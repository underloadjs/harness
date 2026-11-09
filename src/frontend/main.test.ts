// End-to-end shell + request lifecycle against stubbed server answers.
//
// This file pins the redesigned three-column frontend and the behaviours the
// change is for:
//   - R1: the harness rail lists the server catalogue and offers a create action;
//   - R2: the agent configuration is ONE dialog opened from the composer's single button. A
//     harness template's save PATCHes `/harnesses/:name`; since T7b (R5/R6/R7) a SAVED
//     conversation edits its own team, prompts and models through `/sessions/{id}/agents...`,
//     keeps its entry agent fixed, and can gain an agent the catalogue never advertised;
//   - R3 (as amended by R21.2 and T3/R1): sessions are filtered to the selected
//     harness and rendered as PILLS under its title; the right rail is the scratch board
//     alone — no tool list and no session list;
//   - R4: turn and tool-call durations come from the server on reload;
//   - R5: existing streaming, snapshot hydration, endpoint drafts and polling are
//     preserved.
//
// `main.ts` is a module with side effects: it builds the shell and boots against
// the API. `fetch` is stubbed and the SSE body is a real ReadableStream, so
// api.ts parses its own frames. No server, no provider.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import type {
    HarnessAssistantMessage,
    HarnessDescriptor,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bumpFixtureEpoch, viewAwareFetch } from './view-test-support';
import type { HarnessStreamOptions, StreamDouble } from './view-test-support';

// T37: canonical request evidence.
//
// The shell dials the canonical control plane (`/v1/harness/...`), and the shared double
// (`./view-test-support`) composes each canonical answer by re-reading the test's OWN raw
// route (`GET {root}/sessions/:id`) — a session open costs one metadata read plus the turns
// page, roster, definition, usage and queue composition reads. Counting the raw route
// therefore no longer answers "which conversations did the SHELL open": every open looks
// like six reads of the same id.
//
// `canonicalReads` is the honest replacement: the URLs the browser actually sent, captured
// in the wrapper OUTSIDE the double (the same shape `main-lazy-display.test.ts` uses). Tests
// assert conversation opens off the row PAGE route, tree fetches off the display route, and
// lazy detail fetches off the step/block routes.
let canonicalReads: string[] = [];

// One canonical read of one conversation, in the client's own spelling.
const rowReadsFor = (sessionId: string): string[] =>
    canonicalReads.filter(
        (url) => url.split('?')[0] === `/v1/harness/sessions/${sessionId}/turns`
    );

// T50/R5: the conversation's METADATA reads (`GET /v1/harness/sessions/:id`) — the resource the
// bounded fallback refresh re-reads while a run is pending and the live plane cannot carry it.
// Counted on the OUTER recorder (the URL the browser actually sent), never on the raw fixture
// route: the shared double re-reads that one route once per canonical answer it composes, so a raw
// count answers "how many probes did the double make", not "how often did the SHELL refresh".
const metaReadsFor = (sessionId: string): string[] =>
    canonicalReads.filter(
        (url) => url.split('?')[0] === `/v1/harness/sessions/${sessionId}`
    );

const SESSION_KEY = 'underload-harness-app:session';
// The PROVIDER draft the endpoint dialog edits (`./main.ts` `STORAGE_KEY`): the exact
// payload is asserted wherever a test needs to prove a keystroke landed on a provider
// field rather than on the harness server URL above it.
const SETTINGS_KEY = 'underload-harness-app:settings';
// Realistic epoch stamps: the UI formats real server milliseconds, and a tiny
// value would make the live label look like a clock-skew bug.
const T = 1_700_000_000_000;

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Record<string, unknown> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: [
            'read',
            'write',
            'edit',
            'glob',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'tasks'
        ],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly with the full toolbox.',
        instruction: 'Answer the request directly and keep the answer focused.',
        guidelines: ['Prefer a tool over memory.', 'Be concise.']
    },
    {
        name: 'summarizer',
        title: 'Summarizer',
        description: 'Compresses notes into two sentences.',
        instruction: 'Compress notes into at most two sentences.',
        guidelines: ['Keep names and numbers.']
    },
    {
        name: 'workspace',
        title: 'Workspace',
        description: 'A coding-focused agent.',
        instruction: 'Inspect before you change anything.',
        guidelines: []
    }
];

const assistant = (overrides: Partial<HarnessAssistantMessage> = {}): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: 'm1',
    stopReason: 'stop',
    ...overrides
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

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

// One SSE frame per `SessionStreamItem`, in the shape the raw observer body carries. Only the one
// still-hand-rolled observer fixture below uses it (`hydrates a queued session on reload…`); every
// other live case rides the canonical socket double, and the two whole-body helpers this file used to
// hand out (`sse`, `splitSse`) died with those conversions.
const dataOf = (items: readonly unknown[]): Uint8Array =>
    new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''));

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

type Call = { url: string; method: string | undefined; body: unknown };

// A tiny router for the stubbed server: log every call, answer what the test
// declares, and fail loudly on anything unexpected.
//
// T37/T42: the placement of the two records is the whole point.
//   - `calls` sits INSIDE `viewAwareFetch`, so it sees the RAW route the double composed its
//     answer from (`POST /api/sessions/s1/tasks` for a task receipt, `/api/sessions/s1` for the
//     metadata/row-page/tree reads it re-expresses). A write assertion is about the contract's
//     own route, so it asserts on that.
//   - `canonicalReads` sits OUTSIDE the adapter, on the function the browser actually calls, so
//     it records the URL the SHELL sent: `/v1/harness/sessions/s1/turns?limit=25&order=desc` for
//     a row page, `/v1/harness/sessions/s1/turns/t1/display` for a lazy tree. Recording inside
//     the adapter (the shape this file had) logged the double's own composition reads instead,
//     which made `rowReadsFor` structurally unable to match anything — the same placement rule
//     `selectionStub` and `enterStub` follow.
const stubFetch = (
    handler: (url: string, method: string | undefined, body: unknown) => Response | undefined
): Call[] => {
    const calls: Call[] = [];

    const rawFetch = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        calls.push({ url, method, body });

        const response = handler(url, method, body);
        if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);

        return response;
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            // The browser's own spelling, captured before the adapter rewrites it.
            canonicalReads.push(String(input));

            const answer = rawFetch(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return calls;
};

// T37: the canonical live surface (replaces the SSE self-stub this file used to hand-roll).
//
// The client has no SSE fallback (`./stream.ts:40-43`), so a test that wants live behaviour
// installs the `harness.v1` WebSocket double BEFORE the shell boots. The double answers the
// handshake, records the `subscribe`/`unsubscribe` frames the shell sends, and accepts the
// SAME raw `SessionStreamItem` frames this file always declared, folding them through the
// server's own projector (`toViewItem`) into `turn.upsert`/`display.ops`/`session.updated`.
// Frames pushed before the shell registers its subscription are queued, not dropped, so a
// test declares its traffic up front exactly as it did with `sse(items)`.
// T42: every install in this file is resolved by a DYNAMIC import, never a static one.
// `beforeEach` calls `vi.resetModules()`, which clears the module registry, so a statically
// imported `installHarnessStream` configures the singleton of the PREVIOUS graph while the
// `main.ts` imported after the reset dials a FRESH `./stream` that has no factory at all. That
// failure is silent (the shell never subscribes) and reads exactly like "the shell does not
// observe", so the double and the shell must resolve the SAME `./stream` instance (the rule
// `main-lazy-display.test.ts:521-525` and `canonical-directory-live-main.test.ts:34-44` state).
// The TYPES stay static: erased at compile time, they cannot pin an instance.
const installLiveStream = (options: HarnessStreamOptions): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

const liveStream = (
    sessionId: string,
    // The document the live fold seeds from (the same source `withViewRoutes` uses).
    host: () => SessionSnapshot | undefined,
    initial: readonly unknown[] = []
): Promise<StreamDouble> =>
    installLiveStream({ sessionId, snapshot: host }).then((stream) => {
        if (initial.length > 0) stream.push(initial);

        return stream;
    });

// T42: frames are addressed to a SUBSCRIPTION, and the client only writes its `subscribe`
// frame once the double's `welcome` has been answered (./stream.ts queues a subscription made
// before the handshake). A live case therefore waits for the subscription it wants to address
// before pushing, which is also the real server's order of events: subscribe, then frames. The
// wait is bounded so a shell that never observes fails with a named reason instead of hanging.
const subscribed = async (stream: StreamDouble, scope: string, sessionId?: string): Promise<StreamDouble> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const registered = stream.subscriptions.some(
            (sub) => sub.scope === scope && (sessionId === undefined || sub.session_id === sessionId)
        );
        if (registered) return stream;

        await flush();
    }

    throw new Error(
        `the shell never opened a ${scope} subscription${sessionId === undefined ? '' : ` for ${sessionId}`}`
    );
};

const statusText = (): string | null | undefined => document.querySelector('.status-text')?.textContent;
// R3: the pill shows the concise state word only; the full diagnostic is the pill's
// `title` tooltip. `null` means no tooltip at all (a bare state).
const statusTitle = (): string | null | undefined =>
    document.querySelector('.status')?.getAttribute('title');
const tileStates = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.state);
const tileElapsed = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile-elapsed')].map((node) => node.textContent);
// T3/R3: the agent dialog lists the team as clickable badges (the ONLY listing) and
// shows one agent's configuration at a time, so a team read opens the dialog from the
// composer's SINGLE agent button (a no-op when it is already open — a chrome rebuild
// refreshes it in place).
function openAgents(): void {
    // T9: the session dashboard is a modal layer too, and a pill DELETE leaves it open (only
    // OPENING a conversation dismisses it). Put that layer away first — exactly what a reader
    // does — or the deck trigger below is swallowed by the "a dialog is already open" rule.
    closeDashboard();
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
}

const agentRoles = (): (string | undefined)[] => {
    openAgents();
    return [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map(
        (row) => row.dataset.role
    );
};
const agentNames = (): (string | null)[] => {
    openAgents();
    return [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent-name')].map(
        (node) => node.textContent
    );
};
// The configuration panel's agent, i.e. what the roster strip currently shows.
const configuredAgent = (): string | undefined => {
    openAgents();

    return document.querySelector<HTMLElement>('.agent-dialog-config')?.dataset.agent;
};
// The roster, in order: R3 lists THIS team only, never the whole catalogue.
const agentEntries = (): string[] => {
    openAgents();

    return [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map(
        (tab) => tab.dataset.agent ?? ''
    );
};
// The dialog's own editors. Each opens the dialog first, because a lifecycle change
// (a new session, a harness switch) closes it and the next read must not fail.
const instructionBox = (): HTMLTextAreaElement => {
    openAgents();

    return byClass('.agent-dialog-instruction', 'textarea');
};
// R3: the membership checkbox is gone. `Remove from team` is the control a reader
// presses to leave a team, so its enabled/disabled state is the membership fact.
const memberToggle = (): HTMLButtonElement => {
    openAgents();

    return byClass('.agent-dialog-remove', 'button');
};
const promoteToggle = (): HTMLButtonElement => {
    openAgents();

    return byClass('.agent-dialog-promote', 'button');
};
// R3: the lock explanation paragraph is gone; the reason lives on each locked control.
const dialogNote = (): string | null => {
    openAgents();

    return document.querySelector('.agent-dialog-note')?.textContent ?? null;
};
// The real reason main.ts supplies for a locked team, read off a control that is
// disabled because of it (never invented by the dialog).
const teamLockReason = (): string | null => {
    openAgents();

    return document.querySelector('.agent-dialog-add')?.getAttribute('title') ?? null;
};
const applyAction = (): HTMLButtonElement => {
    openAgents();

    return byClass('.agent-dialog-apply', 'button');
};
// Views another agent's configuration by clicking its badge (it sends nothing on its
// own, and R3: it never promotes).
const selectConfigured = (name: string): void => {
    openAgents();

    byClass(`.agent-dialog-tab[data-agent="${name}"]`, 'button').click();
};
// R3: `[+]` is the only route to an agent the team does not select. It drafts the
// membership and moves the view to the new badge.
const addAgent = (name: string): void => {
    openAgents();

    byClass('.agent-dialog-add', 'button').click();
    byClass(`.agent-dialog-add-option[data-agent="${name}"]`, 'button').click();
};
const harnessNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.harness-item .harness-name')].map((node) => node.textContent);
// The core list is gone from the UI (R21.2); this helper stays only so a test can
// prove it renders nothing anywhere.
const coreToolNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.core-tool-name')].map((node) => node.textContent);
// T3/R1 + T9: the saved-conversation directory is the Sessions dashboard of the dialog
// behind the harness title, so "is it listed?" is answered by opening that layer.
// `dashboard()` is idempotent: a pill press DISMISSES the layer (it must never describe the
// conversation the reader left), and the next read reopens it from the live projection.
const dashboard = (): HTMLElement => {
    const open = document.querySelector<HTMLElement>('.session-pills-bar-dialog');
    if (open !== null) return open;

    byClass('.harness-title-button', 'button').click();

    const bar = document.querySelector<HTMLElement>('.session-pills-bar-dialog');
    if (bar === null) throw new Error('missing session dashboard');
    return bar;
};

// Closes the SESSION layer only. A deck dialog can be open at the same time (the agent
// dialog stacks), and `document.querySelector('.dialog-close')` would then find the OTHER
// layer's control — so the click is scoped to the panel that actually holds the strip.
const closeDashboard = (): void => {
    const panel = document.querySelector('.session-pills-bar-dialog')?.closest('.dialog');
    panel?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
};

// A pure directory READ: open the layer if it is closed, read it, and put the layer away
// again unless the test had it open already. Leaving a modal layer standing would steal the
// next gesture (the agent deck cannot open behind it), so reads never change the page state.
const readPills = <T>(read: (bar: HTMLElement) => T): T => {
    const openedHere = document.querySelector('.session-pills-bar-dialog') === null;
    const bar = dashboard();

    try {
        return read(bar);
    } finally {
        if (openedHere) closeDashboard();
    }
};

// R1 (T3): the directory is a pill list, scoped to the selected harness. The id lives on the
// wrapper and on both controls, so an id list is read off the OPEN buttons.
const sessionIds = (): (string | undefined)[] =>
    readPills((bar) =>
        [...bar.querySelectorAll<HTMLElement>('.session-pill-select')].map((node) => node.dataset.sessionId)
    );
// R6: a conversation whose HARNESS was deleted is no longer in a labelled rail group — it
// is a `data-archived="true"` pill at the end of the same directory. `sessionIds()` stays
// dashboard-scoped, so the "scoped to the selected harness" contract is asserted against
// the live split only, and the archived pills are asserted explicitly.
const liveSessionIds = (): (string | undefined)[] =>
    readPills((bar) =>
        [
            ...bar.querySelectorAll<HTMLElement>('.session-pill[data-archived=false] .session-pill-select')
        ].map((node) => node.dataset.sessionId)
    );
const archivedSessionIds = (): (string | undefined)[] =>
    readPills((bar) =>
        [...bar.querySelectorAll<HTMLElement>('.session-pill[data-archived=true] .session-pill-select')].map(
            (node) => node.dataset.sessionId
        )
    );
// R8/T3: the pill WRAPPER (open button + sibling delete control) carries the entry-level
// data attributes and the session id.
const rowIds = (): (string | undefined)[] =>
    readPills((bar) => [...bar.querySelectorAll<HTMLElement>('.session-pill')].map((node) => node.dataset.sessionId));
// The dashboard's own pills, addressed explicitly so a test never counts a pill from some
// other surface by accident (T9 removed the header copy, so this is the only list there is).
const dashPillIds = (): (string | undefined)[] => rowIds();

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// The dialog's provider input whose label reads exactly this, addressed by label TEXT.
// Position matters here: the Endpoint & model dialog opens with the harness server URL
// field (./main.ts), which also wears `.field-input`, so a bare
// `.endpoint-body input.field-input` selector silently stopped naming the provider pair.
// Only the provider fields are wrapped in `label.field` (./main.ts `field`), so scoping to
// it excludes the server URL (`div.field` + `label[for]`) and the model control.
const byFieldLabel = (label: string): HTMLInputElement => {
    const control = [
        ...document.querySelectorAll<HTMLInputElement>('.dialog .endpoint-body label.field > input.field-input')
    ].find((input) => input.closest('label.field')?.querySelector('.field-label')?.textContent === label);

    if (control === undefined) throw new Error(`missing ${label} field`);

    return control;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    // Fresh evidence per test: the wrappers below push every URL the shell sends.
    canonicalReads = [];
    // T6: `--composer-height` is published on the ROOT element, which survives the body
    // reset above. Without this, a test that opened the tools view (a hidden composer
    // publishes `0px`) would leak that value into the next test's boot and make the
    // "unset until measured" contract unreadable.
    document.documentElement.style.removeProperty('--composer-height');
});

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // The socket client is a process-wide singleton (`./stream.ts` `harnessStream()`); leaving
    // this test's double installed leaks its subscriptions into the next file's boot. The
    // import is DYNAMIC on purpose: `vi.resetModules()` in `beforeEach` clears the registry, so
    // a static import would reset the PREVIOUS graph's singleton while the next `main.ts` dials
    // a fresh one (the instance rule `main-lazy-display.test.ts:522-524` documents).
    const { resetHarnessStream: reset } = await import('./stream');
    reset();
});

it('boots the three-column shell, streams a turn and resolves server timings', async () => {
    let taskRequests = 0;

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const call = {
        type: 'tool_call' as const,
        agent: 'instruct',
        call: { id: 'c1', name: 'read', arguments: '{"path":"package.json"}' }
    };
    const result = {
        type: 'tool_result' as const,
        agent: 'instruct',
        name: 'read',
        content: '{"ok":true}',
        isError: false,
        callId: 'c1'
    };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'a b' }) };

    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [
            start,
            call,
            result,
            { type: 'text', agent: 'instruct', delta: '# Hi\n\n' },
            { type: 'text', agent: 'instruct', delta: 'a **b**' },
            done
        ],
        eventTimes: [T, T + 200, T + 1000, T + 1500, T + 1700, T + 2400]
    } as SessionTurn;
    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };
    const finished = snapshot({ harnessDefinition: descriptor(), turns: [recorded], revision: 7 });

    // T42: the live surface is the canonical `harness.v1` socket, not an SSE body (./stream.ts
    // :40-43 has no fallback), so the eight frames this test always declared ride the double
    // instead of a route the shell never asks for again. The double folds them with the SERVER's
    // own projector (`toViewItem`), so every frame the shell receives is the frame the server
    // would send for that recorded frame: `turn.upsert` for the running row, `display.ops` per
    // event (the tool segment, the two text deltas, the settled answer), then `session.updated`
    // plus the recorded rows from the terminal snapshot.
    const frames: SessionStreamItem[] = [
        { type: 'turn', turn: opening },
        { type: 'event', turnId: 't1', event: start, at: T },
        { type: 'event', turnId: 't1', event: call, at: T + 200 },
        { type: 'event', turnId: 't1', event: result, at: T + 1000 },
        { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: '# Hi\n\n' }, at: T + 1500 },
        { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'a **b**' }, at: T + 1700 },
        { type: 'event', turnId: 't1', event: done, at: T + 2400 }
    ];

    // The document the SERVER holds, moved forward by the same frames the socket carries: a
    // canonical read (the metadata patch, the row page, the lazy tree) composes from this record,
    // so it must describe the conversation at the moment the read is answered — a run that is
    // still in flight has a running turn in it, and only the terminal `snapshot` frame settles it.
    let host = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [opening], revision: 3 });
    const settle = (): void => {
        host = finished;
    };

    const live = await liveStream('s1', () => host);

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        // The document the canonical surface is composed FROM: every canonical read (the row
        // page, the roster, the definition, the lazy tree) is answered by the shared double
        // re-reading this route, which is why one raw record is the whole server side of a
        // conversation open.
        if (url === '/api/sessions/s1') return json({ session: host });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            taskRequests += 1;
            return json(
                {
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'running',
                        turns: [opening]
                    }),
                    turn: opening
                },
                202
            );
        }

        return undefined;
    });

    await import('./main');
    await flush();

    // --- shell (R1/R2/R3) ---------------------------------------------
    expect(statusText()).toBe('idle');
    expect(document.querySelectorAll('.shell > .rail-left, .shell > .center, .shell > .rail-right')).toHaveLength(3);
    expect(harnessNames()).toEqual(['instruct']);
    expect(byClass('.harness-item', 'button').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');
    // The chat head shows ONLY the display title. The harness registry id
    // (`instruct`) is internal (sessions/aliases/API), so the shared badge next to
    // the title is emptied and hidden (`renderHarnessChrome`, main.ts:3212-3213).
    expect(document.querySelector('.harness-id')?.textContent).toBe('');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);

    // T3/R3: the team is a strip of clickable badges, and it lists THIS harness's
    // members only (the dropdown that also listed every advertised agent, and the
    // duplicate Team section, are gone). `[+]` is how another agent joins.
    expect(agentNames()).toEqual(['Instruct']);
    expect(agentRoles()).toEqual(['primary']);
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    expect(document.querySelector('.agent-add')).toBeNull();
    expect(document.querySelector('.agent-dialog-agent-select')).toBeNull();
    expect(document.querySelector('.agent-dialog-note')).toBeNull();
    expect(configuredAgent()).toBe('instruct');
    expect(agentEntries()).toEqual(['instruct']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
            tab.dataset.agent,
            tab.getAttribute('aria-selected') === 'true',
            tab.querySelector('.agent-dialog-agent-role')?.textContent
        ])
    ).toEqual([['instruct', true, 'primary']]);

    // The picker, not the strip, is where the other trusted agents are offered.
    byClass('.agent-dialog-add', 'button').click();
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-add-option')].map((option) => [
            option.dataset.agent,
            option.textContent
        ])
    ).toEqual([
        ['summarizer', 'Summarizer'],
        ['workspace', 'Workspace']
    ]);
    byClass('.agent-dialog-add', 'button').click();
    expect(document.querySelector('.agent-dialog-add-list')).toBeNull();

    // R21.1: the rail says template/custom and an agent count — never a
    // read-only/editable distinction.
    expect(document.querySelector('.harness-meta')?.textContent).toBe('template · 1 agent');

    // R21.2: the right rail has NO tool list and NO core-tools dropdown. T3/R1 took the
    // sessions out of it as well: the scratch board is now its ONLY section.
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .tool-button')).toBeNull();
    expect(document.querySelector('.rail-right .catalogue-count')).toBeNull();
    expect(document.querySelector('.rail-right .sessions')).toBeNull();
    expect(document.querySelector('.rail-right .session-pill')).toBeNull();
    const rightSections = [...document.querySelectorAll<HTMLElement>('.rail-right > .rail-section')];
    expect(rightSections.map((section) => section.className)).toEqual(['rail-section scratch-section']);
    expect(document.querySelector('#rail-right')?.getAttribute('aria-label')).toBe('Scratch board');
    // The board explains its empty state and stays hidden until a tool publishes.
    expect(document.querySelector('.scratch-section .rail-title')?.textContent).toBe('Scratch board');
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );
    expect(byClass('.scratch-section .panel-host', 'div').hidden).toBe(true);
    // No badge wall in the header any more.
    expect(document.querySelector('.badges')).toBeNull();

    // R1 (T3) + T9: the header is the title row plus the note, and the row's session items
    // are the compact cycler and its `+`. The pill strip that used to sit under the title is
    // gone at every width; the directory is the dashboard behind the title button.
    const head = document.querySelector<HTMLElement>('.harness-head');
    expect([...(head?.children ?? [])].map((node) => node.className)).toEqual([
        'harness-title-row',
        'harness-note'
    ]);
    expect(document.querySelector('.session-pills-bar-head')).toBeNull();
    expect(head?.querySelector('.session-pills')).toBeNull();
    expect([...byClass('.harness-title-row', 'div').children].map((node) => node.className)).toEqual([
        'main-title',
        'session-cycle',
        'new-session session-new',
        'harness-id'
    ]);
    // Nothing is open yet, so the cycler has no conversation to name, while the dashboard
    // behind the title is empty-state only (and so is not announced as a list).
    expect(byClass('.session-cycle', 'button').hidden).toBe(true);
    const bar = dashboard();
    expect(bar.querySelectorAll('.session-pill')).toHaveLength(0);
    expect(bar.querySelector('.session-pills-empty')?.textContent).toBe('No sessions yet.');
    expect(bar.querySelector('.session-pills')?.getAttribute('role')).toBe('presentation');
    closeDashboard();

    const input = byClass('.composer-input', 'textarea');
    const form = byClass('.composer', 'form');
    // R10: the only composer action starts hidden (idle + empty field) and is the
    // single in-field control in every other state.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');

    input.value = 'say hi';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The tile exists before the server answers; while the stream is open the
    // request lock is held, so a second submit is ignored.
    expect(document.querySelector('.tile')).not.toBeNull();
    // T3/R3: while a run is in flight the dialog's team/instruction controls are locked
    // and each one carries the real reason — the explanation paragraph is gone.
    expect(instructionBox().disabled).toBe(true);
    expect(memberToggle().disabled).toBe(true);
    expect(promoteToggle().disabled).toBe(true);
    expect(document.querySelector('.agent-dialog-note')).toBeNull();
    expect(byClass('.agent-dialog-add', 'button').title).toBe(
        'A session is being created; try again in a moment.'
    );
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The observer opens because the run is pending, and a frame is addressed to a SUBSCRIPTION,
    // so the push waits for the shell's `session` subscription to be registered (the order the
    // real server delivers in) and then carries the run exactly as the SSE body used to.
    await subscribed(live, 'session', 's1');
    live.push(frames);

    await flush();
    await flush();

    // The terminal `snapshot` frame is the last one, and the stub's record moves with it: a
    // canonical read answered after this point describes the settled conversation, which is what
    // the server would hold (the recorded stamps, not the local clock).
    settle();
    live.push([{ type: 'snapshot', session: finished }]);

    await flush();
    await flush();

    expect(taskRequests).toBe(1);

    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    // R3: the header carries no `#ordinal` and no raw agent id; it is the metadata
    // cluster only (the agent label lives in the section header).
    expect(tile.querySelector('.tile-index')).toBeNull();
    expect(tile.querySelector('.tile-status-text')?.textContent).toBe('done');
    expect(tile.querySelector('.turn-prompt')?.textContent).toBe('say hi\n');
    expect(tile.querySelector('.agent-text')?.innerHTML).toBe('<h1>Hi</h1>\n<p>a <strong>b</strong></p>\n');
    // R5: the block footer no longer prints the model / stop reason line — those
    // figures are header facts (`.tile-top`, asserted below). The footer is the
    // answer action row: one right-aligned, accessible Copy control for THIS block.
    expect(tile.querySelectorAll('.agent-meta')).toHaveLength(0);
    const answerCopy = tile.querySelector<HTMLButtonElement>('.agent-answer-actions .answer-copy');
    expect(answerCopy?.className).toContain('answer-copy');
    expect(answerCopy?.getAttribute('aria-label')).toBe('Copy the final answer');
    // An icon button: no visible word at idle (the announced state is a hidden live
    // child, and `data-state` plus the glyph carry the feedback).
    expect(answerCopy?.textContent).toBe('');
    expect(answerCopy?.hasAttribute('data-state')).toBe(false);

    // The payload is the RAW Markdown of the block's completed answer: exactly the
    // text the model streamed — not the rendered HTML, not the prompt, not the tool
    // result, and not the whole transcript.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
    });
    answerCopy?.click();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('# Hi\n\na **b**');
    expect(answerCopy?.dataset.state).toBe('success');
    expect(answerCopy?.getAttribute('aria-label')).toBe('Copy the final answer');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    // R4: the server's startedAt/updatedAt and eventTimes decide the labels.
    expect(tile.querySelector('.tile-elapsed')?.textContent).toBe('3.6s');
    // T11 (R7): the recorded call is ONE SEGMENT of this turn's context bar, not a card. Every
    // figure the chip used to print is still on screen — the name, the settled state, the
    // EXACT recorded characters (args 23 + result 11) and the recorded span (eventTimes
    // T+200 -> T+1000) — and no `.tool` card is minted for it any more.
    const callSegment = tile.querySelector<HTMLElement>('.context-bar-segment[data-kind="tool"]');

    expect(tile.querySelectorAll('.tool')).toHaveLength(0);
    expect(callSegment?.dataset.tone).toBe('ok');
    expect(callSegment?.dataset.chars).toBe('34');
    expect(callSegment?.dataset.durationMs).toBe('800');
    expect(callSegment?.title).toContain('read · tool · ok · 34 characters · args 23 + result 11 · 800ms');
    // The one lazy route this turn can cost is still click-only: nothing was fetched to paint.
    expect(tile.classList.contains('is-expanded')).toBe(true);

    // The terminal snapshot populated the directory and the remembered pointer. T9: the
    // directory is the dashboard behind the title, so the read opens it and puts it away.
    dashboard();
    const pill = byClass('.session-pills-bar-dialog .session-pill-select', 'button');
    expect(pill.dataset.status).toBe('idle');
    expect(pill.dataset.active).toBe('true');
    // R1 (T3): the pill's VISIBLE text is the eight-character prefix only — never the
    // full uuid, which the tooltip carries.
    expect(pill.textContent).toBe('s1');
    expect(pill.getAttribute('aria-label')).toBe('Open session s1');
    expect(pill.title).toBe('instruct · idle · s1');
    // T9: the header's own marker names the same conversation without a dialog.
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s1');
    closeDashboard();
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');

    // The header is app-scoped: a settled run is reported by the tile, not here.
    expect(statusText()).toBe('idle');
    // Empty field, no pending work: the action is gone again (R10).
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');
    // T7b (R5/R6): a session exists, and it is NOT a lock — the conversation edits its own team
    // and its own prompts, so both editors are live and `[+]` offers another member. What the
    // conversation cannot change is its entry agent (R5), and R3 still states every restriction
    // ON the control, with no explanation paragraph inside the dialog.
    expect(instructionBox().disabled).toBe(false);
    expect(memberToggle().disabled).toBe(true);
    expect(dialogNote()).toBeNull();
    expect(instructionBox().getAttribute('title')).toBe(
        'The instruction this agent runs in this conversation.'
    );
    // The member viewed here is the primary, so its removal is impossible for the structural
    // reason — and R7 makes this session's `[+]` a name field as well as a catalogue picker.
    expect(memberToggle().title).toBe('The primary agent is always part of the team.');
    expect(teamLockReason()).toBe('Add an agent to the team, or name a new one.');
    expect(document.querySelector('.agent-lock')).toBeNull();
    expect(document.querySelector('.agent-row-wrap .link-button')).toBeNull();
    // R1 (T3) + R4 (T9): the create action is the compact `+` beside the cycler. Its
    // accessible name is still the full phrase (a bare "+" is not a name an AT can act on).
    expect(document.querySelector('.harness-title-row .new-session')?.textContent).toBe('+');
    expect(document.querySelector('.harness-title-row .new-session')?.getAttribute('aria-label')).toBe(
        'New session'
    );
    expect(document.querySelector('.harness-title-row .new-session')?.title).toBe('New session');
    expect(byClass('.harness-title-row .new-session', 'button').disabled).toBe(false);
    // R4: no manual refresh control survives anywhere.
    expect(document.querySelector('.refresh-sessions')).toBeNull();
    // ...but the MODELS are live (R2): the dialog's strip still edits this session.
    const modelSelect = byClass('.agent-model-select', 'select');
    expect(modelSelect.disabled).toBe(false);
    expect(modelSelect.title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );
});

// Header badge lifecycle. `<span class="harness-id">` is shared by two heads:
//   - the CHAT head (`renderHarnessChrome`, main.ts:3206-3213) sets the display
//     title and BLANKS + HIDES the badge — the harness registry id (`instruct`,
//     `research`, …) is an internal key for sessions/aliases/API, not reader copy;
//   - the TOOLS head shows user-facing group labels in it again
//     (`paintToolsHead` main.ts:3780-3781 → `catalogue`, `selectTool`
//     main.ts:3867-3868 → the entry's group such as `Files`), so both writers
//     explicitly un-hide the element the chat head hid.
// This walks the whole round trip: chat → catalogue → tool → catalogue → chat.
it('shows the tools badge only in the tools view and keeps it hidden in the chat head', async () => {
    const tool = {
        name: 'read',
        group: 'Files',
        description: 'Read one or more files.',
        tags: ['files', 'read'],
        visibility: 'searchable',
        parameters: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } } },
            required: ['paths']
        }
    };

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ tools: [tool] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    const badge = byClass('.harness-id', 'span');

    // Chat head: display title only, badge empty and hidden.
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');
    expect(badge.textContent).toBe('');
    expect(badge.hidden).toBe(true);

    // Tools view: the catalogue label is readable, so the badge is shown.
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(badge.textContent).toBe('catalogue');
    expect(badge.hidden).toBe(false);

    // Selected tool: the head names the tool and its GROUP in the badge.
    byClass('.tool-tab-button', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('read');
    expect(badge.textContent).toBe('Files');
    expect(badge.hidden).toBe(false);

    // Dialog close re-describes the catalogue, badge still shown.
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(badge.textContent).toBe('catalogue');
    expect(badge.hidden).toBe(false);

    // Back to chat: the title returns and the badge is blanked and hidden again.
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');
    expect(badge.textContent).toBe('');
    expect(badge.hidden).toBe(true);
});

// Token tally: the row shows TWO scopes. The primary is the LATEST request's
// input/context size (derived from the last `usage` event in the turn), and the
// bracket is the server's cumulative cached input across the turn. See
// src/frontend/ui/tokens.ts and the tally block in ui/turns.ts. Here request 1
// sends 48/0 and request 2 sends 96/48, while the server tally sums to 144/48:
// the row renders '48 (0)' then '96 (48)' — never '144 (48)'. `output` is never
// printed.
it('prints the latest request context with the cumulative cache per frame', async () => {
    const firstTally = { input: 48, output: 18, total: 66, cached: 0 };
    const lastTally = { input: 144, output: 40, total: 184, cached: 48 };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const text = { type: 'text' as const, agent: 'instruct', delta: 'hi' };
    const usageFirst = {
        type: 'usage' as const,
        agent: 'instruct',
        usage: { input: 48, output: 18, total: 66, cached: 0 }
    };
    const usageLast = {
        type: 'usage' as const,
        agent: 'instruct',
        usage: { input: 96, output: 22, total: 118, cached: 48 }
    };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'hi' }) };

    // The recorded turn is what the terminal snapshot re-hydrates from, events
    // and cumulative tally included: a reload must show the same row as live.
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [start, usageFirst, text, usageLast, done],
        eventTimes: [T, T + 50, T + 100, T + 150, T + 200],
        usage: lastTally
    } as SessionTurn;
    const opening: SessionTurn = { ...recorded, status: 'running', events: [], usage: firstTally };
    const finished = snapshot({ harnessDefinition: descriptor(), turns: [recorded] });

    // The document the server holds RIGHT NOW: the canonical reads are composed from it, and it
    // settles only when the terminal `snapshot` frame is pushed (the store's record moves with
    // the run the same way).
    let host = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [opening] });
    const settle = (): void => {
        host = finished;
    };

    // T42: the canonical socket double replaces the split SSE body. The point of the split was
    // to pin what the tile shows BETWEEN frames (the tally is written per frame, `sse` would
    // apply all of them before the test regained control); `push(batch)` delivers ONE UPDATE
    // FRAME per item and returns, so the same halfway assertion still holds. The held-back half
    // is the second `push` below, and the first frames go in once the subscription exists.
    const live = await liveStream('s1', () => host);

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        // The document the canonical reads are composed from (see the boot test).
        if (url === '/api/sessions/s1') return json({ session: host });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json(
                {
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'running',
                        turns: [opening]
                    }),
                    turn: opening
                },
                202
            );
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The pre-stream requests (session, models) and the receipt settle here. A canonical RECEIPT
    // carries identity and placement only (../shared/harness-api.ts:1194-1209) — no usage — so the
    // first tallied figure can only come from the socket. Frames are addressed to a SUBSCRIPTION,
    // hence the wait, and `push` delivers one UPDATE frame per item: the halfway read below is what
    // the split SSE body used to pin, and it still holds.
    await subscribed(live, 'session', 's1');
    live.push([
        { type: 'turn', turn: opening },
        { type: 'event', turnId: 't1', event: usageFirst, at: T + 50, usage: firstTally }
    ]);
    await flush();
    await flush();

    const liveTally = byClass('.tile', 'article').querySelector<HTMLElement>('.tile-tokens');
    expect(liveTally?.textContent).toBe('48 (0)');
    expect(liveTally?.hidden).toBe(false);

    live.push([
        // A frame with NO tally between two tallied ones: it must leave
        // the figure alone rather than clear it.
        { type: 'event', turnId: 't1', event: text, at: T + 100 },
        { type: 'event', turnId: 't1', event: usageLast, at: T + 150, usage: lastTally },
        { type: 'event', turnId: 't1', event: done, at: T + 200, usage: lastTally },
        { type: 'snapshot', session: finished }
    ]);
    await flush();
    await flush();

    // The terminal snapshot rebuilt the tile from the recorded turn, so the label
    // comes from `SessionTurn.usage` — the same exact figure, not a double sum.
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.textContent).toBe('96 (48)');
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
    // The recorded stamps (not the local clock) prove this tile is the rehydrated
    // one: the live tile ran from T to "now".
    expect(tile.querySelector('.tile-elapsed')?.textContent).toBe('3.6s');
});

it('keeps the last tally when later frames carry none', async () => {
    const tally = { input: 48, output: 18, total: 66, cached: 0 };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    // T3: the turn-level PRIMARY figure the header prints is the ROOT section's own latest
    // request, published by the projector from its `usage` frames (`TurnSummary.latestInput`,
    // root scope only). This record therefore carries its own reported requests, and their
    // inputs are deliberately DIFFERENT from the turn-wide tally: the earlier round cost 8 and
    // the latest one 40, so the server's running sum is exactly `input: 48`
    // (src/server/sessions.ts `addUsage`), while the primary figure can only come from the
    // ROOT usage frame — `'40 (0)'` is NOT satisfiable from the tally, which would print 48.
    // Without any root figure the tile now honestly hides the primary rather than printing the
    // `usage.input` sum (the reversal pinned in ui/turns-compiled.test.ts "hides the primary
    // figure when only a delegated child reported a context"). What THIS test owns is
    // stickiness: frames that carry no `usage` must never clear or re-sum the figure.
    const firstUsage = { type: 'usage' as const, agent: 'instruct', usage: { input: 8, output: 2, total: 10, cached: 0 } };
    const usage = { type: 'usage' as const, agent: 'instruct', usage: { input: 40, output: 16, total: 56, cached: 0 } };
    const text = { type: 'text' as const, agent: 'instruct', delta: 'hi' };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'hi' }) };

    const opening: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'running',
        startedAt: T,
        updatedAt: T + 200,
        events: [],
        usage: tally
    } as SessionTurn;

    // The settled document the run ends on: the same turn, now terminal, with the tally the
    // tallied frames established. It is both the host the live fold seeds from and the record
    // the canonical reads are composed from.
    const finished = snapshot({
        harnessDefinition: descriptor(),
        turns: [{ ...opening, status: 'done', events: [start, firstUsage, text, usage, done] }]
    });

    // The record the server holds, moved forward by the frames below (see the boot test).
    let host = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [opening] });
    const settle = (): void => {
        host = finished;
    };

    // T42: the raw frames ride the canonical socket double (the client has no SSE fallback). The
    // record the terminal `snapshot` frame carries holds the tally the tallied frames
    // established; the untallied frames after it must not clear it (the tile prints server data
    // and never re-sums from its own clock).
    const live = await liveStream('s1', () => host);

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        // The document the canonical reads are composed from (see the boot test).
        if (url === '/api/sessions/s1') return json({ session: host });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json(
                {
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'running',
                        turns: [opening]
                    }),
                    turn: opening
                },
                202
            );
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The run's frames, addressed to the subscription the pending run opened, and the terminal
    // snapshot last so the record settles the way the server's does.
    await subscribed(live, 'session', 's1');
    live.push([
        { type: 'turn', turn: opening },
        { type: 'event', turnId: 't1', event: start, at: T, usage: tally },
        // The running tally each frame carries is what the server's own fold produces:
        // 8 after the first reported request, the full 48 once the second one lands.
        { type: 'event', turnId: 't1', event: firstUsage, at: T + 20, usage: firstUsage.usage },
        { type: 'event', turnId: 't1', event: text, at: T + 100, usage: firstUsage.usage },
        { type: 'event', turnId: 't1', event: usage, at: T + 150, usage: tally },
        { type: 'event', turnId: 't1', event: done, at: T + 200 }
    ]);
    await flush();
    await flush();

    settle();
    live.push([{ type: 'snapshot', session: finished }]);
    await flush();
    await flush();

    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    // The PRIMARY is the root section's latest request (40), never the turn-wide
    // `usage.input` sum (48) — the T3 scoping — and the bracket is the tally's cache.
    // The frames after the tallied one (and the terminal snapshot) carried no `usage`, so
    // the figure is untouched — never cleared, never re-summed.
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.textContent).toBe('40 (0)');
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
});

it('restores a remembered session with its frozen team and server timings', async () => {
    const frozen = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer'],
        // A subagent allowlist is what makes the server add delegate.
        coreTools: [
            'read',
            'write',
            'edit',
            'glob',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'records',

            'tasks',
            'delegate'
        ]
    });

    const first: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'first task',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            {
                type: 'tool_call',
                agent: 'instruct',
                call: { id: 'c1', name: 'read', arguments: '{"path":"package.json"}' }
            },
            {
                type: 'tool_result',
                agent: 'instruct',
                name: 'read',
                content: '{"ok":true}',
                isError: false,
                callId: 'c1'
            },
            { type: 'text', agent: 'instruct', delta: '## Answer\n\nfinal' },
            { type: 'done', agent: 'instruct', message: assistant() }
        ],
        eventTimes: [T, T + 200, T + 1700, T + 2000, T + 3000]
    } as SessionTurn;

    // A turn recorded before the server sent timing data: no eventTimes, but the
    // turn span still renders, and no tool duration is invented.
    const legacy: SessionTurn = {
        id: 't2',
        index: 1,
        prompt: 'second task',
        status: 'error',
        startedAt: T + 4000,
        updatedAt: T + 5000,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'tool_call', agent: 'instruct', call: { id: 'c2', name: 'timeNow', arguments: '{}' } },
            { type: 'error', agent: 'instruct', error: { message: 'provider exploded' } }
        ]
    };

    const restored = snapshot({ harnessDefinition: frozen, turns: [first, legacy] });
    localStorage.setItem(SESSION_KEY, 's1');

    let messageRequests = 0;
    let writes = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor()], sessions: [restored] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') {
            if (method !== undefined) {
                writes += 1;
                throw new Error('opening a session must be read-only');
            }
            return json({ session: restored });
        }
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [restored] });
        if (url.endsWith('/messages')) messageRequests += 1;
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(messageRequests).toBe(0);
    expect(writes).toBe(0);
    expect(tileStates()).toEqual(['done', 'error']);
    expect(tileElapsed()).toEqual(['3.6s', '1.0s']);
    // T11 (R7): a recorded call's span travels on its segment now, from eventTimes
    // (T+200 -> T+1700), because the bar is the surface that shows calls.
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('.tile'));
    const timed = tiles[0].querySelector<HTMLElement>('.context-bar-segment[data-kind="tool"]');

    expect(tiles[0].querySelectorAll('.tool')).toHaveLength(0);
    expect(timed?.dataset.tone).toBe('ok');
    expect(timed?.dataset.durationMs).toBe('1500');

    // The legacy call has no recorded timing at all, so its segment states a duration for
    // neither half rather than inventing one.
    const legacyCall = tiles[1].querySelector<HTMLElement>('.context-bar-segment[data-kind="tool"]');

    expect(legacyCall?.dataset.durationMs).toBe('');
    expect(tiles[1].querySelectorAll('.tool')).toHaveLength(0);
    // No NaN anywhere, including legacy timing.
    expect(document.body.textContent ?? '').not.toContain('NaN');

    // The frozen definition is what is displayed, not the live descriptor.
    expect(agentNames()).toEqual(['Instruct', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // T3/R1: a locked saved session prints NO header note. The old frozen-team caption
    // restated two facts the reader cannot act on: the team lock is written on the
    // disabled editors themselves (asserted below), and which conversation is open is
    // what the pill strip marks with `data-active`.
    const note = document.querySelector<HTMLElement>('.harness-note');
    expect(note?.textContent).toBe('');
    expect(note?.hidden).toBe(true);
    // T9: which conversation is open is stated by the pill in the dashboard behind the
    // title; the read opens that layer and puts it straight away again.
    dashboard();
    expect(byClass('.session-pill-select', 'button').dataset.active).toBe('true');
    closeDashboard();
    // R21.2: the enabled-for-session status now lives in the global tools view (its
    // pane is detached while the chat owns the stage — tools-tab.test.ts pins the
    // text). What matters here is that no right-rail core dropdown came back.
    expect(document.querySelector('.core-tools')).toBeNull();
    // T7b (R5/R6): restoring a conversation does NOT lock its configuration. The instruction
    // editor and the team controls are live (they edit THIS conversation), each restriction that
    // does exist is stated on the control itself, and the explanation paragraph stays gone. What
    // a saved conversation cannot do is move its entry agent (R5).
    expect(instructionBox().disabled).toBe(false);
    expect(memberToggle().disabled).toBe(true);
    expect(promoteToggle().disabled).toBe(true);
    expect(byClass('.agent-dialog-add', 'button').disabled).toBe(false);
    expect(dialogNote()).toBeNull();
    expect(applyAction().textContent).toBe('Save configuration');
    expect(applyAction().disabled).toBe(true);
    expect(instructionBox().getAttribute('title')).toBe(
        'The instruction this agent runs in this conversation.'
    );
    expect(memberToggle().title).toBe('The primary agent is always part of the team.');
    expect(promoteToggle().title).toBe('The primary agent is fixed for a saved conversation.');
    expect(teamLockReason()).toBe('Add an agent to the team, or name a new one.');
    // The frozen roster is THIS conversation's team, and only it.
    expect(agentEntries()).toEqual(['instruct', 'summarizer']);
    // R7: the frozen team is visible through its disabled controls.
    // Neither the removed notice nor its New session link may come back; the compact header
    // `+` (R2/T9) is the independent way to start an editable conversation.
    expect(document.querySelector('.agent-lock')).toBeNull();
    expect(document.querySelector('.agent-lock-text')).toBeNull();
    expect(document.querySelector('.agent-row-wrap .link-button')).toBeNull();
    expect(byClass('.harness-title-row .new-session', 'button').textContent).toBe('+');
    expect(byClass('.harness-title-row .new-session', 'button').disabled).toBe(false);
    // R2: models are not part of the frozen team, so the dropdown stays usable on a
    // saved session and promises the next request in THIS chat — for every member,
    // which the T3 dropdown reaches one agent at a time.
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);
    expect(byClass('.agent-model-select', 'select').title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );

    selectConfigured('summarizer');
    expect(configuredAgent()).toBe('summarizer');
    expect(byClass('.agent-model-select', 'select').title).toBe(
        'Model for Summarizer. Applies to the next request in this session.'
    );

    // T9: the compact header `+` starts the new conversation without the reader ever opening
    // the dashboard, which unlocks editing. It is the ONLY New session affordance on the page
    // (R7): the rail's copy is gone, the header strip is gone, and no details dialog is open
    // to carry a second one.
    expect(document.querySelectorAll('.new-session')).toHaveLength(1);
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(0);
    byClass('.harness-title-row .new-session', 'button').click();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    expect(agentNames()).toEqual(['Instruct']);
    expect(instructionBox().disabled).toBe(false);
    expect(applyAction().textContent).toBe('Save configuration');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(writes).toBe(0);
});

// ---------------------------------------------------------------------------
// T21 R21 + R22: the conversation a FIRST LOAD opens, and what is expanded
// ---------------------------------------------------------------------------
//
// R21 (main.ts `recencyOf`/`latestSession`/`initialSession`, called by `boot`): the
// app chooses a conversation exactly ONCE — when a harness is first loaded — and the
// choice is the most recently used row of the harness on screen: the server's
// `updatedAt`, then `createdAt`, then the directory's own order (the server lists its
// sessions oldest first, so the later row is the newer conversation). A pointer saved
// by an earlier visit never beats a newer conversation, and nothing picks again after
// boot: a stream frame, a poll or a directory refresh cannot move the reader.
//
// R22 (main.ts `openSession` + `View.collapseForLoad`): a loaded conversation renders
// with EVERY thread collapsed. The board's first-content rule opens the newest surface
// while the document is applied (ui/turns.ts `reconcileView`'s `!hadTurns` /
// `pendingFirstFocus` branches); the shell drops that expansion before anything can
// read it as a focus choice. Only a click opens a thread, and after a click every
// later frame keeps it open.

// One persistent thread of a fixture conversation. The roster is what lets the
// composer's routing line say `New thread` at all (a legacy session with no threads
// shows no label), so R22's assertions need real rows.
type DirectoryThread = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
};

// One recorded run of a fixture conversation. A settled turn carries its whole event
// list so the compiled document paints a real answer; a running one stops at the
// text delta, which is what keeps the session pending and the observer open.
const selectionTurn = (
    id: string,
    index: number,
    prompt: string,
    threadId: string,
    at: number,
    status: 'done' | 'running' = 'done'
): SessionTurn =>
    ({
        id,
        index,
        prompt,
        status,
        threadId,
        startedAt: at,
        updatedAt: at,
        events:
            status === 'done'
                ? [
                      { type: 'start', agent: 'instruct', model: 'm1' },
                      { type: 'text', agent: 'instruct', delta: `answer to ${prompt}` },
                      { type: 'done', agent: 'instruct', message: assistant() }
                  ]
                : [
                      { type: 'start', agent: 'instruct', model: 'm1' },
                      { type: 'text', agent: 'instruct', delta: `working on ${prompt}` }
                  ]
    }) as unknown as SessionTurn;

// A directory row that is ALSO the document `GET /sessions/:id` answers with, so one
// fixture drives both the pick (the row's stamps) and the render (its turns).
const conversation = (
    id: string,
    usedAt: number,
    options: {
        harness?: string;
        status?: 'idle' | 'running';
        turns?: SessionTurn[];
        threads?: DirectoryThread[];
    } = {}
): SessionSnapshot =>
    ({
        id,
        harness: options.harness ?? 'instruct',
        status: options.status ?? 'idle',
        model: 'm1',
        // A conversation created a while before its last use: `createdAt` only breaks a
        // tie between identical `updatedAt` stamps, it never wins on its own.
        createdAt: usedAt - 10_000,
        updatedAt: usedAt,
        messages: [],
        turns: options.turns ?? [selectionTurn(`t-${id}`, 0, `task in ${id}`, `thread-${id}`, usedAt)],
        ...(options.threads === undefined ? {} : { threads: options.threads })
    }) as unknown as SessionSnapshot;

// The whole server surface the selection tests need: the catalogue with its embedded
// directory rows, the compact list route, and the canonical reads the double composes from
// them (row pages, rosters, definitions, trees). T37: the live observer is the canonical
// `harness.v1` socket double — NOT the open SSE body this file used to hold — so a test that
// still has a working conversation passes its id in `live` and pushes RAW frames with `emit`.
// The double is installed unconditionally, because jsdom supplies a real `WebSocket` and an
// undriven socket reconnects on its own and never delivers anything.
//
// `reads` stays the evidence for "opened exactly one conversation, and never a second time",
// counted where the canonical surface states it: the ROW PAGE of that conversation, which the
// shell asks for on an open and never re-walks by itself. The raw `GET {root}/sessions/:id`
// route no longer works as that evidence — the double re-reads it several times per open to
// compose the row page, roster, definition, usage and queue answers.
const selectionStub = async (
    rows: SessionSnapshot[],
    // The catalogue's harness rows. Only the cross-harness resume needs a second one.
    options: { presets?: HarnessDescriptor[]; live?: string } = {}
): Promise<{ reads: string[]; emit: (item: unknown) => void }> => {
    const reads: string[] = [];

    // The socket is scoped to the conversation still working when the test names one; without
    // a target it answers the newest subscription, which is what a directory-only fixture has.
    const stream = await installLiveStream(
        options.live === undefined
            ? {}
            : { sessionId: options.live, snapshot: () => rows.find((row) => row.id === options.live) }
    );

    const fixture = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method;

        if (url === '/api') {
            return json(
                bootstrap({
                    sessions: rows,
                    ...(options.presets === undefined ? {} : { presets: options.presets })
                })
            );
        }
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: rows });

        const read = /^\/api\/sessions\/([^/]+)$/.exec(url);
        if (read !== null && method === undefined) {
            const record = rows.find((row) => row.id === read[1]);
            if (record === undefined) return json({ error: { message: `unknown session ${read[1]}` } }, 404);

            return json({ session: record });
        }

        return undefined;
    }, { root: '/api' });

    // The recorder sits OUTSIDE the double: the double answers the canonical row page itself
    // and never consults the stub for it, so only this pass sees every URL the shell sent.
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            canonicalReads.push(url);

            const opened = /^\/v1\/harness\/sessions\/([^/]+)\/turns$/.exec(url.split('?')[0] ?? url);
            if (opened !== null && init?.method === undefined) reads.push(decodeURIComponent(opened[1]));

            const answer = fixture(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return {
        reads,
        emit: (item: unknown): void => {
            stream.push(item);
        }
    };
};

// The pills that say they ARE the conversation on screen (`data-active`), read through
// the dashboard layer the strip lives in since T9.
const activePillIds = (): (string | undefined)[] =>
    readPills((bar) =>
        [...bar.querySelectorAll<HTMLElement>('.session-pill-select')]
            .filter((node) => node.dataset.active === 'true')
            .map((node) => node.dataset.sessionId)
    );

// Every surface the board marks open. R22 is about ALL of them: the tile card, its
// row wrapper, and the conversation group that owns the nested continuations.
const expandedTiles = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('.tile.is-expanded')];

it('opens the most recently used conversation of the selected harness on a first load', async () => {
    const older = conversation('s-old', T + 1_000);
    const middle = conversation('s-mid', T + 3_000);
    const newest = conversation('s-new', T + 5_000);

    // Deliberately shuffled: the pick comes from the stamps, never from where a row
    // happens to sit in the server's answer.
    const stub = await selectionStub([middle, newest, older]);

    await import('./main');
    await flush();
    await flush();

    // Exactly one conversation read, and it is the newest one.
    expect(stub.reads).toEqual(['s-new']);
    // The pointer now names what the shell actually opened.
    expect(localStorage.getItem(SESSION_KEY)).toBe('s-new');
    // Every surface that names the conversation on screen agrees.
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s-new');
    expect(activePillIds()).toEqual(['s-new']);
    expect(tileStates()).toEqual(['done']);
    expect(document.querySelector('.agent-text')?.textContent).toBe('answer to task in s-new\n');
});

it('breaks an identical timestamp with the directory order, whose last row is the newest', async () => {
    // The same instant to the millisecond, and the same creation stamp: the directory's
    // own order is the remaining authority, and the server lists oldest first.
    const first = conversation('s-first', T + 1_000);
    const second = conversation('s-second', T + 1_000);

    const stub = await selectionStub([first, second]);

    await import('./main');
    await flush();
    await flush();

    expect(stub.reads).toEqual(['s-second']);
    expect(localStorage.getItem(SESSION_KEY)).toBe('s-second');
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s-second');
});

it('opens the newest conversation even when the browser remembers an older one', async () => {
    const older = conversation('s-old', T + 1_000);
    const newest = conversation('s-new', T + 5_000);

    // A pointer from the last visit, still held by this server, but NOT the newest
    // conversation: R21 puts latest-first ahead of it.
    localStorage.setItem(SESSION_KEY, 's-old');

    const stub = await selectionStub([newest, older]);

    await import('./main');
    await flush();
    await flush();

    // The remembered row is never even read, and the pointer moves to what is open.
    expect(stub.reads).toEqual(['s-new']);
    expect(localStorage.getItem(SESSION_KEY)).toBe('s-new');
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s-new');
});

it('still resumes a saved conversation of another harness when the harness on screen has none', async () => {
    const workspace = descriptor({
        name: 'workspace',
        title: 'Workspace',
        agents: ['workspace'],
        primary: 'workspace',
        requiresEndpoint: false
    });
    const saved = conversation('s-ws', T + 1_000, { harness: 'workspace' });

    localStorage.setItem(SESSION_KEY, 's-ws');

    const stub = await selectionStub([saved], { presets: [descriptor(), workspace] });

    await import('./main');
    await flush();
    await flush();

    // Instruct (the first catalogue entry) owns no conversation, so the saved pointer
    // decides — the reload-where-you-left behaviour R21 does not take away.
    expect(stub.reads).toEqual(['s-ws']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Workspace');
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s-ws');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s-ws');
});

it('never re-picks the conversation while the live stream keeps arriving', async () => {
    const live = conversation('s-new', T + 5_000, {
        status: 'running',
        turns: [selectionTurn('ta', 0, 'running task', 'thread-ta', T + 5_000, 'running')]
    });
    const older = conversation('s-old', T + 1_000);

    // A NEWER row than the one on screen, so a re-pick would be visible: the directory
    // answers with `s-old` last, and only the boot decision may look at it.
    const stub = await selectionStub([live, older], { live: 's-new' });

    await import('./main');
    await flush();
    await flush();

    expect(stub.reads).toEqual(['s-new']);
    expect(tileStates()).toEqual(['streaming']);

    // A terminal frame lands: the turn settles, the selection does not move, and no
    // second conversation is opened.
    stub.emit({
        type: 'snapshot',
        session: conversation('s-new', T + 6_000, {
            turns: [selectionTurn('ta', 0, 'running task', 'thread-ta', T + 6_000)]
        })
    });
    await flush();
    await flush();

    expect(tileStates()).toEqual(['done']);
    expect(stub.reads).toEqual(['s-new']);
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s-new');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s-new');
});

it('loads a conversation with every thread collapsed and the composer on a new thread', async () => {
    const threads: DirectoryThread[] = [
        { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'RR1' },
        { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2, label: 'RR2' }
    ];
    const loaded = conversation('s1', T + 5_000, {
        threads,
        turns: [
            selectionTurn('ta', 0, 'first task', 'thread-1', T + 1_000),
            selectionTurn('tb', 1, 'second task', 'thread-1', T + 2_000),
            selectionTurn('tc', 2, 'third task', 'thread-2', T + 3_000)
        ]
    });

    const stub = await selectionStub([loaded]);

    await import('./main');
    await flush();
    await flush();

    // The conversation IS open — three settled rows, the pointer and the pill name it.
    expect(stub.reads).toEqual(['s1']);
    expect(document.querySelectorAll('.tile')).toHaveLength(3);
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s1');

    // Nothing is expanded, on ANY surface. Before R22 the newest tile (and its
    // conversation group) opened by itself on every load.
    expect(expandedTiles()).toEqual([]);
    expect(document.querySelectorAll('.thread-row.is-expanded')).toHaveLength(0);
    expect(document.querySelectorAll('.conversation.is-expanded')).toHaveLength(0);
    expect(document.querySelectorAll('.tile-select[aria-expanded="true"]')).toHaveLength(0);
    [...document.querySelectorAll<HTMLElement>('.tile-select')].forEach((control) =>
        expect(control.getAttribute('aria-expanded')).toBe('false')
    );

    // The composer therefore routes the next message to a NEW thread: focus is the
    // expanded conversation, and nothing is expanded.
    const target = byClass('.composer-target', 'p');
    expect(target.hidden).toBe(false);
    expect(target.dataset.mode).toBe('new');
    expect(target.textContent).toBe('New thread');
});

it('keeps the thread the reader expanded open across a later stream frame', async () => {
    const threads: DirectoryThread[] = [
        { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'RR1' },
        // The roster rows are what the routing line reads; the session-level `running`
        // status below is what keeps the observer open for the frame.
        { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2, label: 'RR2' }
    ];
    const turns = [
        selectionTurn('ta', 0, 'first task', 'thread-1', T + 1_000),
        selectionTurn('tb', 1, 'second task', 'thread-1', T + 2_000),
        selectionTurn('tc', 2, 'third task', 'thread-2', T + 3_000, 'running')
    ];
    const loaded = conversation('s1', T + 5_000, { status: 'running', threads, turns });

    const stub = await selectionStub([loaded], { live: 's1' });

    await import('./main');
    await flush();
    await flush();

    // Fresh load: collapsed, and the reader has to choose.
    expect(expandedTiles()).toEqual([]);

    // The explicit choice: the newest conversation's card.
    const tiles = [...document.querySelectorAll<HTMLElement>('.tile')];
    const chosen = tiles[2];
    chosen?.querySelector<HTMLButtonElement>('.tile-select')?.click();

    expect(expandedTiles()).toEqual([chosen]);
    expect(tiles[0]?.classList.contains('is-expanded')).toBe(false);
    const target = byClass('.composer-target', 'p');
    expect(target.dataset.mode).toBe('continue');
    expect(target.textContent).toBe('Continuing RR2');

    // A later authoritative frame: the same document, now settled. It must merge into
    // the open card, not rebuild the focus decision.
    stub.emit({
        type: 'snapshot',
        session: conversation('s1', T + 6_000, {
            threads,
            turns: [
                selectionTurn('ta', 0, 'first task', 'thread-1', T + 1_000),
                selectionTurn('tb', 1, 'second task', 'thread-1', T + 2_000),
                selectionTurn('tc', 2, 'third task', 'thread-2', T + 6_000)
            ]
        })
    });
    await flush();
    await flush();

    // Exactly one surface is open, and it is STILL the card the reader clicked. The
    // disclosure state rides the tile and its own `.tile-select`, and the steering
    // target is still the conversation the reader chose.
    expect(expandedTiles()).toEqual([chosen]);
    expect(document.querySelectorAll('.tile-select[aria-expanded="true"]')).toHaveLength(1);
    expect(chosen.querySelector('.tile-select')?.getAttribute('aria-expanded')).toBe('true');
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing RR2');
    expect(stub.reads).toEqual(['s1']);
});

// ---------------------------------------------------------------------------
// T24: ENTERING a harness resolves ITS latest conversation
// ---------------------------------------------------------------------------
//
// T21 R21 fixed only the app's first load. The user rule is "when first loaded a
// harness, it should select the latest session", so every FIRST entry into a harness (a
// rail row this visit has not resolved yet) resolves to that harness's most recently used
// conversation, through the same `latestSession` authority and the same `openSession`
// path (so T21 R22's collapse-on-load still renders nothing expanded). Guards:
//   - a harness with a conversation bound, or one already resolved in this visit, or one
//     the reader emptied with `+ New session`, is never re-picked — an explicit selection
//     outlives polling, refreshes and switches;
//   - a harness with NO conversations stays eligible (nothing was resolved), and
//   - the record read is guarded, because the reader can be somewhere else entirely by the
//     time a slow answer lands: rapid rail switching must never let the harness they left
//     take the screen back.

const workspaceHarness = (): HarnessDescriptor =>
    descriptor({
        name: 'workspace',
        title: 'Workspace',
        agents: ['workspace'],
        primary: 'workspace',
        requiresEndpoint: false
    });

const gammaHarness = (): HarnessDescriptor =>
    descriptor({
        name: 'gamma',
        title: 'Gamma',
        agents: ['gamma'],
        primary: 'gamma',
        requiresEndpoint: false
    });

// The multi-harness stub: the catalogue, the list route and one read per record, with
// `hold` naming the record whose read stays unanswered until `release(id)` — the only way
// to OBSERVE the rapid-switch race instead of tripping over it by accident.
//
// T37: `reads` counts the canonical row page of the conversation the shell opened (see
// `selectionStub`), and the socket double is installed so no test depends on jsdom's real
// `WebSocket` answering a dial no fixture drives.
const enterStub = async (
    rows: SessionSnapshot[],
    presets: HarnessDescriptor[],
    hold: string[] = []
): Promise<{ reads: string[]; release: (id: string) => void }> => {
    const reads: string[] = [];
    const waiters = new Map<string, (response: Response) => void>();

    await installLiveStream({});

    const fixture = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method;

        if (url === '/api') return json(bootstrap({ presets, sessions: rows }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: rows });

        const read = /^\/api\/sessions\/([^/]+)$/.exec(url);
        if (read !== null && method === undefined) {
            const id = decodeURIComponent(read[1]);
            const record = rows.find((row) => row.id === id);
            if (record === undefined) return json({ error: { message: `unknown session ${id}` } }, 404);

            if (hold.includes(id)) {
                return await new Promise<Response>((resolve) => waiters.set(id, resolve));
            }

            return json({ session: record });
        }

        return undefined;
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            canonicalReads.push(url);

            const opened = /^\/v1\/harness\/sessions\/([^/]+)\/turns$/.exec(url.split('?')[0] ?? url);
            if (opened !== null && init?.method === undefined) reads.push(decodeURIComponent(opened[1]));

            const answer = fixture(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return {
        reads,
        release: (id: string): void => {
            const settle = waiters.get(id);
            const record = rows.find((row) => row.id === id);
            if (settle === undefined || record === undefined) {
                throw new Error(`no held read for ${id}`);
            }

            waiters.delete(id);
            settle(json({ session: record }));
        }
    };
};

it('opens the most recently used conversation of the harness the reader enters', async () => {
    const instructRow = conversation('in-1', T + 2_000);
    // Shuffled on purpose, and the newest row of the entered harness is NOT the last one
    // listed: the pick comes from that harness's own stamps (T21 R21), never from position.
    const rows = [
        instructRow,
        conversation('ws-mid', T + 5_000, { harness: 'workspace' }),
        conversation('ws-new', T + 9_000, { harness: 'workspace' }),
        conversation('ws-old', T + 1_000, { harness: 'workspace' })
    ];

    const stub = await enterStub(rows, [descriptor(), workspaceHarness()]);

    await import('./main');
    await flush();
    await flush();

    // Boot resolved the harness it landed on (T21 R21), and only that one.
    expect(stub.reads).toEqual(['in-1']);

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();

    // Exactly one extra read: the newest WORKSPACE conversation.
    expect(stub.reads).toEqual(['in-1', 'ws-new']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Workspace');
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').getAttribute('aria-pressed')).toBe(
        'true'
    );
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('ws-new');
    expect(localStorage.getItem(SESSION_KEY)).toBe('ws-new');
    expect(activePillIds()).toEqual(['ws-new']);
    // T21 R22 is unchanged by an entry: the conversation opens, no thread expands.
    expect(expandedTiles()).toEqual([]);
});

it('enters a harness with no conversations as an empty view and opens nothing', async () => {
    const rows = [conversation('in-1', T + 2_000)];
    const stub = await enterStub(rows, [descriptor(), workspaceHarness()]);

    await import('./main');
    await flush();
    await flush();

    expect(stub.reads).toEqual(['in-1']);

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();

    // The harness is selected, the centre column is the empty one, and no record was read
    // for it: "latest session" of an empty directory is no session, not an error.
    expect(stub.reads).toEqual(['in-1']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Workspace');
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(byClass('.session-cycle', 'button').hidden).toBe(true);
    expect(document.querySelector('.empty-text')?.textContent).toBe('Send a task below to start this harness.');
    // The pointer still names the conversation last actually viewed.
    expect(localStorage.getItem(SESSION_KEY)).toBe('in-1');

    // And the harness stays ELIGIBLE: conversations that show up later are picked up by
    // the next entry rather than leaving a permanently empty view.
    expect(stub.reads).toEqual(['in-1']);
});

it('keeps the harness the reader switched to when the abandoned harness answers late', async () => {
    const rows = [
        conversation('in-1', T + 2_000),
        conversation('ws-slow', T + 8_000, { harness: 'workspace' }),
        conversation('gamma-1', T + 3_000, { harness: 'gamma' })
    ];

    // `ws-slow` is the newest workspace row, so entering workspace reads it — and that read
    // is held while the reader moves on to gamma.
    const stub = await enterStub(rows, [descriptor(), workspaceHarness(), gammaHarness()], ['ws-slow']);

    await import('./main');
    await flush();
    await flush();

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();

    // The read is still in flight; the reader enters another harness, which resolves at
    // once from its own newest row.
    expect(stub.reads).toEqual(['in-1', 'ws-slow']);
    byClass('.harness-item[data-harness="gamma"]', 'button').click();
    await flush();
    await flush();

    expect(stub.reads).toEqual(['in-1', 'ws-slow', 'gamma-1']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Gamma');
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('gamma-1');

    // Now the abandoned answer lands. It must not select workspace, bind its conversation
    // or move the pointer: the reader is on gamma.
    stub.release('ws-slow');
    await flush();
    await flush();

    expect(document.querySelector('.main-title')?.textContent).toBe('Gamma');
    expect(byClass('.harness-item[data-harness="gamma"]', 'button').getAttribute('aria-pressed')).toBe(
        'true'
    );
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').getAttribute('aria-pressed')).toBe(
        'false'
    );
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('gamma-1');
    expect(localStorage.getItem(SESSION_KEY)).toBe('gamma-1');
    expect(document.querySelector('.stage')?.textContent).not.toContain('task in ws-slow');
});

it('opens an entered conversation collapsed and keeps the reader expansion through a frame', async () => {
    const threads: DirectoryThread[] = [
        { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'RR1' },
        { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2, label: 'RR2' }
    ];
    const entered = conversation('ws-1', T + 5_000, {
        harness: 'workspace',
        status: 'running',
        threads,
        turns: [
            selectionTurn('ta', 0, 'workspace first', 'thread-1', T + 1_000),
            selectionTurn('tb', 1, 'workspace second', 'thread-2', T + 2_000, 'running')
        ]
    });

    // instruct (the first catalogue entry) has no conversation at all, so boot opens
    // nothing and the entry below is the first resolution workspace gets.
    const stub = await selectionStub([entered], { presets: [descriptor(), workspaceHarness()], live: 'ws-1' });

    await import('./main');
    await flush();
    await flush();

    expect(byClass('.session-cycle', 'button').hidden).toBe(true);

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();

    expect(stub.reads).toEqual(['ws-1']);
    // Every card collapsed on entry, and the composer offers a new thread.
    expect(expandedTiles()).toEqual([]);
    expect(byClass('.composer-target', 'p').dataset.mode).toBe('new');

    // The reader opens one conversation, and that becomes the steering target.
    const tiles = [...document.querySelectorAll<HTMLElement>('.tile')];
    const chosen = tiles[1];
    chosen?.querySelector<HTMLButtonElement>('.tile-select')?.click();
    expect(expandedTiles()).toEqual([chosen]);
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing RR2');

    // The live document settles: the open card merges in place and stays open.
    stub.emit({
        type: 'snapshot',
        session: conversation('ws-1', T + 6_000, {
            harness: 'workspace',
            threads,
            turns: [
                selectionTurn('ta', 0, 'workspace first', 'thread-1', T + 1_000),
                selectionTurn('tb', 1, 'workspace second', 'thread-2', T + 6_000)
            ]
        })
    });
    await flush();
    await flush();

    expect(expandedTiles()).toEqual([chosen]);
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing RR2');
    expect(stub.reads).toEqual(['ws-1']);
});

it('keeps the conversation the reader chose when they leave a harness and come back', async () => {
    const rows = [
        conversation('ws-old', T + 1_000, { harness: 'workspace' }),
        conversation('ws-new', T + 9_000, { harness: 'workspace' }),
        conversation('in-1', T + 2_000)
    ];

    const stub = await enterStub(rows, [descriptor(), workspaceHarness()]);

    await import('./main');
    await flush();
    await flush();

    // Entry resolves workspace to its newest row…
    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('ws-new');

    // …then the reader picks another conversation of the same harness explicitly.
    dashboard();
    byClass('.session-pills-bar-dialog .session-pill-select[data-session-id="ws-old"]', 'button').click();
    await flush();
    await flush();
    expect(stub.reads).toEqual(['in-1', 'ws-new', 'ws-old']);
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('ws-old');

    // Away and back: instruct keeps its own bound conversation (no read), and workspace
    // keeps the one the READER chose — the entry rule fires once per harness per visit.
    byClass('.harness-item[data-harness="instruct"]', 'button').click();
    await flush();
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('in-1');

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();

    expect(stub.reads).toEqual(['in-1', 'ws-new', 'ws-old']);
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('ws-old');
    expect(localStorage.getItem(SESSION_KEY)).toBe('ws-old');
    expect(activePillIds()).toEqual(['ws-old']);
});

it('leaves a harness empty across a switch when the reader started a new session', async () => {
    const rows = [conversation('in-1', T + 2_000), conversation('ws-1', T + 7_000, { harness: 'workspace' })];

    const stub = await enterStub(rows, [descriptor(), workspaceHarness()]);

    await import('./main');
    await flush();
    await flush();

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();
    expect(stub.reads).toEqual(['in-1', 'ws-1']);

    // `+ New session` is the explicit choice of an empty conversation.
    byClass('.harness-title-row .new-session', 'button').click();
    await flush();
    expect(byClass('.session-cycle', 'button').hidden).toBe(true);

    // Away and straight back: the empty composer is what the reader left, and the entry
    // rule does not hand them a saved conversation instead.
    byClass('.harness-item[data-harness="instruct"]', 'button').click();
    await flush();
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('in-1');

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();
    await flush();

    expect(stub.reads).toEqual(['in-1', 'ws-1']);
    expect(byClass('.session-cycle', 'button').hidden).toBe(true);
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
});

it('creates a harness from preset agents with an initial primary', async () => {
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses' && method === 'POST') {
            const request = body as { name: string; title: string; primary: string; subagents: string[] };
            return json(
                {
                    harness: descriptor({
                        name: request.name,
                        title: request.title,
                        agents: [request.primary, ...request.subagents],
                        primary: request.primary,
                        subagents: request.subagents,
                        builtin: false,
                        editable: true,
                        tools: [],
                        coreTools: [
                            'read',
                            'write',
                            'edit',
                            'glob',
                            'toolRequest',
                            'toolList',
                            'toolManage',
                            'toolCreate',
                            'records',

                            'tasks',
                            ...(request.subagents.length > 0 ? ['delegate'] : [])
                        ]
                    })
                },
                201
            );
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.new-harness', 'button').click();
    const panel = byClass('.create-harness', 'section');
    expect(panel.hidden).toBe(false);
    expect(byClass('.new-harness', 'button').getAttribute('aria-expanded')).toBe('true');

    byClass('.create-name', 'input').value = 'release-captain';
    byClass('.create-title-input', 'input').value = 'Release captain';

    const primary = byClass('.create-primary', 'select');
    primary.value = 'workspace';
    primary.dispatchEvent(new Event('change', { bubbles: true }));

    // The secondary select cannot offer the primary agent.
    const secondary = byClass('.create-agent-select', 'select');
    expect([...secondary.options].map((option) => option.value)).toEqual(['instruct', 'summarizer']);
    secondary.value = 'summarizer';
    byClass('.create-agent-add', 'button').click();

    expect([...document.querySelectorAll('.create-chip-name')].map((chip) => chip.textContent)).toEqual([
        'Summarizer'
    ]);

    byClass('.create-form', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    const post = calls.find((call) => call.url === '/api/harnesses' && call.method === 'POST');
    expect(post?.body).toEqual({
        name: 'release-captain',
        title: 'Release captain',
        primary: 'workspace',
        subagents: ['summarizer']
    });

    // The server's descriptor wins: the new harness is listed and selected.
    expect(panel.hidden).toBe(true);
    expect(harnessNames()).toEqual(['instruct', 'release-captain']);
    const selected = byClass('.harness-item[data-harness="release-captain"]', 'button');
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('Release captain');
    // A custom harness keeps the same rule: only the title shows, the badge stays
    // empty and hidden (the registry id `release-captain` is never rendered).
    expect(document.querySelector('.harness-id')?.textContent).toBe('');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(agentNames()).toEqual(['Workspace', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // R21.2: no right-rail core list follows the new harness; the global tools view
    // (detached while the chat is showing) carries that status instead.
    expect(document.querySelector('.core-tools')).toBeNull();
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
});

it('adds a picker agent, promotes it to primary and never duplicates a member', async () => {
    const base = descriptor();
    let current = base;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [base] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses/instruct' && method === 'PATCH') {
            const request = body as { primary: string; subagents: string[] };
            current = descriptor({
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents,
                // A server with a subagent allowlist adds delegate.
                coreTools: [
                    'read',
                    'write',
                    'edit',
                    'glob',
                    'toolRequest',
                    'toolList',
                    'toolManage',
                    'toolCreate',
                    'records',

                    'tasks',
                    ...(request.subagents.length > 0 ? ['delegate'] : [])
                ]
            });
            return json({ harness: current });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // T3/R3: the strip lists THIS team only (the dropdown that also listed every
    // advertised agent is gone), and `[+]` is what offers the rest of the trusted
    // library. The selected agent's instruction is on screen as an editor (not a
    // read-only block).
    openAgents();
    expect(agentEntries()).toEqual(['instruct']);
    byClass('.agent-dialog-add', 'button').click();
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-add-option')].map((option) => option.textContent)
    ).toEqual(['Summarizer', 'Workspace']);
    byClass('.agent-dialog-add', 'button').click();

    // 1. Adding is a local draft: `[+]` gives the outside agent a badge, and returning
    //    to the primary keeps it an add (never a promotion). Nothing was sent by the
    //    picker or the selection.
    byClass('.agent-dialog-add', 'button').click();
    byClass('.agent-dialog-add-option[data-agent="summarizer"]', 'button').click();
    expect(configuredAgent()).toBe('summarizer');
    // R4 (T7a): the added member's box holds the FULL prompt the agent runs — its identity
    // sentence AND its guideline block — and there is no second read-only reference to compare it
    // against (the `.agent-detail` element this assertion used to read is gone).
    expect(instructionBox().value).toBe(
        'Compress notes into at most two sentences.\n\nGuidelines:\n- Keep names and numbers.'
    );
    expect(document.querySelector('.agent-detail')).toBeNull();
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);

    selectConfigured('instruct');
    applyAction().click();
    await flush();

    // Complete team in one PATCH: primary + every remaining member as subagent. No
    // model/instruction keys are invented for a harness that has none.
    expect(calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({
        primary: 'instruct',
        subagents: ['summarizer']
    });
    expect(agentNames()).toEqual(['Instruct', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // R21.2: the core set is no longer rendered anywhere; the global tools view lists
    // every tool (core entries included) from the server catalogue instead.
    expect(document.querySelector('.core-tool-name')).toBeNull();

    // 2. R3: VIEWING the secondary does not promote it — the panel's own control arms
    //    the promotion, and the request lists the demoted old primary exactly once.
    selectConfigured('summarizer');
    expect(applyAction().textContent).toBe('Save configuration');
    expect(applyAction().disabled).toBe(true);

    promoteToggle().click();
    expect(applyAction().textContent).toBe('Save & set primary');
    applyAction().click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[1]?.body).toEqual({
        primary: 'summarizer',
        subagents: ['instruct']
    });
    expect(agentNames()).toEqual(['Summarizer', 'Instruct']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);

    // 3. Removing is opt-IN through `Remove from team`, and the team never ends up
    //    without a primary: the removed agent loses its badge, so the view lands on the
    //    primary rather than configuring an agent the save drops.
    selectConfigured('instruct');
    memberToggle().click();
    expect(configuredAgent()).toBe('summarizer');

    applyAction().click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[2]?.body).toEqual({
        primary: 'summarizer',
        subagents: []
    });
    expect(agentNames()).toEqual(['Summarizer']);

    // The only member is the primary: its team controls are locked WITH the reason on
    // the control, so a harness can never be saved with zero agents.
    selectConfigured('summarizer');
    expect(memberToggle().disabled).toBe(true);
    expect(memberToggle().title).toBe('The primary agent is always part of the team.');
    expect(document.querySelector('.agent-dialog-field-note')).toBeNull();
});

it('views another agent configuration without promoting it or PATCHing the team', async () => {
    const base = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer']
    });
    let current = base;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [base] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });

        if (url === '/api/harnesses/instruct' && method === 'PATCH') {
            const request = body as {
                primary: string;
                subagents: string[];
                agentModels?: Record<string, string>;
            };
            current = descriptor({
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents,
                agentModels: request.agentModels
            });
            return json({ harness: current });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // T3: the dialog opens on the primary's configuration, and both members are listed.
    openAgents();
    expect(configuredAgent()).toBe('instruct');
    expect(agentRoles()).toEqual(['primary', 'secondary']);

    // Viewing the secondary sends NOTHING: selection is local draft state, so the
    // primary and the team are untouched.
    selectConfigured('summarizer');
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(configuredAgent()).toBe('summarizer');
    expect(agentRoles()).toEqual(['primary', 'secondary']);

    // The model choice is a draft too. The one explicit action writes it, and R3: the
    // promotion the reader did NOT arm does not travel with it.
    const select = byClass('.agent-model-select', 'select');
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(applyAction().textContent).toBe('Save configuration');

    applyAction().click();
    await flush();

    // The team is restated unchanged (instruct stays the primary), and the model map is
    // the complete stored map plus the drafted entry.
    expect(calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({
        primary: 'instruct',
        subagents: ['summarizer'],
        agentModels: { summarizer: 'm2' }
    });
    // The rebuild the PATCH triggers keeps the configuration being viewed (it is still
    // a member) and shows the saved model instead of yanking the reader elsewhere.
    expect(configuredAgent()).toBe('summarizer');
    expect(byClass('.agent-model-select', 'select').value).toBe('m2');
    expect(agentRoles()).toEqual(['primary', 'secondary']);
});

it('drops a removed member from the roster and offers it back through the add picker', async () => {
    const base = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer']
    });
    let current = base;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [base] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses/instruct' && method === 'PATCH') {
            const request = body as { primary: string; subagents: string[] };
            current = descriptor({
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents
            });
            return json({ harness: current });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R3: `Remove from team` drops the badge at once, so the view lands on the primary
    // rather than configuring an agent this save would drop. Nothing is promoted by the
    // removal, and nothing was sent by the click itself.
    openAgents();
    selectConfigured('summarizer');
    memberToggle().click();
    expect(configuredAgent()).toBe('instruct');
    expect(agentRoles()).toEqual(['primary']);

    applyAction().click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({
        primary: 'instruct',
        subagents: []
    });
    expect(agentNames()).toEqual(['Instruct']);
    expect(agentRoles()).toEqual(['primary']);

    // The removed agent is still a trusted agent — it just left the team — so it has no
    // badge (the strip lists THIS team only) and `[+]` offers it again. Re-adding it is
    // the undo, and it is still only a draft.
    expect(document.querySelector('.agent-dialog-tab[data-agent="summarizer"]')).toBeNull();
    addAgent('summarizer');
    expect(agentEntries()).toEqual(['instruct', 'summarizer']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => tab.dataset.added ?? '')
    ).toEqual(['', 'true']);
    expect(memberToggle().disabled).toBe(false);
    expect(applyAction().textContent).toBe('Save configuration');

    memberToggle().click();
    expect(agentEntries()).toEqual(['instruct']);
    expect(applyAction().disabled).toBe(true);

    // The one surviving member is the primary: its team control is locked with the
    // reason ON the control, so the team can never be saved empty.
    selectConfigured('instruct');
    expect(memberToggle().disabled).toBe(true);
    expect(memberToggle().title).toBe('The primary agent is always part of the team.');
    expect(document.querySelector('.agent-dialog-field-note')).toBeNull();
});

it('views a saved conversation’s team and saves a model draft through the session PATCH', async () => {
    const frozen = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer'],
        coreTools: [
            'read',
            'write',
            'edit',
            'glob',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'records',

            'tasks',
            'delegate'
        ]
    });
    const restored = snapshot({ harnessDefinition: frozen } as Partial<SessionSnapshot>);
    localStorage.setItem(SESSION_KEY, 's1');

    const patches: unknown[] = [];
    stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor()], sessions: [restored] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: restored });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [restored] });

        if (url === '/api/sessions/s1' && method === 'PATCH') {
            patches.push(body);
            return json({
                session: snapshot({
                    harnessDefinition: frozen,
                    agentModels: { summarizer: 'm2' },
                    updatedAt: 3
                } as Partial<SessionSnapshot>)
            });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R2/T3: the team and the instructions are frozen, but VIEWING another agent is
    // not a team edit, so the dropdown reaches every member.
    openAgents();
    selectConfigured('summarizer');
    await flush();

    // T7b (R2/R5/R6): the conversation's prompts and team are its own to edit, and VIEWING another
    // member is not a team change, so the strip reaches every member and nothing here is locked by
    // the session. The one thing the conversation cannot do is move its entry agent, and a
    // promotion cannot be armed at all.
    expect(configuredAgent()).toBe('summarizer');
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    expect(instructionBox().disabled).toBe(false);
    expect(memberToggle().disabled).toBe(false);
    expect(promoteToggle().disabled).toBe(true);
    // No team change was attempted, and the action cannot promote here.
    expect(patches).toEqual([]);
    expect(applyAction().textContent).toBe('Save configuration');
    expect(applyAction().disabled).toBe(true);

    // The viewed agent's model is live (R2), but a selection is only a DRAFT: the
    // PATCH happens on the explicit action, and it never touches the frozen team.
    const select = byClass('.agent-model-select', 'select');
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('');

    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(patches).toEqual([]);

    applyAction().click();
    await flush();

    // The wire spelling, not the render model's: `PATCH /sessions/:id` takes the contract's
    // `UpdateSessionRequest.agent_models` (../shared/harness-api.ts), exactly as the catalog
    // cards do (catalogue.test.ts:17). The camelCase `agentModels` is what the DOCUMENT and the
    // dialog hold, so a draft written through the real control path must leave in snake_case.
    expect(patches).toEqual([{ agent_models: { summarizer: 'm2' } }]);

    // The refresh keeps the viewed configuration and shows the saved model.
    expect(configuredAgent()).toBe('summarizer');
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    expect(byClass('.agent-model-select', 'select').value).toBe('m2');
});

it('adds a member to a saved conversation through its own roster, never the harness template', async () => {
    // T7b (R5/R7): the same `[+]` press that PATCHes `/harnesses/:name` in a template context is a
    // `POST /sessions/{id}/agents` here, and the conversation's roster is the thing that grows.
    // The shared double answers the create AND the reads that follow from one state, so the tab on
    // screen after the save is evidence the roster moved — not evidence the client redrew it.
    const frozen = descriptor({
        agents: ['instruct'],
        primary: 'instruct',
        subagents: []
    });
    const saved = snapshot({ id: 's1', harnessDefinition: frozen } as Partial<SessionSnapshot>);

    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor()], sessions: [saved] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: saved });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [saved] });

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // A one-member team: `[+]` still offers the trusted library, and picking one is a local draft.
    addAgent('summarizer');
    expect(agentEntries()).toEqual(['instruct', 'summarizer']);
    expect(calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/sessions/'))).toEqual([]);

    applyAction().click();
    await flush();
    await flush();
    await flush();

    // Exactly one roster write, on the conversation, with the profile named — and no template write
    // of any kind (a conversation's team is not the template's team). `/api/models` is POSTed by
    // the catalogue read, so the filter is scoped to the session surface.
    expect(calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/sessions/'))).toEqual([
        {
            url: '/api/sessions/s1/agents',
            method: 'POST',
            body: { name: 'summarizer', profile: 'summarizer' }
        }
    ]);
    expect(calls.filter((call) => call.method === 'PATCH' && call.url.startsWith('/api/harnesses'))).toEqual([]);
    expect(calls.filter((call) => call.method === 'PATCH' && call.url === '/api/sessions/s1')).toEqual([]);

    // The added member is still on the strip after the refresh, and the save states its scope.
    expect(agentEntries()).toEqual(['instruct', 'summarizer']);
    expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
        'agent configuration saved · applies to this conversation'
    );
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
});

it('blocks removing an agent a conversation in the session runs, with the reason on the control', async () => {
    // T7b (R6): `instance.threads` is the shell's live host-thread roster, and a member that owns
    // one cannot be detached (src/server/sessions.ts:5059-5074 answers 409 on exactly that
    // condition). The control says so, and the reason is repeated as a visible note because a
    // disabled control's tooltip is not reachable.
    const frozen = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer']
    });
    const saved = snapshot({
        id: 's1',
        harnessDefinition: frozen,
        threads: [
            { id: 'thread-2', agent: 'summarizer', origin: 'host', status: 'idle', sequence: 2, label: 'SU2' }
        ]
    } as Partial<SessionSnapshot>);

    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ presets: [frozen], sessions: [saved] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: saved });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [saved] });

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // The primary is removable in principle (no thread names it) and the secondary is not.
    openAgents();
    expect(memberToggle().disabled).toBe(true);
    expect(memberToggle().title).toBe('The primary agent is always part of the team.');

    selectConfigured('summarizer');
    expect(memberToggle().disabled).toBe(true);
    expect(memberToggle().title).toBe(
        'This agent is used by a conversation in this session; delete that conversation before removing the agent.'
    );
    expect(byClass('.agent-dialog-inuse', 'p').textContent).toBe(
        'This agent is in use by a conversation and cannot be removed.'
    );

    // A press of a disabled control drafts nothing, so a save cannot be armed and no DELETE can
    // race the conversation that owns the member.
    byClass('.agent-dialog-remove', 'button').click();
    expect(applyAction().disabled).toBe(true);
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
});

it('filters the session strip to the selected harness and opens within it', async () => {
    const instruct = descriptor();
    const workspace = descriptor({
        name: 'workspace',
        title: 'Workspace',
        agents: ['workspace'],
        primary: 'workspace',
        requiresEndpoint: false
    });

    const instructSession = snapshot({ id: 's1', harness: 'instruct' });
    const workspaceSession = snapshot({ id: 's2', harness: 'workspace' });
    const foreign = snapshot({ id: 's3', harness: 'retired' });

    stubFetch((url) => {
        if (url === '/api') {
            return json(
                bootstrap({
                    presets: [instruct, workspace],
                    sessions: [instructSession, workspaceSession, foreign]
                })
            );
        }
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s2') return json({ session: workspaceSession });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(harnessNames()).toEqual(['instruct', 'workspace']);
    expect(liveSessionIds()).toEqual(['s1']);
    // R6: `retired` is not a harness this server reports, so its conversation is not
    // silently attributed to the selected one — it stays reachable in the strip, flagged
    // `data-archived` instead of living in a rail group with its own heading (T3/R1).
    expect(archivedSessionIds()).toEqual(['s3']);
    // T3/R1: the "Locked to <harness>" sentence is gone; scoping is what the id list
    // below proves, and the harness in each pill's tooltip is who it belongs to.
    expect(document.querySelector('.sessions-scope')).toBeNull();

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();

    expect(liveSessionIds()).toEqual(['s2']);
    expect(archivedSessionIds()).toEqual(['s3']);
    expect(agentNames()).toEqual(['Workspace']);

    dashboard();
    byClass('.session-pill-select[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    // Opening a session keeps its harness selected — never switches it.
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').getAttribute('aria-pressed')).toBe(
        'true'
    );
    expect(document.querySelector('.main-title')?.textContent).toBe('Workspace');
    // Switching harness (or opening one of its sessions) repaints the chat head,
    // which always leaves the badge empty and hidden.
    expect(document.querySelector('.harness-id')?.textContent).toBe('');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(liveSessionIds()).toEqual(['s2']);
});

it('keeps the existing session when endpoint settings change', async () => {
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'keep me',
        status: 'done',
        startedAt: T,
        updatedAt: T + 1000,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'text', agent: 'instruct', delta: 'kept' }
        ]
    };

    const existing = snapshot({ turns: [recorded] });
    localStorage.setItem(SESSION_KEY, 's1');

    let created = 0;
    let deleted = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [existing] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: existing });

        if (url === '/api/sessions') {
            if (method === 'POST') {
                created += 1;

                return json({ session: snapshot() });
            }

            // The raw list route answers a LIST (`{sessions}`, protocol.ts) — a `{session}` body
            // here made the canonical directory page empty, so the remembered conversation had
            // nothing to restore against and the board stayed in the new-session state (which is
            // what `.empty-title` still says).
            return json({ sessions: [existing] });
        }

        if (method === 'DELETE') {
            deleted += 1;
            return json({ deleted: true });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Change the base URL through the real input path (this is a *draft*: it is
    // only used the next time a session is created).
    //
    // R4 (T4): the fields are no longer a rail disclosure — they live in the dialog the
    // top-right status pill opens, so the input path starts with that trigger. The rail
    // assertion is the same change from the other side: nothing endpoint-shaped is left
    // inside `.rail-left`.
    expect(document.querySelector('.rail-left .endpoint-body')).toBeNull();
    byClass('.status-button', 'button').click();

    // The provider Base URL control, addressed through the `label.field` wrapper rather
    // than by position: since the harness server URL group was added at the TOP of
    // `.endpoint-body` (./main.ts), a bare `input.field-input` here would land on THAT
    // field and this test would silently stop editing the endpoint. The wrapper's own
    // label text is pinned so the selector cannot drift onto the API key either.
    const baseURL = byFieldLabel('Base URL');

    baseURL.value = 'http://other-provider/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    // The edit really hit the provider draft (the payload `underload-harness-app:settings`
    // is what a session create reads), which is the "endpoint settings change" this test
    // is named for.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://other-provider/v1","apiKey":"","model":"m1"}'
    );

    // Long enough for the debounced model refresh to fire, so a bug that tripped
    // session recreation on any settings change would have happened by now.
    await new Promise((resolve) => setTimeout(resolve, 650));
    await flush();

    expect(created).toBe(0);
    expect(deleted).toBe(0);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector('.agent-text')?.textContent).toBe('kept\n');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    dashboard();
    expect(byClass('.session-pill-select', 'button').dataset.active).toBe('true');
});

it('replaces the projected stream with the authoritative terminal snapshot', async () => {
    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'go',
        status: 'done',
        startedAt: T,
        updatedAt: T + 500,
        events: [start, { type: 'text', agent: 'instruct', delta: 'server wins' }]
    };

    const finished = snapshot({ turns: [recorded] });
    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };

    // T42/T50: the live plane is the canonical `harness.v1` socket (the client has no SSE
    // fallback, ./stream.ts:40-43), so the transient projection frames and the authoritative
    // terminal snapshot ride `live.push` in the server's own order. `host` is the document the
    // SERVER holds and every canonical read is composed from it, so it moves forward exactly when
    // the snapshot frame lands.
    let host = snapshot({ status: 'running', turns: [opening] });
    const live = await liveStream('s1', () => host);

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() });

        // The one raw record the whole canonical surface is composed from.
        if (url === '/api/sessions/s1') return json({ session: host });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json(
                {
                    session: snapshot({ turns: [opening], status: 'running' }),
                    turn: opening
                },
                202
            );
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    // A frame is addressed to a SUBSCRIPTION, so the push waits for the shell's own
    // `session` subscription — the order the real server delivers in.
    await subscribed(live, 'session', 's1');
    live.push([
        { type: 'turn', turn: opening },
        { type: 'event', turnId: 't1', event: start, at: T },
        // A transient projection the server did not record.
        { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'draft ' }, at: T + 100 },
        { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'that differs' }, at: T + 200 }
    ]);
    await flush();
    await flush();

    // The projection really is on screen before the authoritative record lands — without this the
    // "replaces" claim below could be satisfied by a row that never showed the draft at all.
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>draft that differs</p>\n');

    host = finished;
    live.push([{ type: 'snapshot', session: finished }]);
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>server wins</p>\n');
    expect(document.querySelector('.agent-text')?.textContent).not.toContain('draft');
});

it('stops every task in the originating session while a run is in flight', async () => {
    let cancelRequests = 0;
    let cancelBody: unknown;

    const other = descriptor({ name: 'workspace', title: 'Workspace', agents: ['workspace'], primary: 'workspace' });
    const runningTurn: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'long one',
        status: 'running',
        startedAt: T,
        updatedAt: T,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const cancelledTurn: SessionTurn = { ...runningTurn, status: 'cancelled', updatedAt: T + 100 };
    const transcript = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningTurn]
    });
    const cancelled = snapshot({ harnessDefinition: descriptor(), turns: [cancelledTurn] });

    // T42/T50: the run's live plane is the canonical socket. The fixture used to hold an SSE
    // response open forever and RESOLVE nothing until the client aborted it, because the abort was
    // the observable; on the canonical surface the client never dials `/events` at all (no SSE
    // fallback, ./stream.ts:40-43), so that promise was never settled and the test timed out on
    // `await started`. The socket double supplies the same two facts: the shell's own `session`
    // subscription (the equivalent of "the observer is open") and the cancelled terminal record.
    let host: SessionSnapshot = transcript;
    const live = await liveStream('s1', () => host);

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [descriptor(), other] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: transcript });
            if (url === '/api/sessions/s1/tasks' && init?.method === 'POST') {
                return json({ session: transcript, turn: runningTurn }, 202);
            }

            // The document every canonical read is composed from: the running record until the
            // stop lands, the cancelled record afterwards.
            if (url === '/api/sessions/s1' && init?.method === undefined) {
                return json({ session: host });
            }

            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                cancelRequests += 1;
                cancelBody = init.body === undefined ? undefined : JSON.parse(String(init.body));
                return json({ cancelled: true });
            }

            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [transcript] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'long one';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await subscribed(live, 'session', 's1');
    await flush();

    // The queue is server-owned, so switching harness stays possible while it runs;
    // the team row is locked (frozen session) and New session refuses pending work.
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').disabled).toBe(false);
    expect(byClass('.new-session', 'button').disabled).toBe(true);
    openAgents();
    // T3: mid-run the team/instruction editors are locked (the reason is the dialog's
    // own note), and the membership toggle is part of that lock.
    expect(memberToggle().disabled).toBe(true);
    expect(instructionBox().disabled).toBe(true);
    // R2: the TEAM is locked mid-run, the MODEL is not — it edits the session's live
    // map for the next request and never cancels this stream.
    const streamingSelect = byClass('.agent-model-select', 'select');
    expect(streamingSelect.disabled).toBe(false);
    expect(streamingSelect.title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );

    // R10: the running session, with an empty field, exposes the stop action in the
    // composer's one button slot.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    expect(composerAction.hidden).toBe(false);
    composerAction.click();
    await flush();

    // The server's own terminal record for the stop lands on the socket, exactly as it does for a
    // run that ends by itself: `POST /sessions/:id/cancel` answers the COMMAND, then the cancelled
    // row is re-published (`turn.upsert`) and the session settles (`session.updated` + the rows),
    // which is what repaints the tile. A snapshot frame alone does not claim the row's tree, so the
    // row upsert is the frame that carries the cancellation the reader sees.
    host = cancelled;
    live.push([{ type: 'turn', turn: cancelledTurn }, { type: 'snapshot', session: cancelled }]);
    await flush();
    await flush();

    // Stop is total: the body says `{ all: true }` so retained queue records are
    // cancelled too, and the tile shows the server's cancellation.
    expect(cancelRequests).toBe(1);
    expect(cancelBody).toEqual({ all: true });
    expect(tileStates()).toEqual(['cancelled']);
    // A deliberate stop is a session outcome: the tile says `cancelled`, and the
    // global header stays app-scoped instead of announcing the run's end.
    expect(statusText()).toBe('idle');
    expect(document.querySelector('.session-note')?.hasAttribute('hidden')).toBe(true);
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').disabled).toBe(false);
    // The queue drained: no text, no pending work, no action (R10).
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');
});

it('stops polling a running session when another harness is selected', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 500,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    const other = descriptor({ name: 'workspace', title: 'Workspace', agents: ['workspace'], primary: 'workspace' });
    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor(), other], sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') {
            gets += 1;
            return json({ session: running });
        }
        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);
    expect(gets).toBe(1);

    // The reader moves on before the first poll fires.
    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await vi.advanceTimersByTimeAsync(3000);

    expect(gets).toBe(1);
    expect(sessionIds()).toEqual([]);
    expect(statusText()).toBe('idle');
});

it('clears polling and elapsed timers on pagehide', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: Date.now() - 500,
        updatedAt: Date.now(),
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    localStorage.setItem(SESSION_KEY, 'r1');

    // R5/T50: the live plane is the canonical socket, and the poll is only the FALLBACK for a run
    // the socket cannot carry (main.ts:8502-8520, `POLL_INTERVAL_MS` / `POLL_MAX_ATTEMPTS` — bounded
    // by design). This case states the degraded host directly: NO `WebSocket` constructor, so
    // stream.ts has no transport to dial (stream.ts:193-199), ./view-shell.ts:485-490 settles the
    // observation at once, and `startWatching` puts the conversation on `pollSession`
    // (main.ts:8917-8930). A HEALTHY socket must not poll, which every live case in this file pins
    // by its exact read count; a poll running next to a live connection is the pattern the R5
    // performance rule forbids.
    //
    // The count is taken from the OUTER recorder (`metaReadsFor`, one canonical
    // `GET /v1/harness/sessions/:id` per refresh), never from the raw `/api/sessions/:id` route: the
    // shared double re-reads that route once per canonical answer it composes, so a raw count answers
    // "how many probes did the double make", not "how often did the SHELL refresh".
    vi.stubGlobal('WebSocket', undefined);

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') return json({ session: running });
        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    // The remembered conversation is open, and it was opened by exactly ONE metadata read: while
    // the socket is up, nothing re-reads the resource (no healthy-WS poll, on demand or otherwise).
    expect(metaReadsFor('r1')).toHaveLength(1);

    // Offline: the bounded fallback takes over and re-reads the resource rather than freezing on
    // the first answer. The behaviour under test is "it keeps refreshing while offline", so the
    // count only has to GROW here; the exact figure is the reconnect cadence's business and is
    // pinned by the frozen count after `pagehide` below.
    await vi.advanceTimersByTimeAsync(3_000);
    const refreshed = metaReadsFor('r1').length;
    expect(refreshed).toBeGreaterThan(1);
    const before = tileElapsed()[0];

    window.dispatchEvent(new Event('pagehide'));
    // Both the poll and the live tick are gone: neither may fire again.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(metaReadsFor('r1')).toHaveLength(refreshed);
    expect(tileElapsed()[0]).toBe(before);
});

// ---------------------------------------------------------------------------
// R4 queue: submit behind the active task, advance in FIFO order
// ---------------------------------------------------------------------------
it('queues a second task behind the active one and advances it automatically', async () => {
    // T42/T50: the queue is driven by the canonical `harness.v1` socket, not an SSE body. The
    // client has no SSE fallback (`./stream.ts:40-43`), so a fixture that pushes its frames on
    // `/sessions/:id/events` never reaches the shell at all: the first row stays `streaming`, the
    // queued row stays `queued`, and the drain never happens. `live.push` addresses the shell's own
    // `session` subscription and the double folds each raw item with the server's projector.
    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };

    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [start, { type: 'text' as const, agent: 'instruct', delta: 'first answer' }]
    } as SessionTurn;
    const doneA = {
        ...runningA,
        status: 'done' as const,
        updatedAt: T + 100,
        events: [...runningA.events, { type: 'done' as const, agent: 'instruct', message: assistant() }]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;
    const runningB = {
        ...queuedB,
        status: 'running' as const,
        startedAt: T + 200,
        updatedAt: T + 210,
        events: [start]
    } as SessionTurn;
    const doneB = {
        ...runningB,
        status: 'done' as const,
        updatedAt: T + 400,
        events: [
            ...runningB.events,
            { type: 'text' as const, agent: 'instruct', delta: 'second answer' },
            { type: 'done' as const, agent: 'instruct', message: assistant() }
        ]
    } as SessionTurn;

    const first = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [runningA] });
    const both = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    // The document the SERVER holds, moved forward exactly when the socket's terminal `snapshot`
    // frame is pushed (the same rule the boot test follows): every canonical read the shell dials
    // — the metadata patch, the row page — is composed from this record, so it must describe the
    // conversation at the moment the read is answered.
    let host: SessionSnapshot = first;
    const drain = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [doneA, runningB] });
    const settled = snapshot({ harnessDefinition: descriptor(), turns: [doneA, doneB] });

    // The live surface must exist BEFORE the shell boots, or the shell never subscribes.
    const live = await liveStream('s1', () => host);

    let tasks = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        // The one raw record the whole canonical surface is composed from.
        if (url === '/api/sessions/s1') return json({ session: host });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [] });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            tasks += 1;
            return tasks === 1
                ? json({ session: first, turn: runningA }, 202)
                : json({ session: both, turn: queuedB }, 202);
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const form = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // Task A starts processing.
    input.value = 'first task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    // A frame is addressed to a SUBSCRIPTION, so the first push waits for the shell's `session`
    // subscription — the order the real server delivers in.
    await subscribed(live, 'session', 's1');
    live.push([{ type: 'turn', turn: runningA }]);
    await flush();

    expect(tasks).toBe(1);
    expect(tileStates()).toEqual(['streaming']);
    // R4/R10: with A running and the field empty the one action is STOP; typing
    // turns that same control into an ENABLED submit, which is still queueing.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    input.value = 'queued while running';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(composerAction.dataset.action).toBe('submit');
    expect(composerAction.disabled).toBe(false);

    // Task B is submitted BEHIND A and is visibly queued, neutral.
    input.value = 'second task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    expect(tasks).toBe(2);
    expect(tileStates()).toEqual(['streaming', 'queued']);
    expect(document.querySelectorAll('.turn-row')[1]?.getAttribute('data-state')).toBe('queued');
    // Queued B has no clock, and the stop action covers the whole queue. Reset is
    // gone (R10): no third composer control exists while work is pending.
    expect(tileElapsed()[1]).toBe('');
    expect(composerAction.dataset.action).toBe('stop');
    expect(composerAction.disabled).toBe(false);
    expect(document.querySelector('.composer .reset')).toBeNull();
    // R2: models stay editable while a queue runs.
    openAgents();
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);

    // A completes; the server advances B without another submit.
    host = drain;
    live.push([{ type: 'turn', turn: doneA }]);
    live.push([{ type: 'snapshot', session: drain }]);
    await flush();
    await flush();

    expect(tileStates()).toEqual(['done', 'streaming']);

    // B streams its text, then the drain snapshot settles both.
    host = settled;
    live.push([{ type: 'event', turnId: 'tb', event: { type: 'text', agent: 'instruct', delta: 'second answer' } }]);
    live.push([{ type: 'snapshot', session: settled }]);
    live.close();
    await flush();
    await flush();

    expect(tileStates()).toEqual(['done', 'done']);
    // DEFECT (renderer, U8): this is the fact the SSE fixture used to satisfy for free. On the
    // canonical surface a settled row's answer is its LAZY display tree (the double's terminal
    // `snapshot` frame re-publishes rows without claiming trees, ./view-test-support.ts:2629-2631),
    // and neither the session-scope `event` frame above nor the recorded `doneB` row paints it, so
    // the row has no `.agent-text` node at all. Pinning the answer requires the renderer to state
    // which gesture pays for the tree; a `.tile-select` click after the socket closes does NOT
    // expand this row (`is-expanded` stays false), so the product contract is missing, not the
    // fixture. Same gap `keeps one row per task when the observer beats the POST answer` hits.
    expect(document.querySelectorAll('.tile')[1].querySelector('.agent-text')?.textContent).toBe(
        'second answer\n'
    );
    // No duplicated events: A's single text block appears exactly once.
    expect(document.querySelectorAll('.tile')[0].querySelectorAll('.agent-text')).toHaveLength(1);
    expect(document.querySelector('.tile-elapsed')?.textContent).toBe('100ms');
    // Queue drained + empty field: no action at all (R10).
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');
});

// R2 regression: a delayed 202 answer must not revert a model edit.
//
// The 202 body is captured at ENQUEUE time. A model PATCH made while that answer
// is still in flight changes `sessionModels`/`sessionModel` immediately, so a stale
// body applied afterwards must not rewrite the definition, the model map, the
// discovery list or the rail cache (it may only reconcile turn records).
it('keeps a live model edit when the delayed 202 answer lands afterwards', async () => {
    let sendAnswer!: (value: unknown) => void;
    const answer = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                sendAnswer = (value) => {
                    controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                    controller.close();
                };
            }
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };

    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [start]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;

    // What the still-in-flight 202 body says (captured before the PATCH).
    const staleBoth = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        model: 'm1',
        agentModels: { instruct: 'm1' },
        updatedAt: T + 20,
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    // The PATCH answer: the session now runs m2, stamped NEWER.
    const patched = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        model: 'm2',
        agentModels: { instruct: 'm2' },
        updatedAt: T + 300,
        turns: [runningA, queuedB]
    } as SessionSnapshot);

    let tasks = 0;
    const patches: unknown[] = [];

    // T42/T50: the live plane is the canonical `harness.v1` socket — the client never dials an SSE
    // `/events` route (no fallback, ./stream.ts:40-43), so the hand-rolled stream this test pushed
    // into was never read and the queued row never claimed its optimistic twin. The held-open 202
    // BODY stays (it is a JSON answer, not an observer): the fact pinned here is the order — the
    // socket's queued upsert lands first, the stale ack lands after the model PATCH.
    let host = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningA]
    }) as SessionSnapshot;
    const live = await liveStream('s1', () => host);

    stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        // The document every canonical read is composed from.
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: host });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            tasks += 1;
            return tasks === 1
                ? json(
                      {
                          session: snapshot({
                              harnessDefinition: descriptor(),
                              status: 'running',
                              model: 'm1',
                              agentModels: { instruct: 'm1' },
                              updatedAt: T + 10,
                              turns: [runningA]
                          } as SessionSnapshot),
                          turn: runningA
                      },
                      202
                  )
                : answer;
        }

        if (url === '/api/sessions/s1' && method === 'PATCH') {
            patches.push(body);
            return json({ session: patched });
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const form = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // A runs, then B is submitted with its 202 answer held open.
    input.value = 'first task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    await subscribed(live, 'session', 's1');
    live.push([{ type: 'turn', turn: runningA }]);
    await flush();

    input.value = 'second task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(tasks).toBe(2);

    // B's queued upsert claims the optimistic row.
    host = staleBoth;
    live.push([{ type: 'turn', turn: queuedB }]);
    await flush();
    expect(tileStates()).toEqual(['streaming', 'queued']);

    // While the answer is in flight the reader changes the session's model. The
    // effective model is what the dropdown DISPLAYS: an override equal to the
    // session fallback is represented by option 0 (ui/agents.ts dedupe rule).
    openAgents();
    const shownModel = (): string | null =>
        byClass('.agent-model-select', 'select').selectedOptions[0]?.textContent ?? null;

    const select = byClass('.agent-model-select', 'select');
    expect(select.disabled).toBe(false);
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    // T3: the selection alone is a draft; the explicit action writes it.
    expect(patches).toEqual([]);
    applyAction().click();
    await flush();

    // The canonical session PATCH body (../shared/harness-api.ts `SessionPatchRequest`, snake_case
    // like every other wire field — see `agent_models` on `SessionResource`), which is what the
    // double forwards verbatim from `PATCH /v1/harness/sessions/:id`.
    expect(patches).toEqual([{ agent_models: { instruct: 'm2' } }]);
    expect(shownModel()).toBe('m2');

    // The stale 202 body lands now: it predates the PATCH.
    sendAnswer({ session: staleBoth, turn: queuedB });
    await flush();
    await flush();

    // The model edit survives: the definition and model map came from the PATCH,
    // and the stale body may only reconcile the turns.
    expect(shownModel()).toBe('m2');
    expect(tileStates()).toEqual(['streaming', 'queued']);
    expect(document.querySelectorAll('.tile')).toHaveLength(2);
});

// R2 regression: the enqueue/observer race.
//
// src/server/sessions.ts publishes the queued `turn` upsert BEFORE the 202 body, and
// the 202 body itself is captured at ENQUEUE time. So a task submitted while
// another runs can produce, in this order on the client:
//   1. observer `turn` frames for the new turn (queued, then running),
//   2. the older 202 snapshot (A still running, B still queued).
// Before this was reconciled, (1) adopted a SECOND tile for the new prompt, and
// (2) then regressed the tiles to the stale statuses — leaving duplicated,
// out-of-order green rows above the completed ones. One row per task, one
// processing row, chronological order.
it('keeps one row per task when the observer beats the POST answer', async () => {
    // A POST answer whose body is only closed when the test says so: this is what
    // makes the observer frames arrive BEFORE the ack, deterministically.
    let sendAnswer!: (value: unknown) => void;
    const answer = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                sendAnswer = (value) => {
                    controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                    controller.close();
                };
            }
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };

    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [start]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;
    const runningB = {
        ...queuedB,
        status: 'running' as const,
        startedAt: T + 200,
        updatedAt: T + 210,
        events: [start]
    } as SessionTurn;
    const doneA = {
        ...runningA,
        status: 'done' as const,
        startedAt: T,
        updatedAt: T + 100,
        events: [...runningA.events, { type: 'done' as const, agent: 'instruct', message: assistant() }]
    } as SessionTurn;

    // The 202 body: captured when B was enqueued, i.e. A running + B queued.
    const staleBoth = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        updatedAt: T + 20,
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    // What the observer already knows when that body finally resolves.
    const fresh = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        updatedAt: T + 500,
        turns: [doneA, runningB]
    } as SessionSnapshot);

    let tasks = 0;

    // T42/T50: same conversion as the delayed-202 test — the observer frames ride the canonical
    // socket, and the enqueue/observer race is reproduced by holding the 202 BODY open (`answer`),
    // which is a JSON answer, not an SSE observer. `host` is the record every canonical read is
    // composed from, so it moves with the socket's terminal frame.
    let host = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningA]
    }) as SessionSnapshot;
    const live = await liveStream('s1', () => host);

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        // The document every canonical read is composed from.
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: host });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            tasks += 1;
            return tasks === 1
                ? json(
                      {
                          session: snapshot({
                              harnessDefinition: descriptor(),
                              status: 'running',
                              updatedAt: T + 10,
                              turns: [runningA]
                          } as SessionSnapshot),
                          turn: runningA
                      },
                      202
                  )
                : answer;
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const form = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // A starts processing.
    input.value = 'first task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    await subscribed(live, 'session', 's1');
    live.push([{ type: 'turn', turn: runningA }]);
    await flush();
    expect(tileStates()).toEqual(['streaming']);

    // B is submitted while A runs; its 202 answer is still on the wire.
    input.value = 'second task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(tasks).toBe(2);

    // The observer describes B first. It must CLAIM the optimistic row, not add
    // a second one for the same prompt.
    live.push([{ type: 'turn', turn: queuedB }]);
    await flush();

    expect(tileStates()).toEqual(['streaming', 'queued']);
    expect(document.querySelectorAll('.tile')).toHaveLength(2);
    expect(document.querySelectorAll('.turn-row')).toHaveLength(2);
    expect([...document.querySelectorAll('.tile-prompt')].map((node) => node.textContent)).toEqual([
        'first task',
        'second task'
    ]);
    // B is neutral: no clock runs until the server actually starts it.
    expect(
        document.querySelectorAll<HTMLElement>('.tile')[1]?.querySelector<HTMLElement>('.tile-elapsed')?.hidden
    ).toBe(true);

    // A settles and B starts, all before the 202 answer resolves. Each frame is its own update and
    // the test regains control between them, so the ORDER the shell applies them in is the order the
    // server sent them in (a single flush after three pushes cannot pin that).
    host = fresh;
    live.push([{ type: 'turn', turn: doneA }]);
    await flush();
    live.push([{ type: 'turn', turn: runningB }]);
    await flush();
    live.push([{ type: 'snapshot', session: fresh }]);
    await flush();

    expect(tileStates()).toEqual(['done', 'streaming']);

    // Now the stale 202 body lands. It must not duplicate, re-order, or regress.
    sendAnswer({ session: staleBoth, turn: queuedB });
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(2);
    expect(document.querySelectorAll('.turn-row')).toHaveLength(2);
    expect(tileStates()).toEqual(['done', 'streaming']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.turn-row')].map((row) => row.dataset.state)
    ).toEqual(['done', 'streaming']);
    expect([...document.querySelectorAll('.tile-prompt')].map((node) => node.textContent)).toEqual([
        'first task',
        'second task'
    ]);
    // A keeps its recorded duration; B still owns the live clock.
    expect(tileElapsed()[0]).toBe('100ms');
    expect(
        document.querySelectorAll<HTMLElement>('.tile')[1]?.querySelector<HTMLElement>('.tile-elapsed')?.hidden
    ).toBe(false);
    expect(document.querySelectorAll('.tile')[1]?.classList.contains('is-expanded')).toBe(true);
});

it('hydrates a queued session on reload and stops the whole queue explicitly', async () => {

    let cancelBody: unknown;
    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;
    const queued = snapshot({
        id: 's1',
        status: 'running',
        harnessDefinition: descriptor(),
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    const stopped = snapshot({
        id: 's1',
        harnessDefinition: descriptor(),
        turns: [
            { ...runningA, status: 'cancelled', updatedAt: T + 100 },
            { ...queuedB, status: 'cancelled', updatedAt: T + 100 }
        ] as SessionTurn[]
    });

    localStorage.setItem(SESSION_KEY, 's1');

    let observer: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(next) {
            observer = next;
            next.enqueue(dataOf([{ type: 'snapshot', session: queued }]));
        }
    });

    let snapshotGets = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ sessions: [queued] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && init?.method === undefined) {
                snapshotGets += 1;
                // Boot/open reads the live queue; the post-cancel resync reads the
                // server's terminal records.
                return json({ session: snapshotGets === 1 ? queued : stopped });
            }
            if (url === '/api/sessions/s1/events') return new Response(body, { status: 200 });
            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                cancelBody = init.body === undefined ? undefined : JSON.parse(String(init.body));
                return json({ cancelled: true });
            }
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [queued] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    // Reload shows the server-owned queue: active A, neutral B behind it. Empty
    // field + pending work means the ONE composer action is stop (R10).
    expect(tileStates()).toEqual(['streaming', 'queued']);
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    expect(composerAction.disabled).toBe(false);
    expect(document.querySelector('.composer .reset')).toBeNull();

    composerAction.click();
    await flush();
    await flush();

    // Stop is explicit and total: active + retained queue.
    expect(cancelBody).toEqual({ all: true });
    expect(tileStates()).toEqual(['cancelled', 'cancelled']);
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');

    observer?.close();
});

it('polls a session that is still running after reload until it is terminal', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 500,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'text', agent: 'instruct', delta: 'half' }
        ]
    };

    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    const finishedTurn: SessionTurn = {
        ...runningTurn,
        status: 'done',
        updatedAt: T + 2500,
        events: [...runningTurn.events, { type: 'text', agent: 'instruct', delta: ' and done' }]
    };
    const finished = snapshot({ id: 'r1', turns: [finishedTurn] });

    localStorage.setItem(SESSION_KEY, 'r1');

    let messageRequests = 0;

    // R5/T50: the reload's live plane is the canonical socket; with no socket in this fixture the
    // shell is offline and the bounded metadata refresh (main.ts:8502-8520) is what carries the
    // still-running conversation. The refresh is counted on the OUTER recorder (`metaReadsFor`, one
    // canonical `GET /v1/harness/sessions/r1` per refresh), and the record the server holds moves
    // with THAT count — counting the raw `/api/sessions/r1` route would count the double's
    // composition probes instead (one raw re-read per canonical answer it composes).
    // R5/T50: as above — the socket is the primary plane, and the bounded re-read is the OFFLINE
    // fallback. The connection is installed and then explicitly dropped so the refresh that settles
    // this conversation is the fallback the test is named for, counted on the outer recorder
    // (`metaReadsFor`), with the record the server holds moving by THAT count.
    // T50: the host has no socket plane at all (see the header of `clears polling and elapsed
    // timers on pagehide` for why this is the honest shape of the case). stream.ts resolves the
    // transport when the client is CREATED (stream.ts:193-199), so removing the constructor leaves
    // `harnessStream()` with nothing to dial: ./view-shell.ts:485-490 settles the observation at
    // once and `startWatching` hands the conversation to `pollSession` (main.ts:8917-8930), which
    // is the bounded refresh this test counts on the OUTER recorder (`metaReadsFor`).
    vi.stubGlobal('WebSocket', undefined);

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/sessions/r1') {
            if (method !== undefined) throw new Error('the refresh must be a GET');
            // 1 = the reload's own open, 2 = still running, 3+ = the terminal record.
            const refresh = metaReadsFor('r1').length;
            return json({ session: refresh < 3 ? running : finished });
        }

        if (url.endsWith('/messages')) {
            messageRequests += 1;
            return json({ error: { message: 'Unknown API route.' } }, 404);
        }

        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    // The reload rendered the running turn off ONE canonical metadata read, and the app header
    // stayed app-scoped instead of becoming a run-status display.
    expect(metaReadsFor('r1')).toHaveLength(1);
    expect(tileStates()).toEqual(['streaming']);
    expect(document.querySelector('.agent-text')?.textContent).toBe('half\n');
    expect(statusText()).toBe('idle');

    // No socket: the fallback re-reads the resource while the turn is still running, and the
    // row is re-rendered from the same single turn (no duplicate, no invented finish). The wait is
    // bounded so a shell that never refreshes fails with the count, not a hang. Each bump is the
    // fixture's statement that the SERVER's record moved on since the last read — the shared
    // composition memo otherwise answers the poll with the document the reload already read
    // (./view-test-support.ts `bumpFixtureEpoch`).
    let waited = 0;
    while (metaReadsFor('r1').length < 2 && waited < 6) {
        bumpFixtureEpoch();
        await vi.advanceTimersByTimeAsync(1_000);
        waited += 1;
    }
    expect(metaReadsFor('r1').length).toBeGreaterThan(1);
    expect(tileStates()).toEqual(['streaming']);
    expect(statusText()).toBe('idle');

    // A later refresh reports the terminal record: the server's turn list replaces the projection
    // and the recorded stamps (not the local clock) decide the duration.
    waited = 0;
    while (tileStates()[0] !== 'done' && waited < 6) {
        bumpFixtureEpoch();
        await vi.advanceTimersByTimeAsync(1_000);
        waited += 1;
    }
    await vi.advanceTimersByTimeAsync(0);

    const settledReads = metaReadsFor('r1').length;
    expect(settledReads).toBeGreaterThan(1);
    expect(tileStates()).toEqual(['done']);
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>half and done</p>\n');
    expect(tileElapsed()).toEqual(['2.5s']);
    // The transition out of pending is reported by the tile, not the app header.
    expect(statusText()).toBe('idle');
    dashboard();
    expect(byClass('.session-pill-select', 'button').dataset.status).toBe('idle');

    // The fallback is GET-only: it never starts a model run.
    expect(messageRequests).toBe(0);

    // No further refresh once the answer is terminal: the poll stops by itself.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(metaReadsFor('r1')).toHaveLength(settledReads);
});

// ---------------------------------------------------------------------------
// Startup without a reachable API (R1)
// ---------------------------------------------------------------------------
//
// The first paint must be a visible status, and a failed bootstrap must become
// the offline pane with a Retry action. This is the exact user-visible contract
// that the dev proxy regression broke: the module graph failed before `boot()`
// ran, leaving `#app` empty.

const emptyTitle = (): string | null | undefined =>
    document.querySelector('.empty-title')?.textContent;
const emptyText = (): string | null | undefined => document.querySelector('.empty-text')?.textContent;

const OFFLINE_HINT =
    'Start the API with `yarn start-service` (repo root, /v1/harness on :5000), then reload. `yarn dev:frontend` is the Vite UI only; it does not start an API.';

const expectOfflinePane = (message: string): void => {
    expect(emptyTitle()).toBe('Harness server unavailable');
    expect(emptyText()).toBe(message);
    expect(document.querySelector('.empty-hint')?.textContent).toBe(OFFLINE_HINT);

    // Retry is the only offered action; a reload re-resolves the API root and
    // re-reads the bootstrap document.
    const retry = [...document.querySelectorAll<HTMLButtonElement>('.stage .composer-actions button')];
    expect(retry).toHaveLength(1);
    expect(retry[0].textContent).toBe('Retry');
    expect(retry[0].type).toBe('button');

    // The status pill names the same failure and the app-level state is red. R3: the
    // visible word is the concise state; the full message is the tooltip and the
    // live region's hidden detail.
    expect(statusText()).toBe('error');
    expect(statusTitle()).toBe('server offline');
    expect(document.querySelector('.status-detail')?.textContent).toBe('server offline');
    expect(document.querySelector<HTMLElement>('.status')?.dataset.state).toBe('error');

    // No catalogue, no rows and no tools view while offline (R3).
    expect(document.querySelectorAll('.harness-item')).toHaveLength(0);
    expect(document.querySelector('.harness-list .field-hint')?.textContent).toBe('No server connection.');
    expect(byClass('.tools-toggle', 'button').disabled).toBe(true);
};

it('renders the connecting pane before the first request settles', async () => {
    // A fetch that never settles models a server that accepts the TCP connection
    // but never answers: the centre must not be blank while boot waits.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    await import('./main');

    expect(emptyTitle()).toBe('Connecting to the harness server…');
    // T40: the pane names the route boot actually dials — the canonical service root
    // (`main.ts:9526` renders `API_ROOT`, which is `/v1/harness`), not the old `/api` mount.
    expect(emptyText()).toBe('Contacting /v1/harness…');
    expect(document.querySelector('.stage .empty')).not.toBeNull();
    expect(statusText()).toBe('connecting');
    // A bare state carries no tooltip and no accessible detail (nothing to add to the
    // visible word).
    expect(statusTitle()).toBeNull();
    expect(document.querySelector('.status-detail')?.textContent).toBe('');
    expect(document.querySelector<HTMLElement>('.status')?.dataset.state).toBe('connecting');
    expect(document.querySelectorAll('.harness-item')).toHaveLength(0);
});

it('shows the offline pane when fetch rejects (network refused)', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        })
    );

    await import('./main');
    await flush();

    expectOfflinePane('The harness server is unreachable: Failed to fetch');
});

it('shows the offline pane when the proxy answers 502 with an empty body', async () => {
    // This is the exact shape Vite's /api proxy produced with its target down:
    // non-OK and not JSON, so readError must fall back to the status line.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' }))
    );

    await import('./main');
    await flush();

    expectOfflinePane('HTTP 502 Bad Gateway');
});

it('shows the offline pane when a proxy answers 200 with HTML instead of JSON', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response('<!doctype html><title>Harness UI</title>', {
                    status: 200,
                    headers: { 'Content-Type': 'text/html' }
                })
        )
    );

    await import('./main');
    await flush();

    // T40: boot's FIRST canonical read is the service root itself (`GET {root}` -> ServiceInfo),
    // and it is the read that reports the abstraction's actionable non-JSON message. The old
    // expectation named `/harnesses`, which was only reached because the legacy boot body was
    // one document; the canonical surface dials the root first, so that is the failure named.
    expectOfflinePane('The harness server returned a non-JSON response for / (HTTP 200).');
});

// ---------------------------------------------------------------------------
// R8: permanent session deletion (T1/R1: one click, no confirmation step)
// ---------------------------------------------------------------------------
//
// T3/R1 renamed the entry but kept the structure: a `.session-pill` SPAN wrapper with the
// open button and a SIBLING `.session-pill-delete` control (buttons cannot nest, and the
// wrapper is deliberately not one). T1/R1 removed the inline `.session-confirm` step: one
// click sends exactly one DELETE /sessions/:id and then removes the pill. No
// replacement session is created for the current conversation, and a late observer
// frame must not resurrect a deleted one. The permanence warning lives on the control
// (`title`/`aria-label`), and the guards (`deletionBlocked`, `removingSessions`) are
// what keep the click safe — not the extra click.

it('deletes an inactive session on the first click, with no confirmation panel', async () => {
    const doneTurn: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'hello',
        status: 'done',
        startedAt: T,
        updatedAt: T + 10,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const current = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn] });
    const other = snapshot({
        id: 's2',
        harnessDefinition: descriptor(),
        // Older than `current` (whose stamps are the fixture defaults): T21 R21 opens
        // the newest conversation on a first load, and this test's whole point is the
        // pill of the conversation that is NOT on screen.
        createdAt: 0,
        updatedAt: 1
    });

    localStorage.setItem(SESSION_KEY, 's1');

    // T50: the fake server holds a DIRECTORY it is allowed to FORGET. Without a raw directory
    // record, every refresh after the delete re-lists the conversation the server just removed, so
    // the pill count below would measure the fixture's lie rather than the shell's behaviour.
    const directory = [current, other];

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: directory }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: current });
        if (url === '/api/sessions/s2' && method === 'DELETE') {
            const index = directory.findIndex((entry) => entry.id === 's2');
            if (index >= 0) directory.splice(index, 1);
            return json({ deleted: true });
        }
        if (url === '/api/sessions' && method === undefined) return json({ sessions: directory });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // Both pills of the selected harness are present; only s1 is active.
    expect(rowIds()).toEqual(['s1', 's2']);
    dashboard();
    const wrappers = [...document.querySelectorAll<HTMLElement>('.session-pill')];
    // The wrapper is a `<span role="listitem">`, never a button, and it owns exactly the
    // two controls (no third row for a confirmation surface).
    expect(wrappers.map((node) => `${node.tagName.toLowerCase()}:${node.getAttribute('role')}`)).toEqual([
        'span:listitem',
        'span:listitem'
    ]);
    expect(wrappers.map((node) => [...node.children].map((child) => child.className))).toEqual([
        ['session-pill-select', 'session-pill-delete'],
        ['session-pill-select', 'session-pill-delete']
    ]);
    expect(wrappers.map((node) => node.dataset.status)).toEqual(['idle', 'idle']);
    expect(wrappers.map((node) => node.dataset.active)).toEqual(['true', undefined]);
    expect(wrappers.map((node) => node.dataset.archived)).toEqual(['false', 'false']);
    // The list wrapper announces a list only while it holds items.
    dashboard();
    expect(document.querySelector('.session-pills')?.getAttribute('role')).toBe('list');

    dashboard();
    const del = byClass('.session-pill[data-session-id="s2"] .session-pill-delete', 'button');
    expect(del.textContent).toBe('×');
    expect(del.getAttribute('aria-label')).toBe('Delete session s2');
    // T1/R1: the sentence the confirmation panel used to print is the control's own
    // tooltip, so the warning survives the removed step.
    expect(del.title).toBe('Delete this session permanently. Running or queued work in it stops.');
    expect(del.disabled).toBe(false);

    // T1/R1: ONE click is the whole action. The strip never renders a `.session-confirm`
    // group, so the pill keeps exactly two children: open + delete.
    del.click();
    await flush();

    expect(document.querySelector('.session-confirm')).toBeNull();

    await flush();

    dashboard();
    const rows = [...document.querySelectorAll<HTMLElement>('.session-pill')];
    expect(rows.map((node) => [...node.children].map((child) => child.className))).toEqual([
        ['session-pill-select', 'session-pill-delete']
    ]);

    // ...and exactly one DELETE goes out for that one click.
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s2', method: 'DELETE', body: undefined }
    ]);
    expect(rowIds()).toEqual(['s1']);
    expect(sessionIds()).toEqual(['s1']);
    dashboard();
    expect(byClass('.session-pill[data-session-id="s1"]', 'span').dataset.active).toBe('true');
    // The current conversation is untouched: its tile, pointer, frozen team and
    // status note all stay exactly as they were.
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(document.querySelector('.session-note')?.hasAttribute('hidden')).toBe(true);
    // T3/R1: deleting another conversation leaves the CURRENT saved session with no
    // header note at all (the frozen-team wording is gone), and its pill stays marked.
    expect(document.querySelector('.harness-note')?.textContent).toBe('');
    expect(document.querySelector<HTMLElement>('.harness-note')?.hidden).toBe(true);
    openAgents();
    // T7b (R5/R6): deleting ANOTHER conversation changes nothing about this one — and this one's
    // own configuration is editable, because a saved conversation owns its team and prompts. The
    // delete drafted nothing, so the save action is still asleep.
    expect(instructionBox().disabled).toBe(false);
    expect(applyAction().disabled).toBe(true);
    // No session was created: a delete is not a submit.
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toEqual([]);
    expect(statusText()).toBe('idle');
    expect(statusTitle()).toBe('session s2 deleted');
    expect(document.querySelector('.status-detail')?.textContent).toBe('session s2 deleted');
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
});

it('deletes the running current session, stops watching and creates no replacement', async () => {
    const runningTurn: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'long one',
        status: 'running',
        startedAt: T,
        updatedAt: T,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const running = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningTurn]
    });

    localStorage.setItem(SESSION_KEY, 's1');

    const calls: Call[] = [];

    // T42/T50: the conversation is watched over the canonical `harness.v1` socket. The fixture used
    // to hand-roll an SSE body split in two halves and watch `init.signal` abort; the client has no
    // SSE route to abort any more (./stream.ts:40-43), so the two facts this test needs are now the
    // shell's own socket behaviour: an UNSUBSCRIBE frame when the conversation is deleted, and a
    // LATE frame pushed after the delete that must be dropped by the session-id guards.
    const live = await liveStream('s1', () => running);

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push({
                url,
                method: init?.method,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            if (url === '/api') return json(bootstrap({ sessions: [running] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && init?.method === undefined) {
                return json({ session: running });
            }
            if (url === '/api/sessions/s1' && init?.method === 'DELETE') {
                return json({ deleted: true });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    // A running session is being observed: its tile is on screen (a running server
    // turn renders as `streaming`) and the composer's stop action is live.
    expect(tileStates()).toEqual(['streaming']);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
    expect(byClass('.composer-action', 'button').disabled).toBe(false);
    dashboard();
    expect(document.querySelector('.session-pill[data-session-id="s1"]')?.getAttribute('data-status')).toBe(
        'running'
    );

    // T1/R1: deleting the CURRENT session is allowed while it runs — the control's own
    // title says the running/queued work stops, and one click sends the DELETE.
    dashboard();
    byClass('.session-pill[data-session-id="s1"] .session-pill-delete', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1', method: 'DELETE', body: undefined }
    ]);
    // Watching stops on the plane that carries the watching. The client's `unsubscribe` frame names
    // a SUBSCRIPTION (`{type:'unsubscribe', subscription_id}`, ./stream.ts:455 and :570), so the
    // fact is the pairing: every subscription registered for this conversation is closed — the
    // shell's observer AND the shared record-update channel of T6's live panels
    // (./extensions/records-wake.ts), which the panel's dispose releases through the context's
    // signal. A delete that orphaned either one would keep a dead conversation's slot on the
    // plane. This is the socket equivalent of the SSE `abort` this test used to observe, and a
    // delete is still never a cancel round trip.
    const watched = live.subscriptions.filter(
        (sub) => sub.scope === 'session' && sub.session_id === 's1'
    );
    expect(watched.map((sub) => sub.scope).sort()).toEqual(['session', 'session']);
    const watchedIds = watched.map((sub) => sub.subscription_id);
    expect(
        live.sent
            .filter((frame) => frame.type === 'unsubscribe' && watchedIds.includes(frame.subscription_id))
            .map((frame) => frame.subscription_id)
            .sort()
    ).toEqual([...watchedIds].sort());
    expect(calls.filter((call) => call.url.endsWith('/cancel'))).toEqual([]);

    // The row, the transcript, the pointer and every view field are gone; no
    // replacement session was created and the frozen team is editable again.
    expect(rowIds()).toEqual([]);
    dashboard();
    expect(document.querySelector('.session-pills-empty')?.textContent).toBe('No sessions yet.');
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelector('.agent-text')).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    openAgents();
    // The deleted conversation took its lock with it: the harness is editable again.
    expect(instructionBox().disabled).toBe(false);
    // R3: the roster lists only this harness's own team, and the configured agent is
    // the primary, so its team control is locked WITH the reason on the control (a
    // harness always has one) — there is no paragraph to say it.
    expect(memberToggle().disabled).toBe(true);
    expect(memberToggle().title).toBe('The primary agent is always part of the team.');
    expect(document.querySelector('.agent-dialog-field-note')).toBeNull();

    // The agent outside the team is reachable through `[+]` now, and its add is a live
    // draft the reader can still cancel.
    expect(byClass('.agent-dialog-add', 'button').disabled).toBe(false);
    addAgent('summarizer');
    expect(agentEntries()).toEqual(['instruct', 'summarizer']);
    expect(configuredAgent()).toBe('summarizer');
    expect(memberToggle().disabled).toBe(false);
    expect(memberToggle().title).toBe('Cancel the add, so Summarizer never joins this team.');
    expect(applyAction().disabled).toBe(false);
    // The deleted conversation took its pending work with it: empty field + idle
    // means no action, and there is no Reset control to fall back on (R10).
    expect(byClass('.composer-action', 'button').hidden).toBe(true);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('none');
    expect(document.querySelector('.reset')).toBeNull();
    expect(byClass('.new-session', 'button').disabled).toBe(false);
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toEqual([]);
    expect(statusText()).toBe('idle');
    expect(statusTitle()).toBe('session s1 deleted');
    expect(document.querySelector('.status-detail')?.textContent).toBe('session s1 deleted');
    expect(byClass('.status', 'span').dataset.state).toBe('idle');

    // A frame that arrives AFTER the delete is dropped by the session-id guards: nothing repaints
    // and the pointer is not restored. On the socket this is the same late terminal record the
    // split SSE body used to hold back.
    live.push([{ type: 'snapshot', session: running }]);
    await flush();
    await flush();

    expect(rowIds()).toEqual([]);
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
});

it('keeps the row and reports the error when a delete is rejected', async () => {
    const current = snapshot({ harnessDefinition: descriptor() });
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });
        if (url === '/api/sessions/s1' && method === 'DELETE') {
            return json({ error: { message: 'The database is read-only.' } }, 500);
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // T1/R1: one click is one attempt.
    dashboard();
    byClass('.session-pill-delete', 'button').click();
    await flush();
    await flush();

    // One attempt, row still there, no confirmation surface, error reported through
    // the app-scoped pill (the same place a failed session-list read reports).
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1', method: 'DELETE', body: undefined }
    ]);
    expect(rowIds()).toEqual(['s1']);
    expect(sessionIds()).toEqual(['s1']);
    expect(document.querySelector('.session-confirm')).toBeNull();
    expect(byClass('.status', 'span').dataset.state).toBe('error');
    expect(statusText()).toBe('error');
    expect(statusTitle()).toBe('delete session: The database is read-only.');
    expect(document.querySelector('.status-detail')?.textContent).toBe(
        'delete session: The database is read-only.'
    );
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    // The control is usable again, so a transient failure can be retried.
    dashboard();
    expect(byClass('.session-pill-delete', 'button').disabled).toBe(false);
});

it('drops the row when the server answers 404 for an already-deleted session', async () => {
    const current = snapshot({ harnessDefinition: descriptor() });
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });
        if (url === '/api/sessions/s1' && method === 'DELETE') {
            return json({ error: { message: 'Unknown session "s1".' } }, 404);
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // T1/R1: one click, one request.
    dashboard();
    byClass('.session-pill-delete', 'button').click();
    await flush();
    await flush();

    // The desired end state already holds: the local record is dropped, without
    // claiming our request deleted it and without an error state.
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(rowIds()).toEqual([]);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
    expect(statusText()).toBe('idle');
    expect(statusTitle()).toBe('session s1 was already gone');
    expect(document.querySelector('.status-detail')?.textContent).toBe('session s1 was already gone');
});

it('sends one DELETE per click and disables the row while the delete is in flight', async () => {
    const current = snapshot({ harnessDefinition: descriptor() });
    localStorage.setItem(SESSION_KEY, 's1');

    let deletes = 0;
    let settleDelete: ((response: Response) => void) | undefined;
    const pendingDelete = new Promise<Response>((resolve) => {
        settleDelete = resolve;
    });

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });
        if (url === '/api/sessions/s1' && method === 'DELETE') {
            deletes += 1;
            return pendingDelete as unknown as Response;
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // T1/R1: the first click starts the DELETE. The repaint replaces the rail, so
    // clicking the HELD (detached) node again proves the `removingSessions` guard —
    // not merely the `disabled` attribute — is what blocks a duplicate request.
    dashboard();
    const control = byClass('.session-pill-delete', 'button');
    control.click();
    await flush();

    expect(document.querySelector('.session-confirm')).toBeNull();
    dashboard();
    expect(byClass('.session-pill-delete', 'button').disabled).toBe(true);

    control.click();
    dashboard();
    byClass('.session-pill-delete', 'button').click();
    await flush();
    await flush();

    expect(deletes).toBe(1);

    settleDelete?.(json({ deleted: true }));
    await flush();
    await flush();

    expect(rowIds()).toEqual([]);
    expect(statusText()).toBe('idle');
    expect(statusTitle()).toBe('session s1 deleted');
    expect(document.querySelector('.status-detail')?.textContent).toBe('session s1 deleted');
});

// R8 regression (reviewer-reproduced race): a directory read that STARTED before a
// delete can resolve after it. The raw list answer still contains the deleted id,
// so assigning it unfiltered rebuilt the row. A tombstoned id must stay gone while
// the survivor in the same answer still renders.
it('never resurrects a deleted session from a stale session-list answer', async () => {
    const deleted = snapshot({
        harnessDefinition: descriptor(),
        turns: [
            {
                id: 't1',
                index: 0,
                prompt: 'delete me',
                status: 'done',
                startedAt: T,
                updatedAt: T + 10,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
            }
        ]
    });
    const survivor = snapshot({
        id: 's2',
        harnessDefinition: descriptor(),
        // Older than `deleted` (whose stamps are the fixture defaults): T21 R21 opens
        // the newest conversation on a first load, and this test follows the
        // conversation named in its pointer, s1.
        createdAt: 0,
        updatedAt: 1
    });

    localStorage.setItem(SESSION_KEY, 's1');

    let listRequests = 0;
    let settleList: ((response: Response) => void) | undefined;
    // The list answer is held until the test releases it, so its content is
    // provably OLDER than the delete that lands while it is in flight.
    const pendingList = new Promise<Response>((resolve) => {
        settleList = resolve;
    });

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [deleted, survivor] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: deleted });
        if (url === '/api/sessions/s1' && method === 'DELETE') return json({ deleted: true });
        // T9: with the manual Refresh control gone, the automatic path that re-reads the
        // directory is a rejected run — that is what puts a `GET /sessions` in flight here.
        if (url === '/api/sessions/s1/tasks' && method === 'POST')
            return json({ error: { message: 'provider is offline' } }, 500);
        if (url === '/api/sessions' && method === undefined) {
            listRequests += 1;
            // T50: the boot read of the directory (`GET /v1/harness/sessions`) is answered
            // normally — the shell opens the remembered conversation off it, so holding it would
            // leave the directory empty and the race un-runnable. Only the LATER re-read, the one
            // the rejected run triggers, is held until the test releases it: that is the answer
            // whose staleness the tombstone has to survive.
            return listRequests === 1
                ? json({ sessions: [deleted, survivor] })
                : (pendingList as unknown as Response);
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(rowIds()).toEqual(['s1', 's2']);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Start the directory read and leave it un-answered. T9: the trigger is the app's OWN
    // automatic re-read (a rejected run calls `refreshSessions()`), because there is no
    // refresh control left to press — the manual `↻` and its class are gone (R4).
    byClass('.composer-input', 'textarea').value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    // One directory read for the boot, one for the rejected run: the second is the stale answer
    // this test races against, and it is the one still on the wire.
    expect(listRequests).toBe(2);
    expect(document.querySelector('.refresh-sessions')).toBeNull();

    // Delete the CURRENT session while that older read is still in flight. T1/R1: the
    // click IS the confirmation.
    dashboard();
    byClass('.session-pill[data-session-id="s1"] .session-pill-delete', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1', method: 'DELETE', body: undefined }
    ]);
    expect(rowIds()).toEqual(['s2']);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);

    // Release the pre-delete list: it still names s1. The tombstone filter must keep
    // the deleted row gone and leave the surviving session visible.
    settleList?.(json({ sessions: [deleted, survivor] }));
    await flush();
    await flush();

    // Exactly one refresh was ever in flight (the boot read plus this held one): releasing a stale
    // answer must not make the shell re-read the directory again.
    expect(listRequests).toBe(2);
    expect(rowIds()).toEqual(['s2']);
    expect(sessionIds()).toEqual(['s2']);
    dashboard();
    expect(document.querySelector('.session-pill[data-session-id="s1"]')).toBeNull();
    dashboard();
    expect(byClass('.session-pill[data-session-id="s2"]', 'span').dataset.status).toBe('idle');
    dashboard();
    expect(byClass('.session-pill[data-session-id="s2"]', 'span').dataset.active).toBeUndefined();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    openAgents();
    expect(instructionBox().disabled).toBe(false);
    // The released read left nothing locked: the create control is the surface T9 keeps in
    // the header, and it is live again once `booted` and no write is in flight.
    expect(byClass('.harness-title-row .new-session', 'button').disabled).toBe(false);
});

// ---------------------------------------------------------------------------
// T6/T9: the composer-height anchor, and the Instruct dialog across the breakpoint.
//
//   - `--composer-height` anchors the floating scratch button (`.scratch-fab`) above the
//     input. A HIDDEN composer (the tools view) is not an unmeasured one: there is no
//     field to clear, so the anchor is 0 rather than the last chat-view height — which
//     left the button floating in the space where the input used to be;
//   - T9 moved the session directory INTO the dialog at every width, so the body is no
//     longer sampled from the breakpoint. The desktop-width test below is what proves the
//     other half of R3 (the media stand-in also shows a resize no longer re-shapes or
//     duplicates the layer, which is what `refreshHarnessDialog` used to exist for).
// ---------------------------------------------------------------------------

it('publishes a 0px composer anchor while the tools view hides the input', async () => {
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    const composer = byClass('.composer', 'form');
    // The chat view: the composer is in the page and this host measures no layout at all,
    // so the property stays UNSET and the stylesheet's `76px` fallback places the button
    // (the other half of the contract, pinned in session-pills.test.ts).
    expect(composer.hidden).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('');

    // The tools view hides the composer, and `hidden` is an ANSWER (there is no field to
    // clear), not a missing measurement.
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(composer.hidden).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('0px');

    // Back to the chat the composer is in the page again — and jsdom still measures no
    // layout, so the `0px` is given BACK rather than left standing: only HIDING may say 0,
    // so the stylesheet's `76px` fallback rules again (a real host publishes the measured
    // height here, from the same pass).
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(composer.hidden).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('');
});

type MediaListener = (event: { matches: boolean }) => void;

// jsdom has no `matchMedia`, so `isPhoneLayout()` is TRUE in every other test in this
// file. This is the desktop starting point, as a MediaQueryList stand-in whose `matches`
// can be flipped — which fires the `change` listeners exactly the way a resize across
// 860px does. The pointer query `main.ts` also reads gets a neutral object, so only the
// width is under test.
const stubPhoneMedia = (matches: boolean): { setMatches(next: boolean): void } => {
    const listeners = new Set<MediaListener>();
    const phone = {
        media: '(max-width: 860px)',
        matches,
        addEventListener: (_type: string, listener: MediaListener): void => {
            listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: MediaListener): void => {
            listeners.delete(listener);
        }
    };
    const inert = {
        media: '(pointer: fine)',
        matches: false,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined
    };

    vi.stubGlobal('matchMedia', vi.fn((query: string) => (query === '(max-width: 860px)' ? phone : inert)));

    return {
        setMatches(next: boolean): void {
            phone.matches = next;
            for (const listener of [...listeners]) listener({ matches: next });
        }
    };
};

it('keeps one session dashboard for the dialog across the phone breakpoint (desktop width)', async () => {
    const media = stubPhoneMedia(false);
    const first = snapshot({ harnessDefinition: descriptor() });
    const second = snapshot({ id: 's2', harnessDefinition: descriptor() });

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R1 (T9): this is the width jsdom cannot reach by default — the query ANSWERS, so
    // `isPhoneLayout()` is false. Nothing about the header changes: it is still the title
    // row (cycler + `+`) and the note, with NO directory strip anywhere.
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(0);
    expect(document.querySelector('.session-pills-bar-head')).toBeNull();
    expect([...byClass('.harness-title-row', 'div').children].map((node) => node.className)).toEqual([
        'main-title',
        'session-cycle',
        'new-session session-new',
        'harness-id'
    ]);

    byClass('.harness-title-button', 'button').click();
    await flush();

    const dialog = byClass('.dialog', 'div');
    const details = byClass('.harness-details', 'div');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // R3 (T9): the Sessions dashboard is part of this layer at EVERY width, painted from
    // the directory the header no longer shows. R3 (this pass): it is the LAST block, under
    // a semantic `<hr>` that closes the harness's own details.
    expect(details.querySelector('.harness-details-section')?.textContent).toBe('Sessions');
    expect([...details.children].map((node) => node.className)).toEqual([
        'harness-details-description',
        // The aggregate totals ride the same projection, between the copy and the template
        // metadata line.
        'harness-details-stats',
        'harness-details-meta',
        'harness-details-note',
        // R3 (this pass): the Sessions dashboard is the LAST block, under a semantic rule.
        'harness-details-divider',
        'harness-details-section',
        'session-pills-bar session-pills-bar-dialog'
    ]);
    expect(details.querySelectorAll('hr.harness-details-divider')).toHaveLength(1);
    // Two conversations, neither with a turn: the thread count is the only derivable
    // figure, and the token/time figures are absent because nothing was reported.
    expect(details.querySelector('.harness-details-stats')?.textContent).toBe('0 threads');

    const bar = byClass('.session-pills-bar-dialog', 'div');
    expect(
        [...bar.querySelectorAll<HTMLElement>('.session-pill')].map((node) => node.dataset.sessionId)
    ).toEqual(['s1', 's2']);
    // R3: the dashboard has no create control; the header's `+` is the only one.
    expect(bar.querySelector('.new-session')).toBeNull();
    expect(document.querySelectorAll('.new-session')).toHaveLength(1);
    expect(bar.querySelector('.refresh-sessions')).toBeNull();
    // Only ONE strip in the page — the dialog's. T9 deleted the header copy rather than
    // hiding it, so there is nothing to keep in sync across a resize.
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);

    // T9: crossing the breakpoint no longer re-shapes this body. The layer, its node, its
    // body and its strip all survive the resize untouched — the rebuild this test used to
    // pin is gone, and with it the flicker it prevented.
    media.setMatches(true);
    await flush();

    expect(byClass('.dialog', 'div')).toBe(dialog);
    expect(byClass('.harness-details', 'div')).toBe(details);
    expect(byClass('.session-pills-bar-dialog', 'div')).toBe(bar);
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);

    media.setMatches(false);
    await flush();

    expect(byClass('.session-pills-bar-dialog', 'div')).toBe(bar);
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);

    // R1/R4 (T9): closing takes the only strip out of the document, so the painter is left
    // with live nodes only, and the directory still repoints correctly the next time the
    // dashboard opens. No refresh control exists to press on the way.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.session-pills-bar-dialog')).toBeNull();
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(0);

    expect(dashPillIds()).toEqual(['s1', 's2']);
    expect(document.querySelector('.refresh-sessions')).toBeNull();
});

// T4 (R3): the tools view used to keep the desktop header pill strip as its session entry
// point. T9 removed that strip, so the TITLE BUTTON has to open the dashboard from the Tools
// head too. This walks the whole gesture at the width jsdom cannot reach by default (the
// media query answers, so `isPhoneLayout()` is false): enter Tools, open the dashboard from
// the catalogue heading, delete one conversation there, then open the other and land back in
// the chat — the normal session-navigation return path.
it('opens the session dashboard from the tools-view title at a desktop width, deletes there and returns to the chat', async () => {
    stubPhoneMedia(false);

    const first = snapshot({
        harnessDefinition: descriptor(),
        turns: [
            {
                id: 't-first',
                index: 0,
                prompt: 'first in',
                status: 'done',
                startedAt: T,
                updatedAt: T + 10,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
            } as SessionTurn
        ]
    });
    const second = snapshot({
        id: 's2',
        harnessDefinition: descriptor(),
        // Older than `first` (whose stamps are the fixture defaults): T21 R21 opens the
        // newest conversation on a first load, and this test drives the dashboard from
        // the conversation its pointer names, s1.
        createdAt: 0,
        updatedAt: 1,
        turns: [
            {
                id: 't-second',
                index: 0,
                prompt: 'second in',
                status: 'done',
                startedAt: T,
                updatedAt: T + 10,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
            } as SessionTurn
        ]
    });
    const tool = {
        name: 'read',
        group: 'Files',
        description: 'Read one or more files.',
        tags: ['files', 'read'],
        visibility: 'searchable',
        parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] }
    };

    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ tools: [tool], sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s2' && method === 'DELETE') return json({ deleted: true });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions/s2') return json({ session: second });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // Chat head first: the trigger advertises the harness details.
    const button = byClass('.harness-title-button', 'button');
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Show harness details');

    // Enter the global tools view (the catalogue LIST — no runner dialog stacked).
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(byClass('.main-title', 'h1').textContent).toBe('Tools');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.title).toBe('Show sessions');

    // R3 (T4): one press from the tools heading is the session dashboard, with the same
    // selection and deletion affordances as in the chat head.
    const bar = dashboard();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Sessions');
    expect([...bar.querySelectorAll<HTMLElement>('.session-pill')].map((node) => node.dataset.sessionId)).toEqual([
        's1',
        's2'
    ]);
    expect(bar.querySelector('.session-pill[data-session-id="s1"]')?.dataset.active).toBe('true');
    expect(bar.querySelectorAll('.session-pill-delete')).toHaveLength(2);
    // R3: no create affordance in the tools-view dashboard either.
    expect(document.querySelector('.session-pills-bar-dialog .new-session')).toBeNull();

    // Deleting here is the same one-click DELETE, and the tools view underneath is not
    // disturbed: no navigation, no chat repaint, the catalogue is still the stage.
    bar.querySelector<HTMLElement>('.session-pill[data-session-id="s2"] .session-pill-delete')?.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s2', method: 'DELETE', body: undefined }
    ]);
    expect(
        [...dashboard().querySelectorAll<HTMLElement>('.session-pill')].map((node) => node.dataset.sessionId)
    ).toEqual(['s1']);
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(true);

    // Normal session navigation returns to the chat: pressing a pill dismisses the layer,
    // opens that conversation AND leaves the tools view (R2 — switching is a view change,
    // never a cancellation), so the head goes back to naming the harness.
    dashboard()
        .querySelector<HTMLElement>('.session-pill[data-session-id="s1"] .session-pill-select')
        ?.click();
    await flush();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(byClass('.main-title', 'h1').textContent).toBe('Instruct');
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(document.querySelector('.tile')?.textContent).toContain('first in');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(button.title).toBe('Show harness details');
});

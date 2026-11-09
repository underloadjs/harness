// R21 shell acceptance: editable harnesses everywhere, no right-rail tool list,
// and the declarative scratch board (plus two secondary hosts).
//
//   - R21.2: the right rail is [scratch board, sessions] and holds NO tool list /
//     core-tools dropdown — those live only on the Tools tab;
//   - R21.3: recorded panels are derived from snapshot turns (reload/poll), live
//     `tool_result.ui` renders immediately, panels are per session (switch / New
//     session isolation), and a manual tool call routes its panels to the OWNER
//     captured before the await — never to whatever harness is selected later.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bumpFixtureEpoch, viewAwareFetch } from './view-test-support';
import type { StreamDouble } from './view-test-support';

// T24: the live case below drives the canonical `harness.v1` WebSocket (./stream.ts), and the
// double is resolved by a DYNAMIC import. `vi.resetModules()` clears the module registry, so a
// statically imported double would configure the PREVIOUS `./stream` instance while `main.ts`
// — imported after the reset — dials a fresh singleton with no factory at all: the frames would
// land nowhere (the discipline composer-agent-control.test.ts:24-39 follows). There is no SSE
// fallback in the client (stream.ts:40-43), so a dead `GET /sessions/:id/events` stub is not a
// substitute — production keeps the canonical route and the fixture follows it.
const installLiveStream = (options: {
    sessionId?: string;
    snapshot?: () => SessionSnapshot | undefined;
}): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

// The singleton is process-wide (./stream.ts:647), so the double is released through the SAME
// module instance the shell used, or it leaks into the next file's boot.
const releaseLiveStream = async (): Promise<void> => {
    const { resetHarnessStream } = await import('./stream');

    resetHarnessStream();
};

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
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
        description: 'Answers directly.',
        instruction: 'Answer the request.',
        guidelines: []
    },
    {
        name: 'summarizer',
        title: 'Summarizer',
        description: 'Compresses notes.',
        instruction: 'Compress notes.',
        guidelines: []
    }
];

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

const turn = (overrides: Partial<SessionTurn>): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'done',
    startedAt: T,
    updatedAt: T + 1000,
    events: [],
    ...overrides
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

type Call = { url: string; method: string | undefined; body: unknown };

const stubFetch = (
    handler: (url: string, method: string | undefined, body: unknown) => Response | Promise<Response> | undefined
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const response = await handler(url, method, body);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);

            return response;
        }, { root: '/api' }))
    );

    return calls;
};

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// T5 R11/R12: the agent configuration lives in the shared dialog, so a dialog read
// opens it from the composer's single agent button (idempotent once open).
const openDeck = (): void => {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
};

// T3: the deck is gone, so the ring a test observes is the composer control's own
// `data-activity` (ui/activity.ts paints it on every `start`/`done` frame). The
// dialog's team rows carry the same state and need no separate read.
const ringActivity = (): string | undefined =>
    document.querySelector<HTMLElement>('.agent-control[data-agent]')?.dataset.activity;

const host = (slot: 'scratch' | 'center' | 'left'): HTMLElement =>
    byClass(`.panel-host[data-slot="${slot}"]`, 'div');

// TOOL-panel cards only. T6 mounted two live panels on this board (`harness.tasks`,
// `harness.records`), and they are `.panel` elements too; their content is pinned by
// ./extensions/records-panels.test.ts, and the assertions below are about what the TOOL
// pipeline painted. `panel-extension` is the discriminator the runtime stamps on an
// extension node and never on a tool card (./extensions/runtime.ts:104).
const toolCards = (slot: 'scratch' | 'center' | 'left'): HTMLElement[] =>
    [...host(slot).querySelectorAll<HTMLElement>('.panel')].filter((panel) => !panel.classList.contains('panel-extension'));

const panelIds = (slot: 'scratch' | 'center' | 'left'): (string | undefined)[] =>
    toolCards(slot).map((panel) => panel.dataset.panelId);

const panelText = (slot: 'scratch' | 'center' | 'left'): (string | null)[] =>
    [...host(slot).querySelectorAll<HTMLElement>('.panel-text')].map((node) => node.textContent);

// The live panels this board carries (T6). Asserted where the board's shape matters, so
// "a live panel appeared on the board" is a pinned fact rather than an accident of the
// selector.
const extensionIds = (slot: 'scratch' | 'center' | 'left'): (string | undefined)[] =>
    [...host(slot).querySelectorAll<HTMLElement>('.panel-extension')].map((node) => node.dataset.panelExtension);

// R3: the tools view is opened from the global topbar toggle (no tab strip).
const openTools = (): void => {
    const found = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (found === null) throw new Error('missing global Tools toggle');
    if (found.getAttribute('aria-pressed') !== 'true') found.click();
};

const ui = (panel: unknown): unknown[] => [panel];

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // T38: release the stream double through the module instance the shell used.
    await releaseLiveStream();
});

it('keeps a legacy editable:false preset fully editable and never says read-only', async () => {
    const demo = descriptor({
        name: 'demo',
        title: 'Demo',
        agents: ['instruct'],
        primary: 'instruct',
        builtin: true,
        // Old-server metadata: R21.1 says ignore it.
        editable: false
    });

    let patched: HarnessDescriptor | undefined;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [demo] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses/demo' && method === 'PATCH') {
            const request = body as { primary: string; subagents: string[] };
            patched = descriptor({
                name: 'demo',
                title: 'Demo',
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents,
                builtin: true,
                editable: false
            });

            return json({ harness: patched });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // No read-only harness language and no lock: the rail speaks template/custom
    // only. (The preset picker's "instructions stay read-only" is unrelated content
    // provenance, not a harness permission, so the check is scoped to harness chrome.)
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    expect(document.querySelector('.harness-meta')?.textContent).toBe('template · 1 agent');
    expect(document.querySelector('.agent-lock')).toBeNull();
    expect(document.querySelector('.harness-meta')?.textContent).not.toContain('editable');

    // T3/R3: the team is genuinely editable — the instruction editor, the model select
    // and the team controls are all live (nothing here is a read-only "not editable"
    // surface, and the entry still never says read-only). The only agent is the primary,
    // so it cannot leave its own team.
    openDeck();
    expect(byClass('.agent-dialog-instruction', 'textarea').disabled).toBe(false);
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);
    expect(byClass('.agent-dialog-remove', 'button').disabled).toBe(true); // the primary

    // Adding a trusted agent: `[+]` lists only the agents without a badge, picking one
    // drafts the membership, and saving from the primary adds without promoting.
    byClass('.agent-dialog-add', 'button').click();
    byClass('.agent-dialog-add-option[data-agent="summarizer"]', 'button').click();
    byClass('.agent-dialog-tab[data-agent="instruct"]', 'button').click();

    byClass('.agent-dialog-apply', 'button').click();
    await flush();
    await flush();

    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        primary: 'instruct',
        subagents: ['summarizer']
    });
    expect(patched).toBeDefined();
    expect(document.querySelector('.harness-meta')?.textContent).toBe('template · 2 agents');
});

it('derives recorded panels per session and keeps the hosts session-scoped', async () => {
    const first = snapshot({
        id: 's1',
        // T21 R21: a first load opens the newest conversation, and this test reads the
        // board of s1 before switching to s2 — so s1 carries the newer stamp.
        createdAt: T,
        updatedAt: T + 5_000,
        turns: [
            turn({
                events: [
                    {
                        type: 'tool_result',
                        agent: 'instruct',
                        name: 'statusTool',
                        content: 'ok',
                        isError: false,
                        ui: ui({
                            id: 'status',
                            slot: 'scratch',
                            title: 'Status',
                            blocks: [{ type: 'text', text: 'ready' }]
                        })
                    }
                ]
            })
        ]
    });

    const second = snapshot({
        id: 's2',
        turns: [
            turn({
                id: 't2',
                events: [
                    {
                        type: 'tool_result',
                        agent: 'instruct',
                        name: 'statusTool',
                        content: 'ok',
                        isError: false,
                        ui: [
                            {
                                id: 's2-note',
                                slot: 'scratch',
                                title: 'Second',
                                blocks: [
                                    {
                                        type: 'keyValue',
                                        items: [
                                            { label: 'open', value: '2' },
                                            { label: 'done', value: '5' }
                                        ]
                                    }
                                ]
                            },
                            {
                                id: 's2-top',
                                slot: 'center',
                                title: 'Above turns',
                                blocks: [{ type: 'text', text: 'live summary' }]
                            },
                            {
                                id: 's2-side',
                                slot: 'left',
                                title: 'Harness side',
                                blocks: [{ type: 'text', text: 'aside' }]
                            }
                        ]
                    }
                ]
            })
        ]
    });

    localStorage.setItem(SESSION_KEY, 's1');

    // `calls` is the request log: the assertions below prove the recorded panel values arrive
    // ONLY through the lazy step-detail route (one request, on the reader's click).
    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: first });
        if (url === '/api/sessions/s2' && method === undefined) return json({ session: second });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R21.2 shell order: scratch board FIRST. T3/R1: it is the rail's ONLY section — the
    // sessions moved into the pill strip under the Instruct title.
    const sections = [...document.querySelectorAll<HTMLElement>('.rail-right > .rail-section')];
    expect(sections.map((section) => section.className)).toEqual(['rail-section scratch-section']);
    expect(document.querySelector('.rail-right .session-pill')).toBeNull();
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();

    // The three hosts are mounted where they were promised.
    expect(document.querySelectorAll('.center > .panel-host[data-slot="center"]')).toHaveLength(1);
    expect(document.querySelectorAll('.rail-left > .panel-host[data-slot="left"]')).toHaveLength(1);
    expect(document.querySelectorAll('.rail-right > .scratch-section > .panel-host[data-slot="scratch"]')).toHaveLength(
        1
    );
    // centre host sits directly above the turn stage; the left host is the rail's LAST
    // child (T4/R4: the endpoint settings left the rail for the status-pill dialog, so
    // the `.endpoint` disclosure that used to follow it is gone).
    const centerHost = host('center');
    expect(centerHost.nextElementSibling).toBe(byClass('.stage', 'div'));
    const leftHost = host('left');
    expect(leftHost.nextElementSibling).toBeNull();
    expect(document.querySelector('.rail-left .endpoint-body')).toBeNull();

    // s1: only the scratch board has content; the other hosts stay hidden.
    expect(panelIds('scratch')).toEqual(['status']);
    expect(panelText('scratch')).toEqual(['ready']);
    expect(host('scratch').hidden).toBe(false);
    expect(host('center').hidden).toBe(true);
    expect(host('left').hidden).toBe(true);
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for instruct.');
    // A settled turn's panel is valid scratch state, but it must not light the
    // agent ring: activity is derived only from a RUNNING turn.
    expect(ringActivity()).toBeUndefined();

    // Opening s2 replaces the board with that conversation's panels (no leakage
    // of s1's panel), and the two secondary hosts light up. T9: the pills live in the
    // dashboard behind the harness title, which the press then dismisses.
    byClass('.harness-title-button', 'button').click();
    byClass('.session-pills-bar-dialog .session-pill-select[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    expect(panelIds('scratch')).toEqual(['s2-note']);
    // T5 R1/R2: the compact surface sends a bounded SUMMARY per panel, so the card carries
    // the server's own preview line (never the recorded blocks) plus the block SHAPES, and
    // says what it left out. `panelText` reads `.panel-text`, i.e. exactly the preview line.
    expect(panelText('scratch')).toEqual(['open 2 · done 5']);
    expect(byClass('.panel[data-panel-id="s2-note"]', 'article').dataset.panelState).toBe('summary');
    expect(host('scratch').querySelector('.panel-note')?.textContent).toContain('compact view');
    expect(host('scratch').querySelector('.panel-expand')).not.toBeNull();
    expect(host('center').hidden).toBe(false);
    expect(panelText('center')).toEqual(['live summary']);
    expect(host('left').hidden).toBe(false);
    expect(panelText('left')).toEqual(['aside']);
    // s1's panel is gone from every host: no cross-session residue.
    expect([...panelText('scratch'), ...panelText('center'), ...panelText('left')]).not.toContain('ready');

    // T5 R2: before expansion the card names the block shapes only — the recorded values are
    // NOT in the browser (that is the payload class the compact wire removes). The detail route
    // is the one place they arrive, and only on the reader's click.
    const summaryKv = byClass('.panel[data-panel-id="s2-note"] .panel-kv', 'dl');
    expect([...summaryKv.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['keyValue']);
    expect([...summaryKv.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['2 items']);

    const details = calls.filter((call) => call.url.includes('/turns/') && call.url.includes('/steps/'));
    expect(details).toHaveLength(0);

    byClass('.panel[data-panel-id="s2-note"] .panel-expand', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url.includes('/turns/') && call.url.includes('/steps/'))).toHaveLength(1);
    expect(byClass('.panel[data-panel-id="s2-note"]', 'article').dataset.panelState).toBe('full');
    const kv = byClass('.panel[data-panel-id="s2-note"] .panel-kv', 'dl');
    expect([...kv.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['open', 'done']);
    expect([...kv.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['2', '5']);

    // New session clears every host; the board explains its empty state. T9: the header `+`
    // is the no-dashboard path.
    byClass('.harness-title-row .new-session', 'button').click();
    await flush();

    expect(panelIds('scratch')).toEqual([]);
    expect(panelIds('center')).toEqual([]);
    expect(panelIds('left')).toEqual([]);
    expect(host('scratch').hidden).toBe(true);
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );

    // Reopening s1 restores exactly its recorded panel.
    byClass('.harness-title-button', 'button').click();
    byClass('.session-pills-bar-dialog .session-pill-select[data-session-id="s1"]', 'button').click();
    await flush();
    await flush();

    expect(panelIds('scratch')).toEqual(['status']);
    expect(panelText('scratch')).toEqual(['ready']);
    expect(host('center').hidden).toBe(true);
    expect(host('left').hidden).toBe(true);

    // R10 removed the composer's Reset control: there is no in-place conversation
    // wipe in the UI any more. The board is cleared by New session (proven above) or
    // by an authoritative snapshot, so a plain selection change keeps it intact and
    // no reset control exists anywhere in the composer.
    expect(document.querySelector('.composer .reset')).toBeNull();
    expect(panelIds('scratch')).toEqual(['status']);
    expect(host('scratch').hidden).toBe(false);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
});

it('renders live tool_result.ui panels and keeps them across the terminal snapshot', async () => {
    const resultEvent = {
        type: 'tool_result' as const,
        agent: 'instruct',
        name: 'statusTool',
        content: 'ok',
        isError: false,
        ui: ui({
            id: 'live',
            slot: 'scratch',
            title: 'Live',
            blocks: [{ type: 'text', text: 'running now' }]
        })
    };

    const recorded = turn({
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }, resultEvent]
    });

    // The double must exist before the shell boots, or the client's subscription has no socket.
    const live = await installLiveStream({ sessionId: 's1', snapshot: () => undefined });

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() });
        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            const opening = { ...recorded, status: 'running' as const, events: [] };

            return json(
                { session: snapshot({ status: 'running', turns: [opening] }), turn: opening },
                202
            );
        }

        // T24: there is no SSE route to stub any more — the live frames arrive over the
        // canonical `harness.v1` socket double installed above, folded by the server's own
        // projector, so the `tool_result` reaches the browser as the same `display.ops` frame
        // a server sends (which is what ../view-state.ts `panelEntriesOf` reads).
        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    live.push([
        { type: 'turn', turn: { ...recorded, status: 'running', events: [] } },
        { type: 'event', turnId: 't1', event: { type: 'start', agent: 'instruct', model: 'm1' } },
        { type: 'event', turnId: 't1', event: resultEvent }
    ]);
    await flush();
    await flush();

    // LIVE: the panel is on the board while the turn runs, and the agent ring is
    // lit because that is a separate, honest signal.
    expect(panelIds('scratch')).toEqual(['live']);
    expect(panelText('scratch')).toEqual(['running now']);
    expect(ringActivity()).toBe('active');

    live.push([{ type: 'snapshot', session: snapshot({ turns: [recorded] }) }]);
    live.close();
    await flush();
    await flush();

    // Terminal snapshot recomputes from the SAME recorded ui: still there, and the
    // completed history does not leave an agent looking busy.
    expect(panelIds('scratch')).toEqual(['live']);
    expect(panelText('scratch')).toEqual(['running now']);
    expect(ringActivity()).toBeUndefined();
    expect(byClass('.tile', 'article').dataset.state).toBe('done');
});

it('derives panels from a polled snapshot without replaying old activity', async () => {
    vi.useFakeTimers();

    const running = snapshot({
        id: 'r1',
        status: 'running',
        turns: [turn({ id: 't1', status: 'running', events: [] })]
    });

    const polledTurn = turn({
        id: 't1',
        status: 'running',
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            {
                type: 'tool_result',
                agent: 'instruct',
                name: 'statusTool',
                content: 'ok',
                isError: false,
                ui: ui({
                    id: 'polled',
                    slot: 'scratch',
                    title: 'Polled',
                    blocks: [{ type: 'text', text: 'from poll' }]
                })
            }
        ]
    });

    const polled = snapshot({ id: 'r1', status: 'running', turns: [polledTurn] });

    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    // The record this fixture's routes serve. A poll is only meaningful when the server has
    // MOVED on, so the test changes this value at the moment it says the run progressed; the
    // `bumpFixtureEpoch` call below is what tells the shared composition memo about it.
    let served = running;
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') {
            gets += 1;
            return json({ session: served });
        }
        return undefined;
    });

    // T50: the degraded host this test is about. `pollSession` is the fallback for a run the
    // socket CANNOT carry (main.ts:8885), and `stream.ts` resolves its transport when the client
    // is CREATED (stream.ts:193-199): with jsdom's `WebSocket` present the client dials a real
    // socket and re-dials with backoff forever, so the observation never settles and polling
    // would mean a second plane running next to a live connection — the pattern the R5
    // performance rule forbids. No constructor at all is the honest statement of "this host has
    // no sockets": ./view-shell.ts:485-490 and :589-604 then settle the observation immediately
    // and the bounded re-read takes over on `POLL_INTERVAL_MS`. `afterEach` un-stubs it.
    vi.stubGlobal('WebSocket', undefined);

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    expect(gets).toBe(1);
    // The board holds NO TOOL CARD yet (`gets` is the first read, and the polled
    // snapshot has not landed), but the host is not hidden: the two live panels of T6
    // are mounted for the conversation on screen, and a host with content is a visible
    // host. The tool-card count — the thing this test is about — is still zero.
    expect(host('scratch').hidden).toBe(false);
    expect(panelIds('scratch')).toEqual([]);
    expect(extensionIds('scratch')).toEqual(['harness.tasks', 'harness.records']);

    // The run progressed SERVER-SIDE: the next read answers the snapshot that carries the tool
    // result. Nothing in this case goes through a write or a pushed frame (that is the point of a
    // poll), so the fixture names the move — otherwise the composition memo answers the poll with
    // the document the open already read and the panel never lands (./view-test-support.ts
    // `bumpFixtureEpoch`).
    served = polled;
    bumpFixtureEpoch();

    // The poll's snapshot carries the tool result; the board follows it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets).toBe(2);
    expect(panelIds('scratch')).toEqual(['polled']);
    expect(panelText('scratch')).toEqual(['from poll']);
    // The turn is still running, so the agent ring is legitimately active — panels
    // are not what lights it (activity comes from the turn's own events).
    expect(ringActivity()).toBe('active');

    // Hiding the page stops polling; the panel (a completed tool's output) is still
    // valid scratch state and is not discarded by the teardown.
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(panelIds('scratch')).toEqual(['polled']);
});

it('keeps a manual playground result out of every conversation board (R7)', async () => {
    const alpha = descriptor({ name: 'alpha', title: 'Alpha', agents: ['instruct'], primary: 'instruct' });
    const beta = descriptor({ name: 'beta', title: 'Beta', agents: ['instruct'], primary: 'instruct' });

    const publish = {
        name: 'publish',
        group: 'Demo',
        description: 'Publishes a panel.',
        tags: ['demo'],
        visibility: 'searchable' as const,
        parameters: { type: 'object', properties: {} }
    };

    let answer: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
        answer = resolve;
    });

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ presets: [alpha, beta], tools: [publish] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/tools/publish' && method === 'POST') return pending;
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openTools();
    await flush();

    // The tools view still lists every tool while the scratch board is visible.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['publish']);
    expect(document.querySelectorAll('.rail-right > .rail-section')[0].className).toBe(
        'rail-section scratch-section'
    );

    // Opening the Tools view shows ONLY the catalogue: nothing is auto-opened, so
    // neither a dialog nor a runner exists until the reader activates an entry.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-args')).toBeNull();
    expect(document.querySelector('.tool-card')).toBeNull();

    // Activating the entry opens the shared modal; the runner is adopted inside
    // `.dialog-body > .tool-runner-slot`, which is where the manual call is made.
    byClass('.tool-tab-button[data-tool="publish"]', 'button').click();
    await flush();

    expect(document.querySelector('.dialog-title')?.textContent).toBe('publish');
    expect(document.querySelectorAll('.dialog-body > .tool-runner-slot')).toHaveLength(1);
    expect(document.querySelectorAll('.tool-runner-slot > .pane > .log-wrap > .log > .tool-card')).toHaveLength(1);

    byClass('.tool-args', 'textarea').value = '{}';
    // Captured BEFORE the harness switch: the runner pane is persistent and keeps its
    // answer even while it is detached from the closed dialog, so this same node is what
    // the late answer writes into (R7/R8: the response box, not the scratch board).
    const responseBox = byClass('.tool-output .card-body', 'pre');
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();

    // The request is in flight; the reader moves to the OTHER harness before the
    // answer lands. A manual call does not lock harness selection, and the harness
    // switch closes the open tool dialog (the runner keeps the in-flight call).
    byClass('.harness-item[data-harness="beta"]', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Beta');
    expect(host('scratch').hidden).toBe(true);
    expect(document.querySelector('.dialog')).toBeNull();

    answer?.(
        json({
            ok: true,
            result: { value: 1 },
            durationMs: 3,
            panels: [
                {
                    id: 'manual',
                    slot: 'scratch',
                    title: 'Manual',
                    blocks: [{ type: 'text', text: 'ok' }]
                }
            ]
        })
    );
    await flush();
    await flush();

    // Nothing was injected into the newly selected harness.
    expect(panelIds('scratch')).toEqual([]);
    expect(host('scratch').hidden).toBe(true);

    // R7: a playground call's panels are NOT injected into any conversation. The answer
    // belongs to the playground's own temporary context, so the board of the harness that
    // made the call stays exactly as empty as the board of the harness the reader moved
    // to — the panels are visible as data in the runner's response box instead.
    byClass('.harness-item[data-harness="alpha"]', 'button').click();
    await flush();

    expect(panelIds('scratch')).toEqual([]);
    expect(panelText('scratch')).toEqual([]);
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );

    // The response box carries the whole answer envelope, panels included, so nothing is
    // lost by not painting them: the reader can read and copy them from the runner.
    const response = responseBox.textContent ?? '';
    expect(response).toContain('"value": 1');
    expect(response).toContain('"panels"');
    expect(response).toContain('"Manual"');

    // Exactly one server call was made: the panel is presentation, not a retry.
    expect(
        calls.filter((call) => call.url === '/api/tools/publish' && call.method === 'POST')
    ).toHaveLength(1);
});

// R21 shell acceptance: editable harnesses everywhere, no right-rail tool list,
// and the declarative scratch board (plus two secondary hosts).
//
// What this file pins, end to end through `main.ts` with a stubbed server:
//   - R21.1: a preset the wire marks `editable:false` still renders an editable
//     agent row, never a read-only badge, and a PATCH is sent when it is edited;
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
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const response = await handler(url, method, body);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);

            return response;
        })
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

const host = (slot: 'scratch' | 'center' | 'left'): HTMLElement =>
    byClass(`.panel-host[data-slot="${slot}"]`, 'div');

const panelIds = (slot: 'scratch' | 'center' | 'left'): (string | undefined)[] =>
    [...host(slot).querySelectorAll<HTMLElement>('.panel')].map((panel) => panel.dataset.panelId);

const panelText = (slot: 'scratch' | 'center' | 'left'): (string | null)[] =>
    [...host(slot).querySelectorAll<HTMLElement>('.panel-text')].map((node) => node.textContent);

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

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    // The team row is genuinely editable: promotion, add, remove and model selects.
    expect(byClass('.agent-main', 'button').disabled).toBe(false);
    expect(byClass('.agent-add', 'button').disabled).toBe(false);
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);

    byClass('.agent-add', 'button').click();
    document
        .querySelector<HTMLButtonElement>('.agent-option[data-agent="summarizer"] .agent-option-add')
        ?.click();
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

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: first });
        if (url === '/api/sessions/s2' && method === undefined) return json({ session: second });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R21.2 shell order: scratch board FIRST, sessions second, no tool list.
    const sections = [...document.querySelectorAll<HTMLElement>('.rail-right > .rail-section')];
    expect(sections.map((section) => section.className)).toEqual([
        'rail-section scratch-section',
        'rail-section sessions'
    ]);
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();

    // The three hosts are mounted where they were promised.
    expect(document.querySelectorAll('.center > .panel-host[data-slot="center"]')).toHaveLength(1);
    expect(document.querySelectorAll('.rail-left > .panel-host[data-slot="left"]')).toHaveLength(1);
    expect(document.querySelectorAll('.rail-right > .scratch-section > .panel-host[data-slot="scratch"]')).toHaveLength(
        1
    );
    // centre host sits directly above the turn stage; left host above the endpoint.
    const centerHost = host('center');
    expect(centerHost.nextElementSibling).toBe(byClass('.stage', 'div'));
    const leftHost = host('left');
    expect(leftHost.nextElementSibling).toBe(byClass('.endpoint', 'details'));

    // s1: only the scratch board has content; the other hosts stay hidden.
    expect(panelIds('scratch')).toEqual(['status']);
    expect(panelText('scratch')).toEqual(['ready']);
    expect(host('scratch').hidden).toBe(false);
    expect(host('center').hidden).toBe(true);
    expect(host('left').hidden).toBe(true);
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for instruct.');
    // A settled turn's panel is valid scratch state, but it must not light the
    // agent ring: activity is derived only from a RUNNING turn.
    expect(document.querySelector('.agent-tile')?.dataset.activity).toBeUndefined();

    // Opening s2 replaces the board with that conversation's panels (no leakage
    // of s1's panel), and the two secondary hosts light up.
    byClass('.session[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    expect(panelIds('scratch')).toEqual(['s2-note']);
    expect(panelText('scratch')).toEqual([]);
    expect(host('center').hidden).toBe(false);
    expect(panelText('center')).toEqual(['live summary']);
    expect(host('left').hidden).toBe(false);
    expect(panelText('left')).toEqual(['aside']);
    // s1's panel is gone from every host: no cross-session residue.
    expect([...panelText('scratch'), ...panelText('center'), ...panelText('left')]).not.toContain('ready');

    const kv = byClass('.panel[data-panel-id="s2-note"] .panel-kv', 'dl');
    expect([...kv.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['open', 'done']);
    expect([...kv.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['2', '5']);

    // New session clears every host; the board explains its empty state.
    byClass('.new-session', 'button').click();
    await flush();

    expect(panelIds('scratch')).toEqual([]);
    expect(panelIds('center')).toEqual([]);
    expect(panelIds('left')).toEqual([]);
    expect(host('scratch').hidden).toBe(true);
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );

    // Reopening s1 restores exactly its recorded panel.
    byClass('.session[data-session-id="s1"]', 'button').click();
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
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        }
    });

    const push = (items: readonly unknown[]): void => {
        const text = items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
        controller?.enqueue(new TextEncoder().encode(text));
    };

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
        if (url === '/api/sessions/s1/events') return new Response(body, { status: 200 });
        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    push([{ type: 'turn', turn: { ...recorded, status: 'running', events: [] } }]);
    push([{ type: 'event', turnId: 't1', event: { type: 'start', agent: 'instruct', model: 'm1' } }]);
    push([{ type: 'event', turnId: 't1', event: resultEvent }]);
    await flush();

    // LIVE: the panel is on the board while the turn runs, and the agent ring is
    // lit because that is a separate, honest signal.
    expect(panelIds('scratch')).toEqual(['live']);
    expect(panelText('scratch')).toEqual(['running now']);
    expect(document.querySelector('.agent-tile')?.dataset.activity).toBe('active');

    push([{ type: 'snapshot', session: snapshot({ turns: [recorded] }) }]);
    controller?.close();
    await flush();
    await flush();

    // Terminal snapshot recomputes from the SAME recorded ui: still there, and the
    // completed history does not leave an agent looking busy.
    expect(panelIds('scratch')).toEqual(['live']);
    expect(panelText('scratch')).toEqual(['running now']);
    expect(document.querySelector('.agent-tile')?.dataset.activity).toBeUndefined();
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
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') {
            gets += 1;
            return json({ session: gets < 2 ? running : polled });
        }
        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    expect(gets).toBe(1);
    expect(host('scratch').hidden).toBe(true);

    // The poll's snapshot carries the tool result; the board follows it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets).toBe(2);
    expect(panelIds('scratch')).toEqual(['polled']);
    expect(panelText('scratch')).toEqual(['from poll']);
    // The turn is still running, so the agent ring is legitimately active — panels
    // are not what lights it (activity comes from the turn's own events).
    expect(document.querySelector('.agent-tile')?.dataset.activity).toBe('active');

    // Hiding the page stops polling; the panel (a completed tool's output) is still
    // valid scratch state and is not discarded by the teardown.
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(panelIds('scratch')).toEqual(['polled']);
});

it('routes a manual tool result to the owner captured before the call', async () => {
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

    byClass('.tool-args', 'textarea').value = '{}';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();

    // The request is in flight; the reader moves to the OTHER harness before the
    // answer lands. A manual call does not lock harness selection.
    byClass('.harness-item[data-harness="beta"]', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Beta');
    expect(host('scratch').hidden).toBe(true);

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

    // The panel belongs to the harness that made the call.
    byClass('.harness-item[data-harness="alpha"]', 'button').click();
    await flush();

    expect(panelIds('scratch')).toEqual(['manual']);
    expect(panelText('scratch')).toEqual(['ok']);
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for alpha.');
    // Exactly one server call was made: the panel is presentation, not a retry.
    expect(
        calls.filter((call) => call.url === '/api/tools/publish' && call.method === 'POST')
    ).toHaveLength(1);
});

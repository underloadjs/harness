// T3/R1 + R2: the session directory as pills under the Instruct header, and the same
// strip inside the Instruct dialog on a phone.
//
// What this file pins (the rail contract these replace lives in main.test.ts /
// harness-delete-main.test.ts, and the CSS half lives in session-control-style.test.ts
// and rail-toggle.test.ts):
//   - placement: the strip is a header child between the title row and the note, and the
//     right rail holds ONLY the scratch board (no session surface at all);
//   - projection: one pill per saved session of the SELECTED harness, visible text is
//     `shortId(session.id)` — the first eight characters — and the full uuid appears only
//     in the tooltip, never in rendered text;
//   - state: the open conversation's pill carries `data-active="true"`;
//   - actions: a pill opens its session, `×` deletes it, `+ New` starts a fresh
//     conversation, `↻` re-reads the directory (the busy/disabled rules the rail buttons
//     carried are unchanged);
//   - empty state: a short hint, not the old "Locked to <harness>" sentence;
//   - R2: on a phone (`isPhoneLayout()` is true wherever `matchMedia` is absent, which is
//     every jsdom run) `openHarnessDetails` puts a Sessions section with the SAME pills,
//     New and Refresh at the top of the dialog body; a pill there opens the conversation
//     and closes the dialog; closing the dialog drops the strip so the single painter
//     never touches a detached node.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';

const SESSION_KEY = 'underload-harness-app:session';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const T = 1_700_000_000_000;

type Call = { url: string; method: string | undefined; body: unknown };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve_) => setTimeout(resolve_, 30));
};

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: [],
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
        instruction: 'Answer directly.',
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

const doneTurn = (prompt: string): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt,
        status: 'done',
        startedAt: T,
        updatedAt: T + 10,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    }) as SessionTurn;

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

// A tiny router for the stubbed server: log every call, answer what the test declares,
// and fail loudly on anything unexpected (the same discipline as main.test.ts).
const stubFetch = (
    handler: (url: string, method: string | undefined, body: unknown) => Response | undefined
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const response = handler(url, method, body);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);

            return response;
        })
    );

    return calls;
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// The header strip and its pills. Addressed by variant so an open dialog (which carries
// its own copy on a phone) is never counted by accident.
const headBar = (): HTMLElement => byClass('.session-pills-bar-head', 'div');
const pills = (root: ParentNode = document): HTMLElement[] => [
    ...root.querySelectorAll<HTMLElement>('.session-pill')
];
const pillIds = (root: ParentNode = document): (string | undefined)[] =>
    pills(root).map((node) => node.dataset.sessionId);

// The R1 contract, read from the DOM the app actually produced.
const structure = (root: ParentNode = document): Record<string, unknown> =>
    pills(root).map((node) => ({
        id: node.dataset.sessionId,
        status: node.dataset.status,
        active: node.dataset.active,
        archived: node.dataset.archived,
        role: node.getAttribute('role'),
        tag: node.tagName.toLowerCase(),
        children: [...node.children].map((child) => child.className),
        text: node.textContent
    }));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('lists every saved session of the selected harness as pills under the Instruct title', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });
    const second = snapshot({
        id: 's2',
        status: 'running',
        harnessDefinition: descriptor(),
        turns: [doneTurn('second in')]
    });

    // The remembered conversation is the one the strip marks active; boot never opens a
    // session on its own.
    localStorage.setItem(SESSION_KEY, 's1');

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions/s2') return json({ session: second });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R1: the right rail is the scratch board ONLY — no session surface anywhere in it.
    const rail = byClass('#rail-right', 'aside');
    expect(rail.querySelector('.session-pill')).toBeNull();
    expect(rail.querySelector('.session-list')).toBeNull();
    expect(rail.querySelector('.session-pills-bar')).toBeNull();
    expect(rail.getAttribute('aria-label')).toBe('Scratch board');

    // R1: the strip sits between the title row and the note, inside the header.
    const head = byClass('.harness-head', 'header');
    expect([...head.children].map((node) => node.className)).toEqual([
        'harness-title-row',
        'session-pills-bar session-pills-bar-head',
        'harness-note'
    ]);

    // Directory order is the server's; the remembered session (s1) is the active one.
    expect(pillIds(headBar())).toEqual(['s1', 's2']);
    expect(headBar().querySelector('.session-pills')?.getAttribute('role')).toBe('list');
    expect(structure(headBar())).toEqual([
        {
            id: 's1',
            status: 'idle',
            active: 'true',
            archived: 'false',
            role: 'listitem',
            tag: 'span',
            children: ['session-pill-select', 'session-pill-delete'],
            text: 's1×'
        },
        {
            id: 's2',
            status: 'running',
            active: undefined,
            archived: 'false',
            role: 'listitem',
            tag: 'span',
            children: ['session-pill-select', 'session-pill-delete'],
            text: 's2×'
        }
    ]);

    // The active pill is the open conversation, and the open conversation is the pointer.
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(headBar().querySelector('.session-pills-empty')).toBeNull();

    // The two actions the rail used to own, with their labels intact.
    expect(headBar().querySelector('.new-session')?.textContent).toBe('+ New');
    expect(headBar().querySelector('.new-session')?.getAttribute('aria-label')).toBe('New session');
    expect(headBar().querySelector('.refresh-sessions')?.textContent).toBe('↻');
    expect(headBar().querySelector('.refresh-sessions')?.getAttribute('aria-label')).toBe(
        'Refresh sessions'
    );
});

it('shows only the first eight characters of a session id, never the full uuid', async () => {
    const longId = '3f2a9c1b-7788-4a91-9d0e-1f2a3b4c5d6e';
    const long = snapshot({ id: longId, harnessDefinition: descriptor(), turns: [doneTurn('long id')] });

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [long] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === `/api/sessions/${longId}`) return json({ session: long });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    const select = byClass('.session-pill-select', 'button');
    // The visible text is the eight-character prefix, exactly.
    expect(select.querySelector('.session-pill-id')?.textContent).toBe('3f2a9c1b');
    expect(select.textContent).toBe('3f2a9c1b');
    // The full id is still reachable on hover (the tooltip) and by an id attribute, but
    // it is not rendered text anywhere on the page.
    expect(select.title).toBe(`instruct · idle · ${longId}`);
    expect(select.getAttribute('aria-label')).toBe('Open session 3f2a9c1b');
    expect(select.dataset.sessionId).toBe(longId);
    expect(document.body.textContent ?? '').not.toContain(longId);
});

it('opens a session from its pill, marking it active, and keeps the harness selected', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });
    const second = snapshot({
        id: 's2',
        harnessDefinition: descriptor(),
        turns: [doneTurn('second in')]
    });

    const calls = stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions/s2') return json({ session: second });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.session-pill-select[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    // The pointer and the projection both moved to s2, through one GET of the record.
    expect(localStorage.getItem(SESSION_KEY)).toBe('s2');
    expect(calls.filter((call) => call.url === '/api/sessions/s2')).toHaveLength(1);
    expect(pillIds(headBar())).toEqual(['s1', 's2']);
    expect(headBar().querySelector('.session-pill[data-session-id="s1"]')?.dataset.active).toBeUndefined();
    expect(headBar().querySelector('.session-pill[data-session-id="s2"]')?.dataset.active).toBe('true');
    expect(document.querySelector('.tile')?.textContent).toContain('second in');
    // Switching sessions is a view change: the harness stays selected, and nothing was
    // written. (`/api/models` is the background model lookup the boot flow always fires;
    // it is a read of the provider list, not a conversation write.)
    expect(byClass('.harness-item[data-harness="instruct"]', 'button').getAttribute('aria-pressed')).toBe(
        'true'
    );
    expect(
        calls.filter(
            (call) =>
                (call.method === 'POST' || call.method === 'DELETE' || call.method === 'PATCH') &&
                call.url !== '/api/models'
        )
    ).toEqual([]);
});

it('deletes a session from its pill with one click', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });
    const second = snapshot({ id: 's2', harnessDefinition: descriptor() });

    // The delete must not disturb the conversation on screen, so one exists.
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions/s2' && method === 'DELETE') return json({ deleted: true });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.session-pill[data-session-id="s2"] .session-pill-delete', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s2', method: 'DELETE', body: undefined }
    ]);
    expect(pillIds(headBar())).toEqual(['s1']);
    // The current conversation is untouched by deleting another one.
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(headBar().querySelector('.session-pill[data-session-id="s1"]')?.dataset.active).toBe('true');
});

it('starts a fresh conversation from the strip and clears the active mark', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(headBar().querySelector('.session-pill-select')?.dataset.active).toBe('true');

    byClass('.new-session', 'button').click();
    await flush();

    // Same contract the rail's New session had: no conversation write is sent, the pointer
    // is forgotten, the transcript is empty and no pill is active. (`/api/models` is the
    // background provider lookup, not a write.)
    expect(
        calls.filter((call) => (call.method === 'POST' || call.method === 'DELETE') && call.url !== '/api/models')
    ).toEqual([]);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(pillIds(headBar())).toEqual(['s1']);
    expect(headBar().querySelector('.session-pill-select')?.dataset.active).toBeUndefined();
});

it('re-reads the directory when Refresh is pressed', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });

    let listed = [first];

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: listed });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(pillIds(headBar())).toEqual(['s1']);

    // The server gained a conversation while the page was open.
    listed = [first, snapshot({ id: 's9', turns: [doneTurn('from another tab')] })];

    const refresh = byClass('.refresh-sessions', 'button');
    refresh.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === undefined)).toHaveLength(1);
    expect(pillIds(headBar())).toEqual(['s1', 's9']);
    // The read finished, so the control is live again.
    expect(refresh.disabled).toBe(false);
});

it('shows a short hint when the selected harness has no conversation', async () => {
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    const bar = headBar();
    expect(pills(bar)).toHaveLength(0);
    expect(bar.querySelector('.session-pills-empty')?.textContent).toBe('No sessions yet.');
    // An empty strip is not announced as a list of nothing.
    expect(bar.querySelector('.session-pills')?.getAttribute('role')).toBe('presentation');
    // The old rail sentence must not come back in any form.
    expect(bar.textContent).not.toContain('Locked to');
});

// --- R2: the phone dialog carries the directory --------------------------
//
// jsdom has no `matchMedia`, so `isPhoneLayout()` is true in every test here: that is the
// phone branch of `openHarnessDetails`, which is exactly what R2 asks for.

const openDetails = (): void => {
    byClass('.harness-title-button', 'button').click();
};

it('puts the same pills, New and Refresh at the top of the Instruct dialog', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });
    const second = snapshot({ id: 's2', harnessDefinition: descriptor() });

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();

    const dialog = byClass('.dialog', 'div');
    // `openDialog` ADOPTS the caller's body node, so `.dialog-body`'s only child is the
    // details container the app built.
    const details = byClass('.harness-details', 'div');
    expect(dialog.contains(details)).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // Two strips exist while the dialog is open: the header one (hidden by CSS on a
    // phone) and the dialog one. Both are the same factory's output.
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(2);
    const bar = byClass('.session-pills-bar-dialog', 'div');
    expect(dialog.contains(bar)).toBe(true);

    // R2: the directory is the FIRST thing in the dialog, under its own caption — above
    // the description/meta the dialog already carried.
    expect([...details.children].map((node) => node.className)).toEqual([
        'harness-details-section',
        'session-pills-bar session-pills-bar-dialog',
        'harness-details-description',
        // The aggregate totals for the SAME two conversations, between the copy and the
        // template metadata line.
        'harness-details-stats',
        'harness-details-meta',
        // The harness is unlocked here (no conversation is open), so the note keeps its
        // "edits apply to new sessions" line and the dialog repeats it.
        'harness-details-note'
    ]);
    expect(details.querySelector('.harness-details-section')?.textContent).toBe('Sessions');
    expect(pillIds(bar)).toEqual(['s1', 's2']);
    expect(bar.querySelector('.session-pills')?.getAttribute('role')).toBe('list');
    expect(bar.querySelector('.new-session')).not.toBeNull();
    expect(bar.querySelector('.refresh-sessions')).not.toBeNull();
    // The existing harness context is still below it, unchanged.
    expect(details.querySelector('.harness-details-description')?.textContent).toBe(
        'A general instruction-following agent.'
    );
});

// --- the dialog's aggregate totals ---------------------------------------
//
// The row is built from `sessionDirectory()`, the exact list the chips above come from,
// so the totals describe the conversations the reader can see. Each fixture value is
// fixed in advance: two sessions of one harness, one of them with a delegated child.
//   threads  — s1 owns `agent:instruct` only (1); s2 owns `agent:instruct` PLUS the host
//              thread `host/worker`, which its second turn also names (so 2, not 3);
//   input    — EVERY turn that reported a tally counts, including the one still running
//              (its spend is real): 40,000 + 9,935 + 2,000 + 500 = 52,435;
//   time     — completed turns only: 62,000 + 30,000 + 5,000 = 97,000ms. s2's RUNNING
//              turn is excluded because its `updatedAt` is a heartbeat, not an end
//              stamp — `1m37s`;
//   cache    — 8,000 + 1,472, because s2's `host/worker` turn reported input but no cache
//              figure and contributes nothing (it does not contribute 0).
const billedTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'bill me',
        status: 'done',
        threadId: 'agent:instruct',
        startedAt: T,
        updatedAt: T + 1_000,
        events: [],
        usage: { input: 1, output: 1, total: 2 },
        ...overrides
    }) as SessionTurn;

it('totals threads, input, time and cache for every session of the harness', async () => {
    const first = snapshot({
        harnessDefinition: descriptor(),
        turns: [
            billedTurn({
                startedAt: T,
                updatedAt: T + 62_000,
                usage: { input: 40_000, output: 120, total: 40_120, cached: 8_000 }
            })
        ]
    });
    const second = snapshot({
        id: 's2',
        harnessDefinition: descriptor(),
        threads: [
            {
                id: 'host/worker',
                agent: 'worker',
                origin: 'host',
                status: 'stopped',
                sequence: 1,
                messages: []
            }
        ],
        turns: [
            billedTurn({
                id: 't2',
                threadId: 'agent:instruct',
                startedAt: T,
                updatedAt: T + 30_000,
                usage: { input: 9_935, output: 40, total: 9_975, cached: 1_472 }
            }),
            billedTurn({
                id: 't3',
                index: 1,
                threadId: 'host/worker',
                startedAt: T,
                updatedAt: T + 5_000,
                usage: { input: 2_000, output: 10, total: 2_010 }
            }),
            billedTurn({
                id: 't4',
                index: 2,
                status: 'running',
                startedAt: T,
                updatedAt: T + 900_000,
                usage: { input: 500, output: 10, total: 510 }
            })
        ]
    });

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions/s2') return json({ session: second });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();

    const stats = byClass('.harness-details', 'div').querySelector('.harness-details-stats');
    expect(stats).not.toBeNull();
    // Exact copy, in this order. The `' | '` between figures is generated by CSS, so it
    // is NOT part of any node's text — each value stays copy-pastable.
    expect([...stats?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.textContent))
        .toEqual(['3 threads', '52,435 input', '1m37s', '9,472 cache']);
    // The labels that are not self-evident say what they measure.
    expect(
        [...stats?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.title)
    ).toEqual([
        'Threads across all sessions of this harness',
        'Prompt tokens across all sessions of this harness',
        'Summed completed run time across all sessions of this harness',
        'Input tokens served from the provider prefix cache'
    ]);
});

it('hides the token and time totals a provider never reported instead of printing zeros', async () => {
    // One session, one completed turn with NO usage block at all: only the thread count
    // and the measured span exist, so exactly those two figures render.
    const bare = snapshot({
        harnessDefinition: descriptor(),
        turns: [{ ...doneTurn('hello'), threadId: 'agent:instruct' } as SessionTurn]
    });

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [bare] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: bare });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();

    const stats = byClass('.harness-details', 'div').querySelector('.harness-details-stats');
    expect([...stats?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.textContent))
        .toEqual(['1 thread', '10ms']);
});

it('keeps an open dialog totals in step with a directory read, on the same node', async () => {
    let listed = [
        snapshot({
            harnessDefinition: descriptor(),
            turns: [{ ...doneTurn('hello'), threadId: 'agent:instruct' } as SessionTurn]
        })
    ];

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: listed }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: listed });
        if (url === '/api/sessions/s1') return json({ session: listed[0] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();

    const before = byClass('.harness-details', 'div').querySelector('.harness-details-stats');
    expect([...before?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.textContent))
        .toEqual(['1 thread', '10ms']);

    // The server gained a conversation WITH a reported tally while the dialog was open.
    listed = [
        listed[0],
        snapshot({
            id: 's2',
            harnessDefinition: descriptor(),
            turns: [
                billedTurn({
                    id: 't2',
                    threadId: 'agent:instruct',
                    startedAt: T,
                    updatedAt: T + 30_000,
                    usage: { input: 1_000, output: 5, total: 1_005, cached: 250 }
                })
            ]
        })
    ];

    // The header strip's refresh is the enabled control (a strip created at open time is
    // not repainted until the next `paintSessionActions`), and either one routes through
    // the same `refreshSessions()` → `renderSessions()` painter.
    byClass('.session-pills-bar-head .refresh-sessions', 'button').click();
    await flush();
    await flush();

    // Same node, same layer: only the figures were replaced, so the open dialog never
    // flickers or loses the reader's place (`refreshHarnessDialog` would).
    expect(byClass('.harness-details', 'div').querySelector('.harness-details-stats')).toBe(before);
    expect([...before?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.textContent))
        .toEqual(['2 threads', '1,000 input', '30.0s', '250 cache']);
});

it('omits the totals row for a harness with no sessions', async () => {
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();

    // A row of zeros would read as a measurement, so the row is not there at all.
    expect(document.querySelector('.harness-details-stats')).toBeNull();
    expect(document.querySelector('.harness-details-meta')).not.toBeNull();
});

it('opens a session from a dialog pill and closes the dialog, and deletes from the dialog pill', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });
    const second = snapshot({ id: 's2', harnessDefinition: descriptor(), turns: [doneTurn('second in')] });
    const third = snapshot({ id: 's3', harnessDefinition: descriptor() });

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second, third] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions/s2') return json({ session: second });
        if (url === '/api/sessions/s3' && method === 'DELETE') return json({ deleted: true });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();

    // Selecting a pill from the dialog opens that conversation AND dismisses the dialog,
    // so the details layer never describes the conversation the reader left.
    byClass('.session-pills-bar-dialog .session-pill-select[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBe('s2');
    expect(document.querySelector('.tile')?.textContent).toContain('second in');
    expect(headBar().querySelector('.session-pill[data-session-id="s2"]')?.dataset.active).toBe('true');

    // R2: the dialog is rebuilt on every open, so the pill strip is rebuilt with it and
    // shows the CURRENT selection. Deleting from a dialog pill is the same one-click path
    // as from the header.
    openDetails();
    await flush();

    const bar = byClass('.session-pills-bar-dialog', 'div');
    expect(bar.querySelector('.session-pill[data-session-id="s2"]')?.dataset.active).toBe('true');
    // T3/R1: the saved session on screen prints no header note, so the dialog repeats
    // none either — the removed frozen-session caption cannot come back through here.
    expect(document.querySelector('.harness-details-note')).toBeNull();

    bar.querySelector<HTMLElement>('.session-pill[data-session-id="s3"] .session-pill-delete')?.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s3', method: 'DELETE', body: undefined }
    ]);
    expect(pillIds(headBar())).toEqual(['s1', 's2']);
    expect(pillIds(bar)).toEqual(['s1', 's2']);
});

it('drops the dialog strip when the dialog closes, so the painter only touches live bars', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });

    let listed = [first, snapshot({ id: 's2', harnessDefinition: descriptor() })];

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: listed }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: listed });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(2);

    // Closing through the dialog's own control removes the adopted body with the layer.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.session-pills-bar-dialog')).toBeNull();
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);

    // The directory then changes (a conversation disappears on the server) and the
    // header strip repaints. Painting only the LIVE bars is what keeps a closed dialog's
    // detached strip from holding a ghost pill — or from throwing.
    listed = [first];
    byClass('.refresh-sessions', 'button').click();
    await flush();
    await flush();

    expect(pillIds(headBar())).toEqual(['s1']);
    expect(document.querySelectorAll('.session-pill')).toHaveLength(1);
});

it('leaves the composer-height fallback alone when the host measures no layout', async () => {
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R3: `syncComposerHeight` publishes `--composer-height` from the composer's measured
    // box, and a host with no layout engine (jsdom: every rect is 0) must leave the
    // property UNSET so the stylesheet's `76px` fallback still positions the button. A
    // measured 0 written through would pin the button to the viewport's bottom edge.
    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('');
    expect(byClass('.scratch-fab', 'button').isConnected).toBe(true);
});

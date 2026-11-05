// T3/R1 + R2/R3 (T9): the session directory as the Sessions dashboard of the dialog the
// harness title opens — at every width — and the compact header controls beside it.
//
// What this file pins (the rail contract these replace lives in main.test.ts /
// harness-delete-main.test.ts, and the CSS half lives in session-control-style.test.ts
// and rail-toggle.test.ts):
//   - placement: the header is the title row plus the note and NOTHING else — the pill
//     strip that used to sit there is gone (T9/R1) — while the right rail holds ONLY the
//     scratch board (no session surface at all);
//   - projection: one pill per saved session of the SELECTED harness, visible text is
//     `shortId(session.id)` — the first eight characters — and the full uuid appears only
//     in the tooltip, never in rendered text;
//   - state: the open conversation's pill carries `data-active="true"`;
//   - actions: a pill opens its session, `×` deletes it, the `+` (in the header row AND in
//     the dashboard) starts a fresh conversation. T9 removed the manual Refresh control;
//     the directory re-read that used to sit behind it is still automatic (see the
//     rejected-submit test below) and the busy/disabled rules the rail buttons carried are
//     unchanged;
//   - empty state: a short hint, not the old "Locked to <harness>" sentence;
//   - R3 (T9): `openHarnessDetails` puts that Sessions section in the dialog at
//     EVERY width (jsdom answers `matchMedia` as phone by default, and the desktop stub
//     below proves the other half); a pill there opens the conversation and closes the
//     dialog; closing the dialog drops the strip so the single painter never touches a
//     detached node;
//   - R3 (this pass): that section is the LAST block of the body, under a semantic
//     `<hr class="harness-details-divider">`, and the dashboard carries NO create control
//     — the header's `+` is the only one in the page.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts session-pills.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withViewRoutes } from './view-test-support';
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
    // T5: the shell speaks the DISPLAY surface by default, so every `/views` route is
    // answered from the raw fixtures this test already declares
    // (./view-test-support.ts `withViewRoutes` rewrites the request and compiles the
    // answer). The recorded `calls` still show the URL the browser actually asked for.
    const answer = withViewRoutes(handler as (url: string, method?: string, body?: unknown) => Response | undefined, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const response = await answer(url, method, body);
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

// T9: the directory exists in ONE place — the Sessions section of the dialog the harness
// title opens — so "reach the pills" means "open the dashboard". A pill press dismisses
// that layer (it must never describe the conversation the reader just left), so this
// helper re-opens it whenever it is gone: `openDialog` adopts the body synchronously and
// `openHarnessDetails` paints the strip before returning, so no extra tick is needed.
const dashboard = (): HTMLElement => {
    if (document.querySelector('.session-pills-bar-dialog') === null) {
        byClass('.harness-title-button', 'button').click();
    }

    return byClass('.session-pills-bar-dialog', 'div');
};

// The header's own create control, addressed inside the title row so the dashboard's
// identical `+` is never counted by accident.
const headerNew = (): HTMLButtonElement => byClass('.harness-title-row .new-session', 'button');
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

// jsdom has no `matchMedia`, which the app reads as "phone-sized" (main.ts
// `isPhoneLayout`). R3 (T9) has to be proved at the OTHER width too, so this stub answers
// the query the way a real desktop browser does. It must be installed BEFORE
// `import('./main')`: main.ts samples `window.matchMedia` once, at module init.
const stubDesktopViewport = (): void => {
    vi.stubGlobal(
        'matchMedia',
        (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false
        })
    );
};

it('lists every saved session of the harness in the dashboard behind the Instruct title', async () => {
    const first = snapshot({
        // T21 R21: a first load opens the NEWEST conversation, and every assertion below
        // treats s1 as the one on screen — so s1 carries the newer stamp instead of
        // tying with s2 on the fixture defaults.
        createdAt: T,
        updatedAt: T + 10_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('hello')]
    });
    const second = snapshot({
        id: 's2',
        status: 'running',
        harnessDefinition: descriptor(),
        turns: [doneTurn('second in')]
    });

    // The remembered conversation is also the newest, so the strip marks it active and
    // the boot selection and the pointer agree (T21 R21).
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

    // R1 (T9): the header is the title row and the note — the pill strip that used to sit
    // between them is gone, and the directory is behind the title button instead.
    const head = byClass('.harness-head', 'header');
    expect([...head.children].map((node) => node.className)).toEqual([
        'harness-title-row',
        'harness-note'
    ]);
    // The row itself carries the two compact session controls: the cycler and its `+`.
    expect([...byClass('.harness-title-row', 'div').children].map((node) => node.className)).toEqual([
        'main-title',
        'session-cycle',
        'new-session session-new',
        'harness-id'
    ]);
    // No header strip survives anywhere, at any width.
    expect(document.querySelector('.session-pills-bar-head')).toBeNull();

    // Directory order is the server's; the remembered session (s1) is the active one.
    const bar = dashboard();
    expect(pillIds(bar)).toEqual(['s1', 's2']);
    expect(bar.querySelector('.session-pills')?.getAttribute('role')).toBe('list');
    expect(structure(bar)).toEqual([
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
    expect(bar.querySelector('.session-pills-empty')).toBeNull();

    // R3 (this pass): the dashboard has NO create control — a conversation is opened and
    // deleted here and created from the header, so the strip is its pill list alone (no
    // button of any kind sits beside it).
    expect(bar.querySelector('.new-session')).toBeNull();
    // The bar element is the list container alone. (The pills themselves are `span`s that
    // hold their own select/delete buttons, so counting buttons here would prove nothing.)
    expect([...bar.children].map((node) => node.className)).toEqual(['session-pills']);
    // …and the header's `+` is the page's ONLY create control now, same name, same class.
    expect(document.querySelectorAll('.new-session')).toHaveLength(1);
    expect(headerNew().textContent).toBe('+');
    expect(headerNew().getAttribute('aria-label')).toBe('New session');
    expect(headerNew().title).toBe('New session');
    expect(headerNew().disabled).toBe(false);
    // The manual refresh control is gone from every surface (R4) — its class may not come
    // back, in the DOM or in the stylesheet.
    expect(document.querySelector('.refresh-sessions')).toBeNull();
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

    // T9: the pill is in the dashboard behind the title.
    dashboard();
    const select = byClass('.session-pills-bar-dialog .session-pill-select', 'button');
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
    const first = snapshot({
        // T21 R21: a first load opens the newest conversation, so this test starts on
        // s1 and its pill press is the ONLY read of s2.
        createdAt: T,
        updatedAt: T + 10_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('hello')]
    });
    // A distinct turn id: the server mints ids per conversation, and reusing `t1` for
    // both rows would let the board legitimately keep the tile that was already on
    // screen across the switch (the same rule session-cycle.test.ts pins for its
    // fixtures) instead of proving s2's transcript replaced s1's.
    const second = snapshot({
        id: 's2',
        harnessDefinition: descriptor(),
        turns: [{ ...doneTurn('second in'), id: 't-s2' } as SessionTurn]
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

    // T9: the pills live behind the title button, so reaching one means opening the
    // dashboard. Pressing it then dismisses that layer (see the dialog test below), which
    // is why the reads after it go through `dashboard()` again.
    dashboard();
    byClass('.session-pills-bar-dialog .session-pill-select[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    // The pointer and the projection both moved to s2, through one GET of the record.
    expect(localStorage.getItem(SESSION_KEY)).toBe('s2');
    // T43: the `/views` mirror is gone (./view-api.ts:7), so the record read IS the canonical
    // identified read `GET /v1/harness/sessions/:id` (../shared/harness-api.ts:69), and it is
    // followed by that conversation's named subresources (`/turns`, `/threads`, `/actions`).
    // The exact-path match is the point: one ROW read per switch, and a subresource read is
    // never a second record read.
    expect(calls.filter((call) => call.url === '/v1/harness/sessions/s2')).toHaveLength(1);
    expect(pillIds(dashboard())).toEqual(['s1', 's2']);
    expect(
        dashboard().querySelector('.session-pill[data-session-id="s1"]')?.dataset.active
    ).toBeUndefined();
    expect(dashboard().querySelector('.session-pill[data-session-id="s2"]')?.dataset.active).toBe(
        'true'
    );
    expect(document.querySelector('.tile')?.textContent).toContain('second in');
    // Switching sessions is a view change: the harness stays selected, and nothing was
    // written. (`/v1/harness/models` is the background model discovery boot always fires;
    // the canonical route is a POST with the endpoint settings, and it is a read of the
    // provider list, not a conversation write.)
    expect(byClass('.harness-item[data-harness="instruct"]', 'button').getAttribute('aria-pressed')).toBe(
        'true'
    );
    expect(
        calls.filter(
            (call) =>
                (call.method === 'POST' || call.method === 'DELETE' || call.method === 'PATCH') &&
                call.url !== '/v1/harness/models'
        )
    ).toEqual([]);
});

it('deletes a session from its pill with one click', async () => {
    const first = snapshot({
        // T21 R21: the newest conversation is the one a first load opens, and this test
        // deletes the OTHER one — so s1 must be the newer row, not a tie with s2.
        createdAt: T,
        updatedAt: T + 10_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('hello')]
    });
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

    // T9: deletion is a dashboard action — the header carries no `×` at any width.
    dashboard();
    byClass(
        '.session-pills-bar-dialog .session-pill[data-session-id="s2"] .session-pill-delete',
        'button'
    ).click();
    await flush();
    await flush();

    // T43: one click, one canonical delete (`DELETE /v1/harness/sessions/:id`,
    // ./api.ts `deleteSession`); the `/views` mirror this used to name no longer exists.
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/v1/harness/sessions/s2', method: 'DELETE', body: undefined }
    ]);
    // A DELETE leaves the layer open (only opening a conversation dismisses it), so this is
    // the same strip the click landed on.
    expect(pillIds(dashboard())).toEqual(['s1']);
    // The current conversation is untouched by deleting another one.
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(dashboard().querySelector('.session-pill[data-session-id="s1"]')?.dataset.active).toBe(
        'true'
    );
});

it('starts a fresh conversation from the header `+`, without opening the dashboard', async () => {
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

    // R2 (T9): the whole create path is one header control — no dialog, no dashboard. The
    // conversation in view is named by the cycler beside it, which is how the test knows
    // s1 was active WITHOUT opening the dashboard.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s1');
    expect(headerNew().disabled).toBe(false);

    headerNew().click();
    await flush();

    // Same contract the rail's New session had: no conversation write is sent, the pointer
    // is forgotten, the transcript is empty and no pill is active. (`/v1/harness/models` is
    // the background provider discovery POST boot always fires, not a conversation write.)
    expect(
        calls.filter((call) => (call.method === 'POST' || call.method === 'DELETE') && call.url !== '/v1/harness/models')
    ).toEqual([]);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(byClass('.session-cycle', 'button').hidden).toBe(true);
    expect(pillIds(dashboard())).toEqual(['s1']);
    expect(dashboard().querySelector('.session-pill-select')?.dataset.active).toBeUndefined();
});

// T9 removed the manual Refresh BUTTON; this pins what replaced it as the contract: the
// directory re-read itself. A rejected submit is one of the automatic paths (`run()`'s
// failure branch calls `refreshSessions()`), so the reader gets the current server list
// without ever being handed a ↻ to press.
it('re-reads the directory automatically when a submit is rejected, with no refresh control', async () => {
    const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });

    let listed = [first];

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: listed });
        if (url === '/api/sessions/s1/tasks' && method === 'POST')
            return json({ error: { message: 'provider is offline' } }, 500);
        return undefined;
    });

    localStorage.setItem(SESSION_KEY, 's1');
    await import('./main');
    await flush();
    await flush();

    expect(pillIds(dashboard())).toEqual(['s1']);


    // T43 R1: boot reads the compact directory page (`GET /v1/harness/sessions?<page>`,
    // ./view-api.ts `listAllSessions` → ./api.ts `listSessions`); count what it did before
    // the submit so the re-read below is attributable to the rejected run alone. The match
    // is the ROUTE, method-less: a create is a POST on the same path, and a page cursor is
    // still the same directory read.
    const directoryReads = (): number =>
        calls.filter(
            (call) =>
                call.method === undefined &&
                (call.url === '/v1/harness/sessions' || call.url.startsWith('/v1/harness/sessions?'))
        ).length;
    const readByBoot = directoryReads();
    // The server gained a conversation while the page was open.
    listed = [first, snapshot({ id: 's9', turns: [doneTurn('from another tab')] })];

    byClass('.composer-input', 'textarea').value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    // T43 R1: boot reads the compact directory page once, so the reads after boot are the
    // baseline. The ONE additional page read here is the automatic re-read the rejected run
    // triggered, and it answers with the same rows the strip projects. Nothing on this path
    // waits for a manual refresh.
    expect(directoryReads()).toBe(readByBoot + 1);
    expect(pillIds(dashboard())).toEqual(['s1', 's9']);
    // Nothing manual is left to press, and the create control is live again once the failed
    // run released its lock.
    expect(document.querySelector('.refresh-sessions')).toBeNull();
    expect(headerNew().disabled).toBe(false);
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

    const bar = dashboard();
    expect(pills(bar)).toHaveLength(0);
    expect(bar.querySelector('.session-pills-empty')?.textContent).toBe('No sessions yet.');
    // An empty strip is not announced as a list of nothing.
    expect(bar.querySelector('.session-pills')?.getAttribute('role')).toBe('presentation');
    // The old rail sentence must not come back in any form.
    expect(bar.textContent).not.toContain('Locked to');
});

// --- R3 (T9): the dialog carries the directory at EVERY width ------------
//
// jsdom has no `matchMedia`, so every test above runs as the PHONE layout. `stubDesktop-
// Viewport` answers the query the way a real desktop browser does, which is how the "same
// dashboard at ≥861px" half of R3 is proved instead of assumed.

const openDetails = (): void => {
    byClass('.harness-title-button', 'button').click();
};

it('puts the pills, the `+` and no refresh control at the top of the Instruct dialog', async () => {
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

    // T9: exactly one strip in the whole page — the dialog's. The header copy this test
    // used to compare against is gone, so nothing needs a variant to be told apart.
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);
    const bar = byClass('.session-pills-bar-dialog', 'div');
    expect(dialog.contains(bar)).toBe(true);

    // R3 (this pass): the directory is the LAST thing in the dialog — the harness's own
    // description, totals and metadata come first, then a real `<hr>` divider, then the
    // Sessions caption and strip under it.
    expect([...details.children].map((node) => node.className)).toEqual([
        'harness-details-description',
        // The aggregate totals for the SAME two conversations, between the copy and the
        // template metadata line.
        'harness-details-stats',
        'harness-details-meta',
        // The harness is unlocked here (no conversation is open), so the note keeps its
        // "edits apply to new sessions" line and the dialog repeats it.
        'harness-details-note',
        'harness-details-divider',
        'harness-details-section',
        'session-pills-bar session-pills-bar-dialog'
    ]);
    // The divider is a semantic rule, not a styled paragraph: an `<hr>` between the two
    // sections, and it is the ONLY one in this body.
    expect(details.querySelector('hr.harness-details-divider')).not.toBeNull();
    expect(details.querySelectorAll('hr')).toHaveLength(1);
    expect(details.querySelector('.harness-details-section')?.textContent).toBe('Sessions');
    // The section is what follows the divider, in that exact order.
    const divider = details.querySelector('.harness-details-divider');
    expect(divider?.nextElementSibling?.className).toBe('harness-details-section');
    expect(divider?.nextElementSibling?.nextElementSibling).toBe(bar);
    expect(pillIds(bar)).toEqual(['s1', 's2']);
    expect(bar.querySelector('.session-pills')?.getAttribute('role')).toBe('list');
    // R3: no create affordance in the dashboard at all.
    expect(bar.querySelector('.new-session')).toBeNull();
    expect(bar.querySelector('.refresh-sessions')).toBeNull();
    // The existing harness context is still above the divider, unchanged.
    expect(details.querySelector('.harness-details-description')?.textContent).toBe(
        'A general instruction-following agent.'
    );
});

// R3 (T9), the width the phone tests above cannot prove: with `matchMedia` answering like
// a desktop browser, the header keeps the SAME two compact controls, no pill strip appears
// under it, and the title button still opens the session dashboard with its pills.
it('keeps the same compact header and the same dashboard at a desktop width', async () => {
    const first = snapshot({
        // T21 R21: the newest row is what a first load opens, and this fixture only
        // answers the read for s1.
        createdAt: T,
        updatedAt: T + 10_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('hello')]
    });
    const second = snapshot({ id: 's2', harnessDefinition: descriptor() });

    localStorage.setItem(SESSION_KEY, 's1');
    stubDesktopViewport();

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: first });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // The header row is byte-for-byte the phone row: title, cycler, `+`, id line — and the
    // cycler is not hidden, because a desktop conversation is open.
    expect([...byClass('.harness-title-row', 'div').children].map((node) => node.className)).toEqual([
        'main-title',
        'session-cycle',
        'new-session session-new',
        'harness-id'
    ]);
    const pill = byClass('.session-cycle', 'button');
    expect(pill.hidden).toBe(false);
    expect(pill.dataset.sessionId).toBe('s1');
    expect(pill.getAttribute('aria-label')).toBe('Current session s1. Switch to the next session.');

    // No directory strip anywhere in the header at this width either (R1).
    expect(document.querySelector('.session-pills-bar-head')).toBeNull();
    expect(byClass('.harness-head', 'header').querySelector('.session-pills')).toBeNull();

    // And the dashboard behind the title behaves exactly like the phone's (R3).
    openDetails();
    await flush();

    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);
    const bar = byClass('.session-pills-bar-dialog', 'div');
    expect(pillIds(bar)).toEqual(['s1', 's2']);
    expect(bar.querySelector('.session-pill[data-session-id="s1"]')?.dataset.active).toBe('true');
    expect(bar.querySelectorAll('.session-pill-delete')).toHaveLength(2);
    // R3: the dashboard offers no create control at this width either.
    expect(bar.querySelector('.new-session')).toBeNull();
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
//   time     — completed turns of the conversation whose ROWS are on screen: 30,000 +
//              5,000 = 35,000ms → `35.0s`. s1 stays a compact row (boot opened the newest
//              conversation, s2), and the server's fold carries tokens only, so s1's 62,000ms
//              is honestly unknown rather than added. s2's RUNNING turn is excluded either
//              way because its `updatedAt` is a heartbeat, not an end stamp;
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
        // T38/T43: s1 stays a compact directory ROW here (boot opened the newest
        // conversation, s2, so only s2's turns are on screen). A row carries no token
        // figure (../shared/harness-api.ts:807-809), so the totals line reads the server's
        // own fold — `GET /v1/harness/sessions/:id/usage` (./view-api.ts `readUsage`),
        // issued once when the details dialog opens and cached. The fold is the payload a
        // shell test has to author (./view-test-support.ts:1826-1848 composes everything
        // except `usage`), and these are exactly s1's turn figures: 40,000 input / 8,000
        // cached. The adapter dials the test's OWN route for it (its offer-first rule hands
        // the raw twin, `${root}/sessions/:id/usage`, to this handler — view-test-support.ts
        // :1000-1007), which is why the path below is the raw spelling while the recorded
        // request log above shows the canonical URL the browser asked for.
        if (url === '/api/sessions/s1/usage')
            return json({
                session_id: 's1',
                turn_count: 1,
                reported_turns: 1,
                usage: { input: 40_000, output: 120, total: 40_120, cached: 8_000 },
                by_thread: [],
                truncated: false,
                revision: 1
            });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();
    // The fold is a read, so the figures it carries land one round-trip after the dialog
    // opened (main.ts `hydrateDialogUsage` → `paintHarnessDialogStats`).
    await flush();

    const stats = byClass('.harness-details', 'div').querySelector('.harness-details-stats');
    expect(stats).not.toBeNull();
    // Exact copy, in this order. The `' | '` between figures is generated by CSS, so it
    // is NOT part of any node's text — each value stays copy-pastable.
    //
    // T43 re-anchors two figures to what the canonical wire states in this MIXED state
    // (s2's rows are on screen, s1 is a compact directory row plus its `/usage` fold):
    //   - `2 threads`: a directory row's counter is the HOST roster only
    //     (src/server/api-reads.ts:211 `thread_count: hostThreads(record).length`, proved by
    //     src/server/api.test.ts:1367 `thread_count === 0` for a default-only conversation),
    //     so s1's default conversation is not countable from its row — the turn ids that made
    //     it countable are exactly what a row omits. s2 stays 2 (`agent:instruct` +
    //     `host/worker`);
    //   - `35.0s`: `SessionUsageResponse` carries TOKENS only
    //     (../shared/harness-api.ts:1364-1371 — no duration field), so the folded
    //     conversation contributes no run time and ./ui/usage-summary.ts leaves
    //     `durationMs` unknown rather than inventing 0.
    // The token figures are the full total across BOTH conversations.
    expect([...stats?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.textContent))
        .toEqual(['2 threads', '52,435 input', '35.0s', '9,472 cache']);
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

it("keeps an open dialog's totals in step with a directory read, on the same node", async () => {
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
        // T9: no session is open here, so the submit's create lands on the SAME s1 the
        // directory already holds, and the rejected task is what fires the automatic
        // directory re-read.
        if (url === '/api/sessions' && method === 'POST') return json({ session: listed[0] });
        if (url === '/api/sessions/s1/tasks' && method === 'POST')
            return json({ error: { message: 'provider is offline' } }, 500);
        if (url === '/api/sessions/s1') return json({ session: listed[0] });
        // T38/T43: after the re-read BOTH conversations are compact rows, so their token
        // figures can only come from the server's fold, once per conversation, and only
        // while the details dialog is open. s1's conversation never reported a tally, so
        // its fold honestly carries NO `usage` field; s2's carries exactly its one billed
        // turn (1,000 input / 250 cached). Raw-twin spelling, offered to this handler by the
        // adapter's offer-first rule (see the totals test above).
        if (url === '/api/sessions/s1/usage')
            return json({ session_id: 's1', turn_count: 1, reported_turns: 0, by_thread: [], truncated: false, revision: 1 });
        if (url === '/api/sessions/s2/usage')
            return json({
                session_id: 's2',
                turn_count: 1,
                reported_turns: 1,
                usage: { input: 1_000, output: 5, total: 1_005, cached: 250 },
                by_thread: [],
                truncated: false,
                revision: 1
            });
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

    // T9: with no Refresh control left, the automatic re-read is what keeps the dialog in
    // step — a rejected run re-asks the server for the directory, and that read routes
    // through the same `refreshSessions()` → `renderSessions()` painter.
    byClass('.composer-input', 'textarea').value = 'bill me';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    // Same node, same layer: only the figures were replaced, so the open dialog never
    // flickers or loses the reader's place (a full body rebuild would).
    //
    // T43: the figures are the ones the canonical wire can state for this state. Both rows
    // are compact after the re-read, so the tokens come from the folds declared above and
    // the time figure is ABSENT — `SessionUsageResponse` publishes tokens only
    // (../shared/harness-api.ts:1364-1371), and ./ui/usage-summary.ts leaves `durationMs`
    // undefined for a summary row instead of inventing 0. Dropping a figure the server
    // never reported is the honest reading; keeping `30.0s` would have been the stale one.
    expect(byClass('.harness-details', 'div').querySelector('.harness-details-stats')).toBe(before);
    expect([...before?.querySelectorAll<HTMLElement>('.harness-details-stat') ?? []].map((node) => node.textContent))
        .toEqual(['0 threads', '1,000 input', '250 cache']);
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
    // T9: the dismiss took the strip with it, so the assertion reopens the dashboard — and
    // proves the rebuilt layer describes the conversation the reader switched TO.
    expect(dashboard().querySelector('.session-pill[data-session-id="s2"]')?.dataset.active).toBe(
        'true'
    );

    // T9: the dashboard the reader is looking at is the one directory surface there is, and
    // it repaints from the live projection on every mutation, so it already shows the
    // CURRENT selection. Deleting from a dialog pill is the same one-click path it ever was.
    const bar = dashboard();
    expect(bar.querySelector('.session-pill[data-session-id="s2"]')?.dataset.active).toBe('true');
    // T3/R1: the saved session on screen prints no header note, so the dialog repeats
    // none either — the removed frozen-session caption cannot come back through here.
    expect(document.querySelector('.harness-details-note')).toBeNull();

    bar.querySelector<HTMLElement>('.session-pill[data-session-id="s3"] .session-pill-delete')?.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/v1/harness/sessions/s3', method: 'DELETE', body: undefined }
    ]);
    // T9 leaves exactly one strip in the page, so the reopen returns the SAME live node the
    // delete repainted — no header copy to fall out of step.
    expect(pillIds(dashboard())).toEqual(['s1', 's2']);
    expect(dashboard()).toBe(bar);
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
        // T9: the automatic directory re-read is fired by a rejected run, so the submit's
        // create and its task POST need answers (the create lands on the s1 on the server).
        if (url === '/api/sessions' && method === 'POST') return json({ session: first });
        if (url === '/api/sessions/s1/tasks' && method === 'POST')
            return json({ error: { message: 'provider is offline' } }, 500);
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    openDetails();
    await flush();
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(1);

    // Closing through the dialog's own control removes the adopted body with the layer.
    byClass('.dialog-close', 'button').click();
    await flush();

    // T9: with the dialog gone there is NO strip left anywhere — the header keeps only the
    // cycler and its `+`.
    expect(document.querySelector('.session-pills-bar-dialog')).toBeNull();
    expect(document.querySelectorAll('.session-pills-bar')).toHaveLength(0);

    // The directory then changes (a conversation disappears on the server) and the next
    // automatic re-read repaints. Painting only the LIVE bars is what keeps a closed
    // dialog's detached strip from holding a ghost pill — or from throwing.
    listed = [first];
    byClass('.composer-input', 'textarea').value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    expect(pillIds(dashboard())).toEqual(['s1']);
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

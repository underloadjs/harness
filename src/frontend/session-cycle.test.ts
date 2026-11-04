// T7 + T9: the session CYCLER beside the Instruct title (main.ts `sessionCycle`) and the
// `+` next to it (`sessionNew`) — the header's whole session surface, at EVERY width.
//
// Why it exists (user feedback, verbatim): "Lower screen (mobile) this is fine but needed
// to highlight which session is being viewed, but I want a pill next to the instruct button
// here … clicking it will rotate through the session available. There is no need for delete
// button in this mode. If i want to delete, I click on Instruct and delete it from the
// proper dashboard." T9 then asked for the same compact header on the desktop, a `+` beside
// the cycler instead of `+ New`, and the dashboard (with deletion) behind `Instruct`.
//
// The header pill strip is gone at every width (`.session-pills-bar-head` no longer exists),
// so this file pins the small surface that answers "which conversation am I looking at?":
//   - PLACEMENT: one real <button> in `.harness-title-row`, a SIBLING of the `h1` — never
//     nested in `.harness-title-button`, which is itself a button and owns the dialog — with
//     the `+` immediately after it;
//   - PROJECTION: it reads `sessionDirectory()`, the very list `renderSessions()` paints, so
//     the dashboard and the pill can never disagree about what exists;
//   - PAINT: eight characters only (the harness, the status and the full uuid are tooltip
//     facts), the name `Current session <id>. Switch to the next session.`, and `hidden`
//     whenever no conversation is open — repainted from `renderSessions()`, which every
//     mutation path (open / new / delete / an automatic directory re-read / a snapshot frame)
//     already calls;
//   - CYCLE: the next entry of that projection, wrapping last → first, starting at the FIRST
//     entry when the open conversation is not in the list, and doing NOTHING when the
//     directory is empty. Every press is exactly one `openSession` — a view change, never a
//     write (R4);
//   - LOCK: `submitting || running`, the strip's own "can I switch" rule, because the pill
//     calls the same `openSession` — and the tooltip says why rather than going quiet;
//   - NO DELETE here. The full dashboard (pills + `×` + `+`, and NO refresh control since
//     T9/R4) stays behind the title button, where the ACTIVE pill is both painted
//     (`data-active`) and announced (`aria-current`) and follows the pointer.
//
// jsdom computes no layout, so the stylesheet half is read as text — the discipline of
// session-control-style.test.ts and compact-ui.test.ts. The directory half of those reads
// goes through the dialog behind the title (`dashboard()` below), because that is the only
// place it exists now.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts session-cycle.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { viewAwareFetch } from './view-test-support';

const SESSION_KEY = 'underload-harness-app:session';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const T = 1_700_000_000_000;

type Call = { url: string; method: string | undefined; body: unknown };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// Two macrotask turns: enough for the boot chain (bootstrap → remembered session open →
// paint) and for one `openSession` to land and repaint — the same budget the sibling strip
// tests (session-pills.test.ts) run on.
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

// Turn ids are unique per conversation on the server (one mint per task), and the transcript
// keys its tiles by turn id — so the fixtures must not reuse `t1` across sessions, or a
// session switch would legitimately keep the tile that was already there.
const doneTurn = (prompt: string, id: string): SessionTurn =>
    ({
        id,
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

// Router stub: log every call, answer only what the test declares, and fail loudly on
// anything else — which is what makes "one GET per switch, zero writes" provable.
const stubFetch = (
    handler: (url: string, method: string | undefined, body: unknown) => Response | undefined
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const response = handler(url, method, body);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);

            return response;
        }, { root: '/api' }))
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

// The pill, and the surfaces it has to agree with.
const cycle = (): HTMLButtonElement => byClass('.session-cycle', 'button');
const cycleId = (): string | undefined => cycle().querySelector('.session-cycle-id')?.textContent;
// R2 (T9): the `+` that sits immediately after the cycler in the same row.
const headerNew = (): HTMLButtonElement => byClass('.harness-title-row .new-session', 'button');
// T9: the directory is the Sessions section of the dialog behind the title, so "does the
// strip agree with the pill?" means "open the dashboard, read it, and put the layer away".
// Neither gesture touches the pointer or the transcript, so the walk stays deterministic.
const dashboard = (): HTMLElement => {
    if (document.querySelector('.session-pills-bar-dialog') === null) {
        byClass('.harness-title-button', 'button').click();
    }

    return byClass('.session-pills-bar-dialog', 'div');
};
// Scoped to the SESSION layer: a deck dialog may be stacked, and the first `.dialog-close`
// in the document would then belong to the other one.
const closeDashboard = (): void => {
    const panel = document.querySelector('.session-pills-bar-dialog')?.closest('.dialog');
    panel?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
};
const readActivePills = (): (string | undefined)[] => {
    const ids = activePillIds(dashboard());
    closeDashboard();
    return ids;
};
const dialogBar = (): HTMLElement => byClass('.session-pills-bar-dialog', 'div');
const openDetails = (): void => {
    byClass('.harness-title-button', 'button').click();
};
// The strip's own "which one is open" marker, read the way the stylesheet reads it.
function activePillIds(root: ParentNode = document): (string | undefined)[] {
    return [...root.querySelectorAll<HTMLElement>('.session-pill[data-active="true"]')].map(
        (node) => node.dataset.sessionId
    );
}

// T9: there is no Refresh control any more, so a test that needs the page to re-read the
// server's CURRENT directory fires one of the automatic paths instead — a rejected submit,
// whose failure branch in `run()` calls `refreshSessions()`.
const rereadDirectory = async (): Promise<void> => {
    byClass('.composer-input', 'textarea').value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true })
    );
    await flush();
    await flush();
};

// Reads of a conversation RECORD — i.e. exactly the `openSession` calls, in order. Neither
// `/api/models` (the provider list boot always asks for) nor `/api/sessions` (the directory
// read) opens a conversation, so the trailing slash excludes both.
const opened = (calls: Call[]): string[] =>
    calls
        .filter((call) => call.method === undefined && call.url.startsWith('/api/sessions/'))
        .map((call) => call.url.slice('/api/sessions/'.length));

// Three conversations of the selected harness, in directory order. Every test that cycles
// starts from s1 (the remembered pointer), so the expected walk is fully known: s1 → s2 → s3
// → s1.
//
// T21 R21 makes that start deterministic from BOTH sides: a first load opens the most
// recently used conversation, so s1 also carries the newest `updatedAt` (the server's
// own stamp). The remembered pointer and the newest row are the same conversation on
// purpose, and the cycler's walk then never depends on which row the fixture listed
// last.
const directory = (): SessionSnapshot[] => [
    snapshot({
        createdAt: T,
        updatedAt: T + 5_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('first in', 't-s1')]
    }),
    snapshot({
        id: 's2',
        createdAt: T - 10_000,
        updatedAt: T - 5_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('second in', 't-s2')]
    }),
    snapshot({
        id: 's3',
        createdAt: T - 20_000,
        updatedAt: T - 15_000,
        harnessDefinition: descriptor(),
        turns: [doneTurn('third in', 't-s3')]
    })
];

const recordOf = (url: string): SessionSnapshot | undefined =>
    directory().find((session) => url === `/api/sessions/${session.id}`);

const routeDirectory = (url: string): Response | undefined => {
    if (url === '/api') return json(bootstrap({ sessions: directory() }));
    if (url === '/api/models') return json({ models: ['m1'] });
    const record = recordOf(url);
    return record === undefined ? undefined : json({ session: record });
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the header session cycler and its `+` (T7/T9)', () => {
    it('sits beside the Instruct title as one sibling button, with no delete affordance', async () => {
        localStorage.setItem(SESSION_KEY, 's1');
        stubFetch(routeDirectory);

        await import('./main');
        await flush();
        await flush();

        const pill = cycle();
        // A real <button> (Enter/Space work natively) and a SIBLING of the heading inside the
        // title row — never nested in `.harness-title-button`, which is itself a button and
        // already owns the details dialog (interactive content may not nest in a button).
        expect(pill.tagName).toBe('BUTTON');
        expect(pill.type).toBe('button');
        expect(pill.parentElement?.className).toBe('harness-title-row');
        expect([...(pill.parentElement?.children ?? [])].map((node) => node.className)).toEqual([
            'main-title',
            'session-cycle',
            'new-session session-new',
            'harness-id'
        ]);
        expect(byClass('.harness-title-button', 'button').contains(pill)).toBe(false);
        expect(pill.previousElementSibling?.className).toBe('main-title');
        // R2 (T9): the create control is the very next item, so the two read as one group.
        expect(pill.nextElementSibling).toBe(headerNew());
        expect(headerNew().textContent).toBe('+');
        expect(headerNew().getAttribute('aria-label')).toBe('New session');
        expect(headerNew().title).toBe('New session');
        expect(headerNew().parentElement?.className).toBe('harness-title-row');
        // R1 (T9): no directory strip anywhere in the header.
        expect(byClass('.harness-head', 'header').querySelector('.session-pills')).toBeNull();
        expect(document.querySelector('.session-pills-bar-head')).toBeNull();

        // Its whole content is the id plus a decorative rotation mark: NO delete button, NO
        // nested control of any kind. Deletion stays in the dialog's dashboard.
        expect([...pill.children].map((node) => node.className)).toEqual([
            'session-cycle-id',
            'session-cycle-glyph'
        ]);
        expect(pill.querySelectorAll('button')).toHaveLength(0);
        expect(pill.querySelector('.session-pill-delete')).toBeNull();
        expect(pill.textContent).toBe('s1\u21c4');
        // The glyph says "this rotates" without being announced.
        expect(pill.querySelector('.session-cycle-glyph')?.getAttribute('aria-hidden')).toBe('true');

        // The conversation in view, stated three ways: the machine-readable id for the
        // stylesheet and any later query, the accessible name, and the tooltip with what the
        // compact pill has no room for.
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.sessionId).toBe('s1');
        expect(pill.dataset.status).toBe('idle');
        expect(cycleId()).toBe('s1');
        expect(pill.getAttribute('aria-label')).toBe('Current session s1. Switch to the next session.');
        expect(pill.title).toBe('instruct · idle · s1 · click to switch');
        expect(pill.disabled).toBe(false);

        // And it agrees with the directory it was projected from.
        expect(readActivePills()).toEqual(['s1']);
    });

    it('shows eight characters only, with the harness, status and uuid kept in the tooltip', async () => {
        const longId = '3f2a9c1b-7788-4a91-9d0e-1f2a3b4c5d6e';
        const long = snapshot({ id: longId, harnessDefinition: descriptor(), turns: [doneTurn('long id', 't-long')] });

        localStorage.setItem(SESSION_KEY, longId);
        stubFetch((url) => {
            if (url === '/api') return json(bootstrap({ sessions: [long] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === `/api/sessions/${longId}`) return json({ session: long });
            return undefined;
        });

        await import('./main');
        await flush();
        await flush();

        const pill = cycle();
        // The visible text is the eight-character prefix, exactly — the strip's own rule.
        expect(cycleId()).toBe('3f2a9c1b');
        expect(pill.dataset.sessionId).toBe(longId);
        // The uuid, the harness and the status are tooltip-only facts…
        expect(pill.title).toBe(`instruct · idle · ${longId} · click to switch`);
        // …and the accessible name is the prefix plus the action, never raw hex.
        expect(pill.getAttribute('aria-label')).toBe(
            'Current session 3f2a9c1b. Switch to the next session.'
        );
        // The full uuid is never rendered as text anywhere on the page.
        expect(document.body.textContent ?? '').not.toContain(longId);
    });

    it('is hidden while no conversation is open, and paints itself the moment one is', async () => {
        const first = snapshot({
            createdAt: T,
            updatedAt: T + 5_000,
            harnessDefinition: descriptor(),
            turns: [doneTurn('hello', 't-hello')]
        });

        // Nothing remembered. T21 R21: a first load opens the newest conversation of
        // the harness on screen, so the pill starts out naming it — and the header `+`
        // below is what produces the "nothing open" state this control hides in.
        stubFetch((url) => {
            if (url === '/api') return json(bootstrap({ sessions: [first] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1') return json({ session: first });
            return undefined;
        });

        await import('./main');
        await flush();
        await flush();

        const pill = cycle();
        expect(pill.hidden).toBe(false);
        expect(cycleId()).toBe('s1');

        // The header `+` — the compact create control R2 (T9) put beside the cycler —
        // forgets the conversation without deleting anything.
        headerNew().click();
        await flush();

        // Nothing to name, so nothing to read, tab to, or click — and no stale id, name or
        // tooltip left behind for a screen reader to trip over.
        expect(pill.hidden).toBe(true);
        expect(pill.hasAttribute('hidden')).toBe(true);
        expect(cycleId()).toBe('');
        expect(pill.dataset.sessionId).toBeUndefined();
        expect(pill.dataset.status).toBeUndefined();
        expect(pill.hasAttribute('aria-label')).toBe(false);
        expect(pill.hasAttribute('title')).toBe(false);
        expect(pill.disabled).toBe(false);

        // Opening a conversation repaints it — no reload, no separate pass. T9: that pill is
        // in the dashboard behind the title, so reaching it means opening that layer (which
        // the press then dismisses).
        dashboard();
        byClass('.session-pills-bar-dialog .session-pill-select[data-session-id="s1"]', 'button').click();
        await flush();
        await flush();

        expect(pill.hidden).toBe(false);
        expect(cycleId()).toBe('s1');
        expect(pill.dataset.sessionId).toBe('s1');
        expect(pill.getAttribute('aria-label')).toBe('Current session s1. Switch to the next session.');

        // And the `+` returns the pill to hidden again WITHOUT opening the dashboard. The pill
        // can only ever name a conversation on screen.
        expect(document.querySelector('.dialog')).toBeNull();
        headerNew().click();
        await flush();

        expect(pill.hidden).toBe(true);
        expect(cycleId()).toBe('');
        expect(pill.dataset.sessionId).toBeUndefined();
        expect(pill.hasAttribute('aria-label')).toBe(false);
    });

    it('rotates s1 → s2 → s3 and wraps back to s1, opening one conversation per press', async () => {
        localStorage.setItem(SESSION_KEY, 's1');
        const calls = stubFetch(routeDirectory);

        await import('./main');
        await flush();
        await flush();

        const pill = cycle();
        // Boot opened the remembered conversation, so that is the only record read so far.
        expect(opened(calls)).toEqual(['s1']);

        // s1 → s2: the next entry of the SAME projection the strip paints, one GET, and every
        // surface moves together (pill, pointer, transcript, active mark).
        pill.click();
        await flush();
        await flush();

        expect(pill.dataset.sessionId).toBe('s2');
        expect(cycleId()).toBe('s2');
        expect(pill.getAttribute('aria-label')).toBe('Current session s2. Switch to the next session.');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s2');
        expect(readActivePills()).toEqual(['s2']);
        expect(document.querySelector('.tile')?.textContent).toContain('second in');

        // s2 → s3.
        pill.click();
        await flush();
        await flush();

        expect(pill.dataset.sessionId).toBe('s3');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s3');
        expect(readActivePills()).toEqual(['s3']);
        expect(document.querySelector('.tile')?.textContent).toContain('third in');

        // s3 → s1: the walk WRAPS instead of running off the end of the list.
        pill.click();
        await flush();
        await flush();

        expect(pill.dataset.sessionId).toBe('s1');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
        expect(readActivePills()).toEqual(['s1']);
        expect(document.querySelector('.tile')?.textContent).toContain('first in');

        // Exactly one record GET per hop, in directory order, and no write of any kind:
        // cycling is a view change, never a cancellation or a save (R4). (`/api/models` is the
        // background provider lookup boot always fires.)
        expect(opened(calls)).toEqual(['s1', 's2', 's3', 's1']);
        expect(
            calls.filter(
                (call) =>
                    (call.method === 'POST' || call.method === 'DELETE' || call.method === 'PATCH') &&
                    call.url !== '/api/models'
            )
        ).toEqual([]);
    });

    it('starts at the first session when the open one is no longer in the directory', async () => {
        let listed = directory().slice(0, 2);

        localStorage.setItem(SESSION_KEY, 's1');
        const calls = stubFetch((url, method) => {
            if (url === '/api') return json(bootstrap({ sessions: listed }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: listed });
            // T9: the rejected task is what fires the automatic directory re-read.
            if (url === '/api/sessions/s1/tasks' && method === 'POST')
                return json({ error: { message: 'provider is offline' } }, 500);
            const record = recordOf(url);
            return record === undefined ? undefined : json({ session: record });
        });

        await import('./main');
        await flush();
        await flush();

        // Another tab replaced the directory while this page was open: s1 is gone from the
        // list, but the conversation itself stays on screen — so the pill still names it.
        listed = directory().slice(1);
        await rereadDirectory();

        const pill = cycle();
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.sessionId).toBe('s1');
        expect(pill.title).toBe('instruct · idle · s1 · click to switch');
        expect(readActivePills()).toEqual([]);

        // An id the list does not contain resolves to `index === -1`, and the handler turns
        // that into the FIRST entry rather than wrapping past the end.
        pill.click();
        await flush();
        await flush();

        expect(opened(calls)).toEqual(['s1', 's2']);
        expect(pill.dataset.sessionId).toBe('s2');
        expect(readActivePills()).toEqual(['s2']);
    });

    it('does nothing when the directory is empty', async () => {
        let listed = [snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('only one', 't-only')] })];

        localStorage.setItem(SESSION_KEY, 's1');
        const calls = stubFetch((url, method) => {
            if (url === '/api') return json(bootstrap({ sessions: listed }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: listed });
            if (url === '/api/sessions/s1') return json({ session: listed[0] });
            // T9: the rejected task is what fires the automatic directory re-read.
            if (url === '/api/sessions/s1/tasks' && method === 'POST')
                return json({ error: { message: 'provider is offline' } }, 500);
            return undefined;
        });

        await import('./main');
        await flush();
        await flush();

        // The conversation the reader is looking at was deleted elsewhere.
        listed = [];
        await rereadDirectory();

        const bar = dashboard();
        expect(bar.querySelector('.session-pills-empty')?.textContent).toBe('No sessions yet.');
        expect(activePillIds(bar)).toEqual([]);
        closeDashboard();

        const pill = cycle();
        // It still names what is on screen (the record this instance was built from), and a
        // press cannot open anything: no request, no navigation, no lost pointer.
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.sessionId).toBe('s1');

        pill.click();
        await flush();
        await flush();

        expect(opened(calls)).toEqual(['s1']);
        expect(pill.dataset.sessionId).toBe('s1');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    });

    it('hides itself when the conversation in view is deleted', async () => {
        const first = snapshot({
            // T21 R21: a first load opens the newest conversation, and this test walks
            // the delete of the conversation ON screen (s1) — so s1 is the newer row.
            createdAt: T,
            updatedAt: T + 5_000,
            harnessDefinition: descriptor(),
            turns: [doneTurn('hello', 't-hello')]
        });
        const second = snapshot({
            id: 's2',
            createdAt: T - 10_000,
            updatedAt: T - 5_000,
            harnessDefinition: descriptor(),
            turns: [doneTurn('other', 't-other')]
        });

        localStorage.setItem(SESSION_KEY, 's1');
        const calls = stubFetch((url, method) => {
            if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: [second] });
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: first });
            if (url === '/api/sessions/s1' && method === 'DELETE') return json({ deleted: true });
            if (url === '/api/sessions/s2') return json({ session: second });
            return undefined;
        });

        await import('./main');
        await flush();
        await flush();

        const pill = cycle();
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.sessionId).toBe('s1');

        // One click on the dashboard's `×` removes the conversation THAT pill was naming.
        // T9: the `×` exists only behind the title button, at every width. The delete is
        // permanent (the server drops the record), so the cycler has nothing left to name:
        // it goes hidden with its attributes, and a press cannot resurrect it.
        dashboard();
        byClass(
            '.session-pills-bar-dialog .session-pill[data-session-id="s1"] .session-pill-delete',
            'button'
        ).click();
        await flush();
        await flush();
        // A delete leaves the layer open (only OPENING a conversation dismisses it).
        expect(document.querySelector('.dialog')).not.toBeNull();
        closeDashboard();

        expect(pill.hidden).toBe(true);
        expect(pill.dataset.sessionId).toBeUndefined();
        expect(cycleId()).toBe('');
        expect(pill.hasAttribute('aria-label')).toBe(false);

        // The cycler's own cycle start still applies in this state: with no conversation
        // open the active id is absent, which resolves to the FIRST entry of the directory.
        // On screen this press is unreachable (the control is `hidden`), but it is the
        // defined behaviour rather than a stale pointer, so it is pinned.
        pill.click();
        await flush();
        await flush();

        expect(opened(calls)).toEqual(['s1', 's2']);
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.sessionId).toBe('s2');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s2');
        expect(readActivePills()).toEqual(['s2']);
        expect(pill.disabled).toBe(false);
    });

    it('refuses to switch while a submit is in flight, exactly like the strip', async () => {
        const first = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn('hello')] });

        localStorage.setItem(SESSION_KEY, 's1');
        let taskRequests = 0;

        stubFetch((url, method) => {
            if (url === '/api') return json(bootstrap({ sessions: [first] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: first });
            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                taskRequests += 1;
                // Held open on purpose: the enqueue window IS the moment a switch would drop
                // the reader out of a conversation whose queue is still moving. Nothing after
                // this point depends on the answer, so it never has to arrive.
                return new Promise<Response>(() => undefined);
            }
            return undefined;
        });

        await import('./main');
        await flush();
        await flush();

        const pill = cycle();
        expect(pill.disabled).toBe(false);

        byClass('.composer-input', 'textarea').value = 'say hi';
        byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        // The enqueue request goes out after `ensureSession`, so let the submit reach the
        // network layer; the answer never arrives, which is what holds the lock open.
        await flush();

        // `paintControls()` owns this lock and runs in the same synchronous paint that
        // disables a strip pill, so the two surfaces can never disagree about whether a
        // switch is possible — and the tooltip explains the lock instead of only muting it.
        // T9: the strip that proves the other half of that sentence is the dashboard.
        expect(taskRequests).toBe(1);
        expect(pill.disabled).toBe(true);
        expect(pill.title).toBe('instruct · idle · s1 · wait for the run to finish before switching');
        const bar = dashboard();
        expect(bar.querySelector<HTMLElement>('.session-pill-select')?.disabled).toBe(true);
        // R2 (T9): the header `+` carries the same enqueue lock, so the reader cannot start a
        // second conversation while the first one's task is still being posted.
        expect(headerNew().disabled).toBe(true);
        closeDashboard();
    });

    it('leaves the session dashboard highlighting the conversation the cycler switched to', async () => {
        localStorage.setItem(SESSION_KEY, 's1');
        stubFetch(routeDirectory);

        await import('./main');
        await flush();
        await flush();

        openDetails();
        await flush();

        // T9: this IS the directory — the same strip, at every width — and its ACTIVE pill is
        // both painted (styles.css keys the accent frame off `.session-pill[data-active='true']`)
        // and ANNOUNCED (`aria-current` on the open button, written under exactly the same
        // condition as `data-active`).
        const before = dialogBar();
        const s1 = before.querySelector<HTMLElement>('.session-pill[data-session-id="s1"] .session-pill-select');
        expect(s1?.dataset.active).toBe('true');
        expect(s1?.getAttribute('aria-current')).toBe('true');
        expect(
            before
                .querySelector('.session-pill[data-session-id="s2"] .session-pill-select')
                ?.hasAttribute('aria-current')
        ).toBe(false);

        byClass('.dialog-close', 'button').click();
        await flush();

        // The pill steps to s2; opening the dashboard again highlights THAT one, and the
        // previous pill is clean.
        cycle().click();
        await flush();
        await flush();
        expect(cycle().dataset.sessionId).toBe('s2');

        openDetails();
        await flush();

        const after = dialogBar();
        expect(activePillIds(after)).toEqual(['s2']);
        expect(
            after.querySelector('.session-pill[data-session-id="s2"] .session-pill-select')?.getAttribute(
                'aria-current'
            )
        ).toBe('true');
        expect(
            after.querySelector('.session-pill[data-session-id="s1"] .session-pill-select')?.hasAttribute(
                'aria-current'
            )
        ).toBe(false);

        // R3 (T9): deletion is still where the user asked for it — three pills, each with its
        // `×`, plus the dashboard's own `+`. And R4: no refresh control anywhere.
        expect(after.querySelectorAll('.session-pill-delete')).toHaveLength(3);
        // R3 (this pass): the dashboard has NO create control any more, so the only
        // `.new-session` left in the page is the header's compact `+`.
        expect(after.querySelector('.new-session')).toBeNull();
        expect(document.querySelectorAll('.new-session')).toHaveLength(1);
        expect(after.querySelector('.refresh-sessions')).toBeNull();
    });
});

// --- the stylesheet half ---------------------------------------------------

const css = (() => {
    const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));
    if (stylesheet === undefined) throw new Error('styles.css not found');
    return readFileSync(stylesheet, 'utf8');
})();

// Comments NAME rules that used to exist, so "must not exist" reads the stripped text (the
// convention of session-control-style.test.ts).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Brace-matched body of the FIRST `selector` in `source` — the desktop/base copy, or a rule
// inside an already-extracted `@media` body.
const blockIn = (source: string, selector: string): string => {
    const start = source.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

const blockOf = (selector: string): string => blockIn(rules, selector);

// A whole `@media` body, braces balanced: the phone contract is about the RULE LIST (what it
// shows and what it hides), so it cannot be read with `blockOf`.
const mediaBlockOf = (query: string): string => {
    const start = rules.indexOf(`@media ${query}`);
    if (start < 0) throw new Error(`missing media query ${query}`);

    const open = rules.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${query}`);

    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced media block for ${query}`);
};

describe('the header session controls stylesheet (T7/T9)', () => {
    it('paints one compact cycler and `+` for every width, with no header strip to hide', () => {
        // The assumption T9 replaces: the cycler used to be a PHONE addition behind a base
        // `display: none`. Its box now lives in the shared BASE rule, so desktop and phone
        // get the same control and no breakpoint decides visibility.
        const compact = blockOf('.session-cycle,\n.session-new {');
        expect(compact).toContain('display: inline-flex');
        // Exactly one rule still declares `.session-cycle` on its own, and it is the width
        // ceiling — not a visibility flip.
        expect(rules.match(/\.session-cycle \{/g)).toHaveLength(1);

        // The alignment the phone block used to own is now the row's base rule, so the two
        // bordered controls line up with the title at every width.
        expect(blockOf('.harness-title-row {')).toContain('align-items: center');

        // R1 (T9): the desktop header strip is gone, so its class may not come back as a rule
        // anywhere — base or phone.
        expect(rules).not.toContain('.session-pills-bar-head');
        const phone = mediaBlockOf('(max-width: 860px)');
        expect(phone).not.toContain('.session-pills-bar');
        expect(phone).not.toContain('.session-cycle');
        expect(phone).not.toContain('.session-new');

        // The strip that survives is the dashboard's, and it is still a wrapping flex row.
        expect(blockOf('.session-pills-bar {')).toContain('display: flex');
        // R4 (T9): the manual refresh control is gone from the stylesheet as well as the DOM.
        expect(rules).not.toContain('.refresh-sessions');
    });

    it('gives the cycler and the `+` one matched box, differentiated only by fill', () => {
        const compact = blockOf('.session-cycle,\n.session-new {');
        for (const declaration of [
            'align-items: center',
            'justify-content: center',
            'gap: 4px',
            // A fixed, small flex item beside a title that stays free to ellipsize: the
            // controls can push the title, never the other way round, and they never wrap to
            // a second line.
            'flex: 0 0 auto',
            'padding: 3px 9px',
            // The strip's ACTIVE-pill vocabulary (accent frame + soft fill), so the cycler
            // reads as "the conversation in view" rather than as one more header button.
            'border: 1px solid var(--accent)',
            // The same control radius as every other button/chip (`--radius-sm`), so the pair
            // matches the dashboard strip it replaced instead of adding a new shape.
            'border-radius: var(--radius-sm)',
            'background: var(--accent-soft)',
            'color: var(--text)',
            'font-family: var(--mono)',
            'font-size: 11px',
            'white-space: nowrap',
            'cursor: pointer'
        ]) {
            expect(compact).toContain(declaration);
        }

        // `42vw` is the ceiling that leaves the title the rest of the row, and it belongs to
        // the text-carrying control only (the `+` is content-sized).
        expect(blockOf('.session-cycle {')).toContain('max-width: 42vw');

        // R2 (T4): the two controls must be the same size IN FACT, not only in look. The
        // shared rule is the single source of every box metric, and the `+` rule may not
        // restate any of them — a `font-size` or `line-height` override (the 13px this
        // contract used to pin) moves the intrinsic height of one control away from the
        // other and reopens the size mismatch the user objected to.
        const plus = blockIn(rules, '.session-new {\n    min-width');
        for (const metric of [
            'font-size',
            'line-height',
            'padding',
            'border-radius',
            'border-width',
            'height',
            'min-height',
            'gap',
            'letter-spacing'
        ]) {
            expect(plus).not.toContain(`${metric}:`);
        }
        // The metrics both controls therefore inherit from ONE declaration each.
        for (const declaration of [
            'font-size: 11px',
            'line-height: 1.4',
            'padding: 3px 9px',
            'border: 1px solid var(--accent)',
            'border-radius: var(--radius-sm)'
        ]) {
            expect(compact).toContain(declaration);
        }

        // Only the paint, and a minimum width for a single glyph, belong to the `+`: same
        // box, neutral frame, so it matches its neighbour without claiming the "current
        // session" highlight the cycler carries.
        expect(plus).toContain('min-width: 26px');
        expect(plus).toContain('border-color: var(--border-strong)');
        expect(plus).toContain('background: var(--bg-elevated)');
        expect(blockOf('.session-new:hover:not(:disabled) {')).toContain(
            'border-color: var(--accent)'
        );

        // Hover confirms the press, focus is the app's accent ring for BOTH controls (and
        // therefore an IDENTICAL ring — same width, style, colour and offset — on the `+`),
        // and a locked control reads locked (the guards `paintSessionCycle` and
        // `paintSessionActions` paint from `submitting || running` / the busy contract).
        expect(blockOf('.session-cycle:hover:not(:disabled) {')).toContain(
            'background: var(--accent)'
        );
        const focus = blockOf('.session-cycle:focus-visible,\n.session-new:focus-visible {');
        expect(focus).toContain('outline: 2px solid var(--accent)');
        expect(focus).toContain('outline-offset: 2px');
        const disabled = blockOf('.session-cycle:disabled,\n.session-new:disabled {');
        expect(disabled).toContain('cursor: not-allowed');
        expect(disabled).toContain('border-color: var(--border)');

        // The id clips instead of widening the row, and the rotation mark is quiet — both are
        // BASE rules, so they hold whatever the breakpoint does.
        const id = blockOf('.session-cycle-id {');
        expect(id).toContain('overflow: hidden');
        expect(id).toContain('text-overflow: ellipsis');
        expect(id).toContain('white-space: nowrap');
        expect(blockOf('.session-cycle-glyph {')).toContain('color: var(--muted)');

        // No `×` lives in the header, so no destructive styling may exist for one either.
        expect(rules).not.toContain('.session-cycle-delete');
        expect(rules).not.toContain('.session-cycle-remove');
    });
});

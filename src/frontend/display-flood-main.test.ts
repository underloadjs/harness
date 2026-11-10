// R2 + R4 — the display-request flood and the per-tick tile rebuild it caused.
//
// The bug (user-reported: the server log repeating
// `GET /v1/harness/sessions/<sid>/turns/<tid>/display` for the SAME turn ~20 times): the
// document read `getView` (./view-shell.ts) composed a window that fetched a display tree for
// every painted turn, and the bounded fallback poll (./main.ts `pollSession`) re-reads THAT
// document once per second while work is pending. A conversation that had not moved at all
// therefore issued one identical tree read per painted turn per second, and because the
// document's trees were re-applied through `reconcileView`, every tile also lost and re-earned
// its painted flow on each tick (the flicker).
//
// The fix, pinned here:
//   - a document read asks for ROWS ONLY (`openSession(sessionId, { visibleTurns: 0 })`), so
//     the per-instance display loader (`createDisplayPlane`, driven by the pane's `reveal()`)
//     is the ONLY thing that reads trees — capped, deduped, generation-guarded;
//   - `applyView` carries the painted trees across a rows-only document while the row's own
//     figures have not moved, so a steady-state poll tick costs ZERO display reads and reuses
//     the same tile DOM (no wipe, no rebuild);
//   - a row that really is new still earns exactly ONE tree read;
//   - a row whose RECORD moved earns exactly one FRESH tree read (`DisplayPlane.forget`), the
//     channel the polled document used to provide by shipping a tree for every painted turn.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts display-flood-main.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bumpFixtureEpoch, viewAwareFetch } from './view-test-support';

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
    }
];

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 'r1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const turn = (overrides: Partial<SessionTurn>): SessionTurn =>
    ({
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

type Call = { url: string; method: string | undefined };

// One recorder for everything the shell asks for. The canonical `/v1/harness/...` reads are
// composed by `viewAwareFetch` from the `/api` record below, so both spellings land here and
// the display reads are counted at the browser's own request layer.
const stubFetch = (
    handler: (url: string, method: string | undefined) => Response | undefined
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;

            calls.push({ url, method });

            const response = handler(url, method);

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

// The turn ids whose tree the browser read, in the order it asked — the only figure this case
// is about. The recorded spelling is the fixture's legacy `/api` route that `viewAwareFetch`
// composes the canonical contract route from (`../shared/harness-api.ts`), and the full URL
// list is asserted once below so a route change cannot quietly make this counter meaningless.
const treeReads = (calls: readonly Call[]): string[] =>
    calls
        .filter((call) => call.method === undefined && /\/turns\/[^/]+\/display$/.test(call.url))
        .map((call) => call.url.split('/turns/')[1]?.split('/')[0] ?? call.url);

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);

    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('pays zero display reads for an unchanged poll tick and one for a turn that is new', async () => {
    // T50: the degraded host the bounded poll is the observation for — no `WebSocket`
    // constructor at all settles the observation immediately (./view-shell.ts), so
    // `pollSession` re-reads the window on `POLL_INTERVAL_MS` (./main.ts).
    vi.stubGlobal('WebSocket', undefined);
    vi.useFakeTimers();

    const first = [
        turn({ id: 't1', index: 0, status: 'done' }),
        // A still-running turn keeps the poll alive (`pendingOf`); its RECORD does not move
        // between the ticks below, which is exactly the steady state the flood was made of.
        turn({ id: 't2', index: 1, status: 'running' })
    ];

    let served = snapshot({ id: 'r1', status: 'running', turns: first });

    localStorage.setItem(SESSION_KEY, 'r1');

    const calls = stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [served] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') return json({ session: served });

        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    // The open painted both turns, and every tree came from the display loader — EXACTLY one
    // read per painted turn, never one per turn per tick. The ORDER the loader asks in is its
    // own business (it walks the visible window newest-first, ./view-shell.ts `ensureVisible`),
    // so the membership is what is asserted exactly: no turn read twice, none skipped.
    expect([...treeReads(calls)].sort()).toEqual(['t1', 't2']);

    const loaded = treeReads(calls).length;
    const tile = byClass('.tile[data-turn-id="t1"]', 'article');

    // Two more ticks of the SAME record: rows-only documents, the trees carried across, and
    // the tiles keep their own DOM (no `syncDisplay(empty)` wipe, no rebuild).
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(treeReads(calls)).toHaveLength(loaded);
    expect(document.querySelector('.tile[data-turn-id="t1"]')).toBe(tile);

    // The server moved on: a third turn exists. It earns exactly ONE tree read, and the two
    // turns that did not move still cost nothing.
    served = snapshot({ id: 'r1', status: 'running', turns: [...first, turn({ id: 't3', index: 2, status: 'done' })] });
    bumpFixtureEpoch();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(treeReads(calls).slice(loaded)).toEqual(['t3']);
    expect(treeReads(calls).filter((id) => id === 't1')).toHaveLength(1);
    expect(treeReads(calls).filter((id) => id === 't2')).toHaveLength(1);
    expect(document.querySelector('.tile[data-turn-id="t1"]')).toBe(tile);

    // The row that moved must get a FRESH tree: `carryDisplays` un-marks it on the plane
    // (`DisplayPlane.forget`), so the loader reads it again. That is the channel the polled
    // document used to provide by shipping a tree for every painted turn — here it costs one
    // read, for the one row whose record advanced, and nothing for the two that did not.
    served = snapshot({
        id: 'r1',
        status: 'running',
        turns: [...first, turn({ id: 't3', index: 2, status: 'done', updatedAt: T + 9_000 })]
    });
    bumpFixtureEpoch();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(treeReads(calls).slice(loaded + 1)).toEqual(['t3']);
    expect(treeReads(calls).filter((id) => id === 't1')).toHaveLength(1);
    expect(treeReads(calls).filter((id) => id === 't2')).toHaveLength(1);

    // The WHOLE display budget of the run, spelled out: four tree reads across five document
    // reads, where the old document-based path cost one read per painted turn per tick.
    // `treeReads` counts by path shape, so the exact URLs are pinned once here — a route change
    // cannot quietly make that counter match nothing.
    expect(calls.map((call) => call.url).filter((url) => url.endsWith('/display')).sort()).toEqual([
        '/api/sessions/r1/turns/t1/display',
        '/api/sessions/r1/turns/t2/display',
        '/api/sessions/r1/turns/t3/display',
        '/api/sessions/r1/turns/t3/display'
    ]);

    // The ROW document is still re-read — that is what the poll is for, and the fix did not
    // touch it. Exactly three reads of this conversation's document happen in the run above:
    // the open, plus one per tick whose document differed. A tick whose document is unchanged
    // cannot be counted here because the fixture adapter answers an unchanged epoch without
    // reaching this stub (./view-test-support.ts `bumpFixtureEpoch`) — which is also why the
    // tree reads above are the honest measure of a tick.
    expect(calls.filter((call) => call.method === undefined && call.url === '/api/sessions/r1')).toHaveLength(3);
});

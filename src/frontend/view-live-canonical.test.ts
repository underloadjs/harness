// T44: the LIVE path asserted on actual canonical wire messages, end to end through the
// real client code — `./view-api.ts` (paging), `./view-shell.ts` (frame → item mapping),
// `./view-state.ts` (the merge reducer), `./stream.ts` (the connection) and the shared
// fixture bridge `./view-test-support.ts`.
//
// WHY THESE CASES EXIST (each pins a root cause, not a helper):
//   1. The rows page. The client opens a conversation with
//      `GET {root}/sessions/:id/turns?limit=25&order=desc` and reverses the page it gets
//      (`view-api.ascRows`, because `desc` cursors walk OLDER). The fixture's route parser
//      dispatches on a PATHNAME (`stripOrigin` exists for the prefix comparisons), so the
//      query never reached `canonicalRoutes`, `order=desc` was ignored, an ASCENDING page
//      came back, and the client reversed the wrong end: newest-first board, `olderCursor`
//      null. Pinned below on the exact window and cursor.
//   2. A `session.updated` patch. `SessionStatePatch`
//      (../shared/harness-api.ts:2048-2059) is metadata with NO turns, and the shell's
//      document path is authoritative for rows: `applyView` rebuilds the record cache from
//      `session.turns` and tombstones every id it no longer names. Publishing the metadata
//      read as a `{type:'view'}` document therefore deleted every live turn the moment the
//      terminal patch landed. The contract now says `header`, asserted here on the exact
//      item vocabulary.
//   3. `display.ops` is a `turn`-scope kind (../shared/harness-stream.ts:201). The bridge
//      addresses a flow frame to the subscription that names the turn, and a `turn.upsert`
//      to the session scope, so a test cannot accidentally pin the wrong scope.
//   4. A dropped socket must reconnect for real: the fixture fires the socket's `onclose`
//      (./stream.ts:528 is the only thing that drives the resume), the client re-dials with
//      `hello` + one `subscribe` per live subscription, and the new connection restarts the
//      sequence space — otherwise every reconnect reads as a gap and forces a window
//      re-read (which is exactly the wipe in case 2, arriving by another route).
//   5. Row merge semantics: a receipt row (`view-api.rowFromReceipt`, `optimistic: true`,
//      stamped with the LOCAL clock) must never outrank the server's `turn.upsert` for the
//      same id, or the tile keeps the receipt's figures — no `usage`, so no token tally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, SessionStreamItem, SessionTurn, SessionView } from '../server/protocol';
import type { TurnSummary } from '../shared/turn-display';
import { listTurns } from './api';
import { openSession } from './view-api';
import { observeTurn, observeView } from './view-shell';
import type { ViewStreamItem } from './view-shell';
import { applySessionPatch, createViewStateStore, isPendingView, upsertSummary } from './view-state';
import { installHarnessStream, viewAwareFetch } from './view-test-support';
import type { StreamDouble } from './view-test-support';

// A fixed base stamp, far behind the wall clock the receipt path uses, which is what makes
// the optimistic-row case (5) reproducible without faking time.
const T = 1_700_000_000_000;

// One recorded turn of the host document the fixture composes its canonical answers from.
const turnOf = (id: string, index: number, status: 'running' | 'done'): SessionTurn =>
    ({
        id,
        index,
        prompt: `task ${index}`,
        status,
        startedAt: T + index * 100,
        updatedAt: T + index * 100 + 50,
        events: [],
        eventTimes: []
    }) as unknown as SessionTurn;

// The conversation as the SERVER holds it: a raw `SessionSnapshot`, which every canonical
// read in the bridge is projected from (never a hand-written view).
const snapshotOf = (status: 'running' | 'idle', turns: SessionTurn[]): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status,
        model: 'm1',
        createdAt: T,
        updatedAt: T + 1_000,
        turns,
        threads: [],
        harnessDefinition: { name: 'instruct', primary: 'instruct', members: ['instruct'] }
    }) as unknown as SessionSnapshot;

// The canonical row a `turn.upsert` carries for one turn (`TurnSummary`, camelCase per
// ../shared/harness-api.ts), streaming and then terminal.
const rowRunning = {
    id: 't1',
    index: 0,
    promptPreview: 'say hi',
    promptChars: 6,
    status: 'running',
    state: 'streaming',
    updatedAt: 2_000,
    startedAt: 1_800,
    sectionCount: 1,
    stepCount: 0,
    activeAgents: ['instruct'],
    blocks: [],
    usage: { input: 48, output: 18, total: 66, cached: 0 },
    cachedInput: 0
};
const rowDone = {
    ...rowRunning,
    status: 'done',
    state: 'done',
    updatedAt: 2_400,
    activeAgents: [],
    usage: { input: 144, output: 40, total: 184, cached: 48 },
    latestInput: 96,
    cachedInput: 48
};

// The op the turn scope publishes for one `usage` report (the tile's token tally).
const usageOp = {
    op: 'usage',
    sectionId: 'turn',
    latestInput: 96,
    cachedInput: 48,
    usage: { input: 144, output: 40, total: 184, cached: 48 }
};

// A window with no rows yet — the state a live connection patches.
const blankView = (sessionId = 's1'): SessionView =>
    ({
        id: sessionId,
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: T,
        updatedAt: T,
        turns: [],
        displays: {},
        olderCursor: null
    }) as unknown as SessionView;

// Microtasks + macrotasks, so a queued socket handshake, an async `getSession` and a
// subscription re-register all land before the assertions run.
const settle = async (rounds = 6): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

// Bounded wait for a subscription the client writes on a microtask.
const subscribed = async (stream: StreamDouble, scope: string): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (stream.subscriptions.some((sub) => sub.scope === scope)) return;
        await settle(1);
    }

    throw new Error(`no ${scope} subscription was ever registered`);
};

// Every url the browser dialled, in order; the fixture answers from the shared snapshot.
let dialed: string[] = [];

const stubFetch = (snapshot: () => SessionSnapshot): void => {
    const answer = viewAwareFetch(async () => undefined, { root: '/api', snapshot });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            // The url the BROWSER dialled, before the adapter rewrites it.
            dialed.push(String(input));

            return answer(input, init);
        })
    );
};

describe('the canonical rows page', () => {
    beforeEach(() => {
        dialed = [];
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // Case 1: the page is answered in the ORDER and WINDOW the client asked for.
    it('answers order=desc newest-first so the board renders the tail in recorded order', async () => {
        stubFetch(() =>
            snapshotOf('idle', [turnOf('t1', 0, 'done'), turnOf('t2', 1, 'done'), turnOf('t3', 2, 'done')])
        );

        const view = await openSession('s1', {
            limit: 2,
            visibleTurns: 0,
            includeRoster: false,
            includeActions: false
        });

        // The client dialled the canonical page with its paging query intact.
        const page = dialed.find((url) => url.includes('/turns'));

        expect(page).toBeDefined();
        const query = new URL(String(page), 'http://localhost/').searchParams;
        expect(query.get('order')).toBe('desc');
        expect(query.get('limit')).toBe('2');

        // The newest TWO rows, reversed by the client into recorded order, with the
        // cursor that walks further back. An ignored query would answer all three
        // ascending, reverse them into `t3,t2,t1`, and report no older page at all.
        expect(view.turns.map((row) => row.id)).toEqual(['t2', 't3']);
        expect(view.olderCursor).toBe('older-cursor');
    });

    // The same rule on the bare read, so the parser (not `openSession`) is what is pinned.
    it('pages with the cursor the client sent', async () => {
        stubFetch(() =>
            snapshotOf('idle', [turnOf('t1', 0, 'done'), turnOf('t2', 1, 'done'), turnOf('t3', 2, 'done')])
        );

        const page = await listTurns('s1', { limit: 2, order: 'desc', cursor: 'older-cursor' });

        // The fixture's second window: the rows OLDER than the page just held.
        expect(page.items.map((row) => row.id)).toEqual(['t1']);
    });
});

describe('the live subscription plane', () => {
    beforeEach(() => {
        dialed = [];
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    // Case 2 + 5: the run a reader is watching survives its own terminal frame.
    it('keeps the streamed turn through the terminal session patch and paints the server figures', async () => {
        let host = snapshotOf('running', [turnOf('t1', 0, 'running')]);
        stubFetch(() => host);

        const live: StreamDouble = installHarnessStream({ sessionId: 's1', snapshot: () => host });
        const items: ViewStreamItem[] = [];
        const controller = new AbortController();

        void observeView('s1', (item) => items.push(item), controller.signal);
        await subscribed(live, 'session');

        const store = createViewStateStore();
        store.setView(blankView());

        const applyAll = (): void => {
            for (const item of items.splice(0)) store.applyItem(item as unknown as Parameters<typeof store.applyItem>[0]);
        };

        // A: the row the server published when the task started.
        expect(live.push({ kind: 'turn.upsert', turn: rowRunning })).toBe(true);
        await settle();
        applyAll();

        let row = store.view()?.turns[0] as (TurnSummary & Record<string, unknown>) | undefined;

        expect(store.view()?.turns.map((entry) => entry.id)).toEqual(['t1']);
        expect(row?.status).toBe('running');
        expect(row?.state).toBe('streaming');
        expect(row?.usage).toEqual({ input: 48, output: 18, total: 66, cached: 0 });

        // B: the flow frame for the usage report, then the terminal row.
        expect(live.push({ kind: 'display.ops', turn_id: 't1', ops: [usageOp] })).toBe(true);
        expect(live.push({ kind: 'turn.upsert', turn: rowDone })).toBe(true);
        await settle();
        applyAll();

        row = store.view()?.turns[0] as (TurnSummary & Record<string, unknown>) | undefined;

        // The tile's two printed figures come from the row, exactly as the server stated
        // them: the LATEST request beside the turn-wide cache.
        expect(row?.latestInput).toBe(96);
        expect(row?.cachedInput).toBe(48);
        expect(row?.usage).toEqual({ input: 144, output: 40, total: 184, cached: 48 });
        expect(row?.status).toBe('done');

        // C: the terminal `session.updated` patch. It is metadata, so the shell answers it
        // with a `header` item and never with a zero-row document; the rows the client
        // already holds survive.
        host = snapshotOf('idle', [turnOf('t1', 0, 'done')]);
        live.push({ kind: 'session.updated', session: { id: 's1', status: 'idle', model: 'm1', revision: 8 } });
        await settle();

        const header = items[items.length - 1];

        expect(header?.type).toBe('header');
        expect(items.filter((item) => item.type === 'view')).toHaveLength(0);

        applyAll();

        row = store.view()?.turns[0] as (TurnSummary & Record<string, unknown>) | undefined;

        expect(store.view()?.turns).toHaveLength(1);
        expect(row?.id).toBe('t1');
        expect(row?.status).toBe('done');

        controller.abort();
        live.close();
    });

    // Case 3: the scope contract — flow frames ride the turn subscription.
    it('addresses display ops to the turn subscription and a row upsert to the session scope', async () => {
        const host = snapshotOf('running', [turnOf('t1', 0, 'running')]);
        stubFetch(() => host);

        const live = installHarnessStream({ sessionId: 's1', snapshot: () => host });
        const session: ViewStreamItem[] = [];
        const flow: ViewStreamItem[] = [];
        const controller = new AbortController();

        void observeView('s1', (item) => session.push(item), controller.signal);
        await subscribed(live, 'session');

        void observeTurn('s1', 't1', (item) => flow.push(item), controller.signal);
        await subscribed(live, 'turn');

        live.push({ kind: 'display.ops', turn_id: 't1', ops: [usageOp] });
        await settle();

        // One item, on the turn scope only, projected to the render model op verbatim.
        expect(session).toHaveLength(0);
        expect(flow).toHaveLength(1);
        expect((flow[0] as Extract<ViewStreamItem, { type: 'ops' }>).ops).toEqual([
            {
                op: 'usage',
                turnId: 't1',
                sectionId: 'turn',
                latestInput: 96,
                cachedInput: 48,
                usage: { input: 144, output: 40, total: 184, cached: 48 }
            }
        ]);

        live.push({ kind: 'turn.upsert', turn: rowDone });
        await settle();

        // A row is a session-scope kind: it lands once, on the session subscription.
        expect(session.map((item) => item.type)).toEqual(['ops']);
        expect(flow).toHaveLength(1);

        controller.abort();
        live.close();
    });

    // Case 4: a dropped socket reconnects, re-registers and restarts the sequence space.
    it('re-registers every subscription after a dropped socket without reading a gap', async () => {
        const host = snapshotOf('running', [turnOf('t1', 0, 'running')]);
        stubFetch(() => host);

        // Deterministic transport timing: the client's backoff callback is run by the test.
        const scheduled: { run: () => void; ms: number }[] = [];
        const live = installHarnessStream({
            sessionId: 's1',
            snapshot: () => host,
            schedule: (fn, ms) => {
                scheduled.push({ run: fn, ms });

                return () => undefined;
            }
        });

        const session: ViewStreamItem[] = [];
        const controller = new AbortController();

        void observeView('s1', (item) => session.push(item), controller.signal);
        await subscribed(live, 'session');

        expect(live.status()).toBe('open');

        live.push({ kind: 'turn.upsert', turn: rowRunning });
        await settle();
        expect(session.map((item) => item.type)).toEqual(['ops']);

        // The socket drops. The fixture used to stop delivering and leave the client
        // believing it was still open; a real close fires `onclose`, which is the ONLY
        // thing that puts ./stream.ts into `reconnecting`.
        const beforeDrop = scheduled.length;

        live.drop();

        expect(live.status()).toBe('reconnecting');
        expect(live.socket().closeCode).toBe(1006);

        const reconnect = scheduled.slice(beforeDrop).find((entry) => entry.ms >= 500);

        expect(reconnect).toBeDefined();
        (reconnect as { run: () => void }).run();
        await settle();

        expect(live.status()).toBe('open');

        // Resume first (`hello` names the epoch and the last cursor), then every live
        // subscription again — the contract's only recovery after a lost connection.
        const hello = live.sent.filter((frame) => frame.type === 'hello');

        expect(hello).toHaveLength(1);
        expect(hello[0].epoch).toBe('test-epoch');
        expect(typeof hello[0].cursor).toBe('string');

        expect(
            live.sent
                .filter((frame) => frame.type === 'subscribe')
                .map((frame) => `${String(frame.scope)}:${String(frame.session_id)}`)
        ).toEqual(['session:s1', 'session:s1']);

        // And the new connection delivers again, with no gap: a sequence that continued
        // the old counter would fire `resync_required` here, and the shell would answer
        // with a window re-read — the very document that used to wipe the board.
        expect(live.push({ kind: 'turn.upsert', turn: rowDone })).toBe(true);
        await settle();

        expect(session.map((item) => item.type)).toEqual(['ops', 'ops']);
        expect(session.filter((item) => item.type === 'view')).toHaveLength(0);

        controller.abort();
        live.close();
    });
});

// T46: the header patch's merge rule, pinned where it lives (`view-state.ts
// applySessionPatch`, which `main.ts applyHeaderPatch` delegates to). This is the T44
// regression in its smallest honest form: a `session.updated` patch — or a card answer —
// replaces the SESSION facts and must leave everything the reader is looking at alone.
describe('the session-level patch', () => {
    it('replaces session facts while preserving the rendered rows, tallies, trees and pending state', () => {
        const view = blankView();

        upsertSummary(view, rowRunning as unknown as TurnSummary);
        view.displays['t1'] = { id: 't1', sections: [] } as unknown as SessionView['displays'][string];

        expect(isPendingView(view)).toBe(true);

        applySessionPatch(view, {
            status: 'idle',
            queueDepth: 0,
            model: 'm2',
            agentModels: { instruct: 'm2' },
            lastError: 'the provider refused the request',
            actions: [{ id: 'a1' }]
        } as unknown as Parameters<typeof applySessionPatch>[1]);

        // Session facts: replaced, exactly as stated.
        expect(view.status).toBe('idle');
        expect(view.queueDepth).toBe(0);
        expect(view.model).toBe('m2');
        expect(view.agentModels).toEqual({ instruct: 'm2' });
        expect(view.lastError).toBe('the provider refused the request');
        expect((view as unknown as { actions?: unknown[] }).actions).toEqual([{ id: 'a1' }]);

        // Rows, figures and trees: untouched. This is the whole T44 defect — a metadata read
        // applied as a document deleted the row (and tombstoned it), which left the board
        // empty, the tally blank and the pill stuck.
        const row = view.turns[0] as TurnSummary & Record<string, unknown>;

        expect(view.turns).toHaveLength(1);
        expect(row.id).toBe('t1');
        expect(row.status).toBe('running');
        expect(row.state).toBe('streaming');
        expect(row.usage).toEqual({ input: 48, output: 18, total: 66, cached: 0 });
        expect(row.cachedInput).toBe(0);
        expect(Object.keys(view.displays)).toEqual(['t1']);
        // `olderCursor` is a display-plane field (the protocol document type does not name
        // it), and it is one of the three things a session patch may never move.
        expect((view as unknown as { olderCursor?: string | null }).olderCursor).toBeNull();

        // The pill keeps its authority: pending comes from the rows the patch cannot touch.
        expect(isPendingView(view)).toBe(true);

        upsertSummary(view, rowDone as unknown as TurnSummary);

        expect(isPendingView(view)).toBe(false);
    });

    it('states nothing about a figure the patch omits', () => {
        const view = blankView();

        view.model = 'm1';
        view.status = 'running';

        applySessionPatch(view, { model: '', queueDepth: undefined } as unknown as Parameters<typeof applySessionPatch>[1]);

        // An empty model string is "not stated", never "the model is gone"; the running
        // session status survives a patch that says nothing about it.
        expect(view.model).toBe('m1');
        expect(view.status).toBe('running');
        expect(view.queueDepth).toBeUndefined();
    });
});

describe('the live row merge', () => {
    // Case 5: the receipt row is a placeholder, never an authority.
    it('lets a stamped server row replace an optimistic receipt row', () => {
        const view = blankView();
        const receipt = {
            id: 't1',
            index: -1,
            prompt: 'say hi',
            promptPreview: 'say hi',
            promptChars: 6,
            promptIsPreview: false,
            status: 'queued',
            state: 'queued',
            // The receipt is stamped with the BROWSER's clock, which is ahead of every row
            // the server has published for that turn.
            updatedAt: Number.MAX_SAFE_INTEGER,
            sectionCount: 0,
            stepCount: 0,
            activeAgents: [],
            blocks: [],
            optimistic: true
        } as unknown as TurnSummary;

        upsertSummary(view, receipt);
        upsertSummary(view, rowDone as unknown as TurnSummary);

        const row = view.turns[0] as TurnSummary & Record<string, unknown>;

        expect(view.turns).toHaveLength(1);
        expect(row.optimistic).toBeUndefined();
        expect(row.status).toBe('done');
        expect(row.index).toBe(0);
        expect(row.usage).toEqual({ input: 144, output: 40, total: 184, cached: 48 });

        // The monotonic rule still holds for REAL rows: a strictly older answer for the
        // same turn is a late response and is dropped.
        upsertSummary(view, { ...rowDone, status: 'queued', updatedAt: 2_300 } as unknown as TurnSummary);

        expect((view.turns[0] as TurnSummary).status).toBe('done');
    });
});

// The raw recorded frames still bridge to the same canonical payloads; this is the shape a
// shell fixture pushes (a `SessionStreamItem`), asserted against the wire the client reads.
describe('the raw frame bridge', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('turns a recorded event frame into one display.ops payload for its turn', async () => {
        const host = snapshotOf('running', [turnOf('t1', 0, 'running')]);
        stubFetch(() => host);

        const seen: SessionStreamItem[] = [];
        const live = installHarnessStream({ sessionId: 's1', snapshot: () => host });
        const controller = new AbortController();
        const items: ViewStreamItem[] = [];

        void observeView('s1', (item) => items.push(item), controller.signal);
        await subscribed(live, 'session');

        const eventFrame = {
            type: 'event',
            turnId: 't1',
            at: T + 50,
            event: { type: 'usage', agent: 'instruct', usage: { input: 48, output: 18, total: 66, cached: 0 } }
        } as unknown as SessionStreamItem;

        seen.push(eventFrame);
        expect(live.push(eventFrame)).toBe(true);
        await settle();

        // One raw `usage` event becomes the turn's flow frame — never a row, never a
        // document — and the client projects it into the render model's op.
        expect(items.map((item) => item.type)).toEqual(['ops']);
        expect((items[0] as Extract<ViewStreamItem, { type: 'ops' }>).turnId).toBe('t1');
        expect(seen).toHaveLength(1);

        controller.abort();
        live.close();
    });
});

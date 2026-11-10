/**
 * Live scratch-board panels tests (records-panels.ts).
 *
 * Mounts `harness.tasks` and `harness.records` against a panel host whose REST reads and
 * realtime plane are doubles, and pins what the reader and an assistive technology
 * actually get: the five states on `data-phase`, the exact row and feed markup (a task
 * row is a tick-or-cross mark, its text, and a button that opens the rest), the
 * shared ONE session registration, live add/complete/reopen/remove arriving over the
 * wake, the "just landed" and FLIP bookkeeping, the frozen reading position with its
 * "N new" pill, the collection chips and their footer honesty, the row-opened detail
 * (full text, meta line and per-record history), the batched announcements, the records panel's collapse gate (closed by
 * default, no read and no registration while closed), and a teardown that leaves no
 * registration, no timer and no paint behind.
 *
 * Run: npx vitest run --config src/frontend/vitest.config.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import type {
    RecordChangeRow,
    RecordsDeltaResponse,
    RecordsSnapshotResponse
} from '../../shared/harness-api';
import type { WsSubscriptionState, WsUpdateRecords } from '../../shared/harness-stream';
import { clearShellPanels, listShellPanels } from './shell-panels';
import { createPanelContext } from './context';
import type { PanelApiOverrides, PanelContext, PanelSubscribe, PanelSubscriptionSpec } from './context';
import { releaseRecordsWake } from './records-wake';
import {
    HARNESS_RECORDS_PANEL_ID,
    HARNESS_TASKS_PANEL_ID,
    mountRecordsPanel,
    mountTasksPanel,
    recordsPanelPhaseOf,
    recordsSyncLineOf,
    type RecordsPanelOptions
} from './records-panels';
import type { RecordsClient } from './records-client';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const AT = '2026-11-10T09:00:00.000Z';
const LATER = '2026-11-10T09:05:00.000Z';
// Five minutes after `AT`, which is what every relative stamp in these tests reads.
const NOW = Date.parse(AT) + 5 * 60_000;

const TASK_FIELDS = [
    { key: 'text', type: 'text' as const, required: true },
    { key: 'completed', type: 'boolean' as const, required: true }
];

// The store both panels start from: two tasks (one finished) and one chapter, so the
// tasks projection, the mixed feed and the chips all have real material to draw.
const SNAPSHOT: RecordsSnapshotResponse = {
    session_id: 'sess_a',
    revision: 3,
    store_rev: 2,
    collections_rev: 1,
    collections: [
        {
            name: 'tasks',
            store_rev: 2,
            count: 2,
            fields: TASK_FIELDS,
            entries: [
                { id: 'rec_b', rev: 0, text: 'Write the tests', completed: false, updated_at: AT },
                { id: 'rec_a', rev: 1, text: 'Ship it', completed: true, updated_by: 'agent', updated_thread_id: 'ses_1', updated_at: AT }
            ]
        },
        {
            name: 'chapters',
            store_rev: 1,
            count: 1,
            fields: [{ key: 'title', type: 'text' as const, required: true }],
            entries: [{ id: 'rec_c', rev: 0, title: 'Opening' }]
        }
    ],
    changes: [
        { seq: 1, collection: 'tasks', rev: 1, id: 'rec_a', op: 'update', fields: ['completed'], item_rev: 1, at: AT, by: 'agent', thread_id: 'ses_1' },
        { seq: 2, collection: 'chapters', rev: 1, id: 'rec_c', op: 'add', fields: ['title'], item_rev: 0, at: AT }
    ]
};

const EMPTY_SNAPSHOT: RecordsSnapshotResponse = {
    session_id: 'sess_a',
    revision: 0,
    store_rev: 0,
    collections_rev: 1,
    collections: [{ name: 'tasks', store_rev: 0, count: 0, fields: TASK_FIELDS, entries: [] }],
    changes: []
};

const deltaOf = (rows: RecordChangeRow[], collectionsRev = 1): RecordsDeltaResponse => ({
    session_id: 'sess_a',
    revision: 10,
    store_rev: rows.length === 0 ? 0 : (rows[rows.length - 1]?.seq as number),
    collections_rev: collectionsRev,
    changes: rows,
    reset: false
});

type Backend = {
    api: PanelApiOverrides;
    reads: { kind: 'snapshot' | 'delta'; sessionId: string; since: number | null }[];
    /** Queues rows for the next delta read, the way the store appends them. */
    push: (...rows: RecordChangeRow[]) => void;
    setSnapshot: (next: RecordsSnapshotResponse) => void;
    /** Makes the next N snapshot reads reject — how `error` and `stale` are reached. */
    failSnapshots: (count: number) => void;
    /** Makes the next N delta reads reject. */
    failDeltas: (count: number) => void;
    /** Parks the next snapshot reads until `release()` answers them. */
    holdSnapshots: (on: boolean) => void;
    release: () => void;
    snapshotReads: () => number;
    deltaReads: () => number;
};

/**
 * The REST half of the host: the two reads a panel calls through `PanelContext.api`.
 * Both panels of a fixture share one backend (one store, two readers), which is what
 * makes "one panel's failure stays local" and "two bounded reads per burst" assertable.
 */
const createBackend = (initial: RecordsSnapshotResponse = SNAPSHOT): Backend => {
    const reads: Backend['reads'] = [];
    let snapshot = initial;
    let queue: RecordChangeRow[] = [];
    let failSnapshot = 0;
    let failDelta = 0;
    let held = false;
    let waiting: (() => void)[] = [];

    return {
        reads,
        push: (...rows) => {
            queue = [...queue, ...rows];
        },
        setSnapshot: (next) => {
            snapshot = next;
        },
        failSnapshots: (count) => {
            failSnapshot = count;
        },
        failDeltas: (count) => {
            failDelta = count;
        },
        holdSnapshots: (on) => {
            held = on;
            if (!on) return;
            waiting = [];
        },
        release: () => {
            const pending = waiting;

            waiting = [];

            for (const answer of pending) answer();
        },
        snapshotReads: () => reads.filter((read) => read.kind === 'snapshot').length,
        deltaReads: () => reads.filter((read) => read.kind === 'delta').length,
        api: {
            readRecordsSnapshot: (sessionId: string) =>
                new Promise<RecordsSnapshotResponse>((resolve, reject) => {
                    reads.push({ kind: 'snapshot', sessionId, since: null });

                    const answer = (): void => {
                        if (failSnapshot > 0) {
                            failSnapshot -= 1;
                            reject(new Error('the record store is not readable right now'));

                            return;
                        }

                        resolve(snapshot);
                    };

                    if (held) waiting.push(answer);
                    else answer();
                }),
            readRecordsDelta: (sessionId: string, since: number) =>
                new Promise<RecordsDeltaResponse>((resolve, reject) => {
                    reads.push({ kind: 'delta', sessionId, since });

                    if (failDelta > 0) {
                        failDelta -= 1;
                        reject(new Error('the delta read timed out'));

                        return;
                    }

                    const rows = queue;

                    queue = [];

                    // A real delta answers with the store's CURRENT position even when
                    // nothing arrived. Reporting 0 for an empty batch would leave the
                    // client chasing events that do not exist (one extra read per wake).
                    const arrived = rows.length === 0 ? 0 : (rows[rows.length - 1]?.seq as number);

                    resolve({ ...deltaOf(rows, snapshot.collections_rev), store_rev: Math.max(arrived, snapshot.store_rev) });
                })
        }
    };
};

type Timers = {
    schedule: NonNullable<RecordsPanelOptions['schedule']>;
    armed: { run: () => void; delayMs: number }[];
    /** Fires every callback armed for one delay, in arming order. */
    fire: (delayMs: number) => void;
    fireAll: () => void;
    delays: () => number[];
};

// The panel's every timer is captured rather than armed: the announcer's coalescing
// announcer's coalescing window, the FLIP frames and the freshness expiry are then
// things a test triggers, never things it waits for.
const createTimers = (): Timers => {
    const armed: { run: () => void; delayMs: number }[] = [];

    return {
        armed,
        schedule: (run, delayMs) => {
            armed.push({ run, delayMs });
        },
        fire: (delayMs) => {
            for (const entry of armed.filter((item) => item.delayMs === delayMs)) entry.run();
        },
        fireAll: () => {
            for (const entry of [...armed]) entry.run();
        },
        delays: () => armed.map((entry) => entry.delayMs)
    };
};

type Seam = {
    subscribe: PanelSubscribe;
    specs: PanelSubscriptionSpec[];
    unsubscribed: string[];
    /** `records.updated`, fanned to every registration exactly as the hub does it. */
    wake: (storeRev: number, collectionsRev?: number) => void;
    baseline: (state: WsSubscriptionState) => void;
    gap: (reason: 'frames_dropped' | 'cursor_expired', resources?: number) => void;
    refuse: (message: string) => void;
};

const createSeam = (): Seam => {
    const specs: PanelSubscriptionSpec[] = [];
    const unsubscribed: string[] = [];

    const subscribe: PanelSubscribe = (spec) => {
        specs.push(spec);

        const id = `sub_${specs.length}`;

        return { id, spec, cursor: null, sequence: 0, unsubscribe: () => unsubscribed.push(id) };
    };

    return {
        subscribe,
        specs,
        unsubscribed,
        wake: (storeRev, collectionsRev = 1) => {
            const frame: WsUpdateRecords = {
                type: 'update',
                subscription_id: 'sub_1',
                sequence: 1,
                cursor: 'c1',
                kind: 'records.updated',
                at: NOW,
                records: { store_rev: storeRev, collections_rev: collectionsRev }
            };

            for (const spec of specs) spec.onUpdate?.(frame);
        },
        baseline: (state) => {
            for (const spec of specs) spec.onState?.(state);
        },
        gap: (reason, resources = 0) => {
            const frame = {
                type: 'resync_required' as const,
                subscription_id: 'sub_1',
                reason,
                epoch: 'epoch-2',
                cursor: 'c9',
                resources: Array.from({ length: resources }, () => ({
                    resource: 'records' as const,
                    id: 'sess_a',
                    revision: 9,
                    epoch: 'epoch-2',
                    link: '/v1/harness/sessions/sess_a/records'
                }))
            };

            for (const spec of specs) spec.onResync?.(frame);
        },
        refuse: (message) => {
            for (const spec of specs) spec.onError?.({ type: 'error', code: 'unknown_resource', message, retryable: false });
        }
    };
};

type Host = {
    element: HTMLElement;
    controller: ReturnType<typeof createPanelContext>;
    backend: Backend | null;
    seam: Seam;
    timers: Timers;
    /** Drains the microtask chain the async read doubles start. */
    settle: () => Promise<void>;
    dispose: () => void;
    /**
     * Rewrites the session this host's context reports. The runtime moves the session
     BEFORE it notifies (./runtime.ts:186-196), so a host that only notified would be
     lying about which conversation is on screen.
     */
    setSession: (sessionId: string | null) => void;
    query: <T extends HTMLElement = HTMLElement>(selector: string) => T | null;
    queryAll: <T extends HTMLElement = HTMLElement>(selector: string) => T[];
    text: (selector: string) => string;
    phase: () => string | undefined;
};

type HostOptions = {
    id?: string;
    mount: (ctx: PanelContext, options?: RecordsPanelOptions) => void;
    backend?: Backend;
    /** Replaces the reads entirely (the missing-read host passes an empty surface). */
    api?: PanelApiOverrides;
    seam?: Seam;
    sessionId?: string | null;
    bodyRefreshMs?: number;
};

/**
 * One panel, one host element, one panel context: the three pieces the shell's runtime
 * assembles, without its diffing. `subscribe` is handed to the context BY REFERENCE, so
 * two hosts built on the same seam share one wake registration — the isolation rule
 * under test.
 */
const createHost = (options: HostOptions): Host => {
    const backend = options.backend ?? (options.api === undefined ? createBackend() : null);
    const seam = options.seam ?? createSeam();
    const timers = createTimers();
    const element = document.createElement('div');
    let sessionId = options.sessionId === undefined ? 'sess_a' : options.sessionId;

    element.className = 'panel';
    document.body.append(element);

    const controller = createPanelContext({
        id: options.id ?? HARNESS_TASKS_PANEL_ID,
        slot: 'scratch',
        element,
        sessionId: () => sessionId,
        api: options.api ?? backend?.api ?? {},
        subscribe: seam.subscribe
    });

    options.mount(controller.context, {
        now: () => NOW,
        schedule: timers.schedule,
        // Long enough that the 30s clock tick never fires inside a test.
        tickMs: 60 * 60_000,
        clientOptions: { bodyRefreshMs: options.bodyRefreshMs ?? 0 }
    });

    return {
        element,
        controller,
        backend,
        seam,
        timers,
        settle: async () => {
            for (let pass = 0; pass < 12; pass += 1) await Promise.resolve();
        },
        dispose: () => {
            controller.dispose();
            element.remove();
        },
        setSession: (next) => {
            sessionId = next;
        },
        query: (selector) => element.querySelector<HTMLElement>(selector),
        queryAll: (selector) => [...element.querySelectorAll<HTMLElement>(selector)],
        text: (selector) => element.querySelector<HTMLElement>(selector)?.textContent ?? '',
        phase: () => element.querySelector<HTMLElement>('[data-phase]')?.dataset.phase
    };
};

const tasksHost = (options: Omit<HostOptions, 'mount'> = {}): Host =>
    createHost({ mount: (ctx, opts) => mountTasksPanel(ctx, opts), ...options });

const recordsHost = (options: Omit<HostOptions, 'mount'> = {}): Host =>
    createHost({ mount: (ctx, opts) => mountRecordsPanel(ctx, opts), id: HARNESS_RECORDS_PANEL_ID, ...options });

// The records panel ships COLLAPSED (./records-panels.ts): every test below that pins
// feed behaviour opens the card first, the way a reader does. A plain `.click()` — the
// same dispatch the chip tests use — is the whole gesture; `settle` drains the boot
// the expansion starts.
const expandRecords = async (host: Host): Promise<void> => {
    const toggle = host.query<HTMLButtonElement>('button[data-panel-toggle="records"]');

    if (toggle === null) throw new Error('the records panel has no collapse toggle');

    toggle.click();
    await host.settle();
};

// Fakes for the two pure derivations: a client is a bag of getters, so the RULES are
// what these tests pin, not the store they normally read from.
const fakeClient = (over: { phase?: string; stale?: boolean; error?: string; link?: string; lastSync?: number } = {}): RecordsClient => ({
    phase: () => over.phase ?? 'ready',
    stale: () => over.stale ?? false,
    error: () => over.error,
    linkState: () => over.link ?? 'live',
    lastSyncAt: () => over.lastSync ?? NOW,
    feed: () => [],
    collections: () => []
}) as unknown as RecordsClient;

afterEach(() => {
    releaseRecordsWake();
    clearShellPanels();
});

// -----------------------------------------------------------------------------
// The five states, derived and published
// -----------------------------------------------------------------------------

describe('records panel phase derivation', () => {
    it('names loading, error, stale, empty and ready in that precedence', () => {
        expect(recordsPanelPhaseOf(fakeClient({ phase: 'loading' }), 4)).toBe('loading');
        // Nothing on screen: the failure IS the state.
        expect(recordsPanelPhaseOf(fakeClient({ phase: 'error' }), 0)).toBe('error');
        // Rows are worth keeping: a failed re-read of a populated panel is stale.
        expect(recordsPanelPhaseOf(fakeClient({ phase: 'error' }), 2)).toBe('stale');
        expect(recordsPanelPhaseOf(fakeClient({ stale: true }), 3)).toBe('stale');
        // `count` is the CALLING panel's projection, so emptiness belongs to the panel.
        expect(recordsPanelPhaseOf(fakeClient(), 0)).toBe('empty');
        expect(recordsPanelPhaseOf(fakeClient(), 1)).toBe('ready');
    });

    it('states the sync line as when the data last landed and what is wrong with it now', () => {
        expect(recordsSyncLineOf(fakeClient({ lastSync: 0 }), NOW)).toBe('never read');
        expect(recordsSyncLineOf(fakeClient(), NOW)).toBe('updated just now');
        expect(recordsSyncLineOf(fakeClient({ stale: true }), NOW)).toBe('updated just now · may be out of date');
        expect(recordsSyncLineOf(fakeClient({ link: 'down', stale: true }), NOW)).toBe('updated just now · realtime disconnected');
        // A failed re-read names its reason, even while the rows on screen stay usable.
        expect(recordsSyncLineOf(fakeClient({ stale: true, error: 'the delta read timed out' }), NOW)).toBe(
            'updated just now · read failed: the delta read timed out'
        );
        expect(recordsSyncLineOf(fakeClient({ phase: 'error', error: 'boom', lastSync: 0 }), NOW)).toBe('never read · read failed: boom');
    });
});

// -----------------------------------------------------------------------------
// harness.tasks — the states
// -----------------------------------------------------------------------------

describe('harness.tasks — the five states', () => {
    it('mounts the title as the control, pre-mounts the live region, and reads as loading', async () => {
        const backend = createBackend();

        backend.holdSnapshots(true);
        const host = tasksHost({ backend });
        await host.settle();

        // THE HEADING IS THE CONTROL, and it is the card's first child: a live card reads
        // title-then-body exactly as a tool card does, and the title is a real `<button>`
        // wearing the heading's own class (./records-panels.ts `titleToggleOf`).
        const toggle = host.query<HTMLButtonElement>('button[data-panel-toggle="tasks"]');

        expect(host.element.firstElementChild).toBe(toggle);
        expect(toggle?.tagName).toBe('BUTTON');
        expect(toggle?.className).toBe('panel-title panel-title-toggle');
        expect(toggle?.textContent).toBe('Tasks');
        expect(toggle?.getAttribute('type')).toBe('button');
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        expect(toggle?.getAttribute('aria-controls')).toBe(host.query('.panel-tasks-body')?.id);

        // The live region is next, and it is there before any content moves: a region that
        // appears with its own text may never be registered by AT.
        expect(host.element.children[1]).toBe(host.query('.panel-live'));
        expect(host.query('.panel-live')?.getAttribute('role')).toBe('status');
        expect(host.query('.panel-live')?.getAttribute('aria-live')).toBe('polite');
        expect(host.query('.panel-live')?.getAttribute('aria-atomic')).toBe('false');

        const body = host.query<HTMLElement>('.panel-tasks-body');

        expect(body?.dataset.phase).toBe('loading');
        expect(body?.getAttribute('aria-busy')).toBe('true');
        expect(host.text('.panel-tasks-status')).toBe('0 tasks · 0 completed · 0 open');

        // LOADING is one word in a box that was already on screen. Nothing is inserted
        // over the list, so there is no delay to wait for and no block of bars to swap in
        // and out — that swap is what made the tile flicker every time a read came and
        // went, and it is why no timer is armed behind the box at all.
        const box = host.query<HTMLElement>('.panel-status') as HTMLElement;

        expect(box).not.toBeNull();
        expect(box.hidden).toBe(false);
        expect(box.textContent).toBe('reading');
        expect(box.dataset.state).toBe('loading');
        expect(host.query('[data-role="skeleton"]')).toBeNull();

        backend.holdSnapshots(false);
        backend.release();
        await host.settle();

        // The SAME element, one new word: never removed, never re-added.
        expect(host.query('.panel-status')).toBe(box);
        expect(box.dataset.state).toBe('ready');
        expect(box.textContent).toBe('live');
        expect(body?.dataset.phase).toBe('ready');
        expect(body?.getAttribute('aria-busy')).toBe('false');
        expect(host.text('.panel-tasks-sync')).toBe('updated just now');
        expect(host.query<HTMLElement>('.panel-tasks-sync')?.hidden).toBe(true);
    });

    it('paints the progress bar, the two groups and a row that is a mark, a sentence and a control', async () => {
        const host = tasksHost();
        await host.settle();

        expect(host.phase()).toBe('ready');
        expect(host.text('.panel-tasks-status')).toBe('2 tasks · 1 completed · 1 open');

        const bar = host.query<HTMLElement>('.panel-tasks-bar');

        expect(bar?.getAttribute('role')).toBe('progressbar');
        expect(bar?.getAttribute('aria-valuenow')).toBe('50');
        expect(bar?.getAttribute('aria-valuemin')).toBe('0');
        expect(bar?.getAttribute('aria-valuemax')).toBe('100');
        // The figure an assistive tech hears and the share the stylesheet draws: one number.
        expect(bar?.style.getPropertyValue('--records-progress')).toBe('50%');

        const pending = host.query<HTMLElement>('ol[data-group="pending"]');
        const done = host.query<HTMLElement>('ol[data-group="done"]');

        expect(pending?.getAttribute('aria-label')).toBe('Pending tasks');
        expect(done?.getAttribute('aria-label')).toBe('Completed tasks');
        expect(pending?.getAttribute('data-count')).toBe('1');
        expect(done?.getAttribute('data-count')).toBe('1');
        expect(pending?.getAttribute('aria-busy')).toBe('false');
        expect(host.text('.panel-tasks-done-count')).toBe('1');

        const row = pending?.querySelector<HTMLElement>('li.panel-tasks-row');

        expect(row?.dataset.id).toBe('rec_b');
        expect(row?.dataset.rowKey).toBe('rec_b');
        expect(row?.dataset.completed).toBe('false');

        // THE COLLAPSED ROW IS TWO NODES: the control, and the detail area it opens
        // (empty while it is closed). The row itself carries no actor, no `#id`, no
        // `r{rev}`, no stamp and no state WORD — those are what pressing it buys.
        expect([...(row?.children ?? [])].map((node) => (node as HTMLElement).className)).toEqual([
            'panel-tasks-row-head',
            'panel-tasks-detail'
        ]);

        const head = row?.querySelector('button.panel-tasks-row-head') as HTMLButtonElement;
        const detail = row?.querySelector('div.panel-tasks-detail') as HTMLElement;

        expect([...(head?.querySelectorAll<HTMLElement>(':scope > *') ?? [])].map((node) => node.className)).toEqual([
            'panel-tasks-glyph',
            'panel-tasks-row-state',
            'panel-tasks-row-text'
        ]);
        // A real `<button>`: Enter and Space arrive as a click with no key handler of
        // our own, and `aria-expanded` is the disclosure's own state.
        expect(head?.tagName).toBe('BUTTON');
        expect(head?.type).toBe('button');
        expect(head?.getAttribute('aria-expanded')).toBe('false');
        // `aria-controls` names THIS row's detail, and the id is unique in the document
        // (./records-panels.ts `tasksDetailSequence`) even with two panels mounted.
        expect(head?.getAttribute('aria-controls')).toBe(detail?.id);
        expect(detail?.id.length).toBeGreaterThan(0);
        expect(document.getElementById(detail?.id as string)).toBe(detail);
        expect(detail?.hidden).toBe(true);
        expect(detail?.children).toHaveLength(0);
        // One control per row, and none of it looks like a checkbox it cannot press.
        expect(row?.querySelectorAll('button')).toHaveLength(1);
        expect(row?.querySelectorAll('input, [role="checkbox"]')).toHaveLength(0);

        // The cross: open is "not done", not an error, and the glyph is decorative.
        expect(head.querySelector('.panel-tasks-glyph')?.textContent).toBe('✕');
        expect(head.querySelector('.panel-tasks-glyph')?.getAttribute('aria-hidden')).toBe('true');
        expect(head.querySelector('.panel-tasks-glyph')?.dataset.completed).toBe('false');
        // The WORD is gone from the row and still in the accessible name: clipped, in
        // the button, so the state never rides on colour or shape alone.
        expect(head.querySelector('.panel-tasks-row-state')?.textContent).toBe('open');
        expect(head.querySelector('.panel-tasks-row-text')?.textContent).toBe('Write the tests');
        expect(row?.textContent).not.toContain('[open]');
        expect(row?.querySelector('.panel-tasks-state')).toBeNull();
        expect(row?.querySelector('.panel-tasks-id')).toBeNull();
        expect(row?.querySelector('.panel-tasks-actor')).toBeNull();
        expect(row?.querySelector('time')).toBeNull();

        // --- the detail a press buys -----------------------------------------
        // `.click()` is the whole gesture; in a browser an Enter or Space keypress on
        // the focused button performs this same activation.
        head.click();

        expect(head.getAttribute('aria-expanded')).toBe('true');
        expect(detail.hidden).toBe(false);
        // No word-glyph appeared with it either — the row's own text is still a mark
        // and a sentence, and the meta below is the only thing that changed.
        expect(detail.querySelector('.panel-tasks-id')?.textContent).toBe('#rec_b');
        expect(detail.querySelector('.panel-tasks-rev')?.textContent).toBe('r0');
        expect(detail.querySelector('.panel-tasks-detail-text')).toBeNull();

        // No attribution in the store means the neutral actor, never an invented name.
        const actor = detail.querySelector('.panel-tasks-actor') as HTMLElement;

        expect(actor.textContent).toBe('system');
        expect(actor.dataset.actor).toBe('system');

        const stamp = detail.querySelector('time') as HTMLElement;

        expect(stamp.tagName).toBe('TIME');
        expect(stamp.getAttribute('datetime')).toBe(AT);
        expect(stamp.title).toBe(AT);
        expect(stamp.textContent).toBe('5m');

        head.click();

        // Closing takes the content with it: the rail is exactly as tall as it was.
        expect(head.getAttribute('aria-expanded')).toBe('false');
        expect(detail.hidden).toBe(true);
        expect(detail.children).toHaveLength(0);
        expect(row.querySelector('.panel-tasks-id')).toBeNull();

        const doneRow = done?.querySelector<HTMLElement>('li.panel-tasks-row');

        expect(doneRow?.dataset.id).toBe('rec_a');
        expect(doneRow?.dataset.completed).toBe('true');
        expect(doneRow?.querySelector('.panel-tasks-glyph')?.textContent).toBe('✓');
        expect(doneRow?.querySelector('.panel-tasks-row-state')?.textContent).toBe('completed');
        expect(doneRow?.textContent).not.toContain('[done]');
        expect(doneRow?.querySelector('div.panel-tasks-detail')?.hidden).toBe(true);

        (doneRow?.querySelector('button.panel-tasks-row-head') as HTMLButtonElement).click();

        expect(doneRow?.querySelector('.panel-tasks-actor')?.textContent).toBe('agent');
        expect(doneRow?.querySelector('.panel-tasks-actor')?.dataset.actor).toBe('agent');
        expect(doneRow?.querySelector('.panel-tasks-rev')?.textContent).toBe('r1');

        host.dispose();
    });

    it('opens a row for the whole text the collapsed preview had to cut short', async () => {
        // 376 characters: a task is allowed 4000 (../shared/harness-api.ts), and the
        // rail shows `RECORDS_TEXT_PREVIEW` of them. The tail is the reason the reader
        // presses, so it is exactly what the detail area owes them.
        const longText = 'Draft the migration notes for the record store. '.repeat(8);
        const backend = createBackend({
            ...SNAPSHOT,
            collections: [
                {
                    ...(SNAPSHOT.collections[0] as (typeof SNAPSHOT.collections)[number]),
                    count: 1,
                    entries: [{ id: 'rec_e', rev: 0, text: longText, completed: false, updated_at: AT }]
                },
                SNAPSHOT.collections[1] as (typeof SNAPSHOT.collections)[number]
            ]
        });
        const host = tasksHost({ backend });

        await host.settle();

        const row = taskRowOf(host, 'rec_e') as HTMLElement;
        const preview = row.querySelector('.panel-tasks-row-text') as HTMLElement;

        expect(preview.textContent).toBe(`${longText.slice(0, 220)}…`);
        expect(preview.title).toBe(longText);

        const head = row.querySelector('button.panel-tasks-row-head') as HTMLButtonElement;

        head.click();

        // The full text, untruncated and un-titled, beside the meta line.
        expect(row.querySelector('.panel-tasks-detail-text')?.textContent).toBe(longText);
        expect(row.querySelector('.panel-tasks-detail-meta')?.textContent).toBe('system#rec_er05m');

        host.dispose();
    });

    it('calls an empty store empty, and does not offer a retry for something that never failed', async () => {
        const host = tasksHost({ backend: createBackend(EMPTY_SNAPSHOT) });
        await host.settle();

        expect(host.phase()).toBe('empty');
        expect(host.text('.panel-tasks-empty')).toBe('No tasks yet. This list fills when an agent writes to the session task store.');
        expect(host.query('.panel-tasks-empty')?.getAttribute('data-state')).toBe('empty');
        expect(host.query('.panel-tasks-empty button')).toBeNull();
        expect(host.query('ol[data-group="pending"]')?.parentElement?.hasAttribute('hidden')).toBe(true);
        expect(host.query('ol[data-group="done"]')?.parentElement?.hasAttribute('hidden')).toBe(true);
        expect(host.text('.panel-tasks-status')).toBe('0 tasks · 0 completed · 0 open');
        expect(host.query('.panel-tasks-bar')?.style.getPropertyValue('--records-progress')).toBe('0%');

        host.dispose();
    });

    it('names a failed read, offers a real retry, and recovers when the reader takes it', async () => {
        const backend = createBackend();

        backend.failSnapshots(1);
        const host = tasksHost({ backend });
        await host.settle();

        expect(host.phase()).toBe('error');
        expect(host.text('.panel-tasks-error')).toBe('The task store could not be read: the record store is not readable right now.Retry');
        expect(host.query('.panel-tasks-error')?.getAttribute('data-state')).toBe('error');

        const button = host.query<HTMLElement>('.panel-tasks-error button');

        expect(button?.textContent).toBe('Retry');
        expect(button?.getAttribute('type')).toBe('button');
        expect(host.query('ol[data-group="pending"]')?.parentElement?.hasAttribute('hidden')).toBe(true);
        expect(host.text('.panel-tasks-sync')).toBe('never read · read failed: the record store is not readable right now');
        expect(host.backend?.snapshotReads()).toBe(1);

        button?.dispatchEvent(new Event('click', { bubbles: true }));
        await host.settle();

        expect(host.phase()).toBe('ready');
        expect(host.backend?.snapshotReads()).toBe(2);
        expect(host.queryAll('.panel-tasks-row')).toHaveLength(2);

        host.dispose();
    });

    it('keeps the rows it has and reads as stale when a wake cannot be answered', async () => {
        const backend = createBackend();
        const host = tasksHost({ backend });
        await host.settle();

        backend.failDeltas(1);
        host.seam.wake(3);
        await host.settle();

        const body = host.query<HTMLElement>('.panel-tasks-body');

        expect(body?.dataset.phase).toBe('stale');
        expect(body?.getAttribute('aria-busy')).toBe('false');
        // The last honest answer stays on screen; only the note appears.
        expect(host.queryAll('.panel-tasks-row')).toHaveLength(2);
        expect(host.query<HTMLElement>('.panel-tasks-sync')?.hidden).toBe(false);
        expect(host.query<HTMLElement>('.panel-tasks-sync')?.dataset.state).toBe('stale');
        expect(host.text('.panel-tasks-sync')).toBe('updated just now · read failed: the delta read timed out');
        // The retry belongs to the error state; a stale panel keeps its rows and its note.
        expect(host.query('.panel-tasks-sync button')).toBeNull();

        host.seam.wake(3);
        await host.settle();

        expect(host.phase()).toBe('ready');
        expect(host.query<HTMLElement>('.panel-tasks-sync')?.hidden).toBe(true);

        host.dispose();
    });
});

// -----------------------------------------------------------------------------
// harness.records — the states and the feed
// -----------------------------------------------------------------------------

describe('harness.records — the five states', () => {
    it('paints the feed newest-first with the values it can vouch for, and an em-dash for the rest', async () => {
        const host = recordsHost();

        await expandRecords(host);

        const feed = host.query<HTMLElement>('ol.panel-records-feed');

        expect(feed?.getAttribute('aria-label')).toBe('Record changes');
        expect(feed?.getAttribute('data-count')).toBe('2');
        // Newest first: the chapters add (seq 2) sits above the tasks update (seq 1).
        expect(host.queryAll('ol.panel-records-feed > li').map((node) => node.dataset.rowKey)).toEqual(['2', '1']);
        expect(host.queryAll('ol.panel-records-feed > li').map((node) => [node.dataset.collection, node.dataset.id])).toEqual([
            ['chapters', 'rec_c'],
            ['tasks', 'rec_a']
        ]);

        const row = host.query('li[data-row-key="1"]');
        const head = row?.querySelector('.panel-records-row-head');

        expect(row?.dataset.collection).toBe('tasks');
        expect(row?.dataset.id).toBe('rec_a');
        expect([...(head?.children ?? [])].map((node) => node.className)).toEqual([
            'panel-records-actor',
            'panel-records-op',
            'panel-records-collection',
            'panel-records-id',
            'panel-records-text',
            'panel-records-stamp',
            'panel-records-seq'
        ]);
        expect(row?.querySelector('.panel-records-op')?.textContent).toBe('update');
        expect(row?.querySelector('.panel-records-op')?.dataset.op).toBe('update');
        expect(row?.querySelector('.panel-records-text')?.textContent).toBe('Ship it');
        expect(row?.querySelector('.panel-records-collection')?.textContent).toBe('tasks');
        expect(row?.querySelector('.panel-records-id')?.textContent).toBe('#rec_a');
        expect(row?.querySelector('.panel-records-seq')?.textContent).toBe('#1');
        expect(row?.querySelector('.panel-records-actor')?.textContent).toBe('agent');

        // A snapshot row knows the value AFTER the event and not the one before: the
        // before cell is `—` (never an empty cell, which would read as "cleared").
        expect(row?.querySelectorAll<HTMLElement>('ul.panel-records-changes li')).toHaveLength(1);

        const change = row?.querySelector<HTMLElement>('li.panel-records-change');

        expect(change?.textContent).toBe('completed—→true');
        expect([...(change?.children ?? [])].map((node) => node.className)).toEqual([
            'panel-records-change-field',
            'panel-records-change-value',
            'panel-records-change-arrow',
            'panel-records-change-value'
        ]);
        expect(change?.querySelectorAll<HTMLElement>('.panel-records-change-value')[0]?.textContent).toBe('—');
        expect(change?.querySelectorAll<HTMLElement>('.panel-records-change-value')[1]?.textContent).toBe('true');
        expect(change?.querySelector('.panel-records-change-arrow')?.getAttribute('aria-hidden')).toBe('true');

        expect(host.text('.panel-records-footer')).toBe('2 of 2 retained changes');
        expect(host.query('.panel-records-footer')?.getAttribute('data-state')).toBe('live');

        // The chips state their own worth in their own text, next to `aria-pressed`.
        expect(host.query('.panel-records-filters')?.getAttribute('role')).toBe('group');
        expect(host.query('.panel-records-filters')?.getAttribute('aria-label')).toBe('Filter the change feed by collection');
        expect(host.text('.panel-records-filter-label')).toBe('Collections');
        expect(host.queryAll('button.panel-records-chip').map((chip) => [chip.dataset.collection, chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
            ['all', 'All (2)', 'true'],
            ['tasks', 'tasks (1)', 'false'],
            ['chapters', 'chapters (1)', 'false']
        ]);

        host.dispose();
    });

    it('says what the feed is doing in the corner box and in the footer', async () => {
        const backend = createBackend();
        const host = recordsHost({ backend });

        backend.holdSnapshots(true);
        await expandRecords(host);

        expect(host.phase()).toBe('loading');
        expect(host.query('ol.panel-records-feed')?.hasAttribute('hidden')).toBe(true);
        expect(host.text('.panel-records-footer')).toBe('Reading the record store…');

        const box = host.query<HTMLElement>('.panel-status') as HTMLElement;

        expect(box.textContent).toBe('reading');
        expect(box.dataset.state).toBe('loading');
        expect(host.query('[data-role="skeleton"]')).toBeNull();

        backend.holdSnapshots(false);
        backend.release();
        await host.settle();

        // The box that said `reading` is the box that says `live`: one element, one word
        // changed, nothing for the card to resize around.
        expect(host.query('.panel-status')).toBe(box);
        expect(box.dataset.state).toBe('ready');
        expect(box.textContent).toBe('live');
        expect(host.phase()).toBe('ready');
        expect(host.query('ol.panel-records-feed')?.hasAttribute('hidden')).toBe(false);

        host.dispose();
    });

    it('states an empty store, and states a failed read with a retry', async () => {
        const empty = recordsHost({ backend: createBackend(EMPTY_SNAPSHOT) });

        await expandRecords(empty);

        expect(empty.phase()).toBe('empty');
        expect(empty.text('.panel-records-empty')).toBe('No record changes yet. The store fills as agents write — a task created, a chapter saved.');
        expect(empty.text('.panel-records-footer')).toBe('0 of 0 retained changes');
        expect(empty.queryAll('button.panel-records-chip').map((chip) => chip.textContent)).toEqual(['All (0)', 'tasks (0)']);

        const backend = createBackend();

        backend.failSnapshots(1);
        const failed = recordsHost({ backend });

        await expandRecords(failed);

        expect(failed.phase()).toBe('error');
        expect(failed.text('.panel-records-error')).toBe('The record store could not be read: the record store is not readable right now.Retry');
        expect(failed.query('.panel-records-error button')?.textContent).toBe('Retry');

        failed.dispose();
        empty.dispose();
    });

    it('clips an id-shaped failure so a uuid never reaches the rail', async () => {
        const host = recordsHost({
            api: {
                readRecordsSnapshot: () =>
                    Promise.reject(new Error('session 3f2a9c1b-7788-4a11-9d22-112233445566 has no readable record store')),
                readRecordsDelta: () => Promise.resolve(deltaOf([]))
            }
        });

        await expandRecords(host);

        expect(host.text('.panel-records-error')).toBe('The record store could not be read: session 3f2a9c1b has no readable record store.Retry');
        expect(host.element.textContent).not.toContain('3f2a9c1b-7788');

        host.dispose();
    });
});

// -----------------------------------------------------------------------------
// The collapse gate: a card the reader has not opened costs the conversation nothing
// -----------------------------------------------------------------------------

describe('harness.records — the collapse gate', () => {
    it('mounts collapsed by default: no read, no registration, body hidden', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = recordsHost({ backend, seam });
        await host.settle();

        const toggle = host.query<HTMLButtonElement>('button[data-panel-toggle="records"]');

        // The gate is the card's own HEADING: the word "Records" is the button, and there
        // is no second "Show records" control under it.
        expect(host.element.firstElementChild).toBe(toggle);
        expect(toggle?.className).toBe('panel-title panel-title-toggle');
        expect(toggle?.getAttribute('type')).toBe('button');
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        expect(toggle?.dataset.expanded).toBe('false');
        expect(toggle?.textContent).toBe('Records');
        expect(toggle?.getAttribute('aria-controls')).toBe(host.query('.panel-records-body')?.id);
        expect(host.queryAll('button.panel-expand')).toHaveLength(0);
        expect(host.query<HTMLElement>('.panel-records-body')?.hidden).toBe(true);
        // A card with no engine has no state to report, so it shows no box either.
        expect(host.query<HTMLElement>('.panel-status')?.hidden).toBe(true);
        // The gate is the whole point: not one request, not one plane slot.
        expect(backend.reads).toEqual([]);
        expect(seam.specs).toEqual([]);

        host.dispose();
    });

    it('opening the card is what boots the engine and registers the wake', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = recordsHost({ backend, seam });

        await expandRecords(host);

        expect(host.phase()).toBe('ready');
        expect(host.query<HTMLElement>('.panel-records-body')?.hidden).toBe(false);
        expect(host.query('button[data-panel-toggle="records"]')?.getAttribute('aria-expanded')).toBe('true');
        // Opening changes `aria-expanded` and the box, never the heading's word: the title
        // is the same title open or shut.
        expect(host.text('button[data-panel-toggle="records"]')).toBe('Records');
        expect(host.text('.panel-status')).toBe('live');
        expect(backend.snapshotReads()).toBe(1);
        expect(seam.specs).toHaveLength(1);
        expect(host.queryAll('ol.panel-records-feed > li')).toHaveLength(2);

        host.dispose();
    });

    it('closing the card releases the wake, and a wake while closed reads nothing', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = recordsHost({ backend, seam });

        await expandRecords(host);

        host.query<HTMLButtonElement>('button[data-panel-toggle="records"]')?.click();
        await host.settle();

        // The last listener let go, so the registration went with the card.
        expect(seam.unsubscribed).toEqual(['sub_1']);
        expect(host.query<HTMLElement>('.panel-records-body')?.hidden).toBe(true);
        expect(host.query('button[data-panel-toggle="records"]')?.getAttribute('aria-expanded')).toBe('false');
        expect(host.queryAll('li.panel-records-row')).toHaveLength(0);
        expect(host.phase()).toBeUndefined();
        // Closed: the corner box goes blank with the surface, rather than claiming a state
        // no read is backing anymore.
        expect(host.query<HTMLElement>('.panel-status')?.hidden).toBe(true);
        expect(host.text('.panel-status')).toBe('');

        // The store keeps moving while the card is closed: not one read answers it.
        const readsBefore = backend.reads.length;

        backend.push({
            seq: 3,
            collection: 'tasks',
            rev: 1,
            id: 'rec_b',
            op: 'update',
            fields: ['completed'],
            item_rev: 1,
            at: LATER,
            by: 'agent'
        });
        host.seam.wake(3);
        await host.settle();

        expect(backend.reads).toHaveLength(readsBefore);

        // Re-opening is a fresh boot, not a resurrection of the rows it dropped.
        host.query<HTMLButtonElement>('button[data-panel-toggle="records"]')?.click();
        await host.settle();

        expect(backend.snapshotReads()).toBe(2);
        expect(host.phase()).toBe('ready');
        expect(host.queryAll('ol.panel-records-feed > li')).toHaveLength(2);

        host.dispose();
    });

    it('opens onto an empty surface with no conversation, and reads the one that arrives', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = recordsHost({ backend, seam, sessionId: null });

        await expandRecords(host);

        // Open but conversationless: the surface is the cleared one, and nothing reads.
        expect(host.query<HTMLElement>('.panel-records-body')?.hidden).toBe(false);
        expect(backend.reads).toEqual([]);
        expect(seam.specs).toEqual([]);

        host.setSession('sess_a');
        host.controller.notifySessionChange('sess_a');
        await host.settle();

        // The open choice is the reader's: a conversation arriving to an OPEN card is
        // read at once, not held back for a second press.
        expect(backend.snapshotReads()).toBe(1);
        expect(seam.specs).toHaveLength(1);
        expect(host.phase()).toBe('ready');

        host.dispose();
    });
});

// -----------------------------------------------------------------------------
// The title is the toggle: the tasks card closes the same way
// -----------------------------------------------------------------------------

describe('harness.tasks — the title as the collapse control', () => {
    it('ships open, closes from its own heading, and holds nothing while shut', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = tasksHost({ backend, seam });

        await host.settle();

        const toggle = host.query<HTMLButtonElement>('button[data-panel-toggle="tasks"]') as HTMLButtonElement;

        // Tasks ships OPEN — it is the card a reader glances at without thinking — but the
        // heading is the control all the same, and it is the ONLY control: no second button
        // under it, the way the records card has none either.
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(host.query<HTMLElement>('.panel-tasks-body')?.hidden).toBe(false);
        expect(host.queryAll('button.panel-expand')).toHaveLength(0);
        expect(host.text('.panel-status')).toBe('live');

        toggle.click();
        await host.settle();

        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.dataset.expanded).toBe('false');
        expect(host.query<HTMLElement>('.panel-tasks-body')?.hidden).toBe(true);
        // Shut: the surface is blank, the corner box included, and the plane let go.
        expect(host.phase()).toBeUndefined();
        expect(host.query<HTMLElement>('.panel-status')?.hidden).toBe(true);
        expect(host.queryAll('li.panel-tasks-row')).toHaveLength(0);
        expect(seam.unsubscribed).toEqual(['sub_1']);

        // The store keeps moving while the card is shut: not one read answers it.
        const readsBefore = backend.reads.length;

        backend.push({
            seq: 3,
            collection: 'tasks',
            rev: 1,
            id: 'rec_b',
            op: 'update',
            fields: ['completed'],
            item_rev: 1,
            at: LATER,
            by: 'agent'
        });
        host.seam.wake(3);
        await host.settle();

        expect(backend.reads).toHaveLength(readsBefore);

        toggle.click();
        await host.settle();

        // Re-opening is a fresh boot, not a resurrection of the rows it dropped.
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(backend.snapshotReads()).toBe(2);
        expect(host.phase()).toBe('ready');
        expect(host.text('.panel-status')).toBe('live');
        expect(host.queryAll('li.panel-tasks-row')).toHaveLength(2);

        host.dispose();
    });
});

// -----------------------------------------------------------------------------
// Isolation: one registration, two independent panels
// -----------------------------------------------------------------------------

describe('the two panels on one conversation', () => {
    it('share ONE session registration and read independently', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const tasks = tasksHost({ backend, seam });
        const records = recordsHost({ backend, seam });

        await tasks.settle();
        await expandRecords(records);

        // Both panels are attached and the plane holds one registration for the pair.
        expect(seam.specs).toHaveLength(1);
        expect(seam.specs[0]).toEqual({
            scope: 'session',
            sessionId: 'sess_a',
            onState: expect.any(Function),
            onUpdate: expect.any(Function),
            onResync: expect.any(Function),
            onError: expect.any(Function)
        });
        // Two bounded REST reads per burst is the accepted price of a panel that can
        // fail alone: the wake is shared, the state is not.
        expect(backend.snapshotReads()).toBe(2);
        expect(tasks.queryAll('.panel-tasks-row')).toHaveLength(2);
        expect(records.queryAll('ol.panel-records-feed > li')).toHaveLength(2);

        tasks.dispose();
        expect(seam.unsubscribed).toEqual([]);

        records.dispose();
        expect(seam.unsubscribed).toEqual(['sub_1']);
    });

    it('a host that supplies no reads fails one panel without touching its neighbour', async () => {
        const seam = createSeam();
        const backend = createBackend();
        // Every member explicitly undefined: the context then has NO default for it
        // (./context.ts `PanelApiOverrides`), which is how a panel is told a capability
        // is deliberately absent.
        const broken = tasksHost({
            seam,
            api: { readRecordsSnapshot: undefined, readRecordsDelta: undefined }
        });
        const healthy = recordsHost({ backend, seam });

        await broken.settle();
        await expandRecords(healthy);

        // A missing read is a rejected read, not a TypeError from inside the client's
        // retry loop: the panel explains itself instead of going blank.
        expect(broken.phase()).toBe('error');
        expect(broken.text('.panel-tasks-error')).toContain('This host does not provide the records snapshot read');
        expect(healthy.phase()).toBe('ready');

        broken.dispose();
        healthy.dispose();
        // The healthy panel was the last to let go, and the registration went with it.
        expect(seam.unsubscribed).toEqual(['sub_1']);
    });

    it('mounts no engine before a conversation exists, and reads the moment one arrives', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = tasksHost({ backend, seam, sessionId: null });

        await host.settle();

        // No session: no engine, no read, no registration on the plane.
        expect(backend.reads).toEqual([]);
        expect(seam.specs).toEqual([]);
        expect(host.phase()).toBeUndefined();
        expect(host.query('.panel-live')).not.toBeNull();

        // The shell moves the conversation BEFORE it notifies; the host does the same.
        host.setSession('sess_a');
        host.controller.notifySessionChange('sess_a');
        await host.settle();

        expect(host.phase()).toBe('ready');
        expect(host.queryAll('.panel-tasks-row')).toHaveLength(2);
        expect(seam.specs).toHaveLength(1);

        host.dispose();
        expect(seam.unsubscribed).toEqual(['sub_1']);
    });

    it('a refused registration is the panel error note, not an exception', async () => {
        const host = tasksHost();
        await host.settle();

        host.seam.refuse('unknown resource records:3f2a9c1b-7788-4a11-9d22-112233445566');
        await host.settle();

        // The rows stay: the store was read, the PLANE is what refused.
        expect(host.phase()).toBe('stale');
        const note = host.text('.panel-tasks-sync');

        expect(note.startsWith('updated just now · realtime disconnected · read failed:')).toBe(true);
        expect(note).toContain('unknown resource records:3f2a9c1b');
        expect(host.element.textContent).not.toContain('3f2a9c1b-7788');

        host.dispose();
    });
});

// -----------------------------------------------------------------------------
// Part 2 — the live half: a wake arrives, the DOM travels, the reader is told
// -----------------------------------------------------------------------------

// The two events an agent produces: a task added, and a task finished. A
// `RecordChangeRow` names WHICH record and WHICH fields — never the values
// (../../shared/harness-api.ts), so the delta alone cannot move a row between groups.
const TASK_ADDED: RecordChangeRow = {
    seq: 3,
    collection: 'tasks',
    rev: 0,
    id: 'rec_d',
    op: 'add',
    fields: ['text', 'completed'],
    item_rev: 0,
    at: LATER
};

const TASK_DONE: RecordChangeRow = {
    seq: 4,
    collection: 'tasks',
    rev: 2,
    id: 'rec_b',
    op: 'update',
    fields: ['completed'],
    item_rev: 2,
    at: LATER,
    by: 'agent'
};

// The same store as the server now sees it: the new task has text, and `rec_b` is
// finished. This is what the ONE debounced snapshot re-read brings back.
const AFTER_TASKS: RecordsSnapshotResponse = {
    session_id: 'sess_a',
    revision: 4,
    store_rev: 4,
    collections_rev: 1,
    collections: [
        {
            name: 'tasks',
            store_rev: 4,
            count: 3,
            fields: TASK_FIELDS,
            entries: [
                { id: 'rec_b', rev: 2, text: 'Write the tests', completed: true, updated_by: 'agent', updated_at: LATER },
                { id: 'rec_a', rev: 1, text: 'Ship it', completed: true, updated_by: 'agent', updated_thread_id: 'ses_1', updated_at: AT },
                { id: 'rec_d', rev: 0, text: 'Land the change', completed: false, updated_at: LATER }
            ]
        },
        {
            name: 'chapters',
            store_rev: 1,
            count: 1,
            fields: [{ key: 'title', type: 'text' as const, required: true }],
            entries: [{ id: 'rec_c', rev: 0, title: 'Opening' }]
        }
    ],
    changes: [...SNAPSHOT.changes, TASK_ADDED, TASK_DONE]
};

// The feed as it looks when the store has already forgotten the oldest events: the
// window starts at seq 5, so `feedTruncated` is the honest answer.
const WINDOWED_SNAPSHOT: RecordsSnapshotResponse = {
    ...SNAPSHOT,
    changes: [
        { ...SNAPSHOT.changes[0] as RecordChangeRow, seq: 5 },
        { ...SNAPSHOT.changes[1] as RecordChangeRow, seq: 6 }
    ]
};

const TASK_REOPENED: RecordChangeRow = {
    seq: 7,
    collection: 'tasks',
    rev: 2,
    id: 'rec_a',
    op: 'update',
    fields: ['completed'],
    item_rev: 2,
    at: LATER,
    by: 'agent'
};

// A record with TWO events behind it, which is what makes an OPENED row carry a
// history (a task with one event has nothing to say beyond the row itself).
const WITH_HISTORY: RecordsSnapshotResponse = {
    ...WINDOWED_SNAPSHOT,
    store_rev: 7,
    collections: [
        {
            ...SNAPSHOT.collections[0] as (typeof SNAPSHOT.collections)[number],
            store_rev: 7,
            entries: [
                { id: 'rec_b', rev: 0, text: 'Write the tests', completed: false, updated_at: AT },
                { id: 'rec_a', rev: 2, text: 'Ship it', completed: false, updated_by: 'agent', updated_at: LATER }
            ]
        },
        SNAPSHOT.collections[1] as (typeof SNAPSHOT.collections)[number]
    ]
};

// Geometry jsdom does not have: a scrollable box, and a row with a height.
const setScrollBox = (element: HTMLElement, scrollHeight: number, clientHeight: number): void => {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight });
};

const setRowHeight = (element: HTMLElement, height: number): void => {
    element.getBoundingClientRect = () =>
        ({ height, top: 0, bottom: height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
};

// What an assistive technology actually hears: the lines the live region holds.
const liveLinesOf = (host: Host): string[] =>
    host.queryAll('.panel-live-line').map((line) => line.textContent as string);

const taskRowOf = (host: Host, id: string): HTMLElement | null =>
    host.query(`li.panel-tasks-row[data-id="${id}"]`);

const feedKeysOf = (host: Host): string[] =>
    host.queryAll('li.panel-records-row').map((row) => row.dataset.rowKey as string);

const chipOf = (host: Host, collection: string): HTMLButtonElement =>
    host.queryAll<HTMLButtonElement>('button.panel-records-chip').find(
        (chip) => chip.dataset.collection === collection
    ) as HTMLButtonElement;

describe('harness.tasks — live updates', () => {
    it('applies a wake as it really happens: identity now, values one re-read later', async () => {
        const backend = createBackend();
        const host = tasksHost({ backend, bodyRefreshMs: 150 });

        await host.settle();

        const rowB = taskRowOf(host, 'rec_b') as HTMLElement;
        const headB = rowB.querySelector('button.panel-tasks-row-head') as HTMLButtonElement;

        // The reader has this row open before it finishes.
        headB.click();
        expect(headB.getAttribute('aria-expanded')).toBe('true');

        backend.push(TASK_ADDED, TASK_DONE);
        backend.setSnapshot(AFTER_TASKS);
        host.seam.wake(4);
        await host.settle();

        // The delta names the two records and nothing else, so the new task is on screen
        // with no text and the finished one is STILL in the pending group: the panel does
        // not guess a value it has not read.
        expect(host.text('.panel-tasks-status')).toBe('3 tasks · 1 completed · 2 open');
        expect(
            [...(host.query('ol[data-group="pending"]')?.children ?? [])].map((row) => (row as HTMLElement).dataset.id)
        ).toEqual(['rec_d', 'rec_b']);

        const rowD = taskRowOf(host, 'rec_d') as HTMLElement;

        expect(rowD.dataset.fresh).toBe('true');
        expect(rowD.querySelector('.panel-tasks-row-text')?.dataset.missing).toBe('true');
        expect(rowD.querySelector('.panel-tasks-row-text')?.getAttribute('aria-label')).toBe(
            'Task rec_d: no text in the last read'
        );

        // One debounced snapshot re-read closes the gap — exactly one, and only because
        // the delta left values unknown (an event-driven retry, never a poll).
        expect(backend.snapshotReads()).toBe(1);
        host.timers.fire(150);
        await host.settle();

        expect(backend.snapshotReads()).toBe(2);
        expect(host.text('.panel-tasks-status')).toBe('3 tasks · 2 completed · 1 open');
        expect(
            [...(host.query('ol[data-group="done"]')?.children ?? [])].map((row) => (row as HTMLElement).dataset.id)
        ).toEqual(['rec_a', 'rec_b']);

        // THE SAME ELEMENT travels between the two groups: focus, selection and an
        // open detail belong to the row the reader was looking at, not to the group.
        expect(taskRowOf(host, 'rec_b')).toBe(rowB);
        expect(rowB.parentElement?.dataset.group).toBe('done');
        expect(rowB.dataset.completed).toBe('true');
        expect(rowB.querySelector('.panel-tasks-glyph')?.textContent).toBe('✓');
        expect(rowB.querySelector('.panel-tasks-row-state')?.textContent).toBe('completed');
        // And it is STILL open: the open-set is keyed by the task id, and a repaint in
        // the other group re-renders the detail rather than closing it.
        expect(rowB.querySelector('button.panel-tasks-row-head')).toBe(headB);
        expect(headB.getAttribute('aria-expanded')).toBe('true');
        expect(rowB.querySelector('div.panel-tasks-detail')?.hidden).toBe(false);
        expect(rowB.querySelector('.panel-tasks-id')?.textContent).toBe('#rec_b');

        // The re-read fills the new row in and does NOT cut its highlight short: the
        // freshness marker's own timer owns the expiry, and 150ms is inside 1500ms.
        expect(rowD.querySelector('.panel-tasks-row-text')?.textContent).toBe('Land the change');
        expect(rowD.querySelector('.panel-tasks-row-text')?.hasAttribute('data-missing')).toBe(false);
        expect(rowD.dataset.fresh).toBe('true');

        // A move is not an arrival: the completed row never gets the "just landed" mark.
        expect(rowB.hasAttribute('data-fresh')).toBe(false);

        host.dispose();
    });

    it('says what landed in sentences, coalesced into one write of the live region', async () => {
        const backend = createBackend();
        const host = tasksHost({ backend, bodyRefreshMs: 150 });

        await host.settle();

        backend.push(TASK_ADDED, TASK_DONE);
        host.seam.wake(4);
        await host.settle();

        // The region is silent while the burst is still arriving.
        expect(liveLinesOf(host)).toEqual([]);

        host.timers.fire(400);

        // Row text and actor, never a bare count — and the completion sentence waits for
        // the value it names, so it is not said here at all.
        expect(liveLinesOf(host)).toEqual([
            'agent updated Write the tests: completed.',
            '2 changes applied.',
            'system added a task: task rec_d.'
        ]);

        host.timers.fire(150);
        await host.settle();
        host.timers.fire(400);

        // The completion sentence names a VALUE, so it is not said by the delta that only
        // named the record; what the reader hears instead is the re-read admitting what it
        // did. The field-level truth was already said, in the burst above. The region
        // keeps only its last three lines.
        expect(liveLinesOf(host)).toEqual([
            '2 changes applied.',
            'system added a task: task rec_d.',
            'The task list was re-read.'
        ]);

        host.dispose();
    });

    it('follows the bottom edge, counts what a scrolled-away reader missed, and jumps on request', async () => {
        const backend = createBackend();
        const host = tasksHost({ backend, bodyRefreshMs: 150 });

        await host.settle();

        const scroller = host.query('.panel-tasks-scroller') as HTMLElement;
        const pill = host.query('.panel-new-pill') as HTMLButtonElement;

        setScrollBox(scroller, 400, 200);

        // The live edge of a task list is the END of the done group; the reader has
        // scrolled up to something older.
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll'));

        expect(pill.hidden).toBe(true);

        backend.push(TASK_ADDED);
        host.seam.wake(3);
        await host.settle();

        expect(pill.hidden).toBe(false);
        expect(pill.textContent).toBe('1 new');
        expect(pill.dataset.pending).toBe('1');
        expect(pill.getAttribute('aria-label')).toBe('1 new changes above. Activate to jump to the newest.');

        // Nothing moved under them: a bottom-edge list compensates by not moving.
        expect(scroller.scrollTop).toBe(0);

        pill.click();

        expect(scroller.scrollTop).toBe(200);
        expect(pill.hidden).toBe(true);
        expect(pill.dataset.pending).toBe('0');

        // Back at the edge, the next arrival comes along with the reader.
        backend.push(TASK_DONE);
        host.seam.wake(4);
        await host.settle();

        expect(scroller.scrollTop).toBe(200);
        expect(pill.hidden).toBe(true);

        host.dispose();
    });

    it('keeps an open row open across a group move, and forgets it when the task or the conversation goes', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = tasksHost({ backend, seam, bodyRefreshMs: 150 });

        await host.settle();

        const rowA = taskRowOf(host, 'rec_a') as HTMLElement;
        const headA = rowA.querySelector('button.panel-tasks-row-head') as HTMLButtonElement;

        headA.click();
        expect(headA.getAttribute('aria-expanded')).toBe('true');

        // The store drops it. The row, its detail and its entry in the panel's own
        // open-set leave together — the prune at the end of `paint`, not the one per
        // group, because a row on its way to the other list is invisible to one pass.
        backend.push({
            seq: 3,
            collection: 'tasks',
            rev: 1,
            id: 'rec_a',
            op: 'remove',
            fields: [],
            item_rev: 1,
            at: LATER,
            by: 'agent'
        });
        host.seam.wake(3);
        await host.settle();

        expect(taskRowOf(host, 'rec_a')).toBeNull();
        expect(host.queryAll('div.panel-tasks-detail')).toHaveLength(1);

        // The same id comes back, and it comes back CLOSED: an open detail belongs to
        // the row that was thrown away with it, never to an id that is reused.
        backend.push({
            seq: 4,
            collection: 'tasks',
            rev: 3,
            id: 'rec_a',
            op: 'add',
            fields: ['text', 'completed'],
            item_rev: 3,
            at: LATER,
            by: 'agent'
        });
        backend.setSnapshot({
            ...SNAPSHOT,
            store_rev: 4,
            collections: [
                {
                    ...(SNAPSHOT.collections[0] as (typeof SNAPSHOT.collections)[number]),
                    store_rev: 4,
                    entries: [
                        { id: 'rec_b', rev: 0, text: 'Write the tests', completed: false, updated_at: AT },
                        { id: 'rec_a', rev: 3, text: 'Ship it, twice', completed: true, updated_by: 'agent', updated_at: LATER }
                    ]
                },
                SNAPSHOT.collections[1] as (typeof SNAPSHOT.collections)[number]
            ]
        });
        host.seam.wake(4);
        await host.settle();
        host.timers.fire(150);
        await host.settle();

        const reborn = taskRowOf(host, 'rec_a') as HTMLElement;

        expect(reborn.dataset.completed).toBe('true');
        expect(reborn.querySelector('button.panel-tasks-row-head')?.getAttribute('aria-expanded')).toBe('false');
        expect(reborn.querySelector('div.panel-tasks-detail')?.hidden).toBe(true);

        // A conversation ending takes its open rows with it (`onSessionChange` clears the
        // set): the next store is a different store, and a row left open from the last
        // one would be a claim about a record this panel has never read.
        const rowB = taskRowOf(host, 'rec_b') as HTMLElement;

        (rowB.querySelector('button.panel-tasks-row-head') as HTMLButtonElement).click();
        expect(rowB.querySelector('button.panel-tasks-row-head')?.getAttribute('aria-expanded')).toBe('true');

        host.setSession('sess_b');
        host.controller.notifySessionChange('sess_b');
        await host.settle();

        expect(host.queryAll('button.panel-tasks-row-head').map((node) => node.getAttribute('aria-expanded'))).toEqual([
            'false',
            'false'
        ]);
        expect(host.queryAll('div.panel-tasks-detail[hidden]')).toHaveLength(2);

        host.dispose();
        // Two conversations were on screen, so the switch retired `sub_1` and the
        // teardown retires `sub_2` — no slot on the plane is left held.
        expect(seam.unsubscribed).toEqual(['sub_1', 'sub_2']);
    });

    it('retires a removed task, hides a group that empties out, and says the row is gone', async () => {
        const backend = createBackend();
        const host = tasksHost({ backend, bodyRefreshMs: 150 });

        await host.settle();

        backend.push({
            seq: 3,
            collection: 'tasks',
            rev: 1,
            id: 'rec_a',
            op: 'remove',
            fields: [],
            item_rev: 1,
            at: LATER,
            by: 'agent'
        });
        host.seam.wake(3);
        await host.settle();

        expect(taskRowOf(host, 'rec_a')).toBeNull();
        expect(host.text('.panel-tasks-status')).toBe('1 task · 0 completed · 1 open');

        // A group with nothing in it removes its own heading rather than leaving a
        // caption over an empty list.
        const doneGroup = host.query('ol[data-group="done"]')?.closest('div.panel-tasks-group');

        expect(doneGroup?.hidden).toBe(true);
        expect(host.query('ol[data-group="pending"]')?.closest('div.panel-tasks-group')?.hidden).toBe(false);

        host.timers.fire(400);

        // The tombstone carries the record's last known text, so the generic line names
        // the row and the panel's own names the id — the two are different facts, both
        // worth hearing.
        expect(liveLinesOf(host)).toEqual(['agent removed Ship it.', 'agent removed task rec_a.']);

        host.dispose();
    });
});

describe('harness.records — live updates', () => {
    it('prepends a live change with the values it cannot vouch for, then fills them in', async () => {
        const backend = createBackend();
        const host = recordsHost({ backend, bodyRefreshMs: 150 });

        await expandRecords(host);

        backend.push({
            seq: 3,
            collection: 'chapters',
            rev: 1,
            id: 'rec_e',
            op: 'add',
            fields: ['title'],
            item_rev: 1,
            at: LATER
        });
        backend.setSnapshot({
            ...SNAPSHOT,
            store_rev: 3,
            collections: [
                SNAPSHOT.collections[0] as (typeof SNAPSHOT.collections)[number],
                {
                    name: 'chapters',
                    store_rev: 3,
                    count: 2,
                    fields: [{ key: 'title', type: 'text' as const, required: true }],
                    entries: [
                        { id: 'rec_c', rev: 0, title: 'Opening' },
                        { id: 'rec_e', rev: 1, title: 'Closing', updated_at: LATER }
                    ]
                }
            ]
        });
        host.seam.wake(3);
        await host.settle();

        // Newest first, at the top, marked as the thing that just landed.
        expect(feedKeysOf(host)).toEqual(['3', '2', '1']);

        const row = host.query('li[data-row-key="3"]') as HTMLElement;

        expect(row.dataset.collection).toBe('chapters');
        expect(row.dataset.id).toBe('rec_e');
        expect(row.dataset.fresh).toBe('true');
        expect(row.querySelector('.panel-records-op')?.textContent).toBe('add');
        expect(row.querySelector('.panel-records-stamp')?.textContent).toBe('just now');

        // The before/after cell the panel cannot fill in yet: the row said `title`, not
        // what `title` became. `—` plus an explicit reason, never a blank cell.
        const unknown = row.querySelectorAll<HTMLElement>('.panel-records-change-value')[1] as HTMLElement;

        expect(unknown.textContent).toBe('—');
        expect(unknown.dataset.unknown).toBe('true');
        expect(unknown.title).toBe('The new value is not in the last read of this record');
        expect(row.querySelector('.panel-records-text')?.dataset.missing).toBe('true');

        // The one re-read closes the record's OWN text. The change cell speaks about the
        // EVENT, and no read of the current record can retroactively say what value this
        // event carried — so it keeps saying so, rather than quietly relabelling history
        // with whatever the field holds now.
        host.timers.fire(150);
        await host.settle();

        expect(row.querySelector('.panel-records-text')?.textContent).toBe('Closing');
        expect(row.querySelector('.panel-records-text')?.hasAttribute('data-missing')).toBe(false);
        expect(unknown.textContent).toBe('—');
        expect(unknown.dataset.unknown).toBe('true');

        // The highlight is still on the row: its own ~1.5s marker decides when it ends,
        // not the re-read that landed 150ms later.
        expect(row.dataset.fresh).toBe('true');
        expect(host.text('.panel-records-footer')).toBe('3 of 3 retained changes');

        host.dispose();
    });

    it('holds a frozen reading position and lets the pill carry the reader back', async () => {
        const backend = createBackend();
        const host = recordsHost({ backend, bodyRefreshMs: 150 });

        await expandRecords(host);

        const scroller = host.query('.panel-records-scroller') as HTMLElement;
        const pill = host.query('.panel-new-pill') as HTMLButtonElement;

        setScrollBox(scroller, 400, 200);
        setRowHeight(host.query('li[data-row-key="2"]') as HTMLElement, 24);

        // A newest-first feed's live edge is scrollTop 0; 120px down is "reading history".
        scroller.scrollTop = 120;
        scroller.dispatchEvent(new Event('scroll'));

        backend.push({
            seq: 3,
            collection: 'tasks',
            rev: 1,
            id: 'rec_b',
            op: 'update',
            fields: ['completed'],
            item_rev: 1,
            at: LATER,
            by: 'agent'
        });
        host.seam.wake(3);
        await host.settle();

        expect(pill.hidden).toBe(false);
        expect(pill.textContent).toBe('1 new');
        expect(pill.getAttribute('aria-label')).toBe('1 new changes above. Activate to jump to the newest.');

        // The line under the eye is held: the offset moved down by exactly the height of
        // the row the batch landed above (120 + 24).
        expect(scroller.scrollTop).toBe(144);
        expect(feedKeysOf(host)).toEqual(['3', '2', '1']);

        pill.click();

        expect(scroller.scrollTop).toBe(0);
        expect(pill.hidden).toBe(true);

        host.dispose();
    });

    it('narrows the feed with a chip, and the All chip is the way back', async () => {
        const host = recordsHost();

        await expandRecords(host);

        chipOf(host, 'tasks').click();

        expect(feedKeysOf(host)).toEqual(['1']);
        expect(host.text('.panel-records-footer')).toBe('1 of 2 retained changes · filtered to tasks');
        expect(chipOf(host, 'all').getAttribute('aria-pressed')).toBe('false');
        expect(chipOf(host, 'tasks').getAttribute('aria-pressed')).toBe('true');

        // Pressing the same chip again is the other way out, and so is "All" — the
        // narrowing is local, so escaping it can never need a re-read.
        chipOf(host, 'tasks').click();

        expect(feedKeysOf(host)).toEqual(['2', '1']);
        expect(host.text('.panel-records-footer')).toBe('2 of 2 retained changes');

        chipOf(host, 'tasks').click();
        chipOf(host, 'all').click();

        expect(feedKeysOf(host)).toEqual(['2', '1']);
        expect(chipOf(host, 'all').getAttribute('aria-pressed')).toBe('true');
        expect(host.query('.panel-records-footer')?.dataset.state).toBe('live');

        host.dispose();
    });

    it('names the window the store keeps, in the footer and inside a record history', async () => {
        const backend = createBackend(WINDOWED_SNAPSHOT);
        const host = tasksHost({ backend, bodyRefreshMs: 150 });

        await host.settle();

        // One event behind a task is not a history, and there is no separate disclosure
        // button left to find: the row is the only control it has.
        const closedRow = taskRowOf(host, 'rec_a') as HTMLElement;

        expect(closedRow.querySelectorAll('button')).toHaveLength(1);
        expect(closedRow.querySelector('.panel-expand')).toBeNull();
        expect(closedRow.querySelector('ol.panel-tasks-history')).toBeNull();

        backend.push(TASK_REOPENED);
        backend.setSnapshot(WITH_HISTORY);
        host.seam.wake(7);
        await host.settle();
        host.timers.fire(150);
        await host.settle();

        const rowA = taskRowOf(host, 'rec_a') as HTMLElement;
        const headA = rowA.querySelector('button.panel-tasks-row-head') as HTMLButtonElement;
        const detailA = rowA.querySelector('div.panel-tasks-detail') as HTMLElement;

        // The history arrived and the row grew no button for it — no "Show 2 changes"
        // label, no word about changes at all, and the mark and sentence are unchanged.
        expect(rowA.querySelectorAll('button')).toHaveLength(1);
        expect(rowA.textContent).not.toContain('changes');
        expect(headA.getAttribute('aria-expanded')).toBe('false');
        expect(detailA.hidden).toBe(true);
        expect(rowA.querySelector('ol.panel-tasks-history')).toBeNull();

        headA.click();

        expect(headA.getAttribute('aria-expanded')).toBe('true');
        expect(detailA.hidden).toBe(false);

        const history = rowA.querySelectorAll('ol.panel-tasks-history > li') as NodeListOf<HTMLElement>;

        // Newest first, and the honest note: the store keeps 200 events and this record's
        // rev says more happened than that.
        expect(history).toHaveLength(3);
        expect(history[0]?.textContent).toBe('agentupdatecompletedjust now');
        expect(history[1]?.textContent).toBe('agentupdatecompleted5m');
        expect(history[2]?.textContent).toBe('Older changes were not kept by the store.');

        headA.click();

        expect(headA.getAttribute('aria-expanded')).toBe('false');
        expect(rowA.querySelector('ol.panel-tasks-history')).toBeNull();
        expect(rowA.querySelectorAll('div.panel-tasks-detail')).toHaveLength(1);

        host.dispose();
    });
});

describe('the plane, the conversation and the way out', () => {
    it('treats a silent drop as a dead plane, and the next baseline as the answer to it', async () => {
        const backend = createBackend();
        const host = tasksHost({ backend });

        await host.settle();

        host.seam.gap('frames_dropped');
        await host.settle();

        // The rows stay: the plane is what died, not the data.
        expect(host.phase()).toBe('stale');
        expect(host.text('.panel-tasks-sync')).toBe('updated just now · realtime disconnected');
        expect(host.queryAll('.panel-tasks-row')).toHaveLength(2);
        expect(backend.snapshotReads()).toBe(1);

        host.timers.fire(400);
        expect(liveLinesOf(host)).toEqual(['Realtime updates disconnected.']);

        const before = backend.deltaReads();

        host.seam.baseline({
            type: 'subscription_state',
            subscription_id: 'sub_1',
            scope: 'session',
            epoch: 'epoch-2',
            sequence: 2,
            cursor: 'c2',
            revisions: [
                { resource: 'records', id: 'sess_a', revision: 4, epoch: 'epoch-2', link: '/v1/harness/sessions/sess_a/records' }
            ],
            replayed_frames: 0
        });
        await host.settle();

        // A baseline that replayed NOTHING means the outage's writes never arrived, so the
        // panel re-reads rather than trusting the rows it has.
        expect(backend.deltaReads()).toBe(before + 1);
        expect(host.phase()).toBe('ready');

        host.timers.fire(400);

        expect(liveLinesOf(host)).toEqual([
            'Realtime updates disconnected.',
            'Realtime updates reconnected.',
            '2 tasks on the list.'
        ]);

        host.dispose();
    });

    it('rebuilds from scratch when the drop names the record store, without calling a rebuild new', async () => {
        const backend = createBackend();
        const host = recordsHost({ backend });

        await expandRecords(host);

        const kept = host.query('li[data-row-key="2"]') as HTMLElement;

        host.seam.gap('cursor_expired', 1);
        await host.settle();

        expect(backend.snapshotReads()).toBe(2);
        expect(host.phase()).toBe('ready');

        // Keyed by the feed's own seq: a rebuild re-uses the row it already had, and does
        // not light it up as though it had just landed.
        expect(host.query('li[data-row-key="2"]')).toBe(kept);
        expect(kept.hasAttribute('data-fresh')).toBe(false);

        host.timers.fire(400);

        // The rebuild line is the generic one; the panel adds what the rebuild means in
        // ITS collection. Neither claims anything arrived.
        expect(liveLinesOf(host)).toEqual([
            'The record store was rebuilt from scratch.',
            '2 record changes on screen.'
        ]);

        host.dispose();
    });

    it('drops the conversation that is going away, filter included', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = recordsHost({ backend, seam });

        await expandRecords(host);

        chipOf(host, 'tasks').click();
        expect(feedKeysOf(host)).toEqual(['1']);

        host.setSession('sess_b');
        host.controller.notifySessionChange('sess_b');
        await host.settle();

        // The new conversation is read from the top: no leftover narrowing, no rows from
        // the session that is gone, and one registration for the session on screen now.
        expect(backend.reads.some((read) => read.sessionId === 'sess_b')).toBe(true);
        expect(feedKeysOf(host)).toEqual(['2', '1']);
        expect(chipOf(host, 'all').getAttribute('aria-pressed')).toBe('true');
        expect(host.text('.panel-records-footer')).toBe('2 of 2 retained changes');
        expect(seam.specs.map((spec) => spec.sessionId)).toEqual(['sess_a', 'sess_b']);

        // Moving to no conversation at all stops the reads instead of leaving the old
        // session's rows on a board that has nothing to describe.
        host.setSession(null);
        host.controller.notifySessionChange(null);
        await host.settle();

        expect(host.queryAll('li.panel-records-row')).toHaveLength(0);

        // Two conversations were on screen, so two registrations were dialled (the spec
        // list above names both). Each one is retired the moment its conversation ends —
        // the switch to `sess_b` released `sub_1`, going to no session releases `sub_2`.
        // Anything still held here is a slot on the plane that nobody is listening to.
        expect(seam.unsubscribed).toEqual(['sub_1', 'sub_2']);

        host.dispose();
    });

    it('leaves no registration, no timer and no paint behind', async () => {
        const backend = createBackend();
        const seam = createSeam();
        const host = tasksHost({ backend, seam });

        await host.settle();

        expect(seam.specs).toHaveLength(1);

        host.dispose();

        expect(seam.unsubscribed).toEqual(['sub_1']);

        const armed = host.timers.armed.length;

        backend.push(TASK_ADDED);
        seam.wake(3);
        await host.settle();

        // A frame after the teardown paints nothing and arms nothing: the client is
        // disposed, the wake is detached, and the clock is cleared with the context.
        expect(host.timers.armed).toHaveLength(armed);
        expect(taskRowOf(host, 'rec_d')).toBeNull();
        expect(host.text('.panel-tasks-status')).toBe('2 tasks · 1 completed · 1 open');

        host.timers.fireAll();
        await host.settle();

        expect(taskRowOf(host, 'rec_d')).toBeNull();
    });
});

describe('the panels the shell ships', () => {
    it('registers Tasks above Records, both session-scoped and both needing a conversation', async () => {
        const extensions = await import('./index');

        extensions.registerBuiltinShellPanels();

        expect(listShellPanels().map((panel) => panel.id)).toEqual([HARNESS_TASKS_PANEL_ID, HARNESS_RECORDS_PANEL_ID]);
        expect(
            listShellPanels().map((panel) => [panel.title, panel.slot, panel.scope, panel.requiresSession, panel.order])
        ).toEqual([
            ['Tasks', 'scratch', 'session', true, 10],
            ['Records', 'scratch', 'session', true, 20]
        ]);

        // Idempotent: a hot reload replaces the registration rather than stacking a
        // second card in the rail.
        extensions.registerBuiltinShellPanels();

        expect(listShellPanels().map((panel) => panel.id)).toEqual([HARNESS_TASKS_PANEL_ID, HARNESS_RECORDS_PANEL_ID]);
    });
});

// The two live shell panels (T6): Tasks (`harness.tasks`) and Records (`harness.records`).
//
// WHAT THESE PANELS ARE
// ---------------------
// The first panels this app keeps MOUNTED for the life of a conversation. A tool card
// is a photograph of a tool's answer; these two are windows onto the session's record
// store, which an agent is editing while the reader watches. Everything that comes
// from "mounted while the data moves" lives here or in the two modules below it:
//
//     ./records-client.ts — WHEN to read and WHAT the store now says (wake + delta)
//     ./records-dom.ts    — the live-region, follow, FLIP and timestamp machinery
//     this file           — the two surfaces, and the registration that puts them on
//                           the scratch board
//
// THE PANELS ARE DISPLAY-ONLY
// ---------------------------
// Neither panel writes. The record store is the agent's workspace; a reader who wants
// a task ticked ticks it with a tool call, and the row moves on its own a moment later.
// That is why there are no checkboxes to click here: a control that only LOOKS like it
// works is worse than none.
//
// ISOLATION
// ---------
// Each panel owns its own `createRecordsClient` (./records-client.ts) and its own
// subscription. Two clients means two bounded reads per burst instead of one, which is
// the price of the guarantee that matters more: ONE PANEL FAILING CANNOT TAKE THE OTHER
// DOWN. A throwing render, a refused subscription or a failed read in Records leaves
// Tasks painting normally, and the shell itself keeps running (./runtime.ts mounts each
// panel in a try/catch and disposes the half-built instance — a broken panel is one
// card, not a dead page).
//
// THE COLLAPSE GATE (BOTH PANELS, AND THE TITLE IS THE CONTROL)
// -------------------------------------------------------------
// Both cards open and close, and the thing the reader presses is the card's own
// heading — a `<button class="panel-title">` that replaces the plain heading the
// runtime drew (see `titleToggleOf` below). A card the reader has not opened must
// cost the conversation nothing: no snapshot read, no delta, no registration on the
// realtime plane. Expanding the card is what mounts the engine; collapsing it again
// releases the wake and the client and clears the surface, so every expansion is a
// fresh boot rather than a stale view kept "live" by nothing. Records ships CLOSED
// (the feed is the long one); Tasks ships OPEN (it is the card a reader glances at).
//
// HOW A ROW ARRIVES ON SCREEN
// ---------------------------
//   1. the WS plane says `records.updated` (identity only, never content)
//   2. the client delta-reads `?since=store_rev` and applies the rows in seq order
//   3. this file reconciles the keyed DOM: a new row is created, marked `data-fresh`
//      for the ~1.5s "just landed" highlight, and moved with FLIP if it displaced
//      anything the reader was looking at
//   4. the follow controller decides whether the reader MOVES (they were at the live
//      edge) or STAYS (they were reading something else, and get an "N new" pill)
//   5. the announcer writes one coalesced sentence into the panel's pre-mounted live
//      region — the row's TEXT, because "3 changes" tells a blind reader nothing
// The change row itself carries no field values (../shared/harness-api.ts
// `RecordChangeRow.fields` is a list of NAMES), so step 2 knows the identity and order
// of every event immediately and closes the body gap with ONE debounced re-read
// (`RECORDS_BODY_REFRESH_MS`) — event-driven, never a poll.
//
// THE FIVE STATES
// ---------------
// `loading` (one word in the corner box — never a shimmer laid over the list, which
// is what made the tile flicker every time a re-read came and went), `empty`, `error`
// (+ Retry), `stale` (rows on screen, a note saying they may not be current) and
// `ready`. All five are a `data-phase` on the panel's own root, so the CSS, the tests
// and a screen reader (`aria-busy`) read the same single fact, and the phase is derived
// from the client rather than tracked beside it (`recordsPanelPhaseOf`).
//
// Cross-references:
//   - ./shell-panels.ts — the registry these two register into
//   - ./context.ts      — the capabilities a mounted panel gets, and its abort signal
//   - ../ui/panels.ts   — the scratch host that places the card
//   - ../main.ts        — `registerBuiltinShellPanels()` at boot
//   - ../styles.css     — every class named here (the new section at the end)

import type { RecordsDeltaResponse, RecordsSnapshotResponse } from '../../shared/harness-api';
import type { RecordsClient, RecordsClientOptions, RecordsFeedRow, RecordsNotice, RecordsTask } from './records-client';
import { RECORDS_FEED_WINDOW, TASKS_COLLECTION, createRecordsClient, recordsActorOf } from './records-client';
import type { PanelContext } from './context';
import type { RecordsAnnouncer, RecordsSchedule, RecordsSurfaceState } from './records-dom';
import {
    RECORDS_LIVE_EDGE_THRESHOLD,
    createRecordsAnnouncer,
    createRecordsFlip,
    createRecordsFollow,
    createRecordsFreshMarker,
    recordsActorBadgeOf,
    recordsElement,
    recordsLiveRegionOf,
    recordsNewPillOf,
    recordsStampOf,
    recordsStateOf,
    recordsStatusOf,
    recordsTruncate,
    refreshRecordsStamps
} from './records-dom';
import { registerShellPanel } from './shell-panels';
import { attachRecordsWake } from './records-wake';

// The registry ids. Exported because a host (and the tests) must be able to name a
// panel without re-typing a string, and because `order` below is only meaningful next
// to these.
export const HARNESS_TASKS_PANEL_ID = 'harness.tasks';
export const HARNESS_RECORDS_PANEL_ID = 'harness.records';

// Both sit at the TOP of the scratch board (the default order is 100, so a registered
// tool-kind panel still lands below them), Tasks first: it is the shorter read and the
// one a reader checks for "is the agent done with its list".
const TASKS_PANEL_ORDER = 10;
const RECORDS_PANEL_ORDER = 20;

// Relative stamps are cheap to re-age and nobody needs them accurate to the second; a
// minute is the resolution the labels actually render at.
const RECORDS_CLOCK_TICK_MS = 30_000;

// The feed's neutral chip. Internally the filter is `null` when nothing is narrowed, and
// this name is the chip that represents that state: pressing "All" can never select a
// store collection that happens to be called `all`, which would otherwise empty the feed
// with no way back (a collection name is the server's to choose).
const RECORDS_ALL_CHIP = 'all';

// ---------------------------------------------------------------------------
// Shared mount plumbing
// ---------------------------------------------------------------------------

// What a host may override for BOTH panels. `now` and `schedule` reach the client, the
// announcer, the fresh marker and the clock, which is what makes "the highlight expired"
// and "the burst coalesced" testable without waiting for either.
export type RecordsPanelOptions = {
    /** Epoch-ms clock. Default `Date.now`. */
    now?: () => number;
    /** Timer seam. Default `setTimeout`, with the panel's abort signal honoured. */
    schedule?: RecordsSchedule;
    /** Stamp/footer tick. Default 30s. */
    tickMs?: number;
    /** Test seam: build the client with an injected reader (see ./records-client.ts). */
    clientOptions?: Pick<RecordsClientOptions, 'reader' | 'schedule' | 'bodyRefreshMs' | 'feedLimit'>;
};

// The pieces every live panel needs, assembled once per mount. The engine (the client
// and its subscription) is NOT built here: `retarget` builds it, so a session switch
// can replace it without touching the surface.
type PanelMount = {
    /** The panel's own live region, pre-mounted before any content. */
    region: HTMLElement;
    announcer: RecordsAnnouncer;
    /** Fresh id for the clock tick, so a late tick never paints a dead panel. */
    now: () => number;
    schedule: RecordsSchedule;
    /** Creates the engine for `sessionId` and starts its first read. */
    retarget: (sessionId: string, repaint: () => void) => void;
    /** The engine's client, or undefined before the first session. */
    engine: () => RecordsClient | undefined;
    /**
     * Stops the current engine: the store AND its registration on the plane. A session
     * switch keeps the surface and drops the conversation, so the wake goes with it.
     */
    stopEngine: () => void;
};

const defaultSchedule: RecordsSchedule = (callback, delayMs, signal) => {
    // The signal is passed to setTimeout where the host supports it (Node ≥ 10, all
    // browsers): a disposed panel's pending timer then dies on its own, and the guard
    // in each callback is the belt for a host whose timer cannot be aborted.
    const timer = globalThis.setTimeout(callback, delayMs, signal);

    signal?.addEventListener('abort', () => globalThis.clearTimeout(timer), { once: true });
};

const createPanelMount = (
    ctx: PanelContext,
    options: RecordsPanelOptions | undefined,
    onNotice?: (notice: RecordsNotice) => void
): PanelMount => {
    const now = options?.now ?? ((): number => Date.now());
    const schedule = options?.schedule ?? defaultSchedule;

    // Pre-mounted, and the FIRST child: a live region that appears in the same
    // mutation as the text it should announce is a region assistive tech may never
    // have registered (./records-dom.ts `recordsLiveRegionOf`).
    const region = recordsLiveRegionOf('Panel updates');
    const announcer = createRecordsAnnouncer({ region, schedule, signal: ctx.signal });

    ctx.onDispose(() => {
        // Anything still queued belongs to a panel that is gone; the runtime also
        // aborts the signal every timer here was armed with.
        announcer.cancel();
        announcer.destroy();
    });

    let client: RecordsClient | undefined;
    // The wake detach of whichever engine is running. `retarget` replaces it and
    // `stopEngine` runs it. The registration belongs to the conversation the engine was
    // built for (./records-wake.ts dials one per session id), so a conversation switch
    // that only disposed the client would leave the OLD session's registration on the
    // plane forever: the broker still counts this panel as attached and keeps every
    // frame of that conversation alive.
    let detachWake: () => void = () => undefined;

    return {
        region,
        announcer,
        now,
        schedule,
        engine: () => client,
        stopEngine: () => {
            const current = client;
            const detach = detachWake;

            client = undefined;
            detachWake = () => undefined;
            // The plane first: a frame that lands after this belongs to the conversation
            // that is going away, and its client is about to be disposed. `release` is
            // idempotent, so the context's own teardown still runs it harmlessly later.
            detach();
            current?.dispose();
        },
        retarget: (sessionId, repaint) => {
            const engine = createRecordsEngine({
                ctx,
                sessionId,
                now,
                schedule,
                announcer,
                paint: repaint,
                ...(onNotice === undefined ? {} : { onNotice }),
                ...(options?.clientOptions === undefined ? {} : { clientOptions: options.clientOptions })
            });

            client = engine.client;
            detachWake = engine.release;
        }
    };
};

// ---------------------------------------------------------------------------
// The engine: one client, one subscription, one paint hook
// ---------------------------------------------------------------------------

const createRecordsEngine = (deps: {
    ctx: PanelContext;
    sessionId: string;
    now: () => number;
    schedule: RecordsSchedule;
    announcer: RecordsAnnouncer;
    paint: (client: RecordsClient) => void;
    /** The panel's own reading of a notice (its row sentences). Runs before the paint. */
    onNotice?: (notice: RecordsNotice) => void;
    clientOptions?: RecordsPanelOptions['clientOptions'];
}): { client: RecordsClient; release: () => void } => {
    const { ctx, sessionId, paint } = deps;

    // The reads go through the context's api so an injected host (a test, or a shell
    // pointed at another origin) can answer them (./context.ts `panelApi`).
    const snapshot = injectedSnapshot(ctx.api.readRecordsSnapshot);
    const delta = injectedDelta(ctx.api.readRecordsDelta);

    // One engine = one conversation. Its FIRST successful read is the panel arriving, so
    // it is not announced (see `onNotice` below); every notice after it is news.
    let painted = false;

    const client = createRecordsClient({
        sessionId,
        reader: { snapshot, delta },
        now: deps.now,
        // The client wants a cancellable timer; the panel's schedule is
        // signal-scoped. This adapter bridges the two spellings and is registered for
        // teardown so a pending body re-read cannot outlive the mount.
        schedule: (run, ms) => {
            const controller = new AbortController();

            deps.schedule(run, ms, controller.signal);

            return () => controller.abort();
        },
        ...(deps.clientOptions === undefined ? {} : deps.clientOptions),
        onNotice: (notice) => {
            if (ctx.disposed) return;

            // THE FIRST READ IS NOT NEWS. The panel arriving is not the store changing:
            // announcing the window's last events on mount is a monologue about a past
            // the reader never saw, so the opening read paints silently. Everything
            // after it is news — including a first read that FAILED, which the reader
            // cannot see explained any other way, and a Retry (reason 'boot' again,
            // after the first paint) which is news by definition.
            const opening = !painted && notice.reason === 'boot' && !notice.stale;

            painted = true;

            if (!opening) {
                // Generic first (every panel owes the reader these), then the panel's own
                // sentence for the events that mean something in ITS collection.
                announceNotice(deps.announcer, notice);
                deps.onNotice?.(notice);
            }

            paint(client);
        }
    });

    // THE REALTIME WIRING. `records` is one of the session baseline's resources, so a
    // session-scoped registration carries no filters (the contract accepts filters for
    // status/threads/events/sections only — ../../shared/harness-stream.ts). The
    // registration itself is SHARED across the live panels (./records-wake.ts): these
    // frames are watermarks, so one registration fans out to every attached client and
    // a second live panel costs zero extra slots on the plane.
    let releaseWake: () => void = () => undefined;

    try {
        const wake = attachRecordsWake(
            sessionId,
            {
                onSignal: (signal) => client.frame(signal),
                onBaseline: (state) => {
                    // THE OUTAGE IS ANSWERED ONCE. `linkUp` owns the case this client
                    // noticed (a resync it was waiting on), so the panel only answers the
                    // case the client CANNOT see: a re-registration that replayed nothing
                    // while the client still believed it was current. Two owners pulling
                    // here would cost two reads per reconnect for one answer.
                    const waiting = client.resyncPending();

                    client.linkUp(
                        state.revisions?.find((resource) => resource.resource === 'records')?.revision
                    );

                    if (!waiting && (state.replayed_frames ?? 0) === 0) void client.pull('delta');
                },
                onGap: (frame) => {
                    // A drop with no resource list is the socket dying: the client marks
                    // the rows stale and waits for the next baseline, which is the answer
                    // to "were the missing frames replayed?" — re-reading now would race
                    // that answer (the ordering ./view-shell.ts:743-770 keeps).
                    if (frame.reason === 'frames_dropped' && frame.resources.length === 0) {
                        client.linkDown();

                        return;
                    }

                    void client.refresh('reset');
                },
                onRefused: (message) => {
                    // A refusal (unknown_resource, unsupported_filter) is final for this
                    // registration: the panel says so once and stops waiting.
                    client.linkError(`Realtime updates refused: ${message}`);
                },
                onUnavailable: (message) => {
                    // No plane, or a host whose seam refused: the panel still reads, it
                    // just reads on demand instead of on wake.
                    client.linkError(`Realtime updates unavailable: ${message}`);
                },
                onReleased: () => {
                    // The shared registration is gone (the last panel let go, or the page
                    // is being torn down): the rows stay, the plane does not.
                    client.linkDown();
                }
            },
            // A host may point the runtime at its own plane (a test, an embedded shell);
            // the broker then shares THAT seam instead of the page's client, so the
            // "one registration" rule holds for the host's connection too. The RAW seam,
            // never the per-context wrapper: two panels of one host must look like ONE
            // host to the broker (./context.ts `PanelContext.subscribeSeam`).
            ctx.subscribeSeam
        );

        releaseWake = wake.release;
    } catch (error) {
        client.linkError(
            `Realtime updates unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    ctx.onDispose(() => {
        // Detach THIS panel; the broker retires the registration when the last panel
        // lets go, which is what keeps a session switch from leaving a slot behind.
        // Idempotent, so `stopEngine` running it first is fine.
        releaseWake();
    });

    ctx.onDispose(() => client.dispose());

    void client.boot();

    // `release` is also handed back: a session switch stops this engine WITHOUT
    // disposing the context, and the registration belongs to the conversation this
    // engine was built for (./records-wake.ts dials one per session id).
    return { client, release: () => releaseWake() };
};

// One sentence per event this update ADDED, plus the state changes a sighted reader
// would see with their own eyes. The count line is the fallback for a burst of 30,
// where 30 sentences would be worse than silence (./records-dom.ts `createRecordsAnnouncer`
// keeps only the last three lines).
const announceNotice = (announcer: RecordsAnnouncer, notice: RecordsNotice): void => {
    for (const row of notice.rows) announcer.say(announceRowOf(row));

    if (notice.rows.length > 1) announcer.say(`${notice.rows.length} changes applied.`);

    if (notice.reason === 'error') {
        announcer.say(`The record read failed: ${notice.error ?? 'no reason given'}.`);

        return;
    }

    // A LINK notice reports the LINK; `stale` is a claim about the DATA. After a
    // reconnect the rows are still unconfirmed until the delta lands, so the sentence
    // follows `notice.link` and never `notice.stale` (./records-client.ts keeps the two
    // flags apart for exactly this reason).
    if (notice.reason === 'link' && notice.link === 'down') announcer.say('Realtime updates disconnected.');

    if (notice.reason === 'link' && notice.link === 'live') announcer.say('Realtime updates reconnected.');

    if (notice.reason === 'reset') announcer.say('The record store was rebuilt from scratch.');

    if (notice.reason === 'collections') announcer.say('The record collections changed.');
};

const announceRowOf = (row: RecordsFeedRow): string => {
    const actor = recordsActorOf(row);
    const what = row.label.length > 0 ? row.label : `${row.collection} ${row.id}`;

    if (row.op === 'add') return `${actor.name} added ${what}.`;
    if (row.op === 'remove') return `${actor.name} removed ${what}.`;

    const fields = row.changes.map((change) => change.field);

    return fields.length === 0
        ? `${actor.name} updated ${what}.`
        : `${actor.name} updated ${what}: ${fields.join(', ')}.`;
};

// ---------------------------------------------------------------------------
// The keyed reconciliation every list here uses
// ---------------------------------------------------------------------------

// The rule: rows are keyed by the record `id` (a feed row's `seq` would re-key a record
// on every edit and animate it as a NEW arrival). A reused element keeps its scroll
// position, its focus, its open `<details>` and its `data-fresh` mark; a moved element
// gets FLIP'd into place by the caller, which measured the list BEFORE this ran.
type ReconcileSpec<T> = {
    items: readonly T[];
    keyOf: (item: T) => string;
    create: (item: T) => HTMLElement;
    render: (node: HTMLElement, item: T, index: number) => void;
    /** True → the list is rebuilt wholesale (a bootstrap/reset): no "before" to animate. */
    replace?: boolean;
    /**
     * Rows that may already exist in a SIBLING container. The tasks panel has two groups
     * over one record set, and a row that completes is the same row the reader was
     * looking at: with a pool its element MOVES between the groups, keeping focus, text
     * selection and an open disclosure, instead of being thrown away and rebuilt.
     */
    pool?: Map<string, HTMLElement>;
    fresh?: Set<string>;
    markNode?: (node: HTMLElement, fresh: boolean) => void;
    /** Live count for `aria-busy` and the `data-count` the CSS and the tests read. */
    busy?: boolean;
};

const reconcile = <T,>(
    container: HTMLElement,
    spec: ReconcileSpec<T>
): { created: string[]; removed: string[]; moved: boolean } => {
    const existing = new Map<string, HTMLElement>();

    for (const node of [...container.children]) {
        if (!(node instanceof HTMLElement)) continue;

        const key = node.dataset.rowKey;
        if (key === undefined || key.length === 0) continue;
        existing.set(key, node);
    }

    const seen = new Set<string>();
    const created: string[] = [];
    const removed: string[] = [];
    let moved = false;
    let index = 0;

    // Slot-by-slot: each item's place in the desired order is filled by its own node,
    // created when it does not exist yet and moved when it is somewhere else. A brand
    // new row whose place is the END is appended (the cheap path — an oldest-first
    // list, and every bootstrap); a new row whose place is at the TOP or the MIDDLE
    // goes there, because a newest-first feed that appended its newest event at the
    // bottom would be lying about what just landed.
    for (const item of spec.items) {
        const key = spec.keyOf(item);
        const slot = container.children[index] ?? null;

        // A row that lives in a SIBLING container (the other task group) is not a new
        // row: its element moves, and everything the reader had on it moves with it.
        let node = existing.get(key) ?? spec.pool?.get(key);

        if (node === undefined) {
            node = spec.create(item);
            node.dataset.rowKey = key;

            if (slot === null) container.append(node);
            else container.insertBefore(node, slot);

            created.push(key);
        } else if (slot !== node) {
            container.insertBefore(node, slot);
            moved = true;
        }

        spec.render(node, item, index);
        spec.markNode?.(node, spec.fresh?.has(key) === true);
        seen.add(key);
        index += 1;
    }

    for (const [key, node] of existing) {
        if (seen.has(key)) continue;
        node.remove();
        removed.push(key);
    }

    container.setAttribute('data-count', String(spec.items.length));
    container.setAttribute('aria-busy', String(spec.busy === true));

    if (spec.replace === true) spec.fresh?.clear();

    return { created, removed, moved };
};

// ---------------------------------------------------------------------------
// Shared surface helpers
// ---------------------------------------------------------------------------

// The closed set of states a panel publishes as `data-phase` on its root. It is a TYPE,
// not a runtime array: the stylesheet switches on the attribute and `recordsPanelPhaseOf`
// below is the only derivation, so a sixth state cannot appear without failing to
// compile. The set itself is the DOM layer's (./records-dom.ts `RecordsSurfaceState`),
// because the corner box paints the same five words.
export type RecordsPanelPhase = RecordsSurfaceState;

// THE FIVE STATES, DERIVED. `loading` is the client's own phase; `error` is the full
// state only while there is nothing on screen, because rows that did arrive are worth
// keeping and a failed re-read of them is `stale` (the client says so in `error()`).
// `count` is what the CALLING panel has to show — its own projection, not the store — so
// a session with chapters and no tasks reads as `empty` on the tasks panel and `ready` on
// the feed panel. Each panel owns its emptiness.
export const recordsPanelPhaseOf = (client: RecordsClient, count: number): RecordsPanelPhase => {
    if (client.phase() === 'loading') return 'loading';
    if (client.phase() === 'error') return count === 0 ? 'error' : 'stale';
    if (client.stale()) return 'stale';
    if (count === 0) return 'empty';

    return 'ready';
};

// The one honest line about the data: when it last landed, and what is wrong with it
// now. `lastSyncAt` is 0 before the first successful read, and that is stated rather
// than hidden.
export const recordsSyncLineOf = (client: RecordsClient, nowMs: number): string => {
    const last = client.lastSyncAt();
    const stamp = recordsStampOf(last === 0 ? undefined : new Date(last).toISOString(), nowMs);
    const parts: string[] = [];

    parts.push(last === 0 ? 'never read' : `updated ${stamp.textContent || 'just now'}`);

    if (client.linkState() === 'down') parts.push('realtime disconnected');

    // The reason a re-read failed is worth one clause, whether or not the rows on screen
    // are still usable — that distinction is what `error` and `stale` are for, and a
    // reader who sees only "may be out of date" cannot tell a dead plane from a slow one.
    if (client.error() !== undefined) parts.push(`read failed: ${client.error()}`);
    else if (client.stale() && client.linkState() !== 'down') parts.push('may be out of date');

    return parts.join(' · ');
};

// What the corner box says, one short word per state. The box is small and pinned to a
// corner, so it carries the NAME of the state; the sentence about why — when the data
// last landed, whether the plane is down, what a failed read said — is the chrome line
// under the body, which has room for the whole clause.
const PHASE_LABEL: Record<RecordsPanelPhase, string> = {
    loading: 'reading',
    empty: 'empty',
    error: 'error',
    stale: 'stale',
    ready: 'live'
};

// The chrome every panel draws: the corner box that says what the surface is doing, and
// the one honest line about the data under it. `data-phase` on the ROOT is what the
// stylesheet switches on, so this only maintains the two attributes and the text. The
// box is never re-inserted — it is built once at mount and only its word changes, which
// is the whole reason it replaced the skeleton.
const paintChrome = (
    root: HTMLElement,
    status: HTMLElement,
    note: HTMLElement,
    phase: RecordsPanelPhase,
    text: string
): void => {
    root.dataset.phase = phase;
    root.setAttribute('aria-busy', String(phase === 'loading'));

    status.hidden = false;
    status.dataset.state = phase;
    status.textContent = PHASE_LABEL[phase];

    note.dataset.state = phase === 'ready' || phase === 'loading' ? 'live' : phase;
    note.hidden = phase === 'ready';
    note.textContent = text;
};

// ---------------------------------------------------------------------------
// The card heading is the collapse control
// ---------------------------------------------------------------------------

// `aria-controls` needs an id, and one board — or one test fixture — can mount the same
// panel twice, so the sequence is this module's (the same reasoning as
// `tasksDetailSequence` below).
let panelBodySequence = 0;

// THE HEADING IS THE CONTROL. The runtime draws a plain `<h3 class="panel-title">` for a
// registered panel (./context.ts `setTitle`); a live panel replaces it with a real
// `<button>` carrying the SAME class, so it keeps the heading's look, the `.panel-title`
// selector the shell and the stylesheet already use, and the collapse state on
// `aria-expanded`. A separate "Show records" button under the heading was one control too
// many for a card whose title is the thing every reader already presses — and it made the
// Tasks card, which had no such button, the odd one out.
const titleToggleOf = (options: {
    ctx: PanelContext;
    /** The heading's own words, which double as the button's accessible name. */
    label: string;
    /** Names the card for a host that styles or queries one panel's toggle. */
    panel: string;
    body: HTMLElement;
    onToggle: () => void;
}): HTMLButtonElement => {
    const button = recordsElement('button', 'panel-title panel-title-toggle') as HTMLButtonElement;

    panelBodySequence += 1;

    const bodyId = `panel-body-${panelBodySequence}`;

    options.body.id = bodyId;
    button.type = 'button';
    button.dataset.panelToggle = options.panel;
    button.textContent = options.label;
    button.setAttribute('aria-controls', bodyId);

    // The heading the context prepended goes first, and this takes its place: the card
    // still reads title-then-body, and a later `setTitle` rewrites THIS node.
    options.ctx.setTitle('');
    options.ctx.element.prepend(button);

    button.addEventListener('click', () => {
        if (options.ctx.disposed) return;

        options.onToggle();
    });

    return button;
};

const paintTitleToggle = (button: HTMLButtonElement, label: string, expanded: boolean): void => {
    button.dataset.expanded = String(expanded);
    button.setAttribute('aria-expanded', String(expanded));
    // The visible affordance is the heading itself, so the hint is where a pointer
    // reader looks before pressing: the tooltip, not a second label.
    button.title = expanded ? `Collapse the ${label} panel` : `Expand the ${label} panel`;
};

// The history disclosure's body: the events this client accumulated for ONE record,
// newest first, with the honest note when older events exist that it never saw.
const historyListOf = (
    items: readonly RecordsFeedRow[],
    truncated: boolean,
    nowMs: number,
    classNames: { list: string; truncated: string }
): HTMLElement => {
    const list = recordsElement('ol', classNames.list);

    for (const row of items) {
        const item = recordsElement('li');
        const actor = recordsActorOf(row);

        item.append(recordsElement('span', 'panel-history-actor', actor.name));

        const verb = recordsElement('span', 'panel-history-verb', row.op);

        verb.dataset.op = row.op;
        item.append(verb);

        if (row.changes.length > 0) {
            item.append(
                recordsElement(
                    'span',
                    'panel-history-fields',
                    row.changes.map((change) => change.field).join(', ')
                )
            );
        }

        item.append(recordsStampOf(row.at, nowMs, 'panel-history-stamp'));
        list.append(item);
    }

    if (truncated) list.append(recordsElement('li', classNames.truncated, 'Older changes were not kept by the store.'));

    return list;
};

// The records feed's disclosure: a real `<button>` with `aria-expanded` (the feed's rows
// are already `<li>`s inside a list, so a `<details>` inside a list item would fight the
// list semantics a screen reader is navigating). The Tasks panel no longer uses it —
// there the whole row is the control — but the feed's rows are not a control: a whole
// change row would be a button wrapping a button, since each of its rows expands too.
const expandButtonOf = (node: HTMLElement, repaint: () => void, expanded: boolean, count: number): HTMLButtonElement => {
    let button = node.querySelector<HTMLButtonElement>('.panel-expand');

    if (button === null) {
        const created = recordsElement('button', 'panel-expand');

        created.type = 'button';
        created.addEventListener('click', () => {
            // The panel's own state (a Set of expanded keys) is authoritative; this
            // attribute is repainted from it on the next pass. Writing it here keeps the
            // button truthful for the milliseconds before that paint, and for a panel
            // that never repaints at all (a host that only mounts and unmounts).
            created.dataset.expanded = String(created.dataset.expanded !== 'true');
            repaint();
        });
        node.append(created);
        button = created;
    }

    button.dataset.expanded = String(expanded);
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? 'Hide changes' : `Show ${count} changes`;

    return button;
};

// A host may inject a partial api (./context.ts `PanelApiOverrides`). A read it did not
// supply is a rejected read, not a `TypeError: not a function` from deep inside the
// client's retry loop — the client already turns a rejected read into the panel's
// error/stale state, which is the difference between a panel that explains itself and a
// panel that is blank.
const injectedSnapshot = (
    fn: ((sessionId: string) => Promise<RecordsSnapshotResponse>) | undefined
): ((sessionId: string) => Promise<RecordsSnapshotResponse>) =>
    fn ??
    (() => Promise.reject(new Error('This host does not provide the records snapshot read (PanelContext.api)')));

const injectedDelta = (
    fn: ((sessionId: string, since: number) => Promise<RecordsDeltaResponse>) | undefined
): ((sessionId: string, since: number) => Promise<RecordsDeltaResponse>) =>
    fn ??
    (() => Promise.reject(new Error('This host does not provide the records delta read (PanelContext.api)')));

// A row is "just landed" ONLY when a live apply put it on screen. A bootstrap, a reset
// or a collections rebuild rebuilds everything at once, and lighting the whole list
// would say nothing about what is new. `bodies` counts: the debounced re-read that
// follows a burst may carry the first rows of a record the delta only named.
const isArrival = (notice: RecordsNotice): boolean =>
    !notice.replaced && (notice.reason === 'delta' || notice.reason === 'bodies');

const retryActionOf = (client: RecordsClient): { label: string; run: () => void } => ({
    label: 'Retry',
    run: () => void client.refresh('boot')
});

// ---------------------------------------------------------------------------
// Tasks — `harness.tasks`
// ---------------------------------------------------------------------------

// THE TWO MARKS a row is drawn with: a tick for completed, a cross for open — the same
// pair ../ui/tools.ts:307-315 uses for a tool call that succeeded and one that failed,
// so a shape means one thing across the whole shell. Both are `aria-hidden` in the row:
// the clipped state word beside them is what an assistive technology reads, so a screen
// reader never hears "tick" or "cross".
const TASKS_GLYPH_COMPLETED = '✓';
const TASKS_GLYPH_OPEN = '✕';

// The element id behind a row's `aria-controls`. A task id is unique inside its
// COLLECTION, not inside the document, and two Tasks panels can be mounted at once (a
// host that renders the board twice, or a test fixture with a broken card beside a
// working one), so a sequence this module owns is what makes `aria-controls` resolve to
// THIS row's detail area rather than to whichever panel appended first.
let tasksDetailSequence = 0;

// The session's shared task list: the `tasks` collection, whose fields are `text`
// (≤4000 chars), `completed` and `rev` (../shared/harness-api.ts; the store caps the
// collection at 200 entries — src/core/records.ts). The list has no owner and no claim
// concept, so nothing here invents one: the badge says who LAST CHANGED a row, which is
// a different fact from who owns it, and it reads `system` when the store named no
// caller (the attribution keys are simply absent in that case — see
// ./records-client.ts `recordsActorOf`).
//
// ORDER IS THE PANEL'S, NOT THE STORE'S. The store returns insertion order, which says
// nothing useful once rows start completing: pending rows sort newest-id-first (a fresh
// task appears at the top, where its "just landed" highlight is visible) and completed
// rows oldest-id-first, so a row that finishes moves to the far end of a short list
// instead of jumping onto the reader's rest position.
//
// IT IS DISPLAY-ONLY. A box that looks like a checkbox but does not write would be a
// lie, and the agent owns the store — a reader who wants a task ticked ticks it with a
// tool call, and the row moves a moment later.
//
// THE ROW IS THE CONTROL THOUGH. Pressing a row (mouse, Enter or Space — the collapsed
// row is a real `<button>`) opens the detail area with everything the tidy row left out:
// the full text, the actor / id / rev / stamp line, and this record's change history.
//
// A ROW IS A MARK AND A SENTENCE. A tick means completed and a cross means open — the
// same two glyphs ../ui/tools.ts:307-315 uses for a tool call that succeeded and one
// that failed, so a shape means one thing across the shell. The same fact is painted
// twice more (a green edge and wash for a completed row, an amber ones for an open one,
// both from `data-completed`), because the reader scans this rail rather than reading
// it. Colour is never the ONLY signal and there is never a strike: the glyph's SHAPE
// differs, the row carries `data-completed`, the group heading names the state, and the
// button's accessible name carries the word "completed"/"open" in a clipped span. Words
// are what the collapsed row gives up — an icon is identified faster than a label is
// read, and every word removed is a row the reader can see without scrolling.
export const mountTasksPanel = (ctx: PanelContext, options?: RecordsPanelOptions): void => {
    // `onNotice` is the panel's announcement hook: the engine calls it after every
    // state change (./records-panels.ts `createPanelMount`), which is the only place a
    // burst's row list exists — a later read of the client cannot tell which rows are new.
    const mount = createPanelMount(ctx, options, (notice) => {
        // Freshness comes from the notice, recorded BEFORE the paint that follows this
        // callback consumes the set. Only a live `add` of a task is an arrival: a row
        // that completes travels between groups, and a bootstrap paints the whole list.
        if (isArrival(notice)) {
            for (const row of notice.rows) {
                if (row.collection === TASKS_COLLECTION && row.op === 'add') fresh.add(row.id);
            }
        }

        announce(notice);
    });
    const now = mount.now;

    const body = recordsElement('div', 'panel-tasks-body');
    const progress = recordsElement('div', 'panel-tasks-progress');
    const status = recordsElement('p', 'panel-tasks-status');
    const bar = recordsElement('div', 'panel-tasks-bar');

    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');

    const chrome = recordsElement('p', 'panel-tasks-sync');

    chrome.dataset.state = 'live';
    chrome.hidden = true;
    progress.append(status, bar, chrome);

    const scroller = recordsElement('div', 'panel-tasks-scroller');
    const stateArea = recordsElement('div', 'panel-tasks-states');
    const listWrap = recordsElement('div', 'panel-tasks-lists');

    // Two groups rather than one list with a separator: a completed row is not
    // interesting in the same breath as an open one, and a group that empties out
    // removes its own heading instead of leaving a caption over nothing.
    const pendingHead = recordsElement('h3', 'panel-tasks-group-title', 'Pending');
    const pendingList = recordsElement('ol', 'panel-tasks-list');

    pendingList.dataset.group = 'pending';
    pendingList.setAttribute('aria-label', 'Pending tasks');

    const pendingGroup = recordsElement('div', 'panel-tasks-group', undefined, [pendingHead, pendingList]);

    const doneHead = recordsElement('h3', 'panel-tasks-group-title');
    const doneCount = recordsElement('span', 'panel-tasks-done-count', '0');

    doneHead.append(document.createTextNode('Completed '), doneCount);

    const doneList = recordsElement('ol', 'panel-tasks-list');

    doneList.dataset.group = 'done';
    doneList.setAttribute('aria-label', 'Completed tasks');

    const doneGroup = recordsElement('div', 'panel-tasks-group', undefined, [doneHead, doneList]);

    stateArea.hidden = true;
    listWrap.append(pendingGroup, doneGroup);

    // The pill is a child of the BODY, not of the scroller: it pins to the scroller's
    // box in CSS, and inside the scroller it would scroll away with the rows it counts.
    const pill = recordsNewPillOf();

    // The corner box: built ONCE, never re-inserted, and a child of the CARD rather than
    // of the body — a collapsed card has no body to pin it to. It starts hidden because a
    // card with no conversation has no state to report yet (./records-dom.ts
    // `recordsStatusOf`). `statusBox`, because `status` is already the progress sentence.
    const statusBox = recordsStatusOf('loading', PHASE_LABEL.loading);

    statusBox.hidden = true;
    body.append(progress, scroller, pill);
    scroller.append(stateArea, listWrap);
    ctx.element.append(mount.region, statusBox, body);

    // --- the collapse gate ---------------------------------------------------
    // Tasks ships OPEN: it is the card a reader glances at without thinking. The title
    // still closes it like any other card, and a closed card holds nothing — no client,
    // no plane registration, no announcements (`collapsePanel`, at the engine below).
    let panelExpanded = true;
    const toggle = titleToggleOf({
        ctx,
        label: 'Tasks',
        panel: 'tasks',
        body,
        onToggle: () => {
            if (panelExpanded) collapsePanel();
            else expandPanel();
        }
    });

    paintTitleToggle(toggle, 'Tasks', panelExpanded);

    // --- per-mount state -----------------------------------------------------
    const expanded = new Set<string>();
    const fresh = new Set<string>();
    // Row elements by task id, across BOTH groups. A row that completes is the same
    // record the reader was looking at, so its element — focus, text selection, open
    // disclosure — travels from the pending list to the done list instead of being
    // rebuilt. The map is maintained by `reconcile` (entries for removed keys are
    // dropped) and by `create`.
    const rows = new Map<string, HTMLElement>();

    // The client currently on screen. Row renderers read their history through this
    // (not through an argument) so a click-driven repaint and a frame-driven repaint
    // see exactly the same store — one source of truth for "what happened to this row".
    let current: RecordsClient | undefined;

    const historyFor = (collection: string, id: string): { items: RecordsFeedRow[]; truncated: boolean } =>
        current?.historyOf(collection, id) ?? { items: [], truncated: false };

    const freshMarker = createRecordsFreshMarker({ schedule: mount.schedule, signal: ctx.signal });
    const flip = createRecordsFlip({ schedule: mount.schedule, signal: ctx.signal });

    ctx.onDispose(() => {
        freshMarker.destroy();
        flip.destroy();
    });

    // The follow controller watches the scroller's BOTTOM edge: pending rows arrive at
    // the top and completed rows at the bottom, so the live edge of a task list is the
    // end of the done group, and an arrival at the top is what has to be compensated
    // for when the reader is down there.
    const controller = createRecordsFollow({
        scroller,
        pill,
        liveEdge: 'bottom',
        signal: ctx.signal
    });

    ctx.onDispose(() => controller.destroy());

    // A pane resize moves the live edge; without this the pill would keep counting
    // against a threshold that no longer matches the box on screen.
    globalThis.addEventListener?.('resize', () => controller.sync(), { signal: ctx.signal });

    // --- the row -------------------------------------------------------------
    // Built ONCE per task and never replaced by a repaint: the button and the detail
    // area are the two nodes that keep the reader's place (focus, text selection, an
    // open detail), while everything they CONTAIN is rewritten from the latest read on
    // every frame. A stream frame rebuilds the button's children — three spans — and
    // neither of them is focusable, so the reader's focus on the button survives it.
    const createRow = (task: RecordsTask): HTMLElement => {
        const row = recordsElement('li', 'panel-tasks-row');

        row.dataset.id = task.id;

        // A real `<button>`, not a click handler on a `<div>`: Enter and Space, the
        // focus ring and `aria-expanded` all come from the element the browser already
        // knows how to operate, and the whole collapsed row is its box.
        const head = recordsElement('button', 'panel-tasks-row-head');

        head.type = 'button';
        head.setAttribute('aria-expanded', 'false');

        const detail = recordsElement('div', 'panel-tasks-detail');

        tasksDetailSequence += 1;
        detail.id = `panel-tasks-detail-${tasksDetailSequence}`;
        // `hidden` is the fact; `aria-expanded` on the button is its mirror. Both are
        // repainted from the panel's `expanded` set, never from a click's own guess.
        detail.hidden = true;
        head.setAttribute('aria-controls', detail.id);

        // ONE listener for the life of the row. `reconcile` never rebuilds this node
        // (it moves it between the two groups and between repaints), so the target the
        // reader aims at cannot drift out from under the handler, and a frame that
        // re-renders this row re-arms nothing.
        head.addEventListener('click', () => toggleEvents(task.id));

        row.append(head, detail);

        return row;
    };

    const renderRow = (row: HTMLElement, task: RecordsTask): void => {
        // `createRow` above is the only producer of these two elements, so the casts
        // state the panel's invariant rather than a hope (same shape as the records
        // feed's `renderRow`, which reaches for its own persistent nodes).
        const head = row.querySelector<HTMLButtonElement>('.panel-tasks-row-head') as HTMLButtonElement;
        const detail = row.querySelector<HTMLElement>('.panel-tasks-detail') as HTMLElement;
        const preview = recordsTruncate(task.text);
        const isOpen = expanded.has(task.id);

        // The state as a SHAPE, and the state as a WORD. The shape is what a reader
        // identifies at a glance; the word is clipped out of the layout but sits inside
        // the button's accessible name, so a colour-blind reader, a forced-colours
        // mode and a screen reader all get the same fact without a single visible
        // label taking the row's space.
        const glyph = recordsElement('span', 'panel-tasks-glyph', task.completed ? TASKS_GLYPH_COMPLETED : TASKS_GLYPH_OPEN);

        glyph.setAttribute('aria-hidden', 'true');
        glyph.dataset.completed = String(task.completed);

        const stateWord = recordsElement('span', 'panel-tasks-row-state', task.completed ? 'completed' : 'open');
        const textNode = recordsElement('span', 'panel-tasks-row-text', preview.text);

        if (preview.truncated) textNode.title = task.text;

        if (task.text.length === 0) {
            // Nothing to show: an empty title, or a body this read never published. The
            // id in the detail area is then the only handle on the row, and the panel
            // says so where a sighted reader can see it too.
            textNode.dataset.missing = 'true';
            textNode.setAttribute('aria-label', `Task ${task.id}: no text in the last read`);
        }

        // The row's one fact, in one attribute: the stylesheet draws the glyph colour,
        // the edge and the wash from it, `reconcile` and the tests read it, and the
        // group heading above the list says the same thing in words.
        row.dataset.completed = String(task.completed);
        head.setAttribute('aria-expanded', String(isOpen));
        head.replaceChildren(glyph, stateWord, textNode);

        // --- the detail area: everything the collapsed row leaves out ---------
        detail.hidden = !isOpen;

        if (!isOpen) {
            // A closed detail carries nothing: the panel stays as light as it looks, and
            // the `aria-controls` target still exists for assistive tech to inspect.
            detail.replaceChildren();

            return;
        }

        const parts: HTMLElement[] = [];

        // The full text. The row shows a `RECORDS_TEXT_PREVIEW` preview, so the tail is
        // the reason the reader pressed; a row whose text already fits has nothing to
        // add, and repeating it would be the second line of the same sentence.
        if (preview.truncated) parts.push(recordsElement('p', 'panel-tasks-detail-text', task.text));
        else if (task.text.length === 0) parts.push(recordsElement('p', 'panel-tasks-detail-text', 'No text in the last read.'));

        // The facts that used to sit in the row itself: who last changed it, which
        // record it is, which revision, and when.
        const meta: HTMLElement[] = [
            recordsActorBadgeOf(recordsActorOf(task), 'panel-tasks-actor'),
            recordsElement('span', 'panel-tasks-id', `#${task.id}`),
            recordsElement('span', 'panel-tasks-rev', `r${task.rev}`)
        ];

        if (task.at !== undefined) meta.push(recordsStampOf(task.at, now(), 'panel-tasks-stamp'));

        parts.push(recordsElement('div', 'panel-tasks-detail-meta', undefined, meta));

        // What happened to this record — the body the "Show N changes" button used to
        // open, now part of opening the row. Read through `historyFor` (the client on
        // screen), so a click-driven repaint and a frame-driven repaint draw the same
        // history. A single event (its add) is not a history, and the row already says
        // everything it knows.
        const events = historyFor(TASKS_COLLECTION, task.id);

        if (events.items.length > 1) {
            parts.push(
                historyListOf(events.items, events.truncated, now(), {
                    list: 'panel-tasks-history',
                    truncated: 'panel-tasks-history-truncated'
                })
            );
        }

        detail.replaceChildren(...parts);
    };

    // The toggle writes the panel's own set FIRST and then repaints, so a stream frame
    // that re-renders this row in the same tick cannot resurrect a closed detail.
    const toggleEvents = (id: string): void => {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);

        repaint();
    };

    let repaint: () => void = () => undefined;

    // One keyed pass over one group. The element pool is shared across both groups, so
    // a row moving between them is a MOVE (its element travels), not a rebuild.
    const applyGroup = (
        list: HTMLElement,
        items: readonly RecordsTask[]
    ): { created: string[]; removed: string[]; moved: boolean } => {
        const applied = reconcile<RecordsTask>(list, {
            items,
            keyOf: (task) => task.id,
            // The pool is the panel's own row map: a task that moves between the two
            // groups is the SAME element, and a task that leaves the store is dropped by
            // the prune in `paint` (not here — a row on its way to the other group is
            // invisible to one group's pass and must not be discarded by it).
            pool: rows,
            create: (task) => {
                const row = createRow(task);

                rows.set(task.id, row);

                return row;
            },
            render: (node, task) => {
                rows.set(task.id, node);
                renderRow(node, task);
            },
            // Freshness is added, never removed here: the marker's own ~1.5s timer owns
            // the expiry, and the debounced body re-read that lands 150ms later must not
            // cut the highlight short on the row it just filled in.
            markNode: (node, isFresh) => {
                if (isFresh) freshMarker.mark(node);
            },
            fresh,
            busy: current?.phase() === 'loading'
        });

        return applied;
    };

    // --- the paint -----------------------------------------------------------
    const paint = (client: RecordsClient): void => {
        current = client;

        const tasks = client.tasks();
        const pending = tasks.filter((task) => !task.completed).sort((left, right) => compareIds(right.id, left.id));
        const done = tasks.filter((task) => task.completed).sort((left, right) => compareIds(left.id, right.id));
        const phase = recordsPanelPhaseOf(client, tasks.length);

        paintChrome(body, statusBox, chrome, phase, recordsSyncLineOf(client, now()));
        status.textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${done.length} completed · ${pending.length} open`;
        const percent = tasks.length === 0 ? 0 : Math.round((done.length / tasks.length) * 100);

        bar.setAttribute('aria-valuenow', String(percent));

        // The bar's fill and the figure an assistive tech reads are the SAME number:
        // the share is published as a custom property the stylesheet draws with
        // (../styles.css `.panel-tasks-bar`), so the two cannot drift apart.
        bar.style.setProperty('--records-progress', `${percent}%`);
        doneCount.textContent = String(done.length);

        // LOADING — the corner box says `reading` and the list chrome stays out of the
        // way. Nothing is inserted over the body: the card keeps its size, so a re-read
        // that comes and goes cannot flicker the tile the way a skeleton did.
        if (phase === 'loading') {
            pendingGroup.hidden = true;
            doneGroup.hidden = true;
            stateArea.hidden = true;
            stateArea.replaceChildren();

            return;
        }

        if (phase === 'empty') {
            pendingGroup.hidden = true;
            doneGroup.hidden = true;
            stateArea.hidden = false;
            stateArea.replaceChildren(
                recordsStateOf(
                    'panel-tasks-empty',
                    'empty',
                    'No tasks yet. This list fills when an agent writes to the session task store.'
                )
            );

            return;
        }

        if (phase === 'error') {
            pendingGroup.hidden = true;
            doneGroup.hidden = true;
            stateArea.hidden = false;
            stateArea.replaceChildren(
                recordsStateOf(
                    'panel-tasks-error',
                    'error',
                    `The task store could not be read: ${client.error() ?? 'no reason given'}.`,
                    retryActionOf(client)
                )
            );

            return;
        }

        // READY / STALE — the rows are on screen either way. STALE adds nothing here
        // except the chrome note (and its Retry): the data may be behind, but it is
        // still the last honest answer this panel has, and hiding it would be worse.
        stateArea.hidden = true;
        stateArea.replaceChildren();
        pendingGroup.hidden = pending.length === 0;
        doneGroup.hidden = done.length === 0;

        // FLIP: measure before the move, play after it. Each group animates only its
        // own rows — a task that completes appears as a fresh arrival at the bottom of
        // the done list, which is the honest reading of what the reader just saw.
        flip.measure(pendingList);
        flip.measure(doneList);

        const mark = controller.begin();
        const pendingApplied = applyGroup(pendingList, pending);
        const doneApplied = applyGroup(doneList, done);

        if (pendingApplied.moved || doneApplied.moved) {
            flip.play(pendingList);
            flip.play(doneList);
        }

        controller.commit(mark, pendingApplied.created.length + doneApplied.created.length);
        fresh.clear();

        // The row pool is pruned against the LIST, not against either group: a task that
        // changed groups is in the other pass, and only a task the store dropped is gone.
        // Its disclosure goes with it, so a re-added id cannot inherit a stale open state.
        const alive = new Set(tasks.map((task) => task.id));

        for (const id of [...rows.keys()]) {
            if (alive.has(id)) continue;

            rows.get(id)?.remove();
            rows.delete(id);
            expanded.delete(id);
        }
    };

    const paintNow = (): void => {
        // Closed: there is no engine to read from and nothing on screen to paint into,
        // so a late notice and the clock tick are both inert (the same guard the records
        // panel keeps).
        if (!panelExpanded) return;

        const client = mount.engine();

        if (client !== undefined) paint(client);
    };

    repaint = paintNow;

    // THE BOARD LOSES ITS CONVERSATION. A mount before any session draws nothing but its
    // live region — no `data-phase`, no rows, no chrome — so going back to no session has
    // to put the surface back there. Leaving a departed session's rows on screen would
    // describe a conversation the reader is no longer in, over a store this panel can no
    // longer read (its client is disposed).
    const clearSurface = (): void => {
        for (const list of [pendingList, doneList]) {
            list.replaceChildren();
            list.setAttribute('data-count', '0');
            list.setAttribute('aria-busy', 'false');
        }

        pendingGroup.hidden = true;
        doneGroup.hidden = true;
        stateArea.hidden = true;
        stateArea.replaceChildren();
        // A surface with nothing to report says nothing: the corner box goes blank with
        // the rows, rather than sitting there claiming a state no read backs.
        statusBox.hidden = true;
        statusBox.textContent = '';
        delete statusBox.dataset.state;
        chrome.hidden = true;
        chrome.textContent = '';
        pill.hidden = true;
        status.textContent = '';
        doneCount.textContent = '0';
        bar.removeAttribute('aria-valuenow');
        bar.style.setProperty('--records-progress', '0%');
        delete body.dataset.phase;
        body.removeAttribute('aria-busy');
    };

    // --- announcements -------------------------------------------------------
    // The row TEXT, never a count: "3 changes" tells a blind reader nothing they could
    // act on. `touched` is the client's list of collections whose entries or counts
    // moved, so a burst in another collection stays silent on this panel.
    const announce = (notice: RecordsNotice): void => {
        if (ctx.disposed) return;

        // A LINK notice touches no collection — it is the PLANE changing, so the guard
        // below cannot see it. The reader who was told "disconnected" is owed the
        // sentence that it is back, and what is on screen now: the delta a reconnect
        // triggers may find nothing new to report, and silence would leave
        // "disconnected" as the last thing they heard. A disconnect (`stale`) stays
        // silent here — the shared notice line already covers it.
        const reconnected = notice.reason === 'link' && notice.link === 'live';

        if (!notice.touched.includes(TASKS_COLLECTION) && !reconnected) return;

        if (notice.rows.length === 0) {
            mount.announcer.say(
                notice.replaced
                    ? 'The task list was re-read.'
                    : `${mount.engine()?.tasks().length ?? 0} tasks on the list.`
            );

            return;
        }

        for (const row of notice.rows) {
            if (row.collection !== TASKS_COLLECTION) continue;

            const actor = recordsActorOf(row);

            if (row.op === 'add') mount.announcer.say(`${actor.name} added a task: ${row.label || `task ${row.id}`}.`);
            if (row.op === 'remove') mount.announcer.say(`${actor.name} removed task ${row.id}.`);

            if (row.op === 'update') {
                const completed = row.changes.find((change) => change.field === 'completed');

                if (completed?.after === 'true') mount.announcer.say(`${actor.name} completed: ${row.label || `task ${row.id}`}.`);
                else if (completed?.after === 'false') mount.announcer.say(`${actor.name} reopened: ${row.label || `task ${row.id}`}.`);
                else if (row.changes.some((change) => change.field === 'text')) {
                    mount.announcer.say(`${actor.name} changed a task's text: ${row.label || `task ${row.id}`}.`);
                }
            }
        }
    };

    // --- the collapse gate ---------------------------------------------------
    // Closing the card releases the conversation exactly the way a session switch does:
    // the wake first, then the client, then the surface. Re-opening is a fresh boot, not
    // a resurrection of rows nothing was reading.
    const collapsePanel = (): void => {
        panelExpanded = false;
        paintTitleToggle(toggle, 'Tasks', false);
        body.hidden = true;
        mount.stopEngine();
        expanded.clear();
        fresh.clear();
        rows.clear();
        current = undefined;
        freshMarker.clearAll();
        flip.reset();
        clearSurface();
    };

    const expandPanel = (): void => {
        panelExpanded = true;
        paintTitleToggle(toggle, 'Tasks', true);
        body.hidden = false;

        // No conversation: the card opens onto the cleared surface and waits, exactly as
        // a mount with no session draws.
        if (ctx.sessionId !== null) {
            mount.retarget(ctx.sessionId, paintNow);
            paintNow();
        }
    };

    // --- the engine ----------------------------------------------------------
    const clock = globalThis.setInterval(() => {
        // A closed card has nothing to re-age and no engine to repaint; the tick must not
        // be the thing that keeps a collapsed panel "working".
        if (ctx.disposed || !panelExpanded) return;

        refreshRecordsStamps(ctx.element, now());
        paintNow();
    }, options?.tickMs ?? RECORDS_CLOCK_TICK_MS);

    ctx.onDispose(() => globalThis.clearInterval(clock));

    if (ctx.sessionId !== null) {
        mount.retarget(ctx.sessionId, paintNow);
        paintNow();
    }

    ctx.onSessionChange(() => {
        // A session-scoped panel is normally DISPOSED on a switch rather than told
        // about one; a host that does notify gets a clean re-target — the old store's
        // rows, disclosures and highlights are dropped before the new session reads.
        mount.stopEngine();
        expanded.clear();
        fresh.clear();
        rows.clear();
        current = undefined;
        freshMarker.clearAll();
        flip.reset();

        // Closed, or no conversation to read: the surface goes back to blank and waits.
        if (ctx.sessionId === null || !panelExpanded) {
            clearSurface();

            return;
        }

        mount.retarget(ctx.sessionId, paintNow);
    });
};

// Id ordering. Ids are the store's own and unique per collection, which is exactly why
// they are also the reconciliation key: an `update` keeps the id (a feed `seq` would
// re-key a record on every edit and animate it as a new arrival).
const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
// ---------------------------------------------------------------------------
// Records — `harness.records`
// ---------------------------------------------------------------------------

// The session's change feed: every event the record store retained, newest first. This
// is the panel that proves the realtime plane is working, so it is the one that carries
// the whole reading-position story — a feed grows at the TOP, which is exactly where a
// reader in the middle of it must not be dragged to.
//
// THE FILTER IS LOCAL. The feed is a bounded window (the store retains
// `RECORDS_FEED_WINDOW` events; the client caps its own accumulation at
// `RECORDS_FEED_LIMIT`), and the chips narrow THAT window — they are not a server
// query. The footer therefore always states what the reader is looking at, including
// when the window has already dropped older events.
//
// THE VALUES ARE BEST-KNOWN, NOT HISTORICAL. A change row names the fields it touched
// and carries no values (../shared/harness-api.ts `RecordChangeRow.fields`), so a live
// row knows the value BEFORE (it was on screen) and the debounced body re-read fills in
// the value AFTER for the newest row of that record only. An intermediate value in a
// mid-burst row is not knowable, and this panel says `—` rather than inventing one
// (./records-client.ts `RecordsFieldChange`).
//
// THE PANEL SHIPS COLLAPSED. The card mounts with its body hidden and its engine
// UNBUILT: no snapshot read, no wake registration, no clock work — a panel the reader
// has not opened holds no plane slot and pays for no read. The card's own title is the
// toggle, and the only thing that starts the engine; collapsing releases the wake and the client and
// clears the surface, so a re-opening is a fresh boot. The open/closed choice belongs
// to the reader: it survives a session change delivered to a mounted card, while the
// runtime's own path for this session-scoped panel — a dispose and re-mount per
// conversation — starts every conversation collapsed again.
export const mountRecordsPanel = (ctx: PanelContext, options?: RecordsPanelOptions): void => {
    const mount = createPanelMount(ctx, options, (notice) => {
        // Every row a live apply added is an arrival: this panel IS the event log, so a
        // new feed row is a change that just landed. Recorded before the paint that
        // consumes the set — the rows are keyed by `seq`, the feed's own identity.
        if (isArrival(notice)) {
            for (const row of notice.rows) fresh.add(String(row.seq));
        }

        announce(notice);
    });
    const now = mount.now;

    const body = recordsElement('div', 'panel-records-body');
    const filters = recordsElement('div', 'panel-records-filters');

    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter the change feed by collection');

    const chrome = recordsElement('p', 'panel-records-sync');

    chrome.dataset.state = 'live';
    chrome.hidden = true;

    const scroller = recordsElement('div', 'panel-records-scroller');
    const stateArea = recordsElement('div', 'panel-records-states');
    const feed = recordsElement('ol', 'panel-records-feed');

    feed.setAttribute('aria-label', 'Record changes');

    const pill = recordsNewPillOf();
    const footer = recordsElement('p', 'panel-records-footer');

    // The corner box (./records-dom.ts `recordsStatusOf`): one fixed box in the card's
    // top-right corner that names the state, in place of a skeleton that came and went
    // over the feed. A child of the CARD, not of the body, because a collapsed card has
    // no body to hold it.
    const statusBox = recordsStatusOf('loading', PHASE_LABEL.loading);

    statusBox.hidden = true;
    stateArea.hidden = true;
    // COLLAPSED BY DEFAULT: the body starts hidden and stays that way until the reader
    // opens the card by pressing its title (the collapse gate below). Nothing is read
    // while it is.
    body.hidden = true;
    body.append(filters, chrome, scroller, pill, footer);
    scroller.append(stateArea, feed);
    ctx.element.append(mount.region, statusBox, body);

    // --- per-mount state -----------------------------------------------------
    // `null` is "all collections": the client publishes no collection list until the
    // first read, so the filter starts open rather than guessing a name.
    let filter: string | null = null;
    const expanded = new Set<string>();
    const fresh = new Set<string>();
    let current: RecordsClient | undefined;
    // The panel-level gate. `false` is the shipped default (collapsed): no engine,
    // no reads, no registration on the plane. This is a different dimension from the
    // row-level `expanded` set above, which says which records show their history.
    let panelExpanded = false;

    const historyFor = (collection: string, id: string): { items: RecordsFeedRow[]; truncated: boolean } =>
        current?.historyOf(collection, id) ?? { items: [], truncated: false };

    const freshMarker = createRecordsFreshMarker({ schedule: mount.schedule, signal: ctx.signal });
    const flip = createRecordsFlip({ schedule: mount.schedule, signal: ctx.signal });

    ctx.onDispose(() => {
        freshMarker.destroy();
        flip.destroy();
    });

    // A newest-first feed has its live edge at scrollTop 0: the reader is "following"
    // only while they are looking at the top, and every arrival above that point is a
    // row they have to be TOLD about rather than a row they get shoved into.
    const controller = createRecordsFollow({
        scroller,
        pill,
        liveEdge: 'top',
        threshold: RECORDS_LIVE_EDGE_THRESHOLD,
        signal: ctx.signal
    });

    ctx.onDispose(() => controller.destroy());

    globalThis.addEventListener?.('resize', () => controller.sync(), { signal: ctx.signal });

    // --- the row -------------------------------------------------------------
    const createRow = (row: RecordsFeedRow): HTMLElement => {
        const node = recordsElement('li', 'panel-records-row');

        node.dataset.id = row.id;
        node.dataset.collection = row.collection;
        node.append(
            recordsElement('div', 'panel-records-row-head'),
            recordsElement('ul', 'panel-records-changes')
        );

        return node;
    };

    const renderRow = (node: HTMLElement, row: RecordsFeedRow): void => {
        const actor = recordsActorOf(row);
        const label = row.label.length > 0
            ? recordsTruncate(row.label)
            : { text: row.known ? '(no title in this collection)' : '(no text in this read)', truncated: false };
        const head = node.querySelector<HTMLElement>('.panel-records-row-head') as HTMLElement;
        const op = recordsElement('span', 'panel-records-op', row.op);

        op.dataset.op = row.op;

        const textNode = recordsElement('span', 'panel-records-text', label.text);

        if (row.label.length === 0) textNode.dataset.missing = 'true';
        if (label.truncated) textNode.title = row.label;

        const parts: HTMLElement[] = [
            recordsActorBadgeOf(actor, 'panel-records-actor'),
            op,
            recordsElement('span', 'panel-records-collection', row.collection),
            recordsElement('span', 'panel-records-id', `#${row.id}`),
            textNode,
            recordsStampOf(row.at, now(), 'panel-records-stamp'),
            recordsElement('span', 'panel-records-seq', `#${row.seq}`)
        ];

        head.replaceChildren(...parts);

        // The field-level detail: what this event says changed, and the values this
        // client can vouch for. An absent value renders `—`, never an empty cell that
        // reads as "cleared".
        const changes = node.querySelector<HTMLElement>('.panel-records-changes') as HTMLElement;

        changes.replaceChildren(
            ...row.changes.map((change) => {
                const item = recordsElement('li', 'panel-records-change');

                item.append(
                    recordsElement('span', 'panel-records-change-field', change.field),
                    recordsElement('span', 'panel-records-change-value', change.before ?? '—')
                );

                const arrow = recordsElement('span', 'panel-records-change-arrow', '→');

                arrow.setAttribute('aria-hidden', 'true');
                item.append(arrow);

                if (change.after === undefined) {
                    // Not knowable: the row carried no values and this client has not
                    // re-read this record's body since. Saying so IS the answer.
                    const unknown = recordsElement('span', 'panel-records-change-value', '—');

                    unknown.dataset.unknown = 'true';
                    unknown.title = 'The new value is not in the last read of this record';
                    item.append(unknown);

                    return item;
                }

                const after = recordsTruncate(change.after);
                const afterNode = recordsElement('span', 'panel-records-change-value', after.text);

                if (after.truncated) afterNode.title = change.after;
                item.append(afterNode);

                return item;
            })
        );

        // A row about a record with a single event has no story; the row is the story.
        const events = historyFor(row.collection, row.id);

        if (events.items.length <= 1) return;

        const isOpen = expanded.has(`${row.collection}/${row.id}`);

        expandButtonOf(node, () => toggleEvents(row), isOpen, events.items.length);

        if (!isOpen) return;

        node.append(
            recordsElement(
                'div',
                'panel-records-disclosure',
                undefined,
                [
                    historyListOf(events.items, events.truncated, now(), {
                        list: 'panel-records-history',
                        truncated: 'panel-records-history-truncated'
                    })
                ]
            )
        );
    };

    const toggleEvents = (row: RecordsFeedRow): void => {
        const key = `${row.collection}/${row.id}`;

        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);

        paintNow();
    };

    let paintNow: () => void = () => undefined;

    // --- the collection chips ------------------------------------------------
    // One chip per collection the store published, each carrying the number of feed
    // events it accounts for. A collection that exists but has no events still gets a
    // chip (the reader can see the store's shape), and the "All" chip is never
    // unreachable: the filter is a LOCAL narrowing of a bounded window, so escaping it
    // is one click.
    const paintChips = (client: RecordsClient): void => {
        const counts = new Map<string, number>();

        for (const row of client.feed()) counts.set(row.collection, (counts.get(row.collection) ?? 0) + 1);

        const chips: HTMLElement[] = [chipOf(RECORDS_ALL_CHIP, 'All', client.feed().length)];

        for (const collection of client.collections()) chips.push(chipOf(collection.name, collection.name, counts.get(collection.name) ?? 0));

        for (const name of counts.keys()) {
            // A collection dropped since its events were retained still has a feed, and
            // a feed with no chip is a filter the reader cannot escape.
            if (client.collection(name) === undefined) chips.push(chipOf(name, name, counts.get(name) ?? 0));
        }

        filters.replaceChildren(
            recordsElement('span', 'panel-records-filter-label', 'Collections'),
            ...chips
        );
    };

    const chipOf = (name: string, text: string, count: number): HTMLButtonElement => {
        const chip = recordsElement('button', 'panel-records-chip') as HTMLButtonElement;

        chip.type = 'button';
        chip.dataset.collection = name;

        // The neutral chip is pressed whenever NOTHING is narrowed (`filter === null`);
        // every other chip is pressed only while it is the narrowing.
        const active = name === RECORDS_ALL_CHIP ? filter === null : filter === name;

        chip.dataset.active = String(active);
        chip.setAttribute('aria-pressed', String(active));

        // The count is in the button's OWN text: `aria-pressed` tells a screen reader
        // which chip is on, and the text tells them how much that chip is worth.
        chip.textContent = `${text} (${count})`;
        chip.addEventListener('click', () => {
            // Pressing the neutral chip — or a chip that is already on — clears the
            // narrowing; pressing another one moves the feed to it.
            filter = name === RECORDS_ALL_CHIP || filter === name ? null : name;
            paintNow();
        });

        return chip;
    };

    // --- the paint -----------------------------------------------------------
    const paint = (client: RecordsClient): void => {
        current = client;

        const feedRows = client.feed();
        const rows = filter === null ? feedRows : feedRows.filter((row) => row.collection === filter);
        const newestFirst = [...rows].reverse();
        const phase = recordsPanelPhaseOf(client, feedRows.length);

        paintChrome(body, statusBox, chrome, phase, recordsSyncLineOf(client, now()));
        paintChips(client);

        // LOADING: the corner box says `reading`, the footer says the sentence, and the
        // feed stays out of the way. Nothing is inserted over the scroller, so the card
        // never resizes and the tile never flickers.
        if (phase === 'loading') {
            feed.hidden = true;
            stateArea.hidden = true;
            stateArea.replaceChildren();

            paintFooter(client, phase, 0, 0);

            return;
        }

        if (phase === 'empty') {
            feed.hidden = true;
            stateArea.hidden = false;
            stateArea.replaceChildren(
                recordsStateOf(
                    'panel-records-empty',
                    'empty',
                    'No record changes yet. The store fills as agents write — a task created, a chapter saved.'
                )
            );
            paintFooter(client, phase, 0, 0);

            return;
        }

        if (phase === 'error') {
            feed.hidden = true;
            stateArea.hidden = false;
            stateArea.replaceChildren(
                recordsStateOf(
                    'panel-records-error',
                    'error',
                    `The record store could not be read: ${client.error() ?? 'no reason given'}.`,
                    retryActionOf(client)
                )
            );
            paintFooter(client, phase, 0, 0);

            return;
        }

        // READY / STALE. The feed keeps its rows in both: a disconnected plane is a
        // warning about the future, not a reason to lose the present.
        stateArea.hidden = true;
        stateArea.replaceChildren();
        feed.hidden = false;

        // The frozen reader gets a count, not a shove: measure the rows that are about
        // to land ABOVE them, hold their position by exactly that height, and let the
        // pill say how much they missed. The measure is the FEED's first row — a new
        // event is prepended above it — because the scroller's first child is the state
        // area, which never moves (./records-dom.ts `createRecordsFollow.begin`).
        const edgeRow = feed.firstElementChild;
        const mark = controller.begin(
            edgeRow instanceof HTMLElement ? edgeRow.getBoundingClientRect().height : 0
        );

        flip.measure(feed);

        const applied = reconcile<RecordsFeedRow>(feed, {
            items: newestFirst,
            keyOf: (row) => String(row.seq),
            create: (row) => createRow(row),
            render: (node, row) => renderRow(node, row),
            // Added, never removed: the marker's own timer owns the expiry, so a row that
            // is re-rendered by the debounced body re-read keeps its highlight.
            markNode: (node, isFresh) => {
                if (isFresh) freshMarker.mark(node);
            },
            fresh,
            busy: client.phase() === 'loading'
        });

        if (applied.moved) flip.play(feed);

        controller.commit(mark, applied.created.length);
        fresh.clear();

        // `shown` is what is ON screen and `windowed` is what the store kept, so a filter
        // narrows the first number without pretending the log got shorter.
        paintFooter(client, phase, newestFirst.length, feedRows.length);
    };

    // The footer is the panel's honesty about its own window: how much of the log is on
    // screen, and what the store stopped keeping.
    const paintFooter = (client: RecordsClient, phase: RecordsPanelPhase, shown: number, windowed: number): void => {
        if (phase === 'loading') {
            footer.textContent = 'Reading the record store…';
            footer.dataset.state = 'loading';

            return;
        }

        const parts = [`${shown} of ${windowed} retained changes`];

        if (client.feedTruncated()) {
            parts.push(
                `the store keeps its last ${RECORDS_FEED_WINDOW} events, so older changes are not shown`
            );
        }

        if (filter !== null) parts.push(`filtered to ${filter}`);

        footer.textContent = parts.join(' · ');
        footer.dataset.state = client.feedTruncated() ? 'truncated' : 'live';
    };

    paintNow = (): void => {
        // Collapsed: there is no engine to read from and nothing on screen to paint
        // into. This guard is what keeps a late notice and the clock tick inert
        // while the card is closed.
        if (!panelExpanded) return;

        const client = mount.engine();

        if (client !== undefined) paint(client);
    };

    // THE BOARD LOSES ITS CONVERSATION. Same rule as the tasks panel: the surface goes
    // back to what a mount with no session draws (live region only, no `data-phase`, no
    // rows). The chips go with it — they are the departed session's collection list, and
    // `paintChips` rebuilds them from scratch on the next paint, so nothing is orphaned.
    const clearSurface = (): void => {
        feed.hidden = true;
        feed.replaceChildren();
        feed.setAttribute('data-count', '0');
        feed.setAttribute('aria-busy', 'false');
        stateArea.hidden = true;
        stateArea.replaceChildren();
        // Nothing to report, so nothing claimed: the corner box goes blank with the feed.
        statusBox.hidden = true;
        statusBox.textContent = '';
        delete statusBox.dataset.state;
        chrome.hidden = true;
        chrome.textContent = '';
        filters.replaceChildren();
        // The follow controller owns the pill's visibility (`pill.hidden = !show`);
        // hiding it here only says there is nothing left to jump back to.
        pill.hidden = true;
        footer.textContent = '';
        footer.dataset.state = 'live';
        delete body.dataset.phase;
        body.removeAttribute('aria-busy');
    };

    // --- announcements -------------------------------------------------------
    // Sentences a sighted reader gets for free — "a new row appeared, and this is what
    // it says" — which is why they carry the record's TEXT and the actor's name, never
    // a bare count. The announcer keeps the last three lines of a burst and writes them
    // once, so a 40-record import costs one announcement rather than 40.
    const announce = (notice: RecordsNotice): void => {
        if (ctx.disposed) return;

        if (notice.rows.length === 0) {
            // `replaced` is a wholesale re-read; a RECONNECT is the plane coming back and
            // the delta it triggers may land empty. Either way the reader is owed the
            // sentence about what is on screen now, and a disconnect (`stale`) stays
            // silent here because the shared notice line already says that part.
            if (notice.replaced || (notice.reason === 'link' && notice.link === 'live')) {
                mount.announcer.say(`${mount.engine()?.feed().length ?? 0} record changes on screen.`);
            }

            return;
        }

        for (const row of notice.rows) {
            mount.announcer.say(rowSentenceOf(row));
        }

        if (notice.rows.length > 1) mount.announcer.say(`${notice.rows.length} changes applied.`);
    };

    // --- the collapse gate ---------------------------------------------------
    // The card ships CLOSED (the body above starts `hidden`). While it is closed the
    // conversation's record store costs the page nothing: no snapshot read, no delta,
    // no registration on the plane — the engine is simply never built. Opening the
    // card is what builds it; closing it again releases the wake and the client
    // (`stopEngine`, the same order a session switch uses) and clears the surface, so
    // a re-opening is a fresh boot rather than a resurrection of rows nothing is
    // reading anymore. THE CONTROL IS THE CARD'S OWN HEADING (`titleToggleOf`): the word
    // "Records" is a real `<button>`, and `aria-expanded` on it is the one state claim.
    // There is no second "Show records" button — a card whose title is the toggle does
    // not need a caption telling the reader what to press.
    const toggle = titleToggleOf({
        ctx,
        label: 'Records',
        panel: 'records',
        body,
        onToggle: () => {
            if (panelExpanded) collapsePanel();
            else expandPanel();
        }
    });

    paintTitleToggle(toggle, 'Records', panelExpanded);

    const collapsePanel = (): void => {
        panelExpanded = false;
        paintTitleToggle(toggle, 'Records', false);
        body.hidden = true;
        mount.stopEngine();
        expanded.clear();
        fresh.clear();
        current = undefined;
        filter = null;
        freshMarker.clearAll();
        flip.reset();
        clearSurface();
    };

    const expandPanel = (): void => {
        panelExpanded = true;
        paintTitleToggle(toggle, 'Records', true);
        body.hidden = false;

        // No conversation: the card opens onto the cleared surface and waits, exactly
        // as a mount with no session draws.
        if (ctx.sessionId !== null) {
            mount.retarget(ctx.sessionId, paintNow);
            paintNow();
        }
    };

    // --- the engine ----------------------------------------------------------
    const clock = globalThis.setInterval(() => {
        // A closed card has nothing to re-age and no engine to repaint; the tick must
        // not be the thing that keeps a collapsed panel "working".
        if (ctx.disposed || !panelExpanded) return;

        refreshRecordsStamps(ctx.element, now());
        paintNow();
    }, options?.tickMs ?? RECORDS_CLOCK_TICK_MS);

    ctx.onDispose(() => globalThis.clearInterval(clock));

    ctx.onSessionChange(() => {
        // A fresh conversation is a fresh store: the window, the filter and every open
        // disclosure belong to the conversation that is going away.
        mount.stopEngine();
        expanded.clear();
        fresh.clear();
        current = undefined;
        filter = null;
        freshMarker.clearAll();
        flip.reset();

        if (ctx.sessionId === null || !panelExpanded) {
            clearSurface();

            return;
        }

        // The reader had the card open: the open state is the reader's choice, so the
        // conversation that arrived is read at once. The runtime's own path for this
        // session-scoped panel is a dispose and re-mount — a fresh card starts
        // collapsed again.
        mount.retarget(ctx.sessionId, paintNow);
    });
};

// One event, in a sentence. `known` is the client's flag for "a body backed this
// label", so an add whose text has not landed yet says so instead of announcing an
// anonymous record (`./records-client.ts` resolves a label only from state it holds).
const rowSentenceOf = (row: RecordsFeedRow): string => {
    const actor = recordsActorOf(row);
    const what = row.label.length > 0 ? row.label : `${row.collection} ${row.id}`;

    if (row.op === 'add') return `${actor.name} added ${what}.`;
    if (row.op === 'remove') return `${actor.name} removed ${what}.`;

    const fields = row.changes.map((change) => change.field);

    if (fields.length === 0) return `${actor.name} updated ${what}.`;

    const value = row.changes.find((change) => change.after !== undefined);

    return value === undefined
        ? `${actor.name} updated ${what}: ${fields.join(', ')} — the new values are not in this read.`
        : `${actor.name} updated ${what}: ${fields.join(', ')}.`;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// The two built-ins, in the order the board draws them (Tasks first: it is the shorter
// read and the one a reader checks for "is the agent done with its list"). Both declare
// `requiresSession`, which is what keeps them off the board during boot — the shell
// paints once before the remembered conversation has been read, and a live panel
// mounted there would be disposed seconds later by the session arriving. Declaring the
// need means each panel mounts exactly once, with a real session id to read with.
//
// `registerBuiltinShellPanels` is IDEMPOTENT: re-registering an id replaces its record
// (./shell-panels.ts), so a hot reload does not stack two Tasks cards on the board.
export const registerBuiltinShellPanels = (): (() => void) => {
    const offTasks = registerShellPanel({
        id: HARNESS_TASKS_PANEL_ID,
        title: 'Tasks',
        slot: 'scratch',
        order: TASKS_PANEL_ORDER,
        scope: 'session',
        requiresSession: true,
        mount: (ctx) => mountTasksPanel(ctx)
    });

    const offRecords = registerShellPanel({
        id: HARNESS_RECORDS_PANEL_ID,
        title: 'Records',
        slot: 'scratch',
        order: RECORDS_PANEL_ORDER,
        scope: 'session',
        requiresSession: true,
        mount: (ctx) => mountRecordsPanel(ctx)
    });

    return () => {
        offRecords();
        offTasks();
    };
};

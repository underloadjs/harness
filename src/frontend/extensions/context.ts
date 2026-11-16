// PanelContext: the disposal-scoped capability bag a mounted panel is handed (T5/R1).
//
// WHY THIS EXISTS
// ---------------
// A shell panel is long-lived code the shell does not know: it adds listeners, it
// subscribes to the realtime plane, it reads the API. Every one of those is a leak
// the moment the conversation it belongs to is switched or closed. This module turns
// those capabilities into things the runtime can REVOKE: the context hands out a
// subscription instead of the socket, a disposer list instead of an unload hook, and
// an `AbortSignal` instead of raw `addEventListener`. Disposal is then one call, and
// "no leaked listeners/timers" is a property of the runtime rather than of each
// plugin's discipline.
//
// WHAT IS DELIBERATELY ABSENT
// ---------------------------
// No framework, no reactive store, no re-render loop: this app is vanilla DOM. A
// panel paints into `context.element` with the same `createElement`/`textContent`
// discipline the rest of the frontend uses, and owns its own update schedule. The
// `api` surface is the shell's EXISTING client (./view-api.ts + ./api.ts) passed
// through — one transport, one resolved API root, no parallel fetch layer.
//
// Cross-references:
//   - ../stream.ts     — the one `harness.v1` client this wraps (scoped subscriptions)
//   - ../view-api.ts   — the lazy REST reads this wraps
//   - ./runtime.ts     — creates a context per mounted panel and disposes it
//   - ./panel-kinds.ts — the other seam (stateless renderers, no context)

import type { PageQuery } from '../api';
import { apiUrl, request } from '../api';
import type { StreamSubscription, StreamSubscriptionSpec } from '../stream';
import { harnessStream } from '../stream';
import * as viewApi from '../view-api';
import type { PanelSlot } from '../ui/panels';

// ---------------------------------------------------------------------------
// The API surface
// ---------------------------------------------------------------------------

// The pass-through client. Named `read*`/`list*` like ./view-api.ts so a plugin
// author reading either file sees the same verbs; every member returns exactly what
// the underlying client returns, including its rejections.
export const panelApi = {
    /** Absolute or root-relative URL for a contract route (./api.ts `apiUrl`). */
    url: apiUrl,
    /** The transport every request in this package goes through (./api.ts `request`). */
    request,
    /** One conversation's render model (./view-api.ts `openSession`). */
    readSession: (sessionId: string, options?: viewApi.OpenSessionOptions) => viewApi.openSession(sessionId, options),
    /** One turn's full display tree (./view-api.ts `readTurnDisplay`). */
    readTurnDisplay: viewApi.readTurnDisplay,
    /** One row (./view-api.ts `readTurnRow`). */
    readTurnRow: viewApi.readTurnRow,
    /** One step's recorded bytes — the payload a compact card does not ship. */
    readStepDetail: viewApi.readStepDetail,
    /** One context-bar segment's bytes. */
    readBlockDetail: viewApi.readBlockDetail,
    /** The frozen definition of a conversation (its team, models, toolbox). */
    readDefinition: viewApi.readDefinition,
    /** Token/cost accounting for one conversation. */
    readUsage: viewApi.readUsage,
    /** The server's queue for one conversation. */
    readQueue: viewApi.readQueue,
    /** The pending approval actions of one conversation. */
    readActions: viewApi.readActions,
    /** One thread's transcript. */
    readTranscript: viewApi.readTranscript,
    /** The conversation directory, one bounded page at a time (`Page<SessionSummary>`). */
    listSessions: (query: PageQuery = {}) => viewApi.listSessionPage(query),
    /** Stop a conversation's live work (an unsubscribe, never a cancel of the run). */
    stopConversation: (sessionId: string, all = true) => viewApi.stopConversation(sessionId, all),
    /** Submit a task into one conversation. */
    submitConversation: viewApi.submitConversationTask,
    /** Every collection plus the retained change feed — the live panel's bootstrap (./view-api.ts). */
    readRecordsSnapshot: viewApi.readRecordsSnapshot,
    /** The feed rows after one store position — the live panel's delta (./view-api.ts). */
    readRecordsDelta: viewApi.readRecordsDelta
};

export type PanelApi = typeof panelApi;

// What a host may inject as `PanelContext.api`: EVERY member is optional. A test host
// (and a plugin host that only needs one route) supplies the reads it implements, and
// the panel it feeds is responsible for the read it performs. Keeping this partial
// means adding a capability to `panelApi` above can never break an existing host.
export type PanelApiOverrides = { [Key in keyof PanelApi]?: PanelApi[Key] };

// ---------------------------------------------------------------------------
// The realtime surface
// ---------------------------------------------------------------------------

// A subscription request as a panel writes it: `sessionId` is optional because a
// session-scoped panel is told which conversation it belongs to and should not have
// to repeat it.
export type PanelSubscriptionSpec = Omit<StreamSubscriptionSpec, 'sessionId'> & { sessionId?: string };

// The injectable seam. Returns `undefined` when the host has no realtime plane at
// all (a bare Node test host), which the context treats as "no subscription", never
// as an error.
export type PanelSubscribe = (spec: PanelSubscriptionSpec) => StreamSubscription | undefined;

// The default: the process-wide `harness.v1` client (./stream.ts:647 onward). One
// connection per page is the contract's rule, so a panel never dials its own socket;
// `connect()` is idempotent and a subscription made while reconnecting is queued by
// that client rather than lost (./stream.ts:129-135).
export const defaultPanelSubscribe: PanelSubscribe = (spec) => {
    const client = harnessStream();
    client.connect();

    return client.subscribe(spec);
};

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export type PanelContextInput = {
    /** The panel's registry id (a shell panel) — carried for diagnostics. */
    id: string;
    slot: PanelSlot;
    /** The container the panel paints into; already in the host when mounted. */
    element: HTMLElement;
    /** LIVE read of the session this panel is drawing (null = no conversation). */
    sessionId: () => string | null;
    /** Partial override of the API surface; anything missing falls back to `panelApi`. */
    api?: PanelApiOverrides;
    subscribe?: PanelSubscribe;
    /** Paints the card heading; the runtime installs it, a bare host may omit it. */
    title?: string;
};

export type PanelContext = {
    readonly id: string;
    readonly slot: PanelSlot;
    /** The panel's own container. Fill it; never replace the host above it. */
    readonly element: HTMLElement;
    /**
     * The conversation this panel belongs to, or null. Live: an app-scoped panel
     * reads the current session here after a change (a session-scoped panel is
     * disposed by the same change, so for it the value never moves).
     */
    readonly sessionId: string | null;
    /** The API surface: `panelApi` with whatever the host injected on top. */
    readonly api: PanelApi;
    /** Aborted on dispose — the cheap way to retire listeners, controllers and timeouts. */
    readonly signal: AbortSignal;
    /** True once this context has been disposed; every capability below is then inert. */
    readonly disposed: boolean;
    /**
     * Subscribes to the shared realtime plane for THIS panel. The subscription is
     * released by `dispose()`, and the spec's `sessionId` defaults to this panel's
     * session. Returns undefined when disposed or when the host has no plane.
     */
    subscribe(spec: PanelSubscriptionSpec): StreamSubscription | undefined;
    /**
     * Registers teardown (clear timers, remove listeners the panel added by hand).
     * Runs exactly once, in reverse order of registration. The returned function
     * removes the disposer without disposing the panel. Registering on a disposed
     * context runs the callback immediately — a late async answer must not leak.
     */
    onDispose(dispose: () => void): () => void;
    /**
     * The RAW seam this context dials through: the host's own `subscribe`, or the
     * page's shared client. Reference-stable across every panel of one host, which is
     * what a panel sharing a plane registration with its siblings must key on
     * (./records-wake.ts) — `subscribe` below is a per-context wrapper, so two panels
     * of the same host would otherwise look like two different hosts and each hold
     * their own slot.
     */
    readonly subscribeSeam: PanelSubscribe;
    /**
     * Session-change notification. A SESSION-scoped panel never sees one (it is
     * disposed instead), so this is the app-scoped panel's way to re-target a live
     * read. Returns the unsubscribe.
     */
    onSessionChange(listener: (sessionId: string | null) => void): () => void;
    /** Rewrites the card heading; an empty title removes it. */
    setTitle(title: string): void;
    /**
     * Whether this panel's SLOT is on screen right now (T5/R3). `true` is the shipped
     * default and only the host can move it (./runtime.ts delivers it from
     * `PanelPaintInput.visibility`), so a host that never touches the seam leaves every
     * panel visible. The one host that does is the phone scratch drawer: a card inside a
     * closed drawer cannot be looked at, and must not read, subscribe or tick while it
     * is shut (../main.ts `scratchRailVisible`).
     */
    readonly visible: boolean;
    /**
     * Registers a board-visibility listener; returns the unsubscribe. Delivery is ON
     * CHANGE ONLY — never on registration: the value in force when a panel mounts is the
     * context default until the runtime says otherwise, and `visible` is the readable
     * answer (./runtime.ts calls `setVisibility` with the slot's current value right
     * after `panel.mount()` returns, which fires only when that value differs from the
     * default). Isolated like `onDispose`: one throwing listener cannot keep the others
     * from being told.
     */
    onVisibility(listener: (visible: boolean) => void): () => void;
};

// The runtime's half: the extension gets `context`, the shell keeps the two
// capabilities that must not be public (teardown and the session-change dispatch) plus
// the one the shell itself owns (whether the slot is on screen).
export type PanelContextController = {
    context: PanelContext;
    notifySessionChange: (sessionId: string | null) => void;
    /**
     * Publishes the slot's visibility. A no-op while disposed, and a no-op when the
     * value is unchanged — listeners fire on the CHANGE, not on every paint (the paint
     * loop runs on every stream frame).
     */
    setVisibility: (visible: boolean) => void;
    dispose: () => void;
};

// The heading the runtime draws. Kept in the DOM by class so the SAME selector the
// tool cards use (`.panel-title`) finds it, and so a panel that rebuilds its own
// children can get the heading back with `setTitle`.
const TITLE_CLASS = 'panel-title';

const titleNodeOf = (element: HTMLElement): HTMLElement | undefined =>
    [...element.querySelectorAll<HTMLElement>(`.${TITLE_CLASS}`)][0];

export const createPanelContext = (input: PanelContextInput): PanelContextController => {
    // The api is MERGED, not replaced: a host injects the reads it implements (a test
    // double, an embedded shell) and every other member still resolves to the shell's
    // own client. A host that replaces a member with `undefined` loses the default —
    // that is how a panel is told a capability is deliberately absent.
    const api: PanelApi = { ...panelApi, ...(input.api ?? {}) };
    const subscribe = input.subscribe ?? defaultPanelSubscribe;

    const disposers: (() => void)[] = [];
    const subscriptions = new Set<StreamSubscription>();
    const listeners = new Set<(sessionId: string | null) => void>();
    // T5/R3 — the board-visibility channel. A SET (not a single callback) because one
    // slot can hold several panels (Tasks and Records both sit in `scratch`) and each
    // suspends its own reads; every one of them must hear the same change.
    const visibilityListeners = new Set<(visible: boolean) => void>();
    const controller = new AbortController();

    let disposed = false;
    // VISIBLE BY DEFAULT, and it is the host that has to say otherwise: a panel in a
    // slot nobody publishes (a host that never passes `PanelPaintInput.visibility`) keeps
    // the behaviour it had before this seam existed.
    let visible = true;

    // One teardown path for every resource this context handed out. Reverse order so
    // a disposer that unwinds another's work runs first (the last thing mounted is the
    // first thing released). Each step is isolated: one throwing disposer must still
    // release everything after it.
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;

        for (let index = disposers.length - 1; index >= 0; index -= 1) {
            const dispose$ = disposers[index];
            disposers[index] = () => {};

            try {
                dispose$();
            } catch {
                // A broken disposer cannot strand the rest of the teardown.
            }
        }
        disposers.length = 0;

        for (const subscription of subscriptions) {
            try {
                subscription.unsubscribe();
            } catch {
                // Already gone: the plane may have closed before this panel.
            }
        }
        subscriptions.clear();

        listeners.clear();
        // Released for the same reason `listeners` is: each visibility listener closes
        // over the panel's whole surface, and the context must not keep that alive.
        visibilityListeners.clear();
        controller.abort();
    };

    const subscribeForContext = (spec: PanelSubscriptionSpec): StreamSubscription | undefined => {
        // A late subscription (an answer that landed after the session moved) is
        // DROPPED, not registered: subscribing on a dead panel is exactly the leak
        // this context exists to prevent.
        if (disposed) return undefined;

        const subscription = subscribe({
            ...spec,
            sessionId: spec.sessionId ?? input.sessionId() ?? undefined
        });

        if (subscription !== undefined) subscriptions.add(subscription);

        return subscription;
    };

    const onDispose = (dispose$: () => void): (() => void) => {
        if (typeof dispose$ !== 'function') return () => {};

        if (disposed) {
            try {
                dispose$();
            } catch {
                // Same isolation as the teardown loop.
            }

            return () => {};
        }

        disposers.push(dispose$);

        return () => {
            const index = disposers.indexOf(dispose$);
            if (index >= 0) disposers.splice(index, 1);
        };
    };

    const onSessionChange = (listener: (sessionId: string | null) => void): (() => void) => {
        if (disposed || typeof listener !== 'function') return () => {};

        listeners.add(listener);

        return () => {
            listeners.delete(listener);
        };
    };

    const onVisibility = (listener: (visible$: boolean) => void): (() => void) => {
        // Same shape as `onSessionChange`: registering on a disposed context is a no-op
        // (a late answer must not leave a listener behind), and the current value is
        // readable through `context.visible` instead of being replayed here.
        if (disposed || typeof listener !== 'function') return () => {};

        visibilityListeners.add(listener);

        return () => {
            visibilityListeners.delete(listener);
        };
    };

    const setVisibility = (next: boolean): void => {
        // A panel that is gone has nothing to suspend.
        if (disposed) return;

        // Anything that is not `false` is visible, so a host that hands over `undefined`
        // for a slot gets the default rather than a suspension it never asked for.
        const value = next !== false;

        // CHANGE only. `paint` runs on every stream frame, and a live panel's answer to
        // "still hidden?" is a no-op it should not have to run at all (./runtime.ts
        // diffs per instance too — this guard is the one that makes the seam itself
        // safe for any other caller).
        if (value === visible) return;

        visible = value;

        // Iterated over a copy: a listener may unsubscribe itself (or a sibling) from
        // inside the callback, and a `Set` mutated during `for..of` skips entries.
        for (const listener of [...visibilityListeners]) {
            try {
                listener(value);
            } catch {
                // One panel throwing must not stop the next one being told — the same
                // isolation the teardown loop keeps.
            }
        }
    };

    const setTitle = (title: string): void => {
        const existing = titleNodeOf(input.element);

        if (title.length === 0) {
            existing?.remove();

            return;
        }

        if (existing !== undefined) {
            existing.textContent = title;

            return;
        }

        const heading = input.element.ownerDocument.createElement('h3');
        heading.className = TITLE_CLASS;
        heading.textContent = title;
        input.element.prepend(heading);
    };

    if (input.title !== undefined && input.title.length > 0) setTitle(input.title);

    const context: PanelContext = {
        id: input.id,
        slot: input.slot,
        element: input.element,
        // A live getter, not a snapshot: an app-scoped panel must read the session
        // that is on screen now (see `PanelContext.sessionId`).
        get sessionId() {
            return input.sessionId();
        },
        api,
        signal: controller.signal,
        get disposed() {
            return disposed;
        },
        subscribe: subscribeForContext,
        // The unwrapped seam — see `PanelContext.subscribeSeam`.
        subscribeSeam: subscribe,
        onDispose,
        onSessionChange,
        // A live getter, not a snapshot: the value the host published is the answer, and
        // a panel that registers `onVisibility` mid-mount can read the state it is in.
        get visible() {
            return visible;
        },
        onVisibility,
        setTitle
    };

    return {
        context,
        dispose,
        notifySessionChange: (sessionId) => void listeners.forEach((l) => l(sessionId)),
        setVisibility
    };
};

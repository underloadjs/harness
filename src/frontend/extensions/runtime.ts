// The panel runtime: the mount/unmount engine the shell paints THROUGH (T5/R1).
//
// THIS IS THE DELEGATION POINT
// ----------------------------
// `main.ts` keeps its hosts and its paint call-sites, and every paint now goes:
//
//     paintPanels() -> runtime.paint({ hosts, media, sessionId })
//                        |                 -> host.setExtensions({ before, after })
//                        |                    (the shell-panel registry's elements)
//                        -> host.apply(media)
//                           (each card rendered by ./panel-kinds.ts, or by the
//                            shell's standard block renderer when no kind owns it)
//
// The runtime owns mounting and unmounting panel CONTENT; the hosts own where it
// sits; `main.ts` owns which conversation's data reaches them. With both registries
// empty this call is a no-op against the hosts and the board is byte-identical to
// the pre-registry shell.
//
// SESSION SCOPING, AND WHY DISPOSAL IS NOT A REPAINT
// -------------------------------------------------
// The runtime tracks the session id it last painted. When that id moves — a switch,
// a New session, a delete — every SESSION-scoped instance is torn down BEFORE the
// next one is mounted: its element leaves the host, its `onDispose` callbacks run,
// its realtime subscriptions are released, and its `AbortSignal` fires. A live panel
// therefore cannot outlive the conversation it reads, which is the property
// ./runtime.test.ts pins (no listener, no timer, no subscription survives a switch).
//
// APP-scoped instances survive the switch by design (they are the app's chrome, not
// the conversation's), and are told about it through `context.onSessionChange`.
//
// A SESSION-scoped panel is additionally held back until the shell actually HAS a
// conversation (`requiresSession`). Without that gate the boot would mount a panel on
// the first paint — before the remembered session has been read — and dispose it
// again the moment the session arrives: a rebuilt panel and one wasted subscription
// for a state the reader never saw.
//
// Failure isolation: a `mount` that throws is recorded in `runtime.failures()`, its
// half-built instance is disposed, and it is not retried until it is re-registered
// (or the session moves). One broken plugin must never break the board, the paint
// loop, or the other panels.
//
// Cross-references:
//   - ./shell-panels.ts  — what gets mounted, and in which order
//   - ./context.ts       — the capability bag and its teardown
//   - ./panel-kinds.ts   — the per-card renderer seam inside `host.apply`
//   - ../main.ts         — `paintPanels`, the hosts, and the session pointer

import type { PanelHost, PanelMedia, PanelSlot } from '../ui/panels';
import { PANEL_SLOTS } from '../ui/panels';
import type { PanelApiOverrides, PanelSubscribe } from './context';
import { createPanelContext } from './context';
import type { PanelContextController } from './context';
import type { ShellPanel } from './shell-panels';
import { listShellPanels } from './shell-panels';

export type PanelRuntimeOptions = {
    /**
     * Override the API surface handed to panels (the default is the shell's own
     * client). Partial on purpose: a host supplies the reads it implements and every
     * other member still resolves to `panelApi`.
     */
    api?: PanelApiOverrides;
    /** Override the realtime seam (the default is the shared `harness.v1` client). */
    subscribe?: PanelSubscribe;
};

export type PanelPaintInput = {
    /**
     * The hosts this paint may write to. A slot missing here keeps its panels
     * unmounted, so a host-less slot can never mount content into nothing.
     */
    hosts: Readonly<Partial<Record<PanelSlot, PanelHost>>>;
    /** The selected conversation's tool panels. Omitted/empty paints tool cards out. */
    media?: readonly PanelMedia[];
    /** The conversation on screen; null when none is. */
    sessionId?: string | null;
};

export type PanelRuntime = {
    /** Reconciles the mounted instances and repaints every host handed to it. */
    paint: (input: PanelPaintInput) => void;
    /** Tears every instance down (page teardown / host reset). */
    disposeAll: () => void;
    /** The ids currently mounted, in the order the board draws them. */
    mountedIds: () => string[];
    /** `id -> message` for the mounts that threw since their last registration. */
    failures: () => Record<string, string>;
    /** The session this runtime last painted. */
    activeSessionId: () => string | null;
};

type Mounted = {
    panel: ShellPanel;
    element: HTMLElement;
    controller: PanelContextController;
};

// The container a shell panel paints into. `.panel` gives it the same card chrome
// the tool panels have (the CSS is shared, and this task adds no rule);
// `.panel-extension` is the extra hook a plugin can style against, and
// `data-panel-extension` names the registration for tests and diagnostics.
const createExtensionElement = (panel: ShellPanel): HTMLElement => {
    const element = document.createElement('div');
    element.className = 'panel panel-extension';
    element.dataset.panelExtension = panel.id;
    element.dataset.panelSlot = panel.slot;

    return element;
};

export const createPanelRuntime = (options: PanelRuntimeOptions = {}): PanelRuntime => {
    // Insertion is the mount order; `desired` below is the paint order.
    const instances = new Map<string, Mounted>();
    // A mount that threw, remembered against the registration that threw. The identity
    // check is what makes the retry rule precise: the SAME broken record is not
    // re-mounted every frame (a paint loop must not spin on a plugin bug), while a
    // RE-REGISTRATION — the author's fix — is a different object and runs again.
    const failed = new Map<string, { panel: ShellPanel; message: string }>();

    let activeSession: string | null = null;

    const unmount = (id: string): void => {
        const mounted = instances.get(id);
        if (mounted === undefined) return;

        instances.delete(id);

        // Teardown FIRST (a disposer may read the DOM it is leaving), then the
        // element leaves the host. `replaceChildren` in `apply` never removes an
        // extension node it did not create, so releasing it here is what makes the
        // host's diff cheap.
        mounted.controller.dispose();
        mounted.element.remove();
    };

    const mount = (panel: ShellPanel): void => {
        const element = createExtensionElement(panel);
        const controller = createPanelContext({
            id: panel.id,
            slot: panel.slot,
            element,
            // Read per call: an APP-scoped panel must see the session that is on
            // screen now; a session-scoped one is disposed before it could notice.
            sessionId: () => activeSession,
            ...(options.api === undefined ? {} : { api: options.api }),
            ...(options.subscribe === undefined ? {} : { subscribe: options.subscribe }),
            ...(panel.title.length > 0 ? { title: panel.title } : {})
        });

        try {
            panel.mount(controller.context);
        } catch (error) {
            // A half-mounted instance is disposed the same way a complete one is, so
            // its subscriptions/disposers are released and never re-run.
            failed.set(panel.id, {
                panel,
                message: error instanceof Error ? error.message : String(error)
            });
            controller.dispose();
            element.remove();

            return;
        }

        instances.set(panel.id, { panel, element, controller });
        failed.delete(panel.id);

        // The host places it (`setExtensions` below); nothing is appended here, which
        // is what keeps one insertion point — and one ordering rule — per slot.
    };

    // A mount that threw is skipped until its registration is REPLACED (or the session
    // moves): one broken plugin must not re-throw on every stream frame, and the author's
    // fix must take effect on the next paint without a reload.
    const isBlocked = (panel: ShellPanel): boolean => {
        const failure = failed.get(panel.id);

        return failure !== undefined && failure.panel === panel;
    };

    const paint = (input: PanelPaintInput): void => {
        const sessionId = input.sessionId ?? null;
        const hosts = input.hosts;
        const media: readonly PanelMedia[] = input.media ?? [];

        if (sessionId !== activeSession) {
            activeSession = sessionId;

            // The conversation on screen changed: everything scoped to the old one is
            // released before anything is mounted for the new one.
            for (const id of [...instances.keys()]) {
                if (instances.get(id)?.panel.scope === 'session') unmount(id);
            }

            // The survivors (app-scoped) re-target their own reads.
            for (const mounted of instances.values()) mounted.controller.notifySessionChange(sessionId);

            // A fresh registration attempt is fair game again after a session move.
            failed.clear();
        }

        // What SHOULD be mounted right now: the registration order, restricted to the
        // slots the shell actually handed over, to the panels whose session
        // requirement the shell currently meets, and filtered by each panel's own gate.
        const desired = listShellPanels().filter(
            (panel) =>
                hosts[panel.slot] !== undefined &&
                (panel.requiresSession === false || activeSession !== null) &&
                (panel.when === undefined || panel.when(activeSession) === true) &&
                !isBlocked(panel)
        );

        const wanted = new Set(desired.map((panel) => panel.id));

        // Release anything the registry no longer wants (unregistered, gated off, or
        // a slot this paint does not carry).
        for (const id of [...instances.keys()]) if (!wanted.has(id)) unmount(id);

        for (const panel of desired) {
            if (instances.has(panel.id)) continue;
            mount(panel);
        }

        // Ordered node lists per slot. `desired` order == draw order == mount order.
        const before = new Map<PanelSlot, HTMLElement[]>();
        const after = new Map<PanelSlot, HTMLElement[]>();

        for (const panel of desired) {
            const mounted = instances.get(panel.id);
            if (mounted === undefined) continue;

            const bucket = panel.position === 'before' ? before : after;
            const list = bucket.get(panel.slot) ?? [];
            list.push(mounted.element);
            bucket.set(panel.slot, list);
        }

        for (const slot of PANEL_SLOTS) {
            const host = hosts[slot];
            if (host === undefined) continue;

            // Extensions first: an empty registry sends two empty lists, and the host
            // then composes the same children `apply` always produced.
            host.setExtensions({ before: before.get(slot) ?? [], after: after.get(slot) ?? [] });
            host.apply(media);
        }
    };

    const disposeAll = (): void => {
        // Reverse mount order: the last panel mounted is the first released.
        for (const id of [...instances.keys()].reverse()) unmount(id);

        failed.clear();
        activeSession = null;
    };

    // The ids currently mounted, in paint order — the same sort `paint` mounts in, so
    // asserting this list asserts the DOM order of the host too.
    const mountedIds = (): string[] => {
        const ids: string[] = [];

        for (const panel of listShellPanels()) if (instances.has(panel.id)) ids.push(panel.id);

        return ids;
    };

    return {
        paint,
        disposeAll,
        mountedIds,
        failures: () => {
            const copy: Record<string, string> = {};
            for (const [id, failure] of failed) copy[id] = failure.message;

            return copy;
        },
        activeSessionId: () => activeSession
    };
};

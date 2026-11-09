// Shell panels: persistent, session-scoped panels an app registers beside the tool
// panels the scratch board already shows (T5/R1).
//
// WHAT MAKES A PANEL A "SHELL" PANEL
// ----------------------------------
// A tool panel is a snapshot of DATA a tool returned at some point in a
// conversation: it appears with the turn that produced it and disappears with the
// conversation. A shell panel is a live VIEW the app owns: it exists while the
// session is on screen, it is handed a `PanelContext` (./context.ts) so it can
// subscribe to the realtime plane and read the API, and it is disposed — not
// repainted — when that conversation is switched or closed.
//
//     registerShellPanel({ id: 'tasks', title: 'Tasks', mount: (ctx) => ... })
//
// THE EMPTY REGISTRY IS THE CONTRACT
// ----------------------------------
// Nothing is mounted until a panel is registered, so the shell renders exactly the
// DOM it rendered before this seam existed (byte-for-byte, as `scratch-board.test.ts`
// and `panels.test.ts` pin it). A registration is the only thing that changes the
// scratch board, and it changes it ADDITIVELY: the extension's element joins the
// slot's host, the tool cards keep their ids, their order and the note's count.
//
// DETERMINISTIC ORDER
// -------------------
// `listShellPanels()` sorts by `order` (default 100) then by `id`, so the board's
// layout depends on the registration DATA, never on the order two unrelated modules
// happened to be imported. `position` says which side of the tool cards the panel
// sits on; the default 'after' leaves the tool panels exactly where they are today.
//
// Cross-references:
//   - ./context.ts    — what `mount` receives and how it is released
//   - ./runtime.ts    — the mount/unmount engine (the shell paints through it)
//   - ../ui/panels.ts — the slots, the hosts, the tool-panel pipeline

import { resolveSlot } from '../ui/panels';
import type { PanelSlot } from '../ui/panels';
import type { PanelContext } from './context';

// The lifecycle a mounted instance gets (./runtime.ts enforces both spellings).
//   `session` (default) — disposed and re-created whenever the on-screen session changes.
//   `app`              — survives a session change and is notified instead.
export type ShellPanelScope = 'session' | 'app';

// Which side of the tool cards this panel is drawn on, inside its slot's host.
export type ShellPanelPosition = 'before' | 'after';

export type ShellPanelRegistration = {
    /** Registry key, unique across slots. Trimmed on the way in. */
    id: string;
    /** Heading drawn above the panel's own content (the tool-card convention). */
    title?: string;
    /** Where it mounts. 'right' resolves to 'scratch' like every other slot name. */
    slot?: PanelSlot;
    /** Ascending sort key. Equal orders fall back to `id`, so the layout is stable. */
    order?: number;
    position?: ShellPanelPosition;
    scope?: ShellPanelScope;
    /**
     * Whether this panel needs a conversation before it may mount. Default: true for
     * a SESSION-scoped panel, false for an app-scoped one.
     *
     * The default matters at boot: the shell paints before the remembered session has
     * been read, and a live panel that mounted there would be disposed seconds later
     * by the session arriving. Declaring the need means the panel is mounted ONCE,
     * with a real session id to read with. Set false for a panel that has its own
     * no-conversation state to show (a directory, a global queue).
     */
    requiresSession?: boolean;
    /**
     * Optional gate: return false to keep this panel unmounted for the session on
     * screen (e.g. "only once a conversation exists"). Re-evaluated on every paint,
     * and a gate that closes DISPOSES the instance — that is the leak-free way to
     * hide a live panel.
     */
    when?: (sessionId: string | null) => boolean;
    /**
     * Builds the panel's DOM inside `context.element` and takes its resources through
     * `context`. Teardown belongs to `context.onDispose`; anything the mount returns
     * is ignored, so a mount that forgets to register teardown still loses only its
     * own work, never the shell's.
     */
    mount: (context: PanelContext) => void;
};

// A registration after validation/defaulting: every field present, so the runtime
// never has to re-derive a default and a test can assert the normalized record.
export type ShellPanel = {
    id: string;
    title: string;
    slot: PanelSlot;
    order: number;
    position: ShellPanelPosition;
    scope: ShellPanelScope;
    requiresSession: boolean;
    when?: (sessionId: string | null) => boolean;
    mount: (context: PanelContext) => void;
};

// The default sits above 0 so an explicitly-ordered panel (0, 10, ...) reliably wins
// a slot's top place without anyone having to use negative numbers.
export const SHELL_PANEL_DEFAULT_ORDER = 100;

const panels = new Map<string, ShellPanel>();

const asName = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

// Validates and defaults one registration. Throws for a malformed record: a panel
// that silently failed to appear on a live board is far harder to diagnose than an
// exception at the `registerShellPanel` call that caused it.
const normalize = (registration: ShellPanelRegistration): ShellPanel => {
    if (registration === null || typeof registration !== 'object')
        throw new TypeError('registerShellPanel: a registration object is required');

    const id = asName(registration.id);
    if (id.length === 0) throw new TypeError('registerShellPanel: `id` must be a non-empty string');

    if (typeof registration.mount !== 'function')
        throw new TypeError(`registerShellPanel('${id}'): \`mount\` must be a function`);

    // The slot is checked here rather than at paint time so a panel written against
    // a slot this app does not mount fails at authoring. The documented alias
    // ('right') is resolved to the mounted host, exactly as the wire path does.
    const slot = registration.slot === undefined ? 'scratch' : resolveSlot(registration.slot);
    if (slot === undefined)
        throw new TypeError(`registerShellPanel('${id}'): slot '${String(registration.slot)}' is not mounted`);

    const order = typeof registration.order === 'number' && Number.isFinite(registration.order)
        ? registration.order
        : SHELL_PANEL_DEFAULT_ORDER;

    const scope: ShellPanelScope = registration.scope === 'app' ? 'app' : 'session';

    return {
        id,
        title: asName(registration.title),
        slot,
        order,
        position: registration.position === 'before' ? 'before' : 'after',
        scope,
        // Resolved here so the runtime has one boolean to read and never re-derives a
        // default that could drift from this one.
        requiresSession:
            typeof registration.requiresSession === 'boolean'
                ? registration.requiresSession
                : scope === 'session',
        ...(registration.when === undefined ? {} : { when: registration.when }),
        mount: registration.mount
    };
};

/**
 * Registers a shell panel and returns its teardown. Re-registering the same `id`
 * REPLACES the earlier record (the development loop: edit, re-register, repaint),
 * and the displaced record's teardown is a no-op.
 */
export const registerShellPanel = (registration: ShellPanelRegistration): (() => void) => {
    const panel = normalize(registration);
    panels.set(panel.id, panel);

    return (): void => {
        if (panels.get(panel.id) === panel) panels.delete(panel.id);
    };
};

/** Removes one panel by id. Returns whether it was registered. */
export const unregisterShellPanel = (id: unknown): boolean => {
    const name = asName(id);

    return name.length === 0 ? false : panels.delete(name);
};

export const getShellPanel = (id: unknown): ShellPanel | undefined => {
    const name = asName(id);

    return name.length === 0 ? undefined : panels.get(name);
};

/**
 * Every registration, in the order the board draws them: `order` ascending, then
 * `id` ascending. Deterministic by DATA, so two hosts that register the same set in
 * different import orders still paint the same board.
 */
export const listShellPanels = (): ShellPanel[] =>
    [...panels.values()].sort((left, right) =>
        left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );

export const listShellPanelIds = (): string[] => listShellPanels().map((panel) => panel.id);

/** Drops every registration. Test/host-reset seam. */
export const clearShellPanels = (): void => {
    panels.clear();
};

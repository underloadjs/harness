// Panel kinds: the plug-in seam of the declarative panel pipeline (T5/R1).
//
// WHAT A KIND IS
// --------------
// A `ToolUiPanel` is DATA, and `../ui/panels.ts` owns the one renderer that turns
// that data into the standard card (text / table / key/value blocks, sanitized and
// bounded). A KIND is a named renderer registered by the app (or a plugin) that
// takes over for the panels that carry that name, so a tool that publishes a
// structured payload — a task list, a record table, a diff — can draw it with real
// markup instead of flattening it into key/value rows.
//
//     registerPanelKind({ kind: 'tasks', render: ({ panel, media }) => ... })
//
// THE TRUST BOUNDARY DOES NOT MOVE. The wire panel is still sanitized and bounded
// before a renderer ever sees it (`../ui/panels.ts` `sanitizePanel`): the model
// supplies data, never markup, and this module never evaluates a string. A kind is
// registered by CODE the host author ships, so the element a renderer returns is a
// trusted node — exactly like the element `panels.ts` builds itself.
//
// FALLBACK IS THE CONTRACT
// -------------------------
// `renderPanelOfKind` returns `undefined` for every case the registry does not own:
// an unkinded panel (the whole of today's wire), a kind nobody registered, or a
// renderer that threw. The caller then draws the standard card, so a panel written
// for a kind this build does not know still lands as data and the board never loses
// a card to a plugin bug. `panels.test.ts` and `scratch-board.test.ts` pin the
// fallback DOM byte-for-byte.
//
// The optional `kind` WIRE FIELD is a later task (`ToolUiPanel.kind`); reading it
// here is structural, so this module compiles with or without it and routing is
// exercised by tests and by future consumers today.
//
// Cross-references:
//   - ../ui/panels.ts        — the sanitizer, the fallback card, the hosts
//   - ./shell-panels.ts      — the other half of the seam (persistent panels)
//   - ./runtime.ts           — the mount/unmount engine the shell paints through
//   - ../index.ts            — the published client barrel

import type { ToolUiBlock, ToolUiPanel } from '../../server/protocol';
import type { PanelMedia, PanelSlot } from '../ui/panels';

// The name the shell's own block renderer answers. A panel that carries no `kind`
// resolves here, and an unregistered `blocks` renderer therefore means "today".
export const PANEL_KIND_BLOCKS = 'blocks';

// Everything one kind renderer needs, pre-sanitized. `blocks` is a shortcut over
// `panel.blocks` because that is what almost every renderer draws first.
export type PanelKindRenderInput = {
    /** The resolved kind name (never empty; `PANEL_KIND_BLOCKS` for an unkinded panel). */
    readonly kind: string;
    /** The slot this panel is being drawn into (aliases already resolved). */
    readonly slot: PanelSlot;
    /** The full media entry: `key`, `detail` action, and the panel data. */
    readonly media: PanelMedia;
    /** The sanitized panel (`id`, `slot`, `title`, `blocks`, optional `kind`). */
    readonly panel: ToolUiPanel & { slot: PanelSlot; kind?: string };
    readonly blocks: readonly ToolUiBlock[];
    /** The owner document, so a renderer never reaches for a stale global. */
    readonly document: Document;
};

export type PanelKind = {
    /** Registry key. Trimmed on the way in; case-sensitive. */
    kind: string;
    /**
     * Builds the card for one panel. Return the element to own the card, or
     * `undefined` to hand the panel back to the shell's standard renderer.
     */
    render: (input: PanelKindRenderInput) => HTMLElement | undefined;
};

// Module-scoped on purpose: registration is what makes a panel module "plug and
// play" with the shell, and the shell is a different module. Nothing is created at
// import time, so importing this file stays inert (./index.ts import-safety rule).
const kinds = new Map<string, PanelKind>();

// The LAST error each kind's renderer produced, keyed by kind. A swallowed throw is
// otherwise invisible: the card falls back and nobody can tell that the plugin ran.
const failures = new Map<string, string>();

const asKindName = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Registers one panel kind and returns its teardown. Registering the same kind
 * twice REPLACES the earlier renderer (a hot-reloaded plugin wins), and the older
 * registration's teardown then does nothing.
 *
 * Throws a `TypeError` for a malformed registration: this is an author-time bug in
 * shipped code, and a silent no-op would hide it behind a fallback card.
 */
export const registerPanelKind = (registration: PanelKind): (() => void) => {
    const kind = asKindName(registration?.kind);

    if (kind.length === 0) throw new TypeError('registerPanelKind: `kind` must be a non-empty string');
    if (typeof registration.render !== 'function')
        throw new TypeError(`registerPanelKind('${kind}'): \`render\` must be a function`);

    const entry: PanelKind = { kind, render: registration.render };
    kinds.set(kind, entry);

    return (): void => {
        // Identity check: a replacement registration must survive the teardown of the
        // registration it displaced (the displaced one still holds its own closure).
        if (kinds.get(kind) === entry) kinds.delete(kind);
        failures.delete(kind);
    };
};

/** Removes one kind by name. Returns whether it was registered. */
export const unregisterPanelKind = (kind: unknown): boolean => {
    const name = asKindName(kind);
    if (name.length === 0) return false;

    failures.delete(name);

    return kinds.delete(name);
};

export const getPanelKind = (kind: unknown): PanelKind | undefined => {
    const name = asKindName(kind);

    return name.length === 0 ? undefined : kinds.get(name);
};

/** True when this build can draw `kind` (used by the sanitizer's opaque-block rule). */
export const isPanelKindRegistered = (kind: unknown): boolean => getPanelKind(kind) !== undefined;

/** Every registered kind name, sorted — the deterministic view a diagnostics pane reads. */
export const listPanelKinds = (): string[] => [...kinds.keys()].sort();

/** The last renderer error per kind (`kind -> message`). */
export const panelKindErrors = (): Record<string, string> => Object.fromEntries(failures);

/** Drops every registration. Test/host-reset seam. */
export const clearPanelKinds = (): void => {
    kinds.clear();
    failures.clear();
};

/**
 * The kind a media entry routes to: the wire `kind` when it names one, otherwise
 * `PANEL_KIND_BLOCKS`. Both `media.kind` and `media.panel.kind` are read because a
 * caller may attach the name to either (the wire field itself is a later task).
 */
export const panelKindOf = (media: PanelMedia): string => {
    const named = asKindName(
        (media as { kind?: unknown }).kind ?? (media.panel as { kind?: unknown }).kind
    );

    return named.length === 0 ? PANEL_KIND_BLOCKS : named;
};

// `${tool}\u001f${panel id}` — the scope separator `panelKeyOf` writes. A key built
// without it (a hand-made media entry) names no tool, so the whole key is the best
// attribution available. Same rule the standard card has always used.
export const panelToolOf = (key: string): string => {
    const separator = key.indexOf('\u001f');

    return separator >= 0 ? key.slice(0, separator) : key;
};

/**
 * Stamps the dataset every panel card carries. `../ui/panels.ts` calls this from
 * its own renderer, so a kind renderer and the standard card cannot drift apart and
 * the selectors the acceptance tests use (`.panel[data-panel-id]`,
 * `data-panel-state`, `data-panel-tool`) keep working for either.
 *
 * `data-panel-kind` is written ONLY for a panel that names a kind: an unkinded card
 * stays byte-identical to the card this app has always drawn.
 */
export const applyPanelCardData = (card: HTMLElement, slot: PanelSlot, media: PanelMedia): void => {
    card.dataset.panelId = media.panel.id;
    card.dataset.panelSlot = slot;
    // Summary (the bounded compact card) or full (a manual result / an expanded one).
    card.dataset.panelState = media.detail === undefined ? 'full' : 'summary';
    card.dataset.panelTool = panelToolOf(media.key);

    const named = asKindName((media as { kind?: unknown }).kind ?? (media.panel as { kind?: unknown }).kind);
    if (named.length > 0) card.dataset.panelKind = named;
};

/**
 * The card shell a kind renderer should return: `article.panel` with the standard
 * dataset. Titles, bodies and actions stay the renderer's business — this helper
 * exists so a plugin gets the chrome the CSS and the tests expect for one call.
 */
export const createPanelCard = (input: PanelKindRenderInput): HTMLElement => {
    const card = input.document.createElement('article');
    card.className = 'panel';
    applyPanelCardData(card, input.slot, input.media);

    return card;
};

/**
 * The delegation entry point `../ui/panels.ts` calls before drawing anything.
 * `undefined` means "not mine" — unkinded, unknown kind, or a renderer that
 * declined or threw — and the caller draws the standard card.
 */
export const renderPanelOfKind = (slot: PanelSlot, media: PanelMedia): HTMLElement | undefined => {
    const kind = panelKindOf(media);
    const registration = kinds.get(kind);

    if (registration === undefined) return undefined;

    const input: PanelKindRenderInput = {
        kind,
        slot,
        media,
        panel: media.panel,
        blocks: media.panel.blocks,
        document
    };

    try {
        const card = registration.render(input);

        // A renderer must return a real element; anything else falls back rather
        // than putting `undefined` into `replaceChildren`.
        return card instanceof HTMLElement ? card : undefined;
    } catch (error) {
        // One plugin must never take the scratch board (or the socket-driven paint
        // loop) down with it. The message is kept where a host can surface it.
        failures.set(kind, error instanceof Error ? error.message : String(error));

        return undefined;
    }
};

// Reusable accessible modal dialog (T17 R9).
//
// The transcript/tools integration (other workers) needs ONE modal facility for
// full-size previews: clicking a transcript image or a file chip opens a dialog,
// and tool call/result details open a dialog instead of expanding inline. This
// module owns only that generic shell; it knows nothing about turns, tools,
// attachments or markdown.
//
// CONTRACT
// --------
//   openDialog({ title, content, copy?, returnFocus?, onClose? })
//       -> { element, isOpen, close(), update({ title?, content?, copy? }) }
//
// `copy` is the opt-in data-inspection action (R5): a string or a click-time
// provider. The dialog owns the icon button, the clipboard path (async API plus the
// insecure-origin fallback) and the success/failure announcement, so tool/transcript/
// file dialogs do not duplicate handlers.
//
// `createTextCopyButton({ label, text, className })` exports that SAME copy control
// for callers that need it outside a dialog header (a section heading inside adopted
// content, an answer footer). It is the shared implementation on purpose: the
// clipboard fallback with its modal focus-trap exemption is the part every caller got
// wrong before, and one vocabulary ("Copied" / "Copy failed") stays everywhere.
//
// `content` is a DOM Node, never an HTML string. The caller supplies nodes it has
// already built with createElement/textContent (see ui/panels.ts for the same
// data-only rule), so there is no HTML parse path here and therefore nothing to
// sanitize. `element` is the element carrying `role="dialog"`; its parent is the
// full-viewport `.dialog-overlay`.
//
// THE STACK (nested dialogs and replacement)
// ------------------------------------------
// Layers are ordered globally, across every host, so two hosts can never fight
// over focus. Within a host:
//   - `open()` pushes a layer; `close()` removes exactly that layer;
//   - Escape and backdrop clicks act on the TOP layer only (one layer per press);
//   - focus cycling is trapped inside the top layer only;
//   - closing a lower layer never steals focus from a higher one;
//   - `closeAll()` closes that host's layers top-down, so `onClose` callbacks run
//     in reverse order.
// There is no implicit "replace": a second open stacks (predictable and cleanup
// safe). Callers that want replacement close the old handle first.
//
// FOCUS
// -----
// Opening focuses the dialog panel itself (`tabindex="-1"`) rather than a control,
// so a preview never starts with Enter/Space aimed at the close button. Tab then
// cycles through the dialog's focusable descendants (close button first).
//
// Closing restores focus ONLY to something that was actually focused:
//   1. `returnFocus` when explicitly provided as a connected element;
//   2. otherwise the element that was `document.activeElement` at open time;
//   3. otherwise the previous (now top) dialog panel.
// `returnFocus: null` explicitly means "do not move focus on close".
// There is deliberately NO fallback to the composer or any other known widget:
// this module has no reference to the app shell, so a preview opened by a mouse
// click cannot silently steal focus back into the composer.
//
// SCROLL LOCK
// -----------
// The body scroll lock is reference-counted ACROSS hosts in one module-level
// counter, so nesting (or two independent hosts) cannot unlock the page early.
// The previous inline `overflow` value is captured on the first lock and restored
// on the last unlock.
//
// STYLES
// ------
// Styles live in `./dialog.css` and are NOT imported here on purpose: the browser
// barrel `src/frontend/index.ts` must stay inert at module scope (its header
// documents "NO stylesheet import"), and Vite only includes the stylesheet when a
// module in the app graph imports it. Host integration therefore needs ONE line,
// first in `src/frontend/styles.css`:
//
//     @import './ui/dialog.css';
//
// (Any other module that imports the stylesheet is equally valid; the app shell's
// styles.css is the existing convention.) Without that line the dialog is fully
// functional but unstyled.
//
// Cross-references:
//   - src/frontend/main.ts              app shell / composer (must NOT be coupled)
//   - src/frontend/ui/panels.ts         same data-only DOM security model
//   - src/frontend/styles.css           `@import` host (owned by the app shell)
//   - src/frontend/ui/dialog.css        `.dialog-*` rules
//   - src/frontend/ui/dialog.test.ts    behavioural + stylesheet contract

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

// Everything a caller may pass when opening. Only `title` and `content` are
// required; the rest is opt-in focus and lifecycle control.
export type DialogOptions = {
    // Visible heading and the accessible name (wired with `aria-labelledby`).
    title: string;
    // Pre-built DOM to adopt inside `.dialog-body`. This is DOM adoption, not a
    // clone: an element that already lives in the transcript MOVES into the dialog.
    // Callers whose source must stay in place pass `source.cloneNode(true)`.
    // A DocumentFragment moves its children; a string is rejected by the runtime
    // guard (there is no HTML parse path).
    content: Node;
    // Optional "Copy" action for a DATA-INSPECTION dialog (tool details, transcripts,
    // file previews). The source is resolved at CLICK time, so a live dialog (a tool
    // card still running) copies the data that is on screen now. A function that
    // throws is reported as a failed copy; it never breaks the dialog.
    //
    // Pure confirmation/input dialogs and binary previews omit this: a Copy button
    // must copy meaningful text, not configuration controls or an image payload.
    copy?: DialogCopySource;
    // Explicit focus destination on close. `undefined` = restore the element that
    // was focused when the dialog opened. `null` = restore nothing.
    returnFocus?: HTMLElement | null;
    // Runs exactly once, after the overlay is removed and focus is restored.
    onClose?: () => void;
};

// The text a Copy button writes. A string is a snapshot; a function is evaluated on
// every activation so an async/live dialog copies its CURRENT contents without a
// second mutation API.
export type DialogCopySource = string | (() => string);

// Update input for `handle.update`. Fields are optional; omitted fields keep their
// current value. `copy: null` removes a previously installed Copy button (used when
// an async preview settles into an error with no text to copy).
export type DialogUpdate = {
    title?: string;
    content?: Node;
    copy?: DialogCopySource | null;
};

export type DialogHandle = {
    // The `role="dialog"` panel (not the overlay).
    readonly element: HTMLElement;
    // False once `close()` has run, so callers can ignore late async updates.
    readonly isOpen: boolean;
    // Idempotent: the second call is a no-op (no duplicate `onClose`).
    close(): void;
    // Replace title/content while open; a no-op after close.
    update(next: DialogUpdate): void;
};

export type DialogHost = {
    // Push a dialog onto this host's stack.
    open(options: DialogOptions): DialogHandle;
    // Close every dialog in THIS host, top-down. New dialogs opened from `onClose`
    // callbacks are not chased; call again if that matters.
    closeAll(): void;
    // Live layer count for this host (drives tests and integration teardown).
    readonly count: number;
    // This host's topmost handle, or null when it is empty.
    readonly top: DialogHandle | null;
};

// ---------------------------------------------------------------------------
// DOM constants
// ---------------------------------------------------------------------------

// Classes are all scoped under `.dialog-*` so they cannot collide with the shell.
const OVERLAY_CLASS = 'dialog-overlay';
const PANEL_CLASS = 'dialog';
const HEAD_CLASS = 'dialog-head';
const TITLE_CLASS = 'dialog-title';
const COPY_CLASS = 'dialog-copy';
const CLOSE_CLASS = 'dialog-close';
const BODY_CLASS = 'dialog-body';

// Close glyph is escaped so the source file stays ASCII-safe (the repo has had
// encoding issues) and the test can assert the exact character.
const CLOSE_GLYPH = '\u00d7';
const CLOSE_LABEL = 'Close';

// Copy feedback is TEXT in an aria-live child of the button plus a state-driven ICON,
// never colour alone: the visible word is screen-reader text now, so the picture is
// what changes on screen. T1/R3.
// T1/R3: the words below are ANNOUNCED (live child) and used as tooltips; the visible
// affordance is the icon. They stay in the source so the announcement is spelled the
// same way in every dialog.
const COPY_SUCCESS_LABEL = 'Copied';
const COPY_FAILURE_LABEL = 'Copy failed';
// Stable accessible name: the control's purpose never changes, so the announcement is
// a status message (the live child) instead of a renamed button.
const COPY_ARIA_LABEL = 'Copy dialog contents';
const COPY_TITLE = 'Copy the dialog contents to the clipboard';
const COPY_SUCCESS_TITLE = 'Copied to the clipboard';
const COPY_FAILURE_TITLE = 'Copy failed — the clipboard was not available';

// T1/R3: the button carries an inline SVG (stroke) glyph per state — two sheets for
// "copy", a tick for success, an exclamation for failure. Paths, not fonts: an icon
// font or an emoji would render inconsistently (and the repo keeps source ASCII-only).
// `aria-hidden` on the <svg> keeps the button's accessible name equal to COPY_ARIA_LABEL.
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const COPY_ICONS: Record<'idle' | 'success' | 'error', string> = {
    // Back sheet + front sheet (the conventional copy mark).
    idle: 'M9 9.5h9.5v9.5H9z M15 5H5.5v9.5',
    // Tick.
    success: 'M4.5 12.5l4.5 4.5 10.5-10.5',
    // Exclamation: the stem plus its dot.
    error: 'M12 4.5v10.5 M12 18.6v0.9'
};

// The announced word for each state. Idle is EMPTY on purpose: the button already
// names itself, and a live region that repeats the label on every open would announce
// nothing new.
const COPY_FEEDBACK: Record<'idle' | 'success' | 'error', string> = {
    idle: '',
    success: COPY_SUCCESS_LABEL,
    error: COPY_FAILURE_LABEL
};

// Elements a Tab press may land on. `[tabindex]` is filtered below: `-1` is
// programmatic-only and must not join the cycle.
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button',
    'input',
    'select',
    'textarea',
    'iframe',
    'object',
    'embed',
    'summary',
    '[contenteditable="true"]',
    '[tabindex]'
].join(',');

// ---------------------------------------------------------------------------
// Tree order and focus helpers
// ---------------------------------------------------------------------------

// A stable accessible-name id per dialog. Global (not per host) so two hosts can
// never emit the same id on one page; tests assert the wiring rather than a
// hardcoded number because the counter intentionally survives between opens.
let titleSequence = 0;
const nextTitleId = (): string => `dialog-title-${(titleSequence += 1)}`;

// Tabbable descendants in DOM order. jsdom computes no layout, so visibility is
// decided from attributes (`hidden`, `inert`) rather than client rects.
const focusablesWithin = (panel: HTMLElement): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        if (element.hasAttribute('disabled')) return false;
        if (element.tabIndex < 0) return false;
        if (element.closest('[hidden]') !== null) return false;
        if (element.closest('[inert]') !== null) return false;
        return true;
    });

// Focus the first tabbable descendant, falling back to the panel itself (a dialog
// with only static text still needs a focus holder for Escape/Tab handling).
const focusFirst = (panel: HTMLElement): void => {
    const first = focusablesWithin(panel)[0];
    (first ?? panel).focus({ preventScroll: true });
};

// Runtime guards keep the JS-facing contract honest: callers in TS get the types,
// but a content string would otherwise become text (safe) or throw deep inside
// append. Fail at the boundary with a precise message instead.
const assertTitle = (title: unknown): string => {
    if (typeof title !== 'string') throw new TypeError('openDialog: title must be a string');
    return title;
};

const assertContent = (content: unknown): Node => {
    if (!(content instanceof Node)) throw new TypeError('openDialog: content must be a DOM Node');
    return content;
};

// ---------------------------------------------------------------------------
// Copy support (data-inspection dialogs)
// ---------------------------------------------------------------------------
//
// Two paths, in order:
//   1. the async Clipboard API (`navigator.clipboard.writeText`) — the safe,
//      permission-aware path a secure browser context exposes;
//   2. a read-only textarea + `document.execCommand('copy')` — the documented
//      fallback for older browsers, embedded webviews and pages where the async API
//      is absent or rejects (permissions policy, INSECURE ORIGIN).
// Both are best-effort; the caller receives a boolean and the button reports the
// truth instead of pretending the clipboard write succeeded.
//
// WHY THE FALLBACK MATTERS FOR THIS APP (T1/R3): the harness UI is served over plain
// HTTP on the LAN static host (src/frontend/deployment.ts and
// src/frontend/vite.config.ts print `http://<LAN-IP>:<port>/`), and `navigator
// .clipboard` simply does not exist in a non-secure origin. Every transcript copy
// there went through the fallback, and the fallback was the thing that was broken.
//
// THE BUG THIS FIXES: `execCommand('copy')` copies the selection of the FOCUSED
// control. The old code called `area.select()` without ever focusing the textarea
// (the dialog panel holds focus), so the copy ran against an empty selection,
// reported success, and left the clipboard unchanged. Focusing the helper is only
// half the fix: the modal focus trap (`onDocumentFocusIn`, capture) drags any focus
// outside the top panel straight back in, so the workaround needs the trap held
// open for exactly the duration of the copy (see `clipboardWorkaround`).
let clipboardWorkaround = false;

const clipboardFallback = (text: string): boolean => {
    if (typeof document === 'undefined' || document.body === null) return false;
    if (typeof document.execCommand !== 'function') return false;

    const previousFocus = document.activeElement;
    const area = document.createElement('textarea');
    area.className = 'dialog-copy-buffer';
    area.value = text;
    area.setAttribute('readonly', '');
    // Data only, and not a stop for assistive tech passing over the dialog.
    area.setAttribute('aria-hidden', 'true');
    // Off-screen, not display:none: a hidden element cannot be selected/copied.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.left = '-1000px';
    area.style.opacity = '0';

    clipboardWorkaround = true;
    document.body.append(area);

    let copied = false;
    try {
        // Focus THEN select, in that order: the selection only belongs to the copy
        // command while its control is the focused one. `setSelectionRange` is the
        // iOS/Safari spelling of "all of it".
        area.focus({ preventScroll: true });
        area.select();
        area.setSelectionRange(0, text.length);
        copied = document.execCommand('copy') === true;
    } catch {
        copied = false;
    } finally {
        // The trap must own focus again before anything else can move it, and the
        // helper is removed whatever the command answered.
        clipboardWorkaround = false;
        area.remove();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
            previousFocus.focus({ preventScroll: true });
        }
    }

    return copied;
};

const writeClipboardText = async (text: string): Promise<boolean> => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;

    if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
        try {
            await clipboard.writeText(text);
            return true;
        } catch {
            // Permission denied / unsupported context: fall through to the
            // textarea path instead of reporting a failure the user could fix
            // with the fallback.
        }
    }

    return clipboardFallback(text);
};

// The plain text for one activation. A source that throws or returns a non-string
// is a failure, never an empty successful copy.
const copyTextOf = (source: DialogCopySource): string => {
    const text = typeof source === 'function' ? source() : source;
    if (typeof text !== 'string') throw new TypeError('dialog copy source must produce a string');
    return text;
};

// T1/R3: the Copy control is an ICON button. Two nodes are built once and repainted
// on every state change: the <svg> glyph (what the reader sees) and a visually hidden
// `role="status"` word (what a screen reader hears). SVG is created in its own
// namespace because this module never parses HTML — the same data-only rule the
// `content` option enforces.
const createCopyIcon = (): SVGSVGElement => {
    const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
    icon.setAttribute('class', 'dialog-copy-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    // The button carries the accessible name (`aria-label`), so the glyph must not be
    // announced a second time, and it must never take a focus order of its own.
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');

    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('d', COPY_ICONS.idle);
    icon.append(path);

    return icon;
};

const createCopyFeedback = (): HTMLSpanElement => {
    const feedback = document.createElement('span');
    feedback.className = 'dialog-copy-feedback';
    // A live region INSIDE the button announces idle -> Copied / Copy failed without
    // renaming the control, so the visible word is no longer the only feedback.
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.textContent = COPY_FEEDBACK.idle;
    return feedback;
};

// Tooltip wording per state, externalised so the SAME icon/feedback machinery can
// serve a control that is not the dialog header. `DIALOG_COPY_TITLES` reproduces the
// historical header strings byte for byte (dialog-copy.test.ts pins them); a shared
// pane button passes its own label as the idle tooltip, so the hover text says WHICH
// pane it copies instead of claiming to copy "the dialog" (R3).
type CopyTitles = { idle: string; success: string; failure: string };

const DIALOG_COPY_TITLES: CopyTitles = {
    idle: COPY_TITLE,
    success: COPY_SUCCESS_TITLE,
    failure: COPY_FAILURE_TITLE
};

// Paint the button's icon/state. The `title` follows the state so a hover explains
// what just happened, and `data-state` drives the border/colour reinforcement.
const paintCopyState = (
    button: HTMLButtonElement,
    state: 'idle' | 'success' | 'error',
    titles: CopyTitles = DIALOG_COPY_TITLES
): void => {
    const path = button.querySelector('svg.dialog-copy-icon > path');
    if (path !== null) path.setAttribute('d', COPY_ICONS[state]);

    const feedback = button.querySelector<HTMLElement>('.dialog-copy-feedback');
    if (feedback !== null) feedback.textContent = COPY_FEEDBACK[state];

    if (state === 'success') {
        button.dataset.state = 'success';
        button.title = titles.success;
        return;
    }
    if (state === 'error') {
        button.dataset.state = 'error';
        button.title = titles.failure;
        return;
    }

    delete button.dataset.state;
    button.title = titles.idle;
};

// ---------------------------------------------------------------------------
// Balanced body scroll lock (module-wide)
// ---------------------------------------------------------------------------
//
// A single counter is shared by every host because nested layers may come from
// different hosts. Capturing the previous value (rather than assuming '') keeps a
// host page that already styled body overflow intact after the last close.
let scrollLockDepth = 0;
let scrollLockRestore: string | undefined;

const lockBodyScroll = (): void => {
    if (typeof document === 'undefined' || document.body === null) return;
    if (scrollLockDepth === 0) scrollLockRestore = document.body.style.overflow;
    scrollLockDepth += 1;
    document.body.style.overflow = 'hidden';
};

const unlockBodyScroll = (): void => {
    if (scrollLockDepth === 0) return;
    scrollLockDepth -= 1;
    if (scrollLockDepth > 0) return;
    if (typeof document !== 'undefined' && document.body !== null) {
        document.body.style.overflow = scrollLockRestore ?? '';
    }
    scrollLockRestore = undefined;
};

// ---------------------------------------------------------------------------
// Global layer registry
// ---------------------------------------------------------------------------
//
// One entry is the live state behind one handle. `capturedFocus` is read BEFORE
// the overlay is appended, so it can never point into this dialog.
type DialogEntry = {
    panel: HTMLElement;
    overlay: HTMLElement;
    head: HTMLElement;
    title: HTMLElement;
    closeButton: HTMLButtonElement;
    body: HTMLElement;
    copy: DialogCopySource | undefined;
    copyButton: HTMLButtonElement | undefined;
    capturedFocus: HTMLElement | null;
    returnFocus: HTMLElement | null | undefined;
    onClose: (() => void) | undefined;
    closed: boolean;
};

// A layer is the global view of an open entry: it can close itself without the
// document listeners needing to know which host owns it.
type DialogLayer = {
    entry: DialogEntry;
    panel: HTMLElement;
    close: () => void;
};

// Ordered bottom -> top across ALL hosts. This is what makes nesting and multiple
// hosts cooperate: exactly one dialog in the document is the focus/Escape owner.
const layers: DialogLayer[] = [];

// One set of document listeners total, attached only while at least one layer is
// open. Capture phase wins over the shell's Escape/Tab handling in main.ts.
let listening = false;

// `redirecting` breaks the focusin -> focus() -> focusin recursion when the trap
// pulls focus back inside the top dialog.
let redirecting = false;

const topLayer = (): DialogLayer | undefined => layers[layers.length - 1];

const onDocumentKeyDown = (event: KeyboardEvent): void => {
    const top = topLayer();
    if (top === undefined || top.entry.closed) return;

    // Escape belongs to the topmost layer. `preventDefault` + `stopPropagation`
    // means the shell's own Escape handling (phone rails in main.ts) and any
    // dialog content handler do not also react to this same press.
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        top.close();
        return;
    }

    if (event.key !== 'Tab') return;

    // Tab cycle. The panel itself is the initial focus holder and is not in
    // `focusablesWithin`; treat that as "enter at first/last" so keyboard users
    // can leave the panel and reach the close button and content controls.
    const focusables = focusablesWithin(top.panel);
    if (focusables.length === 0) {
        event.preventDefault();
        top.panel.focus({ preventScroll: true });
        return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1;

    if (index === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
    }

    if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
        return;
    }

    if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
    }
};

// Modal focus containment: programmatic/mouse focus that lands outside the top
// dialog is pulled back. Detached targets (focus leaving the document) are
// ignored, and the redirect flag prevents a focusin loop.
//
// T1/R3: `clipboardWorkaround` is the second exemption. The execCommand fallback has
// to focus and select a helper textarea that lives in `document.body`, OUTSIDE the
// panel; without this the trap would yank focus back before the copy command runs and
// the clipboard write would land on an empty selection.
const onDocumentFocusIn = (event: FocusEvent): void => {
    if (redirecting || clipboardWorkaround) return;

    const top = topLayer();
    if (top === undefined || top.entry.closed) return;

    const target = event.target;
    if (!(target instanceof Node) || !target.isConnected) return;
    if (target === top.panel || top.panel.contains(target)) return;

    redirecting = true;
    focusFirst(top.panel);
    redirecting = false;
};

const attachListeners = (): void => {
    if (listening) return;
    listening = true;
    document.addEventListener('keydown', onDocumentKeyDown, true);
    document.addEventListener('focusin', onDocumentFocusIn, true);
};

const detachListeners = (): void => {
    if (!listening) return;
    listening = false;
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    document.removeEventListener('focusin', onDocumentFocusIn, true);
};

// Pick the close-time focus destination from explicit -> captured -> previous
// dialog. `returnFocus === null` suppresses restoration outright. Called AFTER
// the closing entry is removed from `layers`, so `topLayer()` is the previous
// dialog (or undefined when this was the last one).
const resolveFocusTarget = (entry: DialogEntry): HTMLElement | null => {
    if (entry.returnFocus === null) return null;

    const candidates = [entry.returnFocus, entry.capturedFocus, topLayer()?.panel ?? null];

    for (const candidate of candidates) {
        if (candidate instanceof HTMLElement && candidate.isConnected) return candidate;
    }

    return null;
};

// The click pipeline every copy affordance shares: resolve the text at CLICK time
// (so a live surface copies what is on screen now), write it through the one
// reliable clipboard path (async API, then the focus-trap-aware textarea fallback),
// and report the truth through `paint`. `paint` is a callback rather than a fixed
// `paintCopyState` call because the dialog must not repaint a button whose layer
// closed mid-write, while a standalone button always repaints.
const runTextCopy = async (
    source: DialogCopySource,
    button: HTMLButtonElement,
    paint: (state: 'success' | 'error') => void
): Promise<void> => {
    let text: string;

    try {
        text = copyTextOf(source);
    } catch {
        paint('error');
        return;
    }

    const copied = await writeClipboardText(text);
    paint(copied ? 'success' : 'error');
};

// Resolve the copy source when the user asks for it, so a live tool card or
// transcript copies what is CURRENTLY rendered. Feedback is written INSIDE the button
// (the glyph, `data-state`, the `title`, and the hidden `aria-live` word — T1/R3); the
// entry may close while the async clipboard write is in flight, in which case there is
// no button left to paint.
const runCopy = async (entry: DialogEntry, button: HTMLButtonElement): Promise<void> => {
    if (entry.copy === undefined) {
        paintCopyState(button, 'error');
        return;
    }

    await runTextCopy(entry.copy, button, (state) => {
        if (!entry.closed) paintCopyState(button, state);
    });
};

// Create the header Copy control lazily, so dialogs that do not opt in keep the
// historical two-child header (title + close) exactly. It sits before Close, which
// keeps the dismiss control at the far edge of every dialog.
const installCopyButton = (entry: DialogEntry, source: DialogCopySource): void => {
    entry.copy = source;

    if (entry.copyButton !== undefined) {
        // Re-installing onto a live dialog (a refresh replaced the copy source) resets
        // the previous feedback so a stale "Copied" never describes a different payload.
        paintCopyState(entry.copyButton, 'idle');
        return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = COPY_CLASS;
    // T1/R3: an icon button. The accessible name and the tooltip describe the ACTION
    // and never change; the hidden live child inside announces the outcome.
    button.setAttribute('aria-label', COPY_ARIA_LABEL);
    button.append(createCopyIcon(), createCopyFeedback());
    // Paint once so `title`/`data-state`/icon are consistent from the first frame.
    paintCopyState(button, 'idle');
    button.addEventListener('click', () => {
        void runCopy(entry, button);
    });

    entry.head.insertBefore(button, entry.closeButton);
    entry.copyButton = button;
};

const removeCopyButton = (entry: DialogEntry): void => {
    entry.copy = undefined;
    entry.copyButton?.remove();
    entry.copyButton = undefined;
};

// ---------------------------------------------------------------------------
// Shared standalone Copy control (R3)
// ---------------------------------------------------------------------------

export type TextCopyButtonOptions = {
    // Accessible name AND idle tooltip, e.g. "Copy arguments". Required because a
    // pane button must name the ONE thing it copies; the dialog header's own label
    // ("Copy dialog contents") would be a lie inside a section heading.
    label: string;
    // Click-time text provider. Resolved on every activation, so a surface that is
    // still streaming copies what is on screen at that moment, never a snapshot.
    text: () => string;
    // Optional style hook. The control always carries the shared `text-copy` class
    // plus the shared icon/feedback classes, so a caller only adds layout.
    className?: string;
};

// The default class for a standalone copy control. Exported because the icon and the
// live child are styled under it (styles.css / dialog.css).
export const TEXT_COPY_CLASS = 'text-copy';

// A COPY BUTTON OUTSIDE THE DIALOG HEADER that reuses the shell's proven copy
// machinery: the same inline SVG glyph set, the same visually hidden `role="status"`
// announcement, the same `data-state` reinforcement and — most importantly — the
// same `writeClipboardText` path, including the textarea fallback that focuses its
// own helper with the modal focus trap held open (`clipboardWorkaround`). That last
// part is why this lives HERE rather than in the caller: the harness UI is served
// over plain HTTP on the LAN, where `navigator.clipboard` does not exist at all and a
// hand-rolled copy silently "succeeds" while the clipboard stays unchanged.
//
// Synchronous and DOM-only: it opens nothing, needs no dialog, and never throws when
// the clipboard is unavailable — the button reports the failure in place.
// `createToolCallCard`'s argument/result headings and the answer footer use it.
export const createTextCopyButton = (options: TextCopyButtonOptions): HTMLButtonElement => {
    const { label, text, className } = options;
    // Titles are derived from the label so the hover explains which pane is copied;
    // the success/failure wording stays identical to the dialog's (one vocabulary).
    const titles: CopyTitles = {
        idle: label,
        success: COPY_SUCCESS_TITLE,
        failure: COPY_FAILURE_TITLE
    };

    const button = document.createElement('button');
    button.type = 'button';
    // `TEXT_COPY_CLASS` first so a caller's class can restyle without unsharing the
    // icon/feedback selectors.
    button.className = className === undefined ? TEXT_COPY_CLASS : `${TEXT_COPY_CLASS} ${className}`;
    // The name never changes (an announced state is a status message, not a rename).
    button.setAttribute('aria-label', label);
    button.append(createCopyIcon(), createCopyFeedback());

    const paint = (state: 'idle' | 'success' | 'error'): void => paintCopyState(button, state, titles);
    paint('idle');

    button.addEventListener('click', () => {
        void runTextCopy(text, button, paint);
    });

    return button;
};

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export const createDialogHost = (parent?: HTMLElement): DialogHost => {
    // The mount point is resolved lazily at open time: creating a host before
    // <body> exists (SSR, module init) must stay inert like the rest of ui/*.
    const stack: DialogEntry[] = [];

    // Keep the public handle per entry so `top` returns the SAME object the caller
    // received (identity-comparable, no facade duplication).
    const handles = new Map<DialogEntry, DialogHandle>();

    const closeEntry = (entry: DialogEntry): void => {
        if (entry.closed) return;
        entry.closed = true;

        const hostIndex = stack.indexOf(entry);
        if (hostIndex >= 0) stack.splice(hostIndex, 1);
        handles.delete(entry);

        const layerIndex = layers.findIndex((layer) => layer.entry === entry);
        if (layerIndex >= 0) layers.splice(layerIndex, 1);

        // `layerIndex === layers.length` after the splice means the removed entry
        // was the global top: only then is it safe to move focus. A lower-layer
        // close leaves focus wherever the still-open dialog put it.
        const wasTop = layerIndex >= 0 && layerIndex === layers.length;

        entry.overlay.remove();

        if (layers.length === 0) detachListeners();
        unlockBodyScroll();

        if (wasTop) {
            resolveFocusTarget(entry)?.focus({ preventScroll: true });
        } else if (entry.panel.contains(document.activeElement)) {
            // Defensive: if the removed lower layer somehow held focus, hand it to
            // the current top layer instead of dropping focus to <body>.
            topLayer()?.panel.focus({ preventScroll: true });
        }

        // Lifecycle callback runs last, after DOM/scroll/focus are final, and is
        // intentionally not wrapped: a throwing callback must not make `close()`
        // look like it failed after cleanup already succeeded. The entry is marked
        // closed first, so the throw cannot cause a second cleanup on retry.
        entry.onClose?.();
    };

    return {
        open(options: DialogOptions): DialogHandle {
            const titleText = assertTitle(options.title);
            const content = assertContent(options.content);
            const returnFocus = options.returnFocus;

            // Capture the genuinely focused element before any DOM work. `body` and
            // `<html>` mean "nothing meaningful was focused"; restoring them would
            // be a no-op at best and is deliberately treated as absent.
            const active = document.activeElement;
            const capturedFocus =
                active instanceof HTMLElement && active !== document.body && active !== document.documentElement
                    ? active
                    : null;

            const titleId = nextTitleId();

            // Build the whole layer off-document first so the initial focus and the
            // stack push happen in one deterministic order.
            const overlay = document.createElement('div');
            overlay.className = OVERLAY_CLASS;

            const panel = document.createElement('div');
            panel.className = PANEL_CLASS;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            panel.setAttribute('aria-labelledby', titleId);
            panel.tabIndex = -1;

            const head = document.createElement('div');
            head.className = HEAD_CLASS;

            const title = document.createElement('h2');
            title.className = TITLE_CLASS;
            title.id = titleId;
            title.textContent = titleText;

            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = CLOSE_CLASS;
            closeButton.setAttribute('aria-label', CLOSE_LABEL);
            closeButton.textContent = CLOSE_GLYPH;

            const body = document.createElement('div');
            body.className = BODY_CLASS;
            // `content` is adopted as-is. No innerHTML path exists in this module.
            body.append(content);

            // Title + close first; `installCopyButton` inserts Copy immediately
            // before Close, keeping Close at the far edge.
            head.append(title, closeButton);
            panel.append(head, body);
            overlay.append(panel);

            const entry: DialogEntry = {
                panel,
                overlay,
                head,
                title,
                closeButton,
                body,
                copy: undefined,
                copyButton: undefined,
                capturedFocus,
                returnFocus: returnFocus instanceof HTMLElement ? returnFocus : returnFocus === null ? null : undefined,
                onClose: options.onClose,
                closed: false
            };

            // Opt-in inspection dialogs get the shared Copy control. The source is
            // resolved on activation, never cached here.
            if (options.copy !== undefined) installCopyButton(entry, options.copy);

            const handle: DialogHandle = {
                get element(): HTMLElement {
                    return panel;
                },
                get isOpen(): boolean {
                    return !entry.closed;
                },
                close(): void {
                    closeEntry(entry);
                },
                update(next: DialogUpdate): void {
                    if (entry.closed) return;

                    if (next.title !== undefined) {
                        entry.title.textContent = assertTitle(next.title);
                    }

                    if (next.content !== undefined) {
                        entry.body.replaceChildren(assertContent(next.content));
                    }

                    // `copy: null` removes the control (an async preview settled
                    // with nothing to copy); a source adds or retargets it.
                    if ('copy' in next) {
                        if (next.copy === null || next.copy === undefined) removeCopyButton(entry);
                        else installCopyButton(entry, next.copy);
                    }
                }
            };

            closeButton.addEventListener('click', () => {
                closeEntry(entry);
            });

            // Backdrop click only: the target must be the overlay itself, so a click
            // anywhere inside the panel (including padding/scrollbar area) is inert.
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) closeEntry(entry);
            });

            // Mount first: focus() is meaningless on a detached node.
            (parent ?? document.body).append(overlay);

            stack.push(entry);
            handles.set(entry, handle);
            layers.push({ entry, panel, close: () => closeEntry(entry) });
            attachListeners();
            lockBodyScroll();

            // Initial focus: the panel, so the dialog is announced and Escape/Tab
            // work immediately without aiming Enter/Space at the close button.
            panel.focus({ preventScroll: true });

            return handle;
        },

        closeAll(): void {
            // Snapshot + reverse: `onClose` may mutate the stack (including opening
            // a new dialog), which must not disturb this loop.
            for (const entry of [...stack].reverse()) closeEntry(entry);
        },

        get count(): number {
            return stack.length;
        },

        get top(): DialogHandle | null {
            const top = stack[stack.length - 1];
            return top === undefined ? null : (handles.get(top) ?? null);
        }
    };
};

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------
//
// Lazily created on first open so importing this module (directly or through the
// browser barrel) creates no DOM and touches no globals at module scope.
let defaultHost: DialogHost | undefined;

const host = (): DialogHost => {
    defaultHost ??= createDialogHost();
    return defaultHost;
};

// The convenience API used by transcript/tool integration. Nested calls stack in
// the default host; call `handle.close()` or use Escape/backdrop/close button.
export const openDialog = (options: DialogOptions): DialogHandle => host().open(options);

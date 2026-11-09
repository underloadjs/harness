// The shared DOM layer of the live shell panels (T6/R2-R4).
//
// WHAT BELONGS HERE
// -----------------
// The two panels — Tasks (`harness.tasks`) and Records (`harness.records`) — are the
// first panels this app keeps MOUNTED for the life of a conversation, so they need the
// things a tool card never needed: an announcement channel, a reading position the
// server must not steal, enter/move/leave animation, relative stamps that age, and a
// five-state surface that is never blank. All of that is the same code twice, so it
// lives once here, next to the client that produces the state (./records-client.ts).
//
// THE RULES THIS LAYER ENFORCES
// -----------------------------
//   - Vanilla DOM only: `createElement` + `textContent`, no framework, no innerHTML
//     with model bytes (a record's text is DATA — the same rule ./ui/panels.ts applies
//     to a tool payload).
//   - Every timer and listener is created through an injectable `schedule` and every
//     helper ends in `destroy()`, so a panel disposed by a session switch leaves no
//     clock and no subscriber behind (the property ./runtime.test.ts pins for the
//     runtime itself).
//   - Motion is decoration, never the message: a row's state is an attribute
//     (`data-fresh`, `data-completed`, `data-phase`) and a text label, and
//     `prefers-reduced-motion: reduce` skips the transforms — the same division
//     ./styles.css already draws for the turn tile's pulsing dots.
//   - `matchMedia` is OPTIONAL: it is absent in jsdom and in older shells, so
//     prefers-reduced-motion reads as "motion allowed" there rather than throwing (the
//     identical discipline ./ui/turns.ts applies to the pointer query).
//
// Cross-references:
//   - ./records-panels.ts — the two panels that use every helper below
//   - ./records-client.ts — the state they paint
//   - ../styles.css       — the `.panel-live`, `.panel-*` rules these class names bind
//   - ./runtime.ts        — the mount/dispose cycle that calls `destroy`

// ---------------------------------------------------------------------------
// Element factory (the local `el` every ui module keeps; see ./ui/panels.ts:514)
// ---------------------------------------------------------------------------

// `children` is the composition hook: a row built from three spans should not have to
// append them by hand at every call site. `text` and `children` combine in that order
// (the text first), which is what a label followed by a chip wants.
const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
    children?: readonly HTMLElement[]
): HTMLElementTagNameMap[K] => {
    // The GLOBAL document, exactly as ../main.ts:410 uses it. This module's builders run
    // synchronously inside a mount or a paint, so the shell's document is by definition
    // the live one; a helper that may fire from a timer AFTER the panel is gone must
    // instead build through its owner element (see `createRecordsAnnouncer`'s `region`
    // capture — a late `document.createElement` there throws `document is not defined`
    // in a host that has torn its environment down).
    const node = document.createElement(tag);

    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (children !== undefined) node.append(...children);

    return node;
};

export const recordsElement = el;

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/**
 * Every clock in this module is injectable so a test can advance time without waiting
 * for it. The default is a plain `setTimeout`; the panels pass their mount signal so a
 * disposed panel's pending timers die with it.
 */
export type RecordsSchedule = (callback: () => void, delayMs: number, signal?: AbortSignal) => void;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Relative on the surface, absolute in the tooltip. The steps are deliberately coarse
// (a rail is not a stopwatch): `just now` inside a minute, then minutes, hours, days.
// An unknown or future stamp renders as an empty label — the `<time datetime>` and its
// `title` still carry the fact, so nothing is invented.
export const RECORDS_JUST_NOW_MS = 60_000;

export const recordsRelativeOf = (iso: string | undefined, nowMs: number): string => {
    if (iso === undefined || iso.length === 0) return '';

    const at = Date.parse(iso);
    if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return '';

    const delta = nowMs - at;
    if (delta < 0) return 'just now';
    if (delta < RECORDS_JUST_NOW_MS) return 'just now';

    const minutes = Math.floor(delta / 60_000);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;

    return `${Math.floor(hours / 24)}d`;
};

// The absolute form a tooltip and `datetime` carry. An unparseable stamp keeps the raw
// string (the server's own bytes) rather than rendering `Invalid Date`.
export const recordsIsoOf = (iso: string | undefined): string => {
    if (iso === undefined || iso.length === 0) return '';

    const at = Date.parse(iso);

    return Number.isFinite(at) ? new Date(at).toISOString() : iso;
};

// One timestamp element: `<time datetime>` with the relative label and the absolute
// form in `title`. `data-stamp` marks the ones the panel's clock ages in place.
export const recordsStampOf = (iso: string | undefined, nowMs: number, className = 'panel-stamp'): HTMLElement => {
    const time = el('time', className);
    const absolute = recordsIsoOf(iso);

    time.dataset.stamp = 'true';

    if (absolute.length > 0) {
        time.setAttribute('datetime', absolute);
        time.title = absolute;
    }

    time.textContent = recordsRelativeOf(iso, nowMs);

    return time;
};

// Re-ages every stamp under a root. Cheap by construction: the panels are bounded
// surfaces, and the alternative (re-rendering a whole list per minute) would fight the
// FLIP animations and the reader's selection.
export const refreshRecordsStamps = (root: HTMLElement, nowMs: number): void => {
    for (const node of root.querySelectorAll<HTMLElement>('time[data-stamp]')) {
        const iso = node.getAttribute('datetime') ?? undefined;
        const next = recordsRelativeOf(iso, nowMs);

        if (node.textContent !== next) node.textContent = next;
    }
};

// ---------------------------------------------------------------------------
// Text bounds
// ---------------------------------------------------------------------------

// A record's text can be 4000 characters (the tasks cap); the rail is ~320px wide. A
// truncation is therefore always labelled with the full text (`title`) and, where the
// reader needs all of it, an explicit expand control on the row.
export const RECORDS_TEXT_PREVIEW = 220;

export const recordsTruncate = (
    text: string,
    max = RECORDS_TEXT_PREVIEW
): { text: string; truncated: boolean } =>
    text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}…`, truncated: true };

// ---------------------------------------------------------------------------
// Actor badge
// ---------------------------------------------------------------------------

// An agent name, or the neutral `system` when the store named no caller. The kind is
// published as `data-actor` so the CSS and the tests read the distinction rather than
// comparing label strings. Named `…BadgeOf` because ./records-client.ts already owns
// `recordsActorOf` — the reader that decides WHICH actor an event names — and both
// share the extensions barrel.
export const recordsActorBadgeOf = (
    actor: { name: string; kind: 'agent' | 'system' },
    className = 'panel-actor'
): HTMLElement => {
    const badge = el('span', className, actor.name);

    badge.dataset.actor = actor.kind;
    badge.title =
        actor.kind === 'agent'
            ? `Last changed by ${actor.name}`
            : 'Changed without an agent identity (a restored store, or a caller with no agent context)';

    return badge;
};

// ---------------------------------------------------------------------------
// Motion preference
// ---------------------------------------------------------------------------

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Sampled per call rather than captured at module scope: a host without `matchMedia`
// (jsdom, an embedded shell) must not fail at import, and the reader may change the
// setting while the panel is mounted.
export const recordsReducedMotion = (): boolean => {
    if (typeof globalThis.matchMedia !== 'function') return false;

    try {
        return globalThis.matchMedia(REDUCED_MOTION_QUERY).matches === true;
    } catch {
        // A hostile or partial implementation: assume motion is allowed and let the
        // stylesheet's own media query remove it.
        return false;
    }
};

// ---------------------------------------------------------------------------
// The live region and its announcer
// ---------------------------------------------------------------------------

// One visually-hidden `role=status` region per panel, PRE-MOUNTED before any content:
// a live region that appears at the same moment as the text it should announce is a
// region assistive tech may never have registered. `aria-atomic=false` is the point of
// the batching below — only the line that was added is announced, so a burst does not
// re-read the panel's whole history.
export const recordsLiveRegionOf = (label: string): HTMLElement => {
    const region = el('div', 'panel-live');

    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'false');
    region.setAttribute('aria-label', label);

    return region;
};

export type RecordsAnnouncer = {
    /** Queues one sentence; a burst coalesces into a single announcement. */
    say: (text: string) => void;
    /** Writes whatever is queued NOW (a test seam, and the dispose path's last word). */
    flush: () => void;
    /** Drops the queue (a rebuild that already says everything, or a dispose). */
    cancel: () => void;
    pending: () => string[];
    destroy: () => void;
};

// Burst semantics: while events arrive faster than `delay`, nothing is announced; when
// the burst settles, ONE region update carries the accumulated lines (max 3, oldest
// dropped). Announcing every row of a 40-record import would take the reader's screen
// reader hostage, which is the failure mode this debounce exists to prevent.
export const createRecordsAnnouncer = (options: {
    region: HTMLElement;
    schedule: RecordsSchedule;
    delay?: number;
    limit?: number;
    /** The owner's abort signal: a disposed panel's pending write must not fire at all. */
    signal?: AbortSignal;
}): RecordsAnnouncer => {
    const delay = options.delay ?? 400;
    const limit = options.limit ?? 3;

    const queued: string[] = [];
    let generation = 0;
    let armed = false;
    let destroyed = false;

    const flush = (): void => {
        // A manual flush wins the race against any timer still in flight.
        generation += 1;

        if (destroyed || queued.length === 0) return;

        const lines = queued.splice(0, queued.length);

        // The region holds only the latest lines: an unbounded list would make every
        // later write a re-read of a document nobody asked for. The element is created
        // through the REGION's document, not the global one: a flush can land after the
        // panel has been disposed and the host's environment torn down, and a stray
        // `document.createElement` in that instant is an uncaught ReferenceError.
        const doc = options.region.ownerDocument ?? globalThis.document;

        for (const line of lines) {
            const node = doc.createElement('span');

            node.className = 'panel-live-line';
            node.textContent = line;
            options.region.append(node);
        }

        while (options.region.children.length > limit) options.region.removeChild(options.region.firstChild as Node);
    };

    return {
        say: (text) => {
            if (destroyed || text.length === 0) return;

            queued.push(text);

            // One timer for a whole burst: a later `say` extends the silence rather
            // than arming another write. The token is what makes the older timer a
            // no-op, so nothing has to be cancelled in a host whose schedule cannot.
            if (armed) return;

            armed = true;
            const token = generation;

            options.schedule(() => {
                armed = false;
                if (token === generation) flush();
            }, delay, options.signal);
        },
        flush,
        cancel: () => {
            queued.length = 0;
            generation += 1;
            armed = false;
        },
        pending: () => [...queued],
        destroy: () => {
            destroyed = true;
            queued.length = 0;
            generation += 1;
            armed = false;
        }
    };
};

// ---------------------------------------------------------------------------
// Reading position: the follow controller and its "N new" pill
// ---------------------------------------------------------------------------

export type RecordsFollowController = {
    /** True while the live edge is on screen (the only state that auto-follows). */
    following: () => boolean;
    /** Rows waiting above the reader's position. */
    pending: () => number;
    /**
     * Called BEFORE a batch is inserted: captures where the reader is, so `commit` can
     * decide whether to move them or to hold them still. `insertHeight` is the height
     * the caller expects the batch to add — a newest-first feed cannot measure rows it
     * has not built yet. Without it the controller uses the height of the first child,
     * which is the right answer for an oldest-first list.
     */
    begin: (insertHeight?: number) => { scrollTop: number; shift: number };
    /**
     * Called AFTER the batch. Following → pin to the live edge. Not following → keep
     * the reader on the line they were reading (the inserted height is added back to
     * `scrollTop`) and accumulate the pill count.
     */
    commit: (mark: { scrollTop: number; shift: number }, inserted: number) => void;
    /** Jumps to the live edge and clears the pill (the pill's own click). */
    jump: () => void;
    /** Recomputes `following` from the scroll position and repaints the pill. */
    sync: () => void;
    destroy: () => void;
};

// The distance from the live edge that still counts as "reading the live edge". A few
// pixels of rounding must not turn a followed list into a frozen one.
export const RECORDS_LIVE_EDGE_THRESHOLD = 12;

export const createRecordsFollow = (options: {
    scroller: HTMLElement;
    pill: HTMLButtonElement;
    threshold?: number;
    liveEdge?: 'top' | 'bottom';
    onChange?: (following: boolean, pending: number) => void;
    /** The panel's disposal signal — the scroll listener is registered with it. */
    signal?: AbortSignal;
}): RecordsFollowController => {
    const threshold = options.threshold ?? RECORDS_LIVE_EDGE_THRESHOLD;
    const liveEdge = options.liveEdge ?? 'top';
    const { scroller, pill } = options;

    let waiting = 0;
    let atEdge = true;

    // The live edge, in scroll coordinates: `top` for a newest-first feed, `bottom`
    // for an oldest-first list. In a layout-free environment (a test, a detached
    // element) `scrollHeight === clientHeight`, so the bottom edge is 0 and the
    // controller reads as "at the edge" — which is the honest answer for a list that
    // does not scroll.
    const edgeOffset = (): number =>
        liveEdge === 'top' ? 0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    const distance = (): number => Math.abs(scroller.scrollTop - edgeOffset());

    const paintPill = (): void => {
        const show = waiting > 0 && !atEdge;

        pill.hidden = !show;
        pill.textContent = `${waiting} new`;
        pill.setAttribute('aria-label', `${waiting} new changes above. Activate to jump to the newest.`);
        pill.dataset.pending = String(waiting);
    };

    const sync = (): void => {
        const next = distance() <= threshold;

        // Scrolling back to the live edge IS the follow gesture: the waiting count
        // would otherwise sit there with nothing left to jump to.
        if (next && !atEdge) waiting = 0;

        atEdge = next;
        paintPill();
        options.onChange?.(atEdge, waiting);
    };

    const onScroll = (): void => sync();

    scroller.addEventListener('scroll', onScroll, options.signal === undefined ? undefined : { signal: options.signal });

    const onJump = (): void => {
        waiting = 0;
        atEdge = true;
        scroller.scrollTop = edgeOffset();
        paintPill();
        options.onChange?.(atEdge, waiting);
    };

    pill.addEventListener('click', onJump, options.signal === undefined ? undefined : { signal: options.signal });

    return {
        following: () => atEdge,
        pending: () => waiting,
        begin: (insertHeight?: number) => ({
            scrollTop: scroller.scrollTop,
            // What an insertion ABOVE the reader would otherwise push out from under
            // them: the height the caller says the batch will add, or — for an
            // oldest-first list, and in a layout-free host that reports zeros — the
            // height of the row already at the live edge.
            shift:
                insertHeight ??
                (liveEdge === 'top'
                    ? (scroller.firstElementChild as HTMLElement | null)?.getBoundingClientRect().height ?? 0
                    : 0)
        }),
        commit: (mark, inserted) => {
            if (inserted === 0) {
                sync();

                return;
            }

            if (atEdge) {
                // Followed: the newest content is what the reader asked for, so the
                // edge moves and they come with it.
                scroller.scrollTop = edgeOffset();
                sync();

                return;
            }

            // Frozen: hold the line. The rows arrived above, so the same content stays
            // under the eye by moving the offset down by exactly what was inserted.
            scroller.scrollTop = mark.scrollTop + mark.shift;
            waiting += inserted;
            paintPill();
            options.onChange?.(atEdge, waiting);
        },
        jump: onJump,
        sync,
        destroy: () => {
            // The listener and the pill's click handler both went in with the panel's
            // signal, so the runtime's abort releases them; this is the belt for a host
            // that hands no signal.
            if (options.signal === undefined) {
                scroller.removeEventListener('scroll', onScroll);
                pill.removeEventListener('click', onJump);
            }

            waiting = 0;
        }
    };
};

// The pill itself: a real button (the jump is an action, not a hover decoration) that
// starts hidden and carries its own count for the tests and the CSS.
export const recordsNewPillOf = (): HTMLButtonElement => {
    const pill = el('button', 'panel-new-pill') as HTMLButtonElement;

    pill.type = 'button';
    pill.hidden = true;
    pill.dataset.pending = '0';

    return pill;
};

// ---------------------------------------------------------------------------
// FLIP: keyed enter / move / leave animation
// ---------------------------------------------------------------------------

export type RecordsFlipAnimator = {
    /** Records every keyed row's current top, BEFORE the DOM moves. */
    measure: (root: HTMLElement) => void;
    /**
     * Inverts the movement and plays it back (a no-op when nothing moved). `root`
     * defaults to the document; a panel passes its own element so two mounted lists
     * never animate each other's rows.
     */
    play: (root?: HTMLElement) => void;
    /** Drops the remembered geometry (a wholesale rebuild has no "before"). */
    reset: () => void;
    destroy: () => void;
};

// The vanilla 20-line version of FLIP: measure, mutate, invert, play. Rows are keyed by
// their stable record `id`, which is the only key that survives an `update` (a feed
// `seq` would re-key a record on every edit and animate it as a new arrival).
//
// Motion is skipped entirely under `prefers-reduced-motion` — the attribute
// `data-flip` is still written, because it is the state the tests and the CSS read.
export const createRecordsFlip = (options: {
    schedule: RecordsSchedule;
    duration?: number;
    itemSelector?: string;
    keyOf?: (node: HTMLElement) => string;
    /** The owner's abort signal — an in-flight invert is cancelled with the panel. */
    signal?: AbortSignal;
}): RecordsFlipAnimator => {
    const duration = options.duration ?? 180;
    const selector = options.itemSelector ?? '[data-row-key]';
    const keyOf = options.keyOf ?? ((node: HTMLElement) => node.dataset.rowKey ?? '');

    const before = new Map<string, number>();
    // Bumped on every play/reset/destroy: an in-flight invert belongs to a previous
    // frame and must not fight whatever the next reconciliation paints.
    let generation = 0;
    let destroyed = false;

    return {
        measure: (root) => {
            before.clear();

            for (const node of root.querySelectorAll<HTMLElement>(selector)) {
                const key = keyOf(node);
                if (key.length === 0) continue;
                before.set(key, node.getBoundingClientRect().top);
            }
        },
        play: (root?: HTMLElement) => {
            if (destroyed) return;

            // Default is the live document; a caller may point at a specific root so a
            // page with several animated lists never animates its neighbours.
            const container: ParentNode = root ?? globalThis.document;
            const reduced = recordsReducedMotion();
            const token = generation;

            for (const node of container.querySelectorAll<HTMLElement>(selector)) {
                const key = keyOf(node);
                if (key.length === 0 || !before.has(key)) continue;

                const delta = (before.get(key) as number) - node.getBoundingClientRect().top;

                // The attribute is the durable fact; the transform is decoration that
                // the stylesheet's `prefers-reduced-motion` block never applies.
                node.dataset.flip = delta === 0 ? 'steady' : 'moved';

                if (delta === 0 || reduced) continue;

                // Invert: put the element back where the reader saw it…
                node.style.transform = `translateY(${delta}px)`;
                node.style.transition = 'transform 0s';

                options.schedule(() => {
                    if (token !== generation) return;

                    // …then let it arrive at where it now belongs.
                    node.style.transition = `transform ${duration}ms ease-out`;
                    node.style.transform = '';

                    options.schedule(() => {
                        if (token !== generation) return;
                        node.style.transition = '';
                    }, duration, options.signal);
                }, 0, options.signal);
            }

            generation = token;
            before.clear();
        },
        reset: () => {
            generation += 1;
            before.clear();
        },
        destroy: () => {
            destroyed = true;
            generation += 1;
            before.clear();
        }
    };
};

// ---------------------------------------------------------------------------
// "Just landed" highlight
// ---------------------------------------------------------------------------

export type RecordsFreshMarker = {
    /** Flags a row as newly arrived; the mark expires after `ttl`. */
    mark: (node: HTMLElement) => void;
    clear: (node: HTMLElement) => void;
    clearAll: () => void;
    destroy: () => void;
};

// A short highlight that says "this one is new" without an announcement. The attribute
// is the fact; the colour is CSS. Reduced motion only removes the fade animation (the
// stylesheet), so the mark itself stays readable in every setting.
export const createRecordsFreshMarker = (options: {
    schedule: RecordsSchedule;
    ttl?: number;
    /** The owner's abort signal — a highlight that outlives its panel is a leaked timer. */
    signal?: AbortSignal;
}): RecordsFreshMarker => {
    const ttl = options.ttl ?? 1_500;
    // generation per node: the newest mark owns the expiry, so re-marking a row moves
    // the deadline instead of stacking a second timer on the same element.
    const timers = new Map<HTMLElement, number>();
    let destroyed = false;

    const clear = (node: HTMLElement): void => {
        const token = timers.get(node);

        if (token !== undefined) {
            // Expiry is a generation check rather than a real cancel: a host whose
            // `schedule` cannot be revoked still gets the right answer, and the panel's
            // own abort signal kills the timer when it unmounts.
            timers.delete(node);
            node.dataset.freshToken = String(token + 1);
        }

        delete node.dataset.fresh;
    };

    return {
        mark: (node) => {
            if (destroyed) return;

            const next = Number(timers.get(node) ?? 0) + 1;

            timers.set(node, next);
            node.dataset.fresh = 'true';
            node.dataset.freshToken = String(next);

            options.schedule(() => {
                // Only the newest timer for this node may expire it.
                if (timers.get(node) === next) clear(node);
            }, ttl, options.signal);
        },
        clear,
        clearAll: () => {
            for (const node of [...timers.keys()]) clear(node);
        },
        destroy: () => {
            destroyed = true;

            for (const node of [...timers.keys()]) clear(node);
        }
    };
};

// ---------------------------------------------------------------------------
// The non-ready states: loading, empty, error, stale
// ---------------------------------------------------------------------------

// Skeleton rows that MIRROR the final row layout (same height, same columns), so the
// surface does not jump when the data lands. The delay before a skeleton is worth
// showing at all is the caller's (`RECORDS_SKELETON_DELAY_MS`) — a read that answers
// in 40ms should paint rows, never a shimmer.
export const RECORDS_SKELETON_DELAY_MS = 250;

export const recordsSkeletonOf = (className: string, rows: number, columns: number): HTMLElement => {
    const wrap = el('div', `panel-skeleton ${className}`);

    wrap.dataset.role = 'skeleton';
    wrap.setAttribute('aria-hidden', 'true');

    for (let index = 0; index < rows; index += 1) {
        const row = el('div', `${className}-row`);

        for (let column = 0; column < columns; column += 1) row.append(el('span', `${className}-cell`));
        wrap.append(row);
    }

    return wrap;
};

// The one-line state message every panel uses for `empty`, `error` and `stale`. It is
// a `role=status`-free element on purpose: these states are painted into the panel's
// live region separately, and a second live region per state would announce the same
// sentence twice.
export const recordsStateOf = (
    className: string,
    state: 'empty' | 'error' | 'stale',
    text: string,
    action?: { label: string; run: () => void }
): HTMLElement => {
    const note = el('p', className, text);

    note.dataset.state = state;

    if (action === undefined) return note;

    const button = el('button', `${className}-action`, action.label);

    button.type = 'button';
    button.addEventListener('click', action.run);
    note.append(button);

    return note;
};

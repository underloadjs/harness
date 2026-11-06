// The draggable seams between the chat column and the two rails.
//
// The shell is a five-track grid: [left rail] [seam] [chat] [seam] [right rail]. The
// two rails own its only fixed-width tracks, and this module is what turns those two
// tracks into numbers the reader controls. Each seam is a focusable `role="separator"`
// that, while dragged, writes ONE inline custom property on `.shell`
// (`--rail-left-width` / `--rail-right-width`), which `.shell { grid-template-columns }`
// reads. Nothing is written on the rails themselves and nothing is persisted: a reload
// — like a double-click on a seam — returns the shell to the stylesheet's fallback
// widths.
//
// Why a custom property instead of `rail.style.width`: in a grid it is the TRACK that
// sizes the rail, so a `width` on the element can never claim more than the `248px`
// (or `320px`) it was given, while the property the track reads can. The rails' own
// rules — padding, divider, scroll box — are therefore untouched, and the phone
// drawers (which set their own `width: min(86vw, 320px)`) ignore the property entirely.
//
// Cross-references:
//   - src/frontend/main.ts — builds the shell and appends the two handles;
//   - src/frontend/styles.css — `.shell { grid-template-columns }`, `.rail-resizer*`;
//   - src/frontend/ui/rail-resize.test.ts — the drag, keyboard, clamp and reset contract.

export type RailEdge = 'left' | 'right';

export type RailTrack = {
    /** The custom property the shell's grid track reads. */
    property: string;
    /** Names the rail in the handle's accessible label. */
    label: string;
    /** Narrowest width the handle may drive, in px. */
    min: number;
    /** Widest the handle may drive on its own, in px — the chat's share caps it lower. */
    max: number;
    /** The width the shell paints with no drag. Keep it equal to styles.css's fallback. */
    fallback: number;
};

export const RAIL_TRACKS: Record<RailEdge, RailTrack> = {
    left: { property: '--rail-left-width', label: 'harnesses', min: 180, max: 640, fallback: 248 },
    right: { property: '--rail-right-width', label: 'scratch board', min: 220, max: 720, fallback: 320 }
};

// A drag may never crush the chat column. The widest a rail grows is the shell minus
// this, minus the other rail, minus both seams — so the transcript keeps a usable line
// length however far the reader pulls a panel open.
export const MIN_CENTER_WIDTH = 320;
const SEAM_TOTAL = 12;

// Keyboard sizing: one arrow press is 16px, Shift is 64px, Home returns the default.
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export type RailResizeOptions = {
    /** The grid element whose two outer tracks the seams drive. */
    shell: HTMLElement;
    /**
     * Called after every width change. The chat column's width is what the composer's
     * auto-grow height, the scratch button's anchor and the notched routing label are
     * measured against, so the host re-runs its resize pass here (main.ts).
     */
    onWidthChange?: () => void;
};

export type RailResizers = {
    left: HTMLElement;
    right: HTMLElement;
};

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

export const createRailResizers = ({ shell, onWidthChange }: RailResizeOptions): RailResizers => {
    const edgeOf = (edge: RailEdge): RailEdge => (edge === 'left' ? 'right' : 'left');

    // The width a rail claims right now: the inline property while a drag or a key
    // press holds it, then the value the stylesheet computes, then the module fallback
    // for a host that resolves no custom properties at all (jsdom).
    const widthOf = (edge: RailEdge): number => {
        const track = RAIL_TRACKS[edge];
        const inline = shell.style.getPropertyValue(track.property).trim();
        const declared =
            inline.length > 0 ? inline : window.getComputedStyle(shell).getPropertyValue(track.property).trim();
        const parsed = Number.parseFloat(declared);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : track.fallback;
    };

    // The upper bound for one rail, given what the shell and the OTHER rail currently
    // hold. An unmeasured shell (`clientWidth` 0: jsdom, a hidden shell) has no room to
    // ration, so only the track's own cap applies there.
    const capOf = (edge: RailEdge): number => {
        const track = RAIL_TRACKS[edge];
        const available = shell.clientWidth;
        if (available <= 0) return track.max;
        const other = widthOf(edgeOf(edge));
        return Math.max(track.min, Math.min(track.max, available - MIN_CENTER_WIDTH - other - SEAM_TOTAL));
    };

    const createHandle = (edge: RailEdge): HTMLElement => {
        const track = RAIL_TRACKS[edge];
        const handle = el('div', `rail-resizer rail-resizer-${edge}`);
        handle.setAttribute('role', 'separator');
        // The seam divides the chat from a rail stacked top to bottom, so its own
        // orientation is the axis it runs along; it moves sideways.
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', `Resize the ${track.label} panel`);
        handle.setAttribute('aria-valuemin', String(track.min));
        handle.setAttribute('aria-valuemax', String(track.max));
        handle.setAttribute('aria-valuenow', String(widthOf(edge)));
        handle.title = `Drag to resize the ${track.label} panel. Double-click resets it.`;
        handle.tabIndex = 0;

        const setWidth = (desired: number): void => {
            const width = Math.round(Math.min(Math.max(desired, track.min), capOf(edge)));
            shell.style.setProperty(track.property, `${width}px`);
            handle.setAttribute('aria-valuenow', String(width));
            onWidthChange?.();
        };

        const resetWidth = (): void => {
            shell.style.removeProperty(track.property);
            handle.setAttribute('aria-valuenow', String(widthOf(edge)));
            onWidthChange?.();
        };

        // --- drag ---------------------------------------------------------------
        //
        // The listeners live on the DOCUMENT for the duration of the drag, not on the
        // handle: a fast pull moves the pointer off a 6px strip immediately, and a
        // handle that only hears its own events loses the drag there. Pointer capture is
        // requested too (it keeps the events on the handle, and `preventDefault` on
        // pointerdown stops the drag selecting transcript text), but it is optional —
        // jsdom has no `setPointerCapture`, and the document listeners work without it.
        let drag: { pointerId: number; startX: number; startWidth: number } | undefined;

        const onMove = (event: PointerEvent): void => {
            if (drag === undefined || event.pointerId !== drag.pointerId) return;
            // The right rail grows leftwards, so its delta is mirrored; the seam the
            // reader grabs moves with the width either way.
            const delta = event.clientX - drag.startX;
            setWidth(drag.startWidth + (edge === 'left' ? delta : -delta));
        };

        const endDrag = (event?: PointerEvent): void => {
            if (drag !== undefined && event !== undefined && event.pointerId !== drag.pointerId) return;
            drag = undefined;
            handle.classList.remove('is-resizing');
            document.body.classList.remove('is-resizing-rail');
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', endDrag);
            document.removeEventListener('pointercancel', endDrag);
        };

        handle.addEventListener('pointerdown', (event: PointerEvent) => {
            // Left button (or touch/pen) only: a right-click is a context menu, a middle
            // click a paste, and neither should start a resize.
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            if (drag !== undefined) return;
            event.preventDefault();

            drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: widthOf(edge) };
            handle.classList.add('is-resizing');
            document.body.classList.add('is-resizing-rail');
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', endDrag);
            document.addEventListener('pointercancel', endDrag);
            handle.setPointerCapture?.(event.pointerId);
            // `preventDefault` above suppresses the click's own focus, and the seam is the
            // control the reader is now holding: focusing it means the arrow keys take over
            // the moment the pointer comes up, and a screen reader reports the width the
            // drag landed on. A mouse focus shows no ring (`:focus-visible`).
            handle.focus({ preventScroll: true });
        });

        // --- keyboard -----------------------------------------------------------
        //
        // The seam is a focusable separator, so the arrow keys do what the pointer
        // would: the direction that widens the rail is the direction the rail sits in
        // (right for the harnesses, left for the scratch board).
        handle.addEventListener('keydown', (event: KeyboardEvent) => {
            const grow = edge === 'left' ? 1 : -1;
            let step: number;
            if (event.key === 'ArrowRight') step = grow;
            else if (event.key === 'ArrowLeft') step = -grow;
            else if (
                event.key === 'ArrowUp' ||
                event.key === 'ArrowDown' ||
                event.key === 'Home' ||
                event.key === 'End'
            ) {
                // Nothing vertical to move, and no other axis to scroll: swallow the
                // arrow rather than let it scroll the rail the seam belongs to.
                event.preventDefault();
                if (event.key === 'Home') resetWidth();
                return;
            } else return;

            event.preventDefault();
            setWidth(widthOf(edge) + step * (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP));
        });

        // The no-drag reset: same result as a reload, available on request.
        handle.addEventListener('dblclick', () => resetWidth());

        // A drag that ends in a cancelled pointer, a lost window or a released capture
        // still has to give the page its text selection back.
        handle.addEventListener('lostpointercapture', () => endDrag());

        return handle;
    };

    return { left: createHandle('left'), right: createHandle('right') };
};

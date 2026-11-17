// Tap / press-and-hold state machine for ONE press target (ui/agent-control.ts).
//
// Why a module instead of listeners inside the chip: the outcome of a touch press is
// decided by a RACE between a timer and four different cancel paths, and that race — not
// the chip's markup — is the part a test has to pin exactly. Keeping it here also keeps
// the chip free of timing code and of any assumption about what a tap MEANS (the caller
// decides: cycle, open, focus, nothing).
//
// THE STATE MACHINE
// -----------------
//   pointerdown (an accepting pointer)  -> ARMED: the hold timer runs, `onState('armed')`
//                                          paints the "being held" affordance.
//   timer reaches `threshold`           -> HELD: `onHold()` fires EXACTLY ONCE and
//                                          `onState('held')` keeps the affordance until
//                                          the finger leaves (D8: the visual state lives
//                                          until release, because the action already
//                                          happened and the finger is still down).
//   pointerup while ARMED               -> TAP: `onTap()` fires exactly once.
//   pointerup while HELD/CANCELLED      -> nothing (the press already reported itself).
//   move further than `slop` px,
//   `pointercancel`, `lostpointercapture`,
//   `blur`, or the target leaving the DOM -> CANCELLED: NO action at all. A drag is a
//                                          scroll/selection, not a press. "Leaving the DOM"
//                                          is OBSERVED ON THE NEXT MOVE (`onMove`'s
//                                          `isConnected` check, :166-173) — there is no
//                                          MutationObserver, so a node detached in silence
//                                          leaves the press armed and its release still
//                                          taps. The platform supplies that follow-up in
//                                          practice: capture makes detachment fire
//                                          `lostpointercapture`.
//
// THE SYNTHESISED CLICK
// ---------------------
// A touch press that produces no `click` would be the easy part; the real hazard is that
// a browser ALSO synthesises a `click` after `pointerup`, so a naive click handler would
// open a dialog on top of the cycle the tap already performed (or twice, after a hold).
// `consumeGesture()` is therefore the chip's click guard: it returns true ONCE per
// gesture. A non-accepting pointerdown (a real mouse, or a keyboard `Enter`/`Space`, which
// produces a click with NO pointer events at all) CLEARS the debt, so the next genuine
// click is never swallowed by a stale touch press.
//
// THE DEBT AND A REPLACED TARGET
// ------------------------------
// A tap that CYCLES replaces its own target: main.ts `paintAgentSlot` answers the cycle
// with `agentSlot.replaceChildren(control.element)`, so the click the browser synthesises a
// moment later is hit-tested against the FRESH node — a machine that never saw the press,
// and which would otherwise open the dialog the tap was supposed to avoid. The shell cannot
// hand the old machine's flag to the new one, so the handle exposes `oweClick()`: the shell
// marks the REPLACEMENT as owing one swallowed click, and the fresh node answers its own
// echo. The debt is still per-machine (no global state to leak between hosts), and a new
// press of its own clears it, so a debt that never met a click can never travel.
//
// ENVIRONMENT NOTES (both are jsdom facts this module is written against)
//   - `setPointerCapture`/`releasePointerCapture` do not exist there, so every call is
//     optional-chained and the move/up/cancel listeners live on `document` (the same
//     approach `ui/rail-resize.ts:140-175` takes); capture is a real-browser refinement
//     that retargets the events, never the mechanism itself.
//   - `TouchEvent` is a bare shell without `Touch`/`TouchList`, so the machine is driven
//     by `PointerEvent`s — which is also what a modern browser sends first.
//
// CONTRACT
// --------
//   createPressHold({ target, onTap, onHold, accepts?, threshold?, slop?, onState? })
//       -> { consumeGesture, destroy }
//
// Cross-references:
//   - ui/agent-control.ts  the only production caller (tap = cycle, hold = dialog)
//   - ui/rail-resize.ts:164 the `pointerType`/`button` branching precedent
//   - src/frontend/styles.css `.agent-control-button[data-hold=…]` the affordance

// How long a finger has to stay down before the press means "hold" instead of "tap".
// 500ms is the long-press constant every major touch platform uses (Android 500ms,
// iOS ~500ms), so the page is not inventing a gesture the reader has to learn.
export const PRESS_HOLD_MS = 500;

// Finger travel that still counts as "the same press". Below the platform's own touch
// slop (~10px on both Android and iOS), so a scroll started on the control is the
// browser's, and above the jitter a real finger reports while resting on it.
export const PRESS_SLOP_PX = 10;

// `armed` = the finger is down and the timer is running; `held` = the hold already
// fired and the finger has not left yet; `undefined` = no press. The caller owns the
// visual: this module never touches a class or an attribute.
export type PressState = 'armed' | 'held' | undefined;

export type PressHoldOptions = {
    // The element that receives `pointerdown`. Move/up/cancel listeners are on
    // `document`, because the finger leaves a 32px chip within one move.
    target: HTMLElement;
    // Release BEFORE the threshold, with the finger never having left the slop circle.
    onTap: () => void;
    // The threshold reached while the finger is still down. Fires once per press.
    onHold: () => void;
    // Which pointers may start a gesture. Defaults to `touch`/`pen` (D7: a real mouse
    // keeps the browser's own click semantics).
    accepts?: (event: PointerEvent) => boolean;
    threshold?: number;
    slop?: number;
    onState?: (state: PressState) => void;
};

export type PressHold = {
    // True once for the synthesised `click` that follows a gesture, false for every
    // other click (a mouse click, or a keyboard `Enter`/`Space` activation).
    consumeGesture: () => boolean;
    // Declares a debt this machine never earned: it is the CONTROL THAT REPLACED a node
    // whose press had already acted (see the header). Its next click is swallowed.
    oweClick: () => void;
    // Drop every listener and cancel a pending press without reporting an action.
    destroy: () => void;
};

// The pointer types that mean "a finger or a stylus is on glass". A mouse pointer on a
// touch-capable machine keeps the desktop contract (D7), and an empty `pointerType`
// (jsdom's default `PointerEventInit`, or an engine that does not report one) is NOT
// claimed either, so an unknown input keeps today's behaviour.
const isTouchLike = (event: PointerEvent): boolean =>
    event.pointerType === 'touch' || event.pointerType === 'pen';


export const createPressHold = (options: PressHoldOptions): PressHold => {
    const target = options.target;
    const threshold = options.threshold ?? PRESS_HOLD_MS;
    const slop = options.slop ?? PRESS_SLOP_PX;
    const accepts = options.accepts ?? isTouchLike;

    // One press at a time. `decided` means the press has already produced its outcome
    // (hold fired, or the gesture was cancelled), so no later event can act again.
    type Press = {
        pointerId: number;
        x: number;
        y: number;
        timer: ReturnType<typeof setTimeout> | undefined;
        state: 'armed' | 'held' | 'cancelled';
    };

    let press: Press | undefined;
    // A gesture ran on THIS node and its synthesised click is still owed. Set by a press
    // that decided itself, by `oweClick()` (the replacement of a node whose press already
    // acted), and cleared by the click it pays for or by a fresh press.
    let owed = false;

    const documentOff = (): void => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', onCancel);
    };

    const setState = (state: PressState): void => options.onState?.(state);

    // End the press WITHOUT choosing an action. Used by every cancel leg and by
    // `destroy`; a `held` press releases its visual here, which is the "until release"
    // half of D8.
    const clear = (): void => {
        const current = press;
        press = undefined;
        if (current?.timer !== undefined) clearTimeout(current.timer);
        documentOff();
        setState(undefined);
    };

    const cancel = (): void => {
        if (press === undefined) return;
        // The browser will still synthesise a click after a cancelled touch press in
        // some engines; the debt is what keeps it from acting a second time.
        owed = true;
        clear();
    };

    const onMove = (event: PointerEvent): void => {
        const current = press;
        if (current === undefined || event.pointerId !== current.pointerId) return;
        // A control removed from the DOM mid-press (a chrome repaint during a hold) has
        // no decision left to make.
        if (!target.isConnected) {
            cancel();

            return;
        }

        if (Math.abs(event.clientX - current.x) > slop || Math.abs(event.clientY - current.y) > slop) {
            cancel();
        }
    };

    const finish = (event: PointerEvent): void => {
        const current = press;
        if (current === undefined || event.pointerId !== current.pointerId) return;

        const tapped = current.state === 'armed';

        clear();

        if (!tapped) return;
        owed = true;
        options.onTap();
    };

    const onCancel = (event?: PointerEvent): void => {
        // `pointercancel` is the platform taking the gesture (a scroll, a system edge
        // swipe, the app going to the background): no action, ever.
        if (event === undefined || press === undefined || event.pointerId === press.pointerId) cancel();
    };

    const onDown = (event: PointerEvent): void => {
        if (!accepts(event)) {
            // A mouse (or pen-without-touch) press means the NEXT `click` is a real one,
            // so a debt left by an earlier touch gesture must not swallow it.
            owed = false;

            return;
        }

        if (press !== undefined) return;

        // A press of our own owns its own echo: a debt that never met a click (some
        // engines skip the synthetic click after a touch) must not be paid by a click
        // belonging to THIS press.
        owed = false;

        // No `preventDefault()` here: the chip is a real <button> and the default is what
        // gives it focus (and, on a held press, the text-selection the CSS then removes).
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: undefined, state: 'armed' };
        // Optional: absent in jsdom, and the document listeners work without it.
        target.setPointerCapture?.(event.pointerId);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', onCancel);
        setState('armed');

        press.timer = setTimeout(() => {
            const current = press;
            if (current === undefined || current.state !== 'armed') return;

            current.timer = undefined;
            current.state = 'held';
            owed = true;
            // D8: the affordance stays until release even though the action is done.
            setState('held');
            options.onHold();
        }, threshold);
    };

    // Native long-press interference (D9): on touch, the same press that opens our
    // dialog also raises the OS context menu (and, on iOS, the callout) unless the
    // default is prevented. Scoped to the press that is actually a gesture press, so a
    // right-click menu on a desktop mouse press is untouched.
    const onContextMenu = (event: MouseEvent): void => {
        const pointerType = (event as PointerEvent).pointerType;
        if (press !== undefined || (pointerType !== undefined && pointerType !== 'mouse')) {
            event.preventDefault();
        }
    };

    // A press that loses the control loses its decision: the reader tabbed away, the
    // chip was rebuilt, or the window went away.
    const onBlur = (): void => cancel();
    const onLostCapture = (): void => cancel();

    target.addEventListener('pointerdown', onDown);
    target.addEventListener('contextmenu', onContextMenu);
    target.addEventListener('blur', onBlur);
    target.addEventListener('lostpointercapture', onLostCapture);

    return {
        consumeGesture: (): boolean => {
            if (!owed) return false;
            owed = false;

            return true;
        },
        // The replacement-node case (see the header): the shell rebuilt this control while
        // answering a press that had already acted, so the click about to arrive here is
        // that press's echo and must change nothing.
        oweClick: (): void => {
            owed = true;
        },
        destroy: (): void => {
            target.removeEventListener('pointerdown', onDown);
            target.removeEventListener('contextmenu', onContextMenu);
            target.removeEventListener('blur', onBlur);
            target.removeEventListener('lostpointercapture', onLostCapture);
            clear();
        }
    };
};

// The tap / press-and-hold machine (ui/press-hold.ts) — the part of the composer's agent
// chip that a shell test cannot pin honestly, tested here on its own.
//
// Every case drives the real `PointerEvent` sequence a finger produces and asserts the
// OUTCOME the reader gets, because the whole risk of this control is a press that acts
// twice, acts after a drag, or acts after the platform took the gesture:
//
//   pointerdown(touch) + pointerup BEFORE the threshold -> exactly one `onTap`
//   pointerdown(touch) + the threshold elapses          -> exactly one `onHold`, and the
//                                                          state stays `held` until release
//   pointerdown(touch) + travel past `slop`             -> NO action at all (a drag)
//   pointercancel / lostpointercapture / blur / detached-then-moved -> NO action at all
//   (a node detached IN SILENCE stays armed — see the `no follow-up event` case below)
//   pointerdown(mouse) / a bare `click`                 -> the machine never arms, so the
//                                                          caller's click path is untouched
//
// The synthesised click: a browser fires `click` after `pointerup`, so `consumeGesture()`
// is the chip's guard. It is pinned to return true EXACTLY ONCE per gesture, and to be
// cleared by a mouse pointerdown so an old touch press can never swallow a later real
// click (a keyboard `Enter`/`Space` produces a click with no pointer events at all).
//
// The debt is PER-HANDLE — one `owed` flag inside each machine (ui/press-hold.ts:130-134) —
// and it travels by hand-off, not by being shared: a tap that cycles REPLACES its own target
// (main.ts `paintAgentSlot`), the echo click lands on the FRESH node and finds a NEW machine
// that knows nothing, so the shell calls `oweClick()` on that replacement to move the debt
// across (pinned in the `oweClick hands the echo to a replacement node` case below, and on the
// component side in ui/agent-control.test.ts). A fresh press of either handle clears the debt,
// and `destroy()` retires the handle that still holds it — which is why every case below
// destroys the handle it made.
//
// Timing is fake (`vi.useFakeTimers`), so every claim about WHEN the hold fires names an
// exact tick with no slack — 499ms must not fire, 500ms must. `vi.useRealTimers()` runs in
// `afterEach`, or the fake clock leaks into the next file's real-timer `flush()` helper.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/press-hold.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESS_HOLD_MS, PRESS_SLOP_PX, createPressHold } from './press-hold';
import type { PressHold, PressState } from './press-hold';

// The `pointer()` shape `ui/rail-resize.test.ts:55` uses: jsdom 29 builds real
// PointerEvents (including `pointerType`), while `TouchEvent` there is a bare shell with
// no `Touch`/`TouchList` — so a PointerEvent is the only honest way into this machine.
const pointer = (type: string, init: PointerEventInit = {}): PointerEvent =>
    new PointerEvent(type, { bubbles: true, cancelable: true, ...init });

type Rig = {
    target: HTMLButtonElement;
    handle: PressHold;
    /** Every action the machine reported, in order (`tap` / `hold`). */
    actions: string[];
    /** Every state transition, including the release back to `undefined`. */
    states: PressState[];
};

const rig = (): Rig => {
    document.body.innerHTML = '';

    const target = document.createElement('button');
    target.className = 'agent-control-button';
    document.body.append(target);

    const actions: string[] = [];
    const states: PressState[] = [];
    const handle = createPressHold({
        target,
        onTap: () => actions.push('tap'),
        onHold: () => actions.push('hold'),
        onState: (state) => states.push(state)
    });

    return { target, handle, actions, states };
};

const press = (target: HTMLElement, init: PointerEventInit = {}): void => {
    target.dispatchEvent(pointer('pointerdown', { button: 0, ...init }));
};

const move = (init: PointerEventInit): void => {
    document.dispatchEvent(pointer('pointermove', init));
};

const release = (init: PointerEventInit): void => {
    document.dispatchEvent(pointer('pointerup', init));
};

// One finger, resting at (40,22). Every case below is the same press with one different
// thing happening, which is what makes the outcomes comparable.
const finger = { pointerId: 1, pointerType: 'touch' as const, clientX: 40, clientY: 22 };

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    // Non-negotiable: a leaked fake clock makes any later real-timer `flush()` in this
    // process wait on a timer that can never fire.
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('a touch press', () => {
    it('reports a tap on release before the threshold, and nothing else', () => {
        const { target, handle, actions, states } = rig();

        press(target, finger);
        release(finger);

        expect(actions).toEqual(['tap']);
        // `armed` while the finger is down, released back to nothing on up: the
        // affordance never outlives the press.
        expect(states).toEqual(['armed', undefined]);

        handle.destroy();
    });

    it('fires the hold at exactly the threshold and keeps the state until release', () => {
        const { target, handle, actions, states } = rig();

        press(target, finger);

        // One millisecond short of the promise: armed, and nothing has happened.
        vi.advanceTimersByTime(PRESS_HOLD_MS - 1);
        expect(actions).toEqual([]);
        expect(states).toEqual(['armed']);

        vi.advanceTimersByTime(1);
        expect(actions).toEqual(['hold']);
        // D8: the affordance stays `held` while the finger is down even though the action
        // already ran — otherwise the press looks like it did nothing.
        expect(states).toEqual(['armed', 'held']);

        release(finger);
        // Release does NOT act again: the hold already reported itself.
        expect(actions).toEqual(['hold']);
        expect(states).toEqual(['armed', 'held', undefined]);

        // A press after a released hold is a NEW decision, not a stuck machine.
        press(target, { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 22 });
        release({ pointerId: 2, pointerType: 'touch' });
        expect(actions).toEqual(['hold', 'tap']);

        handle.destroy();
    });

    it('acts at most once however long the finger stays down', () => {
        const { target, handle, actions } = rig();

        press(target, finger);
        vi.advanceTimersByTime(PRESS_HOLD_MS * 4);

        expect(actions).toEqual(['hold']);

        handle.destroy();
    });

    it('owes exactly one swallowed click for the gesture it performed', () => {
        const { target, handle } = rig();

        // No press yet (a bare `HTMLElement.click()`, or a mouse): not ours to swallow.
        expect(handle.consumeGesture()).toBe(false);

        press(target, finger);
        release(finger);

        // The browser's synthetic click, once: the cycle already happened, and a second
        // action would open the dialog on top of it.
        expect(handle.consumeGesture()).toBe(true);
        expect(handle.consumeGesture()).toBe(false);

        // A mouse press means the NEXT click is a real one, so a debt that never met a
        // click (some engines skip the synthetic click after a touch) cannot swallow it.
        press(target, finger);
        release(finger);
        press(target, { pointerId: 8, pointerType: 'mouse', button: 0 });
        expect(handle.consumeGesture()).toBe(false);

        handle.destroy();
    });

    it('oweClick hands the echo of a replaced node\'s press to the control that took its place', () => {
        // The shell sequence the method exists for: a tap CYCLES, main.ts `paintAgentSlot`
        // replaces the slot's children, and the click the browser then synthesises is
        // hit-tested against the FRESH node (press-hold.ts's header). The shell marks that
        // node as owing the click, and it answers the echo — exactly once.
        const first = rig();
        press(first.target, finger);
        const second = rig();
        release(finger);

        expect(first.target.isConnected).toBe(false);
        expect(first.actions).toEqual(['tap']);
        // Without the hand-off this machine would answer the click with its own action.
        expect(second.handle.consumeGesture()).toBe(false);

        second.handle.oweClick();
        expect(second.handle.consumeGesture()).toBe(true);
        expect(second.handle.consumeGesture()).toBe(false);

        first.handle.destroy();
        second.handle.destroy();
    });

    it('a press of its own clears a debt that never met a click', () => {
        // Some engines skip the synthetic click entirely. A debt that is still outstanding
        // when a NEW press starts must not be paid by that press's click, or one gesture
        // would silently swallow the next one.
        const { target, handle, actions } = rig();

        press(target, finger);
        release(finger);
        expect(actions).toEqual(['tap']);

        press(target, finger);
        release(finger);
        expect(actions).toEqual(['tap', 'tap']);
        // The second press owns its own echo: one debt, paid once.
        expect(handle.consumeGesture()).toBe(true);
        expect(handle.consumeGesture()).toBe(false);

        handle.destroy();
    });
});

// The chip's repaint replaces the node a tap acted on, so the shell hands that press's
// outstanding echo to the replacement through `oweClick`. The component half of the hand-off
// is pinned in ui/agent-control.test.ts, and the reader-visible outcome — a tap that
// switches the agent without opening the settings dialog — in the live shell case
// composer-agent-cycle.test.ts (`owes exactly one swallowed click…` and `oweClick hands the
// echo of a replaced node's press…` below are the machine halves).

describe('a cancelled press', () => {
    const cancels: Record<string, () => void> = {
        'pointermove past the slop': () =>
            move({ pointerId: 1, pointerType: 'touch', clientX: 40 + PRESS_SLOP_PX + 1, clientY: 22 }),
        pointercancel: () => document.dispatchEvent(pointer('pointercancel', finger)),
        lostpointercapture: () => document.querySelector('.agent-control-button')?.dispatchEvent(new Event('lostpointercapture')),
        blur: () => document.querySelector('.agent-control-button')?.dispatchEvent(new Event('blur'))
    };

    for (const [name, cancel] of Object.entries(cancels)) {
        it(`${name} performs no action, and its release stays silent`, () => {
            const { target, handle, actions, states } = rig();

            press(target, finger);
            expect(states).toEqual(['armed']);

            cancel();

            // The timer is gone: a cancelled press must not sprout a hold later.
            vi.advanceTimersByTime(PRESS_HOLD_MS * 2);
            expect(actions).toEqual([]);
            expect(states).toEqual(['armed', undefined]);

            release(finger);
            expect(actions).toEqual([]);

            handle.destroy();
        });
    }

    it('a target removed from the DOM mid-press performs no action', () => {
        const { target, handle, actions, states } = rig();

        press(target, finger);
        target.remove();
        // The move is the first event after the removal (a chrome repaint during a hold).
        move({ pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 22 });

        vi.advanceTimersByTime(PRESS_HOLD_MS * 2);
        release(finger);

        expect(actions).toEqual([]);
        expect(states).toEqual(['armed', undefined]);

        handle.destroy();
    });

    it('a target removed with no follow-up event still taps on release, so the removal case needs its cancel', () => {
        // G10, pinning the CURRENT semantics rather than a wish: `onMove` is the only leg that
        // inspects `target.isConnected` (press-hold.ts:166-173), and the release leg does not —
        // it only matches the pointer id. Nor does detaching cancel anything by itself: the
        // listeners live on `document` and the hold timer is a plain `setTimeout`, so a node that
        // disappears IN SILENCE leaves the press armed. On the real wire that silence is rare —
        // where `setPointerCapture` exists, detaching the node fires `lostpointercapture` and the
        // press IS cancelled (the `cancels` table above); jsdom implements neither capture nor
        // that event, which is exactly why the case above drives a move after the removal.
        // The tap therefore runs against a detached target, where the caller's own listeners are
        // already off the live tree — the repaint that removed the node owns the outcome, the same
        // contract D8 pins for a tap that cycled (its action had already run on the old node).
        // If the release leg ever grows an `isConnected` guard, THIS is the case that must
        // change, and the removal case above stops being load-bearing.
        const { target, handle, actions, states } = rig();

        press(target, finger);
        target.remove();
        // Released before the threshold, so the press is still `armed` and the release leg is
        // the thing being examined (the timer never runs here).
        release(finger);

        expect(actions).toEqual(['tap']);
        expect(states).toEqual(['armed', undefined]);
        // And the echo of that press is still owed, exactly as for an attached tap: the
        // replacement node's `oweClick()` is what pays it.
        expect(handle.consumeGesture()).toBe(true);
        expect(handle.consumeGesture()).toBe(false);

        handle.destroy();
    });

    it('keeps the press alive for travel inside the slop, and that tap still acts', () => {
        const { target, handle, actions } = rig();

        press(target, finger);
        // A resting finger jitters; that is not a scroll.
        move({ pointerId: 1, pointerType: 'touch', clientX: 40 + PRESS_SLOP_PX, clientY: 22 });
        release({ pointerId: 1, pointerType: 'touch', clientX: 40 + PRESS_SLOP_PX, clientY: 22 });

        expect(actions).toEqual(['tap']);

        handle.destroy();
    });

    it('ignores a pointer that is not the press', () => {
        const { target, handle, actions } = rig();

        press(target, finger);
        // A second finger landing elsewhere is not this press — and must not cancel it.
        move({ pointerId: 12, pointerType: 'touch', clientX: 500, clientY: 500 });
        release({ pointerId: 12, pointerType: 'touch' });
        expect(actions).toEqual([]);

        release(finger);
        expect(actions).toEqual(['tap']);

        handle.destroy();
    });
});

describe('a mouse press', () => {
    it('never arms the machine, so the click path is untouched', () => {
        const { target, handle, actions, states } = rig();

        press(target, { pointerId: 13, pointerType: 'mouse', button: 0 });
        vi.advanceTimersByTime(PRESS_HOLD_MS * 2);
        release({ pointerId: 13, pointerType: 'mouse' });

        expect(actions).toEqual([]);
        expect(states).toEqual([]);
        // The desktop click — and a keyboard `Enter`/`Space`, which has no pointer events
        // at all — therefore reach the caller as an ordinary click.
        expect(handle.consumeGesture()).toBe(false);

        handle.destroy();
    });

    it('suppresses the native context menu only for a press that is a gesture', () => {
        const { target, handle } = rig();

        // Long-press on glass: the OS menu would sit on top of the dialog the hold opens.
        const touchMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.defineProperty(touchMenu, 'pointerType', { value: 'touch' });
        target.dispatchEvent(touchMenu);
        expect(touchMenu.defaultPrevented).toBe(true);

        // A right-click with a real mouse is the reader asking for a menu.
        const mouseMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.defineProperty(mouseMenu, 'pointerType', { value: 'mouse' });
        target.dispatchEvent(mouseMenu);
        expect(mouseMenu.defaultPrevented).toBe(false);

        // Mid-hold it is suppressed whatever the event reports, because the hold owns
        // this press (D9).
        press(target, finger);
        const heldMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        target.dispatchEvent(heldMenu);
        expect(heldMenu.defaultPrevented).toBe(true);

        handle.destroy();
    });
});

describe('destroy', () => {
    it('leaves no pending decision and no listener behind', () => {
        const { target, handle, actions, states } = rig();

        press(target, finger);
        handle.destroy();

        vi.advanceTimersByTime(PRESS_HOLD_MS * 2);
        release(finger);

        expect(actions).toEqual([]);
        expect(states).toEqual(['armed', undefined]);

        // The target's own listeners are gone too: a new press changes nothing.
        press(target, { pointerId: 16, pointerType: 'touch' });
        expect(states).toEqual(['armed', undefined]);
    });
});

it('exports the gesture bounds its own documentation names', () => {
    // These two numbers are the promise the control makes to the reader (platform
    // long-press ~500ms, platform touch slop ~10px); a silent retune would change the
    // gesture without changing a test.
    expect(PRESS_HOLD_MS).toBe(500);
    expect(PRESS_SLOP_PX).toBe(10);
});

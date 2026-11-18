// The composer's agent chip as a COMPONENT (ui/agent-control.ts) — no shell, no fetch,
// no stylesheet: what is pinned here is the contract between a press and the two
// callbacks the shell implements, plus the accessible name each device is told.
//
//   DEVICE                     PLAIN PRESS          HOLD (touch only)   aria-haspopup
//   `fine`  (mouse)            onActivate (dialog)  —                   'dialog'
//   `unknown` (no matchMedia)  onActivate (dialog)  —                   'dialog'
//   `coarse` (touch)           onCycle(+1)          onActivate (dialog)  ABSENT
//   cycling BLOCKED, any device onActivate (dialog) —                    'dialog'
//
// The blocked row is D6's promise: a one-agent team (or a view that hides the slot) must
// not leave a dead control, so the chip degrades to its old R11 self AND says why in the
// accessible name.
//
// Also pinned: the button is still ONE control (no cycle button, no chevron, no popover
// — the negative half of R11 survives the new press semantic), the label spans are both
// in the DOM for the CSS width swap, the identity/activity paint lands on the WRAPPER,
// the hold affordance is an attribute, and the component imports no stylesheet (every
// rule it depends on is styles.css, pinned by ui/compact-control-style.test.ts).
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/agent-control.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentDescriptor } from '../../server/protocol';
import { createAgentControl } from './agent-control';
import type { AgentControl, AgentControlOptions } from './agent-control';
import { PRESS_HOLD_MS, PRESS_SLOP_PX } from './press-hold';

const agents: AgentDescriptor[] = [
    { name: 'instruct', title: 'Instruct', description: '', instruction: '', guidelines: [] },
    { name: 'research', title: 'Researcher', description: '', instruction: '', guidelines: [] },
    { name: 'workspace', title: 'Coder', description: '', instruction: '', guidelines: [] }
];

const pointer = (type: string, init: PointerEventInit = {}): PointerEvent =>
    new PointerEvent(type, { bubbles: true, cancelable: true, ...init });

type Rig = {
    element: HTMLElement;
    button: HTMLButtonElement;
    // The handle itself, for the API that is not about the node (`oweClick`).
    control: AgentControl;
    // Every cycle the shell was asked for, in order (1 forward, -1 backward).
    cycles: number[];
    // Every dialog activation: one entry per activation.
    activations: string[];
};

const rig = (overrides: Partial<AgentControlOptions> = {}): Rig => {
    document.body.innerHTML = '';

    const cycles: number[] = [];
    const activations: string[] = [];
    const control = createAgentControl({
        agent: 'instruct',
        agents,
        device: 'fine',
        onCycle: (direction) => cycles.push(direction),
        onActivate: () => activations.push('activate'),
        ...overrides
    });

    document.body.append(control.element);

    const button = control.element.querySelector<HTMLButtonElement>('.agent-control-button');
    if (button === null) throw new Error('missing .agent-control-button');

    return { element: control.element, button, control, cycles, activations };
};

const press = (button: HTMLElement, init: PointerEventInit = {}): void => {
    button.dispatchEvent(pointer('pointerdown', { button: 0, ...init }));
};

const release = (init: PointerEventInit = {}): void => {
    document.dispatchEvent(pointer('pointerup', init));
};

const move = (init: PointerEventInit): void => {
    document.dispatchEvent(pointer('pointermove', init));
};

const touch = { pointerId: 1, pointerType: 'touch' as const, clientX: 30, clientY: 12 };

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('the desktop control', () => {
    it('names the agent and states that a press opens the settings', () => {
        const { button } = rig();

        // The exact string `composer-agent-control.test.ts` pins in the live shell, and
        // the string this control has always shipped: unchanged where behaviour is
        // unchanged (D10).
        expect(button.getAttribute('aria-label')).toBe('Agent: Instruct. Open agent settings.');
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');
        expect(button.title).toBe('Agent settings for Instruct');
        expect(button.getAttribute('aria-expanded')).toBeNull();
    });

    it('opens the dialog on a click and never cycles', () => {
        const { button, cycles, activations } = rig();

        button.click();

        expect(activations).toHaveLength(1);
        expect(cycles).toEqual([]);
    });

    it('keeps the fine-pointer contract when the device is unknown', () => {
        // No `matchMedia` (jsdom-less engines): an undetected device must not be handed a
        // destructive gesture, so this is today's control with today's words (D7).
        const { button, cycles, activations } = rig({ device: 'unknown' });

        expect(button.getAttribute('aria-label')).toBe('Agent: Instruct. Open agent settings.');
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');

        press(button, touch);
        release(touch);
        button.click();

        expect(activations).toHaveLength(1);
        expect(cycles).toEqual([]);
    });

    it('paints the label spans, the identity host and the activity state on the wrapper', () => {
        const { element, button } = rig({ activity: ['instruct'] });

        // ONE button, and no trace of the retired cycle/chevron/popover design.
        expect(element.querySelectorAll('button')).toHaveLength(1);
        expect(element.querySelector('.agent-control-cycle')).toBeNull();
        expect(element.querySelector('.agent-control-model-toggle')).toBeNull();
        expect(element.querySelector('.agent-control-popover')).toBeNull();

        // Both labels are in the DOM at every width: the 860px swap is pure CSS.
        expect(button.querySelector('.agent-control-name')?.textContent).toBe('Instruct');
        expect(button.querySelector('.agent-control-code')?.textContent).toBe('IT');
        expect(button.querySelector('.agent-control-code')?.getAttribute('aria-hidden')).toBe('true');

        // R4: the tone and the activity host are the WRAPPER, so one paint covers the
        // name, the code and the ring (ui/activity.ts selects `data-agent`).
        expect(element.getAttribute('data-agent')).toBe('instruct');
        expect(element.getAttribute('data-activity')).toBe('active');
        expect(element.getAttribute('aria-busy')).toBe('true');
    });

    it('paints the agent the shell resolved, not the entry agent it happens to be', () => {
        // The chip is the composer's promise about the NEXT message, so the shell passes
        // the pending selection as `agent` and the label follows it (D10).
        const { element, button } = rig({ agent: 'research' });

        expect(button.querySelector('.agent-control-name')?.textContent).toBe('Researcher');
        expect(button.querySelector('.agent-control-code')?.textContent).toBe('RR');
        expect(button.getAttribute('aria-label')).toBe('Agent: Researcher. Open agent settings.');
        expect(element.getAttribute('data-agent')).toBe('research');
    });

    it('keeps the tooltip honest when team editing is locked', () => {
        const { button } = rig({ hint: 'Wait for the current run to finish before changing the agents or instructions.' });

        expect(button.disabled).toBe(false);
        expect(button.title).toBe('Wait for the current run to finish before changing the agents or instructions.');
        expect(button.getAttribute('aria-label')).toBe('Agent: Instruct. Open agent settings.');
    });
});

describe('the touch control', () => {
    it('states the gesture instead of a plain press, and drops the dialog hint', () => {
        const { button } = rig({ device: 'coarse', hint: 'Edits here change this conversation only.' });

        expect(button.getAttribute('aria-label')).toBe(
            'Agent: Instruct. Tap to switch agent, press and hold for settings.'
        );
        // D10: `aria-haspopup="dialog"` is only truthful while a PLAIN press opens the
        // modal. Here a plain press cycles, so the attribute goes.
        expect(button.hasAttribute('aria-haspopup')).toBe(false);
        expect(button.title).toBe('Edits here change this conversation only. Tap to switch agent; press and hold to open agent settings.');
    });

    it('keeps the settings sentence in the touch tooltip when the shell has no reason to state', () => {
        // No `hint`: the default fine tooltip is `Agent settings for X`, and the touch
        // device adds its two presses as a SECOND sentence rather than running the two
        // halves together.
        const { button } = rig({ device: 'coarse' });

        expect(button.title).toBe(
            'Agent settings for Instruct. Tap to switch agent; press and hold to open agent settings.'
        );
    });

    it('cycles forward on a tap, with no activation and no hold state left behind', () => {
        const { button, cycles, activations } = rig({ device: 'coarse' });

        press(button, touch);
        expect(button.dataset.hold).toBe('armed');

        release(touch);

        expect(cycles).toEqual([1]);
        expect(activations).toHaveLength(0);
        expect(button.dataset.hold).toBeUndefined();
    });

    it('opens the dialog on a hold, keeps the affordance until release, and swallows the synthetic click', () => {
        const { button, cycles, activations } = rig({ device: 'coarse' });

        press(button, touch);
        vi.advanceTimersByTime(PRESS_HOLD_MS);

        expect(activations).toHaveLength(1);
        expect(cycles).toEqual([]);
        // D8: the state stays visible while the finger is down.
        expect(button.dataset.hold).toBe('held');

        release(touch);
        expect(button.dataset.hold).toBeUndefined();

        // The browser fires `click` after the pointerup. It must not open a second
        // dialog, and it must not cycle either — exactly one swallow.
        button.click();
        expect(activations).toHaveLength(1);
        expect(cycles).toEqual([]);
        button.click();
        expect(activations).toHaveLength(2);
    });

    it('hands the echo of a gesture to the control that replaced the pressed chip', () => {
        // A tap that CYCLES makes the shell rebuild the slot (main.ts `paintAgentSlot`
        // replaces its children), so the click the browser synthesises lands on a FRESH
        // node. `oweClick` is how the shell tells that node the press already acted;
        // without the hand-off, the tap that switched the agent would ALSO open the
        // settings dialog on top of the switch.
        const first = rig({ device: 'coarse' });
        press(first.button, touch);
        release(touch);
        expect(first.cycles).toEqual([1]);

        const second = rig({ device: 'coarse' });
        second.control.oweClick();
        second.button.click();
        expect(second.activations).toHaveLength(0);
        expect(second.cycles).toEqual([]);
        // Paid once: the NEXT click is a press of its own.
        second.button.click();
        expect(second.activations).toHaveLength(1);
    });

    it('oweClick is a no-op on a device with no gesture machine', () => {
        // A fine pointer has no echo to swallow, so the hand-off cannot disarm the desktop
        // click that opens the dialog.
        const { control, button, activations } = rig({ device: 'fine' });

        control.oweClick();
        button.click();

        expect(activations).toHaveLength(1);
    });

    it('performs nothing for a drag, a cancel or a blur, and swallows their synthetic click once', () => {
        const cases = [
            {
                name: 'a drag past the slop',
                cancel: (button: HTMLElement) =>
                    move({ pointerId: 1, pointerType: 'touch', clientX: 30 + PRESS_SLOP_PX + 1, clientY: 12 })
            },
            {
                name: 'pointercancel',
                cancel: () => document.dispatchEvent(pointer('pointercancel', touch))
            },
            {
                name: 'blur',
                cancel: (button: HTMLElement) => button.dispatchEvent(new Event('blur'))
            }
        ];

        for (const entry of cases) {
            const { button, cycles, activations } = rig({ device: 'coarse' });

            press(button, touch);
            entry.cancel(button);
            vi.advanceTimersByTime(PRESS_HOLD_MS * 2);
            release(touch);

            expect(cycles).toEqual([]);
            expect(activations).toHaveLength(0);
            expect(button.dataset.hold).toBeUndefined();

            button.click();
            expect(activations).toHaveLength(0);
            expect(cycles).toEqual([]);
        }
    });

    it('leaves a real mouse press on a touch-capable machine to the browser', () => {
        // D7: the DEVICE axis arms the machine, but the actual `pointerType` decides each
        // press — a mouse click on a touchscreen laptop still opens the dialog.
        const { button, cycles, activations } = rig({ device: 'coarse' });

        press(button, { pointerId: 7, pointerType: 'mouse', button: 0 });
        vi.advanceTimersByTime(PRESS_HOLD_MS * 2);
        release({ pointerId: 7, pointerType: 'mouse' });
        button.click();

        expect(activations).toHaveLength(1);
        expect(cycles).toEqual([]);
    });

    it('treats a keyboard activation as a plain press, whatever the device says', () => {
        const { button, cycles, activations } = rig({ device: 'coarse' });

        // Enter/Space on the focused chip produces a click with NO pointer events, and so
        // does jsdom's `HTMLElement.click()`: neither is a gesture.
        button.focus();
        button.click();

        expect(activations).toHaveLength(1);
        expect(cycles).toEqual([]);
    });

    it('suppresses the native long-press menu but not a right-click', () => {
        const { button } = rig({ device: 'coarse' });

        const touchMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.defineProperty(touchMenu, 'pointerType', { value: 'touch' });
        button.dispatchEvent(touchMenu);
        expect(touchMenu.defaultPrevented).toBe(true);

        const mouseMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.defineProperty(mouseMenu, 'pointerType', { value: 'mouse' });
        button.dispatchEvent(mouseMenu);
        expect(mouseMenu.defaultPrevented).toBe(false);
    });
});

describe('a team with nothing to cycle', () => {
    it('states why, keeps the dialog semantics, and never arms a gesture', () => {
        const blocked = 'This team has one agent, so there is nothing to switch between.';
        const { button, cycles, activations } = rig({ device: 'coarse', cycleBlocked: blocked });

        expect(button.getAttribute('aria-label')).toBe(`Agent: Instruct. ${blocked} Open agent settings.`);
        // A plain press opens the dialog on EVERY device now, so the hint is back.
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');

        press(button, touch);
        expect(button.dataset.hold).toBeUndefined();
        release(touch);
        button.click();

        expect(cycles).toEqual([]);
        expect(activations).toHaveLength(1);
    });

    it('states the reason on a desktop device too', () => {
        const { button, activations } = rig({
            device: 'fine',
            cycleBlocked: 'Agent switching is not available in this view.'
        });

        expect(button.getAttribute('aria-label')).toBe(
            'Agent: Instruct. Agent switching is not available in this view. Open agent settings.'
        );
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');

        button.click();
        expect(activations).toHaveLength(1);
    });
});

describe('the fallbacks', () => {
    it('names an agent the catalogue never carried without leaking its raw id', () => {
        const { button } = rig({ agent: 'ghost' });

        // Same rule as ui/agents.ts `displayTitleOf`: the neutral word, never the id.
        expect(button.getAttribute('aria-label')).toBe('Agent: Agent. Open agent settings.');
    });

    it('imports no stylesheet, so the component stays CSS-free', () => {
        const source = readFileSync(resolve(process.cwd(), 'src/frontend/ui/agent-control.ts'), 'utf8');

        // jsdom resolves no media queries, which is why every rule this control needs is
        // pinned as TEXT in ui/compact-control-style.test.ts — and why this file must not
        // grow an `import './agent-control.css'` that would quietly move the contract.
        expect(source.match(/^import[^;\n]*\.css['"];/m)).toBeNull();
    });
});

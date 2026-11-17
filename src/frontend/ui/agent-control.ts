// Compact agent button inside the composer frame (R10/R11 + the T1 cycle/hold split).
//
// The user's two previous designs are GONE on purpose:
//   1. the entry-agent transcript button on the left flank (R9 removes it with its
//      plumbing), and
//   2. the "cycle the primary + chevron disclosure" pair on the right flank (R11
//      replaces both with ONE button).
//
// It is still ONE button — no chevron, no second control, no disclosure popover — but
// pressing it now means two different things depending on HOW it is pressed:
//
//   desk  (a positively fine primary pointer)
//         click / Enter / Space  -> open the shared agent dialog (R11, unchanged),
//                                    and `Tab` in the field cycles the agent (main.ts);
//   touch (a positively coarse primary pointer)
//         tap                    -> cycle to the next agent (no request),
//         press and hold ≥ ~500ms-> open the SAME agent dialog,
//   unknown (no `matchMedia`)    -> exactly the desktop behaviour: an undetected device
//                                    never gets a destructive gesture.
//
// The cycle is a PENDING choice the shell holds per conversation (main.ts
// `Instance.agentSelection`): this component never touches the team, never sends a
// request, and never claims a promotion. What the button PAINTS is the agent the shell
// resolved for the next send (`primary` below), so the chip and the routing label can
// only ever state one answer.
//
// CONTRACT
// --------
//   createAgentControl({ primary, agents, activity, hint, device, cycleBlocked?,
//                        onCycle, onActivate })
//       -> { element, focus() }
//
// `element` is `.agent-control` (the activity/dataset host, see ui/activity.ts
// `paintActivity`); the only child is the real `<button>`. The component is CSS-free:
// every rule it relies on lives in styles.css.
//
// LABEL
// -----
// The visible label is the full display title at wide widths and the threading code
// (`Researcher` -> `RR`, ui/agent-label.ts) at small widths (styles.css media
// query). Both spans stay in the DOM so resizing needs no rebuild. The button's
// `aria-label` always carries the full title AND the action that press performs ON THIS
// DEVICE, so the compact code is never the accessible name (D10).
//
// The button is never disabled: a frozen saved-session team still needs the dialog
// for models and instructions (R2/R12 — only TEAM changes are locked, and the dialog
// paints that restriction on the controls that actually enforce it). `hint` is
// surfaced as the tooltip and inside the dialog instead of pretending the button is
// unavailable.
//
// WHEN CYCLING IS NOT AVAILABLE (`cycleBlocked`, D6) the button degrades to its R11
// self on EVERY device — a plain press opens the dialog, `Tab` is left to the browser —
// and the reason is stated in the accessible name and the tooltip, so the control is
// never silently dead.
//
// IDENTITY COLOUR (T5/R4): the wrapper is painted through ui/agent-color.ts, so the
// composer's agent name (`Instruct`) and its compact code (`IT`) carry the SAME tone as
// that agent's transcript blocks and its dialog badge. Painting the WRAPPER rather than
// the label is deliberate: custom properties inherit, so one call covers the name, the
// code and the activity frame, and `data-agent` lands on the host ui/activity.ts
// selects. styles.css keeps the accent colour reserved for hover/activity, so the
// identity colour never has to compete with a state colour for the same property.
//
// Cross-references:
//   - src/frontend/main.ts          builds the control, holds the pending selection,
//                                   commits it at send, and owns the Tab/Shift+Tab leg
//   - src/frontend/ui/press-hold.ts the tap / hold / cancel machine this control drives
//   - src/frontend/ui/agent-color.ts paintAgentColor (the identity tone of this button)
//   - src/frontend/ui/agent-dialog.ts  the modal content (deck + instructions)
//   - src/frontend/ui/agents.ts     createAgentRow / createAgentModelSelect
//   - src/frontend/ui/agent-label.ts agentCodeOf (shared threading code)
//   - src/frontend/styles.css       `.agent-control*`, `.composer-controls`

import type { AgentDescriptor } from '../../server/protocol';
import { createPressHold } from './press-hold';
import { paintAgentColor } from './agent-color';
import { agentCodeOf } from './agent-label';

// The component is a handle (not only its node) so the shell can restore focus to
// the fresh button after replacing the slot on a chrome rebuild.
export type AgentControl = {
    element: HTMLElement;
    focus: () => void;
    // T1: call this on a control that REPLACED the node a touch gesture already acted on
    // (a tap cycles, and `paintAgentSlot` rebuilds the chip to show the new agent). The
    // browser still delivers that press's synthesised `click`, and it is hit-tested against
    // THIS node, so without the hand-off the tap that switched the agent would also open
    // the settings dialog on top of it.
    oweClick: () => void;
};

// The primary-pointer axis, already resolved by the shell (main.ts `hasFinePointer`).
// `unknown` is an engine with no `matchMedia` and keeps the desktop contract; `coarse`
// is the ONLY value that arms the touch gestures (D7).
export type AgentControlDevice = 'fine' | 'coarse' | 'unknown';

// `1` = the next agent in roster order (wrap-around), `-1` = the previous one.
export type AgentCycleDirection = 1 | -1;

export type AgentControlOptions = {
    // The agent this chip PAINTS: the shell's pending selection when there is one, and
    // the team's entry agent otherwise. It is not the team's primary, and nothing here
    // promotes it.
    primary: string;
    // Trusted preset library; supplies the display title and the compact code.
    agents: readonly AgentDescriptor[];
    // Agents that should show the activity ring right now (the instance's live set).
    activity?: readonly string[];
    // Honest reason shown as the tooltip while team editing is locked (frozen saved
    // session, in-flight run, session creation). Omitted when editing is allowed.
    hint?: string;
    // Device axis for the press semantics AND the accessible name (D7/D10).
    device: AgentControlDevice;
    // Present when a press must NOT cycle, with the reason the label states (D6): a
    // one-agent team, or a view that hides the control. A press then opens the dialog
    // on every device.
    cycleBlocked?: string;
    // Asks the shell to move the pending selection. No request: the choice is committed
    // at send (D2/D3).
    onCycle: (direction: AgentCycleDirection) => void;
    // Opens the shared agent dialog. main.ts resolves the CURRENT instance at press
    // time, so a rebuilt button never opens a dialog for a conversation left behind.
    onActivate: () => void;
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

// Visible title for an agent. A descriptor with no title (never one of the built-in
// profiles, but possible from an old server) falls back to the neutral word, never
// the raw id, matching ui/agents.ts `displayTitleOf`.
const titleOf = (agents: readonly AgentDescriptor[], name: string): string => {
    const found = agents.find((agent) => agent.name === name);
    const title = found?.title.trim() ?? '';

    return title.length > 0 ? title : 'Agent';
};

// The two action sentences, kept as constants so the label a screen reader hears and
// the tooltip a sighted reader hovers are built from the SAME words (D10).
const OPEN_SENTENCE = 'Open agent settings.';
const GESTURE_SENTENCE = 'Tap to switch agent, press and hold for settings.';
const GESTURE_TOOLTIP = 'Tap to switch agent; press and hold to open agent settings.';

export const createAgentControl = (options: AgentControlOptions): AgentControl => {
    const cycling = options.cycleBlocked === undefined;
    // Gestures need BOTH halves of D7: the DEVICE is positively coarse, and the actual
    // `PointerEvent.pointerType` says touch/pen (enforced in ui/press-hold.ts). A fine
    // or unknown device therefore keeps the browser's click → dialog path untouched.
    const gesturable = cycling && options.device === 'coarse';

    // The wrapper keeps the historical `.agent-control` class and `data-agent`:
    // ui/activity.ts paints its ring through exactly this selector, and styles.css
    // owns the compact shape.
    const wrapper = el('div', 'agent-control');
    // R4 (T5): ONE paint sets the identity tone for the whole control — the name, the
    // compact code and the frame the activity ring draws — and writes `data-agent`,
    // the attribute ui/activity.ts `paintActivity` selects on. Custom properties
    // inherit, so the two labels need no paint of their own and a chrome rebuild
    // cannot desynchronise them.
    //
    // The id stored here is the CANONICAL one (trimmed). The previous raw write only
    // ever mattered for a padded id, and a padded `data-agent` could not match the
    // server's activity names anyway; a blank/`unknown` primary now carries no identity
    // attribute at all, exactly like the transcript's unattributable tiles.
    paintAgentColor(wrapper, options.primary);

    const title = titleOf(options.agents, options.primary);

    const button = el('button', 'agent-control-button');
    button.type = 'button';

    // ACCESSIBLE NAME (D10): which agent this is, then what a press does on THIS
    // device, then why a cycle is unavailable when it is. `aria-haspopup="dialog"` is
    // deliberately NOT static — it is only truthful while a plain press really does
    // open the modal, i.e. on a fine/unknown device, or on any device once cycling is
    // blocked and a tap falls back to the dialog (D6).
    button.setAttribute(
        'aria-label',
        cycling
            ? `Agent: ${title}. ${options.device === 'coarse' ? GESTURE_SENTENCE : OPEN_SENTENCE}`
            : `Agent: ${title}. ${options.cycleBlocked ?? ''} ${OPEN_SENTENCE}`
    );
    if (gesturable) button.removeAttribute('aria-haspopup');
    else button.setAttribute('aria-haspopup', 'dialog');

    // The tooltip, for the pointer that can actually hover it. `hint` is main.ts's
    // honest reason when team editing is locked; the default states what the press is for
    // WITHOUT promising a model switch (D12). On a touch device the two presses are added
    // as their own sentence, joined so the two halves stay readable — and the fine device
    // keeps the exact string it has always shipped.
    const base = options.hint ?? `Agent settings for ${title}`;
    button.title =
        cycling && options.device === 'coarse'
            ? `${/[.!?]$/.test(base) ? base : `${base}.`} ${GESTURE_TOOLTIP}`
            : base;

    const code = el('span', 'agent-control-code', agentCodeOf(title));
    // The compact code is decoration for sighted users: the explicit aria-label
    // above is the accessible name at every width.
    code.setAttribute('aria-hidden', 'true');
    button.append(el('span', 'agent-control-name', title), code);

    // The hold affordance (D8) is an ATTRIBUTE, never a class: styles.css owns the
    // look, this control owns the state, and `data-*` is how every other state in this
    // package is painted (`data-activity`, `data-mode`, `data-state`).
    const gesture = gesturable
        ? createPressHold({
              target: button,
              onTap: () => options.onCycle(1),
              onHold: () => options.onActivate(),
              onState: (state) => {
                  if (state === undefined) delete button.dataset.hold;
                  else button.dataset.hold = state;
              }
          })
        : undefined;

    button.addEventListener('click', () => {
        // A touch gesture decides its own action on `pointerup`; the browser then
        // synthesises this click, so exactly one of them is swallowed (D8). A keyboard
        // `Enter`/`Space` activation has NO preceding pointer event, and neither does a
        // mouse click, so both reach `onActivate` and open the dialog.
        if (gesture?.consumeGesture() === true) return;

        options.onActivate();
    });

    wrapper.append(button);

    // Snapshot-time activity: main.ts also repaints this wrapper from the live
    // instance set on every frame (ui/activity.ts `paintActivity`).
    if (options.activity?.includes(options.primary) === true) {
        wrapper.dataset.activity = 'active';
        wrapper.setAttribute('aria-busy', 'true');
    }

    return {
        element: wrapper,
        focus: () => button.focus(),
        // Only a control that actually has a gesture machine can owe one: on a fine/unknown
        // device (or a locked roster) there is no echo to swallow, and the desktop click
        // path stays exactly as it was.
        oweClick: () => gesture?.oweClick()
    };
};

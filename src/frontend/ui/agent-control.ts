// Compact agent button inside the composer frame (R10/R11).
//
// The user's two previous designs are GONE on purpose:
//   1. the entry-agent transcript button on the left flank (R9 removes it with its
//      plumbing), and
//   2. the "cycle the primary + chevron disclosure" pair on the right flank (R11
//      replaces both with ONE button that opens a dialog).
//
// The button therefore has exactly one job: open the shared agent dialog
// (ui/agent-dialog.ts) where the primary, every model and every instruction can be
// inspected. It never changes the team by itself, so a stray click cannot promote an
// agent, and there is no chevron/menu to confuse with the send control.
//
// CONTRACT
// --------
//   createAgentControl({ primary, agents, activity, hint, onActivate })
//       -> { element, focus() }
//
// `element` is `.agent-control` (the activity/dataset host, see ui/activity.ts
// `paintActivity`); the only child is the real `<button>`.
//
// LABEL
// -----
// The visible label is the full display title at wide widths and the threading code
// (`Researcher` -> `RR`, ui/agent-label.ts) at small widths (styles.css media
// query). Both spans stay in the DOM so resizing needs no rebuild. The button's
// `aria-label` always carries the full title AND the action, so the compact code is
// never the accessible name.
//
// The button is never disabled: a frozen saved-session team still needs the dialog
// for models and instructions (R2/R12 — only TEAM changes are locked, and the dialog
// paints that restriction on the controls that actually enforce it). `hint` is
// surfaced as the tooltip and inside the dialog instead of pretending the button is
// unavailable.
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
//   - src/frontend/main.ts          builds the control + opens the dialog
//   - src/frontend/ui/agent-color.ts paintAgentColor (the identity tone of this button)
//   - src/frontend/ui/agent-dialog.ts  the modal content (deck + instructions)
//   - src/frontend/ui/agents.ts     createAgentRow / createAgentModelSelect
//   - src/frontend/ui/agent-label.ts agentCodeOf (shared threading code)
//   - src/frontend/styles.css       `.agent-control*`, `.composer-controls`

import type { AgentDescriptor } from '../../server/protocol';
import { paintAgentColor } from './agent-color';
import { agentCodeOf } from './agent-label';

// The component is a handle (not only its node) so the shell can restore focus to
// the fresh button after replacing the slot on a chrome rebuild.
export type AgentControl = {
    element: HTMLElement;
    focus: () => void;
};

export type AgentControlOptions = {
    // The agent currently running as primary.
    primary: string;
    // Trusted preset library; supplies the display title and the compact code.
    agents: readonly AgentDescriptor[];
    // Agents that should show the activity ring right now (the instance's live set).
    activity?: readonly string[];
    // Honest reason shown as the tooltip while team editing is locked (frozen saved
    // session, in-flight run, session creation). Omitted when editing is allowed.
    hint?: string;
    // Opens the shared agent dialog. main.ts resolves the CURRENT instance at click
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

export const createAgentControl = (options: AgentControlOptions): AgentControl => {
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
    // A dialog, not a menu/disclosure: aria-haspopup tells AT what the press does,
    // and there is deliberately no aria-expanded (a modal is not an expanded region
    // of this button).
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', `Agent: ${title}. Open agent settings.`);
    button.title = options.hint ?? `Agent settings for ${title}`;

    const code = el('span', 'agent-control-code', agentCodeOf(title));
    // The compact code is decoration for sighted users: the explicit aria-label
    // above is the accessible name at every width.
    code.setAttribute('aria-hidden', 'true');
    button.append(el('span', 'agent-control-name', title), code);

    button.addEventListener('click', () => options.onActivate());

    wrapper.append(button);

    // Snapshot-time activity: main.ts also repaints this wrapper from the live
    // instance set on every frame (ui/activity.ts `paintActivity`).
    if (options.activity?.includes(options.primary) === true) {
        wrapper.dataset.activity = 'active';
        wrapper.setAttribute('aria-busy', 'true');
    }

    return {
        element: wrapper,
        focus: () => button.focus()
    };
};

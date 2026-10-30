// Shared agent dialog (R11/R12).
//
// R11 replaced the old right-flank pair (a primary-cycling button + a model chevron
// disclosure) with ONE composer button that opens this modal. The dialog is the
// place where the reader can:
//   - choose a different PRIMARY agent (a clear pressed-button list — the deck's
//     overlapping cards make promotion a hard-to-discover two-step on a modal);
//   - change every agent's MODEL through the existing per-agent selects;
//   - add/remove team members through the existing deck (add picker included);
//   - READ each agent's instruction and guidelines (read-only preset details).
//
// Everything is built from the EXISTING catalogue/team UI: the deck is
// `createAgentRow(...)` (adopted, not cloned, so its PATCH handlers and model
// selects are unchanged) and instructions use `createAgentPresetDetail(...)`, the
// same details/summary markup the preset picker renders. There is no second API and
// no client-side team rule here.
//
// HONEST STATE
// ------------
// `editable` is the TEAM lock (frozen saved-session team, in-flight run, session
// creation). When it is false the primary buttons and the deck's promotion/add/
// remove controls are disabled by their own components, and `hint` states the real
// reason. Models stay live in a saved session (R2) exactly as before: the deck's
// model selects enforce their own rule.
//
// LIVE UPDATES WITHOUT LOSING FOCUS
// ---------------------------------
// main.ts rebuilds the chrome after every server-confirmed change (a promotion, a
// model PATCH, an activity frame). `update(next)` rebuilds the content in place and
// restores focus to the SAME logical control (primary button, model select, tile
// control, picker option, instruction summary). Without that, replacing content
// while the dialog is open would drop the reader onto the close button.
//
// The dialog itself is ui/dialog.ts: Escape/backdrop/close-button, focus trapping
// and focus restoration are already owned there. `onClose` lets main.ts forget its
// handle and hand focus back to the (rebuilt) composer button if the original opener
// was replaced while the modal was open.
//
// Cross-references:
//   - src/frontend/main.ts            open/refresh/close lifecycle, PATCH handlers
//   - src/frontend/ui/agent-control.ts the composer button that opens this dialog
//   - src/frontend/ui/agents.ts       createAgentRow + createAgentPresetDetail
//   - src/frontend/ui/dialog.ts       modal stack/focus/scroll lock
//   - src/frontend/styles.css         `.agent-dialog*`

import type { AgentDescriptor } from '../../server/protocol';
import {
    agentDetailsOf,
    createAgentPresetDetail,
    createAgentRow,
    displayTitleOf
} from './agents';
import type { AgentModelSelect } from './agents';
import { paintActivity as paintAgentActivity } from './activity';
import { openDialog } from './dialog';

// Everything the dialog paints. Deliberately the same shape the deck takes, plus the
// primary chooser's own state; main.ts derives these once per chrome paint.
export type AgentDialogOptions = {
    members: readonly string[];
    primary: string;
    agents: readonly AgentDescriptor[];
    // TEAM editing (promotion/add/remove). Models have their own flag inside
    // `models` (R2: a saved session keeps live models).
    editable: boolean;
    models: AgentModelSelect;
    activity?: readonly string[];
    // The real reason team editing is locked. Shown as a note; never invented.
    hint?: string;
    // Deck view state, owned by main.ts so a rebuild keeps the viewed card.
    front?: string;
    onFront?: (name: string) => void;
    onSelectPrimary: (name: string) => void;
    onAdd: (name: string) => void;
    onRemove: (name: string) => void;
    // After the dialog layer is gone (main.ts clears its handle here).
    onClose?: () => void;
};

export type AgentDialog = {
    readonly isOpen: boolean;
    close(): void;
    // Replace the content from fresh state; a no-op after close.
    update(next: AgentDialogOptions): void;
    // Repaint ONLY the activity ring on the existing tiles. Used for live event
    // frames: rebuilding the whole dialog for every `start`/`done` would collapse
    // open instruction details and churn focus while the reader is mid-interaction.
    paintActivity(active: ReadonlySet<string>): void;
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

// Same neutral fallback as ui/agent-control.ts and ui/agents.ts `displayTitleOf`.
const titleOf = (agents: readonly AgentDescriptor[], name: string): string => {
    const found = agents.find((agent) => agent.name === name);
    const title = found?.title.trim() ?? '';

    return title.length > 0 ? title : 'Agent';
};

const dialogTitle = (options: AgentDialogOptions): string =>
    `Agents · ${titleOf(options.agents, options.primary)}`;

// Build the whole body off-document. main.ts owns `openDialog`; this module only
// supplies content, so it stays testable without the app shell.
const buildContent = (options: AgentDialogOptions): HTMLElement => {
    const root = el('div', 'agent-dialog');

    // Honest lock reason. R7 removed the row's permanent notice, but INSIDE a dialog
    // that offers team controls the restriction must be stated, not guessed from a
    // disabled button.
    if (options.hint !== undefined && options.hint.length > 0) {
        root.append(el('p', 'agent-dialog-note', options.hint));
    }

    // --- primary choice ------------------------------------------------------
    // One button per member, aria-pressed on the current primary. This is the
    // explicit "choose a different agent" affordance R11/R12 asks for; it calls the
    // same `onSelectPrimary` PATCH path as the deck's promotion control.
    const primarySection = el('section', 'agent-dialog-section');
    primarySection.setAttribute('aria-label', 'Primary agent');
    primarySection.append(el('p', 'agent-dialog-label', 'Primary agent'));

    const primaryList = el('div', 'agent-dialog-primary-list');
    for (const name of options.members) {
        const label = displayTitleOf(agentDetailsOf(options.agents, name));
        const choose = el('button', 'agent-dialog-primary', label);
        choose.type = 'button';
        choose.dataset.agent = name;
        choose.setAttribute('aria-pressed', name === options.primary ? 'true' : 'false');
        // The current primary is a truthful no-op target, so it is not offered as an
        // action; a locked team disables the whole list (the reason is the note).
        choose.disabled = !options.editable || name === options.primary;
        choose.title = !options.editable
            ? (options.hint ?? 'The agent team is locked.')
            : name === options.primary
              ? `${label} is the primary agent.`
              : `Make ${label} the primary agent.`;

        choose.addEventListener('click', () => {
            if (!options.editable || name === options.primary) return;
            options.onSelectPrimary(name);
        });

        primaryList.append(choose);
    }
    primarySection.append(primaryList);
    root.append(primarySection);

    // --- team deck (models, add/remove, front card) --------------------------
    const teamSection = el('section', 'agent-dialog-section');
    teamSection.setAttribute('aria-label', 'Agent team');
    teamSection.append(el('p', 'agent-dialog-label', 'Team and models'));
    teamSection.append(
        createAgentRow({
            members: options.members,
            primary: options.primary,
            agents: options.agents,
            editable: options.editable,
            models: options.models,
            activity: options.activity ?? [],
            // The dialog IS the disclosure; styles.css hides the deck's phone
            // summary inside it and keeps the cards visible, so `expanded` is always
            // true here (there is nothing left for the summary to collapse).
            expanded: true,
            ...(options.front === undefined ? {} : { front: options.front }),
            ...(options.onFront === undefined ? {} : { onFront: options.onFront }),
            onSelectPrimary: options.onSelectPrimary,
            onAdd: options.onAdd,
            onRemove: options.onRemove
        })
    );
    root.append(teamSection);

    // --- instructions --------------------------------------------------------
    // Members first (the agents this conversation can run), then every other preset
    // the catalogue advertises. `createAgentPresetDetail` is read-only and keeps the
    // instruction/guidelines wording the server sent.
    const instructions = el('section', 'agent-dialog-section agent-dialog-instructions');
    instructions.setAttribute('aria-label', 'Agent instructions');
    instructions.append(el('p', 'agent-dialog-label', 'Instructions'));

    const listed = new Set<string>();
    for (const name of [...options.members, ...options.agents.map((agent) => agent.name)]) {
        if (listed.has(name)) continue;
        listed.add(name);

        const descriptor = agentDetailsOf(options.agents, name);
        instructions.append(createAgentPresetDetail(descriptor, displayTitleOf(descriptor)));
    }
    root.append(instructions);

    return root;
};

// A stable description of the focused control, so a content rebuild can put focus
// back on the SAME logical control. Values are agent ids / aria-labels, not DOM
// references: the old nodes are discarded by `replaceChildren`.
const focusKeyOf = (root: HTMLElement): string | undefined => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined;

    const primary = active.closest<HTMLElement>('.agent-dialog-primary');
    if (primary?.dataset.agent !== undefined) return `primary:${primary.dataset.agent}`;

    const select = active.closest<HTMLSelectElement>('.agent-model-select');
    if (select !== null) return `model:${select.getAttribute('aria-label') ?? ''}`;

    const tile = active.closest<HTMLElement>('.agent-tile[data-agent]');
    if (tile?.dataset.agent !== undefined) {
        if (active.classList.contains('agent-main')) return `main:${tile.dataset.agent}`;
        if (active.classList.contains('agent-remove')) return `remove:${tile.dataset.agent}`;
        if (active.classList.contains('agent-handle')) return `handle:${tile.dataset.agent}`;
    }

    const option = active.closest<HTMLElement>('.agent-option[data-agent]');
    if (option?.dataset.agent !== undefined) return `option:${option.dataset.agent}`;

    if (active.classList.contains('agent-add')) return 'add';
    if (active.classList.contains('agent-summary')) return 'summary';

    const detail = active.closest<HTMLElement>('details.agent-detail');
    if (detail !== null) {
        const details = Array.from(root.querySelectorAll<HTMLElement>('details.agent-detail'));
        return `detail:${details.indexOf(detail)}`;
    }

    return undefined;
};

// Find the equivalent control in the rebuilt content and focus it. Disabled controls
// are skipped: a model select can become disabled while a run starts, and focusing
// it would be a lie.
const focusByKey = (root: HTMLElement, key: string): void => {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const value = key.slice(separator + 1);

    const focus = (element: HTMLElement | null): void => {
        if (element !== null && !(element as HTMLButtonElement | HTMLSelectElement).disabled) {
            element.focus();
        }
    };

    if (kind === 'primary') {
        focus(
            Array.from(root.querySelectorAll<HTMLElement>('.agent-dialog-primary')).find(
                (element) => element.dataset.agent === value
            ) ?? null
        );
        return;
    }

    if (kind === 'model') {
        focus(
            Array.from(root.querySelectorAll<HTMLElement>('.agent-model-select')).find(
                (element) => element.getAttribute('aria-label') === value
            ) ?? null
        );
        return;
    }

    if (kind === 'option') {
        const option = Array.from(root.querySelectorAll<HTMLElement>('.agent-option')).find(
            (element) => element.dataset.agent === value
        );
        focus(option?.querySelector<HTMLButtonElement>('.agent-option-add') ?? null);
        return;
    }

    if (kind === 'main' || kind === 'remove' || kind === 'handle') {
        const tile = Array.from(root.querySelectorAll<HTMLElement>('.agent-tile')).find(
            (element) => element.dataset.agent === value
        );
        const selector =
            kind === 'main' ? '.agent-main' : kind === 'remove' ? '.agent-remove' : '.agent-handle';
        focus(tile?.querySelector<HTMLButtonElement>(selector) ?? null);
        return;
    }

    if (kind === 'add') {
        focus(root.querySelector<HTMLButtonElement>('.agent-add'));
        return;
    }

    if (kind === 'summary') {
        focus(root.querySelector<HTMLButtonElement>('.agent-summary'));
        return;
    }

    if (kind === 'detail') {
        const details = root.querySelectorAll<HTMLElement>('details.agent-detail');
        focus(details[Number(value)]?.querySelector<HTMLElement>('summary') ?? null);
    }
};

// Open one agent dialog. main.ts keeps the returned handle, updates it on chrome
// rebuilds (`update`) and closes it on a lifecycle change (`close`).
export const openAgentDialog = (options: AgentDialogOptions): AgentDialog => {
    let content = buildContent(options);
    let open = true;

    const handle = openDialog({
        title: dialogTitle(options),
        content,
        onClose: () => {
            open = false;
            options.onClose?.();
        }
    });

    return {
        get isOpen(): boolean {
            return open;
        },
        close(): void {
            if (!open) return;
            open = false;
            handle.close();
        },
        update(next: AgentDialogOptions): void {
            if (!open) return;

            // Capture focus BEFORE the old nodes are discarded.
            const key = focusKeyOf(content);
            content = buildContent(next);
            handle.update({ title: dialogTitle(next), content });
            if (key !== undefined) focusByKey(content, key);
        },
        paintActivity(active: ReadonlySet<string>): void {
            if (!open) return;
            paintAgentActivity(content, active);
        }
    };
};

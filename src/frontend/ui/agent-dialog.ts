// The agent configuration dialog (T3/R3: one tab strip, editable configuration).
//
// PRODUCT RULE
// ------------
// ONE strip of clickable tabs lists the agents THIS conversation/harness actually has
// — the team members, primary first, exactly as the server reports them. Selecting a
// tab shows THAT agent's configuration: its instruction (editable), its model
// (editable) and its trusted preset instruction (read-only reference). Nothing else
// is listed: an agent the team does not select has no configuration here yet, so it
// gets its own tab through the `[+]` control instead.
//
// Selecting a tab is a VIEW change. It never promotes and never writes: making an
// agent the primary is an explicit control (`Make primary`) inside its own panel, so
// reading a teammate's prompt cannot arm a promotion nobody asked for.
//
// The bottom-right action is the only thing that writes to the server. X / backdrop /
// Escape / a programmatic `close()` therefore discard everything by construction —
// nothing was ever sent. That is the whole purpose of the draft layer below:
// selection, editing, adding and removing are LOCAL until the explicit action.
//
// DRAFTS
// ------
// `state.drafts` is a per-agent map of what the reader actually changed,
// `state.selected` is the active tab and `state.promote` is the armed promotion. All
// three live in this closure, so:
//   - a live refresh (`update()` from a chrome rebuild) repaints from the newest
//     server answer WITHOUT clobbering a touched field: an untouched agent follows
//     the server, a touched one keeps its draft;
//   - switching tabs keeps every other agent's draft, so configuring three agents and
//     then saving writes all three at once;
//   - dismissal drops them (the next open starts from the server's truth).
//
// The baseline maps (`options.models.models`, `options.instructions`) are the
// server's answer, so an editor always opens on the TRUTH, and the diff against it
// is what `changesOf()` reports to `onApply`. An explicit '' in a draft means
// "clear the override" (use the resolved default model / the trusted preset
// instruction), which is how a saved override is reverted.
//
// THE ROSTER (who has a tab)
// --------------------------
// `rosterOf()` is the saved team PLUS the drafted adds MINUS the drafted removals.
// It is the only listing in the dialog, and `[+]` offers exactly the catalogue agents
// missing from it. Removing a member drops its tab immediately (the roster shown is
// the roster the save would produce); the draft still carries `member: false` so the
// delta is honest, and re-adding it through `[+]` cancels the removal.
//
// TRANSACTIONAL APPLY
// -------------------
// `onApply` is async and must report `{ applied, message? }`. Only an applied write
// clears the drafts; a refused or dropped write keeps the dialog open, keeps every
// draft, and paints the reason in `.agent-dialog-error` beside the action. The
// dialog deliberately stays open after a success (the footer reports it), because a
// confident close is exactly the claim a failed save must not make.
//
// HONEST RESTRICTIONS
// -------------------
// `editable` is the TEAM lock (a saved conversation's frozen team, an in-flight run,
// a session being created). It gates `[+]`, `Make primary`, `Remove from team` and
// the instruction editor. Models keep their own flag inside `models` (a saved session
// edits its live model map), so the dialog offers model editing exactly where the
// server does.
//
// R3 removed the lock EXPLANATION paragraph: the restriction is stated where it
// bites — the footer's one short line says what Save can actually do here, and every
// locked control carries the real reason (`hint` from main.ts) as its accessible
// description. A disabled control that cannot say why is the failure mode.
//
// LIVE ACTIVITY WITHOUT LOSING FOCUS
// ----------------------------------
// `update(next)` rebuilds the body in place and restores focus to the SAME logical
// control (tab, `[+]`, add option, instruction textarea including its caret, model
// select, action button). Activity frames go through `paintActivity()` instead, which
// only touches the tabs' ring attributes — it never rebuilds, so typing is never
// interrupted mid-frame.
//
// The modal itself is ui/dialog.ts: Escape/backdrop/close-button, focus trapping and
// focus restoration live there. `onClose` lets main.ts forget its handle.
//
// Cross-references:
//   - src/frontend/main.ts             open/refresh/close lifecycle + onApply PATCH
//   - src/frontend/ui/agent-control.ts the composer button that opens this dialog
//   - src/frontend/ui/agents.ts        createAgentModelSelect/createAgentPresetDetail
//   - src/frontend/ui/activity.ts      paintActivity (the dialog's tabs keep the
//                                      `.agent-dialog-agent[data-agent]` host it paints)
//   - src/frontend/ui/dialog.ts        modal stack/focus/scroll lock
//   - src/frontend/ui/agent-dialog.css `.agent-dialog*`

import type { AgentDescriptor } from '../../server/protocol';
import {
    UNKNOWN_MODEL_LABEL,
    agentDetailsOf,
    createAgentModelSelect,
    createAgentPresetDetail,
    displayTitleOf
} from './agents';
import type { AgentModelSelect } from './agents';
import { paintActivity as paintAgentActivity } from './activity';
import { openDialog } from './dialog';
import type { DialogHandle } from './dialog';

// What ONE explicit apply sends to main.ts. Everything is a DELTA plus the resulting
// promotion; main.ts is the only module that knows whether a write goes to
// PATCH /harnesses/:name or PATCH /sessions/:id, and it owns merging these deltas
// onto the server's current state (the effective-vs-override distinction).
//
// R3 changed WHICH control produces `primary` (an explicit `Make primary`, not the
// tab selection) and `add` (the `[+]` picker, not "viewing an outside agent"), but the
// shape is exactly the one main.ts already merges onto the stored team.
export type AgentConfigurationApply = {
    // The agent the reader was configuring (the active tab).
    agent: string;
    // Present ONLY when the action also promotes: the agent to make primary.
    primary?: string;
    // Model choices the reader touched: agent id → model id, or '' for "use the
    // resolved default" (delete the override).
    models: Record<string, string>;
    // Instruction choices the reader touched: agent id → text, or '' for "revert to
    // the trusted preset instruction".
    instructions: Record<string, string>;
    // Explicit membership changes. `add` comes from `[+]`, `remove` from
    // `Remove from team`; `add` never removes anyone, and a promoted agent is never
    // in `remove`.
    add: string[];
    remove: string[];
};

// How main.ts reports the write back. `applied: false` keeps the dialog open with
// its drafts; `message` is the honest outcome shown beside the action.
export type AgentApplyResult = {
    applied: boolean;
    message?: string;
};

// Everything the dialog paints. main.ts derives it once per chrome paint.
export type AgentDialogOptions = {
    members: readonly string[];
    primary: string;
    // The trusted agent library from GET /agents (or the boot fallback).
    agents: readonly AgentDescriptor[];
    // TEAM + instruction editing. Models carry their own flag inside `models`.
    editable: boolean;
    models: AgentModelSelect;
    // The stored per-agent INSTRUCTION OVERRIDES (the textarea's baseline). A member
    // absent here runs its trusted preset instruction, which is the text the editor
    // is seeded with.
    instructions: Readonly<Record<string, string>>;
    activity?: readonly string[];
    // The real reason the team/instructions are locked. Used as the accessible
    // description of every locked control; never invented.
    hint?: string;
    // The one write path. See `AgentConfigurationApply`.
    onApply: (changes: AgentConfigurationApply) => Promise<AgentApplyResult>;
    // After the dialog layer is gone (main.ts clears its handle here).
    onClose?: () => void;
};

export type AgentDialog = {
    readonly isOpen: boolean;
    close(): void;
    // Replace the content from fresh state; a no-op after close.
    update(next: AgentDialogOptions): void;
    // Repaint ONLY the activity state on the existing tabs. Used for live event
    // frames: rebuilding the whole dialog for every `start`/`done` would throw away
    // the caret and collapse open details mid-interaction.
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

// One agent's local edits. Every field is "untouched" when absent, which is what
// lets a refresh follow the server for agents the reader never edited.
type AgentDraft = {
    // Model id, or '' for the resolved default (clear the override).
    model?: string;
    // Instruction text, or '' to revert to the trusted preset instruction.
    instruction?: string;
    // Explicit membership: true adds the agent, false removes it.
    member?: boolean;
};

// The dialog's local layer, owned by `openAgentDialog` and read by every paint.
// `paint` is assigned once the modal handle exists, so the body's own handlers
// (tab click/arrow, add picker, membership, apply) can rebuild in place.
type DialogState = {
    drafts: Map<string, AgentDraft>;
    selected: string;
    // The agent armed as the next primary by `Make primary`. Cleared when that agent
    // leaves the roster, when the promotion is re-armed onto another agent, on a
    // successful save and on dismissal.
    promote?: string;
    // Is the `[+]` picker open? Local view state only: opening it sends nothing and
    // adds nobody.
    adding: boolean;
    applying: boolean;
    // Outcome of the last apply attempt; undefined while nothing was attempted or
    // after any further edit (a stale verdict must not describe new work).
    result?: { applied: boolean; message: string };
    // The live body, so a keystroke can re-sync the action and a frame can paint
    // activity WITHOUT a rebuild.
    root: HTMLElement;
    paint(focusKey?: string): void;
};

// Same neutral fallback as ui/agent-control.ts and ui/agents.ts `displayTitleOf`.
const titleOf = (agents: readonly AgentDescriptor[], name: string): string => {
    const found = agents.find((agent) => agent.name === name);
    const title = found?.title.trim() ?? '';

    return title.length > 0 ? title : 'Agent';
};

// The modal header names the agent being configured, because that is what the tab
// strip — and therefore the whole dialog — is about.
const dialogTitle = (options: AgentDialogOptions, state: DialogState): string =>
    `Agents · ${titleOf(options.agents, state.selected)}`;

// The roster: the agents with a badge. Saved members first, in the exact order the
// server reports them (a saved conversation can name an agent the catalogue no longer
// advertises, so members come from `options.members`, never from the library), then
// the drafted additions in the order they were added — and only while the catalogue
// still advertises them, because an agent the server stopped offering cannot be
// joined (and `[+]` would not offer it again). A drafted removal drops the badge now,
// because the list on screen is the list a save would produce.
const rosterOf = (options: AgentDialogOptions, state: DialogState): string[] => {
    const roster: string[] = [];

    for (const name of options.members) {
        if (state.drafts.get(name)?.member === false) continue;
        if (!roster.includes(name)) roster.push(name);
    }

    for (const [name, draft] of state.drafts) {
        if (draft.member !== true) continue;
        if (options.members.includes(name)) continue;
        if (!options.agents.some((agent) => agent.name === name)) continue;
        if (!roster.includes(name)) roster.push(name);
    }

    return roster;
};

// Is this agent on the roster the save would produce? A drafted removal takes a member
// off it, and cancelling a drafted addition takes the added agent off it again — in
// both cases the agent has no team entry to hold a model or instruction key, so its
// edits must not be part of the request (the server validates every map key against
// the FINAL member set).
const onRoster = (options: AgentDialogOptions, state: DialogState, name: string): boolean =>
    rosterOf(options, state).includes(name);

// Who the `[+]` picker offers: every trusted catalogue agent WITHOUT a tab. Current
// members and already-drafted additions never appear twice, and a drafted removal is
// offered again (picking it cancels the removal).
const addableOf = (options: AgentDialogOptions, state: DialogState): string[] => {
    const roster = rosterOf(options, state);

    return options.agents.map((agent) => agent.name).filter((name) => !roster.includes(name));
};

// Is this agent on the roster only because of a draft? Its tab and its edits are not
// saved yet, so the panel must not describe it as if it were.
const isDraftedAddition = (options: AgentDialogOptions, state: DialogState, name: string): boolean =>
    !options.members.includes(name) && state.drafts.get(name)?.member === true;

// Does this agent currently carry a STORED override (as opposed to a draft one)?
const hasStoredOverride = (options: AgentDialogOptions, name: string): boolean =>
    (options.instructions[name] ?? '').trim().length > 0;

// The instruction the textarea starts from: the saved override when this harness has
// one, otherwise the trusted preset text. An absent override is therefore NOT an
// empty box — the reader edits the words the agent actually runs.
const baselineInstructionOf = (options: AgentDialogOptions, name: string): string => {
    const override = (options.instructions[name] ?? '').trim();

    return override.length > 0 ? override : agentDetailsOf(options.agents, name).instruction;
};

// The promotion this dialog's action represents: the agent armed by `Make primary`,
// and only while the team is editable. `undefined` means "no promotion" — the tab
// selection itself never promotes (R3).
const promotionOf = (options: AgentDialogOptions, state: DialogState): string | undefined =>
    options.editable ? state.promote : undefined;

// Is there anything worth sending? Computed from the DELTA the action would actually
// produce (plus an armed promotion), so "pending" can never disagree with the request:
// a cancelled add or a re-cleared promotion leaves an empty delta and a DISABLED
// action, and a disabled button can never falsely claim a save.
const changesPending = (options: AgentDialogOptions, state: DialogState): boolean => {
    if (promotionOf(options, state) !== undefined) return true;

    const changes = changesOf(options, state);

    return (
        Object.keys(changes.models).length > 0 ||
        Object.keys(changes.instructions).length > 0 ||
        changes.add.length > 0 ||
        changes.remove.length > 0
    );
};

// Build the request the action represents: only the deltas the reader made. A drafted
// removal carries no model/instruction delta (the server validates map keys against
// the FINAL member set, so a leaving agent's edit would be a 400), and a promoted
// agent is never listed as removed.
const changesOf = (options: AgentDialogOptions, state: DialogState): AgentConfigurationApply => {
    const models: Record<string, string> = {};
    const instructions: Record<string, string> = {};
    const add: string[] = [];
    const remove: string[] = [];

    const primary = promotionOf(options, state);

    for (const [name, draft] of state.drafts) {
        // Only a rostered agent can carry a model or instruction key.
        if (onRoster(options, state, name)) {
            if (draft.model !== undefined) models[name] = draft.model;
            if (draft.instruction !== undefined) instructions[name] = draft.instruction;
        }

        if (draft.member === true && !options.members.includes(name)) add.push(name);
        if (draft.member === false && options.members.includes(name) && name !== primary) {
            remove.push(name);
        }
    }

    // A promoted agent is a member by definition, so `[+]`-adding it is implied and
    // recorded exactly once.
    if (primary !== undefined && !options.members.includes(primary) && !add.includes(primary)) {
        add.push(primary);
    }

    const changes: AgentConfigurationApply = {
        agent: state.selected,
        models,
        instructions,
        add,
        remove
    };

    if (primary !== undefined) changes.primary = primary;

    return changes;
};

// The draft accessor: edits are local, and any edit clears the last apply verdict so
// a stale "saved"/"failed" line cannot describe work in progress.
const editDraft = (
    state: DialogState,
    name: string,
    edit: (draft: AgentDraft) => void
): void => {
    const draft = state.drafts.get(name) ?? {};
    edit(draft);
    state.drafts.set(name, draft);
    state.result = undefined;
};

// The single line that states what this dialog can do right now. R3: it is the ONLY
// explanation of a lock — the paragraph above the editors is gone, and a locked
// control carries its own reason.
const footerNoteOf = (options: AgentDialogOptions, state: DialogState): string => {
    if (!options.editable) {
        return options.models.editable
            ? 'Models only here · this conversation keeps the team and instructions it started with.'
            : 'Nothing can be changed in this conversation right now.';
    }

    const promoted = promotionOf(options, state);

    if (promoted !== undefined) {
        return `Saves this harness and makes ${titleOf(options.agents, promoted)} the primary.`;
    }

    return 'Saves on this harness · new sessions run what you save here.';
};

// Re-arm the action after a draft edit WITHOUT rebuilding the body: a rebuild on
// every keystroke would drop the caret.
const syncAction = (options: AgentDialogOptions, state: DialogState): void => {
    const apply = state.root.querySelector<HTMLButtonElement>('.agent-dialog-apply');
    if (apply === null) return;

    const pending = changesPending(options, state);
    const promoted = promotionOf(options, state);

    apply.disabled = state.applying || !pending;
    apply.title = state.applying
        ? 'Saving…'
        : pending
          ? 'Save this configuration' +
            (promoted === undefined ? '' : ` and make ${titleOf(options.agents, promoted)} the primary`) +
            '. Closing the dialog saves nothing.'
          : 'Nothing has changed yet.';
};

// Focus the tab the reader is on: after a rebuild the old node is gone, and a
// keyboard user must not be thrown back to the start of the strip. With no name to
// match, the ACTIVE tab is the control that re-orients the form (the role the old
// dropdown had), and the first tab covers the case of an empty selection.
const focusTab = (root: HTMLElement, name = ''): void => {
    const tabs = Array.from(root.querySelectorAll<HTMLElement>('.agent-dialog-tab'));
    const tab =
        tabs.find((element) => element.dataset.agent === name) ??
        root.querySelector<HTMLElement>('.agent-dialog-tab[aria-selected="true"]') ??
        tabs[0];

    tab?.focus();
};

// The `[+]` control and its accessible reason. Disabled rather than hidden when the
// team is locked, so the affordance does not vanish on a saved conversation and the
// tooltip states the real cause (`hint` from main.ts, never invented).
const createAddControl = (options: AgentDialogOptions, state: DialogState): HTMLElement => {
    const addable = addableOf(options, state);
    const add = el('button', 'agent-dialog-add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add an agent to the team');
    add.setAttribute('aria-haspopup', 'true');
    add.setAttribute('aria-expanded', state.adding ? 'true' : 'false');

    if (!options.editable) {
        add.disabled = true;
        add.title = options.hint ?? 'The agent team is locked here.';
        add.setAttribute('aria-describedby', 'agent-dialog-footer-note');
        return add;
    }

    if (addable.length === 0) {
        add.disabled = true;
        add.title = 'Every agent the server offers is already on this team.';
        return add;
    }

    add.title = 'Add an agent to the team.';
    add.addEventListener('click', () => {
        state.adding = !state.adding;
        state.paint(state.adding ? 'add-first' : 'add');
    });

    return add;
};

// The picker: the agents WITHOUT a tab, one button each. Picking one only DRAFTS the
// membership and moves the view to it — nothing is sent until the action.
const createAddPicker = (options: AgentDialogOptions, state: DialogState): HTMLElement | undefined => {
    if (!state.adding) return undefined;

    const list = el('div', 'agent-dialog-add-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Agents to add');

    for (const name of addableOf(options, state)) {
        const label = displayTitleOf(agentDetailsOf(options.agents, name));
        const option = el('button', 'agent-dialog-add-option', label);
        option.type = 'button';
        option.dataset.agent = name;
        option.title = `Add ${label} to the team and configure it.`;
        option.addEventListener('click', () => {
            editDraft(state, name, (draft) => {
                draft.member = true;
            });
            // The new tab is the configuration the reader is here to fill in.
            state.selected = name;
            state.adding = false;
            state.paint(`tab:${name}`);
        });

        list.append(option);
    }

    return list;
};

// The two explicit membership controls inside the selected agent's panel. R3: the
// tab strip selects WHAT you view; these change WHO is on the team, and each one
// states its effect instead of leaving a disabled control unexplained.
const createMembershipActions = (
    options: AgentDialogOptions,
    state: DialogState,
    name: string,
    label: string,
    isPrimary: boolean,
    isMember: boolean
): HTMLElement => {
    const row = el('div', 'agent-dialog-membership');

    const promote = el('button', 'agent-dialog-action agent-dialog-promote');
    promote.type = 'button';
    promote.dataset.action = 'promote';
    promote.dataset.agent = name;

    const armed = promotionOf(options, state) === name;
    const promotable = options.editable && !isPrimary;

    // A toggle keeps ONE name and changes state: screen readers announce
    // "Make primary, pressed", the accent paints the same fact, and the action's label
    // (`Save & set primary`) states what the press will write.
    promote.textContent = 'Make primary';
    promote.disabled = !promotable;
    // `aria-pressed` is the honest state of a toggle, so the pending promotion is
    // visible without a sentence about it.
    promote.setAttribute('aria-pressed', armed ? 'true' : 'false');
    promote.title = !options.editable
        ? (options.hint ?? 'The agent team is locked here.')
        : isPrimary
          ? 'The primary agent is already the primary.'
          : armed
            ? `Cancel the promotion, so ${label} stays a team member without leading the team.`
            : `Make ${label} the primary agent when you save.`;
    promote.addEventListener('click', () => {
        state.promote = armed ? undefined : name;
        state.result = undefined;
        state.paint('action:promote');
    });

    const remove = el('button', 'agent-dialog-action agent-dialog-remove');
    remove.type = 'button';
    remove.dataset.action = 'remove';
    remove.dataset.agent = name;
    remove.textContent = 'Remove from team';

    // The primary always stays, so its control is disabled WITH the reason instead of
    // silently missing. For a drafted addition the label is the same and the effect
    // cancels the add.
    remove.disabled = !options.editable || isPrimary;
    remove.title = !options.editable
        ? (options.hint ?? 'The agent team is locked here.')
        : isPrimary
          ? 'The primary agent is always part of the team.'
          : isMember
            ? `Take ${label} off the team when you save.`
            : `Cancel the add, so ${label} never joins this team.`;
    remove.addEventListener('click', () => {
        editDraft(state, name, (draft) => {
            draft.member = false;
        });

        // The agent no longer has a tab, so the view moves to a rostered agent rather
        // than configuring an agent the save would drop.
        if (state.promote === name) state.promote = undefined;
        state.selected = options.primary;
        state.paint('roster');
    });

    row.append(promote, remove);

    return row;
};

// The full body, built off-document so the module stays testable without the app
// shell. `state` is the local draft layer: a paint reads it and never writes the
// server.
const buildContent = (options: AgentDialogOptions, state: DialogState): HTMLElement => {
    const root = el('div', 'agent-dialog');

    const roster = rosterOf(options, state);

    // A drafted removal (or a server refresh) can leave the viewed agent with no tab.
    // Fall back to the primary, then to whatever the roster does hold.
    const selected = roster.includes(state.selected)
        ? state.selected
        : (roster.includes(options.primary) ? options.primary : (roster[0] ?? options.primary));
    state.selected = selected;

    if (state.promote !== undefined && !roster.includes(state.promote)) state.promote = undefined;

    const descriptor = agentDetailsOf(options.agents, selected);
    const label = displayTitleOf(descriptor);
    const isMember = options.members.includes(selected);
    const isPrimary = selected === options.primary;
    const isAdded = isDraftedAddition(options, state, selected);
    const draft = state.drafts.get(selected) ?? {};

    // --- the team tabs (the only listing) ----------------------------------
    const chooser = el('section', 'agent-dialog-section agent-dialog-chooser');

    const tabs = el('div', 'agent-dialog-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Agent team');
    tabs.setAttribute('aria-orientation', 'horizontal');

    const addable = addableOf(options, state);
    // The live set, seeded onto every tab so a rebuild cannot drop a working agent's
    // ring (later frames go through `paintActivity`, which never rebuilds).
    const activity = new Set(options.activity ?? []);

    for (const member of roster) {
        const title = displayTitleOf(agentDetailsOf(options.agents, member));
        const active = member === selected;

        const tab = el('button', 'agent-dialog-tab agent-dialog-agent');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.id = `agent-dialog-tab-${member}`;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('aria-controls', 'agent-dialog-config');
        // Roving tabindex: one tab stop for the whole strip, arrows move inside it.
        tab.tabIndex = active ? 0 : -1;
        // `data-agent`/`data-role` are the same team facts the deck and the old rows
        // exposed, so a test/inspector reads the roster the same way from any host,
        // and ui/activity.ts keeps painting these nodes.
        tab.dataset.agent = member;
        tab.dataset.role = member === options.primary ? 'primary' : 'secondary';
        if (isDraftedAddition(options, state, member)) tab.dataset.added = 'true';
        tab.setAttribute('aria-label', `Configure ${title} · ${member === options.primary ? 'primary agent' : 'subagent'}`);
        tab.title = `View and edit ${title}’s model and instruction.`;

        // `data-activity`/`aria-busy` are what ui/activity.ts `paintActivity` writes on
        // the next frame; seeding them here keeps a rebuild truthful for EVERY member,
        // not only the viewed one.
        if (activity.has(member)) {
            tab.dataset.activity = 'active';
            tab.setAttribute('aria-busy', 'true');
        }

        // The model line reads the same map the select is built from, so the strip and
        // the editor can never disagree.
        const model = options.models.models[member] ?? (options.models.fallbackModel?.trim() ?? '');

        tab.append(
            el('span', 'agent-dialog-agent-name', title),
            el('span', 'agent-dialog-agent-role', member === options.primary ? 'primary' : 'subagent'),
            el('span', 'agent-dialog-agent-model', model.length > 0 ? model : UNKNOWN_MODEL_LABEL)
        );

        // A drafted addition has no saved team entry yet, so its tab says so.
        if (isDraftedAddition(options, state, member)) {
            tab.append(el('span', 'agent-dialog-agent-state', 'new'));
        }

        tab.addEventListener('click', () => {
            // A tab switch is a VIEW change: nothing is sent and nobody is promoted.
            if (state.selected === member) return;
            state.selected = member;
            state.result = undefined;
            state.adding = false;
            state.paint(`tab:${member}`);
        });

        tabs.append(tab);
    }

    // Arrow keys move the selection inside the strip (automatic activation: switching
    // a view has no side effect, so there is nothing to confirm with Enter).
    tabs.addEventListener('keydown', (event: Event) => {
        const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
        const keyboard = event as KeyboardEvent;
        if (!keys.includes(keyboard.key)) return;

        const nodes = Array.from(tabs.querySelectorAll<HTMLElement>('.agent-dialog-tab'));
        if (nodes.length === 0) return;

        const at = nodes.findIndex((node) => node.dataset.agent === state.selected);
        const next =
            keyboard.key === 'Home'
                ? 0
                : keyboard.key === 'End'
                  ? nodes.length - 1
                  : keyboard.key === 'ArrowRight'
                    ? (Math.max(at, 0) + 1) % nodes.length
                    : (Math.max(at, 0) - 1 + nodes.length) % nodes.length;

        const moved = nodes[next]?.dataset.agent ?? '';
        if (moved === '' || moved === state.selected) return;

        keyboard.preventDefault();
        state.selected = moved;
        state.result = undefined;
        state.adding = false;
        state.paint(`tab:${moved}`);
    });

    chooser.append(tabs, createAddControl(options, state));

    if (state.adding && options.editable && addable.length > 0) {
        const picker = createAddPicker(options, state);
        if (picker !== undefined) chooser.append(picker);
    }

    root.append(chooser);

    // --- the selected agent's configuration --------------------------------
    const config = el('section', 'agent-dialog-section agent-dialog-config');
    config.id = 'agent-dialog-config';
    config.setAttribute('role', 'tabpanel');
    config.setAttribute('aria-labelledby', `agent-dialog-tab-${selected}`);
    config.dataset.agent = selected;

    // Model -----------------------------------------------------------------
    config.append(el('p', 'agent-dialog-label', 'Model'));

    // `createAgentModelSelect` owns the option rules (resolved default first, the
    // catalogue alphabetically, a stale id sorted in). The dialog replaces its PATCH
    // callback with a DRAFT write — that substitution is the entire transactional
    // difference from the old always-writing row.
    const models: AgentModelSelect = {
        ...options.models,
        models: {
            ...options.models.models,
            ...(draft.model === undefined ? {} : { [selected]: draft.model })
        },
        onChange: (name: string, model: string) => {
            editDraft(state, name, (entry) => {
                entry.model = model;
            });
            syncAction(options, state);
        }
    };

    config.append(createAgentModelSelect(selected, label, models));

    // Instruction -----------------------------------------------------------
    const instructionLocked = !options.editable;

    config.append(el('p', 'agent-dialog-label', 'Instruction'));

    const instruction = el('textarea', 'agent-dialog-instruction field-input');
    instruction.setAttribute('aria-label', `Instruction for ${label}`);
    instruction.rows = 8;
    instruction.spellcheck = false;
    instruction.value =
        draft.instruction === undefined ? baselineInstructionOf(options, selected) : draft.instruction;
    // A locked instruction is shown as disabled text, never as an editable box whose
    // typing would be silently thrown away. The reason lives on the control (R3: no
    // explanation paragraph), and the text stays readable.
    instruction.disabled = instructionLocked;
    // R3: the reason lives ON the control (no explanation paragraph). The instruction
    // gets its own sentence rather than the generic team hint, because it names the
    // actual cause for THIS field and says where the edit does work.
    instruction.title = instructionLocked
        ? 'A saved conversation runs the instructions it was created with. Edit them on the harness to use them in a new session.'
        : hasStoredOverride(options, selected)
          ? 'This harness overrides the preset instruction. Clear the text to run the preset instruction again.'
          : 'Saved on this harness and used by new sessions. The trusted preset instruction itself is never changed.';

    // Typing only updates the draft and re-arms the action: a full repaint here would
    // move the caret and interrupt the reader.
    instruction.addEventListener('input', () => {
        editDraft(state, selected, (entry) => {
            entry.instruction = instruction.value;
        });
        syncAction(options, state);
    });

    config.append(instruction);

    // Reverting a saved override is an explicit affordance, not a hidden gesture.
    if (!instructionLocked && hasStoredOverride(options, selected)) {
        const revert = el('button', 'agent-dialog-revert', 'Use the preset instruction');
        revert.type = 'button';
        revert.title = `Clear this harness’s override so ${label} runs its trusted preset instruction again.`;
        revert.addEventListener('click', () => {
            editDraft(state, selected, (entry) => {
                entry.instruction = '';
            });
            state.paint('revert');
        });

        config.append(revert);
    }

    // Trusted reference -----------------------------------------------------
    // What the server actually ships for this agent, so an override can be compared
    // with the preset it replaces. Same builder the preset picker uses.
    config.append(createAgentPresetDetail(descriptor, `Preset instruction for ${label}`));

    // Membership ------------------------------------------------------------
    // R3: no checkbox and no prose. `[+]` adds, this row removes, and a promotion is
    // armed explicitly. Conservative by construction: viewing a tab never changes the
    // team, and the primary can never be removed.
    config.append(createMembershipActions(options, state, selected, label, isPrimary, isMember));

    // An added agent is not on the team until the action runs, so the panel says so
    // rather than reading as saved state.
    if (isAdded) {
        config.append(
            el('p', 'agent-dialog-field-note', `${label} joins the team when you save · nothing is sent yet.`)
        );
    }

    root.append(config);

    // --- the footer: verdict + the one action (bottom right) ----------------
    const footer = el('div', 'agent-dialog-footer');

    const note = el('p', 'agent-dialog-footer-note', '');
    note.id = 'agent-dialog-footer-note';
    note.textContent =
        state.result === undefined ? footerNoteOf(options, state) : state.result.message;

    // A failed save gets its own status line (role=status), so the reader who pressed
    // the action hears the refusal even though the dialog stayed open.
    const error = el('p', 'agent-dialog-error', '');
    error.setAttribute('role', 'status');

    if (state.result !== undefined && !state.result.applied) {
        error.textContent = state.result.message;
        note.textContent = footerNoteOf(options, state);
    }

    const apply = el('button', 'agent-dialog-apply button primary');
    apply.type = 'button';
    apply.dataset.agent = selected;
    apply.textContent = promotionOf(options, state) === undefined ? 'Save configuration' : 'Save & set primary';
    apply.disabled = state.applying || !changesPending(options, state);
    apply.title = state.applying
        ? 'Saving…'
        : changesPending(options, state)
          ? 'Save this configuration' +
            (promotionOf(options, state) === undefined
                ? ''
                : ` and make ${titleOf(options.agents, promotionOf(options, state) as string)} the primary`) +
            '. Closing the dialog saves nothing.'
          : 'Nothing has changed yet.';

    apply.addEventListener('click', () => {
        void submit(options, state);
    });

    footer.append(note, error, apply);
    root.append(footer);

    // Every handler above closes over `state`, and the shared helpers (syncAction,
    // paintActivity) query the LIVE body — so the root just built is the state's
    // root from here on. Assigning it inside the builder is what keeps the initial
    // open (which has no modal handle yet) and every later repaint identical.
    state.root = root;

    return root;
};

// The single write path. Kept here (not in the JSX closure) so the apply/reject
// rules are readable in one place.
const submit = async (options: AgentDialogOptions, state: DialogState): Promise<void> => {
    // A second press while one PATCH is in flight is ignored, not queued: the first
    // request already carries every current draft.
    if (state.applying) return;

    const changes = changesOf(options, state);

    state.applying = true;
    state.result = undefined;

    // The busy state is painted by mutating the live action, NOT by rebuilding: a
    // rebuild would replace the button the reader just pressed and drop the focus.
    const busy = state.root.querySelector<HTMLButtonElement>('.agent-dialog-apply');
    if (busy !== null) {
        busy.disabled = true;
        busy.title = 'Saving…';
        busy.setAttribute('aria-busy', 'true');
    }

    try {
        const result = await options.onApply(changes);

        state.applying = false;

        if (result.applied) {
            // Confirmed: the drafts fold into the baseline main.ts delivers through
            // `update()`, so clearing them here leaves the truthful text on screen.
            state.drafts.clear();
            state.promote = undefined;
            state.adding = false;
            state.result = { applied: true, message: result.message ?? 'Saved.' };
        } else {
            // Refused or dropped: keep EVERY draft, stay open, and say why.
            state.result = {
                applied: false,
                message: result.message ?? 'The change was not saved. Your edits are still here.'
            };
        }
    } catch (error: unknown) {
        state.applying = false;
        state.result = {
            applied: false,
            message:
                error instanceof Error && error.message.trim().length > 0
                    ? error.message
                    : 'The change was not saved. Your edits are still here.'
        };
    }

    state.paint('apply');
};

// A stable description of the focused control, so a content rebuild can put focus
// back on the SAME logical control. Values are agent ids / aria-labels, not DOM
// references: the old nodes are discarded when the body is replaced.
const focusKeyOf = (root: HTMLElement): string | undefined => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined;

    const tab = active.closest<HTMLElement>('.agent-dialog-tab');
    if (tab !== null) return `tab:${tab.dataset.agent ?? ''}`;

    if (active.classList.contains('agent-dialog-add')) return 'add';

    const option = active.closest<HTMLElement>('.agent-dialog-add-option');
    if (option !== null) return `add:${option.dataset.agent ?? ''}`;

    const action = active.closest<HTMLElement>('.agent-dialog-action');
    if (action !== null) return `action:${action.dataset.action ?? ''}`;

    const instruction = active.closest<HTMLTextAreaElement>('.agent-dialog-instruction');
    if (instruction !== null) {
        // The caret travels with the key, so a rebuild cannot restart the reader at
        // the beginning of a long instruction.
        return `instruction:${instruction.getAttribute('aria-label') ?? ''}:${
            instruction.selectionStart ?? 0
        }`;
    }

    if (active.classList.contains('agent-dialog-revert')) return 'revert';

    const apply = active.closest<HTMLButtonElement>('.agent-dialog-apply');
    if (apply !== null) return `apply:${apply.dataset.agent ?? ''}`;

    const model = active.closest<HTMLSelectElement>('.agent-model-select');
    if (model !== null) return `model:${model.getAttribute('aria-label') ?? ''}`;

    const summary = active.closest<HTMLElement>('summary');
    if (summary !== null && summary.parentElement?.classList.contains('agent-detail')) return 'preset';

    return undefined;
};

// Find the equivalent control in the rebuilt body and focus it. A control that is
// missing or disabled is NOT focused (a model select can become disabled while a run
// starts, and claiming it would be a lie); the reader is then handed the active tab,
// which is the control that re-orients the whole form. The rule exists so a rebuild
// can never drop focus onto <body> while the dialog is open — the case that happens
// after a successful save, when the action becomes disabled again.
const targetOf = (root: HTMLElement, key: string): HTMLElement | null => {
    if (key === 'add' || key === 'add-first') {
        return root.querySelector<HTMLElement>('.agent-dialog-add');
    }

    if (key === 'revert') return root.querySelector<HTMLButtonElement>('.agent-dialog-revert');
    if (key === 'preset') return root.querySelector<HTMLElement>('.agent-detail summary');
    if (key === 'roster') return root.querySelector<HTMLElement>('.agent-dialog-tab[aria-selected="true"]');

    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const rest = key.slice(separator + 1);

    if (kind === 'action') {
        return root.querySelector<HTMLElement>(`.agent-dialog-action[data-action="${rest}"]`);
    }

    if (kind === 'tab') {
        return (
            Array.from(root.querySelectorAll<HTMLElement>('.agent-dialog-tab')).find(
                (element) => element.dataset.agent === rest
            ) ?? null
        );
    }

    if (kind === 'add') {
        const option = Array.from(root.querySelectorAll<HTMLElement>('.agent-dialog-add-option')).find(
            (element) => element.dataset.agent === rest
        );

        // The picker closes as the add is drafted, so the new tab is the control that
        // keeps the reader's place.
        return option ?? root.querySelector<HTMLElement>(`.agent-dialog-tab[data-agent="${rest}"]`);
    }

    if (kind === 'instruction') {
        // `instruction:<aria-label>:<caret>` — split on the LAST colon so an
        // aria-label containing a colon still resolves.
        const cut = rest.lastIndexOf(':');
        const name = cut < 0 ? rest : rest.slice(0, cut);

        return (
            Array.from(root.querySelectorAll<HTMLTextAreaElement>('.agent-dialog-instruction')).find(
                (element) => element.getAttribute('aria-label') === name
            ) ?? null
        );
    }

    if (kind === 'model') {
        return (
            Array.from(root.querySelectorAll<HTMLElement>('.agent-model-select')).find(
                (element) => element.getAttribute('aria-label') === rest
            ) ?? null
        );
    }

    if (kind === 'apply') {
        return (
            Array.from(root.querySelectorAll<HTMLElement>('.agent-dialog-apply')).find(
                (element) => element.dataset.agent === rest
            ) ?? null
        );
    }

    return null;
};

const focusByKey = (root: HTMLElement, key: string): void => {
    // The picker's first option is where `[+]` focus goes when the list opens.
    if (key === 'add-first') {
        root.querySelector<HTMLElement>('.agent-dialog-add-option')?.focus();
        return;
    }

    const target = targetOf(root, key);

    if (target !== null && !(target as HTMLButtonElement | HTMLSelectElement).disabled) {
        target.focus();

        // The caret is part of the instruction control's identity: a rebuild must not
        // restart the reader at the beginning of a long prompt.
        if (target instanceof HTMLTextAreaElement) {
            const cut = key.lastIndexOf(':');
            const caret = Number(cut < 0 ? '' : key.slice(cut + 1));
            if (Number.isFinite(caret)) target.setSelectionRange(caret, caret);
        }

        return;
    }

    focusTab(root, '');
};

// Open one agent dialog. main.ts keeps the returned handle, updates it on chrome
// rebuilds (`update`) and closes it on a lifecycle change (`close`).
export const openAgentDialog = (initial: AgentDialogOptions): AgentDialog => {
    // The live options: `update()` replaces them, and the body's own handlers always
    // read the newest server state.
    let options = initial;

    const state: DialogState = {
        drafts: new Map<string, AgentDraft>(),
        // The primary is the agent the reader is most likely here to look at.
        selected: initial.primary,
        promote: undefined,
        adding: false,
        applying: false,
        // Replaced by the first paint below.
        root: el('div', 'agent-dialog'),
        paint: () => undefined
    };

    let open = true;
    let handle: DialogHandle | undefined;

    // The lifecycle callback is OPEN-time wiring: `update()` replaces the paint
    // options (members/primary/models/instructions/onApply) with a fresh object from
    // main.ts that carries no `onClose`, so the dismissal handler must be captured
    // here or a refresh while the dialog is open would silently drop the host's
    // handle-clearing and focus-return logic.
    const onClose = initial.onClose;

    // Rebuild the body in place. `focusKey` overrides the derived key only for a
    // handler that knows which control it belongs to; otherwise the live focus is
    // captured first, so an update never drops the reader on the close button.
    const paint = (focusKey?: string): void => {
        const key = focusKey ?? focusKeyOf(state.root);
        const content = buildContent(options, state);

        if (handle === undefined) return;
        handle.update({ title: dialogTitle(options, state), content });
        if (key !== undefined) focusByKey(content, key);
    };

    state.paint = paint;

    // `buildContent` seeds `state.root`, so activity and the action re-sync work from
    // the very first paint.
    const content = buildContent(options, state);

    handle = openDialog({
        title: dialogTitle(options, state),
        content,
        onClose: () => {
            open = false;
            // Dismissal discards every draft: nothing was ever sent, so there is
            // nothing to roll back.
            state.drafts.clear();
            state.promote = undefined;
            state.adding = false;
            state.applying = false;
            state.result = undefined;
            onClose?.();
        }
    });

    return {
        get isOpen(): boolean {
            return open;
        },
        close(): void {
            if (!open) return;
            open = false;
            handle?.close();
        },
        update(next: AgentDialogOptions): void {
            if (!open) return;

            options = next;

            // The selected agent may have left the roster or the catalogue. Fall back
            // to the primary rather than configuring an agent the server can no
            // longer reach.
            if (!rosterOf(next, state).includes(state.selected)) state.selected = next.primary;
            if (state.promote !== undefined && !rosterOf(next, state).includes(state.promote)) {
                state.promote = undefined;
            }

            // An open picker with nothing left to add would render an empty group.
            if (state.adding && addableOf(next, state).length === 0) state.adding = false;

            paint();
        },
        paintActivity(active: ReadonlySet<string>): void {
            if (!open) return;
            paintAgentActivity(state.root, active);
        }
    };
};

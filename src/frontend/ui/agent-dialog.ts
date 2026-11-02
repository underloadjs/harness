// The agent configuration dialog (T3: one dropdown, editable configuration).
//
// PRODUCT RULE
// ------------
// ONE dropdown lists EVERY agent the server advertises plus every current team
// member. Selecting an entry shows THAT agent's configuration: its instruction
// (editable), its model (editable), its trusted preset instruction (read-only
// reference) and its team membership. The bottom-right action is the only thing
// that writes to the server: it saves the configuration and, where the conversation
// supports it, makes the selected agent the primary.
//
// X / backdrop / Escape / a programmatic `close()` therefore discard everything by
// construction — nothing was ever sent. That is the whole purpose of the draft
// layer below: selection and editing are LOCAL until the explicit action.
//
// DRAFTS
// ------
// `state.drafts` is a per-agent map of what the reader actually changed and
// `state.selected` is the dropdown's agent. Both live in this closure, so:
//   - a live refresh (`update()` from a chrome rebuild) repaints from the newest
//     server answer WITHOUT clobbering a touched field: an untouched agent follows
//     the server, a touched one keeps its draft;
//   - switching agents in the dropdown keeps every other agent's draft, so
//     configuring three agents and then saving writes all three at once;
//   - dismissal drops them (the next open starts from the server's truth).
//
// The baseline maps (`options.models.models`, `options.instructions`) are the
// server's answer, so an editor always opens on the TRUTH, and the diff against it
// is what `changesOf()` reports to `onApply`. An explicit '' in a draft means
// "clear the override" (use the resolved default model / the trusted preset
// instruction), which is how a saved override is reverted.
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
// a session being created). It gates the promotion half of the action, the
// membership control and the instruction editor, and `hint` states the real reason.
// Models keep their own flag inside `models` (a saved session edits its live model
// map), so the dialog offers model editing exactly where the server does, and the
// footer says in words what a Save can actually do here.
//
// LIVE ACTIVITY WITHOUT LOSING FOCUS
// ----------------------------------
// `update(next)` rebuilds the body in place and restores focus to the SAME logical
// control (dropdown, instruction textarea including its caret, model select,
// membership checkbox, action button). Activity frames go through `paintActivity()`
// instead, which only touches the team rows' ring attributes — it never rebuilds, so
// typing is never interrupted mid-frame.
//
// The modal itself is ui/dialog.ts: Escape/backdrop/close-button, focus trapping and
// focus restoration live there. `onClose` lets main.ts forget its handle.
//
// Cross-references:
//   - src/frontend/main.ts             open/refresh/close lifecycle + onApply PATCH
//   - src/frontend/ui/agent-control.ts the composer button that opens this dialog
//   - src/frontend/ui/agents.ts        createAgentModelSelect/createAgentPresetDetail
//   - src/frontend/ui/activity.ts      paintActivity (the dialog's team rows)
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
export type AgentConfigurationApply = {
    // The agent the reader was configuring (the dropdown selection).
    agent: string;
    // Present ONLY when the action also promotes: the agent to make primary.
    primary?: string;
    // Model choices the reader touched: agent id → model id, or '' for "use the
    // resolved default" (delete the override).
    models: Record<string, string>;
    // Instruction choices the reader touched: agent id → text, or '' for "revert to
    // the trusted preset instruction".
    instructions: Record<string, string>;
    // Explicit membership changes from the checkbox. `add` never removes anyone, and
    // a promoted agent is never in `remove`.
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
    // The real reason the team/instructions are locked. Shown as a note; never
    // invented.
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
    // Repaint ONLY the activity state on the existing team rows. Used for live event
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

const isDraftEmpty = (draft: AgentDraft): boolean =>
    draft.model === undefined && draft.instruction === undefined && draft.member === undefined;

// The dialog's local layer, owned by `openAgentDialog` and read by every paint.
// `paint` is assigned once the modal handle exists, so the body's own handlers
// (dropdown change, membership toggle, apply) can rebuild in place.
type DialogState = {
    drafts: Map<string, AgentDraft>;
    selected: string;
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

// The modal header names the agent being configured, because that is what the
// dropdown — and therefore the whole dialog — is about.
const dialogTitle = (options: AgentDialogOptions, state: DialogState): string =>
    `Agents · ${titleOf(options.agents, state.selected)}`;

// The dropdown's entries: the team first (primary, then secondaries — the exact
// order the server reports), then every catalogue agent that is not a member. A
// saved conversation can name an agent the catalogue no longer advertises, so
// members come from `options.members`, never from the library.
const agentEntriesOf = (options: AgentDialogOptions): string[] => {
    const entries: string[] = [];

    for (const name of [...options.members, ...options.agents.map((agent) => agent.name)]) {
        if (!entries.includes(name)) entries.push(name);
    }

    return entries;
};

// What one entry is labelled. R3 keeps the raw agent id out of visible text; the
// state suffix is the team truth, so the reader sees what selecting an entry implies
// before pressing the action.
const entryLabelOf = (options: AgentDialogOptions, name: string): string => {
    const label = displayTitleOf(agentDetailsOf(options.agents, name));

    if (name === options.primary) return `${label} · primary`;
    if (options.members.includes(name)) return `${label} · team member`;

    return `${label} · not in the team`;
};

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

// The promotion this dialog's action represents: the selected agent, when the team
// is editable and it is not already the primary. `undefined` means "no promotion".
const promotionOf = (options: AgentDialogOptions, state: DialogState): string | undefined =>
    options.editable && state.selected !== options.primary ? state.selected : undefined;

// Is there anything worth sending? A promotion is a change on its own, so selecting
// another agent and pressing the action is never a silent no-op — and while nothing
// is pending the action is DISABLED, so a disabled button can never falsely promote.
const changesPending = (options: AgentDialogOptions, state: DialogState): boolean => {
    if (promotionOf(options, state) !== undefined) return true;

    for (const [, draft] of state.drafts) {
        if (!isDraftEmpty(draft)) return true;
    }

    return false;
};

// Build the request the action represents: only the deltas the reader made, with the
// promotion's membership consequence folded in (choosing an outside agent as primary
// ADDS it, and never removes anyone).
const changesOf = (options: AgentDialogOptions, state: DialogState): AgentConfigurationApply => {
    const models: Record<string, string> = {};
    const instructions: Record<string, string> = {};
    const add: string[] = [];
    const remove: string[] = [];

    const primary = promotionOf(options, state);

    for (const [name, draft] of state.drafts) {
        if (draft.model !== undefined) models[name] = draft.model;
        if (draft.instruction !== undefined) instructions[name] = draft.instruction;

        // A promoted agent is a member by definition: an unchecked box cannot remove
        // it, and a non-member is added exactly once (below).
        if (name === primary) continue;

        if (draft.member === true && !options.members.includes(name)) add.push(name);
        if (draft.member === false && options.members.includes(name)) remove.push(name);
    }

    if (primary !== undefined && !options.members.includes(primary)) add.push(primary);

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

// Re-arm the action after a draft edit WITHOUT rebuilding the body: a rebuild on
// every keystroke would drop the caret.
const syncAction = (options: AgentDialogOptions, state: DialogState): void => {
    const apply = state.root.querySelector<HTMLButtonElement>('.agent-dialog-apply');
    if (apply === null) return;

    const pending = changesPending(options, state);
    const promotes = promotionOf(options, state) !== undefined;

    apply.disabled = state.applying || !pending;
    apply.title = state.applying
        ? 'Saving…'
        : pending
          ? 'Save this configuration' +
            (promotes ? ' and make this agent the primary' : '') +
            '. Closing the dialog saves nothing.'
          : 'Nothing has changed yet.';
};

// What the footer note says while nothing is pending. Every branch names a real
// restriction the server enforces (main.ts derives `editable`/`hint` from it).
const footerNoteOf = (options: AgentDialogOptions, state: DialogState, label: string): string => {
    if (!options.editable) {
        return options.models.editable
            ? `This conversation keeps the team and instructions it was created with. Saving changes only ${label}’s model, from its next request.`
            : 'Nothing can be changed in this conversation right now.';
    }

    return state.selected === options.primary
        ? `Saves ${label} on this harness. New sessions run what you save here.`
        : `Saves ${label}, adds it to the team if needed, and makes it the primary agent. Every current member stays on the team.`;
};

// The full body, built off-document so the module stays testable without the app
// shell. `state` is the local draft layer: a paint reads it and never writes the
// server.
const buildContent = (options: AgentDialogOptions, state: DialogState): HTMLElement => {
    const root = el('div', 'agent-dialog');

    const selected = state.selected;
    const descriptor = agentDetailsOf(options.agents, selected);
    const label = displayTitleOf(descriptor);
    const isMember = options.members.includes(selected);
    const isPrimary = selected === options.primary;
    const draft = state.drafts.get(selected) ?? {};

    // Honest restriction note. Only painted when something really is locked; an
    // unlocked dialog has nothing to explain.
    if (!options.editable) {
        root.append(
            el(
                'p',
                'agent-dialog-note',
                options.hint ??
                    'This conversation keeps the agent team it started with; start a new session to change it.'
            )
        );
    }

    // --- the dropdown ------------------------------------------------------
    const chooser = el('section', 'agent-dialog-section');
    chooser.append(el('p', 'agent-dialog-label', 'Agent'));

    const select = el('select', 'agent-dialog-agent-select field-select');
    select.setAttribute('aria-label', 'Agent to configure');
    select.title = 'Choose an agent to view and edit its configuration.';

    for (const name of agentEntriesOf(options)) {
        const option = el('option', undefined, entryLabelOf(options, name));
        option.value = name;
        select.append(option);
    }

    select.value = selected;

    // Selecting is LOCAL: it changes what is viewed and sends nothing.
    select.addEventListener('change', () => {
        state.selected = select.value;
        state.result = undefined;
        state.paint('select');
    });

    chooser.append(select);
    root.append(chooser);

    // --- the selected agent's configuration --------------------------------
    const config = el('section', 'agent-dialog-section agent-dialog-config');
    config.dataset.agent = selected;

    // One line of team state, so a disabled control below reads as a fact.
    config.append(
        el(
            'p',
            'agent-dialog-state',
            isPrimary
                ? `${label} is the primary agent.`
                : isMember
                  ? `${label} is a team member.`
                  : `${label} is not in this team yet.`
        )
    );

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
    // typing would be silently thrown away.
    instruction.disabled = instructionLocked;
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
    // Conservative and explicit: one checkbox. Adding is what makes a non-member's
    // edits mean anything; removing is opt-IN, so a team is never silently shrunk.
    const membership = el('div', 'agent-dialog-membership');

    const memberToggle = el('input', 'agent-dialog-member');
    memberToggle.type = 'checkbox';
    // A draft wins over the server state, exactly like the other two editors.
    memberToggle.checked = draft.member === undefined ? isMember : draft.member;
    memberToggle.disabled = !options.editable || isPrimary;
    memberToggle.dataset.agent = selected;
    memberToggle.id = `agent-dialog-member-${selected}`;
    memberToggle.title =
        options.editable && !isPrimary
            ? 'Include this agent in the team. Unchecking removes it when you save.'
            : isPrimary
              ? 'The primary agent is always part of the team.'
              : 'The agent team is locked for this conversation.';
    memberToggle.addEventListener('change', () => {
        editDraft(state, selected, (entry) => {
            entry.member = memberToggle.checked;
        });
        state.paint(`member:${selected}`);
    });

    const memberLabel = el('label', 'agent-dialog-member-label', 'In the agent team');
    memberLabel.htmlFor = memberToggle.id;

    membership.append(memberToggle, memberLabel);

    if (isPrimary) {
        membership.append(
            el('p', 'agent-dialog-field-note', 'The primary agent is always part of the team.')
        );
    } else if (!options.editable) {
        membership.append(el('p', 'agent-dialog-field-note', 'The team is locked for this conversation.'));
    } else if (!isMember) {
        membership.append(
            el(
                'p',
                'agent-dialog-field-note',
                'Saving a configuration for an outside agent adds it; no current member is removed.'
            )
        );
    }

    config.append(membership);
    root.append(config);

    // --- the team, with live activity --------------------------------------
    const team = el('section', 'agent-dialog-section agent-dialog-team');
    team.setAttribute('aria-label', 'Agent team');
    team.append(el('p', 'agent-dialog-label', 'Team'));

    const list = el('div', 'agent-dialog-team-list');
    list.setAttribute('role', 'list');

    const active = new Set(options.activity ?? []);

    for (const name of options.members) {
        const row = el('div', 'agent-dialog-agent');
        row.dataset.agent = name;
        // The same role marker the deck used, so a test/inspector reads the team the
        // same way from either host (`data-role` is the primary/secondary fact).
        row.dataset.role = name === options.primary ? 'primary' : 'secondary';
        row.setAttribute('role', 'listitem');

        // `data-activity`/`aria-busy` are what ui/activity.ts `paintActivity` writes
        // on the next frame; seeding them here keeps a rebuild truthful.
        if (active.has(name)) {
            row.dataset.activity = 'active';
            row.setAttribute('aria-busy', 'true');
        }

        // The model line reads the same map the select is built from, so the list and
        // the editor can never disagree.
        const model = options.models.models[name] ?? (options.models.fallbackModel?.trim() ?? '');

        row.append(
            el(
                'span',
                'agent-dialog-agent-name',
                displayTitleOf(agentDetailsOf(options.agents, name))
            ),
            el('span', 'agent-dialog-agent-role', name === options.primary ? 'primary' : 'subagent'),
            el('span', 'agent-dialog-agent-model', model.length > 0 ? model : UNKNOWN_MODEL_LABEL)
        );

        list.append(row);
    }

    team.append(list);
    root.append(team);

    // --- the footer: verdict + the one action (bottom right) ----------------
    const footer = el('div', 'agent-dialog-footer');

    const note = el('p', 'agent-dialog-footer-note', '');
    note.textContent =
        state.result === undefined ? footerNoteOf(options, state, label) : state.result.message;

    // A failed save gets its own status line (role=status), so the reader who pressed
    // the action hears the refusal even though the dialog stayed open.
    const error = el('p', 'agent-dialog-error', '');
    error.setAttribute('role', 'status');

    if (state.result !== undefined && !state.result.applied) {
        error.textContent = state.result.message;
        note.textContent = footerNoteOf(options, state, label);
    }

    const apply = el('button', 'agent-dialog-apply button primary');
    apply.type = 'button';
    apply.dataset.agent = selected;
    apply.textContent =
        options.editable && !isPrimary ? 'Save & set primary' : 'Save configuration';
    apply.disabled = state.applying || !changesPending(options, state);
    apply.title = state.applying
        ? 'Saving…'
        : changesPending(options, state)
          ? 'Save this configuration' +
            (promotionOf(options, state) !== undefined ? ' and make this agent the primary' : '') +
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

    if (active.classList.contains('agent-dialog-agent-select')) return 'select';

    const instruction = active.closest<HTMLTextAreaElement>('.agent-dialog-instruction');
    if (instruction !== null) {
        // The caret travels with the key, so a rebuild cannot restart the reader at
        // the beginning of a long instruction.
        return `instruction:${instruction.getAttribute('aria-label') ?? ''}:${
            instruction.selectionStart ?? 0
        }`;
    }

    if (active.classList.contains('agent-dialog-revert')) return 'revert';

    const member = active.closest<HTMLInputElement>('.agent-dialog-member');
    if (member !== null) return `member:${member.dataset.agent ?? ''}`;

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
// starts, and claiming it would be a lie); the reader is then handed the dropdown,
// which is the control that re-orients the whole form. The rule exists so a rebuild
// can never drop focus onto <body> while the dialog is open — the case that happens
// after a successful save, when the action becomes disabled again.
const targetOf = (root: HTMLElement, key: string): HTMLElement | null => {
    if (key === 'select') return root.querySelector<HTMLSelectElement>('.agent-dialog-agent-select');
    if (key === 'revert') return root.querySelector<HTMLButtonElement>('.agent-dialog-revert');
    if (key === 'preset') return root.querySelector<HTMLElement>('.agent-detail summary');

    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const rest = key.slice(separator + 1);

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

    if (kind === 'member') {
        return (
            Array.from(root.querySelectorAll<HTMLElement>('.agent-dialog-member')).find(
                (element) => element.dataset.agent === rest
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

    root.querySelector<HTMLSelectElement>('.agent-dialog-agent-select')?.focus();
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

            // The selected agent may have left the team or the catalogue. Fall back
            // to the primary rather than configuring an agent the server can no
            // longer reach.
            if (!agentEntriesOf(next).includes(state.selected)) state.selected = next.primary;

            paint();
        },
        paintActivity(active: ReadonlySet<string>): void {
            if (!open) return;
            paintAgentActivity(state.root, active);
        }
    };
};
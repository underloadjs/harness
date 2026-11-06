// The agent configuration dialog (T3/R3: one tab strip, editable configuration).
//
// PRODUCT RULE
// ------------
// ONE strip of clickable tabs lists the agents THIS conversation/harness actually has
// — the team members, primary first, exactly as the server reports them. Selecting a
// tab shows THAT agent's configuration: ONE editable instruction box holding the FULL
// effective instruction (R4: no read-only "preset" block and no revert control — the
// box is the whole truth) and ONE model dropdown. Nothing else is listed: an agent the
// team does not select has no configuration here yet, so it gets its own tab through
// the `[+]` control instead — and in a session (`allowCustom`) the reader can also type
// a brand-new agent name (R7) and get a tab the same way.
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
// is what `changesOf()` reports to `onApply`. An explicit '' in a draft means "clear
// it" (use the resolved default model / drop the stored instruction so the agent runs
// its default instruction again), which is how a saved value is reverted — by the
// box's own text, not by a dedicated control.
//
// The DEFAULT text a baseline falls back to is the FULL composed prompt
// (./agents.ts `agentDefaultInstructionOf`), whose identity sentence comes from the
// library row. That row is a second source and it is NOT in the boot page: `GET
// /agents` rows are summaries with no prompt (../shared/harness-api.ts:552-563), so
// main.ts folds the identified profile read (`GET /agents/:id`, ./api.ts `getAgent`)
// into `options.agents` before this dialog ever renders a fallback (./main.ts
// `loadAgentPresetTexts`). A tab that shows an agent that walk never covered — an
// agent added through `[+]` — asks for its text through `onRequestPreset`, so the read
// rides an explicit selection and never a render. A row still empty after that means
// the server genuinely has no prompt to show (a retired profile 404s), which is the
// honest blank, not a silent one. A name the reader typed (R7) never asks at all: the
// server has nothing to say about an agent it has never heard of, so its box starts
// empty by design.
//
// THE ROSTER (who has a tab)
// --------------------------
// `rosterOf()` is the saved team PLUS the drafted adds MINUS the drafted removals.
// It is the only listing in the dialog. `[+]` offers the catalogue agents missing from
// it, and in a session (`allowCustom`) also a form that turns a typed name into a tab
// (R7); a catalogue-only host (a harness template) still lists only agents the server
// advertises. Removing a member drops its tab immediately (the roster shown is the
// roster the save would produce); the draft still carries `member: false` so the delta
// is honest, and re-adding it through `[+]` cancels the removal.
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
// `editable` is the TEAM lock (an in-flight run, a session being created). It gates
// `[+]`, `Make primary`, `Remove from team` and the instruction editor. Models keep
// their own flag inside `models` (a saved session edits its live model map), so the
// dialog offers model editing exactly where the server does.
//
// `scope` says WHERE a save lands — 'session' edits this conversation's own agents and
// instructions, 'harness' edits the template new sessions start from (R5). It changes
// the copy only: the shell owns which route a save takes. `canPromote: false` (a saved
// conversation's entry agent is fixed) disables `Make primary` AND makes an armed
// promotion impossible, so the action can never promise "Save & set primary" somewhere
// that cannot promote. `threadAgents` names the agents a conversation in this session
// already runs, and one of those cannot be removed (R6): its control is disabled WITH
// the reason, and the reason is repeated as a visible note under the actions because a
// tooltip on a disabled control is not reachable.
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
//   - src/frontend/ui/agents.ts        createAgentModelSelect/agentDefaultInstructionOf
//   - src/frontend/ui/agent-color.ts   paintAgentColor — R4 paints every roster badge
//                                      and every `[+]` option with that agent's tone, so
//                                      a badge, the composer button and the transcript
//                                      blocks of one agent always share one colour
//   - src/frontend/ui/activity.ts      paintActivity (the dialog's tabs keep the
//                                      `.agent-dialog-agent[data-agent]` host it paints)
//   - src/frontend/ui/dialog.ts        modal stack/focus/scroll lock
//   - src/frontend/ui/agent-dialog.css `.agent-dialog*`

import type { AgentDescriptor } from '../../server/protocol';
import {
    UNKNOWN_MODEL_LABEL,
    agentDefaultInstructionOf,
    agentDetailsOf,
    createAgentModelSelect,
    displayTitleOf
} from './agents';
import type { AgentModelSelect } from './agents';
import { paintActivity as paintAgentActivity } from './activity';
import { paintAgentColor } from './agent-color';
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
    // Instruction choices the reader touched: agent id → the full text the agent
    // should run, or '' for "no stored instruction", which lets the agent fall back to
    // the default instruction its library row describes (R4: one box, cleared by hand).
    instructions: Record<string, string>;
    // Explicit membership changes. `add` comes from `[+]` (a catalogue pick or a name
    // typed in a session), `remove` from `Remove from team`; `add` never removes
    // anyone, and a promoted agent is never in `remove`.
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
    // The trusted agent library from GET /agents (or the boot fallback), with each
    // row's default-instruction text filled in by the identified profile read — see
    // the header note for why the page alone is not enough.
    agents: readonly AgentDescriptor[];
    // TEAM + instruction editing. Models carry their own flag inside `models`.
    editable: boolean;
    models: AgentModelSelect;
    // The stored per-agent INSTRUCTION text (the textarea's baseline). A member
    // absent here is seeded with its default instruction — the full prompt the server
    // composes, identity sentence plus guidelines (./agents.ts
    // `agentDefaultInstructionOf`).
    instructions: Readonly<Record<string, string>>;
    // R5: WHERE a save lands, which decides only the copy the reader is shown.
    // 'session' edits this conversation's own agents and instructions; 'harness' (the
    // default, so every existing caller keeps its old wording) edits the template.
    scope?: 'session' | 'harness';
    // R7: offer a "New agent" name field in the `[+]` picker, so a session can gain an
    // agent the catalogue never advertised. False (the default) keeps the picker
    // catalogue-only, which is what a harness template needs.
    allowCustom?: boolean;
    // Whether `Make primary` may be armed at all. A saved conversation's entry agent is
    // fixed, so its shell passes false and the action can never offer a promotion the
    // session cannot perform. Defaults to true.
    canPromote?: boolean;
    // R6: agents a conversation in this session already runs. Each of those keeps its
    // tab but cannot be removed, and the control says why. Defaults to empty, so a
    // harness (which has no threads) is unaffected.
    threadAgents?: readonly string[];
    // Asks main.ts for the trusted instruction text of an agent this dialog is about to
    // show (see the header note). Optional: a caller that has no such read (a test, a
    // host without the agent route) simply keeps the library text it was given. The
    // answer arrives through `update()`, so this never writes anything. Never called
    // for a name the reader typed, because the server has no row for it.
    onRequestPreset?: (agent: string) => void;
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
    // the caret and close an add picker the reader is typing in mid-interaction.
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
    // Instruction text exactly as typed, or '' for "no stored instruction", which lets
    // the agent fall back to the default instruction its library row describes.
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

// T7b (R7): the label for an agent ON THIS TEAM.
//
// A session's roster can name an agent the catalogue has never advertised — the reader typed
// that name into the `[+]` form, and the conversation now runs it. `agentDetailsOf`'s neutral
// fallback ('Agent', ./agents.ts:161-171) exists to keep an UNKNOWN id out of visible text (R3),
// and for a member it points at nothing: the id IS the identity the reader chose, and rendering
// 'Agent' makes a real teammate read like a failed lookup (two of them are indistinguishable).
// So a rostered name with no library row is displayed as written, and a name that is NOT on the
// roster keeps the neutral fallback exactly as before — `[+]` options, a promotion target, or a
// stale `selected` after a refresh have no team entry to justify showing their id.
const memberTitleOf = (options: AgentDialogOptions, state: DialogState, name: string): string =>
    options.agents.some((agent) => agent.name === name) || !rosterOf(options, state).includes(name)
        ? titleOf(options.agents, name)
        : name;

// ---------------------------------------------------------------------------
// Optional capability flags (R5/R6/R7). Each defaults to the behaviour a caller
// written before that rule expects — a harness template, an in-flight run, an older
// test fixture — so adding the flags changed no existing call site. Reading them
// through these helpers keeps every rule below a plain boolean instead of a repeated
// `options.x === undefined ? … : …` chain.
// ---------------------------------------------------------------------------
// R5: 'session' edits this conversation, 'harness' (default) edits the template.
const isSessionScope = (options: AgentDialogOptions): boolean => options.scope === 'session';

// R7: a session may gain an agent the catalogue never advertised.
const allowsCustomAgent = (options: AgentDialogOptions): boolean => options.allowCustom === true;

// R6/R5: a saved conversation's entry agent is fixed; everything else may promote.
const mayPromote = (options: AgentDialogOptions): boolean => options.canPromote !== false;

// R6: an agent some conversation in this session already runs. Ids compare exactly,
// because the roster, `primary` and `threadAgents` are all server-side agent ids.
const usedByThread = (options: AgentDialogOptions, name: string): boolean =>
    (options.threadAgents ?? []).includes(name);

// The modal header names the agent being configured, because that is what the tab
// strip — and therefore the whole dialog — is about.
const dialogTitle = (options: AgentDialogOptions, state: DialogState): string =>
    `Agents · ${memberTitleOf(options, state, state.selected)}`;

// The roster: the agents with a badge. Saved members first, in the exact order the
// server reports them (a saved conversation can name an agent the catalogue no longer
// advertises, so members come from `options.members`, never from the library), then
// the drafted additions in the order they were added. A catalogue-only dialog (a
// harness template) drops an addition the server stopped offering, because such an
// agent cannot be joined and `[+]` would not offer it again; a session
// (`allowCustom`) keeps it, because the reader typed that name and the session accepts
// agents the catalogue has never heard of (R7). A drafted removal drops the badge now,
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
        if (!allowsCustomAgent(options) && !options.agents.some((agent) => agent.name === name)) {
            continue;
        }
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

// The instruction the textarea starts from: the text this scope saved for the agent,
// otherwise that agent's DEFAULT instruction — the full prompt the server composes
// (identity sentence plus its `Guidelines:` block), not the identity alone (R4). The
// default side of that pair is the library row main.ts filled from `GET /agents/:id`
// (./main.ts `loadAgentPresetTexts`); a row that is still empty after that read names a
// profile this server no longer publishes, and the blank is the truth. A name the
// reader typed has no row at all, so its box honestly starts empty.
const baselineInstructionOf = (options: AgentDialogOptions, name: string): string => {
    // A stored value that is only whitespace is "nothing saved": falling through keeps
    // the box showing the words the agent actually runs instead of an empty one. The
    // saved text is used VERBATIM (never trimmed) so a save round-trips byte-identical.
    const stored = options.instructions[name] ?? '';

    return stored.trim().length > 0
        ? stored
        : agentDefaultInstructionOf(agentDetailsOf(options.agents, name));
};

// The promotion this dialog's action represents: the agent armed by `Make primary`,
// and only while the team is editable AND the scope can promote at all (R5/R6: a saved
// conversation's entry agent is fixed). `undefined` means "no promotion" — the tab
// selection itself never promotes (R3).
const promotionOf = (options: AgentDialogOptions, state: DialogState): string | undefined =>
    options.editable && mayPromote(options) ? state.promote : undefined;

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
// control carries its own reason. R5: when a save IS possible the line says where it
// lands, because "Saves" alone no longer answers that question in a conversation.
const footerNoteOf = (options: AgentDialogOptions, state: DialogState): string => {
    if (!options.editable) {
        return options.models.editable
            ? 'Models only here · this conversation keeps the team and instructions it started with.'
            : 'Nothing can be changed in this conversation right now.';
    }

    const promoted = promotionOf(options, state);

    if (promoted !== undefined) {
        // Sessions normally cannot arm a promotion (`canPromote: false`), so the
        // session wording is the honest fallback for a host that does allow one — it
        // must never claim a harness write the reader did not make.
        return `Saves ${isSessionScope(options) ? 'on this conversation' : 'this harness'} and makes ${memberTitleOf(
            options,
            state,
            promoted
        )} the primary.`;
    }

    return isSessionScope(options)
        ? 'Saves on this conversation · only this session’s agents and instructions change.'
        : 'Saves on this harness template · new sessions start with these agents and instructions.';
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
            (promoted === undefined ? '' : ` and make ${memberTitleOf(options, state, promoted)} the primary`) +
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

// Move the view onto one agent. Selection is a VIEW change: nothing is sent and nobody
// is promoted (R3), which is also what makes it the right moment to ask for that
// agent's default instruction text — the reader chose it explicitly, so the read is paid
// for by a click or an arrow key, never by a render. `onRequestPreset` is a no-op for an
// agent whose library row already carries text, so re-selecting a tab is free.
const selectMemberTab = (options: AgentDialogOptions, state: DialogState, member: string): void => {
    if (member === '' || state.selected === member) return;

    state.selected = member;
    state.result = undefined;
    state.adding = false;
    options.onRequestPreset?.(member);
    state.paint(`tab:${member}`);
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

    // An exhausted catalogue would normally close the picker, but in a session the
    // reader can still gain an agent the server never advertised (R7), so `[+]` stays
    // live and the picker opens on the name form alone.
    if (addable.length === 0 && !allowsCustomAgent(options)) {
        add.disabled = true;
        add.title = 'Every agent the server offers is already on this team.';
        return add;
    }

    add.title = allowsCustomAgent(options)
        ? 'Add an agent to the team, or name a new one.'
        : 'Add an agent to the team.';
    add.addEventListener('click', () => {
        state.adding = !state.adding;
        state.paint(state.adding ? 'add-first' : 'add');
    });

    return add;
};

// ---------------------------------------------------------------------------
// R7: a session can run agents the catalogue never advertised, so its `[+]` panel also
// takes a typed name. The id contract is the server's own: every agent-name field in
// ../server/harness.swagger.yaml (lines 816/1735/2885/2896/3461/4401) is
// `pattern: '^[a-z][a-z0-9_-]*$'`, so the form validates exactly that client-side and a
// typo is caught before a save round-trip instead of coming back as a 400.
// ---------------------------------------------------------------------------
const CUSTOM_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

// The one reserved id. `unknown` is what the transcript, the event stream and
// ./ui/agent-control.ts print for an agent nobody can identify, so a reader-created
// agent with that name would make two different facts share one label.
const RESERVED_AGENT_NAME = 'unknown';

// The typed name's verdict, or '' when the name is usable. An empty field is also '' —
// the panel must not scold a form the reader has not filled in yet. Agent ids are
// case-sensitive on the server, but a name that differs from an existing one only by
// case would still read as the same word (and the pattern already rejects capitals), so
// the collision check folds case against the roster AND the primary, which a drafted
// removal may have just taken off the strip.
const customAgentNameError = (
    options: AgentDialogOptions,
    state: DialogState,
    typed: string
): string => {
    const name = typed.trim();

    if (name === '') return '';

    if (!CUSTOM_AGENT_NAME_PATTERN.test(name)) {
        return 'Use a lowercase name that starts with a letter and continues with letters, digits, "-" or "_".';
    }

    if (name.toLowerCase() === RESERVED_AGENT_NAME) {
        return '"unknown" is the reserved name for an agent the server cannot identify.';
    }

    const taken = [...rosterOf(options, state), options.primary].some(
        (member) => member.toLowerCase() === name.toLowerCase()
    );

    if (taken) return `An agent named ${name} is already on this team.`;

    return '';
};

// The "New agent" half of the `[+]` panel. Like a catalogue pick it only DRAFTS the
// membership and moves the view: nothing is sent until the action, and dismissal drops
// it. It never calls `onRequestPreset`, because the server has no row to read for a name
// nobody published — that agent's instruction box honestly starts empty.
const createCustomAgentForm = (options: AgentDialogOptions, state: DialogState): HTMLElement => {
    const form = el('div', 'agent-dialog-add-custom');

    const name = el('input', 'agent-dialog-add-input field-input');
    name.type = 'text';
    name.setAttribute('aria-label', 'New agent name');
    name.placeholder = 'New agent name';
    // The server caps an agent name at 64 characters; the attribute stops the reader
    // where the contract does instead of rejecting a long word on save.
    name.maxLength = 64;
    name.title = 'Lowercase letters, digits, "-" and "_", starting with a letter.';

    // Announced, not a paragraph the reader has to hunt for, and only ever filled when
    // the typed name is actually unusable.
    const error = el('p', 'agent-dialog-add-error', '');
    error.setAttribute('role', 'status');

    const create = el('button', 'agent-dialog-add-create', 'Create agent');
    create.type = 'button';
    create.title = 'Add this agent to the team. Its instruction is empty until you write one.';

    // Stays ENABLED even when the name is unusable: a press is what shows the reason,
    // and a disabled button would swallow it (a tooltip on a disabled control is not
    // reachable). The verdict is written straight into the live nodes, so no repaint
    // moves the caret mid-word.
    const show = (message: string): void => {
        error.textContent = message;
        create.setAttribute('aria-disabled', message.length > 0 ? 'true' : 'false');
    };

    name.addEventListener('input', () => {
        show(customAgentNameError(options, state, name.value));
    });

    const submitName = (): void => {
        const trimmed = name.value.trim();
        const message = customAgentNameError(options, state, trimmed);

        show(message);

        // Nothing typed, or an unusable name: the panel keeps the reason and drafts
        // nobody.
        if (trimmed === '' || message !== '') return;

        editDraft(state, trimmed, (draft) => {
            draft.member = true;
        });
        state.selected = trimmed;
        state.adding = false;
        state.paint(`tab:${trimmed}`);
    };

    create.addEventListener('click', submitName);

    // Enter in the field is the same press. The dialog body is a plain <div>, so this
    // is a keydown handler rather than a form submit, and `preventDefault` stops Enter
    // reaching the dialog's own key handling (Escape/Tab trapping, ui/dialog.ts).
    name.addEventListener('keydown', (event: Event) => {
        const keyboard = event as KeyboardEvent;
        if (keyboard.key !== 'Enter') return;

        keyboard.preventDefault();
        submitName();
    });

    form.append(el('p', 'agent-dialog-add-custom-label', 'New agent'), name, create, error);

    return form;
};

// The picker: the agents WITHOUT a tab, one button each, and in a session the "New
// agent" form after them. Picking one only DRAFTS the membership and moves the view to
// it — nothing is sent until the action.
const createAddPicker = (options: AgentDialogOptions, state: DialogState): HTMLElement | undefined => {
    if (!state.adding) return undefined;

    const list = el('div', 'agent-dialog-add-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Agents to add');

    for (const name of addableOf(options, state)) {
        const label = displayTitleOf(agentDetailsOf(options.agents, name));
        const option = el('button', 'agent-dialog-add-option', label);
        option.type = 'button';
        // R4 (T5): a picker option is an agent the roster is about to gain, so it is
        // painted with the tone that badge will keep — the colour is already the reader's
        // pointer to "who am I about to add". Same canonical id, same page-lifetime slot,
        // so the option and the badge it produces cannot disagree.
        paintAgentColor(option, name);
        option.title = `Add ${label} to the team and configure it.`;
        option.addEventListener('click', () => {
            editDraft(state, name, (draft) => {
                draft.member = true;
            });
            // The new tab is the configuration the reader is here to fill in.
            state.selected = name;
            state.adding = false;
            // An agent added here was never part of the definition the dialog-open walk
            // covered, so its trusted instruction text is asked for by this same press
            // (see `selectMemberTab` for why a selection is the right moment).
            options.onRequestPreset?.(name);
            state.paint(`tab:${name}`);
        });

        list.append(option);
    }

    // R7: the name form comes last, so the agents the server already offers stay the
    // first thing a reader sees. A locked team cannot gain an agent at all, and a
    // harness template only accepts catalogue agents, so neither gets the form.
    if (allowsCustomAgent(options) && options.editable) {
        list.append(createCustomAgentForm(options, state));
    }

    return list;
};

// R6: an agent some conversation in this session already runs cannot be taken off the
// team (its transcript names it). The primary is exempt because its own, stronger
// reason already disables the control, and a locked team is already fully explained by
// the lock hint — so this says exactly when the THREAD reason is the reason, and the
// disabled control's tooltip and the visible note below can never disagree.
const isRemovalBlockedByThread = (
    options: AgentDialogOptions,
    name: string,
    isPrimary: boolean
): boolean => options.editable && !isPrimary && usedByThread(options, name);

// The two explicit membership controls inside the selected agent's panel. R3: the
// tab strip selects WHAT you view; these change WHO is on the team, and each one
// states its effect instead of leaving a disabled control unexplained.
//
// R5/R6 add two more reasons the reader must be told about, in the order the reason
// actually applies: a saved conversation's entry agent is fixed (`canPromote: false`),
// and an agent some conversation already runs cannot be removed at all (`threadAgents`).
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
    const promotable = options.editable && mayPromote(options) && !isPrimary;

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
        : !mayPromote(options)
          ? // R5: a saved conversation keeps the entry agent it started with, so the
            // control is not merely busy — it has nothing to do here.
            'The primary agent is fixed for a saved conversation.'
          : isPrimary
            ? 'The primary agent is already the primary.'
            : armed
              ? `Cancel the promotion, so ${label} stays a team member without leading the team.`
              : `Make ${label} the primary agent when you save.`;
    promote.addEventListener('click', () => {
        if (!promotable) return;

        state.promote = armed ? undefined : name;
        state.result = undefined;
        state.paint('action:promote');
    });

    const remove = el('button', 'agent-dialog-action agent-dialog-remove');
    remove.type = 'button';
    remove.dataset.action = 'remove';
    remove.dataset.agent = name;
    remove.textContent = 'Remove from team';

    // R6: the exact condition the note below repeats (see `isRemovalBlockedByThread`).
    const blockedByThread = isRemovalBlockedByThread(options, name, isPrimary);

    // The primary always stays, so its control is disabled WITH the reason instead of
    // silently missing. For a drafted addition the label is the same and the effect
    // cancels the add.
    remove.disabled = !options.editable || isPrimary || blockedByThread;
    remove.title = !options.editable
        ? (options.hint ?? 'The agent team is locked here.')
        : isPrimary
          ? 'The primary agent is always part of the team.'
          : blockedByThread
            ? // The action the reader has to take lives outside this dialog (delete the
              // conversation), so the reason names it instead of just refusing.
              'This agent is used by a conversation in this session; delete that conversation before removing the agent.'
            : isMember
              ? `Take ${label} off the team when you save.`
              : `Cancel the add, so ${label} never joins this team.`;
    remove.addEventListener('click', () => {
        if (remove.disabled) return;

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

    // The viewed agent's visible name: the library title when the catalogue describes it, and the
    // name the reader typed for a member this conversation invented (T7b, `memberTitleOf`). The
    // SAME string feeds the panel's aria-labels and the model select, so the header, the tab and
    // the editor can never name two different owners for one configuration.
    const label = memberTitleOf(options, state, selected);
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
        const title = memberTitleOf(options, state, member);
        const active = member === selected;

        const tab = el('button', 'agent-dialog-tab agent-dialog-agent');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.id = `agent-dialog-tab-${member}`;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('aria-controls', 'agent-dialog-config');
        // Roving tabindex: one tab stop for the whole strip, arrows move inside it.
        tab.tabIndex = active ? 0 : -1;
        // R4 (T5): the badge is painted with its agent's tone, so the roster answers
        // "which badge is which agent" with the SAME colour the transcript tiles and the
        // composer button already use. Painting the badge (not the inner name span) is
        // what makes that possible in one call: `--agent-color` inherits down to
        // `.agent-dialog-agent-name`, and the rebuild in `paint()` re-reads the same
        // page-lifetime assignment, so switching tabs or a live refresh never recolours
        // a badge. The badge's own border stays `--border`/`--accent` because that is the
        // channel for selection and ACTIVITY — identity colour and state colour must stay
        // readable as two different facts.
        //
        // `data-agent`/`data-role` are the same team facts the deck and the old rows
        // exposed, so a test/inspector reads the roster the same way from any host, and
        // ui/activity.ts keeps painting these nodes (`paintAgentColor` writes the same
        // canonical id).
        paintAgentColor(tab, member);
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
            selectMemberTab(options, state, member);
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
        selectMemberTab(options, state, moved);
    });

    chooser.append(tabs, createAddControl(options, state));

    // A session's picker also opens when the catalogue is exhausted, because the
    // "New agent" form is still something to offer there (R7). A catalogue-only host has
    // nothing left to add, so it renders no empty group.
    if (
        state.adding &&
        options.editable &&
        (addable.length > 0 || allowsCustomAgent(options))
    ) {
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
    // R4: exactly ONE instruction control, holding the FULL instruction the agent runs
    // (identity plus its guidelines when nothing has been saved). The read-only "preset"
    // block and the revert control are gone: the box's own text is the whole truth, and
    // clearing it is how the default comes back.
    const instructionLocked = !options.editable;

    config.append(el('p', 'agent-dialog-label', 'Instruction'));

    const instruction = el('textarea', 'agent-dialog-instruction field-input');
    instruction.setAttribute('aria-label', `Instruction for ${label}`);
    instruction.rows = 8;
    instruction.spellcheck = false;
    instruction.placeholder = 'Describe what this agent should do.';
    instruction.value = draft.instruction ?? baselineInstructionOf(options, selected);
    // A locked instruction is shown as disabled text, never as an editable box whose
    // typing would be silently thrown away. The reason lives on the control (R3: no
    // explanation paragraph), and the text stays readable.
    instruction.disabled = instructionLocked;
    // R3: the reason lives ON the control (no explanation paragraph), and R5: the
    // unlocked sentence names the scope a save actually writes, because "saved" alone no
    // longer says where. The locked branch is only ever a run/submit in flight — a saved
    // conversation edits its own instructions now, so it never reaches here.
    instruction.title = instructionLocked
        ? 'Wait for the current run to finish before changing this instruction.'
        : isSessionScope(options)
          ? 'The instruction this agent runs in this conversation.'
          : 'The instruction this agent runs. Saved on this harness template for new sessions.';

    // Typing only updates the draft and re-arms the action: a full repaint here would
    // move the caret and interrupt the reader.
    instruction.addEventListener('input', () => {
        editDraft(state, selected, (entry) => {
            entry.instruction = instruction.value;
        });
        syncAction(options, state);
    });

    config.append(instruction);

    // Membership ------------------------------------------------------------
    // R3: no checkbox and no prose. `[+]` adds, this row removes, and a promotion is
    // armed explicitly. Conservative by construction: viewing a tab never changes the
    // team, and the primary can never be removed.
    config.append(createMembershipActions(options, state, selected, label, isPrimary, isMember));

    // R6: the thread reason repeated where it is visible. A disabled button's `title` is
    // not reachable by keyboard or by a screen reader in reading order, so the panel
    // states the block itself — and names the action that lifts it.
    if (isRemovalBlockedByThread(options, selected, isPrimary)) {
        config.append(
            el(
                'p',
                'agent-dialog-field-note agent-dialog-inuse',
                'This agent is in use by a conversation and cannot be removed.'
            )
        );
    }

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
                : ` and make ${memberTitleOf(options, state, promotionOf(options, state) as string)} the primary`) +
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

    // R7: the custom-name field. The typed value lives on the node itself, so the key
    // only has to land the caret back inside that field (no per-character state).
    if (active.closest<HTMLElement>('.agent-dialog-add-input') !== null) return 'add-input';

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

    const apply = active.closest<HTMLButtonElement>('.agent-dialog-apply');
    if (apply !== null) return `apply:${apply.dataset.agent ?? ''}`;

    const model = active.closest<HTMLSelectElement>('.agent-model-select');
    if (model !== null) return `model:${model.getAttribute('aria-label') ?? ''}`;

    // R4: no `revert` and no read-only `preset` details any more — the instruction box
    // above is the only instruction control, so those keys can never be produced.
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

    // R7: the custom-name field, so a live refresh while the picker is open keeps the
    // reader in the box they are typing in.
    if (key === 'add-input') return root.querySelector<HTMLElement>('.agent-dialog-add-input');
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
    // The picker's first option is where `[+]` focus goes when the list opens. A session
    // whose catalogue is already exhausted has no option, so its name field is the
    // control the reader came for (R7).
    if (key === 'add-first') {
        (
            root.querySelector<HTMLElement>('.agent-dialog-add-option') ??
            root.querySelector<HTMLElement>('.agent-dialog-add-input')
        )?.focus();
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

            // An open picker with nothing left to add would render an empty group — but
            // a session's picker still has the name form, so it stays open (R7).
            if (
                state.adding &&
                !allowsCustomAgent(next) &&
                addableOf(next, state).length === 0
            ) {
                state.adding = false;
            }

            paint();
        },
        paintActivity(active: ReadonlySet<string>): void {
            if (!open) return;
            paintAgentActivity(state.root, active);
        }
    };
};

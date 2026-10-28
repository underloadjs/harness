// The harness agent row: one tile per configured agent, a trailing add tile and
// the trusted preset picker.
//
// Product rules this component encodes (R2):
//   - the row replaces the old description wall; every member is labelled either
//     `primary` or `secondary` in text (not colour alone);
//   - selecting any member's tile makes it primary — the row never shows two
//     primaries, and the caller sends the complete `subagents` list with the new
//     `primary` so a demotion cannot leave a stale duplicate behind;
//   - the trailing `+` opens a picker of agents the SERVER advertises. Harness
//     creation here means choosing existing presets, never typing instructions:
//     the instruction and guidelines are shown read-only;
//   - a member already in the team is visibly disabled in the picker, so a
//     duplicate cannot be added;
//   - removing a member is offered on every tile except the last one;
//   - every tile carries its own model dropdown (R9), labelled for that agent and
//     placed outside the promotion button. It offers "inherit" plus the provider
//     catalogue; a locked (saved) session shows the effective frozen model with the
//     control disabled.
//   - an active agent's tile carries `data-activity='active'` / `aria-busy` for the
//     rotating ring (ui/activity.ts, styles.css).
//
// The component is intentionally stateless: `main.ts` re-renders it from the
// descriptor after every server-confirmed change. Only the picker's open state is
// local, and it closes as soon as a preset is chosen.
//
// Cross-references:
//   - playground/src/contract.ts — primary/subagents accessors
//   - playground/src/main.ts — PATCH handling and the lock explanation
//   - playground/src/styles.css — `.agent-row`, `.agent-tile`, `.agent-picker`

import type { AgentDescriptor } from '../../../server/protocol';

export type AgentRowOptions = {
    // Member names in display order; the primary is also present in this list.
    members: readonly string[];
    primary: string;
    // Trusted preset library from GET /agents (or the boot fallback).
    agents: readonly AgentDescriptor[];
    // False while a run is in flight or while a saved session's frozen team is on
    // screen. The reason is printed verbatim next to the row.
    editable: boolean;
    lockReason?: string;
    // The affordance offered with the lock explanation: start a new conversation
    // so the edited team applies.
    onNewSession?: () => void;
    // Per-agent model dropdowns (R9). Every tile gets one, labelled for its own
    // agent and kept OUTSIDE the promotion button so choosing a model can never
    // also change the primary. Omitted only by callers that do not know models.
    models?: AgentModelSelect;
    // Agent names whose tile should show the rotating activity ring. Read from the
    // live per-instance set, so a rebuild never loses a running agent.
    activity?: readonly string[];
    onSelectPrimary: (name: string) => void;
    onAdd: (name: string) => void;
    onRemove: (name: string) => void;
};

// Data for the model dropdown on each tile.
export type AgentModelSelect = {
    // Effective model id per member. For an editable harness this is the override
    // map only (a missing member inherits); for a frozen session it is the
    // server's effective map, so the id shown is the one the chat is running.
    models: Readonly<Record<string, string>>;
    // Provider catalogue ids, in the server's order. The current id is appended
    // when it is absent, so a provider that stopped advertising it still renders.
    catalogue: readonly string[];
    // The model named by the "inherit" option: the session model for a frozen
    // chat, the global settings model for a new session.
    inheritModel?: string;
    // False when the team is locked: the select shows the effective frozen model
    // and cannot change it. The caller explains the lock and offers New session.
    editable: boolean;
    onChange?: (name: string, model: string) => void;
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

// Unique ids for `aria-controls`; a module counter is enough for one document.
let nextId = 0;

// Resolve preset metadata for a name. A descriptor can name an agent the picker
// does not know (an old saved session); the tile still renders, with the name as
// its title, rather than disappearing.
const detailsOf = (agents: readonly AgentDescriptor[], name: string): AgentDescriptor =>
    agents.find((agent) => agent.name === name) ?? {
        name,
        title: name,
        description: 'No preset details are available for this agent.',
        instruction: '',
        guidelines: []
    };

const presetDetail = (agent: AgentDescriptor): HTMLElement => {
    const detail = el('details', 'agent-detail');
    detail.append(el('summary', 'agent-detail-summary', 'preset details'));

    const body = el('div', 'agent-detail-body');
    body.append(
        el(
            'p',
            'agent-instruction',
            agent.instruction.length > 0
                ? agent.instruction
                : 'This server does not advertise an instruction for this agent.'
        )
    );

    if (agent.guidelines.length > 0) {
        body.append(el('p', 'agent-detail-label', 'guidelines'));
        const list = el('ul', 'agent-guidelines');
        for (const guideline of agent.guidelines) list.append(el('li', 'agent-guideline', guideline));
        body.append(list);
    }

    detail.append(body);
    return detail;
};

// One tile's model dropdown. Kept as a helper because the option list has three
// sources that must not disagree:
//
//   1. `inherit` (value '') — the member uses the session/global model, which is
//      what a member missing from the override map really does;
//   2. every id the provider advertises, in provider order;
//   3. the current id when the catalogue does not list it (an override chosen
//      before the provider changed, or a frozen session's effective model). It is
//      labelled "(current)" so a stale id is visibly not a fresh choice.
//
// The visible text is "model"; the accessible name carries the agent, so a screen
// reader announces "Model for summarizer".
const modelSelectFor = (name: string, models: AgentModelSelect): HTMLElement => {
    const row = el('label', 'agent-model');
    row.append(el('span', 'agent-model-label', 'model'));

    const select = el('select', 'agent-model-select field-select');
    select.setAttribute('aria-label', `Model for ${name}`);

    const inherit = el(
        'option',
        undefined,
        models.inheritModel !== undefined && models.inheritModel.length > 0
            ? `inherit · ${models.inheritModel}`
            : 'inherit session model'
    );
    inherit.value = '';
    select.append(inherit);

    const current = models.models[name] ?? '';
    const catalogue = [...models.catalogue];
    // Append the current id only when the catalogue does not already offer it.
    // For an editable harness `current` is an override; for a frozen session it is
    // the effective model, and seeing it is the point of the locked dropdown.
    const ids = current.length > 0 && !catalogue.includes(current) ? [...catalogue, current] : catalogue;

    for (const id of ids) {
        const option = el(
            'option',
            undefined,
            id === current && !catalogue.includes(id) ? `${id} (current)` : id
        );
        option.value = id;
        select.append(option);
    }

    // A non-empty current value selects its option; an inherited member lands on
    // the inherit entry because no override option exists for it.
    select.value = current;
    select.disabled = !models.editable || models.onChange === undefined;
    select.title = models.editable
        ? models.onChange === undefined
            ? 'Model editing is unavailable.'
            : `Model for ${name}. Applies to future sessions.`
        : 'This chat keeps the models it started with; start a new session to change them.';

    select.addEventListener('change', () => {
        if (!models.editable) return;
        models.onChange?.(name, select.value);
    });

    row.append(select);
    return row;
};

export const createAgentRow = (options: AgentRowOptions): HTMLElement => {
    const wrapper = el('div', 'agent-row-wrap');

    const row = el('div', 'agent-row');
    row.setAttribute('role', 'list');
    row.setAttribute('aria-label', 'Agent team');

    const pickerId = `agent-picker-${++nextId}`;

    const picker = el('div', 'agent-picker');
    picker.id = pickerId;
    picker.hidden = true;
    // A disclosure, not a modal: the rest of the page stays operable.
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Add an agent from the server presets');
    picker.append(
        el(
            'p',
            'agent-picker-hint',
            'Choose an existing preset agent. Instructions and guidelines are read-only; they come from the server.'
        )
    );

    const addButton = el('button', 'agent-add');
    addButton.type = 'button';
    addButton.textContent = '+';
    addButton.setAttribute('aria-label', 'Add an agent');
    addButton.setAttribute('aria-expanded', 'false');
    addButton.setAttribute('aria-controls', pickerId);
    addButton.title = options.editable ? 'Add an agent' : (options.lockReason ?? 'The agent team is locked.');
    addButton.disabled = !options.editable;

    const setPickerOpen = (open: boolean): void => {
        picker.hidden = !open;
        addButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) picker.querySelector<HTMLButtonElement>('.agent-option-add:not(:disabled)')?.focus();
    };

    addButton.addEventListener('click', () => {
        if (!options.editable) return;
        setPickerOpen(picker.hidden === true);
    });

    // One button per server preset. Already-added agents stay visible (so the
    // team is understandable) but cannot be added twice.
    for (const agent of options.agents) {
        const member = options.members.includes(agent.name);
        const option = el('div', 'agent-option');
        option.dataset.agent = agent.name;
        if (member) option.dataset.state = 'member';

        const choose = el('button', 'agent-option-add');
        choose.type = 'button';
        choose.disabled = !options.editable || member;
        choose.append(
            el('span', 'agent-option-name', agent.name),
            el('span', 'agent-option-title', agent.title),
            el('span', 'agent-option-description', agent.description),
            el('span', 'agent-option-state', member ? 'already in team' : 'add')
        );
        choose.addEventListener('click', () => {
            if (!options.editable || member) return;
            options.onAdd(agent.name);
            setPickerOpen(false);
        });

        option.append(choose, presetDetail(agent));
        picker.append(option);
    }

    if (options.agents.length === 0) {
        picker.append(el('p', 'agent-picker-hint', 'The server did not advertise any agent presets.'));
    }

    // Member tiles. The whole card is not a button (a remove control and a model
    // dropdown live inside it), so the primary-selection button and the remove
    // button are siblings inside the top row.
    const active = new Set(options.activity ?? []);

    for (const name of options.members) {
        const agent = detailsOf(options.agents, name);
        const isPrimary = name === options.primary;
        const tile = el('article', 'agent-tile');
        tile.dataset.agent = name;
        tile.dataset.role = isPrimary ? 'primary' : 'secondary';
        tile.setAttribute('role', 'listitem');

        // Activity is per agent and read from the live set passed by main.ts.
        // `aria-busy` is the assistive signal; the ring is decoration on top.
        if (active.has(name)) {
            tile.dataset.activity = 'active';
            tile.setAttribute('aria-busy', 'true');
        }

        const main = el('button', 'agent-main');
        main.type = 'button';
        main.disabled = !options.editable;
        main.setAttribute('aria-pressed', isPrimary ? 'true' : 'false');
        main.title = isPrimary
            ? 'This agent is the primary (entry) agent.'
            : `Make ${name} the primary agent; ${options.primary} becomes a subagent.`;

        main.append(
            el('span', 'agent-role', isPrimary ? 'primary' : 'secondary'),
            el('span', 'agent-tile-name', agent.name),
            el('span', 'agent-tile-title', agent.title)
        );
        main.addEventListener('click', () => {
            if (!options.editable || isPrimary) return;
            options.onSelectPrimary(name);
        });

        const remove = el('button', 'agent-remove');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${name}`);
        // The last agent is the entry point: removing it would leave nothing to
        // run, so it is disabled rather than silently rejected.
        remove.disabled = !options.editable || options.members.length <= 1;
        remove.title =
            options.members.length <= 1 ? 'A harness needs at least one agent.' : `Remove ${name}`;
        remove.addEventListener('click', () => {
            if (!options.editable || options.members.length <= 1) return;
            options.onRemove(name);
        });

        const top = el('div', 'agent-tile-top');
        top.append(main, remove);

        // The model dropdown is a sibling of the promotion button, never inside
        // it: changing a model must not also promote the agent.
        const model = modelSelectFor(
            name,
            options.models ?? {
                models: {},
                catalogue: [],
                editable: false
            }
        );

        tile.append(top, model);
        row.append(tile);
    }

    row.append(addButton);
    wrapper.append(row, picker);

    // Lock explanation and the affordance that makes the rule actionable: a
    // saved session keeps its frozen team, so the way to edit is a new session.
    if (!options.editable) {
        const lock = el('p', 'agent-lock');
        lock.append(
            el(
                'span',
                'agent-lock-text',
                options.lockReason ?? 'The agent team cannot be changed here.'
            )
        );

        if (options.onNewSession !== undefined) {
            const action = el('button', 'link-button', 'New session');
            action.type = 'button';
            action.addEventListener('click', () => options.onNewSession?.());
            lock.append(action);
        }

        wrapper.append(lock);
    }

    return wrapper;
};

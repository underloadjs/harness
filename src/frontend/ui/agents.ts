// The harness agent row: one tile per configured agent, a trailing add tile and
// the trusted preset picker.
//
// Product rules this component encodes (R2):
//   - the row replaces the old description wall; each tile shows exactly ONE
//     human-readable name (the preset title, e.g. "Summarizer") instead of a
//     duplicated slug + title pair, and no role badge. Role is conveyed by the
//     name colour (primary green, secondary neutral, styles.css) plus the
//     `aria-pressed` state below, so the control stays compact;
//   - selecting any member's tile makes it primary — the row never shows two
//     primaries, and the caller sends the complete `subagents` list with the new
//     `primary` so a demotion cannot leave a stale duplicate behind;
//   - the trailing `+` opens a picker of agents the SERVER advertises. Harness
//     creation here means choosing existing presets, never typing instructions:
//     the instruction and guidelines are shown read-only;
//   - a member already in the team is visibly disabled in the picker, so a
//     duplicate cannot be added;
//   - removing a member is offered on every tile except the last one;
//   - every tile carries its own model dropdown (R9/R18) placed outside the
//     promotion button. It is a bare select with no visible "model" label; its
//     accessible name still carries the agent. It never says "inherit": the
//     no-override choice is labelled with the ACTUAL model it resolves to, and the
//     provider catalogue follows alphabetically. R2: a saved session's models are
//     LIVE (main.ts PATCHes /sessions/:id), so the control stays enabled there even
//     though the team is frozen; only a caller with no model data disables it.
//   - an active agent's tile carries `data-activity='active'` / `aria-busy` for the
//     rotating ring (ui/activity.ts, styles.css).
//
// The component is intentionally stateless: `main.ts` re-renders it from the
// descriptor after every server-confirmed change. Only the picker's open state is
// local, and it closes as soon as a preset is chosen.
//
// Cross-references:
//   - src/frontend/contract.ts — primary/subagents accessors
//   - src/frontend/main.ts — PATCH handling and the lock explanation
//   - src/frontend/styles.css — `.agent-row`, `.agent-tile`, `.agent-picker`

import type { AgentDescriptor } from '../../server/protocol';
// Per-agent dropdowns show the catalogue alphabetically; the global dropdown in
// main.ts keeps provider order, so the helper is intentionally only used here.
import { sortModelIds } from './model-order';

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
    // Known model id per member. For an editable harness this is the override map
    // only (a missing member uses fallbackModel); for a frozen session it is the
    // server's effective map, so the id shown is the one the chat is running.
    models: Readonly<Record<string, string>>;
    // Provider catalogue ids, in the server's order. The per-agent dropdown sorts
    // a copy alphabetically (ui/model-order.ts); an override absent from the
    // catalogue is sorted in too, so a provider that stopped advertising it still
    // renders without changing the caller's array.
    catalogue: readonly string[];
    // The model a member uses when it has no override: the session/global model
    // for an editable harness, the frozen session model for a saved chat. R18: this
    // is only ever rendered as the resolved model id (never as "inherit"). Empty
    // means the caller does not know the effective model; the option then says so
    // honestly instead of inventing an id.
    fallbackModel?: string;
    // False when the team is locked: the select shows the effective frozen model
    // and cannot change it. The caller explains the lock and offers New session.
    editable: boolean;
    // R2: true when this dropdown edits a SAVED session's live model map. It only
    // changes the tooltip's promise ("next request in this session" instead of
    // "future sessions"); the control's enabled state still comes from `editable`.
    session?: boolean;
    onChange?: (name: string, model: string) => void;
};

// Shown when no effective model is known (a blank setting before the server
// default arrives). Deliberately not "inherit": R18 requires the dropdown to name
// a model, and when it cannot it must say so rather than imply one.
export const UNKNOWN_MODEL_LABEL = 'model not specified';

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

// One tile's model dropdown. R18: every option label is a real model id — the
// first option (value '') is the no-override/default choice, and it is labelled
// with the fallback model that choice actually resolves to:
//
//   1. the fallback id (`fallbackModel`) when known, otherwise an honest
//      "model not specified" — never "inherit"/"inherited";
//   2. every id the provider advertises, alphabetically (ui/model-order.ts), so
//      the same model sits in the same place on every tile;
//   3. the member's current id when it is not in the catalogue and is not the
//      fallback (a stale override or a frozen session's effective model), sorted
//      into place like any other id.
//
// Dedup rule: the fallback id is represented by option 0, so a catalogue entry
// with that exact id is skipped. That avoids two options with the same visible
// label; selecting option 0 is the revert-to-default action (the change payload
// stays '' and main.ts deletes the override). A current override that EQUALS the
// fallback is also represented by option 0, because the effective model is
// identical and an explicit same-as-default override is not a distinct choice.
//
// The visible control is just the select; its accessible name carries the agent,
// so a screen reader announces "Model for Summarizer" without adding a visible
// MODEL label above it.
const modelSelectFor = (name: string, title: string, models: AgentModelSelect): HTMLElement => {
    // A plain container, not a <label>: there is no visible label text to click.
    const row = el('div', 'agent-model');

    const select = el('select', 'agent-model-select field-select');
    select.setAttribute('aria-label', `Model for ${title}`);

    // The no-override option. Its value is '' (main.ts maps that to "delete the
    // override"); its LABEL is the resolved model, which is why "inherit" can never
    // appear in the UI.
    const fallback = models.fallbackModel?.trim() ?? '';
    const fallbackOption = el(
        'option',
        undefined,
        fallback.length > 0 ? fallback : UNKNOWN_MODEL_LABEL
    );
    fallbackOption.value = '';
    select.append(fallbackOption);

    const current = (models.models[name] ?? '').trim();
    // catalogue entries that are not the fallback; exact equality keeps ids that
    // differ only by case (providers can list both) as distinct choices.
    const catalogue = models.catalogue.filter((id) => id.length > 0 && id !== fallback);
    // Add the current override only when the catalogue omits it AND option 0 does
    // not already label it; sorting afterwards places it naturally, not at the tail.
    const needsCurrent = current.length > 0 && current !== fallback && !catalogue.includes(current);
    const ids = sortModelIds(needsCurrent ? [...catalogue, current] : catalogue);

    for (const id of ids) {
        const option = el('option', undefined, id);
        option.value = id;
        select.append(option);
    }

    // Choose the option that represents the EFFECTIVE model: the override when it
    // differs from the fallback, otherwise option 0 (the default). This keeps the
    // selected control truthful even when an explicit override equals the default.
    select.value = current.length > 0 && current !== fallback ? current : '';
    select.disabled = !models.editable || models.onChange === undefined;
    select.title = models.editable
        ? models.onChange === undefined
            ? 'Model editing is unavailable.'
            : models.session === true
              ? `Model for ${title}. Applies to the next request in this session.`
              : `Model for ${title}. Applies to future sessions.`
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
        // Exactly one human-readable name (the preset title). The slug is kept in
        // `data-agent` for the callbacks and tests but is never displayed, so a
        // tile reads "Summarizer", not "summarizer" + "Summarizer". The fallback
        // descriptor in detailsOf sets title = name when details are missing.
        const label = agent.title.trim().length > 0 ? agent.title : agent.name;

        main.title = isPrimary
            ? 'This agent is the primary (entry) agent.'
            : `Make ${label} the primary agent; ${options.primary} becomes a subagent.`;

        main.append(el('span', 'agent-tile-name', label));
        main.addEventListener('click', () => {
            if (!options.editable || isPrimary) return;
            options.onSelectPrimary(name);
        });

        const remove = el('button', 'agent-remove');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${label}`);
        // The last agent is the entry point: removing it would leave nothing to
        // run, so it is disabled rather than silently rejected.
        remove.disabled = !options.editable || options.members.length <= 1;
        remove.title =
            options.members.length <= 1 ? 'A harness needs at least one agent.' : `Remove ${label}`;
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
            label,
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

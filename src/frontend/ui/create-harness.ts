// The "create harness" form shown in the left rail.
//
// A harness is a team of existing preset agents, not a prompt editor. The form
// therefore asks only for identity (name/title) and composition:
//   - one ENTRY agent — the agent a new conversation starts with (routing, and
//     nothing more);
//   - any number of additional agents, each with its OWN RANK (R20). A rank is a
//     letter, A highest, and any number of agents may share one; an agent may
//     delegate only to a strictly LOWER rank.
//
// Naming rules mirror what the server can accept without guessing: a short slug
// that is unique in the catalogue. Everything else (title) has a usable default.
//
// Cross-references:
//   - src/frontend/contract.ts — the rank ladder helpers (`rankLabelOf`/`stepRank`)
//   - src/frontend/api.ts — POST /harnesses
//   - src/frontend/main.ts — mounts the panel, appends the returned descriptor
//   - src/frontend/styles.css — `.create-harness`, `.create-*`

import type { AgentRank } from '../../types';
import type { AgentDescriptor, CreateHarnessRequest } from '../../server/protocol';
import { HIGHEST_RANK, LOWEST_RANK, rankLabelOf, stepRank } from '../contract';

export type CreateHarnessOptions = {
    // Read on every open so a later bootstrap/refresh is reflected.
    agents: () => readonly AgentDescriptor[];
    existingNames: () => readonly string[];
    onCancel: () => void;
    // Rejects with a src/server/validation message; the panel prints it and stays
    // open so the draft is not lost.
    onSubmit: (request: CreateHarnessRequest) => Promise<void>;
};

export type CreateHarnessPanel = {
    element: HTMLElement;
    open: () => void;
    close: () => void;
    isOpen: () => boolean;
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

// The ONE visible label for a preset agent: its single-word display title (R5).
// R3: the slug (`AgentDescriptor.name`) is an internal id — it is the <option>
// value / chip `data-agent` and is never rendered. A descriptor with no title falls
// back to a neutral word so an id can never leak into the form.
const displayTitleOf = (agent: AgentDescriptor): string =>
    agent.title.trim().length > 0 ? agent.title : 'Agent';

// The server's name rule (src/harnesses/registry.ts): a letter first, then letters,
// digits, underscores or dashes, at most 64 characters. Mirrored so the user gets
// an immediate explanation instead of a round trip.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NAME_HINT =
    'Use a name that starts with a letter, then letters, digits, dashes or underscores (e.g. release-captain).';

export const createCreateHarnessPanel = (options: CreateHarnessOptions): CreateHarnessPanel => {
    const element = el('section', 'create-harness');
    element.hidden = true;
    element.setAttribute('aria-label', 'New harness');

    const form = el('form', 'create-form');

    const head = el('div', 'create-head');
    const heading = el('h2', 'create-title', 'New harness');
    heading.id = 'create-harness-title';
    const closeButton = el('button', 'icon-button', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close new harness form');
    head.append(heading, closeButton);

    // --- identity ---------------------------------------------------------
    const nameField = el('label', 'field');
    nameField.append(el('span', 'field-label', 'Name'));
    const nameInput = el('input', 'field-input create-name');
    nameInput.type = 'text';
    nameInput.required = true;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.maxLength = 64;
    nameInput.placeholder = 'release-captain';
    nameField.append(nameInput);

    const titleField = el('label', 'field');
    titleField.append(el('span', 'field-label', 'Title'));
    const titleInput = el('input', 'field-input create-title-input');
    titleInput.type = 'text';
    titleInput.autocomplete = 'off';
    titleInput.maxLength = 120;
    titleInput.placeholder = 'Release captain (defaults to the name)';
    titleField.append(titleInput);

    // --- composition (R20: one ENTRY agent + a RANK per member) -------------
    //
    // Two independent facts, and the form keeps them visibly separate:
    //   - `Entry agent` is the routing/seed choice — which agent a new conversation
    //     opens with. Exactly one, picked from the same catalogue.
    //   - Every member (the entry agent included) carries its OWN rank. The chip
    //     stepper assigns it per member, so ANY number of members may sit at Rank A:
    //     nothing here implies a single top agent, and the entry agent's rank is just
    //     another stepper.
    const entryField = el('label', 'field');
    entryField.append(el('span', 'field-label', 'Entry agent'));
    const entrySelect = el('select', 'field-input field-select create-entry');
    entryField.append(entrySelect);

    const teamLabel = el('div', 'create-label', 'Team (each agent keeps its own rank)');
    const addRow = el('div', 'create-add-row');
    const agentSelect = el('select', 'field-input field-select create-agent-select');
    const addAgentButton = el('button', 'button small create-agent-add', 'Add');
    addAgentButton.type = 'button';
    addRow.append(agentSelect, addAgentButton);

    const chosen = el('div', 'create-chosen');
    const hint = el(
        'p',
        'field-hint',
        'Only preset agents are selectable. Instructions and guidelines stay read-only. Rank sets who may delegate to whom: an agent may delegate only to a strictly LOWER rank, so Rank A leads and several agents may share any rank. The entry agent is only where a new conversation starts; it may hold any rank. Each agent starts on the session model — after creation, set a model per agent on its tile.'
    );

    const error = el('p', 'create-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const actions = el('div', 'create-actions');
    const cancelButton = el('button', 'button small create-cancel', 'Cancel');
    cancelButton.type = 'button';
    const submitButton = el('button', 'button primary small create-submit', 'Create harness');
    submitButton.type = 'submit';
    actions.append(cancelButton, submitButton);

    form.append(nameField, titleField, entryField, teamLabel, addRow, chosen, hint, error, actions);
    element.append(head, form);

    // The drafted team. `entry` is the routing agent and is always a member;
    // `added` holds the OTHER members in add order. Ranks are per member in `ranks`,
    // and the entry agent is stored there like anybody else — being the entry agent
    // says nothing about its rank.
    //
    // Defaults a fresh draft starts from (stated so the submit body is predictable):
    //   - the entry agent: Rank A, the conventional lead;
    //   - each agent added after it: Rank B, so the lead can delegate to it at once.
    // Both are editable with the chip stepper before the reader submits. Named because the
    // same two letters are written in four places, and the add-option label has to agree
    // with what the draft actually stores.
    const DEFAULT_ENTRY_RANK: AgentRank = HIGHEST_RANK;
    const DEFAULT_MEMBER_RANK: AgentRank = 'B';
    let entry = '';
    let added: string[] = [];
    const ranks = new Map<string, AgentRank>();
    let submitting = false;

    // The complete member set the request describes: entry first, then the added
    // agents in add order.
    const memberNames = (): string[] => (entry.length === 0 ? [...added] : [entry, ...added]);

    const rankFor = (name: string): AgentRank => ranks.get(name) ?? DEFAULT_ENTRY_RANK;

    // Title for a chosen member. Looks the descriptor up on every render (the
    // catalogue is a live accessor); a name the server no longer advertises still
    // reads a neutral word rather than its slug (R3).
    const titleFor = (name: string): string => {
        const agent = options.agents().find((candidate) => candidate.name === name);
        return agent === undefined ? 'Agent' : displayTitleOf(agent);
    };

    // One chip's rank stepper (R20): `−` raises the member one step of authority,
    // `+` lowers it. It mutates ONLY this member, so a team of three Rank A agents
    // is expressible and the stepper never claims to make anyone "the" leader.
    const rankStepperFor = (name: string): HTMLElement => {
        const row = el('div', 'create-chip-rank');
        row.dataset.agent = name;
        // The hook a test/inspector reads for the drafted rank of this member.
        row.dataset.rank = rankFor(name);

        const next = stepRank(rankFor(name), -1);
        const prev = stepRank(rankFor(name), 1);

        const raise = el('button', 'chip-rank-step chip-rank-raise', '−');
        raise.type = 'button';
        raise.setAttribute('aria-label', `Raise ${titleFor(name)} to ${rankLabelOf(next)}`);
        raise.title =
            rankFor(name) === HIGHEST_RANK
                ? `${rankLabelOf(HIGHEST_RANK)} is the highest rank.`
                : `Assign ${rankLabelOf(next)}.`;
        raise.disabled = rankFor(name) === HIGHEST_RANK || submitting;
        raise.addEventListener('click', () => {
            if (submitting) return;
            ranks.set(name, next);
            renderChosen();
        });

        const lower = el('button', 'chip-rank-step chip-rank-lower', '+');
        lower.type = 'button';
        lower.setAttribute('aria-label', `Lower ${titleFor(name)} to ${rankLabelOf(prev)}`);
        lower.title =
            rankFor(name) === LOWEST_RANK
                ? `${rankLabelOf(LOWEST_RANK)} is the lowest rank.`
                : `Assign ${rankLabelOf(prev)}.`;
        lower.disabled = rankFor(name) === LOWEST_RANK || submitting;
        lower.addEventListener('click', () => {
            if (submitting) return;
            ranks.set(name, prev);
            renderChosen();
        });

        row.append(raise, el('span', 'create-chip-rank-value', rankLabelOf(rankFor(name))), lower);

        return row;
    };

    const renderChosen = (): void => {
        chosen.replaceChildren();

        const names = memberNames();
        if (names.length === 0) {
            chosen.append(el('span', 'create-empty', 'No agents chosen yet.'));
            return;
        }

        for (const name of names) {
            const title = titleFor(name);
            const chip = el('span', 'create-chip');
            // The slug stays on the chip as data for tests/automation; the visible
            // text is the title only (R3). `data-entry` marks the one routing agent,
            // which is a routing fact and not a rank.
            chip.dataset.agent = name;
            if (name === entry) chip.dataset.entry = 'true';
            chip.append(
                el('span', 'create-chip-name', title),
                ...(name === entry ? [el('span', 'create-chip-flag', 'entry')] : [])
            );

            // The rank stepper is rendered for EVERY member, entry agent included.
            chip.append(rankStepperFor(name));

            // Only the added members are removable here: the entry agent leaves the
            // team by the entry select, which is the same single choice that put it
            // there.
            if (name !== entry) {
                const remove = el('button', 'chip-remove', '×');
                remove.type = 'button';
                remove.setAttribute('aria-label', `Remove ${title} from the new harness`);
                remove.disabled = submitting;
                remove.addEventListener('click', () => {
                    if (submitting) return;
                    added = added.filter((candidate) => candidate !== name);
                    ranks.delete(name);
                    renderChosen();
                    renderAgentOptions();
                });

                chip.append(remove);
            }

            chosen.append(chip);
        }
    };

    // Options for the "add agent" select: every preset except one that is already on
    // the team (the entry agent included). When nothing is left, the row is disabled
    // rather than offering a duplicate.
    const renderAgentOptions = (): void => {
        agentSelect.replaceChildren();

        const taken = new Set(memberNames());
        const available = options.agents().filter((agent) => !taken.has(agent.name));

        if (available.length === 0) {
            const empty = el('option', undefined, 'No agents left to add');
            empty.value = '';
            empty.disabled = true;
            agentSelect.append(empty);
            agentSelect.disabled = true;
            addAgentButton.disabled = true;
            return;
        }

        agentSelect.disabled = submitting;
        addAgentButton.disabled = submitting;

        for (const agent of available) {
            // R3/F4: the option text is the ONE-WORD display title; the slug stays the
            // option's value (what the form submits) and is never rendered.
            const option = el('option', undefined, `${displayTitleOf(agent)} · ${rankLabelOf(DEFAULT_MEMBER_RANK)}`);
            option.value = agent.name;
            option.title = `Adds ${displayTitleOf(agent)} at Rank B; the stepper on its chip changes that.`;
            agentSelect.append(option);
        }
    };

    // The entry select. Every catalogue agent can be the entry agent, whatever its
    // rank, and switching keeps the previous entry agent on the team ONLY if the
    // reader added it explicitly — exactly the old exclusion rule, restated for the
    // entry role.
    const renderEntryOptions = (): void => {
        const previous = entry;
        const names = options.agents().map((agent) => agent.name);
        // The entry agent is kept even when the catalogue stopped advertising it (a
        // draft the reader made from an agent that went away stays honest).
        const preferred = names.includes(previous) || previous.length > 0 ? previous : (names[0] ?? '');

        entrySelect.replaceChildren();

        for (const agent of options.agents()) {
            const option = el('option', undefined, displayTitleOf(agent));
            option.value = agent.name;
            option.title = 'The agent a new conversation starts with. Routing only — it does not change any rank.';
            entrySelect.append(option);
        }

        entrySelect.value = preferred;
        entry = preferred;

        if (entry.length > 0 && !ranks.has(entry)) ranks.set(entry, DEFAULT_ENTRY_RANK);

        renderAgentOptions();
        renderChosen();
    };

    entrySelect.addEventListener('change', () => {
        if (submitting) return;

        const next = entrySelect.value;
        if (next.length === 0 || next === entry) return;

        // The agent the reader just moved off the entry role stays a member only when
        // it was added explicitly; the entry select cannot leave a phantom member
        // behind, and a request can never list the same agent twice.
        added = added.filter((candidate) => candidate !== next);
        entry = next;
        if (!ranks.has(entry)) ranks.set(entry, DEFAULT_ENTRY_RANK);

        renderAgentOptions();
        renderChosen();
    });

    addAgentButton.addEventListener('click', () => {
        if (submitting) return;

        const name = agentSelect.value;
        if (name.length === 0 || memberNames().includes(name)) return;

        added = [...added, name];
        // A new member starts at Rank B (the rank the lead can delegate to); the chip
        // stepper is what makes that explicit rather than leaving it implied.
        if (!ranks.has(name)) ranks.set(name, DEFAULT_MEMBER_RANK);

        renderAgentOptions();
        renderChosen();
    });

    const setError = (message?: string): void => {
        error.hidden = message === undefined;
        error.textContent = message ?? '';
    };

    const setSubmitting = (value: boolean): void => {
        submitting = value;
        submitButton.disabled = value;
        submitButton.textContent = value ? 'Creating…' : 'Create harness';
        nameInput.disabled = value;
        titleInput.disabled = value;
        entrySelect.disabled = value;
        agentSelect.disabled = value;
        addAgentButton.disabled = value;
        // The steppers live inside the chips, which are rebuilt from `submitting` so
        // a draft cannot move underneath an in-flight POST.
        renderChosen();
    };

    const reset = (): void => {
        nameInput.value = '';
        titleInput.value = '';
        added = [];
        ranks.clear();
        setError();
        setSubmitting(false);
        renderEntryOptions();
    };

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (submitting) return;

        const name = nameInput.value.trim();
        const title = titleInput.value.trim();

        if (!NAME_PATTERN.test(name)) {
            setError(NAME_HINT);
            nameInput.focus();
            return;
        }

        // The registry rejects names case-insensitively; mirror that so the user
        // does not learn it from a round trip.
        if (options.existingNames().some((existing) => existing.toLowerCase() === name.toLowerCase())) {
            setError(`A harness named "${name}" already exists.`);
            nameInput.focus();
            return;
        }

        if (entry.length === 0) {
            setError('Choose the entry agent.');
            return;
        }

        // R20 request shape (../shared/harness-api.ts `CreateHarnessRequest`): `agents` is the
        // roster in DECLARATION ORDER with the entry agent first, `entry` names the routing member
        // and `ranks` states one letter per member, entry included. Any number of members may share
        // a rank, and the entry agent's letter is just its rank — there is no `primary`/`subagents`
        // pair on the wire any more. The roster is sent explicitly rather than left to the server's
        // "first entry of `agents`" default so the form never depends on that fallback.
        const requestRanks: Record<string, AgentRank> = {};
        for (const member of memberNames()) requestRanks[member] = rankFor(member);

        const request: CreateHarnessRequest = {
            name,
            title: title.length > 0 ? title : name,
            agents: memberNames(),
            entry,
            ranks: requestRanks
        };

        setError();
        setSubmitting(true);

        void options.onSubmit(request).then(
            () => {
                setSubmitting(false);
                reset();
                close();
            },
            (failure: unknown) => {
                setSubmitting(false);
                setError(failure instanceof Error ? failure.message : String(failure));
            }
        );
    });

    const open = (): void => {
        reset();
        renderEntryOptions();
        element.hidden = false;
        nameInput.focus();
    };

    const close = (): void => {
        element.hidden = true;
        options.onCancel();
    };

    closeButton.addEventListener('click', close);
    cancelButton.addEventListener('click', close);
    element.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
    });

    return {
        element,
        open,
        close,
        isOpen: () => !element.hidden
    };
};

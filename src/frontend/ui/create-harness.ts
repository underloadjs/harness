// The "create harness" form shown in the left rail.
//
// A harness is a team of existing preset agents, not a prompt editor. The form
// therefore asks only for identity (name/title) and composition:
//   - one initial primary agent (the entry point);
//   - any number of additional agents, added as secondaries.
//
// Naming rules mirror what the server can accept without guessing: a short slug
// that is unique in the catalogue. Everything else (title) has a usable default.
//
// Cross-references:
//   - src/frontend/api.ts — POST /harnesses
//   - src/frontend/main.ts — mounts the panel, appends the returned descriptor
//   - src/frontend/styles.css — `.create-harness`, `.create-*`

import type { AgentDescriptor, CreateHarnessRequest } from '../../server/protocol';

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

    // --- composition ------------------------------------------------------
    const primaryField = el('label', 'field');
    primaryField.append(el('span', 'field-label', 'Primary agent'));
    const primarySelect = el('select', 'field-input field-select create-primary');
    primaryField.append(primarySelect);

    const secondaryLabel = el('div', 'create-label', 'Additional agents (secondaries)');
    const addRow = el('div', 'create-add-row');
    const secondarySelect = el('select', 'field-input field-select create-agent-select');
    const addAgentButton = el('button', 'button small create-agent-add', 'Add');
    addAgentButton.type = 'button';
    addRow.append(secondarySelect, addAgentButton);

    const chosen = el('div', 'create-chosen');
    const hint = el(
        'p',
        'field-hint',
        'Only preset agents are selectable. Instructions and guidelines stay read-only; the primary agent may delegate to the others. Each agent starts on the session model — after creation, set a model per agent on its tile.'
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

    form.append(nameField, titleField, primaryField, secondaryLabel, addRow, chosen, hint, error, actions);
    element.append(head, form);

    // Selected secondaries, in add order. The primary is always excluded by
    // construction so a request can never contain the same agent twice.
    let secondaries: string[] = [];
    let submitting = false;

    const chosenNames = (): string[] =>
        secondaries.filter((name) => name !== primarySelect.value && name.length > 0);

    const renderChosen = (): void => {
        chosen.replaceChildren();

        const names = chosenNames();
        if (names.length === 0) {
            chosen.append(el('span', 'create-empty', 'No additional agents. The harness will have one agent.'));
            return;
        }

        for (const name of names) {
            const chip = el('span', 'create-chip');
            chip.append(el('span', 'create-chip-name', name));

            const remove = el('button', 'chip-remove', '×');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${name} from the new harness`);
            remove.addEventListener('click', () => {
                secondaries = secondaries.filter((candidate) => candidate !== name);
                renderChosen();
                renderSecondaryOptions();
            });

            chip.append(remove);
            chosen.append(chip);
        }
    };

    // Options for the "add secondary" select: every preset except the primary and
    // anything already chosen. When nothing is left, the row is disabled rather
    // than offering a duplicate.
    const renderSecondaryOptions = (): void => {
        secondarySelect.replaceChildren();

        const taken = new Set([primarySelect.value, ...chosenNames()]);
        const available = options.agents().filter((agent) => !taken.has(agent.name));

        if (available.length === 0) {
            const empty = el('option', undefined, 'No agents left to add');
            empty.value = '';
            empty.disabled = true;
            secondarySelect.append(empty);
            secondarySelect.disabled = true;
            addAgentButton.disabled = true;
            return;
        }

        secondarySelect.disabled = false;
        addAgentButton.disabled = false;

        for (const agent of available) {
            const option = el('option', undefined, `${agent.name} — ${agent.title}`);
            option.value = agent.name;
            secondarySelect.append(option);
        }
    };

    const renderPrimaryOptions = (): void => {
        const current = primarySelect.value;
        primarySelect.replaceChildren();

        for (const agent of options.agents()) {
            const option = el('option', undefined, `${agent.name} — ${agent.title}`);
            option.value = agent.name;
            primarySelect.append(option);
        }

        const names = options.agents().map((agent) => agent.name);
        const preferred = names.includes(current) ? current : (names[0] ?? '');
        primarySelect.value = preferred;
        // A demoted primary stays on the team as a secondary only if the user had
        // explicitly added it; otherwise it simply drops out of `secondaries`.
        secondaries = secondaries.filter((name) => name !== preferred);
        renderSecondaryOptions();
        renderChosen();
    };

    primarySelect.addEventListener('change', () => {
        // Selecting a different primary removes it from the secondary list so the
        // request cannot contain the same agent twice.
        secondaries = secondaries.filter((name) => name !== primarySelect.value);
        renderSecondaryOptions();
        renderChosen();
    });

    addAgentButton.addEventListener('click', () => {
        const name = secondarySelect.value;
        if (name.length === 0 || chosenNames().includes(name) || name === primarySelect.value) return;

        secondaries = [...secondaries, name];
        renderSecondaryOptions();
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
        primarySelect.disabled = value;
        secondarySelect.disabled = value;
        addAgentButton.disabled = value;
    };

    const reset = (): void => {
        nameInput.value = '';
        titleInput.value = '';
        secondaries = [];
        setError();
        setSubmitting(false);
        renderPrimaryOptions();
    };

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (submitting) return;

        const name = nameInput.value.trim();
        const title = titleInput.value.trim();
        const primary = primarySelect.value;

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

        if (primary.length === 0) {
            setError('Choose a primary agent.');
            return;
        }

        const request: CreateHarnessRequest = {
            name,
            title: title.length > 0 ? title : name,
            primary,
            subagents: chosenNames()
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
        renderPrimaryOptions();
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

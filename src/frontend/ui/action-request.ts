// Interactive actionRequest card (N3 / A1).
//
// One card per `action_request` event. The card is the ONLY place a human can
// answer a model's bounded question, and the only place a fork/autoanswer child
// request is shown read-only:
//
//   - ROOT requests (no `thread`) are interactive: the recommended option is
//     highlighted first, every alternative follows it, and a free-text ("custom")
//     answer is ALWAYS available (the frozen request contract sets allowCustom).
//   - NON-ROOT requests (thread.kind delegation/fork/autoanswer) are read-only.
//     The immediate owner fork answers them automatically, so human buttons here
//     would invite an answer that can never be sent. The card still reports the
//     question and its pending/resolved state.
//
// Interaction rules:
//   - selecting a recommendation is NEVER automatic; the user must select a radio
//     (or type custom text) and press Answer explicitly;
//   - while the POST is in flight every control is disabled ("submitting");
//   - a failure is recoverable: the chosen option and the custom text are kept,
//     the error is shown, and the controls are enabled again;
//   - `setAnswer` is the authoritative update from an `action_answer` event (the
//     source may be 'owner' or 'auto') and always wins over local guessing;
//   - `setExpired` is terminal (turn cancelled/failed/done, or a session switch):
//     the controls are disabled and the reason is shown. An answered card never
//     regresses to expired.
//
// Styling lives in src/frontend/styles.css (`.action-request`, `.action-option`,
// `.action-custom`, `.action-status`, `.action-error`). This module owns only the
// DOM and state; networking/routing is the turn board's answer callback.

import type { HarnessActionAnswer, HarnessActionChoice, HarnessActionRequest } from '../../types';

export type ActionCardState = 'pending' | 'submitting' | 'answered' | 'expired' | 'error';

export type ActionRequestCard = {
    element: HTMLElement;
    requestId: string;
    state: () => ActionCardState;
    // Authoritative answer from an action_answer event (owner or auto). Applies to
    // expired/submitting cards too: the record is newer than any local projection.
    setAnswer: (answer: HarnessActionAnswer) => void;
    // Terminal, recoverable-in-DOM state. The card keeps the question visible.
    setExpired: (reason: string) => void;
    destroy: () => void;
};

export type ActionRequestCardOptions = {
    request: HarnessActionRequest;
    // Root request = human-interactive. Non-root (autoanswer/fork child) = read-only.
    interactive: boolean;
    // Initial authoritative answer (a replayed action_answer) or expiry (a settled
    // historical turn). Both are optional; a live pending root request has neither.
    answer?: HarnessActionAnswer;
    expired?: string;
    // Sends the human choice. Undefined for a read-only card or when the page has no
    // routing callback; submission then reports a recoverable local error.
    onAnswer?: (choice: HarnessActionChoice) => Promise<void>;
};

// Human-readable text for an answer. Option ids resolve to their label; an id
// that is not in the request (a server-side legacy answer) falls back to the raw
// id so the card never claims a different option. Custom answers are verbatim.
export const actionChoiceText = (request: HarnessActionRequest, choice: HarnessActionChoice): string => {
    if (choice.kind === 'custom') return choice.text;

    const option = request.options.find((candidate) => candidate.id === choice.optionId);
    return option?.label ?? choice.optionId;
};

// Unique DOM ids. A module counter is enough: one document.
let nextId = 0;

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

// Recommended option first; alternatives keep the request's order. The server
// guarantees `recommended` names an option, but a malformed/legacy payload must
// still render: then nothing is highlighted and the original order is kept.
const orderedOptions = (request: HarnessActionRequest) => {
    const recommended = request.options.find((option) => option.id === request.recommended);
    const alternatives = request.options.filter((option) => option.id !== request.recommended);

    return recommended === undefined
        ? { recommended: undefined, options: request.options }
        : { recommended, options: [recommended, ...alternatives] };
};

export const createActionRequestCard = (options: ActionRequestCardOptions): ActionRequestCard => {
    const { request } = options;
    const cardId = `action-${++nextId}`;
    const questionId = `${cardId}-question`;
    const customId = `${cardId}-custom`;
    const radioName = `${cardId}-choice`;

    const root = el('section', 'action-request');
    root.dataset.requestId = request.requestId;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-labelledby', questionId);

    const question = el('p', 'action-question', request.question);
    question.id = questionId;
    root.append(question);

    // Non-root requests are answered by the owner's automatic fork; make that
    // provenance explicit without exposing agent ids or branch internals.
    if (!options.interactive) {
        root.dataset.readonly = 'true';
        root.append(el('p', 'action-note', 'Auto-answered by the owner fork.'));
    }

    const { recommended, options: ordered } = orderedOptions(request);

    // Read-only rendering: static option list, recommended first and labelled.
    // No radios, textarea or submit button, because a human answer cannot be sent.
    if (!options.interactive) {
        const list = el('ul', 'action-options action-options-static');
        for (const option of ordered) {
            const item = el('li', 'action-option-static');
            if (option.id === recommended?.id) item.dataset.recommended = 'true';
            item.append(el('span', 'action-option-label', option.label));
            if (option.id === recommended?.id) item.append(el('span', 'action-recommended', 'Recommended'));
            if (option.description !== undefined) {
                item.append(el('span', 'action-option-description', option.description));
            }
            list.append(item);
        }
        root.append(list);
    }

    const optionsHost = options.interactive ? el('div', 'action-options') : undefined;
    optionsHost?.setAttribute('role', 'radiogroup');
    optionsHost?.setAttribute('aria-labelledby', questionId);

    // One radio per option (+ the always-present custom path). The label wraps the
    // whole row, so clicking the text selects it; the radio input is a real radio
    // for keyboard/assistive use.
    const radios: Array<{ optionId: string; input: HTMLInputElement }> = [];
    if (optionsHost !== undefined) {
        for (const option of ordered) {
            const label = el('label', 'action-option');
            if (option.id === recommended?.id) label.dataset.recommended = 'true';

            const input = el('input', 'action-radio');
            input.type = 'radio';
            input.name = radioName;
            input.value = option.id;
            input.id = `${cardId}-${option.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

            const body = el('span', 'action-option-body');
            const line = el('span', 'action-option-line');
            line.append(el('span', 'action-option-label', option.label));
            if (option.id === recommended?.id) line.append(el('span', 'action-recommended', 'Recommended'));
            body.append(line);
            if (option.description !== undefined) {
                body.append(el('span', 'action-option-description', option.description));
            }

            label.append(input, body);
            optionsHost.append(label);
            radios.push({ optionId: option.id, input });
        }

        // ALWAYS custom: the free-text path is part of the frozen contract, not an
        // optional extra, so it is rendered even when every option is offered.
        const customLabel = el('label', 'action-option action-custom');
        const customRadio = el('input', 'action-radio');
        customRadio.type = 'radio';
        customRadio.name = radioName;
        customRadio.value = '__custom';
        customRadio.id = customId;
        const customBody = el('span', 'action-option-body');
        customBody.append(el('span', 'action-option-label', 'Your own answer'));
        customLabel.append(customRadio, customBody);
        optionsHost.append(customLabel);
        radios.push({ optionId: '__custom', input: customRadio });

        const customInput = el('textarea', 'action-custom-input');
        customInput.id = `${customId}-text`;
        customInput.rows = 2;
        customInput.placeholder = 'Type a custom answer';
        customInput.setAttribute('aria-label', 'Custom answer');
        optionsHost.append(customInput);

        root.append(optionsHost);

        const controls = el('div', 'action-controls');
        const submit = el('button', 'button primary action-submit', 'Answer');
        submit.type = 'button';
        const status = el('span', 'action-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const error = el('p', 'action-error');
        error.hidden = true;
        error.setAttribute('role', 'alert');
        controls.append(submit, status);
        root.append(controls, error);

        // --- card state ---------------------------------------------------
        let state: ActionCardState = 'pending';
        let selected: string | undefined;

        const allInputs = (): HTMLInputElement[] => radios.map((radio) => radio.input);
        const customSelected = (): boolean => selected === '__custom';
        const hasChoice = (): boolean =>
            selected === '__custom'
                ? customInput.value.trim().length > 0
                : selected !== undefined;

        const paint = (): void => {
            root.dataset.state = state;
            const locked = state !== 'pending' && state !== 'error';
            for (const input of allInputs()) input.disabled = locked;
            customInput.disabled = locked || !customSelected();
            submit.hidden = state === 'answered' || state === 'expired';
            submit.disabled = locked || !hasChoice();
            submit.textContent = state === 'submitting' ? 'Sending…' : 'Answer';
        };

        const choose = (value: string): void => {
            if (state !== 'pending' && state !== 'error') return;
            selected = value;
            for (const radio of radios) radio.input.checked = radio.optionId === value;
            if (state === 'error') state = 'pending';
            error.hidden = true;
            paint();
        };

        for (const radio of radios) {
            radio.input.addEventListener('change', () => {
                if (!radio.input.checked) return;
                choose(radio.optionId);
                if (radio.optionId === '__custom') customInput.focus();
            });
        }

        // Typing is itself a selection: the user should not have to click the
        // custom radio first. The text stays when they go back to an option so a
        // failed submit can be retried without retyping.
        customInput.addEventListener('input', () => {
            if (state === 'answered' || state === 'expired' || state === 'submitting') return;
            if (!customSelected()) {
                selected = '__custom';
                for (const radio of radios) radio.input.checked = radio.optionId === '__custom';
            }
            if (state === 'error') state = 'pending';
            error.hidden = true;
            paint();
        });

        const buildChoice = (): HarnessActionChoice | undefined => {
            if (selected === undefined) return undefined;
            if (selected === '__custom') {
                const text = customInput.value.trim();
                return text.length === 0 ? undefined : { kind: 'custom', text };
            }

            return { kind: 'option', optionId: selected };
        };

        submit.addEventListener('click', () => {
            if (state !== 'pending' && state !== 'error') return;

            const choice = buildChoice();
            if (choice === undefined) return;

            if (options.onAnswer === undefined) {
                state = 'error';
                error.textContent = 'This page cannot send an answer; reload and try again.';
                error.hidden = false;
                paint();
                return;
            }

            state = 'submitting';
            error.hidden = true;
            paint();

            void options
                .onAnswer(choice)
                .then(() => {
                    // The action_answer event may already have settled the card (it
                    // is authoritative, including an automatic answer). Only a card
                    // still in flight is completed from the successful POST.
                    if (state !== 'submitting') return;
                    state = 'answered';
                    status.textContent = `Answered: ${actionChoiceText(request, choice)}`;
                    paint();
                })
                .catch((cause: unknown) => {
                    // A turn/session expiry during the round trip is terminal; the
                    // failure must not reopen controls the board already disabled.
                    if (state !== 'submitting') return;

                    state = 'error';
                    error.textContent = `Could not send the answer: ${
                        cause instanceof Error ? cause.message : String(cause)
                    }`;
                    error.hidden = false;
                    // Keep the user's choice/text; only the status line changes.
                    paint();
                });
        });

        // --- authoritative updates ---------------------------------------
        const setAnswer = (answer: HarnessActionAnswer): void => {
            state = 'answered';
            selected =
                answer.choice.kind === 'option'
                    ? answer.choice.optionId
                    : '__custom';
            if (answer.choice.kind === 'custom') customInput.value = answer.choice.text;
            for (const radio of radios) radio.input.checked = radio.optionId === selected;
            const prefix = answer.source === 'auto' ? 'Auto-answered' : 'Answered';
            status.textContent = `${prefix}: ${actionChoiceText(request, answer.choice)}`;
            error.hidden = true;
            paint();
        };

        const setExpired = (reason: string): void => {
            if (state === 'answered') return;
            state = 'expired';
            status.textContent = reason;
            error.hidden = true;
            paint();
        };

        const applyInitial = (): void => {
            if (options.answer !== undefined) {
                setAnswer(options.answer);
                return;
            }
            if (options.expired !== undefined) {
                setExpired(options.expired);
                return;
            }
            status.textContent = 'Choose an answer, then press Answer.';
            paint();
        };

        applyInitial();

        return {
            element: root,
            requestId: request.requestId,
            state: () => state,
            setAnswer,
            setExpired,
            destroy: (): void => {
                root.remove();
            }
        };
    }

    // Read-only cards share the same status surface, minus every control.
    const status = el('span', 'action-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.append(status);

    let state: ActionCardState = 'pending';
    const paint = (): void => {
        root.dataset.state = state;
    };

    const setAnswer = (answer: HarnessActionAnswer): void => {
        state = 'answered';
        const prefix = answer.source === 'auto' ? 'Auto-answered' : 'Answered';
        status.textContent = `${prefix}: ${actionChoiceText(request, answer.choice)}`;
        paint();
    };

    const setExpired = (reason: string): void => {
        if (state === 'answered') return;
        state = 'expired';
        status.textContent = reason;
        paint();
    };

    if (options.answer !== undefined) setAnswer(options.answer);
    else if (options.expired !== undefined) setExpired(options.expired);
    else {
        status.textContent = 'Waiting for the automatic owner answer…';
        paint();
    }

    return {
        element: root,
        requestId: request.requestId,
        state: () => state,
        setAnswer,
        setExpired,
        destroy: (): void => {
            root.remove();
        }
    };
};

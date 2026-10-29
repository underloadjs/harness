// actionRequest card (N3 / A1).
//
// Pins the human half of the frozen interaction contract:
//   - recommended option is rendered FIRST and labelled; alternatives follow;
//   - a custom text path is ALWAYS present;
//   - selecting a recommendation does not submit: the Answer button is explicit;
//   - submitting disables the controls, a failure is recoverable and preserves the
//     user's choice/text, and success/`action_answer` produce an answered state;
//   - a non-root (autoanswer/fork) request is read-only with no human buttons;
//   - expiry is terminal and an authoritative answer still wins.

import type { HarnessActionAnswer, HarnessActionRequest } from '../../types';
import { actionChoiceText, createActionRequestCard } from './action-request';

const request = (overrides: Partial<HarnessActionRequest> = {}): HarnessActionRequest => ({
    requestId: 'req-1',
    question: 'Which file should I read?',
    recommended: 'b',
    options: [
        { id: 'a', label: 'Alpha', description: 'the first option' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' }
    ],
    allowCustom: true,
    ...overrides
});

const optionTexts = (root: HTMLElement): string[] => [
    ...root.querySelectorAll<HTMLElement>('.action-option-label')
].map((node) => node.textContent ?? '');

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('actionChoiceText', () => {
    it('resolves option ids to their label and keeps custom text verbatim', () => {
        expect(actionChoiceText(request(), { kind: 'option', optionId: 'b' })).toBe('Beta');
        expect(actionChoiceText(request(), { kind: 'custom', text: 'read package.json' })).toBe(
            'read package.json'
        );
        // A legacy answer naming an option this request no longer carries must not
        // be relabelled as a different choice.
        expect(actionChoiceText(request(), { kind: 'option', optionId: 'gone' })).toBe('gone');
    });
});

describe('createActionRequestCard (interactive root)', () => {
    it('renders the recommendation first, alternatives after, and always custom', () => {
        const card = createActionRequestCard({ request: request(), interactive: true });
        const root = card.element;

        expect(root.dataset.state).toBe('pending');
        expect(optionTexts(root)).toEqual(['Beta', 'Alpha', 'Gamma', 'Your own answer']);
        expect(root.querySelectorAll('.action-radio')).toHaveLength(4);
        expect(root.querySelector('.action-custom-input')).not.toBeNull();

        const options = [...root.querySelectorAll<HTMLElement>('.action-option')];
        expect(options[0].dataset.recommended).toBe('true');
        expect(options[1].dataset.recommended).toBeUndefined();
        expect(options[0].querySelector('.action-recommended')?.textContent).toBe('Recommended');

        const submit = root.querySelector<HTMLButtonElement>('.action-submit');
        expect(submit?.disabled).toBe(true);
        // Custom text is present but only enabled after choosing the custom path.
        expect(root.querySelector<HTMLTextAreaElement>('.action-custom-input')?.disabled).toBe(true);
        expect(root.querySelector('.action-status')?.textContent).toBe(
            'Choose an answer, then press Answer.'
        );
    });

    it('requires an explicit submit and sends the selected option', async () => {
        const sent: unknown[] = [];
        const card = createActionRequestCard({
            request: request(),
            interactive: true,
            onAnswer: async (choice) => {
                sent.push(choice);
            }
        });
        const root = card.element;
        document.body.replaceChildren(root);

        const beta = root.querySelector<HTMLInputElement>('input[value="b"]');
        beta?.click();
        // Selecting alone must NOT answer automatically.
        expect(sent).toEqual([]);
        expect(card.state()).toBe('pending');

        const submit = root.querySelector<HTMLButtonElement>('.action-submit');
        expect(submit?.disabled).toBe(false);
        submit?.click();

        expect(card.state()).toBe('submitting');
        expect(root.dataset.state).toBe('submitting');
        expect(root.querySelector<HTMLInputElement>('input[value="b"]')?.disabled).toBe(true);
        expect(submit?.disabled).toBe(true);

        await flush();

        expect(sent).toEqual([{ kind: 'option', optionId: 'b' }]);
        expect(card.state()).toBe('answered');
        expect(root.querySelector('.action-status')?.textContent).toBe('Answered: Beta');
        expect(root.querySelector<HTMLButtonElement>('.action-submit')?.hidden).toBe(true);
    });

    it('sends custom text and keeps it after a recoverable failure', async () => {
        const attempts: unknown[] = [];
        let fail = true;
        const card = createActionRequestCard({
            request: request(),
            interactive: true,
            onAnswer: async (choice) => {
                attempts.push(choice);
                if (fail) throw new Error('network down');
            }
        });
        const root = card.element;

        const custom = root.querySelector<HTMLTextAreaElement>('.action-custom-input');
        expect(custom).not.toBeNull();
        custom!.value = 'read the docs';
        custom!.dispatchEvent(new Event('input'));

        expect(root.querySelector<HTMLInputElement>('input[value="__custom"]')?.checked).toBe(true);
        expect(custom!.disabled).toBe(false);

        root.querySelector<HTMLButtonElement>('.action-submit')?.click();
        await flush();

        expect(attempts).toEqual([{ kind: 'custom', text: 'read the docs' }]);
        expect(card.state()).toBe('error');
        expect(root.querySelector('.action-error')?.textContent).toBe(
            'Could not send the answer: network down'
        );
        // The user's input survives the failure and the controls are usable again.
        expect(custom!.value).toBe('read the docs');
        expect(custom!.disabled).toBe(false);
        expect(root.querySelector<HTMLButtonElement>('.action-submit')?.disabled).toBe(false);

        fail = false;
        root.querySelector<HTMLButtonElement>('.action-submit')?.click();
        await flush();

        expect(attempts).toEqual([
            { kind: 'custom', text: 'read the docs' },
            { kind: 'custom', text: 'read the docs' }
        ]);
        expect(card.state()).toBe('answered');
        expect(root.querySelector('.action-status')?.textContent).toBe('Answered: read the docs');
    });

    it('accepts the authoritative automatic answer', () => {
        const card = createActionRequestCard({ request: request(), interactive: true });
        const answer: HarnessActionAnswer = {
            requestId: 'req-1',
            choice: { kind: 'option', optionId: 'a' },
            source: 'auto',
            branchId: 'branch-9'
        };

        card.setAnswer(answer);

        expect(card.state()).toBe('answered');
        expect(card.element.querySelector('.action-status')?.textContent).toBe('Auto-answered: Alpha');
        expect(card.element.querySelector<HTMLInputElement>('input[value="a"]')?.checked).toBe(true);
        expect(card.element.querySelector<HTMLInputElement>('input[value="a"]')?.disabled).toBe(true);
    });

    it('expires controls, but a later authoritative answer still wins', () => {
        const card = createActionRequestCard({ request: request(), interactive: true });
        const root = card.element;

        card.setExpired('This question expired when the turn ended.');

        expect(card.state()).toBe('expired');
        expect(root.dataset.state).toBe('expired');
        expect(root.querySelector('.action-status')?.textContent).toBe(
            'This question expired when the turn ended.'
        );
        expect(root.querySelector<HTMLInputElement>('input[value="b"]')?.disabled).toBe(true);
        expect(root.querySelector<HTMLTextAreaElement>('.action-custom-input')?.disabled).toBe(true);
        expect(root.querySelector<HTMLButtonElement>('.action-submit')?.hidden).toBe(true);

        card.setAnswer({
            requestId: 'req-1',
            choice: { kind: 'custom', text: 'late answer' },
            source: 'owner'
        });
        expect(card.state()).toBe('answered');
        expect(root.querySelector('.action-status')?.textContent).toBe('Answered: late answer');
    });
});

describe('createActionRequestCard (read-only child)', () => {
    it('renders a static recommended list with no human controls', () => {
        const card = createActionRequestCard({ request: request(), interactive: false });
        const root = card.element;

        expect(root.dataset.readonly).toBe('true');
        expect(root.querySelector('.action-radio')).toBeNull();
        expect(root.querySelector('.action-custom-input')).toBeNull();
        expect(root.querySelector('.action-submit')).toBeNull();
        expect(optionTexts(root)).toEqual(['Beta', 'Alpha', 'Gamma']);
        expect(root.querySelector('.action-note')?.textContent).toBe('Auto-answered by the owner fork.');
        expect(root.querySelector('.action-status')?.textContent).toBe(
            'Waiting for the automatic owner answer…'
        );
    });

    it('shows an automatic answer as resolved', () => {
        const card = createActionRequestCard({ request: request(), interactive: false });
        card.setAnswer({
            requestId: 'req-1',
            choice: { kind: 'option', optionId: 'c' },
            source: 'auto',
            branchId: 'branch-1'
        });

        expect(card.state()).toBe('answered');
        expect(card.element.querySelector('.action-status')?.textContent).toBe('Auto-answered: Gamma');
    });
});

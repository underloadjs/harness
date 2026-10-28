// Create-harness form: identity validation, primary choice, secondary chips and
// the exact POST body. The server owns the final descriptor; this component owns
// only what a user can express: a unique slug, a title and a team of presets.

import type { AgentDescriptor } from '../contract';
import { createCreateHarnessPanel } from './create-harness';
import type { CreateHarnessPanel } from './create-harness';

const agents: AgentDescriptor[] = [
    { name: 'instruct', title: 'Instruct', description: '', instruction: '', guidelines: [] },
    { name: 'summarizer', title: 'Summarizer', description: '', instruction: '', guidelines: [] },
    { name: 'workspace', title: 'Workspace', description: '', instruction: '', guidelines: [] }
];

const tick = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const mount = (onSubmit = vi.fn(async () => undefined)) => {
    const onCancel = vi.fn();
    const panel: CreateHarnessPanel = createCreateHarnessPanel({
        agents: () => agents,
        existingNames: () => ['instruct'],
        onCancel,
        onSubmit
    });

    document.body.replaceChildren(panel.element);
    panel.open();
    return { panel, onSubmit, onCancel };
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

const submit = (): void => {
    byClass('.create-form', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

describe('createCreateHarnessPanel', () => {
    it('opens with the first preset as primary and one-agent empty state', () => {
        const { panel } = mount();

        expect(panel.isOpen()).toBe(true);
        expect(byClass('.create-primary', 'select').value).toBe('instruct');
        expect(document.querySelector('.create-empty')?.textContent).toBe(
            'No additional agents. The harness will have one agent.'
        );
        expect(byClass('.create-agent-select', 'select').disabled).toBe(false);
    });

    it('rejects an invalid or duplicate name before calling the server', async () => {
        const { onSubmit } = mount();

        submit();
        expect(byClass('.create-error', 'p').textContent).toBe(
            'Use a name that starts with a letter, then letters, digits, dashes or underscores (e.g. release-captain).'
        );

        byClass('.create-name', 'input').value = '9lives';
        submit();
        expect(byClass('.create-error', 'p').textContent).toBe(
            'Use a name that starts with a letter, then letters, digits, dashes or underscores (e.g. release-captain).'
        );

        byClass('.create-name', 'input').value = 'instruct';
        submit();
        expect(byClass('.create-error', 'p').textContent).toBe('A harness named "instruct" already exists.');
        expect(onSubmit).not.toHaveBeenCalled();
        await tick();
    });

    it('submits the exact name, title, primary and secondary list', async () => {
        const { panel, onSubmit, onCancel } = mount();

        byClass('.create-name', 'input').value = 'release-captain';
        // An empty title defaults to the name: the request always has a title.
        byClass('.create-title-input', 'input').value = '';

        const primary = byClass('.create-primary', 'select');
        primary.value = 'workspace';
        primary.dispatchEvent(new Event('change', { bubbles: true }));
        // The primary can never be added as its own secondary.
        expect([...byClass('.create-agent-select', 'select').options].map((option) => option.value)).toEqual([
            'instruct',
            'summarizer'
        ]);

        const secondary = byClass('.create-agent-select', 'select');
        secondary.value = 'summarizer';
        byClass('.create-agent-add', 'button').click();
        expect([...document.querySelectorAll('.create-chip-name')].map((chip) => chip.textContent)).toEqual([
            'summarizer'
        ]);

        submit();
        await tick();

        expect(onSubmit).toHaveBeenCalledWith({
            name: 'release-captain',
            title: 'release-captain',
            primary: 'workspace',
            subagents: ['summarizer']
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(panel.isOpen()).toBe(false);
        // The form is reset for the next harness.
        expect(byClass('.create-name', 'input').value).toBe('');
        expect(document.querySelectorAll('.create-chip')).toHaveLength(0);
    });

    it('removes a chosen secondary and demotes a changed primary out of the list', () => {
        const { panel } = mount();

        byClass('.create-name', 'input').value = 'triage';
        byClass('.create-agent-select', 'select').value = 'summarizer';
        byClass('.create-agent-add', 'button').click();

        const chipRemove = byClass('.chip-remove', 'button');
        chipRemove.click();
        expect(document.querySelectorAll('.create-chip')).toHaveLength(0);

        // Choosing a new primary drops it from the secondary list if it was there.
        byClass('.create-agent-select', 'select').value = 'summarizer';
        byClass('.create-agent-add', 'button').click();
        const primary = byClass('.create-primary', 'select');
        primary.value = 'summarizer';
        primary.dispatchEvent(new Event('change', { bubbles: true }));

        expect(document.querySelectorAll('.create-chip')).toHaveLength(0);
        expect([...byClass('.create-agent-select', 'select').options].map((option) => option.value)).toEqual([
            'instruct',
            'workspace'
        ]);
        expect(panel.isOpen()).toBe(true);
    });

    it('keeps the draft open and shows the server error when creation fails', async () => {
        const onSubmit = vi.fn(async () => {
            throw new Error('Harness "triage" already exists.');
        });
        const { panel } = mount(onSubmit);

        byClass('.create-name', 'input').value = 'triage';
        submit();
        await tick();
        await tick();

        expect(byClass('.create-error', 'p').textContent).toBe('Harness "triage" already exists.');
        expect(panel.isOpen()).toBe(true);
        expect(byClass('.create-submit', 'button').disabled).toBe(false);
        expect(byClass('.create-name', 'input').value).toBe('triage');
    });

    it('closes on Escape without submitting', () => {
        const { panel, onSubmit } = mount();

        byClass('.create-harness', 'section').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );

        expect(panel.isOpen()).toBe(false);
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

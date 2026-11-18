// Create-harness form: identity validation, entry choice, ranked member chips and
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
    it('opens with the first preset as entry agent and one-agent empty state', () => {
        const { panel } = mount();

        expect(panel.isOpen()).toBe(true);
        expect(byClass('.create-entry', 'select').value).toBe('instruct');
        // F4/R3: every option reads the single-word display title; the slug stays the
        // option VALUE (what the form submits) and is never rendered as text.
        expect([...byClass('.create-entry', 'select').options].map((option) => option.textContent)).toEqual([
            'Instruct',
            'Summarizer',
            'Workspace'
        ]);
        expect(
            [...byClass('.create-agent-select', 'select').options].map((option) => option.textContent)
        ).toEqual(['Summarizer · Rank B', 'Workspace · Rank B']);
        expect(byClass('.create-form', 'form').textContent).not.toContain('summarizer');
        expect(byClass('.create-form', 'form').textContent).not.toContain('workspace');
        // The entry agent is always chosen, so there is no empty state on open: the strip shows
        // exactly one chip — the entry agent — and the add select offers everyone else.
        expect(document.querySelector('.create-empty')).toBeNull();
        expect([...document.querySelectorAll<HTMLElement>('.create-chip')].map((chip) => [chip.dataset.agent, chip.dataset.entry ?? ''])).toEqual([
            ['instruct', 'true']
        ]);
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

    it('submits the exact name, title, entry agent, roster and rank map', async () => {
        const { panel, onSubmit, onCancel } = mount();

        byClass('.create-name', 'input').value = 'release-captain';
        // An empty title defaults to the name: the request always has a title.
        byClass('.create-title-input', 'input').value = '';

        const entrySelect = byClass('.create-entry', 'select');
        entrySelect.value = 'workspace';
        entrySelect.dispatchEvent(new Event('change', { bubbles: true }));
        // The entry agent can never be added as its own member.
        expect([...byClass('.create-agent-select', 'select').options].map((option) => option.value)).toEqual([
            'instruct',
            'summarizer'
        ]);

        const addSelect = byClass('.create-agent-select', 'select');
        addSelect.value = 'summarizer';
        byClass('.create-agent-add', 'button').click();
        // The chip strip is the WHOLE team: the entry agent first (flagged `data-entry` and with
        // the `entry` flag word), then every added member. Rank steps render on every chip, entry
        // agent included, because a rank is a per-member fact rather than a property of one slot.
        const chips = [...document.querySelectorAll<HTMLElement>('.create-chip')];
        expect(chips.map((chip) => [chip.dataset.agent, chip.dataset.entry ?? ''])).toEqual([
            ['workspace', 'true'],
            ['summarizer', '']
        ]);
        expect([...document.querySelectorAll('.create-chip-name')].map((chip) => chip.textContent)).toEqual([
            'Workspace',
            'Summarizer'
        ]);
        expect([...document.querySelectorAll('.create-chip-rank-value')].map((node) => node.textContent)).toEqual([
            'Rank A',
            'Rank B'
        ]);
        expect(document.querySelectorAll('.create-chip-flag')).toHaveLength(1);
        expect(document.querySelector('.create-chip-flag')?.textContent).toBe('entry');
        // The slug is still carried internally (chip `data-agent`), and only an ADDED member has
        // a remove control: the entry agent leaves the team through the entry select, which is the
        // single choice that put it there. The remove control names the one-word title (R3/F4).
        expect(chips[1]?.querySelector('.chip-remove')?.getAttribute('aria-label')).toBe(
            'Remove Summarizer from the new harness'
        );
        expect(chips[0]?.querySelector('.chip-remove')).toBeNull();

        submit();
        await tick();

        // R20 request shape: the roster in declaration order (entry first), the entry agent, and
        // one rank letter per member — no `primary`/`subagents` pair on the wire.
        expect(onSubmit).toHaveBeenCalledWith({
            name: 'release-captain',
            title: 'release-captain',
            agents: ['workspace', 'summarizer'],
            entry: 'workspace',
            ranks: { workspace: 'A', summarizer: 'B' }
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(panel.isOpen()).toBe(false);
        // The form is reset for the next harness: the added member is gone and only the entry
        // agent's own chip remains.
        expect(byClass('.create-name', 'input').value).toBe('');
        expect(document.querySelectorAll('.create-chip')).toHaveLength(1);
    });

    it('removes a chosen member and drops a changed entry agent from the chip list', () => {
        const { panel } = mount();

        byClass('.create-name', 'input').value = 'triage';
        byClass('.create-agent-select', 'select').value = 'summarizer';
        byClass('.create-agent-add', 'button').click();

        const chipRemove = byClass('.chip-remove', 'button');
        chipRemove.click();
        // Only the ADDED member had a remove control, so the strip keeps the entry agent's chip.
        expect(document.querySelectorAll('.create-chip')).toHaveLength(1);
        expect(document.querySelector<HTMLElement>('.create-chip')?.dataset.agent).toBe('instruct');

        // Choosing an entry agent that is already a member drops it from the added list, because a roster can name an agent once.
        byClass('.create-agent-select', 'select').value = 'summarizer';
        byClass('.create-agent-add', 'button').click();
        const entrySelect = byClass('.create-entry', 'select');
        entrySelect.value = 'summarizer';
        entrySelect.dispatchEvent(new Event('change', { bubbles: true }));

        // The roster is now just the entry agent: the chip strip shows it once, flagged, and the
        // add select offers the two members that are not on the team.
        expect(document.querySelectorAll('.create-chip')).toHaveLength(1);
        expect(document.querySelector<HTMLElement>('.create-chip')?.dataset.agent).toBe('summarizer');
        expect(document.querySelector<HTMLElement>('.create-chip')?.dataset.entry).toBe('true');
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

// Agent row and preset picker: roles, promotion, duplicate prevention, removal
// and the frozen-session lock. The component is stateless — these tests assert the
// callbacks it reports, which is exactly what main.ts sends to PATCH.

import type { AgentDescriptor } from '../contract';
import { createAgentRow } from './agents';
import type { AgentRowOptions } from './agents';

const agents: AgentDescriptor[] = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'General agent.',
        instruction: 'Answer directly.',
        guidelines: ['Be concise.']
    },
    {
        name: 'summarizer',
        title: 'Summarizer',
        description: 'Compresses notes.',
        instruction: 'Compress into two sentences.',
        guidelines: []
    }
];

const mount = (overrides: Partial<AgentRowOptions> = {}) => {
    const options: AgentRowOptions = {
        members: ['instruct'],
        primary: 'instruct',
        agents,
        editable: true,
        onSelectPrimary: vi.fn(),
        onAdd: vi.fn(),
        onRemove: vi.fn(),
        ...overrides
    };

    const element = createAgentRow(options);
    document.body.replaceChildren(element);
    return { element, options };
};

const mainButtons = (element: HTMLElement): HTMLButtonElement[] => [
    ...element.querySelectorAll<HTMLButtonElement>('.agent-main')
];
const removeButtons = (element: HTMLElement): HTMLButtonElement[] => [
    ...element.querySelectorAll<HTMLButtonElement>('.agent-remove')
];

describe('createAgentRow', () => {
    it('shows one human-readable name per member with role as data only', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'], primary: 'instruct' });

        const tiles = [...element.querySelectorAll<HTMLElement>('.agent-tile')];
        expect(tiles.map((tile) => tile.dataset.agent)).toEqual(['instruct', 'summarizer']);
        expect(tiles.map((tile) => tile.dataset.role)).toEqual(['primary', 'secondary']);
        // The preset title is the only displayed name: no duplicated slug and no
        // separate title line.
        expect(
            [...element.querySelectorAll<HTMLElement>('.agent-tile-name')].map((node) => node.textContent)
        ).toEqual(['Instruct', 'Summarizer']);
        expect(element.querySelector('.agent-tile-title')).toBeNull();
        // Role is colour + aria-pressed, not a badge.
        expect(element.querySelector('.agent-role')).toBeNull();
        expect(mainButtons(element).map((button) => button.getAttribute('aria-pressed'))).toEqual([
            'true',
            'false'
        ]);

        expect(removeButtons(element).map((button) => button.disabled)).toEqual([false, false]);
    });

    it('disables removing the only agent', () => {
        const { element } = mount();
        expect(removeButtons(element)[0].disabled).toBe(true);
        expect(removeButtons(element)[0].title).toBe('A harness needs at least one agent.');
    });

    it('promotes a secondary through onSelectPrimary and ignores a click on the primary', () => {
        const { element, options } = mount({ members: ['instruct', 'summarizer'] });

        mainButtons(element)[1].click();
        expect(options.onSelectPrimary).toHaveBeenCalledWith('summarizer');

        mainButtons(element)[0].click();
        expect(options.onSelectPrimary).toHaveBeenCalledTimes(1);
    });

    it('opens the trusted preset picker with read-only details and no duplicate add', () => {
        const { element, options } = mount();
        const add = element.querySelector<HTMLButtonElement>('.agent-add');
        const picker = element.querySelector<HTMLElement>('.agent-picker');

        expect(add?.getAttribute('aria-expanded')).toBe('false');
        expect(picker?.hidden).toBe(true);

        add?.click();
        expect(picker?.hidden).toBe(false);
        expect(add?.getAttribute('aria-expanded')).toBe('true');

        const options_ = [...element.querySelectorAll<HTMLElement>('.agent-option')];
        expect(options_.map((option) => option.dataset.agent)).toEqual(['instruct', 'summarizer']);
        // A member remains visible so the team is understandable, but cannot be added twice.
        expect(options_[0].dataset.state).toBe('member');
        expect(options_[0].querySelector<HTMLButtonElement>('.agent-option-add')?.disabled).toBe(true);
        expect(options_[0].querySelector('.agent-option-state')?.textContent).toBe('already in team');
        expect(options_[1].dataset.state).toBeUndefined();
        expect(options_[1].querySelector('.agent-instruction')?.textContent).toBe(
            'Compress into two sentences.'
        );
        // Summarizer declares no guidelines: no empty list is rendered.
        expect(options_[1].querySelector('.agent-guidelines')).toBeNull();
        expect(options_[1].querySelector('.agent-detail-summary')?.textContent).toBe('preset details');

        options_[0].querySelector<HTMLButtonElement>('.agent-option-add')?.click();
        expect(options.onAdd).not.toHaveBeenCalled();

        options_[1].querySelector<HTMLButtonElement>('.agent-option-add')?.click();
        expect(options.onAdd).toHaveBeenCalledWith('summarizer');
        expect(picker?.hidden).toBe(true);
    });

    it('reports a removal, including the primary tile', () => {
        const { element, options } = mount({ members: ['instruct', 'summarizer'] });

        removeButtons(element)[0].click();
        expect(options.onRemove).toHaveBeenCalledWith('instruct');
    });

    it('locks the team without a notice or an in-row New session link (R7)', () => {
        const { element } = mount({
            members: ['instruct', 'summarizer'],
            editable: false
        });

        expect(mainButtons(element).every((button) => button.disabled)).toBe(true);
        expect(removeButtons(element).every((button) => button.disabled)).toBe(true);
        expect(element.querySelector<HTMLButtonElement>('.agent-add')?.disabled).toBe(true);
        // R7: a frozen team is expressed by the disabled controls alone. The old
        // explanation and its link must not come back (the rail owns New session).
        expect(element.querySelector('.agent-lock')).toBeNull();
        expect(element.querySelector('.agent-lock-text')).toBeNull();
        expect(element.querySelector('.link-button')).toBeNull();
        // The add control's tooltip states only the fact, never a caller-supplied
        // reason that could smuggle the removed sentence back in.
        expect(element.querySelector<HTMLButtonElement>('.agent-add')?.title).toBe(
            'The agent team is locked.'
        );
        // The wrapper holds exactly the row and the picker: no third lock block.
        expect([...element.children].map((child) => child.className)).toEqual([
            'agent-row',
            'agent-picker'
        ]);
    });

    it('renders a fallback title for a member the preset library does not know', () => {
        const { element } = mount({ members: ['instruct', 'legacy-helper'] });

        const tile = element.querySelector<HTMLElement>('.agent-tile[data-agent="legacy-helper"]');
        expect(tile?.querySelector('.agent-tile-name')?.textContent).toBe('legacy-helper');
        expect(element.querySelectorAll('.agent-option')).toHaveLength(agents.length);
    });
});

describe('per-agent model dropdown', () => {
    const models = (
        options: Partial<NonNullable<AgentRowOptions['models']>> = {}
    ): NonNullable<AgentRowOptions['models']> => ({
        models: {},
        catalogue: ['m1', 'm2'],
        // R18: the no-override choice is labelled with this resolved model.
        fallbackModel: 'm1',
        editable: true,
        onChange: vi.fn(),
        ...options
    });

    it('labels each select for its own agent and keeps it outside the promotion button', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'], models: models() });

        const selects = [...element.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
        expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
            'Model for Instruct',
            'Model for Summarizer'
        ]);
        // The control is a bare select: no visible MODEL label, but the accessible
        // name above still identifies it.
        expect(element.querySelector('.agent-model-label')).toBeNull();
        expect(
            [...element.querySelectorAll<HTMLElement>('.agent-model')].map((row) =>
                [...row.children].map((child) => child.tagName)
            )
        ).toEqual([['SELECT'], ['SELECT']]);
        // The promotion buttons contain no select: choosing a model can never
        // also promote the agent.
        expect(
            [...element.querySelectorAll<HTMLButtonElement>('.agent-main')].some(
                (button) => button.querySelector('select') !== null
            )
        ).toBe(false);
        expect(selects.map((select) => select.disabled)).toEqual([false, false]);
    });

    it('labels the default with its model, dedupes it from the catalogue, and sorts an absent override', () => {
        const { element, options } = mount({
            members: ['instruct', 'summarizer'],
            models: models({ models: { instruct: 'legacy-model' } })
        });

        const select = element.querySelector<HTMLSelectElement>('.agent-model-select');
        // Option 0 is the no-override default, labelled m1 (the fallback it really
        // resolves to), so the catalogue's m1 is not repeated. No "inherit" text.
        // `legacy-model` sorts into its alphabetic place, not at the tail.
        expect([...select!.options].map((option) => option.textContent)).toEqual([
            'm1',
            'legacy-model',
            'm2'
        ]);
        expect([...select!.options].map((option) => option.value)).toEqual([
            '',
            'legacy-model',
            'm2'
        ]);
        expect(select!.value).toBe('legacy-model');

        // A member without an override selects the default option and shows the
        // actual model it uses.
        const fallback = element.querySelectorAll<HTMLSelectElement>('.agent-model-select')[1];
        expect(fallback.value).toBe('');
        expect(fallback.options[0].textContent).toBe('m1');

        select!.value = 'm2';
        select!.dispatchEvent(new Event('change', { bubbles: true }));
        expect(options.models?.onChange).toHaveBeenCalledWith('instruct', 'm2');

        // Reverting sends '' so main.ts deletes the override.
        fallback.value = '';
        fallback.dispatchEvent(new Event('change', { bubbles: true }));
        expect(options.models?.onChange).toHaveBeenLastCalledWith('summarizer', '');
    });

    it('shows an honest label when the effective model is unknown, never "inherit"', () => {
        const { element } = mount({
            models: models({ fallbackModel: '', models: {}, catalogue: [] })
        });

        const select = element.querySelector<HTMLSelectElement>('.agent-model-select');
        expect([...select!.options].map((option) => option.textContent)).toEqual([
            'model not specified'
        ]);
        expect(select!.value).toBe('');
        expect(JSON.stringify([...select!.options].map((option) => option.textContent))).not.toContain(
            'inherit'
        );
    });

    it('sorts an unsorted catalogue case-insensitively and places an unknown current override in order', () => {
        // Deliberately unsorted, mixed case and mixed numeric widths. The helper
        // (ui/model-order.ts) lower-cases for comparison, then applies a numeric
        // collator, then a raw tie-break: `Alpha` and `alpha` fold equal and sort
        // by codepoint (uppercase first), while `beta-2` precedes `beta-10`.
        const catalogue = ['zeta-2', 'Alpha', 'beta-10', 'beta-2', 'alpha'];
        const { element } = mount({
            members: ['instruct'],
            models: models({ catalogue, models: { instruct: 'Legacy-Model' } })
        });

        const select = element.querySelector<HTMLSelectElement>('.agent-model-select');
        expect([...select!.options].map((option) => option.textContent)).toEqual([
            'm1',
            'Alpha',
            'alpha',
            'beta-2',
            'beta-10',
            'Legacy-Model',
            'zeta-2'
        ]);
        expect([...select!.options].map((option) => option.value)).toEqual([
            '',
            'Alpha',
            'alpha',
            'beta-2',
            'beta-10',
            'Legacy-Model',
            'zeta-2'
        ]);
        // The unknown override stays selected after being sorted into place.
        expect(select!.value).toBe('Legacy-Model');
        // Sorting copies: the caller's catalogue must not be reordered in place.
        expect(catalogue).toEqual(['zeta-2', 'Alpha', 'beta-10', 'beta-2', 'alpha']);
    });

    it('shows the effective models and honours a caller-disabled control', () => {
        // The component does not decide whether a saved session may edit models
        // (main.ts does, via `editable`); this pins that it truthfully renders the
        // effective map and obeys an explicit lock.
        const onChange = vi.fn();
        const { element } = mount({
            members: ['instruct', 'summarizer'],
            editable: false,
            models: models({
                editable: false,
                fallbackModel: 'm1',
                models: { instruct: 'm2', summarizer: 'm1' },
                onChange
            })
        });

        const selects = [...element.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
        // The visible effective model is what matters: m2 is an override (its own
        // option), m1 equals the fallback so the default option is selected and
        // labelled m1. No option says "inherit".
        expect(selects.map((select) => select.value)).toEqual(['m2', '']);
        expect(selects.map((select) => select.options[select.selectedIndex].textContent)).toEqual([
            'm2',
            'm1'
        ]);
        expect(selects.map((select) => select.disabled)).toEqual([true, true]);
        expect(selects[0].title).toBe(
            'This chat keeps the models it started with; start a new session to change them.'
        );

        // A disabled select cannot be driven by a stale handler.
        selects[0].value = 'm1';
        selects[0].dispatchEvent(new Event('change', { bubbles: true }));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('promises a session-scoped edit when the caller marks the map live', () => {
        // R2: the same control edits a saved session's live map; the tooltip must
        // say so, because the team row above it is still locked.
        const { element } = mount({
            members: ['instruct'],
            models: models({ session: true })
        });

        expect(element.querySelector<HTMLSelectElement>('.agent-model-select')?.title).toBe(
            'Model for Instruct. Applies to the next request in this session.'
        );
    });

    it('keeps the model row when no model data is supplied (caller has no catalogue)', () => {
        const { element } = mount();

        const select = element.querySelector<HTMLSelectElement>('.agent-model-select');
        expect(select?.disabled).toBe(true);
        // No caller data: the honest unknown label, never an inherit claim.
        expect([...select!.options].map((option) => option.textContent)).toEqual([
            'model not specified'
        ]);
    });
});

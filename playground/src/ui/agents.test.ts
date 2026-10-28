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
    it('labels every member as primary or secondary and disables removing the last one', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'], primary: 'instruct' });

        const tiles = [...element.querySelectorAll<HTMLElement>('.agent-tile')];
        expect(tiles.map((tile) => tile.dataset.agent)).toEqual(['instruct', 'summarizer']);
        expect(tiles.map((tile) => tile.dataset.role)).toEqual(['primary', 'secondary']);
        expect(
            [...element.querySelectorAll<HTMLElement>('.agent-role')].map((node) => node.textContent)
        ).toEqual(['primary', 'secondary']);
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

    it('locks editing with a visible reason and a New session affordance', () => {
        const onNewSession = vi.fn();
        const { element, options } = mount({
            members: ['instruct', 'summarizer'],
            editable: false,
            lockReason: 'This saved session keeps the agent team it started with.',
            onNewSession
        });

        expect(mainButtons(element).every((button) => button.disabled)).toBe(true);
        expect(removeButtons(element).every((button) => button.disabled)).toBe(true);
        expect(element.querySelector<HTMLButtonElement>('.agent-add')?.disabled).toBe(true);
        expect(element.querySelector('.agent-lock-text')?.textContent).toBe(
            'This saved session keeps the agent team it started with.'
        );

        element.querySelector<HTMLButtonElement>('.agent-lock .link-button')?.click();
        expect(onNewSession).toHaveBeenCalledTimes(1);
        expect(options.onSelectPrimary).not.toHaveBeenCalled();
    });

    it('renders a fallback title for a member the preset library does not know', () => {
        const { element } = mount({ members: ['instruct', 'legacy-helper'] });

        const tile = element.querySelector<HTMLElement>('.agent-tile[data-agent="legacy-helper"]');
        expect(tile?.querySelector('.agent-tile-title')?.textContent).toBe('legacy-helper');
        expect(element.querySelectorAll('.agent-option')).toHaveLength(agents.length);
    });
});

describe('per-agent model dropdown', () => {
    const models = (
        options: Partial<NonNullable<AgentRowOptions['models']>> = {}
    ): NonNullable<AgentRowOptions['models']> => ({
        models: {},
        catalogue: ['m1', 'm2'],
        inheritModel: 'm1',
        editable: true,
        onChange: vi.fn(),
        ...options
    });

    it('labels each select for its own agent and keeps it outside the promotion button', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'], models: models() });

        const selects = [...element.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
        expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
            'Model for instruct',
            'Model for summarizer'
        ]);
        expect(
            [...element.querySelectorAll<HTMLElement>('.agent-model-label')].map((node) => node.textContent)
        ).toEqual(['model', 'model']);
        // The promotion buttons contain no select: choosing a model can never
        // also promote the agent.
        expect(
            [...element.querySelectorAll<HTMLButtonElement>('.agent-main')].some(
                (button) => button.querySelector('select') !== null
            )
        ).toBe(false);
        expect(selects.map((select) => select.disabled)).toEqual([false, false]);
    });

    it('offers inherit, the catalogue and a current override that is absent from it', () => {
        const { element, options } = mount({
            members: ['instruct', 'summarizer'],
            models: models({ models: { instruct: 'legacy-model' } })
        });

        const select = element.querySelector<HTMLSelectElement>('.agent-model-select');
        expect([...select!.options].map((option) => option.textContent)).toEqual([
            'inherit · m1',
            'm1',
            'm2',
            'legacy-model (current)'
        ]);
        expect([...select!.options].map((option) => option.value)).toEqual([
            '',
            'm1',
            'm2',
            'legacy-model'
        ]);
        expect(select!.value).toBe('legacy-model');

        // A member without an override shows the inherit choice and names the
        // model it would use.
        const inherit = element.querySelectorAll<HTMLSelectElement>('.agent-model-select')[1];
        expect(inherit.value).toBe('');
        expect(inherit.options[0].textContent).toBe('inherit · m1');

        select!.value = 'm2';
        select!.dispatchEvent(new Event('change', { bubbles: true }));
        expect(options.models?.onChange).toHaveBeenCalledWith('instruct', 'm2');

        inherit.value = '';
        inherit.dispatchEvent(new Event('change', { bubbles: true }));
        expect(options.models?.onChange).toHaveBeenLastCalledWith('summarizer', '');
    });

    it('shows effective frozen models and disables the selects when the chat is locked', () => {
        const onChange = vi.fn();
        const { element } = mount({
            members: ['instruct', 'summarizer'],
            editable: false,
            lockReason: 'This saved session keeps the agent team it started with.',
            models: models({
                editable: false,
                inheritModel: 'm1',
                models: { instruct: 'm2', summarizer: 'm1' },
                onChange
            })
        });

        const selects = [...element.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
        expect(selects.map((select) => select.value)).toEqual(['m2', 'm1']);
        expect(selects.map((select) => select.disabled)).toEqual([true, true]);

        // A disabled select cannot be driven by a stale handler.
        selects[0].value = 'm1';
        selects[0].dispatchEvent(new Event('change', { bubbles: true }));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps the model row when no model data is supplied (caller has no catalogue)', () => {
        const { element } = mount();

        const select = element.querySelector<HTMLSelectElement>('.agent-model-select');
        expect(select?.disabled).toBe(true);
        expect([...select!.options].map((option) => option.textContent)).toEqual([
            'inherit session model'
        ]);
    });
});

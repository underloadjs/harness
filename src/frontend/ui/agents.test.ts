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

    it('resolves the primary TITLE in the promotion tooltip, never the slug', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'], primary: 'instruct' });

        const buttons = mainButtons(element);
        expect(buttons[1].title).toBe('Make Summarizer the primary agent; Instruct becomes a subagent.');
        // The slug never appears: only the two one-word titles do (F4/R3).
        expect(buttons[1].title).not.toContain('summarizer');
        expect(buttons[1].title).not.toContain('instruct');
    });

    it('labels an unknown member neutrally instead of exposing its slug', () => {
        const { element } = mount({ members: ['ghost'], primary: 'ghost' });

        // F4/R3: a member without preset details reads a neutral word; the slug is
        // still the tile's `data-agent` (internal identity).
        expect(element.querySelector<HTMLElement>('.agent-tile-name')?.textContent).toBe('Agent');
        expect(element.querySelector<HTMLElement>('.agent-tile')?.dataset.agent).toBe('ghost');
        expect(element.textContent).not.toContain('ghost');
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
        // R3/R5: ONE visible label per preset (the single-word display title). The
        // slug stays on `data-agent` for the callback and is never rendered text.
        expect(options_.map((option) => option.querySelector('.agent-option-title')?.textContent)).toEqual([
            'Instruct',
            'Summarizer'
        ]);
        expect(element.querySelector('.agent-option-name')).toBeNull();
        expect(options_[1].textContent).not.toContain('summarizer');
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

    it('never renders a raw id when a preset descriptor has no title', () => {
        const { element } = mount({
            agents: [
                { name: 'mystery', title: '', description: 'No title.', instruction: '', guidelines: [] }
            ]
        });

        element.querySelector<HTMLButtonElement>('.agent-add')?.click();
        const option = element.querySelector<HTMLElement>('.agent-option[data-agent="mystery"]');

        // R3: a missing display title falls back to a neutral word, not the slug.
        expect(option?.querySelector('.agent-option-title')?.textContent).toBe('Agent');
        expect(option?.textContent).not.toContain('mystery');
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
        // The wrapper holds the phone summary, the row and the picker: no third lock
        // block. The summary is R1's mobile disclosure (hidden by CSS above 860px).
        expect([...element.children].map((child) => child.className)).toEqual([
            'agent-summary',
            'agent-row',
            'agent-picker'
        ]);
    });

    it('renders a neutral fallback title for a member the preset library does not know', () => {
        const { element } = mount({ members: ['instruct', 'legacy-helper'] });

        const tile = element.querySelector<HTMLElement>('.agent-tile[data-agent="legacy-helper"]');
        // F4/R3: an unknown member reads a neutral word; the slug stays internal
        // (`data-agent`) and is never visible text.
        expect(tile?.querySelector('.agent-tile-name')?.textContent).toBe('Agent');
        expect(tile?.textContent).not.toContain('legacy-helper');
        expect(element.querySelectorAll('.agent-option')).toHaveLength(agents.length);
    });
});

// R1 (phone): the summary is a real disclosure control. Its DOM/state is pinned
// here; the stylesheet half — hidden above 860px, cards hidden until `data-open` —
// is pinned in compact-ui.test.ts.
describe('phone team summary', () => {
    it('summarises the primary and starts collapsed', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'] });

        const summary = element.querySelector<HTMLButtonElement>('.agent-summary');
        const row = element.querySelector<HTMLElement>('.agent-row');
        if (summary === null || row === null) throw new Error('missing summary or row');

        expect(summary.type).toBe('button');
        expect(summary.getAttribute('aria-expanded')).toBe('false');
        // The summary controls the card row it reveals (unique ids per mount).
        expect(summary.getAttribute('aria-controls')).toBe(row.id);
        expect(summary.querySelector('.agent-summary-label')?.textContent).toBe('Instruct');
        expect(summary.querySelector('.agent-summary-meta')?.textContent).toBe('2 agents');
        const icon = summary.querySelector('.agent-summary-icon');
        expect(icon?.textContent).toBe('▾');
        expect(icon?.getAttribute('aria-hidden')).toBe('true');
        // Collapsed is the ABSENCE of a data state, so nothing styles an open row.
        expect(element.dataset.open).toBeUndefined();

        // The cards and the add control stay in the DOM: CSS hides them, so expanding
        // never has to rebuild the team.
        expect(element.querySelectorAll('.agent-tile')).toHaveLength(2);
        expect(element.querySelector('.agent-add')).not.toBeNull();
    });

    it('uses the singular count for a one-agent team', () => {
        const { element } = mount();
        expect(element.querySelector('.agent-summary-label')?.textContent).toBe('Instruct');
        expect(element.querySelector('.agent-summary-meta')?.textContent).toBe('1 agent');
    });

    it('reports the open state to the caller and keeps a seeded state open', () => {
        const onToggle = vi.fn();
        const { element } = mount({ members: ['instruct', 'summarizer'], onToggle });
        const summary = element.querySelector<HTMLButtonElement>('.agent-summary');
        if (summary === null) throw new Error('missing summary');

        summary.click();
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(element.dataset.open).toBe('true');
        expect(onToggle).toHaveBeenLastCalledWith(true);

        summary.click();
        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(element.dataset.open).toBeUndefined();
        expect(onToggle).toHaveBeenLastCalledWith(false);

        // A rebuild seeded from the remembered state (main.ts `agentsExpanded`) paints
        // the same open row, so a repaint cannot collapse an open team.
        const reopened = mount({ members: ['instruct', 'summarizer'], expanded: true }).element;
        expect(
            reopened.querySelector<HTMLButtonElement>('.agent-summary')?.getAttribute('aria-expanded')
        ).toBe('true');
        expect(reopened.dataset.open).toBe('true');
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

// R2: the overlapping card deck. ONE card is front (fully visible); every other
// card exposes only its right strip as a `.agent-handle` button. The strip VIEWS
// the card — it never promotes and never reaches the server — while promotion and
// removal stay on the card's own controls. The geometry is CSS (styles.css), the
// front-state precedence and the tab order are pinned here.
describe('agent card deck', () => {
    const tileList = (element: HTMLElement): HTMLElement[] => [
        ...element.querySelectorAll<HTMLElement>('.agent-tile')
    ];
    const handleList = (element: HTMLElement): HTMLButtonElement[] => [
        ...element.querySelectorAll<HTMLButtonElement>('.agent-handle')
    ];
    // The FRONT flag in DOM order; `undefined` means "hidden card".
    const fronts = (element: HTMLElement): (string | undefined)[] =>
        tileList(element).map((tile) => tile.dataset.front);
    const tabStops = (tile: HTMLElement): (string | null)[] =>
        [
            tile.querySelector<HTMLElement>('.agent-main'),
            tile.querySelector<HTMLElement>('.agent-remove'),
            tile.querySelector<HTMLElement>('.agent-model-select')
        ].map((node) => node?.getAttribute('tabindex') ?? null);

    it('starts with the primary in front and every other edge a named button', () => {
        const { element } = mount({
            members: ['instruct', 'summarizer', 'workspace'],
            primary: 'instruct'
        });

        // Exactly one front card, the primary, and it is the leftmost visually
        // (CSS `order: -1`) without reordering the list itself.
        expect(fronts(element)).toEqual(['true', undefined, undefined]);
        expect(tileList(element).map((tile) => tile.dataset.agent)).toEqual([
            'instruct',
            'summarizer',
            'workspace'
        ]);

        // The strips are real buttons carrying the agent's human name, so an edge
        // identifies its agent. The front card offers no strip (nothing to reveal).
        // `workspace` is not in this file's preset fixture, so it reads the neutral
        // fallback title (F4/R3) — never the slug.
        expect(
            handleList(element).map((handle) => [handle.dataset.agent, handle.hidden, handle.textContent, handle.getAttribute('aria-label')])
        ).toEqual([
            ['instruct', true, 'Instruct', 'View Instruct'],
            ['summarizer', false, 'Summarizer', 'View Summarizer'],
            ['workspace', false, 'Agent', 'View Agent']
        ]);
        expect(handleList(element).map((handle) => handle.type)).toEqual(['button', 'button', 'button']);
        expect(handleList(element).map((handle) => handle.title)).toEqual([
            'View Instruct',
            'View Summarizer',
            'View Agent'
        ]);
        // A strip is a pure view control: it contains neither the remove button nor
        // the native model select, so a mis-click cannot delete or open one.
        expect(
            handleList(element).some(
                (handle) => handle.querySelector('.agent-remove, select') !== null
            )
        ).toBe(false);
    });

    it('fronts a card from its strip without promoting it or touching the list', () => {        const onFront = vi.fn();
        const { element, options } = mount({
            members: ['instruct', 'summarizer', 'workspace'],
            primary: 'instruct',
            onFront
        });

        handleList(element)[2].click();

        expect(fronts(element)).toEqual([undefined, undefined, 'true']);
        expect(onFront).toHaveBeenCalledWith('workspace');
        // R2: viewing is not promotion. The team callbacks are untouched...
        expect(options.onSelectPrimary).not.toHaveBeenCalled();
        expect(options.onRemove).not.toHaveBeenCalled();
        expect(options.onAdd).not.toHaveBeenCalled();
        // ...and the DOM/list semantics are the server's order with one primary.
        expect(tileList(element).map((tile) => tile.dataset.agent)).toEqual([
            'instruct',
            'summarizer',
            'workspace'
        ]);
        expect(tileList(element).map((tile) => tile.dataset.role)).toEqual([
            'primary',
            'secondary',
            'secondary'
        ]);
        expect(mainButtons(element).map((button) => button.getAttribute('aria-pressed'))).toEqual([
            'true',
            'false',
            'false'
        ]);
    });

    it('hands focus to the newly fronted card and keeps hidden controls out of the tab order', () => {
        const { element } = mount({ members: ['instruct', 'summarizer'], primary: 'instruct' });

        // Initial state: the primary's controls are the only tab stops; the secondary
        // card is covered by the deck, so its controls are skipped.
        expect(tabStops(tileList(element)[0])).toEqual([null, null, null]);
        expect(tabStops(tileList(element)[1])).toEqual(['-1', '-1', '-1']);

        handleList(element)[1].click();

        // The pressed strip is now hidden (its tile is front), so focus is moved to
        // that card's promotion button rather than being dropped to <body>.
        expect(handleList(element)[1].hidden).toBe(true);
        expect(handleList(element)[0].hidden).toBe(false);
        expect(document.activeElement).toBe(tileList(element)[1].querySelector('.agent-main'));
        expect(tabStops(tileList(element)[1])).toEqual([null, null, null]);
        expect(tabStops(tileList(element)[0])).toEqual(['-1', '-1', '-1']);
    });

    it('focuses the live model select when the locked card has no enabled promotion', () => {
        // Frozen session: `editable: false` disables promotion/removal but the model
        // map stays live (R2), so that is the card's real focusable control. Focusing
        // the disabled `.agent-main` would leave activeElement on <body>.
        const { element } = mount({
            members: ['instruct', 'summarizer'],
            editable: false,
            models: {
                models: {},
                catalogue: ['m1'],
                fallbackModel: 'm1',
                editable: true,
                onChange: vi.fn()
            }
        });
        const front = tileList(element)[1];
        const select = front.querySelector<HTMLSelectElement>('.agent-model-select');

        handleList(element)[1].click();

        expect(front.dataset.front).toBe('true');
        expect(select?.disabled).toBe(false);
        expect(document.activeElement).toBe(select);
        // The tile is not a focus target in this case, so it gains no tabindex.
        expect(front.hasAttribute('tabindex')).toBe(false);
        expect(tabStops(front)).toEqual([null, null, null]);
    });

    it('focuses the tile itself when every card control is disabled, adding no tab stop', () => {
        // Run in flight: the team AND its models are locked, so the card has nothing
        // focusable. Focus must still land inside the fronted card, and only as a
        // programmatic target (tabindex=-1), never as a new Tab stop (R3).
        const { element } = mount({
            members: ['instruct', 'summarizer'],
            editable: false,
            models: {
                models: {},
                catalogue: ['m1'],
                fallbackModel: 'm1',
                editable: false,
                onChange: vi.fn()
            }
        });

        handleList(element)[1].click();

        const front = tileList(element)[1];
        expect(front.dataset.front).toBe('true');
        expect(document.activeElement).toBe(front);
        expect(front.getAttribute('tabindex')).toBe('-1');
        // No control on that card became reachable: promotion/removal/model stay
        // disabled and the hidden controls stay at -1.
        expect(tabStops(front)).toEqual([null, null, null]);
        expect(front.querySelector<HTMLButtonElement>('.agent-main')?.disabled).toBe(true);
        expect(front.querySelector<HTMLButtonElement>('.agent-remove')?.disabled).toBe(true);
        expect(front.querySelector<HTMLSelectElement>('.agent-model-select')?.disabled).toBe(true);

        // Fronting the other card moves the focus target (and its tabindex marker)
        // with it, so no stale focusable tile is left in the deck.
        handleList(element)[0].click();
        expect(document.activeElement).toBe(tileList(element)[0]);
        expect(tileList(element)[0].getAttribute('tabindex')).toBe('-1');
        expect(tileList(element)[1].hasAttribute('tabindex')).toBe(false);
    });

    it('ignores a repeat activation of the already-front card', () => {
        const onFront = vi.fn();
        const { element } = mount({ members: ['instruct', 'summarizer'], onFront });

        // A hidden handle cannot be clicked by a pointer, but a stale programmatic
        // activation must not re-report or reset the deck.
        handleList(element)[1].click();
        handleList(element)[1].click();

        expect(onFront).toHaveBeenCalledTimes(1);
        expect(onFront).toHaveBeenCalledWith('summarizer');
        expect(fronts(element)).toEqual([undefined, 'true']);
    });

    it('ranks every card above the neighbour whose body covers its strip', () => {
        // The strip of a card is overlapped by the card to its RIGHT, so the leftmost
        // card must paint highest. Without this rank a mid-list front card would cover
        // an earlier card's strip, and a click there would hit promotion.
        const { element } = mount({
            members: ['instruct', 'summarizer', 'workspace'],
            primary: 'instruct'
        });
        const ranks = (): string[] =>
            tileList(element).map((tile) => tile.style.getPropertyValue('--agent-deck-z'));

        // Front first, then the rest in list order: 3, 2, 1 by DOM index.
        expect(ranks()).toEqual(['3', '2', '1']);

        // Fronting the LAST member moves it visually to the left, so the ranks follow
        // the visual order: workspace 3, instruct 2, summarizer 1.
        handleList(element)[2].click();
        expect(ranks()).toEqual(['2', '1', '3']);

        // The same rank is applied when the front card is seeded by the caller.
        const seeded = mount({
            members: ['instruct', 'summarizer', 'workspace'],
            front: 'workspace'
        }).element;
        expect(tileList(seeded).map((tile) => tile.style.getPropertyValue('--agent-deck-z'))).toEqual([
            '2',
            '1',
            '3'
        ]);
    });

    it('re-applies a remembered front card and falls back to the primary for an unknown one', () => {
        // main.ts remembers the viewed card (agentFront) and re-seeds it on every
        // rebuild, so an activity frame or a model PATCH cannot yank it back.
        const remembered = mount({ members: ['instruct', 'summarizer'], front: 'summarizer' }).element;
        expect(fronts(remembered)).toEqual([undefined, 'true']);

        // A remembered name that is no longer a member (the agent was removed) must
        // never blank the deck: the primary becomes front again.
        const stale = mount({ members: ['instruct', 'summarizer'], front: 'ghost' }).element;
        expect(fronts(stale)).toEqual(['true', undefined]);
        expect(handleList(stale)[0].hidden).toBe(true);
    });

    it('fronts while the team is locked and leaves the model selects as the lock applies', () => {
        const onFront = vi.fn();
        const { element } = mount({
            members: ['instruct', 'summarizer'],
            editable: false,
            onFront
        });

        // Promotion/removal stay disabled; the strip is not part of the team edit, so
        // viewing a frozen agent is still offered (R2/R3).
        expect(handleList(element).map((handle) => handle.disabled)).toEqual([false, false]);
        handleList(element)[1].click();

        expect(fronts(element)).toEqual([undefined, 'true']);
        expect(onFront).toHaveBeenCalledWith('summarizer');
        expect(mainButtons(element).map((button) => button.disabled)).toEqual([true, true]);
        expect(removeButtons(element).map((button) => button.disabled)).toEqual([true, true]);
        expect(tabStops(tileList(element)[1])).toEqual([null, null, null]);
    });

    it('keeps promotion and removal working on a hidden card when driven directly', () => {
        // The deck only covers these controls visually; their handlers are unchanged,
        // so the existing single-PATCH promotion/removal paths still report.
        const { element, options } = mount({ members: ['instruct', 'summarizer'] });

        mainButtons(element)[1].click();
        expect(options.onSelectPrimary).toHaveBeenCalledWith('summarizer');

        removeButtons(element)[1].click();
        expect(options.onRemove).toHaveBeenCalledWith('summarizer');
    });
});

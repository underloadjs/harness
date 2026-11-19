// Agent configuration dialog (T3/R3 + T7a/R4-R7) — module contract.
//
// composer-agent-control.test.ts and main.test.ts exercise this dialog through the
// live shell (real fetch stubs, PATCH bodies). This file pins the DIALOG ITSELF,
// without main.ts, so the rules the product depends on stay covered when the shell
// changes:
//   - ONE strip of clickable badges lists the ROSTER (the saved team plus drafted
//     adds) and nothing else: an agent the team does not select has no badge, and the
//     removed dropdown/team-section/note paragraph never come back;
//   - selecting a badge is a VIEW change: it moves the instruction and model area and
//     never writes and never moves the entry agent;
//   - `[+]` offers the nonmembers ONLY, drafting an add that becomes a badge;
//   - `Set as entry` / `Remove from team` are the only things that move the team, and
//     they are LOCAL drafts until the action;
//   - the bottom-right action is the only writer, it is always pressable (an empty
//     delta dismisses the dialog, an in-flight write disables it), and it reports the
//     exact delta (including an armed promotion);
//   - dismissal (X/backdrop/Escape/`close()`) discards every draft;
//   - a failed apply keeps the dialog open with its drafts and states the reason;
//   - a live `update()` refreshes untouched fields from the server, keeps a touched
//     one, and restores focus (including the caret);
//   - the badges are keyboard-operable (one tab stop, arrows move the selection);
//   - a run in flight locks the roster and the instruction WITH the reason on each
//     control, and keeps models live;
//   - `paintActivity()` paints rings without rebuilding the body;
//   - the optional `onRequestPreset` read rides an EXPLICIT selection only (a badge
//     click, an arrow move, a `[+]` pick), never a render, never a re-selection, and
//     never a write;
//   - R4: the instruction editor is ONE editable box holding the FULL effective
//     instruction — the stored text when this scope has one, otherwise the agent's
//     default instruction (identity plus its `Guidelines:` block). The read-only
//     "Preset instruction for X" block, the "Use the preset instruction" revert and
//     every preset word are gone by construction, asserted below;
//   - R5: `scope` changes only the copy — the session wording on the instruction box,
//     the harness wording for a harness template; the footer line is state only (a
//     lock or an armed change), so an idle editable dialog states nothing there;
//   - R7: in a session (`allowCustom`) the `[+]` panel also creates an agent by typed
//     name, which gets a badge and an empty editable instruction; a catalogue-only
//     dialog never offers that form;
//   - R6: an agent a conversation already runs keeps its badge but cannot be removed,
//     and the reason is visible rather than tooltip-only; a saved conversation's fixed
//     entry agent (`canSetEntry: false`) cannot be made the entry agent.
//
// Every assertion names the exact expected value — see the deterministic rule.

import type { AgentDescriptor } from '../../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAgentDialog } from './agent-dialog';
import type { AgentApplyResult, AgentConfigurationApply, AgentDialog, AgentDialogOptions } from './agent-dialog';

const agents: AgentDescriptor[] = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'General agent.',
        instruction: 'Answer directly.',
        guidelines: []
    },
    {
        name: 'research',
        title: 'Researcher',
        description: 'Investigates.',
        instruction: 'Investigate.',
        guidelines: ['Cite sources.']
    },
    {
        name: 'reviewer',
        title: 'Reviewer',
        description: 'Skeptical pass.',
        instruction: 'Hunt for bugs.',
        guidelines: []
    }
];

// The apply recorder: every test asserts the exact payload (or its absence).
const applyOf = (result: AgentApplyResult = { applied: true, message: 'Saved.' }) => {
    const calls: AgentConfigurationApply[] = [];

    return {
        calls,
        onApply: (changes: AgentConfigurationApply) => {
            calls.push(changes);

            return Promise.resolve(result);
        }
    };
};

const base = (overrides: Partial<AgentDialogOptions> = {}): AgentDialogOptions => {
    const apply = applyOf();

    return {
        members: ['instruct', 'research'],
        entry: 'instruct',
        ranks: { instruct: 'A', research: 'B' },
        agents,
        editable: true,
        models: {
            models: {},
            catalogue: ['m1', 'm2'],
            fallbackModel: 'm1',
            editable: true
        },
        instructions: {},
        onApply: apply.onApply,
        ...overrides
    };
};

// The preset-read recorder: every test asserts the EXACT ask sequence (agent ids, in
// the order the reader moved onto them) plus the call count, so a stray read during a
// render, a duplicate on re-selection, or a display title instead of an id all fail.
const presetOf = () => {
    const calls: string[] = [];

    return {
        calls,
        onRequestPreset: vi.fn((agent: string) => {
            calls.push(agent);
        })
    };
};

// Wraps the apply recorder in a spy so a view-only press can be pinned at ZERO calls
// with a count assertion, not only an empty-payload assertion.
const applySpyOf = (apply: ReturnType<typeof applyOf>) => ({
    onApply: vi.fn(apply.onApply)
});

let dialog: AgentDialog | undefined;

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    dialog?.close();
    dialog = undefined;
    for (const overlay of document.querySelectorAll('.dialog-overlay')) overlay.remove();
    vi.restoreAllMocks();
});

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

const instructionBox = (): HTMLTextAreaElement => byClass('.agent-dialog-instruction', 'textarea');
const modelSelect = (name?: string): HTMLSelectElement => {
    const agent =
        name ??
        byClass('.agent-dialog-tab[aria-selected="true"]', 'div').dataset.agent ??
        '';

    return byClass(`.agent-dialog-tab[data-agent="${agent}"] .agent-model-select`, 'select');
};
const applyButton = (): HTMLButtonElement => byClass('.agent-dialog-apply', 'button');
const addButton = (): HTMLButtonElement => byClass('.agent-dialog-add', 'button');
const entryButton = (): HTMLButtonElement => byClass('.agent-dialog-entry', 'button');
const removeButton = (): HTMLButtonElement => byClass('.agent-dialog-remove', 'button');

// The roster strip as the reader sees it: who has a badge, in which order, with the
// role/model facts inside it and which one is selected. The viewed chip's model is a
// select (that is the list the reader picks from); every other chip prints the id.
const modelTextOf = (tab: HTMLElement): string => {
    const cell = tab.querySelector<HTMLElement>('.agent-dialog-agent-model');
    const select = cell?.querySelector<HTMLSelectElement>('select');

    return select === null || select === undefined
        ? (cell?.textContent ?? '')
        : (select.selectedOptions[0]?.textContent ?? '');
};

const tabsOf = (): [string, string, boolean, string, string][] =>
    [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
        tab.dataset.agent ?? '',
        tab.dataset.entry ?? '',
        tab.getAttribute('aria-selected') === 'true',
        tab.querySelector('.agent-dialog-agent-name')?.textContent ?? '',
        modelTextOf(tab)
    ]);

// Selecting an agent is now a click on its badge (R3: the dropdown is gone).
const selectAgent = (name: string): void => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('.agent-dialog-tab')).find(
        (element) => element.dataset.agent === name
    );
    if (tab === undefined) throw new Error(`no badge for ${name}`);

    (tab as HTMLButtonElement).click();
};

const pressKey = (key: string): void => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) throw new Error('nothing is focused');
    active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

const openPicker = (): void => {
    addButton().click();
};

const pickerOptions = (): [string, string][] =>
    [...document.querySelectorAll<HTMLElement>('.agent-dialog-add-option')].map((option) => [
        option.dataset.agent ?? '',
        option.textContent ?? ''
    ]);

// ---------------------------------------------------------------------------
// R7: the "New agent" half of the `[+]` panel.
// ---------------------------------------------------------------------------
const customInput = (): HTMLInputElement => byClass('.agent-dialog-add-input', 'input');
const createAgentButton = (): HTMLButtonElement => byClass('.agent-dialog-add-create', 'button');
const customError = (): HTMLParagraphElement => byClass('.agent-dialog-add-error', 'p');

// Typing means the field's OWN event, because the live verdict is written on `input`;
// assigning `.value` alone would skip the handler the product depends on.
const typeAgentName = (text: string): void => {
    const input = customInput();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

const clickCreate = (): void => {
    createAgentButton().click();
};

const pressEnterInNameField = (): void => {
    customInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
};

// The panel's own words: the footer's scope promise and every inline note (the drafted
// "joins when you save" line and the R6 in-use line share the note class).
const footerNote = (): string => byClass('.agent-dialog-footer-note', 'p').textContent ?? '';
const fieldNotes = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.agent-dialog-field-note')].map(
        (node) => node.textContent
    );

const typeInstruction = (text: string): void => {
    const box = instructionBox();
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
};

const chooseModel = (id: string): void => {
    const select = modelSelect();
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
};

const flush = async (): Promise<void> => {
    // The apply handler is async; one microtask drain is enough (the stub resolves
    // immediately), and it keeps the assertions below synchronous and exact.
    await Promise.resolve();
    await Promise.resolve();
};

describe('the roster strip', () => {
    it('lists only the team as badges, entry agent first, and shows its model', () => {
        dialog = openAgentDialog(
            base({
                // A saved conversation can name an agent the catalogue no longer
                // advertises, so the roster comes from the members, never the library.
                members: ['instruct', 'legacy'],
                onApply: applyOf().onApply
            })
        );

        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Instruct');
        expect(tabsOf()).toEqual([
            ['instruct', 'true', true, 'Instruct', 'm1'],
            // T7b: a rostered member the catalogue does not describe is named by its id — it IS a
            // member of this team (`legacy` may be a profile the server dropped or an agent a
            // session invented), and 'Agent' would make two of them indistinguishable.
            ['legacy', '', false, 'legacy', 'm1']
        ]);

        // R3: no dropdown, no duplicate Team section, no explanation paragraph, and no
        // one-line team fact — the badge IS the team state.
        expect(document.querySelector('.agent-dialog-agent-select')).toBeNull();
        expect(document.querySelector('.agent-dialog-team-list')).toBeNull();
        expect(document.querySelector('.agent-dialog-note')).toBeNull();
        expect(document.querySelector('.agent-dialog-state')).toBeNull();
        expect(document.querySelector('.agent-dialog-member')).toBeNull();

        // The strip names itself for a screen reader and is a real tablist.
        expect(byClass('.agent-dialog-tabs', 'div').getAttribute('role')).toBe('tablist');
        expect(byClass('.agent-dialog-tabs', 'div').getAttribute('aria-label')).toBe('Agent team');

        // The entry agent is the default view: its instruction and model are on screen, and
        // the panel is the tab's declared controls.
        const config = byClass('.agent-dialog-config', 'section');
        expect(config.dataset.agent).toBe('instruct');
        expect(config.getAttribute('role')).toBe('tabpanel');
        expect(config.getAttribute('aria-labelledby')).toBe('agent-dialog-tab-instruct');
        expect(instructionBox().getAttribute('aria-label')).toBe('Instruction for Instruct');
        expect(instructionBox().value).toBe('Answer directly.');
        expect(modelSelect().getAttribute('aria-label')).toBe('Model for Instruct');
        expect(entryButton().getAttribute('aria-pressed')).toBe('false');
        expect(entryButton().disabled).toBe(true);
        expect(entryButton().title).toBe('Instruct is already the entry agent.');
        expect(removeButton().disabled).toBe(true);
        expect(removeButton().title).toBe('The entry agent is always part of the team: every harness needs an entry point.');
    });

    it('never lists an agent the team does not select', () => {
        dialog = openAgentDialog(base());

        // `reviewer` is in the trusted catalogue but not on the team, so it has no
        // badge at all; it reaches the strip through `[+]`.
        expect(tabsOf()).toEqual([
            ['instruct', 'true', true, 'Instruct', 'm1'],
            ['research', '', false, 'Researcher', 'm1']
        ]);
        expect(document.querySelector('.agent-dialog-tab[data-agent="reviewer"]')).toBeNull();
    });

    it('moves the instruction and model area on a badge click without writing', () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');

        // Every visible piece moved to the selected agent...
        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Researcher');
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('research');
        // R4: the ONE box carries the FULL effective instruction, guidelines included,
        // because that is the prompt the agent actually runs.
        expect(instructionBox().value).toBe('Investigate.\n\nGuidelines:\n- Cite sources.');
        expect(modelSelect().getAttribute('aria-label')).toBe('Model for Researcher');
        // R4: the read-only reference block is gone, so the guidelines appear exactly
        // once on screen — inside the editable box.
        expect(document.querySelector('.agent-detail')).toBeNull();
        expect(document.querySelector('.agent-guidelines')).toBeNull();

        // R3: selecting a badge is a view change AND not a promotion. The action stays
        // pressable but carries no delta here, so reading a teammate's prompt cannot
        // arm a promotion — and a press would only dismiss the dialog.
        expect(apply.calls).toEqual([]);
        expect(applyButton().disabled).toBe(false);
        expect(applyButton().textContent).toBe('Save configuration');
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
    });

    it('seeds the stored text verbatim and offers no revert control (R4)', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({ instructions: { research: 'Investigate twice.' }, onApply: apply.onApply })
        );

        selectAgent('research');

        // The stored text wins the box byte for byte, and the control says where a save
        // would write it (R5: harness scope wording).
        expect(instructionBox().value).toBe('Investigate twice.');
        expect(instructionBox().disabled).toBe(false);
        expect(instructionBox().title).toBe(
            'The instruction this agent runs. Saved on this harness template for new sessions.'
        );

        // R4: no dedicated revert affordance anywhere. Clearing the box IS the revert,
        // and the empty value still round-trips as '' so the shell can delete the entry.
        expect(document.querySelector('.agent-dialog-revert')).toBeNull();

        typeInstruction('');
        expect(instructionBox().value).toBe('');
        expect(apply.calls).toEqual([]);

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'research', models: {}, instructions: { research: '' }, add: [], remove: [] }
        ]);
    });
});

describe('the quick chip controls', () => {
    it('cycles a chip rank A -> B -> C -> D -> A without changing the view', () => {
        dialog = openAgentDialog(base());

        const badgeOf = (name: string): HTMLButtonElement =>
            byClass(`.agent-dialog-tab[data-agent="${name}"] .agent-dialog-agent-rank`, 'button');

        // The badge is the FIRST control in the chip and, for the entry agent, starts at A.
        expect(
            byClass('.agent-dialog-tab[data-agent="instruct"]', 'div').firstElementChild
        ).toBe(badgeOf('instruct'));
        expect(badgeOf('instruct').textContent).toBe('A');
        expect(badgeOf('instruct').getAttribute('aria-label')).toBe(
            'Change Instruct from Rank A to Rank B'
        );

        for (const [letter, next] of [
            ['B', 'C'],
            ['C', 'D'],
            ['D', 'A'],
            ['A', 'B']
        ] as const) {
            badgeOf('instruct').click();
            expect(badgeOf('instruct').textContent).toBe(letter);
            expect(badgeOf('instruct').getAttribute('aria-label')).toBe(
                `Change Instruct from Rank ${letter} to Rank ${next}`
            );
            // The quick path is rank-only: selecting another agent is a separate press.
            expect(
                byClass('.agent-dialog-tab[data-agent="instruct"]', 'div').getAttribute('aria-selected')
            ).toBe('true');
        }

        expect(byClass('.agent-dialog-tab[data-agent="instruct"]', 'div').dataset.rank).toBe('A');
    });

    it('offers every chip its own model select, without selecting that agent first', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        const selects = [
            ...document.querySelectorAll<HTMLSelectElement>('.agent-dialog-tab .agent-model-select')
        ];
        expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
            'Model for Instruct',
            'Model for Researcher'
        ]);

        // The researcher's chip is NOT the viewed one; its select is still live.
        const research = byClass(
            '.agent-dialog-tab[data-agent="research"] .agent-model-select',
            'select'
        );
        expect(research.disabled).toBe(false);
        research.value = 'm2';
        research.dispatchEvent(new Event('change', { bubbles: true }));

        expect(byClass('.agent-dialog-tab[data-agent="instruct"]', 'div').getAttribute('aria-selected')).toBe(
            'true'
        );
        expect(apply.calls).toEqual([]);

        // A rebuild keeps each member's own draft: switching away and back must not
        // copy one agent's model onto another chip.
        selectAgent('research');
        expect(modelSelect('research').value).toBe('m2');
        selectAgent('instruct');
        expect(modelSelect('instruct').value).toBe('');

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            {
                agent: 'instruct',
                models: { research: 'm2' },
                instructions: {},
                add: [],
                remove: []
            }
        ]);
    });

    it('reports the saved-conversation rank rule instead of silently ignoring the press', () => {
        dialog = openAgentDialog(base({ canAssignRanks: false }));

        const badge = byClass(
            '.agent-dialog-tab[data-agent="instruct"] .agent-dialog-agent-rank',
            'button'
        );
        expect(badge.getAttribute('aria-disabled')).toBe('true');
        expect(badge.textContent).toBe('A');

        badge.click();

        expect(byClass('.agent-dialog-error', 'p').textContent).toBe(
            'A saved conversation keeps the ranks its harness template defines; start a new session to change them.'
        );
        // Nothing was drafted: the badge still states the server's letter.
        expect(
            byClass(
                '.agent-dialog-tab[data-agent="instruct"] .agent-dialog-agent-rank',
                'button'
            ).textContent
        ).toBe('A');
        expect(applyButton().textContent).toBe('Save configuration');
    });

    it('puts the only header action at the old close position and leaves no X', () => {
        dialog = openAgentDialog(base());

        expect(document.querySelector('.dialog-close')).toBeNull();
        const add = byClass('.agent-dialog-add', 'button');
        expect(add.closest('.dialog-head')).not.toBeNull();
        expect(document.querySelector('.dialog-head .agent-dialog-add')).toBe(add);

        // An empty Save press is the dismissal path; the add picker's open state does not
        // write anything either.
        add.click();
        expect(document.querySelector('.agent-dialog-add-list')).not.toBeNull();
        applyButton().click();
        expect(dialog.isOpen).toBe(false);
    });
});

describe('the keyboard', () => {
    it('gives the strip one tab stop and moves the selection with the arrows', () => {
        dialog = openAgentDialog(base());

        // Roving tabindex: only the selected badge is in the tab order.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => tab.tabIndex)
        ).toEqual([0, -1]);

        const first = byClass('.agent-dialog-tab[data-agent="instruct"]', 'div');
        first.focus();
        pressKey('ArrowRight');

        // Automatic activation: the view follows the focus, and focus survives the
        // rebuild on the badge that is now selected.
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
        expect(document.activeElement).toBe(document.querySelector('.agent-dialog-tab[data-agent="research"]'));
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('research');
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => tab.tabIndex)
        ).toEqual([-1, 0]);

        pressKey('ArrowRight');
        expect(tabsOf().map((tab) => tab[2])).toEqual([true, false]);

        pressKey('Home');
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
        pressKey('End');
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('research');
    });
});

describe('the add picker', () => {
    it('lists only the agents without a badge, in catalogue order', () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({
                members: ['instruct', 'research'],
                agents: [agents[2], agents[1], agents[0]],
                onApply: apply.onApply
            })
        );

        // The picker is closed until `[+]` is pressed, so nothing is listed by default.
        expect(document.querySelector('.agent-dialog-add-list')).toBeNull();
        expect(addButton().getAttribute('aria-expanded')).toBe('false');
        expect(apply.calls).toEqual([]);

        openPicker();

        expect(addButton().getAttribute('aria-expanded')).toBe('true');
        // `research` is a member (so it is never offered again) and the surviving
        // nonmember keeps the library's own order and its display title.
        expect(pickerOptions()).toEqual([['reviewer', 'Reviewer']]);
        expect(apply.calls).toEqual([]);
    });

    it('drafts an add, gives it a badge, and keeps the other agents unsaved values', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // An edit on a current member first, to prove `[+]` does not lose it.
        typeInstruction('Answer in three words.');

        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();

        // The added agent joins the strip, marked as a draft, and is the viewed agent.
        expect(document.querySelector('.agent-dialog-add-list')).toBeNull();
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
                tab.dataset.agent,
                tab.dataset.added ?? '',
                tab.getAttribute('aria-selected') === 'true'
            ])
        ).toEqual([
            ['instruct', '', false],
            ['research', '', false],
            ['reviewer', 'true', true]
        ]);
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-field-note')].map((node) => node.textContent)
        ).toEqual(['Reviewer joins the team when you save · nothing is sent yet.']);
        expect(instructionBox().value).toBe('Hunt for bugs.');

        // Instruct's unsaved instruction survived the add, and nothing was written.
        selectAgent('instruct');
        expect(instructionBox().value).toBe('Answer in three words.');
        expect(apply.calls).toEqual([]);

        applyButton().click();
        await flush();

        // One save adds exactly the new agent, and never invents a promotion.
        expect(apply.calls).toEqual([
            {
                agent: 'instruct',
                models: {},
                instructions: { instruct: 'Answer in three words.' },
                add: ['reviewer'],
                remove: []
            }
        ]);
    });

    it('cancels a drafted add without leaving any delta', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();
        removeButton().click();

        // Cancelling an add is not a removal: the saved team never listed that agent, so
        // the roster is back to the server state and there is nothing to send.
        expect(tabsOf()).toEqual([
            ['instruct', 'true', true, 'Instruct', 'm1'],
            ['research', '', false, 'Researcher', 'm1']
        ]);
        // The action is always pressable: with the empty delta the press dismisses the
        // dialog instead of writing, and it never sends.
        expect(applyButton().disabled).toBe(false);

        applyButton().click();
        expect(apply.calls).toEqual([]);
        expect(dialog?.isOpen).toBe(false);
    });

    it('disables the add control with the real reason when the team is locked', () => {
        dialog = openAgentDialog(
            base({ editable: false, hint: 'Wait for the current run to finish before switching agents.' })
        );

        expect(addButton().disabled).toBe(true);
        expect(addButton().title).toBe('Wait for the current run to finish before switching agents.');

        // A press on a disabled control adds nobody and sends nothing.
        openPicker();
        expect(document.querySelector('.agent-dialog-add-list')).toBeNull();
    });

    it('disables the add control when every offered agent already has a badge', () => {
        dialog = openAgentDialog(base({ members: ['instruct', 'research', 'reviewer'] }));

        expect(addButton().disabled).toBe(true);
        expect(addButton().title).toBe('Every agent the server offers is already on this team.');
        expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research', 'reviewer']);
    });
});

describe('the preset read (onRequestPreset)', () => {
    // The dialog's second source: the trusted preset text a baseline falls back to is
    // NOT in the boot page, so the identified profile read rides an explicit
    // selection (`selectMemberTab` plus the `[+]` pick) and never a render. These cases
    // pin WHICH presses ask, how often, and with what exact argument.
    it('asks once with the agent id when a badge becomes the view, and never for a re-selection', () => {
        const apply = applyOf();
        const { onApply } = applySpyOf(apply);
        const preset = presetOf();

        dialog = openAgentDialog(base({ onApply, onRequestPreset: preset.onRequestPreset }));

        // Opening the dialog selects the entry agent WITHOUT asking: the page it was built
        // from already carries that roster, so a read paid per render is the bug.
        expect(preset.calls).toEqual([]);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(0);

        // A press on the badge that is ALREADY the view moves nothing, so it asks nothing
        // (main.ts dedupes nothing here — the dialog must not pay for a no-op).
        selectAgent('instruct');
        expect(preset.calls).toEqual([]);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(0);

        selectAgent('research');

        // Exactly one ask, carrying the AGENT ID — never the display title.
        expect(preset.calls).toEqual(['research']);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(1);

        selectAgent('research');
        expect(preset.calls).toEqual(['research']);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(1);

        // Moving onto another badge is a new selection, so it asks once more.
        selectAgent('instruct');
        expect(preset.calls).toEqual(['research', 'instruct']);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(2);

        // The ask is a read request, never a write: the action was never pressed, and
        // the draft layer is still empty so the press would only dismiss the dialog.
        expect(onApply).toHaveBeenCalledTimes(0);
        expect(apply.calls).toEqual([]);
        expect(applyButton().disabled).toBe(false);
    });

    it('asks once per badge the arrows move onto, and not for a move that lands on the viewed badge', () => {
        const apply = applyOf();
        const { onApply } = applySpyOf(apply);
        const preset = presetOf();

        dialog = openAgentDialog(base({ onApply, onRequestPreset: preset.onRequestPreset }));

        byClass('.agent-dialog-tab[data-agent="instruct"]', 'div').focus();

        // Automatic activation: the view follows the focus, so the read follows too.
        pressKey('ArrowRight');
        expect(preset.calls).toEqual(['research']);

        pressKey('ArrowLeft');
        expect(preset.calls).toEqual(['research', 'instruct']);

        // Home from the first badge is a no-op move, and the early return happens before
        // any ask (the handler cannot fire a read for a badge that is already the view).
        pressKey('Home');
        expect(preset.calls).toEqual(['research', 'instruct']);

        // End is a real move, so it asks again.
        pressKey('End');
        expect(preset.calls).toEqual(['research', 'instruct', 'research']);

        expect(preset.onRequestPreset).toHaveBeenCalledTimes(3);
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('research');
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
        expect(onApply).toHaveBeenCalledTimes(0);
        expect(apply.calls).toEqual([]);
    });

    it('asks nothing when the arrows cannot move at all (a one-badge roster)', () => {
        const apply = applyOf();
        const { onApply } = applySpyOf(apply);
        const preset = presetOf();

        dialog = openAgentDialog(
            base({ members: ['instruct'], onApply, onRequestPreset: preset.onRequestPreset })
        );

        byClass('.agent-dialog-tab[data-agent="instruct"]', 'div').focus();

        // With one badge, every wrap/warp computation lands back on the viewed agent, so
        // the guard must short-circuit four times rather than fire four identical reads.
        pressKey('ArrowRight');
        pressKey('ArrowLeft');
        pressKey('Home');
        pressKey('End');

        expect(preset.calls).toEqual([]);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(0);
        expect(tabsOf().map((tab) => tab[2])).toEqual([true]);
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
        expect(onApply).toHaveBeenCalledTimes(0);
    });

    it('asks for the id when the [+] picker drafts a tab, and keeps the drafted-tab facts', () => {
        const apply = applyOf();
        const { onApply } = applySpyOf(apply);
        const preset = presetOf();

        dialog = openAgentDialog(base({ onApply, onRequestPreset: preset.onRequestPreset }));

        openPicker();

        // Opening the picker adds nobody and asks for nothing.
        expect(preset.calls).toEqual([]);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(0);

        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();

        // The added agent was never covered by the dialog-open walk, so THIS press asks
        // for its text — exactly once, with the id.
        expect(preset.calls).toEqual(['reviewer']);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(1);

        // The draft fact must not drift: `dataset.added` is how the dialog says "not saved
        // yet" (the dashed border). The added badge carries NO `new` caption — the word was
        // repeated on every drafted badge and said nothing the dashed border did not.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
                tab.dataset.agent,
                tab.dataset.added ?? '',
                tab.getAttribute('aria-selected') === 'true'
            ])
        ).toEqual([
            ['instruct', '', false],
            ['research', '', false],
            ['reviewer', 'true', true]
        ]);
        expect(
            document.querySelector('.agent-dialog-tab[data-agent="reviewer"] .agent-dialog-agent-state')
        ).toBeNull();
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('reviewer');
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-field-note')].map((node) => node.textContent)
        ).toEqual(['Reviewer joins the team when you save · nothing is sent yet.']);

        // A read request is not a write and it does not arm the action by itself.
        expect(onApply).toHaveBeenCalledTimes(0);
        expect(apply.calls).toEqual([]);
        expect(applyButton().disabled).toBe(false);
    });

    it('still paints, selects and edits when the host supplies no preset read', async () => {
        const apply = applyOf();
        const { onApply } = applySpyOf(apply);

        // Back-compat: every existing call site omits `onRequestPreset`, so the option
        // staying optional must not turn any of these paths into a crash.
        const options = base({ onApply });
        expect(options.onRequestPreset).toBeUndefined();

        dialog = openAgentDialog(options);

        selectAgent('research');
        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Researcher');
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
        expect(instructionBox().value).toBe('Investigate.\n\nGuidelines:\n- Cite sources.');

        byClass('.agent-dialog-tab[data-agent="research"]', 'div').focus();
        pressKey('ArrowRight');
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
        expect(tabsOf().map((tab) => tab[2])).toEqual([true, false]);

        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('reviewer');

        typeInstruction('Hunt for real bugs.');
        expect(instructionBox().value).toBe('Hunt for real bugs.');
        expect(applyButton().disabled).toBe(false);

        applyButton().click();
        await flush();

        expect(onApply).toHaveBeenCalledTimes(1);
        expect(apply.calls).toEqual([
            {
                agent: 'reviewer',
                models: {},
                instructions: { reviewer: 'Hunt for real bugs.' },
                add: ['reviewer'],
                remove: []
            }
        ]);
    });

    it('clears the stale verdict and an open picker when the selection moves', async () => {
        const apply = applyOf({
            applied: false,
            message: 'An agent save is still in flight · try again in a moment.'
        });
        const preset = presetOf();

        dialog = openAgentDialog(base({ onApply: apply.onApply, onRequestPreset: preset.onRequestPreset }));

        selectAgent('research');
        typeInstruction('Investigate with sources.');
        applyButton().click();
        await flush();

        expect(byClass('.agent-dialog-error', 'p').textContent).toBe(
            'An agent save is still in flight · try again in a moment.'
        );

        openPicker();
        expect(addButton().getAttribute('aria-expanded')).toBe('true');

        // Moving the view is neither an edit nor a retry: the refused verdict must stop
        // describing work in progress, and the open picker closes with the selection.
        selectAgent('instruct');

        expect(byClass('.agent-dialog-error', 'p').textContent).toBe('');
        expect(footerNote()).toBe('');
        expect(document.querySelector('.agent-dialog-add-list')).toBeNull();
        expect(addButton().getAttribute('aria-expanded')).toBe('false');
        expect(preset.calls).toEqual(['research', 'instruct']);

        // The drafts survive the verdict being cleared, so the retry still carries the edit.
        selectAgent('research');
        expect(instructionBox().value).toBe('Investigate with sources.');
        expect(preset.calls).toEqual(['research', 'instruct', 'research']);
    });
});

describe('the one instruction editor (R4/R5)', () => {
    // A library row whose text is reachable ONLY through `options.agents` (the boot
    // summary carries no prompt), with an id and a display title that differ by case —
    // so a seed reading the wrong source, or an ask passing the title, fails visibly.
    const library: AgentDescriptor[] = [
        {
            name: 'instruct',
            title: 'Instruct',
            description: 'General agent.',
            instruction: 'Answer directly.',
            guidelines: []
        },
        {
            name: 'summarizer',
            title: 'Summarizer',
            description: 'Condenses the transcript.',
            instruction: 'Summarize the transcript in five bullets.',
            guidelines: ['Name every source.', 'Never invent a quote.']
        }
    ];

    it('seeds the box with the agent default instruction when nothing is stored', () => {
        const preset = presetOf();

        dialog = openAgentDialog(
            base({
                members: ['instruct', 'summarizer'],
                agents: library,
                instructions: {},
                onRequestPreset: preset.onRequestPreset
            })
        );

        selectAgent('summarizer');

        // Nothing stored is NOT an empty box: the reader edits the whole prompt the
        // agent runs, which is the library identity sentence PLUS its guidelines.
        expect(preset.calls).toEqual(['summarizer']);
        expect(instructionBox().value).toBe(
            'Summarize the transcript in five bullets.\n\n' +
                'Guidelines:\n' +
                '- Name every source.\n' +
                '- Never invent a quote.'
        );
        expect(instructionBox().getAttribute('aria-label')).toBe('Instruction for Summarizer');
        expect(instructionBox().disabled).toBe(false);
        expect(instructionBox().placeholder).toBe('Describe what this agent should do.');
        expect(instructionBox().title).toBe(
            'The instruction this agent runs. Saved on this harness template for new sessions.'
        );

        // R4: there is no second copy of that text anywhere. One editor, one truth.
        expect(document.querySelector('.agent-detail')).toBeNull();
        expect(document.querySelector('.agent-instruction')).toBeNull();
        expect(document.querySelector('.agent-guidelines')).toBeNull();
        expect(document.querySelectorAll('.agent-dialog-instruction')).toHaveLength(1);
    });

    it('seeds the stored text and never repeats the library text (R4)', () => {
        const apply = applyOf();
        const { onApply } = applySpyOf(apply);
        const preset = presetOf();

        dialog = openAgentDialog(
            base({
                members: ['instruct', 'summarizer'],
                agents: library,
                instructions: { summarizer: 'Override text.' },
                onApply,
                onRequestPreset: preset.onRequestPreset
            })
        );

        selectAgent('summarizer');

        // A stored value wins the box verbatim, and the read still rides the selection.
        expect(preset.calls).toEqual(['summarizer']);
        expect(instructionBox().value).toBe('Override text.');
        expect(instructionBox().title).toBe(
            'The instruction this agent runs. Saved on this harness template for new sessions.'
        );

        // R4: the library text is not shown alongside it, so the editor can never
        // contradict a second, read-only copy of "the real prompt".
        expect(document.body.textContent).not.toContain('Summarize the transcript in five bullets.');
        expect(document.querySelector('.agent-detail')).toBeNull();
        expect(document.querySelector('.agent-dialog-revert')).toBeNull();

        // Reading the box and asking for the library text are both view-only, so the
        // press would only dismiss the dialog.
        expect(onApply).toHaveBeenCalledTimes(0);
        expect(apply.calls).toEqual([]);
        expect(applyButton().disabled).toBe(false);
    });

    it('seeds the honest blank for an agent the library does not advertise', () => {
        const preset = presetOf();

        dialog = openAgentDialog(
            base({ members: ['instruct', 'legacy'], onRequestPreset: preset.onRequestPreset })
        );

        selectAgent('legacy');

        // The ask still uses the id, even though no row exists to display it.
        expect(preset.calls).toEqual(['legacy']);
        expect(instructionBox().value).toBe('');
        expect(instructionBox().placeholder).toBe('Describe what this agent should do.');
        expect(instructionBox().disabled).toBe(false);

        // R4: with no reference block there is no "this server does not advertise…"
        // sentence either. The empty editable box is the whole statement.
        expect(document.querySelector('.agent-detail')).toBeNull();
        expect(document.body.textContent).not.toContain('does not advertise');
    });
});

describe('drafts', () => {
    it('writes nothing for an instruction edit, a model edit or an armed entry change', () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        typeInstruction('Answer in three words.');
        chooseModel('m2');

        selectAgent('research');
        entryButton().click();

        expect(apply.calls).toEqual([]);
        // The controls still show the reader own choices (draft state, not the server's).
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
        expect(entryButton().getAttribute('aria-pressed')).toBe('true');
        expect(applyButton().textContent).toBe('Save & set entry');
    });

    it('keeps every agent draft across badge switches and sends both deltas without promoting', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // The action is always pressable; nothing has changed and the entry agent is
        // selected, so a press here would only dismiss the dialog.
        expect(applyButton().disabled).toBe(false);
        expect(applyButton().textContent).toBe('Save configuration');

        typeInstruction('Answer in three words.');
        expect(applyButton().disabled).toBe(false);

        selectAgent('research');
        typeInstruction('Investigate with sources.');
        chooseModel('m2');

        // Back to the first agent: its draft survived the switch.
        selectAgent('instruct');
        expect(instructionBox().value).toBe('Answer in three words.');

        selectAgent('research');
        expect(instructionBox().value).toBe('Investigate with sources.');
        expect(modelSelect().value).toBe('m2');

        // One save carries BOTH agents deltas, and the viewed agent stays a member
        // without becoming the entry agent (R3: selection never moves the entry role).
        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            {
                agent: 'research',
                models: { research: 'm2' },
                instructions: { instruct: 'Answer in three words.', research: 'Investigate with sources.' },
                add: [],
                remove: []
            }
        ]);
    });

    it('moves the entry agent only when the panel control is pressed', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');
        expect(applyButton().disabled).toBe(false);

        entryButton().click();
        expect(applyButton().disabled).toBe(false);
        expect(applyButton().textContent).toBe('Save & set entry');
        expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
            'Saves this harness and makes Researcher the entry agent.'
        );

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'research', entry: 'research', models: {}, instructions: {}, add: [], remove: [] }
        ]);
    });

    it('cancels an armed entry change on a second press', () => {
        dialog = openAgentDialog(base());

        selectAgent('research');
        entryButton().click();
        expect(applyButton().disabled).toBe(false);

        entryButton().click();
        expect(entryButton().getAttribute('aria-pressed')).toBe('false');
        expect(applyButton().disabled).toBe(false);
        expect(applyButton().textContent).toBe('Save configuration');
    });

    it('reports an explicit removal of a member and never removes anyone else', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // Removing is a deliberate press on that agent own panel, and the view moves to
        // a rostered agent rather than configuring an agent the save would drop.
        selectAgent('research');
        removeButton().click();

        expect(tabsOf()).toEqual([['instruct', 'true', true, 'Instruct', 'm1']]);
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'instruct', models: {}, instructions: {}, add: [], remove: ['research'] }
        ]);
    });

    it('drops a removed agent drafted edits, because the server rejects a non-member key', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');
        typeInstruction('Investigate with sources.');
        chooseModel('m2');
        removeButton().click();

        applyButton().click();
        await flush();

        // Only the removal is sent: a leaving agent has no team entry to hold its model
        // or instruction, so a delta there would be a 400 on the harness PATCH.
        expect(apply.calls).toEqual([
            { agent: 'instruct', models: {}, instructions: {}, add: [], remove: ['research'] }
        ]);
    });

    it('sends the empty model choice as the clear-the-override value', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({
                models: {
                    models: { research: 'm2' },
                    catalogue: ['m1', 'm2'],
                    fallbackModel: 'm1',
                    editable: true
                },
                onApply: apply.onApply
            })
        );

        selectAgent('research');
        chooseModel('');

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'research', models: { research: '' }, instructions: {}, add: [], remove: [] }
        ]);
    });
});

describe('the transactional action', () => {
    it('clears the drafts and reports the saved state on an applied write', async () => {
        const apply = applyOf({ applied: true, message: 'agent configuration saved · applies to new sessions' });
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        typeInstruction('Answer in three words.');
        applyButton().click();

        // While the request is in flight the action is busy and cannot double-send.
        expect(applyButton().disabled).toBe(true);
        expect(applyButton().title).toBe('Saving…');

        await flush();

        expect(apply.calls).toHaveLength(1);
        expect(document.querySelector('.dialog')).not.toBeNull();
        expect(dialog?.isOpen).toBe(true);
        expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
            'agent configuration saved · applies to new sessions'
        );
        expect(document.querySelector('.agent-dialog-error')?.textContent).toBe('');
        // The drafts are gone and the action stays pressable: another press now would
        // simply dismiss the dialog.
        expect(applyButton().disabled).toBe(false);
    });

    it('keeps the action the footer’s last node, beside the always-present status line', () => {
        // T5: the footer's DOM order is the other half of the bottom-right promise.
        // `.agent-dialog-error` is rendered even while it is empty, and its
        // `flex-basis: 100%` forces a wrap, so the action always sits alone on the last
        // flex line — where `margin-left: auto` (pinned in
        // ui/compact-control-style.test.ts) is the only thing holding it to the right.
        // The empty error line must STAY in the DOM: `role=status` announces only when
        // the node is already there, so hiding it would also break the announcement.
        dialog = openAgentDialog(base());

        const footer = byClass('.agent-dialog-footer', 'div');

        expect([...footer.children].map((node) => node.className)).toEqual([
            'agent-dialog-footer-note',
            'agent-dialog-error',
            'agent-dialog-apply button primary'
        ]);
        expect(footer.lastElementChild).toBe(applyButton());
        expect(byClass('.agent-dialog-error', 'p').getAttribute('role')).toBe('status');
        expect(byClass('.agent-dialog-error', 'p').textContent).toBe('');
    });

    it('keeps every draft and states the reason when the write is refused', async () => {
        const apply = applyOf({ applied: false, message: 'An agent save is still in flight · try again in a moment.' });
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');
        typeInstruction('Investigate with sources.');
        chooseModel('m2');

        applyButton().click();
        await flush();

        // No falsely successful close: the dialog is open, and every edit is still there.
        expect(dialog?.isOpen).toBe(true);
        expect(byClass('.agent-dialog-error', 'p').textContent).toBe(
            'An agent save is still in flight · try again in a moment.'
        );
        expect(instructionBox().value).toBe('Investigate with sources.');
        expect(modelSelect().value).toBe('m2');
        expect(applyButton().disabled).toBe(false);
    });

    it('turns a rejected write into the same visible failure', async () => {
        dialog = openAgentDialog(
            base({
                onApply: () => Promise.reject(new Error('`agentInstructions.instruct` cannot exceed 8000 characters.'))
            })
        );

        typeInstruction('x'.repeat(12));
        applyButton().click();
        await flush();

        expect(dialog?.isOpen).toBe(true);
        expect(byClass('.agent-dialog-error', 'p').textContent).toBe(
            '`agentInstructions.instruct` cannot exceed 8000 characters.'
        );
    });

    it('discards every draft when the dialog is dismissed', () => {
        const apply = applyOf();
        const closed: string[] = [];
        dialog = openAgentDialog(
            base({ onApply: apply.onApply, onClose: () => closed.push('closed') })
        );

        typeInstruction('Never saved.');
        chooseModel('m2');
        selectAgent('research');
        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();

        // X / backdrop / Escape all route here (ui/dialog.ts), as does a programmatic
        // close from a lifecycle change.
        dialog.close();

        expect(apply.calls).toEqual([]);
        expect(closed).toEqual(['closed']);
        expect(dialog.isOpen).toBe(false);

        // Re-opening starts from the server state, not from the dropped draft: no
        // invented badge, no dropped instruction, no dropped model choice.
        dialog = openAgentDialog(base({ onApply: apply.onApply }));
        expect(tabsOf()).toEqual([
            ['instruct', 'true', true, 'Instruct', 'm1'],
            ['research', '', false, 'Researcher', 'm1']
        ]);
        expect(instructionBox().value).toBe('Answer directly.');
        expect(modelSelect().value).toBe('');
        expect(apply.calls).toEqual([]);
    });
});

describe('live refresh while open', () => {
    it('follows the server for untouched agents and keeps a touched one', () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // The reader edits Researcher, then a live refresh lands for the whole team.
        selectAgent('research');
        typeInstruction('Investigate with sources.');

        dialog.update(
            base({
                entry: 'research',
                members: ['research', 'instruct', 'reviewer'],
                models: {
                    models: { research: 'm2', instruct: 'm1' },
                    catalogue: ['m1', 'm2'],
                    fallbackModel: 'm1',
                    editable: true
                },
                instructions: { reviewer: 'Review every claim.' },
                onApply: apply.onApply
            })
        );

        // Touched: the draft wins over the refreshed baseline.
        expect(instructionBox().value).toBe('Investigate with sources.');
        // The strip follows the server: new entry agent, new member, in the server order.
        expect(tabsOf()).toEqual([
            ['research', 'true', true, 'Researcher', 'm2'],
            ['instruct', '', false, 'Instruct', 'm1'],
            ['reviewer', '', false, 'Reviewer', 'm1']
        ]);
        // An untouched agent shows the server value.
        selectAgent('instruct');
        expect(modelSelect().value).toBe('');
        expect(instructionBox().value).toBe('Answer directly.');

        selectAgent('reviewer');
        expect(instructionBox().value).toBe('Review every claim.');
        expect(apply.calls).toEqual([]);
    });

    it('closes an open picker when a refresh leaves nothing to add', () => {
        dialog = openAgentDialog(base({ members: ['instruct'] }));

        openPicker();
        expect(pickerOptions()).toEqual([
            ['research', 'Researcher'],
            ['reviewer', 'Reviewer']
        ]);

        dialog.update(base({ members: ['instruct', 'research', 'reviewer'] }));

        expect(document.querySelector('.agent-dialog-add-list')).toBeNull();
        expect(addButton().disabled).toBe(true);
    });

    it('restores focus and the caret on the same instruction control after a rebuild', () => {
        dialog = openAgentDialog(base());

        selectAgent('research');
        const box = instructionBox();
        box.focus();
        box.setSelectionRange(5, 5);
        expect(document.activeElement).toBe(box);

        dialog.update(base({ models: { models: { research: 'm2' }, catalogue: ['m1', 'm2'], fallbackModel: 'm1', editable: true } }));

        const rebuilt = instructionBox();
        expect(rebuilt).not.toBe(box);
        expect(document.activeElement).toBe(rebuilt);
        expect(rebuilt.selectionStart).toBe(5);
    });

    it('restores focus on the same badge and the model select across a rebuild', () => {
        dialog = openAgentDialog(base());

        selectAgent('research');
        const tab = byClass('.agent-dialog-tab[data-agent="research"]', 'div');
        tab.focus();
        dialog.update(base({ entry: 'research', members: ['research', 'instruct'] }));
        const rebuiltTab = byClass('.agent-dialog-tab[data-agent="research"]', 'div');
        expect(rebuiltTab).not.toBe(tab);
        expect(document.activeElement).toBe(rebuiltTab);

        const model = modelSelect();
        model.focus();
        dialog.update(base({ entry: 'research', members: ['research', 'instruct'] }));
        const rebuilt = modelSelect();
        expect(rebuilt).not.toBe(model);
        expect(document.activeElement).toBe(rebuilt);
    });

    it('falls back to the entry agent when the viewed agent leaves the roster and the catalogue', () => {
        dialog = openAgentDialog(base());

        // The viewed agent is a drafted addition, so it only exists while the trusted
        // library still advertises it.
        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('reviewer');

        dialog.update(base({ members: ['research', 'instruct'], entry: 'instruct', agents: [agents[0], agents[1]] }));

        // Configuring an agent the server can no longer reach is meaningless, so the
        // view returns to the entry agent instead of stranding the reader on a dead badge.
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
        expect(tabsOf().map((tab) => tab[0])).toEqual(['research', 'instruct']);
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
    });
});

describe('honest restrictions and lifecycle', () => {
    it('locks the instruction and the roster while a run is in flight and keeps models live', async () => {
        const apply = applyOf();
        const hint =
            'A saved conversation keeps the agent team and the instructions it was created with; only models can change here. Edits saved on the harness apply to a new session.';
        dialog = openAgentDialog(
            base({
                editable: false,
                hint,
                models: {
                    models: { instruct: 'm1', research: 'm1' },
                    catalogue: ['m1', 'm2'],
                    fallbackModel: 'm1',
                    editable: true,
                    session: true
                },
                onApply: apply.onApply
            })
        );

        // R3: the frozen roster is still the full team (a saved conversation lists ITS
        // members), and there is no explanation paragraph anywhere.
        expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research']);
        expect(document.querySelector('.agent-dialog-note')).toBeNull();

        // Every locked control carries the real reason instead of a paragraph.
        expect(instructionBox().disabled).toBe(true);
        expect(instructionBox().title).toBe(
            'Wait for the current run to finish before changing this instruction.'
        );
        expect(addButton().disabled).toBe(true);
        expect(addButton().title).toBe(hint);
        expect(entryButton().disabled).toBe(true);
        expect(entryButton().title).toBe(hint);
        expect(removeButton().disabled).toBe(true);
        expect(removeButton().title).toBe(hint);
        // R2: models stay live in a saved session, so the select is still enabled.
        expect(modelSelect().disabled).toBe(false);

        // The action can only save a model here; it is always pressable, and with no
        // draft yet a press would only dismiss the dialog.
        expect(applyButton().textContent).toBe('Save configuration');
        expect(applyButton().disabled).toBe(false);
        expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
            'Models only here · this conversation keeps the team and instructions it started with.'
        );

        chooseModel('m2');
        expect(applyButton().disabled).toBe(false);

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'instruct', models: { instruct: 'm2' }, instructions: {}, add: [], remove: [] }
        ]);
    });

    it('still views every frozen member without attempting a team change', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({
                editable: false,
                hint: 'Wait for the current run to finish before switching agents.',
                onApply: apply.onApply
            })
        );

        selectAgent('research');

        // Viewing is not an edit, so the mid-run lock leaves the roster and the model
        // area reachable while the team controls state the reason.
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('research');
        expect(instructionBox().value).toBe('Investigate.\n\nGuidelines:\n- Cite sources.');
        expect(removeButton().title).toBe('Wait for the current run to finish before switching agents.');
        expect(apply.calls).toEqual([]);
    });

    it('names the lock reason for the whole strip when nothing can change', () => {
        dialog = openAgentDialog(
            base({
                editable: false,
                hint: 'A session is being created; try again in a moment.',
                models: { models: {}, catalogue: ['m1'], editable: false }
            })
        );

        expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
            'Nothing can be changed in this conversation right now.'
        );
        expect(addButton().title).toBe('A session is being created; try again in a moment.');
    });

    it('paints activity rings on the badges without rebuilding the body', () => {
        dialog = openAgentDialog(base());
        const rowsBefore = [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')];

        dialog.paintActivity(new Set(['research']));

        const rowsAfter = [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')];
        // Same nodes: a ring repaint must not recreate the badges (caret/details survive).
        expect(rowsAfter).toEqual(rowsBefore);
        expect(rowsAfter.map((row) => row.dataset.activity)).toEqual([undefined, 'active']);
        expect(rowsAfter.map((row) => row.getAttribute('aria-busy'))).toEqual([null, 'true']);

        dialog.paintActivity(new Set());
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map((row) => row.dataset.activity)
        ).toEqual([undefined, undefined]);
    });

    it('seeds the activity ring on rebuild so a refresh cannot drop a working agent', () => {
        dialog = openAgentDialog(base({ activity: ['research'] }));

        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
                tab.dataset.activity,
                tab.getAttribute('aria-busy')
            ])
        ).toEqual([
            [undefined, null],
            ['active', 'true']
        ]);
    });

    it('closes once and ignores updates after close', () => {
        dialog = openAgentDialog(base());
        expect(document.querySelector('.dialog')).not.toBeNull();
        expect(dialog.isOpen).toBe(true);

        dialog.close();
        expect(dialog.isOpen).toBe(false);
        expect(document.querySelector('.dialog')).toBeNull();

        // Idempotent + late async updates are no-ops (no resurrected overlay).
        dialog.close();
        dialog.update(base({ entry: 'research' }));
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

// R5: a saved conversation is a first-class configuration surface. The dialog's model
// (drafts, apply, roster) is identical for both scopes; what differs is the copy that
// states WHERE a save lands, plus the two capability flags the shell passes
// (`allowCustom`, `canSetEntry`). Every string below is asserted exactly.
describe('the session scope (R5)', () => {
    it('keeps the box editable and its conversation wording, with no idle footer note', () => {
        dialog = openAgentDialog(base({ scope: 'session', allowCustom: true, canSetEntry: false }));

        // The team is editable in a session, so the instruction is editable too: this is
        // the whole point of R5 (the harness definition is only a template). The scope's
        // wording lives on the box; the footer states nothing while nothing is armed.
        expect(instructionBox().disabled).toBe(false);
        expect(instructionBox().title).toBe('The instruction this agent runs in this conversation.');
        expect(footerNote()).toBe('');

        typeInstruction('Answer in three words.');
        expect(applyButton().disabled).toBe(false);
        expect(applyButton().textContent).toBe('Save configuration');
    });

    it('keeps the harness-template wording on the box when the caller does not name a scope', () => {
        // Default `scope` is 'harness', so every pre-R5 caller keeps its old promises.
        dialog = openAgentDialog(base());

        expect(instructionBox().title).toBe(
            'The instruction this agent runs. Saved on this harness template for new sessions.'
        );
        expect(footerNote()).toBe('');
    });

    it('shows the run-in-flight wording instead whenever the team is locked', () => {
        // The lock outranks the scope: `editable: false` now only ever means a run or a
        // session creation, so the instruction names THAT cause, not the harness.
        dialog = openAgentDialog(
            base({
                scope: 'session',
                allowCustom: true,
                canSetEntry: false,
                editable: false,
                hint: 'Wait for the current run to finish before switching agents.'
            })
        );

        expect(instructionBox().disabled).toBe(true);
        expect(instructionBox().title).toBe(
            'Wait for the current run to finish before changing this instruction.'
        );
        expect(footerNote()).toBe(
            'Models only here · this conversation keeps the team and instructions it started with.'
        );
    });
});

// R7: a session can gain an agent the catalogue never advertised. The name form lives in
// the `[+]` panel, validates the server's own id contract before it will draft anything,
// and produces an ordinary drafted tab — same `new` chip, same local-until-save rules,
// and no wasted read for a profile the server has never heard of.
describe('a custom agent in a session (R7)', () => {
    const session = (overrides: Partial<AgentDialogOptions> = {}): AgentDialogOptions =>
        base({ scope: 'session', allowCustom: true, canSetEntry: false, ...overrides });

    it('creates a badge from a typed name with an empty editable instruction', async () => {
        const apply = applyOf();
        const preset = presetOf();
        dialog = openAgentDialog(
            session({ onApply: apply.onApply, onRequestPreset: preset.onRequestPreset })
        );

        openPicker();
        typeAgentName('note-taker');
        // A usable name carries no verdict at all: the sentence only ever states a problem.
        expect(customError().textContent).toBe('');

        clickCreate();

        // The picker closes and the new agent is the viewed badge, marked as a draft.
        expect(document.querySelector('.agent-dialog-add-list')).toBeNull();
        expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research', 'note-taker']);
        expect(
            document.querySelector<HTMLElement>('.agent-dialog-tab[data-agent="note-taker"]')
                ?.dataset.added
        ).toBe('true');
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('note-taker');

        // T7b (R7): the reader's OWN name is the label. A session-defined member has no library
        // row, and the neutral fallback that hides an unknown id from visible text (R3) would make
        // two invented agents read as one 'Agent'; for a team member the id IS the identity, so the
        // tab, the header and the panel all say what was typed. The instruction stays an honest
        // EMPTY box: the server has no default for a name nobody published.
        expect(
            document.querySelector<HTMLElement>(
                '.agent-dialog-tab[data-agent="note-taker"] .agent-dialog-agent-name'
            )?.textContent
        ).toBe('note-taker');
        expect(
            document.querySelector<HTMLElement>('.agent-dialog-tab[data-agent="note-taker"]')?.getAttribute(
                'aria-label'
            )
        ).toBe('Configure note-taker · rank not stated');
        // A member with NO stated rank still shows the rank badge, as a dash rather than a
        // guessed letter: it is the quick path that assigns the first rank now, so hiding
        // it would leave a newly added member with no way to state one. The machine hook
        // stays absent (R3) and the badge's own name states the exact press.
        const unrankedBadge = byClass(
            '.agent-dialog-tab[data-agent="note-taker"] .agent-dialog-agent-rank',
            'button'
        );
        expect(unrankedBadge.textContent).toBe('–');
        expect(unrankedBadge.getAttribute('aria-label')).toBe('Set note-taker to Rank A');
        expect(unrankedBadge.title).toBe('No rank stated. Click to assign Rank A.');
        expect(
            document.querySelector<HTMLElement>('.agent-dialog-tab[data-agent="note-taker"]')?.dataset.rank
        ).toBeUndefined();
        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · note-taker');
        expect(instructionBox().value).toBe('');
        expect(instructionBox().disabled).toBe(false);
        expect(instructionBox().placeholder).toBe('Describe what this agent should do.');
        expect(instructionBox().getAttribute('aria-label')).toBe('Instruction for note-taker');
        // The membership row names the same agent, so nothing on screen calls it 'Agent'. It is
        // still a DRAFTED addition at this point, which is what the control's sentence says.
        expect(removeButton().title).toBe('Cancel the add, so note-taker never joins this team.');
        expect(
            document.querySelector<HTMLElement>('.agent-dialog-field-note')?.textContent
        ).toBe('note-taker joins the team when you save · nothing is sent yet.');

        // No preset read: `GET /agents/:id` for an unpublished name can only 404.
        expect(preset.calls).toEqual([]);
        expect(preset.onRequestPreset).toHaveBeenCalledTimes(0);

        // The draft is local until the action, exactly like a catalogue pick.
        typeInstruction('Take verbatim notes.');
        expect(apply.calls).toEqual([]);

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            {
                agent: 'note-taker',
                models: {},
                instructions: { 'note-taker': 'Take verbatim notes.' },
                add: ['note-taker'],
                remove: []
            }
        ]);
    });

    it('accepts Enter in the name field as the create press', () => {
        dialog = openAgentDialog(session());

        openPicker();
        typeAgentName('auditor');
        pressEnterInNameField();

        expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research', 'auditor']);
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('auditor');
    });

    // T7b: the boundary of the member-title rule. A name ON the roster is the reader's own naming
    // act, so it is displayed (the rule the test above pins); a name that is not on any roster has
    // no team entry to justify showing an id, and keeps the neutral word ui/agents.ts defines.
    it('labels a name that is not on the team with the neutral fallback, not its id', () => {
        dialog = openAgentDialog(session({ members: [], entry: 'ghost' }));

        // Nothing is rostered, so the tab strip is empty and the panel describes an agent this
        // dialog only knows by an id it never saw on a library row.
        expect(document.querySelector('.agent-dialog-tab')).toBeNull();
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('ghost');
        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Agent');
        expect(instructionBox().getAttribute('aria-label')).toBe('Instruction for Agent');
    });

    it('refuses every name the server would reject, and drafts nothing', () => {
        const apply = applyOf();
        dialog = openAgentDialog(session({ onApply: apply.onApply }));

        const refused: [string, string][] = [
            // The contract is `^[a-z][a-z0-9_-]*$`: no capitals, no spaces, no leading
            // digit, no other punctuation.
            ['Notes', 'Use a lowercase name that starts with a letter and continues with letters, digits, "-" or "_".'],
            ['note taker', 'Use a lowercase name that starts with a letter and continues with letters, digits, "-" or "_".'],
            ['9lives', 'Use a lowercase name that starts with a letter and continues with letters, digits, "-" or "_".'],
            ['notes!', 'Use a lowercase name that starts with a letter and continues with letters, digits, "-" or "_".'],
            // `unknown` matches the pattern but is the reserved id for an unreadable agent.
            ['unknown', '"unknown" is the reserved name for an agent the server cannot identify.'],
            // A member and the entry agent are both collisions, and case does not save you.
            ['research', 'An agent named research is already on this team.'],
            ['instruct', 'An agent named instruct is already on this team.']
        ];

        openPicker();

        for (const [typed, reason] of refused) {
            typeAgentName(typed);
            clickCreate();

            expect(customError().textContent).toBe(reason);
            // Nothing was drafted and nothing was viewed, so the strip is untouched.
            expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research']);
            expect(apply.calls).toEqual([]);
        }

        // A name that only differs by case from a member still collides, and the reason
        // quotes the name the reader typed. Nothing was drafted, so the action's press
        // would only dismiss the dialog.
        expect(applyButton().disabled).toBe(false);
    });

    it('pressing create with nothing typed says nothing and adds nobody', () => {
        dialog = openAgentDialog(session());

        openPicker();
        clickCreate();

        expect(customError().textContent).toBe('');
        expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research']);
        expect(applyButton().disabled).toBe(false);
    });

    it('still offers the form after the catalogue is exhausted', () => {
        // All three advertised agents are already on the team. Without R7 that closes
        // `[+]`; a session can still gain an unpublished agent, so it must not.
        dialog = openAgentDialog(session({ members: ['instruct', 'research', 'reviewer'] }));

        expect(addButton().disabled).toBe(false);
        expect(addButton().title).toBe('Add an agent to the team, or name a new one.');

        openPicker();

        expect(pickerOptions()).toEqual([]);
        expect(customInput().getAttribute('aria-label')).toBe('New agent name');
        expect(customInput().placeholder).toBe('New agent name');
        expect(customInput().maxLength).toBe(64);
        expect(createAgentButton().textContent).toBe('Create agent');

        typeAgentName('auditor');
        clickCreate();

        expect(tabsOf().map((tab) => tab[0])).toEqual([
            'instruct',
            'research',
            'reviewer',
            'auditor'
        ]);
    });

    it('offers no name field where a typed name is not allowed', () => {
        // The default (a harness template) is catalogue-only: the server validates its
        // agent names against the published profiles, so a typed name would 400.
        dialog = openAgentDialog(base());

        openPicker();

        expect(pickerOptions()).toEqual([['reviewer', 'Reviewer']]);
        expect(document.querySelector('.agent-dialog-add-custom')).toBeNull();
        expect(document.querySelector('.agent-dialog-add-input')).toBeNull();
        expect(document.querySelector('.agent-dialog-add-create')).toBeNull();
        expect(addButton().title).toBe('Add an agent to the team.');
    });
});

// R6: an agent some conversation in this session already runs keeps its badge — the
// transcript names it — but cannot be taken off the team. The reason is visible, because
// a tooltip on a disabled button is not reachable.
describe('an agent a conversation already runs (R6)', () => {
    it('disables the removal with the reason and shows it under the actions', () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({ scope: 'session', allowCustom: true, canSetEntry: false, threadAgents: ['research'], onApply: apply.onApply })
        );

        selectAgent('research');

        expect(removeButton().disabled).toBe(true);
        expect(removeButton().title).toBe(
            'This agent is used by a conversation in this session; deleting that conversation does not release it, so removing the agent needs the session deleted.'
        );
        expect(fieldNotes()).toEqual(['This agent is in use by a conversation and cannot be removed.']);

        // A press on the disabled control cannot draft a removal, so there is nothing to
        // save and the roster keeps its badge; the action's own press would only dismiss.
        removeButton().click();
        expect(tabsOf().map((tab) => tab[0])).toEqual(['instruct', 'research']);
        expect(apply.calls).toEqual([]);
        expect(applyButton().disabled).toBe(false);
    });

    it('leaves an agent no conversation runs removable', () => {
        dialog = openAgentDialog(
            base({ scope: 'session', allowCustom: true, canSetEntry: false, threadAgents: ['research'] })
        );

        // `reviewer` is not in `threadAgents`, so it keeps the ordinary add flow: the tab
        // is drafted, and cancelling the add is offered with its own sentence.
        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();

        expect(removeButton().disabled).toBe(false);
        expect(removeButton().title).toBe('Cancel the add, so Reviewer never joins this team.');
        expect(fieldNotes()).toEqual(['Reviewer joins the team when you save · nothing is sent yet.']);
    });

    it('states the entry-agent reason for the entry agent, not the thread reason', () => {
        // The entry agent is always running SOME conversation, so both rules apply to it.
        // The stronger one (the entry agent always stays) wins, and the note stays hidden so
        // the panel never states two reasons for one disabled control.
        dialog = openAgentDialog(
            base({ scope: 'session', allowCustom: true, canSetEntry: false, threadAgents: ['instruct', 'research'] })
        );

        expect(removeButton().disabled).toBe(true);
        expect(removeButton().title).toBe('The entry agent is always part of the team: every harness needs an entry point.');
        // The panel states NO removal reason here (the rule lives on the disabled control),
        // and it states no rank line either — the config area carries no field note at all.
        expect(fieldNotes()).toEqual([]);
    });
});

// R5/R6: a saved conversation's entry agent is fixed, so `Set as entry` has nothing to
// do there and must not arm a promotion the shell cannot write.
describe('a fixed entry agent (R5 canSetEntry)', () => {
    it('disables Set as entry with the reason and never arms an entry change', () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({ scope: 'session', allowCustom: true, canSetEntry: false, onApply: apply.onApply })
        );

        selectAgent('research');

        expect(entryButton().disabled).toBe(true);
        expect(entryButton().title).toBe(
            'The entry agent is fixed for a saved conversation.'
        );
        expect(entryButton().getAttribute('aria-pressed')).toBe('false');

        // Even a forced press cannot arm it, so the action keeps its plain label: with
        // no delta its press would only dismiss the dialog.
        entryButton().click();
        expect(entryButton().getAttribute('aria-pressed')).toBe('false');
        expect(applyButton().textContent).toBe('Save configuration');
        expect(applyButton().disabled).toBe(false);
        expect(apply.calls).toEqual([]);
        expect(footerNote()).toBe('');
    });

    it('keeps the entry move available for a harness template (default canSetEntry)', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');

        expect(entryButton().disabled).toBe(false);
        expect(entryButton().title).toBe('Make Researcher the entry agent when you save, so a new conversation starts with it. No rank changes, and this does not make it the highest-ranked agent.');

        entryButton().click();
        expect(applyButton().textContent).toBe('Save & set entry');

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'research', entry: 'research', models: {}, instructions: {}, add: [], remove: [] }
        ]);
    });
});

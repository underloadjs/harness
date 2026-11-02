// Agent configuration dialog (T3/R3) — module contract.
//
// composer-agent-control.test.ts and main.test.ts exercise this dialog through the
// live shell (real fetch stubs, PATCH bodies). This file pins the DIALOG ITSELF,
// without main.ts, so the rules the product depends on stay covered when the shell
// changes:
//   - ONE strip of clickable badges lists the ROSTER (the saved team plus drafted
//     adds) and nothing else: an agent the team does not select has no badge, and the
//     removed dropdown/team-section/note paragraph never come back;
//   - selecting a badge is a VIEW change: it moves the instruction and model area and
//     never writes and never promotes;
//   - `[+]` offers the nonmembers ONLY, drafting an add that becomes a badge;
//   - `Make primary` / `Remove from team` are the only things that move the team, and
//     they are LOCAL drafts until the action;
//   - the bottom-right action is the only writer, it is disabled while nothing is
//     pending, and it reports the exact delta (including an armed promotion);
//   - dismissal (X/backdrop/Escape/`close()`) discards every draft;
//   - a failed apply keeps the dialog open with its drafts and states the reason;
//   - a live `update()` refreshes untouched fields from the server, keeps a touched
//     one, and restores focus (including the caret);
//   - the badges are keyboard-operable (one tab stop, arrows move the selection);
//   - a frozen saved session locks the roster and the instruction WITH the reason on
//     each control, and keeps models live;
//   - `paintActivity()` paints rings without rebuilding the body.
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
        primary: 'instruct',
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
const modelSelect = (): HTMLSelectElement => byClass('.agent-model-select', 'select');
const applyButton = (): HTMLButtonElement => byClass('.agent-dialog-apply', 'button');
const addButton = (): HTMLButtonElement => byClass('.agent-dialog-add', 'button');
const promoteButton = (): HTMLButtonElement => byClass('.agent-dialog-promote', 'button');
const removeButton = (): HTMLButtonElement => byClass('.agent-dialog-remove', 'button');

// The roster strip as the reader sees it: who has a badge, in which order, with the
// role/model facts inside it and which one is selected.
const tabsOf = (): [string, string, boolean, string, string][] =>
    [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
        tab.dataset.agent ?? '',
        tab.dataset.role ?? '',
        tab.getAttribute('aria-selected') === 'true',
        tab.querySelector('.agent-dialog-agent-name')?.textContent ?? '',
        tab.querySelector('.agent-dialog-agent-model')?.textContent ?? ''
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
    it('lists only the team as badges, primary first, and shows its model', () => {
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
            ['instruct', 'primary', true, 'Instruct', 'm1'],
            ['legacy', 'secondary', false, 'Agent', 'm1']
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

        // The primary is the default view: its instruction and model are on screen, and
        // the panel is the tab's declared controls.
        const config = byClass('.agent-dialog-config', 'section');
        expect(config.dataset.agent).toBe('instruct');
        expect(config.getAttribute('role')).toBe('tabpanel');
        expect(config.getAttribute('aria-labelledby')).toBe('agent-dialog-tab-instruct');
        expect(instructionBox().getAttribute('aria-label')).toBe('Instruction for Instruct');
        expect(instructionBox().value).toBe('Answer directly.');
        expect(modelSelect().getAttribute('aria-label')).toBe('Model for Instruct');
        expect(promoteButton().getAttribute('aria-pressed')).toBe('false');
        expect(promoteButton().disabled).toBe(true);
        expect(promoteButton().title).toBe('The primary agent is already the primary.');
        expect(removeButton().disabled).toBe(true);
        expect(removeButton().title).toBe('The primary agent is always part of the team.');
    });

    it('never lists an agent the team does not select', () => {
        dialog = openAgentDialog(base());

        // `reviewer` is in the trusted catalogue but not on the team, so it has no
        // badge at all; it reaches the strip through `[+]`.
        expect(tabsOf()).toEqual([
            ['instruct', 'primary', true, 'Instruct', 'm1'],
            ['research', 'secondary', false, 'Researcher', 'm1']
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
        expect(instructionBox().value).toBe('Investigate.');
        expect(modelSelect().getAttribute('aria-label')).toBe('Model for Researcher');
        // ...and the trusted guidelines are still shown as the preset reference.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-detail .agent-guideline')].map(
                (node) => node.textContent
            )
        ).toEqual(['Cite sources.']);

        // R3: selecting a badge is a view change AND not a promotion. The action stays
        // disabled, so reading a teammate's prompt cannot arm a promotion.
        expect(apply.calls).toEqual([]);
        expect(applyButton().disabled).toBe(true);
        expect(applyButton().textContent).toBe('Save configuration');
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
    });

    it('keeps a stored override as the editor baseline and offers the revert', () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({ instructions: { research: 'Investigate twice.' }, onApply: apply.onApply })
        );

        selectAgent('research');
        expect(instructionBox().value).toBe('Investigate twice.');
        expect(byClass('.agent-dialog-revert', 'button').textContent).toBe('Use the preset instruction');

        byClass('.agent-dialog-revert', 'button').click();

        // The revert is a draft until the action runs: an empty box means "the preset
        // instruction again", and nothing has been sent yet.
        expect(instructionBox().value).toBe('');
        expect(apply.calls).toEqual([]);
    });
});

describe('the keyboard', () => {
    it('gives the strip one tab stop and moves the selection with the arrows', () => {
        dialog = openAgentDialog(base());

        // Roving tabindex: only the selected badge is in the tab order.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => tab.tabIndex)
        ).toEqual([0, -1]);

        const first = byClass('.agent-dialog-tab[data-agent="instruct"]', 'button');
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
            ['instruct', 'primary', true, 'Instruct', 'm1'],
            ['research', 'secondary', false, 'Researcher', 'm1']
        ]);
        expect(applyButton().disabled).toBe(true);

        applyButton().click();
        expect(apply.calls).toEqual([]);
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

describe('drafts', () => {
    it('writes nothing for an instruction edit, a model edit or an armed promotion', () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        typeInstruction('Answer in three words.');
        chooseModel('m2');

        selectAgent('research');
        promoteButton().click();

        expect(apply.calls).toEqual([]);
        // The controls still show the reader own choices (draft state, not the server's).
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
        expect(promoteButton().getAttribute('aria-pressed')).toBe('true');
        expect(applyButton().textContent).toBe('Save & set primary');
    });

    it('keeps every agent draft across badge switches and sends both deltas without promoting', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // The action starts disabled: nothing has changed and the primary is selected.
        expect(applyButton().disabled).toBe(true);
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
        // without becoming the primary (R3: selection never promotes).
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

    it('promotes only when the panel control is pressed', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');
        expect(applyButton().disabled).toBe(true);

        promoteButton().click();
        expect(applyButton().disabled).toBe(false);
        expect(applyButton().textContent).toBe('Save & set primary');
        expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
            'Saves this harness and makes Researcher the primary.'
        );

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'research', primary: 'research', models: {}, instructions: {}, add: [], remove: [] }
        ]);
    });

    it('cancels an armed promotion on a second press', () => {
        dialog = openAgentDialog(base());

        selectAgent('research');
        promoteButton().click();
        expect(applyButton().disabled).toBe(false);

        promoteButton().click();
        expect(promoteButton().getAttribute('aria-pressed')).toBe('false');
        expect(applyButton().disabled).toBe(true);
        expect(applyButton().textContent).toBe('Save configuration');
    });

    it('reports an explicit removal of a member and never removes anyone else', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // Removing is a deliberate press on that agent own panel, and the view moves to
        // a rostered agent rather than configuring an agent the save would drop.
        selectAgent('research');
        removeButton().click();

        expect(tabsOf()).toEqual([['instruct', 'primary', true, 'Instruct', 'm1']]);
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
        // The drafts are gone, so the action is disabled again.
        expect(applyButton().disabled).toBe(true);
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
            ['instruct', 'primary', true, 'Instruct', 'm1'],
            ['research', 'secondary', false, 'Researcher', 'm1']
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
                primary: 'research',
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
        // The strip follows the server: new primary, new member, in the server order.
        expect(tabsOf()).toEqual([
            ['research', 'primary', true, 'Researcher', 'm2'],
            ['instruct', 'secondary', false, 'Instruct', 'm1'],
            ['reviewer', 'secondary', false, 'Reviewer', 'm1']
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
        const tab = byClass('.agent-dialog-tab[data-agent="research"]', 'button');
        tab.focus();
        dialog.update(base({ primary: 'research', members: ['research', 'instruct'] }));
        const rebuiltTab = byClass('.agent-dialog-tab[data-agent="research"]', 'button');
        expect(rebuiltTab).not.toBe(tab);
        expect(document.activeElement).toBe(rebuiltTab);

        const model = modelSelect();
        model.focus();
        dialog.update(base({ primary: 'research', members: ['research', 'instruct'] }));
        const rebuilt = modelSelect();
        expect(rebuilt).not.toBe(model);
        expect(document.activeElement).toBe(rebuilt);
    });

    it('falls back to the primary when the viewed agent leaves the roster and the catalogue', () => {
        dialog = openAgentDialog(base());

        // The viewed agent is a drafted addition, so it only exists while the trusted
        // library still advertises it.
        openPicker();
        byClass('.agent-dialog-add-option[data-agent="reviewer"]', 'button').click();
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('reviewer');

        dialog.update(base({ members: ['research', 'instruct'], primary: 'instruct', agents: [agents[0], agents[1]] }));

        // Configuring an agent the server can no longer reach is meaningless, so the
        // view returns to the primary instead of stranding the reader on a dead badge.
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
        expect(tabsOf().map((tab) => tab[0])).toEqual(['research', 'instruct']);
        expect(tabsOf().map((tab) => tab[2])).toEqual([false, true]);
    });
});

describe('honest restrictions and lifecycle', () => {
    it('locks the instruction and the roster in a saved session and keeps models live', async () => {
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
            'A saved conversation runs the instructions it was created with. Edit them on the harness to use them in a new session.'
        );
        expect(addButton().disabled).toBe(true);
        expect(addButton().title).toBe(hint);
        expect(promoteButton().disabled).toBe(true);
        expect(promoteButton().title).toBe(hint);
        expect(removeButton().disabled).toBe(true);
        expect(removeButton().title).toBe(hint);
        // R2: models stay live in a saved session, so the select is still enabled.
        expect(modelSelect().disabled).toBe(false);

        // The action can only save a model here: it is disabled until one is drafted,
        // so a disabled button can never falsely promote.
        expect(applyButton().textContent).toBe('Save configuration');
        expect(applyButton().disabled).toBe(true);
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
        expect(instructionBox().value).toBe('Investigate.');
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
        dialog.update(base({ primary: 'research' }));
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

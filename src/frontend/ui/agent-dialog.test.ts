// Agent configuration dialog (T3) — module contract.
//
// composer-agent-control.test.ts and main.test.ts exercise this dialog through the
// live shell (real fetch stubs, PATCH bodies). This file pins the DIALOG ITSELF,
// without main.ts, so the rules the product depends on stay covered when the shell
// changes:
//   - ONE dropdown lists every agent, and selecting one shows its configuration;
//   - selection, instruction edits, model edits and the membership toggle are LOCAL
//     drafts: `onApply` is never called by them;
//   - the bottom-right action is the only writer, it is disabled while nothing is
//     pending, and it reports the exact delta (including the promotion);
//   - dismissal (X/backdrop/Escape/`close()`) discards every draft;
//   - a failed apply keeps the dialog open with its drafts and states the reason;
//   - a live `update()` refreshes untouched fields from the server, keeps a touched
//     one, and restores focus (including the caret);
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

const dropdown = (): HTMLSelectElement => byClass('.agent-dialog-agent-select', 'select');
const instructionBox = (): HTMLTextAreaElement => byClass('.agent-dialog-instruction', 'textarea');
const modelSelect = (): HTMLSelectElement => byClass('.agent-model-select', 'select');
const memberToggle = (): HTMLInputElement => byClass('.agent-dialog-member', 'input');
const applyButton = (): HTMLButtonElement => byClass('.agent-dialog-apply', 'button');

// The dropdown entries as [value, visible label], so "every agent is in one dropdown"
// is pinned against the exact server library, not a count.
const entriesOf = (): [string, string][] =>
    [...dropdown().options].map((option) => [option.value, option.textContent ?? '']);

const selectAgent = (name: string): void => {
    const select = dropdown();
    select.value = name;
    select.dispatchEvent(new Event('change', { bubbles: true }));
};

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

describe('the dropdown and the configuration panel', () => {
    it('lists the team first, then every other catalogue agent, with its team state', () => {
        dialog = openAgentDialog(
            base({
                // A saved session can name an agent the catalogue no longer advertises.
                members: ['instruct', 'legacy'],
                onApply: applyOf().onApply
            })
        );

        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Instruct');
        expect(entriesOf()).toEqual([
            ['instruct', 'Instruct · primary'],
            ['legacy', 'Agent · team member'],
            ['research', 'Researcher · not in the team'],
            ['reviewer', 'Reviewer · not in the team']
        ]);

        // The primary is the default view: its instruction and model are on screen.
        expect(instructionBox().getAttribute('aria-label')).toBe('Instruction for Instruct');
        expect(instructionBox().value).toBe('Answer directly.');
        expect(modelSelect().getAttribute('aria-label')).toBe('Model for Instruct');
        expect(memberToggle().checked).toBe(true);
        expect(byClass('.agent-dialog-state', 'p').textContent).toBe('Instruct is the primary agent.');

        // The team rows are the current members, primary first, with their models.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map((row) => [
                row.dataset.agent,
                row.dataset.role,
                row.querySelector('.agent-dialog-agent-name')?.textContent,
                row.querySelector('.agent-dialog-agent-role')?.textContent,
                row.querySelector('.agent-dialog-agent-model')?.textContent
            ])
        ).toEqual([
            ['instruct', 'primary', 'Instruct', 'primary', 'm1'],
            ['legacy', 'secondary', 'Agent', 'subagent', 'm1']
        ]);
    });

    it('shows the selected agent configuration without writing anything', () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');

        // Every visible piece moved to the selected agent...
        expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Researcher');
        expect(byClass('.agent-dialog-config', 'div').dataset.agent).toBe('research');
        expect(byClass('.agent-dialog-state', 'p').textContent).toBe('Researcher is a team member.');
        expect(instructionBox().value).toBe('Investigate.');
        expect(modelSelect().getAttribute('aria-label')).toBe('Model for Researcher');
        // ...and the trusted guidelines are still shown as the preset reference.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-detail .agent-guideline')].map(
                (node) => node.textContent
            )
        ).toEqual(['Cite sources.']);

        // Nothing was written: switching agents is a view change.
        expect(apply.calls).toEqual([]);
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

    it('shows an agent that is not in the team, unchecked, and explains what saving adds', () => {
        dialog = openAgentDialog(base());

        selectAgent('reviewer');

        expect(memberToggle().checked).toBe(false);
        expect(memberToggle().disabled).toBe(false);
        expect(byClass('.agent-dialog-state', 'p').textContent).toBe('Reviewer is not in this team yet.');
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-field-note')].map((node) => node.textContent)
        ).toEqual(['Saving a configuration for an outside agent adds it; no current member is removed.']);
    });
});

describe('drafts', () => {
    it('writes nothing for an instruction edit, a model edit or a membership toggle', () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        typeInstruction('Answer in three words.');
        chooseModel('m2');

        const toggle = memberToggle();
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(apply.calls).toEqual([]);
        // The controls still show the reader's own choices (draft state, not the server's).
        expect(instructionBox().value).toBe('Answer in three words.');
        expect(modelSelect().value).toBe('m2');
        expect(memberToggle().checked).toBe(false);
    });

    it('keeps every agent draft across dropdown switches and shows the pending action', async () => {
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

        // One save carries BOTH agents' deltas, and selecting a member promotes it.
        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            {
                agent: 'research',
                primary: 'research',
                models: { research: 'm2' },
                instructions: { instruct: 'Answer in three words.', research: 'Investigate with sources.' },
                add: [],
                remove: []
            }
        ]);
    });

    it('promotes a non-member and adds it, without touching current members', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('reviewer');
        expect(applyButton().textContent).toBe('Save & set primary');
        expect(applyButton().disabled).toBe(false);

        // Choosing an outside agent is the only reason `add` is ever populated, and it
        // never removes anyone.
        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            {
                agent: 'reviewer',
                primary: 'reviewer',
                models: {},
                instructions: {},
                add: ['reviewer'],
                remove: []
            }
        ]);
    });

    it('reports an explicit removal of a member and never removes anyone else', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        // Removing is about a member the reader is NOT promoting: uncheck Researcher,
        // then go back to the current primary and save from there.
        selectAgent('research');
        const toggle = memberToggle();
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        selectAgent('instruct');
        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([
            { agent: 'instruct', models: {}, instructions: {}, add: [], remove: ['research'] }
        ]);
    });

    it('never removes the agent it is promoting', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(base({ onApply: apply.onApply }));

        selectAgent('research');

        const toggle = memberToggle();
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        applyButton().click();
        await flush();

        // `primary: research` + an empty remove list: promotion wins over a stale
        // uncheck, so the harness cannot end up with a primary outside its team.
        expect(apply.calls).toEqual([
            { agent: 'research', primary: 'research', models: {}, instructions: {}, add: [], remove: [] }
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
            { agent: 'research', primary: 'research', models: { research: '' }, instructions: {}, add: [], remove: [] }
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

        // X / backdrop / Escape all route here (ui/dialog.ts), as does a programmatic
        // close from a lifecycle change.
        dialog.close();

        expect(apply.calls).toEqual([]);
        expect(closed).toEqual(['closed']);
        expect(dialog.isOpen).toBe(false);

        // Re-opening starts from the server state, not from the dropped draft.
        dialog = openAgentDialog(base({ onApply: apply.onApply }));
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
        // The team list follows the server: new primary, new member.
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map((row) => [
                row.dataset.agent,
                row.dataset.role
            ])
        ).toEqual([
            ['research', 'primary'],
            ['instruct', 'secondary'],
            ['reviewer', 'secondary']
        ]);
        // An untouched agent shows the server value.
        selectAgent('instruct');
        expect(modelSelect().value).toBe('');
        expect(instructionBox().value).toBe('Answer directly.');

        selectAgent('reviewer');
        expect(instructionBox().value).toBe('Review every claim.');
        expect(apply.calls).toEqual([]);
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

    it('restores focus on the dropdown and the model select across a rebuild', () => {
        dialog = openAgentDialog(base());

        const select = dropdown();
        select.focus();
        dialog.update(base({ primary: 'research', members: ['research', 'instruct'] }));
        expect(document.activeElement).toBe(dropdown());

        const model = modelSelect();
        model.focus();
        dialog.update(base({ primary: 'research', members: ['research', 'instruct'] }));
        const rebuilt = modelSelect();
        expect(rebuilt).not.toBe(model);
        expect(document.activeElement).toBe(rebuilt);
    });

    it('falls back to the primary when the viewed agent leaves the team and the catalogue', () => {
        dialog = openAgentDialog(base());

        selectAgent('reviewer');
        expect(byClass('.agent-dialog-config', 'div').dataset.agent).toBe('reviewer');

        dialog.update(base({ members: ['research', 'instruct'], primary: 'instruct', agents: [agents[0], agents[1]] }));

        expect(byClass('.agent-dialog-config', 'div').dataset.agent).toBe('instruct');
        expect(dropdown().value).toBe('instruct');
    });
});

describe('honest restrictions and lifecycle', () => {
    it('locks the instruction and membership in a saved session and keeps models live', async () => {
        const apply = applyOf();
        dialog = openAgentDialog(
            base({
                editable: false,
                hint: 'A saved conversation keeps the agent team and the instructions it was created with.',
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

        expect(byClass('.agent-dialog-note', 'p').textContent).toBe(
            'A saved conversation keeps the agent team and the instructions it was created with.'
        );
        expect(instructionBox().disabled).toBe(true);
        expect(memberToggle().disabled).toBe(true);
        // R2: models stay live in a saved session, so the select is still enabled.
        expect(modelSelect().disabled).toBe(false);

        // The action can only save a model here: it is disabled until one is drafted,
        // so a disabled button can never falsely promote.
        expect(applyButton().textContent).toBe('Save configuration');
        expect(applyButton().disabled).toBe(true);
        expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
            'This conversation keeps the team and instructions it was created with. Saving changes only Instruct’s model, from its next request.'        );

        chooseModel('m2');
        expect(applyButton().disabled).toBe(false);

        applyButton().click();
        await flush();

        expect(apply.calls).toEqual([{ agent: 'instruct', models: { instruct: 'm2' }, instructions: {}, add: [], remove: [] }]);
    });

    it('names the lock reason for the membership control on a locked team', () => {
        dialog = openAgentDialog(
            base({ editable: false, hint: 'Wait for the current run to finish before switching agents.' })
        );

        selectAgent('research');

        expect(byClass('.agent-dialog-note', 'p').textContent).toBe(
            'Wait for the current run to finish before switching agents.'
        );
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-field-note')].map((node) => node.textContent)
        ).toEqual(['The team is locked for this conversation.']);
    });

    it('paints activity rings on the team rows without rebuilding the body', () => {
        dialog = openAgentDialog(base());
        const rowsBefore = [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')];

        dialog.paintActivity(new Set(['research']));

        const rowsAfter = [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')];
        // Same nodes: a ring repaint must not recreate the rows (caret/details survive).
        expect(rowsAfter).toEqual(rowsBefore);
        expect(rowsAfter.map((row) => row.dataset.activity)).toEqual([undefined, 'active']);
        expect(rowsAfter.map((row) => row.getAttribute('aria-busy'))).toEqual([null, 'true']);

        dialog.paintActivity(new Set());
        expect(
            [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map((row) => row.dataset.activity)
        ).toEqual([undefined, undefined]);
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

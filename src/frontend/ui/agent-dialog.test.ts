// Shared agent dialog (T5 R11/R12/R13) — module contract.
//
// composer-agent-control.test.ts exercises the dialog through the live shell. This
// file pins the dialog module itself, without main.ts, so its OWN content and update
// rules stay covered when the shell changes:
//   - the primary chooser, the existing deck and the read-only instructions are all
//     present, from the same descriptors the server supplied;
//   - the lock note/hint is painted ONLY when team editing is restricted;
//   - `update()` swaps content in place and restores focus to the SAME logical
//     control (model select, primary button, deck control, instruction summary);
//   - `paintActivity()` paints rings without rebuilding content;
//   - `close()` is idempotent and updates after close are no-ops.

import type { AgentDescriptor } from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openAgentDialog } from './agent-dialog';
import type { AgentDialog, AgentDialogOptions } from './agent-dialog';

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
    }
];

const base = (overrides: Partial<AgentDialogOptions> = {}): AgentDialogOptions => ({
    members: ['instruct', 'research'],
    primary: 'instruct',
    agents,
    editable: true,
    models: {
        models: {},
        catalogue: ['m1', 'm2'],
        fallbackModel: 'm1',
        editable: true,
        onChange: () => undefined
    },
    onSelectPrimary: () => undefined,
    onAdd: () => undefined,
    onRemove: () => undefined,
    ...overrides
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

it('renders the primary chooser, the existing deck and the read-only instructions', () => {
    dialog = openAgentDialog(
        base({
            // A saved session can name an agent the catalogue no longer advertises.
            members: ['instruct', 'research', 'legacy'],
            onFront: () => undefined
        })
    );

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Instruct');
    // No hint when team editing is allowed.
    expect(document.querySelector('.agent-dialog-note')).toBeNull();

    // Primary chooser: current primary pressed+disabled, the others offered.
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-primary')].map((entry) => [
            entry.dataset.agent,
            entry.textContent,
            entry.getAttribute('aria-pressed'),
            entry.disabled
        ])
    ).toEqual([
        ['instruct', 'Instruct', 'true', true],
        ['research', 'Researcher', 'false', false],
        ['legacy', 'Agent', 'false', false]
    ]);

    // The deck is the existing component: one tile per member + the add control.
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.dataset.agent)
    ).toEqual(['instruct', 'research', 'legacy']);
    expect(byClass('.agent-add', 'button').disabled).toBe(false);

    // Instructions: members first, then catalogue agents not in the team, with the
    // neutral fallback detail for the unknown member.
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-detail-summary')].map(
            (summary) => summary.textContent
        )
    ).toEqual(['Instruct', 'Researcher', 'Agent']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-instruction')].map(
            (node) => node.textContent
        )
    ).toEqual([
        'Answer directly.',
        'Investigate.',
        'This server does not advertise an instruction for this agent.'
    ]);
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-guideline')].map(
            (node) => node.textContent
        )
    ).toEqual(['Cite sources.']);
});

it('states the real lock reason and disables only team controls', () => {
    dialog = openAgentDialog(
        base({
            editable: false,
            hint: 'The agent team is locked for this conversation.',
            models: {
                models: {},
                catalogue: ['m1'],
                fallbackModel: 'm1',
                editable: true,
                session: true,
                onChange: () => undefined
            }
        })
    );

    expect(byClass('.agent-dialog-note', 'p').textContent).toBe(
        'The agent team is locked for this conversation.'
    );
    expect(
        [...document.querySelectorAll<HTMLButtonElement>('.agent-dialog-primary')].map(
            (entry) => entry.disabled
        )
    ).toEqual([true, true]);
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    expect(byClass('.agent-add', 'button').disabled).toBe(true);
    // R2: models stay live in a saved session, so the select is still enabled.
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);
});

it('updates in place and restores focus to the same logical control', () => {
    dialog = openAgentDialog(base());

    // Focus restoration by MODEL SELECT (the control a model PATCH destroys).
    const select = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    select.focus();
    expect(document.activeElement).toBe(select);

    dialog.update(
        base({
            primary: 'research',
            models: {
                models: { research: 'm2' },
                catalogue: ['m1', 'm2'],
                fallbackModel: 'm1',
                editable: true,
                onChange: () => undefined
            }
        })
    );

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Researcher');
    const promoted = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Researcher"]',
        'select'
    );
    expect(promoted.value).toBe('m2');
    // Focus returns to the SAME logical control the reader operated (Instruct), not
    // the newly promoted agent: an update must never move them elsewhere.
    const restored = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    expect(restored).not.toBe(select);
    expect(document.activeElement).toBe(restored);
    expect(document.querySelector('.agent-dialog-primary[data-agent="research"]')?.getAttribute('aria-pressed')).toBe(
        'true'
    );

    // Focus restoration by PRIMARY BUTTON: `research` is still an OFFERED (enabled)
    // option, so a rebuild must return focus to its replacement node. The current
    // primary's own button is a disabled no-op and would intentionally be skipped.
    dialog.update(
        base({
            models: {
                models: { instruct: 'm2' },
                catalogue: ['m1', 'm2'],
                fallbackModel: 'm1',
                editable: true,
                onChange: () => undefined
            }
        })
    );
    const research = byClass<HTMLButtonElement>('.agent-dialog-primary[data-agent="research"]', 'button');
    expect(byClass('.agent-dialog-primary[data-agent="instruct"]', 'button').disabled).toBe(true);
    research.focus();
    expect(document.activeElement).toBe(research);

    dialog.update(
        base({
            models: {
                models: { instruct: 'm3' },
                catalogue: ['m1', 'm2', 'm3'],
                fallbackModel: 'm1',
                editable: true,
                onChange: () => undefined
            }
        })
    );

    const moved = byClass('.agent-dialog-primary[data-agent="research"]', 'button');
    expect(moved).not.toBe(research);
    expect(document.activeElement).toBe(moved);
});

it('paints activity rings without rebuilding the content', () => {
    dialog = openAgentDialog(base());
    const tilesBefore = [...document.querySelectorAll<HTMLElement>('.agent-tile')];

    dialog.paintActivity(new Set(['research']));

    const tilesAfter = [...document.querySelectorAll<HTMLElement>('.agent-tile')];
    // Same nodes: a ring repaint must not recreate the deck (focus/details survive).
    expect(tilesAfter).toEqual(tilesBefore);
    expect(tilesAfter.map((tile) => tile.dataset.activity)).toEqual([undefined, 'active']);
    expect(tilesAfter.map((tile) => tile.getAttribute('aria-busy'))).toEqual([null, 'true']);

    dialog.paintActivity(new Set());
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.dataset.activity)
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

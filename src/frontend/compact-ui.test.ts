// Compact chrome acceptance: the responsive UI (R1), the silent composer (R2), the
// GLOBAL tools toggle that replaced the Chat/Tools tabs (R3) and the icon-only phone
// rail controls (R4).
//
// Two contracts are pinned here:
//   - DOM/state: on a phone the harness head and the agent strip are disclosures
//     whose triggers carry `aria-expanded`/`aria-controls`; the Tools toggle is the
//     only way in and out of the tools view and it restores the chat on the second
//     press; nothing claims a tab/tabpanel relationship;
//   - CSS: the compact controls exist ONLY inside the <=860px block, so desktop and
//     tablet keep the previous header, card row and chips. jsdom cannot compute
//     media queries, so the stylesheet source is read the same way the other style
//     tests do.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve_) => setTimeout(resolve_, 30));
};

// One harness, one catalogue tool, one advertised agent preset: enough for boot to
// select a harness, build the card row and open a real tool runner.
const bootstrap = {
    rootPath: '/api',
    presets: [
        {
            name: 'instruct',
            title: 'Instruct',
            description: 'A general instruction-following agent.',
            requiresEndpoint: true,
            agents: ['instruct'],
            tools: [],
            coreTools: ['toolRequest'],
            primary: 'instruct',
            subagents: [],
            builtin: true,
            editable: true
        }
    ],
    tools: [
        {
            name: 'fileRead',
            group: 'Files',
            description: 'Read one or more files.',
            tags: ['files', 'read'],
            visibility: 'searchable',
            parameters: {
                type: 'object',
                properties: {
                    paths: { type: 'array', items: { type: 'string' } }
                },
                required: ['paths']
            }
        }
    ],
    defaults,
    sessions: [],
    agents: [
        {
            name: 'instruct',
            title: 'Instruct',
            description: 'Answers directly.',
            instruction: 'Answer directly.',
            guidelines: []
        }
    ]
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const boot = async (): Promise<void> => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') return json(bootstrap);
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// --- R3: global tools toggle, no tab strip ---------------------------------

it('opens and closes the global tools view from the topbar icon only', async () => {
    await boot();

    const toggle = byClass('.tools-toggle', 'button');
    const stage = byClass('.stage', 'div');
    const head = byClass('.harness-head', 'header');
    // The shared badge next to `.main-title` (main.ts:1534 `headName`). It carries
    // the token-catalogue label in the tools view and stays empty/hidden in chat.
    const badge = byClass('.harness-id', 'span');
    const agentSlot = byClass('.agent-slot', 'div');
    const composer = byClass('.composer', 'form');

    // The icon lives in the topbar's right cluster next to the status pill, NOT in
    // the centre column: it is global, not per-harness.
    expect(toggle.parentElement?.className).toBe('topbar-right');
    expect(byClass('.topbar', 'header').contains(toggle)).toBe(true);
    expect(byClass('.center', 'main').contains(toggle)).toBe(false);

    // No tab/tablist/tabpanel anywhere, and the stage is a plain region.
    expect(document.querySelector('.tabs')).toBeNull();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    expect(stage.getAttribute('role')).toBeNull();
    expect(stage.getAttribute('aria-labelledby')).toBeNull();
    expect(stage.id).toBe('harness-stage');
    expect(toggle.getAttribute('aria-controls')).toBe('harness-stage');

    // Closed by default: the chat owns the stage and the toggle is unpressed.
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Tools');
    expect(toggle.title).toBe('Show or hide the tool catalogue');
    // Boot reached a selected harness, so the global control is usable now.
    expect(toggle.disabled).toBe(false);
    expect(stage.querySelector('.tools-pane')).toBeNull();
    expect(head.querySelector('.main-title')?.textContent).toBe('Instruct');
    // The chat head shows ONLY the display title: the harness registry id
    // (`instruct`) is an internal key, so the badge is emptied and hidden
    // (main.ts:3212-3213 in `renderHarnessChrome`).
    expect(badge.textContent).toBe('');
    expect(badge.hidden).toBe(true);

    // Press: the catalogue LIST replaces the centre column and the harness-only
    // chrome is hidden, exactly as the removed Tools tab did. The list is ALL that
    // opens (R12): the first entry is no longer auto-selected, so there is no
    // runner and no modal yet.
    toggle.click();
    await flush();

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(stage.querySelector('.tools-pane')).not.toBeNull();
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['fileRead']);
    // List-only head: the head describes the CATALOGUE, not a tool.
    expect(head.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(head.querySelector('.harness-id')?.textContent).toBe('catalogue');
    // The tools view re-shows the shared badge (`paintToolsHead`, main.ts:3780-3781):
    // the chat header hid it, so the un-hide is part of the contract.
    expect(badge.hidden).toBe(false);
    expect(head.querySelector('.harness-note')?.textContent).toBe(
        '1 tool · calls run on the harness server'
    );
    // The runner lives in the shared modal now, so nothing of it is mounted while
    // the list is alone on screen.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-runner-slot')).toBeNull();
    expect(document.querySelector('.tool-card')).toBeNull();
    expect(agentSlot.hidden).toBe(true);
    expect(composer.hidden).toBe(true);

    // Activating the entry opens its runner in the shared modal. The button names
    // the popup kind and reports the current selection.
    const toolButton = byClass('.tool-tab-button', 'button');
    expect(toolButton.dataset.tool).toBe('fileRead');
    expect(toolButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(toolButton.getAttribute('aria-pressed')).toBe('false');

    toolButton.click();
    await flush();

    const dialog = byClass('.dialog', 'div');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('fileRead');
    // While the dialog is open the head describes the SELECTED tool (name, group,
    // visibility · tags), not the catalogue.
    expect(head.querySelector('.main-title')?.textContent).toBe('fileRead');
    expect(head.querySelector('.harness-id')?.textContent).toBe('Files');
    // A tool group label, not a harness id: `selectTool` un-hides the badge too
    // (main.ts:3867-3868) even though the chat header keeps it hidden.
    expect(badge.hidden).toBe(false);
    expect(head.querySelector('.harness-note')?.textContent).toBe('searchable · tags: files, read');
    expect(toolButton.getAttribute('aria-pressed')).toBe('true');
    // Opening moves focus onto the modal panel, so the close-time focus restore
    // below is a real move back to the entry rather than a no-op.
    expect(document.activeElement).toBe(dialog);
    // The persistent runner pane is adopted inside the dialog body: slot > pane >
    // the real tool card (schema + arguments + result), not a copy.
    const slot = byClass('.tool-runner-slot', 'div');
    expect(slot.parentElement?.className).toBe('dialog-body');
    expect(byClass('.tool-runner-slot > .pane', 'div').className).toBe('pane');

    const runnerCard = byClass('.tool-runner-slot > .pane .tool-card', 'section');
    expect(runnerCard.className).toBe('tool-card');
    expect(runnerCard.closest('.dialog-body')).toBe(dialog.querySelector('.dialog-body'));
    // The list stays behind the dialog: one screen, one modal.
    expect(stage.querySelector('.tools-pane')).not.toBeNull();
    expect(agentSlot.hidden).toBe(true);
    expect(composer.hidden).toBe(true);

    // Closing the dialog drops the layer, resets the pressed state, re-describes
    // the catalogue in the head and returns focus to the entry that opened it.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-runner-slot')).toBeNull();
    expect(document.querySelector('.tool-card')).toBeNull();
    expect(toolButton.getAttribute('aria-pressed')).toBe('false');
    expect(toolButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(head.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(head.querySelector('.harness-id')?.textContent).toBe('catalogue');
    // Dialog close repaints the catalogue head, which keeps the badge shown.
    expect(badge.hidden).toBe(false);
    expect(head.querySelector('.harness-note')?.textContent).toBe(
        '1 tool · calls run on the harness server'
    );
    expect(document.activeElement).toBe(toolButton);
    expect(stage.querySelector('.tools-pane')).not.toBeNull();
    expect(agentSlot.hidden).toBe(true);
    expect(composer.hidden).toBe(true);

    // Press again: the toggle is the close control too (and it closes any tool
    // layer). The chat comes back with the same harness head, the agent strip and
    // the composer.
    toggle.click();
    await flush();

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(stage.querySelector('.tools-pane')).toBeNull();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(head.querySelector('.main-title')?.textContent).toBe('Instruct');
    // Leaving the tools view restores the chat head from `renderHarnessChrome`:
    // the badge is emptied AND hidden again (main.ts:3212-3213).
    expect(badge.textContent).toBe('');
    expect(badge.hidden).toBe(true);
    expect(agentSlot.hidden).toBe(false);
    expect(composer.hidden).toBe(false);
});

// --- R3: disabled before the catalogue exists ------------------------------

it('keeps the tools toggle disabled until the catalogue has loaded', async () => {
    // A server that never answers: boot is still on the startup pane, so there is no
    // catalogue to show and the global control must not blank that pane.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    await import('./main');

    const toggle = byClass('.tools-toggle', 'button');
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.empty-title')?.textContent).toBe(
        'Connecting to the harness server…'
    );
});

// --- R1: phone disclosures, DOM/state --------------------------------------

it('opens harness details from the clickable title and keeps tools headings inert', async () => {
    await boot();

    const head = byClass('.harness-head', 'header');
    const title = byClass('.main-title', 'h1');
    const button = byClass('.harness-title-button', 'button');
    const note = byClass('.harness-note', 'p');

    // R2: the title is a real BUTTON inside the `h1` (heading semantics preserved),
    // not a disclosure arrow. There is no `.harness-disclosure` control at all.
    expect(document.querySelector('.harness-disclosure')).toBeNull();
    expect(title.contains(button)).toBe(true);
    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.title).toBe('Show harness details');
    // The button's accessible name IS the harness title, so it reads as the heading.
    expect(button.textContent).toBe('Instruct');
    expect(title.textContent).toBe('Instruct');

    // The desktop note stays in the DOM with its text (the phone block hides it; the
    // dialog carries the details instead).
    expect(note.textContent).toBe('Edits apply to new sessions');
    expect(head.dataset.expanded).toBeUndefined();

    // Press: the shared modal opens with the selected harness's own details.
    button.click();
    await flush();

    const dialog = byClass('.dialog', 'div');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('Instruct');
    expect(dialog.querySelector('.harness-details-description')?.textContent).toBe(
        'A general instruction-following agent.'
    );
    // Existing metadata only (the same line the rail rows show): kind · agent count.
    expect(dialog.querySelector('.harness-details-meta')?.textContent).toBe('template · 1 agent');
    // The header note is hidden on a phone, so the dialog carries it too.
    expect(dialog.querySelector('.harness-details-note')?.textContent).toBe(
        'Edits apply to new sessions'
    );
    expect(document.activeElement).toBe(dialog);

    // Closing restores focus to the title button.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    // R2: while the TOOLS view owns the head, the title describes the catalogue (or a
    // tool), so it must not open a harness dialog — the button is disabled and out of
    // the tab order, and a programmatic click is a no-op.
    byClass('.tools-toggle', 'button').click();
    await flush();

    expect(title.textContent).toBe('Tools');
    expect(button.disabled).toBe(true);
    // The disabled heading also drops the popup claim and the action tooltip.
    expect(button.hasAttribute('aria-haspopup')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    button.click();
    await flush();
    expect(document.querySelector('.dialog')).toBeNull();

    // Selecting a tool keeps the head inert as well.
    byClass('.tool-tab-button', 'button').click();
    await flush();
    expect(title.textContent).toBe('fileRead');
    expect(button.disabled).toBe(true);
    button.click();
    await flush();
    // Only the tool runner dialog is open (its title is the tool), never a harness one.
    expect(document.querySelector('.dialog-title')?.textContent).toBe('fileRead');
    expect(document.querySelector('.harness-details')).toBeNull();

    // Leaving the tools view restores the chat head and re-enables the trigger.
    byClass('.dialog-close', 'button').click();
    await flush();
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(title.textContent).toBe('Instruct');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.title).toBe('Show harness details');
});

it('closes the harness details dialog when navigating to another harness', async () => {
    await boot();

    const button = byClass('.harness-title-button', 'button');
    button.click();
    await flush();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Instruct');

    // Picking a harness (here: the same row, which is a full selection pass) closes
    // the dialog rather than leaving stale details on screen (R2).
    byClass('.harness-item', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.harness-details')).toBeNull();
    expect(document.activeElement).toBe(button);
});

it('moves focus to the tools toggle when the details dialog is closed by that switch', async () => {
    // T4: `setToolsView(true)` closes the harness dialog (returning focus to the
    // title) and then disables that title, so without an explicit target the reader
    // would be dropped on <body>. The toggle that performed the switch is the target.
    await boot();

    const button = byClass('.harness-title-button', 'button');
    button.click();
    await flush();
    expect(document.querySelector('.dialog')).not.toBeNull();

    const toggle = byClass('.tools-toggle', 'button');
    toggle.click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(toggle);
});

it('keeps the agent cards reachable from the composer button at every width', async () => {
    await boot();

    // T5 R11/R12: nothing from the deck sits permanently in the chat chrome any more.
    expect(document.querySelector('.agent-row')).toBeNull();
    expect(document.querySelector('.agent-summary')).toBeNull();

    // The single composer button opens the shared dialog, whose content is the
    // existing deck. The DIALOG is the disclosure, so the cards start visible
    // (`data-open` is written by the deck; styles.css pins the always-visible rule).
    byClass('.agent-control-button', 'button').click();

    const row = byClass('.agent-row', 'div');
    const wrap = byClass('.agent-row-wrap', 'div');
    expect(wrap.dataset.open).toBe('true');

    const summary = byClass('.agent-summary', 'button');
    expect(summary.getAttribute('aria-controls')).toBe(row.id);
    expect(summary.querySelector('.agent-summary-label')?.textContent).toBe('Instruct');
    expect(summary.querySelector('.agent-summary-meta')?.textContent).toBe('1 agent');
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    const primary = byClass('.agent-main', 'button');
    const model = byClass('.agent-model-select', 'select');
    const add = byClass('.agent-add', 'button');
    expect(primary.getAttribute('aria-pressed')).toBe('true');
    expect(model.getAttribute('aria-label')).toBe('Model for Instruct');
    expect(add.disabled).toBe(false);
    // The only agent cannot be removed (the same rule as desktop).
    expect(byClass('.agent-remove', 'button').disabled).toBe(true);

    // Closing removes the deck with the modal layer; nothing dead is left behind.
    byClass('.dialog-close', 'button').click();
    expect(document.querySelector('.agent-row')).toBeNull();
});

it('keeps the create-harness close button plain icon-button (F2)', async () => {
    await boot();

    byClass('.new-harness', 'button').click();
    const close = document.querySelector<HTMLButtonElement>('.create-harness .icon-button');
    if (close === null) throw new Error('missing create close button');

    // No `tools-toggle` (or any second) class: the create form's close keeps its own
    // base rule and therefore its previous 0 6px / borderless / 16px look.
    expect(close.className).toBe('icon-button');
    expect(close.textContent).toBe('×');
    expect(close.getAttribute('aria-label')).toBe('Close new harness form');
});

// --- CSS: compact only inside the phone breakpoint -------------------------

const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments NAME the removed selectors, so "must be gone" assertions read the
// stripped stylesheet (same rule as session-control-style.test.ts).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Brace-matched slice, so the nested phone block is never cut at its first `}`.
const blockOf = (selector: string): string => {
    const start = rules.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = rules.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

it('has no tab strip rules left and styles the global icon toggle', () => {
    // R3: the removed Chat/Tools strip owns no CSS any more.
    expect(rules).not.toContain('.tabs');
    expect(rules).not.toContain('.tab {');
    expect(rules).not.toContain(".tab[aria-selected='true']");

    // The icon-only toggle is a 30px square whose pressed state is visible. The rule
    // is SCOPED to `.tools-toggle` (F2) so it cannot collide with, or be overridden
    // by, the pre-existing `.icon-button` close control further down the sheet.
    const button = blockOf('.tools-toggle {');
    expect(button).toContain('width: 30px');
    expect(button).toContain('height: 30px');
    expect(button).toContain('justify-content: center');
    expect(button).toContain('border: 1px solid var(--border-strong)');
    expect(button).toContain('padding: 0');
    expect(button).toContain('font-size: 14px');
    expect(blockOf(".tools-toggle[aria-pressed='true'] {")).toContain(
        'border-color: var(--accent)'
    );
    expect(blockOf('.tools-toggle:disabled {')).toContain('cursor: not-allowed');
    expect(blockOf('.topbar-right {')).toContain('align-items: center');
});

it('leaves the create-harness close baseline alone (F2 cascade guard)', () => {
    // The close button in the create form is the original `icon-button`. The FIRST
    // `.icon-button {` rule in the sheet must still be that control's compact look;
    // a generic 30px bordered rule inserted earlier would silently restyle it (and be
    // overridden later for the tools toggle, which is why the toggle is scoped).
    const iconButton = blockOf('.icon-button {');
    expect(iconButton).toContain('padding: 0 6px');
    expect(iconButton).toContain('border: 0');
    expect(iconButton).toContain('font-size: 16px');
    expect(iconButton).not.toContain('width: 30px');
    expect(rules).not.toContain('.icon-button[aria-pressed');

    // And the toggle does not wear that class at all.
    expect(rules).not.toContain('.icon-button.tools-toggle');
});

it('lets the topbar cluster shrink so the status pill never scrolls the bar (F1)', () => {
    const cluster = blockOf('.topbar-right {');
    // Shrinkable (`0 1 auto`) with `min-width: 0`: two icon rail toggles + the tools
    // icon + a long error status must fit a 320/375px line.
    expect(cluster).toContain('flex: 0 1 auto');
    expect(cluster).toContain('min-width: 0');
    expect(cluster).not.toContain('flex: 0 0 auto');

    // The pill is sized by its content, not by a percentage of the indefinite cluster
    // (which used to keep it at content width and push the topbar to scrollWidth 386).
    const status = blockOf('.topbar-right .status {');
    expect(status.trim()).toBe('max-width: none;');

    // The phone block only makes the pill shrinkable; it must not reintroduce a
    // percentage cap that the scoped rule would then have to fight.
    const phone = blockOf('@media (max-width: 860px)');
    expect(phone).toContain('.status {\n        min-width: 0;\n    }');
    expect(phone).not.toContain('max-width: 50%');

    // The text child owns the truncation (ellipsis), so a long status clips inside the
    // pill instead of widening it.
    expect(blockOf('.status-text {')).toContain('text-overflow: ellipsis');
});

it('keeps the status diagnostic in the live region but out of the visible line (R3)', () => {
    // The concise state is the only VISIBLE text; the diagnostic is a hidden sibling
    // inside the same live region, using the app's existing sr-only recipe.
    const detail = blockOf('.status-detail {');
    expect(detail).toContain('position: absolute');
    expect(detail).toContain('width: 1px');
    expect(detail).toContain('height: 1px');
    expect(detail).toContain('clip-path: inset(50%)');
    expect(detail).toContain('white-space: nowrap');
    // It must never take visible room or paint a second line inside the pill.
    expect(detail).not.toContain('display: none');
    expect(blockOf('.status-text {')).not.toContain('display: none');
});

it('does not clip the title button outline (T4 focus-visible regression)', () => {
    // The heading is the shrinking flex item, but it must NOT clip: the text child
    // owns the ellipsis and the box would cut the button's focus outline.
    const heading = blockOf('.main-title {');
    expect(heading).toContain('flex: 0 1 auto');
    expect(heading).toContain('min-width: 0');
    expect(heading).not.toContain('overflow: hidden');
    expect(heading).not.toContain('text-overflow');

    // The ellipsis still exists, on the element that actually holds the text.
    const text = blockOf('.harness-title-text {');
    expect(text).toContain('overflow: hidden');
    expect(text).toContain('text-overflow: ellipsis');
    expect(text).toContain('white-space: nowrap');
});

it('reveals the compact harness head and agent strip only at <=860px', () => {
    const phone = blockOf('@media (max-width: 860px)');

    // Hidden outside the breakpoint: desktop/tablet keep the always-visible note and
    // the always-visible card row.
    expect(blockOf('.agent-summary {')).toContain('display: none');
    expect(blockOf('.harness-note {')).not.toContain('display: none');
    expect(blockOf('.agent-row {')).toContain('display: flex');
    expect(blockOf('.agent-row {')).not.toContain('display: none');

    // R2: the old disclosure arrow owns no CSS at all any more; the title itself is
    // the (always available) details trigger and is styled as plain heading text.
    expect(rules).not.toContain('.harness-disclosure');
    const titleButton = blockOf('.harness-title-button {');
    expect(titleButton).toContain('border: 0');
    expect(titleButton).toContain('background: none');
    expect(titleButton).toContain('font: inherit');
    expect(titleButton).toContain('cursor: pointer');

    // The phone block keeps one title line: the note is hidden (details live in the
    // dialog) and the agent strip becomes a summary disclosure.
    expect(phone).toContain('.harness-head .harness-note {\n        display: none;\n    }');
    expect(phone).toContain('.agent-summary {\n        display: flex;\n    }');
    expect(phone).toContain(
        ".agent-row-wrap:not([data-open='true']) .agent-row {\n        display: none;\n    }"
    );
    // The compact rows are shorter than the desktop padding they replace.
    expect(phone).toContain('.agent-slot {\n        padding: 6px 14px;\n    }');
    expect(phone).toContain('.harness-head {\n        padding: 8px 14px;\n    }');
    // T4: the phone row centres the title button against the rail toggle, so the
    // focus outline and the toggle share one baseline.
    expect(phone).toContain('.harness-title-row {\n        align-items: center;\n    }');
});

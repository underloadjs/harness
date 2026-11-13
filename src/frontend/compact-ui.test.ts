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
import { viewAwareFetch } from './view-test-support';
import { sessionToolReads } from './session-config-test-support';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve_) => setTimeout(resolve_, 30));
};

// One harness, one catalogue tool, one advertised agent preset: enough for boot to
// select a harness, build the card row and open a real tool runner.
//
// T45: the body stays the compact legacy shape (`{rootPath, presets, tools, agents,
// defaults, sessions}`) because that is the cheapest way to describe a server, but it is
// no longer handed to the browser raw. `viewAwareFetch` (./view-test-support.ts) re-acts
// it as the canonical control plane the shell actually dials: the service document, the
// global config, ONE PAGE PER CATALOGUE (`/harnesses`, `/tools`, `/agents`, `/sessions`)
// and the identified definition read (`/harnesses/:name`, which the configuration dialog
// triggers) — the last three composed from this same fixture, so nothing here invents a
// payload the fixture does not state. Without that adapter the client booted offline
// (no page, no card, no definition) and every chrome assertion below read an empty head.
// T4: the conversation boot resolves for the only harness. The ⚒/⚙ toggles describe THIS
// conversation (main.ts `configScope`), so a fixture that opens either pane has to name one;
// `harness: 'instruct'` matches `presets[0]`, which is what makes boot open it instead of
// landing on an empty harness view.
const SESSION = {
    id: 's1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    turns: []
};

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
            name: 'read',
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
    // T4: BOTH header catalogues configure the CONVERSATION on screen, and main.ts stops
    // RENDERING them while none is bound (`paintControls` sets `hidden` on
    // `.harness-title-tools`, `styles.css` `.harness-title-tools[hidden]`). A fixture with an
    // empty roster therefore has no ⚒ button to press at all — see the two new toggle tests
    // at the bottom of this file, which pin exactly that — so the chrome tests below boot with
    // one conversation of the only harness. `harness: 'instruct'` is what makes boot open it.
    sessions: [SESSION],
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

// The boot body with the ROSTER and the HARNESS LIST decided by the caller: `boot()` keeps the
// one conversation the chrome tests need, `bootWith([])` describes a server whose harness has
// none, and the second argument adds harnesses (the unbound-state test below needs one the
// reader can switch to).
const bootWith = async (
    sessions: readonly unknown[],
    presets: readonly unknown[] = bootstrap.presets
): Promise<void> => {
    // Canonical adapter OUTSIDE, the fixture's raw routes INSIDE: the shell dials
    // `/v1/harness/*`, the adapter rewrites each of those to the raw twin this fixture
    // declares (`/api`, `/api/models`) and composes the pages/definition from that same
    // boot body (see the note above `bootstrap`).
    //
    // T4: binding a conversation adds three routes the shell never dialled before — the roster
    // that names it, the view open behind the rail pill boot selects, and the toolbox page the
    // ⚒ pane reads on its FIRST open (./session-config-test-support.ts `sessionToolReads`, which
    // answers that page AND the identified `GET /tools/{name}` the runner needs from the ONE
    // `tools` list above, so the catalogue, the pane and the runner cannot disagree). The double
    // stays strict: anything else is an `unexpected request`.
    const body = { ...bootstrap, presets: [...presets], sessions: [...sessions] };

    vi.stubGlobal(
        'fetch',
        vi.fn(
            viewAwareFetch(async (input: RequestInfo | URL) => {
                const url = String(input);

                if (url === '/api') return json(body);
                if (url === '/api/models') return json({ models: ['m1'] });
                if (url === '/api/sessions' || url === '/api/sessions?limit=25') return json({ sessions: [...sessions] });
                if (sessions.length > 0 && url === '/api/sessions/s1') return json({ session: SESSION });

                const toolReads = sessionToolReads(body.tools, url);

                if (toolReads !== undefined) return toolReads;

                throw new Error(`unexpected request: ${url}`);
            }, { root: '/api' })
        )
    );

    await import('./main');
    await flush();
    await flush();
};

const boot = async (): Promise<void> => {
    await bootWith([SESSION]);
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

it('opens and closes the global tools view from the session-line icon only', async () => {
    await boot();

    const toggle = byClass('.tools-toggle', 'button');
    const stage = byClass('.stage', 'div');
    const head = byClass('.harness-head', 'header');
    // The shared badge next to `.main-title` (the `headName` span in main.ts). It names a
    // SELECTED tool's GROUP (the runner head) or `built-ins` (the Plugins head) only; in
    // chat AND in the tools catalogue it is blanked + hidden — the catalogue's own word
    // lives in the title now ("Tools Catalogue"), so the badge has nothing left to say
    // (`paintToolsHead`, and the chat head's own hide in `renderHarnessChrome`).
    const badge = byClass('.harness-id', 'span');
    const agentSlot = byClass('.agent-slot', 'div');
    const composer = byClass('.composer', 'form');

    // The icon lives on the harness TITLE ROW (same line as the title, the session id
    // chip and the `+`), in the right-aligned `.harness-title-tools` group — NOT in the
    // topbar corner. The pane this icon opens is presented FOR the session in view, so it
    // belongs with the session display; only the app-wide status pill stays in the corner.
    // (What the pane WRITES is deployment-wide — see the RELOCATION note in main.ts beside
    // `titleRow.append`.)
    const group = byClass('.harness-title-tools', 'div');
    expect(toggle.parentElement).toBe(group);
    expect(group.parentElement?.className).toBe('harness-title-row');
    expect(head.contains(toggle)).toBe(true);
    expect(byClass('.topbar', 'header').contains(toggle)).toBe(false);
    expect(byClass('.center', 'main').contains(toggle)).toBe(true);
    // The corner cluster is the status pill alone.
    expect([...byClass('.topbar-right', 'div').children]).toEqual([
        byClass('.status-button', 'button')
    ]);

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
    // T4: and it is RENDERED, because this boot has a conversation bound. Being unusable and
    // being absent are different states, and only the second one is the unbound case: with no
    // conversation `paintControls` puts `hidden` on the group AND on each toggle, so the DOM has
    // nothing to press instead of a greyed-out promise of an empty pane (the two `hidden` tests
    // at the end of this file pin the other half, including the CSS that makes `hidden` stick).
    expect(group.hidden).toBe(false);
    expect(toggle.hidden).toBe(false);
    expect(byClass('.plugins-toggle', 'button').hidden).toBe(false);
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
    ).toEqual(['read']);
    // List-only head: the head describes the CATALOGUE, not a tool (R2: the view is
    // named "Tools Catalogue", the same words the pane's own `h2` uses).
    expect(head.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(head.querySelector('.harness-id')?.textContent).toBe('');
    // R2 (Tools Catalogue): the stray `catalogue` word that used to hang to the right of
    // the "+" is GONE. The title carries that word, so `paintToolsHead` blanks the shared
    // badge and hides it, exactly the way `renderHarnessChrome` hides it in chat — the
    // badge is spare room for the title, not a second label.
    expect(badge.hidden).toBe(true);
    // T4: the note states THIS CONVERSATION's toolbox — the count of rows the session read
    // returned — and no longer asserts anything about where a call runs. The manual runner
    // keeps its own playground note (`createToolRunner`), which is where "calls run on the
    // harness server" is still true (`tools-runner-copy.test.ts` pins it there).
    expect(head.querySelector('.harness-note')?.textContent).toBe('1 tool · the toolbox of this conversation');
    // The runner lives in the shared modal now, so nothing of it is mounted while
    // the list is alone on screen.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-runner-slot')).toBeNull();
    expect(document.querySelector('.tool-card')).toBeNull();
    expect(agentSlot.hidden).toBe(true);
    expect(composer.hidden).toBe(true);

    // R1 (the swap): the row's two activations are two nodes. The TILE is the conversation's
    // enable/disable switch — `read` is a switchable name the session reports enabled, so its
    // tile is pressed and carries no lock. The corner MARK is what opens a runner, and it names
    // the popup kind and reports whether ITS dialog is open.
    const toolTile = byClass('.tool-tab-button', 'button');
    const toolMark = byClass('.tool-tab-info', 'button');

    expect(toolTile.dataset.tool).toBe('read');
    expect(toolTile.getAttribute('aria-pressed')).toBe('true');
    expect(toolTile.getAttribute('aria-haspopup')).toBeNull();
    expect(toolTile.dataset.locked).toBeUndefined();
    expect(toolMark.dataset.tool).toBe('read');
    expect(toolMark.getAttribute('aria-haspopup')).toBe('dialog');
    expect(toolMark.getAttribute('aria-expanded')).toBe('false');
    expect(toolMark.getAttribute('aria-label')).toBe('Details for read');

    toolMark.click();
    await flush();

    const dialog = byClass('.dialog', 'div');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('read');
    // While the dialog is open the head describes the SELECTED tool (name, group,
    // visibility · tags), not the catalogue.
    expect(head.querySelector('.main-title')?.textContent).toBe('read');
    expect(head.querySelector('.harness-id')?.textContent).toBe('Files');
    // A tool group label, not a harness id: `selectTool` un-hides the badge too
    // (main.ts:3867-3868) even though the chat header keeps it hidden.
    expect(badge.hidden).toBe(false);
    expect(head.querySelector('.harness-note')?.textContent).toBe('searchable · tags: files, read');
    // The OPEN figure belongs to the mark; the tile's `aria-pressed` is the enabled figure and
    // opening a dialog says nothing about it (the two figures stay independent by design).
    expect(toolMark.getAttribute('aria-expanded')).toBe('true');
    expect(toolMark.dataset.open).toBe('true');
    expect(toolTile.getAttribute('aria-pressed')).toBe('true');
    // Opening moves focus onto the modal panel, so the close-time focus restore
    // below is a real move back to the mark rather than a no-op.
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

    // Closing the dialog drops the layer, resets the mark's expanded state, re-describes the
    // catalogue in the head, and returns focus to the MARK that opened it (`returnFocus`).
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-runner-slot')).toBeNull();
    expect(document.querySelector('.tool-card')).toBeNull();
    expect(toolMark.getAttribute('aria-expanded')).toBe('false');
    expect(toolMark.dataset.open).toBeUndefined();
    expect(toolTile.getAttribute('aria-pressed')).toBe('true');
    expect(head.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(head.querySelector('.harness-id')?.textContent).toBe('');
    // Dialog close repaints the catalogue head (`paintToolsHead`), which keeps the shared
    // badge blanked + hidden — closing a runner does not bring the stray word back.
    expect(badge.hidden).toBe(true);
    // T4: closing a runner repaints the SAME conversation's tally — the rows are still the ones
    // this conversation's read returned, and nothing re-dials the toolbox on a dialog close.
    expect(head.querySelector('.harness-note')?.textContent).toBe('1 tool · the toolbox of this conversation');
    expect(document.activeElement).toBe(toolMark);
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
    // T7 (R2): the Plugins toggle sits next to it and answers to the SAME gate — no
    // catalogue read has landed, so opening it would replace the startup pane with an
    // empty list.
    const plugins = byClass('.plugins-toggle', 'button');
    expect(plugins.disabled).toBe(true);
    expect(plugins.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.empty-title')?.textContent).toBe(
        'Connecting to the harness server…'
    );
});

// --- T4: the two catalogues configure ONE conversation ---------------------

// A second harness with NO conversation of its own. Selecting it is the pointer release
// `syncConfigScope` watches (a harness with nothing to show stays unbound — no conversation is
// created on entry), so the page can move rendered → absent → rendered without a create or a
// delete request, and without a fetch route this file does not already serve.
const RESEARCH = { ...bootstrap.presets[0], name: 'research', title: 'Research' };

const harnessRow = (title: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.harness-item')].find(
        (node) => node.textContent?.includes(title) === true
    );

    if (found === undefined) throw new Error(`no rail row titled ${title}`);

    return found;
};

it('renders both header catalogues only while a conversation is bound', async () => {
    // The ⚒ and ⚙ panes read and write the conversation on screen (`main.ts` `configScope`), so
    // with no conversation there is nothing for either button to open. The Decision is to stop
    // RENDERING them: `paintControls` puts `hidden` on the `.harness-title-tools` group and on
    // each button, and the layout claim lives in the CSS test below.
    await bootWith([SESSION], [bootstrap.presets[0], RESEARCH]);

    const group = byClass('.harness-title-tools', 'div');
    const tools = byClass('.tools-toggle', 'button');
    const plugins = byClass('.plugins-toggle', 'button');

    // Boot resolves the one conversation `instruct` has, so all three are in the document.
    expect(group.hidden).toBe(false);
    expect(tools.hidden).toBe(false);
    expect(plugins.hidden).toBe(false);

    // The harness with nothing to show: the pointer is released, and both catalogues leave with
    // it. They are ABSENT, not disabled-and-explained — `disabled` keeps its single meaning
    // ("the server never answered", the state `showOffline` leaves behind), so the controls stay
    // enabled while hidden and no tooltip has to claim a reason the reader cannot act on. The
    // unbound guard is at the pane's own edge instead: `loadSessionTools`/`loadPlugins` never
    // dial a request for a missing id.
    harnessRow('Research').click();
    await flush();

    expect(group.hidden).toBe(true);
    expect(tools.hidden).toBe(true);
    expect(plugins.hidden).toBe(true);
    expect(tools.disabled).toBe(false);
    expect(plugins.disabled).toBe(false);

    // Back to the harness that has a conversation: the same pointer path re-binds it and both
    // icons return. The rows are re-read on the next open rather than carried — the caches were
    // dropped when the pointer was released (`invalidateConfigPanes`).
    harnessRow('Instruct').click();
    await flush();

    expect(group.hidden).toBe(false);
    expect(tools.hidden).toBe(false);
    expect(plugins.hidden).toBe(false);
});

// --- R1: phone disclosures, DOM/state --------------------------------------

it('opens harness details from the clickable title and keeps the dashboard reachable from the tools head', async () => {
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

    // The desktop note's text is what the details dialog below carries. T4: this boot has a
    // CONVERSATION open, and a saved conversation's head carries no note at all —
    // `renderHarnessChrome` blanks it and sets `hidden` (main.ts:6891-6908), because
    // "Edits apply to new sessions" is a sentence about the harness definition, not about the
    // conversation on screen. The element stays in the DOM (the phone block and the archived
    // branches both need it back), it is simply empty and hidden here.
    expect(note.textContent).toBe('');
    expect(note.hidden).toBe(true);
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
    // The header note is hidden on a phone, so the dialog repeats it — and T3/R1 left a saved
    // conversation with NO note, so there is nothing to repeat here: the element is absent, not
    // empty (`main.ts:3963`). The sentence itself still belongs to the harness definition, and
    // the unbound case (`bootWith([])`, and the archived branch) is where it prints.
    expect(dialog.querySelector('.harness-details-note')).toBeNull();
    // The aggregate totals render HERE because this boot has a conversation: the row is gated on
    // `summary.sessions > 0` (main.ts:3948-3955), which an empty roster failed and one
    // conversation passes. Its single figure is the thread tally across every conversation of
    // this harness, and the conversation this fixture ships has no turns, so the exact answer is
    // zero (`session-pills.test.ts` pins the row's other shapes, including its stale-frame no-op).
    const stats = byClass('.harness-details-stats', 'p');

    expect(
        [...stats.querySelectorAll<HTMLElement>('.harness-details-stat')].map((node) => [node.title, node.textContent])
    ).toEqual([['Threads across all sessions of this harness', '0 threads']]);
    expect(document.activeElement).toBe(dialog);

    // Closing restores focus to the title button.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    // R2 (T9): while the TOOLS view owns the head, the title describes the catalogue, so
    // the popup it opens is the SESSION dashboard — the reader's only way to a saved
    // conversation from here. The trigger stays enabled and in the tab order, and its
    // tooltip says what it really opens instead of promising "harness details".
    byClass('.tools-toggle', 'button').click();
    await flush();

    expect(title.textContent).toBe('Tools Catalogue');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.title).toBe('Show sessions');

    button.click();
    await flush();

    const toolsDialog = byClass('.dialog', 'div');
    // Sessions only: the head is naming the catalogue, not the selected harness, so no
    // harness copy/metadata/note/totals ride along (harness-delete-main.test.ts pins the
    // same shape for the empty-roster case).
    expect(toolsDialog.querySelector('.dialog-title')?.textContent).toBe('Sessions');
    expect(toolsDialog.querySelector('.harness-details-section')?.textContent).toBe('Sessions');
    expect(toolsDialog.querySelector('.harness-details-description')).toBeNull();
    expect(toolsDialog.querySelector('.harness-details-meta')).toBeNull();
    expect(toolsDialog.querySelector('.harness-details-note')).toBeNull();
    // The tools view keeps its own state underneath: the catalogue is still the stage.
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();

    byClass('.dialog-close', 'button').click();
    await flush();
    expect(document.querySelector('.dialog')).toBeNull();

    // Selecting a tool retitles the head but not the affordance: the heading names the
    // tool, the runner is the front layer, and no harness details leak in.
    // R1 (swap): the tool dialog opens from the row's CORNER MARK, not from the tile —
    // the tile's press writes enablement. Same head/affordance contract either way.
    byClass('.tool-tab-info', 'button').click();
    await flush();
    expect(title.textContent).toBe('read');
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Show sessions');
    // Only the tool runner dialog is open (its title is the tool), never a harness one.
    expect(document.querySelector('.dialog-title')?.textContent).toBe('read');
    expect(document.querySelector('.harness-details')).toBeNull();

    // Leaving the tools view restores the chat head and its details wording.
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
    // T4: `setToolsView(true)` closes the harness dialog (returning focus to the title) and
    // then re-titles that same trigger for the tools view, so without an explicit target the
    // reader would be dropped on <body>. The toggle that performed the switch is the target.
    await boot();

    const button = byClass('.harness-title-button', 'button');
    button.click();
    await flush();
    expect(document.querySelector('.dialog')).not.toBeNull();

    const toggle = byClass('.tools-toggle', 'button');
    toggle.click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    // T9: the trigger is NOT disabled by the switch — it is how the reader still reaches the
    // session dashboard from the tools view — it just changes what it advertises.
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Show sessions');
    expect(document.activeElement).toBe(toggle);
});

it('keeps the agent configuration reachable from the composer button at every width', async () => {
    // This test is about the composer's agent button and the dialog it opens, not about the
    // session-scoped panes, so it boots the way this file always did: a harness with NO
    // conversation. The dialog therefore edits the harness TEMPLATE — which is the state whose
    // remove/promote/`[+]` rules are pinned below; a saved conversation edits its own frozen
    // roster instead (./main.ts `ensureSession`'s note, pinned in the agent-dialog suite).
    await bootWith([]);

    // Nothing from the old deck sits permanently in the chat chrome any more.
    expect(document.querySelector('.agent-row')).toBeNull();
    expect(document.querySelector('.agent-summary')).toBeNull();
    expect(document.querySelector('.agent-control-popover')).toBeNull();

    // The single composer button opens the configuration dialog. It is a form, not a
    // card deck: no `.agent-row-wrap`, no phone summary, no add picker.
    byClass('.agent-control-button', 'button').click();

    expect(document.querySelector('.agent-row-wrap')).toBeNull();
    expect(document.querySelector('.agent-add')).toBeNull();
    expect(document.querySelector('.agent-main')).toBeNull();

    // R3: the roster is a strip of clickable badges, and it names itself for a screen
    // reader. Only this harness's own members are listed.
    expect(byClass('.agent-dialog-tabs', 'div').getAttribute('role')).toBe('tablist');
    expect(byClass('.agent-dialog-tabs', 'div').getAttribute('aria-label')).toBe('Agent team');
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => tab.dataset.agent)
    ).toEqual(['instruct']);
    expect(document.querySelector('.agent-dialog-agent-select')).toBeNull();
    expect(byClass('.agent-dialog-instruction', 'textarea').getAttribute('aria-label')).toBe(
        'Instruction for Instruct'
    );
    expect(byClass('.agent-model-select', 'select').getAttribute('aria-label')).toBe(
        'Model for Instruct'
    );

    // The only agent is the primary, so it cannot leave the team (the same rule the
    // desktop deck enforced with a disabled remove button), stated on the control
    // rather than in a paragraph, and `[+]` has nothing left to offer.
    expect(byClass('.agent-dialog-remove', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-remove', 'button').title).toBe(
        'The primary agent is always part of the team.'
    );
    expect(byClass('.agent-dialog-promote', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-add', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-add', 'button').title).toBe(
        'Every agent the server offers is already on this team.'
    );

    // One writer, and it is the action in the footer.
    expect(document.querySelectorAll('.agent-dialog-apply')).toHaveLength(1);

    // Closing removes the form with the modal layer; nothing dead is left behind.
    byClass('.dialog-close', 'button').click();
    expect(document.querySelector('.agent-dialog')).toBeNull();
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

// Same brace matching as `blockOf`, anchored on the LAST match. The sheet has six
// `@media (forced-colors: active)` blocks (first at styles.css:1667, the catalogue-tile
// rescue in the last one at 9330), so `blockOf` alone can never reach that rescue.
const blockOfLast = (selector: string): string => {
    const start = rules.lastIndexOf(selector);
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

    // RELOCATION: the two icons are styled by these SAME unscoped rules (no rule was ever
    // scoped to `.topbar-right`), so moving them cost no styling. Their new parent is a
    // right-aligned, non-shrinking flex group — the icons can never be squeezed. Two items
    // give room back instead: `.main-title` is the only one that truncates the TITLE
    // (ellipsis on `.harness-title-text`), and `.harness-id` is a second shrinker — it
    // declares no `flex: 0 0 auto`, so its default `flex-shrink: 1` stands and its
    // `overflow: hidden` lowers the automatic minimum to 0. That second shrinker is what
    // makes the narrow-line arithmetic in styles.css:1696-1704 true.
    const toolsGroup = blockOf('.harness-title-tools {');
    expect(toolsGroup).toContain('flex: 0 0 auto');
    expect(toolsGroup).toContain('margin-left: auto');
    // The row itself can still give room back, so the auto margin cannot force a sideways
    // scroll on a 320/375px line.
    expect(blockOf('.harness-title-row {')).toContain('min-width: 0');
    // The second shrinker, pinned both halves: no `flex: 0 0 auto` (so `flex-shrink: 1`
    // stands) and `overflow: hidden` (so its automatic minimum drops to 0 and it can give
    // the row real room on a narrow line).
    const idSpan = blockOf('.harness-name,\n.harness-id {');
    expect(idSpan).not.toContain('flex: 0 0 auto');
    expect(idSpan).toContain('overflow: hidden');

    // The responsive claim, asserted instead of reasoned: the phone block carries NO rule
    // for the group, so no breakpoint can resize, re-wrap, re-order or hide the two icons.
    // They are one identical control at every width, like the session controls beside them.
    expect(blockOf('@media (max-width: 860px)')).not.toContain('.harness-title-tools');

    // T7 (R2): the Plugins toggle is styled by its OWN rules — never a shared
    // `.tools-toggle, .plugins-toggle` selector list — so the tools block pinned above
    // stays byte-for-byte what it always was, and restyling one catalogue icon cannot
    // silently move the other. Same 30px square, same pressed/disabled vocabulary.
    const pluginsButton = blockOf('.plugins-toggle {');
    expect(pluginsButton).toContain('width: 30px');
    expect(pluginsButton).toContain('height: 30px');
    expect(pluginsButton).toContain('justify-content: center');
    expect(pluginsButton).toContain('border: 1px solid var(--border-strong)');
    expect(pluginsButton).toContain('padding: 0');
    expect(pluginsButton).toContain('font-size: 14px');
    expect(blockOf(".plugins-toggle[aria-pressed='true'] {")).toContain(
        'border-color: var(--accent)'
    );
    expect(blockOf('.plugins-toggle:disabled {')).toContain('cursor: not-allowed');
    expect(blockOf('.plugins-toggle-icon {')).toContain('font-size: 15px');
    // The tools rules were not turned into a shared list.
    expect(rules).not.toContain('.tools-toggle, .plugins-toggle');
    expect(rules).not.toContain('.plugins-toggle, .tools-toggle');
});

// R1 (THE SWAP): each catalogue row now carries its own enable/disable SWITCH in the tile itself
// and a corner INFO BUTTON in the tile's top-right corner. A row is still a WRAPPER
// (`.tool-tab-row` / `.plugin-tab-row`) holding its two controls as siblings — a `<button>` cannot
// contain a control. The plugins pane moved the same way (R2/R3): its native tick box is gone and
// the corner mark is now a button the sheet has to paint. The tile says "enabled" on the BORDER,
// and since the swap the SELECTION figure lives on the corner control rather than on the tile, so
// the two figures cannot collide in one cascade at all. What stays per pane is the SELECTOR — the
// two catalogues are deliberately never merged into one selector list, so restyling one row can
// never move the other.
it('lays out each catalogue row as a switch tile plus its own corner info control', () => {
    // The wrapper is a flex line AND the positioning context the corner control anchors to;
    // the tile takes the remaining width and can shrink (a long tool name still clamps instead of
    // pushing the layout), and it reserves the corner so text never runs under the mark.
    expect(blockOf('.tool-tab-row {')).toContain('display: flex');
    expect(blockOf('.tool-tab-row {')).toContain('position: relative');
    expect(blockOf('.tool-tab-row .tool-tab-button {')).toContain('flex: 1 1 auto');
    expect(blockOf('.tool-tab-row .tool-tab-button {')).toContain('min-width: 0');
    expect(blockOf('.tool-tab-row .tool-tab-button {')).toContain('padding-right: 32px');
    expect(blockOf('.plugin-tab-row {')).toContain('display: flex');
    expect(blockOf('.plugin-tab-row {')).toContain('position: relative');
    expect(blockOf('.plugin-tab-row .plugin-tab-button {')).toContain('flex: 1 1 auto');
    expect(blockOf('.plugin-tab-row .plugin-tab-button {')).toContain('min-width: 0');
    expect(blockOf('.plugin-tab-row .plugin-tab-button {')).toContain('padding-right: 34px');

    // Both corner controls are absolutely positioned in the wrapper and LIFTED above the tile by
    // `z-index` — that pairing is what makes a press on the corner land on the corner and never
    // reach the tile's handler. Both are now the SAME kind of control: a bordered 20px square the
    // sheet paints, sized around the shared 13px glyph.
    for (const selector of ['.tool-tab-info', '.plugin-tab-info']) {
        expect(blockOf(`${selector} {`)).toContain('position: absolute');
        expect(blockOf(`${selector} {`)).toContain('z-index: 1');
        expect(blockOf(`${selector} {`)).toContain('cursor: pointer');
        expect(blockOf(`${selector} {`)).toContain('width: 20px');
        expect(blockOf(`${selector} {`)).toContain('height: 20px');
        expect(blockOf(`${selector} {`)).toContain('border: 1px solid var(--border-strong)');
        expect(blockOf(`${selector} {`)).toContain('background: var(--bg-elevated)');
        expect(blockOf(`${selector} {`)).toContain('color: var(--muted)');
        expect(blockOf(`${selector}:hover {`)).toContain('border-color: var(--accent)');
        expect(blockOf(`${selector}:focus-visible {`)).toContain('outline: 2px solid var(--accent)');
    }

    // Each pane owns its corner INSET — the two catalogues have different tile padding, and the
    // mark is centred on the card's title line in each. This is the pair of numbers that keeps a
    // clamped title or description from running under the mark (see the `padding-right` above).
    expect(blockOf('.tool-tab-info {')).toContain('top: 8px');
    expect(blockOf('.tool-tab-info {')).toContain('right: 9px');
    expect(blockOf('.plugin-tab-info {')).toContain('top: 11px');
    expect(blockOf('.plugin-tab-info {')).toContain('right: 12px');

    // The native checkbox and its rules are gone from this pane, in both spellings: a tick box
    // cannot be locked-but-not-disabled, and its state was a FILL (`accent-color`), which is the
    // one channel this contract keeps free for the selection figure.
    expect(rules).not.toContain('.plugin-tab-enable');
    expect(rules).not.toContain('accent-color: var(--ok)');

    // The glyph itself is ONE rule for every copy in the frontend (./ui/info-icon.ts is data
    // only — `fill="none"` rides the element). `stroke: currentColor` is what lets the control's
    // own `color` state carry the mark, and it is why the open state needs no second glyph rule.
    const glyph = blockOf('.info-icon {');

    expect(glyph).toContain('fill: none');
    expect(glyph).toContain('stroke: currentColor');
    expect(glyph).toContain('stroke-width: 1.7');
    expect(glyph).toContain('width: 13px');
    expect(glyph).toContain('height: 13px');

    // THE selection figure of the tools pane: the mark of the row whose runner is open. This is
    // the accent pair the tile used to carry, and it is the ONLY place that pair appears in this
    // pane — so "enabled" (the tile's green edge) and "open" (the mark's accent) stay two
    // readable, non-competing states.
    const toolInfoOpen = blockOf(".tool-tab-info[aria-expanded='true'] {");

    expect(toolInfoOpen).toContain('border-color: var(--accent)');
    expect(toolInfoOpen).toContain('background: var(--accent-soft)');
    expect(toolInfoOpen).toContain('color: var(--text)');

    // R1: the TOOLS tile carries "enabled" on its EDGE only — `--ok-line` border over the
    // tile's normal `--bg-elevated` surface. The green wash is gone from this pane because
    // the BACKGROUND is the SELECTION channel: the mark of the open row fills with
    // `--accent-soft` (pinned above), so the two figures can never collide. The rule must
    // not declare a background at all — the elevated surface is inherited from the base
    // `.tool-tab-button {` rule, and any enabled background here would sit on the selection
    // channel and make "enabled" and "selected" unreadable on the same tile.
    const toolEnabled = blockOf(".tool-tab-button[data-enabled='true'] {");

    expect(toolEnabled).toContain('border-color: var(--ok-line)');
    expect(toolEnabled).not.toContain('var(--ok-wash)');
    expect(toolEnabled).not.toContain('background');

    // Hover strengthens the SAME edge (never adds a tint).
    expect(blockOf(".tool-tab-button[data-enabled='true']:hover:not(:disabled) {")).toContain(
        'border-color: var(--ok)'
    );
    expect(blockOf('.tool-tab-button {')).toContain('border: 1px solid transparent');
    expect(blockOf('.tool-tab-button {')).toContain('background: var(--bg-elevated)');

    // Since the swap the tile's `aria-pressed` IS the enabled figure, so the accent "selected"
    // rule that used to sit on it is GONE — an accent border there would repaint the green edge
    // on every enabled row. The tick box's own rules left with its markup too, in BOTH panes.
    expect(rules).not.toContain(".tool-tab-button[aria-pressed='true']");
    expect(rules).not.toContain(".plugin-tab-button[aria-pressed='true']");
    expect(rules).not.toContain('.tool-tab-enable');

    // A locked switch is inert but never `disabled`, so the cursor is the only thing that can
    // say it. R5 cut the reason set to the states that really refuse a write: `writing` (this
    // tile's own PATCH is in flight) plus the two the lock helper cannot see — `offline` for the
    // tools tile when no server answers, and `no-enablement` for a row whose server reported no
    // figure at all. The `protected` and `running` markers are gone, because a harness-owned name
    // and a working conversation both answer a switch now; the Plugins pane always had the
    // shorter set (`writing` / `offline`). Both panes keep the progress cursor for `writing`.
    expect(blockOf('.tool-tab-button[data-locked] {')).toContain('cursor: default');
    expect(blockOf(".tool-tab-button[data-locked='writing'] {")).toContain('cursor: progress');

    // The PLUGINS twin now MATCHES the tools twin: a ticked plugin row carries the green on
    // its EDGE only, over the elevated surface the base rule already gives it. The wash left
    // this pane for the same reason it left tools — the background there is the SELECTION
    // channel (`.plugin-tab-info[aria-expanded='true']` fills with `--accent-soft`, pinned
    // below), so a green fill and an accent fill would collide on the row whose dialog is
    // open. The rule declares NO background at all; the old `background-color:
    // var(--bg-elevated)` companion existed only as the layer UNDER the wash gradient and has
    // no purpose once the gradient is gone.
    const pluginEnabled = blockOf(".plugin-tab-button[data-enabled='true'] {");

    expect(pluginEnabled).toContain('border-color: var(--ok-line)');
    expect(pluginEnabled).not.toContain('var(--ok-wash)');
    expect(pluginEnabled).not.toContain('background');
    expect(blockOf(".plugin-tab-button[data-enabled='true']:hover:not(:disabled) {")).toContain(
        'border-color: var(--ok)'
    );
    expect(blockOf('.plugin-tab-button {')).toContain('border: 1px solid transparent');
    expect(blockOf('.plugin-tab-button {')).toContain('background: var(--bg-elevated)');

    // THE selection figure of the plugins pane, exactly as in tools: the mark of the row whose
    // settings layer is open. `blockOf` takes the FIRST rule for a selector, and there is no
    // second one here — the forced-colours twin below is inside a `@media`, so it cannot be
    // mistaken for a base rule that overrides this one.
    const pluginInfoOpen = blockOf(".plugin-tab-info[aria-expanded='true'] {");

    expect(pluginInfoOpen).toContain('border-color: var(--accent)');
    expect(pluginInfoOpen).toContain('background: var(--accent-soft)');
    expect(pluginInfoOpen).toContain('color: var(--text)');
    expect(blockOf('.plugin-tab-info:hover {')).toContain('border-color: var(--accent)');

    // Neither pane has a border contest any more: "enabled" and "open" sit on two different
    // controls, one on the tile's edge and one on the mark's edge, so the ORDER of the two rules
    // cannot change what a row looks like. The old
    // `[data-enabled]`-before-`[aria-pressed]` pin is gone because the pair it ordered is gone;
    // the two `not.toContain` greps above are what keep it gone.

    // A locked plugin switch is inert but never `disabled` — the tools rule above, with only the
    // plugin's real reasons. The `@supports` pair is the progressive layer for engines without
    // `not-allowed`; both spellings must survive the strip, or the fallback silently becomes the
    // only cursor this UI has.
    expect(blockOf('.plugin-tab-button[data-locked] {')).toContain('cursor: default');
    expect(blockOf(".plugin-tab-button[data-locked='writing'] {")).toContain('cursor: progress');

    // The token pair is still two tokens, not alphas repeated per pane, and `--ok-wash` is
    // still DEFINED and still CONSUMED — by the records/tasks completed rows
    // (`.panel-tasks-row[data-completed='true']`, `.block-detail-fact[data-tone='ok']`), which
    // is what this grep pins. Neither catalogue tile paints it any more: tools dropped it
    // first, plugins followed so "selected" can never be read as "enabled" there either.
    expect(blockOf(':root {')).toContain('--ok-wash: rgba(74, 222, 128, 0.16)');
    expect(blockOf(':root {')).toContain('--ok-line: rgba(74, 222, 128, 0.5)');
    expect(rules).toContain('background: var(--ok-wash)');

    // Forced colours drops background tints, which is exactly why a catalogue tile that wears
    // its state on the edge has to pin that edge to a SYSTEM colour: the sheet's own doctrine
    // is that a state must survive on borders and text, and an enabled tile and a plain one
    // would both collapse onto the forced `CanvasText` border and stop differing at all.
    // `Highlight` is the salient-one system colour the block already uses elsewhere. BOTH
    // catalogue tiles ride that edge now, so both pin it.
    const forcedToolEnabled = blockOfLast(".tool-tab-button[data-enabled='true'] {");

    expect(forcedToolEnabled.replace(/\s+/g, ' ').trim()).toBe('border-color: Highlight;');

    const forcedPluginEnabled = blockOfLast(".plugin-tab-button[data-enabled='true'] {");

    expect(forcedPluginEnabled.replace(/\s+/g, ' ').trim()).toBe('border-color: Highlight;');

    // The swap moved the SELECTION figure onto the corner mark, and that figure is an accent
    // border plus an accent TINT — the tint is exactly what forced colours throws away. So the
    // mark states its open edge in a system colour too, and follows it with `color` because the
    // glyph rides `stroke: currentColor`: without the second declaration the open row's mark
    // would collapse to a plain outline and the pane would have no "which runner is open" cue.
    const forcedToolInfo = blockOfLast(".tool-tab-info[aria-expanded='true'] {");

    expect(forcedToolInfo.replace(/\s+/g, ' ').trim()).toBe('border-color: Highlight; color: Highlight;');

    // The plugins mark is the same figure with the same dependency, and it is a SEPARATE rule
    // (the two panes are never merged into one selector list).
    const forcedPluginInfo = blockOfLast(".plugin-tab-info[aria-expanded='true'] {");

    expect(forcedPluginInfo.replace(/\s+/g, ' ').trim()).toBe('border-color: Highlight; color: Highlight;');

    // A DISABLED tile is the PLAIN one: the old `[data-enabled='false']` opacity dim is
    // gone, so "off" is the default appearance and no catalogue row is faded. The only dim
    // left is the control's own `:disabled` (an unconfigured row cannot open a runner).
    expect(rules).not.toContain("[data-enabled='false']");
    expect(blockOf('.tool-tab-button:disabled {')).toContain('opacity: 0.5');

    // The pill and the "core" pin left the sheet with the markup that used to carry them.
    expect(rules).not.toContain('.tool-tab-toggle');
    expect(rules).not.toContain('.plugin-tab-toggle');
    expect(rules).not.toContain('.tool-tab-pin');

    // The PLUGINS twin is unchanged: a switch failure there is marked by class as well as
    // colour. The TOOLS twin is gone with its markup (the reader asked for no line under the
    // catalogue title), so neither of its rules may survive — and neither may the removed
    // playground note's rule. `rules` is the comment-stripped sheet, so a comment naming a
    // dead selector can never satisfy these assertions.
    expect(rules).not.toContain('.tools-tab-note');
    expect(rules).not.toContain('.tools-tab-note-error');
    expect(rules).not.toContain('.tools-session-note');
    // The Plugins pane's own descriptive copy went the same way in the following pass (the
    // reader asked for the same treatment there): the "Auto-scanned · tick to enable…"
    // paragraph and the count line that duplicated the view head's subtitle left main.ts, so
    // their rules may not stay behind. `.plugins-tab-status` is NOT in that list — it is
    // feedback about a switch write, not description, and it survives in the footer strip.
    expect(rules).not.toContain('.plugins-tab-hint');
    expect(rules).not.toContain('.plugins-tab-note');
    expect(blockOf('.plugins-tab-status-error {')).toContain('color: var(--danger)');

    // The two panes still own their own rules (no shared selector list was introduced). The
    // tools corner control has no plugins twin to merge with at all now that the tick boxes are
    // different controls, and the pane's dead enablement vocabulary may not survive anywhere.
    expect(rules).not.toContain('.tool-tab-info, .plugin-tab-info');
    expect(rules).not.toContain('.plugin-tab-enable, .tool-tab-enable');
    expect(rules).not.toContain('.tool-tab-enable');
});

// The Plugins pane FOOTER (2026-11-13): `Reload plugins` moved out of `.plugins-tab-head`,
// where it read as one more line of the descriptive copy, into its own row AFTER the list so
// it sits in the pane's bottom-right corner. jsdom runs no cascade, so what gets pinned is the
// declarations that create the corner, the sheet order that mirrors the markup, and the
// leftovers the move made obsolete in the button's own rule.
it('sits the plugin re-read control in a right-aligned footer under the list', () => {
    const footer = blockOf('.plugins-tab-footer {');

    // A flex line whose only alignment job is the corner: `justify-content: flex-end` is the
    // right half of "bottom-right", and the pane's column layout (`.pane` is `flex-direction:
    // column`, and the footer is the LAST child main.ts appends) is the bottom half.
    expect(footer).toContain('display: flex');
    expect(footer).toContain('justify-content: flex-end');
    // `0 0 auto` keeps the strip its own height, so `.plugin-tab-list` (`flex: 1` +
    // `min-height: 0`, pinned below) stays the pane's ONLY scroll region and the button is
    // never scrolled away with the rows.
    expect(footer).toContain('flex: 0 0 auto');
    // The strip carries TWO children now that the head is the bare `h2`: the enablement
    // outcome line (`pluginsTabStatus`, first) and `Reload plugins` (last). `align-items:
    // center` is what keeps a text line and a padded button on one visual line instead of
    // stretching the `<p>` to the button's height; `justify-content: flex-end` still parks the
    // button in the corner, and it is still the strip's only button.
    expect(footer).toContain('align-items: center');
    // NOT `position: fixed`: main.ts swaps the whole `.plugins-pane` out when another view
    // takes the column, and a fixed control would survive that swap floating over the chat.
    expect(footer).not.toContain('position: fixed');

    // The footer rule is written AFTER the list rule for the same reason the markup appends
    // head, list, footer — the sheet mirrors the pane, so the next reader finds the rules in
    // the order the eye meets them.
    expect(rules.indexOf('.plugin-tab-list {')).toBeLessThan(rules.indexOf('.plugins-tab-footer {'));
    expect(blockOf('.plugin-tab-list {')).toContain('flex: 1');
    expect(blockOf('.plugin-tab-list {')).toContain('min-height: 0');

    // The button rule keeps only its own width. The head-column leftovers are gone:
    // `align-self: flex-start` meant "top of a flex COLUMN" and is meaningless in a row, and
    // `margin-top: 4px` only separated it from the note above it — the pane's own `gap: 12px`
    // is the separation now, so a margin there would just thicken the footer.
    const refresh = blockOf('.plugins-refresh {');

    expect(refresh).toContain('flex: 0 0 auto');
    expect(refresh).not.toContain('align-self');
    expect(refresh).not.toContain('margin-top');
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

// R4 (2026-11-13): both catalogues stopped PRINTING a sentence about a switch — the tile's green
// edge is the accepted figure — and a refused switch moved onto the row itself, as the corner mark
// turning into a red warning glyph. jsdom runs no cascade, so what gets pinned here is the
// declarations, the ORDER that makes them win, and the shape of the contract: one state hook per
// pane (never a shared selector list), painted from the sheet's own danger token, and NO rule for
// the failure glyph beyond the shared `.info-icon` one — the mark rides `stroke: currentColor`, so
// the control's colour IS the glyph's colour.
it('paints a refused switch red on both catalogues’ corner marks', () => {
    for (const pane of ['tool', 'plugin'] as const) {
        const error = blockOf(`.${pane}-tab-info[data-toggle='error'] {`);

        // Edge AND glyph. The glyph needs its own declaration because it is stroked with
        // `currentColor`: without `color`, a refused row would wear a red border and a grey mark.
        expect(error).toContain('border-color: var(--danger)');
        expect(error).toContain('color: var(--danger)');
        // The token, never a literal, so one palette edit moves both catalogues and the pill.
        expect(error).not.toMatch(/#[0-9a-fA-F]{3,6}|rgba?\(/);
        // The failure state adds NO background: the accent fill is the pane's "this row's layer is
        // open" figure (`.tool-tab-info[aria-expanded='true']` / its plugin twin), and a third
        // channel on the same 20px box would be read as a third state of the ROW.
        expect(error).not.toContain('background');
        // Not a size change either — the two glyphs share `.info-icon`'s box, so a swap cannot
        // move the control's footprint or the row's text padding.
        expect(error).not.toContain('width');
        expect(error).not.toContain('height');

        // ORDER is load-bearing: `:hover`, the open rule and this one all have the same specificity
        // (one class + one compound), so the LAST writer wins. Being written after both keeps a
        // refused row red under the pointer and while its own dialog is open — otherwise the hover
        // accent would silently repaint the failure the moment the reader aimed at it.
        expect(rules.indexOf(`.${pane}-tab-info:hover {`)).toBeLessThan(rules.indexOf(`.${pane}-tab-info[data-toggle='error'] {`));
        expect(
            rules.indexOf(`.${pane}-tab-info[aria-expanded='true'] {`)
        ).toBeLessThan(rules.indexOf(`.${pane}-tab-info[data-toggle='error'] {`));

        // ONE rule per pane, and no forced-colours twin: the selectors appear EXACTLY once in the
        // stripped sheet. The enabled edge needs a `Highlight` rescue in that mode because it is a
        // colour with no shape and no words; this state changes the glyph's SHAPE and puts the
        // reason in the control's accessible name and tooltip, which forced colours never touches —
        // and there is no system colour for "error" to rescue it to anyway.
        expect(rules.match(new RegExp(`\\.${pane}-tab-info\\[data-toggle='error'\\]`, 'g'))).toHaveLength(1);
    }

    // The two catalogues are never merged into a selector list — the standing rule that restyling
    // one pane cannot move the other (the same reason their base, hover and open rules are pairs).
    expect(rules).not.toContain(".tool-tab-info[data-toggle='error'],");
    expect(rules).not.toContain(".plugin-tab-info[data-toggle='error'],");
    expect(rules).not.toContain('.tool-tab-info, .plugin-tab-info');

    // The warning glyph borrows the SHARED paint rule rather than inventing a class of its own, so
    // the resting mark and the failure mark cannot drift in size, stroke or joins. A `.warning-icon`
    // rule appearing here would be the drift this pin exists to catch.
    const glyph = blockOf('.info-icon {');

    expect(glyph).toContain('stroke: currentColor');
    expect(glyph).toContain('fill: none');
    expect(rules).not.toContain('.warning-icon');
    expect(rules).not.toContain('.info-icon-warning');

    // The danger token is still defined ONCE, and both new rules consume that definition.
    expect(blockOf(':root {')).toContain('--danger: #f87171');
    expect(rules.match(/--danger: /g)).toHaveLength(1);

    // The plugin pane's footer line KEEPS both of its rules even though R4 silenced the element:
    // main.ts still builds the `<p>` (the footer strip stays `[statusLine, refresh]`), the
    // `role="status"` live region survives for any sentence the pane is given again, and a dead
    // selector grep must not clear the failure spelling this element's contract is written in.
    expect(blockOf('.plugins-tab-status {')).toContain('margin: 0');
    expect(blockOf('.plugins-tab-status-error {')).toContain('color: var(--danger)');
    expect(blockOf('.plugins-tab-status-error {')).toContain('font-weight: 600');
    // The sentence's own surface never grew a colour contest: one line, one danger spelling.
    expect(rules).not.toContain('.plugins-tab-status-error,');
    // And neither catalogue grew a replacement sentence: the tools pane's line is gone, and the
    // plugins pane's line is now written by nobody.
    expect(rules).not.toContain('.tools-tab-note');
});

it('lets the topbar cluster shrink so the status pill never scrolls the bar (F1)', () => {
    const cluster = blockOf('.topbar-right {');
    // Shrinkable (`0 1 auto`) with `min-width: 0`. The cluster is the status pill ALONE
    // since the catalogue toggles moved to the harness title row, but the pill still has
    // to be the item that gives room back so a long error status fits a 320/375px line
    // beside the brand.
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
    // T9: the title row now carries the session cycler and its `+` at EVERY width, so the
    // centring that used to be a phone-only override is the base rule (and the phone block
    // has nothing left to override).
    expect(blockOf('.harness-title-row {')).toContain('align-items: center');
    expect(phone).not.toContain('.harness-title-row');
});

it('takes the hidden catalogues out of the layout, not just out of the DOM', () => {
    // T4: `hidden` on its own hides NOTHING here. `.harness-title-tools` declares
    // `display: flex` and both buttons declare `display: inline-flex`, and an AUTHOR rule always
    // outranks the UA stylesheet's `[hidden] { display: none }` at equal specificity
    // (styles.css:1893-1915). Delete these three declarations and the unbound state still shows
    // two pressable icons — jsdom would keep reporting `hidden === true` while the reader sees
    // the old chrome, so the claim has to be pinned against the sheet.
    expect(blockOf('.harness-title-tools[hidden] {')).toContain('display: none');
    // The two icons are covered by ONE rule, so the selector list itself is the pin: a rule that
    // named only one of them would leave the other icon on screen.
    expect(rules).toContain('.tools-toggle[hidden],\n.plugins-toggle[hidden] {');
    expect(blockOf('.tools-toggle[hidden],')).toContain('display: none');
    expect(blockOf('.plugins-toggle[hidden] {')).toContain('display: none');
    // The base rules the override exists to beat, pinned so the pair cannot be "fixed" by
    // deleting the base `display` instead.
    expect(blockOf('.harness-title-tools {')).toContain('display: flex');
    expect(blockOf('.tools-toggle {')).toContain('display: inline-flex');
    expect(blockOf('.plugins-toggle {')).toContain('display: inline-flex');
});

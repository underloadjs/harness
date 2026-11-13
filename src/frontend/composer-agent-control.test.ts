// Composer agent control + shared dialog (T5 R9/R10/R11/R12/R13).
//
// These tests exercise the LIVE shell (main.ts) because the request is about real
// interaction, not only DOM shape:
//   - R9: the entry-agent transcript button and its raw `session.messages` dialog are
//     GONE (with their per-view text plumbing);
//   - R10/R11: the composer is one frame and the agent control is a SINGLE button at
//     its right edge. It shows the full title on desktop and the thread code
//     (`Researcher` -> `RR`) at small widths (CSS pinned separately in
//     ui/compact-control-style.test.ts, since jsdom has no media queries);
//   - R11: pressing the button opens the shared modal (never a cycle, never a
//     chevron popover);
//   - R12: the dialog selects a different primary, changes every agent's model, shows
//     the instructions, and (T7b/R5) states the SCOPE a save writes: a saved conversation
//     edits its own team, prompts and live models, and only its entry agent is fixed.
//   - R13: closing restores focus to the composer button and a live rebuild keeps the
//     open dialog (and the control the reader was using) in place.

import type { AgentDescriptor, HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';
import type { StreamDouble } from './view-test-support';

// T38: the live case below drives the canonical `harness.v1` stream, and the double is
// resolved by a DYNAMIC import. `vi.resetModules()` clears the module registry, so a static
// import would configure the PREVIOUS `./stream` instance while `main.ts` — imported after the
// reset — dials a fresh singleton with no factory at all: the frame would land nowhere and the
// case would fail for a reason that has nothing to do with the shell (the same discipline
// `main-lazy-display.test.ts:521-525` and `canonical-directory-live-main.test.ts` follow).
const installLiveStream = (options: { sessionId?: string; snapshot?: () => SessionSnapshot | undefined }): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

// The singleton is process-wide (./stream.ts:647), so the double is released through the SAME
// module instance the shell used, or it leaks into the next file's boot.
const releaseLiveStream = async (): Promise<void> => {
    const { resetHarnessStream } = await import('./stream');

    resetHarnessStream();
};

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const SESSION_KEY = 'underload-harness-app:session';

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'research', 'workspace'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'tasks', 'delegate'],
        primary: 'instruct',
        subagents: ['research', 'workspace'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

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
        guidelines: []
    },
    {
        name: 'workspace',
        title: 'Coder',
        description: 'Writes code.',
        instruction: 'Write code.',
        guidelines: ['Keep diffs small.']
    }
];

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// One PATCH handler shared by the fixtures: it answers with the server-confirmed
// harness descriptor the way the real route does (primary first in `agents`).
const patchHarness = (
    current: HarnessDescriptor,
    body: unknown
): { harness: HarnessDescriptor; body: { primary: string; subagents: string[]; agentModels?: Record<string, string> } } => {
    const request = body as {
        primary: string;
        subagents: string[];
        agentModels?: Record<string, string>;
    };

    return {
        body: request,
        harness: descriptor({
            agents: [request.primary, ...request.subagents],
            primary: request.primary,
            subagents: request.subagents,
            ...(request.agentModels === undefined ? {} : { agentModels: request.agentModels })
        })
    };
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
    // A leaked dialog overlay would own the next test's focus/Escape handling.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
        button.click();
    }
    vi.unstubAllGlobals();
    // T38: the live case installs the stream double; it is released through the same module
    // instance the shell used, or it leaks into the next test file's boot.
    await releaseLiveStream();
});

it('removes the entry-agent transcript button and its raw session.messages dialog', async () => {
    const messages = [
        { role: 'system', content: 'You are Instruct.' },
        { role: 'user', content: 'say hi' },
        { role: 'assistant', content: 'hi' }
    ];
    const session = snapshot({ messages } as Partial<SessionSnapshot>);
    localStorage.setItem(SESSION_KEY, 's1');

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [session],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1') return json({ session });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    // R9: no transcript control anywhere, and no composer left flank.
    expect(document.querySelector('.transcript-button')).toBeNull();
    expect(document.querySelector('.transcript-button-icon')).toBeNull();
    // The unrelated transcript SURFACES stay: the turn list is still the conversation.
    expect(document.querySelector('.turns')).not.toBeNull();
    // The composer has ONE child: the field column. Nothing flanks it any more.
    expect([...byClass('.composer', 'form').children].map((child) => child.className)).toEqual([
        'composer-body'
    ]);
    expect(document.querySelector('.composer .agent-slot')?.closest('.composer-field')).not.toBeNull();
});

it('opens the shared agent dialog from the single composer button', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    const button = byClass('.agent-control-button', 'button');
    // R11: ONE button. No cycle control and no chevron/disclosure pair.
    expect(document.querySelector('.agent-control-cycle')).toBeNull();
    expect(document.querySelector('.agent-control-model-toggle')).toBeNull();
    expect(document.querySelector('.agent-control-popover')).toBeNull();
    expect(document.querySelectorAll('.agent-control-button')).toHaveLength(1);

    // Full title is the visible label; the compact code is present for the CSS swap.
    expect(button.querySelector('.agent-control-name')?.textContent).toBe('Instruct');
    expect(button.querySelector('.agent-control-code')?.textContent).toBe('IT');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-label')).toBe('Agent: Instruct. Open agent settings.');
    expect(button.disabled).toBe(false);

    // Click (with real focus, so the close-time restoration is meaningful) opens the
    // shared modal, not a menu.
    button.focus();
    button.click();

    const dialog = byClass('.dialog', 'div');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Instruct');
    expect(document.querySelector('.agent-control-popover')).toBeNull();

    // T3/R3: ONE strip of badges lists the team (never a dropdown, never a duplicate
    // Team section), the selected agent's configuration is editable, and the
    // bottom-right action is the only writer.
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
            tab.dataset.agent,
            tab.dataset.role,
            tab.getAttribute('aria-selected') === 'true',
            tab.querySelector('.agent-dialog-agent-name')?.textContent
        ])
    ).toEqual([
        ['instruct', 'primary', true, 'Instruct'],
        ['research', 'secondary', false, 'Researcher'],
        ['workspace', 'secondary', false, 'Coder']
    ]);
    expect(document.querySelector('.agent-dialog-agent-select')).toBeNull();
    expect(document.querySelector('.agent-dialog-note')).toBeNull();

    // The old primary-button wall and the adopted card deck are gone: no pressed
    // chooser list, no `.agent-row-wrap`, no read-only instruction section.
    expect(document.querySelector('.agent-dialog-primary')).toBeNull();
    expect(document.querySelector('.agent-row-wrap')).toBeNull();
    expect(document.querySelector('.agent-dialog-instructions')).toBeNull();

    // The configuration shown is the selected agent's, and the instruction is a real
    // editor seeded with the trusted text (R1: not a read-only block).
    expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
    const instruction = byClass('.agent-dialog-instruction', 'textarea');
    expect(instruction.getAttribute('aria-label')).toBe('Instruction for Instruct');
    expect(instruction.value).toBe('Answer directly.');
    expect(instruction.disabled).toBe(false);
    expect(byClass('.agent-model-select', 'select').getAttribute('aria-label')).toBe('Model for Instruct');

    // Nothing has been changed, so the action is disabled: it cannot claim a save or a
    // promotion that the reader never asked for.
    const apply = byClass('.agent-dialog-apply', 'button');
    expect(apply.textContent).toBe('Save configuration');
    expect(apply.disabled).toBe(true);

    // R13: Escape dismisses the modal and focus returns to the composer button.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(byClass('.agent-control-button', 'button'));
});

it('selects a different primary agent from the dialog and PATCHes the complete team', async () => {
    let current = descriptor();
    const patches: unknown[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [current],
                    tools: [],
                    defaults,
                    sessions: [],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                const patched = patchHarness(current, JSON.parse(String(init.body)));
                patches.push(patched.body);
                current = patched.harness;
                return json({ harness: current });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();

    // T3/R3: clicking the badge is a LOCAL view change — nothing is sent, nobody is
    // promoted, and the team is untouched. The panel's own control arms the promotion
    // the reader asked for, and the bottom-right action writes it in the same
    // complete-team PATCH the deck used.
    byClass('.agent-dialog-tab[data-agent="research"]', 'button').click();
    expect(patches).toEqual([]);

    expect(byClass('.agent-dialog-apply', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-apply', 'button').textContent).toBe('Save configuration');

    // The promotion is a deliberate press, and the rebuild repaints the action's label
    // to say what the write will do.
    byClass('.agent-dialog-promote', 'button').click();
    const apply = byClass('.agent-dialog-apply', 'button');
    expect(apply.textContent).toBe('Save & set primary');
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    await flush();

    // The existing complete-team PATCH path, not a new endpoint.
    expect(patches[0]).toEqual({ primary: 'research', subagents: ['instruct', 'workspace'] });

    // The open dialog is refreshed in place: the header follows the agent being
    // configured, and every badge now states the new team truth.
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Researcher');
    expect(document.querySelector('.dialog')).not.toBeNull();
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => [
            tab.dataset.agent,
            tab.dataset.role
        ])
    ).toEqual([
        ['research', 'primary'],
        ['instruct', 'secondary'],
        ['workspace', 'secondary']
    ]);
    expect(byClass('.agent-control-name', 'span').textContent).toBe('Researcher');
    expect(byClass('.agent-control-code', 'span').textContent).toBe('RR');
    expect(byClass('.agent-control-button', 'button').getAttribute('aria-label')).toBe(
        'Agent: Researcher. Open agent settings.'
    );

    // R13: closing after the rebuild still returns focus to the LIVE button (the
    // opener node itself may have been replaced by the chrome repaint).
    byClass('.dialog-close', 'button').click();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(byClass('.agent-control-button', 'button'));
});

it('changes a model from the dialog and keeps the open dialog in sync without dropping focus', async () => {
    let current = descriptor({ agentModels: { instruct: 'm2' } });
    const patches: unknown[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [current],
                    tools: [],
                    defaults,
                    sessions: [],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1', 'm2', 'm3'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                const patched = patchHarness(current, JSON.parse(String(init.body)));
                patches.push(patched.body);
                current = patched.harness;
                return json({ harness: current });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();

    // T3: the dialog reuses the EXISTING per-agent option rules (same labels/state),
    // but shows one agent at a time through the dropdown instead of a select per card.
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
    expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual(['Model for Instruct']);

    const instruct = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    expect(instruct.value).toBe('m2');

    instruct.focus();
    instruct.value = 'm3';
    instruct.dispatchEvent(new Event('change', { bubbles: true }));

    // The change is a DRAFT: no request yet, and the action is armed. The reader keeps
    // their place in the select while they type/choose (no rebuild, no caret loss).
    expect(patches).toEqual([]);
    expect(document.activeElement).toBe(instruct);
    expect(byClass('.agent-dialog-apply', 'button').disabled).toBe(false);

    byClass('.agent-dialog-apply', 'button').click();
    await flush();
    await flush();

    // The complete override map is sent (the server replaces, never merges), and only
    // the model changed: the team is restated unchanged.
    expect(patches[0]).toEqual({
        primary: 'instruct',
        subagents: ['research', 'workspace'],
        agentModels: { instruct: 'm3' }
    });

    // The dialog is still the same modal and shows the saved value. Focus never lands
    // on <body> after the rebuild: the action is legitimately disabled again (nothing
    // is pending), so the dialog hands focus to the badge that re-orients the form.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    const replaced = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    expect(replaced.value).toBe('m3');
    expect(document.activeElement).toBe(byClass('.agent-dialog-tab[data-agent="instruct"]', 'button'));
    expect(document.activeElement?.tagName).not.toBe('BODY');
});

it('shows every agent instruction and guideline inside the dialog', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();

    // R4 (T7a/T7b): the configured agent's instruction is ONE editable box holding the FULL text
    // the agent runs. `instruct` has no stored override and no guideline rules, so its default is
    // its identity sentence alone — the same composition the server ships
    // (./ui/agents.ts `agentDefaultInstructionOf`).
    const box = byClass('.agent-dialog-instruction', 'textarea');
    expect(box.value).toBe('Answer directly.');
    expect(box.disabled).toBe(false);
    // The read-only preset reference (`.agent-detail`) and the revert control are GONE: the box's
    // own text is the whole truth, and clearing it by hand is how the default comes back.
    expect(document.querySelector('.agent-detail')).toBeNull();
    expect(document.querySelector('.agent-dialog-revert')).toBeNull();

    // Typing is local. This stub answers ONLY the boot and model requests (it throws
    // on anything else), so a write here would fail the test by itself.
    box.value = 'Answer in one sentence.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(byClass('.agent-dialog-apply', 'button').disabled).toBe(false);

    // R3: the strip reaches every trusted agent the team selects — including one the
    // reader did not open the dialog for, whose guideline rules are part of ITS default prompt.
    byClass('.agent-dialog-tab[data-agent="workspace"]', 'button').click();

    expect(byClass('.agent-dialog-instruction', 'textarea').value).toBe(
        'Write code.\n\nGuidelines:\n- Keep diffs small.'
    );

    // And the draft the reader typed for Instruct is still there when they go back.
    byClass('.agent-dialog-tab[data-agent="instruct"]', 'button').click();
    expect(byClass('.agent-dialog-instruction', 'textarea').value).toBe('Answer in one sentence.');
});

it('keeps a saved conversation editable and states the scope a save writes', async () => {
    const session = snapshot({ harnessDefinition: descriptor() } as Partial<SessionSnapshot>);
    localStorage.setItem(SESSION_KEY, 's1');

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [session],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1') return json({ session });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    const button = byClass('.agent-control-button', 'button');
    // The compact button is NEVER disabled, and since T7b (R5) a saved conversation is not a lock
    // either: it edits its own team, prompts and live models. The tooltip states where a save
    // lands, which is the fact the reader can act on.
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Edits here change this conversation only. The harness template stays as it is.');

    button.click();

    // R3: the restriction is stated where it bites, not in a paragraph. The roster is the team this
    // conversation started with (no nonmember appears), and every editor is ENABLED because the
    // conversation owns its own configuration.
    expect(document.querySelector('.agent-dialog-note')).toBeNull();
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-tab')].map((tab) => tab.dataset.agent)
    ).toEqual(['instruct', 'research', 'workspace']);

    const instruction = byClass('.agent-dialog-instruction', 'textarea');

    // R6: the box is editable, and its text is this conversation's OWN prompt for the member —
    // read live from `GET /sessions/s1/agents/instruct/instruction`, which for an unoverridden
    // member is the full default composition (identity only here: this profile ships no rules).
    expect(instruction.disabled).toBe(false);
    expect(instruction.value).toBe('Answer directly.');
    expect(instruction.title).toBe('The instruction this agent runs in this conversation.');

    // R6: a member this conversation runs is removable — the primary excepted, for the structural
    // reason — and R7: `[+]` offers a typed name as well as the catalogue.
    expect(byClass('.agent-dialog-remove', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-remove', 'button').title).toBe(
        'The primary agent is always part of the team.'
    );
    expect(byClass('.agent-dialog-add', 'button').disabled).toBe(false);
    expect(byClass('.agent-dialog-add', 'button').title).toBe(
        'Add an agent to the team, or name a new one.'
    );

    // R5: the entry agent of a saved conversation is FIXED, so `Make primary` carries that reason
    // and the action can never promise a promotion this session cannot write.
    expect(byClass('.agent-dialog-promote', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-promote', 'button').title).toBe(
        'The primary agent is fixed for a saved conversation.'
    );
    const apply = byClass('.agent-dialog-apply', 'button');
    expect(apply.textContent).toBe('Save configuration');
    expect(apply.disabled).toBe(true);

    // R2: the model map is still live, and the strip reaches every member's configuration.
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);
    expect(byClass('.agent-model-select', 'select').title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );

    byClass('.agent-dialog-tab[data-agent="research"]', 'button').click();
    expect(byClass('.agent-model-select', 'select').title).toBe(
        'Model for Researcher. Applies to the next request in this session.'
    );
});

// R2 (T3): the whole point of the draft layer. Every dismissal path must discard the
// edits, and nothing may reach the server until the reader presses the action.
it('discards every draft on close, overlay and Escape without a single request', async () => {
    let current = descriptor();
    const patches: unknown[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [current],
                    tools: [],
                    defaults,
                    sessions: [],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1', 'm2'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                const patched = patchHarness(current, JSON.parse(String(init.body)));
                patches.push(patched.body);
                current = patched.harness;
                return json({ harness: current });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    for (const dismiss of ['close', 'overlay', 'escape'] as const) {
        byClass('.agent-control-button', 'button').click();

        // A draft on a NON-primary agent: an instruction, a model and an armed
        // promotion, i.e. one edit of every kind the dialog owns here (every trusted
        // agent is already on this team, so `[+]` has nothing to add).
        byClass('.agent-dialog-tab[data-agent="research"]', 'button').click();

        const box = byClass('.agent-dialog-instruction', 'textarea');
        box.value = 'Never sent.';
        box.dispatchEvent(new Event('input', { bubbles: true }));

        const model = byClass('.agent-model-select', 'select');
        model.value = 'm2';
        model.dispatchEvent(new Event('change', { bubbles: true }));

        byClass('.agent-dialog-promote', 'button').click();

        expect(patches).toEqual([]);
        expect(byClass('.agent-dialog-apply', 'button').disabled).toBe(false);

        if (dismiss === 'close') byClass('.dialog-close', 'button').click();
        else if (dismiss === 'overlay') byClass('.dialog-overlay', 'div').click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(document.querySelector('.dialog')).toBeNull();
        // The dismissal itself wrote nothing.
        expect(patches).toEqual([]);

        // Re-opening shows the SERVER's configuration, not the dropped draft.
        byClass('.agent-control-button', 'button').click();
        expect(byClass('.agent-dialog-config', 'section').dataset.agent).toBe('instruct');
        expect(byClass('.agent-dialog-instruction', 'textarea').value).toBe('Answer directly.');
        expect(byClass('.agent-model-select', 'select').value).toBe('');
        expect(byClass('.agent-dialog-apply', 'button').disabled).toBe(true);

        byClass('.dialog-close', 'button').click();
        expect(patches).toEqual([]);
    }
});

it('keeps the open dialog and the focused control across a live snapshot rebuild', async () => {
    // The conversation as the SERVER holds it. A settled frame is followed by a header
    // re-read (`session.updated` reconciles through `GET /sessions/:id`,
    // ./view-shell.ts:515-529), so the document and the frame move together — which is what
    // makes "pending released" a statement about the shell rather than about a fixture whose
    // answer never changed.
    let session = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        updatedAt: 2
    });
    localStorage.setItem(SESSION_KEY, 's1');

    // T38: the live surface is the canonical `harness.v1` stream, and the shell has NO SSE
    // fallback (./stream.ts:40-43). The hand-raised `ReadableStream` this case used to push its
    // frames through was therefore never dialled at all: the snapshot landed nowhere, the shell
    // kept believing the run was live, `paintSessionActions()` (./main.ts:7301) left
    // `.new-session` disabled, and the click that was supposed to dismiss the dialog did
    // nothing. The double below speaks the real wire and folds the SAME raw `SessionStreamItem`
    // this fixture always declared through the server's own projector
    // (./view-test-support.ts:2100-2108) — the assertions are unchanged.
    const stream = await installLiveStream({ sessionId: 's1', snapshot: () => session });

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [session],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1') return json({ session });
            // T3 (R1): the `+` this case ends with CREATES a conversation. A create that never
            // answered would dismiss the dialog for the wrong reason — the failure path closes
            // it too — so the fixture answers with the fresh 0-turn record a real server hands
            // back (the id is the one this case never asserts on: only the dialog's lifecycle).
            if (url === '/api/sessions')
                return json(
                    { session: snapshot({ harnessDefinition: descriptor(), createdAt: 12, updatedAt: 12 }) },
                    201
                );

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();

    // T7b (R6): opening a conversation's dialog is the explicit action that reads THIS
    // conversation's live per-agent prompts (`GET /sessions/s1/agents`, then one text read per
    // member), and that answer repaints the body once. The reads are awaited here so the node
    // captured below is the one the reader would actually be standing on once the conversation's
    // own configuration has landed; each hop is a separate request through the canonical adapter.
    await flush();
    await flush();
    await flush();
    await flush();

    // `byClass`'s tag parameter IS the element type (its `K` is the tag NAME), so the helper
    // infers `HTMLSelectElement` instead of passing one as a type argument.
    const selectIn = () =>
        byClass('.agent-model-select[aria-label="Model for Instruct"]', 'select');

    const firstSelect = selectIn();
    firstSelect.focus();
    expect(document.activeElement).toBe(firstSelect);

    const pushSnapshot = async (updatedAt: number, status: 'idle' | 'running' = 'idle'): Promise<void> => {
        session = snapshot({
            harnessDefinition: descriptor(),
            status,
            updatedAt
        });
        // Frames pushed before the shell registered its subscription are queued by the double,
        // so the order declared here is the order the socket delivers.
        stream.push([{ type: 'snapshot', session }]);
        await flush();
        await flush();
    };

    // The frame that SETTLES the run is a real configuration change since T7b (R5): while a run is
    // in flight the team and the instruction editor are locked, and a saved conversation's own
    // editors wake up the moment it stops. `editable` is part of the dialog's signature, so this
    // rebuild is the correct answer — the reader must not keep typing into a box whose write the
    // shell would refuse.
    await pushSnapshot(10);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    // Identical agent state after that: the dialog stays open, the SAME node keeps focus, and no
    // frame rebuilds the body under the reader (a rebuild would replace this node and hand focus
    // to the close button).
    const settled = selectIn();
    settled.focus();
    expect(document.activeElement).toBe(settled);

    await pushSnapshot(11);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(document.activeElement).toBe(settled);
    expect(selectIn()).toBe(settled);

    // Lifecycle: a new conversation dismisses the dialog rather than carrying it into
    // an empty session.
    byClass('.new-session', 'button').click();
    await flush();
    expect(document.querySelector('.dialog')).toBeNull();
});

// Per-member model selection on the agent tiles (R9).
//
// Covered here (R18):
//   - every tile has its own labelled dropdown whose no-override option shows the
//     ACTUAL effective model (never "inherit"), followed by the provider catalogue
//     and any current override the catalogue no longer lists;
//   - the default option and a catalogue entry with the same id are deduped;
//   - a model change PATCHes the complete override map;
//   - promotion/add preserve the map, removal drops the removed member's key, and
//     choosing the default deletes that member's entry;
//   - a saved session's TEAM is frozen (New session affordance, disabled
//     promotion/add/remove) but its MODELS are live (R2): the dropdowns stay
//     enabled and PATCH /sessions/:id, applying the returned snapshot, including
//     while the session is running.

import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const SESSION_KEY = 'underload-harness-app:session';

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'summarizer'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'task', 'delegate'],
        primary: 'instruct',
        subagents: ['summarizer'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
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
        description: 'Compresses notes.',
        instruction: 'Compress into two sentences.',
        guidelines: []
    },
    {
        name: 'critic',
        title: 'Critic',
        description: 'Reviews the answer.',
        instruction: 'Find problems.',
        guidelines: []
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

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// T3/R3: the per-agent select lives in the shared agent dialog and belongs to the agent
// the roster strip currently views, so reading one opens the dialog (idempotent once
// open) and switching agents is `selectConfigured` (a badge click). The dialog refreshes
// itself after each confirmed PATCH.
const openDeck = (): void => {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
};

const modelSelects = (): HTMLSelectElement[] => {
    openDeck();
    return [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
};

// Views another agent's configuration. Local only: it never sends a request.
const selectConfigured = (name: string): void => {
    openDeck();

    byClass(`.agent-dialog-tab[data-agent="${name}"]`, 'button').click();
};

// R3: `[+]` is the only way an agent outside the roster gets a badge.
const addAgent = (name: string): void => {
    openDeck();
    byClass('.agent-dialog-add', 'button').click();
    byClass(`.agent-dialog-add-option[data-agent="${name}"]`, 'button').click();
};

// The two explicit team controls inside the viewed agent's panel.
const promoteAction = (): HTMLButtonElement => {
    openDeck();

    return byClass('.agent-dialog-promote', 'button');
};

const removeAction = (): HTMLButtonElement => {
    openDeck();

    return byClass('.agent-dialog-remove', 'button');
};

// The dialog's single writer.
const applyAction = (): HTMLButtonElement => {
    openDeck();

    return byClass('.agent-dialog-apply', 'button');
};

const optionTexts = (select: HTMLSelectElement): (string | null)[] =>
    [...select.options].map((option) => option.textContent);

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('edits per-agent models, preserving the map and dropping removed keys', async () => {
    let current = descriptor({ agentModels: { instruct: 'm2', summarizer: 'm1' } });
    const patches: unknown[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [current] }));
            if (url === '/api/models') return json({ models: ['m1', 'm2', 'm3'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                const request = JSON.parse(String(init.body)) as {
                    primary: string;
                    subagents: string[];
                    agentModels?: Record<string, string>;
                };
                patches.push(request);

                current = descriptor({
                    primary: request.primary,
                    agents: [request.primary, ...request.subagents],
                    subagents: request.subagents,
                    ...(request.agentModels === undefined
                        ? {}
                        : { agentModels: request.agentModels })
                });
                return json({ harness: current });
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // T3: the dialog configures ONE agent at a time, so there is exactly one select
    // and the dropdown is how you reach the other member. Option 0 is the default
    // labelled m1, so m1 is not repeated.
    expect(modelSelects()).toHaveLength(1);
    const instruct = modelSelects()[0];
    expect(instruct.getAttribute('aria-label')).toBe('Model for Instruct');
    expect(optionTexts(instruct)).toEqual(['m1', 'm2', 'm3']);
    expect(instruct.value).toBe('m2');

    // The summarizer's explicit override equals the fallback, so the default option
    // represents it and already displays m1.
    selectConfigured('summarizer');
    const summarizer = modelSelects()[0];
    expect(summarizer.getAttribute('aria-label')).toBe('Model for Summarizer');
    expect(summarizer.value).toBe('');
    expect(summarizer.selectedOptions[0].textContent).toBe('m1');
    // Viewing an agent is not an edit: nothing has been written.
    expect(patches).toEqual([]);

    // --- change one model: DRAFT first, then the complete map on the action --
    selectConfigured('instruct');
    const instructSelect = modelSelects()[0];
    instructSelect.value = 'm3';
    instructSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(patches).toEqual([]);

    applyAction().click();
    await flush();

    expect(patches[0]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer'],
        agentModels: { instruct: 'm3', summarizer: 'm1' }
    });
    expect(modelSelects()[0].value).toBe('m3');
    selectConfigured('summarizer');
    expect(modelSelects()[0].value).toBe('');
    expect(modelSelects()[0].selectedOptions[0].textContent).toBe('m1');

    // --- adding a member preserves existing entries -----------------------
    // R3: `[+]` is what drafts the membership; the picker lists only agents without a
    // badge, and adding one never promotes it.
    addAgent('critic');
    expect(patches).toHaveLength(1);

    // Saved from the PRIMARY's configuration so adding does not also promote.
    selectConfigured('instruct');
    applyAction().click();
    await flush();

    expect(patches[1]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer', 'critic'],
        agentModels: { instruct: 'm3', summarizer: 'm1' }
    });

    // --- a new member can get its own model -------------------------------
    selectConfigured('critic');
    const critic = modelSelects()[0];
    expect(critic.value).toBe('');
    critic.value = 'm2';
    critic.dispatchEvent(new Event('change', { bubbles: true }));

    selectConfigured('instruct');
    applyAction().click();
    await flush();

    expect(patches[2]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer', 'critic'],
        agentModels: { instruct: 'm3', summarizer: 'm1', critic: 'm2' }
    });

    // --- promotion preserves every mapping --------------------------------
    // R3: the promotion is armed by the panel control, and its label states it; saving
    // from there restates the complete team with the new primary first.
    selectConfigured('critic');
    expect(applyAction().textContent).toBe('Save configuration');
    promoteAction().click();
    expect(applyAction().textContent).toBe('Save & set primary');
    applyAction().click();
    await flush();

    expect(patches[3]).toEqual({
        primary: 'critic',
        subagents: ['instruct', 'summarizer'],
        agentModels: { instruct: 'm3', summarizer: 'm1', critic: 'm2' }
    });
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map((row) => row.dataset.agent)
    ).toEqual(['critic', 'instruct', 'summarizer']);

    // --- removal drops only the removed member's key ----------------------
    // R3: `Remove from team` is the deliberate press, and the removed agent loses its
    // badge at once, so the view lands on the primary instead of a dropped agent.
    selectConfigured('summarizer');
    removeAction().click();

    applyAction().click();
    await flush();

    expect(patches[4]).toEqual({
        primary: 'critic',
        subagents: ['instruct'],
        agentModels: { instruct: 'm3', critic: 'm2' }
    });
    selectConfigured('critic');
    expect(modelSelects()[0].value).toBe('m2');
    selectConfigured('instruct');
    expect(modelSelects()[0].value).toBe('m3');

    // --- choosing the default deletes the key (not an empty entry) ---------
    // Drafted on Instruct, saved from the PRIMARY's configuration so the action saves
    // the model without also promoting the agent being edited.
    const cleared = modelSelects()[0];
    cleared.value = '';
    cleared.dispatchEvent(new Event('change', { bubbles: true }));

    selectConfigured('critic');
    applyAction().click();
    await flush();

    expect(patches[5]).toEqual({
        primary: 'critic',
        subagents: ['instruct'],
        agentModels: { critic: 'm2' }
    });
    selectConfigured('instruct');
    expect(modelSelects()[0].value).toBe('');
    expect(optionTexts(modelSelects()[0])[0]).toBe('m1');
});

it('names the server fallback when the stored settings model is blank', async () => {
    // A blank stored model is sent as blank; mergeSettings then falls back to the
    // server default. The dropdown must label that real model, not "inherit" and
    // not an empty/unknown value (R18).
    localStorage.setItem(
        'underload-harness-app:settings',
        JSON.stringify({ baseURL: 'http://provider/v1', apiKey: '', model: '' })
    );

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [descriptor()] }));
            if (url === '/api/models') return json({ models: ['m1', 'm2'] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    const [select] = modelSelects();
    expect(optionTexts(select)).toEqual(['m1', 'm2']);
    expect(select.value).toBe('');
    expect(select.selectedOptions[0].textContent).toBe('m1');
    // The default option and the catalogue's m1 are the same entry, not two.
    expect(optionTexts(select).filter((label) => label === 'm1')).toHaveLength(1);
});

it('shows a model-change error and keeps the last server-confirmed selection', async () => {
    const current = descriptor();

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [current] }));
            if (url === '/api/models') return json({ models: ['m1', 'm2'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                return json({ error: { message: 'That model is not available to this provider.' } }, 400);
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    const select = modelSelects()[0];
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    // T3: the change is a draft; the rejection can only happen once the action writes.
    applyAction().click();
    await flush();

    expect(byClass('.status', 'span').dataset.state).toBe('error');
    // R3: concise visible state; the rejected model message is the tooltip.
    expect(document.querySelector('.status-text')?.textContent).toBe('error');
    expect(document.querySelector('.status')?.getAttribute('title')).toBe(
        'agent configuration: That model is not available to this provider.'
    );
    // T3 R2: the dialog did NOT close and did NOT lose the edit. The refused draft is
    // still on screen so the reader can fix it, the action is re-armed, and the reason
    // is stated beside it (the app pill carries the same message).
    expect(byClass('.agent-model-select', 'select').value).toBe('m2');
    expect(applyAction().disabled).toBe(false);
    expect(document.querySelector('.agent-dialog-error')?.textContent).toBe(
        'That model is not available to this provider.'
    );
    // The stored configuration is untouched: the server's last answer still has no
    // override, which is what the team list reports.
    expect(
        document.querySelector('.agent-dialog-agent[data-agent="instruct"] .agent-dialog-agent-model')?.textContent
    ).toBe('m1');
});

// R3 (T4): the SAVING window must be observable while the PATCH is in flight. The
// visible word is the concise state, `data-state` drives the busy styling, and the
// diagnostic is BOTH the tooltip and the live-region detail (a title is not
// announced by `role="status"`).
it('shows the saving state and diagnostic while a model PATCH is in flight', async () => {
    let releasePatch: (() => void) | undefined;
    const patchStarted = new Promise<void>((resolveStarted) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);

                if (url === '/api') return json(bootstrap({ presets: [descriptor()] }));
                if (url === '/api/models') return json({ models: ['m1', 'm2'] });

                if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                    // Hold the answer open so the in-flight pill can be asserted.
                    resolveStarted();
                    await new Promise<void>((resolvePatch) => {
                        releasePatch = resolvePatch;
                    });
                    // Wire shape: the updated harness is nested under `harness`.
                    return json({ harness: descriptor({ agentModels: { instruct: 'm2' } }) });
                }

                throw new Error(`unexpected request: ${url}`);
            })
        );
    });

    await import('./main');
    await flush();
    await flush();

    const pill = byClass('.status', 'span');
    // Idle before the change: no diagnostic in either channel.
    expect(pill.dataset.state).toBe('idle');
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(pill.getAttribute('title')).toBeNull();
    expect(document.querySelector('.status-detail')?.textContent).toBe('');

    const select = modelSelects()[0];
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    // T3: the PATCH starts at the action, not at the dropdown.
    applyAction().click();
    await patchStarted;
    await flush();

    // In flight: concise visible word, busy state, full diagnostic in the tooltip AND
    // in the hidden live-region child.
    expect(pill.dataset.state).toBe('saving');
    expect(document.querySelector('.status-text')?.textContent).toBe('saving');
    expect(pill.getAttribute('title')).toBe('saving agent configuration');
    expect(document.querySelector('.status-detail')?.textContent).toBe('saving agent configuration');

    if (releasePatch === undefined) throw new Error('the PATCH never started');
    releasePatch();
    await flush();
    await flush();

    // Settled: the diagnostic is replaced (not appended) and the state is ready.
    // This harness has no session yet, so the harness PATCH reports the
    // "applies to new sessions" wording (the session PATCH says "next request").
    expect(pill.dataset.state).toBe('idle');
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(pill.getAttribute('title')).toBe(
        'agent configuration saved · applies to new sessions'
    );
    expect(document.querySelector('.status-detail')?.textContent).toBe(
        'agent configuration saved · applies to new sessions'
    );
    // T3: the dialog reports the same outcome in its own footer, and the drafts are
    // cleared because the write was confirmed.
    expect(document.querySelector('.agent-dialog-error')?.textContent).toBe('');
    expect(byClass('.agent-dialog-footer-note', 'p').textContent).toBe(
        'agent configuration saved · applies to new sessions'
    );
    expect(applyAction().disabled).toBe(true);
});

it('clears the accessible status diagnostic when the state resets', async () => {
    // A rejected PATCH writes a diagnostic; a later bare `setStatus('idle')`
    // (selecting a harness) must EMPTY the live-region detail so the stale failure
    // cannot be re-read.
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [descriptor()] }));
            if (url === '/api/models') return json({ models: ['m1', 'm2'] });

            if (url === '/api/harnesses/instruct' && init?.method === 'PATCH') {
                return json({ error: { message: 'That model is not available to this provider.' } }, 400);
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    const select = modelSelects()[0];
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    applyAction().click();
    await flush();

    const pill = byClass('.status', 'span');
    expect(pill.dataset.state).toBe('error');
    expect(document.querySelector('.status-detail')?.textContent).toBe(
        'agent configuration: That model is not available to this provider.'
    );

    // Picking the harness resets the app pill to the bare `idle` state.
    byClass('.harness-item', 'button').click();
    await flush();

    expect(pill.dataset.state).toBe('idle');
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(pill.getAttribute('title')).toBeNull();
    expect(document.querySelector('.status-detail')?.textContent).toBe('');
});

it('edits a saved session’s live models through PATCH /sessions/:id and keeps its team frozen', async () => {
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const saved = snapshot({
        id: 's9',
        status: 'idle',
        model: 'm1',
        agentModels: { instruct: 'm2', summarizer: 'm1' },
        harnessDefinition: frozen,
        turns: [
            {
                id: 't1',
                index: 0,
                prompt: 'earlier',
                status: 'done',
                startedAt: 10,
                updatedAt: 20,
                events: [{ type: 'start', agent: 'instruct', model: 'm2' }]
            }
        ]
    });
    // The server's answer to the PATCH: the same snapshot envelope as GET, with only
    // the live model map moved on. `harnessDefinition` keeps its creation-time map.
    const patched = snapshot({
        ...saved,
        agentModels: { instruct: 'm3', summarizer: 'm1' }
    });

    localStorage.setItem(SESSION_KEY, 's9');
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({
                url,
                method,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            if (url === '/api') return json(bootstrap({ sessions: [saved] }));
            // m2 is deliberately absent: a stored id must still render.
            if (url === '/api/models') return json({ models: ['m1', 'm3'] });
            if (url === '/api/sessions/s9' && method === 'PATCH') return json({ session: patched });
            if (url === '/api/sessions/s9') return json({ session: saved });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // The TEAM and the INSTRUCTIONS are still frozen: the roster controls and the
    // instruction editor are disabled with the real reason on each of them, `[+]`
    // cannot add, and the action cannot promote. R7: there is no lock notice and no
    // in-row "New session" link. T3/R1: a saved session prints NO header note at all —
    // the strip under the title is what says which conversation is open, and it keeps its
    // own independent New session action, which stays usable.
    expect(document.querySelector('.harness-note')?.textContent).toBe('');
    expect(document.querySelector<HTMLElement>('.harness-note')?.hidden).toBe(true);
    expect(document.querySelector('.session-pill-select')?.getAttribute('data-active')).toBe('true');
    openDeck();
    const frozenReason =
        'A saved conversation keeps the agent team and the instructions it was created with; only models can change here. Edits saved on the harness apply to a new session.';
    expect(byClass('.agent-dialog-instruction', 'textarea').disabled).toBe(true);
    expect(byClass('.agent-dialog-instruction', 'textarea').title).toBe(
        'A saved conversation runs the instructions it was created with. Edit them on the harness to use them in a new session.'
    );
    expect(byClass('.agent-dialog-remove', 'button').disabled).toBe(true);
    expect(byClass('.agent-dialog-remove', 'button').title).toBe(frozenReason);
    expect(byClass('.agent-dialog-add', 'button').disabled).toBe(true);
    // R3: the explanation paragraph is gone; the frozen roster is the saved team, and
    // a nonmember never appears in it.
    expect(document.querySelector('.agent-dialog-note')).toBeNull();
    expect(applyAction().textContent).toBe('Save configuration');
    expect(applyAction().disabled).toBe(true);
    expect(document.querySelector('.agent-lock')).toBeNull();
    expect(document.querySelector('.agent-row-wrap .link-button')).toBeNull();
    const stripNewSession = byClass('.new-session', 'button');
    expect(stripNewSession.textContent).toBe('+ New');
    expect(stripNewSession.disabled).toBe(false);

    // Effective live values (not the live descriptor's map, which only has instruct)
    // with the MODEL control enabled (R2). One select per configuration, reached
    // through the roster strip.
    const instructSelect = modelSelects()[0];
    expect(instructSelect.value).toBe('m2');
    expect(instructSelect.selectedOptions[0].textContent).toBe('m2');
    expect(instructSelect.disabled).toBe(false);
    expect(instructSelect.title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );
    expect(optionTexts(instructSelect)).toEqual(['m1', 'm2', 'm3']);

    selectConfigured('summarizer');
    const summarizerSelect = modelSelects()[0];
    expect(summarizerSelect.value).toBe('');
    expect(summarizerSelect.selectedOptions[0].textContent).toBe('m1');
    expect(summarizerSelect.disabled).toBe(false);
    expect(summarizerSelect.title).toBe(
        'Model for Summarizer. Applies to the next request in this session.'
    );

    // --- change one model: DRAFT, then the action PATCHes the SESSION -------
    selectConfigured('instruct');
    const edited = modelSelects()[0];
    edited.value = 'm3';
    edited.dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);

    applyAction().click();
    await flush();

    // The complete live map travels: the summarizer's m1 is preserved, the edited
    // member carries the new id.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        {
            url: '/api/sessions/s9',
            method: 'PATCH',
            body: { agentModels: { instruct: 'm3', summarizer: 'm1' } }
        }
    ]);
    // The frozen definition is historical: no harness PATCH races the edit.
    expect(calls.some((call) => call.url.startsWith('/api/harnesses/'))).toBe(false);

    // The answer is applied like any GET snapshot, so the control shows the new id
    // and m2 (no longer effective) disappears from the options.
    expect(modelSelects()[0].value).toBe('m3');
    expect(optionTexts(modelSelects()[0])).toEqual(['m1', 'm3']);
    selectConfigured('summarizer');
    expect(modelSelects()[0].value).toBe('');
    // R3: concise visible state; the save confirmation is the pill's tooltip.
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(document.querySelector('.status')?.getAttribute('title')).toBe(
        'agent models saved · next request'
    );
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
});

it('changes a RUNNING session’s model without cancelling the stream', async () => {
    // A session this tab opened while it was already running: the server owns the
    // run, the browser polls it, and the pill says so.
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const running = snapshot({
        id: 's7',
        status: 'running',
        model: 'm1',
        agentModels: { instruct: 'm2', summarizer: 'm1' },
        harnessDefinition: frozen,
        turns: [
            {
                id: 't1',
                index: 0,
                prompt: 'long task',
                status: 'running',
                startedAt: 10,
                updatedAt: 20,
                events: [
                    { type: 'start', agent: 'instruct', model: 'm2' },
                    { type: 'text', agent: 'instruct', delta: 'working' }
                ]
            }
        ]
    });
    const patched = snapshot({ ...running, agentModels: { instruct: 'm3', summarizer: 'm1' } });

    localStorage.setItem(SESSION_KEY, 's7');
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({
                url,
                method,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            if (url === '/api') return json(bootstrap({ sessions: [running] }));
            if (url === '/api/models') return json({ models: ['m1', 'm3'] });
            if (url === '/api/sessions/s7' && method === 'PATCH') return json({ session: patched });
            if (url === '/api/sessions/s7') return json({ session: running });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // The observer route is not stubbed here, so the UI falls back to the
    // documented GET polling path; either way the session is running and the app
    // header stays neutral (run state belongs to the tiles).
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    // Team still frozen while running; MODELS editable (R2).
    openDeck();
    expect(byClass('.agent-dialog-instruction', 'textarea').disabled).toBe(true);
    expect(modelSelects()[0].disabled).toBe(false);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    const runningSelect = modelSelects()[0];
    runningSelect.value = 'm3';
    runningSelect.dispatchEvent(new Event('change', { bubbles: true }));
    // T3: the stream keeps running while the reader decides; nothing is sent until the
    // action, and the action here can only save a model.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(applyAction().disabled).toBe(false);

    applyAction().click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        {
            url: '/api/sessions/s7',
            method: 'PATCH',
            body: { agentModels: { instruct: 'm3', summarizer: 'm1' } }
        }
    ]);
    // Nothing cancels or restarts the run: no cancel route. The composer's stop
    // action is AVAILABLE because this session has pending work (R4/R10: a reloaded
    // running session can be stopped, and Stop cancels all); it does not own an
    // observation either way.
    expect(calls.some((call) => call.url.endsWith('/cancel'))).toBe(false);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
    expect(byClass('.composer-action', 'button').disabled).toBe(false);

    expect(modelSelects()[0].value).toBe('m3');
    selectConfigured('summarizer');
    expect(modelSelects()[0].value).toBe('');
    selectConfigured('instruct');
    // The save is config feedback; the session's run state stays on its tile, so the
    // header does not claim "session running".
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(document.querySelector('.status')?.getAttribute('title')).toBe(
        'agent models saved · next request'
    );
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Stop the background poll this view scheduled before the test ends.
    window.dispatchEvent(new Event('pagehide'));
});

it('shows a session model-change error and keeps the last confirmed value', async () => {
    const frozen = descriptor({ agentModels: { instruct: 'm2' } });
    const saved = snapshot({
        id: 's9',
        status: 'idle',
        model: 'm1',
        agentModels: { instruct: 'm2', summarizer: 'm1' },
        harnessDefinition: frozen,
        turns: []
    });

    localStorage.setItem(SESSION_KEY, 's9');
    const calls: string[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push(`${init?.method ?? 'GET'} ${url}`);

            if (url === '/api') return json(bootstrap({ sessions: [saved] }));
            if (url === '/api/models') return json({ models: ['m1', 'm3'] });
            if (url === '/api/sessions/s9' && init?.method === 'PATCH') {
                return json({ error: { message: 'That model is not available to this session.' } }, 400);
            }
            if (url === '/api/sessions/s9') return json({ session: saved });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // T3: the draft is written by the action, and a saved session's model save still
    // goes to PATCH /sessions/:id (never to the harness).
    const select = modelSelects()[0];
    select.value = 'm3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls.filter((call) => call.startsWith('PATCH'))).toEqual([]);

    applyAction().click();
    await flush();

    expect(byClass('.status', 'span').dataset.state).toBe('error');
    expect(document.querySelector('.status-text')?.textContent).toBe('error');
    expect(document.querySelector('.status')?.getAttribute('title')).toBe(
        'agent models: That model is not available to this session.'
    );
    // R2 (T3): the refused draft is KEPT so the reader can retry, and the dialog says
    // why instead of closing. The SERVER's confirmed map is what the team list shows.
    expect(modelSelects()[0].value).toBe('m3');
    expect(applyAction().disabled).toBe(false);
    expect(document.querySelector('.agent-dialog-error')?.textContent).toBe(
        'That model is not available to this session.'
    );
    expect(
        document.querySelector('.agent-dialog-agent[data-agent="instruct"] .agent-dialog-agent-model')?.textContent
    ).toBe('m2');
    expect(calls).toContain('PATCH /api/sessions/s9');
    expect(calls.some((call) => call.includes('/api/harnesses/'))).toBe(false);
});

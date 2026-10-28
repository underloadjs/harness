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

import type { HarnessDescriptor, SessionSnapshot } from '../../server/protocol';
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
        coreTools: ['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate'],
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

const modelSelects = (): HTMLSelectElement[] => [
    ...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')
];

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

    // One dropdown per member, each labelled for its agent and showing the
    // effective model. Option 0 is the default labelled m1, so m1 is not repeated.
    expect(modelSelects().map((select) => select.getAttribute('aria-label'))).toEqual([
        'Model for Instruct',
        'Model for Summarizer'
    ]);
    const [instruct, summarizer] = modelSelects();
    expect(optionTexts(instruct)).toEqual(['m1', 'm2', 'm3']);
    expect(instruct.value).toBe('m2');
    // The summarizer's explicit override equals the fallback, so the default
    // option represents it and already displays m1.
    expect(summarizer.value).toBe('');
    expect(summarizer.selectedOptions[0].textContent).toBe('m1');

    // --- change one model: the complete map goes with it ------------------
    instruct.value = 'm3';
    instruct.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches[0]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer'],
        agentModels: { instruct: 'm3', summarizer: 'm1' }
    });
    expect(modelSelects().map((select) => select.value)).toEqual(['m3', '']);
    expect(modelSelects()[1].selectedOptions[0].textContent).toBe('m1');

    // --- adding a member preserves existing entries -----------------------
    byClass('.agent-add', 'button').click();
    document
        .querySelector<HTMLButtonElement>('.agent-option[data-agent="critic"] .agent-option-add')
        ?.click();
    await flush();

    expect(patches[1]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer', 'critic'],
        agentModels: { instruct: 'm3', summarizer: 'm1' }
    });

    // --- a new member can get its own model -------------------------------
    const critic = modelSelects()[2];
    expect(critic.value).toBe('');
    critic.value = 'm2';
    critic.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches[2]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer', 'critic'],
        agentModels: { instruct: 'm3', summarizer: 'm1', critic: 'm2' }
    });

    // --- promotion preserves every mapping --------------------------------
    document.querySelectorAll<HTMLButtonElement>('.agent-main')[2].click();
    await flush();

    expect(patches[3]).toEqual({
        primary: 'critic',
        subagents: ['instruct', 'summarizer'],
        agentModels: { instruct: 'm3', summarizer: 'm1', critic: 'm2' }
    });
    expect(document.querySelector('.agent-tile')?.dataset.agent).toBe('critic');

    // --- removal drops only the removed member's key ----------------------
    // Tiles are now [critic, instruct, summarizer]; index 2 is summarizer.
    document.querySelectorAll<HTMLButtonElement>('.agent-remove')[2].click();
    await flush();

    expect(patches[4]).toEqual({
        primary: 'critic',
        subagents: ['instruct'],
        agentModels: { instruct: 'm3', critic: 'm2' }
    });
    expect(modelSelects().map((select) => select.value)).toEqual(['m2', 'm3']);

    // --- choosing the default deletes the key (not an empty entry) ---------
    modelSelects()[1].value = '';
    modelSelects()[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches[5]).toEqual({
        primary: 'critic',
        subagents: ['instruct'],
        agentModels: { critic: 'm2' }
    });
    expect(modelSelects()[1].value).toBe('');
    expect(optionTexts(modelSelects()[1])[0]).toBe('m1');
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

    modelSelects()[0].value = 'm2';
    modelSelects()[0].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(byClass('.status', 'span').dataset.state).toBe('error');
    expect(document.querySelector('.status-text')?.textContent).toBe(
        'agent models: That model is not available to this provider.'
    );
    // The row is redrawn from the descriptor the server last confirmed, so it does
    // not pretend the rejected change stuck.
    expect(modelSelects()[0].value).toBe('');
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

    // The TEAM is still frozen: promotion, add and remove are disabled, and the
    // existing explanation plus New session affordance stay on screen.
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'Viewing a saved session · agent team frozen'
    );
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    expect(byClass('.agent-add', 'button').disabled).toBe(true);
    expect(byClass('.agent-remove', 'button').disabled).toBe(true);
    expect(document.querySelector('.agent-lock-text')?.textContent).toBe(
        'This saved session keeps the agent team it started with.'
    );
    expect(document.querySelector('.agent-lock .link-button')?.textContent).toBe('New session');

    const selects = modelSelects();
    // Effective live values (not the live descriptor's map, which only has
    // instruct) with the MODEL controls enabled (R2).
    expect(selects.map((select) => select.value)).toEqual(['m2', '']);
    expect(selects.map((select) => select.selectedOptions[0].textContent)).toEqual(['m2', 'm1']);
    expect(selects.map((select) => select.disabled)).toEqual([false, false]);
    expect(selects.map((select) => select.title)).toEqual([
        'Model for Instruct. Applies to the next request in this session.',
        'Model for Summarizer. Applies to the next request in this session.'
    ]);
    expect(optionTexts(selects[0])).toEqual(['m1', 'm2', 'm3']);

    // --- change one model: PATCH the SESSION, not the harness ---------------
    selects[0].value = 'm3';
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
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
    expect(modelSelects().map((select) => select.value)).toEqual(['m3', '']);
    expect(optionTexts(modelSelects()[0])).toEqual(['m1', 'm3']);
    expect(document.querySelector('.status-text')?.textContent).toBe(
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
    // documented GET polling path; either way the session is running.
    expect(byClass('.status', 'span').dataset.state).toBe('running');
    expect(document.querySelector('.status-text')?.textContent).toBe(
        'live stream lost · polling server'
    );
    // Team still frozen while running; MODELS editable (R2).
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    expect(modelSelects().map((select) => select.disabled)).toEqual([false, false]);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    modelSelects()[0].value = 'm3';
    modelSelects()[0].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        {
            url: '/api/sessions/s7',
            method: 'PATCH',
            body: { agentModels: { instruct: 'm3', summarizer: 'm1' } }
        }
    ]);
    // Nothing cancels or restarts the run: no cancel route. Stop is AVAILABLE
    // because this session has pending work (R4: a reloaded running session can be
    // stopped, and Stop cancels all); it does not own an observation either way.
    expect(calls.some((call) => call.url.endsWith('/cancel'))).toBe(false);
    expect(byClass('.stop', 'button').disabled).toBe(false);

    expect(modelSelects().map((select) => select.value)).toEqual(['m3', '']);
    // The session is still running, so the pill reports that instead of "idle".
    expect(document.querySelector('.status-text')?.textContent).toBe(
        'agent models saved · session running'
    );
    expect(byClass('.status', 'span').dataset.state).toBe('running');
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

    modelSelects()[0].value = 'm3';
    modelSelects()[0].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(byClass('.status', 'span').dataset.state).toBe('error');
    expect(document.querySelector('.status-text')?.textContent).toBe(
        'agent models: That model is not available to this session.'
    );
    // The rejected value did not stick; the last server-confirmed map is redrawn.
    expect(modelSelects().map((select) => select.value)).toEqual(['m2', '']);
    expect(calls).toContain('PATCH /api/sessions/s9');
    expect(calls.some((call) => call.includes('/api/harnesses/'))).toBe(false);
});

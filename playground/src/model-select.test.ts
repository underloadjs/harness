// Per-member model selection on the agent tiles (R9).
//
// Covered here:
//   - every tile has its own labelled dropdown with an inherit choice, the
//     provider catalogue, and the current override even when the catalogue no
//     longer lists it;
//   - a model change PATCHes the complete override map;
//   - promotion/add preserve the map, removal drops the removed member's key, and
//     choosing "inherit" deletes that member's entry;
//   - a saved (frozen) session displays its EFFECTIVE frozen models with the
//     dropdowns locked and the existing New session affordance, so an old chat is
//     never silently rewritten.

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
        coreTools: ['requestTools', 'createTool', 'todoTools', 'delegate'],
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
    // override; options are inherit + catalogue.
    expect(modelSelects().map((select) => select.getAttribute('aria-label'))).toEqual([
        'Model for instruct',
        'Model for summarizer'
    ]);
    const [instruct, summarizer] = modelSelects();
    expect(optionTexts(instruct)).toEqual(['inherit · m1', 'm1', 'm2', 'm3']);
    expect(instruct.value).toBe('m2');
    expect(summarizer.value).toBe('m1');

    // --- change one model: the complete map goes with it ------------------
    instruct.value = 'm3';
    instruct.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches[0]).toEqual({
        primary: 'instruct',
        subagents: ['summarizer'],
        agentModels: { instruct: 'm3', summarizer: 'm1' }
    });
    expect(modelSelects().map((select) => select.value)).toEqual(['m3', 'm1']);

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

    // --- inherit deletes the key (not an empty-string entry) --------------
    modelSelects()[1].value = '';
    modelSelects()[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches[5]).toEqual({
        primary: 'critic',
        subagents: ['instruct'],
        agentModels: { critic: 'm2' }
    });
    expect(modelSelects()[1].value).toBe('');
    expect(optionTexts(modelSelects()[1])[0]).toBe('inherit · m1');
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

it('shows a reloaded session’s frozen effective models and locks the dropdowns', async () => {
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

    localStorage.setItem(SESSION_KEY, 's9');
    let patches = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ sessions: [saved] }));
            // m2 is deliberately absent: a frozen id must still render.
            if (url === '/api/models') return json({ models: ['m1', 'm3'] });
            if (url === '/api/sessions/s9') return json({ session: saved });
            if (url.startsWith('/api/harnesses/') && init?.method === 'PATCH') {
                patches += 1;
                return json({ harness: frozen });
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'Viewing a saved session · agent team frozen'
    );

    const selects = modelSelects();
    // Effective frozen values, not the live descriptor's map (which only has
    // instruct) and not the current global model.
    expect(selects.map((select) => select.value)).toEqual(['m2', 'm1']);
    expect(selects.map((select) => select.disabled)).toEqual([true, true]);

    // The frozen id is offered even though the catalogue no longer lists it.
    expect(optionTexts(selects[0])).toEqual(['inherit · m1', 'm1', 'm3', 'm2 (current)']);
    // A model that IS in the catalogue is not duplicated as "(current)".
    expect(optionTexts(selects[1])).toEqual(['inherit · m1', 'm1', 'm3']);

    // The lock is explained with the existing New session affordance; changing a
    // select cannot PATCH the frozen conversation.
    expect(document.querySelector('.agent-lock-text')?.textContent).toBe(
        'This saved session keeps the agent team it started with.'
    );
    expect(document.querySelector('.agent-lock .link-button')?.textContent).toBe('New session');

    selects[0].value = 'm3';
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches).toBe(0);
});

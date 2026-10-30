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
//     the server instructions, and is honest about a frozen saved-session team while
//     models/instructions stay reachable;
//   - R13: closing restores focus to the composer button and a live rebuild keeps the
//     open dialog (and the control the reader was using) in place.

import type { AgentDescriptor, HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
        coreTools: ['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate'],
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

afterEach(() => {
    // A leaked dialog overlay would own the next test's focus/Escape handling.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
        button.click();
    }
    vi.unstubAllGlobals();
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
        vi.fn(async (input: RequestInfo | URL) => {
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
        })
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
        vi.fn(async (input: RequestInfo | URL) => {
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
        })
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

    // R12: the dialog offers a primary chooser, the existing deck and the instructions.
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
        ['workspace', 'Coder', 'false', false]
    ]);
    expect(document.querySelector('.agent-dialog .agent-row-wrap')).not.toBeNull();
    expect(document.querySelector('.agent-dialog-instructions')).not.toBeNull();

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
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        })
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();
    byClass('.agent-dialog-primary[data-agent="research"]', 'button').click();
    await flush();
    await flush();

    // The existing complete-team PATCH path, not a new endpoint.
    expect(patches[0]).toEqual({ primary: 'research', subagents: ['instruct', 'workspace'] });

    // The open dialog is refreshed in place: title, pressed state and the composer
    // button all report the promoted agent.
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Agents · Researcher');
    expect(document.querySelector('.dialog')).not.toBeNull();
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-primary')].map((entry) => [
            entry.dataset.agent,
            entry.getAttribute('aria-pressed')
        ])
    ).toEqual([
        ['research', 'true'],
        ['instruct', 'false'],
        ['workspace', 'false']
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
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        })
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();

    // The dialog adopts the EXISTING per-agent selects (same options/state as the old
    // deck), ordered by team membership.
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
    expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
        'Model for Instruct',
        'Model for Researcher',
        'Model for Coder'
    ]);
    const instruct = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    expect(instruct.value).toBe('m2');

    instruct.focus();
    instruct.value = 'm3';
    instruct.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await flush();

    // The complete override map is sent (the server replaces, never merges).
    expect(patches[0]).toEqual({
        primary: 'instruct',
        subagents: ['research', 'workspace'],
        agentModels: { instruct: 'm3' }
    });

    // The dialog is still the same modal, shows the new value and has moved focus to
    // the REPLACEMENT select the reader was operating.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    const replaced = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    expect(replaced.value).toBe('m3');
    expect(document.activeElement).toBe(replaced);
});

it('shows every agent instruction and guideline inside the dialog', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
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
        })
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();

    // R12: team members first, then any other catalogue preset; the existing
    // read-only preset-detail markup is reused (`.agent-detail` / `.agent-instruction`).
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-detail-summary')].map(
            (summary) => summary.textContent
        )
    ).toEqual(['Instruct', 'Researcher', 'Coder']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-instruction')].map(
            (node) => node.textContent
        )
    ).toEqual(['Answer directly.', 'Investigate.', 'Write code.']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-guideline')].map(
            (node) => node.textContent
        )
    ).toEqual(['Keep diffs small.']);
});

it('keeps a saved session’s team locked while models and instructions stay reachable', async () => {
    const session = snapshot({ harnessDefinition: descriptor() } as Partial<SessionSnapshot>);
    localStorage.setItem(SESSION_KEY, 's1');

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
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
        })
    );

    await import('./main');
    await flush();
    await flush();

    const button = byClass('.agent-control-button', 'button');
    // The compact button is NEVER disabled: the dialog is still the way to inspect
    // models and instructions for this conversation.
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('The agent team is locked for this conversation.');

    button.click();

    // R12 restriction preserved: team controls are disabled and the REAL reason is
    // stated in the dialog (not invented, not a dead control).
    expect(byClass('.agent-dialog-note', 'p').textContent).toBe(
        'The agent team is locked for this conversation.'
    );
    expect(
        [...document.querySelectorAll<HTMLButtonElement>('.agent-dialog-primary')].map(
            (entry) => entry.disabled
        )
    ).toEqual([true, true, true]);
    for (const main of document.querySelectorAll<HTMLButtonElement>('.agent-main')) {
        expect(main.disabled).toBe(true);
    }
    expect(byClass('.agent-add', 'button').disabled).toBe(true);

    // R2: the model map is live even in a saved session.
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
    expect(selects.map((select) => select.disabled)).toEqual([false, false, false]);
    expect(selects[0].title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );

    // Instructions are read-only data, so they never depend on the team lock.
    expect(
        [...document.querySelectorAll<HTMLElement>('.agent-dialog-instructions .agent-instruction')].map(
            (node) => node.textContent
        )
    ).toEqual(['Answer directly.', 'Investigate.', 'Write code.']);
});

it('keeps the open dialog and the focused control across a live snapshot rebuild', async () => {
    const session = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        updatedAt: 2
    });
    localStorage.setItem(SESSION_KEY, 's1');

    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
        }
    });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
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
            if (url === '/api/sessions/s1/events') {
                return new Response(streamBody, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    byClass('.agent-control-button', 'button').click();
    const firstSelect = byClass<HTMLSelectElement>(
        '.agent-model-select[aria-label="Model for Instruct"]',
        'select'
    );
    firstSelect.focus();
    expect(document.activeElement).toBe(firstSelect);

    const pushSnapshot = async (updatedAt: number): Promise<void> => {
        if (streamController === undefined) throw new Error('stream not attached');
        streamController.enqueue(
            new TextEncoder().encode(
                `data: ${JSON.stringify({
                    type: 'snapshot',
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'idle',
                        updatedAt
                    })
                })}\n\n`
            )
        );
        await flush();
        await flush();
    };

    // Identical agent state: the dialog stays open and the SAME node keeps focus (a
    // rebuild would have replaced it and dropped focus onto the close button).
    await pushSnapshot(10);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(document.activeElement).toBe(firstSelect);

    // Lifecycle: a new conversation dismisses the dialog rather than carrying it into
    // an empty session.
    byClass('.new-session', 'button').click();
    await flush();
    expect(document.querySelector('.dialog')).toBeNull();
});

// The app shell painting THROUGH the extension registry (T5/R1).
//
// Two boots of the SAME fixture, the only difference being one `registerShellPanel`
// call:
//
//   1. nothing registered BY THIS TEST -> the scratch board's tool card is the
//      byte-for-byte card the shell has always rendered (the string `TOOL_CARD` below,
//      which is also what the untouched ./../scratch-board.test.ts pins). "Nothing
//      registered" is the seam's own view: `main.ts` does register the two live panels
//      of T6 at boot, and those nodes are excluded by id here so the claim stays
//      "the tool card did not move", which is what this file is about;
//   2. one live panel registered -> that exact card, unchanged, with the extension's
//      element after it, and the panel mounted for the conversation on screen.
//
// The second case then follows the reader: switching conversations, starting a new
// one, and reopening the first must dispose and re-create the instance, because the
// panel holds a listener and a timer that belong to one conversation. That is the
// lifecycle proven against the REAL session pointers of `main.ts`, not a fake paint.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from '../view-test-support';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly.',
        instruction: 'Answer the request.',
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

const turn = (overrides: Partial<SessionTurn>): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'done',
    startedAt: T,
    updatedAt: T + 1000,
    events: [],
    ...overrides
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const stubFetch = (
    handler: (url: string, method: string | undefined) => Response | undefined
): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = handler(String(input), init?.method);
            if (response === undefined) throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${input}`);

            return response;
        }, { root: '/api' }))
    );
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

const scratchHost = (): HTMLElement => byClass('.panel-host[data-slot="scratch"]', 'div');

// The board's two conversations. s1 carries the one recorded panel this file is
// written around; s2 carries a different one, so a leak across a switch is visible.
const first = snapshot({
    id: 's1',
    createdAt: T,
    updatedAt: T + 5_000,
    turns: [
        turn({
            events: [
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'statusTool',
                    content: 'ok',
                    isError: false,
                    ui: [
                        {
                            id: 'status',
                            slot: 'scratch',
                            title: 'Status',
                            blocks: [{ type: 'text', text: 'ready' }]
                        }
                    ]
                }
            ]
        })
    ]
});

const second = snapshot({
    id: 's2',
    turns: [
        turn({
            id: 't2',
            events: [
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'statusTool',
                    content: 'ok',
                    isError: false,
                    ui: [
                        {
                            id: 'other',
                            slot: 'scratch',
                            title: 'Other',
                            blocks: [{ type: 'text', text: 'elsewhere' }]
                        }
                    ]
                }
            ]
        })
    ]
});

const serve = (): void => {
    let made = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: first });
        if (url === '/api/sessions/s2' && method === undefined) return json({ session: second });

        // T3 (R1): the header `+` CREATES a conversation. A POST on the directory's own path,
        // answered with a fresh 0-turn record under the harness the BODY names — the created
        // row is what the live panel below re-mounts for, so the fixture has to serve it.
        if (url === '/api/sessions' && method === 'POST') {
            made += 1;

            return json({ session: snapshot({ id: `made-${made}`, createdAt: 900, updatedAt: 900 }) }, 201);
        }
        if (url === '/api/sessions/made-1' && method === undefined)
            return json({ session: snapshot({ id: 'made-1', createdAt: 900, updatedAt: 900 }) });

        return undefined;
    });
};

// A live panel: one listener (released by the context's signal), one interval
// (released by an explicit disposer) and a mount log labelled per instance, so a
// disposal is an OBSERVED effect rather than a call count.
const mountLog: string[] = [];

const installLivePanel = async (): Promise<void> => {
    // `vi.resetModules()` gives `../main` a FRESH copy of this subsystem, so the
    // registry a statically imported handle would write into is not the one the shell
    // reads (the same discipline ./scratch-board.test.ts:20-31 describes for the
    // stream double). Import the seam AFTER the reset, through the same specifier the
    // shell uses.
    const extensions = await import('./index');
    let instances = 0;

    extensions.registerShellPanel({
        id: 'tasks',
        title: 'Tasks',
        mount: (context) => {
            instances += 1;
            const self = instances;
            mountLog.push(`mount:${self}:${context.sessionId ?? 'none'}`);

            window.addEventListener('resize', () => mountLog.push(`resize:${self}`), { signal: context.signal });

            const timer = window.setInterval(() => mountLog.push(`tick:${self}`), 1_000);
            context.onDispose(() => {
                window.clearInterval(timer);
                mountLog.push(`dispose:${self}`);
            });
        }
    });
};

const openSession = async (id: string): Promise<void> => {
    byClass('.harness-title-button', 'button').click();
    byClass(`.session-pills-bar-dialog .session-pill-select[data-session-id="${id}"]`, 'button').click();
    await flush();
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    mountLog.length = 0;
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.setItem(SESSION_KEY, 's1');
    serve();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// The card the shell draws for `first`'s recorded panel: the COMPACT summary card
// (state, shape list, disclosure note and expand action), exactly as the untouched
// ../scratch-board.test.ts pins it. Both tests below compare against this one string,
// which is what makes "a registered panel changed nothing" a checkable claim.
const TOOL_CARD =
    '<article class="panel" data-panel-id="status" data-panel-slot="scratch" data-panel-state="summary" ' +
    'data-panel-tool="statusTool"><h3 class="panel-title">Status</h3>' +
    '<div class="panel-blocks"><p class="panel-text">ready</p>' +
    '<dl class="panel-kv" data-block="keyValue"><dt class="panel-kv-label">text</dt>' +
    '<dd class="panel-kv-value">5 characters</dd></dl></div>' +
    '<p class="panel-note" title="This card is the compact view. Use Open the full panel for the recorded ' +
    'content.">compact view · preview only</p><div class="panel-actions">' +
    '<button class="button small panel-expand" type="button">Open the full panel</button></div></article>';

// The two live panels `main.ts` registers at boot (T6: ./extensions/records-panels.ts).
// Both tests below pin the TOOL card and ONE named test panel, so the built-ins are
// excluded by class — `panel-extension` is what the runtime stamps on an extension node
// (./runtime.ts:104) and never on a tool card — and by id, so the assertion still names
// the panel it is about.
const BUILTIN_PANEL_IDS = ['harness.tasks', 'harness.records'];

const toolCardsIn = (): HTMLElement[] =>
    [...scratchHost().querySelectorAll<HTMLElement>('.panel')].filter(
        (node) => !node.classList.contains('panel-extension')
    );

const extensionNodesIn = (): HTMLElement[] =>
    [...scratchHost().querySelectorAll<HTMLElement>('.panel-extension')].filter(
        (node) => !BUILTIN_PANEL_IDS.includes(node.dataset.panelExtension ?? '')
    );

it('paints the scratch board unchanged with an empty registry', async () => {
    await import('../main');
    await flush();
    await flush();

    // The rail section is still head, note, host. What the host holds is the tool card
    // BYTE-FOR-BYTE, plus the two live panels the shell itself registers at boot — the
    // seam adds nodes and changes nothing about a card it already drew, which is the
    // claim this test exists to pin.
    expect(document.querySelector('.rail-right > .rail-section')?.className).toBe('rail-section scratch-section');
    expect(scratchHost().previousElementSibling?.className).toBe('field-hint scratch-note');
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for instruct.');
    expect(toolCardsIn().map((node) => node.outerHTML)).toEqual([TOOL_CARD]);
    expect(scratchHost().querySelectorAll('.panel-extension')).toHaveLength(2);
    expect(
        [...scratchHost().querySelectorAll<HTMLElement>('.panel-extension')].map((node) => node.dataset.panelExtension)
    ).toEqual(BUILTIN_PANEL_IDS);
    expect(scratchHost().hidden).toBe(false);
});

it('mounts, switches and disposes a registered live panel without touching the tool card', async () => {
    await installLivePanel();
    await import('../main');
    await flush();
    await flush();

    // Mounted EXACTLY once, for the conversation on screen (the boot paint runs before
    // the remembered session is read, and a session-scoped panel waits for it), and
    // after the tool card — which is the byte-for-byte card of the empty-registry boot.
    expect(mountLog).toEqual(['mount:1:s1']);
    expect(toolCardsIn().map((node) => node.outerHTML)).toEqual([TOOL_CARD]);
    expect(extensionNodesIn().map((node) => node.outerHTML)).toEqual([
        '<div class="panel panel-extension" data-panel-extension="tasks" data-panel-slot="scratch">' +
            '<h3 class="panel-title">Tasks</h3></div>'
    ]);

    // The note still counts TOOL panels: a registered live panel cannot rewrite the
    // rail's copy, which is what the pre-existing scratch-board assertions pin.
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for instruct.');

    // The listener belongs to the mounted instance and answers while it lives.
    window.dispatchEvent(new Event('resize'));
    expect(mountLog).toEqual(['mount:1:s1', 'resize:1']);

    // A session SWITCH disposes instance 1 and mounts instance 2 for s2's conversation
    // — one element, no residue from the previous chat.
    await openSession('s2');

    expect(mountLog).toEqual(['mount:1:s1', 'resize:1', 'dispose:1', 'mount:2:s2']);

    window.dispatchEvent(new Event('resize'));
    expect(mountLog).toEqual(['mount:1:s1', 'resize:1', 'dispose:1', 'mount:2:s2', 'resize:2']);

    expect(extensionNodesIn()).toHaveLength(1);
    // The card the TOOL pipeline drew for s2 is still the first card in the host — a
    // live panel is appended after the tool cards, never between them.
    expect(scratchHost().querySelector('.panel')?.getAttribute('data-panel-id')).toBe('other');

    // New session: the conversation the panel was mounted for is gone, so that instance is
    // disposed and a FRESH one is mounted for the conversation the create opened — T3 (R1)
    // means the press now lands on a real 0-turn record (`made-1`), and a session-scoped
    // panel re-mounts for it, exactly as it does for a pill switch. The listener of the old
    // instance stops answering; the new one's does.
    byClass('.harness-title-row .new-session', 'button').click();
    await flush();
    await flush();

    expect(mountLog).toEqual([
        'mount:1:s1',
        'resize:1',
        'dispose:1',
        'mount:2:s2',
        'resize:2',
        'dispose:2',
        'mount:3:made-1'
    ]);

    window.dispatchEvent(new Event('resize'));
    expect(mountLog[7]).toBe('resize:3');
    // The TOOL pipeline has nothing to draw for a conversation with no turns, so the board's
    // only nodes are the live panels — the test's `tasks` panel and the two the shell
    // registers — and the rail's copy says so.
    expect(toolCardsIn()).toHaveLength(0);
    expect(extensionNodesIn().map((node) => node.outerHTML)).toEqual([
        '<div class="panel panel-extension" data-panel-extension="tasks" data-panel-slot="scratch">' +
            '<h3 class="panel-title">Tasks</h3></div>'
    ]);
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );

    // Reopening s1 is a fresh instance, scoped to the conversation it now reads.
    await openSession('s1');

    expect(mountLog.slice(7)).toEqual(['resize:3', 'dispose:3', 'mount:4:s1']);
    expect(extensionNodesIn()).toHaveLength(1);
    expect(scratchHost().querySelector('.panel')?.getAttribute('data-panel-id')).toBe('status');
});

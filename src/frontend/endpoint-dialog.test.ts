// R4 (T4): the Endpoint & model settings are a DIALOG opened from the top-right status
// pill — they are no longer a `<details>` disclosure at the bottom of the left rail.
//
// What is pinned here, in the order the reader hits it:
//   - the trigger: the `<span class="status" role="status">` live region keeps its tag,
//     classes, ARIA and children, and a bare `<button class="status-button">` wraps it
//     (a live region cannot also be a button, so the two semantics nest);
//   - the dialog: title `Endpoint & model`, and inside it the Base URL / API key / Model
//     controls plus the model status line, the explanatory paragraph and the API-root
//     line — the same nodes the rail used to host, adopted rather than rebuilt;
//   - the data path is unchanged by the move: dialog edits still write the exact
//     `underload-harness-app:settings` payload, still fire ONE debounced catalogue
//     refresh, and still describe the next session the app creates;
//   - persistence across the dialog lifecycle: closing removes only the overlay, and the
//     reopen shows the SAME control nodes with the SAME values (no duplicates, no lost
//     listeners — the dropdown is still populated from the provider answer);
//   - dismissal: Escape, the × button and a backdrop click all close it and hand focus
//     back to the pill; a second press toggles instead of stacking; the pill is inert
//     while the tools view owns the centre (the same guard style as the harness title);
//   - the status live region still updates IN PLACE (same node, inside the wrapper) while
//     the dialog is open, and the settings still open from a non-idle state;
//   - the rail: no endpoint markup at all, and the left panel host is the rail's last
//     child where the disclosure used to sit;
//   - CSS (jsdom computes no media queries, so the sheet's source text is the contract —
//     the same convention compact-ui.test.ts and tool-chip-style.test.ts use): the
//     wrapper is a bare button with no clipping, the dialog body gets its own breathing
//     room, and the accordion rules (`.endpoint`, `.endpoint-summary`, its `::before`
//     chevron and its rotation) are gone.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
    HarnessAssistantMessage,
    HarnessDescriptor,
    SessionSnapshot,
    SessionTurn
} from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { API_ROOT } from './api';
import { viewAwareFetch } from './view-test-support';

const SETTINGS_KEY = 'underload-harness-app:settings';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
// Realistic epoch stamps: the shell formats real server milliseconds.
const T = 1_700_000_000_000;

// The API-root hint is built by `main.ts` from the SAME live binding, at module scope
// and therefore before boot can move the root, so the expected line is computed rather
// than guessed (`resolveApiRoot()` in api.ts documents that pre-probe value).
const API_ROOT_HINT = `API root: ${API_ROOT.length > 0 ? API_ROOT : '(origin)'} · override with ?apiRoot=/v1/harness`;

const descriptor = (overrides: Record<string, unknown> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['toolRequest'],
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
        instruction: 'Answer directly.',
        guidelines: []
    }
];

// One searchable catalogue entry: enough for the tools view to be a real view, which is
// what the status-pill guard keys off.
const tools = [
    {
        name: 'read',
        group: 'Files',
        description: 'Read one or more files.',
        tags: ['files', 'read'],
        visibility: 'searchable',
        parameters: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } } },
            required: ['paths']
        }
    }
];

const assistant = (overrides: Partial<HarnessAssistantMessage> = {}): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: 'm1',
    stopReason: 'stop',
    ...overrides
});

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

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools,
    defaults,
    sessions: [],
    agents,
    ...overrides
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// One SSE frame per stream item, exactly the shape `api.ts` parses.
const sse = (items: readonly unknown[]): Response => {
    const body = new TextEncoder().encode(
        items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('')
    );

    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(body);
                controller.close();
            }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
};

const flush = async (): Promise<void> => {
    await new Promise((done) => setTimeout(done, 30));
};

// Long enough for the 500ms catalogue debounce to have fired.
const pastDebounce = async (): Promise<void> => {
    await new Promise((done) => setTimeout(done, 650));
    await flush();
};

type Call = { url: string; method: string; body: unknown };

// Every boot answers the same two reads; a test adds the session/task routes it needs.
// An unmapped URL throws LOUDLY instead of letting a missing request masquerade as
// "nothing happened".
const stub = (extra?: (url: string, method: string, body: unknown) => Response | undefined): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const handled = extra?.(url, method, body);
            if (handled !== undefined) return handled;

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models' && method === 'POST') return json({ models: ['m1', 'm2'] });

            throw new Error(`unexpected request: ${method} ${url}`);
        }))
    );

    return calls;
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

const modelCalls = (calls: Call[]): Call[] => calls.filter((call) => call.url === '/api/models');

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

const openSettings = (): void => {
    byClass('.status-button', 'button').click();
};

const closeWithEscape = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

// `.field-select` is NOT endpoint-specific (the create-harness form wears the same
// classes), so every settings read is scoped to the dialog. `.model-manual` and
// `.endpoint-body` ARE unique to the settings, which is what makes the "no duplicate
// fields" assertions below exact rather than positional.
const settingsRoot = (): HTMLElement => byClass('.dialog .endpoint-body', 'div');

// --- the trigger ---------------------------------------------------------------

it('wraps the status live region in a bare dialog trigger in the top-right cluster', async () => {
    stub();
    await boot();

    const button = byClass('.status-button', 'button');
    const pill = byClass('.status', 'span');

    // The pill is unchanged by the move: still a `<span>` live region with the same
    // three children, in order.
    expect(pill.tagName).toBe('SPAN');
    expect(pill.getAttribute('role')).toBe('status');
    expect(pill.getAttribute('aria-live')).toBe('polite');
    expect(pill.getAttribute('aria-atomic')).toBe('true');
    expect(pill.dataset.state).toBe('idle');
    expect([...pill.children].map((child) => child.className)).toEqual([
        'status-dot',
        'status-text',
        'status-detail'
    ]);
    expect(pill.querySelector('.status-text')?.textContent).toBe('idle');
    expect(pill.querySelector('.status-detail')?.textContent).toBe('');

    // The BUTTON owns the click and the popup semantics; the live region stays nested
    // inside it and is never the control itself.
    expect(pill.parentElement).toBe(button);
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-label')).toBe('Endpoint and model settings');
    expect(button.title).toBe('Endpoint and model settings');
    // A dialog trigger is not a toggle, so it must not claim toggle state.
    expect(button.getAttribute('aria-pressed')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBeNull();

    // The topbar cluster still holds exactly the status and the tools toggle, in order.
    expect([...byClass('.topbar-right', 'div').children]).toEqual([
        button,
        byClass('.tools-toggle', 'button')
    ]);

    // Nothing is open before the reader presses it.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.dialog-overlay')).toBeNull();
});

// --- the dialog contents -------------------------------------------------------

it('opens the settings in a dialog titled Endpoint & model with every control', async () => {
    stub();
    await boot();
    openSettings();

    const panel = byClass('.dialog', 'div');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    // The dialog title replaced the `<summary>`; it is also the accessible name.
    const title = byClass('.dialog-title', 'h2');
    expect(title.textContent).toBe('Endpoint & model');
    expect(panel.getAttribute('aria-labelledby')).toBe(title.id);

    // Structure: `.dialog-body > .endpoint-dialog > .endpoint-body`.
    const wrapper = byClass('.endpoint-dialog', 'div');
    expect(wrapper.parentElement).toBe(byClass('.dialog-body', 'div'));
    const body = settingsRoot();
    expect(wrapper.children[0]).toBe(body);

    // Exactly one copy of the settings exists: the dialog is the ONLY host.
    expect(document.querySelectorAll('.endpoint-body')).toHaveLength(1);
    expect(document.querySelectorAll('.endpoint-dialog')).toHaveLength(1);
    expect(document.querySelectorAll('.model-manual')).toHaveLength(1);

    // Field order and labels are the ones the rail used to carry.
    expect([...body.children].map((child) => child.className)).toEqual([
        'field',
        'field',
        'field',
        'field-hint',
        'field-hint'
    ]);
    expect([...body.querySelectorAll('.field-label')].map((node) => node.textContent)).toEqual([
        'Base URL',
        'API key',
        'Model'
    ]);

    // Base URL and API key are the two labelled text inputs, in that order, prefilled
    // from the server defaults with the placeholders the rail showed.
    const inputs = [...body.querySelectorAll<HTMLInputElement>('label.field > input.field-input')];
    expect(inputs.map((input) => input.type)).toEqual(['text', 'password']);
    expect(inputs.map((input) => input.value)).toEqual(['http://provider/v1', '']);
    expect(inputs.map((input) => input.placeholder)).toEqual([
        'http://localhost:5500/providers/private/v1',
        'optional'
    ]);
    expect(inputs.map((input) => [input.spellcheck, input.autocomplete])).toEqual([
        [false, 'off'],
        [false, 'off']
    ]);

    // The dropdown is populated from the catalogue boot fetched, plus the manual
    // fallback entry, and it selects the current model.
    const select = byClass('.dialog .field-select', 'select');
    expect([...select.options].map((option) => option.textContent)).toEqual(['m1', 'm2', 'Custom model…']);
    expect(select.value).toBe('m1');
    expect(select.disabled).toBe(false);
    const manual = byClass('.model-manual', 'input');
    expect(manual.hidden).toBe(true);
    expect(manual.value).toBe('m1');

    // The three text lines: the model status, the explanation, the resolved API root.
    expect([...body.querySelectorAll('.field-hint')].map((node) => node.textContent)).toEqual([
        'Loaded 2 models from http://provider/v1.',
        'Sent to the harness server when a session starts. Leave the key blank to use the key configured on the server. Values are saved in this browser only. The model list is fetched by the server from {base URL}/models.',
        API_ROOT_HINT
    ]);

    // No disclosure markup survives anywhere in the document.
    expect(document.querySelector('details.endpoint')).toBeNull();
    expect(document.querySelector('summary.endpoint-summary')).toBeNull();
});

// --- the rail no longer hosts the settings ------------------------------------

it('leaves no endpoint markup in the left rail and no fields in the document while closed', async () => {
    stub();
    await boot();

    const rail = byClass('.rail-left', 'aside');
    expect(rail.querySelector('.endpoint')).toBeNull();
    expect(rail.querySelector('.endpoint-body')).toBeNull();
    expect(rail.querySelector('.endpoint-dialog')).toBeNull();
    expect(rail.querySelector('.model-manual')).toBeNull();
    expect(rail.querySelector('details')).toBeNull();

    // The left panel host is now the rail's LAST child — the disclosure used to follow
    // it, and `scratch-board.test.ts` pins the same fact from the host side.
    expect([...rail.children]).toEqual([
        byClass('.rail-head', 'div'),
        byClass('.harness-list', 'div'),
        byClass('#create-harness-panel', 'section'),
        byClass('.panel-host[data-slot="left"]', 'div')
    ]);
    expect(rail.lastElementChild?.dataset.slot).toBe('left');

    // While the dialog is closed the settings are DETACHED: they survive as persistent
    // nodes, so the document cannot be holding a second, duplicate copy of a field.
    expect(document.querySelectorAll('.endpoint-body')).toHaveLength(0);
    expect(document.querySelectorAll('.model-manual')).toHaveLength(0);
    // The only `<select>`s on the page belong to the create-harness form.
    expect([...document.querySelectorAll('select')].map((node) => node.className)).toEqual([
        'field-input field-select create-primary',
        'field-input field-select create-agent-select'
    ]);
});

// --- the data path is unchanged by the move -----------------------------------

it('persists dialog edits to storage and fires one debounced catalogue refresh', async () => {
    const calls = stub();
    await boot();
    const modelsAtBoot = modelCalls(calls).length;
    expect(modelsAtBoot).toBe(1);

    openSettings();
    const [baseURL, apiKey] = [
        ...document.querySelectorAll<HTMLInputElement>('.dialog label.field > input.field-input')
    ];

    baseURL.value = 'http://other/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    // The debounce is still 500ms of silence: typing must not fan out into one provider
    // request per keystroke, so nothing has fired yet.
    expect(modelCalls(calls)).toHaveLength(modelsAtBoot);
    // The stored payload is the whole settings object, in `loadSettings`' key order.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://other/v1","apiKey":"","model":"m1"}'
    );

    apiKey.value = 'sk-test';
    apiKey.dispatchEvent(new Event('input', { bubbles: true }));

    const select = byClass('.dialog .field-select', 'select');
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://other/v1","apiKey":"sk-test","model":"m2"}'
    );

    await pastDebounce();

    // ONE refresh for the whole editing session (each keystroke re-arms the same timer),
    // and it carries the credentials the dialog is showing.
    const refreshes = modelCalls(calls);
    expect(refreshes).toHaveLength(modelsAtBoot + 1);
    expect(refreshes[modelsAtBoot]?.method).toBe('POST');
    expect(refreshes[modelsAtBoot]?.body).toEqual({
        settings: { baseURL: 'http://other/v1', apiKey: 'sk-test' }
    });

    // The refreshed catalogue repaints the SAME persistent dropdown and status line:
    // 'm2' is in the provider list, so the order stays the provider's.
    expect([...select.options].map((option) => option.textContent)).toEqual(['m1', 'm2', 'Custom model…']);
    expect(select.value).toBe('m2');
    expect(settingsRoot().querySelector('.field-hint')?.textContent).toBe(
        'Loaded 2 models from http://other/v1.'
    );
});

it('sends the dialog values to the session it creates next', async () => {
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'go',
        status: 'done',
        startedAt: T,
        updatedAt: T + 1000,
        events: [
            { type: 'start', agent: 'instruct', model: 'm2' },
            { type: 'text', agent: 'instruct', delta: 'hi' },
            { type: 'done', agent: 'instruct', message: assistant({ content: 'hi', model: 'm2' }) }
        ]
    };
    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };
    const finished = snapshot({ turns: [recorded] });

    const calls = stub((url, method) => {
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() });
        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json({ session: snapshot({ status: 'running', turns: [opening] }), turn: opening }, 202);
        }
        if (url === '/api/sessions/s1/events') {
            return sse([
                { type: 'turn', turn: opening },
                { type: 'event', turnId: 't1', event: recorded.events[0], at: T },
                { type: 'event', turnId: 't1', event: recorded.events[1], at: T + 500 },
                { type: 'event', turnId: 't1', event: recorded.events[2], at: T + 1000 },
                { type: 'snapshot', session: finished }
            ]);
        }

        return undefined;
    });
    await boot();

    // The edits happen in the dialog, which is then CLOSED: the values are app state,
    // not dialog state, so a submit after dismissing the popup still uses them.
    openSettings();
    const [baseURL, apiKey] = [
        ...document.querySelectorAll<HTMLInputElement>('.dialog label.field > input.field-input')
    ];
    baseURL.value = 'http://other/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    apiKey.value = 'sk-test';
    apiKey.dispatchEvent(new Event('input', { bubbles: true }));
    const select = byClass('.dialog .field-select', 'select');
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    byClass('.dialog-close', 'button').click();
    expect(document.querySelector('.dialog')).toBeNull();

    byClass('.composer-input', 'textarea').value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    const created = calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST');
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({
        harness: 'instruct',
        settings: { baseURL: 'http://other/v1', apiKey: 'sk-test', model: 'm2' }
    });

    // The conversation really opened, so the drafted settings were the ones in use.
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Drain the keystroke debounce (see the note in the reopen test): a request that
    // fires after `vi.resetModules()` would be recorded by the next test's stub.
    await pastDebounce();
});

// --- persistence across close/reopen ------------------------------------------

it('reopens with the same control nodes, values and listeners', async () => {
    stub();
    await boot();

    openSettings();
    const body = settingsRoot();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');
    const select = byClass('.dialog .field-select', 'select');
    const optionValues = [...select.options].map((option) => option.value);

    baseURL.value = 'http://typed-once/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.dialog-close', 'button').click();

    // Close removes the OVERLAY only. The settings survive detached, so nothing can be
    // quietly rebuilt behind the reader's back.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.dialog-overlay')).toBeNull();
    expect(baseURL.isConnected).toBe(false);
    expect(body.isConnected).toBe(false);

    openSettings();

    // Identity, not similarity: the reopen adopts the SAME persistent nodes.
    expect(settingsRoot()).toBe(body);
    expect(document.querySelector('.dialog input.field-input')).toBe(baseURL);
    expect(document.querySelector('.dialog .field-select')).toBe(select);
    expect(baseURL.value).toBe('http://typed-once/v1');
    expect(select.value).toBe('m1');

    // The debounced refresh for the last keystroke is DRAINED inside this test: the
    // app's 500ms timer outlives the module instance, and a request that lands after
    // `vi.resetModules()` would be recorded by the NEXT test's stub (the same reason
    // main.test.ts waits past the debounce after touching the endpoint fields).
    await pastDebounce();

    // The listeners survived the move: a new keystroke still saves, and the value the
    // closed dialog wrote is the one storage holds.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://typed-once/v1","apiKey":"","model":"m1"}'
    );
    baseURL.value = 'http://typed-twice/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://typed-twice/v1","apiKey":"","model":"m1"}'
    );

    // Still exactly one host for the fields, and the dropdown was not rebuilt empty.
    expect(document.querySelectorAll('.endpoint-body')).toHaveLength(1);
    expect([...select.options].map((option) => option.value)).toEqual(optionValues);

    await pastDebounce();
});

it('toggles from the pill instead of stacking a second dialog', async () => {
    stub();
    await boot();

    const button = byClass('.status-button', 'button');
    button.click();
    const first = byClass('.dialog', 'div');
    button.click();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);

    // A third press opens a FRESH layer that re-adopts the same persistent body.
    button.click();
    expect(byClass('.dialog', 'div')).not.toBe(first);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(document.querySelectorAll('.endpoint-body')).toHaveLength(1);
});

// --- dismissal and focus ------------------------------------------------------

it('closes on Escape, on the × button and on the backdrop, returning focus to the pill', async () => {
    stub();
    await boot();

    const button = byClass('.status-button', 'button');
    button.focus();
    button.click();
    expect(byClass('.dialog', 'div').contains(document.activeElement)).toBe(true);

    closeWithEscape();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    button.click();
    const close = byClass('.dialog-close', 'button');
    expect(close.getAttribute('aria-label')).toBe('Close');
    close.click();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    // Backdrop click is the third way out (`ui/dialog.ts` owns all three).
    button.click();
    byClass('.dialog-overlay', 'div').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
});

it('stays out of the way while the tools view owns the centre', async () => {
    stub();
    await boot();

    byClass('.tools-toggle', 'button').click();
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('true');

    openSettings();
    expect(document.querySelector('.dialog')).toBeNull();

    byClass('.tools-toggle', 'button').click();
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('false');

    openSettings();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Endpoint & model');
});

// --- the live region keeps working while the dialog is open -------------------

it('still paints the same status live region in place while the dialog is open', async () => {
    const calls = stub();
    await boot();

    const button = byClass('.status-button', 'button');
    const pill = byClass('.status', 'span');
    const stateWord = byClass('.status-text', 'span');
    const detail = byClass('.status-detail', 'span');

    // An endpoint-requiring harness with a blanked base URL: the send is refused, and a
    // config failure IS app-level state, so the pill owns the announcement.
    openSettings();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');
    baseURL.value = '';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    byClass('.composer-input', 'textarea').value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    // Same nodes, updated in place: the wrapper neither replaced nor re-created the
    // live region, and an open dialog did not stop the announcement.
    expect(byClass('.status', 'span')).toBe(pill);
    expect(pill.parentElement).toBe(button);
    expect(pill.isConnected).toBe(true);
    expect(pill.dataset.state).toBe('error');
    expect(stateWord.textContent).toBe('error');
    expect(detail.textContent).toBe('no endpoint configured');
    expect(pill.getAttribute('title')).toBe('no endpoint configured');

    // A refused send creates nothing, and the settings dialog stays open for the fix.
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toEqual([]);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    // The debounced refresh for a BLANK url makes no provider request at all: the boot
    // read is the only one this test can see (every test that types drains its timer, so
    // no stale request from a previous instance lands here). The persistent status line
    // says what to do next.
    await pastDebounce();
    expect(modelCalls(calls)).toHaveLength(1);
    expect(settingsRoot().querySelector('.field-hint')?.textContent).toBe(
        'Set a base URL to load models. Enter a model manually until then.'
    );

    // The pill still closes from an error state, and reopens on the blanked value.
    button.click();
    expect(document.querySelector('.dialog')).toBeNull();
    button.click();
    expect(byClass('.dialog label.field > input.field-input', 'input').value).toBe('');
    expect(byClass('.model-manual', 'input').hidden).toBe(false);
});

// --- the stylesheet contract --------------------------------------------------

const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments NAME the removed rules, so "this selector is gone" assertions read the
// comment-stripped sheet (the convention every style contract test here uses).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

const blockOf = (selector: string): string => {
    const start = rules.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = rules.indexOf('{', start);

    // Brace-matched: the sheet nests `@media` bodies.
    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }
    throw new Error(`unterminated rule ${selector}`);
};

it('styles the pill trigger as a bare wrapper and drops the accordion rules', () => {
    const trigger = blockOf('.status-button {');
    for (const declaration of [
        'display: inline-flex',
        'align-items: center',
        'min-width: 0',
        'max-width: 100%',
        'padding: 0',
        'border: 0',
        'background: none',
        'color: inherit',
        'font: inherit',
        'cursor: pointer'
    ]) {
        expect(trigger).toContain(declaration);
    }
    // No clipping and no sizing of its own: `overflow: hidden` would cut the pill's own
    // ellipsis machinery and this button's focus ring, and a width would fight the
    // content-sized cluster that keeps the topbar from scrolling (F1).
    expect(trigger).not.toContain('overflow:');
    expect(trigger).not.toContain('width: 30px');
    expect(trigger).not.toContain('gap:');

    // The focus ring is on the wrapper, not on the live region.
    const focus = blockOf('.status-button:focus-visible {');
    expect(focus).toContain('outline: 2px solid var(--accent)');
    expect(focus).toContain('outline-offset: 2px');
    expect(focus).toContain('border-radius: 999px');

    // Hover reinforces the pill the wrapper contains, and the pill's own rules are
    // untouched. `\n` anchors the base `.status` block: `.status-button:hover .status {`
    // is written earlier in the sheet and shares its substring.
    expect(blockOf('.status-button:hover .status {')).toBe(
        '\n    border-color: var(--accent);\n    color: var(--text);\n'
    );
    expect(blockOf('.topbar-right .status {')).toBe('\n    max-width: none;\n');
    expect(blockOf('\n.status {')).toContain('border-radius: 999px');

    // The dialog body owns the spacing the accordion used to get from the rail.
    expect(blockOf('.endpoint-dialog {')).toBe(
        '\n    display: flex;\n    flex-direction: column;\n    gap: 12px;\n    min-width: min(440px, 100%);\n'
    );
    // `.endpoint-body` keeps its field rhythm and loses the accordion top padding: there
    // is no summary above it inside a dialog.
    const body = blockOf('.endpoint-body {');
    expect(body).toContain('gap: 9px');
    expect(body).not.toContain('padding');

    // The disclosure vocabulary is gone from every layer of the sheet.
    for (const dead of ['.endpoint {', '.endpoint-summary', '.endpoint[open]']) {
        expect(rules).not.toContain(dead);
    }
    expect(css).not.toContain('▸');
    // The generic marker reset stays for the `<details>` surfaces that remain (tools).
    expect(rules).toMatch(/^summary \{\s*list-style: none;\s*\}/m);
});

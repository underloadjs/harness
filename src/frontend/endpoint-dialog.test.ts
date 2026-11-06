// R4 (T4): the Endpoint & model settings are a DIALOG opened from the top-right status
// pill — they are no longer a `<details>` disclosure at the bottom of the left rail.
//
// What is pinned here, in the order the reader hits it:
//   - the trigger: the `<span class="status" role="status">` live region keeps its tag,
//     classes, ARIA and children, and a bare `<button class="status-button">` wraps it
//     (a live region cannot also be a button, so the two semantics nest);
//   - the dialog: title `Endpoint & model`, and inside it the harness server URL group
//     (field + explanation + refusal line + Apply/Reset) followed by the Base URL / API
//     key / Model controls, the model status line, the explanatory paragraph and the
//     API-root line — the same nodes the rail used to host, adopted rather than rebuilt;
//   - the data path is unchanged by the move: dialog edits still write the exact
//     `underload-harness-app:settings` payload, still fire ONE debounced catalogue
//     refresh, and still describe the next session the app creates;
//   - the harness server URL is a SEPARATE setting (`underload-harness-app:api-root`,
//     ./api.ts): prefilled from what this browser saved rather than from a one-load
//     `?apiRoot=`, applied only by its button (validate → persist → strip the override
//     → reload), refused inline when malformed or when the browser cannot keep the
//     value, and cleared by Reset. Typing in it never touches the provider payload and
//     never refreshes the provider catalogue;
//   - THE ROOT DISPLAYS ARE REPAINTED ON EVERY OPEN: on a GitHub Pages host `API_ROOT`
//     only moves inside `loadBootstrap` (`ensureApiRoot`, ./api.ts), after `main.ts`
//     module scope built this dialog, so both the field and the "API root in use" line
//     must name the gateway the probe LANDED on — and a refusal line from a previous open
//     must not survive the reopen (./main.ts `paintServerRoot`);
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
import { HARNESS_API_ROOT } from '../shared/harness-api';
import { API_ROOT } from './api';
import { STATIC_API_CANDIDATES } from './deployment';
import { viewAwareFetch } from './view-test-support';

const SETTINGS_KEY = 'underload-harness-app:settings';
// The harness server URL has its OWN storage key (./api.ts `API_ROOT_STORAGE_KEY`): it
// decides where the provider settings above are sent, so it must survive their reset
// and must never ride in a request body.
const SERVER_URL_KEY = 'underload-harness-app:api-root';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
// Realistic epoch stamps: the shell formats real server milliseconds.
const T = 1_700_000_000_000;

// The "which root is live" line the dialog renders. `main.ts` writes it from the SAME
// live binding (`API_ROOT`) — at module scope and again on every dialog open, because a
// static-host probe moves that binding after module scope (see the Pages test below) —
// so the expected text is computed rather than guessed, and a test can name the root a
// scenario resolved to.
const apiRootLine = (root: string): string =>
    `API root in use: ${root.length > 0 ? root : '(origin)'} · every request and the live stream go here. Change it for this browser with the Harness server URL above, or for a single load with ?apiRoot=.`;

const API_ROOT_HINT = apiRootLine(API_ROOT);

// The two fixed strings of the new server-URL group. Pinning them as constants keeps
// the DOM-order assertion below readable, and a source change is a deliberate edit.
const SERVER_URL_PLACEHOLDER = 'http://localhost:8180/v1/harness';
const SERVER_URL_HINT =
    'Relative paths resolve against the page that served this UI, so the default /v1/harness means the harness on the same host and port (a UI at http://localhost:8180 dials http://localhost:8180/v1/harness). Blank restores automatic resolution. An absolute URL may name another host: it must accept this page origin at the service Origin gate and CORS, and an https page cannot dial a plain-http host. ?apiRoot= still overrides for a single load.';
const SETTINGS_HINT =
    'Sent to the harness server when a session starts. Leave the key blank to use the key configured on the server. Values are saved in this browser only. The model list is fetched by the server from {base URL}/models.';

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

// `raw` is the request body as the CLIENT serialized it (the JSON string in `init.body`,
// which `viewAwareFetch` forwards verbatim — see its note at ./view-test-support.ts:2695).
// The parsed `body` cannot prove the WIRE spelling on its own: a camelCase key that
// survived serialization would still parse into a differently-named property only after
// the damage is done, and a `JSON.parse`/`JSON.stringify` round trip hides which bytes
// were actually sent. Both are recorded so a test can pin the exact field names on the
// wire (`POST /sessions` rejects anything outside its allow-list, ../server/api.ts:544).
type Call = { url: string; method: string; body: unknown; raw?: string };

// Every boot answers the same two reads; a test adds the session/task routes it needs.
// An unmapped URL throws LOUDLY instead of letting a missing request masquerade as
// "nothing happened".
//
// `browser` is an optional layer IN FRONT of the shared double. The double reduces every
// request to the configured fixture mount (`stripOrigin`), which is exactly what hides a
// static-host deployment: the client dials `http://localhost:5000/v1/harness/health` and
// `http://127.0.0.1:5000/v1/harness/health` as the SAME `/api/health` route. A Pages test
// therefore answers or rewrites on the URL the browser actually sent — a `Response` to
// settle it, a string to hand the double a different URL, `undefined` to pass it through.
const stub = (
    extra?: (url: string, method: string, body: unknown) => Response | undefined,
    browser?: (url: string) => Response | string | undefined
): Call[] => {
    const calls: Call[] = [];

    const double = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const raw = init?.body === undefined ? undefined : String(init.body);
        const body = raw === undefined ? undefined : JSON.parse(raw);
        calls.push({ url, method, body, ...(raw === undefined ? {} : { raw }) });

        const handled = extra?.(url, method, body);
        if (handled !== undefined) return handled;

        if (url === '/api') return json(bootstrap());
        if (url === '/api/models' && method === 'POST') return json({ models: ['m1', 'm2'] });

        throw new Error(`unexpected request: ${method} ${url}`);
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const handled = browser?.(String(input));
            if (handled instanceof Response) return handled;

            const answer = double(typeof handled === 'string' ? handled : String(input), init);

            return answer instanceof Promise ? await answer : answer;
        })
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
    // The server-URL tests put `?apiRoot=` in the address bar; the real Location is a
    // per-file singleton, so a leaked query would change the NEXT test's resolved root.
    window.history.replaceState(null, '', '/');
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

// The dialog's LAST line: the root this load resolved. Addressed by position because
// that is what the DOM order pins (see the child-list assertion below).
const lastBodyHint = (): string | null | undefined => {
    const children = settingsRoot().children;

    return children[children.length - 1]?.textContent;
};

// The harness server URL control (a `div.field`, so `label.field > input.field-input`
// below keeps naming the provider pair) and its two action buttons.
const serverRootInput = (): HTMLInputElement => byClass('.dialog #harness-server-root', 'input');
const serverRootButtons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('.dialog .endpoint-actions button')
];

// The model catalogue's status line. It must be scoped through the model `div.field`:
// the server-URL group above it owns two `.field-hint` siblings of its own, so the
// first `.field-hint` inside `.endpoint-body` is no longer the model status.
const modelStatusLine = (): string | null | undefined =>
    settingsRoot().querySelector('.field .field-hint')?.textContent;

// The server URL's refusal line. `role="status"` is unique to it (the model status line
// is a plain `.field-hint`), so this selector cannot land on another node.
const serverRootStatusLine = (): HTMLParagraphElement =>
    byClass('.dialog p.field-hint[role="status"]', 'p');

// jsdom cannot fake a navigation. `location.reload` is an UNFORGEABLE own property of
// jsdom's Location (non-writable, non-configurable — verified: assignment,
// `defineProperty` and `vi.spyOn` all throw, and a Proxy `get` trap that returns
// anything else violates the proxy invariant and raises a TypeError at the call site).
// Calling the real one only logs "Not implemented: navigation to another Document"
// without reporting anything, so `vi.stubGlobal` swaps the GLOBAL SLOT that a bare
// `location.reload()` resolves to (main.ts:11096 `Retry` included) with a plain object
// whose URL members read through to the REAL Location. `history.replaceState` therefore
// still moves the real document URL, and a test can count the reloads AND read the
// stripped query back from the returned `location`.
const stubNavigation = (): { readonly reloads: () => number; readonly location: Location } => {
    const real = window.location;
    let count = 0;

    const read = (property: 'href' | 'search' | 'hash' | 'pathname' | 'origin'): string => real[property];

    vi.stubGlobal('location', {
        reload: (): void => {
            count += 1;
        },
        assign: (): void => undefined,
        replace: (): void => undefined,
        get href(): string {
            return read('href');
        },
        get search(): string {
            return read('search');
        },
        get hash(): string {
            return read('hash');
        },
        get pathname(): string {
            return read('pathname');
        },
        get origin(): string {
            return read('origin');
        }
    });

    return { reloads: (): number => count, location: real };
};

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

    // Child order: the harness server URL group FIRST (it decides where the provider
    // credentials below are sent), then the three provider fields the rail used to
    // carry, then the two provider hints.
    expect([...body.children].map((child) => child.className)).toEqual([
        'field',
        'field-hint',
        'field-hint is-warning',
        'endpoint-actions',
        'field',
        'field',
        'field',
        'field-hint',
        'field-hint'
    ]);
    expect([...body.querySelectorAll('.field-label')].map((node) => node.textContent)).toEqual([
        'Harness server URL',
        'Base URL',
        'API key',
        'Model'
    ]);

    // Base URL and API key are still the two labelled text inputs, in that order,
    // prefilled from the server defaults with the placeholders the rail showed. The
    // server URL field is a `div.field` with a `label[for]`, which is what keeps this
    // selector naming the PROVIDER pair and nothing else.
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

    // The harness server URL: the root this load actually uses, an absolute-URL
    // placeholder, and a real accessible name through `label[for]`.
    const serverRoot = serverRootInput();
    expect(serverRoot.type).toBe('text');
    expect(serverRoot.value).toBe(API_ROOT);
    expect(serverRoot.placeholder).toBe(SERVER_URL_PLACEHOLDER);
    expect([serverRoot.spellcheck, serverRoot.autocomplete]).toEqual([false, 'off']);
    expect(byClass('.dialog label.field-label[for="harness-server-root"]', 'label').textContent).toBe(
        'Harness server URL'
    );
    expect(document.querySelector('.dialog label.field > #harness-server-root')).toBeNull();

    // Its two status nodes: the explanation, and the refusal line that starts empty and
    // hidden (it is the `role="status"` target of a failed Apply).
    expect(body.children[1].textContent).toBe(SERVER_URL_HINT);
    const serverStatus = body.children[2] as HTMLElement;
    expect(serverStatus.getAttribute('role')).toBe('status');
    expect(serverStatus.textContent).toBe('');
    expect(serverStatus.hidden).toBe(true);

    // Its two actions, primary first in the DOM (CSS right-aligns the row, so the
    // commit button lands where a reader expects it to be pressed).
    const [apply, reset] = serverRootButtons();
    expect(apply.textContent).toBe('Apply & reconnect');
    expect(apply.className).toBe('button primary');
    expect(apply.type).toBe('button');
    expect(reset.textContent).toBe('Reset');
    expect(reset.className).toBe('button');
    expect(reset.type).toBe('button');

    // The dropdown is populated from the catalogue boot fetched, plus the manual
    // fallback entry, and it selects the current model.
    const select = byClass('.dialog .field-select', 'select');
    expect([...select.options].map((option) => option.textContent)).toEqual(['m1', 'm2', 'Custom model…']);
    expect(select.value).toBe('m1');
    expect(select.disabled).toBe(false);
    const manual = byClass('.model-manual', 'input');
    expect(manual.hidden).toBe(true);
    expect(manual.value).toBe('m1');

    // The text lines, in DOM order: the server explanation, its (empty) refusal line,
    // the model status, the provider explanation, the API root actually in use.
    expect([...body.querySelectorAll('.field-hint')].map((node) => node.textContent)).toEqual([
        SERVER_URL_HINT,
        '',
        'Loaded 2 models from http://provider/v1.',
        SETTINGS_HINT,
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
    // T17: `POST /models` carries the contract's `RunnerSettingsInput`
    // (../shared/harness-api.ts:369 — `base_url`/`api_key`, snake_case, write-only key).
    // The camelCase spelling was the pre-canonical body; the settings the dialog shows are
    // still exactly the pair that was typed, which is the behaviour this assertion pins.
    expect(refreshes[modelsAtBoot]?.body).toEqual({
        settings: { base_url: 'http://other/v1', api_key: 'sk-test' }
    });

    // The refreshed catalogue repaints the SAME persistent dropdown and status line:
    // 'm2' is in the provider list, so the order stays the provider's.
    expect([...select.options].map((option) => option.textContent)).toEqual(['m1', 'm2', 'Custom model…']);
    expect(select.value).toBe('m2');
    expect(modelStatusLine()).toBe('Loaded 2 models from http://other/v1.');
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
    // T-A: the `settings` block is the CONTRACT's snake_case `RunnerSettingsInput`
    // (../shared/harness-api.ts:369-373), NOT the shell's camelCase `RunnerSettings`
    // (../server/harnesses/types.ts:18-22). The server runs `requireKnownFields` over the
    // allow-list `base_url, api_key, model` (../server/api.ts:504-510, :544) BEFORE it
    // creates anything, so a camelCase body was a 400 on the FIRST submit of every new
    // conversation: `Unknown field "baseURL". Allowed fields: base_url, api_key, model.`
    // This is the spelling `POST /models` already sends (:437-443); only the WIRE changes
    // — `localStorage` keeps the camelCase domain record (see :414-428).
    expect(created[0]?.body).toEqual({
        harness: 'instruct',
        settings: { base_url: 'http://other/v1', api_key: 'sk-test', model: 'm2' }
    });

    // The whole-body `toEqual` above is ORDER-INSENSITIVE, so the field list is pinned
    // separately: exactly these three keys, in the mapper's order, and no fourth one.
    const createdSettings = (created[0]?.body as { settings: Record<string, string> }).settings;
    expect(Object.keys(createdSettings)).toEqual(['base_url', 'api_key', 'model']);

    // The serialized bytes, exact. `not.toContain` is the regression guard that survives a
    // future mapper growing an additive field: the camelCase names may never appear on this
    // request again, anywhere in it.
    expect(created[0]?.raw).toBe(
        '{"harness":"instruct","settings":{"base_url":"http://other/v1","api_key":"sk-test","model":"m2"}}'
    );
    expect(created[0]?.raw).not.toContain('baseURL');
    expect(created[0]?.raw).not.toContain('apiKey');

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

    // Identity, not similarity: the reopen adopts the SAME persistent nodes. Scoped to
    // `label.field` because the first `input.field-input` in the dialog is now the
    // harness server URL, which is not part of the provider triple.
    expect(settingsRoot()).toBe(body);
    expect(document.querySelector('.dialog label.field > input.field-input')).toBe(baseURL);
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
    expect(modelStatusLine()).toBe('Set a base URL to load models. Enter a model manually until then.');

    // The pill still closes from an error state, and reopens on the blanked value.
    button.click();
    expect(document.querySelector('.dialog')).toBeNull();
    button.click();
    expect(byClass('.dialog label.field > input.field-input', 'input').value).toBe('');
    expect(byClass('.model-manual', 'input').hidden).toBe(false);
});

// --- the harness server URL (the UI-level server setting) -------------------
//
// The dialog is where a reader points this UI at a DIFFERENT harness without a
// rebuild: the field is prefilled from what this browser saved (or from the automatic
// root), Apply validates and persists it, and both actions strip the one-load
// `?apiRoot=` override and reload — because every request URL and the socket are built
// from the root resolved at module load (./api.ts), and the shell has no in-place
// reset. `location.reload` is stubbed (see `stubNavigation`), so these tests count the
// reload instead of performing it.
//
// A click fails LOUDLY whenever the write cannot land, and then changes NOTHING: the
// reason goes on the refusal line, the dialog stays open with the typed value, no key is
// written and no reload happens. That covers a malformed URL, a root that normalizes
// away to `''` (`/`), and a typed Apply in a browser that exposes no `localStorage`; a
// store that can read but refuses the `remove` fails the same way on Reset. Reloading in
// any of those cases would land on the OLD root and read as an Apply that silently did
// nothing. The clear in a browser with NO store is the one case that cannot fail (T5):
// there is nothing to remove and automatic resolution is what such a browser already
// gets, so Reset succeeds and reloads.

it('prefills the server URL from the saved setting, not from a one-load override', async () => {
    // A saved cross-origin root is the whole point of the setting: it is trusted
    // (typed by this browser, never delivered by a link), so the UI boots against it and
    // the dialog names it as the root in use.
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    stub();
    await boot();
    openSettings();

    expect(serverRootInput().value).toBe('https://harness.example.test/v1/harness');
    expect(lastBodyHint()).toBe(apiRootLine('https://harness.example.test/v1/harness'));

    byClass('.dialog-close', 'button').click();

    // The link-supplied override outranks the saved value FOR THAT LOAD, so the field
    // still shows the saved URL (pressing Apply would keep it) while the dialog reports
    // the root actually in use. The two lines disagreeing is the contract.
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
    stub();
    await boot();
    openSettings();

    expect(serverRootInput().value).toBe('https://harness.example.test/v1/harness');
    expect(lastBodyHint()).toBe(apiRootLine('http://localhost:5000/v1/harness'));
});

it('saves a typed server URL normalized, strips the one-load override, and reloads', async () => {
    stub();
    await boot();
    openSettings();

    // `?apiRoot=` is consulted at module load and outranks the saved value, so Apply
    // must remove it — otherwise the reload it triggers ignores the value just written.
    // A second parameter and the hash pin that ONLY `apiRoot` is dropped.
    window.history.replaceState(
        null,
        '',
        '/?theme=dark&apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness#sessions'
    );

    const navigation = stubNavigation();
    const field = serverRootInput();

    // The trailing slash is the reader's, not the store's: normalization happens before
    // the write, so a reload cannot drift from what Apply accepted.
    field.value = 'https://harness.example.test/v1/harness/';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    // Typing alone changes NOTHING: the root is resolved at module load, so only the
    // explicit action may touch storage, the provider draft, or the model catalogue.
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://provider/v1","apiKey":"","model":"m1"}'
    );

    serverRootButtons()[0].click();

    expect(navigation.reloads()).toBe(1);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBe('https://harness.example.test/v1/harness');
    expect(navigation.location.pathname).toBe('/');
    expect(navigation.location.search).toBe('?theme=dark');
    expect(navigation.location.hash).toBe('#sessions');

    // The provider draft is byte-for-byte the triple it was before: the server URL never
    // joins `underload-harness-app:settings`, and a keystroke here never refreshes the
    // provider catalogue (that belongs to the base URL and the key alone).
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(
        '{"baseURL":"http://provider/v1","apiKey":"","model":"m1"}'
    );

    await pastDebounce();
});

it('refuses a malformed server URL inline and keeps the dialog, the storage and the page as they were', async () => {
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();
    const field = serverRootInput();

    // Protocol-relative: syntactically another origin hiding behind a rooted path, which
    // `normalizeApiRoot` rejects (./api.ts:228).
    field.value = '//evil.example/v1/harness';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    serverRootButtons()[0].click();

    const status = serverRootStatusLine();
    expect(status.hidden).toBe(false);
    expect(status.classList.contains('is-warning')).toBe(true);
    expect(status.textContent).toBe('A relative API root must start with a single "/".');

    // Nothing was written, nothing navigated, and the address bar is untouched.
    expect(navigation.reloads()).toBe(0);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(navigation.location.search).toBe('');

    // The typed value stays so the reader can fix it, and the dialog is still open.
    expect(serverRootInput().value).toBe('//evil.example/v1/harness');
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    // Closing and REOPENING repaints both root displays: the refusal named a value that is
    // no longer on screen, so carrying it over would claim the freshly painted root had
    // been rejected. Nothing was written in between, so the field restarts from what this
    // browser saved (nothing) or the root this load dials, and no reload happened.
    byClass('.dialog-close', 'button').click();
    openSettings();

    expect(serverRootStatusLine().hidden).toBe(true);
    expect(serverRootStatusLine().textContent).toBe('');
    expect(serverRootInput().value).toBe(API_ROOT);
    expect(lastBodyHint()).toBe(API_ROOT_HINT);
    expect(navigation.reloads()).toBe(0);
});

it('refuses a bare "/" server URL inline instead of saving a value that silently reverts', async () => {
    // Syntactically a root, and the validator strips trailing slashes, so `/` collapses
    // to `''` — and `''` is exactly what the store reports for "nothing saved"
    // (./api.ts `storedApiRoot`). Persisting it would ACCEPT the value, reload, and hand
    // the next load back to automatic resolution: an Apply that quietly undid itself.
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();
    const field = serverRootInput();

    field.value = '/';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    serverRootButtons()[0].click();

    const status = serverRootStatusLine();
    expect(status.hidden).toBe(false);
    expect(status.classList.contains('is-warning')).toBe(true);
    expect(status.textContent).toBe(
        'The API root cannot be just "/"; use an absolute origin or a path such as /v1/harness.'
    );

    // No write, no reload, dialog open, typed value intact: the reader fixes it instead
    // of chasing a root that moved back on its own.
    expect(navigation.reloads()).toBe(0);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(serverRootInput().value).toBe('/');
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
});

it('names a browser with no local storage instead of reloading onto the automatic root', async () => {
    // The SAVE half of the no-store rule: a typed URL has to be kept somewhere, and a
    // browser that exposes no store cannot keep it, so the click reports why and stays put
    // (a blank field / Reset is the other half — see the test below, which succeeds).
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();
    const field = serverRootInput();
    field.value = 'http://localhost:8180/v1/harness';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    // Stubbed only now, and only for the click: the shell reads and writes its own
    // settings throughout boot, so a store that never existed would fail long before
    // Apply. `vi.stubGlobal` swaps the global SLOT `globalThis.localStorage` reads;
    // `afterEach` (`vi.unstubAllGlobals`) restores it, and this test restores it itself
    // to inspect the store afterwards.
    vi.stubGlobal('localStorage', undefined);
    serverRootButtons()[0].click();

    const status = serverRootStatusLine();
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(
        'This browser does not expose local storage, so the harness server URL cannot be saved.'
    );

    // The failure replaces the reload: before this, the missing store was an optional
    // chain that reported success and navigated anyway.
    expect(navigation.reloads()).toBe(0);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    vi.unstubAllGlobals();

    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
});

it('resets to the automatic root even in a browser with no local storage', async () => {
    // The CLEAR half of the same rule (./api.ts `saveApiRootSetting`, T5): the missing
    // store may only refuse a value that has to be kept. Reset asks for automatic
    // resolution, and a browser with no store is already there — `storedApiRoot()` reads
    // it as "no setting" — so there is nothing to remove and the click must behave like
    // every other successful Reset: write nothing, show no refusal, drop the one-load
    // override, reload.
    stub();
    await boot();
    openSettings();

    // Same mid-session stubbing as the test above (the boot needs the real store for the
    // provider settings); the guard is only observable at the click.
    window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
    const navigation = stubNavigation();

    vi.stubGlobal('localStorage', undefined);

    expect(serverRootButtons()[1].textContent).toBe('Reset');
    serverRootButtons()[1].click();

    // Success, not a refusal: the reload happened and the status line stayed empty.
    expect(navigation.reloads()).toBe(1);
    expect(serverRootStatusLine().hidden).toBe(true);
    expect(serverRootStatusLine().textContent).toBe('');
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    // `apiRoot` is stripped even though nothing was written, because leaving it would
    // point the reload at the override instead of at automatic resolution.
    expect(navigation.location.search).toBe('');

    // Globals restored (the `location` slot too), and the key is still ABSENT: the click
    // wrote nothing, which is the whole point of a clear in a store-less browser.
    vi.unstubAllGlobals();

    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
});

it('treats a blank field as automatic: Apply clears the saved URL instead of storing an empty one', async () => {
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();
    const field = serverRootInput();
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    serverRootButtons()[0].click();

    // An empty string would be a stored value that resolves to nothing; the key is gone,
    // so the next load walks the documented ladder from the top.
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(navigation.reloads()).toBe(1);
});

it('resets to the automatic root: clears the saved URL, drops the override, and reloads', async () => {
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    stub();
    await boot();
    openSettings();

    window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
    const navigation = stubNavigation();

    // The secondary button of the row (`Reset`, not `Apply & reconnect`).
    expect(serverRootButtons()[1].textContent).toBe('Reset');
    serverRootButtons()[1].click();

    expect(navigation.reloads()).toBe(1);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(navigation.location.search).toBe('');

    // A reset with no failure never shows the refusal line.
    expect(serverRootStatusLine().hidden).toBe(true);
});

it('reports a store that refuses the reset instead of reloading onto the same saved root', async () => {
    // The store here CAN read (the boot resolves the saved root and the field is
    // prefilled from it) but CANNOT remove. Silently accepting that made Reset a no-op
    // the reader could never see finish: the reload re-resolved the very host they just
    // asked to leave.
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();

    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError');
    });

    expect(serverRootButtons()[1].textContent).toBe('Reset');
    serverRootButtons()[1].click();

    const status = serverRootStatusLine();
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(
        'Could not clear the saved harness server URL in this browser: SecurityError'
    );

    expect(navigation.reloads()).toBe(0);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    removeItem.mockRestore();

    // Why the reload is the wrong answer: the saved root survived the failed clear.
    expect(localStorage.getItem(SERVER_URL_KEY)).toBe('https://harness.example.test/v1/harness');
});

// --- the static-host probe moves the root AFTER this dialog was built ---------
//
// A GitHub Pages deployment pins nothing (./api.ts source 5), so `resolveRoot` hands the
// compiled local/LAN chain to `ensureApiRoot`, and `API_ROOT` — an ESM live binding —
// only becomes final inside `loadBootstrap` (./api.ts:681), strictly AFTER `main.ts`
// module scope painted this dialog. The two root displays are therefore repainted on
// every open (./main.ts `paintServerRoot`). Pre-fix, both kept naming candidate 1 (dead)
// while every request and the live stream went to the gateway that answered.

it('names the gateway the static-host probe landed on, not the candidate resolved at module load', async () => {
    // The Pages Location double `api-static-host.test.ts:85` uses. It must be in place
    // before `api.ts` is evaluated: `vi.resetModules()` (beforeEach) plus the dynamic
    // `import('./main')` below give this test its own module graph, so this stubbed
    // Location is what `isStaticPagesHost()` reads.
    vi.stubGlobal('location', {
        protocol: 'https:',
        hostname: 'underload-app.github.io',
        host: 'underload-app.github.io',
        origin: 'https://underload-app.github.io',
        href: 'https://underload-app.github.io/harness/',
        search: '',
        reload: (): void => undefined
    });

    const dead = STATIC_API_CANDIDATES[0];
    const live = STATIC_API_CANDIDATES[1];
    const dialled: string[] = [];

    stub(undefined, (url) => {
        dialled.push(url);

        // Candidate 1 refuses: `probeRoot` requires `response.ok`, so a 503 fails the
        // probe and the chain moves on to candidate 2 (the shared double would answer
        // its `/health` with `{ ok: true }`, which is what pins the winner).
        if (url.startsWith(dead)) return json({ error: { message: 'gateway down' } }, 503);

        // The double answers the canonical MOUNT (every other test in this file dials
        // `/v1/harness`); the client dials the absolute candidate root instead, and
        // `stripOrigin` only reduces an absolute URL once a path follows the root, so the
        // mount-stamped path is handed over here. The log above still shows what the
        // browser really sent.
        return url.startsWith(live) ? `${HARNESS_API_ROOT}${url.slice(live.length)}` : undefined;
    });

    await boot();

    // The move is real, not merely displayed: the chain was walked in order and the boot
    // document was read from the gateway that answered.
    expect(dialled[0]).toBe(`${dead}/health`);
    expect(dialled).toContain(`${live}/health`);
    expect(dialled).toContain(live);

    openSettings();

    // Both displays name the root actually in use. `API_ROOT` (imported at the top of this
    // file) belongs to the PRE-reset module instance, so the expectation is the compiled
    // candidate the live binding moved to — and it is provably NOT the stale candidate.
    expect(serverRootInput().value).toBe(live);
    expect(serverRootInput().value).not.toBe(dead);
    expect(lastBodyHint()).toBe(apiRootLine(live));
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

    // The server-URL action row: a right-aligned pair under the field it commits, with
    // the sheet's standard action spacing, and no wrapping surprises at the dialog's
    // `min-width: min(440px, 100%)`.
    const actions = blockOf('.endpoint-actions {');
    expect(actions).toContain('display: flex');
    expect(actions).toContain('justify-content: flex-end');
    expect(actions).toContain('gap: 8px');
    expect(actions).not.toContain('position:');

    // The disclosure vocabulary is gone from every layer of the sheet.
    for (const dead of ['.endpoint {', '.endpoint-summary', '.endpoint[open]']) {
        expect(rules).not.toContain(dead);
    }
    expect(css).not.toContain('▸');
    // The generic marker reset stays for the `<details>` surfaces that remain (tools).
    expect(rules).toMatch(/^summary \{\s*list-style: none;\s*\}/m);
});

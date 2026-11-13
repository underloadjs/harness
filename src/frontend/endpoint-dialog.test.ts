// R4 (T4): the Endpoint & model settings are a DIALOG opened from the top-right status
// pill — they are no longer a `<details>` disclosure at the bottom of the left rail.
//
// What is pinned here, in the order the reader hits it:
//   - the trigger: the `<span class="status" role="status">` live region keeps its tag,
//     classes, ARIA and children, and a bare `<button class="status-button">` wraps it
//     (a live region cannot also be a button, so the two semantics nest);
//   - the dialog: title `Endpoint & model`, and inside it the harness server URL group
//     (field + the `role="status"` refusal line + the one-line `In use:` state), the three
//     provider controls (Base URL / API key / Model), and then ONE footer row carrying the
//     single `Apply` button as the LAST child of the body. There is no `Reset`, and the
//     three instructional paragraphs are gone — an expert reader gets a label, a
//     placeholder and one short state line per concern, nothing else;
//   - DRAFT-then-APPLY (./main.ts `endpointDraft`): a keystroke and a dropdown change write
//     the DRAFT and nothing else, so `underload-harness-app:settings` keeps its previous
//     bytes until the reader presses `Apply`. Dismissal (Escape, the × button, the backdrop,
//     a second pill press) is therefore a real cancel — which is exactly why the footer
//     holds one button. The model catalogue is the one thing the draft drives on its own:
//     typing a base URL posts it to `POST /models` (debounced, 500ms of silence) and
//     repopulates the dropdown while persisting nothing, and closing drops both the pending
//     debounce and the in-flight lookup;
//   - the model control is a `<select>` ONLY: no free-text input and no `Custom model…`
//     option, because an id the endpoint does not advertise is not something this dialog
//     invents. A stored model the provider hides stays selectable as `<current> (current)`,
//     and an empty catalogue shows a disabled `No models` placeholder;
//   - the harness server URL is a SEPARATE setting (`underload-harness-app:api-root`,
//     ./api.ts): prefilled from what this browser saved rather than from a one-load
//     `?apiRoot=`, and written by Apply ONLY when the field actually changed — an untouched
//     field must not turn the automatic root into a stored override. When it changed, the
//     click validates → persists → strips the override → reloads (the reconnect); when it
//     did not, Apply is a plain save: settings written, dialog closed, NO reload. A blank
//     field clears the stored key, which is the job the removed `Reset` used to do. Typing
//     in it never touches the provider payload and never refreshes the provider catalogue;
//   - THE ROOT DISPLAYS ARE REPAINTED ON EVERY OPEN: on a GitHub Pages host `API_ROOT`
//     only moves inside `loadBootstrap` (`ensureApiRoot`, ./api.ts), after `main.ts`
//     module scope built this dialog, so both the field and the `In use:` line must name
//     the gateway the probe LANDED on — and a refusal line from a previous open must not
//     survive the reopen (./main.ts `paintServerRoot`);
//   - persistence across the dialog lifecycle: closing removes only the overlay, and the
//     reopen adopts the SAME control nodes (identity, not a copy) with their values
//     RE-BASED on what is saved — a dismissed edit is gone and an applied one is not, and
//     neither case rebuilds a field or loses a listener;
//   - dismissal: Escape, the × button and a backdrop click all close it and hand focus
//     back to the pill; a second press toggles instead of stacking; and the pill keeps
//     toggling while the Tools or Plugins catalogue owns the centre — the layer is a
//     `document.body` overlay that covers whichever pane is on screen (./main.ts). `Apply`
//     is therefore reachable over a catalogue, and it must leave the catalogue and its head
//     exactly where they were (./main.ts `renderHarnessChrome` returns early there);
//   - the status live region still updates IN PLACE (same node, inside the wrapper) while
//     the dialog is open, and the settings still open from a non-idle state;
//   - the rail: no endpoint markup at all, and the left panel host is the rail's last
//     child where the disclosure used to sit;
//   - CSS (jsdom computes no media queries, so the sheet's source text is the contract —
//     the same convention compact-ui.test.ts and tool-chip-style.test.ts use): the
//     wrapper is a bare button with no clipping, the dialog body gets its own breathing
//     room, the footer row is a right-aligned single action, and the accordion rules
//     (`.endpoint`, `.endpoint-summary`, its `::before` chevron and its rotation) are gone.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts src/frontend/endpoint-dialog.test.ts

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

// The "which root is live" line the dialog renders, and the ONLY prose left in the server
// group: one short state line, no explanation of requests, streams or `?apiRoot=`.
// `main.ts` writes it from the SAME live binding (`API_ROOT`) — at module scope and again on
// every dialog open, because a static-host probe moves that binding after module scope (see
// the Pages test below) — so the expected text is computed rather than guessed, and a test
// can name the root a scenario resolved to.
const apiRootLine = (root: string): string => `In use: ${root.length > 0 ? root : '(origin)'}`;

const API_ROOT_HINT = apiRootLine(API_ROOT);

// The one string the provider group still states, and the ONLY model state line. Terse by
// contract: the imperative tails ("Enter a model manually.") are gone with the manual input.
const MODEL_LOADED = 'Loaded 2 models from http://provider/v1';

// The placeholder an empty catalogue shows. It is disabled, so the reader can never
// "select" it into the draft.
const NO_MODELS = 'No models';

// The server-URL placeholder — the one hint the field keeps, because a placeholder teaches
// the shape without a paragraph.
const SERVER_URL_PLACEHOLDER = 'http://localhost:8180/v1/harness';

// The stored payload exactly as `loadSettings`/`saveSettings` serialize it: the whole
// provider triple, in the record's key order. Every draft assertion below compares against
// a variant of this byte string, because "the draft was not persisted" is a byte claim.
const storedSettings = (baseURL: string, apiKey: string, model: string): string =>
    `{"baseURL":"${baseURL}","apiKey":"${apiKey}","model":"${model}"}`;

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
    // The async-lifecycle cases run on `vi.useFakeTimers()`; leaving the fake clock installed
    // would hang the next file's real-timer `flush`/`pastDebounce` helpers.
    vi.useRealTimers();
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

// `.field-select` is NOT endpoint-specific (the create-harness form wears the same classes),
// so every settings read is scoped to the dialog. `.endpoint-body` and `.endpoint-actions`
// ARE unique to the settings, which is what makes the "no duplicate fields" and "one button"
// assertions below exact rather than positional.
const settingsRoot = (): HTMLElement => byClass('.dialog .endpoint-body', 'div');

// The `In use:` line — the SECOND child of the body, since the actions row took the last
// slot. Addressed by position because that is what the DOM-order assertion below pins.
const serverRootLiveLine = (): string | null | undefined => settingsRoot().children[2]?.textContent;

// The harness server URL control (a `div.field`, so `label.field > input.field-input` below
// keeps naming the provider pair).
const serverRootInput = (): HTMLInputElement => byClass('.dialog #harness-server-root', 'input');

// The dialog's single action. `.endpoint-actions` is the last child of the body and holds
// exactly one button, so this is THE Apply of the dialog — there is nothing else in that row
// to disambiguate.
const applyButton = (): HTMLButtonElement =>
    byClass('.dialog .endpoint-actions button', 'button');

// Every button the open layer owns, as `[host, label]` pairs: the × of the head and the
// footer action. A third entry is a control this dialog is not supposed to have (the exact
// array IS the "one button, labelled Apply" assertion).
const dialogButtons = (): [string, string][] => [
    ...[...document.querySelectorAll<HTMLButtonElement>('.dialog button')].map(
        (button): [string, string] => [
            button.closest('.dialog-head') === null ? 'body' : 'head',
            button.textContent ?? ''
        ]
    )
];

// The model catalogue's status line. It must be scoped through the model `div.field`: the
// server-URL group above it owns two `.field-hint` siblings of its own, so the first
// `.field-hint` inside `.endpoint-body` is the refusal line, not the model status.
const modelStatusLine = (): string | null | undefined =>
    settingsRoot().querySelector('.field .field-hint')?.textContent;

// The model `<select>`, the ONLY model control the dialog has.
const modelSelect = (): HTMLSelectElement => byClass('.dialog .field-select', 'select');

// The dropdown as `[label, value, disabled]` triples — the whole contract of the control in
// one exact assertion. Spread first: jsdom's `HTMLOptionsCollection` is indexed but has no
// `map`, so `select.options.map(...)` is not iterable.
const modelOptions = (): [string | null, string, boolean][] => [
    ...[...modelSelect().options].map((option) => [
        option.textContent ?? null,
        option.value,
        option.disabled
    ] as [string | null, string, boolean])
];

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

    // The topbar cluster holds the status pill ALONE. The two catalogue toggles that used
    // to follow it (T7/R2) now live in the `.harness-title-tools` group on the harness
    // title row, because the panes they open are presented for the session in view while
    // this pill is app-scoped — the pill's own placement and order are unchanged.
    expect([...byClass('.topbar-right', 'div').children]).toEqual([button]);

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

    // Child order: the harness server URL group FIRST (it decides where the provider
    // credentials below are sent) with its refusal line and its one `In use:` state line,
    // then the three provider fields the rail used to carry, then the footer. The three
    // instructional paragraphs are gone, so the body is 7 children and not 9.
    expect([...body.children].map((child) => child.className)).toEqual([
        'field',
        'field-hint is-warning',
        'field-hint',
        'field',
        'field',
        'field',
        'endpoint-actions'
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

    // The whole control inventory of the dialog, exact: three text inputs (server URL,
    // Base URL, API key) and ONE select. A fourth input would be the free-text model
    // fallback this dialog no longer offers — the ids come from the endpoint.
    expect([...body.querySelectorAll<HTMLInputElement>('input')].map((input) => input.type)).toEqual([
        'text',
        'text',
        'password'
    ]);
    expect([...body.querySelectorAll('select')].map((node) => node.className)).toEqual([
        'field-input field-select'
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

    // Its two state nodes: the refusal line (empty and hidden until a click is refused),
    // then the one-line `In use:` state that replaced the paragraph above it.
    const serverStatus = body.children[1] as HTMLElement;
    expect(serverStatus.getAttribute('role')).toBe('status');
    expect(serverStatus.textContent).toBe('');
    expect(serverStatus.hidden).toBe(true);
    expect(body.children[2].textContent).toBe(API_ROOT_HINT);

    // ONE action, labelled exactly `Apply`, and it is the LAST row of the body — the
    // right-alignment is the stylesheet's (`.endpoint-actions`, pinned by the CSS contract
    // below), the last-child position is the DOM's. `Reset` is gone with the draft
    // semantics: walking away from the dialog is how a reader discards an edit.
    const actions = byClass('.dialog .endpoint-actions', 'div');
    expect(actions.parentElement).toBe(body);
    expect(body.lastElementChild).toBe(actions);
    expect([...actions.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Apply']);
    expect(applyButton().className).toBe('button primary');
    expect(applyButton().type).toBe('button');
    // The whole layer has two buttons: the × of the head and this one. No `Reset`.
    expect(dialogButtons()).toEqual([
        ['head', '×'],
        ['body', 'Apply']
    ]);

    // The dropdown is the catalogue boot fetched, with the stored model selected. There is
    // no `Custom model…` entry and no manual input behind it.
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);
    expect(modelSelect().value).toBe('m1');
    expect(modelSelect().disabled).toBe(false);

    // The text lines, in DOM order: the (empty) refusal line, the root in use, and the one
    // model state line. Nothing else in the body says anything.
    expect([...body.querySelectorAll('.field-hint')].map((node) => node.textContent)).toEqual([
        '',
        API_ROOT_HINT,
        MODEL_LOADED
    ]);
    expect(actions.nextElementSibling).toBeNull();

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
    // The only `<select>`s on the page belong to the create-harness form: the model
    // dropdown is a persistent node too, and it is in NONE of them while the dialog is
    // closed.
    expect([...document.querySelectorAll('select')].map((node) => node.className)).toEqual([
        'field-input field-select create-primary',
        'field-input field-select create-agent-select'
    ]);
});

// --- draft-then-apply: the dialog writes nothing until `Apply` -----------------

it('previews dialog edits through the draft and persists only what Apply commits', async () => {
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
    // And nothing is stored. A keystroke moves the DRAFT; `underload-harness-app:settings`
    // still holds the byte string boot wrote (./main.ts `endpointDraft`).
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    apiKey.value = 'sk-test';
    apiKey.dispatchEvent(new Event('input', { bubbles: true }));

    modelSelect().value = 'm2';
    modelSelect().dispatchEvent(new Event('change', { bubbles: true }));

    // Three edits, one of them a model choice, and storage has not moved by a byte.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    await pastDebounce();

    // ONE refresh for the whole editing session (each keystroke re-arms the same timer),
    // and it carries the DRAFT credentials — the preview of a pasted base URL is what makes
    // the list trustworthy, and it persists nothing.
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

    // The refreshed catalogue repaints the SAME persistent dropdown and status line: 'm2'
    // is in the provider list, so the order stays the provider's and the choice holds.
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);
    expect(modelSelect().value).toBe('m2');
    expect(modelStatusLine()).toBe('Loaded 2 models from http://other/v1');

    // The stored api root is still absent: the root field was never touched, so the one
    // action the reader CAN press now must not invent an override out of the automatic
    // root it was prefilled with.
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();

    // `Apply` is the writer. The harness server URL did not move, so this is a plain save:
    // the payload lands in `loadSettings`' key order, the layer closes, and NO reload runs.
    const navigation = stubNavigation();
    applyButton().click();

    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://other/v1', 'sk-test', 'm2'));
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(navigation.reloads()).toBe(0);
    expect(document.querySelector('.dialog')).toBeNull();
});

it('offers a stored model the endpoint no longer advertises as the current choice', async () => {
    // The select can only offer what the endpoint lists, so a stored model that has been
    // retired needs its own option in front: the field must not silently rewrite a working
    // choice to the first entry, and the reader must still be able to move ONCE the
    // endpoint starts advertising it.
    localStorage.setItem(SETTINGS_KEY, '{"baseURL":"http://provider/v1","apiKey":"","model":"zeta-model"}');
    const calls = stub();
    await boot();
    openSettings();

    expect(modelSelect().value).toBe('zeta-model');
    expect(modelOptions()).toEqual([
        ['zeta-model (current)', 'zeta-model', false],
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);

    modelSelect().value = 'm1';
    modelSelect().dispatchEvent(new Event('change', { bubbles: true }));

    // Moving onto an advertised id is a DRAFT edit: storage still names the retired model,
    // and no session was created. (The catalogue read IS a POST, so the assertion names the
    // route rather than the verb.)
    expect(modelSelect().value).toBe('m1');
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'zeta-model'));
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toEqual([]);

    applyButton().click();

    // `Apply` is the only writer, and a model move needs no reload — the root did not
    // change, so the new id is simply used by the session created next.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    expect(document.querySelector('.dialog')).toBeNull();
});

it('shows a disabled placeholder when the endpoint lists no models at all', async () => {
    // A well-formed catalogue that comes back empty is a STATE, not an error: the select
    // has to say so in its own options rather than leave the reader with an empty box or a
    // fake `Select a model` blank that would commit as an empty model id.
    // The FIRST `stub()` parameter is the route layer that runs in front of the default
    // answers, so this overrides the catalogue read and nothing else.
    stub((url) => (url === '/api/models' ? json({ models: [] }) : undefined));
    await boot();
    openSettings();

    expect(modelOptions()).toEqual([['m1 (current)', 'm1', false], ['No models', '', true]]);
    expect(modelSelect().value).toBe('m1');
    expect(modelStatusLine()).toBe('No models returned');
});

it('persists nothing on any dismissal path, and reopens from what is saved', async () => {
    const calls = stub();
    await boot();

    // The three ways out `ui/dialog.ts` owns. Each one gets the same full edit — provider
    // triple AND the server URL field — and each one must leave BOTH storage keys exactly
    // as they were, which is the whole argument for deleting `Reset`.
    const dismissals: (() => void)[] = [
        () => closeWithEscape(),
        () => byClass('.dialog-close', 'button').click(),
        () => byClass('.dialog-overlay', 'div').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ];

    for (const dismiss of dismissals) {
        openSettings();
        const [baseURL, apiKey] = [
            ...document.querySelectorAll<HTMLInputElement>('.dialog label.field > input.field-input')
        ];

        baseURL.value = 'http://dismissed/v1';
        baseURL.dispatchEvent(new Event('input', { bubbles: true }));
        apiKey.value = 'sk-dismissed';
        apiKey.dispatchEvent(new Event('input', { bubbles: true }));
        modelSelect().value = 'm2';
        modelSelect().dispatchEvent(new Event('change', { bubbles: true }));
        // The root field is edited too, and editing it is inert on its own: only the
        // button writes it, and the button was never pressed.
        serverRootInput().value = 'http://localhost:5000/v1/harness';
        serverRootInput().dispatchEvent(new Event('input', { bubbles: true }));

        dismiss();
        expect(document.querySelector('.dialog')).toBeNull();

        // Settings untouched (the boot payload), and no api-root key was created either.
        expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
        expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();

        // The reopen repaints from what is SAVED, so a stale draft can never haunt the
        // fields the reader is about to commit.
        openSettings();
        expect(
            document.querySelector<HTMLInputElement>('.dialog label.field > input.field-input')?.value
        ).toBe('http://provider/v1');
        expect(apiKey.value).toBe('');
        expect(modelSelect().value).toBe('m1');
        expect(serverRootInput().value).toBe(API_ROOT);
        byClass('.dialog-close', 'button').click();
    }

    // No dismissal leaked a provider request either: dismissing also drops the pending
    // debounce (./main.ts `cancelModelPreview`), so the only `/models` call is boot's.
    expect(modelCalls(calls)).toHaveLength(1);
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

    // The edits happen in the DRAFT and `Apply` commits them: the dialog closes itself as
    // part of applying, and the values are app state, so a submit after that still uses
    // them. A root change would reload instead, and this test never touches the root.
    openSettings();
    const [baseURL, apiKey] = [
        ...document.querySelectorAll<HTMLInputElement>('.dialog label.field > input.field-input')
    ];
    baseURL.value = 'http://other/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    apiKey.value = 'sk-test';
    apiKey.dispatchEvent(new Event('input', { bubbles: true }));
    const select = modelSelect();
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // The DRAFT is what the select shows; storage is still what boot wrote until Apply.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    applyButton().click();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://other/v1', 'sk-test', 'm2'));

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
    const calls = stub();
    await boot();

    openSettings();
    const body = settingsRoot();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');
    const select = modelSelect();
    const optionValues = [...select.options].map((option) => option.value);

    baseURL.value = 'http://typed-once/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.dialog-close', 'button').click();

    // Close removes the OVERLAY only. The settings survive detached, so nothing can be
    // quietly rebuilt behind the reader's back. The keystroke's debounced preview died with
    // the close (`cancelModelPreview`), so the boot read is still the only one.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.dialog-overlay')).toBeNull();
    expect(baseURL.isConnected).toBe(false);
    expect(body.isConnected).toBe(false);
    expect(modelCalls(calls)).toHaveLength(1);

    openSettings();

    // Identity, not similarity: the reopen adopts the SAME persistent nodes. Scoped to
    // `label.field` because the first `input.field-input` in the dialog is now the
    // harness server URL, which is not part of the provider triple.
    expect(settingsRoot()).toBe(body);
    expect(document.querySelector('.dialog label.field > input.field-input')).toBe(baseURL);
    expect(document.querySelector('.dialog .field-select')).toBe(select);
    // Re-based, not remembered: the dismissed keystroke is gone.
    expect(baseURL.value).toBe('http://provider/v1');
    expect(select.value).toBe('m1');

    // The listeners survived the move. A keystroke previews instead of persisting — the
    // value the closed dialog wrote is still what storage holds — and it re-arms the
    // debounced refresh, drained INSIDE this test: the app's 500ms timer outlives the
    // module instance, and a request that lands after `vi.resetModules()` would be recorded
    // by the NEXT test's stub (the same reason main.test.ts waits past the debounce after
    // touching the endpoint fields).
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    baseURL.value = 'http://typed-twice/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    await pastDebounce();
    expect(modelCalls(calls)).toHaveLength(2);
    expect(modelStatusLine()).toBe('Loaded 2 models from http://typed-twice/v1');

    applyButton().click();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://typed-twice/v1', '', 'm1'));

    // Apply closed the overlay (the host detaches with it), and the dropdown the reader
    // picked from is the same option list — not a rebuild.
    expect(document.querySelectorAll('.endpoint-body')).toHaveLength(0);
    expect([...select.options].map((option) => option.value)).toEqual(optionValues);
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

// R1: the pill is APP-scoped, not centre-scoped. While the tools catalogue owns the
// centre column the press still opens the endpoint dialog — the layer is an overlay on
// `document.body` (./ui/dialog.ts) that covers the pane — and a second press closes it
// again without leaving the catalogue.
it('opens over the tools catalogue and toggles closed on a second press', async () => {
    stub();
    await boot();

    byClass('.tools-toggle', 'button').click();
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('true');

    openSettings();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Endpoint & model');
    // The catalogue is still the centre view underneath the dialog: the press added a
    // body-level layer, it did not switch views.
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();

    openSettings();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('true');

    // Back in the chat the trigger behaves exactly as it always did.
    byClass('.tools-toggle', 'button').click();
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('false');

    openSettings();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Endpoint & model');
});

// R2: the Plugins view owns the centre in exactly the same way, so it must not swallow the
// press either. The catalogue is read on FIRST open (`./main.ts` `setPluginsView` →
// `loadPlugins`), so this fixture answers `/api/plugins` with the empty page in the
// `PluginSummaryPage` wire shape (../shared/harness-api.ts) — an unmapped route throws and
// the pane would carry an error card instead of the catalogue.
it('opens over the plugins catalogue and toggles closed on a second press', async () => {
    const calls = stub((url) =>
        url.startsWith('/api/plugins')
            ? json({ items: [], limit: 25, next_cursor: null, observed_at: 1, revision: 1 })
            : undefined
    );
    const pluginReads = (): number =>
        calls.filter((call) => call.url.startsWith('/api/plugins')).length;

    await boot();

    // R2 from the other side of the same rule: the page is NOT paid for at boot.
    expect(pluginReads()).toBe(0);

    byClass('.plugins-toggle', 'button').click();
    expect(byClass('.plugins-toggle', 'button').getAttribute('aria-pressed')).toBe('true');
    await flush();

    // Exactly one read, and it was ANSWERED (no `.plugins-error` card in the pane).
    expect(pluginReads()).toBe(1);

    openSettings();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Endpoint & model');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(document.querySelector('.plugins-error')).toBeNull();

    openSettings();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
    expect(byClass('.plugins-toggle', 'button').getAttribute('aria-pressed')).toBe('true');

    byClass('.plugins-toggle', 'button').click();
    expect(byClass('.plugins-toggle', 'button').getAttribute('aria-pressed')).toBe('false');

    openSettings();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Endpoint & model');
});

// R3: because the pill now opens over a catalogue, `Apply` is reachable WHILE the Tools
// catalogue owns the centre — a path that did not exist while the guard suppressed the
// press. Applying there is still a plain save (the harness server URL field is untouched,
// so no reload): the layer closes, and the repaint it triggers must NOT reclaim the head.
// `renderHarnessChrome` returns early while `showingTools`/`showingPlugins` is set
// (./main.ts), so `paintToolsHead`'s title survives and the catalogue stays the centre
// view — the reader is left exactly where they were, with the settings committed.
it('applies from the pill over the tools catalogue without reclaiming the catalogue head', async () => {
    stub();
    await boot();

    byClass('.tools-toggle', 'button').click();
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    // The head the catalogue paints (./main.ts `paintToolsHead` writes the title text node
    // inside the `h1.main-title` button, the same shared head the chat title uses).
    expect(byClass('.main-title', 'h1').textContent).toBe('Tools Catalogue');

    openSettings();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Endpoint & model');

    const navigation = stubNavigation();
    applyButton().click();

    // The layer is gone — both the panel and its backdrop, so nothing shadows the toggles.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);

    // The catalogue still owns the centre column: the save never switched views.
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    // And the chat head was NOT resurrected over it: the shared head still carries the
    // catalogue title `paintToolsHead` painted, not the selected harness's display title.
    expect(byClass('.main-title', 'h1').textContent).toBe('Tools Catalogue');
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('true');

    // No reload: the root did not move, so Apply is a save, not a reconnect.
    expect(navigation.reloads()).toBe(0);
});

// --- the live region keeps working while the dialog is open -------------------

it('still paints the same status live region in place while the dialog is open', async () => {
    // An endpoint-requiring harness whose COMMITTED base URL is blank. The dialog can no
    // longer half-apply a config, so the refusal has to come from real settings: seed them
    // BEFORE boot and only open the dialog to prove it does not block the announcement.
    localStorage.setItem(SETTINGS_KEY, '{"baseURL":"","apiKey":"","model":"m1"}');
    const calls = stub();
    await boot();

    const button = byClass('.status-button', 'button');
    const pill = byClass('.status', 'span');
    const stateWord = byClass('.status-text', 'span');
    const detail = byClass('.status-detail', 'span');

    openSettings();

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

    // A blank base URL is a STATE, not a request: nothing is asked of the provider, and
    // the persistent status line says what is wrong.
    expect(modelCalls(calls)).toEqual([]);
    expect(modelStatusLine()).toBe('No base URL set');

    // The pill still closes from an error state, and reopens on the same blank value —
    // with the select parked on the disabled placeholder rather than a manual fallback.
    button.click();
    expect(document.querySelector('.dialog')).toBeNull();
    button.click();
    expect(byClass('.dialog label.field > input.field-input', 'input').value).toBe('');
    expect(modelStatusLine()).toBe('No base URL set');
    expect(modelOptions()).toEqual([['m1 (current)', 'm1', false], ['No models', '', true]]);
});

// --- the harness server URL (the UI-level server setting) -------------------
//
// The dialog is where a reader points this UI at a DIFFERENT harness without a
// rebuild: the field is prefilled from what this browser saved (or from the automatic
// root), Apply validates and persists it, then strips the one-load `?apiRoot=` override
// and reloads — because every request URL and the socket are built from the root
// resolved at module load (./api.ts), and the shell has no in-place reset. `location
// .reload` is stubbed (see `stubNavigation`), so these tests count the reload instead of
// performing it. Leaving the field BLANK is how you ask for automatic resolution: Apply
// clears the saved key rather than storing an empty string (that is what replaced the old
// Reset button — one action, one direction).
//
// A click fails LOUDLY whenever the write cannot land, and then changes NOTHING: the
// reason goes on the refusal line, the dialog stays open with the typed value, no key is
// written and no reload happens. That covers a malformed URL, a root that normalizes
// away to `''` (`/`), a typed Apply in a browser that exposes no `localStorage`, and a
// store that can read but refuses the `remove` for a blank field. Reloading in any of
// those cases would land on the OLD root and read as an Apply that silently did nothing.
// The clear in a browser with NO store is the one clear that cannot fail: there is
// nothing to remove and automatic resolution is what such a browser already gets, so it
// succeeds and reloads.

it('prefills the server URL from the saved setting, not from a one-load override', async () => {
    // A saved cross-origin root is the whole point of the setting: it is trusted
    // (typed by this browser, never delivered by a link), so the UI boots against it and
    // the dialog names it as the root in use.
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    stub();
    await boot();
    openSettings();

    expect(serverRootInput().value).toBe('https://harness.example.test/v1/harness');
    expect(serverRootLiveLine()).toBe(apiRootLine('https://harness.example.test/v1/harness'));

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
    expect(serverRootLiveLine()).toBe(apiRootLine('http://localhost:5000/v1/harness'));
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

    applyButton().click();

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
    applyButton().click();

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
    expect(serverRootLiveLine()).toBe(API_ROOT_HINT);
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
    applyButton().click();

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
    applyButton().click();

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

it('clears to the automatic root even in a browser with no local storage', async () => {
    // The CLEAR half of the no-store rule (./api.ts `saveApiRootSetting`, T5): the missing
    // store may only refuse a value that has to be kept. A blank field asks for automatic
    // resolution, and a browser with no store is already there — `storedApiRoot()` reads it
    // as "no setting" — so there is nothing to remove and the click must behave like every
    // other successful clear: write nothing, show no refusal, drop the one-load override,
    // reload.
    stub();
    await boot();
    openSettings();

    // Same mid-session stubbing as the test above (the boot needs the real store for the
    // provider settings); the guard is only observable at the click.
    window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
    const navigation = stubNavigation();

    vi.stubGlobal('localStorage', undefined);

    expect(applyButton().textContent).toBe('Apply');
    serverRootInput().value = '';
    serverRootInput().dispatchEvent(new Event('input', { bubbles: true }));
    applyButton().click();

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
    applyButton().click();

    // An empty string would be a stored value that resolves to nothing; the key is gone,
    // so the next load walks the documented ladder from the top.
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(navigation.reloads()).toBe(1);
});

it('clears to the automatic root on a blank field: no saved URL, no override, reload', async () => {
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    stub();
    await boot();
    openSettings();

    window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
    const navigation = stubNavigation();

    // The one Apply button, and the blank field that stands in for the old Reset: the
    // label is asserted here so the removal of the second button cannot go unnoticed.
    expect(applyButton().textContent).toBe('Apply');
    serverRootInput().value = '';
    serverRootInput().dispatchEvent(new Event('input', { bubbles: true }));
    applyButton().click();

    expect(navigation.reloads()).toBe(1);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(navigation.location.search).toBe('');

    // A clear with no failure never shows the refusal line.
    expect(serverRootStatusLine().hidden).toBe(true);
});

it('reports a store that refuses the clear instead of reloading onto the same saved root', async () => {
    // The store here CAN read (the boot resolves the saved root and the field is
    // prefilled from it) but CANNOT remove. Silently accepting that made the clear a no-op
    // the reader could never see finish: the reload re-resolved the very host they just
    // asked to leave. The provider payload is seeded rather than left to the bootstrap so
    // the byte string below is a fact of this test, not of the boot's defaulting.
    localStorage.setItem(SERVER_URL_KEY, 'https://harness.example.test/v1/harness');
    localStorage.setItem(SETTINGS_KEY, storedSettings('http://provider/v1', '', 'm1'));
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();

    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError');
    });

    // A provider edit is staged in the draft as well, so "the refusal changed NOTHING" is
    // observable on both storage keys and on the field itself.
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');
    baseURL.value = 'http://not-committed/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    serverRootInput().value = '';
    serverRootInput().dispatchEvent(new Event('input', { bubbles: true }));
    applyButton().click();

    const status = serverRootStatusLine();
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(
        'Could not clear the saved harness server URL in this browser: SecurityError'
    );

    expect(navigation.reloads()).toBe(0);
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    // The failure is the WHOLE Apply: the root was validated first, so the provider draft
    // is still uncommitted, still on screen, and neither key moved.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    expect(baseURL.value).toBe('http://not-committed/v1');

    removeItem.mockRestore();

    // Why the reload is the wrong answer: the saved root survived the failed clear.
    expect(localStorage.getItem(SERVER_URL_KEY)).toBe('https://harness.example.test/v1/harness');

    // The staged provider edit armed the catalogue debounce, and that timer outlives the
    // module instance: drain it HERE so the request cannot land in the next test's stub.
    await pastDebounce();
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
    expect(serverRootLiveLine()).toBe(apiRootLine(live));
});

// --- the model catalogue lifecycle (F1/F2/F3 + the async states) --------------
//
// Every remaining surface of the model group is ASYNC, and a synchronous stub cannot pin a
// single one of them: when each answer arrives immediately, the newest answer is also the only
// answer, so a `Loading models…` frame, a superseded lookup, and a lookup that outlives the
// dialog that started it are all invisible. `delayedJson` therefore returns the `Response`
// synchronously but closes its BODY on a timer, so the client is genuinely waiting on a request
// the scenario controls, and `scriptedModels` scripts the ANSWER OF EACH CALL IN ORDER (call 0
// is boot's read).
//
// What this section pins, in dependency order:
//   - SUPERSESSION: two typed endpoints, overlapping lookups, the FIRST answer arriving LAST.
//     Exactly one catalogue ends up painted, and it is the second endpoint's (./main.ts
//     `modelTicket` / `modelRequest?.abort()`);
//   - F1: a preview that is dismissed mid-flight (or superseded) never touches the PUBLISHED
//     catalogue the per-agent dropdowns read (./main.ts `agentModelSelectOf` → the shared
//     `catalogue`), and it is read from both sides: the real per-agent `<select>`, and the reopen
//     of the dialog itself. `Apply` is the one moment a preview MAY publish, and the applied
//     endpoint then shows up in every per-agent dropdown;
//   - the CATALOGUE IDENTITY (./main.ts `ModelLookup`): the app-wide list moves only on a lookup
//     of the COMMITTED pair — boot, the one a dialog open arms when nothing is known, or `Apply` —
//     and a preview that is dismissed or superseded never moves it. The identity is the (Base URL,
//     API key) pair, so applying a key the published list was not fetched with re-asks rather than
//     publishing the wrong credential's answer;
//   - F2: dismissing a lookup in flight leaves the state line on the initial wording (never a
//     `Loading models…` with nothing in flight), and reopening either seeds the published list
//     or arms exactly one fetch when nothing is known for the committed endpoint;
//   - the failure line `Could not load models: <server message>` — the only error surface the
//     group has left — and the fact that a failed PREVIEW costs the published catalogue
//     nothing;
//   - F3: with a blank stored model the id the dropdown DISPLAYS is the id `Apply` COMMITS, and
//     no extra option was invented to get there;
//   - F7: `Enter` in a text field is the same single commit as the button — once, not twice, and
//     not at all when the keystroke is an IME confirming a candidate;
//   - F4: a bootstrap that lands while the dialog is open must not rewrite what the reader is
//     typing, and must not cost the app its catalogue.
//
// Timing: the debounce is 500ms (./main.ts `MODEL_REFRESH_DELAY_MS`). The cases that only need to
// be "past the debounce" use the real clock and `pastDebounce()`; the two that make claims about
// WHEN an answer lands run on `vi.useFakeTimers()` (the package convention — ./main.test.ts,
// ./ui/turns.test.ts, ./ui/tools.test.ts) so every assertion names an exact tick with no slack,
// and each scripted body reports whether it was actually delivered. `wait()` and `flush()` are
// real-timer helpers and must not be awaited under the fake clock: their `setTimeout` would never
// fire, so the fake-clock cases advance the clock instead.

const wait = async (ms: number): Promise<void> => {
    await new Promise((done) => setTimeout(done, ms));
};

// The fake-clock replacements. `advance` steps the clock and then yields once more so the promise
// chain an answer starts (body → `response.json()` → the caller) has settled before the test
// reads the DOM — the microtask equivalent of what `flush()` does on the real clock.
const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
};

// `boot()` on the fake clock. `main.ts` calls `boot()` without awaiting it, so the import settles
// as soon as the module body has run; advancing 50ms then drains the microtask-only bootstrap and
// the COMMITTED `/models` read it arms.
const bootOnFakeClock = async (): Promise<void> => {
    await import('./main');
    await advance(50);
};

// How many scripted `/models` BODIES have actually been written into their stream. A "the late
// answer changed nothing" assertion is worthless on its own: the same assertions pass when the
// answer never arrived at all, so the fixture testifies to the delivery and the case asserts it.
type BodyDelivery = { bodies: number };

// A `/models` answer whose BODY lands on a timer. The fixture never consults the abort signal, so
// a cancelled lookup really does receive its answer afterwards — and whether that answer is
// rejected at the socket or dropped by the ticket, it must not paint.
const delayedJson = (
    value: unknown,
    delay: number,
    status = 200,
    delivered?: BodyDelivery
): Response => {
    if (delay === 0) {
        if (delivered !== undefined) delivered.bodies += 1;
        return json(value, status);
    }

    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                window.setTimeout(() => {
                    controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                    controller.close();
                    if (delivered !== undefined) delivered.bodies += 1;
                }, delay);
            }
        }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
};

// One scripted `/models` call: the ids it serves, how long the body takes, and (for a failure)
// the server's own message and status.
type ModelAnswer = { ids?: readonly string[]; delay?: number; status?: number; message?: string };

// The route handler IN FRONT of the shared stub's default answers (./stub's first parameter),
// consuming one scripted answer per call in call order. An exhausted queue answers an empty
// catalogue rather than throwing, so an unexpected extra lookup still shows up as a changed
// option list instead of an unrelated failure. Pass a `BodyDelivery` to count the bodies that were
// actually written (see above).
const scriptedModels =
    (answers: readonly ModelAnswer[], delivered?: BodyDelivery): ((url: string) => Response | undefined) => {
        const queue = [...answers];

        return (url: string): Response | undefined => {
            if (url !== '/api/models') return undefined;

            const answer = queue.shift() ?? {};

            return answer.message === undefined
                ? delayedJson({ models: answer.ids ?? [] }, answer.delay ?? 0, 200, delivered)
                : delayedJson(
                      { error: { message: answer.message } },
                      answer.delay ?? 0,
                      answer.status ?? 502,
                      delivered
                  );
        };
    };

// The model group's two nodes, captured while the layer is OPEN so a test can keep reading them
// after a close DETACHES the pane. They are the persistent nodes ./main.ts `endpointBody` owns
// (that is what `openEndpointDialog` adopts), and the state line must be right in BOTH
// states — the reader sees it while connected, and the reopen contract depends on what it says
// while detached.
const captureModelGroup = (): { readonly status: Element; readonly select: HTMLSelectElement } => {
    const status = settingsRoot().querySelector('.field .field-hint');
    if (status === null) throw new Error('missing model status line');

    return { status, select: modelSelect() };
};

// `[label, value, disabled]` triples for ANY `<select>`, including a DETACHED one that
// `modelOptions()` cannot reach (it queries through `.dialog`, and a closed layer has removed
// the pane from the document).
const optionsOf = (select: HTMLSelectElement): [string | null, string, boolean][] =>
    [...select.options].map(
        (option) => [option.textContent ?? null, option.value, option.disabled] as [
            string | null,
            string,
            boolean
        ]
    );

// The catalogue the APP publishes, read where it is actually consumed: the per-agent model
// dropdown inside the agent dialog (./main.ts:6800 → ui/agents.ts `createAgentModelSelect`).
// Option 0 is the no-override choice labelled with the effective default (here the bootstrap
// default `m1`), so a published `['m1','m2']` is exactly `['', 'm2']` — and a catalogue that a
// preview leaked into the app would name the preview's ids instead.
const publishedCatalogue = (): string[] => {
    byClass('.agent-control-button', 'button').click();
    const values = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')].map(
        (select) => [...select.options].map((option) => option.value)
    );
    byClass('.dialog-close', 'button').click();

    if (values.length === 0) throw new Error('no per-agent model dropdown was rendered');

    return values[0] ?? [];
};

it('paints the newest preview only, when two lookups overlap and the first answer lands last', async () => {
    // The clock is faked because this case is about WHEN each answer lands: every wait below is an
    // exact tick, and the delivery tally proves both that the stale answer had NOT landed when the
    // newest one painted and that it DID land before the "nothing changed" assertions ran.
    vi.useFakeTimers();

    const delivered: BodyDelivery = { bodies: 0 };
    const calls = stub(
        scriptedModels(
            [
                // 0: boot's committed read for the saved endpoint — the published catalogue.
                { ids: ['m1', 'm2'] },
                // 1: the first typed endpoint, answering 1.5s after its own request.
                { ids: ['x1', 'x2'], delay: 1500 },
                // 2: the second typed endpoint, answering at once.
                { ids: ['y1'] }
            ],
            delivered
        )
    );
    await bootOnFakeClock();
    openSettings();

    const baseURL = byClass('.dialog label.field > input.field-input', 'input');

    baseURL.value = 'http://slow/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    // The debounce fires at exactly t+500ms, so the first lookup is in flight and its body is a
    // further 1500ms away. A keystroke is a PREVIEW: the loading state is painted, and only boot's
    // answer has been delivered.
    await advance(500);
    expect(modelCalls(calls)).toHaveLength(2);
    expect(delivered.bodies).toBe(1);
    expect(modelStatusLine()).toBe('Loading models…');

    baseURL.value = 'http://fast/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    // Exactly 1000ms in: the second debounce has fired (t+1000ms) and its answer is immediate, so
    // `y1` is on screen while the FIRST answer is still 1000ms away (t+2000ms). The tally is what
    // proves that ordering rather than assuming it.
    await advance(500);
    expect(modelCalls(calls)).toHaveLength(3);
    expect(delivered.bodies).toBe(2);
    // `m1` is the committed model and the fast endpoint does not list it, so it keeps its
    // `(current)` entry; the catalogue itself is the second endpoint's, alone.
    expect(modelOptions()).toEqual([
        ['m1 (current)', 'm1', false],
        ['y1', 'y1', false]
    ]);
    expect(modelSelect().value).toBe('m1');
    expect(modelSelect().disabled).toBe(false);
    expect(modelStatusLine()).toBe('Loaded 1 model from http://fast/v1');

    // t+2000ms: the stale answer has now landed (it was issued under a superseded ticket and its
    // request was aborted when the new lookup started). It may not repaint the option list, the
    // selection, or the state line — and it may not have published either, since the endpoint it
    // dialled was never applied. `delivered` is the proof there was an answer to drop.
    await advance(1000);
    expect(delivered.bodies).toBe(3);
    expect(modelOptions()).toEqual([
        ['m1 (current)', 'm1', false],
        ['y1', 'y1', false]
    ]);
    expect(modelSelect().value).toBe('m1');
    expect(modelStatusLine()).toBe('Loaded 1 model from http://fast/v1');

    // One lookup per edit — the debounce still coalesces — and a preview persists nothing.
    expect(modelCalls(calls)).toHaveLength(3);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    // The published side of the same fact: neither typed endpoint (`slow`, then `fast`) was ever
    // applied, so the app-wide catalogue the per-agent dropdowns read still holds the provider
    // the reader applied. The layer closes first because the agent dialog is the second caller
    // of `openDialog`, and only one layer should be on screen while it is read.
    byClass('.dialog-close', 'button').click();
    expect(publishedCatalogue()).toEqual(['', 'm2']);
});

it('leaves the published catalogue alone when a preview is dismissed mid-flight, and seeds it back on reopen', async () => {
    // Fake clock for the same reason as the case above, and a harder one: the whole point here is
    // that an answer arrives in a dialog that no longer exists, which is only an OBSERVATION once
    // the fixture has reported delivering it. Remove the ticket check in ./main.ts `refreshModels`
    // and the two post-delivery assertions below fail; make the answer never arrive and the
    // delivery count fails. Either way the case discriminates.
    vi.useFakeTimers();

    const delivered: BodyDelivery = { bodies: 0 };
    const calls = stub(
        scriptedModels(
            [
                { ids: ['m1', 'm2'] },
                // A foreign endpoint that answers only after the reader has walked away.
                { ids: ['x1', 'x2'], delay: 1200 }
            ],
            delivered
        )
    );
    await bootOnFakeClock();

    // The app-wide starting point: the provider the reader applied.
    expect(publishedCatalogue()).toEqual(['', 'm2']);

    openSettings();
    const group = captureModelGroup();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');

    baseURL.value = 'http://foreign/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    // t+500ms: the debounce has just fired, so the preview is in flight and the control is
    // disabled and says so (the state this dialog shows while waiting, pinned here because the
    // dismiss below has to UNDO it). The foreign body is still 1200ms away.
    await advance(500);
    expect(modelCalls(calls)).toHaveLength(2);
    expect(delivered.bodies).toBe(1);
    expect(modelSelect().disabled).toBe(true);
    expect(modelOptions()).toEqual([['Loading models…', '', true]]);
    expect(modelStatusLine()).toBe('Loading models…');

    // Dismiss mid-flight (./main.ts `cancelModelPreview`): the pending work is gone, the state
    // line goes back to the initial wording, and the dropdown is enabled again — a
    // `Loading models…` with nothing in flight would be a lie the reader could not escape.
    closeWithEscape();
    expect(group.status.isConnected).toBe(false);
    expect(group.status.textContent).toBe('Model list not loaded yet.');
    expect(group.select.disabled).toBe(false);

    // t+1700ms: the foreign answer is now written into the socket of a dialog that no longer
    // exists, and the guard — not the timing — is what keeps it off the screen. The detached
    // nodes still say exactly what the cancel said, ids included.
    await advance(1200);
    expect(delivered.bodies).toBe(2);
    expect(group.status.textContent).toBe('Model list not loaded yet.');
    expect(optionsOf(group.select)).toEqual([
        ['m1 (current)', 'm1', false],
        ['No models', '', true]
    ]);
    expect(publishedCatalogue()).toEqual(['', 'm2']);

    // The reopen is the proof the published catalogue was untouched: it seeds from `modelIds`,
    // so the provider the reader DID applied is back on screen with its own state line, not
    // `No models` and not the foreign ids.
    openSettings();
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);
    expect(modelSelect().value).toBe('m1');
    expect(modelStatusLine()).toBe('Loaded 2 models from http://provider/v1');

    // And the dismiss dropped the pending debounce: still exactly two lookups, the second one
    // answered into the void.
    expect(modelCalls(calls)).toHaveLength(2);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    byClass('.dialog-close', 'button').click();
});

it('reports the server message when the preview lookup fails, and costs the published catalogue nothing', async () => {
    // The one error surface the model group has left. The body is the contract's error envelope
    // and the status is the real one the harness server uses for an upstream provider failure
    // (./server/api.ts:2756 maps a model-list failure to 502 with the upstream message).
    const message = 'The provider replied 502 Bad Gateway for GET http://broken/v1/models.';
    const calls = stub(
        scriptedModels([
            { ids: ['m1', 'm2'] },
            { message, status: 502 }
        ])
    );
    await boot();
    openSettings();

    const baseURL = byClass('.dialog label.field > input.field-input', 'input');
    baseURL.value = 'http://broken/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    await pastDebounce();

    // The server's own text, verbatim, on the state line — not a generic failure word and not a
    // swallowed reason.
    expect(modelStatusLine()).toBe(`Could not load models: ${message}`);
    expect(settingsRoot().querySelector('.field .field-hint')?.classList.contains('is-warning')).toBe(true);
    // A failure is not a catalogue: the empty placeholder is back, and the stored model is still
    // selectable rather than silently dropped.
    expect(modelOptions()).toEqual([
        ['m1 (current)', 'm1', false],
        ['No models', '', true]
    ]);
    expect(modelSelect().disabled).toBe(false);

    // Dismissing an endpoint that failed leaves the app pointing at the provider that was
    // actually applied — a failed PREVIEW may not clear the published catalogue.
    byClass('.dialog-close', 'button').click();
    expect(publishedCatalogue()).toEqual(['', 'm2']);

    openSettings();
    expect(modelStatusLine()).toBe('Loaded 2 models from http://provider/v1');
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);
    byClass('.dialog-close', 'button').click();

    expect(modelCalls(calls)).toHaveLength(2);
});

it('re-arms one lookup when a reopen knows nothing about the committed endpoint', async () => {
    // Boot's read FAILS (502), so nothing is published and the state line still carries the
    // server's reason. `No models` beside a Base URL that is set is exactly the dead end F2 is
    // about: the only controls the reader has are the two text fields they may not want to touch.
    const calls = stub(
        scriptedModels([
            { message: 'The provider is not reachable.', status: 502 },
            // The reopen's armed lookup: this time the provider answers.
            { ids: ['m1', 'm2'] }
        ])
    );
    await boot();
    openSettings();

    // Nothing was known for the committed Base URL, so opening armed exactly one fetch. The
    // state line is the honest loading line, not the boot failure and not `No models` alone.
    expect(modelCalls(calls)).toHaveLength(2);
    expect(modelStatusLine()).toBe('Loading models…');
    expect(modelSelect().disabled).toBe(true);
    expect(modelOptions()).toEqual([['Loading models…', '', true]]);

    await pastDebounce();
    expect(modelStatusLine()).toBe('Loaded 2 models from http://provider/v1');
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);

    const group = captureModelGroup();
    closeWithEscape();

    // F2/F5(d): the cancel resets the preview to the CLEAN initial line — the state the group
    // was in before anything was asked.
    expect(group.status.textContent).toBe('Model list not loaded yet.');
    expect(group.select.disabled).toBe(false);

    // And the reopen does NOT ask again: a catalogue is now known for exactly that Base URL, so
    // it seeds from it. Bounded by construction — one fetch per open, no polling, no TTL, and a
    // provider that serves zero models never earns a request per open either.
    openSettings();
    expect(modelCalls(calls)).toHaveLength(2);
    expect(modelStatusLine()).toBe('Loaded 2 models from http://provider/v1');
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);
    byClass('.dialog-close', 'button').click();
});

it('publishes the applied endpoint into every per-agent model dropdown', async () => {
    // The positive half of F1, which the negative cases above only imply: `Apply` is the moment a
    // preview is ALLOWED to become the app-wide catalogue, so the endpoint the reader applied has
    // to show up in the per-agent dropdowns and not only in the dialog they are looking at.
    const calls = stub(
        scriptedModels([
            // boot's committed read for the stored endpoint.
            { ids: ['m1', 'm2'] },
            // what the endpoint the reader then TYPES advertises.
            { ids: ['p1', 'p2'] }
        ])
    );
    await boot();
    openSettings();

    const baseURL = byClass('.dialog label.field > input.field-input', 'input');
    baseURL.value = 'http://applied/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));
    await pastDebounce();

    // The preview is the typed endpoint's list, and the stored model is still selectable because
    // the new endpoint does not advertise it.
    expect(modelOptions()).toEqual([
        ['m1 (current)', 'm1', false],
        ['p1', 'p1', false],
        ['p2', 'p2', false]
    ]);
    expect(modelStatusLine()).toBe('Loaded 2 models from http://applied/v1');

    applyButton().click();

    // What the layer was showing answered for exactly the pair that has just been committed, so
    // `Apply` moves the APP-WIDE catalogue onto it: the per-agent dropdowns now offer the applied
    // endpoint's ids. Option 0 is still the no-override choice labelled with the effective default
    // (`m1`), which is why the first value stays empty.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://applied/v1', '', 'm1'));
    expect(publishedCatalogue()).toEqual(['', 'p1', 'p2']);

    // And `Apply` armed no second lookup: the published catalogue already answers for the
    // committed pair (./main.ts `publishedCatalogueAnswers`), so the corrective request is skipped
    // by construction rather than by a timing accident.
    expect(modelCalls(calls)).toHaveLength(2);
});

it('publishes the server-default catalogue on boot even when the dialog is already open', async () => {
    // M1. The status pill is live before the bootstrap lands, so the dialog can be open when
    // `applyDefaults` runs — and it deliberately leaves the draft alone then (./main.ts F4), which
    // means the fields still name the PRE-boot endpoint when the server's defaults arrive. The boot
    // lookup belongs to the settings that just landed, not to that draft, and its answer is what
    // the app-wide catalogue must end up holding. Before this, the comparison of a pre-boot draft
    // against the fresh settings made the answer un-publishable and every per-agent dropdown stayed
    // without provider ids for the whole load.
    vi.useFakeTimers();

    const models = scriptedModels([
        // 0: the open-time seed, dialling the endpoint the dialog was SHOWING.
        { ids: ['stale1'] },
        // 1: boot's committed read, dialling the endpoint the bootstrap just named.
        { ids: ['m1', 'm2'] }
    ]);
    const calls = stub((url) => (url === '/api' ? delayedJson(bootstrap(), 500) : models(url)));

    const loaded = import('./main');
    for (let attempt = 0; attempt < 20 && document.querySelector('.status-button') === null; attempt += 1) {
        await advance(25);
    }

    openSettings();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');

    // The layer really is inside the bootstrap window: the field still names the module-load
    // endpoint, so the server defaults have not landed (and have not been re-synced) yet.
    expect(baseURL.value).toBe('http://localhost:5500/providers/private/v1');

    // The defaults land, the draft is left alone, and boot dials the endpoint it just learned.
    await advance(500);
    await loaded;
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    expect(baseURL.value).toBe('http://localhost:5500/providers/private/v1');

    // Boot's remaining work is a promise chain rather than a timer, so the clock is stepped until
    // the composer's agent control exists instead of guessing how many hops it needs.
    for (
        let attempt = 0;
        attempt < 20 && document.querySelector('.agent-control-button') === null;
        attempt += 1
    ) {
        await advance(25);
    }

    // Each lookup dialled the pair its caller owns, and the wire body is the proof: the second
    // request carries the SERVER's endpoint even though the dialog is still showing the old one.
    expect(
        modelCalls(calls).map(
            (call) => (call.body as { settings: { base_url: string } }).settings.base_url
        )
    ).toEqual(['http://localhost:5500/providers/private/v1', 'http://provider/v1']);

    closeWithEscape();

    // The app-wide catalogue is boot's answer for the committed endpoint, not the pre-boot list the
    // open dialog had seeded — and boot spent exactly one lookup on it.
    expect(publishedCatalogue()).toEqual(['', 'm2']);
    expect(modelCalls(calls)).toHaveLength(2);
});

it('re-asks for the catalogue when only the API key moved before Apply', async () => {
    // M2. A catalogue answers for a (Base URL, API key) PAIR, not for a URL: a blank key on the
    // configured origin means the SERVER's key (../shared/harness-api.ts `RunnerSettingsInput`), so
    // the key-less list boot published is NOT an answer for the credentialed endpoint. Applying a
    // typed key INSIDE the 500ms debounce window is the case that used to end the load with the
    // wrong list published and no corrective request, because both halves of the check were
    // URL-only.
    localStorage.setItem(SETTINGS_KEY, '{"baseURL":"http://provider/v1","apiKey":"","model":"m1"}');
    const calls = stub(
        scriptedModels([
            // boot's committed read for (http://provider/v1, '').
            { ids: ['m1', 'm2'] },
            // the corrective read `Apply` arms for (http://provider/v1, 'sk-test').
            { ids: ['k1', 'k2'] }
        ])
    );
    await boot();

    // The app-wide starting point: the key-less answer for the stored URL.
    expect(publishedCatalogue()).toEqual(['', 'm2']);

    openSettings();
    const [, apiKey] = [
        ...document.querySelectorAll<HTMLInputElement>('.dialog label.field > input.field-input')
    ];

    apiKey.value = 'sk-test';
    apiKey.dispatchEvent(new Event('input', { bubbles: true }));

    // Pressed before the debounce can fire, so the list on screen is still the KEY-LESS answer for
    // the same URL. The pending preview is dropped by the close, which is what makes the request
    // count below exact.
    applyButton().click();

    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', 'sk-test', 'm1'));
    expect(document.querySelector('.dialog')).toBeNull();

    // The key-only change moved the identity, so exactly one corrective lookup is armed — and it
    // carries the credential that was just committed, which is the whole point of tracking it.
    const refreshes = modelCalls(calls);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]?.body).toEqual({
        settings: { base_url: 'http://provider/v1', api_key: 'sk-test' }
    });

    await pastDebounce();

    // The load ends with the catalogue fetched under the committed credential, published into the
    // per-agent dropdowns.
    expect(publishedCatalogue()).toEqual(['', 'k1', 'k2']);
});

it('commits the model the dropdown displays when the stored model is blank', async () => {
    // The one way a blank model still exists: a record written by the previous UI's manual input
    // (./main.ts `loadSettings` passes `""` straight through). The control can no longer produce
    // it, so the control must not be allowed to keep it by silently APPLYING it.
    localStorage.setItem(SETTINGS_KEY, '{"baseURL":"http://provider/v1","apiKey":"","model":""}');
    const calls = stub();
    await boot();
    openSettings();

    // No extra option was invented for the blank case — no `Server default`, no blank entry: the
    // ids come from the endpoint, and the first advertised id is what the control shows.
    expect(modelOptions()).toEqual([
        ['m1', 'm1', false],
        ['m2', 'm2', false]
    ]);
    expect(modelSelect().value).toBe('m1');
    expect(modelSelect().disabled).toBe(false);

    // The draft moved onto the displayed id WITHOUT persisting: `Apply` is still the only writer,
    // so the stored bytes are exactly what they were before the open.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', ''));

    applyButton().click();

    // AC3: what the control displayed is what the record now holds. Before this, `Apply` wrote
    // `""` while the dropdown named `m1` — and re-picking `m1` was no `change` event, so the
    // reader had no way to fix it.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    expect(document.querySelector('.dialog')).toBeNull();

    // The blank is gone from the record, so a reopen shows the same id and no second write.
    openSettings();
    expect(modelSelect().value).toBe('m1');
    byClass('.dialog-close', 'button').click();

    expect(modelCalls(calls)).toHaveLength(1);
});

it('commits from Enter in a text field, exactly once', async () => {
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();

    // `Enter` in the harness server URL is the same commit as the button: the body is a plain
    // `div` (no `<form>`), so the browser would otherwise do nothing at all. The reload count is
    // the exact-once proof — a double fire would reload twice.
    const root = serverRootInput();
    root.value = 'https://harness.example.test/v1/harness';
    root.dispatchEvent(new Event('input', { bubbles: true }));

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    root.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(navigation.reloads()).toBe(1);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBe('https://harness.example.test/v1/harness');

    await pastDebounce();
});

it('commits a provider edit from Enter in the Base URL field without reloading', async () => {
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');

    baseURL.value = 'http://entered/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    // A keystroke alone persists nothing (the draft), so the byte string below is the proof that
    // it was the keypress — and only the keypress — that committed.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    baseURL.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://entered/v1', '', 'm1'));
    expect(navigation.reloads()).toBe(0);
    expect(document.querySelector('.dialog')).toBeNull();

    // Every other key is still just typing: the layer is open afterwards and the draft is all the
    // key moved, so this handler cannot swallow an ordinary character or a caret.
    openSettings();
    const second = byClass('.dialog label.field > input.field-input', 'input');
    second.value = 'http://typed-not-entered/v1';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));

    expect(document.querySelector('.dialog')).not.toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://entered/v1', '', 'm1'));

    byClass('.dialog-close', 'button').click();
    await pastDebounce();
});

it('ignores the Enter that confirms an input-method candidate', async () => {
    // M3: `commitFromEnter` carries the same composition guard the composer's Enter-to-send policy
    // does (./main.ts, and the IME rule documented above that handler). The candidate-confirming
    // Enter belongs to the input method, so here it must neither commit the draft nor be prevented
    // — otherwise a keystroke the reader never meant as a commit persists a half-typed value and
    // closes the layer while the field still holds the unconfirmed composition buffer.
    stub();
    await boot();
    openSettings();

    const navigation = stubNavigation();
    const baseURL = byClass('.dialog label.field > input.field-input', 'input');

    baseURL.value = 'http://composing/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    const composing = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true
    });
    baseURL.dispatchEvent(composing);

    // Nothing committed, nothing closed, and the input method still owns the event.
    expect(composing.defaultPrevented).toBe(false);
    expect(document.querySelector('.dialog')).not.toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    expect(navigation.reloads()).toBe(0);

    // Older engines only report the legacy marker (keyCode 229): same outcome.
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    baseURL.dispatchEvent(legacy);

    expect(legacy.defaultPrevented).toBe(false);
    expect(document.querySelector('.dialog')).not.toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));
    expect(navigation.reloads()).toBe(0);

    // A real Enter is still the commit, so the guard did not swallow the gesture it guards.
    baseURL.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://composing/v1', '', 'm1'));
    expect(document.querySelector('.dialog')).toBeNull();

    await pastDebounce();
});

it('leaves what the reader is typing when the bootstrap lands with the dialog open', async () => {
    // F4: the status pill is enabled BEFORE the bootstrap resolves, so the dialog can genuinely
    // be open when `applyDefaults` runs. The `/api` document is delayed so the reader can get a
    // field typed inside that window; the server default is a DIFFERENT url from what they typed,
    // which is what makes a re-sync visible.
    const bootDocument = delayedJson(bootstrap(), 500);

    stub((url) => (url === '/api' ? bootDocument : undefined));
    const loaded = import('./main');

    // The module body is what builds the shell and starts `boot()`, so wait for the trigger to
    // exist rather than guessing a duration — and the document is still 0.5s away when it does.
    for (let attempt = 0; attempt < 60 && document.querySelector('.status-button') === null; attempt += 1) {
        await wait(25);
    }

    openSettings();

    const baseURL = byClass('.dialog label.field > input.field-input', 'input');

    // The proof the layer really is INSIDE the bootstrap window: the field still names the
    // module-load default, i.e. the server defaults have not landed (and not been re-synced) yet.
    expect(baseURL.value).toBe('http://localhost:5500/providers/private/v1');

    baseURL.value = 'http://typed-during-boot/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    await loaded;

    // Wait for the delayed document to land and `applyDefaults` to have run — it writes the
    // server bytes synchronously — instead of guessing how long the bootstrap takes.
    for (let attempt = 0; attempt < 60 && localStorage.getItem(SETTINGS_KEY) === null; attempt += 1) {
        await wait(25);
    }
    await flush();

    // The layer is still open, the field still holds the typed value, and the caret position is
    // untouched — before this, `applyDefaults` re-based the draft and rewrote every control,
    // deleting the edit while naming the SERVER's bytes in storage.
    expect(byClass('.dialog', 'div')).not.toBeNull();
    expect(baseURL.value).toBe('http://typed-during-boot/v1');

    // R4 still holds on the other side: the bytes that landed in storage are the SERVER defaults,
    // not the uncommitted draft. The next open re-bases from them, exactly as a dismissal does.
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storedSettings('http://provider/v1', '', 'm1'));

    closeWithEscape();

    // And the reopen does re-base: the typed edit is gone, as it is after any dismissal.
    openSettings();
    expect(byClass('.dialog label.field > input.field-input', 'input').value).toBe('http://provider/v1');
    byClass('.dialog-close', 'button').click();

    await pastDebounce();
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

    // The action footer: ONE right-aligned button under the fields it commits, with the
    // sheet's standard action spacing, separated from the form by the same hairline the
    // agent dialog uses, and no wrapping surprises at the dialog's
    // `min-width: min(440px, 100%)`. Absolute positioning would need a positioned ancestor
    // and would overlap the model status line.
    const actions = blockOf('.endpoint-actions {');
    expect(actions).toContain('display: flex');
    expect(actions).toContain('justify-content: flex-end');
    expect(actions).toContain('gap: 8px');
    expect(actions).toContain('margin-top: 4px');
    expect(actions).toContain('padding-top: 12px');
    expect(actions).toContain('border-top: 1px solid var(--border)');
    expect(actions).not.toContain('position:');

    // The disclosure vocabulary is gone from every layer of the sheet.
    for (const dead of ['.endpoint {', '.endpoint-summary', '.endpoint[open]']) {
        expect(rules).not.toContain(dead);
    }
    expect(css).not.toContain('▸');
    // The generic marker reset stays for the `<details>` surfaces that remain (tools).
    expect(rules).toMatch(/^summary \{\s*list-style: none;\s*\}/m);
});

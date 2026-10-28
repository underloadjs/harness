// The harness UI.
//
// This file is a *client*. It loads the server catalogue (bootstrap or the
// standalone routes), creates and selects server sessions, submits tasks, and
// renders the transcript the server owns. It deliberately imports nothing from
// `@underload/harness`: the CLI can run every preset without a browser, and the
// browser can only reach the loop through the server.
//
// Authoritative transcript (H4): the server records one SessionTurn per submit
// and returns the turn list from GET /sessions, GET /sessions/:id and every
// terminal stream frame. The browser never invents a turn boundary and never
// deletes a session because a settings draft changed — it renders the latest
// snapshot and keeps no conversation state of its own. Only presentation is
// local: which tile is expanded, which session id was last viewed, the request
// spinner.
//
// API root: `./api.ts` resolves it at runtime (?apiRoot → injected config →
// build-time VITE_HARNESS_API → /api) and `loadBootstrap` works against the
// canonical `/v1/harness` root document or the standalone `/api` routes.

import './styles.css';
import type {
    HarnessDescriptor,
    RunnerSettings,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn,
    ToolDescriptor
} from '../../server/protocol';
import {
    API_ROOT,
    callTool,
    cancelSession,
    createSession,
    getSession,
    listProviderModels,
    listSessions,
    loadBootstrap,
    resetSession,
    submitMessage
} from './api';
import type { HarnessBootstrap } from './api';
import { highlightCode, looksLikeJson, prettyJson } from './ui/markdown';
import { createTurnBoard } from './ui/turns';
import type { TurnHandle } from './ui/turns';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'underload-harness-app:settings';

const DEFAULT_SETTINGS: RunnerSettings = {
    baseURL: 'http://localhost:5500/providers/private/v1',
    apiKey: '',
    model: 'merge/ds4-flash'
};

let hasStoredSettings = false;

const loadSettings = (): RunnerSettings => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return { ...DEFAULT_SETTINGS };

        hasStoredSettings = true;
        const parsed = JSON.parse(raw) as Partial<RunnerSettings>;

        return {
            baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : DEFAULT_SETTINGS.baseURL,
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_SETTINGS.apiKey,
            model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_SETTINGS.model
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
};

const settings = loadSettings();

const saveSettings = (): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Private browsing and blocked storage are not worth a dialog here.
    }
};

// UI preference only: which server session this browser looked at last. The
// conversation itself is never stored here — the id is a pointer the server
// answers for, and an id from a previous server process simply 404s and is
// forgotten.
const SESSION_KEY = 'underload-harness-app:session';

const loadRememberedSession = (): string | undefined => {
    try {
        const value = localStorage.getItem(SESSION_KEY);
        return value !== null && value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
};

const rememberSession = (id: string): void => {
    try {
        localStorage.setItem(SESSION_KEY, id);
    } catch {
        // Private browsing and blocked storage are not worth a dialog here.
    }
};

const forgetRememberedSession = (): void => {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch {
        // See above.
    }
};

// ---------------------------------------------------------------------------
// One view per harness
// ---------------------------------------------------------------------------
//
// Each view owns one turn board: the tiles are per preset, so switching presets
// never destroys a conversation you wanted to compare against. The conversation
// itself lives on the server; this map only remembers which session belongs to
// which card.

type View = {
    pane: HTMLElement;
    // Start a new user turn and return its handle. Called by `run()` *before* the
    // session exists, so the tile can show "queued → waiting → streaming" as the
    // request actually progresses rather than appearing only once text arrives.
    begin: (prompt: string) => TurnHandle;
    clear: () => void;
    notice: (text: string, tone?: 'info' | 'error') => void;
    setTranscript: (text: string) => void;
    // Replace the whole transcript with the server's turns. Used on boot, on
    // session selection, while polling a running session, and on the terminal
    // stream frame — the server record always wins over local projection.
    hydrate: (turns: readonly SessionTurn[], model?: string, keep?: string) => TurnHandle[];
    // Look up a tile by the server turn id carried on a stream `event` frame.
    turn: (id: string) => TurnHandle | undefined;
};

const createView = (descriptor: HarnessDescriptor): View => {
    const pane = el('div', 'pane');
    const logWrap = el('div', 'log-wrap');

    const empty = el('div', 'empty');
    empty.append(
        el('h2', 'empty-title', descriptor.title),
        el('p', 'empty-text', descriptor.description),
        el('p', 'empty-hint', 'Send a task below. The harness server runs it and streams every progress event back here.')
    );

    // One tile per user turn. The board owns expansion state (exactly one tile
    // open, newest auto-opened) and keeps every tile's DOM, so reading an older
    // turn is never interrupted by deltas arriving for a newer one.
    const board = createTurnBoard({ empty });

    const log = el('div', 'log');
    log.append(board.element);

    const details = el('details', 'transcript');
    details.append(el('summary', 'transcript-summary', 'Entry agent transcript (session.messages)'));
    const transcriptBody = el('pre', 'transcript-body', '[]');
    details.append(transcriptBody);

    logWrap.append(log);
    pane.append(logWrap, details);

    // Only follow the stream when the reader has not scrolled away from the
    // bottom. Reading history while a run streams is a legitimate thing to do.
    const pinned = (): boolean => logWrap.scrollTop + logWrap.clientHeight >= logWrap.scrollHeight - 48;

    const stick = (follow: boolean): void => {
        if (follow) logWrap.scrollTop = logWrap.scrollHeight;
    };

    return {
        pane,
        begin: (prompt) => {
            const turn = board.begin(prompt);
            // A new turn is the one thing that always scrolls: the user just
            // submitted it.
            stick(true);
            return turn;
        },
        clear: () => {
            board.clear();
            logWrap.scrollTop = 0;
        },
        notice: (text, tone) => {
            board.notice(text, tone);
            stick(true);
        },
        setTranscript: (text) => {
            transcriptBody.textContent = text;
        },
        hydrate: (turns, model, keep) => {
            const follow = pinned();
            const handles = board.hydrate(turns, {
                ...(model === undefined ? {} : { model }),
                ...(keep === undefined ? {} : { keep })
            });
            stick(follow);
            return handles;
        },
        turn: (id) => board.find(id)
    };
};


// ---------------------------------------------------------------------------
// Direct tool calls
// ---------------------------------------------------------------------------
//
// The Tools tab exercises the other entry point of `tool()`: calling it as a
// function, with no harness, no agent, and no loop. The server runs the exact
// implementation a session registers, so package presets work here too.

// A few tools deserve a real starting value rather than a schema-derived blank.
const EXAMPLES: Readonly<Record<string, unknown>> = {
    javascriptSyntax: 'const answer = 42;\nconsole.log(answer);',
    pythonSyntax: 'def add(a, b):\n    return a + b',
    readFile: 'package.json',
    writeFile: { path: 'notes/hello.txt', content: 'hello from the harness UI\n' },
    listFiles: '.',
    runCommand: { command: 'git status --short' },
    clock: 'UTC',
    wordCount: 'The harness finds tools by tag before it uses them.',
    roll: 6,
    searchNotes: 'tool loop',
    summarize: 'The harness runs tools until the model answers with text.',
    // The server owns the provider key; the runner only needs a valid query. The
    // exact key is never part of this value.
    websearch: { query: 'harness tool discovery', maxResults: 5 }
};

// The single-property rule, mirrored for the UI: a one-property schema means the
// textarea holds that property's value, not a wrapper object.
const singleProperty = (parameters: Record<string, unknown> | undefined): string | undefined => {
    if (!parameters || parameters.type !== 'object') return undefined;

    const properties = parameters.properties;
    if (!properties || typeof properties !== 'object') return undefined;

    const keys = Object.keys(properties as Record<string, unknown>);
    return keys.length === 1 ? keys[0] : undefined;
};

const placeholderFor = (schema: Record<string, unknown> | undefined): unknown => {
    switch (schema?.type) {
        case 'string':
            return '';
        case 'number':
        case 'integer':
            return 0;
        case 'boolean':
            return false;
        case 'array':
            return [];
        case 'object':
            return {};
        default:
            return null;
    }
};

const templateFor = (parameters: Record<string, unknown> | undefined): string => {
    if (!parameters || parameters.type !== 'object') return '{}';

    const properties = (parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
    const keys = Object.keys(properties);

    if (keys.length === 0) return '{}';
    if (keys.length === 1) return JSON.stringify(placeholderFor(properties[keys[0]]));

    const value: Record<string, unknown> = {};
    for (const key of keys) value[key] = placeholderFor(properties[key]);

    return JSON.stringify(value, null, 2);
};

type ToolRunner = {
    pane: HTMLElement;
    show: (entry: ToolDescriptor) => void;
};

const createToolRunner = (): ToolRunner => {
    const pane = el('div', 'pane');
    const wrap = el('div', 'log-wrap');
    const log = el('div', 'log');
    const card = el('section', 'tool-card');

    const note = el(
        'p',
        'tool-note',
        'Direct call — no harness, no agent, no tool loop. This is the same implementation a session registers, invoked as a function.'
    );
    const safetyNote = el(
        'p',
        'tool-note is-warning',
        'This runs on the harness server with the server process permissions. The file and command presets are not sandboxed.'
    );

    // Credential-dependent tools stay listed when the server has no key. This is
    // the server's own hint (variable names only, never values), so the runner
    // never invents a configuration message the server does not agree with.
    const availabilityNote = el('p', 'tool-note is-warning', '');
    availabilityNote.hidden = true;

    const schema = el('details', 'transcript');
    schema.append(el('summary', 'transcript-summary', 'Parameter schema'));
    const schemaBody = el('pre', 'transcript-body', '{}');
    schema.append(schemaBody);

    const argsField = el('label', 'field');
    argsField.append(el('span', 'field-label', 'Arguments (JSON)'));
    const args = el('textarea', 'composer-input tool-args');
    args.rows = 5;
    args.spellcheck = false;
    argsField.append(args);

    const rule = el('p', 'field-hint', '');

    const callButton = el('button', 'button primary', 'Call tool');
    callButton.type = 'button';
    const actions = el('div', 'composer-actions');
    actions.append(callButton);

    const output = el('div', 'card tool-output');
    const outputHead = el('div', 'card-head', 'result');
    const outputBody = el('pre', 'card-body', '');
    output.append(outputHead, outputBody);

    card.append(note, safetyNote, availabilityNote, schema, argsField, rule, actions, output);
    log.append(card);
    wrap.append(log);
    pane.append(wrap);

    let active: ToolDescriptor | undefined;

    // Direct-call results get the same treatment as tool results inside a turn:
    // pretty-printed JSON when it parses, escaped+highlighted otherwise. The
    // markup comes from `highlightCode`, which escapes its input, so assigning it
    // to `innerHTML` cannot execute anything.
    const setOutput = (text: string, isError: boolean): void => {
        outputHead.textContent = isError ? 'error' : 'result';
        output.className = isError ? 'card tool-output is-error' : 'card tool-output';
        outputBody.innerHTML = highlightCode(prettyJson(text), looksLikeJson(text) ? 'json' : undefined);
        outputBody.dataset.language = looksLikeJson(text) ? 'json' : 'text';
    };

    callButton.addEventListener('click', async () => {
        // The button is disabled for an unconfigured entry; this guard keeps a
        // programmatic click (or a stale handler) from asking a server that has
        // already answered "no credential".
        if (active === undefined || active.availability?.state === 'unconfigured') return;

        let parameters: unknown;
        try {
            parameters = args.value.trim().length === 0 ? {} : JSON.parse(args.value);
        } catch (error) {
            setOutput(`Arguments are not valid JSON: ${messageOf(error)}`, true);
            return;
        }

        callButton.disabled = true;
        setOutput('running…', false);

        try {
            const response = await callTool(active.name, parameters);

            if (!response.ok) {
                setOutput(response.error.message, true);
                return;
            }

            const rendered =
                response.result === undefined
                    ? 'undefined'
                    : (JSON.stringify(response.result, null, 2) ?? String(response.result));

            setOutput(rendered, false);
            outputHead.textContent = `result · ${response.durationMs}ms`;
        } catch (error) {
            setOutput(messageOf(error), true);
        } finally {
            // The early guard returned for an unconfigured entry, so reaching here
            // means the tool is callable and the button may be offered again.
            callButton.disabled = false;
        }
    });

    return {
        pane,
        show: (entry) => {
            active = entry;

            const single = singleProperty(entry.parameters);
            const properties = entry.parameters.properties;
            const count = properties && typeof properties === 'object' ? Object.keys(properties).length : 0;
            // 'unconfigured' is the server's answer that the tool exists but has
            // no credential. Listing it is the point; calling it is not offered.
            const unavailable = entry.availability?.state === 'unconfigured';

            schemaBody.textContent = JSON.stringify(entry.parameters, null, 2);

            args.value = Object.prototype.hasOwnProperty.call(EXAMPLES, entry.name)
                ? JSON.stringify(EXAMPLES[entry.name], null, 2)
                : templateFor(entry.parameters);

            rule.textContent =
                single !== undefined
                    ? `Single-property rule: execute receives the value of "${single}", so this textarea holds that value (JSON), not a wrapper object.`
                    : count === 0
                      ? 'This schema declares no properties, so execute receives an empty object.'
                      : `execute receives the whole object, because the schema declares ${count} properties.`;

            availabilityNote.textContent = entry.availability?.hint ?? '';
            availabilityNote.hidden = !unavailable;
            callButton.disabled = unavailable;
            args.disabled = unavailable;

            setOutput(
                // The full hint is already rendered above the schema; repeating a
                // paragraph in the result box would just be noise.
                unavailable ? 'Not configured on this server.' : 'Nothing yet. Press “Call tool”.',
                unavailable
            );
            outputHead.textContent = unavailable ? 'unconfigured' : 'result';
        }
    };
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('The harness UI needs an #app element.');

const topbar = el('header', 'topbar');
const brand = el('div', 'brand');
brand.append(
    el('span', 'brand-mark', '◍'),
    el('span', 'brand-name', '@underload/harness'),
    el('span', 'brand-sub', 'harness ui')
);

// The status pill is the app's single live region: it announces the request
// lifecycle (connecting → session → waiting → streaming → done/error) to screen
// readers and shows a spinner on screen. Text *and* movement carry the state, so
// colour is never the only signal.
const statusPill = el('span', 'status');
statusPill.dataset.state = 'idle';
statusPill.setAttribute('role', 'status');
statusPill.setAttribute('aria-live', 'polite');
statusPill.setAttribute('aria-atomic', 'true');

const statusDot = el('span', 'status-dot');
statusDot.setAttribute('aria-hidden', 'true');
const statusText = el('span', 'status-text', 'idle');
statusPill.append(statusDot, statusText);
topbar.append(brand, statusPill);

const layout = el('div', 'layout');

const sidebar = el('aside', 'sidebar');

// Two catalogues, one sidebar: harness presets (the loop), and the tools
// themselves (direct calls, no harness).
const modeSwitch = el('div', 'modes');
const harnessMode = el('button', 'mode', 'Harnesses');
harnessMode.type = 'button';
harnessMode.setAttribute('aria-pressed', 'true');
const toolsMode = el('button', 'mode', 'Tools');
toolsMode.type = 'button';
toolsMode.setAttribute('aria-pressed', 'false');
modeSwitch.append(harnessMode, toolsMode);

const presetList = el('div', 'presets');
const toolList = el('div', 'tool-list');
toolList.hidden = true;

// --- session directory -----------------------------------------------------
//
// The server owns sessions; this list is a view of GET /sessions. Selecting an
// entry loads that session's snapshot, which is how a reload, a second tab or
// the CLI's conversation becomes visible in this UI. "New" is an explicit action
// that forgets the current pointer (it never deletes server state).
const sessionsSection = el('section', 'sessions');
const sessionsActions = el('div', 'sessions-actions');

const newSessionButton = el('button', 'button small', 'New session');
newSessionButton.type = 'button';
newSessionButton.disabled = true;

const refreshSessionsButton = el('button', 'button small', 'Refresh');
refreshSessionsButton.type = 'button';
refreshSessionsButton.disabled = true;

sessionsActions.append(newSessionButton, refreshSessionsButton);
const sessionList = el('div', 'session-list');
sessionsSection.append(el('h2', 'sidebar-head', 'Sessions'), sessionsActions, sessionList);

const main = el('main', 'main');
const head = el('div', 'main-head');
const headTitle = el('h1', 'main-title', '');
const headDescription = el('p', 'main-description', '');
const headBadges = el('div', 'badges');
head.append(headTitle, headDescription, headBadges);

const stage = el('div', 'stage');

const composer = el('form', 'composer');
const input = el('textarea', 'input composer-input');
input.rows = 3;
input.placeholder = 'Ask the harness something…  (Enter to run, Shift+Enter for a newline)';
input.spellcheck = false;

const actions = el('div', 'composer-actions');
const runButton = el('button', 'button primary', 'Run');
runButton.type = 'submit';
runButton.disabled = true;
const stopButton = el('button', 'button', 'Stop');
stopButton.type = 'button';
stopButton.disabled = true;
const resetButton = el('button', 'button', 'Reset');
resetButton.type = 'button';
actions.append(runButton, stopButton, resetButton);
composer.append(input, actions);

main.append(head, stage, composer);

const endpoint = el('section', 'endpoint');
endpoint.append(el('h2', 'sidebar-head', 'Endpoint'));

const controls = new Map<keyof RunnerSettings, HTMLInputElement>();

const field = (
    label: string,
    key: keyof RunnerSettings,
    type: string,
    placeholder: string
): HTMLElement => {
    const wrapper = el('label', 'field');
    wrapper.append(el('span', 'field-label', label));

    const control = el('input', 'field-input');
    control.type = type;
    control.value = settings[key];
    control.placeholder = placeholder;
    control.spellcheck = false;
    control.autocomplete = 'off';
    control.addEventListener('input', () => {
        settings[key] = control.value;
        saveSettings();

        // The model catalogue belongs to the provider, so a change to either
        // credential-bearing field invalidates it. Debounced because typing a
        // base URL would otherwise fire one request per keystroke.
        if (key === 'baseURL' || key === 'apiKey') scheduleModelRefresh();
    });

    controls.set(key, control);
    wrapper.append(control);
    return wrapper;
};

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------
//
// A model id is provider data, not a free-form guess: every OpenAI-compatible
// endpoint advertises what it serves at GET {baseURL}/models. The dropdown is
// populated from that list by the harness server (it owns the credentials and
// the browser is not allowed near them), and refreshed whenever the base URL or
// key changes.
//
// The manual input is the fallback for a provider that does not implement the
// endpoint: the dropdown then shows the current model plus "Custom model…", the
// input opens automatically, and a session still works. Nothing here ever
// renders or logs the API key.

const CUSTOM_MODEL = '__custom__';
const MODEL_REFRESH_DELAY_MS = 500;

const modelSelect = el('select', 'field-input field-select');
const modelManual = el('input', 'field-input model-manual');
modelManual.type = 'text';
modelManual.placeholder = 'model id';
modelManual.spellcheck = false;
modelManual.autocomplete = 'off';
modelManual.hidden = true;

const modelStatus = el('p', 'field-hint', 'Model list not loaded yet.');

// Ids from the last successful lookup, in provider order.
let modelIds: readonly string[] = [];
let modelLoading = false;
// True whenever the dropdown cannot express the model (the endpoint failed,
// answered with nothing, or no base URL exists yet). It pins the manual input
// open instead of making the fallback depend on one successful request.
let manualFallback = false;
let refreshTimer: number | undefined;
let modelRequest: AbortController | undefined;
// Monotonic ticket: a superseded response must never paint over a newer one.
let modelTicket = 0;

const setModelStatus = (text: string, isWarning = false): void => {
    modelStatus.textContent = text;
    modelStatus.classList.toggle('is-warning', isWarning);
};

// Keep the dropdown and the manual field consistent with `settings.model`.
const syncModelControls = (): void => {
    modelManual.hidden = !manualFallback && modelSelect.value !== CUSTOM_MODEL;
    // Reflect the stored value without stealing a caret from someone typing.
    if (modelManual.hidden) modelManual.value = settings.model;
    modelSelect.disabled = modelLoading;
};

// Rebuild the option list from the provider catalogue plus the current model.
//
// Order matters:
//   1. the current model first **when it is not in the catalogue**, so a valid
//      selection survives a provider that hides models or a temporary failure;
//   2. every advertised id, in provider order (providers tend to list their
//      preferred model first, so it is preserved rather than sorted);
//   3. an explicit custom entry, which reveals the manual input.
const renderModelOptions = (): void => {
    if (modelLoading) {
        modelSelect.replaceChildren();
        const loading = el('option', undefined, 'Loading models…');
        loading.value = '';
        loading.disabled = true;
        modelSelect.append(loading);
        modelSelect.disabled = true;
        modelManual.hidden = true;
        return;
    }

    const current = settings.model.trim();
    modelSelect.replaceChildren();

    if (current.length > 0 && !modelIds.includes(current)) {
        const option = el('option', undefined, `${current} (current)`);
        option.value = current;
        modelSelect.append(option);
    }

    for (const id of modelIds) {
        const option = el('option', undefined, id);
        option.value = id;
        modelSelect.append(option);
    }

    if (modelIds.length === 0) {
        const empty = el('option', undefined, 'No models loaded');
        empty.value = '';
        empty.disabled = true;
        modelSelect.append(empty);
    }

    const custom = el('option', undefined, 'Custom model…');
    custom.value = CUSTOM_MODEL;
    modelSelect.append(custom);

    // Selecting a listed id requires an option with that value, which exists in
    // both cases above; an empty stored model lands on the custom entry so the
    // manual field is the obvious next step.
    modelSelect.value = current.length > 0 ? current : CUSTOM_MODEL;
    syncModelControls();
};

// Fetch the catalogue for the current settings and render every outcome as a
// state the user can act on: loading, loaded, empty, or failed-with-fallback.
const refreshModels = async (): Promise<void> => {
    const ticket = ++modelTicket;

    // Drop any in-flight request: its answer describes the previous endpoint.
    modelRequest?.abort();
    modelRequest = undefined;

    const baseURL = settings.baseURL.trim();
    const apiKey = settings.apiKey;

    if (baseURL.length === 0) {
        modelIds = [];
        modelLoading = false;
        manualFallback = true;
        renderModelOptions();
        setModelStatus('Set a base URL to load models. Enter a model manually until then.', true);
        return;
    }

    const controller = new AbortController();
    modelRequest = controller;

    modelIds = [];
    modelLoading = true;
    manualFallback = false;
    renderModelOptions();
    setModelStatus(`Loading models from ${baseURL}…`);

    try {
        const ids = await listProviderModels({ baseURL, apiKey }, controller.signal);
        if (ticket !== modelTicket) return;

        modelIds = ids;
        modelLoading = false;
        manualFallback = ids.length === 0;
        renderModelOptions();
        setModelStatus(
            ids.length === 0
                ? 'The provider returned no models. Enter a model manually.'
                : `Loaded ${ids.length} model${ids.length === 1 ? '' : 's'} from ${baseURL}.`,
            ids.length === 0
        );
    } catch (error) {
        if (ticket !== modelTicket) return;

        modelIds = [];
        modelLoading = false;
        manualFallback = true;
        renderModelOptions();
        setModelStatus(`Could not load models: ${messageOf(error)} Enter a model manually.`, true);
    } finally {
        if (ticket === modelTicket) modelRequest = undefined;
    }
};

// Typing in the endpoint fields must not produce one provider request per
// keystroke. 500ms is short enough to feel automatic once a URL is pasted.
const scheduleModelRefresh = (): void => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);

    refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refreshModels();
    }, MODEL_REFRESH_DELAY_MS);
};

modelSelect.addEventListener('change', () => {
    if (modelSelect.value === CUSTOM_MODEL) {
        // Keep the current value as the starting point and let the user type.
        manualFallback = true;
        syncModelControls();
        modelManual.focus();
        return;
    }

    manualFallback = false;
    settings.model = modelSelect.value;
    saveSettings();
    syncModelControls();
});

modelManual.addEventListener('input', () => {
    settings.model = modelManual.value;
    saveSettings();

    // When the typed value is already advertised, mirror it in the dropdown so
    // the two controls cannot disagree; otherwise the dropdown stays on custom.
    modelSelect.value = modelIds.includes(modelManual.value) ? modelManual.value : CUSTOM_MODEL;
});

const modelField = el('div', 'field');
modelField.append(el('span', 'field-label', 'Model'), modelSelect, modelManual, modelStatus);

endpoint.append(
    field('Base URL', 'baseURL', 'text', 'http://localhost:5500/providers/private/v1'),
    field('API key', 'apiKey', 'password', 'optional'),
    modelField,
    el(
        'p',
        'field-hint',
        'Sent to the harness server when a session starts. Leave the key blank to use the key configured on the server. Values are saved in this browser only. The model list is fetched by the server from {base URL}/models.'
    ),
    // Show the resolved root so a deployment question ("is this page talking to
    // /v1/harness or /api?") is answerable without devtools. `?apiRoot=` wins at
    // runtime; this text is the value actually in use.
    el('p', 'field-hint', `API root: ${API_ROOT.length > 0 ? API_ROOT : '(origin)'} · override with ?apiRoot=/v1/harness`)
);

// Initial paint: the stored model is a valid selection even before the server
// answers, so the dropdown must show it rather than an empty control.
renderModelOptions();

sidebar.append(modeSwitch, presetList, toolList, sessionsSection, endpoint);
layout.append(sidebar, main);
app.append(topbar, layout);

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
//
// Each view owns one turn board: the tiles are per preset, so switching presets
// never destroys a conversation you wanted to compare against. The conversation
// itself lives on the server; this map only remembers which session belongs to
// which card, and it is never the source of truth for turn content.

type Instance = {
    descriptor: HarnessDescriptor;
    view: View;
    sessionId?: string;
};

const instances = new Map<string, Instance>();
let current: Instance | undefined;

const ensureInstance = (descriptor: HarnessDescriptor): Instance => {
    const existing = instances.get(descriptor.name);
    if (existing !== undefined) return existing;

    const instance: Instance = { descriptor, view: createView(descriptor) };
    instances.set(descriptor.name, instance);
    return instance;
};

// Create a session only when this card has none. Settings drafts are read here
// and nowhere else: editing the endpoint, model or key afterwards must not
// recreate, replace or delete the conversation the user already has (H4). A new
// session is an explicit "New session" click, and the first submit after it
// creates the server record.
const ensureSession = async (instance: Instance): Promise<string> => {
    if (instance.sessionId !== undefined) return instance.sessionId;

    const session = await createSession(instance.descriptor.name, settings);

    instance.sessionId = session.id;
    rememberSession(session.id);
    upsertSession(session);
    renderSessions();

    return session.id;
};

// ---------------------------------------------------------------------------
// Preset and tool selection
// ---------------------------------------------------------------------------

const buttons = new Map<string, HTMLButtonElement>();
const toolButtons = new Map<string, HTMLButtonElement>();
const runner = createToolRunner();

let currentTool: ToolDescriptor | undefined;
let presetDescriptors: readonly HarnessDescriptor[] = [];

const badge = (text: string): HTMLElement => el('span', 'badge', text);

const select = (instance: Instance): void => {
    current = instance;

    for (const [name, button] of buttons) {
        button.setAttribute('aria-pressed', name === instance.descriptor.name ? 'true' : 'false');
    }

    const descriptor = instance.descriptor;
    headTitle.textContent = descriptor.title;
    headDescription.textContent = descriptor.description;
    headBadges.replaceChildren(
        badge(`agents: ${descriptor.agents.join(', ')}`),
        // Core tools are server-owned (HarnessDescriptor.coreTools): the server
        // knows whether delegate exists from the preset's subagent allowlist, so
        // the UI never hardcodes a core catalogue. The fallback keeps an older
        // server's descriptor renderable.
        badge(`core: ${descriptor.coreTools?.join(', ') ?? 'getTools'}`),
        badge(`catalogue: ${descriptor.tools.length > 0 ? descriptor.tools.join(', ') : 'none'}`),
        badge(descriptor.requiresEndpoint ? 'needs endpoint' : 'offline')
    );

    stage.replaceChildren(instance.view.pane);
    stage.dataset.preset = descriptor.name;
    setStatus('idle');

    // The list highlights whichever row this card is pointed at.
    renderSessions();
};

const selectTool = (entry: ToolDescriptor): void => {
    currentTool = entry;

    for (const [name, button] of toolButtons) {
        button.setAttribute('aria-pressed', name === entry.name ? 'true' : 'false');
    }

    headTitle.textContent = entry.name;
    headDescription.textContent = entry.description;
    headBadges.replaceChildren(
        badge(entry.group),
        badge(`tags: ${entry.tags.join(', ')}`),
        badge(entry.visibility),
        // Only credential-dependent tools carry availability; other entries keep
        // the original three-badge header.
        ...(entry.availability === undefined ? [] : [badge(entry.availability.state)])
    );

    runner.show(entry);
    stage.replaceChildren(runner.pane);
    delete stage.dataset.preset;
    setStatus('idle');
};

const buildPresets = (descriptors: readonly HarnessDescriptor[]): void => {
    presetList.replaceChildren();
    presetDescriptors = descriptors;
    buttons.clear();

    for (const descriptor of descriptors) {
        const button = el('button', 'preset');
        button.type = 'button';
        button.setAttribute('aria-pressed', 'false');
        button.append(
            el('span', 'preset-title', descriptor.title),
            el('span', 'preset-name', descriptor.name),
            el('span', 'preset-meta', descriptor.requiresEndpoint ? 'live' : 'offline · no endpoint')
        );
        button.addEventListener('click', () => select(ensureInstance(descriptor)));

        buttons.set(descriptor.name, button);
        presetList.append(button);
    }
};

const buildTools = (entries: readonly ToolDescriptor[]): void => {
    toolList.replaceChildren();

    let lastGroup = '';

    for (const entry of entries) {
        if (entry.group !== lastGroup) {
            toolList.append(el('div', 'tool-group', entry.group));
            lastGroup = entry.group;
        }

        const button = el('button', 'tool-button');
        button.type = 'button';
        button.setAttribute('aria-pressed', 'false');

        // The sidebar has to answer "is websearch available here?" before a click.
        // The kind text is the existing visibility, with an explicit unconfigured
        // suffix and a data attribute for styling; a configured tool is unchanged.
        const unavailable = entry.availability?.state === 'unconfigured';
        if (unavailable) button.dataset.availability = 'unconfigured';

        button.append(
            el('span', 'tool-name', entry.name),
            el(
                'span',
                'tool-kind',
                unavailable ? `${entry.visibility} · unconfigured` : entry.visibility
            )
        );
        button.addEventListener('click', () => selectTool(entry));

        toolButtons.set(entry.name, button);
        toolList.append(button);
    }
};

const setMode = (next: 'harness' | 'tool'): void => {
    harnessMode.setAttribute('aria-pressed', next === 'harness' ? 'true' : 'false');
    toolsMode.setAttribute('aria-pressed', next === 'tool' ? 'true' : 'false');

    presetList.hidden = next !== 'harness';
    toolList.hidden = next !== 'tool';
    // The session directory belongs to harness runs, not to direct tool calls.
    sessionsSection.hidden = next !== 'harness';
    endpoint.hidden = next !== 'harness';
    composer.hidden = next !== 'harness';

    if (next === 'harness') {
        if (current !== undefined) select(current);
        else if (presetDescriptors.length > 0) select(ensureInstance(presetDescriptors[0]));
    } else if (currentTool !== undefined) {
        selectTool(currentTool);
    }
};

harnessMode.addEventListener('click', () => setMode('harness'));
toolsMode.addEventListener('click', () => setMode('tool'));

// ---------------------------------------------------------------------------
// Session directory (server-owned)
// ---------------------------------------------------------------------------
//
// `sessions` is a cache of the server's answers, not a record: the UI asks again
// on refresh, after every run and while polling a running session, and every
// answer replaces the cache entries it mentions. Local edits never add or remove
// server sessions.

let sessions: SessionSnapshot[] = [];

const upsertSession = (session: SessionSnapshot): void => {
    const index = sessions.findIndex((candidate) => candidate.id === session.id);
    if (index >= 0) sessions[index] = session;
    else sessions.push(session);
};

// Eight characters is the same prefix the server's logs are readable by, and a
// full uuid would not fit the 272px sidebar.
const shortId = (id: string): string => (id.length <= 8 ? id : id.slice(0, 8));

// Rows are buttons: keyboard reachable and self-explanatory with a status text
// and turn count. The active row is marked for styling only — selection is state
// in `current.sessionId`, not in this DOM.
const renderSessions = (): void => {
    sessionList.replaceChildren();

    if (sessions.length === 0) {
        sessionList.append(el('p', 'field-hint', 'No sessions on this server yet. Send a task to create one.'));
        return;
    }

    const activeId = current?.sessionId;

    for (const session of sessions) {
        const row = el('button', 'session');
        row.type = 'button';
        row.dataset.sessionId = session.id;
        row.dataset.status = session.status;
        if (session.id === activeId) row.dataset.active = 'true';

        // `turns.length` is the server's count; the UI does not compute a turn
        // count from event frames (it could disagree after a reload).
        const turns = session.turns.length;
        row.append(
            el('span', 'session-harness', session.harness),
            el('span', 'session-meta', `${session.status} · ${turns} turn${turns === 1 ? '' : 's'} · ${shortId(session.id)}`),
            el('span', 'session-prompt', session.turns.length > 0 ? session.turns[session.turns.length - 1].prompt : 'no turns yet')
        );
        row.title = `${session.harness} · ${session.id}`;

        row.addEventListener('click', () => {
            void openSession(session.id);
        });

        sessionList.append(row);
    }
};

// Re-read the directory. A failure is reported in the status pill; the list on
// screen stays usable (it is the last answer the server gave).
const refreshSessions = async (): Promise<void> => {
    refreshSessionsButton.disabled = true;

    try {
        sessions = await listSessions();
        renderSessions();
    } catch (error) {
        setStatus('error', `session list: ${messageOf(error)}`);
    } finally {
        refreshSessionsButton.disabled = false;
    }
};

// Draw a snapshot into its card. The turns are the authoritative transcript;
// `messages` is the entry agent's own view of the same run and is informational.
const applySnapshot = (instance: Instance, session: SessionSnapshot): void => {
    instance.sessionId = session.id;
    instance.view.hydrate(session.turns, session.model);
    instance.view.setTranscript(JSON.stringify(session.messages, null, 2));
    renderSessions();
};

const descriptorFor = (name: string): HarnessDescriptor | undefined =>
    presetDescriptors.find((candidate) => candidate.name === name);

// ---------------------------------------------------------------------------
// Polling a running session (reload / late attach)
// ---------------------------------------------------------------------------
//
// The stream endpoint is POST-only, so a page that reloaded mid-run cannot
// attach to the live stream. It polls GET /sessions/:id instead: bounded in
// frequency and in total attempts, cleared on every terminal answer, and it
// never POSTs /messages, so it can never start a second model run.

const POLL_INTERVAL_MS = 1_000;
// About two minutes. Long enough for a real run, short enough that a stuck
// session stops asking rather than polling forever.
const POLL_MAX_ATTEMPTS = 120;

let pollTimer: number | undefined;
let pollToken = 0;

const stopPolling = (): void => {
    // The token invalidates an in-flight `getSession` response: a stale answer
    // must not repaint the card after the reader moved to another session.
    pollToken += 1;

    if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer);
        pollTimer = undefined;
    }
};

const pollSession = (instance: Instance, id: string): void => {
    stopPolling();

    const token = pollToken;
    let attempts = 0;

    const tick = async (): Promise<void> => {
        if (token !== pollToken) return;
        // The card was pointed elsewhere (new session, another selection).
        if (instance.sessionId !== id) return;

        attempts += 1;

        let session: SessionSnapshot;
        try {
            session = await getSession(id);
        } catch (error) {
            if (token !== pollToken) return;

            stopPolling();
            setStatus('error', `polling session: ${messageOf(error)}`);
            return;
        }

        if (token !== pollToken) return;

        upsertSession(session);

        if (session.status !== 'running') {
            applySnapshot(instance, session);
            setStatus(session.status === 'error' ? 'error' : 'idle');
            stopPolling();
            return;
        }

        // Still running: render the server snapshot (it wins over whatever the
        // browser projected) and keep the reader's expansion by turn id.
        applySnapshot(instance, session);
        setStatus('running', 'session running · polling server');

        if (attempts >= POLL_MAX_ATTEMPTS) {
            stopPolling();
            setStatus('error', 'stopped polling a long-running session · reload to retry');
            return;
        }

        pollTimer = window.setTimeout(() => {
            void tick();
        }, POLL_INTERVAL_MS);
    };

    pollTimer = window.setTimeout(() => {
        void tick();
    }, POLL_INTERVAL_MS);
};

// Select and render an existing session. Everything drawn here comes from the
// server's snapshot; nothing is reconstructed from browser memory.
const openSession = async (id: string): Promise<void> => {
    stopPolling();

    let session: SessionSnapshot;
    try {
        session = await getSession(id);
    } catch (error) {
        // A remembered id from a previous server process is not an error state
        // the user must fix: forget it and show what the server does have. A
        // stale id in a *row* (someone else's process) must not clear a valid
        // pointer, so only the remembered id is forgotten.
        if (loadRememberedSession() === id) forgetRememberedSession();
        setStatus('error', messageOf(error));
        void refreshSessions();
        return;
    }

    const descriptor = descriptorFor(session.harness);
    if (descriptor === undefined) {
        setStatus('error', `unknown harness "${session.harness}"`);
        return;
    }

    const target = ensureInstance(descriptor);

    // One session, one card: release any other card pointed at this id.
    for (const instance of instances.values()) {
        if (instance !== target && instance.sessionId === id) instance.sessionId = undefined;
    }

    target.sessionId = id;
    select(target);
    applySnapshot(target, session);
    upsertSession(session);
    renderSessions();
    rememberSession(id);

    if (session.status === 'running') {
        setStatus('running', 'session running · polling server');
        pollSession(target, id);
        return;
    }

    setStatus(session.status === 'error' ? 'error' : 'idle', session.status === 'error' ? (session.lastError ?? 'session error') : undefined);
};

// Explicit new conversation: forget the pointer and drop the local projection.
// The previous session stays on the server and in the list — nothing is deleted.
newSessionButton.addEventListener('click', () => {
    const instance = current;
    if (instance === undefined) return;

    if (running) {
        instance.view.notice('cancel the running task before starting a new session');
        return;
    }

    stopPolling();
    instance.sessionId = undefined;
    instance.view.clear();
    instance.view.setTranscript('[]');
    forgetRememberedSession();
    renderSessions();
    setStatus('idle');
    input.focus();
});

refreshSessionsButton.addEventListener('click', () => {
    void refreshSessions();
});

// A polling loop must never outlive the page; a reload re-reads the snapshot.
window.addEventListener('pagehide', () => {
    stopPolling();
});


// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

let running = false;
let controller: AbortController | undefined;
let booted = false;

const setBusy = (value: boolean): void => {
    running = value;
    runButton.disabled = value || !booted;
    stopButton.disabled = !value;
    resetButton.disabled = value;
};

// `state` drives the pill's colour and spinner; `detail` is the human sentence.
//
// States map onto real phases only — no timers invent progress:
//   connecting → opening/loading, `running` → session created / request in
//   flight or streaming, `done` / `error` → terminal.
const setStatus = (state: 'idle' | 'running' | 'done' | 'error' | 'connecting', detail?: string): void => {
    statusPill.dataset.state = state;
    statusText.textContent = detail === undefined ? state : detail;
};

const run = async (): Promise<void> => {
    const prompt = input.value.trim();
    if (running || prompt.length === 0) return;

    const instance = current;
    if (instance === undefined) return;

    if (instance.descriptor.requiresEndpoint && settings.baseURL.trim().length === 0) {
        instance.view.notice('set a base URL in Endpoint, then run again');
        setStatus('error', 'no endpoint configured');
        return;
    }

    // Submitting makes this card live: a background poll for a previously
    // running session must stop doing GETs while a stream owns the tile.
    stopPolling();

    // The turn tile exists before the request does: it is what makes the
    // lifecycle visible instead of the view looking idle until the first token.
    const turn = instance.view.begin(prompt);

    const requestController = new AbortController();

    // Take the request lock *before* `await ensureSession(...)`. Session creation
    // is part of the request, so Run must be disabled (and Enter must be a no-op)
    // for its whole duration — otherwise a double submit creates two sessions.
    controller = requestController;
    input.value = '';
    setBusy(true);

    turn.setState('queued', 'starting session');
    setStatus('connecting', 'creating session');

    let failure: string | undefined;
    let terminal: SessionSnapshot | undefined;
    let sessionId: string | undefined;

    try {
        sessionId = await ensureSession(instance);

        // Stop pressed while the session was being created: nothing has been
        // submitted, so there is no stream to abort — report and leave.
        if (requestController.signal.aborted) {
            turn.setState('cancelled', 'stopped before the request');
            instance.view.notice('run cancelled');
            setStatus('idle', 'cancelled');
            return;
        }

        turn.setState('waiting', 'request sent');
        setStatus('running', 'waiting for server');

        let streaming = false;

        const snapshot = await submitMessage(
            sessionId,
            prompt,
            (item: SessionStreamItem) => {
                // The server opens every stream with its turn record. Binding it
                // gives the optimistic tile the server's id/index, which is what
                // makes the tile a projection of a real record rather than a
                // browser-invented boundary.
                if (item.type === 'turn') {
                    turn.bind(item.turn);
                    return;
                }

                if (item.type === 'event') {
                    // First real event is the honest start of streaming; before
                    // that the request is queued on the server.
                    if (!streaming) {
                        streaming = true;
                        turn.setState('streaming');
                        setStatus('running', 'streaming');
                    }

                    // Explicit routing: the frame names its turn. Look the tile
                    // up by that id; an event for a turn this view does not hold
                    // (another tab's stream, a stale frame) is dropped. The
                    // terminal snapshot reconciles anything missed.
                    const target = instance.view.turn(item.turnId) ?? turn;
                    target.apply(item.event);
                    return;
                }

                // Terminal frames (snapshot | failed) carry the complete session,
                // turns included. This is the frame that makes the server record
                // authoritative for the whole transcript.
                if (item.type === 'snapshot' || item.type === 'failed') {
                    terminal = item.session;
                    instance.view.setTranscript(JSON.stringify(item.session.messages, null, 2));
                }

                if (item.type === 'failed') failure = item.error.message;
            },
            requestController.signal
        );

        // Render the last frame before the tile changes state, so the final text
        // is never one animation frame behind the "done" badge.
        turn.flush();

        // If the reader opened another session in this card while the stream was
        // open, the tiles are detached: writing the terminal snapshot would
        // overwrite the conversation now on screen. The server still recorded the
        // run, so the directory entry is updated from it below.
        const stillShown = instance.sessionId === sessionId;

        // Server snapshot wins. Rebuilding from `turns` replays every recorded
        // event (subagent events included) and drops any transient projection the
        // browser held. A frame without turns (older server) falls back to
        // settling the live tile so nothing is lost.
        if (stillShown && terminal !== undefined && terminal.turns.length > 0) {
            instance.view.hydrate(terminal.turns, terminal.model, turn.id());
        } else if (stillShown && failure !== undefined) {
            turn.setState('error', failure);
        } else if (stillShown) {
            turn.setState('done', `${snapshot.model} · ${snapshot.status}`);
        }

        if (failure !== undefined) {
            setStatus('error', failure);
        } else {
            setStatus('done', `done · ${snapshot.model} · ${snapshot.status}`);
        }

        // Keep the directory row in step with the run that just finished; no
        // extra request is needed because the terminal frame is a full snapshot.
        upsertSession(terminal ?? snapshot);
        if (stillShown) rememberSession(sessionId);
        renderSessions();
    } catch (error) {
        turn.flush();

        if (requestController.signal.aborted) {
            turn.setState('cancelled', 'stopped by user');
            instance.view.notice('run cancelled');
            setStatus('idle', 'cancelled');
            void refreshSessions();
        } else {
            const message = messageOf(error);

            if (message.includes('Unknown session')) {
                // The server restarted (sessions are in memory). Forget the stale
                // pointer so the next run creates a fresh conversation; the
                // session list is re-read to show what actually exists now.
                instance.sessionId = undefined;
                if (instance === current) forgetRememberedSession();
                void refreshSessions();
            }

            turn.setState('error', message);
            instance.view.notice(`run failed: ${message}`, 'error');
            setStatus('error', message);
        }
    } finally {
        if (controller === requestController) controller = undefined;
        setBusy(false);
        turn.flush();
        input.focus();
    }
};

composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void run();
});

input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void run();
    }
});

stopButton.addEventListener('click', () => {
    const active = controller;
    active?.abort();

    // Immediate acknowledgement: aborting the fetch and asking the server to
    // cancel both take a round trip, so the pill says what is happening.
    if (active !== undefined) setStatus('running', 'stopping');

    const instance = current;
    if (instance?.sessionId !== undefined) {
        // The server records the cancellation as the turn's terminal status; the
        // directory row should stop saying "running" once it has.
        void cancelSession(instance.sessionId)
            .catch(() => undefined)
            .finally(() => {
                void refreshSessions();
            });
    }
});

resetButton.addEventListener('click', () => {
    const instance = current;
    if (instance === undefined) return;

    if (running) {
        instance.view.notice('cancel the running task before resetting');
        return;
    }

    const sessionId = instance.sessionId;
    instance.view.clear();
    instance.view.setTranscript('[]');
    setStatus('idle');

    if (sessionId === undefined) return;

    void resetSession(sessionId).then(
        (session) => {
            // The reset answer is a full snapshot with an empty turn list; draw
            // it rather than guessing that clearing locally was equivalent.
            applySnapshot(instance, session);
            upsertSession(session);
            renderSessions();
        },
        (error: unknown) => {
            // The server may have restarted since this card was opened. Forget the
            // stale id so the next run creates a fresh session.
            instance.sessionId = undefined;
            if (instance === current) forgetRememberedSession();
            instance.view.notice(`reset failed: ${messageOf(error)}`);
            setStatus('error', messageOf(error));
            void refreshSessions();
        }
    );
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const applyDefaults = (defaults: HarnessBootstrap['defaults']): void => {
    if (hasStoredSettings) return;

    if (defaults.baseURL.trim().length > 0) settings.baseURL = defaults.baseURL;
    if (defaults.model.trim().length > 0) settings.model = defaults.model;

    for (const [key, control] of controls) {
        control.value = settings[key];
    }

    saveSettings();
};

const showOffline = (message: string): void => {
    const pane = el('div', 'pane');
    const wrap = el('div', 'log-wrap');
    const box = el('div', 'empty');

    box.append(
        el('h2', 'empty-title', 'Harness server unavailable'),
        el('p', 'empty-text', message),
        el(
            'p',
            'empty-hint',
            'Start it with `yarn serve` after `yarn build:playground`, or run `yarn dev:playground` for the dev UI. Then reload.'
        )
    );

    const retry = el('button', 'button primary', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => location.reload());

    const retryActions = el('div', 'composer-actions');
    retryActions.append(retry);
    box.append(retryActions);

    wrap.append(box);
    pane.append(wrap);
    stage.replaceChildren(pane);
};

const boot = async (): Promise<void> => {
    setStatus('connecting');

    try {
        // One bootstrap document on the canonical mount; the standalone `/api`
        // root is a 404, so the client falls back to /harnesses + /tools +
        // /sessions there. Both bring the full session list, which is what makes
        // a reload land on an existing conversation.
        const data = await loadBootstrap();

        applyDefaults(data.defaults);

        // The defaults may have replaced the model, and the stored settings may
        // name a model the provider no longer serves. Rendering first and then
        // fetching keeps the dropdown correct in both cases; the lookup runs in
        // the background so boot is not gated on the provider being reachable.
        renderModelOptions();
        void refreshModels();

        buildPresets(data.presets);
        buildTools(data.tools);

        sessions = data.sessions;
        renderSessions();

        // Catalogue-dependent actions become usable only now.
        refreshSessionsButton.disabled = false;
        newSessionButton.disabled = false;

        if (data.presets.length === 0) {
            showOffline('The server reported no harnesses.');
            setStatus('error', 'no harnesses');
            return;
        }

        booted = true;
        runButton.disabled = false;
        setMode('harness');

        // Resume the last conversation this browser looked at, but only if this
        // server still holds it (sessions are in memory, so a restart loses
        // them). An unknown id is forgotten, not treated as an error.
        const remembered = loadRememberedSession();

        if (remembered !== undefined && sessions.some((session) => session.id === remembered)) {
            await openSession(remembered);
        } else {
            if (remembered !== undefined) forgetRememberedSession();
            setStatus('idle');
        }

        input.focus();
    } catch (error) {
        showOffline(messageOf(error));
        setStatus('error', 'server offline');
    }
};

setMode('harness');
void boot();

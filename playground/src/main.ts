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
// Shell (three columns, R1–R3):
//   - left rail  — harnesses (built-ins and user-created) plus the create form,
//                  and a collapsed endpoint/model panel at the bottom;
//   - centre     — a Chat/Tools tablist. Chat shows the selected harness title,
//                  its agent row (with a per-agent model dropdown), the transcript
//                  and the composer. Tools is the full-width list of EVERY server
//                  tool — core entries included — plus the manual runner; a direct
//                  tool call opens there too;
//   - right rail — the core-tools disclosure, the complete tool catalogue, and
//                  the sessions for the selected harness only.
//
// Agent editing is deliberately scoped to *new* sessions. A saved session carries
// a frozen `harnessDefinition` and frozen effective `agentModels`; the row renders
// those and explains why it is locked, with a New session action. Editing (team or
// model) therefore never rewrites a conversation that is already on screen.
//
// Execution is server-only. A catalogue tool is a direct call; a core tool
// (`sessionBound`) is sent with the selected session's id so requestTools,
// createTool, todoTools and delegate change THAT conversation — and the snapshot is
// re-read afterwards so discoveries/todos show up. The browser never evaluates a
// tool.
//
// Activity: every `HarnessEvent` names an agent, and the live set per instance
// draws a rotating ring on that agent's tile (ui/activity.ts, styles.css). Start
// activates, done/error removes only that agent, and terminal/cancel/reset/switch/
// pagehide clear everything. A hydrated or polled RUNNING turn derives activity
// from its own events; settled history never lights a tile.
//
// Run/cancel is single-flight and instance-scoped: the stop button uses the
// instance that started the run (never "whatever is selected now"), and harness
// switching/editing is disabled while a run is in flight.
//
// API root: `./api.ts` resolves it at runtime (?apiRoot → injected config →
// build-time VITE_HARNESS_API → /api) and `loadBootstrap` works against the
// canonical `/v1/harness` root document or the standalone `/api` routes.

import './styles.css';
import type {
    AgentDescriptor,
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
    createHarness,
    createSession,
    getSession,
    listProviderModels,
    listSessions,
    loadBootstrap,
    resetSession,
    submitMessage,
    updateHarness
} from './api';
import type { HarnessBootstrap } from './api';
import {
    HARNESS_CORE_TOOL_DESCRIPTIONS,
    agentModelsOf,
    agentsFromDescriptors,
    builtinOf,
    canonicalHarnessName,
    coreToolsOf,
    editableOf,
    frameAtOf,
    frozenDefinitionOf,
    membersOf,
    modelsForMembers,
    primaryOf,
    uniqueNames
} from './contract';
import { createCreateHarnessPanel } from './ui/create-harness';
import { createAgentRow } from './ui/agents';
import { applyActivity, activityOfTurns, paintActivity } from './ui/activity';
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
// One transcript view per harness
// ---------------------------------------------------------------------------
//
// Each view owns one turn board: switching harnesses never destroys a
// conversation you wanted to compare against. The conversation itself lives on
// the server; this map only remembers which session belongs to which harness.

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
    // Stop every live timer this view owns (elapsed labels, tool durations).
    dispose: () => void;
};

const createView = (descriptor: HarnessDescriptor): View => {
    const pane = el('div', 'pane');
    const logWrap = el('div', 'log-wrap');

    // The empty state is deliberately short: the agent row above already explains
    // *who* will run, and the old description wall made the centre noisy.
    const empty = el('div', 'empty');
    empty.append(
        el('h2', 'empty-title', descriptor.title),
        el('p', 'empty-text', 'Send a task below to start this harness.'),
        el(
            'p',
            'empty-hint',
            'Tools are discovered inside the chat with requestTools; the catalogue never assigns them.'
        )
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
        turn: (id) => board.find(id),
        dispose: () => board.destroy()
    };
};

// ---------------------------------------------------------------------------
// Direct tool calls
// ---------------------------------------------------------------------------
//
// The Tools catalogue exercises the other entry point of `tool()`: calling it as
// a function, with no harness, no agent, and no loop. The server runs the exact
// implementation a session registers, so package presets work here too.

// A few tools deserve a real starting value rather than a schema-derived blank.
const EXAMPLES: Readonly<Record<string, unknown>> = {
    // Two properties, so the runner sends the whole object (no single-property
    // unwrapping): the language is part of the input, not a separate mode.
    syntaxCheck: { code: 'const answer = 42;\nconsole.log(answer);', language: 'javascript' },
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

// What the runner needs from the shell for a session-bound core tool.
//
// `context` is read at show time and before every call; `ensureSession` creates
// the SELECTED harness's session when none exists yet; `refreshSession` re-reads
// the server snapshot after a call so requestTools discoveries and todo state are
// on screen immediately. None of these live in this module: the runner must not
// own the selection, and it must not guess a session id.
export type ToolRunnerOptions = {
    context: () => { harness?: string; sessionId?: string };
    ensureSession: () => Promise<string | undefined>;
    refreshSession: (sessionId: string) => Promise<void>;
};

type ToolRunner = {
    pane: HTMLElement;
    show: (entry: ToolDescriptor) => void;
    // Repaint the session-context line (selection or session changed underneath
    // an already-open runner).
    sync: () => void;
};

// The cap the server applies to `requestTools` (5). Kept here only to explain
// truncation: the UI never slices the result itself.
const REQUEST_TOOLS_LIMIT = 5;

// Turn a requestTools result into one actionable sentence. The structured result
// is still rendered verbatim above; this line exists because a truncated list is
// useless unless it says how much is missing and what to do next.
const resultHintFor = (name: string, result: unknown): string | undefined => {
    if (name !== 'requestTools' || typeof result !== 'object' || result === null) return undefined;

    const value = result as { truncated?: unknown; remaining?: unknown; enabled?: unknown };

    const remaining =
        typeof value.remaining === 'number' && Number.isFinite(value.remaining) && value.remaining > 0
            ? value.remaining
            : undefined;

    // `truncated` is the explicit flag; `remaining > 0` alone is enough for a
    // server that omits it, because the count is the actionable number.
    if (value.truncated !== true && remaining === undefined) return undefined;

    const enabled = Array.isArray(value.enabled) ? value.enabled.length : undefined;
    const lead =
        enabled === undefined ? undefined : `${enabled} tool${enabled === 1 ? '' : 's'} enabled`;

    if (remaining === undefined) {
        return `${lead === undefined ? 'More tools match' : `${lead}; more tools match`} than the ${REQUEST_TOOLS_LIMIT}-tool limit. Refine the tags to see the rest.`;
    }

    return `${lead === undefined ? '' : `${lead}; `}${remaining} more tool${remaining === 1 ? '' : 's'} match. Refine the tags to see them.`;
};

const createToolRunner = (options: ToolRunnerOptions): ToolRunner => {
    const pane = el('div', 'pane');
    const wrap = el('div', 'log-wrap');
    const log = el('div', 'log');
    const card = el('section', 'tool-card');

    // The introduction changes with the entry: a catalogue tool is a bare
    // function call; a core tool needs a session and mutates that conversation.
    const note = el('p', 'tool-note', '');
    const sessionNote = el('p', 'tool-note tool-session', '');
    sessionNote.hidden = true;
    sessionNote.setAttribute('role', 'note');
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

    // Guidance for a truncated requestTools answer. Separate from the raw result:
    // the structured payload is never rewritten.
    const resultHint = el('p', 'field-hint tool-hint', '');
    resultHint.hidden = true;

    card.append(
        note,
        sessionNote,
        safetyNote,
        availabilityNote,
        schema,
        argsField,
        rule,
        actions,
        output,
        resultHint
    );
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

    // Session context line. Read live so a session created after the runner
    // opened is shown instead of "no session yet", and so a frozen chat reports
    // the session the call will actually use.
    const sync = (): void => {
        if (active?.sessionBound !== true) {
            sessionNote.hidden = true;
            sessionNote.textContent = '';
            return;
        }

        const context = options.context();
        sessionNote.hidden = false;
        sessionNote.dataset.harness = context.harness ?? '';
        if (context.harness === undefined) {
            sessionNote.textContent =
                'Session-bound: select a harness first. This tool executes inside that harness’s session.';
            return;
        }

        sessionNote.textContent =
            context.sessionId === undefined
                ? `Session-bound: runs inside ${context.harness}. No session yet — Call creates one for this harness.`
                : `Session-bound: runs inside ${context.harness} · session ${context.sessionId}.`;
    };

    callButton.addEventListener('click', async () => {
        // The button is disabled for an unconfigured entry; this guard keeps a
        // programmatic click (or a stale handler) from asking a server that has
        // already answered "no credential".
        const entry = active;
        if (entry === undefined || entry.availability?.state === 'unconfigured') return;

        let parameters: unknown;
        try {
            parameters = args.value.trim().length === 0 ? {} : JSON.parse(args.value);
        } catch (error) {
            setOutput(`Arguments are not valid JSON: ${messageOf(error)}`, true);
            return;
        }

        callButton.disabled = true;
        setOutput('running…', false);
        resultHint.hidden = true;

        try {
            // Capture the session id BEFORE any await. If the selection changes
            // while the call is in flight, the request still runs in the session
            // the runner displayed — never in whatever happens to be selected when
            // the response lands.
            let sessionId: string | undefined;
            if (entry.sessionBound === true) {
                sessionId = options.context().sessionId;

                if (sessionId === undefined) {
                    // A manual core call needs a real server session (the tool
                    // mutates discovery/todos/runtime tools). Creating one here is
                    // the documented equivalent of the chat's first submit.
                    setOutput('No session for this harness yet — creating one…', false);
                    try {
                        sessionId = await options.ensureSession();
                    } catch (error) {
                        setOutput(`Could not create a session: ${messageOf(error)}`, true);
                        return;
                    }

                    if (sessionId === undefined) {
                        setOutput(
                            'No harness is selected, so this core tool has no session to run in. Select a harness first.',
                            true
                        );
                        return;
                    }
                }

                sync();
            }

            const response = await callTool(entry.name, parameters, sessionId);

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

            // requestTools caps its answer (5 tools). The raw payload stays; the
            // hint names the remaining count and the next move.
            const hint = resultHintFor(entry.name, response.result);
            resultHint.hidden = hint === undefined;
            resultHint.textContent = hint ?? '';

            // Core calls mutate the session (enabled tools, created tools, todos),
            // so re-read the server's snapshot. A refresh failure must not hide the
            // result that just arrived; the caller's status pill reports it.
            if (entry.sessionBound === true && sessionId !== undefined) {
                try {
                    await options.refreshSession(sessionId);
                } catch {
                    // Deliberately silent here: the tool answer above is the
                    // primary outcome, and main.ts reports refresh trouble.
                }
            }
        } catch (error) {
            // Request-level failures (no session 400, unknown session 404, active
            // run 409, offline) arrive here with the server's own message.
            setOutput(messageOf(error), true);
        } finally {
            // The early guard returned for an unconfigured entry, so reaching here
            // means the tool is callable and the button may be offered again.
            callButton.disabled = false;
            sync();
        }
    });

    return {
        pane,
        sync,
        show: (entry) => {
            active = entry;

            const single = singleProperty(entry.parameters);
            const properties = entry.parameters.properties;
            const count = properties && typeof properties === 'object' ? Object.keys(properties).length : 0;
            // 'unconfigured' is the server's answer that the tool exists but has
            // no credential. Listing it is the point; calling it is not offered.
            const unavailable = entry.availability?.state === 'unconfigured';
            const sessionBound = entry.sessionBound === true;

            note.textContent = sessionBound
                ? 'Core tool — it runs inside the selected session’s harness on the server, so its result changes that conversation.'
                : 'Direct call — no harness, no agent, no tool loop. This is the same implementation a session registers, invoked as a function.';

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
            resultHint.hidden = true;
            resultHint.textContent = '';

            sync();
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

const shell = el('div', 'shell');

// --- left rail: harnesses + endpoint ---------------------------------------
const leftRail = el('aside', 'rail rail-left');
leftRail.setAttribute('aria-label', 'Harnesses');
const harnessHead = el('div', 'rail-head');
const harnessHeading = el('h2', 'rail-title', 'Harnesses');
const createHarnessButton = el('button', 'button small new-harness', '+ New');
createHarnessButton.type = 'button';
createHarnessButton.disabled = true;
createHarnessButton.setAttribute('aria-expanded', 'false');
harnessHead.append(harnessHeading, createHarnessButton);

const harnessList = el('div', 'harness-list');

// Endpoint/model stays reachable but compact: a native disclosure at the bottom
// of the rail, closed until the user needs it. No "needs endpoint" badge clutter.
const endpoint = el('details', 'endpoint');
endpoint.append(el('summary', 'endpoint-summary', 'Endpoint & model'));
const endpointBody = el('div', 'endpoint-body');

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
        // Per-agent model dropdowns are built from this catalogue. Re-render the
        // chrome so an already-open harness (or a boot that opened a remembered
        // session before the provider answered) offers the real ids instead of
        // only inherit/current.
        if (current !== undefined) renderHarnessChrome();
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

endpointBody.append(
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
endpoint.append(endpointBody);

// Initial paint: the stored model is a valid selection even before the server
// answers, so the dropdown must show it rather than an empty control.
renderModelOptions();

// --- centre: view tabs, harness head, agent row, transcript, composer ------
const center = el('main', 'center');

// Chat / Tools are real tabs (role="tablist"), not a mode switch hidden in the
// catalogue: the user asked for an obvious Tools tab, and it has to be reachable
// without discovering the right rail. One panel (`stage`) is shared because both
// views replace the same centre column; `aria-labelledby` names whichever tab is
// selected.
const tabs = el('div', 'tabs');
tabs.setAttribute('role', 'tablist');
tabs.setAttribute('aria-label', 'Harness views');

const chatTab = el('button', 'tab', 'Chat');
chatTab.type = 'button';
chatTab.id = 'harness-tab-chat';
chatTab.setAttribute('role', 'tab');
chatTab.setAttribute('aria-selected', 'true');
chatTab.setAttribute('aria-controls', 'harness-tabpanel');
chatTab.tabIndex = 0;

const toolsTab = el('button', 'tab', 'Tools');
toolsTab.type = 'button';
toolsTab.id = 'harness-tab-tools';
toolsTab.setAttribute('role', 'tab');
toolsTab.setAttribute('aria-selected', 'false');
toolsTab.setAttribute('aria-controls', 'harness-tabpanel');
toolsTab.tabIndex = -1;

tabs.append(chatTab, toolsTab);

const mainHead = el('header', 'harness-head');
const titleRow = el('div', 'harness-title-row');
const headTitle = el('h1', 'main-title', '');
const headName = el('span', 'harness-id', '');
titleRow.append(headTitle, headName);
const headNote = el('p', 'harness-note', '');
mainHead.append(titleRow, headNote);

const agentSlot = el('div', 'agent-slot');

const stage = el('div', 'stage');
stage.id = 'harness-tabpanel';
stage.setAttribute('role', 'tabpanel');
stage.setAttribute('aria-labelledby', 'harness-tab-chat');

const composer = el('form', 'composer');
const input = el('textarea', 'input composer-input');
input.rows = 3;
input.placeholder = 'Ask the harness something…  (Enter to run, Shift+Enter for a newline)';
input.spellcheck = false;

const actions = el('div', 'composer-actions');
const runButton = el('button', 'button primary run', 'Run');
runButton.type = 'submit';
runButton.disabled = true;
const stopButton = el('button', 'button stop', 'Stop');
stopButton.type = 'button';
stopButton.disabled = true;
const resetButton = el('button', 'button reset', 'Reset');
resetButton.type = 'button';
actions.append(runButton, stopButton, resetButton);
composer.append(input, actions);

center.append(tabs, mainHead, agentSlot, stage, composer);

// --- right rail: core tools, catalogue, sessions ----------------------------
const rightRail = el('aside', 'rail rail-right');
rightRail.setAttribute('aria-label', 'Core tools, tool catalogue and sessions');

const coreSection = el('section', 'rail-section core-section');
const coreDetails = el('details', 'core-tools');
const coreSummary = el('summary', 'core-summary', 'Core tools');
const coreBody = el('div', 'core-body');
const coreHint = el(
    'p',
    'field-hint',
    'Always available in chat. requestTools enables more tools for this session; discovered tools stay enabled for it.'
);
const coreList = el('div', 'core-list');
// Tools requestTools enabled for the selected session, from the server snapshot
// (`discoveredTools`). Kept separate from the core list: these are session state,
// not the harness-owned set, and a core-tool call refreshes the snapshot so this
// line updates without a reload.
const coreDiscovered = el('p', 'core-discovered', '');
coreDiscovered.hidden = true;
coreBody.append(coreHint, coreList, coreDiscovered);
coreDetails.append(coreSummary, coreBody);
coreSection.append(coreDetails);

const catalogueSection = el('section', 'rail-section catalogue-section');
const catalogueHead = el('div', 'rail-head');
const catalogueHeading = el('h2', 'rail-title', 'Tool catalogue');
const catalogueCount = el('span', 'catalogue-count', '0');
catalogueHead.append(catalogueHeading, catalogueCount);
const catalogueHint = el(
    'p',
    'field-hint',
    'Every tool the server can call, core tools included. Nothing is assigned here: chat discovers tools with requestTools by tag.'
);
const toolList = el('div', 'tool-list');
catalogueSection.append(catalogueHead, catalogueHint, toolList);

const sessionsSection = el('section', 'rail-section sessions');
const sessionsHead = el('div', 'rail-head');
const sessionsHeading = el('h2', 'rail-title', 'Sessions');
sessionsHead.append(sessionsHeading);

// The lock is stated in text, not just implied by a filtered list.
const sessionsScope = el('p', 'sessions-scope', 'Locked to the selected harness.');

const sessionsActions = el('div', 'sessions-actions');
const newSessionButton = el('button', 'button small new-session', 'New session');
newSessionButton.type = 'button';
newSessionButton.disabled = true;
const refreshSessionsButton = el('button', 'button small', 'Refresh');
refreshSessionsButton.type = 'button';
refreshSessionsButton.disabled = true;
sessionsActions.append(newSessionButton, refreshSessionsButton);
const sessionList = el('div', 'session-list');
sessionsSection.append(sessionsHead, sessionsScope, sessionsActions, sessionList);

rightRail.append(coreSection, catalogueSection, sessionsSection);
shell.append(leftRail, center, rightRail);
app.append(topbar, shell);

// ---------------------------------------------------------------------------
// Instances and selection state
// ---------------------------------------------------------------------------

type Instance = {
    descriptor: HarnessDescriptor;
    view: View;
    sessionId?: string;
    // The definition the current conversation was created with. When present the
    // agent row renders this and editing is locked, so an updated harness cannot
    // pretend to have changed a chat that is already on screen.
    frozen?: HarnessDescriptor;
    // Effective per-agent models frozen by the server at creation
    // (SessionSnapshot.agentModels). Used only while a saved session is on screen;
    // an editable harness reads its override map from the descriptor.
    sessionModels?: Record<string, string>;
    // The session's settings model: the value the per-agent "inherit" choice names
    // for a frozen chat, and the fallback when a member is absent from the map.
    sessionModel?: string;
    // Tools requestTools enabled for this session (SessionSnapshot.discoveredTools),
    // shown under the core dropdown. Refreshed by the snapshot a core call triggers.
    discovered?: readonly string[];
    // Per-instance live activity set for the tile rings. Never a module global:
    // two harness views must not share who is busy.
    activity: Set<string>;
};

const instances = new Map<string, Instance>();
let current: Instance | undefined;
let selectedName: string | undefined;
let presetDescriptors: readonly HarnessDescriptor[] = [];
let agentLibrary: readonly AgentDescriptor[] = [];
let sessions: SessionSnapshot[] = [];
let currentTool: ToolDescriptor | undefined;
// The complete server catalogue (core entries included) for the Tools tab. Boot
// replaces it from the bootstrap document; the right rail renders the same list.
let toolEntries: readonly ToolDescriptor[] = [];
// Which centre view is showing. The Tools tab is not the catalogue: it is a
// full-width, keyed list of every tool plus the manual runner.
let activeTab: 'chat' | 'tools' = 'chat';

// Single-flight run state. `activeRun` names the instance that owns the stream,
// which is what Stop cancels — never "the harness selected when Stop is pressed".
let running = false;
let booted = false;
let activeRun: { controller: AbortController; instance: Instance } | undefined;
// Guards a double PATCH while an agent edit is in flight.
let savingAgents = false;

// Session context the manual runner needs. `current` is the selected harness (the
// runner is opened from it and never changes the selection); `ensureSession`
// creates that harness's session on demand, exactly like the first chat submit.
const runner = createToolRunner({
    context: () => {
        const instance = current;
        if (instance === undefined) return {};
        return {
            harness: instance.descriptor.name,
            ...(instance.sessionId === undefined ? {} : { sessionId: instance.sessionId })
        };
    },
    ensureSession: async () => {
        const instance = current;
        if (instance === undefined) return undefined;

        return ensureSession(instance);
    },
    refreshSession: async (sessionId) => {
        // Re-read the captured session, not whatever is selected now: a core call
        // changes the session it ran in, and the answer must land there.
        const session = await getSession(sessionId);

        // Find the card that still points at that session. If the reader started a
        // new session (or opened another one) meanwhile, no card owns it: do not
        // re-point one, because that would undo their explicit choice.
        let owner: Instance | undefined;
        for (const instance of instances.values()) {
            if (instance.sessionId === sessionId) {
                owner = instance;
                break;
            }
        }
        if (owner === undefined) return;

        applySnapshot(owner, session);
        rememberSession(session.id);
        runner.sync();
    }
});

let sessionsPollTimer: number | undefined;
let pollToken = 0;

const descriptorFor = (name: string): HarnessDescriptor | undefined =>
    presetDescriptors.find((candidate) => candidate.name === name);

const ensureInstance = (descriptor: HarnessDescriptor): Instance => {
    const existing = instances.get(descriptor.name);
    if (existing !== undefined) {
        // The catalogue can replace a descriptor (PATCH); the session pointer and
        // view survive, but the current configuration is the server's answer.
        existing.descriptor = descriptor;
        return existing;
    }

    const instance: Instance = { descriptor, view: createView(descriptor), activity: new Set<string>() };
    instances.set(descriptor.name, instance);
    return instance;
};

// Replace one descriptor in the catalogue (create or update). The view is kept:
// an edit changes the *next* session, not the transcript already rendered.
const replaceDescriptor = (updated: HarnessDescriptor): void => {
    presetDescriptors = presetDescriptors.some((candidate) => candidate.name === updated.name)
        ? presetDescriptors.map((candidate) => (candidate.name === updated.name ? updated : candidate))
        : [...presetDescriptors, updated];

    const existing = instances.get(updated.name);
    if (existing !== undefined) existing.descriptor = updated;
};

// ---------------------------------------------------------------------------
// Harness rail and centre chrome
// ---------------------------------------------------------------------------

const harnessButtons = new Map<string, HTMLButtonElement>();

// Tab visuals only. Content switching lives in `setTab` (declared with the tool
// runner, because it needs `toolEntries`), so this is safe to call from selection
// and busy-state code without re-entering the runner.
const paintTabs = (): void => {
    const chat = activeTab === 'chat';
    chatTab.setAttribute('aria-selected', chat ? 'true' : 'false');
    toolsTab.setAttribute('aria-selected', chat ? 'false' : 'true');
    chatTab.tabIndex = chat ? 0 : -1;
    toolsTab.tabIndex = chat ? -1 : 0;
    stage.setAttribute('aria-labelledby', chat ? 'harness-tab-chat' : 'harness-tab-tools');
};

// Remove every activity ring. Called on terminal frames, cancel, reset, new
// session, harness switch and pagehide: after those there is no in-flight agent
// in view, and a leftover ring would claim work that is not happening.
const clearActivity = (): void => {
    for (const instance of instances.values()) instance.activity.clear();
    paintActivity(agentSlot, new Set<string>());
};

const harnessMeta = (descriptor: HarnessDescriptor): string => {
    const members = membersOf(descriptor).length;
    const kind = builtinOf(descriptor) ? 'builtin' : 'custom';
    const access = editableOf(descriptor) ? 'editable' : 'read-only';

    return `${kind} · ${members} agent${members === 1 ? '' : 's'} · ${access}`;
};

const selectHarness = (name: string): void => {
    const descriptor = descriptorFor(name);
    if (descriptor === undefined) return;

    // Selecting anything cancels a background poll; a poll must never paint a
    // card the reader has left.
    stopPolling();

    // Switching harness leaves the Tools tab and drops every ring: the activity
    // belonged to the view being left.
    activeTab = 'chat';
    paintTabs();
    clearActivity();

    selectedName = descriptor.name;
    currentTool = undefined;
    current = ensureInstance(descriptor);

    for (const [key, button] of harnessButtons) {
        button.setAttribute('aria-pressed', key === name ? 'true' : 'false');
    }
    for (const button of toolButtons.values()) button.setAttribute('aria-pressed', 'false');
    for (const button of toolTabButtons.values()) button.setAttribute('aria-pressed', 'false');

    agentSlot.hidden = false;
    composer.hidden = false;
    stage.replaceChildren(current.view.pane);
    renderHarnessChrome();
    renderSessions();
    runner.sync();
    setStatus('idle');
};

const buildHarnesses = (): void => {
    harnessList.replaceChildren();
    harnessButtons.clear();

    for (const descriptor of presetDescriptors) {
        const button = el('button', 'harness-item');
        button.type = 'button';
        button.dataset.harness = descriptor.name;
        button.setAttribute('aria-pressed', selectedName === descriptor.name ? 'true' : 'false');
        button.disabled = running;
        // The description is available on hover/focus without becoming a wall of
        // prose in the centre column.
        button.title = descriptor.description;

        button.append(
            el('span', 'harness-title', descriptor.title),
            el('span', 'harness-name', descriptor.name),
            el('span', 'harness-meta', harnessMeta(descriptor))
        );

        button.addEventListener('click', () => {
            if (running) return;
            selectHarness(descriptor.name);
        });

        harnessButtons.set(descriptor.name, button);
        harnessList.append(button);
    }

    if (presetDescriptors.length === 0) {
        harnessList.append(el('p', 'field-hint', 'No harnesses reported by the server yet.'));
    }
};

// Rebuild the header, agent row and core-tool list from the instance's current
// (or frozen) definition. Called after every server-confirmed change and on
// snapshot hydration.
const renderHarnessChrome = (): void => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;

    // The right-rail core section always describes the SELECTED harness — it is
    // visible while the Tools tab owns the centre, and a snapshot refreshed by a
    // manual core call must update its "enabled for this session" line there.
    renderCoreTools(display, membersOf(display).length, instance.discovered);

    // While a tool runner owns the centre, the head/agent row belong to the tool;
    // do not overwrite them.
    if (currentTool !== undefined) return;

    const locked = instance.sessionId !== undefined;

    headTitle.textContent = display.title;
    headName.textContent = display.name;
    headNote.textContent = locked
        ? instance.frozen !== undefined
            ? 'Viewing a saved session · agent team frozen'
            : 'Viewing a saved session'
        : editableOf(display)
          ? 'Edits apply to new sessions'
          : 'Read-only harness';

    // A locked session renders the definition it started with; the live harness
    // may already have moved on.
    agentSlot.replaceChildren(renderAgents(instance));
};

const renderAgents = (instance: Instance): HTMLElement => {
    const display = instance.frozen ?? instance.descriptor;
    const members = membersOf(display);
    const locked = instance.sessionId !== undefined;
    const editable = editableOf(display) && !locked && !running;

    const lockReason = !editableOf(display)
        ? 'The server marks this harness read-only.'
        : locked
          ? instance.frozen !== undefined
              ? 'This saved session keeps the agent team it started with.'
              : 'This saved session cannot change its agent team here.'
          : running
            ? 'Stop the run before changing the agent team.'
            : undefined;

    // Effective model per member.
    //
    // Locked chat: the server froze `agentModels` at creation with every member
    // present, so displaying it is the truth even if the live harness was edited
    // afterwards. Before that field existed, fall back to the frozen descriptor's
    // overrides and finally to the session model.
    //
    // Editable harness: only overrides are relevant; a member without one shows
    // the "inherit" option naming the current global model, and a session started
    // later resolves it from its settings.
    const overrides = agentModelsOf(display);
    const models: Record<string, string> = {};
    for (const name of members) {
        const model = locked
            ? (instance.sessionModels?.[name] ?? overrides[name] ?? instance.sessionModel)
            : overrides[name];
        if (model !== undefined && model.length > 0) models[name] = model;
    }

    return createAgentRow({
        members,
        primary: primaryOf(display),
        agents: agentLibrary,
        editable,
        ...(lockReason === undefined ? {} : { lockReason }),
        models: {
            models,
            catalogue: modelIds,
            ...(locked
                ? instance.sessionModel === undefined
                    ? {}
                    : { inheritModel: instance.sessionModel }
                : { inheritModel: settings.model }),
            editable: editableOf(display) && !locked && !running,
            onChange: (name, model) => void setAgentModel(name, model)
        },
        activity: [...instance.activity],
        onNewSession: () => newSession(),
        onSelectPrimary: (name) => void selectPrimary(name),
        onAdd: (name) => void addAgent(name),
        onRemove: (name) => void removeAgent(name)
    });
};

// Send the complete team on every change: `primary` plus every other member as
// `subagents`. That is what makes a demotion atomic — the old primary is listed
// as a secondary exactly once and no stale duplicate can survive.
//
// `models` is the COMPLETE override map the caller wants stored. The server
// replaces its map with what it receives, so every mutation sends the whole map:
// promotion keeps each member's entry, add leaves the new member inheriting, and
// remove drops the removed member's key via `modelsForMembers` (the server offers
// the same guarantee, but a complete map never depends on it).
//
// When `models` is omitted, agent moves preserve the descriptor's current
// overrides and omit the field entirely if there is nothing to preserve — the
// exact pre-R9 request body for a harness that has no per-agent models.
const patchAgents = async (
    primary: string,
    members: readonly string[],
    models?: Readonly<Record<string, string>>,
    label = 'agent team'
): Promise<void> => {
    const instance = current;
    if (instance === undefined || savingAgents) return;

    const display = instance.frozen ?? instance.descriptor;
    if (!editableOf(display) || instance.sessionId !== undefined || running) return;

    const unique = uniqueNames(members);
    const nextPrimary = unique.includes(primary) ? primary : unique[0];
    if (nextPrimary === undefined) return;

    const subagents = unique.filter((name) => name !== nextPrimary);

    const nextModels = modelsForMembers(models ?? agentModelsOf(display), unique);
    const includeModels = models !== undefined || Object.keys(nextModels).length > 0;

    savingAgents = true;
    setStatus('running', `saving ${label}`);

    try {
        const updated = await updateHarness(display.name, {
            primary: nextPrimary,
            subagents,
            ...(includeModels ? { agentModels: nextModels } : {})
        });
        replaceDescriptor(updated);
        buildHarnesses();
        renderHarnessChrome();
        setStatus('idle', `${label} saved · applies to new sessions`);
    } catch (error) {
        // The descriptor on screen is still the last server answer, so a failed
        // PATCH leaves a truthful row.
        setStatus('error', `${label}: ${messageOf(error)}`);
        renderHarnessChrome();
    } finally {
        savingAgents = false;
    }
};

// Change one member's model. An empty value is the "inherit" choice: delete the
// key so the member resolves to the session's settings model, and send the
// resulting map explicitly (even `{}`) so clearing the last override really clears
// it on the server.
const setAgentModel = async (name: string, model: string): Promise<void> => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    // A saved chat keeps the models it started with; the tile dropdown is disabled
    // in that state, and this guard covers a stale handler.
    if (!editableOf(display) || instance.sessionId !== undefined || running) return;

    const members = membersOf(display);
    if (!members.includes(name)) return;

    const overrides = { ...agentModelsOf(display) };
    if (model.length === 0) delete overrides[name];
    else overrides[name] = model;

    await patchAgents(primaryOf(display), members, overrides, 'agent models');
};

const selectPrimary = async (name: string): Promise<void> => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    // Selecting a member promotes it and demotes the old primary to a secondary,
    // in place (order is preserved so the row does not shuffle unexpectedly).
    const members = membersOf(display);
    await patchAgents(name, members);
};

const addAgent = async (name: string): Promise<void> => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    const members = membersOf(display);
    if (members.includes(name)) return;

    await patchAgents(primaryOf(display), [...members, name]);
};

const removeAgent = async (name: string): Promise<void> => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    const members = membersOf(display);
    if (members.length <= 1 || !members.includes(name)) return;

    const remaining = members.filter((member) => member !== name);
    // Removing the primary promotes the next member; the team never ends up with
    // zero or two primaries.
    const nextPrimary = name === primaryOf(display) ? remaining[0] : primaryOf(display);
    await patchAgents(nextPrimary, remaining);
};

// Core tools live ONLY in this collapsible dropdown (R3): the harness-owned set,
// where delegate appears exactly when there is somewhere to delegate. The Tools tab
// and the right-rail catalogue list every tool including these; this dropdown stays
// as the informational view of what a session always has.
const renderCoreTools = (
    descriptor: HarnessDescriptor,
    memberCount: number,
    discovered?: readonly string[]
): void => {
    const names = coreToolsOf(descriptor, memberCount);
    coreSummary.textContent = `Core tools · ${names.length}`;
    coreList.replaceChildren();

    for (const name of names) {
        const row = el('div', 'core-tool');
        row.dataset.tool = name;
        row.append(
            el('span', 'core-tool-name', name),
            el(
                'span',
                'core-tool-description',
                HARNESS_CORE_TOOL_DESCRIPTIONS[name] ?? 'Harness core tool.'
            )
        );
        coreList.append(row);
    }

    // Discovered tools are session state: a manual requestTools (Tools tab) or a
    // chat discovery refreshes the snapshot, and this line follows it.
    const enabled = discovered ?? [];
    coreDiscovered.hidden = enabled.length === 0;
    coreDiscovered.textContent = enabled.length === 0 ? '' : `enabled for this session: ${enabled.join(', ')}`;
};

// ---------------------------------------------------------------------------
// Tool catalogue (right rail + Tools tab) and the manual runner (centre)
// ---------------------------------------------------------------------------
//
// Two listings of the SAME server data, on purpose:
//   - the right rail is the compact catalogue that stays visible while chatting;
//   - the Tools tab is the full-width, keyed list the user asked for, and it
//     includes the core tools (requestTools/createTool/todoTools/delegate) even
//     though the harness also shows them informationally in its core dropdown.
// Selecting either listing opens the same runner, and a core entry runs inside the
// selected harness's session (api.ts `callTool(name, parameters, sessionId)`).

const toolButtons = new Map<string, HTMLButtonElement>();
const toolTabButtons = new Map<string, HTMLButtonElement>();

const toolsPane = el('div', 'pane tools-pane');
const toolsTabHead = el('div', 'tools-tab-head');
toolsTabHead.append(
    el('h2', 'tools-tab-title', 'Tools'),
    el(
        'p',
        'tools-tab-hint',
        'Every tool the server lists, core tools included. Calls execute on the harness server — nothing runs in this browser. Core tools run inside the selected harness’s session; ordinary tools run directly.'
    )
);
const toolsTabList = el('div', 'tool-tab-list');
const runnerSlot = el('div', 'tool-runner-slot');
toolsPane.append(toolsTabHead, toolsTabList, runnerSlot);

const selectTool = (entry: ToolDescriptor): void => {
    if (running) return;

    stopPolling();

    currentTool = entry;
    // Selecting a tool is what the Tools tab is for: switch to it so the full list
    // and the runner are both visible, whichever listing was clicked.
    activeTab = 'tools';
    paintTabs();

    for (const [name, button] of toolButtons) {
        button.setAttribute('aria-pressed', name === entry.name ? 'true' : 'false');
    }
    for (const [name, button] of toolTabButtons) {
        button.setAttribute('aria-pressed', name === entry.name ? 'true' : 'false');
    }
    // The harness stays selected: the sessions rail is still scoped to it, and
    // clicking a harness row returns to that chat.
    for (const [name, button] of harnessButtons) {
        button.setAttribute('aria-pressed', name === selectedName ? 'true' : 'false');
    }

    const unavailable = entry.availability?.state === 'unconfigured';
    headTitle.textContent = entry.name;
    headName.textContent = entry.group;
    headNote.textContent = [
        entry.visibility,
        `tags: ${entry.tags.length > 0 ? entry.tags.join(', ') : 'none'}`,
        ...(entry.sessionBound === true ? ['session-bound'] : []),
        ...(unavailable ? ['unconfigured'] : [])
    ].join(' · ');

    agentSlot.hidden = true;
    composer.hidden = true;
    runner.show(entry);
    runnerSlot.replaceChildren(runner.pane);
    stage.replaceChildren(toolsPane);
    delete stage.dataset.preset;
    setStatus('idle');
};

// Switch between the chat and the Tools tab. The panel (`stage`) is shared; the
// rest of the centre chrome (head, agent row, composer) is shown or hidden to
// match. A run in flight keeps the tabs locked, exactly like harness switching.
const setTab = (tab: 'chat' | 'tools'): void => {
    if (running || activeTab === tab) return;

    if (tab === 'chat') {
        activeTab = 'chat';
        paintTabs();

        currentTool = undefined;
        for (const button of toolButtons.values()) button.setAttribute('aria-pressed', 'false');
        for (const button of toolTabButtons.values()) button.setAttribute('aria-pressed', 'false');

        agentSlot.hidden = false;
        composer.hidden = false;
        if (current !== undefined) {
            stage.replaceChildren(current.view.pane);
            renderHarnessChrome();
            renderSessions();
        } else {
            stage.replaceChildren();
        }
        setStatus('idle');
        return;
    }

    // Tools tab with nothing chosen yet: open the first entry (core tools are
    // listed first by the server) so the tab is never an empty shell. An empty
    // catalogue explains itself instead.
    const entry = currentTool ?? toolEntries[0];
    if (entry === undefined) {
        activeTab = 'tools';
        paintTabs();
        currentTool = undefined;
        agentSlot.hidden = true;
        composer.hidden = true;
        headTitle.textContent = 'Tools';
        headName.textContent = '';
        headNote.textContent = 'The server reported no tools.';
        const empty = el('div', 'pane');
        const wrap = el('div', 'log-wrap');
        wrap.append(
            el('p', 'field-hint', 'The server reported no tools. Check that the harness server is reachable.')
        );
        empty.append(wrap);
        stage.replaceChildren(empty);
        return;
    }

    selectTool(entry);
};

chatTab.addEventListener('click', () => setTab('chat'));
toolsTab.addEventListener('click', () => setTab('tools'));

// Full-width Tools tab listing. Same grouping as the rail, but every entry is a
// keyed button with enough room to show what it is and whether a session is needed.
const buildToolsTab = (entries: readonly ToolDescriptor[]): void => {
    toolsTabList.replaceChildren();
    toolTabButtons.clear();

    let lastGroup = '';

    for (const entry of entries) {
        if (entry.group !== lastGroup) {
            toolsTabList.append(el('div', 'tool-tab-group', entry.group));
            lastGroup = entry.group;
        }

        const button = el('button', 'tool-tab-button');
        button.type = 'button';
        button.dataset.tool = entry.name;
        button.setAttribute('aria-pressed', 'false');
        button.disabled = running;

        const unavailable = entry.availability?.state === 'unconfigured';
        const kind = [
            entry.visibility,
            ...(entry.sessionBound === true ? ['session'] : []),
            ...(unavailable ? ['unconfigured'] : [])
        ].join(' · ');
        if (unavailable) button.dataset.availability = 'unconfigured';

        button.append(
            el('span', 'tool-tab-name', entry.name),
            el('span', 'tool-tab-kind', kind)
        );
        button.addEventListener('click', () => selectTool(entry));

        toolTabButtons.set(entry.name, button);
        toolsTabList.append(button);
    }

    if (entries.length === 0) {
        toolsTabList.append(
            el('p', 'field-hint', 'The server reported no tools. Check that the harness server is reachable.')
        );
    }
};

const buildTools = (entries: readonly ToolDescriptor[]): void => {
    toolEntries = entries;
    toolList.replaceChildren();
    toolButtons.clear();
    catalogueCount.textContent = String(entries.length);
    buildToolsTab(entries);

    let lastGroup = '';

    for (const entry of entries) {
        if (entry.group !== lastGroup) {
            toolList.append(el('div', 'tool-group', entry.group));
            lastGroup = entry.group;
        }

        const button = el('button', 'tool-button');
        button.type = 'button';
        button.dataset.tool = entry.name;
        button.setAttribute('aria-pressed', 'false');
        button.disabled = running;

        // The rail has to answer "is websearch available here?" before a click.
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

    if (entries.length === 0) {
        toolList.append(el('p', 'field-hint', 'The server reported no direct-call tools.'));
    }
};

// ---------------------------------------------------------------------------
// Session directory (server-owned, filtered by harness)
// ---------------------------------------------------------------------------

const upsertSession = (session: SessionSnapshot): void => {
    const index = sessions.findIndex((candidate) => candidate.id === session.id);
    if (index >= 0) sessions[index] = session;
    else sessions.push(session);
};

// Eight characters is the same prefix the server's logs are readable by.
const shortId = (id: string): string => (id.length <= 8 ? id : id.slice(0, 8));

// Sessions belong to one canonical harness. The rail shows only the selected one,
// which is the "locked to selected harness" rule in R3 — opening a row can never
// silently move the reader to another harness, because no other row is offered.
const visibleSessions = (): SessionSnapshot[] => {
    if (selectedName === undefined) return [];

    return sessions.filter(
        (session) => canonicalHarnessName(session.harness, presetDescriptors) === selectedName
    );
};

// Rows are buttons: keyboard reachable and self-explanatory with a status text
// and turn count. The active row is marked for styling only — selection is state
// in `current.sessionId`, not in this DOM.
const renderSessions = (): void => {
    sessionList.replaceChildren();

    sessionsScope.textContent =
        selectedName === undefined
            ? 'Select a harness to see its sessions.'
            : `Locked to ${selectedName}.`;

    const visible = visibleSessions();

    if (visible.length === 0) {
        sessionList.append(
            el(
                'p',
                'field-hint',
                selectedName === undefined
                    ? 'Select a harness first.'
                    : 'No sessions for this harness yet. Send a task to create one.'
            )
        );
        return;
    }

    const activeId = current?.sessionId;

    for (const session of visible) {
        const row = el('button', 'session');
        row.type = 'button';
        row.dataset.sessionId = session.id;
        row.dataset.status = session.status;
        if (session.id === activeId) row.dataset.active = 'true';
        row.disabled = running;

        // `turns.length` is the server's count; the UI does not compute a turn
        // count from event frames (it could disagree after a reload).
        const turns = session.turns.length;
        row.append(
            el('span', 'session-harness', session.harness),
            el(
                'span',
                'session-meta',
                `${session.status} · ${turns} turn${turns === 1 ? '' : 's'} · ${shortId(session.id)}`
            ),
            el(
                'span',
                'session-prompt',
                session.turns.length > 0 ? session.turns[session.turns.length - 1].prompt : 'no turns yet'
            )
        );
        row.title = `${session.harness} · ${session.id}`;

        row.addEventListener('click', () => {
            if (running) return;
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

// Draw a snapshot into its harness view. The turns are the authoritative
// transcript; `messages` is the entry agent's own view of the same run and is
// informational. The frozen definition, when sent, becomes the displayed team.
const applySnapshot = (instance: Instance, session: SessionSnapshot): void => {
    instance.sessionId = session.id;

    // The frozen definition is the conversation's own team. Assign even when the
    // server omitted it (legacy): keeping a previous session's frozen team would
    // describe the wrong chat.
    instance.frozen = frozenDefinitionOf(session);

    // Frozen per-agent models + the settings model they inherit from. A PATCH
    // after creation does not change these, which is why a saved chat can show the
    // models it started with while the live harness has moved on.
    instance.sessionModels = agentModelsOf(session);
    instance.sessionModel = typeof session.model === 'string' ? session.model : undefined;
    instance.discovered = Array.isArray(session.discoveredTools)
        ? [...session.discoveredTools]
        : undefined;

    // Activity from a hydrated/polled record: ONLY a still-running turn can make
    // an agent busy. Replaying a settled turn (done/error/cancelled) lights
    // nothing, so opening history never animates old work.
    instance.activity.clear();
    if (session.status === 'running') {
        for (const name of activityOfTurns(session.turns)) instance.activity.add(name);
    }

    instance.view.hydrate(session.turns, session.model);
    instance.view.setTranscript(JSON.stringify(session.messages, null, 2));
    upsertSession(session);
    renderSessions();

    if (current === instance) {
        paintActivity(agentSlot, instance.activity);
        renderHarnessChrome();
        runner.sync();
    }
};

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

const stopPolling = (): void => {
    // The token invalidates an in-flight `getSession` response: a stale answer
    // must not repaint the card after the reader moved to another session.
    pollToken += 1;

    if (sessionsPollTimer !== undefined) {
        window.clearTimeout(sessionsPollTimer);
        sessionsPollTimer = undefined;
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

        sessionsPollTimer = window.setTimeout(() => {
            void tick();
        }, POLL_INTERVAL_MS);
    };

    sessionsPollTimer = window.setTimeout(() => {
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

    // Opening a session keeps its canonical harness (including a legacy alias):
    // the row's harness is what is selected, so the chat never lands in another
    // harness's transcript.
    const harnessName = canonicalHarnessName(session.harness, presetDescriptors);
    const descriptor = descriptorFor(harnessName);
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
    target.frozen = frozenDefinitionOf(session);

    selectHarness(descriptor.name);
    applySnapshot(target, session);
    rememberSession(id);

    if (session.status === 'running') {
        setStatus('running', 'session running · polling server');
        pollSession(target, id);
        return;
    }

    setStatus(
        session.status === 'error' ? 'error' : 'idle',
        session.status === 'error' ? (session.lastError ?? 'session error') : undefined
    );
};

// Explicit new conversation: forget the pointer and drop the local projection.
// The previous session stays on the server and can be reopened from the rail;
// clearing the pointer is also what unlocks agent editing again.
const newSession = (): void => {
    const instance = current;
    if (instance === undefined) return;

    if (running) {
        instance.view.notice('cancel the running task before starting a new session');
        return;
    }

    stopPolling();
    instance.sessionId = undefined;
    instance.frozen = undefined;
    instance.sessionModels = undefined;
    instance.sessionModel = undefined;
    instance.discovered = undefined;
    clearActivity();
    instance.view.clear();
    instance.view.setTranscript('[]');
    if (instance === current) forgetRememberedSession();
    renderHarnessChrome();
    renderSessions();
    setStatus('idle');
    input.focus();
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const setBusy = (value: boolean): void => {
    running = value;
    runButton.disabled = value || !booted;
    stopButton.disabled = !value;
    resetButton.disabled = value;
    newSessionButton.disabled = value || !booted;
    createHarnessButton.disabled = value || !booted;

    // A creation form left open while a run starts would still be submittable;
    // close it so no POST can race the stream.
    if (value && createPanel.isOpen()) createPanel.close();

    for (const button of harnessButtons.values()) button.disabled = value || !booted;
    for (const button of toolButtons.values()) button.disabled = value;
    for (const button of toolTabButtons.values()) button.disabled = value;
    chatTab.disabled = value;
    toolsTab.disabled = value;
    for (const row of sessionList.querySelectorAll<HTMLButtonElement>('.session')) row.disabled = value;

    // The agent row follows the same lock: no editing while a run streams.
    if (current !== undefined) renderHarnessChrome();
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

// Create a session only when this harness has none. Settings drafts are read here
// and nowhere else: editing the endpoint, model or key afterwards must not
// recreate, replace or delete the conversation the user already has (H4). A new
// session is an explicit "New session" click, and the first submit after it
// creates the server record.
const ensureSession = async (instance: Instance): Promise<string> => {
    if (instance.sessionId !== undefined) return instance.sessionId;

    const session = await createSession(instance.descriptor.name, settings);

    instance.sessionId = session.id;
    instance.frozen = frozenDefinitionOf(session);
    // The creation answer carries the effective frozen model map, so the tile
    // dropdowns can show what this conversation actually runs.
    instance.sessionModels = agentModelsOf(session);
    instance.sessionModel = typeof session.model === 'string' ? session.model : undefined;
    instance.discovered = Array.isArray(session.discoveredTools)
        ? [...session.discoveredTools]
        : undefined;
    rememberSession(session.id);
    upsertSession(session);
    renderSessions();

    // A manual core call may have created this session; its runner shows the
    // session id now instead of "no session yet".
    if (current === instance) {
        renderHarnessChrome();
        runner.sync();
    }

    return session.id;
};

const run = async (): Promise<void> => {
    const prompt = input.value.trim();
    if (running || savingAgents || prompt.length === 0) return;

    const instance = current;
    if (instance === undefined || currentTool !== undefined) return;

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

    // A new run owns the rings from zero: nothing from the previous turn may
    // carry over before the first `start` event arrives.
    clearActivity();

    const requestController = new AbortController();

    // Take the request lock *before* `await ensureSession(...)`. Session creation
    // is part of the request, so Run must be disabled (and Enter must be a no-op)
    // for its whole duration — otherwise a double submit creates two sessions.
    activeRun = { controller: requestController, instance };
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
                    //
                    // `frameAtOf` is the server clock for this event (new
                    // servers); absent means the tile falls back to the local
                    // clock for tool timing.
                    const target = instance.view.turn(item.turnId) ?? turn;
                    target.apply(item.event, frameAtOf(item));

                    // Per-agent ring. `start` activates the agent, text/reasoning/
                    // tool events keep it active, and a `done`/`error` for one agent
                    // removes only that agent (a delegated sibling keeps spinning).
                    applyActivity(instance.activity, item.event);
                    if (current === instance) paintActivity(agentSlot, instance.activity);
                    return;
                }

                // Terminal frames (snapshot | failed) carry the complete session,
                // turns included. This is the frame that makes the server record
                // authoritative for the whole transcript.
                if (item.type === 'snapshot' || item.type === 'failed') {
                    terminal = item.session;
                    instance.view.setTranscript(JSON.stringify(item.session.messages, null, 2));

                    // The run is over: no agent may stay marked busy.
                    instance.activity.clear();
                    if (current === instance) paintActivity(agentSlot, instance.activity);
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
            instance.frozen = frozenDefinitionOf(terminal) ?? instance.frozen;
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
        if (current === instance) renderHarnessChrome();
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
                instance.frozen = undefined;
                if (instance === current) forgetRememberedSession();
                void refreshSessions();
            }

            turn.setState('error', message);
            instance.view.notice(`run failed: ${message}`, 'error');
            setStatus('error', message);
        }
    } finally {
        if (activeRun?.controller === requestController) activeRun = undefined;
        // Reset/cancel/failure/terminal all leave through here: clear the rings
        // for the instance that owned the run (not whichever is selected now).
        instance.activity.clear();
        if (current === instance) paintActivity(agentSlot, instance.activity);
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
    const active = activeRun;
    if (active === undefined) return;

    active.controller.abort();

    // Immediate acknowledgement: aborting the fetch and asking the server to
    // cancel both take a round trip, so the pill says what is happening.
    setStatus('running', 'stopping');

    // Stopping is the user's terminal signal: no ring may keep spinning while the
    // cancellation round-trip finishes. Cleared on the ORIGIN instance.
    active.instance.activity.clear();
    if (current === active.instance) paintActivity(agentSlot, active.instance.activity);

    // The origin instance owns the session to cancel — never whatever harness is
    // selected now. Harness switching is disabled during a run, so this also
    // survives a selection that raced the first render.
    const sessionId = active.instance.sessionId;
    if (sessionId !== undefined) {
        // The server records the cancellation as the turn's terminal status; the
        // directory row should stop saying "running" once it has.
        void cancelSession(sessionId)
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
    clearActivity();
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
            instance.frozen = undefined;
            if (instance === current) forgetRememberedSession();
            instance.view.notice(`reset failed: ${messageOf(error)}`);
            setStatus('error', messageOf(error));
            void refreshSessions();
        }
    );
});

// ---------------------------------------------------------------------------
// Create harness panel
// ---------------------------------------------------------------------------

const createPanel = createCreateHarnessPanel({
    agents: () => agentLibrary,
    existingNames: () => presetDescriptors.map((descriptor) => descriptor.name),
    onCancel: () => createHarnessButton.setAttribute('aria-expanded', 'false'),
    onSubmit: async (request) => {
        // The server stores the harness and answers with its descriptor; the rail
        // and the centre are rebuilt from that answer, never from the draft.
        const descriptor = await createHarness(request);
        replaceDescriptor(descriptor);
        buildHarnesses();
        selectHarness(descriptor.name);
        setStatus('idle', `created ${descriptor.name} · choose the team if needed`);
    }
});
createPanel.element.id = 'create-harness-panel';
createHarnessButton.setAttribute('aria-controls', createPanel.element.id);
leftRail.append(harnessHead, harnessList, createPanel.element, endpoint);

createHarnessButton.addEventListener('click', () => {
    if (running || !booted) return;

    if (createPanel.isOpen()) {
        createPanel.close();
        createHarnessButton.setAttribute('aria-expanded', 'false');
        return;
    }

    createPanel.open();
    createHarnessButton.setAttribute('aria-expanded', 'true');
});

newSessionButton.addEventListener('click', newSession);

refreshSessionsButton.addEventListener('click', () => {
    void refreshSessions();
});

// A polling loop or a live tick must never outlive the page; a reload re-reads
// the snapshot and every elapsed label from the server.
window.addEventListener('pagehide', () => {
    stopPolling();
    clearActivity();

    for (const instance of instances.values()) instance.view.dispose();
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

    // No catalogue, no tab switch: the only useful action is Retry.
    chatTab.disabled = true;
    toolsTab.disabled = true;

    if (presetDescriptors.length === 0) {
        harnessList.replaceChildren(el('p', 'field-hint', 'No server connection.'));
    }
};

const boot = async (): Promise<void> => {
    setStatus('connecting');

    try {
        // One bootstrap document on the canonical mount; the standalone `/api`
        // root is a 404, so the client falls back to /harnesses + /tools +
        // /sessions there. Both bring the full session list, which is what makes
        // a reload land on an existing conversation, and both carry the agent
        // presets on the new server.
        const data = await loadBootstrap();

        applyDefaults(data.defaults);

        // The defaults may have replaced the model, and the stored settings may
        // name a model the provider no longer serves. Rendering first and then
        // fetching keeps the dropdown correct in both cases; the lookup runs in
        // the background so boot is not gated on the provider being reachable.
        renderModelOptions();
        void refreshModels();

        presetDescriptors = data.presets;
        // The agent library is server data. An older server has no list, so derive
        // a minimal one from its descriptors: the picker still works, and the
        // detail panel says the server did not advertise instructions.
        agentLibrary =
            Array.isArray(data.agents) && data.agents.length > 0
                ? data.agents
                : agentsFromDescriptors(data.presets);

        buildHarnesses();
        buildTools(data.tools);

        sessions = data.sessions;
        renderSessions();

        // Catalogue-dependent actions become usable only now.
        refreshSessionsButton.disabled = false;
        newSessionButton.disabled = false;
        createHarnessButton.disabled = false;

        if (presetDescriptors.length === 0) {
            showOffline('The server reported no harnesses.');
            setStatus('error', 'no harnesses');
            return;
        }

        booted = true;
        runButton.disabled = false;
        selectHarness(presetDescriptors[0].name);

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

void boot();

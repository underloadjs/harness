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
// Shell (three columns, R21):
//   - left rail  — harnesses (built-ins and user-created) plus the create form,
//                  the `left` tool-panel host, and a collapsed endpoint/model
//                  panel at the bottom;
//   - centre     — a Chat/Tools tablist. Chat shows the selected harness title,
//                  its agent row (with a per-agent model dropdown), the `center`
//                  tool-panel host, the transcript and the composer. Tools is the
//                  full-width list of EVERY server tool — core entries included —
//                  plus the manual runner; the tool list lives ONLY there;
//   - right rail — the tool-contributed SCRATCH BOARD (primary panel host) and,
//                  below it, the sessions for the selected harness only.
//
// R21.2 removed the right rail's core-tools dropdown and tool catalogue. They
// duplicated the Tools tab, which is now the single place to review and call
// tools; enabled-for-session status moved next to that list (`.tools-session-note`)
// instead of floating on the board.
//
// R21.1: every harness is editable. The legacy `editable:false` flag (old demo/
// flaky fixtures) is ignored — see contract.ts `editableOf` — so the rail shows
// only template/custom, never a read-only badge or gate. What remains locked is a
// SAVED SESSION's frozen team, which is a conversation guarantee, not a harness
// permission.
//
// Agent TEAM editing is deliberately scoped to *new* sessions. A saved session
// carries a frozen `harnessDefinition` for its member list and promotion order; the
// row renders those and explains why the team is locked, with a New session action.
//
// Agent MODELS are live (R2): `SessionSnapshot.agentModels` is the session's current
// effective map, so a tile dropdown edits the conversation on screen through
// PATCH /sessions/:id and the next model request picks the new id up — even while a
// run streams, because the server reads the map at request time. Only the frozen
// `harnessDefinition` remains historical. Before a session exists the same control
// keeps the harness-level override path (PATCH /harnesses/:name).
//
// Execution is server-only. A catalogue tool is a direct call; a session-bound
// core tool (`sessionBound`) is sent with the selected session's id so toolRequest,
// toolCreate, todoManage and agentDelegate change THAT conversation — and the snapshot is
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
// switching and TEAM editing is disabled while a run is in flight. Model edits are
// not a team edit: PATCH /sessions/:id applies to the next request without
// cancelling the stream (R2).
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
    enqueueTask,
    getSession,
    listProviderModels,
    listSessions,
    loadBootstrap,
    observeSession,
    resetSession,
    updateHarness,
    updateSession
} from './api';
import type { HarnessBootstrap } from './api';
import {
    agentModelsOf,
    agentsFromDescriptors,
    builtinOf,
    canonicalHarnessName,
    frameAtOf,
    frameUsageOf,
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
import { applyPanels, createPanelHost, mediaOfTurns } from './ui/panels';
import type { PanelMedia } from './ui/panels';
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

// The provider's advertised default model, learned from the bootstrap document.
// R18: when the settings model is blank, a session request sends no model and the
// SERVER falls back to this value, so it is the effective fallback a per-agent
// dropdown must name. Kept separately from `settings` because `applyDefaults`
// skips stored settings — the label still needs the real server fallback.
let serverDefaultModel = '';

// The model a member with no override uses for a NEW session: the typed settings
// model, else the server's documented fallback. Empty means unknown (the dropdown
// says so rather than fabricating an id).
const defaultSessionModel = (): string => {
    const typed = settings.model.trim();
    return typed.length > 0 ? typed : serverDefaultModel;
};

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
    // task is enqueued, so the tile shows `queued` (neutral, no clock) until the
    // server accepts it and advances it to running.
    begin: (prompt: string) => TurnHandle;
    clear: () => void;
    notice: (text: string, tone?: 'info' | 'error') => void;
    setTranscript: (text: string) => void;
    // Replace the whole transcript with the server's turns. Used on boot and on
    // session selection — the server record always wins over local projection.
    hydrate: (turns: readonly SessionTurn[], model?: string, keep?: string) => TurnHandle[];
    // Reconcile the visible turns with a server snapshot/upsert without rebuilding
    // tiles (R4 queue): same ids are merged in place, new turns adopted, missing
    // ones dropped. This is the live path so streamed text is never duplicated and
    // the reader's expanded tile survives.
    reconcile: (turns: readonly SessionTurn[], model?: string, keep?: string) => TurnHandle[];
    // Find, or adopt, the tile for one server turn (a `turn` upsert frame).
    upsert: (turn: SessionTurn, model?: string) => TurnHandle;
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
            'Tools are discovered inside the chat with toolRequest; the catalogue never assigns them.'
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
        reconcile: (turns, model, keep) => {
            const follow = pinned();
            const handles = board.reconcile(turns, {
                ...(model === undefined ? {} : { model }),
                ...(keep === undefined ? {} : { keep })
            });
            // A task submitted while the reader is at the bottom should pull the
            // view down to the active row; a reader scrolled up keeps their place.
            stick(follow);
            return handles;
        },
        upsert: (turn, model) => {
            const existing = board.find(turn.id);
            if (existing !== undefined) {
                existing.merge(turn, model);
                return existing;
            }

            // A turn this browser did not submit (another tab, another observer)
            // is adopted from the server record. `adopt` expands it as the newest.
            stick(pinned());
            return board.adopt(turn, model);
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
//
// Every entry here must be an input the tool would actually accept: the box is
// editable and nothing runs until "Call tool", so a value with empty tags, a
// missing required string, or an optional field pinned to an invalid 0 only
// teaches the wrong shape.
const EXAMPLES: Readonly<Record<string, unknown>> = {
    // Two properties, so the runner sends the whole object (no single-property
    // unwrapping): the language is part of the input, not a separate mode.
    syntaxCheck: { code: 'const answer = 42;\nconsole.log(answer);', language: 'javascript' },
    // The batched file tools each declare ONE array property, so the textarea holds
    // the array itself, not a wrapper object (T14).
    fileRead: ['package.json'],
    fileWrite: [{ path: 'notes/hello.txt', content: 'hello from the harness UI\n' }],
    fileEdit: [{ path: 'notes/hello.txt', oldString: 'hello', newString: 'hi' }],
    // "." works from whatever directory the server runs in.
    fileList: ['.'],
    // fileGlob declares four properties, so it takes the whole object. Both lists
    // are the documented defaults, and the optional `content`/`maxResults` are
    // OMITTED: an absent `content` is filename mode (the useful first call) and an
    // absent `maxResults` means the documented cap, whereas `""` or `0` would
    // switch to content mode or be clamped. Add `content` to try a content search.
    fileGlob: { patterns: ['**/*'], paths: ['.'] },
    commandRun: { command: 'git status --short' },
    // Core tools: the manual runner can call these inside the selected session, so
    // their examples have to satisfy the same schema the model sees (non-empty
    // tags, a real action, a body that would parse).
    toolRequest: { tags: ['files', 'read'] },
    toolCreate: {
        name: 'shoutText',
        description: 'Uppercase a short string.',
        tags: ['text', 'upper'],
        source: 'return args.trim().toUpperCase();'
    },
    todoManage: { action: 'add', text: 'Review the harness catalogue' },
    agentDelegate: {
        agent: 'summarizer',
        input: 'Summarise these notes in at most two sentences.'
    },
    timeNow: 'UTC',
    textCount: 'The harness finds tools by tag before it uses them.',
    diceRoll: 6,
    noteSearch: 'tool loop',
    textSummarize: 'The harness runs tools until the model answers with text.',
    // The server owns the provider key; the runner only needs a valid query. The
    // exact key is never part of this value.
    webSearch: { query: 'harness tool discovery', maxResults: 5 }
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

// A schema-derived starting value for one property, used only when no example and
// no schema `default` exist.
//
// The order is deliberate: an enum member is always valid, "required" strings and
// numbers get a value the schema would accept, and an array is left empty (that is
// valid for every array schema here — a `minItems` constraint would need an
// example instead).
const placeholderFor = (schema: Record<string, unknown> | undefined): unknown => {
    // A declared default is the best answer there is: it is what the tool itself
    // documents as the value to use.
    if (schema !== undefined && schema.default !== undefined) return schema.default;

    const values = schema?.enum;

    // An enum member is valid by construction. Taking the first keeps the template
    // deterministic (todoManage.action, syntaxCheck.language).
    if (Array.isArray(values) && values.length > 0) return values[0];

    switch (schema?.type) {
        case 'string':
            return '';
        case 'number':
        case 'integer':
            return schema.minimum !== undefined && typeof schema.minimum === 'number' ? schema.minimum : 0;
        case 'boolean':
            return schema.default === true;
        case 'array':
            return [];
        case 'object':
            return {};
        default:
            return null;
    }
};

// The auto-generated argument text for a tool that has no curated example.
//
// WHY OPTIONAL PROPERTIES ARE DROPPED (T16)
// -----------------------------------------
// Filling every property with a type-shaped blank produced arguments that no tool
// would accept: `{"tags": [], "limit": 0}` for toolRequest (empty tags, and 0 is
// below the minimum), `{"patterns": [], "paths": [], "content": "", "maxResults": 0}`
// for fileGlob. Omitting what the schema does not require is both valid and the
// honest reading of "optional": the tool then applies its documented default. Only
// the `required` list is materialized; a schema with no `required` at all gets `{}`,
// which is a valid no-argument call.
//
// The ONE-property case is different: the single-property rule means the textarea
// holds that property's VALUE, not a wrapper object (see `singleProperty` above), so
// it is emitted bare whether or not the schema marks it required — with no value at
// all the box would be `undefined` instead of JSON.
//
// The text stays fully editable in the runner; nothing here executes.
const templateFor = (parameters: Record<string, unknown> | undefined): string => {
    if (!parameters || parameters.type !== 'object') return '{}';

    const properties = (parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(parameters.required)
        ? (parameters.required as unknown[]).filter((key): key is string => typeof key === 'string')
        : [];
    const keys = Object.keys(properties);

    // Single-property schema: the whole argument IS this property's value.
    if (keys.length === 1) return JSON.stringify(placeholderFor(properties[keys[0]]));

    const included = keys.filter((key) => required.includes(key));

    if (included.length === 0) return '{}';

    const value: Record<string, unknown> = {};
    for (const key of included) value[key] = placeholderFor(properties[key]);

    return JSON.stringify(value, null, 2);
};

// What the runner needs from the shell for a session-bound core tool.
//
// `context` is read at show time and before every call; `ensureSession` creates
// the SELECTED harness's session when none exists yet; `refreshSession` re-reads
// the server snapshot after a call so toolRequest discoveries and todo state are
// on screen immediately. None of these live in this module: the runner must not
// own the selection, and it must not guess a session id.
//
// `onPanels` delivers the tool's declarative panels (R21.3) TOGETHER WITH the
// owner captured before the call: the caller decides which instance may draw
// them. That is what keeps a slow manual call from painting into whatever harness
// or session happens to be selected when the answer lands.
export type ToolRunnerOptions = {
    context: () => { harness?: string; sessionId?: string };
    ensureSession: () => Promise<string | undefined>;
    refreshSession: (sessionId: string) => Promise<void>;
    onPanels?: (
        toolName: string,
        panels: unknown,
        owner: { harness?: string; sessionId?: string }
    ) => void;
};

type ToolRunner = {
    pane: HTMLElement;
    show: (entry: ToolDescriptor) => void;
    // Repaint the session-context line (selection or session changed underneath
    // an already-open runner).
    sync: () => void;
};

// The cap the server applies to `toolRequest` (5). Kept here only to explain
// truncation: the UI never slices the result itself.
const REQUEST_TOOLS_LIMIT = 5;

// Turn a toolRequest result into one actionable sentence. The structured result
// is still rendered verbatim above; this line exists because a truncated list is
// useless unless it says how much is missing and what to do next.
const resultHintFor = (name: string, result: unknown): string | undefined => {
    if (name !== 'toolRequest' || typeof result !== 'object' || result === null) return undefined;

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

    // Guidance for a truncated toolRequest answer. Separate from the raw result:
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

            // Capture the owner BEFORE the call. `ensureSession` above may have just
            // created the session, so read `context()` now: this is the exact view
            // the request is about to report into. A selection change during the
            // await can no longer redirect the answer.
            const owner = options.context();

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

            // toolRequest caps its answer (5 tools). The raw payload stays; the
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

            // Declarative panels come LAST: the refresh above recomputes instance
            // panels from the server's turns and would drop a manual panel that has
            // no backend storage yet. `panels` is optional on the success result, so
            // an older/ordinary tool answer passes `undefined` (a no-op).
            options.onPanels?.(entry.name, response.panels, owner);
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

// Mobile rail toggles (R1). Below 860px both rails are collapsed by default, so the
// topbar carries one independent disclosure per rail. On every wider layout the
// rails are permanently visible and `.rail-toggles` is `display:none` (styles.css),
// which is why the state below is inert there — it only drives the phone layout.
//
// One rail at a time: the two toggles are siblings, not a segmented control, but
// `setRailOpen` closes the other side because two open rails would leave no room
// for the chat on a phone.
const railToggles = el('div', 'rail-toggles');
const leftRailToggle = el('button', 'button small rail-toggle rail-toggle-left', 'Harnesses');
leftRailToggle.type = 'button';
leftRailToggle.setAttribute('aria-controls', 'rail-left');
leftRailToggle.setAttribute('aria-expanded', 'false');
leftRailToggle.setAttribute('aria-label', 'Harnesses panel');
leftRailToggle.title = 'Show or hide the harnesses rail';
const rightRailToggle = el('button', 'button small rail-toggle rail-toggle-right', 'Sessions');
rightRailToggle.type = 'button';
rightRailToggle.setAttribute('aria-controls', 'rail-right');
rightRailToggle.setAttribute('aria-expanded', 'false');
rightRailToggle.setAttribute('aria-label', 'Scratch board and sessions panel');
rightRailToggle.title = 'Show or hide the scratch board and sessions rail';
railToggles.append(leftRailToggle, rightRailToggle);

topbar.append(brand, railToggles, statusPill);

const shell = el('div', 'shell');

// --- left rail: harnesses + endpoint ---------------------------------------
const leftRail = el('aside', 'rail rail-left');
// The id is what `aria-controls` on the mobile toggle points at; the rail stays in
// the DOM at every width (only CSS collapses it on a phone).
leftRail.id = 'rail-left';
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
        // only the effective default/current labels.
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

// Tool-panel hosts (R21.3). Three named locations, one renderer:
//   - `center` sits above the turn grid, inside the chat column;
//   - `scratch` is the right rail's primary board (mounted below, above sessions);
//   - `left` sits under the harness list and above the endpoint disclosure.
// Each host hides itself while it has no panels (ui/panels.ts), so the shell stays
// exactly as quiet as before for tools that contribute nothing.
const centerPanels = createPanelHost('center');
// The left host is appended with the create-harness panel below (harness list →
// panels → endpoint), which is the requested "below harnesses, above endpoint".
const leftPanels = createPanelHost('left');
center.append(tabs, mainHead, agentSlot, centerPanels.element, stage, composer);

// --- right rail: scratch board (primary panel host), then sessions ----------
const rightRail = el('aside', 'rail rail-right');
rightRail.id = 'rail-right';
rightRail.setAttribute('aria-label', 'Tool scratch board and sessions');

// The scratch board is where a tool's declarative output lands. It is the primary
// host on purpose: the right rail is visible while chatting, so a tool can show
// state next to the conversation without owning a centre view.
const scratchSection = el('section', 'rail-section scratch-section');
const scratchHead = el('div', 'rail-head');
const scratchHeading = el('h2', 'rail-title', 'Scratch board');
const scratchNote = el('p', 'field-hint scratch-note', 'Tool-contributed panels for the current session.');
const scratchHost = createPanelHost('scratch');
scratchSection.append(scratchHead, scratchNote, scratchHost.element);
scratchHead.append(scratchHeading);

// Sessions are the second section, deliberately below the board: the conversation
// directory stays where it was, and the board never displaces it.
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

rightRail.append(scratchSection, sessionsSection);

// Dismiss layer for an open phone rail (R1). It is a sibling, NOT a wrapper: the
// rails must stay direct grid children so the desktop three-column layout and
// `shell > .rail-*` selectors keep working. CSS shows it only at <=860px while a
// rail is open and it never takes layout space (`position: fixed`).
const railBackdrop = el('div', 'rail-backdrop');
railBackdrop.setAttribute('aria-hidden', 'true');

shell.append(leftRail, center, rightRail, railBackdrop);
app.append(topbar, shell);

// Which phone rail is expanded, if any. Desktop/tablet ignore it entirely (their
// CSS never hides a rail), so the state can stay a plain module variable rather
// than something the server or storage knows about.
let openRail: 'left' | 'right' | undefined;

// One painter for the whole state: the shell attribute drives CSS, the two toggles'
// `aria-expanded` drives the accessibility tree. `undefined` removes the attribute
// so the collapsed default has no lingering data state to style.
const setRailOpen = (side: 'left' | 'right' | undefined): void => {
    openRail = side;

    if (side === undefined) delete shell.dataset.railOpen;
    else shell.dataset.railOpen = side;

    leftRailToggle.setAttribute('aria-expanded', side === 'left' ? 'true' : 'false');
    rightRailToggle.setAttribute('aria-expanded', side === 'right' ? 'true' : 'false');
};

// Toggling the open side closes it (the button is a real toggle), and opening one
// always closes the other: the two rails are exclusive on a phone.
leftRailToggle.addEventListener('click', () => {
    setRailOpen(openRail === 'left' ? undefined : 'left');
});

rightRailToggle.addEventListener('click', () => {
    setRailOpen(openRail === 'right' ? undefined : 'right');
});

// Backdrop click is the pointer dismiss; Escape is the keyboard one. Both only act
// when a rail is actually open, so Escape keeps whatever else the page uses it for
// (there is nothing today) when the shell is fully collapsed.
railBackdrop.addEventListener('click', () => {
    if (openRail !== undefined) setRailOpen(undefined);
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openRail !== undefined) setRailOpen(undefined);
});

// Leaving the phone breakpoint forgets the phone-only state, so rotating/resizing to
// a desktop width and back cannot resurrect a rail the reader had already dismissed.
// `matchMedia` is absent in jsdom and in very old browsers: optional, not required.
window.matchMedia?.('(max-width: 860px)')?.addEventListener?.('change', (event) => {
    if (!event.matches) setRailOpen(undefined);
});

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
    // The session's CURRENT effective per-agent models (`SessionSnapshot.agentModels`,
    // R2). The server keeps this map live: PATCH /sessions/:id replaces it and the
    // next model request uses the new ids. Refreshed by applySnapshot / openSession /
    // poll / a session-model PATCH. A harness without a session reads its override
    // map from the descriptor instead.
    sessionModels?: Record<string, string>;
    // The session's settings model: the effective fallback for the no-override
    // choice and the tile label a saved chat shows (R18 never renders "inherit").
    sessionModel?: string;
    // Tools toolRequest enabled for this session (SessionSnapshot.discoveredTools),
    // shown on the Tools tab's session note (R21.2 — there is no core dropdown any
    // more). Refreshed by the snapshot a core call triggers.
    discovered?: readonly string[];
    // Per-instance live activity set for the tile rings. Never a module global:
    // two harness views must not share who is busy.
    activity: Set<string>;
    // Tool-contributed panels for THIS instance/session (R21.3), keyed by
    // tool+panel id. Recomputed from the server's turns on every applySnapshot
    // (reload, poll, session open, reset) and upserted live from
    // `tool_result.ui` and from manual tool results. Never shared across
    // instances: switching harness can neither show nor leak another chat's board.
    panels: Map<string, PanelMedia>;
    // Work the server has not finished for this instance's session (R4): a
    // running task, a retained queued task, or a non-zero queueDepth. Drives Stop
    // (enabled), Reset (disabled) and the topbar pill. The composer is NOT gated
    // by it: submitting another task is how a queue is built.
    pending: boolean;
    // The latest authoritative turn records for this session, keyed by id. Kept so
    // activity can be recomputed from running records without a full snapshot.
    records: Map<string, SessionTurn>;
};

const instances = new Map<string, Instance>();
let current: Instance | undefined;
let selectedName: string | undefined;
let presetDescriptors: readonly HarnessDescriptor[] = [];
let agentLibrary: readonly AgentDescriptor[] = [];
let sessions: SessionSnapshot[] = [];
let currentTool: ToolDescriptor | undefined;
// The complete server catalogue (core entries included) for the Tools tab — the
// ONLY tool listing after R21.2. Boot replaces it from the bootstrap document.
let toolEntries: readonly ToolDescriptor[] = [];
// Which centre view is showing. The Tools tab is not the catalogue: it is a
// full-width, keyed list of every tool plus the manual runner.
let activeTab: 'chat' | 'tools' = 'chat';

// Single-flight submit state (R4). `running` means the selected session has work
// the server has not finished; it drives Stop/Reset/harness locks but NOT the
// composer, because submitting another task while one runs is exactly how the
// queue is built. `submitting` covers only the short window between pressing Run
// and the POST /tasks answer, so a double submit cannot create two sessions or
// two copies of the same task.
let running = false;
let submitting = false;
let booted = false;
// The live queue observer for the selected session, if one is open. Aborting it
// only unsubscribes (the server keeps running) — see api.ts observeSession.
let watch: { instance: Instance; sessionId: string; controller: AbortController } | undefined;
// Guards a double PATCH while an agent edit is in flight.
let savingAgents = false;
// How many POST /sessions requests are awaiting an answer. A model edit while a
// session is being created must not race the freeze (see setAgentModel); a counter
// rather than a boolean because the manual tool runner may also create one.
let creatingSessions = 0;

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
    },
    onPanels: (toolName, panels, owner) => {
        // R21.3 manual-call routing. The owner was captured immediately before the
        // request; the instance is resolved by harness name, then REQUIRED to still
        // point at that same session. If the reader moved on (another harness, New
        // session, another conversation) the panels are dropped rather than painted
        // into a conversation they were never produced for.
        //
        // MANUAL PANELS ARE EPHEMERAL: there is no backend storage for a direct
        // call's panels, so the next recompute (reload, poll, session reopen) derives
        // the board from turns and this panel disappears. That is the documented
        // trade-off; a tool that wants durable output must return it inside a run
        // (recorded `tool_result.ui`).
        if (owner.harness === undefined) return;

        const instance = instances.get(owner.harness);
        if (instance === undefined || instance.sessionId !== owner.sessionId) return;

        // `applyPanels` is a no-op for a server that sends no `panels` field, so an
        // older backend simply contributes nothing (no error, no empty card).
        const changes = applyPanels(instance.panels, toolName, panels);
        if (changes > 0 && current === instance) paintPanels();
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

    const instance: Instance = {
        descriptor,
        view: createView(descriptor),
        activity: new Set<string>(),
        panels: new Map<string, PanelMedia>(),
        pending: false,
        records: new Map<string, SessionTurn>()
    };
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

// Paint every named panel host from the SELECTED instance's panel state.
//
// The hosts are dumb; the instance is the source of truth. That is what makes a
// session switch safe: the board can only ever show the panels of the conversation
// on screen, and `current.panels` is rebuilt from that session's turns and results.
const paintPanels = (): void => {
    const media: readonly PanelMedia[] = current === undefined ? [] : [...current.panels.values()];
    scratchHost.apply(media);
    centerPanels.apply(media);
    leftPanels.apply(media);

    // The scratch note explains an empty board instead of leaving a blank section.
    const count = scratchHost.ids().length;
    scratchNote.textContent =
        current === undefined
            ? 'Select a harness to see tool panels.'
            : count > 0
              ? `${count} tool panel${count === 1 ? '' : 's'} for ${current.descriptor.name}.`
              : 'No tool panels yet. A tool that publishes ui/panels lands here.';
};

const harnessMeta = (descriptor: HarnessDescriptor): string => {
    const members = membersOf(descriptor).length;
    // R21.1: `template` marks a shipped harness, `custom` a user-created one. There
    // is deliberately no editable/read-only word here: every harness is editable.
    const kind = builtinOf(descriptor) ? 'template' : 'custom';

    return `${kind} · ${members} agent${members === 1 ? '' : 's'}`;
};

const selectHarness = (name: string): void => {
    const descriptor = descriptorFor(name);
    if (descriptor === undefined) return;
    // Picking a harness (or a session, which lands here through openSession) is the
    // end of a phone rail visit: collapse it so the chat is visible again. Harmless
    // on desktop, where the state is never styled.
    setRailOpen(undefined);

    // Selecting anything cancels a background observer/poll; a stream must never
    // paint a card the reader has left. The task itself keeps running server-side
    // (aborting an observer is only an unsubscribe — R4).
    stopWatching();
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
    for (const button of toolTabButtons.values()) button.setAttribute('aria-pressed', 'false');

    agentSlot.hidden = false;
    composer.hidden = false;
    stage.replaceChildren(current.view.pane);
    renderHarnessChrome();
    renderSessions();
    // The board follows the SELECTED instance only; switching harness never shows
    // the previous conversation's panels.
    paintPanels();
    runner.sync();
    setStatus(current.pending ? 'running' : 'idle', current.pending ? 'session running · observing' : undefined);
    // Re-derive controls for THIS instance: pending work belongs to its session,
    // and leaving a running conversation simply unsubscribes (work continues).
    setBusy(current.pending);
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
            // R4: switching is allowed while work is pending — the queue belongs to
            // the server and keeps running; the observer is just unsubscribed.
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

    // The Tools tab's session line always describes the SELECTED harness (R21.2):
    // the tab is where tools are reviewed and called, and a snapshot refreshed by a
    // manual core call must update "enabled for this session" there. The right rail
    // no longer renders any tool list.
    renderToolsSession(display, instance.sessionId, instance.discovered);

    // While a tool runner owns the centre, the head/agent row belong to the tool;
    // do not overwrite them.
    if (currentTool !== undefined) return;

    const locked = instance.sessionId !== undefined;

    headTitle.textContent = display.title;
    headName.textContent = display.name;
    // R21.1: no read-only branch. Editing a harness applies to its NEXT session;
    // a saved chat keeps what it started with (the conversation guarantee).
    headNote.textContent = locked
        ? instance.frozen !== undefined
            ? 'Viewing a saved session · agent team frozen'
            : 'Viewing a saved session'
        : 'Edits apply to new sessions';

    // A locked session renders the definition it started with; the live harness
    // may already have moved on.
    agentSlot.replaceChildren(renderAgents(instance));
};

const renderAgents = (instance: Instance): HTMLElement => {
    const display = instance.frozen ?? instance.descriptor;
    const members = membersOf(display);
    const locked = instance.sessionId !== undefined;
    // R21.1: the harness itself is always editable; only a saved session (frozen
    // team), an in-flight run, or a submit that is currently creating/answering a
    // session locks the row.
    const editable = !locked && !running && !submitting;

    const lockReason = locked
        ? instance.frozen !== undefined
            ? 'This saved session keeps the agent team it started with.'
            : 'This saved session cannot change its agent team here.'
        : running
          ? 'Stop the run before changing the agent team.'
          : undefined;

    // Effective model per member.
    //
    // Saved session (locked): `SessionSnapshot.agentModels` is the session's LIVE
    // effective map (R2) — the server replaces it on PATCH and the next model
    // request reads it, so displaying it is the truth even while the frozen
    // `harnessDefinition` (team + creation-time overrides) stays historical. A
    // legacy snapshot without the map falls back to the frozen descriptor's
    // overrides and finally to the session model.
    //
    // Harness without a session: only overrides are relevant; a member without one
    // uses the settings model (or the server's fallback when the field is blank),
    // which is passed as `fallbackModel` and rendered as that model id — never
    // "inherit".
    const overrides = agentModelsOf(display);
    const models: Record<string, string> = {};
    for (const name of members) {
        const model = locked
            ? (instance.sessionModels?.[name] ?? overrides[name] ?? instance.sessionModel)
            : overrides[name];
        if (model !== undefined && model.length > 0) models[name] = model;
    }

    // The actual model the no-override choice resolves to. For a new session it
    // is the typed model, else the server default (what mergeSettings applies to a
    // blank request).
    //
    // For a saved chat, `snapshot.model` is the PRIMARY's effective model, which is
    // not necessarily the session settings model when the primary has an override.
    // Use a member that has no frozen override instead: its effective model is the
    // session model. If every member is overridden (or an older snapshot has no
    // effective map), the fallback is unknown and the option says so rather than
    // labelling another agent's override as the default.
    const frozenOverrides = agentModelsOf(display);
    const hasFrozenOverrides = Object.keys(frozenOverrides).length > 0;
    const fallback = locked
        ? (members
              .filter((name) => frozenOverrides[name] === undefined)
              // The live effective map is authoritative. A legacy snapshot
              // without it can only name the session model when nothing was
              // overridden (otherwise `snapshot.model` may be the primary's
              // override, not the settings model).
              .map(
                  (name) =>
                      instance.sessionModels?.[name] ??
                      (hasFrozenOverrides ? undefined : instance.sessionModel)
              )
              .find((model): model is string => typeof model === 'string' && model.trim().length > 0) ??
          '')
        : defaultSessionModel();

    return createAgentRow({
        members,
        primary: primaryOf(display),
        agents: agentLibrary,
        editable,
        ...(lockReason === undefined ? {} : { lockReason }),
        models: {
            models,
            catalogue: modelIds,
            ...(fallback.length > 0 ? { fallbackModel: fallback } : {}),
            // R2: models are NOT part of the frozen team. A saved session edits its
            // live map through PATCH /sessions/:id, and an in-flight run keeps
            // streaming while the next request picks the new id up. The single-flight
            // guard lives in setAgentModel/patchSessionModels, not in this flag
            // (rendering while that PATCH is in flight must not look disabled).
            editable: locked || !running,
            // Tells the tile which promise the control makes: a session edit applies
            // to the next request in THIS chat, a harness edit to future sessions.
            ...(locked ? { session: true } : {}),
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
    // R21.1: no harness-level permission gate. A saved session and an in-flight run
    // are the only reasons to refuse an edit.
    if (instance.sessionId !== undefined || running) return;

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

// Change one member's model (R2). Where the edit goes depends on whether the
// conversation exists yet:
//
//   - SAVED SESSION (locked id present, idle or running): PATCH /sessions/:id with
//     the complete live `agentModels` map. The server reads that map when it builds
//     the NEXT model request, so the change takes effect without cancelling an
//     in-flight run. The frozen `harnessDefinition` stays historical — the team and
//     its promotion order are still not editable here.
//   - NO SESSION YET: the harness-level override path, unchanged from R9: the edit
//     applies to the next session.
//
// An empty value is the revert-to-default choice: delete the key so the member
// resolves to the session's settings model (or the server fallback), and send the
// resulting map explicitly (even `{}`) so clearing the last override really clears
// it. The dropdown labels that default with its real model id; "inherit" never
// appears in the UI.
const setAgentModel = async (name: string, model: string): Promise<void> => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    const members = membersOf(display);
    if (!members.includes(name)) return;

    const sessionId = instance.sessionId;
    if (sessionId !== undefined) {
        // Complete map = the live effective map (a session's own answer wins) with
        // any frozen/harness override as the base for members the server omitted.
        // Filtering to `members` keeps a legacy frozen-less session from sending a
        // key the server would reject against the real team.
        const next = modelsForMembers(
            { ...agentModelsOf(display), ...(instance.sessionModels ?? {}) },
            members
        );

        if (model.length === 0) delete next[name];
        else next[name] = model;

        await patchSessionModels(instance, sessionId, next);
        return;
    }

    // No session yet and one is being created right now. The server captures the
    // model map at creation, so a harness PATCH sent from here would race it: the
    // session could freeze the OLD map while the rail claims the new one. Refuse
    // loudly instead of silently changing a descriptor that the session already
    // ignored; the tile stays on its last confirmed value.
    if (creatingSessions > 0) {
        setStatus('error', 'agent models: a session is being created · retry once it exists');
        return;
    }

    // R21.1: the harness's legacy `editable` flag is not a gate. A run without a
    // session cannot happen (the run creates it first), but keep the guard for the
    // stale-handler case.
    if (running) return;

    const overrides = { ...agentModelsOf(display) };
    if (model.length === 0) delete overrides[name];
    else overrides[name] = model;

    await patchAgents(primaryOf(display), members, overrides, 'agent models');
};

// PATCH a saved session's live model map and apply the answer (R2).
//
// `savingAgents` is the existing single-flight guard for agent edits: a second
// select change while one PATCH is in flight is dropped rather than queued.
//
// The answer uses the GET /sessions/:id envelope (`{ session }`), so it is applied
// the same way — but ONLY the model fields and the directory row. The transcript is
// deliberately NOT rehydrated: a run may be streaming into this view, and replaying
// an answer that is a moment behind the stream would roll the tiles back.
const patchSessionModels = async (
    instance: Instance,
    id: string,
    models: Readonly<Record<string, string>>
): Promise<void> => {
    if (savingAgents) {
        // A second change while one PATCH is in flight is dropped, not queued. Redraw
        // so the control snaps back to the last CONFIRMED model instead of showing a
        // choice that will never be sent.
        if (current === instance) renderHarnessChrome();
        return;
    }

    savingAgents = true;

    // Only claim the status pill while idle. During a run the pill belongs to the
    // run, and a model edit must never look like it owns the request.
    if (!running) setStatus('running', 'saving agent models');

    try {
        const session = await updateSession(id, { agentModels: { ...models } });

        // The reader may have started a New session or opened another row while the
        // PATCH was in flight. Applying then would re-point THIS card at a session
        // it no longer shows, so drop the answer.
        if (instance.sessionId !== id) return;

        instance.sessionModels = agentModelsOf(session);
        if (typeof session.model === 'string') instance.sessionModel = session.model;
        upsertSession(session);
        renderSessions();

        if (current === instance) renderHarnessChrome();

        // Only claim the pill when nothing else owns it. A streaming run keeps its
        // own live status, and a session this tab is merely POLLING (reloaded
        // mid-run) still reports `running` — do not downgrade that to idle.
        if (running) {
            // Pending work owns the pill's colour; the sentence reports the save.
            setStatus('running', 'agent models saved · session running');
        } else if (session.status === 'running') {
            setStatus('running', 'agent models saved · session running');
        } else {
            setStatus('idle', 'agent models saved · next request');
        }
    } catch (error) {
        // Errors are shown even mid-run: a rejected model is something the reader
        // must see, and the streaming turn keeps its tiles either way. The row is
        // redrawn from the last confirmed map so it cannot pretend the change stuck.
        setStatus('error', `agent models: ${messageOf(error)}`);
        if (current === instance) renderHarnessChrome();
    } finally {
        savingAgents = false;
    }
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

// R21.2: the tool catalogue is the Tools tab and nothing else. This line is the
// tab's informational session status (the one piece the removed right-rail core
// dropdown actually carried that is still worth showing): which harness/session a
// session-bound call will mutate, and which tools toolRequest enabled there.
//
// It is updated from the SELECTED instance on every chrome rebuild, so a manual
// core call's snapshot refresh keeps it truthful without a reload.
const renderToolsSession = (
    descriptor: HarnessDescriptor,
    sessionId: string | undefined,
    discovered?: readonly string[]
): void => {
    const target =
        sessionId === undefined
            ? `${descriptor.name} (no session yet — a call creates one)`
            : `${descriptor.name} · session ${sessionId}`;
    const enabled = discovered ?? [];

    toolsSessionNote.textContent =
        enabled.length === 0
            ? `Session-bound tools run inside ${target}.`
            : `Session-bound tools run inside ${target} · enabled for this session: ${enabled.join(', ')}`;
};

// ---------------------------------------------------------------------------
// Tools tab: the complete catalogue and the manual runner (centre)
// ---------------------------------------------------------------------------
//
// R21.2: this is the ONLY tool listing. The right rail used to duplicate it (a
// catalogue plus a core-tools disclosure); both were removed so there is one place
// to review and call every server tool, core entries included.
// A `sessionBound` entry runs inside the selected harness's session
// (api.ts `callTool(name, parameters, sessionId)`); every other entry is a direct
// function call on the server.

const toolTabButtons = new Map<string, HTMLButtonElement>();

const toolsPane = el('div', 'pane tools-pane');
const toolsTabHead = el('div', 'tools-tab-head');
const toolsTabHint = el(
    'p',
    'tools-tab-hint',
    'Every tool the server lists, core tools included. Calls execute on the harness server — nothing runs in this browser. Session-bound tools (toolRequest, toolCreate, todoManage, agentDelegate) run inside the selected harness’s session; every other tool, including the core file and search tools, runs directly.'
);
const toolsSessionNote = el('p', 'tools-session-note field-hint', '');
toolsTabHead.append(el('h2', 'tools-tab-title', 'Tools'), toolsTabHint, toolsSessionNote);
const toolsTabList = el('div', 'tool-tab-list');
const runnerSlot = el('div', 'tool-runner-slot');
toolsPane.append(toolsTabHead, toolsTabList, runnerSlot);

const selectTool = (entry: ToolDescriptor): void => {
    if (running) return;

    stopPolling();

    currentTool = entry;
    // Selecting a tool switches to the Tools tab: that is the only tool listing
    // now (R21.2), so the full catalogue and the runner are always in view together.
    activeTab = 'tools';
    paintTabs();

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

// Full-width Tools tab listing: the single catalogue (R21.2). Every entry is a
// keyed button with enough room to show what it is and whether a session is needed.
// Group headings come from the server order, core entries included.
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

// Boot entry for the catalogue. R21.2: the Tools tab is the sole listing, so this
// only caches the entries (for `setTab`) and rebuilds that list — no right-rail
// duplicate to keep in sync any more.
const buildTools = (entries: readonly ToolDescriptor[]): void => {
    toolEntries = entries;
    buildToolsTab(entries);
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
            // Switching sessions is a view change, not a cancellation (R4).
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

// Does this snapshot still hold work? A running session status, an explicit
// `queueDepth` (new server), or any running/queued turn record (authoritative even
// when an older server omits queueDepth). Used for Stop/Reset and the pill.
const queueDepthOf = (session: SessionSnapshot): number => {
    const depth = (session as { queueDepth?: unknown }).queueDepth;
    return typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? depth : 0;
};

const pendingOf = (session: SessionSnapshot): boolean => {
    if (queueDepthOf(session) > 0) return true;
    if (session.status === 'running') return true;

    return session.turns.some((turn) => {
        const status = turn.status as string;
        return status === 'running' || status === 'queued';
    });
};

// Draw a snapshot into its harness view. The turns are the authoritative
// transcript; `messages` is the entry agent's own view of the same run and is
// informational. The frozen definition, when sent, becomes the displayed team.
//
// R4: this RECONCILES the timeline (same id → merge in place) rather than
// rebuilding it, so a reconnect/poll neither duplicates streamed text nor collapses
// the reader's expanded turn. It also refreshes what the composer's neighbours need
// to know: whether work is pending (Stop enabled, Reset disabled) and the activity
// rings (only still-running records light an agent).
const applySnapshot = (instance: Instance, session: SessionSnapshot): void => {
    const wasPending = instance.pending;

    instance.sessionId = session.id;

    // The frozen definition is the conversation's own team. Assign even when the
    // server omitted it (legacy): keeping a previous session's frozen team would
    // describe the wrong chat.
    instance.frozen = frozenDefinitionOf(session);

    // The session's LIVE effective per-agent models + the settings model they
    // inherit from (R2). The frozen `harnessDefinition` above is historical; this
    // map is not: PATCH /sessions/:id replaces it and the next request uses it.
    instance.sessionModels = agentModelsOf(session);
    instance.sessionModel = typeof session.model === 'string' ? session.model : undefined;
    instance.discovered = Array.isArray(session.discoveredTools)
        ? [...session.discoveredTools]
        : undefined;

    // Authoritative records: latest snapshot, keyed by the server's stable id.
    instance.records = new Map(session.turns.map((turn) => [turn.id, turn]));
    instance.pending = pendingOf(session);

    // Activity from a hydrated/polled record: ONLY a still-running turn can make
    // an agent busy. Replaying a settled turn (done/error/cancelled) lights
    // nothing, so opening history never animates old work. A queued task is not
    // working yet, so it lights nothing either.
    instance.activity.clear();
    if (instance.pending) {
        for (const name of activityOfTurns(session.turns)) instance.activity.add(name);
    }

    // R21.3: the tool panels are DERIVED from the server's recorded turns on every
    // snapshot — reload, poll, session open, reset, terminal frame. A completed
    // turn's panels are valid scratch state (they describe work that happened), but
    // they never light an agent ring: activity above only reads a RUNNING turn.
    // Recomputation also means no cross-session leakage: the board is replaced with
    // exactly what this conversation recorded.
    instance.panels = mediaOfTurns(session.turns);

    instance.view.reconcile(session.turns, session.model);
    instance.view.setTranscript(JSON.stringify(session.messages, null, 2));
    upsertSession(session);
    renderSessions();

    if (current !== instance) return;

    paintActivity(agentSlot, instance.activity);
    renderHarnessChrome();
    paintPanels();
    runner.sync();

    // Pill: pending work reports the queue; a transition out of pending is the
    // completion of the task the reader was watching. Opening settled history just
    // returns to idle (openSession may refine this for an error session).
    if (instance.pending) {
        const depth = queueDepthOf(session);
        setStatus(
            'running',
            session.status === 'running'
                ? depth > 0
                    ? `session running · ${depth} queued`
                    : 'session running'
                : 'session queued'
        );
    } else if (wasPending) {
        // The task this reader was watching has settled. A deliberate stop is
        // reported as "cancelled" (idle tone: it is not a failure); anything else
        // is the done line the UI has always shown.
        const last = session.turns[session.turns.length - 1];
        if (last?.status === 'cancelled') setStatus('idle', 'cancelled');
        else setStatus('done', `done · ${session.model} · ${session.status}`);
    } else if (session.status === 'error') {
        setStatus('error', session.lastError ?? 'session error');
    } else {
        setStatus('idle');
    }

    setBusy(instance.pending);
};

// ---------------------------------------------------------------------------
// Observing a session's queue (R4) — live events with a polling fallback
// ---------------------------------------------------------------------------
//
// GET /sessions/:id/events is the live source: ONE observer per selected session,
// opened when the session is selected (or a task is enqueued) and left open across
// every task. The server sends an initial snapshot, then `turn` upserts and `event`
// frames in FIFO order, and a fresh snapshot when the queue drains.
//
// The observer is disposable: aborting it only unsubscribes. Work is server-owned
// and continues when the page is hidden, reloaded, or viewing another session.
//
// Observation failure is NOT task failure. If the stream is lost (proxy timeout,
// server restart) the UI falls back to GET /sessions/:id polling; the pill reports
// the stream state, and the queue keeps running on the server.

const POLL_INTERVAL_MS = 1_000;
// About two minutes. Long enough for a real run, short enough that a stuck
// session stops asking rather than polling forever.
const POLL_MAX_ATTEMPTS = 120;
// One second between observer reconnects: long enough not to spin against a
// server that is closing the stream, short enough to feel live again.
const RECONNECT_DELAY_MS = 1_000;

// Recompute the pending flag from the latest turn records. The snapshot path sets
// it from the session; this is the incremental path for `turn` upserts, so Stop
// lights the moment a task is accepted and clears when the last record settles.
const refreshPending = (instance: Instance): void => {
    instance.pending = [...instance.records.values()].some((turn) => {
        const status = turn.status as string;
        return status === 'running' || status === 'queued';
    });
};

// Activity rings come from running records only. A queued task is not working
// yet, so it lights nothing (R4: queued is neutral).
const refreshActivity = (instance: Instance): void => {
    instance.activity.clear();

    const active = [...instance.records.values()].filter((turn) => turn.status === 'running');
    for (const name of activityOfTurns(active)) instance.activity.add(name);

    if (current === instance) paintActivity(agentSlot, instance.activity);
};

const stopPolling = (): void => {
    // The token invalidates an in-flight `getSession` response: a stale answer
    // must not repaint the card after the reader moved to another session.
    pollToken += 1;

    if (sessionsPollTimer !== undefined) {
        window.clearTimeout(sessionsPollTimer);
        sessionsPollTimer = undefined;
    }
};

// Tear the observer down. This only unsubscribes; it never cancels a task.
const stopWatching = (): void => {
    if (watch !== undefined) watch.controller.abort();
    watch = undefined;
};

// One item from the observer. Items for a session/observer this view no longer
// owns are dropped: a late frame must not paint into a conversation the reader
// left.
const onStreamItem = (
    instance: Instance,
    sessionId: string,
    item: SessionStreamItem,
    controller: AbortController
): void => {
    if (instance.sessionId !== sessionId) return;
    if (watch === undefined || watch.controller !== controller) return;

    if (item.type === 'turn') {
        // UPSERT the record and the tile. A queued turn is retained behind the
        // active one; a running turn starts the clock/ring; a terminal one settles.
        instance.records.set(item.turn.id, item.turn);
        instance.view.upsert(item.turn, instance.sessionModel);
        refreshPending(instance);
        refreshActivity(instance);

        if (current === instance) {
            if (instance.pending) {
                setStatus('running', 'session running · queue updated');
            } else {
                // The last retained task settled; the drain snapshot refines this.
                setStatus('done', `done · ${instance.sessionModel ?? ''}`.trim());
            }
            setBusy(instance.pending);
        }
        return;
    }

    if (item.type === 'event') {
        // Route by explicit turn id. The `turn` upsert precedes its events, so a
        // missing tile means this frame is for a turn this view does not hold
        // (another tab, a stale frame): the terminal snapshot reconciles it.
        const target = instance.view.turn(item.turnId);
        if (target === undefined) return;

        target.apply(item.event, frameAtOf(item));

        // Token tally, straight from the server: the frame carries the turn's
        // running sum, and the tile prints it verbatim. Frames without a tally
        // leave the last figure alone.
        const tally = frameUsageOf(item);
        if (tally !== undefined) target.setUsage(tally);

        // Per-agent ring. `start` activates the agent; a `done`/`error` for one
        // agent removes only that agent (a delegated sibling keeps spinning).
        applyActivity(instance.activity, item.event);
        if (current === instance) paintActivity(agentSlot, instance.activity);

        // R21.3 LIVE panels: a tool result may carry `ui`. Upsert it into THIS
        // instance's board immediately, scoped by the tool name.
        if (item.event.type === 'tool_result') {
            const changed = applyPanels(instance.panels, item.event.name, item.event.ui);
            if (changed > 0 && current === instance) paintPanels();
        }
        return;
    }

    // Terminal/drain frames (snapshot | failed) carry the complete session, turns
    // included. Apply it reconciles everything the frames may have missed.
    applySnapshot(instance, item.session);
    if (item.type === 'failed') setStatus('error', item.error.message);
};

// Re-read the session after an observer ends, then reopen it only if work is
// still pending. A drained queue already delivered its final snapshot.
const resyncSession = async (instance: Instance, sessionId: string): Promise<void> => {
    if (instance.sessionId !== sessionId) return;

    try {
        const session = await getSession(sessionId);
        if (instance.sessionId !== sessionId) return;

        applySnapshot(instance, session);

        if (instance.pending && watch === undefined) {
            window.setTimeout(() => {
                if (instance.sessionId === sessionId && instance.pending && watch === undefined) {
                    startWatching(instance, sessionId);
                }
            }, RECONNECT_DELAY_MS);
        }
    } catch {
        // The snapshot read failed too: fall back to bounded polling, which
        // reports its own trouble. The task is unaffected either way.
        pollSession(instance, sessionId);
    }
};

const startWatching = (instance: Instance, sessionId: string): void => {
    // One observer per selected session (R4). Enqueueing another task must NOT
    // tear down and reopen the stream: the existing observer already carries the
    // FIFO turn upserts (and reopening would race the still-reading response).
    if (watch !== undefined && watch.instance === instance && watch.sessionId === sessionId) {
        stopPolling();
        return;
    }

    stopWatching();
    stopPolling();

    // Nothing is running, so an observer would be an idle connection. The next
    // enqueue opens one.
    if (!instance.pending) return;

    const controller = new AbortController();
    watch = { instance, sessionId, controller };

    void observeSession(
        sessionId,
        (item) => onStreamItem(instance, sessionId, item, controller),
        controller.signal
    )
        .then(() => {
            if (watch?.controller !== controller) return;
            watch = undefined;
            void resyncSession(instance, sessionId);
        })
        .catch(() => {
            // An aborted observer is a deliberate unsubscribe, not an error.
            if (controller.signal.aborted) return;
            if (watch?.controller === controller) watch = undefined;

            if (instance.sessionId === sessionId) {
                setStatus(
                    instance.pending ? 'running' : 'idle',
                    instance.pending ? 'live stream lost · polling server' : 'live stream closed'
                );
                pollSession(instance, sessionId);
            }
        });
};

// Bounded GET /sessions/:id polling — the fallback when observation fails (or a
// page reloaded mid-run and cannot attach). It never POSTs a task, so it can never
// start a second run.
const pollSession = (instance: Instance, id: string): void => {
    stopPolling();
    stopWatching();

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
        // Pending is derived from the snapshot (queue included), not from the old
        // "status === running" test: a session that is only holding queued tasks
        // still needs to be followed.
        applySnapshot(instance, session);

        if (!pendingOf(session)) {
            stopPolling();
            return;
        }

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
    stopWatching();
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

    if (pendingOf(session)) {
        // R4: a reloaded/selected session with a live queue gets the observer, not
        // a one-way poll — queued tasks advance and stream here automatically.
        setStatus('running', session.status === 'running' ? 'session running' : 'session queued');
        startWatching(target, id);
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

    // New session is reachable from the phone rail: collapse it so the started
    // conversation is on screen (no-op on desktop).
    setRailOpen(undefined);

    stopWatching();
    stopPolling();
    instance.sessionId = undefined;
    instance.frozen = undefined;
    instance.sessionModels = undefined;
    instance.sessionModel = undefined;
    instance.discovered = undefined;
    // A new conversation has no pending work and no server records; the queue
    // belongs to the previous session and keeps running there.
    instance.pending = false;
    instance.records.clear();
    // A new conversation has no tool output yet: clearing the instance state and
    // repainting is what drops the previous session's board and any manual panels
    // that lived only in the browser (R21.3).
    instance.panels.clear();
    clearActivity();
    instance.view.clear();
    instance.view.setTranscript('[]');
    if (instance === current) forgetRememberedSession();
    renderHarnessChrome();
    renderSessions();
    paintPanels();
    setStatus('idle');
    input.focus();
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

// Paint every control from (a) whether the selected session has pending work and
// (b) whether a submit is in its short enqueue window.
//
// R4 keys:
//   - Run stays ENABLED while a task runs: submitting another task is how the
//     queue grows. Only `submitting` (the POST /tasks round trip) locks it.
//   - Stop is enabled whenever work is pending, including a session observed after
//     a reload (Stop then cancels ALL explicitly via cancelSession(id, true)).
//   - Reset/New session/harness switching/tabs stay locked while pending, because
//     they would tear down the view of a queue that is still running.
const paintControls = (): void => {
    const pending = running || current?.pending === true;

    runButton.disabled = submitting || !booted;
    stopButton.disabled = !pending;
    resetButton.disabled = submitting || pending;
    newSessionButton.disabled = submitting || pending || !booted;
    createHarnessButton.disabled = submitting || pending || !booted;

    // Harness/session switching is allowed while work is pending (R4): the queue
    // is server-owned, so leaving a conversation never stops it; the observer is
    // simply unsubscribed and reopened when the reader returns.
    for (const button of harnessButtons.values()) button.disabled = submitting || !booted;
    for (const button of toolTabButtons.values()) button.disabled = submitting || pending;
    chatTab.disabled = submitting || pending;
    toolsTab.disabled = submitting || pending;
    for (const row of sessionList.querySelectorAll<HTMLButtonElement>('.session')) {
        row.disabled = submitting;
    }

    // The agent row follows the pending lock for TEAM edits; models remain live
    // (R2) and are handled in renderHarnessChrome/renderAgents.
    if (current !== undefined) renderHarnessChrome();
};

const setBusy = (value: boolean): void => {
    running = value;

    // A creation form left open while work starts would still be submittable;
    // close it so no POST can race the queue.
    if (value && createPanel.isOpen()) createPanel.close();

    paintControls();
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

    // Announce the creation window so a model edit cannot race the freeze: the
    // server captures `agentModels` at creation (see setAgentModel).
    creatingSessions += 1;

    let session: SessionSnapshot;
    try {
        session = await createSession(instance.descriptor.name, settings);
    } finally {
        creatingSessions -= 1;
    }

    instance.sessionId = session.id;
    instance.frozen = frozenDefinitionOf(session);
    // The creation answer carries this session's effective model map, which is also
    // the map a later PATCH /sessions/:id replaces (R2).
    instance.sessionModels = agentModelsOf(session);
    instance.sessionModel = typeof session.model === 'string' ? session.model : undefined;
    instance.discovered = Array.isArray(session.discoveredTools)
        ? [...session.discoveredTools]
        : undefined;
    // A fresh session has no turns and no pending work; clear any stale queue state
    // from the conversation this card used to point at.
    instance.records = new Map(session.turns.map((turn) => [turn.id, turn]));
    instance.pending = pendingOf(session);
    // A freshly created session starts with an empty turn list, so recomputing from
    // it both empties the board and guarantees nothing from a previously viewed
    // session survives a New session.
    instance.panels = mediaOfTurns(session.turns);
    rememberSession(session.id);
    upsertSession(session);
    renderSessions();

    // A manual core call may have created this session; its runner shows the
    // session id now instead of "no session yet".
    if (current === instance) {
        renderHarnessChrome();
        paintPanels();
        runner.sync();
    }

    return session.id;
};

const run = async (): Promise<void> => {
    const prompt = input.value.trim();

    // Only the short enqueue window is single-flight (R4). Pending work does NOT
    // block a submit: a task submitted while another runs is the queue.
    if (submitting || savingAgents || prompt.length === 0) return;

    const instance = current;
    if (instance === undefined || currentTool !== undefined) return;

    if (instance.descriptor.requiresEndpoint && settings.baseURL.trim().length === 0) {
        instance.view.notice('set a base URL in Endpoint, then run again');
        setStatus('error', 'no endpoint configured');
        return;
    }

    // The tile exists before the request does, in submission order, so a second
    // task visibly sits BEHIND the active one from the first frame. It starts
    // `queued` and neutral: no ring, no clock.
    const turn = instance.view.begin(prompt);
    input.value = '';
    submitting = true;
    paintControls();
    setStatus('connecting', 'queueing task');

    let sessionId: string | undefined;

    try {
        // Session creation is part of the submit. `ensureSession` is deduplicated:
        // a task enqueued while another session creation is settling still gets
        // exactly one session (creatingSessions + the instance id).
        sessionId = await ensureSession(instance);

        // 202: the server retained the task and answered with its record. The
        // request is over here — execution and streaming happen on GET /events.
        const { session, turn: record } = await enqueueTask(sessionId, prompt);

        // Bind the server id/index and mirror the queue position. `merge` applies
        // only events that are not already on the tile (normally none yet), so a
        // retried answer can never duplicate a streamed prefix.
        turn.merge(record, session.model);

        upsertSession(session);
        renderSessions();

        if (instance.sessionId === sessionId) {
            // The POST answer is a full snapshot and already includes the new
            // turn: reconcile from it (the optimistic tile matches by id) and
            // start observing the queue. `applySnapshot` sets pending + the pill.
            applySnapshot(instance, session);
            startWatching(instance, sessionId);
            if (current === instance) rememberSession(sessionId);
        }
    } catch (error) {
        turn.flush();
        const message = messageOf(error);

        if (message.includes('Unknown session')) {
            // The server restarted (sessions are in memory). Forget the stale
            // pointer so the next task creates a fresh conversation; the session
            // list is re-read to show what actually exists now. The board belonged
            // to a conversation the server no longer holds.
            instance.sessionId = undefined;
            instance.frozen = undefined;
            instance.records.clear();
            instance.pending = false;
            instance.panels.clear();
            if (instance === current) paintPanels();
            if (instance === current) forgetRememberedSession();
            void refreshSessions();
        }

        // A failed submit is the TASK's failure (rejected input, unreachable
        // server): the tile says so and keeps its prompt. It is not a stream
        // failure, which is reported separately and never marks a task failed.
        turn.setState('error', message);
        instance.view.notice(`task failed: ${message}`, 'error');
        setStatus('error', message);
        void refreshSessions();
    } finally {
        submitting = false;
        // Repaint from the authoritative pending flag. The queue observer owns
        // every later transition; this only releases the enqueue lock.
        setBusy(current?.pending === true);
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
    const instance = current;
    const sessionId = instance?.sessionId;
    if (instance === undefined || sessionId === undefined || !instance.pending) return;

    // Stop is explicit and TOTAL (R4): `{ all: true }` makes the server abort the
    // active task AND cancel every retained queued record, so the queue drains
    // instead of immediately starting the next task. Merely aborting the observer
    // would only unsubscribe — work would keep running.
    stopWatching();

    // Immediate acknowledgement: the cancel round trip has not answered yet.
    setStatus('running', 'stopping');

    // Stopping is the user's terminal signal: no ring may keep spinning while the
    // cancellation round-trip finishes.
    instance.activity.clear();
    if (current === instance) paintActivity(agentSlot, instance.activity);

    void cancelSession(sessionId, true)
        .catch(() => false)
        .finally(() => {
            if (instance.sessionId !== sessionId) return;

            // Re-read the server's terminal records (the observer was unsubscribed
            // above). A cancel that failed leaves work pending, and the resync then
            // reopens observation rather than pretending it stopped.
            void resyncSession(instance, sessionId);
            void refreshSessions();
        });
});

resetButton.addEventListener('click', () => {
    const instance = current;
    if (instance === undefined) return;

    if (running) {
        instance.view.notice('cancel the running task before resetting');
        return;
    }

    const sessionId = instance.sessionId;
    // Reset is a server-side conversation wipe; the observer for its queue must
    // stop first (unsubscribe only) or late frames would repaint wiped turns.
    stopWatching();
    instance.view.clear();
    instance.view.setTranscript('[]');
    // Local reset clears the board immediately, before the server answers: the
    // conversation is being emptied, so its tool panels and queue state are too.
    instance.panels.clear();
    instance.pending = false;
    instance.records.clear();
    paintPanels();
    clearActivity();
    setStatus('idle');
    setBusy(false);

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
leftRail.append(harnessHead, harnessList, createPanel.element, leftPanels.element, endpoint);

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
    // Unsubscribe and stop every timer. The server keeps running any pending
    // queue (R4); a reload re-reads the snapshot and reopens the observer.
    stopWatching();
    stopPolling();
    clearActivity();

    for (const instance of instances.values()) instance.view.dispose();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const applyDefaults = (defaults: HarnessBootstrap['defaults']): void => {
    // Record the server fallback even when stored settings win: a blank settings
    // model still resolves to it server-side, and the per-agent dropdown labels
    // that real model (R18) instead of claiming "inherit" or an empty value.
    serverDefaultModel = defaults.model.trim();

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

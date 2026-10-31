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
//   - centre     — the selected harness title, the `center` tool-panel host, the
//                  transcript and the composer. The composer is ONE bordered frame
//                  with a notched routing label on its top border (R14), the single
//                  agent button on its LEFT edge (R16, opens the shared agent dialog
//                  — team, models and instructions) and stop/send on the right. The GLOBAL tools view (the
//                  full-width list of EVERY server tool — core entries included)
//                  replaces this column when the topbar's icon-only Tools toggle is
//                  pressed; activating one entry opens its manual runner in the
//                  shared modal. There is no tab strip (R3);
//   - right rail — the tool-contributed SCRATCH BOARD (primary panel host) and,
//                  below it, the sessions for the selected harness only.
//
// R21.2 removed the right rail's core-tools dropdown and tool catalogue. They
// duplicated the tools view, which is now the single place to review and call
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
// carries a frozen `harnessDefinition` for its member list and promotion order;
// the row renders those with its controls disabled. R7: there is no lock notice
// and no in-row "New session" link — the Sessions rail's own New session button
// is the independent way to start an editable conversation.
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
// activates, done/error removes only that agent, and terminal/cancel/switch/
// pagehide clear everything. A hydrated or polled RUNNING turn derives activity
// from its own events; settled history never lights a tile.
//
// Run/cancel is single-flight and instance-scoped: the composer's stop action uses
// the instance that started the run (never "whatever is selected now"), and harness
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
    DeleteThreadResult,
    HarnessDescriptor,
    RunnerSettings,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn,
    ToolDescriptor
} from '../server/protocol';
import type { HarnessActionChoice, HarnessAttachment } from '../types';
import { validateAttachments } from '../shared/attachments';
import {
    API_ROOT,
    answerAction,
    callTool,
    cancelSession,
    createHarness,
    createSession,
    deleteSession,
    deleteSessionThread,
    enqueueTask,
    getSession,
    listProviderModels,
    listSessions,
    loadBootstrap,
    observeSession,
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
    subagentsOf,
    uniqueNames
} from './contract';
import { createCreateHarnessPanel } from './ui/create-harness';
import { createAgentControl } from './ui/agent-control';
import type { AgentControl } from './ui/agent-control';
import { openAgentDialog } from './ui/agent-dialog';
import type { AgentDialog } from './ui/agent-dialog';
import { openDialog } from './ui/dialog';
import type { DialogHandle } from './ui/dialog';
import {
    composerActionOf,
    composerFieldHeight,
    composerMaxHeight,
    composerStopOf
} from './ui/composer';
import {
    attachmentFileName,
    attachmentPreviewUrl,
    attachmentRecordOf,
    clipboardFilesOf,
    createAttachmentCounters,
    nextAttachmentMarker,
    planAttachmentBatch,
    readFileAsBase64,
    releaseAttachmentPreview
} from './ui/attachments';
import type { AttachmentCounters, AttachmentKind } from './ui/attachments';
import {
    editorChips,
    editorCollapseChipGap,
    editorDeleteChips,
    editorInsertChips,
    editorInsertPlainText,
    editorRemoveAttachment,
    editorRestore,
    editorSelection,
    editorSetAttachmentState,
    editorSetText,
    editorSnapshot,
    editorText,
    installEditorAccessors
} from './ui/editor';
import {
    fileChipOf,
    fileGlobPattern,
    fileListEntriesOf,
    filePathsOf,
    fileQueryScope,
    fileToken,
    filterFilePathList,
    folderPathsOf,
    isReferenceableBlock,
    mentionTriggerAt,
    normalizeReferenceLabel,
    referenceChipOf,
    referencesOfChips
} from './ui/references';
import type { AgentBlockDescriptor, MentionTrigger } from './ui/references';
import { applyActivity, activityOfTurns, paintActivity } from './ui/activity';
import { highlightCode, looksLikeJson, prettyJson } from './ui/markdown';
import { applyPanels, createPanelHost, mediaOfTurns } from './ui/panels';
import type { PanelMedia } from './ui/panels';
import type { FilePreviewReader, FilePreviewResult } from './ui/file-preview';
import { createTurnBoard, labelSeedsOf } from './ui/turns';
import type { AnswerActionInput, TurnHandle } from './ui/turns';
// Persistent agent threads (R2/R5/R6/R7): roster reading and the routing decision for
// the next submit. See ui/threads.ts for the server contract; every read there is
// additive (legacy snapshots simply produce an empty roster).
//
// The compact `.thread-strip` band that used to sit above the transcript is GONE:
// it duplicated what the transcript already shows (each conversation's `.tile-thread`
// badge) and cost a permanent row of height. Focus is still fully usable without it —
// clicking a tile expands/focuses its conversation (ui/turns.ts `expand`), clicking
// the expanded tile collapses it again (`collapse`, the explicit unfocus), and the
// composer's notched routing label names the resulting target ("Continuing RR1" /
// "New thread"). Session-wide cancellation stays on the composer's `.composer-stop`.
import {
    resolveSubmitTarget,
    sessionThreadsOf,
    submitTargetLabel,
    turnThreadIdOf
} from './ui/threads';
import type { SessionThreadEntry } from './ui/threads';

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

// R11: the ONLY file request a transcript click may make. It is bounded by the
// preview dialog (`startLine`/`maxLines`) and goes through the existing direct
// tool endpoint — no new server route, no client filesystem access. A refused
// request surfaces the server's own message in the dialog.
const readFileForPreview: FilePreviewReader = async ({ path, startLine, maxLines }) => {
    const response = await callTool('fileRead', [{ path, startLine, maxLines }]);

    if (!response.ok) throw new Error(response.error.message);

    // The dialog reads this structurally (`files[]`); the cast only carries the
    // tool's documented result shape across the generic endpoint boundary.
    return response.result as FilePreviewResult;
};

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
    // N3: tell the board which session its turns belong to, so a human answer is
    // routed to the conversation that ASKED it and a stale question is expired
    // when the reader switches conversations.
    bindSession: (sessionId: string | undefined) => void;
    // Start a new user turn and return its handle. Called by `run()` *before* the
    // task is enqueued, so the tile shows `queued` (neutral, no clock) until the
    // server accepts it and advances it to running. Attachments are rendered as
    // chips on the optimistic tile, then replaced by the server record.
    //
    // `threadId` is the persistent thread the submit targets (continue/steer). It is
    // only the optimistic BADGE — the wire body carries the same id (api.ts
    // enqueueTask) — so a steering row is labelled with the thread it joins.
    begin: (
        prompt: string,
        attachments?: readonly HarnessAttachment[],
        threadId?: string
    ) => TurnHandle;
    // Drop an optimistic tile the server never accepted as its own turn. Steering a
    // running thread answers with the OWNING turn, so the temporary row must be
    // removed instead of lingering as an unbound queued ghost (see run()).
    discard: (turn: TurnHandle) => void;
    // Focus controls. Focus IS the expanded conversation (exactly one), and it is
    // what routes the next submit: continuing an idle/stopped thread or steering a
    // running one. `undefined` means "no focus": the next message opens a NEW thread.
    focusedThread: () => string | undefined;
    focusThread: (threadId: string) => boolean;
    // Explicitly drop the steering target (deleted thread, session teardown). Unlike
    // a tile toggle this is never a user intent to open a new thread, but it must
    // still stop the next submit from targeting the removed id (S3).
    clearFocus: () => void;
    // Hand the authoritative persistent-thread roster to the board. Repeated turns
    // of one thread share a badge in the transcript, so a conversation is never
    // presented as several independent threads. (The former strip also rendered
    // these rows; it is gone, and this is the only consumer.)
    setThreads: (threads: readonly SessionThreadEntry[]) => void;
    // R7: the tombstone-filtered raw snapshot the JSON transcript copies. Called
    // after every applied snapshot; `undefined` on session teardown.
    setSessionSnapshot: (snapshot: SessionSnapshot | undefined) => void;
    clear: () => void;
    notice: (text: string, tone?: 'info' | 'error') => void;
    // Session-scoped outcome line (a failed/cancelled run's detail), rendered in
    // the transcript pane. The topbar pill is app-scoped only, so run failures are
    // reported HERE and stay attached to the conversation they happened in
    // (R2: details remain visible; R1: never in the global header).
    setNotice: (text?: string, tone?: 'info' | 'error') => void;
    // R9 (T5): the entry-agent transcript button/dialog and their per-view text are
    // GONE — the serialized `session.messages` pane was duplicate plumbing nobody
    // used. The conversation itself is still rendered from the server's turns below
    // (and tool calls/arguments keep their own read-only details); only the
    // entry-agent raw-JSON surface was removed.
    //
    // Replace the whole transcript with the server's turns. Used on boot and on
    // session selection — the server record always wins over local projection.
    // `labelSeeds` is the snapshot's per-turn label counters (`labelSeedsOf`), so a
    // replay keeps every block label stable even when a deleted thread's turns are
    // no longer in the list.
    hydrate: (
        turns: readonly SessionTurn[],
        model?: string,
        keep?: string,
        labelSeeds?: Record<string, Record<string, number>>
    ) => TurnHandle[];
    // Reconcile the visible turns with a server snapshot/upsert without rebuilding
    // tiles (R4 queue): same ids are merged in place, new turns adopted, missing
    // ones dropped. This is the live path so streamed text is never duplicated and
    // the reader's expanded tile survives.
    reconcile: (
        turns: readonly SessionTurn[],
        model?: string,
        keep?: string,
        labelSeeds?: Record<string, Record<string, number>>
    ) => TurnHandle[];
    // Find, or adopt, the tile for one server turn (a `turn` upsert frame).
    upsert: (turn: SessionTurn, model?: string) => TurnHandle;
    // Look up a tile by the server turn id carried on a stream `event` frame.
    turn: (id: string) => TurnHandle | undefined;
    // Every real block in this conversation (root+nested), oldest→newest. The
    // composer's # reference popup reads it; labels are conversation-scoped, so a
    // label names one block and the popup matches the server's resolution.
    blocks: () => AgentBlockDescriptor[];
    // Stop every live timer this view owns (elapsed labels, tool durations).
    dispose: () => void;
};

// R8 re-introduces per-thread actions on the EXPANDED thread surfaces themselves
// (ui/turns.ts action bars): Transcript and Delete ride between each block's header
// and body, and the roster-only focus panel gets the same toolbar. The session-wide
// stop remains on the composer (`.composer-stop`, `stopRun`).
const createView = (
    descriptor: HarnessDescriptor,
    answer?: (input: AnswerActionInput) => Promise<void>,
    // R7: one explicit-open `getSession` read, guarded by the shell before it is
    // applied. R9: the board's Delete confirmation delegates the actual DELETE here.
    refreshTranscript?: (sessionId: string) => Promise<SessionSnapshot | undefined>,
    removeThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>
): View => {
    const pane = el('div', 'pane');
    const logWrap = el('div', 'log-wrap');

    // The empty state is deliberately short: the composer's agent control already
    // names *who* will run, and the old description wall made the centre noisy.
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
    const board = createTurnBoard({
        empty,
        // R11: file links in the transcript get the bounded read adapter. Omitted
        // in a standalone/embedded page, where the dialog reports it is unwired.
        readFile: readFileForPreview,
        ...(answer === undefined ? {} : { answerAction: answer }),
        ...(refreshTranscript === undefined
            ? {}
            : { refreshSessionSnapshot: refreshTranscript }),
        ...(removeThread === undefined ? {} : { deleteThread: removeThread }),
        // Focus follows the single expanded tile. Only the composer's routing line
        // has to repaint from here now that the thread strip is gone, so the
        // steering target stays visible in the same tick the reader
        // expands/collapses a conversation.
        onFocusChange: () => {
            // Only the SELECTED view owns the composer; a background harness's
            // reconcile must not repaint the routing line of another conversation.
            // Identity is the view's own pane, the one thing available before the
            // View object exists.
            if (current?.view.pane === pane) paintComposerTarget();
        }
    });

    const log = el('div', 'log');
    log.append(board.element);

    // R9 (T5): the per-view serialized transcript text/dialog is removed with the
    // composer button that opened it. Nothing else in this view depended on it.

    // Session outcome line. ONE element per view (per harness/session card), so a
    // failure from a conversation the reader left can never paint into another one:
    // `applySnapshot` reads the session's own `lastError` into it on every
    // authoritative answer and clears it once the session is healthy again. Hidden
    // by default so the common (no-error) view has no empty banner.
    const sessionNote = el('p', 'notice session-note');
    sessionNote.hidden = true;
    const setNotice = (text?: string, tone: 'info' | 'error' = 'error'): void => {
        const value = text?.trim() ?? '';
        sessionNote.textContent = value;
        sessionNote.dataset.tone = tone;
        sessionNote.hidden = value.length === 0;
    };

    logWrap.append(log);
    // Only the session outcome line sits between the harness head and the
    // transcript. The former thread strip band was removed (see the ui/threads
    // import comment): thread focus is expressed by the expanded tile plus the
    // composer's routing label, so no extra bar is needed here.
    pane.append(sessionNote, logWrap);

    // Only follow the stream when the reader has not scrolled away from the
    // bottom. Reading history while a run streams is a legitimate thing to do.
    const pinned = (): boolean => logWrap.scrollTop + logWrap.clientHeight >= logWrap.scrollHeight - 48;

    const stick = (follow: boolean): void => {
        if (follow) logWrap.scrollTop = logWrap.scrollHeight;
    };

    return {
        pane,
        bindSession: (sessionId) => {
            board.bindSession(sessionId);
        },
        begin: (prompt, attachments, threadId) => {
            const turn = board.begin(prompt, attachments, threadId);
            // A new turn is the one thing that always scrolls: the user just
            // submitted it.
            stick(true);
            return turn;
        },
        discard: (turn) => board.discard(turn),
        focusedThread: () => board.focusedThread(),
        focusThread: (threadId) => board.focusThread(threadId),
        clearFocus: () => board.collapse(),
        setThreads: (threads) => {
            // The BOARD owns canonical labels (S6), the persistent-id mapping for
            // child focus (S2) and the roster-only transcript. It may CLEAR a focus
            // the roster no longer describes, which reports through `onFocusChange`
            // and repaints the composer's routing line.
            board.setThreads(threads);
        },
        setSessionSnapshot: (snapshot) => {
            // The board owns the JSON transcript and delete protection; the shell
            // only supplies the tombstone-filtered authority (see applySnapshot).
            board.setSessionSnapshot(snapshot);
        },
        clear: () => {
            board.clear();
            logWrap.scrollTop = 0;
        },
        notice: (text, tone) => {
            board.notice(text, tone);
            stick(true);
        },
        setNotice,
        hydrate: (turns, model, keep, labelSeeds) => {
            const follow = pinned();
            const handles = board.hydrate(turns, {
                ...(model === undefined ? {} : { model }),
                ...(keep === undefined ? {} : { keep }),
                ...(labelSeeds === undefined ? {} : { labelSeeds })
            });
            stick(follow);
            return handles;
        },
        reconcile: (turns, model, keep, labelSeeds) => {
            const follow = pinned();
            const handles = board.reconcile(turns, {
                ...(model === undefined ? {} : { model }),
                ...(keep === undefined ? {} : { keep }),
                ...(labelSeeds === undefined ? {} : { labelSeeds })
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

            // The record for a prompt this browser is still enqueueing (the POST
            // answer has not arrived yet) must bind the optimistic tile instead of
            // adding a second row for the same task (R2). The server publishes the
            // queued `turn` upsert before the 202 body, so this is the normal path
            // for a task submitted while another one runs.
            const claimed = board.claim(turn.prompt);
            if (claimed !== undefined) {
                claimed.merge(turn, model);
                return claimed;
            }

            // A turn this browser did not submit (another tab, another observer) is
            // adopted from the server record. Adoption NEVER moves focus (S1): the
            // reader keeps whatever conversation they were reading.
            stick(pinned());
            return board.adopt(turn, model);
        },
        turn: (id) => board.find(id),
        blocks: () => board.blocks(),
        dispose: () => {
            // The entry-agent transcript dialog is gone (R9), so this view owns no
            // overlay of its own; the shared agent dialog is app-scoped and closed
            // by the shell's lifecycle helpers.
            board.destroy();
        }
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
    // agentDelegate has NO static example: its only valid target is one of the
    // SELECTED harness's subagents, and a hard-coded id (the old 'summarizer' one)
    // was wrong for every harness that does not configure it. The runner builds
    // that example from `delegateTargets` at show time (see `show` below).
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
//
// `delegateTargets` reads the SELECTED harness's subagent allowlist (live
// descriptor, or the frozen team of the open session). agentDelegate is the one
// core tool whose validity depends on the session's configuration: it is only
// registered when the harness declares subagents, so the runner must not offer an
// example naming an agent this harness does not have.
export type ToolRunnerOptions = {
    context: () => { harness?: string; sessionId?: string };
    ensureSession: () => Promise<string | undefined>;
    refreshSession: (sessionId: string) => Promise<void>;
    delegateTargets?: () => readonly string[];
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
    // R5/T6: the CURRENT result-box data for the dialog Copy action. Evaluated at
    // click time so a call that settles while the dialog is open copies its latest
    // result, not the initial placeholder.
    copyText: () => string;
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

    // The raw text behind the rendered result box. Copy uses this instead of the
    // highlighted DOM so no syntax spans, truncation or decoration leak into the
    // clipboard; it is updated by every `setOutput`, including errors/prompts.
    let outputText = '';
    let outputLabel = 'result';

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
        outputText = text;
        outputLabel = isError ? 'error' : 'result';
        outputHead.textContent = outputLabel;
        output.className = isError ? 'card tool-output is-error' : 'card tool-output';
        outputBody.innerHTML = highlightCode(prettyJson(text), looksLikeJson(text) ? 'json' : undefined);
        outputBody.dataset.language = looksLikeJson(text) ? 'json' : 'text';
    };

    // The runner's current useful data. The input controls are deliberately not
    // copied: they are editable arguments, not a result. The tool identity and the
    // result-box label give a pasted answer enough context to stand alone.
    const copyText = (): string => {
        const label = outputHead.textContent !== null && outputHead.textContent.length > 0
            ? outputHead.textContent
            : outputLabel;

        return [`Tool: ${active?.name ?? 'tool'}`, `Result: ${label}`, '', outputText].join('\n');
    };

    // Delegation is the one core tool whose VALIDITY depends on the selected
    // harness: the server registers agentDelegate only when the harness declares
    // subagents, so a hard-coded example (the old 'summarizer' one) named an agent
    // most harnesses do not have.
    //
    // `delegateKey` is the target list last painted (undefined = nothing painted
    // yet), so an ordinary `sync()` (called before every call and after every
    // selection change) only rewrites the example when the TEAM changed — never over
    // something the reader typed.
    //
    // Returns true when the selected harness offers no target, which the caller
    // must treat as "not callable here" (the server would answer 404).
    let delegateKey: string | undefined;

    const paintDelegate = (entry: ToolDescriptor): boolean => {
        if (entry.name !== 'agentDelegate') {
            delegateKey = undefined;
            return false;
        }

        const targets = [...(options.delegateTargets?.() ?? [])];
        const key = targets.join(',');
        const noTargets = targets.length === 0;

        if (key !== delegateKey) {
            delegateKey = key;
            args.value = noTargets
                ? '{}'
                : JSON.stringify(
                      {
                          agent: targets[0],
                          input: `Give ${targets[0]} everything it needs: the goal, the files or areas, the constraints, and the evidence you want back.`
                      },
                      null,
                      2
                  );
        }

        note.textContent = noTargets
            ? 'Core tool — this harness declares no subagents, so delegation is not available in its sessions. Add an agent to the team to enable one-level delegation.'
            : `Core tool — it runs inside the selected session and hands ONE subagent a self-contained brief. Targets for this harness: ${targets.join(', ')}. Subagents cannot delegate further.`;

        return noTargets;
    };

    // Session context line. Read live so a session created after the runner
    // opened is shown instead of "no session yet", and so a frozen chat reports
    // the session the call will actually use.
    const sync = (): void => {
        // A selection change can change the team under an open runner: repaint the
        // delegate example/availability so the pane never names an agent the
        // selected harness no longer has.
        if (active !== undefined) paintDelegate(active);

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

        // Delegation with no configured target is not a call the server can serve
        // (it answers 404 because agentDelegate is not registered at all). Disabled
        // button plus this guard keeps the pane honest.
        if (paintDelegate(entry)) return;

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
        copyText,
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

            // agentDelegate's example depends on the SELECTED team; every other
            // entry (including the server-wide catalogue listing) is team-independent.
            // Reset the painted-targets key so a re-show always repaints the example
            // from the current team rather than keeping the schema template.
            delegateKey = undefined;
            const noDelegateTargets = paintDelegate(entry);

            rule.textContent =
                single !== undefined
                    ? `Single-property rule: execute receives the value of "${single}", so this textarea holds that value (JSON), not a wrapper object.`
                    : count === 0
                      ? 'This schema declares no properties, so execute receives an empty object.'
                      : `execute receives the whole object, because the schema declares ${count} properties.`;

            // The server's availability hint wins for an unconfigured entry;
            // otherwise a delegation target problem is the actionable warning.
            availabilityNote.textContent =
                entry.availability?.state === 'unconfigured'
                    ? (entry.availability.hint ?? '')
                    : noDelegateTargets
                      ? 'Not available for the selected harness: it declares no subagents, so agentDelegate is not registered in its sessions.'
                      : '';
            availabilityNote.hidden = !unavailable && !noDelegateTargets;

            const blocked = unavailable || noDelegateTargets;
            callButton.disabled = blocked;
            args.disabled = blocked;

            setOutput(
                // The full hint is already rendered above the schema; repeating a
                // paragraph in the result box would just be noise.
                unavailable
                    ? 'Not configured on this server.'
                    : noDelegateTargets
                      ? 'Delegation is unavailable for this harness.'
                      : 'Nothing yet. Press “Call tool”.',
                blocked
            );
            outputHead.textContent = unavailable ? 'unconfigured' : noDelegateTargets ? 'unavailable' : 'result';
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
// R2: the visible "Harness UI" title is the phone drawer trigger. It is a real
// button (not a click handler on a div) so it is keyboard reachable and exposes
// `aria-controls`/`aria-expanded` for the harness listing. `syncBrandTrigger` below
// adds those disclosure semantics ONLY on phones; above 860px the rails are always
// visible, so the brand is a non-disclosure and is natively disabled (no tab stop,
// no misleading `aria-expanded=false`). Its visual styling is unchanged.
const brand = el('button', 'brand');
brand.type = 'button';
const brandMark = el('span', 'brand-mark', '◍');
brandMark.setAttribute('aria-hidden', 'true');
brand.append(brandMark, el('span', 'brand-name', 'Harness UI'));

// The status pill is the app's single live region, and it is APP-SCOPED: it
// announces startup/readiness and app/config failures to screen readers and shows
// a spinner on screen. Session and run state (queued/running/done/cancelled, a
// failed turn) is NOT announced here: it belongs to the transcript that owns it
// (turn tiles + the pane's session note). Text *and* movement carry the state, so
// colour is never the only signal.
const statusPill = el('span', 'status');
statusPill.dataset.state = 'idle';
statusPill.setAttribute('role', 'status');
statusPill.setAttribute('aria-live', 'polite');
statusPill.setAttribute('aria-atomic', 'true');

const statusDot = el('span', 'status-dot');
statusDot.setAttribute('aria-hidden', 'true');
const statusText = el('span', 'status-text', 'idle');
// R3 (T4): the CONCISE state is the only visible text, but the full diagnostic must
// still reach assistive tech — a `title` tooltip is mouse/hover only and is NOT
// announced by a `role="status"` live region. This visually hidden sibling lives
// INSIDE the live region, so `aria-atomic` announces "state + diagnostic" together.
// It is emptied (not just hidden) whenever there is no extra detail, so a stale
// diagnostic can never be read after the state resets.
const statusDetail = el('span', 'status-detail', '');
statusPill.append(statusDot, statusText, statusDetail);

// R3: Tools is a GLOBAL icon-only toggle in the top-right corner, not a centre tab.
// It opens the same full-width catalogue + manual runner in `stage`; the harness
// head, composer (with both flanking controls) is hidden while it is open (`setToolsView`).
//
// The glyph is decoration (`aria-hidden`), the accessible name is `aria-label`, and
// `aria-pressed` reports whether the tools view is showing, so the button is a real
// toggle for assistive tech rather than an unexplained icon.
const toolsToggle = el('button', 'tools-toggle');
toolsToggle.type = 'button';
toolsToggle.id = 'tools-toggle';
toolsToggle.setAttribute('aria-label', 'Tools');
toolsToggle.setAttribute('aria-controls', 'harness-stage');
toolsToggle.setAttribute('aria-pressed', 'false');
toolsToggle.title = 'Show or hide the tool catalogue';
// There is no catalogue to show until boot answers, and opening the view would
// replace the startup pane with "no tools". `paintControls` enables it once boot
// has reached a selected harness (the same pass that enables the rail actions).
toolsToggle.disabled = true;
const toolsGlyph = el('span', 'tools-toggle-icon', '⚒');
toolsGlyph.setAttribute('aria-hidden', 'true');
toolsToggle.append(toolsGlyph);

// The right cluster keeps the live status pill and the Tools toggle together at the
// top-right on every width. There is NO rail control in the topbar any more (R1): the
// harness listing is opened by the "Harness UI" brand button, and the scratch/sessions
// rail toggle lives on the harness title row (`.harness-title-row`, built below), so
// the phone topbar spends no room repeating a trigger that already exists.
const topbarRight = el('div', 'topbar-right');
topbarRight.append(statusPill, toolsToggle);

// Mobile rail toggle (R1/R4). Below 860px the right rail is collapsed by default, so
// the harness title row carries ONE independent disclosure for it. On every wider
// layout the rails are permanently visible and `.rail-toggles` is `display:none`
// (styles.css), which is why the state below is inert there — it only drives the
// phone layout.
//
// The LEFT rail needs no toggle: the brand button above already opens the harness
// listing (R1/R2), so a second hamburger would be a redundant control.
//
// R4: it is ICON-ONLY. The glyph is decorative (`aria-hidden`); the accessible name
// is the `aria-label` below, so a screen reader still announces which rail the button
// opens and the `title` explains the action on hover.
const railToggles = el('div', 'rail-toggles');

const railIcon = (glyph: string): HTMLSpanElement => {
    const icon = el('span', 'rail-toggle-icon', glyph);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
};

const rightRailToggle = el('button', 'button small rail-toggle rail-toggle-right');
rightRailToggle.type = 'button';
rightRailToggle.setAttribute('aria-controls', 'rail-right');
rightRailToggle.setAttribute('aria-expanded', 'false');
rightRailToggle.setAttribute('aria-label', 'Scratch board and sessions panel');
rightRailToggle.title = 'Show or hide the scratch board and sessions rail';
rightRailToggle.append(railIcon('▤'));
railToggles.append(rightRailToggle);

topbar.append(brand, topbarRight);

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
// R2: close affordance for the phone drawer. It is hidden by CSS on wider layouts,
// where the rail is permanent; main.ts wires it to the same `setRailOpen(undefined)`
// path as Escape, the backdrop and picking a harness.
const closeHarnessSidebar = el('button', 'button small rail-close', '×');
closeHarnessSidebar.type = 'button';
closeHarnessSidebar.setAttribute('aria-label', 'Close harnesses panel');
const harnessHeadActions = el('div', 'rail-head-actions');
harnessHeadActions.append(createHarnessButton, closeHarnessSidebar);
harnessHead.append(harnessHeading, harnessHeadActions);

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

// --- centre: harness head, transcript, composer (agent control right) -------
const center = el('main', 'center');

// R1: the harness head is a single title line. The title is a real BUTTON inside the
// `h1` (heading semantics preserved) that opens the harness details dialog: there is
// no disclosure arrow and no inline note toggle on a phone any more.
//
// F3: the SAME header band also shows the selected tool's name/group/meta while the
// tools view is open. Clicking a tools heading must NOT open a harness popup (R2), so
// the button is disabled while `showingTools` is true (paintToolsHead/selectTool set
// it); a disabled button is also out of the tab order, so the misleading affordance
// is not even reachable.
//
// The note (`.harness-note`) stays in the DOM and keeps its text: it is the desktop
// always-visible detail line, and the dialog reuses the same vocabulary.
const mainHead = el('header', 'harness-head');
const titleRow = el('div', 'harness-title-row');
const headTitle = el('h1', 'main-title', '');
// The button carries the visible title text, so `headTitle.textContent` (written by
// renderHarnessChrome/paintToolsHead/selectTool) always equals the title string and
// the existing head assertions keep reading the same value.
const headTitleButton = el('button', 'harness-title-button');
headTitleButton.type = 'button';
headTitleButton.setAttribute('aria-haspopup', 'dialog');
headTitleButton.title = 'Show harness details';
const headTitleText = el('span', 'harness-title-text', '');
headTitleButton.append(headTitleText);
headTitle.append(headTitleButton);
const headName = el('span', 'harness-id', '');
const headNote = el('p', 'harness-note', '');
headNote.id = 'harness-note';

// R2: one painter for the title trigger's state. The chat head names a harness, so
// the button advertises (and opens) the details dialog. The tools view names the
// catalogue or a tool instead, so the button is disabled, drops `aria-haspopup` and
// loses its action tooltip: a disabled button must not keep claiming a popup it will
// never open.
const paintHeadTitleTrigger = (enabled: boolean): void => {
    headTitleButton.disabled = !enabled;
    if (enabled) {
        headTitleButton.setAttribute('aria-haspopup', 'dialog');
        headTitleButton.title = 'Show harness details';
        return;
    }

    headTitleButton.removeAttribute('aria-haspopup');
    headTitleButton.removeAttribute('title');
};

// The open harness-details layer, if any. One at a time (a second open would stack a
// duplicate description), and every navigation path closes it so a dialog can never
// describe a harness that is no longer selected (R2).
let harnessDialog: DialogHandle | undefined;

const closeHarnessDialog = (): void => {
    harnessDialog?.close();
};

// Open the details dialog for the harness that is selected RIGHT NOW. Content is the
// selected display descriptor's description plus the same metadata the rail rows
// show (`harnessMeta`); nothing else is invented (R2: existing metadata only).
const openHarnessDetails = (trigger: HTMLElement): void => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    const body = el('div', 'harness-details');
    if (display.description.length > 0) {
        body.append(el('p', 'harness-details-description', display.description));
    }
    body.append(el('p', 'harness-details-meta', harnessMeta(display)));
    // The header's own note is hidden on a phone (styles.css), so the dialog repeats
    // it here: it is the existing "edits apply to new sessions" / "saved session"
    // context, not a new concept.
    if (headNote.textContent.length > 0) {
        body.append(el('p', 'harness-details-note', headNote.textContent));
    }

    let handle: DialogHandle | undefined;
    handle = openDialog({
        title: display.title,
        content: body,
        returnFocus: trigger,
        onClose: () => {
            // Identity check: a replacement open may already own the variable.
            if (harnessDialog !== handle) return;
            harnessDialog = undefined;
        }
    });

    harnessDialog = handle;
};

headTitleButton.addEventListener('click', () => {
    // Tools headings describe the catalogue or a tool, never a harness (R2).
    if (showingTools) return;
    if (harnessDialog !== undefined) {
        closeHarnessDialog();
        return;
    }
    openHarnessDetails(headTitleButton);
});

titleRow.append(headTitle, headName, railToggles);
mainHead.append(titleRow, headNote);

const agentSlot = el('div', 'agent-slot');

// `stage` is the single centre surface: the transcript, the global tools view or a
// status pane. It is NOT a tab panel (R3): the topbar Tools toggle points at it with
// `aria-controls`, and nothing claims a tab/tabpanel relationship.
const stage = el('div', 'stage');
stage.id = 'harness-stage';

// Composer (R9/R10 + R5): ONE input field with ONE action inside it.
//
//   - The contentEditable field starts at one line box and grows with its content
//     up to a line cap, then scrolls: 3 text lines on a phone viewport (<=860px) and
//     5 on desktop. `autoGrow` below is the only writer of its inline height and
//     derives the cap from the live computed line-height/padding/borders, so the cap
//     is measured in readable lines rather than a fixed pixel box.
//   - The action button is positioned inside the box, bottom-right, and keeps that
//     spot in every state (styles.css `.composer-action`). Its meaning follows the
//     state matrix in `ui/composer.ts`:
//         text present           -> submit (chevron/play); while a run is in flight
//                                   the same control queues the task (R4 preserved)
//         empty + pending work   -> stop (X)
//         empty + idle           -> no control at all
//   - Reset is gone (R10). Starting over is the Sessions rail's New session; the
//     server still owns POST /sessions/:id/reset for other clients (untouched).
//   - Keyboard (R1): Enter inserts a newline like any multiline editor; Ctrl/Cmd+
//     Enter is the shortcut that sends, and the in-field button stays the primary
//     send path. See the `keydown` listener below the submit wiring for the full
//     matrix (including @/# popup navigation).
//
// Attachments (T5 clip/attach) are INLINE chips in that field, not a second input:
//   - `.composer-body` is the column holding the error line and the field wrapper, so
//     `.composer-field`/`.composer-action` keep their exact layout contract
//     (composer-style.test.ts);
//   - there is NO attach button / hidden file input any more (R6): clipboard paste,
//     drag/drop and @ file lookup are the whole attachment surface;
//   - paste/drop file detection lives on the field/composer below. Each file becomes
//     one atomic chip; its serialized text is the plain marker and the bytes travel
//     separately in `attachments`.
//
// R9/R10/R11 (T5): the composer no longer has OUTSIDE flanks. The transcript button
// is gone, and the single agent button now lives INSIDE the field frame at its right
// edge, next to stop/send (see `.composer-controls` below). The text column keeps
// `flex: 1; min-width: 0`, so it is the element that shrinks; the controls never
// leave the border.
const composer = el('form', 'composer');

const composerBody = el('div', 'composer-body');

// R9 (T5): the entry-agent transcript button is REMOVED entirely. It was the
// composer's left flank and its only consumer of `session.messages`; deleting the
// node (rather than hiding it) keeps no dead control in the tab order.

// Chips now live INLINE in the contentEditable field (T5 R1): the old chip strip
// above the field is gone. The explicit error line stays above the field so a
// rejected batch / failed read is announced without moving the caret.
const attachmentError = el('p', 'composer-attachment-error');
attachmentError.id = 'composer-attachment-error';
attachmentError.setAttribute('role', 'status');
attachmentError.setAttribute('aria-live', 'polite');
attachmentError.hidden = true;

// Routing line (R5/R6): WHERE the next submit goes — a new thread, a connected new
// thread (the draft carries `#` references), or the focused thread (continue/steer).
// It is the visible half of focus: the reader can always see that a focused thread
// will receive their message before they send it. Not a live region — it changes on
// every keystroke and must not be announced repeatedly; the expanded tile's badge
// and this line carry the same state visually.
const composerTarget = el('p', 'composer-target');
composerTarget.hidden = true;
// R14 (T7): the routing line is also the frame's FLOATING LABEL. It keeps the same
// `<p class="composer-target">` node (thread-routing.test.ts / thread-session-scope
// .test.ts read its text and `data-mode`; attachments-main.test.ts reads the tag), but
// it is now positioned over the frame's top border as a notched outlined label
// instead of taking a row above the field. The id lets paintComposerTarget wire
// `aria-describedby` on the field while the label is visible, so the "where will this
// send?" promise is still announced without turning it into a second control.
composerTarget.id = 'composer-target';

// The field is the positioning context for the action, so the button travels with
// the box as it grows instead of sitting in a separate column.
const composerField = el('div', 'composer-field');
// R15 (T7): mirrors whether the notched label is painted. The stylesheet reserves the
// notch's top padding ONLY in that state (`.composer-field[data-target='true']`), so
// an idle composer with nothing to distinguish stays one input line tall. Set here
// rather than with `:has()` so every engine (and jsdom source tests) sees the same
// explicit state the paint pass writes in paintComposerTarget.
composerField.dataset.target = 'false';
// R1: ONE contentEditable surface. Chips are atomic non-editable spans
// (ui/editor.ts); its plain-text value is still the old marker grammar, so the
// server contract and attachment payload are unchanged.
const input = el('div', 'input composer-input');
input.setAttribute('contenteditable', 'true');
input.contentEditable = 'true';
// R9/R2 accessibility: the field has a real accessible name and multiline textbox
// semantics. No placeholder, for the same reason as before: it is not a label and
// vanishes as soon as the reader types.
input.setAttribute('role', 'textbox');
input.setAttribute('aria-multiline', 'true');
input.setAttribute('aria-label', 'Task message');
input.setAttribute('aria-autocomplete', 'list');
input.setAttribute('aria-haspopup', 'listbox');
input.setAttribute('aria-controls', 'composer-popup');
input.setAttribute('aria-expanded', 'false');
input.spellcheck = false;
// The textarea-compatible value/selection accessors are installed once. They keep
// insertAttachmentMarkers' captured-selection contract (and the draft-restore path)
// available on a chip-bearing surface.
installEditorAccessors(input);

// @ / # popup anchored at the caret inside the field. role=listbox + option rows
// mirror UniversalTextBox's mention popup, but the harness keeps its own keyboard
// submit (Ctrl/Cmd+Enter) and its plain Enter newline.
const composerPopup = el('div', 'composer-popup');
composerPopup.id = 'composer-popup';
composerPopup.setAttribute('role', 'listbox');
composerPopup.setAttribute('aria-label', 'Composer suggestions');
composerPopup.hidden = true;

// One button, switched by state — never two visible controls. It starts hidden
// (idle + empty) and type=submit so a future paint cannot submit a blank field
// by accident; `paintComposer` keeps type and label in sync with the matrix.
const actionButton = el('button', 'composer-action');
actionButton.type = 'submit';
actionButton.hidden = true;
// SESSION-WIDE stop-all (R5/R7), separate from the submit action on purpose: with
// independent threads running, "stop everything" must stay reachable while the
// reader has a draft in the field. It is painted only when the inline action is not
// already `stop` (ui/composer.ts `composerStopOf`), so there is never a second stop
// control in the same corner.
const stopAllButton = el('button', 'composer-stop');
stopAllButton.type = 'button';
stopAllButton.hidden = true;
stopAllButton.textContent = '×';
stopAllButton.setAttribute('aria-label', 'Stop all tasks');
stopAllButton.title = 'Stop all running and queued tasks';

// R10/R11 (T5) + R14/R16 (T7): ONE input frame. `.composer-field` is the visible
// border/background of the composer now, and its children are the notched label (out
// of flow), the agent button on the LEFT, the text column and a right-hand control
// row:
//
//     ┌ New thread ────────────────────────────────────┐
//     │ [ RR ]  textarea .................... [×] [▶] │
//     └───────────────────────────────────────────────┘
//
// The controls are FLOW children (not absolutely positioned), so they can never
// escape the frame — the previous design anchored the send control with
// `position: absolute` while the agent control lived outside the border, which is
// exactly the "button outside the input frame" the user reported. `.composer-field`
// is a flex row: the text disc keeps `flex: 1; min-width: 0` and shrinks first, and
// `.composer-controls` wraps internally at very small widths instead of pushing the
// send button out of the box.
//
// R16 (T7): the agent slot moved from the right cluster to the LEFT edge of the same
// frame, so the send/stop pair is untouched on the right and the agent button reads
// as part of the input (borderless/transparent in styles.css) rather than as a
// separate box. The agent dialog wiring is unchanged.
const composerControls = el('div', 'composer-controls');
composerControls.append(stopAllButton, actionButton);

// DOM order = visual order: label (absolute, so it is not a flex item), agent (left),
// text, popup (absolute), stop/send (right). The label stays FIRST so the notch reads
// before the input in the reading order too.
composerField.append(composerTarget, agentSlot, input, composerPopup, composerControls);
// R14 (T7): the routing label moved INSIDE the frame; the body column now holds only
// the (hidden unless there is a rejection) error line and the frame itself.
composerBody.append(attachmentError, composerField);

// R6: the attachment chooser (button + hidden file input) is deliberately gone:
// paste, drop and @ lookup cover attachments, and keeping either node would leave a
// dead control in the tab order and a stylesheet rule reserving space for it.
//
// The composer now has ONE child: the column with the field frame (R9 removed the
// left transcript flank; R10/R11 moved the agent button INSIDE the frame). The
// `.agent-slot` host stays the same node so the Tools view's existing hide/show
// (`agentSlot.hidden`, tools-tab.test.ts) is unchanged.
composer.append(composerBody);

// --- attachment draft state ------------------------------------------------
//
// `draftAttachments` is the ONE draft the composer owns. It is deliberately
// module-scoped (like the field's text) so switching sessions does not lose an
// attachment the user just pasted; only a SUCCESSFUL send (or the user pressing a
// chip's ×) removes an entry. Every entry carries the marker already in its inline
// chip, so the prompt and the payload can never drift.
//
// Reads are per-file: markers are inserted SYNCHRONOUSLY at the captured selection
// in clipboard order, then each file is encoded independently. A read failure
// removes only that marker/chip and reports it; the rest of the draft is intact.
// `attachmentReads` counts in-flight reads and gates the send action, so a turn
// can never be submitted with a missing payload.
type DraftAttachment = {
    id: string;
    kind: AttachmentKind;
    marker: string;
    name: string;
    mime: string;
    size: number;
    // Undefined until the FileReader completes (or forever, if the read failed and
    // the entry was removed).
    data: string | undefined;
    // Object URL for a raster image thumbnail; revoked on remove/reset/teardown.
    previewUrl?: string;
};

let draftAttachments: DraftAttachment[] = [];
let attachmentCounters: AttachmentCounters = createAttachmentCounters();
let attachmentReads = 0;
let attachmentSeq = 0;

const setAttachmentError = (message?: string): void => {
    const text = message?.trim() ?? '';
    attachmentError.textContent = text;
    attachmentError.hidden = text.length === 0;
};

// The payload for this draft. Only encoded entries are ready; callers must still
// check `attachmentReads` (an entry could be mid-read if state is inconsistent).
const readyAttachmentRecords = (): HarnessAttachment[] =>
    draftAttachments.flatMap((draft) =>
        draft.data === undefined
            ? []
            : [
                  {
                      id: draft.id,
                      kind: draft.kind,
                      marker: draft.marker,
                      name: draft.name,
                      mime: draft.mime,
                      size: draft.size,
                      data: draft.data
                  }
              ]
    );

const paintAttachments = (): void => {
    // Chips are INLINE: only their reading/ready state and remove affordance are
    // repainted. The draft text itself is never rewritten here — that would flatten
    // chips and lose the exact caret.
    for (const draft of draftAttachments) {
        editorSetAttachmentState(input, draft.id, draft.data === undefined ? 'reading' : undefined);
    }

    // During the short enqueue window the sent payload is frozen: remove controls
    // are disabled so a failed submit can restore the prompt and draft exactly.
    for (const button of Array.from(input.querySelectorAll<HTMLButtonElement>('[data-chip-remove]'))) {
        button.disabled = submitting;
    }

    // The action depends on whether any READY attachment exists.
    paintComposer();
};

// Forget one draft entry WITHOUT touching the field. Used by the chip removal
// button (which removes the DOM chip itself) and by the MutationObserver when the
// reader backspaces a chip.
const forgetDraftAttachment = (id: string): void => {
    const index = draftAttachments.findIndex((draft) => draft.id === id);
    if (index < 0) return;

    const [draft] = draftAttachments.splice(index, 1);
    if (draft !== undefined) releaseAttachmentPreview(draft.previewUrl);
};

// Remove one draft atomically: its inline chip, its object URL and its draft
// entry. The chip's serialized marker disappears with the DOM node, so the prompt
// and the bytes can never drift.
const removeDraftAttachment = (draft: DraftAttachment): void => {
    // The submit snapshot is frozen: no removal between capture and the 202/error.
    if (submitting) return;

    if (!draftAttachments.includes(draft)) return;

    forgetDraftAttachment(draft.id);
    editorRemoveAttachment(input, draft.id, draft.marker);
    autoGrow();
    paintAttachments();
};

// Finish one read. `data` is the canonical base64, or an Error describing the
// failure (reader error, malformed data URL, signature/MIME mismatch from the
// shared validator). The entry is removed on failure so the draft only ever
// contains sendable records; the text and every other chip stay untouched.
const finishAttachmentRead = (draft: DraftAttachment, data: string | Error): void => {
    attachmentReads = Math.max(0, attachmentReads - 1);

    // The user removed the chip while the read was in flight: nothing to apply.
    if (!draftAttachments.includes(draft)) {
        paintAttachments();
        return;
    }

    if (data instanceof Error) {
        forgetDraftAttachment(draft.id);
        editorRemoveAttachment(input, draft.id, draft.marker);

        setAttachmentError(`Could not attach "${draft.name}": ${messageOf(data)}`);
        autoGrow();
        paintAttachments();
        return;
    }

    try {
        // Validate the ENCODED record through the shared gate. This checks canonical
        // base64, size agreement and the magic signature; returning a detached copy
        // means the draft can only hold values the server would accept too.
        const record = attachmentRecordOf({
            id: draft.id,
            kind: draft.kind,
            marker: draft.marker,
            name: draft.name,
            mime: draft.mime,
            size: draft.size,
            data
        });

        draft.data = record.data;
        draft.size = record.size;
        draft.mime = record.mime;
    } catch (error) {
        forgetDraftAttachment(draft.id);
        editorRemoveAttachment(input, draft.id, draft.marker);
        setAttachmentError(`Could not attach "${draft.name}": ${messageOf(error)}`);
    }

    paintAttachments();
};

// Add a clipboard/drop batch. The budget gate runs BEFORE any bytes
// are read and is ATOMIC: one oversized/invalid file rejects the whole batch with
// an explicit reason, inserting nothing. A read failure afterwards is partial and
// per-file (see finishAttachmentRead) because the markers are already in the text.
//
// FREEZE: while a submit owns the enqueue window (`submitting`), no new draft entry
// may appear. Paste/drop are still intercepted by their handlers (the native
// paste/drop is always prevented), so a payload arriving during the window must be
// dropped here too. Otherwise the new
// chip sits in the cleared field while the keydown chip-delete and the chip
// MutationObserver both skip `submitting`, so a Backspace in that window could
// remove only the chip and leave bytes behind: an orphan attachment whose marker is
// not in any prompt.
const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    if (submitting) return;

    const plan = planAttachmentBatch(
        files.map((file) => ({ name: file.name, mime: file.type, size: file.size })),
        draftAttachments
    );

    if (!plan.ok) {
        setAttachmentError(plan.message);
        return;
    }

    setAttachmentError(undefined);

    // CAPTURE the selection before touching the field. Insertion is synchronous,
    // so the asynchronous reads never have to restore a caret the user may have
    // moved (the new text is already in place and the caret sits after it).
    const selection = editorSelection(input);

    const pending = files.map((file, index) => {
        const planned = plan.entries[index];
        const previewUrl = attachmentPreviewUrl(file, planned.kind);

        const draft: DraftAttachment = {
            id: `attach-${++attachmentSeq}`,
            kind: planned.kind,
            // Markers are allocated in clipboard order; a later removal never
            // renumbers the rest of the draft.
            marker: nextAttachmentMarker(attachmentCounters, planned.kind),
            name: attachmentFileName(file.name, planned.mime, attachmentSeq),
            mime: planned.mime,
            size: file.size,
            data: undefined,
            ...(previewUrl === undefined ? {} : { previewUrl })
        };

        return { file, draft };
    });

    draftAttachments.push(...pending.map((entry) => entry.draft));

    // Inline atomic chips (R1). Spacing/caret are identical to the old plain-text
    // `insertAttachmentMarkers`, so a marker still sits exactly where the caret
    // was and a paste mid-word pads both sides.
    editorInsertChips(
        input,
        selection,
        pending.map(({ draft }) => ({
            kind: 'attachment' as const,
            id: draft.id,
            label: draft.marker,
            ...(draft.previewUrl === undefined ? {} : { previewUrl: draft.previewUrl }),
            data: {
                kind: draft.kind,
                attachmentKind: draft.kind,
                attachmentName: draft.name
            }
        }))
    );

    attachmentReads += pending.length;
    paintAttachments();
    autoGrow();

    for (const { file, draft } of pending) {
        void readFileAsBase64(file).then(
            (data) => finishAttachmentRead(draft, data),
            (error: unknown) =>
                finishAttachmentRead(draft, error instanceof Error ? error : new Error(String(error)))
        );
    }
};

// OS clipboard files (screenshots copied from another app) land on paste. When
// files DO exist the clipboard's text is deliberately ignored so one gesture
// cannot insert both an image and its HTML/plain copy.
//
// EVERY paste is intercepted: the clipboard's text/html flavor is never parsed
// (no foreign markup, no script, no auto-chips). Only `text/plain` may be inserted,
// and an HTML-only / empty payload inserts nothing. Letting the native paste run
// for an "empty" plain string would still let the browser paste HTML.
input.addEventListener('paste', (event) => {
    event.preventDefault();
    closeComposerPopup();

    const files = clipboardFilesOf(event.clipboardData);
    if (files.length > 0) {
        addFiles(files);
        return;
    }

    const text =
        typeof event.clipboardData?.getData === 'function'
            ? event.clipboardData.getData('text/plain')
            : '';
    if (text.length === 0) return;

    editorInsertPlainText(input, editorSelection(input), text);
    autoGrow();
    paintComposer();
});

// Drag/drop is the second way in. Like paste, the native drop is ALWAYS prevented:
// a drop payload is either files (same gate/atomicity) or plain text, never HTML.
//
// R8: a drop never calls input.focus(). The insertion lands at the field's stored
// caret, but focus stays wherever the user had it (another control, or nowhere):
// the requirement is "no automatic focus", and a drop on the composer is not a
// request to move the caret for typing.
composer.addEventListener('dragover', (event) => {
    // Prevent default even for text: the drop handler owns what lands in the field.
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
});

composer.addEventListener('drop', (event) => {
    event.preventDefault();
    closeComposerPopup();

    const files = clipboardFilesOf(event.dataTransfer);
    if (files.length > 0) {
        addFiles(files);
        return;
    }

    const text =
        typeof event.dataTransfer?.getData === 'function'
            ? event.dataTransfer.getData('text/plain')
            : '';
    if (text.length === 0) return;

    // A drop can land anywhere on the composer; insert at the field's caret.
    editorInsertPlainText(input, editorSelection(input), text);
    autoGrow();
    paintComposer();
});


// R9/R5: grow/shrink the field with its content. The inline height is cleared FIRST
// so a deleted line measures the smaller content honestly; `composerFieldHeight` adds
// the border back (border-box) and clamps to the LINE cap computed here (3 text lines
// on a phone viewport, 5 on desktop), not to a fixed stylesheet box. jsdom has no
// layout (scrollHeight === 0), so the stylesheet's one-row height is left in place.
const autoGrow = (): void => {
    input.style.height = 'auto';

    const styles = getComputedStyle(input);
    const borders =
        (Number.parseFloat(styles.borderTopWidth) || 0) +
        (Number.parseFloat(styles.borderBottomWidth) || 0);
    // R5: read the cap from the LIVE computed metrics every time, so a resize across
    // the 860px breakpoint, a zoom change or a restyled font is honoured without a
    // keystroke. `window.innerWidth` is the same viewport width CSS media queries use.
    const maxHeight = composerMaxHeight({
        viewportWidth: window.innerWidth,
        lineHeight: styles.lineHeight,
        fontSize: styles.fontSize,
        paddingTop: styles.paddingTop,
        paddingBottom: styles.paddingBottom,
        borders
    });
    const height = composerFieldHeight(input.scrollHeight, borders, maxHeight);

    input.style.height = height > 0 ? `${height}px` : '';
};

// --- @ / # popup -------------------------------------------------------------
//
// One popup, three sources:
//   - `@query` files: a DEBOUNCED, query-aware fileGlob call (the existing /tools
//     endpoint; no new route). Each query changes the glob, so the server walk is
//     narrowed instead of permanently limiting the picker to the first 100 files.
//     A monotonically increasing sequence drops stale replies.
//   - `@query` folders: the SAME debounced beat also reads `fileList` for the typed
//     scope (fileGlob never yields directories), because folders are listed FIRST —
//     navigation on top, matching file hits below. Both answers carry the same
//     sequence, so they are painted together or not at all.
//   - `#query`: the board's REAL root+nested agent blocks (view.blocks()), deduped
//     by label with the latest occurrence winning (the server's plain-text
//     resolution rule). No network.
//
// A THIRD source fills the same list: `@query` also asks fileList for the folders
// of the typed scope (fileGlob yields files only), and those rows are placed FIRST
// so folder navigation reads top-down. A folder row ends with "/" and drills in.
//
// Accessibility: the field owns aria-expanded/aria-activedescendant and the popup
// is a listbox of option rows. Mouse rows preventDefault on mousedown so picking
// one never blurs the editor before the click runs.
type ComposerPopupItem =
    | { kind: 'file'; path: string }
    | { kind: 'folder'; path: string }
    | { kind: 'reference'; block: AgentBlockDescriptor };

type ComposerPopupState = {
    trigger: MentionTrigger;
    items: ComposerPopupItem[];
    index: number;
    truncated: boolean;
    loading: boolean;
    // A real lookup failure (HTTP/tool error). Rendered as an error note, NOT as
    // the empty-result "No matching files" message.
    error?: string;
};

let composerPopupState: ComposerPopupState | undefined;
let lookupTimer: number | undefined;
let lookupSeq = 0;

// Page size for the folder read. `fileList` defaults to 200 entries per page, which
// is already far more folders than a picker can usefully show; asking for more would
// only make the debounced read heavier for the same browsing experience.
const FILE_FOLDER_LIMIT = 200;

const closeComposerPopup = (): void => {
    if (lookupTimer !== undefined) {
        window.clearTimeout(lookupTimer);
        lookupTimer = undefined;
    }

    // Invalidate any in-flight lookup so its answer cannot reopen the popup.
    lookupSeq += 1;
    composerPopupState = undefined;
    composerPopup.hidden = true;
    composerPopup.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
};

const referencePopupItems = (query: string): ComposerPopupItem[] => {
    const blocks = (current?.view.blocks() ?? []).filter(isReferenceableBlock);
    // Latest occurrence wins: deleting before setting moves the label to the end,
    // so the popup shows the block the server would resolve for a plain `#LABEL`.
    // Failed/cancelled blocks are filtered FIRST, so they never hide an earlier
    // completed block with the same label.
    const latest = new Map<string, AgentBlockDescriptor>();
    for (const block of blocks) {
        const label = normalizeReferenceLabel(block.label);
        latest.delete(label);
        latest.set(label, block);
    }

    const labelQuery = normalizeReferenceLabel(query);
    const textQuery = query.trim().toLowerCase();

    return [...latest.values()]
        .filter((block) => {
            const label = normalizeReferenceLabel(block.label);
            const labelMatch = labelQuery.length === 0 || label.includes(labelQuery);
            const agentMatch = textQuery.length === 0 || block.agent.toLowerCase().includes(textQuery);
            return labelMatch || agentMatch;
        })
        .map((block) => ({ kind: 'reference' as const, block }));
};

const popupRow = (item: ComposerPopupItem, index: number, selected: boolean): HTMLElement => {
    const row = el('div', 'composer-popup-option');
    row.id = `composer-option-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    row.dataset.index = String(index);
    if (selected) row.dataset.active = 'true';

    if (item.kind === 'reference') {
        row.append(
            el('span', 'composer-popup-token', `#${normalizeReferenceLabel(item.block.label)}`),
            el('span', 'composer-popup-name', item.block.agent),
            el('span', 'composer-popup-state', item.block.status)
        );
    } else {
        // File and folder rows share the "@" token so the list reads as one mention
        // surface; a folder is marked in the dataset (styles.css bolds its name) and
        // its path already carries the trailing "/" the pick uses to drill in.
        row.append(el('span', 'composer-popup-token', '@'), el('span', 'composer-popup-name', item.path));
        row.title = item.path;
        if (item.kind === 'folder') row.dataset.folder = 'true';
    }

    return row;
};

const placeComposerPopup = (): void => {
    // Caret geometry is only available in a real layout; jsdom reports zeros and
    // the stylesheet fallback (top of the field) is used.
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (selection === null || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    // jsdom (and some embedders) do not implement Range geometry. Placement is
    // cosmetic; the stylesheet fallback keeps the popup attached to the field.
    if (typeof range.getBoundingClientRect !== 'function') return;

    const rect = range.getBoundingClientRect();
    const field = composerField.getBoundingClientRect();
    if (!Number.isFinite(rect.top)) return;

    // The composer is docked at the BOTTOM of the pane (styles.css `.pane` column:
    // `.log-wrap` flex:1, `.composer` last). Opening the list strictly below the
    // caret therefore painted it past the window edge — the list was anchored to a
    // side of the caret that has no room. Placement below is still the default;
    // the list flips above the caret line when that side has more room, and its
    // inline max-height shrinks to the chosen side so the rows scroll in place
    // instead of being clipped by the viewport.
    const gap = 4;
    // Reset the previous inline cap first so this measurement reflects the
    // stylesheet's own `max-height` rather than a stale clamp.
    composerPopup.style.maxHeight = '';

    // Every value below is 0 in jsdom, so `placeVertical` stays undefined there and
    // the measurements are only used once real layout exists.
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const popupHeight = composerPopup.offsetHeight;
    const popupWidth = composerPopup.offsetWidth;

    let top = Math.max(0, Math.round(rect.bottom - field.top + gap));

    if (popupHeight > 0 && viewportHeight > 0) {
        // Space available on each side of the caret line, minus the gap.
        const roomBelow = viewportHeight - rect.bottom - gap;
        const roomAbove = rect.top - gap;
        const openAbove = popupHeight > roomBelow && roomAbove > roomBelow;
        const room = openAbove ? roomAbove : roomBelow;

        if (openAbove) {
            // Sit the list on top of the caret line: its bottom edge is `gap` above
            // the line, using the height it will actually have after the cap below.
            const height = Math.min(popupHeight, Math.max(0, room));
            top = Math.round(rect.top - field.top - height - gap);
        } else {
            top = Math.max(0, Math.round(rect.bottom - field.top + gap));
        }

        // Only ever SHRINK: the stylesheet cap (240px) still controls the tall case,
        // because growing it here would let a long list paint over the transcript.
        const cssCap = Number.parseFloat(window.getComputedStyle(composerPopup).maxHeight);
        if (Number.isFinite(cssCap) && room < cssCap) {
            composerPopup.style.maxHeight = `${Math.max(0, Math.floor(room))}px`;
        }
    }

    // Horizontal: keep the list inside the field so a caret near its right edge does
    // not push the box out of the composer.
    let left = Math.max(0, Math.round(rect.left - field.left));
    if (popupWidth > 0 && field.width > 0 && left + popupWidth > field.width) {
        left = Math.max(0, Math.round(field.width - popupWidth));
    }

    composerPopup.style.top = `${top}px`;
    composerPopup.style.left = `${left}px`;
};

const paintComposerPopup = (): void => {
    const state = composerPopupState;
    if (state === undefined) {
        closeComposerPopup();
        return;
    }

    const rows: HTMLElement[] = [];

    if (state.error !== undefined) {
        const error = el('div', 'composer-popup-note composer-popup-error', state.error);
        error.setAttribute('role', 'presentation');
        rows.push(error);
    } else if (state.items.length === 0) {
        const note = el('div', 'composer-popup-note');
        note.setAttribute('role', 'presentation');
        note.textContent = state.loading
            ? 'Searching files…'
            : state.trigger.kind === 'file'
              ? 'No matching files'
              : 'No referenceable agent blocks';
        rows.push(note);
    } else {
        state.items.forEach((item, index) => {
            const row = popupRow(item, index, index === state.index);
            // Mouse down must not blur the editor before the click runs.
            row.addEventListener('mousedown', (event) => event.preventDefault());
            row.addEventListener('click', () => selectComposerPopup(index));
            rows.push(row);
        });
    }

    if (state.truncated && state.items.length > 0) {
        const more = el('div', 'composer-popup-note', 'Showing the first matches — type to narrow.');
        more.setAttribute('role', 'presentation');
        rows.push(more);
    }

    composerPopup.replaceChildren(...rows);
    composerPopup.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    if (state.items.length === 0) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', `composer-option-${state.index}`);

    placeComposerPopup();
};

const scheduleFileLookup = (trigger: MentionTrigger & { kind: 'file' }): void => {
    if (lookupTimer !== undefined) window.clearTimeout(lookupTimer);

    const seq = ++lookupSeq;
    // 160ms: long enough to coalesce normal typing, short enough that the list
    // feels live. The query is re-sent (not filtered from an old capped page).
    lookupTimer = window.setTimeout(() => {
        lookupTimer = undefined;
        void (async () => {
            const scope = fileQueryScope(trigger.query);
            // Folders come from `fileList` (fileGlob walks past directories), read
            // in parallel with the glob: one debounce still, two answers. The folder
            // read NEVER fails the picker — an unreadable half-typed directory or an
            // unconfigured tool just contributes no folder rows, and the glob keeps
            // ownership of the error note.
            const folders = callTool('fileList', { paths: [scope.directory], limit: FILE_FOLDER_LIMIT }).then(
                (reply) => (reply.ok ? folderPathsOf(fileListEntriesOf(reply.result), scope) : []),
                () => []
            );

            try {
                const [response, folderRows] = await Promise.all([
                    callTool('fileGlob', {
                        patterns: fileGlobPattern(trigger.query),
                        paths: ['.'],
                        maxResults: 100
                    }),
                    folders
                ]);

                // A newer keystroke, a closed popup, or a different trigger makes
                // this answer stale. Never paint it.
                if (seq !== lookupSeq) return;
                const state = composerPopupState;
                if (state === undefined || state.trigger.kind !== 'file' || state.trigger.query !== trigger.query) {
                    return;
                }

                if (!response.ok) {
                    // A refused lookup is an ERROR, not an empty result: the
                    // reader must not be told "no matching files" when the walk
                    // itself failed.
                    state.items = [];
                    state.truncated = false;
                    state.error = response.error.message;
                } else {
                    const result = response.result as { truncated?: unknown } | undefined;
                    const files = filterFilePathList(filePathsOf(response.result), trigger.query);
                    // FOLDER ROWS FIRST, then the matching files: navigation is the
                    // top of the list, so a folder is never buried under file hits.
                    state.items = [
                        ...folderRows.map((path) => ({ kind: 'folder' as const, path })),
                        ...files.map((path) => ({ kind: 'file' as const, path }))
                    ];
                    state.truncated = result?.truncated === true;
                    state.error = undefined;
                }

                state.loading = false;
                state.index = 0;
                paintComposerPopup();
            } catch (error) {
                if (seq !== lookupSeq) return;
                const state = composerPopupState;
                if (state === undefined || state.trigger.kind !== 'file') return;

                state.items = [];
                state.loading = false;
                state.error = messageOf(error);
                paintComposerPopup();
            }
        })();
    }, 160);
};

// Re-evaluate the trigger at the caret. Called on input and on arrow/home/end
// key moves; a non-collapsed selection or no trigger closes the popup.
const updateComposerPopup = (): void => {
    const selection = editorSelection(input);
    if (selection.start !== selection.end) {
        closeComposerPopup();
        return;
    }

    const trigger = mentionTriggerAt(editorText(input), selection.start);
    if (trigger === undefined) {
        closeComposerPopup();
        return;
    }

    if (trigger.kind === 'reference') {
        const items = referencePopupItems(trigger.query);
        const state = composerPopupState;
        const same =
            state !== undefined && state.trigger.kind === 'reference' && state.trigger.start === trigger.start;

        composerPopupState = {
            trigger,
            items,
            index: same ? Math.min(state.index, Math.max(0, items.length - 1)) : 0,
            truncated: false,
            loading: false
        };
        paintComposerPopup();
        return;
    }

    const state = composerPopupState;
    const same = state !== undefined && state.trigger.kind === 'file' && state.trigger.start === trigger.start;

    if (same && state.trigger.query === trigger.query && state.error === undefined) return;

    // A new @ query: show the previous query's rows (if any) until this answer
    // arrives, then replace them. `loading` only renders when there is nothing to
    // show, so typing does not flicker an empty list.
    composerPopupState = {
        trigger,
        items: same ? state.items : [],
        index: 0,
        truncated: false,
        loading: true
    };
    paintComposerPopup();
    scheduleFileLookup(trigger);
};

const moveComposerPopup = (delta: number): boolean => {
    const state = composerPopupState;
    if (state === undefined || state.items.length === 0) return false;

    state.index = (state.index + delta + state.items.length) % state.items.length;
    paintComposerPopup();
    return true;
};

// Pick the active row: replace `[trigger.start, caret)` with one atomic chip, or —
// for a folder row — with the plain `@dir/` text that drills into it.
// Returns false when there is nothing to pick, so Enter can fall through to
// newline / submit.
const selectComposerPopup = (index = composerPopupState?.index): boolean => {
    const state = composerPopupState;
    if (state === undefined || index === undefined) return false;

    const item = state.items[index];
    if (item === undefined) return false;

    const caret = editorSelection(input).end;
    const range = { start: state.trigger.start, end: Math.max(state.trigger.start, caret) };

    // A folder row attaches nothing: it TYPES the folder path (with its trailing
    // "/") over the query and immediately re-opens the picker for that directory,
    // so "@" browsing is drill-down instead of a dead token. Plain text, not a chip:
    // only files become file chips.
    if (item.kind === 'folder') {
        editorInsertPlainText(input, range, fileToken(item.path));
        autoGrow();
        paintComposer();
        updateComposerPopup();
        return true;
    }

    const chip = item.kind === 'file' ? fileChipOf(item.path) : referenceChipOf(item.block);

    editorInsertChips(input, range, [chip]);
    closeComposerPopup();
    autoGrow();
    paintComposer();
    return true;
};

// Paint the single action from the same `pending` value `paintControls` uses: the
// local run flag OR the selected session's server-owned queue.
//
// Labels/titles are the accessible names (the glyph is decorative): the button is a
// real <button>, so both pointer and keyboard activate it. In submit mode it is the
// form's submit button, so clicking it and pressing Ctrl/Cmd+Enter share one path
// (R10: queuing behavior untouched); a bare Enter stays a native newline (see the
// keydown contract below). In stop mode it is a plain button wired to `stopRun`.
// Count draft references whose target turn has not settled yet (queued/running).
// The server only steers WITH reference context when every target is already `done`
// (sessions.ts `composeSteerReferences` returns undefined otherwise) — a live target
// makes the submit a queued continuation in the focused thread. `records` is the
// authoritative per-turn map (`Instance.records`); an id it does not know is already
// gone and `purgeStaleReferences`/the submit boundary filter drop it, so it must not
// inflate this count.
const unfinishedReferenceCount = (
    records: ReadonlyMap<string, SessionTurn> | undefined,
    references: readonly { turnId: string }[]
): number => {
    if (records === undefined) return 0;

    return references.filter((reference) => {
        const record = records.get(reference.turnId);

        return record !== undefined && (record.status === 'queued' || record.status === 'running');
    }).length;
};

// Paint the composer's routing line: where this draft will go if sent now. It reads
// the SAME inputs as `run()` (focus + `#` reference chips + ready attachments)
// through the same pure helper (`resolveSubmitTarget`), so the promise and the
// request cannot disagree.
const paintComposerTarget = (): void => {
    const instance = current;
    const references = referencesOfChips(editorChips(input));
    const target = resolveSubmitTarget({
        focus: instance?.view.focusedThread(),
        threads: instance?.threads ?? [],
        references: references.length,
        // Attachments are never steered, so their presence already turns a running
        // target into a queued continuation; the label must say so up front.
        attachments: draftAttachments.reduce(
            (count, draft) => count + (draft.data === undefined ? 0 : 1),
            0
        ),
        unfinishedReferences: unfinishedReferenceCount(instance?.records, references)
    });

    composerTarget.textContent = submitTargetLabel(target);
    composerTarget.dataset.mode = target.mode;
    // "New thread" is only worth saying when this session HAS threads to distinguish
    // from (or when a reference just turned it into a connected thread). A legacy
    // session therefore shows no label at all.
    const showTarget = !(target.mode === 'new' && (instance?.threads.length ?? 0) === 0);
    composerTarget.hidden = !showTarget;

    // R14 (T7): the routing line is the frame's notched label. These two writes keep
    // the visual notch and the accessible description in the SAME state:
    //   - `data-target` on the frame reserves the notch's top padding only while the
    //     label is painted, which is what keeps the idle composer one line tall;
    //   - `aria-describedby` is removed while hidden: a description that points at a
    //     `display:none` node is silently dropped by AT anyway, so removing it keeps
    //     the DOM honest (and the field keeps its own `aria-label` = "Task message").
    composerField.dataset.target = showTarget ? 'true' : 'false';
    if (showTarget) input.setAttribute('aria-describedby', 'composer-target');
    else input.removeAttribute('aria-describedby');
};

const paintComposer = (): void => {
    const pending = running || current?.pending === true;
    // Only READY attachments count as submittable content; a still-encoding file is
    // shown as a pending chip but cannot turn the empty field into a send.
    const ready = draftAttachments.reduce((count, draft) => count + (draft.data === undefined ? 0 : 1), 0);
    const action = composerActionOf(editorText(input), pending, ready);

    actionButton.dataset.action = action;
    actionButton.hidden = action === 'none';

    // Stop-all (R5/R7): visible while work is pending UNLESS the inline action is
    // already the stop `×` (empty field). Typing while threads run therefore swaps to
    // submit + a separate stop, instead of hiding the only cancellation control.
    const showStop = composerStopOf(action, pending);
    stopAllButton.hidden = !showStop;
    stopAllButton.disabled = !booted;
    // Two 28px circles need the right gutter; one does not.
    composer.classList.toggle('has-stop', showStop);
    // The target line follows the same paint as the action: focus changes and
    // reference chips both move it.
    paintComposerTarget();
    // Submit follows the old Run guard exactly (the short enqueue window + boot).
    // A read in flight disables submit: the payload is not complete yet, and the
    // stop state stays live because that state requires pending work.
    const reading = attachmentReads > 0;
    actionButton.disabled = action === 'submit' ? submitting || !booted || reading : false;
    actionButton.type = action === 'stop' ? 'button' : 'submit';

    if (action === 'stop') {
        actionButton.textContent = '×';
        actionButton.setAttribute('aria-label', 'Stop the running task');
        actionButton.title = 'Stop';
        return;
    }

    actionButton.textContent = '▶';
    if (action === 'submit' && reading) {
        actionButton.setAttribute('aria-label', 'Send task — attachments are still loading');
        actionButton.title = 'Reading the attached file…';
        return;
    }

    actionButton.setAttribute('aria-label', 'Send task');
    // The title must state the real shortcut (R1): Enter is a newline now, so the
    // only keyboard send is Ctrl+Enter (Cmd+Enter on macOS).
    actionButton.title = 'Send (Ctrl/Cmd+Enter)';
};

// Typing / deletion is the only thing that changes the action outside a
// paintControls pass: measure the new height, re-derive the icon, and re-evaluate
// an @/# trigger at the caret.
input.addEventListener('input', () => {
    autoGrow();
    paintComposer();
    updateComposerPopup();
});

// Caret moves can enter or leave an @/# query without changing the text.
input.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        updateComposerPopup();
    }
});

// Leaving the field closes the popup. Popup rows preventDefault on mousedown, so
// a real blur only happens when the reader actually left the composer.
input.addEventListener('blur', () => {
    closeComposerPopup();
});

// Clicking a chip's × removes that draft atomically. The chip itself is inside a
// contenteditable=false island, so the click cannot move the caret into it.
composer.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest<HTMLElement>('[data-chip-remove]');
    if (button === null) return;

    event.preventDefault();
    const draft = draftAttachments.find((entry) => entry.id === button.dataset.chipRemove);
    if (draft !== undefined) removeDraftAttachment(draft);
});

// Backspace/Delete/cut removes an atomic chip inside the browser's editing
// machinery, not in our handlers. Synchronize the DRAFT to the surviving chips:
// a chip the reader deleted must drop its bytes, preview URL and record. The
// submit window is frozen (the payload was captured; a failed submit restores the
// exact snapshot), so removals during `submitting` are ignored.
const chipObserver = new MutationObserver((records) => {
    if (submitting) return;

    let changed = false;

    for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
            // Skip moves (a browser can transiently detach/re-insert a node).
            if (node.isConnected) continue;
            if (!(node instanceof Element)) continue;

            const chips =
                node.getAttribute('data-chip') === 'attachment'
                    ? [node as HTMLElement]
                    : Array.from(node.querySelectorAll<HTMLElement>('[data-chip="attachment"]'));

            for (const chip of chips) {
                const id = chip.dataset.chipId ?? '';
                if (!draftAttachments.some((draft) => draft.id === id)) continue;

                editorCollapseChipGap(record.previousSibling, record.nextSibling);
                forgetDraftAttachment(id);
                changed = true;
            }
        }
    }

    if (!changed) return;

    autoGrow();
    paintAttachments();
});

chipObserver.observe(input, { childList: true, subtree: true });

// R9/R5 responsive: a layout reflow (phone rail opening, window resize, rotation)
// changes the wrap width — and possibly the cap itself when the 860px breakpoint is
// crossed — without a keystroke, so the last inline height would clip the text.
// Re-measure; the browser resizes the element before this listener runs.
window.addEventListener('resize', () => {
    autoGrow();
});


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
// R5/T7: `agentSlot` lives inside the `.composer-field` frame now (LEFT edge, R16),
// NOT under the head. The centre keeps the head, the panel host, the stage and the
// composer.
center.append(mainHead, centerPanels.element, stage, composer);

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

// The element that opened the current phone rail. Restoring focus there on close is
// what keeps the drawer usable from the keyboard: without it, hiding the rail's own
// close button leaves focus on <body> after Escape, the backdrop, or picking a row.
let railReturnFocus: HTMLElement | undefined;

// One query instance for the drawer state: `isPhoneLayout` and the resize listener
// must observe the same MediaQueryList. `matchMedia` is absent in jsdom and very old
// browsers: that environment is treated as phone-sized so the drawer remains
// reachable and testable. It is defined everywhere a real desktop browser runs.
const phoneMedia = window.matchMedia?.('(max-width: 860px)');
const isPhoneLayout = (): boolean => phoneMedia?.matches ?? true;

// Apply the platform-appropriate brand semantics:
//   - phone: a real disclosure trigger, enabled, with `aria-controls` and the live
//     `aria-expanded` state;
//   - desktop/tablet: the rail is permanently visible, so the brand is NOT a
//     disclosure. Native `disabled` removes it from the tab order and prevents the
//     no-op click; the ARIA disclosure attributes and action title are removed so
//     assistive tech never hears a false "collapsed" state. `.brand`'s author styles
//     keep the title visually identical to the former text label.
const syncBrandTrigger = (): void => {
    if (isPhoneLayout()) {
        brand.disabled = false;
        brand.setAttribute('aria-controls', 'rail-left');
        brand.setAttribute('aria-expanded', openRail === 'left' ? 'true' : 'false');
        brand.title = 'Show or hide harnesses';
        return;
    }

    brand.disabled = true;
    brand.removeAttribute('aria-controls');
    brand.removeAttribute('aria-expanded');
    brand.removeAttribute('title');
};

// One painter for the whole state: the shell attribute drives CSS, the two toggles'
// `aria-expanded` drives the accessibility tree. `undefined` removes the attribute
// so the collapsed default has no lingering data state to style. `trigger` is the
// control that opened the rail, so closing always restores focus there even when the
// reader switches from one rail to the other.
const setRailOpen = (side: 'left' | 'right' | undefined, trigger?: HTMLElement): void => {
    openRail = side;

    if (side === undefined) delete shell.dataset.railOpen;
    else shell.dataset.railOpen = side;

    // R1: the left rail has no topbar toggle any more (the brand opens it), so only
    // the right rail's own control reports `aria-expanded` here.
    rightRailToggle.setAttribute('aria-expanded', side === 'right' ? 'true' : 'false');
    // The brand is only a disclosure on a phone; on desktop this disables it and
    // strips the ARIA state rather than publishing a misleading collapsed control.
    syncBrandTrigger();

    if (side !== undefined) {
        // The explicit trigger wins. The active-element fallback keeps programmatic
        // opens honest without relying on browser click focus behaviour.
        const active = document.activeElement;
        railReturnFocus =
            trigger ??
            (active instanceof HTMLElement && active !== document.body && active !== document.documentElement
                ? active
                : undefined);

        // The harness drawer is modal-ish: move focus to its own close control so
        // Escape/Tab and the dismiss affordance are immediately reachable.
        if (side === 'left') closeHarnessSidebar.focus({ preventScroll: true });
        return;
    }

    // Closed: hand focus back to the trigger when it is still in the page. A
    // programmatic close (selecting a harness / starting a session) is harmless
    // here because the trigger is a persistent topbar control.
    const returnFocus = railReturnFocus;
    railReturnFocus = undefined;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
};

// Initial platform pass: desktop disables the brand before first paint; a phone gets
// the familiar collapsed disclosure state.
syncBrandTrigger();

// Toggling the open side closes it (the button is a real toggle), and opening it
// closes the other side: the two rails are exclusive on a phone.
rightRailToggle.addEventListener('click', () => {
    setRailOpen(openRail === 'right' ? undefined : 'right', rightRailToggle);
});

// R2: clicking the "Harness UI" brand opens the harness DRAWER on sm/mobile. It is
// a toggle, so a second click closes it. `syncBrandTrigger` natively disables the
// button above 860px; the media guard here is the second line of defence against a
// programmatic click while a resize transition is in flight.
brand.addEventListener('click', () => {
    if (!isPhoneLayout()) return;
    setRailOpen(openRail === 'left' ? undefined : 'left', brand);
});

// R2: the drawer's own close control. Backdrop, Escape and picking a harness all
// converge on the same state reset, so no separate cleanup path is needed.
closeHarnessSidebar.addEventListener('click', () => {
    setRailOpen(undefined);
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
// Entering the phone breakpoint re-enables the brand and restores its disclosure
// semantics; leaving it disables/strips them through `setRailOpen(undefined)`.
// `matchMedia` is absent in jsdom and in very old browsers: optional, not required.
phoneMedia?.addEventListener?.('change', (event) => {
    if (event.matches) {
        syncBrandTrigger();
        return;
    }

    setRailOpen(undefined);
});

// ---------------------------------------------------------------------------
// Instances and selection state
// ---------------------------------------------------------------------------

type Instance = {
    descriptor: HarnessDescriptor;
    view: View;
    sessionId?: string;
    // The definition the current conversation was created with. When present the
    // compact agent control renders this and editing is locked, so an updated harness cannot
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
    // shown on the tools view's session note (R21.2 — there is no core dropdown any
    // more). Refreshed by the snapshot a core call triggers.
    discovered?: readonly string[];
    // Per-instance live activity set for the tile rings. Never a module global:
    // two harness views must not share who is busy.
    activity: Set<string>;
    // Tool-contributed panels for THIS instance/session (R21.3), keyed by
    // tool+panel id. Recomputed from the server's turns on every applySnapshot
    // (reload, poll, session open, enqueue answer) and upserted live from
    // `tool_result.ui` and from manual tool results. Never shared across
    // instances: switching harness can neither show nor leak another chat's board.
    panels: Map<string, PanelMedia>;
    // Work the server has not finished for this instance's session (R4): a
    // running task, a retained queued task, or a non-zero queueDepth. Drives the
    // composer's stop state (R10) and the topbar pill. The composer is NOT gated
    // by it: submitting another task is how a queue is built.
    pending: boolean;
    // The latest authoritative turn records for this session, keyed by id. Kept so
    // activity can be recomputed from running records without a full snapshot.
    records: Map<string, SessionTurn>;
    // The session's PERSISTENT runtime threads (`SessionSnapshot.threads`, additive),
    // in creation order. Empty for a legacy server and for a session that has only
    // its implicit conversations; every pre-thread behaviour is unchanged then. The
    // roster feeds the composer's routing decision and the board's label/badge joins
    // (the former strip that also listed it is gone).
    threads: readonly SessionThreadEntry[];
    // Deletion tombstones (S3). A thread this client deleted — and the descendants
    // and turns removed with it — must never come back from a late SSE `turn`, a
    // delayed 202 body, or an in-flight stale snapshot. Session-scoped: reset when
    // the instance points at a different conversation.
    threadTombstones: Set<string>;
    turnTombstones: Set<string>;
    // Watermark of the newest snapshot this instance has applied, tagged with the
    // session it came from. The 202 body of POST /tasks is captured at ENQUEUE time
    // and can resolve after newer observer frames, so its session-level fields
    // (status, queueDepth, pending) must not override what is already on screen.
    // Per-turn records are guarded separately by their own `updatedAt`. The tag is
    // required because pointing the instance at another session resets the clock.
    snapshotMark?: { sessionId: string; at: number };
    // R7: the last tombstone-filtered authoritative snapshot (raw threads + raw
    // turns + session fields). Not used for rendering (the board owns that); it is
    // the source the JSON transcript copies and the baseline delete protection
    // reads. Cleared whenever the instance points at a different/no session.
    snapshot?: SessionSnapshot;
};

const instances = new Map<string, Instance>();
let current: Instance | undefined;
let selectedName: string | undefined;
let presetDescriptors: readonly HarnessDescriptor[] = [];
let agentLibrary: readonly AgentDescriptor[] = [];
let sessions: SessionSnapshot[] = [];
let currentTool: ToolDescriptor | undefined;
// The complete server catalogue (core entries included) for the global tools view —
// the ONLY tool listing after R21.2. Boot replaces it from the bootstrap document.
let toolEntries: readonly ToolDescriptor[] = [];
// Which centre view is showing: the chat (transcript + composer) or the GLOBAL tools
// view (catalogue + manual runner). There is no tab strip (R3); the topbar's
// icon-only Tools toggle drives this through `setToolsView`.
let showingTools = false;
// Which agent tile is FRONT (fully visible) in the overlapping card deck (R2). The
// dialog content is rebuilt on every paint (activity frames, model PATCHes, busy
// changes), so the viewed card has to be remembered here or an activity frame would
// flip the deck back. This is VIEW state only — it is deliberately not
// `selectedName`/`primaryOf`, never sent to
// the server, and fronting a card never PATCHes the team. `undefined` means "front
// the primary"; a name that is no longer a member is dropped on the next render so
// removing the viewed agent falls back to the primary instead of blanking the deck.
let agentFront: string | undefined;
// R11/R12 (T5): the agent dialog is APP-scoped, not per view. It is opened from the
// composer button, kept in sync across routine chrome rebuilds (see
// `refreshAgentDialog`) and closed by the lifecycle changes that used to reset the
// old popover (harness switch, new/deleted session, Tools view).
let agentDialog: AgentDialog | undefined;
// The state the open dialog was last painted from. A chrome rebuild happens for
// every snapshot/activity frame; rebuilding identical content would collapse open
// instruction details and churn focus, so an unchanged signature is a no-op.
let agentDialogSignature: string | undefined;

// Single-flight submit state (R4). `running` means the selected session has work
// the server has not finished; it drives the composer's stop state and the harness
// locks, but NOT submission, because submitting another task while one runs is
// exactly how the queue is built. `submitting` covers only the short window between
// pressing the submit action and the POST /tasks answer, so a double submit cannot
// create two sessions or two copies of the same task.
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
    // agentDelegate is only registered when the harness declares subagents, so the
    // manual runner asks the SELECTED instance for its real targets: the frozen
    // team for a saved session, otherwise the live descriptor's allowlist. A
    // harness with none cannot offer a callable delegation.
    delegateTargets: () => {
        const instance = current;
        if (instance === undefined) return [];

        return subagentsOf(instance.frozen ?? instance.descriptor);
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

// N3: route one human answer from a turn board to the session that asked it.
//
// The board captured `sessionId` when the card was rendered and main re-checks it
// against the instance's CURRENT session before the POST. That double binding is
// what stops an answer from leaking into a conversation the reader switched to
// after the question appeared. `answerAction` itself only resolves the pending
// question (it never enqueues a task), so answering while the turn is busy is the
// intended path.
const answerActionFor = async (harnessName: string, input: AnswerActionInput): Promise<void> => {
    const instance = instances.get(harnessName);
    if (instance === undefined) throw new Error('This harness view is no longer open.');
    if (instance.sessionId === undefined) throw new Error('No session is open for this question.');
    if (input.sessionId === undefined || input.sessionId !== instance.sessionId) {
        throw new Error('This question belongs to another session.');
    }

    await answerAction(instance.sessionId, input.requestId, input.choice);
};

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
        view: createView(
            descriptor,
            (input) => answerActionFor(descriptor.name, input),
            refreshTranscriptSnapshot,
            deleteThreadForSession
        ),
        activity: new Set<string>(),
        panels: new Map<string, PanelMedia>(),
        pending: false,
        records: new Map<string, SessionTurn>(),
        threads: [],
        threadTombstones: new Set<string>(),
        turnTombstones: new Set<string>()
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

// Toggle visuals only. Content switching lives in `setToolsView` (declared with the
// tool runner, because it needs `toolEntries`), so this is safe to call from
// selection and busy-state code without re-entering the runner.
//
// R3: there is no tab/tablist anywhere. The only visible state is the topbar
// toggle's pressed flag; the stage is a plain region and its accessible name comes
// from the heading inside it (the harness title or the selected tool's name).
const paintToolsToggle = (): void => {
    toolsToggle.setAttribute('aria-pressed', showingTools ? 'true' : 'false');
};

// Remove every activity ring. Called on terminal frames, cancel, delete, new
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

    // A tool runner is a modal belonging to the view being left; close it before
    // the chat is restored (a programmatic switch may happen while it is open).
    closeToolDialog();
    // R2: the details dialog describes the harness being LEFT, so selecting another
    // harness/session closes it rather than leaving stale content on screen.
    closeHarnessDialog();

    // Switching harness closes the global tools view and drops every ring: the
    // activity belonged to the view being left. The deck disclosure also starts
    // collapsed for the new team (R1 default).
    showingTools = false;
    paintToolsToggle();
    // The deck's front card belonged to the team being left; the new team starts
    // with its own primary in front (the deck's own fallback does the same, this
    // just keeps the remembered state honest).
    agentFront = undefined;
    // Lifecycle: the agent dialog belongs to the conversation being left. The new
    // harness/session starts with it closed.
    closeAgentDialog();
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
    // The topbar pill is APP-scoped: selecting a card never paints that card's run
    // state into it (R1 — that text went stale the moment another session was
    // opened). Work the reader selected is visible on its turn tiles, and a failure
    // detail lives in the pane's session note.
    setStatus('idle');
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

// Rebuild the header, compact agent control and core-tool list from the instance's
// current (or frozen) definition. Called after every server-confirmed change and on
// snapshot hydration.
const renderHarnessChrome = (): void => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;

    // The tools view's session line always describes the SELECTED harness (R21.2):
    // the view is where tools are reviewed and called, and a snapshot refreshed by a
    // manual core call must update "enabled for this session" there. The right rail
    // no longer renders any tool list.
    renderToolsSession(display, instance.sessionId, instance.discovered);

    // The manual runner lives on the tools view and shows an agentDelegate example
    // built from the selected team (see createToolRunner.paintDelegate). A team edit
    // lands here, so re-sync it: the example becomes callable the moment a subagent
    // exists, and stops being offered when the last one is removed. The runner
    // itself only rewrites its argument box when the target list actually changed.
    runner.sync();

    // While the tools view owns the centre, the head describes the list (or the
    // tool whose dialog is open); a background repaint must not overwrite it with
    // the chat title. `setToolsView`/`selectHarness` restore the chat head by
    // clearing `showingTools` before they call back in here.
    if (showingTools) return;

    const locked = instance.sessionId !== undefined;

    // The title text lives INSIDE the details button (R2); writing the button's text
    // node keeps the heading's textContent identical to the visible title, which the
    // head assertions read, without replacing the button itself.
    headTitleText.textContent = display.title;
    // The chat head always describes the selected harness, so its details dialog is
    // meaningful here (unlike the tools view — see paintToolsHead/selectTool).
    paintHeadTitleTrigger(true);
    // The harness id (`research`, `workspace`, …) is an internal registry key used by
    // sessions, aliases and the API — not something the reader needs. The chat head
    // shows ONLY the display title, so the shared badge stays empty and hidden here.
    // The badge is still used by the tools view for user-facing group labels
    // (`Files`, `Web search`, `catalogue`); `paintToolsHead`/`selectTool` un-hide it.
    headName.textContent = '';
    headName.hidden = true;
    // R21.1: no read-only branch. Editing a harness applies to its NEXT session;
    // a saved chat keeps what it started with (the conversation guarantee).
    headNote.textContent = locked
        ? instance.frozen !== undefined
            ? 'Viewing a saved session · agent team frozen'
            : 'Viewing a saved session'
        : 'Edits apply to new sessions';

    // A locked session renders the definition it started with; the live harness
    // may already have moved on. The composer button opens the shared agent dialog
    // (R11), so there is no popover to restore here: only the BUTTON's own focus has
    // to survive the rebuild, and an already-open dialog is refreshed from the new
    // state (R12).
    const hadAgentFocus = agentSlot.contains(document.activeElement);
    const view = agentViewOf(instance);
    const control = renderAgentControl(view, instance);
    agentSlot.replaceChildren(control.element);

    // A keyboard user who was on the agent button must not be dropped to <body> when
    // a snapshot/activity frame replaces it.
    if (hadAgentFocus) control.focus();

    // Keep the open dialog truthful after a promotion/model PATCH/frame without
    // closing it (unchanged state is a no-op inside refreshAgentDialog).
    refreshAgentDialog(view, instance);
};

// One derived description of the agent UI for the selected instance. Both the
// composer button and the dialog read from it, so the two can never disagree about
// the team, the primary, the lock reason or the effective model map.
type AgentView = {
    display: HarnessDescriptor;
    members: string[];
    primary: string;
    locked: boolean;
    // TEAM editing (promotion/add/remove). A saved session freezes the team; models
    // stay live through `models.editable` below (R2).
    editable: boolean;
    // Per-member EFFECTIVE model (override or session/global fallback).
    models: Record<string, string>;
    // The model a no-override choice resolves to (rendered as an id, never
    // "inherit"); '' means "not known", which the select states honestly.
    fallback: string;
    // The real reason team editing is locked. Omitted when it is allowed.
    hint?: string;
};

const agentViewOf = (instance: Instance): AgentView => {
    const display = instance.frozen ?? instance.descriptor;
    const members = membersOf(display);
    const locked = instance.sessionId !== undefined;
    // R21.1: the harness itself is always editable; only a saved session (frozen
    // team), an in-flight run, or a submit that is currently creating/answering a
    // session locks the team.
    const editable = !locked && !running && !submitting;

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

    // R2 deck: prune the remembered front card against the CURRENT team before it
    // is handed down. Removing (or promoting away) the viewed agent therefore falls
    // back to the primary on this render, and a name that later reappears is not a
    // ghost selection. `members` order is the server's, primary first.
    if (agentFront !== undefined && !members.includes(agentFront)) agentFront = undefined;

    // The hint names the ACTUAL cause instead of claiming "locked" for a busy run.
    const hint = locked
        ? 'The agent team is locked for this conversation.'
        : running
          ? 'Wait for the current run to finish before switching agents.'
          : submitting
            ? 'A session is being created; try again in a moment.'
            : undefined;

    return {
        display,
        members,
        primary: primaryOf(display),
        locked,
        editable,
        models,
        fallback,
        ...(hint === undefined ? {} : { hint })
    };
};

// The model dropdown payload shared by the deck inside the dialog. Every rule below
// is the pre-existing one from the old centre row/popover; only its host changed.
const agentModelSelectOf = (view: AgentView) => ({
    models: view.models,
    catalogue: modelIds,
    ...(view.fallback.length > 0 ? { fallbackModel: view.fallback } : {}),
    // R2: models are NOT part of the frozen team. A saved session edits its live map
    // through PATCH /sessions/:id, and an in-flight run keeps streaming while the
    // next request picks the new id up. The single-flight guard lives in
    // setAgentModel/patchSessionModels, not in this flag (rendering while that PATCH
    // is in flight must not look disabled).
    editable: view.locked || !running,
    // Tells the tile which promise the control makes: a session edit applies to the
    // next request in THIS chat, a harness edit to future sessions.
    ...(view.locked ? { session: true } : {}),
    onChange: (name: string, model: string) => void setAgentModel(name, model)
});

// The composer button (R11). One control, no cycling, no chevron: pressing it opens
// the dialog. `hint` is the tooltip, not a disabled state — models and instructions
// must stay reachable while the TEAM is locked.
const renderAgentControl = (view: AgentView, instance: Instance): AgentControl =>
    createAgentControl({
        primary: view.primary,
        agents: agentLibrary,
        activity: [...instance.activity],
        ...(view.hint === undefined ? {} : { hint: view.hint }),
        onActivate: () => openAgentDialogForCurrent()
    });

// Everything the dialog paints, derived from the same `AgentView`.
const agentDialogOptionsOf = (view: AgentView, instance: Instance) => ({
    members: view.members,
    primary: view.primary,
    agents: agentLibrary,
    editable: view.editable,
    models: agentModelSelectOf(view),
    activity: [...instance.activity],
    ...(view.hint === undefined ? {} : { hint: view.hint }),
    ...(agentFront === undefined ? {} : { front: agentFront }),
    // R2: the front card is remembered across rebuilds for the same reason as
    // before. Fronting never PATCHes.
    onFront: (name: string) => {
        agentFront = name;
    },
    onSelectPrimary: (name: string) => void selectPrimary(name),
    onAdd: (name: string) => void addAgent(name),
    onRemove: (name: string) => void removeAgent(name)
});

// A cheap equality key for "does the open dialog need repainting?". It covers every
// field the dialog renders that can change while it is open.
const agentDialogSignatureOf = (view: AgentView, instance: Instance): string =>
    JSON.stringify({
        members: view.members,
        primary: view.primary,
        editable: view.editable,
        models: view.models,
        fallback: view.fallback,
        front: agentFront ?? null,
        activity: [...instance.activity].sort(),
        agents: agentLibrary.map((agent) => agent.name)
    });

// Open the dialog for the SELECTED instance. The click handler resolves `current`
// at press time, so a rebuilt button can never target a conversation left behind.
const openAgentDialogForCurrent = (): void => {
    const instance = current;
    if (instance === undefined) return;

    const view = agentViewOf(instance);
    // One dialog at a time. A second programmatic open replaces the previous layer
    // instead of stacking two views of the same team.
    agentDialog?.close();
    agentDialogSignature = agentDialogSignatureOf(view, instance);

    agentDialog = openAgentDialog({
        ...agentDialogOptionsOf(view, instance),
        onClose: () => {
            agentDialog = undefined;
            agentDialogSignature = undefined;

            // Focus return (R11/R13). ui/dialog.ts restores the opener when it is
            // still connected; a chrome rebuild may have replaced the composer button
            // while the modal was open, so fall back to the LIVE button rather than
            // leaving focus on <body>.
            const active = document.activeElement;
            if (active === null || active === document.body) {
                agentSlot.querySelector<HTMLButtonElement>('.agent-control-button')?.focus();
            }
        }
    });
};

// Close the app-scoped agent dialog (lifecycle changes, Tools view). Idempotent.
const closeAgentDialog = (): void => {
    const dialog = agentDialog;
    agentDialog = undefined;
    agentDialogSignature = undefined;
    dialog?.close();
};

// Keep an open dialog in sync with a chrome rebuild. Identical state is a no-op so
// activity frames cannot collapse instruction details or churn focus.
//
// `force` exists for a REJECTED/IGNORED write: the stored state did not move, so the
// signature matches, yet the control the reader pressed is showing the choice that
// was refused. Rebuilding is the only way to snap it back to the last confirmed value.
const refreshAgentDialog = (view: AgentView, instance: Instance, force = false): void => {
    if (agentDialog === undefined || !agentDialog.isOpen) return;

    const signature = agentDialogSignatureOf(view, instance);
    if (!force && signature === agentDialogSignature) return;

    agentDialogSignature = signature;
    agentDialog.update(agentDialogOptionsOf(view, instance));
};

// Rebuild the open dialog from the CURRENT instance, even when the derived state is
// unchanged (see `force` above). Used only on the failure/drop paths of an agent edit.
const forceRefreshAgentDialog = (): void => {
    const instance = current;
    if (instance === undefined) return;
    refreshAgentDialog(agentViewOf(instance), instance, true);
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
    // R3: `saving` is the visible word; the label says WHAT is being saved in the
    // tooltip only.
    setStatus('saving', `saving ${label}`);

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
        // PATCH leaves a truthful row. The dialog is forced because its derived state
        // is unchanged while the rejected select still shows the user's choice (T5 R13).
        setStatus('error', `${label}: ${messageOf(error)}`);
        renderHarnessChrome();
        forceRefreshAgentDialog();
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
        // choice that will never be sent. The dialog needs the forced rebuild for the
        // same reason as the failure path below (derived state did not change).
        if (current === instance) {
            renderHarnessChrome();
            forceRefreshAgentDialog();
        }
        return;
    }

    savingAgents = true;

    // The pill carries the CONFIG operation (app-scoped action feedback), never the
    // session's run state — that lives on the tiles (R1). R3: the visible word is
    // `saving`; the target is tooltip detail.
    setStatus('saving', 'saving agent models');

    try {
        const session = await updateSession(id, { agentModels: { ...models } });

        // The reader may have started a New session or opened another row while the
        // PATCH was in flight. Applying then would re-point THIS card at a session
        // it no longer shows, so drop the answer.
        if (instance.sessionId !== id) return;

        instance.sessionModels = agentModelsOf(session);
        if (typeof session.model === 'string') instance.sessionModel = session.model;
        // The PATCH answer is the newest authoritative state for this session: it
        // moves the watermark so a 202 body captured before the edit is recognised
        // as stale instead of reverting the model map (R2).
        markSnapshot(instance, session);
        upsertSession(session);
        renderSessions();

        if (current === instance) renderHarnessChrome();

        // The save is a CONFIG action, so its result is app-scoped feedback. It says
        // "next request" for a running session too: the run's own progress belongs
        // to the tiles, never to the header (R1).
        setStatus('idle', 'agent models saved · next request');
    } catch (error) {
        // Errors are shown even mid-run: a rejected model is something the reader
        // must see, and the streaming turn keeps its tiles either way. The row/dialog
        // is redrawn from the last confirmed map so it cannot pretend the change stuck.
        setStatus('error', `agent models: ${messageOf(error)}`);
        if (current === instance) {
            renderHarnessChrome();
            forceRefreshAgentDialog();
        }
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
    // After a promotion the NEW primary must be the front card, so the refreshed
    // dialog shows its model select immediately. `undefined` is the deck's documented
    // "front the primary" value.
    agentFront = undefined;
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

// R21.2: the tool catalogue is the global tools view and nothing else. This line is
// that view's informational session status (the one piece the removed right-rail
// core dropdown actually carried that is still worth showing): which harness/session
// a session-bound call will mutate, and which tools toolRequest enabled there.
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
// Tools view: the complete catalogue (centre column) and the tool-testing dialog
// ---------------------------------------------------------------------------
//
// R21.2: this is the ONLY tool listing. The right rail used to duplicate it (a
// catalogue plus a core-tools disclosure); both were removed so there is one place
// to review and call every server tool, core entries included.
//
// R12/dialog rework: the centre column IS the list. The manual runner no longer
// sits inline UNDER the list (which forced the list into a 32vh scroll box and put
// the schema/arguments/result below the fold). Instead, activating one entry opens
// the shared modal (`ui/dialog.ts`) with the runner adopted inside it. The dialog
// owns focus/Escape/backdrop dismissal, so the list stays exactly one screen.
//
// A `sessionBound` entry runs inside the selected harness's session
// (api.ts `callTool(name, parameters, sessionId)`); every other entry is a direct
// function call on the server.

const toolTabButtons = new Map<string, HTMLButtonElement>();

const toolsPane = el('div', 'pane tools-pane');
const toolsTabHead = el('div', 'tools-tab-head');
const toolsTabHint = el(
    'p',
    'tools-tab-hint',
    'Every tool the server lists, core tools included. Select one to open its runner. Calls execute on the harness server — nothing runs in this browser. Session-bound tools (toolRequest, toolCreate, todoManage, and agentDelegate when the selected harness has subagents) run inside the selected harness’s session; every other tool, including the core file and search tools, runs directly.'
);
const toolsSessionNote = el('p', 'tools-session-note field-hint', '');
toolsTabHead.append(el('h2', 'tools-tab-title', 'Tools'), toolsTabHint, toolsSessionNote);
const toolsTabList = el('div', 'tool-tab-list');
// The list is the whole content area. The runner is NOT mounted here any more: it
// is adopted by `openToolDialog` only while the reader is testing that tool.
toolsPane.append(toolsTabHead, toolsTabList);

// The open tool-runner dialog, if any. The UI exercises ONE tool at a time, so a
// second selection closes this layer before opening the next (openDialog stacks
// by design; replacement is the catalogue's own rule).
let toolDialog: DialogHandle | undefined;

// The head shown while the tools view owns the centre and no dialog is open.
// `renderHarnessChrome` returns early whenever `showingTools` is true, so this is
// the only writer of the title/note in that state (a background snapshot or a
// pending-state repaint can never repaint the chat title under the list).
const paintToolsHead = (): void => {
    const count = toolEntries.length;
    headTitleText.textContent = 'Tools';
    // R2: a tools heading is not a harness, so its title must not open a harness
    // details dialog. `disabled` also removes it from the tab order (no misleading
    // affordance for keyboard/AT users).
    paintHeadTitleTrigger(false);
    // Category label, not a harness id: the chat header hides this badge, the tools
    // view re-shows it (see renderHarnessChrome).
    headName.hidden = false;
    headName.textContent = 'catalogue';
    headNote.textContent =
        count === 0
            ? 'The server reported no tools.'
            : `${count} tool${count === 1 ? '' : 's'} · calls run on the harness server`;
};

// Close the tool dialog if one is open. Idempotent; `onClose` performs the local
// state cleanup, so every dismissal path (Escape, backdrop, close button, harness
// switch, tools toggle) converges on the same reset.
const closeToolDialog = (): void => {
    toolDialog?.close();
};

// Open the runner for one catalogue entry in the shared modal. The runner pane is
// PERSISTENT (it owns the in-flight call state), so it is moved into a fresh
// dialog slot on every open instead of rebuilt. When the dialog closes, the slot
// is removed with the overlay and the pane is re-adopted on the next open; a call
// that finished meanwhile keeps its result.
const openToolDialog = (entry: ToolDescriptor, trigger?: HTMLElement): void => {
    const slot = el('div', 'tool-runner-slot');
    slot.append(runner.pane);

    let handle: DialogHandle | undefined;
    handle = openDialog({
        // The chips name the tool; the group is already on the head note behind the
        // dialog, so repeating it in the title would only wrap long names.
        title: entry.name,
        content: slot,
        // R5/T6: the runner is also a data-inspection surface for its CURRENT result.
        // The provider reads the live output box, so Copy after a call yields the
        // settled payload even though the same dialog also contains input controls.
        copy: () => runner.copyText(),
        // `returnFocus` is the tool button that opened this dialog, so Escape/close
        // lands the reader back on the entry they picked (never the composer).
        ...(trigger === undefined ? {} : { returnFocus: trigger }),
        onClose: () => {
            // Identity check: a replacement dialog may already have been opened by
            // the time a queued close callback runs.
            if (toolDialog !== handle) return;

            toolDialog = undefined;
            currentTool = undefined;
            for (const button of toolTabButtons.values()) {
                button.setAttribute('aria-pressed', 'false');
            }

            // The list is still on screen: describe it again. When the dialog was
            // closed by LEAVING the tools view, that view has its own restore path
            // (setToolsView/selectHarness) and must not be painted over here.
            if (showingTools) paintToolsHead();
            else if (current !== undefined) renderHarnessChrome();
        }
    });

    // The runner is a full working surface (schema + editable arguments + result),
    // so it uses the wide dialog variant. `dialog.ts` keeps the class list generic;
    // the width lives in ui/dialog.css.
    handle.element.classList.add('dialog-wide');
    toolDialog = handle;
};

const selectTool = (entry: ToolDescriptor, trigger?: HTMLElement): void => {
    if (running) return;

    stopPolling();

    // Replace, never stack: close the previous runner first so its `onClose` reset
    // runs against the state that was actually on screen.
    closeToolDialog();

    currentTool = entry;
    // Selecting a tool ensures the GLOBAL tools view is behind the dialog: that is
    // the only tool listing (R21.2).
    showingTools = true;
    paintToolsToggle();

    for (const [name, button] of toolTabButtons) {
        button.setAttribute('aria-pressed', name === entry.name ? 'true' : 'false');
    }
    // The harness stays selected: the sessions rail is still scoped to it, and
    // clicking a harness row returns to that chat.
    for (const [name, button] of harnessButtons) {
        button.setAttribute('aria-pressed', name === selectedName ? 'true' : 'false');
    }

    const unavailable = entry.availability?.state === 'unconfigured';
    headTitleText.textContent = entry.name;
    // R2: a tool heading describes a tool, never a harness — no harness dialog here.
    paintHeadTitleTrigger(false);
    // Tool group label (e.g. `Files`) — user-facing category, so the badge is shown
    // here even though the chat header keeps it hidden.
    headName.hidden = false;
    headName.textContent = entry.group;
    headNote.textContent = [
        entry.visibility,
        `tags: ${entry.tags.length > 0 ? entry.tags.join(', ') : 'none'}`,
        ...(entry.sessionBound === true ? ['session-bound'] : []),
        ...(unavailable ? ['unconfigured'] : [])
    ].join(' · ');

    agentSlot.hidden = true;
    composer.hidden = true;
    // Lifecycle: the agent dialog is not carried behind the Tools view; returning to
    // the chat starts with it closed.
    closeAgentDialog();
    stage.replaceChildren(toolsPane);
    delete stage.dataset.preset;
    // Populate the persistent runner BEFORE it is adopted, so the dialog paints the
    // argument template/schema on its first frame.
    runner.show(entry);
    openToolDialog(entry, trigger);
    setStatus('idle');
};

// Open or close the GLOBAL tools view (R3). One function for both directions: the
// topbar icon toggle calls it and harness selection closes it. The panel (`stage`)
// is shared; the rest of the centre chrome (head and composer, with both flanking
// controls) is shown or
// hidden to match. A run in flight keeps the view locked, exactly as the removed
// tabs were.
//
// Opening NEVER auto-opens a tool any more: the content area is the list, and a
// dialog appears only after the reader activates one entry.
const setToolsView = (open: boolean): void => {
    if (running || showingTools === open) return;

    // Lifecycle: entering the Tools view dismisses the agent dialog; the chat starts
    // with it closed when the view returns. The harness details dialog is also closed
    // (R2): its title/description belong to the chat head that is being replaced.
    if (open) {
        closeAgentDialog();
        closeHarnessDialog();
    }

    if (!open) {
        // Close the runner first: its `onClose` still sees the tools view and only
        // resets the list's pressed state/head, then the chat chrome is restored
        // below.
        closeToolDialog();
        showingTools = false;
        paintToolsToggle();

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

    showingTools = true;
    paintToolsToggle();
    currentTool = undefined;
    for (const button of toolTabButtons.values()) button.setAttribute('aria-pressed', 'false');

    agentSlot.hidden = true;
    composer.hidden = true;
    paintToolsHead();
    stage.replaceChildren(toolsPane);
    delete stage.dataset.preset;
    setStatus('idle');

    // T4 focus ordering: `closeHarnessDialog` above returns focus to the title
    // button, and `paintToolsHead` then DISABLES that button — a disabled control
    // cannot hold focus, so the press would otherwise drop the reader onto <body>.
    // Hand focus to the toggle that performed the switch (the only caller of this
    // branch), which is a stable, meaningful target in the tools view.
    const active = document.activeElement;
    if (active === null || active === document.body || active === headTitleButton) {
        toolsToggle.focus({ preventScroll: true });
    }
};

// The topbar icon is a real toggle: pressing it while the tools view is showing
// closes it and returns to the selected chat. It is disabled while a run is pending
// (paintControls), so this handler never has to fight a streaming queue.
toolsToggle.addEventListener('click', () => {
    setToolsView(!showingTools);
});

// Full-width tools view listing: the single catalogue (R21.2). Every entry is a
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
        // The activation opens a modal runner rather than an inline panel, so the
        // control advertises the popup kind to assistive technology. The button is
        // passed back as `returnFocus` so closing restores focus here.
        button.setAttribute('aria-haspopup', 'dialog');
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
        button.addEventListener('click', () => selectTool(entry, button));

        toolTabButtons.set(entry.name, button);
        toolsTabList.append(button);
    }

    if (entries.length === 0) {
        toolsTabList.append(
            el('p', 'field-hint', 'The server reported no tools. Check that the harness server is reachable.')
        );
    }
};

// Boot entry for the catalogue. R21.2: the tools view is the sole listing, so this
// only caches the entries (for `setToolsView`) and rebuilds that list — no
// right-rail duplicate to keep in sync any more.
const buildTools = (entries: readonly ToolDescriptor[]): void => {
    toolEntries = entries;
    buildToolsTab(entries);
};

// ---------------------------------------------------------------------------
// Session directory (server-owned, filtered by harness)
// ---------------------------------------------------------------------------

const upsertSession = (session: SessionSnapshot): void => {
    // R8: a deleted conversation is never re-entered into the directory cache by a
    // late answer (see `deletedSessions` and `forgetDeletedSession`).
    if (deletedSessions.has(session.id)) return;

    const index = sessions.findIndex((candidate) => candidate.id === session.id);
    if (index >= 0) sessions[index] = session;
    else sessions.push(session);
};

// Eight characters is the same prefix the server's logs are readable by.
const shortId = (id: string): string => (id.length <= 8 ? id : id.slice(0, 8));

// Sessions belong to one canonical harness. The rail shows only the selected one,
// which is the "locked to selected harness" rule in R3 — opening a row can never
// silently move the reader to another harness, because no other row is offered.
//
// R8 defense in depth: a tombstoned id (`deletedSessions`) is never rendered, even
// if some other path assigned it into the cache. The authoritative filter is at the
// assignment sites (`refreshSessions`, `upsertSession`), but the RENDER projection
// is the last line of defence, so a deleted conversation cannot reappear as a row.
const visibleSessions = (): SessionSnapshot[] => {
    if (selectedName === undefined) return [];

    return sessions.filter(
        (session) =>
            !deletedSessions.has(session.id) &&
            canonicalHarnessName(session.harness, presetDescriptors) === selectedName
    );
};

// ---------------------------------------------------------------------------
// Deleting a session (R8)
// ---------------------------------------------------------------------------
//
// Delete is PERMANENT. The server (src/server/api.ts DELETE /sessions/:id ->
// SessionStore.remove, src/server/sessions.ts) aborts an active run, discards the
// retained queue, closes /events watchers, and rewrites state.json without the
// record before answering. The UI therefore never offers it as a one-click icon:
// `.session-delete` only OPENS the inline `.session-confirm`, cancel sends no
// request at all, and only a confirm sends exactly one DELETE.
//
// Local state is deliberately module-scoped, not per row: `renderSessions` may
// rebuild the rail at any time (a refresh, a snapshot, a new submit) and the open
// confirmation must not vanish or be duplicated by that rebuild.

// Session ids with a DELETE currently in flight. Doubles as the dedupe guard: a
// second confirm click (or a double pointer event) is a no-op.
const removingSessions = new Set<string>();

// Tombstones for ids this page has deleted. Every asynchronous path that can
// deliver an authoritative session (the 202 body of POST /tasks, a GET /events
// frame, the GET /sessions/:id polling fallback, an openSession/enqueue/model PATCH
// answer) checks this before applying anything: the server record is gone, so a
// late answer must not re-point a card at it or re-add its row (R8). Ids are
// UUIDs, so a tombstone can never hide a different, later session.
const deletedSessions = new Set<string>();

// The one session whose inline confirmation is open, if any. Opening a second
// row replaces it, so two confirms can never be open at once.
let confirmingDelete: string | undefined;

// A delete must not race an operation that owns the same conversation:
//   - `submitting` is the POST /tasks window (the run() flow),
//   - `savingAgents` is a harness/team PATCH or a session-model PATCH,
//   - a pending session creation (creatingSessions) would make "which session is
//     current" ambiguous mid-flight,
//   - and nothing may be deleted before the catalogue has booted.
// Runs themselves are NOT a reason to block: the server stops the run as part of
// the delete, which is exactly what the confirmation warns about.
const deletionBlocked = (): boolean =>
    !booted || submitting || savingAgents || creatingSessions > 0;

// First step: open (or close) the inline confirmation. No request is sent here.
const requestDeleteConfirmation = (id: string): void => {
    if (deletionBlocked() || removingSessions.has(id)) return;

    confirmingDelete = confirmingDelete === id ? undefined : id;
    renderSessions();
};

// Second step's escape hatch: close the confirmation without any request.
const cancelDelete = (): void => {
    if (confirmingDelete === undefined) return;

    confirmingDelete = undefined;
    renderSessions();
};

// Drop every local trace of a session the server no longer holds. Used after a
// successful DELETE, and after a 404 (the record is already gone — the desired
// end state). It NEVER creates a replacement session: the card becomes an empty
// harness view, exactly like `newSession`, and the frozen team is unlocked only
// because no conversation is selected any more.
const forgetDeletedSession = (id: string): void => {
    // The tombstone is what keeps a late stream/poll/POST answer from resurrecting
    // the conversation after its row is gone (see `deletedSessions`).
    deletedSessions.add(id);

    // The directory cache is what every later render (and `refreshSessions`) reads,
    // so the row disappears from here first.
    sessions = sessions.filter((session) => session.id !== id);

    let wasCurrent = false;

    for (const instance of instances.values()) {
        // Sessions are one-to-one with their canonical harness, so this normally
        // matches a single instance; the loop keeps a second stale pointer from
        // ever outliving the record.
        if (instance.sessionId !== id) continue;

        // Stop observing the conversation on screen BEFORE clearing its id. The
        // observer/poll guards key off `instance.sessionId`, so clearing first
        // would also work — but aborting first means no frame can paint while this
        // function runs.
        if (instance === current) {
            stopWatching();
            stopPolling();
            wasCurrent = true;
        }

        // Same state `newSession` clears, plus the frozen/live model maps: the
        // deleted conversation must not leak its team, models or discovery into
        // the empty view (R8).
        instance.sessionId = undefined;
        // N3: expiring the question cards before the board is cleared means a stale
        // answer control cannot survive the deletion.
        instance.view.bindSession(undefined);
        instance.frozen = undefined;
        instance.sessionModels = undefined;
        instance.sessionModel = undefined;
        instance.discovered = undefined;
        instance.pending = false;
        instance.records.clear();
        // The watermark and raw JSON authority belonged to the deleted conversation.
        instance.snapshotMark = undefined;
        instance.snapshot = undefined;
        instance.panels.clear();
        instance.view.setSessionSnapshot(undefined);
        instance.view.clear();
        // The conversation (and its outcome detail) is gone; nothing is left to
        // report.
        instance.view.setNotice(undefined);
    }

    // The remembered pointer must not resurrect a deleted id on the next reload.
    if (wasCurrent && loadRememberedSession() === id) forgetRememberedSession();

    renderSessions();

    if (!wasCurrent) return;

    // No replacement is created. Clear the rings tied to the removed session,
    // repaint the (now empty) card, and release the lock: `setBusy(false)` also
    // re-enables the agent team and New session, since the server stopped whatever
    // was running in the deleted conversation.
    clearActivity();
    // Lifecycle: the deleted conversation's agent dialog must not reopen against the
    // next session.
    closeAgentDialog();
    renderHarnessChrome();
    paintPanels();
    runner.sync();
    setBusy(false);
};

// Send the DELETE. Exactly one request per confirmed action: the row is marked
// busy before the round trip, and every entry point re-checks the guards.
const deleteSessionRow = async (id: string): Promise<void> => {
    if (deletionBlocked() || removingSessions.has(id)) return;

    confirmingDelete = undefined;
    removingSessions.add(id);
    // Paint the in-flight state (confirmation closed, control disabled).
    renderSessions();

    let removed = false;
    let alreadyGone = false;

    try {
        await deleteSession(id);
        removed = true;
    } catch (error) {
        // A 404 means the server holds no such session (deleted from another
        // browser, or a stale id after a server restart). The end state the user
        // asked for already holds, so the row is dropped without claiming our
        // DELETE achieved it. `api.ts` keeps the wire contract unchanged; the
        // message check is the same one `run()` uses for an unknown session.
        if (messageOf(error).includes('Unknown session')) alreadyGone = true;
        else {
            // The row STAYS: nothing was removed. Rail operations report in the
            // app-scoped pill (like a failed `refreshSessions`); a conversation
            // pane note would describe whichever chat happens to be on screen.
            setStatus('error', `delete session: ${messageOf(error)}`);
        }
    } finally {
        removingSessions.delete(id);
    }

    if (!removed && !alreadyGone) {
        // Failure: row visible again (enabled), confirmation closed, error shown.
        renderSessions();
        return;
    }

    forgetDeletedSession(id);
    setStatus('idle', removed ? `session ${shortId(id)} deleted` : `session ${shortId(id)} was already gone`);
};

// Rows are buttons: keyboard reachable and self-explanatory with a status text
// and turn count. The active row is marked for styling only — selection is state
// in `current.sessionId`, not in this DOM.
//
// R8: every row is a `.session-row` WRAPPER around the select button and a
// SIBLING `.session-delete` control. Buttons can never nest, so deletion is a
// second button beside the row, and confirming it is an inline two-step action
// (`.session-confirm`) rather than a browser dialog or a one-click delete.
// The select button keeps its own `data-session-id`/`data-status`/`data-active`
// as well, so the existing `.session[...]` styles and row queries keep working.
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
        const rowWrap = el('div', 'session-row');
        rowWrap.dataset.sessionId = session.id;
        rowWrap.dataset.status = session.status;
        if (session.id === activeId) rowWrap.dataset.active = 'true';

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

        // Delete control. Disabled while a write owns the conversation, or while
        // this row's own DELETE is in flight (see `deletionBlocked`).
        const remove = el('button', 'session-delete');
        remove.type = 'button';
        remove.dataset.sessionId = session.id;
        // A compact glyph with an explicit accessible name: the rail has no room
        // for a word, and the inline confirmation carries the full warning.
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Delete session ${shortId(session.id)}`);
        remove.title = 'Delete this session permanently';
        remove.disabled = deletionBlocked() || removingSessions.has(session.id);
        remove.addEventListener('click', () => requestDeleteConfirmation(session.id));

        rowWrap.append(row, remove);

        // Inline confirmation for THIS row only. It states the two consequences
        // the server guarantee implies: the record is gone for good, and any
        // running/queued work in it is stopped.
        if (confirmingDelete === session.id) {
            const confirm = el('div', 'session-confirm');
            confirm.dataset.sessionId = session.id;
            confirm.setAttribute('role', 'group');
            confirm.setAttribute('aria-label', `Confirm deleting session ${shortId(session.id)}`);
            confirm.append(
                el(
                    'p',
                    'session-confirm-text',
                    'Delete this session permanently. Running or queued work in it stops.'
                )
            );

            const yes = el('button', 'session-confirm-delete', 'Delete session');
            yes.type = 'button';
            yes.disabled = removingSessions.has(session.id);
            yes.addEventListener('click', () => void deleteSessionRow(session.id));

            const no = el('button', 'session-confirm-cancel', 'Cancel');
            no.type = 'button';
            // Cancel is a pure view change: it sends NO request.
            no.addEventListener('click', () => cancelDelete());

            confirm.append(yes, no);
            rowWrap.append(confirm);
        }

        sessionList.append(rowWrap);
    }
};

// Re-read the directory. A failure is reported in the status pill; the list on
// screen stays usable (it is the last answer the server gave).
//
// R8: a list read that STARTED before a DELETE can resolve after it. The server
// answer is a snapshot of the moment it was produced, so assigning it raw would
// rebuild the deleted row in the rail (the confirmed race: press Refresh, delete a
// session, then release the older list). Every answer is therefore filtered
// through the `deletedSessions` tombstones before it becomes the cache — the
// delete is permanent locally too, not just until the next directory read.
const refreshSessions = async (): Promise<void> => {
    refreshSessionsButton.disabled = true;

    try {
        const listed = await listSessions();
        sessions = listed.filter((session) => !deletedSessions.has(session.id));
        renderSessions();
    } catch (error) {
        setStatus('error', `session list: ${messageOf(error)}`);
    } finally {
        refreshSessionsButton.disabled = false;
    }
};

// Does this snapshot still hold work? A running session status, an explicit
// `queueDepth` (new server), or any running/queued turn record (authoritative even
// when an older server omits queueDepth). Drives the composer's stop action and the
// topbar pill.
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
// R4: this RECONCILES the list (same id → merge in place) rather than
// rebuilding it, so a reconnect/poll neither duplicates streamed text nor collapses
// the reader's expanded turn. It also refreshes what the composer needs to know —
// whether work is pending, which decides stop vs submit (R10) — and the activity
// rings (only still-running records light an agent).
//
// Record where a snapshot sits in its session's monotonic timeline. EVERY answer
// that carries an authoritative `SessionSnapshot` announces itself here — the
// stream/poll/202 hydration path (applySnapshot) and the model PATCH, which
// applies its answer directly without a reconcile. Without the PATCH's mark a
// delayed 202 body would look newer than the last *streamed* snapshot and revert
// the edit it predates.
//
// `updatedAt` is absent from legacy fixtures: then nothing is recorded and the
// caller never treats a snapshot as stale (graceful, no regression).
const markSnapshot = (instance: Instance, session: SessionSnapshot): void => {
    const stamp = session.updatedAt;

    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return;

    instance.snapshotMark = { sessionId: session.id, at: stamp };
};

// The server records a DELIBERATE stop as this exact sentence (src/server/sessions.ts:
// `failure = session.cancelled ? 'The run was cancelled.' : messageOf(error)`).
// The turn tile already renders the `cancelled` status, so the sentence is
// suppressed from the pane note: a user's own Stop is not an error to report.
const CANCELLED_MESSAGE = 'The run was cancelled.';

// Drop `#` reference chips whose turn no longer exists in the authoritative record
// (R7: deleting a thread deletes its turns). A chip is the ONLY place the exact
// `{ turnId, threadId?, label }` binding lives; leaving a stale one would make the
// next submit a 400 for the whole message. Surviving chips are untouched: their
// labels are allocated by the server and deleting one conversation never renumbers
// the blocks that remain (`ui/references.ts` contract).
// `report: false` removes the chips silently: the failed-submit path already owns
// the reader's attention (`task failed: …`) and must not replace that message with a
// draft note about a reference it restored and immediately dropped (N3).
const purgeStaleReferences = (
    knownTurns: ReadonlySet<string>,
    options: { report?: boolean } = {}
): void => {
    const stale = Array.from(input.querySelectorAll<HTMLElement>('[data-chip="reference"]')).filter(
        (chip) => {
            const turnId = chip.dataset.referenceTurn ?? '';
            return turnId.length === 0 || !knownTurns.has(turnId);
        }
    );
    if (stale.length === 0) return;

    for (const chip of stale) {
        // Same spacing repair the chip-removal paths use, so the draft reads as if
        // the reference had never been there.
        editorCollapseChipGap(chip.previousSibling, chip.nextSibling);
        chip.remove();
    }

    autoGrow();
    paintComposer();

    if (options.report === false) return;

    // Composer-scoped status line (`role=status`), not the session outcome: this is
    // a draft problem the reader can act on, not a failing run.
    setAttachmentError('A referenced block was deleted; its # reference was removed from the draft.');
};

// The turns this client currently holds as live, tombstone-filtered authority. Used
// when a DRAFT must be validated against the server state that exists NOW (N3).
const liveTurnIds = (instance: Instance): ReadonlySet<string> =>
    new Set([...instance.records.keys()].filter((id) => !instance.turnTombstones.has(id)));

// Deletion tombstones (S3).
//
// A deletion is authoritative IMMEDIATELY, while observer frames, the 202 body of a
// submit and in-flight GET answers that were captured BEFORE it can still arrive.
// Filtering every inbound record through these sets is what stops such a frame from
// resurrecting a deleted thread/turn (and re-focusing it) after the DELETE answer
// already reconciled the deletion.
const threadTombstoned = (instance: Instance, threadId: string | undefined): boolean =>
    threadId !== undefined && instance.threadTombstones.has(threadId);

const turnTombstoned = (instance: Instance, turn: SessionTurn): boolean =>
    instance.turnTombstones.has(turn.id) || threadTombstoned(instance, turnThreadIdOf(turn));

// Tombstone a removed thread AND everything it owns: descendant threads (by the
// roster chain) and every recorded turn that ran in them. A child thread of a
// deleted owner is removed by the server too, and must not survive locally.
const tombstoneThread = (
    instance: Instance,
    threadId: string,
    roster: readonly SessionThreadEntry[]
): void => {
    if (instance.threadTombstones.has(threadId)) return;

    instance.threadTombstones.add(threadId);

    for (const turn of instance.records.values()) {
        if (turnThreadIdOf(turn) === threadId) instance.turnTombstones.add(turn.id);
    }

    for (const entry of roster) {
        if (entry.ownerThreadId !== threadId) continue;
        tombstoneThread(instance, entry.id, roster);
    }
};

const applySnapshot = (instance: Instance, session: SessionSnapshot): void => {
    // R8: a snapshot for a session this page deleted must never re-point the card
    // at it. The tombstone covers the observer/poll/resync/openSession/enqueue
    // continuations that were already in flight when the DELETE succeeded.
    if (deletedSessions.has(session.id)) return;

    // N1: once this card points at a conversation, a snapshot for ANOTHER session
    // is a late answer (an observer/get captured before the switch). It must not
    // re-point the card, and — critically — must not become the deletion-learning
    // baseline for the session now on screen. Opening a session sets the id first
    // (openSession/ensureSession), so the intended path always passes this guard.
    if (instance.sessionId !== undefined && instance.sessionId !== session.id) return;

    instance.sessionId = session.id;
    // Answer routing: bind before reconciling so every card rendered from this
    // snapshot knows which session may answer it (cards from another one expire).
    instance.view.bindSession(session.id);

    // Snapshot watermark (R2/N2). `session.updatedAt` is monotonic on the server, so
    // a snapshot stamped before the newest one already applied is stale.
    const stamp = session.updatedAt;
    const mark =
        instance.snapshotMark !== undefined && instance.snapshotMark.sessionId === session.id
            ? instance.snapshotMark.at
            : undefined;
    // N2 tie policy: only a STRICTLY older stamp is stale. Every new turn bumps the
    // session's `updatedAt` at enqueue, so a snapshot missing an SSE-delivered turn
    // necessarily carries an older stamp; an equal stamp describes the same moment
    // and applying it cannot delete a turn that exists at that moment. Ignoring
    // equal stamps instead broke the terminal-frame contract (a drain frame may
    // share its millisecond with the last event), so the strict comparison is the
    // conservative choice here. The first answer for a session has no mark and is
    // always applied.
    const stale =
        typeof stamp === 'number' && Number.isFinite(stamp) && mark !== undefined ? stamp < mark : false;

    // N2: a snapshot stamped before the newest one already applied is a LATE answer
    // (the 202 body captured at enqueue time, or a GET issued before newer frames).
    // It is authoritative for NOTHING on this path: its turn list can omit a turn a
    // newer upsert already delivered, so reconciling it would delete that live row
    // (and its focus), and its roster would regress the strip. Ignore it completely.
    // Records that arrive with a stale answer are still merged by their own
    // per-turn `updatedAt` guard where they ARE authoritative (`run` merges the 202
    // record into its tile directly).
    if (stale) return;

    markSnapshot(instance, session);

    // --- deletion tombstones (S3) ---------------------------------------
    // The sets are session-scoped: they are cleared by `openSession` (switch),
    // `ensureSession` (new conversation) and `newSession`, and this function refuses
    // snapshots for any other session id, so an id can never be tombstoned/learned
    // across a session boundary (N1).

    // Every inbound record is filtered through the tombstones BEFORE anything is
    // stored or rendered — including a STALE snapshot, which may otherwise still
    // carry a thread this client already deleted.
    const incomingTurns = session.turns.filter((turn) => !turnTombstoned(instance, turn));
    const incomingThreads = sessionThreadsOf(session).filter(
        (entry) => !instance.threadTombstones.has(entry.id)
    );

    // Learn deletions from this AUTHORITATIVE snapshot (it passed the stale guard):
    // whatever the previous roster/records had and this one no longer has is gone,
    // and its turns/descendants go with it. A stale answer never reaches this code,
    // so it can neither learn a phantom deletion nor drop a newer turn (N2).
    const nextThreadIds = new Set(incomingThreads.map((entry) => entry.id));
    for (const entry of instance.threads) {
        if (!nextThreadIds.has(entry.id)) tombstoneThread(instance, entry.id, instance.threads);
    }

    const nextTurnIds = new Set(incomingTurns.map((turn) => turn.id));
    for (const id of instance.records.keys()) {
        if (!nextTurnIds.has(id)) instance.turnTombstones.add(id);
    }

    // This snapshot is the newest one this instance has applied, so everything the
    // reader sees comes from it: the frozen team, the live per-agent model map,
    // discovery, the transcript pane and the sessions-rail cache.
    //
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
    // MONOTONIC per id: a stale snapshot may not replace a record this instance
    // already holds in a newer revision, otherwise `pending`/activity would flicker
    // back to a state the observer has already moved past.
    const records = new Map<string, SessionTurn>();
    for (const turn of incomingTurns) {
        const known = instance.records.get(turn.id);
        const knownAt = known === undefined ? undefined : known.updatedAt;
        records.set(
            turn.id,
            known !== undefined &&
                typeof knownAt === 'number' &&
                typeof turn.updatedAt === 'number' &&
                knownAt > turn.updatedAt
                ? known
                : turn
        );
    }
    instance.records = records;

    // R7 authority for the JSON transcript/delete protection. Built from the RAW
    // snapshot (not the normalized roster) so exact `SessionThread`/`SessionTurn`
    // fields survive, and from the MONOTONIC records map so a newer turn revision
    // already adopted from a stream is not regressed. Tombstone-filtered exactly
    // like the render path: a late answer can never make a deleted thread
    // inspectable again.
    const rawIncomingThreads = Array.isArray(session.threads)
        ? session.threads.filter((entry) => !instance.threadTombstones.has(entry.id))
        : undefined;
    instance.snapshot = {
        ...session,
        turns: [...records.values()],
        ...(rawIncomingThreads === undefined ? {} : { threads: rawIncomingThreads })
    };

    // Pending: a live (running/queued) RECORD or the session-level flags of this
    // authoritative snapshot. No stale snapshot can reach here to leave Stop enabled
    // after the queue drained.
    const liveRecord = [...records.values()].some((turn) => {
        const status = turn.status as string;
        return status === 'running' || status === 'queued';
    });
    instance.pending = liveRecord || queueDepthOf(session) > 0 || session.status === 'running';

    // Activity from a hydrated/polled record: ONLY a still-running turn can make
    // an agent busy. Replaying a settled turn (done/error/cancelled) lights
    // nothing, so opening history never animates old work. A queued task is not
    // working yet, so it lights nothing either.
    instance.activity.clear();
    if (instance.pending) {
        for (const name of activityOfTurns([...records.values()])) instance.activity.add(name);
    }

    // R21.3: the tool panels are DERIVED from the server's recorded turns on every
    // snapshot - reload, poll, session open, enqueue answer, terminal frame. A completed
    // turn's panels are valid scratch state (they describe work that happened), but
    // they never light an agent ring: activity above only reads a RUNNING turn.
    // Recomputation also means no cross-session leakage: the board is replaced with
    // exactly what this conversation recorded.
    instance.panels = mediaOfTurns(incomingTurns);

    // `labelSeeds` keeps every surviving turn's block labels identical across a
    // deletion: a replayed turn seeds its allocator from the counters the server
    // recorded at ITS start instead of from the (now shorter) surviving list. Read
    // structurally so a server without the field falls back to the old numbering.
    // Tombstone-filtered turns and roster: a late 202 body or an in-flight answer
    // captured before a DELETE can never resurrect the deleted thread or its turns.
    instance.view.reconcile(incomingTurns, session.model, undefined, labelSeedsOf(session));

    // Persistent thread roster (R5/R7). Only an authoritative snapshot updates it
    // (the stale guard above returns first).
    instance.threads = incomingThreads;
    instance.view.setThreads(instance.threads);
    instance.view.setSessionSnapshot(instance.snapshot);

    // A LEARNED deletion must drop the focus, exactly like the in-app delete used to
    // (that handler owned this clear and is gone with the thread strip).
    //
    // The board alone cannot do it: it keeps a thread "known" while a pending
    // optimistic row still names it, so `reconcile`'s focus-preservation branch
    // re-focuses a thread the authoritative roster just removed. Without this clear
    // the composer would keep targeting a thread the server no longer has (every
    // later submit 404s) instead of falling back to "New thread".
    //
    // Only the focused id is consulted, and only when it is TOMBSTONED: a focus on a
    // thread that merely has no turn (a delegated child, the agent default
    // conversation) is legitimate and must survive every snapshot.
    const focusedAfterReconcile = instance.view.focusedThread();
    if (focusedAfterReconcile !== undefined && instance.threadTombstones.has(focusedAfterReconcile)) {
        instance.view.clearFocus();
    }

    // Authoritative deletion reconciliation for the DRAFT (R7). A `#` reference chip
    // binds a turn that may no longer exist (its thread was deleted): the wire
    // rejects an unknown turn, so the stale chip is removed from the field NOW and
    // the reader is told, instead of failing the whole submit later. Labels stay
    // untouched for every surviving chip: the server owns allocation and a deletion
    // never renumbers the blocks that remain. Only the SELECTED instance owns the
    // composer, so another harness's snapshot cannot mutate it.
    if (instance === current) purgeStaleReferences(new Set(incomingTurns.map((turn) => turn.id)));

    upsertSession(session);
    renderSessions();

    // Session outcome detail (R1/R2). This is the ONE report of a failed run: the
    // topbar pill is app-scoped, so a failure can neither leak into another session's
    // header nor go stale when the reader switches away. The tile's status word still
    // says `error`/`cancelled`; this line adds the server's message, which the
    // record's events do not carry. A deliberate stop is suppressed: the server
    // stores `The run was cancelled.` as `lastError`, and the tile already reports
    // `cancelled` — repeating it here would present the user's own Stop as an error.
    const failure =
        session.status === 'error'
            ? session.lastError === CANCELLED_MESSAGE
                ? undefined
                : (session.lastError ?? 'session error')
            : undefined;
    instance.view.setNotice(failure);

    if (current !== instance) return;

    paintActivity(agentSlot, instance.activity);
    renderHarnessChrome();
    paintPanels();
    runner.sync();
    setBusy(instance.pending);
};

// R7 explicit-open freshness. The board asks for ONE read when the reader opens a
// transcript; every streamed event is deliberately ignored. The answer is applied
// through the normal tombstone-guarded snapshot path (so roster/turns/tiles stay
// coherent) and then returned as the authority the dialog copies. A session switch
// or an already-deleted session makes the read stale: return undefined and let the
// board keep its last applied snapshot instead of retargeting another conversation.
const refreshTranscriptSnapshot = async (
    sessionId: string
): Promise<SessionSnapshot | undefined> => {
    if (deletedSessions.has(sessionId)) return undefined;

    const instance = [...instances.values()].find(
        (candidate) => candidate.sessionId === sessionId
    );
    if (instance === undefined) return undefined;

    try {
        const session = await getSession(sessionId);
        if (deletedSessions.has(sessionId) || instance.sessionId !== sessionId) return undefined;

        applySnapshot(instance, session);
        return instance.snapshot;
    } catch {
        // A failed freshness read never invalidates the snapshot already on screen.
        return undefined;
    }
};

// R9 thread deletion. The board owns confirmation/feedback; this function owns the
// EXISTING DELETE endpoint plus the destructive reconciliation the shell already
// uses for learned deletions:
//   1. tombstone the thread (and descendants/turns) BEFORE applying the answer, so
//      a late stream upsert cannot resurrect it;
//   2. apply the returned snapshot through the ordinary path;
//   3. even when that snapshot is stale for the watermark, the DELETE answer is
//      authoritative for THIS thread, so drop its roster rows and clear a focus
//      that pointed at it. Transcript dialogs close from the missing roster/source.
// A 404 "Unknown thread" is the desired end state (another tab/API already removed
// it): resync the session and return a successful deletion. A 409/400/500 throws:
// the caller keeps the row/data and shows the server's message.
const reconcileDeletedThread = (
    instance: Instance,
    sessionId: string,
    threadId: string,
    session: SessionSnapshot
): void => {
    if (instance.sessionId !== sessionId) return;

    tombstoneThread(instance, threadId, instance.threads);
    applySnapshot(instance, session);

    // The answer is authoritative even if `applySnapshot` rejected it as older
    // than a newer streamed frame. Filtering through the tombstones is safe in both
    // cases, and repainting the board closes the deleted surfaces immediately.
    instance.records = new Map(
        [...instance.records].filter(([, turn]) => !turnTombstoned(instance, turn))
    );
    // Tool panels are derived state, exactly like `applySnapshot`: recompute them
    // from the surviving records so a deleted thread's `tool_result.ui` cards do
    // not survive a stale DELETE answer that the watermark guard rejected.
    instance.panels = mediaOfTurns([...instance.records.values()]);
    instance.view.reconcile([...instance.records.values()], instance.sessionModel);
    instance.threads = instance.threads.filter((entry) => !instance.threadTombstones.has(entry.id));
    instance.view.setThreads(instance.threads);
    if (instance.snapshot !== undefined) {
        const rawThreads = Array.isArray(instance.snapshot.threads)
            ? instance.snapshot.threads.filter((entry) => !instance.threadTombstones.has(entry.id))
            : undefined;
        instance.snapshot = {
            ...instance.snapshot,
            turns: instance.snapshot.turns.filter((turn) => !turnTombstoned(instance, turn)),
            ...(rawThreads === undefined ? {} : { threads: rawThreads })
        };
    }
    instance.view.setSessionSnapshot(instance.snapshot);

    const focused = instance.view.focusedThread();
    if (focused !== undefined && instance.threadTombstones.has(focused)) {
        instance.view.clearFocus();
    }

    // Same app-facing effect as the normal snapshot path: the selected view paints
    // the current instance's derived panels (or hides empty hosts).
    if (current === instance) paintPanels();
};

const deleteThreadForSession = async (
    sessionId: string,
    threadId: string
): Promise<DeleteThreadResult> => {
    const instance = [...instances.values()].find(
        (candidate) => candidate.sessionId === sessionId
    );
    if (instance === undefined) throw new Error('Unknown session');

    try {
        const result = await deleteSessionThread(sessionId, threadId);
        reconcileDeletedThread(instance, sessionId, threadId, result.session);
        return result;
    } catch (error) {
        if (!messageOf(error).includes('Unknown thread')) throw error;

        // Already gone: the caller's intended end state holds. Re-read so the
        // roster/turns/focus reconcile to whatever the server holds now.
        const session = await getSession(sessionId);
        reconcileDeletedThread(instance, sessionId, threadId, session);
        return { deleted: true, session };
    }
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
        // S3: a DELETED thread (or a turn removed with it) must never come back. An
        // upsert can be in flight while the DELETE answer lands, so the tombstone —
        // not arrival order — decides. The tile is not adopted and no focus moves.
        if (turnTombstoned(instance, item.turn)) return;

        // UPSERT the record and the tile. A queued turn is retained behind the
        // active one; a running turn starts the clock/ring; a terminal one settles.
        instance.records.set(item.turn.id, item.turn);
        instance.view.upsert(item.turn, instance.sessionModel);
        refreshPending(instance);
        refreshActivity(instance);

        if (current === instance) {
            // The topbar pill is app-scoped. The last retained task settling is a
            // session outcome: the tile says `done`/`error`/`cancelled`, so the
            // global header is left untouched (R1).
            setBusy(instance.pending);
        }
        return;
    }

    if (item.type === 'event') {
        // A late event for a deleted turn is dropped for the same reason as a late
        // upsert (S3): it would repaint a conversation the server already removed.
        if (instance.turnTombstones.has(item.turnId)) return;

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
        if (current === instance) {
            paintActivity(agentSlot, instance.activity);
            // R12 (T5): keep the OPEN dialog's team cards truthful without a rebuild —
            // event frames can arrive many times per second, so repainting the ring is
            // both cheaper and non-disruptive (focus/details stay put).
            agentDialog?.paintActivity(instance.activity);
        }

        // R21.3 LIVE panels: a tool result may carry `ui`. Upsert it into THIS
        // instance's board immediately, scoped by the tool name.
        if (item.event.type === 'tool_result') {
            const changed = applyPanels(instance.panels, item.event.name, item.event.ui);
            if (changed > 0 && current === instance) paintPanels();
        }
        return;
    }

    // Terminal/drain frames (snapshot | failed) carry the complete session, turns
    // included. Apply it reconciles everything the frames may have missed — and its
    // `lastError` populates the pane's session note. The pill is NOT touched: a
    // failed run is session-scoped (R1); its detail is in the transcript (R2).
    applySnapshot(instance, item.session);
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

// NOTE: the per-thread STOP (`POST .../threads/:id/cancel`) and DELETE
// (`DELETE .../threads/:id`) handlers that lived here were wired exclusively to the
// removed `.thread-strip` rows. With no UI surface calling them they are gone;
// `api.ts` still exports `cancelSessionThread`/`deleteSessionThread` for embedders,
// and the session-wide stop stays in `stopRun` (`POST /sessions/:id/cancel{all}`).
// The deletion tombstones below remain live: a server snapshot that drops a thread
// (deleted by another tab or by the API) is learned and filtered the same way.

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

            // Losing the live stream is not a run failure: polling continues to
            // paint the same session, so neither the app-scoped pill nor the pane's
            // error note is touched (R1/R3). A genuine failure of that fallback is
            // reported by `pollSession` itself.
            if (instance.sessionId === sessionId) pollSession(instance, sessionId);
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
            // A lost fallback is a real connectivity failure for THIS conversation,
            // so it is reported in the pane (actionable, scoped) rather than in the
            // app-scoped header (R1/R3). The session keeps its last painted state.
            instance.view.setNotice(
                `lost connection while following this session: ${messageOf(error)}`,
                'error'
            );
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

        // The pill is app-scoped: a session that is still being polled is visible
        // on its tiles and Stop button, not in the global header (R1).
        if (attempts >= POLL_MAX_ATTEMPTS) {
            stopPolling();
            // Bounded fallback exhausted: report where the conversation is, not in
            // the header, and say what the reader can do (R2/R3).
            instance.view.setNotice('stopped following this session · reopen it to retry', 'info');
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

    // R8: this read may have been in flight when the row was deleted (a DELETE is
    // allowed while a session is being opened). The record is gone server-side, so
    // a pre-delete answer must not reopen it or restore the remembered pointer.
    if (deletedSessions.has(id)) return;

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

    // One session, one card: release any other card pointed at this id. The release
    // must invalidate that card's raw transcript authority and close any transcript
    // opened from it; otherwise the stale source can reopen after the session moved.
    for (const instance of instances.values()) {
        if (instance !== target && instance.sessionId === id) {
            instance.sessionId = undefined;
            instance.snapshot = undefined;
            instance.snapshotMark = undefined;
            instance.threads = [];
            instance.view.bindSession(undefined);
            instance.view.setThreads([]);
            instance.view.setSessionSnapshot(undefined);
        }
    }

    // N1: everything the instance holds about the conversation being LEFT is stale
    // once a DIFFERENT session is opened. Thread ids are minted per session, so the
    // previous session's roster/records must not be the baseline for `applySnapshot`
    // deletion learning — otherwise an id the new session will mint later (e.g.
    // `thread-2`) is tombstoned on arrival and the new thread can never appear.
    //
    // Tombstones are session-scoped by construction: they live on the instance and
    // are cleared exactly here (and in `ensureSession`/`newSession`), while
    // `applySnapshot` refuses a snapshot for any other session id.
    if (target.sessionId !== undefined && target.sessionId !== id) {
        target.threadTombstones.clear();
        target.turnTombstones.clear();
        target.records = new Map<string, SessionTurn>();
        target.threads = [];
        target.snapshotMark = undefined;
        target.snapshot = undefined;
        target.view.setSessionSnapshot(undefined);
    }

    target.sessionId = id;
    // N3: an answer card from the conversation being left cannot follow the
    // reader here; binding expires it before the new transcript is drawn.
    target.view.bindSession(id);
    target.frozen = frozenDefinitionOf(session);

    selectHarness(descriptor.name);
    applySnapshot(target, session);
    rememberSession(id);

    if (pendingOf(session)) {
        // R4: a reloaded/selected session with a live queue gets the observer, not
        // a one-way poll — queued tasks advance and stream here automatically.
        // No header write: pending work is session state, shown on its tiles.
        startWatching(target, id);
        return;
    }

    // A saved error session's detail is already in the pane note via
    // `applySnapshot`; the topbar pill stays app-scoped (R1).
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
    // N3: a card left on the old conversation can no longer be answered; expire it
    // before the board is cleared.
    instance.view.bindSession(undefined);
    instance.frozen = undefined;
    instance.sessionModels = undefined;
    instance.sessionModel = undefined;
    instance.discovered = undefined;
    // A new conversation has no pending work and no server records; the queue
    // belongs to the previous session and keeps running there.
    instance.pending = false;
    instance.records.clear();
    // The watermark and raw authority belonged to the previous conversation; a new
    // session's snapshots start a fresh clock/source.
    instance.snapshotMark = undefined;
    instance.snapshot = undefined;
    instance.view.setSessionSnapshot(undefined);
    // A new conversation has no tool output yet: clearing the instance state and
    // repainting is what drops the previous session's board and any manual panels
    // that lived only in the browser (R21.3).
    instance.panels.clear();
    clearActivity();
    // The conversation (and its thread roster) is gone: clearing the board also
    // drops the focus, and the emptied roster leaves the composer with "New thread"
    // instead of a target in the previous session.
    instance.threads = [];
    instance.threadTombstones.clear();
    instance.turnTombstones.clear();
    instance.view.setThreads(instance.threads);
    instance.view.clear();
    // The conversation (and its failure/stop detail) is gone; an empty session has
    // no outcome to report.
    instance.view.setNotice(undefined);
    if (instance === current) forgetRememberedSession();
    // Lifecycle: the agent dialog belongs to the conversation being left. Closing it
    // here also releases its focus trap/scroll lock before the chrome repaints.
    closeAgentDialog();
    // R2: the harness details dialog described the SAVED session (frozen team), so it
    // is dismissed when that conversation is replaced by a fresh one.
    closeHarnessDialog();
    renderHarnessChrome();
    renderSessions();
    paintPanels();
    setStatus('idle');
    // R8: starting a new session must not move focus into the composer. The draft is
    // module-scoped and survives session switches, so there is nothing to re-enter;
    // the user clicks the field when they want to type.
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

// Paint every control from (a) whether the selected session has pending work and
// (b) whether a submit is in its short enqueue window.
//
// R4 keys:
//   - The composer's SUBMIT action stays ENABLED while a task runs: submitting
//     another task is how the queue grows. Only `submitting` (the POST /tasks round
//     trip) locks it — see `paintComposer`.
//   - The composer switches to its STOP action whenever work is pending, including
//     a session observed after a reload (Stop then cancels ALL explicitly via
//     cancelSession(id, true)).
//   - New session/harness switching/the tools view stay locked while pending, because
//     they would tear down the view of a queue that is still running. Reset is gone
//     (R10), so there is no third composer control to paint.
const paintControls = (): void => {
    const pending = running || current?.pending === true;

    // R9/R10: the composer's single action is painted from the same state as every
    // other control. It is the only submit/stop control in the shell.
    paintComposer();

    newSessionButton.disabled = submitting || pending || !booted;
    createHarnessButton.disabled = submitting || pending || !booted;

    // Harness/session switching is allowed while work is pending (R4): the queue
    // is server-owned, so leaving a conversation never stops it; the observer is
    // simply unsubscribed and reopened when the reader returns.
    for (const button of harnessButtons.values()) button.disabled = submitting || !booted;
    for (const button of toolTabButtons.values()) button.disabled = submitting || pending;
    // R3: the global tools toggle is locked while a run is pending, like the tabs it
    // replaced; leaving the transcript of a streaming queue is not offered. It is also
    // locked before boot has a catalogue (`booted`) and after `showOffline` disables it.
    toolsToggle.disabled = submitting || pending || !booted;
    for (const row of sessionList.querySelectorAll<HTMLButtonElement>('.session')) {
        row.disabled = submitting;
    }

    // R8: deletion is a write, so it is disabled for the same conflicting windows
    // that lock submits/saves (and for a row whose own DELETE is in flight). The
    // click handler re-checks `deletionBlocked`, so this is only the visible state.
    const deletionsBlocked = deletionBlocked();
    for (const button of sessionList.querySelectorAll<HTMLButtonElement>('.session-delete')) {
        const id = button.dataset.sessionId;
        button.disabled = deletionsBlocked || (id !== undefined && removingSessions.has(id));
    }

    // The compact agent control follows the pending lock for TEAM edits; models
    // remain live (R2) and are handled in renderHarnessChrome/renderAgentControl.
    if (current !== undefined) renderHarnessChrome();
};

const setBusy = (value: boolean): void => {
    running = value;

    // A creation form left open while work starts would still be submittable;
    // close it so no POST can race the queue.
    if (value && createPanel.isOpen()) createPanel.close();

    paintControls();
};

// The topbar pill is the APP's live state (R1), and the only live region:
//   connecting → startup/bootstrap, `saving` → an app-scoped config write is in
//   flight (harness/model PATCH), `idle` → ready, `error` → an app or config
//   operation the reader must act on (offline server, unreadable session list,
//   rejected harness/config edit).
//
// R3: the VISIBLE word is the concise state vocabulary only (idle/connecting/
// saving/error). The full diagnostic — which used to replace the word entirely and
// push the topbar wide — is preserved twice: as the pill's `title` tooltip for
// pointer readers, and as a visually hidden `status-detail` child inside the live
// region for assistive tech (a `title` is not announced by `role="status"`).
// Detailed error surfaces (the offline pane, the session note, the dialog's own
// messages) are untouched.
//
// It must NEVER carry session/run outcomes: running, queued, done, cancelled and
// failed turns are properties of ONE conversation, already rendered by its tiles
// (status word) and its pane note (`View.setNotice`, error detail). Painting them
// here made the header lie the moment the reader switched sessions (the cancelled
// session's "The run was cancelled." outlived it).
type AppStatus = 'idle' | 'connecting' | 'saving' | 'error';

const setStatus = (state: AppStatus, detail?: string): void => {
    statusPill.dataset.state = state;
    statusText.textContent = state;

    // The tooltip carries the full diagnostic; a bare state has no tooltip at all
    // (an empty `title` would still show an empty hover bubble).
    if (detail === undefined || detail === state) {
        statusPill.removeAttribute('title');
        // Clear the live-region detail too: an emptied node cannot announce stale
        // text, and `aria-atomic` then reads just the new state word.
        statusDetail.textContent = '';
        return;
    }

    statusPill.title = detail;
    // R3 (T4): the SAME diagnostic is exposed to assistive tech through the hidden
    // live-region child. Text is set (never appended), so repeated identical saves
    // cannot accumulate and each change announces once.
    statusDetail.textContent = detail;
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
    // N3: the first submit of a new conversation creates the session before the
    // task is enqueued, so bind here: any action card that arrives with the run is
    // answerable against this id.
    instance.view.bindSession(session.id);
    instance.frozen = frozenDefinitionOf(session);
    // The creation answer carries this session's effective model map, which is also
    // the map a later PATCH /sessions/:id replaces (R2).
    instance.sessionModels = agentModelsOf(session);
    instance.sessionModel = typeof session.model === 'string' ? session.model : undefined;
    instance.discovered = Array.isArray(session.discoveredTools)
        ? [...session.discoveredTools]
        : undefined;
    // A fresh session has no turns and no pending work; clear any stale queue state
    // from the conversation this card used to point at. Tombstones are per-session,
    // so the new conversation starts with none (S3).
    instance.threadTombstones.clear();
    instance.turnTombstones.clear();
    instance.records = new Map(session.turns.map((turn) => [turn.id, turn]));
    instance.pending = pendingOf(session);
    // A brand-new session has no persistent threads yet; handing the empty roster to
    // the board clears any focus left over from the conversation this card used to
    // point at.
    instance.threads = sessionThreadsOf(session);
    instance.view.setThreads(instance.threads);
    // Creation answer is the initial raw JSON authority for this new session.
    instance.snapshot = {
        ...session,
        turns: session.turns,
        ...(Array.isArray(session.threads) ? { threads: session.threads } : {})
    };
    instance.view.setSessionSnapshot(instance.snapshot);
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
    const prompt = editorText(input).trim();

    // An in-flight read is not a draft: submitting now would send a prompt whose
    // marker has no bytes. The action is disabled in that state, and the shortcut
    // is guarded here so it cannot race the read either.
    if (attachmentReads > 0) {
        setAttachmentError('Wait for the attached file to finish loading.');
        return;
    }

    // Attachment-only turns are allowed by the server, so an empty prompt is not
    // by itself a refusal when a ready attachment exists.
    const attachments = readyAttachmentRecords();

    // Only the short enqueue window is single-flight (R4). Pending work does NOT
    // block a submit: a task submitted while another runs is the queue.
    if (submitting || savingAgents || (prompt.length === 0 && attachments.length === 0)) return;

    const instance = current;
    if (instance === undefined || currentTool !== undefined) return;

    if (instance.descriptor.requiresEndpoint && settings.baseURL.trim().length === 0) {
        instance.view.notice('set a base URL in Endpoint, then run again');
        setStatus('error', 'no endpoint configured');
        return;
    }

    // Re-validate the WHOLE payload immediately before it leaves the browser. The
    // per-file gate already ran on encode; this is the boundary check (count, total
    // bytes, uniqueness) and its failure must not clear the draft.
    let validated: HarnessAttachment[];
    try {
        validated = validateAttachments(attachments);
    } catch (error) {
        setAttachmentError(messageOf(error));
        return;
    }

    if (validated.length === 0 && prompt.length === 0) return;

    // Snapshot the drafts this submit sends. They are removed only on SUCCESS, so
    // a failure leaves the chips (and their markers) intact for a retry.
    const sentDrafts = draftAttachments.filter((draft) => draft.data !== undefined);
    // Exact # bindings carried by reference chips, plus a DOM snapshot of the
    // whole draft. A failed submit restores the snapshot, so a reference chip keeps
    // its turn/thread binding instead of degrading to plain `#LABEL` text.
    //
    // Boundary filter (R7): a chip can name a turn an authoritative snapshot has
    // already dropped (its thread was deleted between the last paint and this
    // click). The server rejects the WHOLE body in that case, so the stale binding
    // is dropped here as a last line of defence; `purgeStaleReferences` normally
    // removes the chip itself the moment the snapshot arrives.
    const knownTurns = instance.sessionId === undefined ? undefined : new Set(instance.records.keys());
    const references = referencesOfChips(editorChips(input)).filter(
        (reference) => knownTurns === undefined || knownTurns.has(reference.turnId)
    );

    // WHERE this message goes (R5/R6). Computed from the same focus + reference +
    // attachment inputs the composer's routing line shows, through the same pure
    // helper:
    //   - focused idle/stopped thread -> continue it;
    //   - focused running thread, text only, every reference settled -> steer it;
    //   - focused running thread WITH attachments or an unfinished reference -> a
    //     queued continuation turn in the same thread (label says "Queued in");
    //   - no focus, # references    -> NEW thread connected through those blocks;
    //   - no focus, no references   -> NEW standalone thread.
    // The qualifier is display-only: `threadId` (and therefore the body) is the same
    // in every focused case, and its absence is the wire's "open a new thread"
    // signal, so a legacy server sees the exact body it always saw.
    const target = resolveSubmitTarget({
        focus: instance.view.focusedThread(),
        threads: instance.threads,
        references: references.length,
        // `validated` is the exact set leaving the browser, so the qualifier cannot
        // disagree with what the server receives.
        attachments: validated.length,
        unfinishedReferences: unfinishedReferenceCount(instance.records, references)
    });

    const draftSnapshot = editorSnapshot(input);
    setAttachmentError(undefined);

    // The tile exists before the request does, in submission order, so a second
    // task visibly sits BEHIND the active one from the first frame. It starts
    // `queued` and neutral: no ring, no clock.
    const turn = instance.view.begin(prompt, validated, target.threadId);
    // `submitting` is set BEFORE the field is cleared so the chip MutationObserver
    // does not mistake this programmatic clear for a user deletion.
    submitting = true;
    editorSetText(input, '');
    // R9: the field shrinks back to one row immediately; the inline height from the
    // filled state would otherwise leave a tall empty box until the next keystroke.
    autoGrow();
    paintControls();
    // Freeze the inline chips (remove controls disable) for the enqueue window.
    paintAttachments();
    // No header write: the optimistic tile already shows the submit lifecycle, and
    // the topbar pill is app-scoped (R1).

    let sessionId: string | undefined;

    try {
        // Session creation is part of the submit. `ensureSession` is deduplicated:
        // a task enqueued while another session creation is settling still gets
        // exactly one session (creatingSessions + the instance id).
        sessionId = await ensureSession(instance);

        // 202: the server retained the task and answered with its record. The
        // request is over here — execution and streaming happen on GET /events.
        // `references` carries the exact block bindings picked via # (omitted when
        // the prompt has none, so a plain typed `#LABEL` keeps the old body shape).
        const { session, turn: record } = await enqueueTask(
            sessionId,
            prompt,
            validated,
            references.length === 0 ? undefined : references,
            // Absent for a new thread: the server decides the new thread's id and
            // reports it on the record (and in the roster of the snapshot below).
            target.threadId
        );

        // Steering answers with the OWNING turn (same id, `steered: true`) instead
        // of a new record: the optimistic steering row must not survive as an unbound
        // queued ghost, so it is discarded and the record is merged into the tile
        // that already represents that conversation. Every other path binds this tile
        // as usual, and `merge` applies only events the tile has not seen yet (a
        // retried answer can never duplicate a streamed prefix).
        //
        // The id check is kept alongside the marker: it also collapses the (rare)
        // case of a server that folds the submit without reporting `steered`.
        const owner = instance.view.turn(record.id);
        if (owner !== undefined && owner !== turn) {
            instance.view.discard(turn);
            owner.merge(record, session.model);
        } else {
            turn.merge(record, session.model);
        }

        // Keep the steering target visible on the conversation that received the
        // message: continuing/steering must not silently move focus elsewhere.
        if (target.threadId !== undefined) instance.view.focusThread(target.threadId);

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

        // SUCCESS is the only point at which the sent draft is consumed. Any chip
        // the user added during the short enqueue window stays (the markers already
        // left the field with the previous submit); counters reset only when the
        // draft is empty, so a surviving marker's number is never reused.
        for (const draft of sentDrafts) releaseAttachmentPreview(draft.previewUrl);
        draftAttachments = draftAttachments.filter((draft) => !sentDrafts.includes(draft));
        if (draftAttachments.length === 0) attachmentCounters = createAttachmentCounters();
        paintAttachments();
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
            instance.snapshotMark = undefined;
            instance.pending = false;
            instance.snapshot = undefined;
            instance.threads = [];
            // Bind teardown expires answer cards AND closes the tracked transcript;
            // clearing the roster/snapshot also stops the board's standalone
            // fallback from reopening that transcript from stale tile records.
            instance.view.bindSession(undefined);
            instance.view.setThreads([]);
            instance.view.setSessionSnapshot(undefined);
            instance.panels.clear();
            // The conversation is gone from the server; any outcome detail from it
            // would describe a session this card no longer points at.
            instance.view.setNotice(undefined);
            if (instance === current) paintPanels();
            if (instance === current) forgetRememberedSession();
            void refreshSessions();
        }

        // A failed submit is the TASK's failure (rejected input, unreachable
        // server): the tile and the transcript notice say so, and the draft stays.
        // The field was cleared optimistically; restoring the DOM snapshot (only
        // when the reader has not started a new message meanwhile) means no input
        // is lost AND reference chips keep their exact turn/thread binding.
        //
        // The snapshot carries only the chips; their BYTES still live in
        // `draftAttachments` because a failure never consumes them. Reconcile the
        // two sides so a failed turn can never leave an attachment without its
        // marker:
        //   - field still empty (nobody typed, or the turn was attachment-only):
        //     restore the exact snapshot, chips and their draft entries together;
        //   - the reader started the next message: keep that text, and drop the
        //     failed turn's drafts (bytes, record, object URL) because its markers
        //     are gone with the cleared field. Otherwise the next POST would carry
        //     `attachments` whose markers are nowhere in the prompt.
        if (editorText(input).length === 0) {
            editorRestore(input, draftSnapshot);
            autoGrow();

            // N3: the restored snapshot was captured BEFORE this request. If a `#`
            // target was deleted while the submit was in flight (the usual reason a
            // continue/steer is rejected), restoring its chip would reinstate a
            // binding the server no longer knows — and the next retry would either
            // 400 again or resolve the same label to a different block. Filter the
            // restored chips against the LIVE tombstone-filtered records, silently:
            // the surviving text, attachments and draft entries stay untouched.
            purgeStaleReferences(liveTurnIds(instance), { report: false });
        } else {
            // Marker counters keep their values (a removed marker is never
            // renumbered - same rule as the chip × and the chip observer).
            for (const draft of sentDrafts) forgetDraftAttachment(draft.id);
            // `finally` repaints once `submitting` is released, so the chip
            // controls are not painted disabled here.
        }
        // Not a stream failure, and it is NOT painted into the app-scoped header
        // (R1): a run failure must not outlive the session it belongs to.
        turn.setState('error', message);
        instance.view.notice(`task failed: ${message}`, 'error');
        void refreshSessions();
    } finally {
        submitting = false;
        // Repaint from the authoritative pending flag. The queue observer owns
        // every later transition; this only releases the enqueue lock.
        setBusy(current?.pending === true);
        turn.flush();
        // R8: send success/failure must not refocus the composer. The field was
        // cleared optimistically (or restored on failure); the user decides when to
        // return to it, so no lifecycle branch calls input.focus() here.
        // Release the frozen chip strip (remove controls return; a successful send
        // already emptied it above).
        paintAttachments();
    }
};

composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void run();
});

// Keyboard contract (R1). The send button is the primary path; the keyboard only
// mirrors it, EXCEPT while an @/# popup is open (UniversalTextBox parity):
//   popup open + ArrowDown/ArrowUp -> move the active row
//   popup open + Enter or Tab      -> pick the active row (never submit/newline)
//   popup open + Escape            -> close the popup
//   Enter              -> native newline. NEVER prevented and NEVER submits, so the
//                         field behaves like any other multiline editor.
//   Shift+Enter        -> native newline (unchanged).
//   Alt+Enter          -> native newline (also unchanged: Alt is a content modifier).
//   Ctrl+Enter, Cmd+Enter -> explicit send shortcut. The ONLY keyboard submit path
//                         (it wins over the popup, so a reader can queue the task
//                         without picking a suggestion).
//   IME composition    -> ignored entirely: the Enter that confirms a candidate
//                         belongs to the input method, so it must not submit and must
//                         not be prevented (`isComposing`, plus keyCode 229 for older
//                         engines that only report the legacy marker).
// Both the shortcut and the button run through the form's own `submit` path, so
// queueing while a run is in flight (R4) stays identical.
input.addEventListener('keydown', (event) => {
    // IME guard first: no composition key may reach the popup or send logic.
    if (event.isComposing || event.keyCode === 229) return;

    const sending = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;

    // R4/R5: the editor owns Backspace/Delete AT an inline chip.
    //
    // A chip is a `contenteditable=false` island (plus `user-select: none`), and
    // Chromium/WebKit do not delete such an island reliably with the native
    // keystroke: the caret sits next to the chip yet the browser removes the
    // neighbouring text character instead, so a pasted image could not be
    // backspaced at all. When the keystroke targets a chip (collapsed caret exactly
    // beside one, or a selection spanning one) the default is prevented and the
    // deletion is applied atomically here: chip DOM, draft bytes, object URL and
    // record leave together.
    //
    // Guards:
    //   - plain key only (Ctrl/Alt/Cmd keep their word/line deletion semantics);
    //   - not during the frozen enqueue window (`submitting`): the payload was
    //     captured and a failed submit restores the exact snapshot;
    //   - never while the chip's × has focus: that keystroke belongs to the button,
    //     not to the field's caret.
    const plainDeleteKey =
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === 'Backspace' || event.key === 'Delete');

    if (plainDeleteKey && !submitting) {
        const fromRemoveButton =
            event.target instanceof HTMLElement && event.target.closest('[data-chip-remove]') !== null;

        if (!fromRemoveButton) {
            const deletion = editorDeleteChips(
                input,
                event.key === 'Backspace' ? 'backward' : 'forward'
            );

            if (deletion !== undefined) {
                event.preventDefault();

                for (const id of deletion.ids) forgetDraftAttachment(id);

                autoGrow();
                paintAttachments();
                // A native edit would emit `input`; keep the popup/action/height
                // observers on the same contract.
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
        }
    }

    if (composerPopupState !== undefined) {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveComposerPopup(1);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveComposerPopup(-1);
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            closeComposerPopup();
            return;
        }

        if ((event.key === 'Enter' || event.key === 'Tab') && !sending) {
            // Only hijacked when there is something to pick; an empty/loading list
            // lets Enter stay a newline and Tab stay a focus move.
            if (selectComposerPopup()) {
                event.preventDefault();
                return;
            }
        }
    }

    if (event.key !== 'Enter') return;

    // Send only on Ctrl/Cmd. Shift or Alt alongside it is still a newline request
    // (content modifiers win), and a bare Enter is left to the browser.
    if (!sending) return;

    event.preventDefault();
    void run();
});

// Stop is explicit and TOTAL (R4): `{ all: true }` makes the server abort the
// active task AND cancel every retained queued record, so the queue drains instead
// of immediately starting the next task. Merely aborting the observer would only
// unsubscribe — work would keep running.
const stopRun = (): void => {
    const instance = current;
    const sessionId = instance?.sessionId;
    if (instance === undefined || sessionId === undefined || !instance.pending) return;

    stopWatching();

    // The cancel round trip is async; the tile keeps its last state until the
    // server confirms. No header acknowledgement: Stop is a session action and is
    // not an app-level state (R1).

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
};

// R10: one action, two roles. Submit mode is the form's own submit button (pointer and
// the Ctrl/Cmd+Enter shortcut take the existing run() path, queueing included); only
// stop mode needs a direct listener. The state check makes a late click after the
// queue drained a no-op instead of a stale cancel.
actionButton.addEventListener('click', (event) => {
    if (actionButton.dataset.action !== 'stop') return;

    event.preventDefault();
    stopRun();
});

// The separate stop-all control shares `stopRun` exactly (cancelSession(id, true)):
// one cancellation path, one reconciliation, both from the same `pending` guard.
stopAllButton.addEventListener('click', (event) => {
    event.preventDefault();
    stopRun();
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

    // Object URLs for draft thumbnails are page-lifetime only; release them so a
    // reload/new document does not leak blob storage. The bytes themselves are in
    // the draft records (which this document is dropping anyway).
    for (const draft of draftAttachments) releaseAttachmentPreview(draft.previewUrl);
    draftAttachments = [];

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

const showConnecting = (): void => {
    const pane = el('div', 'pane');
    const wrap = el('div', 'log-wrap');
    const box = el('div', 'empty');

    // The centre is empty until the catalogue arrives. Without this pane a slow or
    // hanging bootstrap looks like a blank page (R1): paint the shell's startup
    // state FIRST, so the reader always has a visible, accessible status while the
    // first request is in flight. `setStatus('connecting')` names the same phase in
    // the topbar pill, which is the live region.
    box.append(
        el('h2', 'empty-title', 'Connecting to the harness server…'),
        el('p', 'empty-text', `Contacting ${API_ROOT.length > 0 ? API_ROOT : '(origin)'}…`),
        el(
            'p',
            'empty-hint',
            'This page is only the UI: the harness API runs as a separate process. If none answers, the next screen explains how to start one.'
        )
    );

    wrap.append(box);
    pane.append(wrap);
    stage.replaceChildren(pane);
};

const showOffline = (message: string): void => {
    const pane = el('div', 'pane');
    const wrap = el('div', 'log-wrap');
    const box = el('div', 'empty');

    box.append(
        el('h2', 'empty-title', 'Harness server unavailable'),
        // The server/proxy text is rendered with textContent by `el`, so an error
        // page or a hostile response body can never inject markup here.
        el('p', 'empty-text', message),
        el(
            'p',
            'empty-hint',
            'Start the API with `yarn start-service` (repo root, /v1/harness on :5000), then reload. `yarn dev:frontend` is the Vite UI only; it does not start an API.'
        )
    );

    // Retry is a full reload on purpose: it re-resolves the API root, re-reads the
    // bootstrap document and resets every in-flight observation, which is exactly
    // what "connect again" means for this client.
    const retry = el('button', 'button primary', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => location.reload());

    const retryActions = el('div', 'composer-actions');
    retryActions.append(retry);
    box.append(retryActions);

    wrap.append(box);
    pane.append(wrap);
    stage.replaceChildren(pane);

    // No catalogue, no tools view: the only useful action is Retry.
    toolsToggle.disabled = true;

    if (presetDescriptors.length === 0) {
        harnessList.replaceChildren(el('p', 'field-hint', 'No server connection.'));
    }
};

const boot = async (): Promise<void> => {
    setStatus('connecting');
    // Render before the first await: a failed or slow network must leave a visible
    // startup state, never an empty centre column (R1).
    showConnecting();

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
        // R9/R10: paint the single composer action now that submitting is allowed
        // (it stays hidden while the field is empty and nothing is pending).
        paintComposer();
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

        // R8: initial load never focuses the composer. The page opens with focus
        // where the browser put it (body); the user clicks the field to type.
    } catch (error) {
        showOffline(messageOf(error));
        setStatus('error', 'server offline');
    }
};

void boot();

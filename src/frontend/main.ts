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
//   - left rail  — harnesses (built-ins and user-created) plus the create form and
//                  the `left` tool-panel host. The endpoint/model settings are NOT
//                  here any more (R4/T4): they open from the top-right status pill;
//   - centre     — the selected harness title, the SESSION PILLS for the selected
//                  harness (T3/R1: one pill per saved conversation, with New/Refresh),
//                  the `center` tool-panel host, the transcript and the composer. The
//                  composer is ONE bordered frame
//                  with a notched routing label on its top border (R14), the single
//                  agent button on its LEFT edge (R16, opens the shared agent dialog
//                  — team, models and instructions) and stop/send on the right. The GLOBAL tools view (the
//                  full-width list of EVERY server tool — core entries included)
//                  replaces this column when the topbar's icon-only Tools toggle is
//                  pressed; activating one entry opens its manual runner in the
//                  shared modal. There is no tab strip (R3);
//   - right rail — the tool-contributed SCRATCH BOARD (primary panel host), and nothing
//                  else since T3/R1 moved the session directory into the header. On a
//                  phone it opens from the floating `.scratch-fab` (T3/R3), and since T8
//                  it opens in the SAME left-hand sidebar slot as the harness drawer: the
//                  phone has one sidebar, showing whichever trigger was pressed last.
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
// toolCreate, task and delegate change THAT conversation — and the snapshot is
// re-read afterwards so discoveries and the task list show up. The browser never evaluates a
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
// build-time VITE_HARNESS_API → the local/LAN chain on a GitHub Pages host → /api)
// and `loadBootstrap` works against the canonical `/v1/harness` root document or
// the standalone `/api` routes.

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
    apiRootCandidates,
    callTool,
    cancelSession,
    createHarness,
    createSession,
    deleteHarness,
    deleteSession,
    deleteSessionOnUnload,
    deleteSessionThread,
    enqueueTask,
    getSession,
    listProviderModels,
    listSessions,
    loadBootstrap,
    observeSession,
    updateHarness,
    updateSession,
    updateThreadTranscript
} from './api';
import type { HarnessBootstrap, ThreadTranscriptPayload } from './api';
import {
    agentInstructionsOf,
    agentModelsOf,
    agentsFromDescriptors,
    builtinOf,
    canonicalHarnessName,
    frameAtOf,
    frameUsageOf,
    frozenDefinitionOf,
    instructionsForMembers,
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
import type { AgentApplyResult, AgentConfigurationApply, AgentDialog } from './ui/agent-dialog';
import { createTextCopyButton, openDialog } from './ui/dialog';
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
import type { FilePreviewReader, FilePreviewResult, FilePreviewResolver } from './ui/file-preview';
// The preview dialog owns the basename-resolution RULES (exact-name filter,
// shallowest-first order); the shell below only supplies the `glob` round-trip.
import { filePreviewGlobPattern } from './ui/file-preview';
import { createTurnBoard, labelSeedsOf } from './ui/turns';
import type { AnswerActionInput, TurnHandle } from './ui/turns';
// Harness totals for the details dialog (threads / input / time / cache across EVERY
// session of the selected harness). The pure helper lives in `ui/` so it is testable
// without booting the shell, and the two formatters are the SAME ones the turn header
// already prints token counts and elapsed time with — one vocabulary of numbers.
import { summarizeSessionUsage } from './ui/usage-summary';
import type { SessionUsageSummary } from './ui/usage-summary';
import { formatDuration } from './ui/time';
import { formatTokens } from './ui/tokens';
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
    const response = await callTool('read', [{ path, startLine, maxLines }]);

    if (!response.ok) throw new Error(response.error.message);

    // The dialog reads this structurally (`files[]`); the cast only carries the
    // tool's documented result shape across the generic endpoint boundary.
    return response.result as FilePreviewResult;
};

// R11+: a transcript reference is usually a BARE BASENAME (`descriptors.ts`), and
// the `read` tool resolves a path against the SERVER working directory with no
// fuzzy search — so such a click failed with `no such file or directory (ENOENT)`
// even though the file existed somewhere in the tree. This adapter is the missing
// lookup: it asks the SAME `glob` tool the `@` picker already uses (main.ts
// `lookupComposerPopup`), rooted at `'.'`, which is the working directory `read`
// resolves against (src/server/runtime.ts — there is deliberately no
// workspace-root endpoint).
//
// Pattern: `**/<name>` from `filePreviewGlobPattern`. `**/` can consume ZERO
// directories (src/tools/files/glob.ts `globToRegExp`), so a file sitting at the
// workspace root is found too — verified by ui/file-preview-glob.test.ts against
// the real tool, which is why no `["<name>"]` fallback pattern is needed.
//
// The answer stays RAW here on purpose: exact (case-sensitive) basename filtering,
// unsafe-path rejection, dedupe and the shallowest-first order all live in
// ui/file-preview.ts `filePreviewCandidatesOf`, so the dialog and a test narrow the
// same way and a substring hit (`old-descriptors.ts`) can never be opened instead
// of the named file. A rejected `glob` call THROWS, which the dialog treats as
// "the search said nothing" and falls back to reading the path as typed.
const resolveFileForPreview: FilePreviewResolver = async (name) => {
    const response = await callTool('glob', {
        patterns: filePreviewGlobPattern(name),
        paths: ['.'],
        maxResults: 100
    });

    if (!response.ok) throw new Error(response.error.message);

    // `glob` answers `{ files, truncated }`; `filePathsOf` narrows that structurally
    // (an error body or an older server yields no rows, never a throw).
    return filePathsOf(response.result);
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
    removeThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>,
    // C5: the board's transcript editor delegates the PUT here. The shell owns the
    // API and applies the returned snapshot through `applySnapshot`, so the roster,
    // the tiles, the tombstones and the dialog all reconcile from ONE authority.
    saveTranscript?: (
        sessionId: string,
        threadId: string,
        messages: unknown
    ) => Promise<ThreadTranscriptPayload>
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
        // R11+: the same links often name a file by BARE BASENAME; this turns that
        // name into the real workspace path (or a pick-list) instead of an ENOENT.
        resolveFile: resolveFileForPreview,
        ...(answer === undefined ? {} : { answerAction: answer }),
        ...(refreshTranscript === undefined
            ? {}
            : { refreshSessionSnapshot: refreshTranscript }),
        ...(removeThread === undefined ? {} : { deleteThread: removeThread }),
        ...(saveTranscript === undefined ? {} : { saveThreadTranscript: saveTranscript }),
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

// Named starting payloads the playground offers per tool (R8).
//
// WHY THIS IS A LIST AND NOT ONE EXAMPLE (R8)
// --------------------------------------------
// The runner used to fill the arguments box with a single canned value, so trying a
// second shape meant typing the whole JSON again. Each entry is now a BUTTON beside
// the box: pressing it drops the payload into the textarea, which stays a fully
// editable JSON field, and "Call tool" sends exactly what the box holds — never the
// preset object. The FIRST entry of a tool's list is what the box shows when its
// runner opens.
//
// Every value here must still be an input the tool would actually accept: a preset
// with empty tags, a missing required string, or an optional field pinned to an
// invalid 0 teaches the wrong shape, and the label promises a working call.
type ToolPreset = { label: string; value: unknown };

const PRESETS: Readonly<Record<string, readonly ToolPreset[]>> = {
    // Two properties, so the runner sends the whole object (no single-property
    // unwrapping): the language is part of the input, not a separate mode.
    // `language` is a free-text NAME now (the schema enum is gone): the tool
    // normalizes aliases (`ts`, `.tsx`, `Python3`) and errors on a language it has
    // no parser for, so a preset uses a canonical spelling.
    syntax: [
        {
            label: 'JavaScript snippet',
            value: { code: 'const answer = 42;\nconsole.log(answer);', language: 'javascript' }
        },
        {
            label: 'TypeScript snippet',
            value: { code: 'const answer: number = 42;\nexport default answer;', language: 'typescript' }
        }
    ],
    // The batched file tools each declare ONE array property, so the textarea holds
    // the array itself, not a wrapper object (T14).
    read: [
        { label: 'package.json', value: ['package.json'] },
        { label: 'This UI', value: ['src/frontend/main.ts', 'src/frontend/api.ts'] }
    ],
    write: [
        {
            label: 'New note',
            value: [{ path: 'notes/hello.txt', content: 'hello from the harness UI\n' }]
        }
    ],
    edit: [
        {
            label: 'Fix the note',
            value: [{ path: 'notes/hello.txt', oldString: 'hello', newString: 'hi' }]
        }
    ],
    // "." works from whatever directory the server runs in.
    fileList: [{ label: 'Current directory', value: ['.'] }],
    // glob declares three OPTIONAL properties, so a preset takes the whole object.
    // Both lists below are the documented defaults, and the optional `maxResults` is
    // OMITTED: an absent `maxResults` means the documented cap, whereas `0` would be
    // clamped. glob is FILE NAMES only — the old `content` property is gone (it is
    // rejected as an unknown property), so a content search is the `grep` preset below.
    glob: [
        { label: 'All files', value: { patterns: ['**/*'], paths: ['.'] } },
        { label: 'TypeScript sources', value: { patterns: ['**/*.ts'], paths: ['.'] } }
    ],
    // grep is the content half of the old fileGlob: `pattern` is required, so the
    // schema alone would only produce `{"pattern": ""}`. A regex source with two
    // alternatives plus the file filter shows the whole shape in one editable call.
    grep: [
        { label: 'TODO and FIXME', value: { pattern: 'TODO|FIXME', patterns: ['*.ts'], paths: ['.'] } },
        { label: 'The runner itself', value: { pattern: 'createToolRunner', patterns: ['*.ts'], paths: ['.'] } }
    ],
    shell: [
        { label: 'git status', value: { command: 'git status --short' } },
        { label: 'node version', value: { command: 'node --version' } }
    ],
    // Session-bound tools: the playground runs these inside its OWN temporary session
    // (R7), so their payloads have to satisfy the same schema the model sees (non-empty
    // tags, a real action, a body that would parse).
    toolRequest: [
        { label: 'Files and read', value: { tags: ['files', 'read'] } },
        { label: 'Web search', value: { tags: ['web', 'search'] } }
    ],
    toolCreate: [
        {
            label: 'shoutText',
            value: {
                name: 'shoutText',
                description: 'Uppercase a short string.',
                tags: ['text', 'upper'],
                source: 'return args.trim().toUpperCase();'
            }
        }
    ],
    // `task` (R9-R11: the old `todoManage`) is a merge/patch command, not an action
    // enum, so each button below is one complete merge the tool accepts as-is:
    //   - no properties at all reads the current list;
    //   - a `tasks` entry WITHOUT `id` adds one, and `text` is what makes it valid;
    //   - a `tasks` entry WITH `id` patches only the fields it names (here: completion);
    //   - `remove` drops the ids it lists.
    // Every success answers with the CURRENT bounded list, so the id placeholders below
    // are edited from the result of the read/add call that precedes them. The read
    // payload is identical to the schema-derived fallback (`{}`), so the runner shows one
    // button for it, never two.
    task: [
        { label: 'Current tasks', value: {} },
        { label: 'Add a task', value: { tasks: [{ text: 'Review the change' }] } },
        {
            label: 'Complete a task (edit id)',
            value: { tasks: [{ id: '<id from the list above>', completed: true }] }
        },
        { label: 'Remove a task (edit id)', value: { remove: ['<id from the list above>'] } }
    ],
    // delegate has NO static preset: its only valid target is one of the PLAYGROUND
    // harness's subagents, and a hard-coded id (the old 'summarizer' one) was wrong
    // for every harness that does not configure it. The runner builds those presets
    // from `delegateTargets` at show time (see `presetsFor` below).
    timeNow: [{ label: 'UTC', value: 'UTC' }],
    textCount: [{ label: 'A sentence', value: 'The harness finds tools by tag before it uses them.' }],
    diceRoll: [
        { label: 'd6', value: 6 },
        { label: 'd20', value: 20 }
    ],
    noteSearch: [{ label: 'Tool loop', value: 'tool loop' }],
    textSummarize: [
        { label: 'A paragraph', value: 'The harness runs tools until the model answers with text.' }
    ],
    // The server owns the provider key; the playground only needs a valid query. The
    // exact key is never part of this value.
    search: [{ label: 'Tool discovery', value: { query: 'harness tool discovery', maxResults: 5 } }],
    // ---------------------------------------------------------------------------
    // Runtime registry + story tools. Every value below is schema-checked against the
    // tool's own metadata (src/tools/runtime/*.tool.ts), including the enum spellings
    // and the `additionalProperties: false` rule, because a preset the server rejects is
    // worse than no preset. Anything that names a RUNTIME id (a call, a thread, an id
    // minted by an earlier `add`) carries an obviously fake placeholder instead of an
    // invented real-looking id: the reader edits it, and the label says so.
    // ---------------------------------------------------------------------------
    // No properties at all: the button names what the call returns, which is still more
    // useful than the reader guessing that an empty object is the whole request.
    toolList: [{ label: 'Full inventory', value: {} }],
    // `operation` is the one required property, and 'read' is registered in every
    // harness, so the target of these three is a name the playground can resolve.
    toolManage: [
        { label: 'List registered', value: { operation: 'list' } },
        { label: 'Details for read', value: { operation: 'details', name: 'read' } },
        { label: 'Source of read', value: { operation: 'source', name: 'read' } }
    ],
    // All properties are optional, so a name-less install is a valid request: the module
    // text or legacy body declares the wire name itself.
    toolRegistry: [
        {
            label: 'Install shoutText (body)',
            value: {
                name: 'shoutText',
                description: 'Uppercase a short string.',
                tags: ['text', 'upper'],
                source: 'return args.trim().toUpperCase();'
            }
        }
    ],
    toolCancel: [
        {
            // ONE property, so the single-property rule applies: the box holds the id
            // string itself, not a `{callId: …}` wrapper.
            label: 'Cancel a call (edit id)',
            value: '<callId from a running tool call>'
        }
    ],
    // agentManage and threadList take no arguments; both are the discovery step whose
    // answer supplies the ids the id-based presets below need.
    agentManage: [{ label: 'Recent invocations', value: {} }],
    // `agent` must be an agent THIS harness configures, so the runner builds these
    // presets from the playground harness's subagent list (see `presetsFor`).
    agentResult: [],
    threadList: [{ label: 'Thread roster', value: {} }],
    threadSend: [
        {
            label: 'Send to thread (edit id)',
            value: {
                thread: '<thread id from threadList>',
                message: 'Here is the constraint you asked for; please fold it into the current task.'
            }
        }
    ],
    // A fork needs no id: it inherits the current history, so this whole call is valid
    // without any editing.
    threadFork: [
        {
            label: 'Fork an alternate take',
            value: {
                input: 'Try the opposite approach and report what breaks, with the evidence.',
                label: 'Alternate take'
            }
        }
    ],
    // The story tables: `action` is required and each write action needs its own pair of
    // fields, so the add presets carry complete records and the id-based one stays a
    // clearly-marked placeholder.
    profileManage: [
        { label: 'List profiles', value: { action: 'list' } },
        {
            label: 'Add a profile',
            value: {
                action: 'add',
                name: 'Iris',
                description: 'A cautious planner who asks before acting.',
                traits: ['brave', 'loyal']
            }
        },
        { label: 'Get by id (edit id)', value: { action: 'get', id: '<id from add>' } }
    ],
    chapterManage: [
        { label: 'List chapters', value: { action: 'list' } },
        {
            label: 'Add a draft chapter',
            value: {
                action: 'add',
                title: 'The harness finds its tools',
                summary: 'Discovery runs before the first model call.',
                content: 'The registry answers with tags, and the model asks for what it needs.',
                status: 'draft'
            }
        },
        { label: 'Get by id (edit id)', value: { action: 'get', id: '<id from add>' } }
    ],
    locationManage: [
        { label: 'List locations', value: { action: 'list' } },
        {
            label: 'Add a location',
            value: {
                action: 'add',
                name: 'The archive',
                description: 'A quiet room full of superseded plans.',
                notes: 'Nobody throws anything away here.'
            }
        },
        { label: 'Get by id (edit id)', value: { action: 'get', id: '<id from add>' } }
    ],
    // actionRequest's `recommended` MUST match one of the option ids, so the preset ships
    // a self-consistent request rather than three independent fields.
    actionRequest: [
        {
            label: 'Ask which path to take',
            value: {
                question: 'Should the fix change the shared schema or stay local to this tool?',
                recommended: 'local',
                options: [
                    { id: 'shared', label: 'Change the shared schema', description: 'Every caller sees it.' },
                    { id: 'local', label: 'Keep it local', description: 'Only this tool changes.' }
                ]
            }
        }
    ],
    // ---------------------------------------------------------------------------
    // Network and git presets.
    // ---------------------------------------------------------------------------
    // `fetch` declares ONE property, so the single-property rule applies and the box holds
    // the URL itself — an object here would be sent as a literal `{url: …}` value.
    fetch: [{ label: 'Fetch example.com', value: 'https://example.com' }],
    download: [
        {
            label: 'Save a named file',
            value: { url: 'https://example.com/report.html', name: 'report.html' }
        }
    ],
    // gitDiff has NO required property: every one of these is a complete, different call.
    gitDiff: [
        { label: 'Working tree', value: {} },
        { label: 'Against HEAD~1', value: { ref: 'HEAD~1' } },
        { label: 'Staged index', value: { staged: true } },
        { label: 'Only src, against main', value: { ref: 'main', paths: ['src'] } }
    ]
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
    // deterministic (the story tools' `action` and `toolManage.operation` enums;
    // `syntax.language` is free text now, so the
    // curated example is what makes that call valid).
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
// below the minimum), `{"patterns": [], "paths": [], "maxResults": 0}` for glob —
// every glob property is optional now, so the old `content` mode property is not
// even part of that schema any more. Omitting what the schema does not require is
// both valid and the honest reading of "optional": the tool then applies its
// documented default. Only the `required` list is materialized; a schema with no
// `required` at all gets `{}`, which is a valid no-argument call.
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

// The schema-derived preset for a tool with no curated payload. Its LABEL names the
// shape it fills, because the button is the only hint a reader gets before pressing it:
// `Only paths` for the single-property rule, `Required tags` for a required list, and
// `Empty call` when the schema requires nothing.
const schemaPreset = (entry: ToolDescriptor): ToolPreset => {
    const parameters = entry.parameters;
    const single = singleProperty(parameters);
    const required = Array.isArray(parameters?.required)
        ? (parameters.required as unknown[]).filter((key): key is string => typeof key === 'string')
        : [];

    const label =
        single !== undefined
            ? `Only ${single}`
            : required.length === 0
              ? 'Empty call'
              : required.length <= 2
                ? `Required ${required.join(' + ')}`
                : 'Required fields';

    // `templateFor` always returns JSON text, so this parse cannot fail; it exists so
    // the preset list carries VALUES (the box renders them with 2-space formatting).
    return { label, value: JSON.parse(templateFor(parameters)) as unknown };
};

// How many preset buttons one tool may show. Beyond this the argument box would be
// pushed below the fold inside the runner dialog.
const PRESET_LIMIT = 4;

// The preset buttons for one catalogue entry: curated payloads first, then the
// schema-derived fallback — so EVERY listed tool offers at least one named, valid
// starting value, even a tool nobody curated (a runtime tool, or one a harness added).
//
// `playgroundAgents` is the subagent allowlist of the harness the PLAYGROUND picked (R7).
// delegate and agentResult are the two tools whose target must name a configured agent,
// so their presets are built from that list at show time — the selected conversation's
// frozen team is irrelevant here, and a hard-coded agent name would be invalid for most
// harnesses.
const presetsFor = (
    entry: ToolDescriptor,
    playgroundAgents: readonly string[]
): readonly ToolPreset[] => {
    if (entry.name === 'delegate') {
        // Each named target is a self-contained brief: an under-specified delegation is
        // the call the model most often gets wrong, so the preset shows a real one.
        return playgroundAgents.slice(0, PRESET_LIMIT).map((agent) => ({
            label: `Delegate to ${agent}`,
            value: {
                agent,
                input: `Give ${agent} everything it needs: the goal, the files or areas, the constraints, and the evidence you want back.`
            }
        }));
    }

    if (entry.name === 'agentResult') {
        // `agent` must be a configured subagent, so offer one preset per real target and
        // keep the paging shape reachable. With no subagents there is no valid target:
        // the reader gets the clearly-marked placeholder to edit rather than a name this
        // harness does not have.
        const targets: ToolPreset[] = playgroundAgents.slice(0, PRESET_LIMIT - 1).map((agent) => ({
            label: `Read ${agent}`,
            value: { agent }
        }));

        targets.push({
            label: 'Page a result (edit ids)',
            value: { agent: '<agent from agentManage>', offset: 0, limit: 2000 }
        });

        return targets;
    }

    const presets = [...(PRESETS[entry.name] ?? [])];

    // The fallback is deduplicated against a curated preset with the identical value
    // (the common case for a tool that has exactly one curated payload), so a button
    // never repeats itself.
    const fallback = schemaPreset(entry);
    if (!presets.some((preset) => JSON.stringify(preset.value) === JSON.stringify(fallback.value))) {
        presets.push(fallback);
    }

    return presets.slice(0, PRESET_LIMIT);
};

// What the runner needs from the shell for a session-bound core tool (R7).
//
// The runner is the GLOBAL playground's surface: it never reads the selected
// conversation. `context` is read at show time and before every call and reports the
// PLAYGROUND's own temporary context; `ensureSession` creates that temporary session on
// the production harness the playground picked (never the reader's chat);
// `refreshSession` re-reads the temporary session's snapshot after a call so
// toolRequest discoveries and the task list are on screen immediately. None of these live
// in this module: the runner must not own the temporary context, and it must not guess
// a session id.
//
// `delegateTargets` reads the SUBAGENT allowlist of the harness the playground picked.
// delegate is the one core tool whose validity depends on that harness's configuration:
// it is only registered when the harness declares subagents, so the runner must not
// offer a preset naming an agent that harness does not have.
//
// There is NO panel routing any more: a playground call belongs to the temporary
// context, so its declarative panels are shown in the response box (R21.3 panels never
// enter the conversation the reader is looking at).
export type ToolRunnerOptions = {
    context: () => { harness?: string; sessionId?: string };
    ensureSession: () => Promise<string | undefined>;
    refreshSession: (sessionId: string) => Promise<void>;
    delegateTargets?: () => readonly string[];
};

type ToolRunner = {
    pane: HTMLElement;
    show: (entry: ToolDescriptor) => void;
    // Repaint the session-context line (the playground context changed underneath an
    // already-open runner).
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

    // The introduction changes with the entry: a catalogue tool is a bare function
    // call; a core tool runs in the playground's OWN temporary session (R7), so its
    // wording never points at the conversation the reader is looking at.
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

    // R8: the preset buttons. Pressing one FILLS the editable box and sends nothing;
    // the payload the reader sees is the payload that is sent, so a preset is a
    // starting value, never a hidden argument source.
    const presetRow = el('div', 'tool-presets');
    const presetLabel = el('span', 'field-label tool-label', 'Presets');
    const presetButtons = el('div', 'tool-preset-buttons');
    presetRow.append(presetLabel, presetButtons);
    presetRow.hidden = true;

    // R8: the payload section carries its OWN copy control. The wrapper is a `div`,
    // not a `label`: a button inside a `<label>` would forward its activation to the
    // textarea. The accessible name moves to an explicit `aria-label` on the field.
    const argsField = el('div', 'field tool-section');
    const argsHeading = el('div', 'tool-heading');
    const argsLabel = el('span', 'field-label tool-label', 'Payload (JSON)');
    argsHeading.append(
        argsLabel,
        createTextCopyButton({
            label: 'Copy payload',
            // Click-time provider: whatever the reader has typed is what lands on the
            // clipboard, verbatim — not a re-serialized or prettified version.
            text: () => args.value,
            className: 'tool-copy'
        })
    );
    const args = el('textarea', 'composer-input tool-args');
    args.rows = 5;
    args.spellcheck = false;
    args.setAttribute('aria-label', 'Tool arguments as JSON');
    argsField.append(argsHeading, args);

    const rule = el('p', 'field-hint', '');

    const callButton = el('button', 'button primary', 'Call tool');
    callButton.type = 'button';
    const actions = el('div', 'composer-actions');
    actions.append(callButton);

    // R8: the response section, with its own copy control beside its own label. The
    // dialog header has NO copy button any more (see `openToolDialog`): a whole-dialog
    // copy would have to guess which of these two panes the reader meant.
    const output = el('div', 'card tool-output tool-section');
    const outputHead = el('div', 'card-head tool-heading');
    const outputLabelNode = el('span', 'card-label tool-label', 'response');
    outputHead.append(
        outputLabelNode,
        createTextCopyButton({
            label: 'Copy response',
            // The raw text behind the highlighted view, resolved at click time so a
            // call that settles while the dialog is open copies the settled answer.
            text: () => responseText,
            className: 'tool-copy'
        })
    );
    const outputBody = el('pre', 'card-body', '');
    output.append(outputHead, outputBody);

    // The raw text behind the rendered response box. Copy uses this instead of the
    // highlighted DOM so no syntax spans, truncation or decoration leak into the
    // clipboard; it is updated by every `setResponse`, including errors and prompts.
    let responseText = '';
    let responseLabel = 'response';

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
        presetRow,
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

    // Direct-call responses get the same treatment as tool results inside a turn:
    // pretty-printed JSON when it parses, escaped+highlighted otherwise. The
    // markup comes from `highlightCode`, which escapes its input, so assigning it
    // to `innerHTML` cannot execute anything.
    const setResponse = (text: string, isError: boolean): void => {
        responseText = text;
        responseLabel = isError ? 'error' : 'response';
        outputLabelNode.textContent = responseLabel;
        output.className = isError
            ? 'card tool-output tool-section is-error'
            : 'card tool-output tool-section';
        outputBody.innerHTML = highlightCode(prettyJson(text), looksLikeJson(text) ? 'json' : undefined);
        outputBody.dataset.language = looksLikeJson(text) ? 'json' : 'text';
    };

    // One writer for every failure the runner can produce (R8). The box is a JSON view,
    // so a failure is written AS JSON: the reader (and anything parsing the box) gets a
    // machine-readable `ok: false` envelope with the server's or the parser's own
    // message, instead of a prose sentence that would make the box lie about its
    // format. The payload textarea is never touched here — an invalid draft stays
    // exactly as typed so it can be corrected and re-sent.
    const setFailure = (kind: string, message: string, extra?: Record<string, unknown>): void => {
        const error: Record<string, unknown> = { kind, message, ...extra };
        setResponse(JSON.stringify({ ok: false, error }, null, 2), true);
    };

    // The preset buttons for the entry being shown (R8). `fill` writes the FIRST
    // preset into the textarea, which is what makes the box start with a valid call
    // without ever locking the reader into it.
    const paintPresets = (entry: ToolDescriptor, fill: boolean): void => {
        const presets = presetsFor(entry, [...(options.delegateTargets?.() ?? [])]);

        presetButtons.replaceChildren();
        presetRow.hidden = presets.length === 0;

        presets.forEach((preset, index) => {
            // Owns its chip styling (no shared `.button` classes, for the same reason
            // as `.harness-delete`: the generic `.button` rule sits later in the sheet).
            const button = el('button', 'tool-preset');
            button.type = 'button';
            button.textContent = preset.label;
            button.dataset.preset = preset.label;
            // Which payload the box currently holds. The first preset is the one the
            // runner filled, so the pressed state starts on it; a hand-edited box is
            // re-filled by pressing the button again.
            button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
            // A preset is still a CALL waiting to happen, so an entry the server says it
            // cannot run offers none.
            button.disabled = entry.availability?.state === 'unconfigured';
            button.title = `Fill the arguments with ${preset.label}. Nothing runs until “Call tool”.`;

            button.addEventListener('click', () => {
                // R8: filling the box is the whole action. The text stays fully
                // editable, so "Call tool" sends exactly this JSON plus any edit the
                // reader makes on top of it.
                args.value = JSON.stringify(preset.value, null, 2);

                for (const other of presetButtons.children) {
                    (other as HTMLButtonElement).setAttribute('aria-pressed', 'false');
                }
                button.setAttribute('aria-pressed', 'true');
            });

            presetButtons.append(button);
        });

        if (fill && presets.length > 0) args.value = JSON.stringify(presets[0].value, null, 2);
    };

    // Delegation is the one core tool whose VALIDITY depends on the harness the
    // playground picked: the server registers delegate only when that harness declares
    // subagents, so a hard-coded target (the old 'summarizer' one) named an agent most
    // harnesses do not have.
    //
    // `delegateKey` is the target list last painted (undefined = nothing painted yet),
    // so an ordinary `sync()` (called before every call and after every context change)
    // only rewrites the presets when the TEAM changed — never over something the reader
    // typed.
    //
    // Returns true when the playground harness offers no target, which the caller must
    // treat as "not callable here" (the server would answer 404).
    let delegateKey: string | undefined;

    const paintDelegate = (entry: ToolDescriptor): boolean => {
        if (entry.name !== 'delegate') {
            delegateKey = undefined;
            return false;
        }

        const targets = [...(options.delegateTargets?.() ?? [])];
        const key = targets.join(',');
        const noTargets = targets.length === 0;

        if (key !== delegateKey) {
            delegateKey = key;
            paintPresets(entry, !noTargets);
            if (noTargets) args.value = '{}';
        }

        note.textContent = noTargets
            ? 'Core tool — the playground harness declares no subagents, so delegation is not available in its session. Add an agent to that team to enable one-level delegation.'
            : `Core tool — it runs in the playground’s temporary session and hands ONE subagent a self-contained brief. Targets for the playground harness: ${targets.join(', ')}. Subagents cannot delegate further.`;

        return noTargets;
    };

    // Context line (R7). Read live so a temporary session created after the runner
    // opened is shown instead of "none yet", and so it always names the context the
    // call will actually use — never the conversation the reader selected.
    const sync = (): void => {
        // The playground harness can change underneath an open runner (a harness was
        // deleted, or the roster reloaded): repaint the delegate presets/availability
        // so the pane never names an agent that harness no longer has.
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
                'Session-bound: this server reports no harness, so there is no context to run a core tool in. Create a harness first.';
            return;
        }

        sessionNote.textContent =
            context.sessionId === undefined
                ? `Session-bound: runs in the playground’s own temporary session for ${context.harness}. None yet — Call creates one, and leaving the tools view deletes it.`
                : `Session-bound: runs in the playground’s own temporary session for ${context.harness} · session ${context.sessionId}. The conversation you selected is untouched.`;
    };

    callButton.addEventListener('click', async () => {
        // The button is disabled for an unconfigured entry; this guard keeps a
        // programmatic click (or a stale handler) from asking a server that has
        // already answered "no credential".
        const entry = active;
        if (entry === undefined || entry.availability?.state === 'unconfigured') return;

        // Delegation with no configured target is not a call the server can serve
        // (it answers 404 because delegate is not registered at all). Disabled
        // button plus this guard keeps the pane honest.
        if (paintDelegate(entry)) return;

        // R8: the box IS the request. It is parsed (and only parsed) here, so a preset
        // is never sent as an object and an edit is never lost. A parse failure is
        // reported as a structured response and leaves the draft untouched, which is
        // what makes it correctable.
        let parameters: unknown;
        try {
            parameters = args.value.trim().length === 0 ? {} : JSON.parse(args.value);
        } catch (error) {
            setFailure('invalid_json', `Arguments are not valid JSON: ${messageOf(error)}`);
            return;
        }

        callButton.disabled = true;
        setResponse('Calling…', false);
        resultHint.hidden = true;

        try {
            // Capture the temporary session id BEFORE any await. If the playground
            // context changes while the call is in flight, the request still runs in
            // the session the runner displayed — never in whatever exists when the
            // response lands.
            let sessionId: string | undefined;
            if (entry.sessionBound === true) {
                sessionId = options.context().sessionId;

                if (sessionId === undefined) {
                    // A core call needs a real server session (the tool mutates
                    // discovery/tasks/runtime tools). The playground creates its OWN
                    // (R7): never the reader's conversation, and never an id this view
                    // invents.
                    setResponse('Creating the playground session…', false);
                    try {
                        sessionId = await options.ensureSession();
                    } catch (error) {
                        setFailure('session_create_failed', `Could not create a session: ${messageOf(error)}`);
                        return;
                    }

                    if (sessionId === undefined) {
                        // Two honest reasons, and the pane says which one it is: this
                        // server has no harness to run in, or the tools view was closed
                        // while the create was in flight (that answer is discarded).
                        const harness = options.context().harness;

                        if (harness === undefined) {
                            setFailure(
                                'no_harness',
                                'This server reports no harness, so this core tool has no session to run in. Create a harness in the sidebar, then call again.'
                            );
                        } else {
                            setFailure(
                                'playground_closed',
                                `The tools view was closed while the temporary session for ${harness} was being created, so it was discarded and this call did not run.`
                            );
                        }
                        return;
                    }
                }

                sync();
            }

            const response = await callTool(entry.name, parameters, sessionId);

            if (!response.ok) {
                // A tool-level failure is still a JSON answer: the server's own error
                // envelope is rendered verbatim instead of being flattened into a
                // sentence, so the response box keeps one format for every outcome.
                setResponse(JSON.stringify(response, null, 2), true);
                return;
            }

            // R8: the response box shows the response — the server's whole answer
            // envelope (result, duration, and any declarative panels). A playground
            // call's panels are data in THIS pane, not something injected into the
            // conversation the reader is looking at.
            setResponse(JSON.stringify(response, null, 2), false);
            outputLabelNode.textContent = `response · ${response.durationMs}ms`;

            // toolRequest caps its answer (5 tools). The raw payload stays; the
            // hint names the remaining count and the next move.
            const hint = resultHintFor(entry.name, response.result);
            resultHint.hidden = hint === undefined;
            resultHint.textContent = hint ?? '';

            // Core calls mutate the session (enabled tools, created tools, tasks),
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

            // R7: there is NO panel routing here any more. A playground call produced
            // its panels inside the temporary session it owns, so they are shown as
            // part of the response envelope above and never injected into the
            // conversation the reader happens to be looking at.
        } catch (error) {
            // Request-level failures (no session 400, unknown session 404, active
            // run 409, offline) arrive here with the server's own message, written as
            // the same structured envelope the success path uses.
            setFailure('request_failed', messageOf(error));
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
                ? 'Core tool — it runs in the playground’s own temporary session (a harness session this view created for tool testing, deleted when the tools view closes), so its result never changes the conversation you are reading.'
                : 'Direct call — no harness, no agent, no tool loop. This is the same implementation a session registers, invoked as a function.';

            schemaBody.textContent = JSON.stringify(entry.parameters, null, 2);

            // R8: the preset buttons are painted first and the first one fills the box,
            // so the runner always starts from a named, schema-valid payload (curated
            // example when one exists, schema-derived otherwise) that the reader can
            // edit freely.
            paintPresets(entry, true);

            // delegate's presets depend on the PLAYGROUND harness's team; every other
            // entry (including the server-wide catalogue listing) is team-independent.
            // Reset the painted-targets key so a re-show always repaints from the
            // current roster rather than keeping the previous fill.
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
                      ? 'Not available for the playground harness: it declares no subagents, so delegate is not registered in its session.'
                      : '';
            availabilityNote.hidden = !unavailable && !noDelegateTargets;

            const blocked = unavailable || noDelegateTargets;
            callButton.disabled = blocked;
            args.disabled = blocked;

            setResponse(
                // The full hint is already rendered above the schema; repeating a
                // paragraph in the response box would just be noise.
                unavailable
                    ? 'Not configured on this server.'
                    : noDelegateTargets
                      ? 'Delegation is unavailable for the playground harness.'
                      : 'Nothing yet. Press “Call tool”.',
                blocked
            );
            outputLabelNode.textContent = unavailable
                ? 'unconfigured'
                : noDelegateTargets
                  ? 'unavailable'
                  : 'response';
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

// R4 (T4): the status pill is ALSO the entry point to the endpoint/model settings.
// The pill itself is untouched — it stays the `<span class="status" role="status">`
// live region every status assertion reads — and a bare wrapper BUTTON around it
// carries the click, `aria-haspopup="dialog"` and the accessible name. A live region
// cannot be a button (and a button cannot be `role="status"`), so the two semantics
// live on nested elements instead of fighting over one.
const statusButton = el('button', 'status-button');
statusButton.type = 'button';
statusButton.setAttribute('aria-haspopup', 'dialog');
statusButton.setAttribute('aria-label', 'Endpoint and model settings');
statusButton.title = 'Endpoint and model settings';
statusButton.append(statusPill);

// The right cluster keeps the live status pill and the Tools toggle together at the
// top-right on every width. There is NO rail control in the topbar or on the harness
// title row any more (T3/R1+R3): the harness listing is opened by the "Harness UI"
// brand button and the scratch board by the floating `.scratch-fab` below.
const topbarRight = el('div', 'topbar-right');
topbarRight.append(statusButton, toolsToggle);

const railIcon = (glyph: string): HTMLSpanElement => {
    const icon = el('span', 'rail-toggle-icon', glyph);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
};

// R3 (T3): the phone trigger for the RIGHT rail is a floating action button, not a
// header toggle. The right rail is only the scratch board now (sessions moved under the
// Instruct header), so the header row has nothing left to disclose, and a fixed button
// above the composer stays reachable while the transcript scrolls.
//
// It is ICON-ONLY like the control it replaces: the glyph is decorative
// (`aria-hidden`), the accessible name is the `aria-label`, and `aria-expanded` is
// painted by `setRailOpen` so the disclosure state is real for assistive tech. CSS
// hides the button entirely above 860px (`.scratch-fab { display: none; }`), where the
// rail is permanently visible and the control would be a no-op.
//
// T8: the rail keeps the id `rail-right` (and `aria-controls` points at it) because the
// name describes the CONTENT — the scratch board — not the edge it opens from. On a phone
// that drawer now slides in from the left, in the harness drawer's slot, and the button is
// stacked above the backdrop so it can switch drawers with one press.
const scratchFab = el('button', 'scratch-fab');
scratchFab.type = 'button';
scratchFab.id = 'scratch-fab';
scratchFab.setAttribute('aria-controls', 'rail-right');
scratchFab.setAttribute('aria-expanded', 'false');
scratchFab.setAttribute('aria-label', 'Open scratch board');
scratchFab.title = 'Open scratch board';
scratchFab.append(railIcon('▤'));

topbar.append(brand, topbarRight);

const shell = el('div', 'shell');

// --- left rail: harnesses ---------------------------------------------------
const leftRail = el('aside', 'rail rail-left');
// The id is what `aria-controls` on the mobile toggle points at; the rail stays in
// the DOM at every width (only CSS collapses it on a phone).
leftRail.id = 'rail-left';
leftRail.setAttribute('aria-label', 'Harnesses');
const harnessHead = el('div', 'rail-head');
// R4: the "Harnesses" title IS the drawer toggle. It opens and closes the SAME left
// sidebar as the "Harness UI" brand, so the small-screen `×` control is gone: one
// labelled heading does the job the glyph did, and the drawer no longer needs a
// second, easily-missed target. The `<h2>` stays (the rail keeps its accessible
// section heading and the existing `.rail-title` styling); the BUTTON inside it is the
// control, so the heading's textContent is still exactly "Harnesses".
const harnessHeading = el('h2', 'rail-title');
const harnessTitleToggle = el('button', 'rail-title-toggle', 'Harnesses');
harnessTitleToggle.type = 'button';
harnessHeading.append(harnessTitleToggle);
const createHarnessButton = el('button', 'button small new-harness', '+ New');
createHarnessButton.type = 'button';
createHarnessButton.disabled = true;
createHarnessButton.setAttribute('aria-expanded', 'false');
const harnessHeadActions = el('div', 'rail-head-actions');
harnessHeadActions.append(createHarnessButton);
harnessHead.append(harnessHeading, harnessHeadActions);

const harnessList = el('div', 'harness-list');

// R4 (T4): the endpoint/model settings are no longer a rail disclosure. `endpointBody`
// is the PERSISTENT settings root: it owns the inputs, the model dropdown, the status
// line and every listener, and the dialog created by `openEndpointDialog` ADOPTS it
// (DOM adoption, not a clone) each time the status pill is pressed. Closing the dialog
// removes only the overlay — the fields, their values and the `controls` map survive,
// so `applyDefaults()`/`renderModelOptions()`/`refreshModels()` keep painting the same
// nodes whether the dialog is open or not.
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

// Initial paint: the stored model is a valid selection even before the server
// answers, so the dropdown must show it rather than an empty control.
renderModelOptions();

// ---------------------------------------------------------------------------
// Endpoint & model dialog (R4 / T4)
// ---------------------------------------------------------------------------
//
// The settings leave the rail entirely: the ONLY way in is the top-right status pill.
// The dialog is opened on demand and the persistent `endpointBody` is adopted into a
// fresh `.endpoint-dialog` wrapper each time — the same move-a-live-pane pattern the
// tool runner uses (`openToolDialog`, `ui/dialog.ts` adopts `content` instead of
// cloning it). Nothing here rebuilds a field, so a value typed while open is still
// there after close/reopen and the debounced refresh keeps running while closed.
//
// `endpointDialog` is guarded by identity in `onClose` (a replacement open may already
// own the variable when a queued close callback runs), and the pill is the trigger so
// `returnFocus` lands back on the control the reader pressed, never the composer.
let endpointDialog: DialogHandle | undefined;

const closeEndpointDialog = (): void => {
    endpointDialog?.close();
};

const openEndpointDialog = (trigger: HTMLElement): void => {
    const body = el('div', 'endpoint-dialog');
    body.append(endpointBody);

    let handle: DialogHandle | undefined;
    handle = openDialog({
        // The dialog title replaces the old `<summary>` label, so the wording is
        // identical and there is no second heading inside the body.
        title: 'Endpoint & model',
        content: body,
        returnFocus: trigger,
        onClose: () => {
            if (endpointDialog !== handle) return;
            endpointDialog = undefined;
        }
    });

    endpointDialog = handle;
};

// Second press closes instead of stacking (a dialog on top of the pill is a popup the
// reader cannot dismiss with the same gesture that opened it). The `showingTools` guard
// matches `headTitleButton`: while the tools catalogue owns the centre, the top-right
// pill is still the APP status pill, and pressing it must not fight that view.
statusButton.addEventListener('click', () => {
    if (showingTools) return;
    if (endpointDialog !== undefined) {
        closeEndpointDialog();
        return;
    }
    openEndpointDialog(statusButton);
});

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

// T7 (user feedback, phone): "Lower screen … needed to highlight which session is being
// viewed, but I want a pill next to the instruct button … clicking it will rotate through
// the session available. There is no need for delete button in this mode."
//
// Under 861px the header strip is `display:none` (`.session-pills-bar-head`, styles.css)
// and the directory moves INSIDE the Instruct dialog, so a phone reader sees no answer to
// "which conversation am I looking at?". This pill answers it in ~70px and steps to the
// next conversation on press; deleting stays in the dialog's full dashboard.
//
// It is a SIBLING of the `h1` itself (`.main-title`), inserted between the title and the
// `.harness-id` line, so it sits immediately to the RIGHT of `.harness-title-button` in the
// row — and it is never nested inside that button: the title already opens the details
// dialog, and interactive content may not live inside a <button>, or one press could mean
// two different things.
const sessionCycle = el('button', 'session-cycle');
sessionCycle.type = 'button';
// `paintSessionCycle()` owns this: with no conversation open the pill has nothing to name.
// (styles.css `[hidden] { display: none !important }` makes it authoritative over the
// phone block's `display: inline-flex`, so no extra visibility rule is needed here.)
sessionCycle.hidden = true;
// The only VISIBLE text is the eight-character prefix (the same rule the strip follows);
// the full uuid stays in the tooltip.
const sessionCycleId = el('span', 'session-cycle-id', '');
// The rotation glyph is the wordless "this cycles" cue. Decoration, so it stays out of the
// accessible name the button carries.
const sessionCycleGlyph = el('span', 'session-cycle-glyph', '\u21c4');
sessionCycleGlyph.setAttribute('aria-hidden', 'true');
sessionCycle.append(sessionCycleId, sessionCycleGlyph);

// Cycling walks the SAME projection the strip paints (`sessionDirectory`), so "next" is
// always the next conversation the reader would find in the dashboard.
//   - last entry → wraps to the first;
//   - an active id that is not in the list (`index` -1 — the conversation was deleted in
//     another tab and the directory re-read, or nothing is open at all) → starts at the
//     FIRST entry rather than wrapping past the end;
//   - an empty list → no-op, because there is nothing to open.
//
// There is deliberately no separate "nothing is open" branch: in that state
// `paintSessionCycle` has already written `hidden`, and the stylesheet's global
// `[hidden] { display: none !important }` rule takes the control out of the layout, the tab
// order and the pointer, so this handler only ever runs on a pill the reader can see. (jsdom
// still dispatches a click on a hidden node, which is why session-cycle.test.ts pins what
// such a press does: the first conversation, never a stale pointer.)
//
// `openSession` is a module-level `const` declared far below; the arrow defers the read to
// click time (the same temporal-dead-zone discipline `createSessionPillBar` uses for
// `newSession`). No delete affordance and no delete handler live here.
sessionCycle.addEventListener('click', () => {
    const list = sessionDirectory().map((entry) => entry.session);
    if (list.length === 0) return;

    const index = list.findIndex((session) => session.id === current?.sessionId);
    const next = list[(index + 1) % list.length] ?? list[0];
    if (next === undefined) return;

    // Switching is a view change (R4), never a cancellation, and it repaints through
    // `renderSessions()` → `paintSessionCycle()`.
    void openSession(next.id);
});

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

// ---------------------------------------------------------------------------
// Session pill bar (T3/R1)
// ---------------------------------------------------------------------------
//
// R1 moved the session directory OUT of the right rail and into a compact pill strip
// under the Instruct header, and R2 mirrors that strip inside the harness details
// dialog on a phone (where the header strip is hidden by CSS). BOTH copies are built by
// the factory below, so a pill can never behave differently depending on where it is
// rendered, and `renderSessions()` stays the single painter for every live copy.
//
// A bar is registered while it is in the page and dropped when its root is disconnected
// (a closed dialog adopts its body, then removes it), so the painter never touches a
// detached node.
type SessionPillBar = {
    element: HTMLElement;
    list: HTMLElement;
    newButton: HTMLButtonElement;
    refreshButton: HTMLButtonElement;
};

const sessionBars = new Set<SessionPillBar>();

// The dialog's bar, kept explicitly so `onClose` can unregister it the moment the layer
// is gone (the `isConnected` prune below is the safety net, not the mechanism).
let dialogSessionBar: SessionPillBar | undefined;

// Every bar whose DOM is still in the document. Painting only these keeps a closed
// dialog's detached strip out of the render loop.
const liveSessionBars = (): SessionPillBar[] => [...sessionBars].filter((bar) => bar.element.isConnected);

// Build one strip. `variant` only selects the CSS hook
// (`.session-pills-bar-head` / `.session-pills-bar-dialog`); the behaviour and the
// markup are identical, which is what makes the phone dialog a full replacement for the
// hidden header strip.
const createSessionPillBar = (variant: 'head' | 'dialog'): SessionPillBar => {
    const element = el('div', `session-pills-bar session-pills-bar-${variant}`);
    const list = el('div', 'session-pills');
    list.setAttribute('role', 'list');

    // R1: New session keeps the historical `.new-session` class (the existing selectors
    // and the busy/disabled contract in `paintSessionActions` are unchanged) and is
    // labelled exactly like the control it replaces.
    const newButton = el('button', 'button small new-session', '+ New');
    newButton.type = 'button';
    newButton.disabled = true;
    newButton.title = 'New session';
    newButton.setAttribute('aria-label', 'New session');
    // The listener is wrapped (not passed by reference) because `newSession` is a
    // module-level `const` declared far below: reading the binding during this factory's
    // first call — which happens at module init, while the header strip is built — would
    // hit the temporal-dead-zone error. The arrow defers the read to click time.
    newButton.addEventListener('click', () => newSession());

    // R1: the refresh action keeps its own class so a caller can reach it without a
    // positional selector (`.sessions-actions button:nth-of-type(2)` is gone with the
    // rail markup).
    const refreshButton = el('button', 'button small refresh-sessions', '↻');
    refreshButton.type = 'button';
    refreshButton.disabled = true;
    refreshButton.title = 'Refresh sessions';
    refreshButton.setAttribute('aria-label', 'Refresh sessions');
    refreshButton.addEventListener('click', () => {
        void refreshSessions();
    });

    element.append(list, newButton, refreshButton);

    const bar: SessionPillBar = { element, list, newButton, refreshButton };
    sessionBars.add(bar);

    return bar;
};

// Aggregate totals for the selected harness, across EVERY session the dialog lists.
//
// The row is built from `sessionDirectory()` — the exact list the session chips come
// from (main.ts:5713) — so a figure can never disagree with the strip above it. Four
// totals (thread count, total input tokens, total completed time, total cached input),
// never per-thread values. A figure the data does not report produces NO span (see
// ui/usage-summary.ts), because "not reported" is a different fact from zero.
//
// The `' | '` between figures is CSS decoration (`.harness-details-stat + ...`), not a
// text node, so each span stays a clean, copy-pastable value — the same discipline as
// the turn header's measurement line (`.tile-elapsed + .tile-tokens::before` in
// styles.css).
//
// Cross-references:
//   - src/frontend/ui/usage-summary.ts — the derivation (threads/unknown rules)
//   - src/frontend/ui/tokens.ts        — formatTokens, the grouped token figures
//   - src/frontend/ui/time.ts          — formatDuration, the elapsed figure
const harnessStatFigures = (summary: SessionUsageSummary): HTMLElement[] => {
    // One labelled figure. Every value here is a TOTAL over the whole session set, and
    // `input`/`cache` are not self-explanatory, so the scope and the unit ride on the
    // node as a tooltip rather than as visible clutter.
    const figure = (text: string, title: string): HTMLElement => {
        const span = el('span', 'harness-details-stat', text);
        span.title = title;
        return span;
    };

    // A thread count is always derivable from the roster and the turn ids, so it is the
    // one figure that never disappears: `0 threads` is a real answer, not a gap.
    const figures: HTMLElement[] = [
        figure(
            `${summary.threads} thread${summary.threads === 1 ? '' : 's'}`,
            'Threads across all sessions of this harness'
        )
    ];

    if (summary.input !== undefined) {
        figures.push(
            figure(`${formatTokens(summary.input)} input`, 'Prompt tokens across all sessions of this harness')
        );
    }

    if (summary.durationMs !== undefined) {
        // `1m30s` already carries its own unit, so the label is the tooltip only. The
        // empty-string guard covers the formatter's own "nothing honest to show" case.
        const time = formatDuration(summary.durationMs);
        if (time.length > 0) {
            figures.push(figure(time, 'Summed completed run time across all sessions of this harness'));
        }
    }

    if (summary.cached !== undefined) {
        figures.push(
            figure(
                `${formatTokens(summary.cached)} cache`,
                'Input tokens served from the provider prefix cache'
            )
        );
    }

    return figures;
};

// The totals for the conversation set the dialog is describing, from the one directory
// projection (`sessionDirectory()`), so the pills and the figures are the same set.
const harnessDialogSummary = (): SessionUsageSummary =>
    summarizeSessionUsage(sessionDirectory().map((entry) => entry.session));

// The live `<p>` inside an OPEN dialog, kept so a repaint can touch ONLY these figures.
// `renderSessions()` is the single painter every snapshot already flows through
// (`applySnapshot`/`upsertSession`), and replacing the children of one `<p>` cannot move
// focus or scroll — unlike `refreshHarnessDialog`, which rebuilds the whole body and
// would reset the reader's place on every streamed usage event.
let dialogStats: HTMLElement | undefined;

const paintHarnessDialogStats = (): void => {
    const row = dialogStats;
    if (row === undefined) return;

    // Closing takes the adopted body (and this row) out of the document, so the painter
    // drops the dead node instead of painting into it.
    if (!row.isConnected) {
        dialogStats = undefined;
        return;
    }

    const summary = harnessDialogSummary();

    // Every conversation was deleted while the dialog stayed open: the row goes quiet
    // (the global `[hidden]` rule, styles.css:75) rather than printing an empty shell.
    // The node stays, so a session that arrives later still repopulates it.
    if (summary.sessions === 0) {
        row.hidden = true;
        row.replaceChildren();
        return;
    }

    row.hidden = false;
    row.replaceChildren(...harnessStatFigures(summary));
};

// The dialog's body, built from the CURRENT breakpoint. R2 (T3): on a phone the header
// strip is `display:none`, so the dialog carries the directory instead — it goes FIRST,
// because choosing a conversation is the action a phone reader came for — and it is the
// same factory, so New/Refresh/pills work exactly as they do in the header.
//
// T6: extracting this is what makes the body RECOMPUTABLE. `isPhoneLayout()` can only be
// sampled while the body is being built, so an open dialog would otherwise keep the shape
// of the width it was opened in: desktop → ≤860px would leave it with NO Sessions section
// while the header strip is hidden (sessions unreachable), and the reverse would duplicate
// the directory. `refreshHarnessDialog` re-runs this factory on the media change.
const harnessDetailsBody = (display: HarnessDescriptor): HTMLElement => {
    // The strip this call replaces leaves the document with the old body, so the painter's
    // work list drops it first: `renderSessions()` paints registered bars.
    if (dialogSessionBar !== undefined) {
        sessionBars.delete(dialogSessionBar);
        dialogSessionBar = undefined;
    }

    // The stats row is rebuilt together with the body, so the live reference goes with
    // the old node; `paintHarnessDialogStats` re-arms on the way out.
    dialogStats = undefined;

    const body = el('div', 'harness-details');

    if (isPhoneLayout()) {
        dialogSessionBar = createSessionPillBar('dialog');
        body.append(el('h3', 'harness-details-section', 'Sessions'), dialogSessionBar.element);
    }

    if (display.description.length > 0) {
        body.append(el('p', 'harness-details-description', display.description));
    }

    // OUTSIDE the phone branch on purpose: the totals are desktop content too. Omitted
    // ENTIRELY when the harness has no conversations — nothing to total, and a row of
    // zeros would read as reported numbers.
    const summary = harnessDialogSummary();
    if (summary.sessions > 0) {
        const stats = el('p', 'harness-details-stats');
        stats.replaceChildren(...harnessStatFigures(summary));
        dialogStats = stats;
        body.append(stats);
    }

    body.append(el('p', 'harness-details-meta', harnessMeta(display)));
    // The header's own note is hidden on a phone (styles.css), so the dialog repeats
    // it here: the "edits apply to new sessions" context. A locked saved session has no
    // note any more (T3/R1 removed the frozen-session wording), and the empty check
    // below keeps that out of the dialog.
    if (headNote.textContent.length > 0) {
        body.append(el('p', 'harness-details-note', headNote.textContent));
    }

    return body;
};

// T6: re-shape an OPEN harness dialog for the width we are in now. This REBUILDS rather
// than closes: `handle.update({ content })` swaps the body inside the same layer, so the
// title, the focus trap, the Copy wiring, `returnFocus` and the reader's scroll context all
// survive, and `onClose` still unregisters whatever strip is current when the layer goes
// away. The invariant it protects: after crossing the breakpoint, sessions are reachable.
const refreshHarnessDialog = (): void => {
    const handle = harnessDialog;
    const instance = current;
    if (handle === undefined || !handle.isOpen || instance === undefined) return;

    handle.update({ content: harnessDetailsBody(instance.frozen ?? instance.descriptor) });
    // The phone variant just created a NEW strip; `renderSessions()` skips registered-but-
    // disconnected bars, so the pills have to be painted now that the dialog adopted it.
    renderSessions();
};

// Open the details dialog for the harness that is selected RIGHT NOW. Content is the
// selected display descriptor's description plus the same metadata the rail rows
// show (`harnessMeta`); nothing else is invented (R2: existing metadata only).
const openHarnessDetails = (trigger: HTMLElement): void => {
    const instance = current;
    if (instance === undefined) return;

    const display = instance.frozen ?? instance.descriptor;
    const body = harnessDetailsBody(display);

    let handle: DialogHandle | undefined;
    handle = openDialog({
        title: display.title,
        content: body,
        returnFocus: trigger,
        onClose: () => {
            // The adopted body (and its pill bar) leaves the document with the overlay,
            // so `renderSessions()` must stop painting it. Done unconditionally: this bar
            // belongs to THIS layer even when a replacement open already owns
            // `harnessDialog`.
            if (dialogSessionBar !== undefined) {
                sessionBars.delete(dialogSessionBar);
                dialogSessionBar = undefined;
            }

            // Identity check: a replacement open may already own the variable.
            if (harnessDialog !== handle) return;
            harnessDialog = undefined;
        }
    });

    harnessDialog = handle;

    // R2 (T3): the strip only joins the document when the dialog adopts this body, so the
    // first paint of the dialog's pills has to happen HERE — `renderSessions()` skips
    // disconnected bars, and before `openDialog` the new strip is still off-document.
    renderSessions();
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

// R1 (T3): the header's only children are the title line and the note; the rail
// disclosure is gone from this row (`.scratch-fab` owns it now), and the session
// directory sits between them as a pill strip.
//
// T7: the title row is `title`, the phone session cycler, then the id/group line. The
// cycler is `display: none` above the phone breakpoint, so desktop's row is unchanged.
titleRow.append(headTitle, sessionCycle, headName);
const headSessionBar = createSessionPillBar('head');
mainHead.append(titleRow, headSessionBar.element, headNote);

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
//   - Keyboard (R1 + T1): a fine pointer sends on Enter and inserts a newline on
//     Shift+Enter; a coarse or undetectable pointer keeps Enter as a newline and sends
//     through the button or Ctrl/Cmd+Enter. See the `keydown` listener below
//     the submit wiring for the full matrix (including @/# popup navigation and the
//     chip × button's own Enter).
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
// submit (Enter on a hardware keyboard, Ctrl/Cmd+Enter everywhere) and its Enter
// newline on a touch keyboard.
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

    // R3 (T3): the field's growth is what changes the composer's outer height, so the
    // floating scratch button re-anchors in the same pass.
    syncComposerHeight();
};

// R3 (T3): publishes the composer's live height as `--composer-height` on the root, which
// is what keeps `.scratch-fab` (`bottom: calc(var(--composer-height, 76px) + 12px)`)
// floating just above the input box instead of sitting on top of it. The composer grows
// with the draft (up to the line cap), so a static offset would either overlap the field
// or float too high as soon as the reader types a few lines.
//
// T6: a HIDDEN composer is a different case from an unmeasured one. The tools view sets
// `composer.hidden`, and then there is no input box for the button to clear at all, so the
// answer is 0 — publishing the last chat-view height instead left the button floating in
// the space where the field used to be, over an empty stage.
//
// A VISIBLE composer that measures 0 (jsdom has no layout engine, or the node is detached)
// is the unmeasured case: the property stays UNSET so the stylesheet's `76px` fallback
// keeps the button in a sane place instead of pinning it to the viewport bottom edge.
const syncComposerHeight = (): void => {
    if (composer.hidden) {
        document.documentElement.style.setProperty('--composer-height', '0px');
        return;
    }

    const height = Math.ceil(composer.getBoundingClientRect().height);
    if (height <= 0) {
        // T6: the property is REMOVED rather than left alone, because "alone" may be the
        // `0px` the tools view published. Only a HIDDEN composer may say 0, so a visible
        // composer that cannot be measured must give the value back and let the stylesheet
        // fallback rule again — otherwise the button would stay pinned to the viewport's
        // bottom edge for as long as this host reports no layout.
        document.documentElement.style.removeProperty('--composer-height');
        return;
    }

    document.documentElement.style.setProperty('--composer-height', `${height}px`);
};

// A layout-driven change (a resize, the on-screen keyboard opening, the tools view
// hiding the composer) never runs `autoGrow`, so the observer is what keeps the variable
// honest. `ResizeObserver` is optional: an engine without it still gets the keystroke and
// resize paths, and jsdom (the test environment) has no layout to observe anyway.
if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncComposerHeight()).observe(composer);
}

// T6: the visibility half of that contract. `composer.hidden` is flipped by five different
// paths (the tools toggle in both directions, the tool dialog, harness selection and the
// empty-roster fallback), and a hidden element reports no ResizeObserver box in a host
// without layout, so the attribute itself is the observable. Watching it means the anchor
// can never lag behind the composer's presence — in either direction, and including a
// toggle added later — and it is the same mechanism the attachment-chip observer below
// already uses. `MutationObserver` is optional for the same reason as above.
if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => syncComposerHeight()).observe(composer, {
        attributes: true,
        attributeFilter: ['hidden']
    });
}

// First paint: the composer's height is only knowable once it is laid out, so this is
// deferred one frame. Guarded because neither timer API is guaranteed in every host
// (the module also runs under vitest's jsdom, where it is simply a 0-height no-op).
if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => syncComposerHeight());
}

// --- @ / # popup -------------------------------------------------------------
//
// One popup, three sources:
//   - `@query` files: a DEBOUNCED, query-aware `glob` call (the existing /tools
//     endpoint; no new route). Each query changes the glob, so the server walk is
//     narrowed instead of permanently limiting the picker to the first 100 files.
//     A monotonically increasing sequence drops stale replies.
//   - `@query` folders: the SAME debounced beat also reads `fileList` for the typed
//     scope (glob never yields directories), because folders are listed FIRST —
//     navigation on top, matching file hits below. Both answers carry the same
//     sequence, so they are painted together or not at all.
//   - `#query`: the board's REAL root+nested agent blocks (view.blocks()), deduped
//     by label with the latest occurrence winning (the server's plain-text
//     resolution rule). No network.
//
// A THIRD source fills the same list: `@query` also asks fileList for the folders
// of the typed scope (glob answers file names only — content search is `grep`, and
// neither of them is what a mention picker wants), and those rows are placed FIRST
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
            // Folders come from `fileList` (glob walks past directories), read
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
                    // `glob` is the filename half of the old `fileGlob`: names only,
                    // no `content` property, so the picker never has to interpret a
                    // second result shape.
                    callTool('glob', {
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
// form's submit button: a click arrives through the form's `submit` listener, while the
// keyboard sends (bare Enter on a fine pointer, Ctrl/Cmd+Enter everywhere) call `run()`
// directly. Both converge on that one body (R10: queuing behavior untouched); on a
// touch/unknown pointer a bare Enter stays a native newline (see the keydown contract
// below). In stop mode it is a plain button wired to `stopRun`.
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

    // Issue B: the notch label's TEXT has to start at the same x as the caret inside
    // the field (the "blue dot"), not at a fixed 10px. A static `left` cannot track
    // it, because the text column's origin is content-dependent: the agent button is
    // the frame's first child (R16) and its width is the agent NAME on desktop and the
    // short code (`IT`) under the 860px media query, so the caret moves when the agent
    // changes or the viewport crosses the breakpoint.
    //   - `input.offsetLeft` is measured against `.composer-field`, which is ALSO the
    //     label's containing block (`position: relative`), so `left` and `offsetLeft`
    //     share one origin and need no extra arithmetic;
    //   - `+ textInset` crosses the input's own left padding to reach the glyph column
    //     (read from the live computed style so a stylesheet change cannot drift; the
    //     `|| 8` fallback is what jsdom/no-layout hosts get);
    //   - `- 5` cancels the label's own `padding: 0 5px`, which is what puts the text
    //     — not the label's background box — on the caret;
    //   - the 10px floor is the stylesheet's fallback and keeps the label off the
    //     frame's rounded corner when the pill is missing (tools view, no agent).
    // Hidden clears the inline value so the label can never carry a stale measurement
    // into the next painted state (`[hidden]` is `display: none`, so the write would
    // otherwise be the only thing recomputed late).
    if (showTarget) {
        const textInset = Number.parseFloat(getComputedStyle(input).paddingLeft) || 8;
        composerTarget.style.left = `${Math.max(10, input.offsetLeft + textInset - 5)}px`;
    } else {
        composerTarget.style.left = '';
    }
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
    // T1: the title states the shortcut the reader actually has on THIS device, so the
    // hint must follow the same `(pointer: fine)` query the keydown handler uses — a
    // hardware pointer sends on a bare Enter, a touch/unknown pointer's Enter inserts a
    // newline and Ctrl/Cmd+Enter is the only keyboard send. The button itself is the
    // primary path either way, which is why the non-desktop hint names no shortcut.
    actionButton.title = hasFinePointer() ? 'Send (Enter)' : 'Send';
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
    // R3 (T3): explicit, not merely via `autoGrow`, so the scratch button's anchor is
    // refreshed even in a host where the composer has no editable content to grow.
    syncComposerHeight();
    // Issue B: the notched label is aligned to the caret by MEASUREMENT (see
    // `paintComposerTarget`), and the agent pill's width — the input's offset — changes
    // purely in CSS at the 860px breakpoint (full name -> short code). A resize is the
    // only signal for that swap, so the label has to be re-measured here or it drifts
    // off the text column the moment the pill shrinks.
    paintComposerTarget();
});


// Tool-panel hosts (R21.3). Three named locations, one renderer:
//   - `center` sits above the turn grid, inside the chat column;
//   - `scratch` is the right rail's primary board (the rail holds it ALONE: T3/R1 moved
//     the session directory into the harness head's pill strip);
//   - `left` sits under the harness list and is the rail's last child (R4/T4 moved the
//     endpoint settings into the status-pill dialog);
// Each host hides itself while it has no panels (ui/panels.ts), so the shell stays
// exactly as quiet as before for tools that contribute nothing.
const centerPanels = createPanelHost('center');
// The left host is appended with the create-harness panel below (harness list →
// panels), which is the requested "below harnesses" slot.
const leftPanels = createPanelHost('left');
// R5/T7: `agentSlot` lives inside the `.composer-field` frame now (LEFT edge, R16),
// NOT under the head. The centre keeps the head, the panel host, the stage and the
// composer.
center.append(mainHead, centerPanels.element, stage, composer);

// --- right rail: the tool scratch board, and nothing else ------------------
//
// R1 (T3): the sessions directory left the rail for the pill strip under the Instruct
// header (`.session-pills-bar`, built in the head above), so the right rail is now the
// scratch board ALONE. Its accessible name says exactly that, and the phone trigger for
// it is the floating `.scratch-fab` (R3) rather than a header disclosure.
const rightRail = el('aside', 'rail rail-right');
rightRail.id = 'rail-right';
rightRail.setAttribute('aria-label', 'Scratch board');

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

rightRail.append(scratchSection);

// Dismiss layer for an open phone rail (R1). It is a sibling, NOT a wrapper: the
// rails must stay direct grid children so the desktop three-column layout and
// `shell > .rail-*` selectors keep working. CSS shows it only at <=860px while a
// rail is open and it never takes layout space (`position: fixed`).
const railBackdrop = el('div', 'rail-backdrop');
railBackdrop.setAttribute('aria-hidden', 'true');

// R3 (T3): the scratch FAB is mounted in the shell but is NOT a grid item — CSS makes it
// `position: fixed`, so it takes no track and cannot disturb the three-column layout.
// T8 changed the stacking decision: the button is painted ABOVE the backdrop (2) and both
// drawers (3) with `z-index: 4`, because it is the only way onto the scratch board and the
// reader must be able to press it while the harness drawer is open — one press then SWITCHES
// drawers in the single sidebar slot instead of the press being swallowed as an outside
// dismiss. DOM order still puts it before the backdrop; the layering is CSS's, and the
// backdrop keeps its own click handler for every other outside press.
shell.append(leftRail, center, rightRail, scratchFab, railBackdrop);
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

// T1: a SECOND, independent media axis for the composer's Enter policy — the primary
// INPUT DEVICE, deliberately not the 860px layout breakpoint above.
//
// Why not width: a desktop window dragged to 700px would lose Enter-to-send, and a
// phone in landscape past 860px would gain it. Neither is what the reader meant.
//
// T3 hardening: the query is POSITIVE — `(pointer: fine)` matches only when the PRIMARY
// pointing device is a mouse/trackpad, so Enter-to-send is claimed only on a device the
// page can actually vouch for. Testing `(pointer: coarse)` instead would classify every
// non-coarse device as a desktop, including `(pointer: none)` (keyboard-only or
// assistive-tech input), and would hand Enter-to-send to a machine that was never
// detected. The matrix now reads:
//   - `(pointer: fine)`  -> Enter sends (R2): a desktop, and a touchscreen laptop whose
//     primary pointer is its mouse/trackpad;
//   - `(pointer: coarse)` -> Enter is a newline (R1): a phone/tablet, whose on-screen
//     keyboard has no dependable Shift and whose send button is on screen;
//   - `(pointer: none)` or an absent `matchMedia` (jsdom, very old engines) -> UNKNOWN,
//     so the newline fallback holds. Sending is the irreversible half of the matrix: an
//     environment that cannot prove a hardware keyboard keeps the historical contract
//     instead of inventing a submit.
const finePointerMedia = window.matchMedia?.('(pointer: fine)');
const hasFinePointer = (): boolean => finePointerMedia?.matches ?? false;

// The Enter policy is read live on every keystroke, but the send button's shortcut
// HINT is painted once per composer repaint. Repainting on a pointer change keeps them
// in one state (a touchscreen laptop switching to finger input, or a phone gaining a
// bluetooth keyboard, must not keep advertising a shortcut that no longer applies).
finePointerMedia?.addEventListener?.('change', () => paintComposer());

// Apply the platform-appropriate disclosure semantics to BOTH left-rail triggers (the
// topbar brand and, R4, the "Harnesses" heading inside the drawer itself):
//   - phone: a real disclosure trigger, enabled, with `aria-controls` and the live
//     `aria-expanded` state;
//   - desktop/tablet: the rail is permanently visible, so neither title is a
//     disclosure. Native `disabled` removes it from the tab order and prevents the
//     no-op click; the ARIA disclosure attributes and action title are removed so
//     assistive tech never hears a false "collapsed" state. `.brand`'s and
//     `.rail-title-toggle`'s author styles keep both titles visually identical to a
//     plain label.
const syncBrandTrigger = (): void => {
    if (isPhoneLayout()) {
        brand.disabled = false;
        brand.setAttribute('aria-controls', 'rail-left');
        brand.setAttribute('aria-expanded', openRail === 'left' ? 'true' : 'false');
        brand.title = 'Show or hide harnesses';

        // R4: the heading is the drawer's own toggle — the control that replaced the
        // small `×`. Same disclosure state, same target rail.
        harnessTitleToggle.disabled = false;
        harnessTitleToggle.setAttribute('aria-controls', 'rail-left');
        harnessTitleToggle.setAttribute('aria-expanded', openRail === 'left' ? 'true' : 'false');
        harnessTitleToggle.title = 'Show or hide harnesses';
        return;
    }

    brand.disabled = true;
    brand.removeAttribute('aria-controls');
    brand.removeAttribute('aria-expanded');
    brand.removeAttribute('title');

    harnessTitleToggle.disabled = true;
    harnessTitleToggle.removeAttribute('aria-controls');
    harnessTitleToggle.removeAttribute('aria-expanded');
    harnessTitleToggle.removeAttribute('title');
};

// One painter for the whole state: the shell attribute drives CSS, the two toggles'
// `aria-expanded` drives the accessibility tree. `undefined` removes the attribute
// so the collapsed default has no lingering data state to style. `trigger` is the
// control that opened the rail, so closing always restores focus there even when the
// reader switches from one rail to the other.
//
// T8 — the single sidebar, in code: `openRail` is ONE value and `shell[data-rail-open]` is
// ONE attribute, so "open the other one" is a reassignment, not a second state to keep in
// step. Every call repaints BOTH disclosures (the FAB through the line below, the brand and
// the drawer heading through `syncBrandTrigger`), which is what makes a direct switch
// (harness drawer open → press the scratch button) leave no stale `aria-expanded="true"` on
// the control that just lost the slot, and `railReturnFocus` is OVERWRITTEN on every open —
// the trigger of the rail that is now showing is the dismiss target, never the hidden
// element that opened the previous one.
const setRailOpen = (side: 'left' | 'right' | undefined, trigger?: HTMLElement): void => {
    openRail = side;

    if (side === undefined) delete shell.dataset.railOpen;
    else shell.dataset.railOpen = side;

    // R1: the left rail has no topbar toggle any more (the brand opens it), so only
    // the right rail's own control reports `aria-expanded` here.
    // R3 (T3): the scratch FAB is the right rail's only disclosure trigger now (the
    // header `.rail-toggles` control is gone), so it is what reports `aria-expanded`.
    // The accessible name stays constant ("Open scratch board"): `aria-expanded` already
    // carries the state, and renaming a toggle per state makes the announced name move
    // under a screen reader that is reporting the very change.
    scratchFab.setAttribute('aria-expanded', side === 'right' ? 'true' : 'false');
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

        // The harness drawer is modal-ish: move focus to its own dismiss control (R4:
        // the heading toggle, which is what the removed `×` used to be) so Escape/Tab
        // and the dismissal affordance are immediately reachable.
        if (side === 'left') {
            harnessTitleToggle.focus({ preventScroll: true });
            return;
        }

        // T8: the scratch drawer has NO in-drawer toggle — its dismiss control IS the FAB —
        // so focus goes to the trigger on open. This matters most when the reader switches
        // from the harness drawer: the heading that held focus sits inside a rail CSS has just
        // hidden, and a browser moves focus to <body> when the focused element stops being
        // rendered. Pinning the FAB keeps Escape, Tab and the second press that closes the
        // drawer reachable, and matches where a pointer press already placed the focus.
        scratchFab.focus({ preventScroll: true });
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

// R3 (T3): the floating scratch button is a real toggle for the RIGHT rail — pressing it
// again collapses the drawer. T8: opening it also closes the harness drawer IN ONE PRESS,
// because the phone has one sidebar slot (`setRailOpen` holds a single `openRail`), and the
// button is stacked ABOVE the backdrop (styles.css `z-index: 4`) precisely so this press
// reaches it while the harness drawer is open. The switch reads `openRail === 'right'`
// first, so from `'left'` it lands on `'right'` rather than closing anything, and the
// stored trigger is the button itself — so Escape, the backdrop or a programmatic close
// hand focus back to the control that is still on screen.
scratchFab.addEventListener('click', () => {
    setRailOpen(openRail === 'right' ? undefined : 'right', scratchFab);
});

// R2: clicking the "Harness UI" brand opens the harness DRAWER on sm/mobile. It is
// a toggle, so a second click closes it. `syncBrandTrigger` natively disables the
// button above 860px; the media guard here is the second line of defence against a
// programmatic click while a resize transition is in flight.
brand.addEventListener('click', () => {
    if (!isPhoneLayout()) return;
    setRailOpen(openRail === 'left' ? undefined : 'left', brand);
});

// R4: the "Harnesses" heading toggles the same sidebar the brand does. The drawer is
// the only place this control is reachable on a phone (the rail is `display:none`
// when closed), so in practice this press collapses the drawer the reader is looking
// at — and the toggle semantics stay identical to the brand, including a programmatic
// open. Backdrop, Escape and picking a harness all converge on the same state reset.
harnessTitleToggle.addEventListener('click', () => {
    if (!isPhoneLayout()) return;
    setRailOpen(openRail === 'left' ? undefined : 'left', harnessTitleToggle);
});

// Backdrop click is the pointer dismiss; Escape is the keyboard one. Both only act
// when a rail is actually open, so Escape keeps whatever else the page uses it for
// (there is nothing today) when the shell is fully collapsed.
railBackdrop.addEventListener('click', () => {
    if (openRail !== undefined) setRailOpen(undefined);
});

document.addEventListener('keydown', (event) => {
    // R6: Escape also cancels an armed harness delete, so a confirmation can be
    // abandoned from the keyboard without clicking elsewhere. This runs independently of
    // the rail dismiss below: an armed row and an open rail are different states, and
    // one press should not leave a pending confirmation behind.
    if (event.key === 'Escape' && armedHarness !== undefined) {
        armedHarness = undefined;
        buildHarnesses();
    }

    if (event.key === 'Escape' && openRail !== undefined) setRailOpen(undefined);
});

// Leaving the phone breakpoint forgets the phone-only state, so rotating/resizing to
// a desktop width and back cannot resurrect a rail the reader had already dismissed.
// Entering the phone breakpoint re-enables the brand and restores its disclosure
// semantics; leaving it disables/strips them through `setRailOpen(undefined)`.
// `matchMedia` is absent in jsdom and in very old browsers: optional, not required.
phoneMedia?.addEventListener?.('change', (event) => {
    // T6: the harness dialog's Sessions section is breakpoint-shaped (it stands in for the
    // header strip, which CSS hides at ≤860px), so crossing the line WHILE the dialog is
    // open has to re-shape it — in either direction. Rebuild, never close: the reader is
    // looking at this layer, and `handle.update` keeps its focus contract.
    refreshHarnessDialog();

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
// R11/R12/T3: the agent dialog is APP-scoped, not per view. It is opened from the
// composer button, kept in sync across routine chrome rebuilds (see
// `refreshAgentDialog`) and closed by the lifecycle changes that used to reset the
// old popover (harness switch, new/deleted session, Tools view). The dialog owns its
// OWN draft state (which agent is selected, what has been edited), so main.ts
// remembers no view state for it: a dismissal simply drops the handle.
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
// session is being created must not race the freeze (see applyAgentConfiguration); a
// counter
// rather than a boolean because the manual tool runner may also create one.
let creatingSessions = 0;

// ---------------------------------------------------------------------------
// The tools playground's own context (R7)
// ---------------------------------------------------------------------------
//
// The Tools view in the top-right is a GLOBAL playground: it must behave the same no
// matter which conversation is selected, and a session-bound tool (toolRequest,
// toolCreate, task, delegate) must never mutate the chat the reader is looking
// at. Calling such a tool therefore runs it in a TEMPORARY session this view owns:
//
//   - created through `createSession` against a PRODUCTION harness this function picks
//     itself (the first descriptor the server reports) — never `ensureSession(current)`,
//     and never a thread inside the real conversation;
//   - kept for the whole playground visit, so a `toolRequest` discovery followed by a
//     `toolCreate` and a `task` observe the same session — that chain is exactly
//     what makes these tools worth testing here;
//   - deleted when the playground closes, when it is superseded (a different harness is
//     picked, the bound harness is deleted, or the page unloads).
//
// The id deliberately lives HERE, outside `Instance`/`current`/`sessions`: the reader's
// selection state, the sessions rail, the scratch board and the remembered session are
// all untouched by a playground call. The trade-off is honest and stated in the UI copy
// AND in `playgroundSessions`: the server holds a real session record while the
// playground is open, so the roster paths filter that id out until it is deleted.
//
// If no harness is reported there is no context to run in, and the runner says so with
// an actionable error rather than quietly borrowing the selected conversation.
type PlaygroundState = {
    // The production harness the current temporary session belongs to.
    harness: string | undefined;
    // The temporary session's id; `undefined` until a session-bound tool is called.
    sessionId: string | undefined;
    // What toolRequest enabled inside that session (the playground note's truth).
    discovered: string[] | undefined;
    // Bumped by every close/supersede. An in-flight create or call that captured an
    // older generation may not publish anything when it finally lands.
    generation: number;
    // A create is currently awaited (a close during that window is the race below).
    creating: boolean;
};

const playground: PlaygroundState = {
    harness: undefined,
    sessionId: undefined,
    discovered: undefined,
    generation: 0,
    creating: false
};

// Every session id THIS page created for the playground. The sessions roster filters
// them out (see `upsertSession`/`refreshSessions`/`visibleSessions`), so a temporary
// context never leaks into the list of conversations while it exists — and an id stays
// marked even when the cleanup DELETE fails, because hiding a leaked record is better
// than offering the reader a conversation they never started.
const playgroundSessions = new Set<string>();

// The harness the playground runs in: the FIRST descriptor the server reports. It is
// independent of `selectedName`/`current` (so selecting a different conversation never
// moves the playground), and stable while the roster is unchanged, which is what keeps
// a chain of calls inside one session.
const playgroundHarness = (): string | undefined => presetDescriptors[0]?.name;

// Close the temporary context: invalidate the current generation FIRST (so an in-flight
// create discards its own answer), then delete the record. `pagehide` uses the keepalive
// variant because an ordinary fetch may not survive the unload.
const releasePlaygroundSession = (options?: { unload?: boolean }): void => {
    const id = playground.sessionId;

    playground.sessionId = undefined;
    playground.harness = undefined;
    playground.discovered = undefined;
    playground.creating = false;
    // Always bumped, even with no id: a create in flight must see that its generation
    // is gone and delete the session that arrives late.
    playground.generation += 1;

    if (id === undefined) return;

    const request$ = options?.unload === true ? deleteSessionOnUnload(id) : deleteSession(id);

    void request$.then(
        // Removed from the roster filter only once the server confirms the record is
        // gone; until then it stays hidden locally.
        () => playgroundSessions.delete(id),
        (error: unknown) => {
            // On unload the page is going away, so reporting is pointless (and a
            // status paint could not be read). Otherwise the leak is named, because an
            // orphan session WOULD reappear in the roster after a reload.
            if (options?.unload !== true) setStatus('error', `playground cleanup: ${messageOf(error)}`);
        }
    );

    renderPlaygroundNote();
};

// The session a session-bound call runs in, creating the playground's own on demand.
// Returns `undefined` when there is no harness to run in, or when this playground
// generation was closed while the create was in flight (that answer is deleted).
const ensurePlaygroundSession = async (): Promise<string | undefined> => {
    const harness = playgroundHarness();
    if (harness === undefined) return undefined;

    if (playground.sessionId !== undefined) {
        // Reuse: this is what lets toolRequest -> toolCreate -> toolManage see one
        // growing session across playground calls.
        if (playground.harness === harness) return playground.sessionId;

        // Superseded: the chosen harness changed (the roster moved underneath us), so
        // the old temporary session is dropped rather than left behind.
        releasePlaygroundSession();
    }

    playground.harness = harness;
    playground.creating = true;
    const generation = playground.generation;

    try {
        // `settings` are the configured runtime defaults, exactly as a chat submit uses
        // them — the playground never inherits another conversation's frozen model.
        const session = await createSession(harness, settings);

        // Closed (or superseded) while this request was in flight: this record is not
        // the live playground's context, so it is removed immediately and the caller is
        // told the call did not run. Best-effort: nothing awaits it.
        if (generation !== playground.generation || !showingTools) {
            playgroundSessions.add(session.id);
            void deleteSession(session.id).catch(() => undefined);
            return undefined;
        }

        playground.sessionId = session.id;
        playgroundSessions.add(session.id);
        playground.discovered = Array.isArray(session.discoveredTools)
            ? [...session.discoveredTools]
            : undefined;
        renderPlaygroundNote();

        return session.id;
    } finally {
        playground.creating = false;
    }
};

// Session context the playground runner needs. It reads ONLY the state above: the
// selected harness/conversation is never consulted, so opening the tools view from any
// chat produces the same surface and the same request bodies.
const runner = createToolRunner({
    context: () => {
        const harness = playground.harness ?? playgroundHarness();
        if (harness === undefined) return {};

        return {
            harness,
            ...(playground.sessionId === undefined ? {} : { sessionId: playground.sessionId })
        };
    },
    ensureSession: ensurePlaygroundSession,
    // delegate is only registered when the harness declares subagents, so the runner
    // asks the PLAYGROUND harness for its real allowlist (R7) — the selected
    // conversation's frozen team is irrelevant here. A harness with none cannot offer a
    // callable delegation.
    delegateTargets: () => {
        const harness = playground.harness ?? playgroundHarness();
        if (harness === undefined) return [];

        const descriptor = descriptorFor(harness);

        return descriptor === undefined ? [] : subagentsOf(descriptor);
    },
    refreshSession: async (sessionId) => {
        // Re-read the playground's OWN snapshot for the playground note. The answer is
        // never applied to an Instance and never enters the sessions roster, so a
        // discovery inside the temporary context cannot repaint or adopt anything in the
        // conversation the reader is looking at.
        const session = await getSession(sessionId);
        if (playground.sessionId !== sessionId) return;

        playground.discovered = Array.isArray(session.discoveredTools)
            ? [...session.discoveredTools]
            : undefined;
        renderPlaygroundNote();
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
            deleteThreadForSession,
            saveThreadTranscriptFor
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

// R6: the per-row delete controls, kept beside the select buttons so the busy-state
// painter (`paintControls`) can enable/disable both from the same roster pass.
const harnessDeleteButtons = new Map<string, HTMLButtonElement>();

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
// Paints the live agent ring on BOTH hosts of `data-agent`: the composer control
// (`agentSlot`) and the team rows of an OPEN configuration dialog. The dialog's rows
// are not inside `agentSlot`, and its body is deliberately NOT rebuilt for an activity
// frame (a rebuild would throw the reader's caret away mid-instruction, T3), so the
// ring has to be pushed here for the two hosts to stay in step.
const paintAgentRings = (active: ReadonlySet<string>): void => {
    paintActivity(agentSlot, active);
    agentDialog?.paintActivity(active);
};

const clearActivity = (): void => {
    for (const instance of instances.values()) instance.activity.clear();
    paintAgentRings(new Set<string>());
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

// `fallback` is the definition to select when the registry no longer holds this name
// (R6: opening a saved session of a DELETED harness). It never writes to the roster, so
// selecting an archived conversation cannot resurrect its harness.
const selectHarness = (name: string, fallback?: HarnessDescriptor): void => {
    const descriptor = descriptorFor(name) ?? fallback;
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
    // R7: the playground was left, so its temporary session goes with it. This must
    // happen BEFORE the new selection paints the chat, so no late frame can adopt it.
    releasePlaygroundSession();
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

// ---------------------------------------------------------------------------
// Deleting a harness (R6)
// ---------------------------------------------------------------------------
//
// DELETE /harnesses/:name is DURABLE and removes the definition only: built-ins go
// with it, and the server never cascades into sessions (src/server/api.ts). So a
// conversation already started keeps its frozen definition and stays in the sessions
// roster — the local state below must not throw those records away.
//
// Confirmation is TWO STEPS on purpose, unlike the one-click session delete: removing
// a harness is not undoable from this UI (the reader would have to recreate it, and a
// built-in is gone for every visitor of this server). The first press only ARMS the
// row (`armedHarness`), the second press on the SAME control sends exactly one DELETE.
// Nothing else about the row changes, so arming can never select or deselect it.
//
// Harnesses with a DELETE in flight are tracked in `removingHarnesses`; it doubles as
// the dedupe guard for a double pointer event.
const removingHarnesses = new Set<string>();

// The row currently waiting for its second press. Only one row is armed at a time, so
// arming another row moves the confirmation instead of creating a second pending state.
let armedHarness: string | undefined;

// A harness delete must not race a write that owns the same definitions, and must not
// happen before the catalogue exists:
//   - `submitting` is the POST /tasks window, which may be creating a session,
//   - `savingAgents` is a harness/team PATCH,
//   - `running`/`current.pending` means the centre column is showing work whose harness
//     would vanish underneath it,
//   - a session creation in flight (`creatingSessions`) would make "which harness is
//     selected" ambiguous exactly when the delete has to reselect one.
const harnessDeletionBlocked = (): boolean =>
    !booted || submitting || savingAgents || running || creatingSessions > 0 || removingHarnesses.size > 0;

// Forget one harness the server no longer holds (a 200, or a 404 that says it was
// already gone). The roster is the only authority for the rail AND for the harness the
// playground picks, so the descriptor goes first and everything else is derived.
const applyHarnessRemoved = (name: string): void => {
    presetDescriptors = presetDescriptors.filter((descriptor) => descriptor.name !== name);

    // The instance (its transcript view, panels and observer bindings) dies with its
    // harness. SAVED SESSIONS are untouched: they are server records, and the directory
    // cache keeps them for any harness that still exists.
    const instance = instances.get(name);
    if (instance !== undefined) {
        if (instance === current) {
            stopWatching();
            stopPolling();
        }
        instance.view.dispose();
        instances.delete(name);
    }

    // R7: the playground's temporary session was created ON this harness. Its core
    // tools can no longer resolve the definition, so the context goes with it.
    if (playground.harness === name) releasePlaygroundSession();

    // The agent library keeps its trusted entries: they belong to the server, not to
    // the deleted harness, and other harnesses may name the same agents.
    if (selectedName === name) {
        selectedName = undefined;
        current = undefined;
        currentTool = undefined;
        clearActivity();

        // Reselect sensibly: the first harness the server still reports. `selectHarness`
        // restores the composer, the head and the transcript from that instance.
        const next = presetDescriptors[0];

        if (next !== undefined) {
            selectHarness(next.name);
        } else if (showingTools) {
            // The playground owns the centre column, so it stays: its note now says there
            // is no context for a session-bound tool, and a direct call still works.
            paintToolsHead();
        } else {
            // Empty roster without crashing: the chat has nowhere to go, so the centre
            // column says what is available instead of showing a dead transcript. The
            // playground stays reachable from the topbar for direct calls, and `+ New`
            // is the way back.
            agentSlot.hidden = true;
            composer.hidden = true;
            stage.replaceChildren(emptyStagePane());
            renderSessions();
        }
    }

    buildHarnesses();
    // R6: the deleted harness's conversations become archived immediately — the group is
    // painted from the same directory cache, which this delete never touches.
    renderSessions();
    renderPlaygroundNote();
};

// The centre column shown when no harness exists at all (R6: deleting the last one must
// not leave a stale conversation or a blank column).
const emptyStagePane = (): HTMLElement => {
    const pane = el('div', 'pane');
    const wrap = el('div', 'log-wrap');
    const box = el('div', 'empty');

    box.append(
        el('p', 'field-hint', 'No harness is available. Create one with “+ New” in the harnesses panel.'),
        el(
            'p',
            'field-hint',
            'Saved sessions for the harness you deleted are still on the server; they stay in the sessions list.'
        )
    );

    wrap.append(box);
    pane.append(wrap);
    return pane;
};

// One press arms, the second deletes. Every dismissal path (selecting another harness,
// arming a different row, a successful delete) clears the arm, and Escape does too.
const deleteHarnessRow = async (name: string): Promise<void> => {
    if (harnessDeletionBlocked()) return;

    if (armedHarness !== name) {
        armedHarness = name;
        buildHarnesses();
        return;
    }

    // Second press on the armed row: consume the confirmation BEFORE the request, so a
    // double pointer event cannot send two DELETEs.
    armedHarness = undefined;
    removingHarnesses.add(name);
    buildHarnesses();

    let deleted = false;

    try {
        deleted = await deleteHarness(name);
    } catch (error) {
        setStatus('error', `delete harness: ${messageOf(error)}`);
        removingHarnesses.delete(name);
        // The row is repainted from the roster the server agreed with, so the control
        // is armed again rather than left showing a confirmation nobody asked for.
        buildHarnesses();
        return;
    }

    removingHarnesses.delete(name);

    // `deleted: false` is the accepted 404: the harness is already gone, which is the
    // desired end state (the same reasoning as a session delete).
    applyHarnessRemoved(name);
    setStatus('idle', deleted ? `deleted ${name}` : `${name} was already gone`);
};

const buildHarnesses = (): void => {
    harnessList.replaceChildren();
    harnessButtons.clear();
    harnessDeleteButtons.clear();

    for (const descriptor of presetDescriptors) {
        // Buttons cannot nest, so the row is a wrapper around the select button and its
        // delete control (the same structure the sessions rail uses, R8). A press on the
        // delete control can never select the harness, because the two controls are
        // siblings and only the select button carries the selection handler.
        const row = el('div', 'harness-row');
        row.dataset.harness = descriptor.name;

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

        // No shared `.button` classes here: like `.session-pill-delete`, this control owns
        // its compact destructive styling outright, and a later `.button` rule would
        // otherwise win on equal specificity.
        const remove = el('button', 'harness-delete');
        remove.type = 'button';
        remove.dataset.harness = descriptor.name;
        const armed = armedHarness === descriptor.name;
        remove.textContent = armed ? 'Delete?' : '×';
        remove.setAttribute(
            'aria-label',
            armed ? `Confirm delete harness ${descriptor.name}` : `Delete harness ${descriptor.name}`
        );
        // The warning lives on the control, so a reader who never arms it still knows
        // what the second press costs.
        remove.title = armed
            ? `Delete ${descriptor.title} (${descriptor.name}) permanently. Press again to confirm, or pick another row to cancel.`
            : `Delete ${descriptor.title} (${descriptor.name}) permanently. Its saved sessions stay.`;
        remove.setAttribute('aria-describedby', armed ? `harness-delete-hint-${descriptor.name}` : '');
        if (!armed) remove.removeAttribute('aria-describedby');
        remove.disabled = harnessDeletionBlocked() || removingHarnesses.has(descriptor.name);

        remove.addEventListener('click', () => void deleteHarnessRow(descriptor.name));

        row.append(button, remove);

        if (armed) {
            // The confirmation is text, not only a repainted button: it names exactly
            // what is about to happen and what survives, and it is the description the
            // armed control points at.
            row.dataset.armed = 'true';
            const hint = el(
                'p',
                'field-hint harness-delete-hint',
                `Delete “${descriptor.title}” (${descriptor.name}) permanently? Its saved sessions stay, and this cannot be undone from the UI.`
            );
            hint.id = `harness-delete-hint-${descriptor.name}`;
            row.append(hint);
        } else {
            delete row.dataset.armed;
        }

        harnessButtons.set(descriptor.name, button);
        harnessDeleteButtons.set(descriptor.name, remove);
        harnessList.append(row);
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

    // The playground's own status line (R7): it describes the temporary context, so
    // the tools view stays truthful about where a session-bound call runs no matter
    // which conversation is selected.
    renderPlaygroundNote();

    // The playground runner lives on the tools view and builds its delegate presets
    // from the PLAYGROUND harness's allowlist (see createToolRunner.paintDelegate). A
    // team edit can land on that harness from this very chrome, so re-sync it: the
    // preset becomes callable the moment a subagent exists, and stops being offered
    // when the last one is removed. The runner only rewrites its argument box when the
    // target list actually changed, so this is a no-op for an untouched team.
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
    //
    // R6: unless its harness is gone. A deleted harness has no registry row to edit, and
    // the conversation on screen is running the definition frozen in its own record, so
    // the note says what the reader is looking at instead of promising edits that have no
    // target. Nothing here re-adds the harness to the roster.
    //
    // T3/R1: an ordinary saved session gets NO note at all. The old frozen-team caption
    // restated two facts the reader cannot act on — the conversation on screen is already
    // visible, and the team's lock is stated on the controls themselves (ui/agents.ts sets
    // the reason on every disabled editor). The strip under the title now shows WHICH
    // session is open, which is the part that used to be worth printing.
    const archived = descriptorFor(instance.descriptor.name) === undefined;

    headNote.textContent = archived
        ? instance.sessionId !== undefined
            ? 'Deleted harness · saved session kept and reopened from its frozen definition'
            : 'Deleted harness · read the saved session, or pick a harness that still exists'
        : locked
          ? ''
          : 'Edits apply to new sessions';
    // `hidden` (not just empty text) so the empty state leaves no reserved line: the
    // note is a static block in the header, and the archived branches above must un-hide
    // it again.
    headNote.hidden = headNote.textContent.length === 0;

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

    // Issue B: this is the ONLY place the agent button is rebuilt, so it is the one
    // funnel through which the pill's width changes (harness switch, agent promotion,
    // a team edit, an activity/snapshot frame). The label's inline `left` is derived
    // from that width, so the alignment has to be recomputed here — nothing else in
    // this path repaints the composer, and a stale `left` would leave the notch label
    // sitting over the previous agent's text column.
    paintComposerTarget();
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
    // The stored per-agent INSTRUCTION overrides (T3). Effective text = this map
    // first, else the trusted catalogue instruction (main.ts pairs it with
    // `agentLibrary`, exactly the way the dialog's textarea is seeded).
    instructions: Record<string, string>;
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

    // Per-agent INSTRUCTION overrides (T3). The harness's stored map is the only
    // source: a member absent from it runs the trusted preset instruction, which is
    // what the dialog's textarea is seeded with. A saved conversation reads its
    // FROZEN definition here, so the text on screen is the text that conversation
    // actually runs — and editing it is refused, because a system message already
    // seeded into a running transcript cannot be rewritten without rebuilding the
    // conversation (see the `hint` below and the dialog's locked instruction note).
    const instructions = agentInstructionsOf(display);

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

    // The hint names the ACTUAL cause instead of claiming "locked" for a busy run.
    // T3: it also has to cover the instruction editor, which is locked for the same
    // three reasons, so a saved conversation's message says what is frozen rather
    // than guessing at a team-only restriction.
    const hint = locked
        ? 'A saved conversation keeps the agent team and the instructions it was created with; only models can change here. Edits saved on the harness apply to a new session.'
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
        instructions,
        fallback,
        ...(hint === undefined ? {} : { hint })
    };
};

// The model dropdown payload shared by the configuration panel inside the dialog.
// Every rule below is the pre-existing one from the old centre row/popover; only its
// host changed. `onChange` is deliberately absent: the dialog owns the model choice
// as a DRAFT and writes it through `onApply`, so a select change must never PATCH.
const agentModelSelectOf = (view: AgentView) => ({
    models: view.models,
    catalogue: modelIds,
    ...(view.fallback.length > 0 ? { fallbackModel: view.fallback } : {}),
    // R2: models are NOT part of the frozen team. A saved session edits its live map
    // through PATCH /sessions/:id, and an in-flight run keeps streaming while the
    // next request picks the new id up. The single-flight guard lives in
    // applyAgentConfiguration/patchSessionModels, not in this flag (rendering while
    // that PATCH is in flight must not look disabled).
    editable: view.locked || !running,
    // Tells the control which promise the choice makes: a session edit applies to the
    // next request in THIS chat, a harness edit to future sessions.
    ...(view.locked ? { session: true } : {})
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
    instructions: view.instructions,
    activity: [...instance.activity],
    ...(view.hint === undefined ? {} : { hint: view.hint }),
    // T3: the one write path. The dialog never PATCHes on select or on edit.
    onApply: (changes: AgentConfigurationApply) => applyAgentConfiguration(changes)
});

// A cheap equality key for "does the open dialog need repainting?". It covers every
// field the dialog renders that can change while it is open.
//
// `activity` is deliberately NOT part of it (T3): live `start`/`done` frames arrive
// many times a run and only move the ring on the team rows, which `paintActivity`
// repaints in place. Including it here would rebuild the body while the reader is
// typing an instruction, and a rebuild throws the caret away.
const agentDialogSignatureOf = (view: AgentView): string =>
    JSON.stringify({
        members: view.members,
        primary: view.primary,
        editable: view.editable,
        models: view.models,
        instructions: view.instructions,
        fallback: view.fallback,
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
    agentDialogSignature = agentDialogSignatureOf(view);

    agentDialog = openAgentDialog({
        ...agentDialogOptionsOf(view, instance),
        onClose: () => {
            agentDialog = undefined;
            agentDialogSignature = undefined;

            // Focus return (R11/R13/T3). ui/dialog.ts restores the opener when it is
            // still connected; a chrome rebuild may have replaced the composer button
            // while the modal was open, so fall back to the LIVE button rather than
            // leaving focus on <body>. The dialog-contents test matters too: `onClose`
            // can run while the body is still mounted (focus sits on a control that is
            // about to disappear), and then `activeElement` is neither null nor body.
            const active = document.activeElement;
            if (
                active === null ||
                active === document.body ||
                active.closest('.agent-dialog') !== null
            ) {
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
// signature matches, yet the control the reader operated is showing a choice that
// was refused. Rebuilding is the only way to snap it back to the last confirmed
// value. T3: the dialog's editors now hold DRAFTS, so a refused write does not need
// snapping (the draft is the truth about what the reader typed); `force` still
// matters for the paths that write outside the dialog, and it is cheap to keep.
const refreshAgentDialog = (view: AgentView, instance: Instance, force = false): void => {
    if (agentDialog === undefined || !agentDialog.isOpen) return;

    const signature = agentDialogSignatureOf(view);
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

// ---------------------------------------------------------------------------
// The one agent write path (T3 transactional configuration)
// ---------------------------------------------------------------------------
//
// The dialog hands over DELTAS and the promotion it represents. This function is the
// only place that turns them into a request, which is what keeps the two server
// surfaces honest:
//
//   - NO SESSION YET — one atomic PATCH /harnesses/:name carrying the complete
//     `primary` + `subagents` + `agentModels` + `agentInstructions`. One request, so
//     a promotion and a model/instruction edit can never land as two partially
//     applied writes, and the demoted old primary survives as a secondary exactly
//     once (no stale duplicate).
//   - A SAVED SESSION — the team and the instructions are frozen (a conversation
//     runs the definition it was created with), so only the live model map is
//     writable, through PATCH /sessions/:id. Anything else in the draft is refused
//     with the reason, and the dialog keeps the drafts so the reader can start a new
//     session and save them there.
//
// The return value is what the dialog renders: `applied: false` never closes it and
// never clears a draft.
const applyAgentConfiguration = async (
    changes: AgentConfigurationApply
): Promise<AgentApplyResult> => {
    const instance = current;
    if (instance === undefined) {
        return { applied: false, message: 'No conversation is selected.' };
    }

    const view = agentViewOf(instance);
    const display = view.display;
    const members = view.members;
    const busy = changes.primary !== undefined || changes.add.length > 0 || changes.remove.length > 0;

    // A second save while one PATCH is in flight is refused, not queued: the first
    // request already carries every draft the dialog holds right now.
    if (savingAgents) {
        return { applied: false, message: 'An agent save is still in flight · try again in a moment.' };
    }

    // --- saved session: live models only ----------------------------------
    const sessionId = instance.sessionId;

    if (sessionId !== undefined) {
        if (busy) {
            return {
                applied: false,
                message:
                    'This conversation keeps the team it was created with · save on the harness to use it in a new session.'
            };
        }

        // T5 safeguard: instruction deltas are forbidden here for the same reason the
        // team is — a saved conversation runs the system prompt it was created with,
        // and PATCH /sessions/:id has no instruction field to write. Today the dialog
        // cannot produce such a draft (its editor is rendered disabled while locked),
        // so this branch is a guard against a future/stale caller: refusing beats
        // dropping the delta and reporting the save as applied.
        if (Object.keys(changes.instructions).length > 0) {
            return {
                applied: false,
                message:
                    'This conversation keeps the instructions it was created with · save on the harness to use them in a new session.'
            };
        }

        const drafted = Object.entries(changes.models);

        if (drafted.length === 0) {
            return { applied: false, message: 'Nothing changed.' };
        }

        // The session PATCH MERGES, so the body is the complete live map (the
        // server's answer wins over the frozen overrides for members the patch does
        // not name). A "use the default" choice becomes that resolved id rather than
        // a deleted key: deleting here would leave the agent on the model it already
        // runs, which is the opposite of what the reader picked.
        const next = modelsForMembers(
            { ...agentModelsOf(display), ...(instance.sessionModels ?? {}) },
            members
        );

        for (const [name, model] of drafted) {
            if (!members.includes(name)) continue;

            const value = model.trim();
            const resolved = view.fallback.trim();

            if (value.length === 0) {
                if (resolved.length > 0) next[name] = resolved;
                else delete next[name];
            } else {
                next[name] = value;
            }
        }

        if (Object.keys(next).length === 0) {
            return { applied: false, message: 'No model is available to select here yet.' };
        }

        return await patchSessionModels(instance, sessionId, next);
    }

    // --- editing the harness itself --------------------------------------
    if (running) {
        return { applied: false, message: 'Wait for the current run to finish before saving agents.' };
    }

    // A session being created captures the model map at creation, so a harness PATCH
    // from here could race the freeze and be ignored. Refuse loudly instead of
    // silently changing a descriptor the new session already passed.
    if (creatingSessions > 0) {
        return {
            applied: false,
            message: 'A session is being created · save again once it exists.'
        };
    }

    const primary = changes.primary ?? primaryOf(display);

    // Membership: removing is opt-IN, adding is what a promotion of an outside agent
    // implies. Nothing else moves, so the current team can never shrink by accident
    // and the new primary is never listed as its own subagent.
    const kept = members.filter((name) => !changes.remove.includes(name));
    const added = changes.add.filter((name) => !kept.includes(name));
    const nextMembers = uniqueNames([primary, ...kept.filter((name) => name !== primary), ...added]);

    if (!nextMembers.includes(primary)) return { applied: false, message: 'A harness needs a primary agent.' };

    // Merge the deltas onto the stored maps. An explicit '' clears a key, which is
    // how the dialog reverts one agent to the default model or to the trusted preset
    // instruction without a second protocol verb.
    const models = { ...agentModelsOf(display) };

    for (const [name, model] of Object.entries(changes.models)) {
        const value = model.trim();
        if (value.length === 0) delete models[name];
        else models[name] = value;
    }

    const instructions = { ...agentInstructionsOf(display) };

    for (const [name, instruction] of Object.entries(changes.instructions)) {
        const value = instruction.trim();
        if (value.length === 0) delete instructions[name];
        else instructions[name] = value;
    }

    const nextModels = modelsForMembers(models, nextMembers);
    const nextInstructions = instructionsForMembers(instructions, nextMembers);

    // Same server state means the same request would be a pointless round trip. The
    // dialog cannot normally get here (its action stays disabled while nothing is
    // pending), so this is a guard against a stale tab rather than a UX path.
    if (
        primary === primaryOf(display) &&
        JSON.stringify(nextMembers) === JSON.stringify(members) &&
        JSON.stringify(nextModels) === JSON.stringify(modelsForMembers(agentModelsOf(display), members)) &&
        JSON.stringify(nextInstructions) ===
            JSON.stringify(agentInstructionsOf(display)) &&
        !busy
    ) {
        return { applied: false, message: 'Nothing changed.' };
    }

    return await patchAgents(primary, nextMembers, nextModels, nextInstructions);
};

// Send the complete team on every change: `primary` plus every other member as
// `subagents`. That is what makes a demotion atomic — the old primary is listed
// as a secondary exactly once and no stale duplicate can survive.
//
// `models` and `instructions` are the COMPLETE maps the caller wants stored. The
// server replaces each map with what it receives, so every mutation sends the whole
// map (promotion keeps each member's entry, add leaves the new member inheriting,
// and remove drops the removed member's key via `modelsForMembers` /
// `instructionsForMembers` — the server offers the same guarantee, but a complete
// map never depends on it).
const patchAgents = async (
    primary: string,
    members: readonly string[],
    models: Readonly<Record<string, string>>,
    instructions: Readonly<Record<string, string>>,
    label = 'agent configuration'
): Promise<AgentApplyResult> => {
    const instance = current;

    if (instance === undefined) {
        return { applied: false, message: 'No conversation is selected.' };
    }

    if (savingAgents) {
        return { applied: false, message: 'An agent save is still in flight · try again in a moment.' };
    }

    const display = instance.frozen ?? instance.descriptor;
    const unique = uniqueNames(members);
    const nextPrimary = unique.includes(primary) ? primary : unique[0];

    if (nextPrimary === undefined) {
        return { applied: false, message: 'A harness needs at least one agent.' };
    }

    const subagents = unique.filter((name) => name !== nextPrimary);
    const includeModels = Object.keys(models).length > 0;
    const includeInstructions = Object.keys(instructions).length > 0;

    savingAgents = true;
    // R3: `saving` is the visible word; the label says WHAT is being saved in the
    // tooltip only.
    setStatus('saving', `saving ${label}`);

    try {
        const updated = await updateHarness(display.name, {
            primary: nextPrimary,
            subagents,
            ...(includeModels ? { agentModels: models } : {}),
            // T3: `{}` is meaningful and must still be sent — it clears every stored
            // override so every member runs its trusted preset instruction again.
            ...(includeInstructions || Object.keys(agentInstructionsOf(display)).length > 0
                ? { agentInstructions: instructions }
                : {})
        });
        replaceDescriptor(updated);
        buildHarnesses();
        renderHarnessChrome();

        // The pill leaves `saving` only here: the write is confirmed and the descriptor
        // on screen is the server's answer. `label` says WHAT was saved.
        setStatus('idle', `${label} saved · applies to new sessions`);

        return { applied: true, message: `${label} saved · applies to new sessions` };
    } catch (error) {
        // The descriptor on screen is still the last server answer, so a failed PATCH
        // leaves a truthful row. The dialog is forced because its derived state is
        // unchanged while the rejected control still shows the user's choice (T5 R13).
        const message = messageOf(error);
        setStatus('error', `${label}: ${message}`);
        renderHarnessChrome();
        forceRefreshAgentDialog();

        return { applied: false, message };
    } finally {
        savingAgents = false;
    }
};

// PATCH a saved session's live model map and apply the answer (R2).
//
// `savingAgents` is the existing single-flight guard for agent edits: a second change
// while one PATCH is in flight is refused rather than queued.
//
// The answer uses the GET /sessions/:id envelope (`{ session }`), so it is applied
// the same way — but ONLY the model fields and the directory row. The transcript is
// deliberately NOT rehydrated: a run may be streaming into this view, and replaying
// an answer that is a moment behind the stream would roll the tiles back.
const patchSessionModels = async (
    instance: Instance,
    id: string,
    models: Readonly<Record<string, string>>
): Promise<AgentApplyResult> => {
    if (savingAgents) {
        // A second change while one PATCH is in flight is dropped, not queued. The
        // dialog keeps its draft and shows the reason; nothing on screen claims a
        // write that never happened.
        return { applied: false, message: 'An agent save is still in flight · try again in a moment.' };
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
        if (instance.sessionId !== id) {
            return { applied: false, message: 'This conversation changed before the save landed.' };
        }

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

        return { applied: true, message: 'Models saved · the next request uses them.' };
    } catch (error) {
        // Errors are shown even mid-run: a rejected model is something the reader
        // must see, and the streaming turn keeps its tiles either way. The row/dialog
        // is redrawn from the last confirmed map so it cannot pretend the change stuck.
        const message = messageOf(error);
        setStatus('error', `agent models: ${message}`);

        if (current === instance) {
            renderHarnessChrome();
            forceRefreshAgentDialog();
        }

        return { applied: false, message };
    } finally {
        savingAgents = false;
    }
};

// R21.2/R7: the tool catalogue is the global playground and nothing else. This line is
// that playground's OWN context status: which harness/session a session-bound call will
// mutate, and which tools toolRequest enabled THERE.
//
// It is deliberately NOT derived from the selected instance any more. The playground is
// the same surface from every conversation, so the note names the temporary context (or
// says why there is none) and states plainly that the reader's chat is untouched.
const renderPlaygroundNote = (): void => {
    const harness = playground.sessionId === undefined ? playgroundHarness() : playground.harness;

    if (harness === undefined) {
        toolsSessionNote.textContent =
            'No harness is reported by this server, so session-bound tools have no context to run in. Create a harness first; every other tool can still be called directly.';
        return;
    }

    const target =
        playground.sessionId === undefined
            ? `${harness} (no temporary session yet — the first Call creates one)`
            : `${harness} · temporary session ${shortId(playground.sessionId)}`;
    const enabled = playground.discovered ?? [];

    toolsSessionNote.textContent =
        `Session-bound tools run in the playground’s own context: ${target}` +
        (enabled.length === 0 ? '' : ` · enabled there: ${enabled.join(', ')}`) +
        '. The conversation you selected is never touched.';
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
    'Every tool the server lists, core tools included. Select one to open its runner. Calls execute on the harness server — nothing runs in this browser. This playground is independent of the conversation you have selected: session-bound tools (toolRequest, toolCreate, task, and delegate when the playground harness has subagents) run in a temporary session the playground creates for itself and deletes when this view closes, and every other tool, including the core file and search tools, runs directly.'
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
    // T3/R1: the chat head now HIDES the note for a saved session, so every tools-view
    // writer must un-hide it again — otherwise the catalogue line would be painted into a
    // `hidden` element the reader never sees.
    headNote.hidden = false;
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
        // R8: NO dialog-level copy any more. The runner is two panes with different
        // payloads (the editable request and the server's answer), and each of them
        // carries its own copy control beside its own label, so a single header button
        // could only ever guess which one the reader meant.
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
    // T3/R1: same un-hide as `paintToolsHead` — the chat head hides the note for a saved
    // session, and a tool heading always has something to say.
    headNote.hidden = false;
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

        // R7: leaving the playground is the end of the temporary context. The session
        // a chain of core calls built up is deleted here (and an in-flight create
        // discards its own answer through the generation bump), so the reader never
        // keeps a conversation they did not start.
        releasePlaygroundSession();

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

    // R7: a fresh playground visit starts with a fresh context (the previous one was
    // released when the view closed), and the note states that up front.
    renderPlaygroundNote();

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

    // R7: a playground session is a tool-testing context, not a conversation. Its id
    // can arrive through any authoritative path (a directory poll, an observer frame,
    // a POST answer), and none of them may add it to the reader's roster.
    if (playgroundSessions.has(session.id)) return;

    const index = sessions.findIndex((candidate) => candidate.id === session.id);
    if (index >= 0) sessions[index] = session;
    else sessions.push(session);
};

// Eight characters is the same prefix the server's logs are readable by.
const shortId = (id: string): string => (id.length <= 8 ? id : id.slice(0, 8));

// Is this session's harness MISSING from the registry? R6: deleting a harness removes the
// definition only — the server never cascades into sessions — so a conversation that
// started before the delete survives as a durable record. `canonicalHarnessName` resolves a
// legacy alias to its canonical name but returns an unknown name unchanged, so "archived"
// is exactly the case where that canonical name has no descriptor: the record is intact, the
// definition is gone.
const archivedHarnessOf = (session: SessionSnapshot): string | undefined => {
    const canonical = canonicalHarnessName(session.harness, presetDescriptors);

    return descriptorFor(canonical) === undefined ? canonical : undefined;
};

// Sessions whose harness no longer exists, newest last (the directory order). They are
// listed in their own group in the sessions rail, because the rail is otherwise scoped to
// the SELECTED harness and the deleted harness has no row to be selected any more.
const archivedSessions = (): SessionSnapshot[] =>
    sessions.filter(
        (session) =>
            !deletedSessions.has(session.id) &&
            !playgroundSessions.has(session.id) &&
            archivedHarnessOf(session) !== undefined
    );

// Sessions belong to one canonical harness. The rail shows only the selected one,
// which is the "locked to selected harness" rule in R3 — opening a row can never
// silently move the reader to another harness, because no other row is offered.
//
// R8 defense in depth: a tombstoned id (`deletedSessions`) is never rendered, even
// if some other path assigned it into the cache. The authoritative filter is at the
// assignment sites (`refreshSessions`, `upsertSession`), but the RENDER projection
// is the last line of defence, so a deleted conversation cannot reappear as a row.
//
// R6: the one extra match is an ARCHIVED harness that is currently open. A deleted
// harness has no registry entry to resolve through, so its still-readable conversations
// are matched by the harness name the record itself carries.
const visibleSessions = (): SessionSnapshot[] => {
    if (selectedName === undefined) return [];

    return sessions.filter(
        (session) =>
            !deletedSessions.has(session.id) &&
            // R7: the playground's temporary session is not a conversation. The cache
            // filter above is authoritative; this is the last line of defence so a
            // temporary context can never show up as a row the reader might open.
            !playgroundSessions.has(session.id) &&
            (canonicalHarnessName(session.harness, presetDescriptors) === selectedName ||
                archivedHarnessOf(session) === selectedName)
    );
};

// T7: THE one session directory projection, shared by every surface that lists the
// reader's conversations. `renderSessions()` paints it as pills and the phone cycler
// (`paintSessionCycle`) walks it to answer "which session is next?", so the strip, the
// dialog copy and the pill can never disagree about membership or order.
//
// Selected harness first. Then (R6) the conversations of a harness the reader deleted:
// the server never cascades, and with no rail group to hold them any more they stay
// listed, flagged `archived`, exactly as reachable as before. A session already in the
// first list is skipped, so an archived harness that is CURRENTLY selected is never
// listed twice.
type SessionDirectoryEntry = { session: SessionSnapshot; archived: boolean };

const sessionDirectory = (): SessionDirectoryEntry[] => {
    const entries: SessionDirectoryEntry[] = visibleSessions().map((session) => ({
        session,
        archived: archivedHarnessOf(session) !== undefined
    }));

    const seen = new Set(entries.map((entry) => entry.session.id));
    for (const session of archivedSessions()) {
        if (session.harness === selectedName || seen.has(session.id)) continue;
        seen.add(session.id);
        entries.push({ session, archived: true });
    }

    return entries;
};

// ---------------------------------------------------------------------------
// Deleting a session (R8, T1/R1)
// ---------------------------------------------------------------------------
//
// Delete is PERMANENT. The server (src/server/api.ts DELETE /sessions/:id ->
// SessionStore.remove, src/server/sessions.ts) aborts an active run, discards the
// retained queue, closes /events watchers, and rewrites state.json without the
// record before answering.
//
// T1/R1: the inline two-step confirmation is GONE. One click on `.session-pill-delete`
// sends exactly one DELETE, because the control is a small `x` on a row the reader
// is already looking at, and the old panel cost a second click plus a rail rebuild
// for an action the reader can undo by creating a new session. The warning that the
// panel used to carry now lives on the control itself (`title` + `aria-label`), and
// the safety that mattered was never the extra click: it is the guard below plus
// `removingSessions`, which keep a delete from racing a submit/save and from being
// sent twice. There is no confirmation state left to keep module-scoped.

// Session ids with a DELETE currently in flight. Doubles as the dedupe guard: a
// second click (or a double pointer event) is a no-op.
const removingSessions = new Set<string>();

// Tombstones for ids this page has deleted. Every asynchronous path that can
// deliver an authoritative session (the 202 body of POST /tasks, a GET /events
// frame, the GET /sessions/:id polling fallback, an openSession/enqueue/model PATCH
// answer) checks this before applying anything: the server record is gone, so a
// late answer must not re-point a card at it or re-add its row (R8). Ids are
// UUIDs, so a tombstone can never hide a different, later session.
const deletedSessions = new Set<string>();

// A delete must not race an operation that owns the same conversation:
//   - `submitting` is the POST /tasks window (the run() flow),
//   - `savingAgents` is a harness/team PATCH or a session-model PATCH,
//   - a pending session creation (creatingSessions) would make "which session is
//     current" ambiguous mid-flight,
//   - and nothing may be deleted before the catalogue has booted.
// Runs themselves are NOT a reason to block: the server stops the run as part of
// the delete, which is what the control's own title warns about.
const deletionBlocked = (): boolean =>
    !booted || submitting || savingAgents || creatingSessions > 0;

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

// Send the DELETE (T1/R1: this is what ONE click on `.session-pill-delete` does). Exactly
// one request per action: the row is marked busy before the round trip, and every
// entry point re-checks the guards.
const deleteSessionRow = async (id: string): Promise<void> => {
    if (deletionBlocked() || removingSessions.has(id)) return;

    removingSessions.add(id);
    // Paint the in-flight state (the control is disabled while the request runs).
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
        // Failure: the row stays and the control is enabled again; the rail reports
        // the reason in the app pill.
        renderSessions();
        return;
    }

    forgetDeletedSession(id);
    setStatus('idle', removed ? `session ${shortId(id)} deleted` : `session ${shortId(id)} was already gone`);
};

// ---------------------------------------------------------------------------
// The pill painter (R1/T3)
// ---------------------------------------------------------------------------
//
// One directory pill replaces the old rail row. The structure is the same contract the
// row carried, renamed for the strip:
//
//   .session-pill[data-session-id][data-status][data-active][data-archived]  ← wrapper (span)
//     .session-pill-select                                                    ← open the conversation
//       .session-pill-id                                                      ← the 8-char prefix ONLY
//     .session-pill-delete                                                    ← one click = one DELETE
//
// The wrapper is a `<span>`, never a button: the two controls sit SIDE BY SIDE inside it
// (nested buttons are invalid HTML) and it exists only to carry the state attributes the
// stylesheet paints from. Selection stays in `current.sessionId`, not in this DOM.
//
// R1: only the first eight characters are VISIBLE. The full uuid, the harness and the
// status live in the `title` tooltip, so a dozen conversations still fit one wrapped row
// under the title.
const renderSessionPill = (
    session: SessionSnapshot,
    activeId: string | undefined,
    archived: boolean
): HTMLElement => {
    const pill = el('span', 'session-pill');
    pill.setAttribute('role', 'listitem');
    pill.dataset.sessionId = session.id;
    pill.dataset.status = session.status;
    // R6: an archived pill is the conversation of a harness the registry no longer has.
    // The flag is styling only (muted/dashed) — opening and deleting are the same paths.
    pill.dataset.archived = archived ? 'true' : 'false';
    if (session.id === activeId) pill.dataset.active = 'true';

    const select = el('button', 'session-pill-select');
    select.type = 'button';
    select.dataset.sessionId = session.id;
    select.dataset.status = session.status;
    if (session.id === activeId) {
        select.dataset.active = 'true';
        // T7: the highlight is only a border/background tint, and the strip is the one place
        // that states which conversation is on screen, so the relation is announced as well.
        // `aria-current` is ARIA for "this is the current item of a set"; it is written under
        // the SAME condition as `data-active`, from the SAME painter, so what a reader sees
        // and what a screen reader hears can never disagree — in the header strip or in the
        // dialog copy on a phone, both of which are rebuilt from `activeId` on every paint.
        select.setAttribute('aria-current', 'true');
    }
    // Switching conversations is refused while a run is in flight (the same lock the old
    // row carried, and the reason the rail's New session is disabled too).
    select.disabled = running;
    select.append(el('span', 'session-pill-id', shortId(session.id)));
    select.title = `${session.harness} · ${session.status} · ${session.id}`;
    // The visible text is a truncated id, so the accessible name spells the action out
    // instead of announcing eight hex characters.
    select.setAttribute('aria-label', `Open session ${shortId(session.id)}`);
    select.addEventListener('click', () => {
        // R2: a pill pressed inside the open Instruct dialog must not leave that dialog
        // describing the conversation the reader just left. No-op when it is closed.
        closeHarnessDialog();
        // Switching sessions is a view change, not a cancellation (R4).
        void openSession(session.id);
    });

    const remove = el('button', 'session-pill-delete');
    remove.type = 'button';
    remove.dataset.sessionId = session.id;
    remove.textContent = '\u00d7';
    // T1/R1 kept: one click, one DELETE, and the control's own name/tooltip carry the
    // whole permanence warning now that no confirmation surface exists.
    remove.setAttribute('aria-label', `Delete session ${shortId(session.id)}`);
    remove.title = 'Delete this session permanently. Running or queued work in it stops.';
    remove.disabled = deletionBlocked() || removingSessions.has(session.id);
    remove.addEventListener('click', () => void deleteSessionRow(session.id));

    pill.append(select, remove);
    return pill;
};

// T7: paint the phone-only cycling pill next to the Instruct title (the node and the click
// route are built in the head above). It is driven from `renderSessions()`, which every
// mutation path already calls (open, delete, new, refresh, a snapshot frame), so the pill
// follows the directory the instant it changes — and from `paintControls()`, which owns the
// busy lock the same way it owns the strip's.
//
// Three facts, all read from the SAME state the strip paints from:
//   - WHICH conversation: `current.sessionId`. No session open → the pill is `hidden`,
//     because naming nothing and cycling to "the next" of nothing would be a lie.
//   - WHAT it shows: `shortId(id)` — eight characters, like the strip. The full uuid, the
//     harness and the status are tooltip facts only, so the row stays one line wide.
//   - WHAT a press does: the next entry of `sessionDirectory()`, the strip's own projection.
// The guard is the strip's own "can I switch" rule (`submitting || running`, see
// `paintControls`), because pressing this pill calls the very same `openSession`.
const paintSessionCycle = (): void => {
    const instance = current;
    const activeId = instance?.sessionId;

    if (activeId === undefined || instance === undefined) {
        sessionCycle.hidden = true;
        sessionCycle.disabled = false;
        sessionCycleId.textContent = '';
        delete sessionCycle.dataset.sessionId;
        delete sessionCycle.dataset.status;
        sessionCycle.removeAttribute('aria-label');
        sessionCycle.removeAttribute('title');
        return;
    }

    // The record behind the pointer. Normally the directory entry itself; `instance.snapshot`
    // is the fallback for a conversation opened from a record the list read has not returned
    // yet, so the tooltip still describes what is on screen.
    const record =
        sessions.find((session) => session.id === activeId) ?? instance.snapshot;
    const harness = record?.harness ?? (instance.frozen ?? instance.descriptor).title;
    const status = record?.status ?? 'unknown';
    const short = shortId(activeId);
    // Same lock as a strip pill: switching mid-run would drop the reader out of a
    // conversation whose queue is still moving.
    const blocked = submitting || running;

    sessionCycle.hidden = false;
    sessionCycle.disabled = blocked;
    sessionCycle.dataset.sessionId = activeId;
    sessionCycle.dataset.status = status;
    sessionCycleId.textContent = short;
    // The visible text is eight hex characters, so the NAME says what the pill points at and
    // what pressing it does — the same reasoning as the strip's `Open session …` labels.
    sessionCycle.setAttribute(
        'aria-label',
        `Current session ${short}. Switch to the next session.`
    );
    // The tooltip carries what the compact pill has no room for: the harness, the server
    // status, the FULL uuid, and the action (or the reason the action is locked).
    sessionCycle.title =
        `${harness} · ${status} · ${activeId} · ` +
        (blocked ? 'wait for the run to finish before switching' : 'click to switch');
};

// The single painter for the directory. `renderSessions()` is still the only entry point
// (every mutation path already calls it), and it repaints EVERY live strip — the header
// one and, on a phone, the one inside the open Instruct dialog — from one projection, so
// the two copies can never disagree.
const renderSessions = (): void => {
    // T7: the pill beside the title is not a strip, so it is painted BEFORE the early
    // return below — with no live bar at all (a closed dialog, a phone that never opens
    // one) it still has to name the conversation on screen.
    paintSessionCycle();

    // The dialog's aggregate figures ride the SAME projection as the pills, so they are
    // repainted here: a streamed usage tally lands in `sessions` through
    // `applySnapshot`/`upsertSession`, which both route through this painter. Kept
    // narrowly scoped on purpose — only the spans inside `.harness-details-stats` are
    // replaced, so an open dialog keeps its scroll position, its focus trap and its
    // pill strip (a full `refreshHarnessDialog` rebuild on every frame would flicker
    // the whole body and reset the reader).
    paintHarnessDialogStats();

    // A closed dialog adopts its body into the overlay and removes the layer wholesale,
    // so its strip is disconnected here. Dropping it keeps the loop off dead nodes.
    for (const bar of [...sessionBars]) {
        if (bar.element.isConnected) continue;
        sessionBars.delete(bar);
    }

    const bars = liveSessionBars();
    if (bars.length === 0) return;

    const activeId = current?.sessionId;
    // T7: extracted into `sessionDirectory()` so the phone cycler walks exactly this list.
    const entries = sessionDirectory();

    for (const bar of bars) {
        if (entries.length === 0) {
            // `role="list"` promises list items; an empty strip announces a list of
            // nothing, so the hint replaces the semantics instead of riding inside it.
            bar.list.setAttribute('role', 'presentation');
            bar.list.replaceChildren(
                el(
                    'p',
                    'session-pills-empty',
                    // R1: the scope sentence ("Locked to <harness>") is gone with the rail;
                    // a strip under the harness title cannot be read as another harness's.
                    selectedName === undefined
                        ? 'Select a harness to see its sessions.'
                        : 'No sessions yet.'
                )
            );
            continue;
        }

        bar.list.setAttribute('role', 'list');
        bar.list.replaceChildren(
            ...entries.map((entry) => renderSessionPill(entry.session, activeId, entry.archived))
        );
    }
};

// True while a directory read (`GET /sessions`) is in flight. The refresh control now
// exists once per strip (header + an open dialog), so the in-flight state is a flag the
// one painter reads instead of a property written on a single button.
let refreshingSessions = false;

// One painter for the two actions every strip owns, so the header copy and a dialog copy
// can never disagree about what is clickable. `refreshSessions` also routes its in-flight
// state through here (see `refreshingSessions`) because the button now exists more than
// once.
//
// R6: a NEW session needs a harness the registry still has. An archived conversation
// (its harness deleted) is readable and can keep queuing tasks into its own record, but
// `POST /sessions` for a missing harness would only produce a server error, so the action
// is withheld rather than offered and failed.
const paintSessionActions = (): void => {
    const pending = running || current?.pending === true;
    const archivedSelection =
        selectedName !== undefined && descriptorFor(selectedName) === undefined;

    for (const bar of liveSessionBars()) {
        bar.newButton.disabled = submitting || pending || !booted || archivedSelection;
        bar.refreshButton.disabled = refreshingSessions || !booted;
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
    refreshingSessions = true;
    paintSessionActions();

    try {
        const listed = await listSessions();
        // R7: a temporary playground session that exists right now is filtered out of
        // the directory too, so the sessions strip never grows a conversation the reader
        // did not start (the id returns after cleanup, on the next refresh).
        sessions = listed.filter(
            (session) => !deletedSessions.has(session.id) && !playgroundSessions.has(session.id)
        );
        renderSessions();
    } catch (error) {
        setStatus('error', `session list: ${messageOf(error)}`);
    } finally {
        refreshingSessions = false;
        paintSessionActions();
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

    paintAgentRings(instance.activity);
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

// C5 transcript editing. The dialog owns the editor and every failure rule (local
// parse error, pending Save, the `transcript.invalid` banner); this function owns the
// PUT and the reconciliation the shell already performs for every other authoritative
// answer:
//   1. resolve the view that points at this session — an id this page does not hold is
//      a local error, so no request leaves for a conversation nobody is looking at;
//   2. send the editor's parsed value VERBATIM. A structurally invalid transcript is a
//      200 carrying `transcript.invalid`, not a failure: the write landed, and the
//      dialog keeps the text with a banner;
//   3. apply `result.session` through `applySnapshot`, which owns the stale-watermark
//      guard, the deletion tombstones, the roster/turn reconcile, the focus clear and
//      the panel repaint. That path also calls `view.setSessionSnapshot`, which
//      refreshes the open dialog from the same authority — an invalid transcript is
//      never closed by it (ui/thread-transcript.ts).
// A 409 (running thread) / 404 (unknown thread) / 400 (missing `messages`) throws with
// the server's own message via `api.ts#request`; the editor shows it and keeps the text.
const saveThreadTranscriptFor = async (
    sessionId: string,
    threadId: string,
    messages: unknown
): Promise<ThreadTranscriptPayload> => {
    const instance = [...instances.values()].find(
        (candidate) => candidate.sessionId === sessionId
    );
    if (instance === undefined) throw new Error('Unknown session');

    const result = await updateThreadTranscript(sessionId, threadId, messages);

    // The snapshot is applied even when the watermark rejects it as older than a
    // streamed frame: nothing else about the session changes, and the returned
    // `transcript` remains the newest authority for the editable value.
    applySnapshot(instance, result.session);

    return result.transcript;
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

    if (current === instance) paintAgentRings(instance.activity);
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
            // R12 (T5): keep the composer control AND the open dialog's team rows
            // truthful without a rebuild — event frames can arrive many times per
            // second, so repainting the ring is both cheaper and non-disruptive
            // (focus, the caret and open details all stay put).
            paintAgentRings(instance.activity);
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
    let descriptor = descriptorFor(harnessName);

    if (descriptor === undefined) {
        // R6: the harness was deleted AFTER this conversation started. The delete removes
        // the DEFINITION only — the server never cascades into sessions — so the record is
        // still authoritative and still opens. What it opens WITH is the definition frozen
        // inside the snapshot (the team, models and tools the run actually used), NOT a
        // registry entry: nothing is re-added to `presetDescriptors`, so a deleted harness
        // is never silently resurrected by reading one of its chats.
        const frozen = frozenDefinitionOf(session);

        if (frozen === undefined) {
            // No frozen definition to rebuild from (a legacy record whose harness is also
            // gone): the honest answer is still an error, not a invented descriptor.
            setStatus('error', `unknown harness "${session.harness}"`);
            return;
        }

        descriptor = frozen;
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

    // R6: for an archived harness this passes the frozen definition, because the registry
    // has no entry to look up. The instance key is the record's own harness name, so the
    // conversation is scoped to itself and no harness row appears in the rail.
    selectHarness(descriptor.name, descriptor);
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

    // R6: the button is disabled for an archived harness, and this guard keeps a
    // programmatic call from starting a session the server cannot resolve.
    if (descriptorFor(instance.descriptor.name) === undefined) return;

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

    // R1 (T3): the session strip paints its own New/Refresh actions from one place
    // (`paintSessionActions`), because the control now exists once per strip: the header
    // copy plus the copy inside an open Instruct dialog on a phone. The rules are the
    // ones the rail buttons carried before.
    paintSessionActions();
    createHarnessButton.disabled = submitting || pending || !booted;

    // Harness/session switching is allowed while work is pending (R4): the queue
    // is server-owned, so leaving a conversation never stops it; the observer is
    // simply unsubscribed and reopened when the reader returns.
    for (const button of harnessButtons.values()) button.disabled = submitting || !booted;
    // R6: the delete control is a write, so it is locked by the same conflicting
    // windows (`harnessDeletionBlocked`) plus its own in-flight row. The click handler
    // re-checks, so this is only the visible state.
    const harnessDeletionsBlocked = harnessDeletionBlocked();
    for (const [name, button] of harnessDeleteButtons) {
        button.disabled = harnessDeletionsBlocked || removingHarnesses.has(name);
    }
    for (const button of toolTabButtons.values()) button.disabled = submitting || pending;
    // R3: the global tools toggle is locked while a run is pending, like the tabs it
    // replaced; leaving the transcript of a streaming queue is not offered. It is also
    // locked before boot has a catalogue (`booted`) and after `showOffline` disables it.
    toolsToggle.disabled = submitting || pending || !booted;

    // R1/T3: pills replace the rail rows, and an archived conversation's pill is the same
    // control, so the busy-state pass walks every live strip instead of two lists.
    //
    // Opening a conversation stays locked while a run is in flight OR while a submit is in
    // its enqueue window: the pill is built with `disabled = running`, and this pass is
    // what keeps that lock honest after a repaint that did not rebuild the strip.
    const deletionsBlocked = deletionBlocked();

    for (const bar of liveSessionBars()) {
        for (const select of bar.element.querySelectorAll<HTMLButtonElement>('.session-pill-select')) {
            select.disabled = submitting || running;
        }

        // R8: deletion is a write, so it is disabled for the same conflicting windows
        // that lock submits/saves (and for a pill whose own DELETE is in flight). The
        // click handler re-checks `deletionBlocked`, so this is only the visible state.
        for (const button of bar.element.querySelectorAll<HTMLButtonElement>('.session-pill-delete')) {
            const id = button.dataset.sessionId;
            button.disabled = deletionsBlocked || (id !== undefined && removingSessions.has(id));
        }
    }

    // T7: the phone cycler opens a conversation through the very same `openSession` a strip
    // pill uses, so it carries the very same lock. Repainting it HERE (not only from
    // `renderSessions`) is what keeps it honest when a run starts or ends without the
    // directory changing — the same reason the strip's buttons are re-walked above.
    paintSessionCycle();

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
        // R4 (T4): the settings are no longer a rail disclosure, so the wording names
        // the dialog the reader has to open (the top-right status pill).
        instance.view.notice('set a base URL in Endpoint & model, then run again');
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
    //
    // `target.threadId` here is the DRAFT binding only: it is what the composer keeps
    // steering and what the badge shows until the record lands. It is NOT placement
    // authority — ui/turns.ts `placementThreadIdOf` puts the row in the conversation
    // the RECORD names, so a thread-less server command turn (a `/…` line this same
    // path submits) reads at board level live exactly as it does after a reload.
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

// Keyboard contract (R1 + T1). The send button is the primary path; the keyboard only
// mirrors it, EXCEPT while an @/# popup is open (UniversalTextBox parity) or while a
// chip's own control has focus:
//   chip × focused   -> EVERY Enter (any modifier) is left to the browser: it activates
//                         the button, which removes that one chip (T3/D1). Nothing here
//                         prevents it and nothing sends.
//   popup open + ArrowDown/ArrowUp -> move the active row
//   popup open + Enter or Tab      -> pick the active row (never submit/newline)
//   popup open + Escape            -> close the popup
//   Enter (fine pointer)         -> SEND (T1/R2). The default is prevented so the
//                         keystroke never also inserts a line break; `run()` keeps
//                         every existing guard, so an empty/unfinished draft is simply
//                         refused rather than POSTed.
//   Enter (coarse/unknown)       -> native newline, NEVER prevented and NEVER submits
//                         (T1/R1 + T3). An on-screen keyboard has no dependable Shift, so
//                         the field stays a multiline editor and the button is the send
//                         path; `(pointer: none)` and a missing `matchMedia` are unknown
//                         input, so they keep this non-destructive half of the matrix.
//   Shift+Enter        -> native newline on EVERY device (T1/R2). Shift is the explicit
//                         "I want a line break" modifier and always wins.
//   Alt+Enter          -> native newline (also unchanged: Alt is a content modifier).
//   Ctrl+Enter, Cmd+Enter -> explicit send shortcut, kept on EVERY device (R3). It still
//                         wins over the popup, so a reader can queue the task without
//                         picking a suggestion, and on a touch keyboard it is the only
//                         keyboard send.
//   IME composition    -> ignored entirely: the Enter that confirms a candidate
//                         belongs to the input method, so it must not submit and must
//                         not be prevented (`isComposing`, plus keyCode 229 for older
//                         engines that only report the legacy marker). This guard stays
//                         FIRST, ahead of the T1 send path, which is exactly why a
//                         desktop Enter cannot fire mid-composition.
// The button is the form's own submit button, so a click arrives through the `submit`
// listener above; every keyboard send here calls `run()` directly (it prevents the
// default, so no submit event fires). Both converge on the same `run()` body, so
// queueing while a run is in flight (R4) stays identical.
input.addEventListener('keydown', (event) => {
    // IME guard first: no composition key may reach the popup or send logic.
    if (event.isComposing || event.keyCode === 229) return;

    // T3/D1: keyboard ownership for a chip's × remove button. That button is a real
    // <button> INSIDE the contentEditable field (ui/editor.ts:380-386), so its keydown
    // events bubble through this field listener and this handler must decline them:
    //   - Enter (with ANY modifier, conservatively) belongs to the focused button, which
    //     the browser activates natively and removes exactly that one chip. Claiming it
    //     here would `preventDefault` the activation away and send the WHOLE draft
    //     instead, so one keystroke would post an unintended task and lose nothing;
    //   - the guard therefore runs BEFORE the popup and send branches below, so neither
    //     an open suggestion list nor the T1 desktop policy can steal the keystroke;
    //   - Backspace/Delete at the button stays the field's atomic chip delete (the
    //     `fromRemoveButton` guard in that branch keeps its old meaning).
    const fromRemoveButton =
        event.target instanceof HTMLElement &&
        event.target.closest('[data-chip-remove]') !== null;

    if (event.key === 'Enter' && fromRemoveButton) return;

    const sending = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;

    // T1/R2: a bare Enter sends only on a device whose primary pointer is fine (a real
    // keyboard is attached, Shift is reachable). Shift and Alt are content modifiers, so
    // they suppress the send and leave the native newline; `sending` already covers
    // Ctrl/Cmd, and the popup handling below still outranks a bare Enter (R3).
    const enterSends = !sending && !event.shiftKey && !event.altKey && hasFinePointer();

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

            // R3: the open suggestion list owns Enter. When there is nothing to pick yet
            // (no match, or the @ lookup is still in flight) a bare Enter stays a native
            // newline on EVERY device, so the T1 desktop send can never fire in the
            // middle of a mention. Tab deliberately falls through to the browser.
            if (event.key === 'Enter') return;
        }
    }

    // Only Enter is a send candidate here; every other key (including Tab out of a popup
    // that had nothing to pick) is left to the browser.
    if (event.key !== 'Enter') return;

    // T1 send matrix, evaluated once the popup no longer owns the keystroke:
    //   `sending`     -> the explicit Ctrl/Cmd+Enter shortcut, every device (R3), with
    //                    Shift/Alt excluded because they are content modifiers;
    //   `enterSends`  -> a bare Enter on a hardware keyboard (R2).
    // Everything else (touch Enter, Shift+Enter, Alt+Enter) returns here and inserts a
    // native line break. Preventing the default BEFORE `run()` is what stops the
    // newline that would otherwise be left behind in the field; `run()` still applies
    // its own guards (empty draft, enqueue window, in-flight attachment read, no
    // session/endpoint), so a send that cannot happen is a no-op, never a bad POST.
    if (!(sending || enterSends)) return;

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
    if (current === instance) paintAgentRings(instance.activity);

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
// every keyboard send take the existing run() path, queueing included); only
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
leftRail.append(harnessHead, harnessList, createPanel.element, leftPanels.element);

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

// R1 (T3): New session and Refresh are wired inside `createSessionPillBar` — the strip
// exists once in the header and (on a phone) once per open Instruct dialog, so a single
// module-level listener could no longer reach both copies.

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

    // R7: the playground's temporary session must not outlive the page. This is
    // BEST EFFORT by construction — `keepalive` gives the DELETE a chance to leave,
    // but a background-kill can still drop it, and nothing here may block the unload.
    // The worst case is one orphan conversation in the roster after a reload, which the
    // reader can delete like any other session.
    releasePlaygroundSession({ unload: true });

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
    //
    // A static host (GitHub Pages) has no API of its own, so the client walks its
    // compiled local/LAN chain (./deployment.ts) and keeps the first gateway that
    // answers. Naming every candidate BEFORE the probe starts is what makes a slow
    // boot legible instead of looking like a hang on one host; an empty list means
    // the root is pinned, so exactly one host is contacted.
    const candidates = apiRootCandidates();

    box.append(
        el('h2', 'empty-title', 'Connecting to the harness server…'),
        el('p', 'empty-text', `Contacting ${API_ROOT.length > 0 ? API_ROOT : '(origin)'}…`),
        ...(candidates.length > 1
            ? [el('p', 'empty-text', `Trying in order: ${candidates.join('  →  ')}…`)]
            : []),
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

    // On a static host the failure is "none of the compiled servers answered", and
    // the single root in `message` would hide which hosts were eligible. Listing the
    // chain is the actionable part: it tells the reader which machine to start the
    // service on (or which one to point `?apiRoot=` at).
    const candidates = apiRootCandidates();

    box.append(
        el('h2', 'empty-title', 'Harness server unavailable'),
        // The server/proxy text is rendered with textContent by `el`, so an error
        // page or a hostile response body can never inject markup here.
        el('p', 'empty-text', message),
        el(
            'p',
            'empty-hint',
            candidates.length > 0
                ? `This page is hosted on a static host, so it dialed its own chain of harness servers in order — ${candidates.join(', ')} — and none answered. Start the service on one of those machines (\`yarn start-service\`, /v1/harness on :5000) and Retry, or open the UI from the server itself. A plain-HTTP LAN address can also be blocked by the browser as mixed content on an HTTPS page; \`?apiRoot=\` pins one host instead.`
                : 'Start the API with `yarn start-service` (repo root, /v1/harness on :5000), then reload. `yarn dev:frontend` is the Vite UI only; it does not start an API.'
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
        createHarnessButton.disabled = false;

        if (presetDescriptors.length === 0) {
            showOffline('The server reported no harnesses.');
            setStatus('error', 'no harnesses');
            return;
        }

        booted = true;
        // R1 (T3): New/Refresh live in the pill strips, and their enabled state is derived
        // from `booted`, so this runs AFTER the flag flips (the rail used to force the two
        // buttons on directly). With no harness at all the strips stay disabled, which is
        // the truth: `newSession` has nothing to start a conversation from.
        paintSessionActions();
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

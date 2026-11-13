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
// A FIRST load is not local state (T21): the app opens the most recently used
// conversation of the harness it lands on (`initialSession`, ranked by the
// server's `updatedAt`/`createdAt` and then by directory order), and it opens it
// with EVERY thread collapsed — nothing expands until the reader clicks a card
// (`View.collapseForLoad`, ui/turns.ts).
//
// Shell (three columns, R21):
//   - left rail  — harnesses (built-ins and user-created) plus the create form and
//                  the `left` tool-panel host. The endpoint/model settings are NOT
//                  here any more (R4/T4): they open from the top-right status pill;
//                  the rail's width is the reader's: a `role="separator"` seam on its
//                  inner edge drags it (ui/rail-resize.ts) and nothing is saved, so a
//                  reload is back to the stylesheet default;
//   - centre     — the selected harness title with the compact SESSION CYCLER and its `+`
//                  beside it (T9: one pill names the conversation on screen and steps to
//                  the next one, and the `+` starts a fresh conversation; the saved-
//                  conversation dashboard with New/delete lives in the dialog the title
//                  button opens, at every width), the `center` tool-panel host, the
//                  transcript and the composer. The
//                  composer is ONE bordered frame
//                  with a notched routing label on its top border (R14), the single
//                  agent button on its LEFT edge (R16, opens the shared agent dialog
//                  — team, models and instructions) and stop/send on the right. The GLOBAL tools view (the
//                  full-width list of EVERY server tool — core entries included)
//                  replaces this column when the icon-only Tools toggle on the harness
//                  title row is pressed; activating one entry opens its manual runner in
//                  the shared modal. There is no tab strip (R3);
//   - right rail — the tool-contributed SCRATCH BOARD (primary panel host), and nothing
//                  else since T3/R1 moved the session directory out of it (T9 keeps that
//                  directory in the title dialog). It is resizable from its own seam,
//                  like the left rail. On a
//                  phone it opens from the floating `.scratch-fab` (T3/R3), and since T8
//                  it opens in the SAME left-hand sidebar slot as the harness drawer: the
//                  phone has one sidebar, showing whichever trigger was pressed last.
//
// R21.2 removed the right rail's core-tools dropdown and tool catalogue. They
// duplicated the tools view, which is now the single place to review and call
// tools; the enabled-for-session status that used to sit next to that list is gone
// too (R3), so the pane is its heading plus the grid and one enablement live line.
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
// Run/cancel is single-flight and instance-scoped: the composer's stop action is painted
// from, and cancels, the SELECTED conversation (`stopRun` reads `current`), never "whatever
// worked last". A run locks the TEAM edit, the harness create and the harness delete; it
// does NOT lock harness or session switching, because leaving a working conversation is an
// unsubscribe, not a cancel (R4). Model edits are not a team edit: PATCH /sessions/:id
// applies to the next request without cancelling the stream (R2).
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
    SessionThread,
    SessionTurn,
    SessionView,
    SessionViewStreamItem,
    SessionViewSummary,
    ToolDescriptor
} from '../server/protocol';
import type { HarnessUsage } from '../types';
import type { DisplayStep, TurnDisplayOp, TurnSummary, TurnStepDetail, TurnBlockDetail } from '../shared/turn-display';
// The pending-tool figure a cold display tree states per section (./view-api.ts
// `readTurnDisplayWithPending`), seeded into the store as the `pending:set` ops it
// would have arrived as on a live connection.
// `AgentProfile` is the payload of the identified catalogue read (see
// `loadAgentPresetTexts`): the ONLY response that states an agent's preset
// instruction text, because `GET /agents` rows are text-free summaries
// (../shared/harness-api.ts:552-563).
import type { AgentProfile, HarnessInstructionSummaryEntry, HarnessPendingTool, PluginSetting, PluginSummary, TaskReceipt, ToolDetail } from '../shared/harness-api';
// The display wire (T5) is the shell's DEFAULT surface: every fetch, every stream
// and every submit below speaks `/views`, so no round trip on this path can carry a
// recorded event. The raw client (./api.ts) stays imported for the catalogue routes
// (`/harnesses`, `/tools`, `/models`) and for the explicit export read, which is the
// ONLY place `HarnessEvent`s reach this browser.
import {
    answerViewAction,
    cancelView,
    cancelViewThread,
    createView as createViewSession,
    createDisplayPlane,
    deleteView,
    deleteViewOnUnload,
    deleteViewThread,
    getRawSession,
    getStepDetail,
    getBlockDetail,
    getView,
    listViews,
    observeTurn,
    observeView,
    // T3: the per-thread live plane — one `thread`-scope subscription per conversation the
    // reader opened (./view-shell.ts `observeThread`) and the bounded queue that reads THAT
    // thread's transcript (./view-api.ts `createThreadTranscriptLoader`).
    observeThread,
    createThreadTranscriptLoader,
    resetView,
    resumeViewThread,
    submitViewTask,
    updateThreadTranscript as updateViewThreadTranscript,
    updateView
} from './view-shell';
import type { DisplayPlane, ThreadTranscriptLoader, ViewStreamItem } from './view-shell';
// The connection the observation rides. The shell asks it ONE question, when an observation
// ends: is there a transport at all? `closed` means nothing will ever arrive on a
// subscription (no factory and no `WebSocket`, stream.ts:193-199 and :459-467), which is the
// state where the bounded poll — not a one-off re-read — is the observation (see
// `startWatching`). Accessing the singleton here cannot dial anything: `harnessStream()` only
// creates the client the first time, and the observer above already did.
import { harnessStream } from './stream';
// The lazy payload reads the display plane needs: one turn's tree (the focused
// subscription's resync recovery), the out-of-band pending figure a cold tree states,
// and the frozen definition — the only remaining source of a conversation's
// discovered toolbox, read when the tools surface opens (./view-api.ts header).
// `sessionRowOf` is the SAME row normalizer the directory page uses (./view-api.ts:159):
// the boot document embeds `SessionSummary` rows in the contract's snake_case spelling, and
// casting them into `SessionRecord` left `createdAt`/`updatedAt`/`queueDepth` undefined.
import {
    readDefinition,
    // T46: the archived reopen's descriptor (./view-api.ts `frozenDescriptorOf`).
    frozenDescriptorOf,
    readTurnDisplay,
    readTurnDisplayWithPending,
    // T52: the bounded ROW re-read a submit receipt cannot replace (./view-api.ts
    // `readTurnRow`): a steer's text and a brand-new thread's label live only on the row.
    readTurnRow,
    // T38: the details dialog's lazy per-conversation usage fold (./view-api.ts:850).
    readUsage,
    sessionRowOf,
    // T3: the invalid-transcript roster is DERIVED from the roster rows (an unreadable
    // transcript is a property of the row), so a single-row patch re-derives it exactly the
    // way `openSession` does.
    invalidThreadsOf,
    type ThreadRow
} from './view-api';
import {
    activeAgentsOf,
    applyOpsToActivity,
    // T46: the one session-patch merge rule (./view-state.ts), so the shell's header path and
    // its test assert the SAME field set.
    applySessionPatch,
    createViewStateStore,
    displayOf as viewDisplayOf,
    isPendingView,
    panelEntriesOf,
    stepIndex,
    summariesOf,
    transcriptTurnIdsOf,
    // T49: the one row-merge rule (./view-state.ts:730) — the same guard the stream's row ops
    // use, so a receipt row and a `turn.upsert` frame cannot fight over one tile.
    upsertSummary,
    type ViewStateStore
} from './view-state';
// The unwrap of ONE lazy step detail (explicit clicks only): the panel expansion and
// the tool chip's detail loader are its only callers.
import { stepDetailPayloadOf } from './view-detail';
import type { HarnessActionChoice, HarnessActionRequest, HarnessAttachment } from '../types';
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
    descriptorOf,
    deleteSession,
    deleteSessionOnUnload,
    deleteSessionThread,
    getSession,
    listProviderModels,
    listSessions,
    loadBootstrap,
    // The UI-level harness server URL (its own storage key, separate from the provider
    // settings below): read to prefill the dialog field, written by Apply.
    // `normalizeApiRoot` is the SAME validator `saveApiRootSetting` runs, imported so Apply
    // can decide "did the reader actually change the root?" WITHOUT writing (an untouched
    // field must not turn the automatic root into a stored override).
    normalizeApiRoot,
    saveApiRootSetting,
    storedApiRoot,
    updateHarness,
    getHarness,
    // T32: the one member's effective instruction text, asked for only when the definition's
    // summary says THIS harness supplies that prompt (./api.ts:689).
    getHarnessInstructionText,
    // The identified profile read: the only response that carries an agent's PRESET
    // instruction text and its guideline rules (./api.ts:701). Asked for when the
    // configuration dialog needs that text, exactly as `getTool` is asked for when a
    // tool is opened (T50).
    getAgent,
    // T7 (R2/R3): the plugin catalogue read and the ONE write the Plugins pane makes.
    // `listPlugins` is `GET /plugins` (every auto-scanned built-in, its declared
    // settings and the effective values), `updatePluginSettings` is
    // `PATCH /plugins/{id}` (settings-only; the answer is the whole row).
    listPlugins,
    updatePluginSettings,
    // T7b (R5/R6/R7): the SESSION-scoped roster surface. A saved conversation owns its own
    // members, their models and their complete prompts, and these are the only routes that
    // read or write them (`GET/POST /sessions/{id}/agents`,
    // `PATCH/DELETE /sessions/{id}/agents/{agent}`, plus the per-agent instruction read used
    // to seed the dialog's one box with the LIVE text).
    createSessionAgent,
    deleteSessionAgent,
    getSessionAgentInstruction,
    listSessionAgents,
    updateSessionAgent,
    updateSession,
    // T50: the identified catalogue read (argument schema + execution scope) and the row
    // mapper it shares with the page. A `ToolSummary` row has no schema; this is the read
    // that supplies one, asked for only when a tool is opened.
    getTool,
    // R3: the ONE global write a catalogue entry has — `PATCH /tools/{id}` with
    // `{ enabled }`, answered by the whole updated row. The Tools pane's switch is its
    // only caller, and the write is anytime (no idle window on the server).
    updateToolEnabled,
    toolRowOf
} from './api';
import type { HarnessBootstrap } from './api';
import type { SessionView as RenderSessionView, ThreadTranscriptPayload, TurnRowView } from './view-model';
import {
    agentColorsOf,
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
// T4/R1-R3: the ONE place that teaches the page who the team is and which identity wears
// an explicit colour. Every surface (composer button, dialog badges, transcript tiles)
// reads the module state configured here, so the shell must configure it BEFORE it paints.
import { configureAgentColors, resetAgentColors } from './ui/agent-color';
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
    filesListEntriesOf,
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
import { looksLikeJson, prettyJson } from './ui/markdown';
// The one payload viewer every dialog surface uses (ui/tools.ts). The runner's response
// box used to hand-roll `highlightCode` into a bare `pre.card-body`, which lost its wrap
// to `ui/dialog.css .dialog-body pre { white-space: pre }`. `paintCodeBlock` is the
// matching repaint: a persistent box keeps its ONE node and only its rows change.
import { createPayloadViewer, paintCodeBlock } from './ui/tools';
import { applyPanels, createPanelHost, mediaOfTurns, panelKeyOf, mediaOfSummaries } from './ui/panels';
import type { PanelHost, PanelMedia, PanelSlot, PanelSummarySource } from './ui/panels';
// The plug-and-play panel seam (T5/R1). The shell keeps its hosts and its paint
// call-sites, and delegates what a panel LOOKS like (a registered panel KIND) and
// what ELSE sits in a host (a registered SHELL PANEL) to this subsystem. With nothing
// registered the board paints exactly as this file always did — and this file DOES
// register two: the live Tasks and Records panels (./extensions/records-panels.ts),
// which is the feature those seams exist for.
import { createPanelRuntime, registerBuiltinShellPanels } from './extensions';
// The two draggable seams between the chat column and the rails (styles.css
// `.rail-resizer`). They drive the shell's outer grid tracks and store nothing, so a
// reload repaints the stylesheet's default rail widths.
import { createRailResizers } from './ui/rail-resize';
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
    // The local basalt model: the id the gateway above serves for it, and the model
    // every preset agent shows in the deck when it has no per-agent override.
    model: 'local/basalt'
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

// ---------------------------------------------------------------------------
// Endpoint dialog DRAFT (the settings dialog is draft-then-apply)
// ---------------------------------------------------------------------------
//
// `settings` above is the COMMITTED record: it is what `POST /sessions` serializes, what
// `defaultSessionModel()` names and what `localStorage` holds. The Endpoint & model dialog
// never writes it directly — its fields show `endpointDraft`, a copy taken from the
// committed record every time the dialog opens (./main.ts `syncEndpointDraft`). Pressing
// `Apply` is the only thing that copies the draft back into `settings`, because dismissal is
// the discard: `ui/dialog.ts` already provides ×, Escape, a backdrop click and a second pill
// press, and "I clicked outside" must mean "nothing changed". Without a draft, every
// keystroke would persist and the dialog would need a second button to undo itself.
//
// The draft is also what the model-catalogue PREVIEW dials (./main.ts `refreshModels`), so
// pasting a base URL shows what that endpoint serves while still writing nothing.
//
// It is a module-scoped copy rather than dialog state because the settings pane is a
// PERSISTENT node that outlives the layer hosting it (R4/T4): boot paints it
// (`applyDefaults` → `syncEndpointDraft`, `refreshModels`) whether or not anything is open.
let endpointDraft: RunnerSettings = { ...settings };

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

// T29: `discoveredTools` is the ONE figure the compact session row stopped publishing
// (./view-model.ts header: the canonical open carries metadata + rows + trees, and the
// frozen definition is a separate lazy read). `GET /sessions/{id}/definition` is its
// remaining source, so it is read when a surface that SHOWS it opens — the tools view,
// the playground note, the agent dialog — never at boot, never on the transcript path,
// and at most once per conversation (the promise is the cache).
//
// A failed read is cached as "nothing to report": the note omits its `enabled there`
// clause rather than inventing a toolbox, and the entry is dropped so a later open can
// ask again.
const discoveredReads = new Map<string, Promise<string[]>>();

const discoveredToolsOf = (sessionId: string, refresh = false): Promise<string[]> => {
    const cached = discoveredReads.get(sessionId);
    if (cached !== undefined && !refresh) return cached;

    const read = readDefinition(sessionId)
        .then((definition) => (Array.isArray(definition.discovered_tools) ? [...definition.discovered_tools] : []))
        .catch(() => {
            discoveredReads.delete(sessionId);

            return [];
        });

    discoveredReads.set(sessionId, read);

    return read;
};

// T46: the FROZEN TEAM of a conversation whose harness is gone.
//
// WHY A READ IS NEEDED AT ALL: the canonical session DTO carries `definition_revision`
// only (../shared/harness-api.ts `SessionResource`), so after `DELETE /harnesses/:name`
// the browser holds no team, no per-agent models and no tool list for that record — and
// `openSession` used to answer "unknown harness" and refuse the conversation outright,
// which made an archived session unreopenable (the exact R6 parity this closes).
//
// WHY THIS IS THE CHEAP SHAPE:
//   - it is LAZY: `openSession` calls it only when the registry has no descriptor AND the
//     document carries no frozen team, so an ordinary open costs zero extra reads;
//   - it is ONE identified read (`GET /sessions/:id/definition`), deduped per conversation
//     like `discoveredToolsOf` above, so a pill click plus the tools surface cannot cost
//     two, and a failed read is dropped so a retry can still land;
//   - it never writes `presetDescriptors` (a deleted harness must not reappear as a rail
//     row) and never pulls the per-agent instruction TEXTS — the definition resource
//     carries the override map, the prompts stay the agent dialog's own reads.
const frozenReads = new Map<string, Promise<HarnessDescriptor | undefined>>();

const readFrozenDefinition = (sessionId: string): Promise<HarnessDescriptor | undefined> => {
    const cached = frozenReads.get(sessionId);
    if (cached !== undefined) return cached;

    const read = readDefinition(sessionId)
        .then((definition) => frozenDescriptorOf(definition))
        .catch(() => {
            frozenReads.delete(sessionId);

            return undefined;
        });

    frozenReads.set(sessionId, read);

    return read;
};

// T50: the frozen team must reach the PAINT, not only the dialog that edits it.
//
// The canonical document states `definition_revision` only (../shared/harness-api.ts
// `SessionResource`), so a saved conversation whose harness is STILL registered arrives with
// no team of its own, and `agentViewOf` falls through to `instance.descriptor` — the LIVE
// preset. That is the exact bug `frozenDefinitionOf` exists to prevent (./contract.ts:273:
// "the frontend renders that descriptor, never the live one, so an edited harness cannot
// rewrite a conversation that is already on screen"): the roster, the model selects and the
// dialog tabs described whatever the harness is TODAY, so a saved team of two painted as
// one and the per-agent model selects had no member to hold their value.
//
// Cost stays bounded and lazy, which is the rule this file follows everywhere:
//   - one identified read per conversation (`readFrozenDefinition` dedupes and remembers a
//     failure so a retry can still land), fired from the OPEN path only;
//   - skipped entirely when the team is already in hand (the document carried one, or the
//     dialog's own read answered first);
//   - the answer is cached in `frozenDefinitions`, so every later document for this
//     conversation re-derives the SAME team through `frozenTeamOf` instead of wiping it;
//   - the repaint is guarded: a late answer for a conversation the reader left paints
//     nothing, and an open dialog refreshes through the existing signature-forced path.
const hydrateFrozenTeam = (instance: Instance): void => {
    const sessionId = instance.sessionId;
    if (sessionId === undefined || instance.frozen !== undefined) return;

    void readFrozenDefinition(sessionId).then((frozen) => {
        if (frozen === undefined) return;
        // Stale guards: the reader moved on, or another surface (the dialog's own read)
        // already established this conversation's team in the meantime.
        if (instance.sessionId !== sessionId || instance.frozen !== undefined) return;

        frozenDefinitions.set(sessionId, frozen);
        instance.frozen = frozen;

        if (current !== instance) return;

        // The chrome and the dialog both read `instance.frozen`; nothing here re-opens a
        // dialog the reader never asked for.
        refreshAgentDialog(agentViewOf(instance), instance, true);
    });
};

// The tools view's lazy read, fired when the view OPENS (never at boot):
//   - the selected conversation's discovered toolbox lands on the render document,
//     which is where every renderer reads `SessionView.discoveredTools`;
//   - the `enabled there` figure of the PLAYGROUND session is recorded on
//     `playground.discovered` (`refresh: true` after a tool call so a fresh discovery
//     shows up). The tools pane no longer renders a context note, so this is state the
//     runner carries, not a paint.
// Both are guarded on their own conversation, so a late answer cannot paint another
// session's toolbox, and each costs at most one read per conversation.
const hydratePlaygroundDiscovered = (refresh = false): void => {
    const playgroundSession = playground.sessionId;
    if (playgroundSession === undefined) return;

    void discoveredToolsOf(playgroundSession, refresh)
        .then((names) => {
            if (playground.sessionId !== playgroundSession) return;

            playground.discovered = names;
        })
        .catch(() => undefined);
};

// The conversation-level lazy read, fired by the surface that shows THIS conversation's
// frozen team and toolbox: the agent/configuration dialog. `GET /sessions/{id}/definition`
// is the only route that still answers `discoveredTools` (the compact row stopped
// publishing it, ./view-model.ts:113-116), and the same answer carries the member set,
// models and per-agent overrides the dialog edits — so one read feeds the whole surface,
// cached per conversation, and a chat that is only being read never pays for it.
const hydrateSessionDefinition = (instance: Instance | undefined, refresh = false): void => {
    const sessionId = instance?.sessionId;
    const document = instance === undefined ? undefined : renderDocument(instance);

    if (instance === undefined || sessionId === undefined || document === undefined) return;

    void discoveredToolsOf(sessionId, refresh)
        .then((names) => {
            // Stale guard: the reader left this conversation while the read ran.
            if (instance.sessionId !== sessionId) return;

            document.discoveredTools = names;
            instance.discovered = names;

            const frozen = frozenDefinitions.get(sessionId);
            if (frozen !== undefined) instance.frozen = frozen;
        })
        .catch(() => undefined);
};

// T29: the frozen team of one conversation, cached per conversation. The canonical
// document carries no `harnessDefinition` (./view-api.ts:6-29), so the team is recorded
// here whenever the conversation-level definition read runs (the agent/configuration
// dialog), and every later document for the same conversation re-uses that answer instead
// of wiping the team it reopened with.
//
// What this cache deliberately does NOT do: invent an ARCHIVED harness's team out of a
// document that never captured one.
//
// T46: the archived REOPEN does read the conversation's frozen definition — but only as an
// answer, never as a guess. The refusal case above is decided on that answer being absent
// (the shared fixture now 404s a record with no frozen definition instead of naming one
// after `host.harness`, so a legacy record cannot fabricate a team), and the answer is
// cached here so `applyView` keeps describing THIS conversation.
const frozenDefinitions = new Map<string, HarnessDescriptor>();

// T46: the header label of an ARCHIVED conversation (see `openSession`). The registry has no
// card to take a display title from, so the harness the record itself names is the label —
// stated the way a card title looks, which is the only thing the reader can act on. The
// internal key stays internal: `.harness-id` is blanked and hidden by `renderHarnessChrome`.
const archivedHarnessLabel = (harness: string): string => {
    const name = harness.trim();

    return name.length === 0 ? name : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

// The one read a conversation's frozen team comes from: the document's own field when a
// producer published it, otherwise the cached definition answer.
const frozenTeamOf = (session: { harnessDefinition?: HarnessDescriptor; id: string }): HarnessDescriptor | undefined =>
    frozenDefinitionOf(session) ?? frozenDefinitions.get(session.id);

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
    // R3c: `scroll` (default false) is this view saying "the reader asked for it" — the
    // board then moves that conversation into view. A background path leaves it off.
    focusThread: (threadId: string, scroll?: boolean) => boolean;
    // Explicitly drop the steering target (deleted thread, session teardown). Unlike
    // a tile toggle this is never a user intent to open a new thread, but it must
    // still stop the next submit from targeting the removed id (S3).
    clearFocus: () => void;
    // T21 R22: land on a LOADED conversation with EVERY thread collapsed. The board's
    // first-content rule opens the newest surface once (ui/turns.ts `reconcileView`
    // `!hadTurns`, and `pendingFirstFocus` after a session switch); a load is not the
    // reader asking to read a thread, so the shell drops that expansion immediately.
    // It routes through the board's own `collapse`, which also marks the unfocus
    // deliberate (`explicitUnfocus`), and that is what keeps every later stream,
    // snapshot and poll frame from re-opening anything — only an explicit click on a
    // `.tile-select`/`.thread-row` expands again.
    collapseForLoad: () => void;
    // Hand the authoritative persistent-thread roster to the board. Repeated turns
    // of one thread share a badge in the transcript, so a conversation is never
    // presented as several independent threads. (The former strip also rendered
    // these rows; it is gone, and this is the only consumer.)
    setThreads: (threads: readonly SessionThreadEntry[]) => void;
    // T3: the conversations this view is SHOWING (expanded cards + the focused one), and
    // the transcript document the shell read for one of them. Same pair the board exposes
    // (./ui/turns.ts `TurnBoard`); the shell pulls after a roster lands, because that is
    // when an id becomes a real conversation it may follow.
    followedThreads: () => readonly string[];
    setThreadTranscript: (threadId: string, payload: ThreadTranscriptPayload | undefined) => void;
    // R7: the tombstone-filtered raw snapshot the JSON transcript copies. Reached by
    // an EXPLICIT export read only (T5 R3); `undefined` until the reader opens a
    // transcript, and on session teardown.
    setSessionSnapshot: (snapshot: SessionSnapshot | undefined) => void;
    // T5 R1: the COMPILED document the shell applied. Roster joins, delete
    // protection and the transcript fallback read their rows from here, so none of
    // the default surfaces needs an event list.
    setSessionView: (view: SessionView | undefined) => void;
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
    // --- display-wire path (T5: R1/R2/R3) --------------------------------
    //
    // The same list/focus rules, fed by the COMPILED document instead of recorded
    // turns. These are the DEFAULT surfaces; `hydrate`/`reconcile`/`upsert` above
    // remain the raw compatibility path for an embedding that folds events.
    hydrateView: (view: SessionView, model?: string, keep?: string) => TurnHandle[];
    reconcileView: (view: SessionView, model?: string, keep?: string) => TurnHandle[];
    // Bind/adopt the compact row a submit answer names (a steered submit merges into
    // the tile that already owns that conversation).
    upsertSummary: (summary: TurnSummary, view?: SessionView) => TurnHandle;
    // Route one ops frame by turn id. False when this view holds no such tile.
    applyOps: (turnId: string, ops: readonly TurnDisplayOp[], view?: SessionView) => boolean;
    // Look up a tile by the server turn id carried on a stream `event` frame.
    turn: (id: string) => TurnHandle | undefined;
    // Every real block in this conversation (root+nested), oldest→newest. The
    // composer's # reference popup reads it; labels are conversation-scoped, so a
    // label names one block and the popup matches the server's resolution.
    blocks: () => AgentBlockDescriptor[];
    // Stop every live timer this view owns (elapsed labels, tool durations).
    dispose: () => void;
    // --- T24 lazy display wiring -----------------------------------------
    // Installs the shell's lazy sources once the INSTANCE exists (the plane reads
    // the instance's session id, which does not exist while `createView` runs).
    // Every board callback below delegates through this binding, so the renderer
    // still owns no network code — the same rule `readFile`/`loadStepDetail` follow.
    bindLazy: (binding: LazyDisplayBinding) => void;
    // Requests a tree for every row the reader can SEE (plus the expanded tile) and
    // repaints the "load older" affordance. Called on a document landing, on scroll,
    // and whenever an expansion changes — never once per row of loaded history.
    reveal: () => void;
    // The rows currently inside this pane's viewport, plus the expanded tile's id.
    // This is what `DisplayPlane.ensureVisible` is allowed to ask trees for.
    visibleTurnIds: () => string[];
    // The turn the reader has open right now (the focused flow subscription's key).
    expandedTurnId: () => string | undefined;
    // Re-evaluates the "load older" button (label, disabled, hidden) from the plane.
    paintOlder: () => void;
};

// The lazy sources one pane gets from the shell (T24). Declared as a type because
// `createView` closes over it BEFORE the instance exists: the binding is installed
// later by `bindLazy`, and every board callback reads it through the closure.
type LazyDisplayBinding = {
    // The instance's display plane (./view-shell.ts `createDisplayPlane`), capped at
    // 4 concurrent tree reads, deduped and generation-guarded inside.
    ensureVisible: (turnIds?: readonly string[]) => string[];
    // Walks exactly one page from the cursor the server issued.
    loadOlder: () => Promise<boolean>;
    hasOlder: () => boolean;
    loadingOlder: () => boolean;
    // The tile the reader expanded, so the shell can move its `turn`-scope flow
    // subscription to the conversation whose streamed text matters.
    focusTurn?: (turnId: string | undefined) => void;
    // T3 (R2/R3): the conversations the reader has OPEN. The shell follows exactly this
    // set with one `thread`-scope subscription and one transcript document each, and stops
    // following an id the moment it leaves the set.
    followThreads?: (threadIds: readonly string[], sessionId: string | undefined) => void;
    // An owner question as the COMPACT wire sees it: answered synchronously from the
    // session's live pending actions, so a card carries the REAL recorded options
    // (./ui/turns.ts:513). Undefined = not pending, which the lazy read below settles.
    requestFor?: (step: DisplayStep) => HarnessActionRequest | undefined;
    // A settled/historical card's choices: ONE step-detail read for the verbatim
    // `action_request` opening event.
    loadRequest?: (step: DisplayStep) => Promise<HarnessActionRequest | undefined>;
    // The read above landed: the shell repaints that ONE tile from the compiled
    // document so the card mounts with its recorded options.
    actionHydrated?: (turnId: string) => void;
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
    // T3 (R1): the thread the reader opened travels with the request, so the shell composes
    // THAT conversation's document instead of one per roster row.
    refreshTranscript?: (sessionId: string, threadId?: string) => Promise<SessionSnapshot | undefined>,
    removeThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>,
    // C5: the board's transcript editor delegates the PUT here. The shell owns the
    // API and applies the returned snapshot through `applySnapshot`, so the roster,
    // the tiles, the tombstones and the dialog all reconcile from ONE authority.
    saveTranscript?: (
        sessionId: string,
        threadId: string,
        messages: unknown
    ) => Promise<ThreadTranscriptPayload>,
    // T5 R2: the ONE transport a tool chip may use, and only when the reader expands
    // it. The shell owns the route (./view-api.ts `getStepDetail`); the UI layer keeps
    // its "no network code in the renderer" rule (`readFile`/`resolveFile` work the
    // same way).
    loadDetail?: (input: {
        turnId: string;
        stepId: string;
        sessionId?: string;
    }) => Promise<TurnStepDetail>,
    // T11 R8: the same lazy rule for ONE context-bar segment. The bar calls it ONLY from
    // the segment the reader clicked, and only for that segment, so a turn with five
    // hundred recorded calls still costs zero requests until one of them is opened.
    loadBlock?: (input: {
        turnId: string;
        blockId: string;
        sessionId?: string;
    }) => Promise<TurnBlockDetail>,
    // R1: the bar's Stop control delegates the per-thread cancel here. The shell owns the
    // route (./view-shell.ts `cancelViewThread`) and the roster reconcile that turns the
    // control back into Delete; the board owns single-flight and the no-confirmation rule.
    // Omitted in an embedding without the route: the control renders Stop-but-disabled.
    stopThread?: (sessionId: string, threadId: string) => Promise<unknown>,
    // T4/R2: the bar's Resume control delegates the per-thread resume to the same pair of
    // owners — the shell owns the route (./view-shell.ts `resumeViewThread`) and the roster
    // reconcile that retires the control, the board owns single-flight and failure
    // reporting. Omitted in an embedding without the route: the control renders
    // Resume-but-disabled with the honest reason, exactly like an unwired Stop/Delete.
    resumeThread?: (sessionId: string, threadId: string) => Promise<TaskReceipt>
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

    // T24: the shell's lazy sources, installed by `bindLazy` once the instance (and
    // therefore its display plane) exists. Declared before the board because every
    // board callback below is created here and must read the CURRENT binding rather
    // than one captured at construction.
    let lazy: LazyDisplayBinding | undefined;

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
        // T24 (item 5): an owner question's REAL choices, never a fabricated option
        // list. `actionRequestFor` answers synchronously from the session's pending
        // actions (the exact recorded request the answer route validates against); a
        // settled card with no live request costs ONE step-detail read for its
        // verbatim `action_request` opening event, after which `onActionHydrated`
        // asks the shell to repaint that tile with the recorded options.
        actionRequestFor: (step) => lazy?.requestFor?.(step),
        loadActionRequest: (step) => lazy?.loadRequest?.(step) ?? Promise.resolve(undefined),
        onActionHydrated: (turnId) => lazy?.actionHydrated?.(turnId),
        ...(answer === undefined ? {} : { answerAction: answer }),
        ...(refreshTranscript === undefined
            ? {}
            : { refreshSessionSnapshot: refreshTranscript }),
        ...(removeThread === undefined ? {} : { deleteThread: removeThread }),
        // R1: same shape as the delete transport — passed through only when the shell can
        // actually reach the cancel route.
        ...(stopThread === undefined ? {} : { stopThread }),
        // T4/R2: same conditional as Stop — the board renders Resume disabled-with-a-reason
        // rather than pretending a route exists.
        ...(resumeThread === undefined ? {} : { resumeThread }),
        ...(saveTranscript === undefined ? {} : { saveThreadTranscript: saveTranscript }),
        ...(loadDetail === undefined ? {} : { loadStepDetail: loadDetail }),
        ...(loadBlock === undefined ? {} : { loadBlockDetail: loadBlock }),
        // Focus follows the single expanded tile. Only the composer's routing line
        // has to repaint from here now that the thread strip is gone, so the
        // steering target stays visible in the same tick the reader
        // expands/collapses a conversation.
        onFocusChange: () => {
            // T24: an expansion is also (a) a request for that row's display tree
            // NOW and (b) the conversation whose streamed text the reader is
            // watching, which is what the `turn`-scope flow subscription follows.
            // Guarded on `lazy` because the board can notify during construction,
            // before `reveal` exists.
            if (lazy !== undefined) {
                lazy.focusTurn?.(board.expanded()?.id());
                reveal();
            }

            // Only the SELECTED view owns the composer; a background harness's
            // reconcile must not repaint the routing line of another conversation.
            // Identity is the view's own pane, the one thing available before the
            // View object exists.
            if (current?.view.pane === pane) paintComposerTarget();
        },
        // T3 (R2/R3): the board reports the set of conversations it is SHOWING — expanded
        // thread cards plus the focused conversation — and the shell turns that into live
        // following: a `thread`-scope subscription and a transcript document per id, and
        // neither for anything collapsed. A load reports the empty set, which is R1: the
        // collapsed screen stays driven by the roster page alone.
        onFollowedThreadsChange: (threadIds, sessionId) => {
            lazy?.followThreads?.(threadIds, sessionId);
        }
    });

    const log = el('div', 'log');
    log.append(board.element);

    // T24 (item 3): the ONLY way history grows — one button, one issued cursor, one
    // page per press. The shell never walks history on its own, and the control
    // retires when the server says the beginning is already loaded.
    const older = el('button', 'load-older') as HTMLButtonElement;
    older.type = 'button';
    older.textContent = 'Load older messages';
    older.hidden = true;

    const paintOlder = (): void => {
        const binding = lazy;

        // No plane bound yet, or nothing older than this window: no affordance at
        // all, rather than a control that would answer nothing.
        if (binding === undefined || !binding.hasOlder()) {
            older.hidden = true;
            older.disabled = false;
            older.textContent = 'Load older messages';

            return;
        }

        older.hidden = false;
        // While a page is in flight the button stays VISIBLE and disabled: hiding it
        // would read as "there is nothing older" to a reader who just pressed it.
        older.disabled = binding.loadingOlder();
        older.textContent = binding.loadingOlder() ? 'Loading older…' : 'Load older messages';
    };

    older.addEventListener('click', () => {
        const binding = lazy;
        if (binding === undefined) return;

        // Reflect the in-flight state immediately; the plane also refuses a second
        // concurrent page (`loadingOlder`), so a double click costs one request.
        paintOlder();

        void binding
            .loadOlder()
            .catch(() => undefined)
            .finally(() => {
                // The prepend repaints the rows through the plane's own `repaint`;
                // this re-evaluates the affordance and asks for the trees of the rows
                // that just entered the viewport.
                paintOlder();
                reveal();
            });
    });

    // The rows inside this pane's viewport, plus the expanded tile. Synchronous
    // viewport math rather than an IntersectionObserver: the pane is ONE scroll
    // container (`log-wrap`), the row count is bounded by the loaded window, and a
    // read cannot miss a row the reader already sees. A host with no layout (jsdom, a
    // detached pane) reports zero-area rects, which all count as inside the viewport
    // — the safe direction, because the plane still caps concurrency at 4 and dedupes.
    const visibleTurnIds = (): string[] => {
        const ids: string[] = [];
        const view = logWrap.getBoundingClientRect();

        for (const handle of board.turns()) {
            const id = handle.id();
            if (id === undefined) continue;

            const rect = handle.element.getBoundingClientRect();
            if (rect.bottom >= view.top && rect.top <= view.bottom) ids.push(id);
        }

        // The opened conversation is by definition being read, even if its header
        // scrolled past while its flow fills the pane.
        const opened = board.expanded()?.id();
        if (opened !== undefined && !ids.includes(opened)) ids.push(opened);

        return ids;
    };

    // Ask for trees for what the reader can actually SEE, then refresh the
    // affordance. Safe to call on every scroll/repaint: the loader drops a row it
    // already holds or already has in flight, so a scroll gesture cannot start the
    // same read twice and a fully-loaded window issues zero requests.
    const reveal = (): void => {
        if (lazy === undefined) return;

        lazy.ensureVisible(visibleTurnIds());
        paintOlder();
    };

    // Scrolling INTO unloaded history is the request for it (T24 item 2).
    logWrap.addEventListener('scroll', () => reveal(), { passive: true });

    // A click anywhere in the transcript is the reader changing WHAT THEY ARE LOOKING
    // AT, and it is not always a focus change: two tiles of the SAME conversation
    // switch the expanded tile without moving the steering target, so `onFocusChange`
    // stays silent. Without this the flow subscription would follow the thread and not
    // the tile, and the newly opened tile would stream nothing. `followTurnFlow` is
    // idempotent for the same turn, so a click that changed nothing costs no request.
    board.element.addEventListener('click', () => {
        if (lazy === undefined) return;

        lazy.focusTurn?.(board.expanded()?.id());
        reveal();
    });

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

    logWrap.append(older, log);
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
        focusThread: (threadId, scroll) => board.focusThread(threadId, scroll === true),
        clearFocus: () => board.collapse(),
        // T21 R22: same transition as the reader's own collapse press, used by the
        // shell when a conversation is LOADED (see the `View.collapseForLoad` note).
        collapseForLoad: () => board.collapse(),
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
        setSessionView: (view) => {
            // T5 R1: the compiled document is the authority for everything the default
            // path draws and protects. The raw transcript source stays untouched until
            // an explicit export read replaces it.
            board.setSessionView(view);
        },
        followedThreads: () => board.followedThreads(),
        setThreadTranscript: (threadId, payload) => {
            // T3: the shell owns the read; the board owns the surfaces that render it (the
            // roster row, the roster-only focus panel, an open transcript dialog).
            board.setThreadTranscript(threadId, payload);
        },
        hydrateView: (view, model, keep) => {
            const follow = pinned();
            const handles = board.hydrateView(view, {
                ...(model === undefined ? {} : { model }),
                ...(keep === undefined ? {} : { keep })
            });
            stick(follow);

            return handles;
        },
        reconcileView: (view, model, keep) => {
            const follow = pinned();
            const handles = board.reconcileView(view, {
                ...(model === undefined ? {} : { model }),
                ...(keep === undefined ? {} : { keep })
            });
            // A task submitted while the reader is at the bottom should pull the view
            // down to the active row; a reader scrolled up keeps their place.
            stick(follow);

            return handles;
        },
        upsertSummary: (summary, view) => board.upsertView(summary, view),
        applyOps: (turnId, ops, view) => {
            const applied = board.applyViewOps(turnId, ops, view);
            // An ops frame changes the transcript without changing the document
            // pointer, so the same follow-the-bottom rule applies.
            if (applied) stick(pinned());

            return applied;
        },
        clear: () => {
            board.clear();
            logWrap.scrollTop = 0;
        },
        notice: (text, tone) => {
            board.notice(text, tone);
            // R3: a notice is the board's own line (it already lives at the end of the
            // transcript), not a user gesture. Jumping to the bottom here pulled a reader
            // out of whatever they were reading every time anything was reported; the same
            // follow-the-bottom rule the rest of this view uses applies — follow ONLY when
            // the reader was already at the bottom (see `pinned`).
            stick(pinned());
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
        },
        bindLazy: (binding) => {
            lazy = binding;
            paintOlder();
        },
        reveal: () => reveal(),
        visibleTurnIds: () => visibleTurnIds(),
        expandedTurnId: () => board.expanded()?.id(),
        paintOlder: () => paintOlder()
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
    // `files` declares ONE array property (`ops`), so the textarea holds the array of
    // operations itself. A list of the server's working directory is the cheapest way to
    // see the shape; the second preset shows a mutation, which is what makes this tool
    // more than the `fileList` it replaced.
    files: [
        { label: 'List the current directory', value: [{ op: 'list', path: '.' }] },
        { label: 'Create Temp/probe', value: [{ op: 'mkdir', path: 'Temp/probe' }] }
    ],
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
    // `tasks` (renamed from `task` by the records-engine redesign, Decision J; the slash
    // command is still `/task`) is a merge/patch call, not an action
    // enum, so each button below is one complete merge the tool accepts as-is:
    //   - no properties at all reads the current list;
    //   - a `tasks` entry WITHOUT `id` adds one, and `text` is what makes it valid;
    //   - a `tasks` entry WITH `id` patches only the fields it names (here: completion);
    //   - `remove` drops the ids it lists.
    // Every success answers with the CURRENT bounded list, so the id placeholders below
    // are edited from the result of the read/add call that precedes them. The read
    // payload is identical to the schema-derived fallback (`{}`), so the runner shows one
    // button for it, never two.
    tasks: [
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
    // Runtime registry + record-store wrappers. Every value below is schema-checked against the
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
    profiles: [
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
    chapters: [
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
    locations: [
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
    show: (entry: ToolDescriptor, preserve?: boolean) => void;
    // Repaint the session-context line (the playground context changed underneath an
    // already-open runner).
    sync: () => void;
};

// The cap the server applies to `toolRequest` (5). Kept here only to explain
// truncation: the UI never slices the result itself.
const REQUEST_TOOLS_LIMIT = 5;

// The class hook of the runner's response box. styles.css sizes and frames it through
// `.card-body` (and the `.tool-runner-slot … > .tool-output > .card-body` flex chain), and
// every consumer reads the result through it; `createPayloadViewer` adds the `tool-code`
// wrap class beside it. A named constant so the viewer call sites cannot drift apart.
const RUNNER_RESPONSE_VIEWER_CLASS = 'card-body';

// The same pairing for the runner's parameter-schema disclosure (styles.css
// `.transcript-body`).
const TRANSCRIPT_BODY_VIEWER_CLASS = 'transcript-body';

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
    // R1 (payload views): the parameter schema is a JSON payload inside the runner
    // dialog, so it renders through the same line-numbered, soft-wrapped viewer as the
    // result box below. `.transcript-body`'s own `pre-wrap` in styles.css (0,1,0) loses to
    // `ui/dialog.css .dialog-body pre` (0,1,1), which is why this box used to scroll
    // sideways; `createPayloadViewer` carries the host class plus `tool-code`.
    const schemaBody = createPayloadViewer('{}', 'json', TRANSCRIPT_BODY_VIEWER_CLASS);
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
    // R1 (payload views): the response box is a PAYLOAD surface, so it is the same
    // line-numbered, soft-wrapped viewer a tool pane uses. It used to hand-roll
    // `highlightCode` into a bare `pre.card-body`, and `ui/dialog.css`
    // `.dialog-body pre { white-space: pre }` (0,1,1) beat `.card-body`'s `pre-wrap`
    // (0,1,0) in styles.css — the long single-line results the runner is full of scrolled
    // sideways instead of wrapping. `card-body` stays the host class (the runner's flex
    // chain, its cap and `.card` framing all address it, and the consumer tests read the
    // box through it); `createPayloadViewer` adds `tool-code`, which is what wins.
    //
    // `code.textContent` is byte-identical to the pretty-printed payload, so
    // `JSON.parse(document.querySelector('.tool-output .card-body').textContent)` and the
    // pane's Copy (which reads `responseText`, not the DOM) are unchanged.
    //
    // The box is ONE node for the life of the runner (R2): `setResponse` repaints its
    // `<code>` column in place through `paintCodeBlock`. It used to hand-roll
    // `highlightCode` into this same `<pre>`, and the payload viewer must keep that
    // property — the runner pane is persistent (it outlives the dialog it was opened
    // from), so consumers hold the box they rendered: a test that captures
    // `.tool-output .card-body` before a call, then reads it after the answer lands
    // (scratch-board.test.ts, playground-context.test.ts), is the same reader who looks
    // at the box. Swapping the host would leave that reference on a detached node still
    // showing the previous prompt.
    const outputBody = createPayloadViewer('', undefined, RUNNER_RESPONSE_VIEWER_CLASS);
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
    // pretty-printed JSON when it parses, escaped (and highlighted) otherwise. The
    // viewer builds that from `highlightCode` output through createElement/createTextNode
    // only, so model-written markup stays inert text and the box is re-rendered rather
    // than patched — the row set is derived from the payload's own newlines.
    const setResponse = (text: string, isError: boolean): void => {
        responseText = text;
        responseLabel = isError ? 'error' : 'response';
        outputLabelNode.textContent = responseLabel;
        output.className = isError
            ? 'card tool-output tool-section is-error'
            : 'card tool-output tool-section';

        const shown = prettyJson(text);
        const language = looksLikeJson(text) ? 'json' : undefined;

        // IN PLACE (see `outputBody` above): the same `<pre class="card-body …">` keeps
        // being the response box, and only its rows are rebuilt from the new payload.
        paintCodeBlock(outputBody, shown, language);
        // The format the box is actually showing, kept as data for a reader who inspects
        // the node (nothing paints it: the `[data-language]` caption is Markdown-fence
        // only, styles.css).
        outputBody.dataset.language = language ?? 'text';
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

    // The exact text the last preset fill wrote into the box, and the value the CURRENTLY painted
    // preset list would fill. A schema that lands AFTER the row was painted must adopt its own
    // starting value when the reader has not touched the box, and must leave it alone the moment
    // they have — so "untouched" is decided against `lastFilled`, never against a guess.
    let lastFilled: string | undefined;
    let firstPresetValue: string | undefined;

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
                lastFilled = args.value;

                for (const other of presetButtons.children) {
                    (other as HTMLButtonElement).setAttribute('aria-pressed', 'false');
                }
                button.setAttribute('aria-pressed', 'true');
            });

            presetButtons.append(button);
        });

        // Recorded whether or not this paint fills, so a preserve repaint knows the starting
        // value the new schema would have offered.
        firstPresetValue = presets.length > 0 ? JSON.stringify(presets[0].value, null, 2) : undefined;

        if (fill && presets.length > 0) {
            args.value = JSON.stringify(presets[0].value, null, 2);
            lastFilled = args.value;
        }
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
            outputLabelNode.textContent = `response · ${response.duration_ms}ms`;

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
        show: (entry, preserve = false) => {
            // A late identified-read repaint (T50) must not destroy work in progress: the
            // reader's draft, the response they are reading, and the panels/hint under it all
            // stay exactly as they were. Captured before any painter runs, because every one of
            // these surfaces writes through the same closures.
            const prevDraft = preserve ? args.value : undefined;
            const prevFilled = lastFilled;
            const prevResponse = preserve ? responseText : undefined;
            const prevIsError = preserve ? responseLabel === 'error' : false;
            const prevHintHidden = preserve ? resultHint.hidden : true;
            const prevHintText = preserve ? resultHint.textContent : '';

            active = entry;

            const single = singleProperty(entry.parameters);
            // T29: a catalogue entry may publish NO `parameters` schema at all (a tool
            // listed without one, or a roster rebuilt after its harness was deleted).
            // Reading `.properties` off an absent schema threw HERE, which left the
            // runner half-mounted with no argument box — the whole row became unusable
            // instead of merely schema-less. The schema is data to tolerate.
            const properties = (entry.parameters as { properties?: unknown } | undefined)?.properties;
            const count = properties && typeof properties === 'object' ? Object.keys(properties).length : 0;
            // 'unconfigured' is the server's answer that the tool exists but has
            // no credential. Listing it is the point; calling it is not offered.
            const unavailable = entry.availability?.state === 'unconfigured';
            const sessionBound = entry.sessionBound === true;

            note.textContent = sessionBound
                ? 'Core tool — it runs in the playground’s own temporary session (a harness session this view created for tool testing, deleted when the tools view closes), so its result never changes the conversation you are reading.'
                : 'Direct call — no harness, no agent, no tool loop. This is the same implementation a session registers, invoked as a function.';

            // The schema keeps its ONE `<pre>` (see the response box above): the rows are
            // re-laid-out in place because the row set is derived from the payload's own
            // newlines, and swapping the host would orphan a box a consumer already holds.
            // `.transcript` keeps its own disclosure behaviour.
            // An absent schema still has an honest answer: an empty object. Handing
            // `undefined` to the code painter used to throw on its length, which aborted
            // the rest of the runner mount (no argument box at all).
            const schemaJson = JSON.stringify(entry.parameters ?? {}, null, 2);
            paintCodeBlock(schemaBody, schemaJson, 'json');

            // R8: the preset buttons are painted first and the first one fills the box,
            // so the runner always starts from a named, schema-valid payload (curated
            // example when one exists, schema-derived otherwise) that the reader can
            // edit freely. On a PRESERVE repaint the presets are rebuilt but the box is
            // not refilled: the draft the reader is working on wins.
            paintPresets(entry, !preserve);

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

            // A schema repaint carries no new payload, so everything the previous frame showed
            // is put back verbatim (see the capture at the top of this function) — EXCEPT an
            // argument box the reader never touched: an untouched placeholder adopts the real
            // schema's starting value, which is the whole point of the identified read.
            if (preserve) {
                if (prevDraft !== undefined && prevDraft !== prevFilled) args.value = prevDraft;
                // Untouched box: adopt the real schema's starting value, which is the whole
                // point of the identified read.
                else if (firstPresetValue !== undefined) args.value = firstPresetValue;

                if (prevResponse !== undefined) setResponse(prevResponse, prevIsError);
                if (prevIsError) outputLabelNode.textContent = 'error';

                resultHint.hidden = prevHintHidden;
                resultHint.textContent = prevHintText;
            }

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
// Build identity ("Harness UI v2.3.0(081345)"): version from package.json plus
// the build stamp (day, hour, minute), both inlined at build time by
// src/frontend/vite.config.ts.
// The bare name is the fallback for a host that does not define the constant
// (the UI's vitest config), so tests and any non-Vite bundle keep a valid label.
// See src/frontend/build-label.ts.
const harnessUiLabel =
    typeof __HARNESS_UI_LABEL__ === 'string' ? __HARNESS_UI_LABEL__ : 'Harness UI';
brand.append(brandMark, el('span', 'brand-name', harnessUiLabel));

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

// R3: Tools is a GLOBAL icon-only toggle, not a centre tab.
// It opens the same full-width catalogue + manual runner in `stage`; the
// composer (with both flanking controls) is hidden while it is open (`setToolsView`). The
// harness head is NOT hidden — `paintToolsHead` re-titles it — which is what makes the
// title row a safe home for this control: the second press that closes the pane stays on
// screen (and `setToolsView` focuses this very button after switching).
//
// The glyph is decoration (`aria-hidden`), the accessible name is `aria-label`, and
// `aria-pressed` reports whether the tools view is showing, so the button is a real
// toggle for assistive tech rather than an unexplained icon.
//
// ASSEMBLY NOTE: the element is still BUILT here, next to the other topbar controls it was
// built alongside, but it is PARENTED into `harnessTitleTools` on the harness title row —
// see the `titleRow.append(...)` block. Nothing else about it changes.
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

// T7 (R2): the Plugins toggle sits IMMEDIATELY AFTER the Tools toggle in the same
// control group (now `harnessTitleTools`, on the harness title row), and is built by exactly
// the same rules: an icon-only button whose
// glyph is decoration (`aria-hidden`), whose accessible name is `aria-label`, and
// whose `aria-pressed` reports whether the Plugins pane owns the centre column.
//
// It is a TOGGLE of the same shape as Tools because the two views are mutually
// exclusive (one centre column, one owner): `setPluginsView` closes Tools and
// `setToolsView` closes Plugins, so at most one of these buttons is ever pressed.
//
// T7 (R3): the Plugins pane is a read-only catalogue for ENABLEMENT (plugins are
// auto-scanned; there is no enable/disable switch to offer), but the shipped
// Context Compaction plugin declares a `contextLimit` setting that IS editable
// there — the row's dialog is that editor.
const pluginsToggle = el('button', 'plugins-toggle');
pluginsToggle.type = 'button';
pluginsToggle.id = 'plugins-toggle';
pluginsToggle.setAttribute('aria-label', 'Plugins');
pluginsToggle.setAttribute('aria-controls', 'harness-stage');
pluginsToggle.setAttribute('aria-pressed', 'false');
pluginsToggle.title = 'Show the plugin catalogue';
// Same gate as Tools: before boot has answered there is no catalogue to list, and
// `paintControls` enables it once a harness is selected (and `showOffline` disables
// it again when the server goes away).
pluginsToggle.disabled = true;
const pluginsGlyph = el('span', 'plugins-toggle-icon', '⚙');
pluginsGlyph.setAttribute('aria-hidden', 'true');
pluginsToggle.append(pluginsGlyph);

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

// The right cluster keeps the live status pill alone at the top-right on every width.
// There is NO rail control in the topbar (T3/R1+R3): the harness listing is opened by
// the "Harness UI" brand button and the scratch board by the floating `.scratch-fab`
// below.
//
// RELOCATION (this change): the two catalogue toggles used to be this cluster's last two
// children and now sit on the harness TITLE ROW (`harnessTitleTools`, assembled with
// `titleRow` below): the panes they open are presented for the session in view, while this
// pill is app-wide. The elements are built exactly once, HERE, and only their PARENT
// changes — `paintToolsToggle`, `paintPluginsToggle` and `paintControls` hold these
// references, so re-creating them in the new place would silently detach every painter.
const topbarRight = el('div', 'topbar-right');
topbarRight.append(statusButton);

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
//
// What those nodes show is the DRAFT (`endpointDraft`), never the committed `settings`:
// `syncEndpointDraft()` re-bases it on what is saved on every open and every close, so
// walking away from the dialog is the same decision as never opening it.
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
    control.value = endpointDraft[key];
    control.placeholder = placeholder;
    control.spellcheck = false;
    control.autocomplete = 'off';
    control.addEventListener('input', () => {
        // The keystroke moves the DRAFT only. `Apply` is the single writer of
        // `settings`/`localStorage` (./main.ts `commitEndpointDraft`), which is what makes
        // dismissal (×, Escape, backdrop, a second pill press) mean "no update".
        endpointDraft[key] = control.value;

        // The model catalogue belongs to the provider, so a change to either
        // credential-bearing field invalidates it. Debounced because typing a
        // base URL would otherwise fire one request per keystroke. This is a PREVIEW:
        // it renders what the typed endpoint serves, and persists nothing.
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
// endpoint advertises what it serves at GET {baseURL}/models (the browser posts the
// pair to `POST /models` and the HARNESS server makes that call — it owns the
// credentials, and the key never travels back to this page). The dropdown is therefore
// a PREVIEW of the endpoint: paste a base URL and the list repopulates (debounced),
// pick one and `Apply` writes it. There is no text box: an id the endpoint does not
// advertise is not something this dialog invents.
//
// A stored model the provider does not list stays visible as a `<current> (current)`
// option, so previewing a different endpoint never silently drops a valid selection.
// Nothing here ever renders or logs the API key.

const MODEL_REFRESH_DELAY_MS = 500;

// The state line's initial wording, and the wording a dismissed preview is reset to: after
// a cancel nothing is in flight and nothing is known for the endpoint on screen, so the
// dropdown must read as if it had never been asked (./main.ts `cancelModelPreview`, F2).
const MODEL_STATUS_INITIAL = 'Model list not loaded yet.';

const modelSelect = el('select', 'field-input field-select');

// The ONE line that states what the catalogue preview knows. It is a `.field-hint`
// sibling of the `<select>`, and it carries terse state only — never instructions.
const modelStatus = el('p', 'field-hint', MODEL_STATUS_INITIAL);

// --- PUBLISHED catalogue vs. PREVIEW list (F1) --------------------------------
//
// `modelIds` is the catalogue the whole app shares: every per-agent model dropdown reads it
// (./main.ts `agentModelSelectOf` → `catalogue: modelIds`). `previewModelIds` is only what the
// endpoint dialog's `<select>` shows. They are deliberately SEPARATE state: pasting a Base URL
// is a PREVIEW, and a preview that is dismissed or superseded must leave the published
// catalogue exactly as it was — otherwise the app-wide dropdowns end up pointing at a provider
// the reader never applied.
//
// An answer belongs to an ENDPOINT PAIR, not to a Base URL alone: `modelCatalogueFor` +
// `modelCatalogueKey` name the (Base URL, API key) the published ids were fetched with, and
// `previewFor` + `previewKey` the pair the preview on screen was fetched with. The credential
// is part of the identity because a blank key on the configured origin means the SERVER's key
// (../shared/harness-api.ts `RunnerSettingsInput.api_key`, and the same rule the OpenAPI
// contract states for `POST /models`), so one URL legitimately answers with two different lists
// depending on which credential it was asked under. A list fetched with the wrong credential is
// therefore NOT an answer for the committed endpoint, exactly as a list fetched for another URL
// is not, and a key-only edit has to move or re-ask the catalogue the way a URL edit does.
//
// `undefined` in a `…For` slot means nothing has answered for any endpoint yet. That distinction
// is what lets `seedModelPreview` tell a provider that genuinely serves zero models (no request
// on reopen) from an endpoint nobody has asked about (exactly one request on reopen), and
// `previewFor` goes back to `undefined` whenever the list on screen is NOT a real answer — in
// flight, failed, or cancelled.
let modelIds: readonly string[] = [];
let modelCatalogueFor: string | undefined;
let modelCatalogueKey: string | undefined;
let previewModelIds: readonly string[] = [];
let previewFor: string | undefined;
let previewKey: string | undefined;

// The endpoint a model lookup dials, plus the one fact the caller has to STATE because nothing
// can infer it: whether that pair IS the saved record. `committed: true` means the answer
// describes the endpoint the app is actually dialling, so it may move the shared catalogue;
// `committed: false` means it is a DRAFT preview, so it paints the dialog and nothing else.
//
// The flag replaces the previous "does the draft string happen to equal `settings`" comparison.
// That comparison coupled the app-wide catalogue to whatever the dialog was showing, and
// `applyDefaults` deliberately does NOT re-base the draft while a layer is open (./main.ts F4),
// so a reader who opened the dialog before the bootstrap landed left the boot lookup comparing a
// pre-boot draft URL against the settings that had just arrived, found them different, and the
// shared catalogue stayed empty for the whole load.
type ModelLookup = {
    readonly baseURL: string;
    readonly apiKey: string;
    readonly committed: boolean;
};

// The pair `POST /sessions` will dial, read from `settings` rather than from the draft so a
// stale draft can never describe it. Boot, the `Apply` re-arm, and the open-time seed use this.
const committedModelLookup = (): ModelLookup => ({
    baseURL: settings.baseURL.trim(),
    apiKey: settings.apiKey,
    committed: true
});

// The pair the dialog's fields are showing. Only the debounced keystroke lookup uses it, and its
// answer never leaves the dialog.
const previewModelLookup = (): ModelLookup => ({
    baseURL: endpointDraft.baseURL.trim(),
    apiKey: endpointDraft.apiKey,
    committed: false
});

// Is the shared catalogue an answer for EXACTLY this pair? Both halves must match; a cleared
// catalogue (`modelCatalogueFor === undefined`) answers for nothing, so it never matches.
const publishedCatalogueAnswers = (endpoint: ModelLookup): boolean =>
    modelCatalogueFor === endpoint.baseURL && modelCatalogueKey === endpoint.apiKey;

let modelLoading = false;
let refreshTimer: number | undefined;
let modelRequest: AbortController | undefined;
// Monotonic ticket: a superseded response must never paint over a newer one.
let modelTicket = 0;

const setModelStatus = (text: string, isWarning = false): void => {
    modelStatus.textContent = text;
    modelStatus.classList.toggle('is-warning', isWarning);
};

// The one state line for a SETTLED list of a non-blank Base URL — loaded or empty. Shared by
// the answer paint and the open-time seed so the two can never drift apart in wording.
const setModelCatalogueStatus = (ids: readonly string[], baseURL: string): void => {
    setModelStatus(
        ids.length === 0
            ? 'No models returned'
            : `Loaded ${ids.length} model${ids.length === 1 ? '' : 's'} from ${baseURL}`,
        ids.length === 0
    );
};

// Move the PUBLISHED catalogue onto this answer, and repaint the chrome that reads it. Only a
// lookup that declared its pair IS the saved record may call this (./main.ts `refreshModels`),
// which is the whole of F1: a preview of a typed-but-unapplied endpoint never gets here.
const publishModelCatalogue = (endpoint: ModelLookup, ids: readonly string[]): void => {
    modelIds = ids;
    modelCatalogueFor = endpoint.baseURL;
    modelCatalogueKey = endpoint.apiKey;

    // The per-agent model dropdowns are built from the published catalogue by
    // `agentModelSelectOf`, so the chrome that hosts them repaints here: the composer's agent
    // control is rebuilt, and a per-agent dialog opened AFTER this point offers the real ids
    // rather than only the effective default/current labels (`current` is the ACTIVE
    // conversation, ./main.ts `current`). What this deliberately does NOT do is repaint a
    // per-agent dialog that is ALREADY open: `agentDialogSignatureOf` keys on the conversation
    // view and its own model map, not on the shared catalogue, so `refreshAgentDialog` finds an
    // unchanged signature and bails. That open dialog picks the new ids up when it is next
    // opened; widening the signature is out of scope for this pass.
    const activeInstance = current;
    if (activeInstance !== undefined) renderHarnessChrome();
};

// The published catalogue has gone from "known" to "no answer" — a committed lookup that failed,
// or a committed Base URL that is blank. The chrome repaints for the same reason
// `publishModelCatalogue` repaints: the per-agent dropdowns read `modelIds`, and after this they
// must show only the effective default/current labels rather than ids nothing backs any more.
// (The `Apply` path has its own repaint at ./main.ts `applyEndpointSettings`, so a clear reached
// from `commitEndpointDraft` is repainted there instead of here.)
const clearPublishedCatalogue = (): void => {
    modelIds = [];
    modelCatalogueFor = undefined;
    modelCatalogueKey = undefined;

    const activeInstance = current;
    if (activeInstance !== undefined) renderHarnessChrome();
};

// Rebuild the option list from the provider catalogue plus the current model.
//
// Order matters:
//   1. the current model first **when it is not in the catalogue**, so a valid
//      selection survives a provider that hides models or a temporary failure;
//   2. every advertised id, in provider order (providers tend to list their
//      preferred model first, so it is preserved rather than sorted);
//   3. a disabled placeholder when the catalogue is empty, so the control is never a
//      blank box and the reason is the status line beside it.
const renderModelOptions = (): void => {
    if (modelLoading) {
        modelSelect.replaceChildren();
        const loading = el('option', undefined, 'Loading models…');
        loading.value = '';
        loading.disabled = true;
        modelSelect.append(loading);
        modelSelect.disabled = true;
        return;
    }

    // The DRAFT is what the control shows, so a preview of another endpoint cannot
    // rewrite the model that is actually saved.
    const current = endpointDraft.model.trim();
    modelSelect.replaceChildren();

    if (current.length > 0 && !previewModelIds.includes(current)) {
        const option = el('option', undefined, `${current} (current)`);
        option.value = current;
        modelSelect.append(option);
    }

    for (const id of previewModelIds) {
        const option = el('option', undefined, id);
        option.value = id;
        modelSelect.append(option);
    }

    if (previewModelIds.length === 0) {
        const empty = el('option', undefined, 'No models');
        empty.value = '';
        empty.disabled = true;
        modelSelect.append(empty);
    }

    // The selection is the draft model, and every branch above guarantees an option with
    // that value: an advertised id matches itself, and an id the provider hides matches the
    // `(current)` entry. A blank draft (only reachable from a hand-edited record — this
    // control can no longer produce one) lands on the placeholder when there is nothing
    // advertised, and previews the first advertised id otherwise.
    //
    // F1: the list is `previewModelIds`, never the published `modelIds`, so this control can
    // never display a catalogue the reader did not apply.
    //
    // F3: what the control DISPLAYS is what `Apply` COMMITS. A blank draft showing the first
    // advertised id used to be a lie — the `change` listener below only fires on user
    // interaction, and re-picking the option that is already selected fires nothing at all, so
    // `Apply` wrote the empty string while the dropdown named a real model. Moving the draft
    // here, in the same tick as the paint, keeps the two identical without inventing a
    // `Server default` option. A displayed blank (nothing advertised) writes nothing, so the
    // stored model survives an endpoint that lists nothing.
    const displayed = current.length > 0 ? current : (previewModelIds[0] ?? '');
    modelSelect.value = displayed;
    if (current.length === 0 && displayed.length > 0) endpointDraft.model = displayed;
    modelSelect.disabled = false;
};

// Fetch ONE endpoint's catalogue and render every outcome as one terse state line: loading,
// loaded, empty, or failed.
//
// The caller names the endpoint; the default is the DRAFT preview, which is the only caller that
// edits the pair on screen (./main.ts `scheduleModelRefresh`). A committed caller passes
// `committedModelLookup()` so the request carries the pair the app actually dials — which is what
// makes boot's lookup correct even when the dialog is open with a draft that has not caught up
// (./main.ts `applyDefaults` skips the draft re-base while a layer is open).
const refreshModels = async (lookup: ModelLookup = previewModelLookup()): Promise<void> => {
    const ticket = ++modelTicket;

    // Drop any in-flight request: its answer describes the previous endpoint.
    modelRequest?.abort();
    modelRequest = undefined;

    const { baseURL, apiKey, committed } = lookup;

    if (baseURL.length === 0) {
        // No endpoint to ask: a STATE, not a request. Nothing is known for any endpoint, and a
        // committed blank base URL means the published catalogue is empty too.
        previewFor = undefined;
        previewKey = undefined;
        previewModelIds = [];
        modelLoading = false;
        renderModelOptions();
        setModelStatus('No base URL set', true);
        if (committed) clearPublishedCatalogue();
        return;
    }

    const controller = new AbortController();
    modelRequest = controller;

    // Nothing on screen answers for anything while a lookup is in flight (`previewFor` is
    // published/seeded again only by a settled answer).
    previewFor = undefined;
    previewKey = undefined;
    previewModelIds = [];
    modelLoading = true;
    renderModelOptions();
    setModelStatus('Loading models…');

    try {
        const ids = await listProviderModels({ base_url: baseURL, api_key: apiKey }, controller.signal);
        if (ticket !== modelTicket) return;

        previewModelIds = ids;
        previewFor = baseURL;
        previewKey = apiKey;
        modelLoading = false;
        renderModelOptions();
        // F1: the answer is published because the CALLER declared the pair it dials to be the
        // saved record — not because a draft string happens to match one.
        if (committed) publishModelCatalogue(lookup, ids);
        setModelCatalogueStatus(ids, baseURL);
    } catch (error) {
        if (ticket !== modelTicket) return;

        // A failure is not an answer for this endpoint: the preview goes back to an empty list
        // with the server's reason on the state line, and nothing is published. A committed
        // lookup that fails leaves the published catalogue UNKNOWN (`modelCatalogueFor` unset),
        // so the next dialog open re-arms a fetch instead of trusting a stale list (F2), and the
        // chrome drops the ids that are no longer backed by an answer.
        previewModelIds = [];
        previewFor = undefined;
        previewKey = undefined;
        modelLoading = false;
        renderModelOptions();
        if (committed) clearPublishedCatalogue();
        setModelStatus(`Could not load models: ${messageOf(error)}`, true);
    } finally {
        if (ticket === modelTicket) modelRequest = undefined;
    }
};

// Typing in the endpoint fields must not produce one provider request per
// keystroke. 500ms is short enough to feel automatic once a URL is pasted.
//
// The debounce is the ONLY preview caller of `refreshModels`: it dials the DRAFT, and its answer
// paints the dialog's dropdown without ever moving the app-wide catalogue (./main.ts
// `previewModelLookup`).
const scheduleModelRefresh = (): void => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);

    refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refreshModels();
    }, MODEL_REFRESH_DELAY_MS);
};

// Drop the pending debounce AND any in-flight lookup, and put the model group back to the
// state it had before the dialog was opened (F1/F2). The ticket is what makes a live request
// ignore its own answer (`refreshModels` compares it before painting) and the abort is what
// stops the socket work behind it; together they are why a lookup started from a draft the
// reader walked away from can neither repaint the dropdown nor publish into `modelIds` —
// the catalogue the per-agent dropdowns share.
//
// What this does NOT do is touch the published catalogue: a dismissed preview never reached
// it in the first place, so nothing needs restoring. Resetting the state line to the initial
// wording is what stops `Loading models…` from outliving the request it described — the one
// piece of the preview that stays WRONG after an abort, because the dropdown keeps the ids it
// was holding while the request was in flight. The option list itself is left alone on
// purpose: it is a persistent node the reader never sees while detached, and every reopen
// repaints it from the published catalogue or from a fresh lookup (./main.ts
// `seedModelPreview`), so a stale list can never be what the reader is looking at.
// `previewFor`/`previewKey` go back to `undefined` because nothing on screen answers for
// anything any more — which is also what stops `Apply` from publishing a catalogue a preview left
// behind.
const cancelModelPreview = (): void => {
    if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
    }

    modelTicket += 1;
    modelRequest?.abort();
    modelRequest = undefined;
    // The loading paint would otherwise leave a disabled dropdown holding the single
    // `Loading models…` option for a request that no longer exists (F2).
    modelLoading = false;
    previewFor = undefined;
    previewKey = undefined;
    setModelStatus(MODEL_STATUS_INITIAL);
};

// Paint the dialog's dropdown for the endpoint that is COMMITTED, before the reader sees it.
// `openEndpointDialog` calls this straight after `syncEndpointDraft`, so the draft IS the saved
// settings here — and the lookup it may arm therefore belongs to the COMMITTED pair, which is
// what lets its answer become the app-wide catalogue. Without that, a conversation opened against
// an endpoint whose boot lookup failed would never see the provider's ids, and every reopen would
// spend a fresh request instead of seeding from the one it just made.
//
// It reads `settings` through `committedModelLookup()` rather than the draft, so the pair can
// never come from a field the reader has already moved on. Three states, each worded exactly like
// the boot path:
//
//   1. no Base URL committed → a state, not a request: no provider call, `No base URL set`;
//   2. the published catalogue is an answer for exactly that (Base URL, API key) pair → reuse it
//      and ask nothing. This is the reopen-after-dismiss case (F1/F2): the list the reader needs
//      is already in `modelIds`, so a reopen cannot say `No models` about a provider that does
//      serve models, and a provider that serves none does not earn a request per open;
//   3. a Base URL is committed but nothing is known for that pair (a failed or never-run lookup,
//      or a catalogue that answers for a different URL OR a different credential) → arm exactly
//      ONE fetch, which is what keeps a reopen from being a dead end. Bounded on purpose: one
//      request per open, no polling, no TTL.
const seedModelPreview = (): void => {
    const lookup = committedModelLookup();

    if (lookup.baseURL.length === 0) {
        previewFor = undefined;
        previewKey = undefined;
        previewModelIds = [];
        modelLoading = false;
        renderModelOptions();
        setModelStatus('No base URL set', true);
        return;
    }

    if (publishedCatalogueAnswers(lookup)) {
        previewFor = lookup.baseURL;
        previewKey = lookup.apiKey;
        previewModelIds = modelIds;
        modelLoading = false;
        renderModelOptions();
        setModelCatalogueStatus(modelIds, lookup.baseURL);
        return;
    }

    void refreshModels(lookup);
};

// The dropdown is the ONLY model control: the ids come from the endpoint, and picking
// one moves the draft. The committed model changes when `Apply` commits it.
modelSelect.addEventListener('change', () => {
    // A disabled placeholder can never become the selection, so this value is a real id;
    // the guard is only against a programmatic empty selection wiping the draft. The trim is
    // what keeps `Apply` from committing an id with whitespace a provider will not match.
    if (modelSelect.value.length > 0) endpointDraft.model = modelSelect.value.trim();
});

const modelField = el('div', 'field');
modelField.append(el('span', 'field-label', 'Model'), modelSelect, modelStatus);

// ---------------------------------------------------------------------------
// Harness server URL (the control-plane root) — the UI-level server setting
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS: the UI is independent of the server it talks to. Nothing about
// this bundle is built for one host, so the reader must be able to point it at any
// harness control plane from the browser, with no rebuild. The default stays
// automatic: `API_ROOT` is `/v1/harness` (./api.ts `FALLBACK_ROOT`), i.e. the origin
// that served this page — a UI at http://localhost:8180 dials
// http://localhost:8180/v1/harness.
//
// WHY IT IS NOT A `RunnerSettings` FIELD: `settings` (./main.ts `STORAGE_KEY` /
// `loadSettings` / `saveSettings`) is the PROVIDER triple — base URL / API key /
// model — that travels in the body of `POST /models` and `POST /sessions`. The server
// URL decides WHICH harness receives those bodies, so it lives in its own storage key
// (./api.ts `API_ROOT_STORAGE_KEY`) and is never serialized into a payload. Keeping it
// out of `field()`/`controls` is also what stops a keystroke here from firing a
// provider catalogue refresh.
//
// WHY APPLY RATHER THAN SAVE-ON-INPUT: every request URL in this app is built from
// the root resolved at module load (`API_ROOT`, plus the socket URL ./stream.ts
// derives from it), and there is no in-place teardown for a conversation in flight —
// `boot()` is called exactly once. So Apply persists the value and reloads, which is
// the same contract the offline pane's `Retry` already uses (`showOffline`).
const serverRootInput = el('input', 'field-input');
serverRootInput.type = 'text';
serverRootInput.id = 'harness-server-root';
serverRootInput.placeholder = 'http://localhost:8180/v1/harness';
serverRootInput.spellcheck = false;
serverRootInput.autocomplete = 'off';

// A `label[for]` rather than a wrapping `<label>`: the two provider fields wrap their
// single control in `label.field`, and keeping this one a plain `div.field` is what
// makes `label.field > input.field-input` keep naming the provider pair.
const serverRootField = el('div', 'field');
const serverRootLabel = el('label', 'field-label', 'Harness server URL');
serverRootLabel.htmlFor = serverRootInput.id;
serverRootField.append(serverRootLabel, serverRootInput);

// The refusal line: hidden until Apply rejects the typed value, and a `role="status"`
// live region so the reason is announced without moving focus out of the field. It is the
// ONLY error surface the dialog has, so it stays even though the prose around it went.
const serverRootStatus = el('p', 'field-hint is-warning');
serverRootStatus.setAttribute('role', 'status');
serverRootStatus.hidden = true;

// The dialog's ONE action, labelled exactly `Apply`. Dismissal (×, Escape, the backdrop, a
// second press of the pill) already means "discard", so a second button to undo the first
// was redundant: going back to automatic resolution is a blank field plus Apply, which is
// the same write the reader is making anyway.
const endpointApply = el('button', 'button primary', 'Apply');
endpointApply.type = 'button';

// The footer row: the last child of the body, right-aligned by `.endpoint-actions`, so the
// commit is the last thing the reader reaches for (the footer idiom of
// `.agent-dialog-footer` / `.composer-actions`).
const endpointActions = el('div', 'endpoint-actions');
endpointActions.append(endpointApply);

const setServerRootStatus = (message: string): void => {
    serverRootStatus.textContent = message;
    serverRootStatus.hidden = message.length === 0;
};

// The "which root is live" line — a terse state line, not an explanation. A named node
// because it is REPAINTED, not written once (see `paintServerRoot`).
const serverRootLive = el('p', 'field-hint', '');

// Paint the two root displays from the values that are live AT THE MOMENT OF THE CALL:
//   - the FIELD previews what Apply would write, so it reads `storedApiRoot() ?? API_ROOT`
//     exactly as module load does: a saved URL outranks a one-load `?apiRoot=` here (the
//     override wins for the load it is on, but pressing Apply must keep the saved value);
//   - the LINE names what THIS load actually dials, so it reads `API_ROOT` alone. The two
//     disagreeing on such a URL is the documented contract, not a bug to reconcile.
//
// WHY A FUNCTION INSTEAD OF ONE MODULE-SCOPE ASSIGNMENT: on a GitHub Pages host `API_ROOT`
// is not final when this module finishes. `resolveRoot` returns the compiled local/LAN
// chain (./api.ts:417) and `ensureApiRoot` — awaited inside `loadBootstrap`, i.e. strictly
// AFTER this dialog DOM was built — moves the ESM live binding to the gateway that
// answered (./api.ts:681). A one-time paint therefore leaves the reader looking at
// `STATIC_API_CANDIDATES[0]` while every request and the socket go to the host that
// actually answered. `openEndpointDialog` repaints on every open, and an Apply that moved
// the root reloads the page, so a repaint can never drop edits the reader is mid-way
// through committing.
const paintServerRoot = (): void => {
    serverRootInput.value = storedApiRoot() ?? API_ROOT;
    serverRootLive.textContent = `In use: ${API_ROOT.length > 0 ? API_ROOT : '(origin)'}`;
};

// Initial paint: the settings root is a PERSISTENT node that exists long before the
// dialog first adopts it, so it must not carry an empty line while detached.
paintServerRoot();

// `?apiRoot=` outranks the saved setting for the load it is on (a shared link must
// still be able to pin a host, and it stays the only per-load escape hatch), so an
// Apply that left it in the address bar would be undone by its own reload. Dropping
// that ONE parameter through `replaceState` keeps every other parameter and the hash,
// and does not litter Back with the intermediate URL.
//
// A URL this engine cannot round-trip is not worth a failed Apply: the saved value is
// already written, and the field above previews the value that wins next load.
const dropApiRootQuery = (): void => {
    try {
        const current = new URL(location.href);
        if (!current.searchParams.has('apiRoot')) return;

        current.searchParams.delete('apiRoot');
        history.replaceState(history.state, '', `${current.pathname}${current.search}${current.hash}`);
    } catch {
        // See above.
    }
};

// Copy the draft into the committed record. This is the moment `underload-harness-app:settings`
// moves, and the ONLY one inside the dialog.
const commitEndpointDraft = (): void => {
    // Assigned key by key rather than `Object.assign`, so the record keeps `loadSettings`'
    // key order — the stored payload's byte order is a contract other tests pin.
    settings.baseURL = endpointDraft.baseURL;
    settings.apiKey = endpointDraft.apiKey;
    settings.model = endpointDraft.model;

    saveSettings();

    // F1: `Apply` is the one moment a preview is ALLOWED to become the app-wide catalogue, and
    // only when the list on screen is an answer for the endpoint AND the credential that have
    // just been committed (`previewFor`/`previewKey` name the pair it was fetched for). Anything
    // else — the reader applied before the debounce fired, the lookup failed, an answer is still
    // in flight, or the API key moved while the list on screen was still the key-less answer for
    // the same URL — means NOTHING is known about the pair that was just committed, so the stale
    // list is dropped rather than left describing the provider or the credential the reader
    // replaced. The credential belongs in this comparison because a blank key on the configured
    // origin means the SERVER's key (../shared/harness-api.ts `RunnerSettingsInput.api_key`), so
    // the same URL legitimately answers with a different list once a key is typed.
    //
    // The catalogue then stays unknown until the committed lookup `applyEndpointSettings` arms
    // with the layer closed refills it with a real answer.
    //
    // A blank committed Base URL takes the same branch by construction: `previewFor` is only
    // ever a non-blank trimmed URL, so the published catalogue goes empty-and-unknown, which
    // is the state a blank endpoint actually has. (No chrome repaint here on purpose: the Apply
    // path that gets here repaints two statements after closing the layer.)
    const committed = committedModelLookup();

    if (
        committed.baseURL.length > 0 &&
        previewFor === committed.baseURL &&
        previewKey === committed.apiKey
    )
        publishModelCatalogue(committed, previewModelIds);
    else {
        modelIds = [];
        modelCatalogueFor = undefined;
        modelCatalogueKey = undefined;
    }
};

// Re-base the draft on the committed settings and repaint every control from it. Called
// when the dialog opens (a previous open's edits are no longer pending) and when it closes
// (so the persistent pane never shows a value that was never saved).
const syncEndpointDraft = (): void => {
    endpointDraft = { ...settings };

    for (const [key, control] of controls) {
        control.value = endpointDraft[key];
    }

    // The `<current> (current)` entry and the selected option follow the model that is
    // actually saved, not whatever the discarded draft named.
    renderModelOptions();
};

// The dialog's only action: commit the provider draft, and reconnect only if the harness
// server URL really moved.
//
// The root is validated and written FIRST because it is the only step that can fail, and a
// failure must change NOTHING: the typed value stays on screen with the reason beside it,
// the draft stays uncommitted, no key is written and no reload happens (a reload onto the
// OLD root would read as an Apply that silently did nothing).
const applyEndpointSettings = (): void => {
    const typed = serverRootInput.value.trim();

    // `rootMoved` is what separates "the reader pointed this browser at another harness"
    // from "the reader edited the provider fields and pressed the only button there is".
    let rootMoved = false;

    try {
        // The field is painted with `storedApiRoot() ?? API_ROOT`, so THAT is the value a
        // field the reader never touched stands for. `normalizeApiRoot` is the validator
        // `saveApiRootSetting` itself runs, imported so the comparison happens on the
        // NORMALIZED value: a trailing slash, or the automatic `/v1/harness` typed back at
        // the reader, must not become a stored override. A malformed value throws here —
        // before anything at all is written.
        const painted = storedApiRoot() ?? API_ROOT;
        // Blank is a real value: it CLEARS the setting, so the next load resolves
        // automatically again — the job the removed `Reset` button used to do.
        const normalized = typed.length === 0 ? '' : normalizeApiRoot(typed, '');

        rootMoved = normalized !== painted;

        if (rootMoved) saveApiRootSetting(typed);
    } catch (error) {
        setServerRootStatus(messageOf(error));

        return;
    }

    commitEndpointDraft();

    if (!rootMoved) {
        // Nothing about this browser's transport changed, so Apply is a plain save: close
        // the layer and repaint the chrome that reads the committed model. No reload —
        // `boot()` would tear down the conversation for nothing.
        closeEndpointDialog();

        // `current` is the ACTIVE conversation (./main.ts:5449); the alias says so because
        // the same word names a model string and a URL elsewhere in this dialog.
        const activeInstance = current;
        if (activeInstance !== undefined) renderHarnessChrome();

        // F1: with the layer now closed the draft IS the committed settings, so one lookup is
        // what makes the published catalogue describe the endpoint AND credential that were just
        // applied — the commit above could only publish when the list on screen already answered
        // for that exact pair, and an API key typed moments before the press is exactly the case
        // where it did not. Bounded: exactly one request, and only when nothing is known for the
        // committed pair (a blank Base URL answers with no request at all, see `refreshModels`).
        const committed = committedModelLookup();
        if (!publishedCatalogueAnswers(committed)) void refreshModels(committed);

        return;
    }

    // The reconnect IS the reload: every request URL and the socket are built from the root
    // resolved at module load (./api.ts), and `boot()` runs exactly once — the same contract
    // the offline pane's `Retry` already uses (`showOffline`). The layer is left alone: the
    // page is going away underneath it.
    dropApiRootQuery();
    location.reload();
};

endpointApply.addEventListener('click', applyEndpointSettings);

// F7: `Enter` inside a text field means "commit", because `Apply` is the single commit path
// and the body is a plain `div` — no `<form>`, so the browser fires no submit of its own and a
// reader who typed a URL and pressed Enter used to get nothing at all. `preventDefault` keeps
// that browser default (and any future form ancestor) from firing a SECOND commit, and the
// re-entrancy flag is the guard against the same commit being entered twice — e.g. an Apply
// that synchronously moves focus and re-dispatches, or a click the key repeat lands on. It is
// deliberately NOT a per-open latch: two deliberate `Enter` presses are two commits, exactly
// like two deliberate clicks.
let committingFromKeyboard = false;

const commitFromEnter = (event: KeyboardEvent): void => {
    // IME guard FIRST, the same pair the composer's Enter handler runs (./main.ts, the
    // `isComposing || keyCode === 229` rule documented at the composer keydown block): the Enter
    // that confirms an input-method candidate belongs to the IME, so here it must neither commit
    // the draft nor be prevented. Without it, a candidate-confirming Enter in Base URL / API key
    // persisted the half-typed value and closed the dialog while the control still held the
    // unconfirmed composition buffer.
    if (event.isComposing || event.keyCode === 229) return;

    if (event.key !== 'Enter') return;

    event.preventDefault();
    if (committingFromKeyboard) return;

    committingFromKeyboard = true;
    try {
        applyEndpointSettings();
    } finally {
        committingFromKeyboard = false;
    }
};

endpointBody.append(
    // The server choice reads FIRST: it decides where the provider credentials below
    // are about to be sent.
    serverRootField,
    // The refusal line sits directly under the field it describes, so the reason lands
    // where the eye already is.
    serverRootStatus,
    // Terse state line: the root THIS load dials. A deployment question ("is this page
    // talking to /v1/harness or /api?") stays answerable without devtools.
    serverRootLive,
    field('Base URL', 'baseURL', 'text', 'http://localhost:5500/providers/private/v1'),
    field('API key', 'apiKey', 'password', 'optional'),
    modelField,
    // LAST, and right-aligned: the single commit for everything above it.
    endpointActions
);

// All three text fields, in the order they read: the harness server URL plus the two provider
// fields `field` just registered. (`field` fills `controls`, so this list can only be built
// after the append above.) The model `<select>` is excluded — Enter there is not a commit the
// reader is reaching for, and its own `change` already moved the draft.
for (const input of [serverRootInput, ...controls.values()]) {
    input.addEventListener('keydown', commitFromEnter);
}

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
// cloning it). Nothing here rebuilds a field, so the listeners and the debounced
// catalogue refresh keep working while the layer is detached.
//
// What the reader edits is the DRAFT (`endpointDraft`, ./main.ts): `openEndpointDialog`
// re-bases it on the saved settings and `onClose` throws it away. That is the whole
// reason the footer is a single `Apply` — every dismissal path `ui/dialog.ts` provides
// (×, Escape, backdrop, a second press of the pill) is already a cancel, and a cancel
// that had already written to `localStorage` would need a second button to undo it.
//
// The harness server URL and its "In use:" line are the one value outside the draft:
// both are repainted from the live deployment on every open (see `paintServerRoot`),
// because they describe where this page is dialling rather than what the reader is
// working on.
//
// `endpointDialog` is guarded by identity in `onClose` (a replacement open may already
// own the variable when a queued close callback runs), and the pill is the trigger so
// `returnFocus` lands back on the control the reader pressed, never the composer.
let endpointDialog: DialogHandle | undefined;

const closeEndpointDialog = (): void => {
    endpointDialog?.close();
};

const openEndpointDialog = (trigger: HTMLElement): void => {
    // Repaint the two root displays BEFORE the layer is shown: on a static host the
    // probe moves `API_ROOT` after this module ran (see `paintServerRoot`), and the
    // persistent body would otherwise keep naming the candidate the loader started on.
    paintServerRoot();
    // A refusal from a PREVIOUS open is stale here: it names a value that is no longer on
    // screen, so re-showing it would claim the freshly painted root had been rejected.
    setServerRootStatus('');
    // Every open starts from what is SAVED. Whatever the last open left behind was either
    // applied (this re-base is then a no-op) or dismissed (this is the discard).
    syncEndpointDraft();
    // F2: the model group then seeds from what is PUBLISHED for that saved endpoint, or arms
    // exactly one fetch when nothing is known for it. Without this the dropdown keeps whatever
    // the previous open's preview painted (or the cleared post-cancel state) and the state line
    // can still claim `Loading models…` with nothing in flight, leaving a reopened reader with
    // `No models` and no way to re-trigger except editing the fields again.
    seedModelPreview();

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

            // Closing is the discard, and it also stops the preview that closing made
            // pointless. `syncEndpointDraft` then repaints the detached pane from the
            // committed settings, so a reopen can never show a value that was never saved
            // and `refreshModels` (still reachable from boot) reads real state.
            cancelModelPreview();
            syncEndpointDraft();
        }
    });

    endpointDialog = handle;
};

// Second press closes instead of stacking (a dialog on top of the pill is a popup the
// reader cannot dismiss with the same gesture that opened it). The pill is APP-scoped, not
// centre-scoped: it opens/toggles this dialog from EVERY centre view — the chat, the Tools
// catalogue and the Plugins catalogue — because the layer is an overlay on `document.body`
// (./ui/dialog.ts) laid over whichever pane is showing; the pane underneath is untouched.
// The previous `showingTools || showingPlugins` guard suppressed the press inside both
// catalogues, which is the reported bug. `headTitleButton` carries no such guard either:
// that trigger has always worked in BOTH heads, and `openHarnessDetails` simply switches
// its layer to the Sessions-only variant while a catalogue owns the centre.
statusButton.addEventListener('click', () => {
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
// tools view is open. T9: the tools heading keeps the button ENABLED, because the
// session dashboard is the reader's only way to a saved conversation and the old header
// pill strip is gone — `paintHeadTitleTrigger('sessions')` retitles the popup (Tools or
// a tool is never described as "harness details", and the layer opens on Sessions only).
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
// T9: that compact control is now the header's session UI AT EVERY WIDTH. The desktop pill
// strip is gone (the same dashboard the phone already reached now lives behind the title
// button on both layouts), so this pill answers "which conversation am I looking at?" and
// steps to the next one, and deleting stays in the dashboard behind `Instruct`.
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
// control's base `display: inline-flex`, so no extra visibility rule is needed here.)
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

// R2 (T9): the compact `+` beside the cycler starts a fresh conversation WITHOUT going
// through the dashboard, replacing the old `+ New` strip button. Only the glyph fits the
// header row, so the accessible name and the tooltip carry the whole phrase (a bare "+" is
// not a name an AT can act on) — the same rule the strip's button always followed.
//
// The historical `.new-session` class is kept, and with the header strip gone this is the
// only copy outside the dashboard, so every consumer that clicks `.new-session` while the
// dialog is closed still reaches a real control. `paintSessionActions()` is the ONLY writer
// of `disabled`, so the busy contract (a submit in flight / an un-booted catalogue / an
// archived harness) is one rule for every copy — and a run is deliberately NOT part of it.
const sessionNew = el('button', 'new-session session-new', '+');
sessionNew.type = 'button';
sessionNew.disabled = true;
sessionNew.title = 'New session';
sessionNew.setAttribute('aria-label', 'New session');
// Same temporal-dead-zone discipline as the cycler below: `newSession` is a module-level
// `const` declared far away, so the arrow defers the read to click time.
sessionNew.addEventListener('click', () => newSession());

// R2 (T9): one painter for the title trigger's state. The button is ALWAYS a real dialog
// trigger now: the chat head opens the harness details (whose Sessions dashboard is the
// LAST section, under the details divider — R3), and the tools view opens that dashboard
// directly. T9 removed the header pill
// strip that used to stay reachable while Tools owned the centre, so disabling this button
// in the tools view would have left the reader with no way to a saved conversation from
// there — the entry point stays, only its scope and tooltip change.
const paintHeadTitleTrigger = (mode: 'harness' | 'sessions'): void => {
    headTitleButton.disabled = false;
    headTitleButton.setAttribute('aria-haspopup', 'dialog');
    // The tools head names the catalogue or a tool, so the popup it opens is the session
    // dashboard, never "harness details" for a harness the head is not describing.
    headTitleButton.title = mode === 'sessions' ? 'Show sessions' : 'Show harness details';
};

// The open harness-details layer, if any. One at a time (a second open would stack a
// duplicate description), and every navigation path closes it so a dialog can never
// describe a harness that is no longer selected (R2).
let harnessDialog: DialogHandle | undefined;

const closeHarnessDialog = (): void => {
    harnessDialog?.close();
};

// ---------------------------------------------------------------------------
// Session pill bar (T3/R1, reshaped by T9)
// ---------------------------------------------------------------------------
//
// R1 (T3) moved the session directory OUT of the right rail; T9 moved it one step further
// and made it the Sessions dashboard of the harness details dialog (the layer the title
// button opens) AT EVERY WIDTH. The header keeps only the compact cycler and its `+`, so
// exactly one strip is ever live: the one inside an open dialog.
//
// A bar is registered while it is in the page and dropped when its root is disconnected
// (a closed dialog adopts its body, then removes it), so the painter never touches a
// detached node.
//
// R3: no create control any more — the dashboard lists conversations (select / delete) and
// the header owns "start a new one", so the bar is its list element alone.
type SessionPillBar = {
    element: HTMLElement;
    list: HTMLElement;
};

const sessionBars = new Set<SessionPillBar>();

// The dialog's bar, kept explicitly so `onClose` can unregister it the moment the layer
// is gone (the `isConnected` prune below is the safety net, not the mechanism).
let dialogSessionBar: SessionPillBar | undefined;

// Every bar whose DOM is still in the document. Painting only these keeps a closed
// dialog's detached strip out of the render loop.
const liveSessionBars = (): SessionPillBar[] => [...sessionBars].filter((bar) => bar.element.isConnected);

// Build the dashboard strip. T9 leaves exactly one variant in the page (the dialog's), so
// the class hook is fixed rather than chosen per call site; the behaviour and the markup
// are identical wherever it is rendered, which is what keeps the dashboard the one
// authoritative directory view.
//
// R3: the dashboard's `+` is GONE. A session cannot be CREATED from inside this dialog —
// only opened and deleted — because the create action belongs to the header, where the
// harness the new conversation would inherit is the thing on screen. The one remaining
// `.new-session` in the page is therefore the header's (`sessionNew` above), and
// `paintSessionActions` has exactly one control to arm.
const createSessionPillBar = (): SessionPillBar => {
    const element = el('div', 'session-pills-bar session-pills-bar-dialog');
    const list = el('div', 'session-pills');
    list.setAttribute('role', 'list');

    // R4 (T9): the manual Refresh control is GONE. Nothing about the refresh BEHAVIOUR
    // changes — `refreshSessions()` still re-reads the directory on boot, after a stale
    // remembered id, and on the other automatic paths, and every mutation repaints through
    // `renderSessions()` — so a hand-held ↻ button was the only thing left to remove.
    element.append(list);

    const bar: SessionPillBar = { element, list };
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

// T38: the lazy usage fold for the totals row. A directory row is metadata and counters —
// it carries NO token figures (../shared/harness-api.ts:807-809), so on a page of rows the
// honest answer for "input" / "cache" is "not reported" (ui/usage-summary.ts). The server's
// own per-conversation fold (`GET /sessions/:id/usage`, ./view-api.ts `readUsage`) is the read
// that turns that into a figure, and it belongs to THIS dialog: it is issued when the details
// dialog is open, once per conversation, and never at boot — a closed dialog reads nothing
// back, and a history the reader never opened costs no request.
//
// A conversation whose turns are on screen needs no fold: its rows already carry the per-turn
// tallies the helper sums. `usageInFlight` is the single-flight guard, so a repaint storm
// (every streamed frame repaints these figures) cannot turn into a request per frame, and a
// failed fold leaves the figure absent — "not reported" stays true, which is a different fact
// from zero.
const usageFolds = new Map<string, HarnessUsage>();
const usageInFlight = new Set<string>();

const hydrateDialogUsage = (): void => {
    for (const entry of sessionDirectory()) {
        const session = entry.session;

        // Nothing to fold: a conversation that never ran a task reports no tokens, and one
        // already folded or already in flight needs no second read.
        if (session.turnCount === 0 || session.turnCount === undefined) continue;
        if (usageFolds.has(session.id) || usageInFlight.has(session.id)) continue;

        usageInFlight.add(session.id);

        void readUsage(session.id).then(
            (fold) => {
                usageInFlight.delete(session.id);

                // `usage` is absent when NO turn ever reported a tally
                // (../shared/harness-api.ts:1358-1368): that is the honest state, so nothing is
                // stored and the figure stays "not reported" rather than becoming 0.
                if (fold.usage === undefined) return;

                usageFolds.set(session.id, fold.usage);
                paintHarnessDialogStats();
            },
            () => usageInFlight.delete(session.id)
        );
    }
};

// The totals for the conversation set the dialog is describing, from the one directory
// projection (`sessionDirectory()`), so the pills and the figures are the same set.
//
// T38: the mapping also fixes what a row IS. A directory row carries a turn COUNT and an
// empty window (`sessionViewOf`'s rule, ./view-api.ts:151-152) — that is not a loaded
// history, and ui/usage-summary.ts reads a PRESENT `turns` as exactly that (usage-summary.ts
// :156-161), which would make every row look "fetched and silent" and print an honest zero
// for a conversation whose rows were never read. So the window is passed through only when it
// actually holds turns; otherwise the row stays a summary, the helper reports it as pending
// (`pending`, usage-summary.ts:134-137), and the server's own fold is what turns that into a
// figure. A row whose fold has been read contributes the aggregate; nothing is invented.
const harnessDialogSummary = (): SessionUsageSummary =>
    summarizeSessionUsage(
        sessionDirectory().map((entry) => {
            const session = entry.session;
            const fold = usageFolds.get(session.id);

            // T43: the empty window has to be REMOVED, not just left out of the spread.
            // `sessionViewOf`/`sessionRowOf` always publish `turns: []` for a directory row
            // (./view-api.ts:151-155), and `loadedTurns` reads a PRESENT array — even an
            // empty one — as "history loaded" (./ui/usage-summary.ts:96-98, :159), which
            // classified every compact row as DETAILED-with-nothing-to-report. That made the
            // state-2 aggregate below unreachable: the lazy `/sessions/:id/usage` fold was
            // fetched and cached, then quietly ignored, so the totals showed only the
            // conversation whose rows happened to be on screen. Destructuring the window out
            // is what leaves the row a SUMMARY, exactly as the wire describes it.
            const { turns: rowWindow, ...rest } = session;
            const loaded = (rowWindow ?? []).length > 0 ? rowWindow : undefined;

            return {
                ...rest,
                ...(loaded === undefined ? {} : { turns: loaded }),
                ...(fold === undefined ? {} : { usage: fold })
            };
        })
    );

// The live `<p>` inside an OPEN dialog, kept so a repaint can touch ONLY these figures.
// `renderSessions()` is the single painter every snapshot already flows through
// (`applySnapshot`/`upsertSession`), and replacing the children of one `<p>` cannot move
// focus or scroll — unlike a full body rebuild, which would reset the reader's place on
// every streamed usage event.
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

    // T38: painting the figures is also the moment it is worth READING them — this painter
    // only runs while the details dialog is on screen, and a directory row carries no token
    // figure at all. See `hydrateDialogUsage` for the bounded, once-per-conversation rule.
    hydrateDialogUsage();

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

// The dialog's body. R3 (T9) put the Sessions dashboard at the TOP because choosing a
// conversation was the action the reader came for; R3 (this pass) moves the SAME section to
// the BOTTOM, under a semantic `<hr>` that separates "what this harness is" from "the
// conversations it holds". The details/stats/meta/note block is the answer to "what am I
// looking at", and the directory is the list you scroll to when you want to go somewhere
// else — a divider, not a reorder into a second heading, is what makes that readable.
//
// The dashboard is still here at EVERY width (the header carries no directory), it keeps
// the same factory, and selection plus deletion keep working exactly as before. Only the
// CREATE affordance is gone from this layer (see `createSessionPillBar`), because a session
// cannot be created here.
//
// T6's breakpoint-shaped body stays gone: the body does not depend on the width it was
// built at, so a dialog that survives a resize needs no rebuild.
const harnessDetailsBody = (display: HarnessDescriptor | undefined): HTMLElement => {
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

    // Registered as soon as it exists (the painter walks `sessionBars`, not the DOM
    // order), and appended LAST by `appendSessions` below — registration and position are
    // independent here, which is what lets R3 reorder without touching the paint path.
    const bar = createSessionPillBar();
    dialogSessionBar = bar;

    // One place builds the section (caption + strip) so both shapes of this body — the
    // harness dialog and the tools-view Sessions-only dialog — render the same nodes.
    const appendSessions = (): void => {
        body.append(el('h3', 'harness-details-section', 'Sessions'), bar.element);
    };

    // T9: with no harness selected (the last one was deleted, or the server has none) or
    // while the tools view owns the head, the saved conversations are the only thing this
    // layer can honestly offer: an archived record has no rail row and no chat card, and a
    // tools head names a tool rather than a harness. The body then stops after the
    // dashboard, because every section above it would describe a harness the reader is not
    // looking at — and a divider with nothing ABOVE it would be decoration, so there is
    // none in this shape either.
    if (display === undefined) {
        appendSessions();

        return body;
    }

    if (display.description.length > 0) {
        body.append(el('p', 'harness-details-description', display.description));
    }

    // Aggregate totals for the selected harness (R2: existing metadata only). Omitted
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

    // R3: the rule that closes the details block, then the directory under it. A real
    // `<hr>` (not a border on the caption) because the break is in the CONTENT: styling is
    // one rule in ui/dialog.css, `.dialog-body > .harness-details > .harness-details-divider`.
    body.append(el('hr', 'harness-details-divider'));
    appendSessions();

    return body;
};

// Open the details dialog for the harness that is selected RIGHT NOW, or — while the tools
// view owns the centre (T9) — the Sessions dashboard on its own. Content is the selected
// display descriptor's description plus the same metadata the rail rows show
// (`harnessMeta`); nothing else is invented (R2: existing metadata only).
const openHarnessDetails = (trigger: HTMLElement): void => {
    // T9: `current` is undefined when the roster is empty (the last harness was deleted),
    // and the saved conversations of a deleted harness are still reachable — from THIS
    // layer. The tools view takes the same Sessions-only shape: its head names a tool, not
    // a harness, so the harness copy below the dashboard would describe something the
    // reader is not looking at.
    const instance = current;
    // T7 (R2): the Plugins view replaces the head exactly like the tools view does, so
    // it takes the same Sessions-only layer — the heading names a catalogue, not a
    // harness, and harness copy below it would describe something off screen.
    const display =
        instance === undefined || showingTools || showingPlugins
            ? undefined
            : instance.frozen ?? instance.descriptor;
    const body = harnessDetailsBody(display);

    let handle: DialogHandle | undefined;
    handle = openDialog({
        title: display?.title ?? 'Sessions',
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
    // R2 (T9): the trigger works in BOTH heads. Chat opens the harness details; the tools
    // view opens the same session dashboard, because the header strip that used to stay
    // reachable there no longer exists. A second press closes the layer instead of stacking.
    if (harnessDialog !== undefined) {
        closeHarnessDialog();
        return;
    }
    openHarnessDetails(headTitleButton);
});

// R1 (T3) / R1 (T9): the header's only children are the title line and the note. The
// title row is `title`, the session cycler, the compact `+`, then the id/group line — one
// compact, functional session header at desktop AND on a phone, with the directory itself
// behind the title button.
//
// RELOCATION (this change): the two catalogue toggles join that line as a right-aligned
// group AFTER the id span, because each pane they open is presented for the SESSION
// currently in view (the header is repainted per session — one pair for the session shown,
// not one per session). What is NOT session-scoped is what those panes WRITE: their
// enablement switches are deployment-wide (every conversation, from the next turn), and the
// genuinely per-session tool state — `/sessions/{id}/tools` — lives on a surface these panes
// never call. `harnessTitleTools` mirrors the `.topbar-right` wrapper convention (a flex
// group the stylesheet positions as one unit); `margin-left: auto` pushes it flush right.
//
// The two buttons are MOVED, not rebuilt: `toolsToggle`/`pluginsToggle` are the same nodes
// created in the topbar assembly above, so `paintToolsToggle`, `paintPluginsToggle` and the
// enable/disable gating in `paintControls` keep working untouched. `DOM.append` on an
// already-parented node relocates it, so nothing is left behind in `.topbar-right`.
//
// The toggles stay reachable in BOTH catalogue views: `setToolsView`/`setPluginsView` hide
// the composer and the agent slot, never `mainHead` — they RETITLE it through
// `paintToolsHead`/`paintPluginsHead` — so the second press that closes a pane is always on
// screen, and both views hand focus to the toggle that performed the switch.
const harnessTitleTools = el('div', 'harness-title-tools');
harnessTitleTools.append(toolsToggle, pluginsToggle);

titleRow.append(headTitle, sessionCycle, sessionNew, headName, harnessTitleTools);
mainHead.append(titleRow, headNote);

const agentSlot = el('div', 'agent-slot');

// `stage` is the single centre surface: the transcript, the global tools view or a
// status pane. It is NOT a tab panel (R3): the title-row Tools toggle points at it with
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
//   - `@query` folders: the SAME debounced beat also reads the `files` list operation for the typed
//     scope (glob never yields directories), because folders are listed FIRST —
//     navigation on top, matching file hits below. Both answers carry the same
//     sequence, so they are painted together or not at all.
//   - `#query`: the board's REAL root+nested agent blocks (view.blocks()), deduped
//     by label with the latest occurrence winning (the server's plain-text
//     resolution rule). No network.
//
// A THIRD source fills the same list: `@query` also asks `files` (list) for the folders
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

// Page size for the folder read. A `files` list defaults to 200 entries per page, which
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
            // Folders come from the `files` list operation (glob walks past directories), read
            // in parallel with the glob: one debounce still, two answers. The folder
            // read NEVER fails the picker — an unreadable half-typed directory or an
            // unconfigured tool just contributes no folder rows, and the glob keeps
            // ownership of the error note.
            const folders = callTool('files', { ops: [{ op: 'list', path: scope.directory, limit: FILE_FOLDER_LIMIT }] }).then(
                (reply) => (reply.ok ? folderPathsOf(filesListEntriesOf(reply.result), scope) : []),
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
    records: ReadonlyMap<string, { status: string }> | undefined,
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
//
// Named, not inlined, because a rail drag reflows the SAME column: the seams below
// change the chat's width without a window resize, and everything measured against it
// (the composer's grown height, the scratch button's anchor, the notched label) has to
// be re-read the same way.
const reflowLayout = (): void => {
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
};

window.addEventListener('resize', reflowLayout);


// Tool-panel hosts (R21.3). Three named locations, one renderer:
//   - `center` sits above the turn grid, inside the chat column;
//   - `scratch` is the right rail's primary board (the rail holds it ALONE: T3/R1 moved
//     the session directory out of the rail, and T9 keeps it only in the title dialog);
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
// R1 (T3) / R3 (T9): the sessions directory left the rail entirely — the header now carries
// only the compact cycler and its `+`, and the directory itself is the Sessions dashboard of
// the dialog the title button opens. The right rail is therefore the scratch board ALONE.
// Its accessible name says exactly that, and the phone trigger for it is the floating
// `.scratch-fab` (R3) rather than a header disclosure.
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

// The two seams (user request: "the left and right panel bars should be draggable").
// They are grid children, NOT children of a rail: a rail is a scroll box, so a handle
// inside it would slide away with the content, and only a track sibling can change the
// track the rail is sized by. Each one writes `--rail-left-width` / `--rail-right-width`
// on `shell` while dragged; CSS owns the layout and the fallbacks, nothing is saved, so
// a reload (or a double-click on a seam) is back to the default widths.
const railResizers = createRailResizers({
    shell,
    // Dragging a rail reflows the chat column without a window resize, so the composer
    // and everything measured off it re-read their geometry exactly as they do on resize.
    onWidthChange: reflowLayout
});

// R3 (T3): the scratch FAB is mounted in the shell but is NOT a grid item — CSS makes it
// `position: fixed`, so it takes no track and cannot disturb the three-column layout.
// T8 changed the stacking decision: the button is painted ABOVE the backdrop (2) and both
// drawers (3) with `z-index: 4`, because it is the only way onto the scratch board and the
// reader must be able to press it while the harness drawer is open — one press then SWITCHES
// drawers in the single sidebar slot instead of the press being swallowed as an outside
// dismiss. DOM order still puts it before the backdrop; the layering is CSS's, and the
// backdrop keeps its own click handler for every other outside press.
shell.append(leftRail, railResizers.left, center, railResizers.right, rightRail, scratchFab, railBackdrop);
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
    // T9: nothing about the harness dialog is breakpoint-shaped any more — its Sessions
    // dashboard and the header's session controls are identical at every width — so
    // crossing the line only has to re-apply the drawer semantics below.

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
    // T11: the harness's per-agent INSTRUCTION overrides, read on the ONE explicit action
    // that needs them (opening the configuration dialog). A `/views` document OMITS
    // `harnessDefinition.agentInstructions` (../server/protocol.ts:655-663) because that
    // map is instruction text, so the dialog must not assume the textarea it seeds is the
    // stored text. Undefined = never read; a harness whose read failed or answered nothing
    // keeps the document-derived map, which is the pre-T11 behaviour rather than a blank.
    harnessInstructions?: Record<string, string>;
    // T32: the harness's per-agent MODEL overrides, read on the same explicit action
    // (opening the configuration dialog). A definition CARD omits `agent_models`
    // (../shared/harness-api.ts:418-433), so the model selects would otherwise show no
    // override for a harness that has one. Same rule as `harnessInstructions`: undefined
    // means never read, and a failed read keeps the document-derived map.
    harnessModels?: Record<string, string>;
    // T4/R2: the harness's per-agent identity COLOR map, read on the same explicit action
    // (opening the configuration dialog, where `GET /harnesses/:name` is the only publisher
    // of `agent_colors`). A definition CARD never states it, and a COMPILED view states it
    // only when the conversation's frozen definition carries one, so this cache is the
    // place an explicit colour lands for a live harness AND the place a future
    // SESSION-level colour map would land. Same rule as `harnessModels`: undefined = never
    // read, and a failed read keeps whatever this browser already had.
    harnessColors?: Record<string, string>;
    // Tools toolRequest enabled for this session (SessionSnapshot.discoveredTools),
    // shown on the tools view's session note (R21.2 — there is no core dropdown any
    // more). Refreshed by the snapshot a core call triggers.
    discovered?: readonly string[];
    // Per-instance live activity set for the tile rings. Never a module global:
    // two harness views must not share who is busy.
    activity: Set<string>;
    // Tool-contributed panels for THIS instance/session (R21.3), keyed by
    // tool+panel id. Recomputed from the server's COMPILED state on every applied
    // view (reload, poll, session open, enqueue answer) and upserted live from the
    // `step:set`/`pending:set` ops the display wire sends — plus from manual tool
    // results, which are already full panel documents. Never shared across
    // instances: switching harness can neither show nor leak another chat's board.
    panels: Map<string, PanelMedia>;
    // Panel cards the READER expanded (T5 R2). A full panel document arrives only
    // from an explicit click on a summary card's action, and is cached here so a
    // later snapshot re-derivation (which recomputes `panels` from the compact rows)
    // restores the expansion instead of silently collapsing it back to a summary.
    panelDetails: Map<string, PanelMedia>;
    // Panel keys with a detail request in flight, so one press issues exactly one
    // request and a double click cannot stack two answers.
    panelRequests: Set<string>;
    // Work the server has not finished for this instance's session (R4): a
    // running task, a retained queued task, or a non-zero queueDepth. Drives the
    // composer's stop state (R10) and the topbar pill. The composer is NOT gated
    // by it: submitting another task is how a queue is built.
    pending: boolean;
    // The latest authoritative COMPACT rows for this session, keyed by id (T5 R1:
    // a `TurnSummary`, never a recorded turn). Kept so pending state, activity and
    // reference validation answer without a document walk.
    records: Map<string, TurnSummary>;
    // The compiled document store for this instance (T5 R1/R3). It owns the
    // `SessionView` the shell renders and applies the ops frames to it, so state
    // and DOM are updated by ONE addressed mutation per frame — and the only place
    // a raw event can enter this browser is the explicit export read below.
    store: ViewStateStore;
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
    // R7: the last tombstone-filtered RAW document this page read, and a read happens
    // ONLY on an explicit transcript/export action (T5 R3). Not used for rendering
    // (the board owns that, from the compiled view below); it is the source the JSON
    // transcript quotes and the lossless baseline delete protection can fall back to.
    // Cleared whenever the instance points at a different/no session.
    snapshot?: SessionSnapshot;
    // The compiled document this instance currently renders (T5 R1). A convenience
    // mirror of `store.view()` — the store remains the mutation point, so an ops
    // frame and a drain frame reconcile the SAME object. Named `compiled` (not
    // `view`) because `Instance.view` is the DOM view wrapper.
    compiled?: SessionView;
    // T24: the lazy display plane for THIS conversation — the single bounded queue
    // (4 concurrent, deduped, generation-guarded) that decides which display trees
    // are fetched, and the only way an older page is ever walked. Created with the
    // instance because it reads the instance's live session id and document; optional
    // only because it is built after the object literal (it reads the id eagerly).
    plane?: DisplayPlane;
    // The live flow subscription for the ONE tile the reader has open (T24). The
    // contract publishes `display.ops` on the `turn` scope ONLY
    // (../shared/harness-stream.ts:201, harness.swagger.yaml:2429), so a session-level
    // subscription cannot deliver streamed text; this is the connection that does.
    // Aborting it unsubscribes and never cancels a task.
    turnWatch?: { turnId: string; sessionId: string; controller: AbortController };
    // T3 (R2/R3): the conversations this card's reader has OPEN, one live `thread`-scope
    // subscription each. Keyed by thread id; each entry owns its AbortController, so a
    // collapse releases exactly one registration and a session switch releases all of
    // them. This is the lazy counterpart of the session subscription: before it, the only
    // way a thread's own state reached the page was the whole-roster read every frame
    // triggered, and the only way its transcript arrived was the per-open fan-out.
    threadWatches?: Map<string, { sessionId: string; controller: AbortController }>;
    // T3b: the newest `thread.upsert` stamp this page has APPLIED for each roster row,
    // keyed by thread id (the value is the frame's server-clock `at`). A resumed stream
    // replays from its retained window, and a document re-read (a poll, a resync, a
    // reopen) can install a NEWER row in between — so a frame that arrives afterwards can
    // be OLDER than the row on screen. `applyThreadRowPatch` refuses it with this mark,
    // exactly as `applyView` refuses a stale document with `snapshotMark`. The frame's
    // `cursor` is used for the resume position only (the client tracks those itself), so
    // only `at` is retained here.
    threadRowMarks?: Map<string, number>;
    // T3: the bounded transcript queue for THIS conversation (2 concurrent, deduped,
    // generation-guarded, ./view-api.ts). Rebuilt when the instance points at another
    // session, and invalidated whenever the realtime plane loses its position, so a
    // document read before an outage is never painted after it.
    transcripts?: { sessionId: string; loader: ThreadTranscriptLoader };
    // T3 (R1): set while a LOAD is being applied. A loaded conversation starts with every
    // card collapsed (`collapseForLoad`, T21 R22), but the board's own first-content rule
    // opens the newest surface inside `applyView` — following it during that window would
    // pull a transcript for a conversation the reader never opened. The shell clears this
    // flag right after the collapse and syncs the followed set once, from the state that
    // the reader actually sees.
    deferFollow?: boolean;
    // T44: the turns whose STALE display tree this instance has already re-read because a
    // settling row arrived without a flow frame (see `refreshUnopenedTree`). Scoped to the
    // session id so a conversation switch starts the budget over; one bounded tree read per
    // turn per open, never a per-frame read.
    reloadedTrees?: { sessionId: string; ids: Set<string> };
    // T52: the turns whose compact ROW this instance has already re-read because its submit
    // receipt could not describe the tile (a steer's text, a new thread's label — see
    // `refreshReceiptRow`). Same scoping rule as `reloadedTrees`: one bounded row-page read per
    // turn per open conversation, never one per frame.
    reloadedRows?: { sessionId: string; ids: Set<string> };
    // R2: the turns whose tree read is IN FLIGHT right now (see `reloadTurnTree`). Unlike
    // `reloadedTrees`, this is not a budget — it is released as soon as the answer lands,
    // so it dedupes only CONCURRENT identical reads (the three recovery paths that fire on
    // one drop) and never blocks a later freshness re-read after a real reconnect.
    treeReads?: { sessionId: string; ids: Set<string> };
    // R2/R4: the display loader's generation at the moment the current document's trees were
    // adopted (see `carryDisplays`). A mismatch means the cache was invalidated since, so the
    // trees the last document painted must not survive into the next one.
    treeGeneration?: number;
    // T9 (R7): the ONE pending lane repaint for this conversation (see
    // `scheduleDisplayRefresh`). One entry per instance, re-armed by every signal that
    // arrives before it fires — that re-arm IS the coalescing — and released when it runs,
    // when the conversation is released, and when the page goes away.
    displayRefresh?: DisplayRefreshPass;
};

const instances = new Map<string, Instance>();
let current: Instance | undefined;
let selectedName: string | undefined;
let presetDescriptors: readonly HarnessDescriptor[] = [];
let agentLibrary: readonly AgentDescriptor[] = [];
// A row of the session directory, read-only by shape.
//
// The display wire's `SessionViewSummary` is what the rail ACTUALLY holds (T5 R1),
// and `SessionSnapshot` satisfies the same fields — every helper below reads header
// figures, thread ids and turn STATUS/USAGE only, never `events` or `displays`. One
// structural type therefore serves both surfaces, which is also the proof that the
// rail needs no recorded events at all.
type DirectoryTurn = {
    id: string;
    status: string;
    updatedAt: number;
    index?: number;
    startedAt?: number;
    threadId?: string;
    threadLabel?: string;
    usage?: HarnessUsage;
};

type SessionRecord = {
    id: string;
    harness: string;
    status: string;
    model: string;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
    queueDepth?: number;
    threads?: SessionThread[];
    // A directory ROW states a turn COUNT, never the turns themselves
    // (../shared/harness-api.ts:807-809), so the list is optional by contract: an absent
    // field means "this read never loaded a history", and every reader treats that as no
    // live record (`?? []`) instead of crashing or assuming an empty queue.
    turns?: DirectoryTurn[];
    harnessDefinition?: HarnessDescriptor;
    agentModels?: Record<string, string>;
    discoveredTools?: string[];
    // The server's own counter, carried by every session ROW
    // (../shared/harness-api.ts:822-823). It is what tells the details dialog whether a
    // conversation has anything to fold at all (`hydrateDialogUsage`), and it arrives through
    // `sessionRowOf` (./view-api.ts:159) — a raw row's `turn_count` never reaches the shell in
    // any other spelling.
    turnCount?: number;
};

// The session directory. `SessionViewSummary` is the compact counterpart of
// `SessionSnapshot`: same header fields the rail, the pills and the harness totals
// read, and NO event list anywhere (which is the payload this surface removes).
let sessions: SessionRecord[] = [];
let currentTool: ToolRowEntry | undefined;
// R3 — the row shape the global tools view actually paints.
//
// WHY THIS IS A LOCAL EXTENSION AND NOT A PROTOCOL CHANGE
// ------------------------------------------------------
// `GET /tools` rows state the enablement figure (../shared/harness-api.ts `ToolSummary`)
// and ./api.ts `toolRowOf` maps it through, but the shell's row type is the server
// protocol's `ToolDescriptor` (../server/protocol.ts:414), which predates the switch and
// is not this surface's to widen. A catalogue entry therefore reaches the pane as
// `ToolRowEntry`: the descriptor plus what `toolRowOf` carried.
//
// The field is OPTIONAL on purpose. A row from a server that never states enablement (an
// older build, or a fixture modelling one) renders NO tick box — the pane only ever shows
// an enablement the server actually reported, never a guessed one.
//
// The corner tick box replaced the old "core" pin: EVERY catalogue entry — the
// harness-owned core set included — is switchable now, so the frontend reads no
// pinned-set flag anywhere and never renders an affordance-less row.
type ToolRowEntry = ToolDescriptor & {
    enabled?: boolean;
};

// The complete server catalogue (core entries included) for the global tools view —
// the ONLY tool listing after R21.2. Boot replaces it from the bootstrap document.
let toolEntries: readonly ToolRowEntry[] = [];
// Which centre view is showing: the chat (transcript + composer) or the GLOBAL tools
// view (catalogue + manual runner). There is no tab strip (R3); the icon-only
// Tools toggle on the harness title row drives this through `setToolsView`.
let showingTools = false;
// T7 (R2): which centre view is showing is a THREE-way exclusive, not a pair of
// independent flags: the chat, the GLOBAL tools view, or the Plugins catalogue. Every
// opener closes the other catalogue (`setToolsView`/`setPluginsView`), so at most one
// of `showingTools`/`showingPlugins` is ever true — and both false is the chat.
let showingPlugins = false;
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
// create/delete locks, but NOT session switching and NOT submission, because leaving a
// working conversation is an unsubscribe (R4) and submitting another task while one runs
// is exactly how the queue is built. `submitting` covers only the short window between
// pressing the submit action and the POST /tasks answer, so a double submit cannot
// create two sessions or two copies of the same task.
let running = false;
let submitting = false;
let booted = false;
// The live queue observer for the selected session, if one is open. Aborting it
// only unsubscribes (the server keeps running) — see api.ts observeSession.
let watch: { instance: Instance; sessionId: string; controller: AbortController } | undefined;
// R3: the ONE number that says what the centre column is supposed to show. It is raised by
// USER NAVIGATION ONLY — three places, each one a thing the reader did:
//   - `openSession` claims a value for itself (the header cycler, a strip pill, the
//     harness-entry pick, the boot restore),
//   - `newSession` (`+ New session` — an empty composer IS a choice),
//   - `selectHarness` (the rail row, creating a harness, the reselect after a harness delete,
//     boot's first selection, and the switch that ends a conversation open).
// `openSession` re-checks the value it captured after EVERY await, so an answer that lands
// late is dropped instead of painted. Everything else — an observer being re-pointed by a
// submit's receipt, a cancel's reconciliation or a resync, a session delete, a tool runner
// closing — is housekeeping and records NOTHING, so it can never cancel a gesture the reader
// is still waiting for.
//
// Why the check cannot be opt-in: `newSession` leaves `instance.sessionId === undefined`, and
// `applyView` adopts a document whenever the card has no pointer (the remembered-pointer boot
// needs exactly that), so a released card is ACCEPTING by construction. Without this counter,
// a `+` pressed while a conversation's read was in flight let that answer re-bind the card the
// reader had just released: the transcript came back, `setBusy(instance.pending)` restored the
// pending figure, and `rememberSession` wrote back the pointer `forgetRememberedSession` had
// cleared. Two rapid opens failed the same way — last RESPONSE won, not last CLICK.
let navigationIntent = 0;

// Records a navigation gesture. The only reader is the `openSession` continuation that
// captured an older value, so raising it costs nothing; a gesture site calls it rather than
// reasoning about whether this particular path could race a read.
const markNavigationIntent = (): void => {
    navigationIntent += 1;
};
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
    // What toolRequest enabled inside that session. Recorded for the runner's own
    // bookkeeping (the refresh path below); the tools pane shows no context note.
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

    const request$ = options?.unload === true ? deleteViewOnUnload(id) : deleteView(id);

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
        const session = await createViewSession(harness, settings);

        // Closed (or superseded) while this request was in flight: this record is not
        // the live playground's context, so it is removed immediately and the caller is
        // told the call did not run. Best-effort: nothing awaits it.
        if (generation !== playground.generation || !showingTools) {
            playgroundSessions.add(session.id);
            void deleteView(session.id).catch(() => undefined);
            return undefined;
        }

        playground.sessionId = session.id;
        playgroundSessions.add(session.id);
        playground.discovered = Array.isArray(session.discoveredTools)
            ? [...session.discoveredTools]
            : undefined;
        // T29: the canonical session row no longer carries `discoveredTools`, so the
        // playground's record of what that session enabled comes from the definition
        // read — fired here, on the surface that owns the context, and never at boot.
        hydratePlaygroundDiscovered();

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
        // Re-read the playground's OWN snapshot. The answer is never applied to an
        // Instance and never enters the sessions roster, so a discovery inside the
        // temporary context cannot repaint or adopt anything in the conversation the
        // reader is looking at.
        const session = await getView(sessionId);
        if (playground.sessionId !== sessionId) return;

        playground.discovered = Array.isArray(session.discoveredTools)
            ? [...session.discoveredTools]
            : undefined;
        // T29: a core call may have just enabled a tool, so this is the one place the
        // figure is REFRESHED (the cache is bypassed), and the source is the definition
        // read the compact row can no longer answer with.
        hydratePlaygroundDiscovered(true);
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

    await answerViewAction(instance.sessionId, input.requestId, input.choice);
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
            saveThreadTranscriptFor,
            // R2 lazy detail. The board calls this ONLY from a chip the reader
            // expanded, and `boundSession` inside the tile already names the session
            // the card was rendered from; the instance id is the fallback for an
            // embedding that has no per-card binding.
            (input) =>
                getStepDetail(
                    input.sessionId ?? instance.sessionId ?? '',
                    input.turnId,
                    input.stepId
                ),
            // T11 R8: the ONE request a context-bar segment costs, and only on the click.
            (input) =>
                getBlockDetail(
                    input.sessionId ?? instance.sessionId ?? '',
                    input.turnId,
                    input.blockId
                ),
            // R1: the per-thread Stop the transcript bar offers while a conversation has
            // live work. Same session resolution as the delete below, minus the tombstones.
            stopThreadForSession,
            // T4/R2: the per-thread Resume the same bar offers while a conversation is
            // `stopped`. Same session resolution as the stop above; the receipt's
            // continuation turn arrives through the stream, not from here.
            resumeThreadForSession
        ),
        activity: new Set<string>(),
        panels: new Map<string, PanelMedia>(),
        panelDetails: new Map<string, PanelMedia>(),
        panelRequests: new Set<string>(),
        pending: false,
        records: new Map<string, TurnSummary>(),
        // One store per instance: two harness views must not share a document, and a
        // session switch resets it rather than patching another conversation's tree.
        store: createViewStateStore(),
        threads: [],
        threadTombstones: new Set<string>(),
        turnTombstones: new Set<string>()
    };

    // T24: the plane and the pane's lazy sources are wired HERE rather than in the
    // literal, because `createDisplayPlane` reads the session id immediately and the
    // id belongs to the object that does not exist until this line has run.
    instance.plane = createDisplayPlane({
        // Read per call: the same card is reused across selections, and a captured id
        // would paint another conversation's tree onto these rows. The STORE is the
        // document's mutation point (see `Instance.compiled`), so the plane writes its
        // adopted trees into exactly the object every renderer reads.
        sessionId: () => instance.sessionId ?? '',
        document: () => renderDocument(instance),
        // A tree that landed, or an older page that was prepended, repaints from the
        // one document this instance already owns.
        repaint: () => repaintPlane(instance),
        // 4 concurrent identified reads — the cap the loader's own rules name
        // (./view-api.ts:592). A 25-row window drains in bounded batches.
        concurrency: 4,
        // The cold tree read also carries the sections' still-running background
        // calls, which the render model cannot express; seeded as their own ops.
        fetch: async (sessionId, turnId) => {
            const cold = await readTurnDisplayWithPending(sessionId, turnId);

            // Stale guard: a tree for a conversation the reader left seeds nothing.
            if (instance.sessionId !== sessionId) return cold.display;

            seedColdPending(instance, turnId, cold.pending);

            return cold.display;
        }
    });

    // The pane now has real lazy sources: trees for what is on screen, one cursor
    // walk per "load older" press, and the two authoritative sources behind an owner
    // question's choices.
    instance.view.bindLazy({
        ensureVisible: (turnIds) => instance.plane?.ensureVisible(turnIds) ?? [],
        loadOlder: () => instance.plane?.loadOlder() ?? Promise.resolve(false),
        hasOlder: () => instance.plane?.hasOlder() ?? false,
        loadingOlder: () => instance.plane?.loadingOlder() ?? false,
        focusTurn: (turnId) => followTurnFlow(instance, turnId),
        // T3 (R2/R3): the board's "what am I showing" report, turned into following.
        followThreads: (threadIds, sessionId) => syncThreadFollow(instance, threadIds, sessionId),
        requestFor: (step) => actionRequestForStep(instance, step),
        loadRequest: (step) => loadActionRequestFor(instance, step),
        actionHydrated: (turnId) => repaintActionCard(instance, turnId)
    });

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
    if (existing !== undefined) {
        existing.descriptor = updated;

        // T11: the dialog-open read caches the SAME map, so an authoritative descriptor
        // replaces that cache too — otherwise a deleted override would resurrect itself from
        // the cached copy (the merge in `agentViewOf` prefers the document per key, and a key
        // the document no longer names would still be readable from a stale cache).
        existing.harnessInstructions = agentInstructionsOf(updated);

        // T4: the identical rule for the identical reason on the COLOUR map. A harness PATCH
        // that clears a colour (`agent_colors: {}`) has to clear the cache as well, or the
        // removed hex would keep painting this conversation's identities from a stale read.
        existing.harnessColors = agentColorsOf(updated);
    }
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
// R3: there is no tab/tablist anywhere. The only visible state is the title-row
// toggle's pressed flag; the stage is a plain region and its accessible name comes
// from the heading inside it (the harness title or the selected tool's name).
const paintToolsToggle = (): void => {
    toolsToggle.setAttribute('aria-pressed', showingTools ? 'true' : 'false');
};

// T7 (R2): the Plugins toggle's visuals, same rule as above (content switching lives in
// `setPluginsView`, declared with the plugin catalogue). Because the two catalogues are
// mutually exclusive this painter ALWAYS disagrees with `paintToolsToggle`: exactly one
// of the two corner buttons can read `aria-pressed="true"`.
const paintPluginsToggle = (): void => {
    pluginsToggle.setAttribute('aria-pressed', showingPlugins ? 'true' : 'false');
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
//
// T5/R1: the paint goes THROUGH the extension runtime instead of writing the hosts
// itself. One call now (a) reconciles the registered shell panels against the session
// on screen — mounting the ones this conversation should show and DISPOSING the ones
// it should not, subscriptions and timers included — (b) hands each host the
// extension nodes it owns, and (c) applies the tool panels, whose card each host now
// asks the kind registry to draw and falls back to the standard card when no kind
// owns it. With both registries empty that is the same three `apply` calls, the same
// nodes and the same hidden/visible state as before.
// The two live panels this app ships (T6): `harness.tasks` above `harness.records`,
// both session-scoped and both `requiresSession`, so neither mounts at boot — the
// board stays exactly as `scratch-board.test.ts` pins it until a conversation is on
// screen, and then each panel mounts ONCE with a real session id to read with. The
// registration is idempotent (re-registering an id replaces it), so a hot reload does
// not stack a second card.
registerBuiltinShellPanels();

const panelRuntime = createPanelRuntime();

// The three hosts, addressed by slot (`ui/panels.ts` owns the slot list). Read per
// paint rather than handed to the runtime once, so the runtime can never hold a host
// the shell has replaced.
const panelHosts = (): Partial<Record<PanelSlot, PanelHost>> => ({
    scratch: scratchHost,
    center: centerPanels,
    left: leftPanels
});

const paintPanels = (): void => {
    const media: readonly PanelMedia[] = current === undefined ? [] : [...current.panels.values()];

    // The session pointer is what scopes a live panel: a switch, a New session or a
    // delete moves this value, and the runtime releases the conversation it came from.
    panelRuntime.paint({ hosts: panelHosts(), media, sessionId: current?.sessionId ?? null });

    // The scratch note explains an empty board instead of leaving a blank section.
    // `ids()` is the TOOL-panel list — a registered live panel never changes this
    // sentence, which is what keeps the rail's copy pinned by scratch-board.test.ts.
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
//
// `keepStatus` is for the AUTOMATIC switch of an automatic conversation open (T24): the
// reader did not gesture, so the app must not erase the confirmation they were told to
// read (e.g. "deleted alpha") the moment the record arrives.
const selectHarness = (
    name: string,
    fallback?: HarnessDescriptor,
    options?: { keepStatus?: boolean }
): void => {
    const descriptor = descriptorFor(name) ?? fallback;
    if (descriptor === undefined) return;
    // R3: pointing the centre column at another harness IS a navigation intent, and this is
    // the one place every such gesture passes through — the rail row, creating a harness, the
    // reselect after a harness delete, boot's first selection, and the switch that ends a
    // conversation open. The bump sits AFTER the descriptor guard so a harness the server no
    // longer reports cannot supersede the open that is still landing.
    markNavigationIntent();

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
    // T7: same rule for the plugin detail dialog — it describes a plugin row that the
    // incoming view does not own.
    closePluginDialog();
    // R2: the details dialog describes the harness being LEFT, so selecting another
    // harness/session closes it rather than leaving stale content on screen.
    closeHarnessDialog();

    // Switching harness closes the global tools view and drops every ring: the
    // activity belonged to the view being left. The deck disclosure also starts
    // collapsed for the new team (R1 default).
    showingTools = false;
    paintToolsToggle();
    // T7 (R2): the Plugins catalogue is left the same way the tools view is, so a
    // harness switch always lands the reader on the new conversation.
    showingPlugins = false;
    paintPluginsToggle();
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
    if (options?.keepStatus !== true) setStatus('idle');
    // Re-derive controls for THIS instance: pending work belongs to its session,
    // and leaving a running conversation simply unsubscribes (work continues).
    setBusy(current.pending);

    // T24: selection cleanup + the lazy reveal. Only the SELECTED pane is on screen,
    // so every other card's focused-turn flow subscription goes with its visibility
    // (a background card never spends an identified read on rows nobody can see), and
    // the rows this pane just showed are the rows whose trees are worth fetching now.
    for (const instance of instances.values()) {
        if (instance !== current) stopTurnFlow(instance);
    }

    followTurnFlow(current, current.view.expandedTurnId());
    current.view.reveal();

    // T24: entering a harness resolves its conversation the way the first load does —
    // its most recently used row (T21 R21) — when this harness has nothing selected yet.
    // Everything that only REDRAWS the current harness (a session open, which arrives
    // here with `sessionId` already bound) is a no-op inside the helper, and so is every
    // later entry, because the reader's own selection wins from then on.
    openLatestOfEnteredHarness(descriptor.name);
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
//   - `running`/`current.pending` means THIS page still carries work whose harness would
//     vanish underneath it — the centre column need not be showing that work (the reader can
//     switch away and the queue keeps running), but the pending figure, the composer's stop
//     state and the observer this page holds all still belong to the team being deleted,
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

        // FIX D: a harness can be deleted while its lane dim pass is PENDING, and the timer is
        // per-instance housekeeping like the two subscriptions above — it must die with the
        // instance, not with the tile that happens to be focused. Without this the timer outlives
        // the map entry, and `runDisplayRefresh` then runs against a disposed document: the stale
        // guard inside it compares `instance.sessionId` (which a disposed instance still reports),
        // so it proceeds to `renderDocument` and `instance.plane?.ensureVisible` on a board whose
        // trees and observer bindings are already gone — the one work the conversation switch and
        // the page teardown at ./main.ts's unload path both take care to cancel.
        cancelDisplayRefresh(instance);

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
            // The playground owns the centre column, so it stays; a direct call still
            // works, and a session-bound one reports the missing context itself (the
            // runner's `no_harness` answer) rather than the pane guessing up front.
            paintToolsHead();
        } else if (showingPlugins) {
            // T7: same for the Plugins catalogue — it is server-wide, not harness-scoped, so
            // the last harness disappearing leaves it in place; only its count note can
            // change (nothing else about a plugin depends on the roster).
            paintPluginsHead();
        } else {
            // Empty roster without crashing: the chat has nowhere to go, so the centre
            // column says what is available instead of showing a dead transcript. The
            // playground stays reachable from the title-row Tools toggle for direct calls,
            // and `+ New` is the way back.
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
            'Saved sessions for the harness you deleted are still on the server; open them from the Sessions list behind the title above.'
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
        deleted = (await deleteHarness(name)) !== undefined;
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
        // A run locks NO session or harness navigation (R4): the queue is server-owned, so
        // leaving a working conversation is an unsubscribe. The two windows that genuinely
        // race are the ones `paintControls` re-derives for this same map (`submitting`,
        // `!booted`) — the create-time paint has to agree with that repaint, not self-heal
        // afterwards.
        button.disabled = submitting || !booted;
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
    //
    // T7 (R2): the Plugins catalogue owns the head under the same contract, and the
    // same restore path applies (`setPluginsView`/`selectHarness` clear the flag first).
    if (showingTools || showingPlugins) return;

    const locked = instance.sessionId !== undefined;

    // The title text lives INSIDE the details button (R2); writing the button's text
    // node keeps the heading's textContent identical to the visible title, which the
    // head assertions read, without replacing the button itself.
    headTitleText.textContent = display.title;
    // The chat head always describes the selected harness, so its details dialog is
    // meaningful here (the tools view paints the Sessions-only variant instead).
    paintHeadTitleTrigger('harness');
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
    // T4: teach the palette THIS view's colours before the button is built — `createAgentControl`
    // paints the primary's identity through the module state, so configuring afterwards would
    // leave the previous conversation's hex on screen (R2/R4).
    configureAgentColorsFor(view);
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

// The per-agent INSTRUCTION map this browser believes is STORED, in precedence order:
// whatever the document states wins per key (an unredacted server, or a frozen definition
// that carries its own map), and the copy read on the configuration dialog's explicit open
// (`instance.harnessInstructions`, ./api.ts `getHarness`) fills the keys a compiled view
// omits (../server/protocol.ts:655-663).
//
// Both the dialog's seed and every harness PATCH restate THIS map, and that is the whole
// point of keeping it in one place: the server REPLACES `agentInstructions`, so restating
// only the fields one frame happened to carry would silently wipe another member's override.
// T7b (R6): the precedence FLIPS for a saved conversation. A session's `harnessInstructions`
// cache is not a second-hand copy of the template — it is the roster read's LIVE text, fetched
// per member from `GET /sessions/{id}/agents/{agent}/instruction` (./api.ts
// `getSessionAgentInstruction`), and it is what this conversation actually runs. The frozen
// definition's `agent_instructions` map is the CREATION-TIME text: still the fallback for a
// member the read has not answered for (a legacy server with no roster route, or a first paint
// before the read lands), but it must never overwrite text this conversation saved afterwards.
// Without a session the rule is unchanged: the document states the stored map, so it wins.
const storedInstructionsOf = (display: HarnessDescriptor, instance: Instance): Record<string, string> =>
    instance.sessionId === undefined
        ? { ...(instance.harnessInstructions ?? {}), ...agentInstructionsOf(display) }
        : { ...agentInstructionsOf(display), ...(instance.harnessInstructions ?? {}) };

// T32: the same precedence for the per-agent MODEL map, and for the same reason. A card
// omits `agent_models` (../shared/harness-api.ts:418-419), so the only complete view of
// what each member runs is the document plus the definition the dialog's open read
// produced (`instance.harnessModels`, ./api.ts `getHarness`). Both the selects and every
// harness PATCH restate THIS map: the server replaces the whole field, so writing only
// what one frame happened to carry would silently drop another member's override.
//
// Two writers read it, and that is the contract the sentence above states:
//   - `agentViewOf` builds `view.models` from it, and `applyAgentConfiguration` merges the
//     dialog's model deltas onto `view.models` and compares the guard against the same map;
//   - `patchAgents`'s `sendsModels` flag asks it whether anything is stored, which is what
//     makes clearing the LAST override send an explicit `agent_models: {}` instead of
//     omitting the field (R3).
const storedModelsOf = (display: HarnessDescriptor, instance: Instance): Record<string, string> => ({
    ...(instance.harnessModels ?? {}),
    ...agentModelsOf(display)
});

// T4/R2: the per-agent identity COLOR map this browser believes is configured, with the
// same precedence as the two above: whatever the DOCUMENT states wins per key (a frozen
// definition that carries its own map, or an unredacted server), and the copy read on the
// configuration dialog's explicit open (`instance.harnessColors`, ./api.ts `getHarness`)
// fills the keys a definition CARD omits (../shared/harness-api.ts:422 `HarnessCard` has no
// `agent_colors` — only the identified read publishes it).
//
// Unlike the model map, colors are NOT restated on a write: the shell never edits one, so
// this is a read-only projection of display metadata. A member it omits is uncolored, and
// ./ui/agent-color.ts derives that agent's tone deterministically (R3).
const storedColorsOf = (display: HarnessDescriptor, instance: Instance): Record<string, string> => ({
    ...(instance.harnessColors ?? {}),
    ...agentColorsOf(display)
});
type AgentView = {
    display: HarnessDescriptor;
    members: string[];
    primary: string;
    locked: boolean;
    // TEAM editing (promotion/add/remove) plus the instruction editor. R5/R6 (T7b): a saved
    // session is NOT locked any more — it edits its OWN team, models and prompts. Only an
    // in-flight run or a session-creating submit locks the controls, because those windows
    // race the roster the next request runs.
    editable: boolean;
    // Per-member EFFECTIVE model (override or session/global fallback).
    models: Record<string, string>;
    // The stored per-agent INSTRUCTION overrides (T3). Effective text = this map
    // first, else the trusted catalogue instruction (main.ts pairs it with
    // `agentLibrary`, exactly the way the dialog's textarea is seeded).
    instructions: Record<string, string>;
    // T4/R2: the stored per-agent identity COLORS (explicit hexes only; an agent this map
    // omits is uncolored and gets its deterministic palette tone). Every painted surface
    // reads it through ./ui/agent-color.ts's module state, which `configureAgentColorsFor`
    // below refreshes from THIS field — that is why the view carries it at all: the
    // composer button, the dialog badges and the transcript tiles are three different
    // components, and only this one map can keep them agreeing (R4).
    colors: Record<string, string>;
    // R5/R6/R7 (T7b): what the DIALOG is allowed to do, derived once here so the composer
    // button, the dialog and the write path can never disagree about the scope.
    //   - `scope` is where a save lands: 'session' edits THIS conversation's roster,
    //     models and prompts; 'harness' edits the template new sessions start from.
    //   - `allowCustom` offers the `[+]` "New agent" name field (R7) — only a session
    //     accepts an agent the catalogue never advertised.
    //   - `canPromote` is false for a saved conversation: its entry agent is fixed
    //     server-side, so the control must not arm a promotion that cannot be written.
    //   - `threadAgents` names the agents a conversation in this session already runs
    //     (R6); each keeps its tab but cannot be removed.
    scope: 'session' | 'harness';
    allowCustom: boolean;
    canPromote: boolean;
    threadAgents: string[];
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
    // T7b (R5/R6): a saved conversation is no longer locked for TEAM/instruction edits — it
    // owns its own roster, models and prompts through `POST/PATCH/DELETE
    // /sessions/{id}/agents...`, and a save there never touches the harness template. Only an
    // in-flight run, or a submit that is creating/answering a session, is a real lock, because
    // those windows race the roster the next request will run. `locked` stays: it is the scope
    // switch (which route, which copy), not the edit gate.
    const editable = !running && !submitting;
    // R6: which agents this session's conversations actually run. The runtime roster omits an
    // agent's DEFAULT conversation (`origin: 'agent'`, ui/threads.ts:58-62), so whatever is
    // listed here is an independent thread, and the server refuses to detach exactly those
    // members (../server/api-reads.ts:953-1011 sets `deletable: false` on the same condition).
    // A harness template has no threads at all, so nothing is in use.
    const threadAgents = locked ? uniqueNames(instance.threads.map((thread) => thread.agent)) : [];

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
    // T32: the definition the dialog's open read produced is merged in, but only for a
    // harness WITHOUT a session. A saved conversation keeps its historical precedence —
    // its own live map (`instance.sessionModels`), then the overrides it was created with
    // — because a live harness override written after the conversation started is not a
    // model that conversation runs.
    const harnessOverrides = storedModelsOf(display, instance);
    const models: Record<string, string> = {};
    for (const name of members) {
        const model = locked
            ? (instance.sessionModels?.[name] ?? overrides[name] ?? instance.sessionModel)
            : harnessOverrides[name];
        if (model !== undefined && model.length > 0) models[name] = model;
    }

    // Per-agent INSTRUCTION text (T3, R4/T7b). ONE box, and THIS map is what seeds it: a
    // member absent from it falls back to the default prompt the catalogue composes (./ui/
    // agents.ts `agentDefaultInstructionOf`), which is the same full text the server runs.
    //
    // T11: a COMPILED view no longer carries instruction text at all (it would ride every
    // frame, ../server/protocol.ts:655-663), so the explicit dialog-open read fills the gap
    // (`instance.harnessInstructions`). Which source wins is the scope question, and
    // `storedInstructionsOf` above states it: a harness template's stored map, or a saved
    // conversation's LIVE per-agent roster text (R6 — a session's prompt is its own, and
    // editing it is now a supported write, not a refusal).
    const instructions = storedInstructionsOf(display, instance);

    // T4/R2: the explicit colors configured for THIS team. Read-only display metadata —
    // nothing here is sent back on a write — and deliberately NOT filtered to `members`:
    // a transcript tile can name an agent the definition no longer lists (a custom session
    // agent, a member removed after the conversation ran), and its configured colour is
    // still the colour the reader learned for it.
    const colors = storedColorsOf(display, instance);

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
    // T7b (R5): the sentence states the SCOPE a save writes, and only names a lock when
    // something really is locked. A saved conversation is no longer described as frozen — it
    // edits its own agents, models and prompts, and the sentence says so the reader cannot
    // send a change to the template by accident. T3's rule still holds: the same string is the
    // accessible reason on every locked control, so it must name the actual cause (a run, a
    // session being created) rather than a stale "saved conversations are read-only" claim.
    const hint = running
        ? 'Wait for the current run to finish before changing the agents or instructions.'
        : submitting
          ? 'A session is being created; try again in a moment.'
          : locked
            ? 'Edits here change this conversation only. The harness template stays as it is.'
            : 'Edits here change the harness template used by new sessions.';

    return {
        display,
        members,
        primary: primaryOf(display),
        locked,
        editable,
        models,
        instructions,
        colors,
        fallback,
        scope: locked ? 'session' : 'harness',
        // R7: only a session can gain an agent the catalogue never advertised; R5: only a
        // template (no session) can move its entry agent, because a saved conversation's
        // primary is fixed server-side (../shared/harness-api.ts `CreateSessionAgentRequest`
        // cannot demote the entry point).
        allowCustom: locked,
        canPromote: !locked,
        threadAgents,
        hint
    };
};

// ---------------------------------------------------------------------------
// Agent identity colours (T4 / R1 + R2 + R3)
// ---------------------------------------------------------------------------
//
// ./ui/agent-color.ts owns ONE module-level mapping, because the reader learns the team by
// colour and every surface (the composer's agent button, the configuration dialog's roster
// badges and `[+]` options, the transcript's tiles and thread labels) has to agree on it.
// Those components call `paintAgentColor(host, name)` with no colour argument — they read
// the configured state — so the SHELL is the only thing that can feed it. This is that
// wiring, and the rule it has to obey is a sequencing rule: configure BEFORE the paint.
//
// Why `resetAgentColors()` runs first, and why that does not cost R1:
//   - an explicit colour belongs to the ACTIVE view. Switching to a conversation whose
//     harness colours `instruct` differently must drop the old hex rather than merge over
//     it (`configureAgentColors` merges by design, so a partial payload can never
//     un-learn a colour on its own);
//   - the automatic tones are re-derived from scratch, from `roster` ORDER plus the pure
//     hash/probe — no clock and no `Math.random` — so the same team painted from the same
//     boot gives the same vector on every reload and on every re-configure. Boot always
//     seeds the trusted library roster FIRST (see `boot`), which is what keeps a saved
//     session's extra agents appending deterministically instead of shuffling the tones a
//     reader already knows.
//
// The roster is the trusted catalogue PLUS this team, in that order: the library is the
// stable part of the identity space, and a team member that is not in the catalogue (a
// custom agent) lands after it.
const configureAgentColorsFor = (view: AgentView): void => {
    const roster = uniqueNames([
        ...agentLibrary.map((agent) => agent.name),
        ...view.members,
        // An explicit colour for an agent OUTSIDE the member list still has to be taught to
        // the palette (a tile for a removed member keeps the colour it wore), and it takes
        // its auto slot in this same deterministic order.
        ...Object.keys(view.colors)
    ]);

    resetAgentColors();
    configureAgentColors({ roster, colors: view.colors });
};

// The boot seed: the trusted library roster, no explicit colours yet. Called once, before
// anything can paint, so a surface that renders before the first conversation is resolved
// still reads real tones rather than the neutral fallback.
const configureBaselineAgentColors = (): void => {
    resetAgentColors();
    configureAgentColors({ roster: uniqueNames(agentLibrary.map((agent) => agent.name)), colors: {} });
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
const agentDialogOptionsOf = (view: AgentView, instance: Instance) => {
    // T4 safety net: this is the one funnel every dialog paint goes through (open AND
    // refresh), so re-deriving the palette here guarantees the roster badges and the `[+]`
    // options wear THIS view's colours even when the caller reached them without a chrome
    // repaint. Idempotent: the same roster and the same map always produce the same vector.
    configureAgentColorsFor(view);

    return {
        members: view.members,
        primary: view.primary,
        agents: agentLibrary,
        editable: view.editable,
        models: agentModelSelectOf(view),
        instructions: view.instructions,
        // R5/R6/R7: the capability flags the dialog renders from — where a save lands, whether
        // `[+]` may take a typed name, whether `Make primary` exists here, and which members
        // a conversation already runs. Derived in `agentViewOf` so the composer's tooltip, the
        // dialog's controls and `applyAgentConfiguration`'s writes all read ONE answer.
        scope: view.scope,
        allowCustom: view.allowCustom,
        canPromote: view.canPromote,
        threadAgents: view.threadAgents,
        // A selection that moves onto an agent the catalog detail walk never covered (a `[+]`
        // addition) asks for its default text on that explicit action. A no-op once
        // the row has text, for a name the catalogue does not carry (a custom session agent),
        // and on re-painting the same tab.
        onRequestPreset: (agent: string) => loadAgentPresetTexts(instance, [agent]),
        activity: [...instance.activity],
        ...(view.hint === undefined ? {} : { hint: view.hint }),
        // T3: the one write path. The dialog never PATCHes on select or on edit.
        onApply: (changes: AgentConfigurationApply) => applyAgentConfiguration(changes)
    };
};

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
        // T4: an explicit colour is part of what the dialog PAINTS (every roster badge and
        // every `[+]` option carries the identity tone), so a colour-only answer has to move
        // the signature — otherwise the definition read that revealed a colour would repaint
        // nothing and the badges would keep the automatic tones.
        colors: view.colors,
        fallback: view.fallback,
        // T7b (R5/R6/R7): the dialog's SHAPE depends on the scope flags, and in a session the
        // removal controls depend on which members a conversation runs. A thread appearing or
        // going away has to move the signature, or an open dialog would keep offering a `Remove
        // from team` press the server is about to refuse with 409.
        scope: view.scope,
        allowCustom: view.allowCustom,
        canPromote: view.canPromote,
        threadAgents: view.threadAgents,
        agents: agentLibrary.map((agent) => agent.name)
    });

// T11/T32: the configuration dialog's MODEL map and instruction TEXT are not part of the
// compiled view. A `/views` frame types `harnessDefinition` as a `HarnessDescriptor` but omits
// both (../server/protocol.ts:655-663), and a definition CARD omits them by contract
// (../shared/harness-api.ts:418-433) — the identified read adds the model map and an
// instruction SUMMARY whose rows carry provenance and length, never the prompt
// (../shared/harness-api.ts:449-460). Opening the dialog is therefore the ONE explicit action
// that needs either, and this is the only place the read happens: never during a render, a
// hydrate, a poll or a stream frame.
//
// The text is a second, bounded step. The summary names which members this definition
// overrides, and only those members are worth a `GET /harnesses/:name/instructions/:agent`
// (./api.ts `getHarnessInstructionText`); a member that runs the trusted preset already has its
// text in the agents catalogue the app booted with, so it costs nothing. A definition that
// states its own `agent_instructions` (an unredacted server) skips the walk entirely.
//
// Every failure mode keeps what this browser already had instead of blanking the editor: a
// gateway that has not mounted the GET answers 405/404 and ./api.ts reports `undefined`; a
// network failure rejects; a text row that fails leaves that one member unoverridden, which is
// the honest reading — the write path restates only the overrides this browser has SEEN
// (`agent-instructions-lazy-main.test.ts` pins it), because the server replaces the map and an
// invented key would store text nobody ever ran. And the answer is applied only while this
// instance is STILL the one whose dialog was opened, so a late response cannot paint another
// conversation's configuration.
const loadHarnessConfiguration = (instance: Instance): void => {
    const name = instance.descriptor.name;

    // The catalogue DEFAULT text is asked for alongside the configuration read, from the
    // member list already in hand (the FROZEN definition for a saved conversation, so the tabs
    // on screen are the ones filled). It stays a separate read because it answers a different
    // fact: what each member runs when NOTHING has been saved for it — the full prompt the
    // server composes (./ui/agents.ts `agentDefaultInstructionOf`), which is what the dialog's
    // one box falls back to. Names the catalogue does not carry (a custom session agent,
    // R7) are skipped by the helper itself: there is no row to fill. See `loadAgentPresetTexts`.
    loadAgentPresetTexts(instance, membersOf(instance.frozen ?? instance.descriptor));

    // T7b (R6): a saved conversation does NOT edit the template's stored prompts. Its own
    // roster, models and complete prompts live under `GET /sessions/{id}/agents...`, so the
    // harness definition is not read at all here — `GET /harnesses/:name` would answer the
    // template's text, which is precisely the wrong question for this conversation.
    const sessionId = instance.sessionId;

    if (sessionId !== undefined) {
        void loadSessionConfiguration(instance, sessionId).catch(() => {
            // Stated, not swallowed: the dialog stays usable from the definition this browser
            // was given (the frozen `agent_instructions` map), and the next open asks again.
        });

        // T4: the colour half of the template read, and ONLY that half.
        loadHarnessColors(instance, sessionId);

        return;
    }

    void getHarness(name)
        .then(async (fetched) => {
            // No such route (or an answer that names a different harness): keep what we have.
            if (fetched === undefined || fetched.name !== name) return;

            const definition = descriptorOf(fetched);
            const models = agentModelsOf(definition);

            // T4/R2: the identity colours THIS definition configures. The identified read is
            // the only publisher of `agent_colors` (a card omits it), so for a harness with no
            // conversation on screen this is the first moment the shell knows the explicit
            // tones at all.
            const colors = agentColorsOf(definition);

            // An unredacted definition states its own overrides, so the summary walk is not
            // needed at all; otherwise only the rows this definition supplies are fetched.
            const stated = agentInstructionsOf(definition);
            const stored =
                Object.keys(stated).length > 0
                    ? stated
                    : await overriddenInstructionsOf(name, definition.instructionSummary ?? []);

            // Nothing moved: no repaint, and no caret loss for a reader already typing. A
            // harness with no model override and no stored instruction answers with two empty
            // maps, which is exactly what an unread instance holds, so the early return is the
            // same rule T11 stated for the map alone.
            //
            // T4: colours are part of that equality. A definition that ONLY changed its colour
            // map (or answered one for the first time) has to refresh, or the explicit tones
            // would sit unread until the next unrelated frame.
            if (
                sameStringMap(instance.harnessModels, models) &&
                sameStringMap(instance.harnessInstructions, stored) &&
                sameStringMap(instance.harnessColors, colors)
            ) {
                return;
            }

            instance.harnessModels = models;
            instance.harnessInstructions = stored;
            instance.harnessColors = colors;
            if (current !== instance) return;

            // `refreshAgentDialog` is signature-guarded: unchanged state repaints nothing,
            // and a changed map rebuilds the body the reader has not typed into yet (a draft
            // they ARE typing survives, because the dialog owns drafts separately).
            const view = agentViewOf(instance);

            // The colour map is now part of the view, so the shared palette is re-derived
            // BEFORE anything repaints from it. `renderHarnessChrome` rebuilds the composer
            // button (whose identity tone just changed) and ends in `refreshAgentDialog`; the
            // extra refresh below is only for the branch where the TOOLS view owns the centre
            // and that chrome paint returns early — the open dialog still has to follow.
            configureAgentColorsFor(view);
            renderHarnessChrome();
            refreshAgentDialog(view, instance);
        })
        .catch(() => {
            // Stated, not swallowed: the dialog is still usable with the definition this
            // browser was given, and the next open asks again.
        });
};

// Colours are the one template fact a saved conversation still asks for, and the reason is
// T4's rule, not a shortcut: `GET /harnesses/:name` is the ONLY publisher of `agent_colors` (a
// card omits the field, ../shared/harness-api.ts:422), while a frozen copy carries the map only
// when the conversation was created after the swatch existed. A session whose frozen definition
// states colours needs no read at all — `storedColorsOf` gives the DOCUMENT precedence per key,
// so the conversation's own copy wins either way. What must not happen is the other loss: an
// older conversation (or an archived harness with no card left) silently dropping a colour the
// server still configures for that member.
const loadHarnessColors = (instance: Instance, sessionId: string): void => {
    const name = instance.descriptor.name;

    void getHarness(name)
        .then((fetched) => {
            // No card, or a card that names a different harness (an archived conversation): keep
            // the colours this browser already has.
            if (fetched === undefined || fetched.name !== name) return;
            if (instance.sessionId !== sessionId) return;

            const colors = agentColorsOf(descriptorOf(fetched));

            if (sameStringMap(instance.harnessColors, colors)) return;

            instance.harnessColors = colors;
            if (current !== instance) return;

            const view = agentViewOf(instance);

            configureAgentColorsFor(view);
            renderHarnessChrome();
            refreshAgentDialog(view, instance);
        })
        .catch(() => {
            // The palette keeps the deterministic automatic tones, which is the honest reading of
            // "this browser has not been told a colour for these agents".
        });
};

// T7b (R6): the LIVE configuration of ONE saved conversation, in the same explicit-open window
// as the definition read above (never from a render, a hydrate, a poll or a stream frame).
//
// WHY THE ROSTER READ FIRST: `GET /sessions/{id}/agents` is the route that states who this
// conversation actually has — the frozen definition's members PLUS every agent it bound itself
// (a catalogue profile via `[+]`, or a name the reader typed, R7). The instruction subresource
// is 404 for a name that is not on that roster, so the roster is both the member list and the
// bound for how many text reads follow (the roster budget caps it, ../shared/harness-api.ts:963).
//
// WHY ONE TEXT READ PER MEMBER: a `SessionAgentBinding` carries provenance and length but NO
// prompt (../shared/harness-api.ts:938-960), and the text a session runs is not the template's
// — since T6 a stored override IS the complete prompt, so the box must show exactly this answer
// and nothing composed from the harness map. A read that fails leaves that one member out,
// which is honest: `storedInstructionsOf` then falls back to the definition's text for it.
const loadSessionConfiguration = async (instance: Instance, sessionId: string): Promise<void> => {
    const list = await listSessionAgents(sessionId);

    // The reader left this conversation while the roster was in flight: painting would describe
    // a chat that is not on screen.
    if (instance.sessionId !== sessionId) return;

    const entries = await Promise.all(
        list.agents.map(async (binding): Promise<[string, string] | undefined> => {
            try {
                const text = await getSessionAgentInstruction(sessionId, binding.agent_id);

                return [binding.agent_id, text.instruction];
            } catch {
                return undefined;
            }
        })
    );

    const stored = Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== undefined));

    // Nothing moved: no repaint, and no caret loss for a reader already typing.
    if (sameStringMap(instance.harnessInstructions, stored)) return;

    instance.harnessInstructions = stored;

    if (current !== instance) return;

    const view = agentViewOf(instance);

    // Same funnel as the template read above: the palette is re-derived BEFORE anything paints
    // from it (T4), the composer button follows the roster, and the open dialog re-seeds every
    // box with the text this conversation actually runs.
    configureAgentColorsFor(view);
    renderHarnessChrome();
    refreshAgentDialog(view, instance);
};

// T7b (R5/R6/R7): the roster WRITE path's refresh, on its own.
//
// Neither `POST` nor `DELETE /sessions/{id}/agents` answers a roster — a create answers one
// `SessionAgentBinding` and a delete answers a receipt naming what detached
// (../shared/harness-api.ts:974-1026). Two reads DO state it:
//
//   - `GET /sessions/{id}/definition` — the member set (the definition's team plus every name
//     this conversation bound or invented, minus what it detached) and the toolbox. Installed
//     through `frozenDefinitions`, which is the map every later document re-derives THIS
//     conversation's team from (`frozenTeamOf`, T46/T50 above); the two promise caches are
//     replaced in the same step, because `readFrozenDefinition`/`discoveredToolsOf` dedupe per
//     conversation and would otherwise hand the next hydrate a team that no longer exists.
//   - `getView` + `applyView` — the live snapshot: the thread roster (which is what
//     `view.threadAgents` reads, R6) and the effective per-agent model map, reconciled by exactly
//     the code `openSession` uses (its stale guard keeps a live frame that moved past this answer
//     in front).
//
// Both run BEFORE the surviving members' prompts and models are written, for two reasons: the
// writes are addressed by member name, so the NEW team has to be in hand; and a later document
// re-read would regress the model map the model PATCH is about to install (the PATCH answer is
// the newest authority for that field, R2).
//
// A failed read keeps what this browser has: the write itself already happened, and the honest
// fallback is the team as last stated rather than an emptied roster.
const refreshSessionRoster = async (instance: Instance, sessionId: string): Promise<void> => {
    // ./view-api.ts `readDefinition` is this route's existing shell accessor (the same one
    // `hydrateSessionDefinition` and `readFrozenDefinition` use), so no second import is needed.
    const definition = await readDefinition(sessionId).catch(() => undefined);

    if (definition !== undefined && instance.sessionId === sessionId) {
        const frozen = frozenDescriptorOf(definition);

        if (frozen !== undefined) {
            const discovered = Array.isArray(definition.discovered_tools) ? [...definition.discovered_tools] : [];

            frozenDefinitions.set(sessionId, frozen);
            frozenReads.set(sessionId, Promise.resolve(frozen));
            discoveredReads.set(sessionId, Promise.resolve(discovered));

            instance.frozen = frozen;
            instance.discovered = discovered;
        }
    }

    if (instance.sessionId !== sessionId) return;

    try {
        applyView(instance, await getView(sessionId));
    } catch {
        // A freshness read that fails cannot invalidate the write the server already accepted.
    }
};

// T7b (R4/R6): repaint a saved conversation after a session write — the live per-agent prompt
// text, then ONE repaint funnel. `renderHarnessChrome` re-derives the view, calls
// `configureAgentColorsFor` (T4: a brand-new member wears its deterministic tone immediately)
// and refreshes the open dialog; the trailing `refreshAgentDialog` covers the branch where the
// Tools view owns the centre and that chrome paint returns early. Forced, because a roster write
// can leave the derived state looking identical to the reader (a NEW tab is not a change in any
// map this browser cached) while the team on screen has in fact moved.
const refreshSessionConfiguration = async (instance: Instance, sessionId: string): Promise<void> => {
    await loadSessionConfiguration(instance, sessionId).catch(() => undefined);

    if (instance.sessionId !== sessionId || current !== instance) return;

    const view = agentViewOf(instance);

    configureAgentColorsFor(view);
    renderHarnessChrome();
    refreshAgentDialog(view, instance, true);
};

// Two override maps are the same server state when every key and value matches. `undefined`
// (never read) is deliberately NOT the same as `{}` (read, and nothing is overridden): a
// harness whose first read came back empty still has to record that it asked, or every frame
// would look like a change.
const sameStringMap = (left: Record<string, string> | undefined, right: Record<string, string>): boolean => {
    if (left === undefined) return Object.keys(right).length === 0;

    const names = Object.keys(left);

    return names.length === Object.keys(right).length && names.every((name) => left[name] === right[name]);
};

// The instruction overrides this definition actually runs, one bounded text read per member
// the summary flags as THIS harness's own prompt. A row that fails is skipped rather than
// guessed, and the rows run in parallel because the member set is bounded by the definition
// (../shared/harness-api.ts:515-524 says the index is not even paged).
const overriddenInstructionsOf = async (
    name: string,
    summary: readonly HarnessInstructionSummaryEntry[]
): Promise<Record<string, string>> => {
    const overridden = summary.filter((row) => row.overridden === true && row.source === 'harness');
    const entries = await Promise.all(
        overridden.map(async (row): Promise<[string, string] | undefined> => {
            try {
                const text = await getHarnessInstructionText(name, row.agent);

                return [row.agent, text.instruction];
            } catch {
                return undefined;
            }
        })
    );

    return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== undefined));
};

// ---------------------------------------------------------------------------
// The trusted PRESET instruction text (the T11/T32 companion read)
// ---------------------------------------------------------------------------
//
// The dialog seeds an agent that has no harness override from its trusted preset text,
// and states that same text as the reference an override is compared against
// (./ui/agent-dialog.ts `baselineInstructionOf`, `createAgentPresetDetail`). Two reads
// look like they could supply it and neither does:
//
//   - `GET /agents` (the boot page the library is built from) answers SUMMARIES with no
//     prompt at all, and `agentRowOf` maps that absence to '' on purpose
//     (./api.ts:1246-1273, ../shared/harness-api.ts:552-563);
//   - `GET /harnesses/:name/instructions/:agent` answers the EFFECTIVE text, so an
//     overridden member reports its own override rather than the preset it replaces
//     (../server/api-reads.ts:1091-1120) — useless for the comparison.
//
// `GET /agents/:id` (./api.ts `getAgent`) is the identified read that ships the shipped
// profile text plus its guideline rules, resolved through the global layer
// (`instruction_source`), and it had no caller at all. This is it. T50 states the same
// rule for tools: a list row carries no schema, the identified read does, and only the
// control that needs one asks (./main.ts `hydrateToolDetail`).
//
// Cost stays bounded and explicit: one read per agent whose library row still has no
// text, fired when the dialog is opened (the definition's own members) or when a
// selection moves onto an agent that walk never covered (a `[+]` addition). Never from
// a render, a hydrate, a poll or a stream frame. `presetTextRequests` keeps a repaint of
// the same tab free, and a failed read is deliberately NOT cached — a retired profile
// 404s (../server/api.ts:1685-1688) and the honest blank stays until the next selection
// asks again.
const presetTextRequests = new Set<string>();

// Library row + identified profile read, as one row. Only the two trusted TEXT fields
// move: the title and description the summary already stated stay, so a late read
// cannot relabel a tile or shift another agent's colour slot (R3/R4) under the reader.
const agentRowWithTextOf = (row: AgentDescriptor, profile: AgentProfile): AgentDescriptor => ({
    ...row,
    instruction: profile.instruction,
    guidelines: [...profile.guidelines]
});

const loadAgentPresetTexts = (instance: Instance, names: readonly string[]): void => {
    const wanted = uniqueNames(names).filter((name) => {
        const row = agentLibrary.find((agent) => agent.name === name);

        // No row means no tile to fill — an agent this catalogue stopped advertising has
        // nothing here to attach the text to, and `agentDetailsOf` already says so.
        return (
            row !== undefined &&
            row.instruction.trim().length === 0 &&
            !presetTextRequests.has(name)
        );
    });

    if (wanted.length === 0) return;

    for (const name of wanted) presetTextRequests.add(name);

    void Promise.all(
        wanted.map((name) => getAgent(name).catch<AgentProfile | undefined>(() => undefined))
    ).then((profiles) => {
        for (const name of wanted) presetTextRequests.delete(name);

        const found = profiles.filter((profile): profile is AgentProfile => profile !== undefined);
        if (found.length === 0) return;

        agentLibrary = agentLibrary.map((row) => {
            const profile = found.find((candidate) => candidate.name === row.name);

            return profile === undefined ? row : agentRowWithTextOf(row, profile);
        });

        // A late answer for a conversation the reader already left repaints nothing, and
        // the refresh is FORCED on purpose: `agentDialogSignatureOf` lists `agents` by
        // NAME only, so text arriving for a name that was already there would otherwise
        // never reach the open dialog. Drafts live in the dialog's own layer, so this
        // rebuild cannot throw away what the reader is typing.
        if (current !== instance) return;

        refreshAgentDialog(agentViewOf(instance), instance, true);
    });
};

// Open the dialog for the SELECTED instance. The click handler resolves `current`
// at press time, so a rebuilt button can never target a conversation left behind.
const openAgentDialogForCurrent = (): void => {
    const instance = current;
    if (instance === undefined) return;

    // T29: this dialog is the surface that shows the conversation's frozen team and its
    // discovered toolbox. The canonical document carries neither (./view-api.ts:6-29), so
    // the dialog's open is what asks `GET /sessions/{id}/definition` for them — one read
    // per conversation, cached, and never paid for by a chat that is only being read.
    hydrateSessionDefinition(instance);

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

    // T11/T32: the dialog opened, so the model map and the instruction text it edits are now
    // the thing worth one request. The dialog itself is already painted from the definition in
    // hand, so this read only ever refines it — a slow or missing route cannot delay or blank
    // the modal.
    loadHarnessConfiguration(instance);
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
    // T4 safety net (see `agentDialogOptionsOf`): an open dialog's badges must follow the
    // view the caller just derived, including a colour map that arrived from the definition
    // read. Runs before the early returns on purpose, so a chrome repaint for a CLOSED
    // dialog still keeps the module state pointed at the ACTIVE view.
    configureAgentColorsFor(view);

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
//   - A SAVED SESSION (T7b, R5/R6/R7) — the conversation's OWN team, prompts and live
//     models, written through `POST/PATCH/DELETE /sessions/{id}/agents...`. The harness
//     template is never touched, so nothing this reader does can change the sessions the
//     NEXT person starts. See `applySessionConfiguration` for the order and the guards.
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

    // --- a saved conversation: its own team, prompts and models ------------
    // T7b (R5/R6/R7): a saved conversation owns its roster, its complete prompts and its live
    // models, so every draft lands on `POST/PATCH/DELETE /sessions/{id}/agents...` and NOTHING
    // is written to the harness template. A models-only draft keeps the pre-T7b path (R2),
    // including its wording, because that write is the one thing allowed mid-run.
    const sessionId = instance.sessionId;

    if (sessionId !== undefined) {
        return await applySessionConfiguration(instance, sessionId, view, changes);
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

    // Merge the deltas onto the stored maps. An explicit '' clears a key, which is how the dialog
    // drops an agent's stored prompt (R4: the one box, cleared by hand) or chooses the default
    // model, without a second protocol verb.
    //
    // T32 (R1/R2): exactly T11's rule for instructions, now applied to models. The base map is the
    // one the DIALOG renders from (`view.models`, built at `agentViewOf` from `storedModelsOf`),
    // NOT the raw document field: a runtime view frame omits `agent_models`
    // (../shared/harness-api.ts:418-419), so `agentModelsOf(display)` is `{}` here and merging on
    // it broke the save two ways —
    //   - clearing an override (the dropdown's default option, value '') deleted a key from `{}`,
    //     so the guard below compared `{}` with `{}` and answered "Nothing changed." without ever
    //     reaching the PATCH — the reported bug;
    //   - any model that DID pass the guard went out as a complete replacement derived from
    //     nothing, silently wiping every other member's stored override, because the server
    //     REPLACES `agent_models` with whatever it receives.
    // `view.models` is already normalized the way the PATCH body must be (member order, empty
    // values dropped), so the merge and the guard below compare the same shape.
    const models = { ...view.models };

    for (const [name, model] of Object.entries(changes.models)) {
        const value = model.trim();
        if (value.length === 0) delete models[name];
        else models[name] = value;
    }

    // T11: the base map is the one the DIALOG renders from (`view.instructions`), not the raw
    // document field. A compiled view omits `agentInstructions` entirely, and the copy this
    // shell read when the dialog was opened (`instance.harnessInstructions`) is the only
    // other source there is. Since the server REPLACES the whole map, restating only what the
    // document happened to carry would silently wipe a member's stored override.
    const instructions = { ...view.instructions };

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
    //
    // T32 (R1): both model sides are the SAME stored map the reader sees. The old right-hand side
    // (`modelsForMembers(agentModelsOf(display), members)`) was a frame that omits the field, so
    // it read "nothing is overridden" for a template that does override something, and a genuine
    // clear was refused as a no-op.
    if (
        primary === primaryOf(display) &&
        JSON.stringify(nextMembers) === JSON.stringify(members) &&
        JSON.stringify(nextModels) === JSON.stringify(view.models) &&
        JSON.stringify(nextInstructions) ===
            JSON.stringify(view.instructions) &&
        !busy
    ) {
        return { applied: false, message: 'Nothing changed.' };
    }

    return await patchAgents(primary, nextMembers, nextModels, nextInstructions);
};

// ---------------------------------------------------------------------------
// The saved conversation's own write path (T7b / R5 + R6 + R7)
// ---------------------------------------------------------------------------
//
// One explicit apply from the dialog, in the order the SERVER needs it:
//
//   removals → additions → roster refresh → surviving members' prompts → models → refresh
//
// WHY THAT ORDER: a removal is the one write the server may REFUSE (409 while a host
// conversation runs that member, ../server/sessions.ts `removeSessionAgent`, mirrored by the
// binding's `deletable: false`, ../server/api-reads.ts:1009-1011), so it goes first: a blocked
// save then costs exactly one request and the roster has not moved. Additions follow, and only
// after the roster is re-read (step 3) can the surviving members' prompts be addressed by name —
// a create receipt states ONE binding, not the team (../shared/harness-api.ts:974-1026).
//
// WHY EACH BODY LOOKS THE WAY IT DOES:
//   - an added member carries its model and its complete prompt in the CREATE, so a `[+]` pick
//     with a typed instruction is one request, not three (../shared/harness-api.ts:982-1000 —
//     a catalogue name BINDS that profile, any other name CREATES a session-defined agent whose
//     whole prompt is the `instruction` supplied, defaulting to the session model and an
//     identity sentence);
//   - a prompt is sent VERBATIM. Since T6 an instruction override IS the complete system prompt
//     (the guidelines are defaults, not an appended layer), so the text in the box is exactly
//     what the agent runs;
//   - a CLEARED box sends `null`, which restores the inherited prompt. An empty string would
//     store a prompt of nothing, and an omitted field would change nothing at all
//     (../shared/harness-api.ts:1002-1011: omitted = no change, string = replace, null = clear);
//   - the model map is restated COMPLETE against the FINAL member list, because the session
//     PATCH replaces the field it names.
//
// A rejected write leaves the dialog open with every draft (the dialog's own rule) but still
// re-reads the conversation: an earlier write in the same sequence may have landed, and the
// roster on screen must then say so.
const applySessionConfiguration = async (
    instance: Instance,
    sessionId: string,
    view: AgentView,
    changes: AgentConfigurationApply
): Promise<AgentApplyResult> => {
    const existing = view.members;
    const removals = changes.remove.filter((name) => existing.includes(name));
    const additions = changes.add.filter((name) => !existing.includes(name));
    const prompts = Object.entries(changes.instructions);
    const drafted = Object.entries(changes.models);
    const teamWork = removals.length > 0 || additions.length > 0 || prompts.length > 0;
    // Only a roster write moves the member set; a prompt or model save re-reads nothing but the
    // text it just wrote (the model PATCH answer is already the newest authority for its field).
    const rosterMoved = removals.length > 0 || additions.length > 0;

    // R5: a saved conversation keeps the entry agent it started with — `canPromote: false`
    // already disables the control, so this is the guard against a stale or foreign caller
    // rather than the reader's normal path.
    if (changes.primary !== undefined && changes.primary !== view.primary) {
        return { applied: false, message: 'The primary agent is fixed for a saved conversation.' };
    }

    if (!teamWork && drafted.length === 0) return { applied: false, message: 'Nothing changed.' };

    // A roster or prompt write decides who runs the NEXT request, so it is refused while a run
    // is in flight (the tiles are still moving) or while a submit is creating this session (the
    // freeze has not landed). A models-only draft is NOT refused: R2 keeps the live map editable
    // mid-run, and the harness path's own message names the same two windows.
    if (teamWork && (running || submitting || creatingSessions > 0)) {
        return {
            applied: false,
            message: running
                ? 'Wait for the current run to finish before saving agents.'
                : 'A session is being created · save again once it exists.'
        };
    }

    // The whole sequence is one single-flight unit: a harness PATCH or a second session save
    // that interleaved two roster writes would report a team that never existed.
    if (savingAgents) {
        return { applied: false, message: 'An agent save is still in flight · try again in a moment.' };
    }

    savingAgents = true;

    // R3/R5: the pill says what is being written, and (unlike a template save) that it lands on
    // THIS conversation. The models-only case keeps R2's wording, because that save really is
    // "the next request" and nothing else.
    const label = teamWork ? 'agent configuration' : 'agent models';
    const saved = teamWork
        ? 'agent configuration saved · applies to this conversation'
        : 'agent models saved · next request';

    setStatus('saving', `saving ${label}`);

    try {
        // 1. Removals.
        for (const name of removals) await deleteSessionAgent(sessionId, name);

        // 2. Additions, each carrying its own model and complete prompt.
        for (const name of additions) {
            const model = (changes.models[name] ?? '').trim();
            const instruction = (changes.instructions[name] ?? '').trim();

            await createSessionAgent(sessionId, {
                name,
                profile: name,
                ...(model.length === 0 ? {} : { model }),
                ...(instruction.length === 0 ? {} : { instruction })
            });
        }

        // 3. The roster the writes produced, BEFORE anything is addressed by member name.
        if (rosterMoved) await refreshSessionRoster(instance, sessionId);

        // 4. Prompts for the members that were ALREADY on this team (an added member's text
        //    travelled with its create, so restating it here would be a second write of the
        //    same bytes).
        for (const [name, text] of prompts) {
            if (!existing.includes(name)) continue;

            const instruction = text.trim();

            await updateSessionAgent(sessionId, name, {
                instruction: instruction.length > 0 ? instruction : null
            });
        }

        // 5. Models, built from the REFRESHED roster so a member added one request ago is on the
        //    list its key belongs to and a removed one is off it (`modelsForMembers` filters to
        //    the final set because the PATCH replaces the whole field).
        if (drafted.length > 0) {
            const live = agentViewOf(instance);
            const next = modelsForMembers(
                { ...agentModelsOf(live.display), ...(instance.sessionModels ?? {}) },
                live.members
            );

            for (const [name, model] of drafted) {
                if (!live.members.includes(name)) continue;

                const value = model.trim();
                const resolved = live.fallback.trim();

                // A "use the default" choice becomes the resolved id rather than a deleted key:
                // deleting here would leave the agent on the model it already runs (R2).
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

            // `held` tells the helper the guard is already taken by this sequence, so it neither
            // refuses the call nor releases the flag early.
            const result = await patchSessionModels(instance, sessionId, next, {
                held: true,
                label,
                status: saved,
                result: saved
            });

            // The PATCH answer states the MODEL map and nothing else: it cannot say what the
            // prompts or the roster look like now. So the conversation is re-read either way —
            // a successful save has to paint the saved prompt in the box, and a refused one has
            // to paint the roster the earlier writes of this sequence produced.
            if (instance.sessionId === sessionId) await refreshSessionConfiguration(instance, sessionId);

            return result;
        }

        // 6. No model write: this function owns the refresh and the honest status line.
        await refreshSessionConfiguration(instance, sessionId);
        setStatus('idle', saved);

        return { applied: true, message: saved };
    } catch (error) {
        const message = messageOf(error);

        setStatus('error', `${label}: ${message}`);

        // Written, then re-read: steps 1-4 may have applied part of the draft, and the roster on
        // screen is a claim about the server, not about what this browser wanted.
        if (rosterMoved) await refreshSessionRoster(instance, sessionId);
        await refreshSessionConfiguration(instance, sessionId);

        return { applied: false, message };
    } finally {
        savingAgents = false;
    }
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
    // T3: `{}` is meaningful and must still be SENT when an override is being cleared — an
    // omitted field would leave the stored map in place while the UI claimed the preset was
    // running again. The same condition decides whether this browser may restate its cached
    // map below, so the two can never disagree about what the server now holds.
    const sendsInstructions = includeInstructions || Object.keys(storedInstructionsOf(display, instance)).length > 0;
    // T32 (R3): the identical rule for the model map, and it needs the identical flag. Clearing
    // the LAST override leaves `models` empty, so `includeModels` alone would omit the field and
    // the server would keep the override the reader just removed. `storedModelsOf` is the map the
    // dialog rendered from (see its comment above), so this asks the real question: was there
    // anything stored that this request has to restate or clear? Present-but-empty is the
    // explicit clear server-side (../server/api.ts `patchHarness`: "Present = REPLACE the map;
    // `{}` is the explicit clear"), so no server change is needed for the clear to land.
    const sendsModels = includeModels || Object.keys(storedModelsOf(display, instance)).length > 0;

    savingAgents = true;
    // R3: `saving` is the visible word; the label says WHAT is being saved in the
    // tooltip only.
    setStatus('saving', `saving ${label}`);

    try {
        // T38: the contract's field names, verbatim. `UpdateHarnessRequest`
        // (../shared/harness-api.ts:488-499) spells the two override maps `agent_models` and
        // `agent_instructions`; this call used to send the shell's camelCase render spelling
        // under a conditional spread, which is the one shape TypeScript's excess-property check
        // does not catch, so the body went to a CLOSED object (`additionalProperties: false`)
        // with two unknown keys and the maps themselves absent. The answer is read back through
        // `descriptorOf` (./api.ts:1203), which already maps the snake fields, so nothing else
        // in the write path needed to change.
        const updated = await updateHarness(display.name, {
            primary: nextPrimary,
            subagents,
            ...(sendsModels ? { agent_models: models } : {}),
            ...(sendsInstructions ? { agent_instructions: instructions } : {})
        });
        // descriptorOf is the canonical card/definition -> render descriptor mapping (./api.ts);
        // the cast is nominal only: the protocol type carries legacy optional fields this
        // deployment no longer publishes.
        replaceDescriptor(descriptorOf(updated) as unknown as HarnessDescriptor);

        // T32: the PATCH REPLACED both maps with exactly what was sent, so the two lazy caches
        // are restated from the request itself. The identified read that `replaceDescriptor`
        // just consumed publishes an instruction SUMMARY without the prompts
        // (../shared/harness-api.ts:449-460), so trusting the answer alone would drop a stored
        // override the reader can still see on screen; a field this PATCH omitted keeps whatever
        // the browser had, because the server kept it too.
        const live = instances.get(display.name);

        if (live !== undefined) {
            if (sendsModels) live.harnessModels = { ...models };
            if (sendsInstructions) live.harnessInstructions = { ...instructions };
        }

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
//
// T7b (R5/R6): `write` lets a FULL session save (roster + prompts + models from one apply)
// reuse this PATCH instead of inventing a second one. `held: true` says the caller already
// owns `savingAgents` across the whole sequence — releasing it here would let another write
// interleave between two session mutations — and `label`/`status`/`result` state the save in
// the scope it actually has: a template-shaped save says "applies to new sessions", a
// conversation-shaped one says "applies to this conversation". Absent `write` this is exactly
// the models-only save it always was, copy included.
const patchSessionModels = async (
    instance: Instance,
    id: string,
    models: Readonly<Record<string, string>>,
    write?: { held?: boolean; label?: string; status?: string; result?: string }
): Promise<AgentApplyResult> => {
    // A full save holds the guard for the whole sequence; a models-only draft takes it here.
    const held = write?.held === true;

    if (!held) {
        // A second change while one PATCH is in flight is dropped, not queued. The
        // dialog keeps its draft and shows the reason; nothing on screen claims a
        // write that never happened.
        if (savingAgents) {
            return { applied: false, message: 'An agent save is still in flight · try again in a moment.' };
        }

        savingAgents = true;
    }

    const label = write?.label ?? 'agent models';
    const savedStatus = write?.status ?? 'agent models saved · next request';
    const savedResult = write?.result ?? 'Models saved · the next request uses them.';

    // The pill carries the CONFIG operation (app-scoped action feedback), never the
    // session's run state — that lives on the tiles (R1). R3: the visible word is
    // `saving`; the target is tooltip detail.
    setStatus('saving', `saving ${label}`);

    try {
        const session = await updateView(id, { agentModels: { ...models } });

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
        setStatus('idle', savedStatus);

        return { applied: true, message: savedResult };
    } catch (error) {
        // Errors are shown even mid-run: a rejected model is something the reader
        // must see, and the streaming turn keeps its tiles either way. The row/dialog
        // is redrawn from the last confirmed map so it cannot pretend the change stuck.
        const message = messageOf(error);
        setStatus('error', `${label}: ${message}`);

        if (current === instance) {
            renderHarnessChrome();
            forceRefreshAgentDialog();
        }

        return { applied: false, message };
    } finally {
        if (!held) savingAgents = false;
    }
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

// One PATCH per name at a time (the same single-flight discipline `loadPlugins` and the
// settings save follow).
const togglingTools = new Set<string>();
// The corner tick boxes, keyed by tool name, so a write repaints its OWN row in place
// and a busy pass can lock/unlock exactly that control.
const toolEnableBoxes = new Map<string, HTMLInputElement>();
// Tools Catalogue: the pane owns NO line of its own under the title. A switch write already
// reports itself where the reader is looking — the tick box's own `checked`, the row's green
// `data-enabled` edge, and the topbar pill (`setStatus`), which carries the server's sentence
// when the write is REFUSED — so the accepted figure and the refusal are stated there, never
// echoed back into the pane.

const toolsPane = el('div', 'pane tools-pane');
const toolsTabHead = el('div', 'tools-tab-head');
// R1 (Tools Catalogue): the pane's long "Every tool the server lists…" paragraph is GONE —
// the reader does not need it, and the head note above the list already states the count and
// where calls run. R3: the playground's session-bound context note is gone for the same
// reason, and so is the enablement write's live line: the head is now ONLY its heading, and
// the pane is its heading plus the grid. Where a session-bound call actually runs is stated
// by the runner itself when one is opened (`.tool-session`) or refused (its `no_harness` error).
//
// R2: the heading reads "Tools Catalogue", the same label `paintToolsHead` paints in the
// harness head, so head and pane name the view identically (the pattern every other view here
// follows — chat, Plugins, workspace).
toolsTabHead.append(el('h2', 'tools-tab-title', 'Tools Catalogue'));
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
    headTitleText.textContent = 'Tools Catalogue';
    // R2 (T9): a tools heading is not a harness, so the popup it opens is the session
    // dashboard — the only entry point to a saved conversation from this view — never
    // "harness details" for a definition the head is not naming.
    paintHeadTitleTrigger('sessions');
    // R2 (Tools Catalogue): the shared `.harness-id` badge is HIDDEN here. It used to print
    // the word `catalogue` next to the title, which read as a stray label hanging to the right
    // of the "+"; the title now carries that word ("Tools Catalogue"), so the badge has
    // nothing left to say and is blanked + hidden exactly the way the chat head hides it
    // (see renderHarnessChrome). Every OTHER writer of this span is untouched: `selectTool`
    // still names the open tool's GROUP, and the Plugins head still shows `built-ins`.
    headName.hidden = true;
    headName.textContent = '';
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

const selectTool = (entry: ToolRowEntry, trigger?: HTMLElement): void => {
    // R1: no `running` gate. The catalogue and its runner are server facts, and the
    // conversation's observer keeps streaming underneath this pane; the transcript
    // painters all early-return on `showingTools` (`renderHarnessChrome`, main.ts:6189).
    //
    // The `stopPolling()` this function used to open with is GONE, and that is part of
    // the same change: the bounded refresh is how a conversation with no live socket
    // stays current, and removing the run gate made "select a tool mid-run" reachable.
    // Stopping the follow there would freeze the transcript under the catalogue and only
    // resume it when the reader happens to re-open the conversation.

    // Replace, never stack: close the previous runner first so its `onClose` reset
    // runs against the state that was actually on screen.
    closeToolDialog();

    // T50: the list row is a `ToolSummary` — identity, group, tags, availability, scope, and no
    // argument schema. Paint from the cached identified read when this browser already has one,
    // otherwise paint the row immediately (the first frame must never wait on a request) and let
    // `hydrateToolDetail` repaint the runner the moment the schema lands.
    const known = toolDetails.get(entry.name);
    const shown = known ?? entry;

    currentTool = shown;
    // Selecting a tool ensures the GLOBAL tools view is behind the dialog: that is
    // the only tool listing (R21.2).
    showingTools = true;
    paintToolsToggle();
    // T7 (R2): this is the second writer of `showingTools`, so it keeps the same
    // exclusivity rule as `setToolsView` — a tool row is only reachable from the tools
    // pane, but a plugin layer must never survive the switch behind it.
    if (showingPlugins) {
        closePluginDialog();
        showingPlugins = false;
        paintPluginsToggle();
    }
    // T29: opening the tools surface is the request for the figure its note shows. A
    // direct (no-session) call has no playground context yet, so this costs NO read:
    // `hydratePlaygroundDiscovered` is a no-op until a temporary session exists, which
    // is what the canonical playground suite pins.
    hydratePlaygroundDiscovered();

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
    // R2 (T9): the tool name is a heading, not a harness — the popup from this head is the
    // session dashboard, never this tool's details.
    paintHeadTitleTrigger('sessions');
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
    runner.show(shown);
    openToolDialog(shown, trigger);
    setStatus('idle');

    // The schema is the identified read, and one open costs exactly one of them (memoized until
    // the catalogue page changes). Awaited nowhere: the row paints immediately.
    if (known === undefined) void hydrateToolDetail(entry);
};

// Open or close the GLOBAL tools view (R3). One function for both directions: the
// icon-only Tools toggle on the harness title row calls it, and harness selection closes
// it. The panel (`stage`) is shared and only PART of the centre chrome moves: the composer
// and the agent slot are hidden while the catalogue owns the column, and the HEAD IS NEVER
// HIDDEN — `paintToolsHead` re-titles it instead. That is what keeps the session-line
// toggle on screen (and focused, below) so its second press can close the pane.
//
// R1 (this pass): a run in flight NO LONGER locks the view. The catalogue and its
// runner are server facts, and leaving/entering this column only swaps the centre
// pane — the conversation's observer, its queue and its tiles are untouched, so a
// stream keeps being folded into `instance.view` while the list is on screen
// (`renderHarnessChrome` and the head painters early-return on `showingTools`). The
// old lock bought nothing except a hidden catalogue.
//
// Opening NEVER auto-opens a tool any more: the content area is the list, and a
// dialog appears only after the reader activates one entry.
const setToolsView = (open: boolean): void => {
    if (showingTools === open) return;

    // Lifecycle: entering the Tools view dismisses the agent dialog; the chat starts
    // with it closed when the view returns. The harness details dialog is also closed
    // (R2): its title/description belong to the chat head that is being replaced.
    if (open) {
        closeAgentDialog();
        closeHarnessDialog();
        // T7 (R2): the centre column has ONE owner, so opening Tools leaves the Plugins
        // catalogue first — through `setPluginsView(false)`, which closes any open plugin
        // dialog and restores the chat chrome that the pass below then replaces.
        if (showingPlugins) setPluginsView(false);
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
    // released when the view closed).
    // T29: the tools view is the surface that shows the playground context's discovered
    // toolbox. `GET /sessions/{id}/definition` is the only route that still answers it
    // (the compact session row stopped publishing `discoveredTools`), so the read is
    // paid for HERE — cached in `discoveredReads`, and a no-op while no temporary session
    // exists, which is exactly what "a direct call costs no session traffic" pins. The
    // selected CHAT's definition is a different surface's read (the agent dialog), and
    // opening the catalogue must not spend a session read on it.
    hydratePlaygroundDiscovered();

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

// The session-line icon is a real toggle: pressing it while the tools view is showing
// closes it and returns to the selected chat. It is disabled while a run is pending
// (paintControls), so this handler never has to fight a streaming queue.
toolsToggle.addEventListener('click', () => {
    setToolsView(!showingTools);
});

// The row's enablement control (R1). A row is one `.tool-tab-row` holding the listing
// button and, in the wrapper's top-right corner, ONE tick box:
//
//   - every catalogue entry gets one, harness-owned core tools included — the server
//     makes every tool switchable and no longer states a pinned set, so there is no
//     affordance-less row shape left to render (the old "core" pin is gone);
//   - the box is a real `input[type=checkbox]`, so `checked` IS the state for assistive
//     tech (no `role`/`aria-checked` to keep honest), and one click writes it for EVERY
//     session (`PATCH /tools/{tool_id}`); the row is repainted from the answer, never
//     from a guess.
//
// The box is the button's SIBLING and absolutely positioned in the wrapper (see
// styles.css `.tool-tab-enable`), which is what keeps the two activations apart: a click
// on the box writes enablement and never opens the runner, and a click anywhere else on
// the tile opens the runner and never writes.
//
// A row that states NO enablement (`enabled === undefined`, an older server or a fixture
// modelling one) renders NEITHER control nor state attribute: inventing a tick for a
// state the server never reported is a lie the reader cannot act on.
//
// The box itself. The accessible name is the ACTION (`Enable`/`Disable` + the tool name),
// `checked` carries the state, and the tile's green edge (`.tool-tab-button[data-enabled]`
// takes an `--ok-line` border, no background wash — styles.css:1042-1058) is painted from the
// same figure by `paintToolRowEnablement` — three readings of one state, never a colour-only
// signal.
const toolEnableCheckboxOf = (entry: ToolRowEntry): HTMLInputElement => {
    const enabled = entry.enabled === true;
    const control = el('input', enabled ? 'tool-tab-enable is-on' : 'tool-tab-enable is-off');

    control.type = 'checkbox';
    // The native state, not an ARIA mirror: assistive tech, the keyboard and the CSS all
    // read this one figure.
    control.checked = enabled;
    control.dataset.tool = entry.name;
    control.dataset.enabled = enabled ? 'true' : 'false';
    control.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} ${entry.name}`);
    control.title = enabled
        ? 'Enabled for every conversation on this harness server · click to switch this tool off'
        : 'Disabled for every conversation on this harness server · click to switch it on';
    // R1: a run never locks this control — the only thing that can is its own write
    // (the same rule `paintControls` paints from).
    control.disabled = togglingTools.has(entry.name);
    // The click reads the CACHED row, not the `entry` this node was built from: a
    // successful write replaces the cache, and a second press must invert the figure the
    // server last reported rather than the one this frame was painted with. The value the
    // browser just ticked is deliberately ignored — the server's answer is what repaints
    // it, and the busy pass in `setToolEnabled`'s `finally` pulls the tick back to the
    // cached figure when the write is refused.
    control.addEventListener('click', () => {
        void setToolEnabled(entry.name, !(toolEntryOf(entry.name)?.enabled ?? false));
    });

    return control;
};

// The catalogue row the pane currently holds for one name — the figure every repaint and
// every click of the tick box reads.
const toolEntryOf = (name: string): ToolRowEntry | undefined =>
    toolEntries.find((entry) => entry.name === name);

// Repaint ONE row's tick box from the row's own enablement figure, in place (no list
// rebuild, so focus and the dialog's `returnFocus` target survive). The box's `checked`,
// its `data-enabled` and the tile button's `data-enabled` move together, so the list can
// never show a tick on a row the server says is off (or the green edge without the tick).
//
// The parameter is the ENABLEMENT figure, not a whole row: a `ToolRowView` (what
// `toolRowOf` maps a PATCH answer into) has no `parameters` field, and this painter reads
// exactly two fields, so widening it to the full entry would only add a cast.
type ToolEnablement = { name: string; enabled?: boolean };

const paintToolRowEnablement = (entry: ToolEnablement): void => {
    const control = toolEnableBoxes.get(entry.name);
    const button = toolTabButtons.get(entry.name);

    if (button !== undefined && entry.enabled !== undefined) {
        button.dataset.enabled = entry.enabled ? 'true' : 'false';
    }

    if (control === undefined || entry.enabled === undefined) return;

    const enabled = entry.enabled;

    control.className = enabled ? 'tool-tab-enable is-on' : 'tool-tab-enable is-off';
    // THE state. A native checkbox carries no `aria-checked` to keep honest, so `checked`
    // is the single figure assistive tech reads — and it is also what the CSS tick and the
    // row's green edge follow.
    control.checked = enabled;
    control.dataset.enabled = enabled ? 'true' : 'false';
    control.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} ${entry.name}`);
    control.title = enabled
        ? 'Enabled for every conversation on this harness server · click to switch this tool off'
        : 'Disabled for every conversation on this harness server · click to switch it on';
};

// Lock/unlock one row's tick box while ITS OWN write is in flight. This is the only
// disabled state the control has after R1 removed the run/pending lock.
//
// Unlocking also REPAINTS from the cache, which is the revert path: a native checkbox
// flips itself the instant it is clicked, so a REFUSED write must have its tick pulled
// back to the figure the server actually holds. The cache only ever moves with a
// successful answer, so repainting from it is exactly "what the server says".
const paintToolEnableBusy = (name: string, busy: boolean): void => {
    const control = toolEnableBoxes.get(name);

    if (control === undefined) return;

    control.disabled = busy;
    control.setAttribute('aria-busy', busy ? 'true' : 'false');

    if (!busy) {
        const row = toolEntryOf(name);

        if (row !== undefined) paintToolRowEnablement(row);
    }
};

// Take the PATCH answer as the new state of one row. The answer is a whole `ToolDetail`,
// so the cache, the memoized identified read (its schema stays where it was) and the
// runner all move to the server's figure.
const rememberToolRow = (detail: ToolDetail): void => {
    const row = toolRowOf(detail);
    toolEntries = toolEntries.map((entry) =>
        entry.name === row.name ? { ...entry, enabled: row.enabled } : entry
    );

    const known = toolDetails.get(row.name);

    if (known !== undefined) {
        toolDetails.set(row.name, { ...known, enabled: row.enabled });
    }

    paintToolRowEnablement(row);
    // The dialog's runner is showing this tool: its availability line is the same figure.
    if (currentTool !== undefined && currentTool.name === row.name) {
        currentTool = { ...currentTool, enabled: row.enabled };
    }

    // A refused or accepted switch is a fact about the LISTING, and the list is what the
    // head describes; keep the row states in sync with the cache.
    if (showingTools && currentTool === undefined) paintToolsHead();
};

// R3's one global write. Deliberately NOT guarded by `running`/`submitting`: the route
// is write-anytime (../server/api.ts `patchTool` — no `assertIdleForToolMutation`), and
// the request being served keeps the tool list it was given, so the switch simply takes
// effect on the NEXT request.
//
// Single-flight per name (a double press must not send two PATCHes), and every repaint
// comes from the server's answer: the PATCH returns the whole updated `ToolDetail`, so
// the row shows the figure the store holds, not the value that was sent.
const setToolEnabled = async (name: string, enabled: boolean): Promise<void> => {
    if (togglingTools.has(name)) return;

    togglingTools.add(name);
    paintToolEnableBusy(name, true);
    // An app-scoped config write: the topbar pill reports the window exactly like the
    // plugin settings save does.
    setStatus('saving', `tool enablement: ${name}`);

    try {
        const detail = await updateToolEnabled(name, enabled);

        rememberToolRow(detail);
        setStatus('idle');
    } catch (error) {
        // The server's own sentence (a 404 for an unknown name, a 4xx for a write this
        // server refuses) goes on the topbar pill — the one surface this pane still
        // reports a refusal on, since the reader asked for no line under the title.
        // Nothing was written, so the `finally` pass pulls the tick, the control's
        // `data-enabled` and the tile's green edge back to the figure the cache holds.
        const message = messageOf(error);

        setStatus('error', `tool enablement: ${message}`);
    } finally {
        togglingTools.delete(name);
        paintToolEnableBusy(name, false);
    }
};
// R1: rows are NEVER disabled by a run — the list stays clickable while a thread
// streams, and `selectTool` no longer refuses the click.
//
// R1 (this pass): EVERY row carries the tool's global enablement tick box in its
// top-right corner, harness-owned core entries included — the "core" pin and the
// pinned-set branch it keyed on are gone, because the server now makes the whole
// catalogue switchable. The tile itself is a `<button>`, which cannot contain a control, so the
// box is the button's SIBLING inside `.tool-tab-row` (a button inside a button is not
// valid HTML and assistive tech would read one control where there are two) and CSS
// pins it to the corner above the tile.
// R5 (Tools Catalogue): ONE flat A–Z list, no group sections.
//
// The pane used to emit a `.tool-tab-group` heading every time the entry's group changed,
// which split the catalogue into labelled blocks ("Core tools", then each registration
// group) and forced the reader to scan three sections to find one tool. The reader asked for
// the whole catalogue in one alphabetical run instead — which also answers the "what is the
// difference between Core tools and Package presets?" question by removing the distinction
// from THIS view: a tool's kind is still on its meta line (`core · session`, `searchable`),
// only the section headings are gone.
//
// Only the RENDER order changes. The server's array order (core tools first, then catalogue
// registration order — src/server/api.ts:1044-1045) and every row's `group` field are left
// exactly as they arrive: `group` still paints the runner dialog's head badge (`selectTool`)
// and still feeds the `GET /tools?group=` filter, and `toolEntries` (the head count and the
// runner lookups) keeps the untouched array.
//
// The compare is case-insensitive and code-point based — NOT `localeCompare`, so the order is
// identical on every ICU build and in every test run — and `Array.prototype.sort` is stable,
// so two rows that compare equal keep the order the server listed them in. `toolRegistry`
// precedes `toolRequest` because 'g' < 'q' at the sixth character.
const byToolName = (left: ToolRowEntry, right: ToolRowEntry): number => {
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();

    if (a === b) return 0;

    return a < b ? -1 : 1;
};

const buildToolsTab = (entries: readonly ToolRowEntry[]): void => {
    toolsTabList.replaceChildren();
    toolTabButtons.clear();
    toolEnableBoxes.clear();

    // A copy, sorted: the caller's array stays the server's order for every other reader.
    for (const entry of [...entries].sort(byToolName)) {
        const row = el('div', 'tool-tab-row');

        const button = el('button', 'tool-tab-button');
        button.type = 'button';
        button.dataset.tool = entry.name;
        button.setAttribute('aria-pressed', 'false');
        // The activation opens a modal runner rather than an inline panel, so the
        // control advertises the popup kind to assistive technology. The button is
        // passed back as `returnFocus` so closing restores focus here.
        button.setAttribute('aria-haspopup', 'dialog');

        const unavailable = entry.availability?.state === 'unconfigured';
        const kind = [
            entry.visibility,
            ...(entry.sessionBound === true ? ['session'] : []),
            ...(unavailable ? ['unconfigured'] : [])
        ].join(' · ');
        if (unavailable) button.dataset.availability = 'unconfigured';
        // R1: the tile states the tick box's state too, so the list is readable with the
        // control off-screen — and `data-enabled='true'` is what paints the green edge
        // (an `--ok-line` border on the tile, no background wash; styles.css:1042-1058).
        if (entry.enabled !== undefined) button.dataset.enabled = entry.enabled ? 'true' : 'false';

        button.append(
            el('span', 'tool-tab-name', entry.name),
            el('span', 'tool-tab-kind', kind)
        );
        button.addEventListener('click', () => selectTool(entry, button));
        row.append(button);

        // The enablement affordance: one corner tick box for EVERY row that states an
        // enablement (core tools included), and NOTHING for a row that never stated one.
        if (entry.enabled !== undefined) {
            const control = toolEnableCheckboxOf(entry);

            row.append(control);
            toolEnableBoxes.set(entry.name, control);
        }

        toolTabButtons.set(entry.name, button);
        toolsTabList.append(row);
    }

    if (entries.length === 0) {
        toolsTabList.append(
            el('p', 'field-hint', 'The server reported no tools. Check that the harness server is reachable.')
        );
    }
};

// The identified tool reads this browser has already paid for (T50).
//
// A catalogue PAGE row is a `ToolSummary`: name, group, description, tags, visibility,
// availability and `session_bound` — and deliberately NO argument schema, because the schema
// lives on the identified read (../shared/harness-api.ts:636-648, `ToolDetail` at :654). The
// runner paints three things from that schema — the preset list, the single-property rule line
// and the schema pane — so painting a bare row fills the box with `{}` and claims "this schema
// declares no properties" for a tool that has a full one (the `files`/`widgetManage`
// regressions this memo exists to end).
//
// The detail is therefore fetched when, and only when, a tool is opened, and memoized for as
// long as the catalogue page it came from is current: `buildTools` replaces that page (boot, a
// catalogue refresh) and drops the memo, which is the revision boundary this resource actually
// publishes (`ToolDetail` carries no counter of its own). A failed read is not memoized, so the
// next open asks again, and no list render ever waits on or fans out these reads.
const toolDetails = new Map<string, ToolRowEntry>();

// Row + identified read, as one descriptor. The row's display facts stay (that is what the list
// showed and what the click was made on); the schema, availability and session scope come from
// the detail, because that is the only read that states them. R3: so does `enabled` — the
// identified row is the fresher statement of the tick box, and a runner opened from an older
// page must not describe a switch the server has since moved.
const toolDescriptorOf = (row: ToolRowEntry, detail: ToolDetail): ToolRowEntry => {
    const merged = toolRowOf(detail);

    return {
        ...row,
        ...(merged.availability === undefined ? {} : { availability: merged.availability }),
        sessionBound: merged.sessionBound,
        // R3: the switch's state comes from the read that states it freshest.
        enabled: merged.enabled,
        parameters: (detail.parameters ?? {}) as Record<string, unknown>
    };
};

// Pull one entry's schema, then repaint ONLY if that tool is still the one on screen. A late
// answer for a tool the reader already left must not replace the runner underneath them.
const hydrateToolDetail = async (row: ToolRowEntry): Promise<void> => {
    const detail = await getTool(row.name).catch<ToolDetail | undefined>(() => undefined);
    if (detail === undefined) return;

    const merged = toolDescriptorOf(row, detail);
    toolDetails.set(row.name, merged);
    if (currentTool === undefined || currentTool.name !== row.name) return;

    currentTool = merged;
    // The runner owns every schema-derived surface (schema pane, presets, the rule line and the
    // availability note), so one repaint is the whole update. The head keeps the facts the row
    // already stated: `availability` rides the catalogue row, and a tools-view heading painter
    // would erase the selected tool's name.
    runner.show(merged, true);
};

// Boot entry for the catalogue. R21.2: the tools view is the sole listing, so this
// only caches the entries (for `setToolsView`) and rebuilds that list — no
// right-rail duplicate to keep in sync any more.
const buildTools = (entries: readonly ToolRowEntry[]): void => {
    toolEntries = entries;
    // A new catalogue page is a new revision of every row in it, so every memoized identified
    // read describes a list the server has since replaced.
    toolDetails.clear();
    buildToolsTab(entries);
};

// ---------------------------------------------------------------------------
// Plugins view (T7 / R2-R3): the auto-scanned catalogue and its settings editor
// ---------------------------------------------------------------------------
//
// R2 asked for a Plugins button next to Tools that shows what the server ships; R3 adds
// the shipped Context Compaction plugin with an EDITABLE context limit. The two halves
// of that answer are deliberately different:
//
//   - ENABLEMENT is a ONE-CLICK GLOBAL WRITE (R2, this pass). Loading is still
//     auto-scanned — nothing here installs or uninstalls a plugin — but every row carries
//     a switch, and `PluginSummary.enabled` is the TOP-LEVEL field it paints from
//     (../shared/harness-api.ts:676-689). The write is the ordinary settings PATCH with
//     the framework's RESERVED `enabled` key:
//     `PATCH /plugins/{id}` `{ settings: { enabled: <boolean> } }`. It is accepted for
//     EVERY plugin, whether or not that plugin declares the key itself, it has no idle
//     window, and it takes effect in every conversation from its next turn
//     (../server/plugins.ts "THE RESERVED `enabled` KEY").
//
//     WHY `values.enabled` IS NEVER READ: `values` reports DECLARED settings only
//     (../server/plugins.ts:47-50 — "a key absent from `settings` never appears there"),
//     so for a plugin that declares no `enabled` the map has nothing under that key while
//     the row's own `enabled` field still states the switch. Painting the toggle from
//     `values` would show every undeclared plugin as off.
//   - SETTINGS stay editable, and the row dialog is the only write path for them:
//     `PATCH /plugins/{id}` with `{ settings: { key: value } }`.
//
// STRUCTURE mirrors the tools view (the code directly above) on purpose: an icon-only
// toggle on the harness title row, a full-width `.plugins-pane` in `stage`, `.plugin-tab-row`
// rows (a dialog trigger plus its own enablement switch), and the SHARED modal
// (`ui/dialog.ts`) for the detail. The centre column has ONE owner, so `setPluginsView` and
// `setToolsView` close each other.
//
// WHY THE PAGE IS CACHED AND RE-READ BY HAND
// ------------------------------------------
// `GET /plugins` answers the whole surface in one document (descriptor + effective
// values), and the server publishes NO stream update kind for plugins (T5): the only way
// a row goes stale is another visitor writing it. So the first open pays for the read,
// every later open repaints from `pluginRows`, and `Reload plugins` (plus the Retry
// button on a failed read) is the explicit re-read. A SAVE merges the PATCH answer into
// the same cache, which is why reopening a row shows the saved figure without a second
// request.
//
// WHY A SAVE REPAINTS IN PLACE
// ----------------------------
// `updatePluginSettings` returns the WHOLE row (the values it reports ARE the result of
// the write). The dialog therefore keeps its own DOM, takes the server's figures as the
// new form values, and repaints exactly one list row's settings line. Rebuilding the
// list would replace the button that opened the dialog, and `ui/dialog.ts` restores
// focus to a node that is still connected — so the dismissal would land the reader on
// `<body>`.

// The rows the browser has read (the whole page: the shipped set is small, and the
// contract's page order is the catalogue order).
let pluginRows: PluginSummary[] = [];
// Three transient read states, so the pane can tell "not asked yet" from "in flight"
// from "asked and refused". `pluginsLoaded` is the cache flag `loadPlugins` honours.
let pluginsLoaded = false;
let pluginsLoading = false;
let pluginsError: string | undefined;
// The open detail dialog and the NAME of the row it is showing (the row identity a save
// merges back into, and the row that carries `aria-pressed`). One dialog at a time, like
// the tool runner — a second activation replaces the first through `selectPlugin`.
let pluginDialog: DialogHandle | undefined;
let currentPlugin: string | undefined;

// The catalogue rows, keyed by plugin name, so a save repaints its own row; the
// `values` span is the line that carries the effective settings, and `toggle` is the
// row's enablement tick box (R2) — a SIBLING of the row button inside `.plugin-tab-row`,
// absolutely positioned in the wrapper's corner, never a control nested in another.
const pluginTabButtons = new Map<string, HTMLButtonElement>();
const pluginRowNodes = new Map<string, {
    button: HTMLButtonElement;
    values: HTMLSpanElement;
    toggle?: HTMLInputElement;
}>();
// R2: the tick boxes, keyed by plugin name, so `paintControls` can lock exactly the one
// whose write is in flight (`togglingPlugins`) — and nothing else, ever.
const pluginEnableBoxes = new Map<string, HTMLInputElement>();
const togglingPlugins = new Set<string>();

const pluginsPane = el('div', 'pane plugins-pane');
const pluginsTabHead = el('div', 'plugins-tab-head');
// The pane head carries the `h2` ONLY (see the append below), like the Tools pane's
// `toolsTabHead` above. Two lines of descriptive copy left it in this pass:
//   - the "Auto-scanned · tick to enable…" paragraph (`pluginsTabHint`), and
//   - the `pluginsTabNote` count line that restated the view head's own subtitle.
// Both are gone with their rules in styles.css. Nothing else was dropped: every state that
// line carried still has a home — the loaded count sentence is the head subtitle
// (`paintPluginsHead` → `headNote`), and the loading and read-failure states are painted
// INSIDE the list itself (`.plugins-loading` / `.plugins-error` + Retry, in `buildPluginsTab`).
// The enablement line (R2): the outcome of a row's switch write — the accepted figure or
// the server's refusal, never a colour-only signal. It is feedback, not description, so it
// SURVIVES the copy removal; it is SEPARATE from the head subtitle (`pluginsCountNote`) on
// purpose, so a refusal can never be mistaken for a failed catalogue read and neither
// writer can paint the other's sentence away. `notePluginToggleResult` is its only writer,
// and the footer below is what holds it now that the head is the bare title.
const pluginsTabStatus = el('p', 'plugins-tab-status field-hint', '');
pluginsTabStatus.setAttribute('role', 'status');
pluginsTabStatus.setAttribute('aria-live', 'polite');
pluginsTabStatus.hidden = true;

const pluginsRefresh = el('button', 'button plugins-refresh', 'Reload plugins');
pluginsRefresh.type = 'button';
// Same gate as the toggle it belongs to: nothing is readable before boot has answered,
// and `buildPluginsTab`/`paintControls` are the only writers afterwards. R1 removed the
// run lock — a re-read is a GET, and a streaming queue does not make it meaningless.
pluginsRefresh.disabled = true;
// Deferred read (the same discipline every other control in this file follows):
// `loadPlugins` is a module-level `const` declared below this listener's installation.
pluginsRefresh.addEventListener('click', () => {
    void loadPlugins(true);
});
pluginsTabHead.append(el('h2', 'plugins-tab-title', 'Plugins'));
// The list is the whole content area, exactly like `.tool-tab-list`.
const pluginsTabList = el('div', 'plugin-tab-list');
// The re-read control used to be the last line of `.plugins-tab-head`, where it read as part
// of the descriptive copy. It now owns a FOOTER row appended AFTER the list, and
// `.plugins-tab-footer` (flex, `justify-content: flex-end`) is what puts it in the pane's
// bottom-right corner — a static box inside the pane, so it scrolls and sizes with this view
// and never overlays another one the way `position: fixed` would. Nothing about the control
// itself moved: same element, same label, same click handler, same `disabled` gates
// (`buildPluginsTab`/`paintControls`/the offline path are still the only writers).
//
// The enablement line joined it in this pass: with the head reduced to the bare title there is
// no descriptive block left to carry feedback, and the pane's child list must stay
// `[head, list, footer]`. It sits BEFORE the button, so the pair stays a right-aligned strip
// (`justify-content: flex-end`) and "Reload plugins" remains the footer's only `<button>`.
const pluginsTabFooter = el('div', 'plugins-tab-footer');

pluginsTabFooter.append(pluginsTabStatus, pluginsRefresh);
pluginsPane.append(pluginsTabHead, pluginsTabList, pluginsTabFooter);

// One declared setting's value in the spelling this surface prints. The server's
// effective value wins and the declared default is the fallback, so a row never claims
// "undefined" for a key nothing was stored under.
const settingTextOf = (setting: PluginSetting, value: unknown): string => {
    const shown = value === undefined || value === null ? setting.default : value;

    return String(shown);
};

// The settings line a row shows: `key: effective value` per declared setting. This is
// the figure a SAVE repaints, so the list always states what is in force.
const pluginValuesOf = (plugin: PluginSummary): string =>
    plugin.settings
        .map((setting) => `${setting.key}: ${settingTextOf(setting, plugin.values[setting.key])}`)
        .join(' · ');

// Count labels, spelled the same in the pane, the head and the dialog.
const pluginHookLabel = (plugin: PluginSummary): string => {
    const count = plugin.hooks?.length ?? 0;

    return `${count} hook${count === 1 ? '' : 's'}`;
};

const pluginSettingLabel = (plugin: PluginSummary): string => {
    const count = plugin.settings.length;

    // R3: a plugin with no declared settings is pure behaviour — the pane says so
    // instead of leaving the reader looking for a control that does not exist.
    return count === 0 ? 'read-only' : `${count} setting${count === 1 ? '' : 's'}`;
};

// The "how many, and can we read them right now" sentence. ONE writer, because the head
// note and the pane note must never disagree about a failed or in-flight read.
const pluginsCountNote = (): string => {
    if (pluginsLoading) return 'Reading the plugin catalogue…';
    if (pluginsError !== undefined) return `The plugin catalogue could not be read: ${pluginsError}`;

    const count = pluginRows.length;

    return count === 0
        ? 'The server reported no plugins.'
        : `${count} plugin${count === 1 ? '' : 's'} · auto-scanned · settings save on the harness server`;
};

// The head while the Plugins view owns the centre and no dialog is open. Same contract
// as `paintToolsHead`: this is the ONLY writer of the head in that state, and the chat
// head hides the badge/note, so both are un-hidden here.
const paintPluginsHead = (): void => {
    headTitleText.textContent = 'Plugins';
    // A Plugins heading is not a harness, so the popup this head opens is the session
    // dashboard (the same T9 rule the tools head follows).
    paintHeadTitleTrigger('sessions');
    headName.hidden = false;
    headName.textContent = 'built-ins';
    headNote.hidden = false;
    headNote.textContent = pluginsCountNote();
};

// The head while ONE plugin's dialog is open: the heading names that plugin, not the
// catalogue. Mirrors `selectTool`'s head pass.
const paintPluginHead = (plugin: PluginSummary): void => {
    headTitleText.textContent = plugin.title;
    paintHeadTitleTrigger('sessions');
    // The registry key (`context-compaction`) is a category-style label here, so the
    // badge shows it and the note carries the version/hook/settings facts.
    headName.hidden = false;
    headName.textContent = plugin.name;
    headNote.hidden = false;
    headNote.textContent = [
        ...(plugin.version === undefined ? [] : [`v${plugin.version}`]),
        pluginHookLabel(plugin),
        pluginSettingLabel(plugin),
        ...(plugin.builtin ? ['built-in'] : ['custom'])
    ].join(' · ');
};

// Paint the head's title/badge for whichever of the two Plugins states is showing, so
// every async completion (a read landing, a dialog closing) re-describes the right thing.
const paintPluginsChrome = (): void => {
    const open = currentPlugin === undefined ? undefined : pluginRows.find((row) => row.name === currentPlugin);

    if (open !== undefined) paintPluginHead(open);
    else paintPluginsHead();
};

// Close the plugin dialog if one is open. Idempotent: every dismissal path (Escape,
// backdrop, close button, the other catalogue's toggle, a harness switch) converges on
// the same `onClose` reset.
const closePluginDialog = (): void => {
    pluginDialog?.close();
};

// Merge a fresh row into the cached page. Both the PATCH answer and a reload land here,
// so the cache is never a stale copy of a row the server just restated.
const rememberPlugin = (plugin: PluginSummary): void => {
    replacePluginRow(plugin);
    // A settings save happens INSIDE one plugin's dialog, so the merged row is also the
    // row the head is currently naming.
    currentPlugin = plugin.name;
};

// The same cache merge WITHOUT claiming a dialog is open: the row's enablement switch
// writes from the LIST, and a head painter that read `currentPlugin` would then describe
// a plugin whose layer was never opened.
const replacePluginRow = (plugin: PluginSummary): void => {
    const index = pluginRows.findIndex((row) => row.name === plugin.name);

    if (index >= 0) pluginRows[index] = plugin;
    else pluginRows = [...pluginRows, plugin];
};

// Repaint ONE row from its row data, without touching the list's other nodes (see the
// in-place-repaint note at the top of this section). The settings line AND the
// enablement switch move together, so a row can never show `enabled` on a dead switch.
const paintPluginRow = (plugin: PluginSummary): void => {
    const nodes = pluginRowNodes.get(plugin.name);
    if (nodes === undefined) return;

    nodes.values.textContent = pluginValuesOf(plugin);
    nodes.button.title = plugin.description ?? plugin.title;
    nodes.button.dataset.enabled = plugin.enabled === true ? 'true' : 'false';

    if (nodes.toggle !== undefined) paintPluginToggle(nodes.toggle, plugin);
};

// Paint one tick box from its row. Shared by the list builder and the repaint so the two
// can never disagree about what "on" looks like, sounds like, or is labelled as.
const paintPluginToggle = (control: HTMLInputElement, plugin: PluginSummary): void => {
    const enabled = plugin.enabled === true;

    control.className = enabled ? 'plugin-tab-enable is-on' : 'plugin-tab-enable is-off';
    // THE state — a native checkbox has no `aria-checked` to maintain, and `checked` is
    // also what the row's green edge (`.plugin-tab-button[data-enabled='true']`) follows.
    control.checked = enabled;
    control.dataset.enabled = enabled ? 'true' : 'false';
    control.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} ${plugin.title}`);
    control.title = enabled
        ? `Enabled for every conversation on this server · click to switch ${plugin.name} off`
        : `Disabled for every conversation on this server · click to switch ${plugin.name} on`;
    // R1: the only lock this control answers to is its OWN in-flight write.
    control.disabled = togglingPlugins.has(plugin.name) || !booted;
};

// R2's tick box, in the row's top-right corner. A real `input[type=checkbox]`: `checked`
// is the state for assistive tech, the accessible name is the ACTION, and the tile's green
// edge carries the same figure for the eye — the same three readings the tool rows use, and
// now the same recipe too: BOTH panes put the green on the tile's BORDER only (see
// `.plugin-tab-button[data-enabled='true']` and its tools twin in styles.css), because in
// either pane the background is the SELECTION channel (`--accent-soft` on `[aria-pressed]`).
// The box is the button's SIBLING and CSS lifts it
// above the tile, so clicking it writes enablement and never opens the dialog.
//
// `PluginSummary.enabled` is the field this paints from. It is a TOP-LEVEL row field,
// NOT `values.enabled`: `values` carries declared settings only
// (../shared/harness-api.ts `PluginSummary` and ../server/plugins.ts's own memo), so a
// plugin that never declares `enabled` has nothing under that key.
const pluginEnableCheckboxOf = (plugin: PluginSummary): HTMLInputElement => {
    const control = el('input', 'plugin-tab-enable');

    control.type = 'checkbox';
    control.dataset.plugin = plugin.name;
    paintPluginToggle(control, plugin);
    // The click reads the CACHE, so a second press inverts what the server last reported
    // rather than what this frame was built from. The value the browser just ticked is
    // ignored on purpose: `paintPluginToggleBusy` repaints the box from the cache when the
    // write lands (or is refused), so the tick always ends up where the server says.
    control.addEventListener('click', () => {
        const current = pluginRows.find((row) => row.name === plugin.name) ?? plugin;

        void setPluginEnabled(plugin.name, current.enabled !== true);
    });

    return control;
};

// Lock/unlock one row's tick box while its own write is in flight (R1 left the rows and
// the pane untouched — this is the single remaining disabled state).
const paintPluginToggleBusy = (name: string, busy: boolean): void => {
    const control = pluginEnableBoxes.get(name);
    const row = pluginRows.find((candidate) => candidate.name === name);

    if (control === undefined) return;

    control.disabled = busy;
    control.setAttribute('aria-busy', busy ? 'true' : 'false');

    // A repaint after the write lands must not re-enable a control whose PATCH is still
    // out, so the state painter reads the same set the paint pass does. This is also the
    // REVERT path for a refused write: a native checkbox flipped itself on click, and the
    // cache never moved, so repainting from the row pulls the tick back.
    if (!busy && row !== undefined) paintPluginToggle(control, row);
};

// The pane's one sentence about a switch write. Separate from the view head's count
// subtitle on purpose: that line is the catalogue count and the read failure.
const notePluginToggleResult = (text: string, failed: boolean): void => {
    pluginsTabStatus.textContent = text;
    pluginsTabStatus.hidden = false;
    // Text AND class: colour is never the only signal (the shell's standing rule).
    pluginsTabStatus.className = failed ? 'plugins-tab-status plugins-tab-status-error' : 'plugins-tab-status field-hint';
};

// R2's one global write. Like the tool switch it is NOT gated by `running`/`submitting`:
// `PATCH /plugins/{id}` with the reserved `enabled` key takes effect in every session
// from its next turn and has no idle window (../shared/harness-api.ts
// `PluginSettingsUpdate`, ../server/plugins.ts "THE RESERVED `enabled` KEY").
//
// The answer is the WHOLE row, so the cache, the row and the head all take the server's
// figure; a refusal touches none of them (nothing was written) and prints the server's
// sentence verbatim, the same way the settings save does.
const setPluginEnabled = async (name: string, enabled: boolean): Promise<void> => {
    if (togglingPlugins.has(name)) return;

    togglingPlugins.add(name);
    paintPluginToggleBusy(name, true);
    // An app-scoped config write, exactly like the settings save.
    setStatus('saving', `plugin enablement: ${name}`);

    try {
        const updated = await updatePluginSettings(name, { enabled });

        replacePluginRow(updated);
        paintPluginRow(updated);
        // The head subtitle is the only place the count sentence lives now, and
        // `paintPluginsChrome` repaints it from the same `pluginsCountNote()` the removed
        // pane line used — the row count cannot move on an enablement write anyway.
        if (showingPlugins) paintPluginsChrome();
        notePluginToggleResult(
            `${updated.title} is now ${updated.enabled ? 'enabled' : 'disabled'} for every conversation.`,
            false
        );
        setStatus('idle');
    } catch (error) {
        const message = messageOf(error);

        notePluginToggleResult(message, true);
        setStatus('error', `plugin enablement: ${message}`);
    } finally {
        togglingPlugins.delete(name);
        paintPluginToggleBusy(name, false);
    }
};

// Build the catalogue list: loading, empty, and an error WITH a retry are real states of
// this surface, not a blank column. Every row is a dialog trigger, so it advertises the
// popup kind and passes itself back as the close-time focus target.
const buildPluginsTab = (): void => {
    pluginsTabList.replaceChildren();
    pluginTabButtons.clear();
    pluginRowNodes.clear();
    // The tick boxes are rebuilt with the list, so the key set follows the nodes exactly.
    pluginEnableBoxes.clear();
    pluginsRefresh.disabled = pluginsLoading || !booted;

    if (pluginsLoading && pluginRows.length === 0) {
        pluginsTabList.append(el('p', 'field-hint plugins-loading', 'Reading the plugin catalogue…'));

        return;
    }

    if (pluginsError !== undefined && pluginRows.length === 0) {
        // The server's own sentence, verbatim (api.ts flattens `ErrorBody` to exactly
        // that), plus the one action that can fix it.
        pluginsTabList.append(el('p', 'field-hint plugins-error', pluginsError));

        const retry = el('button', 'button plugins-retry', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => {
            void loadPlugins(true);
        });
        pluginsTabList.append(retry);

        return;
    }

    if (pluginRows.length === 0) {
        pluginsTabList.append(
            el('p', 'field-hint', 'The server reported no plugins. Check that the harness server is reachable.')
        );

        return;
    }

    for (const plugin of pluginRows) {
        // R2: the row is a WRAPPER with two siblings — the dialog trigger and the
        // enablement tick box. A `<button>` cannot contain a control, so the nesting that
        // used to hold the whole row becomes a flex row instead, and CSS pins the box to
        // the wrapper's top-right corner above the tile. Each control keeps its own
        // accessible name, and a click on the box can never open the dialog.
        const row = el('div', 'plugin-tab-row');

        const button = el('button', 'plugin-tab-button');
        button.type = 'button';
        button.dataset.plugin = plugin.name;
        button.setAttribute('aria-pressed', plugin.name === currentPlugin ? 'true' : 'false');
        button.setAttribute('aria-haspopup', 'dialog');
        button.title = plugin.description ?? plugin.title;
        // R2: the row states the tick box's state on the trigger too (`data-enabled`), so
        // the list is readable with the control out of view — and it is the figure CSS
        // paints the enabled green EDGE (`--ok-line`) from.
        button.dataset.enabled = plugin.enabled === true ? 'true' : 'false';
        // The whole row is kept, never truncated away: the description is the part a
        // reader scans, so CSS clamps it to two lines (`.plugin-tab-desc`) and the full
        // text stays in the row's accessible description.
        const meta = el(
            'span',
            'plugin-tab-meta',
            `${pluginHookLabel(plugin)} · ${pluginSettingLabel(plugin)} · ${plugin.builtin ? 'built-in' : 'custom'}`
        );

        // The effective settings line. A plugin that declares nothing gets the explicit
        // `no settings` word rather than an empty line the reader has to interpret.
        const values = el('span', 'plugin-tab-values', plugin.settings.length === 0 ? 'no settings' : pluginValuesOf(plugin));

        button.append(
            el('span', 'plugin-tab-title', plugin.title),
            el('span', 'plugin-tab-name', plugin.name),
            el('span', 'plugin-tab-desc', plugin.description ?? 'No description.'),
            meta,
            values
        );
        // The row's data comes from the CACHE at click time, not from the closure: a save
        // merges a new row into `pluginRows`, and a dialog opened after that must show the
        // server's figures rather than the object this list frame was built from.
        button.addEventListener('click', () => {
            selectPlugin(pluginRows.find((row) => row.name === plugin.name) ?? plugin, button);
        });
        // R1: no run/submit lock on the row — the catalogue is clickable while a thread
        // streams, and the dialog's own save handler is single-flight on its own write.

        const toggle = pluginEnableCheckboxOf(plugin);

        row.append(button, toggle);
        pluginTabButtons.set(plugin.name, button);
        pluginEnableBoxes.set(plugin.name, toggle);
        pluginRowNodes.set(plugin.name, { button, values, toggle });
        pluginsTabList.append(row);
    }
};

// Read the catalogue. `force` is the Reload/Retry path; without it a cached page is
// painted from, which is what keeps the second (and every later) open free of traffic.
const loadPlugins = async (force = false): Promise<void> => {
    // Single-flight: a double press of Reload, or an open while a read is in flight,
    // must not race two answers into the cache.
    if (pluginsLoading) return;
    if (pluginsLoaded && !force) {
        buildPluginsTab();

        return;
    }

    pluginsLoading = true;
    pluginsError = undefined;
    buildPluginsTab();
    if (showingPlugins) paintPluginsChrome();

    try {
        const page = await listPlugins();
        pluginRows = [...page.items];
        pluginsLoaded = true;
        pluginsError = undefined;
    } catch (error) {
        // NOT memoized: the next open (or Retry) asks again, exactly like the tool
        // detail read above.
        pluginsError = messageOf(error);
    } finally {
        pluginsLoading = false;
        buildPluginsTab();
        if (showingPlugins) paintPluginsChrome();
    }
};

// The value one control holds right now, or `undefined` when it does not hold a value of
// the declared type (an emptied number box). Two callers need this and must NOT disagree:
// the dirty test (not-a-value means "nothing to send") and the save (a number field the
// reader cleared is a refusal to save, with a message naming the field).
const literalOf = (setting: PluginSetting, input: HTMLInputElement): number | string | boolean | undefined => {
    if (setting.type === 'boolean') return input.checked;
    if (setting.type === 'string') return input.value;

    const text = input.value.trim();
    const parsed = Number(text);

    return text.length === 0 || !Number.isFinite(parsed) ? undefined : parsed;
};

// The value the form is showing as current: the server's effective value, falling back
// to the declared default for a key nothing was stored under. Every dirty comparison and
// every reset after a refused/accepted write is taken from this.
const effectiveOf = (plugin: PluginSummary, setting: PluginSetting): number | string | boolean => {
    const stored = plugin.values[setting.key];

    return stored === undefined || stored === null ? setting.default : (stored as number | string | boolean);
};

// Write the declared hints onto the control. `min`/`max` are what the SERVER validates
// (../shared/harness-api.ts:640-657) and `step` only bounds what a spinner offers, so all
// three go on the element and the browser can pre-validation nudge the reader.
const applySettingHints = (setting: PluginSetting, input: HTMLInputElement): void => {
    if (setting.type !== 'number') return;
    if (setting.min !== undefined) input.min = String(setting.min);
    if (setting.max !== undefined) input.max = String(setting.max);
    if (setting.step !== undefined) input.step = String(setting.step);
};

// One labelled control per declared setting. The label is a real `<label for>`, the hint
// is the setting's own description, and every control is marked with its key so the save
// handler walks the form instead of guessing.
const buildSettingField = (
    plugin: PluginSummary,
    setting: PluginSetting,
    register: (field: PluginField) => void
): HTMLElement => {
    const row = el('div', 'plugin-setting');
    const inputId = `plugin-setting-${plugin.name}-${setting.key}`;
    const input = el('input', 'plugin-setting-input');
    input.id = inputId;
    input.dataset.setting = setting.key;
    input.type = setting.type === 'number' ? 'number' : setting.type === 'boolean' ? 'checkbox' : 'text';
    applySettingHints(setting, input);

    const current = effectiveOf(plugin, setting);

    if (setting.type === 'boolean') input.checked = current === true;
    else input.value = String(current);

    const label = el('label', 'plugin-setting-label', setting.label);
    label.htmlFor = inputId;
    row.append(label, input);

    if (setting.description !== undefined) {
        // Text, never markup: a plugin manifest is server data (the same data-only rule
        // `ui/dialog.ts` enforces for `content`).
        row.append(el('p', 'plugin-setting-hint', setting.description));
    }

    register({ setting, input });

    return row;
};

// A field of the form, plus the row it belongs to.
type PluginField = { setting: PluginSetting; input: HTMLInputElement };

// --- grouped and gated settings (T5/R3) --------------------------------------
//
// The TWO OPTIONAL descriptor fields the plugin-settings contract grew (2026-11-13), spelled
// exactly as the contract spells them:
//   * `group: { id, title }` — settings sharing an `id` belong to one titled block, so a
//     seventeen-row manifest reads as six decisions instead of seventeen rows;
//   * `parentKey` — the key of the BOOLEAN setting whose tick decides whether this row is
//     shown at all, which is the shape the operator asked for: `Trim after (tool turns)`
//     sits under a ticked `Automatic trim invalid tools` and disappears when the tick is off.
// Both are declared on `PluginSetting` (../shared/harness-api.ts:942-956) beside
// `HarnessPluginSettingDescriptor` (../types/index.ts:4138-4145), and projected onto the wire
// field by field by `src/server/api.ts` `pluginSettingOf`, so this file reads them straight off
// the contract type — it adds no field of its own. A plugin that declares NEITHER keeps the
// flat form exactly as it rendered before, and `plugins-tab.test.ts` pins that claim on the DOM
// rather than in prose.

// The reserved framework key (../server/plugins.ts): the plugin's own master switch. When a
// plugin DECLARES it, that row is a setting like any other, and the only thing the pane does
// with it is DIM the policy blocks it governs — it never hides them, because an operator who
// switched a plugin off is exactly the reader about to edit its policy. The shipped Context
// Trimmer declares `enabled` with NO `group` on purpose (../plugins/context-trimmer.plugin.ts
// :454-471), so the switch sits above the blocks and the dim has something to fall on.
const MASTER_SETTING_KEY = 'enabled';

// The one safe id fragment: a plugin owns `group.id` as free text, and `ui/action-request.ts`
// already sanitises the same way when a server string has to become an element id.
const idFragmentOf = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');

// Build the whole settings body into `form` and hand back `paintGates`, the function that
// re-reads every parent tick and re-applies what that makes visible.
//
// ONE pass over `plugin.settings`, in the plugin's declared order — no sorting, no
// re-derivation from a second source — with three placement rules:
//   1. a setting with no `group` is a plain row on the form, at the index it declares, and
//      NOTHING else is created (so an ungrouped plugin's DOM is the pre-contract DOM);
//   2. consecutive settings with the SAME `group.id` share one `role="group"` block, opened
//      by a new id or by an intervening flat row;
//   3. a setting with `parentKey` goes into that parent's indented host instead, which is
//      attached IMMEDIATELY AFTER the parent's own row — inside the same block — whether the
//      child was declared before or after it.
// `paintGates` is called once here (the SEEDED state, from the values on the row) and again
// after every save repaint.
const buildSettingsForm = (
    form: HTMLElement,
    plugin: PluginSummary,
    register: (field: PluginField) => void
): (() => void) => {
    // key -> its control. Every reveal resolves `parentKey` through this map, which is why
    // declaration order cannot break the nesting.
    const inputs = new Map<string, HTMLInputElement>();
    // key -> where that key's OWN row was emitted, so its children can be hung off it. EVERY
    // setting is registered here, gated or not (D5): a gated setting is a parent candidate
    // exactly like an ungated one, and `childrenOf` resolves placement through this map, so a
    // missing entry would leave its children's host detached and flush it at the form root.
    const emitted = new Map<string, { host: HTMLElement; row: HTMLElement }>();
    // parentKey -> that parent's indented host, created on its FIRST child and never before,
    // so a plugin with no gated rows never grows an empty indent box.
    const childHosts = new Map<string, HTMLElement>();
    // Every gated row, with the key that decides it AND the indent host it lives in. Recorded
    // during the walk, applied after it, so a child declared before its parent still sees a
    // real control. The host travels with the row because `paintGates` has to be able to hide
    // a host whose whole branch is collapsed (D3) — and only this list knows which rows are
    // gated, which rows live in which host, and (via nested hosts, D5) that a host can hold
    // hosts that are NOT gated rows.
    const gates: Array<{ row: HTMLElement; parentKey: string; host: HTMLElement }> = [];
    // key -> the DECLARED type of that setting. A gate only counts when the setting its
    // `parentKey` names is declared `boolean` (D6): reading `input.checked` off a number or
    // text control gives `undefined`, which would hide the child forever with no switch to
    // turn it back on. Filled during the walk, read by `paintGates`, because a child may be
    // declared before its parent and this map is only complete when the walk ends.
    const declaredTypes = new Map<string, PluginSetting['type']>();
    // The KEYS whose tick anything depends on — every `parentKey` a gated row named, plus the
    // master switch. Keys rather than controls, because a child may be declared before its
    // parent and the control map is only complete when the walk ends.
    const triggerKeys = new Set<string>();
    // The single wrapper that holds every block (the dim marks ONE element), the blocks in
    // the order they were opened (which is what keeps a re-used `group.id` from sharing one
    // heading across two blocks), and the block the previous setting opened, which is the id
    // the next setting is compared against.
    let groupsHost: HTMLElement | undefined;
    const blocks: HTMLElement[] = [];
    let openGroup: { id: string; node: HTMLElement } | undefined;
    let masterSwitch: HTMLInputElement | undefined;

    // The block this setting belongs to, opening a new one when the id changed.
    const blockOf = (group: PluginSetting['group']): HTMLElement => {
        if (group === undefined) return form;
        if (openGroup !== undefined && openGroup.id === group.id) return openGroup.node;

        const node = el('div', 'plugin-settings-group');
        // `aria-labelledby` (not `aria-label`): the visible caption IS the accessible name,
        // so the two can never drift apart. The index keeps a re-used id unique, because a
        // plugin that opens the same block twice gets two headings and two blocks.
        const title = el('h4', 'plugin-setting-group-title', group.title);

        title.id = `plugin-setting-group-${idFragmentOf(plugin.name)}-${idFragmentOf(group.id)}-${blocks.length}`;
        node.setAttribute('role', 'group');
        node.setAttribute('aria-labelledby', title.id);
        node.append(title);

        // The wrapper only exists for a plugin that groups at all, and it sits at the form's
        // current end — the position the first block declares.
        if (groupsHost === undefined) {
            groupsHost = el('div', 'plugin-settings-groups');
            form.append(groupsHost);
        }

        groupsHost.append(node);
        blocks.push(node);
        openGroup = { id: group.id, node };

        return node;
    };

    // The indented host of one parent, attached under that parent's row the moment the row
    // exists (see the walk).
    const childrenOf = (parentKey: string): HTMLElement => {
        const existing = childHosts.get(parentKey);

        if (existing !== undefined) return existing;

        const host = el('div', 'plugin-setting-children');
        // Read-only handle for CSS and for a reader inspecting the dialog; the reveal itself
        // resolves through `inputs`, never through this attribute.
        host.dataset.parent = parentKey;
        childHosts.set(parentKey, host);

        const parent = emitted.get(parentKey);

        // Parent already emitted → hang the block directly under it, in its own group.
        // Not emitted yet → the host stays detached until the walk reaches the parent, and
        // the flush at the end of this function is what guarantees it lands on screen anyway.
        if (parent !== undefined) parent.host.insertBefore(host, parent.row.nextSibling);

        return host;
    };

    // What "visible" means for the whole form, re-derived from the controls every time so
    // the DOM can never disagree with a tick:
    //   * a gated row is `hidden` while its parent is unticked. `hidden` on the ROW, never a
    //     class, because `[hidden] { display: none !important }` (styles.css:118) is this
    //     app's one authoritative hiding rule and a native control inside a hidden subtree is
    //     unfocusable — the part that keeps a switched-off setting out of the tab order. The
    //     control stays REGISTERED and savable, because only its visibility changes;
    //   * ONLY a DECLARED-BOOLEAN `parentKey` gates anything (D6). A key that names no setting
    //     at all, and a key that names a number or a text setting, are both treated the same
    //     way — the child renders SHOWN. Both are manifest bugs, and a wrong-typed parent used
    //     to strand its children permanently: `input.checked` on a number box is `undefined`,
    //     so the row hid with no checkbox anywhere to bring it back;
    //   * an indent host hides ITSELF once every gated row inside it is hidden (D3). A host at
    //     0 height is still a flex item in the `gap: 8px` column of `.plugin-settings-group`,
    //     so an all-hidden branch used to leave a dead ~8px gap under its parent, and
    //     `.plugin-setting-children:empty` can never match a host full of HIDDEN rows. Hiding
    //     the host also hides any nested host it holds (D5), because `display: none` on an
    //     ancestor takes the whole subtree out of the render tree — which is what keeps a
    //     grandchild from floating out from under a parent row that is itself hidden.
    const paintGates = (): void => {
        // host -> how many of its gated rows exist and how many of those are hidden. The tally
        // comes from `gates` rather than from `host.children`, because a host's children are
        // rows AND nested hosts, and only a host with NO visible gated row may hide.
        const tallies = new Map<HTMLElement, { total: number; hidden: number }>();

        for (const gate of gates) {
            // A non-boolean `parentKey` resolves to `undefined` here, which is the same branch
            // a dangling one takes — the two are meant to behave alike, see the note above.
            const control = declaredTypes.get(gate.parentKey) === 'boolean' ? inputs.get(gate.parentKey) : undefined;

            gate.row.hidden = control === undefined ? false : control.checked !== true;

            const tally = tallies.get(gate.host) ?? { total: 0, hidden: 0 };

            tally.total += 1;
            if (gate.row.hidden) tally.hidden += 1;
            tallies.set(gate.host, tally);
        }

        for (const [host, tally] of tallies) host.hidden = tally.hidden === tally.total;

        if (groupsHost !== undefined && masterSwitch !== undefined)
            groupsHost.classList.toggle('plugin-settings-groups--off', masterSwitch.checked !== true);
    };

    for (const setting of plugin.settings) {
        let input: HTMLInputElement | undefined;

        // `buildSettingField` is untouched: the same row, the same classes, the same order
        // inside it, whatever the setting is grouped under.
        const row = buildSettingField(plugin, setting, (field) => {
            register(field);
            inputs.set(field.setting.key, field.input);
            input = field.input;
        });

        // A local `const` re-widens the callback-assigned `input`: the assignment happens
        // inside `buildSettingField`'s callback, which control-flow analysis cannot see, so
        // `input` alone would still read as `undefined` at the line below.
        const control = input;

        if (control === undefined) continue;

        declaredTypes.set(setting.key, setting.type);

        // ONE host for both branches (D5): the block the setting belongs to when it is
        // ungated, that parent's indent host when it is gated. Both branches then register the
        // row in `emitted`, which is what lets a GATED setting act as a parent — while only the
        // ungated branch registered, a gated parent's own children host stayed detached and
        // the flush below dumped those rows at the FORM ROOT, outside the block that declares
        // them and outside the indent they belong to.
        const host = setting.parentKey === undefined ? blockOf(setting.group) : childrenOf(setting.parentKey);

        host.append(row);
        emitted.set(setting.key, { host, row });

        if (setting.parentKey !== undefined) {
            gates.push({ row, parentKey: setting.parentKey, host });
            triggerKeys.add(setting.parentKey);
        }

        // A child of this key was declared BEFORE this row, gated or not, so its host has to
        // move from wherever it was parked to directly under the row that gates it — inside the
        // same host this row just landed in, which is the whole point of a nested reveal.
        const children = childHosts.get(setting.key);

        if (children !== undefined) host.insertBefore(children, row.nextSibling);

        if (setting.key === MASTER_SETTING_KEY) {
            masterSwitch = control;
            // The dim follows the master tick the same way a reveal follows its parent, so the
            // master switch joins the same listener set rather than getting its own path.
            triggerKeys.add(MASTER_SETTING_KEY);
        }
    }

    // A `parentKey` naming nothing leaves its host detached, which would drop the row out of
    // the document while it stayed registered and savable — an invisible field nobody can
    // edit. Flushing the leftovers keeps every declared control on screen (and `paintGates`
    // renders those SHOWN, per the rule above).
    for (const host of childHosts.values()) {
        if (host.parentElement === null) form.append(host);
    }

    // One `input` + `change` pair per control anything depends on. `input` is the live-edit
    // signal this form already listens to for the status line, and `change` is the one a
    // checkbox fires on every commit; registering BOTH means the reveal lands in the SAME turn
    // however the reader flipped the tick (click, label click, Space, or an assistive tech
    // that only commits on blur), and `paintGates` re-derives everything from the controls, so
    // a doubled signal is free. A key that names no control is skipped — nothing can ever
    // change it, and its rows are the SHOWN ones `paintGates` already settled.
    for (const key of triggerKeys) {
        const control = inputs.get(key);

        if (control === undefined) continue;

        control.addEventListener('input', paintGates);
        control.addEventListener('change', paintGates);
    }

    // Seed the initial visibility from the seeded values — a dialog that opens with the tick
    // off must open with the dependent rows already gone.
    paintGates();

    return paintGates;
};

// Open one plugin's detail in the shared modal. The dialog owns Escape/backdrop/focus
// restore (the tools runner gets the same machinery), and the settings form is built
// fresh for every open, so the values it shows are always the cache's.
const openPluginDialog = (plugin: PluginSummary, trigger?: HTMLElement): void => {
    // The row THIS dialog is painted from. A save replaces it with the PATCH answer;
    // every repaint below reads this variable rather than the row passed in, so a late
    // answer can never paint figures from a superseded read.
    let shown = plugin;
    let saving = false;
    const fields: PluginField[] = [];
    // key -> its field. The save loop needs this for ONE thing (D4): a `parentKey` chain is
    // spelled in KEYS, and revealing a row its own tick hides means finding the ancestor
    // CONTROLS that chain names. Filled by the same registration callback as `fields`, so the
    // two can never disagree about what the form holds.
    const fieldsByKey = new Map<string, PluginField>();
    // Re-applies what each tick makes visible. `buildSettingsForm` seeds it during the build
    // and the save handler calls it again after every `paintValues()`; the read-only branch
    // has no settings, so it keeps this no-op.
    let paintGates: () => void = () => undefined;

    const body = el('div', 'plugin-detail');
    body.append(el('p', 'plugin-detail-description', plugin.description ?? 'No description.'));

    // Identity facts, existing metadata only (the discipline the harness details dialog
    // follows): name, version, tags and the builtin state.
    const facts = el('div', 'plugin-detail-facts');

    for (const fact of [
        plugin.name,
        ...(plugin.version === undefined ? [] : [`v${plugin.version}`]),
        plugin.builtin ? 'built-in' : 'custom',
        ...(plugin.tags === undefined || plugin.tags.length === 0 ? [] : [`tags: ${plugin.tags.join(', ')}`])
    ]) {
        facts.append(el('span', 'plugin-detail-fact', fact));
    }

    body.append(facts);

    // Declared hooks as chips: the live subscription list is the part that explains WHEN a
    // plugin runs, and the row only counts it.
    const hooksSection = el('div', 'plugin-detail-hooks');
    hooksSection.append(el('h3', 'plugin-detail-section-title', 'Hooks'));
    const hookList = el('div', 'plugin-hook-list');
    const hooks = plugin.hooks ?? [];

    if (hooks.length === 0) hookList.append(el('p', 'plugin-detail-empty', 'Declares no lifecycle hooks.'));
    else for (const hook of hooks) hookList.append(el('span', 'plugin-hook-chip', hook));

    hooksSection.append(hookList);
    body.append(hooksSection);

    // The system prompt this plugin sends, read-only (2026-11-12: the operator designed the
    // panel and asked to SEE the prompt, not guess it). Conditional on the row carrying a
    // NON-EMPTY field — `PluginSummary.system_prompt` is optional, and only a plugin that
    // prompts declares one — so EVERY other plugin's panel keeps the sections it had before,
    // in the same order (plugins-tab.test.ts pins `['Hooks','Settings']` for a row without it,
    // on both the synthetic row and the shipped `async-ping`). Empty counts as absent: the
    // contract declares `minLength: 1` (../server/harness.swagger.yaml), so `''` is "no prompt
    // declared", and a bare presence check would paint this heading over an empty <p>.
    // A `<p>`, deliberately not a `<pre>`: ui/dialog.css `.dialog-body pre` (specificity
    // 0,1,1) forces `white-space: pre` and would clip this 715-character prose to one
    // un-wrapped line; `.plugin-detail-prompt` (styles.css) carries the wrapping and the
    // scroll frame, mirroring `.agent-instruction`. Text, never markup — the same data-only
    // rule the setting hint above follows.
    if (plugin.system_prompt !== undefined && plugin.system_prompt !== '') {
        const promptSection = el('div', 'plugin-detail-prompt-section');

        promptSection.append(el('h3', 'plugin-detail-section-title', 'System prompt'));
        promptSection.append(el('p', 'plugin-detail-prompt', plugin.system_prompt));
        body.append(promptSection);
    }

    // --- settings -----------------------------------------------------------------
    const settingsSection = el('div', 'plugin-detail-settings');
    settingsSection.append(el('h3', 'plugin-detail-section-title', 'Settings'));

    // The status line is a polite live region: "Saving…", "Saved" and a refusal are all
    // things the reader is told about, and nothing here moves focus.
    const status = el('p', 'plugin-setting-status field-hint', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    let save: HTMLButtonElement | undefined;

    if (plugin.settings.length === 0) {
        // R3: no declared settings means nothing to edit. Rendered read-only on purpose
        // (no disabled inputs pretending an edit is pending), and with NO save control —
        // an action that could only ever send an empty patch.
        settingsSection.append(el('p', 'plugin-detail-empty', 'This plugin declares no settings · read-only.'));
        body.append(settingsSection);
    } else {
        const form = el('div', 'plugin-settings-form');
        form.setAttribute('role', 'group');
        form.append(el('span', 'plugin-settings-form-label', 'Plugin settings'));

        // T5/R3: this used to be a flat `for` loop appending one row per descriptor. It now
        // honours the two optional descriptor fields — titled blocks for a shared `group.id`,
        // and a gated row nested under the tick that reveals it — while an ungrouped manifest
        // still gets the identical flat rows in the identical order.
        paintGates = buildSettingsForm(form, plugin, (field) => {
            fields.push(field);
            fieldsByKey.set(field.setting.key, field);
        });

        settingsSection.append(form);

        const actions = el('div', 'plugin-setting-actions');

        save = el('button', 'button primary plugin-setting-save', 'Save');
        save.type = 'button';
        // NEVER disabled. The press is always live and a press with nothing changed sends
        // nothing (see the empty-patch guard below); the `saving` flag in the handler is
        // what keeps a double click from writing the same patch twice, so the control has
        // no honest reason to grey itself out.
        actions.append(save);
        settingsSection.append(actions, status);
        body.append(settingsSection);
    }

    // Take the server's figures as the form's current values. A write can clamp/normalise
    // what was sent, so the box shows what is IN FORCE afterwards, not what was typed.
    const paintValues = (): void => {
        for (const { setting, input } of fields) {
            const current = effectiveOf(shown, setting);

            if (setting.type === 'boolean') input.checked = current === true;
            else input.value = String(current);
        }

        // A programmatic `checked =` fires NO event, so the gated rows would otherwise keep
        // whatever visibility the reader last left them in while the SERVER's answer says a
        // parent moved. The server's figures are the truth here, so the reveal is re-taken
        // from them in the same pass.
        paintGates();
    };

    const note = (text: string, failed: boolean): void => {
        status.textContent = text;
        // Text AND class: colour is never the only signal (the shell's standing rule).
        status.className = failed ? 'plugin-setting-status plugin-setting-status-error' : 'plugin-setting-status field-hint';
    };

    // Reveal the whole gate chain of one setting (D4, 2026-11-13). A row its own tick hides is
    // STILL registered and still savable — that is the contract this form pins — so a value the
    // save loop refuses can sit in a field that is not on screen, and a refusal naming a row the
    // reader cannot see is only half actionable. Walking `parentKey` upward and ticking every
    // ancestor makes the offending row visible BEFORE the message is written, and the reader's
    // own tick chain is restored by the same paint.
    //
    // Nothing else moves: the typed text stays, the value is neither coerced nor dropped, no
    // `PATCH` leaves the browser, and the message keeps its exact wording.
    //
    // The walk stops at a `parentKey` naming nothing or naming a NON-boolean setting — those
    // gate nothing at all, which is exactly how `paintGates` treats them (D6), so there is no
    // tick to flip past that point. `visited` is the guard against a third-party manifest whose
    // keys point at each other in a cycle, which would otherwise spin here forever.
    const revealGateChain = (setting: PluginSetting): void => {
        const visited = new Set<string>();
        let parentKey = setting.parentKey;

        while (parentKey !== undefined && !visited.has(parentKey)) {
            visited.add(parentKey);

            const parent = fieldsByKey.get(parentKey);

            if (parent === undefined || parent.setting.type !== 'boolean') break;

            // A programmatic `checked =` fires NO event, which is why the reveal has to re-paint
            // by hand: the `input`/`change` listeners `buildSettingsForm` registered are what
            // normally carry a tick into the DOM, and a click that never happened cannot be
            // waited for here.
            parent.input.checked = true;
            parentKey = parent.setting.parentKey;
        }

        paintGates();
    };

    if (save !== undefined) {
        save.addEventListener('click', () => {
            void (async () => {
                if (saving) return;

                const patch: Record<string, number | string | boolean> = {};

                for (const { setting, input } of fields) {
                    const value = literalOf(setting, input);

                    if (value === undefined) {
                        // A cleared number box has no value to send; naming the field is
                        // the actionable part, and the typed text stays for the fix.
                        // D4: the row is revealed FIRST, then focused, so the sentence names
                        // something on screen and the cursor lands on the box to fix. Revealing
                        // is the only liberty taken here — the message text, the untouched value
                        // and the "no request" behaviour are all unchanged.
                        revealGateChain(setting);
                        note(`${setting.label} needs a number.`, true);
                        input.focus();

                        return;
                    }

                    // Only CHANGED keys go on the wire: an omitted key is documented as "no
                    // change" (../shared/harness-api.ts:695-706), so untouched settings are
                    // never rewritten by an unrelated save.
                    if (!Object.is(value, effectiveOf(shown, setting))) patch[setting.key] = value;
                }

                // Nothing changed, so nothing leaves the browser. The server REFUSES an
                // empty settings patch (`400` — "A plugin settings patch must change at
                // least one setting", ../server/plugins.ts:545-553), and sending every
                // field anyway would pin each untouched default as an explicit stored
                // override. A no-change press is therefore a silent no-op.
                if (Object.keys(patch).length === 0) return;

                saving = true;
                note('Saving…', false);
                // An app-scoped config write, so the topbar pill reports the window
                // exactly like the endpoint/model and harness writes do.
                setStatus('saving', `plugin settings: ${shown.name}`);

                try {
                    const updated = await updatePluginSettings(shown.name, patch);
                    // The answer IS the new state: merge it into the cache, repaint this
                    // row's settings line, and re-take the form's values from it.
                    shown = updated;
                    rememberPlugin(updated);
                    paintPluginRow(updated);
                    paintValues();
                    // Same reason as in `setPluginEnabled`: the count sentence lives only in
                    // the head subtitle, and `paintPluginsChrome` re-takes it from the cache.
                    if (showingPlugins) paintPluginsChrome();
                    note('Saved', false);
                    setStatus('idle');
                } catch (error) {
                    // The server's sentence, verbatim (a 400 for a value outside `min`/
                    // `max` is the validator's message, not a client guess) — and the
                    // form keeps what the reader typed, so the fix is one keystroke away.
                    // The cache is NOT touched: nothing was written.
                    const message = messageOf(error);

                    note(message, true);
                    setStatus('error', `plugin settings: ${message}`);
                } finally {
                    saving = false;
                }
            })();
        });

        for (const { input } of fields) {
            // `input` (not `change`) so a stale outcome line clears while the reader is
            // still typing, not only when the field loses focus.
            input.addEventListener('input', () => note('', false));
        }
    }

    let handle: DialogHandle | undefined;

    handle = openDialog({
        // The plugin's own display title, so the layer is named the way the row is.
        title: plugin.title,
        content: body,
        // Escape/close lands the reader back on the row they activated.
        ...(trigger === undefined ? {} : { returnFocus: trigger }),
        onClose: () => {
            // Identity check: a replacement dialog may own the variable already.
            if (pluginDialog !== handle) return;

            pluginDialog = undefined;
            currentPlugin = undefined;
            for (const button of pluginTabButtons.values()) button.setAttribute('aria-pressed', 'false');

            // The catalogue is still on screen: describe the list again. When the dialog
            // was closed by LEAVING the view, that view has its own restore path
            // (`setPluginsView`/`selectHarness`) and must not be painted over here.
            if (showingPlugins) paintPluginsHead();
            else if (current !== undefined) renderHarnessChrome();
        }
    });

    // The settings form is a working surface (identity + hooks + editable values), so it
    // uses the wide dialog variant — the same class the tool runner adds (ui/dialog.css).
    handle.element.classList.add('dialog-wide');
    pluginDialog = handle;
};

// Activate one catalogue row: the plugins view is ensured behind the dialog (the same
// "one listing" rule `selectTool` follows), the head names that plugin, and the detail
// opens in the shared modal.
const selectPlugin = (plugin: PluginSummary, trigger?: HTMLElement): void => {
    // R1: no `running` gate — same rule as `selectTool`. The plugin catalogue is
    // server-wide data, and the stream painters all early-return while `showingPlugins`
    // owns the centre column. The `stopPolling()` this opened with is gone for the same
    // reason `selectTool`'s went: a run that starts while the catalogue is on screen has
    // to keep being followed, and the pane's own paint path is the one that reports it.
    closePluginDialog();

    currentPlugin = plugin.name;
    showingPlugins = true;
    paintPluginsToggle();
    // T7: opening Plugins leaves Tools, through Tools' own close path (it releases the
    // playground session and resets the runner state), so exactly one catalogue is ever
    // marked pressed.
    if (showingTools) setToolsView(false);

    for (const [name, button] of pluginTabButtons) {
        button.setAttribute('aria-pressed', name === plugin.name ? 'true' : 'false');
    }

    // The harness stays selected: the sessions rail is still scoped to it, and clicking a
    // harness row returns to that chat.
    for (const [name, button] of harnessButtons) {
        button.setAttribute('aria-pressed', name === selectedName ? 'true' : 'false');
    }

    paintPluginHead(plugin);
    agentSlot.hidden = true;
    composer.hidden = true;
    closeAgentDialog();
    stage.replaceChildren(pluginsPane);
    delete stage.dataset.preset;
    // The list is NOT rebuilt here: the trigger button stays the node the dialog hands
    // focus back to, and the pressed state is set by the pass above.
    openPluginDialog(plugin, trigger);
    setStatus('idle');
};

// Open or close the PLUGINS view. One function both directions, exactly like
// `setToolsView`: the title-row Plugins toggle calls it, harness selection and the Tools
// toggle close it, and the view is NEVER locked by a run (R1) — the catalogue is server-wide
// data, the write-anytime contract on `PATCH /plugins/{id}` has no idle window, and
// every transcript painter already early-returns while a catalogue owns the column.
//
// The dialogs that belong to the view being entered are dismissed first (agent +
// harness details, as Tools does), because their titles describe the chat head that is
// being replaced.
const setPluginsView = (open: boolean): void => {
    if (showingPlugins === open) return;

    if (open) {
        closeAgentDialog();
        closeHarnessDialog();
        // Exclusivity: leaving the tools playground is a FULL close (its temporary
        // session is released by `setToolsView(false)`), then Plugins takes the column.
        if (showingTools) setToolsView(false);

        showingPlugins = true;
        paintPluginsToggle();
        agentSlot.hidden = true;
        composer.hidden = true;
        paintPluginsHead();
        stage.replaceChildren(pluginsPane);
        delete stage.dataset.preset;
        setStatus('idle');

        // R2: the read is paid for on the FIRST open, never at boot — the bootstrap
        // document already carries the catalogues the chat needs, and a plugin page is
        // only useful to a reader who asked for it. `loadPlugins` no-ops on a cached page.
        void loadPlugins();

        // Focus handoff, same rule as `setToolsView`: opening closes the details dialog,
        // which returns focus to the title button that the new head re-titles, so the
        // press hands focus to the toggle that performed the switch rather than dropping
        // the reader on `<body>`.
        const active = document.activeElement;

        if (active === null || active === document.body || active === headTitleButton) {
            pluginsToggle.focus({ preventScroll: true });
        }

        return;
    }

    // The plugin dialog goes first: its `onClose` still sees the Plugins view and only
    // resets the row pressed state/head.
    closePluginDialog();
    showingPlugins = false;
    paintPluginsToggle();
    for (const button of pluginTabButtons.values()) button.setAttribute('aria-pressed', 'false');

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
};

// The session-line icon is a real toggle: a second press closes the pane and returns to the
// selected chat. `paintControls` disables it while a run is pending or before boot, so
// this handler never races the queue or blanks the startup pane.
pluginsToggle.addEventListener('click', () => {
    setPluginsView(!showingPlugins);
});

// ---------------------------------------------------------------------------
// Session directory (server-owned, filtered by harness)
// ---------------------------------------------------------------------------

const upsertSession = (session: SessionRecord): void => {
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
const archivedHarnessOf = (session: SessionRecord): string | undefined => {
    const canonical = canonicalHarnessName(session.harness, presetDescriptors);

    return descriptorFor(canonical) === undefined ? canonical : undefined;
};

// Sessions whose harness no longer exists, newest last (the directory order). They are
// listed in their own group in the sessions rail, because the rail is otherwise scoped to
// the SELECTED harness and the deleted harness has no row to be selected any more.
const archivedSessions = (): SessionRecord[] =>
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
//
// T24: the projection is parameterised by harness, because ENTERING a harness has to
// answer "which conversation is this harness's newest?" for a harness that is not the
// selected one yet (the reader just clicked its row). Same rows, same exclusions — the
// rail and the pick can therefore never disagree about what belongs to a harness.
const sessionsOfHarness = (name: string | undefined): SessionRecord[] => {
    if (name === undefined) return [];

    return sessions.filter(
        (session) =>
            !deletedSessions.has(session.id) &&
            // R7: the playground's temporary session is not a conversation. The cache
            // filter above is authoritative; this is the last line of defence so a
            // temporary context can never show up as a row the reader might open.
            !playgroundSessions.has(session.id) &&
            (canonicalHarnessName(session.harness, presetDescriptors) === name ||
                archivedHarnessOf(session) === name)
    );
};

const visibleSessions = (): SessionRecord[] => sessionsOfHarness(selectedName);

// T7: THE one session directory projection, shared by every surface that lists the
// reader's conversations. `renderSessions()` paints it as pills and the header cycler
// (`paintSessionCycle`) walks it to answer "which session is next?", so the dashboard and
// the pill can never disagree about membership or order.
//
// Selected harness first. Then (R6) the conversations of a harness the reader deleted:
// the server never cascades, and with no rail group to hold them any more they stay
// listed, flagged `archived`, exactly as reachable as before. A session already in the
// first list is skipped, so an archived harness that is CURRENTLY selected is never
// listed twice.
type SessionDirectoryEntry = { session: SessionRecord; archived: boolean };

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
// Initial selection (T21 R21 + T24)
// ---------------------------------------------------------------------------
//
// The app chooses a conversation on the reader's behalf when a harness is FIRST entered:
// on boot (the harness it lands on) and on every later rail entry into a harness that has
// nothing selected yet (T24). Both go through the same ranking below and the same
// `openSession`, and nothing in it runs on a directory poll, a refresh or a frame — an
// ongoing selection is never moved underneath the reader (the "don't churn" rule).

// The recency figure a directory row is ranked by, from the server's own stamps.
// `updatedAt` is authoritative (the session store bumps it on every turn, and the
// display wire carries it on every row), so "latest session" means "most recently
// used". `createdAt` is the fallback for a conversation that has never run a task or
// for a server that sends no update stamp; a record with NEITHER sorts first (0),
// which keeps an un-stamped legacy row behind every stamped one instead of inventing
// a date for it.
const recencyOf = (session: SessionRecord): number => {
    const updated = session.updatedAt;
    if (typeof updated === 'number' && Number.isFinite(updated)) return updated;

    const created = session.createdAt;
    if (typeof created === 'number' && Number.isFinite(created)) return created;

    return 0;
};

// The most recently used row of one directory list. Deterministic for a given server
// answer: `recencyOf` decides first, and an exact tie falls to the DIRECTORY order,
// which is the server's insertion order (oldest first — see `archivedSessions`), so
// "later row" is the newer conversation. The strict `>=` walk therefore keeps the
// newest tie rather than whichever row the list happened to put first, and a list
// whose order is shuffled but whose stamps differ still yields the same row.
const latestSession = (list: readonly SessionRecord[]): SessionRecord | undefined => {
    let newest: SessionRecord | undefined;
    let newestAt = 0;

    for (const session of list) {
        const at = recencyOf(session);
        if (at >= newestAt) {
            newest = session;
            newestAt = at;
        }
    }

    return newest;
};

// The conversation to open on a first load: the latest one belonging to the harness
// on screen. `visibleSessions()` is the right scope (the selected harness only, with
// deleted and playground rows filtered out) and deliberately EXCLUDES the archived
// group — an archived harness's conversation must not steal the first load of the
// harness the reader actually opened. Called only after `selectHarness`, which is what
// sets `selectedName`; with no harness selected it is empty, exactly like the rail.
const initialSession = (): SessionRecord | undefined => latestSession(visibleSessions());

// ---------------------------------------------------------------------------
// Entering a harness (T24)
// ---------------------------------------------------------------------------
//
// The user rule ("when first loaded a harness, it should select the latest session")
// applies to EVERY first entry into a harness, not only to the app's boot: clicking a
// rail row that has never been opened in this visit resolves to that harness's most
// recently used conversation, through the same `latestSession` authority and the same
// `openSession` path (so T21 R22's collapse-on-load still renders nothing expanded).

// A harness resolves its own conversation exactly ONCE per page visit. After that the
// reader is in charge: a directory poll, a refresh, or another trip through the rail
// never replaces the conversation they chose. The mark is set when an open ACTUALLY binds
// a conversation (see `openLatestOfEnteredHarness`), and `+ New session` sets it too: an
// empty composer is a choice, not something to take back on the next entry.
const enteredHarnesses = new Set<string>();

// Is the automatic open of `name`'s newest conversation still wanted? Every fact is read
// AFTER the record arrives, because each can change while the request is in flight:
//   - `selectedName !== name` — the reader entered another harness (rapid rail switching:
//     the slow answer from the harness they LEFT must not yank the screen back);
//   - `sessionId !== undefined` — a conversation is bound already, either the reader's own
//     open that won the race or a submit whose answer just created one;
//   - `enteredHarnesses.has(name)` — the reader resolved this harness themselves mid-flight
//     (`+ New session`) or an earlier automatic open already landed.
const entryIsStale = (name: string): boolean =>
    enteredHarnesses.has(name) ||
    selectedName !== name ||
    instances.get(name)?.sessionId !== undefined;

// One automatic open per harness in flight. Without it, entering A, leaving, and coming
// back before the first read lands would queue a second GET of the same record (the first
// one still wins the bind, and the second drops itself as stale — correct, but wasteful).
const entryInFlight = new Set<string>();

// Enter a harness: open its latest conversation when the harness is not already showing
// one. `selectHarness` is the ONE entry point (rail row, the reselect after a harness
// delete, the app's first load), so this rule lives in exactly one place.
const openLatestOfEnteredHarness = (name: string): void => {
    // Already resolved in this visit — the reader's own selection stands.
    if (enteredHarnesses.has(name) || entryInFlight.has(name)) return;

    const instance = instances.get(name);
    if (instance === undefined) return;
    // A conversation is bound to this harness already (the selection survives switching),
    // so there is nothing to pick.
    if (instance.sessionId !== undefined) return;
    // A submit may be creating the very conversation this harness should show; picking one
    // now would race its answer. The harness stays UNMARKED, so the next entry resolves.
    if (submitting || creatingSessions > 0) return;

    const latest = latestSession(sessionsOfHarness(name));
    if (latest === undefined) {
        // No conversation to open (a fresh harness, or rows that have not arrived yet).
        // Deliberately unmarked: a conversation that appears later is still picked up the
        // next time the harness is entered.
        return;
    }

    entryInFlight.add(name);

    // `openSession` swallows its own read failures, so the continuation only has to
    // un-in-flight the harness and record what actually bound.
    void openSession(latest.id, { stale: () => entryIsStale(name), automatic: true }).then(
        () => {
            entryInFlight.delete(name);
            // Mark only once a conversation is REALLY bound. A dropped (stale) or failed
            // open leaves the harness eligible, so re-entering it — the reader's next
            // deliberate gesture — gets another chance to resolve instead of staying
            // silently empty.
            const opened = instances.get(name);
            if (opened !== undefined && opened.sessionId !== undefined) {
                enteredHarnesses.add(name);
            }
        },
        // `openSession` swallows its own read errors, so this is defensive: a rejection
        // must never leave the harness permanently in flight.
        () => {
            entryInFlight.delete(name);
        }
    );
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
        // The watermark, the compiled document and the raw JSON authority all belonged
        // to the deleted conversation; the view store's addressed tree did too.
        releaseSessionState(instance);
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
        await deleteView(id);
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
// One pill per conversation, REUSED across paints (R4b). `renderSessions()` is the single
// directory painter and it runs from EVERY mutation path AND from `applyView`/`upsertSession`
// — i.e. once per poll tick while a run is live. It used to `replaceChildren` the whole
// strip, so every pill was destroyed and rebuilt on every paint: the entry animation
// restarted, the hover state died mid-click, and a list the reader was already looking at
// re-appeared as fresh content. The node is now created once per session id and updated in
// place; only added/removed/moved conversations touch the DOM.
//
// R1: only the first eight characters are VISIBLE. The full uuid, the harness and the
// status live in the `title` tooltip, so a dozen conversations still fit one wrapped row
// under the title.
const createSessionPill = (session: SessionRecord, archived: boolean): HTMLElement => {
    const pill = el('span', 'session-pill');
    pill.setAttribute('role', 'listitem');
    pill.dataset.sessionId = session.id;

    const select = el('button', 'session-pill-select');
    select.type = 'button';
    select.dataset.sessionId = session.id;
    // The visible text is a truncated id, so the accessible name spells the action out
    // instead of announcing eight hex characters. The id never changes for a reused pill,
    // so this is a create-time fact, not a per-paint one.
    select.setAttribute('aria-label', `Open session ${shortId(session.id)}`);
    select.append(el('span', 'session-pill-id', shortId(session.id)));
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
    remove.addEventListener('click', () => void deleteSessionRow(session.id));

    pill.append(select, remove);

    // Every state attribute (and both busy locks) is painted by ONE function, so a created
    // pill and a reused one can never disagree.
    paintSessionPill(pill, session, undefined, archived);

    return pill;
};

// The in-place update of a reused pill. Written under the SAME conditions the old wholesale
// painter used, plus the removals that a rebuild got for free by starting from nothing:
// `data-active`/`aria-current` are DELETED when this conversation is no longer the one on
// screen, or the strip would show two selected pills after a selection change.
const paintSessionPill = (
    pill: HTMLElement,
    session: SessionRecord,
    activeId: string | undefined,
    archived: boolean
): void => {
    const select = pill.querySelector<HTMLButtonElement>('.session-pill-select');
    const remove = pill.querySelector<HTMLButtonElement>('.session-pill-delete');
    const active = session.id === activeId;

    pill.dataset.status = session.status;
    // R6: an archived pill is the conversation of a harness the registry no longer has.
    // The flag is styling only (muted/dashed) — opening and deleting are the same paths.
    pill.dataset.archived = archived ? 'true' : 'false';

    if (active) pill.dataset.active = 'true';
    else delete pill.dataset.active;

    if (select !== null) {
        select.dataset.status = session.status;

        if (active) {
            select.dataset.active = 'true';
            // `aria-current` is ARIA for "this is the current item of a set"; it is written
            // under the SAME condition as `data-active`, from the SAME painter, so what a
            // reader sees and what a screen reader hears can never disagree.
            select.setAttribute('aria-current', 'true');
        } else {
            delete select.dataset.active;
            select.removeAttribute('aria-current');
        }

        // Opening a conversation is a VIEW change, never a cancellation, so the only lock this
        // control carries is `submitting` — the short POST /tasks enqueue window, during which
        // the answer's session pointer could still race the switch. A RUN does not lock it: the
        // queue is server-owned, leaving a conversation only unsubscribes its observer (R4, and
        // the rule the harness rail buttons at `paintControls` already follow), so a conversation
        // whose own queue is moving can always be switched away from AND into.
        // `paintControls` re-applies the same expression on every later repaint; painting it here
        // as well is what keeps a pill that was just created (or reused after a directory change)
        // honest without a second pass over the strip.
        select.disabled = submitting;
        select.title = `${session.harness} · ${session.status} · ${session.id}`;
    }

    if (remove !== null) {
        // R8: deletion is a write, so it is disabled for the same conflicting windows that
        // lock submits/saves, and for a pill whose own DELETE is in flight.
        remove.disabled = deletionBlocked() || removingSessions.has(session.id);
    }
};

// The reused nodes of one strip, keyed by session id. A WeakMap on the list element keeps
// this entirely local to the painter: `SessionPillBar` (the exported bar record) is unchanged.
const pillNodes = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

const pillNodesFor = (list: HTMLElement): Map<string, HTMLElement> => {
    const held = pillNodes.get(list);

    if (held !== undefined) return held;

    const created = new Map<string, HTMLElement>();
    pillNodes.set(list, created);

    return created;
};

// T7/T9: paint the session cycling pill next to the Instruct title (the node and the click
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
// The guard is the strip's own "can I switch" rule (`submitting` only, see
// `paintSessionPill`), because pressing this pill calls the very same `openSession`. A run
// never locks it: leaving a conversation whose queue is moving only unsubscribes the observer.
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

    // The record behind the pointer. Normally the directory entry itself; the applied
    // COMPILED document is the fallback for a conversation opened from a record the
    // list read has not returned yet, so the tooltip still describes what is on
    // screen. The raw export document (present only after an explicit transcript read)
    // is the last resort.
    const record =
        sessions.find((session) => session.id === activeId) ??
        (instance.compiled as SessionRecord | undefined) ??
        (instance.snapshot as SessionRecord | undefined);
    const harness = record?.harness ?? (instance.frozen ?? instance.descriptor).title;
    const status = record?.status ?? 'unknown';
    const short = shortId(activeId);
    // Same guard as a strip pill: only the submit's enqueue window locks a switch. A run in
    // THIS conversation never does — leaving it unsubscribes the observer while the server keeps
    // the queue moving, and coming back re-opens it (`openSession` → `startWatching`).
    const blocked = submitting;

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
    // status, the FULL uuid, and the action (or the reason the action is locked). A RUNNING
    // conversation is not a reason: it says `click to switch`, because pressing this pill only
    // moves the reader — the queue keeps running server-side.
    sessionCycle.title =
        `${harness} · ${status} · ${activeId} · ` +
        (blocked ? 'wait for the submit to finish before switching' : 'click to switch');
};

// The single painter for the directory. `renderSessions()` is still the only entry point
// (every mutation path already calls it), and it repaints the header cycler plus EVERY live
// strip (the one inside an open Instruct dialog) from one projection, so no surface can
// disagree about what conversations exist or which one is on screen.
const renderSessions = (): void => {
    // T7/T9: the cycling pill beside the title is not a strip, so it is painted BEFORE the
    // early return below — with no live bar at all (the dialog is closed, which is the
    // normal state now) it still has to name the conversation on screen.
    paintSessionCycle();

    // The dialog's aggregate figures ride the SAME projection as the pills, so they are
    // repainted here: a streamed usage tally lands in `sessions` through
    // `applySnapshot`/`upsertSession`, which both route through this painter. Kept
    // narrowly scoped on purpose — only the spans inside `.harness-details-stats` are
    // replaced, so an open dialog keeps its scroll position, its focus trap and its
    // pill strip (a full body rebuild on every frame would flicker the whole body and
    // reset the reader).
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
    // T7: extracted into `sessionDirectory()` so the header cycler walks exactly this list.
    const entries = sessionDirectory();

    for (const bar of bars) {
        // R4b: the reused nodes of THIS strip, keyed by session id.
        const pills = pillNodesFor(bar.list);

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
            // The nodes this strip owned are detached; the map must not hand a dead node
            // back to the next paint that names the same conversation.
            pills.clear();
            continue;
        }

        bar.list.setAttribute('role', 'list');

        // 1. retire the pills of conversations that are gone, and the empty-state hint a
        //    previously-empty strip left behind.
        for (const [id, pill] of [...pills]) {
            if (entries.some((entry) => entry.session.id === id)) continue;

            pill.remove();
            pills.delete(id);
        }

        bar.list.querySelector(':scope > .session-pills-empty')?.remove();

        // 2. update or create one pill per entry, then move it only when it is not already
        //    the child at this position. A directory that only changed STATUS — the common
        //    poll tick — therefore costs zero DOM moves.
        let position = 0;

        for (const entry of entries) {
            const existing = pills.get(entry.session.id);
            const pill = existing ?? createSessionPill(entry.session, entry.archived);

            pills.set(entry.session.id, pill);
            paintSessionPill(pill, entry.session, activeId, entry.archived);

            const at = bar.list.children[position] ?? null;

            if (at !== pill) bar.list.insertBefore(pill, at);
            position += 1;
        }
    }
};

// One painter for the create-session control the page owns: the compact `+` in the header
// row. R3 took the dashboard's copy away (a conversation is not created from inside the
// details dialog), so there is one control again and this painter's busy contract is now
// only the windows that can actually race the create: a submit in its enqueue window
// (`submitting`) and an un-booted catalogue.
//
// A RUN is deliberately NOT part of the contract. `newSession()` tears down no queue: it
// forgets the local pointer, unsubscribes the observer, and the previous conversation keeps
// running server-side (R4) — which is exactly why the reader can start a fresh conversation
// while one is already working. Sessions are independent; only the shared client state below
// is reset, and it belongs to the conversation being left.
//
// R6: a NEW session needs a harness the registry still has. An archived conversation
// (its harness deleted) is readable and can keep queuing tasks into its own record, but
// `POST /sessions` for a missing harness would only produce a server error, so the action
// is withheld rather than offered and failed.
const paintSessionActions = (): void => {
    const archivedSelection =
        selectedName !== undefined && descriptorFor(selectedName) === undefined;

    sessionNew.disabled = submitting || !booted || archivedSelection;
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
//
// T9: this is still the automatic re-read every path relies on (boot, a stale
// remembered id, the observer's fallback poll); only the manual Refresh BUTTON is
// gone, never the behaviour behind it.
const refreshSessions = async (): Promise<void> => {
    try {
        // T5 R1: the directory is the COMPACT index — one row per conversation and no
        // display trees at all (`SessionViewSummary`), which is the payload the raw
        // `GET /sessions` list used to carry for every session.
        const listed = await listViews();
        // R7: a temporary playground session that exists right now is filtered out of
        // the directory too, so the sessions strip never grows a conversation the reader
        // did not start (the id returns after cleanup, on the next refresh).
        sessions = listed.filter(
            (session) => !deletedSessions.has(session.id) && !playgroundSessions.has(session.id)
        );
        renderSessions();
    } catch (error) {
        setStatus('error', `session list: ${messageOf(error)}`);
    }
};

// Does this snapshot still hold work? A running session status, an explicit
// `queueDepth` (new server), or any running/queued turn record (authoritative even
// when an older server omits queueDepth). Drives the composer's stop action and the
// topbar pill.
const queueDepthOf = (session: SessionRecord): number => {
    const depth = (session as { queueDepth?: unknown }).queueDepth;
    return typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? depth : 0;
};

const pendingOf = (session: SessionRecord): boolean => {
    if (queueDepthOf(session) > 0) return true;
    if (session.status === 'running') return true;

    // A directory row answers a turn COUNT, not the turns (../shared/harness-api.ts:807-809),
    // so the list is optional: absent means this read never loaded a history, and that is "no
    // live record", not a crash and not a queue. Only an opened conversation has rows.
    return (session.turns ?? []).some((turn) => {
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
const markSnapshot = (instance: Instance, session: SessionRecord): void => {
    const stamp = session.updatedAt;

    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return;

    instance.snapshotMark = { sessionId: session.id, at: stamp };
};

// The server records a DELIBERATE stop as this exact sentence (src/server/sessions.ts:
// `failure = session.cancelled ? 'The run was cancelled.' : messageOf(error)`).
// The turn tile already renders the `cancelled` status, so the sentence is
// suppressed from the pane note: a user's own Stop is not an error to report.
const CANCELLED_MESSAGE = 'The run was cancelled.';

// R1/R2: the ONE rule for the session-scoped failure line. The topbar pill is app-scoped, so
// a run's outcome is reported here — the tile's status word says `error`/`cancelled`, and this
// sentence adds the server's message, which the record's events do not carry. A deliberate stop
// is suppressed: the server stores `The run was cancelled.` as `lastError`, and repeating the
// user's own Stop as an error is the bug this rule exists to prevent.
//
// Both authority paths use it: a whole document (`applyView`) and a `session.updated` metadata
// patch (`applyHeaderPatch`). Before this, a failure that arrived on the stream — the `failed`
// frame's session, or a status a poll reported — left the note empty while the tile already
// read `error`, which is the half-reported failure the status-scope contract refuses.
const sessionFailureOf = (session: { status?: string; lastError?: string }): string | undefined =>
    session.status === 'error'
        ? session.lastError === CANCELLED_MESSAGE
            ? undefined
            : (session.lastError ?? 'session error')
        : undefined;

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

// A row is tombstoned when its turn id was deleted, or when the conversation it ran
// in was. `TurnSummary` (display wire) and `SessionTurn` (raw) both carry `id` and
// `threadId`, so one guard covers both surfaces.
const turnTombstoned = (
    instance: Instance,
    turn: { id: string; threadId?: string }
): boolean =>
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

// Draw one COMPILED view into its harness view (T5 R1 — the default path).
//
// The rows (`view.turns`, a `TurnSummary` per exchange) and the display trees
// (`view.displays`, keyed by turn id) are the whole transcript: no function reached
// from here reads `SessionTurn.events`, so a reload, a poll and a drain frame all
// reconcile the SAME addressed state the server published.
//
// R4: this RECONCILES the list (same id → patch in place) rather than rebuilding it,
// so a reconnect/poll neither duplicates streamed text (a node's content is painted
// FROM the node) nor collapses the reader's expanded turn. It also refreshes what the
// composer needs to know — whether work is pending, which decides stop vs submit
// (R10) — and the activity rings (only a still-running row/section lights an agent).
//
// Record where a document sits in its session's monotonic timeline. EVERY answer that
// carries an authoritative view announces itself here — the stream/poll/202 hydration
// path (applyView) and the model PATCH, which applies its answer directly without a
// reconcile. Without the PATCH's mark a delayed 202 body would look newer than the
// last *streamed* frame and revert the edit it predates.
//
// `updatedAt` is absent from legacy fixtures: then nothing is recorded and the caller
// never treats a document as stale (graceful, no regression).
// ---------------------------------------------------------------------------
// Scratch board from COMPILED state (T5 R1/R2)
// ---------------------------------------------------------------------------

// Recompute one instance's panel map from its compiled display trees, then re-apply
// whatever the reader already expanded.
//
// The compact wire sends `DisplayPanelSummary` cards (identity, slot, title, block
// SHAPES, one preview line) — never a full `ToolUiPanel`. A card that carries an
// expand action is therefore known to be a summary, and the full document only ever
// comes from the step-detail route the reader triggered. `panelDetails` is what keeps
// that expansion across a later document that ships the summary again.
const derivePanels = (instance: Instance): void => {
    const summaries = mediaOfSummaries(panelEntriesOf(instance.compiled), (entry) =>
        openPanelDetail(instance, entry)
    );

    instance.panels = new Map([...summaries, ...instance.panelDetails]);
};

// One click, one request: fetch the step this panel came from and upsert its FULL
// panels over the summary (same scoped key, same sanitizing/bounds as any other
// panel source). A failure is silent-but-recoverable: the summary card stays and its
// action remains clickable, because losing a panel card would be a worse answer than
// telling the reader nothing loaded.
const openPanelDetail = (instance: Instance, entry: PanelSummarySource): void => {
    const sessionId = instance.sessionId;
    if (sessionId === undefined) return;

    const key = panelKeyOf(entry.tool, { id: entry.panel.id });
    if (instance.panelRequests.has(key)) return;

    instance.panelRequests.add(key);

    void getStepDetail(sessionId, entry.turnId, entry.stepId)
        .then((detail) => {
            const payload = stepDetailPayloadOf(detail);

            // `applyPanels` is the documented upsert (an empty `blocks` array removes
            // the key), so a result that no longer carries this panel retracts it and
            // the compact card returns on the next derivation.
            if (payload.panels !== undefined)
                applyPanels(instance.panelDetails, entry.tool, payload.panels);

            derivePanels(instance);
            if (current === instance) paintPanels();
        })
        .catch(() => undefined)
        .finally(() => {
            instance.panelRequests.delete(key);
        });
};

// The live render document (./view-model.ts `SessionView`) in the spelling the
// display plane and the action lookup need. `ViewStateStore` is still typed with the
// legacy protocol document (../server/protocol.ts:681), which does not NAME the two
// windowing fields the composed answer actually carries (`olderCursor`, `actions`).
// Every object in the store comes from ./view-api.ts `openSession`, so this widening
// is nominal only — and without it `loadOlder` could not see the cursor it walks.
const renderDocument = (instance: Instance): RenderSessionView | undefined =>
    instance.store.view() as unknown as RenderSessionView | undefined;

// ---------------------------------------------------------------------------
// The lazy display plane, per instance (T24 items 1-6)
// ---------------------------------------------------------------------------
//
// A session open costs 25 ROWS plus at most 10 display trees (./view-api.ts
// `MAX_VISIBLE_DISPLAYS_PER_OPEN`); every other tree is a user action. The plane
// (./view-shell.ts `createDisplayPlane`) is the one queue that decides which, so a
// scroll, an expansion, an ops frame and an older page all go through the same
// bounded loader (4 in flight, deduped, generation-guarded, failure-not-retried)
// instead of each starting their own fetch-everything.
//
// The plane writes the tree INTO the document it was given (`displays[turnId]`) and
// asks for this repaint; the board then reads the same object it always read, so no
// second copy of a turn's flow exists anywhere in the browser.
const repaintPlane = (instance: Instance): void => {
    const view = instance.compiled;
    if (view === undefined) return;

    // Panels come from the display trees, so a newly adopted tree can contribute a
    // card — the same derivation every other document path runs.
    derivePanels(instance);

    // `reconcileView` patches tiles in place and re-runs `syncDisplay`, which is how
    // a tree that arrived after the row got painted reaches the DOM without touching
    // the reader's expansion or scroll position.
    //
    // T4: the same palette re-derivation as `applyView`, because this is the paint that
    // builds the AGENT SECTIONS of a tree opened lazily (the cold read path never goes
    // through `applyView`). Guarded on the selected instance for the same reason: one
    // page-wide mapping, owned by the conversation on screen.
    if (current === instance) configureAgentColorsFor(agentViewOf(instance));

    instance.view.reconcileView(view, instance.sessionModel);

    if (current === instance) paintPanels();
    instance.view.paintOlder();
};

// A cold display tree states its still-running background calls OUT OF BAND: the
// render model holds that figure only in a `pending:set` op, so a reload of a
// running turn would otherwise lose its "N still running" affordance. The read
// above returns them beside the tree; they land in the store as the ops they are.
const seedColdPending = (
    instance: Instance,
    turnId: string,
    pending: { sectionId: string; pending: HarnessPendingTool[] }[]
): void => {
    if (pending.length === 0) return;

    instance.store.applyOps(
        turnId,
        pending.map((entry) => ({
            op: 'pending:set',
            turnId,
            sectionId: entry.sectionId,
            pending: entry.pending
        }))
    );
};

// The live owner question one card answers (T24 item 5). The compact step publishes
// the question line only, so the choices come from the session's pending actions —
// `PendingAction.request` is the exact recorded request the answer route validates a
// choice against. The id contract is the board's own: `step.callId` (the recorded
// `action_request.callId`) and, for a step that carries none, the step id.
const actionRequestForStep = (instance: Instance, step: DisplayStep): HarnessActionRequest | undefined => {
    // The pending questions ride the render document (./view-model.ts
    // `SessionView.actions`), which the store owns; the legacy protocol spelling does
    // not name that field (see `renderDocument`).
    const actions = renderDocument(instance)?.actions;
    if (actions === undefined || actions.length === 0) return undefined;

    const requestId = step.action?.requestId ?? step.callId ?? step.id;

    return actions.find((action) => action.request.requestId === requestId)?.request;
};

// A settled/historical card's choices: ONE step-detail read for its verbatim
// `action_request` opening event. Called by the board at most once per step, and
// only for a card that has no live request, so history costs nothing until opened.
const loadActionRequestFor = (instance: Instance, step: DisplayStep): Promise<HarnessActionRequest | undefined> => {
    const sessionId = instance.sessionId;
    if (sessionId === undefined) return Promise.resolve(undefined);

    return getStepDetail(sessionId, step.turnId, step.id)
        .then((detail) => stepDetailPayloadOf(detail).request)
        .catch(() => undefined);
};

// The hydrated request is authoritative for that card only, so the repaint is
// tile-scoped: re-syncing the whole document would re-paint every row for one card.
// The tree itself did not change (the choices came from a side read the board cached),
// so this is a re-render of the SAME tree, not a reconcile: `renderDisplay` re-runs
// the compiled paint, which is where the cached request becomes the card's option list.
const repaintActionCard = (instance: Instance, turnId: string): void => {
    const handle = instance.view.turn(turnId);
    const tree = instance.compiled?.displays[turnId];

    if (handle !== undefined && tree !== undefined) {
        handle.renderDisplay(tree);

        return;
    }

    // No adopted tree yet (the row's tree is still in flight on the plane): the
    // document re-apply below paints the card with the cached request the moment the
    // tree lands, so the reader still gets the recorded choices without a second click.
    repaintPlane(instance);
};

// Recovery for a gap on the focused turn's own subscription: one bounded re-read of
// THAT turn's tree (the turn scope's full state), never a history snapshot.
//
// R2: deduped per turn while a read is in flight. A recovery can be asked for the SAME
// turn by three independent paths at once (the drop's tree-cache invalidation, the window
// reconcile that follows it, and the re-registered `turn` subscription's fresh baseline),
// and they used to stack three identical GETs of one tree. Sequential re-reads after a
// real reconnect are still allowed — the guard is scoped to the in-flight window and to
// one session id, so it never suppresses the NEXT re-read, only a concurrent duplicate.
const reloadTurnTree = (instance: Instance, sessionId: string, turnId: string): void => {
    let scoped = instance.treeReads;

    if (scoped === undefined || scoped.sessionId !== sessionId) {
        scoped = { sessionId, ids: new Set<string>() };
        instance.treeReads = scoped;
    }

    if (scoped.ids.has(turnId)) return;
    scoped.ids.add(turnId);

    // Stable binding for the callbacks below (a `let` captured in a closure loses the
    // narrowing above). The id is released on BOTH outcomes so the next genuine re-read
    // still runs; the mark only lives while this one request is open.
    const pending = scoped;
    const release = (): void => {
        if (instance.treeReads === pending) pending.ids.delete(turnId);
    };

    void readTurnDisplay(sessionId, turnId)
        .then((tree) => {
            release();

            const view = instance.compiled;

            // Stale guard: the reader left this conversation while the read ran.
            if (view === undefined || instance.sessionId !== sessionId) return;

            view.displays[turnId] = tree;
            repaintPlane(instance);
        })
        .catch(() => {
            release();
        });
};

// T44: recovery for a turn that settles WITHOUT a flow frame (see the call in
// `applyOpsFrame`), and T51: recovery for a turn that settles while this document holds
// NO tree for it at all. The rule is deliberately narrow:
//   - a turn with no tree is normally UNOPENED (the lazy plane reads it when the reader opens
//     it), but a row that has now SETTLED is a finished answer the reader can already see with
//     nothing painted in it: a 202-adopted row never entered the plane's queue, because the
//     plane pumps the rows of the document that was open when the gesture happened. Claiming it
//     once is the difference between a settled tile with its answer and a settled tile that is
//     permanently blank;
//   - only once per turn id per conversation (the scoped budget below), so a 25-row window
//     that settles cannot turn into 25 reads per frame;
//   - only through `reloadTurnTree`, which is one bounded identified read and a stale guard —
//     the same recovery the turn subscription's own `onResync` uses.
//
// T9 (R7): returns whether THIS call actually started the re-read. The settle path in
// `applyOpsFrame` hands the answer to `scheduleDisplayRefresh` as the exclusion, so the lane
// pass below never re-reads a tree the settling row is already re-reading.
const refreshUnopenedTree = (instance: Instance, turnId: string): boolean => {
    const view = instance.compiled;
    const sessionId = instance.sessionId;

    if (view === undefined || sessionId === undefined) return false;

    const budget = instance.reloadedTrees;

    if (budget === undefined || budget.sessionId !== sessionId) {
        instance.reloadedTrees = { sessionId, ids: new Set<string>([turnId]) };
    } else {
        if (budget.ids.has(turnId)) return false;
        budget.ids.add(turnId);
    }

    reloadTurnTree(instance, sessionId, turnId);

    return true;
};

// ---------------------------------------------------------------------------
// T9 (R7): the live lane dim — the coalesced display re-read
// ---------------------------------------------------------------------------

// WHY A RE-READ IS THE ONLY HOOK THE TRIMMER HAS. The shipped context trimmer
// (../plugins/context-trimmer.plugin.ts) withholds entries at `turn.before` through the
// context-port setter (`../harness.ts` `setIncluded` → `reportCanonicalWrite` → the store's
// `noteStateChange`, src/server/sessions.ts:3307). That write is durable and COMPLETELY
// SILENT on the wire: the state-change observer snapshots and saves without publishing a
// frame, `transcript.updated` is minted only inside `updateThreadTranscript`
// (src/server/sessions.ts:9273), and even then the broker routes that kind to the `thread`
// scope alone (src/server/stream/protocol.ts:73-86 + `isKindPublishedTo`,
// src/server/stream/broker.ts:487). The figure the lane prints (`ContextBlock.included`) is
// stamped per read (src/server/api.ts `contextSegmentIncludedOf`), so with no frame to
// patch it, the only honest repaint is a fresh read of the tree that carries it.
//
// WHICH SIGNALS COUNT. One live fact says "the flags may have moved": a `turn` row SETTLING
// on the session subscription (`applyOpsFrame`). It is the frame that every client of the
// session receives, open tile or no tile, open card or no card, and it arrives exactly when
// the run whose `turn.before` pass wrote the flags has finished — so it is the only signal
// THAT covers the trimmer at all. `transcript.updated` was the other candidate (it is what the
// operator's own Transcript save publishes, and ./view-shell.ts `observeThread` already turns it
// into `onTranscript`), and it was REJECTED as the lane signal for two proven reasons: it reaches
// only subscriptions on THAT thread (protocol.ts:73-86 + `isKindPublishedTo`,
// src/server/stream/broker.ts:487), so a client with no card open for it never sees it, and it
// says nothing at all about a trimmer write. It still arms the pass when it arrives — a host
// transcript write really does move the flags behind the segments — but it cannot be the signal
// the feature is built on.
//
// THE BOUND, stated because a naive listener would refetch per signal. One pass per
// CONTEXT_REFRESH_DELAY_MS window, trailing-edge: a burst of N settling rows costs ONE pass,
// never N. A pass reads at most the rows the board reports as on screen (`visibleTurnIds`, the
// same set `DisplayPlane.ensureVisible` is allowed to ask trees for, T24) AND that already have a
// painted tree, and it goes back through that same plane queue — 4 reads in flight, deduped,
// generation- and stale-guarded — so the ceiling is the number of lanes on screen per coalesced
// window, and the settle path's own immediate re-read of a row it has never opened
// (`refreshUnopenedTree`) is EXCLUDED so no tile is read twice for one signal. A conversation
// that is merely idle, or a session the reader is not looking at, costs nothing at all: no
// signal, no pass, no read.
//
// WHY THE PAINT IS A SNAPSHOT, AND STAYS ONE (R5 review, FIX D — read this before reporting a
// stale lane as a bug). The figure the lane prints is stamped PER READ
// (src/server/api.ts `contextSegmentIncludedOf`), and the only live facts that say "the flags may
// have moved" are a row settling and a thread's transcript frame. So while a run is IN FLIGHT the
// lane shows the verdicts as of the last read: a `turn.before` pass that has already withheld
// entries for the turn now streaming cannot announce itself, and neither can a mid-run Transcript
// save (`../plugins/context-trimmer.plugin.ts` writes through the silent state-change observer,
// and `transcript.updated` reaches only subscriptions on that thread). That is the accepted cost
// of "no new server push" — the sentence the strip prints is true of the last read, not of the
// request the model is composing right now, and a reader who needs the live figure re-reads the
// tree (a reload, or opening the tile, which reads through the plane).
const CONTEXT_REFRESH_DELAY_MS = 150;

// THE WINDOW NEEDS A CEILING, NOT ONLY A LENGTH (FIX D). Re-arming IS the coalescing, and the
// re-arm is unconditional, so a signal stream that never gaps for 150ms never fires the pass —
// a conversation streaming turn after turn, or a host writing transcript rows in a tight loop,
// holds the pending pass open indefinitely and the lane sits un-repainting while signals pile up.
// A burst is bounded by bounding the WAIT rather than the count: past this deadline the next
// signal runs the pass inline instead of postponing it, so the worst case a reader waits for a
// verdict is the deadline, and a sustained burst costs at most ONE pass per deadline window
// (150ms of coalescing followed by one read, every 600ms) — the same pass, the same row ceiling,
// just no longer deferrable. 4x the window is deliberately coarse: ordinary row-to-row gaps stay
// fully coalesced, and only a genuinely continuous stream pays the extra read.
const CONTEXT_REFRESH_MAX_WAIT_MS = 600;

type DisplayRefreshPass = {
    // The conversation this pass belongs to; a pending pass for another one is dropped.
    sessionId: string;
    // The re-armed trailing timer. Re-arming (rather than ignoring) IS the coalescing.
    timer: number;
    // The stamp this window OPENED (its first signal), which is what the deadline above measures
    // from. Deliberately not the timer's own expiry: a re-arm resets the expiry, and the bug this
    // field exists to prevent is exactly a re-arm chain that never ends.
    startedAt: number;
    // Rows whose tree the settle path is ALREADY re-reading immediately, so this pass must not
    // read them a second time for the same signal.
    exceptTurnIds: Set<string>;
};

// Drop one painted tree from the document AND un-mark the loader, so the next `ensureVisible`
// re-reads exactly this row through the plane's own capped queue. Deleting the tree is safe
// while the read is open: a tile whose document momentarily stops carrying its display keeps
// the flow it already painted (./ui/turns.ts `reconcileView` — "a rows-only document must not
// wipe a tile that is already painted"), so the lane never blinks between the two states.
const unloadDisplay = (instance: Instance, view: SessionView, turnId: string): void => {
    if (view.displays !== undefined && typeof view.displays === 'object') delete view.displays[turnId];
    instance.plane?.forget(turnId);
};

// ONE pass: re-read the painted trees of the rows this reader is looking at.
const runDisplayRefresh = (instance: Instance, pass: DisplayRefreshPass): void => {
    // Stale guard: the reader left this conversation (or the document is gone) while the
    // window was open, and a tree for a conversation nobody is showing repaints nothing.
    if (instance.sessionId !== pass.sessionId) return;

    const view = renderDocument(instance);

    if (view === undefined) return;

    // The board's own report of what is on screen — the SAME set `ensureVisible` below is
    // allowed to ask trees for, so this pass can never widen the read surface of a scroll.
    const onScreen = new Set(instance.view.visibleTurnIds());
    const stale: string[] = [];

    for (const row of summariesOf(view)) {
        if (pass.exceptTurnIds.has(row.id) || !onScreen.has(row.id)) continue;

        // WHY EVERY LANE ON SCREEN AND NOT JUST THE RUN'S: the fold the trimmer performs writes
        // `included` into the conversation's SHARED transcript, so every turn of that
        // conversation re-derives its lane from the same withheld entries — that is precisely
        // what R7 reports as "previously submitted tiles dim". The ops delta that carries the
        // settling row does not say which thread the row belongs to, and a pass scoped by a guess
        // would silently skip the lanes the reader is looking at; widening it costs reads, never
        // correctness, and the ceiling below is still one read per painted lane.

        // Nothing painted means nothing to repaint: the row's FIRST read (the plane's, when it
        // scrolls in or opens) is already the current one, so claiming it here would be a
        // second read of a tree the reader has never seen.
        if (view.displays === undefined || typeof view.displays !== 'object' || view.displays[row.id] === undefined)
            continue;

        stale.push(row.id);
    }

    if (stale.length === 0) return;

    for (const turnId of stale) unloadDisplay(instance, view, turnId);

    // The pump is the plane's: newest-first is not needed here (these are already painted),
    // and the answer lands on the same document and repaints through `repaintPlane`, which is
    // how the bar re-derives `data-included` from the fresh `included` stamps.
    instance.plane?.ensureVisible(stale);
};

// Re-arm the trailing edge of the window. The pass object itself is the identity check below:
// a released or superseded pass must not read anything.
const armDisplayRefresh = (instance: Instance, pass: DisplayRefreshPass): void => {
    pass.timer = window.setTimeout(() => {
        // Superseded by a session switch or a newer pass: drop silently.
        if (instance.displayRefresh !== pass) return;

        instance.displayRefresh = undefined;
        runDisplayRefresh(instance, pass);
    }, CONTEXT_REFRESH_DELAY_MS);
};

// Arm (or re-arm) the ONE pending pass for this conversation. Re-arming IS the coalescing: a
// later signal inside the window replaces the timer and only WIDENS the pass — a row the settle
// path is already re-reading stays excluded, and never the other way round.
const scheduleDisplayRefresh = (instance: Instance, scope: { exceptTurnId?: string } = {}): void => {
    const sessionId = instance.sessionId;

    if (sessionId === undefined) return;

    const pending = instance.displayRefresh;

    if (pending !== undefined && pending.sessionId === sessionId) {
        window.clearTimeout(pending.timer);

        if (scope.exceptTurnId !== undefined) pending.exceptTurnIds.add(scope.exceptTurnId);

        // FIX D: the coalescing window has a DEADLINE as well as a length. Past it, this signal
        // RUNS the pass inline rather than re-arming it, because an unbounded re-arm chain is how
        // a continuously streaming conversation could starve the repaint entirely — see
        // `CONTEXT_REFRESH_MAX_WAIT_MS` above. Releasing the slot BEFORE running matters: the pass
        // object is the identity guard `runDisplayRefresh` and the timer callback both compare
        // against, and a signal that arrives inside the read this call starts must open a fresh
        // window rather than re-run the one already in flight.
        if (Date.now() - pending.startedAt >= CONTEXT_REFRESH_MAX_WAIT_MS) {
            instance.displayRefresh = undefined;
            runDisplayRefresh(instance, pending);

            return;
        }

        armDisplayRefresh(instance, pending);

        return;
    }

    const pass: DisplayRefreshPass = {
        sessionId,
        timer: 0,
        startedAt: Date.now(),
        exceptTurnIds: new Set(scope.exceptTurnId === undefined ? [] : [scope.exceptTurnId])
    };

    instance.displayRefresh = pass;
    armDisplayRefresh(instance, pass);
};

// Release a pending pass (a conversation switch, a delete, the page going away). The timer
// is cancelled outright: a read for a conversation the reader left is work nobody sees.
const cancelDisplayRefresh = (instance: Instance): void => {
    const pending = instance.displayRefresh;

    if (pending === undefined) return;

    window.clearTimeout(pending.timer);
    instance.displayRefresh = undefined;
};

// T52: one bounded ROW re-read for the turn a submit receipt names, deduped per conversation
// exactly like the tree claim above. Why the receipt is not enough (decision: the DTO stays
// closed, so no new wire fields):
//   - `steered` (flagged, or recognised below as an ack that folded into a turn this document
//     already holds): the steer TEXT lives on the row (`TurnSummary.steers`), never on the
//     receipt, so an accepted steer painted nothing inside the running conversation;
//   - a `thread_id` the roster does not describe: a thread the server minted in this submit is
//     not in the roster this browser loaded, so the badge has no label to prefer
//     (./ui/turns.ts falls back to `T?`);
//   - the row also carries the attachment facts the compact wire publishes, so one read feeds
//     the chips as well.
// Anything else (a plain new turn in a known conversation, or a `queued` accept that the
// socket is about to move) costs nothing: the stream's own `turn.upsert` is authoritative.
const refreshReceiptRow = (instance: Instance, sessionId: string, turnId: string): void => {
    const budget = instance.reloadedRows;

    if (budget === undefined || budget.sessionId !== sessionId) {
        instance.reloadedRows = { sessionId, ids: new Set<string>([turnId]) };
    } else {
        if (budget.ids.has(turnId)) return;
        budget.ids.add(turnId);
    }

    void readTurnRow(sessionId, turnId)
        .then((row) => {
            const view = instance.compiled;

            // Stale guard: the reader left this conversation while the read ran.
            if (row === undefined || view === undefined || instance.sessionId !== sessionId) return;

            // The record cache first, so Stop/pending and the delete baseline read the same
            // revision the tile is about to show.
            instance.records.set(row.id, row);
            refreshPending(instance);

            // Monotonic merge into the ONE document the board and every ops frame share; a
            // stamped row always replaces the optimistic receipt row (./view-state.ts).
            upsertSummary(view, row);
            instance.store.setView(view);

            // Repaint that tile only, through the same board entry an ops frame uses: the row
            // is the tile's authority, and a whole-document re-apply would erase what the
            // socket already delivered.
            instance.view.upsertSummary(row, view);
            derivePanels(instance);

            if (current === instance) setBusy(instance.pending);
        })
        .catch(() => undefined);
};

// One frame from the FOCUSED TURN's subscription (T24 item 6). `display.ops` is a
// turn-scope kind — the contract's scope table publishes it nowhere else — so these
// frames are how streamed text reaches an opened tile at all. The reducer work is
// the ops branch of `onViewItem`, shared so a turn frame and a session frame patch
// the same document the same way.
const onTurnItem = (instance: Instance, sessionId: string, item: ViewStreamItem): void => {
    if (instance.sessionId !== sessionId) return;
    if (item.type !== 'ops') return;

    applyOpsFrame(instance, item);
};

// Move the flow subscription to the tile the reader is looking at. Exactly one at a
// time, per instance: an unbounded set of turn subscriptions is how a 25-row window
// turns back into 25 connections.
const followTurnFlow = (instance: Instance, turnId: string | undefined): void => {
    const sessionId = instance.sessionId;
    const previous = instance.turnWatch;

    if (previous !== undefined && (previous.turnId !== turnId || previous.sessionId !== sessionId)) {
        previous.controller.abort();
        instance.turnWatch = undefined;
    }

    instance.plane?.setFocusedTurn(turnId);

    if (turnId === undefined || sessionId === undefined) return;
    if (instance.turnWatch !== undefined) return;

    const controller = new AbortController();
    instance.turnWatch = { turnId, sessionId, controller };

    void observeTurn(
        sessionId,
        turnId,
        (item) => onTurnItem(instance, sessionId, item),
        controller.signal,
        { onResync: (id) => void reloadTurnTree(instance, sessionId, id) }
    ).catch(() => {
        // A refused subscription costs this tile its live flow, nothing else: the
        // session subscription still carries the rows, and the plane still loads trees.
        if (instance.turnWatch?.controller === controller) instance.turnWatch = undefined;
    });
};

// Drop the flow subscription (session switch, new conversation, delete, teardown).
// Aborting only unsubscribes: execution is server-owned.
const stopTurnFlow = (instance: Instance): void => {
    if (instance.turnWatch !== undefined) instance.turnWatch.controller.abort();
    instance.turnWatch = undefined;
};

// ---------------------------------------------------------------------------
// T3: following threads (lazy live observation + on-demand transcripts)
// ---------------------------------------------------------------------------

// The transcript queue for the conversation this card points at: rebuilt when the
// instance moves to another session (thread ids and documents are minted inside ONE
// conversation), reused otherwise, so a repaint never re-creates the cache and a switch
// never paints another conversation's document.
const transcriptLoaderFor = (instance: Instance, sessionId: string): ThreadTranscriptLoader => {
    const held = instance.transcripts;

    if (held !== undefined && held.sessionId === sessionId) return held.loader;

    const loader = createThreadTranscriptLoader(sessionId, {
        // Every document this queue reads — awaited or not — lands on the two surfaces
        // that render a conversation's committed messages: the board (its roster rows and
        // the roster-only focus panel) and the raw authority the transcript dialog quotes.
        // Painting from here rather than from each caller is what keeps a re-read that the
        // original waiter had already finished from being thrown away.
        onResolved: (threadId, payload) => {
            if (instance.sessionId !== sessionId) return;

            instance.snapshot = withThreadTranscript(instance.snapshot, threadId, payload);
            instance.view.setThreadTranscript(threadId, payload);
            instance.view.setSessionSnapshot(instance.snapshot);
        }
    });

    instance.transcripts = { sessionId, loader };

    return loader;
};

// Stamps one thread's transcript onto the RAW authority without disturbing the rest of
// the document. The compact wire never carries messages (./ui/threads.ts:89-104), so a
// per-thread read would otherwise be the only row with content and every thread the
// reader opened EARLIER would lose its bytes from the lossless JSON.
const withThreadTranscript = (
    previous: SessionSnapshot | undefined,
    threadId: string | undefined,
    payload: ThreadTranscriptPayload | undefined
): SessionSnapshot | undefined => {
    // No explicit read has happened yet, or the read failed: the raw authority stays as it
    // was (T5 R3 — a transcript/export document exists only after the reader asked for one),
    // and the board renders the conversation from the transcript payload above.
    if (threadId === undefined || payload === undefined) return previous;
    if (previous === undefined || !Array.isArray(previous.threads)) return previous;

    return {
        ...previous,
        threads: previous.threads.map((row) =>
            row.id === threadId
                ? ({ ...row, messages: payload.messages } as unknown as SessionThread)
                : row
        )
    } as SessionSnapshot;
};

// Releases EVERY thread subscription this card holds (a session switch, a delete, a
// teardown). Aborting is an unsubscribe only — execution is server-owned (rule 7 of
// ./stream.ts), so leaving a conversation never cancels a task running inside it.
const stopThreadFollow = (instance: Instance): void => {
    const watches = instance.threadWatches;

    if (watches === undefined) return;

    for (const [, entry] of watches) entry.controller.abort();
    watches.clear();
};

// R2/R3: make this card's live following match exactly what the board is showing.
//
// The board reports the set it can see (./ui/turns.ts `followedThreads`); the shell owns
// the diff, because the shell owns the socket. One entry per conversation: a `thread`
// subscription (the roster row and the transcript signal) plus the transcript document
// itself. Expanding re-dials when the plane is down, so "whenever expanding a thread, the
// socket needs to be re-established" is literally true; collapsing aborts the controller,
// which unsubscribes, and the thread's document is dropped from the cache so the next
// expand reads the CURRENT state again rather than whatever was on screen before.
const syncThreadFollow = (
    instance: Instance,
    reported: readonly string[],
    sessionOfReport?: string
): void => {
    const sessionId = instance.sessionId;

    if (sessionId === undefined) return;

    // T3 (R1): during a LOAD, defer. The board opens its newest surface while the document
    // is reconciled and the shell collapses it immediately after; following the
    // conversation in between would read a transcript for a thread nobody opened. The
    // shell calls back into this function when the flag clears, so nothing is lost — the
    // set is simply applied from the state the reader actually sees.
    if (instance.deferFollow === true) return;

    // A report from another conversation is stale by construction: `bindSession` runs
    // before the rows are replaced, and the previous session's expanded cards are still in
    // the DOM at that moment. Following THOSE ids under the NEW session would subscribe to
    // conversations that do not exist here (and the server refuses them).
    if (sessionOfReport !== undefined && sessionOfReport !== sessionId) return;

    // Only a conversation the ROSTER describes is followable. `focusedThreadId` can name a
    // thread the roster has not published yet (an optimistic row, a legacy turn), and a
    // `thread` subscription for an unknown id is a protocol error, not a wait — the roster
    // frame that finally names it re-syncs this set (see `applyView`/`applyThreadRowPatch`).
    const wanted = new Set(
        reported.filter((threadId) => instance.threads.some((entry) => entry.id === threadId))
    );

    const watches = instance.threadWatches ?? new Map<string, { sessionId: string; controller: AbortController }>();

    instance.threadWatches = watches;

    // R3: collapsing stops the following — unsubscribe, and stop holding its document.
    for (const [threadId, entry] of [...watches]) {
        if (wanted.has(threadId) && entry.sessionId === sessionId) continue;

        entry.controller.abort();
        watches.delete(threadId);
        instance.transcripts?.loader.forget(threadId);
    }

    if (wanted.size === 0) return;

    const stream = harnessStream();

    // The threads this sync actually STARTS watching. Everything else in `wanted` is
    // already carried by a live watch and needs no action at all — a distinction T3b had
    // to make explicit, because this function also runs from `applyThreadRowPatch` on
    // every roster frame and an unconditional force there re-dialled per frame.
    const fresh = [...wanted].filter((id) => watches.get(id)?.sessionId !== sessionId);

    // R2: expanding while the plane is DOWN must re-establish the connection, not wait for
    // the next frame or the next reader gesture — `reconnecting` means a backoff timer is
    // pending, up to 10s of it, and a reader who just clicked to READ a conversation
    // should not watch a stale card for that long. T3b: that force belongs to a NEW watch
    // only, and ./stream.ts `forceReconnectOnce` spends it at most once per outage (the
    // resume state survives either way, so the reconnect still replays). `open` already
    // carries the subscribe and `connecting` already has a dial in flight that flushes the
    // queued registration on its `welcome`, so neither is forced.
    if (fresh.length > 0) {
        const status = stream.status();

        if (status === 'reconnecting' || status === 'idle' || status === 'closed')
            stream.forceReconnectOnce();
    }

    const loader = transcriptLoaderFor(instance, sessionId);

    for (const threadId of fresh) {
        const controller = new AbortController();

        watches.set(threadId, { sessionId, controller });

        void observeThread(sessionId, threadId, controller.signal, {
            // The thread's own roster row moved: patch it (the frame carries the whole
            // row, so this is a patch, never a read).
            onThread: (id, row, stamp) => applyThreadRowPatch(instance, id, row, stamp),
            // `transcript.updated`: the committed document moved. One bounded re-read of
            // THIS thread — that is the whole payload class the session fan-out used to
            // pay for on every open.
            //
            // T9 (R7): the same frame is also a live fact for the lanes — a host transcript write
            // (`PATCH/PUT …/transcript`) moves the inclusion flags of the entries behind them — so
            // it arms the coalesced display pass too. The pass is deliberately NOT scoped to this
            // conversation: scoping would skip any row whose `threadId` the wire never stated, and
            // under-dimming the lanes the reader is looking at is the failure this feature exists
            // to fix, while widening costs reads only (the ceiling is the plane's own).
            onTranscript: (id) => {
                void loader.refresh(id);
                scheduleDisplayRefresh(instance);
            },
            // Lost position (a drop, a gap, a refused cursor, or a re-registered baseline
            // whose replay window expired): the document this surface shows is re-read, so
            // the pane converges without a page refresh (R4).
            onResync: (id) => void loader.refresh(id),
            onError: () => {
                if (watches.get(threadId)?.controller === controller) watches.delete(threadId);
            }
        }).catch(() => {
            // A refused or aborted observation costs this card its live thread flow; the
            // session subscription still carries the roster and the board keeps rendering
            // the document below.
            if (watches.get(threadId)?.controller === controller) watches.delete(threadId);
        });

        // R2: the FRESH per-thread load, every time. `refresh` bypasses the cache on
        // purpose — an expand is the reader asking for the conversation as it is NOW, and a
        // document held from before a collapse (or before an outage) cannot prove that.
        void loader.refresh(threadId);
    }
};

// T3 (R4): the plane lost its position — a dropped connection, a detected gap, a server
// `resync_required`, or a re-registration whose replay window had expired (the quiet one:
// the broker answers a fresh baseline and the client cannot see the loss in any frame).
// The observer's own re-read restores the ROWS; this restores what a document cannot:
//   - the cached display trees: a turn that was mid-flight across the outage settled
//     without a frame, and `createDisplayLoader` marks an answer 'done' for its
//     generation forever, so its stale tree would be painted until the reader switched
//     conversations;
//   - the cached per-thread transcripts, for the same reason;
//   - every followed thread's document, re-read now.
const recoverAfterDrop = (instance: Instance, sessionId: string): void => {
    if (instance.sessionId !== sessionId) return;

    instance.plane?.invalidate();

    const held = instance.transcripts;

    if (held !== undefined && held.sessionId === sessionId) held.loader.invalidate();

    for (const threadId of instance.view.followedThreads()) {
        void transcriptLoaderFor(instance, sessionId).refresh(threadId);
    }
};

// T3: one roster row moves — the reducer BOTH paths share: the session subscription's
// `thread.upsert` (./view-shell.ts `applyUpdate`) and the followed thread's own
// subscription. The frame carries the whole row (../shared/harness-stream.ts:619-627), so
// the compact document's `threadViews` is patched in place and every roster-derived
// surface repaints from it. This replaced a full `openSession` re-read (rows page + roster
// page + actions + a board rebuild) per frame, on the hot path of every running
// conversation.
const applyThreadRowPatch = (
    instance: Instance,
    threadId: string,
    row: ThreadRow,
    // The frame's OWN stamp, carried by `observeView`/`observeThread` (T3b). Absent only
    // from a caller that has no frame to speak of (a hand-built patch in a test).
    stamp?: { at: number; cursor: string }
): void => {
    if (instance.sessionId === undefined) return;

    // S3: a conversation this client deleted never comes back, whatever frame arrives last.
    if (instance.threadTombstones.has(threadId)) return;

    // T3b (R4 of the review): the freshness guard, the row-level twin of `applyView`'s
    // document watermark below. The danger is ordering, not content: a `thread.upsert`
    // replayed out of the stream's retention window can describe a moment EARLIER than
    // the document a mid-outage `pollSession`/`resyncSession` already installed, and the
    // patch would then regress one settled row's `status`/`messageCount`/`preview` while
    // every other row kept the newer state (the frame carries ONE row — the only
    // information about it is the frame itself).
    //
    // The floor is the newest of:
    //   - this row's own applied mark, and
    //   - this document's `snapshotMark.at`, because a document re-read settled EVERY row
    //     at that instant (a thread that has never had a frame of its own still must not
    //     accept an older one);
    // and, like `applyView`, only a STRICTLY older frame is refused — an equal stamp
    // describes the same instant and re-applying it cannot lose anything. A frame with no
    // usable stamp is applied: refusing it would silently drop a live patch, which is the
    // worse failure.
    const document =
        instance.snapshotMark !== undefined && instance.snapshotMark.sessionId === instance.sessionId
            ? instance.snapshotMark.at
            : undefined;
    const applied = instance.threadRowMarks?.get(threadId);
    const floor =
        typeof applied === 'number'
            ? Math.max(applied, document ?? applied)
            : document;

    if (
        stamp !== undefined &&
        floor !== undefined &&
        Number.isFinite(stamp.at) &&
        stamp.at < floor
    )
        return;

    const view = instance.compiled;

    // The shell holds the compiled document under the protocol's nominal `SessionView`
    // (../server/protocol.ts) while a roster row is the display wire's `ThreadRow`
    // (./view-model.ts): the same record in two spellings, and the same nominal cast the
    // delete path already applies (see `reconcileDeletedThread`).
    const rows: ThreadRow[] =
        view === undefined || !Array.isArray(view.threadViews)
            ? []
            : [...(view.threadViews as unknown as ThreadRow[])];

    const index = rows.findIndex((entry) => entry.id === threadId);

    if (index >= 0) rows[index] = row;
    else rows.push(row);

    if (view !== undefined) {
        view.threadViews = rows as unknown as SessionView['threadViews'];
        // An unreadable transcript is a PROPERTY OF THE ROW (./view-api.ts
        // `invalidThreadsOf`), so the invalid roster is re-derived from the patched rows —
        // the same rule `openSession` follows, never a second source of truth.
        view.invalidThreads = invalidThreadsOf(rows) as unknown as SessionView['invalidThreads'];
        instance.store.setView(view);
    }

    const entries = sessionThreadsOf(view ?? ({ threadViews: rows } as unknown as SessionView)).filter(
        (entry) => !instance.threadTombstones.has(entry.id)
    );

    instance.threads = entries;
    instance.view.setThreads(entries);
    if (view !== undefined) instance.view.setSessionView(view);

    // The applied mark moves with an APPLIED patch only — a refused (older) frame leaves
    // the newer mark in place, which is the whole point of the guard above.
    if (stamp !== undefined && Number.isFinite(stamp.at)) {
        const marks = instance.threadRowMarks ?? new Map<string, number>();

        instance.threadRowMarks = marks;

        if ((marks.get(threadId) ?? Number.NEGATIVE_INFINITY) < stamp.at) marks.set(threadId, stamp.at);
    }

    // A row that appears in the roster can make a conversation the reader is ALREADY
    // looking at followable for the first time. The board's report does not change (its
    // set is the same ids), so the re-sync has to be asked for here.
    syncThreadFollow(instance, instance.view.followedThreads());
};

// R2/R4: moves the trees this instance already painted onto a rows-only document before
// that document becomes the instance's authority. Two rules, stated once:
//
//   1. the loader's GENERATION decides whether any tree may survive at all. `invalidate()`
//      (a dropped socket in `recoverAfterDrop`, a released session) is the signal that the
//      cached trees are untrustworthy, so nothing carries and the next reveal() re-reads the
//      rows on screen — the freshness recovery `recoverAfterDrop` documents stays intact;
//   2. a ROW that moved since its tree was painted (a running turn advancing, a settle, a
//      cancel) is a tree that is known to be behind, so it is unloaded from the cache
//      (`plane.forget`) and read again by the plane. That is the poll fallback's display
//      update channel: it used to arrive as a fresh tree inside the polled document.
//
// A steady-state tick — an idle conversation, or a live one whose rows did not move — then
// carries every tree and costs ZERO display reads and ZERO tile rebuilds, which is the flood
// and the flicker this fix removes.
const carryDisplays = (instance: Instance, session: SessionView): void => {
    const plane = instance.plane;
    const previous = instance.compiled;

    // The first document of this card, or a document of ANOTHER conversation: nothing to
    // carry (turn ids are unique per session only), and the stamp is re-based onto the plane
    // this conversation's trees belong to.
    if (previous === undefined || previous.id !== session.id) {
        instance.treeGeneration = plane?.generation();

        return;
    }

    const generation = plane?.generation();
    const stamp = instance.treeGeneration;

    instance.treeGeneration = generation;

    const held = previous.displays;
    const incoming = session.displays;

    if (held === undefined || incoming === undefined) return;

    // A generation bump happened between the two documents: every tree the last document
    // painted is stale by the loader's own rule, so the rows simply become unloaded again.
    if (generation !== undefined && stamp !== undefined && stamp !== generation) {
        for (const row of session.turns) plane?.forget(row.id);

        return;
    }

    const before = new Map<string, TurnSummary>();
    for (const row of previous.turns) before.set(row.id, row);

    for (const row of session.turns) {
        // A document that DOES carry this row's tree (an open that fetched a tail, an ops
        // frame's adopted tree) is the newer authority and wins untouched.
        if (incoming[row.id] !== undefined) continue;
        if (held[row.id] === undefined) continue;

        if (rowMoved(before.get(row.id), row)) {
            plane?.forget(row.id);
            continue;
        }

        incoming[row.id] = held[row.id];
    }
};

// R2/R4 rule 2: has this row's RECORD moved since the tree above it was painted? The
// comparison is the row's OWN published tree-shaped figures (the server folds them from the
// same flow the tree carries): the stamps, the folded state, the section/step counts, the
// live agents and the block previews. Identical figures mean the painted tree is still
// current; anything else means the flow advanced and the tree is behind, so the plane reads
// it again — one bounded read for the row that moved, instead of the old document that
// shipped a fresh tree for EVERY painted turn on EVERY tick.
const treeSignatureOf = (row: TurnSummary): string =>
    [
        row.updatedAt,
        row.status,
        row.state,
        row.sectionCount,
        row.stepCount,
        (row.activeAgents ?? []).join(','),
        row.detail ?? '',
        (row.blocks ?? [])
            .map((block) => `${block.agent}:${block.label}:${block.status}:${block.preview?.length ?? 0}`)
            .join('|')
    ].join('');

const rowMoved = (previous: TurnSummary | undefined, next: TurnSummary): boolean =>
    previous === undefined || treeSignatureOf(previous) !== treeSignatureOf(next);

const applyView = (instance: Instance, session: SessionView): void => {
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
    instance.frozen = frozenTeamOf(session);

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
    const records = new Map<string, TurnSummary>();
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

    // R2/R4 (the display-read flood): a document read is now ROWS ONLY (./view-shell.ts
    // `getView` passes `visibleTurns: 0`), so the trees this instance had already painted
    // are not in the document that replaces it. `carryDisplays` moves them across (with its
    // own generation and row-level rules) BEFORE the document becomes the instance's
    // authority, so the tiles, the tool panels, `stepIndex` and any later ops frame all keep
    // reading the trees that are on screen — and a steady-state poll tick costs zero display
    // reads and zero tile rebuilds.
    carryDisplays(instance, session);

    // R1/R3 authority: the compiled document this instance renders, kept in the
    // per-instance store so an ops frame and this document mutate ONE state object.
    // The RAW record (`instance.snapshot`) is deliberately NOT written here — it
    // exists only after an explicit transcript/export read, which is the one surface
    // that quotes recorded events.
    instance.store.setView(session);
    instance.compiled = session;

    // Pending: a live (running/queued) ROW or the session-level flags of this
    // authoritative document. No stale answer can reach here to leave Stop enabled
    // after the queue drained.
    const liveRecord = [...records.values()].some((turn) => {
        const status = turn.status as string;
        return status === 'running' || status === 'queued';
    });
    instance.pending = liveRecord || queueDepthOf(session) > 0 || session.status === 'running';

    // Activity from a hydrated/polled document: ONLY a still-running turn can make an
    // agent busy. Replaying a settled turn (done/error/cancelled) lights nothing, so
    // opening history never animates old work. A queued task is not working yet, so it
    // lights nothing either. `TurnSummary.activeAgents` is the server's own figure —
    // the replacement for walking every event (ui/activity.ts:129).
    instance.activity.clear();
    if (instance.pending) {
        for (const name of activeAgentsOf(session)) instance.activity.add(name);
    }

    // R21.3 + T5 R1: the tool panels are DERIVED from the compiled display trees on
    // every document — reload, poll, session open, enqueue answer, drain frame. A
    // completed turn's panels are valid scratch state (they describe work that
    // happened), but they never light an agent ring: activity above only reads a
    // RUNNING row. Recomputation also means no cross-session leakage: the board is
    // replaced with exactly what this conversation published. Whatever the reader had
    // expanded (a full panel document) is re-applied by `derivePanels`, so an
    // expansion survives a frame that only carries the bounded summary.
    derivePanels(instance);

    // The compact rows and their display trees ARE the transcript. Tombstone-filtered
    // turns and roster: a late 202 body or an in-flight answer captured before a DELETE
    // can never resurrect the deleted thread or its turns.
    //
    // No `labelSeeds` on this path: the projector sends each block's label, so a
    // deletion cannot renumber a surviving block by construction — the guarantee the
    // raw fold implements with seeds.
    //
    // T4/R2/R3: the shared identity palette is re-derived from THIS view immediately before
    // the board paints. Every tile, agent section and thread label `ui/turns.ts` builds calls
    // `paintAgentColor` with no colour argument, so the explicit colours of this
    // conversation's own definition (its frozen map, plus anything the definition read
    // cached) must already be the module state when the rows are built — otherwise opening a
    // saved session would paint the tones of the conversation the reader just left. Scoped to
    // the SELECTED instance on purpose: the mapping is one page-wide fact, and a background
    // card applying a frame must not recolour the transcript on screen.
    if (instance === current) configureAgentColorsFor(agentViewOf(instance));

    instance.view.reconcileView(session, session.model);

    // Persistent thread roster (R5/R7). Only an authoritative document updates it
    // (the stale guard above returns first).
    instance.threads = incomingThreads;
    instance.view.setThreads(instance.threads);

    // T3: a roster is what makes an id a followable conversation. The reader may already be
    // looking at a thread the previous roster did not name (a submit that minted one, a
    // child the server just joined), and the board's reported set did not change when the
    // roster did — so the follow set is re-derived here, not only from the board.
    syncThreadFollow(instance, instance.view.followedThreads());

    instance.view.setSessionView(session);
    // The transcript dialog repaints from the newest authority the board holds: the
    // raw document after an explicit export read, the compiled rows otherwise.
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

    // Session outcome detail (R1/R2) — the SAME rule the header patch paints below, so a
    // failure that arrives as a `session.updated` frame and one that arrives inside a document
    // cannot describe themselves differently.
    instance.view.setNotice(sessionFailureOf(session));

    if (current !== instance) return;

    paintAgentRings(instance.activity);
    renderHarnessChrome();
    paintPanels();
    runner.sync();
    setBusy(instance.pending);

    // T24 (item 1): the document just became the authority the plane reads rows and
    // trees from, so THIS is where the trees for the rows the reader can see are
    // requested. A session open fetched at most `MAX_VISIBLE_DISPLAYS_PER_OPEN`
    // trees; every other row is one the reader has not scrolled to, and a background
    // card's pane is not on screen at all (it reveals when the harness is selected).
    instance.view.reveal();
};

// R7 explicit-open freshness, on the display wire (T5 R3). The board asks for ONE read
// when the reader opens a transcript; every streamed frame is deliberately ignored for
// this purpose. The answer is the RAW document the dialog quotes — the ONLY place a
// recorded event enters this browser, and it is reached by an explicit user action.
//
// Bounded on purpose: the request names the turn ids the transcript document needs
// (./view-state.ts `transcriptTurnIdsOf` derives them from COMPILED rows and section
// invocations), and the read refreshes the COMPILED document first so the roster, the
// rows and the tiles stay coherent while the raw bytes are being collected. A session
// switch or an already-deleted session makes the read stale: return undefined and let
// the board keep its last applied authority instead of retargeting another conversation.
const refreshTranscriptSnapshot = async (
    sessionId: string,
    threadId?: string
): Promise<SessionSnapshot | undefined> => {
    if (deletedSessions.has(sessionId)) return undefined;

    const instance = [...instances.values()].find(
        (candidate) => candidate.sessionId === sessionId
    );
    if (instance === undefined) return undefined;

    try {
        const view = await getView(sessionId);
        if (deletedSessions.has(sessionId) || instance.sessionId !== sessionId) return undefined;

        // Compiled first: the export's turn selection is derived from what the server
        // says exists NOW, so a turn another tab deleted is not fetched (and a newly
        // added one is not missed).
        applyView(instance, view);

        // T5 R1: the roster comes from the compact view (`threadViews`, no transcripts), which is
        // also what `applyView` installs — the raw `threads` roster is only present on an explicit
        // export read, and `sessionThreadsOf` prefers whichever this document carries.
        const roster = sessionThreadsOf(view);
        const ids = new Set<string>();
        for (const entry of instance.threads) {
            for (const id of transcriptTurnIdsOf(view, entry.id, roster)) ids.add(id);
        }

        // T3b (R1 + the export-fidelity contract): the transcript documents are read HERE,
        // at the explicit export/transcript action, for EVERY roster thread — the lossless
        // JSON document (`ui/thread-transcript.ts`, and `ui/thread-transcript.test.ts` which
        // pins a thread row's committed `messages`) must describe the conversations this
        // page never opened exactly as it did before the lazy-thread work. What stayed
        // lazy is everything that is NOT an explicit export: a load reads no transcript at
        // all (R1), and an expanded card reads only its own conversation (R2).
        const payload = threadId === undefined
            ? undefined
            : await transcriptLoaderFor(instance, sessionId).refresh(threadId);

        const session = await getRawSession(sessionId, [...ids]);
        if (deletedSessions.has(sessionId) || instance.sessionId !== sessionId) return undefined;

        instance.snapshot = session;
        instance.view.setSessionSnapshot(session);

        // The opened conversation also lands on the surfaces that render committed messages
        // from the ROSTER row (the roster-only focus panel), which the compact document
        // never carries.
        if (threadId !== undefined) instance.view.setThreadTranscript(threadId, payload);

        return session;
    } catch {
        // A failed freshness read never invalidates what is already on screen.
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
    session: SessionView
): void => {
    if (instance.sessionId !== sessionId) return;

    tombstoneThread(instance, threadId, instance.threads);
    applyView(instance, session);

    // The answer is authoritative even if `applyView` rejected it as older than a
    // newer streamed frame. Filtering through the tombstones is safe in both cases,
    // and repainting the board closes the deleted surfaces immediately.
    instance.records = new Map(
        [...instance.records].filter(([, turn]) => !turnTombstoned(instance, turn))
    );

    // The compiled authority loses the deleted rows/threads FIRST, so everything derived from it
    // (panels, the reconciled board, the transcript fallback) sees only the survivors. Both roster
    // spellings are filtered: the display wire's compact `threadViews` (protocol.ts:408) and the
    // raw `threads` roster an export read may still carry.
    if (instance.compiled !== undefined) {
        const compactThreads = Array.isArray(instance.compiled.threadViews)
            ? {
                  threadViews: instance.compiled.threadViews.filter(
                      (entry) => !instance.threadTombstones.has(entry.id)
                  )
              }
            : {};
        const rawThreads = Array.isArray(instance.compiled.threads)
            ? {
                  threads: instance.compiled.threads.filter(
                      (entry) => !instance.threadTombstones.has(entry.id)
                  )
              }
            : {};

        instance.compiled = {
            ...instance.compiled,
            turns: summariesOf(instance.compiled).filter((turn) => !turnTombstoned(instance, turn)),
            ...compactThreads,
            ...rawThreads
        };
        instance.store.setView(instance.compiled);
    }

    // Tool panels are derived state, exactly like `applyView`: recompute them from
    // the surviving compiled rows so a deleted thread's panel cards do not survive a
    // stale DELETE answer that the watermark guard rejected.
    derivePanels(instance);
    instance.view.reconcileView(instance.compiled ?? session, instance.sessionModel);
    instance.threads = instance.threads.filter((entry) => !instance.threadTombstones.has(entry.id));
    instance.view.setThreads(instance.threads);

    if (instance.compiled !== undefined) instance.view.setSessionView(instance.compiled);

    // The raw export document (when one was read) loses them the same way.
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

    // Same app-facing effect as the normal document path: the selected view paints
    // the current instance's derived panels (or hides empty hosts).
    if (current === instance) paintPanels();

    // T7b (R6): this is the one roster change that lands AFTER `applyView` already painted (the
    // tombstone filter above runs after it), and `view.threadAgents` is part of the dialog's
    // signature — an open `Agents` panel must stop offering `Remove from team` for a member the
    // conversation no longer runs, and start offering it again when a thread goes away. An
    // unchanged roster is a no-op inside `refreshAgentDialog`.
    if (current === instance) refreshAgentDialog(agentViewOf(instance), instance);
};

// R1: the per-thread Stop the transcript bar offers while a conversation (or one it
// owns) has live work. The mirror of `deleteThreadForSession` WITHOUT the teardown:
//   1. resolve the view that points at this session — an id this page does not hold is a
//      local error, so no request leaves for a conversation nobody is looking at;
//   2. send the POST to the EXISTING cancel route (no new API surface);
//   3. apply the roster document `cancelViewThread` reads back through `applyView`, the
//      one authority path that owns the stale-watermark guard, the tombstones, the
//      roster/rows reconcile, the pending figures (the composer's own Stop) and the board
//      repaint. `setThreads`/`setSessionView` inside it are what re-paint the action bar,
//      so the control flips from Stop back to Delete from the SERVER's answer rather than
//      from an optimistic local flag.
// The thread SURVIVES a stop, so nothing here may tombstone it, and a rejection is thrown
// verbatim: the board reports it and leaves every surface intact.
const stopThreadForSession = async (
    sessionId: string,
    threadId: string
): Promise<{ cancelled: boolean }> => {
    const instance = [...instances.values()].find(
        (candidate) => candidate.sessionId === sessionId
    );
    if (instance === undefined) throw new Error('Unknown session');

    const result = await cancelViewThread(sessionId, threadId);
    applyView(instance, result.view);

    return { cancelled: result.cancelled };
};

// T4/R2: the per-thread RESUME the transcript bar offers while a conversation's roster row
// says `stopped` and its answer has not been reached. The mirror of `stopThreadForSession`
// (and, like it, WITHOUT the delete teardown — the thread survives in both directions):
//   1. resolve the view that points at this session — an id this page does not hold is a
//      local error, so no request leaves for a conversation nobody is looking at;
//   2. POST the empty resume body and get the continuation task's `TaskReceipt` back;
//   3. apply the roster document `resumeViewThread` reads back through `applyView`, the one
//      authority path that owns the stale-watermark guard, the tombstones, the reconcile and
//      the board repaint. `setThreads`/`setSessionView` inside it are what hide the control:
//      visibility comes from the SERVER's status, never from an optimistic local flag.
// The continuation turn is NOT painted from the receipt here — the stream's `turn.upsert`
// frame is the document's update plane and renders it, which is why no `board.begin` is
// needed (and why inventing prompt text client-side would be a lie: the resume's input
// lives server-side). A 404/409 rejection travels verbatim to the board, which reports it
// and leaves every surface intact.
const resumeThreadForSession = async (
    sessionId: string,
    threadId: string
): Promise<TaskReceipt> => {
    const instance = [...instances.values()].find(
        (candidate) => candidate.sessionId === sessionId
    );
    if (instance === undefined) throw new Error('Unknown session');

    const result = await resumeViewThread(sessionId, threadId);
    applyView(instance, result.view);

    return result.receipt;
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
        // T5: the mirrored route answers with a VIEW, so a destructive delete
        // reconciles without one snapshot of every recorded event. `session` keeps the
        // field the board's transport contract names, and it carries the view.
        const result = await deleteViewThread(sessionId, threadId);
        reconcileDeletedThread(instance, sessionId, threadId, result.view);

        return { deleted: true, session: result.view as unknown as SessionSnapshot };
    } catch (error) {
        if (!messageOf(error).includes('Unknown thread')) throw error;

        // Already gone: the caller's intended end state holds. Re-read so the
        // roster/turns/focus reconcile to whatever the server holds now.
        const view = await getView(sessionId);
        reconcileDeletedThread(instance, sessionId, threadId, view);

        return { deleted: true, session: view as unknown as SessionSnapshot };
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
//   3. apply `result.view` through `applyView`, which owns the stale-watermark guard,
//      the deletion tombstones, the roster/row reconcile, the focus clear and the
//      panel repaint. That path also calls `view.setSessionView`, which refreshes the
//      open dialog from the same authority — an invalid transcript is never closed by
//      it (ui/thread-transcript.ts).
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

    const result = await updateViewThreadTranscript(sessionId, threadId, messages);

    // T49: a transcript save answers a WRITE RECEIPT (what was accepted, the new revision, and
    // the validator's verdict when the JSON is broken) — never a session document. The receipt
    // proves the conversation moved, so the newest authority is fetched the ordinary way: one
    // bounded open, applied through `applyView`, which owns the stale-watermark guard, the
    // deletion tombstones, the roster reconcile and the session-outcome note. The dialog's own
    // bytes come from the document read `updateViewThreadTranscript` already performed, so the
    // editor never waits on this round trip.
    void result.receipt;

    try {
        const view = await getView(sessionId);
        if (instance.sessionId === sessionId) applyView(instance, view);
    } catch {
        // A failed freshness read leaves the applied document in place: the save itself landed,
        // and the transcript payload below is what the dialog repaints from.
    }

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

// T49: the receipt a submit answers, merged IN PLACE.
//
// A canonical `TaskReceipt` (../shared/harness-api.ts) states identity, placement, the
// moved session revision and the queue position. It is NOT a document, and the contract
// stopped sending one with a submit, so this is the whole post-write reconciliation:
//   - the accepted row joins `instance.records` (the Stop/pending authority the stream's
//     row ops also write) and the compiled document the board renders, through the SAME
//     monotonic merge `upsertSummary` uses for a `turn.upsert` frame — the optimistic tile
//     and the receipt row are one id, never two;
//   - the session-level figures the receipt names (`status`, `revision`, `queue_position`)
//     patch the held document and the directory row;
//   - nothing else moves. The running row, the tally and the streamed answer arrive on the
//     socket (`turn.upsert`, `session.updated`, `display.ops`).
//
// Re-reading the conversation instead cost a second round trip per task, and applying that
// read through `applyView` — a WHOLE-document apply — erased the rows, the live model map
// and the frozen team the re-read did not carry, which is why an accepted second task
// painted as `error` behind the first.
const applyReceiptRow = (instance: Instance, record: TurnRowView, receipt: TaskReceipt): void => {
    // The queue figure is the row's position; a steer does not open a new slot.
    const live = receipt.status === 'queued' || receipt.status === 'running';

    instance.records.set(record.id, record);
    refreshPending(instance);

    const compiled = instance.compiled;

    if (compiled !== undefined && compiled.id === receipt.session_id) {
        // A session with an accepted task is doing work. `SessionStatus` has no `queued` member
        // (../shared/harness-api.ts:790): the queue figure is `queue_depth`, and the row's own
        // status is what paints `queued` on the tile. A steer opens no slot and leaves both alone.
        if (live) compiled.status = 'running';
        (compiled as { revision?: number }).revision = receipt.session_revision;
        if (typeof receipt.queue_position === 'number') compiled.queueDepth = receipt.queue_position;

        upsertSummary(compiled, record);
        // The store and the document are ONE object (./view-state.ts), so the board and any
        // ops frame now read the row this receipt accepted.
        instance.store.setView(compiled);

        // T52: this receipt just grew the document the board renders, and a row painted from a
        // receipt carries NO display tree (./view-api.ts `rowFromReceipt` states identity, status
        // and placement only). A document apply ends by asking the plane for the trees of the rows
        // on screen (`applyView`, last line); the receipt path skipped that step, so an accepted
        // submit — running or settled — stayed a prompt with no answer in it. The plane is the
        // only caller here: its queue is capped (4 concurrent), deduped and generation-guarded, so
        // this cannot fan out into a read per row.
        if (current === instance) instance.view.reveal();
        // T51: a background card gets nothing from the plane (its pane is not on screen, which is
        // the whole lazy rule), so a row the ack already SETTLED is claimed once through the
        // bounded identified read — it will never settle again on the socket, and a reader who
        // opens this conversation later is served the tree by the plane anyway.
        else if (!live) refreshUnopenedTree(instance, record.id);

        // T52: the receipt is a closed DTO, so it cannot state the two facts above (a steer's
        // text, a brand-new thread's label). Pay ONE bounded row re-read for that turn.
        const ackFoldsIntoAHeldTurn = summariesOf(compiled).some(
            (row) => row.id === record.id && (row as { optimistic?: boolean }).optimistic !== true
        );
        const ackThread = receipt.thread_id;
        const ackThreadUnknown =
            typeof ackThread === 'string' &&
            ackThread.length > 0 &&
            !sessionThreadsOf(compiled).some((entry) => entry.id === ackThread);

        if (receipt.steered === true || ackFoldsIntoAHeldTurn || ackThreadUnknown) {
            refreshReceiptRow(instance, receipt.session_id, record.id);
        }
    }

    // The directory row for this conversation moves with it: the pill's tally and the
    // running/queued figure come from the same receipt, not from a re-read.
    const row = sessions.find((candidate) => candidate.id === receipt.session_id);

    if (row !== undefined) {
        if (live) row.status = 'running';
        if (typeof receipt.queue_position === 'number') row.queueDepth = receipt.queue_position;
    }

    // Stop lights the moment the task is accepted (R4), and the counters repaint.
    if (current === instance) setBusy(instance.pending);
};

// Activity rings come from running state only. A queued task is not working yet, so
// it lights nothing (R4: queued is neutral). On the display wire the figure comes from
// the compiled document — `TurnSummary.activeAgents` plus any section still working —
// so no event is walked (T5 R1/R3, and the replacement for `activityOfTurns`).
const refreshActivity = (instance: Instance): void => {
    instance.activity.clear();

    for (const name of activeAgentsOf(instance.compiled)) instance.activity.add(name);

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
//
// R3: this raises NO navigation intent. Every caller is either a gesture that ALSO records
// its own intent (`selectHarness`, `newSession`, `openSession`) or the observer being
// RE-POINTED at the conversation that just won it (`startWatching`, reached from a submit's
// receipt, a cancel's reconciliation, or a resync) — and a re-point is housekeeping, which
// must never cancel an explicit open the reader is still waiting for.
const stopWatching = (): void => {
    if (watch !== undefined) watch.controller.abort();
    watch = undefined;
};

// The statuses that END a turn, spelled from the ONE contract this frame carries
// (../shared/turn-display.ts `TurnRecordStatus` = `src/shared/harness-api.ts`
// `SessionTurnStatus`, which src/server/protocol.ts stamps on a `turn` row op): done, error,
// cancelled. R5 review, FIX D replaced a `status !== 'running'` test with this enumeration, and
// the difference is not cosmetic — the union also holds `queued`, which is a turn that has NOT
// started, so "not running" and "settled" are different facts. A `turn:new` for a row the server
// queued (a steer accepted into a lane that is still streaming, a batch submit, a lane parked
// behind a running one) used to take this branch, and all three of its effects are wrong for a
// row that has not run: it claimed the trimmer's `turn.before` writes had landed for a pass that
// has not happened yet, it spent the once-per-conversation budget of `refreshUnopenedTree` on a
// tree nobody has watched change, and — the visible one — the settle branch SKIPS
// `applyOpsToActivity`, so the frame's own event deltas were dropped and the agent's activity
// ring lost the opening events of the very turn that queued.
const turnStatusIsSettled = (status: unknown): boolean =>
    status === 'done' || status === 'error' || status === 'cancelled';

// Apply one projected ops frame to this instance's document and DOM (T24).
//
// Split out of `onViewItem` because TWO subscriptions now deliver ops: the session
// scope (a `turn.upsert` row patch) and the focused turn's own scope (the
// `display.ops` flow the session scope does not publish). Both must land on the same
// store, the same record map and the same tile, so there is exactly one reducer here
// and neither path keeps a private copy of the rules.
const applyOpsFrame = (
    instance: Instance,
    item: Extract<ViewStreamItem, { type: 'ops' }>
): void => {
    // S3: a turn removed by a delete this client performed must never come back.
    // The tombstone — not arrival order — decides.
    if (instance.turnTombstones.has(item.turnId)) return;

    // The document as it stood WHEN this frame arrived. The activity reducer resolves
    // an agent by section id against it, because `section:remove` names a section the
    // post-state no longer holds.
    const before = instance.store.view();

    // 1. state first: the store applies every addressed mutation to the one
    //    document this instance renders.
    instance.store.applyItem(item);
    const view = instance.store.view();
    if (view === undefined) return;
    instance.compiled = view;

    // 2. the row upsert that rode inside the frame (`{ op: 'turn' }`) refreshes
    //    the record cache and the derived chrome. A frame that only patches nodes
    //    changes none of that, so this stays cheap.
    const summaryOp = (item.ops ?? []).find((op) => op.op === 'turn');
    if (summaryOp !== undefined && summaryOp.op === 'turn') {
        if (!turnTombstoned(instance, summaryOp.summary))
            instance.records.set(summaryOp.summary.id, summaryOp.summary);

        refreshPending(instance);
    }

    // 3. DOM: route the ops to the tile by explicit turn id. A missing tile means
    //    this frame belongs to a turn this view does not hold (another tab, or the
    //    row has not arrived yet): the closing `view` frame reconciles it, so
    //    guessing here would be a client-side projection.
    let applied = instance.view.applyOps(item.turnId, item.ops ?? [], view);

    // T47: a `turn.upsert` for a row this instance has NEVER held (another tab started a
    // conversation, or the server minted a second thread mid-run). The session scope
    // publishes rows only (../shared/harness-stream.ts scope table), so before this the row
    // landed in the document — `store.applyItem` upserted it — with no tile to route it to,
    // and the transcript kept showing the older window: a follow-up in a NEW conversation
    // was simply invisible until the next re-read.
    //
    // Minting from the FRAME is deliberate. A window re-read here would be a second cost for
    // information the frame already carries, and against a server whose REST answer is
    // captured before the frame (the N2 fixture's late 202/GET) it would delete the row the
    // frame just delivered. The document already holds the row, so the tile is one call:
    // `view.upsertSummary` (./ui/turns.ts `upsertView`) mints the tile AND its conversation
    // shell, which is the same path a submit receipt uses for its optimistic row.
    //
    // Guards: only a ROW op (a flow frame for an unknown turn stays the "not mine" no-op it
    // always was), only a turn still named by the document (a tombstone or a delete that beat
    // this frame must not mint), and only once — `applyOps` already returned true for a tile
    // that exists.
    if (!applied && summaryOp !== undefined && summaryOp.op === 'turn' && !turnTombstoned(instance, summaryOp.summary)) {
        const held = summariesOf(view).some((row) => row.id === item.turnId);

        if (held) {
            applied = true;
            instance.view.upsertSummary(summaryOp.summary, view);
        }
    }

    if (!applied) return;

    // Panels: the compact trees changed, so the scratch board follows — the
    // same derivation the document path uses, never an event scan.
    derivePanels(instance);

    // Activity: the raw stream mutated the live ring set from every event
    // (ui/activity.ts); the display wire mutates the SAME set from the addressed
    // ops this frame names. A frame that ENDS a turn instead recomputes from the
    // document, because the row it just upserted is now the authority for what is
    // still running (and a `view` frame does the same in `applyView`).
    // `rowOp` names the parameter to dodge the `op` callback parameter the `summaryOp` lookup
    // above already binds in this same scope.
    const settlesTurn = (item.ops ?? []).some((rowOp) => rowOp.op === 'turn' && turnStatusIsSettled(rowOp.summary.status));

    // T44: a settling row for a turn this instance is NOT streaming. `display.ops` rides the
    // `turn` scope only (../shared/harness-stream.ts:201) and `followTurnFlow` holds ONE
    // subscription — the expanded tile — so every other visible turn gets row patches without
    // flow: its tree, loaded once at open time, is stale by construction the moment the row
    // settles. One bounded re-read of THAT tree (the turn scope's own full state, never a
    // history snapshot or a window re-read) closes the gap the focused subscriber leaves.
    //
    // T9 (R7): the same settling row is also the only live fact that says a `turn.before`
    // plugin's inclusion writes have landed (see `scheduleDisplayRefresh` above). It arms ONE
    // coalesced pass over the OTHER on-screen tiles — the ones whose lanes the trimmer just
    // withheld — and this row is EXCLUDED from that pass exactly when the immediate re-read
    // below covers it, so no tile is read twice for one frame.
    if (settlesTurn) {
        const settledNow =
            instance.turnWatch?.turnId !== item.turnId && refreshUnopenedTree(instance, item.turnId);

        scheduleDisplayRefresh(instance, settledNow ? { exceptTurnId: item.turnId } : {});
        refreshActivity(instance);
    } else {
        applyOpsToActivity(instance.activity, before, item.turnId, item.ops ?? []);
        if (current === instance) paintAgentRings(instance.activity);
    }

    if (current === instance) {
        paintPanels();
        setBusy(instance.pending);
    }
};

// One frame from the DISPLAY observer (T5 R1/R3). Items for a session/observer this
// view no longer owns are dropped: a late frame must not paint into a conversation the
// reader left.
//
// The frame vocabulary is `view` / `ops` / `failed` (protocol.ts:640). An `ops` frame
// is applied to the store by NODE/STEP ID and routed to the tile that owns the turn —
// no event matching, no routing by name, no compilation. A `view` frame is
// self-sufficient, so it reconciles anything this connection missed; that is the
// recovery contract the raw stream implemented with a terminal `snapshot`, kept
// identical here so a reconnect never duplicates text.
const onViewItem = (
    instance: Instance,
    sessionId: string,
    item: ViewStreamItem,
    controller: AbortController
): void => {
    if (instance.sessionId !== sessionId) return;
    if (watch === undefined || watch.controller !== controller) return;

    if (item.type === 'ops') {
        // T24: the same reducer the focused turn's subscription uses, so a row patch
        // that arrives on the session scope and a flow frame that arrives on the turn
        // scope mutate ONE document in exactly one way.
        applyOpsFrame(instance, item);

        return;
    }

    // T3: one roster row moved. The frame carries the whole row, so this is the patch path
    // — the rows page, the roster page and the pending-action list are NOT re-read to learn
    // what the frame already states.
    if (item.type === 'thread') {
        // T3b: the frame's stamp travels with the row so a replayed older patch is refused
        // (./main.ts `applyThreadRowPatch`).
        applyThreadRowPatch(instance, item.threadId, item.row, { at: item.at, cursor: item.cursor });

        return;
    }

    // `view` (the open frame and every drain frame) and `failed` (the error terminal)
    // both carry a complete document. Applying it reconciles everything the frames may
    // have missed — and `lastError` populates the pane's session note. The pill is NOT
    // touched: a failed run is session-scoped (R1); its detail is in the transcript (R2).
    if (item.type === 'header') {
        applyHeaderPatch(instance, item.view);

        return;
    }

    applyView(instance, item.view);
};

// T44: a session-level patch (`session.updated`, a pending-action list) applied WITHOUT
// reconciling rows. `applyView` is the reconciliation path: it rebuilds `instance.records`
// from `session.turns` and tombstones every id that list no longer names. A metadata read
// carries NO rows (`SessionResource` is counters, ../shared/harness-api.ts:807-809), so
// publishing it as a document deleted every live turn mid-run — the board went empty the
// moment the terminal `session.updated` landed, and the tombstones kept the re-delivered
// rows from coming back. Only the session facts named by the patch move; rows, trees, the
// paging cursor and the snapshot watermark (which is about DOCUMENTS, see `applyView` N2)
// all stay exactly as this instance holds them.
const applyHeaderPatch = (instance: Instance, patch: SessionView): void => {
    // Same routing guards as a document: a deleted session and a late answer for another
    // one are authoritative for nothing.
    if (deletedSessions.has(patch.id) || instance.sessionId !== patch.id) return;

    const view = instance.compiled;
    if (view === undefined || view.id !== patch.id) return;

    // Header facts only, through the one merge rule (./view-state.ts
    // `applySessionPatch`): `turns`, `displays` and `olderCursor` are never written here, so
    // the rows keep flowing from `turn.upsert`, and a document that IS authoritative still
    // arrives as a `view` item.
    applySessionPatch(view, patch);

    // R2: the composer edits the LIVE per-agent map, so the patch is the newest statement
    // of it this client has. The frozen team is definition data a patch never carries.
    instance.sessionModels = agentModelsOf(view);
    instance.sessionModel = typeof view.model === 'string' ? view.model : undefined;

    // Stop/pill and rings come from the patched document, exactly as the document path
    // derives them — no new rules, one authority.
    refreshPending(instance);
    refreshActivity(instance);
    instance.view.setSessionView(view);

    // R1/R2: the patch carries the session's own outcome (`status` + `lastError`), so the
    // session-scoped note repaints from it — the same rule the document path uses, and the
    // reason a streamed failure is never left without its detail line.
    instance.view.setNotice(sessionFailureOf(view));

    if (current === instance) {
        setBusy(instance.pending);
        paintControls();
    }
};

// Re-read the session after an observer ends, then reopen it only if work is
// still pending. A drained queue already delivered its final document.
const resyncSession = async (instance: Instance, sessionId: string): Promise<void> => {
    if (instance.sessionId !== sessionId) return;

    try {
        const view = await getView(sessionId);
        if (instance.sessionId !== sessionId) return;

        applyView(instance, view);

        if (instance.pending && watch === undefined) {
            window.setTimeout(() => {
                if (instance.sessionId === sessionId && instance.pending && watch === undefined) {
                    startWatching(instance, sessionId);
                }
            }, RECONNECT_DELAY_MS);
        }
    } catch {
        // The re-read failed too: fall back to bounded polling, which reports its own
        // trouble. The task is unaffected either way.
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

    void observeView(
        sessionId,
        (item) => onViewItem(instance, sessionId, item, controller),
        controller.signal,
        {
            // T3 (R4): the plane lost its position — a dropped socket (./stream.ts now
            // reports a drop to every subscription instead of re-dialling in silence), a
            // sequence gap, or a re-registered baseline whose replay window had expired.
            // The observer re-reads the rows; this drops the render state a document
            // cannot repair and re-reads what the reader is looking at, so the panes
            // converge on the CURRENT state without a page refresh.
            onRecover: () => recoverAfterDrop(instance, sessionId)
        }
    )
        .then(() => {
            if (watch?.controller !== controller) return;
            watch = undefined;

            // T50: an observation that ended because this host has NO transport at all is the
            // degraded case ./view-shell.ts:485-490 names out loud — "the caller's bounded-poll
            // path is the degraded observation". Going through `resyncSession` first costs one
            // extra read of the very document `applyView` just painted, on every single tick of
            // the reconnect loop, and the board never gains anything from it. `pollSession` is
            // that re-read with the cadence and the bound attached, so the degraded host reads
            // once per `POLL_INTERVAL_MS` and stops when the work settles. Every OTHER way this
            // promise ends (the server ended the subscription, a protocol error, an unsubscribe)
            // keeps the single authoritative re-read, because there the socket may come back and
            // the document in hand may already be stale.
            //
            // T3 (R4): `reconnecting` joins `closed` here. An observation that ENDED while the
            // plane was still trying to come back used to take the `resyncSession` branch, which
            // re-read once and then only restarted the observer if `instance.pending` happened to
            // be true at that instant — so an outage that outlived the run left the card
            // displaying a document nothing was updating any more, with no fallback ticking. The
            // bounded poll re-reads on every tick and stops by itself when the work settles,
            // which is the honest shape of "the socket is not carrying you right now".
            const plane = harnessStream().status();

            if (plane === 'closed' || plane === 'reconnecting') {
                pollSession(instance, sessionId);

                return;
            }

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

// Bounded `GET /views/:id` polling — the fallback when observation fails (or a page
// reloaded mid-run and cannot attach). It never POSTS a task, so it can never start a
// second run, and each poll costs the compact document: no recorded events.
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

        let session: SessionView;
        try {
            session = await getView(id);
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
        // Pending is derived from the document (queue included), not from the old
        // "status === running" test: a session that is only holding queued tasks
        // still needs to be followed.
        applyView(instance, session);

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

// Point an instance at no conversation (or at a brand-new one). Every per-session
// authority is dropped TOGETHER, so a stale document, tombstone-fed record map, panel
// board or store tree can never describe the conversation this card just left. The
// view store resets because its sections and nodes are addressed by ids minted inside
// ONE session (turn-display.ts:50), and `panelDetails` because a full panel the reader
// expanded belongs to a step of the previous conversation.
const releaseSessionState = (instance: Instance): void => {
    instance.snapshot = undefined;
    instance.snapshotMark = undefined;
    instance.compiled = undefined;
    instance.records = new Map<string, TurnSummary>();
    instance.threads = [];
    instance.panelDetails.clear();
    instance.panelRequests.clear();
    instance.panels.clear();
    instance.store.reset();
    instance.view.setSessionSnapshot(undefined);
    instance.view.setSessionView(undefined);

    // T24: the plane and the flow subscription belong to the conversation being
    // released. `invalidate` is the strong one of the two plane calls — it bumps the
    // generation, so a tree still in flight for the conversation the reader left
    // resolves to nothing and is never painted onto the next one — and the flow
    // subscription dies with it, because a `turn` id is minted inside one session.
    instance.plane?.invalidate();
    stopTurnFlow(instance);

    // T3 (R3): the thread subscriptions and the transcript queue belong to the
    // conversation being released. Thread ids are minted per session, so the next
    // conversation may mint the same id — holding a stale document (or a subscription)
    // under it would paint another conversation's transcript.
    stopThreadFollow(instance);
    instance.threadWatches = undefined;
    // T3b: the row marks are keyed by thread id, which is minted per session — the next
    // conversation may reuse an id, and a mark left from the conversation being released
    // would refuse its first live patch.
    instance.threadRowMarks = undefined;
    instance.transcripts = undefined;

    // T9 (R7): a pending lane pass belongs to the conversation being released — its reads
    // are addressed by turn ids minted inside one session, and a tree for a conversation the
    // reader left must not arrive and repaint the new one's rows.
    cancelDisplayRefresh(instance);

    instance.view.paintOlder();
};

// Select and render an existing session. Everything drawn here comes from the
// server's COMPILED document; nothing is reconstructed from browser memory, and no
// recorded event is fetched (T5 R1/R3).
//
// The read is async, so the continuation drops itself on either of two facts:
//   - the NAVIGATION INTENT (R3), checked for EVERY call, explicit or automatic: the reader
//     asked for something else while this read was in flight (another open, `+ New session`,
//     or any observer teardown). See `navigationIntent`;
//   - `stale`, the T24 opt-in guard the AUTOMATIC opens (entering a harness) add on top.
//     `entryIsStale` also sees what no counter can: the reader entered ANOTHER harness, or
//     this harness resolved a conversation of its own mid-flight.
// An explicit open (a pill, the cycler) passes no `stale`, because the intent check alone is
// what makes its click win. `automatic: true` marks the same calls so the switch they perform
// keeps the app status the reader was just told about (see `selectHarness`).
const openSession = async (
    id: string,
    options?: { stale?: () => boolean; automatic?: boolean }
): Promise<void> => {
    const stale = options?.stale;

    stopWatching();
    stopPolling();

    // R3: THIS open is the newest intent. It is claimed after the teardown above (which is
    // pure housekeeping and records nothing) and BEFORE the first await, so every open that is
    // still in flight is now superseded — and nothing that merely re-dials the observer can
    // take the claim away again.
    const intent = navigationIntent + 1;
    navigationIntent = intent;

    // One predicate, re-checked after every await below. The opt-in `stale` stays as the
    // additional automatic-entry condition (T24), never as the only guard.
    const isStale = (): boolean => navigationIntent !== intent || (stale !== undefined && stale());

    let session: SessionView;
    try {
        session = await getView(id);
    } catch (error) {
        // A superseded open is not an event the reader should feel: the view it belonged to
        // is already gone, and the gesture that replaced it owns the header, the pointer and
        // the directory re-read. So: no pointer change, no header error, no refresh.
        if (isStale()) return;
        // A remembered id from a previous server process is not an error state
        // the user must fix: forget it and show what the server does have. A
        // stale id in a *row* (someone else's process) must not clear a valid
        // pointer, so only the remembered id is forgotten.
        if (loadRememberedSession() === id) forgetRememberedSession();
        setStatus('error', messageOf(error));
        void refreshSessions();
        return;
    }

    // T24/R3: an open whose answer arrived after the reader moved on is dropped BEFORE it can
    // select a harness, bind a conversation or repaint anything. This is the guard that keeps
    // a released card from adopting the conversation it just let go.
    if (isStale()) return;

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
        // The ARCHIVED decision is made on the document's own field ONLY, never on the
        // cached definition answer: a record that never captured a team must be refused,
        // and the conversation-level definition read (which the agent dialog triggers for
        // its own purposes) answers with a named record regardless. `frozenTeamOf` is for
        // the chrome paths that must not WIPE a team this page already knows.
        // T46: the document's own frozen team first (a legacy snapshot still carries it, and a
        // conversation opened while the harness existed is cached). Only when NEITHER exists
        // does the shell spend the one identified definition read — the server's own statement
        // of the team this record ran with.
        const frozen = frozenDefinitionOf(session) ?? (await readFrozenDefinition(id));

        if (frozen === undefined) {
            // No frozen definition anywhere (the harness is gone AND the record never captured
            // a team, or the definition read failed): the honest answer is still an error, not
            // an invented descriptor.
            setStatus('error', `unknown harness "${session.harness}"`);
            return;
        }

        // T46/R3: the definition read is a second hop, so the reader may have moved on or
        // deleted the conversation while it was in flight. These are the same two guards the
        // open itself applies above, re-checked before anything is selected or painted.
        if (isStale()) return;
        if (deletedSessions.has(id)) return;

        // Cache it so `applyView` below (which re-derives the team from the document, and
        // finds none on the canonical wire) keeps describing THIS conversation rather than
        // wiping the team it just reopened with.
        frozenDefinitions.set(id, frozen);

        // T46: the header names the harness this conversation BELONGS TO, which is the
        // identity the reader picked from the pill. The frozen copy still supplies everything
        // the conversation RUNS with (team, per-agent models, tools); only its `title` is a
        // historical string the registry no longer owns, and an archived conversation has no
        // card left to take a display label from. The `Deleted harness · …` sentence that
        // `renderHarnessChrome` paints for an unregistered name is what states the loss (R6).
        //
        // The CACHE gets the same object the instance does: `renderHarnessChrome` renders
        // `instance.frozen ?? instance.descriptor`, and `frozenTeamOf` answers from this cache
        // on every later document (`applyView`), so caching the raw definition would let a
        // repaint put the historical title back after the open painted the right one.
        const archived = { ...frozen, title: archivedHarnessLabel(harnessName) };

        frozenDefinitions.set(id, archived);
        descriptor = archived;
    }

    const target = ensureInstance(descriptor);

    // One session, one card: release any other card pointed at this id. The release
    // must invalidate that card's raw transcript authority and close any transcript
    // opened from it; otherwise the stale source can reopen after the session moved.
    for (const instance of instances.values()) {
        if (instance !== target && instance.sessionId === id) {
            instance.sessionId = undefined;
            releaseSessionState(instance);
            instance.view.bindSession(undefined);
            instance.view.setThreads([]);
        }
    }

    // N1: everything the instance holds about the conversation being LEFT is stale
    // once a DIFFERENT session is opened. Thread ids are minted per session, so the
    // previous session's roster/records must not be the baseline for `applyView`
    // deletion learning — otherwise an id the new session will mint later (e.g.
    // `thread-2`) is tombstoned on arrival and the new thread can never appear.
    //
    // Tombstones are session-scoped by construction: they live on the instance and
    // are cleared exactly here (and in `ensureSession`/`newSession`), while
    // `applyView` refuses a document for any other session id.
    if (target.sessionId !== undefined && target.sessionId !== id) {
        target.threadTombstones.clear();
        target.turnTombstones.clear();
        releaseSessionState(target);
    }

    // T21 R22: is this a LOAD of a conversation, as opposed to the same conversation
    // being re-opened while it is already on screen? Captured BEFORE the assignment
    // below, which is what makes the answer impossible to derive afterwards. Clicking
    // the pill of the ACTIVE session is not a load, so an expansion the reader chose
    // there is never reset by the click.
    const loadsFresh = target.sessionId !== id;

    target.sessionId = id;
    // T7b (R6): the per-agent TEXT and COLOUR caches belong to a conversation, not to a harness.
    // `loadHarnessConfiguration` refills them on the next explicit dialog open (a session reads
    // its own live roster, a template reads `GET /harnesses/:name`), but a stale map kept on the
    // card in between is what would seed the first paint with ANOTHER conversation's prompts.
    // Only a genuine LOAD clears them: re-opening the same conversation must not throw away text
    // this browser already holds.
    if (loadsFresh) {
        target.harnessInstructions = undefined;
        target.harnessColors = undefined;
        target.harnessModels = undefined;
    }
    // N3: an answer card from the conversation being left cannot follow the
    // reader here; binding expires it before the new transcript is drawn.
    target.view.bindSession(id);
    target.frozen = frozenTeamOf(session);

    // R6: for an archived harness this passes the frozen definition, because the registry
    // has no entry to look up. The instance key is the record's own harness name, so the
    // conversation is scoped to itself and no harness row appears in the rail.
    selectHarness(descriptor.name, descriptor,
        // T24: an open the reader did not gesture (the harness-entry pick) keeps whatever
        // status line the action before it painted.
        options?.automatic === true ? { keepStatus: true } : undefined
    );

    // T3 (R1): the whole apply/collapse pass below runs with the thread following deferred
    // (see `Instance.deferFollow`).
    target.deferFollow = true;

    // T3b: the release belongs in a `finally`, and the deferred sync travels with it — the
    // flag and the sync are one critical section. A throw anywhere below (a malformed
    // document reaching `applyView`, anything in the hydrate/collapse pass) used to leave
    // `deferFollow` set for the life of this card, and every later board report was then
    // dropped at the top of `syncThreadFollow` in silence: expanding a thread would simply
    // never follow again. Releasing the flag without re-syncing would leave the same hole
    // until the reader's next expand, so both happen together.
    try {
        applyView(target, session);
        // T50: the conversation's OWN team (see `hydrateFrozenTeam`). A registered harness
        // with a document that carries no frozen team would otherwise paint the live
        // preset's roster.
        hydrateFrozenTeam(target);
        // T21 R22: a loaded conversation starts with EVERY thread collapsed. `applyView`
        // just reconciled the document, and the board's first-content rule opened the
        // newest surface while doing so (`reconcileView`'s `!hadTurns` branch, and its
        // `pendingFirstFocus` branch after a session switch — ui/turns.ts). Reading that as
        // an expansion request is wrong — only a click is — so the shell drops it here,
        // before the observer below or any composer paint can see a focus the reader never
        // chose. `collapse` also marks the unfocus deliberate (`explicitUnfocus`), which is
        // what stops every later stream/snapshot/poll frame from re-opening anything.
        if (loadsFresh) target.view.collapseForLoad();
    } finally {
        // T3 (R1/R5): the load is over, so the deferred following is applied — from the set
        // the reader ACTUALLY sees, which after a fresh load is empty (every card
        // collapsed). Nothing per-thread has been fetched or streamed for the conversations
        // still showing their roster row; the roster page above is the collapsed screen's
        // source.
        target.deferFollow = false;
        syncThreadFollow(target, target.view.followedThreads());
    }

    rememberSession(id);

    if (pendingOf(session)) {
        // R4: a reloaded/selected session with a live queue gets the observer, not
        // a one-way poll — queued tasks advance and stream here automatically.
        // No header write: pending work is session state, shown on its tiles.
        startWatching(target, id);
        return;
    }

    // A saved error session's detail is already in the pane note via
    // `applyView`; the topbar pill stays app-scoped (R1).
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

    // NO run guard (R4): a conversation is created by forgetting the local pointer, not by
    // cancelling anything. Whatever the previous conversation has queued keeps running on the
    // server, so starting a new session while it works is the normal way to open a second,
    // independent conversation. The `running` flag itself is released below, with the rest of
    // the state that belonged to the conversation being left.

    // R3: an empty composer is a navigation intent, so it supersedes every conversation read
    // still in flight. This is the guard the run lock used to provide by accident: the card is
    // about to have NO pointer, and `applyView` binds any document that arrives for a
    // pointer-free card, so without this the conversation just released would re-bind this
    // card from its own late answer — transcript, pending figure and the remembered pointer.
    markNavigationIntent();

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
    // T7b (R6): the text/colour/model caches described the conversation being left. Without a
    // session this card edits the harness TEMPLATE again, and those maps are refilled by the
    // next explicit dialog open — so the honest state here is "not read yet".
    instance.harnessInstructions = undefined;
    instance.harnessColors = undefined;
    instance.harnessModels = undefined;
    // A new conversation has no pending work and no server records; the queue
    // belongs to the previous session and keeps running there.
    instance.pending = false;
    // The watermark, the compiled document and the raw authority belonged to the
    // previous conversation; a new session's documents start a fresh clock/source, and
    // the view store's addressed tree starts empty because its ids are per session.
    releaseSessionState(instance);
    // A new conversation has no tool output yet: clearing the instance state and
    // repainting is what drops the previous session's board and any manual panels
    // that lived only in the browser (R21.3).
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
    // T24: `+ New session` is an EXPLICIT choice of an empty conversation, so this
    // harness stops resolving one on entry for the rest of the visit — switching away and
    // back returns the reader to the draft they were writing, not to a saved chat. It also
    // drops an automatic entry-open that is still mid-read (`entryIsStale`).
    enteredHarnesses.add(instance.descriptor.name);
    // Lifecycle: the agent dialog belongs to the conversation being left. Closing it
    // here also releases its focus trap/scroll lock before the chrome repaints.
    closeAgentDialog();
    // R2: the harness details dialog described the SAVED session (frozen team), so it
    // is dismissed when that conversation is replaced by a fresh one.
    closeHarnessDialog();
    // The app-scoped `running` flag is derived from the SELECTED conversation alone, so clearing
    // the pointer has to release it too: with the guard gone from the top of this function a run
    // can be live at this moment, and the empty card must not keep painting the PREVIOUS
    // conversation's STOP action (or hold the harness create button locked) while nothing on
    // screen is working. Placed after the board/roster/pointer resets so the repaint it triggers
    // sees the new conversation's state, not the one being released; this is the same release
    // `forgetDeletedSession` performs for a deleted conversation.
    setBusy(false);
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
//   - The composer switches to its STOP action whenever work is pending ON THE SELECTED
//     CONVERSATION — `running` is that conversation's own flag, re-set by its painters
//     (`applyView`/`refreshPending` call `setBusy(instance.pending)`), and `current.pending`
//     is the same figure read directly — including a session observed after a reload. The
//     run of a conversation the reader left paints no STOP here; Stop cancels that ONE
//     conversation's queue explicitly via cancelSession(id, true).
//   - Session SWITCHING and session CREATION are NOT locked by a run (R4) — and neither is
//     the harness rail, which now states the same rule at BOTH ends: `buildHarnesses` creates
//     a row with `submitting || !booted`, and the pass below re-derives exactly that. The
//     queue is server-owned, so leaving a conversation only unsubscribes its observer. Both
//     keep the windows that can genuinely race — `submitting`, `!booted`, and an archived
//     harness for the create — see `paintSessionActions`, `paintSessionCycle` and the strip
//     pass below. Reset is gone (R10), so there is no third composer control to paint.
//   - R1: the TWO CATALOGUES (Tools and Plugins) are NOT locked by a run. They are
//     server-wide surfaces whose own writes have no idle window, and every transcript
//     painter early-returns while a catalogue owns the centre column, so a stream keeps
//     being folded into the conversation underneath the pane. Their only remaining gate
//     is `!booted` (there is nothing to list before the catalogue answers) — plus
//     `pluginsLoading` for the plugin re-read.
const paintControls = (): void => {
    const pending = running || current?.pending === true;

    // R9/R10: the composer's single action is painted from the same state as every
    // other control. It is the only submit/stop control in the shell.
    paintComposer();

    // R1 (T3) / R4 (T9) / R3 (this pass): the create-session control is painted from one
    // place (`paintSessionActions`) and there is now exactly ONE of them — the compact `+`
    // in this header row. R3 removed the dashboard's copy (no creating inside the details
    // dialog), so the two-copies rule that used to live here is gone with it.
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
    // R1: the tool rows are a server listing, not a conversation affordance — pressing
    // one opens a modal runner whose call goes straight to the server. Nothing here
    // tears down the transcript, so a run never dims the list.
    //
    // R3: the row's ENABLEMENT tick box is not painted from run state either; it is
    // painted from ITS OWN in-flight write (`togglingTools`), because that is the only
    // race the control can create with itself.
    for (const [name, control] of toolEnableBoxes) {
        control.disabled = togglingTools.has(name) || !booted;
    }

    // R3 + R1: the global tools toggle is gated by ONE thing — the catalogue has to
    // exist before the pane can list it. The run lock the removed tabs carried is gone
    // (`setToolsView` has no `running` gate), and `showOffline` disables the control
    // again the moment the transport is lost.
    toolsToggle.disabled = !booted;
    // T7 (R2) + R1: the Plugins toggle answers to the identical gate. Its writes
    // (`PATCH /plugins/{id}`, including the reserved `enabled` key) are write-anytime
    // on the server, so nothing here has to fear a streaming queue.
    pluginsToggle.disabled = !booted;
    // The re-read keeps its own extra gate: a read already in flight must not be
    // dialled twice (`loadPlugins` is single-flight, and a disabled control says so).
    pluginsRefresh.disabled = pluginsLoading || !booted;

    // R1: plugin rows are always clickable once boot has answered; their tick box is
    // locked only while ITS OWN write is in flight (`togglingPlugins`).
    for (const [name, control] of pluginEnableBoxes) {
        control.disabled = togglingPlugins.has(name) || !booted;
    }

    // R1/T3: pills replace the rail rows, and an archived conversation's pill is the same
    // control, so the busy-state pass walks every live strip instead of two lists.
    //
    // Opening a conversation is locked ONLY while a submit is in its enqueue window: the pill is
    // built with `disabled = submitting` (`paintSessionPill`), and this pass is what keeps that
    // state honest after a repaint that did not rebuild the strip. A RUN locks nothing — leaving
    // a working conversation is an unsubscribe, not a cancel (R4).
    const deletionsBlocked = deletionBlocked();

    for (const bar of liveSessionBars()) {
        for (const select of bar.element.querySelectorAll<HTMLButtonElement>('.session-pill-select')) {
            select.disabled = submitting;
        }

        // R8: deletion is a write, so it is disabled for the same conflicting windows
        // that lock submits/saves (and for a pill whose own DELETE is in flight). The
        // click handler re-checks `deletionBlocked`, so this is only the visible state.
        for (const button of bar.element.querySelectorAll<HTMLButtonElement>('.session-pill-delete')) {
            const id = button.dataset.sessionId;
            button.disabled = deletionsBlocked || (id !== undefined && removingSessions.has(id));
        }
    }

    // T7: the header cycler opens a conversation through the very same `openSession` a strip
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

    let session: SessionView;
    try {
        session = await createViewSession(instance.descriptor.name, settings);
    } finally {
        creatingSessions -= 1;
    }

    instance.sessionId = session.id;
    // N3: the first submit of a new conversation creates the session before the
    // task is enqueued, so bind here: any action card that arrives with the run is
    // answerable against this id.
    instance.view.bindSession(session.id);
    instance.frozen = frozenTeamOf(session);
    // The creation answer carries this session's effective model map, which is also
    // the map a later PATCH /views/:id replaces (R2).
    instance.sessionModels = agentModelsOf(session);
    instance.sessionModel = typeof session.model === 'string' ? session.model : undefined;
    instance.discovered = Array.isArray(session.discoveredTools)
        ? [...session.discoveredTools]
        : undefined;
    // T7b (R6): this card now points at a CONVERSATION, so the template's stored prompts,
    // colours and overrides are no longer what its agent dialog edits. Cleared rather than
    // carried: the next open reads this session's own roster (`loadSessionConfiguration`).
    instance.harnessInstructions = undefined;
    instance.harnessColors = undefined;
    instance.harnessModels = undefined;
    // A fresh session has no turns and no pending work; clear any stale queue state
    // from the conversation this card used to point at — including the compiled
    // document, the view store's addressed tree and any expanded panel, all of which
    // belong to the conversation being left. Tombstones are per-session, so the new
    // conversation starts with none (S3).
    instance.threadTombstones.clear();
    instance.turnTombstones.clear();
    releaseSessionState(instance);
    instance.pending = pendingOf(session);
    // A brand-new session has no persistent threads yet; handing the empty roster to
    // the board clears any focus left over from the conversation this card used to
    // point at.
    instance.threads = sessionThreadsOf(session);
    instance.view.setThreads(instance.threads);
    // The creation answer IS the initial compiled authority: a `SessionView`, so the
    // first paint of a new conversation costs a header, not an event log (T5 R1).
    instance.store.setView(session);
    instance.compiled = session;
    instance.view.setSessionView(session);
    // A freshly created session starts with an empty turn list, so recomputing from
    // it both empties the board and guarantees nothing from a previously viewed
    // session survives a New session.
    derivePanels(instance);
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

        // 202 on the canonical wire: a TASK RECEIPT, never a document. The row the receipt
        // names is merged into the document this browser already paints, the session figures it
        // states are patched in place, and everything else — the running row, the tally, the
        // streamed answer — arrives on the socket. A re-read here was a second round trip per
        // task, and applying it as a document erased the rows, the model map and the frozen team
        // the receipt does not carry (an accepted second task then painted as `error`).
        // `references` carries the exact block bindings picked via # (omitted when the
        // prompt has none, so a plain typed `#LABEL` keeps the old body shape).
        const { turn: record, receipt } = await submitViewTask(
            sessionId,
            prompt,
            validated,
            references.length === 0 ? undefined : references,
            // Absent for a new thread: the server decides the new thread's id and reports it on
            // the row; the roster learns it from the stream's `turn.upsert`.
            target.threadId
        );

        // Steering answers with the OWNING row (same id, `steered: true`) instead of a
        // new one: the optimistic steering row must not survive as an unbound queued
        // ghost, so it is discarded and the row binds to the tile that already
        // represents that conversation. Every other path binds this tile as usual, and
        // binding a compiled row can never duplicate streamed text - a node's content
        // is painted from the node, not from a replayed delta.
        //
        // The id check is kept alongside the marker: it also collapses the (rare)
        // case of a server that folds the submit without reporting `steered`.
        const owner = instance.view.turn(record.id);
        if (owner !== undefined && owner !== turn && record.id !== turn.id()) {
            instance.view.discard(turn);
        }

        instance.view.upsertSummary(record);

        // Keep the steering target visible on the conversation that received the
        // message: continuing/steering must not silently move focus elsewhere.
        // R3c: the reader pressed send, so keeping that conversation in view is their call.
        if (target.threadId !== undefined) instance.view.focusThread(target.threadId, true);

        // The receipt's own merge: rows, pending flag, session figures, directory row.
        applyReceiptRow(instance, record, receipt);
        renderSessions();

        if (instance.sessionId === sessionId) {
            // The task is accepted and this card owns the conversation: start observing.
            // The queue figure is already painted from the receipt, so nothing is re-read.
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
            instance.snapshotMark = undefined;
            instance.pending = false;
            // Bind teardown expires answer cards AND closes the tracked transcript;
            // releasing the compiled document, the store tree and the roster also stops
            // the board's fallback from reopening a transcript from stale state.
            releaseSessionState(instance);
            instance.view.bindSession(undefined);
            instance.view.setThreads([]);
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

    // T52: Stop cancels WORK, it does not end OBSERVATION. The server publishes the terminal
    // records of a deliberate stop on the very subscription this client already holds (the
    // cancelled `turn.upsert`, then `session.updated`), and those frames are what repaint the
    // tile — the abort here left the cancelled row with no subscriber, so the tile stayed
    // `streaming` while the session had stopped. Aborting also forced the re-read below to
    // become the only reconciliation, and a re-read captured before the server applied the
    // cancel answered the still-running document.

    // The cancel round trip is async; the tile keeps its last state until the
    // server confirms. No header acknowledgement: Stop is a session action and is
    // not an app-level state (R1).

    // Stopping is the user's terminal signal: no ring may keep spinning while the
    // cancellation round-trip finishes.
    instance.activity.clear();
    if (current === instance) paintAgentRings(instance.activity);

    void cancelView(sessionId, true)
        .catch(() => false)
        .finally(() => {
            if (instance.sessionId !== sessionId) return;

            // Reconciliation of the session figures stays a re-read (it is the only path that
            // works when the live plane is a bounded poll, i.e. a host with no transport). It is
            // NOT the source of the tile's terminal state any more: the cancelled rows also
            // arrive on the subscription that is still open above.
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
        const descriptor = descriptorOf(await createHarness(request)) as unknown as HarnessDescriptor;
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

// R1 (T3) / R4 (T9) / R3 (this pass): the only New-session control is the header `+`, wired
// where it is built (`sessionNew`). The dashboard's copy that used to be built inside
// `createSessionPillBar` is gone — a conversation is not created from the details dialog —
// so there is one listener again.

// A polling loop or a live tick must never outlive the page; a reload re-reads
// the snapshot and every elapsed label from the server.
window.addEventListener('pagehide', () => {
    // Unsubscribe and stop every timer. The server keeps running any pending
    // queue (R4); a reload re-reads the snapshot and reopens the observer.
    stopWatching();
    stopPolling();
    clearActivity();

    // T5/R1: the registered live panels' teardown travels with the page. Each one
    // released its own listeners/subscriptions/timers through its `PanelContext`, so
    // an unload hook another module installed cannot strand a plugin's resources.
    panelRuntime.disposeAll();

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

    for (const instance of instances.values()) {
        // T24: every focused-turn flow subscription dies with the page. Aborting is
        // an unsubscribe only — the server keeps running whatever is pending (R4).
        stopTurnFlow(instance);
        // T3: same for every followed thread (R3) — the registrations are released, the
        // transcripts go with the conversation, and the plane itself says goodbye below.
        stopThreadFollow(instance);
        instance.threadWatches = undefined;
        instance.transcripts = undefined;
        // T9 (R7): no lane pass may outlive the page either — a re-armed timer would fire a
        // display read the reader will never see.
        cancelDisplayRefresh(instance);
        instance.view.dispose();
    }

    // T3 (R4): the page is going away, so the ONE shared socket goes with it — a `bye`
    // plus close 1000, which is how this connection does not look like a DROP in the
    // server's diagnostics (and how the next page load starts from a fresh registration
    // instead of resuming a cursor the server may have parked for this one). Until now
    // `close()` was never called in production at all: the socket of a reloaded page was
    // left to the browser, and the reconnect path treated it as an outage.
    harnessStream().close('page unload');
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

    if (defaults.base_url.trim().length > 0) settings.baseURL = defaults.base_url;
    if (defaults.model.trim().length > 0) settings.model = defaults.model;

    saveSettings();

    // The defaults are COMMITTED state, and the settings controls show the draft, so the
    // draft is re-based here rather than written field by field (R4/T4: the fields belong
    // to the dialog, and they read `endpointDraft`).
    //
    // F4: the status pill is enabled BEFORE the bootstrap lands, so the dialog can be open
    // when these defaults arrive. Re-syncing then rewrites every field out from under the
    // caret — the reader loses what they typed for nothing, since `saveSettings` above has
    // already written the server's bytes, not the draft (R4 holds either way). So the re-sync
    // is skipped while a layer is open: the edits stay, and the next open re-bases from the
    // saved values exactly as a dismissal does. The one consequence worth naming is that a
    // reader who opened the dialog before boot and then presses `Apply` commits the pre-boot
    // draft for the fields they never touched, rather than the defaults that just landed.
    if (endpointDialog === undefined) syncEndpointDraft();
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
    // T7 (R2): the Plugins catalogue is server-wide data this pane can only read through
    // the same dead transport, so its toggle goes disabled with the tools one.
    pluginsToggle.disabled = true;
    pluginsRefresh.disabled = true;

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

        // The defaults may have replaced the model, and the stored settings may name a model the
        // provider no longer serves. Rendering first and then fetching keeps the dropdown correct
        // in both cases; the lookup runs in the background so boot is not gated on the provider
        // being reachable.
        //
        // It is a COMMITTED lookup, and that has to be stated rather than inferred: the dialog can
        // be open while these defaults land, and `applyDefaults` deliberately leaves the draft
        // alone then (./main.ts F4), so the draft may still name the pre-boot endpoint. Reading
        // `settings` is what makes this the answer for the endpoint this load actually dials, and
        // publishing it is what gives every per-agent model dropdown its provider's ids (./main.ts
        // `publishModelCatalogue`).
        renderModelOptions();
        void refreshModels(committedModelLookup());

        presetDescriptors = data.presets as unknown as HarnessDescriptor[];
        // The agent library is server data. An older server has no list, so derive
        // a minimal one from its descriptors: the picker still works, and the
        // detail panel says the server did not advertise instructions.
        agentLibrary =
            Array.isArray(data.agents) && data.agents.length > 0
                ? data.agents
                : agentsFromDescriptors(data.presets as unknown as readonly HarnessDescriptor[]);

        // T4/R1: seed the identity palette with the trusted library roster, in catalogue
        // order and with NO explicit colours, before anything can paint. Boot first, and the
        // active view after it (every `configureAgentColorsFor` below), is what makes a saved
        // session's custom agents append deterministically to the tones the reader already
        // knows instead of re-shuffling the whole mapping on the first frame.
        configureBaselineAgentColors();

        buildHarnesses();
        buildTools(data.tools as unknown as readonly ToolRowEntry[]);

        // T5 R1 / T38: the conversation directory is the COMPACT surface. The bootstrap already
        // embedded one row per conversation, and a row is the CONTRACT's snake_case metadata
        // document (`SessionSummary`, ../shared/harness-api.ts:812-825): it carries
        // `created_at`/`updated_at`/`queue_depth` and NO turns. It therefore goes through
        // `directoryRowOf` — the exact mapper the `GET /sessions` page uses (./view-shell.ts) —
        // instead of being cast into the shell's record. The cast is what made "open the latest
        // session" meaningless (every row ranked at recency 0, because `recencyOf` reads the
        // camel stamps) and what left a `running` conversation unwatched after a reload.
        const embedded = Array.isArray(data.sessions) ? data.sessions.map(sessionRowOf) : [];
        sessions = embedded.length > 0 ? embedded : await listViews().catch(() => []);
        renderSessions();

        // Catalogue-dependent actions become usable only now.
        createHarnessButton.disabled = false;

        booted = true;
        // R1 (T3) / R4 (T9) / R3 (this pass): the header's New-session button is the only
        // create control, and EVERY control's enabled state is derived from `booted`, so the
        // shared painter runs AFTER the flag flips (the rail used to force the buttons on
        // directly). `paintControls` is `paintSessionActions()` + `paintComposer()` + the rail,
        // pill, cycler and catalogue passes, so this replaces the two ad-hoc calls that used
        // to sit here.
        //
        // R3 (this pass): the harness rows are now CREATED from the same expression
        // `paintControls` re-derives (`submitting || !booted`), so this repaint is what turns
        // the rail on at the end of boot. It has to be the shared painter rather than the two
        // ad-hoc calls: the boot path that opens NO conversation (`initial === undefined`
        // below) never reaches `setBusy`, and every other rail repaint happens before
        // `booted` flips — the rail would otherwise stay disabled until the first live frame.
        //
        // T3 (zero-harness boot): a RESOLVED bootstrap that reports ZERO harnesses is a
        // healthy server, not an offline one. The tool catalogue, the agent library and the
        // session directory all came back, and `POST /v1/harness/harnesses` needs no
        // pre-existing harness (its primary only has to be a known agent), so an empty
        // catalogue must boot exactly like a normal one: `booted = true`, the same control
        // painting, and the empty-catalogue UI the live delete-all path already lands in
        // (`applyHarnessRemoved`). Bailing out into `showOffline` here is what made a
        // delete-everything server look dead AND left "+ New" refused by the `!booted` click
        // guard, so the reader could never create the first harness. Only a FAILED request
        // is offline — that is the catch below.
        paintControls();

        if (presetDescriptors.length === 0) {
            // The identical screen a reader gets after deleting the last harness, so a
            // reload of that server does not move them: no chat head, no composer, the
            // centre column names the way back (`emptyStagePane`), and the rail keeps the
            // "No harnesses reported by the server yet." hint `buildHarnesses` painted
            // above. Saved sessions of the deleted harness stay reachable.
            agentSlot.hidden = true;
            composer.hidden = true;
            stage.replaceChildren(emptyStagePane());
            renderSessions();
            // Every control is then derived from `booted` by the SHARED painter, which is
            // what the live delete-all state already reflects: "+ New" and the header "+"
            // are enabled (the header "+" is a no-op with no instance — `newSession`'s
            // `current === undefined` guard, exactly like that state), and the two
            // server-wide catalogue toggles stay usable because their rows arrived with the
            // bootstrap.
            paintControls();
            // Informational, never `error`: the pill reads `idle` and its detail names the
            // action that leaves the empty state.
            setStatus('idle', 'no harnesses · create one with “+ New”');
            return;
        }
        // T24: `selectHarness` now resolves the harness on screen by itself, and boot must
        // not stack a second automatic open on top of it. Marking the first harness as
        // already entered hands that ONE decision to the awaited block below, which is the
        // version that also honours the saved-pointer fallback and finishes before the
        // reader sees a half-resolved view.
        const firstHarness = presetDescriptors[0].name;
        enteredHarnesses.add(firstHarness);
        selectHarness(firstHarness);

        // T21 R21: a first load opens the LATEST conversation of the harness on
        // screen, ranked by the server's own stamps (see `initialSession`). This runs
        // BEFORE the remembered pointer is consulted on purpose: a pointer from an
        // earlier visit must not beat the newest conversation, so the saved id only
        // decides when it IS the newest, or when the selected harness has no
        // conversation at all and the pointer names one under another harness (the
        // resume this app has always offered on a reload).
        const remembered = loadRememberedSession();
        const rememberedLive =
            remembered !== undefined && sessions.some((session) => session.id === remembered);

        // Sessions are in memory, so a server restart loses them; an unknown id is
        // forgotten, not treated as an error.
        if (remembered !== undefined && !rememberedLive) forgetRememberedSession();

        const newest = initialSession();
        const initial = newest === undefined ? (rememberedLive ? remembered : undefined) : newest.id;

        if (newest === undefined) {
            // Boot had nothing to resolve FOR this harness (an empty one, or only the
            // saved pointer of another harness matched). Release the claim above, so the
            // next time the reader enters it the shared entry rule picks the newest
            // conversation the server reports by then — the same "empty stays eligible"
            // rule `openLatestOfEnteredHarness` applies everywhere else.
            enteredHarnesses.delete(firstHarness);
        }

        if (initial === undefined) {
            // Nothing to open: an empty harness view, which is what `+ New session`
            // and the composer are for.
            setStatus('idle');
        } else {
            await openSession(initial);
        }

        // R8: initial load never focuses the composer. The page opens with focus
        // where the browser put it (body); the user clicks the field to type.
    } catch (error) {
        showOffline(messageOf(error));
        setStatus('error', 'server offline');
    }
};

void boot();

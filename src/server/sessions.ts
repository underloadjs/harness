// In-memory sessions for the harness server, with an optional durable store.
//
// A session owns exactly one harness instance and its conversation. Submitting a
// task appends to that conversation, so the UI can send another task later and the
// model still sees the earlier transcript. Persistence (R3b) is OPTIONAL: when the
// host supplies a database root, every structural mutation is written through
// ./persistence.ts before it returns, background turn transitions (start, tool
// result, terminal) are saved as they happen, and a restart rebuilds the registry,
// then each session's frozen harness, then the core snapshot. With no root the
// store is exactly the previous in-memory behaviour (direct unit tests).
//
// FROZEN CONFIGURATION (R4): create() resolves a harness through the live registry
// exactly once. The preset object and a descriptor snapshot are captured on the
// session, so a later POST/PATCH — even one that rebrands the same built-in —
// affects only FUTURE sessions. This session keeps running (and reporting) what it
// was built with.
//
// The ONE live mutation is a model id (R2): setAgentModels retargets an agent in
// place, so the next request uses the new model while the harness, its history,
// and the frozen `definition` are untouched. Snapshots therefore report the live
// map, and `definition.agentModels` stays the creation-time record.
//
// THREE SUBMIT PATHS (R4, all retained):
//   - LEGACY: run() backs POST /sessions/:id/messages. The run is owned by that SSE
//     response: if its emitter fails the run is aborted, and a busy session is
//     rejected with 409 before a status line is sent.
//   - QUEUE: enqueue() backs POST /sessions/:id/tasks for MODEL work. It answers 202
//     immediately and the private lane pump executes each THREAD's backlog FIFO, so a
//     task keeps running after the browser disconnects. Watchers
//     (GET /sessions/:id/events) only unsubscribe on disconnect; nothing aborts an
//     accepted task except cancel/remove/delete.
//   - COMMAND: dispatch() is what POST /sessions/:id/tasks actually calls, and it is
//     the ONE splitter. A leading "/" is an OPERATOR command, so it runs HERE
//     (`harness.executeCommand`: no model request, no lane, no steering, no pending
//     cap) and its answer is recorded as one ordinary SessionTurn with SYNTHESIZED
//     `start`/`tool_call`/`tool_result` events, which is what lets the existing
//     renderers and a reload show it with zero frontend changes. Every other input
//     falls through to enqueue() untouched, so the queue contract is unchanged.
//
// SINGLE FLIGHT: every operation that mutates a session's harness is mutually
// exclusive: a queue pump turn, a legacy streaming run, a manual `callTool` (R8),
// and a reset all share the private `busy` flag. The pump WAITS for the gate (it
// never runs the harness alongside a legacy run or a manual call), while the
// legacy/manual paths reject with 409. A manual call is NOT a turn, so it never
// changes `status` or appends a SessionTurn; `busy` is released in a `finally` on
// success, failure, and cancellation. cancel() aborts an active run; a manual call
// has no controller.
//
// FRESH BLOCKS + RESULT REFERENCES (R2): a LEGACY `/messages` turn, and each
// unfocused submit (its own new host thread with an empty transcript), is a NEW
// block, not a resumed transcript. For the legacy path executeTurn reseeds every
// agent's conversation (`agent.reset()`, NOT `harness.reset()`), so the previous
// block's user/assistant messages are never inherited while discovery, todos,
// record stores, created tools, and the session's `turns` archive survive. A submit
// that names a thread is a CONTINUATION of that conversation (that is what a
// persistent thread means), and a submit to a RUNNING thread is steered into it.
// A task may
// carry `references` (or type `#LABEL`), which the store binds at enqueue and
// expands at EXECUTION from the referenced turn's recorded terminal `done`
// content; the raw `turn.prompt` stays user-facing. See shared/agent-results.ts
// for the block projection and prompt delimiters.
//
// Record ownership (H3): the server — not the browser — is the source of truth for
// the renderable transcript. Each submitted task becomes one SessionTurn that owns
// the prompt, status, timestamps, and every HarnessEvent the run produced
// (including events from subagents reached by delegation). `eventTimes` is a
// parallel epoch-ms array, so per-step and per-tool elapsed time survives a
// reload. `usage` is the server's running token tally for the turn, folded from the
// per-request `usage` events (see addUsage) and repeated on every stream frame, so
// a live tile and a reloaded one print the same number. Snapshots clone the turns,
// so a client that mutates a response cannot corrupt the live record.
//
// OWNER INTERACTION (N4): buildHarness installs ONE
// `interaction.actionRequest` handler on every session (fresh and restored, every
// preset). It parks the runtime's awaited promise in this session's
// `pendingActions` map, and answerAction (POST
// /sessions/:id/actions/:requestId/answer) settles exactly one entry after
// validating the choice against the request the model offered. Four unanswered
// questions are allowed at once (the runtime enforces the same bound); a fifth is
// rejected for the model, never auto-selected. cancel(), remove(), dispose(), the
// end of a turn, and the runtime's run signal all reject outstanding promises;
// finished ids stay in a bounded history so a stale card answers 409 rather than
// 404. After a restart nothing is resumed: every recorded question is expired, and
// the events remain the source a client renders question cards from.
//
// PERSISTENT THREADS (R1-R6): the harness owns persistent agent conversations
// (`harness.threads()`); the store owns the TURN records and decides which thread
// an input executes in.
//
//   - POST /tasks WITHOUT threadId opens a NEW standalone host thread for the
//     primary agent. A reference to a prior block is a LINK only (the roster
//     derives `connectedThreadIds`); `ownerThreadId` is reserved for the runtime's
//     delegation lineage, so stopping/deleting a referenced source never aborts or
//     purges the connected conversation.
//   - POST /tasks WITH threadId runs in that thread's own LANE. EVERY
//     thread-capable submit (new or addressed) runs in its lane: two plain submits
//     are CONCURRENT (F1), while one lane's backlog stays FIFO. The legacy
//     `session.queue` + pump survive only for a harness handle that predates the
//     thread API. `queueDepth` counts pending work across every lane, and
//     MAX_PENDING_TASKS spans them all. A legacy run or a manual tool call still
//     owns the session's exclusive gate and parks every lane.
//   - A submit to a RUNNING thread is STEERED (`harness.steerThread`) at the next
//     safe model boundary; no duplicate turn is recorded and the response returns
//     the owning turn with `steered: true`.
//   - Stopping one thread aborts its run and drops its queued turns; stopping all
//     (`/cancel {all:true}`) also stops every host thread and drops every backlog.
//   - Deleting a terminal thread purges its turns, its descendants' turns, the
//     result references that pointed at them, and the persisted copies BEFORE the
//     response. Turn INDICES are monotonic high-water marks and label counters are
//     recorded per turn, so deletion never renumbers a surviving record.
//
// CONSEQUENCES for existing readers (explicit, not silent):
//   - `SessionSnapshot.messages` stays the ENTRY AGENT's default conversation, so
//     it is empty for a threaded submit (the conversation lives in the thread; see
//     `SessionSnapshot.threads[].messages` and the per-turn `threadId`). The legacy
//     `/messages` route keeps appending to it exactly as before;
//   - an attachment-only submit (empty prompt) is a valid task, but a thread run
//     requires non-empty text, so its attachment markers become the run text; the
//     recorded `turn.prompt` stays the raw (empty) user text;
//   - each unfocused submit opens its own thread, which is bounded by the runtime's
//     MAX_THREAD_RECORDS (256). A long unfocused conversation reaches that bound;
//     the UI path (submitting the returned `threadId`) continues ONE thread instead;
//   - a harness handle that predates the thread API keeps the legacy behaviour
//     (see `threadsSupported`): no threads, no roster, fresh blocks on the root.
//
// Progress attribution: the runtime exposes ONE progress hook per harness. Its
// `thread` field is INVOCATION identity (`start` carries the prompt, later frames
// the id), and the same agent can run in two host threads at once, so the field
// alone cannot decide which recorded turn an event belongs to. Concurrent runs are
// therefore routed with AsyncLocalStorage: each run executes inside its own
// context, so the harness's progress callback (and a background tool completion it
// schedules) delivers to exactly that run's turn. A single active run remains a
// safe fallback when a callback escapes the async chain.
//
// Cross-references:
//   - ./protocol.ts — SessionSnapshot.turns/threads, SessionTurn, SessionStreamItem
//   - ./handler.ts  — forwards stream items verbatim; no turn inference there
//   - ./api.ts      — POST /tasks (202), GET /events (watcher), POST /cancel {all},
//                     POST/DELETE /sessions/:id/threads/:threadId[/cancel],
//                     GET/PUT /sessions/:id/threads/:threadId/transcript (C4),
//                     POST /sessions/:id/actions/:requestId/answer
//   - ./harnesses/registry.ts — the in-memory harness registry
//   - ./harnesses/descriptor.ts — describeHarness, the frozen definition
//   - ../shared/agent-results.ts — labels, block projection, reference prompt
//   - ../core/action.ts — validateActionChoice (the one answer parser)
//   - ../harness.ts — threads()/createThread()/sendThreadInput()/steerThread()/
//                     stopThread()/stopAllThreads()/deleteThread()

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
    Harness,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessActionRequestContext,
    HarnessAttachment,
    HarnessCommandResult,
    HarnessEvent,
    HarnessInteractionConfiguration,
    HarnessMessage,
    HarnessSnapshot,
    HarnessStateChangeEvent,
    HarnessThreadRecord,
    HarnessThreadSteerReceipt
} from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { validateAttachments } from '../shared/attachments';
import {
    agentCodeOf,
    agentLabelParts,
    collectAgentLabelCounters,
    composeAgentResultPrompt,
    findAgentResultBlock,
    findLatestAgentResultBlock,
    listAgentResultBlocks,
    MAX_AGENT_REFERENCES,
    parseAgentReferenceLabels,
    readAgentResultReferenceList
} from '../shared/agent-results';
import type { AgentResultBlock, AgentResultReference, AgentResultTurn } from '../shared/agent-results';
// T16: the stream contract's resource-kind vocabulary, deep-imported (the shared barrel collides
// with the server's own names). It is a TYPE-only dependency: the store answers the broker's
// existence question with the same key the hub and REST stamp revisions under.
import type { StreamResourceKind } from '../shared/harness-stream';

/**
 * T16: split a hub composite key (`session:turn`, `session:thread`) into its parts, accepting the
 * plain id form a subscription carries too. The fallback session id comes from the subscription's
 * own `session_id`, which is how a turn/thread resource addressed under a session scope resolves.
 */
const splitStreamKey = (id: string, fallbackSessionId?: string): [string | undefined, string | undefined] => {
    const separator = id.indexOf(':');

    if (separator < 0) {
        // A plain child id is meaningless without its session scope, and a plain session id is a
        // whole id: with a scope present, treat it as the child; without one, as the session.
        return fallbackSessionId === undefined ? [id, undefined] : [fallbackSessionId, id];
    }

    return [id.slice(0, separator), id.slice(separator + 1)];
};
import { validateActionChoice } from '../core/action';
// C4: the ONE transcript reader (`readHarnessMessages`) shared by snapshot(),
// restore() and the transcript editor, so the server can never persist a
// transcript its own restore would refuse, and a transcript it refuses is refused
// with the exact same message everywhere. Barrel import (core/index.ts) keeps the
// module graph identical to the rest of the server.
import { readHarnessMessages, THREAD_AGENT_PREFIX } from '../core';
// The ONE slash-line parser (core/command.ts). The store uses it only to DECIDE
// whether a submit is a command; the harness re-parses the same line when it
// executes it, so a host can never disagree with the server about what "/x" means.
import { parseCommandLine } from '../core/command';
import { describeHarness } from './harnesses/descriptor';
// T27: a session-scoped agent binding composes its brain from the SAME trusted profile the
// preset factory uses (./harnesses/toolbox.ts `agentConfigurationFromProfile`), so a member
// added at runtime and a member a restart rebuilds cannot disagree about the prompt, the
// model, or the provider transport. `effectiveAgentProfile`/`agentInstruction` are the two
// halves of clearing an override back to the deployment's current text.
import { agentConfigurationForCustom, agentConfigurationFromProfile, customAgentInstruction } from './harnesses/toolbox';
import { effectiveAgentProfile } from './harnesses/agent-state';
import { agentInstruction, isAgentProfileName } from '../agents';
import {
    createHarnessRegistry,
    HarnessRegistryError,
    normalizeAgentModels,
    presetFromRecord,
    presetRecordEquals,
    presetToRecord
} from './harnesses/registry';
import type { HarnessRegistry } from './harnesses/registry';
import { mergeSettings } from './config';
import type { ServerRuntimeConfiguration } from './config';
import { DEFAULT_RUNTIME_CONFIGURATION } from './config';
// T5 (R1): lane-worker execution. Imported through the subsystem barrel so the session layer
// has ONE boundary to the worker machinery, and never reaches into a primitive directly.
import {
    assessLaneWorkerCapability,
    createLaneAuthority,
    createLaneHost,
    laneWorkerEnvironment,
    laneWorkerUnsupportedMessage,
    planWorkerToolSurfaces,
    // T12: the field-correct scan text (`moduleText` + captured helpers), so the SESSION window
    // is computed from the same bytes the worker report and the authority's created-tool check
    // scan. Without it `memoryKeysFor` saw `undefined` for every shipped core tool.
    toolScanTextOf
} from './workers';
import type { LaneAuthority, LaneBlueprintSource, LaneHost, LaneTarget, LaneTurnResult } from './workers';
// D4 (R1/R2/R4): the IO worker client, through the same subsystem barrel. `openHarnessIoClient`
// is the SYNCHRONOUS opener: the store constructor cannot await, and the client registers
// every operation issued before the handshake and releases it in call order once the worker
// answers (`./workers/io-client.ts`, "THE INTEGRATION CONTRACT").
import { openHarnessIoClient } from './workers';
import type { HarnessIoClient, IoCloseSummary } from './workers';
import { HarnessPersistenceError } from './persistence';
import { HARNESS_DATABASE_VERSION, repairInterruptedToolCalls } from './persistence';
import type { HarnessDatabase, HarnessGlobalSettingsRecord, HarnessInvalidThreadRecord, HarnessPersistence, HarnessSessionRecord } from './persistence';
import type {
    CancelThreadResult,
    HarnessDescriptor,
    HarnessUsage,
    SessionInvalidThread,
    SessionSnapshot,
    SessionStatus,
    SessionStreamItem,
    SessionThread,
    SessionThreadView,
    SessionTurn,
    SessionView,
    SessionViewStreamItem,
    SessionViewSummary,
    ThreadTranscriptResponse,
    TurnBlockDetail,
    TurnStepDetail,
    UpdateThreadTranscriptResult
} from './protocol';
// R1/R3/R4: the compiled display surface. The fold is SERVER-only (the browser
// imports the types from ../shared/turn-display.ts and never this runtime), and the
// journal is the per-step durable log the compiled memory is rebuilt from.
import type {
    ContextBlock,
    DisplayProjectContext,
    TurnDisplay,
    TurnDisplayOp,
    TurnInstructionSource,
    TurnProjector
} from '../shared/turn-display';
import { createTurnProjector, refoldTurn, steerBlockKeyOf, steerBlockKeysOf, steerSubmitList } from './turn-projector';
import { HarnessJournal } from './journal';
import type { JournalEventRecord, JournalProblem } from './journal';

const MAX_INPUT_LENGTH = 200_000;

// R7: the name shape of a SESSION-DEFINED agent — one a conversation INVENTS instead of
// selecting from the trusted catalogue (./harnesses/toolbox.ts `agentConfigurationForCustom`).
// The name is simultaneously a delegation id, a runtime agent-registry key, a default-conversation
// thread-id component (`agent:<name>`), and a key of the session's durable preset maps, so the
// rule is deliberately conservative: an alphanumeric first character (which also keeps a name
// like `__proto__` from landing on the PROTOTYPE of the runtime's plain-object agent map), then
// letters, digits, space, `.`, `_` or `-`, at most 64 characters in total, and never a control
// character. A catalogue profile id (`instruct`, `summarizer`, …) is lowercase-and-strict already,
// so this pattern never widens what a PROFILE binding accepts.
const CUSTOM_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

// The one name a custom agent may never take: `unknown` (any case) is the placeholder the UI
// paints for "no agent at all" (src/frontend/ui/agent-color.ts `UNNAMED_AGENT_PLACEHOLDER`), so
// an agent literally named that would render as a lookup miss everywhere it appears.
const CUSTOM_AGENT_RESERVED_NAME = 'unknown';

// Maximum number of PENDING (queued, not yet started) tasks per session. The
// active turn is not part of the queue, so a session can run one task with this
// many waiting. Exceeding it is a 429, and the submit mutates nothing.
const MAX_PENDING_TASKS = 100;

// Result references (R2) are bounded by the shared reader (MAX_AGENT_REFERENCES).
// The per-submit cap is enforced there, so the store and persistence cannot
// disagree about what a valid reference payload is.

// N4 owner interaction: one session can have at most this many unanswered
// actionRequest questions. The runtime enforces its own bound too, so this is the
// server's independent guard against a host (or a misbehaving runtime) parking
// more promise resolvers than a human could ever answer. A fifth request is
// REJECTED (the model receives a readable tool error); it is never auto-answered.
const MAX_PENDING_ACTIONS = 4;

// Steered-submit audit bound per turn (F3). Only identity/timing/link metadata is
// kept — never a second copy of the event transcript.
const MAX_STEER_RECORDS = 64;

// This ring is the OPERATIONAL record (and the compact row's list): a rolling last-64. It is
// NOT the retention limit for what the user typed — every accepted submit's text is archived
// on the same turn WITHOUT a cap, so a context-bar segment stays resolvable however long the
// turn was steered (./protocol.ts `SessionTurn.steerTexts`, ./persistence.ts
// `readSteerTexts`). The fold mints, and this store resolves, from the merged list
// (./turn-projector.ts `steerSubmitList`).

// How many no-longer-answerable request ids a session remembers. `answerAction`
// uses this to distinguish "expired/already answered" (409) from "never existed"
// (404) after the pending entry is gone (including after a restart). Bounded so a
// long conversation cannot grow the set without limit; the oldest ids fall out
// first.
const MAX_COMPLETED_ACTIONS = 64;

// Readable rejection texts. The handler promise rejection is turned into a tool
// result by the runtime, so the model — not just a log — sees why no answer came.
const ACTION_CANCELLED_MESSAGE =
    'The action request was cancelled before the owner answered. Ask again only if the question is still required.';
const ACTION_RUN_ENDED_MESSAGE =
    'The run ended before the action request was answered. Ask again if the question is still required.';
const ACTION_SESSION_GONE_MESSAGE =
    'The session was removed before the action request was answered.';
const ACTION_DUPLICATE_MESSAGE = 'An action request with this requestId is already pending.';

/**
 * T16: map an action settlement to the contract's closed `action.closed` reason set
 * (`WsActionClosed.reason`, src/shared/harness-stream.ts). The store's rejection TEXT is written
 * for the model, so the classification is done on the stable phrases above rather than on a
 * guess: cancel wording is `cancelled`, a run that finished without an answer is `ended`, and
 * everything else (a removed session, a stale promise) is `expired`.
 */
const actionClosedReason = (outcome: { ok: boolean; error?: unknown }): 'answered' | 'expired' | 'cancelled' | 'ended' => {
    if (outcome.ok) return 'answered';

    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? '');

    if (/cancel/i.test(message)) return 'cancelled';
    if (/ended/i.test(message)) return 'ended';

    return 'expired';
};

// One unanswered owner question, registered by the host callback that the runtime
// awaits. The store owns the resolver: POST /sessions/:id/actions/:requestId/answer
// settles it exactly once, and cancellation/removal rejects it so the runtime's
// tool call can finish instead of hanging a turn forever.
type PendingAction = {
    requestId: string;
    // R1-R6: the persistent thread whose run asked the question. Stopping or
    // deleting THAT thread expires only its own questions; a sibling lane's
    // question stays answerable.
    threadId?: string;
    // The already-validated request this pending answer belongs to. The answer
    // route re-validates the choice against it, so an option id the model never
    // offered is a 400 rather than an answer the runtime must trust.
    request: HarnessActionRequest;
    // T13: the requesting agent and the instant the question opened. The canonical
    // `PendingAction` row (src/shared/harness-api.ts) states `agent` and `received_at`,
    // and this record is the ONLY place those facts exist while the question is live: the
    // recorded `action_request` event belongs to a turn that may already have moved on.
    agent: string;
    openedAt: number;
    // The handler's own promise settlement (exposed so the store can settle it).
    settle: (outcome: HarnessActionOutcome) => void;
    // Run signal the runtime supplied; an abort expires the pending entry.
    signal: AbortSignal;
    // Bound abort listener, removed on settlement so a completed action leaves no
    // listener on a long-lived signal.
    onAbort: () => void;
    // Guard that makes the settlement idempotent (resolve/reject exactly once).
    settled: boolean;
};

// What settles one pending action: either an accepted choice or a rejection.
type HarnessActionOutcome =
    | { ok: true; choice: HarnessActionChoice }
    | { ok: false; error: Error };

type Emit = (item: SessionStreamItem) => void | Promise<void>;

// One GET /sessions/:id/events subscriber. `emit` never owns a run (a throwing or
// slow watcher must not affect the pump), and `close` is how remove()/dispose()
// ends the stream instead of leaving it open forever. `unsubscribe` is called by
// the route when the client disconnects; it never cancels anything.
type SessionWatcher = {
    emit: Emit;
    close: () => void;
};

// R3: the compact display stream. A view watcher's frames are `SessionViewStreamItem`
// (turn ops / rows / views) and NEVER a raw event, so the browser's default traffic
// carries no step payloads.
type EmitView = (item: SessionViewStreamItem) => void | Promise<void>;

type ViewWatcher = {
    emit: EmitView;
    close: () => void;
};

// R4: how often a RUNNING session may rewrite the whole `state.json`. Every event is
// appended to the journal regardless; the checkpoint exists so a crash between two
// intervals loses at most this many milliseconds of PROGRESS deltas (a tool call,
// commit, start, done or cancellation always checkpoints through the existing
// strict/best-effort calls). 2s is bounded work per turn and far below the old
// per-non-delta-event full-document serialization.
const VIEW_CHECKPOINT_INTERVAL_MS = 2_000;

// One host thread's execution lane (R1-R6). Every thread-capable submit runs in a
// lane (F1); it owns:
//   - its own FIFO backlog (never mixed with the legacy `session.queue`);
//   - at most ONE active turn (the harness serializes inside a thread anyway);
//   - the cancellation state of that run, so stopping THIS thread cannot touch a
//     sibling lane's work.
// Independent lanes execute concurrently; the session-level `busy` gate (legacy
// run or manual tool call) parks every lane's pump, exactly like the legacy queue.
export type ThreadLane = {
    threadId: string;
    queue: SessionTurn[];
    active?: SessionTurn;
    controller?: AbortController;
    pumping: boolean;
    // Set by cancelThread/cancel-all BEFORE aborting: the harness rejects the run
    // with its own abort error, and this flag is what classifies the turn as
    // "cancelled" rather than "error" (there is no session-wide flag for lanes).
    stopRequested: boolean;
    // Progress recorder of the ACTIVE run. Used only as the fallback when the
    // AsyncLocalStorage context is unavailable (a callback the runtime scheduled
    // outside this run's async chain) and exactly one lane is active.
    sink?: (event: HarnessEvent) => Promise<void>;
};

// What ONE run's async context carries: the turn its events belong to, the
// persistent thread, and the recorder that appends/publishes them. The harness's
// progress hook is global, so this is how two concurrent thread runs keep their
// recorded events apart.
type TurnRunContext = {
    session: Session;
    turn: SessionTurn;
    threadId?: string;
    record: (event: HarnessEvent) => Promise<void>;
};

// Extra execution knobs for executeTurn. The legacy `/messages` path passes none
// of this (fresh block, exclusive, response-owned); a queue submit passes the
// persistent thread it was accepted for.
type TurnExecutionOptions = {
    // The persistent thread this turn runs in. Undefined only for a legacy
    // `/messages` turn (the response-owned fresh block).
    threadId?: string;
    // The lane that owns this turn, when it was addressed through a thread lane.
    lane?: ThreadLane;
    // Reset every agent conversation before the run. TRUE only for the legacy
    // `/messages` path, which keeps the historical fresh-block semantics. A host
    // thread is born with an empty transcript, so it never needs a reset (and a
    // reset would destroy the continuation a threaded submit asked for).
    freshBlock?: boolean;
};

// T13: exported for the canonical REST read model (./api-reads.ts), which needs the LIVE
// record to build bounded pages. The name stays internal otherwise; `SessionRecord` is the
// alias the read layer imports so a reader knows it is a live view, never a detached
// snapshot. Nothing outside this package should treat these fields as a wire contract.
export type Session = {
    id: string;
    // The resolved preset THIS session runs. Captured at creation; the registry
    // replacing its entry later does not reach into this object.
    preset: HarnessPreset;
    // Metadata snapshot of the same preset, so a reload can render the frozen
    // configuration without re-resolving anything (which may have changed).
    definition: HarnessDescriptor;
    settings: RunnerSettings;
    harness: Harness;
    status: SessionStatus;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
    // T16: the session's display title (durable, see `HarnessSessionRecord.title`). The contract
    // names the field on a session row and on a session PATCH, so it lives on the record rather
    // than in a process-only map.
    title?: string;
    // T27: the members BOUND AT SESSION SCOPE (`POST /sessions/{id}/agents`) rather than
    // inherited from the harness definition. Membership itself lives in `definition.agents`
    // and `preset.agents` (the session's own frozen copies), so this list carries exactly the
    // one fact those copies cannot state: which rows the contract reports as
    // `origin: "session"` instead of `origin: "definition"`, and therefore which bindings a
    // later `DELETE` may detach again. Durable (`HarnessSessionRecord.sessionAgents`); a
    // session that never bound anything keeps its pre-T27 document shape with the field
    // absent.
    sessionAgents: string[];
    controller?: AbortController;
    // Assigned only while a run is streaming. A progress event with no sink (the
    // harness should not produce one then) is dropped rather than buffered.
    sink?: (event: HarnessEvent) => Promise<void>;
    // Single-flight gate for EVERY operation that mutates this harness: a
    // streaming run, a queue turn, AND a manual tool call. Manual calls are not
    // turns, so they cannot use `status` (`running`/`idle`/`error` is what the UI
    // renders); this private flag is what makes them mutually exclusive with a
    // run, a reset, or a second manual call. It is set synchronously before the
    // first await and released in a `finally`, so no path can leave it stuck.
    busy: boolean;
    cancelled: boolean;
    // Every task the session has run, oldest first. Cleared by reset(), removed
    // with the session. This is server state, never rebuildable from messages.
    // Queued turns are in this list too (status 'queued'), so the record is
    // complete before execution begins.
    turns: SessionTurn[];
    // FIFO backlog submitted through enqueue(). Every entry is also in `turns`
    // with status 'queued'. A turn leaves the queue when the pump starts it or
    // when cancel({ all: true }) drops it. Pending only: the active turn is not
    // here, which is why queueDepth never counts it.
    queue: SessionTurn[];
    // R1-R6: per-thread execution lanes for turns submitted WITH a threadId (or
    // whose thread was addressed later). Created lazily; a lane with no queued and
    // no active turn is kept (cheap) so steering/stop lookups stay simple.
    lanes: Map<string, ThreadLane>;
    // Monotonic turn-index high-water mark. A turn index is assigned once and never
    // reused, so deleting a thread does not renumber surviving turns; a fresh
    // session starts at 0 and reset() starts a new conversation at 0 again.
    turnSequence: number;
    // Conversation-scoped result-label counters AT THE START of each turn, keyed by
    // turn id (shared/agent-results.ts). Deleting a thread removes its entries but
    // never rewrites a survivor's, so surviving labels stay stable.
    labelSeeds: Map<string, Record<string, number>>;
    // Highest occurrence ever minted per two-letter code (tombstone high-water).
    // Survives deletion of every turn carrying a label, so a retired textual label
    // is never re-minted for different content. Only counters are kept — never the
    // content they described.
    //
    // T14: mirrored with `threadLabelHighWater` (see raiseThreadLabelHighWater).
    // Both are views of the ONE canonical per-code label sequence that legacy
    // `/messages` blocks, nested blocks and conversation names all draw from, so a
    // persisted document that lost either map still recovers the ordinals.
    labelHighWater: Map<string, number>;
    // R8: stable agent-prefixed display label of every persistent conversation,
    // keyed by thread id (`RR1`, `IT1`, …). IDs stay opaque runtime values; this is
    // the ONE user-facing conversation name shared by the roster, the turn badge,
    // the root/child block header and a `#` reference. It is allocated once per
    // thread (never per invocation, run or continuation) and persisted.
    threadLabels: Map<string, string>;
    // Highest conversation label ordinal minted per agent code. Kept when a thread
    // is deleted so a retired display name (`RR3`) is never re-minted for another
    // conversation — the same non-reuse rule as `labelHighWater`.
    //
    // T14: the two maps are MIRRORED views of one canonical per-code sequence, not
    // disjoint namespaces. A legacy `/messages` block reserves its ordinal here too
    // (so the first user conversation after three legacy turns is `RR4`), and a
    // conversation name raises `labelHighWater` (so it can never be re-minted as a
    // block label). Allocation reads the HIGHEST of both.
    threadLabelHighWater: Map<string, number>;
    // Invocation id recorded by each THREAD turn's root run, keyed by turn id. The
    // roster exposes it as originInvocationId and it survives a restart.
    turnInvocations: Map<string, string>;
    // T9/T10: the system-instruction TEXT each turn's agents actually ran with, keyed
    // by turn id (one entry per agent). No harness event carries an instruction, so
    // this is the only honest source for the context bar's `system` segment: the store
    // freezes it when a turn starts (and again when a new agent's `start` is recorded),
    // and a later instruction edit cannot move a count that is already recorded.
    //
    // Absent for an agent with no recorded evidence (a legacy document), and the fold
    // then emits NO system segment rather than guessing one from today's catalogue.
    turnInstructionSources: Map<string, TurnInstructionSource[]>;
    // F6: every invocation observed in a persistent conversation, mapped to that
    // thread (invocation id → persistent thread id). A child conversation can run
    // many times; the runtime record keeps only the LATEST invocation id, so this
    // map is what lets deletion purge EVERY persisted agent-result record the
    // runtime removes. Persisted, because a restart must still purge correctly.
    invocationThreads: Map<string, string>;
    // C4: conversations whose stored transcript could NOT be read, keyed by thread
    // id. Populated by tolerant restore (one broken thread cannot drop a whole
    // session) and by a PUT that submits a structurally invalid transcript.
    //
    // The thread itself always stays in the harness with a VALID placeholder
    // transcript, so the roster, the model path and persistence keep working;
    // this map is where the raw, unmodified value lives so the visualiser can show
    // it and the operator can fix it. An entry is dropped as soon as a readable
    // transcript replaces it.
    invalidThreads: Map<string, HarnessInvalidThreadRecord>;
    // True while a LEGACY /messages run owns this harness. Manual calls set `busy`
    // without changing `status`, so the aggregate status needs its own flag to know
    // when a real run is active.
    legacyRunning: boolean;
    // GET /events subscribers. Only remove()/dispose()/unsubscribe detach one.
    watchers: Set<SessionWatcher>;
    // True while the pump loop owns the queue. Set synchronously before the loop
    // awaits, so a concurrent enqueue never starts a second worker.
    pumping: boolean;
    // Pump iterations waiting for the single-flight gate (a manual call or a
    // legacy run holds it). releaseBusy() wakes them; they re-check `busy` and
    // retry the SAME queue head, so FIFO order is never skipped.
    busyWaiters: (() => void)[];
    // waitForIdle() callers, resolved after the drain snapshot is published.
    drainWaiters: (() => void)[];
    // Result-reference waiters (R2). A turn that references a block belonging to
    // a turn that is still queued/running parks here until that turn reaches a
    // terminal status; every settlement path wakes them and they re-check. FIFO
    // means this is normally a no-op (prior turns finish first), but the wait is
    // explicit so a reference can never expand partial/still-streaming content.
    turnWaiters: (() => void)[];
    // enqueue()'s per-turn completion resolvers, keyed by turn id. Resolved when
    // the turn reaches a terminal status or is dropped by cancel-all.
    settlers: Map<string, () => void>;
    // N4: unanswered actionRequest questions from the ACTIVE run, keyed by the
    // runtime-generated requestId. Populated by the interaction handler below and
    // settled by answerAction (POST .../answer) or by cancellation/teardown.
    pendingActions: Map<string, PendingAction>;
    // N4: bounded FIFO of request ids that can no longer be answered (answered,
    // cancelled, expired, or restored after a restart). A late answer for one of
    // these is a 409, not a 404.
    completedActions: string[];
    // Set by remove()/dispose(): the pump stops, pending turns are discarded, and
    // no later frame is published for this session.
    disposed: boolean;
    // Last committed core snapshot (R3b). Refreshed by the state-change observer
    // at every mutation boundary, including inside an active run (core allows a
    // synchronous snapshot there), so a completed tool/store change is durable
    // before the next provider request. A tool that is STILL executing when the
    // process dies has not reached its boundary; that residual is documented and
    // the interrupted turn is never replayed.
    core: HarnessSnapshot;
    // -----------------------------------------------------------------------
    // R1/R3/R4: the compiled DISPLAY surface, maintained AS the run goes.
    //
    // One projector per turn, holding that turn's display tree and row. The recorder
    // folds each stored event through it exactly once (see `executeTurn`), so
    // `getView`/`listViews` read a CACHE instead of re-walking events, and the raw
    // `get()`/`list()` copy of every event is not paid just to build a compact
    // response. A terminal turn is rebuilt from the journal/checkpoint at restore,
    // never lazily per request.
    projections: Map<string, TurnProjector>;
    // `GET /views/:id/events` subscribers. Mirrors `watchers`; a view watcher never
    // sees a raw frame, and a raw watcher never sees a display frame.
    viewWatchers: Set<ViewWatcher>;
    // The per-step durable log for this session (undefined for an in-memory store).
    journal: HarnessJournal | undefined;
    // Journal problems worth telling an operator about: write failures and READ
    // corruption. Surfaced through `journalErrors`, never swallowed silently. A
    // crash-truncated tail is included but flagged as tolerated by the reader.
    journalProblems: string[];
    // Memo for the per-turn result-block projection (labels are the store's). Keyed
    // by turn id; invalidated by the turn's own status/updatedAt/event-count stamp.
    blockCache: Map<string, { stamp: string; blocks: AgentResultBlock[] }>;
    // Last full-document checkpoint for THIS session, so a long run writes the
    // document at a bounded interval instead of once per step (R4).
    checkpointAt: number;
};

// T13: the two aliases the canonical read model imports (./api-reads.ts). A live view,
// never a detached copy: the read layer must not pay a `snapshot()` to answer a page, and
// it must never write through these. `ThreadLaneInfo` exists for the same reason - the
// per-lane backlog is where `queue_depth` and the queue page actually live.
export type SessionRecord = Session;
export type ThreadLaneInfo = ThreadLane;

// What start.ts/runtime.ts hand the store (R3b). `persistence` owns the file,
// `database` is the document already loaded from it. Both are optional: without
// them the store is the previous in-memory implementation. `onPersistenceError`
// is how a background save failure becomes observable (the core observer swallows
// our callback's exceptions, so we never throw from a notification); the default
// logs to stderr and the last message is also exposed as `persistenceError`.
//
// `onRestoreError` is the same injectable-reporter convention for the OTHER
// direction: one saved session this build cannot rebuild (a snapshot naming a
// tool that has since been renamed, a hand-edited record, a stale model map).
// Such a session is DROPPED, never fatal, and the message is reported here —
// the default is stderr and every message is also kept in `restoreErrors`.
export type SessionStoreOptions = {
    persistence?: HarnessPersistence;
    database?: HarnessDatabase;
    onPersistenceError?: (error: Error) => void;
    onRestoreError?: (error: Error) => void;
    // T5 (R1/R3): the RESOLVED server runtime. `threadExecution: 'worker'` makes every turn,
    // manual tool call and slash command run on a lane worker; the default is today's inline
    // behaviour. Deliberately an OPTION on the store rather than a per-session field: the
    // execution model is a deployment property, and a session cannot opt into a promise the
    // process did not make.
    runtime?: ServerRuntimeConfiguration;
    // D4: the IO worker client that owns this store's durable writes. Normally LEFT OUT and
    // created by the constructor when `runtime.ioExecution === 'worker'` (one client per
    // database root). Supplying one is the explicit override: a host that owns the thread's
    // lifecycle injects it, and `inline` + an injected client still means worker semantics,
    // because an injected client IS the write path. In-memory stores (no `persistence`)
    // refuse one: there is nothing off-loop to write.
    io?: HarnessIoClient;
};

// Recovery wording used when a turn was running at save time. The policy is
// "mark interrupted, never replay": the turn keeps its recorded events, the
// session reports an error, and no tool operation is re-executed. A queued
// (never started) backlog is preserved but NOT auto-started; it stays paused
// until an explicit submit starts the pump (FIFO) or cancel({ all: true }) drops it.
const INTERRUPTED_MESSAGE =
    'The previous run was interrupted by a server restart; it was not replayed. Review the recorded events before continuing.';

// An error with an HTTP status, so the request layer can stay a thin mapper.
export class SessionError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'SessionError';
    }
}

// What enqueue() hands its caller. `session`/`turn` are copies (the 202 body);
// `settled` resolves when THIS turn is terminal (or dropped by a cancel-all), so
// tests and tools can await the server's work without polling. The HTTP layer
// ignores it: a submit must never wait for execution.
/**
 * T16: one live change the store announces to the realtime hub (see `SessionStore.setStreamObserver`).
 *
 * Identity only, plus the display ops the recorder already produced. A signal never carries a
 * turn record, a session snapshot, or a view document: the observer rebuilds the one small wire
 * body (a `TurnSummary` row, a `SessionStatePatch`, a `UsagePatch`, a roster row, a transcript
 * signal) from the live record, which keeps a live update's cost proportional to what changed.
 */
export type StoreStreamSignal =
    | { kind: 'turn.upsert'; sessionId: string; turnId: string; at: number }
    | { kind: 'turn.removed'; sessionId: string; turnId: string; at: number }
    | { kind: 'session.state'; sessionId: string; at: number }
    | { kind: 'display.ops'; sessionId: string; turnId: string; ops: TurnDisplayOp[]; at: number }
    | { kind: 'usage.updated'; sessionId: string; turnId: string; at: number }
    | { kind: 'action.opened'; sessionId: string; requestId: string; at: number }
    | {
          kind: 'action.closed';
          sessionId: string;
          requestId: string;
          // Why the question stopped waiting, in the contract's closed vocabulary: answered by an
          // owner, expired with its run, cancelled, or ended when the run finished without one.
          reason: 'answered' | 'expired' | 'cancelled' | 'ended';
          at: number;
      }
    | { kind: 'thread.upsert'; sessionId: string; threadId: string; at: number }
    | { kind: 'thread.removed'; sessionId: string; threadId: string; at: number }
    | { kind: 'transcript.updated'; sessionId: string; threadId: string; at: number };

/** The live-change observer shape installed by the REST owner (./api.ts owns the hub). */
export type StoreStreamObserver = (signal: StoreStreamSignal) => void;

/** The resource-existence question the stream broker asks before it accepts a subscription. */
export type StreamScopeIdView = { session_id?: string; thread_id?: string; turn_id?: string };

export type EnqueuedTask = {
    session: SessionSnapshot;
    turn: SessionTurn;
    settled: Promise<void>;
    // R1-R6: present only when the submit was folded into a RUNNING thread. `turn`
    // is then the turn that owns that run, not a newly queued record.
    steered?: true;
    // The conversation the guidance was delivered to (F3). Disambiguates `turn`
    // when the owning turn belongs to a parent conversation.
    steeredThreadId?: string;
};

// What watch() hands the /events route: the snapshot captured atomically with
// registration, plus the detach function.
export type SessionWatch = {
    snapshot: SessionSnapshot;
    unsubscribe: () => void;
};

// What watchView() hands GET /views/:id/events: the compiled view captured
// atomically with registration, plus the detach function. Same contract as
// `SessionWatch`, compact instead of raw.
export type SessionViewWatch = {
    view: SessionView;
    unsubscribe: () => void;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Copy a transcript for JSON serialization. `HarnessMessage` is plain data, and a
// snapshot must not expose the live arrays the harness keeps mutating.
const copyMessages = (messages: readonly HarnessMessage[]): HarnessMessage[] =>
    messages.map((message) => JSON.parse(JSON.stringify(message)) as HarnessMessage);

// ---------------------------------------------------------------------------
// C4: tolerant transcripts (one unreadable thread must not cost the session)
// ---------------------------------------------------------------------------
//
// A transcript is fully user-editable JSON, so a hand edit CAN break it. The whole
// session is still worth loading, so a thread whose stored `messages` value fails
// `readHarnessMessages` keeps its identity and gets this VALID placeholder in the
// live transcript, while the raw broken value is retained beside it
// (`Session.invalidThreads`, persisted as `HarnessSessionRecord.invalidThreads`).
//
// Why a `system` entry: it is the only role with no structural partners to satisfy
// (no toolCallId pairing, no attachment validation), so the placeholder can never
// itself become the invalid-transcript problem, and a run of the thread still gets
// a readable explanation in the model's context.
const TRANSCRIPT_UNREADABLE_PREFIX = '[transcript unreadable: ';

const unreadableTranscript = (error: string): HarnessMessage[] => [
    { role: 'system', content: `${TRANSCRIPT_UNREADABLE_PREFIX}${error}]` }
];

// True when `messages` IS one of the placeholders above (and therefore still
// unreadable). Tolerant restore uses this to tell "the operator repaired the
// transcript by hand" (the persisted raw entry is now stale) from "this thread is
// still broken" (the raw entry is the ONLY copy of what the user wrote).
//
// Exact-shape on purpose: `[transcript unreadable: …]` is text this package mints
// and nothing else writes, so matching the prefix + single-entry system shape is a
// reliable signal rather than a heuristic over arbitrary user content.
const isUnreadablePlaceholder = (messages: unknown): boolean => {
    if (!Array.isArray(messages) || messages.length !== 1) return false;

    const entry = messages[0] as { role?: unknown; content?: unknown } | null;
    if (entry === null || typeof entry !== 'object') return false;

    return (
        entry.role === 'system' &&
        typeof entry.content === 'string' &&
        entry.content.startsWith(TRANSCRIPT_UNREADABLE_PREFIX) &&
        entry.content.endsWith(']')
    );
};

// C8-m3: the same "still unreadable?" question for a DEFAULT conversation
// (`agent:<name>`). Those ids never appear in `core.threads` — the persisted thread
// list is host-thread ids only (src/core/snapshot.ts readThreads refuses an
// `agent:` id), and the default transcript lives on the AGENT entry
// (`core.agents[name].messages`, see src/harness.ts `setThreadMessages`, which writes
// through to `target.agent.messages`).
//
// Why the store must ask it at all: `updateThreadTranscript` DOES accept a default
// conversation, so a live PUT of an invalid value records the raw text under
// `agent:<name>` and installs the placeholder on the agent. Tolerant restore then
// has no `core.threads` entry to revalidate, and without this branch the persisted
// raw value is dropped on restart while the placeholder is still what the model is
// sent — the conversation silently reads as healthy and the operator's text is gone.
//
// Strictness is unchanged: this only keeps a raw value while the agent transcript IS
// a placeholder this package minted. A hand-edited `core.agents[name].messages` that
// is invalid is refused by `readHarnessSnapshot` during restore (the session is
// dropped) and never reaches this comparison.
const defaultTranscriptStillUnreadable = (
    threadId: string,
    agents: Record<string, { messages?: unknown }> | undefined
): boolean => {
    if (!threadId.startsWith(THREAD_AGENT_PREFIX)) return false;

    const name = threadId.slice(THREAD_AGENT_PREFIX.length);
    if (name.length === 0 || agents === null || typeof agents !== 'object') return false;

    // Own-key: `agent:` + `constructor` must not resolve to the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(agents, name)) return false;

    const entry = agents[name];

    return entry !== null && typeof entry === 'object' && isUnreadablePlaceholder(entry.messages);
};

// Pretty JSON for the editor. `raw` is what the user reads and edits, so a value
// that cannot be stringified (a circular JS object handed to the store directly,
// never over HTTP) must degrade to readable text instead of failing the request,
// and `undefined` degrades to `null` because JSON has no undefined value.
const transcriptRawJson = (value: unknown): string => {
    try {
        return JSON.stringify(value, null, 2) ?? 'null';
    } catch {
        return String(value);
    }
};

// C8-m7: the raw unreadable value must never be SHARED with a caller. It is
// arbitrary user JSON (an object or array is the common case), so storing/returning
// it by reference lets an in-process host — the API layer, a tool, a test — mutate
// server state through the value it was handed, rewriting the operator's broken text
// without a single write going through `updateThreadTranscript`.
//
// A JSON round trip is the same total deep copy `copyEvent`/`copyTurn` use, and the
// value is only ever read back as JSON (`transcriptRawJson`, the persisted document,
// the snapshot projection), so a round trip loses nothing that matters.
//
// Edge case: a value JSON cannot carry (a circular object built in-process, a bare
// `undefined`, a function). Those keep their original reference — they cannot be
// copied, and the readers above already degrade them to readable text instead of
// refusing the request.
const copyInvalidMessages = (value: unknown): unknown => {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
};

// One progress event is plain JSON data (message bodies, tool calls, error info),
// so a round trip is a safe deep copy. Events are copied twice on purpose:
// `turn.events` must not alias the object the harness keeps (or a listener
// mutates), and the emitted frame is a third object so a caller cannot mutate the
// stored record through the stream item either.
const copyEvent = (event: HarnessEvent): HarnessEvent =>
    JSON.parse(JSON.stringify(event)) as HarnessEvent;

// Collect the request ids of every actionRequest recorded in a restored turn
// list, oldest first, keeping only the most recent MAX_COMPLETED_ACTIONS. After a
// restart no runtime is awaiting any of them, so every id is EXPIRED: the answer
// route must answer 409 (the question card is stale), never 404 (unknown) and
// never start a new run. Action answers present in the record do not need special
// handling: the request id is no longer answerable either way.
const expiredActionIds = (turns: readonly SessionTurn[]): string[] => {
    const ids: string[] = [];

    for (const turn of turns) {
        for (const event of turn.events) {
            if (event.type !== 'action_request') continue;

            // Persistence keeps events opaque, so a hand-edited/older record can
            // carry a malformed request. Skip it rather than fail the whole restore:
            // an id we cannot read is simply not answerable.
            const requestId = event.request?.requestId;
            if (typeof requestId !== 'string' || requestId.length === 0) continue;
            if (!ids.includes(requestId)) ids.push(requestId);
        }
    }

    return ids.slice(Math.max(0, ids.length - MAX_COMPLETED_ACTIONS));
};

// A turn copy is the only shape a client ever receives. The live SessionTurn stays
// private to the store; list()/get()/terminal frames all go through here.
// `eventTimes` is copied when present, preserving the parallel array contract, and
// `usage` is copied so a client cannot mutate the running tally it was handed.
// `startedAt` is OMITTED while the turn is queued (the server has not started it),
// so a client sees "not started" instead of a fabricated timestamp; the key order
// for a started turn is unchanged from the pre-queue contract.
const copyTurn = (turn: SessionTurn): SessionTurn => ({
    id: turn.id,
    index: turn.index,
    prompt: turn.prompt,
    // R1-R6: the owning persistent thread, when the turn has one. Absent for a
    // legacy `/messages` turn, preserving that record's exact shape.
    ...(turn.threadId === undefined ? {} : { threadId: turn.threadId }),
    // R8: the conversation's display name travels WITH the turn, so a client can
    // label the root block even for a default conversation the roster omits.
    ...(turn.threadLabel === undefined ? {} : { threadLabel: turn.threadLabel }),
    // Attachments are copied too (T3): the validated record is plain data and a
    // client/snapshot consumer must never be able to mutate the stored bytes. The
    // key stays absent for a text-only turn, preserving every old shape.
    ...(turn.attachments === undefined
        ? {}
        : { attachments: turn.attachments.map((attachment) => ({ ...attachment })) }),
    // Result references (R2) are copied for the same reason: a snapshot consumer
    // must not be able to retarget a stored reference through the response it was
    // handed. Absent when the turn references nothing (exact legacy shape).
    ...(turn.references === undefined || turn.references.length === 0
        ? {}
        : { references: turn.references.map((reference) => ({ ...reference })) }),
    status: turn.status,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    updatedAt: turn.updatedAt,
    events: turn.events.map(copyEvent),
    ...(turn.eventTimes === undefined ? {} : { eventTimes: [...turn.eventTimes] }),
    ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
    // Steered guidance audit (R5). Detached copies for the same reason as the rest:
    // a client must not be able to rewrite the stored record through a response.
    ...(turn.steers === undefined
        ? {}
        : {
              steers: turn.steers.map((steer) => ({
                  // T13 identity, copied like every other field: a response must not be
                  // able to hand back a steer whose segment key differs from the stored
                  // record's, and the fold keys its context segment from it.
                  ...(steer.id === undefined ? {} : { id: steer.id }),
                  at: steer.at,
                  prompt: steer.prompt,
                  ...(steer.threadId === undefined ? {} : { threadId: steer.threadId }),
                  ...(steer.references === undefined
                      ? {}
                      : { references: steer.references.map((reference) => ({ ...reference })) })
              }))
          }),
    // T14: the steer text archive rides with the turn record, because that is what makes a
    // displayed context-bar segment resolvable after the 64-entry audit ring has moved past
    // it — and what makes it disappear correctly when the turn itself is deleted, reset or
    // removed with its conversation. Detached like every other field: a response may not
    // rewrite the stored text.
    ...(turn.steerTexts === undefined
        ? {}
        : {
              steerTexts: turn.steerTexts.map((entry) => ({
                  id: entry.id,
                  at: entry.at,
                  prompt: entry.prompt,
                  ...(entry.threadId === undefined ? {} : { threadId: entry.threadId })
              }))
          })
});

// Fold one request's usage into a turn's running tally.
//
// The SERVER owns this sum (not the browser) so that a reload, a poll, a second
// client and the live stream all show the same figure: a client only ever prints
// what it was handed (SessionTurn.usage / the stream frame's `usage`). Input token
// accounting is cumulative by nature — request n+1 re-sends the whole transcript,
// so its `input` already contains everything earlier requests sent, and adding the
// requests up is what makes `A+B` then `A+B+C` read as the run's spend.
//
// `cached` follows the reported-vs-absent rule of HarnessUsage: a request that
// reports no cache figure contributes nothing and must not turn the whole tally
// into "(0)". Once ANY request in the turn reports one, the tally carries a sum.
const addUsage = (prior: HarnessUsage | undefined, next: HarnessUsage): HarnessUsage => {
    const cachedReported = prior?.cached !== undefined || next.cached !== undefined;

    return {
        input: (prior?.input ?? 0) + next.input,
        output: (prior?.output ?? 0) + next.output,
        total: (prior?.total ?? 0) + next.total,
        ...(cachedReported ? { cached: (prior?.cached ?? 0) + (next.cached ?? 0) } : {})
    };
};

// A descriptor is plain JSON, so a round trip is a safe deep copy. The session
// keeps the original; every snapshot hands out its own copy so a client cannot
// mutate the frozen definition through a response.
const copyDescriptor = (descriptor: HarnessDescriptor): HarnessDescriptor =>
    JSON.parse(JSON.stringify(descriptor)) as HarnessDescriptor;

// A descriptor for the COMPACT surface (T10, R3): the same object minus
// `agentInstructions`, which is per-agent system-prompt TEXT
// (./protocol.ts `HarnessDescriptor.agentInstructions`). Forwarding it in every view
// frame would put the whole system prompt of every member on the default wire — the
// exact payload class R1/R3 removes, and the reason a `/views` client reads instruction
// content from ONE lazy block instead (`TurnBlockDetail.entries` of a `system`
// segment). Members, promotion order, models and the rest are untouched, so every
// existing read of this field keeps working. The RAW surface (`SessionSnapshot`) still
// reports the descriptor VERBATIM — only the display surface trims it.
const viewDescriptorOf = (descriptor: HarnessDescriptor): HarnessDescriptor => {
    const copy = copyDescriptor(descriptor);

    delete copy.agentInstructions;

    return copy;
};

const copyTurns = (turns: readonly SessionTurn[]): SessionTurn[] => turns.map(copyTurn);

// A timestamp is usable only when it is a real epoch-ms number. 0 is the projector's
// documented "no timestamp" sentinel (../server/turn-projector.ts
// DISPLAY_NO_TIMESTAMP), and a record without `eventTimes` must never paint a
// duration — the same honesty rule turns.ts:4778 applies to a recorded replay.
const finiteAt = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

// Terminal turn statuses (./protocol.ts SessionTurnStatus). Kept local so the store,
// the frame mirror and the projector agree on one definition.
const isTerminalTurnStatus = (status: SessionTurn['status']): boolean =>
    status === 'done' || status === 'error' || status === 'cancelled';

// The agent a turn's ROOT run executes as: the owner of the host thread it was
// submitted to, else the harness entry agent (a legacy `/messages` turn and the
// default lane both run the entry agent). Threads never change owner
// (../types/index.ts `HarnessThreadRecord.agent`), so the answer is stable for the
// whole life of the turn — which is what makes it safe to freeze the entry agent's
// instruction source at the turn-start boundary.
const runAgentOf = (session: Session, turn: SessionTurn): string => {
    if (turn.threadId === undefined) return session.definition.primary;

    return session.harness.threads().find((thread) => thread.id === turn.threadId)?.agent ?? session.definition.primary;
};

// An index the record can actually address. A segment keeps the event range it was
// folded from, and a range is only usable while the turn still holds those events —
// outside it the payload field stays ABSENT rather than guessing at content.
const recordedEventAt = (turn: SessionTurn, index: number | undefined): HarnessEvent | undefined => {
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= turn.events.length) return undefined;

    return turn.events[index];
};

// The concatenated `delta` bytes of the recorded events in [from..to] of one kind —
// exactly how a streamed answer or think window was built, so the lazy detail returns
// the same text the projector counted (and never a preview).
const recordedStreamText = (
    turn: SessionTurn,
    type: 'text' | 'reasoning',
    from: number | undefined,
    to: number | undefined
): string | undefined => {
    if (from === undefined || to === undefined) return undefined;
    if (recordedEventAt(turn, from) === undefined || recordedEventAt(turn, to) === undefined) return undefined;

    let text = '';
    let matched = false;

    for (let index = from; index <= to; index += 1) {
        const event = turn.events[index];

        if (event.type !== type || typeof event.delta !== 'string') continue;
        text += event.delta;
        matched = true;
    }

    return matched ? text : undefined;
};

// The EXACT recorded payload of one context segment (../shared/turn-display.ts
// `TurnBlockDetail`). Sourced ONLY from the durable turn record and the recorded
// instruction sources: the events in the segment's own range, the turn's prompt, the
// steer it was minted from. A field is absent when the record holds no such bytes
// (a call with no recorded result), never synthesized.
const blockPayloadOf = (
    turn: SessionTurn,
    agent: string,
    block: ContextBlock,
    sources: readonly TurnInstructionSource[] | undefined
): Pick<TurnBlockDetail, 'text' | 'args' | 'result' | 'entries'> => {
    const payload: Pick<TurnBlockDetail, 'text' | 'args' | 'result' | 'entries'> = {};

    if (block.kind === 'user') {
        if (block.name === 'prompt') {
            if (typeof turn.prompt === 'string') payload.text = turn.prompt;

            return payload;
        }

        // Match the segment's OWN key: an idented submit keys off its durable id
        // (`i${id}`, T13), a submit with no id off its derived `(at, length)` pair, numbered
        // apart from any earlier submit that derives the same pair (./turn-projector.ts
        // `steerBlockKeysOf`). The fold mints from the SAME function, so a clicked segment
        // always resolves to the submit it was drawn from.
        //
        // T14: resolved over the MERGED submit list (archive first, then any ring entry the
        // archive does not name), exactly like `syncSteerBlocks` mints. Searching the
        // 64-entry audit ring alone is what made a 65th steer strand an older segment: the
        // bar kept drawing it while this lookup had no bytes to return.
        const steers = steerSubmitList(
            turn as { steers?: SessionTurn['steers']; steerTexts?: SessionTurn['steerTexts'] }
        );
        const keys = steerBlockKeysOf(steers as { id?: string; at?: number; prompt: string }[]);
        let matched = -1;

        for (let position = 0; position < keys.length; position += 1) {
            const steer = steers[position];

            if (steer === null || typeof steer !== 'object' || typeof steer.prompt !== 'string') continue;
            if (!block.id.endsWith(`-user-${keys[position]}`)) continue;

            matched = position;
            break;
        }

        // LEGACY RECORDS ONLY. A submit that carries an id has a unique key, so a miss above
        // is a real miss and stays an honest absence. Only an id-less ring — where trimming
        // an older colliding submit renumbered the survivors — may fall back to the key
        // WITHOUT its occurrence suffix, and even then it answers with the first submit that
        // still carries that base key.
        const legacyOnly = steers.every((steer) => typeof steer?.id !== 'string' || steer.id.trim().length === 0);

        if (matched === -1 && legacyOnly) {
            const suffix = block.id.slice(block.id.lastIndexOf('-user-') + '-user-'.length);
            const base = suffix.replace(/-\d+$/, '');

            for (let position = 0; position < steers.length; position += 1) {
                const steer = steers[position];

                if (steer === null || typeof steer !== 'object' || typeof steer.prompt !== 'string') continue;
                if (steerBlockKeyOf(steer) !== base) continue;

                matched = position;
                break;
            }
        }

        if (matched !== -1) payload.text = (steers[matched] as { prompt: string }).prompt;

        return payload;
    }

    if (block.kind === 'system') {
        const source = (sources ?? []).find((entry) => entry.agent === agent);

        if (source !== undefined) payload.entries = source.instructions.map((entry) => entry);

        return payload;
    }

    if (block.kind === 'reasoning') {
        const text = recordedStreamText(turn, 'reasoning', block.eventFrom, block.eventTo);

        if (text !== undefined) payload.text = text;

        return payload;
    }

    if (block.kind === 'assistant') {
        const text = recordedStreamText(turn, 'text', block.eventFrom, block.eventTo);

        if (text !== undefined) {
            payload.text = text;

            return payload;
        }

        // The `done` fallback segment (no streamed deltas): its bytes live on the
        // recorded response message, and only there.
        const opening = recordedEventAt(turn, block.eventFrom);

        if (opening?.type === 'done' && typeof opening.message?.content === 'string') payload.text = opening.message.content;

        return payload;
    }

    // `tool`: the recorded arguments string and the recorded result text, from the two
    // events the segment names. A call that never settled has NO result bytes, and a
    // result-only segment has no call — both report exactly what exists.
    const opening = recordedEventAt(turn, block.eventFrom);
    const closing = recordedEventAt(turn, block.eventTo);

    if (opening?.type === 'tool_call' && typeof opening.call?.arguments === 'string') payload.args = opening.call.arguments;

    const resultEvent = opening?.type === 'tool_result' ? opening : closing?.type === 'tool_result' ? closing : undefined;

    if (resultEvent !== undefined && typeof resultEvent.content === 'string') payload.result = resultEvent.content;

    return payload;
};

// Roster WITHOUT the transcript. `SessionThread.messages` is the committed harness
// transcript — every assistant text and every tool result verbatim (a tool result is
// capped only at 64 KiB, ../core/result-budget.ts:42) — so shipping it in every view
// frame is precisely the payload class R1 removes. Identity plus a bounded preview is
// what a strip, a badge and a focus resolution need; the transcript itself is one
// lazy route away (GET /views/:id/threads/:threadId/transcript), which is exactly the
// moment the UI has opened a transcript surface.
const threadViewsOf = (threads: readonly SessionThread[]): SessionThreadView[] =>
    threads.map((thread): SessionThreadView => {
        const last = thread.messages[thread.messages.length - 1];
        const raw = (last as { content?: unknown } | undefined)?.content;

        return {
            id: thread.id,
            agent: thread.agent,
            origin: thread.origin,
            status: thread.status,
            sequence: thread.sequence,
            ...(thread.ownerThreadId === undefined ? {} : { ownerThreadId: thread.ownerThreadId }),
            ...(thread.label === undefined ? {} : { label: thread.label }),
            ...(thread.invocationId === undefined ? {} : { invocationId: thread.invocationId }),
            ...(thread.originTurnId === undefined ? {} : { originTurnId: thread.originTurnId }),
            ...(thread.originInvocationId === undefined ? {} : { originInvocationId: thread.originInvocationId }),
            ...(thread.invocationIds === undefined ? {} : { invocationIds: [...thread.invocationIds] }),
            ...(thread.references === undefined || thread.references.length === 0
                ? {}
                : { references: thread.references.map((reference) => ({ ...reference })) }),
            ...(thread.connectedThreadIds === undefined || thread.connectedThreadIds.length === 0
                ? {}
                : { connectedThreadIds: [...thread.connectedThreadIds] }),
            messageCount: thread.messages.length,
            ...(typeof raw === 'string' && raw.length > 0
                ? { preview: raw.length > 240 ? `${raw.slice(0, 239).trimEnd()}\u2026` : raw }
                : {}),
            hasTranscript: thread.messages.length > 0
        };
    });

// Trim + bound a task input. Shared by the legacy run() and the queue enqueue()
// so the two submit surfaces cannot disagree about what a valid task is. Throws
// BEFORE any mutation, which is what makes a rejected submit safe to retry.
//
// An empty/whitespace prompt is allowed ONLY when the turn carries attachments
// (T3): an image dropped without text is a real task. The 200k text cap is
// unchanged for either shape.
const validateInput = (rawInput: string, attachmentCount: number): string => {
    const input = rawInput.trim();

    if (input.length === 0 && attachmentCount === 0) {
        throw new SessionError(400, 'A task cannot be empty.');
    }

    if (input.length > MAX_INPUT_LENGTH) {
        throw new SessionError(413, `A task cannot exceed ${MAX_INPUT_LENGTH} characters.`);
    }

    return input;
};

// ---------------------------------------------------------------------------
// SERVER-SIDE SLASH COMMANDS (dispatch / executeCommandTurn)
// ---------------------------------------------------------------------------

// The synthesized `tool_call`/`tool_result` name for one command turn. "command" is
// not a registered TOOL: it is the transcript's label for "the server ran a slash
// line". A real tool would have to be declared to the model to take this name, and
// a command never reaches the model, so the two cannot collide.
const COMMAND_TOOL_NAME = 'command';

// Rejections for the two submit payloads a command line cannot express. Commands
// take ONE contract (a slash line) and silently dropping a clipped image or a
// referenced result block would answer "it worked" while losing user work.
const COMMAND_ATTACHMENT_MESSAGE = 'A slash command cannot carry attachments.';
const COMMAND_REFERENCE_MESSAGE = 'A slash command cannot carry result references.';

// "How many submitted entries are present", for the command rejections and for the
// shared empty-prompt rule. Deliberately total over unvalidated JSON: `undefined`
// and `null` are absent, an array answers its length, and ANY other value the
// dispatcher could not have produced (a bare object, a string) counts as one, so a
// malformed payload is rejected instead of being read as "nothing was submitted".
const submittedCount = (value: unknown): number => {
    if (value === undefined || value === null) return 0;
    if (Array.isArray(value)) return value.length;

    return 1;
};

// The agent a command turn's synthesized events are attributed to, and the model the
// `start` frame reports. Both MUST equal what `snapshot()` already publishes
// (`agentModels[primary]` / `model`), otherwise a live tile and a reloaded tile
// disagree about the same turn. A host handle without the entry-agent member falls
// back to the frozen descriptor and the session model, so these are never empty.
const commandAgentOf = (session: Session): string => {
    const harness = session.harness as Partial<Harness>;
    const name = typeof harness.name === 'string' && harness.name.length > 0
        ? harness.name
        : session.definition.primary;

    // `name` and `definition.primary` are the SAME string for every preset built by
    // the registry (HarnessPreset.primary is the entry agent), so the fallback only
    // fires for a hand-built handle; the agent-name guard then keeps the frontend's
    // primary/subagent colouring exact instead of colouring a command as a subagent.
    return name;
};

const commandModelOf = (session: Session): string => {
    const harness = session.harness as Partial<Harness>;
    const model = typeof harness.agent?.model === 'function' ? harness.agent.model() : '';

    return model.length > 0 ? model : session.settings.model;
};

// HTTP status for a rejected attachment. The shared validator throws plain
// Errors with descriptive messages; map them onto the three honest HTTP answers
// so a bad clip is never an opaque 500:
//   - 413: any per-attachment/per-turn byte bound was exceeded;
//   - 415: a media type, kind/marker agreement, or magic-signature mismatch;
//   - 400: any other structural problem (missing field, duplicate id, bad base64).
// The match is intentionally narrow; unknown validator wording falls back to 400,
// which is still a clear client error.
const ATTACHMENT_TOO_LARGE = /(?:exceeds|above) the .*byte|byte (?:attachment|per-turn) limit/i;
const ATTACHMENT_MEDIA_TYPE =
    /\.mime\b|magic signature|does not match its declared MIME|not valid for kind/i;

const attachmentErrorStatus = (message: string): number => {
    if (ATTACHMENT_TOO_LARGE.test(message)) return 413;
    if (ATTACHMENT_MEDIA_TYPE.test(message)) return 415;
    return 400;
};

// Validate one submit's attachments and return detached copies. Exported so the
// HTTP dispatcher can pre-validate BEFORE it opens an SSE response (the legacy
// /messages route): a malformed clip must answer a real 400/413/415 JSON body,
// not a failed frame on an already-started stream. The store calls this again on
// every submit, so no path can reach a turn with unvalidated media.
export const validateAttachmentsForSubmit = (value: unknown): HarnessAttachment[] => {
    try {
        return validateAttachments(value);
    } catch (error) {
        const message = messageOf(error);
        throw new SessionError(attachmentErrorStatus(message), message);
    }
};

export class SessionStore {
    private readonly sessions = new Map<string, Session>();

    // Per-run async context (R1-R6). One harness has one progress callback, so
    // this is what attributes a concurrent thread run's events (and the background
    // deliveries it schedules) to the right SessionTurn. See buildHarness/progress.
    private readonly runContexts = new AsyncLocalStorage<TurnRunContext>();

    // Durable layer, when the host supplied a database root. All writes are
    // synchronous (whole-document atomic replace), so they are serialized without
    // a queue: no two saves can interleave in this process.
    private readonly persistence: HarnessPersistence | undefined;
    private readonly onPersistenceError: ((error: Error) => void) | undefined;
    // Per-session restore reporter (see SessionStoreOptions.onRestoreError).
    private readonly onRestoreError: ((error: Error) => void) | undefined;
    // Every saved session this load dropped, in document order, as the full
    // diagnostic message (file path + session id + the underlying reason). Kept
    // because a dropped session must stay explainable after it stops being
    // addressable: the store no longer holds it, so this is the only record.
    private readonly restoreFailures: string[] = [];
    // Last background save failure. Exposed so a caller/test can observe a write
    // error that must not change a run's outcome (the core observer swallows it).
    private lastPersistenceError: string | undefined;
    // R4: aggregate journal diagnostics — write failures and READ corruption for any
    // session, kept after a session is removed (see the `journalErrors` getter).
    private readonly journalFailures: string[] = [];
    // True while the constructor replays a document: the restored harness emits
    // `restore` state changes, and writing the file back mid-load would be a
    // pointless (and possibly partial) round trip.
    // T5 (R1): the resolved runtime, and the lane machinery it may switch on.
    //
    // `runtime` is kept as ONE object (not scattered flags) because every value in it is a
    // deployment promise that must be reported, not inferred. `host` and `authorities` are
    // created LAZILY: an inline store never touches `node:worker_threads`, and a worker store
    // with no running session spawns nothing.
    private readonly runtime: ServerRuntimeConfiguration;
    // T16: the operator's saved global provider defaults (credential-free; see
    // `HarnessGlobalSettingsRecord`). `undefined` means "the shipped environment defaults".
    private global: HarnessGlobalSettingsRecord | undefined;

    private host?: LaneHost;

    // D4 (R1/R2/R4): the IO worker client that performs this store's checkpoint and journal
    // WRITES when `runtime.ioExecution === 'worker'`. One client per database root, opened in
    // the constructor. `undefined` means inline writes - the historical path, byte-identical
    // and still the default.
    //
    // The authority does NOT move with it: the store still decides what the next document and
    // the next journal line are, and in what order (./workers/io-client.ts). What moves off
    // this thread is the serialization and the syscalls.
    private readonly io: HarnessIoClient | undefined;

    // Cached so `drainIo()` is idempotent: `dispose()` fires the close and a host that also
    // awaits it (start.ts / the service shutdown) gets the SAME summary, never a second close.
    private ioClosing: Promise<IoCloseSummary> | undefined;

    // One authority per session id. Rebuilt whenever the session's harness object is replaced
    // (a restore, a reset), because the authority's ledgers are counters over THAT harness.
    private readonly authorities = new Map<string, LaneAuthority>();

    // The memory keys each session's tools may reach, computed from the captured tool sources
    // (./workers/capability.ts) and keyed on the registry's CONTENT FINGERPRINT, so a replaced
    // or created tool revision refreshes it instead of keeping the window captured at session
    // build. Absent means "not computed yet"; a stale fingerprint means "recompute".
    private readonly memoryKeys = new Map<string, { fingerprint: string; keys: string[] }>();

    private loading = false;
    // Shutdown guards (T13 / P1-B). `closing` is set by dispose() AFTER the one
    // graceful save and BEFORE any session is aborted or the map is cleared;
    // `closed` is permanent and set once the map is empty. Both block every
    // background save, and persistOrThrow refuses outright: after the map was
    // cleared a write would serialize `sessions: []` over the good document —
    // exactly the data loss reproduced by Temp/T10/probe-dispose.ts.
    private closing = false;
    private closed = false;

    // True once dispose() started tearing the store down. Every writer checks it,
    // because a store with an empty map must never be the source of a save.
    private get shuttingDown(): boolean {
        return this.closing || this.closed;
    }

    // `registry` defaults to a fresh in-memory registry over the shipped presets.
    // It is injectable so tests can run scripted harnesses (including subagents and
    // failures) without reaching a provider, and so the host can share ONE registry
    // with the API. `describe` captures host-specific availability (search) in
    // the frozen snapshot: the store owns no catalogue, so production injects a
    // describer bound to the runtime catalogue.
    //
    // `options.database` (R3b) is already-validated session state; the registry it
    // refers to must be the SAME one the caller restored from that document.
    constructor(
        readonly defaults: RunnerSettings,
        private readonly registry: HarnessRegistry = createHarnessRegistry(),
        private readonly describe: (preset: HarnessPreset) => HarnessDescriptor = describeHarness,
        options: SessionStoreOptions = {}
    ) {
        this.persistence = options.persistence;
        this.onPersistenceError = options.onPersistenceError;
        this.onRestoreError = options.onRestoreError;

        // T16: the operator's saved GLOBAL provider defaults (base URL + model). Read straight
        // from the document the host already loaded, so a `PATCH /config` survives a restart
        // instead of silently reverting to the environment. The credential is never in here.
        this.global = options.database?.globalSettings;

        // R3: the runtime is already validated (./config.ts resolveRuntimeConfiguration), and
        // ./runtime.ts asserted readiness BEFORE constructing this store. A missing option is
        // inline: the historical behaviour, never a downgrade of an explicit request.
        this.runtime = options.runtime ?? DEFAULT_RUNTIME_CONFIGURATION;

        // D4: open the IO worker when the deployment asked for off-loop durability. This is
        // SYNCHRONOUS on purpose - `new SessionStore(...)` and `createHarnessRuntime` are sync
        // (./runtime.ts:107) - and the client therefore holds every write issued before the
        // handshake instead of dropping it. Whoever may block awaits `ioReady()` before it
        // serves (./start.ts, ./service.ts).
        //
        // Rules this constructor enforces, all of them LOUD:
        //   - `persistence === undefined` (an in-memory store) never opens a thread;
        //   - `ioExecution: 'inline'` never opens one either, unless a client was injected;
        //   - a missing entry, a host without `node:worker_threads`, or a protocol mismatch
        //     THROWS `HarnessIoError` out of the constructor and aborts startup. There is no
        //     inline fallback here, because a store that quietly went back to blocking the
        //     event loop would make the deployment's promise a lie.
        this.io =
            options.io ??
            (this.persistence === undefined || this.runtime.ioExecution !== 'worker'
                ? undefined
                : openHarnessIoClient({
                      // The client commits exactly the file `HarnessPersistence` reads, so a
                      // worker-written database is loadable by the inline reader (and vice
                      // versa) - ./workers/io-worker-loop.ts calls the same primitives.
                      persistence: this.persistence,
                      ...(this.runtime.ioEntry === undefined ? {} : { entry: this.runtime.ioEntry }),
                      // Worker-mode twin of `persistence.lastWriteError` -> the store's sticky
                      // error and reporter. It fires only for a QUEUED save: a strict save
                      // rejects, and `persistOrThrow` reports that itself (one failure, once).
                      onCheckpointError: (error) => this.notePersistenceError(error),
                      // Worker-mode twin of `journal.error`. It arrives with only a session id,
                      // because the reply lands after the call returned - the kinds the store
                      // CAN name (open/append/rewrite) are reported synchronously from
                      // `journalError(id)` at their own call sites, with the inline prefixes.
                      onJournalError: (sessionId, message) => this.noteWorkerJournalError(sessionId, message)
                  }));

        if (options.database !== undefined) {
            this.loading = true;

            try {
                // R6: restore is best-effort PER SESSION. One unusable record (a
                // snapshot that names a tool this build renamed, a queue that
                // points at a turn that is gone, a model map naming a retired
                // agent) must not take the store, the API, or every healthy
                // session down with it — before this loop, it did: the throw
                // escaped the constructor, so createHarnessRuntime/
                // startHarnessServer aborted and the UI reported "server
                // unavailable" with no way to start a new session.
                //
                // Document-level problems (unreadable file, malformed JSON,
                // unknown database version, bad record shape) are still hard
                // failures: they happen in HarnessPersistence.load() BEFORE this
                // loop, and an unparseable document says nothing trustworthy
                // about any session in it.
                for (const record of options.database.sessions) {
                    try {
                        this.restoreSession(record);
                    } catch (error) {
                        this.noteRestoreError(error);
                    }
                }
            } finally {
                this.loading = false;
            }
        }
    }

    // Last failed background write, or undefined after a successful save. A
    // structural mutation THROWS instead (the request must fail); this field is
    // for the turn-transition path, which must not fail a completed run.
    get persistenceError(): string | undefined {
        return this.lastPersistenceError;
    }

    // R4: every event-journal problem this store observed, in first-seen order —
    // append/rewrite/open failures AND read-side corruption (a truncated tail is
    // included and labelled as tolerated). The journal is best-effort for a RUNNING
    // turn (a full disk must not change its outcome), which is exactly why the
    // failures have to be collectible rather than swallowed: the runtime host and the
    // tests read this.
    get journalErrors(): readonly string[] {
        return this.journalFailures;
    }

    // D4: the IO client this store opened (`undefined` = inline writes). A host reads its
    // `stats()`/`lastError()` the way it reads `persistenceError`: the off-loop cost and the
    // last failed commit are deployment facts, not internals.
    get ioWorker(): HarnessIoClient | undefined {
        return this.io;
    }

    // True when THIS store's writes go through the IO worker. Reported rather than inferred,
    // so a health payload can state where durability actually runs.
    get workerIoExecution(): boolean {
        return this.io !== undefined;
    }

    // D4: readiness of the IO worker, or `undefined` when there is nothing to wait for
    // (inline durability / in-memory store). A worker-mode host awaits this BEFORE its first
    // response: it rejects - the thread already terminated - on no worker support, a missing
    // entry, a thread that failed to start, a handshake timeout, or a protocol mismatch.
    //
    // It is the memoized handshake promise, so awaiting it per request (the service host has
    // no separate startup) costs one microtask after the first resolution.
    ioReady(): Promise<void> | undefined {
        return this.io?.ready();
    }

    // D4: graceful durability shutdown (integration contract 7).
    //
    // `dispose()` has already queued the final document; the client's `close()` flushes the
    // coalesced slot, drains everything posted before its `shutdown` frame, and reports the
    // append handles the worker fenced. Idempotent: `dispose()` fires this and a host that
    // also awaits it receives the SAME summary.
    //
    // A non-empty `summary.failures` means those writes are NOT known durable. They are
    // reported through `notePersistenceError` (never thrown: a dispose path cannot act on a
    // failed write, but it must be able to SAY so), and the caller keeps the summary.
    async drainIo(reason = 'store shutdown'): Promise<IoCloseSummary | undefined> {
        if (this.io === undefined) return undefined;

        if (this.ioClosing === undefined) {
            this.ioClosing = this.io.close(reason).then((summary) => {
                for (const failure of summary.failures) {
                    // The sticky error ends up naming the LAST failure, the same way
                    // `persistence.lastWriteError` reports one raw failure. Every failure is
                    // still visible because each line is its own reported error.
                    this.notePersistenceError(new Error(`An IO worker write did not complete: ${failure.kind}: ${failure.message}`));
                }

                return summary;
            });
        }

        return this.ioClosing;
    }

    // Sessions this load dropped, document order, each as the exact diagnostic
    // that was reported (see noteRestoreError). Empty for an in-memory store and
    // for a document whose every session rebuilt successfully.
    get restoreErrors(): readonly string[] {
        return this.restoreFailures;
    }

    get size(): number {
        return this.sessions.size;
    }

    // -----------------------------------------------------------------------
    // T13: bounded reads for the canonical REST surface (./api-reads.ts).
    //
    // These hand out the LIVE record, never a `snapshot()`. `get()`/`list()` deep-copy
    // every turn, every event, the transcripts, and the core snapshot - which is exactly
    // the multi-megabyte boot cost the target contract removes. A REST page instead reads
    // counters (`turns.length`), the per-turn projection cache, and the harness thread
    // RECORDS, so its cost is the page size and nothing else. Read-only by contract: the
    // read layer never writes through these.
    // -----------------------------------------------------------------------

    /** The live record of one session. Unknown id answers 404, exactly like `get()`. */
    liveSession(id: string): SessionRecord {
        return this.require(id);
    }

    /** Every live record, insertion order. Identity and counters only - no turn is copied. */
    liveSessions(): SessionRecord[] {
        return [...this.sessions.values()];
    }

    /** The live record when it exists, without throwing (for reads that answer 404 themselves). */
    peekSession(id: string): SessionRecord | undefined {
        return this.sessions.get(id);
    }

    /**
     * The display projector of one turn: the SAME cached instance the recorder folds every
     * stored event through, so `summary()`/`display()` are cache reads. A turn the store
     * has never projected (a restored document) is folded here once and cached, which is
     * the only case where a request pays for a fold at all.
     */
    turnProjector(id: string, turnId: string): TurnProjector | undefined {
        const session = this.require(id);

        return this.peekTurnProjector(session, turnId);
    }

    /** Projector lookup against a record already in hand (no second id resolution). */
    peekTurnProjector(session: SessionRecord, turnId: string): TurnProjector | undefined {
        const turn = session.turns.find((candidate) => candidate.id === turnId);

        if (turn === undefined) return undefined;

        return this.projectorFor(session, turn);
    }

    /** The live turn record (not copied) for count and ordinal reads. */
    peekTurn(session: SessionRecord, turnId: string): SessionTurn | undefined {
        return session.turns.find((candidate) => candidate.id === turnId);
    }

    /**
     * T16: the stream broker's existence question (`src/server/stream/mount.ts` calls this
     * through `StreamStoreLookups.streamExists`), answered from the live maps.
     *
     * WHY THE STORE OWNS IT: `unknown_resource` is a claim about the server's data, so the
     * component that holds the data answers it. The bridge previously accepted any id because no
     * lookup existed; with this one a subscription to a conversation, turn, or session that is
     * not there is refused honestly.
     *
     * WHY IT IS CHEAP: every branch is a map lookup or an id scan of a bounded list, and nothing
     * here builds a snapshot, folds a projection, or copies a record. The composite hub key
     * (`session:turn`, `session:thread`) and the plain subscription ids are both accepted, so the
     * counter key and the existence question address the same instance.
     */
    streamExists(
        resource: StreamResourceKind,
        id: string | null,
        ids: StreamScopeIdView = {}
    ): boolean {
        // Host-wide kinds have no instance to look up: the registry/catalogue owns them, and a
        // subscription to the collection is always addressable.
        if (id === null) return true;

        if (resource === 'harnesses' || resource === 'agents' || resource === 'tools' || resource === 'config') {
            return true;
        }

        if (resource === 'turn' || resource === 'turn_display' || resource === 'turn_events') {
            const [sessionId, turnId] = splitStreamKey(id, ids.session_id);

            return this.hasTurn(sessionId, turnId);
        }

        if (resource === 'thread' || resource === 'transcript' || resource === 'transcript_messages') {
            const [sessionId, threadId] = splitStreamKey(id, ids.session_id);

            return this.hasThread(sessionId, threadId);
        }

        return this.hasSession(id);
    }

    /** Cheap session existence check (no snapshot, no copy). */
    hasSession(id: string | undefined): boolean {
        return id !== undefined && this.sessions.has(id);
    }

    /** Cheap conversation existence check, including a conversation that is only an unreadable transcript. */
    hasThread(sessionId: string | undefined, threadId: string | undefined): boolean {
        if (sessionId === undefined || threadId === undefined) return false;

        const session = this.sessions.get(sessionId);

        if (session === undefined) return false;
        if (session.invalidThreads.has(threadId)) return true;

        return this.threadsSupported(session) && session.harness.thread(threadId) !== undefined;
    }

    /** Cheap turn existence check. */
    hasTurn(sessionId: string | undefined, turnId: string | undefined): boolean {
        if (sessionId === undefined || turnId === undefined) return false;

        const session = this.sessions.get(sessionId);

        return session !== undefined && session.turns.some((turn) => turn.id === turnId);
    }

    // -----------------------------------------------------------------------
    // T16: the durable fields the canonical contract names
    // -----------------------------------------------------------------------

    /**
     * Rename a session (`PATCH /sessions/{id}` with `title`), durably: the document carrying the
     * new title is written BEFORE the caller answers, which is the store's rule for every
     * structural mutation. `null` (or blank) clears the title. The in-memory store has no
     * persistence, so the same call is a plain state change there - the shape of the answer does
     * not differ between the two modes.
     */
    async renameSession(id: string, title: string | null): Promise<SessionRecord> {
        const session = this.require(id);

        if (title === null) delete session.title;
        else {
            // Bound here rather than in the dispatcher: the field is user text, and the store is
            // the component that decides what its document may hold.
            const trimmed = title.trim();

            if (trimmed.length === 0) delete session.title;
            else session.title = trimmed.slice(0, 200);
        }

        session.updatedAt = Date.now();

        await this.persistOrThrow();

        return session;
    }

    /**
     * The operator's saved global provider defaults, or `undefined` when the deployment has never
     * changed them. Credential-free by construction: `state.json` holds no api key, so a key set
     * over HTTP is PROCESS-ONLY and a restart falls back to the environment (the route says so).
     */
    get globalSettings(): HarnessGlobalSettingsRecord | undefined {
        return this.global;
    }

    /**
     * Change the global defaults (`PATCH /config`) and make the change durable BEFORE the answer.
     * A `null` value resets that field to the shipped default, which is what the contract's
     * `null`-means-reset rule requires, so the reset target survives a restart too.
     */
    async updateGlobalSettings(settings: {
        baseURL?: string | null;
        model?: string | null;
    }): Promise<HarnessGlobalSettingsRecord | undefined> {
        const current: Partial<HarnessGlobalSettingsRecord> = { ...(this.global ?? {}) };

        if (settings.baseURL !== undefined) {
            if (settings.baseURL === null) delete current.baseURL;
            else current.baseURL = settings.baseURL;
        }

        if (settings.model !== undefined) {
            if (settings.model === null) delete current.model;
            else current.model = settings.model;
        }

        this.global = Object.keys(current).length === 0 ? undefined : (current as HarnessGlobalSettingsRecord);

        await this.persistOrThrow();

        return this.global;
    }

    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    async create(presetName: string, input?: Partial<RunnerSettings>): Promise<SessionSnapshot> {
        // Alias-aware: `writer`/`assistant` resolve to `instruct` and
        // `researcher` to `research`, so an older client keeps working. The
        // snapshot reports the canonical preset name below. Resolution consults
        // the live registry, so a harness created through POST /harnesses is
        // runnable by name exactly like a built-in.
        const preset = this.registry.find(presetName);
        if (!preset) {
            throw new SessionError(404, `Unknown harness "${presetName}".`);
        }

        // mergeSettings enforces the credential rule: a blank client key means
        // "server key" ONLY for the configured provider's origin+base path, so a
        // foreign base URL creates an unauthenticated session instead of leaking
        // the server credential.
        const settings = mergeSettings(this.defaults, input);

        if (preset.requiresEndpoint && settings.baseURL.length === 0) {
            throw new SessionError(400, `Harness "${presetName}" needs a provider base URL.`);
        }

        let session: Session | undefined;

        // The sink and the persistence observer close over `session`, which is
        // assigned immediately after the harness is built. Construction never
        // reports progress or state changes.
        // T5 (R3): a session whose harness a worker could not rebuild is REFUSED at creation,
        // with the reason and the fix. Worker mode is never approximated by running that
        // session inline (./workers/capability.ts states why).
        this.assertWorkerCapable(preset);

        let harness: Harness;
        try {
            harness = this.buildHarness(preset, settings, () => session);
        } catch (error) {
            // T27: a build failure that ALREADY carries an HTTP status is propagated, not
            // re-numbered. The case that matters is a retired agent profile: `agent-state`
            // decides `AgentStateError(409, "…retired…cannot select it")` because the
            // refusal is a deployment decision, not a malformed request, and this catch used
            // to turn it into a 400 with the same text. A client that branches on 409 (the
            // profile is unusable here, so offer another) was told its body was wrong.
            //
            // The rule is by capability, not by class name: anything that states a status
            // (`AgentStateError`, `HarnessRegistryError`, a `SessionError` from deeper in the
            // build) keeps its own status and message, and only a statusless throw — a real
            // configuration bug in the preset factory — becomes the 400 receipt.
            const status = (error as { status?: unknown } | undefined)?.status;

            if (typeof status === 'number' && status >= 400) throw error;

            throw new SessionError(400, `Could not build harness "${presetName}": ${messageOf(error)}`);
        }

        const now = Date.now();
        session = {
            id: randomUUID(),
            preset,
            // Frozen metadata for this session. Built once, from the preset the
            // harness above was constructed from, so the pair can never disagree.
            definition: this.describe(preset),
            settings,
            harness,
            status: 'idle',
            createdAt: now,
            updatedAt: now,
            busy: false,
            cancelled: false,
            turns: [],
            queue: [],
            lanes: new Map(),
            turnSequence: 0,
            labelSeeds: new Map(),
            labelHighWater: new Map(),
            threadLabels: new Map(),
            threadLabelHighWater: new Map(),
            turnInvocations: new Map(),
            // T9/T10: nothing has run yet, so no instruction source exists yet.
            turnInstructionSources: new Map(),
            invocationThreads: new Map(),
            // C4: a fresh session has no unreadable transcript by construction.
            invalidThreads: new Map(),
            // T27: a fresh session has exactly the members its definition shipped with.
            sessionAgents: [],
            legacyRunning: false,
            watchers: new Set(),
            pumping: false,
            busyWaiters: [],
            drainWaiters: [],
            turnWaiters: [],
            settlers: new Map(),
            pendingActions: new Map(),
            completedActions: [],
            disposed: false,
            // R1/R3/R4: compiled display state, its observers, and the durable log.
            // A fresh session has no turns, so every map starts empty; the journal is
            // attached lazily (an in-memory store never creates one).
            projections: new Map(),
            viewWatchers: new Set(),
            journal: undefined,
            journalProblems: [],
            blockCache: new Map(),
            checkpointAt: Date.now(),
            // An empty session is a valid commit point: snapshot() succeeds here.
            core: harness.snapshot()
        };

        this.sessions.set(session.id, session);

        // Write-through: the 201 must not report a session the next restart has
        // forgotten. A failed write rolls the in-memory entry back so a retry
        // cannot observe a session that was never durable.
        try {
            await this.persistOrThrow();
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }

        return this.snapshot(session);
    }

    // Build one harness with the store's two host hooks attached: progress goes to
    // whichever turn is currently streaming, and every core state change becomes a
    // durable save. The callbacks read `session` lazily because the harness is
    // constructed before the session object exists.
    private buildHarness(
        preset: HarnessPreset,
        settings: RunnerSettings,
        current: () => Session | undefined
    ): Harness {
        // Progress routing (R1-R6). The runtime has ONE progress hook per harness,
        // so two concurrent root thread runs would otherwise be indistinguishable
        // (a root event carries no `thread` metadata). The run that emitted this
        // event is the AsyncLocalStorage store set around its `sendThreadInput`
        // call; when no store is visible (a callback the runtime scheduled outside
        // that async chain) fall back to the session's single active recorder.
        const progress = (event: HarnessEvent) => {
            const session = current();
            if (session === undefined) return;

            const scoped = this.runContexts.getStore();

            if (scoped !== undefined && scoped.session === session) return scoped.record(event);

            return this.fallbackRecorder(session)?.(event);
        };

        const stateChange = (event: HarnessStateChangeEvent): void => {
            const session = current();
            if (session !== undefined) this.noteStateChange(session, event);
        };

        // N4: the ONE host answerer every session gets. The closure resolves the
        // session lazily (the harness is constructed before the Session object
        // exists) and registers the promise in that session's pending map. The
        // runtime supplies the requestId/callId, awaits this promise, and emits
        // action_request/action_answer itself; the server only brokers the answer.
        //
        // Passing it on EVERY build (restored and fresh, every preset) is what
        // keeps owner questions available in the main UI instead of only in a
        // hand-picked preset. `autoAnswer` is deliberately left unset: a server
        // host always has an answerer, and this store never picks an option on the
        // user's behalf.
        const interaction: HarnessInteractionConfiguration = {
            actionRequest: (context, signal) => {
                const session = current();

                if (session === undefined) {
                    return Promise.reject(new Error(ACTION_SESSION_GONE_MESSAGE));
                }

                return this.registerActionRequest(session, context, signal);
            }
        };

        return preset.create(settings, progress, { stateChange, interaction });
    }

    // -----------------------------------------------------------------------
    // T5 (R1): lane-worker execution
    // -----------------------------------------------------------------------
    //
    // WHY THESE HELPERS EXIST AS A GROUP
    // ---------------------------------
    // Worker mode changes exactly ONE thing about a session: where a harness body executes.
    // Everything else - the recorder, the journal, the projector, the persistence, the SSE
    // fan-out, the busy gate, the cancellation classification - is the inline code path
    // running against the CANONICAL harness, which the lane's commits keep up to date. So the
    // branch below is always "same turn, different CPU", never a second implementation.
    //
    // Nothing here may fall back to inline silently: `threadExecution: 'worker'` is a
    // deployment promise, so a lane that cannot be created, or a session whose harness a
    // worker could not rebuild, is reported (ServerRuntimeError / SessionError) instead of
    // quietly executed on the event loop.

    // True when THIS store promised CPU isolation.
    get workerExecution(): boolean {
        return this.runtime.threadExecution === 'worker';
    }

    // The host, created on first use. An inline store never calls this, so an inline server
    // never touches `node:worker_threads` at all.
    private lanes(): LaneHost {
        if (this.host === undefined) this.host = createLaneHost(this.runtime);

        return this.host;
    }

    // The session's own capability decision, taken where the session is BUILT (create and
    // restore), because that is the last moment a refusal costs nobody any work.
    private assertWorkerCapable(preset: HarnessPreset): void {
        if (!this.workerExecution) return;

        const capability = assessLaneWorkerCapability(preset, laneWorkerEnvironment());

        if (!capability.supported) {
            throw new SessionError(400, laneWorkerUnsupportedMessage(capability));
        }
    }

    // The memory keys this session's tools may touch, derived from the CAPTURED tool sources
    // (./workers/capability.ts). A tool that reaches the map dynamically is refused at hello
    // rather than given the whole map, so the window stays bounded.
    //
    // T12 hook (from the T11 report): two defects, both of which made the window smaller than
    // the toolbox rather than wider, which is the direction that loses a lane's write:
    //   1. The scan read `source.source` - the LEGACY `format: 'function-body'` field. Every
    //      shipped core tool is registered as `format: 'module'` with its text in `moduleText`
    //      plus captured helper modules in `dependencies`, so all of them scanned as
    //      `undefined` and named no keys. That is T10 finding M5 again, one level up: the
    //      session-level plan now uses `toolScanTextOf`, the same field-correct reader the
    //      worker report (./lane-worker-loop.ts) and the authority's created-tool check
    //      (./lane-authority.ts) use, so the three windows cannot drift.
    //   2. The result was cached per session id FOREVER. `toolCreate`/`toolManage` install a
    //      revision without replacing the harness OBJECT, so neither this cache nor the
    //      authority cache below (keyed by object identity) noticed, and a lane created after
    //      that install got the window from session build - a tool naming a literal key the
    //      window never had would then have no base digest to commit against. The cache key is
    //      now the registry's content fingerprint, built from `ToolSourceRecord.revision`
    //      (../core/tool-source.ts:141, content-addressed over the entry, its helpers, and the
    //      installed metadata), so any revision change recomputes the window on the next call.
    private memoryKeysFor(session: Session): string[] {
        const sources = session.harness.toolSources();

        // Sorted so the fingerprint is stable regardless of registration order; `revision`
        // already covers the content, so no second hash is needed here.
        const fingerprint = sources
            .map((source) => `${source.name}\u0000${source.revision}`)
            .sort()
            .join('\u0001');
        const cached = this.memoryKeys.get(session.id);

        if (cached !== undefined && cached.fingerprint === fingerprint) return cached.keys;

        const texts = new Map(sources.map((source) => [source.name, toolScanTextOf(source)]));
        const plan = planWorkerToolSurfaces(
            Object.keys(session.harness.tools).map((name) => ({ name, source: texts.get(name) }))
        );

        this.memoryKeys.set(session.id, { fingerprint, keys: plan.memoryKeys });

        return plan.memoryKeys;
    }

    // The authority for one session: the canonical harness plus the identity ledger, the
    // writer leases, and the commit journal. Rebuilt whenever the harness OBJECT is replaced
    // (a restore or a reset re-creates it), because the ledgers are counters over that object.
    private authorityOf(session: Session): LaneAuthority {
        const existing = this.authorities.get(session.id);

        if (existing !== undefined && existing.harness === session.harness) return existing;

        const authority = createLaneAuthority({
            harness: session.harness,
            memoryKeys: this.memoryKeysFor(session),
            // An owner question asked from a lane is registered EXACTLY like one asked
            // inline: same pending map, same 409/expiry rules, same view card.
            ask: (request) => this.askFromLane(session, request),
            // A registry change made anywhere (lane, operator, model) is applied here first,
            // then pushed to every live replica so no lane keeps running a replaced revision.
            onRegistryChange: (change) => this.host?.broadcastRegistry(session.id, change)
        });

        this.authorities.set(session.id, authority);

        return authority;
    }

    // Broker a lane's owner question against this session's pending-action machinery.
    private askFromLane(
        session: Session,
        request: { requestId: string; agent: string; threadId?: string; request: HarnessActionRequest }
    ): Promise<HarnessActionChoice> {
        // The inline path inherits the run's signal from AsyncLocalStorage. A lane's run is
        // on another thread, so the owning conversation's controller is named explicitly -
        // and `expireActions` in the turn's finally is what still rejects an unanswered
        // question when its run ends.
        const controller =
            request.threadId === undefined
                ? session.controller
                : (session.lanes.get(request.threadId)?.controller ?? session.controller);

        return this.registerActionRequest(
            session,
            { requestId: request.requestId, request: request.request } as HarnessActionRequestContext,
            controller?.signal ?? new AbortController().signal,
            request.threadId
        );
    }

    // The per-lane rebuild data: the durable preset record, the session's provider settings,
    // and the bounded memory window. The authority's snapshot is taken by the host at hello,
    // because that is the one moment a full document may cross.
    private blueprintFor(session: Session): LaneBlueprintSource {
        return {
            record: presetToRecord(session.preset),
            settings: session.settings,
            apiKey: session.settings.apiKey,
            memoryKeys: this.memoryKeysFor(session)
        };
    }

    // The lane a turn belongs to: its conversation, or the session's root lane for a legacy
    // `/messages` run (decision D1 - the root run is isolated like any other).
    private laneTargetFor(threadId: string | undefined, agent: string): LaneTarget {
        return threadId === undefined ? { kind: 'root', agent } : { kind: 'thread', threadId };
    }

    // Guidance for a live run goes to the lane that OWNS the run: the authority's copy of this
    // conversation is never executing, so steering it would steer nothing (T3 finding F9).
    //
    // T12: the lane's answer is AWAITED, and the store reports THAT - the retired version
    // returned `queued: true` from the POST alone, which told a client its guidance was accepted
    // by a run that had already refused it (T10 finding M6). Three honest outcomes:
    //   - `undefined` from the host: no live lane owns this conversation, so the run already
    //     ended and the canonical harness gives the answer - `queued: false` with its own
    //     reason, exactly as the inline path does;
    //   - `queued: true`: the worker's `steer.result` receipt says the guidance was taken;
    //   - `queued: false`: the lane refused it, and the lane's reason IS the answer. Falling
    //     back to `steerThread` here would have replaced "the run is not at a steerable point"
    //     with "Thread is idle", a state that is not true while the lane is running.
    private async steerOnLane(session: Session, threadId: string, input: string): Promise<HarnessThreadSteerReceipt> {
        const host = this.host;
        const receipt = host === undefined ? undefined : await host.steer(session.id, { kind: 'thread', threadId }, input);

        if (receipt === undefined) return session.harness.steerThread(threadId, input);

        if (receipt.queued) return { threadId, queued: true };

        return { threadId, queued: false, ...(receipt.reason === undefined ? {} : { reason: receipt.reason }) };
    }

    // Register one unanswered question from the runtime. Rejections are the
    // intentional failure mode: the runtime turns a rejected handler into a
    // readable tool result for the model, so an over-full session or a cancelled
    // run never leaves a model turn hanging.
    private registerActionRequest(
        session: Session,
        context: HarnessActionRequestContext,
        signal: AbortSignal,
        // T5: a lane's question names its conversation explicitly, because the store is not
        // inside the run's async context (the run is on another thread).
        threadIdOverride?: string
    ): Promise<HarnessActionChoice> {
        if (session.disposed) {
            return Promise.reject(new Error(ACTION_SESSION_GONE_MESSAGE));
        }

        if (signal.aborted) {
            this.rememberCompletedAction(session, context.requestId);
            return Promise.reject(new Error(ACTION_CANCELLED_MESSAGE));
        }

        if (session.pendingActions.size >= MAX_PENDING_ACTIONS) {
            // The runtime already announced this request before calling us, so the
            // question card exists. Remembering the id makes its eventual answer a
            // 409 (expired) rather than a misleading 404.
            this.rememberCompletedAction(session, context.requestId);
            return Promise.reject(
                new Error(
                    `This session already has ${MAX_PENDING_ACTIONS} unanswered action requests; answer one before asking another.`
                )
            );
        }

        if (session.pendingActions.has(context.requestId)) {
            return Promise.reject(new Error(ACTION_DUPLICATE_MESSAGE));
        }

        return new Promise<HarnessActionChoice>((resolve, reject) => {
            // `settle` is the ONLY place that resolves/rejects or removes the
            // listener, and `pending.settled` makes a second route/abort/teardown
            // a no-op. That is how "settle exactly once" survives a race between
            // an HTTP answer and the run's abort.
            let pending: PendingAction;

            // The run that asks is the one whose async context is active right now
            // (the runtime awaits this handler inside the run's chain), so the
            // owning thread comes from the environment, never from the request.
            const scopedThreadId =
                threadIdOverride ??
                (this.runContexts.getStore()?.session === session
                    ? this.runContexts.getStore()?.threadId
                    : undefined);

            pending = {
                requestId: context.requestId,
                ...(scopedThreadId === undefined ? {} : { threadId: scopedThreadId }),
                request: context.request,
                // T13: the agent the runtime named, plus the accept time of the question.
                agent: context.agent,
                openedAt: Date.now(),
                signal,
                settled: false,
                onAbort: () => {
                    this.finishActionRequest(session, pending, {
                        ok: false,
                        error: new Error(ACTION_CANCELLED_MESSAGE)
                    });
                },
                settle: (outcome) => {
                    if (outcome.ok) {
                        resolve(outcome.choice);
                        return;
                    }

                    reject(outcome.error);
                }
            };

            signal.addEventListener('abort', pending.onAbort, { once: true });
            session.pendingActions.set(context.requestId, pending);
        });
    }

    // Answer one pending question. Allowed while the session is BUSY: the run is
    // by definition awaiting this answer, so rejecting it as a conflict would make
    // the feature unusable. Validation happens before any mutation, and the
    // runtime has already parsed the request, so an option id the model did not
    // offer is a readable 400 (never coerced to the recommendation).
    answerAction(id: string, requestId: string, choice: unknown): void {
        const session = this.require(id);

        const pending = session.pendingActions.get(requestId);

        if (pending === undefined) {
            if (session.completedActions.includes(requestId)) {
                throw new SessionError(
                    409,
                    `Action request "${requestId}" was already answered or has expired.`
                );
            }

            throw new SessionError(404, `Unknown action request "${requestId}".`);
        }

        let validated: HarnessActionChoice;

        try {
            validated = validateActionChoice(choice, pending.request);
        } catch (error) {
            throw new SessionError(400, messageOf(error));
        }

        this.finishActionRequest(session, pending, { ok: true, choice: validated });
    }

    // Settle one pending entry exactly once, detach its abort listener, and record
    // the id as no-longer-answerable (bounded FIFO) so a repeated/stale answer is a
    // 409 instead of a 404.
    private finishActionRequest(
        session: Session,
        pending: PendingAction,
        outcome: HarnessActionOutcome
    ): void {
        if (pending.settled) return;

        pending.settled = true;
        session.pendingActions.delete(pending.requestId);
        pending.signal.removeEventListener('abort', pending.onAbort);

        this.rememberCompletedAction(session, pending.requestId);

        // T16: one `action.closed` per settlement, from the ONE settlement point, so a client
        // clears exactly one question card and the `actions` counter moves whether the answer
        // came from an owner, an abort, or the run ending. The reason is the contract's closed
        // vocabulary; the readable text stays in the rejection the runtime already sees.
        this.notifyStream({
            kind: 'action.closed',
            sessionId: session.id,
            requestId: pending.requestId,
            reason: actionClosedReason(outcome),
            at: Date.now()
        });

        pending.settle(outcome);
    }

    // Record one request id as no-longer-answerable, keeping the bounded FIFO. Used
    // by both settlement paths and by rejections that happen BEFORE a pending entry
    // exists (the runtime announced the request, then the host refused it).
    private rememberCompletedAction(session: Session, requestId: string): void {
        // Never record an id twice: an early rejection and a later settlement can
        // both reach here for the same request.
        if (session.completedActions.includes(requestId)) return;

        session.completedActions.push(requestId);
        while (session.completedActions.length > MAX_COMPLETED_ACTIONS) {
            session.completedActions.shift();
        }
    }

    // Fail every unanswered question of this session. Used by cancel(), remove(),
    // dispose(), and the end of a turn, so no runtime await can outlive the work it
    // belongs to. Idempotent via finishActionRequest.
    // `threadId` scopes the expiry to ONE conversation (stopping a thread must not
    // reject a sibling lane's question); omitted expires every pending question
    // (cancel-all, remove, dispose, end of a legacy run).
    private expireActions(session: Session, message: string, threadId?: string): void {
        for (const pending of [...session.pendingActions.values()]) {
            if (threadId !== undefined && pending.threadId !== threadId) continue;

            this.finishActionRequest(session, pending, {
                ok: false,
                error: new Error(message)
            });
        }
    }

    private require(id: string): Session {
        const session = this.sessions.get(id);
        if (!session) {
            throw new SessionError(404, `Unknown session "${id}".`);
        }

        return session;
    }

    // -----------------------------------------------------------------------
    // R1-R6: thread lanes and the session-wide gates
    // -----------------------------------------------------------------------

    // Whether this session's harness exposes the persistent-thread API (R1-R6).
    //
    // A preset built by `harness()` always does. A HOST-supplied handle built
    // before threads existed (the background/recovery fixtures forward only the
    // historical members) does not, and must keep working exactly as before: its
    // unfocused submits run on the callable root with a fresh block, its turns
    // carry no thread id, and its snapshots have no roster. Guarding the capability
    // keeps the old public surface intact instead of breaking every custom handle.
    private threadsSupported(session: Session): boolean {
        const harness = session.harness as Partial<Harness>;

        return (
            typeof harness.threads === 'function' &&
            typeof harness.thread === 'function' &&
            typeof harness.threadMessages === 'function' &&
            typeof harness.createThread === 'function' &&
            typeof harness.sendThreadInput === 'function' &&
            typeof harness.stopThread === 'function' &&
            typeof harness.stopAllThreads === 'function' &&
            typeof harness.deleteThread === 'function'
        );
    }

    // True while ANY thread lane is executing. Lanes are independent, so this is
    // an aggregate: the legacy/manual paths use it to keep their exclusive
    // semantics while lanes still run concurrently with each other.
    private laneActive(session: Session): boolean {
        for (const lane of session.lanes.values()) {
            if (lane.active !== undefined) return true;
        }

        return false;
    }

    // Every turn accepted but not yet started, across the legacy backlog and every
    // lane. This is what MAX_PENDING_TASKS bounds, so a session cannot accumulate
    // unbounded work by spreading it over threads.
    private pendingCount(session: Session): number {
        let count = session.queue.length;

        for (const lane of session.lanes.values()) count += lane.queue.length;

        return count;
    }

    // The exclusive gate: a legacy streaming run, a manual tool call, or any live
    // thread run. A manual mutation must not interleave with a thread's shared-store
    // writes, so it is refused while a lane is active (the previous session-wide
    // busy rule, widened to threads).
    private exclusive(session: Session): boolean {
        return session.busy || this.laneActive(session);
    }

    // Anything that makes "reset"/"remove-and-ignore" unsafe: a live operation or
    // accepted-but-unstarted work anywhere in the session.
    private busyOrPending(session: Session): boolean {
        return this.exclusive(session) || this.pendingCount(session) > 0;
    }

    private laneOf(session: Session, threadId: string): ThreadLane {
        const existing = session.lanes.get(threadId);
        if (existing !== undefined) return existing;

        const lane: ThreadLane = {
            threadId,
            queue: [],
            pumping: false,
            stopRequested: false
        };

        session.lanes.set(threadId, lane);
        return lane;
    }

    // The recorder to use when a progress callback runs OUTSIDE any run context.
    // `session.sink` covers the legacy/exclusive run; a single active lane covers
    // the common one-thread case. Ambiguity (two lanes, no context) is dropped
    // rather than attributed to the wrong turn.
    private fallbackRecorder(session: Session): ((event: HarnessEvent) => Promise<void>) | undefined {
        if (session.sink !== undefined) return session.sink;

        let found: ((event: HarnessEvent) => Promise<void>) | undefined;
        let count = 0;

        for (const lane of session.lanes.values()) {
            if (lane.sink === undefined) continue;
            found = lane.sink;
            count += 1;
        }

        return count === 1 ? found : undefined;
    }

    // Registry mutations happen in ./harnesses/registry.ts, outside the store, so
    // the dispatcher calls this after a successful create/patch. It must persist
    // before the HTTP result: a harness the next restart forgets is a lie. With no
    // database root it is a no-op (the previous in-memory behaviour).
    //
    // A caller that needs "the mutation is real only if it is durable" uses
    // `mutateRegistry` below instead; this stays for a host that mutates the
    // registry itself and commits afterwards.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    async persistRegistry(): Promise<void> {
        // T27: a registry commit is also a SESSION-document commit — `databaseRecord` writes
        // every session's `core` into the same file — so the snapshots it persists have to
        // describe the harnesses as they now are. Before this, a REST tool write
        // (`PATCH/DELETE /sessions/{id}/tools/{name}`, a registration, a `toolManage`
        // enable/disable/remove) mutated the live harness and committed a document whose `core`
        // was whatever the run-boundary observer had last captured, because the registration
        // kernel reports through its own result rather than through `stateChange`. The route
        // worked around that by taking a throwaway snapshot for its receipt, which left the
        // PERSISTED document behind: a restart came back with the pre-write core, and
        // `GET /sessions/{id}` disagreed with the response it had just produced.
        //
        // The refresh is here, in the store's own durable-commit boundary, so no dispatcher can
        // forget it. Sessions with live work are SKIPPED: their `core` is maintained at
        // mutation boundaries by the observer, and snapshotting mid-run here would attribute a
        // half-finished turn's partial state to a registry edit that has nothing to do with it.
        this.refreshIdleCores();

        await this.persistOrThrow();
    }

    // Rewind-proof core refresh: one snapshot per idle session, best-effort. A snapshot that
    // throws (a harness in a state its own snapshot refuses) leaves that session's last good
    // `core` in place rather than failing a registry write for an unrelated session.
    private refreshIdleCores(): void {
        for (const session of this.sessions.values()) {
            if (session.busy || this.laneActive(session)) continue;

            try {
                session.core = session.harness.snapshot();
            } catch {
                // The previous snapshot stays committed; the run-boundary observer is still the
                // owner of this session's state, and a later boundary refreshes it.
            }
        }
    }

    // T5: run a registry mutation (create / patch / DELETE) and commit it as ONE
    // unit. The registry is in-memory and the document is what a restart rebuilds,
    // so a failed write must not leave the mutation applied: that is a catalogue
    // whose next start disagrees with the answer the client just got.
    //
    // The rollback restores the entries AND their listing order AND the deleted
    // built-in tombstones (T5), because `snapshot()` captured all three. It is
    // safe as a wholesale replace because the dispatcher reads the request body
    // BEFORE the mutation and the commit is synchronous, so no other request can
    // have touched the registry in between.
    //
    // Failure is honest: the caller's mutation result is never returned. A write
    // failure throws the 500 from `persistOrThrow` (and a post-shutdown write throws
    // its 503), after the registry is back exactly as it was.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    //
    // The rollback still compensates exactly once: `mutate()` is synchronous and ONLY the
    // commit is awaited, so a failed write restores the captured snapshot before the
    // rejection reaches the caller.
    async mutateRegistry<T>(mutate: () => T): Promise<T> {
        // In-memory store: nothing to commit, nothing to roll back.
        if (this.persistence === undefined) return mutate();

        const captured = this.registry.snapshot();

        let result: T;

        try {
            result = mutate();
            await this.persistOrThrow();
        } catch (error) {
            // A HarnessRegistryError from `mutate` itself lands here too; that
            // mutation never touched the registry, so restoring the snapshot is a
            // no-op and one path covers both failures.
            this.registry.restore(captured);
            throw error;
        }

        return result;
    }

    // -----------------------------------------------------------------------
    // R3b: durable database (read: constructor; write: every mutation)
    // -----------------------------------------------------------------------

    // One session as stored. The live preset is projected WITHOUT its factory; the
    // frozen descriptor is stored verbatim so a later registry PATCH cannot change
    // what an old session reports; `settings` omits the API key on purpose.
    private sessionRecord(session: Session): HarnessSessionRecord {
        return {
            id: session.id,
            harness: session.preset.name,
            preset: presetToRecord(session.preset),
            definition: copyDescriptor(session.definition),
            settings: {
                baseURL: session.settings.baseURL,
                model: session.settings.model
            },
            // T16: written only when the session actually has a title, so a document for an
            // untouched session keeps its pre-T16 shape byte for byte.
            ...(session.title === undefined ? {} : { title: session.title }),
            // T27: the session-scoped binding list, written only when there is one (same
            // additive rule as the title). Detached copy: the document handed to the writer is
            // never the live array.
            ...(session.sessionAgents.length === 0
                ? {}
                : { sessionAgents: [...session.sessionAgents] }),
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ...(session.lastError === undefined ? {} : { lastError: session.lastError }),
            turns: copyTurns(session.turns),
            // Queue entries must be the same turns; ids keep the document compact
            // and let the loader re-link them to the (already copied) turns. F1:
            // EVERY pending turn is included — the legacy queue and each lane's
            // backlog — ordered by turn index so a restart restores the same paused
            // work (and its thread association).
            queue: [...session.queue, ...[...session.lanes.values()].flatMap((lane) => lane.queue)]
                .sort((left, right) => left.index - right.index)
                .map((turn) => turn.id),
            // R1-R6: the index high-water mark and the label/invocation joins.
            // Recorded only when they carry information, so a session that never
            // opened a host thread keeps the pre-thread document shape.
            ...(session.turnSequence === 0 ? {} : { threadSequence: session.turnSequence }),
            ...(session.labelSeeds.size === 0
                ? {}
                : { labelSeeds: Object.fromEntries([...session.labelSeeds].map(([id, seed]) => [id, { ...seed }])) }),
            ...(session.labelHighWater.size === 0
                ? {}
                : { labelHighWater: Object.fromEntries([...session.labelHighWater]) }),
            ...(session.threadLabels.size === 0
                ? {}
                : { threadLabels: Object.fromEntries([...session.threadLabels]) }),
            ...(session.threadLabelHighWater.size === 0
                ? {}
                : { threadLabelHighWater: Object.fromEntries([...session.threadLabelHighWater]) }),
            ...(session.turnInvocations.size === 0
                ? {}
                : { turnInvocations: Object.fromEntries(session.turnInvocations) }),
            // T9/T10: written only when a turn actually recorded a source, so a session
            // that never ran keeps its exact pre-T10 document shape. Detached per entry:
            // the document handed to the writer is never the live map.
            ...(session.turnInstructionSources.size === 0
                ? {}
                : {
                      turnInstructionSources: Object.fromEntries(
                          [...session.turnInstructionSources].map(([turnId, sources]) => [
                              turnId,
                              sources.map((source) => ({
                                  agent: source.agent,
                                  instructions: [...source.instructions],
                                  ...(source.at === undefined ? {} : { at: source.at })
                              }))
                          ])
                      )
                  }),
            ...(session.invocationThreads.size === 0
                ? {}
                : { invocationThreads: Object.fromEntries(session.invocationThreads) }),
            // C4: the raw unreadable transcripts. Written only when present, so a
            // session that never had a broken thread keeps its exact pre-C4
            // document shape. Keyed by thread id; values keep `messages` verbatim.
            ...(session.invalidThreads.size === 0
                ? {}
                : {
                      invalidThreads: Object.fromEntries(
                          [...session.invalidThreads].sort(([left], [right]) =>
                              left.localeCompare(right)
                          )
                      )
                  }),
            // The last committed snapshot. During an active run this is the latest
            // mutation boundary the observer captured (a completed tool's store
            // writes and tool-result message together), plus the event log above.
            core: session.core,
            // Per-agent models are recorded OUTSIDE the core snapshot so a model
            // PATCH is durable even if it lands between snapshot boundaries.
            agentModels: Object.fromEntries(
                Object.entries(session.harness.agents).map(([name, brain]) => [name, brain.model()])
            )
        };
    }

    // `overrides` replaces one session's projected record, which is how a
    // destructive mutation (thread deletion) can be made DURABLE before the live
    // harness is touched: a failed write leaves both memory and disk untouched.
    private databaseRecord(overrides?: ReadonlyMap<string, HarnessSessionRecord>): HarnessDatabase {
        const deletedBuiltins = this.registry.deletedBuiltins();

        return {
            version: HARNESS_DATABASE_VERSION,
            savedAt: Date.now(),
            registry: this.registry.list().map(presetToRecord),
            // T5: the deleted built-in tombstones, written only when there are any
            // (a document without the field is exactly the pre-T5 shape, and a
            // re-created built-in clears its tombstone so the field disappears
            // again). This is the ONLY way a deletion of a shipped default survives:
            // the row is simply missing from `registry`, and a fresh registry seeds
            // itself from the shipped templates.
            ...(deletedBuiltins.length === 0 ? {} : { deleted: [...deletedBuiltins] }),
            // T16: the operator's global defaults, written only once they have been changed, so a
            // document from a deployment that never touched `/config` keeps its exact shape.
            ...(this.global === undefined ? {} : { globalSettings: { ...this.global } }),
            sessions: [...this.sessions.values()].map(
                (session) => overrides?.get(session.id) ?? this.sessionRecord(session)
            )
        };
    }

    // Structural mutations use this: the caller's result is only returned after the
    // document (including this mutation) is durable. Failure becomes a 500 with the
    // underlying message; each caller rolls back what it can.
    //
    // Post-shutdown it refuses instead of writing: the in-memory map was cleared by
    // dispose(), so the document this method would build no longer describes the
    // store, and saving it would destroy the graceful shutdown document. A 503 is
    // the honest answer to a request that raced the shutdown (the caller's rollback
    // then leaves in-memory state exactly as it found it).
    // D4: this method is ASYNC, and that is the whole cost of "durable before the response"
    // in worker mode. Inline it still writes synchronously (the syscall is the commit, exactly
    // as it always was); with an IO client the document is cloned to the thread and the
    // promise resolves only after the worker's own `rename` receipt. A caller that cannot
    // await may NOT claim durability - which is why every strict call site awaits and the
    // synchronous observers use `persistBestEffort`/`checkpoint` instead.
    //
    // `commit.fenceSessions` is the TERMINAL commit shape: the journal tail of those sessions
    // is fsynced ahead of the document that lists those events (`io.commitCheckpoint`, whose
    // queue order is what makes the fence precede the rename). Inline ignores it - the inline
    // path never fsynced here, and a worker-mode fence is strictly stronger than inline, never
    // weaker. Omitting it is byte-for-byte parity in both modes.
    private async persistOrThrow(
        overrides?: ReadonlyMap<string, HarnessSessionRecord>,
        commit?: { fenceSessions?: readonly string[] }
    ): Promise<void> {
        if (this.persistence === undefined) return;

        if (this.shuttingDown) {
            throw new SessionError(503, 'The harness database is closed; nothing was saved.');
        }

        // Built on THIS thread either way: the coordinator owns the state, so it owns the
        // record. What moves off-thread is the stringify and the syscalls.
        const record = this.databaseRecord(overrides);
        const fences = commit?.fenceSessions;

        try {
            if (this.io === undefined) this.persistence.save(record);
            else if (fences === undefined || fences.length === 0) await this.io.saveCheckpoint(record);
            else await this.io.commitCheckpoint({ document: record, fenceSessions: fences });

            this.lastPersistenceError = undefined;
        } catch (error) {
            // The message parity is deliberate: `io.saveCheckpoint` rejects with the exact
            // text `persistence.save` throws (./workers/io-protocol.ts `ioErrorReportOf`), so
            // a 500 body reads identically in both modes.
            this.notePersistenceError(error);
            throw new SessionError(500, `Could not save the harness database: ${messageOf(error)}`);
        }
    }

    // Background transitions use this: a completed run is no longer allowed to
    // change its outcome because the disk is full, but the failure is recorded and
    // reported so it cannot vanish silently.
    //
    // Suppressed while shutting down (P1-B). The aborted run settles only AFTER
    // dispose() cleared the session map, so its terminal save would otherwise
    // rewrite the file with `sessions: []` and lose every session it just
    // committed. Background work may legitimately race a shutdown; it may never
    // overwrite the shutdown document.
    //
    // It STAYS SYNCHRONOUS, in both modes: this is the body of a synchronous core
    // observer (noteStateChange) and of the interval checkpoint, and neither may block.
    // In worker mode the call therefore claims ORDER, not durability - the newest document
    // replaces the pending slot (one commit per burst), and the rename happens later on the
    // worker. Anything that must be durable before a response uses `persistOrThrow`.
    private persistBestEffort(): void {
        if (this.persistence === undefined) return;

        if (this.shuttingDown) return;

        if (this.io !== undefined) {
            this.io.queueCheckpointSave(this.databaseRecord());

            // The worker-mode twin of `persistence.lastWriteError`: what the LAST SETTLED
            // commit says. It can lag this just-queued document by one commit - the honest
            // difference from inline, and the reason a queued failure is reported rather than
            // thrown (`onCheckpointError` covers the case where it settles while nobody is
            // looking).
            this.lastPersistenceError = this.io.lastError();

            return;
        }

        try {
            this.persistence.save(this.databaseRecord());
            this.lastPersistenceError = undefined;
        } catch (error) {
            this.notePersistenceError(error);
        }
    }

    private notePersistenceError(value: unknown): void {
        const error = value instanceof Error ? value : new Error(messageOf(value));
        this.lastPersistenceError = error.message;

        if (this.onPersistenceError !== undefined) {
            try {
                this.onPersistenceError(error);
            } catch {
                // An error reporter must never turn a save failure into a crash.
            }

            return;
        }

        // Default observability: the core observer swallows our callback's throws,
        // so stderr is the only always-on channel. Callers/tests can inject
        // `onPersistenceError` instead and stay quiet.
        console.error(`[harness] failed to persist the harness database: ${error.message}`);
    }

    // Core state-change observer (attached at construction). Core fires it AFTER a
    // mutation is committed and permits a synchronous snapshot even while the run
    // is active (T16), so this captures a completed tool's store writes together
    // with its tool-result message — exactly the point where an interrupted turn
    // must not lose work. A snapshot failure (defensive: a future core restriction)
    // keeps the previous committed state, records the reason where possible and
    // still attempts the save. Exceptions never escape into the core, which
    // swallows them anyway; write failures go through notePersistenceError so they
    // stay observable.
    private noteStateChange(session: Session, _event: HarnessStateChangeEvent): void {
        // A disposed session and a closing store are both dead ends: taking the
        // snapshot would be wasted work and the save must not happen at all (the
        // map no longer contains it, so the document would be a lie).
        if (this.loading || session.disposed || this.shuttingDown) return;

        try {
            session.core = session.harness.snapshot();
        } catch (error) {
            // Only reachable if a future core refuses a boundary snapshot. Keep the
            // last committed state and surface the failure; the turn is restored as
            // interrupted rather than replayed.
            this.lastPersistenceError = `Could not capture harness state: ${messageOf(error)}`;
        }

        this.persistBestEffort();
    }

    // C4: validate every HOST thread transcript in a persisted snapshot and
    // neutralise the unreadable ones. Pure apart from the deliberate in-place
    // replacement, and it must run BEFORE `harness.restore()` (which validates the
    // whole document and refuses it atomically).
    //
    // Returns the threads that failed, keyed by id, with the raw value exactly as
    // stored. A thread with no addressable `id` is left untouched: only
    // `readHarnessSnapshot` can explain that corruption, and the session drop path
    // already reports it, so guessing here would hide the real reason.
    private tolerateThreadTranscripts(core: HarnessSnapshot): Map<string, HarnessInvalidThreadRecord> {
        const invalid = new Map<string, HarnessInvalidThreadRecord>();

        // `core` comes straight off disk, so every field here is `unknown` in
        // practice even though the record type claims a snapshot. Only `threads` is
        // inspected; anything structurally wrong elsewhere is restore's business.
        const threads = core.threads as unknown as
            | { id?: unknown; agent?: unknown; label?: unknown; messages?: unknown }[]
            | undefined;

        if (!Array.isArray(threads)) return invalid;

        for (const thread of threads) {
            if (thread === null || typeof thread !== 'object') continue;

            const id = typeof thread.id === 'string' ? thread.id : undefined;
            if (id === undefined) continue;

            try {
                // The same reader snapshot()/restore() enforce, so a transcript
                // accepted here cannot be refused later, and the message below is
                // exactly what the editor shows the user.
                readHarnessMessages(thread.messages, `thread "${id}" messages`);
            } catch (error) {
                const reason = messageOf(error);

                invalid.set(id, {
                    error: reason,
                    // Opaque on purpose: this is the user's broken value, and the
                    // editor must show precisely what was stored.
                    messages: thread.messages,
                    ...(typeof thread.label === 'string' ? { label: thread.label } : {}),
                    ...(typeof thread.agent === 'string' ? { agent: thread.agent } : {})
                });

                // Replace, do not delete: the thread must keep existing (with its
                // id, agent, label and turn links) so the roster can still address
                // it and the user can still fix it.
                thread.messages = unreadableTranscript(reason);
            }
        }

        return invalid;
    }

    // C4: reconcile the transcripts that failed validation THIS load
    // (`restored`) with the raw values the document already recorded as unreadable
    // (`persisted`). The result lands in `session.invalidThreads`.
    //
    // A persisted entry is only worth keeping while the thread is STILL unreadable,
    // which after `harness.restore()` means its messages are still one of our
    // placeholders:
    //   - thread gone            → stale (the conversation was deleted; ids are
    //     never reused, so nothing can adopt the orphaned raw value);
    //   - thread repaired by hand → stale (its messages are now valid AND not a
    //     placeholder, so the raw value is no longer what the transcript says);
    //   - thread still a placeholder → KEEP. The placeholder is what makes the
    //     session loadable; the raw value only exists here, and it is what the
    //     operator needs in order to fix the thread.
    //
    // C8-m3: a DEFAULT conversation (`agent:<name>`) has no entry in `core.threads`
    // at all, so its "still a placeholder?" test runs against
    // `core.agents[name].messages` instead (see `defaultTranscriptStillUnreadable`).
    // Without that branch a live PUT of an invalid default transcript was a durable
    // record for exactly one process: the restart dropped the raw value and the
    // placeholder started reading as the conversation's real history.
    //
    // A thread that failed THIS load keeps the freshly captured value (`restored`
    // already holds it): the same broken text was re-read from a live transcript,
    // which is authoritative over an older recording of it.
    private mergeInvalidTranscripts(
        session: Session,
        restored: Map<string, HarnessInvalidThreadRecord>,
        persisted: Record<string, HarnessInvalidThreadRecord> | undefined,
        core: HarnessSnapshot
    ): void {
        if (persisted !== undefined) {
            // Addressable threads of the (already neutralised) snapshot.
            const threads = new Map<string, { messages?: unknown }>();
            const entries = core.threads as unknown as
                { id?: unknown; messages?: unknown }[] | undefined;

            if (Array.isArray(entries)) {
                for (const entry of entries) {
                    if (entry === null || typeof entry !== 'object') continue;
                    if (typeof entry.id !== 'string') continue;

                    threads.set(entry.id, entry);
                }
            }

            // Agent-keyed DEFAULT conversations (C8-m3), read raw off the same
            // (unvalidated) persisted snapshot the thread list above came from.
            const agents = core.agents as unknown as
                | Record<string, { messages?: unknown }>
                | undefined;

            for (const [id, entry] of Object.entries(persisted)) {
                if (restored.has(id)) continue;

                const thread = threads.get(id);
                const stillUnreadable =
                    thread === undefined
                        ? defaultTranscriptStillUnreadable(id, agents)
                        : isUnreadablePlaceholder(thread.messages);

                if (!stillUnreadable) continue;

                restored.set(id, entry);
            }
        }

        // Assigned in BOTH cases: a document with no `invalidThreads` field can
        // still carry transcripts that failed THIS load, and those fresh entries
        // are the only record of them.
        session.invalidThreads = restored;
    }

    // Rebuild one session from a validated record. Order matters: the frozen
    // preset decides the harness shape, the harness must be built from it, and only
    // then can the core snapshot be applied (restore validates against the exact
    // agent/registry set before mutating).
    private restoreSession(record: HarnessSessionRecord): void {
        // `HarnessPersistenceError` below prefixes the database file, so the inner
        // message names the SESSION only. Naming the file twice (as `Session "id"
        // in <file>` used to) made the persisted diagnostic unreadable, and this
        // message is now what an operator sees in the server log for a dropped
        // session: `<file>: Session "<id>" could not be restored: <reason>`.
        const location = `Session "${record.id}"`;

        try {
            // Fast path: the registry still has the exactly-matching entry (the
            // common case, including the scripted demo's captured factory). A
            // changed entry falls back to rebuilding from the SESSION's frozen
            // record, which is why a PATCH after creation does not break restart.
            //
            // T5: a DELETED harness lands in the fallback for the same reason. The
            // registry no longer resolves the name (`current === undefined`), so the
            // frozen record's `template` rebuilds the factory — a 'live'/'flaky'
            // record from its saved team and models, a 'scripted' record from the
            // shipped-template lookup. Deleting a card therefore never drops or
            // rewrites a saved conversation. (An injected factory-less preset is the
            // one case that cannot rebuild without its entry; R6 drops such a session
            // with a named restore error.)
            const current = this.registry.find(record.harness);
            const preset =
                current !== undefined && presetRecordEquals(presetToRecord(current), record.preset)
                    ? current
                    : presetFromRecord(record.preset, current);

            // No API key is read from disk. mergeSettings re-attaches the server
            // key only when the stored base URL is the configured provider; a
            // foreign endpoint resumes unauthenticated (by design).
            const settings = mergeSettings(this.defaults, {
                baseURL: record.settings.baseURL,
                model: record.settings.model
            });

            const turns = record.turns.map(copyTurn);
            const byId = new Map(turns.map((turn) => [turn.id, turn]));
            const queue: SessionTurn[] = [];

            for (const id of record.queue) {
                const turn = byId.get(id);

                if (turn === undefined || turn.status !== 'queued') {
                    throw new Error(`queue names turn "${id}", which is not a queued turn.`);
                }

                queue.push(turn);
            }

            // Recovery policy: an in-flight turn is INTERRUPTED, never replayed.
            // Its recorded events stay; the turn and session become error rows.
            const restoredAt = Date.now();
            let interrupted = record.status === 'running';

            for (const turn of turns) {
                if (turn.status !== 'running') continue;

                turn.status = 'error';
                turn.updatedAt = restoredAt;
                interrupted = true;
            }

            // F1: EVERY accepted-but-unstarted turn is PRESERVED as 'queued' and
            // paused (the historical backlog policy). After the core restore below
            // each one is placed in its thread's lane, so the next explicit submit
            // to that conversation drains it FIFO — it is never auto-started and its
            // prompt/attachments/thread association are all preserved.

            let session: Session | undefined;

            // T5: a restored session is checked again, because the registry may have replaced
            // the preset this record rebuilds from with an injected one. A refusal here lands
            // in the per-session restore failure (noteRestoreError), not in a dropped database.
            this.assertWorkerCapable(preset);

            const harness = this.buildHarness(preset, settings, () => session);

            session = {
                id: record.id,
                preset,
                definition: copyDescriptor(record.definition),
                settings,
                harness,
                status: interrupted ? 'error' : record.status === 'error' ? 'error' : 'idle',
                createdAt: record.createdAt,
                updatedAt: interrupted ? restoredAt : record.updatedAt,
                ...(interrupted
                    ? { lastError: INTERRUPTED_MESSAGE }
                    : record.lastError === undefined
                      ? {}
                      : { lastError: record.lastError }),
                // T16: a saved title survives a restart, so a named conversation is still named
                // when the rail comes back.
                ...(record.title === undefined ? {} : { title: record.title }),
                // T27: the session-scoped binding list. The roster itself is rebuilt from
                // `record.preset`/`record.definition` (both copies carry the added member, which
                // is why `presetFromRecord` below re-creates the team), and this list only marks
                // which of those members the contract reports as `origin: "session"`.
                sessionAgents: record.sessionAgents === undefined ? [] : [...record.sessionAgents],
                busy: false,
                cancelled: false,
                turns,
                queue,
                // R1-R6: lanes are rebuilt lazily; restored turns keep their owning
                // thread id so their history stays groupable.
                lanes: new Map(),
                // Old documents have no high-water mark: derive it from the highest
                // recorded index so a restored session never reuses an index.
                turnSequence:
                    record.threadSequence ??
                    turns.reduce((highest, turn) => Math.max(highest, turn.index + 1), 0),
                // Seeds/invocation joins are restored for turns that still exist;
                // a stale id (from a hand-edited file) is dropped rather than
                // resurrecting a record nobody can address.
                labelSeeds: new Map(
                    Object.entries(record.labelSeeds ?? {}).filter(([turnId]) =>
                        turns.some((turn) => turn.id === turnId)
                    )
                ),
                // The tombstone high-water is NOT filtered by live turns: its whole
                // purpose is to remember labels whose turns are gone.
                labelHighWater: new Map(Object.entries(record.labelHighWater ?? {})),
                // R8 conversation names: restored verbatim; a pre-R8 document has
                // none and the store derives them deterministically on demand.
                threadLabels: new Map(Object.entries(record.threadLabels ?? {})),
                threadLabelHighWater: new Map(Object.entries(record.threadLabelHighWater ?? {})),
                turnInvocations: new Map(
                    Object.entries(record.turnInvocations ?? {}).filter(([turnId]) =>
                        turns.some((turn) => turn.id === turnId)
                    )
                ),
                // T9/T10: the frozen instruction sources, keyed by turn id and filtered
                // to the turns that survived (a stale id must not feed a fold for a turn
                // nobody can address). `persistence.readSessionRecord` has already
                // validated the shape; this only detaches the copies so a fold cannot
                // mutate the parsed document.
                turnInstructionSources: new Map(
                    Object.entries(record.turnInstructionSources ?? {})
                        .filter(([turnId]) => turns.some((turn) => turn.id === turnId))
                        .map(([turnId, sources]) => [
                            turnId,
                            (Array.isArray(sources) ? sources : []).map((source) => ({
                                agent: source.agent,
                                instructions: [...source.instructions],
                                ...(source.at === undefined ? {} : { at: source.at })
                            }))
                        ])
                ),
                // F6: invocation → conversation, kept across a restart so a later
                // deletion can purge the runtime's agent-result records exactly.
                invocationThreads: new Map(Object.entries(record.invocationThreads ?? {})),
                // C4: replaced by tolerant restore below (persisted entries are
                // re-validated there, so a stale one cannot survive a restart).
                invalidThreads: new Map(),
                legacyRunning: false,
                watchers: new Set(),
                pumping: false,
                busyWaiters: [],
                drainWaiters: [],
                turnWaiters: [],
                settlers: new Map(),
                pendingActions: new Map(),
                // Nothing from disk may be answered: a restart expires every
                // recorded question (the runtime that was awaiting it is gone).
                // Keeping the ids (bounded) turns a stale UI card's answer into a
                // 409 instead of a misleading 404.
                completedActions: expiredActionIds(turns),
                disposed: false,
                // R1/R3/R4: the compiled state is rebuilt from the durable records
                // right after registration (`restoreProjections`), so a restart starts
                // with warm compact state and no request-time folding. The journal is
                // attached lazily by that merge.
                projections: new Map(),
                viewWatchers: new Set(),
                journal: undefined,
                journalProblems: [],
                blockCache: new Map(),
                checkpointAt: restoredAt,
                // Replaced with a fresh snapshot after restore succeeds.
                core: record.core
            };

            // Apply core state last. restore() validates the whole snapshot
            // (schema, version, agents, tool sources) before mutating, so a bad
            // document here leaves the freshly built harness untouched and fails
            // loudly below.
            //
            // T25/T26: a snapshot written after an assistant tool_call commit (but
            // before its results) is schema-valid yet unsafe to resume. Repair the
            // persisted transcript first: keep every completed result, append an
            // explicit interrupted result for each unmatched id, never execute the
            // call. A fully paired transcript is returned unchanged.
            const core = repairInterruptedToolCalls(record.core);

            // C4: make every UNREADABLE THREAD survivable before restore validates
            // the document. `readHarnessSnapshot` refuses a thread whose `messages`
            // is not a valid transcript, and that refusal used to drop the ENTIRE
            // session — one broken hand edit costing every conversation in it. Each
            // bad thread's messages are replaced with a valid placeholder here and
            // the raw value is captured, so `harness.restore` sees a snapshot it
            // accepts and the broken text stays visible/editable.
            //
            // Scope is deliberately per THREAD: an invalid DEFAULT conversation
            // (`core.agents[name].messages`) still fails the restore, because the
            // agent transcript is what the entry point runs and a placeholder there
            // would silently rewrite the session's primary conversation.
            const invalidThreads = this.tolerateThreadTranscripts(core);

            session.core = core;
            harness.restore(core);

            // Merge what the document recorded as unreadable (C4). A thread that is
            // still a placeholder is the one case where the persisted raw value is
            // the only copy of the user's text, so it wins; anything else is stale.
            this.mergeInvalidTranscripts(session, invalidThreads, record.invalidThreads, core);

            // Re-apply the live per-agent models recorded beside the snapshot. The
            // snapshot usually already carries them; the extra map is what makes a
            // model PATCH accepted during an interrupted run durable.
            if (record.agentModels !== undefined) {
                for (const [agent, model] of Object.entries(record.agentModels)) {
                    const brain = harness.agents[agent];

                    if (brain === undefined) {
                        throw new Error(
                            `the saved agent model map names "${agent}", which is not part of this harness.`
                        );
                    }

                    brain.model(model);
                }
            }

            // F1 distribution: every restored queued turn belongs to the lane of
            // the thread it names (now that `restore` recreated those threads), or
            // to the legacy queue when the harness/thread predates the API. No pump
            // is started: the backlog stays paused until an explicit submit.
            if (queue.length > 0 && this.threadsSupported(session)) {
                const legacy: SessionTurn[] = [];

                for (const turn of queue) {
                    const threadId = turn.threadId;

                    if (threadId !== undefined && harness.thread(threadId) !== undefined) {
                        let lane = session.lanes.get(threadId);

                        if (lane === undefined) {
                            lane = { threadId, queue: [], pumping: false, stopRequested: false };
                            session.lanes.set(threadId, lane);
                        }

                        lane.queue.push(turn);
                        continue;
                    }

                    legacy.push(turn);
                }

                session.queue = legacy;
            }

            // Now idle: capture the authoritative post-restore snapshot (it also
            // records the model map above) as this session's committed state.
            session.core = harness.snapshot();
            this.sessions.set(session.id, session);

            // R4: merge the durable per-step log into the checkpointed turns and fold
            // the compiled display state ONCE here (not per request). A legacy
            // document without a journal directory keeps its checkpoint events exactly
            // as written, so an old database restores unchanged.
            this.restoreProjections(session);
        } catch (error) {
            // R6/R7: the caller decides. `restoreSession` itself stays strict — a
            // direct restore failure is a real error with the file path and the
            // underlying reason in its message — but the load loop turns it into a
            // per-session drop so one stale record cannot abort the whole server.
            throw new HarnessPersistenceError(
                this.persistence?.file ?? '',
                `${location} could not be restored: ${messageOf(error)}`
            );
        }
    }

    // Reporting for one session the load loop dropped (R7: the failure stays
    // observable even though it no longer throws). Same shape as
    // `notePersistenceError`: keep the message, hand it to the injected reporter,
    // and fall back to stderr when the host did not inject one. A reporter that
    // throws must never turn a dropped session into a startup crash.
    private noteRestoreError(value: unknown): void {
        const error = value instanceof Error ? value : new Error(messageOf(value));
        this.restoreFailures.push(error.message);

        if (this.onRestoreError !== undefined) {
            try {
                this.onRestoreError(error);
            } catch {
                // Observability only; the drop already happened.
            }

            return;
        }

        console.error(`[harness] skipped an unrestorable saved session: ${error.message}`);
    }

    // Called before a stream is opened so a busy session is rejected with a real
    // JSON status, not an SSE frame. `busy` (not `status`) is checked because a
    // manual tool call also holds the session without becoming a turn. A pending
    // queue also rejects the legacy path: /messages owns its run via the response,
    // and it must not jump ahead of, or interleave with, tasks already accepted by
    // POST /tasks. Clients that want to submit while work is pending use /tasks.
    assertRunnable(id: string): void {
        const session = this.require(id);

        // R1-R6: a live thread run (or any accepted-but-unstarted work anywhere)
        // also blocks the legacy response-owned path, which keeps its historical
        // "one fresh block at a time" semantics. Without a thread this is exactly
        // the previous busy/queue check.
        if (this.busyOrPending(session)) {
            throw new SessionError(409, 'A task is already running in this session.');
        }
    }

    // Run one REGISTERED tool inside a session's harness (R8).
    //
    // This is the server path behind `POST /tools/:name` when the caller supplies a
    // sessionId: the core tools (toolRequest/toolCreate/task/delegate) have
    // no standalone implementation, so they must execute against the harness the
    // session owns — a manual discovery or todo call then affects the very
    // conversation the user is looking at. Registered, non-core tools are also
    // reachable here if a client asks (they run the same implementation either
    // way); the API keeps their direct runner for session-less calls.
    //
    // Failure mapping is the caller's job (src/server/api.ts):
    //   - unknown session            → SessionError 404 (require)
    //   - session busy (run/manual)  → SessionError 409 (single-flight gate)
    //   - tool absent from the run   → SessionError 404 (delegate without subagents)
    //   - the tool itself throws     → whatever it throws (reported as ok:false)
    //
    // `parameters` is the value `execute` receives, i.e. already unwrapped by the
    // single-property rule — exactly like the direct tool callable.
    async callTool(id: string, name: string, parameters: unknown): Promise<unknown> {
        const session = this.require(id);

        // A manual core call mutates harness state (enabled tools, created tools,
        // the todo list, a subagent turn). Letting it interleave with a streaming
        // run would make that run's transcript internally inconsistent, so it is
        // rejected like a second submitted task rather than queued.
        //
        // The same holds for a SECOND manual call: an async `delegate` holds the
        // session across awaits, so without this check two manual mutations (or a
        // reset) could interleave even though `status` was never `running`.
        //
        // A non-empty QUEUE rejects too: queued tasks are already accepted work for
        // this harness, and a manual mutation would change state they will run
        // against. The pump would otherwise have to interleave two owners.
        if (this.busyOrPending(session)) {
            throw new SessionError(409, 'A task is running in this session; try again when it finishes.');
        }

        // The session's own registry decides what exists. `executeTool` would also
        // throw, but this check gives the caller a lookup status (404) with a
        // sentence that names the real reason instead of a generic harness error.
        // It runs BEFORE the busy flag is taken so a 404 does not touch the gate.
        if (session.harness.tools[name] === undefined) {
            throw new SessionError(404, `Tool "${name}" is not available in this session.`);
        }

        session.busy = true;

        try {
            // A manual call is NOT a turn: no SessionTurn, no events, and no change
            // to `status`. Only the private `busy` flag exists while it runs.
            //
            // T5 (D1): in worker mode the body still runs OFF the event loop - on this
            // session's operator lane - and every shared operation it performs is routed to
            // the authority, so a manual mutation lands in the canonical harness exactly like
            // an inline one and is persisted by the code below.
            const result = this.workerExecution
                ? await this.lanes().invoke({
                      sessionKey: session.id,
                      authority: this.authorityOf(session),
                      request: { op: 'execute:tool', name, parameters },
                      blueprint: this.blueprintFor(session)
                  })
                : await session.harness.executeTool(name, parameters);

            // The tool may have mutated the todo/record stores, discovery, or the
            // created-tool registry. Persist that before the caller sees success:
            // an acknowledged manual mutation must survive a restart.
            session.core = session.harness.snapshot();
            await this.persistOrThrow();

            return result;
        } finally {
            // Success, a throwing tool, and a rejected execute all release the
            // gate here, so a later run/reset/manual call resumes. The queue pump
            // may be parked on this gate, so wake it: it re-checks and continues
            // with the same FIFO head.
            session.busy = false;
            this.releaseBusy(session);
        }
    }

    // Every invocation this server observed running in ONE persistent conversation,
    // oldest first, for the roster's `invocationIds` join (R3).
    //
    // Source of truth is `session.invocationThreads`, written when a run's `start`
    // frame names its invocation (noteInvocationThread, line ~3920) and persisted
    // with the session, so the ORIGINAL delegated run and every later resume are all
    // present — including after a restart. Only this session's map is read, and only
    // entries mapped to THIS thread are kept, so a sibling's or another session's
    // history can never leak into the roster.
    //
    // `record.invocationId` (the latest run) and the roster's `originInvocationId`
    // are folded in when the map does not already name them: a legacy document whose
    // map is empty/absent then still reports what its runtime record knows. The result
    // is deduplicated, because a resume observed twice must not appear twice.
    private invocationIdsOf(
        session: Session,
        record: HarnessThreadRecord,
        originInvocationId: string | undefined
    ): string[] {
        const ids: string[] = [];
        const seen = new Set<string>();
        const push = (invocationId: string | undefined): void => {
            if (invocationId === undefined || invocationId.length === 0) return;
            if (seen.has(invocationId)) return;

            seen.add(invocationId);
            ids.push(invocationId);
        };

        // Map iteration order is observation order, so the card's ORIGINAL run comes
        // before the continuations that advanced the single `invocationId` slot.
        for (const [invocationId, threadId] of session.invocationThreads) {
            if (threadId === record.id) push(invocationId);
        }

        push(record.invocationId);
        push(originInvocationId);

        return ids;
    }

    // R1-R6 roster: every HOST thread (an agent's default conversation is internal
    // plumbing and stays out of the wire shape). Each entry joins the runtime
    // record to the recorded turns:
    //   - originTurnId/originInvocationId: the first turn that ran in the thread and
    //     the invocation id its root run reported, so a client can anchor the
    //     conversation in the legacy turn timeline;
    //   - invocationIds: EVERY invocation observed in the thread (oldest first), so
    //     a historical invocation card still joins this conversation after a resume;
    //   - references: the result blocks the thread's turns consumed (the "#" links);
    //   - messages: the thread's own committed transcript, so a focused UI can
    //     render one conversation without filtering the whole turn list.
    private threadRoster(session: Session): SessionThread[] {
        if (!this.threadsSupported(session)) return [];

        // R8: make sure every conversation has its stable display label before the
        // roster is built (a pre-R8 document derives them here, in turn order).
        this.ensureThreadLabels(session);

        const hostThreads = session.harness.threads().filter((record) => record.origin === 'host');

        if (hostThreads.length === 0) return [];

        const ordered = [...session.turns].sort((left, right) => left.index - right.index);

        return hostThreads.map((record: HarnessThreadRecord) => {
            const owned = ordered.filter((turn) => turn.threadId === record.id);
            const first = owned[0];

            // Deduplicate the links by (turn, thread, label): the same block
            // referenced by two turns of this thread is one edge in the graph.
            const references: AgentResultReference[] = [];
            const seen = new Set<string>();

            for (const turn of owned) {
                for (const reference of turn.references ?? []) {
                    const key = `${reference.turnId}\u0000${reference.threadId ?? ''}\u0000${reference.label}`;
                    if (seen.has(key)) continue;

                    seen.add(key);
                    references.push({ ...reference });
                }
            }

            const originInvocationId =
                first === undefined ? undefined : session.turnInvocations.get(first.id);

            // R3: the FULL invocation roster of this conversation, not just the
            // latest one. A delegated child's card was created by its ORIGINAL run
            // (`invocationId` at the time); once the child is resumed that slot
            // advances, so a client could not join the card any more — and a fresh
            // hydration had no way back. `session.invocationThreads` already records
            // every invocation observed in a conversation (for the F6 purge) and is
            // persisted, which makes it the authoritative, restart-safe join.
            const invocationIds = this.invocationIdsOf(session, record, originInvocationId);

            // F2: reference EDGES, derived from the recorded turns. A connection is
            // never ownership, so it names the source conversations without making
            // this one a child of them.
            const connectedThreadIds = [
                ...new Set(
                    references
                        .map((reference) =>
                            session.turns.find((turn) => turn.id === reference.turnId)
                        )
                        .map((turn) => turn?.threadId)
                        .filter((threadId): threadId is string => threadId !== undefined)
                )
            ].filter((threadId) => threadId !== record.id);

            return {
                ...record,
                // The DISPLAY name is the session's conversation label, never the
                // runtime's optional free-text label and never the global creation
                // ordinal (`T8`). IDs remain opaque; this is what the UI shows.
                label: this.ensureThreadLabel(session, record.id, record.agent),
                ...(first === undefined ? {} : { originTurnId: first.id }),
                ...(originInvocationId === undefined ? {} : { originInvocationId }),
                // Omitted while nothing was recorded (a legacy document), so every
                // pre-existing roster shape stays byte-identical and a client that
                // does not know the field is unaffected.
                ...(invocationIds.length === 0 ? {} : { invocationIds }),
                ...(references.length === 0 ? {} : { references }),
                ...(connectedThreadIds.length === 0 ? {} : { connectedThreadIds }),
                // Always present (possibly empty): a focused UI can render "no
                // messages yet" without a second request.
                messages: session.harness.threadMessages(record.id)
            };
        });
    }

    private snapshot(session: Session): SessionSnapshot {
        const threads = this.threadRoster(session);
        // Pending backlog across every lane plus the legacy queue (F1). The active
        // turn is never counted.
        const pending = this.pendingCount(session);

        return {
            id: session.id,
            harness: session.preset.name,
            status: session.status,
            // Omitted when empty so a drained session keeps the pre-queue shape.
            ...(pending === 0 ? {} : { queueDepth: pending }),
            model: session.harness.agent.model(),
            // Per-agent models THIS session runs (R9), frozen with the harness: an
            // override from the preset, otherwise the session's settings.model. A
            // UI can therefore render every agent's model after a reload, and a
            // later PATCH cannot rewrite what this session reports.
            agentModels: Object.fromEntries(
                Object.entries(session.harness.agents).map(([name, brain]) => [name, brain.model()])
            ),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messages: copyMessages(session.harness.agent.messages),
            turns: copyTurns(session.turns),
            // Omitted entirely when the session owns no host thread, so every
            // pre-thread snapshot keeps its exact shape.
            ...(threads.length === 0 ? {} : { threads }),
            // C4: conversations whose stored transcript could not be read. Omitted
            // when there are none, so a healthy session's snapshot is byte-identical
            // to its pre-C4 shape. Sorted by thread id so the same session always
            // serialises the same way (deterministic tests and SSE repaints).
            ...(session.invalidThreads.size === 0
                ? {}
                : {
                      invalidThreads: [...session.invalidThreads]
                          .sort(([left], [right]) => left.localeCompare(right))
                          .map(([id, entry]): SessionInvalidThread => ({
                              id,
                              ...(entry.label === undefined ? {} : { label: entry.label }),
                              ...(entry.agent === undefined ? {} : { agent: entry.agent }),
                              error: entry.error,
                              // Verbatim, never normalised: this is the text the
                              // operator has to fix. C8-m7: copied, so a snapshot
                              // consumer (the SSE frame, `store.get()`) cannot mutate
                              // the stored raw value through the object it was handed.
                              messages: copyInvalidMessages(entry.messages)
                          }))
                  }),
            ...(session.labelSeeds.size === 0
                ? {}
                : {
                      labelSeeds: Object.fromEntries(
                          [...session.labelSeeds].map(([turnId, seed]) => [turnId, { ...seed }])
                      )
                  }),
            // Tombstone counters only (never content): a client can show that a
            // retired label will not be re-minted after a deletion.
            ...(session.labelHighWater.size === 0
                ? {}
                : { labelHighWater: Object.fromEntries([...session.labelHighWater]) }),
            harnessDefinition: copyDescriptor(session.definition),
            discoveredTools: [...session.harness.discoveredTools],
            ...(session.lastError !== undefined ? { lastError: session.lastError } : {})
        };
    }

    get(id: string): SessionSnapshot {
        return this.snapshot(this.require(id));
    }

    list(): SessionSnapshot[] {
        return [...this.sessions.values()].map((session) => this.snapshot(session));
    }

    // -----------------------------------------------------------------------
    // The compiled display surface (R1/R3/R4)
    //
    // Everything below reads the PER-TURN projection cache, never the raw event
    // copy: a compact response must not cost a raw `get()`/`list()`. The cache is
    // updated by the recorder as events are stored, and rebuilt from the durable
    // journal at restore, so no request ever folds anything.
    // -----------------------------------------------------------------------

    // What the fold needs that is NOT inside one turn record: the entry agent (for
    // `role`), the invocation→conversation label join (R8/T14), the invocation→
    // CONVERSATION join (R18/T18), the answer-route expiry set (N4), and the store's
    // own block projection (labels are the store's, so the fold must not re-mint them).
    private displayContext(session: Session): DisplayProjectContext {
        // What the store had already allocated when this fold was built. Every entry is
        // keyed by INVOCATION id (the fold's only key space), and it covers all three of
        // the store's joins: a delegated conversation's run, a turn's root run, and a
        // host conversation's own latest run (see `invocationThreadLabels`).
        const knownLabels = new Map<string, string>();

        // R8/T14: ADOPT persisted conversation labels before anything mints one.
        // `invocationThreadLabels` allocates for a thread whose name is not recorded,
        // and a restored document adopts its surviving names on the first roster read
        // (see `ensureThreadLabels` → `adoptPersistedLabels`). Building the fold
        // context without that adoption would consume the ordinal a restored `RR3`
        // still owns and hand the survivor `RR4`.
        this.ensureThreadLabels(session);

        for (const [invocationId, label] of Object.entries(this.invocationThreadLabels(session))) {
            knownLabels.set(invocationId, label);
        }

        // R18/T20: the label join is a LIVE view, exactly like `invocationThreadIds`
        // below, and for the same reason — a projector is built ONCE per turn
        // (`projectorFor`, line ~2867) while a delegated conversation is created in the
        // MIDDLE of that turn.
        //
        // WHY IT MATTERS (the gap this closes): a copied map is frozen at the turn's
        // first event, so `createChild`/`adoptPlaceholder` folded the delegated section
        // with `agentLabel: ''` (`conversationLabelOf` misses), and the row only received
        // `HR1` after a restart, when the cold replay read the fully allocated map. The
        // label is the id a user types (`#HR1`) and the name every later turn, roster row
        // and `#` reference has to repeat (R18), so a live board showing a DIFFERENT name
        // than the durable record shows is not a cosmetic difference.
        //
        // WHY A VIEW AND NOT A SECOND MAP: allocation stays the store's single canonical
        // sequence (`ensureThreadLabel` → `nextConversationOrdinal`, T14/F1). The eager
        // half answers every lookup that was already knowable at fold-build time; the live
        // half (`liveThreadLabel`) resolves a conversation the store joined after that
        // point, reading through the SAME in-place maps (`invocationThreads` →
        // `threadLabels`) that the persisted record is written from. A live fold therefore
        // mints the name at the delegated run's OWN `start` frame (the recorder writes the
        // join immediately before folding, line ~5510/5530) and the persisted document
        // carries that exact value, so a cold replay needs no minting and live ≡ replay by
        // construction rather than by coincidence of read order.
        //
        // The fold reads this map through `get` alone (../turn-projector.ts
        // `conversationLabelOf`); the enumerable half is the frozen snapshot, which is the
        // honest answer for `size`/iteration ("labels allocated when this fold was built")
        // and is documented here because a future consumer that iterates must know it does
        // not see a mid-turn arrival.
        const threadLabels: ReadonlyMap<string, string> = {
            get size(): number {
                return knownLabels.size;
            },
            get: (invocationId: string): string | undefined =>
                knownLabels.get(invocationId) ?? this.liveThreadLabel(session, invocationId),
            has: (invocationId: string): boolean =>
                knownLabels.has(invocationId) || this.liveThreadLabel(session, invocationId) !== undefined,
            forEach: (
                callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
                thisArg?: unknown
            ): void => {
                for (const [invocationId, label] of knownLabels) callback.call(thisArg, label, invocationId, threadLabels);
            },
            // The iterator members are deliberately left unannotated: the emitted lib
            // types them as `MapIterator<…>` (which carries `Symbol.dispose`), and writing
            // `IterableIterator<…>` here would narrow the interface and fail `tsc`.
            keys: () => knownLabels.keys(),
            values: () => knownLabels.values(),
            entries: () => knownLabels.entries(),
            [Symbol.iterator]: () => knownLabels.entries()
        };

        return {
            primary: session.definition.primary,
            threadLabels,
            // R18/T18: the invocation → persistent conversation join, handed to the fold
            // as the LIVE map instance — deliberately NOT a snapshot copy.
            //
            // WHY LIVE: a projector is created ONCE per turn and cached (`projections`,
            // line ~548), while this map keeps growing during the run — a delegated
            // child's entry is written at ITS OWN `start` frame (line ~5484), long after
            // the root's first event built this context. A copied map would therefore be
            // frozen at turn start, every delegated child of a live turn would be folded
            // without a conversation id, and the fold would have to guess one. Reading
            // through the live instance is also what makes a cold replay produce the
            // value at the SAME point: restore re-folds with the fully loaded map
            // (`foldProjections` → `displayContext`), so live and replay agree exactly.
            //
            // WHY SAFE TO SHARE: `invocationThreads` is only ever mutated IN PLACE
            // (`set`/`delete`/`clear`; a purge deletes, a restart rebuilds the Session and
            // its projection cache together, line ~2298/2320) and never reassigned, so a
            // cached projector can never be left holding a detached map. If a future
            // restore ever replaces the field instead of filling it in place — the rule
            // `restoreCounterMap` (line ~4056) documents for the label maps — the
            // projector cache must be rebuilt in the same step.
            //
            // The fold reads it as a `ReadonlyMap`: the join is the store's authority
            // (the roster's `SessionThreadView.invocationIds`, protocol.ts:437, is the
            // same map projected per thread), so the projector adopts it verbatim and
            // mints nothing of its own.
            invocationThreadIds: session.invocationThreads,
            expiredRequestIds: new Set(session.completedActions),
            // The callback is handed the LIVE turn record the projector holds, so the
            // cast is exact (see `DisplayTurnInput`, ../shared/turn-display.ts).
            blocksOf: (turn) => this.blocksFor(session, turn as unknown as SessionTurn),
            // T9/T10: the frozen per-turn instruction sources (see
            // `noteInstructionSource`). A turn with no recorded source gets NO system
            // segment — the fold never substitutes today's catalogue text for evidence
            // the record does not hold (a legacy document therefore has no system
            // segment, honestly, instead of a fabricated count).
            instructionSourcesOf: (turn) =>
                session.turnInstructionSources.get((turn as unknown as SessionTurn).id)
        };
    }

    // Freeze the instruction text an agent ACTUALLY runs with — once per turn, per
    // agent (see the field on `Session`, and `TurnInstructionSource` for why this is
    // recorded instead of derived).
    //
    // Called BEFORE the turn-start checkpoint and again for every recorded `start`
    // frame, so:
    //   - the entry agent's source is durable before provider time is spent, and an
    //     interrupted turn rebuilds its system segment with the same counts after a
    //     restart (R4);
    //   - a delegated child's agent is captured at its own first frame, so a preset
    //     edit made mid-session cannot retro-mutate an older turn's recorded metadata
    //     (R6).
    private noteInstructionSource(session: Session, turnId: string, agent: string): void {
        const recorded = session.turnInstructionSources.get(turnId);

        if (recorded?.some((entry) => entry.agent === agent)) return;

        const instructions = session.harness.agents?.[agent]?.instructions;

        // `undefined`/non-array means NO evidence for this name (an unknown agent, or
        // a runtime without the accessor). An EMPTY list IS evidence — the agent runs
        // with no system message — and is recorded so the segment reports zero
        // characters rather than disappearing.
        if (!Array.isArray(instructions)) return;

        const source: TurnInstructionSource = {
            agent,
            instructions: instructions.map((entry) => (typeof entry === 'string' ? entry : '')),
            at: Date.now()
        };

        session.turnInstructionSources.set(turnId, [...(recorded ?? []), source]);
    }

    // One turn's result blocks, memoized by the inputs the projection reads. Without
    // this, a rail refresh would re-walk every event of every turn — the exact cost
    // the compact surface exists to remove.
    private blocksFor(session: Session, turn: SessionTurn): readonly AgentResultBlock[] {
        const stamp = `${turn.status}:${turn.updatedAt}:${turn.events.length}`;
        const cached = session.blockCache.get(turn.id);

        if (cached !== undefined && cached.stamp === stamp) return cached.blocks;

        const blocks = listAgentResultBlocks(this.projectionTurns(session, [turn]));
        session.blockCache.set(turn.id, { stamp, blocks });

        return blocks;
    }

    // The live projector for one turn, folded on first use so a queued turn (no
    // events yet) and a restored turn (a full history) both have a row immediately.
    private projectorFor(session: Session, turn: SessionTurn): TurnProjector {
        const existing = session.projections.get(turn.id);
        if (existing !== undefined) return existing;

        const projector = createTurnProjector(turn, this.displayContext(session));

        for (let index = 0; index < turn.events.length; index += 1) {
            projector.apply(turn.events[index], turn.eventTimes?.[index] ?? 0, index);
        }

        if (isTerminalTurnStatus(turn.status)) {
            projector.settle(turn.status, turn.updatedAt);
        }

        session.projections.set(turn.id, projector);

        return projector;
    }

    // Compiled artifacts must die with their turn (reset, thread deletion, session
    // removal) or a stale tree could outlive the record it was folded from.
    private forgetProjections(session: Session, turnIds: Iterable<string>): void {
        for (const id of turnIds) {
            session.projections.delete(id);
            session.blockCache.delete(id);
        }
    }

    // Full compiled state of one session: header + rows + node trees.
    private viewOf(session: Session): SessionView {
        const turns: SessionView['turns'] = [];
        const displays: Record<string, TurnDisplay> = {};

        for (const turn of session.turns) {
            const projector = this.projectorFor(session, turn);

            turns.push(projector.summary());
            displays[turn.id] = projector.display();
        }

        const pending = this.pendingCount(session);
        const threads = this.threadRoster(session);

        return {
            id: session.id,
            harness: session.preset.name,
            status: session.status,
            ...(pending === 0 ? {} : { queueDepth: pending }),
            model: session.harness.agent.model(),
            agentModels: Object.fromEntries(
                Object.entries(session.harness.agents).map(([name, brain]) => [name, brain.model()])
            ),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
            // ROSTER, NOT TRANSCRIPT: the view ships the compact thread identity and
            // deliberately OMITS the raw `threads` roster (whose `messages` are the
            // committed transcript, i.e. every tool result verbatim — the payload
            // class this change removes). `SessionThreadView` carries identity + a
            // bounded preview; the transcript itself is one lazy route away
            // (GET /views/:id/threads/:threadId/transcript), which is exactly when the
            // UI has shown a transcript dialog.
            ...(threads.length === 0 ? {} : { threadViews: threadViewsOf(threads) }),
            ...(session.invalidThreads.size === 0
                ? {}
                : {
                      invalidThreads: [...session.invalidThreads]
                          .sort(([left], [right]) => left.localeCompare(right))
                          .map(([id, entry]): SessionInvalidThread => ({
                              id,
                              ...(entry.label === undefined ? {} : { label: entry.label }),
                              ...(entry.agent === undefined ? {} : { agent: entry.agent }),
                              error: entry.error,
                              messages: copyInvalidMessages(entry.messages)
                          }))
                  }),
            ...(session.labelSeeds.size === 0
                ? {}
                : {
                      labelSeeds: Object.fromEntries(
                          [...session.labelSeeds].map(([turnId, seed]) => [turnId, { ...seed }])
                      )
                  }),
            ...(session.labelHighWater.size === 0
                ? {}
                : { labelHighWater: Object.fromEntries([...session.labelHighWater]) }),
            // Instruction text is deliberately absent here (see `viewDescriptorOf`):
            // the bar's `system` segment carries the COUNT, and the exact text is one
            // block detail away.
            harnessDefinition: viewDescriptorOf(session.definition),
            discoveredTools: [...session.harness.discoveredTools],
            turns,
            displays
        };
    }

    // The rail document: header + rows, NO trees. This is what makes `listViews()`
    // cheap where `list()` copies every event of every session.
    private viewSummaryOf(session: Session): SessionViewSummary {
        const turns: SessionViewSummary['turns'] = [];

        for (const turn of session.turns) turns.push(this.projectorFor(session, turn).summary());

        const pending = this.pendingCount(session);
        const threads = this.threadRoster(session);

        return {
            id: session.id,
            harness: session.preset.name,
            status: session.status,
            ...(pending === 0 ? {} : { queueDepth: pending }),
            model: session.harness.agent.model(),
            agentModels: Object.fromEntries(
                Object.entries(session.harness.agents).map(([name, brain]) => [name, brain.model()])
            ),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
            ...(threads.length === 0 ? {} : { threadViews: threadViewsOf(threads) }),
            ...(session.labelHighWater.size === 0
                ? {}
                : { labelHighWater: Object.fromEntries([...session.labelHighWater]) }),
            harnessDefinition: viewDescriptorOf(session.definition),
            discoveredTools: [...session.harness.discoveredTools],
            turns
        };
    }

    getView(id: string): SessionView {
        return this.viewOf(this.require(id));
    }

    listViews(): SessionViewSummary[] {
        return [...this.sessions.values()].map((session) => this.viewSummaryOf(session));
    }

    // The lazy detail lookup: the EXACT recorded opening event and, when one was
    // recorded, the matching settled event. Served from the durable turn record
    // (`turn.events`), so the bytes are verbatim before and after a restart, and the
    // pairing comes from the projection that made them addressable — a `callId`
    // reused by a nested invocation of the same turn resolves to its own pair.
    stepDetail(id: string, turnId: string, stepId: string): TurnStepDetail {
        const session = this.require(id);
        const turn = session.turns.find((candidate) => candidate.id === turnId);

        if (turn === undefined) throw new SessionError(404, `Unknown turn "${turnId}" in session "${id}".`);
        if (typeof stepId !== 'string' || !/^\d+$/.test(stepId)) {
            throw new SessionError(400, 'A step id must be the recorded event index of the step.');
        }

        const index = Number(stepId);

        if (!Number.isInteger(index) || index < 0 || index >= turn.events.length) {
            throw new SessionError(404, `Unknown step "${stepId}" in turn "${turnId}".`);
        }

        // The step's own record supplies the section (identity scoping) and the
        // settled event's index; the events themselves come from the raw record.
        const display = this.projectorFor(session, turn).display();
        let sectionId: string | undefined;
        let resultStepId: string | undefined;
        let callId: string | undefined;

        for (const section of display.sections) {
            for (const node of section.nodes) {
                if (node.kind !== 'tool' && node.kind !== 'action') continue;
                if (node.id !== stepId) continue;

                sectionId = section.id;
                resultStepId = node.detail.resultStepId;
                callId = node.callId;
                break;
            }
            if (sectionId !== undefined) break;
        }

        if (sectionId === undefined) throw new SessionError(404, `Unknown step "${stepId}" in turn "${turnId}".`);

        const event = turn.events[index];
        const times = turn.eventTimes;

        const detail: TurnStepDetail = {
            sessionId: session.id,
            turnId,
            stepId,
            sectionId,
            ...(typeof callId === 'string' && callId.length > 0 ? { callId } : {}),
            opening: {
                index,
                ...(finiteAt(times?.[index]) ? { at: times[index] } : {}),
                event: copyEvent(event)
            }
        };

        const resultIndex = resultStepId === undefined ? undefined : Number(resultStepId);

        if (
            resultIndex !== undefined &&
            Number.isInteger(resultIndex) &&
            resultIndex >= 0 &&
            resultIndex < turn.events.length &&
            resultIndex !== index
        ) {
            detail.result = {
                index: resultIndex,
                ...(finiteAt(times?.[resultIndex]) ? { at: times[resultIndex] } : {}),
                event: copyEvent(turn.events[resultIndex])
            };
        }

        return detail;
    }

    // The lazy context-bar lookup (R8): ONE segment answered with its EXACT recorded
    // bytes. The METADATA comes from the compiled bar itself, so an answer can never
    // disagree with the segment that was clicked; the PAYLOAD comes from the durable
    // turn record (the segment's own recorded event range, the turn's prompt, the steer
    // it was minted from, or the recorded instruction source). Nothing here re-reads a
    // preview, so the route answers identically live, after a restart, and for a session
    // folded from a checkpoint whose journal is gone.
    blockDetail(id: string, turnId: string, blockId: string): TurnBlockDetail {
        const session = this.require(id);
        const turn = session.turns.find((candidate) => candidate.id === turnId);

        if (turn === undefined) throw new SessionError(404, `Unknown turn "${turnId}" in session "${id}".`);

        if (typeof blockId !== 'string' || blockId.length === 0) {
            throw new SessionError(400, 'A context block id must be the server-minted segment id.');
        }

        const display = this.projectorFor(session, turn).display();
        const section = display.sections.find((entry) => entry.context?.some((segment) => segment.id === blockId));
        const block = section?.context?.find((segment) => segment.id === blockId);

        if (section === undefined || block === undefined) {
            // Either it was never minted, or it belonged to a discarded attempt and was
            // removed by id — both are honest 404s, never a synthesized body.
            throw new SessionError(404, `Unknown context block "${blockId}" in turn "${turnId}".`);
        }

        const payload = blockPayloadOf(turn, section.agent, block, session.turnInstructionSources.get(turn.id));

        // T14: a steered segment's ONLY purpose is to answer with the text the user typed.
        // If the record cannot name that submit, this route must not answer "success" with
        // a body-less detail: the reader clicked a segment and got an empty panel. With the
        // durable text archive (../server/protocol.ts `SessionTurn.steerTexts`) every submit
        // the bar draws is resolvable, so this is the legacy-document case — a submit whose
        // audit entry the 64-entry ring has already truncated and that predates the archive.
        // A 404 says "this segment's text is not in this document", which the board shows as
        // an unavailable detail instead of an empty one.
        if (block.kind === 'user' && block.name === 'steer' && !('text' in payload)) {
            throw new SessionError(
                404,
                `The text of steered segment "${blockId}" is not in this turn's record.`
            );
        }

        return {
            ...block,
            sessionId: session.id,
            ...payload
        };
    }

    // The whole recorded turn, verbatim — the transcript copy/export surface, which
    // quotes raw events by design. Never part of the normal render path.
    rawTurn(id: string, turnId: string): SessionTurn {
        const session = this.require(id);
        const turn = session.turns.find((candidate) => candidate.id === turnId);

        if (turn === undefined) throw new SessionError(404, `Unknown turn "${turnId}" in session "${id}".`);

        return copyTurn(turn);
    }

    // Register a display observer. Same contract as `watch()`: the initial frame is
    // captured atomically with registration, `unsubscribe` detaches only, and never
    // cancels a task (the pump owns execution).
    watchView(id: string, emit: EmitView, close: () => void = () => {}): SessionViewWatch {
        const session = this.require(id);
        const watcher: ViewWatcher = { emit, close };

        session.viewWatchers.add(watcher);

        return {
            view: this.viewOf(session),
            unsubscribe: () => {
                session.viewWatchers.delete(watcher);
            }
        };
    }

    // Fan a display frame out. Same isolation rule as `publish`: every watcher gets
    // its OWN deep copy, a throwing or slow watcher is dropped, and nothing here can
    // cancel a turn or block the pump.
    private publishView(session: Session, item: SessionViewStreamItem): void {
        if (session.disposed || session.viewWatchers.size === 0) return;

        for (const watcher of [...session.viewWatchers]) {
            let frame: SessionViewStreamItem;

            try {
                frame = JSON.parse(JSON.stringify(item)) as SessionViewStreamItem;
            } catch {
                continue;
            }

            try {
                const result: unknown = watcher.emit(frame);

                if (result instanceof Promise) {
                    void result.catch(() => {
                        session.viewWatchers.delete(watcher);
                    });
                }
            } catch {
                session.viewWatchers.delete(watcher);
            }
        }
    }

    // The recorder's ops path: one `ops` frame per recorded event group.
    private publishViewOps(session: Session, turnId: string, at: number, ops: TurnDisplayOp[]): void {
        if (ops.length === 0) return;

        // T16: the ops list the recorder ALREADY produced rides to the hub by reference, so a
        // live display update adds no fold, no copy, and no snapshot to the run - and the
        // `turn_display` counter moves in the same instant the frame is fanned out.
        this.notifyStream({ kind: 'display.ops', sessionId: session.id, turnId, ops, at });

        this.publishView(session, { type: 'ops', turnId, at, ops });
    }

    // Mirror a RAW frame to the display surface. The raw stream is untouched (CLI,
    // embedders, existing tests); this is the only place a view frame is derived,
    // which is what keeps every lifecycle transition (queued/running/terminal,
    // command turns, cancel, thread and transcript mutations) covered for free.
    private mirrorView(session: Session, item: SessionStreamItem): void {
        if (session.disposed) return;

        // An observer count only gates the FAN-OUT and the expensive full-view build:
        // the projection state itself must settle on every transition, or a later
        // `getView` (a poll, a reload, a second tab) would serve a turn that already
        // ended with rows still "streaming".
        const watching = session.viewWatchers.size > 0;

        if (item.type === 'turn') {
            // The frame carries a COPY; the projection cache is keyed by the live
            // record (the projector reads status/updatedAt/usage off it).
            const live = session.turns.find((turn) => turn.id === item.turn.id);

            if (live === undefined) return;

            const projector = this.projectorFor(session, live);
            const ops: TurnDisplayOp[] = [];

            // A terminal turn must settle its rows the same way the live run's
            // terminal frame did; `settle` is idempotent, so a repeat emits nothing
            // beyond the row itself.
            if (isTerminalTurnStatus(item.turn.status)) {
                ops.push(...projector.settle(item.turn.status, item.turn.updatedAt));
            } else {
                ops.push({ op: 'turn', turnId: item.turn.id, summary: projector.summary() });
            }

            if (watching) this.publishViewOps(session, item.turn.id, item.turn.updatedAt, ops);

            return;
        }

        // A terminal/drain frame needs the whole compiled view, which is a full deep
        // copy: build it only for an observer that is actually waiting for it.
        if (!watching) return;

        if (item.type === 'snapshot') {
            this.publishView(session, { type: 'view', view: this.viewOf(session) });
            return;
        }

        if (item.type === 'failed') {
            this.publishView(session, { type: 'failed', error: item.error, view: this.viewOf(session) });
        }

        // `item.type === 'event'` needs no mirror: the recorder produced that event's
        // display ops already, and re-deriving them here would double-apply.
    }

    // -----------------------------------------------------------------------
    // Durable per-step journal (R4)
    // -----------------------------------------------------------------------

    // The journal exists only when the host runs with a database root; an in-memory
    // store keeps its previous (memory-only) behaviour exactly.
    private attachJournal(session: Session): HarnessJournal | undefined {
        if (this.persistence === undefined) return undefined;
        if (session.journal !== undefined) return session.journal;

        // D4: in worker mode the coordinator builds a READER only. `open()` is a write (it
        // creates the directory and appends the header line), and `append`/`flush`/`rewrite`
        // need the held fd - which the worker owns. Two append handles on one file are two
        // writers, so the store keeps this instance for `read()`/`exists()` (restore-side
        // merges, which stay synchronous by design) and asks the worker to open the log
        // through the queue.
        if (this.io !== undefined) {
            session.journal = new HarnessJournal(this.persistence.directory, session.id);
            this.io.queueJournalOpen(session.id);

            const queuedError = this.io.journalError(session.id);

            if (queuedError !== undefined) this.noteJournalError(session, `could not open the event journal: ${queuedError}`);

            return session.journal;
        }

        const journal = new HarnessJournal(this.persistence.directory, session.id);

        journal.open();
        session.journal = journal;

        const error = journal.error;

        if (error !== undefined) this.noteJournalError(session, `could not open the event journal: ${error}`);

        return journal;
    }

    private journalAppend(
        session: Session,
        turnId: string,
        index: number,
        at: number,
        event: HarnessEvent
    ): void {
        // A removed/disposed session must not resurrect its own log: an in-flight run
        // can still record after `remove()` deleted the session (the same rule that
        // suppresses its publishes).
        if (session.disposed) return;

        // D4: the event recorder runs on EVERY progress frame, so this stays synchronous in
        // both modes. The append is posted in call order - the recorder's order IS the file's
        // order - and the receipt ('written', not 'durable') arrives later. Durability of the
        // tail is the terminal commit's fence or a `journal.flush`, never this call.
        if (this.io !== undefined) {
            this.io.queueJournalAppend(session.id, { turnId, index, at, event });

            const queuedError = this.io.journalError(session.id);

            if (queuedError !== undefined) this.noteJournalError(session, `could not append to the event journal: ${queuedError}`);

            return;
        }

        const journal = session.journal ?? this.attachJournal(session);

        if (journal === undefined) return;

        journal.append({ turnId, index, at, event });

        const error = journal.error;

        if (error !== undefined) this.noteJournalError(session, `could not append to the event journal: ${error}`);
    }

    private noteJournalError(session: Session, message: string): void {
        // Report each distinct failure once, so a persistently broken disk cannot
        // flood the reporter with one line per token.
        if (session.journalProblems.includes(message)) return;

        session.journalProblems.push(message);

        this.reportJournalFailure(`Session ${session.id}: ${message}`);
    }

    // D4: a worker-mode journal failure can also arrive on the client's reporter, from the
    // reply to an operation the store already forgot about (a queued rewrite or remove whose
    // failure lands a tick later). The store then knows only the session id, so the prefix is
    // the neutral one; the kind-specific prefixes inline uses ("could not append...", "could
    // not rewrite...") are still produced synchronously at each call site from
    // `io.journalError(id)`, and the raw message is identical in both modes.
    private noteWorkerJournalError(sessionId: string, message: string): void {
        const label = `could not write the event journal: ${message}`;
        const session = this.sessions.get(sessionId);

        // A session that is already gone still keeps its failure visible: inline, the last
        // error lives on the `HarnessJournal` instance, which outlives `remove()` the same way.
        if (session === undefined) {
            this.reportJournalFailure(`Session ${sessionId}: ${label}`);

            return;
        }

        this.noteJournalError(session, label);
    }

    // The shared tail of both journal-report paths: the aggregate list (what
    // `journalErrors` exposes) and the host reporter, neither of which may throw.
    private reportJournalFailure(report: string): void {
        if (!this.journalFailures.includes(report)) this.journalFailures.push(report);

        if (this.onPersistenceError === undefined) return;

        try {
            this.onPersistenceError(new Error(report));
        } catch {
            // The reporter is observational; it must never change a run.
        }
    }

    // READ-side problems are reported through the restore channel (they are about
    // what was saved, not about a write that failed now).
    private surfaceJournalProblems(session: Session, problems: readonly JournalProblem[]): void {
        for (const problem of problems) {
            const label = problem.tail
                ? `tolerated truncated tail on line ${problem.line}: ${problem.reason}`
                : `journal corruption at line ${problem.line} (${problem.kind}): ${problem.reason}`;

            this.noteJournalError(session, label);
        }
    }

    // Checkpoint with a bounded interval. Every event is journal-appended
    // unconditionally, so the interval only decides how often the FULL document is
    // rewritten; the strict (`persistOrThrow`) and terminal saves are unchanged and
    // still land at every structural transition.
    private checkpoint(session: Session, force = false): void {
        if (this.persistence === undefined) return;

        const now = Date.now();

        if (!force && now - session.checkpointAt < VIEW_CHECKPOINT_INTERVAL_MS) return;

        session.checkpointAt = now;
        this.persistBestEffort();
    }

    // Merge the durable log with the loaded checkpoint (see the rules on the method
    // body), then fold the compiled state so the process starts with a warm cache.
    private restoreProjections(session: Session): void {
        this.mergeJournal(session);
        this.foldProjections(session);
    }

    private foldProjections(session: Session): void {
        const context = this.displayContext(session);

        session.projections.clear();
        session.blockCache.clear();

        for (const turn of session.turns) {
            session.projections.set(turn.id, refoldTurn(turn, context));
        }
    }

    private mergeJournal(session: Session): void {
        const journal = this.attachJournal(session);

        if (journal === undefined) return;

        const read = journal.read();

        // No journal directory: a database written before R4. Its checkpoint turns
        // already carry every event, so legacy restore is byte-for-byte unchanged.
        if (read.missing) return;

        this.surfaceJournalProblems(session, read.problems);

        const logged = new Map<string, JournalEventRecord[]>();

        for (const record of read.events) {
            const bucket = logged.get(record.turnId);

            if (bucket === undefined) logged.set(record.turnId, [record]);
            else bucket.push(record);
        }

        for (const turn of session.turns) {
            const records = logged.get(turn.id);

            if (records === undefined) continue;

            logged.delete(turn.id);

            // Start from the CHECKPOINT: a turn keeps every record it had, even if
            // the journal never saw it (a truncated or compacted log must never lose
            // a step the document still holds).
            const merged = new Map<number, { event: HarnessEvent; at: number | undefined }>();

            for (let index = 0; index < turn.events.length; index += 1) {
                merged.set(index, { event: turn.events[index], at: turn.eventTimes?.[index] });
            }

            for (const record of records) {
                const existing = merged.get(record.index);

                if (existing === undefined) {
                    merged.set(record.index, { event: record.event, at: record.at });
                    continue;
                }

                // A journal line is written BEFORE the document is rewritten, so on a
                // conflict the journal is the newer byte. Compare cheaply first.
                if (existing.at === record.at && existing.event === record.event) continue;
                if (JSON.stringify(existing.event) === JSON.stringify(record.event) && existing.at === record.at) continue;

                merged.set(record.index, { event: record.event, at: record.at });
            }

            const indexes = [...merged.keys()].sort((left, right) => left - right);
            const events: HarnessEvent[] = [];
            const times: number[] = [];
            let timed = false;

            for (const index of indexes) {
                const entry = merged.get(index) as { event: HarnessEvent; at: number | undefined };

                events.push(entry.event);
                times.push(finiteAt(entry.at) ? (entry.at as number) : 0);
                if (finiteAt(entry.at)) timed = true;
            }

            turn.events = events;
            turn.eventTimes = timed ? times : undefined;
        }

        // A turn the document never saw: its prompt was lost with the write that
        // failed, but its STEPS survived in the log. Recover it as an interrupted
        // turn rather than dropping the work — and say so.
        for (const [turnId, records] of logged) {
            const first = records[0];
            const last = records[records.length - 1];
            const events: HarnessEvent[] = [];
            const times: number[] = [];
            let timed = false;

            for (const record of records) {
                events.push(record.event);
                times.push(record.at);
                if (finiteAt(record.at)) timed = true;
            }

            const recovered: SessionTurn = {
                id: turnId,
                index: session.turnSequence++,
                // The prompt lived only on the turn record, and the record never
                // reached a document. Empty is the honest answer, not a guess.
                prompt: '',
                status: 'error',
                ...(finiteAt(first.at) ? { startedAt: first.at } : {}),
                updatedAt: finiteAt(last.at) ? last.at : first.at,
                events,
                ...(timed ? { eventTimes: times } : {})
            };

            session.turns.push(recovered);
            session.projections.delete(turnId);
            this.noteJournalError(
                session,
                `recovered turn ${turnId} from the event journal: its record was never checkpointed, so its prompt is unknown`
            );
        }

        if (logged.size > 0) {
            session.status = 'error';
            session.lastError = session.lastError ?? INTERRUPTED_MESSAGE;
        }
    }

    // Replace the log with exactly what the live records hold (compaction after a
    // deletion or a reset). Without this, a deleted turn's events could be replayed
    // onto a restart as ghost steps.
    private compactJournal(session: Session, turnIds?: Iterable<string>): void {
        // D4: which thread holds the handle decides who writes. Inline needs the session's own
        // `HarnessJournal` (and does nothing without one); worker mode has no writer handle on
        // this thread at all, so the rewrite is QUEUED for the thread that owns the fd. The
        // queue keeps it ordered against the checkpoint that follows it, and a rewrite is
        // atomic there (tmp + fsync + rename), so the durability claim is the same.
        const inline = this.io === undefined ? session.journal : undefined;

        if (this.io === undefined && inline === undefined) return;

        const wanted = turnIds === undefined ? undefined : new Set(turnIds);
        const records: JournalEventRecord[] = [];

        for (const turn of session.turns) {
            if (wanted !== undefined && !wanted.has(turn.id)) continue;

            for (let index = 0; index < turn.events.length; index += 1) {
                records.push({
                    type: 'event',
                    v: 1,
                    turnId: turn.id,
                    index,
                    at: turn.eventTimes?.[index] ?? turn.updatedAt,
                    event: turn.events[index]
                });
            }
        }

        if (this.io === undefined && inline !== undefined) {
            inline.rewrite(records);

            const error = inline.error;

            if (error !== undefined) this.noteJournalError(session, `could not rewrite the event journal: ${error}`);

            return;
        }

        this.io?.queueJournalRewrite(session.id, records);

        // The mirror of `journal.error` for the session, read the same instant the inline path
        // would read its own handle: a rewrite that already failed is reported here, and a
        // later one arrives through `onJournalError`.
        const queuedError = this.io?.journalError(session.id);

        if (queuedError !== undefined) this.noteJournalError(session, `could not rewrite the event journal: ${queuedError}`);
    }

    // PATCH /sessions/:id — retarget the model of one or more agents in THIS live
    // session (R2: the model of an existing agent may change at any time).
    //
    // Nothing is rebuilt: the harness, its history, its enabled tools, and its
    // turns are untouched, so the change takes effect on the NEXT request of the
    // affected agent (an in-flight request keeps the model it started with; see
    // `requestModel` in ../src/core/agent.ts).
    //
    // Rules:
    //   - MERGE, not replace (unlike PATCH /harnesses/:name): an agent absent from
    //     the map keeps the model it currently runs, so changing one dropdown
    //     cannot silently reset its siblings. An empty map is therefore a 400 —
    //     it would change nothing.
    //   - Every named agent must be a member of this session's harness, and every
    //     value must be a valid model id. Validation reuses the registry's
    //     normalizeAgentModels, so the two mutation surfaces cannot disagree about
    //     what an id is; its HarnessRegistryError is re-wrapped as a SessionError
    //     so callers/tests here only ever see one session error type.
    //   - ALL-OR-NOTHING: the whole map is validated into `resolved` before any
    //     brain is touched, so a rejected patch leaves every agent on its previous
    //     model.
    //   - ALLOWED WHILE BUSY (a streaming run or a manual tool call). Changing a
    //     model does not mutate the harness structure the way a manual tool call
    //     does, so the single-flight gate does not apply and no run is aborted.
    //   - `definition` stays FROZEN: it records what the session was created with.
    //     `model`/`agentModels` in a snapshot are derived from the live brains, so
    //     they report what the session runs NOW.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    async setAgentModels(id: string, agentModels: unknown): Promise<SessionSnapshot> {
        const session = this.require(id);

        // Members are exactly the agents a snapshot reports, so a key the client
        // can see in `agentModels` is a key this accepts, and nothing else is.
        const members = Object.keys(session.harness.agents);

        let resolved: Record<string, string>;

        try {
            resolved = normalizeAgentModels(agentModels, members);
        } catch (error) {
            // Translate the registry's error into this store's error type; the
            // message (which names the offending agent) is already correct.
            if (error instanceof HarnessRegistryError) {
                throw new SessionError(error.status, error.message);
            }
            throw error;
        }

        // `{}` validates but changes nothing: reject it instead of reporting a
        // success that did not happen.
        if (Object.keys(resolved).length === 0) {
            throw new SessionError(400, 'A patch must change at least one agent model.');
        }

        // Apply only after every entry validated. `agent.model(value)` is the
        // mutable accessor (src/core/agent.ts); it updates the brain in place.
        // Keep the previous models so a failed write can restore them: a PATCH
        // must not report a change the next restart forgets.
        const previous: Record<string, string> = {};

        for (const [name, model] of Object.entries(resolved)) {
            previous[name] = session.harness.agents[name].model();
            session.harness.agents[name].model(model);
        }

        session.updatedAt = Date.now();

        try {
            // Capture a fresh snapshot when the harness has no active operation; a
            // mid-run PATCH is still durable because the record carries the live
            // model map separately from the snapshot.
            if (!session.busy) session.core = session.harness.snapshot();
            await this.persistOrThrow();
        } catch (error) {
            for (const [name, model] of Object.entries(previous)) {
                session.harness.agents[name].model(model);
            }

            if (!session.busy) session.core = session.harness.snapshot();
            throw error;
        }

        return this.snapshot(session);
    }

    // -----------------------------------------------------------------------
    // T27: session-scoped AGENT BINDINGS
    // -----------------------------------------------------------------------
    //
    // WHAT THIS IS, AND WHY IT IS NOT A REBUILD
    // -----------------------------------------
    // A session's team used to be fixed at `POST /sessions`: whatever the harness definition
    // listed. These three operations let one conversation gain a member, lose one, or retune
    // what a member's prompt says, WITHOUT touching the conversation itself. The alternative
    // every caller had was a history reset — the runtime's only wholesale text write was
    // `setThreadMessages`, which replaces a committed transcript to change a prompt — so a
    // retitled role cost the session its memory. It does not any more.
    //
    // THREE COPIES OF THE TRUTH MOVE TOGETHER, IN THIS ORDER:
    //   1. the live runtime (`harness.addAgent`/`removeAgent`/`setAgentInstruction`) — what
    //      the next turn actually runs, and the source every live read reports;
    //   2. `session.preset` (a fresh LOCAL copy, never the registry object) — what a restart
    //      rebuilds the team from, because `restoreSession` falls through to
    //      `presetFromRecord(record.preset, …)` the moment this copy differs from the registry
    //      entry, and that factory seeds each member from its trusted profile with exactly the
    //      `agentModels`/`agentInstructions` maps written here;
    //   3. `session.definition` (also a fresh copy) — what the roster read enumerates
    //      (`api-reads.sessionAgentRowsOf` iterates `definition.agents`, and
    //      `getSessionAgentInstruction` gates membership on it).
    // Doing 1 without 2 gives a session that works until the next restart and then loses the
    // member; 2 without 1 answers a read with a brain that does not exist. 3 is what makes the
    // binding visible to the contract at all.
    //
    // WHAT STAYS FROZEN: `definition.agentModels`/`definition.agentInstructions` are the
    // CREATION-time inherited baseline — that is what `SessionAgentBinding.inherited_model`
    // reports — so a session override writes `preset.agentModels`/`preset.agentInstructions`
    // only. Membership (`agents`/`subagents`) is the single definition field a binding is
    // allowed to change, because the roster budget in the contract is defined over it.
    //
    // THE IDENTITY RULE (`name` must equal `profile`)
    // -----------------------------------------------
    // `CreateSessionAgentRequest` carries both, so a client may ask for a member called
    // `extra` bound to profile `instruct`. That cannot be honoured across a restart: the team
    // a session rebuilds from is the preset's `agents`/`subagents` NAME LIST, and each name is
    // resolved through `agentFromProfile(name)` (./harnesses/toolbox.ts), so a roster key that
    // is not itself a trusted profile id makes the restored session throw and get DROPPED. A
    // rename would also silently change which profile the next build resolves. The store
    // therefore refuses the mismatch up front instead of creating a session that cannot load.
    //
    // R7 EXCEPTION — A NAME THAT IS NOT A PROFILE AT ALL: the rule above is about a MISMATCH
    // between two spellings, not about an invented identity. A roster key no profile describes
    // (`localizer`, `ops-bot`, …) is now a SESSION-DEFINED agent: its base instruction is stored
    // in `preset.customAgents`, `agentsFromProfiles` builds it from that entry instead of from a
    // profile, and the same map makes the restart rebuild identical. An arbitrary name therefore
    // survives a restart for exactly the same reason a profile binding does — the durable map
    // states it — so the refusal stays reserved for the case that genuinely cannot resolve.
    //
    // PROTECTED MEMBERS: the primary is never removable (it is the entry point, and
    // `harness.name`/`handle.agent` point at it), and `session.definition.primary` is never
    // replaced by a binding — promoting a member is a harness-definition edit
    // (`PATCH /harnesses/{name}`), not a session-scoped binding.
    //
    // R6 REMOVAL GUARD — A SAVED SESSION OWNS ITS HISTORY: an agent that still owns a host
    // conversation is NOT detached (`removeSessionAgent` answers 409 naming the ids). Deleting a
    // member used to delete those conversations behind the caller's back, which threw away
    // transcripts the request never named; the user deletes the threads first and the roster
    // second. `api-reads.sessionAgentRowsOf` reports the same predicate as the row's `deletable`
    // flag, and ./harness.ts `removeAgent` states it a third time as the runtime's backstop, so
    // no caller can strand a conversation from either side.
    //
    // WHY THE IDLE GATE IS TOTAL: these writes change structure the run loop reads (the
    // delegate allowlist, the per-request declaration list, the agent roster a snapshot
    // enumerates). `busyOrPending` covers a legacy run, an active lane, AND accepted-but
    // -unstarted turns, so a binding can never land between "a turn has read the roster" and
    // "the same turn calls a member that just left". A 409 is retryable on a settled session;
    // an unsafe history reset would have been silently destructive.

    // The contract's roster budget (src/shared/harness-api.ts:951 states "the 64-binding
    // roster budget"), and the same instruction ceiling the harness-definition PATCH applies
    // (./harnesses/registry.ts:148). Named here because the store is the component that
    // decides what its own document may hold.
    private readonly maxSessionAgents = 64;
    private readonly maxAgentInstructionChars = 8_000;

    // The gate every binding write shares. `pendingCount` is included deliberately: a queued
    // turn has already been accepted against the CURRENT roster.
    private assertBindingIdle(session: Session, operation: string): void {
        if (this.busyOrPending(session)) {
            throw new SessionError(
                409,
                `Cannot ${operation} while session "${session.id}" has a live run or queued work; wait for it to settle or cancel it first.`
            );
        }
    }

    // Everything a binding write can change, captured BEFORE it mutates. `core` is the runtime
    // half: `harness.restore(previousCore)` is the one structure-level undo the runtime offers,
    // and it is safe precisely because the idle gate above proved no run owns this harness.
    private captureBindingState(session: Session): {
        preset: HarnessPreset;
        definition: HarnessDescriptor;
        sessionAgents: string[];
        core: HarnessSnapshot;
        updatedAt: number;
    } {
        return {
            preset: session.preset,
            definition: session.definition,
            sessionAgents: [...session.sessionAgents],
            core: session.core,
            updatedAt: session.updatedAt
        };
    }

    // Put the session back exactly as it was after a FAILED durable commit. The document was
    // never replaced (`persistOrThrow` throws before the rename), so a restart already agrees
    // with this state; only memory has to be rewound.
    private rollbackBindingState(
        session: Session,
        previous: {
            preset: HarnessPreset;
            definition: HarnessDescriptor;
            sessionAgents: string[];
            core: HarnessSnapshot;
            updatedAt: number;
        }
    ): void {
        session.preset = previous.preset;
        session.definition = previous.definition;
        session.sessionAgents = previous.sessionAgents;
        session.updatedAt = previous.updatedAt;

        try {
            session.harness.restore(previous.core);
        } catch {
            // A restore of a snapshot THIS harness produced cannot reasonably fail; if it does,
            // the caller already has its 500 and the durable document is still the truth. The
            // next restart replays that document, so the failed write is still not observable.
        }

        session.core = previous.core;
    }

    // Rewrite the two metadata copies for one binding change. `removed` drops the member from
    // the roster lists and from BOTH override maps plus the session-defined agent map; `added`
    // appends it (after the primary, so `[primary, ...subagents]` stays the documented
    // derivation); `model`/`instruction` are the session-scoped overrides to record, or
    // `undefined` to leave the map alone (`null` clears an existing entry).
    //
    // R7: `customInstruction` is the BASE text of a session-defined agent — the entry
    // `agentsFromProfiles` rebuilds that member from (./harnesses/toolbox.ts). It is stated only
    // when the member being ADDED is not a catalogue profile; a profile binding leaves it
    // `undefined`, which keeps the map exactly as it was (so a bound profile member never
    // appears in it, and a custom member's base survives a later instruction PATCH — the PATCH
    // records the raw override in `agentInstructions`, and that map wins over the base by the
    // documented precedence).
    private applyBindingMaps(
        session: Session,
        agent: string,
        change: {
            added?: boolean;
            removed?: boolean;
            model?: string | null;
            instruction?: string | null;
            customInstruction?: string;
        }
    ): void {
        const keep = (list: readonly string[]): string[] =>
            change.removed === true ? list.filter((entry) => entry !== agent) : [...list];

        const withAgent = (list: readonly string[]): string[] => {
            const next = keep(list);

            // Appended after the primary, which is already first by construction.
            if (change.added === true && !next.includes(agent)) next.push(agent);

            return next;
        };

        const override = (
            map: Record<string, string> | undefined,
            value: string | null | undefined
        ): Record<string, string> => {
            const next: Record<string, string> = { ...(map ?? {}) };

            if (value === null || change.removed === true) delete next[agent];
            else if (typeof value === 'string') next[agent] = value;

            return next;
        };

        const previous = session.preset;
        const models = override(previous.agentModels, change.model);
        const instructions = override(previous.agentInstructions, change.instruction);

        // R7: the session-defined agent map, rebuilt from the previous copy so an unrelated
        // binding never drops another member's base text. `removed` deletes the key — that is
        // what makes a detach final — and `customInstruction` is the only writer of a new entry.
        const customs: Record<string, string> = { ...(previous.customAgents ?? {}) };

        if (change.removed === true) delete customs[agent];

        if (change.removed !== true && change.customInstruction !== undefined) {
            customs[agent] = change.customInstruction;
        }

        // REBUILD, never inherit: the three override maps come ONLY from their computed values,
        // so an emptied map actually leaves the preset instead of surviving as the previous copy
        // through a `...previous` spread. Two real consequences of that stale-key hole, both in
        // the durable half the contract promises:
        //   - `PATCH …/instruction {instruction: null}` clears a session override, and a restart
        //     must not silently re-apply it (the live brain says one thing, the record another);
        //   - detaching a session-defined agent must take its stored base with it, so a restart
        //     has nothing left to rebuild (R6/R7).
        // Every other preset field is carried over unchanged, and the maps are re-written below
        // exactly when they hold something.
        const {
            agentModels: _previousModels,
            agentInstructions: _previousInstructions,
            customAgents: _previousCustoms,
            ...carried
        } = previous;

        session.preset = {
            ...carried,
            agents: withAgent(previous.agents),
            subagents: withAgent(previous.subagents),
            ...(Object.keys(models).length === 0 ? {} : { agentModels: models }),
            ...(Object.keys(instructions).length === 0 ? {} : { agentInstructions: instructions }),
            // Absent vs `{}` are the same statement ("this session defines no extra agent"), and
            // the absent form is what keeps a pre-R7 document's preset byte-identical through a
            // round trip (`presetToRecord` writes no field for an empty map).
            ...(Object.keys(customs).length === 0 ? {} : { customAgents: customs })
        };

        const definition = session.definition;

        session.definition = {
            ...copyDescriptor(definition),
            agents: withAgent(definition.agents),
            subagents: withAgent(definition.subagents)
        };
    }

    /**
     * Bind an agent into THIS session (`POST /sessions/{id}/agents`).
     *
     * Returns the roster binding id, the model it runs, and the instruction source the
     * contract reports, so the caller does not have to re-read the roster to answer 201.
     * A refusal mutates nothing: validation runs before the runtime call, and a failed
     * durable commit rewinds memory (see `rollbackBindingState`).
     *
     * R2: the composed configuration also inherits this definition's display color for the
     * member, so a bound agent and the same agent rebuilt from the durable preset carry one
     * swatch. Colors are definition metadata, not session state: the binding writes no new
     * `agentColors` entry and the receipt keeps its exact pre-R2 shape.
     *
     * R7: the roster key decides which kind of member this is.
     *   - it spells a trusted catalogue profile (`isAgentProfileName`) → the profile path,
     *     unchanged, including the retired-profile 409 and the raw override recorded in
     *     `agentInstructions`;
     *   - anything else (a name this conversation invents) → a SESSION-DEFINED agent: its own
     *     model plus its own instruction text, built by `agentConfigurationForCustom` with no
     *     profile lookup and no guideline composition, and durable as a `preset.customAgents`
     *     entry so `agentsFromProfiles` rebuilds the identical brain on the next start. The
     *     roster is otherwise the same roster: the cap, the duplicate rule and the primary-role
     *     refusal apply to both kinds, and a custom member is detachable exactly like a bound
     *     profile member (R6 gates the removal on the conversations it owns).
     */
    async addSessionAgent(
        id: string,
        input: { name?: unknown; profile?: unknown; model?: unknown; instruction?: unknown; role?: unknown }
    ): Promise<SessionSnapshot> {
        const session = this.require(id);

        this.assertBindingIdle(session, 'bind an agent to a session');

        const name = typeof input.name === 'string' ? input.name.trim() : '';

        if (name.length === 0) {
            throw new SessionError(400, 'A session agent binding needs a non-blank "name".');
        }

        // An omitted `profile` binds the profile the name already spells, which is the only
        // pair the identity rule below can ever accept anyway.
        const profile = typeof input.profile === 'string' && input.profile.trim().length > 0
            ? input.profile.trim()
            : name;

        if (profile !== name) {
            throw new SessionError(
                400,
                `A session agent binding must use its profile's own name: "name" is "${name}" but "profile" is "${profile}". The roster key is the trusted profile id, which is what a restart rebuilds this session's team from.`
            );
        }

        if (session.definition.agents.includes(name)) {
            throw new SessionError(409, `Agent "${name}" is already a member of session "${id}".`);
        }

        if (session.definition.agents.length >= this.maxSessionAgents) {
            throw new SessionError(
                409,
                `A session roster holds at most ${this.maxSessionAgents} agents; session "${id}" already has ${session.definition.agents.length}.`
            );
        }

        // R7: two kinds of member, decided by whether the roster key spells a trusted profile.
        // A profile id keeps the catalogue path byte-for-byte; anything else is a SESSION-DEFINED
        // agent the caller invents here with its own model and instruction (it used to answer
        // 404 `Unknown agent profile`, which is exactly what R7 replaced).
        const isProfile = isAgentProfileName(name);

        if (isProfile) {
            // A RETIRED profile is a deployment decision, not a bad request, and it is the exact
            // 409 text `agentFromProfile` states for a new session that selects one: the profile is
            // out of the selectable catalogue while existing sessions keep what they were built with.
            if (effectiveAgentProfile(name) === undefined) {
                throw new SessionError(
                    409,
                    `Agent "${name}" has been retired on this deployment, so it cannot be bound to a session. Existing sessions keep the agents they were built with.`
                );
            }
        } else {
            // The custom name is validated BEFORE anything moves, because the same string becomes
            // a delegation id, a runtime agent-registry key, a `agent:<name>` conversation id and
            // a key of the session's durable preset maps in one step (see the module note on
            // `CUSTOM_AGENT_NAME_PATTERN` for why the rule is this conservative).
            if (!CUSTOM_AGENT_NAME_PATTERN.test(name)) {
                throw new SessionError(
                    400,
                    `Agent "${name}" is not a trusted profile, so it would be a session-defined agent, and that name must start with a letter or digit and contain only letters, digits, spaces, ".", "_" or "-", at most 64 characters.`
                );
            }

            // `unknown` (any case) is the placeholder a client paints for "no agent at all"
            // (src/frontend/ui/agent-color.ts `UNNAMED_AGENT_PLACEHOLDER`), so a member literally
            // named that would read back as a lookup miss on every surface that shows it.
            if (name.toLowerCase() === CUSTOM_AGENT_RESERVED_NAME) {
                throw new SessionError(
                    400,
                    `"${CUSTOM_AGENT_RESERVED_NAME}" is the placeholder id of an unknown agent, so it cannot name a session-defined agent.`
                );
            }

            // Case-insensitive membership, which the exact-match duplicate check above cannot
            // catch: the runtime's roster is a plain case-SENSITIVE object, so "Ops" next to
            // "ops" would be two registry keys that every human reader (and every delegation
            // sentence) treats as one agent. A profile member is caught here too — "Instruct" is
            // not a profile id, and inventing a second entry point's near-twin would be a silent
            // roster surprise rather than a new agent.
            const clash = session.definition.agents.find(
                (member) => member.toLowerCase() === name.toLowerCase()
            );

            if (clash !== undefined) {
                throw new SessionError(
                    409,
                    `Agent "${name}" differs only in case from the existing member "${clash}", so it cannot be added to session "${id}". A session roster is case-insensitive.`
                );
            }
        }

        const model = typeof input.model === 'string' && input.model.trim().length > 0
            ? input.model.trim()
            : session.settings.model;

        const instruction = typeof input.instruction === 'string' && input.instruction.trim().length > 0
            ? input.instruction.trim()
            : undefined;

        if (instruction !== undefined && instruction.length > this.maxAgentInstructionChars) {
            throw new SessionError(
                400,
                `An agent instruction cannot exceed ${this.maxAgentInstructionChars} characters.`
            );
        }

        // The primary is structural. Refusing here (rather than quietly binding a subagent and
        // ignoring the requested role) is what keeps the receipt honest about what happened.
        if (input.role === 'primary') {
            throw new SessionError(
                409,
                `A session binding cannot take the primary role; "${session.definition.primary}" stays the entry point of session "${id}". Change the harness definition to replace it.`
            );
        }

        // R7: the base instruction of a SESSION-DEFINED member — the caller's text, or the
        // deterministic identity sentence when the caller named none. This one value is written
        // three times over the agent's life (the live brain below, the durable
        // `preset.customAgents` entry, and the text `agentsFromProfiles` rebuilds from that entry
        // on the next start), so it is computed once here and passed to both halves.
        // `customAgentInstruction` is the shared definition of that fallback
        // (./harnesses/toolbox.ts), which is what makes the live and rebuilt prompts identical.
        const baseInstruction = isProfile ? undefined : customAgentInstruction(name, instruction);

        // Composed from the trusted profile + this session's provider settings, i.e. the same
        // call the preset factory makes, so a bound member and a rebuilt member run byte-identical
        // prompts and the same transport.
        //
        // R2: the 5th argument is the definition's own swatch for this member. The frozen preset
        // map (./harnesses/types.ts `HarnessPreset.agentColors`) is what `agentsFromProfiles` feeds
        // a rebuilt session, and what `describeHarness` projects onto the definition read, so a
        // member bound at runtime must read the same map or the UI would paint one agent two
        // different colors across a restart. Absent entry means "unconfigured": the composer
        // omits the key and the client applies its own derivation, exactly as before.
        //
        // A session-defined member takes the sibling composer instead: same trusted transport, no
        // profile lookup, no guidelines, and the instruction is the base text verbatim. Both
        // builders receive the SAME swatch lookup, so a custom member is painted by the definition
        // exactly like a profile one.
        const configuration = isProfile
            ? agentConfigurationFromProfile(
                  profile,
                  session.settings,
                  model,
                  instruction,
                  session.preset.agentColors?.[name]
              )
            : agentConfigurationForCustom(
                  name,
                  session.settings,
                  model,
                  baseInstruction,
                  session.preset.agentColors?.[name]
              );

        const previous = this.captureBindingState(session);

        try {
            session.harness.addAgent(name, configuration, { delegate: true });
        } catch (error) {
            // A runtime refusal here is a structural conflict (already registered, roster busy),
            // so it surfaces as 409 with the runtime's own reason.
            throw new SessionError(409, messageOf(error));
        }

        // R7: a profile member records its RAW text override (or `null` for none) in
        // `agentInstructions`, exactly as before. A custom member records NO override — the text
        // it runs is its own BASE, durable in `customAgents` — which is also why the roster read
        // reports `instruction_source: 'session'` for it rather than `'harness'`.
        this.applyBindingMaps(session, name, {
            added: true,
            model,
            instruction: isProfile ? (instruction ?? null) : null,
            customInstruction: baseInstruction
        });
        session.sessionAgents = [...previous.sessionAgents, name];
        session.updatedAt = Date.now();

        try {
            // The roster changed, so the persisted snapshot must change with it: a bound member
            // has a default conversation, and `agentModels` in the document enumerates the live
            // brains (see `sessionRecord`).
            session.core = session.harness.snapshot();
            await this.persistOrThrow();
        } catch (error) {
            this.rollbackBindingState(session, previous);

            throw error;
        }

        return this.snapshot(session);
    }

    /**
     * Detach one member of THIS session (`DELETE /sessions/{id}/agents/{agent_id}`).
     *
     * R6: an agent that still owns a conversation is NOT removed — the call answers 409 naming
     * the member, how many conversations it owns, which ids they are, and the remedy (delete
     * those threads first). Removing an agent used to delete its host conversations as a silent
     * side effect, which threw away transcripts the caller never named; a saved session owns its
     * history, so the user decides what goes.
     *
     * `detachedThreads` is therefore 0 on every accepted removal, and it stays in the receipt
     * because the contract declares `detached_threads` (its schema description now states the
     * guard). History already written by the member is never rewritten either way: a delegated
     * answer copied into another transcript stays, and every OTHER member's transcript is
     * untouched. The member's own DEFAULT conversation (`agent:<name>`) is not part of the guard:
     * it is the agent's transcript, and the runtime removes it together with the agent.
     */
    async removeSessionAgent(
        id: string,
        agentId: string
    ): Promise<{ session: SessionSnapshot; detachedThreads: number }> {
        const session = this.require(id);

        this.assertBindingIdle(session, 'remove an agent from a session');

        const agent = typeof agentId === 'string' ? agentId.trim() : '';

        if (!session.definition.agents.includes(agent)) {
            throw new SessionError(404, `Agent "${agent}" is not a member of session "${id}".`);
        }

        if (agent === session.definition.primary) {
            throw new SessionError(
                409,
                `Agent "${agent}" is the primary agent of session "${id}" and cannot be detached; every session needs an entry point.`
            );
        }

        // R6: the ownership gate. `origin === 'host'` is the whole distinction — a host thread is
        // an independent conversation `harness.createThread` opened (and what the thread routes
        // and the transcript editor address), while an `agent`-origin record is the member's
        // implicit default conversation that belongs to it by definition. Only the first blocks,
        // and NOTHING is deleted by a refusal: the roster, the threads, and the durable document
        // all stay exactly as they were.
        const owned = session.harness
            .threads()
            .filter((thread) => thread.origin === 'host' && thread.agent === agent);

        if (owned.length > 0) {
            throw new SessionError(
                409,
                `Agent "${agent}" still owns ${owned.length} conversation${owned.length === 1 ? '' : 's'} in session "${id}": ${owned.map((thread) => `"${thread.id}"`).join(', ')}. Delete those threads before removing the agent.`
            );
        }

        const previous = this.captureBindingState(session);

        try {
            // The runtime states the same host-thread rule as its own backstop (./harness.ts
            // `removeAgent`), so a roster that moved between the gate above and this call still
            // cannot strand a conversation. A refusal here means nothing was removed, so there is
            // nothing to rewind: `previous` is only for the durable commit below.
            session.harness.removeAgent(agent);
        } catch (error) {
            throw new SessionError(409, messageOf(error));
        }

        // R7: `removed` also deletes this agent's `customAgents` entry, so detaching a
        // session-defined member is final — a restart does not rebuild a brain nobody detached.
        this.applyBindingMaps(session, agent, { removed: true });
        session.sessionAgents = previous.sessionAgents.filter((entry) => entry !== agent);
        session.updatedAt = Date.now();

        try {
            session.core = session.harness.snapshot();
            await this.persistOrThrow();
        } catch (error) {
            // The document was never replaced, so a failed commit rewinds memory (roster lists,
            // both override maps, the custom-agent map, and the harness) back to `previous`.
            this.rollbackBindingState(session, previous);

            throw error;
        }

        // R6: no conversation goes with an accepted removal any more, so the receipt states zero
        // detached threads; the invocation→thread joins and lane entries of the surviving
        // conversations are untouched (they are only purged by `deleteThread`).
        return { session: this.snapshot(session), detachedThreads: 0 };
    }

    /**
     * Set or CLEAR one member's session-scoped INSTRUCTION
     * (`PATCH /sessions/{id}/agents/{agent_id}` with `instruction`).
     *
     * A string REPLACES the text the member runs; `null` clears the session override, which
     * re-seeds the deployment's current effective profile text (global layer first, shipped
     * catalogue second). Either way ONLY the leading system block changes — the member's
     * committed turns, and every other member's transcript, are untouched, and the change is
     * what a later `reset()` returns to, because the runtime also reseeds the agent's baseline.
     *
     * R7: for a SESSION-DEFINED member the same write applies to its own base text: `null`
     * restores the instruction this session created the agent with (no profile, no guidelines),
     * and a string overrides it while the base stays durable in `preset.customAgents`. The
     * retired-profile 409 below is a catalogue rule only — a custom agent has no profile to
     * retire.
     */
    async setSessionAgentInstruction(
        id: string,
        agentId: string,
        instruction: string | null
    ): Promise<SessionSnapshot> {
        const session = this.require(id);

        this.assertBindingIdle(session, 'change an agent instruction in a session');

        const agent = typeof agentId === 'string' ? agentId.trim() : '';

        if (!session.definition.agents.includes(agent)) {
            throw new SessionError(404, `Agent "${agent}" is not a member of session "${id}".`);
        }

        // R7: is this a SESSION-DEFINED member? A custom agent has no `AgentProfile` at all, so
        // the whole catalogue ladder below (effective profile, retirement, guideline composition)
        // is not about it: the text it runs is the base its author gave it
        // (`preset.customAgents[name]`), or the session override layered on that base. `null`
        // therefore restores the BASE, not a profile — which is the only honest undo for an agent
        // this conversation invented.
        const custom = Object.prototype.hasOwnProperty.call(session.preset.customAgents ?? {}, agent)
            ? session.preset.customAgents![agent]
            : undefined;

        // What the member runs after this call, and what the durable override records. They are
        // deliberately NOT the same string: the contract's `instruction` field is the
        // IDENTITY-SENTENCE override, while the agent's system message is the composed prompt
        // (override + the profile's trusted guidelines). `agentInstruction` is the single place
        // that joins them (src/agents/index.ts:113), and it is the same call `agentFromProfile`
        // makes when a restart rebuilds this member — so composing here is what keeps the live
        // text and the restored text byte-identical instead of trading one guideline for a 500.
        const profile = custom === undefined ? effectiveAgentProfile(agent) : undefined;

        if (custom === undefined && profile === undefined) {
            // A retired profile has no current text to restore or compose against. The member
            // still runs the text it was seeded with, so the refusal must not pretend the
            // override is gone.
            throw new SessionError(
                409,
                `Agent "${agent}" has been retired on this deployment, so its session instruction cannot be changed here.`
            );
        }

        let override: string | null;

        if (instruction === null) {
            override = null;
        } else {
            if (typeof instruction !== 'string') {
                throw new SessionError(400, 'An agent instruction must be a string or null.');
            }

            override = instruction.trim();

            if (override.length === 0) {
                throw new SessionError(
                    400,
                    custom === undefined
                        ? 'An agent instruction must not be blank. Send null to restore the inherited profile text.'
                        : 'An agent instruction must not be blank. Send null to restore the instruction this session-created agent was given.'
                );
            }

            if (override.length > this.maxAgentInstructionChars) {
                throw new SessionError(
                    400,
                    `An agent instruction cannot exceed ${this.maxAgentInstructionChars} characters.`
                );
            }
        }

        // `null` clears the session override, which means "run the deployment's current
        // effective profile text" — the global agent layer first, the shipped catalogue second
        // (`effectiveAgentProfile`), never the stale text this session happened to start with.
        //
        // R7: a session-defined member has no deployment text to fall back to, so `null` restores
        // the BASE this conversation created it with. `customAgentInstruction` is the same helper
        // `addSessionAgent` used to mint that base and the same one `agentsFromProfiles` uses to
        // rebuild it (./harnesses/toolbox.ts), so the live prompt, the durable record, and the
        // next start are one string — and no guideline block is invented for an agent that has no
        // trusted profile to supply one.
        const liveText = custom === undefined
            ? agentInstruction(profile!, override ?? undefined)
            : customAgentInstruction(agent, override ?? custom);

        const previous = this.captureBindingState(session);

        try {
            session.harness.setAgentInstruction(agent, liveText);
        } catch (error) {
            throw new SessionError(409, messageOf(error));
        }

        // The durable half: the session's own preset copy carries the RAW override, which is
        // what `presetFromRecord` feeds back into `agentFromProfile` on the next build. Storing
        // the composed text here instead would bake today's guidelines into the record and make
        // a later guideline edit unreachable for this member.
        //
        // R7: a session-defined member takes the same route through the sibling branch of
        // `agentsFromProfiles` — `agentInstructions[name] ?? customAgents[name]` — so the raw
        // override recorded here is exactly what the rebuilt brain is seeded with, and clearing it
        // (`null`) returns the rebuild to the stored base.
        this.applyBindingMaps(session, agent, { instruction: override });

        session.updatedAt = Date.now();

        try {
            session.core = session.harness.snapshot();
            await this.persistOrThrow();
        } catch (error) {
            this.rollbackBindingState(session, previous);

            throw error;
        }

        return this.snapshot(session);
    }

    /**
     * Re-read the live harness into `session.core` and commit the document (T27).
     *
     * WHY THIS EXISTS: a REST tool write (enable/disable/remove/replace an installed revision)
     * mutates the LIVE harness through `harness.toolManage`/`registerTool`, and the runtime's
     * `stateChange` observer only refreshes `core` when it fires for a run boundary. A manual
     * registration reports through the factory's own result instead, so the dispatcher used to
     * answer with a snapshot the persisted document did not have yet, and a caller had to re-read
     * a fresh snapshot itself to see the change. This is the store-side operation: take the
     * snapshot NOW (the harness is idle by construction for these calls — a manual mutation is
     * refused while the session is busy) and make it durable before the response, so every
     * channel — `core`, `GET /sessions/{id}`, and the next restart — agrees.
     */
    async refreshCore(id: string): Promise<SessionSnapshot> {
        const session = this.require(id);

        if (!session.busy) session.core = session.harness.snapshot();

        await this.persistOrThrow();

        return this.snapshot(session);
    }

    // LEGACY submit (POST /sessions/:id/messages): run one task and stream it to
    // the caller. The response owns the run — an emitter failure aborts the harness
    // — and a busy session (or a pending queue) is rejected before mutation.
    //
    // Validation happens BEFORE any mutation. A rejected request (busy, queued
    // backlog, empty, too long) therefore leaves the previous turns untouched,
    // which is what makes the 409 safe for a client to retry on a fresh id.
    //
    // `options.signal` is the caller's disconnect signal (the legacy SSE
    // response). It is forwarded to THIS run only: when it aborts, the store marks
    // this turn cancelled and aborts this run's controller. A disconnect that
    // arrives after the run finished (before the response closed) is a no-op for
    // the forwarder, so it can never cancel a queued task that has since started.
    //
    // `attachments` is a TRAILING optional parameter (T3) so every existing caller
    // keeps its argument positions. It is validated (shared validator, detaching
    // copies) before a turn exists; malformed or oversized media is rejected with
    // 400/413/415 and mutates nothing.
    async run(
        id: string,
        rawInput: string,
        emit: Emit,
        options: { signal?: AbortSignal } = {},
        attachments?: unknown
    ): Promise<void> {
        const session = this.require(id);

        // A manual tool call holds `busy` too, so chat cannot start while one runs.
        // F1: a live THREAD lane (or any accepted-but-unstarted work in any lane)
        // also blocks this path — the legacy response-owned run reseeds the shared
        // agent conversations and must not interleave with thread work.
        if (this.busyOrPending(session)) {
            throw new SessionError(409, 'A task is already running in this session.');
        }

        // Validate media BEFORE text/turn mutation. The validator returns detached
        // copies, so a caller mutating its request body later cannot rewrite this
        // turn's bytes.
        const validated = validateAttachmentsForSubmit(attachments);
        const input = validateInput(rawInput, validated.length);
        const startedAt = Date.now();

        // The turn exists before the harness is called, so the very first progress
        // event already has somewhere to land and the stream can open with it.
        // `index` is assigned here, once, from the monotonic high-water mark: a turn
        // never moves within the session, and a deleted thread never frees an index
        // for reuse.
        const index = session.turnSequence;
        session.turnSequence += 1;

        const turn: SessionTurn = {
            id: randomUUID(),
            index,
            prompt: input,
            // Omitted for a text-only turn so the record keeps its legacy shape.
            ...(validated.length === 0 ? {} : { attachments: validated }),
            status: 'running',
            startedAt,
            updatedAt: startedAt,
            events: [],
            // Parallel to `events` from the first record on; see the protocol type.
            eventTimes: []
        };

        session.turns.push(turn);

        // T14/F1: number this block in the ONE canonical conversation sequence. The
        // seed is the same per-turn start state an enqueue records, so a later
        // deletion (or a deleted earlier thread) cannot renumber this block, and the
        // reservation settles the ordinal NOW — before a concurrently accepted task
        // could mint the same label for its new conversation.
        const seed = this.labelSeedOf(session);
        if (seed !== undefined) session.labelSeeds.set(turn.id, seed);

        this.reserveLegacyBlockLabel(session);

        // The legacy path keeps the original fresh-block semantics: no thread id,
        // every agent conversation reseeded before the run.
        await this.executeTurn(session, turn, emit, options.signal, { freshBlock: true });
    }

    // -----------------------------------------------------------------------
    // R2 result references: bind at enqueue, expand at execution
    // -----------------------------------------------------------------------

    // Validate and bind one submit's references. `references` is the raw request
    // field; `input` is the trimmed prompt (typed `#LABEL` tokens are resolved from
    // it). Everything here runs BEFORE the turn is created, so a rejected submit
    // mutates nothing.
    //
    // Two sources are merged:
    //   1. EXPLICIT entries from the client (the UI sends the block descriptor it
    //      picked). These carry turnId/threadId, so they are exact.
    //   2. Typed `#LABEL` tokens in the prompt that the explicit list does not
    //      already cover. Each resolves to the LATEST prior block with that label
    //      (server-side, using the shared allocator); an unknown label is rejected
    //      rather than silently ignored.
    //
    // A target may still be running/queued: binding records it, execution waits for
    // completion. A target that is already failed/cancelled, names a turn that is
    // not EARLIER than this one, or has no matching block is a clear 400.
    private normalizeReferences(
        session: Session,
        turnIndex: number,
        input: string,
        raw: unknown
    ): AgentResultReference[] {
        let explicit: AgentResultReference[];

        try {
            explicit = readAgentResultReferenceList(raw) ?? [];
        } catch (error) {
            throw new SessionError(400, messageOf(error));
        }

        const bound: AgentResultReference[] = [];

        for (const reference of explicit) {
            bound.push(this.bindReference(session, turnIndex, reference));
        }

        // Typed tokens are resolved in prompt order. An explicit reference for the
        // same label wins (it is exact), so the same result is never injected twice.
        for (const label of parseAgentReferenceLabels(input)) {
            if (bound.some((reference) => reference.label === label)) continue;

            // Only PRIOR turns are candidates: a reference points backwards, never
            // at the block being submitted or one queued behind it.
            const candidates = this.projectionTurns(
                session,
                session.turns.filter((turn) => turn.index < turnIndex)
            );
            const block = findLatestAgentResultBlock(candidates, label);

            if (block === undefined) {
                throw new SessionError(
                    400,
                    `No earlier block is labelled "#${label}". Type a label from a completed result.`
                );
            }

            if (block.status === 'error' || block.status === 'cancelled') {
                throw new SessionError(
                    400,
                    `Block "#${label}" cannot be referenced because it ended as ${block.status}.`
                );
            }

            bound.push({
                turnId: block.turnId,
                ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
                label: block.label
            });
        }

        // The explicit reader rejects duplicate turn+thread pairs; the merge above
        // can still add the same label once per source, which is intended. Return
        // detached copies (the caller stores them on the turn).
        if (bound.length > MAX_AGENT_REFERENCES) {
            throw new SessionError(
                400,
                `A task cannot reference more than ${MAX_AGENT_REFERENCES} result blocks.`
            );
        }

        return bound.map((reference) => ({ ...reference }));
    }

    // Turns from the start of the conversation THROUGH `index`, in recorded order.
    // Compact labels are conversation-scoped (shared/agent-results.ts chains one
    // allocator across turns), so resolving a block must project the PREFIX that
    // consumed earlier occurrences of its two-letter code. Projecting the target
    // turn alone would number it as if it were the first turn and resolve the wrong
    // block (or none) — the duplicate-label defect behind R5/R6.
    private turnsThrough(session: Session, index: number): SessionTurn[] {
        return session.turns
            .filter((candidate) => candidate.index <= index)
            .sort((left, right) => left.index - right.index);
    }

    // The turn records in RECORDED order, projected for the shared result-block
    // helpers with each turn's recorded label seed. Passing the seed makes label
    // numbering deletion-safe: a surviving turn keeps the labels it had before an
    // earlier thread was deleted (see shared/agent-results.ts).
    private projectionTurns(session: Session, turns: readonly SessionTurn[]): AgentResultTurn[] {
        // R8: conversation labels are allocated/loaded BEFORE projecting, so the
        // root block's label is the thread's display name (`RR2`) rather than a new
        // per-invocation number.
        this.ensureThreadLabels(session);
        const threadLabels = this.invocationThreadLabels(session);
        const hasThreadLabels = Object.keys(threadLabels).length > 0;

        return [...turns]
            .sort((left, right) => left.index - right.index)
            .map((turn) => {
                const seed = session.labelSeeds.get(turn.id);
                const threadLabel =
                    turn.threadId === undefined
                        ? turn.threadLabel
                        : this.ensureThreadLabel(session, turn.threadId);

                return {
                    id: turn.id,
                    status: turn.status,
                    events: turn.events,
                    ...(seed === undefined ? {} : { labels: seed }),
                    ...(threadLabel === undefined ? {} : { threadLabel }),
                    ...(hasThreadLabels ? { threadLabels } : {})
                };
            });
    }

    // R8: allocate (once) the stable display label of one persistent conversation.
    //
    // The label is the owning agent's two-letter code plus a PER-AGENT conversation
    // ordinal (`RR1`, `RR2`, …; `IT1`). It belongs to the THREAD, so every turn,
    // run, steer or continuation of that thread repeats it; only a genuinely new
    // conversation consumes the next ordinal. The high-water map is never lowered
    // by deletion, which is what stops a retired name from being re-minted.
    private ensureThreadLabel(session: Session, threadId: string, agentHint?: string): string {
        const known = session.threadLabels.get(threadId);
        if (known !== undefined) {
            this.raiseThreadLabelHighWater(session, known);
            return known;
        }

        const record = this.threadsSupported(session) ? session.harness.thread(threadId) : undefined;
        const agent = record?.agent ?? agentHint ?? session.preset.primary;

        return this.mintThreadLabel(session, threadId, agentCodeOf(agent));
    }

    // Mint the next ordinal of `code` for one conversation and record it.
    private mintThreadLabel(session: Session, threadId: string, code: string): string {
        const ordinal = this.nextConversationOrdinal(session, code);
        const label = `${code}${ordinal}`;

        session.threadLabels.set(threadId, label);
        // Raising through the shared helper writes BOTH durable counters (see
        // raiseThreadLabelHighWater), so the number is retired in the one sequence.
        this.raiseThreadLabelHighWater(session, label);
        return label;
    }

    // T14/F1: the next ordinal of a code in the ONE canonical sequence.
    //
    // A legacy `/messages` block, a persistent conversation and a nested/threadless
    // block all draw from this sequence, so no two of them can ever show the same
    // text label. `threadLabelHighWater` answers "which conversation numbers are
    // taken" and `labelHighWater` answers "which block numbers are taken"; a
    // persisted document may carry only one of them (a partial/hand-edited write),
    // so the allocation reads the HIGHEST of both instead of trusting one map. The
    // two maps are kept in sync on every mint, which is what makes that fallback
    // safe.
    private nextConversationOrdinal(session: Session, code: string): number {
        return (
            Math.max(
                session.threadLabelHighWater.get(code) ?? 0,
                session.labelHighWater.get(code) ?? 0
            ) + 1
        );
    }

    // Reserve one ordinal of a code in both durable counters WITHOUT binding it to
    // a conversation. Used by the legacy `/messages` path: its single block owns a
    // number, but no thread exists to own the name.
    private reserveConversationOrdinal(session: Session, code: string, ordinal: number): void {
        this.raiseThreadLabelHighWater(session, `${code}${ordinal}`);
    }

    // Raise the high-water from an already known label. A restored/hand-edited
    // label is authoritative, but a later new conversation of the same agent must
    // still continue AFTER it instead of colliding.
    //
    // T14: BOTH counters are raised. `threadLabelHighWater` is the conversation
    // sequence and `labelHighWater` the result-block tombstone; mirroring them is
    // what unifies the two namespaces (a retired conversation name can never come
    // back as a block label, and vice versa) and what lets a document that lost one
    // map still recover the other's numbers.
    private raiseThreadLabelHighWater(session: Session, label: string): void {
        const parts = agentLabelParts(label);
        if (parts === undefined) return;

        const code = parts.code;
        const used = parts.ordinal;

        session.threadLabelHighWater.set(
            code,
            Math.max(session.threadLabelHighWater.get(code) ?? 0, used)
        );
        session.labelHighWater.set(code, Math.max(session.labelHighWater.get(code) ?? 0, used));
    }

    // T14/F2: adopt the durable display labels BEFORE any allocation.
    //
    // A document can lose the label MAP (a partial write or a hand edit) while every
    // surviving turn still records the label it showed. Allocating first would mint
    // a fresh `RR1` for a conversation whose turn says `RR3` and only THEN raise the
    // counter to 3 — the surviving name would be lost and the next conversation
    // would collide with the stale turn record. So the recorded evidence is adopted
    // first, in a deterministic, duplicate-free order:
    //   1. `threadLabels` (the per-thread allocation record) in map order; a label
    //      already held by another thread is dropped from the map so that thread is
    //      re-allocated below instead of sharing a name;
    //   2. each recorded turn's label in turn order, for a thread that still has no
    //      name — that turn label is what the user actually saw on the block, so it
    //      is the strongest recovery evidence;
    //   3. every adopted label raises BOTH counters, so the next conversation (or
    //      legacy block) continues AFTER it.
    // A CONFLICT (the map and a turn disagree) is resolved deterministically: the
    // map is the per-thread allocation record and wins, the turn record is rewritten
    // to it, and the stale label still reserves its ordinal so it is never minted
    // for different content.
    private adoptPersistedLabels(session: Session): void {
        // label -> the conversation that owns it, so two threads can never adopt the
        // same text label.
        const owner = new Map<string, string>();

        for (const [threadId, label] of [...session.threadLabels]) {
            const parts = agentLabelParts(label);

            // A label this system can never emit is corruption: forget the entry so
            // the allocation pass mints a fresh name (the turns keep their content).
            if (parts === undefined) {
                session.threadLabels.delete(threadId);
                continue;
            }

            const holder = owner.get(parts.label);

            if (holder !== undefined && holder !== threadId) {
                // Two conversations claim one name. The first owner keeps it; this
                // entry is dropped so the other conversation is re-named below.
                session.threadLabels.delete(threadId);
                continue;
            }

            // Normalise the stored spelling (a hand-edited lowercase value must not
            // survive as the authoritative display name).
            session.threadLabels.set(threadId, parts.label);
            owner.set(parts.label, threadId);
            this.raiseThreadLabelHighWater(session, parts.label);
        }

        const ordered = [...session.turns].sort((left, right) => left.index - right.index);

        for (const turn of ordered) {
            const threadId = turn.threadId;
            const recorded = turn.threadLabel;

            // A legacy turn owns no conversation name (its block label comes from the
            // shared allocator); a turn without a recorded label has no evidence.
            if (threadId === undefined || recorded === undefined) continue;

            const parts = agentLabelParts(recorded);
            if (parts === undefined) continue;

            if (session.threadLabels.has(threadId)) {
                // The map wins the conflict; the differing recorded label still
                // reserves its number.
                this.raiseThreadLabelHighWater(session, parts.label);
                continue;
            }

            const holder = owner.get(parts.label);
            if (holder !== undefined && holder !== threadId) {
                // Another conversation already shows this name. Do not adopt it (that
                // would duplicate a `#` reference); reserve it and let the allocation
                // pass below mint the next free one for this thread.
                this.raiseThreadLabelHighWater(session, parts.label);
                continue;
            }

            session.threadLabels.set(threadId, parts.label);
            owner.set(parts.label, threadId);
            this.raiseThreadLabelHighWater(session, parts.label);
        }
    }

    // Assign a label to every conversation the session already knows, in a
    // DETERMINISTIC order: recorded turns first (so a pre-R8 transcript keeps the
    // names its root blocks showed: RR1, RR2, RR3 …), then any remaining runtime
    // thread in creation order. Called before a snapshot or a projection, so every
    // consumer (roster, turn badge, block header, reference) reads the same value.
    private ensureThreadLabels(session: Session): void {
        // Adopt every persisted name/counter FIRST (T14/F2), so nothing below can
        // mint an ordinal that a surviving turn record already shows.
        this.adoptPersistedLabels(session);

        const ordered = [...session.turns].sort((left, right) => left.index - right.index);
        for (const turn of ordered) {
            if (turn.threadId === undefined) continue;

            const label = this.ensureThreadLabel(session, turn.threadId);

            // The conversation's canonical name is authoritative for every turn that
            // ran in it: an old turn (no label) adopts it, and a turn whose recorded
            // label conflicts with its own conversation is reconciled to it (the map
            // is the allocation record; see adoptPersistedLabels).
            turn.threadLabel = label;
            this.raiseThreadLabelHighWater(session, label);
        }

        if (!this.threadsSupported(session)) return;

        for (const record of [...session.harness.threads()].sort(
            (left, right) => left.sequence - right.sequence
        )) {
            // Only INDEPENDENT (host) conversations are labelled eagerly. An
            // agent's implicit default conversation is internal plumbing: it takes a
            // number only when a turn actually runs in it, so the first user-opened
            // Researcher thread is `RR1`, not `RR2`.
            if (record.origin !== 'host') continue;

            this.ensureThreadLabel(session, record.id, record.agent);
        }
    }

    // Invocation id → conversation label, for the shared block projection. A
    // delegated child's events carry its runtime invocation id; the shared
    // projector needs that id's CONVERSATION label (not a fresh per-invocation
    // number), so a repeated run in one child conversation keeps one `#` name.
    private invocationThreadLabels(session: Session): Record<string, string> {
        const labels: Record<string, string> = {};

        if (!this.threadsSupported(session)) return labels;

        for (const [invocationId, threadId] of session.invocationThreads) {
            labels[invocationId] = this.ensureThreadLabel(session, threadId);
        }

        for (const [turnId, invocationId] of session.turnInvocations) {
            const turn = session.turns.find((candidate) => candidate.id === turnId);
            if (turn?.threadId === undefined) continue;

            labels[invocationId] = this.ensureThreadLabel(session, turn.threadId);
        }

        for (const record of session.harness.threads()) {
            if (record.invocationId === undefined) continue;

            // T14/F1: only INDEPENDENT (host) conversations own a display name. An
            // agent's DEFAULT conversation (`origin: 'agent'`, id `agent:<name>`) is
            // internal plumbing: minting a number for it would silently consume the
            // ordinal the user's own block or NEXT conversation must show, and no
            // event needs the join — a legacy stream carries no thread metadata, so
            // its blocks are labelled by the shared allocator instead.
            if (record.origin !== 'host') continue;

            labels[record.invocationId] = this.ensureThreadLabel(session, record.id, record.agent);
        }

        return labels;
    }

    // R18/T20: resolve the conversation label of ONE invocation at LOOKUP time, for the
    // live fold (see `displayContext`). This is the same join the eager
    // `invocationThreadLabels` map is built from — invocation → conversation
    // (`session.invocationThreads`) → conversation label (`session.threadLabels`) — read
    // through the store's own allocator, so nothing here numbers a conversation
    // differently: `ensureThreadLabel` returns the recorded name when there is one and is
    // the single mint for a name that is not.
    //
    // In the normal live path the name already exists by the time this is consulted,
    // because the recorder allocates it in the same step it records the join
    // (`noteInvocationThread`); the mint below is therefore only reached for a
    // host-supplied runtime that binds the roster slot without ever passing through that
    // recorder, and it produces exactly the value the next cold replay would read from
    // disk. A branch invocation is never in the join map, so a branch row still resolves
    // nothing (R18: the fold mints no identity the record does not justify).
    private liveThreadLabel(session: Session, invocationId: string): string | undefined {
        if (!this.threadsSupported(session)) return undefined;

        const threadId = session.invocationThreads.get(invocationId);

        if (threadId === undefined) return undefined;

        return this.ensureThreadLabel(session, threadId);
    }

    // The label counters a NEW turn starts from: one chained allocator over the
    // conversation prefix, honouring every recorded seed, raised to the tombstone
    // high-water so a retired textual label is never re-minted after its turns are
    // deleted. Recorded per turn at creation so deleting an earlier thread cannot
    // renumber later blocks.
    //
    // T14/F1: the seed is the union of BOTH durable counters. `mergeLabelHighWater`
    // collects every number the recorded turns show (legacy `/messages` roots,
    // nested blocks, and — through the projector's reservation — each conversation
    // label), while `threadLabelHighWater` carries retired conversation names whose
    // turns are gone. A new block therefore always starts AFTER a conversation name,
    // which is what stops a nested child from being minted the root's number.
    private labelSeedOf(session: Session): Record<string, number> | undefined {
        this.mergeLabelHighWater(session, session.turns);

        const counters: Record<string, number> = Object.fromEntries(session.labelHighWater);

        for (const [code, used] of session.threadLabelHighWater) {
            counters[code] = Math.max(counters[code] ?? 0, used);
        }

        return Object.keys(counters).length === 0 ? undefined : counters;
    }

    // Raise the per-code tombstone high-water from the given turn records. Only
    // counters are recorded; the turns' content is never copied here, so deleting
    // a conversation leaves no recoverable content in the metadata.
    private mergeLabelHighWater(session: Session, turns: readonly SessionTurn[]): void {
        for (const [code, used] of collectAgentLabelCounters(this.projectionTurns(session, turns))) {
            session.labelHighWater.set(code, Math.max(session.labelHighWater.get(code) ?? 0, used));
        }
    }

    // Restore one label counter map IN PLACE from a detached copy. In place on
    // purpose: every reader (and the session record projection) holds a reference to
    // the same Map instance, so replacing `session.threadLabels` would leave a stale
    // view behind.
    private restoreCounterMap<T>(target: Map<string, T>, copy: ReadonlyMap<string, T>): void {
        target.clear();
        for (const [key, value] of copy) target.set(key, value);
    }

    // T14/F1: reserve the one ordinal a legacy `/messages` block will show.
    //
    // A legacy run is a single fresh block with no conversation record, so nothing
    // would otherwise take its number until its first event is projected. A task
    // accepted WHILE that run is still starting would then mint the same label for a
    // new conversation (`RR1` + `RR1`), and a typed `#RR1` would resolve the wrong
    // target (latest-wins). Reserving at turn creation settles the number before any
    // concurrent submit can see it; the block's own projection continues from the
    // seed recorded for this turn, so it lands on exactly this ordinal.
    //
    // The legacy path always runs the preset's PRIMARY agent (`session.harness(...)`
    // calls the entry agent), so its code is known here even with no events yet.
    //
    // The reservation is deliberately NOT released if the run fails before recording
    // a single event: the turn itself IS published (it stays in the transcript as a
    // terminal error row), and re-offering its number afterwards could re-mint a
    // label a `#` reference already resolved to. Only an UNPUBLISHED submit rolls its
    // counters back (see enqueue's persistence rollback).
    private reserveLegacyBlockLabel(session: Session): void {
        const code = agentCodeOf(session.preset.primary);
        this.reserveConversationOrdinal(session, code, this.nextConversationOrdinal(session, code));
    }

    // Bind one explicit reference against the session record. Returns the exact
    // normalised reference to store. See normalizeReferences for the status rules.
    private bindReference(
        session: Session,
        turnIndex: number,
        reference: AgentResultReference
    ): AgentResultReference {        const target = session.turns.find((turn) => turn.id === reference.turnId);

        if (target === undefined) {
            throw new SessionError(
                400,
                `Referenced turn "${reference.turnId}" does not exist in this session.`
            );
        }

        // A reference is always BACKWARD: this also makes a queued-target wait
        // safe, because the target precedes the pump head that will expand it.
        if (target.index >= turnIndex) {
            throw new SessionError(
                400,
                `A reference must target an earlier block; turn "${target.id}" is not earlier than this task.`
            );
        }

        // A terminal target must resolve NOW, so a missing/failed block is a 400
        // rather than a turn that fails later.
        if (target.status === 'running' || target.status === 'queued') {
            // A running target may not have produced the block yet. Keep the
            // client's binding (the UI's stable `call:<callId>` alias for a pending
            // delegation, or `inline:<agent>` for a legacy stream) and resolve it at
            // EXECUTION after adoption/completion. Nothing partial is read here.
            return { ...reference };
        }

        // Conversation prefix (not just `[target]`): see `turnsThrough`. The
        // recorded seeds keep a surviving turn's labels stable after a deletion.
        const block = findAgentResultBlock(
            this.projectionTurns(session, this.turnsThrough(session, target.index)),
            reference
        );

        if (block === undefined) {
            throw new SessionError(
                400,
                `Turn "${target.id}" has no block labelled "#${reference.label}"${reference.threadId === undefined ? '' : ` (thread "${reference.threadId}")`}.`
            );
        }

        if (block.status === 'error' || block.status === 'cancelled') {
            throw new SessionError(
                400,
                `Block "#${reference.label}" cannot be referenced because it ended as ${block.status}.`
            );
        }

        if (block.status !== 'done') {
            throw new SessionError(
                400,
                `Block "#${reference.label}" cannot be referenced because it is still ${block.status}.`
            );
        }

        if (block.content === undefined) {
            throw new SessionError(
                400,
                `Block "#${reference.label}" has no completed result content to reference.`
            );
        }

        return {
            turnId: block.turnId,
            ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
            label: block.label
        };
    }

    // Expand every reference into the prompt the harness actually receives. This
    // runs at EXECUTION, after the fresh-conversation reset, so:
    //   - a target that was still streaming has had time to finish;
    //   - the content is the recorded terminal `done` text, never a delta stream;
    //   - a target that failed/cancelled after binding rejects THIS turn clearly
    //     instead of injecting nothing and silently running.
    private async expandReferences(session: Session, turn: SessionTurn): Promise<string> {
        return this.composeReferences(session, turn.prompt, turn.references);
    }

    // The shared composer: wait for every referenced target to settle, resolve its
    // recorded block, and inject the terminal `done` content. Used by BOTH an
    // executing turn and a steered submit (F3), so focused guidance carries exactly
    // the same reference context as a normal prompt.
    private async composeReferences(
        session: Session,
        prompt: string,
        references: readonly AgentResultReference[] | undefined
    ): Promise<string> {
        if (references === undefined || references.length === 0) return prompt;

        const entries: { block: AgentResultBlock; content: string }[] = [];

        for (const reference of references) {
            const target = session.turns.find((candidate) => candidate.id === reference.turnId);

            if (target === undefined) {
                throw new Error(
                    `Referenced block "#${reference.label}" is no longer available: turn "${reference.turnId}" is gone.`
                );
            }

            // Coarse but honest: wait for the whole target TURN to settle. FIFO
            // normally means it already has; this is the explicit guarantee for a
            // target that was streaming when the task was accepted.
            await this.waitForTurnTerminal(session, target);

            if (session.disposed) {
                throw new Error('The session was removed while waiting for a referenced block.');
            }

            // Conversation prefix (not just `[target]`): see `turnsThrough`. The
        // recorded seeds keep a surviving turn's labels stable after a deletion.
        const block = findAgentResultBlock(
            this.projectionTurns(session, this.turnsThrough(session, target.index)),
            reference
        );

            if (block === undefined) {
                throw new Error(
                    `Referenced block "#${reference.label}" is missing from turn "${target.id}".`
                );
            }

            if (block.status !== 'done') {
                throw new Error(
                    `Referenced block "#${reference.label}" cannot be used because it ended as ${block.status}.`
                );
            }

            if (block.content === undefined) {
                throw new Error(
                    `Referenced block "#${reference.label}" has no completed result content.`
                );
            }

            entries.push({ block, content: block.content });
        }

        return composeAgentResultPrompt(prompt, entries);
    }

    // Synchronous variant for a STEERED submit (F3): the runtime's steering API is
    // synchronous and the caller (enqueue) is synchronous too. It returns undefined
    // when any referenced target is not terminal yet, which makes the caller queue a
    // continuation turn instead of steering without its context.
    private composeSteerReferences(
        session: Session,
        prompt: string,
        references: readonly AgentResultReference[]
    ): string | undefined {
        if (references.length === 0) return prompt;

        const entries: { block: AgentResultBlock; content: string }[] = [];

        for (const reference of references) {
            const target = session.turns.find((candidate) => candidate.id === reference.turnId);
            if (target === undefined || target.status !== 'done') return undefined;

            const block = findAgentResultBlock(
                this.projectionTurns(session, this.turnsThrough(session, target.index)),
                reference
            );

            if (block === undefined || block.status !== 'done' || block.content === undefined) {
                return undefined;
            }

            entries.push({ block, content: block.content });
        }

        try {
            return composeAgentResultPrompt(prompt, entries);
        } catch {
            // Over-budget context: a continuation turn fails readably at execution;
            // steering without the context would silently drop it.
            return undefined;
        }
    }

    // Park until one turn is no longer queued/running. `turnWaiters` is woken by
    // every settlement path (executeTurn finally, cancel-all, dispose) and the
    // caller re-checks the status, so a wake for a different turn is harmless.
    private async waitForTurnTerminal(session: Session, turn: SessionTurn): Promise<void> {
        while (!session.disposed && (turn.status === 'queued' || turn.status === 'running')) {
            await new Promise<void>((resolve) => {
                session.turnWaiters.push(resolve);
            });
        }
    }

    private releaseTurnWaiters(session: Session): void {
        const waiters = session.turnWaiters.splice(0);
        for (const wake of waiters) wake();
    }

    // QUEUE submit (POST /sessions/:id/tasks): accept the task now, execute later.
    //
    // Validation and the pending cap run BEFORE any mutation, so a 400/413/429
    // leaves the session exactly as it was. The turn gets its stable id and index
    // here — a client can address it as 'queued' immediately — and `startedAt` is
    // deliberately absent until the pump begins it.
    //
    // The returned promise does NOT wait for execution: the 202 body is ready as
    // soon as the turn is enqueued.
    //
    // `attachments` is a TRAILING optional parameter (T3), so `enqueue(id, input)`
    // keeps working unchanged. `references` is an even later trailing parameter
    // (R2), for the same compatibility reason. Media and reference validation run
    // before the pending-count check and before any mutation, and the accepted
    // copies are persisted with the queued turn so a restart still has the real
    // bytes and the bound reference list.
    //
    // `threadId` is the FINAL trailing parameter (R1-R6). Absent opens a new
    // standalone host thread (this submit's block); a running thread is STEERED; an
    // idle/stopped thread gets a continuation turn. See SubmitTaskRequest.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    //
    // The 202 still does not wait for EXECUTION (see `settled`); it waits only for the
    // accepted backlog to be durable, which is what a restart needs to keep the prompt.
    async enqueue(
        id: string,
        rawInput: string,
        attachments?: unknown,
        references?: unknown,
        threadId?: unknown
    ): Promise<EnqueuedTask> {
        const session = this.require(id);
        const validated = validateAttachmentsForSubmit(attachments);
        const input = validateInput(rawInput, validated.length);
        const wantedThread = this.normalizeThreadId(threadId);

        // BIND now (R2): the referenced turn/block must exist and be a PRIOR
        // completion target, so a bad reference is a 400 before a turn exists.
        // Content is deliberately NOT read here: a still-running target is queued
        // and expanded at EXECUTION (see expandReferences) after it completes.
        // The prospective index is the monotonic high-water mark (not the array
        // length), so a deletion never lets a new turn sort before a survivor.
        const boundReferences = this.normalizeReferences(
            session,
            session.turnSequence,
            input,
            references
        );

        // Pending only. The active turn is not in a queue, so one task per lane can
        // run while this many wait; the cap spans every lane so spreading work over
        // threads cannot bypass the backlog bound.
        if (this.pendingCount(session) >= MAX_PENDING_TASKS) {
            throw new SessionError(
                429,
                `A session cannot queue more than ${MAX_PENDING_TASKS} pending tasks.`
            );
        }

        // STEERING (R5/F3): a submit addressed to a RUNNING thread lands at its next
        // safe model boundary. No new turn is recorded — the response names the turn
        // that owns the run — so a focused follow-up cannot duplicate the transcript.
        // Reference context is expanded into the steered text (the audit keeps the
        // user's prompt and the bound blocks); ATTACHMENTS are never steered (the
        // runtime's steer API is text-only), so such a submit falls through to a
        // queued continuation that keeps its bytes.
        if (wantedThread !== undefined) {
            // Awaited because the lane's steering answer is a frame round-trip (T12): the
            // receipt, not the POST, decides whether this submit steered or became a
            // continuation.
            const steered = await this.steerIntoThread(
                session,
                wantedThread,
                input,
                validated,
                boundReferences
            );
            if (steered !== undefined) return steered;
        }

        const now = Date.now();
        const index = session.turnSequence;
        session.turnSequence += 1;

        // The counters THIS turn starts from, computed over the conversation as it
        // exists BEFORE this submit opens a thread. Recording the pre-thread state
        // keeps a first submit's record exactly as it was (no seed) while a later
        // turn still starts after every label the earlier turns show — the
        // conversation label itself is reserved by the projection, so leaving it out
        // of the seed cannot renumber a nested block.
        const seed = this.labelSeedOf(session);

        // T14/F3: snapshot the label bookkeeping BEFORE this submit mints anything,
        // so a failed write can restore it exactly (see the catch below). Only the
        // three label maps mutate between here and the save, and opening a host
        // thread already allocates its label (the harness notifies the store, which
        // projects the roster), so the capture must precede `createSubmitThread`.
        const previousThreadLabels = new Map(session.threadLabels);
        const previousThreadLabelHighWater = new Map(session.threadLabelHighWater);
        const previousLabelHighWater = new Map(session.labelHighWater);

        // Resolve the execution thread. An explicit id is used as-is (a stopped
        // thread is revived by the explicit host action); an unfocused submit opens
        // a NEW standalone host thread. A reference is a LINK, not ownership: the
        // new conversation is never owned by the thread it references, so stopping
        // or deleting that source cannot destroy it (see SessionThread).
        let createdThreadId: string | undefined;
        const targetThread =
            wantedThread ??
            (this.threadsSupported(session)
                ? (createdThreadId = this.createSubmitThread(session))
                : undefined);

        // R8: bind the conversation's display name at CREATION. A continuation
        // (same thread) reuses the existing label; a new standalone thread consumed
        // exactly one ordinal when it was opened above.
        const targetLabel =
            targetThread === undefined ? undefined : this.ensureThreadLabel(session, targetThread);

        // `status: 'queued'` and no `startedAt`: this record is complete and
        // renderable before any execution, which is what lets a reload show the
        // backlog. `events`/`eventTimes` start empty and are filled by the pump.
        const turn: SessionTurn = {
            id: randomUUID(),
            index,
            prompt: input,
            threadId: targetThread,
            ...(targetLabel === undefined ? {} : { threadLabel: targetLabel }),
            // Omitted when nothing was referenced, so a plain task keeps the exact
            // legacy record shape. The bound list is persisted and expanded later.
            ...(boundReferences.length === 0 ? {} : { references: boundReferences }),
            // Omitted for a text-only turn (legacy shape); the validated copies
            // are the ones persisted and later handed to the harness.
            ...(validated.length === 0 ? {} : { attachments: validated }),
            status: 'queued',
            updatedAt: now,
            events: [],
            eventTimes: []
        };

        if (seed !== undefined) session.labelSeeds.set(turn.id, seed);

        session.turns.push(turn);
        // F1: EVERY thread-capable submit runs in its thread's own LANE, so two
        // plain submits are concurrent instead of serialized through the legacy
        // queue (the legacy queue survives only for a harness handle without the
        // thread API). Within one lane the pump stays strictly FIFO.
        const lane =
            targetThread === undefined ? undefined : this.laneOf(session, targetThread);
        (lane?.queue ?? session.queue).push(turn);
        session.updatedAt = now;

        // Completion for callers that want to await THIS turn (tests, tools). The
        // resolver is settled by the pump's terminal transition or by a cancel-all
        // drop; the HTTP layer never waits on it.
        let settleTurn!: () => void;
        const settled = new Promise<void>((resolve) => {
            settleTurn = resolve;
        });
        session.settlers.set(turn.id, settleTurn);

        // Persist the accepted backlog before the 202: a queued prompt is user work
        // that a restart must preserve. Roll back the in-memory entry on failure so
        // a retry cannot duplicate it (including the host thread this submit opened).
        try {
            await this.persistOrThrow();
        } catch (error) {
            const at = session.turns.indexOf(turn);
            if (at !== -1) session.turns.splice(at, 1);

            const queued = (lane?.queue ?? session.queue).indexOf(turn);
            if (queued !== -1) (lane?.queue ?? session.queue).splice(queued, 1);

            session.labelSeeds.delete(turn.id);
            session.settlers.delete(turn.id);

            // T14/F3: the label this submit minted was NEVER PUBLISHED (the 202 never
            // left, the turn never ran), so the counters must roll back with the
            // thread. Leaving them behind would retire an ordinal the user never saw
            // and the next accepted submit would be numbered past it (RR5 instead of
            // the expected RR4).
            this.restoreCounterMap(session.threadLabels, previousThreadLabels);
            this.restoreCounterMap(session.threadLabelHighWater, previousThreadLabelHighWater);
            this.restoreCounterMap(session.labelHighWater, previousLabelHighWater);

            // The new thread was created for this submit only; a failed write must
            // not leave an empty conversation behind.
            if (createdThreadId !== undefined) {
                try {
                    session.harness.deleteThread(createdThreadId);
                } catch {
                    // Already refused/absent: the submit's rollback is complete.
                }
            }

            throw error;
        }

        // Capture the ACCEPTED state before the pump can start the turn: the 202
        // body must report `status: 'queued'` (and the queueDepth that included
        // this submit), even though the pump may begin executing in this same tick.
        const snapshot = this.snapshot(session);
        const queuedTurn = copyTurn(turn);

        // Upsert first, so a watcher that receives it can already count this turn
        // as queued. Then start (or join) the pump, which is decoupled from any
        // response: `void` on purpose, nothing here waits for execution.
        this.publish(session, { type: 'turn', turn: copyTurn(turn) });

        if (lane === undefined) void this.pump(session);
        else void this.pumpLane(session, lane);

        return { session: snapshot, turn: queuedTurn, settled };
    }

    // -----------------------------------------------------------------------
    // SERVER-SIDE SLASH COMMANDS: dispatch() + executeCommandTurn()
    // -----------------------------------------------------------------------
    //
    // WHY A THIRD SUBMIT PATH EXISTS
    // ------------------------------
    // `run()` owns its run in an SSE response and `enqueue()` hands work to a lane
    // pump. Both send the text to a MODEL. A slash command must do neither: it is an
    // operator action whose answer is produced in THIS process by the harness's own
    // command registry (../harness.ts executeCommand, ../core/command.ts grammar).
    // So dispatch() is the ONE submit surface a host calls, and it splits:
    //
    //   - NOT command-shaped text  -> enqueue(), untouched;
    //   - `/name ...`              -> executeCommandTurn(), no model, no lane.
    //
    // The command still becomes a normal SessionTurn with synthesized events, so the
    // transcript, the reload, and GET /events need ZERO frontend changes; and it is
    // terminal BEFORE the 202 body is produced, which is why nothing enters a queue.
    //
    // Commands deliberately bypass the single-flight gate and the pending cap: they
    // are short, they never touch a conversation's transcript, and `/task` has to
    // stay readable while a model run is streaming. A command whose tool call is
    // genuinely unsafe right now is refused by the harness itself, and that refusal
    // becomes an error TURN (a visible answer), not a 500.
    //
    // `attachments`/`references`/`threadId` are typed (not `unknown` like enqueue's):
    // a command has no schema to validate against — all three are refused or ignored,
    // so the only caller is the /tasks route, which already passes those fields.
    async dispatch(
        id: string,
        rawInput: string,
        attachments?: readonly HarnessAttachment[],
        references?: readonly AgentResultReference[],
        threadId?: string
    ): Promise<EnqueuedTask> {
        // NOT a command: hand the submit to enqueue() UNTOUCHED, before validating
        // anything here. enqueue() validates attachments BEFORE the empty/length
        // check, and a malformed clip plus an empty prompt must keep answering the
        // attachment error it answers today (a pre-check here would turn that into
        // "A task cannot be empty."). parseCommandLine also answers undefined for a
        // non-string, so the whole legacy surface is preserved by this one branch.
        if (parseCommandLine(rawInput) === undefined) {
            return this.enqueue(id, rawInput, attachments, references, threadId);
        }

        const session = this.require(id);

        // A host handle built before the command registry has no `executeCommand`
        // (same capability-guard shape as threadsSupported). Sending the line to the
        // model is exactly what such a server did before, so it stays the fallback.
        if (typeof (session.harness as Partial<Harness>).executeCommand !== 'function') {
            return this.enqueue(id, rawInput, attachments, references, threadId);
        }

        // Refuse what a command cannot express, BEFORE any turn exists and before the
        // input is bounded, so a rejected command mutates nothing and a retry is safe
        // (the same rule, and the same order, as enqueue).
        if (submittedCount(attachments) > 0) {
            throw new SessionError(400, COMMAND_ATTACHMENT_MESSAGE);
        }

        if (submittedCount(references) > 0) {
            throw new SessionError(400, COMMAND_REFERENCE_MESSAGE);
        }

        // ONE shared validation (empty/200k), so a command cannot dodge the bounds a
        // prompt is held to. The count only matters for an EMPTY prompt, and a
        // command line is never empty (a leading "/" is required to get here), so it
        // can only ever contribute the 413 — never a different error than enqueue's.
        //
        // ORDER (C8-m5): this runs AFTER the two rejections above, exactly like
        // enqueue(), which validates attachments before `validateInput`. An over-long
        // submit that also carries an attachment must answer the attachment problem it
        // answers on the queue path, not a length 413.
        const input = validateInput(rawInput, submittedCount(attachments));

        // `threadId` is ACCEPTED and ignored on purpose. The command acts on the
        // SESSION (its task list, its tool registry), never on a conversation, so its
        // turn must not join a lane, must not be steered into a running thread, and
        // must not be purged when the focused conversation is later stopped/deleted.
        // Validating the field would only invent a 400 for a value with no meaning.
        return this.executeCommandTurn(session, input);
    }

    // Execute one command line as a single, fully-recorded turn. Called only by
    // dispatch() once the input is known to be command-shaped and `id` resolves.
    //
    // Event shapes are NOT invented: `start` + `tool_call` + `tool_result` are the
    // frames the renderers already switch on (frontend/ui/turns.ts `case 'start'` /
    // `'tool_call'` / `'tool_result'`, ui/activity.ts), paired by `callId`. A command
    // produces no `text`/`usage`/`done` because nothing was generated and nothing was
    // billed.
    private async executeCommandTurn(session: Session, input: string): Promise<EnqueuedTask> {
        const now = Date.now();

        // Monotonic index, exactly like enqueue: the high-water mark moves even if
        // this turn is later rolled back, so no two records ever share an index.
        const index = session.turnSequence;
        session.turnSequence += 1;

        // Born 'running' (never 'queued' — there is no pump in its life) and with NO
        // threadId/threadLabel, which is the record shape the UI already renders for a
        // thread-less turn. No `attachments`/`references`/`usage` keys at all, so the
        // record keeps the plainest historical shape (copyTurn omits absent keys).
        const turn: SessionTurn = {
            id: randomUUID(),
            index,
            prompt: input,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            events: [],
            eventTimes: []
        };

        session.turns.push(turn);
        session.updatedAt = now;

        // DURABILITY BEFORE WORK (R3b): nothing has executed yet, so a failed write
        // means the command simply did not happen, and the record rolls back the same
        // way a failed enqueue does. The 500 from persistOrThrow propagates.
        try {
            await this.persistOrThrow(undefined, { fenceSessions: [session.id] });
        } catch (error) {
            const at = session.turns.indexOf(turn);
            if (at !== -1) session.turns.splice(at, 1);

            throw error;
        }

        // Open the turn frame before ANY event, so a watcher can always attribute what
        // it receives (the rule executeTurn follows for a model run).
        this.publish(session, { type: 'turn', turn: copyTurn(turn) });

        const agent = commandAgentOf(session);
        const model = commandModelOf(session);

        // One synthesized call id pairs the tool_call with its result, which is how
        // the frontend resolves a call row (callId matching, never positional).
        const callId = randomUUID();

        // Record-then-publish for every event: the server's transcript is
        // authoritative even when every watcher is gone, and `at` is the ONE timestamp
        // shared by the frame and the parallel `eventTimes` entry, so a live view and
        // a reload agree exactly.
        const record = (event: HarnessEvent): void => {
            // Same addressing/fold order as the model-run recorder above: the journal
            // and the compiled state describe a COMMAND turn exactly as they describe a
            // model turn, so a slash command's steps survive a restart and render from
            // the compact surface (R4).
            const index = turn.events.length;
            const projector = this.projectorFor(session, turn);
            const stored = copyEvent(event);
            const at = Date.now();

            turn.events.push(stored);
            turn.eventTimes?.push(at);
            turn.updatedAt = at;

            this.journalAppend(session, turn.id, index, at, stored);

            // T10: same freeze as the model-run recorder, so a command turn's section
            // reports the same kind of system segment (and an interrupted command turn
            // still rebuilds it).
            if (stored.type === 'start') this.noteInstructionSource(session, turn.id, stored.agent);

            const ops = projector.apply(stored, at, index);

            // Background durability for a non-delta event (every event here is one),
            // bounded by the same interval so a command never pays one document rewrite
            // per step. A failed write is recorded, never thrown: the command's outcome
            // must not depend on the disk, and the terminal save below is the strict one.
            this.checkpoint(session);
            this.publishViewOps(session, turn.id, at, ops);

            this.publish(session, {
                type: 'event',
                turnId: turn.id,
                event: copyEvent(stored),
                at
            });
        };

        record({ type: 'start', agent, model });

        record({
            type: 'tool_call',
            agent,
            call: {
                id: callId,
                name: COMMAND_TOOL_NAME,
                // `HarnessToolCall.arguments` is a raw JSON STRING (the wire shape —
                // see ../types/index.ts), so the command line rides INSIDE that JSON
                // instead of being an object literal. Echoing the whole line keeps the
                // record re-runnable by hand.
                arguments: JSON.stringify({ input })
            }
        });

        let result: HarnessCommandResult;

        try {
            // THE command. No model request, no lane, no steering, no gate. The
            // harness owns the "unsafe right now" decision (a built-in that calls a
            // tool can be refused mid-run); that refusal throws and lands below as an
            // error turn, which is an answer rather than a transport failure.
            // T5 (D1): a slash command is an operator action, not a model turn - but in
            // worker mode its BODY still runs on a lane worker (the session's operator lane),
            // and the shared operations it performs route to the authority. A command that
            // mutates (e.g. /tools enable) therefore lands canonically, exactly as inline.
            result = this.workerExecution
                ? (await this.lanes().invoke({
                      sessionKey: session.id,
                      authority: this.authorityOf(session),
                      request: { op: 'execute:command', line: input },
                      blueprint: this.blueprintFor(session)
                  })) as HarnessCommandResult
                : await session.harness.executeCommand(input);
        } catch (error) {
            // Total, on purpose. `executeCommand` THROWS for an unknown name
            // ("unknown command: /nope") and rethrows whatever a host command throws.
            // A user-visible typo must never become an unhandled rejection or a 500,
            // so it becomes the same error-shaped result a built-in returns.
            result = { content: messageOf(error), isError: true };
        }

        const isError = result.isError === true;

        record({
            type: 'tool_result',
            agent,
            name: COMMAND_TOOL_NAME,
            callId,
            // Always a string: executeCommand normalizes `content`, and the catch
            // above builds one, so a renderer never sees undefined.
            content: result.content,
            isError,
            // Supplied explicitly because `outcome` is authoritative for the UI (an
            // error-shaped call with no outcome reads as 'failed' anyway, but naming it
            // keeps the record self-describing, and 'completed' is the real state).
            outcome: isError ? 'failed' : 'completed'
        });

        // Terminal status. NO `usage` (no provider request happened — an absent tally
        // is the honest "nothing was billed", never a fabricated 0).
        turn.status = isError ? 'error' : 'done';
        turn.updatedAt = Date.now();

        // `session.status` is NOT touched, and neither is `lastError`: a command is
        // not a run, so an idle session stays idle while it executes and a failed
        // `/task bogus` must not raise the session-wide error banner a real run owns.
        // Only the activity timestamp moves.
        session.updatedAt = turn.updatedAt;

        // Commit the harness state the command mutated (a `/task add` changed the task
        // store; the core observer captured that boundary already, this refresh makes
        // the terminal record and the post-command snapshot agree).
        try {
            session.core = session.harness.snapshot();
        } catch {
            // Defensive: keep the last committed snapshot; the turn is terminal either
            // way and the command already produced its answer.
        }

        // The TURN record must be durable before the 202 leaves. Unlike the core
        // refresh above (best effort), a failed terminal save IS an error: the server
        // cannot promise a transcript it did not write.
        //
        // SKIPPED for a disposed session or a closing store (the P1-B rule executeTurn
        // follows): remove()/dispose() already cleared this session from the map, so a
        // save here would rewrite the document WITHOUT it (or with an empty session
        // list) and destroy the graceful-shutdown file. The command already ran, and
        // publish() is a no-op for a disposed session either way.
        //
        // C8-m4: a failed write must still TERMINATE the live turn. The published
        // frames are the only view a watcher has, and the one before this call said
        // `running`; skipping the terminal upsert (the old behaviour: throw first,
        // publish never) left every browser with an in-flight card that no later frame
        // would ever close. So the terminal frames go out FIRST, and the failure is
        // rethrown so the route still answers 500 — the durability problem is
        // reported, never swallowed. The status is downgraded to `error` rather than
        // kept `done`, because "done" would claim a transcript the disk refused.
        if (!session.disposed && !this.shuttingDown) {
            try {
                await this.persistOrThrow(undefined, { fenceSessions: [session.id] });
            } catch (error) {
                turn.status = 'error';
                turn.updatedAt = Date.now();
                session.updatedAt = turn.updatedAt;

                // Same closing sequence as the success path below: one terminal upsert
                // replaces the running row, and the idle snapshot only rides out when
                // nothing else in this session is still live.
                this.publish(session, { type: 'turn', turn: copyTurn(turn) });

                if (this.isIdle(session)) {
                    this.publish(session, { type: 'snapshot', session: this.snapshot(session) });
                }

                throw error;
            }
        }

        // One terminal upsert replaces the running row for every watcher.
        this.publish(session, { type: 'turn', turn: copyTurn(turn) });

        // The drain snapshot rides the SAME rule as the lane pump: publish only when
        // NOTHING else is live, so a sibling conversation that is still executing
        // never receives a premature "everything settled".
        const finished = this.snapshot(session);

        if (this.isIdle(session)) {
            this.publish(session, { type: 'snapshot', session: finished });
        }

        // `settled` is already resolved: the caller (a test, or a host that wants the
        // answer) never has to poll, because the command completed before the response.
        return { session: finished, turn: copyTurn(turn), settled: Promise.resolve() };
    }

    // Validate the optional `threadId` submit field. A non-string or blank value is
    // a 400 BEFORE any mutation; an unknown/deleted id is a 404 (an honest "no such
    // conversation" rather than silently opening a new thread).
    private normalizeThreadId(value: unknown): string | undefined {
        if (value === undefined) return undefined;

        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new SessionError(400, '`threadId` must be a non-empty string when present.');
        }

        return value.trim();
    }

    // STEER a running thread, or return undefined when it is not running (the
    // caller then enqueues a continuation). The owning turn is returned rather
    // than a duplicate record: its event log is where the steered text lands.
    //
    // ASYNC because of worker mode: in line the runtime answers `steerThread` synchronously,
    // while a lane answers its `steer.result` frame (./workers/lane-host.ts), and the store may
    // only claim the guidance landed once one of those two says so (T12).
    private async steerIntoThread(
        session: Session,
        threadId: string,
        input: string,
        attachments: readonly HarnessAttachment[],
        references: readonly AgentResultReference[]
    ): Promise<EnqueuedTask | undefined> {
        if (!this.threadsSupported(session)) {
            throw new SessionError(400, 'This session does not support persistent threads.');
        }

        const record = session.harness.thread(threadId);

        if (record === undefined) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        const lane = session.lanes.get(threadId);
        const running = record.status === 'running' || lane?.active !== undefined;
        if (!running) return undefined;

        // F3: the runtime's steering API carries TEXT only. An attachment-only (or
        // attachment-bearing) focused submit must never pretend its bytes were
        // delivered, so it becomes a queued continuation in the same thread and
        // keeps them.
        if (attachments.length > 0) return undefined;

        // Reference context is part of the steered text: a focused follow-up gets
        // exactly what a normal turn prompt would (block content inside the shared
        // delimiters). A target that is not terminal yet cannot be injected safely,
        // so the submit becomes a queued CONTINUATION instead (it expands at
        // execution like any other turn) rather than steering without its context.
        const steeredText = this.composeSteerReferences(session, input, references);
        if (steeredText === undefined) return undefined;

        let receipt;
        try {
            receipt = this.workerExecution
                ? await this.steerOnLane(session, threadId, steeredText)
                : session.harness.steerThread(threadId, steeredText);
        } catch (error) {
            // A runtime refusal is a client/lifecycle error (400/429), never a 500.
            throw this.threadError(error, 'Could not steer the thread');
        }

        if (!receipt.queued) return undefined;

        const owning = this.owningTurnOf(session, threadId);

        if (owning === undefined) {
            // A runtime-driven child run (a delegation) can be running without a
            // server turn of its own; its steering target is the parent turn, which
            // is found through the owner chain. Reaching here means no recorded turn
            // owns the conversation, so there is nothing to report as the accepting
            // record.
            throw new SessionError(
                409,
                `Thread "${threadId}" is running but no recorded turn owns it; stop it before submitting.`
            );
        }

        // Audit WITHOUT duplicating the event transcript: the guidance itself
        // appears in the conversation at the next model boundary; the owning turn
        // keeps what was sent, when, and which blocks it carried.
        const at = Date.now();
        const submit = {
            // T13: the submit's own durable identity, minted ONCE here. The context
            // bar keys one segment per submit, and the two figures it used to derive
            // that key from (`at` + text length) are not unique — a double Enter on two
            // equal-length messages lands in the same millisecond. An id also survives
            // the ring truncation below: trimming an older submit can never renumber a
            // surviving one, and it is the key the T14 text archive is addressed by.
            id: randomUUID(),
            at,
            prompt: input,
            // T12b: attribute the steer to the conversation it actually
            // reached. A parent turn owning a running CHILD records the child
            // id; a normal steer into the owner's own thread omits the field
            // (keeping the pre-T12b wire shape for root conversations).
            ...(owning.threadId !== undefined && owning.threadId !== threadId
                ? { threadId }
                : {}),
            ...(references.length === 0
                ? {}
                : { references: references.map((reference) => ({ ...reference })) })
        };

        owning.steers = [...(owning.steers ?? []), submit].slice(-MAX_STEER_RECORDS) as SessionTurn['steers'];

        // T14: the durable TEXT archive, keyed by that same identity. The ring above is the
        // operational audit (and the compact row), so its 65th submit used to strand the
        // context bar's own segment for an older guidance text: the segment stayed on the
        // bar, while its click had nothing left to return. This archive keeps the EXACT
        // submitted text of EVERY submit the server accepted, so any segment the bar draws
        // resolves — now, after a restart, and however long the turn was steered — and it is
        // what the fold mints steered segments from (./turn-projector.ts `syncSteerBlocks`).
        // T15: it is NOT truncated. An accepted submit is the user's own data, so the archive
        // keeps all of it; its volume is bounded at the source instead — one entry per accepted
        // steer, guidance is only accepted while a thread runs (the runtime drains the queue at
        // the next safe boundary), and every submit is already capped at 200,000 characters by
        // `validateInput`/`MAX_INPUT_LENGTH` above (line 1130) before it can reach this line.
        // That is the same reasoning that leaves `turn.events` unbounded. The 64-entry cap
        // above belongs to the rolling audit ring, not to this record. It carries only what a
        // text answer needs (no `references`: the audit ring above is where the bound blocks
        // live).
        owning.steerTexts = [
            ...(owning.steerTexts ?? []),
            {
                id: submit.id,
                at,
                prompt: input,
                ...(submit.threadId === undefined ? {} : { threadId: submit.threadId })
            }
        ] as SessionTurn['steerTexts'];

        session.updatedAt = at;

        // T14: steer the DISPLAY as well as the record. A steered submit is not a recorded
        // event, so the cached fold would otherwise not draw this submit's context segment
        // until the run's next event — while the reader has already typed it and (with the
        // archive above) its text is durable. Adopting here means the segment is on the bar
        // and resolvable through `blockDetail` from the moment the submit is accepted, and
        // the returned ops go to live display watchers exactly like a recorded event's do.
        // No cached projector means nothing to adopt yet: the turn's first event (or its
        // settle) folds the whole submit list anyway.
        const liveProjection = session.projections.get(owning.id);

        if (liveProjection !== undefined) {
            this.publishViewOps(session, owning.id, at, liveProjection.syncSteers(at));
        }

        // Steering is delivered to a LIVE run and is lost on restart by definition
        // (the run is interrupted). The audit record is durable, but a write failure
        // must not claim the guidance was rejected: it IS queued in the runtime, so
        // report the real outcome and surface the write error separately.
        this.persistBestEffort();

        return {
            session: this.snapshot(session),
            turn: copyTurn(owning),
            // Nothing to await: the text is folded into the run already in flight.
            settled: Promise.resolve(),
            steered: true,
            steeredThreadId: threadId
        };
    }

    // The recorded turn that owns a running thread: its own lane, an ancestor
    // lane's turn (a delegated child runs inside its parent), else the newest
    // running turn (a legacy-pump thread turn). Undefined only for runtime-driven
    // work no server turn recorded.
    private owningTurnOf(session: Session, threadId: string): SessionTurn | undefined {
        const own = session.lanes.get(threadId)?.active;
        if (own !== undefined) return own;

        if (!this.threadsSupported(session)) return undefined;

        const records = new Map(session.harness.threads().map((record) => [record.id, record]));
        const seen = new Set<string>([threadId]);
        let current = records.get(threadId)?.ownerThreadId;

        while (current !== undefined && !seen.has(current)) {
            seen.add(current);

            const ancestor = session.lanes.get(current)?.active;
            if (ancestor !== undefined) return ancestor;

            current = records.get(current)?.ownerThreadId;
        }

        const byThread = [...session.turns]
            .sort((left, right) => left.index - right.index)
            .filter((turn) => turn.threadId === threadId && turn.status === 'running')
            .pop();
        if (byThread !== undefined) return byThread;

        return [...session.turns]
            .sort((left, right) => left.index - right.index)
            .filter((turn) => turn.status === 'running')
            .pop();
    }

    // Open the STANDALONE host thread for an unfocused submit (R1-R6).
    //
    // F2: a reference is NOT ownership. `ownerThreadId` is reserved for the
    // runtime's delegation lineage (a child conversation). A "# connected" submit
    // records the relation on the TURN (`references`) and the roster derives
    // `connectedThreadIds` from those links, so stopping/deleting a referenced
    // source can never abort or purge this new conversation.
    //
    // F8: the runtime's host-thread bound is a lifecycle failure, not a server bug.
    // It becomes an actionable 429; any other harness refusal is a 400.
    private createSubmitThread(session: Session): string {
        try {
            return session.harness.createThread(session.preset.primary).id;
        } catch (error) {
            throw this.threadError(error, 'Could not open a new thread');
        }
    }

    // Map a runtime thread error onto a client status. Capacity ("already has N
    // independent threads … delete a terminal one") is a 429; everything else the
    // runtime refuses about a thread operation (unknown agent, blank/oversized
    // label, …) is a 400. The message stays the runtime's actionable text.
    private threadError(error: unknown, context: string): SessionError {
        const message = messageOf(error);

        if (/already has \d+ independent threads|delete a terminal one/i.test(message)) {
            return new SessionError(
                429,
                `${context}: ${message}`
            );
        }

        return new SessionError(400, `${context}: ${message}`);
    }

    // Drain the queue strictly FIFO, one turn at a time (R4).
    //
    // The pump is decoupled from clients: it is started by enqueue(), never by a
    // stream, so work accepted with 202 continues after the browser disconnects.
    // Watchers can neither cancel nor block it (publish never awaits, never
    // throws, and drops a failing watcher).
    //
    // The single-flight gate is shared with run()/callTool()/reset(): while one of
    // those holds `busy`, the pump parks in waitForBusy() and retries the SAME
    // head afterwards, so no turn is skipped and none runs concurrently with a
    // legacy run or a manual call. `pumping` is set synchronously before the first
    // await, so a second enqueue can never start a second worker.
    private async pump(session: Session): Promise<void> {
        if (session.pumping) return;
        session.pumping = true;

        try {
            while (!session.disposed) {
                // Peek, never shift: a turn only leaves the queue when the pump
                // actually starts it (or cancel-all drops it). That is what keeps
                // FIFO intact across waits.
                const head = session.queue[0];
                if (head === undefined) break;

                if (session.busy) {
                    await this.waitForBusy(session);
                    continue;
                }

                session.queue.shift();

                try {
                    // An unfocused submit runs inside the host thread it opened; its
                    // transcript is empty, so no fresh-block reset is needed. The
                    // legacy `/messages` path (threadId undefined) keeps the reset.
                    await this.executeTurn(
                        session,
                        head,
                        undefined,
                        undefined,
                        head.threadId === undefined
                            ? { freshBlock: true }
                            : { threadId: head.threadId }
                    );
                } catch (error) {
                    // executeTurn absorbs harness failures itself; this is the
                    // last-resort guard so an unexpected internal throw can never
                    // park the queue with `pumping` stuck true. The turn is
                    // terminal as an error and the next one still runs.
                    session.status = 'error';
                    session.lastError = messageOf(error);
                    head.status = 'error';
                    head.updatedAt = Date.now();
                    this.publish(session, { type: 'turn', turn: copyTurn(head) });
                    this.settle(head, session);
                    this.releaseDrain(session);
                }
            }
        } finally {
            session.pumping = false;

            // DRAIN: nothing is queued and nothing is executing, so watchers get a
            // self-sufficient final snapshot (the same frame the legacy stream
            // ends with). Suppressed after remove()/dispose().
            if (!session.disposed) {
                this.publish(session, { type: 'snapshot', session: this.snapshot(session) });
            }

            this.releaseDrain(session);
        }
    }

    // Drain ONE thread lane, strictly FIFO, while sibling lanes keep running (R1-R6).
    //
    // The harness already serializes inside a thread, but the server keeps its own
    // backlog so a queued continuation is a recorded turn the client can address
    // before it starts. The session's exclusive gate (a legacy run or a manual call)
    // parks this lane exactly like the legacy pump, so a shared-store mutation never
    // interleaves with a thread's run; lanes never block EACH OTHER.
    private async pumpLane(session: Session, lane: ThreadLane): Promise<void> {
        if (lane.pumping) return;
        lane.pumping = true;

        try {
            while (!session.disposed) {
                const head = lane.queue[0];
                if (head === undefined) break;

                if (session.busy) {
                    await this.waitForBusy(session);
                    continue;
                }

                lane.queue.shift();

                try {
                    await this.executeTurn(session, head, undefined, undefined, {
                        threadId: lane.threadId,
                        lane
                    });
                } catch (error) {
                    // Same last-resort guard as the legacy pump: never leave the
                    // lane parked with a stuck flag.
                    session.status = 'error';
                    session.lastError = messageOf(error);
                    head.status = 'error';
                    head.updatedAt = Date.now();
                    this.publish(session, { type: 'turn', turn: copyTurn(head) });
                    this.settle(head, session);
                    this.releaseDrain(session);
                }
            }
        } finally {
            lane.pumping = false;

            // Drain frame: only when the WHOLE session is idle, so a sibling lane
            // that is still executing does not get a premature "everything done".
            if (!session.disposed && this.isIdle(session)) {
                this.publish(session, { type: 'snapshot', session: this.snapshot(session) });
            }

            this.releaseDrain(session);
        }
    }

    // No accepted-but-unstarted work and no live run anywhere in the session.
    private isIdle(session: Session): boolean {
        if (session.pumping || this.pendingCount(session) > 0) return false;
        if (this.laneActive(session)) return false;

        for (const lane of session.lanes.values()) {
            if (lane.pumping) return false;
        }

        return true;
    }

    // Attach an SSE watcher to a session's queue stream.
    //
    // The snapshot is captured in the SAME synchronous call that registers the
    // watcher, so the client receives a state that is never newer than the frames
    // that follow: publish() can only run in another async tick, and the route
    // buffers frames until the initial snapshot write resolves (see api.ts).
    //
    // `close` ends the stream server-side when the session disappears. The caller
    // must call `unsubscribe` when its client disconnects; that only detaches the
    // watcher and NEVER cancels a task — the pump owns execution, not the stream.
    watch(id: string, emit: Emit, close: () => void = () => {}): SessionWatch {
        const session = this.require(id);
        const watcher: SessionWatcher = { emit, close };
        session.watchers.add(watcher);

        return {
            snapshot: this.snapshot(session),
            unsubscribe: () => {
                session.watchers.delete(watcher);
            }
        };
    }

    // Resolves once the queue has drained (no pending turns, no pump work). Used
    // by tests and tools that want to wait out a submitted backlog; the HTTP
    // contract never blocks on it.
    async waitForIdle(id: string): Promise<void> {
        const session = this.require(id);

        // Wait until EVERY source of work has settled: the legacy pump, every lane
        // pump, its backlog, and any active run. A wake for one lane is harmless —
        // the loop re-checks the whole session.
        while (!session.disposed && !this.isIdle(session)) {
            await new Promise<void>((resolve) => {
                session.drainWaiters.push(resolve);
            });
        }
    }

    // Park until the single-flight gate is released. Resolving early (busy went
    // false before registration) is harmless: the pump re-checks the head.
    private waitForBusy(session: Session): Promise<void> {
        if (!session.busy) return Promise.resolve();

        return new Promise<void>((resolve) => {
            session.busyWaiters.push(resolve);
        });
    }

    private releaseBusy(session: Session): void {
        const waiters = session.busyWaiters.splice(0);
        for (const wake of waiters) wake();
    }

    private releaseDrain(session: Session): void {
        const waiters = session.drainWaiters.splice(0);
        for (const wake of waiters) wake();
    }

    // Resolve the enqueue() completion for one turn exactly once.
    private settle(turn: SessionTurn, session: Session): void {
        const resolve = session.settlers.get(turn.id);
        if (resolve === undefined) return;

        session.settlers.delete(turn.id);
        resolve();
    }

    // -----------------------------------------------------------------------
    // T16: the live-change signal plane (the realtime hub's source of truth).
    //
    // WHY SIGNALS AND NOT A WATCHER
    // ----------------------------
    // The stream owner needs to know WHEN a turn row, a display fold, a usage tally, an
    // owner question, a conversation, or a transcript changed, so the shared epoch/revision
    // hub (./api-events.ts) can move the right counters and the broker can fan a small target
    // update out. It must NOT get that by opening a `watch()`/`watchView()` subscription or
    // calling `get()`/`getView()`: every one of those builds a full snapshot or a whole
    // compiled view document, which is exactly the payload class the target contract removed,
    // and a per-connection observer would pay it again per client.
    //
    // So the store emits an IDENTITY-ONLY signal at the hooks it already has (`publish`,
    // `publishViewOps`, the action settlement, the thread/transcript writes). Nothing here
    // copies a turn, and the display OPS list - which the recorder already computed for the
    // view surface - rides by reference. The observer (installed by ./api.ts, which owns the
    // hub) rebuilds the one small wire body from the live record it is allowed to read, and
    // the counters move in ONE place for both HTTP and WS.
    //
    // The observer is a fan-out, never a gate: it runs synchronously inside the mutation and
    // an observer that throws is ignored, so a broken transport can never fail a run.
    // -----------------------------------------------------------------------

    /**
     * One live change, stated as identity plus (at most) the ops the recorder already made.
     * The payload body is the observer's job; the store only ever names WHAT moved.
     */
    streamObserver: StoreStreamObserver | undefined;

    /** Install (or clear) the live-change observer. One per store, owned by ./api.ts. */
    setStreamObserver(observer?: StoreStreamObserver): void {
        this.streamObserver = observer;
    }

    /** Fan one signal out. Never throws: a dead hub must not break a run or a write. */
    private notifyStream(signal: StoreStreamSignal): void {
        const observer = this.streamObserver;

        if (observer === undefined) return;

        try {
            observer(signal);
        } catch {
            // The hub/transport layer owns its own failures; the mutation already committed.
        }
    }

    /**
     * Derive the signal a raw frame implies. Only the kinds the contract STREAMS are mapped:
     * a `text`/`reasoning` delta is carried by `display.ops`, and a `tool_call`/`tool_result`
     * pair by the display row's step, so per-event frames here stay rare and bounded.
     */
    private signalForFrame(session: Session, item: SessionStreamItem): void {
        if (this.streamObserver === undefined) return;

        const at = Date.now();

        if (item.type === 'turn') {
            this.notifyStream({ kind: 'turn.upsert', sessionId: session.id, turnId: item.turn.id, at });

            // The server-summed tally rides the turn record, so the row transition is the moment
            // the figures are true. `usage.updated` is announced here (once, on the terminal
            // transition) rather than per delta, because it is a figure update and not a stream of
            // figures - a client applies the patch or re-reads, and can never double-count.
            if (
                item.turn.usage !== undefined &&
                (item.turn.status === 'done' || item.turn.status === 'error' || item.turn.status === 'cancelled')
            ) {
                this.notifyStream({ kind: 'usage.updated', sessionId: session.id, turnId: item.turn.id, at });
            }

            return;
        }

        if (item.type === 'snapshot') {
            // A snapshot frame means session metadata (status/queue/last error) moved, which is
            // a `session.updated` patch - never a snapshot transfer.
            this.notifyStream({ kind: 'session.state', sessionId: session.id, at });

            return;
        }

        // Only the two event kinds the contract STREAMS as their own update are mapped here; a
        // `failed` frame carries no event, and text/reasoning deltas ride `display.ops`.
        if (item.type !== 'event') return;

        const event = item.event;

        if (event.type === 'action_request' && event.request !== undefined) {
            this.notifyStream({ kind: 'action.opened', sessionId: session.id, requestId: event.request.requestId, at });

            return;
        }

        if (event.type === 'usage') {
            this.notifyStream({ kind: 'usage.updated', sessionId: session.id, turnId: item.turnId, at });
        }
    }

    // Fan a frame out to every watcher. NEVER throws and never awaits: a dead,
    // slow, or hostile watcher is dropped/ignored, so it can neither cancel a turn
    // nor block the pump. Each watcher gets its OWN deep copy, the same rule
    // copyTurn applies to every client-facing record, so one listener mutating a
    // frame cannot corrupt a sibling's.
    private publish(session: Session, item: SessionStreamItem): void {
        if (session.disposed) return;

        // T16: the hub signal rides the fan-out the store already performs, so a run that
        // nobody is watching over SSE still moves the shared counters the stream needs.
        this.signalForFrame(session, item);

        for (const watcher of [...session.watchers]) {
            let frame: SessionStreamItem;

            try {
                frame = JSON.parse(JSON.stringify(item)) as SessionStreamItem;
            } catch {
                // Non-serializable frame: never send a half-copied record.
                continue;
            }

            try {
                // Typed as `unknown` so the promise check below works for a plain
                // `void` emitter as well as an async one.
                const result: unknown = watcher.emit(frame);

                // A rejected write means the client went away between frames.
                // Detach it; the turn must not be affected.
                if (result instanceof Promise) {
                    void result.catch(() => {
                        session.watchers.delete(watcher);
                    });
                }
            } catch {
                session.watchers.delete(watcher);
            }
        }

        // R3: the compact surface is derived here, so EVERY lifecycle transition that
        // already publishes a raw frame (queued/running/terminal upserts, command
        // turns, cancel, thread and transcript mutations, drain snapshots) automatically
        // produces its display equivalent. Event frames are the one exception: the
        // recorder emitted that event's display ops already.
        this.mirrorView(session, item);
    }

    // Start a NEW block with a fresh conversation. Only agent histories are
    // cleared: `Agent.reset()` reseeds the instruction messages and nothing else.
    // This is the "explicit suitable API" — `harness.reset()` would also wipe
    // discovery, todos, and record stores, which are session capabilities, not the
    // previous conversation's transcript.
    //
    // Historical results remain in `session.turns[].events`, which is exactly what
    // expandReferences and the shared result-block helpers read. A tool that wants
    // prior results must therefore read that archive (or a session-provided view of
    // it), never the live agent transcript this reset clears.
    private resetConversations(session: Session): void {
        for (const brain of Object.values(session.harness.agents)) {
            brain.reset();
        }
    }

    // Execute ONE turn against the harness. Called by run() (legacy, with a
    // per-response emitter) and by the pump (watcher fan-out only).
    //
    // Caller guarantees the single-flight gate is free. `busy` is taken
    // synchronously here and released in `finally`, so a manual call or legacy run
    // can never overlap this harness call.
    //
    // Emitter semantics are deliberately split:
    //   - legacy `emit` failure still aborts the run (the old behaviour: a dead
    //     stream must not keep spending provider time),
    //   - watcher failure only detaches that watcher (publish()).
    //
    // `signal` (optional) is the LEGACY response's disconnect signal. It is
    // forwarded to THIS turn's controller only, and the forwarder is removed in the
    // `finally` below. That identity is what prevents a late disconnect — arriving
    // after this turn released the gate but before its response closed — from
    // aborting a DIFFERENT turn the queue pump has since started.
    private async executeTurn(
        session: Session,
        turn: SessionTurn,
        legacyEmit?: Emit,
        signal?: AbortSignal,
        execution: TurnExecutionOptions = {}
    ): Promise<void> {
        const lane = execution.lane;
        const threadId = execution.threadId;
        const freshBlock = execution.freshBlock === true;

        // Claim the execution slot BEFORE the first await. A LANE turn takes its own
        // lane slot (so sibling lanes keep running). Every other turn — a legacy
        // `/messages` run and an unfocused queued turn — takes the session's
        // exclusive gate, which is what serializes real runs against manual tool
        // calls and each other. Everything below runs inside the try/finally, so no
        // exceptional setup can leave a flag stuck.
        const controller = new AbortController();

        if (lane === undefined) {
            session.busy = true;
            session.legacyRunning = true;
        } else {
            lane.active = turn;
            lane.controller = controller;
            lane.stopRequested = false;
        }

        const usageField = (): { usage?: HarnessUsage } =>
            turn.usage === undefined ? {} : { usage: { ...turn.usage } };

        // Bound to THIS controller and THIS turn: `session.controller` is swapped by
        // the next turn, so the guard below turns a stale signal into a no-op.
        const forwardAbort = (): void => {
            if (session.controller !== controller) return;

            session.cancelled = true;
            controller.abort();
        };

        // A run is cancelled when the store asked THIS run to stop (lane) or the
        // legacy session flag is set, or when its own controller aborted. A lane
        // classification must never inherit a sibling's cancel.
        const wasCancelled = (): boolean =>
            (lane === undefined ? session.cancelled : lane.stopRequested) ||
            controller.signal.aborted;

        let failure: string | undefined;

        // P3: ONE serial write chain for THIS turn's legacy SSE frames.
        //
        // The harness awaits the progress it emits from its main loop, but
        // BACKGROUND deliveries (scheduler wake / tool-completion mailboxes, see
        // harness.ts enqueueMailbox) call the same sink concurrently, and neither
        // adapter serializes an emitter — handler.ts createSseWriter and
        // service.ts write both suspend on backpressure, so two concurrent frames
        // could be flushed out of order. Queuing each frame behind the previous
        // one keeps wire order exact under backpressure: nothing is reordered and
        // nothing is dropped. The /events route already guarantees this with its
        // own `tail` chain (api.ts watchSessionRoute); this is the same rule for
        // the legacy stream. The chain is per turn, so a finished turn can never
        // delay the next one (a legacy response carries exactly one run).
        let legacyChain: Promise<void> = Promise.resolve();

        // Queue one legacy frame. The returned promise rejects for THIS frame only
        // (the caller decides: a dead stream aborts the run, the old contract),
        // while `legacyChain` stays alive so one rejected write cannot wedge the
        // frames behind it — and the rejection is handled here, so it can never
        // surface as an unhandled rejection. A queue turn (no legacy emitter)
        // resolves without writing.
        const writeLegacy = (item: SessionStreamItem): Promise<void> => {
            const write = legacyEmit;

            const written: Promise<void> = legacyChain.then(() =>
                write === undefined ? undefined : write(item)
            );

            legacyChain = written.then(
                () => undefined,
                () => undefined
            );

            return written;
        };

        try {
            const startedAt = Date.now();

            // The turn is already in `session.turns` with a stable id/index. Starting
            // it stamps `startedAt` (absent while queued) and makes it the running row.
            turn.status = 'running';
            turn.startedAt = startedAt;
            turn.updatedAt = startedAt;

            // Aggregate status: any live run reports 'running'. A run only clears
            // the error banner when nothing else is executing, so a sibling's
            // failure is not erased by a later start.
            const othersActive = lane === undefined ? this.laneActive(session) : session.legacyRunning;

            session.status = 'running';
            if (!othersActive) session.lastError = undefined;
            if (lane === undefined) {
                session.cancelled = false;
                session.controller = controller;
            }
            session.updatedAt = startedAt;

            // Durability at the turn-start transition: the running row exists before
            // any provider work, so a crash mid-run leaves an explicit interrupted
            // turn instead of a prompt that vanished. A write failure here fails the
            // turn (the catch below) BEFORE it spends provider time.
            //
            // T10: the entry agent's instruction source is frozen INTO that same write,
            // so an interrupted turn still rebuilds its `system` segment with the counts
            // it ran with — and a preset/instruction edit made later cannot silently
            // move a number a client has already been shown (R4/R6).
            this.noteInstructionSource(session, turn.id, runAgentOf(session, turn));
            await this.persistOrThrow(undefined, { fenceSessions: [session.id] });

            // Legacy disconnect → cancel THIS run only. Registered after the
            // controller is published and removed in the finally, so it can never
            // reach the next queued turn.
            if (signal !== undefined) {
                signal.addEventListener('abort', forwardAbort, { once: true });
                if (signal.aborted) forwardAbort();
            }

            // ONE recorder for THIS run: it appends to this turn and fans the frame
            // out. It is published on the session (legacy run) or on the lane and is
            // bound into the run's async context, so concurrent thread runs never
            // record into each other (see buildHarness/progress).
            const record = async (event: HarnessEvent): Promise<void> => {
                // Record first: the server's turn is authoritative even when the client
                // that opened the stream disappeared (a reload, a cancel by disconnect).
                // `at` is the one server timestamp shared by the frame and the parallel
                // `eventTimes` entry, so a client and a reload agree exactly.
                //
                // The event's POSITION is captured before the push: it is the address a
                // display step carries (`DisplayStep.id == String(index)`), which is what
                // lets the lazy detail route resolve one step's request AND response
                // bytes before and after a restart (R2/R4).
                const index = turn.events.length;
                // Fold through THIS turn's projector BEFORE the record grows, so a
                // lazily-created projector folds exactly the prior events — the identical
                // call sequence a restore's cold fold performs (live ≡ replay, the one
                // rule ./turn-projector.ts is built on).
                const projector = this.projectorFor(session, turn);
                const record = copyEvent(event);
                const at = Date.now();
                turn.events.push(record);
                turn.eventTimes?.push(at);

                // R4: every step is durable, including text/reasoning deltas (which the
                // old checkpoint policy left unwritten until the terminal save) and a
                // command turn's synthesized pair. Best-effort by POLICY — a full disk
                // must not change a run's outcome — and never silent: the failure is
                // retained on the session and reported through `journalErrors`.
                this.journalAppend(session, turn.id, index, at, record);

                // F6: remember which persistent conversation each invocation ran in.
                // The START frame of a root host run or a delegated child names the
                // invocation; the runtime roster maps it to the conversation. Branch
                // frames are transcript-ephemeral and deliberately skipped.
                if (
                    record.type === 'start' &&
                    record.thread !== undefined &&
                    record.thread.kind === undefined &&
                    record.thread.branchId === undefined
                ) {
                    this.noteInvocationThread(session, record.thread.id);
                }

                // T10: freeze every agent's instruction source the moment its first
                // frame is recorded — BEFORE the display fold reads it, so the section's
                // `system` segment counts the bytes this run really carried, and before
                // the next checkpoint makes them durable (live ≡ replay).
                if (record.type === 'start') this.noteInstructionSource(session, turn.id, record.agent);

                // Token tally, accumulated here so every client reads the SERVER's
                // figure. Only the per-request `usage` event counts: the harness also
                // repeats the final request's usage on `done`, and adding that too
                // would double the last step. Folded BEFORE the display fold, because the
                // turn-level token figures come off this tally.
                if (record.type === 'usage') turn.usage = addUsage(turn.usage, record.usage);

                turn.updatedAt = at;

                // The compiled display fold: one event in, bounded display ops out. This
                // is the cache every `/views` read serves, so nothing recomputes it.
                const ops = projector.apply(record, at, index);

                // Durable transitions: the journal above carries every step, so the full
                // document is rewritten on a bounded interval rather than once per step
                // (R4). The strict turn-start save and the terminal save below are
                // unchanged, so no structural transition ever relies on the interval.
                this.checkpoint(session);

                // Display frames go out even to a run that was just cancelled: a second
                // tab's board must not lose rows the server still recorded. The RAW
                // stream keeps its historical "stop sending when aborted" rule.
                this.publishViewOps(session, turn.id, at, ops);

                // A cancelled run keeps recording but stops sending: the stream is gone
                // or the client asked to stop. No progress event is buffered.
                if (controller.signal.aborted) return;

                // LEGACY stream first: a failed write aborts the run (old contract).
                // Queued on the per-turn chain, so concurrent deliveries keep wire
                // order (P3); a failed legacy write (or a dead stream) still aborts
                // this run instead of keeping provider time running for nobody.
                if (legacyEmit !== undefined) {
                    try {
                        // The emitted frame is another copy so a stream listener cannot
                        // mutate the record the snapshot will hand to the next client.
                        // The running tally rides along (when there is one) so a live
                        // tile never has to accumulate usage itself.
                        await writeLegacy({
                            type: 'event',
                            turnId: turn.id,
                            event: copyEvent(record),
                            at,
                            ...usageField()
                        });
                    } catch {
                        // The client went away mid-run. Abort the harness instead of
                        // letting it keep spending provider time on a dead stream.
                        session.cancelled = true;
                        controller.abort();
                        return;
                    }
                }

                // QUEUE watchers afterwards: fan-out never aborts, never blocks.
                this.publish(session, {
                    type: 'event',
                    turnId: turn.id,
                    event: copyEvent(record),
                    at,
                    ...usageField()
                });
            };

            if (lane === undefined) session.sink = record;
            else lane.sink = record;

            // Open the turn frame before the harness emits anything, so a client never
            // sees an event it cannot attribute. A failed legacy write means the stream
            // is already gone: abort rather than run for nobody.
            const opening = (): SessionStreamItem => ({ type: 'turn', turn: copyTurn(turn) });

            if (legacyEmit !== undefined) {
                try {
                    await writeLegacy(opening());
                } catch {
                    session.cancelled = true;
                    controller.abort();
                }
            }

            // Watchers get the SAME shape as an upsert (the turn just became running).
            this.publish(session, opening());

            // R2 FRESH BLOCK — LEGACY PATH ONLY. A `/messages` turn is a new block:
            // the previous block's user/assistant transcript must not be inherited
            // (its results stay available through the SESSION turn record and the
            // reference expansion below). `agent.reset()` reseeds only the
            // conversation from the agent's instructions — it deliberately leaves
            // discovery, the todo list, record stores, created tools, and the
            // session's `turns` archive untouched, so historical results are not
            // discarded. This is why `harness.reset()` is NOT used here.
            //
            // A THREAD turn never resets: a host thread is born with an empty
            // transcript (a fresh block by construction), and a further submit to
            // the same thread is a CONTINUATION that must keep its history.
            if (freshBlock) this.resetConversations(session);

            // Commit the transcript as the active state. A crash during this block
            // then restores a coherent conversation rather than replaying the
            // previous block's history into it.
            try {
                session.core = session.harness.snapshot();
            } catch {
                // Defensive: keep the previous committed snapshot; the turn is
                // still valid because the live harness was reset above.
            }
            this.persistBestEffort();

            // Expand AFTER the reset and only once every referenced turn is
            // terminal, so the injected text is the recorded `done` content. With
            // no references this is the user's prompt by identity.
            const composed = await this.expandReferences(session, turn);

            // An attachment-only task has an EMPTY prompt, which the legacy root
            // call accepts (the media parts travel separately). A persistent thread
            // run requires non-empty text, so its submit markers become the run text
            // — the same labels the composer would insert. The recorded
            // `turn.prompt` stays the user's raw (empty) text.
            const runPrompt =
                threadId !== undefined &&
                composed.trim().length === 0 &&
                turn.attachments !== undefined &&
                turn.attachments.length > 0
                    ? turn.attachments.map((attachment) => attachment.marker).join(' ')
                    : composed;

            // Root prompt + its composer attachments (T3). The attachments ride
            // ONLY on this run's root user message; core validates them once more
            // before appending history (so a corrupted restored record is rejected
            // without mutating the transcript). A text-only turn passes no key.
            const options = {
                signal: controller.signal,
                ...(turn.attachments === undefined ? {} : { attachments: turn.attachments })
            };

            // R1-R6: a turn that names a persistent thread runs IN that thread
            // (`sendThreadInput`), so its transcript, steering, and stop/delete are
            // the runtime's; the legacy `/messages` turn keeps the callable root.
            //
            // The async context is what attributes this run's progress events when
            // a sibling lane is emitting at the same time (see buildHarness).
            if (this.workerExecution) {
                // T5 (R1/D1): the whole turn - agent loop, provider stream handling, and
                // every synchronous tool body - runs on this conversation's lane worker. The
                // recorder `record` above is the lane's event sink, so the durable turn record,
                // the display fold, the journal, and both SSE streams are filled by the SAME
                // code the inline path uses; only the CPU moved.
                const result = await this.lanes().runTurn({
                    sessionKey: session.id,
                    authority: this.authorityOf(session),
                    turnId: turn.id,
                    target: this.laneTargetFor(threadId, runAgentOf(session, turn)),
                    prompt: runPrompt,
                    ...(turn.attachments === undefined ? {} : { attachments: turn.attachments }),
                    // The fresh-block rule is mirrored into the replica so both sides reset
                    // identically; an append against a transcript the two disagree about would
                    // otherwise be refused.
                    ...(freshBlock ? { reset: true } : {}),
                    signal: controller.signal,
                    onEvent: record,
                    blueprint: this.blueprintFor(session)
                });

                // Cancellation is decided HERE, from the store's own stop request - never from
                // the lane's word - so a sibling lane's cancel cannot classify this turn.
                if (result.cancelled === true) {
                    if (lane === undefined) session.cancelled = true;
                    else lane.stopRequested = true;
                }

                const fault = result.failure;
                const commitFault = result.commitFaults?.[0];

                // A lane failure is the turn's failure. A refused commit is reported with it,
                // because "the answer arrived but the state behind it was not accepted" must
                // never read as a clean success (T3 finding F8).
                if (fault !== undefined && !controller.signal.aborted) {
                    throw new Error(commitFault === undefined ? fault : `${fault} (${commitFault})`);
                }

                if (fault === undefined && commitFault !== undefined) {
                    throw new Error(`The run answered, but the lane's state was not accepted: ${commitFault}`);
                }
            } else if (threadId === undefined) {
                await this.runContexts.run({ session, turn, record }, () =>
                    session.harness(runPrompt, options)
                );
            } else {
                await this.runContexts.run({ session, turn, threadId, record }, () =>
                    session.harness.sendThreadInput(threadId, runPrompt, options)
                );
            }

            // Record the run's invocation identity for the roster join. A root run
            // may report none; the thread record's latest invocation id is the
            // fallback the roster already exposes.
            if (threadId !== undefined) {
                const invocationId = session.harness.thread(threadId)?.invocationId;
                if (invocationId !== undefined) session.turnInvocations.set(turn.id, invocationId);
            }

            // A run that settled as an abort is terminal as `cancelled` even if the
            // transport returned instead of throwing.
            if (wasCancelled()) {
                failure = 'The run was cancelled.';
                turn.status = 'cancelled';
            } else {
                turn.status = 'done';
            }
        } catch (error) {
            // A cancelled turn is terminal as `cancelled`, even though the session
            // keeps its existing error/lastError contract for the UI banner. A setup
            // failure lands here too: the finally below still releases the gate.
            const cancelled = wasCancelled();
            failure = cancelled ? 'The run was cancelled.' : messageOf(error);
            session.lastError = failure;
            turn.status = cancelled ? 'cancelled' : 'error';
        } finally {
            // Remove the legacy forwarder BEFORE the gate is released, so the next
            // queued turn can never inherit this response's abort signal.
            signal?.removeEventListener('abort', forwardAbort);

            // The slot is released exactly once, in this run's finally: no other run
            // could have replaced the recorder/controller while this one held the
            // exclusive gate or its lane.
            if (lane === undefined) {
                session.sink = undefined;
                session.controller = undefined;
                session.busy = false;
                session.legacyRunning = false;
            } else {
                lane.sink = undefined;
                lane.active = undefined;
                lane.controller = undefined;
                lane.stopRequested = false;
            }

            // N4: an unanswered question cannot outlive its run. The runtime
            // normally resolves or aborts every handler it awaits, so this is a
            // backstop; finishActionRequest makes it a no-op when there is nothing
            // left. Scoped to THIS conversation, so a sibling lane's question stays
            // answerable.
            this.expireActions(session, ACTION_RUN_ENDED_MESSAGE, threadId);

            // Release the gate on success, failure, and cancellation alike: a stuck
            // gate would reject every later chat/reset/manual call and park every
            // pump forever.
            session.updatedAt = Date.now();
            turn.updatedAt = session.updatedAt;

            // Aggregate session status: only the LAST live run decides idle/error.
            const others = this.laneActive(session) || session.legacyRunning;

            // The historical banner contract: a successful run leaves the session
            // idle, while failure AND cancellation report an error with lastError
            // (the turn itself still records 'cancelled'). With concurrent lanes the
            // LAST settled run decides, and a success clears a sibling's banner —
            // the same "later success resets the banner" rule as before.
            if (others) {
                session.status = 'running';
            } else if (turn.status === 'done') {
                session.status = 'idle';
                session.lastError = undefined;
            } else {
                session.status = 'error';
            }

            // The turn's terminal status is now visible; a turn parked while
            // referencing it may continue (and re-check) on its next tick.
            this.releaseTurnWaiters(session);
            this.releaseBusy(session);
            this.releaseDrain(session);
        }

        // One terminal upsert replaces the running row for every watcher, whatever
        // the outcome. Its events array is the complete record (a client can also
        // rely on the event frames it already applied).
        //
        // The run has settled (runStack is empty), so this is the first point where
        // a fresh core snapshot is legal: capture the completed tool/discovery/
        // record state, then save before any terminal frame is sent.
        //
        // SKIPPED for a disposed session or a closing store (P1-B): the run was
        // aborted by remove()/dispose(), so this continuation lands after the
        // session left the map. Its save would serialize an empty (or
        // session-less) document and destroy the graceful shutdown file. The
        // publish() below is already a no-op for a disposed session, and the
        // settler must still resolve (asserted by the shutdown contracts).
        if (!session.disposed && !this.shuttingDown) {
            try {
                session.core = session.harness.snapshot();
                // Remember the label occurrences this turn minted, so deleting it
                // later cannot make a NEW turn re-mint the same textual label.
                this.mergeLabelHighWater(session, session.turns);
            } catch {
                // Defensive: a run that somehow still owns the harness keeps the last
                // committed snapshot. The turn is terminal either way.
            }

            this.persistBestEffort();
        }

        this.publish(session, { type: 'turn', turn: copyTurn(turn) });
        this.settle(turn, session);

        // Legacy terminal frame: `failed` for an error/cancel, `snapshot` on
        // success. Both carry the complete session, so the last frame a response
        // sees is self-sufficient.
        //
        // Queued on the same per-turn chain (P3) so a terminal frame can never
        // overtake an event frame that is still waiting on backpressure, and a
        // failed write is swallowed exactly like the previous safeEmit helper
        // (the stream is already gone; the run is over either way).
        if (legacyEmit === undefined) return;

        if (failure !== undefined) {
            await writeLegacy({
                type: 'failed',
                error: { message: failure },
                session: this.snapshot(session)
            }).catch(() => {});
            return;
        }

        await writeLegacy({ type: 'snapshot', session: this.snapshot(session) }).catch(() => {});
    }

    // Cancel work in a session.
    //
    //   - default (no body / `{}`): cancel the ACTIVE run only, exactly as before.
    //     A manual tool call has no AbortController and is not a turn, so it is not
    //     cancellable here (its request stays open and releases the gate when it
    //     settles); the queued backlog is untouched.
    //   - `{ all: true }` (the UI Stop button): also DROP every queued turn. The
    //     dropped turns stay in `turns` as 'cancelled' records (the server record
    //     is append-only until reset), so a reload still shows what was stopped.
    //     The active turn keeps running until its abort lands; the pump then
    //     publishes the drain snapshot and exits.
    //
    // Returns true when anything was cancelled (an active run or at least one
    // queued turn). An unknown id is false; the API looks the session up first.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    //
    // A cancel is TERMINAL: the document names the journal tail this call just recorded, so
    // it commits through the fenced path (`fenceSessions`), not a bare save.
    async cancel(id: string, options: { all?: boolean } = {}): Promise<boolean> {
        const session = this.sessions.get(id);
        if (!session) return false;

        let cancelled = false;

        // The LEGACY active run (response-owned `/messages` or an unfocused queued
        // turn). Its controller is the session's.
        if (session.status === 'running' && session.controller !== undefined) {
            session.cancelled = true;
            session.controller.abort();
            // N4: a cancelled run can no longer receive an owner answer. Reject
            // the awaited promise now (the abort signal also reaches it, but this
            // makes the outcome explicit and settles exactly once).
            this.expireActions(session, ACTION_CANCELLED_MESSAGE);
            cancelled = true;
        }

        // Every live THREAD lane. Stopping the active run is the default cancel
        // contract; marking the threads themselves stopped is reserved for `all`.
        // A stop-all also flags IDLE lanes, so a pump parked on the exclusive gate
        // cannot start a conversation that is being stopped.
        for (const lane of session.lanes.values()) {
            if (options.all === true) lane.stopRequested = true;
            if (lane.active === undefined) continue;

            lane.stopRequested = true;
            lane.controller?.abort();
            this.expireActions(session, ACTION_CANCELLED_MESSAGE, lane.threadId);
            cancelled = true;
        }

        if (options.all !== true) {
            // Write-through: an accepted cancel survives a restart (the turn is
            // restored as cancelled, not as a phantom running turn).
            if (cancelled) await this.persistOrThrow(undefined, { fenceSessions: [session.id] });
            return cancelled;
        }

        const now = Date.now();
        const dropped = session.queue.splice(0);

        for (const turn of dropped) {
            turn.status = 'cancelled';
            turn.updatedAt = now;

            // Upsert the terminal record and release the enqueue() completion:
            // a queued turn can never run, so it must not leave a caller waiting.
            this.publish(session, { type: 'turn', turn: copyTurn(turn) });
            this.settle(turn, session);
        }

        // STOP-ALL (R6): mark every HOST thread stopped and drop every lane backlog.
        // The default `agent:<name>` conversations are internal plumbing — a legacy
        // root call and delegation keep using them — so they are left usable; the
        // host threads are exactly what the roster exposes and what a user can
        // resume/delete.
        let stopped = 0;
        if (this.threadsSupported(session)) {
            for (const record of session.harness.threads()) {
                if (record.origin !== 'host') continue;

                try {
                    if (session.harness.stopThread(record.id, 'All threads were stopped.')) stopped += 1;
                } catch {
                    // Already stopped/deleted: nothing to abort for it.
                }
            }
        }

        for (const lane of session.lanes.values()) {
            for (const turn of lane.queue.splice(0)) {
                turn.status = 'cancelled';
                turn.updatedAt = now;
                this.publish(session, { type: 'turn', turn: copyTurn(turn) });
                this.settle(turn, session);
                cancelled = true;
            }
        }

        if (stopped > 0) cancelled = true;

        if (cancelled) {
            session.updatedAt = now;
            // Dropped turns are terminal without an executeTurn finally, so wake
            // reference waiters here too.
            this.releaseTurnWaiters(session);

            // With nothing executing, no pump is left to publish the drain
            // snapshot, so send it here. When a turn IS active the pump sends it.
            if (this.isIdle(session)) {
                this.publish(session, { type: 'snapshot', session: this.snapshot(session) });
            }
        }

        // The dropped turns are terminal records: make that durable before the
        // response claims they were cancelled.
        if (cancelled) await this.persistOrThrow(undefined, { fenceSessions: [session.id] });

        return cancelled;
    }

    // STOP ONE THREAD (R6, POST /sessions/:id/threads/:threadId/cancel).
    //
    // Aborts that thread's live run, drops its queued turns (they can never run
    // now), marks it stopped, and cascades to any thread it owns. A sibling lane is
    // untouched. `cancelled` reports whether live work was aborted or a queued turn
    // dropped; an idle thread is still marked stopped and answers false.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    async cancelThread(id: string, threadId: string, reason?: string): Promise<CancelThreadResult> {
        const session = this.require(id);

        if (!this.threadsSupported(session)) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        const record = session.harness.thread(threadId);

        if (record === undefined) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        const lane = session.lanes.get(threadId);
        let cancelled = false;

        // The thread itself plus every conversation it owns: the runtime's stop
        // cascades, and the server drops the matching backlogs.
        const stoppedThreads = new Set<string>([threadId]);
        for (const child of session.harness.threads()) {
            if (this.isDescendantThread(session, child.id, threadId)) stoppedThreads.add(child.id);
        }

        // Signal OUR classification BEFORE aborting (F7): the runtime rejects the
        // run with its own abort error, and this flag is what records the turn as
        // "cancelled" instead of "error". Set it on EVERY lane the runtime stop
        // cascades to (the thread and its owner-linked children), so a cascaded
        // child run is never misclassified. An idle lane needs no flag.
        for (const targetId of stoppedThreads) {
            const target = session.lanes.get(targetId);
            if (target !== undefined && target.active !== undefined) target.stopRequested = true;
        }

        try {
            if (session.harness.stopThread(threadId, reason)) cancelled = true;
        } catch (error) {
            throw new SessionError(400, messageOf(error));
        }

        // An UNFOCUSED submit runs on the session's exclusive gate (no lane). When
        // the turn being aborted is the one for a stopped thread, the legacy flag
        // and controller are what classify/abort it.
        if (session.status === 'running' && session.controller !== undefined) {
            const active = [...session.turns]
                .sort((left, right) => left.index - right.index)
                .filter((turn) => turn.status === 'running')
                .pop();

            if (active?.threadId !== undefined && stoppedThreads.has(active.threadId)) {
                session.cancelled = true;
                session.controller.abort();
                cancelled = true;
            }
        }

        const now = Date.now();
        for (const targetId of stoppedThreads) {
            // A lane's own backlog.
            const target = session.lanes.get(targetId);
            if (target !== undefined) {
                for (const turn of target.queue.splice(0)) {
                    turn.status = 'cancelled';
                    turn.updatedAt = now;
                    this.publish(session, { type: 'turn', turn: copyTurn(turn) });
                    this.settle(turn, session);
                    cancelled = true;
                }
            }

            // The LEGACY serialized backlog: only a harness handle that predates
            // the thread API parks thread turns there (`threadsSupported` false).
            // A thread-capable session queues per lane instead (see the lane loop
            // above), but a legacy handle's backlog is still addressable, so a
            // stop must drop its turns too.
            const legacyQueued = session.queue.filter(
                (turn) => turn.threadId !== undefined && stoppedThreads.has(turn.threadId)
            );

            for (const turn of legacyQueued) {
                const at = session.queue.indexOf(turn);
                if (at === -1) continue;

                session.queue.splice(at, 1);
                turn.status = 'cancelled';
                turn.updatedAt = now;
                this.publish(session, { type: 'turn', turn: copyTurn(turn) });
                this.settle(turn, session);
                cancelled = true;
            }
        }

        // Only THIS conversation's questions expire; a sibling lane may still be
        // waiting for its owner's answer.
        for (const targetId of stoppedThreads) {
            this.expireActions(session, ACTION_CANCELLED_MESSAGE, targetId);
        }

        // A run whose thread is stopped but that has not settled yet keeps the
        // session 'running' until its abort lands; the terminal frame then fixes it.
        session.updatedAt = now;
        // Dropped turns are terminal without an executeTurn finally: wake reference
        // waiters and any waitForIdle() caller here too.
        this.releaseTurnWaiters(session);
        this.releaseDrain(session);
        await this.persistOrThrow(undefined, { fenceSessions: [session.id] });
        this.publish(session, { type: 'snapshot', session: this.snapshot(session) });

        // T16: the conversation itself changed state (stopped), so the roster row is what a
        // client needs again - identity only, the observer reads the one row.
        this.notifyStream({ kind: 'thread.upsert', sessionId: session.id, threadId, at: Date.now() });

        return { cancelled, session: this.snapshot(session) };
    }

    // True when `candidate` is (transitively) owned by `ancestor` in the runtime
    // roster. Used to cascade a stop/drop over a deleted owner's children; a cyclic
    // hand-edited link terminates instead of looping.
    private isDescendantThread(session: Session, candidate: string, ancestor: string): boolean {
        if (!this.threadsSupported(session)) return false;

        const records = new Map(session.harness.threads().map((record) => [record.id, record]));
        const seen = new Set<string>([candidate]);
        let current = records.get(candidate)?.ownerThreadId;

        while (current !== undefined && !seen.has(current)) {
            if (current === ancestor) return true;

            seen.add(current);
            current = records.get(current)?.ownerThreadId;
        }

        return false;
    }

    // Record invocation → persistent conversation for the F6 purge. The runtime sets
    // the thread record's `invocationId` before the run emits `start`, so a lookup at
    // that moment is exact; an invocation already mapped is left alone (ids are
    // unique and never reused).
    private noteInvocationThread(session: Session, invocationId: string): void {
        if (!this.threadsSupported(session)) return;
        if (session.invocationThreads.has(invocationId)) return;

        for (const record of session.harness.threads()) {
            if (record.invocationId !== invocationId) continue;

            session.invocationThreads.set(invocationId, record.id);
            // R18/T20: allocate the conversation's DISPLAY NAME in the same step that
            // records the join, through the store's existing allocator (`ensureThreadLabel`,
            // NOT a second numbering scheme). This is the earliest moment the conversation
            // is known to exist, and the recorder folds this frame right after (line
            // ~5530), so the delegated section is BORN with the same `agentLabel` the cold
            // replay reads back from `threadLabels` after a restart — live ≡ replay for the
            // label, not only for the id. A name that already exists is returned untouched,
            // so a resumed run of one conversation never consumes another ordinal.
            this.ensureThreadLabel(session, record.id, record.agent);
            return;
        }
    }

    // Invocation ids whose persisted agent-result records belong to the doomed
    // conversations (F6). Reconstructed from the server's own records because the
    // persisted snapshot carries no thread id per result:
    //   - each doomed thread's latest runtime invocation;
    //   - every ROOT invocation recorded for a doomed thread's turn;
    //   - every non-branch invocation that appeared in those turns' events (a
    //     delegated child's runs are recorded inside its parent turn).
    // `removedIds` scopes the turn scan to the turns this deletion actually removes
    // (a survivor's invocation must keep its results), so it is load-bearing, not
    // decorative.
    private doomedInvocationIds(
        session: Session,
        doomed: ReadonlySet<string>,
        removedIds: ReadonlySet<string>
    ): Set<string> {
        const ids = new Set<string>();

        if (!this.threadsSupported(session)) return ids;

        // Every invocation this server observed in a doomed conversation — including
        // a child's EARLIER runs, which the roster's single slot no longer names.
        for (const [invocationId, threadId] of session.invocationThreads) {
            if (doomed.has(threadId)) ids.add(invocationId);
        }

        for (const record of session.harness.threads()) {
            if (!doomed.has(record.id)) continue;
            if (record.invocationId !== undefined) ids.add(record.invocationId);
        }

        for (const turn of session.turns) {
            if (turn.threadId === undefined || !doomed.has(turn.threadId)) continue;
            if (!removedIds.has(turn.id)) continue;

            const rootInvocation = session.turnInvocations.get(turn.id);
            if (rootInvocation !== undefined) ids.add(rootInvocation);

            for (const event of turn.events) {
                const thread = (event as { thread?: { id?: string; kind?: string; branchId?: string } })
                    .thread;

                // Branch results are not scoped to a persistent conversation, so the
                // runtime keeps them; removing them here would make disk and runtime
                // disagree.
                if (thread?.id === undefined) continue;
                if (thread.kind !== undefined || thread.branchId !== undefined) continue;

                ids.add(thread.id);
            }
        }

        return ids;
    }

    // -----------------------------------------------------------------------
    // C4: the per-thread transcript editor
    //     (GET / PUT /sessions/:id/threads/:threadId/transcript)
    // -----------------------------------------------------------------------

    // Whether this session's harness can REPLACE a thread transcript (C4).
    //
    // Deliberately NOT folded into `threadsSupported`: a host-supplied handle that
    // predates the transcript editor must keep its exact roster/queue behaviour, so
    // only the transcript write is unavailable to it (a 409 below, never a changed
    // snapshot shape).
    private transcriptSupported(session: Session): boolean {
        return (
            this.threadsSupported(session) &&
            typeof (session.harness as Partial<Harness>).setThreadMessages === 'function'
        );
    }

    // C4: one thread's transcript in the shape the visualiser edits.
    //
    //   - readable thread  → `messages` is the live transcript and `raw` is its
    //     pretty JSON (the value to edit), with no `invalid`;
    //   - unreadable thread → `messages` is the live PLACEHOLDER (what the model
    //     would actually be sent) and `raw`/`invalid` carry the broken value
    //     verbatim, so the UI can show the error plus the text to fix;
    //   - unknown thread    → 404. A thread that exists ONLY in the invalid map
    //     (a stale record with no harness thread) is still readable here, because
    //     the raw value is the useful part.
    threadTranscript(id: string, threadId: string): ThreadTranscriptResponse {
        const session = this.require(id);

        const invalid = session.invalidThreads.get(threadId);
        const record = this.threadsSupported(session) ? session.harness.thread(threadId) : undefined;

        if (invalid === undefined && record === undefined) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        // `threadMessages` throws for a thread the harness does not have, which is
        // exactly the stale-map case above; stay empty then.
        const messages = record === undefined ? [] : session.harness.threadMessages(threadId);
        const agent = record?.agent ?? invalid?.agent ?? '';

        if (invalid === undefined) {
            return { threadId, agent, messages, raw: transcriptRawJson(messages) };
        }

        return {
            threadId,
            agent,
            messages,
            raw: transcriptRawJson(invalid.messages),
            // C8-m7: returned by VALUE — the caller gets its own object, so mutating
            // `transcript.invalid.messages` cannot rewrite what the store holds.
            invalid: { error: invalid.error, messages: copyInvalidMessages(invalid.messages) }
        };
    }

    // C4: replace one thread's transcript with a value the user edited.
    //
    // THE CONTRACT that makes this safe (and why a broken value is a 200):
    //   - a structurally invalid `messages` is ACCEPTED and PERSISTED: the raw
    //     value is recorded as unreadable and the live transcript becomes a valid
    //     placeholder, so the session stays runnable, snapshot-able and restorable
    //     while the user keeps fixing the JSON;
    //   - a valid value clears the unreadable record and is installed as-is
    //     (validated + detached by the shared reader, in place, so every existing
    //     reference to the transcript array stays correct);
    //   - a RUNNING thread is refused (409): the run loop appends to the array
    //     being replaced, and a lost mid-run edit is worse than a refusal;
    //   - the write is DURABLE before the response (`persistOrThrow`), and watchers
    //     get one `snapshot` frame so a focused conversation repaints.
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    async updateThreadTranscript(
        id: string,
        threadId: string,
        messages: unknown
    ): Promise<UpdateThreadTranscriptResult> {
        const session = this.require(id);

        if (!this.transcriptSupported(session)) {
            throw new SessionError(
                409,
                `This session's harness does not support replacing a thread transcript.`
            );
        }

        const record = session.harness.thread(threadId);

        if (record === undefined) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        // Live work owns the transcript. The record's status plus a lane still
        // holding an active run is the same predicate `deleteThread` uses for its
        // 409 (a stopped-but-still-unwinding run reports 'stopped').
        if (record.status === 'running' || session.lanes.get(threadId)?.active !== undefined) {
            throw new SessionError(
                409,
                `Thread "${threadId}" is running; stop it before replacing its transcript.`
            );
        }

        // One validation attempt, using the reader the runtime itself enforces. A
        // refusal is data here, not a failure: it becomes `transcript.invalid`.
        let validated: HarnessMessage[] | undefined;
        let reason: string | undefined;

        try {
            validated = readHarnessMessages(messages, `thread "${threadId}" messages`);
        } catch (error) {
            reason = messageOf(error);
        }

        try {
            if (validated !== undefined) {
                session.harness.setThreadMessages(threadId, validated);
                session.invalidThreads.delete(threadId);
            } else {
                // Order matters: the placeholder is installed FIRST so the harness
                // can never be left holding the broken value (which its own
                // snapshot() would refuse), and only then is the raw value recorded.
                const error = reason ?? 'the transcript failed validation.';

                session.harness.setThreadMessages(threadId, unreadableTranscript(error));
                session.invalidThreads.set(threadId, {
                    error,
                    // C8-m7: stored by VALUE. `messages` is the caller's object, and
                    // an in-process host keeps a reference to what it submitted.
                    messages: copyInvalidMessages(messages),
                    ...(record.label === undefined ? {} : { label: record.label }),
                    agent: record.agent
                });
            }
        } catch (error) {
            // Unreachable for validation (already checked) or an unknown id (already
            // resolved). The one live case is the runtime's own running refusal — a
            // run that started between the check above and this call — so the
            // caller's 409 stays honest instead of becoming a 500.
            throw new SessionError(409, messageOf(error));
        }

        session.core = session.harness.snapshot();
        session.updatedAt = Date.now();

        await this.persistOrThrow();
        this.publish(session, { type: 'snapshot', session: this.snapshot(session) });

        // T16: the transcript's counts/revision moved (valid draft or unreadable raw), which is
        // exactly the `transcript.updated` signal - message bodies never ride the stream, so an
        // editor re-pages the messages route instead of receiving them.
        this.notifyStream({ kind: 'transcript.updated', sessionId: session.id, threadId, at: Date.now() });

        return {
            session: this.snapshot(session),
            transcript: this.threadTranscript(id, threadId)
        };
    }

    // DELETE ONE THREAD (R6, DELETE /sessions/:id/threads/:threadId).
    //
    // Removes the thread, its descendants, every owning turn, every result
    // reference that pointed at those turns, and their persisted copies. A running
    // thread (or one with queued work) is a 409 — stop it first. The default
    // `agent:<name>` conversation is a 400 (use reset).
    //
    // ORDERING: the new document is written BEFORE the live harness is touched, so
    // a failed write rolls back cleanly with nothing lost (the in-memory state and
    // the disk still describe the same session).
    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    async deleteThread(id: string, threadId: string): Promise<SessionSnapshot> {
        const session = this.require(id);

        if (!this.threadsSupported(session)) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        const record = session.harness.thread(threadId);

        if (record === undefined) {
            throw new SessionError(404, `Unknown thread "${threadId}".`);
        }

        if (record.origin === 'agent') {
            throw new SessionError(
                400,
                `Thread "${threadId}" is the agent's own conversation and cannot be deleted; use reset to clear the session.`
            );
        }

        // The conversation plus every conversation it OWNS (delegation lineage).
        const doomed = new Set<string>([threadId]);
        for (const candidate of session.harness.threads()) {
            if (this.isDescendantThread(session, candidate.id, threadId)) doomed.add(candidate.id);
        }

        // F4: a STOPPED-but-still-unwinding run (an abort-ignoring transport) is a
        // live run. Deleting it now would leave the durable file purged while the
        // runtime still owns the conversation. Every such turn is a 409, whether it
        // runs in a lane or on the exclusive gate (the runtime's `status` may
        // already read 'stopped', which is why the TURN is authoritative here).
        for (const turn of session.turns) {
            if (turn.threadId === undefined || !doomed.has(turn.threadId)) continue;
            if (turn.status !== 'running' && turn.status !== 'queued') continue;

            throw new SessionError(
                409,
                `Thread "${threadId}" still has live work; wait for it to stop before deleting it.`
            );
        }

        // A conversation the runtime still reports as running (for example one a
        // `threadSend` revived without a server turn) is live too.
        if (record.status === 'running') {
            throw new SessionError(
                409,
                `Thread "${threadId}" still has live work; wait for it to stop before deleting it.`
            );
        }

        // The runtime refuses a partial delete when a linked child is live; make
        // that a 409 with the same meaning instead of a generic harness error.
        for (const candidate of session.harness.threads()) {
            if (candidate.id === threadId) continue;
            if (!this.isDescendantThread(session, candidate.id, threadId)) continue;

            if (candidate.status === 'running' || session.lanes.get(candidate.id)?.active !== undefined) {
                throw new SessionError(
                    409,
                    `Thread "${candidate.id}" is running; stop it before deleting "${threadId}".`
                );
            }
        }

        // Queued work in EITHER backlog counts: a lane's own queue and the legacy
        // serialized queue (used only by a harness handle that predates the thread
        // API — a thread-capable session queues per lane). Deleting accepted
        // prompts would discard user work silently.
        for (const targetId of doomed) {
            const laneQueued = session.lanes.get(targetId)?.queue.length ?? 0;
            const legacyQueued = session.queue.filter((turn) => turn.threadId === targetId).length;

            if (laneQueued + legacyQueued > 0) {
                throw new SessionError(
                    409,
                    `Thread "${targetId}" still has queued work; stop it before deleting "${threadId}".`
                );
            }
        }

        // A LIVE task in another thread that is waiting for (or about to expand) a
        // doomed turn would hang once that turn disappears — its waiter would never
        // be signalled. Refuse until that task settles.
        for (const turn of session.turns) {
            if (turn.threadId !== undefined && doomed.has(turn.threadId)) continue;
            if (turn.status !== 'queued' && turn.status !== 'running') continue;
            if (turn.references === undefined) continue;

            const waitsOnDoomed = turn.references.some((reference) => {
                const target = session.turns.find((candidate) => candidate.id === reference.turnId);
                return (
                    target !== undefined &&
                    target.threadId !== undefined &&
                    doomed.has(target.threadId)
                );
            });

            if (waitsOnDoomed) {
                throw new SessionError(
                    409,
                    `Thread "${threadId}" is referenced by a live task; stop that work before deleting it.`
                );
            }
        }

        // F4: a STOPPED-but-still-unwinding run (an abort-ignoring transport) is a
        // live run. Deleting it now would leave the durable file purged while the
        // runtime still owns the conversation. Every such turn is a 409, whether it
        // runs in a lane, the legacy gate, or a conversation the caller just
        // stopped (the runtime's `status` may already read 'stopped').
        for (const turn of session.turns) {
            if (turn.threadId === undefined || !doomed.has(turn.threadId)) continue;
            if (turn.status !== 'running' && turn.status !== 'queued') continue;

            throw new SessionError(
                409,
                `Thread "${threadId}" still has live work; wait for it to stop before deleting it.`
            );
        }
        if (session.status === 'running' && session.controller !== undefined) {
            const active = [...session.turns]
                .sort((left, right) => left.index - right.index)
                .filter((turn) => turn.status === 'running')
                .pop();

            if (active?.threadId !== undefined && doomed.has(active.threadId)) {
                throw new SessionError(
                    409,
                    `Thread "${threadId}" still has live work; wait for it to stop before deleting it.`
                );
            }
        }

        // Retire the labels this deletion removes BEFORE the content goes: only the
        // counters survive, never the text they described (R6 tombstone).
        this.mergeLabelHighWater(
            session,
            session.turns.filter(
                (turn) => turn.threadId !== undefined && doomed.has(turn.threadId)
            )
        );

        // Persist the post-delete document FIRST. `sessionRecord` is projected as if
        // the deletion had already happened, so a write failure changes nothing.
        const survivors = session.turns.filter(
            (turn) => turn.threadId === undefined || !doomed.has(turn.threadId)
        );
        const removedIds = new Set(
            session.turns
                .filter((turn) => turn.threadId !== undefined && doomed.has(turn.threadId))
                .map((turn) => turn.id)
        );

        const projectedTurns = survivors.map((turn) => {
            const copy = copyTurn(turn);

            if (turn.references === undefined) return copy;

            const kept = turn.references.filter((reference) => !removedIds.has(reference.turnId));

            // A link to a deleted turn is dropped from the persisted copy too: the
            // record must not promise a target that no longer exists.
            if (kept.length === 0) delete copy.references;
            else copy.references = kept.map((reference) => ({ ...reference }));

            return copy;
        });

        // F6: the durable agent-result registry must lose exactly what the runtime
        // purge removes. The snapshot does not expose a result's thread, so the
        // doomed invocation ids are reconstructed from what the server recorded:
        // every root invocation of a doomed thread's turn, every invocation that
        // appeared in its events (delegated children included), and each doomed
        // thread's latest invocation. Branch invocations are NOT thread-scoped and
        // are deliberately left alone.
        const doomedInvocations = this.doomedInvocationIds(session, doomed, removedIds);

        const projectedCore = ((): HarnessSnapshot => {
            // Project from the LIVE snapshot, not the cached one: the answer must be
            // exactly what the runtime will return after the purge.
            const core = JSON.parse(JSON.stringify(session.harness.snapshot())) as HarnessSnapshot;

            if (core.threads !== undefined) {
                core.threads = core.threads.filter((thread) => !doomed.has(thread.id));
                // F5: KEEP the id high-water even with zero records. The runtime
                // persists `threads: []` + `threadSequence` once any host thread was
                // ever minted; dropping them here would let a restart reuse
                // `thread-1`.
            }

            if (core.agentResults !== undefined) {
                const kept = core.agentResults.filter(
                    (result) => !doomedInvocations.has(result.invocationId)
                );

                if (kept.length === 0) delete core.agentResults;
                else core.agentResults = kept;
            }

            return core;
        })();

        const seedEntries = [...session.labelSeeds].filter(([turnId]) => !removedIds.has(turnId));
        const invocationEntries = [...session.turnInvocations].filter(
            ([turnId]) => !removedIds.has(turnId)
        );
        const highWaterEntries = [...session.labelHighWater];
        // R8: a deleted conversation's display name leaves the map; the per-code
        // high-water STAYS, so the retired name is never minted again.
        const threadLabelEntries = [...session.threadLabels].filter(([id]) => !doomed.has(id));
        const threadLabelHighWaterEntries = [...session.threadLabelHighWater];
        // C4: an unreadable transcript belongs to a conversation, so the doomed
        // conversations' raw values leave the durable record with them. (A stale
        // entry would otherwise be re-offered for a thread that no longer exists.)
        const invalidEntries = [...session.invalidThreads].filter(([id]) => !doomed.has(id));
        // T10: an instruction snapshot belongs to a turn, so the doomed turns'
        // snapshots leave the durable record with them (a stale key would otherwise
        // keep re-feeding a fold for a turn the document no longer lists).
        const instructionEntries = [...session.turnInstructionSources].filter(([turnId]) => !removedIds.has(turnId));

        const previous = this.sessionRecord(session);

        const projected: HarnessSessionRecord = {
            ...previous,
            turns: projectedTurns,
            queue: session.queue.map((turn) => turn.id).filter((turnId) => !removedIds.has(turnId)),
            core: projectedCore,
            ...(seedEntries.length === 0 ? {} : { labelSeeds: Object.fromEntries(seedEntries) }),
            ...(invocationEntries.length === 0
                ? {}
                : { turnInvocations: Object.fromEntries(invocationEntries) }),
            ...(instructionEntries.length === 0
                ? {}
                : {
                      turnInstructionSources: Object.fromEntries(
                          instructionEntries.map(([turnId, sources]) => [
                              turnId,
                              sources.map((source) => ({
                                  agent: source.agent,
                                  instructions: [...source.instructions],
                                  ...(source.at === undefined ? {} : { at: source.at })
                              }))
                          ])
                      )
                  }),
            ...(highWaterEntries.length === 0
                ? {}
                : { labelHighWater: Object.fromEntries(highWaterEntries) }),
            ...(threadLabelEntries.length === 0
                ? {}
                : { threadLabels: Object.fromEntries(threadLabelEntries) }),
            ...(threadLabelHighWaterEntries.length === 0
                ? {}
                : { threadLabelHighWater: Object.fromEntries(threadLabelHighWaterEntries) }),
            ...(invalidEntries.length === 0 ? {} : { invalidThreads: Object.fromEntries(invalidEntries) })
        };

        // Drop the stale keys from the override when they are absent in the
        // projection (sessionRecord may have included them above).
        if (seedEntries.length === 0) delete projected.labelSeeds;
        if (invocationEntries.length === 0) delete projected.turnInvocations;
        if (instructionEntries.length === 0) delete projected.turnInstructionSources;
        if (highWaterEntries.length === 0) delete projected.labelHighWater;
        if (threadLabelEntries.length === 0) delete projected.threadLabels;
        if (threadLabelHighWaterEntries.length === 0) delete projected.threadLabelHighWater;
        if (invalidEntries.length === 0) delete projected.invalidThreads;

        await this.persistOrThrow(new Map([[session.id, projected]]));

        // Durable: now change the runtime. Preflight above rejects every live or
        // queued conversation, so this call has nothing left to refuse. If the
        // runtime still fails (a future/core contract change), ROLL THE FILE BACK to
        // the document it had before this call: memory and disk then both describe
        // the pre-delete state, and the caller gets an honest 500.
        try {
            session.harness.deleteThread(threadId);
        } catch (error) {
            try {
                await this.persistOrThrow(new Map([[session.id, previous]]));
            } catch {
                // The rollback write failed; report the original refusal.
            }

            throw new SessionError(500, `Could not delete thread "${threadId}": ${messageOf(error)}`);
        }

        // T5: the conversation is gone, so its worker is gone with it. Preflight above
        // refused a live or queued turn, so nothing is mid-flight here; the epoch is retired
        // in the authority's journal, which is what makes any late frame from that worker a
        // no-op instead of a write into a deleted conversation.
        this.host?.closeLane(id, { kind: 'thread', threadId }, 'thread deleted');

        // Purge the owning turns and every link that pointed at them.
        session.turns = survivors;

        // R1/R4: the compiled trees of the deleted turns go with them, and the durable
        // per-step log is compacted to the SURVIVING turns. The compaction is what
        // makes a deletion final across a restart: the restore merge would otherwise
        // find journal records for turns the document no longer lists and recover them
        // as orphan steps.
        this.forgetProjections(session, removedIds);
        this.compactJournal(session, survivors.map((turn) => turn.id));

        // R8: forget the doomed conversations' names (their high-water stays).
        for (const id of doomed) session.threadLabels.delete(id);
        for (const turn of survivors) {
            if (turn.references === undefined) continue;

            const kept = turn.references.filter((reference) => !removedIds.has(reference.turnId));
            if (kept.length === turn.references.length) continue;

            if (kept.length === 0) delete turn.references;
            else turn.references = kept;
        }

        for (const removed of removedIds) {
            session.labelSeeds.delete(removed);
            session.turnInvocations.delete(removed);
            session.turnInstructionSources.delete(removed);

            // Release anyone awaiting a removed turn's completion (nothing else
            // will settle it) and forget its cached settler.
            const settle = session.settlers.get(removed);
            if (settle !== undefined) {
                session.settlers.delete(removed);
                settle();
            }
        }

        // Forget every lane of the deleted conversations. Its queued turns were
        // refused above (409), so the queue is empty by construction.
        for (const targetId of doomed) session.lanes.delete(targetId);

        // The invocation joins of a deleted conversation have no remaining target.
        for (const [invocationId, threadId] of session.invocationThreads) {
            if (doomed.has(threadId)) session.invocationThreads.delete(invocationId);
        }

        // C4: same rule for an unreadable transcript — the durable projection above
        // already dropped it, so the live map must match the file.
        for (const targetId of doomed) session.invalidThreads.delete(targetId);

        session.queue = session.queue.filter((turn) => !removedIds.has(turn.id));
        session.updatedAt = Date.now();
        session.core = session.harness.snapshot();

        // F6 consistency guard: the durable projection and the runtime's post-purge
        // snapshot must describe the same core state (threads, high-water, agent
        // results). If they ever differ, persist the runtime's answer so a restart
        // cannot resurrect a lookup the live session already lost.
        if (JSON.stringify(session.core) !== JSON.stringify(projectedCore)) this.persistBestEffort();

        // Nothing is executing for a deleted thread; wake parked waiters so a
        // `waitForIdle`/reset request can observe the new state.
        this.releaseTurnWaiters(session);
        this.releaseDrain(session);

        this.publish(session, { type: 'snapshot', session: this.snapshot(session) });

        // T16: every deleted conversation and every deleted row is an invalidation the stream
        // states by id - clients re-page the roster and the turns page rather than being handed
        // a snapshot of what is left.
        for (const targetId of removedIds) {
            this.notifyStream({ kind: 'turn.removed', sessionId: session.id, turnId: targetId, at: Date.now() });
        }

        for (const targetId of doomed) {
            this.notifyStream({ kind: 'thread.removed', sessionId: session.id, threadId: targetId, at: Date.now() });
        }

        return this.snapshot(session);
    }

    // D4 (worker IO): ASYNC because the write is durable BEFORE the response. Inline this
    // still returns after the synchronous rename; with an IO client it resolves on the
    // worker's receipt for THIS document (./workers/io-client.ts, contract 1). A caller that
    // drops the await cannot claim the mutation survived a restart.
    //
    // The truncate queued below is ordered AHEAD of this save by the queue, so the document
    // that no longer lists the forgotten turns can never land before the log stopped
    // replaying them.
    async reset(id: string): Promise<SessionSnapshot> {
        const session = this.require(id);

        // `busy`, not `status`: a manual delegate/toolCreate call holds the
        // session without a turn, and resetting its harness mid-call would clear
        // state the tool is still mutating. A pending queue is also refused: those
        // tasks were accepted against this harness, so the caller must stop them
        // first (cancel { all: true }) rather than silently discarding them.
        // A live LANE run or a lane backlog is refused for the same reason: those
        // tasks were accepted against this harness, so the caller must stop them
        // first (cancel { all: true }).
        if (this.busyOrPending(session)) {
            throw new SessionError(409, 'Cancel the running task before resetting the session.');
        }

        // `harness.reset()` only resets the entry agent. A session is the whole
        // conversation, so sibling agents (the researcher's summarizer) are reset
        // too, then discovery is cleared by the harness call.
        for (const agent of Object.values(session.harness.agents)) {
            agent.reset();
        }
        session.harness.reset();

        // T5: a reset restarts record ids, the tool budget view, and the archive, so the
        // session's identity ledger and memory plan are rebuilt from the fresh harness on the
        // next turn rather than continuing counters over a conversation that no longer exists.
        this.authorities.delete(id);
        this.memoryKeys.delete(id);

        // Start over on the renderable record too: the todo list is cleared by the
        // harness reset above, and the turns belong to the same conversation, so
        // keeping them would make the UI show prompts history no longer contains.
        session.turns = [];
        // R1-R6: `harness.reset()` removed every HOST thread, so their lanes and
        // joins go with them. Turn indices and label numbering restart with the new
        // conversation (a reset is a new record, not a deletion).
        session.lanes.clear();
        session.turnSequence = 0;
        session.labelSeeds.clear();
        // A reset starts a NEW conversation, so retired labels are forgotten with it
        // (unlike deletion, which keeps the tombstone counters).
        session.labelHighWater.clear();
        // R8: a reset opens a NEW conversation, so conversation names restart too
        // (deletion, by contrast, keeps the high-water to retire a name forever).
        session.threadLabels.clear();
        session.threadLabelHighWater.clear();
        session.turnInvocations.clear();
        // T10: the recorded instruction snapshots belong to the conversation that just
        // ended. The NEXT turn re-freezes them from the agent it actually runs with, so
        // a reset is also the one moment a historical `system` count is allowed to
        // change — there is no historical turn left to hold it.
        session.turnInstructionSources.clear();
        session.invocationThreads.clear();
        // C4: every conversation is gone, so an unreadable transcript from this
        // conversation has nothing left to describe. A reset starts the raw-JSON
        // editing over too.
        session.invalidThreads.clear();
        // N4: a reset forgets the conversation, so a question from it is no longer
        // answerable. No pending entry exists here (reset refuses a busy session,
        // and a run expires its own questions), but the bounded history is cleared
        // so an old card cannot claim a 409 for a session that no longer knows it.
        session.pendingActions.clear();
        session.completedActions = [];
        // R1/R4: the compiled state and the durable per-step log start over with the
        // conversation. A truncate is required, not optional: without it a restart
        // would replay the OLD turns' events onto the new record as ghost steps, and
        // without the cache clear a stale tree could be served until the next event.
        session.projections.clear();
        session.blockCache.clear();
        // D4: the log restarts on whichever thread owns the append handle. The strict save
        // below is posted AFTER this queue op, so the FIFO order is what guarantees the
        // truncated log reaches the disk before the document that no longer lists the dropped
        // turns (the rule ./journal.ts has always relied on, enforced by the queue).
        if (this.io === undefined) session.journal?.truncate();
        else this.io.queueJournalTruncate(session.id);
        session.status = 'idle';
        session.cancelled = false;
        session.lastError = undefined;
        session.updatedAt = Date.now();
        session.core = session.harness.snapshot();

        // The cleared transcript/records are the new durable state: persist before
        // acknowledging the reset (the old file must not come back on restart).
        await this.persistOrThrow();

        // Watchers would otherwise keep rendering turns the server just forgot.
        // A snapshot is enough: a reset deletes rows, so no upsert can express it.
        this.publish(session, { type: 'snapshot', session: this.snapshot(session) });

        return this.snapshot(session);
    }

    // Deleting a session never waits for an in-flight operation: an active run is
    // aborted, pending queue turns are discarded, and attached /events watchers
    // are closed. A manual call is detached but allowed to settle against the
    // removed harness (its result is simply no longer listed). `disposed` makes
    // the pump stop and suppresses every later publish, so a removed session can
    // never leak frames.
    async remove(id: string): Promise<boolean> {
        const session = this.sessions.get(id);
        if (!session) return false;

        // Persist the deletion BEFORE tearing the session down, so a failed write
        // rolls back cleanly (the in-memory session is still fully usable) and the
        // server never reports a delete it could not make durable.
        this.sessions.delete(id);

        try {
            await this.persistOrThrow();
        } catch (error) {
            this.sessions.set(id, session);
            throw error;
        }

        // The per-step log is part of this session's durable footprint: a deleted
        // session must not leave events behind that a restart could replay as ghost
        // turns. Captured BEFORE `disposeSession` (which closes and clears the handle).
        const journal = session.journal;

        this.disposeSession(session);

        // D4: same order as inline (close, then remove), because the worker's `remove` also
        // drops its cached handle - and in worker mode the coordinator may never have held one
        // at all, so the queue op is issued by session id, not by handle.
        if (this.io === undefined) journal?.remove();
        else this.io.queueJournalRemove(id);

        return true;
    }

    dispose(): void {
        // Idempotent: once the store is closing/closed the map is empty and the
        // graceful document is already on disk, so a second call must not save.
        if (this.shuttingDown) return;

        // 1. Commit BEFORE the guard is raised: disposeSession drops the accepted
        //    backlog (appropriate for remove(), not for a graceful shutdown), so
        //    saving first is what preserves queued prompts and the active turn as
        //    an interrupted record. This is the ONLY write dispose() performs.
        this.persistBestEffort();

        // 2. Close the store to further saves BEFORE aborting anything (P1-B).
        //    The abort below settles asynchronously, so the aborted run's sink
        //    (~sink persistBestEffort) and its post-finally save would otherwise
        //    serialize `sessions: []` over the document just written and destroy
        //    the database (repro: Temp/T10/probe-dispose.ts).
        this.closing = true;

        // 3. Tear down: abort active runs, discard accepted work, end watchers.
        //    Nothing here waits for an uncooperative harness; the guards above
        //    make its late continuations harmless.
        for (const session of this.sessions.values()) {
            this.disposeSession(session);
        }

        this.sessions.clear();
        this.closed = true;

        // T5: the workers go last, after the document is on disk. Termination is async and a
        // shutdown must not wait on an uncooperative lane, so this is fire-and-forget - and
        // every lane's epoch was already retired by disposeSession above, which is what makes
        // a late frame from a dying worker harmless rather than merely unlikely.
        void this.host?.close('store disposed').catch(() => undefined);

        // D4: the IO queue goes last as well, after the graceful document has been queued.
        // `close()` flushes the coalesced slot and drains every frame posted before its
        // `shutdown`, so the document dispose() just wrote is on disk before the thread stops,
        // and `drainIo` reports any write that did not make it.
        //
        // It is fire-and-forget HERE for the same reason the lane close is: `dispose()` is
        // synchronous by contract. It is still safe - a live Worker keeps the process alive
        // until it is terminated, so the drain cannot be truncated by an exit - and a host that
        // must not proceed before the disk is settled awaits `drainIo()` itself (./start.ts's
        // close path, and the worker-mode tests). Same cached promise either way.
        void this.drainIo('store disposed').catch(() => undefined);
    }

    // Shared teardown for remove()/dispose(): stop execution, drop accepted work,
    // release every waiter, and end every watcher. Idempotent: a second call finds
    // empty collections.
    private disposeSession(session: Session): void {
        // T5: a session that goes away takes its lane workers with it. The epochs are retired
        // FIRST (inside closeSession), so a frame from a worker that has not stopped yet
        // cannot move state that is on its way out, and the authority for this id is rebuilt
        // if the same id is ever restored again.
        this.host?.closeSession(session.id, 'session disposed');
        this.authorities.delete(session.id);
        this.memoryKeys.delete(session.id);

        // Set BEFORE aborting: the aborted run's terminal publish is then
        // suppressed (the session no longer exists for any client).
        session.disposed = true;

        // N4: no owner question can be answered for a removed/gone session. Reject
        // the runtime's await before the abort so teardown never leaves a pending
        // promise (and its abort listener) behind.
        this.expireActions(session, ACTION_SESSION_GONE_MESSAGE);

        // Detach the sink with the session. A provider that ignores its abort
        // signal can still yield progress frames; with no sink they are dropped
        // instead of being recorded into a turn nobody will ever read (and asking
        // for a save the store now refuses anyway).
        session.sink = undefined;

        if (session.status === 'running') {
            session.cancelled = true;
            session.controller?.abort();
        }

        // R1-R6: every live lane is aborted too. Each lane's recorder is detached
        // (its sink would otherwise keep recording into a turn nobody reads), and
        // the request to stop is recorded so the terminal frame cannot claim a
        // plain failure.
        for (const lane of session.lanes.values()) {
            lane.sink = undefined;
            lane.stopRequested = true;
            lane.controller?.abort();
        }

        // Discard pending work instead of running it, but release any enqueue()
        // completion so a caller awaiting `settled` does not hang.
        for (const turn of session.queue.splice(0)) {
            this.settle(turn, session);
        }

        for (const lane of session.lanes.values()) {
            for (const turn of lane.queue.splice(0)) this.settle(turn, session);
        }

        // The ACTIVE turn (never in `queue`) is released here too: this session can
        // no longer publish a terminal state, so its logical work is over now
        // rather than whenever — or whether — the harness finally settles. Any
        // later settle() for the same turn is a no-op (the map lookup fails).
        const settlers = [...session.settlers.values()];
        session.settlers.clear();
        for (const resolve of settlers) resolve();

        const watchers = [...session.watchers];
        session.watchers.clear();

        for (const watcher of watchers) {
            try {
                watcher.close();
            } catch {
                // The stream is already gone; nothing to close.
            }
        }

        // R3: display observers end exactly like raw ones — the stream closes, and no
        // later frame is published for a disposed session.
        const viewWatchers = [...session.viewWatchers];
        session.viewWatchers.clear();

        for (const watcher of viewWatchers) {
            try {
                watcher.close();
            } catch {
                // Same rule: the stream is already gone.
            }
        }

        // R4: flush and release the append handle. The LOG ITSELF stays on disk — a
        // store shutdown must never discard durable steps — and only an explicit
        // session removal deletes it (see `remove`).
        //
        // D4: in worker mode the handle is the worker's, so this queues a `journal.close`
        // (fsync + release) instead of touching the fd from here. It is ordered ahead of every
        // later frame for this session, and `drainIo()`/`close()` fences the whole queue on the
        // way out, so nothing recorded before a dispose can be lost silently.
        const journal = session.journal;

        if (this.io === undefined) journal?.close();
        else this.io.queueJournalClose(session.id);

        session.journal = undefined;
        session.projections.clear();
        session.blockCache.clear();

        // Wake a pump parked on the gate (it will see `disposed` and exit) and any
        // waitForIdle()/reference waiter.
        this.releaseBusy(session);
        this.releaseDrain(session);
        this.releaseTurnWaiters(session);
    }
}

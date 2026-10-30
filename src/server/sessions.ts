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
// TWO SUBMIT PATHS (R4, both retained):
//   - LEGACY: run() backs POST /sessions/:id/messages. The run is owned by that SSE
//     response: if its emitter fails the run is aborted, and a busy session is
//     rejected with 409 before a status line is sent.
//   - QUEUE: enqueue() backs POST /sessions/:id/tasks. It answers 202 immediately
//     and the private pump() executes the queue FIFO, so a task keeps running
//     after the browser disconnects. Watchers (GET /sessions/:id/events) only
//     unsubscribe on disconnect; nothing aborts a queued task except cancel/remove.
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
// FRESH BLOCKS + RESULT REFERENCES (R2): every submitted turn is a NEW block, not
// a resumed transcript. Before the harness runs, executeTurn reseeds every agent's
// conversation (`agent.reset()`, NOT `harness.reset()`), so the previous block's
// user/assistant messages are never inherited while discovery, todos, record
// stores, created tools, and the session's `turns` archive survive. A task may
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
// Cross-references:
//   - ./protocol.ts — SessionSnapshot.turns, SessionTurn, SessionStreamItem
//   - ./handler.ts  — forwards stream items verbatim; no turn inference there
//   - ./api.ts      — POST /tasks (202), GET /events (watcher), POST /cancel {all},
//                     POST /sessions/:id/actions/:requestId/answer
//   - ./harnesses/registry.ts — the in-memory harness registry
//   - ./harnesses/descriptor.ts — describeHarness, the frozen definition
//   - ../shared/agent-results.ts — labels, block projection, reference prompt
//   - ../core/action.ts — validateActionChoice (the one answer parser)

import { randomUUID } from 'node:crypto';
import type {
    Harness,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessActionRequestContext,
    HarnessAttachment,
    HarnessEvent,
    HarnessInteractionConfiguration,
    HarnessMessage,
    HarnessSnapshot,
    HarnessStateChangeEvent
} from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { validateAttachments } from '../shared/attachments';
import {
    composeAgentResultPrompt,
    findAgentResultBlock,
    findLatestAgentResultBlock,
    MAX_AGENT_REFERENCES,
    parseAgentReferenceLabels,
    readAgentResultReferenceList
} from '../shared/agent-results';
import type { AgentResultBlock, AgentResultReference } from '../shared/agent-results';
import { validateActionChoice } from '../core/action';
import { describeHarness } from './harnesses/descriptor';
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
import { HarnessPersistenceError } from './persistence';
import { HARNESS_DATABASE_VERSION, repairInterruptedToolCalls } from './persistence';
import type { HarnessDatabase, HarnessPersistence, HarnessSessionRecord } from './persistence';
import type {
    HarnessDescriptor,
    HarnessUsage,
    SessionSnapshot,
    SessionStatus,
    SessionStreamItem,
    SessionTurn
} from './protocol';

const MAX_INPUT_LENGTH = 200_000;

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

// One unanswered owner question, registered by the host callback that the runtime
// awaits. The store owns the resolver: POST /sessions/:id/actions/:requestId/answer
// settles it exactly once, and cancellation/removal rejects it so the runtime's
// tool call can finish instead of hanging a turn forever.
type PendingAction = {
    requestId: string;
    // The already-validated request this pending answer belongs to. The answer
    // route re-validates the choice against it, so an option id the model never
    // offered is a 400 rather than an answer the runtime must trust.
    request: HarnessActionRequest;
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

type Session = {
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
};

// What start.ts/runtime.ts hand the store (R3b). `persistence` owns the file,
// `database` is the document already loaded from it. Both are optional: without
// them the store is the previous in-memory implementation. `onPersistenceError`
// is how a background save failure becomes observable (the core observer swallows
// our callback's exceptions, so we never throw from a notification); the default
// logs to stderr and the last message is also exposed as `persistenceError`.
export type SessionStoreOptions = {
    persistence?: HarnessPersistence;
    database?: HarnessDatabase;
    onPersistenceError?: (error: Error) => void;
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
export type EnqueuedTask = {
    session: SessionSnapshot;
    turn: SessionTurn;
    settled: Promise<void>;
};

// What watch() hands the /events route: the snapshot captured atomically with
// registration, plus the detach function.
export type SessionWatch = {
    snapshot: SessionSnapshot;
    unsubscribe: () => void;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Copy a transcript for JSON serialization. `HarnessMessage` is plain data, and a
// snapshot must not expose the live arrays the harness keeps mutating.
const copyMessages = (messages: readonly HarnessMessage[]): HarnessMessage[] =>
    messages.map((message) => JSON.parse(JSON.stringify(message)) as HarnessMessage);

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
    ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } })
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

const copyTurns = (turns: readonly SessionTurn[]): SessionTurn[] => turns.map(copyTurn);

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

    // Durable layer, when the host supplied a database root. All writes are
    // synchronous (whole-document atomic replace), so they are serialized without
    // a queue: no two saves can interleave in this process.
    private readonly persistence: HarnessPersistence | undefined;
    private readonly onPersistenceError: ((error: Error) => void) | undefined;
    // Last background save failure. Exposed so a caller/test can observe a write
    // error that must not change a run's outcome (the core observer swallows it).
    private lastPersistenceError: string | undefined;
    // True while the constructor replays a document: the restored harness emits
    // `restore` state changes, and writing the file back mid-load would be a
    // pointless (and possibly partial) round trip.
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
    // with the API. `describe` captures host-specific availability (webSearch) in
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

        if (options.database !== undefined) {
            this.loading = true;

            try {
                for (const record of options.database.sessions) this.restoreSession(record);
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

    get size(): number {
        return this.sessions.size;
    }

    create(presetName: string, input?: Partial<RunnerSettings>): SessionSnapshot {
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
        let harness: Harness;
        try {
            harness = this.buildHarness(preset, settings, () => session);
        } catch (error) {
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
            watchers: new Set(),
            pumping: false,
            busyWaiters: [],
            drainWaiters: [],
            turnWaiters: [],
            settlers: new Map(),
            pendingActions: new Map(),
            completedActions: [],
            disposed: false,
            // An empty session is a valid commit point: snapshot() succeeds here.
            core: harness.snapshot()
        };

        this.sessions.set(session.id, session);

        // Write-through: the 201 must not report a session the next restart has
        // forgotten. A failed write rolls the in-memory entry back so a retry
        // cannot observe a session that was never durable.
        try {
            this.persistOrThrow();
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
        const progress = (event: HarnessEvent) => current()?.sink?.(event);

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

    // Register one unanswered question from the runtime. Rejections are the
    // intentional failure mode: the runtime turns a rejected handler into a
    // readable tool result for the model, so an over-full session or a cancelled
    // run never leaves a model turn hanging.
    private registerActionRequest(
        session: Session,
        context: HarnessActionRequestContext,
        signal: AbortSignal
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

            pending = {
                requestId: context.requestId,
                request: context.request,
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
    private expireActions(session: Session, message: string): void {
        for (const pending of [...session.pendingActions.values()]) {
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

    // Registry mutations happen in ./harnesses/registry.ts, outside the store, so
    // the dispatcher calls this after a successful create/patch. It must persist
    // before the HTTP result: a harness the next restart forgets is a lie. With no
    // database root it is a no-op (the previous in-memory behaviour).
    persistRegistry(): void {
        this.persistOrThrow();
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
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ...(session.lastError === undefined ? {} : { lastError: session.lastError }),
            turns: copyTurns(session.turns),
            // Queue entries must be the same turns; ids keep the document compact
            // and let the loader re-link them to the (already copied) turns.
            queue: session.queue.map((turn) => turn.id),
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

    private databaseRecord(): HarnessDatabase {
        return {
            version: HARNESS_DATABASE_VERSION,
            savedAt: Date.now(),
            registry: this.registry.list().map(presetToRecord),
            sessions: [...this.sessions.values()].map((session) => this.sessionRecord(session))
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
    private persistOrThrow(): void {
        if (this.persistence === undefined) return;

        if (this.shuttingDown) {
            throw new SessionError(503, 'The harness database is closed; nothing was saved.');
        }

        try {
            this.persistence.save(this.databaseRecord());
            this.lastPersistenceError = undefined;
        } catch (error) {
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
    private persistBestEffort(): void {
        if (this.persistence === undefined) return;

        if (this.shuttingDown) return;

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

    // Rebuild one session from a validated record. Order matters: the frozen
    // preset decides the harness shape, the harness must be built from it, and only
    // then can the core snapshot be applied (restore validates against the exact
    // agent/registry set before mutating).
    private restoreSession(record: HarnessSessionRecord): void {
        const location =
            this.persistence === undefined
                ? `Session "${record.id}"`
                : `Session "${record.id}" in ${this.persistence.file}`;

        try {
            // Fast path: the registry still has the exactly-matching entry (the
            // common case, including the scripted demo's captured factory). A
            // changed entry falls back to rebuilding from the SESSION's frozen
            // record, which is why a PATCH after creation does not break restart.
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

            let session: Session | undefined;
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
                busy: false,
                cancelled: false,
                turns,
                queue,
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
            session.core = core;
            harness.restore(core);

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

            // Now idle: capture the authoritative post-restore snapshot (it also
            // records the model map above) as this session's committed state.
            session.core = harness.snapshot();
            this.sessions.set(session.id, session);
        } catch (error) {
            // Corrupt or incompatible state must fail the whole load; silently
            // skipping one session would hide user data loss.
            throw new HarnessPersistenceError(
                this.persistence?.file ?? '',
                `${location} could not be restored: ${messageOf(error)}`
            );
        }
    }

    // Called before a stream is opened so a busy session is rejected with a real
    // JSON status, not an SSE frame. `busy` (not `status`) is checked because a
    // manual tool call also holds the session without becoming a turn. A pending
    // queue also rejects the legacy path: /messages owns its run via the response,
    // and it must not jump ahead of, or interleave with, tasks already accepted by
    // POST /tasks. Clients that want to submit while work is pending use /tasks.
    assertRunnable(id: string): void {
        const session = this.require(id);
        if (session.busy || session.queue.length > 0) {
            throw new SessionError(409, 'A task is already running in this session.');
        }
    }

    // Run one REGISTERED tool inside a session's harness (R8).
    //
    // This is the server path behind `POST /tools/:name` when the caller supplies a
    // sessionId: the core tools (toolRequest/toolCreate/todoManage/agentDelegate) have
    // no standalone implementation, so they must execute against the harness the
    // session owns — a manual discovery or todo call then affects the very
    // conversation the user is looking at. Registered, non-core tools are also
    // reachable here if a client asks (they run the same implementation either
    // way); the API keeps their direct runner for session-less calls.
    //
    // Failure mapping is the caller's job (src/server/api.ts):
    //   - unknown session            → SessionError 404 (require)
    //   - session busy (run/manual)  → SessionError 409 (single-flight gate)
    //   - tool absent from the run   → SessionError 404 (agentDelegate without subagents)
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
        // The same holds for a SECOND manual call: an async `agentDelegate` holds the
        // session across awaits, so without this check two manual mutations (or a
        // reset) could interleave even though `status` was never `running`.
        //
        // A non-empty QUEUE rejects too: queued tasks are already accepted work for
        // this harness, and a manual mutation would change state they will run
        // against. The pump would otherwise have to interleave two owners.
        if (session.busy || session.queue.length > 0) {
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
            const result = await session.harness.executeTool(name, parameters);

            // The tool may have mutated the todo/record stores, discovery, or the
            // created-tool registry. Persist that before the caller sees success:
            // an acknowledged manual mutation must survive a restart.
            session.core = session.harness.snapshot();
            this.persistOrThrow();

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

    private snapshot(session: Session): SessionSnapshot {
        return {
            id: session.id,
            harness: session.preset.name,
            status: session.status,
            // Pending backlog only (the active turn is not in `queue`). Omitted
            // when empty so every pre-queue snapshot keeps its exact shape.
            ...(session.queue.length === 0 ? {} : { queueDepth: session.queue.length }),
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
    setAgentModels(id: string, agentModels: unknown): SessionSnapshot {
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
            this.persistOrThrow();
        } catch (error) {
            for (const [name, model] of Object.entries(previous)) {
                session.harness.agents[name].model(model);
            }

            if (!session.busy) session.core = session.harness.snapshot();
            throw error;
        }

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
        // A non-empty queue also blocks this path: the pump's work was accepted
        // first and must keep FIFO order (see assertRunnable).
        if (session.busy || session.queue.length > 0) {
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
        // `index` is assigned here, once: a turn never moves within the session.
        const turn: SessionTurn = {
            id: randomUUID(),
            index: session.turns.length,
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

        await this.executeTurn(session, turn, emit, options.signal);
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
            const candidates = session.turns.filter((turn) => turn.index < turnIndex);
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

        // Conversation prefix (not just `[target]`): see `turnsThrough`.
        const block = findAgentResultBlock(this.turnsThrough(session, target.index), reference);

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
        const references = turn.references;

        if (references === undefined || references.length === 0) return turn.prompt;

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

            // Conversation prefix (not just `[target]`): see `turnsThrough`.
        const block = findAgentResultBlock(this.turnsThrough(session, target.index), reference);

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

        return composeAgentResultPrompt(turn.prompt, entries);
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
    enqueue(
        id: string,
        rawInput: string,
        attachments?: unknown,
        references?: unknown
    ): EnqueuedTask {
        const session = this.require(id);
        const validated = validateAttachmentsForSubmit(attachments);
        const input = validateInput(rawInput, validated.length);
        // BIND now (R2): the referenced turn/block must exist and be a PRIOR
        // completion target, so a bad reference is a 400 before a turn exists.
        // Content is deliberately NOT read here: a still-running target is queued
        // and expanded at EXECUTION (see expandReferences) after it completes.
        const boundReferences = this.normalizeReferences(
            session,
            session.turns.length,
            input,
            references
        );

        // Pending only. The active turn is not in `queue`, so one task can run
        // while this many wait; that keeps the cap a true backlog bound.
        if (session.queue.length >= MAX_PENDING_TASKS) {
            throw new SessionError(
                429,
                `A session cannot queue more than ${MAX_PENDING_TASKS} pending tasks.`
            );
        }

        const now = Date.now();

        // `status: 'queued'` and no `startedAt`: this record is complete and
        // renderable before any execution, which is what lets a reload show the
        // backlog. `events`/`eventTimes` start empty and are filled by the pump.
        const turn: SessionTurn = {
            id: randomUUID(),
            index: session.turns.length,
            prompt: input,
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

        session.turns.push(turn);
        session.queue.push(turn);
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
        // a retry cannot duplicate it.
        try {
            this.persistOrThrow();
        } catch (error) {
            const index = session.turns.indexOf(turn);
            if (index !== -1) session.turns.splice(index, 1);

            const queued = session.queue.indexOf(turn);
            if (queued !== -1) session.queue.splice(queued, 1);

            session.settlers.delete(turn.id);
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
        void this.pump(session);

        return { session: snapshot, turn: queuedTurn, settled };
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
                    await this.executeTurn(session, head);
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
    waitForIdle(id: string): Promise<void> {
        const session = this.require(id);

        if (!session.pumping && session.queue.length === 0) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            session.drainWaiters.push(resolve);
        });
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

    // Fan a frame out to every watcher. NEVER throws and never awaits: a dead,
    // slow, or hostile watcher is dropped/ignored, so it can neither cancel a turn
    // nor block the pump. Each watcher gets its OWN deep copy, the same rule
    // copyTurn applies to every client-facing record, so one listener mutating a
    // frame cannot corrupt a sibling's.
    private publish(session: Session, item: SessionStreamItem): void {
        if (session.disposed) return;

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
        signal?: AbortSignal
    ): Promise<void> {
        // Take the gate BEFORE the first await. Everything after this line runs
        // inside the try/finally below, so even an exceptional setup cannot leave
        // `busy` held (which would reject every later operation) or park the pump.
        session.busy = true;

        const controller = new AbortController();

        const usageField = (): { usage?: HarnessUsage } =>
            turn.usage === undefined ? {} : { usage: { ...turn.usage } };

        // Bound to THIS controller and THIS turn: `session.controller` is swapped by
        // the next turn, so the guard below turns a stale signal into a no-op.
        const forwardAbort = (): void => {
            if (session.controller !== controller) return;

            session.cancelled = true;
            controller.abort();
        };

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

            session.status = 'running';
            session.cancelled = false;
            session.lastError = undefined;
            session.updatedAt = startedAt;
            session.controller = controller;

            // Durability at the turn-start transition: the running row exists before
            // any provider work, so a crash mid-run leaves an explicit interrupted
            // turn instead of a prompt that vanished. A write failure here fails the
            // turn (the catch below) BEFORE it spends provider time.
            this.persistOrThrow();

            // Legacy disconnect → cancel THIS run only. Registered after the
            // controller is published and removed in the finally, so it can never
            // reach the next queued turn.
            if (signal !== undefined) {
                signal.addEventListener('abort', forwardAbort, { once: true });
                if (signal.aborted) forwardAbort();
            }

            session.sink = async (event) => {
                // Record first: the server's turn is authoritative even when the client
                // that opened the stream disappeared (a reload, a cancel by disconnect).
                // `at` is the one server timestamp shared by the frame and the parallel
                // `eventTimes` entry, so a client and a reload agree exactly.
                const record = copyEvent(event);
                const at = Date.now();
                turn.events.push(record);
                turn.eventTimes?.push(at);

                // Token tally, accumulated here so every client reads the SERVER's
                // figure. Only the per-request `usage` event counts: the harness also
                // repeats the final request's usage on `done`, and adding that too
                // would double the last step.
                if (record.type === 'usage') turn.usage = addUsage(turn.usage, record.usage);

                turn.updatedAt = at;

                // Durable background transitions. A full document is rewritten per
                // non-delta event (message commit, tool call/result, usage, start,
                // done); per-token text/reasoning deltas are coalesced and land with
                // the terminal save. A failure is recorded, never thrown: the run's
                // outcome must not depend on the disk.
                if (record.type !== 'text' && record.type !== 'reasoning') {
                    this.persistBestEffort();
                }

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

            // R2 FRESH BLOCK. Every submitted turn is a NEW conversation: the
            // previous block's user/assistant transcript must not be inherited (its
            // results stay available through the SESSION turn record and the
            // reference expansion below). `agent.reset()` reseeds only the
            // conversation from the agent's instructions — it deliberately leaves
            // discovery, the todo list, record stores, created tools, and the
            // session's `turns` archive untouched, so historical results are not
            // discarded. This is why `harness.reset()` is NOT used here.
            this.resetConversations(session);

            // Commit the fresh transcript as the active state. A crash during this
            // block then restores a coherent empty+partial conversation rather than
            // replaying the previous block's history into it.
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
            const runPrompt = await this.expandReferences(session, turn);

            // Root prompt + its composer attachments (T3). The attachments ride
            // ONLY on this run's root user message; core validates them once more
            // before appending history (so a corrupted restored record is rejected
            // without mutating the transcript). A text-only turn passes no key.
            await session.harness(runPrompt, {
                signal: controller.signal,
                ...(turn.attachments === undefined ? {} : { attachments: turn.attachments })
            });
            session.status = 'idle';
            turn.status = 'done';
        } catch (error) {
            // A cancelled turn is terminal as `cancelled`, even though the session
            // keeps its existing error/lastError contract for the UI banner. A setup
            // failure lands here too: the finally below still releases the gate.
            failure = session.cancelled ? 'The run was cancelled.' : messageOf(error);
            session.status = 'error';
            session.lastError = failure;
            turn.status = session.cancelled ? 'cancelled' : 'error';
        } finally {
            // Remove the legacy forwarder BEFORE the gate is released, so the next
            // queued turn can never inherit this response's abort signal.
            signal?.removeEventListener('abort', forwardAbort);

            session.sink = undefined;
            session.controller = undefined;
            // N4: an unanswered question cannot outlive its run. The runtime
            // normally resolves or aborts every handler it awaits, so this is a
            // backstop; finishActionRequest makes it a no-op when there is nothing
            // left. Rejecting here also releases the pending map before the gate
            // opens, so the next queued turn starts with a clean slate.
            this.expireActions(session, ACTION_RUN_ENDED_MESSAGE);

            // Release the single-flight gate on success, failure, and cancellation
            // alike: a stuck gate would reject every later chat/reset/manual call
            // and park the queue pump forever.
            session.busy = false;
            session.updatedAt = Date.now();
            turn.updatedAt = session.updatedAt;
            // The turn's terminal status is now visible; a turn parked while
            // referencing it may continue (and re-check) on its next tick.
            this.releaseTurnWaiters(session);
            this.releaseBusy(session);
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
    cancel(id: string, options: { all?: boolean } = {}): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;

        let cancelled = false;

        if (session.status === 'running') {
            session.cancelled = true;
            session.controller?.abort();
            // N4: a cancelled run can no longer receive an owner answer. Reject
            // the awaited promise now (the abort signal also reaches it, but this
            // makes the outcome explicit and settles exactly once).
            this.expireActions(session, ACTION_CANCELLED_MESSAGE);
            cancelled = true;
        }

        if (options.all !== true) {
            // Write-through: an accepted cancel survives a restart (the turn is
            // restored as cancelled, not as a phantom running turn).
            if (cancelled) this.persistOrThrow();
            return cancelled;
        }

        const dropped = session.queue.splice(0);
        const now = Date.now();

        for (const turn of dropped) {
            turn.status = 'cancelled';
            turn.updatedAt = now;

            // Upsert the terminal record and release the enqueue() completion:
            // a queued turn can never run, so it must not leave a caller waiting.
            this.publish(session, { type: 'turn', turn: copyTurn(turn) });
            this.settle(turn, session);
        }

        if (dropped.length > 0) {
            cancelled = true;
            session.updatedAt = now;
            // Dropped turns are terminal without an executeTurn finally, so wake
            // reference waiters here too.
            this.releaseTurnWaiters(session);

            // With nothing executing, no pump is left to publish the drain
            // snapshot, so send it here. When a turn IS active the pump sends it.
            if (!session.busy && !session.pumping) {
                this.publish(session, { type: 'snapshot', session: this.snapshot(session) });
            }
        }

        // The dropped turns are terminal records: make that durable before the
        // response claims they were cancelled.
        if (cancelled) this.persistOrThrow();

        return cancelled;
    }

    reset(id: string): SessionSnapshot {
        const session = this.require(id);

        // `busy`, not `status`: a manual agentDelegate/toolCreate call holds the
        // session without a turn, and resetting its harness mid-call would clear
        // state the tool is still mutating. A pending queue is also refused: those
        // tasks were accepted against this harness, so the caller must stop them
        // first (cancel { all: true }) rather than silently discarding them.
        if (session.busy || session.queue.length > 0) {
            throw new SessionError(409, 'Cancel the running task before resetting the session.');
        }

        // `harness.reset()` only resets the entry agent. A session is the whole
        // conversation, so sibling agents (the researcher's summarizer) are reset
        // too, then discovery is cleared by the harness call.
        for (const agent of Object.values(session.harness.agents)) {
            agent.reset();
        }
        session.harness.reset();

        // Start over on the renderable record too: the todo list is cleared by the
        // harness reset above, and the turns belong to the same conversation, so
        // keeping them would make the UI show prompts history no longer contains.
        session.turns = [];
        // N4: a reset forgets the conversation, so a question from it is no longer
        // answerable. No pending entry exists here (reset refuses a busy session,
        // and a run expires its own questions), but the bounded history is cleared
        // so an old card cannot claim a 409 for a session that no longer knows it.
        session.pendingActions.clear();
        session.completedActions = [];
        session.status = 'idle';
        session.cancelled = false;
        session.lastError = undefined;
        session.updatedAt = Date.now();
        session.core = session.harness.snapshot();

        // The cleared transcript/records are the new durable state: persist before
        // acknowledging the reset (the old file must not come back on restart).
        this.persistOrThrow();

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
    remove(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;

        // Persist the deletion BEFORE tearing the session down, so a failed write
        // rolls back cleanly (the in-memory session is still fully usable) and the
        // server never reports a delete it could not make durable.
        this.sessions.delete(id);

        try {
            this.persistOrThrow();
        } catch (error) {
            this.sessions.set(id, session);
            throw error;
        }

        this.disposeSession(session);
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
    }

    // Shared teardown for remove()/dispose(): stop execution, drop accepted work,
    // release every waiter, and end every watcher. Idempotent: a second call finds
    // empty collections.
    private disposeSession(session: Session): void {
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

        // Discard pending work instead of running it, but release any enqueue()
        // completion so a caller awaiting `settled` does not hang.
        for (const turn of session.queue.splice(0)) {
            this.settle(turn, session);
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

        // Wake a pump parked on the gate (it will see `disposed` and exit) and any
        // waitForIdle()/reference waiter.
        this.releaseBusy(session);
        this.releaseDrain(session);
        this.releaseTurnWaiters(session);
    }
}

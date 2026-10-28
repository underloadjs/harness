// In-memory sessions for the harness server.
//
// A session owns exactly one harness instance and its conversation. Submitting a
// task appends to that conversation, so the UI can send another task later and the
// model still sees the earlier transcript. Nothing is persisted: restarting the
// server is a clean slate.
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
// Cross-references:
//   - ./protocol.ts — SessionSnapshot.turns, SessionTurn, SessionStreamItem
//   - ./handler.ts  — forwards stream items verbatim; no turn inference there
//   - ./api.ts      — POST /tasks (202), GET /events (watcher), POST /cancel {all}
//   - ../harnesses/registry.ts — the in-memory harness registry
//   - ../harnesses/descriptor.ts — describeHarness, the frozen definition

import { randomUUID } from 'node:crypto';
import type { Harness, HarnessEvent, HarnessMessage } from '../src/harness';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
import { describeHarness } from '../harnesses/descriptor';
import { createHarnessRegistry, HarnessRegistryError, normalizeAgentModels } from '../harnesses/registry';
import type { HarnessRegistry } from '../harnesses/registry';
import { mergeSettings } from './config';
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
    // enqueue()'s per-turn completion resolvers, keyed by turn id. Resolved when
    // the turn reaches a terminal status or is dropped by cancel-all.
    settlers: Map<string, () => void>;
    // Set by remove()/dispose(): the pump stops, pending turns are discarded, and
    // no later frame is published for this session.
    disposed: boolean;
};

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

const safeEmit = async (emit: Emit, item: SessionStreamItem): Promise<void> => {
    try {
        await emit(item);
    } catch {
        // The stream is gone. The run is aborted through the response's close
        // handler, so there is nothing else to do here.
    }
};

// Trim + bound a task input. Shared by the legacy run() and the queue enqueue()
// so the two submit surfaces cannot disagree about what a valid task is. Throws
// BEFORE any mutation, which is what makes a rejected submit safe to retry.
const validateInput = (rawInput: string): string => {
    const input = rawInput.trim();

    if (input.length === 0) {
        throw new SessionError(400, 'A task cannot be empty.');
    }

    if (input.length > MAX_INPUT_LENGTH) {
        throw new SessionError(413, `A task cannot exceed ${MAX_INPUT_LENGTH} characters.`);
    }

    return input;
};

export class SessionStore {
    private readonly sessions = new Map<string, Session>();

    // `registry` defaults to a fresh in-memory registry over the shipped presets.
    // It is injectable so tests can run scripted harnesses (including subagents and
    // failures) without reaching a provider, and so the host can share ONE registry
    // with the API. `describe` captures host-specific availability (webSearch) in
    // the frozen snapshot: the store owns no catalogue, so production injects a
    // describer bound to the runtime catalogue.
    constructor(
        readonly defaults: RunnerSettings,
        private readonly registry: HarnessRegistry = createHarnessRegistry(),
        private readonly describe: (preset: HarnessPreset) => HarnessDescriptor = describeHarness
    ) {}

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

        let session: Session;

        // The sink closes over `session`, which is assigned immediately after the
        // harness is built. Construction never reports progress.
        const progress = (event: HarnessEvent) => session?.sink?.(event);

        let harness: Harness;
        try {
            harness = preset.create(settings, progress);
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
            settlers: new Map(),
            disposed: false
        };

        this.sessions.set(session.id, session);
        return this.snapshot(session);
    }

    private require(id: string): Session {
        const session = this.sessions.get(id);
        if (!session) {
            throw new SessionError(404, `Unknown session "${id}".`);
        }

        return session;
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
    // Failure mapping is the caller's job (server/api.ts):
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
            return await session.harness.executeTool(name, parameters);
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
        for (const [name, model] of Object.entries(resolved)) {
            session.harness.agents[name].model(model);
        }

        session.updatedAt = Date.now();
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
    async run(
        id: string,
        rawInput: string,
        emit: Emit,
        options: { signal?: AbortSignal } = {}
    ): Promise<void> {
        const session = this.require(id);

        // A manual tool call holds `busy` too, so chat cannot start while one runs.
        // A non-empty queue also blocks this path: the pump's work was accepted
        // first and must keep FIFO order (see assertRunnable).
        if (session.busy || session.queue.length > 0) {
            throw new SessionError(409, 'A task is already running in this session.');
        }

        const input = validateInput(rawInput);
        const startedAt = Date.now();

        // The turn exists before the harness is called, so the very first progress
        // event already has somewhere to land and the stream can open with it.
        // `index` is assigned here, once: a turn never moves within the session.
        const turn: SessionTurn = {
            id: randomUUID(),
            index: session.turns.length,
            prompt: input,
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

    // QUEUE submit (POST /sessions/:id/tasks): accept the task now, execute later.
    //
    // Validation and the pending cap run BEFORE any mutation, so a 400/413/429
    // leaves the session exactly as it was. The turn gets its stable id and index
    // here — a client can address it as 'queued' immediately — and `startedAt` is
    // deliberately absent until the pump begins it.
    //
    // The returned promise does NOT wait for execution: the 202 body is ready as
    // soon as the turn is enqueued.
    enqueue(id: string, rawInput: string): EnqueuedTask {
        const session = this.require(id);
        const input = validateInput(rawInput);

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

                // A cancelled run keeps recording but stops sending: the stream is gone
                // or the client asked to stop. No progress event is buffered.
                if (controller.signal.aborted) return;

                // LEGACY stream first: a failed write aborts the run (old contract).
                if (legacyEmit !== undefined) {
                    try {
                        // The emitted frame is another copy so a stream listener cannot
                        // mutate the record the snapshot will hand to the next client.
                        // The running tally rides along (when there is one) so a live
                        // tile never has to accumulate usage itself.
                        await legacyEmit({
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
                    await legacyEmit(opening());
                } catch {
                    session.cancelled = true;
                    controller.abort();
                }
            }

            // Watchers get the SAME shape as an upsert (the turn just became running).
            this.publish(session, opening());

            await session.harness(turn.prompt, { signal: controller.signal });
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
            // Release the single-flight gate on success, failure, and cancellation
            // alike: a stuck gate would reject every later chat/reset/manual call
            // and park the queue pump forever.
            session.busy = false;
            session.updatedAt = Date.now();
            turn.updatedAt = session.updatedAt;
            this.releaseBusy(session);
        }

        // One terminal upsert replaces the running row for every watcher, whatever
        // the outcome. Its events array is the complete record (a client can also
        // rely on the event frames it already applied).
        this.publish(session, { type: 'turn', turn: copyTurn(turn) });
        this.settle(turn, session);

        // Legacy terminal frame: `failed` for an error/cancel, `snapshot` on
        // success. Both carry the complete session, so the last frame a response
        // sees is self-sufficient.
        if (legacyEmit === undefined) return;

        if (failure !== undefined) {
            await safeEmit(legacyEmit, {
                type: 'failed',
                error: { message: failure },
                session: this.snapshot(session)
            });
            return;
        }

        await safeEmit(legacyEmit, { type: 'snapshot', session: this.snapshot(session) });
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
            cancelled = true;
        }

        if (options.all !== true) return cancelled;

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

            // With nothing executing, no pump is left to publish the drain
            // snapshot, so send it here. When a turn IS active the pump sends it.
            if (!session.busy && !session.pumping) {
                this.publish(session, { type: 'snapshot', session: this.snapshot(session) });
            }
        }

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
        session.status = 'idle';
        session.cancelled = false;
        session.lastError = undefined;
        session.updatedAt = Date.now();

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

        this.disposeSession(session);
        return this.sessions.delete(id);
    }

    dispose(): void {
        for (const session of this.sessions.values()) {
            this.disposeSession(session);
        }

        this.sessions.clear();
    }

    // Shared teardown for remove()/dispose(): stop execution, drop accepted work,
    // and end every watcher. Idempotent: a second call finds empty collections.
    private disposeSession(session: Session): void {
        // Set BEFORE aborting: the aborted run's terminal publish is then
        // suppressed (the session no longer exists for any client).
        session.disposed = true;

        if (session.status === 'running') {
            session.cancelled = true;
            session.controller?.abort();
        }

        // Discard pending work instead of running it, but release any enqueue()
        // completion so a caller awaiting `settled` does not hang.
        for (const turn of session.queue.splice(0)) {
            this.settle(turn, session);
        }

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
        // waitForIdle() caller.
        this.releaseBusy(session);
        this.releaseDrain(session);
    }
}

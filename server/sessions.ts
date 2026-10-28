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
// SINGLE FLIGHT: every operation that mutates a session's harness is mutually
// exclusive. A streaming run, a manual `callTool` (R8), and a reset all check the
// private `busy` flag and reject with 409 when it is taken. A manual call is NOT a
// turn, so it never changes `status` or appends a SessionTurn; `busy` is released
// in a `finally` on success, failure, and cancellation, so the UI cannot be left
// stuck. cancel() only aborts a streaming run (a manual call has no controller).
//
// Record ownership (H3): the server — not the browser — is the source of truth for
// the renderable transcript. Each submitted task becomes one SessionTurn that owns
// the prompt, status, timestamps, and every HarnessEvent the run produced
// (including events from subagents reached by delegation). `eventTimes` is a
// parallel epoch-ms array, so per-step and per-tool elapsed time survives a
// reload. Snapshots clone the turns, so a client that mutates a response cannot
// corrupt the live record.
//
// Cross-references:
//   - ./protocol.ts — SessionSnapshot.turns, SessionTurn, SessionStreamItem
//   - ./handler.ts  — forwards stream items verbatim; no turn inference there
//   - ../harnesses/registry.ts — the in-memory harness registry
//   - ../harnesses/descriptor.ts — describeHarness, the frozen definition

import { randomUUID } from 'node:crypto';
import type { Harness, HarnessEvent, HarnessMessage } from '../src/harness';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
import { describeHarness } from '../harnesses/descriptor';
import { createHarnessRegistry } from '../harnesses/registry';
import type { HarnessRegistry } from '../harnesses/registry';
import { mergeSettings } from './config';
import type {
    HarnessDescriptor,
    SessionSnapshot,
    SessionStatus,
    SessionStreamItem,
    SessionTurn
} from './protocol';

const MAX_INPUT_LENGTH = 200_000;

type Emit = (item: SessionStreamItem) => void | Promise<void>;

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
    // streaming run AND a manual tool call. Manual calls are not turns, so they
    // cannot use `status` (`running`/`idle`/`error` is what the UI renders);
    // this private flag is what makes them mutually exclusive with a run, a
    // reset, or a second manual call. It is set synchronously before the first
    // await and released in a `finally`, so no path can leave it stuck.
    busy: boolean;
    cancelled: boolean;
    // Every task the session has run, oldest first. Cleared by reset(), removed
    // with the session. This is server state, never rebuildable from messages.
    turns: SessionTurn[];
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
// `eventTimes` is copied when present, preserving the parallel array contract.
const copyTurn = (turn: SessionTurn): SessionTurn => ({
    id: turn.id,
    index: turn.index,
    prompt: turn.prompt,
    status: turn.status,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    events: turn.events.map(copyEvent),
    ...(turn.eventTimes === undefined ? {} : { eventTimes: [...turn.eventTimes] })
});

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
            turns: []
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
    // manual tool call also holds the session without becoming a turn.
    assertRunnable(id: string): void {
        const session = this.require(id);
        if (session.busy) {
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
        if (session.busy) {
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
            // gate here, so a later run/reset/manual call resumes.
            session.busy = false;
        }
    }

    private snapshot(session: Session): SessionSnapshot {
        return {
            id: session.id,
            harness: session.preset.name,
            status: session.status,
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

    async run(id: string, rawInput: string, emit: Emit): Promise<void> {
        const session = this.require(id);

        // Validate everything BEFORE mutating the session. A rejected request
        // (busy, empty, too long) therefore leaves the previous turns untouched,
        // which is what makes the 409 safe for a client to retry on another id.
        // A manual tool call holds `busy` too, so chat cannot start while one runs.
        if (session.busy) {
            throw new SessionError(409, 'A task is already running in this session.');
        }

        const input = rawInput.trim();
        if (input.length === 0) {
            throw new SessionError(400, 'A task cannot be empty.');
        }

        if (input.length > MAX_INPUT_LENGTH) {
            throw new SessionError(413, `A task cannot exceed ${MAX_INPUT_LENGTH} characters.`);
        }

        // Take the single-flight gate BEFORE the first await. Everything below
        // either completes or unwinds through the main `finally`, which releases it.
        session.busy = true;

        const controller = new AbortController();
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
        session.status = 'running';
        session.cancelled = false;
        session.lastError = undefined;
        session.updatedAt = startedAt;
        session.controller = controller;

        session.sink = async (event) => {
            // Record first: the server's turn is authoritative even when the client
            // that opened the stream disappeared (a reload, a cancel by disconnect).
            // `at` is the one server timestamp shared by the frame and the parallel
            // `eventTimes` entry, so a client and a reload agree exactly.
            const record = copyEvent(event);
            const at = Date.now();
            turn.events.push(record);
            turn.eventTimes?.push(at);
            turn.updatedAt = at;

            // A cancelled run keeps recording but stops sending: the stream is gone
            // or the client asked to stop. No progress event is buffered.
            if (controller.signal.aborted) return;

            try {
                // The emitted frame is another copy so a stream listener cannot
                // mutate the record the snapshot will hand to the next client.
                await emit({ type: 'event', turnId: turn.id, event: copyEvent(record), at });
            } catch {
                // The client went away mid-run. Abort the harness instead of
                // letting it keep spending provider time on a dead stream.
                session.cancelled = true;
                controller.abort();
            }
        };

        // Open the turn frame before the harness emits anything, so a client never
        // sees an event it cannot attribute. A failed write means the stream is
        // already gone: abort rather than run for nobody.
        try {
            await emit({ type: 'turn', turn: copyTurn(turn) });
        } catch {
            session.cancelled = true;
            controller.abort();
        }

        let failure: string | undefined;

        try {
            await session.harness(input, { signal: controller.signal });
            session.status = 'idle';
            turn.status = 'done';
        } catch (error) {
            // A cancelled turn is terminal as `cancelled`, even though the session
            // keeps its existing error/lastError contract for the UI banner.
            failure = session.cancelled ? 'The run was cancelled.' : messageOf(error);
            session.status = 'error';
            session.lastError = failure;
            turn.status = session.cancelled ? 'cancelled' : 'error';
        } finally {
            session.sink = undefined;
            session.controller = undefined;
            // Release the single-flight gate on success, failure, and cancellation
            // alike: a stuck gate would reject every later chat/reset/manual call.
            session.busy = false;
            session.updatedAt = Date.now();
            turn.updatedAt = session.updatedAt;
        }

        if (failure !== undefined) {
            await safeEmit(emit, { type: 'failed', error: { message: failure }, session: this.snapshot(session) });
            return;
        }

        await safeEmit(emit, { type: 'snapshot', session: this.snapshot(session) });
    }

    // Cancels a streaming RUN only. A manual tool call has no AbortController and
    // is not a turn, so it is not cancellable here (its request stays open and
    // releases the gate when it settles); returning false is the truthful answer.
    cancel(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session || session.status !== 'running') return false;

        session.cancelled = true;
        session.controller?.abort();
        return true;
    }

    reset(id: string): SessionSnapshot {
        const session = this.require(id);

        // `busy`, not `status`: a manual agentDelegate/toolCreate call holds the
        // session without a turn, and resetting its harness mid-call would clear
        // state the tool is still mutating.
        if (session.busy) {
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

        return this.snapshot(session);
    }

    // Deleting a session never waits for an in-flight operation: a run is
    // aborted, and a manual call is detached but allowed to settle against the
    // removed harness (its result is simply no longer listed). No other session
    // shares that object, so nothing else is affected.
    remove(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session) return false;

        if (session.status === 'running') {
            session.cancelled = true;
            session.controller?.abort();
        }

        return this.sessions.delete(id);
    }

    dispose(): void {
        for (const session of this.sessions.values()) {
            if (session.status === 'running') {
                session.cancelled = true;
                session.controller?.abort();
            }
        }

        this.sessions.clear();
    }
}

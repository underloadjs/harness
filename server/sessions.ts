// In-memory sessions for the harness server.
//
// A session owns exactly one harness instance and its conversation. Submitting a
// task appends to that conversation, so the UI can send another task later and the
// model still sees the earlier transcript. Nothing is persisted: restarting the
// server is a clean slate.
//
// Record ownership (H3): the server — not the browser — is the source of truth for
// the renderable transcript. Each submitted task becomes one SessionTurn that owns
// the prompt, status, timestamps, and every HarnessEvent the run produced
// (including events from subagents reached by delegation). Snapshots clone the
// turns, so a client that mutates a response cannot corrupt the live record and a
// reload can always render the same thing through list()/get().
//
// Cross-references:
//   - ./protocol.ts — SessionSnapshot.turns, SessionTurn, SessionStreamItem
//   - ./handler.ts  — forwards stream items verbatim; no turn inference there

import { randomUUID } from 'node:crypto';
import type { Harness, HarnessEvent, HarnessMessage } from '../src/harness';
import { findPreset, presets } from '../harnesses';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
import { mergeSettings } from './config';
import type { SessionSnapshot, SessionStatus, SessionStreamItem, SessionTurn } from './protocol';

const MAX_INPUT_LENGTH = 200_000;

type Emit = (item: SessionStreamItem) => void | Promise<void>;

type Session = {
    id: string;
    preset: HarnessPreset;
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
const copyTurn = (turn: SessionTurn): SessionTurn => ({
    id: turn.id,
    index: turn.index,
    prompt: turn.prompt,
    status: turn.status,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    events: turn.events.map(copyEvent)
});

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

    // `catalogue` defaults to the shipped presets. It is injectable so tests can
    // run scripted harnesses (including subagents and failures) without reaching a
    // provider; production (`server/index.ts`) passes only the defaults and keeps
    // the real catalogue. The lookup is by name, exactly like findPreset().
    constructor(
        readonly defaults: RunnerSettings,
        private readonly catalogue: readonly HarnessPreset[] = presets
    ) {}

    get size(): number {
        return this.sessions.size;
    }

    create(presetName: string, input?: Partial<RunnerSettings>): SessionSnapshot {
        // Alias-aware: `writer`/`assistant` resolve to `instruct` and
        // `researcher` to `research`, so an older client keeps working. The
        // snapshot reports the canonical preset name below.
        const preset = findPreset(presetName, this.catalogue);
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
            settings,
            harness,
            status: 'idle',
            createdAt: now,
            updatedAt: now,
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
    // JSON status, not an SSE frame.
    assertRunnable(id: string): void {
        const session = this.require(id);
        if (session.status === 'running') {
            throw new SessionError(409, 'A task is already running in this session.');
        }
    }

    private snapshot(session: Session): SessionSnapshot {
        return {
            id: session.id,
            harness: session.preset.name,
            status: session.status,
            model: session.harness.agent.model(),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messages: copyMessages(session.harness.agent.messages),
            turns: copyTurns(session.turns),
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
        if (session.status === 'running') {
            throw new SessionError(409, 'A task is already running in this session.');
        }

        const input = rawInput.trim();
        if (input.length === 0) {
            throw new SessionError(400, 'A task cannot be empty.');
        }

        if (input.length > MAX_INPUT_LENGTH) {
            throw new SessionError(413, `A task cannot exceed ${MAX_INPUT_LENGTH} characters.`);
        }

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
            events: []
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
            const record = copyEvent(event);
            turn.events.push(record);
            turn.updatedAt = Date.now();

            // A cancelled run keeps recording but stops sending: the stream is gone
            // or the client asked to stop. No progress event is buffered.
            if (controller.signal.aborted) return;

            try {
                // The emitted frame is another copy so a stream listener cannot
                // mutate the record the snapshot will hand to the next client.
                await emit({ type: 'event', turnId: turn.id, event: copyEvent(record) });
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
            session.updatedAt = Date.now();
            turn.updatedAt = session.updatedAt;
        }

        if (failure !== undefined) {
            await safeEmit(emit, { type: 'failed', error: { message: failure }, session: this.snapshot(session) });
            return;
        }

        await safeEmit(emit, { type: 'snapshot', session: this.snapshot(session) });
    }

    cancel(id: string): boolean {
        const session = this.sessions.get(id);
        if (!session || session.status !== 'running') return false;

        session.cancelled = true;
        session.controller?.abort();
        return true;
    }

    reset(id: string): SessionSnapshot {
        const session = this.require(id);

        if (session.status === 'running') {
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

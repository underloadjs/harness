// In-memory sessions for the harness server.
//
// A session owns exactly one harness instance and its conversation. Submitting a
// task appends to that conversation, so the UI can send another task later and the
// model still sees the earlier transcript. Nothing is persisted: restarting the
// server is a clean slate.

import { randomUUID } from 'node:crypto';
import type { Harness, HarnessEvent, HarnessMessage } from '../src/harness';
import { findPreset } from '../harnesses';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
import { mergeSettings } from './config';
import type { SessionSnapshot, SessionStatus, SessionStreamItem } from './protocol';

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

    constructor(readonly defaults: RunnerSettings) {}

    get size(): number {
        return this.sessions.size;
    }

    create(presetName: string, input?: Partial<RunnerSettings>): SessionSnapshot {
        const preset = findPreset(presetName);
        if (!preset) {
            throw new SessionError(404, `Unknown harness "${presetName}".`);
        }

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
            cancelled: false
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

        session.status = 'running';
        session.cancelled = false;
        session.lastError = undefined;
        session.updatedAt = Date.now();
        session.controller = controller;
        session.sink = async (event) => {
            if (controller.signal.aborted) return;

            try {
                await emit({ type: 'event', event });
            } catch {
                // The client went away mid-run. Abort the harness instead of
                // letting it keep spending provider time on a dead stream.
                session.cancelled = true;
                controller.abort();
            }
        };

        let failure: string | undefined;

        try {
            await session.harness(input, { signal: controller.signal });
            session.status = 'idle';
        } catch (error) {
            failure = session.cancelled ? 'The run was cancelled.' : messageOf(error);
            session.status = 'error';
            session.lastError = failure;
        } finally {
            session.sink = undefined;
            session.controller = undefined;
            session.updatedAt = Date.now();
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

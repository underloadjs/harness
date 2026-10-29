// Durable harness database (R3b).
//
// WHAT IS PERSISTED
// -----------------
// One versioned JSON document under `<databaseRoot>/harness/state.json`:
//
//   - `registry` — the metadata of every harness entry the in-memory registry
//     holds (shipped copies and user-created ones). Factories are NOT serialized;
//     ./harnesses/registry.ts rebuilds them from the metadata with the same
//     template rules the original create/patch used.
//   - `sessions` — per-session identity, the FROZEN preset metadata and
//     descriptor the session was created with (a later registry patch cannot
//     change what an old session must rebuild), provider settings WITHOUT the
//     API key, timestamps/status/error, every turn (events/times/usage), the
//     pending queue order, and the last committed core snapshot.
//
// SECRETS ARE NEVER WRITTEN. `RunnerSettings.apiKey` is deliberately absent from
// the session settings record; restore re-resolves the key through
// mergeSettings(server defaults, { baseURL, model }), so the configured provider
// key is used when the stored base URL is that provider and a foreign base URL
// resumes unauthenticated instead of carrying a stolen credential. Arbitrary user
// content (prompts, tool results, created-tool source) CAN contain secrets the
// user typed; that is the user's own transcript and is stored as-is.
//
// ATOMIC WRITE
// ------------
// The whole document is one commit unit: write the full JSON to a sibling staging
// file (`state.json.<pid>.<n>.tmp`), fsync it, then rename over `state.json`.
// The canonical file is never unlinked first, so a crash leaves either the old
// complete document or the new complete document. Writes are synchronous, which
// also makes them serialized: there is no second writer in this process and no
// cross-process multi-writer support (one server process per database root).
//
// FAILURE POLICY
// --------------
// An unknown version, malformed JSON, or a structurally invalid document throws
// HarnessPersistenceError naming the file. Nothing is reset or deleted: a silent
// clean slate would let a corrupt file masquerade as "no sessions".
//
// Cross-references:
//   - ./sessions.ts              — builds/consumes these records, recovery policy
//   - ./harnesses/registry.ts    — presetToRecord / presetFromRecord / registry restore
//   - ../types/index.ts          — HarnessSnapshot schema (restore validates it)
//   - ./runtime.ts, ./start.ts   — root resolution and startup wiring

import fs from 'node:fs';
import path from 'node:path';
import type {
    HarnessAgentSnapshot,
    HarnessMessage,
    HarnessSnapshot
} from '../harness';
import type { HarnessDescriptor, SessionStatus, SessionTurn } from './protocol';
import { validateAttachments } from '../shared/attachments';
import { readAgentResultReferenceList } from '../shared/agent-results';

// Bumped only when the on-disk document becomes incompatible. The core snapshot
// carries its own version (HARNESS_SNAPSHOT_VERSION); this one gates the
// server-owned envelope. A mismatch is an error, never a migration guess.
export const HARNESS_DATABASE_VERSION = 1;

// Namespace below the supplied database root. The service passes DATABASE_ROOT
// (a shared storage boundary used by other distributions), so this package owns
// exactly one child directory and never writes at the root itself.
export const HARNESS_DATABASE_DIRECTORY = 'harness';
export const HARNESS_DATABASE_FILE = 'state.json';

// Serializable view of one registry entry (HarnessPreset minus `create`).
// `template`/`live` are internal replay hints; they are stored so a restart can
// reproduce the same factory kind instead of silently promoting the scripted demo
// to a live harness (or losing flaky's extra tool).
export type HarnessPresetRecord = {
    name: string;
    title: string;
    description: string;
    requiresEndpoint: boolean;
    primary: string;
    subagents: string[];
    agents: string[];
    tools: string[];
    environmentTools?: string[];
    agentModels?: Record<string, string>;
    builtin: boolean;
    editable: boolean;
    template?: 'live' | 'scripted' | 'flaky';
    live?: { title: string; description: string };
};

// Provider settings MINUS the credential. Only these two fields are durable:
// `model` is the session's fallback model, `baseURL` decides whether the
// environment key may be re-attached on restore (see the file header).
export type HarnessSessionSettingsRecord = {
    baseURL: string;
    model: string;
};

// One restorable session. `preset` is a frozen copy of the creation-time preset
// metadata, so restoring does not depend on the live registry still matching.
export type HarnessSessionRecord = {
    id: string;
    // Preset name as the session reported it (`SessionSnapshot.harness`).
    harness: string;
    preset: HarnessPresetRecord;
    // Frozen descriptor the session reports (`harnessDefinition`).
    definition: HarnessDescriptor;
    settings: HarnessSessionSettingsRecord;
    status: SessionStatus;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
    turns: SessionTurn[];
    // IDs of the pending (queued) turns, in FIFO order. References into `turns`.
    queue: string[];
    // Last committed core snapshot. Core permits a synchronous snapshot at each
    // mutation boundary, so an active turn's completed tool/store changes are
    // included as they happen. A tool that is still executing when the process
    // dies has not reached a boundary; the turn is restored as interrupted and is
    // never replayed (see ./sessions.ts).
    core: HarnessSnapshot;
    // Live per-agent models, recorded beside the snapshot so a PATCH accepted
    // during a run (where snapshot() refuses) still survives a restart.
    agentModels?: Record<string, string>;
};

export type HarnessDatabase = {
    version: typeof HARNESS_DATABASE_VERSION;
    savedAt: number;
    registry: HarnessPresetRecord[];
    sessions: HarnessSessionRecord[];
};

// A failure to read or write the database. Carries the absolute file path so an
// operator can find the file without guessing. The dispatcher maps an unwrapped
// error to a 500 with this message; nothing is swallowed.
export class HarnessPersistenceError extends Error {
    constructor(
        readonly file: string,
        message: string
    ) {
        // The path is part of the MESSAGE (not just a property) so an operator or
        // a 500 response can act on it without inspecting the error object.
        super(file.length > 0 ? `${file}: ${message}` : message);
        this.name = 'HarnessPersistenceError';
    }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Absolute root + namespace. `path.resolve` makes two spellings of the same
// directory ("db/../db", a relative path from a different cwd) share one key.
export const resolveHarnessDatabaseRoot = (root: string): string => path.resolve(root);

// Validate a supplied root. `undefined`/`null` means "no database" (in-memory);
// anything else must be a non-empty string, so a bad service `variables.root` is
// a loud error rather than a silently in-memory server.
export const normalizeHarnessDatabaseRoot = (
    value: string | null | undefined
): string | undefined => {
    if (value === undefined || value === null) return undefined;

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HarnessPersistenceError(
            '',
            'A harness database root must be a non-empty string when provided.'
        );
    }

    return resolveHarnessDatabaseRoot(value);
};

// Structural validation helpers. The document is written by this package, so a
// shape failure means corruption or a hand edit; report the offending path.
const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }

    return value as Record<string, unknown>;
};

const requireString = (value: unknown, label: string): string => {
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
    return value;
};

const requireBoolean = (value: unknown, label: string): boolean => {
    if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
    return value;
};

const requireNumber = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
    }

    return value;
};

const requireStringArray = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new TypeError(`${label} must be an array of strings.`);
    }

    return [...(value as string[])];
};

// Frozen descriptor (`SessionSnapshot.harnessDefinition`). Validate the fields a
// restored session and the UI rely on; agentModels/coreTools are optional.
const readDescriptor = (value: unknown, label: string): HarnessDescriptor => {
    const record = requireRecord(value, label);
    const agentModels =
        record.agentModels === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.agentModels, `${label}.agentModels`);
                  const mapped: Record<string, string> = {};

                  for (const [agent, model] of Object.entries(entry)) {
                      mapped[agent] = requireString(model, `${label}.agentModels.${agent}`);
                  }

                  return mapped;
              })();

    return {
        name: requireString(record.name, `${label}.name`),
        title: requireString(record.title, `${label}.title`),
        description: requireString(record.description, `${label}.description`),
        requiresEndpoint: requireBoolean(record.requiresEndpoint, `${label}.requiresEndpoint`),
        primary: requireString(record.primary, `${label}.primary`),
        subagents: requireStringArray(record.subagents, `${label}.subagents`),
        agents: requireStringArray(record.agents, `${label}.agents`),
        tools: requireStringArray(record.tools, `${label}.tools`),
        ...(record.coreTools === undefined
            ? {}
            : { coreTools: requireStringArray(record.coreTools, `${label}.coreTools`) }),
        ...(agentModels === undefined ? {} : { agentModels }),
        builtin: requireBoolean(record.builtin, `${label}.builtin`),
        editable: requireBoolean(record.editable, `${label}.editable`)
    };
};

const readPresetRecord = (value: unknown, label: string): HarnessPresetRecord => {
    const record = requireRecord(value, label);
    const template = record.template;

    if (template !== undefined && template !== 'live' && template !== 'scripted' && template !== 'flaky') {
        throw new TypeError(`${label}.template must be "live", "scripted" or "flaky" when present.`);
    }

    const live =
        record.live === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.live, `${label}.live`);
                  return {
                      title: requireString(entry.title, `${label}.live.title`),
                      description: requireString(entry.description, `${label}.live.description`)
                  };
              })();

    const agentModels =
        record.agentModels === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.agentModels, `${label}.agentModels`);
                  const mapped: Record<string, string> = {};

                  for (const [agent, model] of Object.entries(entry)) {
                      mapped[agent] = requireString(model, `${label}.agentModels.${agent}`);
                  }

                  return mapped;
              })();

    return {
        name: requireString(record.name, `${label}.name`),
        title: requireString(record.title, `${label}.title`),
        description: requireString(record.description, `${label}.description`),
        requiresEndpoint: requireBoolean(record.requiresEndpoint, `${label}.requiresEndpoint`),
        primary: requireString(record.primary, `${label}.primary`),
        subagents: requireStringArray(record.subagents, `${label}.subagents`),
        agents: requireStringArray(record.agents, `${label}.agents`),
        tools: requireStringArray(record.tools, `${label}.tools`),
        ...(record.environmentTools === undefined
            ? {}
            : { environmentTools: requireStringArray(record.environmentTools, `${label}.environmentTools`) }),
        ...(agentModels === undefined ? {} : { agentModels }),
        builtin: requireBoolean(record.builtin, `${label}.builtin`),
        editable: requireBoolean(record.editable, `${label}.editable`),
        ...(template === undefined ? {} : { template }),
        ...(live === undefined ? {} : { live })
    };
};

// Turn/event payloads are user content; the server owns their shape but the
// events themselves are plain JSON forwarded from tools. Validate the fields the
// store and UI rely on, and leave the event objects opaque.
const readTurn = (value: unknown, label: string): SessionTurn => {
    const record = requireRecord(value, label);
    const status = requireString(record.status, `${label}.status`);

    if (!['queued', 'running', 'done', 'error', 'cancelled'].includes(status)) {
        throw new TypeError(`${label}.status is not a known turn status.`);
    }

    if (!Array.isArray(record.events)) throw new TypeError(`${label}.events must be an array.`);

    const eventTimes =
        record.eventTimes === undefined
            ? undefined
            : (() => {
                  if (!Array.isArray(record.eventTimes)) {
                      throw new TypeError(`${label}.eventTimes must be an array.`);
                  }

                  return record.eventTimes.map((entry, index) =>
                      requireNumber(entry, `${label}.eventTimes[${index}]`)
                  );
              })();

    const usage =
        record.usage === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.usage, `${label}.usage`);
                  return {
                      input: requireNumber(entry.input, `${label}.usage.input`),
                      output: requireNumber(entry.output, `${label}.usage.output`),
                      total: requireNumber(entry.total, `${label}.usage.total`),
                      ...(entry.cached === undefined
                          ? {}
                          : { cached: requireNumber(entry.cached, `${label}.usage.cached`) })
                  };
              })();

    // Composer attachments (T3) are OPTIONAL. Re-run the shared validator on load
    // for the same reason the core re-validates persisted user messages: a
    // corrupted/foreign document must fail loudly instead of restoring bytes whose
    // size/MIME/signature no longer holds. `undefined` means a pre-attachment
    // record and is preserved as an absent key (exact old shape).
    const attachments =
        record.attachments === undefined
            ? undefined
            : (() => {
                  try {
                      // The validator detaches copies, so the restored record never
                      // aliases the parsed document.
                      return validateAttachments(record.attachments);
                  } catch (error) {
                      throw new TypeError(
                          `${label}.attachments is invalid: ${error instanceof Error ? error.message : String(error)}`
                      );
                  }
              })();

    // Result references (R2) are OPTIONAL and validated structurally by the shared
    // reader: a malformed persisted reference must fail the load rather than
    // restore a task whose lookup would later miss. The labels are normalised to
    // the allocator's uppercase form; an absent key stays absent.
    const references =
        record.references === undefined
            ? undefined
            : (() => {
                  try {
                      return readAgentResultReferenceList(record.references, `${label}.references`);
                  } catch (error) {
                      throw new TypeError(
                          `${label}.references is invalid: ${error instanceof Error ? error.message : String(error)}`
                      );
                  }
              })();

    return {
        id: requireString(record.id, `${label}.id`),
        index: requireNumber(record.index, `${label}.index`),
        prompt: requireString(record.prompt, `${label}.prompt`),
        ...(references === undefined ? {} : { references }),
        ...(attachments === undefined ? {} : { attachments }),
        status: status as SessionTurn['status'],
        ...(record.startedAt === undefined
            ? {}
            : { startedAt: requireNumber(record.startedAt, `${label}.startedAt`) }),
        updatedAt: requireNumber(record.updatedAt, `${label}.updatedAt`),
        events: record.events as SessionTurn['events'],
        ...(eventTimes === undefined ? {} : { eventTimes }),
        ...(usage === undefined ? {} : { usage })
    };
};

const readSessionRecord = (value: unknown, label: string): HarnessSessionRecord => {
    const record = requireRecord(value, label);
    const settings = requireRecord(record.settings, `${label}.settings`);

    // Reject a persisted apiKey outright: it would mean an older/foreign writer
    // stored a credential, and silently dropping it would hide that defect.
    if (Object.prototype.hasOwnProperty.call(settings, 'apiKey')) {
        throw new TypeError(`${label}.settings must not contain an API key.`);
    }

    const turns = (() => {
        if (!Array.isArray(record.turns)) throw new TypeError(`${label}.turns must be an array.`);
        return record.turns.map((turn, index) => readTurn(turn, `${label}.turns[${index}]`));
    })();

    const status = requireString(record.status, `${label}.status`);
    if (!['idle', 'running', 'error'].includes(status)) {
        throw new TypeError(`${label}.status is not a known session status.`);
    }

    const lastError =
        record.lastError === undefined ? undefined : requireString(record.lastError, `${label}.lastError`);

    const queue = requireStringArray(record.queue, `${label}.queue`);

    // Every queued id must reference a queued turn in this session: a dangling
    // queue entry would make the restored queueDepth lie about runnable work.
    const byId = new Map(turns.map((turn) => [turn.id, turn]));

    for (const id of queue) {
        const turn = byId.get(id);
        if (turn === undefined) {
            throw new TypeError(`${label}.queue names turn "${id}", which is not in this session.`);
        }

        if (turn.status !== 'queued') {
            throw new TypeError(`${label}.queue names turn "${id}", which is not queued.`);
        }
    }

    const core = requireRecord(record.core, `${label}.core`);
    requireNumber(core.version, `${label}.core.version`);

    const agentModels =
        record.agentModels === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.agentModels, `${label}.agentModels`);
                  const mapped: Record<string, string> = {};

                  for (const [agent, model] of Object.entries(entry)) {
                      mapped[agent] = requireString(model, `${label}.agentModels.${agent}`);
                  }

                  return mapped;
              })();

    return {
        id: requireString(record.id, `${label}.id`),
        harness: requireString(record.harness, `${label}.harness`),
        preset: readPresetRecord(record.preset, `${label}.preset`),
        definition: readDescriptor(record.definition, `${label}.definition`),
        settings: {
            baseURL: requireString(settings.baseURL, `${label}.settings.baseURL`),
            model: requireString(settings.model, `${label}.settings.model`)
        },
        status: status as SessionStatus,
        createdAt: requireNumber(record.createdAt, `${label}.createdAt`),
        updatedAt: requireNumber(record.updatedAt, `${label}.updatedAt`),
        ...(lastError === undefined ? {} : { lastError }),
        turns,
        queue,
        core: core as unknown as HarnessSnapshot,
        ...(agentModels === undefined ? {} : { agentModels })
    };
};

// Validate a parsed document. Version first: a future/older document must not be
// interpreted with today's field meanings.
export const readHarnessDatabase = (value: unknown): HarnessDatabase => {
    const record = requireRecord(value, 'The harness database');
    const version = requireNumber(record.version, 'The harness database version');

    if (version !== HARNESS_DATABASE_VERSION) {
        throw new TypeError(
            `Unsupported harness database version ${version}; this server reads version ${HARNESS_DATABASE_VERSION}.`
        );
    }

    if (!Array.isArray(record.registry)) {
        throw new TypeError('The harness database registry must be an array.');
    }

    if (!Array.isArray(record.sessions)) {
        throw new TypeError('The harness database sessions must be an array.');
    }

    const registry = record.registry.map((entry, index) => readPresetRecord(entry, `registry[${index}]`));
    const sessions = record.sessions.map((entry, index) => readSessionRecord(entry, `sessions[${index}]`));

    // Duplicate ids would make the Map silently keep only one session.
    const ids = new Set<string>();
    for (const session of sessions) {
        if (ids.has(session.id)) {
            throw new TypeError(`The harness database lists session "${session.id}" more than once.`);
        }

        ids.add(session.id);
    }

    return {
        version: HARNESS_DATABASE_VERSION,
        savedAt: requireNumber(record.savedAt, 'The harness database savedAt'),
        registry,
        sessions
    };
};

// ---------------------------------------------------------------------------
// Interrupted-turn transcript repair (T25/T26)
// ---------------------------------------------------------------------------
//
// A mutation-boundary snapshot taken after an assistant message commits — but
// before its tools have all appended results — is schema-valid (`readHarnessMessages`
// only checks entry shapes) yet UNMATCHED for a strict provider: every
// `toolCalls[].id` must be followed by a `role:'tool'` message carrying that
// `toolCallId`. Restoring such a snapshot and sending the next prompt would make
// an OpenAI-compatible endpoint reject the transcript.
//
// The recovery policy is the user-approved one: never execute a tool again, never
// trim completed evidence. For each assistant message, keep every contiguous tool
// result that is already there (matched or not) and append ONE explicit
// non-success synthetic result for each call id that has no result yet. The
// synthetic text says the server restarted, so neither the model nor a reader can
// mistake it for a successful result.
//
// Applied to the PERSISTED snapshot before `harness.restore()`; it is pure and
// idempotent (a repaired transcript has every id answered, so a second call
// returns the same value). It never touches records, discovery, or created tools.
export const INTERRUPTED_TOOL_RESULT_TEXT =
    'The server restarted before this tool call completed. The call was interrupted and has NOT been executed since; no result is available.';

// Rebuild one agent transcript only when a result is actually missing; an
// already-coherent transcript is returned by identity.
const repairAgentMessages = (messages: readonly HarnessMessage[]): readonly HarnessMessage[] => {
    const output: HarnessMessage[] = [];
    let changed = false;

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        output.push(message);

        // Only an assistant message can own tool calls.
        if (message.role !== 'assistant') continue;

        const calls = message.toolCalls;

        if (calls === undefined || calls.length === 0) continue;

        const wanted = new Set(calls.map((call) => call.id));
        const answered = new Set<string>();

        // Consume the contiguous tool-result block that follows this message.
        // Unknown/extra tool messages are preserved verbatim: they are evidence,
        // not something to discard while repairing.
        let cursor = index + 1;

        while (cursor < messages.length) {
            const result = messages[cursor];
            if (result.role !== 'tool') break;

            output.push(result);
            if (wanted.has(result.toolCallId)) answered.add(result.toolCallId);
            cursor++;
        }

        // Append missing results in call order, immediately after the existing
        // block so the provider sees one coherent assistant→tool(s) exchange.
        for (const call of calls) {
            if (answered.has(call.id)) continue;

            changed = true;
            output.push({
                role: 'tool',
                content: INTERRUPTED_TOOL_RESULT_TEXT,
                toolCallId: call.id,
                name: call.name
            });
        }

        // Continue after the block we just consumed (the loop increment moves to
        // the next message).
        index = cursor - 1;
    }

    return changed ? output : messages;
};

// Return a snapshot whose agent transcripts are safe to resume, or the SAME
// snapshot object when nothing was missing.
export const repairInterruptedToolCalls = (snapshot: HarnessSnapshot): HarnessSnapshot => {
    let changed = false;
    const agents: Record<string, HarnessAgentSnapshot> = {};

    for (const [name, agent] of Object.entries(snapshot.agents)) {
        const messages = repairAgentMessages(agent.messages);

        if (messages === agent.messages) {
            agents[name] = agent;
            continue;
        }

        changed = true;
        agents[name] = { ...agent, messages: [...messages] };
    }

    return changed ? { ...snapshot, agents } : snapshot;
};

// Durable document owner for one resolved root.
export class HarnessPersistence {
    readonly directory: string;
    readonly file: string;

    // Post-increment staging suffix: unique per process and write, so a stale
    // staging file from a crashed write is never reused.
    private sequence = 0;
    private lastError: string | undefined;

    constructor(root: string) {
        if (typeof root !== 'string' || root.trim().length === 0) {
            throw new HarnessPersistenceError('', 'A harness database root must be a non-empty string.');
        }

        this.directory = path.join(resolveHarnessDatabaseRoot(root), HARNESS_DATABASE_DIRECTORY);
        this.file = path.join(this.directory, HARNESS_DATABASE_FILE);
    }

    // Last write failure, observable even from a background transition where a
    // throw would change a run's outcome. Cleared by the next successful save.
    get lastWriteError(): string | undefined {
        return this.lastError;
    }

    // Read the document, if any. ENOENT means "first run"; every other failure —
    // including malformed JSON — throws instead of returning an empty database.
    load(): HarnessDatabase | undefined {
        let text: string;

        try {
            text = fs.readFileSync(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;

            throw new HarnessPersistenceError(
                this.file,
                `Could not read the harness database: ${messageOf(error)}`
            );
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new HarnessPersistenceError(
                this.file,
                `The harness database is not valid JSON: ${messageOf(error)}`
            );
        }

        try {
            return readHarnessDatabase(parsed);
        } catch (error) {
            throw new HarnessPersistenceError(
                this.file,
                `The harness database has an invalid shape or version: ${messageOf(error)}`
            );
        }
    }

    // Atomic full-document commit. Synchronous by design: it serializes writers,
    // and every structural API mutation can be durable before it returns.
    save(database: HarnessDatabase): void {
        const payload = JSON.stringify(
            { ...database, version: HARNESS_DATABASE_VERSION, savedAt: Date.now() },
            null,
            2
        );

        try {
            fs.mkdirSync(this.directory, { recursive: true });
        } catch (error) {
            this.lastError = messageOf(error);

            throw new HarnessPersistenceError(
                this.file,
                `Could not create the harness database directory: ${messageOf(error)}`
            );
        }

        const staging = path.join(
            this.directory,
            `${HARNESS_DATABASE_FILE}.${process.pid}.${this.sequence++}.tmp`
        );

        let handle: number | undefined;

        try {
            handle = fs.openSync(staging, 'w');
            fs.writeFileSync(handle, payload, 'utf8');
            // fsync before rename: the rename may be durable while the bytes are
            // not, which would publish an empty/truncated canonical file.
            fs.fsyncSync(handle);
            fs.closeSync(handle);
            handle = undefined;

            // Same-directory rename: atomic on the platforms this server targets.
            // The canonical file is never unlinked first, so a crash preserves the
            // previous complete document.
            fs.renameSync(staging, this.file);
            this.lastError = undefined;
        } catch (error) {
            if (handle !== undefined) {
                try {
                    fs.closeSync(handle);
                } catch {
                    // The handle is already unusable; the original error matters.
                }
            }

            // A partial staging file is not a commit: remove it so a later run
            // cannot confuse it with a real document (the canonical file is kept).
            try {
                fs.rmSync(staging, { force: true });
            } catch {
                // Best effort; the write error below is the actionable failure.
            }

            this.lastError = messageOf(error);

            throw new HarnessPersistenceError(
                this.file,
                `Could not write the harness database: ${messageOf(error)}`
            );
        }
    }
}

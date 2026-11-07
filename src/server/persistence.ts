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
//   - `deleted` (T5, optional) — the names of shipped built-ins the operator
//     deleted. The registry array cannot express this: it is written from
//     `list()`, while a fresh registry always re-seeds the shipped templates.
//   - `globalSettings` (T16, optional) — the operator's global provider defaults.
//   - `pluginSettings` (T5/R2-R3, optional) — the operator's per-plugin setting
//     OVERRIDES, plugin name -> key -> value. Only what changed is stored: a
//     plugin's declared default lives in its own `*.plugin.ts` metadata, so a
//     release that changes a default needs no migration here.
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
// R1 (worker IO mode): the identical commit is ALSO executable on the IO worker thread,
// through the exported primitives below (`serializeHarnessDatabase` +
// `writeHarnessDatabaseFile`), so a checkpoint's stringify and its syscalls need not block
// the coordinator's event loop. One writer of record per root still holds: an io client
// (./workers/io-client.ts) funnels EVERY write through one FIFO queue, and the staging name
// carries the writer's identity (`<pid>` on the coordinator, `<pid>.io<threadId>` on the
// worker — see `HarnessDatabaseWriteOptions.owner`) so a worker staging file can never
// collide with a coordinator one. There is still no second PROCESS and no parallel writer.
//
// WIRING STATUS (honest, updated 2026-11-04): the store now opens an io client whenever the
// resolved runtime says `ioExecution: 'worker'` (./sessions.ts constructor, D4), and the build
// emits the entry - `vite.config.ts` has an `io-worker` library entry, so
// `dist/underload-harness.io-worker.mjs` and the `@underload/harness/io-worker` subpath exist in
// a build (./src/structure.test.ts pins the pairing, ./../../scripts/check-package-runtime.mjs
// spawns the shipped bundle and reads its bytes back). In that mode the primitives below run on
// the worker thread and the coordinator never blocks on them: a strict save resolves after the
// worker's rename receipt, a best-effort/observer checkpoint claims queue ORDER only, and journal
// events are appended by the thread that holds the fd.
//
// With the default `ioExecution: 'inline'` nothing above applies: this class remains the only
// writer, exactly as before. `threadExecution: 'worker'` (../config.ts) is the SEPARATE promise
// that isolates each logical THREAD'S CPU (./workers/lane-host.ts); the two flags are
// independent, and each fails loudly when the platform cannot honour it: an io client that
// cannot find an entry throws a named `HarnessIoError` (`worker-entry-missing`) with the exact
// fix, and a store that throws at construction aborts startup rather than serving inline.
//
// FAILURE POLICY
// --------------
// An unknown version, malformed JSON, or a structurally invalid document throws
// HarnessPersistenceError naming the file. Nothing is reset or deleted: a silent
// clean slate would let a corrupt file masquerade as "no sessions". A write that
// fails throws on the inline path and produces a failed reply on the worker path;
// neither mode reports success for a document that is not durable.
//
// Cross-references:
//   - ./sessions.ts              — builds/consumes these records, recovery policy
//   - ./workers/io-worker.ts     — the same commit, executed off the main thread
//   - ./workers/io-client.ts     — the coordinator-side queue and durability barrier
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
import { agentLabelParts, readAgentResultReferenceList } from '../shared/agent-results';
// The durable per-turn instruction snapshot (see
// `HarnessSessionRecord.turnInstructionSources` below) reuses the SHARED display
// contract type, so the value written to disk, the value the projector reads back, and
// the `system` context block it produces are one definition, not three shapes that have
// to agree.
import type { TurnInstructionSource } from '../shared/turn-display';

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
    // Per-agent instruction overrides (T3 editable configuration). Optional and
    // additive: a document without the field restores exactly as before.
    agentInstructions?: Record<string, string>;
    // Per-agent identity colors (R2 display configuration). Optional and additive:
    // a document without the field restores exactly as before, and the loader reads it
    // with the same `readStringMap` shape as the two maps above. Like them it is part
    // of the executable definition the factory is rebuilt from (the map is captured by
    // the closure), so a saved swatch survives a restart instead of reverting to the
    // host's derived color.
    agentColors?: Record<string, string>;
    // SESSION-DEFINED agents (R7): agent id → the base instruction that agent runs. Optional
    // and additive: a document without the field restores exactly as before, and the loader
    // reads it with the same `readStringMap` shape as the three override maps above. Like them
    // it is part of the executable definition the factory is rebuilt from (the map is captured
    // by the closure, and `agentsFromProfiles` consults it before any catalogue lookup), so an
    // agent a session invented survives a restart instead of dropping out of the roster.
    //
    // A harness DEFINITION never writes this field — the registry's create/PATCH surface has no
    // custom-agent input — so in practice it appears only inside a saved session's own
    // `preset` copy (see ./sessions.ts `applyBindingMaps`).
    customAgents?: Record<string, string>;
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

// C4: one persisted unreadable transcript (see `HarnessSessionRecord.invalidThreads`).
// Additive and OPTIONAL: a document written before the transcript editor loads
// exactly as it did, and a session that never had a broken transcript never
// writes this shape at all.
export type HarnessInvalidThreadRecord = {
    // The validation message that refused `messages` (`readHarnessMessages`).
    error: string;
    // The transcript EXACTLY as submitted/stored: opaque, never normalised, so a
    // restart shows the user the same text they are trying to fix.
    messages: unknown;
    // Display hints copied from the thread record when it was recorded. Both are
    // optional because a hand-edited thread may carry neither.
    label?: string;
    agent?: string;
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
    // T16 (ADDITIVE): the session's display title. `SessionSummary.title` /
    // `UpdateSessionRequest.title` are contract-visible, so the field is durable: a rail that
    // names a conversation must still name it after a restart. Absent means "no title" (every
    // pre-T16 document), and it is preserved as absent on a round trip.
    title?: string;
    status: SessionStatus;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
    turns: SessionTurn[];
    // IDs of the pending (queued) turns, in FIFO order. References into `turns`.
    queue: string[];
    // R1-R6: the next turn INDEX high-water mark. Turn indices are monotonic and
    // never reused, so deleting a thread (and its turns) cannot renumber the
    // survivors. Absent in a pre-thread document; the loader then derives it from
    // the recorded turns (old files stay readable).
    threadSequence?: number;
    // Conversation-scoped result-block label counters AT THE START of each turn,
    // keyed by turn id. Persisted so a deletion cannot renumber surviving labels
    // (see shared/agent-results.ts). Absent for a pre-thread document.
    labelSeeds?: Record<string, Record<string, number>>;
    // Highest label occurrence ever minted per code (tombstone high-water). Kept
    // when turns are deleted so a retired textual label is never re-minted for
    // different content — including after every turn carrying it is gone.
    //
    // T14: this is ONE of the two mirrored views of the single canonical label
    // sequence (the other is `threadLabelHighWater`): every mint — a conversation
    // name, a legacy `/messages` block or a nested block — raises BOTH, so a
    // document that lost one map can still recover the ordinals from the other.
    labelHighWater?: Record<string, number>;
    // R8: stable agent-prefixed conversation labels by thread id, plus the
    // per-code high-water that keeps a deleted conversation's name retired.
    threadLabels?: Record<string, string>;
    threadLabelHighWater?: Record<string, number>;
    // Invocation id recorded by each THREAD turn's root run, keyed by turn id.
    // This is the join the snapshot roster exposes as originInvocationId; it lives
    // beside the turns so a restart keeps the mapping.
    turnInvocations?: Record<string, string>;
    // T9 (ADDITIVE, declared with the display contract; the store writes and reads it
    // in the projector pass): the system-instruction text each turn's agents ACTUALLY
    // ran with, keyed by turn id, one entry per agent (`TurnInstructionSource`).
    //
    // Why it has to be durable here rather than derived on read: the context bar's
    // `system` block counts the instruction characters (R6), and the only other places
    // that text exists are live (`Agent.instructions`) or the CURRENT snapshot
    // transcript — both of which move when an instruction is edited or a transcript is
    // rewritten. Freezing the source with the turn is what keeps a recorded count from
    // silently changing under a restart, and it is what lets the block detail route
    // answer with the exact bytes a historical turn ran with.
    //
    // Optional by design: absent means no recorded source (every document written
    // before T9), and the fold then emits NO system block for that agent — the loader
    // must never reconstruct one from the live catalogue.
    turnInstructionSources?: Record<string, TurnInstructionSource[]>;
    // Every invocation observed in a persistent conversation (invocation id → thread
    // id). Needed so a delete after a restart purges exactly the agent-result records
    // the runtime removes — including a child conversation's EARLIER runs, which its
    // single `invocationId` slot no longer names.
    invocationThreads?: Record<string, string>;
    // C4 (ADDITIVE): conversations whose stored transcript could not be read,
    // keyed by thread id. The thread itself is persisted inside `core` with a
    // valid PLACEHOLDER transcript; only the raw, unreadable value lives here, so
    // a broken transcript survives a restart instead of being silently repaired
    // and forgotten. `messages` is opaque by design (it is exactly what
    // `readHarnessMessages` refused), `error` is the refusal text, and
    // `label`/`agent` are the display hints captured when it was recorded.
    invalidThreads?: Record<string, HarnessInvalidThreadRecord>;
    // Last committed core snapshot. Core permits a synchronous snapshot at each
    // mutation boundary, so an active turn's completed tool/store changes are
    // included as they happen. A tool that is still executing when the process
    // dies has not reached a boundary; the turn is restored as interrupted and is
    // never replayed (see ./sessions.ts).
    core: HarnessSnapshot;
    // Live per-agent models, recorded beside the snapshot so a PATCH accepted
    // during a run (where snapshot() refuses) still survives a restart.
    agentModels?: Record<string, string>;
    // T27 (ADDITIVE): the agents BOUND AT SESSION SCOPE by `POST /sessions/{id}/agents`,
    // as opposed to the members the harness definition shipped with. Membership itself is
    // already durable inside `preset`/`definition` (both are the session's own frozen
    // copies, and the runtime roster is rebuilt from them); this list carries only the
    // provenance the contract exposes as `SessionAgentBinding.origin`. Absent means "no
    // session-scoped binding" (every pre-T27 document) and stays absent on a round trip.
    // Values are trimmed and de-duplicated, because the roster budget is a bound on REAL
    // members and a duplicate entry would report one binding twice.
    sessionAgents?: string[];
};

// T16: the persisted shape of the operator's global provider defaults. Deliberately
// credential-free: the secret rule for `state.json` is that no api key is ever written into it,
// so a key set over HTTP lives in the process only and a restart falls back to the environment.
export type HarnessGlobalSettingsRecord = {
    baseURL: string;
    model: string;
};

// T5 (R2/R3): the persisted shape of the operator's PLUGIN setting overrides,
// plugin name -> setting key -> value.
//
// ONLY overrides, never defaults: each built-in plugin declares its own default in its own
// `*.plugin.ts` metadata (src/plugin/manifest.ts is generated from it), so a release that
// moves a default moves it for every deployment with no migration in this file. A plugin
// with no entry means "nothing has ever been changed about it".
//
// Values are the three JSON scalars the descriptors can declare (`number`/`string`/
// `boolean`). `null` is NOT stored: a reset drops the key, which is the same fact in one
// fewer bytes and keeps `values(plugin)` free of "explicitly nothing" states. The store
// (./plugins.ts) filters anything this build no longer declares, so a retired setting
// cannot resurrect itself on the next boot.
export type HarnessPluginSettingsRecord = Record<string, Record<string, number | string | boolean>>;

// T19 (ADDITIVE): one trusted-catalogue agent profile as the GLOBAL override layer
// records it. The shipped profile itself is compiled in (`src/agents`), so a record
// stores ONLY what the operator changed plus the retirement flag — never a copy of the
// catalogue text. A restart therefore replays decisions, not prompts, and an improved
// shipped instruction still reaches a profile nobody overrode.
//
//   - `title`/`description`/`instruction`/`guidelines`: a stated field REPLACES the
//     catalogue value for FUTURE sessions (existing sessions hold the agents they were
//     built with, so they are untouched);
//   - `retired: true`: the profile is out of the selectable catalogue (the DELETE
//     route's tombstone). Absent means "not retired".
//
// WHY A SIBLING FILE AND NOT A `state.json` FIELD
// -----------------------------------------------
// `state.json` is one whole-document commit unit, and its writer (./sessions.ts
// `document()`) builds every field it knows from the live store. The agent overlay is
// REGISTRY state, not session state, and the store's document builder does not own it,
// so the overlay lives in `<root>/harness/agents.json` with the same staging+rename
// discipline. One writer per file means no carry-forward rule, no cross-thread cache,
// and no chance of a session checkpoint silently dropping an operator's agent decision.
export type HarnessAgentRecord = {
    name: string;
    title?: string;
    description?: string;
    instruction?: string;
    guidelines?: string[];
    retired?: boolean;
};

export type HarnessDatabase = {
    version: typeof HARNESS_DATABASE_VERSION;
    savedAt: number;
    registry: HarnessPresetRecord[];
    // T5 (ADDITIVE): names of SHIPPED built-ins the operator deleted. `registry`
    // cannot express this on its own — it is written from `registry.list()`, and a
    // fresh registry always seeds itself from ./presets.ts, so a missing row would
    // simply let the next start re-ship the card. An absent field means "no
    // deletions recorded" (every pre-T5 document), and is preserved as absent on a
    // round trip. A deleted USER harness needs no entry here: its row is gone, and
    // nothing ships it.
    deleted?: string[];
    // T16 (ADDITIVE): the operator's GLOBAL provider defaults, as changed by
    // `PATCH /v1/harness/config`. Key-free by construction - the credential never enters this
    // document (the secret rule: `state.json` holds no api key), so a process-start key from the
    // environment stays the only source of one, and an explicitly overridden key stays in memory
    // for the life of the process (documented on the route). Absent means "the shipped
    // environment defaults" (every pre-T16 document).
    globalSettings?: HarnessGlobalSettingsRecord;
    // T5 / R2-R3 (ADDITIVE): the operator's per-plugin setting OVERRIDES, written by
    // `PATCH /v1/harness/plugins/{plugin_id}` and read back at construction by the runtime's
    // plugin settings store (./plugins.ts, via `SessionStore`). Absent means "no plugin
    // setting has ever been changed" (every pre-R3 document), and an absent field stays
    // absent on a round trip. Values are JSON scalars only; the declared defaults they
    // override are NOT stored (they belong to the plugin's own metadata).
    pluginSettings?: HarnessPluginSettingsRecord;
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

// The raw failure behind a `HarnessPersistenceError`. The wrapper carries the
// operator-facing text; `cause` keeps the underlying message so `lastWriteError`
// reports the same string it reported before the commit primitive was extracted
// (see `writeHarnessDatabaseFile`).
const causeOf = (error: unknown): unknown => {
    if (error instanceof Error && 'cause' in error) return (error as { cause?: unknown }).cause ?? error;

    return error;
};

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

// A string → string map (`agentModels`, T3's `agentInstructions`, R2's `agentColors`, and R7's
// `customAgents`). All four are agent id → text maps restored the same way, so a malformed
// stored document reports the same shape of error whichever field is
// broken. The reader itself is `readStringMap` below, next to the other map readers.

// Frozen descriptor (`SessionSnapshot.harnessDefinition`). Validate the fields a
// restored session and the UI rely on; agentModels/coreTools are optional.
const readDescriptor = (value: unknown, label: string): HarnessDescriptor => {
    const record = requireRecord(value, label);
    const agentModels =
        record.agentModels === undefined ? undefined : readStringMap(record.agentModels, `${label}.agentModels`);
    const agentInstructions =
        record.agentInstructions === undefined
            ? undefined
            : readStringMap(record.agentInstructions, `${label}.agentInstructions`);

    // R2: the per-agent swatches a session's frozen definition carried. Same optional,
    // same reader: a pre-R2 definition restores with no `agentColors` key at all, and a
    // colored one comes back byte-identical (the UI repaints the same agents).
    const agentColors =
        record.agentColors === undefined ? undefined : readStringMap(record.agentColors, `${label}.agentColors`);

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
        ...(agentInstructions === undefined ? {} : { agentInstructions }),
        ...(agentColors === undefined ? {} : { agentColors }),
        builtin: requireBoolean(record.builtin, `${label}.builtin`),
        editable: requireBoolean(record.editable, `${label}.editable`)
    };
};

// T19: one global agent overlay record (see `HarnessAgentRecord`). An override field
// that is present must be non-blank text; `guidelines` must be a list of non-blank
// strings (an empty list is the explicit "no guidelines" the PATCH contract allows);
// `retired` is the tombstone. A record with NO override and NO tombstone is accepted
// and simply states "the shipped profile", which is what a rolled-back edit leaves.
const readAgentRecord = (value: unknown, label: string): HarnessAgentRecord => {
    const record = requireRecord(value, label);
    const name = requireString(record.name, `${label}.name`).trim();

    if (name.length === 0) throw new TypeError(`${label}.name must not be blank.`);

    const optionalText = (field: string): string | undefined => {
        const entry = record[field];

        if (entry === undefined) return undefined;

        const text = requireString(entry, `${label}.${field}`);

        return text;
    };

    const guidelines =
        record.guidelines === undefined
            ? undefined
            : (() => {
                  const lines = requireStringArray(record.guidelines, `${label}.guidelines`);

                  for (const [index, line] of lines.entries()) {
                      if (line.trim().length === 0) {
                          throw new TypeError(`${label}.guidelines[${index}] must not be blank.`);
                      }
                  }

                  return lines;
              })();

    return {
        name,
        ...(optionalText('title') === undefined ? {} : { title: optionalText('title')! }),
        ...(optionalText('description') === undefined ? {} : { description: optionalText('description')! }),
        ...(optionalText('instruction') === undefined ? {} : { instruction: optionalText('instruction')! }),
        ...(guidelines === undefined ? {} : { guidelines }),
        ...(record.retired === undefined
            ? {}
            : { retired: requireBoolean(record.retired, `${label}.retired`) })
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
        record.agentModels === undefined ? undefined : readStringMap(record.agentModels, `${label}.agentModels`);

    // T3: a saved instruction override is part of the harness's executable state, so
    // it is restored exactly like the model map (and an older document without the
    // field restores unchanged).
    const agentInstructions =
        record.agentInstructions === undefined
            ? undefined
            : readStringMap(record.agentInstructions, `${label}.agentInstructions`);

    // R2: a saved color is executable state in the same sense — the factory closure
    // captures the map, so `presetFromRecord` needs it to rebuild the harness the row
    // described. Optional and additive: a document without the field restores with no
    // `agentColors` key, exactly like the two maps above.
    const agentColors =
        record.agentColors === undefined ? undefined : readStringMap(record.agentColors, `${label}.agentColors`);

    // R7: a session-defined agent map is executable state in the same sense — the factory
    // closure captures it and `agentsFromProfiles` builds the listed members from it instead of
    // from the catalogue. Optional and additive: a document without the field restores with no
    // `customAgents` key, exactly like the three maps above, so every pre-R7 session comes back
    // byte-identically.
    const customAgents =
        record.customAgents === undefined ? undefined : readStringMap(record.customAgents, `${label}.customAgents`);

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
        ...(agentInstructions === undefined ? {} : { agentInstructions }),
        ...(agentColors === undefined ? {} : { agentColors }),
        ...(customAgents === undefined ? {} : { customAgents }),
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

    // R1-R6: the persistent thread that owns this turn. OPTIONAL so every
    // pre-thread turn keeps its exact recorded shape; a non-empty string when
    // present (a thread id is opaque but never blank).
    const threadId =
        record.threadId === undefined
            ? undefined
            : (() => {
                  const value = requireString(record.threadId, `${label}.threadId`);
                  if (value.trim().length === 0) {
                      throw new TypeError(`${label}.threadId must not be blank.`);
                  }

                  return value;
              })();

    // R8: the conversation display label recorded WITH the turn (an old turn has
    // none; the store derives it from the roster on demand). T14/F4: it must be a
    // label this server can actually emit (two-letter code + POSITIVE ordinal) — a
    // blank, lowercase, `RR0` or free-text value would be adopted as an authoritative
    // display name and could break `#` resolution, so it fails the load like any
    // other corruption. Old documents simply have no key.
    const threadLabel =
        record.threadLabel === undefined
            ? undefined
            : (() => {
                  const value = requireString(record.threadLabel, `${label}.threadLabel`);
                  const parts = agentLabelParts(value);

                  if (parts === undefined) {
                      throw new TypeError(
                          `${label}.threadLabel must be a conversation label such as "RR1".`
                      );
                  }

                  return parts.label;
              })();

    return {
        id: requireString(record.id, `${label}.id`),
        index: requireNumber(record.index, `${label}.index`),
        prompt: requireString(record.prompt, `${label}.prompt`),
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadLabel === undefined ? {} : { threadLabel }),
        ...(references === undefined ? {} : { references }),
        ...(attachments === undefined ? {} : { attachments }),
        status: status as SessionTurn['status'],
        ...(record.startedAt === undefined
            ? {}
            : { startedAt: requireNumber(record.startedAt, `${label}.startedAt`) }),
        updatedAt: requireNumber(record.updatedAt, `${label}.updatedAt`),
        events: record.events as SessionTurn['events'],
        ...(eventTimes === undefined ? {} : { eventTimes }),
        ...(usage === undefined ? {} : { usage }),
        ...(record.steers === undefined
            ? {}
            : { steers: readSteerRecords(record.steers, `${label}.steers`) }),
        // T14: the per-turn steer TEXT archive. Validated (not passed through) because it
        // is what the context bar's lazy detail route answers a click with: a corrupt entry
        // would surface as a segment that opens with nothing in it.
        ...(record.steerTexts === undefined
            ? {}
            : { steerTexts: readSteerTexts(record.steerTexts, `${label}.steerTexts`) })
    };
};

// Deliberately UNBOUNDED (T15). The archive holds the text the USER submitted, and a submit
// the server accepted is data, not cache: dropping one to keep a document small would lose a
// fact the conversation already contains. Its size is bounded at the source instead — one
// entry per accepted steer, and steering is only possible while a thread runs (the runtime
// drains the queue at the next safe boundary), each submit already capped by
// ../server/sessions.ts `MAX_INPUT_LENGTH` (200,000 characters) exactly like any other turn
// prompt. `turn.events` is unbounded on the same reasoning; the 64-entry cap above belongs to
// the AUDIT ring (a rolling operational record), not to this archive. The reader therefore
// validates every ENTRY (below) and refuses no length.
const readSteerTexts = (value: unknown, label: string): SessionTurn['steerTexts'] => {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);

    return value.map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        const item = requireRecord(entry, itemLabel);

        // The identity is mandatory here (unlike the audit ring, where an older record may
        // predate it): the archive is addressed BY that id, and a blank key would make the
        // entry unreachable by the very route that reads it.
        const id = requireString(item.id, `${itemLabel}.id`);

        if (id.trim().length === 0) {
            throw new TypeError(`${itemLabel}.id must not be blank.`);
        }

        const threadId =
            item.threadId === undefined
                ? undefined
                : (() => {
                      const text = requireString(item.threadId, `${itemLabel}.threadId`);
                      if (text.trim().length === 0) {
                          throw new TypeError(`${itemLabel}.threadId must not be blank.`);
                      }

                      return text;
                  })();

        return {
            id,
            at: requireNumber(item.at, `${itemLabel}.at`),
            prompt: requireString(item.prompt, `${itemLabel}.prompt`),
            ...(threadId === undefined ? {} : { threadId })
        };
    });
};

// Optional `{ key: number }` map used by the label-seed record. Values are
// finite NON-NEGATIVE integers (an occurrence counter); a negative or fractional
// value is corruption, not something to clamp silently.
const readCounterMap = (value: unknown, label: string): Record<string, number> => {
    const record = requireRecord(value, label);
    const mapped: Record<string, number> = {};

    for (const [key, entry] of Object.entries(record)) {
        const counter = requireNumber(entry, `${label}.${key}`);

        if (!Number.isInteger(counter) || counter < 0) {
            throw new TypeError(`${label}.${key} must be a non-negative integer.`);
        }

        mapped[key] = counter;
    }

    return mapped;
};

// Optional `{ key: string }` map (turn id -> invocation id / per-turn counters, and
// the `agentModels` / `agentInstructions` / `agentColors` override maps of a saved
// preset). A stored color is read as plain text here: the hex SHAPE is enforced where
// the value is authored (registry `normalizeAgentColors` and `agent()` construction),
// and the loader's job is to refuse a document whose map is not a string map at all.
const readStringMap = (value: unknown, label: string): Record<string, string> => {
    const record = requireRecord(value, label);
    const mapped: Record<string, string> = {};

    for (const [key, entry] of Object.entries(record)) {
        mapped[key] = requireString(entry, `${label}.${key}`);
    }

    return mapped;
};

// Optional `turnId -> instruction snapshots` map (T9/T10, see `HarnessSessionRecord
// .turnInstructionSources`). Validated entry by entry rather than passed through: the
// fold COUNTS these strings to produce the context bar's `system` segment, so a
// non-string entry would silently mis-count characters instead of failing the load,
// and an empty `instructions` list is a legitimate value ("this agent ran with no
// system message") that must survive as an empty list, not collapse to absent.
const readInstructionSources = (value: unknown, label: string): Record<string, TurnInstructionSource[]> => {
    const record = requireRecord(value, label);
    const mapped: Record<string, TurnInstructionSource[]> = {};

    for (const [turnId, entry] of Object.entries(record)) {
        const itemLabel = `${label}.${turnId}`;

        if (!Array.isArray(entry)) throw new TypeError(`${itemLabel} must be an array of instruction sources.`);

        mapped[turnId] = entry.map((raw, index) => {
            const itemLabelWithIndex = `${itemLabel}[${index}]`;
            const item = requireRecord(raw, itemLabelWithIndex);

            if (!Array.isArray(item.instructions)) {
                throw new TypeError(`${itemLabelWithIndex}.instructions must be an array of instruction strings.`);
            }

            return {
                agent: requireString(item.agent, `${itemLabelWithIndex}.agent`),
                instructions: item.instructions.map((text, position) =>
                    requireString(text, `${itemLabelWithIndex}.instructions[${position}]`)
                ),
                ...(item.at === undefined ? {} : { at: requireNumber(item.at, `${itemLabelWithIndex}.at`) })
            };
        });
    }

    return mapped;
};

// Optional `threadId -> conversation label` map (R8). T14/F4: each value must be a
// label the allocator can emit (two-letter code + positive ordinal) and each key a
// non-blank thread id. Adopting an arbitrary string as a display name would let a
// hand edit (or a foreign/global ordinal such as `T8`) become authoritative and
// break `#LABEL` resolution, so a malformed entry fails the load instead. The value
// is normalised to the allocator's uppercase spelling; duplicates ACROSS threads are
// repaired deterministically by the store (the first owner keeps the name), not
// rejected here, so a recoverable document still loads.
const readLabelMap = (value: unknown, label: string): Record<string, string> => {
    const record = requireRecord(value, label);
    const mapped: Record<string, string> = {};

    for (const [key, entry] of Object.entries(record)) {
        if (key.trim().length === 0) {
            throw new TypeError(`${label} has a blank thread id key.`);
        }

        const text = requireString(entry, `${label}.${key}`);
        const parts = agentLabelParts(text);

        if (parts === undefined) {
            throw new TypeError(`${label}.${key} must be a conversation label such as "RR1".`);
        }

        mapped[key] = parts.label;
    }

    return mapped;
};

// Steered-submit audit records (R5/F3). Optional; each entry keeps the timestamp,
// the user-facing text, and the result blocks whose content was injected. Bounded
// so a long-running turn cannot grow its record without limit.
const MAX_STEER_RECORDS = 64;

const readSteerRecords = (value: unknown, label: string): SessionTurn['steers'] => {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);

    if (value.length > MAX_STEER_RECORDS) {
        throw new TypeError(`${label} cannot contain more than ${MAX_STEER_RECORDS} entries.`);
    }

    return value.map((entry, index) => {
        const at = `${label}[${index}]`;
        const record = requireRecord(entry, at);
        const references =
            record.references === undefined
                ? undefined
                : (() => {
                      try {
                          return readAgentResultReferenceList(record.references, `${at}.references`);
                      } catch (error) {
                          throw new TypeError(
                              `${at}.references is invalid: ${error instanceof Error ? error.message : String(error)}`
                          );
                      }
                  })();

        // T12b: optional child-conversation attribution for a steered submit.
        const threadId =
            record.threadId === undefined
                ? undefined
                : (() => {
                      const value = requireString(record.threadId, `${at}.threadId`);
                      if (value.trim().length === 0) {
                          throw new TypeError(`${at}.threadId must not be blank.`);
                      }

                      return value;
                  })();

        // T13: the submit's durable identity. OPTIONAL — a document written before the
        // field existed has no key, and the fold derives one for it — but when it is there
        // it must survive the load, because the context bar keys its segment from it and a
        // dropped id would renumber every steer segment of a restored turn.
        const id =
            record.id === undefined
                ? undefined
                : (() => {
                      const value = requireString(record.id, `${at}.id`);
                      if (value.trim().length === 0) {
                          throw new TypeError(`${at}.id must not be blank.`);
                      }

                      return value;
                  })();

        return {
            ...(id === undefined ? {} : { id }),
            at: requireNumber(record.at, `${at}.at`),
            prompt: requireString(record.prompt, `${at}.prompt`),
            ...(threadId === undefined ? {} : { threadId }),
            ...(references === undefined ? {} : { references })
        };
    });
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

    // R1-R6 additive fields. All three are OPTIONAL: a document written before
    // threads keeps loading, and the store derives the missing high-water mark from
    // the recorded turn indices.
    const threadSequence =
        record.threadSequence === undefined
            ? undefined
            : (() => {
                  const value = requireNumber(record.threadSequence, `${label}.threadSequence`);

                  if (!Number.isInteger(value) || value < 0) {
                      throw new TypeError(`${label}.threadSequence must be a non-negative integer.`);
                  }

                  return value;
              })();

    const labelSeeds =
        record.labelSeeds === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.labelSeeds, `${label}.labelSeeds`);
                  const mapped: Record<string, Record<string, number>> = {};

                  for (const [turnId, counters] of Object.entries(entry)) {
                      mapped[turnId] = readCounterMap(counters, `${label}.labelSeeds.${turnId}`);
                  }

                  return mapped;
              })();

    const turnInvocations =
        record.turnInvocations === undefined
            ? undefined
            : readStringMap(record.turnInvocations, `${label}.turnInvocations`);

    // T9/T10: an absent field stays absent through a round trip (a pre-T10 document is
    // byte-identical after a load+save), and a present one is re-validated on read.
    const turnInstructionSources =
        record.turnInstructionSources === undefined
            ? undefined
            : readInstructionSources(record.turnInstructionSources, `${label}.turnInstructionSources`);

    const labelHighWater =
        record.labelHighWater === undefined
            ? undefined
            : readCounterMap(record.labelHighWater, `${label}.labelHighWater`);

    const invocationThreads =
        record.invocationThreads === undefined
            ? undefined
            : readStringMap(record.invocationThreads, `${label}.invocationThreads`);

    const threadLabels =
        record.threadLabels === undefined
            ? undefined
            : readLabelMap(record.threadLabels, `${label}.threadLabels`);

    const threadLabelHighWater =
        record.threadLabelHighWater === undefined
            ? undefined
            : readCounterMap(record.threadLabelHighWater, `${label}.threadLabelHighWater`);

    // C4: unreadable transcripts (see `HarnessSessionRecord.invalidThreads`).
    // OPTIONAL in every direction: an absent field stays absent through a round
    // trip, `messages` is kept EXACTLY as stored (it is the user's broken text, so
    // normalising it here would destroy the thing being shown), `error` is the one
    // field with a hard shape requirement, and a map that is not an object is
    // document corruption like every other field in this record.
    const invalidThreads =
        record.invalidThreads === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.invalidThreads, `${label}.invalidThreads`);

                  // C8-m8: NULL prototype. Thread ids are opaque and a document may
                  // name one `__proto__`; an ordinary bracket assignment on a `{}`
                  // literal hits the prototype SETTER, which re-points the object's
                  // prototype instead of storing the entry — the raw transcript then
                  // silently disappears (`Object.keys` never shows that id) and the
                  // operator loses the only copy of the broken text.
                  const mapped = Object.create(null) as Record<string, HarnessInvalidThreadRecord>;

                  for (const [threadId, value] of Object.entries(entry)) {
                      const itemLabel = `${label}.invalidThreads.${threadId}`;
                      const item = requireRecord(value, itemLabel);

                      mapped[threadId] = {
                          error: requireString(item.error, `${itemLabel}.error`),
                          messages: item.messages,
                          ...(item.label === undefined
                              ? {}
                              : { label: requireString(item.label, `${itemLabel}.label`) }),
                          ...(item.agent === undefined
                              ? {}
                              : { agent: requireString(item.agent, `${itemLabel}.agent`) })
                      };
                  }

                  return mapped;
              })();

    // T27 (durability): the session's display title. `sessions.ts` WRITES this field
    // (sessionRecord, line 2506) and reads it back on restore (line 2973), and
    // `SessionSummary.title` / `UpdateSessionRequest.title` are contract-visible — but this
    // loader used to drop it, so a rename survived in memory only until the next restart:
    // the document on disk named the conversation and the rebuilt session did not. It is
    // now validated and preserved, and preserved as ABSENT when absent (a pre-T16 document
    // still round-trips byte-for-byte).
    //
    // Normalization is a trim, plus "blank means no title". The length cap is the WRITER's
    // (sessions.ts `renameSession` slices to 200) and is deliberately NOT enforced here:
    // throwing on an over-long hand-edited value would drop the whole session
    // (readHarnessDatabase fails => the store reports a restore error for that record),
    // which is a worse outcome than displaying a long name.
    const title = (() => {
        if (record.title === undefined) return undefined;

        const text = requireString(record.title, `${label}.title`).trim();

        return text.length === 0 ? undefined : text;
    })();

    // T27: the session-scoped binding list. OPTIONAL in both directions; values are trimmed,
    // a blank entry is corruption of the named slot (a roster member name cannot be blank),
    // and duplicates collapse because they name one binding.
    const sessionAgents =
        record.sessionAgents === undefined
            ? undefined
            : (() => {
                  const names: string[] = [];

                  const listed = requireStringArray(record.sessionAgents, `${label}.sessionAgents`);

                  for (const [index, entry] of listed.entries()) {
                      const name = entry.trim();

                      if (name.length === 0) {
                          throw new TypeError(`${label}.sessionAgents[${index}] must not be blank.`);
                      }

                      if (!names.includes(name)) names.push(name);
                  }

                  return names;
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
        // T27: preserved only when the document actually carries it (see above).
        ...(title === undefined ? {} : { title }),
        ...(sessionAgents === undefined ? {} : { sessionAgents }),
        turns,
        queue,
        ...(threadSequence === undefined ? {} : { threadSequence }),
        ...(labelSeeds === undefined ? {} : { labelSeeds }),
        ...(labelHighWater === undefined ? {} : { labelHighWater }),
        ...(threadLabels === undefined ? {} : { threadLabels }),
        ...(threadLabelHighWater === undefined ? {} : { threadLabelHighWater }),
        ...(turnInvocations === undefined ? {} : { turnInvocations }),
        ...(turnInstructionSources === undefined ? {} : { turnInstructionSources }),
        ...(invocationThreads === undefined ? {} : { invocationThreads }),
        ...(invalidThreads === undefined ? {} : { invalidThreads }),
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

    // T5: deleted-builtin names. OPTIONAL, and preserved as OPTIONAL: a pre-T5
    // document must round-trip to its exact previous shape, so an absent field stays
    // absent rather than becoming `[]`. Values are trimmed, and duplicates are
    // collapsed (a name listed twice states one fact) while a blank or non-string
    // entry is reported as corruption of the named slot. The names are NOT checked
    // against the shipped catalogue: a tombstone may legitimately name a built-in
    // this build stopped shipping or will ship again later.
    const deleted =
        record.deleted === undefined
            ? undefined
            : (() => {
                  if (!Array.isArray(record.deleted)) {
                      throw new TypeError('The harness database deleted must be an array of harness names.');
                  }

                  const names: string[] = [];

                  for (const [index, entry] of (record.deleted as readonly unknown[]).entries()) {
                      const name = requireString(entry, `deleted[${index}]`).trim();

                      if (name.length === 0) {
                          throw new TypeError(`deleted[${index}] must not be blank.`);
                      }

                      if (!names.includes(name)) names.push(name);
                  }

                  return names;
              })();

    // T27 (durability): the operator's saved global provider defaults. `sessions.ts` WRITES
    // this field (`databaseRecord`, line 2602) and `createHarnessApi` reads it back at
    // construction (`store.globalSettings`, api.ts:756) — but this loader dropped it, so a
    // saved `PATCH /config` was durable on disk and forgotten on the next boot: the file
    // carried the operator's base URL/model while every session got the shipped defaults.
    //
    // Rules, in the order the type allows:
    //   - OPTIONAL in both directions: an absent field stays absent, so a document from a
    //     deployment that never touched `/config` keeps its exact pre-T16 shape;
    //   - each present value must be a non-blank string after trimming (the same shape the
    //     writer produces — `updateGlobalSettings` stores exactly what `/config` validated);
    //   - either field may appear alone, because `HarnessGlobalSettingsRecord` is built as a
    //     partial by the writer and a reset deletes one key rather than the whole map;
    //   - an `apiKey` key is REFUSED, not dropped, mirroring the per-session rule above: the
    //     documented invariant is that state.json holds no credential, so a foreign writer
    //     that stored one must surface as corruption rather than silently lose the secret.
    const globalSettings =
        record.globalSettings === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.globalSettings, 'The harness database globalSettings');

                  if (Object.prototype.hasOwnProperty.call(entry, 'apiKey')) {
                      throw new TypeError('The harness database globalSettings must not contain an API key.');
                  }

                  const readField = (key: 'baseURL' | 'model'): string | undefined => {
                      const value = entry[key];

                      if (value === undefined) return undefined;

                      const text = requireString(value, `The harness database globalSettings.${key}`).trim();

                      if (text.length === 0) {
                          throw new TypeError(
                              `The harness database globalSettings.${key} must not be blank.`
                          );
                      }

                      return text;
                  };

                  const baseURL = readField('baseURL');
                  const model = readField('model');

                  if (baseURL === undefined && model === undefined) {
                      throw new TypeError(
                          'The harness database globalSettings must carry at least one of baseURL or model.'
                      );
                  }

                  return {
                      ...(baseURL === undefined ? {} : { baseURL }),
                      ...(model === undefined ? {} : { model })
                  } as HarnessGlobalSettingsRecord;
              })();

    // T5 / R2-R3 (durability): the operator's per-plugin setting overrides.
    //
    // STRICT about shape, LENIENT about identity:
    //   - OPTIONAL in both directions: an absent field stays absent, so a document from a
    //     deployment that never opened the Plugins pane keeps its exact previous shape;
    //   - the map must be an object of objects, and every value must be one of the three JSON
    //     scalars a descriptor can declare. A nested object or an array is corruption of the
    //     named slot and throws, exactly like every other field here;
    //   - plugin NAMES and KEY NAMES are deliberately not checked against this build's
    //     catalogue — the same rule `deleted` follows above. A saved override may name a
    //     plugin this build stopped shipping or will ship again later, and ./plugins.ts
    //     `restore` decides what is still meaningful;
    //   - an empty map (or a map whose only entries are empty) normalizes to ABSENT, because
    //     the writer never emits `{}`: gating here is what keeps load -> save byte-stable.
    const pluginSettings =
        record.pluginSettings === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.pluginSettings, 'The harness database pluginSettings');

                  const values: HarnessPluginSettingsRecord = {};

                  for (const [plugin, raw] of Object.entries(entry)) {
                      const inner = requireRecord(raw, `The harness database pluginSettings.${plugin}`);

                      const settings: Record<string, number | string | boolean> = {};

                      for (const [key, value] of Object.entries(inner)) {
                          const label = `The harness database pluginSettings.${plugin}.${key}`;

                          if (typeof value === 'number') {
                              if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
                          } else if (typeof value === 'boolean') {
                              // A boolean is already the right shape.
                          } else if (typeof value === 'string') {
                              // A string is already the right shape (an empty string is a value).
                          } else {
                              throw new TypeError(
                                  `${label} must be a number, a string, or a boolean; plugin settings hold JSON scalars only.`
                              );
                          }

                          settings[key] = value as number | string | boolean;
                      }

                      // An empty plugin map states nothing, so it is not carried forward.
                      if (Object.keys(settings).length > 0) values[plugin] = settings;
                  }

                  return Object.keys(values).length === 0 ? undefined : values;
              })();

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
        ...(deleted === undefined ? {} : { deleted }),
        // Key order mirrors `sessions.ts` `databaseRecord`, so a load+save of a document that
        // already carries the field does not reorder it.
        ...(globalSettings === undefined ? {} : { globalSettings }),
        ...(pluginSettings === undefined ? {} : { pluginSettings }),
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

    // R1-R6: host-thread conversations are persisted beside the agent transcripts
    // and are resumed the same way, so they need the SAME orphaned-tool-call repair.
    // A thread left mid-call would otherwise make the next provider request for
    // that conversation invalid — the agent repair alone does not cover it.
    let threads = snapshot.threads;

    if (threads !== undefined) {
        threads = threads.map((thread) => {
            const messages = repairAgentMessages(thread.messages);

            if (messages === thread.messages) return thread;

            changed = true;
            return { ...thread, messages: [...messages] };
        });
    }

    if (!changed) return snapshot;

    return {
        ...snapshot,
        agents,
        ...(threads === undefined ? {} : { threads })
    };
};

// ---------------------------------------------------------------------------
// Commit primitives (R1: the same commit, executed off the coordinator)
// ---------------------------------------------------------------------------
//
// WHY THESE ARE SEPARATE EXPORTS
// ------------------------------
// The IO worker (./workers/io-worker.ts) has to perform EXACTLY this commit, just on
// another thread. Duplicating the format there would let the two write modes drift
// and produce a `state.json` the other mode mis-reads, so the worker calls these
// functions and byte-identity between modes is a property of the code, not of one
// test. Both are pure (no instance state), so nothing about them is per-store.
//
// What is expensive here, and therefore what moves off the main thread:
//   - the serialization: a two-space pretty-print of the WHOLE document, i.e. O(all
//     sessions x all recorded events). On the coordinator this is a synchronous
//     block of the event loop proportional to the database size.
//   - the syscalls: mkdir + open + write + fsync + close + rename.
//
// What stays on the coordinator no matter what (honest limit, restated in
// ./workers/io-client.ts): building the `HarnessDatabase` record itself, and the
// structured clone `postMessage` performs on it. Worker mode moves the stringify and
// every syscall off the loop; it cannot move the object graph it is handed.
export const serializeHarnessDatabase = (database: HarnessDatabase, savedAt = Date.now()): string =>
    JSON.stringify({ ...database, version: HARNESS_DATABASE_VERSION, savedAt }, null, 2);

// Post-increment staging counter: the first write of a writer gets `from`. Hoisted
// out of the class so the worker keeps its OWN counter (a worker thread shares
// `process.pid` with the coordinator, so the two writers must not be able to pick the
// same staging name — see `HarnessDatabaseWriteOptions.owner`).
export const createHarnessStagingSequence = (from = 0): (() => number) => {
    let current = from;

    return () => {
        const value = current;
        current += 1;

        return value;
    };
};

export type HarnessDatabaseWriteOptions = {
    // Identity baked into the staging file name. The default is the process id —
    // what the synchronous writer has always used. The IO worker passes
    // `<pid>.io<threadId>` so its staging name can never collide with a coordinator
    // staging file in the same process.
    owner?: string;
    // Per-writer monotonic suffix source, so a stale staging file from a crashed
    // write is never reused by the next one. A caller that owns a writer MUST pass
    // one (`HarnessPersistence` and the IO worker both do): without it every commit
    // gets suffix `0`, and two writes by the same writer reuse the staging name.
    sequence?: () => number;
};

// The atomic full-document commit, as a function of data only.
//
// Same rule the class has always enforced: write the complete payload to a sibling
// staging file, fsync it, then rename over the canonical file. The canonical file is
// never unlinked first, so a crash leaves either the old complete document or the new
// complete one, and a partial staging file is removed (never mistaken for a commit).
//
// Durability boundary, stated exactly: when this returns, the payload bytes are
// fsynced and the directory ENTRY is replaced. The directory entry itself is not
// fsynced, so after a hard power loss the rename may not have survived — the same
// (deliberate) boundary the synchronous writer has always had.
//
// Throws `HarnessPersistenceError` with the file in the message; the raw failure rides
// along as `cause` so a caller can report the underlying message unchanged.
//
// `directory` MUST be the canonical file's own directory: the staging file is created
// there and the commit is a same-directory rename, which is the whole atomicity
// guarantee (a cross-directory rename is a copy, and a crash in the middle of one is a
// half-written database).
export const writeHarnessDatabaseFile = (
    directory: string,
    file: string,
    payload: string,
    options: HarnessDatabaseWriteOptions = {}
): void => {
    const staging = path.join(
        directory,
        `${HARNESS_DATABASE_FILE}.${options.owner ?? process.pid}.${(options.sequence ?? createHarnessStagingSequence())()}.tmp`
    );

    const failure = (error: unknown, label: string): Error => {
        const wrapped = new HarnessPersistenceError(file, `${label}: ${messageOf(error)}`);

        // Best effort: an Error created without `cause` still reports the wrapper
        // text, which is what the HTTP surface shows either way.
        try {
            (wrapped as Error & { cause?: unknown }).cause = error;
        } catch {
            // Frozen host: the message is the contract, the cause is a bonus.
        }

        return wrapped;
    };

    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
        throw failure(error, 'Could not create the harness database directory');
    }

    let handle: number | undefined;

    try {
        handle = fs.openSync(staging, 'w');
        fs.writeFileSync(handle, payload, 'utf8');
        // fsync before rename: the rename may be durable while the bytes are not,
        // which would publish an empty/truncated canonical file.
        fs.fsyncSync(handle);
        fs.closeSync(handle);
        handle = undefined;

        // Same-directory rename: atomic on the platforms this server targets.
        fs.renameSync(staging, file);
    } catch (error) {
        if (handle !== undefined) {
            try {
                fs.closeSync(handle);
            } catch {
                // The handle is already unusable; the original error matters.
            }
        }

        // A partial staging file is not a commit: remove it so a later run cannot
        // confuse it with a real document (the canonical file is kept).
        try {
            fs.rmSync(staging, { force: true });
        } catch {
            // Best effort; the write error below is the actionable failure.
        }

        throw failure(error, 'Could not write the harness database');
    }
};

// Durable document owner for one resolved root.
export class HarnessPersistence {
    readonly directory: string;
    readonly file: string;

    // Post-increment staging suffix: unique per process and write, so a stale
    // staging file from a crashed write is never reused. The counter is a writer
    // property (not a module one) because the IO worker runs the same primitive in
    // this process with its own `owner` token — see `writeHarnessDatabaseFile`.
    private staging = createHarnessStagingSequence();
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
    //
    // R1: the byte format and the commit sequence live in the exported primitives
    // above, so the IO worker commits identical bytes on its own thread. This method
    // is the inline path and stays the compatibility surface: monkey-patchable in
    // tests (./shutdown-background.test.ts:216), synchronous, and throwing.
    save(database: HarnessDatabase): void {
        const payload = serializeHarnessDatabase(database);

        try {
            writeHarnessDatabaseFile(this.directory, this.file, payload, { sequence: this.staging });
            this.lastError = undefined;
        } catch (error) {
            // The underlying message, exactly as before the extraction: this channel
            // is observability only, and an operator compares it with the syscall.
            this.lastError = messageOf(causeOf(error));

            throw error;
        }
    }
}

// ---------------------------------------------------------------------------
// T19: the durable global AGENT overlay (`<root>/harness/agents.json`)
// ---------------------------------------------------------------------------
//
// One JSON array of `HarnessAgentRecord`, committed with the same staging+fsync+rename
// discipline as `state.json` (it IS `writeHarnessDatabaseFile`, whose durability boundary
// and staging-collision rules are already the package's). The file is small and written
// only by an operator agent mutation, so a synchronous commit is the right trade and
// keeps the mutation's "durable before the response" rule identical to a harness edit.
//
// A missing file means "no decisions recorded" (every pre-T19 database), and an empty
// array round-trips to the same file shape, so `PATCH`-then-revert leaves an auditable
// empty document rather than deleting state behind the operator's back.
export const HARNESS_AGENT_FILE = 'agents.json';

export const harnessAgentFileOf = (root: string): string =>
    path.join(resolveHarnessDatabaseRoot(root), HARNESS_DATABASE_DIRECTORY, HARNESS_AGENT_FILE);

// Read the overlay. Absent file -> []; a corrupt or foreign file is a LOUD failure
// naming the path, exactly like `state.json` (a silently ignored overlay would let a
// restart resurrect a retired agent while claiming durability).
export const readHarnessAgentRecords = (root: string | undefined): HarnessAgentRecord[] => {
    if (root === undefined || root.length === 0) return [];

    const file = harnessAgentFileOf(root);

    let text: string;

    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        const failure = error as NodeJS.ErrnoException;

        if (failure.code === 'ENOENT') return [];

        throw new HarnessPersistenceError(file, `Could not read the harness agent overlay: ${messageOf(error)}`);
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new HarnessPersistenceError(file, `The harness agent overlay is not valid JSON: ${messageOf(error)}`);
    }

    if (!Array.isArray(parsed)) {
        throw new TypeError('The harness agent overlay must be an array of agent records.');
    }

    const records = parsed.map((entry, index) => readAgentRecord(entry, `agents[${index}]`));
    const seen = new Set<string>();

    for (const record of records) {
        if (seen.has(record.name)) {
            throw new TypeError(`The harness agent overlay lists agent "${record.name}" more than once.`);
        }

        seen.add(record.name);
    }

    return records;
};

// Commit the overlay. No root means an in-memory deployment: nothing is durable and the
// caller's answer says so (`restored_by_restart`), so this is a no-op rather than a lie.
let agentStaging = createHarnessStagingSequence();

export const writeHarnessAgentRecords = (
    root: string | undefined,
    records: readonly HarnessAgentRecord[]
): void => {
    if (root === undefined || root.length === 0) return;

    const file = harnessAgentFileOf(root);

    writeHarnessDatabaseFile(
        path.dirname(file),
        file,
        JSON.stringify([...records], null, 2),
        // The staging prefix is `state.json.` by construction of that helper; the
        // `agents` owner keeps this writer's names disjoint from the store's and from
        // any other process, which is the property that matters.
        { owner: 'agents', sequence: agentStaging }
    );
};

// Durable harness database (R3b).
//
// WHAT IS PERSISTED
// -----------------
// Version 2 stores ONE logical document across a small directory tree, because a single
// file holding every session and every transcript cannot survive the population this
// server is meant to reach (hundreds of sessions, thousands of conversations): the whole
// document had to be re-stringified and re-fsynced for the smallest change, and a
// 110 MB `state.json` was a measured 800 ms checkpoint (see the T22/T25 notes below).
//
//   <databaseRoot>/harness/index.json                    the harness-level document: version,
//                                                          savedAt, registry, deleted?, the three
//                                                          operator settings blocks, and
//                                                          `sessions: [{ id, ordinal }]`
//   <databaseRoot>/harness/sessions/<id>/session.json    ONE session record — exactly what
//                                                          ./sessions.ts `sessionRecord()`
//                                                          produces, except that each
//                                                          `core.threads[]` row carries NO
//                                                          `messages`
//   <databaseRoot>/harness/sessions/<id>/threads/<tid>.json  ONE transcript: `{ version,
//                                                          sessionId, id, messages }`
//   <databaseRoot>/harness/sessions/<id>/events.jsonl    unchanged (./journal.ts), and it
//                                                          coexists with `threads/` in the
//                                                          same session directory
//
// ONLY THE STORAGE CHANGED. The in-memory model (`HarnessDatabase`,
// `HarnessSessionRecord`, `HarnessSnapshot`), every validator below
// (`readHarnessDatabase`), the whole restore pipeline and `SessionStore` are untouched:
// `load()` reassembles the identical object graph from the shards and runs the identical
// validation, and `save()` keeps its signature and its monkey-patchability. The v1
// single-file `state.json` is NOT read, migrated, rewritten, renamed or deleted — an
// upgrade therefore starts empty next to the old file, and it is reported once (see
// `noteLegacyHarnessDatabase`).
//
// In the field list below, "the document" now means that tree read back as one graph:
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
//     release that changes a default needs no migration here. The reserved
//     `enabled` key of that map is R2's global plugin switch (./plugins.ts).
//   - `toolSettings` (R3, optional) — the tool NAMES the operator has switched off
//     for EVERY session (a deny list; everything else is enabled). Read back by the
//     runtime's tool store (./tool-settings.ts) and consulted live by every harness,
//     so a click applies to a running conversation on its next turn.
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
// EVERY shard is its own commit unit with the same discipline the single file always
// had: write the shard's full JSON to a staging file in the SHARD'S OWN directory
// (`<name>.<owner>.<n>.tmp`), fsync it, then rename over the canonical name. The
// canonical file is never unlinked first, so a crash leaves either the old complete
// shard or the new complete shard. Writes are synchronous, which also makes them
// serialized: there is no second writer in this process and no cross-process
// multi-writer support (one server process per database root).
//
// A COMMIT IS ORDERED, and the order is the whole torn-set story (rule 6): thread
// shards first, then the session record that indexes them, then `index.json` last, and
// deletions of shards the new document no longer names LAST of all. Any crash window
// therefore leaves an EXTRA file the index does not name (load() ignores it) rather than
// a file the index names going missing (which would abort startup). The one window that
// can still strand a session is an external deletion of `sessions/<id>/` after the index
// was committed; load() then reports it as a persistence failure, exactly like a
// half-written document did in v1. One file deeper the same accident is far cheaper, and
// is handled the cheap way: an external deletion of a single `threads/<id>.json` leaves a
// row with no transcript, and load() keeps the session — the conversation goes through the
// unreadable-transcript tolerance that already exists (see
// `HARNESS_MISSING_THREAD_TRANSCRIPT`), with its own diagnostic naming the missing path.
//
// A COMMIT IS ALSO INCREMENTAL: each shard is content-addressed (sha256 of the payload)
// against the last bytes this writer committed, and a shard whose bytes did not change is
// not opened at all. `index.json` carries the only wall-clock stamp (`savedAt`), so it is
// normally rewritten and every untouched session — and every untouched transcript — is
// skipped. That is the point of the split: one edited conversation costs one thread shard
// plus one session record, not every session's every event.
//
// R1 (worker IO mode): the identical commit is ALSO executable on the IO worker thread,
// through the exported primitives below (`serializeHarnessShard` + `writeHarnessShardFile`
// per shard — the only form a worker receives, since protocol v3 has no whole-document
// frame), so a checkpoint's stringify and
// its syscalls need not block the coordinator's event loop. One writer of record per root
// still holds: an io client (./workers/io-client.ts) funnels EVERY write through one FIFO
// queue, and the staging name carries the writer's identity (`<pid>` on the coordinator,
// `<pid>.io<threadId>` on the worker — see `HarnessDatabaseWriteOptions.owner`) so a worker
// staging file can never collide with a coordinator one. There is still no second PROCESS
// and no parallel writer.
//
// WIRING STATUS (honest, updated 2026-11-12): the store now opens an io client whenever the
// resolved runtime says `ioExecution: 'worker'` (./sessions.ts constructor, D4). The entry the
// thread runs is the TypeScript source `src/server/workers/io-worker.ts`, published as the
// `@underload/harness/io-worker` subpath and loaded through the Vite module runner
// (./workers/worker-runner.ts) - there is no built bundle. (./src/structure.test.ts pins the
// subpath pairing; the packaging checker scripts are being retargeted to this shape.) In that
// mode the primitives below run on the worker thread and the coordinator never blocks on them:
// a strict save resolves after the worker's rename receipt, a best-effort/observer checkpoint
// claims queue ORDER only, and journal events are appended by the thread that holds the fd.
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
// The BLAST RADIUS of each shard is deliberately the v1 radius, not a new policy:
//   - `index.json` is the document header, so an unreadable, unparseable, wrong-version
//     or structurally invalid header aborts startup, naming `index.json`;
//   - a `session.json` that cannot be READ or PARSED aborts startup TOO, naming that session
//     file; a record that PARSES but fails the merged `readHarnessDatabase` shape check aborts
//     naming `index.json`, because that error is `harnessShapeError(this.file, …)` on the header
//     that published the id. In v1 the same broken record lived inside the one document and it
//     refused the whole file, so sharding must not turn a loud failure into a lost session. (A
//     session file CAN be GONE: the ordered commit makes that an external deletion, same shape);
//   - a thread shard is the one part with an existing tolerance: a missing, unparseable
//     or envelope-less shard leaves that row without `messages`, and
//     ./sessions.ts `tolerateThreadTranscripts` routes it into the record's
//     `invalidThreads` (the same trip a corrupt INLINE transcript takes today). No new
//     error class, no new policy;
//   - a shard the index does not name (crash leftover, hand copy, a transcript whose row
//     the 256-record cap retired) is ignored on read and left in place — there is no
//     garbage collection of files the index no longer lists.
//
// Cross-references:
//   - ./sessions.ts              — builds/consumes these records, recovery policy
//   - ./journal.ts               — the per-session `events.jsonl` that shares `sessions/<id>/`
//   - ./workers/io-worker.ts     — the same commit, executed off the main thread
//   - ./workers/io-client.ts     — the coordinator-side queue and durability barrier
//   - ./harnesses/registry.ts    — presetToRecord / presetFromRecord / registry restore
//   - ../types/index.ts          — HarnessSnapshot schema (restore validates it)
//   - ./runtime.ts, ./start.ts   — root resolution and startup wiring

import fs from 'node:fs';
import path from 'node:path';
// Content digests for the incremental shard commit (`HarnessPersistence.save`). Only the
// hash leaves this module; the payload text itself is never retained.
import { createHash } from 'node:crypto';
import type {
    HarnessAgentSnapshot,
    HarnessMessage,
    HarnessSnapshot
} from '../harness';
import type { HarnessDescriptor, SessionPluginDiagnostic, SessionStatus, SessionTurn } from './protocol';
import { PLUGIN_DIAGNOSTIC_LIMIT } from './protocol';
// The v2 per-session directory IS the journal's own, and session ids are addressed the
// same way by both writers (./journal.ts:253 joins the raw id with no sanitiser, so
// reusing the constant keeps the two paths identical by construction instead of by
// duplicated code). journal.ts imports nothing from this module, so this cannot cycle.
import { HARNESS_JOURNAL_DIRECTORY } from './journal';
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
//
// v2 = the sharded layout below (index + one record per session + one file per thread).
// It is deliberately a BUMP, not a silent change: a version-1 reader walking this
// directory would find an empty `sessions` list in `index.json` and report "no
// sessions", which is exactly the silent clean slate this gate exists to refuse.
export const HARNESS_DATABASE_VERSION = 2;

// Namespace below the supplied database root. The service passes DATABASE_ROOT
// (a shared storage boundary used by other distributions), so this package owns
// exactly one child directory and never writes at the root itself.
export const HARNESS_DATABASE_DIRECTORY = 'harness';

// v1 spelled the whole document into this one file. v2 does NOT write it, read it,
// rename it or delete it — it survives only as the artifact an operator (or an older
// build) can still recover, which is why the constant stays exported and why
// `noteLegacyHarnessDatabase` names it when it is found with no v2 index (see
// `HarnessPersistence.load`).
export const HARNESS_DATABASE_FILE = 'state.json';

// v2 layout names. `HARNESS_INDEX_FILE` is the document header and the only file whose
// absence means "first run"; `HARNESS_SESSION_FILE` and `HARNESS_THREAD_DIRECTORY` hang
// below `HARNESS_SESSION_DIRECTORY`, which IS the journal's directory (./journal.ts:90
// `HARNESS_JOURNAL_DIRECTORY`, joined with the raw id at ./journal.ts:253) so
// a session's checkpoint shards, its transcripts and its `events.jsonl` live in one
// footprint and a session delete removes exactly one directory.
export const HARNESS_INDEX_FILE = 'index.json';
export const HARNESS_SESSION_FILE = 'session.json';
export const HARNESS_THREAD_DIRECTORY = 'threads';
export const HARNESS_SESSION_DIRECTORY = HARNESS_JOURNAL_DIRECTORY;

// The thread-shard file name is `<threadId>.json`, so the id doubles as the file name and
// MUST be grammar-checked before it is path-joined: a hand-edited `../../x` in a persisted
// `core.threads[]` row would otherwise write (or read) outside the session directory. The
// pattern is the generated host-thread form, copied from the validator that already owns
// it (../core/snapshot.ts:862-866 with ../core/thread.ts:36 `THREAD_HOST_PREFIX`), and
// every id `snapshot()` mints satisfies it — the check is for foreign bytes, not for the
// store's own output.
export const HARNESS_THREAD_ID_PATTERN = /^thread-[1-9][0-9]*$/;

// The SAME containment rule, one level up: `sessions/<id>` is a directory whose name IS the
// session id, so an id read back from a hand-edited `index.json` as `../../x` would otherwise
// make `save()` write — and `eraseVanishedShards()` RECURSIVELY DELETE (`eraseTree`,
// ./persistence.ts:3057) — a tree outside `<databaseRoot>/harness` entirely.
//
// The grammar is deliberately WIDER than the thread id's: a session id is whatever
// `readSessionRecord` accepted (a non-blank string), and v1 documents exist with ids this
// server did not mint, so refusing them would refuse a store that loads fine today. What the
// LAYOUT requires is exactly one safe path segment, and that is what is required here: a
// leading alphanumeric (which alone rules out `.`, `..` and every `../..` form), then only
// characters that are safe in a file name on every platform this server targets. Every id
// `SessionStore` mints is a `randomUUID()` (./sessions.ts:2369), which satisfies this — the
// check is for foreign bytes, not for the store's own output.
export const HARNESS_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
    // pipeline T1.5's last mile (ADDITIVE): the plugin diagnostics this session reported, oldest
    // first, capped by `PLUGIN_DIAGNOSTIC_LIMIT` in ./sessions.ts. Durable because "this plugin
    // has been failing since before the restart" is a fact an operator needs AFTER a restart —
    // the whole point of installing a server sink for `report.diagnostic`.
    //
    // OPTIONAL in every direction, like `invalidThreads` above: a document written before T4 has
    // no field and loads unchanged, and an empty journal is written back as an absent key, so a
    // healthy session's `state.json` stays byte-identical to its pre-T4 shape.
    pluginDiagnostics?: SessionPluginDiagnostic[];
    // R4 (ADDITIVE, session-scoped config): THIS session's own plugin setting OVERRIDES — the
    // per-session twin of the document-level `HarnessDatabase.pluginSettings`, same
    // `plugin -> key -> JSON scalar` shape, and exactly the value `Session.plugins.snapshot()`
    // writes (./sessions.ts `sessionRecord`).
    //
    // WHY IT IS PER SESSION AND NOT JUST THE DOCUMENT FIELD
    // -----------------------------------------------------
    // The document field is the TEMPLATE: what a session copies down at creation. Once a
    // session exists its plugin configuration belongs to it alone, so its values have to be
    // durable here — otherwise a per-session edit would be re-seeded from the template on the
    // next restart and the operator's isolation would last exactly one reboot.
    //
    // OPTIONAL in both directions, like every additive field here: a pre-R4 document has no
    // field, loads unchanged, and restores at the plugin's DECLARED defaults (NOT at what the
    // template happens to say today — a template edit made after this session was created must
    // not reach a session that never asked for it). An empty map is written back as an absent
    // key, so a session that changed nothing keeps its exact previous `state.json` bytes.
    //
    // The loader is TOLERANT about this block (see ./sessions.ts `restoreSession` and
    // ./plugins.ts `applyRestore`): a stale plugin name, a retired key, or a hand-edited value
    // is dropped rather than refusing the record, because a plugin-settings override is
    // configuration an operator edits, not a load-bearing transcript. What survives is exactly
    // what the writer would have written.
    pluginSettings?: HarnessPluginSettingsRecord;
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

// R3 (ADDITIVE): the persisted shape of the GLOBAL tool switch — the tool NAMES this
// deployment has switched off, for every session and every thread at once.
//
// A DENY LIST, not a per-tool record: "everything is enabled unless listed" is the state
// every harness already has by default, so the document carries only the exceptions and a
// deployment that never opened the Tools pane keeps its exact previous shape (the field is
// optional in both directions, exactly like `pluginSettings`).
//
// Names, not definitions: the catalogue is composed at host startup (configuration plus
// credentials), so a stored name may legitimately not exist in this build. The store
// (./tool-settings.ts) keeps it anyway — re-adding the tool in a later release restores
// the operator's decision — and the runtime simply never consults a name it does not know.
// Every listed name is honoured on restore, the harness-owned control tools included: the
// switch applies to the whole catalogue (./tool-settings.ts R5), and this layer validates
// SHAPE only - it never decides which names are meaningful.
export type HarnessToolSettingsRecord = {
    disabled?: string[];
};

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
    //
    // R4: this is the TEMPLATE block — the map a new session copies down at creation
    // (./sessions.ts `create`, ./plugins.ts `copyPluginSettingsStore`). A session's own values
    // live beside the session (`HarnessSessionRecord.pluginSettings`), so a document now holds
    // the deployment's answer and each conversation's, and neither moves the other.
    pluginSettings?: HarnessPluginSettingsRecord;
    // R3 (ADDITIVE): the tool NAMES the operator has switched off GLOBALLY, written by
    // `PATCH /v1/harness/tools/{tool_id}` and read back at construction by the runtime's
    // tool settings store (./tool-settings.ts, via `SessionStore`). Absent means "nothing
    // is disabled", and an absent field stays absent on a round trip. Names only — the
    // deny-list rule that makes the common case store nothing at all.
    toolSettings?: HarnessToolSettingsRecord;
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

    // T14 gap (c): the LABELS a deletion stripped from this turn (./protocol.ts
    // `SessionTurn.strippedReferences`). Revalidated as labels, not free text, for exactly
    // the reason `threadLabel` above is: this list is what `composeReferences` injects as a
    // `#HEADING` when the turn runs, so a corrupt value would put a label the allocator can
    // never mint in front of the model. Only labels are stored — the vanished target IDS are
    // not, because a durable record must not name rows the document no longer lists. An
    // absent key (every document written before this build, and every turn that never lost a
    // reference) stays absent.
    const strippedReferences =
        record.strippedReferences === undefined
            ? undefined
            : (() => {
                  if (!Array.isArray(record.strippedReferences)) {
                      throw new TypeError(`${label}.strippedReferences must be an array.`);
                  }

                  return record.strippedReferences.map((entry, index) => {
                      const value = requireString(entry, `${label}.strippedReferences[${index}]`);
                      const parts = agentLabelParts(value);

                      if (parts === undefined) {
                          throw new TypeError(
                              `${label}.strippedReferences[${index}] must be a conversation label such as "RR1".`
                          );
                      }

                      return parts.label;
                  });
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

    // DISPLAY LANE (C1): the lane this turn started on (./protocol.ts `SessionTurn.lane`).
    // OPTIONAL and additive — a document written before lanes exist has no key and restores
    // to lane 0, and `copyTurn`/`readTurn` never write a 0, so every pre-lane record keeps
    // its exact bytes. A value must be an integer >= 0 for the same reason the contract
    // says `minimum: 0` (../shared/turn-display.ts `ContextBlock.lane`): a lane a renderer
    // cannot sort is worse than no lane, so a corrupt one fails the load like any other
    // corruption rather than restoring a bar that cannot be painted.
    //
    // The PER-EVENT lanes (./protocol.ts `SessionTurnEvent.lane`) need no reader of their
    // own: `events` stays opaque below — the harness's own event payloads are user content
    // the store never rewrites — so a recorded lane persists and replays verbatim, and
    // ./turn-projector.ts `laneOfEvent` treats anything that is not an integer >= 1 as
    // "no lane" instead of trusting a hand-edited document.
    const lane =
        record.lane === undefined
            ? undefined
            : (() => {
                  const value = requireNumber(record.lane, `${label}.lane`);

                  if (!Number.isInteger(value) || value < 0) {
                      throw new TypeError(`${label}.lane must be an integer >= 0.`);
                  }

                  return value;
              })();

    return {
        id: requireString(record.id, `${label}.id`),
        index: requireNumber(record.index, `${label}.index`),
        prompt: requireString(record.prompt, `${label}.prompt`),
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadLabel === undefined ? {} : { threadLabel }),
        // Written only when it is a real lane (> 0): absence IS lane 0 (the comment above),
        // so a restored row has the exact shape `copyTurn` produces for a lane-0 turn.
        ...(lane === undefined || lane === 0 ? {} : { lane }),
        ...(references === undefined ? {} : { references }),
        // T14 gap (c): the stripped labels, normalized and non-empty only (see the reader
        // above). An empty list is dropped so a restored row has the exact shape `copyTurn`
        // writes.
        ...(strippedReferences === undefined || strippedReferences.length === 0
            ? {}
            : { strippedReferences }),
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

    // pipeline T1.5's last mile: the plugin-diagnostics journal (see
    // `HarnessSessionRecord.pluginDiagnostics`). TOLERANT by design, unlike the fields above:
    // an entry that is not a diagnostic-shaped object is DROPPED rather than refusing the whole
    // record. This journal is observability, and a hand-edited or partially written entry must
    // not cost an operator the conversation next to it — the rule the strict fields can afford
    // (they are load-bearing) and this one cannot. Newest `PLUGIN_DIAGNOSTIC_LIMIT` entries win,
    // so a journal that grew past the cap on disk still restores the part an operator reads.
    const pluginDiagnostics = (() => {
        if (!Array.isArray(record.pluginDiagnostics)) return undefined;

        const kinds = new Set(['handler-threw', 'handler-timed-out', 'invalid-decision', 'policy']);
        const kept: SessionPluginDiagnostic[] = [];

        for (const value of record.pluginDiagnostics) {
            if (value === null || typeof value !== 'object') continue;

            const item = value as Record<string, unknown>;
            const kind = typeof item.kind === 'string' ? item.kind : '';

            // `owner` and `message` are the two fields that make the entry worth reading: an
            // entry naming neither who failed nor what happened is noise, so it is dropped.
            if (!kinds.has(kind) || typeof item.owner !== 'string' || typeof item.message !== 'string') continue;
            if (item.message.trim().length === 0) continue;

            kept.push({
                at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
                kind: kind as SessionPluginDiagnostic['kind'],
                owner: item.owner,
                message: item.message,
                ...(typeof item.event === 'string' ? { event: item.event } : {}),
                ...(item.data !== null && typeof item.data === 'object'
                    ? { data: item.data as Record<string, unknown> }
                    : {})
            });
        }

        if (kept.length === 0) return undefined;

        return kept.slice(-PLUGIN_DIAGNOSTIC_LIMIT);
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

    // R4 (durability): the SESSION's own plugin setting overrides, the per-session twin of the
    // document-level `pluginSettings` block below (see `HarnessSessionRecord.pluginSettings`).
    //
    // TOLERANT, and that is a deliberate difference from the document-level block, which is
    // strict about shape. Two reasons, both about blast radius:
    //   - a throw HERE is not "one bad field", it is `readHarnessDatabase` failing, which costs
    //     the operator EVERY session in the document — for a settings overlay whose whole
    //     content the runtime is willing to resolve to a default anyway;
    //   - the value is produced by `Session.plugins.snapshot()` (./sessions.ts `sessionRecord`),
    //     which can only ever emit catalogue-ordered JSON scalars, so anything else on disk is a
    //     hand edit or an older build, i.e. exactly the case the same file's
    //     `pluginDiagnostics` reader answers by dropping.
    //
    // What "tolerant" means concretely: a non-object block is dropped, a non-object plugin entry
    // is dropped, and a value that is not a finite number / boolean / string is dropped. Names
    // are NEVER checked against this build's catalogue — the store's own `restore`
    // (./plugins.ts `applyRestore`) is what decides whether a plugin or key still means anything,
    // so a plugin that ships again later gets its stored override back.
    //
    // Normalization keeps a load -> save round trip byte-stable: entries are re-emitted in the
    // document's own key order (the writer already emits catalogue order), and a block that ends
    // up empty — absent, `{}`, or all-dropped — normalizes to ABSENT, which is what the writer
    // emits for "this session changed nothing".
    const pluginSettings = (() => {
        const block = record.pluginSettings;

        if (block === undefined || block === null || typeof block !== 'object' || Array.isArray(block)) {
            return undefined;
        }

        const values: HarnessPluginSettingsRecord = {};

        for (const [plugin, raw] of Object.entries(block as Record<string, unknown>)) {
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;

            const settings: Record<string, number | string | boolean> = {};

            for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof value === 'number' && !Number.isFinite(value)) continue;
                if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
                    settings[key] = value as number | string | boolean;
                }
            }

            if (Object.keys(settings).length > 0) values[plugin] = settings;
        }

        return Object.keys(values).length === 0 ? undefined : values;
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
        // T1.5 last mile: restored as written (tolerant — see the reader above), and absent for
        // every document written before the field existed.
        ...(pluginDiagnostics === undefined ? {} : { pluginDiagnostics }),
        // R4: the session's own plugin overrides, tolerant-read and normalized (see the reader
        // above). Key order matches the writer (./sessions.ts `sessionRecord`, which emits this
        // field in the same position), so a load + save lands on the same bytes.
        ...(pluginSettings === undefined ? {} : { pluginSettings }),
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
    // this field (`databaseRecord`, ./sessions.ts:3488) and `createHarnessApi` reads it back at
    // construction (`store.globalSettings`, ./api.ts:1179) — but this loader dropped it, so a
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

    // T5 / R2-R3 (durability): the operator's per-plugin setting overrides FOR THE PROCESS/
    // TEMPLATE SCOPE (R4 — a session's own values live in its record, `HarnessSessionRecord
    // .pluginSettings`, and are read TOLERANTLY there; the difference is deliberate and stated
    // there).
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

    // R3 / the global tool switch (durability): the tool NAMES the operator switched off.
    //
    // Same discipline as `pluginSettings` two blocks above, in one fewer dimension:
    //   - OPTIONAL in both directions — a deployment that never touched the Tools pane
    //     keeps its exact previous document;
    //   - STRICT about shape: the slot must be an object, `disabled` must be an array of
    //     non-empty strings, and anything else is corruption of a named slot and throws
    //     like every other field here (a wrong shape is a bug; a stale NAME is not, so
    //     names are never checked against this build's catalogue);
    //   - normalized, not preserved: duplicates and blank entries are dropped and the
    //     order is sorted, because the writer emits a sorted set and a load->save round
    //     trip of a hand-edited file must land on the same bytes;
    //   - an empty list normalizes to ABSENT, because the writer never emits
    //     `{ disabled: [] }` — gating here is what keeps load -> save byte-stable.
    const toolSettings =
        record.toolSettings === undefined
            ? undefined
            : (() => {
                  const entry = requireRecord(record.toolSettings, 'The harness database toolSettings');

                  const unknown = Object.keys(entry).filter((key) => key !== 'disabled');

                  if (unknown.length > 0) {
                      throw new TypeError(
                          `The harness database toolSettings has unknown field(s): ${unknown.join(', ')}. Only "disabled" is defined.`
                      );
                  }

                  if (entry.disabled === undefined) return undefined;

                  const names = [...new Set(requireStringArray(entry.disabled, 'The harness database toolSettings.disabled'))]
                      .map((name) => name.trim())
                      .filter((name) => name.length > 0)
                      .sort((left, right) => left.localeCompare(right));

                  return names.length === 0 ? undefined : { disabled: names };
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
        // Same rule for the R3 tool switch: the writer (./sessions.ts `databaseRecord`)
        // emits it directly after `pluginSettings`, so a restored document keeps its order.
        ...(toolSettings === undefined ? {} : { toolSettings }),
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

    // RETENTION FIX: which calls are already answered is decided across the WHOLE transcript,
    // not only the `role:'tool'` block that follows an assistant message. An answer can legitimately
    // sit elsewhere — the kernel synthesizes its own interrupted-call result (../harness.ts), a
    // thread SPLIT moves the tail rows of a conversation into the child thread, and a merged
    // subagent transcript appends the rows it adopted — and in every one of those cases the
    // adjacency walk below never sees the existing result and writes a SECOND one for the same
    // `toolCallId`. Two results for one call is exactly what a provider request schema rejects, so
    // an "orphan" repair can manufacture the failure it exists to prevent, and the repair is not
    // idempotent across a restore. Collecting the ids first makes a message that already has an
    // answer anywhere in the transcript invisible to the repair, however it got there.
    const answeredIds = new Set<string>();

    for (const message of messages) {
        if (message.role !== 'tool') continue;

        const callId = message.toolCallId;

        if (typeof callId === 'string' && callId.length > 0) answeredIds.add(callId);
    }

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        output.push(message);

        // Only an assistant message can own tool calls.
        if (message.role !== 'assistant') continue;

        const calls = message.toolCalls;

        if (calls === undefined || calls.length === 0) continue;

        // Consume the contiguous tool-result block that follows this message.
        // Unknown/extra tool messages are preserved verbatim: they are evidence,
        // not something to discard while repairing.
        let cursor = index + 1;

        while (cursor < messages.length) {
            const result = messages[cursor];
            if (result.role !== 'tool') break;

            output.push(result);
            cursor++;
        }

        // Append missing results in call order, immediately after the existing
        // block so the provider sees one coherent assistant→tool(s) exchange. A call
        // answered further down the transcript is skipped — see `answeredIds` above.
        for (const call of calls) {
            if (answeredIds.has(call.id)) continue;

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
//   - the serialization of the WHOLE document, i.e. O(all sessions x all recorded
//     events). On the coordinator this is a synchronous block of the event loop
//     proportional to the database size.
//   - the syscalls: mkdir + open + write + fsync + close + rename.
//
// FORMAT (measured, T22): the payload is COMPACT `JSON.stringify`, not the historical
// two-space pretty-print. Nothing else about the document changed - same keys, same
// order, same values - so no database version bump is required: the reader gates on
// `version` only (`readHarnessDatabase`), never on whitespace, and JSON whitespace is
// insignificant by definition. The win is paid twice: stringify drops 407 ms to 242 ms
// on the live 110 MB document, and the bytes handed to write+fsync halve (110.0 MB to
// 54.6 MB), which is where the other half of the saving is.
// Pretty-printing was never a contract: every byte test in this package pins the file
// relative to THIS function (./io-client.test.ts, ./workers/io-worker.test.ts), so the
// inline and worker writers stay byte-identical whatever the spacing is.
//
// What stays on the coordinator no matter what (honest limit, restated in
// ./workers/io-client.ts): building the `HarnessDatabase` record itself, and the
// structured clone `postMessage` performs on it. Worker mode moves the stringify and
// every syscall off the loop; it cannot move the object graph it is handed.
export const serializeHarnessDatabase = (database: HarnessDatabase, savedAt = Date.now()): string =>
    JSON.stringify({ ...database, version: HARNESS_DATABASE_VERSION, savedAt });

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

// The commit primitive EVERY harness file shares — the whole-document writer below and
// every v2 shard below — as a function of data only.
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
//
// `stagingPrefix` is the only knob, and it names the staging FAMILY inside `directory`.
// The document writer keeps `state.json`, so the names an operator has always seen in a
// directory listing (`state.json.<pid>.<n>.tmp`, and `state.json.agents.<n>.tmp` for the
// T19 overlay that reuses this helper with `owner: 'agents'`) are exactly what they were.
// A shard commits under its OWN canonical name instead (`index.json.<pid>.<n>.tmp`,
// `thread-7.<pid>.<n>.tmp`), because a shard directory holds many files and one flat
// family named after a file that is not there would be unreadable.
const commitHarnessFile = (
    directory: string,
    file: string,
    stagingPrefix: string,
    payload: string,
    options: HarnessDatabaseWriteOptions = {}
): void => {
    const staging = path.join(
        directory,
        `${stagingPrefix}.${options.owner ?? process.pid}.${(options.sequence ?? createHarnessStagingSequence())()}.tmp`
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

// The atomic full-document commit, as a function of data only: one payload, one
// canonical file, one rename.
//
// v2 stores the database as shards, so this is no longer the store's own write path (see
// `writeHarnessShardFile` below, which IS shared with the IO worker). What it still owns is
// the document-shaped commit the T19 agent overlay performs (`writeHarnessAgentRecords`,
// whose bytes and staging family are unchanged). The IO worker is NOT a caller of this one:
// protocol v3 has no whole-document frame, so a worker only ever receives `shard.save` and
// `shard.erase`, and `serializeHarnessDatabase` stays exported for the tests that compare
// v1 single-file bytes with the shard set. Both forms keep the identical durability
// discipline; only WHERE bytes live differs.
export const writeHarnessDatabaseFile = (
    directory: string,
    file: string,
    payload: string,
    options: HarnessDatabaseWriteOptions = {}
): void => commitHarnessFile(directory, file, HARNESS_DATABASE_FILE, payload, options);

// ---------------------------------------------------------------------------
// THE v2 SHARD LAYER — one unit in, one file out
// ---------------------------------------------------------------------------
//
// WHY SHARDS AND NOT A BIGGER FILE
// --------------------------------
// A single file holding every session and every transcript is not a size problem only: it
// makes the COMMIT UNIT the whole population. One appended token in one conversation
// re-stringified and re-fsynced every session's every event (measured 816 ms per settled
// tool call on a live 110 MB document, ./sessions.ts `noteStateChange`), and the failure
// radius of one bad byte was every session in the file. With one file per conversation the
// commit unit is the conversation, the reader can validate one session at a time, and the
// cost of a checkpoint stops growing with the sessions nobody is looking at.
//
// WHAT DID NOT MOVE
// -----------------
// Only the transcripts left the session record. The turns, `queue`, both label maps and
// both high-waters, `labelSeeds`, `turnInvocations`, `invocationThreads`, `invalidThreads`,
// the inactive-thread ledger, `core.agents`/`agentResults`/`records`/`createdTools`/
// `discovery`, the frozen preset and the plugin overrides all stay inside `session.json`,
// because they are one logical record that must not be able to disagree with each other.
// `events.jsonl` (./journal.ts) and `agents.json` (below) are untouched.
//
// ONE DEFINITION OF THE FORMAT
// ----------------------------
// `serializeHarnessShard` + `writeHarnessShardFile` are the per-unit twins of
// `serializeHarnessDatabase` + `writeHarnessDatabaseFile`: the IO worker
// (./workers/io-worker.ts) commits the same bytes on its own thread through THESE, so
// byte-identity between the inline and the worker path stays a property of the code. Both
// are pure functions of the unit — the unit carries its own destination directory, which is
// why a worker can be handed a unit and needs no instance state.
//
// `payload` is optional on every unit for the same reason the document form is split in
// two: the worker has to know the byte length BEFORE the first syscall (its frame-size
// guard), so it serializes once, measures, and hands the payload to the writer. A caller
// that does not care leaves it out and the writer serializes.

// One entry of `index.json`: the session's id and its creation position. `ordinal` is the
// 1-based index in the array and is INFORMATIONAL — the array order is the order, and a
// reader that ignores it still restores the same database. It exists so a human (or a
// future tool) can tell which conversation came first without opening the records.
export type HarnessIndexSessionEntry = {
    id: string;
    ordinal: number;
};

// The harness-level document (`HarnessDatabase` minus the session records). Key order is
// fixed here and mirrors `readHarnessDatabase`'s output and ./sessions.ts
// `databaseRecord()`, so a load -> save cycle lands on the same bytes.
export type HarnessIndexDocument = {
    version: typeof HARNESS_DATABASE_VERSION;
    savedAt: number;
    registry: HarnessPresetRecord[];
    deleted?: string[];
    globalSettings?: HarnessGlobalSettingsRecord;
    pluginSettings?: HarnessPluginSettingsRecord;
    toolSettings?: HarnessToolSettingsRecord;
    sessions: HarnessIndexSessionEntry[];
};

// The three units, discriminated by `kind`. `directory` is always the directory the
// canonical file lives IN, so the commit is a same-directory rename (the atomicity
// requirement `commitHarnessFile` states).
export type HarnessIndexShardUnit = {
    kind: 'index';
    directory: string;
    document: HarnessIndexDocument;
    payload?: string;
};

// `record` is the session record with every `core.threads[]` row stripped of `messages`
// (see `splitHarnessSessionRecord`); the payload is the record itself, with no envelope —
// the format version is the header's, which is the only file a reader opens first.
export type HarnessSessionShardUnit = {
    kind: 'session';
    directory: string;
    sessionId: string;
    record: HarnessSessionRecord;
    payload?: string;
};

export type HarnessThreadShardUnit = {
    kind: 'thread';
    directory: string;
    sessionId: string;
    id: string;
    messages: unknown;
    payload?: string;
};

export type HarnessShardUnit = HarnessIndexShardUnit | HarnessSessionShardUnit | HarnessThreadShardUnit;

// The transcript shard's file name. Grammar-checked because the id IS the name: an id read
// back from a hand-edited `session.json` could otherwise address a path outside the
// session directory (`../..`). The pattern is `HARNESS_THREAD_ID_PATTERN`'s, i.e. the form
// ../core/snapshot.ts:862-866 already requires of a persisted thread id.
export const harnessThreadShardName = (id: string): string => {
    if (!HARNESS_THREAD_ID_PATTERN.test(id)) {
        throw new HarnessPersistenceError(
            id,
            `A thread shard name must be a generated host thread id ("thread-<n>"); "${id}" cannot be stored as a file.`
        );
    }

    return `${id}.json`;
};

// The `sessions/<id>` segment. Grammar-checked because the id IS the name, exactly like
// `harnessThreadShardName` above is checked for a thread id — see `HARNESS_SESSION_ID_PATTERN`
// for the reason (a traversal id reaches `eraseTree`, which deletes recursively).
//
// Throws rather than joins, and throws naming the ID: at the call sites that matter (`load()`)
// the caller wraps it in the fatal `index.json` shape error, and everywhere else the id is the
// only useful thing the message can name.
export const harnessSessionShardName = (id: string): string => {
    if (!HARNESS_SESSION_ID_PATTERN.test(id)) {
        throw new HarnessPersistenceError(
            id,
            `A session directory name must be one safe path segment ("[A-Za-z0-9][A-Za-z0-9._-]*"); "${id}" cannot be stored as a file.`
        );
    }

    return id;
};

// The three shard paths. `sessionId` is grammar-checked, NOT escaped: the store only ever
// addresses sessions by the id it mints, and an id that came from a file is refused by the
// grammar instead of being path-joined into a directory the writer then deletes recursively.
// (The journal still joins the raw id with no sanitiser, ./journal.ts:253 — the difference is
// that a journal only ever writes ONE file inside the segment, while this layer also removes
// whole trees.)
export const harnessSessionDirectoryOf = (directory: string, sessionId: string): string =>
    path.join(directory, HARNESS_SESSION_DIRECTORY, harnessSessionShardName(sessionId));

export const harnessSessionFileOf = (directory: string, sessionId: string): string =>
    path.join(harnessSessionDirectoryOf(directory, sessionId), HARNESS_SESSION_FILE);

export const harnessThreadDirectoryOf = (directory: string, sessionId: string): string =>
    path.join(harnessSessionDirectoryOf(directory, sessionId), HARNESS_THREAD_DIRECTORY);

// Throws (rather than joins) when the thread id cannot be a file name — see
// `harnessThreadShardName`. `save()` never reaches it for store-generated ids; `load()`
// guards with the pattern before calling, so a foreign id degrades into the existing
// transcript tolerance instead of an error.
export const harnessThreadFileOf = (directory: string, sessionId: string, id: string): string =>
    path.join(harnessThreadDirectoryOf(directory, sessionId), harnessThreadShardName(id));

// ---------------------------------------------------------------------------
// Read-side helpers (tolerant shape checks — they must NOT throw)
// ---------------------------------------------------------------------------
//
// The strict validators live in `readHarnessDatabase` and run ONCE on the merged graph, so
// the reader below can afford to only ever classify a value. Everything that is not the
// expected shape becomes either a header/record failure (the caller builds the error, with
// the shard's own path in it) or a tolerated transcript, and never a half-parsed object.
const recordOrNull = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

// The document-level fields of a parsed `index.json` WITHOUT its `sessions` list — i.e.
// exactly the input `readHarnessDatabase` needs to validate the header, and the object the
// merged document is built from. Key order of the v1 document is preserved (version,
// savedAt, registry, then the optional operator blocks), which is what keeps a
// load -> save cycle byte-stable.
const harnessHeaderFieldsOf = (header: Record<string, unknown>): Record<string, unknown> => ({
    version: header.version,
    savedAt: header.savedAt,
    registry: header.registry,
    ...(header.deleted === undefined ? {} : { deleted: header.deleted }),
    ...(header.globalSettings === undefined ? {} : { globalSettings: header.globalSettings }),
    ...(header.pluginSettings === undefined ? {} : { pluginSettings: header.pluginSettings }),
    ...(header.toolSettings === undefined ? {} : { toolSettings: header.toolSettings })
});

// The v1 wording, one file deeper: an operator comparing a message with the directory sees
// the same sentence they saw before sharding, naming the file that actually failed.
const harnessShapeError = (file: string, reason: unknown): Error =>
    new HarnessPersistenceError(file, `The harness database has an invalid shape or version: ${messageOf(reason)}`);

// What a row gets when the transcript FILE its row names is not there.
//
// A STRING, deliberately: ./sessions.ts `restoreSession` runs `repairInterruptedToolCalls`
// (./persistence.ts:1877, and `repairAgentMessages` (:1804) starts with a `for...of` over `messages`)
// BEFORE it reaches `tolerateThreadTranscripts`, so the only non-array value that can survive
// that pipeline is one the scan can walk — which is exactly why the pre-shard store already
// tolerated a stored STRING in `messages` and reported it through `invalidThreads`. An empty
// ARRAY would have been silent data loss (the conversation reads as "no messages", nothing is
// reported), and throwing here would refuse every OTHER session in the database the way the
// single-file document did, i.e. a WIDER blast radius than one transcript file ever earned.
//
// The value is transient in the normal path: `tolerateThreadTranscripts` replaces it with its
// own placeholder transcript, and the marker survives only as the raw value in
// `invalidThreads.messages` (the C4 surface that shows an operator what the store held), beside
// the precise path noted by `noteMissingThreadTranscript`. A document read this way and written
// back WITHOUT a store restore (the loader is also how ./runtime.ts and ./start.ts read the
// registry) persists the marker as that shard's `messages`; the next read refuses it again, so
// the state is stable and never throws rather than silently becoming an empty transcript.
export const HARNESS_MISSING_THREAD_TRANSCRIPT = 'the thread transcript file is missing';

// The transcript one thread shard carries.
//
// A well-formed envelope hands back `messages` EXACTLY as stored — including a value that
// is not a message array at all, because ./sessions.ts `readHarnessMessages` (through
// `tolerateThreadTranscripts`) is the component that explains a broken transcript, and its
// message must be the one the operator reads. Anything else — not JSON, a bare array, an
// object with no `messages` key — hands back the RAW TEXT, which the same tolerance refuses
// and then records verbatim in `invalidThreads.messages`: the C4 rule that a broken
// transcript must survive as the bytes the user submitted, not as a repaired guess.
const harnessThreadTranscriptOf = (text: string): unknown => {
    try {
        const envelope = recordOrNull(JSON.parse(text) as unknown);

        if (envelope !== undefined && 'messages' in envelope) return envelope.messages;
    } catch {
        // Not JSON at all: fall through and hand back the text.
    }

    return text;
};

// The canonical file of a unit. Pure: no mkdir, no existence check.
export const harnessShardFileOf = (unit: HarnessShardUnit): string => {
    if (unit.kind === 'index') return path.join(unit.directory, HARNESS_INDEX_FILE);
    if (unit.kind === 'session') return path.join(unit.directory, HARNESS_SESSION_FILE);

    return path.join(unit.directory, harnessThreadShardName(unit.id));
};

// The document-level fields of a database, as the bytes `index.json` holds. `savedAt` is
// stamped here (default: now) exactly like `serializeHarnessDatabase` stamped it, and it is
// the ONLY wall-clock stamp in the layout: a session or a thread shard is content, so its
// bytes must not move when nothing in it changed, or the digest gate could never skip it.
export const harnessIndexDocumentOf = (
    database: HarnessDatabase,
    savedAt = Date.now()
): HarnessIndexDocument => ({
    version: HARNESS_DATABASE_VERSION,
    savedAt,
    registry: database.registry,
    // Every optional block keeps the omit-when-absent rule the document always had, so a
    // deployment that never touched `/config`, the Plugins pane or the Tools pane writes
    // exactly the fields it wrote before sharding existed.
    ...(database.deleted === undefined ? {} : { deleted: database.deleted }),
    ...(database.globalSettings === undefined ? {} : { globalSettings: database.globalSettings }),
    ...(database.pluginSettings === undefined ? {} : { pluginSettings: database.pluginSettings }),
    ...(database.toolSettings === undefined ? {} : { toolSettings: database.toolSettings }),
    // Live-map insertion order, preserved verbatim: the order v1's document carried, and
    // the order `load()` restores in.
    sessions: database.sessions.map((record, position) => ({ id: record.id, ordinal: position + 1 }))
});

// Splits a session record into the bytes that belong in `session.json` and the transcripts
// that belong in `threads/<id>.json`.
//
// WHY A COPY AND NOT AN EDIT: the record handed in is the LIVE one. ./sessions.ts
// `sessionRecord()` builds `core` from the snapshot of a running harness, and that object
// stays in use after this call returns — deleting `messages` in place would empty the
// conversations of a session that is still running.
//
// A row whose id is not a generated host id KEEPS its `messages` inline: it has no safe
// file name, and dropping the transcript would lose bytes v1 stored. Such a row is refused
// by ../core/snapshot.ts on restore anyway, so inline is the option that cannot make the
// situation worse (and `load()` does not go looking for a shard of it).
export const splitHarnessSessionRecord = (record: HarnessSessionRecord): {
    // The record to serialize. The SAME object when there was nothing to split.
    record: HarnessSessionRecord;
    // The transcripts, in `core.threads` array order — the order the shard set is written
    // and the order `load()` re-attaches them in.
    transcripts: { id: string; messages: unknown }[];
} => {
    const core = record.core as unknown as { threads?: unknown };

    if (!Array.isArray(core.threads)) return { record, transcripts: [] };

    const transcripts: { id: string; messages: unknown }[] = [];
    const rows = (core.threads as unknown[]).map((entry) => {
        if (entry === null || typeof entry !== 'object') return entry;

        const row = entry as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id : undefined;

        // Nothing to move (a row without `messages` is the torn state `load()` produces, and
        // an id that cannot be a file name stays inline) — keep the row exactly as it is.
        if (id === undefined || !('messages' in row) || !HARNESS_THREAD_ID_PATTERN.test(id)) return row;

        transcripts.push({ id, messages: row.messages });

        const copy: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(row)) {
            if (key === 'messages') continue;
            copy[key] = value;
        }

        return copy;
    });

    return {
        record: { ...record, core: { ...record.core, threads: rows } as unknown as HarnessSnapshot },
        transcripts
    };
};

// The bytes of one unit. Compact `JSON.stringify`, the same format decision (and the same
// measured win) `serializeHarnessDatabase` documents: whitespace is not a contract, every
// byte test in this package pins the file relative to the serializer, and the reader gates
// on `version` only.
export const serializeHarnessShard = (unit: HarnessShardUnit): string => {
    if (unit.kind === 'index') return JSON.stringify(unit.document);

    // The record itself, exactly as produced: no envelope, no timestamp, no version. A
    // session shard means nothing outside the header that lists it, and a version field
    // here would be a second gate that can disagree with the first.
    if (unit.kind === 'session') return JSON.stringify(unit.record);

    // A transcript DOES carry the version and its session: the file is the smallest unit a
    // recovery tool (or a human) picks up alone, and `sessionId` is what ties it back to
    // the record that indexes it.
    return JSON.stringify({
        version: HARNESS_DATABASE_VERSION,
        sessionId: unit.sessionId,
        id: unit.id,
        messages: unit.messages
    });
};

// A unit's payload: the pre-computed one when the caller supplied it (the IO worker's
// frame-size guard needs the length before the first syscall), serialized otherwise.
const harnessShardPayloadOf = (unit: HarnessShardUnit): string => unit.payload ?? serializeHarnessShard(unit);

// sha256 of a payload — the value `HarnessPersistence.save` compares against the last bytes
// it committed, so an unchanged shard is never opened. Hash, not the payload itself:
// retaining every transcript's text to answer "did this change?" would cost as much memory
// as the file the split exists to stop rewriting.
//
// EXPORTED because the IO worker (./workers/io-worker-loop.ts) runs the SAME gate on its own
// thread: "unchanged" has to mean the same sha256 in both write modes, or the two modes would
// disagree about which shards a commit is allowed to skip.
export const harnessShardDigest = (payload: string): string => createHash('sha256').update(payload, 'utf8').digest('hex');

// What one writer remembers about a shard it committed: the digest of the bytes it wrote, and
// the state the FILE was in right afterwards.
export type HarnessShardCommitStamp = {
    digest: string;
    size: number;
    mtimeMs: number;
};

// The cheap witness that a shard has not been touched since it was committed: `size` +
// `mtimeMs`, for the price of ONE `statSync`.
//
// WHY THE DIGEST ALONE IS NOT ENOUGH (v1 parity, and the reason this exists): v1 rewrote the
// whole document on every commit, so an out-of-band edit to the file was silently reverted by
// the next save. A digest-only skip CANNOT notice that edit — the payload it hashes is the
// writer's own bytes, which did not change — so the divergence would persist for the whole life
// of the process and then be adopted silently at the next restart. The stat closes that gap:
// an edit that changes the size is caught by `size`, and an edit that keeps the size moves
// `mtimeMs`.
//
// `undefined` (a stat that failed: the file is gone, or its directory is unreadable) means "no
// witness", and every caller treats it as CHANGED. That direction is the only safe one: a
// redundant write costs a syscall, a wrong skip loses the self-heal.
export const harnessShardStampOf = (file: string): { size: number; mtimeMs: number } | undefined => {
    try {
        const stat = fs.statSync(file);

        return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
        // Missing or unstatable: no witness, so the caller writes.
        return undefined;
    }
};

// The stamp to record for bytes that are now ON DISK at `file`. When the file cannot be
// statted right after the commit, `size` falls back to the payload's own length and `mtimeMs`
// to 0 — a value no real `mtimeMs` can equal, so the only possible consequence is one extra
// write on the next commit, never an unsound skip.
export const harnessShardCommitStampOf = (file: string, digest: string, payload: string): HarnessShardCommitStamp => {
    const stamp = harnessShardStampOf(file);

    return { digest, size: stamp?.size ?? payload.length, mtimeMs: stamp?.mtimeMs ?? 0 };
};


// Commit one shard: serialize (unless the payload was handed in), then the same
// staging + fsync + same-directory rename the document commit has always used, under the
// shard's own directory. `options` follows `HarnessDatabaseWriteOptions` unchanged — the
// worker's `owner` token and per-writer `sequence` apply per SHARD, and one sequence per
// writer is enough because each shard's staging name also carries its own file name.
export const writeHarnessShardFile = (unit: HarnessShardUnit, options: HarnessDatabaseWriteOptions = {}): void => {
    const file = harnessShardFileOf(unit);

    commitHarnessFile(unit.directory, file, path.basename(file), harnessShardPayloadOf(unit), options);
};

// Durable document owner for one resolved root.
export class HarnessPersistence {
    // `<databaseRoot>/harness`. Also the journal's root (./sessions.ts builds
    // `new HarnessJournal(this.persistence.directory, id)`), so ONE namespace below the
    // deployment's storage root holds every harness file this package owns.
    readonly directory: string;

    // v2's document header: `<databaseRoot>/harness/index.json`.
    //
    // The property keeps the name `file` on purpose: ./runtime.ts, ./start.ts, the restore
    // diagnostics in ./sessions.ts and the io client (./workers/io-client.ts:626) all
    // address "the file this store commits to" through it, so every operator-facing message
    // that used to name the single document now names the header — the file they have to
    // open first. A message about ONE SESSION names `sessionFile(sessionId)` instead
    // (./sessions.ts:4454), which is the file that actually holds that session.
    readonly file: string;

    // The v1 single-file store, kept as a PATH so `noteLegacyHarnessDatabase` can name it.
    // This class never reads, writes, renames or deletes it — an upgrade starts empty next
    // to a file an older build can still open.
    readonly legacyFile: string;

    // Post-increment staging suffix: unique per process and write, so a stale
    // staging file from a crashed write is never reused. The counter is a writer
    // property (not a module one) because the IO worker runs the same primitives in
    // this process with its own `owner` token — see `writeHarnessShardFile`. One
    // sequence serves every shard of this writer: each staging name also carries the
    // shard's own file name, so two shards committed by one call cannot collide.
    private staging = createHarnessStagingSequence();
    private lastError: string | undefined;

    // The last bytes THIS writer committed, per shard, as `canonical path -> { digest, size,
    // mtimeMs }`. This is the incremental-commit gate (R5): a shard whose payload hashes to the
    // stored digest AND whose file still carries the stored witness was already written by this
    // writer and is not opened at all. `load()` primes it from the bytes it read, so the first
    // save after a restart costs only what changed.
    //
    // The witness is what makes the skip SELF-HEALING, which is v1's behaviour and the reason the
    // witness exists: v1 rewrote the whole document every commit, so an edit made out of band was
    // reverted by the next save. A digest-only skip cannot see such an edit (it hashes the
    // writer's OWN bytes), so the divergence would survive for the life of the process and be
    // adopted silently at the next restart. `harnessShardStampOf` states the rule.
    private shardDigests = new Map<string, HarnessShardCommitStamp>();

    // The shard footprint this writer last committed: which sessions have a `session.json`,
    // and which threads have a shard. A commit erases exactly what these sets name and the
    // new document no longer names (a deleted session, a transcript retired by the 256-record
    // cap) — no directory scan, and no garbage collection of files this writer never wrote.
    private writtenSessionIds = new Set<string>();
    private writtenThreadIds = new Map<string, Set<string>>();

    // Restore diagnostics this store observed while reading (see `restoreDiagnostics`).
    private readonly restoreNotes: string[] = [];
    private legacyNoted = false;

    // Injectable twin of `SessionStoreOptions.onRestoreError` (./sessions.ts:876), for the
    // diagnostics `load()` has to report BEFORE the store exists: ./runtime.ts:178 and
    // ./start.ts:166 read the database to rebuild the registry, so nothing that could wire
    // the store's reporter is built yet. A host that wants these lines on its own channel
    // sets this; the fallback is stderr with the store's own `[harness]` prefix, i.e. the
    // exact convention `noteRestoreError` uses (./sessions.ts:4465-4480).
    onRestoreNote?: (error: Error) => void;

    constructor(root: string) {
        if (typeof root !== 'string' || root.trim().length === 0) {
            throw new HarnessPersistenceError('', 'A harness database root must be a non-empty string.');
        }

        this.directory = path.join(resolveHarnessDatabaseRoot(root), HARNESS_DATABASE_DIRECTORY);
        this.file = path.join(this.directory, HARNESS_INDEX_FILE);
        this.legacyFile = path.join(this.directory, HARNESS_DATABASE_FILE);
    }

    // The shard footprint this store last saw, in the SAME form `save()` compares against:
    // which sessions have a `session.json`, and which conversations have a
    // `threads/<id>.json`. After a `load()` it is the truth about the tree on disk; before any
    // load it is empty.
    //
    // WHY THIS IS PUBLIC: the io client (./workers/io-client.ts) primes its worker-mode erase
    // footprint from exactly this value, so the two write modes delete exactly the same orphan
    // shards (R3 parity). A worker never reads the tree — reads stay on the coordinator
    // (./workers/io-protocol.ts) — so without this the client would only ever learn the
    // footprint from the first document it writes, and a session that was on disk at startup
    // and gone from the first document would keep its shards in worker mode while inline
    // removed them.
    get shardFootprint(): { sessions: readonly string[]; threads: Record<string, readonly string[]> } {
        const threads: Record<string, readonly string[]> = {};

        for (const [sessionId, ids] of this.writtenThreadIds) threads[sessionId] = [...ids];

        return { sessions: [...this.writtenSessionIds], threads };
    }

    // One session's record file (`sessions/<id>/session.json`) — the path a session-scoped
    sessionFile(sessionId: string): string {
        return harnessSessionFileOf(this.directory, sessionId);
    }

    // Last write failure, observable even from a background transition where a
    // throw would change a run's outcome. Cleared by the next successful save.
    get lastWriteError(): string | undefined {
        return this.lastError;
    }

    // Everything this store observed while READING that is neither a thrown failure nor a
    // lost session — today only the v1 single-file store it refused to open. Reported once,
    // kept for a host that asks after the fact (the same shape as `SessionStore`'s
    // `restoreErrors`, ./sessions.ts:1969, which this cannot feed because the load happens
    // before the store is constructed).
    get restoreDiagnostics(): readonly string[] {
        return this.restoreNotes;
    }

    // Reads one shard, or `undefined` when the file simply is not there. ONLY ENOENT counts
    // as absent: an EACCES, EISDIR or EIO is a real failure and throws naming the shard,
    // exactly like the v1 reader refused to turn an unreadable file into "no sessions".
    private readShardText(file: string, label: string): string | undefined {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;

            throw new HarnessPersistenceError(file, `Could not read ${label}: ${messageOf(error)}`);
        }
    }

    // One restore note, reported ONCE per exact sentence.
    //
    // `load()` can run more than once per process (the store re-reads after a fork, and the
    // host may inspect the database directly), and an operator comparing a server log with a
    // directory should see a given anomaly once — the same rule `noteLegacyHarnessDatabase`
    // holds for the v1 store. The channel is the injectable reporter when a host set one, and
    // stderr with the store's own `[harness]` prefix otherwise, i.e. the exact convention
    // `noteRestoreError` uses (./sessions.ts:4465-4480).
    private noteRestore(message: string, prefix: string): void {
        if (this.restoreNotes.includes(message)) return;

        this.restoreNotes.push(message);

        if (this.onRestoreNote !== undefined) {
            try {
                this.onRestoreNote(new Error(message));
            } catch {
                // Observability only; the read already produced its outcome.
            }

            return;
        }

        console.error(`[harness] ${prefix}: ${message}`);
    }

    // The v1 store, reported ONCE and never touched (rule: no migration). A `state.json`
    // with no `index.json` beside it means "this root was written by an older build": this
    // build starts empty, and the operator is told where their sessions still are instead
    // of watching an empty rail and assuming they were deleted.
    private noteLegacyHarnessDatabase(): void {
        if (this.legacyNoted) return;

        // `existsSync` cannot throw, and must-not-throw is the point: an unreadable root
        // still has to reach the loader, whose read failure is the actionable error.
        if (!fs.existsSync(this.legacyFile)) return;

        this.legacyNoted = true;

        this.noteRestore(
            `The harness database at ${this.legacyFile} is the single-file v1 store, which this build ` +
                `(database version ${HARNESS_DATABASE_VERSION}) cannot read; it is not read, rewritten, renamed or ` +
                `deleted, so an older build can still open it. This build starts empty and writes its own v2 layout ` +
                `(${HARNESS_INDEX_FILE} plus ${HARNESS_SESSION_DIRECTORY}/<sessionId>/**) beside it.`,
            'skipped the v1 harness database'
        );
    }

    // A row that names a transcript file which is not there. The tolerance keeps the session
    // alive, so this is the line that says WHAT happened and WHERE: `invalidThreads.error` can
    // only ever be the validator's sentence ("messages must be an array"), because the reader
    // hands that path a marker string rather than inventing a failure of its own.
    private noteMissingThreadTranscript(sessionId: string, threadId: string, file: string): void {
        this.noteRestore(
            `Session "${sessionId}" conversation "${threadId}" names the transcript file ${file}, which is ` +
                `missing; the conversation is kept with a placeholder transcript and reported as unreadable.`,
            'a thread transcript file is missing'
        );
    }

    // Re-reads the v2 tree as the ONE object graph the rest of this package has always
    // received: sessions in `index.json` order, each `core.threads[]` row carrying the
    // `messages` that now live in `threads/<id>.json`, and the identical
    // `readHarnessDatabase` validation on the merged result. Signature and return shape are
    // unchanged, which is what lets ./sessions.ts, ./runtime.ts and ./start.ts stay exactly
    // as they were.
    //
    // Blast radius (stated in the file header, unchanged from v1): an unreadable,
    // unparseable, wrong-version or structurally invalid HEADER throws naming `index.json`,
    // and so does a session record that cannot be parsed or attached — in v1 the same broken
    // record sat inside the one document and refused the whole load. Only a THREAD shard is
    // tolerated, through the tolerance that already exists (see `attachThreadTranscripts`).
    load(): HarnessDatabase | undefined {
        const indexText = this.readShardText(this.file, 'the harness database');

        if (indexText === undefined) {
            // First run (nothing was ever written here), or a root that only holds a v1
            // store. Either way the caller gets `undefined` and builds an empty database.
            this.shardDigests = new Map<string, HarnessShardCommitStamp>();
            this.writtenSessionIds = new Set<string>();
            this.writtenThreadIds = new Map<string, Set<string>>();

            this.noteLegacyHarnessDatabase();

            return undefined;
        }

        // Priming for the incremental gate, collected while reading and SWAPPED IN at the
        // end: a load that throws leaves the previous state alone instead of half-primed.
        // Each entry is the digest of the bytes just read PLUS the file's `size`/`mtimeMs`
        // witness, so the first save after a restart can still tell "on disk, unchanged since I
        // read it" (skip) from "someone edited it while I was not looking" (rewrite) — see
        // `harnessShardStampOf`.
        const digests = new Map<string, HarnessShardCommitStamp>([
            [this.file, harnessShardCommitStampOf(this.file, harnessShardDigest(indexText), indexText)]
        ]);
        const sessionIds = new Set<string>();
        const threadIds = new Map<string, Set<string>>();

        let parsed: unknown;

        try {
            parsed = JSON.parse(indexText);
        } catch (error) {
            throw new HarnessPersistenceError(
                this.file,
                `The harness database is not valid JSON: ${messageOf(error)}`
            );
        }

        const header = recordOrNull(parsed);

        // The `sessions` list is the ONLY thing `readHarnessDatabase` cannot validate here:
        // the header's list is `[{ id, ordinal }]`, not records, so its array-ness is checked
        // here and its CONTENTS are what the loop below opens.
        if (header === undefined || !Array.isArray(header.sessions)) {
            throw harnessShapeError(
                this.file,
                header === undefined ? 'The harness database must be an object.' : 'The harness database sessions must be an array.'
            );
        }

        // The header's own fields — version first, then the registry and the three operator
        // blocks — go through the validator that already owns them, with an empty session
        // list standing in for the shards. A v1/v3/999 header is therefore refused before a
        // single field is interpreted with today's meanings, with the v1 wording.
        try {
            readHarnessDatabase({ ...harnessHeaderFieldsOf(header), sessions: [] });
        } catch (error) {
            throw harnessShapeError(this.file, messageOf(error));
        }

        const sessions: unknown[] = [];

        for (const [position, entry] of (header.sessions as unknown[]).entries()) {
            const listed = recordOrNull(entry);
            const id = listed === undefined || typeof listed.id !== 'string' ? undefined : listed.id;

            if (id === undefined || id.trim().length === 0) {
                throw harnessShapeError(this.file, `sessions[${position}] must name a session id.`);
            }

            // v1 caught a duplicated id in `readHarnessDatabase`; here it would be two
            // records under one path, so it is refused with the same message first.
            if (sessionIds.has(id)) {
                throw harnessShapeError(this.file, `The harness database lists session "${id}" more than once.`);
            }

            // The id is a DIRECTORY NAME, so it goes through the same grammar the thread id's
            // gets (`HARNESS_THREAD_ID_PATTERN` / `harnessThreadShardName`, refused at
            // `attachThreadTranscripts`): a hand-edited `../../x` here would address — and on
            // the next commit `eraseTree` would recursively DELETE — a tree outside
            // `<databaseRoot>/harness`. Refused HERE, fatally and naming `index.json`, in the
            // exact shape a bad snapshot already takes: an operator has to be told the header
            // names a session this build will not open a file for, not watch a session quietly
            // vanish or a sibling directory disappear. `harnessSessionShardName` is the backstop
            // for every other call site (`save()`, the io client's split); this is the one that
            // decides whether the store starts at all.
            if (!HARNESS_SESSION_ID_PATTERN.test(id)) {
                throw harnessShapeError(
                    this.file,
                    `sessions[${position}] names session "${id}", which is not one safe path segment ("[A-Za-z0-9][A-Za-z0-9._-]*") and so has no shard directory.`
                );
            }

            const sessionFile = harnessSessionFileOf(this.directory, id);
            const sessionText = this.readShardText(sessionFile, 'the harness session record');

            if (sessionText === undefined) {
                throw new HarnessPersistenceError(
                    sessionFile,
                    `Could not read the harness session record: ${HARNESS_INDEX_FILE} lists session "${id}" at position ` +
                        `${position}, but its record file is missing. The shard was removed after the header was committed; ` +
                        `nothing was deleted by this build.`
                );
            }

            digests.set(sessionFile, harnessShardCommitStampOf(sessionFile, harnessShardDigest(sessionText), sessionText));
            sessionIds.add(id);

            let sessionDocument: unknown;

            try {
                sessionDocument = JSON.parse(sessionText);
            } catch (error) {
                throw new HarnessPersistenceError(
                    sessionFile,
                    `The harness session record is not valid JSON: ${messageOf(error)}`
                );
            }

            this.attachThreadTranscripts(id, sessionDocument, digests, threadIds);

            sessions.push(sessionDocument);
        }

        this.shardDigests = digests;
        this.writtenSessionIds = sessionIds;
        this.writtenThreadIds = threadIds;

        // One validation of one merged graph — the same call, the same messages
        // (`sessions[<position>]...` is the position in `index.json`'s order) and the same
        // all-or-nothing outcome the v1 document had.
        try {
            return readHarnessDatabase({ ...harnessHeaderFieldsOf(header), sessions });
        } catch (error) {
            throw harnessShapeError(this.file, messageOf(error));
        }
    }

    // Puts every thread transcript back on the rows that index it, IN THE ORDER
    // `session.json` lists those rows (the array order the store's roster and the 256-record
    // cap both depend on), and records the shard bytes for the digest gate.
    //
    // Torn-set rule (6): a row whose shard is NOT there gets `HARNESS_MISSING_THREAD_TRANSCRIPT`
    // as its transcript and a loud diagnostic naming the missing path. The pre-shard store could
    // not produce that shape (the transcript sat inside the record), so this is the narrow
    // reading of it: ./sessions.ts `restoreSession` repairs tool calls BEFORE it tolerates
    // transcripts (`./sessions.ts:4321` then `:4335`), and only a string survives the first step,
    // so `tolerateThreadTranscripts` records the thread in `invalidThreads` with its placeholder
    // transcript and lets the session restore (./sessions.ts:3818). An unparseable shard, or
    // one that is not an envelope, hands back its RAW TEXT instead, so the bytes survive in
    // `invalidThreads.messages` for the editor to show — the C4 rule for an unreadable
    // transcript, applied to a file instead of a field.
    private attachThreadTranscripts(
        sessionId: string,
        document: unknown,
        digests: Map<string, HarnessShardCommitStamp>,
        threadIds: Map<string, Set<string>>
    ): void {
        // Every session gets an entry, even one with no threads: `save()` compares these sets.
        const owners = threadIds.get(sessionId) ?? new Set<string>();

        threadIds.set(sessionId, owners);

        const record = recordOrNull(document);
        const core = record === undefined ? undefined : recordOrNull(record.core);
        const rows = core === undefined ? undefined : core.threads;

        if (!Array.isArray(rows)) return;

        for (const entry of rows) {
            const row = recordOrNull(entry);

            if (row === undefined) continue;

            const id = typeof row.id === 'string' ? row.id : undefined;

            // A foreign id has no shard to look for (`splitHarnessSessionRecord` keeps such a
            // row inline), and ../core/snapshot.ts:862 refuses it with the precise reason on
            // restore. Guessing here would hide that message behind a transcript error.
            if (id === undefined || !HARNESS_THREAD_ID_PATTERN.test(id)) continue;

            const file = harnessThreadFileOf(this.directory, sessionId, id);
            const text = this.readShardText(file, 'the harness thread shard');

            if (text === undefined) {
                // The file the row indexes is gone. Kept as a marker STRING rather than an
                // absent key or an empty array — see `HARNESS_MISSING_THREAD_TRANSCRIPT` — and
                // said out loud, because the tolerance downstream can only ever report
                // "messages must be an array". `owners` deliberately does NOT take this id:
                // there is no file on disk to erase on the next commit, and the store's own
                // post-restore snapshot re-creates the shard from the placeholder transcript.
                row.messages = HARNESS_MISSING_THREAD_TRANSCRIPT;
                this.noteMissingThreadTranscript(sessionId, id, file);
                continue;
            }

            digests.set(file, harnessShardCommitStampOf(file, harnessShardDigest(text), text));
            owners.add(id);
            row.messages = harnessThreadTranscriptOf(text);
        }
    }

    // Commits the database as shards. Synchronous by design (it serializes writers, and
    // every structural API mutation can be durable before it returns), and STILL the
    // compatibility surface: signature unchanged, monkey-patchable in tests
    // (./shutdown-background.test.ts:216), and throwing.
    //
    // R1: the byte format and the commit sequence live in the exported primitives above
    // (`serializeHarnessShard` / `writeHarnessShardFile`), so the IO worker commits
    // identical bytes on its own thread.
    //
    // What is written, in this order and for these reasons:
    //   1. the thread shards of a session,
    //   2. that session's `session.json` — the file that indexes those shards,
    //   3. `index.json`, once every session is durable,
    //   4. the shards the new document no longer names, LAST of all.
    // A crash between any two steps therefore leaves a footprint the committed header does
    // not name (an extra session directory, an extra transcript file: ignored on read), and
    // never a file the header names while missing. Deleting first would have inverted that:
    // a crash after the delete and before the header would drop a session the header still
    // listed, i.e. the one state `load()` has to refuse.
    save(database: HarnessDatabase): void {
        try {
            this.commitShards(database);
            this.lastError = undefined;
        } catch (error) {
            // The underlying message, exactly as before the extraction: this channel
            // is observability only, and an operator compares it with the syscall.
            this.lastError = messageOf(causeOf(error));

            throw error;
        }
    }

    // The ordered shard commit. Every write goes through `commitShardIfChanged`, so a
    // checkpoint of an unchanged session costs no syscall at all for that session (R5).
    private commitShards(database: HarnessDatabase): void {
        const options: HarnessDatabaseWriteOptions = { sequence: this.staging };
        const sessionsNow = new Set<string>();
        const threadsNow = new Map<string, Set<string>>();

        for (const record of database.sessions) {
            // Split, never mutate: `record` is the live record ./sessions.ts
            // `sessionRecord()` just built from a running harness.
            const { record: stored, transcripts } = splitHarnessSessionRecord(record);

            sessionsNow.add(record.id);

            const ids = new Set<string>();

            threadsNow.set(record.id, ids);

            for (const transcript of transcripts) {
                ids.add(transcript.id);

                this.commitShardIfChanged(
                    {
                        kind: 'thread',
                        directory: harnessThreadDirectoryOf(this.directory, record.id),
                        sessionId: record.id,
                        id: transcript.id,
                        messages: transcript.messages
                    },
                    options
                );
            }

            this.commitShardIfChanged(
                {
                    kind: 'session',
                    directory: harnessSessionDirectoryOf(this.directory, record.id),
                    sessionId: record.id,
                    record: stored
                },
                options
            );
        }

        this.commitShardIfChanged({ kind: 'index', directory: this.directory, document: harnessIndexDocumentOf(database) }, options);

        this.eraseVanishedShards(sessionsNow, threadsNow);

        this.writtenSessionIds = sessionsNow;
        this.writtenThreadIds = threadsNow;
    }

    // Commit-one-shard-with-skip. TWO conditions must both hold to skip, and the second one is
    // what keeps the skip honest:
    //
    //   1. the payload hashes to the bytes this writer last committed, and
    //   2. the FILE still carries the witness (`size` + `mtimeMs`) it had at that commit.
    //
    // Condition 1 alone would be v2's first cut, and it has a hole v1 did not: v1 rewrote the
    // whole document every commit, so an edit made to the file from OUTSIDE this process was
    // reverted by the next save. A payload digest cannot see such an edit — it hashes the
    // writer's own bytes, which did not change — so the memory/file divergence would survive
    // until a restart silently adopted the outsider's bytes. Condition 2 restores v1's
    // self-heal for the price of one `statSync` (the shard's CONTENTS are still never re-read,
    // which is the saving the gate exists for), and a file that cannot be statted at all counts
    // as changed — a rewrite is always safe, a wrong skip is not.
    //
    // The digest is of the payload bytes, so "unchanged" means byte-identical, not "semantically
    // identical": a record that re-emits the same values in a different key order IS rewritten
    // (once), which is the honest cost of not keeping a parsed copy of every session around.
    private commitShardIfChanged(unit: HarnessShardUnit, options: HarnessDatabaseWriteOptions): void {
        const file = harnessShardFileOf(unit);
        const payload = harnessShardPayloadOf(unit);
        const digest = harnessShardDigest(payload);
        const committed = this.shardDigests.get(file);

        if (committed !== undefined && committed.digest === digest) {
            const current = harnessShardStampOf(file);

            if (current !== undefined && current.size === committed.size && current.mtimeMs === committed.mtimeMs) return;
        }

        // The payload is carried into the writer so the bytes that were hashed are exactly
        // the bytes committed — a second `JSON.stringify` could in principle differ.
        writeHarnessShardFile({ ...unit, payload } as HarnessShardUnit, options);

        this.shardDigests.set(file, harnessShardCommitStampOf(file, digest, payload));
    }

    // Erases the shards the committed header no longer names: a session that left the map
    // (drop-then-erase) and a transcript retired by the 256-record cap
    // (./sessions.ts `capThreadRecords`).
    //
    // A dropped session keeps its DIRECTORY and its `events.jsonl` — the row is erased and the
    // journal is kept, which is v1's outcome and what ./sessions.ts `remove()` counts on (it
    // deletes the directory itself, ./sessions.ts:11302-11303, after this commit).
    //
    // Best-effort, deliberately: the header is already durable, so the COMMITTED state is
    // correct whatever a failed unlink does to the leftover bytes — a stale shard is ignored
    // by `load()` (the index is authoritative) and a stale `session.json` costs disk, not
    // correctness. Throwing here would report a failed mutation that did in fact succeed.
    private eraseVanishedShards(
        sessionsNow: ReadonlySet<string>,
        threadsNow: ReadonlyMap<string, ReadonlySet<string>>
    ): void {
        for (const id of this.writtenSessionIds) {
            if (sessionsNow.has(id)) continue;

            this.eraseFile(harnessSessionFileOf(this.directory, id));
            this.eraseTree(harnessThreadDirectoryOf(this.directory, id));
            this.forgetShardsUnder(harnessSessionDirectoryOf(this.directory, id));
        }

        for (const [id, previous] of this.writtenThreadIds) {
            // A vanished session already removed its whole `threads/` tree above.
            if (!sessionsNow.has(id)) continue;

            const kept = threadsNow.get(id);

            for (const threadId of previous) {
                if (kept !== undefined && kept.has(threadId)) continue;

                const file = harnessThreadFileOf(this.directory, id, threadId);

                this.eraseFile(file);
                this.shardDigests.delete(file);
            }
        }
    }

    private eraseFile(file: string): void {
        // One primitive, shared with the IO worker, so the two modes cannot disagree about what
        // "removed" means. The failures are not thrown here: the header no longer names the file,
        // so a leftover is invisible to `load()` and costs disk rather than correctness.
        eraseHarnessShardPaths([file], []);
    }

    private eraseTree(directory: string): void {
        eraseHarnessShardPaths([], [directory]);
    }

    // Drops the digest entries of an erased footprint, so a session re-created under the SAME
    // id (a restored-from-backup root, or a hand-copied directory) is written again instead of
    // being skipped against bytes that are no longer there.
    private forgetShardsUnder(directory: string): void {
        const prefix = `${directory}${path.sep}`;

        for (const key of [...this.shardDigests.keys()]) {
            if (key.startsWith(prefix)) this.shardDigests.delete(key);
        }
    }
}

// The ONE removal primitive for a shard footprint. Both legs use `force: true`, so a path that is
// already gone is a SUCCESS — which is what makes a removal idempotent: re-posting an erase (the IO
// queue can, after a retry) cannot turn a completed cleanup into a failure.
//
// Failures are RETURNED rather than thrown, per path: a shard the committed header no longer names
// costs disk, not correctness, so the caller decides how loud to be. The inline collector swallows
// the list; the IO worker answers a `failure` frame naming each path ONCE. Keeping that policy split
// here instead of in two `rmSync` call sites is what stops the two modes from growing different
// ideas of what "erased" means.
export const eraseHarnessShardPaths = (files: readonly string[], trees: readonly string[]): { path: string; message: string }[] => {
    const failed: { path: string; message: string }[] = [];

    for (const file of files) {
        try {
            fs.rmSync(file, { force: true });
        } catch (error) {
            failed.push({ path: file, message: messageOf(error) });
        }
    }

    for (const tree of trees) {
        try {
            fs.rmSync(tree, { recursive: true, force: true });
        } catch (error) {
            failed.push({ path: tree, message: messageOf(error) });
        }
    }

    return failed;
};

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

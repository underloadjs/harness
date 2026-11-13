// Runtime-level GLOBAL TOOL SETTINGS (R3): the one place the server decides which tool
// names this deployment runs, for EVERY session and EVERY thread at once.
//
// WHY A DENY LIST INSTEAD OF A PER-TOOL RECORD
// --------------------------------------------
// Everything is enabled unless it is listed. That is already the runtime's default state
// (a searchable tool is callable once a session discovers it), so the durable document
// carries only the operator's exceptions: a deployment that never opened the Tools pane
// stores nothing, a release that adds a tool needs no migration, and a hand-edited file
// stays readable. It also means "unknown name" is not a persistence error — a stored name
// may legitimately stop existing between builds, and the runtime simply never consults it.
//
// THREE CONSUMERS, ONE LIVE PROVIDER (mirrors ./plugins.ts exactly)
// ----------------------------------------------------------------
// `provider` is handed to every harness (`../sessions.ts` `buildHarness` →
// `HarnessPresetReport.toolSettings` → `../harnesses/toolbox.ts` →
// `HarnessConfiguration.toolSettings`), stored BY REFERENCE, and called per decision —
// the declaration filter, the launch gate, and `toolRequest`'s forbidden report
// (../harness.ts). So `PATCH /v1/harness/tools/{tool_id}` changes what an ALREADY RUNNING
// session declares on its next request: no rebuild, no re-registration, no restart.
//
// HOW IT COMPOSES WITH THE TWO PER-RUN GATES
// ------------------------------------------
// A tool reaches a model turn only when it passes ALL of them, and this store changes
// none of the other two:
//   1. this global switch          — deployment-wide, durable, live;
//   2. the session-wide enabled set — what THIS harness has discovered so far (cap-bounded);
//   3. a delegation's `scope.tools` — the per-run allowlist.
// A name disabled here is additionally never written INTO the session-wide set by a
// discovery round (../harness.ts partitions it as denied), so one thread's search cannot
// quietly undo the operator's decision for every other thread.
//
// WHAT DISABLED DOES NOT MEAN
// ---------------------------
// The tool stays REGISTERED: its schema, its source revision, its availability, a host's
// manual `POST /tools/{name}/executions`, and a session's own registration are untouched.
// Only the model's view changes — hidden from declarations, refused at the launch gate
// with a readable tool result, and answered as `forbidden` by discovery.
//
// EVERY NAME IS SWITCHABLE
// ------------------------
// There is no protected set. A core tool (`toolRequest`, `tasks`, ...) is disabled here
// exactly like a catalogue entry: the switch gates what an AGENT may reach, and nothing
// else. A harness that loses `toolRequest` still answers a host's manual
// `POST /tools/{name}/executions`, still runs a nested call made by another tool, and can
// put the name back with one more PATCH — a deny-list entry is a model-visibility decision,
// not a teardown. The default is ENABLED in every direction: an empty deny list, a restore
// that honours every stored name (core included), and no write-edge refusal.
//
// The session-scoped surface keeps its OWN, unrelated notion of an entry a conversation
// cannot detach: the row's `protected` flag, which is the NEGATION of the kernel's own
// switchability predicate — `!harness.isToolSwitchable(name)` (../harness.ts
// `occupiesSearchableSlot`), stated by ./api-reads.ts `sessionToolRowsOf` and refused with
// 403 by the session-tool PATCH/DELETE (./api.ts). It is deliberately NOT
// "`isCoreToolName` plus `declared`", the combination this note used to describe: that guess
// locks searchable rows the kernel happily switches (`syntax`, `files`, `shell`) and misses
// `delegate` and the pending-only `toolCancel`, which it refuses without being in
// `CORE_TOOL_NAMES`. `isCoreToolName` now feeds only the EXECUTION gate (`scope:
// session_required`, ./api-reads.ts `toolExecutionScopeOf`), a different question with a
// different answer. That gate is a property of one live harness's registry, not of this
// deployment-wide switch: nothing here changes it, and disabling `toolRequest` globally does
// not make a name the kernel will not switch suddenly switchable in a session.
//
// WORKER MODE (the provider cannot cross; the SET can)
// ---------------------------------------------------
// A lane worker rebuilds its replica from the preset RECORD in the `hello` blueprint, and
// `provider` is a closure, so a replica can never hold the store's LIVE object. It does not
// have to: the store's SNAPSHOT travels as data. `../sessions.ts` `blueprintFor` reads
// `disabled()` at lane creation into `LaneBlueprint.disabledTools`
// (../workers/protocol.ts), and `../workers/lane-worker-loop.ts` `laneToolSettingsProvider`
// turns that list back into a provider the replica is BUILT with. So a lane honours every
// name that was switched off when its lane was created, and a name switched off while the
// lane was already running reaches it when the lane is next created (an idle reclaim, a new
// conversation, an authority rebuild) - the documented lane semantics, the same ones
// `PATCH /v1/harness/plugins/{plugin_id}` states (../harness.swagger.yaml, that PATCH).
// Discovery is NOT delayed even in that window: a lane's `toolRequest` is routed to the
// authority (../workers/lane-authority.ts), which answers against the canonical harness and
// therefore against this live provider.
//
// Every inline session - the default deployment shape - reads the switch live, on the turn
// it is made.
//
// Cross-references:
//   - ./plugins.ts            — the sibling store this one mirrors (live provider, revision, snapshot)
//   - ./persistence.ts        — `HarnessToolSettingsRecord`, the durable deny list
//   - ./sessions.ts           — owns one store per runtime, passes `provider` to buildHarness
//                               and `disabled()` to every lane blueprint (`blueprintFor`)
//   - ./workers/protocol.ts   — `LaneBlueprint.disabledTools`, the lane-creation snapshot on the wire
//   - ./workers/lane-worker-loop.ts — `laneToolSettingsProvider`, the snapshot turned back into a provider
//   - ./api.ts                — `GET /tools` rows and `PATCH /tools/{tool_id}`
//   - ../harness.ts           — the three consumers of the provider
//   - ../types/index.ts       — `HarnessToolSettingsProvider`, `HarnessConfiguration.toolSettings`

import type { HarnessToolSettingsProvider } from '../types';
import type { HarnessToolSettingsRecord } from './persistence';

/**
 * A tool-settings failure with the HTTP status the route should answer: 400 for a blank
 * name. The dispatcher maps it the same way it maps `HarnessPluginSettingsError`
 * (./api.ts). An unknown TOOL is the route's 404 — only the route can see the catalogue.
 * Every listed name, core tools included, is switchable, so this store never refuses a
 * name for being harness-owned.
 */
export class HarnessToolSettingsError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HarnessToolSettingsError';
    }
}

export type HarnessToolSettingsStoreOptions = {
    // The deny list restored from `state.json` (./persistence.ts). Names are not checked
    // against the catalogue, and no name is dropped for being harness-owned (see the header).
    values?: HarnessToolSettingsRecord;
};

export type HarnessToolSettingsStore = {
    /** Every disabled name, sorted (the order the writer persists). */
    disabled: () => string[];
    /** The provider's question: is this name switched off for this deployment right now? */
    isDisabled: (name: string) => boolean;
    /** The row-facing answer: a name is off exactly when it is on the deny list. */
    isEnabled: (name: string) => boolean;
    /**
     * Validate and apply one switch. Throws `HarnessToolSettingsError` (400) BEFORE
     * mutating, so a refused write is a no-op. Durability and the revision bump are the
     * store owner's decision (./sessions.ts `updateToolEnabled`).
     */
    setEnabled: (name: string, enabled: boolean) => void;
    /** The `state.json` projection: `{}` when nothing is off, else `{ disabled: [...] }`. */
    snapshot: () => HarnessToolSettingsRecord;
    /** Replace the whole set with a restored document (no revision bump: a boot is not a write). */
    restore: (values?: HarnessToolSettingsRecord) => void;
    /** Reads that mutate: one bump per accepted switch, so a page's `revision` is a staleness test. */
    revision: () => number;
    /**
     * THE provider handed to every harness. It reads the live set on every call, which is
     * what makes an edit reach an existing session; its identity is stable for the process,
     * so a harness that captured it at construction still sees tomorrow's value.
     */
    provider: HarnessToolSettingsProvider;
};

export const createToolSettingsStore = (
    options: HarnessToolSettingsStoreOptions = {}
): HarnessToolSettingsStore => {
    // The live deny list. A Set, because the question is always "is this name in it", and
    // sorted only at the write edge (the persisted document and `disabled()` are diff-stable).
    const disabledNames = new Set<string>();

    // Restore body, shared by the constructor seed and the exposed `restore`. Tolerant by
    // design: an older build's document may hold a blank entry or a duplicate, or a name
    // this build no longer ships, and none of those may abort a server boot. Every real
    // name is HONOURED, core tools included — the switch applies to the whole catalogue,
    // so a deny list the operator wrote is the state a boot comes back with.
    const applyRestore = (values?: HarnessToolSettingsRecord): void => {
        disabledNames.clear();

        if (values === undefined || !Array.isArray(values.disabled)) return;

        for (const raw of values.disabled) {
            if (typeof raw !== 'string') continue;

            const name = raw.trim();

            if (name.length === 0) continue;

            disabledNames.add(name);
        }
    };

    // The persisted document IS the seed: a restored process reads back exactly what the
    // operator last saved, before its first harness is built (./runtime.ts and ./start.ts
    // both pass the loaded document to `SessionStore`, which forwards `database.toolSettings`).
    applyRestore(options.values);

    let revision = 0;

    // The provider object is created ONCE and never replaced: `harness()` keeps the
    // reference, so `isToolDisabled` must close over the live set (../harness.ts calls it
    // while building every request's tool list).
    const provider: HarnessToolSettingsProvider = {
        isToolDisabled: (name: string) => disabledNames.has(name)
    };

    return {
        disabled: () => [...disabledNames].sort((left, right) => left.localeCompare(right)),

        isDisabled: (name: string) => disabledNames.has(name),

        // A name is off exactly when the operator put it on the deny list. Nothing is off
        // by construction: the default state is ENABLED, and a restore that listed a core
        // tool honours it, so this read and the write edge can never disagree.
        isEnabled: (name: string) => !disabledNames.has(name),

        setEnabled: (name: string, enabled: boolean) => {
            if (typeof name !== 'string' || name.trim().length === 0) {
                throw new HarnessToolSettingsError(400, 'A tool switch requires a non-empty tool name.');
            }

            const tool = name.trim();

            // An enable is always a plain remove (idempotent: enabling an enabled tool is a
            // no-op write, never an error), and a disable is an insert into the deny list.
            // A harness-owned name takes either write exactly like any other entry (R5).
            if (enabled) disabledNames.delete(tool);
            else disabledNames.add(tool);

            revision += 1;
        },

        snapshot: () =>
            disabledNames.size === 0 ? {} : { disabled: [...disabledNames].sort((left, right) => left.localeCompare(right)) },

        restore: (values?: HarnessToolSettingsRecord) => applyRestore(values),

        revision: () => revision,

        provider
    };
};

/**
 * The server's ONE built-in tool-settings provider over a store: the value to pass as
 * `HarnessPresetReport.toolSettings`. Exposed as a helper so a host that builds harnesses
 * itself (a CLI, a test) reaches the same live reads the HTTP routes write.
 */
export const toolSettingsProviderOf = (store: HarnessToolSettingsStore): HarnessToolSettingsProvider =>
    store.provider;

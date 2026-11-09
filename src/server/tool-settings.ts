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
// PROTECTED NAMES
// ---------------
// `CORE_TOOL_NAMES` is the control plane a session runs on (the runtime tools plus
// `delegate`/`threadSend`). Switching it off would strand every conversation, so a
// protected name is refused with 403 at the write edge, dropped at restore (a
// hand-edited document cannot smuggle one in), and reported `enabled: true` forever on
// every read. This is the SAME predicate the session-scoped route already uses
// (../api-reads.ts `isProtectedToolName`, which imports it from here) and the same rule
// the runtime enforces through `requireSwitchableTool` (../harness.ts).
//
// WORKER MODE (same documented limit as ./plugins.ts)
// ---------------------------------------------------
// A lane worker rebuilds its replica from the preset RECORD in the `hello` blueprint, and
// a live provider closure cannot cross a `worker_threads` boundary, so a replica harness
// runs with no global provider until its lane is re-created. Every inline session — the
// default deployment shape — reads the switch live.
//
// Cross-references:
//   - ./plugins.ts            — the sibling store this one mirrors (live provider, revision, snapshot)
//   - ./persistence.ts        — `HarnessToolSettingsRecord`, the durable deny list
//   - ./sessions.ts           — owns one store per runtime, passes `provider` to buildHarness
//   - ./api.ts                — `GET /tools` rows and `PATCH /tools/{tool_id}`
//   - ../harness.ts           — the three consumers of the provider
//   - ../types/index.ts       — `HarnessToolSettingsProvider`, `HarnessConfiguration.toolSettings`

import { CORE_TOOL_NAMES } from './harnesses/toolbox';
import type { HarnessToolSettingsProvider } from '../types';
import type { HarnessToolSettingsRecord } from './persistence';

/**
 * A tool-settings failure with the HTTP status the route should answer: 403 for a
 * protected (harness-owned) name the switch does not apply to, 400 for a blank name. The
 * dispatcher maps it the same way it maps `HarnessPluginSettingsError` (./api.ts). An
 * unknown TOOL is the route's 404 — only the route can see the catalogue.
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

/** True when a name is part of the harness-owned control plane, and therefore not switchable. */
export const isProtectedToolName = (name: string): boolean => CORE_TOOL_NAMES.includes(name);

export type HarnessToolSettingsStoreOptions = {
    // The deny list restored from `state.json` (./persistence.ts). Names are not checked
    // against the catalogue; protected names are dropped (see the header).
    values?: HarnessToolSettingsRecord;
};

export type HarnessToolSettingsStore = {
    /** Every disabled name, sorted (the order the writer persists). */
    disabled: () => string[];
    /** The provider's question: is this name switched off for this deployment right now? */
    isDisabled: (name: string) => boolean;
    /** The row-facing answer: a protected name is ALWAYS enabled, whatever a document says. */
    isEnabled: (name: string) => boolean;
    /** Whether the switch applies to this name at all (protected => never). */
    isProtected: (name: string) => boolean;
    /**
     * Validate and apply one switch. Throws `HarnessToolSettingsError` (400/403) BEFORE
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
    // design: an older build's document may hold a blank entry, a duplicate, or a name this
    // build no longer ships, and none of those may abort a server boot. A PROTECTED name is
    // dropped here rather than honoured, so the invariant "the control plane is always on"
    // survives a hand-edited `state.json` — the write edge cannot produce one.
    const applyRestore = (values?: HarnessToolSettingsRecord): void => {
        disabledNames.clear();

        if (values === undefined || !Array.isArray(values.disabled)) return;

        for (const raw of values.disabled) {
            if (typeof raw !== 'string') continue;

            const name = raw.trim();

            if (name.length === 0 || isProtectedToolName(name)) continue;

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

        // A protected name reports `true` even if a stale document listed it (restore drops
        // those, so this is the second line of the same rule): a row must never show the
        // control plane as off when the runtime can never switch it off.
        isEnabled: (name: string) => isProtectedToolName(name) || !disabledNames.has(name),

        isProtected: isProtectedToolName,

        setEnabled: (name: string, enabled: boolean) => {
            if (typeof name !== 'string' || name.trim().length === 0) {
                throw new HarnessToolSettingsError(400, 'A tool switch requires a non-empty tool name.');
            }

            const tool = name.trim();

            if (!enabled && isProtectedToolName(tool)) {
                throw new HarnessToolSettingsError(
                    403,
                    `Tool "${tool}" is harness-owned; it is part of the control plane every session runs on and cannot be disabled.`
                );
            }

            // An enable is always a plain remove (idempotent: enabling an enabled tool is a
            // no-op write, never an error), and a disable is an insert into the deny list.
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

// Runtime-level PLUGIN SETTINGS (T5 / R2-R3): the one place the server decides what a
// built-in plugin's setting is worth, for EVERY session in this process.
//
// WHY THIS LIVES IN THE SERVER, NOT IN THE HARNESS
// ------------------------------------------------
// `harness()` already owns the READ side (src/plugin/settings.ts): a provider answers
// `get(plugin, key)` and each plugin's `api.settings` coerces to the declared type, falling
// back to the plugin's own declared default. What the library deliberately does NOT own is
// where a stored value came from, how it is validated, and how it survives a restart - that
// is host policy. This module is the server's host: it seeds from the generated built-in
// manifest, validates every write against the plugin's own descriptor, keeps the durable
// overrides in `<databaseRoot>/harness/state.json`, and hands every harness ONE live
// provider object, so `PATCH /v1/harness/plugins/{plugin_id}` changes what an EXISTING
// session reads on its very next turn (the settings view re-reads the provider on every
// call - src/plugin/settings.ts `resolve`, and src/plugin/host.ts:151 builds the view over
// the provider reference, never a snapshot of it).
//
// DEFAULTS BELONG TO THE PLUGIN, OVERRIDES TO THE HOST
// ---------------------------------------------------
// `get(plugin, key)` answers `undefined` when the operator has never changed that key, which
// is the provider's documented "nothing stored" signal (src/types/index.ts:3489-3497). The plugin's
// declared `default` is therefore applied by the library, not duplicated here, and
// `state.json` stores ONLY what the operator changed - the same minimal-delta rule as
// `globalSettings` (./persistence.ts `HarnessGlobalSettingsRecord`). `values(plugin)` is the
// projection the UI paints: declared default + stored override, resolved through the SAME
// view a plugin reads, so a row can never disagree with runtime behaviour.
//
// THE RESERVED `enabled` KEY (R2 — the operator's global switch)
// --------------------------------------------------------------
// `enabled` is a framework-owned boolean that EVERY plugin answers to, whether or not
// its own metadata declares one, and it is the one setting whose meaning is not the
// plugin's to define: it turns the plugin's HOOK DELIVERY on and off (../plugin/host.ts
// registers each handler with a live `enabled()` predicate; ../plugin/hooks.ts rule 9
// consults it per event, exempting `harness.dispose` so cleanup still runs).
//
// Resolution is the ordinary one - stored override -> declared default -> `true` -
// because the reserved key is carried as a synthesized descriptor
// (`RESERVED_ENABLED_DESCRIPTOR`) wherever a descriptor would be consulted: the view a
// value resolves through, the patch allowlist, the persisted snapshot, and the restore
// filter. A plugin that declares `enabled` itself (context-compaction) keeps its own
// descriptor, so its Rule-0 read and the framework gate are one value with one write
// path. Consequences an operator can rely on:
//   - one click, every thread: the provider is process-wide and read live, so a running
//     session honours the switch on its next turn, with no rebuild and no re-registration;
//   - a disabled plugin stays LOADED and LISTED - its tools, agents, commands and
//     settings are untouched, and `GET /plugins` reports the row with `enabled: false`;
//   - `values` keeps reporting only DECLARED keys (the contract states a key absent from
//     `settings` never appears there); enablement is the row's own `enabled` field.
//
// VALIDATION AT THE WRITE EDGE, COERCION AT THE READ EDGE
// -------------------------------------------------------
// `plugin/settings.ts` is deliberately coercion-only: a corrupt stored value must not throw
// inside a turn. That is fine for a read, and wrong for a write: an operator editing a form
// deserves to be told `contextLimit` must be at least 1000, not to have it silently ignored.
// So THIS module enforces the descriptor at PATCH time (`min`/`max`, the declared type, and
// the key's existence) and normalizes the stored value to the declared type, while leaving
// the read path permissive.
//
//   - `min` / `max` are enforced. They are the bounds the plugin published, and a value
//     outside them is a value the plugin never said it could handle.
//   - `step` is NOT enforced, deliberately. The domain type states the numeric fields are UI
//     hints (src/types/index.ts:3434-3438), and src/plugin/settings.ts documents that they
//     are "deliberately NOT enforced" at read time. Refusing `contextLimit: 1500` because
//     `step: 1000` would make the API stricter than the runtime that has to live with the
//     value, and would strand any value a migration or a hand-edited document produced. A
//     client that offers only stepped values is a UI decision, not a server rule.
//   - string forms the runtime already accepts are accepted here too: a numeric STRING and
//     the strings 'true'/'false' are what a query parameter or a JSON document legitimately
//     carries (src/plugin/settings.ts `asNumber`/`asBoolean`). They are NORMALIZED to the
//     declared type on write, so a stored value is always exactly the type the descriptor
//     declares, and therefore always JSON-serializable.
//   - an explicit `null` RESETS one key: the override is removed and the declared default
//     applies again. Same `null`-means-reset rule as `PATCH /config` (./api.ts `patchConfig`).
//   - an unknown key is refused with the declared set named, rather than stored and then
//     ignored forever - the contract's "a client is never left believing it changed
//     something" rule (src/server/harness.swagger.yaml `components.responses.BadRequest`).
//
// WORKER MODE (the provider cannot cross; the VALUES can)
// -------------------------------------------------------
// A lane worker rebuilds its replica from the preset RECORD in the `hello` blueprint
// (src/server/workers/lane-worker-loop.ts `sayHello`) and passes `{ stateChange, interaction,
// toolSettings, pluginSettings }` as the report. The LIVE provider is a closure, so it can
// never cross a `worker_threads` boundary; what crosses instead is this store's `snapshot()`
// - the override map in exactly the shape `state.json` holds it - carried as
// `LaneBlueprint.pluginSettings` (src/server/workers/protocol.ts), read at lane creation by
// src/server/sessions.ts `blueprintFor`, and turned back into a read-only provider by
// `lanePluginSettingsProvider`. A replica therefore resolves the operator's `enabled` switch
// (the framework's hook gate, src/plugin/host.ts + src/plugin/hooks.ts) and every other knob
// exactly like an inline session, and a value changed while a lane was running reaches that
// lane when the lane is next created - the semantics the plugin PATCH documents.
//
// The one deliberate difference: a lane's provider has no `set`, so a plugin calling
// `api.settings.setOwn` on a replica gets the library's stated "read-only (no writer)"
// refusal instead of writing into a private copy that dies with the lane. No built-in writes
// settings (src/plugins/** reads only), so this is a honesty change, not a behaviour change.
//
// Cross-references:
//   - ../plugin/manifest.ts       — BUILTIN_PLUGIN_DESCRIPTORS: the seeded catalogue + defaults
//   - ../plugin/settings.ts       — the per-plugin view this module projects `values` through
//   - ../types/index.ts:3434-3507 — the descriptor, metadata, and provider contracts
//   - ./persistence.ts            — `HarnessPluginSettingsRecord`, the durable override map
//   - ./sessions.ts               — owns one store per runtime, passes `provider` to buildHarness
//   - ./api.ts                    — `GET /plugins`, `PATCH /plugins/{plugin_id}`

import { createPluginSettingsView } from '../plugin/settings';
import { BUILTIN_PLUGIN_DESCRIPTORS } from '../plugin/manifest';
import type {
    HarnessPluginMetadata,
    HarnessPluginSettingDescriptor,
    HarnessPluginSettingsProvider,
    HarnessPluginSettingType
} from '../types';
import type { HarnessPluginSettingsRecord } from './persistence';

// The value space of a declared setting. `default` is required on the descriptor, so an
// effective value is never `undefined`; only a raw OVERRIDE is.
export type HarnessPluginSettingValue = number | string | boolean;

/** An effective (declared default + stored override) map for one plugin. */
export type HarnessPluginSettingValues = Record<string, HarnessPluginSettingValue>;

/**
 * THE RESERVED KEY — R2's global plugin switch. `enabled` is a framework-owned boolean
 * that EVERY plugin answers to, whether or not its own metadata declares one, and the
 * same key the plugin itself may declare and read (context-compaction does, as Rule 0).
 *
 * The rule is one line: effective enablement = stored override ?? declared default ??
 * `true`. Nothing else about a plugin changes — it stays loaded, its tools/agents/
 * commands stay registered, and `GET /plugins` still lists it with `enabled: false`;
 * only hook delivery stops (../plugin/host.ts, ../plugin/hooks.ts rule 9).
 *
 * It is deliberately a normal key in the same override map rather than a second
 * per-plugin boolean column: the durable document, the validation edge, the live
 * provider and the settings view all already know how to carry a boolean per plugin, so
 * the switch costs one allowlisted descriptor and no new storage shape.
 */
export const PLUGIN_ENABLED_KEY = 'enabled';

// The synthesized descriptor for a plugin that does not declare the key itself. Its
// `default: true` is the "a plugin nobody switched off runs" answer the gate falls back
// to, and it is what lets the settings view resolve `enabled` through the SAME stored →
// declared → fallback chain as every other key (no special-case read anywhere).
const RESERVED_ENABLED_DESCRIPTOR: HarnessPluginSettingDescriptor = {
    key: PLUGIN_ENABLED_KEY,
    label: 'Enabled',
    type: 'boolean',
    default: true,
    description:
        'Framework switch: off stops this plugin\'s lifecycle hooks from running, in every session, from the next turn. The plugin stays loaded and listed; its tools and commands are unaffected.'
};

/**
 * A plugin-settings failure with the HTTP status the route should answer: 404 for a plugin
 * this build does not ship, 400 for an unknown key or an out-of-bounds/mistyped value. The
 * dispatcher maps it the same way it maps `SessionError`/`HarnessRegistryError` (./api.ts).
 */
export class HarnessPluginSettingsError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HarnessPluginSettingsError';
    }
}

export type HarnessPluginSettingsStoreOptions = {
    // The catalogue to seed from. Defaults to the GENERATED built-in manifest, and is
    // injectable so a test can declare a plugin with `string`/`boolean` settings that no
    // shipped plugin uses yet, without touching src/plugins.
    descriptors?: readonly HarnessPluginMetadata[];
    // Overrides restored from `state.json` (./persistence.ts). Anything this build does not
    // declare is dropped rather than failing the load: a plugin may legitimately stop
    // shipping a key between versions, and a lost override must never abort a server boot.
    values?: HarnessPluginSettingsRecord;
};

export type HarnessPluginSettingsStore = {
    // The catalogue in the manifest's stable order (path-ascending from the scan), which is
    // also the order `GET /plugins` answers in.
    readonly descriptors: readonly HarnessPluginMetadata[];
    /** Every known plugin name, in that same stable order. */
    names: () => string[];
    /** Declared metadata for one plugin, `undefined` when this build does not ship it. */
    metadata: (plugin: string) => HarnessPluginMetadata | undefined;
    /** Declared setting descriptors of one plugin (empty when it declares none). */
    settingsOf: (plugin: string) => readonly HarnessPluginSettingDescriptor[];
    /**
     * The descriptors a WRITE is validated against: the plugin's declared list plus the
     * reserved `enabled` key appended when the plugin does not declare it. That is the
     * allowlist, so `PATCH ... {settings:{enabled:false}}` is accepted for EVERY plugin
     * while an unknown key is still a 400 that names the whole accepted set.
     */
    effectiveSettingsOf: (plugin: string) => readonly HarnessPluginSettingDescriptor[];
    /** The raw STORED override of one key, `undefined` when nothing is stored. */
    get: (plugin: string, key: string) => HarnessPluginSettingValue | undefined;
    /**
     * R2 — whether one plugin RUNS right now: stored `enabled` override, otherwise the
     * plugin's declared `enabled` default, otherwise `true`. This is the exact value the
     * framework gate consults inside the harness (../plugin/host.ts), so a row and a
     * live session can never disagree about whether a plugin is on.
     */
    enabled: (plugin: string) => boolean;
    /**
     * The EFFECTIVE map the plugin reads right now: declared default unless an override is
     * stored, resolved through the same view the plugin's `api.settings` uses.
     * Unknown plugin => `{}` (it has no declared settings to resolve).
     */
    values: (plugin: string) => HarnessPluginSettingValues;
    /**
     * Validate and apply one plugin's patch, returning the new effective map. Throws
     * `HarnessPluginSettingsError` (404/400) BEFORE mutating anything, so a rejected patch
     * is a no-op rather than a partial write. Durability and the revision bump are the
     * store owner's decision (./sessions.ts `updatePluginSettings`).
     */
    update: (plugin: string, patch: Record<string, unknown> | undefined) => HarnessPluginSettingValues;
    /** Only what the operator changed, in catalogue order - the `state.json` projection. */
    snapshot: () => HarnessPluginSettingsRecord;
    /** Replace every override with a restored document (no revision bump: a boot is not a write). */
    restore: (values?: HarnessPluginSettingsRecord) => void;
    /** Reads that mutate: one bump per accepted patch, so a page's `revision` is a staleness test. */
    revision: () => number;
    /**
     * THE provider handed to every harness report. It reads the live map on every call, which
     * is what makes an edit reach an existing session; identity is stable for the process, so
     * a harness that captured it at construction still sees tomorrow's value.
     */
    provider: HarnessPluginSettingsProvider;
};

// The declared descriptor of one key, when the plugin declared it.
const descriptorOf = (
    settings: readonly HarnessPluginSettingDescriptor[],
    key: string
): HarnessPluginSettingDescriptor | undefined => settings.find((entry) => entry.key === key);

// A short, deterministic text of one accepted value, for the error messages.
const labelOf = (plugin: string, key: string): string => `"${key}" of plugin "${plugin}"`;

// ---------------------------------------------------------------------------
// Per-type validation + normalization (the write edge; see the header rules)
// ---------------------------------------------------------------------------

// A `number` setting accepts a JSON number, or a numeric string the runtime would also
// accept, and must land on a FINITE value inside `min`/`max`.
const checkNumber = (plugin: string, descriptor: HarnessPluginSettingDescriptor, value: unknown): number => {
    const where = labelOf(plugin, descriptor.key);

    let numeric: number | undefined;

    if (typeof value === 'number') numeric = value;
    else if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        numeric = Number.isFinite(parsed) ? parsed : undefined;
    }

    if (numeric === undefined || !Number.isFinite(numeric)) {
        throw new HarnessPluginSettingsError(
            400,
            `${where} must be a finite number (it is declared "number").`
        );
    }

    if (descriptor.min !== undefined && numeric < descriptor.min) {
        throw new HarnessPluginSettingsError(
            400,
            `${where} must be at least ${descriptor.min}; ${numeric} was submitted.`
        );
    }

    if (descriptor.max !== undefined && numeric > descriptor.max) {
        throw new HarnessPluginSettingsError(
            400,
            `${where} must be at most ${descriptor.max}; ${numeric} was submitted.`
        );
    }

    return numeric;
};

// A `string` setting accepts a string ONLY: unlike the read path, a write must say what it
// means, and `settings: true` for a text field is more likely a client bug than a value.
const checkString = (plugin: string, descriptor: HarnessPluginSettingDescriptor, value: unknown): string => {
    const where = labelOf(plugin, descriptor.key);

    if (typeof value !== 'string') {
        throw new HarnessPluginSettingsError(400, `${where} must be a string (it is declared "string").`);
    }

    return value;
};

// A `boolean` setting accepts a JSON boolean, or the two words the runtime also parses.
const checkBoolean = (plugin: string, descriptor: HarnessPluginSettingDescriptor, value: unknown): boolean => {
    const where = labelOf(plugin, descriptor.key);

    if (typeof value === 'boolean') return value;

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();

        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }

    throw new HarnessPluginSettingsError(400, `${where} must be true or false (it is declared "boolean").`);
};

// Validate one submitted value against its descriptor and normalize it to the declared type.
const checkValue = (
    plugin: string,
    descriptor: HarnessPluginSettingDescriptor,
    value: unknown
): HarnessPluginSettingValue => {
    const type: HarnessPluginSettingType = descriptor.type;

    if (type === 'number') return checkNumber(plugin, descriptor, value);
    if (type === 'boolean') return checkBoolean(plugin, descriptor, value);

    return checkString(plugin, descriptor, value);
};

// ---------------------------------------------------------------------------
// Restore-side normalization
// ---------------------------------------------------------------------------

// A restored override is validated by the same rules, but a failure DROPS the entry instead
// of throwing: the durable document is operator-visible data from an older build, and a
// single stale key must never abort a server boot or hide every session. The message of the
// caught error is unused (the value is simply not restored).
const normalizeForRestore = (
    plugin: string,
    descriptor: HarnessPluginSettingDescriptor,
    value: unknown
): HarnessPluginSettingValue | undefined => {
    try {
        return checkValue(plugin, descriptor, value);
    } catch {
        return undefined;
    }
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export const createPluginSettingsStore = (
    options: HarnessPluginSettingsStoreOptions = {}
): HarnessPluginSettingsStore => {
    // Catalogue + per-plugin descriptor index. Insertion order is the manifest's order, and
    // that order is what `GET /plugins` must keep stable across restarts.
    const catalogue = options.descriptors ?? BUILTIN_PLUGIN_DESCRIPTORS;
    const byName = new Map<string, HarnessPluginMetadata>();

    for (const descriptor of catalogue) {
        if (!byName.has(descriptor.name)) byName.set(descriptor.name, descriptor);
    }

    // plugin -> key -> stored override. ONLY operator-changed values land here: a declared
    // default is never stored, so `state.json` carries a delta and a plugin's default may
    // change in a release without a migration touching the file.
    const overrides = new Map<string, Map<string, HarnessPluginSettingValue>>();

    const settingsOf = (plugin: string): readonly HarnessPluginSettingDescriptor[] =>
        byName.get(plugin)?.settings ?? [];

    // DECLARED descriptors + the reserved `enabled` key, in that order. Computed per call
    // (a catalogue lookup, no allocation cost worth caching) and used for EVERYTHING the
    // host decides about a key: the view it resolves values through, the allowlist a
    // patch is validated against, the error message's accepted set, the persisted
    // snapshot, and the restore filter. A plugin that declares `enabled` itself keeps its
    // own descriptor (and its own default), so the framework switch and the plugin's
    // Rule-0 read are one and the same stored value.
    //
    // Declared ABOVE `viewOf`/`applyRestore` on purpose: the restore seed runs during
    // construction, and a `const` arrow defined later would still be in its temporal dead
    // zone there.
    const effectiveSettingsOf = (plugin: string): readonly HarnessPluginSettingDescriptor[] => {
        const declared = settingsOf(plugin);

        if (declared.some((entry) => entry.key === PLUGIN_ENABLED_KEY)) return declared;

        return [...declared, RESERVED_ENABLED_DESCRIPTOR];
    };

    // The LIVE provider. `get` reads this same map on every call, so an edit is visible to a
    // harness built hours earlier - the property the whole feature exists for.
    const provider: HarnessPluginSettingsProvider = {
        get: (plugin: string, key: string) => overrides.get(plugin)?.get(key)
    };

    // One settings view per plugin, cached: `values()` is a read hot enough to deserve it,
    // and the view itself never caches a value (it re-reads the provider per call).
    const views = new Map<string, ReturnType<typeof createPluginSettingsView>>();

    const viewOf = (plugin: string): ReturnType<typeof createPluginSettingsView> => {
        const existing = views.get(plugin);

        if (existing !== undefined) return existing;

        // The EFFECTIVE descriptor list, so `enabled` resolves through this view exactly
        // like a declared key: stored override, then the declared default (the plugin's
        // own when it declares one, else the reserved descriptor's `true`).
        const created = createPluginSettingsView(plugin, provider, effectiveSettingsOf(plugin));

        views.set(plugin, created);

        return created;
    };

    const put = (plugin: string, key: string, value: HarnessPluginSettingValue): void => {
        let entries = overrides.get(plugin);

        if (entries === undefined) {
            entries = new Map<string, HarnessPluginSettingValue>();
            overrides.set(plugin, entries);
        }

        entries.set(key, value);
    };

    const requirePlugin = (plugin: string): HarnessPluginMetadata => {
        const metadata = byName.get(plugin);

        if (metadata === undefined) {
            const known = [...byName.keys()].join(', ');

            throw new HarnessPluginSettingsError(
                404,
                `Unknown plugin "${plugin}". This build ships: ${known.length === 0 ? 'none' : known}.`
            );
        }

        return metadata;
    };

    // Every override of one plugin, in EFFECTIVE-DESCRIPTOR order (a document written by an
    // older build may hold keys in a different order, and a snapshot must be diff-stable).
    // The reserved `enabled` key is part of that order, so a switch flipped on a plugin
    // that does NOT declare it is still persisted — and a declared `enabled` keeps the
    // position the plugin gave it.
    const snapshotOf = (plugin: string): Record<string, HarnessPluginSettingValue> => {
        const entries = overrides.get(plugin);
        const result: Record<string, HarnessPluginSettingValue> = {};

        if (entries === undefined) return result;

        for (const descriptor of effectiveSettingsOf(plugin)) {
            const value = entries.get(descriptor.key);

            if (value !== undefined) result[descriptor.key] = value;
        }

        return result;
    };

    // Restore body, shared by the constructor seed and the exposed `restore`. Tolerant by
    // design: a document may name a plugin or a key this build no longer declares, or hold a
    // value whose type has since been tightened, and none of those may abort a server boot.
    const applyRestore = (values?: HarnessPluginSettingsRecord): void => {
        overrides.clear();

        if (values === undefined) return;

        for (const [plugin, entries] of Object.entries(values)) {
            const metadata = byName.get(plugin);

            // A plugin this build stopped shipping: drop the whole entry.
            if (metadata === undefined || !entries || typeof entries !== 'object') continue;

            for (const [key, value] of Object.entries(entries)) {
                // The EFFECTIVE set is the allowlist here too, so an `enabled` override
                // saved for a plugin that never declares the key survives the restart
                // exactly like a declared one (R2's durability criterion).
                const descriptor = descriptorOf(effectiveSettingsOf(plugin), key);

                if (descriptor === undefined) continue;

                const normalized = normalizeForRestore(plugin, descriptor, value);

                if (normalized === undefined) continue;

                put(plugin, key, normalized);
            }
        }
    };

    // The persisted document IS the seed: a restored process reads back exactly what the
    // operator last saved, before its first harness is built (./runtime.ts and ./start.ts both
    // pass the loaded document to `SessionStore`, which forwards `database.pluginSettings`).
    applyRestore(options.values);

    // The effective map of one plugin, resolved through its settings view. Declared as a
    // plain closure (rather than a method on the returned object) because `update` has to
    // call it, and an object literal cannot reference its own methods while being built.
    const valuesOf = (plugin: string): HarnessPluginSettingValues => {
        const view = viewOf(plugin);
        const result: HarnessPluginSettingValues = {};

        // `view.get` is the plugin's OWN read: stored value when present, otherwise the
        // declared default (src/plugin/settings.ts:175-178). Resolving here rather than
        // merging maps by hand is what keeps the row identical to runtime behaviour.
        //
        // Deliberately DECLARED-only: `values` is the projection of the plugin's own form
        // fields, and the contract states a key absent from `settings` can never appear
        // here. Enablement therefore travels in its own `enabled` row field (the store's
        // `enabled()` below), which is the same value for a declaring and a
        // non-declaring plugin, and is what lets a pre-R2 row shape survive unchanged.
        for (const descriptor of settingsOf(plugin)) {
            const value = view.get(descriptor.key);

            if (value !== undefined) result[descriptor.key] = value as HarnessPluginSettingValue;
        }

        return result;
    };

    let revision = 0;

    return {
        descriptors: catalogue,

        names: () => [...byName.keys()],

        metadata: (plugin: string) => byName.get(plugin),

        settingsOf,

        effectiveSettingsOf,

        get: (plugin: string, key: string) => overrides.get(plugin)?.get(key),

        // R2 — resolved through the plugin's OWN view over the reserved descriptor, so
        // this answer and the harness's hook gate (../plugin/host.ts) are the same read
        // of the same stored value. An unknown plugin answers `true`: identity is the
        // ROUTE's decision (404), and this accessor must stay total so no read path throws.
        enabled: (plugin: string) => viewOf(plugin).boolean(PLUGIN_ENABLED_KEY, true),

        values: valuesOf,

        update: (plugin: string, patch: Record<string, unknown> | undefined) => {
            requirePlugin(plugin);

            if (patch === undefined || typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
                throw new HarnessPluginSettingsError(400, 'A plugin settings patch requires a "settings" object.');
            }

            const keys = Object.keys(patch);

            if (keys.length === 0) {
                throw new HarnessPluginSettingsError(
                    400,
                    'A plugin settings patch must change at least one setting.'
                );
            }

            // The EFFECTIVE list is the allowlist: the plugin's declared keys plus the
            // reserved `enabled`, so the operator's switch works on EVERY plugin
            // (R2) while an invented key is still a 400 that names everything accepted.
            const allowedDescriptors = effectiveSettingsOf(plugin);

            // Validate EVERY entry before mutating any of them, so one bad value cannot
            // leave the others applied (the same all-or-nothing rule `PATCH /config` follows).
            const prepared: Array<{ key: string; value: HarnessPluginSettingValue | null }> = [];

            for (const key of keys) {
                const descriptor = descriptorOf(allowedDescriptors, key);

                if (descriptor === undefined) {
                    const allowed = allowedDescriptors.map((entry) => entry.key);

                    throw new HarnessPluginSettingsError(
                        400,
                        `Unknown setting "${key}" for plugin "${plugin}". Allowed settings: ${
                            allowed.length === 0 ? 'none (this plugin declares no settings)' : allowed.join(', ')
                        }.`
                    );
                }

                const submitted = patch[key];

                // `null` (and `undefined`) is the documented RESET: drop the override so the
                // declared default applies again.
                prepared.push({
                    key,
                    value: submitted === null || submitted === undefined
                        ? null
                        : checkValue(plugin, descriptor, submitted)
                });
            }

            for (const entry of prepared) {
                if (entry.value === null) overrides.get(plugin)?.delete(entry.key);
                else put(plugin, entry.key, entry.value);
            }

            // A plugin with no remaining overrides keeps no empty map, so a snapshot stays
            // minimal and a document without the plugin entry means exactly "nothing changed".
            const remaining = overrides.get(plugin);

            if (remaining !== undefined && remaining.size === 0) overrides.delete(plugin);

            revision += 1;

            return valuesOf(plugin);
        },

        snapshot: () => {
            const result: HarnessPluginSettingsRecord = {};

            // Catalogue order, and only plugins that actually hold an override.
            for (const descriptor of catalogue) {
                if (!overrides.has(descriptor.name)) continue;

                const values = snapshotOf(descriptor.name);

                if (Object.keys(values).length > 0) result[descriptor.name] = values;
            }

            return result;
        },

        restore: (values?: HarnessPluginSettingsRecord) => applyRestore(values),

        revision: () => revision,

        provider
    };
};

/**
 * The server's ONE built-in settings provider over a store: the value to pass as
 * `HarnessPresetReport.pluginSettings`. Exposed as a helper so a host that builds harnesses
 * itself (a CLI, a test) reaches the same live reads the HTTP routes write.
 */
export const pluginSettingsProviderOf = (store: HarnessPluginSettingsStore): HarnessPluginSettingsProvider =>
    store.provider;

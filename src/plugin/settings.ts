// Plugin settings: the host read model plus the per-plugin typed view (R2/R3).
//
// TWO OBJECTS, ONE CONTRACT
// -------------------------
//   1. `HarnessPluginSettingsProvider` (../types) is the HOST side: `get(plugin, key)`
//      returns whatever the host has stored, and the optional `set(plugin, key, value)`
//      is where a write goes. Without T3.5 nothing in the harness wrote through it; with
//      T3.5 the ONLY writer is `api.settings.setOwn`, it writes THIS plugin's own
//      namespace, and it refuses a provider that implements `get` alone (the shipped
//      server's live provider) rather than keeping a copy the host would never read.
//   2. `createPluginSettingsView(name, provider, metadata)` is the PLUGIN side: the
//      scoped `api.settings`, which coerces to the declared type and falls back to the
//      plugin's OWN declared default.
//
// WHY A DEFAULT-SEEDED IN-MEMORY PROVIDER
// ---------------------------------------
// A harness built with no `configuration.pluginSettings` still has to answer a
// settings read, or every preset plugin would need its own "no host" branch. The
// default provider is seeded from each plugin's declared defaults and additionally
// carries the legacy `wakeIntervalMs` value under `async-ping.intervalMs`, so the
// documented configuration field keeps its exact meaning while the setting becomes the
// one the UI edits. It is mutable (`set`) so a host that has no persistence layer — a
// CLI, a test — can still drive a plugin.
//
// COERCION, NOT VALIDATION — AT THE READ EDGE
// -------------------------------------------
// `min`/`max`/`step` are UI hints and are deliberately NOT enforced on a READ: a host may
// legitimately store an out-of-range value (an operator typed it, a migration left it),
// and silently clamping would hide it. What IS enforced is the TYPE: a corrupt or
// mismatched stored value falls back to the default instead of handing a plugin `NaN`
// or the string `"false"`. Numeric STRINGS are accepted (a query parameter or a JSON
// document is where these settings actually come from), anything else is not.
//
// A WRITE is the other half of the contract (T3.5, `setOwn`): validating only the read
// would let a plugin persist a value its own read path then silently ignores. So the
// write edge enforces the declared type, `min` and `max`, normalizes the value to the
// declared type, and refuses a key the plugin never declared — while `step` stays a UI
// hint on BOTH edges. See `normalizeValue` below.
//
// Cross-references:
//   - ../types            — HarnessPluginSettingsProvider, HarnessPluginSettings, descriptors
//   - ./host.ts           — builds one view per plugin during runPlugins()
//   - ./manifest.ts       — the descriptors the default provider is seeded from

import { HarnessError } from '../util';
import type {
    HarnessPluginMetadata,
    HarnessPluginSettingDescriptor,
    HarnessPluginSettings,
    HarnessPluginSettingsProvider
} from '../types';

// The plugin name plus the value the host returned. Kept together so a view can
// report WHERE a bad value came from without another lookup.
type RawValue = { value: unknown };

// In-memory provider, optionally pre-seeded with per-plugin overrides.
//
// `seed` is a plugin-name → key → value map. The harness passes the legacy
// `wakeIntervalMs` through it; a host with no persistence can do the same by hand.
export const createInMemoryPluginSettingsProvider = (
    metadata: readonly HarnessPluginMetadata[],
    seed?: Record<string, Record<string, unknown>>
): HarnessPluginSettingsProvider & {
    set: (plugin: string, key: string, value: unknown) => void;
    // Every effective value, plugin by plugin (the server's settings projection).
    snapshot: () => Record<string, Record<string, unknown>>;
} => {
    // plugin → key → value. Seeded from declared defaults FIRST so an override or a
    // later `set` simply wins, and so a plugin with no descriptors has no entries
    // (its reads therefore fall back to the caller's own fallback, which is correct).
    const store = new Map<string, Map<string, unknown>>();

    const put = (plugin: string, key: string, value: unknown): void => {
        let entries = store.get(plugin);
        if (entries === undefined) {
            entries = new Map<string, unknown>();
            store.set(plugin, entries);
        }
        entries.set(key, value);
    };

    for (const descriptor of metadata) {
        for (const setting of descriptor.settings ?? []) {
            put(descriptor.name, setting.key, setting.default);
        }
    }

    for (const [plugin, entries] of Object.entries(seed ?? {})) {
        for (const [key, value] of Object.entries(entries)) {
            if (value === undefined) continue;
            put(plugin, key, value);
        }
    }

    return {
        get: (plugin: string, key: string) => store.get(plugin)?.get(key),
        set: (plugin: string, key: string, value: unknown) => put(plugin, key, value),
        snapshot: () => {
            const result: Record<string, Record<string, unknown>> = {};
            for (const [plugin, entries] of store) {
                result[plugin] = Object.fromEntries(entries);
            }
            return result;
        }
    };
};

// Declared descriptor of one key, when the plugin declared it.
const descriptorOf = (
    settings: readonly HarnessPluginSettingDescriptor[] | undefined,
    key: string
): HarnessPluginSettingDescriptor | undefined => settings?.find((entry) => entry.key === key);

// ---------------------------------------------------------------------------
// THE WRITE EDGE (T3.5) — `api.settings.setOwn`
// ---------------------------------------------------------------------------
// `min`/`max` and the declared type ARE enforced here, and `step` is not: the rules the
// shipped server applies at `PATCH /v1/harness/plugins/{plugin_id}`
// (src/server/plugins.ts, header "VALIDATION AT THE WRITE EDGE, COERCION AT THE READ
// EDGE"), restated here rather than imported — src/plugin/* must not depend on
// src/server/*, and the plugin surface throws `HarnessError` where the server throws its
// HTTP-stamped `HarnessPluginSettingsError`. The message wording is shared on purpose, so
// one bad value reads identically whichever edge refused it.
//
// `min`/`max` are the bounds the plugin PUBLISHED, so a value outside them is a value the
// plugin never said it could handle; `step` is a UI hint (see the descriptor comment in
// ../types) and refusing `1500` because `step: 1000` would make this write stricter than
// the runtime that has to live with the number.

// The shape every accepted write lands on: exactly the declared type, so a stored value
// is always readable by the coercive read path AND JSON-serializable by a host store.
type NormalizedSettingValue = number | string | boolean;

// `"key" of plugin "name"` — the same label the server's write edge puts in its errors.
const settingLabel = (plugin: string, key: string): string =>
    `"${key}" of plugin "${plugin}"`;

// A `number` setting: a JSON number, or a numeric string the read path would also
// accept, and it must land on a FINITE value inside `min`/`max`.
const normalizeNumber = (
    plugin: string,
    descriptor: HarnessPluginSettingDescriptor,
    value: unknown
): number => {
    const where = settingLabel(plugin, descriptor.key);
    let numeric: number | undefined;

    if (typeof value === 'number') numeric = value;
    else if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        numeric = Number.isFinite(parsed) ? parsed : undefined;
    }

    if (numeric === undefined || !Number.isFinite(numeric)) {
        throw new HarnessError(`${where} must be a finite number (it is declared "number").`);
    }

    if (descriptor.min !== undefined && numeric < descriptor.min) {
        throw new HarnessError(
            `${where} must be at least ${String(descriptor.min)}; ${String(numeric)} was submitted.`
        );
    }

    if (descriptor.max !== undefined && numeric > descriptor.max) {
        throw new HarnessError(
            `${where} must be at most ${String(descriptor.max)}; ${String(numeric)} was submitted.`
        );
    }

    return numeric;
};

// A `string` setting accepts a string ONLY. The read path will render a stored number as
// text, but a WRITE that says `settings: 12` for a text field is far likelier a client
// bug than a value, and silence is how such a bug survives to production.
const normalizeString = (
    plugin: string,
    descriptor: HarnessPluginSettingDescriptor,
    value: unknown
): string => {
    if (typeof value !== 'string') {
        throw new HarnessError(
            `${settingLabel(plugin, descriptor.key)} must be a string (it is declared "string").`
        );
    }

    return value;
};

// A `boolean` setting: a JSON boolean, or the two words the read path also parses.
const normalizeBoolean = (
    plugin: string,
    descriptor: HarnessPluginSettingDescriptor,
    value: unknown
): boolean => {
    const where = settingLabel(plugin, descriptor.key);

    if (typeof value === 'boolean') return value;

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();

        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }

    throw new HarnessError(`${where} must be true or false (it is declared "boolean").`);
};

// Validate one submitted value against its descriptor and normalize it to that type.
const normalizeValue = (
    plugin: string,
    descriptor: HarnessPluginSettingDescriptor,
    value: unknown
): NormalizedSettingValue => {
    if (descriptor.type === 'number') return normalizeNumber(plugin, descriptor, value);
    if (descriptor.type === 'boolean') return normalizeBoolean(plugin, descriptor, value);

    return normalizeString(plugin, descriptor, value);
};

// A stored value that is `undefined`/`null` counts as "nothing stored" everywhere.
const present = (raw: RawValue): boolean => raw.value !== undefined && raw.value !== null;

// Number coercion: a finite number, or a numeric string that parses to one.
const asNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};

const asBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return undefined;
};

const asString = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    // A scalar stored as a number/boolean is still readable text; an object is not.
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
};

// The declared default of `key`, typed loosely on purpose: the coercion below decides
// whether it is usable for the accessor being called, so a descriptor whose `default`
// does not match its own `type` degrades to the caller's fallback rather than throwing.
const declaredDefault = (
    settings: readonly HarnessPluginSettingDescriptor[] | undefined,
    key: string
): unknown => descriptorOf(settings, key)?.default;

// Build one plugin's `api.settings`.
//
// `provider` is read on EVERY call (not captured once at setup): a host may change the
// value between turns, and a plugin that read a stale number at construction is exactly
// the "settings do not apply until restart" bug this exists to avoid.
export const createPluginSettingsView = (
    plugin: string,
    provider: HarnessPluginSettingsProvider,
    settings?: readonly HarnessPluginSettingDescriptor[]
): HarnessPluginSettings => {
    const raw = (key: string): RawValue => ({ value: provider.get(plugin, key) });

    // Order is fixed for every accessor: stored value → declared default → argument
    // fallback → the accessor's own neutral value.
    const resolve = <T>(
        key: string,
        fallback: T | undefined,
        convert: (value: unknown) => T | undefined
    ): T => {
        const stored = raw(key);
        if (present(stored)) {
            const converted = convert(stored.value);
            if (converted !== undefined) return converted;
        }

        const fromDescriptor = convert(declaredDefault(settings, key));
        if (fromDescriptor !== undefined) return fromDescriptor;

        return fallback as T;
    };

    return {
        get: (key: string) => {
            const stored = raw(key);
            return present(stored) ? stored.value : declaredDefault(settings, key);
        },
        number: (key: string, fallback?: number) =>
            resolve(key, fallback ?? Number.NaN, asNumber),
        string: (key: string, fallback?: string) => resolve(key, fallback ?? '', asString),
        boolean: (key: string, fallback?: boolean) => resolve(key, fallback ?? false, asBoolean),
        // ONE plugin's own key, written through the HOST's provider (T3.5). Order is
        // fixed and all-or-nothing like every other mutation on this surface: resolve the
        // key → validate and normalize the value → reach the writer. A refusal therefore
        // cannot half-write, and a caller's typo is reported before a host's missing
        // writer, because the typo is the actionable one.
        setOwn: (key: string, value: unknown): void => {
            const descriptor = descriptorOf(settings, key);

            if (descriptor === undefined) {
                // An unknown key is refused with the declared set named rather than
                // stored and then ignored forever — the same rule the server's write edge
                // states (src/server/plugins.ts, last bullet of the header).
                const declared = (settings ?? []).map((entry) => `"${entry.key}"`).join(', ');

                throw new HarnessError(
                    `settings.setOwn received "${key}", which plugin "${plugin}" does not declare${
                        declared.length === 0 ? ' (it declares no settings)' : ` (declared: ${declared})`
                    }.`
                );
            }

            const stored = normalizeValue(plugin, descriptor, value);

            // THE "NO WRITER" ANSWER, stated in the type (../types, `setOwn`) and here:
            // a read-only provider has no place to put this, and keeping a private copy
            // the host never reads would be a lie — the shipped server's live provider is
            // exactly this case, so a plugin write there fails loudly instead of looking
            // durable. Wiring a host store's write path is host work.
            if (typeof provider.set !== 'function') {
                throw new HarnessError(
                    `settings.setOwn cannot store ${settingLabel(plugin, key)}: this harness's plugin-settings provider is read-only (no writer).`
                );
            }

            provider.set(plugin, key, stored);
        }
    };
};

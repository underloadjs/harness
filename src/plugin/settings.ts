// Plugin settings: the host read model plus the per-plugin typed view (R2/R3).
//
// TWO OBJECTS, ONE CONTRACT
// -------------------------
//   1. `HarnessPluginSettingsProvider` (../types) is the HOST side: `get(plugin, key)`
//      returns whatever the host has stored. A server will back it with a persisted
//      session document; nothing in the harness writes through it.
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
// COERCION, NOT VALIDATION
// ------------------------
// `min`/`max`/`step` are UI hints and are deliberately NOT enforced here: a host may
// legitimately store an out-of-range value (an operator typed it, a migration left it),
// and silently clamping would hide it. What IS enforced is the TYPE: a corrupt or
// mismatched stored value falls back to the default instead of handing a plugin `NaN`
// or the string `"false"`. Numeric STRINGS are accepted (a query parameter or a JSON
// document is where these settings actually come from), anything else is not.
//
// Cross-references:
//   - ../types            — HarnessPluginSettingsProvider, HarnessPluginSettings, descriptors
//   - ./host.ts           — builds one view per plugin during runPlugins()
//   - ./manifest.ts       — the descriptors the default provider is seeded from

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
        boolean: (key: string, fallback?: boolean) => resolve(key, fallback ?? false, asBoolean)
    };
};

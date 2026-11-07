// Plugin host — discovery order, application, and the per-plugin api (R2/R3/R4).
//
// "Everything is a plugin" only holds if the extension surface is tiny and the
// application order is obvious. Both are still true, and the framework keeps them so:
//
//   - A plugin is `{ name, metadata?, setup? }`. Nothing else.
//   - setup() is synchronous and runs once, in array order, during harness().
//     Synchronous is a deliberate constraint: it keeps `const writer =
//     harness({...})` a plain expression with no await at the call site. A plugin that
//     needs async work does it in a lifecycle hook (the bus AWAITS handlers) or lazily
//     on first use — either way the call site does not change shape.
//   - Setup receives a HarnessPluginApi: the live registries, createAgent/addTool/
//     addCommand, the lifecycle bus (`on`), THIS plugin's scoped `settings`, and the
//     harness-control surface (`threads`, enable/disable tool, `async`, `config`).
//
// APPLICATION ORDER (the part that must never be surprising)
// ----------------------------------------------------------
//   1. auto-discovered built-ins (`./manifest.ts`, generated from src/plugins);
//   2. `configuration.plugins`, in the order the host listed them.
// A name in (2) REPLACES the built-in of that name in place — that is how an operator
// swaps the shipped compaction or ping plugin out without editing the package, and it
// is the same "later registration wins" rule `addTool`/`addCommand` already use.
// Two entries in `configuration.plugins` with the SAME name are still an error: unlike
// the built-in case there is no precedence story, and a duplicate there is a copy-paste
// mistake in the plugin list.
//
// WHY `on`/`settings` ARE BUILT HERE AND NOT IN harness.ts
// -------------------------------------------------------
// Both are per-plugin: `on` records the owning plugin (and hands that plugin's OWN api
// back inside `turn.before`, so a hook reads its own settings), and `settings` is scoped
// to the plugin's name plus its declared defaults. harness() therefore supplies the
// shared, plugin-agnostic part of the api (`apiBase`) and this module wraps it once per
// plugin. The result is that a plugin can never read or write another plugin's settings
// namespace by accident.
//
// Cross-references:
//   - ./manifest.ts  — generated: BUILTIN_PLUGINS / BUILTIN_PLUGIN_DESCRIPTORS
//   - ./hooks.ts     — the bus `on` subscribes to, and its fail-open rules
//   - ./settings.ts  — the provider read model and the coercion rules
//   - ../types       — HarnessPlugin, HarnessPluginApi, HarnessPluginMetadata
//   - ../harness.ts  — calls runPlugins() while constructing the writer

import { HarnessError } from '../util';
import { createPluginSettingsView } from './settings';
import type { HarnessHookBus } from './hooks';
import type {
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata,
    HarnessPluginSettingsProvider
} from '../types';

// The shared half of the api: everything except the two per-plugin members. The
// harness builds this once; this module clones it per plugin.
export type HarnessPluginApiBase = Omit<HarnessPluginApi, 'on' | 'settings'>;

export type HarnessPluginHostOptions = {
    // Generated auto-discovered plugins, applied first. Absent = none (a host that
    // passes `builtins: []` opts out of the package presets deliberately).
    builtins?: readonly HarnessPlugin[];
    // `configuration.plugins`, applied after the built-ins and able to replace one.
    plugins?: readonly HarnessPlugin[];
    // The harness's hook bus.
    hooks: HarnessHookBus;
    // Host-side settings read model (already defaulted by the caller when absent).
    settings: HarnessPluginSettingsProvider;
    // Plugin-agnostic api surface from the harness.
    apiBase: HarnessPluginApiBase;
};

export type HarnessPluginHostResult = {
    // Applied plugin names, in application order (duplicates impossible).
    names: readonly string[];
    // Declared metadata for every APPLIED plugin, same order. A plugin that shipped
    // no metadata gets a synthesized entry so the UI list stays complete.
    metadata: readonly HarnessPluginMetadata[];
};

// The description the UI sees for one plugin.
//
// `builtin` is normalized to the RESOLUTION, not to what the file declared: a
// discovered built-in is builtin, and a host-supplied plugin is not even when its own
// metadata claims otherwise. Provenance is a fact about how the plugin was LOADED, so a
// hand-written entry cannot upgrade itself to "shipped" — which matters because the UI
// offers a reset-to-default affordance on that flag.
const metadataOf = (plugin: HarnessPlugin, builtin: boolean): HarnessPluginMetadata =>
    plugin.metadata === undefined
        ? { name: plugin.name, title: plugin.name, builtin }
        : { ...plugin.metadata, builtin };

// Resolve built-ins plus host plugins into the single ordered list to apply.
//
// Kept separate from application so a test (and the server's plugin listing) can read
// the same precedence rules without running any setup().
export const resolvePluginList = (
    builtins: readonly HarnessPlugin[] = [],
    plugins: readonly HarnessPlugin[] = []
): { plugin: HarnessPlugin; builtin: boolean }[] => {
    const resolved: { plugin: HarnessPlugin; builtin: boolean }[] = [];
    const indexOfName = new Map<string, number>();

    const place = (plugin: HarnessPlugin, builtin: boolean): void => {
        if (!plugin.name) {
            throw new HarnessError('A plugin requires a name.');
        }

        const existing = indexOfName.get(plugin.name);

        if (existing === undefined) {
            indexOfName.set(plugin.name, resolved.length);
            resolved.push({ plugin, builtin });
            return;
        }

        // The ONLY legal collision is a host plugin replacing a discovered built-in.
        // Two built-ins with one name is a manifest bug (the scanner rejects it, and a
        // silent drop would hide it), and two host entries with one name have no honest
        // precedence — both are errors.
        if (builtin || resolved[existing].builtin === false) {
            throw new HarnessError(`Plugin "${plugin.name}" is registered more than once.`);
        }

        // A built-in is replaced IN PLACE: the position is part of the documented
        // order, and a replacement that ran later would change when its hooks fire
        // relative to every other plugin's.
        resolved[existing] = { plugin, builtin };
    };

    for (const plugin of builtins) place(plugin, true);
    for (const plugin of plugins) place(plugin, false);

    return resolved;
};

// Apply every resolved plugin in order and report what the harness now consists of.
export const runPlugins = (options: HarnessPluginHostOptions): HarnessPluginHostResult => {
    const { builtins = [], plugins = [], hooks, settings, apiBase } = options;
    const resolved = resolvePluginList(builtins, plugins);

    const names: string[] = [];
    const metadata: HarnessPluginMetadata[] = [];

    for (const { plugin, builtin } of resolved) {
        const declared = metadataOf(plugin, builtin);

        // Scoped settings need the DECLARED descriptors: the fallback default of
        // `api.settings.number(key)` comes from what the plugin itself declares, so a
        // host with no settings document still gets a sensible value.
        const api: HarnessPluginApi = {
            ...apiBase,
            settings: createPluginSettingsView(plugin.name, settings, declared.settings),
            // `api` is passed back to the bus so `turn.before` hands THIS plugin its
            // own scoped api. Declared-before-assignment is fine: the bus only reads it
            // during an emit, which cannot happen before setup() has returned.
            on: (event, handler) => hooks.on(event, handler, { owner: plugin.name, api })
        };

        plugin.setup?.(api);

        names.push(plugin.name);
        metadata.push(declared);
    }

    return { names, metadata };
};

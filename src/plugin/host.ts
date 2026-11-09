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
//     addCommand, the lifecycle bus (`on`), THIS plugin's scoped `settings` (read, and one
//     namespaced write — `setOwn`, T3.5), the harness-control surface (`threads`,
//     enable/disable tool, `async`, `config`), and the host's own persisted-state read
//     (`snapshot`, T3.5 — a detached document, safe mid-run).
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
// THE GLOBAL ENABLEMENT GATE (R2 — the operator's click)
// -----------------------------------------------------
// One reserved boolean setting key, `enabled`, decides whether a plugin's handlers are
// DELIVERED anything. It is gated HERE, in the one place that knows both the plugin's
// declared defaults and the host's live provider, so (a) no plugin has to implement the
// switch itself, (b) a plugin that declares the key (context-compaction) and the
// framework agree on one stored value, and (c) a plugin that does NOT declare it
// (async-ping) still answers to it, default `true`.
//
// The gate is a function handed to the bus registration, not a boolean captured at
// setup: `api.settings.boolean('enabled', true)` re-reads the provider every time, so a
// `PATCH /v1/harness/plugins/{plugin_id}` lands on every live session at its next turn
// with no rebuild and no re-registration. A disabled plugin stays LOADED and LISTED
// (its tools, agents and commands stay registered, its row still shows in `GET
// /plugins` with `enabled: false`) — only hook delivery stops, and `harness.dispose`
// is exempt so cleanup always runs (./hooks.ts rule 9).
//
// Cross-references:
//   - ./manifest.ts  — generated: BUILTIN_PLUGINS / BUILTIN_PLUGIN_DESCRIPTORS
//   - ./hooks.ts     — the bus `on` subscribes to, its fail-open rules, and rule 9
//   - ../server/plugins.ts — the stored `enabled` override and the live provider
//   - ../server/api.ts     — `PATCH /v1/harness/plugins/{plugin_id}`, the write edge
//   - ./settings.ts  — the provider read model and the coercion rules
//   - ../types       — HarnessPlugin, HarnessPluginApi, HarnessPluginMetadata
//   - ../harness.ts  — calls runPlugins() while constructing the writer

import { HarnessError } from '../util';
import { createPluginSettingsView } from './settings';
import type { HarnessHookBus } from './hooks';
import type {
    HarnessHookOptions,
    HarnessLifecycleEvent,
    HarnessLifecycleHandler,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata,
    HarnessPluginSettingsProvider,
    HarnessWildcardHandler
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
    // The reserved `enabled` boolean key of this provider is ALSO the plugin's global
    // switch: it gates every hook delivery (see the gate inside `runPlugins` and
    // ./hooks.ts rule 9), because a settings read is re-resolved on every access.
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
    // The HOST provider is renamed here: `settings` below is the per-plugin scoped view
    // built on top of it, and conflating the two is how a plugin would end up reading
    // another plugin's namespace.
    const { builtins = [], plugins = [], hooks, settings: provider, apiBase } = options;
    const resolved = resolvePluginList(builtins, plugins);

    const names: string[] = [];
    const metadata: HarnessPluginMetadata[] = [];

    for (const { plugin, builtin } of resolved) {
        const declared = metadataOf(plugin, builtin);

        // Scoped settings need the DECLARED descriptors: the fallback default of
        // `api.settings.number(key)` comes from what the plugin itself declares, so a
        // host with no settings document still gets a sensible value.
        const settings = createPluginSettingsView(plugin.name, provider, declared.settings);

        // GLOBAL ENABLEMENT (R2/R3, the operator's click) — the framework gate, stated
        // ONCE here so no plugin has to implement it. The reserved `enabled` boolean
        // key of THIS plugin's settings view decides whether its handlers are delivered
        // a hook, and the view re-reads the host provider on every access
        // (./settings.ts:266-271), so an operator's `PATCH /v1/harness/plugins/
        // {plugin_id}` changes what an ALREADY RUNNING session does on its next turn —
        // every session, because every harness was built with the one live provider
        // (../server/sessions.ts `buildHarness`, ../server/plugins.ts `provider`).
        //
        // `?? true` order matters: stored override → the plugin's own declared default
        // (context-compaction declares `enabled: true`, and its Rule-0 read and this
        // gate therefore agree) → `true` for a plugin that declares no such key. The
        // plugin is NOT unregistered: it stays loaded, stays listed with
        // `enabled: false`, and `harness.dispose` still reaches it so its own teardown
        // runs (plugin/hooks.ts rule 9).
        const isEnabled = (): boolean => settings.boolean('enabled', true);

        const api: HarnessPluginApi = {
            ...apiBase,
            settings,
            // T4.5 — the diagnostic channel, attributed. The base api is shared by every
            // plugin and reports as 'harness'; a policy report has to name the plugin that
            // made it, or an operator reading one stream cannot tell the compactor's decisions
            // from a host subscription's. Everything else (the sink, the empty-message drop,
            // the throw-proof wrapper) stays the base implementation.
            report: {
                diagnostic: (report) => apiBase.report.diagnostic({ ...report, owner: plugin.name })
            },
            // `api` is passed back to the bus so `turn.before` hands THIS plugin its
            // own scoped api. Declared-before-assignment is fine: the bus only reads it
            // when it runs, which cannot happen before setup() has returned.
            //
            // T1.3/T1.4 — the author's `{ priority, timeoutMs }` ride through into the
            // bus registration unchanged; the bus owns every default (0, unbounded), so
            // an author who passes nothing gets exactly what every plugin has always
            // gotten. The cast is only because `api.on` is an OVERLOAD pair (named vs
            // `'*'`, T1.1) and an implementation arrow cannot be inferred against two
            // signatures at once — the runtime body is the same for both forms.
            on: ((
                event: HarnessLifecycleEvent | '*',
                handler: HarnessLifecycleHandler<HarnessLifecycleEvent> | HarnessWildcardHandler,
                options?: HarnessHookOptions
            ) =>
                hooks.on(
                    event as HarnessLifecycleEvent,
                    handler as HarnessLifecycleHandler<HarnessLifecycleEvent>,
                    { owner: plugin.name, api, enabled: isEnabled, ...(options ?? {}) }
                )) as unknown as HarnessPluginApi['on']
        };

        plugin.setup?.(api);

        names.push(plugin.name);
        metadata.push(declared);
    }

    return { names, metadata };
};

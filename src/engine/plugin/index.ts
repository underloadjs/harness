// @underload/harness plugin — the programmatic extension host.
//
// Applied by harness() during construction. Declarative configuration covers agents
// and tools; plugins exist for behaviour that needs code at build time AND for
// behaviour that must participate in the run (lifecycle hooks, harness control).
//
// Three parts, one directory:
//   - ./manifest  — GENERATED: the auto-discovered built-ins scanned from src/plugins
//   - ./host      — precedence (built-in, then configuration.plugins replacing it) and
//                   the per-plugin api (scoped settings + `on`)
//   - ./hooks     — the typed, sequential, fail-open lifecycle bus
//   - ./settings  — host read model + the per-plugin typed settings view
export { runPlugins, resolvePluginList } from './host';
export type {
    HarnessPluginApiBase,
    HarnessPluginHostOptions,
    HarnessPluginHostResult
} from './host';
export { createHookBus } from './hooks';
export type {
    HarnessHookBus,
    HarnessHookBusOptions,
    HarnessHookErrorContext,
    // The registration object `HarnessHookBus.on` takes (owner/api plus the T1.3/T1.4
    // `priority`/`timeoutMs`), exported so a host typing its own bus call can name it.
    HarnessHookRegistration,
    HarnessMergedHookResult
} from './hooks';
export { createInMemoryPluginSettingsProvider, createPluginSettingsView } from './settings';
export { BUILTIN_PLUGINS, BUILTIN_PLUGIN_DESCRIPTORS } from './manifest';

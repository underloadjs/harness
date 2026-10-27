// Plugin host.
//
// "Everything is a plugin" only holds if the extension surface is tiny and the
// application order is obvious. Both are true here:
//
//   - A plugin is `{ name, setup? }`. Nothing else.
//   - setup() is synchronous and runs once, in array order, during harness().
//     Synchronous is a deliberate constraint: it keeps `const writer =
//     harness({...})` a plain expression with no await at the call site. A plugin
//     that needs async work does it lazily on first use, or the host grows an
//     explicit `ready()` later — either way the call site does not change shape.
//   - Setup receives a HarnessPluginApi with the live agent and tool registries
//     plus createAgent()/addTool(). That is the entire surface.
//
// Why the declarative config exists alongside this:
//   `agents` and `tools` cover the overwhelming majority of cases with no code.
//   Plugins are for behaviour that must run at construction time — registering a
//   family of agents, or contributing tools from a module.
//
// Cross-references:
//   - ../types     — HarnessPlugin, HarnessPluginApi
//   - ../harness   — calls runPlugins() while constructing the harness

import { HarnessError } from '../util';
import type { HarnessPlugin, HarnessPluginApi } from '../types';

// Apply every plugin in order. Returns the applied names so the harness can
// report what shaped the writer.
//
// Duplicate names are rejected rather than silently applied twice: a plugin that
// registers hooks is not safe to run twice, and a duplicate is almost always a
// copy-paste mistake in the plugin list.
export const runPlugins = (
    plugins: readonly HarnessPlugin[],
    api: HarnessPluginApi
): string[] => {
    const applied: string[] = [];

    for (const plugin of plugins) {
        if (!plugin.name) {
            throw new HarnessError('A plugin requires a name.');
        }

        if (applied.includes(plugin.name)) {
            throw new HarnessError(`Plugin "${plugin.name}" is registered more than once.`);
        }

        plugin.setup?.(api);
        applied.push(plugin.name);
    }

    return applied;
};

// The catalogue shared by the CLI and the HTTP server.
//
// Nothing here is exported from the package root: the published surface stays
// `src/harness.ts`. This folder is the application built on top of that surface —
// it defines the presets the app can run and the tools it can call directly.
//
// RUNTIME, NOT MODULE STATE
// -------------------------
// The direct-call catalogue now includes `webSearch`, which depends on a provider
// key. Keys arrive from `.env`, and the server/CLI load that file *after* their
// imports are evaluated. A module-level catalogue would therefore capture whatever
// the environment happened to contain at import time (usually nothing). So the
// catalogue is a factory:
//
//     const { entries, tools, find } = createToolCatalogue();
//
// Call it after `loadEnvironmentFile()` — `server/index.ts` does exactly that —
// and pass the result into `createHarnessHandler`. Live sessions are unaffected:
// presets opt into `websearch: true` (the configuration field keeps its name) and read the same environment when the
// harness is constructed, which already happens after the load.
//
// Cross-references:
//   - ./websearch  — the always-listed, conditionally-callable search entry
//   - ./types      — CatalogueEntry / ToolAvailability / ToolGroup
//   - ../server/handler.ts — GET /api/tools, POST /api/tools/:name
//   - ../cli/index.ts      — `--tools` and `/tools`

import { presetTools } from '../src/harness';
import type { Tool } from '../src/harness';
import { harnessTools } from './tools';
import { presets, PRESET_MAX_ITERATIONS } from './presets';
// Value import for the local findPreset() below. The barrel also re-exports the
// constant so callers keep importing it from here.
import { PRESET_ALIASES } from './registry';
import { createWebSearchCatalogueEntry } from './websearch';
import type { WebSearchCatalogueEntry } from './websearch';
import type { CatalogueEntry, HarnessPreset, ToolGroup } from './types';

export { presets, harnessTools, PRESET_MAX_ITERATIONS };
export {
    CORE_ENVIRONMENT_TOOL_NAMES,
    CORE_PRESET_TOOL_NAMES,
    CORE_TOOL_NAMES,
    SHARED_APP_TOOL_NAMES,
    SHARED_TOOL_NAMES,
    SHARED_TOOLS,
    agentFromProfile,
    agentsFromProfiles,
    coreToolNames,
    createProfiledHarness,
    createToolboxHarness,
    providerOf
} from './toolbox';
export type { ToolboxHarnessConfiguration } from './toolbox';
export { createHarnessRegistry, HarnessRegistryError, PRESET_ALIASES } from './registry';
export type { HarnessPatch, HarnessRegistration, HarnessRegistry } from './registry';
export { describeAgent, describeAgents, describeHarness } from './descriptor';
export type { DescriptorCatalogue } from './descriptor';
export {
    CORE_TOOL_GROUP,
    CORE_TOOL_SESSION_HINT,
    createCoreToolEntries
} from './core';
export { scriptedDemo } from './demo';
export { createWebSearchCatalogueEntry, WEBSEARCH_ENVIRONMENT, WEBSEARCH_UNCONFIGURED_HINT } from './websearch';
export type { WebSearchCatalogueEntry, WebSearchCatalogueOptions } from './websearch';
export type { CatalogueEntry, HarnessPreset, RunnerSettings, ToolAvailability, ToolGroup } from './types';

// The trusted agent registry is re-exported through the app barrel because the
// server and the CLI both need the same ids when they validate a harness request
// or build an agent. The profiles themselves live in src/agents.
export {
    AGENT_PROFILES,
    AGENT_PROFILE_NAMES,
    agentInstruction,
    agentProfile,
    agentProfiles,
    isAgentProfileName
} from '../src/agents';
export type { AgentProfile } from '../src/agents';

// One catalogue built for one host. `entries` is the display order (grouped, and
// stable so a UI never has to sort); `tools` holds only executable definitions;
// `find` answers "is this name known, and can it run?" in one lookup.
export type ToolCatalogue = {
    entries: readonly CatalogueEntry[];
    tools: Readonly<Record<string, Tool>>;
    find: (name: string) => CatalogueEntry | undefined;
};

export type ToolCatalogueOptions = {
    // Inject the credential-dependent entry. Defaults to a fresh entry built from
    // the current process environment — at call time, never at import time.
    // Tests pass an explicitly configured or keyless entry.
    websearch?: WebSearchCatalogueEntry;
};

// Copy a Tool into a catalogue entry. The metadata is snapshotted so a disabled
// entry (which has no Tool) can be rendered by the same code path, and so a
// later rename of the definition cannot make the catalogue disagree with itself.
const entryOf = (name: string, tool: Tool, group: ToolGroup): CatalogueEntry => ({
    name,
    group,
    tool,
    description: tool.description,
    tags: [...tool.tags],
    visibility: tool.visibility,
    parameters: tool.parameters ?? { type: 'object', properties: {} }
});

export const createToolCatalogue = (options: ToolCatalogueOptions = {}): ToolCatalogue => {
    // Built here, after the caller has had a chance to load `.env`.
    const websearch = options.websearch ?? createWebSearchCatalogueEntry();

    const entries: CatalogueEntry[] = [];
    const tools: Record<string, Tool> = {};
    const seen = new Set<string>();

    // Package presets come first so a harness-level tool can never silently
    // shadow one of them; a duplicate name anywhere is a catalogue bug.
    const addGroup = (group: ToolGroup, definitions: Readonly<Record<string, Tool>>): void => {
        for (const [name, tool] of Object.entries(definitions)) {
            if (seen.has(name)) {
                throw new Error(`The tool catalogue has two entries named "${name}".`);
            }

            seen.add(name);
            entries.push(entryOf(name, tool, group));

            // Only executable definitions go in the call map. `entries` may also
            // hold an unconfigured descriptor, which has no `tool`.
            tools[name] = tool;
        }
    };

    addGroup('Package presets', presetTools);
    addGroup('Harness tools', harnessTools);

    // Web search is always listed, configured or not. The entry carries static
    // metadata when no key exists; `tool` stays absent so nothing can call it and
    // `availability` tells the client exactly why.
    if (seen.has(websearch.entry.name)) {
        throw new Error(`The tool catalogue has two entries named "${websearch.entry.name}".`);
    }

    seen.add(websearch.entry.name);
    entries.push(websearch.entry);

    if (websearch.tool !== undefined) tools[websearch.entry.name] = websearch.tool;

    return {
        entries,
        tools,
        find: (name) => entries.find((entry) => entry.name === name)
    };
};

// Resolve a preset name, including an alias, against any static catalogue. The
// catalogue parameter lets a caller (the CLI) keep using the shipped list; the
// server resolves sessions through a live HarnessRegistry instead, so a
// user-created harness participates there. Aliases themselves are re-exported
// from ./registry.ts above.
export const findPreset = (
    name: string,
    catalogue: readonly HarnessPreset[] = presets
): HarnessPreset | undefined => {
    const direct = catalogue.find((preset) => preset.name === name);
    if (direct !== undefined) return direct;

    const canonical = PRESET_ALIASES[name];
    if (canonical === undefined) return undefined;

    return catalogue.find((preset) => preset.name === canonical);
};

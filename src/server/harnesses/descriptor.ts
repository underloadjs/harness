// Wire descriptors for the harness catalogue and the agent registry.
//
// WHY THIS IS A SEPARATE MODULE
// -----------------------------
// Two consumers need the same projection:
//   - src/server/api.ts      — GET /harnesses, GET /agents, POST/PATCH responses;
//   - src/server/sessions.ts — the frozen `harnessDefinition` a session records at
//                          creation, so a UI can render the configuration it was
//                          built with even after the registry changes.
// Keeping one `describeHarness()` means the card a client sees before creating a
// session and the frozen definition inside that session can never disagree.
//
// `catalogue` is optional. It says WHICH environment-backed tools this host can
// actually run (webSearch today). The session store does not own a catalogue, so
// the host injects a bound describer (src/server/start.ts, src/server/runtime.ts); a
// describer without one is honest about only the statically declared tools.
//
// Cross-references:
//   - ./types.ts          — HarnessPreset (the source of the fields)
//   - ./toolbox.ts        — coreToolNames / CORE_PRESET_TOOL_NAMES / SHARED_TOOL_NAMES
//   - ../src/agents       — AgentProfile (the trusted agent definitions)
//   - ../protocol  — HarnessDescriptor / AgentDescriptor (wire tuples)

import type { AgentProfile } from '../../agents';
import type { AgentDescriptor, HarnessDescriptor } from '../protocol';
import type { HarnessPreset } from './types';
import { coreToolNames } from './toolbox';

// The only part of the runtime tool catalogue a descriptor reads: whether a name
// has an executable definition. Structural so this module never imports the
// catalogue factory (which imports the presets → a cycle).
export type DescriptorCatalogue = {
    tools: Readonly<Record<string, unknown>>;
};

// Project one agent profile onto the wire. Only metadata: the instruction and
// guidelines are trusted catalogue text, and they are exposed because the UI
// renders what an agent is told. No secrets exist in a profile.
export const describeAgent = (profile: AgentProfile): AgentDescriptor => ({
    name: profile.name,
    title: profile.title,
    description: profile.description,
    instruction: profile.instruction,
    guidelines: [...profile.guidelines]
});

export const describeAgents = (profiles: readonly AgentProfile[]): AgentDescriptor[] =>
    profiles.map(describeAgent);

// Project one harness onto the wire.
//
// `tools` is the declared list plus the environment-backed names
// (`environmentTools`, see types.ts) that this host can ACTUALLY run: a name is
// appended only when the runtime catalogue has an executable definition for it. A
// keyless host therefore advertises exactly what it can call and never claims a
// search tool that would answer `ok: false`.
//
// `coreTools` is the exact set this card's runs declare up front (R18): the four
// core package file tools, a configured webSearch, the harness-owned
// toolRequest/toolCreate/todoManage, and agentDelegate when there is a subagent
// allowlist. It is computed from the REGISTERED names, not a static "all core"
// list, so the demo fixture (timeNow only) does not claim file tools and a keyless
// host does not claim webSearch. A UI core dropdown can therefore trust it instead
// of hard-coding the harness-owned names.
//
// `agentModels` (R9) is emitted only when at least one agent has an override, so
// every existing card keeps its exact descriptor shape. It is the OVERRIDE map,
// not the effective one: an agent it omits uses the session's model.
export const describeHarness = (
    preset: HarnessPreset,
    catalogue?: DescriptorCatalogue
): HarnessDescriptor => {
    // The exact names this card registers: the declarative preset list plus every
    // environment-backed name THIS host can actually run. webSearch is the only
    // entry there today, and it is added only when the runtime catalogue has an
    // executable definition (a provider key resolved).
    const registered = [
        ...preset.tools,
        ...(preset.environmentTools ?? []).filter(
            (name) => catalogue?.tools[name] !== undefined && !preset.tools.includes(name)
        )
    ];

    return {
        name: preset.name,
        title: preset.title,
        description: preset.description,
        requiresEndpoint: preset.requiresEndpoint,
        primary: preset.primary,
        subagents: [...preset.subagents],
        agents: [...preset.agents],
        tools: registered,
        coreTools: coreToolNames(preset.subagents, registered),
        ...(Object.keys(preset.agentModels ?? {}).length > 0
            ? { agentModels: { ...preset.agentModels } }
            : {}),
        builtin: preset.builtin,
        editable: preset.editable
    };
};

// Wire descriptors for the harness catalogue and the agent registry.
//
// WHY THIS IS A SEPARATE MODULE
// -----------------------------
// Two consumers need the same projection:
//   - server/api.ts      — GET /harnesses, GET /agents, POST/PATCH responses;
//   - server/sessions.ts — the frozen `harnessDefinition` a session records at
//                          creation, so a UI can render the configuration it was
//                          built with even after the registry changes.
// Keeping one `describeHarness()` means the card a client sees before creating a
// session and the frozen definition inside that session can never disagree.
//
// `catalogue` is optional. It says WHICH environment-backed tools this host can
// actually run (webSearch today). The session store does not own a catalogue, so
// the host injects a bound describer (server/index.ts, server/runtime.ts); a
// describer without one is honest about only the statically declared tools.
//
// Cross-references:
//   - ./types.ts          — HarnessPreset (the source of the fields)
//   - ./toolbox.ts        — coreToolNames / SHARED_TOOL_NAMES
//   - ../src/agents       — AgentProfile (the trusted agent definitions)
//   - ../server/protocol  — HarnessDescriptor / AgentDescriptor (wire tuples)

import type { AgentProfile } from '../src/agents';
import type { AgentDescriptor, HarnessDescriptor } from '../server/protocol';
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
// `coreTools` comes from the harness-owned list only: toolRequest,
// toolCreate, todoManage, plus agentDelegate when there is a subagent allowlist. No
// preset entry is core any more (the whole catalogue is searchable), so the
// descriptor cannot advertise a declared file tool that is not actually declared.
//
// `agentModels` (R9) is emitted only when at least one agent has an override, so
// every existing card keeps its exact descriptor shape. It is the OVERRIDE map,
// not the effective one: an agent it omits uses the session's model, which is what
// lets a UI show "default" rather than guessing.
export const describeHarness = (
    preset: HarnessPreset,
    catalogue?: DescriptorCatalogue
): HarnessDescriptor => ({
    name: preset.name,
    title: preset.title,
    description: preset.description,
    requiresEndpoint: preset.requiresEndpoint,
    primary: preset.primary,
    subagents: [...preset.subagents],
    agents: [...preset.agents],
    tools: [
        ...preset.tools,
        ...(preset.environmentTools ?? []).filter(
            (name) =>
                catalogue?.tools[name] !== undefined && !preset.tools.includes(name)
        )
    ],
    coreTools: coreToolNames(preset.subagents),
    ...(Object.keys(preset.agentModels ?? {}).length > 0
        ? { agentModels: { ...preset.agentModels } }
        : {}),
    builtin: preset.builtin,
    editable: preset.editable
});

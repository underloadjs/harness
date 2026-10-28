// Browser-side contract accessors.
//
// The playground imports wire types from `../../server/protocol` (type-only, so
// the browser never loads server code). This module is the one place that turns
// those records into the values the UI renders, with a documented fallback for a
// server that predates a field:
//
//   - descriptor extensions (primary/subagents/builtin/editable/coreTools);
//   - session freezing (`harnessDefinition`);
//   - per-turn timings (`eventTimes`) and per-frame `at`;
//   - `tool_result.callId`;
//   - legacy harness aliases for the sessions filter.
//
// Every accessor has to be safe on an older payload: a missing field must degrade
// to something truthful, never to NaN or to a fabricated duration.

import type {
    AgentDescriptor,
    HarnessDescriptor,
    HarnessEvent,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../../server/protocol';

// The harness core tools, in display order. R3 is explicit that this dropdown is
// *only* the harness core set: `requestTools`/`createTool`/`todoTools` always,
// `delegate` when the harness has a second agent to delegate to. Other tools are
// catalogue entries, not core tools.
export const HARNESS_CORE_TOOL_NAMES = ['requestTools', 'createTool', 'todoTools'] as const;

// One-line explanations for the core dropdown. They describe behaviour the
// harness owns (src/harness.ts) rather than which capability exists, because the
// catalogue below already lists every tool.
export const HARNESS_CORE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
    requestTools: 'Find tools by capability tag and enable them for this chat.',
    createTool: 'Add a small session-local tool when the catalogue cannot help.',
    todoTools: 'Keep a task list for the current work.',
    delegate: 'Hand a self-contained task to one of this harness’s agents.'
};

const descriptorsOf = (descriptor: HarnessDescriptor): readonly string[] =>
    Array.isArray(descriptor.agents) ? descriptor.agents : [];

// The entry agent. The contract makes `primary` explicit; an older descriptor is
// interpreted the documented way — first declared agent, else the harness name.
export const primaryOf = (descriptor: HarnessDescriptor): string => {
    const primary = descriptor.primary;
    if (typeof primary === 'string' && primary.trim().length > 0) return primary;

    return descriptorsOf(descriptor)[0] ?? descriptor.name;
};

// Agents the primary may delegate to. The server's list wins; the fallback is
// "every agent except the primary", which is what the harness does when
// `subagents` is omitted.
export const subagentsOf = (descriptor: HarnessDescriptor): string[] => {
    const primary = primaryOf(descriptor);

    const listed = Array.isArray(descriptor.subagents)
        ? descriptor.subagents.filter((name): name is string => typeof name === 'string')
        : descriptorsOf(descriptor);

    return uniqueNames(listed.filter((name) => name !== primary));
};

// The complete team in display order: primary first, then secondaries.
export const membersOf = (descriptor: HarnessDescriptor): string[] => {
    const primary = primaryOf(descriptor);
    return [primary, ...subagentsOf(descriptor).filter((name) => name !== primary)];
};

// Deduplicate while preserving order. Used for every request body so a repeated
// member can never be sent to the server.
export const uniqueNames = (names: readonly string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const name of names) {
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        result.push(name);
    }

    return result;
};

// `editable` is explicit on the new server. The check is written against `true`
// so a payload missing the field (older server) stays editable: the user must
// still be able to configure the built-in harnesses.
export const editableOf = (descriptor: HarnessDescriptor): boolean => descriptor.editable !== false;

export const builtinOf = (descriptor: HarnessDescriptor): boolean => descriptor.builtin === true;

// Core tools for the dropdown, limited to the harness-owned set. `delegate` is
// shown when the team has a second member or when the server already declares it.
export const coreToolsOf = (descriptor: HarnessDescriptor, memberCount: number): string[] => {
    const declared = Array.isArray(descriptor.coreTools) ? descriptor.coreTools : undefined;

    return [
        ...HARNESS_CORE_TOOL_NAMES,
        ...(memberCount > 1 || declared?.includes('delegate') === true ? ['delegate'] : [])
    ];
};

// Per-agent model overrides (`agentModels`), read defensively.
//
// The map is optional and only present when a harness actually overrides a member
// (protocol.ts HarnessDescriptor.agentModels). A member absent from the map uses
// the session's settings model — that is the "inherit" choice a per-agent
// dropdown shows, not a resolved id. Values are model ids only: no provider or
// credential ever travels here.
//
// The same accessor reads a SessionSnapshot's effective map: the server freezes it
// at creation with every member present, so a reload can render each agent's model
// without knowing the creation settings.
export const agentModelsOf = (source: {
    agentModels?: Record<string, string>;
}): Record<string, string> => {
    const map = source.agentModels;
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return {};

    const result: Record<string, string> = {};
    for (const [name, model] of Object.entries(map)) {
        // Empty ids are "inherit" and must not become a dropdown option.
        if (typeof model === 'string' && model.length > 0) result[name] = model;
    }

    return result;
};

// Filter an override map down to a member list, preserving member order. Used for
// every PATCH: the server REPLACES its map with what it receives, so the browser
// must send the complete current map and let a removed member's key drop out.
export const modelsForMembers = (
    models: Readonly<Record<string, string>>,
    members: readonly string[]
): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const member of members) {
        const model = models[member];
        if (typeof model === 'string' && model.length > 0) result[member] = model;
    }

    return result;
};

// A session may freeze the definition it started with (`harnessDefinition`). The
// playground renders that descriptor, never the live one, so an edited harness
// cannot rewrite a conversation that is already on screen.
export const frozenDefinitionOf = (session: SessionSnapshot): HarnessDescriptor | undefined => {
    const frozen = session.harnessDefinition;
    if (frozen === null || typeof frozen !== 'object') return undefined;

    return typeof frozen.name === 'string' && frozen.name.length > 0 ? frozen : undefined;
};

// Recorded event timestamps, aligned 1:1 with `events`. A missing/partial array
// means "older server": callers must degrade rather than compute NaN.
export const eventTimesOf = (turn: SessionTurn): (number | undefined)[] | undefined => {
    const times = turn.eventTimes;
    if (!Array.isArray(times) || times.length === 0) return undefined;

    return times.map((value) => finiteOf(value));
};

// SSE event frames may carry the server clock (`at`) for the event. Optional on
// purpose: a legacy server sends frames without it.
export const frameAtOf = (item: SessionStreamItem): number | undefined => {
    if (item.type !== 'event') return undefined;
    return finiteOf(item.at);
};

// `tool_result` may name the call it answers. When present it is the authoritative
// match; name+oldest-first stays as the fallback for an older server.
export const callIdOf = (event: HarnessEvent): string | undefined => {
    if (event.type !== 'tool_result') return undefined;
    return typeof event.callId === 'string' && event.callId.length > 0 ? event.callId : undefined;
};

export const finiteOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// Agent presets from descriptor data, for an older server with no agents list.
// The seed is intentionally minimal: the picker still works, and the detail panel
// says the server did not advertise an instruction.
export const agentsFromDescriptors = (
    descriptors: readonly HarnessDescriptor[]
): AgentDescriptor[] => {
    const byName = new Map<string, AgentDescriptor>();

    for (const descriptor of descriptors) {
        for (const name of descriptorsOf(descriptor)) {
            if (byName.has(name)) continue;

            byName.set(name, {
                name,
                title: name,
                description: 'This server does not advertise agent details.',
                instruction: '',
                guidelines: []
            });
        }
    }

    return [...byName.values()];
};

// Harness names the catalogue used historically. Sessions recorded under an alias
// still belong to the canonical harness, which is what the sessions rail filters
// by. Keep in sync with harnesses/index.ts PRESET_ALIASES.
const HARNESS_ALIASES: Readonly<Record<string, string>> = {
    writer: 'instruct',
    assistant: 'instruct',
    researcher: 'research'
};

// Resolve a session's harness to the canonical descriptor name. Unknown names are
// returned unchanged so a row for a harness this page cannot see is filtered out
// rather than silently attributed to the selected one.
export const canonicalHarnessName = (
    name: string,
    descriptors: readonly HarnessDescriptor[]
): string => {
    if (descriptors.some((descriptor) => descriptor.name === name)) return name;

    const alias = HARNESS_ALIASES[name];
    if (alias !== undefined && descriptors.some((descriptor) => descriptor.name === alias)) return alias;

    return name;
};

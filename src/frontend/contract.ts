// Browser-side contract accessors.
//
// The frontend imports wire types from `../../server/protocol` (type-only, so
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
    HarnessUsage,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../server/protocol';

// Legacy fallback: the harness-owned core tools an OLD server (no `coreTools`)
// declared. R21.2 removed the right-rail core dropdown and the tool catalogue that
// used this list, so the UI no longer derives a core set at all: the Tools tab
// renders the server's complete catalogue, core entries included. The constants are
// kept (exported for callers that only need the historical names) but nothing in
// the shell renders them.
export const HARNESS_CORE_TOOL_NAMES = ['toolRequest', 'toolCreate', 'todoManage'] as const;

// One-line explanations for the historical core set. Retained as documentation
// data; no UI location lists core tools any more (R21.2).
export const HARNESS_CORE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
    toolRequest: 'Find tools by capability tag and enable them for this chat.',
    toolCreate: 'Add a small session-local tool when the catalogue cannot help.',
    todoManage: 'Keep a task list for the current work.',
    agentDelegate: 'Hand a self-contained task to one of this harness’s agents.',
    fileRead: 'Read one or more text files on the server host.',
    fileWrite: 'Write one or more text files on the server host.',
    fileEdit: 'Replace exact text in one or more files on the server host.',
    fileGlob: 'Find files by glob, or search their contents, in one call.',
    webSearch: 'Search the web when the host configured a provider key.'
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

// R21.1: EVERY harness is editable. The wire's `editable` flag is legacy metadata
// (the old server marked the demo/flaky fixtures `false`), and the UI deliberately
// ignores it rather than disabling a card: the backend now accepts PATCH for every
// built-in preset, including those fixtures, so a stored `false` describes an old
// server, not a real restriction. A harness that really cannot be patched reports
// its refusal through PATCH (main.ts shows the server's message); the UI must not
// pre-emptively claim a read-only state that no longer exists.
//
// Kept as a function (rather than deleting the accessor and its call sites) so the
// distinction between "editing a harness" and "editing the team of a saved
// session" (main.ts `renderAgents`) stays explicit.
export const editableOf = (_descriptor: HarnessDescriptor): boolean => true;

export const builtinOf = (descriptor: HarnessDescriptor): boolean => descriptor.builtin === true;

// Core tools for the dropdown. R18: the SERVER's `coreTools` is authoritative —
// it already contains the four file tools, a configured webSearch, and
// agentDelegate when applicable — so the UI reflects catalogue/runtime visibility
// instead of hard-coding the harness-owned names. Only an older payload without
// the field falls back to the legacy harness-owned list (adding delegate when the
// local team has a second member).
export const coreToolsOf = (descriptor: HarnessDescriptor, memberCount: number): string[] => {
    if (Array.isArray(descriptor.coreTools)) {
        return descriptor.coreTools.filter(
            (name): name is string => typeof name === 'string' && name.length > 0
        );
    }

    return [
        ...HARNESS_CORE_TOOL_NAMES,
        ...(memberCount > 1 ? ['agentDelegate'] : [])
    ];
};

// Per-agent model overrides (`agentModels`), read defensively.
//
// The map is optional and only present when a harness actually overrides a member
// (protocol.ts HarnessDescriptor.agentModels). A member absent from the map uses
// the session's settings model; the dropdown labels that no-override choice with
// the resolved id (R18), never the word "inherit". Values are model ids only: no
// provider or credential ever travels here.
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
        // Empty ids mean "no override" and must not become a model option.
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
// frontend renders that descriptor, never the live one, so an edited harness
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

// Validate one token tally from the wire — a turn record's `usage` or a stream
// frame's `usage`. All three required counts must be finite; a partially malformed
// block resolves to undefined so the header hides instead of printing "NaN" or a
// half-sum. `cached` is kept only when it is a real number (absent means "the
// provider never reported a cache figure", which the label renders without
// brackets).
export const usageOf = (value: unknown): HarnessUsage | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const candidate = value as { input?: unknown; output?: unknown; total?: unknown; cached?: unknown };
    const input = finiteOf(candidate.input);
    const output = finiteOf(candidate.output);
    const total = finiteOf(candidate.total);

    if (input === undefined || output === undefined || total === undefined) return undefined;

    const cached = finiteOf(candidate.cached);
    return { input, output, total, ...(cached === undefined ? {} : { cached }) };
};

// The running tally attached to an event frame (see protocol.ts SessionStreamItem).
// Undefined for every other frame type and for a server that does not send one, so
// the tile falls back to the recorded turn's `usage` rather than inventing a value.
export const frameUsageOf = (item: SessionStreamItem): HarnessUsage | undefined =>
    item.type === 'event' ? usageOf(item.usage) : undefined;

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
// by. Keep in sync with src/harnesses/index.ts PRESET_ALIASES.
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

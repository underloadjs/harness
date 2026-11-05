// The one toolbox every real (live) harness shares.
//
// WHY THIS EXISTS
// ---------------
// The UI used to present three differently-equipped live presets (a writer with
// no tools, a "tool user" with three, a workspace with the coding set). That made
// the *toolbox* look like part of the agent's identity, so a user had to guess
// which preset could read a file or search the web. It also made the descriptors
// disagree: the same capability was advertised on one card and absent from the
// next.
//
// The product rule is now the opposite: a harness choice changes the AGENTS
// (instructions, primary, subagents), never the toolbox. Every live preset is
// built by `createToolboxHarness` below, so the registered tool set is identical
// by construction rather than by three hand-maintained lists that can drift.
//
// WHAT IS IN THE SHARED TOOLBOX (T14 names)
// -----------------------------------------
//   - package presets  — src/tools: syntax, read, write, edit,
//                        fileList, glob, grep, shell, gitDiff
//                        (lazy proxies, see src/tools/lazy.ts)
//   - harness tools    — src/server/tools/shared: timeNow, textCount, diceRoll,
//                        noteSearch, textSummarize (T25: discovered from the files,
//                        registered from their discovered source paths, never
//                        imported)
//   - search        — environment-backed (EXA_API_KEY / TAVILY_API_KEY); the
//                        harness factory registers it only when a key resolves,
//                        so a keyless host is offline-safe. The global catalogue
//                        still lists it as `unconfigured`, never fake-callable.
//   - core tools       - the core file tools (read, write,
//                        edit, glob, grep), search and fetch when the host
//                        configured them (a provider key for search, the
//                        `webfetch` flag for fetch), and the harness-owned pair
//                        toolRequest (the discovery bootstrap) plus task (the
//                        session plan), with delegate for a preset that declares
//                        subagents.
//                        fileList, the other package/app tools, and the runtime
//                        rows R9-R11 demoted (toolRegistry/toolList/toolManage/
//                        toolCreate/profileManage/chapterManage/locationManage/
//                        agentManage/agentResult/actionRequest/threadFork) stay
//                        searchable, so they wait for toolRequest.
//
// "core" is a declaration classification, not a session binding: only the
// harness-owned set is sessionBound in the server catalogue because only it
// mutates a session's harness. Core file tools and search keep the ordinary
// session-less direct-call path.
//
// DELIBERATE EXCEPTIONS
// ---------------------
//   - `testFlaky` is NOT in the shared toolbox. It fails two calls out of three on
//     purpose and keeps its attempt count per AGENT (a WeakMap in
//     src/server/tools/examples/testFlaky.tool.ts, plus one module fallback for a
//     direct call), so sharing the singleton is safe: it belongs to the "Recoverable
//     failures" example harness, which adds it as an extra tool. T25: it is excluded
//     STRUCTURALLY — it lives in the sibling `examples` folder, which the shared
//     folder scan never reads — rather than by a name list.
//   - the `demo` preset stays the scripted offline fixture (timeNow only): it is
//     not a live harness, so the equal-toolbox rule does not apply to it.
//
// LAZY, NOT EAGER
// ---------------
// `presetTools` values are lazy proxies, which is exactly why the production
// harness cannot register them as definitions through `configuration.tools`: that
// path validates a constructed object and never captures a source revision. The
// live factory therefore passes `SHARED_TOOL_SOURCES` (concrete paths) so startup
// compiles each entry through the shared kernel; the standalone catalogue still
// uses `presetTools`/`SHARED_TOOLS` directly. "All tools available" means
// registered/discoverable through a real source revision, not an eager body load.
//
// T25: the app half of the toolbox is now DERIVED from `src/server/tools/shared`
// instead of one hand-written `toolSources` entry per app tool. `./tools.ts` scans
// the folder (metadata first) and publishes the discovered source paths, so a new
// file in the folder needs no edit here at all. `toolSources` remains the single
// startup path for both halves, which is what preserves their declared order.
//
// Cross-references:
//   - ./presets.ts      — the preset catalogue built on this factory
//   - ./tools.ts        — the app tools, DERIVED from the server tools folders
//   - ../src/harness.ts — `presets: false` + `toolSources` startup compilation
//   - ../api.ts  — descriptors resolved from the same preset metadata

import { agent, harness, presetTools, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../../harness';
import type { Agent, AgentConfiguration, Harness, HarnessConfiguration, HarnessProgress, Tool } from '../../harness';
import { agentInstruction, agentProfile, isAgentProfileName } from '../../agents';
// T19: the global agent overlay (effective profile text + the retirement error). One
// direction only — ./agent-state.ts imports nothing from here, so there is no cycle.
import { AgentStateError, effectiveAgentProfile } from './agent-state';
import { PRESET_DESCRIPTORS, RUNTIME_DESCRIPTORS, isCoreRegistered } from '../../tools/descriptors';
import {
    EXAMPLE_APP_TOOL_SOURCES,
    SHARED_APP_TOOL_FOLDER,
    SHARED_APP_TOOL_NAMES,
    SHARED_APP_TOOL_SOURCES,
    SHARED_APP_TOOLS
} from './tools';
import type { RunnerSettings } from './types';
import type { HarnessPresetReport } from './types';

// Tool-loop budget for live harnesses. The library default (16) is a runaway
// guard, but a real session legitimately needs dozens of rounds: discovery,
// several reads/edits, a command, then an answer. 1000 keeps a hard stop without
// truncating real work. Exported so the CLI/server can report the same bound.
export const PRESET_MAX_ITERATIONS = 1000;

// Re-exported so the preset/registry modules and the descriptor tests keep ONE
// import path for the shared app set (T25). Both are derived in ./tools.ts from the
// files in src/server/tools/shared; nothing here names a tool.
export {
    EXAMPLE_APP_TOOL_SOURCES,
    SHARED_APP_TOOL_FOLDER,
    SHARED_APP_TOOL_NAMES,
    SHARED_APP_TOOL_SOURCES,
    SHARED_APP_TOOLS
};

// The shared registry. Package presets come first so a duplicate name in the app
// table is a visible shadow rather than a silent override; app names do not collide
// with `presetTools` today.
//
// T25: the app half is `SHARED_APP_TOOLS` — the entries discovered in
// src/server/tools/shared — so the example folder can never leak in, and a new
// shared entry joins without an edit here.
export const SHARED_TOOLS: Readonly<Record<string, Tool>> = {
    ...presetTools,
    ...SHARED_APP_TOOLS
};

// The exact declared names, in registry order: package tools then app tools.
// Derived from the table so a new package/tool entry cannot be advertised in a
// descriptor without also being registered (and vice versa). Frozen because the
// preset metadata shares this array: a caller must not be able to mutate one
// preset's advertised toolbox at runtime.
export const SHARED_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(SHARED_TOOLS));

// The editable source entry for every shared tool (R2/T14/F1).
//
// WHY SOURCE PATHS AND NOT THE `SHARED_TOOLS` DEFINITIONS
// -------------------------------------------------------
// The production harness must register startup tools through the SAME
// compile/load/validate operation runtime replacements use. `SHARED_TOOLS` holds
// lazy proxy definitions for package presets and app tools; passing them via
// `configuration.tools` takes the non-compiling `prepareDefinition` branch, so
// `harness.toolSource('read'/'timeNow')` stays undefined and an agent cannot
// inspect/edit the revision that is actually running.
//
// Every entry here points at the concrete, shipped source file. `createToolboxHarness`
// passes this map as `toolSources`; the harness compiles each one independently and
// only then applies host `extraTools` definitions, preserving override order.
//
// Paths are relative to the package source roots (`src/` during development, the
// deployed editable `tool-sources/` copy in production); see core/tool-source.ts.
//
// DERIVED (T21): the package half is the descriptor manifest's own `sourcePath`, in
// descriptor order, so adding a `.tool.ts` under src/tools makes it a shared source
// with no edit here. DERIVED (T25): the app half is the discovered source path of
// every entry in src/server/tools/shared, so a new shared app entry needs no edit
// either. Those files are registered through `toolSources` (see
// createToolboxHarness), which is what keeps their declared order; `toolFolders` is
// the same folder for hosts that want the live scan instead.
export const SHARED_TOOL_SOURCES: Readonly<Record<string, string>> = Object.freeze({
    // Package preset entries, in the same order as `SHARED_TOOLS`.
    ...Object.fromEntries(
        PRESET_DESCRIPTORS.map((descriptor) => [descriptor.metadata.name, descriptor.sourcePath])
    ),
    // App tool entries (T25), in registration order: discovered from the folder.
    ...SHARED_APP_TOOL_SOURCES
});

// The app-tool folders, package-relative, in catalogue order. `shared` is the shared
// toolbox; `examples` is opt-in per harness. Both are scanned by ./tools.ts, which is
// why the shared toolbox needs no second list of app names.
export const SHARED_TOOL_FOLDERS: readonly string[] = Object.freeze([SHARED_APP_TOOL_FOLDER]);
// Harness-owned core names, DERIVED from the runtime descriptors (T21).
//
// The rule is the descriptor's own registration policy: a runtime entry that is
// registered unconditionally at startup is part of the declared core set, in
// descriptor order (the scan emits the kernel's registration order, toolRegistry
// first). Entries that are capability-by-configuration — delegate (subagents),
// actionRequest (owner answerer), threadFork (fork configuration), toolCancel
// (pending work), the thread pair (independent threads) — are NOT in this list and
// are projected separately by coreToolNames() below, which is why a single-agent
// preset never advertises a delegation tool it would not declare.
//
// N4 note preserved: actionRequest must not be promised by a static projection,
// because whether it registers depends on host configuration `describeHarness`
// cannot see. It IS in the global core catalogue (./core.ts) so the server can list
// it for the Tools tab and answer a clear 404 in a session that lacks it.
export const CORE_TOOL_NAMES: readonly string[] = Object.freeze(
    RUNTIME_DESCRIPTORS.filter(isCoreRegistered).map((descriptor) => descriptor.metadata.name)
);

// Package presets that are declared on every request (R18), derived from the
// descriptor metadata: `visibility: 'core'` is what makes a preset declared up
// front. fileList is deliberately absent from the result because it stays
// discoverable. There is no fileSearch entry — the approved consolidation is the
// one glob tool (plus grep for content), now core.
export const CORE_PRESET_TOOL_NAMES: readonly string[] = Object.freeze(
    PRESET_DESCRIPTORS.filter((descriptor) => descriptor.metadata.visibility === 'core').map(
        (descriptor) => descriptor.metadata.name
    )
);

// The configured environment-backed core tools. Each appears only when the
// runtime catalogue has an executable definition (a provider key resolved for
// search, the `webfetch` flag for fetch), which is why they are not in the
// static list above. R9-R11: both entries declare `visibility: core`, so a
// production preset that registers one must advertise it here as well.
export const CORE_ENVIRONMENT_TOOL_NAMES = [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME] as const;

// Project the core set for one preset descriptor.
//
// `registered` is the exact tool-name set the card was built with (preset.tools
// plus environment tools THIS host can actually run — see descriptor.ts). A core
// name is advertised only when it is in that set, so the demo fixture (timeNow
// only) does not claim file tools, and a keyless host does not claim search.
export const coreToolNames = (
    subagents: readonly string[] = [],
    registered: readonly string[] = []
): string[] => {
    const available = new Set(registered);

    // The runtime registers its harness-owned baseline FIRST (toolRegistry, then
    // the core metadata set), then the preset catalogue, then configured/app
    // tools. `coreTools` mirrors the DECLARED order, so harness-owned entries come
    // before file presets here too.
    return [
        ...CORE_TOOL_NAMES,
        ...(subagents.length > 0 ? ['delegate'] : []),
        // R9-R11: the hardcoded `threadFork` row is gone. It promised a
        // declaration because forks register by default, but the entry now
        // declares searchable visibility, so it is discovered through
        // toolRequest like the rest of the demoted runtime set. delegate keeps
        // its special case only because it stays core WHEN a preset declares
        // subagents.
        ...CORE_PRESET_TOOL_NAMES.filter((name) => available.has(name)),
        ...CORE_ENVIRONMENT_TOOL_NAMES.filter((name) => available.has(name))
    ];
};

// Provider settings are never used by construction; they only feed `agent(...)`.
// An empty key is omitted rather than sent as `Bearer `.
export const providerOf = (settings: RunnerSettings) => ({
    baseURL: settings.baseURL.trim(),
    apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey,
    sampling: { temperature: 0.3 }
});

// Build one agent from a TRUSTED profile. The profile supplies the identity and
// the guidelines (composed into system messages by `agentInstruction`), and this
// application layer supplies the provider transport. A client never contributes
// either, which is what makes "select an agent" safe.
//
// `model` is the optional per-agent override (R9). Only the model id is
// overridable: the provider, base URL, and credential always come from the
// session's trusted RunnerSettings. An absent or blank override falls back to the
// session model, so a map that omits an agent behaves exactly like today.
//
// `instruction` is the optional per-agent instruction override (T3 editable
// configuration). It is already-validated harness text (never raw request text
// here), and `agentInstruction` applies it to the identity sentence only, so the
// profile's guidelines stay in force. Absent/blank means "the trusted profile",
// which is why an untouched harness produces byte-identical system messages.
//
// T27: the CONFIGURATION form is split out because a host that adds a member to an
// ALREADY-BUILT harness (`harness.addAgent`, the server's session agent-binding route)
// needs the same trusted composition without constructing a brain the runtime would
// then throw away. `agentFromProfile` is exactly `agent()` over this value, so a fresh
// session and a session-scoped binding can never compose a prompt differently.
// `color` is the optional per-agent identity color (R2). It is already-validated hex
// text here (the registry's `normalizeAgentColors` checked it on create/PATCH), and it
// is attached to the configuration only when non-blank, so an uncolored member keeps
// the byte-identical configuration it had before R2 — `agent()` stores it verbatim and
// nothing else in the construction path reads it.
export const agentConfigurationFromProfile = (
    name: string,
    settings: RunnerSettings,
    model?: string,
    instruction?: string,
    color?: string
): AgentConfiguration => {
    // T19: the text comes from the EFFECTIVE profile — the trusted catalogue entry with the
    // global override layer merged (./agent-state.ts). The catalogue object itself stays
    // frozen; a merged profile is always a fresh object, so nothing here can write back into
    // `src/agents`. Resolution happens NOW (at session build), which is precisely why a
    // global agent edit reaches future sessions only: an agent built earlier is a separate
    // object that nobody re-seeds.
    //
    // An unknown id still throws the catalogue's own error (it lists the known set), and a
    // RETIRED profile is a 409 naming the retirement rather than a crash or a silent fall
    // back to the shipped text.
    if (!isAgentProfileName(name)) agentProfile(name);

    const profile = effectiveAgentProfile(name);

    if (profile === undefined) {
        throw new AgentStateError(
            409,
            `Agent "${name}" has been retired on this deployment, so a new session cannot select it. Existing sessions keep the agents they were built with.`
        );
    }

    const override = model === undefined ? '' : model.trim();

    // R2: a blank color means "not configured", exactly like a blank model id above,
    // so the key is omitted rather than reaching `agent()` as `''` (which would be a
    // construction error).
    const swatch = color === undefined ? '' : color.trim();

    return {
        name,
        model: override.length > 0 ? override : settings.model,
        // The per-HARNESS override wins over the global one (a harness-level choice is the
        // more specific decision); the profile's guidelines — global override or shipped —
        // are always composed below the identity sentence.
        instruction: agentInstruction(profile, instruction),
        provider: providerOf(settings),
        ...(swatch.length === 0 ? {} : { color: swatch })
    };
};

export const agentFromProfile = (
    name: string,
    settings: RunnerSettings,
    model?: string,
    instruction?: string,
    color?: string
): Agent => agent(agentConfigurationFromProfile(name, settings, model, instruction, color));

// The one sentence a session-defined agent runs when its author gave it no text (R7). Exported
// because BOTH halves must mint it: `SessionStore.addSessionAgent` stores it as the agent's base
// instruction, and `agentConfigurationForCustom` falls back to it when a stored base turned out
// blank (a hand-edited document, or a caller that passed no text at all). One definition is what
// keeps a live custom agent and a rebuilt one byte-identical.
export const customAgentInstruction = (name: string, instruction?: string): string => {
    const text = instruction === undefined ? '' : instruction.trim();

    return text.length > 0 ? text : `You are the ${name} agent.`;
};

// Build the configuration of a SESSION-DEFINED agent (R7) — one this conversation invented
// rather than one it selected from the trusted catalogue.
//
// THE DELIBERATE CONTRAST WITH `agentConfigurationFromProfile`:
//   - NO profile lookup. A custom name has no `AgentProfile`, so `agentProfile(name)`/
//     `effectiveAgentProfile(name)` would throw or report a retirement, and there is nothing for
//     the global agent overlay to override;
//   - NO guideline composition. `agentInstruction()` exists to append TRUSTED policy lines below
//     an identity sentence; a client-authored agent has no trusted policy, so the stored text IS
//     the whole system prompt (which is also why a blank stored base falls back to
//     `customAgentInstruction` rather than to a profile that does not exist);
//   - the SAME trusted transport as a profile member: the model id may come from the session map,
//     but the provider, base URL and credential always come from `RunnerSettings`, and a blank
//     model falls back to `settings.model`.
//
// `color` follows the R2 rule of the profile form above: trimmed, and the key is omitted when
// blank, so an uncolored member keeps a configuration with no `color` key at all.
export const agentConfigurationForCustom = (
    name: string,
    settings: RunnerSettings,
    model?: string,
    instruction?: string,
    color?: string
): AgentConfiguration => {
    const override = model === undefined ? '' : model.trim();
    const swatch = color === undefined ? '' : color.trim();

    return {
        name,
        model: override.length > 0 ? override : settings.model,
        instruction: customAgentInstruction(name, instruction),
        provider: providerOf(settings),
        ...(swatch.length === 0 ? {} : { color: swatch })
    };
};

// Build the agent registry for a selected set. Order is the caller's: primary
// first, then the allowlist, matching the descriptor's `agents` list. `agentModels`
// is the validated override map from the harness registry; it is applied per agent
// so one member can run a different model from its siblings. `agentInstructions`
// (T3) is the parallel instruction override map, applied the same per-agent way.
// `agentColors` (R2) is the third map of the same shape: agent id → validated hex
// color, applied per agent as display metadata only. Each map defaults to `{}`, so a
// caller that only has the first two keeps its exact old behavior.
//
// `customAgents` (R7) is the fourth map of that shape and the only one that changes WHICH
// builder runs: a name listed here is a session-defined agent, so it is composed by
// `agentConfigurationForCustom` (its own stored base text, unless the session later overrode
// the text through `agentInstructions`) and NEVER through a catalogue lookup. Every other name
// keeps the trusted-profile path byte-for-byte, so a template that declares no custom agent —
// i.e. every harness definition and every document saved before R7 — builds exactly as before.
export const agentsFromProfiles = (
    names: readonly string[],
    settings: RunnerSettings,
    agentModels: Readonly<Record<string, string>> = {},
    agentInstructions: Readonly<Record<string, string>> = {},
    agentColors: Readonly<Record<string, string>> = {},
    customAgents: Readonly<Record<string, string>> = {}
): Record<string, Agent> => {
    const agents: Record<string, Agent> = {};

    for (const name of names) {
        // `hasOwnProperty`, not a truthiness check: an agent whose stored base is the empty
        // string is still a session-defined agent, and falling through to the catalogue here
        // would answer 500 on restart for a name that has no profile.
        if (Object.prototype.hasOwnProperty.call(customAgents, name)) {
            agents[name] = agent(
                agentConfigurationForCustom(
                    name,
                    settings,
                    agentModels[name],
                    // A later session-scoped instruction override wins over the base the agent
                    // was invented with — the same precedence `setSessionAgentInstruction`
                    // applies live, so a restart cannot revert the prompt.
                    agentInstructions[name] ?? customAgents[name],
                    agentColors[name]
                )
            );

            continue;
        }

        agents[name] = agentFromProfile(
            name,
            settings,
            agentModels[name],
            agentInstructions[name],
            agentColors[name]
        );
    }

    return agents;
};

// A live harness factory for a primary + subagent selection. Used by the built-in
// presets and by user-created/overridden harnesses, so a harness choice can only
// change the agents — the toolbox and the loop budget are identical by
// construction.
//
// The model and instruction maps are captured by the closure, not read at run
// time: `update()` builds a NEW factory for the new maps, and a session created
// before that keeps the closure (and therefore the models and instructions) it was
// built with. The color map (R2) follows the same rule — it too must be frozen with
// the harness a session is built from, so a later PATCH cannot repaint an existing
// conversation's agents. The custom-agent map (R7) follows it for the same reason:
// a session's invented roster is part of the team the factory builds.
export const createProfiledHarness =
    (
        primary: string,
        subagents: readonly string[],
        agentModels: Readonly<Record<string, string>> = {},
        agentInstructions: Readonly<Record<string, string>> = {},
        agentColors: Readonly<Record<string, string>> = {},
        customAgents: Readonly<Record<string, string>> = {}
    ) =>
    (
        settings: RunnerSettings,
        progress: HarnessProgress,
        report?: HarnessPresetReport
    ): Harness =>
        createToolboxHarness(
            {
                agents: agentsFromProfiles(
                    [primary, ...subagents],
                    settings,
                    agentModels,
                    agentInstructions,
                    agentColors,
                    customAgents
                ),
                primary,
                subagents: [...subagents]
            },
            settings,
            progress,
            report
        );

// What a live preset supplies: the agents and how they are routed. Everything
// else is the shared toolbox, so two presets cannot end up with different tools.
export type ToolboxHarnessConfiguration = {
    agents: Record<string, Agent>;
    primary: string;
    // Omitted/empty means a single-agent harness (no delegate tool).
    subagents?: readonly string[];
    // Example-only SOURCE extras (the recoverable-failure preset adds `testFlaky`).
    // Merged after the shared source map and before host `extraTools`, so a shipped
    // exception is still compiled from its editable entry instead of a prebuilt
    // definition, while a host definition can still override it.
    extraToolSources?: Readonly<Record<string, string>>;
    // Host/example constructed DEFINITION overrides, registered last so they win
    // over both the shared and extra source maps.
    extraTools?: Readonly<Record<string, Tool>>;
};

// Build a live harness from agent configuration + the shared toolbox.
//
// STARTUP COMPILATION (T14/F1): every shipped tool is supplied as an editable
// source PATH — `toolSources` for the package presets AND the app tools (T25) — not
// as a constructed Tool through `tools`. The harness compiles/loads/validates each
// entry through the SAME kernel runtime replacements use, so
// `harness.toolSource('read')` and `harness.toolSource('timeNow')` report a real
// module revision instead of `undefined`. `presets: false` still keeps the registry
// exact: the kernel's default baseline is skipped because `SHARED_TOOL_SOURCES` lists
// precisely the shared set a descriptor advertises.
//
// `configuration.extraToolSources` is merged AFTER the shared source map and
// BEFORE `configuration.extraTools`: shipped exceptions (the flaky example's
// `testFlaky`) are compiled from their editable entries, while a host definition
// still wins on a name collision exactly as before. Environment tools
// (search/fetch) follow the host configuration as usual.
//
// FOLDER PRECEDENCE (T25): every app entry is a `toolSources` entry discovered from
// `src/server/tools/shared`, so the kernel commits it after the package baseline and
// after the package source map, and before `tools` definitions. The example extra
// (`testFlaky`) is committed the same way from `src/server/tools/examples`, so it is
// never part of the shared set. No name is registered twice, because the two folders
// are disjoint.
export const createToolboxHarness = (
    configuration: ToolboxHarnessConfiguration,
    settings: RunnerSettings,
    progress: HarnessProgress,
    observer?: HarnessPresetReport
): Harness => {
    // Example-only sources are given as PATHS, exactly like the shared half: the
    // kernel commits `toolSources` after the baseline and before `tools` overrides,
    // which preserves the documented "source, then host definition" order. A host
    // definition of the same name still wins.
    const liveConfiguration: HarnessConfiguration = {
        agents: configuration.agents,
        // Explicit routing: the entry agent is named even with one key, and the
        // allowlist is copied so later mutation cannot change a live harness.
        primary: configuration.primary,
        ...(configuration.subagents === undefined ? {} : { subagents: [...configuration.subagents] }),
        // ORDER (T25): the app entries come from `SHARED_APP_TOOL_SOURCES`, which
        // ./tools.ts discovers from `src/server/tools/shared` in `registration.order`
        // and labels package-relative. Registering them through `toolSources` keeps
        // that declared order AND the stable `server/tools/shared/<name>.tool.ts`
        // source path; folder discovery would sort them by file name and label them
        // absolute.
        //
        // COLD-STARTUP DISCOVERY: the scan runs when ./tools.ts is evaluated, i.e. at
        // process start, so a brand-new `*.tool.ts` in the folder is compiled and
        // registered by the next startup with no map edit. The folder is the
        // authority; the map is only its projection.
        toolSources: { ...SHARED_TOOL_SOURCES, ...configuration.extraToolSources },
        // Host/example DEFINITIONS override sources by being registered last.
        tools: { ...configuration.extraTools },
        presets: false,
        // Live sessions use the app-wide tool-loop budget, not the library's 16.
        maxIterations: PRESET_MAX_ITERATIONS,
        // Environment-backed search; no key means the factory returns undefined
        // and the harness is unchanged. Keys are resolved at construction, after
        // `.env` is loaded by the CLI/server. The CONFIGURATION field keeps its
        // name (`websearch`); the core tool it registers is search (R18).
        websearch: true,
        // Page fetch (W4) must be opted into as well, or `fetch` never enters
        // this harness's tool map and `toolRequest` has nothing to surface under
        // the `web`/`fetch`/`url` tags — the agent then legitimately reports
        // "search only". `native` needs no credential, so this is safe on a
        // keyless host; the tool stays SEARCHABLE (see src/harness.ts), so it
        // costs no request schema until the model asks for it.
        webfetch: true,
        // The server's persistence observer rides along with progress; either may
        // be absent (CLI, direct preset creation).
        report: {
            progress,
            ...(observer?.stateChange === undefined ? {} : { stateChange: observer.stateChange })
        },
        // N4: the host owner answerer. It belongs on the TOP-LEVEL harness
        // configuration (not inside `report`), because presence is what makes the
        // runtime register actionRequest. A missing hook simply means this host has
        // no answerer and the tool is not declared.
        ...(observer?.interaction === undefined ? {} : { interaction: observer.interaction })
    };

    return harness(liveConfiguration);
};

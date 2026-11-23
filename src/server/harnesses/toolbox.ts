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
// (instructions, entry agent, ranks), never the toolbox. Every live preset is
// built by `createToolboxHarness` below, so the registered tool set is identical
// by construction rather than by three hand-maintained lists that can drift.
//
// WHAT IS IN THE SHARED TOOLBOX (T14 names)
// -----------------------------------------
//   - package presets  — src/tools: syntax, read, write, edit,
//                        files, glob, grep, shell, gitDiff
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
//                        session plan), with delegate for a preset whose RANK MAP
//                        holds two or more distinct ranks (a strictly-lower target
//                        is the only thing to delegate to).
//                        files, the other package/app tools, and the runtime
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
//   - the `chat` card opts OUT of this toolbox entirely (issue 0005-D):
//     `configuration.sharedToolbox: false` skips `SHARED_TOOL_SOURCES` and both
//     environment rows. It is the ONLY shipped preset that does, it is declared at
//     the card in ./presets.ts rather than inferred from `tools: []`, and it exists
//     because a client that wants a session which never touches the server host had
//     no way to ask for one. The card no longer declares a `maxIterations` budget:
//     no shipped card does. Everything else on the factory's default path is
//     unchanged.
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

import { agent, harness, presetTools, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../../engine/harness';
import type {
    Agent,
    AgentConfiguration,
    Harness,
    HarnessCommandConfiguration,
    HarnessConfiguration,
    HarnessProgress,
    Tool
} from '../../engine/harness';
// The A–Z rank union (../types/index.ts). This layer STORES and PROJECTS ranks;
// the ordering and the delegation predicate live with the kernel.
import type { AgentRank, HarnessPrefixTurn } from '../../engine/types';
// THE RANK PRIMITIVES (R1): the ladder itself and its one ordering. They are values, not
// types, because ./registry.ts has to RESOLVE an operator's sparse map into the map the
// harness runs with (see `resolveRosterRanks`), and the kernel's arithmetic
// (../harness.ts:1528-1532) is written against these same two exports — so the scale and
// the floor can never drift from what the runtime does.
import { AGENT_RANKS, rankIndexOf } from '../../engine/types';
import { agentInstruction, agentProfile, isAgentProfileName } from '../../engine/agents';
// T19: the global agent overlay (effective profile text + the retirement error). One
// direction only — ./agent-state.ts imports nothing from here, so there is no cycle.
import { AgentStateError, effectiveAgentProfile } from './agent-state';
import { PRESET_DESCRIPTORS, RUNTIME_DESCRIPTORS, isCoreRegistered } from '../../engine/tools/descriptors';
import {
    SHARED_APP_TOOL_FOLDER,
    SHARED_APP_TOOL_NAMES,
    SHARED_APP_TOOL_SOURCES,
    SHARED_APP_TOOLS
} from './tools';
import type { HarnessPresetReport, HarnessToolboxDefaults, RunnerSettings } from './types';

// Tool-loop budget for live harnesses: NO BUDGET. A real session legitimately
// needs dozens or hundreds of rounds — discovery, several reads/edits, a command,
// then an answer — and the count guard is an optional safeguard rather than
// product policy, so live harnesses ship uncapped and every tool keeps its own
// wall-clock timeout. A card or a host that wants a hard stop passes
// `maxIterations`. Exported so the CLI/server report the same bound.
export const PRESET_MAX_ITERATIONS = Number.POSITIVE_INFINITY;

// Re-exported so the preset/registry modules and the descriptor tests keep ONE
// import path for the shared app set (T25). Both are derived in ./tools.ts from the
// files in src/server/tools/shared; nothing here names a tool.
export {
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
// first). Entries that are capability-by-configuration — delegate (a multi-rank
// roster), actionRequest (owner answerer), threadFork (fork configuration), toolCancel
// (pending work), the thread pair (independent threads) — are NOT in this list and
// are projected separately by coreToolNames() below, which is why a single-rank
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
// front. files is deliberately absent from the result because it stays
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

// Resolve a REQUEST's rank map into the map the harness actually RUNS with: one entry
// per roster member, in roster order, every value a letter.
//
// WHY THE HOST MIRRORS THE KERNEL'S FILL AT ALL. The kernel never runs a sparse map
// (../harness.ts:1505-1545): `ranks` ABSENT ENTIRELY puts the ENTRY agent at 'A' and every
// other member at 'B', and `ranks` PRESENT puts every agent the map omits — the entry agent
// included — one rank BELOW the lowest rank the map states, clamped at 'Z'. A definition
// that stored the sparse map would run a team nobody wrote down: the card would advertise
// fewer ranks than the harness holds, `coreToolNames` would count distinct ranks in a
// different map than the kernel's own `distinctRankCount`, and a restart could move an agent
// whose rank was never recorded. Storing the RESOLVED map removes all three, and turns "the
// operator named only the top" into a decision recorded ONCE instead of re-derived per start.
//
// THE TWO OMISSIONS ARE DIFFERENT ON PURPOSE, because the kernel makes them different:
//   - `ranks` omitted (undefined) = "give me the ordinary team" → entry 'A', others 'B',
//     which spans two ranks, so `delegate` IS registered;
//   - `ranks: {}` = "nobody is ranked" → the kernel's present-but-empty branch, EVERY member
//     (entry included) at 'B', one distinct rank, so NO delegation exists. An operator who
//     clears every rank gets a flat team, and the card says so.
//
// KEEP THIS IN STEP WITH THE KERNEL. The ladder comes from the kernel's own primitives
// (`AGENT_RANKS` ../types/index.ts:1501 and `rankIndexOf` ../types/index.ts:1532, both
// re-exported by ../harness.ts:17272), so the scale can never drift; only the FILL rule
// could. If the kernel ever exports its resolver, delete this mirror and call that.
export const resolveRosterRanks = (
    roster: readonly string[],
    entry: string,
    ranks?: Readonly<Record<string, AgentRank>>
): Record<string, AgentRank> => {
    // Rule 1 (../harness.ts:1540): no map at all — the entry point is the one actor the
    // kernel ranks highest, and that is a DEFAULT, not a rule: pass any map, even an empty
    // one, and the entry agent is ranked like everybody else.
    if (ranks === undefined) {
        return Object.fromEntries(roster.map((name) => [name, name === entry ? ('A' as AgentRank) : ('B' as AgentRank)]));
    }

    // Only the roster's own keys count. A key outside the roster is the CALLER's error, and
    // ./registry.ts refuses it before this runs; ignoring it here keeps a stale map from
    // lowering the floor for a member that no longer exists.
    const explicit = roster
        .map((name) => ranks[name])
        .filter((rank): rank is AgentRank => rank !== undefined);

    // Rule 2 (../harness.ts:1528-1532): one below the LOWEST explicit rank, clamped at 'Z'.
    // An empty map takes the same branch with a floor index of 0, which is what lands every
    // member on 'B' — including the entry agent.
    const lowest = explicit.length === 0 ? 0 : Math.max(...explicit.map(rankIndexOf));
    const floor = AGENT_RANKS[Math.min(lowest + 1, AGENT_RANKS.length - 1)];

    return Object.fromEntries(roster.map((name) => [name, ranks[name] ?? floor]));
};

// Whether one RANK MAP declares a delegation surface, i.e. whether `delegate` is
// registered and therefore whether a descriptor may advertise it.
//
// THE RULE: two or more DISTINCT rank letters — the kernel's own `rosterHasDelegation()`
// (../harness.ts:1557-1561), computed on the same FILLED map `resolveRosterRanks` produces.
// Delegation is strictly downward (../types/index.ts `isLowerRank`), so a roster whose
// members all hold the same rank has no legal target — A→A is refused — and the kernel does
// not register the row at all. A roster with A and B does, an A/B/C roster registers the same
// single row and merely lets an A agent reach two levels down. Counting DISTINCT VALUES
// (not members) is what makes this exact: seven members all at Rank B still cannot
// delegate, and the preset card must not promise the tool.
export const ranksDeclareDelegation = (ranks: Readonly<Record<string, AgentRank>> = {}): boolean =>
    new Set(Object.values(ranks)).size >= 2;

// Project the core set for one preset descriptor.
//
// `ranks` is the preset's rank map (agent id → A–Z letter); `delegate` joins the
// projection exactly when it holds two or more distinct ranks — see
// `ranksDeclareDelegation`. `registered` is the exact tool-name set the card was
// built with (preset.tools plus environment tools THIS host can actually run — see
// descriptor.ts). A core name is advertised only when it is in that set, so the
// scripted fixture (timeNow only) does not claim file tools, and a keyless host
// does not claim search.
export const coreToolNames = (
    ranks: Readonly<Record<string, AgentRank>> = {},
    registered: readonly string[] = []
): string[] => {
    const available = new Set(registered);

    // The runtime registers its harness-owned baseline FIRST (toolRegistry, then
    // the core metadata set), then the preset catalogue, then configured/app
    // tools. `coreTools` mirrors the DECLARED order, so harness-owned entries come
    // before file presets here too.
    return [
        ...CORE_TOOL_NAMES,
        ...(ranksDeclareDelegation(ranks) ? ['delegate'] : []),
        // R9-R11: the hardcoded `threadFork` row is gone. It promised a
        // declaration because forks register by default, but the entry now
        // declares searchable visibility, so it is discovered through
        // toolRequest like the rest of the demoted runtime set. delegate keeps
        // its special case only because it stays core WHEN a preset's ranks give
        // someone a strictly-lower agent to delegate to.
        ...CORE_PRESET_TOOL_NAMES.filter((name) => available.has(name)),
        ...CORE_ENVIRONMENT_TOOL_NAMES.filter((name) => available.has(name))
    ];
};

// THE DECLARED TOOLBOX FOR A HARNESS BUILT FROM `toolbox`. One authority for the
// factory's registration posture AND the card/descriptor's `tools` lists, so a host
// that boots with the zero-toolbox floor cannot ship a card advertising the shared set
// (the contradiction ./presets.ts `chat` exists to avoid).
//
// The resolution is the SAME precedence `createToolboxHarness` applies: an explicit
// `websearch`/`webfetch` opt-in wins, otherwise both follow `sharedToolbox`, which is
// `true` only when the caller states it (the boot resolver states `false`; direct
// factory callers leave it absent and keep the historical shared toolbox).
//
// The returned `environmentTools` names the environment-backed rows the harness WILL
// register. The descriptor layer additionally filters `search` against the runtime
// catalogue (a keyless host lists it unconfigured), so over-declaring here is still
// impossible.
//
// EXTRA TOOLS AND EXTRA SOURCES ARE PART OF THE DECLARATION (B8). `createToolboxHarness`
// registers both maps, so leaving them out of the card's `tools` made a host-supplied
// tool invisible by construction: the harness could call it while `GET /harnesses` said
// the card had nothing but the shared set.
//
// THE NAME IS THE MAP KEY for both halves. That is the registration identity the kernel
// receives (`toolSources`/`tools` are keyed records; the map key is the name the tool is
// registered under, which is why a host can alias a definition by key), so projecting
// `Tool.name` instead would advertise a name the harness does not answer to.
export const declaredToolboxNames = (
    toolbox?: HarnessToolboxDefaults
): { tools: string[]; environmentTools: string[] } => {
    const shared = toolbox?.sharedToolbox !== false;
    const websearch = toolbox?.websearch ?? shared;
    const webfetch = toolbox?.webfetch ?? shared;

    // Shared names first (catalogue order), then the card's own registrations in map
    // order, deduplicated: an extra that overrides a shared name is already listed where
    // the harness resolves it, and a tool may not be advertised twice.
    const tools = shared ? [...SHARED_TOOL_NAMES] : [];

    for (const name of [
        ...Object.keys(toolbox?.extraToolSources ?? {}),
        ...Object.keys(toolbox?.extraTools ?? {})
    ]) {
        if (!tools.includes(name)) tools.push(name);
    }

    return {
        tools,
        environmentTools: [
            ...(websearch ? [WEB_SEARCH_TOOL_NAME] : []),
            ...(webfetch ? [WEB_FETCH_TOOL_NAME] : [])
        ]
    };
};

// Provider settings are never used by construction; they only feed `agent(...)`.
// An empty key is omitted rather than sent as `Bearer `.
//
// (T8, AC2) The three time bounds are forwarded ONLY when this session actually set
// one, and that conditional is the precedence mechanism: `provider.*TimeoutMs` absent
// leaves the transport free to resolve environment -> shipped default at construction
// (transport/openai.ts -> `resolveProviderTimeout`), while a set field is authoritative
// over both. Spreading `undefined` in instead would be the same value to the parser but
// would make every settings object claim all three fields, so `providerOf`'s output for
// an untouched session stays exactly the object it was before T8.
export const providerOf = (settings: RunnerSettings) => ({
    baseURL: settings.baseURL.trim(),
    apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey,
    sampling: { temperature: 0.3 },
    ...(settings.responseHeadTimeoutMs === undefined ? {} : { responseHeadTimeoutMs: settings.responseHeadTimeoutMs }),
    ...(settings.firstTokenTimeoutMs === undefined ? {} : { firstTokenTimeoutMs: settings.firstTokenTimeoutMs }),
    ...(settings.streamChunkTimeoutMs === undefined ? {} : { streamChunkTimeoutMs: settings.streamChunkTimeoutMs })
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
// here), and since T6 `agentInstruction` treats it as the agent's COMPLETE prompt:
// the profile's guidelines are the default for an un-overridden member and are never
// appended below an override. Absent/blank means "the trusted profile", which is why
// an untouched harness produces byte-identical system messages.
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
//
// `prefix` is the optional per-agent PRESET HISTORY (U6): the member's complete ordered band of
// seeded `system` / `user` / `assistant` turns, already validated by the caller
// (`./registry.ts normalizeAgentPrefixes` at the definition edge, `../sessions.ts` at the session
// edge). It rides the SAME conditional-spread discipline as `color`: an absent or EMPTY band
// produces no `prefix` key at all, so a harness that seeds nothing keeps the exact configuration
// object it built before this feature existed (several tests compare built configurations
// byte-for-byte). A supplied band is COPIED into plain mutable `{ role, content }` messages,
// because `AgentConfiguration.prefix` is an ordinary message array and the stored map is
// readonly — and copying is what keeps a shared preset map from aliasing one agent's band into
// another's live transcript.
export const agentConfigurationFromProfile = (
    name: string,
    settings: RunnerSettings,
    model?: string,
    instruction?: string,
    color?: string,
    prefix?: readonly HarnessPrefixTurn[]
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

    // U6: an absent or empty band is "this member seeds no history", spelled by OMITTING the key
    // (see the note above) rather than by `prefix: []`, which would make an untouched harness
    // report a configuration shape it never had. A supplied band is copied element-by-element into
    // text-only messages, so the preset map is never aliased into the agent's live transcript.
    const band = prefix === undefined ? [] : prefix;

    return {
        name,
        model: override.length > 0 ? override : settings.model,
        // The per-HARNESS override wins over the global one (a harness-level choice is the
        // more specific decision), and since T6 it wins outright: a stored override IS the
        // whole prompt, while a member the map omits runs the effective profile's identity
        // sentence composed with its guidelines (global override or shipped).
        instruction: agentInstruction(profile, instruction),
        provider: providerOf(settings),
        ...(swatch.length === 0 ? {} : { color: swatch }),
        ...(band.length === 0
            ? {}
            : { prefix: band.map((turn) => ({ role: turn.role, content: turn.content })) })
    };
};

export const agentFromProfile = (
    name: string,
    settings: RunnerSettings,
    model?: string,
    instruction?: string,
    color?: string,
    prefix?: readonly HarnessPrefixTurn[]
): Agent => agent(agentConfigurationFromProfile(name, settings, model, instruction, color, prefix));

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
//   - NO guideline composition. `agentInstruction()` appends the TRUSTED policy lines only when
//     a profile supplies the prompt; a client-authored agent has no trusted policy, so the stored text
//     IS the whole system prompt (which is also why a blank stored base falls back to
//     `customAgentInstruction` rather than to a profile that does not exist). Since T6 this is the
//     same rule a profile member follows when it has an override, and it is what makes a session that
//     edits one instruction box behave identically for both kinds of member;
//   - the SAME trusted transport as a profile member: the model id may come from the session map,
//     but the provider, base URL and credential always come from `RunnerSettings`, and a blank
//     model falls back to `settings.model`.
//
// `color` follows the R2 rule of the profile form above: trimmed, and the key is omitted when
// blank, so an uncolored member keeps a configuration with no `color` key at all. `prefix`
// follows the U6 rule of that same form: an absent or empty band omits the key, and a supplied
// band is copied into detached text-only messages.
export const agentConfigurationForCustom = (
    name: string,
    settings: RunnerSettings,
    model?: string,
    instruction?: string,
    color?: string,
    prefix?: readonly HarnessPrefixTurn[]
): AgentConfiguration => {
    const override = model === undefined ? '' : model.trim();
    const swatch = color === undefined ? '' : color.trim();
    const band = prefix === undefined ? [] : prefix;

    return {
        name,
        model: override.length > 0 ? override : settings.model,
        instruction: customAgentInstruction(name, instruction),
        provider: providerOf(settings),
        ...(swatch.length === 0 ? {} : { color: swatch }),
        ...(band.length === 0
            ? {}
            : { prefix: band.map((turn) => ({ role: turn.role, content: turn.content })) })
    };
};

// Build the agent registry for a selected set. Order is the caller's: the ENTRY
// agent first, then the rest of the roster, matching the descriptor's `agents`
// list (the order is what the registry's entry default falls back to). `agentModels`
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
//
// `agentPrefixes` (U6) is the fifth map of the shape: agent id → that member's validated preset
// history, passed to the builder the name resolved to (profile form or custom form). It changes
// neither membership nor the prompt; it only says what transcript the agent starts with. A member
// the map omits, or whose band is empty, gets no `prefix` key at all, so a template that seeds
// nothing — every shipped card and every document saved before U6 — builds byte-identically.
export const agentsFromProfiles = (
    names: readonly string[],
    settings: RunnerSettings,
    agentModels: Readonly<Record<string, string>> = {},
    agentInstructions: Readonly<Record<string, string>> = {},
    agentColors: Readonly<Record<string, string>> = {},
    customAgents: Readonly<Record<string, string>> = {},
    agentPrefixes: Readonly<Record<string, readonly HarnessPrefixTurn[]>> = {}
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
                    agentColors[name],
                    agentPrefixes[name]
                )
            );

            continue;
        }

        agents[name] = agentFromProfile(
            name,
            settings,
            agentModels[name],
            agentInstructions[name],
            agentColors[name],
            agentPrefixes[name]
        );
    }

    return agents;
};

// A live harness factory for an ENTRY + ROSTER + RANKS selection. Used by the
// built-in presets and by user-created/overridden harnesses, so a harness choice
// can only change the agents — the toolbox and the loop budget are identical by
// construction.
//
// THE THREE ARGUMENTS ARE THREE CONCEPTS, so none of them is derived from another:
//   - `entry`  — routing: the agent an unfocused submit opens a conversation for;
//   - `roster` — WHO runs, in declaration order (the roster can NEVER be recovered
//                from `Object.keys(ranks)`: a rank map states authority, not membership,
//                and the two are written independently);
//   - `ranks`  — authority: agent id → A–Z letter, for EVERY member. ./registry.ts resolves
//                and validates exactly that (every key a member, every member keyed — see
//                `resolveRosterRanks`), and a map holding two or more DISTINCT letters is
//                what makes `delegate` exist at all (`ranksDeclareDelegation`, which is the
//                kernel's own `rosterHasDelegation`, ../harness.ts:1557-1561).
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
        entry: string,
        roster: readonly string[],
        ranks: Readonly<Record<string, AgentRank>>,
        agentModels: Readonly<Record<string, string>> = {},
        agentInstructions: Readonly<Record<string, string>> = {},
        agentColors: Readonly<Record<string, string>> = {},
        customAgents: Readonly<Record<string, string>> = {},
        // THE PRESET HISTORY MAP (U6). It sits with the other agent maps on purpose — it is agent
        // configuration, not toolbox configuration — which means it is inserted BEFORE the trailing
        // `toolbox` argument. Only three callers pass `toolbox` positionally (./presets.ts's `chat`
        // card, ./boot.ts's compiled cards, and ./registry.ts's rebuild paths), and each now names
        // the band map in front of it.
        agentPrefixes: Readonly<Record<string, readonly HarnessPrefixTurn[]>> = {},
        toolbox?: ProfiledHarnessToolbox
    ) =>
    (
        settings: RunnerSettings,
        progress: HarnessProgress,
        report?: HarnessPresetReport
    ): Harness =>
        createToolboxHarness(
            {
                // Entry FIRST, then the rest of the roster in the caller's order. The
                // entry is already roster[0] for every preset and every registry entry,
                // and this keeps that true for a caller that handed the roster over in
                // some other order: the agent map's key order is what the kernel's
                // "first key is the entry" default reads, and a projection that agrees
                // with the explicit `entry` below cannot disagree with itself.
                agents: agentsFromProfiles(
                    [entry, ...roster.filter((name) => name !== entry)],
                    settings,
                    agentModels,
                    agentInstructions,
                    agentColors,
                    customAgents,
                    agentPrefixes
                ),
                entry,
                ranks: { ...ranks },
                // A PROFILE PRESET THAT SAYS NOTHING KEEPS THE HISTORICAL SHARED TOOLBOX,
                // and it says so explicitly (R-boot). This is not cosmetic: the SessionStore
                // now forwards the deployment's boot toolbox as the per-build FALLBACK, so an
                // omitted field would let a zero-toolbox boot strip the cards in an explicitly
                // supplied `presets`/registry list. Stating `sharedToolbox: true` here makes
                // "the factory was built with the shared set" part of the definition, which is
                // the same rule `chat`'s explicit `false` follows. A host that wants a card on
                // the boot posture builds it through `createToolboxHarness` with the resolved
                // toolbox (./boot.ts does exactly that), not by passing `{}` here.
                ...(toolbox === undefined ? { sharedToolbox: true } : toolbox)
            },
            settings,
            progress,
            report
        );

// What a preset may say about the TOOLBOX half of its harness — the same shape the
// server boot's `HarnessBootConfiguration.toolbox` and the registry's creation defaults
// use (`HarnessToolboxDefaults`), so a host default, a registry-created harness and a
// factory's own declaration are ONE vocabulary rather than three. Every member is
// documented on `HarnessToolboxDefaults` (./types.ts) and resolved by
// `createToolboxHarness`.
//
// It stays an alias rather than a re-declaration on purpose: `createProfiledHarness`
// forwards it verbatim into `ToolboxHarnessConfiguration`, so a field added there can
// never be silently dropped on the profiled path.
export type ProfiledHarnessToolbox = HarnessToolboxDefaults;

// What a live preset supplies: the agents, which one is the entry, and what each of
// them is allowed to do. Everything else is the shared toolbox, so two presets
// cannot end up with different tools.
export type ToolboxHarnessConfiguration = {
    agents: Record<string, Agent>;
    // THE ENTRY AGENT (routing). Explicit even with one key, exactly as the old
    // `primary` was: an unfocused submit must never depend on key order.
    entry: string;
    // THE RANK MAP (authority): agent id → A–Z letter, `A` highest. An empty map
    // means NO delegation authority anywhere in this harness — there is no strictly
    // lower target to hand work to, so `delegate` is not registered — and it is the
    // direct replacement for the old `subagents: []`. A harness may hold any number
    // of Rank A agents; rank, not a singleton role, is what gates delegation
    // (../types/index.ts `isLowerRank`).
    ranks?: Readonly<Record<string, AgentRank>>;
    // THE TOOL-LESS POSTURE (issue 0005-D): `false` registers NO catalogue tool at all — neither the
    // package presets nor the app folder (both ride `SHARED_TOOL_SOURCES`) and neither environment row
    // (search/fetch), so the harness keeps only the harness-owned rows the kernel always owns
    // (toolRegistry/toolRequest/toolList/toolManage/toolCreate/records/tasks/profiles/chapters/
    // locations/agentManage/agentResult, plus the searchable demoted set) and, with a
    // single-rank roster, not even `delegate`. THAT is the gap this closes: a card whose model must never spend a tool round
    // on the server host's filesystem.
    //
    // DELIBERATELY NOT THE DEFAULT. Every live preset still shares one toolbox by construction; this
    // flag exists so ONE shipped card (and a host that injects its own preset) can state the opposite
    // posture without a second factory, and its effect is pinned per-card in ./presets.test.ts.
    // `presets: false` stays exactly as it is — the kernel's own baseline is skipped either way, so a
    // tool-less card registers nothing the descriptor does not advertise.
    sharedToolbox?: boolean;
    // The tool-loop budget for THIS harness, and it is OPTIONAL: omitted means no
    // budget at all (`PRESET_MAX_ITERATIONS`, i.e. Infinity — which is every shipped
    // card). A card that wants a hard stop passes a finite count; a run that hits it
    // is rolled back and rejected.
    //
    // The registry/card default (`HarnessRegistryOptions.creation.maxIterations`, carried
    // per card through `HarnessPreset.creation.toolbox`) is the fallback when the factory
    // states none; it never overrides a card that states one. There is no per-build
    // report member for this: a budget is part of the card's creation posture.
    maxIterations?: number;
    // Explicit environment-row opt-ins (R-boot). Each follows `sharedToolbox` when the
    // factory does not state it — the historical behaviour — so a host can keep the
    // shared file tools while turning `search`/`fetch` off, or enable `fetch` alone on a
    // tool-less card. See `declaredToolboxNames` for the matching card projection.
    websearch?: boolean;
    webfetch?: boolean;
    // Extra SOURCE entries, by package-relative path. Merged after the shared source
    // map and before host `extraTools`, so an extra is still compiled from its editable
    // entry instead of a prebuilt definition, while a host definition can still override
    // it. No shipped preset uses this any more — it was how the `flaky` example pulled in
    // `testFlaky` — so it is now purely a host/test extension point.
    extraToolSources?: Readonly<Record<string, string>>;
    // Host/example constructed DEFINITION overrides, registered last so they win
    // over both the shared and extra source maps.
    extraTools?: Readonly<Record<string, Tool>>;
    // Extra package-relative folders scanned during construction. Missing folders are
    // validated by the kernel itself (a bad path is a construction error), and an empty
    // list is omitted so a host that configures none keeps the historical configuration
    // object byte-for-byte.
    toolFolders?: readonly string[];
    // Slash commands applied to THIS harness (before any commands the report adds).
    // Absent means none; the kernel registers its own built-ins first, so a collision is
    // construction's duplicate-name error rather than a silent replacement.
    commands?: readonly HarnessCommandConfiguration[];
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
// BEFORE `configuration.extraTools`: an extra is compiled from its editable entry, while
// a host definition still wins on a name collision exactly as before. Environment tools
// (search/fetch) follow the host configuration as usual.
//
// FOLDER PRECEDENCE (T25): every app entry is a `toolSources` entry discovered from
// `src/server/tools/shared`, so the kernel commits it after the package baseline and
// after the package source map, and before `tools` definitions. There used to be a second,
// opt-in folder (`src/server/tools/examples`, holding `testFlaky`) committed the same way,
// which is how an example stayed out of the shared set without a name filter. That folder
// is gone with the example preset that owned it, so the shared folder is the only app
// source and `extraToolSources` is a host/test extension point.
export const createToolboxHarness = (
    configuration: ToolboxHarnessConfiguration,
    settings: RunnerSettings,
    progress: HarnessProgress,
    observer?: HarnessPresetReport
): Harness => {
    // THE FACTORY'S OWN TOOLBOX IS THE AUTHORITY (R-boot). The deployment's boot posture is
    // applied where templates are BUILT — boot-declared presets are compiled with it, and a
    // registry-created/restored harness is created with `HarnessRegistryOptions.creation` —
    // never as a per-build override of an explicitly supplied factory. That keeps the
    // precedence honest: a host that hands over a `HarnessPreset` really gets the tools that
    // factory declares (the shipped cards keep their shared toolbox), while a host that
    // omits templates entirely has nothing to strip.
    const useSharedToolbox = configuration.sharedToolbox ?? true;
    const useWebsearch = configuration.websearch ?? useSharedToolbox;
    const useWebfetch = configuration.webfetch ?? useSharedToolbox;
    const extraToolSources = { ...(configuration.extraToolSources ?? {}) };
    const extraTools = { ...(configuration.extraTools ?? {}) };
    const toolFolders = [...(configuration.toolFolders ?? [])];
    // Commands: the preset's own first, then the host's deployment-wide list. The kernel
    // refuses a duplicate name across the merged list, which is the honest answer for a
    // collision between a card and its host.
    const commands = [...(configuration.commands ?? []), ...(observer?.commands ?? [])];

    const liveConfiguration: HarnessConfiguration = {
        agents: configuration.agents,
        // Explicit routing: the entry agent is named even with one key, and the rank
        // map is COPIED so a later mutation of the preset's map cannot change a live
        // harness. A map that comes from ./registry.ts is already RESOLVED (every member
        // keyed), so the kernel fills nothing and the harness runs the ranks its card
        // shows. A hand-written host that passes no map gets the library's own rule
        // (entry 'A', every other agent 'B' — ../harness.ts:1540), which is deliberate:
        // that default is the library's, not this host's, and it is spelled in one place.
        entry: configuration.entry,
        ...(configuration.ranks === undefined ? {} : { ranks: { ...configuration.ranks } }),
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
        //
        // TOOL-LESS POSTURE (issue 0005-D): `sharedToolbox: false` drops the shared half and keeps only
        // the caller's own `extraToolSources` — a card that declares no catalogue tools must register
        // none, or the descriptor would advertise an empty list while the harness still declares core
        // file tools to every request.
        // The factory's extra map, merged after the shared half (or used alone with the
        // shared half off — then these ARE the toolbox).
        toolSources: useSharedToolbox
            ? { ...SHARED_TOOL_SOURCES, ...extraToolSources }
            : { ...extraToolSources },
        // Host/example DEFINITIONS override sources by being registered last.
        tools: { ...extraTools },
        // Empty means "nothing configured", so the field is omitted rather than sent as
        // `[]`: a preset built without folders keeps the exact historical configuration.
        ...(toolFolders.length === 0 ? {} : { toolFolders: [...toolFolders] }),
        // Same absent-when-empty rule. These are the HOST's commands (the kernel adds its
        // own `/help`, `/tools`, ... before any configured entry).
        ...(commands.length === 0 ? {} : { commands }),
        presets: false,
        // Tool-loop budget: no shipped card sets one, so live sessions get `PRESET_MAX_ITERATIONS`
        // (Infinity — the guard is off). It survives as a per-card opt-in, and the library
        // default is likewise uncapped (src/harness.ts `DEFAULT_MAX_ITERATIONS`).
        maxIterations: configuration.maxIterations ?? PRESET_MAX_ITERATIONS,
        // Environment-backed search; no key means the factory returns undefined
        // and the harness is unchanged. Keys are resolved at construction, after
        // `.env` is loaded by the CLI/server. The CONFIGURATION field keeps its
        // name (`websearch`); the core tool it registers is search (R18).
        // Both environment rows follow the shared-toolbox flag unless the card or the
        // host states them: a tool-less card declares no catalogue tool, and `fetch` in
        // particular registers WITHOUT a credential, so it would otherwise sneak a core
        // declaration onto a card whose descriptor promises none.
        websearch: useWebsearch,
        // Page fetch (W4) must be opted into as well, or `fetch` never enters
        // this harness's tool map and `toolRequest` has nothing to surface under
        // the `web`/`fetch`/`url` tags — the agent then legitimately reports
        // "search only". `native` needs no credential, so this is safe on a
        // keyless host; the tool stays SEARCHABLE (see src/harness.ts), so it
        // costs no request schema until the model asks for it.
        webfetch: useWebfetch,
        // THE PLUGIN SET (R-boot). An absent report leaves the library default
        // (`BUILTIN_PLUGINS`); a reported ARRAY is the whole set, so `builtinPlugins: []`
        // is what makes "the host configured no plugins" mean none instead of the shipped
        // three. See `HarnessPresetReport.plugins` in ./types.ts.
        ...(observer?.plugins === undefined
            ? {}
            : { builtinPlugins: [], plugins: observer.plugins }),
        // The server's persistence observer rides along with progress; either may
        // be absent (CLI, direct preset creation).
        report: {
            progress,
            ...(observer?.stateChange === undefined ? {} : { stateChange: observer.stateChange }),
            // T1.5 last mile: the host's plugin-diagnostic sink. Forwarded exactly like
            // `stateChange` — presence means the operator can see a broken plugin, absence
            // means the library's silent no-op. It is NOT a persistence observer: a plugin
            // that throws must not schedule a save by itself (src/types/index.ts
            // `HarnessDiagnosticEvent`), which is why it rides `report` beside `stateChange`
            // rather than replacing it.
            ...(observer?.diagnostic === undefined ? {} : { diagnostic: observer.diagnostic })
        },
        // N4: the host owner answerer. It belongs on the TOP-LEVEL harness
        // configuration (not inside `report`), because presence is what makes the
        // runtime register actionRequest. A missing hook simply means this host has
        // no answerer and the tool is not declared.
        ...(observer?.interaction === undefined ? {} : { interaction: observer.interaction }),
        // T5 (R2/R3): the host's live plugin settings provider, on the same top-level rule
        // (it is a HarnessConfiguration field, src/types/index.ts:2643). Presence means the
        // harness reads operator edits; absence means the library's declared-default provider
        // (src/harness.ts:1080), which is exactly the pre-R3 behaviour and what a lane worker
        // still gets, because a closure cannot cross a `worker_threads` boundary.
        //
        // Only the REFERENCE crosses, and `harness()` never copies it: the settings view
        // built per plugin calls `provider.get` on every read (src/plugin/settings.ts:145-153),
        // so a value written after this harness was constructed is what its next turn sees.
        ...(observer?.pluginSettings === undefined ? {} : { pluginSettings: observer.pluginSettings }),
        // R3: the host's live GLOBAL tool provider, on the identical rule (it is a
        // HarnessConfiguration field, src/types/index.ts `HarnessConfiguration.toolSettings`).
        // Presence means the harness honours the operator's disabled set at the three tool
        // decisions (declarations, the launch gate, discovery); absence means nothing is
        // disabled globally. A lane worker reaches this same line with a provider of its OWN:
        // the coordinator's closure cannot cross `worker_threads`, so the blueprint ships the
        // NAME LIST and the worker builds the provider from it (../workers/lane-worker-loop.ts
        // `laneToolSettingsProvider`, ../workers/protocol.ts `LaneBlueprint.disabledTools`).
        // Only the reference is live; a lane is live for the set it was created with
        // (../tool-settings.ts "WORKER MODE").
        ...(observer?.toolSettings === undefined ? {} : { toolSettings: observer.toolSettings }),
        // T7: the host's knowledge base, on the same rule as the two above (a
        // `HarnessConfiguration` field, ../types). Absent means the library default: a private
        // in-memory engine, and `harness.knowledge` carries NO `flush`, so a tool says "in
        // memory" instead of promising bytes it cannot write. Presence means this session's
        // `context.harness.knowledge` is the deployment's store — the same object every other
        // session of this process holds (../runtime.ts resolves it once per root), which is how
        // one session's article is another's to read and why deleting a session changes nothing
        // about the base.
        ...(observer?.knowledge === undefined ? {} : { knowledge: observer.knowledge }),
        // T6: the canonical harness name this build's knowledge writes are attributed to, on the
        // identical top-level rule as `knowledge` above (it is a `HarnessConfiguration` field,
        // ../types `HarnessConfiguration.knowledgeOwner`). Presence is what makes delete-by-owner
        // possible: the engine stamps it on `create`, and the server's harness-delete flow later
        // removes exactly the articles carrying this name. Absence (a direct preset caller, a
        // lane worker, a library consumer) means unowned articles, which every cleanup preserves.
        ...(observer?.knowledgeOwner === undefined ? {} : { knowledgeOwner: observer.knowledgeOwner }),
        // R1: the host's per-build "start with the whole switchable toolbox enabled" seed,
        // forwarded verbatim into `HarnessConfiguration.enableAllTools` (src/types/index.ts).
        // Absent means the library default — an empty enabled set — which is what a library
        // consumer, a scripted demo, and a RESTORED session all get: a restore re-applies the
        // snapshot's own `discovery.enabled`, so the persisted set is the authority there.
        // The kernel, not this layer, decides WHICH names the seed admits (its switchability
        // rule, the host deny list, and `maxEnabledTools`), so no name list travels here.
        ...(observer?.enableAllTools === true ? { enableAllTools: true } : {})
    };

    return harness(liveConfiguration);
};

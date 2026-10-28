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
// WHAT IS IN THE SHARED TOOLBOX
// -----------------------------
//   - package presets  — src/tools: syntaxCheck, readFile, writeFile, editFile,
//                        listFiles, searchFiles, globFiles, runCommand, gitDiff
//                        (lazy proxies, see src/tools/lazy.ts)
//   - harness tools    — ./tools: clock, wordCount, roll, searchNotes, summarize
//   - websearch        — environment-backed (EXA_API_KEY / TAVILY_API_KEY); the
//                        harness factory registers it only when a key resolves,
//                        so a keyless host is offline-safe. The global catalogue
//                        still lists it as `unconfigured`, never fake-callable.
//   - core tools       — harness-owned only: requestTools, createTool, todoTools,
//                        and delegate for a preset that declares subagents. Every
//                        package and app tool (including the file tools) is
//                        searchable, so a live harness declares nothing else up
//                        front.
//
// DELIBERATE EXCEPTIONS
// ---------------------
//   - `flaky` is NOT in the shared toolbox. It fails two calls out of three on
//     purpose and carries module-level mutable state; it belongs to the
//     "Recoverable failures" example harness, which adds it as an extra tool.
//   - the `demo` preset stays the scripted offline fixture (clock only): it is
//     not a live harness, so the equal-toolbox rule does not apply to it.
//
// LAZY, NOT EAGER
// ---------------
// `presetTools` values are lazy proxies and the harness-tool definitions are
// already imported by this app. Spreading the table registers names and metadata
// without loading `node:fs`, `node:child_process`, or `node:vm`; an implementation
// is imported on first execution. "All tools available" therefore means
// registered/discoverable, never eagerly loaded.
//
// Cross-references:
//   - ./presets.ts      — the preset catalogue built on this factory
//   - ./tools.ts        — the app tools (clock, …, summarize) in the shared set
//   - ../src/harness.ts — `presets: false` + explicit `tools` registry semantics
//   - ../server/api.ts  — descriptors resolved from the same preset metadata

import { agent, harness, presetTools } from '../src/harness';
import type { Agent, Harness, HarnessProgress, Tool } from '../src/harness';
import { agentInstruction, agentProfile } from '../src/agents';
import { harnessTools } from './tools';
import type { RunnerSettings } from './types';

// Tool-loop budget for live harnesses. The library default (16) is a runaway
// guard, but a real session legitimately needs dozens of rounds: discovery,
// several reads/edits, a command, then an answer. 1000 keeps a hard stop without
// truncating real work. Exported so the CLI/server can report the same bound.
export const PRESET_MAX_ITERATIONS = 1000;

// The app-level tools every live harness shares, in registration order. Kept as
// a named list (not `Object.keys(harnessTools)`) because `flaky` is deliberately
// excluded and the order is part of the descriptor contract tests pin.
export const SHARED_APP_TOOL_NAMES = [
    'clock',
    'wordCount',
    'roll',
    'searchNotes',
    'summarize'
] as const;

// The shared registry. Package presets come first so a duplicate name in the app
// table is a visible shadow rather than a silent override; `harnessTools` names
// do not collide with `presetTools` today.
export const SHARED_TOOLS: Readonly<Record<string, Tool>> = {
    ...presetTools,
    clock: harnessTools.clock,
    wordCount: harnessTools.wordCount,
    roll: harnessTools.roll,
    searchNotes: harnessTools.searchNotes,
    summarize: harnessTools.summarize
};

// The exact declared names, in registry order: package tools then app tools.
// Derived from the table so a new package/tool entry cannot be advertised in a
// descriptor without also being registered (and vice versa). Frozen because the
// preset metadata shares this array: a caller must not be able to mutate one
// preset's advertised toolbox at runtime.
export const SHARED_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(SHARED_TOOLS));

// Harness-owned core names. `delegate` is capability-by-configuration: the
// harness registers it only when the harness declares subagents, so a single-agent
// Instruct has no delegation tool while Research does. That difference is the
// agent configuration, not a difference in the shareable toolbox.
//
// No preset entry is core any more: every registered package/app tool is
// searchable, so a descriptor advertises exactly these names (plus delegate).
// `presetCore` is kept out of the signature deliberately — there is no second
// source of core tools that could disagree with this list.
export const CORE_TOOL_NAMES = ['requestTools', 'createTool', 'todoTools'] as const;

export const coreToolNames = (subagents: readonly string[] = []): string[] => [
    ...CORE_TOOL_NAMES,
    ...(subagents.length > 0 ? ['delegate'] : [])
];

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
export const agentFromProfile = (name: string, settings: RunnerSettings, model?: string): Agent => {
    const profile = agentProfile(name);
    const override = model === undefined ? '' : model.trim();

    return agent({
        name,
        model: override.length > 0 ? override : settings.model,
        instruction: agentInstruction(profile),
        provider: providerOf(settings)
    });
};

// Build the agent registry for a selected set. Order is the caller's: primary
// first, then the allowlist, matching the descriptor's `agents` list. `agentModels`
// is the validated override map from the harness registry; it is applied per agent
// so one member can run a different model from its siblings.
export const agentsFromProfiles = (
    names: readonly string[],
    settings: RunnerSettings,
    agentModels: Readonly<Record<string, string>> = {}
): Record<string, Agent> => {
    const agents: Record<string, Agent> = {};

    for (const name of names) agents[name] = agentFromProfile(name, settings, agentModels[name]);

    return agents;
};

// A live harness factory for a primary + subagent selection. Used by the built-in
// presets and by user-created/overridden harnesses, so a harness choice can only
// change the agents — the toolbox and the loop budget are identical by
// construction.
//
// The model map is captured by the closure, not read at run time: `update()`
// builds a NEW factory for the new map, and a session created before that keeps
// the closure (and therefore the models) it was built with.
export const createProfiledHarness =
    (primary: string, subagents: readonly string[], agentModels: Readonly<Record<string, string>> = {}) =>
    (settings: RunnerSettings, progress: HarnessProgress): Harness =>
        createToolboxHarness(
            {
                agents: agentsFromProfiles([primary, ...subagents], settings, agentModels),
                primary,
                subagents: [...subagents]
            },
            settings,
            progress
        );

// What a live preset supplies: the agents and how they are routed. Everything
// else is the shared toolbox, so two presets cannot end up with different tools.
export type ToolboxHarnessConfiguration = {
    agents: Record<string, Agent>;
    primary: string;
    // Omitted/empty means a single-agent harness (no delegate tool).
    subagents?: readonly string[];
    // Example-only extras (the recoverable-failure preset adds `flaky`). Never
    // used by Instruct/Research/Workspace, so the shared set stays exact.
    extraTools?: Readonly<Record<string, Tool>>;
};

// Build a live harness from agent configuration + the shared toolbox. `presets:
// false` keeps the registry explicit: the shared table is the only catalogue a
// session can see, so nothing outside the advertised descriptor set sneaks in
// through the library's default preload.
export const createToolboxHarness = (
    configuration: ToolboxHarnessConfiguration,
    settings: RunnerSettings,
    progress: HarnessProgress
): Harness =>
    harness({
        agents: configuration.agents,
        // Explicit routing: the entry agent is named even with one key, and the
        // allowlist is copied so later mutation cannot change a live harness.
        primary: configuration.primary,
        ...(configuration.subagents === undefined ? {} : { subagents: [...configuration.subagents] }),
        tools: { ...SHARED_TOOLS, ...configuration.extraTools },
        presets: false,
        // Live sessions use the app-wide tool-loop budget, not the library's 16.
        maxIterations: PRESET_MAX_ITERATIONS,
        // Environment-backed search; no key means the factory returns undefined
        // and the harness is unchanged. Keys are resolved at construction, after
        // `.env` is loaded by the CLI/server.
        websearch: true,
        report: { progress }
    });

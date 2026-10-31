// The harness catalogue.
//
// Every preset is a factory so a caller can attach its own provider settings and
// progress sink. The CLI calls one directly; the HTTP server keeps one harness per
// session and routes that session's events to its own stream.
//
// TWO KINDS OF PRESET
// -------------------
//   live  — instruct, research, workspace, reviewer, planner (and the flaky
//           example). All built from TRUSTED agent profiles in src/agents through
//           `createProfiledHarness` (./toolbox.ts), so they register the SAME
//           toolbox: package coding tools, the app tools, environment-backed
//           webSearch, and the harness core tools. Only the agents differ: names,
//           instructions, guidelines, primary, and subagents.
//   fixture — demo is a scripted offline run with timeNow only. It is retained so
//           the UI (and the service tests) can exercise the whole loop without a
//           provider; it is deliberately not a live harness and is listed after
//           the live presets.
//
// THE FIVE REAL ROLES (T3)
// ------------------------
//   instruct  — general instruction-following
//   research  — investigator/cross-checker (visible title "Researcher")
//   workspace — coder (visible title "Coder"; the id is legacy for compatibility)
//   reviewer  — skeptical bug/inconsistency hunt
//   planner   — plan, then route the steps to specialists
//
// TEAMS ARE SYMMETRIC ON PURPOSE. Every real preset offers every OTHER real role
// plus `summarizer` as a direct subagent, so switching the entry role never removes
// a specialist from the team and the Planner's `coder`/`researcher`/`reviewer`
// targets exist by id. `teamOf()` derives the allowlist from one list, so the five
// presets cannot drift. The one-level delegation rule is a harness property (a
// subagent never receives agentDelegate), so none of these prompts may ask a
// subagent to delegate again.
//
// EDITABLE TEMPLATES (R20.1)
// --------------------------
// Every entry here is a TEMPLATE. The registry copies it into an independent
// application entry, so a PATCH never mutates this module (and a later session
// keeps the factory it captured). `editable: true` is a compatibility wire field
// only; there is no read-only category, no categorization UI, and the registry
// does not gate a PATCH on it. `template` (not on the wire) tells the registry
// what a metadata-only patch must preserve:
//   - 'scripted' — demo keeps its offline script and timeNow registry;
//   - 'flaky'    — the example keeps testFlaky and its shared toolbox;
//   - 'live'     — rebuilt from the selected agents/models.
// An executable change (primary/subagents/agentModels) on demo upgrades it to a
// live profiled harness; on flaky it rebuilds the live toolbox and retains
// testFlaky. See ./registry.ts update().
//
// Instructions live in src/agents, not here
// -----------------------------------------
// The words a model is seeded with are trusted catalogue data (AgentProfile), so a
// harness definition and a user-created harness build an agent from the same
// profile. This file only maps a harness onto agent ids: `agents` order is
// [primary, ...subagents].
//
// The preset name is the harness's name and, by convention, its entry agent's
// name. The server's registry keys by preset name; the agent registry key inside
// the harness is the agent id.
//
// Backward compatibility: `writer` and `assistant` are aliases of `instruct`,
// and `researcher` is an alias of `research` (see ./registry.ts PRESET_ALIASES +
// findPreset). They resolve to the canonical preset, so an old CLI invocation or
// bookmarked session request still runs; they are not listed a second time. No
// alias was added for the visible title "Coder": `workspace` is the id, and a new
// reserved name could collide with an existing user-created harness on restore. The
// harness ids themselves are unchanged by the T3 roster change — only titles,
// descriptions and subagent allowlists moved, so a saved session keeps restoring.
// `LEGACY_PRESET_DEFINITIONS` below records the previous shipped executable
// definitions so ./registry.ts can refresh a built-in row that was never
// customised.
//
// Cross-references:
//   - ../src/agents     — AgentProfile registry (instruction + guidelines)
//   - ./toolbox.ts      — createProfiledHarness / createToolboxHarness
//   - ./types.ts        — HarnessPreset metadata (primary/subagents/tools/builtin)
//   - ./registry.ts     — restore policy, aliases, validation
//   - ../api.ts  — descriptors resolved from this metadata

import { agent, harness } from '../../harness';
import { agentInstruction, AGENT_PROFILES } from '../../agents';
import type { HarnessPreset, RunnerSettings } from './types';
import { scriptedDemo } from './demo';
import {
    EXAMPLE_APP_TOOL_SOURCES,
    PRESET_MAX_ITERATIONS,
    SHARED_APP_TOOL_SOURCES,
    SHARED_TOOL_NAMES,
    agentsFromProfiles,
    createProfiledHarness,
    createToolboxHarness,
    providerOf
} from './toolbox';

// Re-exported for callers that imported the app-wide tool-loop budget from here
// (the CLI and server tests did); the value now lives with the shared factory.
export { PRESET_MAX_ITERATIONS };

// The example-only app tools, in registration order. T25: derived from the discovered
// `server/tools/examples` folder instead of the literal 'testFlaky', so a second
// example entry joins this preset with no edit here (and still no name filter in the
// shared toolbox).
const EXAMPLE_TOOL_NAMES: readonly string[] = Object.keys(EXAMPLE_APP_TOOL_SOURCES);

// The real specialist roles, in catalogue/descriptor order. This is the ONE list
// the teams are derived from: changing a role's usefulness here changes every
// preset's allowlist at once.
export const SPECIALIST_AGENT_NAMES = [
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner'
] as const;

// `summarizer` stays a subagent everywhere so the `textSummarize` delegated path
// keeps working in the real presets (it condenses locally when absent).
const SUMMARIZER_AGENT_NAME = 'summarizer';

// The subagent allowlist for one primary: every OTHER real role, then the
// summarizer. The primary is excluded because a harness has exactly one primary
// and the registry rejects a subagent that names it.
export const teamOf = (primary: string): string[] => [
    ...SPECIALIST_AGENT_NAMES.filter((name) => name !== primary),
    SUMMARIZER_AGENT_NAME
];

// ---------------------------------------------------------------------------
// Live harnesses: same toolbox, different selected agents
// ---------------------------------------------------------------------------

// The general-purpose choice and the first card in the UI. Its profile's
// guidelines are about *behaviour* and discovery, not about which capabilities
// exist: the four core file tools and a configured webSearch are always declared;
// fileList, commands, git, syntax and the app tools are searchable.
// The allowlist is computed once per preset so the metadata and the factory
// closure cannot see two different lists.
const instructTeam = teamOf('instruct');

const instruct: HarnessPreset = {
    name: 'instruct',
    title: 'Instruct',
    description:
        'General instruction-following agent with the full shared toolbox and every other role as a direct subagent. File read/write/edit/glob and a configured webSearch are always available; call toolRequest for fileList, commands, diffs, syntax checks, time, text, or notes. Only the agents differ between live presets, never the tools.',
    requiresEndpoint: true,
    primary: 'instruct',
    subagents: instructTeam,
    agents: ['instruct', ...instructTeam],
    tools: SHARED_TOOL_NAMES,
    // Same environment-backed declaration as every live preset: a keyless host
    // simply does not append webSearch to the descriptor (it stays listed as
    // unconfigured in the global tool catalogue).
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('instruct', instructTeam)
};

// Research (visible title "Researcher"): investigate and cross-check. Same
// toolbox as Instruct; the difference is the profile, which demands evidence and
// citation, and the team, which lets it hand code verification or a second opinion
// to the coding agent or the reviewer.
const researchTeam = teamOf('research');

const research: HarnessPreset = {
    name: 'research',
    title: 'Researcher',
    description:
        'Researcher with the same full toolbox as every live harness and the other roles as direct subagents. fileRead and fileGlob are always available; webSearch joins the toolbox when the host configured a key. Investigates, cross-checks sources, and cites what it used.',
    requiresEndpoint: true,
    primary: 'research',
    subagents: researchTeam,
    agents: ['research', ...researchTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('research', researchTeam)
};

// Workspace (visible title "Coder"): the coding-focused live harness. The id stays
// `workspace` for every saved session, bookmark and script; only the title says
// Coder. Same toolbox as Instruct; the profile is what makes it a coding agent,
// which is exactly the product rule ("the only difference is the agents
// configuration").
const workspaceTeam = teamOf('workspace');

const workspace: HarnessPreset = {
    name: 'workspace',
    title: 'Coder',
    description:
        'Coding agent with the full shared toolbox and the other roles as direct subagents: file read/write/edit/glob are always available, and fileList, syntax checks, diffs, and commands are discovered by tag. Web search is available when a key is configured. Everything runs on the server host.',
    requiresEndpoint: true,
    primary: 'workspace',
    subagents: workspaceTeam,
    agents: ['workspace', ...workspaceTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('workspace', workspaceTeam)
};

// Reviewer: a skeptical pass over a change, plan, or claim. The team is the same
// symmetric set, so it can ask the coder to verify a code path or the researchers
// to confirm a fact, but its own default is read-only.
const reviewerTeam = teamOf('reviewer');

const reviewer: HarnessPreset = {
    name: 'reviewer',
    title: 'Reviewer',
    description:
        'Skeptical review agent with the full shared toolbox and the other roles as direct subagents. Looks for small bugs and inconsistencies, reports each with file/line evidence, and says plainly when there is nothing to find. Reads and verifies by default; edits only when asked.',
    requiresEndpoint: true,
    primary: 'reviewer',
    subagents: reviewerTeam,
    agents: ['reviewer', ...reviewerTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('reviewer', reviewerTeam)
};

// Planner: plan, then route each step to the specialist that owns it. It is the
// preset that exists FOR delegation, and its team deliberately contains the other
// four real roles by id, so `agentDelegate` targets really exist.
const plannerTeam = teamOf('planner');

const planner: HarnessPreset = {
    name: 'planner',
    title: 'Planner',
    description:
        'Planning lead with the full shared toolbox and every other role as a direct subagent. Restates the goal and acceptance criteria, writes an explicit plan, hands each step to the specialist who owns it (researcher, coder, reviewer, instruct), and verifies the evidence before answering.',
    requiresEndpoint: true,
    primary: 'planner',
    subagents: plannerTeam,
    agents: ['planner', ...plannerTeam],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('planner', plannerTeam)
};

// ---------------------------------------------------------------------------
// Examples and fixtures
// ---------------------------------------------------------------------------

// The offline demo is a scripted transport, not a live harness: it demonstrates
// the loop (reasoning, toolRequest discovery, one tool call, answer) with no
// endpoint. Its timeNow-only registry is intentional and pinned by its script, so
// it is exempt from the shared-toolbox rule. It is still an EDITABLE template
// (R20.1): a metadata-only PATCH (title/description) keeps the script; an
// executable PATCH (primary/subagents/agentModels) upgrades it to an honest live
// profiled harness (shared toolbox, requiresEndpoint, no script). `template` is
// the registry's signal for that distinction — see ./registry.ts.
const demo: HarnessPreset = {
    name: 'demo',
    title: 'Scripted demo',
    description:
        'Runs a scripted transport: a reasoning stream, a toolRequest discovery round, one tool call, and a final answer. No endpoint needed, so this is the fixture to try first. It is deliberately not a live harness: the toolbox rule applies to the real presets.',
    requiresEndpoint: false,
    primary: 'demo',
    subagents: [],
    agents: ['demo'],
    tools: ['timeNow'],
    builtin: true,
    editable: true,
    template: 'scripted',
    // Adopted by the registry only when an executable PATCH upgrades this template
    // and the operator has not edited the shipped title/description (R20.1): the
    // card must stop claiming "scripted, no endpoint" once it runs live turns.
    live: {
        title: 'Live demo',
        description:
            'A live harness built from the selected agents with the shared toolbox, running against the session provider. This entry started as the scripted demo and no longer uses the offline script.'
    },
    create: (settings, progress, report) =>
        harness({
            agents: {
                demo: agent({
                    model: settings.model.trim().length > 0 ? settings.model : 'scripted/demo',
                    // The trusted profile's instruction + guidelines, same
                    // composition every live agent uses. The scripted transport
                    // ignores them; keeping the path identical proves the profile
                    // is the single source of the prompt.
                    instruction: agentInstruction(AGENT_PROFILES.demo),
                    stream: scriptedDemo()
                })
            },
            // T19/F1: the scripted fixture is still a shipped exception in its
            // TOOL SET, but not in how that tool is registered. Compile its one
            // editable source entry through the same startup kernel instead of
            // passing a prebuilt definition through `tools`.
            // T25: the path is the DISCOVERED one (server/tools/shared/timeNow.tool.ts),
            // so moving/renaming the entry cannot leave a stale literal behind.
            toolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow },
            presets: false,
            // Explicit entry point, even with one agent: the documented style,
            // and it keeps the harness name independent of key order.
            primary: 'demo',
            // The optional third argument is the server's persistence observer
            // (R3b). A scripted harness mutates the todo/record stores too, so its
            // notifications matter exactly like a live harness's.
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            },
            // N4: the same owner-interaction hook every live factory gets. The
            // scripted transport never calls actionRequest, but forwarding it keeps
            // "a preset choice changes agents, not host capabilities". It must be a
            // TOP-LEVEL configuration field: presence registers the tool.
            ...(report?.interaction === undefined ? {} : { interaction: report.interaction })
        })
};

// Recoverable failures is a live example, so it gets the shared toolbox too and
// adds the example tools. Those stay out of the shared table on purpose: `testFlaky`
// throws two calls out of three and keeps its attempt count per AGENT (a WeakMap
// keyed by the requesting agent, so two sessions never share a count), which must
// never be part of what the real presets can call. The example's failure behaviour is
// its point, so its template is `flaky`: a metadata-only PATCH keeps this factory and
// its extra tools, while an executable PATCH rebuilds the live toolbox with them
// retained. The harness id stays `flaky`.
//
// T25: the tool SET is `[...SHARED_TOOL_NAMES, ...EXAMPLE_TOOL_NAMES]` and the
// sources are the discovered example map — both derived from the folders, so no name
// is hardcoded here.
const failure: HarnessPreset = {
    name: 'flaky',
    title: 'Recoverable failures (example)',
    description:
        'The shared toolbox plus a tool that throws on two out of every three calls. The harness turns each error into a tool result, so the model can retry instead of the run dying. An example of the failure path, not a general-purpose agent.',
    requiresEndpoint: true,
    primary: 'flaky',
    subagents: [],
    agents: ['flaky'],
    tools: [...SHARED_TOOL_NAMES, ...EXAMPLE_TOOL_NAMES],
    // R18: the factory below uses createToolboxHarness, which opts into webSearch
    // exactly like the live presets. Declaring it here keeps descriptor.tools and
    // descriptor.coreTools equal to what the session actually registers.
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'flaky',
    create: (settings: RunnerSettings, progress, report) =>
        createToolboxHarness(
            {
                agents: agentsFromProfiles(['flaky'], settings),
                primary: 'flaky',
                subagents: [],
                // The example tools; excluded from the shared set but still compiled
                // from their editable source entries (T19/F1, T25).
                extraToolSources: { ...EXAMPLE_APP_TOOL_SOURCES }
            },
            settings,
            progress,
            report
        )
};

// UI/CLI order: the five real roles first (instruct is the default/first card),
// then the offline fixture and the failure example. This is what stops the demo
// from dominating the initial UI now that it is not the headline preset.
export const presets: readonly HarnessPreset[] = [
    instruct,
    research,
    workspace,
    reviewer,
    planner,
    demo,
    failure
];

// Previous shipped EXECUTABLE definitions, keyed by preset id, for the restore
// policy in ./registry.ts.
//
// WHY: a persisted registry row is a copy of what shipped at the time. Replaying it
// verbatim would pin an old build's defaults forever, so an improved roster would
// never reach an existing installation. These entries are the exact fields that
// T3 changed, which makes "the operator never customised this row" provable: a
// saved record whose executable fields still match the table is a SHIPPED default,
// not a decision, so the current template wins. A record that differs in any
// executable field is treated as a real customisation and is replayed unchanged.
//
// Only the presets whose defaults moved need an entry; a record whose fields equal
// the CURRENT template is already skipped by `presetRecordEquals` in restore.
// Title/description are recorded too, only so an operator's prose edit can be
// identified and preserved across the refresh.
export type LegacyPresetDefinition = {
    title: string;
    description: string;
    requiresEndpoint: boolean;
    primary: string;
    subagents: readonly string[];
    agents: readonly string[];
    tools: readonly string[];
    environmentTools?: readonly string[];
    template?: 'live' | 'scripted' | 'flaky';
};

export const LEGACY_PRESET_DEFINITIONS: Readonly<Record<string, LegacyPresetDefinition>> = {
    instruct: {
        title: 'Instruct',
        description:
            'A general instruction-following agent with the full shared toolbox. File read/write/edit/glob and a configured webSearch are always available; call toolRequest with capability tags for fileList, commands, diffs, syntax checks, time, text, or notes. The live presets differ only in their agents, not their tools.',
        requiresEndpoint: true,
        primary: 'instruct',
        subagents: [],
        agents: ['instruct'],
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['webSearch'],
        template: 'live'
    },
    research: {
        title: 'Research',
        description:
            'A research agent with the same full toolbox as every live harness, plus a summarizer subagent. fileRead and fileGlob are always available; `primary` and `subagents` are explicit: the research agent is the entry point and the only agent that may delegate, and delegation is one level deep. Web search is core and joins the toolbox when the host configured a search key.',
        requiresEndpoint: true,
        primary: 'research',
        subagents: ['summarizer'],
        agents: ['research', 'summarizer'],
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['webSearch'],
        template: 'live'
    },
    workspace: {
        title: 'Workspace (coding)',
        description:
            'A coding agent with the full shared toolbox: file read/write/edit/glob are always available, and fileList, syntax checks, diffs, and commands are discovered by tag. Web search is available when a key is configured. It has the same registered tools as every live harness and differs only in its agent profile and routing. Everything runs on the server host.',
        requiresEndpoint: true,
        primary: 'workspace',
        subagents: [],
        agents: ['workspace'],
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['webSearch'],
        template: 'live'
    }
};

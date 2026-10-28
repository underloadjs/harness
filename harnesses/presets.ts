// The harness catalogue.
//
// Every preset is a factory so a caller can attach its own provider settings and
// progress sink. The CLI calls one directly; the HTTP server keeps one harness per
// session and routes that session's events to its own stream.
//
// TWO KINDS OF PRESET
// -------------------
//   live  — instruct, research, workspace (and the flaky example). All built from
//           TRUSTED agent profiles in src/agents through `createProfiledHarness`
//           (./toolbox.ts), so they register the SAME toolbox: package coding
//           tools, the app tools, environment-backed webSearch, and the harness
//           core tools. Only the agents differ: names, instructions, guidelines,
//           primary, and subagents.
//   fixture — demo is a scripted offline run with timeNow only. It is retained so
//           the UI (and the service tests) can exercise the whole loop without a
//           provider; it is deliberately not a live harness and is listed after
//           the live presets.
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
// and `researcher` is an alias of `research` (see ./index.ts `findPreset` and
// ./registry.ts). They resolve to the canonical preset, so an old CLI invocation
// or bookmarked session request still runs; they are not listed a second time.
// The harness ids themselves are unchanged by the T14 tool rename — only TOOL
// names changed.
//
// Cross-references:
//   - ../src/agents     — AgentProfile registry (instruction + guidelines)
//   - ./toolbox.ts      — createProfiledHarness / createToolboxHarness
//   - ./types.ts        — HarnessPreset metadata (primary/subagents/tools/builtin)
//   - ../server/api.ts  — descriptors resolved from this metadata

import { agent, harness } from '../src/harness';
import { agentInstruction, AGENT_PROFILES } from '../src/agents';
import type { HarnessPreset, RunnerSettings } from './types';
import { harnessTools } from './tools';
import { scriptedDemo } from './demo';
import {
    PRESET_MAX_ITERATIONS,
    SHARED_TOOL_NAMES,
    agentsFromProfiles,
    createProfiledHarness,
    createToolboxHarness,
    providerOf
} from './toolbox';

// Re-exported for callers that imported the app-wide tool-loop budget from here
// (the CLI and server tests did); the value now lives with the shared factory.
export { PRESET_MAX_ITERATIONS };

// ---------------------------------------------------------------------------
// Live harnesses: same toolbox, different selected agents
// ---------------------------------------------------------------------------

// The general-purpose choice and the first card in the UI. Its profile's
// guidelines are about *behaviour* and discovery, not about which capabilities
// exist: the four core file tools and a configured webSearch are always declared;
// fileList, commands, git, syntax and the app tools are searchable.
const instruct: HarnessPreset = {
    name: 'instruct',
    title: 'Instruct',
    description:
        'A general instruction-following agent with the full shared toolbox. File read/write/edit/glob and a configured webSearch are always available; call toolRequest with capability tags for fileList, commands, diffs, syntax checks, time, text, or notes. The live presets differ only in their agents, not their tools.',
    requiresEndpoint: true,
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: SHARED_TOOL_NAMES,
    // Same environment-backed declaration as every live preset: a keyless host
    // simply does not append webSearch to the descriptor (it stays listed as
    // unconfigured in the global tool catalogue).
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('instruct', [])
};

// Research: the one live preset with a subagent. The shared toolbox is identical
// to Instruct's; the difference is the selected agents, which makes agentDelegate
// (and the delegated half of textSummarize) available.
const research: HarnessPreset = {
    name: 'research',
    title: 'Research',
    description:
        'A research agent with the same full toolbox as every live harness, plus a summarizer subagent. fileRead and fileGlob are always available; `primary` and `subagents` are explicit: the research agent is the entry point and the only agent that may delegate, and delegation is one level deep. Web search is core and joins the toolbox when the host configured a search key.',
    requiresEndpoint: true,
    primary: 'research',
    subagents: ['summarizer'],
    agents: ['research', 'summarizer'],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('research', ['summarizer'])
};

// Workspace: the coding-focused live harness. Same toolbox as Instruct; the
// selected agent's profile is the part that makes it a coding agent, which is
// exactly the product rule ("the only difference is the agents configuration").
const workspace: HarnessPreset = {
    name: 'workspace',
    title: 'Workspace (coding)',
    description:
        'A coding agent with the full shared toolbox: file read/write/edit/glob are always available, and fileList, syntax checks, diffs, and commands are discovered by tag. Web search is available when a key is configured. It has the same registered tools as every live harness and differs only in its agent profile and routing. Everything runs on the server host.',
    requiresEndpoint: true,
    primary: 'workspace',
    subagents: [],
    agents: ['workspace'],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'live',
    create: createProfiledHarness('workspace', [])
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
        'Runs a scripted transport: a reasoning stream, a toolRequest discovery round, one tool call, and a final answer. No endpoint needed, so this is the fixture to try first. It is deliberately not a live harness: the toolbox rule applies to Instruct, Research, and Workspace.',
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
    create: (settings, progress) =>
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
            tools: { timeNow: harnessTools.timeNow },
            presets: false,
            // Explicit entry point, even with one agent: the documented style,
            // and it keeps the harness name independent of key order.
            primary: 'demo',
            report: { progress }
        })
};

// Recoverable failures is a live example, so it gets the shared toolbox too and
// adds `testFlaky` as an extra. `testFlaky` stays out of the shared table on
// purpose: it throws two calls out of three and keeps its attempt count per AGENT
// (a WeakMap keyed by the requesting agent, so two sessions never share a count),
// which must never be part of what Instruct/Research/Workspace can call. The
// example's failure behaviour is its point, so its template is `flaky`: a
// metadata-only PATCH keeps this factory and its extra tool, while an executable
// PATCH rebuilds the live toolbox with testFlaky retained. The harness id stays
// `flaky` (only the TOOL is testFlaky).
const failure: HarnessPreset = {
    name: 'flaky',
    title: 'Recoverable failures (example)',
    description:
        'The shared toolbox plus a tool that throws on two out of every three calls. The harness turns each error into a tool result, so the model can retry instead of the run dying. An example of the failure path, not a general-purpose agent.',
    requiresEndpoint: true,
    primary: 'flaky',
    subagents: [],
    agents: ['flaky'],
    tools: [...SHARED_TOOL_NAMES, 'testFlaky'],
    // R18: the factory below uses createToolboxHarness, which opts into webSearch
    // exactly like the live presets. Declaring it here keeps descriptor.tools and
    // descriptor.coreTools equal to what the session actually registers.
    environmentTools: ['webSearch'],
    builtin: true,
    editable: true,
    template: 'flaky',
    create: (settings: RunnerSettings, progress) =>
        createToolboxHarness(
            {
                agents: agentsFromProfiles(['flaky'], settings),
                primary: 'flaky',
                subagents: [],
                // The one preset-specific tool; excluded from the shared set.
                extraTools: { testFlaky: harnessTools.testFlaky }
            },
            settings,
            progress
        )
};

// UI/CLI order: the live choices first (instruct is the default/first card),
// then the offline fixture and the failure example. This is what stops the demo
// from dominating the initial UI now that it is not the headline preset.
export const presets: readonly HarnessPreset[] = [instruct, research, workspace, demo, failure];

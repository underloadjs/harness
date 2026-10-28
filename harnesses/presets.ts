// The harness catalogue.
//
// Every preset is a factory so a caller can attach its own provider settings and
// progress sink. The CLI calls one directly; the HTTP server keeps one harness per
// session and routes that session's events to its own stream.
//
// TWO KINDS OF PRESET
// -------------------
//   live  — instruct, research, workspace (and the flaky example). All built by
//           `createToolboxHarness` (./toolbox.ts), so they register the SAME
//           toolbox: package coding tools, the app tools, environment-backed
//           websearch, and the harness core tools. Only the agents differ:
//           instructions, primary, and subagents.
//   fixture — demo is a scripted offline run with clock only. It is retained so
//           the UI (and the service tests) can exercise the whole loop without a
//           provider; it is deliberately not a live harness and is listed last.
//
// The preset name is the harness's entry-agent name, because the registry key is
// the identity. That is why `instruct`, `research`, and `workspace` name their
// entry agents accordingly.
//
// Backward compatibility: `writer` and `assistant` are aliases of `instruct`,
// and `researcher` is an alias of `research` (see ./index.ts `findPreset`). They
// resolve to the canonical preset, so an old CLI invocation or bookmarked session
// request still runs; they are not listed a second time in the UI.
//
// Cross-references:
//   - ./toolbox.ts — the shared registry and `createToolboxHarness`
//   - ./types.ts   — HarnessPreset metadata (primary/subagents/tools)
//   - ../server/api.ts — descriptors resolved from this metadata

import { agent, harness } from '../src/harness';
import type { HarnessPreset, RunnerSettings } from './types';
import { harnessTools } from './tools';
import { scriptedDemo } from './demo';
import {
    PRESET_MAX_ITERATIONS,
    SHARED_TOOL_NAMES,
    createToolboxHarness,
    providerOf
} from './toolbox';

// Re-exported for callers that imported the app-wide tool-loop budget from here
// (the CLI and server tests did); the value now lives with the shared factory.
export { PRESET_MAX_ITERATIONS };

// ---------------------------------------------------------------------------
// Live harnesses: same toolbox, different agents
// ---------------------------------------------------------------------------

// The general-purpose choice and the first card in the UI. Its instruction is
// deliberately about *behaviour* (answer directly, use tools when they help),
// not about which capabilities exist: every capability is discoverable here.
const instruct: HarnessPreset = {
    name: 'instruct',
    title: 'Instruct',
    description:
        'A general instruction-following agent with the full toolbox. File, command, search, app, and web tools are all registered but searchable: call getTools with capability tags to enable what the task needs. The live presets differ only in their agents, not their tools.',
    requiresEndpoint: true,
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: SHARED_TOOL_NAMES,
    // Same environment-backed declaration as every live preset: a keyless host
    // simply does not append websearch to the descriptor (it stays listed as
    // unconfigured in the global tool catalogue).
    environmentTools: ['websearch'],
    create: (settings: RunnerSettings, progress) =>
        createToolboxHarness(
            {
                agents: {
                    instruct: agent({
                        model: settings.model,
                        instruction:
                            'You are the Instruct agent. Answer the request directly and keep the answer focused. The harness gives you a large catalogue but declares only the core tools at first: call getTools with capability tags to enable what you need, then use it. Tags are broad: ["files", "read"] to read, ["edit"] to change files, ["search"] to find content, ["glob"] to list paths, ["git"] to diff the working tree, ["shell"] to run a command, ["javascript"] or ["python"] to check syntax, ["time"], ["text"], ["random"], ["notes"], and ["web", "search"] for the internet when the host configured a search key. Prefer a tool over memory when it can answer more accurately, and say which tool you used. File and command tools execute on the server host with the server process permissions and are not sandboxed, so inspect before you change anything. If a small capability is missing, createTool can add one for this session. Be concise.',
                        provider: providerOf(settings)
                    })
                },
                primary: 'instruct',
                subagents: []
            },
            settings,
            progress
        )
};

// Research: the one live preset with a subagent. The shared toolbox is identical
// to Instruct's; the difference is the research instruction and the summarizer,
// which makes `delegate` (and the delegated half of `summarize`) available.
const research: HarnessPreset = {
    name: 'research',
    title: 'Research',
    description:
        'A research agent with the same full toolbox as every live harness, plus a summarizer subagent. `primary` and `subagents` are explicit: the research agent is the entry point and the only agent that may delegate, and delegation is one level deep. Web search joins the toolbox when the host configured a search key; without a key it stays visibly unconfigured in the tool catalogue.',
    requiresEndpoint: true,
    primary: 'research',
    subagents: ['summarizer'],
    agents: ['research', 'summarizer'],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['websearch'],
    create: (settings: RunnerSettings, progress) =>
        createToolboxHarness(
            {
                agents: {
                    research: agent({
                        model: settings.model,
                        instruction:
                            'You are the Research agent. Investigate before you answer, and separate what you found from what you inferred. Only the core tools are declared at first: call getTools with capability tags to enable what you need. Use ["web", "search"] when the host configured a search key and the question needs current or external facts — say so plainly when it is not configured instead of inventing sources. Use ["notes"] for the local corpus, ["files", "search"] for repository evidence, ["text"] to measure a draft, and ["summarize"] to compress collected notes. You may call delegate with agent "summarizer" for a self-contained brief; the subagent does not see this conversation, so include everything it needs. Finish with a direct answer and cite the tools (and URLs, when web search returned them) you relied on.',
                        provider: providerOf(settings)
                    }),
                    summarizer: agent({
                        model: settings.model,
                        instruction:
                            'You compress technical notes into at most two sentences. Keep names, numbers, and conclusions; drop preamble and repetition.',
                        provider: providerOf(settings)
                    })
                },
                primary: 'research',
                subagents: ['summarizer']
            },
            settings,
            progress
        )
};

// Workspace: the coding-focused live harness. Same toolbox as Instruct; the
// instruction is the part that makes it a coding agent, which is exactly the
// product rule ("the only difference is the agents configuration").
const workspace: HarnessPreset = {
    name: 'workspace',
    title: 'Workspace (coding)',
    description:
        'A coding agent with the full shared toolbox: read/write/edit files, search contents and globs, check syntax, diff the working tree, run commands, and web search when a key is configured. It has the same registered tools as every live harness and differs only in its instruction and single-agent routing. Everything runs on the server host; discovery still gates each tool.',
    requiresEndpoint: true,
    primary: 'workspace',
    subagents: [],
    agents: ['workspace'],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['websearch'],
    create: (settings: RunnerSettings, progress) =>
        createToolboxHarness(
            {
                agents: {
                    workspace: agent({
                        model: settings.model,
                        instruction:
                            'You are a workspace coding agent. The full toolbox is registered but searchable: call getTools with tags like ["files"], ["read"], ["edit"], ["search"], ["glob"], ["git"], ["shell"], ["javascript"], ["python"], ["web", "search"], ["time"], ["text"], or ["notes"] to enable what you need, then use it. The first call returns at most 10 best matches unless you pass a larger limit (maximum 50), so ask for the capability you actually need. Paths resolve against the workspace server process working directory, so start with listFiles(".") or globFiles("**/*") when you are unsure. Prefer reading before writing, use editFile rather than rewriting a whole file, and use gitDiff to review uncommitted changes. Use runCommand only for commands that inspect or build. Everything executes with this process\'s permissions and there is no sandbox, so keep changes deliberate. If a small capability is missing, createTool can add one for this session. Report what you changed and what you verified.',
                        provider: providerOf(settings)
                    })
                },
                primary: 'workspace',
                subagents: []
            },
            settings,
            progress
        )
};

// ---------------------------------------------------------------------------
// Examples and fixtures
// ---------------------------------------------------------------------------

// The offline demo is a scripted transport, not a live harness: it demonstrates
// the loop (reasoning, getTools discovery, one tool call, answer) with no
// endpoint. Its clock-only registry is intentional and pinned by its script, so
// it is exempt from the shared-toolbox rule. Kept for first-run exploration and
// for the service tests that need a real run without a provider.
const demo: HarnessPreset = {
    name: 'demo',
    title: 'Scripted demo',
    description:
        'Runs a scripted transport: a reasoning stream, a getTools discovery round, one tool call, and a final answer. No endpoint needed, so this is the fixture to try first. It is deliberately not a live harness: the toolbox rule applies to Instruct, Research, and Workspace.',
    requiresEndpoint: false,
    primary: 'demo',
    subagents: [],
    agents: ['demo'],
    tools: ['clock'],
    create: (settings, progress) =>
        harness({
            agents: {
                demo: agent({
                    model: settings.model.trim().length > 0 ? settings.model : 'scripted/demo',
                    instruction:
                        'You are the offline demo agent. The transport is scripted; nothing is sent to a model.',
                    stream: scriptedDemo()
                })
            },
            tools: { clock: harnessTools.clock },
            presets: false,
            // Explicit entry point, even with one agent: the documented style,
            // and it keeps the harness name independent of key order.
            primary: 'demo',
            report: { progress }
        })
};

// Recoverable failures is a live example, so it gets the shared toolbox too and
// adds `flaky` as an extra. `flaky` stays out of the shared table on purpose: it
// throws two calls out of three and keeps module-level attempt state, which must
// never be part of what Instruct/Research/Workspace can call.
const failure: HarnessPreset = {
    name: 'flaky',
    title: 'Recoverable failures (example)',
    description:
        'The shared toolbox plus a tool that throws on two out of every three calls. The harness turns each error into a tool result, so the model can retry instead of the run dying. An example of the failure path, not a general-purpose agent.',
    requiresEndpoint: true,
    primary: 'flaky',
    subagents: [],
    agents: ['flaky'],
    tools: [...SHARED_TOOL_NAMES, 'flaky'],
    create: (settings, progress) =>
        createToolboxHarness(
            {
                agents: {
                    flaky: agent({
                        model: settings.model,
                        instruction:
                            'You are testing tool reliability. Call getTools with tags like ["retry"] to enable the flaky tool, then call the flaky tool. If it fails, call it again with no arguments until it succeeds, then report the number of attempts. The other tools in the shared toolbox are available too, but this task only needs the flaky one.',
                        provider: providerOf(settings)
                    })
                },
                primary: 'flaky',
                subagents: [],
                // The one preset-specific tool; excluded from the shared set.
                extraTools: { flaky: harnessTools.flaky }
            },
            settings,
            progress
        )
};

// UI/CLI order: the live choices first (instruct is the default/first card),
// then the offline fixture and the failure example. This is what stops the demo
// from dominating the initial UI now that it is not the headline preset.
export const presets: readonly HarnessPreset[] = [instruct, research, workspace, demo, failure];

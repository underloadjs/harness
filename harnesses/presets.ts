// The harness catalogue.
//
// Every preset is a factory so a caller can attach its own provider settings and
// progress sink. The CLI calls one directly; the HTTP server keeps one harness per
// session and routes that session's events to its own stream.
//
// The preset name is the harness's entry-agent name, because the registry key is
// the identity — the same rule a consumer sees in `harness({ agents: { writer } })`.
//
// Every tool here is *searchable* (the default): the harness declares only
// getTools, the model asks for capability tags, and the matched tools appear on
// the next turn. That is the flow these presets exist to show.

import { agent, harness, presetTools } from '../src/harness';
import type { HarnessPreset, RunnerSettings } from './types';
import { harnessTools } from './tools';
import { scriptedDemo } from './demo';

const providerOf = (settings: RunnerSettings) => ({
    baseURL: settings.baseURL.trim(),
    // An empty key is omitted rather than sent as `Bearer `.
    apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey,
    sampling: { temperature: 0.3 }
});

const demo: HarnessPreset = {
    name: 'demo',
    title: 'Scripted demo',
    description:
        'Runs a scripted transport: a reasoning stream, a getTools discovery round, one tool call, and a final answer. No endpoint needed, so this is the preset to try first.',
    requiresEndpoint: false,
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

const writer: HarnessPreset = {
    name: 'writer',
    title: 'Writer',
    description: 'A single agent with no tools. The shortest path through the harness: one turn, one reply.',
    requiresEndpoint: true,
    agents: ['writer'],
    tools: [],
    create: (settings, progress) =>
        harness({
            agents: {
                writer: agent({
                    model: settings.model,
                    instruction: 'You are a concise writer. Answer in prose, in a few sentences. Do not use tools.',
                    provider: providerOf(settings)
                })
            },
            // No subagents: a single explicit primary, so no delegate tool exists.
            primary: 'writer',
            presets: false,
            report: { progress }
        })
};

const assistant: HarnessPreset = {
    name: 'assistant',
    title: 'Tool user',
    description:
        'One agent with three small tools, all searchable. getTools is the only tool declared at first; the others appear after the model asks for a capability.',
    requiresEndpoint: true,
    agents: ['assistant'],
    tools: ['clock', 'wordCount', 'roll'],
    create: (settings, progress) =>
        harness({
            agents: {
                assistant: agent({
                    model: settings.model,
                    instruction:
                        'You are a helpful assistant. Only getTools is declared at first: call it with capability tags (for example ["time"], ["text"], ["random"]) to enable the tools you need, then use them. Prefer tools over memory when they can answer more accurately. Keep answers brief and mention which tool you used.',
                    provider: providerOf(settings)
                })
            },
            tools: { clock: harnessTools.clock, wordCount: harnessTools.wordCount, roll: harnessTools.roll },
            // Single agent: explicit primary, and therefore no delegate tool.
            primary: 'assistant',
            presets: false,
            report: { progress }
        })
};

const researcher: HarnessPreset = {
    name: 'researcher',
    title: 'Researcher + summarizer',
    description:
        'Two agents and two searchable tools. `primary` and `subagents` are explicit: the researcher is the entry agent and the only one that may delegate, the summarizer keeps its own instruction and transcript, and the delegate tool is one level deep. The entry agent discovers tools with getTools, searches local notes, and hands the result to the summarizer.',
    requiresEndpoint: true,
    agents: ['researcher', 'summarizer'],
    tools: ['searchNotes', 'summarize'],
    create: (settings, progress) =>
        harness({
            agents: {
                researcher: agent({
                    model: settings.model,
                    instruction:
                        'You are a researcher. Only getTools is declared at first: call it with tags like ["search"] and ["summarize"] to enable searchNotes and summarize, then use them. Use searchNotes to look up facts about the harness, then call summarize with the notes you collected. You can also call delegate with agent "summarizer" for a self-contained brief; the subagent does not see this conversation, so include everything it needs. Finish by restating the summary in your own words.',
                    provider: providerOf(settings)
                }),
                summarizer: agent({
                    model: settings.model,
                    instruction: 'You compress technical notes into at most two sentences. No preamble.',
                    provider: providerOf(settings)
                })
            },
            // Explicit routing: the first key would already be the entry point and
            // the second already a default subagent, but naming both is the
            // documented way to make delegation a deliberate configuration. The
            // allowlist is enforced for the delegate tool (primary-only) and the
            // summarizer never receives it, so delegation cannot nest.
            primary: 'researcher',
            subagents: ['summarizer'],
            tools: { searchNotes: harnessTools.searchNotes, summarize: harnessTools.summarize },
            presets: false,
            report: { progress }
        })
};

const failure: HarnessPreset = {
    name: 'flaky',
    title: 'Recoverable failures',
    description:
        'A tool that throws on two out of every three calls. The harness turns each error into a tool result, so the model can retry instead of the run dying.',
    requiresEndpoint: true,
    agents: ['flaky'],
    tools: ['flaky'],
    create: (settings, progress) =>
        harness({
            agents: {
                flaky: agent({
                    model: settings.model,
                    instruction:
                        'You are testing tool reliability. Only getTools is declared at first: call it with tags like ["retry"] to enable the flaky tool, then call the flaky tool. If it fails, call it again with no arguments until it succeeds, then report the number of attempts.',
                    provider: providerOf(settings)
                })
            },
            tools: { flaky: harnessTools.flaky },
            // Single agent: explicit primary, and therefore no delegate tool.
            primary: 'flaky',
            presets: false,
            report: { progress }
        })
};

// The server-side coding harness. Unlike the browser playground this replaces,
// the preset catalogue really runs here: files are read, edited, and written on
// the server host, gitDiff inspects the working tree, and runCommand spawns with
// the server process's permissions. The harness preloads those presets by
// default; the model must still discover them, and createTool is available from
// the start so it can add a small missing capability for the session.
const workspace: HarnessPreset = {
    name: 'workspace',
    title: 'Workspace (host tools)',
    description:
        'The useful default for real work: read/write/edit files, search contents and globs, check syntax, diff the working tree, and run commands, all executed by the server process. Discovery still gates them: the model calls getTools before it can use anything. createTool is core, so the model can add a small session-local tool without a restart. No sandbox, nothing persisted.',
    requiresEndpoint: true,
    agents: ['workspace'],
    tools: Object.keys(presetTools),
    create: (settings, progress) =>
        harness({
            agents: {
                workspace: agent({
                    model: settings.model,
                    instruction:
                        'You are a workspace agent. The file and command tools are preloaded but searchable: call getTools with tags like ["files"], ["search"], ["glob"], ["edit"], ["git"], ["shell"], ["javascript"], or ["python"] to enable what you need, then use it. The first call returns at most 10 best matches unless you pass a larger limit (maximum 50), so ask for the capability you actually need. Paths resolve against the workspace server process working directory, so start with listFiles(".") or globFiles("**/*") when you are unsure. Prefer reading before writing, use editFile rather than rewriting a whole file, and use gitDiff to review uncommitted changes. Use runCommand only for commands that inspect or build. If a small capability is missing, createTool can add one for this session: the tool is compiled, not run, and it executes with this process\'s permissions, so keep it small and safe. Report what you changed and what you verified.',
                    provider: providerOf(settings)
                })
            },
            // Single-agent harness: naming the primary explicitly shows the entry
            // point without implying a subagent (there is none, so no delegate tool
            // is registered). Created tools live in this harness instance only.
            primary: 'workspace',
            report: { progress }
        })
};

export const presets: readonly HarnessPreset[] = [demo, writer, assistant, researcher, failure, workspace];

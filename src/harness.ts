// harness() — the execution loop.
//
// One call builds a callable writer:
//
//     const writer = harness({
//         agents: { writer: agent({ model, provider }) },
//         tools: { websearch: tool({ ... }) },
//         report: { progress: async (event) => console.log(event) }
//     });
//
//     await writer('tell me about new year');
//
// Calling the harness runs the entry agent until it answers with text. Along the
// way it executes every tool the model asks for, feeds the results back, and
// re-requests — the loop a caller would otherwise write by hand against
// `agent.turn()`.
//
// Loop shape, per call:
//
//     append user input
//     repeat:
//         turn()                      -> assistant message (+ tool calls)
//         no tool calls?              -> report done, return the message
//         for each call:              -> execute, append a tool message
//         (loop again)
//
// Termination:
//   - the model answers with text (normal);
//   - an unknown tool, malformed arguments, or a throwing tool becomes a tool
//     result the model can read and recover from — it does not end the run;
//   - exceeding MAX_ITERATIONS, or a transport failure, ends the run: history is
//     truncated back to where the call started and the harness throws.
//
// Cross-references:
//   - core/agent  — the brain being driven (turn())
//   - core/tool   — what gets executed
//   - types       — Harness, HarnessEvent, HarnessConfiguration
//
// This is the only source file at the root of src/. Everything else lives in a
// role folder with its own barrel, and the public surface is re-exported at the
// bottom of this file.

import { HarnessError, toErrorInfo } from './util';
import { agent as createAgent, tool as createTool, toolParameterKey } from './core';
import { runPlugins } from './plugin';
import type {
    Agent,
    Harness,
    HarnessAssistantMessage,
    HarnessConfiguration,
    HarnessEvent,
    HarnessProgress,
    HarnessRunOptions,
    HarnessStreamTool,
    HarnessToolCall,
    Tool,
    ToolContext
} from './types';

// Hard stop for a model that keeps requesting tools forever. This is a guard,
// not a policy knob: a runaway loop must not be able to run a CLI process out of
// money or stack.
const MAX_ITERATIONS = 16;

// Tool results are text on the wire. Strings pass through untouched so a tool
// can return prose; everything else is JSON.
const serialize = (value: unknown): string => {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? String(value);
};

// Apply the single-property rule (see core/tool.ts): when a tool's schema
// declares exactly one property, the implementation receives that property's
// value rather than an object wrapping it. This is what keeps a direct call
// (`pythonSyntax('print(1)')`) and a model call
// (`python_syntax({ "code": "print(1)" })`) identical inside `execute`.
const unwrapParameters = (definition: Tool, parsed: Record<string, unknown>): unknown => {
    const key = toolParameterKey(definition.parameters);
    if (key === undefined) return parsed;
    return parsed[key];
};

export const harness = (configuration: HarnessConfiguration): Harness => {
    const agentNames = Object.keys(configuration.agents ?? {});
    if (agentNames.length === 0) {
        throw new HarnessError('A harness requires at least one agent.');
    }

    // Build the agent registry. The registry key is the identity: it names the
    // agent in progress events and is what `run(name, input)` addresses. The
    // agent's own `name` is overwritten so the two can never disagree.
    const agents: Record<string, Agent> = {};
    for (const [name, brain] of Object.entries(configuration.agents)) {
        if (!brain || typeof brain.turn !== 'function') {
            throw new HarnessError(`Agent "${name}" is not an agent: create it with agent({...}).`);
        }

        brain.name = name;
        agents[name] = brain;
    }

    // The first entry is the entry point. With one agent the config reads
    // naturally; with several, ordering is the routing decision and is
    // documented rather than hidden behind an extra field.
    const primary = agents[agentNames[0]];

    // Build the tool registry, same rule: the key is the wire name.
    const tools: Record<string, Tool> = {};
    for (const [name, definition] of Object.entries(configuration.tools ?? {})) {
        if (!definition || typeof definition.execute !== 'function') {
            throw new HarnessError(`Tool "${name}" is not a tool: create it with tool({...}).`);
        }

        definition.name = name;
        tools[name] = definition;
    }

    // Progress reporting is awaited for every step, so a UI can pace the run.
    const progress: HarnessProgress = async (event: HarnessEvent) => {
        await configuration.report?.progress?.(event);
    };

    // Declarations handed to every request. Rebuilt per run so a plugin that
    // registers tools mid-flight is picked up on the next call.
    const declarations = (): HarnessStreamTool[] =>
        Object.values(tools).map(({ name, description, parameters }) => ({ name, description, parameters }));

    // Append the model-facing result of one tool call. The assistant message that
    // requested it is already in history (agent.turn() committed it).
    const appendToolResult = (brain: Agent, call: HarnessToolCall, content: string): void => {
        brain.messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });
    };

    // Execute one tool call and report it. Every failure mode is converted into a
    // tool result the model can read, so one bad call cannot end the run.
    const executeToolCall = async (brain: Agent, call: HarnessToolCall): Promise<void> => {
        await progress({ type: 'tool_call', agent: brain.name, call });

        const fail = async (content: string): Promise<void> => {
            appendToolResult(brain, call, content);
            await progress({ type: 'tool_result', agent: brain.name, name: call.name, content, isError: true });
        };

        const definition = tools[call.name];

        // Unknown tool: still answer the call so the transcript stays valid for
        // strict providers, and so the model can correct itself.
        if (!definition) {
            await fail(`Tool "${call.name}" is not registered. Available tools: ${Object.keys(tools).join(', ') || 'none'}.`);
            return;
        }

        // Malformed arguments never reach the implementation.
        let parameters: unknown;
        try {
            const parsed: Record<string, unknown> =
                call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {};
            parameters = unwrapParameters(definition, parsed);
        } catch (error) {
            await fail(`Tool "${call.name}" received malformed JSON arguments: ${toErrorInfo(error).message}`);
            return;
        }

        const context: ToolContext = {
            parameters,
            agent: brain,
            agents,
            run: (agentName: string, input: string) => {
                const target = agents[agentName];
                if (!target) {
                    throw new HarnessError(`Agent "${agentName}" is not registered.`);
                }
                return runAgent(target, input);
            }
        };

        try {
            const result = await definition.execute(context);
            const content = serialize(result);
            appendToolResult(brain, call, content);
            await progress({ type: 'tool_result', agent: brain.name, name: call.name, content, isError: false });
        } catch (error) {
            await fail(`Tool "${call.name}" failed: ${toErrorInfo(error).message}`);
        }
    };

    // Run one agent to completion. This is the loop the harness exists for.
    const runAgent = async (
        brain: Agent,
        input: string,
        options?: HarnessRunOptions
    ): Promise<HarnessAssistantMessage> => {
        // Everything past this index belongs to this run. A failure truncates
        // back to it, so a failed call is never replayed on the next attempt.
        const commitIndex = brain.messages.length;

        await progress({ type: 'start', agent: brain.name, model: brain.model() });
        brain.user(input);

        try {
            for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
                let message: HarnessAssistantMessage | undefined;

                for await (const event of brain.turn({ signal: options?.signal, tools: declarations() })) {
                    switch (event.type) {
                        case 'text':
                            await progress({ type: 'text', agent: brain.name, delta: event.delta });
                            break;

                        case 'reasoning':
                            await progress({ type: 'reasoning', agent: brain.name, delta: event.delta });
                            break;

                        case 'done':
                            message = event.message;
                            break;

                        case 'error':
                            throw new HarnessError(event.error.message);
                    }
                }

                if (!message) {
                    throw new HarnessError(`Agent "${brain.name}" ended without producing a message.`);
                }

                // The model answered with text: the run is done.
                if (message.toolCalls.length === 0) {
                    await progress({ type: 'done', agent: brain.name, message });
                    return message;
                }

                // Otherwise run every requested tool, then re-request.
                for (const call of message.toolCalls) {
                    await executeToolCall(brain, call);
                }
            }

            throw new HarnessError(
                `Agent "${brain.name}" requested tools more than ${MAX_ITERATIONS} times without answering.`
            );
        } catch (error) {
            brain.messages.splice(commitIndex);

            const info = toErrorInfo(error);
            await progress({ type: 'error', agent: brain.name, error: info });

            throw error instanceof HarnessError ? error : new HarnessError(info.message, { cause: error });
        }
    };

    // Apply plugins before returning so the handle is complete and consistent.
    const pluginNames = runPlugins(configuration.plugins ?? [], {
        agents,
        tools,
        createAgent: (name, agentConfiguration) => {
            if (agents[name]) {
                throw new HarnessError(`Agent "${name}" is already registered.`);
            }
            const brain = createAgent({ ...agentConfiguration, name });
            agents[name] = brain;
            return brain;
        },
        addTool: (name, toolConfiguration) => {
            if (tools[name]) {
                throw new HarnessError(`Tool "${name}" is already registered.`);
            }
            const definition = createTool({ ...toolConfiguration, name });
            tools[name] = definition;
            return definition;
        }
    });

    // The harness is a function you call. Properties ride on it so a CLI has
    // everything in one handle without a second lookup object.
    const run = (input: string, options?: HarnessRunOptions) => runAgent(primary, input, options);

    const handle = Object.assign(run, {
        agent: primary,
        agents,
        tools,
        plugins: pluginNames,
        reset: () => primary.reset()
    }) as Harness;

    // `name` is a built-in, read-only property of every function, so it must be
    // defined rather than assigned. The entry agent's name is the harness name.
    Object.defineProperty(handle, 'name', {
        value: primary.name,
        enumerable: true,
        configurable: true
    });

    return handle;
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
//
// src/ holds only this file. Everything else is barrelled from its role folder,
// and re-exported here so the package has one entry point:
//
//   core       agent, tool             — usable without a harness
//   transport  openAICompatible        — the default wire protocol
//   tools      the preset tools        — executable on their own
//   util       HarnessError            — the error type
//   types      every public type
//
// Internal folders import each other directly, so a barrel is never load-bearing
// for the runtime wiring — it only defines what consumers can reach.
export { agent, tool } from './core';
export { openAICompatible } from './transport';
export { javascriptSyntax, pythonSyntax, readFile, writeFile, listFiles, runCommand } from './tools';
export type { WriteFileResult, RunCommandResult } from './tools';
export { HarnessError } from './util';
export type * from './types';

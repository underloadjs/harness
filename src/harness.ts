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
//   - an unknown tool, an undiscovered tool, malformed arguments, or a throwing
//     tool becomes a tool result the model can read and recover from — it does
//     not end the run;
//   - exceeding MAX_ITERATIONS, or a transport failure, ends the run: history is
//     truncated back to where the call started and the harness throws.
//
// Tool visibility:
//
// A registry can hold thousands of tools, so a request declares only:
//   - every `visibility: 'core'` tool, and
//   - every searchable tool that getTools has enabled so far.
//
// getTools is itself core and is always registered here. It ranks the catalogue
// against the tags the model passes (core/discovery), enables the best matches,
// and the next request declares them. Ranking is OR-style — a tool needs only one
// query tag to be a candidate, and its rank is its best single-tag score — so the
// order is deterministic and a broad tool cannot outrank an exact tag hit.
// Matches are capped at 10 by default (the model may pass `limit`, hard maximum
// 50) because a query that matches a whole family must not re-flood the context.
// Undiscovered tools are not callable, so the model cannot skip discovery by
// guessing a name.
//
// Three harness-owned names sit outside that scheme:
//   - getTools    — discovery, described above.     (every agent, core)
//   - createTool  — compile-and-register a tool.    (every agent, core)
//   - delegate    — hand a task to a subagent.      (primary agent only, core)
//
// createTool is the R2b capability: the model can author a JavaScript tool body
// mid-conversation, and the tool is registered searchable and enabled at once. The
// source is compiled but never executed at registration. There is NO sandbox: a
// created tool runs with this process's permissions, the same trust model as the
// runCommand preset. See core/creation.ts for the validated bounds.
//
// delegate is bounded delegation (R4): `primary` selects the entry agent, and
// `subagents` is the allowlist the primary may delegate to. The tool is not
// declared to subagents (and a guessed call is rejected), so delegation is one
// level deep; re-entering an already-running agent is rejected by runAgent, which
// also closes ctx.run cycles.
//
// The bundled preset catalogue (./tools) is preloaded into the registry by
// default — all of it searchable — so a new harness can discover readFile,
// runCommand, … without the caller importing anything. `presets: false` opts out.
//
// Cross-references:
//   - core/agent     — the brain being driven (turn())
//   - core/tool      — what gets executed, and where tags/visibility live
//   - core/discovery — the tag ranking behind getTools
//   - core/creation  — compile-and-register behind createTool
//   - types          — Harness, HarnessEvent, HarnessConfiguration
//
// This is the only source file at the root of src/. Everything else lives in a
// role folder with its own barrel, and the public surface is re-exported at the
// bottom of this file.

import { HarnessError, toErrorInfo } from './util';
import {
    agent as createAgent,
    tool as defineTool,
    searchTools,
    toolParameterKey,
    createDynamicTool
} from './core';
import { presetTools } from './tools';
import { runPlugins } from './plugin';
import type {
    Agent,
    Harness,
    HarnessAssistantMessage,
    HarnessConfiguration,
    HarnessDelegationResult,
    HarnessEvent,
    HarnessProgress,
    HarnessRunOptions,
    HarnessStreamTool,
    HarnessToolCall,
    Tool,
    ToolContext,
    ToolCreation,
    ToolCreationResult,
    ToolSearchResult
} from './types';

// Hard stop for a model that keeps requesting tools forever. This is a guard,
// not a policy knob: a runaway loop must not be able to run a CLI process out of
// money or stack.
const MAX_ITERATIONS = 16;

// The discovery entry point. The harness owns this name: the whole visibility
// scheme depends on there being exactly one tool that can enable the rest.
const GET_TOOLS = 'getTools';

// Runtime tool creation (R2b) and bounded delegation (R4). Both are model-facing
// core tools, so their wire names are part of the harness contract.
const CREATE_TOOL = 'createTool';
const DELEGATE = 'delegate';

// Names no configured, preset, plugin, or model-created tool may take. Keeping
// the whole list in one place is what makes the reservation check exhaustive.
const RESERVED_TOOL_NAMES = [GET_TOOLS, CREATE_TOOL, DELEGATE] as const;

// Budget for createTool: registration is cheap but not free, and an unbounded
// registry defeats the point of discovery. Session-local (no filesystem writes),
// reset with the harness object, counted per harness.
const MAX_CREATED_TOOLS = 32;

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

    // The entry point. `primary` names it explicitly; without one the first key
    // wins, so a single-agent or naturally ordered config needs no extra field.
    // An unknown name is a configuration bug, not a runtime surprise, so it fails
    // here rather than at the first prompt.
    const primaryName = configuration.primary ?? agentNames[0];

    if (!Object.prototype.hasOwnProperty.call(configuration.agents, primaryName)) {
        throw new HarnessError(
            `Primary agent "${primaryName}" is not registered. Configured agents: ${agentNames.join(', ')}.`
        );
    }

    const primary = agents[primaryName];

    // Resolve the delegation allowlist once, at construction. `agents` order is no
    // longer the routing decision when one is given explicitly.
    const subagentNames = ((): string[] => {
        const requested = configuration.subagents;

        // Default: every agent except the primary. A one-agent harness therefore
        // has no subagents and gets no delegate tool at all.
        if (requested === undefined) return agentNames.filter((name) => name !== primaryName);

        const resolved: string[] = [];

        for (const name of requested) {
            if (name === primaryName) {
                throw new HarnessError(
                    `Subagent "${name}" is the primary agent "${primaryName}"; the primary cannot delegate to itself.`
                );
            }

            if (!Object.prototype.hasOwnProperty.call(agents, name)) {
                throw new HarnessError(
                    `Subagent "${name}" is not registered. Configured agents: ${agentNames.join(', ')}.`
                );
            }

            // Deduplicate so the allowlist is also the exact tool description.
            if (!resolved.includes(name)) resolved.push(name);
        }

        return resolved;
    })();

    // The allowlisted agents, exposed on the handle so a host can inspect who the
    // primary is allowed to reach.
    const subagents: Record<string, Agent> = {};
    for (const name of subagentNames) subagents[name] = agents[name];

    // Build the tool registry, same rule: the key is the wire name. The bundled
    // preset catalogue is preloaded by default, so a new harness can discover
    // readFile/runCommand/... without the caller importing them. It is all
    // searchable, so preloading costs no context until something is discovered.
    // `presets: false` starts from the configured tools only, and a configured
    // tool of the same name replaces the preset.
    const tools: Record<string, Tool> = configuration.presets === false ? {} : { ...presetTools };

    for (const [name, definition] of Object.entries(configuration.tools ?? {})) {
        if (!definition || typeof definition.execute !== 'function') {
            throw new HarnessError(`Tool "${name}" is not a tool: create it with tool({...}).`);
        }

        definition.name = name;
        tools[name] = definition;
    }

    // The harness owns its core names. Checked after presets and configured tools
    // so a collision is reported once, up front, in the same place as getTools
    // always was. Model-created tools are checked separately (they arrive later,
    // see createToolFrom).
    for (const reserved of RESERVED_TOOL_NAMES) {
        if (tools[reserved]) {
            throw new HarnessError(`Tool "${reserved}" is reserved by the harness.`);
        }
    }

    // Progress reporting is awaited for every step, so a UI can pace the run.
    const progress: HarnessProgress = async (event: HarnessEvent) => {
        await configuration.report?.progress?.(event);
    };

    // Tools getTools has enabled, in discovery order. Searchable tools stay in the
    // registry but are not declared — and not callable — until they land here.
    // The set is per harness, so a discovered tool stays available for the rest of
    // the conversation.
    const activeTools = new Set<string>();

    const enableTools = (names: readonly string[]): void => {
        for (const name of names) {
            if (tools[name]) activeTools.add(name);
        }
    };

    // getTools is the one discovery tool every harness provides. It is core, so
    // the model can always reach it, and its result both explains the matches and
    // enables them for the next turn.
    //
    // Two schema properties, so the single-property rule does not apply and
    // `parameters` arrives as an object. `limit` is optional; the cap itself lives
    // in core/discovery.ts (default 10, hard maximum 50).
    tools[GET_TOOLS] = defineTool<{ tags: string[]; limit?: number }, ToolSearchResult>({
        name: GET_TOOLS,
        description:
            'Find tools by capability tag and enable them. Only a few core tools are visible at first because the catalogue is large: pass the tags you need (for example ["files", "read"]) and the closest matches become available on your next turn. Call this before concluding that something cannot be done.',
        tags: ['discovery', 'tools', 'catalogue'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Capability tags to look for, e.g. ["files", "read", "shell"].'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    description: 'How many matches to enable. Defaults to 10; maximum 50.'
                }
            },
            required: ['tags'],
            additionalProperties: false
        },
        execute: ({ parameters }) => {
            // Tolerate a bare array (a model ignoring the schema) and a missing
            // `tags`, so a sloppy call still gets the catalogue vocabulary back.
            const query = Array.isArray(parameters)
                ? parameters
                : Array.isArray(parameters?.tags)
                  ? parameters.tags
                  : [];
            const limit = Array.isArray(parameters) ? undefined : parameters?.limit;

            const result = searchTools(Object.values(tools), query, limit);
            enableTools(result.enabled);

            return result;
        }
    });

    // Runtime creation (R2b). One registration path serves the model-facing
    // createTool tool and the host-facing harness.createTool(), so the two can
    // never drift on validation, budget, or discovery behaviour.
    //
    // Session-local by design: a created tool lives in this harness's registry
    // only. Nothing is written to disk, so two harnesses cannot see each other's
    // tools and a process restart starts clean.
    let createdTools = 0;

    const createToolFrom = (configuration: ToolCreation): Tool => {
        if (createdTools >= MAX_CREATED_TOOLS) {
            throw new HarnessError(
                `This harness already created ${MAX_CREATED_TOOLS} tools; reuse an existing tool instead of creating more.`
            );
        }

        // Shape validation, reserved-name rejection, and compilation. Compiling
        // does NOT execute the body — see core/creation.ts.
        const definition = createDynamicTool(configuration, { reserved: RESERVED_TOOL_NAMES });

        // Compare case-insensitively: "readfile" beside a preset "readFile" would
        // make the catalogue ambiguous for the model even though the keys differ.
        // (Reserved names were already rejected above, in the same comparison.)
        const collision = Object.keys(tools).find(
            (name) => name.toLowerCase() === definition.name.toLowerCase()
        );

        if (collision) {
            throw new HarnessError(`Tool "${collision}" is already registered; choose another name.`);
        }

        tools[definition.name] = definition;
        createdTools++;

        // Registered searchable AND enabled immediately: the model just asked for
        // this tool, so making it spend a getTools round trip to call it would be
        // wasteful. It stays in the searchable catalogue, so it remains
        // discoverable (and a reset() only clears the enabled set).
        activeTools.add(definition.name);

        return definition;
    };

    tools[CREATE_TOOL] = defineTool<ToolCreation, ToolCreationResult>({
        name: CREATE_TOOL,
        description:
            "Create a tool for yourself from JavaScript source. `source` is the BODY of an async function, for example `return args.toUpperCase();`: it receives `args` (the call arguments; a one-property schema passes the value itself) and `context` (agent, agents, run). Registering validates and compiles the source and enables the tool for your next turn, without running it. The body runs with this process's full permissions - there is no sandbox - so only create tools you are willing to run, and keep them small.",
        tags: ['tools', 'create', 'extension', 'dynamic'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Wire name: a letter first, then letters, digits, "_" or "-", at most 64 characters.'
                },
                description: { type: 'string', description: 'What the tool does, shown to getTools and the model.' },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Capability tags, e.g. ["text", "upper"]. Required so getTools can find it.'
                },
                parameters: { type: 'object', description: "Optional JSON Schema for the new tool's arguments." },
                source: {
                    type: 'string',
                    description: 'Async function body, e.g. "return args.trim().toUpperCase();".'
                }
            },
            required: ['name', 'description', 'tags', 'source'],
            additionalProperties: false
        },
        execute: ({ parameters }) => {
            // Throwing is the error path the harness turns into a readable tool
            // result: invalid name, reserved name, collision, budget, or a body
            // that does not parse.
            const definition = createToolFrom(parameters);

            const result: ToolCreationResult = {
                name: definition.name,
                description: definition.description,
                tags: [...definition.tags],
                enabled: true
            };

            if (definition.parameters) result.parameters = definition.parameters;

            return result;
        }
    });

    // Bounded delegation (R4). Registered only when there is somewhere to
    // delegate: a tool that can only fail would cost context on every request.
    // Subagents never receive it (see declared()), and executeToolCall rejects a
    // guessed call, so delegation is exactly one level deep. runAgent rejects
    // re-entering an agent that is already running, which closes the ctx.run
    // cycle as well.
    if (subagentNames.length > 0) {
        tools[DELEGATE] = defineTool<{ agent: string; input: string }, HarnessDelegationResult>({
            name: DELEGATE,
            description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${subagentNames.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.`,
            tags: ['agents', 'delegate', 'subagent', 'team'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    agent: {
                        type: 'string',
                        enum: [...subagentNames],
                        description: 'Subagent name, one of the configured allowlist.'
                    },
                    input: { type: 'string', description: 'The full brief the subagent should act on.' }
                },
                required: ['agent', 'input'],
                additionalProperties: false
            },
            execute: async ({ agent: caller, run, parameters }) => {
                // Defence in depth: the tool is not declared to subagents, but a
                // model can guess a name, so the caller is checked here too.
                if (caller !== primary) {
                    throw new HarnessError(
                        `Only the primary agent "${primaryName}" can delegate; "${caller?.name ?? 'a host'}" cannot.`
                    );
                }

                // Delegation is a top-level capability. A primary reached as a
                // subagent of another run must not recurse outward.
                if (runStack.length > 1) {
                    throw new HarnessError(
                        'Delegation is only available from the primary agent\'s own run, not from inside another agent.'
                    );
                }

                // Two schema properties, so `parameters` is the parsed arguments
                // object (the single-property rule does not apply).
                const target = parameters?.agent;

                if (typeof target !== 'string' || !subagentNames.includes(target)) {
                    throw new HarnessError(
                        `Agent "${String(target)}" is not a configured subagent. Allowed: ${subagentNames.join(', ')}.`
                    );
                }

                if (typeof parameters?.input !== 'string' || parameters.input.trim().length === 0) {
                    throw new HarnessError('Delegation requires a non-empty input.');
                }

                if (!run) {
                    throw new HarnessError('Delegation requires a harness run context.');
                }

                const message = await run(target, parameters.input);

                // Only the answer crosses back: the subagent keeps its own
                // transcript and instructions.
                return { agent: target, content: message.content };
            }
        });
    }

    // The tools a request may declare: the core set first, then everything
    // discovered so far. Everything else stays out of the context window on
    // purpose.
    //
    // `delegate` is core for the primary only: it is skipped for every other
    // agent, so a subagent cannot even see the delegation control.
    const declared = (brain: Agent): Tool[] => {
        const core: Tool[] = [];
        const discovered: Tool[] = [];

        for (const definition of Object.values(tools)) {
            if (definition.visibility === 'core') {
                if (definition.name === DELEGATE && brain !== primary) continue;
                core.push(definition);
            } else if (activeTools.has(definition.name)) {
                discovered.push(definition);
            }
        }

        return [...core, ...discovered];
    };

    // Declarations handed to every request. Rebuilt per run so a plugin that
    // registers tools mid-flight is picked up on the next call, and so a getTools
    // round shows up in the very next request. Per-brain because `delegate` is a
    // primary-only declaration.
    const declarations = (brain: Agent): HarnessStreamTool[] =>
        declared(brain).map(({ name, description, parameters }) => ({ name, description, parameters }));

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
        // strict providers, and so the model can correct itself — pointing it at
        // discovery, since the catalogue is not declared.
        if (!definition) {
            const available = declared(brain).map((tool) => tool.name).join(', ') || 'none';
            await fail(
                `Tool "${call.name}" is not registered. Available tools: ${available}. Call ${GET_TOOLS} with capability tags to search the catalogue.`
            );
            return;
        }

        // Delegation is primary-only. `delegate` is core, so the visibility check
        // below would let it through; a subagent that guesses the name is stopped
        // here, in addition to never seeing it declared.
        if (call.name === DELEGATE && brain !== primary) {
            await fail(`Tool "${DELEGATE}" is only available to the primary agent "${primaryName}".`);
            return;
        }

        // A searchable tool the model has not discovered is not callable, even when
        // it guesses the name: being declared is what makes a tool available, and
        // getTools is how a tool gets declared.
        if (definition.visibility !== 'core' && !activeTools.has(call.name)) {
            const tags = definition.tags.slice(0, 3).map((tag) => `"${tag}"`).join(', ');
            await fail(
                `Tool "${call.name}" is registered but not enabled yet. Call ${GET_TOOLS} with tags like ${tags} to enable it.`
            );
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
    //
    // Renamed from runAgent: the guarded entry point is the wrapper below, so
    // every path (harness call, ctx.run, delegate) shares one recursion check.
    const runAgentCore = async (
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

                for await (const event of brain.turn({ signal: options?.signal, tools: declarations(brain) })) {
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

    // Agents currently executing, outermost first. Two jobs:
    //   - refuse to re-enter a running agent (self-delegation, the primary reached
    //     from inside a subagent, a ctx.run cycle). That can never produce an
    //     answer, only a stack;
    //   - let the delegate tool prove it runs at the top level, so delegation
    //     cannot nest.
    const runStack: Agent[] = [];

    // The one entry point every path uses: the harness call, ctx.run, and
    // delegate. The guard is here rather than in the delegate tool so a cycle
    // cannot be opened through the general tool context either.
    const runAgent = async (
        brain: Agent,
        input: string,
        options?: HarnessRunOptions
    ): Promise<HarnessAssistantMessage> => {
        if (runStack.includes(brain)) {
            throw new HarnessError(
                `Agent "${brain.name}" is already running; it cannot be re-entered (delegation cycle).`
            );
        }

        runStack.push(brain);

        try {
            return await runAgentCore(brain, input, options);
        } finally {
            // Pop in a finally so a failed or aborted run leaves the stack clean
            // for the next call.
            runStack.pop();
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
            // The harness-owned names stay owned, even when delegate was not
            // registered (no subagents): a plugin must not claim a reserved name
            // that would later shadow the harness contract.
            if ((RESERVED_TOOL_NAMES as readonly string[]).includes(name)) {
                throw new HarnessError(`Tool "${name}" is reserved by the harness.`);
            }
            if (tools[name]) {
                throw new HarnessError(`Tool "${name}" is already registered.`);
            }
            const definition = defineTool({ ...toolConfiguration, name });
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
        subagents,
        tools,
        plugins: pluginNames,
        // Host-side runtime creation: the same path the model's createTool tool
        // uses, so validation, budget, collision rules, and immediate enablement
        // are identical. Throws HarnessError, unlike the model path which turns
        // the failure into a tool result.
        createTool: createToolFrom,
        // reset() is "start over": the conversation goes back to the seeded
        // instructions, and tool discovery is forgotten with it, so the next run
        // begins from the core set again. Tools created at runtime stay in the
        // catalogue (they are registry state, not conversation state); they are
        // simply no longer enabled until discovered again.
        reset: () => {
            primary.reset();
            activeTools.clear();
        }
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
//   core       agent, tool, searchTools, createDynamicTool — usable without a harness
//   transport  openAICompatible, listModels, ModelListError — wire + catalogue
//   tools      the preset tools        — executable on their own
//   util       HarnessError            — the error type
//   types      every public type
//
// Internal folders import each other directly, so a barrel is never load-bearing
// for the runtime wiring — it only defines what consumers can reach.
//
// The tool re-exports are lazy proxies (see tools/lazy.ts): naming them here does
// not import a single implementation, so `import { harness } from '@underload/harness'`
// costs no `node:fs`/`child_process`/`vm` load. The result types are exported
// alongside each tool so a consumer can type a direct call without reaching into
// an internal path.
export { agent, tool, searchTools, compileToolSource, createDynamicTool } from './core';
export { openAICompatible, listModels, ModelListError } from './transport';
export type { ModelListConfiguration, ModelListErrorKind } from './transport';
export {
    javascriptSyntax,
    pythonSyntax,
    readFile,
    writeFile,
    editFile,
    listFiles,
    searchFiles,
    globFiles,
    runCommand,
    gitDiff,
    presetTools
} from './tools';
export type {
    WriteFileResult,
    EditFileParameters,
    EditFileResult,
    SearchFilesMatch,
    SearchFilesParameters,
    SearchFilesResult,
    GlobFilesParameters,
    GlobFilesResult,
    GitDiffParameters,
    GitDiffResult,
    RunCommandResult
} from './tools';
export { HarnessError } from './util';
export type * from './types';

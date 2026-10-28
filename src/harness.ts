// harness() — the execution loop.
//
// One call builds a callable writer:
//
//     const writer = harness({
//         agents: { writer: agent({ model, provider }) },
//         tools: { webSearch: tool({ ... }) },
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
//         usage?                      -> report what that request spent
//         no tool calls?              -> report done, return the message
//         for each call:              -> execute, append a tool message
//         (loop again)
//
// Termination:
//   - the model answers with text (normal);
//   - an unknown tool, an undiscovered tool, malformed arguments, or a throwing
//     tool becomes a tool result the model can read and recover from — it does
//     not end the run;
//   - exceeding the configured tool-loop limit (`maxIterations`, default
//     DEFAULT_MAX_ITERATIONS), or a transport failure, ends the run: history is
//     truncated back to where the call started and the harness throws.
//
// Tool visibility:
//
// A registry can hold thousands of tools, so a request declares only:
//   - every `visibility: 'core'` tool, and
//   - every searchable tool that toolRequest has enabled so far.
//
// Core vs searchable (R18): the everyday file tools (fileRead, fileWrite,
// fileEdit, fileGlob) carry `visibility: 'core'` in the preset catalogue, and a
// configured webSearch is core too, so they are declared up front. The rest of the
// preset catalogue — fileList, syntaxCheck, commandRun, gitDiff, the app tools —
// stays searchable. "core" is only a declaration classification: it does NOT make
// the tool session-bound. The harness-owned tools below are the session-bound set,
// and the server gates only those on a sessionId.
//
// toolRequest is itself core and is always registered here. It ranks the catalogue
// against the tags the model passes (core/discovery), enables the best matches,
// and the next request declares them. Ranking is OR-style — a tool needs only one
// query tag to be a candidate, and its rank is its best single-tag score — so the
// order is deterministic and a broad tool cannot outrank an exact tag hit.
// Matches are capped at MAX_DISCOVERY_MATCHES (5) per request (R7): the model may
// pass a SMALLER `limit`, never a larger one, and the result reports `remaining`
// — the count of additional tools that matched but were not listed — so the model
// refines its tags to drill deeper instead of paging through names. Undiscovered
// tools are not callable, so the model cannot skip discovery by guessing a name.
// The enabled set is per harness and survives across calls (turns), so a
// capability discovered once stays declared until reset().
//
// Harness-owned names sit outside that scheme:
//   - toolRequest  — discovery, described above.     (every agent, core)
//   - toolCreate   — compile-and-register a tool.    (every agent, core)
//   - todoManage   — the session todo list.          (every agent, core)
//   - profileManage — session character profiles.    (every agent, core)
//   - chapterManage — session chapter tracking.      (every agent, core)
//   - locationManage — session places/settings.      (every agent, core)
//   - agentDelegate — hand a task to a subagent.     (primary agent only, core)
//
// toolCreate is the R2b capability: the model can author a JavaScript tool body
// mid-conversation, and the tool is registered searchable and enabled at once. The
// source is compiled but never executed at registration. There is NO sandbox: a
// created tool runs with this process's permissions, the same trust model as the
// commandRun preset. See core/creation.ts for the validated bounds.
//
// Manual execution (R8): `harness.executeTool(name, parameters)` runs one
// REGISTERED tool directly, with this harness's context. It is the host/server path
// behind the UI's Tools tab (server/sessions.ts → executeTool), so a manual
// toolRequest/toolCreate/todoManage/agentDelegate call changes this session rather
// than a detached copy. Core file tools (R18) also run here, exactly like a direct
// call; only the harness-owned set needs session state. Discovery gates the model
// only: an explicit user call may run a searchable tool that was never enabled.
// Everything else still applies —
// toolCreate keeps its guarded registration, agentDelegate keeps its primary-only
// check, and a tool this harness did not register (agentDelegate without subagents)
// is an honest error, never a fabricated implementation.
//
// todoManage is session state, not catalogue state: a fresh list is created for
// each harness() call, shared by every agent in that harness, and cleared by
// reset() with the conversation. That is why it is built by a factory closure
// (core/todo.ts) rather than registered as a module singleton. profileManage,
// chapterManage, and locationManage follow the same pattern with their own
// closures (core/profile.ts, chapter.ts, location.ts).
//
// agentDelegate is bounded delegation (R4): `primary` selects the entry agent, and
// `subagents` is the allowlist the primary may delegate to. The tool is not
// declared to subagents (and a guessed call is rejected), so delegation is one
// level deep; re-entering an already-running agent is rejected by runAgent, which
// also closes ctx.run cycles.
//
// The bundled preset catalogue (./tools) is preloaded into the registry by
// default, so a new harness gets fileRead/fileWrite/fileEdit/fileGlob as declared
// core tools and can discover commandRun/… without the caller importing anything.
// The searchable presets cost no context until discovered. `presets: false` opts
// out.
//
// Cross-references:
//   - core/agent     — the brain being driven (turn())
//   - core/tool      — what gets executed, and where tags/visibility live
//   - core/discovery — the tag ranking behind toolRequest
//   - core/creation  — compile-and-register behind toolCreate
//   - core/todo      — the per-harness todo list behind todoManage
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
    toolUiOf,
    createDynamicTool,
    createTodoTool,
    createProfileTool,
    createChapterTool,
    createLocationTool,
    TOOL_CREATE_METADATA,
    TOOL_CREATE_NAME,
    AGENT_DELEGATE_NAME,
    TOOL_REQUEST_METADATA,
    TOOL_REQUEST_NAME,
    TODO_MANAGE_NAME,
    PROFILE_MANAGE_NAME,
    CHAPTER_MANAGE_NAME,
    LOCATION_MANAGE_NAME,
    agentDelegateMetadata
} from './core';
import { presetTools, createWebSearchTool, WEB_SEARCH_TOOL_NAME } from './tools';
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
// not a policy knob, so the library default stays deliberately small; a real
// agent session can raise it with `harness({ maxIterations })` (the application
// presets do, see harnesses/presets.ts). A runaway loop must not be able to run a
// CLI process out of money or stack, so `maxIterations` is validated at
// construction (positive safe integer) and can never be Infinity.
const DEFAULT_MAX_ITERATIONS = 16;

// Validate and resolve the configured tool-loop bound. Rejecting anything that is
// not a positive safe integer keeps the guard meaningful: 0 would make every tool
// request fail, 1.5/NaN/Infinity have no well-defined round count, and values
// beyond Number.MAX_SAFE_INTEGER cannot be counted exactly.
const resolveMaxIterations = (value: number | undefined): number => {
    if (value === undefined) return DEFAULT_MAX_ITERATIONS;

    if (!Number.isSafeInteger(value) || value < 1) {
        throw new HarnessError(
            `maxIterations must be a positive safe integer; received ${String(value)}.`
        );
    }

    return value;
};

// The discovery entry point. The harness owns this name: the whole visibility
// scheme depends on there being exactly one tool that can enable the rest.
const TOOL_REQUEST = TOOL_REQUEST_NAME;

// Runtime tool creation (R2b), the session todo list, the session record tools,
// and bounded delegation (R4). All are model-facing core tools, so their wire
// names are part of the harness contract. The names come from core/metadata.ts,
// which the server's tool catalogue also describes — one copy, so a descriptor
// cannot advertise a name the runtime does not register.
const TOOL_CREATE = TOOL_CREATE_NAME;
const TODO_MANAGE = TODO_MANAGE_NAME;
const PROFILE_MANAGE = PROFILE_MANAGE_NAME;
const CHAPTER_MANAGE = CHAPTER_MANAGE_NAME;
const LOCATION_MANAGE = LOCATION_MANAGE_NAME;
const AGENT_DELEGATE = AGENT_DELEGATE_NAME;

// Names no configured, preset, plugin, or model-created tool may take. Keeping
// the whole list in one place is what makes the reservation check exhaustive.
// Order matches the registration order below (and therefore the declaration
// order on every request), with agentDelegate last because it is primary-only.
const RESERVED_TOOL_NAMES = [
    TOOL_REQUEST,
    TOOL_CREATE,
    TODO_MANAGE,
    PROFILE_MANAGE,
    CHAPTER_MANAGE,
    LOCATION_MANAGE,
    AGENT_DELEGATE
] as const;

// Budget for toolCreate: registration is cheap but not free, and an unbounded
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
// (`fileRead(['package.json'])`) and a model call
// (`fileRead({ "paths": ["package.json"] })`) identical inside `execute`.
// Multi-property tools such as syntaxCheck receive the whole object.
const unwrapParameters = (definition: Tool, parsed: Record<string, unknown>): unknown => {
    const key = toolParameterKey(definition.parameters);
    if (key === undefined) return parsed;
    return parsed[key];
};

export const harness = (configuration: HarnessConfiguration): Harness => {
    // Resolve the loop bound once, before anything is built, so a bad value fails
    // at construction instead of after a long run. The bound applies to every agent
    // run in this harness (entry, ctx.run, and delegated subagents); each run gets
    // its own budget because the check lives in runAgentCore's loop.
    const maxIterations = resolveMaxIterations(configuration.maxIterations);

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
        // has no subagents and gets no agentDelegate tool at all.
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
    // preset catalogue is preloaded by default: the four core file tools are
    // declared immediately and the searchable remainder is discoverable without
    // the caller importing anything. `presets: false` starts from the configured
    // tools only, and a configured tool of the same name replaces the preset.
    const tools: Record<string, Tool> = configuration.presets === false ? {} : { ...presetTools };

    for (const [name, definition] of Object.entries(configuration.tools ?? {})) {
        if (!definition || typeof definition.execute !== 'function') {
            throw new HarnessError(`Tool "${name}" is not a tool: create it with tool({...}).`);
        }

        definition.name = name;
        tools[name] = definition;
    }

    // Opt-in web search (W3). `websearch: true` (or a configuration object) builds
    // one CORE tool from the keys available to THIS harness (R18); `presets: false`
    // does not disable it, because it is not part of the preset catalogue. Rules:
    //   - a configured tool named `webSearch` wins: the caller brought its own;
    //   - no usable key means no tool at all (the factory returns undefined), so a
    //     keyless deployment and a default harness stay offline-safe;
    //   - keys resolve now, at construction, and live only in the tool closure, so
    //     two harnesses never share a credential and nothing reaches the schema,
    //     arguments, results, or progress events.
    // The CONFIGURATION field is still spelled `websearch` (it names the feature,
    // not the tool); only the wire name is webSearch. This runs before the
    // reserved-name check on purpose: webSearch is not a harness-reserved name,
    // only a name the harness fills when asked to.
    if (
        configuration.websearch !== undefined &&
        configuration.websearch !== false &&
        tools[WEB_SEARCH_TOOL_NAME] === undefined
    ) {
        const webSearch = createWebSearchTool(
            configuration.websearch === true ? {} : configuration.websearch
        );

        if (webSearch) tools[WEB_SEARCH_TOOL_NAME] = webSearch;
    }

    // The harness owns its core names. Checked after presets and configured tools
    // so a collision is reported once, up front, in the same place as toolRequest
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

    // Tools toolRequest has enabled, in discovery order. Searchable tools stay
    // in the registry but are not declared — and not callable — until they land
    // here. Core tools bypass the set entirely. The set is per harness, so a
    // discovered tool stays available for the rest of the conversation.
    const activeTools = new Set<string>();

    const enableTools = (names: readonly string[]): void => {
        for (const name of names) {
            if (tools[name]) activeTools.add(name);
        }
    };

    // toolRequest is the one discovery tool every harness provides. It is core, so
    // the model can always reach it, and its result both explains the matches and
    // enables them for the next turn.
    //
    // Name, description, tags, and schema come from core/metadata.ts (R7): at most
    // five matches per request, `remaining` as the count of further matches, and a
    // `limit` that can only narrow the shortlist. Two schema properties, so the
    // single-property rule does not apply and `parameters` arrives as an object.
    tools[TOOL_REQUEST] = defineTool<{ tags: string[]; limit?: number }, ToolSearchResult>({
        ...TOOL_REQUEST_METADATA,
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
    // toolCreate tool and the host-facing harness.createTool(), so the two can
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

        // Compare case-insensitively: "fileread" beside a preset "fileRead" would
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
        // this tool, so making it spend a toolRequest round trip to call it would be
        // wasteful. It stays in the searchable catalogue, so it remains
        // discoverable (and a reset() only clears the enabled set).
        activeTools.add(definition.name);

        return definition;
    };

    tools[TOOL_CREATE] = defineTool<ToolCreation, ToolCreationResult>({
        ...TOOL_CREATE_METADATA,
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

    // Session todos (R1/R2). One instance per harness: the tool closes over its
    // own list and id counter, so two harnesses (and therefore two server
    // sessions) can never share todos. Every agent in this harness calls the same
    // tool, so the primary and its subagents see one list. reset() below clears
    // it together with the conversation; nothing is persisted.
    const todo = createTodoTool();
    tools[TODO_MANAGE] = todo.tool;

    // Session records (profiles, chapters, locations). Same lifecycle as the todo
    // list: one factory instance per harness, shared by every agent here, and
    // cleared by reset(). Separate closets and separate id sequences, so a
    // profile id and a chapter id may both be "1" without ambiguity.
    const profile = createProfileTool();
    tools[PROFILE_MANAGE] = profile.tool;

    const chapter = createChapterTool();
    tools[CHAPTER_MANAGE] = chapter.tool;

    const location = createLocationTool();
    tools[LOCATION_MANAGE] = location.tool;

    // Bounded delegation (R4). Registered only when there is somewhere to
    // delegate: a tool that can only fail would cost context on every request.
    // Subagents never receive it (see declared()), and executeToolCall rejects a
    // guessed call, so delegation is exactly one level deep. runAgent rejects
    // re-entering an agent that is already running, which closes the ctx.run
    // cycle as well.
    if (subagentNames.length > 0) {
        tools[AGENT_DELEGATE] = defineTool<{ agent: string; input: string }, HarnessDelegationResult>({
            // Description and schema (including the `agent` enum) come from the
            // shared metadata: the runtime declaration names the allowlist, and the
            // server catalogue describes the same capability generically.
            ...agentDelegateMetadata(subagentNames),
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

    // The tools a request may declare: every core tool first (file tools, a
    // configured webSearch, and the harness-owned set), then everything discovered
    // so far. Everything else stays out of the context window on purpose.
    //
    // agentDelegate is core for the primary only: it is skipped for every other
    // agent, so a subagent cannot even see the delegation control.
    const declared = (brain: Agent): Tool[] => {
        const core: Tool[] = [];
        const discovered: Tool[] = [];

        for (const definition of Object.values(tools)) {
            if (definition.visibility === 'core') {
                if (definition.name === AGENT_DELEGATE && brain !== primary) continue;
                core.push(definition);
            } else if (activeTools.has(definition.name)) {
                discovered.push(definition);
            }
        }

        return [...core, ...discovered];
    };

    // Declarations handed to every request. Rebuilt per run so a plugin that
    // registers tools mid-flight is picked up on the next call, and so a toolRequest
    // round shows up in the very next request. Per-brain because agentDelegate is a
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
            // `callId` pairs the result with the exact tool_call that caused it,
            // even when two calls in one turn share a name. The server's timing
            // record uses it to attribute elapsed time without guesswork.
            await progress({
                type: 'tool_result',
                agent: brain.name,
                name: call.name,
                callId: call.id,
                content,
                isError: true
            });
        };

        const definition = tools[call.name];

        // Unknown tool: still answer the call so the transcript stays valid for
        // strict providers, and so the model can correct itself — pointing it at
        // discovery, since the catalogue is not declared.
        if (!definition) {
            const available = declared(brain).map((tool) => tool.name).join(', ') || 'none';
            await fail(
                `Tool "${call.name}" is not registered. Available tools: ${available}. Call ${TOOL_REQUEST} with capability tags to search the catalogue.`
            );
            return;
        }

        // Delegation is primary-only. agentDelegate is core, so the visibility check
        // below would let it through; a subagent that guesses the name is stopped
        // here, in addition to never seeing it declared.
        if (call.name === AGENT_DELEGATE && brain !== primary) {
            await fail(`Tool "${AGENT_DELEGATE}" is only available to the primary agent "${primaryName}".`);
            return;
        }

        // A searchable tool the model has not discovered is not callable, even when
        // it guesses the name: being declared is what makes a tool available, and
        // toolRequest is how a tool gets declared.
        if (definition.visibility !== 'core' && !activeTools.has(call.name)) {
            const tags = definition.tags.slice(0, 3).map((tag) => `"${tag}"`).join(', ');
            await fail(
                `Tool "${call.name}" is registered but not enabled yet. Call ${TOOL_REQUEST} with tags like ${tags} to enable it.`
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

            // R20.2: a tool may return a `toolUi(content, panels)` envelope.
            // Unwrap it exactly here, so the model gets the ordinary content and
            // the client gets optional declarative panels. Ordinary values pass
            // through unchanged, and a malformed/fake envelope is not recognized.
            const ui = toolUiOf(result);
            const content = serialize(ui === undefined ? result : ui.content);
            appendToolResult(brain, call, content);
            await progress({
                type: 'tool_result',
                agent: brain.name,
                name: call.name,
                callId: call.id,
                content,
                isError: false,
                // Absent for every ordinary tool, so recorded events keep their
                // existing shape. The model never sees this field.
                ...(ui === undefined ? {} : { ui: ui.panels })
            });
        } catch (error) {
            await fail(`Tool "${call.name}" failed: ${toErrorInfo(error).message}`);
        }
    };

    // Run one agent to completion. This is the loop the harness exists for.
    //
    // Renamed from runAgent: the guarded entry point is the wrapper below, so
    // every path (harness call, ctx.run, agentDelegate) shares one recursion check.
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
            for (let iteration = 0; iteration < maxIterations; iteration++) {
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

                // Per-request token accounting, reported for EVERY turn — including
                // the tool rounds that continue this run — so a client can tally the
                // whole run's cost while it iterates. The `done` event below reports
                // only the FINAL request, which is why this event exists separately.
                // A transport that reports no usage for a request emits nothing here;
                // an unreported request must not look like a free one.
                if (message.usage !== undefined) {
                    await progress({ type: 'usage', agent: brain.name, usage: message.usage });
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
                `Agent "${brain.name}" requested tools more than ${maxIterations} times without answering.`
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
    //   - let the agentDelegate tool prove it runs at the top level, so delegation
    //     cannot nest.
    const runStack: Agent[] = [];

    // The one entry point every path uses: the harness call, ctx.run, and
    // agentDelegate. The guard is here rather than in the agentDelegate tool so a
    // cycle cannot be opened through the general tool context either.
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
            // The harness-owned names stay owned, even when agentDelegate was not
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

    // The host/server-facing execution path (R8): run one REGISTERED tool by name
    // with the session it belongs to, exactly like the model would, but without
    // spending a discovery round trip. The server's `POST /tools/:name` calls this
    // through its session for the session-bound harness-owned tools, which is what
    // makes a manual toolRequest/toolCreate/todoManage/agentDelegate call mutate
    // THIS harness instead of a detached copy. Core file tools use the ordinary
    // direct-call path and do not require a session.
    //
    // Gating difference, on purpose: discovery gates the MODEL. An explicit user
    // action may run any registered tool even when toolRequest never enabled it;
    // the model still cannot. Nothing else is bypassed — toolCreate goes through
    // createToolFrom (validation, budget, collisions, guarded compilation) and
    // agentDelegate's own execute re-checks the primary's authority.
    //
    // No progress events are emitted: a manual call is not a conversation turn, so
    // there is no transcript position for a tool_call/tool_result pair. The
    // caller's request/response carries the duration (ToolCallResult).
    const executeTool = async (name: string, parameters: unknown): Promise<unknown> => {
        const definition = tools[name];

        // The session owns which tools exist: a harness without subagents has no
        // agentDelegate, so an operator asking for one gets an honest error here (the
        // server maps it to 404) instead of a fabricated implementation.
        if (!definition) {
            throw new HarnessError(`Tool "${name}" is not registered in this harness.`);
        }

        return definition.execute({
            parameters,
            // An explicit host call acts as the session's entry agent: agentDelegate
            // therefore stays primary-only, and ctx.run cycles are still rejected
            // by runAgent.
            agent: primary,
            agents,
            run: (agentName: string, input: string) => {
                const target = agents[agentName];
                if (!target) {
                    throw new HarnessError(`Agent "${agentName}" is not registered.`);
                }
                return runAgent(target, input);
            }
        });
    };

    // The harness is a function you call. Properties ride on it so a CLI has
    // everything in one handle without a second lookup object.
    const run = (input: string, options?: HarnessRunOptions) => runAgent(primary, input, options);

    // Every Harness field except `name` and `discoveredTools` is assigned here.
    // Those two are defineProperty'd below: `name` is a built-in function property
    // that cannot be assigned, and `discoveredTools` must be a getter so a caller
    // can never mutate the enabled set. The `unknown`-mediated cast is therefore
    // describing exactly that: a complete handle assembled from two sources. Keep
    // this list in step with the Harness type — an omitted accessor typechecks as
    // `never` here and the cast would silently hide it.
    const handle = Object.assign(run, {
        agent: primary,
        agents,
        subagents,
        tools,
        plugins: pluginNames,
        // Host-side runtime creation: the same path the model's toolCreate tool
        // uses, so validation, budget, collision rules, and immediate enablement
        // are identical. Throws HarnessError, unlike the model path which turns
        // the failure into a tool result.
        createTool: createToolFrom,
        // Server-facing manual execution (R8): the session-bound tool invocation
        // `POST /tools/:name` uses when a client supplies a sessionId.
        executeTool,
        // reset() is "start over": the conversation goes back to the seeded
        // instructions, tool discovery is forgotten with it, and the session
        // todo list and record stores (profiles, chapters, locations) are
        // cleared (ids restart at "1"), so the next run begins from the core set
        // and empty session state. Tools created at runtime stay in the
        // catalogue (they are registry state, not conversation state); they are
        // simply no longer enabled until discovered again.
        reset: () => {
            primary.reset();
            activeTools.clear();
            todo.reset();
            profile.reset();
            chapter.reset();
            location.reset();
        }
    }) as unknown as Harness;

    // `name` is a built-in, read-only property of every function, so it must be
    // defined rather than assigned. The entry agent's name is the harness name.
    Object.defineProperty(handle, 'name', {
        value: primary.name,
        enumerable: true,
        configurable: true
    });

    // Read-only discovery view (`Harness.discoveredTools`). A getter that copies
    // the Set on every read: a caller must never be able to mutate the enabled
    // set through the handle, and a server snapshot can record the list so a
    // reload still knows which capabilities were discovered.
    Object.defineProperty(handle, 'discoveredTools', {
        get: () => [...activeTools],
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
export { agent, tool, searchTools, compileToolSource, createDynamicTool, toolUi, toolUiOf } from './core';
// The session record factories are public too, so a host can build the same
// stores the harness registers (e.g. for a server-side tool or a test). They
// mirror the core/index.ts exports; todoManage's factory stays internal to keep
// this change scoped.
export { createProfileTool, createChapterTool, createLocationTool } from './core';
// Tool-panel bounds and the normalizer are public too: a client or a host-side
// tool author can quote the same caps the server enforces (see core/tool-ui.ts).
export { TOOL_UI_LIMITS, normalizeToolUiPanels } from './core';
export type { ToolUiExtraction } from './core';
export { openAICompatible, listModels, ModelListError } from './transport';
export type { ModelListConfiguration, ModelListErrorKind } from './transport';
export {
    syntaxCheck,
    fileRead,
    fileWrite,
    fileEdit,
    fileList,
    fileGlob,
    commandRun,
    gitDiff,
    createWebSearchTool,
    WEB_SEARCH_METADATA,
    WEB_SEARCH_TOOL_NAME,
    presetTools
} from './tools';
export type {
    SyntaxCheckLanguage,
    SyntaxCheckParameters,
    FileReadEntry,
    FileReadParameters,
    FileReadResult,
    FileWriteEntry,
    FileWriteParameters,
    FileWriteResult,
    FileWriteResultEntry,
    FileEditEntry,
    FileEditParameters,
    FileEditResult,
    FileEditResultEntry,
    FileListParameters,
    FileGlobFilesResult,
    FileGlobMatch,
    FileGlobMatchesResult,
    FileGlobParameters,
    FileGlobResult,
    GitDiffParameters,
    GitDiffResult,
    CommandRunResult
} from './tools';
export { HarnessError } from './util';
export type * from './types';


// Shared types for @underload/harness.
//
// The split this file encodes:
//   - Agent  = the brain. Owns the model, the instruction, the message history,
//              and the transport call. Comparable to a `simpleClient` from
//              @agentic/harness. Usable on its own: `agent.stream()` is one turn,
//              and a caller who does not want a harness writes the loop by hand.
//   - Tool   = an action the model can request. It has no policy and no state;
//              the harness decides when to execute it and what to feed back.
//   - Harness = the execution loop. Owns the agents, the tool registry, and the
//              progress reporter. Calling it runs turns until the model stops
//              asking for tools.
//
// Cross-references:
//   - core/agent.ts  — the factory that produces Agent
//   - core/tool.ts   — the factory that produces Tool
//   - harness.ts     — the callable that produces Harness
//   - transport.ts   — the default OpenAI-compatible HarnessStream

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type HarnessRole = 'system' | 'user' | 'assistant' | 'tool';

// A tool invocation requested by the model. `arguments` stays a raw JSON string
// because that is what the wire protocol delivers, and because malformed JSON is
// the harness's problem to report back to the model rather than a parse crash.
export type HarnessToolCall = {
    id: string;
    name: string;
    arguments: string;
};

// One transcript entry, in the shape the harness manipulates internally. The
// transport maps these onto the provider's wire format (see transport.ts).
export type HarnessMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | {
          role: 'assistant';
          content: string;
          // Present only when the turn requested tools.
          toolCalls?: HarnessToolCall[];
          // Kept out of the wire payload; retained so a UI can replay a turn.
          reasoning?: string;
      }
    | {
          role: 'tool';
          content: string;
          toolCallId: string;
          name: string;
      };

// A finished assistant turn. This is the value the harness resolves to and the
// payload of the `done` event, so it carries everything a CLI wants to print.
export type HarnessAssistantMessage = {
    role: 'assistant';
    content: string;
    // Accumulated reasoning/thinking text. Always present; empty for
    // non-reasoning models.
    reasoning: string;
    // Tools the model asked for in this turn. Empty when it answered directly.
    toolCalls: HarnessToolCall[];
    // The model that produced this turn, captured at request time.
    model: string;
    stopReason: HarnessStopReason;
    // Undefined when the provider did not report usage for this request.
    usage?: HarnessUsage;
};

// Why generation ended. `tool_calls` means the model wants tools run and the
// turn is not finished; the other two are terminal.
export type HarnessStopReason = 'stop' | 'length' | 'tool_calls';

// Token accounting, normalized from the provider's `usage` block.
export type HarnessUsage = {
    input: number;
    output: number;
    total: number;
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// One request sent to a model. The transcript is passed by value: transports
// never mutate agent history.
export type HarnessStreamRequest = {
    model: string;
    messages: HarnessMessage[];
    // Tool declarations for this request. Empty or absent when no tools are in
    // scope. Definitions, not implementations: a transport never executes.
    tools?: HarnessStreamTool[];
    // Forwarded to fetch/the SDK so a caller can cancel a running turn.
    signal?: AbortSignal;
};

// The tool declaration shape a transport needs. Deliberately narrower than
// `Tool`: a transport must not be able to call `execute`.
export type HarnessStreamTool = {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
};

// Low-level events yielded by a transport. Tool calls arrive on the terminal
// frame rather than as deltas: the harness only acts once the model has stopped
// generating, and partial arguments are not executable.
export type HarnessStreamEvent =
    | { type: 'text'; delta: string }
    | { type: 'reasoning'; delta: string }
    | {
          type: 'done';
          stopReason: HarnessStopReason;
          toolCalls: HarnessToolCall[];
          usage?: HarnessUsage;
      }
    | { type: 'error'; message: string };

// A transport is an async iterable of those events. Supplying one is how a
// caller swaps the wire protocol; the default is `openAICompatible()`.
export type HarnessStream = (request: HarnessStreamRequest) => AsyncIterable<HarnessStreamEvent>;

// Sampling knobs forwarded verbatim. Providers in this workspace are
// OpenAI-compatible, so these are the OpenAI field names.
export type HarnessSampling = {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
};

// Endpoint configuration for the built-in transport. Ignored when an explicit
// `stream` is supplied to the agent.
export type HarnessProviderConfiguration = {
    // Base URL without the /chat/completions suffix, e.g.
    // 'http://localhost:5500/providers/private/v1'.
    baseURL: string;
    // A static key, or a getter so rotating credentials stay live per request.
    apiKey?: string | (() => string);
    // Extra headers merged over the generated ones.
    headers?: Record<string, string>;
    // Sampling fields attached to every request built by this transport.
    sampling?: HarnessSampling;
};

// ---------------------------------------------------------------------------
// Agent (the brain)
// ---------------------------------------------------------------------------

// Everything needed to construct a brain. `name` is optional: inside a harness
// the registry key names the agent (see harness.ts), so `writer: agent({...})`
// is enough. Standalone agents keep the default label.
export type AgentConfiguration = {
    name?: string;
    // Model identifier, e.g. 'merge/ds4-flash'.
    model: string;
    // System instruction(s). A string or a list; each entry becomes its own
    // system message, in order, so persona + rules + format can compose.
    instruction?: string | string[];
    // Seed history. Instructions are prepended ahead of these.
    messages?: HarnessMessage[];
    // Endpoint config for the built-in transport.
    provider?: HarnessProviderConfiguration;
    // Explicit transport. Takes precedence over `provider`.
    stream?: HarnessStream;
};

// Overload-style accessor so `agent.model()` reads and `agent.model('x')`
// writes, mirroring simpleClient's model().
export type AgentModelAccessor = {
    (): string;
    (value: string): Agent;
};

export type AgentStreamOptions = {
    signal?: AbortSignal;
    // Tool declarations forwarded with the request. Standalone callers pass these
    // and write the execution loop themselves; the harness supplies its whole
    // registry automatically.
    tools?: HarnessStreamTool[];
};

// Events yielded by Agent.stream / Agent.turn. `error` is yielded by stream()
// (which keeps history clean and lets a caller keep going); turn() throws
// instead, because the harness owns recovery there.
export type AgentStreamEvent =
    | { type: 'text'; delta: string }
    | { type: 'reasoning'; delta: string }
    | { type: 'done'; message: HarnessAssistantMessage }
    | { type: 'error'; error: HarnessErrorInfo };

// Serialisable error shape. Events cross CLI/RPC boundaries, so failures travel
// as data rather than as Error instances.
export type HarnessErrorInfo = {
    message: string;
};

// The brain. Owns history; performs one request per turn().
export type Agent = {
    // Label for logging and reporting. A harness overwrites this with the
    // registry key when the agent is registered, so it always matches the name
    // used in `agents`.
    name: string;
    // Live transcript. Mutated by system()/user()/assistant()/stream()/turn().
    readonly messages: HarnessMessage[];
    // The system messages this agent was seeded with, for reset().
    readonly instructions: readonly string[];
    // Read or write the active model.
    model: AgentModelAccessor;
    // Append a message and return the agent for chaining.
    system: (content: string) => Agent;
    user: (content: string) => Agent;
    assistant: (content: string, toolCalls?: HarnessToolCall[]) => Agent;
    // Append the input, then run one turn. Commits the turn atomically: on
    // failure history is truncated back to where it was.
    stream: (input: string, options?: AgentStreamOptions) => AsyncIterable<AgentStreamEvent>;
    // Run one turn against the current history, without appending a user
    // message. This is the primitive the harness loop re-requests with after a
    // tool result. Throws on failure.
    turn: (options?: AgentStreamOptions) => AsyncIterable<AgentStreamEvent>;
    // Restore history to the seeded instructions and reset the model.
    reset: () => void;
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

// Whether the model can see a tool before it searches for one.
//
// A large catalogue cannot be declared on every request — thousands of tools
// would flood the context window before the first prompt. So a request declares:
//   - every 'core' tool (keep that list tiny), and
//   - every 'searchable' tool that getTools has already enabled.
export type ToolVisibility = 'core' | 'searchable';

// One entry in a getTools result: enough for the model to decide whether to call
// it, without shipping the whole schema again.
export type ToolMatch = {
    name: string;
    description: string;
    tags: string[];
};

// The result of a getTools call, and the return value of the pure
// `searchTools()` helper. Shaped as data because it travels back to the model as
// a tool result.
export type ToolSearchResult = {
    // Tools the model can call from the next turn onward, best match first. This
    // list is capped (10 by default, 50 maximum) so a query that matches a whole
    // family cannot flood the context either.
    enabled: string[];
    // Metadata for the enabled tools, in the same order.
    tools: ToolMatch[];
    // Query tags that matched no tag, name, or description.
    unmatchedTags?: string[];
    // Every tag in the searchable catalogue. Present only when nothing matched,
    // so the model can retry with real vocabulary instead of guessing.
    availableTags?: string[];
    // True when more tools matched than the cap and the tail was dropped.
    truncated?: boolean;
};

// A request to create a tool at runtime, either from the model-facing createTool
// tool or from the host through `harness.createTool()`.
//
// `source` is the BODY of an async function, compiled once at registration and
// executed only when the model (or host) calls the tool — registering a tool
// never runs its source. The body is handed `args` (the parameter value, following
// the same single-property rule as every other tool) and `context` (the
// ToolContext, including agent/agents/run inside a harness).
//
// SECURITY: compilation uses the host realm's Function constructor. A created tool
// has exactly the permissions of the process — the same trust model as `runCommand`
// in src/tools. There is NO sandbox and NO isolation; the only guarantees are
// bounded input validation, a bounded number of tools, and a compile error if the
// source does not parse.
export type ToolCreation = {
    // Wire name the model calls. Must match the registry-safe pattern in
    // src/core/creation.ts and must not collide with a registered name.
    name: string;
    // Shown to the model and used by getTools matching.
    description: string;
    // Capability tags. Required: an untagged creation could never be discovered.
    tags: readonly string[];
    // Optional JSON Schema for the arguments.
    parameters?: Record<string, unknown>;
    // Async function body, e.g. `return args.toUpperCase();`.
    source: string;
};

// What a successful createTool call hands back to the model. Metadata only: the
// source is never echoed, so a creation round costs one short result.
export type ToolCreationResult = {
    name: string;
    description: string;
    tags: string[];
    parameters?: Record<string, unknown>;
    // A created tool is registered `searchable` and enabled at once, so the very
    // next turn can call it without a second getTools round.
    enabled: true;
};

// What a delegation hands back to the primary agent: the subagent's answer, not
// its transcript (history stays with the subagent).
export type HarnessDelegationResult = {
    agent: string;
    content: string;
};

// What a tool implementation is handed when the model calls it.
//
// The harness fields are optional because a tool can also be executed on its
// own: `pythonSyntax('print(1)')` runs the same implementation with no agent, no
// registry, and no run(). A tool that needs them must check, and the presets in
// src/tools deliberately do not.
export type ToolContext<TParameters = any> = {
    // The parameter value. For a schema with several properties this is the
    // parsed arguments object; for a schema with exactly one property it is that
    // property's value (see src/core/tool.ts).
    parameters: TParameters;
    // The agent that requested this call. Present only inside a harness.
    agent?: Agent;
    // Every agent in the harness, so a tool can reach a sibling brain.
    agents?: Readonly<Record<string, Agent>>;
    // Run a full turn (including tool execution) on a named agent. Present only
    // inside a harness.
    run?: (agentName: string, input: string) => Promise<HarnessAssistantMessage>;
};

// A tool definition. `name` is optional: inside a harness the registry key names
// the tool, so `websearch: tool({...})` is enough.
export type ToolConfiguration<TParameters = any, TResult = any> = {
    name?: string;
    // Shown to the model. Required — an undescribed tool is an unusable tool.
    description: string;
    // Capability tags, used by tool discovery to find close matches. Required:
    // an untagged tool is invisible to getTools, so it could never be found.
    // Stored trimmed, lowercased, and deduplicated.
    tags: readonly string[];
    // 'core' tools are declared on every request; 'searchable' ones (the
    // default) stay hidden until getTools enables them.
    visibility?: ToolVisibility;
    // JSON Schema for the arguments. A TypeBox schema works as-is: TypeBox
    // output is plain JSON Schema.
    parameters?: Record<string, unknown>;
    // The implementation. Throwing is fine; the harness turns the error into a
    // tool result the model can read and recover from.
    execute: (context: ToolContext<TParameters>) => Promise<TResult> | TResult;
};

// A tool is an executable object: it can be called directly, or registered on a
// harness and called by the model. Both paths run the same implementation.
//
//     const pythonSyntax = tool<string, boolean>({...});
//     await pythonSyntax('print(1)');         // direct, no harness
//     harness({ tools: { pythonSyntax } });   // the model calls it
export type Tool<TParameters = any, TResult = any> = {
    // Execute directly. The argument is the parameter value, exactly as
    // `execute` receives it.
    (parameters: TParameters): Promise<TResult>;
    // The wire name the model calls. A harness overwrites this with the
    // registry key when the tool is registered.
    name: string;
    description: string;
    // Normalized capability tags (trimmed, lowercased, deduplicated).
    tags: readonly string[];
    // Resolved visibility. A harness declares core tools plus enabled ones.
    visibility: ToolVisibility;
    parameters?: Record<string, unknown>;
    execute: (context: ToolContext<TParameters>) => Promise<TResult>;
};

// ---------------------------------------------------------------------------
// Harness (the execution loop)
// ---------------------------------------------------------------------------

// Progress events. Every one names its agent so a multi-agent run stays readable
// in a single console stream. This is the whole reporting surface: a UI or a
// `console.log` sees exactly the steps below.
export type HarnessEvent =
    | { type: 'start'; agent: string; model: string }
    | { type: 'text'; agent: string; delta: string }
    | { type: 'reasoning'; agent: string; delta: string }
    | { type: 'tool_call'; agent: string; call: HarnessToolCall }
    | { type: 'tool_result'; agent: string; name: string; content: string; isError: boolean }
    | { type: 'done'; agent: string; message: HarnessAssistantMessage }
    | { type: 'error'; agent: string; error: HarnessErrorInfo };

export type HarnessProgress = (event: HarnessEvent) => void | Promise<void>;

export type HarnessRunOptions = {
    signal?: AbortSignal;
};

export type HarnessConfiguration = {
    // Every brain the harness can run, keyed by name. The FIRST entry is the
    // entry point unless `primary` names another one: `writer(...)` runs that
    // agent, and the rest are reachable from tools through `ctx.run(name, input)`
    // or the `delegate` tool the primary agent gets.
    agents: Record<string, Agent>;
    // Which agent the callable runs. Defaults to the first entry of `agents`, so
    // a single-agent config needs nothing. Must name a registered agent.
    primary?: string;
    // Agents the primary agent may delegate to. Defaults to every agent except
    // the primary. When the list is empty there is no delegation at all and the
    // `delegate` tool is not registered. Subagents never receive `delegate`, so
    // delegation is one level deep by construction.
    subagents?: readonly string[];

    // Every tool the harness can run. Keyed by the name the model calls. Only
    // `visibility: 'core'` tools are declared up front; the rest are found
    // through the built-in getTools tool and enabled for the next turn.
    tools?: Record<string, Tool>;
    // Preload the bundled preset catalogue (src/tools/) into the registry. True by
    // default: discovery exists so a large catalogue costs nothing until it is
    // asked for. Set false to start from `tools` alone. A configured tool wins on
    // a name collision.
    presets?: boolean;
    // Reporting hooks. `progress` is awaited for every step, so a slow UI can
    // pace the run, and a `console.log` can just print.
    report?: {
        progress?: HarnessProgress;
    };
    // Optional programmatic extension point, retained from the plugin design.
    plugins?: readonly HarnessPlugin[];
};

// The callable harness. `await writer('...')` runs the entry agent to
// completion, executing tools until the model answers with text.
export type Harness = {
    (input: string, options?: HarnessRunOptions): Promise<HarnessAssistantMessage>;
    // The entry agent's name (`primary`, or the first key of `agents`).
    readonly name: string;
    // The entry agent.
    readonly agent: Agent;
    // Every agent, keyed by the names given in configuration.
    readonly agents: Readonly<Record<string, Agent>>;
    // Agents the primary may delegate to, keyed by name. Empty when delegation is
    // not configured.
    readonly subagents: Readonly<Record<string, Agent>>;
    // The registered tools, keyed by the names the model calls. Includes the
    // built-in getTools and createTool entries, plus delegate when there is at
    // least one subagent.
    readonly tools: Readonly<Record<string, Tool>>;
    // Register a tool from source at runtime. This is the host-side path the
    // model-facing createTool tool uses: same validation, same registry, same
    // "searchable and enabled at once" behaviour. Throws HarnessError on invalid
    // or colliding input, so a host sees creation failures as exceptions.
    createTool: (configuration: ToolCreation) => Tool;
    // Names of the applied plugins, in order.
    readonly plugins: readonly string[];
    // Reset the entry agent's conversation and forget which tools getTools had
    // enabled, so the next run starts from the core set again. Created tools stay
    // registered (they are part of the catalogue), just not enabled.
    reset: () => void;
};

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

// A plugin is a named unit of behaviour applied during harness construction.
export type HarnessPlugin = {
    // Unique within one harness. Applied in array order.
    name: string;
    // Runs once, synchronously. Synchronous on purpose: harness() stays a plain
    // factory, so `const writer = harness({...})` needs no await.
    setup?: (api: HarnessPluginApi) => void;
};

// What a plugin is handed at setup time.
export type HarnessPluginApi = {
    // The live agent registry, including the entry agent.
    agents: Record<string, Agent>;
    // The live tool registry.
    tools: Record<string, Tool>;
    // Create and register another brain under `name`.
    createAgent: (name: string, configuration: AgentConfiguration) => Agent;
    // Register another tool under `name`.
    addTool: (name: string, definition: ToolConfiguration) => Tool;
};

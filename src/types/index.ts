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
    // Prompt/input tokens for the request, INCLUDING any replayed cache prefix.
    // That is the OpenAI-compatible `prompt_tokens` semantics: a request that
    // replays A+B and adds C reports A+B+C here.
    input: number;
    output: number;
    total: number;
    // How much of `input` the provider served from its prefix cache, when it says
    // so at all. OPTIONAL and never defaulted: "not reported" and "reported, 0
    // cached" are different facts, and a client that prints `(0)` for a provider
    // which never reports a cache figure would be inventing one. Readers must
    // treat undefined as unknown, not as zero.
    cached?: number;
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
//   - every 'searchable' tool that toolRequest has already enabled.
export type ToolVisibility = 'core' | 'searchable';

// One entry in a toolRequest result: enough for the model to decide whether to call
// it, without shipping the whole schema again.
export type ToolMatch = {
    name: string;
    description: string;
    tags: string[];
};

// The result of a toolRequest call, and the return value of the pure
// `searchTools()` helper. Shaped as data because it travels back to the model as
// a tool result.
//
// DISCOVERY CAP (R7): at most MAX_DISCOVERY_MATCHES (5) matches are returned and
// enabled per request. The cap is deliberately tight: five schemas is a focused
// shortlist the model can actually weigh, and it keeps one broad tag from
// re-flooding the context. Anything beyond that is reported as a COUNT only —
// `remaining` — so the model refines its tags to drill deeper instead of paging
// through a list of names it cannot see.
export type ToolSearchResult = {
    // Tools the model can call from the next turn onward, best match first. At
    // most 5 entries (see MAX_DISCOVERY_MATCHES in core/discovery.ts); a caller
    // may pass a smaller `limit` but can never raise the cap.
    enabled: string[];
    // Metadata for the enabled tools, in the same order.
    tools: ToolMatch[];
    // How many additional tools matched the query but were excluded by the cap.
    // Always present (0 when every match fits). No names are exposed for the
    // excluded tail: tag refinement, not pagination, is the way to reach them.
    remaining: number;
    // Query tags that matched no tag, name, or description.
    unmatchedTags?: string[];
    // Every tag in the searchable catalogue. Present only when nothing matched,
    // so the model can retry with real vocabulary instead of guessing.
    availableTags?: string[];
    // Retained for compatibility: true exactly when `remaining > 0`.
    truncated?: boolean;
};

// A request to create a tool at runtime, either from the model-facing toolCreate
// tool or from the host through `harness.toolCreate()`.
//
// `source` is the BODY of an async function, compiled once at registration and
// executed only when the model (or host) calls the tool — registering a tool
// never runs its source. The body is handed `args` (the parameter value, following
// the same single-property rule as every other tool) and `context` (the
// ToolContext, including agent/agents/run inside a harness).
//
// SECURITY: compilation uses the host realm's Function constructor. A created tool
// has exactly the permissions of the process — the same trust model as `commandRun`
// in src/tools. There is NO sandbox and NO isolation; the only guarantees are
// bounded input validation, a bounded number of tools, and a compile error if the
// source does not parse.
export type ToolCreation = {
    // Wire name the model calls. Must match the registry-safe pattern in
    // src/core/creation.ts and must not collide with a registered name.
    name: string;
    // Shown to the model and used by toolRequest matching.
    description: string;
    // Capability tags. Required: an untagged creation could never be discovered.
    tags: readonly string[];
    // Optional JSON Schema for the arguments.
    parameters?: Record<string, unknown>;
    // Async function body, e.g. `return args.toUpperCase();`.
    source: string;
};

// What a successful toolCreate call hands back to the model. Metadata only: the
// source is never echoed, so a creation round costs one short result.
export type ToolCreationResult = {
    name: string;
    description: string;
    tags: string[];
    parameters?: Record<string, unknown>;
    // A created tool is registered `searchable` and enabled at once, so the very
    // next turn can call it without a second toolRequest round.
    enabled: true;
};

// What a delegation hands back to the primary agent: the subagent's answer, not
// its transcript (history stays with the subagent).
export type HarnessDelegationResult = {
    agent: string;
    content: string;
};

// ---------------------------------------------------------------------------
// Declarative tool UI panels (R20.2)
// ---------------------------------------------------------------------------
//
// A tool may return a `ToolUiEnvelope` (built with the `toolUi()` helper) to give
// the client a small, safe, declarative rendering of its result. The envelope is
// INTERNAL: the harness unwraps it, sends `content` to the model exactly as it
// would send any other tool value, and reports the panels on the optional
// `ui` field of the `tool_result` event / `ToolCallResult`. This keeps the model
// context identical to a plain return value.
//
// SECURITY: panels are DATA ONLY. There is no HTML, JavaScript, URL action, or
// callback in this shape, so a tool cannot inject executable content into the
// browser. The server normalizes and bounds every supplied panel (see
// src/core/tool-ui.ts) before it reaches a client.
//
// `slot` is an open string, not an enum: today the client mounts `right` next to
// the transcript and can treat `center`/`left` as additional placements, and a
// future host may add its own slot names without a schema change.
export type ToolUiBlock =
    | { type: 'text'; text: string }
    | { type: 'table'; columns: string[]; rows: string[][] }
    | { type: 'keyValue'; items: { label: string; value: string }[] };

export type ToolUiPanel = {
    // Stable within one tool result; lets a client update a panel in place.
    id: string;
    // Placement hint. Extensible: 'right' is the default mount point.
    slot: string;
    title: string;
    blocks: ToolUiBlock[];
};

// The branded value `toolUi(content, panels)` returns. The brand property is a
// plain string key so it survives module duplication and can be detected with an
// own-property check; `content` is the ordinary tool result the model sees.
export type ToolUiEnvelope<TContent = unknown> = {
    readonly __toolUi: ToolUiPanel[];
    readonly content: TContent;
};

// ---------------------------------------------------------------------------
// todoManage (per-harness session todos)
// ---------------------------------------------------------------------------
//
// A harness-specific incremental todo API. It is intentionally NOT OpenCode's
// experimental `todowrite`: actions mutate one item at a time, ids are stable
// strings, and the list is session state rather than full-list replacement.
// See src/core/todo.ts and README.md for the source-backed reference.

// Every accepted action. `uncheck` is an explicit alias for `check` with
// `completed: false`.
export type TodoAction = 'add' | 'remove' | 'check' | 'uncheck' | 'list';

// One stored todo. `id` is a decimal string, monotonic within one harness
// instance (and restarted by reset()).
export type TodoItem = {
    id: string;
    text: string;
    completed: boolean;
};

// The model-facing arguments. Only `action` is required; each action reads the
// fields it needs (add → text, remove/check/uncheck → id, check → completed).
export type TodoParameters = {
    action: TodoAction;
    text?: string;
    id?: string;
    completed?: boolean;
};

// Counts are derived on every call so the model does not have to list and count.
export type TodoCounts = {
    total: number;
    completed: number;
    remaining: number;
};

// Every todoManage result is a snapshot: `todos` is always a copy of the current
// list, plus the affected item and/or counts. `todo` is present for add/check/
// uncheck, `removed` for remove.
export type TodoResult = {
    todos: TodoItem[];
    todo?: TodoItem;
    removed?: TodoItem;
    counts: TodoCounts;
};

// What createTodoTool() returns: the core tool plus the reset hook a harness
// stores with its own handle. State lives in the factory closure, never in a
// module singleton, so two harnesses cannot share todos.
export type TodoToolset = {
    tool: Tool<TodoParameters, TodoResult>;
    reset: () => void;
};

// ---------------------------------------------------------------------------
// profileManage / chapterManage / locationManage (per-harness session records)
// ---------------------------------------------------------------------------
//
// Three session record tools follow todoManage's lifecycle exactly:
//   - one factory closure per harness (src/core/profile.ts, chapter.ts,
//     location.ts), never a module singleton;
//   - state is shared by every agent in that harness and cleared by reset();
//   - ids are stable decimal strings, monotonic per instance, restarting at "1"
//     after reset();
//   - every mutating action validates completely before touching the store, so a
//     rejected call leaves the records exactly as they were;
//   - every result is a defensive copy: `item`, `item.traits`, and the collection
//     snapshot never alias live state.
//
// The action set is identical for all three tools. `update` is partial: only the
// fields present in the arguments change. `get` returns one record, and for
// chapters it is the ONLY action that returns the body (lists and mutation
// results carry summaries, so a long chapter cannot flood the context).
//
// Cross-references:
//   - ../core/profile.ts, ../core/chapter.ts, ../core/location.ts — implementations
//   - ../core/metadata.ts — names, descriptions, and JSON Schemas
//   - ../harness.ts — registration, reservation, and reset wiring

// The shared CRUD action set. `add` creates, `list` snapshots, `get` reads one,
// `update` patches one (partial), `remove` deletes one.
export type RecordAction = 'add' | 'list' | 'get' | 'update' | 'remove';

// ---------------------------------------------------------------------------
// profileManage — characters / people
// ---------------------------------------------------------------------------

// A stored profile. `traits` and `notes` are always present (empty when the
// caller did not supply them) so a model sees one stable shape. `traits` are
// trimmed and deduplicated on write; `notes` is free-form text.
export type ProfileItem = {
    id: string;
    name: string;
    description: string;
    traits: string[];
    notes: string;
};

// Model-facing arguments. `action` is the only required property; each action
// reads the fields it needs (add → name + description, get/update/remove → id,
// update → at least one mutable field).
export type ProfileParameters = {
    action: RecordAction;
    id?: string;
    name?: string;
    description?: string;
    traits?: string[];
    notes?: string;
};

// Counts are derived on every call, like TodoCounts.
export type ProfileCounts = {
    total: number;
};

// Every profileManage result is a snapshot: `profiles` is a copied list, plus the
// affected profile for add/get/update and `removed` for remove.
export type ProfileResult = {
    profiles: ProfileItem[];
    profile?: ProfileItem;
    removed?: ProfileItem;
    counts: ProfileCounts;
};

// What createProfileTool() returns: the core tool plus reset().
export type ProfileToolset = {
    tool: Tool<ProfileParameters, ProfileResult>;
    reset: () => void;
};

// ---------------------------------------------------------------------------
// chapterManage — ordered chapter tracking
// ---------------------------------------------------------------------------

// The three lifecycle states a chapter can be in. No other values are accepted.
export type ChapterStatus = 'planned' | 'draft' | 'complete';

// A chapter as it appears in a LIST or in a mutation result: metadata only. The
// body is deliberately absent so a long chapter does not flood the context;
// `get` supplies it separately. `order` is optional and omitted when unset.
export type ChapterSummary = {
    id: string;
    title: string;
    summary: string;
    status: ChapterStatus;
    order?: number;
};

// The full stored chapter, including the body. Only createChapterTool()'s
// internal store and the `get` action ever touch `content`.
export type ChapterItem = ChapterSummary & {
    content: string;
};

// Model-facing arguments. `add` requires title + summary; content, status, and
// order are optional (status defaults to 'planned').
export type ChapterParameters = {
    action: RecordAction;
    id?: string;
    title?: string;
    summary?: string;
    content?: string;
    status?: ChapterStatus;
    order?: number;
};

// Per-status totals derived on every call.
export type ChapterCounts = {
    total: number;
    planned: number;
    draft: number;
    complete: number;
};

// Every chapterManage result is a snapshot of summaries. `content` is present
// only for `get`; `chapter` for add/get/update; `removed` for remove.
export type ChapterResult = {
    chapters: ChapterSummary[];
    chapter?: ChapterSummary;
    content?: string;
    removed?: ChapterSummary;
    counts: ChapterCounts;
};

// What createChapterTool() returns: the core tool plus reset().
export type ChapterToolset = {
    tool: Tool<ChapterParameters, ChapterResult>;
    reset: () => void;
};

// ---------------------------------------------------------------------------
// locationManage — places / settings
// ---------------------------------------------------------------------------

// A stored location. `notes` is always present (empty when not supplied) for a
// stable shape.
export type LocationItem = {
    id: string;
    name: string;
    description: string;
    notes: string;
};

// Model-facing arguments. `add` requires name + description; notes is optional.
export type LocationParameters = {
    action: RecordAction;
    id?: string;
    name?: string;
    description?: string;
    notes?: string;
};

// Counts are derived on every call, like TodoCounts.
export type LocationCounts = {
    total: number;
};

// Every locationManage result is a snapshot: `locations` is a copied list, plus
// the affected location for add/get/update and `removed` for remove.
export type LocationResult = {
    locations: LocationItem[];
    location?: LocationItem;
    removed?: LocationItem;
    counts: LocationCounts;
};

// What createLocationTool() returns: the core tool plus reset().
export type LocationToolset = {
    tool: Tool<LocationParameters, LocationResult>;
    reset: () => void;
};

// What a tool implementation is handed when the model calls it.
//
// The harness fields are optional because a tool can also be executed on its
// own: `fileRead(['package.json'])` runs the same implementation with no agent, no
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
// the tool, so `webSearch: tool({...})` is enough.
export type ToolConfiguration<TParameters = any, TResult = any> = {
    name?: string;
    // Shown to the model. Required — an undescribed tool is an unusable tool.
    description: string;
    // Capability tags, used by tool discovery to find close matches. Required:
    // an untagged tool is invisible to toolRequest, so it could never be found.
    // Stored trimmed, lowercased, and deduplicated.
    tags: readonly string[];
    // 'core' tools are declared on every request; 'searchable' ones (the
    // default) stay hidden until toolRequest enables them.
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
//     const fileRead = tool<string[], FileReadResult>({...});
//     await fileRead(['package.json']);        // direct, no harness
//     harness({ tools: { fileRead } });        // the model calls it
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
// Web search (opt-in)
// ---------------------------------------------------------------------------
//
// One model-facing tool, `webSearch`, backed by a hosted search API. The keys are
// provider credentials, so they are resolved once at harness construction and
// never appear in a tool schema, argument, result, or progress event (W3).
//
// Cross-references:
//   - tools/websearch/index.ts  — createWebSearchTool, the per-harness factory
//   - harness.ts                — `websearch` configuration field wiring
export type WebsearchProvider = 'exa' | 'tavily';

// A key, or a getter that reads it from a store when the harness is constructed.
// A getter is called once per harness construction and the captured key serves
// every search (no per-request rotation), so `process.env` is never read per call
// and two harnesses can hold different keys.
export type WebsearchCredential = string | (() => string | undefined);

export type WebsearchProviderConfiguration = {
    // Explicit override for this provider. When omitted the factory reads the
    // provider's environment variable (EXA_API_KEY / TAVILY_API_KEY) instead.
    apiKey?: WebsearchCredential;
};

export type WebsearchConfiguration = {
    // Environment snapshot to read the two key variables from. Tests and
    // deployments can inject one; the default is `process.env` (never a dotenv
    // autoload — the caller owns that).
    env?: Readonly<Record<string, string | undefined>>;
    // Explicit per-provider keys. A provider with no key (here or in `env`) is
    // simply absent: it is not registered and not offered to the model.
    exa?: WebsearchProviderConfiguration;
    tavily?: WebsearchProviderConfiguration;
};

// The model-facing argument shape. `query` is the only required property; having
// more than one property keeps the object wrapper intact (see the single-property
// rule in core/tool.ts), and both optional fields are validated in execute.
export type WebSearchParameters = {
    query: string;
    // Requested result count. Defaults to 5 and is clamped to 1–20.
    maxResults?: number;
    // Which configured provider to use. Omitted = the first configured one
    // (Exa before Tavily), so a single-key setup needs no decision.
    provider?: WebsearchProvider;
};

// One normalized result. Every field is present (possibly empty) so the model
// sees a stable shape regardless of provider. `snippet` is the provider's
// highlight/content excerpt, truncated and treated as untrusted data.
export type WebSearchMatch = {
    title: string;
    url: string;
    snippet: string;
    // Provider-reported publication date, when it sends one.
    published?: string;
};

export type WebSearchResult = {
    provider: WebsearchProvider;
    query: string;
    // The count actually requested from the provider, after clamping.
    maxResults: number;
    results: WebSearchMatch[];
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
    // `callId` is the id of the tool_call this result answers. Optional so an
    // older recorded event (or a hand-written progress reporter) stays valid, and
    // so a same-name pairing in a UI can be exact instead of positional.
    | {
          type: 'tool_result';
          agent: string;
          name: string;
          callId?: string;
          content: string;
          isError: boolean;
          // Optional declarative panels a tool supplied with `toolUi()`. The
          // `content` above is always the underlying value, and the model never
          // sees this field: it is presentation data for the client only. Absent
          // for every ordinary tool, so recorded events keep their old shape.
          ui?: ToolUiPanel[];
      }
    // Per-request token accounting, emitted once for EVERY model request a run
    // makes — including the tool rounds that keep the loop going. `done` only
    // ever reports the FINAL request of an agent run, so without this event a
    // client can only see the last step's tokens, never the cost of the run.
    // Absent entirely when the provider reported no usage for that request (a
    // gateway that sends no `usage` block); a run may therefore report some
    // requests and not others.
    | { type: 'usage'; agent: string; usage: HarnessUsage }
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
    // or the `agentDelegate` tool the primary agent gets.
    agents: Record<string, Agent>;
    // Which agent the callable runs. Defaults to the first entry of `agents`, so
    // a single-agent config needs nothing. Must name a registered agent.
    primary?: string;
    // Agents the primary agent may delegate to. Defaults to every agent except
    // the primary. When the list is empty there is no delegation at all and the
    // `agentDelegate` tool is not registered. Subagents never receive it, so
    // delegation is one level deep by construction.
    subagents?: readonly string[];

    // Maximum number of tool rounds one agent run may take before the harness
    // treats it as a runaway loop: history is truncated back to the start of the
    // call and the harness throws. Defaults to 16, the library guard. Must be a
    // positive safe integer; validated at construction so a typo fails before a
    // long run. There is no "unlimited" value. The same bound applies to every run
    // in this harness (entry, ctx.run, and delegated subagents); each run gets its
    // own budget. The bundled application presets set 1000 for real work — see
    // harnesses/presets.ts.
    maxIterations?: number;

    // Every tool the harness can run. Keyed by the name the model calls. Only
    // `visibility: 'core'` tools are declared up front; the rest are found
    // through the built-in toolRequest tool and enabled for the next turn.
    tools?: Record<string, Tool>;
    // Preload the bundled preset catalogue (src/tools/) into the registry. True by
    // default: discovery exists so a large catalogue costs nothing until it is
    // asked for. Set false to start from `tools` alone. A configured tool wins on
    // a name collision.
    presets?: boolean;
    // Opt-in web search. `true` reads EXA_API_KEY / TAVILY_API_KEY from this
    // process's environment and registers one searchable `webSearch` tool; an
    // object does the same with an injected env or explicit key overrides. Off
    // when absent or false, and absent when neither key is present — so a
    // default harness never carries a network tool it cannot use. Secrets stay in
    // the constructed tool closure: no schema value, argument, result, or event
    // carries them. A configured tool named `webSearch` wins over this field.
    websearch?: boolean | WebsearchConfiguration;
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
    // built-in toolRequest, toolCreate, todoManage, profileManage,
    // chapterManage, and locationManage entries, plus agentDelegate when there
    // is at least one subagent.
    readonly tools: Readonly<Record<string, Tool>>;
    // Register a tool from source at runtime. This is the host-side path the
    // model-facing toolCreate tool uses: same validation, same registry, same
    // "searchable and enabled at once" behaviour. Throws HarnessError on invalid
    // or colliding input, so a host sees creation failures as exceptions.
    toolCreate: (configuration: ToolCreation) => Tool;
    // Execute one registered tool by name, outside the model's discovery gate
    // (R8). This is the server/host path for an EXPLICIT user action — the CLI or
    // the UI's Tools tab — and it runs the SAME session-bound implementation the
    // model calls, so discovery, runtime creation, todos, and delegation all
    // mutate this harness exactly as they would during a run.
    //
    // `parameters` is the value `execute` receives, i.e. already unwrapped by the
    // single-property rule: `executeTool('fileRead', ['package.json'])`, never
    // `{ paths: ['package.json'] }` for a one-property schema. Same convention as the
    // tool's direct callable.
    //
    // GATING: discovery gates the MODEL, not its operator. A searchable tool that
    // toolRequest has not enabled is still runnable here; the model remains
    // unable to call it. Reserved policy is NOT bypassed: `toolCreate` here goes
    // through the same validated registration path (budget, name rules,
    // collisions, compilation), and `agentDelegate` still requires a harness that
    // actually registered it (no subagents means no agentDelegate tool).
    //
    // Throws HarnessError when the name is not registered in this harness, or
    // whatever the implementation throws; unlike the model path there is no
    // tool-result envelope, because a host caller can see an exception.
    executeTool: (name: string, parameters: unknown) => Promise<unknown>;
    // Names of the applied plugins, in order.
    readonly plugins: readonly string[];
    // Names of the tools toolRequest has enabled so far, in discovery order.
    // Persists for the harness's lifetime (not just one call), which is what lets a
    // later turn call a tool discovered earlier. Copied on read; `reset()` empties
    // it.
    readonly discoveredTools: string[];
    // Reset the entry agent's conversation, forget which tools toolRequest had
    // enabled, and clear the session todo list, so the next run starts from the
    // core set again. Created tools stay registered (they are part of the
    // catalogue), just not enabled.
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

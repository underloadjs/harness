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

// One composer attachment carried with a user message (T3 clip/attach feature).
//
// `data` is RAW canonical base64 of the file bytes — never a `data:` URL, a
// filesystem path, or an HTTP URL. `size` is the DECODED byte length and must
// agree with `data`. `marker` is the exact text label the composer inserted into
// the prompt (e.g. "[Image 1]"); the transport uses it to place the media part at
// the position the user referenced. Validation and limits live in
// shared/attachments.ts (validateAttachments); this type is the single shape
// owner for server, frontend, snapshot, and transport.
export type HarnessAttachment = {
    // Stable, opaque, unique within one turn (used by the client to update a
    // preview in place and by snapshots to round-trip).
    id: string;
    // What the attachment IS. `file` is representable but not transportable:
    // the transport refuses it with an explicit unsupported error rather than
    // stringifying binary data.
    kind: 'image' | 'video' | 'audio' | 'pdf' | 'file';
    // The text marker as it appears in the user prompt: "[Image 1]".
    marker: string;
    // Plain file name only (used as the provider's file filename). No paths/URLs.
    name: string;
    // Lowercase MIME type without parameters, e.g. "image/png" or "application/pdf".
    mime: string;
    // Decoded byte length of `data`.
    size: number;
    // Raw canonical base64 bytes (no prefix, no whitespace).
    data: string;
};

// A tool invocation requested by the model. `arguments` stays a raw JSON string
// because that is what the wire protocol delivers, and because malformed JSON is
// the harness's problem to report back to the model rather than a parse crash.
//
// `id` must be unique across the whole CONVERSATION, not just the turn: the harness
// keys scheduled work and paired tool results by it. A turn that repeats an id, or
// reuses one already committed, is rejected before any call executes (the run rolls
// back) rather than letting one result silently alias another.
export type HarnessToolCall = {
    id: string;
    name: string;
    arguments: string;
};

// One transcript entry, in the shape the harness manipulates internally. The
// transport maps these onto the provider's wire format (see transport.ts).
export type HarnessMessage =
    | { role: 'system'; content: string }
    | {
          role: 'user';
          content: string;
          // Composer attachments referenced by `marker` inside `content`. Optional
          // and omitted for a text-only user message, so every pre-attachment
          // transcript (and snapshot) keeps its exact old shape.
          //
          // Validated and deep-copied before any append (core/agent.ts,
          // harness.ts, core/snapshot.ts) and mapped to provider parts by the
          // transport (transport/openai.ts).
          attachments?: HarnessAttachment[];
      }
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

// One background tool call that is still running when a model request is made or
// a run pauses. This is the PUBLIC, wire-safe view of in-flight work: ids plus a
// monotonic elapsed time, never a promise, controller, or tool implementation.
//
// `elapsedMs` is measured from the moment the call was LAUNCHED (not from the
// model request), so a client can render "running for 12s" without keeping a
// clock of its own. The harness supplies it on `tool_result.pending`,
// `done.pending`, and the `wakeup` event.
export type HarnessPendingTool = {
    callId: string;
    name: string;
    elapsedMs: number;
};

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
    // Attachments for the user message that stream(input, options) appends.
    // `turn()` ignores them: it never appends a user message. Validated before
    // the append (core/agent.ts), so malformed bytes never mutate history.
    //
    // The harness validates the root run's attachments once in harness.ts and
    // passes them through here; nested subagent runs never inherit them.
    attachments?: HarnessAttachment[];
    // Tool declarations forwarded with the request. Standalone callers pass these
    // and write the execution loop themselves; the harness supplies its whole
    // registry automatically.
    tools?: HarnessStreamTool[];
    // Provider-safe transcript projection (background tools). When present, this
    // REPLACES the agent's committed messages for THIS request only; the assistant
    // message still commits to the agent's canonical history. The harness uses it
    // to answer tool calls that are still running with placeholder results without
    // making those placeholders part of the transcript (and therefore without
    // persisting them or pairing them with a later real result).
    //
    // Standalone callers never need this: omit it and the request uses history.
    transcript?: HarnessMessage[];
    // Harness-internal commit guard. Invoked immediately before this turn's
    // assistant message is appended to the canonical history; throwing aborts the
    // turn with NO commit. The harness uses it to make cancellation preemptive: a
    // transport that ignores its abort signal may finish later, but a run that no
    // longer owns the actor (aborted/released) must not mutate the transcript a
    // later run is using.
    //
    // Standalone callers omit it; `agent.turn`/`agent.stream` keep their historical
    // behaviour.
    precommit?: () => void;
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
    // Append a user message. The optional attachments are validated and copied
    // before the append; omit them for the historical text-only call.
    user: (content: string, attachments?: HarnessAttachment[]) => Agent;
    assistant: (content: string, toolCalls?: HarnessToolCall[]) => Agent;
    // Append the input, then run one turn. Commits the turn atomically: on
    // failure history is truncated back to where it was.
    stream: (input: string, options?: AgentStreamOptions) => AsyncIterable<AgentStreamEvent>;
    // Run one turn against the current history, without appending a user
    // message. This is the primitive the harness loop re-requests with after a
    // tool result. Throws on failure.
    turn: (options?: AgentStreamOptions) => AsyncIterable<AgentStreamEvent>;
    // N3: create a PRIVATE branch that owns a detached copy of this agent's
    // entire committed history, model value, instructions and reset baseline.
    // It shares the transport (and therefore provider credentials / external
    // tool side effects), never a sandbox. Tool-call ids are remapped
    // deterministically and pending calls are paired with explicit non-success
    // placeholders; this agent's own transcript is never touched. `label` is
    // display metadata only. Branch identity/depth is available through the
    // internal `agentBranchOf` accessor (core/index), not on this public type.
    fork: (options?: { label?: string }) => Agent;
    // Restore history to the seeded instructions and reset the model. For a
    // fork this restores the branch's DETACHED baseline (its cloned history at
    // fork time), never the live source history.
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
    // Query tags that matched no tag, name, or description in the SEARCHABLE
    // catalogue and no tag or name among the core tools the caller already has
    // declared (see ToolSearchOptions.declared). A tag that only names an
    // already-available core tool is therefore NOT reported as unmatched, so the
    // model is never told a capability it can already call is absent.
    unmatchedTags?: string[];
    // Every tag in the searchable catalogue. Present only when nothing matched,
    // so the model can retry with real vocabulary instead of guessing.
    availableTags?: string[];
    // Where this page starts in the ranked match list. Present only for a LATER
    // page (progressive discovery, R12): repeating an identical query advances by
    // one capped page, and this field reports the position so the model can tell
    // a fresh shortlist from a continued one. Absent on the first page, so an
    // existing first-page result keeps its exact shape.
    offset?: number;
    // Retained for compatibility: true exactly when `remaining > 0`.
    truncated?: boolean;
    // Core tools the CALLER already has declared and that match the query — they
    // can be called directly right now. Reported, never enabled: they are already
    // in every request's declarations, so putting them in `enabled`/`tools` would
    // spend the discovery budget (MAX_DISCOVERY_MATCHES) and imply a new grant.
    //
    // Present only when at least one core tool matches, so an ordinary result keeps
    // its old exact shape. The harness supplies only the core tools VISIBLE to the
    // calling agent (agentDelegate is excluded for subagents, toolCreate under the
    // 'primary' policy too), which is what keeps this list honest rather than a
    // registry dump.
    alreadyAvailable?: ToolMatch[];
};

// Optional context for `searchTools()`. Purely additive: a caller that omits it
// gets the pre-existing searchable-only ranking, byte for byte.
export type ToolSearchOptions = {
    // Core tools the caller considers already declared. Discovery never ranks them
    // as enable candidates; it scores their wire NAME and TAGS (never their
    // description, which mentions everyday words and would match almost anything)
    // and reports the hits as `alreadyAvailable`.
    declared?: readonly Tool[];
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

// Who may create tools at runtime (R12). See HarnessConfiguration.toolCreation:
// 'all' (default, every agent), 'primary' (primary only; subagents neither see
// nor can call the tool), false (no model-facing toolCreate at all — the host
// `harness.toolCreate()` path remains available).
export type ToolCreationPolicy = 'all' | 'primary' | false;

// What a delegation hands back to the primary agent: the subagent's answer, not
// its transcript (history stays with the subagent).
export type HarnessDelegationResult = {
    agent: string;
    content: string;
};

// ---------------------------------------------------------------------------
// actionRequest / threadFork / branches (N3)
// ---------------------------------------------------------------------------
//
// actionRequest lets a model stop and ask its OWNER a bounded question when the
// request is genuinely ambiguous. The model always supplies alternatives plus a
// recommended option; it can never force the owner to accept the recommendation
// (there is no silent fallback), and the owner may always answer with free text
// because `allowCustom` is a type-level `true`, not a model-controlled argument.
//
// threadFork copies an agent's ENTIRE committed history into a private branch so
// another thread can read that history independently and return one summary. A
// branch is not a sandbox: it shares the source agent's transport and the host's
// external tool side effects. It owns a detached transcript and reset baseline.
//
// Cross-references:
//   - ../core/action.ts   — strict runtime parsing for both wire shapes
//   - ../core/branch.ts   — fork identity, tool-id materializer, branch bounds
//   - ../core/agent.ts    — Agent.fork()
//   - ../core/metadata.ts — actionRequest / threadFork schemas
//   - ../harness.ts       — runtime that creates/records branches (later worker)

// One choice the model offers the owner. `id` is the stable value a reply names;
// `label` is what a UI shows. `description` is optional supporting detail.
export type HarnessActionOption = {
    id: string;
    label: string;
    description?: string;
};

// The model-facing request. `recommended` MUST be one of the option ids: the
// parser rejects an unknown id rather than silently falling back to options[0],
// so a UI can always highlight a real recommendation.
export type HarnessActionRequest = {
    // Generated by the runtime, never by the model.
    requestId: string;
    question: string;
    recommended: string;
    options: HarnessActionOption[];
    // Always true. Custom free-text answers are part of the contract, not a
    // switch the model may disable.
    allowCustom: true;
};

// The answer itself, as chosen by an owner (human/host) or the automatic owner
// fork. Either an option id or free text; never both.
export type HarnessActionChoice =
    | { kind: 'option'; optionId: string }
    | { kind: 'custom'; text: string };

// Recorded answer envelope. `source` says who answered; `branchId` is present
// only when an automatic owner fork answered.
export type HarnessActionAnswer = {
    requestId: string;
    choice: HarnessActionChoice;
    source: 'owner' | 'auto';
    branchId?: string;
};

// The tool result handed back to the requesting model. Option choices carry the
// resolved label/description so the model sees the human-visible wording even
// though it only sent an id.
export type HarnessActionResult = {
    requestId: string;
    answeredBy: 'owner' | 'auto';
    choice:
        | { kind: 'option'; optionId: string; label: string; description?: string }
        | { kind: 'custom'; text: string };
};

// What a host action handler sees. `agent`/`branchId`/`threadId`/`callId`
// identify the requester precisely; `request` is already parsed and validated.
export type HarnessActionRequestContext = {
    requestId: string;
    agent: string;
    branchId?: string;
    threadId?: string;
    callId: string;
    request: HarnessActionRequest;
};

// A host-supplied answerer. The signal aborts with the run; a handler that
// rejects fails the actionRequest call (the model receives the error).
export type HarnessActionHandler = (
    context: HarnessActionRequestContext,
    signal: AbortSignal
) => Promise<HarnessActionChoice>;

// What threadFork returns to the requesting thread: an identity plus the final
// summary content. The full transcript stays in `harness.branch(branchId)`.
export type HarnessForkResult = {
    branchId: string;
    threadId: string;
    content: string;
};

// The public, bounded description of one branch. `role` is the source agent's
// role in the harness, `tools` the wire names that branch could call. `forkDepth`
// counts ordinary forks (1 = a fork of a root); autoanswer branches inherit their
// source depth because they do not consume a general nesting level.
export type HarnessBranchSummary = {
    branchId: string;
    kind: 'fork' | 'autoanswer';
    agent: string;
    role: 'primary' | 'subagent';
    sourceBranchId?: string;
    sourceThreadId?: string;
    callId?: string;
    requestId?: string;
    forkDepth: number;
    model: string;
    tools: string[];
};

// Lifecycle of one branch record. `running` is the only non-terminal state.
export type HarnessBranchStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// The terminal statuses a `branch_end` event may report.
export type HarnessBranchTerminalStatus = Exclude<HarnessBranchStatus, 'running'>;

// A branch record is a SUMMARY plus the branch's own committed transcript and
// the deterministic origin→branch tool-id mapping the materializer produced.
// It is runtime/session state, deliberately NOT part of snapshot v1.
export type HarnessBranchRecord = HarnessBranchSummary & {
    status: HarnessBranchStatus;
    // Deterministic provider-safe remap for every tool call in `messages`.
    // `origin` is the id in the source transcript; `branch` is the id this
    // branch uses. Empty for a branch with no tool calls.
    toolCallIds: Array<{ origin: string; branch: string }>;
    // The branch's entire committed transcript (cloned, remapped and with
    // pending calls paired by an explicit non-success placeholder). Never a
    // reference to the owner's live array.
    messages: HarnessMessage[];
    // Present when the branch finished normally.
    result?: { content: string; stopReason: HarnessStopReason };
    // Present when the branch failed or was cancelled.
    error?: HarnessErrorInfo;
};

// Fork/branch bounds. Every field is optional; the defaults are the frozen
// values in ../core/branch.ts (maxDepth 2, maxConcurrent 4, maxHistoryBytes
// 8 MiB, maxBranchRecords 64).
export type HarnessForkConfiguration = {
    enabled?: boolean;
    maxDepth?: number;
    maxConcurrent?: number;
    maxHistoryBytes?: number;
    maxBranchRecords?: number;
};

// Owner interaction. `actionRequest` installs the host answerer; `autoAnswer`
// lets an owner fork answer tool-free when no handler is available. Neither
// enables the tool by itself: the harness registers `actionRequest` only when
// interaction is configured.
export type HarnessInteractionConfiguration = {
    actionRequest?: HarnessActionHandler;
    autoAnswer?: boolean;
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

// The complete restorable todo store (R3a). `nextId` is persisted so a resumed
// session cannot reuse an id that already exists in `items`; both fields are
// validated by core/todo.ts before a restore mutates anything.
export type TodoStoreState = {
    items: TodoItem[];
    nextId: number;
};

// Every todoManage result is a bounded page or a single mutation result; the
// canonical types live in ./core/todo.ts and are re-exported below (R9).

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

// The complete restorable profile store (R3a), matching TodoStoreState.
export type ProfileStoreState = {
    items: ProfileItem[];
    nextId: number;
};

// R9: result and toolset shapes are OWNED by ./core/todo.ts, ./core/profile.ts,
// ./core/chapter.ts, and ./core/location.ts (they build the bounded pages), and
// re-exported here so the public surface cannot drift. Type-only, so there is no
// runtime cycle even though those modules import their item/parameter types from
// this file.
export type {
    TodoPageInfo,
    TodoListResult,
    TodoChangeResult,
    TodoResult,
    TodoToolset
} from '../core/todo';
export type {
    ProfilePageInfo,
    ProfileListResult,
    ProfileChangeResult,
    ProfileResult,
    ProfileToolset
} from '../core/profile';
export type {
    ChapterPageInfo,
    ChapterListResult,
    ChapterChangeResult,
    ChapterResult,
    ChapterToolset
} from '../core/chapter';
export type {
    LocationPageInfo,
    LocationListResult,
    LocationChangeResult,
    LocationResult,
    LocationToolset
} from '../core/location';

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

// The complete restorable chapter store (R3a). `content` is included here even
// though lists and mutation results carry summaries: a resumed session must not
// lose chapter bodies.
export type ChapterStoreState = {
    items: ChapterItem[];
    nextId: number;
};

// Every chapterManage result is a bounded page of summaries or one mutation
// result; `content` is present only for `get`. Canonical types: ./core/chapter.ts.

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

// The complete restorable location store (R3a), matching TodoStoreState.
export type LocationStoreState = {
    items: LocationItem[];
    nextId: number;
};

// Every locationManage result is a bounded page or one mutation result; canonical
// types live in ./core/location.ts and are re-exported above (R9).

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
    // Cancellation for the run that invoked this tool (R10), forwarded from
    // `HarnessRunOptions.signal`. Present for every HARNESS invocation (a direct
    // standalone call has none).
    //
    // BACKGROUND TOOLS (T3): this is a PER-CALL controller linked to the run's
    // signal, not the run signal itself. Aborting it cancels just this call (the
    // model's `toolCancel`), while a run-level abort still reaches every call.
    // The harness releases a cancelled call logically even if the implementation
    // ignores the signal; a late result is discarded.
    //
    // A tool SHOULD observe it (pass it to fetch/spawn, or call throwIfAborted()
    // between steps): the harness cannot preempt arbitrary JavaScript, so a tool
    // that ignores it keeps running to completion after a cancel. That is
    // deliberate — the harness never claims to have stopped side effects it does
    // not control.
    signal?: AbortSignal;
    // How deep the calling run is: 1 = a top-level run, 2 = a delegated/ctx.run
    // child. Present for every harness invocation. The model-facing agentDelegate
    // tool uses it to keep delegation one level deep even when the primary agent
    // is itself being driven as somebody else's subagent.
    runDepth?: number;
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

// Identity of ONE non-root invocation (T3 UI threads). A client groups every
// event of one subagent run into a row by `id`, indents it under `parentId`, and
// anchors it to the tool call that started it (`callId`).
//
// Contract (frozen additive shape):
//   - emitted for NON-ROOT runs only; a root run is the turn itself and its
//     events keep their historical shape (no `thread`);
//   - `id` is stable for the whole invocation and unique within the owning
//     SessionTurn (the run sequence is monotonic), so two sequential
//     delegations to the SAME agent get different ids;
//   - `parentId` is omitted for a direct child of the root and set to the
//     parent invocation's thread id for anything deeper;
//   - `callId` is the parent tool call that spawned this run;
//   - `input` (the child prompt, for a row title/body) appears on the `start`
//     event only; later events carry the identity fields alone.
export type HarnessThread = {
    id: string;
    parentId?: string;
    callId?: string;
    input?: string;
    // N3: what spawned this NON-ROOT invocation.
    //   - 'delegation' — an ordinary agentDelegate / ctx.run child;
    //   - 'fork'       — a threadFork branch that reads the owner history;
    //   - 'autoanswer' — a tool-free owner fork answering an actionRequest.
    // Omitted for historical recorded turns (they predate this field) and may be
    // omitted by a hand-written reporter, so readers must not require it.
    kind?: 'delegation' | 'fork' | 'autoanswer';
    // Branch identity for a fork/autoanswer thread. Absent for a delegation
    // thread and for every pre-branch recorded event. This is the SAME id the
    // branch events and `harness.branch(id)` use; a thread does not invent a
    // second naming scheme.
    branchId?: string;
};

// Every event variant carries the SAME optional field (spelled out per variant so
// `HarnessEvent` stays a plain discriminated union: `Extract<HarnessEvent, {type:
// 'x'}>` and `event.type` narrowing keep working for clients). Optional because
// root events and older recorded turns have none, and a hand-written reporter may
// omit it.
//
// Progress events. Every one names its agent so a multi-agent run stays readable
// in a single console stream. This is the whole reporting surface: a UI or a
// `console.log` sees exactly the steps below. `thread` is present only for
// NON-ROOT runs; see HarnessThread.
export type HarnessEvent =
    | { type: 'start'; agent: string; model: string; thread?: HarnessThread }
    | { type: 'text'; agent: string; delta: string; thread?: HarnessThread }
    | { type: 'reasoning'; agent: string; delta: string; thread?: HarnessThread }
    | { type: 'tool_call'; agent: string; call: HarnessToolCall; thread?: HarnessThread }
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
          // Wall-clock duration of the call, measured from launch to delivery.
          // Present for every EXECUTED call (including one that settled in the same
          // turn; an inline call is a real sub-millisecond measurement, not a
          // different kind of call). An immediate validation failure never reached
          // execution and has no duration; a control result such as toolCancel
          // reports its zero span explicitly.
          durationMs?: number;
          // Tool calls that were STILL RUNNING for this agent when this result was
          // delivered. Absent when none remain, so a run with no background work
          // keeps its historical event shape. Elapsed times let a UI show progress
          // without polling.
          pending?: HarnessPendingTool[];
          // Invocation identity of the (non-root) agent whose call this answers.
          thread?: HarnessThread;
      }
    // Per-request token accounting, emitted once for EVERY model request a run
    // makes - including the tool rounds, pauses with pending work, and wake-driven
    // turns that keep the loop going. `done` reports the response too, but it may be
    // a PAUSED response (`pending` non-empty) or be omitted for a superseded one, so
    // the usage events - not `done` - are the complete cost record. Absent entirely
    // when the provider reported no usage for that request (a gateway that sends no
    // `usage` block); a run may therefore report some requests and not others.
    | { type: 'usage'; agent: string; usage: HarnessUsage; thread?: HarnessThread }
    // A model response. `pending` non-empty means the run is NOT terminal: those
    // calls are still running, the harness stays open, and their completions will
    // drive further turns. Absent when the response has no background work left,
    // so an ordinary answer keeps its old shape and its old meaning.
    //
    // A response that is immediately superseded by a completion which arrived
    // while its request was in flight emits no `done` at all (it was an
    // intermediate turn, like a tool-call turn), so `done` always describes a
    // response the consumer is meant to see.
    | {
          type: 'done';
          agent: string;
          message: HarnessAssistantMessage;
          pending?: HarnessPendingTool[];
          thread?: HarnessThread;
      }
    // Recurring heartbeat while background calls are pending (R4): the configured
    // wake interval (default 600000 ms = 10 minutes) has elapsed. The run is
    // re-requested with the current pending list, so the model can inspect
    // elapsed times and cancel a hung call through `toolCancel`. This is a
    // PROGRESS event, not a transcript entry.
    | {
          type: 'wakeup';
          agent: string;
          reason: 'pending-tools';
          pending: HarnessPendingTool[];
          thread?: HarnessThread;
      }
    // N3: the model asked its owner a bounded question. `callId` is the
    // actionRequest tool call; `request` is already parsed and bounds-checked.
    | {
          type: 'action_request';
          agent: string;
          callId: string;
          request: HarnessActionRequest;
          thread?: HarnessThread;
      }
    // N3: an answer was recorded (owner or automatic). Emitted for every
    // accepted answer, including a custom one, so a client can resolve the
    // pending card without polling.
    | {
          type: 'action_answer';
          agent: string;
          requestId: string;
          answer: HarnessActionAnswer;
          thread?: HarnessThread;
      }
    // N3: a fork/autoanswer branch started. `branch` is the summary a client can
    // use before the branch transcript exists.
    | {
          type: 'branch_start';
          agent: string;
          branch: HarnessBranchSummary;
          thread?: HarnessThread;
      }
    // N3: a branch reached a terminal state. `error` is present for a failed or
    // cancelled branch, and absent for a completed one.
    | {
          type: 'branch_end';
          agent: string;
          branchId: string;
          status: HarnessBranchTerminalStatus;
          error?: HarnessErrorInfo;
          thread?: HarnessThread;
      }
    | { type: 'error'; agent: string; error: HarnessErrorInfo; thread?: HarnessThread };

export type HarnessProgress = (event: HarnessEvent) => void | Promise<void>;

// Optional persistence observer (R3a/T3 addendum). It fires AFTER a mutation that
// the snapshot below would record — agent history, discovery, created tools, the
// session record stores, reset, and restore — so a server can save without waiting
// for session close. It is deliberately NOT a second event stream: there is no
// ordering contract, no payload of changed data, and no replay. A callback that
// throws is ignored (see harness.ts), so a failing persistence layer can never
// change harness behaviour or turn a completed tool call into a failure.
//
// `reason` is a coarse hint for coalescing/debouncing a save; the authoritative
// state is always `harness.snapshot()`. The callback may call snapshot()
// synchronously, INCLUDING during an active run: it runs immediately after the
// mutation, so completed store changes and their tool-result message are captured
// together (T16).
//
// Observable gaps a caller must handle itself:
//   - direct `agent.user()/.assistant()/.model()` calls outside harness methods;
//   - `agent.messages` mutated by a tool or host code directly;
//   - text/reasoning deltas that are not committed to agent.messages yet (they are
//     progress events, not snapshot state; snapshot() never includes partial text);
//   - any mutation made before the callback was configured (take a snapshot).
// These are documented rather than papered over, because the harness cannot
// intercept its own public objects without wrapping them.
export type HarnessStateChangeReason =
    | 'agent_message'
    | 'tool_execute'
    | 'tool_create'
    | 'reset'
    | 'restore';

export type HarnessStateChangeEvent = {
    type: 'state_change';
    reason: HarnessStateChangeReason;
    // The agent whose history changed, when the reason names one.
    agent?: string;
    // The tool whose execution/create caused the change, when applicable.
    tool?: string;
    // N3: the branch whose transcript changed, when the change belongs to a
    // fork/autoanswer branch rather than to a root agent.
    branchId?: string;
};

export type HarnessRunOptions = {
    // Cancellation for this run. Forwarded to every model request, into each
    // tool's `ToolContext.signal` (a per-call controller linked to this one), and
    // to every run it causes (ctx.run and agentDelegate) so a cancel reaches
    // subagents too (R10).
    //
    // The harness checks it BEFORE each model turn and before each tool call, so
    // an aborted run starts no new side effects. Background calls in flight are
    // aborted through their controllers; a tool that ignores the signal may keep
    // running, but its late result is discarded. The run fails, every actor's
    // history is truncated back to where its call started, and the error
    // propagates.
    signal?: AbortSignal;
    // Attachments for the ROOT user prompt of this run (T3 composer). Validated
    // before any history mutation; malformed input rejects the run untouched.
    //
    // Only the root prompt receives them: delegated children and ctx.run start
    // from their own text prompt, so a root's bytes are never re-sent with an
    // unrelated subagent request. The user message keeps `marker` labels inside
    // `content`; the transport maps them to multimodal parts.
    attachments?: HarnessAttachment[];
};

// ---------------------------------------------------------------------------
// Persisted core state (R3a)
// ---------------------------------------------------------------------------
//
// `harness.snapshot()` returns this shape and `harness.restore(snapshot)` applies
// it to a fresh harness built from the SAME definition (same agents, tools,
// primary, subagents, and policy). It is deliberately DATA ONLY:
//   - no provider configuration, API key, header, or other credential;
//   - no functions (transports, tool implementations, plugins, progress hooks);
//   - no live execution state (run stack, abort signal, in-flight turns).
// Everything here survives JSON.stringify/JSON.parse unchanged, which is what a
// server needs to write it to disk under DATABASE_ROOT.
//
// snapshot() is safe to take during an active run (T16): the value reflects the
// committed transcript, discovery, created-tool sources, and store state at that
// synchronous instant. Partial text/reasoning deltas are not included until the
// assistant message commits.
//
// `version` gates the schema. restore() rejects any other version rather than
// guessing; a newer/older snapshot is a migration problem, not a silent drop.
export type HarnessSnapshotVersion = 1;

// One agent's resolvable state. `messages` is the ENTIRE transcript (seeded
// instructions plus turns and tool results), and `model` is the model accessor's
// current value, so a resumed agent sends the same request on its next turn.
// The registry key is the agent identity; no name is duplicated inside.
export type HarnessAgentSnapshot = {
    model: string;
    messages: HarnessMessage[];
};

// One TERMINAL agent result persisted by snapshot v1 (R3 durability). Active
// (`running`) invocations are deliberately omitted: they have no answer yet, and
// fabricating one would misrepresent an in-flight run. A result is immutable once
// terminal, so this record is the minimum needed to rebuild the agentResult
// registry: identity, ordering, and the completed answer (or failure message).
//
// `status` excludes 'running' by construction. `error` is required for a
// failed/cancelled record and forbidden for a completed one.
export type HarnessAgentResultSnapshot = {
    invocationId: string;
    // Run sequence (the harness's monotonic run id). Restored as a high-water
    // mark so a future run can never reuse a persisted invocation id.
    sequence: number;
    // Monotonic completion order across the harness. Restored so a later
    // completion sorts after every archived one and "latest finished" stays
    // correct.
    completedOrder: number;
    agent: string;
    role: 'primary' | 'subagent';
    kind: 'root' | 'delegation' | 'fork' | 'autoanswer';
    status: 'completed' | 'failed' | 'cancelled';
    // Completed answer text; empty for failed/cancelled.
    content: string;
    // Failure/cancellation message. Required for a non-completed result, never
    // present on a completed one.
    error?: string;
};

// One progressive-discovery cursor (R12). `query` is the opaque normalized query
// key the harness already uses (JSON [tags, limit]); it is persisted verbatim so
// repeating a query after a restart continues the same tranche.
export type HarnessDiscoveryOffsetSnapshot = {
    query: string;
    offset: number;
};

// Everything a snapshot records. Creation ORDER is preserved in `createdTools`
// (registry order affects declarations), and ids remain stable because each
// record store carries its own nextId.
export type HarnessSnapshot = {
    version: HarnessSnapshotVersion;
    // Keyed by registry name. Every configured agent must appear (restore checks
    // both directions when the snapshot is applied).
    agents: Record<string, HarnessAgentSnapshot>;
    discovery: {
        // Enabled searchable tool names, in discovery order (Set order).
        enabled: string[];
        // Per-query offsets for progressive discovery; empty when no query has a
        // continued tail.
        offsets: HarnessDiscoveryOffsetSnapshot[];
    };
    // Tools created at runtime (host `createTool` or the model's toolCreate).
    // `source` is retained and RECOMPILED on restore through the existing
    // trusted-source path; restoring never executes it. Configured/preset tools
    // are owned by the harness definition and are not recorded here (they carry
    // function implementations that cannot be serialized).
    createdTools: ToolCreation[];
    // Lifetime creation budget already spent. Equals createdTools.length in a
    // snapshot this harness produced; restore validates it and refuses a count
    // the target's maxCreatedTools cannot hold.
    createdToolCount: number;
    // R3 durability: terminal agent results, bounded to AGENT_RESULT_RETENTION
    // (64). OPTIONAL on purpose: pre-feature snapshots have no field and restore
    // them with an empty registry, and a snapshot with no terminal results omits
    // the field so older fixtures/tests keep their exact shape. Running
    // invocations are omitted (never written as a partial/cancelled answer).
    agentResults?: HarnessAgentResultSnapshot[];
    records: {
        todos: TodoStoreState;
        profiles: ProfileStoreState;
        chapters: ChapterStoreState;
        locations: LocationStoreState;
    };
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

    // Maximum number of MODEL REQUESTS (turns) one agent run may make before the
    // harness treats it as a runaway loop: history is truncated back to the start
    // of the call and the harness throws. Defaults to 16, the library guard. Must
    // be a positive safe integer; validated at construction so a typo fails before
    // a long run. There is no "unlimited" value. The same bound applies to every run
    // in this harness (entry, ctx.run, and delegated subagents); each run gets its
    // own budget.
    //
    // With background tool calls this counts EVERY request, not just tool rounds:
    // a pause (`done` with pending work) and a wake-driven request each consume
    // one. A run that never answers and keeps spawning work is still bounded; on
    // exhaustion the pending work is aborted and the transcript rolled back rather
    // than left orphaned. The bundled application presets set 1000 for real work -
    // see harnesses/presets.ts.
    maxIterations?: number;

    // Who may create tools at runtime (R12). Defaults to 'all', the historical
    // behaviour:
    //   - 'all'     — every agent (primary and subagents) gets toolCreate;
    //   - 'primary' — only the primary agent gets it. The tool is not declared to
    //                 subagents and a guessed call is rejected, so a subagent can
    //                 neither see nor use creation;
    //   - false     — no model-facing toolCreate at all (a session without it
    //                 answers an honest "not registered" error). The HOST path
    //                 `harness.toolCreate()` still works: an operator action is
    //                 not a model privilege.
    // The lifetime creation budget (`maxCreatedTools`) still applies either way.
    toolCreation?: ToolCreationPolicy;

    // How often (milliseconds) a run with background tool calls emits a `wakeup`
    // and gets another model turn so it can inspect pending elapsed times and may
    // cancel a hung call (R4). Defaults to 600000 (10 minutes). Configurable so
    // tests need not wait ten minutes; must be a positive safe integer. The timer
    // exists ONLY while calls are pending and is cleared on every exit path.
    wakeIntervalMs?: number;

    // How many tools this harness instance may create over its LIFETIME.
    // Defaults to 32 (DEFAULT_CREATED_TOOLS_LIMIT in core/creation.ts).
    //
    // Lifetime, not per-turn: created tools stay registered after reset(), so
    // reset() does NOT restore this budget — restoring it would let a session
    // grow the registry without bound one reset at a time. Must be a positive
    // safe integer; validated at construction.
    maxCreatedTools?: number;

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
    // N3 fork/branch bounds and the threadFork capability. Omitted = threadFork
    // is not registered and no branch may be created. Values are validated at
    // construction against the frozen defaults in core/branch.ts.
    forks?: HarnessForkConfiguration;
    // N3 owner interaction. Omitted = actionRequest is not registered.
    interaction?: HarnessInteractionConfiguration;
    // Reporting hooks. `progress` is awaited for every step, so a slow UI can
    // pace the run, and a `console.log` can just print.
    report?: {
        progress?: HarnessProgress;
        // Persistence observer (R3a). Synchronous and advisory: it runs after a
        // snapshot-recorded mutation so a server can schedule a save. Errors
        // thrown by it are ignored. See HarnessStateChangeEvent for what it does
        // and does not cover.
        stateChange?: (event: HarnessStateChangeEvent) => void;
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
    // `parameters` may be EITHER form (R11):
    //   - the value `execute` receives, i.e. already unwrapped by the
    //     single-property rule: `executeTool('fileRead', ['package.json'])`;
    //   - the schema wrapper object, like the model sends:
    //     `executeTool('fileRead', { paths: ['package.json'] })`.
    // Both are validated against the tool's JSON Schema and resolved to the same
    // value, so the legacy direct-call convention keeps working and a manual call
    // cannot smuggle arguments past the runtime check. A schema mismatch throws
    // HarnessError (no tool-result envelope: a host caller sees an exception).
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
    // tool-result envelope, because a host caller can see an exception. The return
    // value is the tool's raw result (UI panels are NOT unwrapped here — the caller
    // owns presentation), and it is NOT subject to the model-facing 64 KiB text
    // budget; a server that serializes it for a client should apply
    // `boundToolResult` (exported from the package root) itself.
    executeTool: (name: string, parameters: unknown) => Promise<unknown>;
    // Names of the applied plugins, in order.
    readonly plugins: readonly string[];
    // A complete, JSON-serializable core-state snapshot (R3a). See HarnessSnapshot
    // for what is and is not included. Safe to call DURING an active run (T16):
    // it synchronously captures the committed transcript, discovery, created-tool
    // sources, and store state, so a completed tool mutation is persistable before
    // the turn settles. Text/reasoning deltas not yet committed to messages are
    // not part of it.
    snapshot: () => HarnessSnapshot;
    // Apply a snapshot to this harness (R3a). Intended for a FRESH harness built
    // from the same definition. Validation is complete and up front: schema,
    // version, agent identity, discovery names, created-tool source compilation,
    // creation budget, and every record store. Nothing is mutated when validation
    // fails, and no created-tool source is executed (compilation only). Applying a
    // snapshot is idempotent: tools previously restored here are replaced, not
    // duplicated. Throws HarnessError while an agent run is in progress.
    restore: (snapshot: HarnessSnapshot) => void;
    // Names of the tools toolRequest has enabled so far, in discovery order.
    // Persists for the harness's lifetime (not just one call), which is what lets a
    // later turn call a tool discovered earlier. Copied on read; `reset()` empties
    // it.
    readonly discoveredTools: string[];
    // N3: every branch record this harness knows, newest last. Includes running
    // branches and the bounded newest terminal records (see
    // MAX_BRANCH_RECORDS / core/branch.ts). The returned array is a detached
    // copy: mutating it never changes harness state.
    branches: () => HarnessBranchRecord[];
    // N3: one branch record by id, or undefined. The returned record is a
    // detached copy, like `branches()`.
    branch: (id: string) => HarnessBranchRecord | undefined;
    // Reset to "start over": EVERY agent's conversation goes back to its seeded
    // instructions (R12 — a subagent kept its old transcript before this), tool
    // discovery is forgotten, and the session todo list and record stores are
    // cleared. Created tools stay registered (they are catalogue state) and are
    // simply no longer enabled; the creation budget is a lifetime budget and is
    // NOT restored by reset().
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

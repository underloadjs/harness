// @underload/harness core — what you can build and use without a harness.
//
//   agent()      — the brain. One turn at a time (`stream` / `turn`).
//   tool()       — an action the model can request, and that you can call directly.
//   selectTools() — explicit, UNCAPPED name/regex/tag selection (what toolRequest
//                  uses). Pure, so tooling and UIs can reuse the selector. Optional
//                  `declared` core tools are reported as `alreadyAvailable` (never
//                  selected/enabled), so a query naming a tool the caller already
//                  has does not come back as "no match".
//   searchTools() — the legacy paged, tag-only ranking retained for existing hosts.
//                  MAX_DISCOVERY_MATCHES is its five-match cap, not toolRequest's.
//   createDynamicTool() — validate + compile a tool from an async function body.
//                  The primitive behind the harness's toolCreate tool.
//   createTaskTool() — the harness's per-session task list, as a factory.
//                  State stays in the closure so a harness (and nothing global)
//                  owns it. See ../core/task.ts.
//   parseCommandLine()/validateCommandName()/normalizeCommandName()/
//   formatCommandHelp() — the slash-command grammar, PURE (no harness, no
//                  transport, no Node built-in) so a CLI, a server route, and the
//                  harness registry resolve `/task add "testing"` the same way.
//                  COMMAND_NAME_PATTERN is the name rule. See ./command.ts.
//   createBuiltinCommands() — the built-in /help, /tools, /task, /websearch and
//                  /webfetch commands. The last three are pass-throughs to the
//                  task/search/fetch TOOLS, so a slash line mutates the same
//                  session state a model tool call would. `harness()` registers
//                  them before `configuration.commands`. See ./command-builtins.ts.
//   createProfileTool()/createChapterTool()/createLocationTool() — the same
//                  factory pattern for the session record tools (profiles,
//                  chapters, locations). See ../core/profile.ts, chapter.ts,
//                  location.ts.
//   coreToolMetadata()/agentDelegateMetadata() — the CORE tools' declarative half
//                  (name, description, tags, schema). The runtime registration in
//                  ../harness.ts and the server catalogue both read this copy.
//                  Includes the agentManage/agentResult inspection pair and their
//                  preview/page bounds.
//   MAX_DISCOVERY_MATCHES - the legacy searchTools five-match cap. toolRequest
//                  uses the uncapped selectTools and the harness's maxEnabledTools
//                  bound instead.
//   boundToolResult()/MODEL_TOOL_RESULT_BUDGET_BYTES — the model-facing 64 KiB
//                  tool-result/error cap (R10). Reusable by a server that
//                  serializes a manual result for a client.
//   resolveToolParameters()/validateSchemaValue()/checkToolSchemaComplexity() —
//                  the runtime JSON Schema gate and the single-property unwrap
//                  (R11). Shared with the harness's manual tool path so both
//                  resolve arguments identically.
//   DEFAULT_CREATED_TOOLS_LIMIT — the lifetime toolCreate budget (R12).
//   validateActionRequestParameters()/validateActionChoice() — strict
//                  actionRequest parsing shared by the harness runtime, server
//                  route, and frontend card (N3). See ./action.ts.
//   agentBranchOf()/forkAgent()/materializeBranchHistory()/
//   incorporateBranchHistory()/pruneBranchRecords() — the private branch
//                  foundation: identity, fork creation, strict tool-id
//                  materialization, owner/child incorporation, and record
//                  bounds (N3). See ./branch.ts. `agentBranchOf` is the internal
//                  accessor that keeps branchId out of the public Agent type.
//
// These factories are usable on their own. An agent on its own means writing the
// loop by hand: send a message, read `message.toolCalls`, run the tools, append
// the results, send again. That is exactly what `harness()` automates.
//
// `toolParameterKey` and `normalizeTags` are internal plumbing: the harness uses
// the first to apply the single-property rule, and discovery uses the second to
// compare tags. They are exported for tests and for tooling that inspects a
// schema, and are not re-exported from the package root.
export { agent } from './agent';
export { tool, toolParameterKey, normalizeTags, DEFAULT_TOOL_MODE } from './tool';
export { MAX_DISCOVERY_MATCHES, searchTools, selectTools } from './discovery';
export type {
    ToolSelectionOptions,
    ToolSelectionQuery,
    ToolSelectionResult
} from './discovery';
export { compileToolSource, createDynamicTool, DEFAULT_CREATED_TOOLS_LIMIT } from './creation';
// The synchronous module compiler behind startup/runtime source registration.
// Exported for focused tests and for a host that wants to validate a candidate
// without publishing it; the harness owns the only publish path.
export {
    TOOL_SOURCE_EXTENSION,
    TOOL_SOURCE_PACKAGE_ROOT,
    TOOL_SOURCE_ROOTS,
    cloneToolSourceRecord,
    deleteToolSourceFile,
    discoverToolFolderSources,
    prepareToolCandidate,
    readToolSourceFile,
    resolveToolFolderTarget,
    resolveToolFolders,
    supportsToolCompilation,
    writeToolSourceFile
} from './tool-source';
// Descriptor discovery (T19/R8-R9). `discoverToolMetadata()` reads every
// `*.tool.ts` entry's `metadata` + `registration` literals through the TypeScript
// AST — it never imports or evaluates a tool module — and returns one descriptor
// per entry (name, metadata, sourcePath, label, origin, group, activation, order,
// and the control/policy flags). `harness()` registers from this list instead of a
// hand-written inventory, so a fresh entry under the default tools root is picked
// up with no registry edit. Re-exported here so focused tests and hosts can inspect
// the same catalogue the runtime uses.
export { TOOL_ENTRY_EXTENSION, discoverToolMetadata } from './tool-discovery';
// The GENERATED lazy loader (T19). One `import()` per discovered entry, keyed by a
// descriptor's `label`. Exported so the harness can register a real, callable
// baseline in a build without the source compiler (browser) from descriptor
// metadata + this loader, instead of importing each tool module itself. Evaluating
// it imports no tool body.
export { loadDiscoveredTool } from './tool-manifest';
export type {
    BuiltinToolDescriptor,
    DiscoveredTool,
    DiscoveredToolOptions,
    ToolActivation,
    ToolGroup,
    ToolMetadata,
    ToolMode,
    ToolOrigin,
    ToolRegistration
} from './tool-discovery';
export type {
    PreparedTool,
    ToolFolderTarget,
    ToolRegistrationCandidate,
    ToolSourceDependency,
    ToolSourceRecord
} from './tool-source';
export {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    boundToolResult,
    utf8ByteLength
} from './result-budget';
export type { BoundedToolResult } from './result-budget';
export {
    MAX_CREATED_SCHEMA_BYTES,
    MAX_CREATED_SCHEMA_DEPTH,
    MAX_CREATED_SCHEMA_NODES,
    checkToolSchemaComplexity,
    resolveToolParameters,
    validateSchemaValue
} from './schema-validation';
export type { SchemaCheck, ToolArgumentMode } from './schema-validation';
export { createTaskTool } from './task';
export { createProfileTool } from './profile';
export { createChapterTool } from './chapter';
export { createLocationTool } from './location';
// Slash commands. The parser is PURE (no harness, no transport, no Node built-in)
// so every host resolves one line the same way: `/task add "testing"` becomes
// `{ name: 'task', args: ['add', 'testing'], rest, input }`. `harness()` owns the
// registry; these helpers are its grammar and its name rule, exported so a CLI or
// a server route never grows a second tokenizer. See ./command.ts.
export {
    COMMAND_NAME_PATTERN,
    formatCommandHelp,
    normalizeCommandName,
    parseCommandLine,
    validateCommandName
} from './command';
export type { ParsedCommand } from './command';
// The built-in command set (`/help`, `/tools`, `/task`, `/websearch`, `/webfetch`).
// The last three are pass-throughs to the `task`/`search`/`fetch` TOOLS through
// `context.harness.executeTool`, so the command layer adds argument shaping and
// readable output only. A harness registers these before `configuration.commands`.
export {
    createBuiltinCommands,
    HELP_COMMAND_NAME,
    TOOLS_COMMAND_NAME,
    TASK_COMMAND_NAME,
    WEBSEARCH_COMMAND_NAME,
    WEBFETCH_COMMAND_NAME
} from './command-builtins';
// R3a persistence: schema/version + the pure snapshot reader. The store readers
// live in their own modules (task/profile/chapter/location) because each owns its
// invariants; harness.ts is the only caller of the harness-wide reader.
export {
    HARNESS_SNAPSHOT_VERSION,
    cloneToolCreation,
    readHarnessMessages,
    readHarnessSnapshot
} from './snapshot';
export {
    TOOL_UI_LIMITS,
    normalizeToolUiPanels,
    toolUi,
    toolUiOf
} from './tool-ui';
export type { ToolUiExtraction } from './tool-ui';
// Tool media (the `download` hand-off): the branded byte envelope, its unwrap,
// the event-safe descriptor projection, and the BOTH-brand unwrapper the
// harness and the manual API path share. Profiles live in ../shared/attachments.
export { toolMedia, toolMediaDescriptors, toolMediaOf, unwrapToolResult } from './tool-media';
export type { ToolMediaExtraction, ToolResultExtraction } from './tool-media';
// Background tool scheduling (T3): one board per harness. Internal to the
// package surface (the harness is the only owner), exported here so the harness
// module and focused tests share one implementation.
export { createTaskScheduler } from './scheduler';
export type {
    ScheduledTask,
    ScheduledTaskStatus,
    ScheduleSpec,
    TaskScheduler,
    TaskSchedulerOptions
} from './scheduler';
export {
    TOOL_CREATE_METADATA,
    TOOL_CREATE_NAME,
    TOOL_LIST_METADATA,
    TOOL_LIST_NAME,
    TOOL_MANAGE_METADATA,
    TOOL_MANAGE_NAME,
    TOOL_REGISTRY_METADATA,
    TOOL_REGISTRY_NAME,
    AGENT_DELEGATE_NAME,
    AGENT_MANAGE_METADATA,
    AGENT_MANAGE_NAME,
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_METADATA,
    AGENT_RESULT_NAME,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION,
    ACTION_REQUEST_METADATA,
    ACTION_REQUEST_NAME,
    THREAD_FORK_METADATA,
    THREAD_FORK_NAME,
    TOOL_CANCEL_METADATA,
    TOOL_CANCEL_NAME,
    // R4 cross-thread chat + roster + transcript reader (conditional core tools,
    // registered by the harness once the session owns an independent thread).
    THREAD_LIST_METADATA,
    THREAD_LIST_NAME,
    THREAD_READ_METADATA,
    THREAD_READ_NAME,
    THREAD_SEND_METADATA,
    THREAD_SEND_NAME,
    TOOL_REQUEST_METADATA,
    TOOL_REQUEST_NAME,
    TASK_METADATA,
    TASK_NAME,
    PROFILE_MANAGE_METADATA,
    PROFILE_MANAGE_NAME,
    CHAPTER_MANAGE_METADATA,
    CHAPTER_MANAGE_NAME,
    LOCATION_MANAGE_METADATA,
    LOCATION_MANAGE_NAME,
    agentDelegateMetadata,
    coreToolMetadata
} from './metadata';
export type { CoreToolMetadata } from './metadata';
// N3 actionRequest parsing. The server route, the frontend card, and the harness
// runtime all call these two functions so model output and owner answers are
// validated by one implementation.
export {
    ACTION_REQUEST_LIMITS,
    validateActionChoice,
    validateActionRequestParameters
} from './action';
// N3 branch foundation. `agentBranchOf` is the INTERNAL accessor that keeps a
// branch id out of the public Agent type; the rest are the runtime's contracts
// for creating branches, materializing/incorporating history and enforcing the
// frozen bounds. None of these are re-exported from the package root.
export {
    BRANCH_PENDING_PLACEHOLDER,
    MAX_BRANCH_RECORDS,
    MAX_FORK_CONCURRENT,
    MAX_FORK_DEPTH,
    MAX_FORK_HISTORY_BYTES,
    agentBranchOf,
    assertBranchConcurrency,
    assertForkDepth,
    branchBoundaryEnd,
    branchBoundaryStart,
    createBranchId,
    forkAgent,
    incorporateBranchHistory,
    isTerminalBranchStatus,
    materializeBranchHistory,
    normalizeBranchLabel,
    normalizeForkAgentOptions,
    pruneBranchRecords,
    quotedBranchSystemInstruction,
    reserveBranchSequence
} from './branch';
export type {
    AgentBranchKind,
    AgentBranchMetadata,
    BranchPendingReason,
    ForkAgentOptions,
    IncorporateBranchHistoryOptions,
    MaterializedBranchHistory,
    NormalizedForkAgentOptions
} from './branch';
// R2 persistent threads. The factory registry is internal plumbing (the harness
// runtime and focused tests are the only callers); the harness's public thread
// API lives on the handle. See ./thread.ts.
export {
    MAX_THREAD_LABEL_CHARS,
    MAX_THREAD_RECORDS,
    THREAD_AGENT_PREFIX,
    THREAD_HOST_PREFIX,
    createThreadAgent,
    defaultThreadIdOf,
    normalizeThreadLabel,
    registerAgentThreader
} from './thread';

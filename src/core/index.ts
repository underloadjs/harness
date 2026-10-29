// @underload/harness core — what you can build and use without a harness.
//
//   agent()      — the brain. One turn at a time (`stream` / `turn`).
//   tool()       — an action the model can request, and that you can call directly.
//   searchTools() — rank a tool catalogue against capability tags (what toolRequest
//                  uses). Pure, so tooling and UIs can reuse the ranking. Optional
//                  `declared` core tools are reported as `alreadyAvailable` (never
//                  enabled), so a query naming a tool the caller already has does
//                  not come back as "no match".
//   createDynamicTool() — validate + compile a tool from an async function body.
//                  The primitive behind the harness's toolCreate tool.
//   createTodoTool() — the harness's per-session todoManage state, as a factory.
//                  State stays in the closure so a harness (and nothing global)
//                  owns it. See ../core/todo.ts.
//   createProfileTool()/createChapterTool()/createLocationTool() — the same
//                  factory pattern for the session record tools (profiles,
//                  chapters, locations). See ../core/profile.ts, chapter.ts,
//                  location.ts.
//   coreToolMetadata()/agentDelegateMetadata() — the CORE tools' declarative half
//                  (name, description, tags, schema). The runtime registration in
//                  ../harness.ts and the server catalogue both read this copy.
//                  Includes the agentManage/agentResult inspection pair and their
//                  preview/page bounds.
//   MAX_DISCOVERY_MATCHES — the discovery cap (R7) the toolRequest schema
//                  advertises and searchTools enforces.
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
export { tool, toolParameterKey, normalizeTags } from './tool';
export { MAX_DISCOVERY_MATCHES, searchTools } from './discovery';
export { compileToolSource, createDynamicTool, DEFAULT_CREATED_TOOLS_LIMIT } from './creation';
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
export { createTodoTool } from './todo';
export { createProfileTool } from './profile';
export { createChapterTool } from './chapter';
export { createLocationTool } from './location';
// R3a persistence: schema/version + the pure snapshot reader. The store readers
// live in their own modules (todo/profile/chapter/location) because each owns its
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
    TOOL_REQUEST_METADATA,
    TOOL_REQUEST_NAME,
    TODO_MANAGE_METADATA,
    TODO_MANAGE_NAME,
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

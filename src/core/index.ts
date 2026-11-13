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
// (issue 0001 B) The structured-output codes travel with the factory that raises them:
// a host (or the server's error mapper) classifies a rejection by `error.code` instead
// of parsing prose, and both names are part of `agent()`'s contract.
export { STRUCTURED_OUTPUT_INVALID_CODE, STRUCTURED_SCHEMA_INVALID_CODE } from './agent';
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
// `compileToolSourceModule` and `supportsToolCompilation` are ALSO the published
// read-only compile (issue 0002) and are re-exported from the package root;
// `prepareToolSourceRecord` stays internal and serves the harness's
// definition-plus-source registration (issue 0003).
export {
    TOOL_SOURCE_EXTENSION,
    TOOL_SOURCE_PACKAGE_ROOT,
    TOOL_SOURCE_ROOTS,
    cloneToolSourceRecord,
    compileToolSourceModule,
    deleteToolSourceFile,
    discoverToolFolderSources,
    prepareToolCandidate,
    prepareToolSourceRecord,
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
    CompiledToolSourceModule,
    PreparedTool,
    ToolCompileCandidate,
    ToolFolderTarget,
    ToolRegistrationCandidate,
    ToolSourceCompileOptions,
    ToolSourceDependency,
    ToolSourceEvaluateMode,
    ToolSourceLiveDependency,
    ToolSourceRecord
} from './tool-source';
export {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES,
    boundToolResult,
    createToolResultTurnBudget,
    utf8ByteLength
} from './result-budget';
export type { BoundedToolResult, ToolResultBoundOptions, ToolResultSource, ToolResultTurnBudget } from './result-budget';
export {
    MAX_CREATED_SCHEMA_BYTES,
    MAX_CREATED_SCHEMA_DEPTH,
    MAX_CREATED_SCHEMA_NODES,
    checkToolSchemaComplexity,
    resolveToolParameters,
    validateSchemaValue
} from './schema-validation';
export type { SchemaCheck, ToolArgumentMode } from './schema-validation';
// The unified session store (records-engine T2/T3): ONE engine owns every record,
// so the four per-store factories are gone. The built-in collection SPECS stay next
// to the collection they describe.
export {
    createRecordEngine,
    readRecordsStoreState,
    RECORD_ERROR_CODES,
    RECORD_ENGINE_TOOL_NAMES,
    BUILTIN_RECORD_COLLECTIONS,
    isRecordRejection,
    translateRecordRejection
} from './records';
export type { RecordEngine, RecordErrorCode } from './records';
export { TASKS_COLLECTION, TASK_MAX_RECORDS, TASK_MAX_TEXT } from './task';
export {
    PROFILES_COLLECTION,
    PROFILE_MAX_RECORDS,
    PROFILE_MAX_NAME,
    PROFILE_MAX_TEXT,
    PROFILE_MAX_TRAITS,
    PROFILE_MAX_TRAIT
} from './profile';
export {
    CHAPTERS_COLLECTION,
    CHAPTER_MAX_RECORDS,
    CHAPTER_MAX_NAME,
    CHAPTER_MAX_TEXT,
    CHAPTER_STATUSES,
    CHAPTER_MAX_ORDER
} from './chapter';
export {
    LOCATIONS_COLLECTION,
    LOCATION_MAX_RECORDS,
    LOCATION_MAX_NAME,
    LOCATION_MAX_TEXT
} from './location';
// The engine's own bounds (store size, page budget, change window, define limits),
// exported so a test asserts the number instead of restating it.
export {
    RECORD_MAX_RECORDS,
    RECORD_MAX_TEXT,
    RECORD_LIST_DEFAULT_LIMIT,
    RECORD_LIST_MAX_LIMIT,
    RECORD_RESPONSE_BUDGET_BYTES,
    RECORD_MAX_CHANGES,
    RECORD_MAX_CHANGES_IN_RESULT,
    RECORD_MAX_FIELDS,
    RECORD_MAX_COLLECTION_NAME,
    RECORD_STALE_PAYLOAD_BUDGET_BYTES
} from './records';
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
// The model-projection brand (`read`): the prose a tool puts in the transcript,
// kept apart from the structured value the API and a UI consume.
export { toolText, toolTextOf } from './tool-text';
export type { ToolTextExtraction } from './tool-text';
// Tool media (the `download` hand-off): the branded byte envelope, its unwrap,
// the event-safe descriptor projection, and the ALL-BRAND unwrapper the harness
// and the manual API path share. Profiles live in ../shared/attachments.
export { toolMedia, toolMediaDescriptors, toolMediaOf, unwrapToolResult } from './tool-media';
export type { ToolMediaExtraction, ToolResultExtraction } from './tool-media';
// The persisted tool outcome (progressive-compaction T1). The three rules — store only a
// NON-`completed` outcome, read absent as `completed`, derive `isError` instead of keeping
// a second field — live in ./tool-outcome.ts so the writers (../harness.ts, ./agent.ts) and
// the readers (./snapshot.ts, ./branch.ts) cannot drift apart. Internal to the package
// surface like the scheduler below; a host reads the field off `HarnessMessage` directly.
export {
    TOOL_OUTCOMES,
    isErrorOutcome,
    isToolOutcome,
    storedOutcomeEntry,
    toolOutcomeOf,
    toolResultIsError
} from './tool-outcome';
// The canonical argument fingerprint (progressive-compaction T2). One canonical string per
// argument object, and a (name, fingerprint) CALL key: the structural identity a retry or a
// prune rule needs, because ids are always fresh and `arguments` is verbatim JSON text.
// Exported here, in `src/core` beside the context estimator (./context-estimate.ts, which
// ../harness.ts imports directly rather than through this barrel), per T2.2. No consumer
// yet — T3's resolver is the next task; the behaviour is pinned in ./argument-fingerprint.test.ts.
export { argumentFingerprint, toolCallFingerprint } from './argument-fingerprint';
// The compaction policy (progressive-compaction T3): which committed tool units stop being
// sent, given the transcript. Pure — the shipped plugin owns the trigger, the settings and
// the flag WRITES (../plugins/context-compaction.plugin.ts), and this is the part that can be
// pinned without a harness. Exported here beside the two helpers it consumes so a host that
// wants to preview a pass (or replace the built-in with its own writer) reads the same rule.
export {
    PRUNE_CANDIDATE_OUTCOMES,
    RESOLVING_OUTCOME,
    groupUnits,
    isCandidateFacts,
    planContextPruning,
    resolvesPrunedFailure
} from './context-pruning';
export type {
    ContextUnit,
    PruneCandidate,
    PruneOptions,
    PrunePlan,
    UnitClass,
    UnitFacts
} from './context-pruning';
// The context estimator (issue 0004): the one "will this transcript fit?" number the
// product already measures with — `ceil(chars / 4)`, the SAME convention as the
// frontend's context bar and the shipped `context-compaction` plugin's `contextLimit`
// (../plugins/context-compaction.plugin.ts). Published through the root barrel so a
// host that trims its own history gets the same figure as the pre-request guard in
// ./agent.ts and as the UI, instead of inventing a second heuristic that disagrees
// with both. Only the plain estimator is public: the provider-anchored hybrid
// (`estimateContextTokensHybrid`) and its `ContextTokenAnchor` stay internal, because
// issue 0004's proposal publishes the one helper a host needs and nothing else.
export { estimateContextTokens } from './context-estimate';
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
    DELEGATE_TIMEOUT_MS,
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
    // Issue 0027: the release door of the same conditional group. Projected through the
    // facade as soon as the generated manifest carried the row.
    THREAD_DELETE_METADATA,
    THREAD_DELETE_NAME,
    THREAD_READ_METADATA,
    THREAD_READ_NAME,
    THREAD_SEND_METADATA,
    THREAD_SEND_NAME,
    TOOL_REQUEST_METADATA,
    TOOL_REQUEST_NAME,
    RECORDS_METADATA,
    RECORDS_NAME,
    TASKS_METADATA,
    TASKS_NAME,
    PROFILES_METADATA,
    PROFILES_NAME,
    CHAPTERS_METADATA,
    CHAPTERS_NAME,
    LOCATIONS_METADATA,
    LOCATIONS_NAME,
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
// T14: the worker-mode NESTED-RUN policy. One leaf owns the limitation code, the refusal
// sentence, and the validated arm, so the core doors (../harness.ts), the lane worker
// (../server/workers/lane-worker-loop.ts), the capability report and the docs cannot state
// three different guarantees for the same rule. See ./nested-runs.ts.
export {
    NESTED_RUN_LIMITATION_CODE,
    NESTED_RUN_POLICIES,
    assertNestedRunPolicy,
    nestedRunRefusalMessage,
    nestedRunUnsupportedError
} from './nested-runs';
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

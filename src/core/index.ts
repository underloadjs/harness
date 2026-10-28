// @underload/harness core — what you can build and use without a harness.
//
//   agent()      — the brain. One turn at a time (`stream` / `turn`).
//   tool()       — an action the model can request, and that you can call directly.
//   searchTools() — rank a tool catalogue against capability tags (what toolRequest
//                  uses). Pure, so tooling and UIs can reuse the ranking.
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
export {
    TOOL_UI_LIMITS,
    normalizeToolUiPanels,
    toolUi,
    toolUiOf
} from './tool-ui';
export type { ToolUiExtraction } from './tool-ui';
export {
    TOOL_CREATE_METADATA,
    TOOL_CREATE_NAME,
    AGENT_DELEGATE_NAME,
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

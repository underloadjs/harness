// @underload/harness core — what you can build and use without a harness.
//
//   agent()      — the brain. One turn at a time (`stream` / `turn`).
//   tool()       — an action the model can request, and that you can call directly.
//   searchTools() — rank a tool catalogue against capability tags (what requestTools
//                  uses). Pure, so tooling and UIs can reuse the ranking.
//   createDynamicTool() — validate + compile a tool from an async function body.
//                  The primitive behind the harness's createTool tool.
//   createTodoTool() — the harness's per-session todoTools state, as a factory.
//                  State stays in the closure so a harness (and nothing global)
//                  owns it. See ../core/todo.ts.
//   coreToolMetadata()/delegateMetadata() — the CORE tools' declarative half
//                  (name, description, tags, schema). The runtime registration in
//                  ../harness.ts and the server catalogue both read this copy.
//   MAX_DISCOVERY_MATCHES — the discovery cap (R7) the requestTools schema
//                  advertises and searchTools enforces.
//
// Both factories are usable on their own. An agent on its own means writing the
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
export { compileToolSource, createDynamicTool } from './creation';
export { createTodoTool } from './todo';
export {
    CREATE_TOOL_METADATA,
    CREATE_TOOL_NAME,
    DELEGATE_TOOL_NAME,
    REQUEST_TOOLS_METADATA,
    REQUEST_TOOLS_NAME,
    TODO_TOOLS_METADATA,
    TODO_TOOLS_NAME,
    coreToolMetadata,
    delegateMetadata
} from './metadata';
export type { CoreToolMetadata } from './metadata';

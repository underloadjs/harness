// @underload/harness core — what you can build and use without a harness.
//
//   agent()      — the brain. One turn at a time (`stream` / `turn`).
//   tool()       — an action the model can request, and that you can call directly.
//   searchTools() — rank a tool catalogue against capability tags (what getTools
//                  uses). Pure, so tooling and UIs can reuse the ranking.
//   createDynamicTool() — validate + compile a tool from an async function body.
//                  The primitive behind the harness's createTool tool.
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
export { searchTools } from './discovery';
export { compileToolSource, createDynamicTool } from './creation';

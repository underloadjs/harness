// @underload/harness core — what you can build and use without a harness.
//
//   agent() — the brain. One turn at a time (`stream` / `turn`).
//   tool()  — an action the model can request, and that you can call directly.
//
// Both are usable on their own. An agent on its own means writing the loop by
// hand: send a message, read `message.toolCalls`, run the tools, append the
// results, send again. That is exactly what `harness()` automates.
//
// `toolParameterKey` is internal plumbing: the harness uses it to apply the
// single-property rule. It is exported for tests and for tooling that inspects a
// schema, and is not re-exported from the package root.
export { agent } from './agent';
export { tool, toolParameterKey } from './tool';

// The browser root of @underload/harness.
//
// `exports["."]` maps the `browser` condition here so a client bundle gets the
// library and the shared helpers — never the server tree (`node:http`, sessions,
// presets) which a browser cannot load.
//
// The reusable browser client lives in `@loadscript/harness`.
export * from './harness';
export * from './shared';
// The runtime's HarnessPendingTool is the canonical shape; the client's
// structural copy kept its own local name for internal use.
export type { HarnessPendingTool } from './harness';

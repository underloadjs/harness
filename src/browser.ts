// The browser root of @underload/harness.
//
// `exports["."]` maps the `browser` condition here so a client bundle gets the
// library, the shared helpers and the reusable browser client — never the server
// tree (`node:http`, sessions, presets) which a browser cannot load.
//
// No stylesheet is imported by this graph: `./frontend` is the client barrel, and
// the application shell (`./frontend/main.ts`, which imports styles.css and mounts
// the DOM on load) is deliberately NOT part of it. Importing this entry therefore
// evaluates only pure helper modules plus highlight.js language registration — it
// creates no element, attaches no listener and swaps no document content.
//
// Named sets differ from the Node root on purpose: `server` is Node-only, the
// client is not. Consumers that need an explicit, minimal graph can import
// `@underload/harness/frontend` (or `/shared`) directly.
export * from './harness';
export * from './shared';
export * from './frontend';

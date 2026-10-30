// The reusable browser client of @underload/harness.
//
// Public as `@underload/harness/frontend` and re-exported from the browser root
// `@underload/harness` (exports["."].browser -> ../browser.ts).
//
// Import safety — this barrel is the ordinary import path for a client, so it
// must stay inert at module scope:
//   - NO stylesheet import. The stylesheet belongs to `./main.ts` (the app
//     shell), which is intentionally not exported here.
//   - No element is created by any exported module at import time. The `ui/*`
//     modules build DOM only when their `create*`/`apply*` functions are called.
//   - The one module-scope computation is `API_ROOT` in `./api.ts` (the resolved
//     API root). It reads `globalThis.location`/`globalThis.document` defensively
//     through optional chaining, so evaluating it in Node does not touch the DOM.
//
// The wire types come from `../server/protocol` **type-only**, which is erased at
// build time; only `origin.ts` is a runtime dependency on the other tree, and it
// lives in `../shared` so this folder never imports server code at runtime.
//
// Cross-references:
//   - ./api.ts       — API root resolution, fetch client, SSE parser
//   - ./contract.ts  — wire validation/presentation helpers
//   - ./ui/*.ts      — turn board, agent row, create form, markdown, panels, tools,
//                      dialog shell, attachment/file/image previews
//   - ./main.ts      — the app shell (NOT exported: it boots on import)
//   - ../../package.json — "exports[./frontend]"
export * from './api';
export * from './contract';
export * from './ui/activity';
export * from './ui/agents';
export * from './ui/create-harness';
export * from './ui/dialog';
export * from './ui/file-links';
export * from './ui/file-preview';
export * from './ui/markdown';
export * from './ui/model-order';
export * from './ui/panels';
export * from './ui/preview';
export * from './ui/time';
export * from './ui/tokens';
export * from './ui/tools';
export * from './ui/turns';

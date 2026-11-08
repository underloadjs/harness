# @underload/harness Knowledge

Plugin-first CLI agent harness. `agent` is the brain, `tool` is an action, `harness` is the loop.

> **Last verified:** 2026-11-09 for this file's documentation pass — the header
> dependencies, the plugin-pipeline member of the run-end lists, and the grep
> matching-time paragraph (all corrected in place; the landed plugin surface is
> documented in `docs/plugins.md`) — and 2026-11-08 for the shared `task` store
> and its concurrency contract (`src/core/task.ts`, `src/tools/runtime/task.tool.ts`,
> the `/task` verbs in
> `src/core/command-builtins.ts`, and the `records.todos` snapshot/restore path in
> `src/core/snapshot.ts` and `src/harness.ts`), and 2026-11-03 for the documentation
> review of the server-side slash-command
> layer (`src/core/command.ts`, `src/core/command-builtins.ts`, `src/harness.ts`
> registry, `src/server/sessions.ts` `dispatch`/`executeCommandTurn`,
> `src/server/cli/commands.ts`) and of editable thread transcripts
> (`src/server/sessions.ts` `threadTranscript`/`updateThreadTranscript` and the
> tolerant restore, `Harness.setThreadMessages`,
> `src/frontend/ui/thread-transcript.ts`); this was a source-level documentation pass —
> runtime behaviour was not re-verified and the test suite was not re-run, so an
> independent verifier still owns both)
> **Package name:** `@underload/harness`
> **Dependencies:** none beyond `dotenv` and `typescript`, both declared in
> `package.json` `dependencies` — `dotenv` by the Node entry points' `.env` loader
> (`src/server/environment.ts`), `typescript` by the tool-source compiler
> (`src/core/tool-source.ts`, Node-only). CORRECTED IN PLACE 2026-11-09: this line
> used to read "none". The DEFAULT transport still adds nothing — it is plain
> `fetch` (Node 18+), and the browser build reaches neither dependency's module.
> **Workspace consumers:** none yet

---

## How to Update This File

1. Read `src/harness.ts` for the public barrel and the loop
2. Check `src/core/agent.ts`, `src/core/tool.ts`, `src/core/discovery.ts`,
   `src/core/creation.ts`, `src/core/task.ts`, `src/core/profile.ts`,
   `src/core/chapter.ts`, `src/core/location.ts`, `src/core/action.ts`,
   `src/core/branch.ts`, and `src/transport/openai.ts` + `src/transport/models.ts`
3. Check `src/tools/catalogue.ts` / `src/tools/lazy.ts` when touching presets
4. Check `src/server/`, `src/frontend/` (including `ui/action-request.ts`), and
   `src/shared/` for the app contract
5. Update the "Last verified" date
6. Keep the "Not built yet" list honest — it is the roadmap

---

## Layout

`src/` has exactly one root *source* file, `harness.ts`; its test sits next to
it. Everything else lives in a role folder with its own barrel, and `harness.ts`
re-exports the public surface.

```
src/
  harness.ts            the only root source file: harness() + the public barrel
  harness.test.ts       its test, next to it
  harness.creation.test.ts    toolCreate behaviour, next to the loop
  harness.delegation.test.ts  primary/subagents + delegate, next to the loop
  harness.task.test.ts        task declaration/state in a harness
  harness.commands.test.ts    command registry: built-in/config/plugin/runtime order,
                              collisions, replace-by-name, executeCommand contracts
  harness.records.test.ts     profileManage/chapterManage/locationManage in a harness
  harness.metadata.test.ts    core tool metadata (R7 cap, schemas) as registered
  harness.websearch.test.ts   opt-in search registration/core declaration/secrets
  harness.webfetch.test.ts    opt-in fetch registration (native default, hosted keys)
  core/
    index.ts            barrel: agent, tool, searchTools, compileToolSource, createDynamicTool,
                        createRecordEngine + the four collection SPECS (TASKS_COLLECTION,
                        PROFILES_COLLECTION, CHAPTERS_COLLECTION, LOCATIONS_COLLECTION)
                        — the per-store factories createTaskTool/createProfileTool/
                        createChapterTool/createLocationTool are gone (records-engine T3):
                        one engine, one store, specs instead of factories,
                        action/branch internals (validateActionRequestParameters,
                        validateActionChoice, agentBranchOf, forkAgent, materialize/incorporate)
    agent.ts            the brain
    agent.test.ts
    tool.ts             an action the model can request, or you can call
    tool.test.ts
    discovery.ts        tag ranking behind toolRequest
    discovery.test.ts
    metadata.ts         core tool metadata (name/description/tags/schema) — one copy for harness.ts, the record factories, and src/harnesses/core.ts
    creation.ts         validate + compile a tool from an async function body
    creation.test.ts
    task.ts             the `tasks` COLLECTION SPEC (fields, caps, count facets, canonical
                        field order, wrapper mapping) — no store, no factory, no lock
                        (records-engine T3/T5; the releaseThread hook died with Decision P)
    task.test.ts
    profile.ts          per-harness character/people records (add/list/get/update/remove)
    profile.test.ts
    chapter.ts          per-harness chapters (summaries, status, order, body only from get)
    chapter.test.ts
    location.ts         per-harness locations/places (name, description, notes)
    location.test.ts
    action.ts           strict actionRequest parameters/choice parsing + limits (N3)
    branch.ts           fork identity, tool-id materialization, incorporation, bounds (N3)
    command.ts          the ONE slash-line parser: tokenizer, name rules, /help renderer
    command.test.ts
    command-builtins.ts the built-in set (/help /tools /task /websearch /webfetch)
  agents/
    index.ts            trusted AgentProfile registry + agentInstruction()
    types.ts            AgentProfile (name, title, description, instruction, guidelines)
    guidelines.ts       the policy lines the five real roles share (discovery, search
                        key, conditional delegation, no sandbox, toolCreate) — one source
                        so the wording cannot drift; tool availability itself is the
                        declaration list, never prompt prose
    instruct.ts / research.ts / workspace.ts / reviewer.ts / planner.ts
                        the five real roles (general, researcher, coder, reviewer, planner)
    summarizer.ts       the delegated condenser (subagent in every real preset)
    demo.ts / flaky.ts  fixture profiles (scripted demo; recoverable-failures example)
    agents.test.ts      pinned ids/instructions + guideline composition + the
                        policy-not-inventory and prompt-budget guards
  transport/
    index.ts            barrel: openAICompatible, listModels, ModelListError
    openai.ts           OpenAI-compatible SSE transport
    openai.test.ts
    models.ts           GET {baseURL}/models → string[]
    models.test.ts
  tools/
    index.ts            barrel: the presets + presetTools (preload catalogue)
    catalogue.ts        static metadata + dynamic-import load table
    lazy.ts             callable Tool whose body loads on first execution
    laziness.test.ts
    syntax/
      index.ts
      syntax.tool.ts      public tool: language dispatch, two properties
      javascript.ts       node:vm Script parser (imported on demand)
      typescript.ts       transpileModule syntax diagnostics for ts/tsx/jsx (on demand)
      json.ts             strict JSON.parse verdict (imported on demand)
      python.ts           compile() through the interpreter (imported on demand)
    files/
      index.ts
      read.tool.ts
      write.tool.ts       was fileWrite
      edit.tool.ts
      files.tool.ts
      glob.tool.ts        names only          } the two halves of the old fileGlob
      grep.tool.ts        contents only      }
      glob.ts           shared walker (used by glob and grep)
      search.ts         shared pattern/root/argument rules for both searches
      *.test.ts
    command/
      index.ts
      shell.ts
      gitDiff.ts
      *.test.ts
    websearch/
      index.ts          createWebSearchTool: key resolution, validation, dispatch
      request.ts        bounds, fetch/timeout, sanitized errors, normalization, redaction
      exa.ts            Exa adapter (dynamic import)
      tavily.ts         Tavily adapter (dynamic import)
      linkup.ts         Linkup adapter (dynamic import)
      websearch.test.ts factory + all three adapters, env injected, fetch stubbed
    webfetch/
      index.ts          createWebFetchTool: native is always the default provider
      request.ts        page bounds (100 KiB / 24 000 chars), text-only gate, URL rules
      native.ts         the direct GET + dependency-free HTML→markdown/text converter
      exa.ts            Exa /contents adapter (dynamic import)
      linkup.ts         Linkup /v1/fetch adapter (dynamic import)
      webfetch.test.ts  native + both hosted providers, env injected, fetch stubbed
    webdownload/
      index.ts          type-only barrel (no value import, keeps the entry lazy)
      download.tool.ts  the `download` preset: 20 MiB cap, toolMedia() envelope
      download.test.ts  caps, streaming, names, kinds, cancellation
    presets.test.ts     covers every preset, standalone and in a harness
  plugin/
    index.ts            barrel: runPlugins
    host.ts             programmatic extension host
  util/
    index.ts            barrel: HarnessError, toErrorInfo
    errors.ts           HarnessError, toErrorInfo
  types/
    index.ts            every public type
```

The published package bundles five entries, all under `src/`: the library
(`harness.ts`), the Node root (`index.ts`), the browser root (`browser.ts`), and the
per-layer barrels (`server/index.ts`, `frontend/index.ts`, `shared/index.ts`). The
application layers are never separate top-level folders:

```
src/index.ts            Node root: library + shared + server + client
src/browser.ts          browser root: library + shared + client
src/shared/
  origin.ts             loopback/same-origin rules (inbound gate + outbound gate)
src/server/
  index.ts              server barrel -> @underload/harness/server
  start.ts              startHarnessServer: standalone node:http server (explicit)
  api.ts                transport-neutral dispatcher: routes, body policy, bootstrap
  handler.ts            Node adapter: /api prefix, X-Harness-Client gate, SSE writer
  service.ts            @underload/service adapter: /v1/harness, Origin gate, raw SSE
  runtime.ts            lazy shared store/catalogue for the service routes, keyed by root
  persistence.ts        durable database: versioned JSON DTO, atomic write, validation
  sessions.ts           authoritative turns + FIFO queue, watchers, single-flight gate,
                        owner-action registry (answerAction/expiry), core-snapshot
                        write-through and restart recovery; the submit `dispatch`
                        (prompt → queue, `/command` → terminal command turn) and the
                        editable per-thread transcript (GET/PUT, tolerant restore,
                        `invalidThreads`)
  dev.ts                explicit standalone API launcher (no Vite/UI)
  environment.ts        package-root .env loader (Node entry points only)
  config.ts             provider defaults + mergeSettings credential rule
  protocol.ts           client/server wire types (turns, queue, stream items, threads,
                        `SessionInvalidThread`, `ThreadTranscriptResponse`)
  package-root.ts       package root discovered by walking to package.json (build-layout free)
  static.ts             src/frontend/dist serving
  cli/
    index.ts            argv parsing, one-shot, interactive, --serve
    commands.ts         the REPL's slash-command dispatch (local set first, then the
                        harness registry) + the two-section /help
    commands.test.ts
    render.ts           terminal rendering of HarnessEvent
  endpoint/harness/     discovered by @underload/service
    service-route.ts        /v1/harness/*
    service-route-root.ts   /v1/harness    (bare bootstrap document)
  harnesses/
    index.ts            createToolCatalogue: runtime catalogue for CLI and server
    core.ts             core-tool catalogue entries (sessionBound) for the server (R8)
    presets.ts          the 5 shipped presets + 2 explicit fixtures (T5: demo/flaky are
                    presets but not catalogue entries), legacy defaults,
                        and teamOf() — assembled from src/agents profiles
    registry.ts         in-memory registry: create/patch, aliases, validation, agentModels (R9),
                        restore policy (refresh unmodified shipped defaults, T3)
    descriptor.ts       describeHarness/describeAgent: the single wire projection
    toolbox.ts          shared toolbox + createProfiledHarness/createToolboxHarness
    tools.ts            timeNow, textCount, diceRoll, noteSearch, textSummarize, testFlaky
    websearch.ts        always-listed search entry (configured or not)
    demo.ts             scripted offline transport
    types.ts            RunnerSettings, HarnessPreset, CatalogueEntry, availability
src/frontend/
  index.ts              client barrel -> @underload/harness/frontend (no CSS, no shell)
  main.ts               app shell: imports styles.css, mounts the DOM (NOT exported)
  vite.config.ts        Vite dev/build/preview; dev binds the dual-stack wildcard
                        (localhost + LAN), /api proxy
                        to the service on :5000; proxy stamps target origin so the
                        service gate accepts LAN-browser traffic without CORS changes
  vite-proxy.ts         /api route map: target, changeOrigin, target-origin header, rewrite
  api.ts                root resolution (query/injected/build/api) + fetch + SSE parser
  contract.ts           wire validation/presentation helpers
  ui/turns.ts           linear turn timeline: completed grey, active green, queued neutral;
                        one independently expandable entry per delegated invocation,
                        nested depth-first outside every collapsible body
  ui/markdown.ts        safe GFM (marked + DOMPurify) + highlight.js fenced code (R5)
  ui/action-request.ts  interactive owner-question card; read-only non-root card (N3)
  ui/thread-transcript.ts  one conversation's lossless JSON document AND its editor
                        (C4/C5): "Edit transcript" swaps in a textarea over the
                        thread's `messages`, and an unreadable thread opens in it
                        directly
```

**Transcript threads.** One `.turn-row` per server turn: a `.tile` (compact header,
collapsible `.tile-body`) plus a `.thread-children` host that sits outside the body.
Each delegated invocation appends a `.thread-row` there (`data-depth` 1 for a child
of the turn root, 2 for a grandchild, …), and that row owns its own body and its own
children host. The nesting rule (`.thread-children { padding-left }`) gives one
indent step per level and depth-first sibling order; because descendants live
outside the parent body, neither tile collapse nor entry collapse can hide them.
Every entry is tracked by invocation id (runtime `thread.id`, or a synthesized
`call:<callId>` for legacy records), and only the parent's `tool_result` for the
spawning `callId` — or the root turn's terminal status — closes it for good;
`done.pending` is a pause, not a finish. A `threadFork`/autoanswer branch reuses
this same nested row shape (`thread.kind` plus `branchId`) rather than inventing a
second presentation; only the small kind tag differs. The layout is pure DOM/CSS,
so the `main.ts` stream/snapshot routing needs no per-agent case.

`src/server` and `src/server/cli` import `src/harness.ts` relatively (they are
inside the package) and re-use the public harness surface. `src/frontend` imports
the wire types **type-only** from `src/server/protocol.ts` (erased at build time)
and takes its only runtime cross-tree dependency from `src/shared/origin.ts`, so the
client never loads server code — which is why the old `node:` stubs are gone.

Tests are colocated with the module they cover, and they import **only** from
`@underload/harness` — never a relative path. That keeps them honest about the
public surface and free of `../` chains. `vitest.config.ts` aliases the specifier
to `src/harness.ts` (and tsconfig `paths` mirrors it), so `vitest run` needs no
build and can never accidentally test `dist/`. Application-layer tests use the
`/server`, `/frontend` and `/shared` aliases; the jsdom client suite runs with
`src/frontend/vitest.config.ts` (`yarn test:frontend`).

**Declaration contract (R1 types).** The shipped `.d.ts` tree must satisfy two
independent constraints:

1. *NodeNext-clean specifiers.* `tsc` preserves the extensionless source specifiers
   (`./harness`, `./ui/turns`), which Node ESM — and therefore
   `moduleResolution: node16|nodenext` — rejects with TS2834. `scripts/build-declarations.mjs`
   post-processes every emitted declaration to the `.js` name TypeScript itself
   prescribes (`./harness.js`, `./harnesses/index.js`); an unresolvable specifier
   fails the build instead of shipping.
2. *Environment-matched types.* The root's `browser` condition resolves
   `dist/browser.d.ts` (library + shared + client) and the Node/`types` path resolves
   `dist/index.d.ts` (plus the server). `src/index.ts` and `src/browser.ts` are
   emitted by a **separate** tsc program (`tsconfig.entries.json`): in one program,
   tsc references inferred types through the shortest re-export path — the Node root
   — which dragged `dist/server/**` (`node:http`) into the library and browser
   declaration graphs. The entry declarations are pure re-export barrels, so they
   carry no such reference.

`scripts/check-package-types.mjs` (`yarn test:package`, part of `prepublishOnly`)
verifies the built artifact: every export target is inside `files`, the tree is
already specifier-fixed, the browser declaration closure reaches neither the Node
root nor a `node:` built-in, and real NodeNext + `customConditions: ["browser"]`
consumers type-check against a copied, published shape of the package.

`scripts/check-package-runtime.mjs` (`yarn test:package:runtime`) runs the built
artifact instead of only reading it: `loadEnvironmentFile` against a fixture (the
dotenv path), `createHarnessRuntime({ root })` writing its database under an absolute
temp root, and `startHarnessServer({ databaseRoot, port: 0 })` serving health, the
harness index and a session POST before closing. It exists because the bundle is a
browser-platform lib build: bare `require('fs')`/`require('path')` from the bundled
CommonJS `dotenv` were replaced by an empty `__vite-browser-external` stub, so the
built `loadEnvironmentFile()` threw `path.resolve is not a function` while imports,
types and every source test still passed. `vite.config.ts` now externalises the bare
Node builtins and `dotenv` (declared in `dependencies`); only the server entry
imports it, so the browser graph is unchanged.

Browser scope of the tools is a documented limitation, not a target: the browser
entry's static graph is Node-free, but the lazy preset chunks (`read`, `shell`,
`gitDiff`, `syntax`, `write`, `glob`, `grep`, …) contain
`node:fs`/`node:vm`/`node:child_process` because
those tools are Node-only by design. Calling them in a browser fails at the dynamic
import; importing the library, shared or client entries does not load them.

A consequence worth knowing: a symbol that is not exported from the root barrel
cannot be unit-tested. That is intentional — it is the pressure that keeps the
public surface clean.

**Dependency direction** — a strict DAG, so no barrel can create a cycle:

| Folder | May import |
|---|---|
| `types` | nothing (leaf) |
| `util` | nothing (leaf) |
| `transport` | `types`, `util` |
| `core` | `types`, `util`, `transport` |
| `tools` | `types`, `util`, `core` |
| `plugin` | `types`, `util` |
| `harness` | `types`, `util`, `core`, `transport`, `tools`, `plugin` |

Internal folders import each other through barrels. A barrel is never
load-bearing for runtime wiring; it only defines what consumers can reach.

`agent` and `tool` live in `core/` and are barrelled to the package root, so
consumers import `{ agent, tool, harness }` from `@underload/harness` and never
reach into `src/`.

---

## Index

### Core
- [agent](#agent) — The brain, usable on its own
- [tool](#tool) — An executable action: call it directly, or let the model call it
- [Tool discovery](#tool-discovery) — Tags, visibility, toolRequest, and the ranking
- [Session tasks](#session-tasks) — Core task, incremental ids, per-harness state,
  revisions, claims and the change feed
- [Session records](#session-records) — Core profileManage/chapterManage/locationManage stores
- [Agent results](#agent-results-r3) — Core agentManage/agentResult result inspection
- [toolCreate](#createtool) — Runtime tool creation from an async function body
- [Delegation](#delegation) — Explicit primary/subagents, one level deep
- [Owner questions and history forks](#owner-questions-and-history-forks) —
  Conditional `actionRequest`/`threadFork`, autoanswer owner forks, ephemeral branches

### Preset Tools
- [Preset tools](#preset-tools) - the ten lazy presets, executable on their own
- [Web search](#web-search) — opt-in per-harness `search` over Exa/Tavily/Linkup
- [Web fetch](#web-fetch) — opt-in `fetch`: keyless `native` default, hosted `exa`/`linkup`
- [Web download](#web-download) — always-registered `download`: 20 MiB bytes as model media

### Harness
- [harness](#harness) — Callable execution loop
- [Slash commands](#slash-commands) — Operator-facing registry, built-ins, and the
  command turn (no model, server state, UI renders)

### Transport
- [openAICompatible](#openaicompatible) — Default SSE transport
- [listModels](#listmodels) — Model catalogue for the dropdown

### Types
- [HarnessEvent](#harnessevent) — Progress events
- [HarnessMessage](#harnessmessage) — Transcript entries
- [HarnessAssistantMessage](#harnessassistantmessage) — Finished turn
- [ToolVisibility / ToolSearchResult](#toolvisibility--toolsearchresult) — Discovery data

### Application
- [CLI, server, and UI](#cli-server-and-ui) — The app built on the harness
- [Task queue and presentation](#task-queue-and-presentation-r4r5) — Server-owned FIFO queue, watcher stream, timeline, Markdown
- [Agents and the harness registry](#agents-and-the-harness-registry) — Trusted profiles, create/patch, frozen teams, live models

---

## Design Split

| Layer | Owns | Must not own |
|---|---|---|
| `agent` | model, instruction, history, one transport call per turn plus its model-request retry sequence | tool execution, compaction, planning |
| `tool` | description, JSON Schema, one `execute` function | state (except the harness-owned `task`/record factories), retries, policy |
| `harness` | agent registry, tool registry, command registry, loop, progress | model I/O, prompt policy |

The harness is the only layer that knows about tools and looping. That is what
makes `agent` reusable standalone.

**Standalone is real, not theoretical.** `agent.stream(input)` is exactly one
turn. A caller who wants tool calling writes the loop by hand: `brain.user(...)`,
`brain.turn({ tools })`, inspect `message.toolCalls`, append tool messages,
`turn()` again. `harness()` is that loop.

---

## agent

```ts
const brain = agent({ model, instruction, provider });   // name optional
```

- `instruction` accepts a string or an array; each entry becomes its own system
  message, in order. Seed `messages` follow the instructions.
- `name` is optional (default `'agent'`). **A harness overwrites it with its
  registry key**, so `agents: { writer: agent({...}) }` gives `agent.name ===
  'writer'` without repeating the name.
- `stream(input, options?)` — append the user message, run one turn, commit
  both. On failure it truncates back to where it started and yields an `error`
  event.
- `turn(options?)` — run one turn against the current history, **no user append
  and no rollback**. Throws on failure. This is the primitive the harness
  re-requests with after a tool result.
- **Retries (R1).** The agent is the single retry owner for model calls. Default:
  one initial attempt plus ten retries, waiting `1000 * 2 ** n` ms (n = 0..9, so
  1s … 512s) between them. A successful attempt ends the sequence; when the last
  retry also fails, that attempt's own error is what the caller sees. Every
  model-call failure is retried — a returned `error` frame (any HTTP status, a
  provider error on a `200` stream, a malformed or truncated stream), a thrown
  network error, and a mid-stream throw. **Cancellation is never retried.**
  `retry: false` disables retries; `retry: { maxRetries, baseDelayMs }` tunes them.
  A retry re-sends ONLY the current request, and the failed attempt's partial
  text/reasoning/tool calls are discarded, so nothing from it is committed and no
  tool it named can run. The `retry` event reports `attempt`, `maxAttempts`,
  `delayMs` and the failed attempt's `error`.
- `options.tools` forwards tool declarations to the transport. The agent never
  executes them; standalone callers do.
- `messages` is the live array (not a copy).
- `model()` reads, `model('x')` writes. `system`/`user`/`assistant` append and
  chain. `reset()` restores instructions + seed messages.
- `fork({ label? })` returns a private branch of this agent's entire committed
  history, current model, and instruction snapshot. `core/branch.ts` materializes
  a detached copy: every tool call gets a deterministic provider-safe id and every
  still-pending call gets an explicit non-success placeholder. The source
  transcript is never mutated. The branch shares the transport (credentials and
  external side effects), never a sandbox. `label` is display metadata, trimmed,
  ≤120 characters, whitespace-only treated as absent.
- A fork's `reset()` restores its fork-time baseline (the cloned history), not the
  live source history. Fork identity lives in a private `WeakMap`
  (`agentBranchOf` from `core/index`, not the package root), so the public `Agent`
  shape carries no nullable branch field.

Construction throws on: missing model, and missing transport (neither `stream`
nor `provider.baseURL`).

---

## tool

A tool is an **executable object**. `tool()` returns a callable with `name`,
`description`, `parameters`, and `execute` attached, so the same implementation
runs from a direct call or from the model's tool call.

```ts
const read = tool<FileReadParameters, FileReadResult>({
    description: 'Read a bounded window of UTF-8 text files.',
    tags: ['files', 'read'],
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } } }, required: ['paths'] },
    execute: async ({ parameters }) => readBounded(parameters)
});

await read(['package.json']);                // direct: no harness, no agent
harness({ tools: { read } });                // the model calls it
// Result: { files: [{ path, content, startLine, endLine, truncated,
//                     nextLine, nextColumn, bytes }], truncated, bytes, contentBudget }
```

- `name` is optional (default `'tool'`). **A harness overwrites it with its
  registry key**, which is the name the model calls.
- `tags` is **required** (at least one, else construction throws). Stored trimmed,
  lowercased, and deduplicated by `normalizeTags()`, so discovery compares
  normalized values on both sides.
- `visibility` is `'core'` or `'searchable'`, default `'searchable'`. An unknown
  value throws. Core tools are declared on every request; searchable tools wait in
  the catalogue for toolRequest.
- `parameters` is plain JSON Schema. TypeBox output *is* JSON Schema, so a
  `Type.Object({...})` can be passed directly — this package needs no schema
  dependency to interop with the rest of the workspace.
- **Single-property rule.** `execute` receives the single property's *value* when
  the schema declares exactly one property, and the whole object otherwise. This
  is what makes `read(['package.json'])` and a model call carrying
  `{ "paths": ["package.json"] }` identical inside the implementation. The harness
  applies it via `unwrapParameters()` → `toolParameterKey()`. Multi-property tools
  such as `syntax({ code, language })`, `glob({ patterns })` and
  `grep({ pattern, patterns })` receive the whole object.
- The tool context is `{ parameters, agent?, agents?, run? }`. The harness fields
  are **optional** because a direct call has none; a tool that needs them must
  check. The presets deliberately do not.
- `execute` may be sync or async; `tool()` normalizes to a promise.
- Throwing is expected: the harness converts it into a tool result.
- `name` is defined with `Object.defineProperty` (a function's `name` is
  read-only) but left writable, so the harness can rename it.
- Construction throws on: missing description, missing tags (or tags that
  normalize to nothing), unknown visibility, missing `execute`.

---

## Tool naming (T14, renamed by T2)

Harness tools are named for what the model calls them. Two shapes coexist on purpose:

- the six everyday capabilities are bare **action verbs** — `read`, `edit`, `shell`,
  `search`, `fetch`, `delegate` — because they are the tools a model reaches for
  constantly and a namespace prefix would only cost tokens;
- a tool that owns ONE action keeps `<namespace><action>`, which is what groups a large
  catalogue for `toolRequest`; a tool that owns a DOMAIN of operations is named for the
  domain (`files` = list/move/copy/delete/mkdir, `tasks` = the task list), because no
  single verb describes it and one call can sequence the operations that belong together.

| Namespace | Tools |
|---|---|
| `tool*` | `toolRequest` (discovery), `toolCreate` (runtime creation), `toolManage`, `toolList`, `toolRegistry`, `toolCancel` |
| `record*` | `records` (the ONE session store every wrapper writes through — one id counter, `define`/`drop` for new collections; records-engine T2/T3) |
| `task*` | `tasks` (session tasks; renamed from `task` by Decision J — the `Todo*` type names stay as legacy aliases) |
| `profile*` | `profiles` (session character/people records; renamed from `profileManage`) |
| `chapter*` | `chapters` (session chapters, summaries + ordered list; renamed from `chapterManage`) |
| `location*` | `locations` (session locations/places; renamed from `locationManage`) |
| `agent*` | `agentManage` (list agents + result previews), `agentResult` (read one completed result) |
| `action*` | `actionRequest` (conditional owner question; `interaction` configured) |
| `thread*` | `threadFork` (conditional private history fork; forks enabled), `threadSend`, `threadList`, `threadRead` (paged transcript read: whole thread, one message, regex/role filters, per-message content paging) |
| `file*` | `files` (the domain-named manager of list/move/copy/delete/mkdir; the single-action halves stay bare verbs: `read`, `write`, `edit`, `glob`, `grep`) |
| (verbs) | `read`, `write`, `edit`, `glob`, `grep`, `shell`, `search`, `fetch`, `delegate` |
| `text*` | `textCount`, `textSummarize` |
| `time*` | `timeNow` |
| `dice*` | `diceRoll` |
| `note*` | `noteSearch` |
| `test*` | `testFlaky` |
| (already conformant) | `gitDiff` |

There are **no aliases**. The T14 spellings (`fileRead`, `fileEdit`, `commandRun`,
`webSearch`, `webFetch`, `agentDelegate`, plus the older `readFile`, `writeFile`,
`editFile`, `listFiles`, `searchFiles`, `globFiles`, `runCommand`, `clock`,
`wordCount`, `roll`, `searchNotes`, `summarize`, `flaky`) are gone from the wire
surface, the exports, the entry file names, the catalogue, the prompts, and the
reserved-name list. The later rename removed `fileWrite` (now `write`), `fileGlob`
(now the pair `glob` + `grep`), `syntaxCheck` (now `syntax`), and `fileList` (now the
`list` OPERATION of `files`) the same way, and the naming rule is simply "name it for
what it does best": bare verbs where a verb is the capability (naming a file, finding a
line, searching, fetching), and the domain name where a tool owns a set of operations.
Two names for one tool makes
discovery ambiguous, and a
compatibility alias would also mean a second catalogue entry the model could pick by
mistake. The public TYPE names (`FileReadResult`, `FileWriteParameters`,
`FileGlobParameters`, `FileGrepParameters`, `SyntaxCheckParameters`,
`WebSearchParameters`,
`FILE_READ_MAX_LINES`, `createWebSearchTool`, …) deliberately did NOT change: they name
a payload shape, a limit, or a factory, not the tool the model calls.

What is deliberately **not** renamed:

- **harness / preset ids** — `instruct`, `research`, `workspace`, `reviewer`,
  `planner`, `demo`, `flaky` are identities, not tool names, and sessions/aliases
  reference them. `workspace` keeps its id while its visible title is "Coder", so
  every saved session and bookmark still resolves;
- **agent ids** — `summarize`'s delegated half still targets the `summarizer` agent;
- **the `websearch` harness configuration field** — it names the *feature*, not the
  tool (`websearch: true | WebsearchConfiguration`), so renaming it would break
  every host's configuration for no API gain;
- **generic helpers** — `createToolCatalogue`, `createToolFrom`, `createToolRunner`,
  `createToolboxHarness`, `createRecordEngine` (the store the record tools write through;
  `createTaskTool` and its three siblings are gone with the per-store factories), `createDynamicTool`,
  `createWebSearchTool`, and native `node:fs` `readFile`/`writeFile` imports are
  functions, not wire names.

---

## Turn modes: sync vs async (T2)

Every tool has an EFFECTIVE turn mode — `ToolMode = 'sync' | 'async'`
(`src/types/index.ts`) — and the documented default is **`'sync'`** (`DEFAULT_TOOL_MODE`,
`src/core/tool.ts`). The mode answers exactly one question: *when this call finishes, may
the agent be re-prompted right now?*

| Declared where | Applies to |
|---|---|
| `registration: { mode }` in a `*.tool.ts` entry | the shipped built-ins: read by the AST scanner (`src/core/tool-scan.ts`), projected into the discovered row (`DiscoveredTool.mode`), copied by every descriptor clone (`src/tools/descriptors.ts`, `src/core/tool-discovery.ts`), and emitted into the generated `src/core/tool-manifest.ts` |
| `tool({ mode })` (`ToolConfiguration.mode`) | every custom tool: a host `tools: {…}` entry, a `toolSources`/`toolFolders` module, a `toolCreate`/`toolRegistry` revision |
| declared nowhere | effective `'sync'` |

Precedence at launch is: the registration policy bound to the PUBLISHED definition
(`modeDefinitions`, set inside `registerDescriptor`) → `definition.mode` → `'sync'`. It is
keyed to the definition OBJECT and never to the wire name, exactly like `primaryOnly` and
the control markers, so replacing `shell` with an ordinary tool publishes a plain sync
tool — no policy leaks onto a replacement.

Behaviour (`runAgentCore`, `deliverTask`, `launchToolCall` in `src/harness.ts`):

- **sync** — the call joins the SYNC GROUP of the assistant message that requested it
  (`RunState.syncGroups`). A member is removed only once its outcome was DELIVERED, and
  the group wakes the run exactly ONCE, when its last member settled; success, failure,
  and cancellation all settle. Three sync calls in one message therefore cost ONE extra
  turn, and a lone sync call starts its next turn only after it finished.
- **async** — the completion marks the run dirty immediately and triggers its own turn,
  even while another call from the same message is still running.
- The batch gate (`waitForSyncBatch`) is a PARK, never a block: any other wake (an async
  completion, the recurring heartbeat, a steer, a parked delivery failure) or the run's
  abort signal releases it, and no delivery is ever delayed by a pending sibling. The
  implementation stays background work — scheduled on the board, cancelable per call,
  delivered through the agent mailbox in canonical order.
- Groups are per run, so a delegated, `ctx.run`, or branch run never holds its parent's
  batch.

Shipped values: `read`, `edit`, `search`, and `fetch` are `'sync'`; `shell`, `delegate`,
`threadFork`, and `actionRequest` declare `'async'`. The last two are the deliberate
control-tool exception: a fork's answer and an owner's `actionRequest` answer arrive
independently of the requester's batch (that dispatch never joins a group), and making
them sync would hold a batch hostage to a detached clone or to a human at a prompt.
`toolCancel` is answered inline and declares nothing, so its default is inert.

`src/harness.sync-async.test.ts` pins the whole contract — the completion orders of a
mixed sync/async batch, a singleton sync, an all-sync batch, an async-only batch, two
batches in one run, two concurrent runs, failure and cancellation as settled members, and
the no-leakage-onto-a-replacement rule. Its `batch gate races` block adds the two
park-specific checks: an abort releases a parked gate (the run rolls back instead of
waiting on a call it will never deliver), and a sync call that settles inside its own
launch round spends no extra turn. `src/harness.background.test.ts` and
`src/harness.races.test.ts` now declare `mode: 'async'` on the probe tools whose whole
point is a call that stays pending while the run keeps taking turns: under the sync
default those frames would never be emitted, so the mode is stated rather than assumed.
`src/tools/presets.test.ts` pins the sync side from the other direction: `read` does real
I/O, and its transcript is `user → assistant → tool → assistant` with no placeholder turn.

---

## Tool discovery

The rework that keeps a large catalogue out of the context window. A request
declares:

- every `visibility: 'core'` tool, and
- every searchable tool that toolRequest has enabled.

**Every harness preloads the preset catalogue** (`src/tools/`) unless it is
created with `presets: false`. **Five file tools are core (R18)** —
`read`, `write`, `edit`, `glob`, `grep` — so they are declared on every
request and need no discovery. `files`, `syntax`, `shell`, and
`gitDiff` stay searchable: a model that needs a directory listing asks for
`files`/`list`. A configured tool replaces a preloaded preset of the same name.
The harness-owned `toolRequest` and `tasks` are core too, and so is the
environment-backed web pair: `search` when a provider key resolved, `fetch` when
the host opted into `webfetch` (R9-R11). The remaining harness-owned rows
(`toolList`, `toolManage`, `toolCreate`, `records`, `profiles`, `chapters`,
`locations`, `agentManage`, `agentResult`) stay registered but SEARCHABLE —
`records` deliberately so (R4): it is the escalation surface an agent reaches by NAME
when a wrapper's schema is what stops it, and its tags are the ENGINE's words only
(`records`, `record`, `store`, `entries`, `define`), never the wrappers' collection words,
exactly like the always-registered `download` preset: the model opens them with
`toolRequest`. `delegate` is core only for a primary with a subagent allowlist;
`actionRequest` is core only when `interaction` is configured; `threadFork` is
core when `forks.enabled` (the
default). Both are registered as standalone definitions whose `execute` refuses a
direct call, because the runtime handles them with the owning run.

**Core is not session-bound.** The five core file tools, `download`, `search`,
and `fetch` have real implementations, so the server's direct-call path runs them
without a `sessionId`.
Only the harness-owned set mutates a session's harness and therefore carries
`sessionBound: true`. There is no `fileSearch` tool and no mode switch either:
`glob` lists names and `grep` searches contents, both under their own name, and both
are core.

**toolRequest is built by the harness**, not shipped in `src/tools/`. It has to be:
it closes over the live registry and the harness's active set. It is registered
after the declarative tools and before plugins, is always core, and its name is
reserved (`harness()` throws if the config or a preset already has `toolRequest`).
`toolCreate`, `records`, `tasks`, `profiles`, `chapters`, `locations`,
`agentManage`, `agentResult`, and
(when subagents exist) `delegate` are reserved the same way, as are
`actionRequest` and `threadFork` when their configuration registers them.

- Signature: `toolRequest({ names?: string[], regex?: string, tags?: string[],
  limit?: number })`. The three query fields are OR-ed into one UNCAPPED union by
  `selectTools` (`core/discovery.ts`); an exact name is case-sensitive, a regex may
  be bare source or `/source/flags`, and tags keep the fuzzy ranking. A bare array
  or a missing `tags` is tolerated as a legacy tags-only call. Name, description,
  tags, and schema live in the tool's own `tools/runtime/toolRequest.tool.ts` entry;
  `core/metadata.ts` is a data-only compatibility projection of the generated
  descriptor manifest (`core/tool-manifest.ts`) that the server catalogue also
  reads. `limit` narrows only the current query; it is not a global request cap.
- Result: `{ enabled, tools: [{ name, description, tags }], matched, omitted,
  evicted?, unmatchedTags?, availableTags?, alreadyAvailable? }`.
  `enabled`/`tools` are THIS call's matches admitted by `maxEnabledTools`
  (default 32, core tools excluded), `matched` is the whole union, `omitted` is
  the selected matches beyond the cap/limit, and `evicted` names prior enabled
  tools displaced by this call. `enabled` doubles as the ranking order.
- The harness owns the per-turn bound. Every selector kind switches the set:
  this call's ordered matches lead (`maxEnabledTools` maximum), prior enabled
  entries fill leftover capacity, overflow is reported as `omitted`, and displaced
  prior names as `evicted`. `declared()`, tool authorization, `discoveredTools`,
  and snapshot all read the same capped set, so a restored snapshot cannot exceed
  the current configuration. Core tools are always declared and never count.
- `selectTools(tools, query, options?)` is the pure uncapped selector; the legacy
  `searchTools(tools, tags, limit?, offset?, options?)` remains for existing hosts.
  Both are exported from the package root. Only `visibility: 'searchable'` tools are
  candidates for ENABLING — core tools are already declared.
- Scoring is **OR-style, best-match**: each query tag scores a tool (exact tag 4,
  tag prefix 3, tag contains query 2, query contains tag 2, name/description
  contains query 1), and the tool's rank is its **best single-tag score**. More
  matching tags only breaks ties (then name), so breadth can never outrank an
  exact hit. Prefix needs two characters, fuzzy needs three. Exact requested names
  rank first in caller order, then regex name hits, then tag matches.
- `MAX_DISCOVERY_MATCHES = 5` belongs to the legacy `searchTools` answer only.
  `toolRequest` never uses it.
- `alreadyAvailable` reports CORE tools the CALLER already has declared
  (`options.declared`, supplied by the harness from `visibleCoreTools`). This is a
  report only: they are never enabled, never counted against the bound, and their
  query tags are added to the matched set so `unmatchedTags` cannot claim an
  already-callable capability is absent. Core matching is deliberately stricter:
  wire NAME, TAGS, and exact/regex NAME only — never the description, whose
  everyday words would match almost every query. The caller's view is what makes
  it honest: `delegate` is never advertised to a subagent, and absent
  entirely in a one-agent harness.
- `availableTags` (the sorted vocabulary of searchable tools) is returned when
  nothing matched or when the query was empty, so a failed query teaches the model
  the real tags.
- Active tools live in a `Set` per harness: discovery survives across calls and is
  cleared by `reset()`. `harness.discoveredTools` exposes the names (a copy); a
  server snapshot records them so a reload can show the discovery state.
- An **undiscovered** tool is not callable: the harness answers the call with a
  tool result naming tags that would enable it. The model cannot bypass discovery
  by guessing a name.
- `declared()` builds the request list core-first, then the current capped enabled
  set, and is rebuilt for every request, so a toolRequest round shows up on the very
  next turn. Authorization reads that same set; a same-turn call evicted by an
  earlier toolRequest is rejected. `delegate` is skipped for every agent except
  the primary.

**toolManage persistence:** `create`/`update` default to `persist: "folder"`.
A pathless create requires `name` and writes `<name>.tool.ts` under the LAST
configured folder; a pathless update reuses the captured absolute owning path when
it is inside a configured folder. Explicit `path` must be inside one of those
folders. `persist: "runtime"` is the explicit no-disk mode and cannot combine with
`path`/`folder`. Disk-backed publications bypass `createdToolRecords` and
`maxCreatedTools`; restart re-scans the folder. Failed writes restore the prior
bytes (or delete the new file) and surface rollback failure.

---

## Session tasks

`src/core/task.ts` builds the `task` tool (R9-R11 renamed it from `todoManage`).
It is a **deliberate exception to the stateless-tool rule**: the state lives in the
factory closure, never in a module singleton, so the harness owns exactly one list
per instance.

```ts
// One STORE per harness, owned by the engine — not one factory per tool (records-engine T2).
const engine = createRecordEngine();   // collections + the single id counter + reset/snapshot/restore
```

- The wire shape is one **merge command**, not an action enum: `tasks` holds patch
  entries, `remove` holds ids, `claim`/`release`/`takeover` hold ids for the
  ownership verbs, and `offset`/`limit`/`afterId`/`since` shape the answer. No
  arguments (or `{}`) is a read. An entry **without** `id` adds a task (`text`
  required); an entry **with** a known `id` patches it — `text` and/or `completed`,
  whichever are sent; omitted fields are unchanged. An unknown id, an entry with
  neither `text` nor a known `id`, one id in two of the five id lists, or an id
  patched twice are all rejections.
- The whole patch is validated **before** anything mutates, so a rejected call
  leaves the records, the id counter, `storeRev` and the change log exactly as they
  were. Apply order is fixed: claims → releases → takeovers → expired-claim clears →
  patches → removals → additions.
  **Corrected in place (records-engine Decision P, 2026-11-09):** the first four steps died
  with the claim protocol, so the order the engine implements is **patches → removals →
  additions**. There is no `claim`/`release`/`takeover` verb, no `leaseMs`, and no
  `owner`/`ownerThreadId`/`leaseUntil` on a record: **every patch is accepted unless it is
  stale**, and a stale rejection returns the CURRENT record (R9). The sentence above is kept
  so the reasoning stays auditable; `src/core/records.ts` is the implementation.
- Ids are decimal strings (`"1"`, `"2"`, …), monotonic per instance; a removed id
  is never re-used. `reset()` clears the list, the counter, `storeRev` and the log.
- **Every record carries concurrency state** (T1), on top of `id`/`text`/`completed`:
  `rev` (its CONTENT revision — 1 on add, `+1` only when trimmed `text` or
  `completed` actually changes, so a restated value is a silent no-op FOR THE PATCH
  ITSELF), the write attribution `updatedBy`/`updatedThreadId`/`updatedAt`, and the
  optional claim triple `owner`/`ownerThreadId`/`leaseUntil`. Attribution comes from the
  `ToolContext` (`agent?.name`, `threadId`), never from arguments, so a model cannot
  forge it. Optional fields stay ABSENT rather than `undefined`-valued, so a store
  nobody has claimed serializes exactly like a pre-T1 store.
- **Every recorded event also bumps the store**: one `TaskChange` per accepted
  `add`/`update`/`remove`/`claim`/`release` goes into a FIFO log capped at
  `TASK_MAX_CHANGES` (200) and `storeRev` advances by one. A no-op patch and a lease
  renewal record nothing THEMSELVES — the one event such a call can still append is
  clearing an expired foreign claim on a record it patches or removes — which is why a
  heartbeat cannot knock a reader off its revision.
- Every success answers the SAME bounded envelope, with no action wrapper:
  `{ tasks, counts: { total, completed, pending }, page: { offset, limit, hasMore,
  nextOffset? | afterId? + nextAfterId? }, storeRev }` (20 items by default, hard
  maximum 100, and a 64 KiB serialized page budget that stops BEFORE an item which
  would cross it). `tasks` is the current page — including right after an add, a
  patch, a removal or an ownership action — and is a defensive copy, so mutating a
  result can never mutate the session list. `counts` always describes the WHOLE
  store, never the page. Caps: 200 tasks and 4000 characters of text each.
- **Two cursors, deliberately different.** `offset` is an index; `afterId` is a
  keyset cursor over the numeric ids ("everything after id 7"), which cannot skip or
  repeat a record when another agent deletes one mid-walk. Passing an EXPLICIT
  `offset` alongside `afterId` is a rejection, and a keyset page reports `afterId`
  plus `nextAfterId` while `hasMore` — never `nextOffset`.
- **The change feed** is the cheap alternative to re-reading: `since: <storeRev>`
  adds `changes` (the events after that revision, oldest first, at most
  `TASK_MAX_CHANGES_IN_RESULT` = 50 entries, added to the result only when the byte
  budget allows), `changesHasMore` (the feed was cut, by count or by bytes) and
  `changesTruncated` (the retained window no longer covers `since + 1`, so the reader
  never saw part of the gap). A `since` ahead of `storeRev` is an error, and those
  three keys are absent from every other result.
- Validation names the offending field with a quoted, balanced path
  (`task "tasks[0]" needs "text" to add a task, or an existing "id" to change one.`);
  the harness turns the throw into a recoverable tool result.
- **The model-facing contract lives in `src/tools/runtime/task.tool.ts`**
  (`TASK_METADATA`: description + JSON Schema + `registration`), and
  `src/core/metadata.ts` is only the generated-manifest projection the factory
  consumes. The two must stay in step, and two boundaries are deliberate: the schema's
  `pattern: '^[0-9]+$'` on `afterId` is DECLARATIVE — the shared validator
  (`src/core/schema-validation.ts`) implements type/minimum/maximum/
  `additionalProperties` but not regex, so a non-decimal cursor reaches the store and
  `readAfterId` is what rejects it — and the `leaseMs` clamp (1 minute..24 hours) only
  ever fires on a call that bypasses the schema (a bare `tool().execute(...)`), because
  a model call and a `harness.executeTool` call are both schema-gated and an
  out-of-range lease is rejected there as `$.leaseMs must be >= 60000.`
- `src/harness.ts` registers the factory's tool under the exact name `task`, marks
  it core (`alwaysDeclared`, so it is declared to every agent with no discovery),
  adds it to `RESERVED_TOOL_NAMES`, calls the returned `reset()` from
  `harness.reset()`, and passes the calling agent + conversation into the tool
  context on every door (model call, `executeTool`, slash command). Because
  `src/server/sessions.ts` creates one harness per session, tasks are isolated per
  session and shared by the primary and its subagents within one harness.
- Snapshot persistence keeps the store's wire key: `records.todos` (snapshot v1,
  still version 1) is now `{ items, nextId, storeRev?, changes? }`, where `items`
  entries are full `TaskItem` records including `rev`, the attribution fields and the
  claim triple. `readTaskStoreState` validates that block and returns a deep copy; it
  is the SAME reader `src/core/snapshot.ts` runs the persisted value through before a
  session is accepted, so a corrupt file cannot half-restore a live store. Duplicate
  or non-positive integer ids still report with the persisted field name
  (`todo state contains the duplicate id "1".`).
- **Old snapshots load, new snapshots do not go backwards.** `storeRev` and
  `changes` are optional and default to `0` / `[]`, and a record without `rev`
  defaults to `1` — the revision it was created with — so a pre-T1 file restores
  unchanged. The reverse is refused: the validator rejects unknown persisted keys
  (`<label> has an unknown field "<key>".`), so a snapshot written by THIS build —
  whose records carry `rev` and whose block carries `storeRev`/`changes` — cannot be
  restored by an older build. It also refuses a `leaseUntil` with no `owner`, a
  change `rev` outside `1..storeRev`, a change log that is not strictly ascending, a
  `storeRev` behind its newest event, and an over-cap `items` (200) or `changes` (200)
  list.
- **~~Thread lifecycle clears claims~~ (deleted in place, records-engine Decision P).**
  `releaseThread(threadId)` used to drop every claim tagged with a conversation id, and the
  harness called it when a thread stopped (`stopThread` and every path through it), when one
  was purged/deleted, when an agent's default conversation was dropped from the roster, and
  on `restore` for any claim whose `ownerThreadId` is absent from the restored session
  — a claim from a thread that no longer exists could never be renewed or released.
- Beyond the tool result there is no separate host getter: the store crosses to a
  host only through `harness.snapshot()`'s `records.todos`, and
  `readTaskStoreState()` is the exported pure reader that path and `restore()` share.
  No UI panel and no dedicated HTTP endpoint.

**Concurrency and ownership (T1).** One store is shared by every agent on every
thread, and a call is not a transaction: a read is a snapshot, and somebody else can
write the same record before your next call lands. The contract makes that race
explicit instead of letting the last write win:

- A caller the runtime **knows** (any model call, `executeTool`, a command, a lane
  worker — anything with `context.agent`) must send `expects: [{ id, rev }]` for
  every id it patches or removes; that is the GUARDED WRITE rule. A bare `tool()` /
  driver call has no identity, may write blind (the pre-T1 behaviour hosts and tests
  rely on), and cannot claim, release or take over at all.
- A token that does not match the stored `rev` rejects the WHOLE call and names what
  moved: `task "1" changed since revision 1 (now 2, last edited by "coder"); re-read
  and retry; changed fields: completed.` A token naming a record the store no longer
  has always answers `task "1" was removed since revision 1; re-read the list.`:
  `readPatch` compares the tokens (step 3) BEFORE it runs the existence lookups
  (step 4), so a `tasks` patch, a `remove`, an ownership verb or a token alone all
  name the removal the caller actually hit. The generic
  `task has no task with id "1".` is only what a call that sent NO token for that id
  hears, and a token for a live id the call does not touch is still rejected as a
  token for nothing.
- `rev` is content-only and `storeRev` counts every event, which is exactly why a
  claim, a release, a takeover or a lease renewal can never break another agent's
  compare-and-swap.
- `claim` holds a record for the exact holder pair `(owner, ownerThreadId)` with
  `leaseUntil = now + leaseMs`; `TASK_DEFAULT_LEASE_MS` is 15 minutes, and a lease
  outside 1 minute..24 hours is REJECTED on a schema-gated call (model or
  `executeTool`) and CLAMPED into that range on a call that bypasses the schema.
  While a claim is live, a non-holder's
  content write, claim, or release is refused (`task "1" is claimed by "coder" until
  <ISO>; release it or take it over first.`); a holder re-claiming its own record only
  renews the lease; releasing an unowned record is a no-op success; a claim stops
  blocking AT or after `leaseUntil` — `isExpired` is `leaseUntil <= now`, so the expiry
  instant itself frees it — and the next writer clears it (logged as a `release`)
  before applying its own change. `owner` with no `leaseUntil` is an indefinite claim
  that never auto-expires, so only a restored or hand-edited store holds one forever.
- `takeover` is the DELIBERATE override: it moves the holder to the caller even under
  a live lease and logs a `claim`. `mergeDisjoint: true` is the one escape from a
  stale content patch: the patch applies only when the log proves every concurrent
  update since the caller's read covers `expected+1 … current` with no gap or
  duplicate and touched none of the fields the patch sets. A logged `remove` of that
  id, an overlapping field, or an uncovered tail all refuse; a stale `remove` is never
  merged.
- **Corrected in place (Decision P):** there is no claim, so a conversation ending strands
  nothing — no sweep, no wiring, and no lease for a crashed agent to hold. The guarantee is
  structural, and `src/harness.task.test.ts` pins it by SHAPE (no `owner`/`leaseUntil` key
  anywhere in a persisted store after stop/delete/snapshot/restore).
- Worker mode changes nothing: a `task` call made on a lane is ROUTED, and the
  authority rebuilds the tool context from the crossing `LaneCallIdentity`
  (`src/server/workers/lane-authority.ts`), so a lane's write is attributed to — and
  guarded by — the same `(agent, threadId)` pair it would have inline.

**Not OpenCode's `todowrite`.** OpenCode's current dev branch (`fd8268e`,
2026-10-27) has an experimental `todo` plugin tool gated by `experimental.todo`:
input `{ todos: [{ content, status: 'pending' | 'in_progress' | 'completed' |
'cancelled' }] }`, full-list replacement, no ids or priorities; the visible list is
derived by the UI from the last call's input, with no server-side todo state.
Sources:
[`plugin/todo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/todo.ts),
[`todowrite.txt`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/todowrite.txt),
[`tool-todo.test.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/test/tool-todo.test.ts).
`task` is a partial patch with stable ids, not parity: it never rewrites the whole
list and it does not carry `in_progress`/`cancelled` states.

**Operator surface.** `/task [list|add|complete|reopen|remove|claim|release|takeover]`
is the built-in slash command over this SAME tool: it calls
`harness.executeTool('task', …)`, so a terminal, an HTTP submit, or the composer reads
and changes this session's list without spending a model turn, and it inherits every
bound above. `complete`/`reopen`/`remove` are guarded writes, so the command first walks
the store (`offset` paging at `limit: 100`, following `page.nextOffset` until it is
exhausted) and sends the REAL `expects: [{ id, rev }]` tokens it read — never an invented
revision — which turns a concurrent edit into the tool's stale error instead of a lost
update; an id the read did not see gets no token, so the tool's own unknown-id rejection
is what an operator reads. `claim`/`release`/`takeover` send no token (an ownership
action never moves `rev`) and run **unthreaded**, so their holder pair is `(entry agent,
no thread)` — `/task release` can therefore lift only the operator's own or an expired
claim, and `/task takeover` is the documented override for a live one. The listing marks
a reserved record — `#1 [ ] testing (claimed by writer until <ISO>)`, with `@<threadId>`
when the holder is a conversation — because the fix (`/task takeover 1`, or waiting out
the lease) is otherwise invisible. See [Slash commands](#slash-commands).

Tests: `src/core/records.test.ts` (the ENGINE — one id counter across collections, per-collection
feeds, patch semantics, bounds, keyset and offset paging, `rev`/attribution, guarded writes
and CAS, disjoint merges, `define`/`drop`, snapshot/restore and the corrupted-file rejections;
the claim/lease tests left with the lock), `src/harness.task.test.ts` (declaration, one shared
list in a live harness, and the T8 harness-boundary checks), `src/harness.commands.test.ts` (every `/task` verb, including the
read-before-write `expects` and the claimed-record rendering), and
`src/server/workers/lane-authority.test.ts` (a routed `task` call against the canonical
harness).

---

## Session records

> **Corrected in place (records-engine T2/T3, 2026-11-09).** This section used to describe
> THREE SEPARATE STORES with "separate closets and separate id sequences". They are now
> COLLECTIONS of one store: `src/core/records.ts` is the engine (one id counter across every
> collection, so a profile id and a chapter id can no longer both be `"1"`), and
> `src/core/profile.ts` / `chapter.ts` / `location.ts` are pure field-spec declarations —
> the only thing a generic engine cannot infer. `createProfileTool()` is gone; the harness
> builds one `createRecordEngine()` and the tools `profiles`, `chapters`, `locations` (plus
> `records` itself, and `tasks`) are thin wrappers over it. Records also gained `rev`,
> attribution and the compare-and-swap contract [Session tasks](#session-tasks) already had,
> which is what R3 asked for: no collection can corrupt or race with another.

`src/core/profile.ts`, `src/core/chapter.ts`, and `src/core/location.ts` declare the three
story collections the engine serves, with the same harness-owned lifecycle as the task list:
one store per harness (so per server session), shared by every agent there, stable
decimal-string ids from the store's single counter, full validation before any mutation,
defensive copies on every result, and cleared by `harness.reset()`. Their metadata lives in
`core/metadata.ts` and their types in `types/index.ts`.

```ts
const engine = createRecordEngine();      // tasks / chapters / profiles / locations + define
await engine.executeRecords('profiles', context);   // routed: harness.runtime.executeRecords
```

Shared action set (`RecordAction = 'add' | 'list' | 'get' | 'update' | 'remove'`);
`src/harness.ts` registers each tool, reserves its name, and calls its `reset()`.
**Corrected in place (records-engine T2/T3, 2026-11-09):** none of these tools holds state
any more. The four wrappers are a schema plus one routed call
(`context.harness.runtime.executeRecords(<name>, context)`), and `src/core/records.ts` is the
single store behind them AND behind `records` — one collection map, one id counter, one change
feed per collection. The `*Manage` names are gone (Decision J).

| Tool | `add` requires | Optional (default) | `update` mutable fields | Result extras |
|---|---|---|---|---|
| `profiles` | `name`, `description` | `traits` (`[]`), `notes` (`''`) | name, description, traits, notes | `list` → `{ profiles, counts: { total }, page }`; `get` → `{ profile, counts }`; writes → `{ profile \| removed, counts }` |
| `chapters` | `title`, `summary` | `content` (`''`), `status` (`planned`), `order` (unset) | title, summary, content, status, order | `list` → `{ chapters, counts: { total, planned, draft, complete }, page }`; `get` → `{ chapter, content, counts }`; writes → `{ chapter \| removed, counts }` |
| `locations` | `name`, `description` | `notes` (`''`) | name, description, notes | `list` → `{ locations, counts: { total }, page }`; `get` → `{ location, counts }`; writes → `{ location \| removed, counts }` |

`page` is `{ offset, limit, hasMore, nextOffset? }`: 20 records by default, hard
maximum 100 per call, and a 64 KiB serialized page budget, so a model reads a long
cast one bounded page at a time (`nextOffset` is omitted when `hasMore` is false).
Caps: 200 records per tool, 200-character names/titles, 4000-character descriptions,
summaries, chapter bodies and notes, and at most 32 profile traits of 200 characters.
The paged result types are re-exported from `types/index.ts`; the SHAPES are declared by
the collection specs in `core/{task,profile,chapter,location}.ts` (field keys, caps, count
facets, the `getOnly` projection) and rendered by `core/records.ts`, so a wrapper cannot
drift from what the engine returns and adding a collection adds no validator.

- **Partial update is atomic.** The tool validates into a patch object and then
  assigns; a later invalid field cannot leave earlier ones applied. An update that
  names no mutable field is an error, not a no-op. Blank `name`/`description`
  (and blank chapter `title`/`summary`) are rejected on update; `notes` and
  chapter `content` may be cleared to `''`; `traits: []` clears a profile's traits.
  Traits are trimmed and deduplicated; an omitted `traits` on `add` defaults to
  `[]`.
- **Chapters return summaries.** `ChapterSummary` is `{ id, title, summary,
  status, order? }`; `content` is stored (`ChapterItem`) but only `get` returns it
  in the result. `order` sorts the returned list: ordered chapters ascending
  first, then unordered ones in insertion order (stable sort); the live array is
  never sorted and there is no move action. `order` must be a safe integer and
  cannot be cleared through `update` (set a new value). `status` is
  `planned | draft | complete` and `counts` tallies all three.
- **Profiles and locations return whole records**, so they have no summary/body
  split.
- **Validation is up-front for every action.** Wrong field types, an unknown
  action, a missing/blank/non-string `id`, an unknown id, a non-integer `order`,
  and an unknown `status` throw `HarnessError` naming the tool and field, even on
  `list`, so no failed call mutates a store.
- **No persistence, no UI panel, no HTTP endpoint of their own.** The stores are
  reached only through their core tools (the server's `sessionBound` catalogue
  entries and `harness.executeTool`).

---

## Agent results (R3)

Two ALWAYS-registered core tools expose the session's completed agent answers to
every configured agent, primary **and** subagent:

```ts
agentManage({})                                  // every agent + truncated previews
agentResult({ agent: 'researcher' })             // latest finished result
agentResult({ agent: 'researcher', invocationId: '3', offset: 4000 })
```

| Tool | Input | Result |
|---|---|---|
| `agentManage` | `{}` | `{ agents: [{ name, role, model, invocationCount, results }], totalResults, activeResults, truncated }`; each result is `{ invocationId, kind, status, contentLength, preview, truncated }` |
| `agentResult` | `{ agent, invocationId?, offset?, limit? }` | `{ agent, invocationId, kind, status, content, contentLength, offset, limit, hasMore, nextOffset? }` (plus `error` for a failed/cancelled run; `status: 'empty'` before any run) |

- **Identity.** `invocationId` is the run id for a root run and the thread id for
  a delegated/ctx.run child; a fork/autoanswer uses its `branchId`. The harness
  records roots, delegations, forks, and autoanswer branches in a bounded
  registry (`AGENT_RESULT_RETENTION` = 64 completed records, active runs are never
  evicted) and persists every TERMINAL record as the OPTIONAL `agentResults` array
  of snapshot v1. Restoring advances the run, completion, and branch-id counters to
  the archived high-water marks, so a future run cannot reuse/overwrite an archived
  invocation id. Old snapshots without the field restore an empty registry, and
  `reset()` clears it with the conversation.
- **Completed answers only.** The registry records the value `runAgentCore`
  returns, never a streamed delta, so a running invocation has `status: 'running'`
  and no content and is OMITTED from a snapshot (never written as a fabricated or
  cancelled answer). `agentResult` without an id selects the latest result by
  COMPLETION order, so a fork that finished earlier cannot mask the root's final
  answer.
- **Durability is strict.** `snapshot.agentResults` is validated before any restore
  mutation: unique `invocationId`/`sequence`/`completedOrder`, an agent present in
  `snapshot.agents`, terminal status only, `error` required exactly for
  failed/cancelled, and at most 64 records. A corrupt array rejects the whole
  restore and leaves the live registry untouched.
- **Previews are bounded.** `agentManage` lists up to 5 recent invocations per
  agent and at most 200 characters of each answer (whitespace-trimmed); the full
  answer stays in the registry.
- **No private data.** Neither tool reads system instructions, transcript
  messages, tool arguments, or tool bodies. Only the completed answer value and
  run identity cross the boundary.
- **Paging, not silent truncation.** `agentResult` defaults to 4000 characters per
  page and caps `limit` at 8000 (far below the 64 KiB serialized tool-result
  bound even with JSON escaping). `nextOffset` pages the remainder, so a long
  result is read in full instead of being cut by `boundToolResult`. Offsets are
  UTF-16 code-unit indices; both page edges are moved to a surrogate-pair boundary
  so a non-BMP glyph is never split (the returned `offset` is the one actually
  used).
- **Reserved names.** `agentManage` and `agentResult` are in
  `RESERVED_TOOL_NAMES`; a configured, plugin, or created tool cannot shadow them.

---

## Preset tools

`src/tools/` ships ten presets: `syntax`, the six file tools (`read`,
`write`, `edit`, `files`, `glob`, `grep`), `shell`, `gitDiff`, and
`download`. Each
is a standard `tool()` and each is executable standalone. R18 kept `read`,
`write`, `edit`, `glob`, and `grep` **core**; `files`, `syntax`, `shell`,
`gitDiff`, and (R9-R11) `download` are **searchable**.

The folder is one file per tool, one folder per capability — `tools/syntax/`,
`tools/files/`, `tools/command/` — and the barrel exports both the named tools and
`presetTools`, the catalogue the harness preloads. **Adding a tool means adding one
`*.tool.ts` file with its `metadata` + `registration` literals — that is all.** No
`PRESET_TOOLS` row, no `loadPresetTool` import branch, no barrel line is required
(T21 removed the inventory; T24 removed the stale-manifest gap). `tools/descriptors.ts`
derives the catalogue from a LIVE `tools/**/*.tool.ts` scan on Node — the same
`core/tool-scan` reader `harness({})` uses — so a cold process already lists and
loads a brand-new entry. The generated `core/tool-manifest.ts` is the BROWSER
inventory (a browser cannot read files or parse TypeScript) and only needs
regenerating (`yarn tools:manifest`) for the browser surface, never for Node.
A barrel line is needed only when the tool must also be a named public import
(`presetTools[name]` reaches it either way).

**The exports are lazy.** `tools/index.ts` builds each named export with
`lazyTool(name)` (`tools/lazy.ts`) from the discovered rows: name, description, tags,
visibility and schema are eager metadata, while `execute` resolves the real
implementation on first call — through the GENERATED `import()` when the manifest
knows the entry, and through the runtime source compiler (`prepareToolCandidate`)
when it is newer than the manifest (T24). Consequences:

- importing the package (or constructing a harness, or listing the server
  catalogue) loads no `node:fs`, `node:child_process`, or `node:vm`;
- the build emits one chunk per implementation next to the entry; `dist/` ships
  them all, and `inlineDynamicImports` must stay off;
- the proxy keeps the `Tool` contract exactly — writable `name`, `tags`
  normalized like `tool()`, callable directly, `execute(context)` delegated — so
  harness registration and the server's direct-call path are unchanged;
- a failed import clears the cache so the next call retries.

Every preset is tagged. The five core file tools are declared up front; the
searchable remainder (`files`, `syntax`, `shell`, `gitDiff`, `download`) waits for
`files`/`list`/`move`/`rename`/`copy`/`delete`/`remove`/`mkdir`, `shell`, `git`,
`javascript`/`typescript`/`json`/`python`, or the `grep` tag.

| Export | Call | Result |
|---|---|---|
| `syntax` | `({ code, language: string })` — validated free name: `javascript`/`js`, `typescript`/`ts`, `tsx`, `jsx`, `json`, `python`/`py`/`python3` (trimmed, case-folded, a leading dot allowed) | `boolean`; an unsupported language, a non-string `code`, a missing interpreter, and a cancelled or timed-out Python run are all ERRORS, never a verdict |
| `read` | `(paths: (string \| { path, startLine?, startColumn?, startByte?, maxLines? })[])` — non-empty, ≤100 | `{ files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, nextByte, bytes, sizeBytes, error? }], truncated, bytes, wireBytes, contentBudget, skipped, note? }`; defaults `startLine 1` and **no default line cap** (an explicit `maxLines` is 1..20000); the 256 KiB budget is measured on the **serialized** result and water-filled by demand, so `wireBytes <= contentBudget` always holds and the continuation fields survive the harness cap — the `note`'s own size is reserved before the split, and it appears only for a file of `65536` bytes or more whose window was cut (up to 2 paths named, the rest counted). A missing path, directory, permission denial, or **binary content** keeps its own ordered entry with `error: { code: 'ENOENT' \| 'EISDIR' \| 'EACCES' \| 'EPERM' \| 'EBINARY' \| 'EIO', message }` and consumes no budget; only a malformed request rejects the call. Binary detection is window-scoped, not whole-file |
| `write` | `(files: { path, content }[])` — non-empty | ordered `{ path, bytes }[]`; all validated first, duplicate targets rejected by file identity, NUL content rejected (read would refuse it). Serialized per file against a concurrent `edit` on the same path |
| `edit` | `(edits: { path, oldString, newString, replaceAll? }[])` — non-empty | ordered `{ path, replacements, bytes, match? }[]`; exact-first matching (typographic and trailing-whitespace fallbacks, line endings preserved), all preflighted before the first write, each file written once. `match` names a fallback tier. Read-match-write is one per-file critical section (`./tools/files/lock.ts`), so a concurrent call fails with "no match" instead of clobbering the other's change |
| `files` | `(ops: ({ op: 'list' \| 'move' \| 'copy' \| 'delete' \| 'mkdir', path? \| from+to, overwrite?, recursive?, force?, offset?, limit? })[])` - non-empty, ≤100 | `{ results, bytes, contentBudget }` with ONE ordered receipt per operation: `list` → `{ path, entries, truncated, nextOffset, offset, limit, bytes }` (ONE page of `dir/entry`, directories end with `/`, non-recursive, 200 entries default / 1000 max, 64 KiB of entry text shared by every list operation in the call); `move`/`copy` → `{ path, to, kind, bytes }`, and an existing destination is refused unless `overwrite`; `delete` → `{ path, removed, recursive }` (a non-empty directory needs `recursive`, a missing path needs `force` and is then reported `removed: false, skipped: true`); `mkdir` → `{ path, created }`, creating parents and reporting an existing directory as `created: false`. A failed list entry carries its own `error: { code, message }`; a failed mutation rejects the call and names the operations already applied (there is no rollback). Operations run in array order against the state each one finds, and mutations hold the same per-file locks as `write`/`edit` (`./tools/files/lock.ts`) |
| `glob` | `({ patterns?, paths?, maxResults? })` | `{ files, truncated }` — names only; the old `content` property is gone and the schema rejects it |
| `grep` | `({ pattern, patterns?, paths?, maxResults? })` | `{ matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget }` (required `pattern`; 1 KiB snippet per line, 64 KiB aggregate) |
| `shell` | `({ command, cwd?, timeoutMs?, input?, saveOutput? })` | `{ exitCode, stdout, stderr, truncated, stdoutTruncated, stderrTruncated, stdoutBytes, stderrBytes, stdoutDroppedBytes, stderrDroppedBytes, outputPath, timedOut, aborted, exitSignal, durationMs, linesChained }`; stdout 128 KiB / stderr 16 KiB **head+tail** with an in-band `[... N bytes omitted ...]` marker (`./boundedOutput`, because build and test output is read from the end) and the full stream teed to `outputPath` when either was cut; timeout 1..600000 ms (default 120000), process tree killed best-effort (`taskkill /T` cannot reach detached/reparented descendants), and a run that finished on its own is never reported `timedOut`; stdin is closed by default and `input` feeds it; on Windows a multi-line `command` is chained with `&&` because cmd.exe otherwise executes only its first line; `exitCode` is normalised to the signed convention |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut, stderrTruncated, aborted }`; `paths` is one path or a non-empty array |
| `download` | `({ url, name? })` — absolute `http(s)`, no userinfo, URL ≤2 048 chars | a `toolMedia()` **envelope**, not a plain value: `{ content: { url, finalUrl, contentType, kind, name, bytes, declaredBytes?, media: 'attached', mediaId }, __toolMedia: [attachment] }` — the summary text is what the model reads, the bytes ride on the tool message (20 MiB cap, 60 s, one attempt, nothing written to disk) |

Implementation notes worth keeping:

- **`syntax` never executes code.** JavaScript compiles with `node:vm`'s
  `Script` (parses, never runs; classic scripts only — `import`/`export` report
  false). TypeScript/TSX/JSX go through the `typescript` dependency already used by
  `core/tool-source`, with `transpileModule(..., reportDiagnostics)` and the dialect
  chosen by FILE NAME (`snippet.ts` / `.tsx` / `.jsx`) — syntax diagnostics only, so a
  TYPE error is still `true`, and `<div/>` parses in tsx/jsx but not in typescript.
  JSON is strict `JSON.parse` (one leading BOM ignored), because the compiler's JSON
  reader is JSONC-lenient and `transpileModule` cannot emit a .json file at all.
  Python pipes source to `compile()` through the interpreter, which also
  only parses. Every parser is a separate module imported on demand, so a check
  in one language never loads another's Node built-in (the compiler is
  multi-megabyte and stays out of js/json/python runs).
- **`syntax` answers with a verdict only for languages it can read.** `language` has
  no schema `enum`: it is a validated free name, normalized (trim, casefold, a leading
  dot) and resolved through an alias table, and anything outside that table THROWS
  listing the supported set. A non-string `code` throws for the same reason —
  `false` must keep meaning "this snippet did not parse".
- **The Python half needs a Python 3 interpreter.** Probes `python3` then `python`
  by exit status (the Windows Store `python3` shim exists but exits non-zero) and
  caches the answer. A missing interpreter **throws** — "false" must keep meaning
  "your code is wrong".
- **The four batched file tools declare ONE array property** (`paths` / `files` /
  `edits`), so the single-property rule hands `execute` the array itself. That is
  what makes `read(['a', 'b'])` and a model call carrying
  `{ "paths": ["a", "b"] }` the same code path. `read` keeps that property while
  allowing range objects as ITEMS (`{ path, startLine?, startColumn?, startByte?,
  maxLines? }`); per-file windows are not a second top-level property.
- **`read` is bounded by default.** 5000 lines per file (`maxLines`, hard max
  20000) from a 1-based `startLine`, plus a fixed 256 KiB aggregate budget measured on
  the SERIALIZED result (`FILE_READ_WIRE_BUDGET`), allocated by DEMAND: every readable
  file gets an equal share, files needing less hand the difference back to the files
  actually cut, and the passes are capped. The default is sized so the BUDGET binds
  before the line count on typical source — a 200-line default used 14.2% of the
  envelope and a 1200-line default 22.7%, so a call spent a round trip to return a
  fifth of what it was allowed. It streams 64 KiB chunks and stops at the cap, so a
  huge file or giant line is never read wholesale. `content` is raw text
  (line 1 is `startLine`); a truncated entry reports `nextLine`/`nextColumn`/`nextByte`,
  where `nextColumn` is a 0-based byte offset inside the line (non-zero only for a line
  cut mid-line). `startByte = nextByte` resumes by SEEKING with no line counting, which
  is the O(window) way to walk a large file; a line-based window at line N rescans from
  byte 0. A NUL or invalid UTF-8 sequence in the chunks DECODED WHILE STREAMING rejects
  that ENTRY as binary; this is not whole-file validation, since bytes after the last
  read chunk are never inspected, so one file can read as text for a narrow window and
  as `EBINARY` for a wide one. A call accepts at most 100 paths so metadata cannot grow
  without bound either.
  A path that cannot be read is DATA, not a failed call: it keeps its ordered slot as
  an entry with empty `content`, `endLine = startLine - 1`, `bytes: 0`, and
  `error: { code, message }` — `ENOENT`, `EISDIR`, `EACCES`/`EPERM`, `EBINARY`, or
  `EIO` — and it consumes no budget (the split is computed across files that actually
  opened, see `execute`'s two phases), so the readable files are still returned in
  full. Only a malformed REQUEST rejects the whole call.
  `wireBytes` is the exact serialized length of the response and always satisfies
  `wireBytes <= contentBudget`, which is what keeps the continuation fields alive
  through the harness's own cap (`MODEL_TOOL_RESULT_BUDGET_BYTES`, held equal to
  `FILE_READ_WIRE_BUDGET` by an assertion in `read.test.ts` rather than an import, so
  the preset compiles with no captured dependency).
- **`write` / `edit` preflight everything.** Every entry is shape-checked,
  every target must be unique **by real file identity** (`tools/files/identity.ts`:
  `realpath`, plus the nearest existing ancestor for a file that does not exist yet,
  case-folded only on Windows — so `notes.txt`/`NOTES.TXT` and symlink aliases are
  caught, while Linux keeps `a.ts`/`A.ts` as two files), and (for edits) every file
  is read and match-checked before the first byte is written, so one bad entry leaves
  every file untouched. A filesystem error during the write phase names the completed
  paths: there is **no transaction and no rollback**.
- **`write` / `edit` hold one critical section per file** (`tools/files/lock.ts`,
  keyed by that same file identity). Read-match-write is three awaits, so two
  overlapping calls used to read one original text, both match, both report success,
  and the last write silently won (measured: `VERSION-0` plus three concurrent edits
  ended at `VERSION-C` with all three claiming to have applied). With the lock the
  later call sees the earlier call's text and fails honestly with "no match". A
  multi-file batch acquires its locks **deduplicated and sorted by identity** and
  releases in reverse, so two batches naming overlapping files cannot deadlock. The
  map entry is dropped when the last holder leaves, so the key set does not grow with
  the number of files the process has touched. This is per-process, per-event-loop
  only: it orders nothing against another process or worker thread, and claims not to.
- **`edit` is exact-first and guarded (opencode v2 matching).** Matching runs a
  three-tier cascade on an LF view of the file: exact bytes, then typographic
  quote/dash/space folding, then trailing-whitespace-ignoring whole-line matching —
  a fallback tier only runs when the tier above found NOTHING, and indentation is
  never forgiven. CRLF/mixed endings are matched and preserved (replacements are
  re-joined with the matched region's endings); an oldString/newString pair that
  differs only in `\r` applies to the exact bytes. `oldString` must appear exactly
  once or `replaceAll: true` must be passed; a match whose replacement equals the
  file text is rejected, not reported as applied. A missing file is an error that says
  so and names `write` (the raw errno used to leak as `ENOENT: no such file or
  directory, open '...'`, which named no remedy); a directory target is classified as
  a directory rather than a permission denial, which matters because Windows reports
  EPERM for both. The result reports `replacements`, the new byte size, and `match`
  when a fallback tier was used.
- **`files`' `list` operation takes one directory or several and returns ONE PAGE.**
  `files([{ op: 'list', path: ['src', 'task'] }])` returns one flat list whose entries
  are prefixed with their directory (`src/a.ts`, `src/nested/`, `task/b.ts`); directories
  keep the trailing `/`. It stays **non-recursive** - `glob({ patterns: ['**/*'] })` is the
  walking tool - and omitting `path` lists the working directory, returning bare entry
  names. Paging state lives INSIDE the list receipt (`{ entries, truncated, nextOffset,`
  `offset, limit, bytes }`), which is what lets `files` declare ONE array property (`ops`)
  where `fileList` needed three - the catalogue's last exception to the batching rule is
  gone. The 64 KiB entry-text budget is shared by every list operation in one call. Unlike
  `fileList`, a directory that cannot be read is that entry’s own `error`
  (`ENOENT`/`ENOTDIR`/`EACCES`…) rather than a failed call, because a read-only miss must not
  discard mutations the same call already applied; the server's direct-call route resolves both the
  legacy bare value and the wrapper through the shared validator
  (`resolveToolParameters`, 'direct' mode), so they are the same request. An explicit
  `[]` is still an error. Directories are visited in the caller's order, each listing
  sorted by code point, and a missing directory rejects the whole call (no partial
  result).
  The result is `{ entries, truncated, nextOffset, offset, limit, bytes, contentBudget }`:
  a page holds at most 200 entries by default (hard maximum 1000) and at most 64 KiB
  of UTF-8 entry text. `truncated` is measured against the WHOLE list and `nextOffset`
  is always `offset + entries.length`, so passing it back as `offset` walks the tree
  once, in order, with no gaps or duplicates. The old `string[]` return is gone: a
  caller that only wants names reads `.entries`.
- **Search is TWO tools, not one tool with two modes.** `glob` answers with names
  (`{ files, truncated }`) and `grep` answers with lines
  (`{ matches, truncated, bytes, contentBudget }`); the old `content` discriminator is
  gone from `glob`'s schema (`additionalProperties: false`), so a stale request is
  rejected rather than silently reinterpreted, and there is no `fileSearch` alias.
  Both share `tools/files/search.ts`, so the rules below apply identically to each:
  `patterns` default `['**/*']` and are OR-ed; a pattern with no `/` also matches
  file names at any depth, and a pattern is matched against a file path **relative
  to each root** (results are root-prefixed, never absolute-matched). `paths` default
  `['.']` and are walked in caller order; overlapping roots are deduplicated by root
  identity first (a symlink alias, or `src`/`SRC` on Windows, is walked once) and
  then files by resolved identity, with the first root winning the prefix; the cap is
  global. A non-object argument (a string or an array) is rejected instead of
  silently meaning "every file", and an explicit empty `patterns`/`paths` array is
  rejected instead of matching nothing. Both skip `.git` and symlinks always, and skip
  `node_modules` unless a root is placed inside it; both honor the `.gitignore` files
  **at or below** each root (`tools/files/gitignore.ts`), so an ignored path is neither
  listed nor read, while a root you name explicitly is still walked because no rule
  above a root reaches into it. `grep` additionally skips binaries and files over 1 MiB,
  caps its result at 100
  matches (clamped 1-100), cuts each match to a 1 KiB snippet on a code-point boundary
  with `textTruncated`, and stops the whole call at a 64 KiB aggregate with
  `truncated`; `.git/info/exclude` and the global `core.excludesFile` are not read.
- **Content matching is time-bounded.** grep's `pattern` is a JavaScript regex, and
  JavaScript regexes backtrack: `(a+)+$` blocks the process for seconds on a 31-byte
  line. `tools/files/bounded-regex.ts` therefore runs the match loop inside
  `node:vm` with a cumulative 30-second MATCHING budget for the whole search
  (`MAX_CONTENT_MATCH_MILLIS`; charged only by measured regex execution, never by
  walking or reading — one context and one precompiled script per search, one call
  per FILE, so ordinary greps cost the same as before). That is the only time bound
  on MATCHING. CORRECTED IN PLACE
  2026-11-09: the clause here used to claim "there is no additional overall request
  timeout", and that stopped being true when the grep tool grew its own whole-search
  wall clock — `MAX_SEARCH_MILLIS` (30 s over walk, reads, and matching together,
  `src/tools/files/grep.tool.ts`). The two bounds now answer differently, which is
  the point of keeping them separate: exhausting the MATCHING budget is the
  pattern's fault and throws a `HarnessError` naming the budget and the likely
  cause, while exhausting the SEARCH budget is the TREE's fault and returns a
  partial result (`partial: true`, `stopReason: 'searchBudget'`, a note to narrow
  `paths`/`patterns`). A big search is a partial answer; an expensive pattern is an
  error; neither is ever reported as the other. It is a timeout, not a sandbox; an
  invalid pattern still fails in the host realm so the caller gets the parser's own
  `SyntaxError`.
- **`gitDiff` is the read-only git path.** A fixed argv with no shell, no colour,
  no external diff drivers, no textconv; `ref` may not start with `-`, and paths
  go after `--`. Non-zero exit is data, like `shell`.
- **No sandbox anywhere.** Paths resolve against `process.cwd()` and are used as
  given; `shell` and `gitDiff` run with host permissions. This matches other
  CLI harnesses: powerful by default, fenced by the process boundary the host
  provides. Say so loudly in docs.
- **Non-zero exit is data.** `shell` / `gitDiff` resolve with `exitCode`
  rather than throwing, so the model can read a failing command and react.
- `write` creates parent directories and returns the absolute path + byte
  count, because agents write into not-yet-existing directories constantly.

---

## Web search

`search` is the one preset-shaped tool that is **not** in `presetTools`, and the
reason is the design: it needs a provider credential, and a credential belongs to
one harness. A module singleton would freeze the first key ever read and advertise
a network tool the host may not be able to authenticate.

**Factory, not catalogue entry.** `createWebSearchTool({ env?, exa?, tavily?, linkup? })`
(`tools/websearch/index.ts`) resolves keys **once, at construction** (a getter is
not re-read per search; there is no rotation), and returns
`Tool<WebSearchParameters, WebSearchResult> | undefined`. `undefined` is not an
error: it means no provider has a usable key, and that is also what makes
`websearch: true` a no-op on a keyless host.

| Input | Result |
|---|---|
| absent / `false` | no tool |
| `true` / `{}` | read `EXA_API_KEY` / `TAVILY_API_KEY` / `LINKUP_API_KEY` from `process.env` |
| `env: {...}` | same, from an injected snapshot (tests, deploy) |
| `exa.apiKey` / `tavily.apiKey` / `linkup.apiKey` | explicit string or getter (called once), wins over env |
| explicit blank key | that provider is off, **without** falling back to env |
| no provider with a key | `undefined` |
| configured `tools.search` | wins; the factory is not consulted |

harness.ts registers the result after configured tools and before the reserved-name
check (so a preset or plugin cannot claim the name first), and only when
`configuration.websearch` is truthy (the field keeps its name) and no custom `search` exists. **A configured
`search` is core (R18)**: it is declared on every request, so the model calls it
directly instead of spending a toolRequest round. Registration is still conditional
on a usable key, so a keyless host neither declares nor lists a runnable search
tool. Keys live in the tool closure: two harnesses never share one, and nothing
enters the schema, arguments, result, events, `RunnerSettings`, the UI, or a client
payload.

**Catalogue visibility (C1).** `src/server/harnesses/websearch.ts` always produces an entry
for the direct-call catalogue. `createWebSearchCatalogueEntry()` calls the factory
at run time and returns `{ entry, tool? }`:

| Host state | Catalogue result |
|---|---|
| any of `EXA_API_KEY` / `TAVILY_API_KEY` / `LINKUP_API_KEY` present | entry + executable tool; `availability: { state: 'available', environment: [...] }` |
| no usable key | entry with `WEB_SEARCH_METADATA` and no `tool`; `availability: { state: 'unconfigured', environment: [...], hint }` |

`src/server/harnesses/index.ts` exports `createToolCatalogue(options?)` instead of module-level
`catalogue`/`allTools`. The factory is what makes startup ordering safe: the server
and CLI load `.env` after their imports, then build the catalogue, so the key is
captured once for the handler's lifetime (never at module evaluation). `websearch`
is group `'Web search'` and `webfetch` is group `'Web fetch'` (the `ToolGroup` union in
`src/server/harnesses/types.ts`); existing groups and the CLI column layout are
unchanged.
`GET /api/tools` sends the optional `availability` field; `POST /api/tools/search`
executes the injected tool when configured and returns `{ ok: false, error }` with
the hint when not. No path echoes a key value — the hint carries variable names
only.

**The fetch entry is the same shape with a different gate.**
`src/server/harnesses/webfetch.ts` exports `createWebFetchCatalogueEntry({ enabled?,
configuration? })` -> `{ entry, tool? }`. `enabled` defaults to `true`, because every
live preset builds its toolbox with `webfetch: true` (`./toolbox.ts`) and the `native`
provider needs no credential; a host that never opts in passes `enabled: false` and
gets the entry with `WEB_FETCH_METADATA`, no `tool`, and
`availability: { state: 'unconfigured', environment: ['EXA_API_KEY', 'LINKUP_API_KEY'],
hint }`. `createToolCatalogue()` appends it right after `search`, and that pairing is
what lets `describeHarness` name `fetch` in a card's `tools`/`coreTools`: a descriptor
advertises an environment tool only when the catalogue can actually run it.

**Wire contracts** (fixed endpoints, keys in headers only):

- Exa — `POST https://api.exa.ai/search`, `x-api-key`, body
  `{ query, type: 'auto', numResults, contents: { highlights: true } }`, response
  `results[{ title, url, highlights: string[], publishedDate? }]`.
- Tavily — `POST https://api.tavily.com/search`, `Authorization: Bearer`, body
  `{ query, max_results, search_depth: 'basic', include_answer: false,
  include_raw_content: false }`, response `results[{ title, url, content,
  score?, published_date? }]`.
- Linkup — `POST https://api.linkup.so/v1/search`, `Authorization: Bearer`, body
  `{ q, depth: 'fast', outputType: 'searchResults', maxResults }`, response
  `results[{ type, name, url, content, favicon }]`. `name` is the title and
  `content` the excerpt; `type`/`favicon` are dropped and Linkup sends no
  publication date, so `published` is simply absent for this provider.
  `depth: 'fast'` and `outputType: 'searchResults'` are pinned for cost and
  shape: an LLM-composed answer would be model output presented as a search
  result (the same reason Tavily's `include_answer` is off).

`numResults` / `max_results` / `maxResults` are always set explicitly: the
provider default must not decide the tool's context cost. `score` is ignored;
highlights are joined into one snippet.

**R12 hardening.** A snippet is redacted BEFORE it is cut to the per-result limit, so
a secret cannot survive in the retained prefix of a truncated highlight. A URL is
accepted only when it parses, is `http(s)`, has NO userinfo, and is at most 2048
characters; `published` is kept only when it is a string of at most 64 characters.
The provider response is read through a streamed 512 KiB body cap, so a runaway page
or a hostile provider cannot allocate an unbounded buffer. These are input/output
bounds, not a claim that a search result is trustworthy.

**Bounds** (`tools/websearch/request.ts`): 5 results by default, 20 maximum
(clamped), 300-character title, 1,000-character snippet, a **512 KiB**
(`512 * 1024` bytes) response read per streamed chunk with a `content-length`
pre-check, 15 s timeout via `AbortController` cleared in
`finally`, `redirect: 'error'`, http(s)-only result URLs. Rows without a valid URL
are dropped, not fatal; the first row's title falls back to its URL. The 512 KiB
budget is the PROVIDER budget; the `fetch` tool's page GET is held to 100 KiB
instead (see [Web fetch](#web-fetch)).

**Cost policy:** one request, no retry, no failover, one provider. The default is
the first provider with a key in the fixed `PROVIDERS` order **exa → tavily →
linkup** (so Exa wins whenever its key exists, and appending a provider later
never reorders what an existing deployment resolves to); `provider` overrides per
call and is only offered when more
than one is configured. 401/403 → key rejected, 402/432/433 → credits/quota, 429
→ rate limited, other non-2xx → HTTP status; timeout, network failure, non-JSON,
and a missing `results` list each get one fixed sentence. **The provider body is
never echoed**, so an error cannot print a key, an account name, or HTML.

**Secret hygiene:** every returned string (title, URL, snippet, published) passes
through `createRedactor` over *all* non-empty configured keys, however short, so
even a page quoting a key becomes `[redacted]`. The description names configured
providers but never a value; no environment variable name appears in metadata
either.

**Laziness:** `tools/websearch/index.ts` statically imports only `tool`, types,
`HarnessError`, and `request.ts`; `exa.ts` / `tavily.ts` / `linkup.ts` are
`import()`ed inside `execute` (one explicit branch per provider, so a fourth
provider fails loudly there instead of silently running Linkup's adapter). No
SDK: all three adapters use `fetch`. A failed import is a plain tool error
and is not cached, so a later call can retry.

**Application wiring:** the real presets (`instruct`, `research`, `workspace`,
`reviewer`, `planner`) pass `websearch: true` AND `webfetch: true` through the
shared toolbox (`src/server/harnesses/toolbox.ts`), so the CLI and server read
search keys from their own process environment; the shared-factory `flaky` example
opts in
too, while `demo` stays offline. `flaky`'s preset metadata declares
`environmentTools: ['search', 'fetch']` so its descriptor matches what the
factory registers.
This is why no search key was added to `RunnerSettings` or the Endpoint panel. The
app entry points preload the package-root `.env` into `process.env` (see “CLI,
server, and UI”); the library still has no autoload and importing it never reads a
file.

**Preset descriptors follow the catalogue.** Those live presets also declare
`environmentTools: ['search', 'fetch']` in `src/server/harnesses/presets.ts` — metadata
only, no harness is built to answer a listing. `describeHarness` appends such a name
to the preset's `tools` only when the runtime catalogue holds an executable definition
for it, and includes it in `coreTools` under the same condition (R18). That pairing is
why each web name has its own catalogue module
(`src/server/harnesses/{websearch,webfetch}.ts`): without a `fetch` entry a card could
never advertise the declaration its harness really makes. A keyless host therefore
advertises no search at all (the global catalogue still shows the tool as unconfigured
with its hint) but does advertise `fetch`, because the `native` provider needs no
credential. Core file tools in `coreTools` are likewise filtered by the preset's
registered names, so the demo fixture (timeNow only) does not claim them. Both web
names are declared CORE when registered (R9-R11): a configured search and any enabled
fetch are in the first request's schema, while the eleven demoted runtime rows and
`download` wait for `toolRequest`.

**Operator surface.** `/websearch <query>` is the built-in slash command over the
registered `search` tool; when the tool is absent it answers the configuration guidance
instead of a registry error (see [Slash commands](#slash-commands)).

---

## Web fetch

`fetch` (`tools/webfetch/`) is the page-reading sibling of `search` and follows the
same factory rule (`createWebFetchTool({ env?, exa?, linkup? })`), with one
deliberate difference: **it always returns a Tool.** The default provider is
`native`, a direct GET with no credential, so "opted in but keyless" is still a
runnable tool. `harness({ webfetch: true })` registers it; the configuration field
keeps the folder name while the TOOL is `fetch`.

| Fact | Behaviour |
|---|---|
| Default provider | `native`, always — even when an Exa/Linkup key exists. Hosted crawlers cost credits, so they are never a silent upgrade; `provider` picks them per call. |
| Keyed providers | `exa` (`EXA_API_KEY`) and `linkup` (`LINKUP_API_KEY`) only. Tavily is search-only. Same explicit-string-or-getter resolution as search: omitted → env, explicit blank → provider absent with no env fallback. |
| Schema | `url` (required), `format` (`markdown` default / `text` / `html`), and `provider` ONLY when a hosted key resolved (`available.length > 1`). |
| Visibility | `core` (R9-R11, same policy as a configured `search`): a harness that registered `fetch` declares it on every request, so researching a page costs no `toolRequest` round. The gate is REGISTRATION, not visibility — no `webfetch` opt-in means no tool and no declaration. Registration: `tools/runtime/fetch.tool.ts`, `activation: 'webfetch'`, `mode: sync`, `order: 250`. |
| Redirects | Followed; the result reports the final URL (the hosted JSON calls keep search's `redirect: 'error'`). |

**Text only, and the bound is a policy pair.** `tools/webfetch/request.ts` caps a
native page at **100 KiB** (`100 * 1024` bytes) — checked against `content-length`
before the body is touched and then per streamed chunk, cancelling the reader the
moment the budget is crossed — and returns at most **24,000 characters**
(`truncated: true` when cut). 100 KiB (not the 512 KiB the provider requests
allow) is the point: a page that does not fit is a file, not an article. The
content-type gate agrees with that sentence: no header is treated as text, and the
readable set is `text/*`, `application/json`, `*+json`, `application/xml`,
`*+xml`, `application/xhtml+xml`, the JS/TS MIMEs and `image/svg+xml` (SVG is
text, and must be checked BEFORE the `image|audio|video/` family rejection).
Everything else is refused with one sentence that names `download`, so the tool
description and the gate are one policy stated twice. Timeout is 15 s with one
attempt per user agent, plus a single honest-`User-Agent` retry (`underload-harness`)
when Cloudflare answers `cf-mitigated: challenge` to the browser-impersonating one.

The hosted adapters reuse `tools/websearch/request.ts`'s `requestSearch` (fixed
endpoint, JSON body, key in a header, no redirects, 512 KiB streamed response cap,
sanitized status errors), so a hosted fetch failure reads "Exa search …" /
"Linkup search …" — one error vocabulary per api host. Exa's `/contents` takes
`text.maxCharacters` server-side (the local slice is a formality there); Linkup's
`/v1/fetch` has no such knob, so `MAX_CONTENT_CHARS` is applied locally. Both
answer markdown, so the reported `contentType` on those paths is `text/markdown`.
Redaction happens BEFORE the character cut (the search lesson: bounding first can
leave a secret prefix at the cut), over every configured web key.

**Application wiring:** the shared toolbox passes `webfetch: true`, so a live
session always has `fetch` registered (native on a keyless host) and declares it as
core. It is part of the server's direct-call catalogue too
(`src/server/harnesses/webfetch.ts`, group `Web fetch`): `createToolCatalogue()`
holds the package presets, the app tools, the `search` entry, and the `fetch`
entry, so `POST /api/tools/fetch` is answered whenever the host enabled webfetch —
which is what lets a preset card advertise the declaration its harness really makes.
A host that passes `createWebFetchCatalogueEntry({ enabled: false })` still LISTS the
tool, with `availability.state: 'unconfigured'`, the static `WEB_FETCH_METADATA`
shape, and no callable implementation.

**Operator surface.** `/webfetch <url>` is the built-in slash command over the
registered `fetch` tool (the first token is the URL, and the tool's content-type gate
and character cap still apply); with `webfetch` disabled it answers the configuration
guidance instead (see [Slash commands](#slash-commands)).

---

## Web download

`download` (`tools/webdownload/download.tool.ts`) is the byte path. `fetch`
answers bounded text and refuses a binary; `download` accepts **any** content
type, caps the transfer, and hands the real bytes to the model as multimodal
input. It is a plain **preset** — in `presetTools`, exported by name, listed and
callable in the server catalogue — with `registration: { group: 'preset',
activation: 'always', mode: 'sync', order: 235 }` and `visibility: 'core'`, so
every harness registers and declares it without a key, a configuration field, or a
discovery round. `presets: false` is the only way to keep it out.

**Caps (all enforced before allocation, all module-local literals).**
`MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024` decoded bytes, checked twice — against
`content-length` before any byte is paid for, then per streamed chunk for a host
that declares nothing or lies. `DOWNLOAD_TIMEOUT_MS = 60_000` for the whole
transfer (a 20 MiB file on a slow link is normal; `fetch`'s 15 s is not), one
attempt, redirects followed, `context.signal` LINKED to the timeout controller so
`toolCancel`/run abort stops the socket rather than only its delivery. URL must be
absolute `http(s)` without userinfo, ≤2,048 characters. **Nothing is written to
disk** — there is no output path argument; a host that wants a file uses `write`.

The value a caller gets is a `toolMedia()` **envelope**
(`{ __toolMedia: [attachment], content: summary }`), and the two halves are
deliberately different sizes:

- `content` is the small JSON summary (`url`, `finalUrl`, `contentType`, `kind`,
  `name`, `bytes`, `declaredBytes?`, `media: 'attached'`, `mediaId`) — a few
  hundred bytes, so the 64 KiB model-facing result budget never touches it;
- the bytes go on the committed `tool` message's `attachments`
  (`HarnessMessage` tool branch), which is what makes them survive history,
  snapshot restore, and forks;
- a `tool_result` event and the server's manual execute answer carry
  `ToolMediaDescriptor[]` (`id`, `kind`, `name`, `mime`, `size`) — metadata only,
  never base64, because events are JSON round-tripped and persisted per turn;
- the transport expands the attachments into a clearly labelled **USER**-role
  payload AFTER the whole contiguous tool block, so strict provider tool-call
  pairing is never broken. Markers/ids are regenerated when one block aggregates
  several downloads whose `dl-1` ids would collide.

Validation runs at both ends of the seam: `toolMedia()` fails the call, and
`toolMediaOf()` re-validates at the unwrap boundary so a forged envelope cannot
splice 500 MB into history. An invalid envelope is REJECTED, never silently
dropped — "downloaded but the model never saw it" is the failure this rule exists
to prevent. Known families keep their media kind and are checked against the
shared magic signatures (a server claiming `image/png` and sending HTML fails
loudly); anything else is `kind: 'file'` with its exact bytes and a sanitized
filename (≤200 chars, no path separators, no drive colon).

**Trust profiles are not interchangeable.** `validateAttachments` takes a profile:
uploads keep `UPLOAD_ATTACHMENT_LIMITS` (4 MiB per file / 8 MiB per turn / 4
files, and `kind: 'file'` is an explicit transport refusal), while tool media uses
`DOWNLOAD_ATTACHMENT_LIMITS` (20 MiB per file, 4 files / 80 MiB per aggregated
block). Grammar, MIME tables, magic signatures and canonical base64 are shared, so
a download is never held to a looser standard than an upload.

**Provider support is the open end, stated plainly.** The transport maps image →
`image_url`, pdf → `file` (data URL), audio → `input_audio` (wav/mp3), video →
`video_url` **only when the request host is `openrouter.ai`** (an OpenRouter
extension, decided on the actual hostname so an OpenAI gateway is never sent an
unsupported part), and a generic `file` → the OpenAI-compatible
`{ type: 'file', file: { filename, file_data } }` part under the tool-media policy
(under the upload policy it stays an explicit "not supported" error). A provider
that cannot represent the part answers with its own explicit error; nothing is
dropped quietly. So "the model can see the file" is a claim about the configured
model, not about this package.

**Cost of the bytes.** One 20 MiB download becomes ~27 MiB of base64 in the
persisted transcript, in the snapshot, and in every later request body built from
it. `forks.maxHistoryBytes` (default 8 MiB of serialized history including
attachment payloads) therefore still applies and can block a fork of a
download-heavy session until it is raised. There is no UI preview of downloaded
files.

**Packaging contract.** The entry is compiled as editable source, so its only
value imports are the `../../core` barrel and `../../util`; the bounds and MIME
tables are literals to keep the captured source revision at `dependencies: []`. The
focused test (`download.test.ts`) asserts those literals equal the authoritative
numbers in `shared/attachments.ts`, so the two cannot drift. The folder barrel is
type-only for the same reason a value re-export anywhere else would eagerly
evaluate the entry.

---

## toolCreate

The model can write a small tool for itself mid-conversation; the host can do the
same with `writer.toolCreate(configuration)`. One registration path serves both
(`createToolFrom` in `src/harness.ts`, `createDynamicTool` in `src/core/creation.ts`).

```ts
const tool = writer.toolCreate({
    name: 'upper',
    description: 'Uppercase a string.',
    tags: ['text', 'upper'],
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    source: 'return String(args).toUpperCase();'   // BODY of an async function
});
```

- **Two-phase.** Registration validates the shape and compiles the body
  (`new AsyncFunction('args', 'context', source)`) but **never executes** it. The
  body runs only when the tool is called, receiving `args` (the parameter value,
  single-property rule applied) and `context` (the full `ToolContext`).
- **Validation** (`core/creation.ts`): name must be a letter first, then
  letters/digits/`_`/`-`, ≤64 chars; reserved names are rejected case-insensitively;
  description non-blank and ≤2 000 chars; 1–16 tags, each ≤64 chars; `parameters`
  must be a JSON-serialisable object; source non-blank and ≤20 000 chars; a body
  that does not parse is a `HarnessError`.
- **Registry rules** (`src/harness.ts`): a case-insensitive collision with any
  registered tool is rejected ("fileread" cannot shadow "read"), and a harness
  may create at most **32** tools (`MAX_CREATED_TOOLS`). The model path returns the
  failure as a tool result; the host path throws.
- **Schema gate is a traversal limit, not schema validation**
  (`checkToolSchemaComplexity`): a created schema is re-sent on every request, so it
  is bounded to 12 levels of container nesting, 256 nested objects/arrays anywhere in
  the value, and 16 KiB of serialized bytes. The walk follows EVERY container —
  `properties`/`items`/`oneOf`, but equally `$defs`, `patternProperties`,
  `dependentSchemas`, or an unknown keyword — because a keyword-only walk let 400
  objects under `$defs` through; the byte cap is what catches one enormous scalar
  `description`/`enum` string. Cycles are rejected explicitly (a host can pass a live
  object; `JSON.stringify` would otherwise throw). `validateSchemaValue` still
  enforces only the vocabulary it documents, so these keywords are counted, not
  resolved.
- **Registered searchable and enabled immediately**, so the next turn can call it
  without a second toolRequest round. It stays in the searchable catalogue afterwards.
- **Session-local.** Created tools live in that harness's registry only; two
  harnesses cannot see each other's tools. A server with a database root persists
  their SOURCES in the session's core snapshot and recompiles them on restore
  (`reset()` keeps the registry and clears only the enabled set); without a root a
  restart starts clean.
- **No sandbox.** The body is compiled with the host realm's `Function`
  constructor and runs with the process's full permissions — the same trust model
  as `shell`. Nothing here isolates filesystem, network, or processes.

---

## Delegation

```ts
const team = harness({
    agents: { lead: agent({...}), tester: agent({...}), reviewer: agent({...}) },
    primary: 'lead',
    subagents: ['tester', 'reviewer'],
    report: { progress }
});
```

- `primary` names the entry agent. Optional; defaults to the first `agents` key.
  An unknown name throws at construction.
- `subagents` is the delegation allowlist. Optional; defaults to every agent except
  the primary. It must not contain the primary or an unknown name; duplicates are
  removed. An empty list (or a one-agent harness) means no `delegate` tool at all.
- The primary receives a core `delegate({ agent, input })` tool whose description
  lists the allowlist and whose `agent` parameter is an `enum` of it.
- **Each agent keeps its own `instruction`(s) and transcript.** A subagent never
  sees the primary's conversation; `run(target, input)` returns only the final
  `content`, and that `{ agent, content }` is what the tool result carries back.
- **One level deep, cycle-safe.** `delegate` is not declared to subagents, a
  guessed call from a subagent is rejected in `executeToolCall`, and the delegate
  implementation refuses when the caller is not the primary or when `runStack`
  shows a nested run. `runAgent` refuses to re-enter an agent already on the
  stack, which also closes `ctx.run` cycles.
- `ctx.run(name, input)` inside a tool still runs a full sibling turn; it is the
  tool-side path (used by the `textSummarize` harness tool) and is not model-visible
  delegation.
- **A delegation is a pending tool.** The parent's `delegate` call stays in
  flight until the child fully completes, so it can appear in the parent's
  `done.pending` list and the resume arrives as a `wakeup`. Calling the same child
  again queues a follow-up on that child's EXISTING transcript (it does not restart
  and does not lose history).
- **No time limit by default (policy 2026-11-09).** The child runs to its own final
  answer; `timeoutMs` is an optional bound the caller sets when it wants one, and an
  omitted or non-finite value arms no timer at all. While the call is in flight the
  parent's next request carries a `{ status: "pending", callId, … }` placeholder that
  NAMES `toolCancel` as the way to abandon the child, and `toolRequest` reports
  `toolCancel` under `alreadyAvailable` in exactly that window (it is a
  `pendingOnly` core control, declared only while work is in flight, so the report —
  not the catalogue — is where it is discoverable).
- **`scope.tools` cannot block the discovery door.** The allowlist hides and refuses
  every capability it omits, `toolRequest` excepted: a restricted child must always
  be able to ask for what it is missing. Before this, a child scoped to
  `["read","glob"]` and told to write looped on `glob` for 45 messages instead of
  failing cleanly, and `scope: { tools: [] }` produced no output at all
  (docs/tasks/2026-11-08-delegate-stress-test.md, finding 2). Enabling a tool through
  discovery is still not the same as being allowed to call it — the launch gate keeps
  the allowlist for everything else.

### Shipped roles and their teams (T3)

`src/server/harnesses/presets.ts` derives every real preset's allowlist from ONE
list (`SPECIALIST_AGENT_NAMES`) with `teamOf(primary)`: the other four real roles,
then `summarizer`. The five primaries are `instruct`, `research` (title
"Researcher"), `workspace` (title "Coder"), `reviewer`, and `planner`. Consequences:

- every real preset registers `delegate` (there is always a target), and the
  Planner's `research`/`workspace`/`reviewer` targets exist by id;
- a subagent never re-delegates, so every profile's delegation guideline is
  conditional on BOTH running as the primary AND this harness declaring
  `delegate` to it, and tells a subagent/lone agent to do the work itself;
- `demo` (scripted) and `flaky` (failure example) stay fixtures with no subagents,
  and T5 un-shipped them: the server catalogue lists only the five real roles, while
  the fixtures remain presets a host or a test injects explicitly
  (`FIXTURE_PRESETS` / `ALL_PRESET_TEMPLATES`). The CLI and UI both select `instruct`
  first (the CLI default is the live role, and `--preset demo` still resolves through
  the lookup superset).

### Persistence restore policy (T3)

`restoreHarnessRegistry()` replays saved rows, but a saved BUILT-IN row whose
executable fields still match `LEGACY_PRESET_DEFINITIONS` (the previous shipped
defaults) is refreshed to the current template instead of pinning the old one. It is
the provable case: any executable difference (team, tools, environment tools,
template, non-empty `agentModels`) means the operator customised the row, and a
customised row is replayed verbatim. An edited title/description survives a refresh.
Frozen sessions never depend on this: `SessionStore.restoreSession` rebuilds from
the session's own `preset` record, so an old conversation keeps the team it started
with.

---

## Owner questions and history forks

Two conditional harness-owned core tools (N3/N4). Their parsers, defaults, and
bounds live in `core/action.ts` and `core/branch.ts`; the runtime handling is in
`src/harness.ts`; the server broker is `SessionStore` (`src/server/sessions.ts`);
the card is `src/frontend/ui/action-request.ts`.

### Registration and configuration

```ts
const writer = harness({
    agents: { writer: agent({ ... }) },
    interaction: {
        actionRequest: async (context, signal) => ({ kind: 'option', optionId: 'safe' }),
        autoAnswer: true                       // default
    },
    forks: {
        enabled: true,                         // default
        maxDepth: 2,
        maxConcurrent: 4,
        maxHistoryBytes: 8 * 1024 * 1024,
        maxBranchRecords: 64
    }
});
```

- `actionRequest` is registered only when `configuration.interaction` is present.
  Its `execute` is a deliberate refusal: the runtime handles it, so a direct
  `executeTool()` call cannot fabricate an owner.
- `threadFork` is registered when `forks.enabled` is true (default). Set
  `forks: { enabled: false }` for a harness that must not branch.
- `resolveForks` reads defaults from `core/branch.ts`. Every numeric bound must be
  a positive safe integer; a typo throws at construction instead of silently
  clamping. `maxConcurrent` counts autoanswer branches too.
- The server always passes an `interaction.actionRequest` handler into every
  preset (fresh and restored) and leaves `autoAnswer` unset. The CLI passes a
  handler that rejects with a readable "no owner UI" message, so a root question
  is declared and can be attempted, but the recommendation is never accepted on
  the user's behalf. A plain library harness without `interaction` has no
  `actionRequest` tool at all.

### actionRequest

Model arguments and the parsed request:

```ts
type HarnessActionOption = { id: string; label: string; description?: string };
type HarnessActionRequest = {
    requestId: string;              // runtime-generated, never model-supplied
    question: string;
    recommended: string;            // MUST be one of options[].id
    options: HarnessActionOption[];
    allowCustom: true;              // type-level constant, not an argument
};
```

- Strict parser (`validateActionRequestParameters`): plain object only; exactly
  `question`/`recommended`/`options`; no `allowCustom` argument (unknown properties
  are rejected). Bounds: question 1..4000, options 2..8, id 1..32 matching
  `^[A-Za-z0-9_-]+$`, unique ids, label 1..120, description trimmed and ≤500
  (blank is omitted). Ids/labels/question are trimmed by the parser. An unknown
  `recommended` id is an error, never a fallback to `options[0]`.
- `allowCustom` is always true: an owner can always answer
  `{ kind: 'custom', text }` (trimmed, 1..4000). `validateActionChoice` accepts
  exactly `{ kind: 'option', optionId }` or `{ kind: 'custom', text }`; an option
  id the model did not offer is an error, and a custom choice has no request-side
  switch to check.
- `HarnessActionHandler = (context, signal) => Promise<HarnessActionChoice>`.
  `context` is `{ requestId, agent, branchId?, threadId?, callId, request }`.
  `branchId` is the REQUESTER's branch, absent for a root. `signal` aborts with
  the run. A rejecting/throwing handler fails the tool call with a readable tool
  result (`actionRequest owner handler failed: …`).
- The model-visible result is `HarnessActionResult`
  `{ requestId, answeredBy: 'owner' | 'auto', choice }`. An option choice is
  widened with the resolved `label`/`description`; a custom choice is verbatim.
- The runtime request id is `request-<n>` (process-local monotonic).
- Pending limit: at most 4 unresolved requests per harness (`src/harness.ts`) and
  per session (`MAX_PENDING_ACTIONS` in `src/server/sessions.ts`). A fifth is
  rejected for the model, never auto-answered.
- Root runs: only the host handler can answer. If it is absent, the tool result is
  a readable "no interaction.actionRequest handler" failure; the recommendation is
  never selected automatically.
- Child/fork runs: the immediate owner is cloned at request instant, synchronously,
  over the owner's FULL history plus the requester's FULL history
  (`incorporateBranchHistory`; child system messages are demoted to quoted user
  data). The autoanswer branch is tool-free and gets exactly one turn, so it cannot
  recursively fork or ask again. It must
  reply `option:<id>` or `custom:<text>` on one line; blank, prose, an unknown id,
  or any tool call is an explicit failure. `forks.enabled` must be true and
  `autoAnswer !== false`. The answer is delivered only to the requester's
  `actionRequest` tool result; the owner transcript is unchanged. The autoanswer
  branch inherits the owner's role and records `tools: []`.

### threadFork

```ts
threadFork({ input: string; label?: string })
// -> HarnessForkResult { branchId, threadId, content }
```

- `input` is required and non-empty. `label` is display-only, trimmed, ≤120.
  `threadFork` is a normal tool call: the requester stays in flight and the branch
  runs as a separate actor.
- At request instant the runtime calls `forkAgent(run.agent, …)`; the branch gets
  this agent's ENTIRE committed transcript (never a slice), current model, and
  instruction snapshot. `materializeBranchHistory` deep-copies and validates every
  message, remaps every tool-call id to `call_<branchToken>_<n>`, rewrites every
  tool result to the remapped id, and pairs outstanding calls with the
  `threadFork` non-success placeholder. Duplicate/orphan results and repeated ids
  are rejected. The origin transcript is never mutated.
- Branches inherit the source `role`, so `declared(branch)` resolves the same
  role-aware core set: a fork of the primary keeps `delegate`/`toolCreate`
  under their policies; a fork of a subagent does not gain them. A fork can fork
  again until `maxDepth`.
- Bounds (`core/branch.ts`): `MAX_FORK_DEPTH = 2` (ordinary forks; autoanswer
  inherits the source depth), `MAX_FORK_CONCURRENT = 4` live branches,
  `MAX_FORK_HISTORY_BYTES = 8 MiB` of serialized history,
  `MAX_BRANCH_RECORDS = 64` retained records. Over-cap history is an EXPLICIT
  error — a fork never truncates history. The serialized cap includes attachment
  payloads, so a legal media-heavy turn can exceed 8 MiB; raise
  `forks.maxHistoryBytes` for those histories.
- The only value returned to the origin is `{ branchId, threadId, content }`, where
  `threadId === branchId`. `content` is the branch's final assistant text, trimmed
  and required non-empty (`threadFork branch "…" produced no substantive answer.`
  otherwise). There is no separate summarizer pass and no transcript merge; the
  full branch transcript stays in the audit record.
- Runtime identity is private: `actorKeyOf(branch)` is `branch:<branchId>`, never
  the display name, so a fork cannot deadlock behind a same-name source run.
  `actorRoles` inherits the source role; `agentBranchOf` reads the `WeakMap`.
- `harness.branches()` returns detached `HarnessBranchRecord` copies; `branch(id)`
  returns one or `undefined`. A record is `HarnessBranchSummary` plus `status`
  (`running|completed|failed|cancelled`), `toolCallIds` (origin→branch remap),
  `messages`, and optional `result`/`error`. Active records are never evicted;
  the newest terminal records fill the remaining `maxBranchRecords` capacity.
- Branch state is ephemeral: `branchRecords`/`activeBranches`/pending request ids
  are runtime/session state, deliberately NOT in `HarnessSnapshot` v1. `reset()`
  does not clear branch records (nor does restore bring them back); they are
  pruned only by the retention bound.
- `src/harness.ts` refuses `executeTool('threadFork' | 'actionRequest', …)` with
  "requires the harness run that owns the conversation", so neither can be
  invoked through the manual server tool route.

### Events and threads

- `action_request`: `{ agent, callId, request, thread? }`, emitted by the
  requester before the handler/owner fork is invoked, so a client can render the
  pending card.
- `action_answer`: `{ agent, requestId, answer, thread? }`, emitted for every
  accepted answer before the tool result. `answer` is
  `{ requestId, choice, source: 'owner'|'auto', branchId? }`.
- `branch_start`: `{ agent, branch: HarnessBranchSummary, thread? }`; for an
  autoanswer it is emitted before `action_request`.
- `branch_end`: `{ agent, branchId, status, error?, thread? }`; `error` is present
  for `failed`/`cancelled` and absent for `completed`.
- `HarnessThread` = `{ id, parentId?, callId?, input?, kind?, branchId? }`. `kind`
  is `'delegation' | 'fork' | 'autoanswer'`; a branch's `id` IS its `branchId`, and
  the branch's own frames carry that same `thread`, so `branch_start`/`branch_end`,
  the branch frames, `harness.branch(id)`, and the transcript's nested entry use
  one naming scheme. `input` is the branch/child task.

### Server broker and UI

- Route: `POST /sessions/:id/actions/:requestId/answer` (standalone `/api`, service
  `/v1/harness`) with body `{ choice }` and response `{ ok: true }`.
  `SessionStore.answerAction` validates against the recorded request and settles
  the handler promise exactly once. Status mapping: 400 malformed body/unknown
  option/out-of-bounds text, 404 unknown session or request id, 409 already
  answered or expired. It is deliberately allowed while the session is busy — the
  active run is awaiting it — and it never enqueues a turn.
- Pending entries keep the run's abort listener. `cancel()`, session end,
  `remove()`/`dispose()`, and an abort settle them with readable rejection text;
  `MAX_COMPLETED_ACTIONS = 64` request ids are remembered so a stale card is 409,
  never 404.
- Restore marks every recorded `action_request` id as expired (the awaiting
  runtime is gone) and starts no run, so a restarted session cannot resume a
  question.
- UI: one card per event. A root request is interactive: recommended option first,
  alternatives after, **always** a free-text custom path, explicit **Answer**
  (nothing auto-submits); submit disables controls, keeps the choice on failure,
  and treats `setAnswer` from `action_answer` as authoritative. A non-root card is
  read-only ("Auto-answered by the owner fork.") because its owner answers
  automatically. Cards capture the session id at render time; a session
  switch/clear or a terminal turn expires them, and `main.ts` re-checks the binding
  before POSTing, so an answer can never cross conversations.
- Branch entries render through the existing nested invocation layout (`thread`
  metadata) with a small kind tag; a settled turn's cards are expired on replay.

---


## harness

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    tools: { search: tool({...}) },
    report: { progress: async (event) => {} }
});

await writer('tell me about new year');
```

- **Callable.** `writer(input)` runs the entry agent to completion. With concurrent
  tools that also means it drains: it resolves only after the response is complete
  AND every pending call — delegated child runs included — has finished.
- **A thread has no wall-clock limit (policy 2026-11-09).** A conversation — a
  delegated child, a `threadFork` branch, a host thread, a steered turn — stops when
  its agent produces its final answer, and nothing external ends it on a clock. The
  one path that ever had a timer, `delegate`, now treats `timeoutMs` as an OPTIONAL,
  caller-set bound whose default is "no limit": set one when you believe a limit is
  warranted (a model may ask for 1..3600000 ms; the unvalidated host path
  `harness.runtime.delegate` may pass any finite bound and is not clamped), and on
  expiry the child returns the structured `status: "cancelled"` envelope with
  `partialContent` and `cancelledAtMessage`. CORRECTED IN PLACE: this default used to
  be a finite 300000 ms (5 minutes) inherited from the T28 hole where a child that ran
  `sleep 600` sat `running` forever — the mechanism survives, the finite default does
  not (`core/agent-limits.ts` `DELEGATE_TIMEOUT_MS` is now `Number.POSITIVE_INFINITY`,
  and `src/harness.delegation.test.ts` pins both halves). Consequences a reader must
  accept: a stuck child is abandoned by an explicit `toolCancel` on its pending
  `callId` (named in the `status: "pending"` placeholder), and a `writer(input)` whose
  child never settles never resolves — that is the drain contract above working as
  specified, not a bug. What DOES bound a long run: every tool's own timeout (below),
  the `maxIterations` REQUEST COUNT (`DEFAULT_MAX_ITERATIONS`, 16), `MAX_RUN_DEPTH`,
  the thread/branch/record caps, and — ADDED 2026-11-09 when the plugin-pipeline
  user-facing lists landed — a `turn.before` plugin's `stop` decision
  (`HarnessTurnDecision`, `docs/plugins.md`): a policy assertion by shipped code at
  a turn boundary, not a clock, and it ends the run through the run's own abort path
  (`stopped` record, `cancelled` invocation, the run's appended work rolled back).
  A stopped conversation is restarted by a HOST
  prompt (`sendThreadInput`), never by an agent's `threadSend`, which refuses
  `stopped` — the host owns stopping and reviving.
- **Concurrency lives in the runtime, not in the provider stream.** Each agent has
  one serialized model stream; its tool calls are async work scheduled together.
  An agent's `done` event is one RESPONSE: it may list `pending` calls still running
  and the agent is woken (`wakeup`) when outcomes land. A periodic wake
  (**600000 ms** default) keeps a hung call visible so it can be killed; there is
  **no automatic hard tool timeout**. Pending work is interrupted, not resumed,
  across a restart, and a hung call ends only through an explicit cancel (or the
  tool's own configured timeout). The same sentence holds for a whole THREAD since
  2026-11-09 (the bullet above), so "no automatic hard timeout" is now the rule at
  both levels, with the tool clocks the load-bearing defence; the wake covers a
  delegated child too (its own actor is pinged and its own inspecting turn declares
  `toolCancel` — `src/harness.delegation.test.ts`, policy doc T8).
- **Ordering is completion order.** Concurrent calls can interleave side effects
  (two writes/commands), and results are appended as they settle rather than in
  call order. Tools are async promises in ONE Node process: there are no OS worker
  threads and no CPU isolation, so CPU-bound JavaScript blocks the event loop. (A
  server-hosted session may opt out per deployment with
  `threadExecution: 'worker'`; see [Lane workers](#lane-workers-threadexecution-worker),
  and `ioExecution: 'worker'` for that deployment's durability writes — see
  [IO workers](#io-workers-ioexecution-worker).)
- **The entry agent is explicit or first.** `primary` names it; without one, the
  first `agents` key wins, so a single-agent config needs nothing. An unknown name
  throws at construction.
- **`subagents` is the delegation allowlist.** Defaults to every agent except the
  primary; must not contain the primary or an unknown name; empty means no
  `delegate` tool. See [Delegation](#delegation).
- The registry key is the identity for both agents and tools; `agent.name` /
  `tool.name` are overwritten to match.
- **Tool declarations are filtered, not the registry.** `writer.tools` holds the
  preset preload, the configured tools, `toolRequest`, `toolCreate`, `task`,
  `profileManage`, `chapterManage`, `locationManage`, `agentManage`, `agentResult`,
  `threadFork` when forks are
  enabled, `actionRequest` when interaction is configured, and `delegate` when
  there is a subagent; a request declares every core tool
  (`read`/`write`/`edit`/`glob`/`grep`, the environment `search`/`fetch` pair it
  actually registered, and the declared harness-owned set), then whatever toolRequest
  enabled. The searchable remainder (`files`, `shell`, `download`, ...) waits for
  discovery. `delegate` is core for
  the primary only.
- **`discoveredTools`** is a read-only copy of the enabled set, in discovery order.
  It persists for the harness's lifetime (every call/turn) and is emptied by
  `reset()`; a server snapshot records it so a reload can show it.
- **`executeTool(name, parameters)`** (R8) runs one REGISTERED tool directly with
  this harness's context (`agent: primary`, `agents`, `run`). It is the server's
  manual-execution path for the session-bound tools (`POST /tools/:name` with a
  `sessionId`), so a manual toolRequest/toolCreate/task/profileManage/
  chapterManage/locationManage/agentManage/agentResult/delegate call mutates
  this session. Core file tools and search are ordinary direct-call catalogue
  entries and do not need a session. Discovery gates the MODEL only: an explicit
  operator call may run a searchable tool that was never enabled. Nothing else is bypassed — `toolCreate` keeps its guarded
  registration, `delegate` keeps its primary-only check, and a name this harness
  did not register (delegate without subagents) throws instead of inventing an
  implementation. `actionRequest` and `threadFork` are refused explicitly: both
  need the owning run (`requires the harness run that owns the conversation`).
  No progress events are emitted: a manual call is not a turn.
- `forks` resolves to `{ enabled, maxDepth, maxConcurrent, maxHistoryBytes,
  maxBranchRecords }` with defaults `true, 2, 4, 8 MiB, 64`; `enabled: true`
  registers `threadFork`. `interaction` presence registers `actionRequest`;
  `autoAnswer` defaults true and only controls a child/fork request's owner fork.
  See [Owner questions and history forks](#owner-questions-and-history-forks).
- `branches()` / `branch(id)` expose DETACHED branch audit records. They are
  ephemeral: branch records, active slots, and pending action requests are not in
  `snapshot()`/`restore()` (N3). `branches()` prunes to `maxBranchRecords`, keeping
  every running record and the newest terminal ones.
- `presets` (default `true`) preloads `presetTools` into the registry. `false`
  starts from `tools` alone. A configured tool wins on a name collision.
- `plugins` remains as an optional programmatic extension point
  (`createAgent`, `addTool`, `addCommand`). It is not part of the declarative config shape, and
  a plugin-added tool is searchable like any other. The reserved names stay
  reserved for plugins too, while a plugin-added COMMAND replaces by name (see
  [Slash commands](#slash-commands)).
- `commands` is the declarative slash-command list
  (`{ name, description, usage?, execute }`). It installs after the built-ins, so a
  name that collides with one — or repeats inside the list — fails construction;
  plugins and `registerCommand` run later and override by name.
  See [Slash commands](#slash-commands).
- `reset()` clears the entry agent's conversation, the discovered-tool set, the session
  task list (records, the id counter, `storeRev` and the change log — `reset()` in
  `src/core/task.ts`), the three record stores, and the agent-result archive, so a
  reset run starts from the core set and empty session state. The terminal result
  archive is otherwise durable through snapshot/restore (see
  [Agent results](#agent-results-r3)).
  Created tools stay registered (registry state), just no longer enabled. The
  server resets every agent in a session, not only the primary; its extra
  agent-loop reset does not replace `harness.reset()`, which is what clears the
  shared `task` and record state. Branch records and action-request state are
  ephemeral runtime state and are not cleared by `reset()`.

**Members:** callable, `name`, `agent`, `agents`, `subagents`, `tools`, `plugins`,
`discoveredTools`, `toolCreate(config)`, `executeTool(name, parameters)`,
`commands`, `executeCommand(input)`, `registerCommand(command)`, `branches()`,
`branch(id)`, `reset()` — plus the thread surface (`threads()`, `thread(id)`,
`threadMessages(id)`, `setThreadMessages(id, messages)`, `createThread()`,
`sendThreadInput()`, `steerThread()`, `stopThread()`, `deleteThread()`) and
`snapshot()`/`restore()`.

### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    no tool calls?         -> report done, return the message
    schedule each tool     -> concurrently (one async actor per call)
    results arrive         -> a tool message per settled call, in completion order
    (loop again, waking on pending outcomes)
```

Multi-tool turns are **scheduled concurrently**, not run one after another. The
model stream stays serialized per agent (one request at a time), and every call
still gets a matching `tool` message with the id the model used, so strict
providers never see a dangling `tool_calls` id. The harness promise resolves only
when the response is complete and all pending work (delegates included) drains.

The tool declarations sent with each `turn()` are the core set plus the tools
toolRequest has enabled — that is how a discovery round changes the next request
without mutating the registry.

Recoverable failures become tool results the model can read:
- unknown tool → result listing the declared tools and pointing at toolRequest;
- undiscovered tool → result naming tags that would enable it (it does not run);
- malformed JSON arguments → result naming the parse failure (the tool is not
  executed). A call whose arguments parse but are **not a JSON object** (`[1,2]`,
  `42`, `"text"`, `null`) is rejected the same way: every tool is declared with an
  object schema, so nothing downstream can bind it. When the request stopped with
  `stopReason: 'length'`, the result also says the reply hit its output-token
  limit, because that is the usual cause — generation was cut off mid-JSON and the
  model needs to know the payload was truncated, not mistyped;
- throwing/rejecting tool (including a runtime-compiled module) → result with the
  error message. `throw undefined` / `Promise.reject(undefined)` are still
  failures: the scheduler records a `failed` flag independently of the payload.
  `toErrorInfo` also describes non-Error thrown values (`42`, a symbol, a plain
  object) and never throws while doing so;
- a tool that returns a result the harness cannot serialize → failed result naming
  the serialization error. The run continues and the other calls in the turn still
  deliver.
- a nested `context.callTool` or `context.run` failure propagates unchanged to an
  awaiting caller. A compiled tool that fires and forgets that promise cannot turn
  the failure into a process `unhandledRejection`; manual `executeTool` has the
  same observation while still rejecting for callers that await it. This covers the
  harness-issued promise only: a caller's own `.then(...)` chain without a
  rejection handler, a timer callback, or another detached async task is outside
  the harness boundary.
- arbitrary thrown values are classified with `isInstanceOf` (guarded
  `instanceof`) on server/harness catch paths. A hostile Proxy whose
  `getPrototypeOf` throws is reported as a normal tool error instead of escaping
  the catch; it is never misclassified as a `SessionError`/HTTP status.

Terminal failures truncate history to the pre-call length, emit `error`, and
throw:
- transport failure;
- more than **maxIterations** model requests without an answer. Every request
  counts, including an immediate tool continuation, a pause turn, and every
  completion or timed wake. Defaults to **16** (the library guard);
  `harness({ maxIterations })` raises or lowers it and is validated at construction
  as a positive safe integer. The application presets pass 1000 for real sessions;
  the offline `demo` keeps the library default of 16. The bound is per agent run,
  so a delegated subagent gets its own budget.

Multi-tool turns are **scheduled concurrently**, and every call gets a matching
`tool` message so strict providers never see a dangling `tool_calls` id. The
agent's `done` is a response boundary, not a turn boundary: with concurrent calls
it may arrive while its own calls are still running (`pending`), and the runtime
wakes the agent (`wakeup`) as outcomes land. Cancellation signals every running
call (`toolCancel({ callId })` targets one): `toolCancel` logically settles/aborts
that call's own task and its late result is ignored; cancelling an already settled
(or already cancelled) call is a SUCCESS with `alreadySettled: true`, because
cancellation is a state to reach rather than a one-shot transition, while a
`callId` this run never started is an error. Command tools honour the abort
and kill their process tree, but arbitrary JavaScript cannot be preempted. A
whole-run abort preempts an uncooperative provider request, releases the child
actor/restore slot and rolls back the cancelled turn's in-flight prompt state
immediately; a late provider commit is rejected by the core precommit check. A
provider socket/generator that never returns can remain in memory without blocking
the actor or re-delegation, but a host `report.progress` reporter that hangs can
still stall the mailbox and therefore cancellation (no guaranteed reporter
watchdog). Because calls share one Node process there is no thread or CPU
isolation, and side effects are ordered by completion rather than by call order.

---

## Slash commands

A slash line is an **operator action, never a prompt**: it runs in the process that
owns the session and costs no model request. The registry lives on the harness handle,
not in a front end, so the CLI, the HTTP server and the UI composer execute ONE
implementation per name — which is the invariant this whole layer exists to protect.

- **Grammar (`src/core/command.ts`, pure: no harness, no transport).**
  `parseCommandLine(text)` answers `undefined` for anything whose trimmed text does
  not start with `/` — that is how a host decides "prompt, not command" — and
  otherwise `{ name, args, rest, input }`. Only the NAME is case-folded: arguments
  keep the case typed, because task text and search queries are data. `tokenize` is
  the shell-ish minimum and the whole contract: whitespace separates, `"…"`/`'…'`
  group, `\` escapes one character inside and outside quotes, `""` is an EMPTY
  argument (not a missing one), an unmatched quote swallows the rest of the line
  instead of throwing (an operator is mid-edit in a REPL), and a trailing `\` keeps
  itself. `COMMAND_NAME_PATTERN` (`/^[a-z][a-z0-9-]{0,31}$/`) is checked at
  registration, so a registry key is always `/`-safe and lowercase — one canonical
  spelling per command, so `/Task` and `/task` can never disagree.
  `normalizeCommandName` (trim + optional leading slash + lowercase) is used by BOTH
  registration and lookup; `validateCommandName` throws for a bad key.
  `formatCommandHelp` renders the sorted, diffable `/help` body
  (`/name  description`, then an indented `usage:` line).
- **Result shape (`HarnessCommandResult`, `src/types/index.ts`).**
  `{ content, isError?, data? }`: displayable text, a recoverable-failure flag a host
  styles instead of parsing prose, and the structured value for a UI.
  `executeCommand` normalizes a missing `content` to `''` and emits the optional keys
  only when the command set them, so a host can spread the result safely.
- **Built-ins (`src/core/command-builtins.ts`, exported as
  `createBuiltinCommands()`).** `/help [command]`, `/tools [filter]`,
  `/task [list|add|complete|reopen|remove|claim|release|takeover]`, `/websearch <query>`
  (the RAW tail is the query, so an exact phrase survives), `/webfetch <url>` (the FIRST
  token is the URL, so a trailing flag cannot corrupt it). The last three are
  **pass-throughs to the live tools** through
  `context.harness.executeTool('task' | 'search' | 'fetch', …)`, so they mutate THIS
  harness's stores and inherit the tools' bounds (200 tasks, 4000 characters, 20/page by
  default; the fetch content-type gate) instead of duplicating them. Because
  `executeTool` always supplies an agent identity, `/task complete|reopen|remove` are
  GUARDED writes: the command reads the whole store first (`offset` paging at limit 100,
  bounded to 16 pages) and sends the `expects` revisions it read, so a concurrent edit
  surfaces as the tool's stale error; `claim|release|takeover` send no token, and the
  command's own holder pair is `(entry agent, no thread)` (see [Session
  tasks](#session-tasks)). `search`/`fetch` are conditional, so an unconfigured session
  answers guidance naming the configuration field and the key names rather than
  `Tool "search" is not registered`. Nothing in the built-ins throws: a usage
  mistake, an unregistered tool, or a rejected tool call returns
  `{ content, isError: true }`; `executeCommand` is the only thrower. Bodies share the
  model's 64 KiB budget (`MODEL_TOOL_RESULT_BUDGET_BYTES`) but append a plain
  `… truncated: …` marker (`capText`), because a command result is human-facing.
- **Ordering and asymmetric collisions (`src/harness.ts`).** built-ins →
  `configuration.commands` → plugins (`api.addCommand`) → runtime
  `harness.registerCommand`. The first two phases reject a duplicate name, because two
  declarative entries cannot both mean one name:
  `Command "/task" is already registered. Built-in commands and "commands" entries
  share one namespace and must be unique; use a plugin or harness.registerCommand()
  to override "/task".` The last two REPLACE by name, mirroring `addTool` /
  `registerTool` — overriding a built-in is the supported way to change one. All
  validation happens before the first mutation (a rejected candidate changes nothing,
  the same atomicity rule the tool kernel follows), and the installed record is a NEW
  frozen-shape object, so a caller cannot mutate a published command afterwards.
  `handle.commands` is a getter that copies AND freezes per read: live, but never
  writable through the copy.
- **Execution (`handle.executeCommand`).** Lookups are own-key on BOTH surfaces — the
  dispatcher and `/help <name>` — so a command named `constructor` is legal, an
  unregistered `toString` is not "found", and `/help toString` answers "unknown
  command" instead of inventing an entry. The model is never called and NO progress
  event is emitted (a command is not a
  conversation turn, so a host can run `/task` while a run is in flight); a built-in's
  tool call still fires `stateChange('tool_execute')`, which is what a persistence
  layer needs to see the mutation. Two failures are exceptions because they are host
  bugs rather than user input: a line without a leading `/`
  (`a command must start with "/"`) and an unknown name (`unknown command: /nope`,
  and `unknown command: /` for a bare slash). A host command's own throw is rethrown.
- **Server path (`src/server/sessions.ts`).** `dispatch()` is the ONE submit surface
  `POST /sessions/:id/tasks` calls, and it is the only splitter: non-command text goes
  to `enqueue()` **untouched** (before any local check, so the legacy "attachment error
  wins over an empty prompt" precedence survives), and a command line becomes
  `executeCommandTurn()` — a real `SessionTurn` with `start` + `tool_call`
  (`name: 'command'`, `arguments: '{"input":"<verbatim line>"}'`) + `tool_result`
  paired by `callId`, NO `text`/`usage`/`done` (nothing generated, nothing billed),
  status `done`/`error`, no `threadId`, and terminal BEFORE the `202` (so nothing
  entered a queue and `settled` resolves immediately). Commands skip the single-flight
  gate and the pending cap on purpose; `attachments`/`references` are a `400`
  (a command has no schema to bind media to) and `threadId` is accepted-and-ignored (a
  command acts on the SESSION, never on one conversation, so its turn never joins a
  lane and is never purged with a focused thread). `session.status`/`lastError` are
  untouched. An unknown name and any command throw become an **error turn**, never a
  `500`. Durability follows the enqueue rule twice: the running row is written before
  any work (a failed write means the command never happened, so the record rolls
  back), and the terminal record is written with `persistOrThrow` before the response
  — except for a disposed session or a closing store, where the save is skipped so a
  shutdown file is not overwritten with an empty session list. A host handle without
  `executeCommand` (built before this layer) falls back to `enqueue()`, which is
  exactly what that server did before. The legacy `/messages` route never treats `/`
  as a command: its SSE envelope predates the registry and has no terminal-turn frame.
- **CLI path (`src/server/cli/commands.ts`).** Everything except readline/stdout, so
  the REPL is testable from a plain object: the host injects a `CliCommandHost`
  (`harness`, `presets`, `write`, `writeError`, `reset`, `exit`, `printTools`,
  `printPresets`) and gets back "was this line a command?". The LOCAL set
  (`exit`, `quit`, `help`, `reset`, `tools`, `presets`) is checked FIRST and therefore
  SHADOWS the same-named built-ins — a terminal wants the direct-call tool catalogue
  with `.env`-aware availability hints and the REPL's own list — while `/help` still
  prints `harness commands:` rendered verbatim from `harness.commands`, because
  hiding the shadowed entries would make `/help` disagree with the registry. The line
  is forwarded to `executeCommand` verbatim (`parsed.input`), replacing the old
  whole-input `toLowerCase()` that destroyed task text and query case. `./index.ts`
  prints the live registry in the banner, serializes input (extra lines typed while a
  line is in flight are dropped, so a command and a run never overlap), and routes
  command output to stderr under `--json` where stdout carries the event stream. An
  unknown command prints the harness message plus
  `hint: /help lists the commands this session can run`; any other throw prints
  `command failed: <message>`.
- **The invariant: commands are server state, the UI is a renderer.** There is no
  client-side command table and no browser command parser. The composer submits `/…`
  text to `/tasks` like any other message, and the recorded command turn renders
  through the ordinary tool-card path (`src/frontend/ui/activity.ts` switches on
  `tool_call`/`tool_result`, `src/frontend/ui/tools.ts` `createToolCallCard`), so a
  reload replays it with zero special cases. Anything the UI knows how to run is what
  `harness.commands` reports, which is why `--json`/CLI/server/UI all print one list.

Tests: `src/core/command.test.ts` (grammar, name validation, help rendering),
`src/harness.commands.test.ts` (registry order, collisions, plugin/runtime override,
`executeCommand` contracts), `src/server/commands.test.ts` (the `/tasks` command turn,
watcher frames, restart replay, lane bypass, 400s),
`src/server/cli/commands.test.ts` (shadowing, `/help` both sections, stderr routing).

---

## openAICompatible

```ts
const stream = openAICompatible({
    baseURL,                 // trailing slashes trimmed; /chat/completions appended
    apiKey,                  // string or () => string, resolved per request
    headers,                 // merged over generated headers
    sampling                 // temperature, top_p, max_tokens, presence/frequency_penalty
});
```

- Posts `{ model, stream: true, messages, tools?, ...sampling }`.
- Maps internal messages to the wire format: assistant `toolCalls` become
  `tool_calls[{ id, type: 'function', function: { name, arguments } }]`, and
  `role: 'tool'` becomes `{ role: 'tool', tool_call_id, content }`.
- `function.arguments` is normalized to a JSON **object** on the wire. A provider
  rejects a non-object or unparseable value with a bare
  `500 {"error":"Internal Server Error"}` for the whole request, so a tool call
  truncated by the output-token ceiling would otherwise fail every later request
  that replays it. The transcript keeps the raw text (it is what the model sent,
  and the UI shows it); only the payload is repaired, to `'{}'`.
- `reasoning` on an assistant message is **dropped** from the payload: local
  replay data, and several providers reject unknown message fields.
- Tool declarations default `parameters` to `{ type: 'object', properties: {} }`.
- Accumulates streamed tool-call fragments by `index` and reports complete calls
  on the terminal frame, ordered by index. Partial arguments are never executed.
- A provider that reports tool calls without `finish_reason` is treated as a
  tool turn (`stopReason: 'tool_calls'`).
- Does **not** send `stream_options` — several gateways reject unknown request
  fields. Usage is parsed when a provider volunteers it.
- Reads reasoning from `delta.reasoning_content` (DeepSeek-compatible) or
  `delta.reasoning`.
- Ignores non-`data:` lines (`event:`, `id:`, `:` comments). Stops at `[DONE]`.
  Flushes a final frame that arrived without a newline.
- Failures become `error` events: non-2xx (`HTTP <status>: <body>`), a
  `chunk.error` on a 200 stream, a malformed frame, a TRUNCATED stream (a body that
  closes without `[DONE]` and without a `finish_reason`), or a connection failure.
  The agent retries every one of those (see "agent" — R1); the transport itself
  never retries, so there is exactly one retry owner.

---

## listModels

```ts
import { listModels, ModelListError } from '@underload/harness';

const ids = await listModels({ baseURL, apiKey, headers?, signal? });
```

- `GET {baseURL}/models`, same URL rules as `openAICompatible`: trim, absolute,
  http(s) only, trailing slashes removed before `/models` is appended.
- Accepts `{ object: 'list', data: [{ id }] }` and a bare array. Ids are trimmed,
  empty values dropped, duplicates removed **in provider order** (a dropdown
  should not reshuffle the provider's preference). A non-string `id` is ignored.
- Resolves `[]` when the provider answers with an empty catalogue. That is a UI
  state, not an error.
- Throws `ModelListError` with `kind`: `'configuration'` (blank/invalid URL; no
  request attempted), `'request'` (network/TLS/abort), `'response'` (answered but
  unusable). The server maps configuration→400, the others→502.
- The key travels only in the `authorization` header (omitted when empty) and is
  redacted from every error message; errors quote a URL without userinfo, query,
  or fragment.
- The server calls it with a per-attempt abort (`POST /api/models`) because it
  owns the key and the browser cannot call the provider (no CORS, no key).
  Failed provider requests (`'request'`/`'response'`) are retried immediately
  with a fresh controller and a doubled deadline: 10 s, 20 s, 40 s, ... up to
  ten total attempts (the last at 5_120 s), stopping on the first success.
  `'configuration'` errors fail at once with no network call. Nothing is
  persisted or logged.

---

## HarnessEvent

```ts
| { type: 'start';          agent: string; model: string }
| { type: 'text';           agent: string; delta: string }
| { type: 'reasoning';      agent: string; delta: string }
| { type: 'tool_call';      agent: string; call: HarnessToolCall }
| { type: 'tool_result';    agent: string; name: string; callId?: string; content: string; isError: boolean; outcome?: HarnessToolOutcome; durationMs?: number; pending?: HarnessPendingTool[]; ui?: ToolUiPanel[] }
| { type: 'usage';         agent: string; usage: HarnessUsage }
| { type: 'done';           agent: string; message: HarnessAssistantMessage; pending?: HarnessPendingTool[] }
| { type: 'wakeup';         agent: string; reason: 'pending-tools'; pending: HarnessPendingTool[] }
| { type: 'retry';          agent: string; attempt: number; maxAttempts: number; delayMs: number; error: { message: string } }
| { type: 'attempt_commit'; agent: string; attempt: number; maxAttempts: number }
| { type: 'action_request'; agent: string; callId: string; request: HarnessActionRequest }
| { type: 'action_answer';  agent: string; requestId: string; answer: HarnessActionAnswer }
| { type: 'branch_start';   agent: string; branch: HarnessBranchSummary }
| { type: 'branch_end';     agent: string; branchId: string; status: HarnessBranchTerminalStatus; error?: HarnessErrorInfo }
| { type: 'error';          agent: string; error: { message: string } }

// EVERY variant also carries `thread?: HarnessThread` for a non-root run.
// HarnessPendingTool = { callId: string; name: string; elapsedMs: number }
// HarnessThread = { id; parentId?; callId?; input?; kind?: 'delegation'|'fork'|'autoanswer'; branchId? }
```

Delivered through `report.progress`, which is **awaited** for every step, so a
slow reporter paces the run. Every event names its agent. `tool_result.callId` is
optional for compatibility and is always populated by the harness: it is the id of
the `tool_call` the result answers, which lets a client pair two same-name calls
exactly instead of positionally — the only safe pairing once calls run
concurrently. A tool-call id must be non-empty and **unique for the whole
conversation**; a duplicate/reused id is rejected before the call is launched and
never reaches persistence. `ui` is the optional declarative panel list from
`toolUi()` (see “Declarative tool panels” below); the model never sees it.

The three concurrency fields are additive, and a client must fall back to its
pre-concurrency rendering when they are absent (old persisted turns):

- `durationMs` is the server-measured span of the call that just ended, not the gap
  between frame arrivals (concurrent calls wait behind each other). Every
  **executed** call reports one — inline/direct calls included; a call rejected by
  argument validation never executed and may omit it.
- `pending` is the set of calls still running. On `done` it means the agent's
  response is complete while its own calls are not: an interim response, not the
  end of the turn. The UI keeps those cards alive and prints their spans; a client
  must not close them on such a `done`. The field is omitted when nothing remains,
  so absence is not a drain signal; a UI prunes a settled `callId` itself.
- `wakeup` is a RESUME. It resolves no tool and ends nothing; it says background
  work progressed and the agent continued. Its `pending` list is required: a wake
  without one is malformed and produces no update.
- `retry` (R1) says the agent abandoned ONE failed model request and re-sent the
  same one after `delayMs`. Text/reasoning/tool calls streamed since the previous
  boundary (`start`/`retry`/`attempt_commit`/`done`) belong to the FAILED attempt: a
  client discards them (the UI truncates back to its attempt boundary) because the
  agent never commits them. `attempt` is the failed attempt (1-based) and
  `maxAttempts` its budget (11 by default), so "2 of 11" needs no guessing.
- `attempt_commit` (R3) is the SUCCESS end of one model request: the answer is in
  history, so everything streamed since the previous boundary is final and a later
  `retry` (a NEWER request) must not discard it. It exists because `done` is not
  always emitted — a completed tool round gets no `done` at all, and a text response
  superseded by a completion that landed mid-request is committed but never reported.
  It is therefore emitted for every committed response that does NOT get a `done`; a
  response that does get one keeps its exact old sequence. Older recordings simply
  have no such frame, and a client keeps its historical `done`-only boundary
  behaviour for them.
- Committing a request also DETACHES the incremental prose/reasoning writers (the
  committed nodes stay, their buffers do not). Without that, the next request's
  deltas would be appended into the committed block, fusing two requests into one
  node that a retry could then neither keep nor remove cleanly.

`usage` is emitted once per **model request**, including the tool rounds that keep
a run going — `done` only ever reports the final request, so this is the only
per-request feed a client can tally. It is absent when the provider reported no
usage block for that request. The server folds every one of them into
`SessionTurn.usage` (subagent requests included) and repeats the running sum on
each SSE frame; the UI prints the LATEST model request's input/context size with
the turn's cumulative cached input in brackets, e.g. `150 (140)` (the label's
title names both scopes). The wire tally's `input` stays the cumulative sum for
other metrics.

## HarnessMessage

```ts
| { role: 'system'; content }
| { role: 'user';   content }
| { role: 'assistant'; content; toolCalls?; reasoning? }
| { role: 'tool';      content; toolCallId; name; attachments?; outcome?; included?; messageId? }
```

The optional keys above arrived with their own entries and are all MINIMAL-DELTA: absent is
the canonical spelling of the default. `attachments?` is out-of-band tool/upload media
(`src/core/tool-media.ts`), `included?` is the context-inclusion flag and is stored only when
`false` (`src/core/agent.ts` `withIncluded`), and `messageId?` is the stable transcript address
minted at every canonical creation point and never model-facing
(`src/core/message-id.ts`). The `tool` variant additionally carries
`outcome?: HarnessToolOutcome` — **only a NON-`completed` outcome is stored**, so absent means
`completed`, a transcript written before the field exists keeps its exact previous shape, and
nothing re-derives the value from the result prose. The three rules (write / read / derive)
live in `src/core/tool-outcome.ts`; `isError` on the event is always derived from the outcome,
never stored beside it. None of these keys reaches a provider: the transport field-selects the
wire shape per role (`src/transport/openai.ts`).

`HarnessToolCall` is `{ id, name, arguments }` where `arguments` stays a raw JSON
string — malformed JSON is the harness's problem to report, not a parse crash, and
it is retained verbatim so a restored transcript replays what the model actually
sent (the transport repairs it at the wire boundary, see `openAICompatible`). The
`id` is non-empty and unique across the conversation; the runtime rejects a
duplicate/reused id before it launches or persists the call.

## HarnessAssistantMessage

```ts
{
    role: 'assistant';
    content: string;
    reasoning: string;              // '' for non-reasoning models
    toolCalls: HarnessToolCall[];   // [] when the model answered directly
    model: string;                  // captured at request time
    stopReason: 'stop' | 'length' | 'tool_calls';
    usage?: {
        input: number;   // prompt tokens, INCLUDING a replayed cache prefix
        output: number;
        total: number;
        cached?: number; // replayed prefix the provider served from cache, when reported
    };
}
```

`usage.cached` is optional and never defaulted: “not reported” and “reported, 0”
are different facts. The transport reads it from `prompt_tokens_details.cached_tokens`
(OpenAI-compatible, and what the workspace's Lightning adapter emits) or
`prompt_cache_hit_tokens` (DeepSeek-compatible), and clamps it to `input`.

## ToolVisibility / selectTools / searchTools

```ts
type ToolVisibility = 'core' | 'searchable';

// The uncapped selector behind toolRequest. Every matched tool is returned; the
// harness applies maxEnabledTools when it decides what to enable/declare.
type ToolSelectionResult = {
    names: string[];
    tools: { name: string; description: string; tags: string[] }[];
    alreadyAvailable?: { name: string; description: string; tags: string[] }[];
                                        // core tools the caller already has; never selected
};

// The harness's model-facing answer: the bound admits enabled/tools, while
// matched counts the whole union and omitted is the difference.
// { enabled, tools, matched, omitted, unmatchedTags?, availableTags?, alreadyAvailable? }

// Legacy tag-only paged answer still returned by searchTools (not toolRequest).
type ToolSearchResult = {
    enabled: string[];                  // ranked; legacy paged shortlist
    tools: { name: string; description: string; tags: string[] }[];
    remaining: number;                  // matched but excluded by MAX_DISCOVERY_MATCHES
    unmatchedTags?: string[];           // query tags that matched nothing
    availableTags?: string[];           // vocabulary, when nothing matched
    offset?: number;                    // start of a later page (legacy progressive discovery)
    truncated?: boolean;                // remaining > 0 (compatibility mirror)
    alreadyAvailable?: { name: string; description: string; tags: string[] }[];
                                        // core tools the caller already has; reported, never enabled
};

type ToolSearchOptions = {
    declared?: readonly Tool[];         // the caller-visible core set (harness: visibleCoreTools)
};
```

`searchTools()` returns the same shape as a `toolRequest` call, so a UI can rank a
catalogue without a harness.

## Action and branch types (N3)

```ts
type HarnessActionOption = { id: string; label: string; description?: string };

type HarnessActionRequest = {
    requestId: string;                  // runtime-generated
    question: string;
    recommended: string;                // one of options[].id
    options: HarnessActionOption[];     // 2..8, unique ids
    allowCustom: true;                  // constant, not model-controlled
};

type HarnessActionChoice =
    | { kind: 'option'; optionId: string }
    | { kind: 'custom'; text: string };

type HarnessActionAnswer = {
    requestId: string;
    choice: HarnessActionChoice;
    source: 'owner' | 'auto';
    branchId?: string;                  // auto answer only
};

type HarnessActionResult = {
    requestId: string;
    answeredBy: 'owner' | 'auto';
    choice:
        | { kind: 'option'; optionId: string; label: string; description?: string }
        | { kind: 'custom'; text: string };
};

type HarnessActionRequestContext = {
    requestId: string;
    agent: string;
    branchId?: string;                  // the requester's branch
    threadId?: string;
    callId: string;
    request: HarnessActionRequest;
};

type HarnessActionHandler = (
    context: HarnessActionRequestContext,
    signal: AbortSignal
) => Promise<HarnessActionChoice>;

type HarnessForkResult = { branchId: string; threadId: string; content: string };

type HarnessBranchSummary = {
    branchId: string;
    kind: 'fork' | 'autoanswer';
    agent: string;                      // source/owner agent name
    role: 'primary' | 'subagent';
    sourceBranchId?: string;
    sourceThreadId?: string;
    callId?: string;
    requestId?: string;                 // autoanswer only
    forkDepth: number;                  // ordinary forks; autoanswer inherits
    model: string;
    tools: string[];                    // declared wire names ([] for autoanswer)
};

type HarnessBranchStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type HarnessBranchRecord = HarnessBranchSummary & {
    status: HarnessBranchStatus;
    toolCallIds: Array<{ origin: string; branch: string }>;
    messages: HarnessMessage[];
    result?: { content: string; stopReason: HarnessStopReason };
    error?: HarnessErrorInfo;
};

type HarnessForkConfiguration = {
    enabled?: boolean;                  // default true
    maxDepth?: number;                  // default 2
    maxConcurrent?: number;             // default 4
    maxHistoryBytes?: number;           // default 8 MiB
    maxBranchRecords?: number;          // default 64
};

type HarnessInteractionConfiguration = {
    actionRequest?: HarnessActionHandler;
    autoAnswer?: boolean;               // default true
};
```

`src/types/index.ts` is canonical; the runtime parsers are `core/action.ts`, and
`core/branch.ts` owns the summary/record/bounds. Branch records are runtime state,
not snapshot v1.

## Declarative tool panels (R20.2)

A tool result is text for the model. To let a client render a small, safe summary,
a tool wraps its ordinary value:

```ts
toolUi(content, panels)               // branded ToolUiEnvelope<TContent>
toolUiOf(value)                       // extraction + re-normalization, or undefined

type ToolUiBlock =
    | { type: 'text'; text: string }
    | { type: 'table'; columns: string[]; rows: string[][] }
    | { type: 'keyValue'; items: { label: string; value: string }[] };

type ToolUiPanel = { id: string; slot: string; title: string; blocks: ToolUiBlock[] };
```

`src/types/index.ts` is the canonical type home; `src/core/tool-ui.ts` owns the
normalizer and the exported `TOOL_UI_LIMITS`.

- **Model content is unchanged.** `executeToolCall` calls `toolUiOf(result)` and
  serializes only `ui.content`; the envelope/panels never enter the transcript or
  a transport request.
- **The event carries it.** `tool_result.ui` is present only for a recognized
  envelope. `src/server/sessions.ts` copies events as before, so SSE and the recorded
  turn keep the panels and `eventTimes` stays a parallel array with the same
  length/order.
- **Manual calls unwrap.** `src/server/api.ts` projects `ToolCallResult.result` to the
  content and adds optional `panels` (session-bound and direct paths alike).
- **Safety bounds.** `slot` is an open string (`right` is the default mount, with
  `center`/`left` available to the UI); panels are data only (no HTML/JS/actions).
  Normalization caps 32 panels, 64 blocks/panel, 100 table rows, 20 columns, 100
  key/value items, bounded text/cell/label lengths, and a 256 KiB total; malformed
  panels/blocks are dropped, non-string cells blanked/padded, and oversized
  panels dropped whole.
- **Demonstration.** `src/harnesses/tools.ts` `timeNow` returns a right-slot key/value
  panel while keeping its `{ timezone, iso, unix }` content. The server API result
  is unchanged; the chat transcript shows the panel. A direct callable consumer
  receives the branded envelope and should use `toolUiOf()`.

---

## Decisions worth remembering

- **No runtime dependencies.** The package publishes standalone; the default
  transport is ~150 lines of SSE over global `fetch`, and `parameters` is plain
  JSON Schema so TypeBox needs no dependency.
- **The registry key is the identity.** Both agents and tools take an optional
  `name` that the harness overwrites, so `writer: agent({...})` never repeats
  `name: 'writer'`.
- **`turn()` vs `stream()`.** `turn()` is the loop primitive (no user append, no
  rollback, throws); `stream()` is the standalone one-turn convenience (atomic,
  yields errors). Keeping both is what lets the harness and a hand-written caller
  share one implementation.
- **Tool failures are data, not exceptions.** Only transport failure and a
  runaway loop are terminal; everything a tool did wrong is reported back to the
  model so it can recover.
- **`ErrorOptions` is not used.** The package's `lib` does not include
  `es2022.error`, so `HarnessError` assigns `cause` directly.
- **`harness.name` must be defined, not assigned.** `name` is a read-only
  property of every function, so the callable is built with `Object.assign` and
  then `Object.defineProperty(handle, 'name', ...)`. `tool()` hits the same
  constraint and defines `name` with `writable: true` so a harness can rename it.
- **A tool is a function, not a record.** Making `tool()` return a callable is
  what lets the same definition be an executable object and a model-facing
  declaration. The cost is that `name` needs `defineProperty` and that the
  callable's signature has to be pinned with generics (`tool<Params, Result>`)
  because a JSON Schema literal cannot be turned into a TS type without a
  TypeBox-style dependency.
- **Visibility is a harness concern, not a tool concern.** A tool knows only its
  own tags and whether it is core; the harness owns the active set and the
  declarations. That split is what lets discovery change between turns while the
  registry stays immutable after construction.
- **Tags are required, scored, and page-capped (legacy `searchTools` only).** A
  tool without tags could never be found, so construction rejects it. Ranking is
  OR-style best-match (a tool's rank is its strongest single-tag hit; hit count
  only breaks ties), deterministic (score, hits, name), and each legacy
  `searchTools` page is capped at five matches — default AND maximum — because
  paged tag discovery exists to save context; the excluded tail is reported only as
  `remaining`. A caller may ask for fewer, never more. The live `toolRequest` tool
  does NOT use that cap: `selectTools` returns every match and the harness's
  `maxEnabledTools` (default 32, core tools excluded) bounds the enabled set, with
  the newest request displacing older enabled tools when the bound is full.
- **Presets are lazy proxies, not implementations.** `src/tools/index.ts` exports
  callable `Tool`s whose metadata is static and whose body is a dynamic import.
  Building a harness, listing the catalogue, or ranking a preset therefore never
  loads `node:fs`/`child_process`/`vm`. The trade-off is build coupling: the dist
  must ship the per-tool chunks and must not inline dynamic imports.
- **Created tools are compiled, not run, at registration.** `createDynamicTool`
  validates the shape and compiles the body with the host realm's `Function`
  constructor; execution happens only on call. The harness adds reserved names, a
  case-insensitive collision check, and a 32-tool budget. It is session-local (a
  server with a database root persists the creation SOURCES in the core snapshot and
  recompiles them on restore; nothing is written into the tool catalogue) and
  **unsandboxed**.
- **Delegation is one level deep by construction.** `delegate` is core for the
  primary only, is never declared to subagents, is rejected if a subagent guesses
  it, and `runAgent` refuses to re-enter a running agent. Each agent keeps its own
  instructions and transcript; only the answer crosses back.
- **A branch is a conversation copy, not a sandbox.** `threadFork`/`Agent.fork()`
  clone the entire committed history at request instant, remap tool ids, and share
  the transport; external side effects remain shared. Only the final summary
  returns. Branch records/events are ephemeral audit state (not snapshot v1), and a
  fork that exceeds the history cap fails explicitly instead of truncating.
- **A question never selects its recommendation.** `actionRequest` has no model
  switch for free text (`allowCustom` is always true) and no automatic fallback to
  `recommended`; a root needs a real host answerer, and a child/fork request is
  answered by a tool-free owner clone. A failed or expired answer stays a readable
  tool result and is never fabricated.
- **Undiscovered tools do not run.** Executing a tool the model was never
  declared would make toolRequest optional in practice. Instead the call comes back
  as a tool result naming the tags that would enable it, which is recoverable and
  still teaches the model the vocabulary.
- **Preload the catalogue, declare only the core.** Shipping the presets into
  every harness by default stays cheap: only the five core file tools are declared
  up front, alongside toolRequest/toolCreate/task/profileManage/
  chapterManage/locationManage/agentManage/agentResult (and delegate when
  applicable), while the searchable remainder costs no context until discovered.
  `presets: false` exists for callers who want an empty catalogue, which is also
  what the harness tests use when they assert exact discovery results.
- **Session state is factory state, not module state.** Tasks, profiles, chapters,
  and locations each get one closure per harness with its own id counter, so two
  sessions never share records and `reset()` is a complete "start over" that no
  module singleton could express.
- **A model is a per-request choice, so it is editable live.** The harness always
  reads an agent's model when it starts a request (`requestModel` in
  `src/core/agent.ts`), which is what lets `PATCH /sessions/:id` retarget an agent
  without rebuilding anything: the in-flight request and the message it commits
  keep the model they started with, and the next request uses the new one.

## CLI, server, and UI

The app is split so the harness has **no UI dependency**. The library
(`src/harness.ts`) stays the published harness entry; the application layers
(`src/server`, `src/frontend`, `src/shared`) are consumers of it and are published
as their own entries.

- **CLI (`src/server/cli/`)** runs a preset in-process: one-shot from argv/stdin, or an
  interactive session on a TTY. It renders `HarnessEvent`s directly with
  `src/server/cli/render.ts`, or emits one JSON object per line with `--json`. With
  concurrent tools the terminal also shows the server's `durationMs`
  (`← read · 1.3s`), a `pending · name 1.2s` line for calls still running, and a
  `~ agent woke · …` wake line, so background work is never invisible in a CLI.
  `--serve` switches to the HTTP server. The CLI never imports the UI.
  An interactive line goes through `src/server/cli/commands.ts` first: its own
  `/exit`, `/quit`, `/help`, `/reset`, `/tools` and `/presets` are answered locally
  (they SHADOW the same-named harness commands), every other `/name` is forwarded
  verbatim to `harness.executeCommand`, and only ordinary text starts a model run
  (see [Slash commands](#slash-commands)).
- **Environment (`src/server/environment.ts`)** loads the package-root `.env` from
  `src/server/cli/index.ts` (before `settingsFrom`) and from the top of
  `startHarnessServer()` (used by `src/server/dev.ts` and the service runtime), via `dotenv` as a
  devDependency. The path is module-relative (`../../.env`), `override: false`
  keeps shell values (including empty ones) authoritative, a missing file is a
  no-op, and `quiet: true` prevents startup logging. It must run before harness
  construction because search keys are captured there. The library graph never
  imports it.
- **Server (`src/server/`)** owns HTTP and sessions, not harness policy. Routing and
  validation live in transport-neutral `api.ts`; `handler.ts` is only the Node
  adapter for `/api` (client header, streamed body bound, SSE writer) and
  `service.ts` the `@underload/service` adapter for `/v1/harness` (Origin gate,
  content-length/serialized body bound, raw SSE `Response`). `start.ts` holds
  `startHarnessServer` — the only listener, created when called. `SessionStore`
  keeps one `Harness` per session and owns each run's `SessionTurn`s plus the FIFO
  task queue, so a second task continues the conversation in order, a reload can
  replay the transcript from `list()`/`get()`, and a watcher can reattach through
  `watch()`. `dispatch()` is the submit surface `POST /sessions/:id/tasks` calls and
  the only place a slash line is split from a prompt: non-command text is queued, a
  `/command` becomes a terminal command turn executed in this process (no model, no
  lane). The store also owns the editable per-thread transcript
  (`threadTranscript`/`updateThreadTranscript`) and the tolerant restart that keeps one
  unreadable conversation from dropping a session. `static.ts` serves
  `src/frontend/dist`; `dev.ts` is the separate standalone API launcher
  (`yarn dev:server`, static serving disabled), while
  `yarn dev:frontend` is Vite only and proxies `/v1/harness` to the service on :5000.
  It binds the IPv6 wildcard `::` (`DEV_SERVER_HOST` in
  `src/frontend/vite-proxy.ts`), which Node opens dual-stack, so the one listener
  serves `localhost` (`::1`), `127.0.0.1` and the LAN IPv4 address; an IPv4-only
  bind made Vite's printed `Local` URL false because `localhost` resolves to `::1`
  first. Preview stays pinned to `localhost` (loopback, IPv6-only on Windows).
  Set `HARNESS_DEV_API=http://127.0.0.1:5181/api` to point that same proxy at the
  standalone launcher instead. There is no CORS in the standalone Node mode: the
  UI is same-origin in production and proxied (or service-hosted) in development.
- **Service host (`src/server/endpoint/` + `src/server/service.ts`)** is the same API on the
  repository's Hono gateway. `@underload/service` scans the repo root for
  `endpoint`/`endpoints` folders and imports every `service-route*.ts` default
  export; `src/server/endpoint/harness/service-route.ts` registers `/v1/harness/*` and
  `service-route-root.ts` registers the bare `/v1/harness` (a wildcard does not
  match the bare path). Neither declares a `port`, so both run on the gateway's
  single listener — no worker server, no 307, no second port. `src/server/runtime.ts`
  builds one shared store/catalogue lazily on the first request (`.env` loaded
  there, never at import). The bootstrap document's `rootPath` is the canonical
  API URL (`/v1/harness`), not a filesystem root: file tools resolve against
  `process.cwd()` and have no sandbox, so advertising a workspace root would be a
  lie. `variables.root` is the service's database boundary, not a workspace. The
  handler selects a runtime keyed by that resolved root, and the runtime writes
  `<root>/harness/state.json` (see persistence.ts); restoring rebuilds the registry
  first, then each session's frozen harness, then its core snapshot. Restore is
  best-effort PER SESSION: a record this build cannot rebuild (a snapshot naming a
  renamed tool, a model map naming a retired agent, an inconsistent record) is
  dropped, reported through `onRestoreError`/`SessionStore.restoreErrors` (stderr
  by default) and answered as `404 Unknown session` afterwards, so one stale
  session can never make the whole server unavailable. It is finer-grained still for
  transcripts, because those are user-editable: every host thread's stored `messages`
  is validated with `readHarnessMessages` BEFORE `harness.restore()`, and an unreadable
  one is neutralised with a valid `[transcript unreadable: …]` system placeholder while
  the raw value is retained in the additive `invalidThreads` roster — so one
  hand-broken conversation never costs the session (see “Persistent threads in the UI”
  below). Document-level corruption (unreadable file, bad JSON,
  unknown version, invalid record shape, a malformed `invalidThreads` map) stays fatal
  and leaves the file untouched. A running turn
  is marked interrupted and never replayed; pending background calls are
  interrupted, not resumed (a restored UI shows them abandoned, not running);
  branch records are not restored, and every recorded `action_request` is expired
  (the awaiting runtime is gone), so no question or branch is resumed;
  queued prompts are preserved but stay
  paused until an explicit submit or a cancel-all. When the snapshot ended between
  an assistant tool call and its result, restore appends explicit interrupted tool
  results for the unmatched ids (no re-execution), so the next provider request is
  coherent.
  The loader's permissive CORS means `X-Harness-Client` is not a boundary there;
  instead the adapter rejects a browser `Origin` that is neither the request host
  nor loopback (`localhost`, `127.0.0.1`, `[::1]`), and allows requests with no
  `Origin`. That is not authentication: the service binds `0.0.0.0`, so anyone
  who can reach the port is trusted, and the tools are unsandboxed. Prefer a
  loopback host for the service when the port is reachable from untrusted
  networks; this package changes no global host/CORS setting.
- **Catalogue (`src/server/harnesses/`)** holds the presets and harness-level tools shared by
  the CLI and server. Presets are factories because a harness bakes its transport
  at construction. `toolbox.ts` owns the one shared toolbox and the factory every
  live preset uses, so `instruct`, `research`, `workspace`, `reviewer` and `planner`
  register the same tools and differ only in agents/instructions/routing. `demo`
  uses the scripted
  transport, needs no endpoint, and keeps a timeNow-only registry as a documented
  template exception; `flaky` is the shared toolbox plus the intentional failure
  tool (excluded from the shared set because it fails on purpose). Every template is
  editable (R20.1): the registry copies it, metadata-only patches preserve the
  captured factory, and an executable patch upgrades demo to a live profiled
  harness / rebuilds flaky with `testFlaky` retained. Every preset
  names its `primary` explicitly; the five real presets declare the same symmetric
  team (every other real role plus `summarizer`, via `teamOf()`), so each registers
  `delegate`, while the two fixtures have no subagents and no delegate. Every
  agent keeps its own instruction. `src/server/harnesses/index.ts` exports
  `createToolCatalogue`, which snapshots the lazy `presetTools` metadata plus the
  harness tools plus the runtime `search` entry; it never executes or imports an
  implementation. `findPreset` resolves the legacy ids (`writer`/`assistant` →
  `instruct`, `researcher` → `research`) without listing duplicate cards. The
  server calls the catalogue builder after `loadEnvironmentFile()` and injects the
  result into the handler; the CLI calls it from `--tools`/`/tools`, which run
  after the same load.
- **UI (`src/frontend/`)** is only a client. It resolves its API root at runtime
  (`?apiRoot=` → the **“Harness server URL”** saved in this browser →
  `window.__HARNESS_CONFIG__.apiRoot` / meta tag → build-time
  `VITE_HARNESS_API` → the compiled Pages chain → `/v1/harness` on the page's own
  origin), then lists presets/tools, creates sessions,
  enqueues tasks (`POST /tasks`, `202`), and observes the session's queue through
  one `GET /events` watcher while work is pending (polling fallback). A `/…` composer
  line is submitted like any other task and answered as a server-side command turn —
  the client has NO command table of its own, because commands are server state and
  the UI is a renderer. The transcript dialog reads
  `GET /sessions/:id/threads/:threadId/transcript` and saves the parsed editor text
  through `PUT` (`src/frontend/api.ts` `getThreadTranscript` /
  `updateThreadTranscript`). Runtime
  absolute roots must be the
  page's own origin or loopback (`src/shared/origin.ts`, shared with the service
  Origin gate) because the saved provider key is posted to that root;
  `VITE_HARNESS_API` is operator-controlled and deliberately trusted across
  origins. The **saved “Harness server URL”** (step 2 of the ladder) is the other
  source the client trusts, and the only
  one a reader controls: the status pill opens **Endpoint & model**, the field at the
  top of that dialog edits it, `Apply & reconnect` validates it (a rooted path, or an
  absolute `http(s)` URL with no query, fragment, credentials or backslashes), stores
  the NORMALIZED value under its own `underload-harness-app:api-root` key
  (`src/frontend/api.ts` `API_ROOT_STORAGE_KEY`, `saveApiRootSetting`), strips any
  `apiRoot` parameter from the address bar (that parameter outranks the saved value for
  the load it is on, so leaving it would undo the save) and reloads — the root is
  resolved once at module load, so a reload IS the reconnect. `Reset`, or applying a
  blank field, deletes the key and restores automatic resolution; a refused value is
  reported inline and stores nothing. A saved cross-origin host is accepted on the
  reader's own authority, so what decides whether it answers is the service Origin
  gate, CORS and the browser's mixed-content rule (an https page cannot dial a
  plain-http harness). The value never enters a request body: the dialog's base URL /
  API key / model triple is the PROVIDER, and where the UI dials is a separate
  decision. A saved root also pins a Pages host — the compiled chain is a fallback,
  never an override. It imports no harness code and no `node:` built-ins, which is why
  `node-stub.ts` and the source alias were deleted. To drive the service host
  from the built UI:
  `http://localhost:5180/?apiRoot=http://localhost:5000/v1/harness` — the Vite
  dev/preview origin is loopback, so the Origin gate allows it.
  On a phone (`max-width: 860px`) both rails are **collapsed by default** and the
  topbar grows one toggle per rail (`main.ts` `setRailOpen`): the two are
  mutually exclusive, a backdrop click or `Escape` dismisses the open one, and
  leaving the breakpoint clears the state so a resize cannot resurrect a dismissed
  rail. The rails stay in the DOM — CSS only hides them — so their content and
  state survive a toggle, and wider layouts ignore the state and show both rails
  permanently. `src/frontend/rail-toggle.test.ts` pins the DOM of this contract.
  Above the phone breakpoint each rail is **resizable**. A `role="separator"` seam sits in
  its own 6px grid track between the rail and the chat (`src/frontend/ui/rail-resize.ts`),
  and a drag writes `--rail-left-width` / `--rail-right-width` on `.shell` — the two
  custom properties `.shell { grid-template-columns }` reads — never a `width` on the
  rail, because a grid item is sized by its track. No width is stored anywhere: a reload,
  like a double-click on a seam, returns the stylesheet's 248px / 320px, and the chat
  keeps a 320px floor so a rail can never be pulled over the transcript. Both seams are
  hidden on a phone (the rails are fixed-width drawers there) and only the right one on a
  tablet (the scratch board is a full-width strip). A drag re-runs the reflow a window
  resize does (`main.ts` `reflowLayout`), so the composer's grown height, the scratch
  button's anchor and the notched routing label re-measure against the new chat width.
  `src/frontend/ui/rail-resize.test.ts` pins the drag, keyboard, clamp and reset.

### API

`/api` is the standalone mount; the `@underload/service` host serves the same
paths below `/v1/harness` **plus** the bare root:

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness and session count |
| `GET /api/harnesses` | Harness descriptors (`primary`/`subagents`/`coreTools`/`agentModels?`/`agentInstructions?`/`builtin`/`editable`), provider defaults, and `agents`; every entry is editable and `editable` is always `true` |
| `POST /api/harnesses` | `{ name, title?, description?, primary, subagents?, agentModels?, agentInstructions? }` → `201 { harness }` |
| `PATCH /api/harnesses/:name` | `{ title?, description?, primary?, subagents?, agentModels?, agentInstructions? }` → `{ harness }`; every template is patchable |
| `GET /api/harnesses/:name` | `200 { harness }` — one definition with the index's own projection, `agentInstructions` included when the card overrides any; the compiled `/views` document omits that map, so the configuration dialog reads the single card it opens. A legacy alias resolves to its target; unknown is `404` |
| `DELETE /api/harnesses/:name` | `200 { deleted: true }`; `404` unknown name or repeat delete (aliases are not deletable identities). Removes a user harness or a shipped built-in; a built-in's name is persisted in the database's additive `deleted` list so a restart keeps it removed. Existing and saved sessions keep the definition they captured, so deleting a harness never loses a conversation |
| `GET /api/agents` | Trusted agent registry (`AgentDescriptor[]`) |
| `GET /api/tools` | Full catalogue: session-bound core entries first (`group: 'Core tools'`, `sessionBound: true`), then every direct-call tool (including the core file tools); `search` always present with `availability` |
| `GET /api/tools/bootstrap` | Alias of `GET /api/tools` — the list the root bootstrap document carries |
| `POST /api/tools/:name` | `{ parameters, sessionId? }` → `{ ok, result | error, durationMs }`. A `sessionBound` core tool requires `sessionId` (`400` without, `404` unknown session or unavailable tool, `409` while the session is busy - a run, reset, or another manual call) and executes inside that session's harness; `actionRequest`/`threadFork` answer a readable "requires the owning run" refusal; a direct-call tool is unchanged and ignores `sessionId` |
| `POST /api/tools/:name/call` | Alias of the row above (verb-named spelling), same dispatcher |
| `POST /api/models` | `{ settings? }` → `{ models: string[] }`; server-side `listModels` |
| `POST /api/sessions` | `{ harness, settings? }` → `{ session }` |
| `GET /api/sessions`, `GET /api/sessions/:id` | Snapshots, always including `turns` (with `eventTimes`) and the frozen `harnessDefinition`; `model`/`agentModels` are LIVE; `queueDepth` counts pending turns and is omitted at zero; the additive `invalidThreads` roster appears only when a conversation's stored transcript could not be read |
| `PATCH /api/sessions/:id` | `{ agentModels: Record<agent, model> }` → `{ session }`. Merges into the live map, validates every key against the session's agents and every value as a model id (400 with nothing applied), rejects `{}` as a no-op, is allowed while the session is busy (no abort/rebuild), and leaves `harnessDefinition` frozen. The current request keeps the model it started with; the next request uses the new one |
| `POST /api/sessions/:id/messages` | `{ input }` → SSE. LEGACY: the response owns the run (close aborts it); `409` when busy or when queued work is pending. A leading-`/` line is NOT a command here — it still goes to the model, because this route's envelope predates the command registry |
| `POST /api/sessions/:id/tasks` | `{ input, attachments?, references?, threadId? }` → `202 { session, turn }`. Server-queued FIFO task: the turn is `queued`, has a stable id/index, and has no `startedAt` until the pump starts it. Cap 100 pending (`429`); queued turns are durable with a database root and paused after a restart. An `input` starting with `/` is a **slash command**: `dispatch()` runs it in this process through `harness.executeCommand`, never calls the model, never enters a lane, and returns the ALREADY-TERMINAL turn (`status: 'done' \| 'error'`, events `start`/`tool_call`/`tool_result`, no `usage`); `attachments`/`references` are `400` and `threadId` is accepted and ignored |
| `GET /api/sessions/:id/threads/:threadId/transcript` | `{ transcript }` = `{ threadId, agent, messages, raw, invalid? }` — `messages` is the live transcript, `raw` the pretty JSON the editor edits, `invalid` present only for an unreadable transcript (reason + raw value). `404` unknown session/thread |
| `PUT /api/sessions/:id/threads/:threadId/transcript` | `{ messages }` → `{ session, transcript }`. Wholesale transcript replace. A structurally invalid value is a **200**: it is persisted, the live transcript becomes the `[transcript unreadable: …]` placeholder, and `transcript.invalid` explains why. `400` absent `messages`/non-object body, `404` unknown thread, `405` other methods, `409` running thread or a harness handle without `setThreadMessages` |
| `GET /api/sessions/:id/events` | SSE watcher: one `snapshot`, `turn` upserts (queued/running/terminal), `event` frames, one final `snapshot` on drain. Disconnect only unsubscribes |
| `POST /api/sessions/:id/reset` | Reset every agent + discovery + tasks + record stores; `409` while a run or queued work is pending |
| `POST /api/sessions/:id/cancel` | `{ all?: boolean }` → `{ cancelled }`. Default aborts the active run only; `all: true` also cancels every queued turn, which stays in `turns` as `cancelled` |
| `POST /api/sessions/:id/actions/:requestId/answer` | `{ choice: HarnessActionChoice }` → `{ ok: true }`. Settles one pending `actionRequest`; 400 invalid body/unknown option/out-of-bounds text, 404 unknown session or request id, 409 answered or expired. Allowed while busy |
| `DELETE /api/sessions/:id` | Forget the session: abort active work, drop queued work, close watchers |
| `GET /v1/harness` | Service only: bootstrap `{ rootPath, presets, agents, tools, defaults, sessions }` |

`/api/presets` and `/v1/harness/presets` are aliases of `/harnesses` and accept only
`GET`; create/patch live on the canonical `/harnesses` mount. The `/api` root stays
a 404 (no bootstrap document) — that legacy contract is unchanged. `rootPath` in
the canonical document is the API URL (`/v1/harness`), not a filesystem path.

**Body policy (both mounts).** Action endpoints require a JSON object; `null`,
arrays, and primitives are `400`. `POST /tools/:name` requires a `parameters`
property, so an empty body cannot run a tool — `{ "parameters": {} }` is the
explicit argument-less call (it is unwrapped to "no arguments", the documented
default, rather than being rejected). An unknown name is `404` whatever the body
looks like. Bounds: the Node adapter stops a streamed body over
1,000,000 bytes with `413`; the service adapter checks declared `content-length`
and the serialized parsed body before dispatch. The service loader parses JSON
before the endpoint runs, so it cannot prevent that upstream allocation and a
parse failure arrives as `{}` — a documented residual, not something this package
can fix.

**R13: the manual route validates and bounds like the model path.**

- The direct (session-less) runner resolves `parameters` through
  `resolveToolParameters(schema, raw, 'direct')` before `execute` sees them. Both
  documented shapes therefore work — the legacy unwrapped value (a bare array for a
  single-property schema, or `files([{ op: 'list', path: 'src' }])`) and the schema
wrapper (`{ "ops": [{ op: 'list', path: 'src' }] }`) - and a wrong type is a `{ ok: false }` tool error with a
  JSON path instead of an implementation crash. `null` is normalized to `{}`.
- Result and error TEXT share the model-facing per-result cap (`boundToolResult` in
  `src/core/result-budget.ts`, 256 KiB, applied AFTER the `toolUi()` unwrap so panels stay on
  their own limit). A result that fits is returned byte-for-byte unchanged; a result
  that does not is returned as the parsed truncation envelope
  `{ truncated, originalBytes, budgetBytes, note, content, tail }` — `content` is the HEAD
  preview, `tail` the end of the original text, and `note` says how many bytes were cut,
  which cap bit, and which call to re-run to get them back — so the HTTP body stays valid
  JSON with an explicit marker rather than a half-written document (the manual route has no
  transcript call to name, so its note says only "the tool call"). This is a
  post-serialization cap: it bounds the wire/context cost, **not** the process's peak
  memory (the tool's own budget has to do that). The MODEL path also bounds the SUM of one
  turn's results — `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES` (512 KiB) through the run's
  `createToolResultTurnBudget`, which spills the results that no longer fit through the same
  envelope and NEVER drops one, because a request must answer every `tool_calls[]` entry.
  A manual call has no turn, so the per-result cap is all it applies.
- A tool that exists only in ONE session's registry (created by `toolCreate`, or
  added by a plugin to that session's harness) is not in the static catalogue. With a
  `sessionId`, an unknown name is resolved against THAT session's registry; without
  one it stays `Unknown tool "<name>"`. A sibling session answers
  `Tool "<name>" is not available in this session.` — one session's tools are never
  listed or callable through another session's id. Listing surface: a created tool is
  registered and enabled at once, so `GET /sessions/:id` reports its name in
  `discoveredTools`; `GET /tools` remains the static catalogue.

**Core tools in the catalogue (R8/N4).** `src/harnesses/core.ts` adds eight entries -
`toolRequest`, `toolCreate`, `task`, `profileManage`, `chapterManage`,
`locationManage`, `agentManage`, `agentResult` - plus `delegate`, `actionRequest`, and `threadFork` to every
listing (`GET /tools`, its `/tools/bootstrap` alias, and the root bootstrap
document). The last two are conditional in a session's harness (`interaction`
configured / `forks.enabled`), but the host-wide catalogue always lists them with
generic metadata; a session without the capability answers a clear 404 rather than
inventing it. All are `group: 'Core tools'`, `visibility: 'core'`, and
`sessionBound: true`, and they deliberately have **no** `tool` implementation:
there is one implementation of each (the session's harness). `SessionStore.callTool(id, name, parameters)` →
`harness.executeTool` is therefore the only path: a missing/blank `sessionId` is
`400`, an unknown session or a tool the session's harness does not register
(delegate without subagents) is `404`, a session with ANY operation in flight
(a streaming run, a reset, another manual call - the store's private `busy`
single-flight flag) or with queued work pending is `409`, a throwing tool is
`{ ok: false, error }`, and
success is `{ ok: true, result, durationMs }`. `PATCH /sessions/:id` is the one
exception to that gate: a model change is not a harness mutation, so it is applied
while a run streams and aborts nothing (see the route table above). Directly
callable entries keep their old session-less runner; they
accept and ignore `sessionId` so one request shape serves the whole Tools tab. The
metadata comes from `src/core/metadata.ts`, the copy the harness registers, so a
descriptor cannot advertise a schema the runtime does not use.

**R18: core file/search/download tools are NOT session-bound.** `read`, `write`,
`edit`, `glob`, `grep`, `download`, and a configured `search` have
`visibility: 'core'` but
keep their real `tool` implementation and appear in the direct-call catalogue
(groups `Package presets` / `Web search`), so `POST /api/tools/read` works
without a `sessionId`; `POST /api/tools/download` returns the summary plus
`media` **descriptors**, never the base64. `sessionBound: true` remains exclusive to the eight
harness-owned entries above plus `delegate`, `actionRequest`, and `threadFork`
(the last two are still refused by the manual call path because they need the
owning run). The UI's core dropdown reads
`coreTools` from the descriptor, which is computed from the registered names and
therefore includes the file tools, adds `search` only when this host resolved a
key, omits `files` (and the other searchable tools), and matches the harness's
actual core declarations.

Every standalone request requires `X-Harness-Client: ui`. A browser on another
origin cannot set that header without a CORS preflight, and the server answers
none, so a malicious page cannot read transcripts or POST a command to localhost.
The UI sends it; `curl` must add it. The service mount does **not** use that
header (its loader allows any header); it uses the Origin gate described above.

Every SSE `data:` frame is `{ type: 'turn', turn }`, `{ type: 'event', turnId, event,
at, usage? }`, `{ type: 'snapshot', session }`, or `{ type: 'failed', error, session }`.
The two streams mean different things:

- `POST /messages` (legacy) opens with `turn`, then events, and ends with `snapshot`
  on success or `failed` on error/cancel. The response owns the run: its close
  aborts the harness, so a disconnected client does not keep spending provider time.
- `GET /sessions/:id/events` (watch) is NOT an owner. It opens with one `snapshot`,
  sends each `turn` as an UPSERT on the same id (queued → running → terminal), then
  event frames, and sends one `snapshot` when the queue drains; a reset also sends
  a snapshot (it deletes rows, so no upsert can express it). A disconnect
  only unsubscribes; the pump keeps executing for nobody.

`at` is the server's epoch-ms stamp for that
record and is identical to the matching entry in `turn.eventTimes`, so a live view
and a reload agree on elapsed time. `usage` is the turn's running token tally as the
SERVER summed it (`{ input, output, total, cached? }`): it is repeated on every frame
once it exists, so a client prints the server's figure instead of accumulating one
of its own, and a poll/reload (`SessionTurn.usage`) shows exactly the same number.
`tool_result` events also carry the `callId` of the `tool_call` they answer, which
pairs same-name calls exactly.

### Task queue and presentation (R4/R5)

`SessionStore` (`src/server/sessions.ts`) owns the queue; no response does.

- **Submit/accept.** `enqueue()` validates and applies the pending cap before any
  mutation, then appends a `SessionTurn` with `status: 'queued'`, a `randomUUID` id,
  the next `index`, and NO `startedAt`; it returns the accepted snapshot + turn and
  the HTTP layer answers `202`. A rejected submit (`400` empty/too long, `413`,
  `429` over 100 pending) leaves the session untouched.
- **Pump.** A private loop peeks the FIFO head (never shifts until it starts it),
  waits for the shared single-flight gate when a legacy run/manual call holds it,
  retries the same head afterwards, and keeps draining after a per-task error.
  `pumping`/`busy` are set synchronously, so a second enqueue joins the worker
  instead of starting one. A `watch()` subscriber can never cancel or block it:
  `publish()` neither awaits nor throws and drops a failing watcher.
  Thread-capable submits do NOT use this one backlog: every thread has its own
  `ThreadLane` with its own `pumpLane` FIFO, so two threads run concurrently while
  one lane stays ordered; the loop above survives only for a legacy harness handle
  that predates the thread API (and the shared `busy` gate still parks every lane).
- **Status.** `SessionStatus` remains `idle | running | error`; queue state is
  `SessionTurn.status` (`queued | running | done | error | cancelled`) plus
  `SessionSnapshot.queueDepth` (pending turns, active excluded, omitted at zero).
  A cancelled turn keeps its row/events (`updatedAt` moves, no `startedAt` for a
  never-started one), so a reload shows what was stopped.
- **Gates.** `reset`, `callTool`, and the legacy `/messages` reject while `busy` or
  while the queue is non-empty (`409`); Delete/`dispose()` aborts the active run,
  discards pending work, settles its `enqueue()` completions, and closes watchers
  without waiting. The abort preempts the provider request, releases the child
  actor/restore slot and rolls back the cancelled turn's in-flight prompt state
  immediately (a late provider commit is rejected by the core precommit check), so
  the logical cancel never waits on a socket that never returns. Shutdown saves at
  most once: a save-once guard stops a late write from replacing the database with
  an empty state, legacy event writes are serialized, and a failed graceful save is
  reported through `persistenceError`/the log while shutdown still closes.
  `PATCH /sessions/:id` stays the exception: it is accepted while
  busy, aborts nothing, and applies to the next request of that agent — including a
  queued task's request, which reads the model when it starts.
- **Recovery.** The UI keeps one `GET /events` observer for the selected session
  while it has pending work; losing it falls back to `GET /sessions/:id` polling
  (1 s, ~120 attempts) and a reconnect after 1 s. Reload re-reads the snapshot,
  calls `view.reconcile()` (merge by id, never rebuild), and reopens the observer
  when work is still pending. Settled history never re-lights an agent ring; only a
  `running` turn does.
- **Controls.** Run stays enabled while work is pending — only the short POST
  `/tasks` round trip locks it — so the queue grows by submitting again. Stop is
  enabled whenever work is pending and sends `{ all: true }` (active + queued);
  Reset/New session/tab switches stay locked while pending. Harness/session
  switching is allowed and only unsubscribes, because work is server-owned.
- **Presentation.** The turn board is one linear timeline: completed = grey, the
  single active task = green (amber while its request is on the wire), queued =
  neutral, error = red, cancelled = muted. Assistant Markdown is GFM via `marked`,
  always sanitized by `DOMPurify`, with fenced code highlighted by `highlight.js`
  core plus a registered language subset (aliases resolve; an unknown fence stays
  escaped text), a CSS language caption, and accent typography/inline code. No
  browser verification was performed for this documentation pass.
- **Chip anatomy (transcript).** A tool call and a reasoning round are the SAME
  surface: a `details.tool` chip that stays INLINE in `.tool-group` and opens its
  detail in a modal (never inline). Reasoning is labelled `think`
  (`ui/tools.ts` `createReasoningCard`), painted amber, and its pill is the share of
  the block's accumulated CONTEXT the round occupies
  (`formatThinkShare`: chars/4 estimate over `BlockMeta.context()` — the same figure
  the header tally prints), not a character count: what is worth seeing is how much
  context the thinking is using. The pill is `[hidden]` until a `usage` figure exists,
  and every chip of a block is repainted when a `usage` event or the server tally
  advances that denominator, so a percentage can never disagree with the header.
  Because a think chip IS a `details.tool`, "how many calls" selects
  `details.tool:not(.think)`. No control in the app shows a disclosure chevron any
  more (`styles.css` base `summary { list-style: none }` + the WebKit marker reset): a
  labelled chip that opens a dialog does not need one, and a future chip inherits it.
- **Block header vs block toolbar.** The expanded block's toolbar owns BOTH per-thread
  actions — `Delete` first (destructive, left), `Transcript` last (`margin-left: auto`,
  right) — plus the full-width two-step Delete confirmation. The card header keeps no
  control slot at all (`.tile-header-action`/`.thread-header-action`/
  `.thread-focus-head-action` are gone from the DOM and the CSS): the header's right
  edge belongs to the measurement line, so an expanded tile lays out as a row-wrap with
  the thread badge left and `elapsed | tokens` flush right on the same line, and the
  meta line wraps below. A nested card was already that shape (`.thread-top`
  `order: 2; margin-left: auto`), which is why the two headers now agree without
  absolute positioning or reserved padding.
- **Background work (R6).** Concurrent tools mean a turn is `running` until the
  harness promise drains, while an agent `done` can be interim. The UI reconciles
  the same way (by turn id, never rebuilding) and, for the additive frames:
  - `tool_result.durationMs` replaces the browser's frame-gap measurement;
  - a present `pending` array replaces `.agent-pending` (`pending · name 1.2s`, a
    static snapshot of the server's spans, never a local tick) and the summed
    `N tools still running` count in the tile meta (visible when expanded; clipped
    sr-only on compact rows). A settled call is pruned from that snapshot by its
    `callId` even when the frame omits `pending` (the runtime omits it when nothing
    remains), so absence is never read as a global drain. The array never resolves
    or abandons a card;
  - a `wakeup` appends `.agent-wakeup` and keeps the agent's ring lit; it is a
    resume, so it does not settle the tile or close a card. A wake frame without a
    usable `pending` list is malformed and produces no update;
  - on a terminal `cancelled`/`error`/`done` turn, any card still running is
    `abandon()`-ed with a reason (`Cancelled before the call returned.`, etc.)
    instead of being left as a live-looking chip — pending work is interrupted, not
    resumed. A result id already settled (resolved or abandoned) is a duplicate and
    is ignored, so a retried/late frame cannot add a second card. The CLI mirrors
    the duration/pending/wake/done **lines** in `src/server/cli/render.ts`; card
    closure is a browser-only state.

### Persistent threads in the UI (T5 / R5-R7)

Two identities exist and must never be conflated:

- `HarnessThread` (`event.thread`, `AgentResultBlock.threadId`) = ONE invocation.
  Its id changes on every run and it is what a `#` reference binds to.
- `SessionTurn.threadId` and `SessionSnapshot.threads[]` = ONE persistent runtime
  conversation. Its id is stable for the thread's life, and repeated turns of it
  are the same conversation (one `RR2` badge in the transcript). R8: the id is opaque;
  the DISPLAY name is `<agent code><per-agent conversation ordinal>` (`RR1`, `RR2`,
  …; `IT1` for Instruct), allocated once per CONVERSATION by the server and re-used
  by every run/steer/continuation. It is carried on `SessionTurn.threadLabel` and
  `SessionThread.label`, never minted per invocation. A host-thread ROOT frame has a
  metadata-only `thread` record (no parent/callId/kind/branch): it belongs to the
  tile's root block and must never render as an indented `T<n>` wrapper.

`src/frontend/ui/threads.ts` owns the decisions; `main.ts` owns the POSTs and the
DOM. The contract it is written against is optional/additive, so a server that does
not send `threads`/`threadId` renders exactly the old UI (`sessionThreadsOf` → `[]`,
`turnThreadIdOf` → `undefined`, submit body unchanged).

- **Focus is explicit board state (S1).** `focusedThreadId` + `explicitUnfocus`, not
  "whichever tile is expanded". `create()` NEVER expands: snapshot adoption, the
  observer `upsert` and a late record for a failed submit are background events and
  may not steal the reader's focus or undo an explicit "New thread". `begin`
  expands the optimistic tile (a submit is a focus choice); `reconcile` keeps a
  surviving expanded tile, re-focuses the same THREAD when its surface disappears,
  clears on deletion, and only auto-opens the newest conversation for the FIRST
  content of an empty board. Reported through `onFocusChange(focusedThreadId)`.
- **Child conversations (S2).** A runtime child thread has no `SessionTurn` of its
  own (its work is in the parent's events). `focusThread(id)` resolves in order:
  a turn with that `threadId` (a continuation creates one) → the nested invocation
  the roster joins via `invocationId`/`originInvocationId` → a roster-only panel
  rendered from `SessionThread.messages`. Focusing a child collapses the tile and
  every other PERSISTENT child entry, so exactly one conversation is expanded;
  pure invocation details (no roster join) keep their independent expand. Clicking
  a mapped nested row focuses the child's true id, which the composer then targets.
- **Routing (`resolveSubmitTarget`).** Focused idle/stopped → `continue` (new turn in
  the same thread), focused running → `steer`, no focus + `#` references →
  `connected` (new thread whose turn carries `references`; the roster derives
  `connectedThreadIds`, a reference EDGE — never `ownerThreadId`, which stays
  delegation lineage), no focus → `new`. The wire body carries `threadId` ONLY in
  the first two cases; omitting it is the server's "open a new thread" signal.
  Unfocused submits run CONCURRENTLY, one lane each; only a legacy pre-thread
  harness handle keeps the serialized backlog.
- **A running focus is not always steered.** Steering is text-only and needs
  terminal reference content, so a draft with attachments (`attachments > 0` in the
  helper, ready files only) or a `#` reference whose target turn is still
  `queued`/`running` becomes a QUEUED CONTINUATION turn in that same thread: bytes,
  reference binding and prompt are kept and run when the active turn settles. The
  target id (and thus the POST body) is unchanged; only the label changes —
  `submitTargetLabel` prints `Queued in …` instead of `Steering …` when
  `target.queued` is set. `main.ts` feeds both the paint path and `run()` the same
  counters (`draftAttachments` ready count, `unfinishedReferenceCount` over the
  authoritative `records`), so what the line promises is what the request does.
- **Capacity.** At most `MAX_THREAD_RECORDS` (256) independent host threads per
  session, delegated children of host threads included; creating one past the bound
  is the runtime's "already has N independent threads; delete a terminal one"
  refusal, mapped to `429` on the server's thread routes. Deleting a terminal
  thread removes its record and frees the slot again. The UI does NOT auto-prune:
  reducing thread count is an explicit per-row delete. Deletion purges only that
  conversation — not what other histories were told, not what it wrote to shared
memory (tasks/profiles/chapters/locations), and not a result a connected thread
  already received.
- **One conversation, many runs (T12b).** The server keeps one `SessionTurn` per run,
  but the board projects every turn of one `threadId` into ONE top-level
  `.conversation` container (`ui/turns.ts` `placeTurn`/`reorderHosts`), in recorded
  order. Idle continuations and steered prompts therefore extend the SAME RR2
  conversation instead of adding a second top-level tile; only the first exchange
  shows the conversation label. A legacy turn without a thread stays its own row. A
  roster `ownerThreadId` nests a child conversation's continuation inside its
  owner (still focusable by id); agent-spawned invocation rows remain the only
  indented `.thread-row` entries. `blocks()` is per turn and unchanged, so `#`
  result bindings survive grouping. Expanding a conversation opens every exchange;
  exactly one conversation is open at a time.
- **Steering answers with the owner.** A running target may return the OWNING turn
  (same id), so `run()` discards its optimistic steering tile and merges the record
  into the existing tile (`view.discard`). Without that, an unbound queued ghost
  would survive every later snapshot as "pending". The owner's `steers` audit is
  rendered as a visible `.turn-steer` user message INSIDE that tile (R9), in record
  order, so steering both replies and shows the typed text in the same conversation.
- **Roster order and labels.** The roster is ordered by the server's `sequence`, not
  array order; the display name is the server conversation label (`RR2`/`IT1`). A
  legacy entry without one derives the same agent-prefixed shape from roster order —
  there is no `T{sequence}` wrapper. (The strip that rendered these rows, and with it
  the per-row `stop`/`delete` controls, is removed; the roster now feeds the routing
  decision and the board's label/badge joins only.)
- **Delete reconciliation + tombstones (S3, N1, N2).** The DELETE answer carries the
  full snapshot; applying it drops the turns and the roster row. Deletion is recorded
  in `Instance.threadTombstones`/`turnTombstones` BEFORE the answer is applied, with
  descendants and the removed turns. Every inbound record is filtered through them:
  late SSE `turn`/`event` frames and late GET answers cannot resurrect the thread or
  re-focus it. The sets are session-scoped: `openSession` (switch), `ensureSession`
  and `newSession` clear them, and `applySnapshot` REFUSES a snapshot whose id is not
  the instance's current session (a late answer cannot re-point the card). A switch
  also drops the previous session's `records`/`threads`/watermark BEFORE applying the
  new snapshot, so deletion learning cannot compare one session's roster with the
  next one's ids (N1). A snapshot older than the applied watermark is ignored
  ENTIRELY — it can neither learn a deletion nor replace records/reconcile an older
  turn list and delete a live SSE row (N2). Equal stamps are not stale: every new
  turn bumps `updatedAt`, so only a strictly older snapshot can be missing one.
  `purgeStaleReferences` removes any `#` chip whose turn is gone (it would 400 the
  whole submit) on authoritative snapshots and again after a failed submit restores
  its draft snapshot (N3, silently — the failure notice stays), keeping the surviving
  text/attachment draft intact; labels of surviving blocks are kept by the snapshot's
  per-turn `labelSeeds`.
- **Labels (S6/R8).** `threadLabelOf` is the ONE display identity: the roster's
  agent-prefixed conversation label (`RR2`) or an agent-prefixed fallback for a
  legacy row, `T?` only when the roster does not describe the id (never digits
  parsed from the opaque id). It titles the tile badge, the root block header and a
  `#` reference. A deleted conversation's ordinal is retired (the server keeps a
  per-code high-water), so a later conversation never reuses `RR3`.
- **The thread strip is REMOVED.** The compact `.thread-strip` band (one row per
  HOST thread with focus/stop/delete controls and a `New thread` unfocus button) no
  longer exists: it duplicated the transcript's own `.tile-thread` badge and cost a
  permanent row of height. Focus is expressed by the single expanded conversation
  (clicking a tile/thread header) and by the composer's routing label; unfocus is
  collapsing that conversation. Per-thread stop/delete are API-only, and a deletion
  learned from any authoritative snapshot drops the focus even when a pending
  optimistic row still names the thread (`applySnapshot` → tombstone check →
  `view.clearFocus`).
- **Stop-all.** `composerStopOf(action, pending)` adds the separate `.composer-stop`
  only when work is pending and the inline action is not already `stop`; it calls
  the same `stopRun` → `POST /sessions/:id/cancel { all: true }`. A draft in the
  field therefore never hides the session-wide cancellation control.
- **Editable transcript (C4/C5).** `GET`/`PUT`
  `/sessions/:id/threads/:threadId/transcript` is the only mutation surface for one
  conversation, and only `messages` are editable: turns, events, statuses,
  `eventTimes` and `usage` stay server history, because they record what actually ran
  rather than what the model will be sent. GET answers
  `{ threadId, agent, messages, raw, invalid? }` (`ThreadTranscriptResponse`) — the
  LIVE transcript, the pretty JSON the editor holds, and the read failure only when
  the value cannot be read. PUT takes `{ messages }` (deliberately `unknown`,
  `UpdateThreadTranscriptRequest`) and answers `{ session, transcript }`, so one
  response repaints the board and the dialog.
- **A broken transcript is a 200, not a 400.** A structurally invalid `messages`
  value is ACCEPTED and PERSISTED. Its raw bytes go to
  `Session.invalidThreads` (persisted as the optional per-record `invalidThreads`
  map), and the live transcript becomes
  `[{ role: 'system', content: '[transcript unreadable: <reason>]' }]` — a `system`
  entry is the only role with no structural partners to satisfy, so the placeholder
  can never itself become the invalid-transcript problem, and a run of that thread
  still carries a readable explanation in the model's context. The session therefore
  stays runnable, snapshot-able and restorable while the operator keeps fixing the
  JSON, and the dialog opens a thread named in `invalidThreads` DIRECTLY in the
  editor with that banner plus the raw value. Only an absent `messages` property is a
  `400`: the service adapter hands an unparseable body as `{}`, so accepting it would
  silently EMPTY a transcript. The rest of the contract is `409` for a running thread
  (record `running` or a lane with an active run — the same predicate `deleteThread`
  uses), `404` for an unknown session/thread, `405` for any other method, and `409`
  when the session's harness handle predates `setThreadMessages`.
- **`harness.setThreadMessages(threadId, messages)` is the write primitive
  (`src/harness.ts`), and its order is fixed.** Resolve the thread (an unknown id is
  the ordinary `HarnessError`) → refuse live work BEFORE validating (the caller gets
  "stop it first", not a schema complaint about a value a run is still writing) →
  validate with `readHarnessMessages` (the SAME reader `snapshot()`/`restore()` use,
  so a harness can never be left holding a transcript its own snapshot would refuse)
  → replace IN PLACE (truncate + push, like `restore()`), because `agent.messages` is
  exposed by reference and a later holder must see the new value. An empty array is a
  legal transcript, a STOPPED thread is writable (repairing a broken conversation is
  the point), and a default `agent:<name>` conversation is writable for the same
  reason. The write notifies the existing `agent_message` reason and emits no progress
  event: a host edit is not model output.
- **Tolerant restore, per thread.** `tolerateThreadTranscripts` validates every host
  thread's stored `messages` BEFORE `harness.restore()` (which validates the whole
  document atomically) and neutralises the unreadable ones while keeping each thread's
  id, agent, label and turn links; `mergeInvalidTranscripts` then reconciles that with
  the raw values the document already recorded. A persisted entry survives only while
  the live transcript is STILL a placeholder (`isUnreadablePlaceholder` matches the
  exact `[transcript unreadable: …]` shape this package mints): a deleted thread, or a
  transcript whose JSON was repaired by hand, makes the recorded raw value stale, so it
  is dropped. The scope is deliberately per HOST THREAD: an invalid DEFAULT
  conversation (`core.agents[name].messages`) still fails the restore and drops the
  session, because that transcript is what the entry point runs and a placeholder there
  would silently rewrite the session's primary conversation. Retention also covers a
  default conversation whose placeholder came from a live `PUT`; only a hand-broken
  `core.agents[name].messages` in the stored file stays fatal. Document-level corruption
  remains fatal — a malformed `invalidThreads` map is record-shape corruption like any
  other field — because tolerance is about one conversation, never about an
  unparseable file.
- **The dialog never destroys an in-progress repair.** A refresh repaints the
  read-only document but NEVER replaces the textarea's text — only an explicit Save,
  a Cancel, or opening a different thread does — and a refresh into or out of the
  unreadable state never closes the dialog. Save parses locally first (`invalid JSON: …`
  keeps the text and sends nothing), then PUTs the parsed value; a 200 carrying
  `transcript.invalid` is a SUCCESS shown as a banner with the text exactly as sent.
  `ui/threads.ts` `invalidThreadsOf` reads the additive roster structurally, so a
  server without it behaves exactly as before.

Tests: `ui/threads.test.ts` (pure roster/routing/labels), `ui/thread-focus.test.ts`
(board focus/badge/discard/stop-all matrix), `thread-routing.test.ts` (live shell
wiring: `threadId` in the body, per-thread stop/delete, steering collision,
stop-all with a draft), `thread-session-scope.test.ts` (N1 cross-session
tombstones, N2 stale snapshot vs live turn, N3 failed-submit reference restore),
`src/harness.thread-runtime.test.ts` (the C4 `setThreadMessages` contract: order,
running refusal, stopped-thread repair, in-place replacement),
`src/server/transcript.test.ts` (transcript read/write on both mounts, an invalid
value as a 200, the 400/404/405/409 matrix, restart round-trips, tolerant restore and
stale-entry dropping, and document corruption that still aborts startup),
`ui/thread-transcript.test.ts` + `ui/thread-transcript-edit.test.ts` (the lossless
read-only document, the editor, and the unreadable-thread open).

### Lane workers: `threadExecution: 'worker'`

`src/server/workers/` is the subsystem that lets ONE logical thread (a `ThreadLane`
in `src/server/sessions.ts`) execute its whole turn — agent loop **and** CPU-bound
tool bodies — on its own OS worker thread, while the session's shared state stays
owned by one coordinator. The default remains `inline`, so nothing changes shape for
an existing host.

Layout (each file states its own contract in its header):

| File | Owns |
|---|---|
| `protocol.ts` | the frame vocabulary (`hello`/`turn`/`invoke`/`steer`/`interrupt`/`event`+`event.ack`/`mutation`+`mutation.receipt`/`request`+`request.reply`/`turn-done`/`aborted`/`fault`/`dispose`/`broadcast.registry`/`sync.memory`/`lease.grant`) plus the epoch / seq / callId / event-credit rules |
| `lane-identity.ts` | the authority's id ledger: leases per id space, in the core's own units |
| `lane-commit.ts` | mutation ops + receipts, the writer-lease ledger, and the journal that decides when a turn may be published |
| `lane-memory.ts` | `harness.memory` across lanes: faithful transfer, bounded declared windows, compare-and-set, named refusals |
| `lane-authority.ts` | the COORDINATOR side: answers a lane's routed `runtime` calls on the canonical harness, folds and replays a commit group |
| `lane-host.ts` | the per-store worker manager: entry resolution, spawn, hello, event relay-then-ack, ordered mutating answers, receipts, crash teardown, idle reclaim |
| `lane-worker.ts` | the spawned **entry**: source vs built layout, resolve hooks for `.ts` in dev/test |
| `lane-worker-loop.ts` | the worker loop: rebuild, capability report, runtime interception, operation derivation, commit boundaries |
| `capability.ts` | what may run in worker mode at all, per harness and per tool, with the reason and the fix |

The three load-bearing decisions:

- **State moves as operations with receipts, never as a merged document.** The first
  cut let each lane mutate a full harness replica and merged the record diff
  last-writer-wins; an independent review (`Temp/t3`) reproduced, through the core's
  own validators, what that lost: a rejected `nextId`, one of two concurrent terminal
  results, a spent tool budget, a sibling's memory key deleted by a lane that never
  read it, and mutations silently dropped. So an append carries the prefix length the
  lane saw, an IN-PLACE rewrite of the already-committed prefix carries the digest of that
  prefix (`transcript:patch` — the write a plugin's `setIncluded`/`edit` makes changes no
  length at all, so the append condition could never see it and the change died with the
  worker process; the lane now keeps a `committedDigest` beside its `committedLength` and
  the authority replays the rewrite through `harness.patchThreadMessages`), a memory write
  carries the digest it read, and a terminal invocation
  carries an authority-leased identity — a collision is a REFUSAL naming the
  canonical value, never an overwrite.
- **The authority intercepts the replica's own `harness.runtime` object** (the same
  reference `src/harness.ts` builds at ~2415 and the core tool sources call), not the
  `harness.runtime` property. That is what makes the interception total: harness
  internals call `runtime.*` locally, so a slash command or a manual tool body running
  on a lane is routed too. `search` and `fetch` stay local — their provider and network
  waits are the work isolation protects. `delegate` is classified local as well (the
  key exists on the replica and nothing crosses for it), but a replica REPLACES it with
  the nested-run refusal below, so the classification describes the routing, not a
  promise that it runs.
- **Nested conversation state is refused, not weakened silently (S7 + T14).** `delegate` and
  `threadFork` each start a CHILD conversation, and adopting a thread by an EXISTING id
  needs a core seam the authority does not have (it can mint an id, mirror a status, and
  archive a result — `appendThreadMessages`/`setThreadStatus`/`archiveInvocation` — but
  not adopt a whole thread). Running them lane-locally produced a real answer behind
  phantom state: the archived child result reached the coordinator while the canonical
  roster could not list the child and its transcript died with the lane. So
  `lane-worker-loop.ts` `refuseNestedRuns()` closes FOUR kinds of door at hello:
  1. it deletes the two registry entries (the run builds its declarations AND resolves a call
     from `Object.values(tools)`, `src/harness.ts:1105`/`:2242`, and `threadFork`'s dispatch is
     a core CONTROL path keyed on a definition marker the replica handle does not expose,
     `src/harness.ts:2111-2120`);
  2. it replaces `harness.runtime.delegate` (the route
     `src/tools/runtime/delegate.tool.ts:120` calls) with a thrower;
  3. T14/T15 — it ARMS the core nested-run policy (`replica.nestedRuns('refuse')`) on EVERY lane it
     starts, whatever preset that lane rebuilt: the arm follows the execution mode, there is no
     per-preset flag to read, and it runs before the capability report and before any frame is
     serviced, so no tool body can be reached unarmed. Steps 1-2 close the doors that go through a
     tool or a runtime route; they never reached the doors a tool BODY holds. T13 measured the gap:
     the shipped `textSummarize` called `ctx.run(...)`, the child answered, and its transcript died
     inside the lane, while `refuseNestedRuns` reported a clean removal. The policy is core state
     (`src/core/nested-runs.ts` owns the code, the sentence and the validated arm), and T15 keeps it
     enforced at the SURFACES rather than at a stack depth: `ToolContext.run` refuses at all three
     construction sites (the model dispatch, `invokeRegisteredTool` and `executeToolInternal` — the
     last two pass NO parent run, which is why a `runAgent` lineage check alone was not enough),
     `runAgent` still refuses anything that reaches it with a parent or as a branch, `context.agents`
     is a guarded view whose `turn()`/`stream()` throw at the READ, and a refusing instance hands the
     body `toolHandleView()` instead of the raw handle — its callable, `sendThreadInput` and the
     brains under `agents`/`subagents` throw WHENEVER they are reached, so a body that stores
     `context.harness` and fires it from a callback after its own call settled is refused exactly
     like a call inside the body, which a timing window (`toolBodiesRunning`) could never bind. That
     window stays only as the backstop for a RAW handle a host-defined closure (no scanned source,
     reported as `closure-definition`) captured in its own scope, and it skips a run that arrives
     with a `threadState`, so a direct tool call running alongside the lane's own authorized turn can
     never refuse that turn. Plain reads and the routed `harness.runtime` operations pass through the
     view untouched, an inline harness still receives the strict-identical live handle, and a write
     made through the view lands on the live replica (it is a guard, not a copy). Every door throws
     the named `nested-run-unsupported` error BEFORE a thread record, a transcript append or a
     provider request exists, and the read-back in `refuseNestedRuns` turns an absent seam (a stale
     `dist/` worker bundle) into a hello `fault`: the handshake is rejected, and there is no inline
     fallback.
  The refusal is one formatter, so no surface can paraphrase it: `capability.ts` re-exports the
  code and words the tool-name spelling (`NESTED_RUN_TOOL_NAMES`,
  `NESTED_RUN_LIMITATION_CODE`, `nestedRunLimitationMessage`), `NESTED_RUN_ARMED_DOORS` (four doors:
  `context.run`, the callable, `sendThreadInput`, a sibling brain run) +
  `nestedRunHandshakeLimitations()` state the armed doors in the hello `limitations`, and a
  per-BODY textual scan (`LANE_NESTED_RUN_DOORS`, `reachesNestedRunDoors`) reports a
  runtime-refused door (`context.run`, `callTool('delegate')`) as a warning while REFUSING, before
  it is installed, the revisions whose OWN source starts the child (`context.harness(...)` used as a
  runner, `agents.<name>.turn()/stream()`) — not because the runtime is blind to them (T15 refuses
  those very doors at the handle a refusing tool is handed) but because such a body has no
  worker-safe path left, and installing it would promise the model a call that can only fail. The
  scan states its own limit on the surface: it is textual, a computed member or an uncaptured helper
  can miss it, and the armed core — not the pattern — is the guarantee for every spelling, named or
  missed.
  A shipped tool with a real local path takes it instead of failing: `textSummarize` reads
  `context.nestedRuns` and condenses the notes on a lane (its documented no-summarizer
  fallback), so worker mode neither loses a child nor bans the toolbox over one call. Cross-thread
  work is NOT in that set: `threadSend`/`threadList` route to the authority and `threadRead` reads
  through it, so the roster feature survives worker mode intact.
- **A commit is applied through targeted core seams, never `restore()` per commit.**
  `restore()` rebuilds every created tool and thread agent and zeroes each thread's
  generation, i.e. it spends coordinator CPU and disturbs live handles. The four seams
  (`appendThreadMessages`, `setThreadStatus`, `archiveInvocation`, `reserveIdentity`;
  `src/harness.ts` ~3833-4060) are the whole applier surface, and each validates its
  own input so a rejected lane write mutates nothing.

Node-24 facts this subsystem paid for (all still true, don't re-derive them):

- a worker does **not** service `parentPort` messages while its module body is still
  evaluating, so the loop must be driven from the message handler, not from a
  top-level await;
- `module.registerHooks` must **not** return `format: 'module'` for a `.ts` file —
  that routes it through the JavaScript compiler and loses Node's type stripping;
- a source-mode worker needs `execArgv: ['--experimental-transform-types']` for this
  repo's parameter properties;
- an unreferenced dynamic import is shaken to an empty namespace by the bundler, so
  the entry imports the loop AND calls `startLaneWorker()` — that call is what keeps
  `dist/underload-harness.worker.mjs` alive;
- `workerData` is read-only and a cloned `AbortSignal` arrives as `{}`, so
  cancellation is a FRAME (`interrupt`), never a signal copy;
- the global `Worker` is undefined in this Node build; `node:worker_threads` is used.

Two more contracts are enforced at the coordinator boundary, because both used to be
claimed before anyone knew:

- **A steer is answered by the worker, not by the post.** `lane-host.ts` `steer()` returns
  `Promise<LaneSteerReceipt | undefined>`: `undefined` when no live lane owns the
  conversation (the store then answers from the canonical harness, exactly as inline does
  once a run ended), otherwise the worker's own `steer.result` receipt — `{queued: true}`,
  or `{queued: false, reason}` naming the refusal. Waiters are a per-turn FIFO (the frame
  pair carries no steer id, and a lane has one live turn), and a turn that ends, faults, or
  a lane that dies settles every outstanding waiter `false`. `sessions.ts` `steerOnLane`
  forwards THAT, so `steered: true` on `POST /sessions/:id/tasks` is now evidence the
  guidance reached the running conversation, not evidence a frame was posted.
- **The declared memory window follows the installed revision.** `sessions.ts`
  `memoryKeysFor` scans with `workers` `toolScanTextOf` (the `moduleText` + captured
  helpers, the field a `format: 'module'` registration actually fills — T10 finding M5) and
  caches per session keyed on the sorted `name + revision` fingerprint of
  `harness.toolSources()`, so `toolCreate`/`toolManage` refreshing a revision recomputes the
  window instead of keeping the one captured at session build.

Tests: `src/server/workers/lane-authority.test.ts` (19 in-process cases against a
REAL harness — prefix refusal, one-writer lease, central archive with reassigned
order, memory CAS, routed `task`/`threadSend`/`threadList`, lease disjointness,
retired epochs answering nothing), `lane-worker.test.ts` (10 live-worker cases: two
lanes busy simultaneously, an 800 ms burn while a sibling's event stream grows, a task
written on one lane read back by a REBUILT lane, cross-thread send/roster from a lane,
a cancel with events frozen, a terminated worker failing the turn with canonical
transcripts frozen, an unrebuildable preset refused at create, the nested-run removal
against a REAL preset harness, and the steering receipt from both angles),
`lane-worker-correctness.test.ts` (T11: eight turns of one conversation with the lane
reclaimed between each, a message another lane sent while this one was idle, a
cross-thread read answered from canonical state the lane never created, the
`maxLaneWorkers` cap with the evicted lane still usable, and an in-flight turn settled
by `host.close()`), plus
`lane-commit`/`lane-identity`/`lane-memory`/`protocol`/`capability` for the
primitives, `io-worker-bridge.test.ts` for the durability path, and
`config.test.ts`/`environment.test.ts`/`server.test.ts` for the runtime surface.

### IO workers: `ioExecution: 'worker'`

The lane workers isolate a turn's CPU; the IO worker isolates **durability**. One
thread per database root owns the write side of `harness/state.json` and
`harness/sessions/<id>/events.jsonl`, so the whole-document stringify plus
mkdir/open/write/fsync/rename no longer block the loop that serves every other session
and every SSE stream. The flag is independent of `threadExecution`: a deployment may
want either, both, or neither, and the default for both is `inline` (today's behavior).

Layout (`src/server/workers/`, same subsystem barrel as the lane workers):

| File | Owns |
|---|---|
| `io-protocol.ts` | the data-only frames (`checkpoint.save`, `journal.open/append/flush/rewrite/truncate/remove/close`, `hello`, `shutdown`), the three outcomes (`durable` / `written` / `superseded`), the flattened `{message, code, path, cause}` error report, and the callId source |
| `io-client.ts` | the coordinator side: one FIFO queue per root, the handshake gate, strict-vs-queued semantics, checkpoint coalescing, `barrier`, `close`, the `resolveIoWorkerEntry` chain, and the numbered integration contract at the bottom of the file |
| `io-worker.ts` | the spawned **entry**: source vs built layout, resolve hooks for extension-less `.ts` specifiers, and the explicit `startIoWorker()` call the bundler needs to keep the loop |
| `io-worker-loop.ts` | the thread body: the operation table, the cached per-session `HarnessJournal` (the append fd lives HERE), the staging owner `<pid>.io<threadId>`, and the frame bound re-check on the true serialized length |

Invariants, in priority order:

- **ORDER.** Frames are posted in call order and answered one at a time (every
  operation inside the thread is synchronous), so a journal append reaches the file
  before the checkpoint that lists it, a reset's truncate precedes the document that
  forgets those turns, and a `journal.flush` ordered ahead of a save fences the tail.
  The rule `src/server/journal.ts` always relied on becomes structural.
- **NO FALSE SUCCESS.** An awaited operation resolves only on the worker's own success
  receipt and rejects with the exact message the inline writer throws, so a 500 body is
  identical in both modes. A QUEUED operation never claims durability at all — it
  claims order — and its failure goes to the same channels the inline
  `journal.error` / `persistence.lastWriteError` feed. A coalesced-away checkpoint is
  counted `superseded`, never reported as written.
- **ONE WRITER.** The store still owns the state and builds every record. In worker mode
  it must not write through a coordinator-side `HarnessJournal` for a session the client
  owns (two append handles is two writers), so `attachJournal` creates a READER only and
  the open/append/rewrite/truncate/remove/close calls are queued. Reads
  (`persistence.load`, `journal.read`) stay on the coordinator by design.
- **NO INLINE FALLBACK.** A missing entry, no `node:worker_threads`, a thread that dies,
  or a protocol-version mismatch throws a named `HarnessIoError`, fails every
  outstanding operation, and aborts startup. `startHarnessServer` awaits
  `store.ioReady()` before `listen`, and `close()` awaits `store.drainIo()` so the
  graceful document is on disk before the process may exit — with `summary.failures`
  listing what is NOT known durable.
- **TERMINAL FENCES (new, strictly stronger than inline).** A cancel / cancelThread /
  turn-start / command-terminal commit maps to `io.commitCheckpoint({ document,
  fenceSessions: [session.id] })`. Inline never fsynced at those sites, so worker mode
  is an upgrade, not a parity claim.
- **BOUNDED, NOT FREE.** The record build and the structured clone of each frame stay on
  the main thread (the authority owns the state); a checkpoint is bounded by
  `maxFrameBytes`, measured by the worker and fed back so the client's guard is O(1).

`SessionStore` opens the client in its constructor when the resolved runtime says
`ioExecution: 'worker'` (or when a host injects `options.io`), and the strict path is
`await`ed through 17 `persistOrThrow` call sites — which is why `create`, `enqueue`,
`reset`, `remove`, `cancel`, `cancelThread`, `deleteThread`, `updateThreadTranscript`,
`setAgentModels`, `persistRegistry` and `mutateRegistry` are async on the public store
surface, and why the dispatcher awaits them before building a response.

Tests: `src/server/workers/io-protocol.test.ts` (frame validation and the outcome
table), `io-client.test.ts` (a REAL spawned worker: ordering, barriers, error close,
source-mode entry, and byte identity with the inline writer), `io-worker.test.ts` (the
operation table in-process), `src/server/io-worker-bridge.test.ts` (the store and the
standalone listener: readiness, off-loop strict writes, a failed commit that rolls back
with the inline message, journal ordering + reload, reset/delete/dispose queueing,
shutdown drain, and the built bundle round-trip), and
`scripts/check-package-runtime.mjs` (the SHIPPED `dist/underload-harness.io-worker.mjs`
handshakes, commits, journals and is re-read by the built server).

### Agents and the harness registry

`src/agents/` is the trusted catalogue: one `AgentProfile` per agent with `name`,
`title`, `description`, `instruction`, and `guidelines`. `agentInstruction()`
composes the profile into ONE system prompt — `` `${instruction}\n\nGuidelines:\n- …` `` —
because several OpenAI-compatible gateways accept only a single system turn, so an
`[instruction, guidelines]` pair used to seed two `system` messages and silently lost
the policy on those models. The application builds agents with
`agent({ model, instruction: agentInstruction(profile), provider })`. That join is the
DEFAULT only: with an explicit `instructionOverride` (T6) `agentInstruction()` returns the
stored text verbatim as the complete prompt, so the guidelines never double up under an
operator's edited box. Nothing in a profile is secret, and a client cannot supply one.

`src/harnesses/registry.ts` is the in-memory harness registry shared by the store and
the dispatcher:

- `list()` → shipped templates (preset order) then user-created harnesses; each entry
  is an independent COPY of its template (R20.1), never the module object;
- `find()` resolves legacy aliases (`writer`/`assistant` → `instruct`,
  `researcher` → `research`) for session creation; `update()` deliberately does not
  accept an alias;
- `create()` validates a new name (letters/digits/`_`/`-`, ≤64, case-insensitively
  unique, not an alias), a known `primary`, and a distinct, bounded, known
  `subagents` allowlist, then builds a live harness with the shared toolbox and
  `builtin: false, editable: true`;
- `update()` changes `title`/`description`/`primary`/`subagents`/`agentModels`/
  `agentInstructions` for
  **every** entry (there is no 403/read-only branch; `editable` is a compatibility
  wire field, always true). It **replaces** the preset object instead of mutating
  it. A metadata-only patch keeps the captured factory (demo's script, flaky's
  `testFlaky`); an executable patch (primary/subagents/agentModels/agentInstructions)
  rebuilds from
  the `template`: `scripted` upgrades to a live profiled harness and corrects
  `requiresEndpoint`/`tools`/`environmentTools`, `flaky` rebuilds the live toolbox
  with the extra retained, and `live` uses `createProfiledHarness`. Changing
  `primary` without restating `subagents` removes the new primary from the old
  allowlist;
- `remove(name)` (T5) deletes any entry by its DIRECT name (an alias is a read redirect,
  not an identity), returns the removed preset, and answers 404 for an unknown or
  already-deleted name. A deleted **built-in** also records a tombstone
  (`deletedBuiltins()`), persisted as the additive `deleted` array in `state.json`,
  because a fresh registry always re-seeds the shipped templates - the missing row
  alone cannot express a deletion. A deleted **user** harness needs no tombstone (its
  row is simply gone). `create()` clears the tombstone for the name it takes, so
  re-creating `instruct` survives its own restart, and `restoreHarnessRegistry` replays
  the tombstones BEFORE the saved rows. `snapshot()`/`restore()` give the durable commit
  path one rollback for create/patch/delete: `SessionStore.mutateRegistry` writes the
  document and restores the snapshot (entries, listing order, tombstones) when the write
  fails, so `DELETE` never answers `{ deleted: true }` for a harness the next restart
  brings back. Sessions are untouched either way - each one restores from its own frozen
  preset record;
- `agentModels` (R9) is a map of selected agent id → model id on create/patch. Keys
  are validated against the FINAL `[primary, ...subagents]` set (unknown key = 400
  naming the members), values are trimmed, non-empty, ≤200 characters, and free of
  control characters. `update()` REPLACES the map when one is stated — `{}` clears
  every override — and otherwise keeps only the entries whose agent is still
  selected. `createProfiledHarness(primary, subagents, agentModels)` captures the
  map in the factory closure, so `update()` builds a NEW closure and a harness edit
  never reaches an existing session; that session's models change only through
  `PATCH /sessions/:id`. Only ids are overridable: provider, base URL, and key
  always come from `RunnerSettings`. `describeHarness()` emits the override map
  only when it is non-empty, so an omitted agent reads as "session default";
- `agentInstructions` (T3 editable configuration) is the parallel map of selected
  agent id → instruction OVERRIDE on create/patch. Same validation shape
  (`normalizeAgentInstructions`: keys must be FINAL members, values trimmed,
  non-empty, ≤8000 characters, and free of control characters except tab/newline/CR,
  so multi-line prose is legal) and the same REPLACE semantics (`{}` clears every
  override). It is EXECUTABLE state: `update()` rebuilds the factory (an instruction
  patch on the scripted demo therefore upgrades it to a live harness, exactly like a
  model patch), it is persisted in the registry record, and `agentInstruction(profile,
  override)` returns the stored text VERBATIM as the COMPLETE prompt (T6) — the profile's
  `guidelines` are the default an UN-overridden member runs on and are never appended
  underneath an override, and the trusted profile in `src/agents` is never rewritten. A
  member the map omits runs the trusted `GET /agents` instruction, which is why the
  descriptor carries the OVERRIDE map and the UI edits one box holding the full effective
  prompt (composed from `instruction` + `guidelines` when there is no override). Sessions
  are deliberately NOT part of this contract: a running
  conversation's system messages are already seeded, so `PATCH /sessions/:id` still
  accepts `agentModels` only and the frozen `harnessDefinition` records the overrides
  the conversation was built with;
- unknown names are 404; duplicate names are 409; everything else is 400. No
  registry failure is a 403.

Semantic validation lives in the registry; the dispatcher rejects unknown body
fields, so a bare `instruction`, `tools`, or `provider` cannot be smuggled into a
create/patch request. `agentModels` is the single model-shaped field: it selects an
id, never credentials. `agentInstructions` (T3) is the single text-shaped field: a
per-member OVERRIDE stored on the harness, validated and bounded by the registry,
that never rewrites the trusted profile. The registry is **in memory only unless a database root is
supplied**: with one, registry metadata is saved in `<root>/harness/state.json` and
replayed on restart (see the Persistence section in README.md); without one, a
restart returns to the shipped catalogue.

Sessions capture the resolved preset AND a `describeHarness()` snapshot at
creation. **Team membership, the primary, and that descriptor are frozen**: a
registry change affects future sessions only, and the existing session keeps
running (and reporting) what it was built with, including its frozen
`harnessDefinition`. The same descriptor projection feeds `/harnesses`, so a card
and a session snapshot cannot disagree.

**Agent models are the one live mutation (R2).** `SessionStore.setAgentModels`
(`PATCH /sessions/:id`) validates the map with the registry's shared
`normalizeAgentModels` against this session's members, applies it all-or-nothing by
calling `agent.model(value)` on each brain, and returns the ordinary snapshot.
Rules that matter:

- it **merges** into the live map (an agent absent from the body keeps its model),
  unlike `PATCH /harnesses/:name`, which replaces the override map;
- `{}` is a 400 no-op, an unknown key or invalid model id is a 400 with nothing
  applied, and a rejected patch leaves every agent unchanged;
- it is **allowed while busy** (streaming run or manual tool call) and never
  aborts or rebuilds anything; `agent.turn()` captures `requestModel` before the
  transport call, so the in-flight request and the assistant message it commits
  keep the old model and the next request uses the new one (a queued task reads it
  when the pump starts that task, so the patch applies there too);
- `SessionSnapshot.model`/`agentModels` are derived from the live brains on every
  snapshot, while `harnessDefinition.agentModels` stays the creation-time record.

This frozen-team rule is not a read-only harness rule: every harness card is
editable (R20.1), and a team edit applies to the next session started. Models are
the exception a saved chat exposes directly.

### Decisions worth keeping

- **No environment autoload in the published library.** `src/` never imports
  `dotenv`; importing `@underload/harness` must not read the host's `.env`. Only
  the Node app entry points load the one package-root file, before provider/search
  configuration, and `.env` stays git-ignored while `.env.example` is tracked.
- **The server is a consumer, not a new layer in `src/`.** `SessionStore` calls the
  same `harness()` a CLI does; neither the CLI nor the server adds tool execution
  or model policy.
- **Sessions are durable only when a database root is supplied.** With one, the
  server writes `<root>/harness/state.json` and a restart rebuilds the registry,
  sessions, queues, and core state; without one the store is in memory and a
  restart is a clean slate (the default for direct unit tests).
- **The queue belongs to the server, not to a response.** `/tasks` answers `202`
  because a task accepted with a socket would die with that socket. Only the legacy
  `/messages` route keeps the old "close cancels" contract, and `/events` watches
  without owning, so reload/hidden tabs/switching sessions never stop work. STOP is
  an explicit `{ all: true }` cancel rather than an implicit disconnect.
- **Queue and transcript are one record.** A queued turn is a real `SessionTurn`
  from acceptance (stable id/index, no `startedAt`), and every frame is an upsert by
  that id, which is what lets the UI reconcile instead of rebuilding and lets a
  reload show a backlog. `queueDepth` is derived, not a second source of truth.
- **Presentation is state, not decoration.** Green is reserved for the one active
  run, so completed rows are grey and queued rows neutral; a finished turn can
  never look busy. Markdown/HTML is untrusted: every rendered response goes through
  DOMPurify, and highlighting is a fixed registered language subset to keep the
  bundle small.
- **No CORS, explicit client header (standalone).** Dev proxies `/api` to the
  standalone server; production serves the UI and API from one origin. Every
  standalone request must carry `X-Harness-Client: ui`, which a foreign page
  cannot set without a preflight the server never answers. The service host is
  the opposite trade: permissive CORS from the loader, so the boundary is an
  Origin gate (own host or loopback) and not authentication.
- **The server key follows the configured provider, never the client's URL.** A
  single `mergeSettings` (`src/server/config.ts`) serves `POST /models` and
  `POST /sessions`: an omitted/blank key falls back to the configured key only
  when the effective base URL matches that provider's origin + base path
  (trailing slashes normalized); a foreign host/port/path gets no key unless the
  client supplies one. This is what stops `POST /models` or a session from being
  used to exfiltrate `HARNESS_API_KEY`.
- **The bootstrap `rootPath` is the API URL.** It is `/v1/harness`, not a
  filesystem root. File tools use the process cwd and are unsandboxed, so no
  workspace-root option exists or is advertised.
- **Loopback by default (standalone).** `127.0.0.1:5181`. Direct tool calls and
  `workspace` run with the server's permissions and have no sandbox. The service
  host binds `0.0.0.0`; restrict it to loopback (its start options) or a trusted
  network; no global service setting is changed here.
- **Settings are bounded and type-checked once.** Base URL ≤ 2048 chars, model
  ≤ 256, non-string fields are `400` (`SettingsError`), so a malformed settings
  body cannot 500 or carry an unbounded value into provider requests.
- **One toolbox, built explicitly.** Every live harness (built-in and
  user-created) uses `createToolboxHarness`/`createProfiledHarness` with the shared
  registry and `presets: false`, so a session can never see a tool outside the
  advertised toolbox through the library's default preload. Choosing a harness
  changes its agents and routing only.
- **A command turn is terminal before the response.** A `/command` never enters a
  queue or a lane, so it needs neither the single-flight gate nor the pending cap, and
  `POST /tasks` can answer the finished turn in the same `202` envelope a queued task
  gets. The event frames are the ones the renderers already switch on
  (`start`/`tool_call`/`tool_result`, paired by `callId`) with a synthesized
  `name: 'command'`, so no front end learned a new shape, and the transcript survives a
  reload. A command's answer is text with `isError`, not a `usage` tally: nothing was
  billed, and an absent tally beats a fabricated zero.
- **A broken transcript is a successful write.** The transcript is the user's own
  JSON, so refusing a structurally invalid value would strand them: they could not
  save the repair they are typing. Instead the raw value is persisted
  (`invalidThreads`), the live transcript becomes a valid `system` placeholder, and the
  session keeps loading, snapshotting and running. Only an absent `messages` property
  is a `400`, because the service adapter reports an unparseable body as `{}` and that
  would otherwise empty a conversation.
- **Commands and transcripts are server state; the UI stays a renderer.** The browser
  has no command table, no slash parser and no transcript validation of its own beyond
  "is this JSON parseable". It submits the line and PUTs the parsed text, and it draws
  whatever the server recorded — which is the same rule the queue, the timeline and the
  labels already follow.

### Scripts

```bash
yarn cli "task"           # one-shot as the live default preset (instruct)
yarn cli --preset demo    # explicit offline scripted fixture
yarn cli                  # interactive Instruct session
yarn cli --serve          # explicit standalone API + built UI on :5181 (CLI opt-in)
yarn dev:frontend         # Vite UI on :5180, dual-stack wildcard (localhost + LAN); /api proxies to the service on :5000
yarn dev:server           # separate standalone API on :5181 (no Vite/UI)
yarn preview:frontend     # built UI on :5180, proxies /api to the service on :5000
yarn test                 # library + server + shared tests
yarn test:frontend        # jsdom client tests
yarn start-service        # repo root: builds UI for /harness/, serves it + /v1/harness on :5000
```

`dev:frontend` and `dev:server` are independent launches: the first is Vite only
and never calls `startHarnessServer`; the second is the standalone API only and
starts no UI. `HARNESS_DEV_API` (default
`http://127.0.0.1:5000/v1/harness`) selects the Vite proxy target, so the UI can
be pointed at the standalone `/api` mount when that is the server being run.
There is no generic `start`/`serve`/`server` script: normal hosting is owned by
`@underload/service` (`yarn start-service`), and `startHarnessServer()` is an
explicit API. The root launcher builds the UI with `PLAYGROUND_BASE=/harness/`
and `VITE_HARNESS_API=/v1/harness`, then imports the service entry from the
repository-root cwd after setting `UNDERLOAD_HARNESS_UI=1`; the service entry is
API-only without that opt-in, so `yarn workspace @underload/service start` needs
no UI build. The opted-in gateway serves the page at `/harness/` as well as
`/v1/harness`, so a device on the same LAN can open `http://<LAN-IP>:5000/harness/`
(no auth, trusted LAN only). `src/server/server.test.ts` drives the real HTTP server with the
scripted demo: create a session, stream a task, continue it, reset it, call a tool
directly, and check the error statuses. `src/server/service-start.test.ts` runs an
actual `vite-node` service gateway that discovers
`src/server/endpoint/harness/service-route*.ts` and answers `/v1/harness`. The UI
build no longer needs a package alias, so `src/frontend/dist` is a plain client
bundle.


## Not built yet

In the order they are expected:

1. **streaming tool output** — `execute` cannot report progress mid-call yet.
2. **context summarization** — history *pruning* is built: the shipped
   `context-compaction` plugin withholds tool units a later success already answered, at
   the turn boundary, through the `included` flag (a pure rule in
   `src/core/context-pruning.ts`, guarded by `minTokens`, a `safetyTurns` tail horizon and a
   per-pass unit bound, and reported on `api.report.diagnostic`). What is still missing is
   the **summarize-and-reinitialize checkpoint**: a structured summary plus a verbatim
   recent tail, applied through `replaceHistory()` — the design is recorded in
   `docs/tasks/2026-11-09-progressive-compaction.md` (T6). Nothing in the library calls a
   model to condense history yet, and a pruned unit is never re-fetched: its full text
   stays in canonical history and a host can switch it back. What the MODEL can act on is
   now built (same entry, T5.1): an over-cap result arrives as a head/tail envelope whose
   `note` names the call to re-run, so a withheld result is re-fetchable by RE-RUNNING it
   rather than by re-reading a stored copy — the full text itself is not kept anywhere
   addressable. That is the precondition T5.3 (eliding superseded LARGE results) was
   waiting on; what still blocks T5.3 is the undecided storage question — whether an
   annotated result keeps its original text or only a handle
   (`docs/tasks/2026-11-09-progressive-compaction.md`, Open decisions 2).
3. **per-agent tool scoping** — searchable tools are catalogued once; every agent
   can discover every searchable tool (only `delegate` is primary-only).
4. **sandboxed presets and created tools** — the file and command tools, and any
   `toolCreate` body, run with host permissions; a `root`-scoped/fenced variant
   would be the natural next step.
5. **more presets** — a patch/multi-edit tool is the obvious remaining gap. The
   former `fetchUrl` idea is built: `fetch` (text) and `download` (bytes) cover
   the read-a-URL surface.
6. **slash-command UX in the browser UI** — the composer's mention popup triggers on
   `@` (files) and `#` (result blocks) only, so a `/` line has no completion surface
   and no command palette: an operator types a command blind and reads the answer off
   the resulting tool card, with `/help` as the discovery path. The registry itself is
   already readable (`harness.commands`), so this is presentation work.
7. **command progress** — related to item 1: a command runs to completion before the
   `202` leaves, so a long host command cannot stream intermediate output or be
   cancelled as a command (it emits no progress events by design, and a command turn is
   not a per-thread lane — in worker mode its body still runs on the session's operator
   lane, but there is no command-specific cancel or stream). A built-in that calls a
   tool inherits the tool's own limits.

Parallel tool execution is no longer on this list: calls are scheduled
concurrently (see “The loop”). There is no ordered side-effect guarantee, and the
library itself still has no thread/CPU isolation; a server deployment can now move
each conversation onto its own worker thread (`threadExecution: 'worker'`, see
[Lane workers](#lane-workers-threadexecution-worker)), which is documented there
with the boundaries that stay refused. The same deployment can also move the
whole-document checkpoint and the per-event journal off the request loop
(`ioExecution: 'worker'`, see [IO workers](#io-workers-ioexecution-worker)); the
library-level statements above are about the library, and neither flag changes them.

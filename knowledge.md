# @underload/harness Knowledge

Plugin-first CLI agent harness. `agent` is the brain, `tool` is an action, `harness` is the loop.

> **Last verified:** 2026-10-29 (documentation review of the server task queue,
> watcher stream, and transcript presentation (R4/R5); the test suite was not
> re-run in this pass — an independent verifier owns that run)
> **Package name:** `@underload/harness`
> **Dependencies:** none (Node 18+ — default transport uses global `fetch`)
> **Workspace consumers:** none yet

---

## How to Update This File

1. Read `src/harness.ts` for the public barrel and the loop
2. Check `src/core/agent.ts`, `src/core/tool.ts`, `src/core/discovery.ts`,
   `src/core/creation.ts`, `src/core/todo.ts`, `src/core/profile.ts`,
   `src/core/chapter.ts`, `src/core/location.ts`, and `src/transport/openai.ts` +
   `src/transport/models.ts`
3. Check `src/tools/catalogue.ts` / `src/tools/lazy.ts` when touching presets
4. Check `server/`, `cli/`, `harnesses/`, and `playground/` for the app contract
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
  harness.todo.test.ts        todoManage declaration/state in a harness
  harness.records.test.ts     profileManage/chapterManage/locationManage in a harness
  harness.metadata.test.ts    core tool metadata (R7 cap, schemas) as registered
  harness.websearch.test.ts   opt-in webSearch registration/core declaration/secrets
  core/
    index.ts            barrel: agent, tool, searchTools, compileToolSource, createDynamicTool, createTodoTool, createProfileTool, createChapterTool, createLocationTool
    agent.ts            the brain
    agent.test.ts
    tool.ts             an action the model can request, or you can call
    tool.test.ts
    discovery.ts        tag ranking behind toolRequest
    discovery.test.ts
    metadata.ts         core tool metadata (name/description/tags/schema) — one copy for harness.ts, the record factories, and harnesses/core.ts
    creation.ts         validate + compile a tool from an async function body
    creation.test.ts
    todo.ts             per-harness session todo list (factory + reset hook)
    todo.test.ts
    profile.ts          per-harness character/people records (add/list/get/update/remove)
    profile.test.ts
    chapter.ts          per-harness chapters (summaries, status, order, body only from get)
    chapter.test.ts
    location.ts         per-harness locations/places (name, description, notes)
    location.test.ts
  agents/
    index.ts            trusted AgentProfile registry + agentInstruction()
    types.ts            AgentProfile (name, title, description, instruction, guidelines)
    instruct.ts / research.ts / summarizer.ts / workspace.ts / demo.ts / flaky.ts
    agents.test.ts      pinned ids/instructions + guideline composition
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
      syntaxCheck.ts      public tool: language dispatch, two properties
      javascript.ts       node:vm Script parser (imported on demand)
      python.ts           compile() through the interpreter (imported on demand)
    files/
      index.ts
      fileRead.ts
      fileWrite.ts
      fileEdit.ts
      fileList.ts
      fileGlob.ts
      glob.ts           shared walker (fileGlob: filename + content modes)
      *.test.ts
    command/
      index.ts
      commandRun.ts
      gitDiff.ts
      *.test.ts
    websearch/
      index.ts          createWebSearchTool: key resolution, validation, dispatch
      request.ts        bounds, fetch/timeout, sanitized errors, normalization, redaction
      exa.ts            Exa adapter (dynamic import)
      tavily.ts         Tavily adapter (dynamic import)
      websearch.test.ts factory + both adapters, env injected, fetch stubbed
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

The published package is `src/` only. The application built on it sits outside that
tree and is never emitted to `dist/`:

```
cli/
  index.ts              argv parsing, one-shot, interactive, --serve
  render.ts             terminal rendering of HarnessEvent
server/
  index.ts              standalone node:http server (API + static UI)
  api.ts                transport-neutral dispatcher: routes, body policy, bootstrap
  handler.ts            Node adapter: /api prefix, X-Harness-Client gate, SSE writer
  service.ts            @underload/service adapter: /v1/harness, Origin gate, raw SSE
  runtime.ts            lazy shared store/catalogue for the service routes
  sessions.ts           in-memory session store: authoritative turns + FIFO task
                        queue, watchers, single-flight gate
  environment.ts        package-root .env loader (Node entry points only)
  config.ts             provider defaults + mergeSettings credential rule
  protocol.ts           client/server wire types (turns, queue, stream items)
  static.ts             playground/dist serving
endpoint/
  harness/
    service-route.ts        /v1/harness/*  (discovered by @underload/service)
    service-route-root.ts   /v1/harness    (bare bootstrap document)
harnesses/
  index.ts              createToolCatalogue: runtime catalogue for CLI and server
  core.ts               core-tool catalogue entries (sessionBound) for the server (R8)
  presets.ts            the five built-ins, assembled from src/agents profiles
  registry.ts           in-memory registry: create/patch, aliases, validation, agentModels (R9)
  descriptor.ts         describeHarness/describeAgent: the single wire projection
  toolbox.ts            shared toolbox + createProfiledHarness/createToolboxHarness
  tools.ts              timeNow, textCount, diceRoll, noteSearch, textSummarize, testFlaky
  websearch.ts          always-listed webSearch entry (configured or not)
  demo.ts               scripted offline transport
  types.ts              RunnerSettings, HarnessPreset, CatalogueEntry, availability
playground/
  dev.ts                starts the API and Vite with an /api proxy
  src/main.ts           UI client: sessions, queue observer, SSE, direct tool calls
  src/api.ts            root resolution (query/injected/build/api) + fetch + SSE parser
  src/ui/turns.ts       linear turn timeline: completed grey, active green, queued neutral
  src/ui/markdown.ts    safe GFM (marked + DOMPurify) + highlight.js fenced code (R5)
```

`server/` and `cli/` import `src/harness.ts` relatively (they are inside the
package) and re-use the public harness surface; they add no API to the published
package. `playground/` imports only the wire types from `server/protocol.ts` and
never imports the harness, which is why the old `node:` stubs are gone.

Tests are colocated with the module they cover, and they import **only** from
`@underload/harness` — never a relative path. That keeps them honest about the
public surface and free of `../` chains. `vitest.config.ts` aliases the specifier
to `src/harness.ts` (and tsconfig `paths` mirrors it), so `vitest run` needs no
build and can never accidentally test `dist/`.

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
- [Session todos](#session-todos) — Core todoManage, incremental ids, per-harness state
- [Session records](#session-records) — Core profileManage/chapterManage/locationManage stores
- [toolCreate](#createtool) — Runtime tool creation from an async function body
- [Delegation](#delegation) — Explicit primary/subagents, one level deep

### Preset Tools
- [Preset tools](#preset-tools) - the eight lazy presets, executable on their own
- [Web search](#web-search) — opt-in per-harness `webSearch` over Exa/Tavily

### Harness
- [harness](#harness) — Callable execution loop

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
| `agent` | model, instruction, history, one transport call per turn | tool execution, compaction, planning |
| `tool` | description, JSON Schema, one `execute` function | state (except the harness-owned `todoManage`/record factories), retries, policy |
| `harness` | agent registry, tool registry, loop, progress | model I/O, prompt policy |

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
- `options.tools` forwards tool declarations to the transport. The agent never
  executes them; standalone callers do.
- `messages` is the live array (not a copy).
- `model()` reads, `model('x')` writes. `system`/`user`/`assistant` append and
  chain. `reset()` restores instructions + seed messages.

Construction throws on: missing model, and missing transport (neither `stream`
nor `provider.baseURL`).

---

## tool

A tool is an **executable object**. `tool()` returns a callable with `name`,
`description`, `parameters`, and `execute` attached, so the same implementation
runs from a direct call or from the model's tool call.

```ts
const fileRead = tool<string[], { path: string; content: string }[]>({
    description: 'Read one or more UTF-8 text files.',
    tags: ['files', 'read'],
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
    execute: async ({ parameters: paths }) =>
        Promise.all(paths.map(async (path) => ({ path, content: await reads(path) })))
});

await fileRead(['package.json']);                // direct: no harness, no agent
harness({ tools: { fileRead } });                // the model calls it
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
  is what makes `fileRead(['package.json'])` and a model call carrying
  `{ "paths": ["package.json"] }` identical inside the implementation. The harness
  applies it via `unwrapParameters()` → `toolParameterKey()`. Multi-property tools
  such as `syntaxCheck({ code, language })` receive the whole object.
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

## Tool naming (T14)

Every tool — core and preset — is named `<namespace><action>`:

| Namespace | Tools |
|---|---|
| `tool*` | `toolRequest` (discovery), `toolCreate` (runtime creation) |
| `todo*` | `todoManage` (session todos) |
| `profile*` | `profileManage` (session character/people records) |
| `chapter*` | `chapterManage` (session chapters, summaries + ordered list) |
| `location*` | `locationManage` (session locations/places) |
| `agent*` | `agentDelegate` (bounded delegation) |
| `file*` | `fileRead`, `fileWrite`, `fileEdit`, `fileList`, `fileGlob` |
| `command*` | `commandRun` |
| `text*` | `textCount`, `textSummarize` |
| `time*` | `timeNow` |
| `dice*` | `diceRoll` |
| `note*` | `noteSearch` |
| `test*` | `testFlaky` |
| `web*` | `webSearch` |
| (already conformant) | `gitDiff`, `syntaxCheck` |

There are **no aliases**: `requestTools`, `createTool`, `todoTools`, `delegate`,
`readFile`, `writeFile`, `editFile`, `listFiles`, `searchFiles`, `globFiles`,
`runCommand`, `websearch`, `clock`, `wordCount`, `roll`, `searchNotes`,
`summarize`, and the tool `flaky` are gone from the wire surface, the exports, the
catalogue, and the reserved-name list. This is a deliberate breaking change: two
names for one tool makes discovery ambiguous, and a compatibility alias would also
mean a second catalogue entry the model could pick by mistake.

What is deliberately **not** renamed:

- **harness / preset ids** — `instruct`, `research`, `workspace`, `demo`, `flaky`
  are identities, not tool names, and sessions/aliases reference them;
- **agent ids** — `summarize`'s delegated half still targets the `summarizer` agent;
- **the `websearch` harness configuration field** — it names the *feature*, not the
  tool (`websearch: true | WebsearchConfiguration`), so renaming it would break
  every host's configuration for no API gain;
- **generic helpers** — `createToolCatalogue`, `createToolFrom`, `createToolRunner`,
  `createToolboxHarness`, `createTodoTool`, `createDynamicTool`,
  `createWebSearchTool`, and native `node:fs` `readFile`/`writeFile` imports are
  functions, not wire names.

---

## Tool discovery

The rework that keeps a large catalogue out of the context window. A request
declares:

- every `visibility: 'core'` tool, and
- every searchable tool that toolRequest has enabled.

**Every harness preloads the preset catalogue** (`src/tools/`) unless it is
created with `presets: false`. **Four file tools are core (R18)** —
`fileRead`, `fileWrite`, `fileEdit`, `fileGlob` — so they are declared on every
request and need no discovery. `fileList`, `syntaxCheck`, `commandRun`, and
`gitDiff` stay searchable: a model that needs a directory listing asks for
`files`/`list`. A configured tool replaces a preloaded preset of the same name.
The harness-owned toolRequest/toolCreate/todoManage/profileManage/chapterManage/
locationManage (plus delegate for a primary with subagents) are core too, and a
configured `webSearch` is core as well.

**Core is not session-bound.** The four core file tools and `webSearch` have real
implementations, so the server's direct-call path runs them without a `sessionId`.
Only the harness-owned set mutates a session's harness and therefore carries
`sessionBound: true`. There is no `fileSearch` tool: `fileGlob` is the one search
surface (filename mode, or content mode with `content`), and it is now core.

**toolRequest is built by the harness**, not shipped in `src/tools/`. It has to be:
it closes over the live registry and the harness's active set. It is registered
after the declarative tools and before plugins, is always core, and its name is
reserved (`harness()` throws if the config or a preset already has `toolRequest`).
`toolCreate`, `todoManage`, `profileManage`, `chapterManage`, `locationManage`, and
(when subagents exist) `agentDelegate` are reserved the same way.

- Signature: `toolRequest({ tags: string[], limit?: number })` — two properties, so
  the single-property rule hands `execute` the parsed object. A bare array or a
  missing `tags` is tolerated and treated as `[]`, so a malformed call still
  returns the vocabulary. Name, description, tags, and schema live in
  `core/metadata.ts` (one copy the server catalogue also reads); the description
  itself states the five-match cap and the `remaining` count.
- Result: `{ enabled, tools: [{ name, description, tags }], remaining,
  unmatchedTags?, availableTags?, truncated? }`. `enabled` doubles as the ranking
  order.
- `searchTools(tools, tags, limit?)` (`core/discovery.ts`) is the pure ranking and
  is exported from the package root so a UI or a test can reuse it. Only
  `visibility: 'searchable'` tools are candidates — core tools are already declared.
- Scoring is **OR-style, best-match**: each query tag scores a tool (exact tag 4,
  tag prefix 3, tag contains query 2, query contains tag 2, name/description
  contains query 1), and the tool's rank is its **best single-tag score**. More
  matching tags only breaks ties (then name), so breadth can never outrank an
  exact hit. Prefix needs two characters, fuzzy needs three.
- `MAX_DISCOVERY_MATCHES = 5` (R7) is both the default and the hard cap: `limit`
  may only narrow it (1–5). `remaining` is the number of matches the cap excluded —
  a count, never names — and `truncated: true` mirrors it for older clients.
  Results sort by best score, then hit count, then name, so which five survive is
  deterministic. A broad tag is refined (`["files"]` then `["files", "write"]`),
  which is how the remaining searchable tools are reached without pagination.
  Core tools never appear in results: the four file tools and a configured
  `webSearch` are already declared, so a `["files"]` query only finds `fileList`.
- `availableTags` (the sorted vocabulary of searchable tools) is returned when
  nothing matched or when the query was empty, so a failed query teaches the model
  the real tags.
- Active tools live in a `Set` per harness: discovery survives across calls and is
  cleared by `reset()`. `harness.discoveredTools` exposes the names (a copy); a
  server snapshot records them so a reload can show the discovery state.
- An **undiscovered** tool is not callable: the harness answers the call with a
  tool result naming tags that would enable it. The model cannot bypass discovery
  by guessing a name.
- `declared()` builds the request list core-first, then discovered, and is rebuilt
  for every request, so a toolRequest round shows up on the very next turn. `agentDelegate`
  is skipped for every agent except the primary.

---

## Session todos

`src/core/todo.ts` builds the core `todoManage` tool. It is a **deliberate
exception to the stateless-tool rule**: the state lives in the factory closure,
never in a module singleton, so the harness owns exactly one list per instance.

```ts
const { tool, reset } = createTodoTool();   // fresh list + id counter
```

- Actions are incremental: `add` (`text`), `remove` (`id`), `check` (`id`,
  optional `completed`), `uncheck` (`id`), and `list`. `check` defaults to
  `completed: true`; `completed: false` and the explicit `uncheck` alias both
  clear it. `uncheck` ignores `completed` (it is always false).
- Ids are decimal strings (`"1"`, `"2"`, …), monotonic per instance. `reset()`
  clears both the list and the counter.
- Results are `{ todos, todo?, removed?, counts: { total, completed, remaining } }`.
  `todos`, `todo`, and `removed` are defensive copies, so mutating a result can
  never mutate the session list.
- Validation is per action and type-checked consistently: not an object, unknown
  action, non-string `text`/`id`, non-boolean `completed`, blank text/id, and an
  unknown id all throw `HarnessError` with the action/field named. The harness
  turns that into a recoverable tool result; a failed call never mutates the list.
- `src/harness.ts` registers the factory's tool under the exact name `todoManage`,
  marks it core (declared to every agent with no discovery), adds it to
  `RESERVED_TOOL_NAMES`, and calls the returned `reset()` from `harness.reset()`.
  Because `server/sessions.ts` creates one harness per session, todos are isolated
  per session and shared by the primary and its subagents within one harness.
- No persistence, no UI panel, no HTTP endpoint, no priorities/statuses. The
  tool-call UI renders the JSON result like any other tool.

**Not OpenCode's `todowrite`.** OpenCode's current dev branch (`fd8268e`,
2026-10-27) has an experimental `todo` plugin tool gated by `experimental.todo`:
input `{ todos: [{ content, status: 'pending' | 'in_progress' | 'completed' |
'cancelled' }] }`, full-list replacement, no ids or priorities; the visible list is
derived by the UI from the last call's input, with no server-side todo state.
Sources:
[`plugin/todo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/todo.ts),
[`todowrite.txt`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/todowrite.txt),
[`tool-todo.test.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/test/tool-todo.test.ts).
`todoManage` is intentionally a harness-specific incremental API, not parity; do
not replace it with the full-list shape.

---

## Session records

`src/core/profile.ts`, `src/core/chapter.ts`, and `src/core/location.ts` add three
more core tools with the same factory-closure lifecycle as [Session
todos](#session-todos): one store per harness (so per server session), shared by
every agent there, stable decimal-string ids from `"1"`, full validation before
any mutation, defensive copies on every result, and cleared by `harness.reset()`
(ids restart at `"1"`). Their metadata lives in `core/metadata.ts` and their types
in `types/index.ts`.

```ts
const { tool, reset } = createProfileTool();    // also createChapterTool / createLocationTool
```

Shared action set (`RecordAction = 'add' | 'list' | 'get' | 'update' | 'remove'`);
`src/harness.ts` registers each tool as core, reserves its name, and calls its
`reset()`.

| Tool | `add` requires | Optional (default) | `update` mutable fields | Result extras |
|---|---|---|---|---|
| `profileManage` | `name`, `description` | `traits` (`[]`), `notes` (`''`) | name, description, traits, notes | `profiles`, `profile?`, `removed?`, `counts: { total }` |
| `chapterManage` | `title`, `summary` | `content` (`''`), `status` (`planned`), `order` (unset) | title, summary, content, status, order | `chapters`, `chapter?`, `content?`, `removed?`, `counts: { total, planned, draft, complete }` |
| `locationManage` | `name`, `description` | `notes` (`''`) | name, description, notes | `locations`, `location?`, `removed?`, `counts: { total }` |

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

## Preset tools

`src/tools/` ships eight presets: `syntaxCheck`, the five file tools (`fileRead`,
`fileWrite`, `fileEdit`, `fileList`, `fileGlob`), `commandRun`, and `gitDiff`. Each
is a standard `tool()` and each is executable standalone. R18: `fileRead`,
`fileWrite`, `fileEdit`, and `fileGlob` are **core**; `fileList`, `syntaxCheck`,
`commandRun`, and `gitDiff` remain **searchable**.

The folder is one file per tool, one folder per capability — `tools/syntax/`,
`tools/files/`, `tools/command/` — and the barrel exports both the named tools and
`presetTools`, the catalogue the harness preloads. Adding a tool means adding a
file, a `PRESET_TOOLS` row (`tools/catalogue.ts`), an `import()` branch in
`loadPresetTool`, and a line in the barrel; nothing else enumerates the catalogue.

**The exports are lazy.** `tools/index.ts` builds each named export with
`lazyTool(name)` (`tools/lazy.ts`) from `PRESET_TOOLS`: name, description, tags,
visibility and schema are eager metadata, while `execute` resolves the real
implementation through `loadPresetTool`'s `import()` on first call. Consequences:

- importing the package (or constructing a harness, or listing the server
  catalogue) loads no `node:fs`, `node:child_process`, or `node:vm`;
- the build emits one chunk per implementation next to the entry; `dist/` ships
  them all, and `inlineDynamicImports` must stay off;
- the proxy keeps the `Tool` contract exactly — writable `name`, `tags`
  normalized like `tool()`, callable directly, `execute(context)` delegated — so
  harness registration and the server's direct-call path are unchanged;
- a failed import clears the cache so the next call retries.

Every preset is tagged. The four core file tools are declared up front; the
searchable remainder (`fileList`, `syntaxCheck`, `commandRun`, `gitDiff`) waits for
`files`/`list`, `shell`, `git`, `python`, or `javascript`.

| Export | Call | Result |
|---|---|---|
| `syntaxCheck` | `({ code, language: 'javascript' \| 'python' })` | `boolean` |
| `fileRead` | `(paths: string[])` — non-empty | ordered `{ path, content }[]`; one bad path rejects the call |
| `fileWrite` | `(files: { path, content }[])` — non-empty | ordered `{ path, bytes }[]`; all validated first, duplicate targets rejected |
| `fileEdit` | `(edits: { path, oldString, newString, replaceAll? }[])` — non-empty | ordered `{ path, replacements, bytes }[]`; all preflighted before the first write |
| `fileList` | `(paths?)` — string or string[]; defaults to `["."]` | `string[]` of `dir/entry`, directories end with `/`; non-recursive |
| `fileGlob` | `({ patterns?, paths?, maxResults? })` | `{ files, truncated }` (filename mode) |
| `fileGlob` | `({ patterns?, paths?, content, maxResults? })` | `{ matches: [{ path, line, text }], truncated }` (content mode) |
| `commandRun` | `({ command, cwd? })` | `{ exitCode, stdout, stderr }` |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut }` |

Implementation notes worth keeping:

- **`syntaxCheck` never executes code.** JavaScript compiles with `node:vm`'s
  `Script` (parses, never runs; classic scripts only — `import`/`export` report
  false). Python pipes source to `compile()` through the interpreter, which also
  only parses. The two parsers are separate modules imported on demand, so a check
  in one language never loads the other's Node built-in.
- **The Python half needs a Python 3 interpreter.** Probes `python3` then `python`
  by exit status (the Windows Store `python3` shim exists but exits non-zero) and
  caches the answer. A missing interpreter **throws** — "false" must keep meaning
  "your code is wrong".
- **The four batched file tools declare ONE array property** (`paths` / `files` /
  `edits`), so the single-property rule hands `execute` the array itself. That is
  what makes `fileRead(['a', 'b'])` and a model call carrying
  `{ "paths": ["a", "b"] }` the same code path.
- **`fileWrite` / `fileEdit` preflight everything.** Every entry is shape-checked,
  every target must be unique **by real file identity** (`tools/files/identity.ts`:
  `realpath`, plus the nearest existing ancestor for a file that does not exist yet,
  case-folded only on Windows — so `notes.txt`/`NOTES.TXT` and symlink aliases are
  caught, while Linux keeps `a.ts`/`A.ts` as two files), and (for edits) every file
  is read and match-checked before the first byte is written, so one bad entry leaves
  every file untouched. A filesystem error during the write phase names the completed
  paths: there is **no transaction and no rollback**.
- **`fileEdit` is exact and guarded.** `oldString` must appear exactly once or
  `replaceAll: true` must be passed; a missing file is an error (use `fileWrite`
  for new files), and the result reports `replacements` and the new byte size.
- **`fileList` takes a directory array.** `fileList(['src', 'task'])` returns one
  flat list whose entries are prefixed with their directory (`src/a.ts`,
  `src/nested/`, `task/b.ts`); directories keep the trailing `/`. It stays
  **non-recursive** — `fileGlob({ patterns: ['**/*'] })` is the walking tool — and
  the default `paths: ["."]` returns bare entry names (the schema declares
  `default: ["."]`). `undefined`, `null`, `{}`, and a `{ "paths": [...] }` wrapper
  all normalize to that default in the implementation, because the server's
  direct-call route hands over the `parameters` object as-is; an explicit `[]` is
  still an error. Directories are visited in the caller's order, each listing sorted
  by code point, and a missing directory rejects the whole call (no partial result).
- **`fileGlob` is ONE tool with two modes**, discriminated by the presence of
  `content`: absent → `{ files, truncated }`, present → `{ matches, truncated }`.
  `patterns` default `['**/*']` and are OR-ed; a pattern with no `/` also matches
  file names at any depth, and a pattern is matched against a file path **relative
  to each root** (results are root-prefixed, never absolute-matched). `paths` default
  `['.']` and are walked in caller order; overlapping roots are deduplicated by root
  identity first (a symlink alias, or `src`/`SRC` on Windows, is walked once) and
  then files by resolved identity, with the first root winning the prefix; the cap is
  global. A non-object argument (a string or an array) is rejected instead of
  silently meaning "every file". `.git`, `node_modules`, symlinks, binaries, and
  files over 1 MiB are skipped in content mode; results default to 100 (clamped
  1–100) and set `truncated`; `.gitignore` is deliberately not read.
- **Content matching is time-bounded.** `content` is a JavaScript regex, and
  JavaScript regexes backtrack: `(a+)+$` blocks the process for seconds on a 31-byte
  line. `tools/files/bounded-regex.ts` therefore runs the match loop inside
  `node:vm` with a cumulative 2-second budget across the whole search (one context
  and one precompiled script per search, one call per FILE, so ordinary greps cost
  the same as before). Exhausting the budget throws a `HarnessError` that names the
  budget and the likely cause. It is a timeout, not a sandbox; an invalid pattern
  still fails in the host realm so the caller gets the parser's own `SyntaxError`.
- **`gitDiff` is the read-only git path.** A fixed argv with no shell, no colour,
  no external diff drivers, no textconv; `ref` may not start with `-`, and paths
  go after `--`. Non-zero exit is data, like `commandRun`.
- **No sandbox anywhere.** Paths resolve against `process.cwd()` and are used as
  given; `commandRun` and `gitDiff` run with host permissions. This matches other
  CLI harnesses: powerful by default, fenced by the process boundary the host
  provides. Say so loudly in docs.
- **Non-zero exit is data.** `commandRun` / `gitDiff` resolve with `exitCode`
  rather than throwing, so the model can read a failing command and react.
- `fileWrite` creates parent directories and returns the absolute path + byte
  count, because agents write into not-yet-existing directories constantly.

---

## Web search

`webSearch` is the one preset-shaped tool that is **not** in `presetTools`, and the
reason is the design: it needs a provider credential, and a credential belongs to
one harness. A module singleton would freeze the first key ever read and advertise
a network tool the host may not be able to authenticate.

**Factory, not catalogue entry.** `createWebSearchTool({ env?, exa?, tavily? })`
(`tools/websearch/index.ts`) resolves keys **once, at construction** (a getter is
not re-read per search; there is no rotation), and returns
`Tool<WebSearchParameters, WebSearchResult> | undefined`. `undefined` is not an
error: it means no provider has a usable key, and that is also what makes
`websearch: true` a no-op on a keyless host.

| Input | Result |
|---|---|
| absent / `false` | no tool |
| `true` / `{}` | read `EXA_API_KEY` / `TAVILY_API_KEY` from `process.env` |
| `env: {...}` | same, from an injected snapshot (tests, deploy) |
| `exa.apiKey` / `tavily.apiKey` | explicit string or getter (called once), wins over env |
| explicit blank key | that provider is off, **without** falling back to env |
| no provider with a key | `undefined` |
| configured `tools.webSearch` | wins; the factory is not consulted |

harness.ts registers the result after configured tools and before the reserved-name
check (so a preset or plugin cannot claim the name first), and only when
`configuration.websearch` is truthy (the field keeps its name) and no custom `webSearch` exists. **A configured
`webSearch` is core (R18)**: it is declared on every request, so the model calls it
directly instead of spending a toolRequest round. Registration is still conditional
on a usable key, so a keyless host neither declares nor lists a runnable search
tool. Keys live in the tool closure: two harnesses never share one, and nothing
enters the schema, arguments, result, events, `RunnerSettings`, the UI, or a client
payload.

**Catalogue visibility (C1).** `harnesses/websearch.ts` always produces an entry
for the direct-call catalogue. `createWebSearchCatalogueEntry()` calls the factory
at run time and returns `{ entry, tool? }`:

| Host state | Catalogue result |
|---|---|
| `EXA_API_KEY` / `TAVILY_API_KEY` present | entry + executable tool; `availability: { state: 'available', environment: [...] }` |
| no usable key | entry with `WEB_SEARCH_METADATA` and no `tool`; `availability: { state: 'unconfigured', environment: [...], hint }` |

`harnesses/index.ts` exports `createToolCatalogue(options?)` instead of module-level
`catalogue`/`allTools`. The factory is what makes startup ordering safe: the server
and CLI load `.env` after their imports, then build the catalogue, so the key is
captured once for the handler's lifetime (never at module evaluation). `websearch`
is group `'Web search'`; existing groups and the CLI column layout are unchanged.
`GET /api/tools` sends the optional `availability` field; `POST /api/tools/webSearch`
executes the injected tool when configured and returns `{ ok: false, error }` with
the hint when not. No path echoes a key value — the hint carries variable names
only.

**Wire contracts** (fixed endpoints, keys in headers only):

- Exa — `POST https://api.exa.ai/search`, `x-api-key`, body
  `{ query, type: 'auto', numResults, contents: { highlights: true } }`, response
  `results[{ title, url, highlights: string[], publishedDate? }]`.
- Tavily — `POST https://api.tavily.com/search`, `Authorization: Bearer`, body
  `{ query, max_results, search_depth: 'basic', include_answer: false,
  include_raw_content: false }`, response `results[{ title, url, content,
  score?, published_date? }]`.

`numResults` / `max_results` are always set explicitly: the provider default must
not decide the tool's context cost. `score` is ignored; highlights are joined into
one snippet.

**Bounds** (`tools/websearch/request.ts`): 5 results by default, 20 maximum
(clamped), 300-character title, 1,000-character snippet, 512,000-character response
(content-length then post-read), 15 s timeout via `AbortController` cleared in
`finally`, `redirect: 'error'`, http(s)-only result URLs. Rows without a valid URL
are dropped, not fatal; the first row's title falls back to its URL.

**Cost policy:** one request, no retry, no failover, one provider. Exa when both
keys exist, Tavily when it is the only one, `provider` overrides only when more
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
`HarnessError`, and `request.ts`; `exa.ts` / `tavily.ts` are `import()`ed inside
`execute`. No SDK: both adapters use `fetch`. A failed import is a plain tool error
and is not cached, so a later call can retry.

**Application wiring:** the live presets (`instruct`, `research`, `workspace`)
pass `websearch: true`, so the CLI and server read search keys from their own
process environment; the shared-factory `flaky` example opts in too, while
`demo` stays offline. `flaky`'s preset metadata declares `environmentTools:
['webSearch']` so its descriptor matches what the factory registers.
This is why no search key was added to `RunnerSettings` or the Endpoint panel. The
app entry points preload the package-root `.env` into `process.env` (see “CLI,
server, and UI”); the library still has no autoload and importing it never reads a
file.

**Preset descriptors follow the catalogue.** Those live presets also declare
`environmentTools: ['webSearch']` in `harnesses/presets.ts` — metadata only, no
harness is built to answer a listing. `describeHarness` appends such a name to the
preset's `tools` only when the runtime catalogue holds an executable definition for
it, and includes it in `coreTools` under the same condition (R18). A keyless host
therefore advertises neither a callable webSearch nor a core webSearch; the global
catalogue still shows the tool as unconfigured with its hint. Core file tools in
`coreTools` are likewise filtered by the preset's registered names, so the demo
fixture (timeNow only) does not claim them.

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
  registered tool is rejected ("fileread" cannot shadow "fileRead"), and a harness
  may create at most **32** tools (`MAX_CREATED_TOOLS`). The model path returns the
  failure as a tool result; the host path throws.
- **Registered searchable and enabled immediately**, so the next turn can call it
  without a second toolRequest round. It stays in the searchable catalogue afterwards.
- **Session-local, no persistence.** Created tools live in that harness's registry
  only; nothing is written to disk, two harnesses cannot see each other's tools,
  and a restart starts clean. `reset()` keeps them registered but clears the
  enabled set (discovery is conversation state).
- **No sandbox.** The body is compiled with the host realm's `Function`
  constructor and runs with the process's full permissions — the same trust model
  as `commandRun`. Nothing here isolates filesystem, network, or processes.

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
  removed. An empty list (or a one-agent harness) means no `agentDelegate` tool at all.
- The primary receives a core `agentDelegate({ agent, input })` tool whose description
  lists the allowlist and whose `agent` parameter is an `enum` of it.
- **Each agent keeps its own `instruction`(s) and transcript.** A subagent never
  sees the primary's conversation; `run(target, input)` returns only the final
  `content`, and that `{ agent, content }` is what the tool result carries back.
- **One level deep, cycle-safe.** `agentDelegate` is not declared to subagents, a
  guessed call from a subagent is rejected in `executeToolCall`, and the delegate
  implementation refuses when the caller is not the primary or when `runStack`
  shows a nested run. `runAgent` refuses to re-enter an agent already on the
  stack, which also closes `ctx.run` cycles.
- `ctx.run(name, input)` inside a tool still runs a full sibling turn; it is the
  tool-side path (used by the `textSummarize` harness tool) and is not model-visible
  delegation.
---

## harness

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    tools: { webSearch: tool({...}) },
    report: { progress: async (event) => {} }
});

await writer('tell me about new year');
```

- **Callable.** `writer(input)` runs the entry agent to completion.
- **The entry agent is explicit or first.** `primary` names it; without one, the
  first `agents` key wins, so a single-agent config needs nothing. An unknown name
  throws at construction.
- **`subagents` is the delegation allowlist.** Defaults to every agent except the
  primary; must not contain the primary or an unknown name; empty means no
  `agentDelegate` tool. See [Delegation](#delegation).
- The registry key is the identity for both agents and tools; `agent.name` /
  `tool.name` are overwritten to match.
- **Tool declarations are filtered, not the registry.** `writer.tools` holds the
  preset preload, the configured tools, `toolRequest`, `toolCreate`, `todoManage`,
  `profileManage`, `chapterManage`, `locationManage`, and `agentDelegate` when
  there is a subagent; a request declares every core tool
  (`fileRead`/`fileWrite`/`fileEdit`/`fileGlob`, a configured `webSearch`, and the
  harness-owned set), then whatever toolRequest enabled. The searchable remainder
  (`fileList`, `commandRun`, ...) waits for discovery. `agentDelegate` is core for
  the primary only.
- **`discoveredTools`** is a read-only copy of the enabled set, in discovery order.
  It persists for the harness's lifetime (every call/turn) and is emptied by
  `reset()`; a server snapshot records it so a reload can show it.
- **`executeTool(name, parameters)`** (R8) runs one REGISTERED tool directly with
  this harness's context (`agent: primary`, `agents`, `run`). It is the server's
  manual-execution path for the session-bound tools (`POST /tools/:name` with a
  `sessionId`), so a manual toolRequest/toolCreate/todoManage/profileManage/
  chapterManage/locationManage/delegate call mutates
  this session. Core file tools and webSearch are ordinary direct-call catalogue
  entries and do not need a session. Discovery gates the MODEL only: an explicit
  operator call may run a searchable tool that was never enabled. Nothing else is bypassed — `toolCreate` keeps its guarded
  registration, `agentDelegate` keeps its primary-only check, and a name this harness
  did not register (delegate without subagents) throws instead of inventing an
  implementation. No progress events are emitted: a manual call is not a turn.
- `presets` (default `true`) preloads `presetTools` into the registry. `false`
  starts from `tools` alone. A configured tool wins on a name collision.
- `plugins` remains as an optional programmatic extension point
  (`createAgent`, `addTool`). It is not part of the declarative config shape, and
  a plugin-added tool is searchable like any other. The reserved names stay
  reserved for plugins too.
- `reset()` clears the entry agent's conversation, the discovered-tool set, the
  session todo list, and the three record stores, so a reset run starts from the
  core set and empty session state.
  Created tools stay registered (registry state), just no longer enabled. The
  server resets every agent in a session, not only the primary; its extra
  agent-loop reset does not replace `harness.reset()`, which is what clears the
  shared `todoManage` and record state.

**Members:** callable, `name`, `agent`, `agents`, `subagents`, `tools`, `plugins`,
`discoveredTools`, `toolCreate(config)`, `executeTool(name, parameters)`, `reset()`.

### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    no tool calls?         -> report done, return the message
    run each tool          -> append a tool message
    (loop again)
```

The tool declarations sent with each `turn()` are the core set plus the tools
toolRequest has enabled — that is how a discovery round changes the next request
without mutating the registry.

Recoverable failures become tool results the model can read:
- unknown tool → result listing the declared tools and pointing at toolRequest;
- undiscovered tool → result naming tags that would enable it (it does not run);
- malformed JSON arguments → result naming the parse failure (the tool is not
  executed);
- throwing tool → result with the error message.

Terminal failures truncate history to the pre-call length, emit `error`, and
throw:
- transport failure;
- more than **maxIterations** tool rounds without an answer. Defaults to **16**
  (the library guard); `harness({ maxIterations })` raises or lowers it and is
  validated at construction as a positive safe integer. The application presets
  pass 1000 for real sessions; the offline `demo` keeps the default. The bound is
  per agent run, so a delegated subagent gets its own budget.

Multi-tool turns are executed **sequentially in model order**, and every call
gets a matching `tool` message so strict providers never see a dangling
`tool_calls` id.

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
  `chunk.error` on a 200 stream, a malformed frame, or a connection failure.

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
- The server calls it with a 10 s abort (`POST /api/models`) because it owns the
  key and the browser cannot call the provider (no CORS, no key). Nothing is
  persisted or logged.

---

## HarnessEvent

```ts
| { type: 'start';       agent: string; model: string }
| { type: 'text';        agent: string; delta: string }
| { type: 'reasoning';   agent: string; delta: string }
| { type: 'tool_call';   agent: string; call: HarnessToolCall }
| { type: 'tool_result'; agent: string; name: string; callId?: string; content: string; isError: boolean; ui?: ToolUiPanel[] }
| { type: 'usage';      agent: string; usage: HarnessUsage }
| { type: 'done';        agent: string; message: HarnessAssistantMessage }
| { type: 'error';       agent: string; error: { message: string } }
```

Delivered through `report.progress`, which is **awaited** for every step, so a
slow reporter paces the run. Every event names its agent. `tool_result.callId` is
optional for compatibility and is always populated by the harness: it is the id of
the `tool_call` the result answers, which lets a client pair two same-name calls
exactly instead of positionally. `ui` is the optional declarative panel list from
`toolUi()` (see “Declarative tool panels” below); the model never sees it.

`usage` is emitted once per **model request**, including the tool rounds that keep
a run going — `done` only ever reports the final request, so this is the only
per-request feed a client can tally. It is absent when the provider reported no
usage block for that request. The server folds every one of them into
`SessionTurn.usage` (subagent requests included) and repeats the running sum on
each SSE frame; the UI prints it next to the turn's elapsed label as
`input (cached)`, e.g. `122,111 (100,301)`.

## HarnessMessage

```ts
| { role: 'system'; content }
| { role: 'user';   content }
| { role: 'assistant'; content; toolCalls?; reasoning? }
| { role: 'tool';      content; toolCallId; name }
```

`HarnessToolCall` is `{ id, name, arguments }` where `arguments` stays a raw JSON
string — malformed JSON is the harness's problem to report, not a parse crash.

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

## ToolVisibility / ToolSearchResult

```ts
type ToolVisibility = 'core' | 'searchable';

type ToolSearchResult = {
    enabled: string[];                  // ranked; also what the next turn declares
    tools: { name: string; description: string; tags: string[] }[];
    remaining: number;                  // matched but excluded by the five-match cap
    unmatchedTags?: string[];           // query tags that matched nothing
    availableTags?: string[];           // vocabulary, when nothing matched
    truncated?: boolean;                // remaining > 0 (compatibility mirror)
};
```

`searchTools()` returns the same shape as a `toolRequest` call, so a UI can rank a
catalogue without a harness.

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
  envelope. `server/sessions.ts` copies events as before, so SSE and the recorded
  turn keep the panels and `eventTimes` stays a parallel array with the same
  length/order.
- **Manual calls unwrap.** `server/api.ts` projects `ToolCallResult.result` to the
  content and adds optional `panels` (session-bound and direct paths alike).
- **Safety bounds.** `slot` is an open string (`right` is the default mount, with
  `center`/`left` available to the UI); panels are data only (no HTML/JS/actions).
  Normalization caps 32 panels, 64 blocks/panel, 100 table rows, 20 columns, 100
  key/value items, bounded text/cell/label lengths, and a 256 KiB total; malformed
  panels/blocks are dropped, non-string cells blanked/padded, and oversized
  panels dropped whole.
- **Demonstration.** `harnesses/tools.ts` `timeNow` returns a right-slot key/value
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
- **Tags are required, scored, and capped.** A tool without tags could never be
  found, so construction rejects it. Ranking is OR-style best-match (a tool's rank
  is its strongest single-tag hit; hit count only breaks ties), deterministic
  (score, hits, name), and capped at five matches — default AND maximum —
  because discovery exists to save context; the excluded tail is reported only as
  `remaining`. A caller may ask for fewer, never more.
- **Presets are lazy proxies, not implementations.** `src/tools/index.ts` exports
  callable `Tool`s whose metadata is static and whose body is a dynamic import.
  Building a harness, listing the catalogue, or ranking a preset therefore never
  loads `node:fs`/`child_process`/`vm`. The trade-off is build coupling: the dist
  must ship the per-tool chunks and must not inline dynamic imports.
- **Created tools are compiled, not run, at registration.** `createDynamicTool`
  validates the shape and compiles the body with the host realm's `Function`
  constructor; execution happens only on call. The harness adds reserved names, a
  case-insensitive collision check, and a 32-tool budget. It is session-local
  (no disk, no persistence) and **unsandboxed**.
- **Delegation is one level deep by construction.** `agentDelegate` is core for the
  primary only, is never declared to subagents, is rejected if a subagent guesses
  it, and `runAgent` refuses to re-enter a running agent. Each agent keeps its own
  instructions and transcript; only the answer crosses back.
- **Undiscovered tools do not run.** Executing a tool the model was never
  declared would make toolRequest optional in practice. Instead the call comes back
  as a tool result naming the tags that would enable it, which is recoverable and
  still teaches the model the vocabulary.
- **Preload the catalogue, declare only the core.** Shipping the presets into
  every harness by default stays cheap: only the four core file tools are declared
  up front, alongside toolRequest/toolCreate/todoManage/profileManage/
  chapterManage/locationManage (and delegate when
  applicable), while the searchable remainder costs no context until discovered.
  `presets: false` exists for callers who want an empty catalogue, which is also
  what the harness tests use when they assert exact discovery results.
- **Session state is factory state, not module state.** Todos, profiles, chapters,
  and locations each get one closure per harness with its own id counter, so two
  sessions never share records and `reset()` is a complete "start over" that no
  module singleton could express.
- **A model is a per-request choice, so it is editable live.** The harness always
  reads an agent's model when it starts a request (`requestModel` in
  `src/core/agent.ts`), which is what lets `PATCH /sessions/:id` retarget an agent
  without rebuilding anything: the in-flight request and the message it commits
  keep the model they started with, and the next request uses the new one.

## CLI, server, and UI

The app is split so the harness has **no UI dependency**. `src/` stays the
published library; the three entry points are consumers of it.

- **CLI (`cli/`)** runs a preset in-process: one-shot from argv/stdin, or an
  interactive session on a TTY. It renders `HarnessEvent`s directly with
  `cli/render.ts`, or emits one JSON object per line with `--json`. `--serve`
  switches to the HTTP server. The CLI never imports the UI.
- **Environment (`server/environment.ts`)** loads the package-root `.env` from
  `cli/index.ts` (before `settingsFrom`) and from the top of
  `startHarnessServer()` (which `playground/dev.ts` uses), via `dotenv` as a
  devDependency. The path is module-relative, `override: false` keeps shell values
  (including empty ones) authoritative, a missing file is a no-op, and
  `quiet: true` prevents startup logging. It must run before harness construction
  because search keys are captured there. `src/` never imports it.
- **Server (`server/`)** owns HTTP and sessions, not harness policy. Routing and
  validation live in transport-neutral `api.ts`; `handler.ts` is only the Node
  adapter for `/api` (client header, streamed body bound, SSE writer) and
  `service.ts` the `@underload/service` adapter for `/v1/harness` (Origin gate,
  content-length/serialized body bound, raw SSE `Response`). `SessionStore` keeps
  one `Harness` per session and owns each run's `SessionTurn`s plus the FIFO task
  queue, so a second task continues the conversation in order, a reload can replay
  the transcript from `list()`/`get()`, and a watcher can reattach through
  `watch()`. `static.ts` serves `playground/dist`; `playground/dev.ts`
  starts the standalone server and proxies Vite's `/api` to it. There is no CORS
  in either standalone mode: the UI is same-origin in production and proxied in
  development.
- **Service host (`endpoint/` + `server/service.ts`)** is the same API on the
  repository's Hono gateway. `@underload/service` scans the repo root for
  `endpoint`/`endpoints` folders and imports every `service-route*.ts` default
  export; `endpoint/harness/service-route.ts` registers `/v1/harness/*` and
  `service-route-root.ts` registers the bare `/v1/harness` (a wildcard does not
  match the bare path). Neither declares a `port`, so both run on the gateway's
  single listener — no worker server, no 307, no second port. `server/runtime.ts`
  builds one shared store/catalogue lazily on the first request (`.env` loaded
  there, never at import). The bootstrap document's `rootPath` is the canonical
  API URL (`/v1/harness`), not a filesystem root: file tools resolve against
  `process.cwd()` and have no sandbox, so advertising a workspace root would be a
  lie. `variables.root` is the service's database boundary, not a workspace.
  The loader's permissive CORS means `X-Harness-Client` is not a boundary there;
  instead the adapter rejects a browser `Origin` that is neither the request host
  nor loopback (`localhost`, `127.0.0.1`, `[::1]`), and allows requests with no
  `Origin`. That is not authentication: the service binds `0.0.0.0`, so anyone
  who can reach the port is trusted, and the tools are unsandboxed. Prefer a
  loopback host for the service when the port is reachable from untrusted
  networks; this package changes no global host/CORS setting.
- **Catalogue (`harnesses/`)** holds the presets and harness-level tools shared by
  the CLI and server. Presets are factories because a harness bakes its transport
  at construction. `toolbox.ts` owns the one shared toolbox and the factory every
  live preset uses, so `instruct`, `research`, and `workspace` register the same
  tools and differ only in agents/instructions/routing. `demo` uses the scripted
  transport, needs no endpoint, and keeps a timeNow-only registry as a documented
  template exception; `flaky` is the shared toolbox plus the intentional failure
  tool (excluded from the shared set because it fails on purpose). Every template is
  editable (R20.1): the registry copies it, metadata-only patches preserve the
  captured factory, and an executable patch upgrades demo to a live profiled
  harness / rebuilds flaky with `testFlaky` retained. Every preset
  names its `primary` explicitly (single-agent presets have no subagents, so no
  `agentDelegate` tool); `research` declares `subagents: ['summarizer']`, and every
  agent keeps its own instruction. `harnesses/index.ts` exports
  `createToolCatalogue`, which snapshots the lazy `presetTools` metadata plus the
  harness tools plus the runtime `webSearch` entry; it never executes or imports an
  implementation. `findPreset` resolves the legacy ids (`writer`/`assistant` →
  `instruct`, `researcher` → `research`) without listing duplicate cards. The
  server calls the catalogue builder after `loadEnvironmentFile()` and injects the
  result into the handler; the CLI calls it from `--tools`/`/tools`, which run
  after the same load.
- **UI (`playground/`)** is only a client. It resolves its API root at runtime
  (`?apiRoot=` → `window.__HARNESS_CONFIG__.apiRoot` / meta tag → build-time
  `VITE_HARNESS_API` → `/api`), then lists presets/tools, creates sessions,
  enqueues tasks (`POST /tasks`, `202`), and observes the session's queue through
  one `GET /events` watcher while work is pending (polling fallback). Runtime
  absolute roots must be the
  page's own origin or loopback (`server/origin.ts`, shared with the service
  Origin gate) because the saved provider key is posted to that root;
  `VITE_HARNESS_API` is operator-controlled and deliberately trusted across
  origins. It imports no harness code and no `node:` built-ins, which is why
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
  permanently. `playground/src/rail-toggle.test.ts` pins the DOM of this contract.

### API

`/api` is the standalone mount; the `@underload/service` host serves the same
paths below `/v1/harness` **plus** the bare root:

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness and session count |
| `GET /api/harnesses` | Harness descriptors (`primary`/`subagents`/`coreTools`/`agentModels?`/`builtin`/`editable`), provider defaults, and `agents`; every entry is editable and `editable` is always `true` |
| `POST /api/harnesses` | `{ name, title?, description?, primary, subagents?, agentModels? }` → `201 { harness }` |
| `PATCH /api/harnesses/:name` | `{ title?, description?, primary?, subagents?, agentModels? }` → `{ harness }`; every template is patchable |
| `GET /api/agents` | Trusted agent registry (`AgentDescriptor[]`) |
| `GET /api/tools` | Full catalogue: session-bound core entries first (`group: 'Core tools'`, `sessionBound: true`), then every direct-call tool (including the core file tools); `webSearch` always present with `availability` |
| `GET /api/tools/bootstrap` | Alias of `GET /api/tools` — the list the root bootstrap document carries |
| `POST /api/tools/:name` | `{ parameters, sessionId? }` → `{ ok, result | error, durationMs }`. A `sessionBound` core tool requires `sessionId` (`400` without, `404` unknown session or unavailable tool, `409` while the session is busy - a run, reset, or another manual call) and executes inside that session's harness; a direct-call tool is unchanged and ignores `sessionId` |
| `POST /api/tools/:name/call` | Alias of the row above (verb-named spelling), same dispatcher |
| `POST /api/models` | `{ settings? }` → `{ models: string[] }`; server-side `listModels` |
| `POST /api/sessions` | `{ harness, settings? }` → `{ session }` |
| `GET /api/sessions`, `GET /api/sessions/:id` | Snapshots, always including `turns` (with `eventTimes`) and the frozen `harnessDefinition`; `model`/`agentModels` are LIVE; `queueDepth` counts pending turns and is omitted at zero |
| `PATCH /api/sessions/:id` | `{ agentModels: Record<agent, model> }` → `{ session }`. Merges into the live map, validates every key against the session's agents and every value as a model id (400 with nothing applied), rejects `{}` as a no-op, is allowed while the session is busy (no abort/rebuild), and leaves `harnessDefinition` frozen. The current request keeps the model it started with; the next request uses the new one |
| `POST /api/sessions/:id/messages` | `{ input }` → SSE. LEGACY: the response owns the run (close aborts it); `409` when busy or when queued work is pending |
| `POST /api/sessions/:id/tasks` | `{ input }` → `202 { session, turn }`. Server-queued FIFO task: the turn is `queued`, has a stable id/index, and has no `startedAt` until the pump starts it. Cap 100 pending (`429`); in-memory only |
| `GET /api/sessions/:id/events` | SSE watcher: one `snapshot`, `turn` upserts (queued/running/terminal), `event` frames, one final `snapshot` on drain. Disconnect only unsubscribes |
| `POST /api/sessions/:id/reset` | Reset every agent + discovery + todos + record stores; `409` while a run or queued work is pending |
| `POST /api/sessions/:id/cancel` | `{ all?: boolean }` → `{ cancelled }`. Default aborts the active run only; `all: true` also cancels every queued turn, which stays in `turns` as `cancelled` |
| `DELETE /api/sessions/:id` | Forget the session: abort active work, drop queued work, close watchers |
| `GET /v1/harness` | Service only: bootstrap `{ rootPath, presets, agents, tools, defaults, sessions }` |

`/api/presets` and `/v1/harness/presets` are aliases of `/harnesses` and accept only
`GET`; create/patch live on the canonical `/harnesses` mount. The `/api` root stays
a 404 (no bootstrap document) — that legacy contract is unchanged. `rootPath` in
the canonical document is the API URL (`/v1/harness`), not a filesystem path.

**Body policy (both mounts).** Action endpoints require a JSON object; `null`,
arrays, and primitives are `400`. `POST /tools/:name` requires a `parameters`
property, so an empty body cannot run a tool — `{ "parameters": {} }` is the
explicit argument-less call. Bounds: the Node adapter stops a streamed body over
1,000,000 bytes with `413`; the service adapter checks declared `content-length`
and the serialized parsed body before dispatch. The service loader parses JSON
before the endpoint runs, so it cannot prevent that upstream allocation and a
parse failure arrives as `{}` — a documented residual, not something this package
can fix.

**Core tools in the catalogue (R8).** `harnesses/core.ts` adds six entries —
`toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`,
`locationManage` — plus `agentDelegate` to every listing
(`GET /tools`, its `/tools/bootstrap` alias, and the root bootstrap document). They
are `group: 'Core tools'`, `visibility: 'core'`, and `sessionBound: true`, and they
deliberately have **no** `tool` implementation: there is one implementation of each
(the session's harness). `SessionStore.callTool(id, name, parameters)` →
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

**R18: core file/search tools are NOT session-bound.** `fileRead`, `fileWrite`,
`fileEdit`, `fileGlob`, and a configured `webSearch` are `visibility: 'core'` but
keep their real `tool` implementation and appear in the direct-call catalogue
(groups `Package presets` / `Web search`), so `POST /api/tools/fileRead` works
without a `sessionId`. `sessionBound: true` remains exclusive to the six
harness-owned entries above plus `agentDelegate`. The UI's core dropdown reads
`coreTools` from the descriptor, which is computed from the registered names and
therefore includes the file tools, adds `webSearch` only when this host resolved a
key, omits `fileList` (and the other searchable tools), and matches the harness's
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

`SessionStore` (`server/sessions.ts`) owns the queue; no response does.

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
- **Status.** `SessionStatus` remains `idle | running | error`; queue state is
  `SessionTurn.status` (`queued | running | done | error | cancelled`) plus
  `SessionSnapshot.queueDepth` (pending turns, active excluded, omitted at zero).
  A cancelled turn keeps its row/events (`updatedAt` moves, no `startedAt` for a
  never-started one), so a reload shows what was stopped.
- **Gates.** `reset`, `callTool`, and the legacy `/messages` reject while `busy` or
  while the queue is non-empty (`409`); Delete/`dispose()` aborts the active run,
  discards pending work, settles its `enqueue()` completions, and closes watchers
  without waiting. `PATCH /sessions/:id` stays the exception: it is accepted while
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

### Agents and the harness registry

`src/agents/` is the trusted catalogue: one `AgentProfile` per agent with `name`,
`title`, `description`, `instruction`, and `guidelines`. `agentInstruction()`
composes the profile into the seeded system messages (`[instruction, 'Guidelines:\n- …']`),
and the application builds agents with `agent({ model, instruction: agentInstruction(profile), provider })`.
Nothing in a profile is secret, and a client cannot supply one.

`harnesses/registry.ts` is the in-memory harness registry shared by the store and
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
- `update()` changes `title`/`description`/`primary`/`subagents`/`agentModels` for
  **every** entry (there is no 403/read-only branch; `editable` is a compatibility
  wire field, always true). It **replaces** the preset object instead of mutating
  it. A metadata-only patch keeps the captured factory (demo's script, flaky's
  `testFlaky`); an executable patch (primary/subagents/agentModels) rebuilds from
  the `template`: `scripted` upgrades to a live profiled harness and corrects
  `requiresEndpoint`/`tools`/`environmentTools`, `flaky` rebuilds the live toolbox
  with the extra retained, and `live` uses `createProfiledHarness`. Changing
  `primary` without restating `subagents` removes the new primary from the old
  allowlist;
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
- unknown names are 404; duplicate names are 409; everything else is 400. No
  registry failure is a 403.

Semantic validation lives in the registry; the dispatcher rejects unknown body
fields, so `instruction`, `tools`, or `provider` cannot be smuggled into a
create/patch request. `agentModels` is the single model-shaped field: it selects an
id, never credentials. The registry is **in memory only**: there is no delete and no
persistence, so a restart restores the shipped catalogue.

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
- **Sessions live in memory.** Restarting the server is a clean slate. Persistence
  is still on the roadmap; this is intentionally the smallest useful session model.
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
  single `mergeSettings` (`server/config.ts`) serves `POST /models` and
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

### Scripts

```bash
yarn start                # API + UI end-to-end
yarn cli "task"           # one-shot, default demo preset
yarn cli                  # interactive
yarn serve                # API + built UI (build the UI first)
yarn dev:playground       # same as start
yarn preview:playground   # built UI, proxies /api to :5181
yarn test                 # library + server tests
yarn start-service        # repo root: @underload/service host, /v1/harness on :5000
```

`server/server.test.ts` drives the real HTTP server with the scripted demo: create
a session, stream a task, continue it, reset it, call a tool directly, and check
the error statuses. The UI build no longer needs a package alias, so
`playground/dist` is a plain client bundle.


## Not built yet

In the order they are expected:

1. **streaming tool output** — `execute` cannot report progress mid-call yet.
2. **session persistence** — the server keeps sessions and their task queue in
   memory; restarting loses both.
3. **compaction** — history pruning before context limits.
4. **per-agent tool scoping** — searchable tools are catalogued once; every agent
   can discover every searchable tool (only `agentDelegate` is primary-only).
5. **parallel tool execution** — calls run sequentially today.
6. **sandboxed presets and created tools** — the file and command tools, and any
   `toolCreate` body, run with host permissions; a `root`-scoped/fenced variant
   would be the natural next step.
7. **persisting created tools** — they live and die with the harness instance.
8. **more presets** — `fetchUrl` and a patch/multi-edit tool are the obvious gaps.

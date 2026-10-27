# @underload/harness Knowledge

Plugin-first CLI agent harness. `agent` is the brain, `tool` is an action, `harness` is the loop.

> **Last verified:** 2026-10-28
> **Package name:** `@underload/harness`
> **Dependencies:** none (Node 18+ — default transport uses global `fetch`)
> **Workspace consumers:** none yet

---

## How to Update This File

1. Read `src/harness.ts` for the public barrel and the loop
2. Check `src/core/agent.ts`, `src/core/tool.ts`, `src/core/discovery.ts`,
   `src/core/creation.ts`, and `src/transport/openai.ts` + `src/transport/models.ts`
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
  harness.creation.test.ts    createTool behaviour, next to the loop
  harness.delegation.test.ts  primary/subagents + delegate, next to the loop
  core/
    index.ts            barrel: agent, tool, searchTools, compileToolSource, createDynamicTool
    agent.ts            the brain
    agent.test.ts
    tool.ts             an action the model can request, or you can call
    tool.test.ts
    discovery.ts        tag ranking behind getTools
    discovery.test.ts
    creation.ts         validate + compile a tool from an async function body
    creation.test.ts
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
      javascriptSyntax.ts
      pythonSyntax.ts
    files/
      index.ts
      readFile.ts
      writeFile.ts
      editFile.ts
      listFiles.ts
      searchFiles.ts
      globFiles.ts
      glob.ts           shared walker (searchFiles + globFiles)
      *.test.ts
    command/
      index.ts
      runCommand.ts
      gitDiff.ts
      *.test.ts
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
  handler.ts            routing, validation, SSE
  sessions.ts           in-memory session store
  config.ts             provider defaults from the environment
  protocol.ts           client/server wire types
  static.ts             playground/dist serving
harnesses/
  index.ts              presets + tool catalogue used by CLI and server
  presets.ts            demo, writer, assistant, researcher, flaky, workspace
  tools.ts              clock, wordCount, roll, searchNotes, summarize, flaky
  demo.ts               scripted offline transport
  types.ts              RunnerSettings, HarnessPreset, CatalogueEntry
playground/
  dev.ts                starts the API and Vite with an /api proxy
  src/main.ts           UI client: sessions, SSE, direct tool calls
  src/api.ts            fetch + SSE parser
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
- [Tool discovery](#tool-discovery) — Tags, visibility, getTools, and the ranking
- [createTool](#createtool) — Runtime tool creation from an async function body
- [Delegation](#delegation) — Explicit primary/subagents, one level deep

### Preset Tools
- [Preset tools](#preset-tools) — the ten lazy presets, executable on their own

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

---

## Design Split

| Layer | Owns | Must not own |
|---|---|---|
| `agent` | model, instruction, history, one transport call per turn | tool execution, compaction, planning |
| `tool` | description, JSON Schema, one `execute` function | state, retries, policy |
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
const pythonSyntax = tool<string, boolean>({
    description: 'Check Python syntax.',
    tags: ['code', 'syntax', 'python'],
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    execute: ({ parameters: code }) => parses(code)
});

await pythonSyntax('print(1)');                  // direct: no harness, no agent
harness({ tools: { pythonSyntax } });            // the model calls it
```

- `name` is optional (default `'tool'`). **A harness overwrites it with its
  registry key**, which is the name the model calls.
- `tags` is **required** (at least one, else construction throws). Stored trimmed,
  lowercased, and deduplicated by `normalizeTags()`, so discovery compares
  normalized values on both sides.
- `visibility` is `'core'` or `'searchable'`, default `'searchable'`. An unknown
  value throws. Core tools are declared on every request; searchable tools wait in
  the catalogue for getTools.
- `parameters` is plain JSON Schema. TypeBox output *is* JSON Schema, so a
  `Type.Object({...})` can be passed directly — this package needs no schema
  dependency to interop with the rest of the workspace.
- **Single-property rule.** `execute` receives the single property's *value* when
  the schema declares exactly one property, and the whole object otherwise. This
  is what makes `pythonSyntax('...')` and a model call carrying
  `{ "code": "..." }` identical inside the implementation. The harness applies it
  via `unwrapParameters()` → `toolParameterKey()`.
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

## Tool discovery

The rework that keeps a large catalogue out of the context window. A request
declares:

- every `visibility: 'core'` tool, and
- every searchable tool that getTools has enabled.

**Every harness preloads the preset catalogue** (`src/tools/`) unless it is
created with `presets: false`. The presets are all searchable, so the preload adds
catalogue entries and no context: a model that needs files asks for `files`, and
readFile/writeFile/editFile/searchFiles/globFiles appear on the next turn. A
configured tool replaces a preloaded preset of the same name.

**getTools is built by the harness**, not shipped in `src/tools/`. It has to be:
it closes over the live registry and the harness's active set. It is registered
after the declarative tools and before plugins, is always core, and its name is
reserved (`harness()` throws if the config or a preset already has `getTools`).
`createTool` and (when subagents exist) `delegate` are reserved the same way.

- Signature: `getTools({ tags: string[], limit?: number })` — two properties, so
  the single-property rule hands `execute` the parsed object. A bare array or a
  missing `tags` is tolerated and treated as `[]`, so a malformed call still
  returns the vocabulary.
- Result: `{ enabled, tools: [{ name, description, tags }], unmatchedTags?,
  availableTags?, truncated? }`. `enabled` doubles as the ranking order.
- `searchTools(tools, tags, limit?)` (`core/discovery.ts`) is the pure ranking and
  is exported from the package root so a UI or a test can reuse it. Only
  `visibility: 'searchable'` tools are candidates — core tools are already declared.
- Scoring is **OR-style, best-match**: each query tag scores a tool (exact tag 4,
  tag prefix 3, tag contains query 2, query contains tag 2, name/description
  contains query 1), and the tool's rank is its **best single-tag score**. More
  matching tags only breaks ties (then name), so breadth can never outrank an
  exact hit. Prefix needs two characters, fuzzy needs three.
- `DEFAULT_MAX_MATCHES = 10`, hard maximum **50** (`resolveLimit` clamps, floor).
  `truncated: true` when more matched. Results sort by best score, then hit count,
  then name, so the cap is deterministic.
- `availableTags` (the sorted vocabulary of searchable tools) is returned when
  nothing matched or when the query was empty, so a failed query teaches the model
  the real tags.
- Active tools live in a `Set` per harness: discovery survives across calls and is
  cleared by `reset()`.
- An **undiscovered** tool is not callable: the harness answers the call with a
  tool result naming tags that would enable it. The model cannot bypass discovery
  by guessing a name.
- `declared()` builds the request list core-first, then discovered, and is rebuilt
  for every request, so a getTools round shows up on the very next turn. `delegate`
  is skipped for every agent except the primary.

---

## Preset tools

`src/tools/` ships ten presets. Each is a standard `tool()` and each is executable
standalone.

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

Every preset is tagged and **searchable** (the default), so a harness that
registers all ten declares only the core set until the model asks for `files`,
`shell`, `git`, `python`, or `javascript`.

| Export | Call | Result |
|---|---|---|
| `pythonSyntax` | `(code)` | `boolean` |
| `javascriptSyntax` | `(code)` | `boolean` |
| `readFile` | `(path)` | `string` |
| `writeFile` | `({ path, content })` | `{ path, bytes }` |
| `editFile` | `({ path, oldString, newString, replaceAll? })` | `{ path, replacements, bytes }` |
| `listFiles` | `(path?)` | `string[]` (directories end with `/`) |
| `searchFiles` | `({ pattern, path?, include?, maxResults? })` | `{ matches: [{ path, line, text }], truncated }` |
| `globFiles` | `({ pattern, path?, maxResults? })` | `{ files, truncated }` |
| `runCommand` | `({ command, cwd? })` | `{ exitCode, stdout, stderr }` |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut }` |

Implementation notes worth keeping:

- **Neither syntax tool executes code.** JavaScript compiles with `node:vm`'s
  `Script` (parses, never runs; classic scripts only — `import`/`export` report
  false). Python pipes source to `compile()` through the interpreter, which also
  only parses.
- **`pythonSyntax` needs a Python 3 interpreter.** Probes `python3` then `python`
  by exit status (the Windows Store `python3` shim exists but exits non-zero) and
  caches the answer. A missing interpreter **throws** — "false" must keep meaning
  "your code is wrong".
- **`editFile` is exact and guarded.** `oldString` must appear exactly once or
  `replaceAll: true` must be passed; a missing file is an error (use `writeFile`
  for new files), and the result reports `replacements` and the new byte size.
- **`searchFiles` / `globFiles` share `files/glob.ts`.** `.git`, `node_modules`,
  symlinks, binaries, and files over 1 MiB are skipped; results default to 100
  (clamped 1–100) and set `truncated`; `.gitignore` is deliberately not read.
- **`gitDiff` is the read-only git path.** A fixed argv with no shell, no colour,
  no external diff drivers, no textconv; `ref` may not start with `-`, and paths
  go after `--`. Non-zero exit is data, like `runCommand`.
- **No sandbox anywhere.** Paths resolve against `process.cwd()` and are used as
  given; `runCommand` and `gitDiff` run with host permissions. This matches other
  CLI harnesses: powerful by default, fenced by the process boundary the host
  provides. Say so loudly in docs.
- **Non-zero exit is data.** `runCommand` / `gitDiff` resolve with `exitCode`
  rather than throwing, so the model can read a failing command and react.
- `writeFile` creates parent directories and returns the absolute path + byte
  count, because agents write into not-yet-existing directories constantly.

---

## createTool

The model can write a small tool for itself mid-conversation; the host can do the
same with `writer.createTool(configuration)`. One registration path serves both
(`createToolFrom` in `src/harness.ts`, `createDynamicTool` in `src/core/creation.ts`).

```ts
const tool = writer.createTool({
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
  registered tool is rejected ("readfile" cannot shadow "readFile"), and a harness
  may create at most **32** tools (`MAX_CREATED_TOOLS`). The model path returns the
  failure as a tool result; the host path throws.
- **Registered searchable and enabled immediately**, so the next turn can call it
  without a second getTools round. It stays in the searchable catalogue afterwards.
- **Session-local, no persistence.** Created tools live in that harness's registry
  only; nothing is written to disk, two harnesses cannot see each other's tools,
  and a restart starts clean. `reset()` keeps them registered but clears the
  enabled set (discovery is conversation state).
- **No sandbox.** The body is compiled with the host realm's `Function`
  constructor and runs with the process's full permissions — the same trust model
  as `runCommand`. Nothing here isolates filesystem, network, or processes.

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
  tool-side path (used by the `summarize` harness tool) and is not model-visible
  delegation.
---

## harness

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    tools: { websearch: tool({...}) },
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
  `delegate` tool. See [Delegation](#delegation).
- The registry key is the identity for both agents and tools; `agent.name` /
  `tool.name` are overwritten to match.
- **Tool declarations are filtered, not the registry.** `writer.tools` holds the
  preset preload, the configured tools, `getTools`, `createTool`, and `delegate`
  when there is a subagent; a request declares core tools first, then whatever
  getTools enabled. `delegate` is core for the primary only.
- `presets` (default `true`) preloads `presetTools` into the registry. `false`
  starts from `tools` alone. A configured tool wins on a name collision.
- `plugins` remains as an optional programmatic extension point
  (`createAgent`, `addTool`). It is not part of the declarative config shape, and
  a plugin-added tool is searchable like any other. The reserved names stay
  reserved for plugins too.
- `reset()` clears the entry agent's conversation **and** the discovered-tool set,
  so a reset run starts from the core set again. Created tools stay registered
  (registry state), just no longer enabled. The server resets every agent in a
  session, not only the primary.

**Members:** callable, `name`, `agent`, `agents`, `subagents`, `tools`, `plugins`,
`createTool(config)`, `reset()`.

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
getTools has enabled — that is how a discovery round changes the next request
without mutating the registry.

Recoverable failures become tool results the model can read:
- unknown tool → result listing the declared tools and pointing at getTools;
- undiscovered tool → result naming tags that would enable it (it does not run);
- malformed JSON arguments → result naming the parse failure (the tool is not
  executed);
- throwing tool → result with the error message.

Terminal failures truncate history to the pre-call length, emit `error`, and
throw:
- transport failure;
- more than **MAX_ITERATIONS (16)** tool rounds without an answer.

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
| { type: 'tool_result'; agent: string; name: string; content: string; isError: boolean }
| { type: 'done';        agent: string; message: HarnessAssistantMessage }
| { type: 'error';       agent: string; error: { message: string } }
```

Delivered through `report.progress`, which is **awaited** for every step, so a
slow reporter paces the run. Every event names its agent.

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
    usage?: { input: number; output: number; total: number };
}
```

## ToolVisibility / ToolSearchResult

```ts
type ToolVisibility = 'core' | 'searchable';

type ToolSearchResult = {
    enabled: string[];                  // ranked; also what the next turn declares
    tools: { name: string; description: string; tags: string[] }[];
    unmatchedTags?: string[];           // query tags that matched nothing
    availableTags?: string[];           // vocabulary, when nothing matched
    truncated?: boolean;                // more matched than the cap
};
```

`searchTools()` returns the same shape as `getTools`, so a UI can rank a catalogue
without a harness.

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
  (score, hits, name), and capped at 10 by default with a hard maximum of 50,
  because discovery exists to save context — an uncapped result would spend it
  again.
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
- **Delegation is one level deep by construction.** `delegate` is core for the
  primary only, is never declared to subagents, is rejected if a subagent guesses
  it, and `runAgent` refuses to re-enter a running agent. Each agent keeps its own
  instructions and transcript; only the answer crosses back.
- **Undiscovered tools do not run.** Executing a tool the model was never
  declared would make getTools optional in practice. Instead the call comes back
  as a tool result naming the tags that would enable it, which is recoverable and
  still teaches the model the vocabulary.
- **Preload the catalogue, declare nothing.** Shipping the presets into every
  harness by default is only safe because they are searchable: the registry grows,
  the request does not. `presets: false` exists for callers who want an empty
  catalogue, which is also what the harness tests use when they assert exact
  discovery results.

## CLI, server, and UI

The app is split so the harness has **no UI dependency**. `src/` stays the
published library; the three entry points are consumers of it.

- **CLI (`cli/`)** runs a preset in-process: one-shot from argv/stdin, or an
  interactive session on a TTY. It renders `HarnessEvent`s directly with
  `cli/render.ts`, or emits one JSON object per line with `--json`. `--serve`
  switches to the HTTP server. The CLI never imports the UI.
- **Server (`server/`)** owns HTTP and sessions, not harness policy. `SessionStore`
  keeps one `Harness` per session, so a second task continues the same
  conversation. `handler.ts` maps routes to the store and streams
  `HarnessEvent`s as SSE. `static.ts` serves `playground/dist`; `playground/dev.ts`
  starts the standalone server and proxies Vite's `/api` to it. There is no CORS in
  either mode: the UI is same-origin in production and proxied in development.
- **Catalogue (`harnesses/`)** holds the presets and harness-level tools shared by
  the CLI and server. Presets are factories because a harness bakes its transport
  at construction. `demo` uses the scripted transport and needs no endpoint;
  `writer`, `assistant`, `researcher`, and `flaky` use `presets: false` so they
  cannot discover the host file/command tools; `workspace` deliberately keeps the
  package preload (all ten presets) and is the useful default for real work.
  Every preset names its `primary` explicitly (one-agent presets have no
  subagents, so no `delegate` tool); `researcher` also declares
  `subagents: ['summarizer']`, and every agent keeps its own instruction. `harnesses/index.ts` aggregates the lazy
  `presetTools` metadata for the CLI/server catalogue and never executes or
  imports an implementation.
- **UI (`playground/`)** is only a client. It lists presets/tools, creates
  sessions, submits tasks, and renders the SSE stream. It imports no harness code
  and no `node:` built-ins, which is why `node-stub.ts` and the source alias were
  deleted.

### API

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness and session count |
| `GET /api/harnesses` | Preset descriptors + provider defaults |
| `GET /api/tools` | Direct-call catalogue |
| `POST /api/tools/:name` | `{ parameters }` → `{ ok, result | error, durationMs }` |
| `POST /api/models` | `{ settings? }` → `{ models: string[] }`; server-side `listModels` |
| `POST /api/sessions` | `{ harness, settings? }` → `{ session }` |
| `GET /api/sessions`, `GET /api/sessions/:id` | Snapshots |
| `POST /api/sessions/:id/messages` | `{ input }` → SSE |
| `POST /api/sessions/:id/reset` | Reset every agent + discovery |
| `POST /api/sessions/:id/cancel` | Abort the current run |
| `DELETE /api/sessions/:id` | Forget the session |

Every request requires `X-Harness-Client: ui`. A browser on another origin
cannot set that header without a CORS preflight, and the server answers none, so
a malicious page cannot read transcripts or POST a command to localhost. The UI
sends it; `curl` must add it.

Every SSE `data:` frame is `{ type: 'event', event }`, `{ type: 'snapshot',
session }` on success, or `{ type: 'failed', error, session }` on failure. The
response's `close` event cancels the run, so a disconnected client does not keep
spending provider time.

### Decisions worth keeping

- **The server is a consumer, not a new layer in `src/`.** `SessionStore` calls the
  same `harness()` a CLI does; neither the CLI nor the server adds tool execution
  or model policy.
- **Sessions live in memory.** Restarting the server is a clean slate. Persistence
  is still on the roadmap; this is intentionally the smallest useful session model.
- **No CORS, explicit client header.** Dev proxies `/api` to the standalone
  server; production serves the UI and API from one origin. Every API request must
  carry `X-Harness-Client: ui`, which a foreign page cannot set without a preflight
  the server never answers.
- **Loopback by default.** `127.0.0.1:5181`. Direct tool calls and `workspace` run
  with the server's permissions and have no sandbox.
- **Scoped presets opt out of the preload.** Because the server now really runs
  `presetTools`, a live preset would otherwise be able to discover `runCommand`.
  Only `workspace` opts in; the rest pass `presets: false`.

### Scripts

```bash
yarn start                # API + UI end-to-end
yarn cli "task"           # one-shot, default demo preset
yarn cli                  # interactive
yarn serve                # API + built UI (build the UI first)
yarn dev:playground       # same as start
yarn preview:playground   # built UI, proxies /api to :5181
yarn test                 # library + server tests
```

`server/server.test.ts` drives the real HTTP server with the scripted demo: create
a session, stream a task, continue it, reset it, call a tool directly, and check
the error statuses. The UI build no longer needs a package alias, so
`playground/dist` is a plain client bundle.


## Not built yet

In the order they are expected:

1. **streaming tool output** — `execute` cannot report progress mid-call yet.
2. **session persistence** — the server keeps sessions in memory; restarting loses them.
3. **compaction** — history pruning before context limits.
4. **per-agent tool scoping** — searchable tools are catalogued once; every agent
   can discover every non-core tool (only `delegate` is primary-only).
5. **parallel tool execution** — calls run sequentially today.
6. **sandboxed presets and created tools** — the file and command tools, and any
   `createTool` body, run with host permissions; a `root`-scoped/fenced variant
   would be the natural next step.
7. **persisting created tools** — they live and die with the harness instance.
8. **more presets** — `fetchUrl` and a patch/multi-edit tool are the obvious gaps.

# @underload/harness

A plugin-first CLI agent harness. One call builds a callable writer that runs the
tool loop for you.

## Install

```bash
yarn add @underload/harness
```

Zero runtime dependencies for the library and the browser client. Node 18+ (`fetch`
is the default transport). The Node server entry declares one runtime dependency,
`dotenv` (it is external, not bundled — see [npm Publishing](#npm-publishing)).

## Usage

```ts
import { harness, agent, tool } from '@underload/harness';

const writer = harness({
    agents: {
        writer: agent({
            model: 'merge/ds4-flash',
            instruction: 'You are a writer.',
            provider: {
                baseURL: 'http://localhost:5500/providers/private/v1',
                apiKey: process.env.HARNESS_KEY!
            }
        })
    },
    tools: {
        webSearch: tool({
            description: 'Search the web for a query.',
            tags: ['search', 'web'],
            parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
            execute: async ({ parameters }) => search(parameters.q)
        })
    },
    report: {
        progress: async (event) => console.log(event.type)
    }
});

const message = await writer('tell me about new year');
console.log(message.content);
```

Calling the harness runs the entry agent until it answers with text, executing
every tool the model asks for along the way.

`webSearch` here is a caller-supplied tool (searchable by default, so toolRequest
enables it). The built-in opt-in `webSearch` factory is core: when a key is
configured it is declared on the first request. The bundled catalogue splits the
same way (R18): `fileRead`, `fileWrite`, `fileEdit`, and `fileGlob` are core, while
`fileList`, `commandRun`, `gitDiff`, and `syntaxCheck` are discovered through the
core `toolRequest` tool — see [Tool discovery](#tool-discovery). The harness-owned
`toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`, and
`locationManage` (plus `agentDelegate` when subagents exist) are also declared up
front and are the only session-bound core tools. Two conditional harness-owned
tools join them: `actionRequest` when `interaction` is configured, and `threadFork`
when forks are enabled (the default) — see
[Owner questions and history forks](#owner-questions-and-history-forks).

## Concepts

Three things: `agent` is the brain, `tool` is an action, `harness` is the loop.
`agent` and `tool` live in `core/` and are barrelled from the package root, so
they work without a harness.

### Layout

Everything the package contains now lives under `src/`: the library, the server
application and the browser client. `harness.ts` stays the stable library entry.

```
src/
  harness.ts        the library entry: harness() + the public barrel
  harness.test.ts   its test, next to it
  index.ts          Node root entry    (library + shared + server + client)
  browser.ts        browser root entry (library + shared + client)
  core/             agent, tool, discovery, creation, todo, profile, chapter,
                    location, action, branch   (usable without a harness)
  agents/           trusted AgentProfile definitions (instruction + guidelines)
  transport/        openai, models      (the wire protocol + model catalogue)
  tools/            the preset catalogue     (lazy, executable on their own)
  plugin/           host                     (programmatic extension)
  util/             errors                   (shared leaf helpers)
  types/            every public type
  shared/           isomorphic helpers both trees evaluate (origin/loopback rules)
  server/           HTTP API, sessions, SSE, catalogue presets, CLI, discovered routes
  frontend/         browser client + the app shell it renders
```

The application layers are barrelled the same way as the library:

```
src/server/
  index.ts              the server surface (startHarnessServer, runtime, dispatcher,
                        SessionStore, protocol, presets) -> @underload/harness/server
  start.ts              startHarnessServer: the ONLY listener, created when called
  api.ts                transport-neutral dispatcher: routes, body policy, bootstrap
  handler.ts            Node adapter: /api prefix, X-Harness-Client gate, SSE writer
  service.ts            @underload/service adapter: /v1/harness, Origin gate, raw SSE
  runtime.ts            lazy shared store/catalogue for the discovered service routes
  persistence.ts        durable database: versioned JSON, atomic write, DTO validation
  sessions.ts           authoritative turns + FIFO queue; restore + write-through
  environment.ts        package-root .env loader (Node entry points only)
  config.ts             provider defaults + mergeSettings credential rule
  protocol.ts           client/server wire types (turns, queue, stream items)
  package-root.ts       package root discovered by walking to package.json (build-layout free)
  static.ts             src/frontend/dist serving
  cli/                  argv parsing, one-shot + interactive rendering
  harnesses/            presets and harness-level tools shared by CLI and server
  endpoint/harness/     the route modules @underload/service discovers
src/frontend/
  index.ts              the reusable client: api + contract + ui panels
                        -> @underload/harness/frontend
  main.ts               the app shell (imports styles.css, mounts the DOM on load)
  api.ts                root resolution (query/injected/build/api) + fetch + SSE
  contract.ts           wire validation/presentation helpers
  ui/                   turns, agents, create form, markdown, panels, tools, tokens,
                        action-request (owner question card)
  styles.css            the app stylesheet
  index.html            the app entry document
```

The transcript is one compact row per user turn. A delegated agent adds an ENTRY
of its own under the invocation that spawned it: a compact thread row at depth 1
(its own children at depth 2, and so on), placed inside the turn row but outside
every collapsible body — collapsing a parent tile or a parent entry never hides
it. Each entry expands independently and owns its input, streamed text, tool
calls, status and outcome; two calls to the same agent are two entries. A
`threadFork`/autoanswer branch reuses the same nested entry shape via its `thread`
metadata (`kind`/`branchId`), with only a small kind tag differentiating it. A
saved session that predates the `thread` metadata is replayed from its
`agentDelegate` calls, and a stream that cannot be attributed keeps the old flat
agent section instead of inventing ancestry.

Imports resolve by environment as well as by name, so a browser never loads a
`node:http` graph and a Node host still gets the server API from the root:

| Specifier | Resolves to | Contains |
|---|---|---|
| `@underload/harness` (node/import) | `src/index.ts` | library + shared + server + client |
| `@underload/harness` (browser) | `src/browser.ts` | library + shared + client |
| `@underload/harness/server` | `src/server/index.ts` | server API only |
| `@underload/harness/frontend` | `src/frontend/index.ts` | browser client only |
| `@underload/harness/shared` | `src/shared/index.ts` | origin/loopback helpers |

Importing any of them is inert: no listener is bound (call `startHarnessServer`
for that, or let `@underload/service` host `/v1/harness`), and the client entry
applies no CSS and creates no element — the shell (`main.ts`) is deliberately not
exported.

### TypeScript consumers

The published declarations are ESM and are post-processed at build time
(`scripts/fix-declaration-specifiers.mjs`) so every relative specifier carries its
`.js` name. Node's resolver — and therefore `moduleResolution: "node16" |
"nodenext"` — requires that, so a NodeNext consumer needs no `paths` or shims:

```jsonc
{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }
```

Types follow the same environment split as the runtime:

| Consumer | Resolves | Compiler needs |
|---|---|---|
| Node | `dist/index.d.ts` (library + shared + server + client) | `lib` with `DOM` (client signatures) and `types: ["node"]` (server API) |
| Browser (`customConditions: ["browser"]`) | `dist/browser.d.ts` (library + shared + client) | `lib` with `DOM`; no Node types |
| `@underload/harness/frontend` | `dist/frontend/index.d.ts` | `lib` with `DOM` |
| `@underload/harness/server` | `dist/server/index.d.ts` | `types: ["node"]` |

The Node root re-exports the browser client, so its DOM signatures make the `DOM`
lib necessary even in a Node program — an accepted consequence of "the root exposes
everything". Import a subpath when you want the narrower surface (or no DOM at all).

`yarn build && yarn test:package` type-checks a real NodeNext consumer **and** a real
`customConditions: ["browser"]` consumer against the built package, and asserts the
browser declaration graph never reaches the Node server surface.
`yarn test:package:runtime` then *runs* the built artifact: the `.env` loader, a
durable `createHarnessRuntime({ root })`, and `startHarnessServer` on an ephemeral
loopback port (health, harness index, session POST, clean close).
`prepublishOnly` runs both.

**Browser note.** Importing the browser root (or `./frontend`) evaluates no Node
graph: `dist/underload-harness.browser.mjs` statically reaches only the library,
shared and client chunks. The package tools are a documented Node-only exception —
`fileRead`/`fileWrite`/`fileEdit`/`fileGlob`/`fileList`, `commandRun`, `gitDiff` and
`syntaxCheck` are lazy chunks (`import()`) whose bodies use `node:fs`, `node:vm` and
`node:child_process`. They are exported (the root is the same library surface) but a
browser must not call them; the catalogue only loads a body when that tool is called,
so ordinary browser imports stay Node-free.

`src/tools/` is one file per tool, one folder per capability:

```
tools/
  index.ts              barrel + presetTools (the preload catalogue)
  catalogue.ts          static metadata + the dynamic-import load table
  lazy.ts               builds a callable Tool whose body loads on first use
  syntax/               syntaxCheck.ts (javascript.ts + python.ts load on demand)
  files/                fileRead.ts, fileWrite.ts, fileEdit.ts, fileGlob.ts
                        (core, always declared), fileList.ts (searchable by tag),
                        glob.ts (shared walker)
  command/              commandRun.ts, gitDiff.ts
  websearch/            request.ts (bounds/errors), exa.ts, tavily.ts,
                        index.ts (createWebSearchTool — opt-in, per-harness)
  presets.test.ts       covers every preset, standalone and in a harness
```

Tests sit next to the module they cover and import **only** from
`@underload/harness` — never a relative path. That keeps them honest about the
public surface and free of `../` chains. The specifier is aliased to
`src/harness.ts` in `vitest.config.ts`, so `vitest run` needs no build.

Each folder has an `index.ts` barrel, and `harness.ts` re-exports the public
surface, so consumers only ever import from `@underload/harness`.

### `agent()` — the brain

Model, instruction, message history, and exactly one transport call per turn.
It owns no policy: no tool execution, no compaction, no planning.

```ts
import { agent } from '@underload/harness';

const brain = agent({ model: 'merge/ds4-flash', provider: { baseURL } });

for await (const event of brain.stream('Write an opening.')) {
    if (event.type === 'text') process.stdout.write(event.delta);
}
```

`stream()` is **one turn**. Without a harness you write the loop by hand:

```ts
brain.user('Search the news.');
const tools = [{ name: 'webSearch', description: '...', parameters }];

for await (const event of brain.turn({ tools })) {
    if (event.type !== 'done') continue;

    if (event.message.toolCalls.length === 0) break;

    for (const call of event.message.toolCalls) {
        const result = await run(call);
        brain.messages.push({ role: 'tool', content: result, toolCallId: call.id, name: call.name });
    }
    // ...turn() again
}
```

That loop is exactly what `harness()` automates.

| Method | Behaviour |
|---|---|
| `stream(input)` | Append the user message, run one turn, commit both. Rolls back on failure. |
| `turn(options?)` | Run one turn against the current history, no user append. Throws on failure. |
| `fork({ label? })` | Create a detached private branch of this agent's entire committed history, model, and instruction snapshot. `label` is display metadata only (≤120 characters). |
| `system` / `user` / `assistant` | Append a message, return the agent for chaining. |
| `model()` / `model('x')` | Read / write the model. |
| `reset()` | Restore the seeded instructions and clear the conversation. For a fork it restores the branch's own fork-time baseline, never the live source history. |

`agent.fork()` is the standalone primitive. A fork owns a materialized copy of the
transcript with provider-safe tool-call ids and explicit non-success placeholders
for calls that were still pending; it shares the transport (and therefore credentials
and external tool side effects), so it is a conversation copy, **not a sandbox**.
`agent.messages` on the source is never touched. In a harness, the same primitive
backs the `threadFork` tool.

### `tool()` — an action the model can request, or you can call

A tool is an **executable object**, not a passive descriptor. The same
implementation has two entry points: a direct call, and a call from the model.

```ts
// The preset's real shape: one array property, so `execute` receives the array
// itself. Items may be strings or `{ path, startLine?, startColumn?, maxLines? }`.
const fileRead = tool<FileReadParameters, FileReadResult>({
    description: 'Read a bounded window of UTF-8 text files.',
    tags: ['files', 'read'],
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } } },
        required: ['paths']
    },
    execute: async ({ parameters }) => readBounded(parameters)
});

// { files: [{ path, content, startLine, endLine, truncated,
//             nextLine, nextColumn, bytes }], truncated, bytes, contentBudget }
await fileRead(['package.json']);                // no harness, no agent
harness({ tools: { fileRead } });                // the model calls fileRead
```

- `tool<Parameters, Result>()` — the generics are the callable's signature. The
  second one is inferred from `execute`'s return type.
- `tags` is **required** — at least one. Tags are how discovery finds the tool, so
  they are normalized on construction (trimmed, lowercased, deduplicated).
- `visibility` is `'core'` or `'searchable'` (the default). Core tools are declared
  on every request; searchable ones wait for discovery.
- `parameters` is plain JSON Schema. A TypeBox schema works as-is, so no schema
  dependency is needed.
- **Single-property rule.** When the schema declares exactly one property, the
  value passed to `execute` is that property's value, not the wrapper object.
  That is why `fileRead(['package.json'])` and a model call with
  `{ "paths": ["package.json"] }` reach the implementation identically — which is
  exactly what makes the batched file tools possible. Multi-property tools receive
  the whole object, as `syntaxCheck({ code, language })` does.
- `execute` may throw. The harness turns the error into a tool result the model
  can read and recover from.
- `agent`, `agents`, and `run` are **optional** in the tool context, because a
  direct call has none of them. `run(agentName, input)` runs a full turn on a
  sibling agent when they are present.

### Tool discovery

A catalogue can reach thousands of tools. Declaring all of them would spend the
model's context on schemas it will never call, so a request declares only:

- every `visibility: 'core'` tool, and
- every searchable tool that `toolRequest` has already enabled.

`toolRequest` is a core tool the harness always registers. It takes capability tags,
ranks the catalogue, enables the closest matches, and the next request declares
them:

Every harness also preloads the bundled preset catalogue by default (`presets:
true`), so its tools are available with no imports at all. The four core file tools
(`fileRead`, `fileWrite`, `fileEdit`, `fileGlob`) plus a configured `webSearch` are
declared from the first request, together with the harness-owned `toolRequest`,
`toolCreate`, `todoManage`, `profileManage`, `chapterManage`, and `locationManage`
(and `agentDelegate` when subagents exist). `actionRequest` joins that set when
`interaction` is configured, and `threadFork` when `forks.enabled` is true
(the default). `fileList`, `commandRun`, `gitDiff`, `syntaxCheck`, and the app tools
stay searchable.

```ts
tools: {
    commandRun: tool({
        description: 'Run a shell command.',
        tags: ['shell', 'command'],
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        execute: ({ parameters: command }) => run(command)
    })
}
```

```text
round 1  model -> fileRead({ "paths": ["README.md"] })     // core, no discovery
round 2  model -> toolRequest({ "tags": ["files", "list"] })
         result -> { enabled: ["fileList"], tools: [...], remaining: 0 }
round 3  model -> fileList(["src"])                         // now declared
round 4  model -> toolRequest({ "tags": ["shell"] })
         result -> { enabled: ["commandRun"], tools: [{ name: "commandRun", ... }], remaining: 0 }
round 5  model -> commandRun({ "command": "git status" })   // now declared
```

A discovery call returns **at most five** matches. `remaining` is the number of
further tools that matched but were not listed (no names are exposed), so a broad
query is refined by adding a tag — `["files"]` leaves a sixth match out,
`["files", "write", ...]` brings it in. Repeating an **identical** query walks the
next page instead (the result carries `offset`), so the cap is never a dead end.

Core tools the caller already has are reported separately in `alreadyAvailable`
(metadata only). The motivating case is `agentDelegate` in a harness with
subagents: an exact wire-name or tag query names the tool instead of claiming
nothing matched. These entries are never enabled, never count against the cap,
and their tags are not reported in `unmatchedTags`.

| Rule | Behaviour |
|---|---|
| Tags | Required. Trimmed, lowercased, deduplicated. |
| Default visibility | `'searchable'`. The core set is `fileRead`/`fileWrite`/`fileEdit`/`fileGlob`, a configured `webSearch`, the harness-owned `toolRequest`/`toolCreate`/`todoManage`/`profileManage`/`chapterManage`/`locationManage`, plus `agentDelegate` on a primary with subagents, `actionRequest` when `interaction` is configured, and `threadFork` when forks are enabled. `fileList` is searchable. |
| Core vs session-bound | `core` means always declared. Only the harness-owned set is `sessionBound` (needs a `sessionId` for a manual server call); core file tools and webSearch run directly. |
| Ranking | OR-style: a tool needs only one query tag to be a candidate, and its rank is its **best single-tag score** — exact tag (4) > tag prefix (3) > tag substring (2) > name/description hit (1). More matching tags only breaks ties, so a broad tool cannot outrank an exact hit. |
| Cap | 5 matches — the default AND the maximum. `limit` may only ask for fewer (1–5). `remaining` counts the matches the cap excluded; `truncated: true` mirrors it for older clients. |
| Already available | Core tools the caller already has (`agentDelegate` with subagents, `todoManage`, the file tools, …) that match the query are listed in `alreadyAvailable` — metadata only, never enabled, never counted against the cap. They are scored by wire name and tags only (never description), and a match is not reported as unmatched. |
| No match | when neither a searchable nor an already-available core tool matches, the result carries `unmatchedTags` and the full `availableTags`, so the model retries with real vocabulary. |
| Undiscovered tool | calling one returns a tool result naming tags that would enable it — it does not run. |
| Lifetime | discovery is per harness and kept across calls; `reset()` forgets it with the conversation. `harness.discoveredTools` exposes the enabled names. |
| Reserved names | `toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`, and `locationManage` belong to the harness, and `agentDelegate`, `actionRequest`, and `threadFork` too when they are registered; using one throws. |
| Manual call | an operator may run any registered tool through `harness.executeTool()` / `POST /tools/:name`; discovery gates the model, not the user. Core file tools need no session; the harness-owned set does. `actionRequest` and `threadFork` are the exception: they need the run that owns the conversation and are refused by the manual path. |

`searchTools(tools, tags, limit?, offset?, options?)` is the same ranking without
a harness — useful for a catalogue UI or for checking that a tag vocabulary
resolves the way you expect. Pass `{ declared }` to reproduce `alreadyAvailable`.

### Session todos (`todoManage`)

Every harness registers a core `todoManage` tool, so the model can keep a plan
without a discovery round. It is **incremental** and **session-scoped**:

| Action | Input | Result |
|---|---|---|
| `add` | `text` (non-blank; trimmed, max 4000 chars) | `{ todo, counts }` — the new todo with the next stable id (`"1"`, `"2"`, …) |
| `remove` | `id` | `{ removed, counts }` |
| `check` | `id`, optional `completed` (default `true`; `false` unchecks) | `{ todo, counts }` |
| `uncheck` | `id` | `{ todo, counts }` with `completed: false` (alias for `check` + `completed: false`) |
| `list` | optional `offset` (≥ 0) and `limit` (1-100, default 20) | ONE page: `{ todos, counts: { total, completed, remaining }, page: { offset, limit, hasMore, nextOffset? } }` |

```text
todoManage({ "action": "add", "text": "Draft the plan" })
  -> { todo: { id: "1", text: "Draft the plan", completed: false },
       counts: { total: 1, completed: 0, remaining: 1 } }

todoManage({ "action": "list", "offset": 20, "limit": 20 })
  -> { todos: [...], counts: { total: 42, completed: 3, remaining: 39 },
       page: { offset: 20, limit: 20, hasMore: true, nextOffset: 40 } }
```

- Results are **bounded and split by action**: `list` returns one page (20 by
  default, max 100, and a 64 KiB serialized page budget that stops before an item
  which would cross it), while every mutation returns only the changed item and the
  counts — no list. `page.nextOffset` is omitted when `hasMore` is false; loop on it
  to read the rest. Caps: 200 todos, 4000 characters of text each.
- Every result is a defensive copy, never a live reference.
- Invalid input is a readable, recoverable tool result: unknown action, blank
  `text`, blank `id`, unknown id, and non-boolean `completed` all name the action
  and field. A failed call never changes the list.
- The list is **per harness**, shared by the primary and its subagents, kept
  across turns, and cleared by `reset()` (ids restart at `"1"`). Nothing is
  persisted: two harnesses, and therefore two server sessions, never share todos.

**Not OpenCode parity.** OpenCode's current dev branch (`fd8268e`, 2026-10-27)
ships a different, experimental `todowrite` tool: gated behind `experimental.todo`,
it takes `{ todos: [{ content, status }] }`, replaces the whole list on every
call, has no ids, and its list is derived by the UI from the last call. Sources:
[`plugin/todo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/todo.ts),
[`todowrite.txt`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/todowrite.txt),
[`tool-todo.test.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/test/tool-todo.test.ts).
`todoManage` deliberately uses incremental actions and stable ids instead; it does
not copy that API or claim compatibility.

### Session records (`profileManage`, `chapterManage`, `locationManage`)

Three more core tools follow `todoManage`'s lifecycle exactly: one store per
harness (therefore per server session), shared by the primary and its subagents,
stable decimal-string ids from `"1"`, and cleared by `reset()` (ids restart at
`"1"`). They share one action set and one validation policy:

| Action | Input | Result |
|---|---|---|
| `add` | the tool's required fields plus optionals | `{ profile \| chapter \| location, counts }` — no list |
| `list` | optional `offset` (≥ 0) and `limit` (1-100, default 20) | ONE page: the records (summaries for chapters) plus `counts` and `page: { offset, limit, hasMore, nextOffset? }` |
| `get` | `id` | one record plus `counts`; for chapters this is the only action that returns `content` |
| `update` | `id` plus at least one mutable field | the patched record plus `counts`; fields you omit are unchanged |
| `remove` | `id` | `{ removed, counts }` |

Pages default to 20 records (max 100) with a 64 KiB serialized page budget; caps are
200 records, 200-character names/titles, 4000-character text, and at most 32 profile
traits of 200 characters. Every result is a defensive snapshot (arrays and records
are copies). A rejected
call changes nothing: unknown action, missing/blank `id`, unknown id, wrong field
type, an update that names no field, and every tool-specific rule below are
readable errors naming the tool and field.

| Tool | Required on `add` | Optional | `counts` |
|---|---|---|---|
| `profileManage` | `name`, `description` | `traits` (string[]; trimmed, deduplicated), `notes` | `{ total }` |
| `chapterManage` | `title`, `summary` | `content` (default `""`), `status` (`planned`/`draft`/`complete`, default `planned`), `order` (integer) | `{ total, planned, draft, complete }` |
| `locationManage` | `name`, `description` | `notes` | `{ total }` |

Chapter-specific rules: `list` and every mutation result carry **summaries**
without the body — only `get` returns `content`; `update` rejects a blank
`title`/`summary` but may clear `content` to `""`; `order` sorts the returned
list (ordered chapters ascending first, unordered ones after in insertion order)
and the live store is never re-sorted. There is no move action: update `order`.
Profiles and locations return whole records, so an empty `notes` is a normal
stored value, and `traits: []` clears a profile's traits. Like `todoManage`,
nothing is persisted and no HTTP/UI surface reads these stores: the tool result
is the record.

### Tool names

Every tool — core and preset — is named `<namespace><action>`. The namespace
groups related tools for discovery; the action is what the model calls.

| Old name (removed) | Current name | Notes |
|---|---|---|
| `requestTools` | `toolRequest` | core; always declared |
| `createTool` (tool) | `toolCreate` | core; the host method is `harness.createTool()` |
| `todoTools` | `todoManage` | core; always declared |
| `delegate` | `agentDelegate` | core; primary only, when subagents exist |
| `readFile` | `fileRead` | **batched and bounded**: `(paths: (string \| { path, startLine?, startColumn?, maxLines? })[])` → `{ files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, bytes, error? }], truncated, bytes, contentBudget }` |
| `writeFile` | `fileWrite` | **batched**: `({ path, content }[])` → `{ path, bytes }[]` |
| `editFile` | `fileEdit` | **batched**: `({ path, oldString, newString, replaceAll? }[])` → `{ path, replacements, bytes }[]` |
| `listFiles` | `fileList` | **paged**: `(paths?)` or `({ paths?, offset?, limit? })` → `{ entries, truncated, nextOffset, offset, limit, bytes, contentBudget }` |
| `globFiles` + `searchFiles` | `fileGlob` | **unified**: filename mode, or content mode when `content` is supplied |
| `runCommand` | `commandRun` | unchanged shape |
| `gitDiff` | `gitDiff` | unchanged (already `namespace`+`action` shape) |
| `syntaxCheck` | `syntaxCheck` | unchanged (already `namespace`+`action` shape) |
| `websearch` | `webSearch` | the **tool**; the `websearch` harness configuration field keeps its name |
| `clock` | `timeNow` | app tool |
| `wordCount` | `textCount` | app tool |
| `roll` | `diceRoll` | app tool |
| `searchNotes` | `noteSearch` | app tool |
| `summarize` | `textSummarize` | app tool |
| `flaky` (tool) | `testFlaky` | the `flaky` **harness/preset id** is unchanged |

`profileManage`, `chapterManage`, and `locationManage` were added under their final
names, so they have no removed-name row. All three are core session tools with the
same incremental action set — see
[Session records](#session-records-profilemanage-chaptermanage-locationmanage).
`actionRequest` and `threadFork` were also added under their final names and follow
the same `<namespace><action>` shape (`action`+`Request`, `thread`+`Fork`); they are
conditional harness-owned core tools — see
[Owner questions and history forks](#owner-questions-and-history-forks).

There are **no aliases**: the old names are gone from the wire surface, the
exports, the catalogue, and the reserved-name list. This is a deliberate breaking
change — a catalogue with two names for one tool makes discovery ambiguous. Harness
ids (`instruct`, `research`, `workspace`, `reviewer`, `planner`, `demo`, `flaky`),
agent ids, and the `websearch` configuration field are *not* tool names and are
unchanged.

### Preset tools

Shipped with the package, each usable standalone or registered on a harness:

```ts
import {
    syntaxCheck,
    fileRead,
    fileWrite,
    fileEdit,
    fileList,
    fileGlob,
    commandRun,
    gitDiff
} from '@underload/harness';

await syntaxCheck({ code: 'def f():\n    pass', language: 'python' }); // true
await fileRead(['package.json']);                                   // { files: [{ path, content, … }], truncated, bytes, contentBudget }
await fileWrite([{ path: 'notes.md', content: '# Notes' }]);         // [{ path, bytes }]
await fileList(['src', 'task']);                                    // { entries: ['src/a.ts', 'src/nested/', 'task/b.ts', ...], truncated, nextOffset, offset, limit, bytes, contentBudget }
await fileList({ paths: ['src'], offset: 200, limit: 100 });        // page 2 of the same list
await fileEdit([{ path: 'a.ts', oldString: 'let x', newString: 'let y' }]);
await fileGlob({ patterns: ['src/**/*.ts'] });                      // { files, truncated }
await fileGlob({ patterns: ['*.ts'], content: 'TODO' });             // { matches, truncated }
await gitDiff();                                                    // { exitCode, stdout, stderr, truncated, timedOut, stderrTruncated, aborted }
await commandRun({ command: 'git status' });                        // { exitCode, stdout, stderr, truncated, timedOut, aborted }
await commandRun({ command: 'npm test', timeoutMs: 600_000 });      // 1..600000 ms; tree killed on timeout
```

Each tool lives in its own file under a capability folder (`tools/syntax/`,
`tools/files/`, `tools/command/`), and the barrel also exports the whole set as
`presetTools`. **Every new harness preloads that catalogue**: `fileRead`,
`fileWrite`, `fileEdit`, and `fileGlob` are declared immediately (core), while
`fileList`, `syntaxCheck`, `commandRun`, and `gitDiff` cost context only after a
toolRequest query enables them; `presets: false` turns the preload off.

The exports are **lazy proxies**, not implementations. `tools/catalogue.ts` holds
the static metadata (name, description, tags, schema) and names each
implementation in its own `import()` branch; the body — and the `node:fs` /
`node:child_process` / `node:vm` it needs — loads the first time a tool is called.
Constructing a harness or listing the catalogue therefore costs no Node built-ins,
and a model that never asks for `commandRun` never loads it. The published build
turns each branch into a chunk next to `dist/underload-harness.mjs`; all of
`dist/` is shipped, and `inlineDynamicImports` must stay off or the split is undone.

**The file tools are batched.** `fileRead`, `fileWrite`, `fileEdit`, and `fileList`
each declare exactly ONE array property (`paths` / `files` / `edits`), so the
single-property rule hands `execute` the array itself. A direct call and a model
call therefore reach the same code:

```ts
await fileRead(['a.ts', 'b.ts']);                                  // { files: [{ path, content, … }, …], … }
await fileRead([{ path: 'big.ts', startLine: 400, maxLines: 50 }]); // one bounded window
await fileWrite([{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }]);
await fileEdit([{ path: 'a.ts', oldString: 'a', newString: 'b' }]);
```

**`fileRead` is bounded by default.** Each result window returns at most 200 lines
(`maxLines`, hard maximum 5000) starting at `startLine` (1-based, default 1). The
whole batch shares a fixed 64 KiB UTF-8 **content** budget, split fairly between the
requested files; reading streams in 64 KiB chunks and stops at the cap, so a huge
file or a single giant line is never loaded wholesale. `content` is raw text whose
first line is `startLine` — line numbering is metadata, not a prefix, so a model can
still copy exact text into `fileEdit`. A truncated entry reports `nextLine` and
`nextColumn` (a 0-based UTF-8 byte offset within that line, normally 0; non-zero
only when a giant line was cut mid-line), and `{ path, startLine: nextLine,
startColumn: nextColumn }` resumes exactly there. Binary rejection is based on the
bytes DECODED WHILE STREAMING: a NUL or invalid UTF-8 sequence in a chunk that was
read rejects the call instead of returning replacement characters. It is not
whole-file validation — bytes after the last read chunk (for example far past a
truncated window) are never inspected. A call accepts at most 100 paths, which
bounds the metadata side of the response as well as the content. The budget covers
content bytes, not JSON escaping; `contentBudget` reports the fixed cap and `bytes`
reports what the response consumed. Because line numbers require counting from the
beginning, a deep `startLine`/`startColumn` rescan the file from byte 0 each time:
memory stays bounded, but the skipped prefix costs time.

A path that does **not exist** is a per-entry result, not a failed call: it keeps its
ordered position with empty `content`, `bytes` 0, the empty-window range
(`endLine = startLine - 1`), and `error: { code: 'ENOENT', message }`, while every
other requested file is still read. A missing entry consumes **no** content budget,
so it cannot shrink the window of a file that does exist. Everything else — a
malformed request, a range error, a directory, binary bytes in a chunk that was
read, or any other filesystem error — rejects the whole call, so a partial answer
can never look complete.

`fileWrite` and `fileEdit` validate **every** entry (shape, non-empty strings, no
NUL, unique target file) before the first write, and `fileEdit` also reads and
match-checks every file first, so one bad entry leaves every file untouched.
Uniqueness is by **real file identity**, not spelling: on Windows `notes.txt` and
`NOTES.TXT` are one file, and so is a symlink alias on any platform, so a batch that
names one file twice is rejected before anything is written (Linux keeps `a.ts` and
`A.ts` as two files). A filesystem error part-way through the write phase is reported
with the paths already completed: there is **no transaction and no rollback**.

| Tool | Signatures | Result |
|---|---|---|
| `syntaxCheck` | `({ code, language: 'javascript' \| 'python' })` | `true` when the snippet parses; JavaScript is a classic script (no `import`/`export` or top-level await) |
| `fileRead` | `(paths: (string \| { path, startLine?, startColumn?, maxLines? })[])` — non-empty | `{ files, truncated, bytes, contentBudget }`; one window per path, ordered; a missing path is an entry with `error: { code: 'ENOENT', message }` (empty content, 0 bytes), while a malformed request, directory, binary, or other I/O error rejects the whole call |
| `fileWrite` | `(files: { path, content }[])` — non-empty | ordered `{ path, bytes }[]`, creating parent directories; duplicate target files rejected |
| `fileEdit` | `(edits: { path, oldString, newString, replaceAll? }[])` — non-empty | ordered `{ path, replacements, bytes }[]`; `oldString` must be unique unless `replaceAll`; all edits preflighted |
| `fileList` | `(paths?)` — string or string[]; defaults to `["."]` | `string[]` of `dir/entry`, directories end with `/`; non-recursive |
| `fileGlob` | `({ patterns?, paths?, maxResults? })` | filename mode: `{ files, truncated }`; caps at 100 |
| `fileGlob` | `({ patterns?, paths?, content, maxResults? })` | content mode: `{ matches: [{ path, line, text }], truncated }`; caps at 100, matching time-bounded |
| `commandRun` | `({ command, cwd? })` | `{ exitCode, stdout, stderr }` |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut }`; read-only |

**`fileGlob` is the one search surface.** Its mode is decided by the presence of
`content`, which is documented in the tool description because a model reads that,
not this table:

- no `content` → `{ files: string[], truncated }` (glob matching only);
- `content` → `{ matches: { path, line, text }[], truncated }` (a content grep
  restricted to files matching `patterns`).

`patterns` (default `["**/*"]`) are OR-ed, and a pattern with no `/` also matches
file names at any depth. A pattern is matched against each file's path **relative to
the root that found it**, and results carry that root as their prefix, so
`fileGlob({ paths: ['src'], patterns: ['**/*.ts'] })` returns `src/a.ts` and
`src/nested/b.ts` (never an absolute path, and never a pattern matched against one).
`paths` (default `["."]`) are walked in caller order; roots that resolve to the same
directory (a symlink alias, or `src`/`SRC` on Windows) are walked once, and files are
deduplicated by resolved identity while keeping the first root's prefix. The cap is
global across every root.
`.git`, `node_modules`, symlinks, binary files, and files over 1 MiB are skipped in
content mode, and `.gitignore` is **not** read.

Content matching is **time-bounded**: a JavaScript regex can backtrack
exponentially (`(a+)+$` needs seconds on a 31-byte line), so the match loop runs in
`node:vm` with a cumulative 30-second budget and a pattern that exceeds it fails with
a clear error instead of hanging the call. That budget is the only time bound on the
match; no separate overall request timeout is added. It is a timeout, not a sandbox,
and an ordinary grep over a large tree is unaffected (the context is reused per
search and the boundary is crossed once per file, not once per line).
`gitDiff` runs a fixed `git diff` argv with no shell, colour, external diff
drivers, or textconv, and never stages or commits.

`syntaxCheck` never executes the code it checks. Its Python half needs a Python 3
interpreter on `PATH` and throws if none is found — a missing interpreter is a
setup problem, not a verdict of "invalid syntax". The JavaScript and Python
parsers are imported on demand, so a check in one language never loads the other.

Every preset is tagged. The four core file tools are always declared, so a model
reads/writes/edits/globs directly. `fileList` is found with `files`/`list`; a shell
with `shell`, git with `git`, and syntax checks with `javascript`/`python`. Those
searchable tools stay out of the context window until enabled.

**These presets hold no sandbox.** `fileRead`, `fileWrite`, `fileEdit`,
`commandRun`, and `gitDiff` act with the permissions of the host process. Run the
harness inside a container, a worktree, or an account you are willing to have
modified, or wrap `execute` to add a fence.

### Web search (`webSearch`)

One opt-in search tool over **Exa** or **Tavily**. It is deliberately **not** part
of `presetTools`: a search tool needs a provider key, and a key belongs to one
harness. Nothing is registered unless the configuration asks for it *and* a key is
available.

```ts
// Library: environment-backed (EXA_API_KEY / TAVILY_API_KEY in process.env)
const writer = harness({
    agents: { writer: agent({ ... }) },
    websearch: true
});

// Library: injected environment, or explicit per-provider overrides
const writer = harness({
    agents: { writer: agent({ ... }) },
    websearch: {
        env: { EXA_API_KEY: readSecretFromYourStore() },
        tavily: { apiKey: () => vault.get('TAVILY_API_KEY') }
    }
});

// Standalone factory: undefined when no provider key is available
const definition = createWebSearchTool({ env: process.env });
```

Registration rules:

| Rule | Effect |
|---|---|
| `websearch` absent or `false` | No tool. |
| `websearch: true` or `{}` | Resolve `EXA_API_KEY` / `TAVILY_API_KEY` at construction. |
| `exa.apiKey` / `tavily.apiKey` | Explicit override (string, or a getter called once at construction and reused for every search — no per-request rotation); an explicit blank key disables that provider instead of falling back to env. |
| Provider without a key | Absent: not in the schema, not callable. |
| No provider with a key | No tool at all, even when opted in. |
| `tools: { webSearch }` configured | Your tool wins; the built-in factory is not consulted. |

Keys are read from `process.env` only (or from `env` when injected). The published
library never imports a dotenv parser and never reads a file: when you embed
`@underload/harness`, the host owns the environment. The bundled Node entry points
(CLI, `yarn dev:server`, and the service runtime) load the package-root `.env` once at startup before any
harness is constructed — see [Environment file](#environment-file). The
CLI/server presets pass `websearch: true`, so a key in the shell or in `.env` is
enough for any of those entry points; the offline `demo` stays offline, and no UI
field or `RunnerSettings` value carries a search key. The real harnesses
(`instruct`, `research`, `workspace`, `reviewer`, `planner`) share one toolbox, so a
key makes web search available to all of them or to none. The `flaky` example is
built by the same shared factory, so it opts in too; only the scripted `demo` stays
offline.

**Catalogue visibility (server and UI).** The harness app always lists
`webSearch` in its direct-call catalogue, configured or not. With a key it is a
normal callable entry (`POST /api/tools/webSearch`); without one the entry is
marked `unconfigured`, carries the provider variable *names* and a non-secret hint,
and a direct call answers a normal `{ "ok": false }` tool failure explaining what
to set and that a restart is required. The catalogue is built when the server
starts — after `.env` loading, never at module import — and each descriptor may
carry `availability: { state, environment, hint }`. Key values never appear in a
descriptor, hint, CLI listing, or UI.

The same rule applies to preset descriptors (`GET /harnesses`, the `/presets`
alias, and the canonical bootstrap document). Every shared-toolbox preset
(`instruct`, `research`, `workspace`, `reviewer`, `planner`, and the `flaky`
example) declares `environmentTools: ['webSearch']`, which the
server appends to its `tools` list **and** to `coreTools` **only** when the runtime
catalogue has an executable `webSearch` (that is, when a key was resolved). A
keyless host advertises the same shared toolbox minus webSearch, so a preset card
never claims a tool the session cannot call.

The built-in tool is **core** (R18): when configured, it is declared on every
request and the model calls it directly — no discovery round. The keyless entry is
still visible in the Tools tab with its `unconfigured` hint, but it is not runnable:

```ts
// Direct call on the tool the factory returned (or on the registry entry)
await definition?.({ query: 'harness tool discovery', maxResults: 5 });
// -> { provider: 'exa', query, maxResults, results: [{ title, url, snippet, published? }] }
```

| Bound | Value |
|---|---|
| Default results | 5 |
| Maximum results | 20 (`maxResults` is clamped, not rejected) |
| Title / snippet | 300 / 1,000 characters |
| Response body | 512,000 characters (declared length, then post-read) |
| Per-request timeout | 15 s, `AbortController`, timer cleared in `finally` |
| Retries / failover | None: one request, one provider, one attempt |

Provider choice: Exa when both keys exist, Tavily when it is the only one. The
`provider` argument is only offered when more than one is configured, and an
unknown value is a readable error. Statuses 401/403 (key), 402/432/433 (credits),
429 (rate limit), 5xx, timeouts, non-JSON bodies, and network failures become one
sanitized sentence each — the provider body is never echoed. There is no retry and
no failover, so a bad call cannot double spend.

Secrets never leave the constructed tool: they travel only in a request header
(`x-api-key` for Exa, `Authorization: Bearer` for Tavily), never in the URL or
JSON body. The description, schema, arguments, result, and progress events contain
no key, and every string a provider returns is passed through a redactor built
from **all** configured keys, however short (a page or error that echoes one
becomes `[redacted]`). Redirects are refused, `http(s)` URLs are required in
results, and returned excerpts are untrusted content — the tool description tells
the model to cite them, not follow instructions found inside them.

The adapters are loaded with `import()` on first execution and use `fetch` plus
plain JSON: no SDK dependency, no network work at construction, and the published
build emits one chunk per adapter like the other lazy tools.

### `harness()` — the execution loop

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    primary: 'writer',               // entry point (explicit; first key is the default)
    subagents: ['researcher'],       // optional delegation allowlist
    tools: { webSearch: tool({...}) },
    report: { progress: async (event) => {} }
});
```

| Field | Meaning |
|---|---|
| `agents` | Every brain, keyed by name. **The first key is the entry point** unless `primary` names another one. |
| `primary` | Which agent the callable runs. Optional; must name a registered agent. Use it in multi-agent configs so routing is explicit. |
| `subagents` | Allowlist the primary may delegate to. Optional; defaults to every agent except the primary. Empty (or a one-agent config) means no `agentDelegate` tool at all. Must not contain the primary or an unknown name. |
| `maxIterations` | Model requests one agent run may make before the harness throws. Every request counts: the first answer, each immediate tool continuation, a pause turn, and every completion or timed wake. **Default 16** — the library's runaway guard. Must be a positive safe integer (validated at construction); there is no unlimited value. The app presets set 1000. |
| `forks` | `{ enabled?, maxDepth?, maxConcurrent?, maxHistoryBytes?, maxBranchRecords? }`. `enabled` defaults **true** and registers the core `threadFork` tool. Defaults: depth 2, 4 live branches, 8 MiB serialized branch history, 64 retained records; every numeric bound must be a positive safe integer. |
| `interaction` | `{ actionRequest?: (context, signal) => Promise<HarnessActionChoice>, autoAnswer? }`. Presence registers the core `actionRequest` tool. `autoAnswer` defaults true and only governs a child/fork request's automatic owner fork; it never selects an option by itself. |
| `tools` | Extra tools, keyed by the name the model calls. A configured tool replaces a preloaded preset of the same name. |
| `presets` | Preload `presetTools` into the registry. **True by default**; `false` starts from `tools` alone. |
| `report.progress` | Awaited for every step — a UI or `console.log`. |
| `plugins` | Optional programmatic extension (`createAgent`, `addTool`). |

The registry key is the identity: `writer: agent({...})` names the agent
`writer` and `webSearch: tool({...})` is the name the model calls. You never
repeat the name inside the definition.

| Member | Meaning |
|---|---|
| `writer(input)` | Run the entry agent to completion. Resolves with its message. |
| `writer.name` | The entry agent's name. |
| `writer.agent` | The entry agent. `writer.agent.messages` is the live transcript. |
| `writer.agents` | Every agent, including the entry one. |
| `writer.subagents` | The agents the primary may delegate to, keyed by name. Empty when delegation is not configured. |
| `writer.tools` | The registered tools, including the harness-owned core `toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`, `locationManage`, `agentDelegate` when it exists, `threadFork` when forks are enabled, and `actionRequest` when interaction is configured. |
| `writer.discoveredTools` | Names `toolRequest` has enabled, in discovery order. Read-only copy; `reset()` empties it. |
| `writer.toolCreate(config)` | Host-side runtime creation. Same validation/registry/budget as the model's `toolCreate`; throws `HarnessError`. |
| `writer.executeTool(name, parameters)` | Run one registered tool directly, with this harness's context (`agent`, `agents`, `run`). The server's manual-execution path: discovery gates the model, not the operator, so an un-discovered searchable tool still runs. Reserved policy is kept (`toolCreate` registration, primary-only `agentDelegate`); an unregistered name throws, and `actionRequest`/`threadFork` are refused because they need the owning run. |
| `writer.branches()` | Detached copies of retained branch audit records (`HarnessBranchRecord[]`), newest terminal records within `maxBranchRecords`; active records are never evicted. Ephemeral: not part of the snapshot. |
| `writer.branch(id)` | One detached branch record by id, or `undefined`. |
| `writer.reset()` | Reset the entry agent's conversation, forget discovered tools, and clear `todoManage`, `profileManage`, `chapterManage`, and `locationManage`. Created tools stay registered but are no longer enabled. Branch records and pending questions are ephemeral runtime state and are **not** cleared here. |

### Runtime tool creation

`toolCreate` is core on every agent, and `harness.toolCreate()` is the same path
for a host:

```ts
const upper = writer.toolCreate({
    name: 'upper',
    description: 'Uppercase a string.',
    tags: ['text', 'upper'],
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    source: 'return String(args).toUpperCase();'   // BODY of an async function
});

await upper('abc');   // 'ABC'
```

The model does the same by calling `toolCreate`; the new tool is registered
`searchable` **and enabled at once**, so the next turn can call it without another
discovery round. `source` is compiled at registration and **never executed** then;
it runs when the tool is called, receiving `args` (the parameter value, following
the single-property rule) and `context` (the `ToolContext`). Registering rejects an
invalid name (letter first, then letters/digits/`_`/`-`, ≤64 chars), a reserved or
case-insensitively colliding name, a blank description, more than 16 tags, a
non-JSON-Schema `parameters`, and a body that does not parse. A created SCHEMA is
also traversal-bounded, because it is re-sent on every request: at most 12 levels of
container nesting, 256 nested objects/arrays **anywhere** in the value (`$defs`,
`patternProperties`, or a keyword nobody implements all count), and 16 KiB of
serialized bytes (which is what catches one enormous scalar `description`/`enum`).
Those are size limits only — the validator still enforces just the JSON Schema
vocabulary it documents, so a `$defs` entry is counted, not resolved. Bounds:
description ≤2 000 chars, source ≤20 000 chars, **32 created tools per harness**. Creation is
**session-local**: nothing is written to disk and two harnesses cannot see each
other's tools. The 32-tool budget is per harness for its LIFETIME: `harness.reset()`
clears conversations, discovery, todos and records, but created tools stay
registered (so a session cannot mint an unbounded number of them by resetting), and
only a new harness starts the count again. `toolCreation` configures the capability:
`'all'` (default — `toolCreate` is declared to every agent), `'primary'` (declared to
the primary only; a subagent that guesses the name gets a clear refusal), or `false`
(no model-facing tool at all — the host method `harness.createTool()` still works).

**No sandbox.** A created tool is compiled with the host realm's `Function`
constructor and runs with the process's full permissions — the same trust model as
`commandRun`. There is no isolation, no allowlist, and no network/filesystem fence.

### Delegation

```ts
const team = harness({
    agents: { lead: agent({...}), tester: agent({...}), reviewer: agent({...}) },
    primary: 'lead',
    subagents: ['tester', 'reviewer'],
    report: { progress: console.log }
});

await team('Add a parser and have it reviewed.');
```

Each agent keeps its own `instruction`(s) and transcript; a subagent never sees the
primary's conversation, and only its final `content` comes back. The primary gets
the core `agentDelegate` tool with `{ agent, input }`; it is **not declared to
subagents**, a guessed call from a subagent is rejected, and `run()` refuses to
re-enter an agent that is already running, so delegation is one level deep and
cycles fail fast. `agentDelegate` is not registered at all when there are no
subagents. A tool can still call `ctx.run(name, input)` directly when it needs a
sibling turn mid-tool, but that path is inside one agent's turn rather than
model-visible delegation.

What that means for the shipped roles:

- **The primary delegates; a subagent never re-delegates.** Drop the `summarizer`
  (or `workspace`, or `reviewer`) from a Planner's team and the Planner must do that
  step itself — it cannot ask another subagent to do it.
- **Briefs must be self-contained.** A subagent starts from its own instruction and
  the `input` you give it, nothing else, so the primary must include the goal, the
  paths/areas, the constraints, and the evidence it wants back.
- **Verification is the primary's job.** A delegate result is a claim: the shipped
  profiles tell the primary to check it (read the file, run the check, or send the
  Reviewer) before answering.
- **`textSummarize` is the tool-side exception.** It calls `ctx.run('summarizer', …)`
  when the harness has that agent and condenses the notes locally otherwise, so the
  tool works in every preset (the real teams include `summarizer`; the fixtures do
  not).

#### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    declare                -> core tools + everything toolRequest enabled
    no tool calls?         -> report done, return the message
    schedule each call     -> CONCURRENT async work, not a serial loop
    results stream back    -> each `tool_result` carries its own duration
    wake                   -> `wakeup` once pending work progressed
    append settled results -> then turn() again
```

Tool calls are **scheduled concurrently**. The model stream stays serialized per
agent (one request at a time); calls execute as async work and their results are
appended as they settle. This changes three things a caller must know:

- **The top-level promise is the drain point.** `await writer(input)` resolves only
  when the entry agent's response is complete AND every pending call — delegated
  child runs included — has finished. A per-agent `done` event is one response, not
  terminal session work: it can arrive while that agent's own calls are still
  running (listed in the event's `pending`), and the agent is woken when outcomes
  land (`wakeup`).
- **A periodic wake keeps a turn honest.** While calls are pending the runtime also
  wakes the agent on a timer (default **600000 ms**), so a hung call is visible and
  can be killed instead of blocking forever. There is **no automatic hard tool
  timeout**: pending calls are interrupted, not resumed, on restart, and a hanging
  call ends only through an explicit cancel (or the tool's own configured timeout).
- **Ordering is completion order.** Concurrent side effects are not ordered: two
  file writes or two commands may interleave, and results come back in the order
  they finish, not the order the model asked for them. Tools are async promises
  inside one Node process — **no OS worker or CPU isolation**, so CPU-bound
  JavaScript still blocks the event loop.

Cancellation follows the same model. A run's signal (and `toolCancel({ callId })`
for one call) reaches every running tool; `commandRun` honours it and kills its
process tree. `toolCancel` logically settles/aborts that call's own task: its late
result is ignored. Arbitrary JavaScript cannot be preempted — a created tool keeps
its CPU until it yields. A whole-run abort does more than flip the signal: it
preempts an uncooperative provider request, releases the child actor/restore slot
immediately, and rolls back the cancelled turn's in-flight prompt state without
waiting for the provider. A provider socket/generator that never returns may stay
in memory, but it no longer blocks the actor or re-delegation; a late provider
commit is guarded by the core precommit check. One host-side caveat: a
`report.progress` reporter that hangs can still stall the mailbox (and therefore
cancellation); there is no guaranteed reporter watchdog.

Delegation is the same mechanism: an `agentDelegate` call stays **pending** until
the child fully completes, and the parent's `pending` list names it. Calling the
same child again queues a follow-up on that child's existing transcript instead of
starting a fresh conversation.

Failures split in two:

- **Recoverable** — unknown tool, undiscovered tool, malformed JSON arguments, or a
  throwing tool. Each becomes a tool result the model sees, so it can correct
  itself.
- **Terminal** — a transport failure or more than `maxIterations` model requests
  (default 16; the bundled live presets pass 1000). History is truncated back to
  where the call started and the harness throws, so a failed call is never
  replayed on the next attempt.

`maxIterations` is per agent run — a delegated subagent gets its own budget — and
is validated when `harness()` is called: a value that is not a positive safe
integer throws `HarnessError` immediately instead of failing mid-run.

### Owner questions and history forks

Two conditional harness-owned core tools cover "ask the owner" and "think in a
private copy of this conversation": `actionRequest` and `threadFork`. They are
registered only by the configuration that can answer/run them, and they are the
only tools the manual `executeTool()` path refuses, because both need the live run
that owns the conversation.

#### Owner questions (`actionRequest`)

```ts
const writer = harness({
    agents: { writer: agent({ ... }) },
    interaction: {
        actionRequest: async (context, signal) => {
            // context.request is already parsed and bounds-checked.
            // The recommendation is advisory; choose explicitly.
            return { kind: 'option', optionId: context.request.recommended };
        }
    }
});
```

The model calls exactly this shape (`allowCustom` is **not** a model argument):

```ts
actionRequest({
    question: 'Which target should I patch?',       // 1..4000 characters
    recommended: 'core',                            // MUST match one option id
    options: [
        { id: 'core', label: 'Core module' },       // 2..8 options
        { id: 'ui', label: 'UI layer', description: 'Visible changes' }
    ]
})
// -> { requestId, answeredBy: 'owner' | 'auto',
//      choice: { kind: 'option', optionId, label, description? } |
//              { kind: 'custom', text } }
```

- **Options are bounded and strict.** 2–8 options; each id is 1–32 characters of
  letters/digits/`_`/`-`, unique within the request; each label is 1–120
  characters; `description` is optional and ≤500. Unknown properties are rejected.
  An unknown `recommended` id is an error, never a fallback to `options[0]`.
- **Custom is inherent.** `allowCustom: true` is part of the request type, not a
  model switch. Any owner answer may be
  `{ kind: 'custom', text }` (1..4000 characters), and a handler can always return
  one.
- **The handler answers a root request.** `context` is
  `{ requestId, agent, branchId?, threadId?, callId, request }`; `signal` aborts
  with the run. A handler that throws/rejects fails the tool call with a readable
  error. The default library has **no owner handler**, and the CLI installs one
  that rejects by design; either way a root question is a readable "unavailable"
  result — the recommendation is never selected automatically.
- **A child/fork request is answered by its immediate owner.** The runtime
  materializes a tool-free, single-turn owner fork over the owner's **full history
  plus the requester's full history** at request instant. It must reply with one
  directive line (`option:<id>` or `custom:<text>`); a blank, malformed, or
  tool-calling reply is an explicit failure, never replaced by `recommended`. This
  path needs `forks.enabled` and `interaction.autoAnswer !== false`; because the
  autoanswer branch is tool-free, it cannot fork or ask another question itself.
- **Only the requester's tool result changes.** The answer is delivered as the
  requester's `actionRequest` tool result; the owner's transcript is unchanged. The
  `action_answer` event carries `source: 'owner' | 'auto'` (and `branchId` for an
  automatic answer).
- **Pending questions do not survive.** Cancellation, the end of the turn, session
  deletion/shutdown, or a restart expires every unanswered request; a restart never
  resumes one and a stale answer is a conflict, not a new run. The server allows at
  most four pending questions per session.

On the server, answer one pending question with the only owner-answer route:

```text
POST /api/sessions/:id/actions/:requestId/answer
{ "choice": { "kind": "option", "optionId": "core" } }   // or { kind: 'custom', text }
-> 200 { "ok": true }
```

Statuses: `400` malformed body or an id/text outside the recorded request, `404`
unknown session or request id, `409` already answered or expired. Answering is
**allowed while the session is busy** — the active run is awaiting exactly this
answer. The route only settles the pending promise; it never enqueues a turn.

The UI renders one card per `action_request`. For a root request it lists the
recommended option first, then the alternatives, and **always** a free-text
"Your own answer"; nothing is submitted until the user selects an option or types a
custom answer and presses **Answer**. A non-root (delegation/fork/autoanswer) request is a read-only card,
because its immediate owner answers it automatically. Cards are bound to the
session they were rendered from, and a session switch/turn end/server expiry
disables them with the reason. The server's `action_request`/`action_answer`
events are the source of truth, including on replay. This is a source-level
description; this documentation pass did not verify the card in a browser.

#### History forks (`threadFork`)

```ts
threadFork({ input: 'Audit the parser for edge cases.', label: 'parser audit' })
// -> { branchId, threadId, content }
```

- **Exact history, detached at the request instant.** The fork receives this
  agent's entire committed transcript, its current model value, and its instruction
  snapshot. Tool-call ids are remapped deterministically to provider-safe ids, and
  every still-pending call is paired with an explicit non-success placeholder.
  The source transcript is never mutated.
- **Conversation-only isolation.** A fork shares the source transport and the
  host's external tool side effects (files, commands, network). It is a private
  transcript, **not a sandbox**.
- **Only the summary comes back.** The origin receives one ordinary tool result
  `{ branchId, threadId, content }`; `content` is the fork's final substantive
  reply (trimmed, non-empty). There is no separate summarizer pass and no
  transcript merge. The full branch transcript is available through
  `harness.branch(branchId)`.
- **Inheritance and bounds.** Ordinary forks inherit the source agent's role and
  therefore its core/tool declarations (a fork of the primary can still delegate;
  a fork of a subagent cannot). Forks may nest to `maxDepth` 2, with 4 live
  branches, 8 MiB of serialized history, and 64 retained records by default. The
  history cap is explicit: an over-cap fork fails and **never truncates** the
  source. The cap counts the serialized transcript including attachment payloads,
  so a legal media-heavy turn can exceed 8 MiB; set `forks.maxHistoryBytes` higher
  when such histories must be forkable.
- **Ephemeral audit.** `harness.branches()` / `branch(id)` return detached
  `HarnessBranchRecord` values (`status`, remap map, messages, optional result or
  error). Branch records and their events are runtime/session state, deliberately
  **not** part of snapshot v1: a restart does not restore them.
- **`Agent.fork({ label? })` is the standalone primitive.** It does the same
  materialization without a harness; `reset()` on that fork restores its
  fork-time baseline.

Branch events, and any non-root `action_request`/`action_answer`, carry `thread`
metadata: `thread.kind` is `'fork'` or `'autoanswer'` for a branch (and
`'delegation'` for an ordinary child), with `thread.branchId` equal to the branch
id used by `branch_start`/`branch_end` and `harness.branch(id)`. Root events have
no thread.

### Transport

The default transport is `openAICompatible()`, an SSE reader for
`/chat/completions`. Pass `stream` to an agent to replace it entirely, or
`provider` to configure it:

```ts
agent({
    model: 'x',
    provider: {
        baseURL: 'http://localhost:5500/providers/private/v1',
        apiKey: () => rotateKey(),          // resolved per request
        headers: { 'x-title': 'writer' },
        sampling: { temperature: 0.8 }
    }
});
```

Tool calls are streamed by providers as indexed fragments with partial JSON
arguments. The transport accumulates them and reports complete calls on the
terminal frame — partial arguments are not executable.

`stream_options` is not sent — several gateways reject unknown request fields.
Usage is captured when a provider reports it and left `undefined` when it does
not.

### Model catalogue

`listModels()` performs the sibling lookup the UI needs for a model dropdown:
`GET {baseURL}/models`, using the same URL normalization, bearer auth, and
redaction rules as the chat transport.

```ts
import { listModels, ModelListError } from '@underload/harness';

const ids = await listModels({
    baseURL: 'http://localhost:5500/providers/private/v1',
    apiKey: () => rotateKey(),          // resolved per request
    signal: AbortSignal.timeout(10_000)
});

try {
    // ...
} catch (error) {
    if (error instanceof ModelListError && error.kind === 'configuration') {
        // no request was attempted: blank or non-http(s) base URL
    }
}
```

- Accepts the standard `{ object: 'list', data: [{ id }] }` envelope and a bare
  array; ids are trimmed, empty values dropped, and duplicates removed in
  provider order.
- An empty catalogue resolves `[]` — a UI state, not an error.
- `ModelListError.kind` is `'configuration'` (no request attempted),
  `'request'` (network/TLS/abort), or `'response'` (answered, unusable body).
- The key travels only in the `authorization` header. Error messages are scrubbed
  of it and quote a URL without userinfo or query string, so they are safe to log
  or return over HTTP.
- The harness server retries a failed catalogue request (`'request'` or
  `'response'`, never `'configuration'`): each attempt gets a fresh abort
  deadline of 10 s, 20 s, 40 s, ... doubling up to ten total attempts (the last
  at 5,120 s), and the first success wins. `POST /api/models` therefore answers
  `400` for unusable settings and `502` only after every attempt has failed.

## Progress events

| Event | Payload |
|---|---|
| `start` | `agent`, `model` |
| `reasoning` | `agent`, `delta` |
| `text` | `agent`, `delta` |
| `tool_call` | `agent`, `call` (`id`, `name`, `arguments`) |
| `tool_result` | `agent`, `name`, `content`, `isError`, optional `durationMs`, optional `pending`, optional `ui` (declarative panels) |
| `usage` | `agent`, `usage` (`input`, `output`, `total`, optional `cached`) — one per model request, tool rounds included |
| `done` | `agent`, `message`, optional `pending` |
| `wakeup` | `agent`, `reason: 'pending-tools'`, `pending` |
| `action_request` | `agent`, `callId`, `request` (parsed `HarnessActionRequest`) |
| `action_answer` | `agent`, `requestId`, `answer` (`source: 'owner' \| 'auto'`, optional `branchId`) |
| `branch_start` | `agent`, `branch` (`HarnessBranchSummary`) |
| `branch_end` | `agent`, `branchId`, `status: 'completed' \| 'failed' \| 'cancelled'`, optional `error` |
| `error` | `agent`, `error: { message }` |

Every event names its agent, so multi-agent runs stay readable in one stream. Every
variant also carries an optional `thread` for a non-root invocation:
`{ id, parentId?, callId?, input?, kind?: 'delegation' | 'fork' | 'autoanswer',
branchId? }`. Root events and older recorded turns have none, and a branch's `id`
is its `branchId`, so `branch_start`, `branch_end`, the branch's own frames, and
`harness.branch(id)` share one naming scheme.

With concurrent tools the stream needs three additive fields (all optional on an
older record, so a client must render its pre-concurrency view when they are
absent):

- `tool_result.durationMs` — the authoritative span of the call that just ended,
  measured by the harness rather than inferred from frame arrival (a call may have
  waited behind other work). Every **executed** call reports one, inline/direct
  calls included; a call rejected by argument validation never executes and may
  omit it.
- `pending` — the calls still running at the moment the frame was produced, each as
  `{ callId, name, elapsedMs }`. On `tool_result` it is the remainder after that
  call; on `done` it says the response is complete **while its own calls are not**.
  A `done` with a non-empty `pending` is an interim response: the agent is woken
  later, not finished. The field is **omitted when nothing remains**, so absence
  means "no new information", not "the queue drained".
- `wakeup` — the agent resumed because pending work progressed. It is a resume
  signal, never a result: no tool is resolved by it. Its `pending` list is
  **required**; a frame without one is malformed and must be ignored.

`tool_result.callId` pairs a result with the call it answers; with concurrent calls
the same-name/oldest-first fallback is no longer positional truth. Call ids must be
non-empty and **unique for the whole conversation**: a duplicate or reused id is
rejected before the call is launched, and never reaches persistence.

### Declarative tool panels (R20.2)

A tool can return presentation data without changing what the model reads. Build a
branded envelope with `toolUi(content, panels)` from `@underload/harness`:

```ts
import { tool, toolUi } from '@underload/harness';

tool({
    description: 'Read the current time.',
    tags: ['time'],
    execute: () => {
        const now = new Date();
        const content = { iso: now.toISOString(), unix: Math.floor(now.getTime() / 1000) };

        return toolUi(content, [
            {
                id: 'timeNow',
                slot: 'right', // placement hint; slot names are extensible
                title: 'Current time',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'ISO 8601', value: content.iso },
                            { label: 'Unix', value: String(content.unix) }
                        ]
                    }
                ]
            }
        ]);
    }
});
```

The block shape is **data only** — `{ type: 'text', text }`,
`{ type: 'table', columns, rows }`, or `{ type: 'keyValue', items }`. There is no
HTML, JavaScript, URL action, or callback in a panel.

Transport behaviour:

- the model receives `serialize(content)` exactly as for an ordinary return value;
  the envelope and panels never enter the request/message transcript;
- a `tool_result` event gains an optional `ui: ToolUiPanel[]` (absent for standard
  tools), which flows through the existing SSE frame and the recorded turn, so a
  reload shows the same panels and `eventTimes` stays aligned;
- `POST /tools/:name` (direct and session-bound) returns `{ ok: true, result,
  panels?, durationMs }` — `result` is the underlying content;
- both manual paths share the model budget: a result or error over **64 KiB of
  UTF-8** is returned as the explicit envelope `{ truncated: true, originalBytes,
  budgetBytes, content }` (panels stay on the separate tool-UI limit), and a result
  that fits is returned exactly as before. This is a post-serialization cap: it
  bounds the response/context cost, **not** the process's peak memory;
- the direct runner validates `parameters` with the same schema the model sees, in
  "direct" mode, so both `["src"]` and `{ "paths": ["src"] }` reach the tool and a
  wrong type is an `ok: false` tool error. `parameters: null` means "no arguments";
- a tool created at runtime (`toolCreate`) or added by a plugin lives in its
  session's harness, not in the static catalogue: `POST /tools/:name` with that
  `sessionId` resolves it, any other session answers `404 Tool "<name>" is not
  available in this session.`, and a session-less call answers `404 Unknown tool`.
  For listing, read the session (`GET /sessions/:id`): a created tool is registered
  AND enabled at once, so its name appears in `discoveredTools` alongside the
  discovered catalogue tools. `GET /tools` stays the static catalogue;
- `GET /tools` is unchanged. The shipped `timeNow` tool is the in-app
  demonstration: its API result is still `{ timezone, iso, unix }`, with a
  right-slot key/value panel attached.

The server normalizes and bounds every panel (and `toolUiOf(value)` re-validates at
the unwrapping boundary): at most 32 panels, 64 blocks per panel, 100 table rows,
20 columns, 100 key/value items, bounded text/cell/label lengths, and a 256 KiB
serialized total. Unknown block types, malformed panels/blocks, and non-string
cells are dropped or blanked, and whole panels are dropped if the payload exceeds
the total cap. See `src/core/tool-ui.ts` for the exact `TOOL_UI_LIMITS`.

## Environment file

The Node entry points load one `.env` automatically:

```text
packages/underload/harness/.env
```

`yarn dev:server` (standalone API), `yarn cli --serve` (CLI opt-in) and
`yarn cli` all use the same loader, through `src/server/environment.ts`. The path
is resolved from the package, not the current directory, so launching from the
workspace root still finds it. In this workspace the file is
`D:/Projects/typescript/noobscript/packages/underload/harness/.env`. Copy
`.env.example` to `.env`; the real file is git-ignored.

| Variable | Used by |
|---|---|
| `HARNESS_BASE_URL` | Provider base URL default; CLI `-b` overrides |
| `HARNESS_API_KEY` | Provider key; CLI `-k` overrides. Falls back to `OPENAI_API_KEY` |
| `HARNESS_MODEL` | Model default; CLI `-m` overrides |
| `EXA_API_KEY` | Opt-in `webSearch` for the real presets (`instruct`, `research`, `workspace`, `reviewer`, `planner`) |
| `TAVILY_API_KEY` | Second opt-in `webSearch` provider |

Rules:

- Existing shell/process values win, **including explicitly empty ones**. The file
  only fills keys that are absent; CLI flags win over both.
- A missing `.env` is a no-op: every value has a fallback and search keys are
  optional.
- Loading happens before provider configuration and harness construction, because
  search keys are read once when a harness is created.
- The server reads the file; the browser never does. The UI receives only
  `hasApiKey`, never the key. Nothing aliases these names to `VITE_*`; do not
  prefix a secret with `VITE_`, because Vite exposes such keys to the browser.
- The `@underload/service` host loads the same file lazily, on the first request
  to a canonical route (`src/server/runtime.ts`), not when the endpoint module is
  imported. Discovery therefore stays free of environment reads.
- Editing `.env` needs a restart (`Ctrl+C`, then start again). Server env is not
  hot-reloaded; a fresh terminal or session is enough. `yarn preview:frontend`
  is only the static UI and does not read `.env`.

## CLI

The CLI runs a preset in-process. No UI, no HTTP server, no browser. It runs from
this package's source through the workspace script; the published package remains
the library.

```bash
yarn cli --list                                     # five real presets, then the examples
yarn cli "Write an opening."                        # default preset: instruct (live)
yarn cli --preset demo "What time is it?"           # explicit offline scripted fixture
yarn cli --preset planner "Plan the release."       # plans, then delegates to its specialists
yarn cli --preset workspace --model merge/ds4-flash --base-url http://localhost:5500/providers/private/v1
yarn cli --preset research --model merge/ds4-flash --base-url http://localhost:5500/providers/private/v1
yarn cli                                            # interactive Instruct session (TTY)
echo "Summarise this" | yarn cli                    # one task from stdin
```

The Coder card is the `workspace` preset (the id is kept for saved sessions and
bookmarks; `--list` shows the pair). The default is the real `instruct` role, not
the demo: a scripted answer is not a useful general harness. `demo` remains the
explicit endpoint-free fixture (`--preset demo`), and there is no silent fallback
to it when a provider is unreachable. A live role uses `--base-url` /
`HARNESS_BASE_URL` (plus `--api-key` / `HARNESS_API_KEY` when the provider needs
one); if the run cannot reach the provider, it reports the failure rather than
inventing a demo transcript.

| Flag | Meaning |
|---|---|
| `-p, --preset <name>` | Preset to run (default `instruct`; `demo` is the offline fixture) |
| `-m, --model <model>` | Model for live presets |
| `-b, --base-url <url>` | OpenAI-compatible base URL |
| `-k, --api-key <key>` | Provider key; defaults to `HARNESS_API_KEY` |
| `-l, --list` | List presets |
| `--tools` | List every tool the catalogue can call |
| `--json` | One `HarnessEvent` per line, plus a terminal `run_error` on failure |
| `--serve` | Start the HTTP server (and the built UI when present) |
| `--port`, `--host` | Server bind address (default `127.0.0.1:5181`) |
| `--no-color` | Disable ANSI colour |

In an interactive session, `/reset` clears the conversation, `/tools` and
`/presets` print the catalogues, and `/exit` quits. `HARNESS_BASE_URL`,
`HARNESS_API_KEY`, and `HARNESS_MODEL` provide the same defaults as the flags;
they can come from the shell or from the package-root `.env` (see
[Environment file](#environment-file)). `EXA_API_KEY` or `TAVILY_API_KEY` enables
the opt-in `webSearch` tool in the live presets (`instruct`, `research`,
`workspace`); with neither key it is simply absent.

Because tools run concurrently the CLI prints their own timing rather than
implying a call is the only thing happening:

```
→ fileRead {"path":"README.md"}
← fileRead · 1.3s
  ...
  pending · webSearch 900ms
  instruct-model · tool_calls · 1 tool call · 1 tool still running
~ instruct woke · 1 still running · webSearch 900ms
```

`← name · 1.3s` is the server's `durationMs`; a `pending · …` line lists calls still
running and their elapsed spans; `~ agent woke · …` is a `wakeup`. A `done` line
ending in `N tools still running` is an interim response, not the end of the turn.
`--json` emits each event verbatim (including `wakeup`), so a consumer sees the
same fields.

## Server and UI

The UI is a client. It does not import the harness package, construct a harness,
or execute a tool. Every action is a request to the server: a task submit is the
`202` JSON accept from `POST /tasks`, and its live progress arrives on the
session's `GET /events` SSE stream as the same `report.progress` events a CLI
prints. The server, not the browser, keeps the queue and the transcript.

On a phone (`max-width: 860px`) both side rails start **collapsed** and the topbar
grows one toggle per rail; opening one closes the other, and a backdrop click or
`Escape` dismisses it. The rails stay in the DOM (CSS only hides them), so their
content and state survive opening and closing, and every wider layout ignores the
toggle state and shows both rails permanently.

```bash
yarn build:frontend       # UI -> src/frontend/dist (base /, standalone/static hosts)

yarn start-service        # repo root: builds UI for /harness/, serves UI + /v1/harness on :5000
yarn dev:frontend         # Vite on all interfaces, dual-stack (localhost + LAN); /api proxies to the running service
yarn preview:frontend     # built UI on :5180 (loopback only); same /api proxy

yarn dev:server           # optional standalone API on :5181 (no Vite, no UI)
```

`yarn start-service` (root `package.json`) builds the UI first with
`PLAYGROUND_BASE=/harness/` and `VITE_HARNESS_API=/v1/harness`, then imports the
service entry without changing the repository-root cwd. That build is the one the
gateway mounts; use the root `yarn build:harness-ui` script to rebuild it without
starting the gateway. A default `yarn build:frontend` build (base `/`) is for the
standalone server or a static host, not the gateway.

`yarn dev:frontend` starts **only Vite**. It never imports or calls
`startHarnessServer`; its `server.proxy` (and `preview.proxy`) maps the client's
default `/api` root onto the service mount at `http://127.0.0.1:5000/v1/harness`.
Start the service first (see [Service host](#service-host-v1harness)), or override
the root with `?apiRoot=` / `VITE_HARNESS_API` (see “Connecting the UI to the
service” below).

**LAN development (R7/R8/R11).** The dev server binds the IPv6 wildcard (`::`), which
Node opens dual-stack, so **one** listener answers `http://localhost:5180/`,
`http://127.0.0.1:5180/` and the LAN Network URL — the same machine can use either
loopback form while a phone or another trusted machine uses the LAN one. Restart the
backend and Vite after pulling this change:

```bash
yarn start-service       # terminal 1: gateway + /v1/harness on :5000
yarn dev:frontend        # terminal 2: Vite on all interfaces (dual-stack)
```

Then open the **Network** URL Vite prints, e.g.
`http://192.168.1.20:5180/`, from the other device. If :5180 is already busy, Vite
starts on the next free port (usually :5181) — use the port in the printed
`Network:` line, not the `Local:` one. The backend must be running first: Vite
serves only the UI and proxies `/api`, so a stopped service gives a proxy error,
not a UI-only page. Keep `HARNESS_DEV_API` unset for the normal gateway; when you
do set it, Vite proxies to that mount and stamps its origin on the outgoing
request, so a custom target must still be reachable from the machine running
Vite.

**If `Network` works but `Local` (`http://localhost:5180/`) does not**, another
process owns `::1:5180` and answers with its own page or 404. `localhost`
resolves to `::1` first on Windows, and Windows lets one process keep
`0.0.0.0:5180` while another keeps `::1:5180` — a specific address keeps winning
over a later wildcard bind — so Vite neither errors nor falls forward. List the
owners and stop the stale one (a leftover `yarn dev:frontend`,
`yarn preview:frontend` or another project's Vite):

```powershell
Get-NetTCPConnection -LocalPort 5180 | Where-Object State -eq Listen |
    Select-Object LocalAddress, OwningProcess
```

Only the harness dev server should be listening; anything else on `::1:5180`
takes `localhost` away from it. The fix is a restart with only one owner — no
hosts-file, firewall or DNS change is needed.

The proxy rewrites the outgoing `Origin` to the target's own origin (for the
default target, `http://127.0.0.1:5000`) while `changeOrigin` makes `Host`
match. That keeps the existing service Origin gate intact for a LAN browser (its
`http://<LAN-IP>:5181` origin is never forwarded as-is) without widening the
service's CORS or loopback allowlist. This is Vite-only: `preview:frontend`
stays loopback-bound.

There is **no authentication**. A LAN device that can reach the Vite port can use
the UI and therefore drive the unsandboxed harness tools through the proxy; the
gateway on :5000 is equally trusted. Only do this on a network you trust, allow
the Vite port through the firewall for that network (the OS may prompt when Vite
first binds the wildcard address), and close the terminal when finished.

`yarn dev:server` is the separate, explicit standalone API launcher
(`src/server/dev.ts`): it binds the Node server on `127.0.0.1:5181` with static
serving disabled and starts no Vite or UI. It accepts `--port`, `--host`, and
`--database-root <path>` (the same option as
`startHarnessServer({ databaseRoot })`). Normal hosting is still owned by
`@underload/service`; there is deliberately no generic `serve`/`start` alias.

To run the UI against that standalone API instead of the service, point Vite's
proxy mount at it (a shell variable, read by `vite.config.ts`):

```bash
HARNESS_DEV_API=http://127.0.0.1:5181/api yarn dev:frontend
```

The default stays `http://127.0.0.1:5000/v1/harness`, so ordinary development
needs no extra variable when the service is running.

The catalogue lives in `src/server/harnesses/`. Both entry points use it. Every **live**
preset is built by the same factory (`src/server/harnesses/toolbox.ts`), so the registered
toolbox is identical: all eight package tools (`syntaxCheck`, the five file tools,
`commandRun`, `gitDiff`), the app tools (`timeNow`, `textCount`, `diceRoll`,
`noteSearch`, `textSummarize`), opt-in `webSearch`, and the harness-owned core tools
(`toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`,
`locationManage`, plus `agentDelegate` only when the preset declares a subagent,
`threadFork` when forks are enabled, and `actionRequest` when the host supplies an
interaction handler).
R18 splits declarations: the four core file tools and a
configured `webSearch` are always declared, while `fileList`, `commandRun`,
`gitDiff`, `syntaxCheck`, and the app tools are discovered. Choosing a harness
changes the agents, not the tools.

Agent identities live in **`src/agents/`** as trusted `AgentProfile` values:
`instruction` plus a `guidelines` list. The runtime seeds both — an identity system
message and one composed `Guidelines:` block — so the definition a UI renders and
the prompt a model receives are the same text. A client can select an agent id; it
can never supply instruction text.

### The five real presets

| Preset | Visible title | Role |
|---|---|---|
| `instruct` | Instruct | **Default card.** General instruction-following with the full toolbox. |
| `research` | Researcher | Investigates and cross-checks evidence; cites tools and URLs. |
| `workspace` | Coder | Coding: reads, edits, runs checks, reviews its own diffs. |
| `reviewer` | Reviewer | Skeptical pass for small bugs and inconsistencies; non-mutating by default. |
| `planner` | Planner | Writes the plan and acceptance criteria, then routes each step to a specialist and verifies it. |

Every real preset's team is **symmetric**: each one lists every *other* real role
plus the `summarizer` as a direct subagent (`teamOf()` in
`src/server/harnesses/presets.ts`). So switching the entry role never removes a
specialist, and the Planner's `research`/`workspace`/`reviewer` targets exist by id.
Delegation is **one level deep** and a subagent never receives `agentDelegate`; the
profiles say so, and none of them asks a subagent to delegate again.

The two remaining entries are examples, not the headline choice (they are listed
after the real presets, and the UI selects `instruct` first):

| Preset | Shape |
|---|---|
| `demo` | Scripted offline template — no endpoint needed; discovers `timeNow` with `toolRequest`, calls it, then answers. Deliberately not a live harness, so it uses timeNow only. Editable: metadata edits keep the script; an executable edit upgrades it to a live profiled harness. |
| `flaky` | The shared toolbox plus a tool that throws two calls out of three, to show recoverable failures. Editable: metadata edits keep `testFlaky`; an executable edit rebuilds the live toolbox with it retained. |

`flaky` is the only preset-specific extra tool: it is excluded from the shared
toolbox because it fails on purpose and keeps attempt state. All seven entries are
templates the registry copies; there is no read-only category (R20.1). Legacy
identifiers still resolve: `writer` and `assistant` → `instruct`, `researcher` →
`research`. They are aliases, not extra cards, and a session created through one
reports the canonical name. The visible title "Coder" keeps the `workspace` id —
adding a new reserved alias could collide with an existing user-created harness on
restart, so the title carries the name instead.

The server keeps one harness per session, so submitting a second task continues
the same conversation. `POST /api/sessions/:id/tasks` accepts a task with
`202 { session, turn }` and the server runs it FIFO behind anything already
pending, so tasks execute in submission order even when they arrive while a run
streams. **Team membership and the descriptor snapshot are frozen at
session creation**: the preset object and a `harnessDefinition` are captured, so a
later create/patch never changes which agents a running session has, its primary,
or the history it reports. The UI's Endpoint panel is sent when a session is
created; changing it starts a fresh session on the next run.

One field is deliberately not frozen: an agent's **model**. `PATCH
/api/sessions/:id` with `{ agentModels: { <agent>: <model> } }` retargets an
existing session in place (see the session table below). The map MERGES into the
live map, every key must name a member of that session's harness, values are
validated like a harness override, and the whole patch is all-or-nothing. It is
allowed while a run streams: the in-flight request keeps the model it started
with (the assistant message it commits names that model), and the **next request**
of that agent uses the new one — including a queued task, whose request starts
after the patch. Nothing is aborted, rebuilt, or replayed, and the
frozen `harnessDefinition.agentModels` remains the creation-time record. Team
editing (primary/subagents) still applies to the next session you start. Sessions
are in memory and are lost when the server restarts. Created tools live in the
session's harness: they survive `reset()` (which clears the conversation,
discovery, `todoManage`, and the three record stores) and disappear with the
session.

Every submit — queued (`/tasks`) or legacy (`/messages`) — is also the server's
record: every task becomes a `SessionTurn` (id, index, prompt, status, timestamps,
every event the run produced, a parallel `eventTimes` array of epoch-ms stamps,
and a `usage` tally summed from the per-request `usage` events — `input` with the
cached part in `cached`). A queued task is a turn immediately: `status: 'queued'`,
a stable `id` and `index`, and **no `startedAt`** until the server pump begins it,
so a client can render the backlog before execution. `GET /api/sessions` and `GET
/api/sessions/:id` always include the full `turns` array, so a browser reload — or
a second client — renders the same transcript, the same per-step/per-tool elapsed
time, and the same token count without having seen the stream. A turn that is
still running (or still queued) is included too, which is what the UI reattaches
to through `GET /api/sessions/:id/events`, with snapshot polling as its fallback.
A snapshot's `queueDepth` counts waiting turns only — the active turn is not in it
— and is omitted when the queue is empty, so pre-queue snapshot shapes are
unchanged. Each snapshot also carries `harnessDefinition` (the frozen descriptor:
members, primary, and the models the session was created with), `agentModels`
(the session's LIVE effective model of every agent — overrides resolved,
rewritten by a session PATCH, so a per-agent dropdown survives a reload and shows
what the next request will use), and `discoveredTools` (what `toolRequest` had
enabled), so a reload loses neither the configuration nor the discovery state.

`/api` is the standalone mount. The `@underload/service` host serves the same
resource paths below `/v1/harness` and adds a bootstrap document at its root; see
[Service host](#service-host-v1harness) below.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness and session count |
| `GET /api/harnesses` | Harness descriptors (`primary`, `subagents`, `coreTools`, `agentModels?`, `builtin`, `editable`), provider defaults, and the trusted `agents` list. Every entry is an editable application copy; `editable` is always `true` (compatibility only) |
| `POST /api/harnesses` | Create a harness from trusted agent ids — body `{ name, title?, description?, primary, subagents?, agentModels? }` → `201 { harness }` |
| `PATCH /api/harnesses/:name` | Change any harness — body `{ title?, description?, primary?, subagents?, agentModels? }` → `{ harness }` |
| `GET /api/agents` | The trusted agent registry (`name`, `title`, `description`, `instruction`, `guidelines`) |
| `GET /api/tools` | The whole tool catalogue, session-bound core tools first (`toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`, `locationManage`, `agentDelegate`, `actionRequest`, `threadFork`) then every direct-call tool (including the core file tools); `webSearch` always appears with `availability` |
| `GET /api/tools/bootstrap` | Alias of `GET /api/tools` (the list the root bootstrap document carries) |
| `POST /api/tools/:name` | Call one tool on the server. A session-bound tool (`toolRequest`, `toolCreate`, `todoManage`, `profileManage`, `chapterManage`, `locationManage`, `agentDelegate`, `actionRequest`, `threadFork`) needs `sessionId`; every other tool - including the core file tools - keeps its session-less runner. `actionRequest`/`threadFork` are refused because they need the owning run. An unconfigured tool returns `ok: false`. See [the call body](#the-tool-call-body) |
| `POST /api/tools/:name/call` | Alias of the row above (verb-named spelling), same dispatcher |
| `POST /api/models` | Server-side `GET {baseURL}/models`; returns `{ models: string[] }` for the UI dropdown |
| `POST /api/sessions` | Create a session for a preset |
| `GET /api/sessions`, `GET /api/sessions/:id` | List or read sessions |
| `PATCH /api/sessions/:id` | Retarget models in a live session: body `{ agentModels: { agent: model } }` → `{ session }`. Merges into the live map, validates every key/value, applies all-or-nothing, and is allowed while the session is running (the next request uses the new model; the current one keeps its own). See [Server and UI](#server-and-ui) |
| `POST /api/sessions/:id/messages` | Legacy submit; response is `text/event-stream`. This response OWNS the run: a disconnect cancels it, and a busy session or a pending queue is a `409`. New clients should prefer `/tasks` + `/events` |
| `POST /api/sessions/:id/tasks` | Queue a task (`{ input }`) → `202 { session, turn }`. The turn is `queued` with a stable id/index and no `startedAt`; the server pump runs the backlog FIFO (cap 100 pending) and continues after a task fails. In memory only |
| `GET /api/sessions/:id/events` | Watch the session: `text/event-stream` opening with one `snapshot`, then `turn` upserts (queued → running → terminal) and `event` frames, then one final `snapshot` when the queue drains. A disconnect only unsubscribes; server-owned tasks keep running |
| `POST /api/sessions/:id/reset` | Reset every agent and clear discovery, todos, and the three record stores; `409` while a run or queued work is pending |
| `POST /api/sessions/:id/cancel` | Optional `{ all?: true }` → `{ cancelled }`. Default cancels the active run only; `all: true` (the UI Stop button) also cancels every queued turn, which stays in `turns` as a `cancelled` row |
| `POST /api/sessions/:id/actions/:requestId/answer` | `{ choice: { kind: 'option', optionId } \| { kind: 'custom', text } }` → `{ ok: true }`. Settles one pending `actionRequest`; allowed while the session is busy. `400` invalid/unknown option, `404` unknown session/request, `409` answered or expired |
| `DELETE /api/sessions/:id` | Forget a session: abort active work, drop queued work, and close its watchers |

#### The tool call body

`POST /api/tools/:name` always takes **one wrapper object with a `parameters`
property**; `{ "parameters": {} }` is a valid argument-less call, and a body without
`parameters` is a `400`. What `parameters` HOLDS depends on the tool's schema, and the
two forms are not interchangeable:

```jsonc
// fileList declares ONE property, so the value IS that property (the same unwrapping
// a model call gets and a direct call passes):
POST /api/tools/fileList   { "parameters": ["src", "task"] }

// its schema, as listed by GET /api/tools, is still an object:
{ "type": "object", "properties": { "paths": { "type": "array", … } }, … }

// a multi-property tool takes the whole object, because there is nothing to unwrap:
POST /api/tools/fileGlob   { "parameters": { "patterns": ["**/*.ts"], "paths": ["src"] } }
POST /api/tools/toolRequest { "parameters": { "tags": ["files"] }, "sessionId": "…" }
```

The single-property tools are `fileRead`, `fileWrite`, `fileEdit`, and `fileList`;
`fileGlob`, `syntaxCheck`, `commandRun`, `gitDiff`, and every core tool carry several
properties. `fileRead`'s single `paths` property still accepts range objects as its
ITEMS (`{ "paths": [{ "path": "big.ts", "startLine": 400, "maxLines": 50 }] }`), so
per-file windows do not add a second top-level property and the unwrapping rule is
unchanged. `fileList` normalizes the tolerated "no preference" shapes itself
(`undefined`, `null`, `{}`, and a `{ "paths": [...] }` wrapper all mean `["."]`), so an
empty argument box and a model-shaped body agree, while an explicit `[]` is still an
error.

**Harness creation and overrides.** `POST /api/harnesses` adds a live harness
built from trusted agents and the shared toolbox; `PATCH` changes any harness,
including the shipped templates (`instruct`, `research`, `workspace`, `reviewer`,
`planner`, `demo`, `flaky`). Every entry is an editable template copy;
`editable` remains on the wire for compatibility and is always `true`. A
metadata-only `PATCH` (`title`/`description`) preserves the template's captured
factory — the scripted `demo` keeps its offline script and `timeNow`-only registry,
and `flaky` keeps its `testFlaky` extra. An executable `PATCH`
(`primary`/`subagents`/`agentModels`) rebuilds the harness: `demo` becomes an
honest live profiled harness (shared toolbox, requires an endpoint), and `flaky`
rebuilds the live toolbox while retaining `testFlaky`.
`builtin: true` still marks provenance. There is no delete; with a database root
the registry is restored from `<root>/harness/state.json` (see Persistence), and
without one it is in memory only. Registry edits affect FUTURE sessions only,
because a session freezes its captured preset and descriptor at creation. Both
routes validate the request — exactly one primary, known agent ids only, no
duplicate ids, reserved aliases
(`writer`/`assistant`/`researcher`) and existing names rejected, bounded
title/description — and reject unknown fields, so a client cannot supply
instruction text, a provider, or a tool list.

**Saved registry rows and improved defaults.** A restart replays the registry rows
saved in `state.json`, but a shipped default may improve between builds (T3 widened
the real presets' teams and retitled `research`/`workspace`). The conservative rule:
a built-in row whose executable fields (primary, subagents, agents, tools,
environmentTools, template, and an empty `agentModels`) still match the previously
shipped definition recorded in `LEGACY_PRESET_DEFINITIONS`
(`src/server/harnesses/presets.ts`) is treated as an unmodified default and is
refreshed to the current template. A row that differs in ANY executable field — or
that carries per-agent models — is a real customisation and is replayed exactly as
saved. A title/description the operator edited is preserved across a refresh.
Frozen sessions are never rewritten: each session restores from its own recorded
preset and descriptor, so an old conversation keeps the team it started with.

`agentModels` is the one model-shaped field: a map of **selected agent id → model
id**, e.g. `{ "summarizer": "small/fast" }`. A member it omits uses the session's
`settings.model`, so a dropdown can show "default". Values are trimmed, non-empty,
at most 200 characters, and free of control characters; keys must belong to the
resulting `[primary, ...subagents]` set or the request is a `400` naming the members.
Only ids are overridable — never a provider, base URL, or key. On `PATCH` the map
REPLACES the previous one, so `{}` clears every override; changing membership
without restating the map drops the overrides of agents that are no longer selected.
The factory closure captures the map, so a harness edit never rewrites an existing
session: those models change only through `PATCH /api/sessions/:id` (which merges
and never touches the frozen definition).

`POST /api/models` takes `{ settings?: { baseURL?, apiKey?, model? } }`. It exists
because the browser must not hold the server key and providers rarely send CORS
headers; the server performs the request with the merged settings and returns ids
only. A blank `baseURL` is `400`, a provider failure or unusable body is `502`, and
an empty catalogue is `200` with `{ "models": [] }`.

Every request must send `X-Harness-Client: ui`. The browser UI does this on every
call; a foreign page cannot set the header without a CORS preflight, which the
server does not answer. A `curl` client must add it explicitly.

Each SSE `data:` frame is one of:

```ts
| { type: 'turn'; turn: SessionTurn }               // legacy: opens the run;
                                                    // watch: an UPSERT by turn id
| { type: 'event'; turnId; event; at?; usage? }     // `at` = epoch-ms stamp,
                                                    // `usage` = running tally
| { type: 'snapshot'; session: SessionSnapshot }    // complete state
| { type: 'failed'; error; session }                // legacy run failed
```

The legacy `POST .../messages` stream owns its run: closing the response aborts it.
The `GET .../events` watcher stream reuses the same shapes but never owns
execution — `turn` is an upsert for the queued, running, and terminal state of one
id, it opens with one `snapshot`, and it ends with one `snapshot` when the queue
drains. Closing the watcher only unsubscribes; the server pump keeps running for
nobody, which is why a reload or a hidden tab costs nothing.

### Task queue, timeline, and message rendering (R4/R5)

- **The queue is server-owned and FIFO.** `POST /tasks` returns `202` immediately;
  the pump runs one task at a time, in order, and continues after a per-task error.
  With a database root the backlog is durable and queued prompts survive a restart
  (paused until an explicit submit or a cancel-all); without one it is in memory
  only and a restart loses the sessions, their turns, and any queued work. A
  single-flight gate is shared by a queue turn, a legacy run, a manual tool call,
  and a reset; the pump waits for it, while the legacy/manual paths answer `409`.
- **The UI can keep submitting.** Run stays enabled while a task runs (only the
  short `POST /tasks` round trip locks it), Stop is enabled whenever work is
  pending, and Stop sends `{ all: true }` so both the active task and the retained
  queue are cancelled. Reset, New session, and tab switches stay locked while work
  is pending; switching harness or session is allowed and only unsubscribes the
  observer, because the work belongs to the server.
- **Reload and switching recover from the record.** Selecting a session that still
  has work opens one `GET /events` observer (a submit also opens or reopens it); a
  lost stream falls back to `GET /sessions/:id` polling at 1 s (up to about two
  minutes), and a reload re-reads the snapshot, reconciles turns by id, and reopens
  the observer when work is still pending. A settled turn never re-animates, and a
  queued task lights nothing.
- **A turn stays `running` while background work is pending.** `done` is per
  agent response; the turn settles only when the harness promise resolves, which is
  after every pending tool call and delegated child has finished. The UI therefore
  keeps running tool cards across an interim `done` (a non-empty `pending` list),
  prints `pending · name 1.2s` from the server's own spans, and paints a wake line
  when a `wakeup` arrives; the agent ring stays lit meanwhile. That pending line is
  a **static snapshot** of the last frame that reported it, not a ticking clock; a
  finished call is removed from it by id as its own result arrives, and the
  `N tools still running` count is visible in the expanded tile's meta (compact
  rows clip the meta visually, as they do the status word). The periodic wake
  (600 s) exists so a hung call stays visible and can be killed rather than
  silently blocking the turn.
- **The timeline shows state by colour.** One linear vertical timeline: completed
  rows are grey, the single active row is green (amber while a request is on the
  wire), queued rows are neutral, failed rows are red, and cancelled rows are
  muted. The active row is the only one that pulses.
- **Assistant text is safe, highlighted Markdown.** GFM is rendered with `marked`,
  always passed through `DOMPurify` (scripts, handlers, `javascript:` URLs, frames,
  and media are removed), and fenced code is highlighted by `highlight.js` core
  plus a registered language subset. A fence keeps its author language as a CSS
  caption, and response typography plus inline code carry the accent styling.
  This is a source-level description; this documentation pass did not verify
  rendering in a browser.

The sidebar's **Tools** tab lists the whole catalogue — the session-bound core tools
first, then every direct-call tool — and calls `POST /api/tools/:name` for all of
them. Execution is server-side only; nothing in the browser runs a tool. The
direct-call entries really run there, so the path exercises the same `execute` a
session registers, including `commandRun`, the file tools, and a configured
`webSearch` (they may be `visibility: 'core'` but are not session-bound). The
**Core tools** group is different by design: those entries are `sessionBound`, their
call must carry the selected `sessionId`, and they execute inside that session's
harness, so a manual `toolRequest`, `toolCreate`, `todoManage`, `profileManage`,
`chapterManage`, `locationManage`, or `agentDelegate`
call changes the conversation the user is looking at (and is refused with `409` while any session
operation is in flight: a chat turn, queued work, a reset, or another manual call). A manual
call is not a turn - it never changes `status` or appends a turn, only a private
single-flight flag while it runs. A session model PATCH is the exception: it is a
model choice, not a harness mutation, so it is accepted while a run streams and
aborts nothing.
`agentDelegate` is listed for every host but only exists in a session whose harness
allows subagents; otherwise the call answers a clear `404`. `actionRequest` and
`threadFork` are likewise listed (conditional in a session), but a manual call is
refused because both need the run that owns the conversation. The **Web search** group
shows whether this server has `EXA_API_KEY`/`TAVILY_API_KEY`; an unconfigured entry
keeps its schema and example arguments visible but disables **Call tool** and prints
the server's hint, so it never looks like a working tool.

**Cancellation is cooperative and signal-based.** Aborting a run
(`POST /sessions/:id/cancel`, `DELETE /sessions/:id`, or a closed legacy stream)
signals every call that is running, and `toolCancel({ callId })` targets one call.
`toolCancel` logically settles/aborts that call's own task; its late result is
ignored. `commandRun` honours the abort signal and kills its process tree, and
`ToolContext.signal` is the same signal a tool can watch. Arbitrary JavaScript
cannot be preempted: a created tool keeps its CPU until it yields. A **whole-run
abort** additionally preempts an uncooperative provider request, releases the
child actor/restore slot and rolls back the cancelled turn's in-flight prompt
state immediately, so re-delegation is not blocked. A provider socket/generator
that never returns can stay in memory, but a late provider commit is rejected by
the core precommit check. One caveat: a host `report.progress` reporter that hangs
can still stall the mailbox and therefore cancellation (there is no guaranteed
reporter watchdog). The server never reports a cancel it did not achieve. A
settled turn abandons calls that never returned, so a cancelled transcript never
leaves a card looking like it is still running. A manual call has no
turn/controller, so `cancel()` does not abort it; only its own completion releases
the gate.

`--tools` (and `/tools` in an interactive CLI session) uses the same runtime
catalogue and appends `[unconfigured — …]` to an entry that needs a missing key.

**No sandbox.** The standalone server binds to `127.0.0.1` by default and has no
CORS layer, which is what keeps a same-origin UI simple. It is still a process with
the server's permissions: `workspace`, `commandRun`, `fileWrite`, and direct tool
calls can change the host. Do not expose it to a network you do not trust. The
service host is stricter in transport but not in trust: `0.0.0.0` plus permissive
CORS, with only the loopback/same-host Origin gate described above. Serving the
UI at `/harness/` on that LAN bind does not add authentication: anyone who can
reach the port can use the page and its API, so keep it on a trusted LAN and
allow the port through the firewall only there.

`src/frontend/vite.config.ts` no longer aliases `@underload/harness` or stubs
`node:`: the browser bundle never reaches the package. `yarn dev:frontend` starts
Vite only and proxies `/api` to the service gateway; `yarn dev:server` is the
separate standalone API launcher (explicit, no Vite). Production hosting is the
service gateway below.

### Service host (`/v1/harness`)

The same API can be hosted by `@underload/service` (the repository's Hono
gateway) instead of the standalone Node server. Nothing in this package starts a
listener for it: the service loader scans the repository root for `endpoint` /
`endpoints` folders, finds `packages/underload/harness/src/server/endpoint/harness/`, and
imports the two discovered modules:

| Module | Route | Job |
|---|---|---|
| `src/server/endpoint/harness/service-route.ts` | `/v1/harness/*` | everything below the mount |
| `src/server/endpoint/harness/service-route-root.ts` | `/v1/harness` | the bare bootstrap document |

Neither module declares a `port`, so both run **in place on the gateway's single
listener**. A port would move the endpoint onto an isolated worker and answer
clients with a 307 redirect; the harness API is cheap to host in-process and must
share the service's port. The route modules only describe a URL and a handler —
`src/server/runtime.ts` creates the `.env`-loaded store and catalogue lazily on the
first request, and every route shares that one store, so a session created through
one route is visible through the other.

Start it from the repository root with `yarn start-service`. The root launcher
first builds the UI for the gateway prefixes (`/harness/` page base,
`/v1/harness` API root) and then imports the service entry without changing the
repository-root cwd, so harness tools keep resolving the repository as their
project root. That entry scans the repository root, so the two modules above are
discovered. The frontend dev launch expects this service (its `/api` proxy
targets `http://127.0.0.1:5000/v1/harness`). This package ships no generic
`start`/`serve` script: the gateway owns the normal listener, and nothing starts
a harness server implicitly. `startHarnessServer()` remains an explicit API; the
separate `yarn dev:server` entry runs it API-only on `127.0.0.1:5181` when a
standalone process is wanted, and an embedder can still serve
`src/frontend/dist` through `startHarnessServer({ staticRoot })`.

The gateway serves both the API and the UI on one listener: the API at
`/v1/harness` and the built page at `/harness/`. The service entry itself stays
API-only by default (the unchanged `yarn workspace @underload/service start`
needs no UI build); the root launcher sets `UNDERLOAD_HARNESS_UI=1` after
building, which opts into the validated `/harness` mount. Locally open
`http://localhost:5000/harness/`. The service still binds `0.0.0.0` and logs its
LAN addresses, so another device on the same router can open
`http://<LAN-IP>:5000/harness/`; allow TCP port 5000 through the host firewall
first. The page's API calls are same-origin, so the existing Origin gate applies
unchanged — a browser origin that is neither the same host nor loopback still
gets a 403; this feature does not broaden the service's Origin/CORS policy.
There is **no authentication**: anyone who can reach port 5000 on the LAN can
create sessions and drive tools, so use this only on a trusted network.

`GET /v1/harness` is the canonical bootstrap document:

```json
{
    "rootPath": "/v1/harness",
    "presets": [{ "name": "demo", "title": "…", "requiresEndpoint": false, "primary": "demo", "subagents": [], "agents": ["demo"], "tools": ["timeNow"], "coreTools": ["toolRequest", "toolCreate", "todoManage", "profileManage", "chapterManage", "locationManage", "threadFork"], "builtin": true, "editable": true }],
    "agents": [{ "name": "instruct", "title": "Instruct", "description": "…", "instruction": "…", "guidelines": ["…"] }],
    "tools": [{ "name": "toolRequest", "group": "Core tools", "tags": ["discovery"], "visibility": "core", "sessionBound": true, "parameters": {}, "availability": { "state": "available", "hint": "Runs inside a session harness: send a sessionId with the call." } }, { "name": "fileRead", "group": "Package presets", "tags": ["files"], "visibility": "core", "parameters": {} }],
    "defaults": { "baseURL": "…", "model": "…", "hasApiKey": true },
    "sessions": []
}
```

`rootPath` is the **API URL this document was served from**, not a filesystem
path. There is deliberately no advertised workspace root: the file and command
tools resolve relative paths against the server process's working directory
(`process.cwd()`) and have no sandbox or fence, so a file-root option would
promise behaviour the tools do not implement. The service's `variables.root` is
the shared database/storage boundary: the harness endpoint uses it as the durable
database root (below `<root>/harness/`), never as a workspace.

### Persistence (`DATABASE_ROOT`)

The harness API is durable when the host supplies a database root. The service
does this in `packages/underload/service/server.ts`: `DATABASE_ROOT` is passed as
`variables: { root: DATABASE_ROOT }`, the loader forwards it as the handler's third
argument, and `createHarnessServiceHandler` selects a runtime keyed by that
resolved root. Two different roots therefore never share a store, and a supplied
root is never silently ignored (an invalid value is a clear 500 / startup error).
The standalone server uses the explicit `startHarnessServer({ databaseRoot })`
option; omitting it keeps the previous in-memory behaviour (and direct unit
tests need no disk).

One versioned document lives at `<root>/harness/state.json` and holds:

- the harness registry metadata (shipped copies and user-created entries);
- every session: identity, the **frozen** preset metadata + descriptor it was
  created with, provider settings **without the API key**, timestamps, status and
  error, every turn (events, per-event times, usage), the pending queue order, the
  last committed core snapshot, and the live per-agent model map.

Branch records and the runtime's pending action-request promises are **not** in
the document. `branch_start`/`branch_end`/`action_request`/`action_answer` events
are recorded inside their turn (so a reload can render the conversation), but no
branch transcript is restored and no question is resumed.

Writes are synchronous whole-document commits: a sibling staging file is written
and fsynced, then renamed over `state.json` (the canonical file is never unlinked
first). Structural API mutations (create/patch/delete session, enqueue/cancel,
reset, manual tool call, registry create/patch) persist **before** the response.
Background turns persist at start, on every non-delta event (message commit, tool
call/result, usage), and at the terminal settle; per-token text/reasoning deltas
are coalesced into the terminal write. A failed structural write is a 500; a
failed background write never changes a run's outcome but is observable via
`SessionStore.persistenceError` (and stderr unless `onPersistenceError` is set).

Session teardown (`dispose()` / process shutdown) saves **at most once**: a
save-once guard stops a late write from replacing the database with an empty state,
and legacy event writes are serialized. A failed graceful save is reported through
`persistenceError` and the log — shutdown still closes rather than waiting or
retrying forever.

Recovery policy on restart:

- the registry is rebuilt first from the saved metadata (using the same template
  rules as the original create/patch);
- each session rebuilds its harness from its OWN frozen preset record, so a
  registry `PATCH` made after creation cannot change or break an old session;
- the core snapshot is restored (agent transcripts, discovery, created-tool
  sources — recompiled, never executed, todo/profile/chapter/location stores);
- an in-flight turn is marked `error` and the session reports
  "interrupted by a server restart"; it is **never replayed**, so no tool
  operation runs twice. Pending background calls are interrupted, not resumed —
  even when their external side effects already happened — and a restored client
  sees them abandoned rather than running;
- if the snapshot stopped after an assistant tool call but before its result was
  appended, restore keeps every completed result and appends one explicit
  non-success "interrupted" tool result for each unmatched call id (in call order).
  That makes the next provider request schema-valid without executing the call
  again; fully paired transcripts are returned unchanged and repeat restarts are
  idempotent;
- queued (never started) prompts are preserved in FIFO order but stay **paused**:
  nothing starts automatically. An explicit new submit starts the pump and drains
  the restored backlog first; `POST /cancel { all: true }` drops it.

Limitations, stated plainly: API keys/headers are never written (a foreign session
base URL therefore resumes unauthenticated, while the configured provider's key is
re-attached through `mergeSettings`); live `AbortController`s/watchers/progress
sinks are not serializable; and one process per database root (there is no
cross-process writer lock). Core state is captured at every mutation boundary,
including inside a running turn, so a completed tool's store change is durable
before the next provider request. The residual window is a tool that is STILL
executing when the process dies: its external side effects (a file it wrote) may
exist while the session snapshot does not include its result yet. The interrupted
turn is marked and its recorded events are kept, but it is never replayed — that is
deliberate, so no tool operation can run twice.

The rest of the surface is the same table as `/api`, one level below the mount:

```text
GET    /v1/harness                        bootstrap document
GET    /v1/harness/health                 liveness + session count
GET    /v1/harness/harnesses              harness descriptors + defaults + agents
GET    /v1/harness/presets                alias of /harnesses
POST   /v1/harness/harnesses              create a harness → 201 { harness }
PATCH  /v1/harness/harnesses/:name        change any harness
GET    /v1/harness/agents                 trusted agent registry
GET    /v1/harness/tools                  full catalogue (session-bound core first)
GET    /v1/harness/tools/bootstrap        alias of /tools
POST   /v1/harness/tools/:name            call one tool (sessionId only for session-bound tools)
POST   /v1/harness/tools/:name/call       alias of the call route
POST   /v1/harness/models                 server-side GET {baseURL}/models
GET    /v1/harness/sessions               session snapshots (with turns)
POST   /v1/harness/sessions               create a session
GET    /v1/harness/sessions/:id           one snapshot (with turns)
PATCH  /v1/harness/sessions/:id           retarget agent models (next request)
DELETE /v1/harness/sessions/:id           forget a session
POST   /v1/harness/sessions/:id/messages  legacy task → text/event-stream (owns the run)
POST   /v1/harness/sessions/:id/tasks     queue a task → 202 { session, turn }
GET    /v1/harness/sessions/:id/events    watch the queue → text/event-stream
POST   /v1/harness/sessions/:id/reset     reset agents, discovery, todos, records
POST   /v1/harness/sessions/:id/cancel    cancel active work ({ all } also drops the queue)
POST   /v1/harness/sessions/:id/actions/:requestId/answer   answer one pending actionRequest
```

**Standalone `/api` compatibility is unchanged.** The `/api` root stays a 404 (it
has no bootstrap document), every `/api` request still needs
`X-Harness-Client: ui`, and `/api/presets` exists as an alias of `/api/harnesses`.
The canonical mount does not use that header: the service loader installs
permissive CORS, so a custom header is not an access boundary there.

**Access control is an Origin gate, not authentication.** The service app is built
with `cors({ origin: '*', allowHeaders: '*' })`, and it listens on `0.0.0.0` by
default. The harness endpoint therefore rejects a browser request whose `Origin`
is neither the request's own host nor a loopback hostname (`localhost`,
`127.0.0.1`, `[::1]`); requests with no `Origin` (curl, server-to-server) are
allowed. That stops a public web page from reading transcripts or driving tools
**through a browser**, but it does not authenticate anyone who can reach the port
directly. Combined with unsandboxed tools (`commandRun`, `fileWrite`,
`toolCreate`), that means: bind the service to a trusted network only, and prefer
loopback (`host: '127.0.0.1'`) when the port is reachable from elsewhere. No
global service host/CORS settings are changed by this package.

**Connecting the UI to the service.** The browser chooses its API root at runtime
(`?apiRoot=` → injected config → `VITE_HARNESS_API` → `/api`), so the same built
bundle works against either mount:

```text
http://localhost:5180/?apiRoot=http://localhost:5000/v1/harness
```

`yarn dev:frontend` (Vite) and `yarn preview:frontend` (built UI) serve on `:5180`
and proxy `/api` to the service gateway on `:5000`, so the explicit `?apiRoot=`
above is only needed when bypassing that proxy. A loopback Vite origin is allowed
by the Origin gate directly; a LAN browser's non-loopback origin is not, so the
dev proxy stamps the target's origin on its server-to-server request (the gate
still rejects a foreign origin that reaches the service without that proxy).
For a LAN browser keep the default relative `/api` root; an absolute
`?apiRoot=http://<LAN-IP>:5000/...` is a different page origin and the runtime
gate ignores it. The UI never sees the API key — it posts only the base URL and model,
and `defaults.hasApiKey` is a boolean.

A **runtime** absolute root (`?apiRoot=` or injected `__HARNESS_CONFIG__`/meta)
must be the page's own origin or a loopback hostname (`localhost`, `127.0.0.1`,
`[::1]`); anything else is silently ignored and the next source is used. This is
deliberate: the UI posts the provider key saved in this browser to that root, so a
crafted `?apiRoot=https://evil.example/api` link must not receive it. A rooted path
such as `/v1/harness` is same-origin by construction. Build-time
`VITE_HARNESS_API` is operator-controlled and may name another origin; it cannot
be changed by a URL a user is tricked into opening. The loopback list is shared
with the service Origin gate (`src/server/origin.ts`), so "local" has one definition.

**Credentials stay with the configured provider.** `POST /models` and
`POST /sessions` both merge client settings through `src/server/config.ts`
(`mergeSettings`). An omitted or blank `apiKey` means "use the server key" **only
when the effective `baseURL` is the configured provider** — same origin and base
path after normalizing trailing slashes. Point the client at any other host, port,
or path and the request/session is created **unauthenticated**, unless the client
supplies its own key. A client key is always used as given. This is why a session
created against another endpoint cannot exfiltrate the server credential.

**Body policy and bounds.** Action endpoints that read a body require a JSON
*object* (`null`, arrays, and primitives are `400`). A direct tool call must carry
a `parameters` property (`{ "parameters": {} }` is a valid argument-less call), so
an empty body cannot execute a tool. The Node adapter rejects a streamed body over
1,000,000 bytes with `413`. The service adapter additionally rejects a declared
`content-length` and a serialized parsed body over the same cap before dispatch —
but the service loader parses JSON *before* the endpoint runs, so it cannot
prevent that upstream allocation, and a malformed body arrives as `{}`. That
residual is documented in `src/server/service.ts`; fixing it belongs in the loader,
not in this package.

**Sessions and reloads.** The server, not the browser, owns the transcript. Each
task is a turn with stable `id`/`index`, and every streamed event names its turn
(`{ type: 'turn' }` opens a legacy run; `GET /events` sends the same id as an
upsert). Reloading the UI re-reads `sessions` from the bootstrap document (or
`/sessions`), which already contains every turn and its events, then reopens the
`GET /events` watcher; if that stream is lost the UI polls the session instead.
Queued and running work belongs to the server, so a reload, a hidden tab, or a
closed watcher never cancels it. With a database root, sessions, turns, created
tools, discovery, todos, and the queued backlog are durable under
`<root>/harness/state.json` and a restart resumes them (see Persistence: running
turns are marked interrupted and never replayed; queued prompts stay paused).
Without a root the store is in memory, and a restart is a fresh store.

**Secrets and restart.** The service loads the package-root `.env` on the first
request (not at module import, so discovery stays free), after which the
credential tool and provider defaults are fixed for the process lifetime. Editing
`.env` requires a restart; the browser never reads it and no search/provider key is
aliased to `VITE_*`.


## Development

```bash
yarn test              # vitest run (library + server + shared)
yarn test:frontend     # vitest run --config src/frontend/vitest.config.ts (UI, jsdom)
yarn typecheck         # tsc --noEmit
yarn build             # library + server + client entries -> dist/
yarn build:frontend    # the UI application -> src/frontend/dist (standalone/deploy base)
yarn cli --list        # CLI preset catalogue
yarn dev:frontend      # Vite UI on all interfaces, dual-stack (LAN + localhost), /api -> the service on :5000
yarn dev:server        # optional standalone API on :5181 (no Vite/UI)
yarn start-service     # repo root: builds UI for /harness/, serves it + /v1/harness on :5000
yarn build:harness-ui  # repo root: rebuild just the gateway UI (/harness/ base)
```

## npm Publishing

The package is publishable to npm as `@underload/harness`.

```bash
yarn build      # five ESM entries + their .d.ts tree -> dist/
yarn publish    # prepublishOnly runs: typecheck -> test -> build -> test:package -> test:package:runtime
```

- **The library entry is stable: `src/harness.ts`.** It is the published library
  barrel (`harness()` / `agent()` / `tool()` plus every public type), and the tests
  keep aliasing `@underload/harness` to it. JS is bundled by Vite into
  `dist/underload-harness.mjs`; declarations are emitted to `dist/index.d.ts`.
- **The JavaScript application also lives under `src/`, next to the library:**
  `src/server` (HTTP API, sessions, SSE, catalogue presets, CLI, discovered service
  routes), `src/frontend` (browser client + app shell) and `src/shared` (helpers
  both trees evaluate). Each has its own barrel that becomes a published entry.
- **Entries and conditions.** `exports` maps the root to `src/index.ts` for
  `node`/`import` (library + shared + server + client) and to `src/browser.ts` for
  `browser` (library + shared + client, never the server tree). `./server`,
  `./frontend` and `./shared` expose each layer on its own. Every condition
  declares an **explicit `types` target**; nothing relies on implicit `.d.ts`
  sibling resolution.
- **Lazy preset chunks.** Each preset's implementation is a dynamic import (see
  `src/tools/catalogue.ts`), so the build emits one chunk per tool next to the
  entry (`fileRead-*.js`, `gitDiff-*.js`, …). The entry keeps no `node:` import
  and no static link to those chunks. `build.lib` must stay ESM-only and must not
  set `inlineDynamicImports`, which would fold every implementation back into the
  entry.
- `package.json` `files` ships all of `dist/` (entry, `.d.ts` tree, and the chunks),
  so a consumer's `import { fileRead }` still resolves its body after publishing.
- `package.json` points `main` / `module` / `types` / `exports` at `dist/`;
  tooling configs and tests never reach npm.
- **UI-only packages are devDependencies.** `marked`, `dompurify`,
  `highlight.js`, and `jsdom` are used only by `src/frontend/` (browser client and
  its jsdom tests), so they stay in `devDependencies`. The UI application build
  (`yarn build:frontend`) lands in `src/frontend/dist` for a static host or the
  standalone server, not in the published `dist/`.
- **`dotenv` is the one runtime dependency, and it is external.** It is CommonJS
  (`require('fs')`/`require('path')`), so bundling it into the ESM output left
  rolldown with a `require` an ESM module cannot run — the built
  `loadEnvironmentFile()` threw and took `startHarnessServer()` with it. It is
  externalised in `vite.config.ts` and declared in `dependencies`; only the server
  entry imports it. `yarn test:package:runtime` fails the release if that breaks
  again.
- `sideEffects: false` + `exports` make the package tree-shakeable.
- **`.env` is never bundled.** Package-relative paths are resolved by
  `src/server/package-root.ts` (a walk up to `package.json`), not by
  `new URL('<neighbouring file>', import.meta.url)`: Vite rewrites that pattern and
  would inline the file — including real provider keys — into `dist/`. Keep it that
  way when adding new package-relative paths.
- `publishConfig.access` is `public`, so the scoped package publishes
  publicly to the npm registry.

## License

ISC

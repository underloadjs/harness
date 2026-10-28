# @underload/harness

A plugin-first CLI agent harness. One call builds a callable writer that runs the
tool loop for you.

## Install

```bash
yarn add @underload/harness
```

Zero runtime dependencies. Node 18+ (`fetch` is the default transport).

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
`toolRequest`, `toolCreate`, `todoManage`, and `agentDelegate` are also declared up
front and are the only session-bound core tools.

## Concepts

Three things: `agent` is the brain, `tool` is an action, `harness` is the loop.
`agent` and `tool` live in `core/` and are barrelled from the package root, so
they work without a harness.

### Layout

```
src/
  harness.ts        the only root source file: harness() + the public barrel
  harness.test.ts   its test, next to it
  core/             agent, tool, discovery, creation   (usable without a harness)
  agents/           trusted AgentProfile definitions (instruction + guidelines)
  transport/        openai, models      (the wire protocol + model catalogue)
  tools/            the preset catalogue     (lazy, executable on their own)
  plugin/           host                     (programmatic extension)
  util/             errors                   (shared leaf helpers)
  types/            every public type
```

The package publishes `src/` only. The application built on it lives alongside:

```
cli/                  argv parsing, one-shot + interactive rendering
server/               HTTP API, sessions, SSE, static UI serving
harnesses/            presets and harness-level tools shared by CLI and server
playground/           browser client (no harness import)
```

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
| `system` / `user` / `assistant` | Append a message, return the agent for chaining. |
| `model()` / `model('x')` | Read / write the model. |
| `reset()` | Restore the seeded instructions and clear the conversation. |

### `tool()` — an action the model can request, or you can call

A tool is an **executable object**, not a passive descriptor. The same
implementation has two entry points: a direct call, and a call from the model.

```ts
const fileRead = tool<string[], FileReadResult>({
    description: 'Read one or more UTF-8 text files.',
    tags: ['files', 'read'],
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths']
    },
    execute: async ({ parameters: paths }) => Promise.all(paths.map(async (path) => ({ path, content: await read(path) })))
});

await fileRead(['package.json']);                // [{ path, content }] — no harness, no agent
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
`toolCreate`, `todoManage` (and `agentDelegate` when subagents exist). `fileList`,
`commandRun`, `gitDiff`, `syntaxCheck`, and the app tools stay searchable.

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
`["files", "write", ...]` brings it in — instead of paging through a list.

| Rule | Behaviour |
|---|---|
| Tags | Required. Trimmed, lowercased, deduplicated. |
| Default visibility | `'searchable'`. The core set is `fileRead`/`fileWrite`/`fileEdit`/`fileGlob`, a configured `webSearch`, the harness-owned `toolRequest`/`toolCreate`/`todoManage`, plus `agentDelegate` on a primary with subagents. `fileList` is searchable. |
| Core vs session-bound | `core` means always declared. Only the harness-owned set is `sessionBound` (needs a `sessionId` for a manual server call); core file tools and webSearch run directly. |
| Ranking | OR-style: a tool needs only one query tag to be a candidate, and its rank is its **best single-tag score** — exact tag (4) > tag prefix (3) > tag substring (2) > name/description hit (1). More matching tags only breaks ties, so a broad tool cannot outrank an exact hit. |
| Cap | 5 matches — the default AND the maximum. `limit` may only ask for fewer (1–5). `remaining` counts the matches the cap excluded; `truncated: true` mirrors it for older clients. |
| No match | the result carries `unmatchedTags` and the full `availableTags`, so the model retries with real vocabulary. |
| Undiscovered tool | calling one returns a tool result naming tags that would enable it — it does not run. |
| Lifetime | discovery is per harness and kept across calls; `reset()` forgets it with the conversation. `harness.discoveredTools` exposes the enabled names. |
| Reserved names | `toolRequest`, `toolCreate`, and `todoManage` belong to the harness, and `agentDelegate` too when it is registered; using one throws. |
| Manual call | an operator may run any registered tool through `harness.executeTool()` / `POST /tools/:name`; discovery gates the model, not the user. Core file tools need no session; the harness-owned set does. |

`searchTools(tools, tags)` is the same ranking without a harness — useful for a
catalogue UI or for checking that a tag vocabulary resolves the way you expect.

### Session todos (`todoManage`)

Every harness registers a core `todoManage` tool, so the model can keep a plan
without a discovery round. It is **incremental** and **session-scoped**:

| Action | Input | Result |
|---|---|---|
| `add` | `text` (non-blank; trimmed) | The new todo, with the next stable id (`"1"`, `"2"`, …). |
| `remove` | `id` | `removed` plus the remaining `todos`. |
| `check` | `id`, optional `completed` (default `true`; `false` unchecks) | The updated todo. |
| `uncheck` | `id` | The updated todo with `completed: false` (alias for `check` + `completed: false`). |
| `list` | — | Every todo plus `counts: { total, completed, remaining }`. |

```text
todoManage({ "action": "add", "text": "Draft the plan" })
  -> { todos: [{ id: "1", text: "Draft the plan", completed: false }],
       todo: { id: "1", text: "Draft the plan", completed: false },
       counts: { total: 1, completed: 0, remaining: 1 } }
```

- Every result carries the current `todos` (copies, never live references) and
  `counts`. `todo` appears for add/check/uncheck; `removed` for remove.
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

### Tool names

Every tool — core and preset — is named `<namespace><action>`. The namespace
groups related tools for discovery; the action is what the model calls.

| Old name (removed) | Current name | Notes |
|---|---|---|
| `requestTools` | `toolRequest` | core; always declared |
| `createTool` (tool) | `toolCreate` | core; the host method is `harness.createTool()` |
| `todoTools` | `todoManage` | core; always declared |
| `delegate` | `agentDelegate` | core; primary only, when subagents exist |
| `readFile` | `fileRead` | **batched**: `(paths: string[])` → `{ path, content }[]` |
| `writeFile` | `fileWrite` | **batched**: `({ path, content }[])` → `{ path, bytes }[]` |
| `editFile` | `fileEdit` | **batched**: `({ path, oldString, newString, replaceAll? }[])` → `{ path, replacements, bytes }[]` |
| `listFiles` | `fileList` | unchanged shape: `(paths?)` → `string[]` |
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

There are **no aliases**: the old names are gone from the wire surface, the
exports, the catalogue, and the reserved-name list. This is a deliberate breaking
change — a catalogue with two names for one tool makes discovery ambiguous. Harness
ids (`instruct`, `research`, `workspace`, `demo`, `flaky`), agent ids, and the
`websearch` configuration field are *not* tool names and are unchanged.

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
await fileRead(['package.json']);                                   // [{ path, content }]
await fileWrite([{ path: 'notes.md', content: '# Notes' }]);         // [{ path, bytes }]
await fileList(['src', 'task']);                                    // ['src/a.ts', 'src/nested/', 'task/b.ts', ...]
await fileEdit([{ path: 'a.ts', oldString: 'let x', newString: 'let y' }]);
await fileGlob({ patterns: ['src/**/*.ts'] });                      // { files, truncated }
await fileGlob({ patterns: ['*.ts'], content: 'TODO' });             // { matches, truncated }
await gitDiff();                                                    // { exitCode, stdout, stderr, ... }
await commandRun({ command: 'git status' });                        // { exitCode, stdout, stderr }
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
await fileRead(['a.ts', 'b.ts']);                                  // [{ path, content }, …]
await fileWrite([{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }]);
await fileEdit([{ path: 'a.ts', oldString: 'a', newString: 'b' }]);
```

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
| `fileRead` | `(paths: string[])` — non-empty | ordered `{ path, content }[]`; one missing/unreadable path rejects the whole call |
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
`node:vm` with a cumulative 2-second budget and a pattern that exceeds it fails with
a clear error instead of hanging the call. It is a timeout, not a sandbox, and an
ordinary grep over a large tree is unaffected (the context is reused per search and
the boundary is crossed once per file, not once per line).
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
(CLI, server, `yarn start`) load the package-root `.env` once at startup before any
harness is constructed — see [Environment file](#environment-file). The
CLI/server presets pass `websearch: true`, so a key in the shell or in `.env` is
enough for any of those entry points; the offline `demo` stays offline, and no UI
field or `RunnerSettings` value carries a search key. The live harnesses
(`instruct`, `research`, `workspace`) share one toolbox, so a key makes web search
available to all of them or to none. The `flaky` example is built by the same
shared factory, so it opts in too; only the scripted `demo` stays offline.

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
(`instruct`, `research`, `workspace`, and the `flaky` example) declares
`environmentTools: ['webSearch']`, which the
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
| `maxIterations` | Tool rounds one agent run may take before the harness throws. **Default 16** — the library's runaway guard. Must be a positive safe integer (validated at construction); there is no unlimited value. The app presets set 1000. |
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
| `writer.tools` | The registered tools, including the harness-owned core `toolRequest`, `toolCreate`, `todoManage`, and `agentDelegate` when it exists. |
| `writer.discoveredTools` | Names `toolRequest` has enabled, in discovery order. Read-only copy; `reset()` empties it. |
| `writer.toolCreate(config)` | Host-side runtime creation. Same validation/registry/budget as the model's `toolCreate`; throws `HarnessError`. |
| `writer.executeTool(name, parameters)` | Run one registered tool directly, with this harness's context (`agent`, `agents`, `run`). The server's manual-execution path: discovery gates the model, not the operator, so an un-discovered searchable tool still runs. Reserved policy is kept (`toolCreate` registration, primary-only `agentDelegate`); an unregistered name throws. |
| `writer.reset()` | Reset the entry agent's conversation, forget discovered tools, and clear `todoManage`. Created tools stay registered but are no longer enabled. |

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
non-JSON-Schema `parameters`, and a body that does not parse. Bounds: description
≤2 000 chars, source ≤20 000 chars, **32 created tools per harness**. Creation is
**session-local**: nothing is written to disk and two harnesses cannot see each
other's tools.

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
subagents**, a guessed call from them is rejected, and `run()` refuses to re-enter
an agent that is already running, so delegation is one level deep and cycles fail
fast. `agentDelegate` is not registered at all when there are no subagents. A tool can
still call `ctx.run(name, input)` directly when it needs a sibling turn mid-tool,
but that path is inside one agent's turn rather than model-visible delegation.

#### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    declare                -> core tools + everything toolRequest enabled
    no tool calls?         -> report done, return the message
    run each tool          -> append a tool message
    (loop again)
```

Failures split in two:

- **Recoverable** — unknown tool, undiscovered tool, malformed JSON arguments, or a
  throwing tool. Each becomes a tool result the model sees, so it can correct
  itself.
- **Terminal** — a transport failure or more than `maxIterations` tool rounds
  (default 16; the bundled live presets pass 1000). History is truncated back to
  where the call started and the harness throws, so a failed call is never
  replayed on the next attempt.

`maxIterations` is per agent run — a delegated subagent gets its own budget — and
is validated when `harness()` is called: a value that is not a positive safe
integer throws `HarnessError` immediately instead of failing mid-run.

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

## Progress events

| Event | Payload |
|---|---|
| `start` | `agent`, `model` |
| `reasoning` | `agent`, `delta` |
| `text` | `agent`, `delta` |
| `tool_call` | `agent`, `call` (`id`, `name`, `arguments`) |
| `tool_result` | `agent`, `name`, `content`, `isError`, optional `ui` (declarative panels) |
| `usage` | `agent`, `usage` (`input`, `output`, `total`, optional `cached`) — one per model request, tool rounds included |
| `done` | `agent`, `message` |
| `error` | `agent`, `error: { message }` |

Every event names its agent, so multi-agent runs stay readable in one stream.

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

`yarn start` / `yarn dev:playground` (server), `yarn serve` / `yarn server`
(CLI `--serve`), and `yarn cli` all use the same loader. The path is resolved from
the package, not the current directory, so launching from the workspace root still
finds it. In this workspace the file is
`D:/Projects/typescript/noobscript/packages/underload/harness/.env`. Copy
`.env.example` to `.env`; the real file is git-ignored.

| Variable | Used by |
|---|---|
| `HARNESS_BASE_URL` | Provider base URL default; CLI `-b` overrides |
| `HARNESS_API_KEY` | Provider key; CLI `-k` overrides. Falls back to `OPENAI_API_KEY` |
| `HARNESS_MODEL` | Model default; CLI `-m` overrides |
| `EXA_API_KEY` | Opt-in `webSearch` for the live presets (`instruct`, `research`, `workspace`) |
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
  to a canonical route (`server/runtime.ts`), not when the endpoint module is
  imported. Discovery therefore stays free of environment reads.
- Editing `.env` needs a restart (`Ctrl+C`, then start again). Server env is not
  hot-reloaded; a fresh terminal or session is enough. `yarn preview:playground`
  is only the static UI and does not read `.env`.

## CLI

The CLI runs a preset in-process. No UI, no HTTP server, no browser. It runs from
this package's source through the workspace script; the published package remains
the library.

```bash
yarn cli "What time is it?"                         # default preset: demo (offline)
yarn cli --preset instruct "Write an opening."      # live; needs an endpoint
yarn cli --preset research --model merge/ds4-flash --base-url http://localhost:5500/providers/private/v1
yarn cli                                            # interactive session (TTY)
echo "Summarise this" | yarn cli --preset instruct  # one task from stdin
```

| Flag | Meaning |
|---|---|
| `-p, --preset <name>` | Preset to run (default `demo`) |
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

## Server and UI

The UI is a client. It does not import the harness package, construct a harness,
or execute a tool. Every action is a request to the server; every result is an SSE
stream of the same `report.progress` events a CLI prints.

```bash
yarn start                # API + UI, everything end-to-end
yarn build:playground     # UI -> playground/dist
yarn serve                # API + built UI -> http://127.0.0.1:5181

yarn dev:playground       # same as start
yarn preview:playground   # built UI on :5180, proxying /api to a running yarn serve
```

The catalogue lives in `harnesses/`. Both entry points use it. Every **live**
preset is built by the same factory (`harnesses/toolbox.ts`), so the registered
toolbox is identical: all eight package tools (`syntaxCheck`, the five file tools,
`commandRun`, `gitDiff`), the app tools (`timeNow`, `textCount`, `diceRoll`,
`noteSearch`, `textSummarize`), opt-in `webSearch`, and the harness-owned core tools
(`toolRequest`, `toolCreate`, `todoManage`, plus `agentDelegate` only when the preset
declares a subagent). R18 splits declarations: the four core file tools and a
configured `webSearch` are always declared, while `fileList`, `commandRun`,
`gitDiff`, `syntaxCheck`, and the app tools are discovered. Choosing a harness
changes the agents, not the tools.

Agent identities live in **`src/agents/`** as trusted `AgentProfile` values:
`instruction` plus a `guidelines` list. The runtime seeds both — an identity system
message and one composed `Guidelines:` block — so the definition a UI renders and
the prompt a model receives are the same text. A client can select an agent id; it
can never supply instruction text.

| Preset | Shape |
|---|---|
| `instruct` | **Default UI card.** One general instruction-following agent with the full shared toolbox. |
| `research` | Two agents with explicit `primary: 'research'` / `subagents: ['summarizer']`; same toolbox, a research instruction, and one-level delegation. |
| `workspace` | One coding-focused agent with the same toolbox and a coding instruction. |
| `demo` | Scripted offline template — no endpoint needed; discovers `timeNow` with `toolRequest`, calls it, then answers. Deliberately not a live harness, so it uses timeNow only. Editable: metadata edits keep the script; an executable edit upgrades it to a live profiled harness. |
| `flaky` | The shared toolbox plus a tool that throws two calls out of three, to show recoverable failures. Editable: metadata edits keep `testFlaky`; an executable edit rebuilds the live toolbox with it retained. |

`flaky` is the only preset-specific extra tool: it is excluded from the shared
toolbox because it fails on purpose and keeps attempt state. All five entries are
templates the registry copies; there is no read-only category (R20.1). Legacy
identifiers still resolve: `writer` and `assistant` → `instruct`, `researcher` →
`research`. They are aliases, not extra cards, and a session created through one
reports the canonical name.

The server keeps one harness per session, so submitting a second task continues
the same conversation. A harness's configuration is **frozen at session creation**:
the preset object and a descriptor snapshot are captured, so a later create/patch
never changes what a running session reports or runs. The UI's Endpoint panel is
sent when a session is created; changing it starts a fresh session on the next run.
This frozen-chat rule is separate from editability: a harness card is always
editable (R20.1), and editing it applies to the next session you start — future
in-place session editing is not implemented. Sessions are in memory and are lost
when the server restarts. Created tools live in the session's harness: they survive
`reset()` (which clears the conversation, discovery, and `todoManage`) and
disappear with the session.

The response of a run is also the server's record: every task becomes a
`SessionTurn` (id, index, prompt, status, timestamps, every event the run produced,
a parallel `eventTimes` array of epoch-ms stamps, and a `usage` tally summed from the
per-request `usage` events — `input` with the cached part in `cached`). `GET
/api/sessions` and `GET /api/sessions/:id` always include the full `turns` array, so
a browser reload — or a second client — renders the same transcript, the same
per-step/per-tool elapsed time, and the same token count without having seen the
stream. A turn that is still running is
included too, which is what the UI polls to reattach to a running session. Each
snapshot also carries `harnessDefinition` (the frozen descriptor), `agentModels`
(the effective model of every agent in that session — overrides resolved, so a
per-agent dropdown survives a reload), and `discoveredTools` (what `toolRequest`
had enabled), so a reload loses neither the configuration nor the discovery state.

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
| `GET /api/tools` | The whole tool catalogue, session-bound core tools first (`toolRequest`, `toolCreate`, `todoManage`, `agentDelegate`) then every direct-call tool (including the core file tools); `webSearch` always appears with `availability` |
| `GET /api/tools/bootstrap` | Alias of `GET /api/tools` (the list the root bootstrap document carries) |
| `POST /api/tools/:name` | Call one tool on the server. A session-bound tool (`toolRequest`, `toolCreate`, `todoManage`, `agentDelegate`) needs `sessionId`; every other tool — including the core file tools — keeps its session-less runner. An unconfigured tool returns `ok: false`. See [the call body](#the-tool-call-body) |
| `POST /api/tools/:name/call` | Alias of the row above (verb-named spelling), same dispatcher |
| `POST /api/models` | Server-side `GET {baseURL}/models`; returns `{ models: string[] }` for the UI dropdown |
| `POST /api/sessions` | Create a session for a preset |
| `GET /api/sessions`, `GET /api/sessions/:id` | List or read sessions |
| `POST /api/sessions/:id/messages` | Submit a task; response is `text/event-stream` |
| `POST /api/sessions/:id/reset` | Reset every agent and clear discovery and todos |
| `POST /api/sessions/:id/cancel` | Abort the running task |
| `DELETE /api/sessions/:id` | Forget a session |

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
properties. `fileList` normalizes the tolerated "no preference" shapes itself
(`undefined`, `null`, `{}`, and a `{ "paths": [...] }` wrapper all mean `["."]`), so an
empty argument box and a model-shaped body agree, while an explicit `[]` is still an
error.

**Harness creation and overrides are in memory only.** `POST /api/harnesses` adds
a live harness built from trusted agents and the shared toolbox; `PATCH` changes
any harness, including the shipped templates (`instruct`, `research`, `workspace`,
`demo`, `flaky`). `demo`/`flaky`/`instruct`/`research`/`workspace` are all editable template copies;
`editable` remains on the wire for compatibility and is always `true`. A
metadata-only `PATCH` (`title`/`description`) preserves the template's captured
factory — the scripted `demo` keeps its offline script and `timeNow`-only registry,
and `flaky` keeps its `testFlaky` extra. An executable `PATCH`
(`primary`/`subagents`/`agentModels`) rebuilds the harness: `demo` becomes an
honest live profiled harness (shared toolbox, requires an endpoint), and `flaky`
rebuilds the live toolbox while retaining `testFlaky`.
`builtin: true` still marks provenance. There is no delete and no persistence:
restarting the server returns to the shipped templates. Registry edits affect
FUTURE sessions only, because a session freezes its captured preset and descriptor
at creation. Both routes validate the request — exactly one primary, known agent
ids only, no duplicate ids, reserved aliases (`writer`/`assistant`/`researcher`)
and existing names rejected, bounded title/description — and reject unknown
fields, so a client cannot supply instruction text, a provider, or a tool list.

`agentModels` is the one model-shaped field: a map of **selected agent id → model
id**, e.g. `{ "summarizer": "small/fast" }`. A member it omits uses the session's
`settings.model`, so a dropdown can show "default". Values are trimmed, non-empty,
at most 200 characters, and free of control characters; keys must belong to the
resulting `[primary, ...subagents]` set or the request is a `400` naming the members.
Only ids are overridable — never a provider, base URL, or key. On `PATCH` the map
REPLACES the previous one, so `{}` clears every override; changing membership
without restating the map drops the overrides of agents that are no longer selected.
The factory closure captures the map, so an existing session keeps the models it was
created with.

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
| { type: 'turn'; turn: SessionTurn }               // opens every run
| { type: 'event'; turnId; event; at?; usage? }     // `at` = epoch-ms stamp,
                                                    // `usage` = running tally
| { type: 'snapshot'; session: SessionSnapshot }    // run finished
| { type: 'failed'; error; session }                // run failed
```

The sidebar's **Tools** tab lists the whole catalogue — the session-bound core tools
first, then every direct-call tool — and calls `POST /api/tools/:name` for all of
them. Execution is server-side only; nothing in the browser runs a tool. The
direct-call entries really run there, so the path exercises the same `execute` a
session registers, including `commandRun`, the file tools, and a configured
`webSearch` (they may be `visibility: 'core'` but are not session-bound). The
**Core tools** group is different by design: those entries are `sessionBound`, their
call must carry the selected `sessionId`, and they execute inside that session's
harness, so a manual `toolRequest`, `toolCreate`, `todoManage`, or `agentDelegate`
call changes the conversation the user is looking at (and is refused with `409` while any session
operation is in flight: a chat turn, a reset, or another manual call). A manual
call is not a turn - it never changes `status` or appends a turn, only a private
single-flight flag while it runs.
`agentDelegate` is listed for every host but only exists in a session whose harness
allows subagents; otherwise the call answers a clear `404`. The **Web search** group
shows whether this server has `EXA_API_KEY`/`TAVILY_API_KEY`; an unconfigured entry
keeps its schema and example arguments visible but disables **Call tool** and prints
the server's hint, so it never looks like a working tool.

`--tools` (and `/tools` in an interactive CLI session) uses the same runtime
catalogue and appends `[unconfigured — …]` to an entry that needs a missing key.

**No sandbox.** The standalone server binds to `127.0.0.1` by default and has no
CORS layer, which is what keeps a same-origin UI simple. It is still a process with
the server's permissions: `workspace`, `commandRun`, `fileWrite`, and direct tool
calls can change the host. Do not expose it to a network you do not trust. The
service host is stricter in transport but not in trust: `0.0.0.0` plus permissive
CORS, with only the loopback Origin gate described above.

`playground/vite.config.ts` no longer aliases `@underload/harness` or stubs
`node:`: the browser bundle never reaches the package. `playground/dev.ts` starts
the standalone server and points Vite's `/api` proxy at it, so development and
production use the same server implementation.

### Service host (`/v1/harness`)

The same API can be hosted by `@underload/service` (the repository's Hono
gateway) instead of the standalone Node server. Nothing in this package starts a
listener for it: the service loader scans the repository root for `endpoint` /
`endpoints` folders, finds `packages/underload/harness/endpoint/harness/`, and
imports the two discovered modules:

| Module | Route | Job |
|---|---|---|
| `endpoint/harness/service-route.ts` | `/v1/harness/*` | everything below the mount |
| `endpoint/harness/service-route-root.ts` | `/v1/harness` | the bare bootstrap document |

Neither module declares a `port`, so both run **in place on the gateway's single
listener**. A port would move the endpoint onto an isolated worker and answer
clients with a 307 redirect; the harness API is cheap to host in-process and must
share the service's port. The route modules only describe a URL and a handler —
`server/runtime.ts` creates the `.env`-loaded store and catalogue lazily on the
first request, and every route shares that one store, so a session created through
one route is visible through the other.

Start it from the repository root with `yarn start-service` (which runs
`yarn workspace @underload/service start`); that entry scans the repository root,
so the two modules above are discovered. `yarn start` is still the standalone
API + UI on `:5181`; the service gateway is `http://localhost:5000`.

`GET /v1/harness` is the canonical bootstrap document:

```json
{
    "rootPath": "/v1/harness",
    "presets": [{ "name": "demo", "title": "…", "requiresEndpoint": false, "primary": "demo", "subagents": [], "agents": ["demo"], "tools": ["timeNow"], "coreTools": ["toolRequest", "toolCreate", "todoManage"], "builtin": true, "editable": true }],
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
the shared database/storage boundary and is not used here.

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
DELETE /v1/harness/sessions/:id           forget a session
POST   /v1/harness/sessions/:id/messages  submit a task → text/event-stream
POST   /v1/harness/sessions/:id/reset     reset every agent, discovery, todos
POST   /v1/harness/sessions/:id/cancel    abort the running task
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

`yarn preview:playground` serves the built UI on `:5180`; the service gateway
listens on `:5000`. The Vite dev origin is a loopback origin, which the Origin
gate allows. The UI never sees the API key — it posts only the base URL and model,
and `defaults.hasApiKey` is a boolean.

A **runtime** absolute root (`?apiRoot=` or injected `__HARNESS_CONFIG__`/meta)
must be the page's own origin or a loopback hostname (`localhost`, `127.0.0.1`,
`[::1]`); anything else is silently ignored and the next source is used. This is
deliberate: the UI posts the provider key saved in this browser to that root, so a
crafted `?apiRoot=https://evil.example/api` link must not receive it. A rooted path
such as `/v1/harness` is same-origin by construction. Build-time
`VITE_HARNESS_API` is operator-controlled and may name another origin; it cannot
be changed by a URL a user is tricked into opening. The loopback list is shared
with the service Origin gate (`server/origin.ts`), so "local" has one definition.

**Credentials stay with the configured provider.** `POST /models` and
`POST /sessions` both merge client settings through `server/config.ts`
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
residual is documented in `server/service.ts`; fixing it belongs in the loader,
not in this package.

**Sessions and reloads.** The server, not the browser, owns the transcript. Each
task is a turn with stable `id`/`index`, and every streamed event names its turn
(`{ type: 'turn' }` opens a run, `{ type: 'event', turnId }` follows). Reloading
the UI re-reads `sessions` from the bootstrap document (or `/sessions`), which
already contains every turn and its events, and the UI polls a session that is
still `running`. Nothing is persisted: sessions, turns, created tools, discovery,
and todos vanish on restart, and a service restart is a fresh in-memory store.

**Secrets and restart.** The service loads the package-root `.env` on the first
request (not at module import, so discovery stays free), after which the
credential tool and provider defaults are fixed for the process lifetime. Editing
`.env` requires a restart; the browser never reads it and no search/provider key is
aliased to `VITE_*`.


## Development

```bash
yarn test              # vitest run (library + server)
yarn test:playground   # vitest run --config playground/vitest.config.ts (UI, jsdom)
yarn typecheck         # tsc --noEmit
yarn build             # library -> dist/
yarn start             # API + UI end-to-end
yarn cli --list        # CLI preset catalogue
yarn serve             # API + built UI
yarn dev:playground    # same as start
yarn start-service     # repo root: @underload/service host, /v1/harness on :5000
```

## npm Publishing

The package is publishable to npm as `@underload/harness`.

```bash
yarn build      # dist/underload-harness.mjs + dist/harness.d.ts
yarn publish    # prepublishOnly runs: typecheck -> test -> build
```

- **Public API = `src/harness.ts`.** It is the only root source file in `src/`
  (its test sits beside it); everything else lives in a role folder with its own
  barrel (`core/`, `transport/`, `tools/`, `plugin/`, `util/`, `types/`), and
  `harness.ts` re-exports the public surface. JS is bundled by Vite into
  `dist/underload-harness.mjs`; declarations are emitted to `dist/harness.d.ts`.
- **Lazy preset chunks.** Each preset's implementation is a dynamic import (see
  `src/tools/catalogue.ts`), so the build emits one chunk per tool next to the
  entry (`fileRead-*.js`, `gitDiff-*.js`, …). The entry keeps no `node:` import
  and no static link to those chunks. `build.lib` must stay single-entry, ESM-only,
  and must not set `inlineDynamicImports`, which would fold every implementation
  back into the entry.
- `package.json` `files` ships all of `dist/` (entry, `.d.ts` tree, and the chunks),
  so a consumer's `import { fileRead }` still resolves its body after publishing.
- `package.json` points `main` / `module` / `types` / `exports` at `dist/`;
  tooling configs and tests never reach npm.
- **UI-only packages are devDependencies.** `marked`, `dompurify`,
  `highlight.js`, and `jsdom` are used only by `playground/` (browser bundle and
  its jsdom tests), and `files: ["dist"]` ships the library only, so they belong
  in `devDependencies` and the published package has no runtime dependencies.
- `sideEffects: false` + `exports` make the package tree-shakeable.
- `publishConfig.access` is `public`, so the scoped package publishes
  publicly to the npm registry.

## License

ISC

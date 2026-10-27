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
        websearch: tool({
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

`websearch` is not declared on the first request. Its tags say how to find it, and
the model gets it by calling the core `getTools` tool — see
[Tool discovery](#tool-discovery). Mark a tool `visibility: 'core'` when the model
should always see it.

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
  syntax/               javascriptSyntax.ts, pythonSyntax.ts
  files/                readFile.ts, writeFile.ts, editFile.ts, listFiles.ts,
                        searchFiles.ts, globFiles.ts, glob.ts (shared walker)
  command/              runCommand.ts, gitDiff.ts
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
const tools = [{ name: 'websearch', description: '...', parameters }];

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
const pythonSyntax = tool<string, boolean>({
    description: 'Check whether a Python snippet parses.',
    tags: ['code', 'python', 'validation'],
    parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Python source.' } },
        required: ['code']
    },
    execute: ({ parameters: code }) => check(code)
});

await pythonSyntax('print(1)');                  // true — no harness, no agent
harness({ tools: { pythonSyntax } });            // the model calls pythonSyntax
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
  That is why `pythonSyntax('...')` and a model call with
  `{ "code": "..." }` reach the implementation identically. Multi-property tools
  receive the whole object.
- `execute` may throw. The harness turns the error into a tool result the model
  can read and recover from.
- `agent`, `agents`, and `run` are **optional** in the tool context, because a
  direct call has none of them. `run(agentName, input)` runs a full turn on a
  sibling agent when they are present.

### Tool discovery

A catalogue can reach thousands of tools. Declaring all of them would spend the
model's context on schemas it will never call, so a request declares only:

- every `visibility: 'core'` tool, and
- every searchable tool that `getTools` has already enabled.

`getTools` is a core tool the harness always registers. It takes capability tags,
ranks the catalogue, enables the closest matches, and the next request declares
them:

Every harness also preloads the bundled preset catalogue by default (`presets:
true`), so `readFile`, `runCommand`, and friends are discoverable with no imports
at all. They are all searchable, so the preload costs no context until a query
asks for one.

```ts
tools: {
    readFile: tool({
        description: 'Read a UTF-8 text file.',
        tags: ['files', 'read'],
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        execute: ({ parameters: path }) => read(path)
    })
}
```

```text
round 1  model -> getTools({ "tags": ["files"] })
         result -> { enabled: ["readFile"], tools: [{ name: "readFile", ... }] }
round 2  model -> readFile({ "path": "README.md" })      // now declared
```

| Rule | Behaviour |
|---|---|
| Tags | Required. Trimmed, lowercased, deduplicated. |
| Default visibility | `'searchable'` — only the core set (`getTools`, `createTool`, and `delegate` on the primary) is declared at first. |
| Ranking | OR-style: a tool needs only one query tag to be a candidate, and its rank is its **best single-tag score** — exact tag (4) > tag prefix (3) > tag substring (2) > name/description hit (1). More matching tags only breaks ties, so a broad tool cannot outrank an exact hit. |
| Cap | 10 matches by default. `limit` raises it up to a hard maximum of 50; `truncated: true` says the tail was dropped. |
| No match | the result carries `unmatchedTags` and the full `availableTags`, so the model retries with real vocabulary. |
| Undiscovered tool | calling one returns a tool result naming tags that would enable it — it does not run. |
| Lifetime | discovery is per harness and kept across calls; `reset()` forgets it with the conversation. |
| Reserved names | `getTools` and `createTool` belong to the harness, and `delegate` too when it is registered; using one throws. |

`searchTools(tools, tags)` is the same ranking without a harness — useful for a
catalogue UI or for checking that a tag vocabulary resolves the way you expect.

### Preset tools

Shipped with the package, each usable standalone or registered on a harness:

```ts
import {
    pythonSyntax,
    javascriptSyntax,
    readFile,
    writeFile,
    editFile,
    listFiles,
    searchFiles,
    globFiles,
    runCommand,
    gitDiff
} from '@underload/harness';

await pythonSyntax('def f():\n    pass');                          // true
await readFile('package.json');                                    // the file, as text
await editFile({ path: 'a.ts', oldString: 'let x', newString: 'let y' });
await globFiles({ pattern: 'src/**/*.ts' });                      // { files, truncated }
await searchFiles({ pattern: 'TODO', include: '*.ts' });          // { matches, truncated }
await gitDiff();                                                   // { exitCode, stdout, stderr, ... }
await runCommand({ command: 'git status' });                       // { exitCode, stdout, stderr }
```

Each tool lives in its own file under a capability folder (`tools/syntax/`,
`tools/files/`, `tools/command/`), and the barrel also exports the whole set as
`presetTools`. **Every new harness preloads that catalogue**, so the model can
discover these without the caller importing anything; `presets: false` turns the
preload off.

The exports are **lazy proxies**, not implementations. `tools/catalogue.ts` holds
the static metadata (name, description, tags, schema) and names each
implementation in its own `import()` branch; the body — and the `node:fs` /
`node:child_process` / `node:vm` it needs — loads the first time a tool is called.
Constructing a harness or listing the catalogue therefore costs no Node built-ins,
and a model that never asks for `runCommand` never loads it. The published build
turns each branch into a chunk next to `dist/underload-harness.mjs`; all of
`dist/` is shipped, and `inlineDynamicImports` must stay off or the split is undone.

| Tool | Signatures | Result |
|---|---|---|
| `pythonSyntax` | `(code)` | `true` when the snippet parses |
| `javascriptSyntax` | `(code)` | `true` when the snippet parses as a classic script |
| `readFile` | `(path)` | file contents as UTF-8 text |
| `writeFile` | `({ path, content })` | `{ path, bytes }`, creating parent directories |
| `editFile` | `({ path, oldString, newString, replaceAll? })` | `{ path, replacements, bytes }`; `oldString` must be unique unless `replaceAll` |
| `listFiles` | `(path?)` | sorted entry names; directories end with `/` |
| `searchFiles` | `({ pattern, path?, include?, maxResults? })` | `{ matches: [{ path, line, text }], truncated }`; caps at 100 |
| `globFiles` | `({ pattern, path?, maxResults? })` | `{ files, truncated }`; caps at 100 |
| `runCommand` | `({ command, cwd? })` | `{ exitCode, stdout, stderr }` |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut }`; read-only |

`searchFiles` and `globFiles` share one walker: `.git`, `node_modules`, symlinks,
binary files, and files over 1 MiB are skipped, and `.gitignore` is **not** read.
`gitDiff` runs a fixed `git diff` argv with no shell, colour, external diff
drivers, or textconv, and never stages or commits.

Neither syntax tool executes the code it checks. `pythonSyntax` needs a Python 3
interpreter on `PATH` and throws if none is found — a missing interpreter is a
setup problem, not a verdict of "invalid syntax".

Every preset is tagged and **searchable**, so registering the whole family still
declares only the core set: a model that needs files asks for `files`, one that
needs a shell asks for `shell`, and the rest stay out of the context window.

**These presets hold no sandbox.** `readFile`, `writeFile`, `editFile`,
`runCommand`, and `gitDiff` act with the permissions of the host process. Run the
harness inside a container, a worktree, or an account you are willing to have
modified, or wrap `execute` to add a fence.

### `harness()` — the execution loop

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    primary: 'writer',               // entry point (explicit; first key is the default)
    subagents: ['researcher'],       // optional delegation allowlist
    tools: { websearch: tool({...}) },
    report: { progress: async (event) => {} }
});
```

| Field | Meaning |
|---|---|
| `agents` | Every brain, keyed by name. **The first key is the entry point** unless `primary` names another one. |
| `primary` | Which agent the callable runs. Optional; must name a registered agent. Use it in multi-agent configs so routing is explicit. |
| `subagents` | Allowlist the primary may delegate to. Optional; defaults to every agent except the primary. Empty (or a one-agent config) means no `delegate` tool at all. Must not contain the primary or an unknown name. |
| `tools` | Extra tools, keyed by the name the model calls. A configured tool replaces a preloaded preset of the same name. |
| `presets` | Preload `presetTools` into the registry. **True by default**; `false` starts from `tools` alone. |
| `report.progress` | Awaited for every step — a UI or `console.log`. |
| `plugins` | Optional programmatic extension (`createAgent`, `addTool`). |

The registry key is the identity: `writer: agent({...})` names the agent
`writer` and `websearch: tool({...})` is the name the model calls. You never
repeat the name inside the definition.

| Member | Meaning |
|---|---|
| `writer(input)` | Run the entry agent to completion. Resolves with its message. |
| `writer.name` | The entry agent's name. |
| `writer.agent` | The entry agent. `writer.agent.messages` is the live transcript. |
| `writer.agents` | Every agent, including the entry one. |
| `writer.subagents` | The agents the primary may delegate to, keyed by name. Empty when delegation is not configured. |
| `writer.tools` | The registered tools, including `getTools`, `createTool`, and `delegate` when it exists. |
| `writer.createTool(config)` | Host-side runtime creation. Same validation/registry/budget as the model's `createTool`; throws `HarnessError`. |
| `writer.reset()` | Reset the entry agent's conversation and forget discovered tools. Created tools stay registered but are no longer enabled. |

### Runtime tool creation

`createTool` is core on every agent, and `harness.createTool()` is the same path
for a host:

```ts
const upper = writer.createTool({
    name: 'upper',
    description: 'Uppercase a string.',
    tags: ['text', 'upper'],
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    source: 'return String(args).toUpperCase();'   // BODY of an async function
});

await upper('abc');   // 'ABC'
```

The model does the same by calling `createTool`; the new tool is registered
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
`runCommand`. There is no isolation, no allowlist, and no network/filesystem fence.

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
the core `delegate` tool with `{ agent, input }`; it is **not declared to
subagents**, a guessed call from them is rejected, and `run()` refuses to re-enter
an agent that is already running, so delegation is one level deep and cycles fail
fast. `delegate` is not registered at all when there are no subagents. A tool can
still call `ctx.run(name, input)` directly when it needs a sibling turn mid-tool,
but that path is inside one agent's turn rather than model-visible delegation.

#### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    declare                -> core tools + everything getTools enabled
    no tool calls?         -> report done, return the message
    run each tool          -> append a tool message
    (loop again)
```

Failures split in two:

- **Recoverable** — unknown tool, undiscovered tool, malformed JSON arguments, or a
  throwing tool. Each becomes a tool result the model sees, so it can correct
  itself.
- **Terminal** — a transport failure or more than 16 tool iterations. History is
  truncated back to where the call started and the harness throws, so a failed
  call is never replayed on the next attempt.

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
| `tool_result` | `agent`, `name`, `content`, `isError` |
| `done` | `agent`, `message` |
| `error` | `agent`, `error: { message }` |

Every event names its agent, so multi-agent runs stay readable in one stream.

## CLI

The CLI runs a preset in-process. No UI, no HTTP server, no browser. It runs from
this package's source through the workspace script; the published package remains
the library.

```bash
yarn cli "What time is it?"                         # default preset: demo (offline)
yarn cli --preset writer "Write an opening."        # live; needs an endpoint
yarn cli --preset assistant --model merge/ds4-flash --base-url http://localhost:5500/providers/private/v1
yarn cli                                            # interactive session (TTY)
echo "Summarise this" | yarn cli --preset writer    # one task from stdin
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
`HARNESS_API_KEY`, and `HARNESS_MODEL` provide the same defaults as the flags.

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

The catalogue lives in `harnesses/`. Both entry points use it:

| Preset | Shape |
|---|---|
| `demo` | Scripted transport — no endpoint needed; discovers `clock` with `getTools`, calls it, then answers |
| `writer` | One agent, no tools |
| `assistant` | One agent with `clock`, `wordCount`, `roll` in the catalogue |
| `researcher` | Two agents with explicit `primary: 'researcher'` / `subagents: ['summarizer']`; each keeps its own instruction, and the primary can delegate one level |
| `flaky` | A tool that throws two calls out of three, to show recoverable failures |
| `workspace` | The useful default: the package preset catalogue (`readFile`, `writeFile`, `editFile`, `listFiles`, `searchFiles`, `globFiles`, `gitDiff`, `runCommand`, syntax checks) plus core `createTool`, executed by the server |

The server keeps one harness per session, so submitting a second task continues
the same conversation. The UI's Endpoint panel is sent when a session is created;
changing it starts a fresh session on the next run. Sessions are in memory and are
lost when the server restarts. Created tools live in the session's harness: they
survive `reset()` (which only clears discovery) and disappear with the session.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness and session count |
| `GET /api/harnesses` | Preset descriptors and provider defaults |
| `GET /api/tools` | Direct-call tool catalogue |
| `POST /api/tools/:name` | Call one tool with no harness, agent, or loop |
| `POST /api/models` | Server-side `GET {baseURL}/models`; returns `{ models: string[] }` for the UI dropdown |
| `POST /api/sessions` | Create a session for a preset |
| `GET /api/sessions`, `GET /api/sessions/:id` | List or read sessions |
| `POST /api/sessions/:id/messages` | Submit a task; response is `text/event-stream` |
| `POST /api/sessions/:id/reset` | Reset every agent and clear discovery |
| `POST /api/sessions/:id/cancel` | Abort the running task |
| `DELETE /api/sessions/:id` | Forget a session |

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
| { type: 'event'; event: HarnessEvent }        // the same event the CLI renders
| { type: 'snapshot'; session: SessionSnapshot } // run finished
| { type: 'failed'; error; session }            // run failed
```

The sidebar's **Tools** tab calls `POST /api/tools/:name`. Package presets really
run there, so the direct-call path now exercises the same `execute` a session
registers, including `runCommand` and the file tools.

**No sandbox.** The server binds to `127.0.0.1` by default and has no CORS layer,
which is what keeps a same-origin UI simple. It is still a process with the
server's permissions: `workspace`, `runCommand`, `writeFile`, and direct tool calls
can change the host. Do not expose it to a network you do not trust.

`playground/vite.config.ts` no longer aliases `@underload/harness` or stubs
`node:`: the browser bundle never reaches the package. `playground/dev.ts` starts
the standalone server and points Vite's `/api` proxy at it, so development and
production use the same server implementation.


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
  entry (`readFile-*.js`, `gitDiff-*.js`, …). The entry keeps no `node:` import
  and no static link to those chunks. `build.lib` must stay single-entry, ESM-only,
  and must not set `inlineDynamicImports`, which would fold every implementation
  back into the entry.
- `package.json` `files` ships all of `dist/` (entry, `.d.ts` tree, and the chunks),
  so a consumer's `import { readFile }` still resolves its body after publishing.
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

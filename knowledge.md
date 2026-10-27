# @underload/harness Knowledge

Plugin-first CLI agent harness. `agent` is the brain, `tool` is an action, `harness` is the loop.

> **Last verified:** 2026-10-28
> **Package name:** `@underload/harness`
> **Dependencies:** none (Node 18+ — default transport uses global `fetch`)
> **Workspace consumers:** none yet

---

## How to Update This File

1. Read `src/harness.ts` for the public barrel and the loop
2. Check `src/core/agent.ts`, `src/core/tool.ts`, `src/transport/openai.ts`
3. Update the "Last verified" date
4. Keep the "Not built yet" list honest — it is the roadmap

---

## Layout

`src/` has exactly one root *source* file, `harness.ts`; its test sits next to
it. Everything else lives in a role folder with its own barrel, and `harness.ts`
re-exports the public surface.

```
src/
  harness.ts            the only root source file: harness() + the public barrel
  harness.test.ts       its test, next to it
  core/
    index.ts            barrel: agent, tool
    agent.ts            the brain
    agent.test.ts
    tool.ts             an action the model can request, or you can call
    tool.test.ts
  transport/
    index.ts            barrel: openAICompatible
    openai.ts           OpenAI-compatible SSE transport
    openai.test.ts
  tools/
    index.ts            barrel: the preset tools
    syntax.ts           pythonSyntax, javascriptSyntax
    files.ts            readFile, writeFile, listFiles
    command.ts          runCommand
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

### Preset Tools
- [Preset tools](#preset-tools) — pythonSyntax, javascriptSyntax, readFile, writeFile, listFiles, runCommand

### Harness
- [harness](#harness) — Callable execution loop

### Transport
- [openAICompatible](#openaicompatible) — Default SSE transport

### Types
- [HarnessEvent](#harnessevent) — Progress events
- [HarnessMessage](#harnessmessage) — Transcript entries
- [HarnessAssistantMessage](#harnessassistantmessage) — Finished turn

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
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    execute: ({ parameters: code }) => parses(code)
});

await pythonSyntax('print(1)');                  // direct: no harness, no agent
harness({ tools: { pythonSyntax } });            // the model calls it
```

- `name` is optional (default `'tool'`). **A harness overwrites it with its
  registry key**, which is the name the model calls.
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
- Construction throws on: missing description, missing `execute`.

---

## Preset tools

`src/tools/` ships six presets. Each is a standard `tool()` and each is
executable standalone.

| Export | Call | Result |
|---|---|---|
| `pythonSyntax` | `(code)` | `boolean` |
| `javascriptSyntax` | `(code)` | `boolean` |
| `readFile` | `(path)` | `string` |
| `writeFile` | `({ path, content })` | `{ path, bytes }` |
| `listFiles` | `(path?)` | `string[]` (directories end with `/`) |
| `runCommand` | `({ command, cwd? })` | `{ exitCode, stdout, stderr }` |

Implementation notes worth keeping:

- **Neither syntax tool executes code.** JavaScript compiles with `node:vm`'s
  `Script` (parses, never runs; classic scripts only — `import`/`export` report
  false). Python pipes source to `compile()` through the interpreter, which also
  only parses.
- **`pythonSyntax` needs a Python 3 interpreter.** Probes `python3` then `python`
  by exit status (the Windows Store `python3` shim exists but exits non-zero) and
  caches the answer. A missing interpreter **throws** — "false" must keep meaning
  "your code is wrong".
- **No sandbox anywhere.** Paths resolve against `process.cwd()` and are used as
  given; `runCommand` runs with host permissions. This matches other CLI
  harnesses: powerful by default, fenced by the process boundary the host
  provides. Say so loudly in docs.
- **Non-zero exit is data.** `runCommand` resolves with `exitCode` rather than
  throwing, so the model can read a failing command and react.
- `writeFile` creates parent directories and returns the absolute path + byte
  count, because agents write into not-yet-existing directories constantly.


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
- **The first `agents` key is the entry point.** With one agent the config reads
  naturally; with several, insertion order is the routing decision. There is no
  extra `name`/`primary` field.
- The registry key is the identity for both agents and tools; `agent.name` /
  `tool.name` are overwritten to match.
- `plugins` remains as an optional programmatic extension point
  (`createAgent`, `addTool`). It is not part of the declarative config shape.

**Members:** callable, `name`, `agent`, `agents`, `tools`, `plugins`, `reset()`.

### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    no tool calls?         -> report done, return the message
    run each tool          -> append a tool message
    (loop again)
```

Recoverable failures become tool results the model can read:
- unknown tool → result listing the registered tools;
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

## Playground

`playground/` is a browser UI for testing the harness visually. It is **not** a
shipped artifact: `files` ships `dist/` only, and `tsconfig.build.json` excludes
the folder from declaration emit.

- Presets live in `playground/src/presets.ts` and are **factories** — a harness
  bakes its transport at construction, so a preset takes the endpoint settings
  and returns a `Harness`. The preset name is the entry agent's name.
- `demo` is offline (a scripted `HarnessStream` that streams reasoning, one tool
  call, then the answer), so the deployed Pages build is interactive with no
  endpoint. `writer`, `assistant`, `researcher` (two agents, `ctx.run`
  delegation), and `flaky` (recoverable tool errors) use the default transport.
- `playground/vite.config.ts` aliases `@underload/harness` to `src/harness.ts`,
  mirroring the vitest alias, so the UI always runs source.
- Every `node:` specifier resolves to `playground/src/node-stub.ts`: the root
  barrel re-exports the preset tools, which import Node built-ins. Those tools
  throw when called in a browser, and the playground harnesses use browser-safe
  tools of their own instead.
- Scripts: `dev:playground`, `build:playground`, `preview:playground` (port
  5180). `.github/workflows/pages.yml` deploys `playground/dist` to GitHub Pages,
  taking the base path from `actions/configure-pages`.

## Not built yet

In the order they are expected:

1. **streaming tool output** — `execute` cannot report progress mid-call yet.
2. **sessions** — persistence and resume across processes.
3. **compaction** — history pruning before context limits.
4. **per-agent tool scoping** — every tool is currently visible to every agent.
5. **abort plumbing** — `signal` is threaded through `turn()` but nothing
   upstream cancels yet.
6. **parallel tool execution** — calls run sequentially today.
7. **sandboxed presets** — the file and command tools have no fence; a
   `root`-scoped variant would be the natural next step.
8. **more presets** — `fetchUrl`, `searchFiles` (grep), and a scripted `editFile`
   are the obvious gaps.

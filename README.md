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

## Concepts

Three things: `agent` is the brain, `tool` is an action, `harness` is the loop.
`agent` and `tool` live in `core/` and are barrelled from the package root, so
they work without a harness.

### Layout

```
src/
  harness.ts        the only root source file: harness() + the public barrel
  harness.test.ts   its test, next to it
  core/             agent, tool            (usable without a harness)
  transport/        openai                 (the default wire protocol)
  tools/            the preset tools       (executable on their own)
  plugin/           host                   (programmatic extension)
  util/             errors                 (shared leaf helpers)
  types/            every public type
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

### Preset tools

Shipped with the package, each usable standalone or registered on a harness:

```ts
import { pythonSyntax, javascriptSyntax, readFile, writeFile, listFiles, runCommand } from '@underload/harness';

await pythonSyntax('def f():\n    pass');        // true
await readFile('package.json');                  // the file, as text
await runCommand({ command: 'git status' });     // { exitCode, stdout, stderr }
```

| Tool | Signatures | Result |
|---|---|---|
| `pythonSyntax` | `(code)` | `true` when the snippet parses |
| `javascriptSyntax` | `(code)` | `true` when the snippet parses as a classic script |
| `readFile` | `(path)` | file contents as UTF-8 text |
| `writeFile` | `({ path, content })` | `{ path, bytes }`, creating parent directories |
| `listFiles` | `(path?)` | sorted entry names; directories end with `/` |
| `runCommand` | `({ command, cwd? })` | `{ exitCode, stdout, stderr }` |

Neither syntax tool executes the code it checks. `pythonSyntax` needs a Python 3
interpreter on `PATH` and throws if none is found — a missing interpreter is a
setup problem, not a verdict of "invalid syntax".

**These presets hold no sandbox.** `readFile`, `writeFile`, and especially
`runCommand` act with the permissions of the host process. Run the harness inside
a container, a worktree, or an account you are willing to have modified, or wrap
`execute` to add a fence.

### `harness()` — the execution loop

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    tools: { websearch: tool({...}) },
    report: { progress: async (event) => {} }
});
```

| Field | Meaning |
|---|---|
| `agents` | Every brain, keyed by name. **The first key is the entry point.** |
| `tools` | Tools available to every agent, keyed by the name the model calls. |
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
| `writer.tools` | The registered tools. |
| `writer.reset()` | Reset the entry agent's conversation. |

#### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    no tool calls?         -> report done, return the message
    run each tool          -> append a tool message
    (loop again)
```

Failures split in two:

- **Recoverable** — unknown tool, malformed JSON arguments, or a throwing tool.
  Each becomes a tool result the model sees, so it can correct itself.
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

## Playground

`playground/` is a visual tester for the harness. It is **not** part of the
published package — `files` ships `dist/` only, and `tsconfig.build.json` excludes
it from declaration emit.

```bash
yarn dev:playground       # http://localhost:5180
yarn build:playground     # static site -> playground/dist
yarn preview:playground   # serve the built site
```

It ships five named presets, selectable in the sidebar:

| Preset | Shape |
|---|---|
| `demo` | Scripted transport — no endpoint needed; streams reasoning, one tool call, then the answer |
| `writer` | One agent, no tools |
| `assistant` | One agent with `clock`, `wordCount`, `roll` |
| `researcher` | Two agents (`researcher` + `summarizer`) and a tool that delegates with `ctx.run` |
| `flaky` | A tool that throws two calls out of three, to show recoverable failures |

The log renders every `report.progress` event (reasoning, text, tool calls,
tool results, done, error) and the entry agent's live `agent.messages`. Live
presets read the base URL, key, and model from the Endpoint panel, which is saved
to the browser's `localStorage`; changing it starts a fresh conversation on the
next run. Conversations survive switching presets, and `Reset` clears them.

The bundle is built from source — `playground/vite.config.ts` aliases
`@underload/harness` to `src/harness.ts`, mirroring the vitest alias — and every
`node:` specifier resolves to a stub, because the root barrel re-exports the
preset tools, which import Node built-ins. Those tools therefore throw in a
browser; the playground harnesses use browser-safe tools of their own.

`.github/workflows/pages.yml` builds `playground/dist` and deploys it to GitHub
Pages (repo Settings → Pages → Source: GitHub Actions).

## Development

```bash
yarn test       # vitest run
yarn typecheck  # tsc --noEmit
yarn build      # vite build + declaration emit -> dist/
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
- `package.json` points `main` / `module` / `types` / `exports` at `dist/`,
  and `files` ships only `dist/` - tooling configs and tests never reach npm.
- `sideEffects: false` + `exports` make the package tree-shakeable.
- `publishConfig.access` is `public`, so the scoped package publishes
  publicly to the npm registry.

## License

ISC

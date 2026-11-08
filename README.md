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
        search: tool({
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

`search` here is a caller-supplied tool (searchable by default, so toolRequest
enables it). The built-in opt-in `search` factory is core: when a key is
configured it is declared on the first request. The bundled catalogue splits the
same way (R18): `read`, `write`, `edit`, `glob`, and `grep` are core, while
`files`, `shell`, `gitDiff`, `syntax`, and the always-registered
`download` are discovered through the
core `toolRequest` tool — see [Tool discovery](#tool-discovery). The harness-owned
`toolRequest` and `tasks` (plus `delegate` when
subagents exist) are also declared up front and are the only session-bound core
tools. Every other harness-owned row — `toolRegistry`, `toolList`, `toolManage`,
`toolCreate`, `records`, `profiles`, `chapters`, `locations`, `agentManage`, and
`agentResult` — stays registered so `toolRequest` can enable it, but is searchable,
not declared (R9-R11). Two conditional harness-owned
tools are registered the same way: `actionRequest` when `interaction` is configured, and `threadFork`
when forks are enabled (the default) — see
[Owner questions and history forks](#owner-questions-and-history-forks).

## Concepts

Three things: `agent` is the brain, `tool` is an action, `harness` is the loop.
`agent` and `tool` live in `core/` and are barrelled from the package root, so
they work without a harness.

### Sessions, agents, and threads

The runtime has three levels, and the distinction is load-bearing:

- **Harness** — the execution loop. It provides callable agents; it is not itself
  a session.
- **Session** — server-controlled shared memory: one harness instance plus the
  record stores (tasks, profiles, chapters, locations), the terminal agent-result
  archive, and `snapshot()`/`restore()`.
- **Thread** — one persistent, agent-owned conversation. It has a stable id and
  its OWN transcript, and shares the session's tools, stores, discovery state,
  and creation budget.

Every configured agent owns a **default conversation** with id `agent:<name>`.
Its transcript is the registry `Agent.messages`, so delegation keeps its
historical behaviour (a subagent accumulates its conversation across calls) and
`sendThreadInput('agent:<name>', …)` resumes exactly that history. Run events
keep their existing invocation identity (`HarnessThread`, keyed by run id); the
persistent thread is a separate record, joined through
`HarnessThreadRecord.invocationId`.

`createThread` opens an **independent** conversation for the same agent, backed
by a fresh `Agent` (same instructions, seed messages, transport, and current
model). Two threads of one agent therefore run concurrently, while turns inside
one thread are serialized — never simultaneous.

A delegation or `ctx.run` child **of a host thread** is itself a new host thread:
own transcript, own id, `ownerThreadId` pointing at the calling conversation. Two
parents that delegate to the same child agent at the same time get two separate
child conversations with no shared transcript, and each is listed, stopped,
deleted, and persisted exactly like a `createThread` conversation. Delegation from
the callable root keeps using the child agent's default conversation, so the
legacy model is unchanged. A host thread follows its owning agent's current model:
`agent.model('…')` applies to every live thread of that agent on its next run.

```ts
const writer = harness({ agents: { writer: agent({ model, provider }) } });
const research = writer.createThread('writer', { label: 'research' });

await writer.sendThreadInput(research.id, 'draft a plan');   // runs that thread
writer.thread(research.id)?.status;                          // 'idle' | 'running' | 'stopped'
writer.threadMessages(research.id);                          // detached transcript copy
writer.setThreadMessages(research.id, messages);             // wholesale transcript replace
writer.threads();                                            // default + host records
```

- **Steering** — `steerThread(id, text)` queues guidance for a RUNNING thread.
  It is appended as a user message at the next safe model boundary, never inside
  an in-flight request, and receipt order is transcript order. An idle or stopped
  thread returns `queued: false` with a reason. If the run fails for any reason
  other than a stop, the steering it had drained is rolled back with the
  transcript and re-queued in order for the next host turn; a stop discards it.
  Steering carries TEXT only, so it has two host-side limits: a submit that brings
  attachments is never steered, and a submit whose `#` reference target has not
  finished (its result block does not exist yet) cannot be expanded into steering
  text. The server accepts both as a QUEUED CONTINUATION turn in the same thread
  instead — the media, the reference binding, and the prompt are preserved and run
  once the active turn settles.
- **Capacity** — a session may hold at most `MAX_THREAD_RECORDS` (256) independent
  host threads, counting delegated children of host threads. Opening one past the
  bound is the runtime's "already has N independent threads; delete a terminal one"
  refusal, which the server's thread routes surface as a `429` (no new conversation
  is created).
  Deleting a terminal thread removes its record, so it frees a slot again.
  Unfocused submits each open a new thread, so a long unfocused conversation can
  reach the bound; continuing ONE thread (submitting its `threadId`) does not.
  The UI offers no automatic pruning — an operator deletes a row deliberately —
  and reaching the bound is reported as the server's actionable message, not
  silently worked around client-side.
- **Stop** — `stopThread(id, reason?)` aborts that thread's active run (and
  owner-linked children) and marks it `stopped`; `stopAllThreads()` stops every
  conversation in the session. A stop also invalidates every host turn already
  QUEUED on that thread (they reject with "was stopped while this turn was
  queued" instead of running and flipping the status back to running). Agents
  cannot run or post into a stopped thread; only a new host `sendThreadInput`
  revives it, or the host deletes it. **Corrected in place (records-engine Decision P,
  2026-11-09):** a stop used to release every `task` CLAIM the conversation held, so a dead
  thread could not keep a shared record reserved until its lease expired. There are no
  claims, so a stop strands nothing — the only conflict control is the `expects` revision
  token a write carries.
- **Delete** — `deleteThread(id)` removes a terminal HOST thread: its record,
  transcript, owned terminal children, its invocation results, and every branch
  (`threadFork`/autoanswer, including nested ones) materialized from that
  conversation. The agent's default conversation cannot be deleted (use
  `reset()`). Deletion purges THIS conversation only: it never promises to forget
  what other histories were already told, and it does not undo what this thread
  copied into session-shared memory (tasks, profiles, chapters, locations) or what
  a connected thread already received through a `#` reference. The one shared write it
  makes any shared write is **nothing** at all (Decision P deleted the claims this used to
  release: `releaseThread` and its four call sites are gone).

Threads may only be OWNED by an independent host thread: `ownerThreadId` must
name a `createThread` record, never an implicit `agent:<name>` conversation
(its owner link could not be persisted/restored). Delegation children from host
threads satisfy this automatically.
- **Cross-thread chat & discovery** — once the session owns a host thread, three
  conditional core tools are registered: `threadList` returns this session's live
  conversations (id, agent, origin, status, owner/label) with the caller's own
  `currentThreadId`, `threadRead` reads one of them back (the whole transcript, one
  message by index, or a regex/role-filtered page with per-message content paging;
  attachments come back as descriptors, never base64 bytes; omitting `thread` reads
  the calling run's own conversation), and `threadSend` posts into one of them. Ids
  are therefore observed, never invented by a model or injected by the server;
  deleted threads are absent, and only this session is visible. The runtime records
  the REAL sender (agent + thread from the calling run, not a tool argument). The
  post is STATE-AWARE and the receipt names the outcome: a RUNNING target is
  steered (`delivered: 'queued'` — the message lands at its next safe boundary, in
  the turn already in flight), a DORMANT target — `idle`, or `paused` by a plugin
  and resumed here — is started (`delivered: 'started'`, the message is its prompt),
  and a STOPPED one is refused. Neither path waits for the answer.
  CORRECTED IN PLACE: an idle target used to get an inert append
  (`delivered: 'appended'`) that no run was obliged to read.

Threads persist through snapshot v1 as an optional `threads`/`threadSequence`
pair (absent while only default conversations exist). See `src/harness.ts` and
`src/types/index.ts` for the full contract.

### Layout

Everything the package contains now lives under `src/`: the library, the server
application and the browser client. `harness.ts` stays the stable library entry.

```
src/
  harness.ts        the library entry: harness() + the public barrel
  harness.test.ts   its test, next to it
  index.ts          Node root entry    (library + shared + server + client)
  browser.ts        browser root entry (library + shared + client)
  core/             agent, tool, discovery, creation, task, profile, chapter,
                    location, action, branch   (usable without a harness)
                    tool-discovery + tool-manifest: the AST descriptor scan and its
                    generated data-only table (no tool module is imported for it)
  agents/           trusted AgentProfile definitions (instruction + guidelines,
                    with the shared policy lines in guidelines.ts)
  transport/        openai, models      (the wire protocol + model catalogue)
  tools/            the preset + runtime catalogue, one `*.tool.ts` per entry
                    (runtime/ holds the harness-owned core entries)
  plugin/           host                     (programmatic extension)
  util/             errors                   (shared leaf helpers)
  types/            every public type
  shared/           isomorphic helpers both trees evaluate (origin/loopback/Pages rules)
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
  api.ts                root resolution (query/saved URL/injected/build/Pages chain,
                        defaulting to /v1/harness) + fetch + SSE
  deployment.ts         the local/LAN gateway chain a GitHub Pages host probes
  contract.ts           wire validation/presentation helpers
  ui/                   turns, agents, create form, markdown, panels, tools, tokens,
                        action-request (owner question card)
  styles.css            the app stylesheet
  index.html            the app entry document

docs/                   the package documents (index: docs/README.md): the plugin
                        authoring guide (plugins.md), the runtime-tools
                        integration doc, and the issue + task logs
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
`delegate` calls, and a stream that cannot be attributed keeps the old flat
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
`read`/`write`/`edit`/`glob`/`grep`/`files`, `shell`, `gitDiff` and
`syntax` are lazy chunks (`import()`) whose bodies use `node:fs`, `node:vm` and
`node:child_process`. They are exported (the root is the same library surface) but a
browser must not call them; the catalogue only loads a body when that tool is called,
so ordinary browser imports stay Node-free.

`src/tools/` is one file per tool, one folder per capability:

```
tools/
  index.ts              barrel + presetTools (the preload catalogue, descriptor-built)
  catalogue.ts          PRESET_TOOLS / PRESET_TOOL_NAMES, derived from ./descriptors
  descriptors.ts        the ONE seam: live Node scan (browser: generated manifest)
                        + the loader (generated import() or source compilation)
  lazy.ts               builds a callable Tool whose body loads on first use
  runtime/              the harness-owned core entries (toolRequest, toolCreate,
                        task, delegate, threadFork, …) — one *.tool.ts each
  syntax/               syntax.tool.ts (javascript.ts, typescript.ts, json.ts and
                        python.ts load on demand)
  files/                read.tool.ts, write.tool.ts, edit.tool.ts,
                        glob.tool.ts + grep.tool.ts (both core, always declared),
                        files.tool.ts (searchable by tag), glob.ts (shared walker),
                        search.ts (the pattern/root rules both searches share)
  command/              shell.tool.ts, gitDiff.tool.ts
  websearch/            request.ts (bounds/errors), exa.ts, tavily.ts, linkup.ts,
                        index.ts (createWebSearchTool — opt-in, per-harness)
  webfetch/             request.ts (page bounds/errors), native.ts (GET + converter),
                        exa.ts, linkup.ts, index.ts (createWebFetchTool — opt-in,
                        native is always the default provider)
  webdownload/          download.tool.ts (the `download` preset: 20 MiB cap,
                        toolMedia() envelope), index.ts (type-only barrel)
  presets.test.ts       covers every preset, standalone and in a harness
```

Tests sit next to the module they cover and import **only** from
`@underload/harness` — never a relative path. That keeps them honest about the
public surface and free of `../` chains. The specifier is aliased to
`src/harness.ts` in `vitest.config.ts`, so `vitest run` needs no build.

Each folder has an `index.ts` barrel, and `harness.ts` re-exports the public
surface, so consumers only ever import from `@underload/harness`.

### `agent()` — the brain

Model, instruction, message history, and the model-request retry sequence for one
turn. It owns no other policy: no tool execution, no compaction, no planning.

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
const tools = [{ name: 'search', description: '...', parameters }];

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

#### Retries

The agent is the **single retry owner** for model calls. One `stream()` / `turn()`
may call the transport more than once, and a retry re-sends **only the current
request** — never a tool, never the whole run.

| Setting | Default | Meaning |
|---|---|---|
| attempts | 1 + 10 retries | `retry: { maxRetries }` (default `10`); `retry: false` disables retries |
| waits | `1000 * 2 ** n` ms, n = 0..9 | 1s, 2s, 4s, … 512s (`retry: { baseDelayMs }` changes the base) |
| success | first successful attempt | later retries are never made |
| exhaustion | 11th call fails | the **last attempt's own error** is thrown / yielded |

Every model-call failure is retried, not just 5xx: a returned `error` frame (any
HTTP status, a provider error attached to a `200` stream, a malformed frame, a
truncated stream), a thrown network error, and a stream that throws mid-flight.
**Cancellation is not retried**: an abort before an attempt, during a backoff, or
while a request is in flight ends the request immediately.

A failed attempt's partial text, reasoning and tool calls are discarded — they are
never committed to history, so no tool from an abandoned attempt can run. The
`retry` event (and `AgentStreamEvent`'s `retry` frame) reports the attempt, the
budget, the backoff and the failed attempt's error, which is what a UI/CLI renders.

```ts
agent({ model: 'x', provider: { baseURL }, retry: { maxRetries: 3, baseDelayMs: 500 } });
agent({ model: 'x', provider: { baseURL }, retry: false });   // one attempt, fail fast
```

### `tool()` — an action the model can request, or you can call

A tool is an **executable object**, not a passive descriptor. The same
implementation has two entry points: a direct call, and a call from the model.

```ts
// The preset's real shape: one array property, so `execute` receives the array
// itself. Items may be strings or `{ path, startLine?, startColumn?, startByte?, maxLines? }`.
const read = tool<FileReadParameters, FileReadResult>({
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
//             nextLine, nextColumn, nextByte, bytes, sizeBytes, error? }],
//   truncated, bytes, wireBytes, contentBudget, skipped, note? }
await read(['package.json']);                // no harness, no agent
harness({ tools: { read } });                // the model calls read
```

- `tool<Parameters, Result>()` — the generics are the callable's signature. The
  second one is inferred from `execute`'s return type.
- `tags` is **required** — at least one. Tags are how discovery finds the tool, so
  they are normalized on construction (trimmed, lowercased, deduplicated).
- `visibility` is `'core'` or `'searchable'` (the default). Core tools are declared
  on every request; searchable ones wait for discovery.
- `mode` is `'sync'` or `'async'`, and the default is **`'sync'`**
  (`DEFAULT_TOOL_MODE`). It says **when a finished call may start the next agent
  turn** — never how the call executes: both modes launch the implementation as
  concurrent background work (promise-backed, cancelable, delivered through the
  per-agent mailbox), and a delivery is never delayed by the other mode's policy.
  - **`sync`** — the completion joins the *sync group* of the assistant message
    that requested it, and the run is re-entered only once **every** sync call
    from that message has settled (success, failure and cancellation all settle).
    Three sync calls therefore cost exactly ONE follow-up turn that carries all
    three results, and a lone sync call is answered only after it finished — no
    placeholder turn.
  - **`async`** — the completion triggers its own turn immediately, even while
    sibling calls from the same message are still in flight. Groups are per
    assistant message and per run, so a delegation or a second thread never joins
    another run's group.
  - The policy belongs to the **resolved definition**, not to the wire name:
    replacing a built-in under the same name publishes a tool that carries only
    its own declared mode (an undeclared replacement is `'sync'`). The shipped
    built-ins state theirs in their own `registration` literal, which is what the
    scanner, the generated manifest and the lazy loader all carry through: `read`,
    `edit`, `search` and `fetch` are `'sync'`; `shell`, `delegate`, `threadFork`
    and `actionRequest` are `'async'` (a long command, a child run, a detached
    clone and a human at a prompt must never hold a batch hostage).
- `parameters` is plain JSON Schema. A TypeBox schema works as-is, so no schema
  dependency is needed.
- **Single-property rule.** When the schema declares exactly one property, the
  value passed to `execute` is that property's value, not the wrapper object.
  That is why `read(['package.json'])` and a model call with
  `{ "paths": ["package.json"] }` reach the implementation identically — which is
  exactly what makes the batched file tools possible. Multi-property tools receive
  the whole object, as `syntax({ code, language })` and `glob({ patterns })` do.
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

`toolRequest` is a core tool the harness always registers. It accepts exact
`names`, a name `regex`, and/or capability `tags`, selects the **union** of those
criteria, enables the matches for the next request, and returns the matched
metadata. Selection is uncapped; the host bounds the persistent enabled set with
`maxEnabledTools` (default 32), and core tools never spend that bound.

Every harness also preloads the bundled preset catalogue by default (`presets:
true`), so its tools are available with no imports at all. The five core file tools
(`read`, `write`, `edit`, `glob`, `grep`)
plus a configured `search` (and `fetch` when the harness opted into `webfetch`) are
declared from the first request, together with the harness-owned `toolRequest` and
`tasks` (and `delegate` when subagents exist). Every other harness-owned row —
`toolRegistry`, `toolList`, `toolManage`, `toolCreate`, `records`, `profiles`,
`chapters`, `locations`, `agentManage`, and `agentResult` — plus the
conditional `actionRequest` (`interaction` configured) and `threadFork`
(`forks.enabled`, the default) stays registered but searchable: the model enables
them with `toolRequest`, and a manual server call still runs them directly.
`files`, `download`, `shell`, `gitDiff`, `syntax`, and the app tools
stay searchable too. `toolList` is the name+description inventory of the live registry
(enabled or not); `toolManage` is the source/path/edit surface described below.

```ts
tools: {
    shell: tool({
        description: 'Run a shell command.',
        tags: ['shell', 'command'],
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        execute: ({ parameters: command }) => run(command)
    })
}
```

```text
round 1  model -> read({ "paths": ["README.md"] })     // core, no discovery
round 2  model -> toolRequest({ "tags": ["files", "list"] })
         result -> { enabled: ["files"], tools: [...], matched: 1, omitted: 0 }
round 3  model -> files({ "ops": [{ "op": "list", "path": "src" }] })   // now declared
round 4  model -> toolRequest({ "names": ["shell"] })
         result -> { enabled: ["shell"], tools: [{ name: "shell", ... }], matched: 1, omitted: 0 }
round 5  model -> shell({ "command": "git status" })   // now declared
```

Selection returns **every** match for the union of `names`/`regex`/`tags`; there
is no five-result cap. `enabled` and `tools` are the matches the configured
`maxEnabledTools` bound admitted, `matched` is the whole union, and `omitted` is
the difference. `limit` narrows only the current query and is not a global cap;
repeating an identical query is idempotent (no hidden paging cursor).

Core tools the caller already has are reported separately in `alreadyAvailable`
(metadata only). The motivating case is `delegate` in a harness with
subagents: an exact wire-name, regex, or tag query names the tool instead of
claiming nothing matched. These entries are never enabled, never count against
`maxEnabledTools`, and their tags are not reported in `unmatchedTags`.

| Rule | Behaviour |
|---|---|
| Query shape | `names` (exact, case-sensitive), `regex` (bare source or `/source/flags`), and `tags` are OR-ed into one union; each match appears once. An empty query enables nothing and returns the vocabulary. |
| Tags | Trimmed, lowercased, deduplicated. Not required when `names` or `regex` is supplied. |
| Default visibility | `'searchable'`. The declared core set is `read`/`write`/`edit`/`glob`/`grep`, the harness-owned `toolRequest`/`tasks`, a configured `search`/`fetch`, and `delegate` on a primary with subagents. Everything else is demand-discovered: `files`, `download`, `syntax`, `shell`, `gitDiff`, the app tools, and the eleven demoted harness-owned rows (`toolRegistry`, `toolList`, `toolManage`, `toolCreate`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `actionRequest`, `threadFork`) — all still registered, so `toolRequest` can enable them (R9-R11). |
| Core vs session-bound | `core` means always declared. Only the harness-owned set is `sessionBound` (needs a `sessionId` for a manual server call); core file tools, `download`, `search`, and `fetch` run directly. |
| Ranking | Exact requested names keep caller order. Name-regex hits follow, then tag matches ranked OR-style: a tool's rank is its **best single-tag score** — exact tag (4) > tag prefix (3) > tag substring (2) > name/description hit (1). More matching tags only breaks ties. |
| Enabled bound | `maxEnabledTools` (default **32**) bounds the persistent SEARCHABLE enabled set at the model-turn boundary. Every selector kind (names, regex, tags) switches the set: this request's ordered matches lead, prior entries fill leftover capacity, overflow is `omitted`, and displaced prior names are `evicted`. Core tools are always declared and never count. |
| Already available | Core tools the caller already has (`delegate` with subagents, `tasks`, the file tools, …) that match the query are listed in `alreadyAvailable` — metadata only, never enabled, never counted against the bound. They are scored by wire name and tags only (never description), and a match is not reported as unmatched. A **conditionally declared** control is reported the same way while it is genuinely actionable: `toolCancel` appears in this list exactly when the caller has calls in flight, because it is declared only then — querying `cancel` must never answer "no such capability" about a tool the caller is holding (docs/tasks/2026-11-08-delegate-stress-test.md, finding 1). |
| No match | when neither a searchable nor an already-available core tool matches, the result carries `unmatchedTags` and the full searchable `availableTags`, so the model retries with real vocabulary. |
| Undiscovered tool | calling one returns a tool result naming tags that would enable it — it does not run. |
| Lifetime | discovery is per harness and kept across calls; `reset()` forgets it with the conversation. `harness.discoveredTools` exposes the enabled names. |
| Reserved names | `toolRequest`, `toolList`, `toolManage`, `toolCreate`, `tasks`, `profiles`, `chapters`, `locations`, `agentManage`, and `agentResult` belong to the harness, and `delegate`, `actionRequest`, and `threadFork` too when they are registered; using one throws. |
| Manual call | an operator may run any registered tool through `harness.executeTool()` / `POST /tools/:name`; discovery gates the model, not the user. Core file tools need no session; the harness-owned set does. `actionRequest` and `threadFork` are the exception: they need the run that owns the conversation and are refused by the manual path. |

`selectTools(tools, query, options?)` is the uncapped selector without a harness;
`searchTools(tools, tags, limit?, offset?, options?)` keeps the legacy paged
tag-only answer for existing hosts. Both are useful for a catalogue UI. Pass
`{ declared }` to reproduce `alreadyAvailable`.

### External tool folders and `*.tool.ts`

`toolFolders` is an ordered list of directories — absolute, or relative to the
process cwd — scanned recursively for editable `*.tool.ts` entries. Discovery is
deterministic (folder order, then a byte-wise sort of each folder's relative
POSIX paths), and a later folder wins
a name collision because every entry publishes through the normal registration
kernel. An invalid folder or module fails construction with its path. **Folder code
is trusted code:** compilation/loading runs it with the process's permissions, and
there is no sandbox.

A canonical entry is self-contained: metadata plus `execute` in the
`metadata + execute` module shape the compiler already supports.

```ts
// tools/example.tool.ts
export const metadata = {
    name: 'example',
    description: 'Return a greeting.',
    tags: ['example', 'greeting'],
    parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false
    }
};

export const execute = ({ parameters }: ToolContext) => `Hello, ${parameters.name}!`;
```

```ts
const writer = harness({
    agents: { writer: agent({...}) },
    toolFolders: ['./tools', '/srv/shared-tools']
});
```

Mutations go through the core `toolManage` tool (or `harness.runtime.manageTool`
from a trusted host):

| Operation | Behaviour |
|---|---|
| `list`, `details`, `source` | Inspect registry metadata, one tool's details (including a cloned `parameters` schema and any preserved `owningPath`), or its captured `moduleText`/dependencies/revision. |
| `path` | Report configured folders, an installed tool's `sourcePath`/`owningPath`, or the deterministic `createPath` a pathless create would use; with an explicit `path`, validate it inside the fence. Never writes. |
| `create`, `update` | Compile/validate/publish through the same kernel as `toolCreate`/`toolRegistry`. **Persist to disk by default:** a pathless `create` requires `name` and writes `<name>.tool.ts` in the LAST configured `toolFolders` root; a pathless `update` reuses the tool's captured owning `sourcePath` when it is inside a configured root. An explicit `path` (inside a root, ending in `.tool.ts`) overrides. `persist: "runtime"` is the explicit no-disk mode and cannot be combined with `path`/`folder`. No configured root is a clear error for persistent operations. |
| `reload` | Recompile the installed source revision. A disk-backed revision re-reads its file; a captured-only revision recompiles its captured bytes. |

Disk-write security is a path fence, not a sandbox: traversal and symlink escapes
are rejected, and a pathless create uses only its deterministic `<name>.tool.ts`
target. A failed registration rolls the just-written file back (or removes the new
file) and reports a rollback failure explicitly; the previous module stays usable.
Disk-backed create/update does not enter `createdToolRecords` or spend
`maxCreatedTools` because a restart re-scans the folder. Runtime-only revisions
survive snapshot/restore but are not persisted to disk by the harness.

### Session tasks (`tasks`)

Every harness registers the `tasks` tool and declares it on the first request, so
the model can keep a plan without a discovery round. The tool used to be named
`todoManage`; R9-R11 renamed it and replaced the action enum with a single
**patch** shape. It stays **session-scoped** and incremental (ids are stable, and
a call only carries what it changes). ONE list is shared by every agent and every
thread of the harness, so it also carries **revisions and a change feed** — and, since
records-engine Decision P, **no claims and no lease** (see
[Concurrency and ownership](#concurrency-and-ownership) below). `tasks` is one collection of
ONE session store: `records` is the low-level surface over that same store, and ids come from
a single counter, so the first profile of a session that already holds one task is `"2"`:

| Call | Effect |
|---|---|
| `task()` / `task({})` / `task({ parameters: undefined })` | read: return the current page, change nothing |
| `tasks` entry **without** `id` | add one task (`text` required, trimmed, max 4000 chars) with the next stable id (`"1"`, `"2"`, …) |
| `tasks` entry **with** a known `id` | patch that task: `text` and/or `completed`, whichever you send; omitted fields are unchanged |
| `remove: ["7", "9"]` | remove those ids |
| `claim` / `release` / `takeover: ["4"]` | hold a record while you work on it, hand it back, or seize it from whoever holds it (`leaseMs`, default 15 minutes, 1 minute-24 hours) |
| `expects: [{ id, rev }]` | the revisions you READ, one per id this call patches or removes; required for those writes whenever the runtime knows the caller, optional for the ownership verbs |
| `since: <storeRev>` | also return the store events after that revision (`changes`) |
| `offset` / `limit` | index-page the returned list (limit 1-100, default 20) |
| `afterId: "12"` | keyset-page it: the records with an id above `"12"`; cannot be combined with `offset` |
| `mergeDisjoint: true` | opt-in: apply a stale content patch when the concurrent change touched only fields this patch leaves out |

```text
task({ "tasks": [{ "text": "Draft the plan" }] })
  -> { tasks: [{ id: "1", text: "Draft the plan", completed: false, rev: 1,
                updatedBy: "instruct", updatedThreadId: "agent:instruct",
                updatedAt: "2026-11-08T09:15:32.772Z" }],
       counts: { total: 1, completed: 0, pending: 1 },
       page: { offset: 0, limit: 20, hasMore: false },
       storeRev: 1 }

task({ "tasks": [{ "id": "1", "completed": true }],
       "expects": [{ "id": "1", "rev": 1 }], "offset": 20, "limit": 20 })
  -> { tasks: [...], counts: { total: 42, completed: 3, pending: 39 },
       page: { offset: 20, limit: 20, hasMore: true, nextOffset: 40 },
       storeRev: 22 }
```

- **Every successful call answers the same envelope** — `{ tasks, counts, page,
  storeRev }` with no per-action wrapper. `counts` reports `total`, `completed`, and
  `pending` (`pending` is the count of unfinished tasks; the store itself keeps
  `completed: boolean` per task) and is always derived from the WHOLE list, never
  from the page. `page.nextOffset` (offset mode) or `page.nextAfterId` (`afterId`
  mode) is omitted when `hasMore` is false; loop on it to read the rest. The page is
  bounded by 100 items and a 64 KiB serialized budget. Caps: 200 tasks, 4000
  characters of text each.
- **Each record carries `rev`**, its CONTENT revision: 1 when it is added, +1 only
  when `text` (after trimming) or `completed` actually changes. The PATCH itself is
  event-free when the values you send already match — no `rev` bump, no attribution,
  no store event — so a model that restates the list cannot flood the log. (A no-op
  patch over an EXPIRED foreign claim is still accompanied by that clear: the claim is
  lifted first, and the clear is attribution plus one `release` event.) Ownership
  actions never move `rev` either, so a claim can never knock another agent off its
  compare-and-swap token. `updatedBy` / `updatedThreadId` / `updatedAt` attribute the
  last write and come from the tool context (the calling agent and conversation), never
  from tool arguments, so a model cannot forge who edited what.
- **The list is shared, so writes are guarded.** A call that HAS an agent identity (a
  model call, `harness.executeTool`, a slash command, a lane worker) must send
  `expects` for every id it patches or removes; a call with no identity (a bare
  `tool()` or driver call) may still write blind, and cannot claim, release or take
  over at all.
- The patch is **atomic**: the whole call is validated before anything mutates, so a
  bad entry leaves the list, the id counter, `storeRev` and the change log exactly as
  they were, and names the offending field
  (`task "tasks[0]" needs "text" to add a task, or an existing "id" to change one.`).
  Unknown ids, a duplicate id inside one call, an id that appears in two of `tasks` /
  `remove` / `claim` / `release` / `takeover`, a repeated id in `remove`, the 201st
  task, a 4001-character text, a stale `expects`, and a blocked claim all produce
  readable, recoverable tool results.
- **The change feed is bounded.** The store keeps a FIFO log of 200 recorded events
  (`add` / `update` / `remove` / `claim` / `release`); `since` returns the events after
  the revision you pass, at most 50 and inside the same 64 KiB budget, with
  `changesHasMore` when the feed was cut and `changesTruncated` when the retained
  window no longer covers the gap. A `since` ahead of the store is an error, not an
  empty answer.
- Every result is a defensive copy, never a live reference.
- The list is **per harness**, shared by the primary and its subagents, kept across
  turns, and cleared by `reset()` (ids restart at `"1"`, `storeRev` restarts at 0, the
  log empties). Snapshot/restore carry it: the persisted record keeps its snapshot-v1
  key `records.todos` and is now `{ items, nextId, storeRev?, changes? }`, where each
  `items` entry is a full `TaskItem` (`id`, `text`, `completed`, `rev`, plus the
  optional `updatedBy`/`updatedThreadId`/`updatedAt` and the optional claim triple
  `owner`/`ownerThreadId`/`leaseUntil`). Those additions are OPTIONAL on read, so a
  pre-T1 snapshot still loads and restores as `storeRev: 0`, `changes: []`, and
  `rev: 1` per record. Compatibility runs one way only: persisted keys are validated
  exactly, never ignored (`<label> has an unknown field "<key>".`), and an older build
  knows only `id`/`text`/`completed`, so a snapshot written by this build is REFUSED
  there rather than silently downgraded. Claims survive a
  restart, and a restore drops any claim whose `ownerThreadId` is not part of the
  restored session (`src/harness.ts`), because no live conversation could ever release
  it. Two harnesses — and therefore two server sessions — never share tasks.

#### Concurrency and ownership

There is ONE task store per harness and every agent on every thread writes it, and a
call is not a transaction: you read a record, work on it, and write back, and in
between somebody else may have written the same record. The store turns that race from
a silent overwrite into an explicit, recoverable error:

- **A read is a snapshot.** Results are copies, so the `rev` you hold describes the
  store as it was when you read it, not as it is when your next call lands.
- **`expects` is the proof of what you read.** Send the `rev` of every id you patch or
  remove. A mismatch rejects the WHOLE call and names the current revision, the last
  editor, and (when the log covers the gap) the fields that changed:
  `task "1" changed since revision 1 (now 2, last edited by "coder"); re-read and
  retry; changed fields: completed.` A token whose record the store no longer has IS
  the race you hit, whichever half of the call named it — a `tasks` patch, a `remove`,
  an ownership verb, or the token alone — and it always answers
  `task "1" was removed since revision 1; re-read the list.` Only a call that sent no
  token for that id hears the plainer `task has no task with id "1".`, and a token for
  a live id this call does not touch is still rejected as a token for nothing.
- **`rev` is content-only; `storeRev` counts every event.** A concurrent claim
  therefore never invalidates your token, while `since: <last storeRev>` still shows
  everything that moved — content and ownership alike.
- **A claim reserves a record while you edit it**, so a long edit is not stomped and
  two agents do not do the same work. `claim` sets `owner`/`ownerThreadId`/`leaseUntil`
  — the holder is the exact pair `(owner, ownerThreadId)`, so the same agent name on
  another thread is a different holder. The default lease is 15 minutes and the
  accepted range is 1 minute-24 hours: a model or `executeTool` call outside it is
  rejected by the schema, a call that bypasses the schema is clamped into it. While a
  claim is live, a non-holder's content write, claim, or release is refused:
  `task "1" is claimed by "coder" until 2026-11-08T09:30:53.657Z; release it or take
  it over first.` Re-claiming a record you
  already hold only renews the lease (nothing else changes); releasing an unowned
  record is a no-op success. A claim is expired AT or after `leaseUntil` (`leaseUntil
  <= now`, so the expiry instant itself frees it), and the next writer then clears it
  — logged as a `release` — and proceeds. A claim with no `leaseUntil` is indefinite
  and never auto-expires; it only appears in a restored or hand-edited store.
- **`takeover` is the deliberate override** of a live claim: it moves the holder to
  you, re-leases the record, and is logged as a `claim`. It is the answer when the
  holder is gone; nothing has to expire first.
- **`mergeDisjoint` is the one escape from a stale rejection**, and only for a content
  patch: it applies the patch when the change log PROVES every concurrent update since
  your read touched only fields your patch does not set. An overlapping field still
  rejects, a removal never merges, and a log that cannot prove full coverage rejects
  rather than guessing.
- **A stopped or deleted conversation cannot leave the list locked.** The harness
  clears every claim tagged with a thread id when that thread stops, is deleted, or
  loses its default conversation, and a restore sweeps claims whose thread is missing
  from the snapshot. Content revisions stay untouched; each clear is one `release`
  event that carries only the thread id.

```ts
// ONE harness session, two agents: `coder` and `reviewer`. Record "1" sits at
// content rev 3 and nobody holds it.

// — compare-and-swap: the loser is told, never silently overwritten —
coder:     task({})                                  // -> tasks[0] = { id: "1", rev: 3, … }
reviewer:  task({ tasks: [{ id: "1", completed: true }],
                  expects: [{ id: "1", rev: 3 }] })  // -> applied: content rev 4
coder:     task({ tasks: [{ id: "1", text: "Rewrite the intro" }],
                  expects: [{ id: "1", rev: 3 }] })  // -> the WHOLE call is REJECTED:
                                                     //    task "1" changed since revision 3 (now 4, last edited by "reviewer"); re-read and retry; changed fields: completed.
coder:     task({})                                  // -> re-read: rev 4, completed true, text untouched
coder:     task({ tasks: [{ id: "1", text: "Rewrite the intro" }],
                  expects: [{ id: "1", rev: 4 }] })  // -> applied on top: rev 5

// — claim and release: one record is protected while it is being edited —
coder:     task({ claim: ["1"] })                    // -> owner/ownerThreadId = coder (+ its thread),
                                                     //    15-minute lease; rev is STILL 5, so no token broke
reviewer:  task({ tasks: [{ id: "1", completed: false }],
                  expects: [{ id: "1", rev: 5 }] })  // -> REJECTED while the lease is live:
                                                     //    task "1" is claimed by "coder" until 2026-11-08T09:30:53.657Z; release it or take it over first.
coder:     task({ release: ["1"] })                   // -> coder's own claim clears (one `release` event); rev stays 5
reviewer:  task({ tasks: [{ id: "1", completed: false }],
                  expects: [{ id: "1", rev: 5 }] })  // -> applied now: rev 6
reviewer:  task({ takeover: ["1"] })                  // takeover is the override: it seizes even a LIVE lease —
coder:     task({ release: ["1"] })                   // -> refused, because reviewer holds it now
```

**Not OpenCode parity.** OpenCode's current dev branch (`fd8268e`, 2026-10-27)
ships a different, experimental `todowrite` tool: gated behind `experimental.todo`,
it takes `{ todos: [{ content, status }] }`, replaces the whole list on every
call, has no ids, and its list is derived by the UI from the last call. Sources:
[`plugin/todo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/todo.ts),
[`todowrite.txt`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/todowrite.txt),
[`tool-todo.test.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/test/tool-todo.test.ts).
`tasks` deliberately uses a partial patch with stable ids instead: it never rewrites
the list, it does not copy that API, and it does not claim compatibility.

### Session records (`profiles`, `chapters`, `locations`)

Three more harness-owned stores follow `tasks`' lifecycle exactly - registered,
searchable, and opened by `toolRequest` (R9-R11) - one store per
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
| `profiles` | `name`, `description` | `traits` (string[]; trimmed, deduplicated), `notes` | `{ total }` |
| `chapters` | `title`, `summary` | `content` (default `""`), `status` (`planned`/`draft`/`complete`, default `planned`), `order` (integer) | `{ total, planned, draft, complete }` |
| `locations` | `name`, `description` | `notes` | `{ total }` |

Chapter-specific rules: `list` and every mutation result carry **summaries**
without the body — only `get` returns `content`; `update` rejects a blank
`title`/`summary` but may clear `content` to `""`; `order` sorts the returned
list (ordered chapters ascending first, unordered ones after in insertion order)
and the live store is never re-sorted. There is no move action: update `order`.
Profiles and locations return whole records, so an empty `notes` is a normal
stored value, and `traits: []` clears a profile's traits. Like `tasks`,
nothing is persisted and no HTTP/UI surface reads these stores: the tool result
is the record.

### Agent results (`agentManage`, `agentResult`)

Two core tools, declared to the primary **and** to every subagent, let an agent
inspect what the session's other agents have produced without reading their
transcripts:

```ts
agentManage({})                                  // agents + truncated result previews
agentResult({ agent: 'researcher' })             // latest completed result
agentResult({ agent: 'researcher', invocationId: '3', offset: 4000 })
```

`agentManage` lists EVERY configured agent (even one that has not run), with
`name`, `role`, `model`, `invocationCount`, and up to five recent invocations
newest first. Each invocation preview carries `invocationId`, `kind` (`root`,
`delegation`, `fork`, or `autoanswer`), `status`, `contentLength`, a
200-character `preview`, and a `truncated` flag. A running invocation has status
`running` and no content — a streamed partial is never presented as a result.

`agentResult` returns one completed answer. Omit `invocationId` for that agent's
latest **finished** result (completion order, so a fork that finished earlier does
not mask the root's answer). The result is `{ content, contentLength, offset,
limit, hasMore, nextOffset? }`: pages are 4000 characters by default and at most
8000, so a long answer is read in full across pages instead of being silently
truncated by the harness's 64 KiB tool-result bound. Offsets are UTF-16 code-unit
indices; page edges snap to surrogate-pair boundaries, so a non-BMP glyph is never
split (the returned `offset` is the one actually used). A failed/cancelled invocation
reports `error` and no content; an unknown id or agent is an error; an agent that
has not run returns `status: 'empty'`.

Both tools expose ONLY the completed assistant answer value. They never return
system instructions, transcript messages, tool arguments, or tool bodies. Results
are held in a bounded per-harness registry (64 completed records, active runs are
never evicted) and are **durable across snapshot/restore**: terminal results —
completed, failed, or cancelled — are stored as an optional `agentResults` array
in the existing snapshot v1 (`invocationId`, `sequence`, `completedOrder`, agent,
role, kind, status, content, error?), so a restart keeps every answer that already
exists. Running invocations are omitted from a snapshot (they have no answer yet),
old snapshots without the field restore with an empty registry, restore advances
the run/completion/branch id counters so a later run cannot overwrite an archived
id, and `reset()` clears the archive with the conversation.

### Tool names

A tool is named for **what it does best**. Where ONE action is the capability, the
name is that action - `read`, `write`, `edit`, `glob`, `grep`, `shell`, `search`,
`fetch`, `download` - because those are the words a model already types. Where a tool
owns a DOMAIN of related operations, the name is the domain: `files` manages files and
folders (list, move, copy, delete, mkdir), exactly as `tasks` is the task list and
`profiles` the profile store. `<namespace><action>` is a useful convention for
grouping a large catalogue, not a requirement: forcing it here would name the
capability after its weakest operation (`fileMove`) and split one coherent bundle
across several rows the model then sequences by hand - the harness launches a
message’s tool calls CONCURRENTLY, so separate calls have no order between them.
Two things ARE required: the name is the word a caller reaches for, and no two tools
share one.

| Old name (removed) | Current name | Notes |
|---|---|---|
| `requestTools` | `toolRequest` | core; always declared |
| `createTool` (tool) | `toolCreate` | core; the host method is `harness.createTool()` |
| `createTaskTool` | `tasks` (one collection of the one store) | core; always declared (R9-R11 renamed the tool from `todoManage` and made its action enum ONE patch command; records-engine Decision J renamed `task` → `tasks`, and T3 deleted the factory — `core/task.ts` is now the collection SPEC and `core/records.ts` is the store) |
| `delegate` | `delegate` | core; primary only, when subagents exist |
| `readFile` | `read` | **batched and bounded**: `(paths: (string \| { path, startLine?, startColumn?, maxLines? })[])` → `{ files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, bytes, error? }], truncated, bytes, contentBudget }` |
| `writeFile` / `fileWrite` | `write` | **batched**: `({ path, content }[])` → `{ path, bytes }[]` |
| `editFile` | `edit` | **batched**: `({ path, oldString, newString, replaceAll? }[])` → `{ path, replacements, bytes }[]` |
| `listFiles` / `fileList` | `files` | **one manager, five operations**: `(ops: ({ op: 'list' \| 'move' \| 'copy' \| 'delete' \| 'mkdir', path?, from?, to?, overwrite?, recursive?, force?, offset?, limit? })[])` → `{ results: [ ...ordered receipts... ], bytes, contentBudget }`; the paged listing is one OPERATION and its cursor lives inside that receipt (`{ entries, truncated, nextOffset, offset, limit, bytes }`), which is why `files` declares ONE property instead of three |
| `globFiles` + `searchFiles` / `fileGlob` | `glob` (names) + `grep` (contents) | the one mode-switched tool is SPLIT: `glob` never reads file contents and has no `content` property, `grep` takes a required `pattern` and answers `{ matches, truncated, bytes, contentBudget }` |
| `runCommand` | `shell` | unchanged shape |
| `gitDiff` | `gitDiff` | unchanged (already `namespace`+`action` shape) |
| `syntaxCheck` | `syntax` | renamed, and `language` is now a validated free name (javascript, typescript, tsx, jsx, json, python, plus aliases) instead of a two-value enum |
| `websearch` | `search` | the **tool**; the `websearch` harness configuration field keeps its name |
| `clock` | `timeNow` | app tool |
| `wordCount` | `textCount` | app tool |
| `roll` | `diceRoll` | app tool |
| `searchNotes` | `noteSearch` | app tool |
| `summarize` | `textSummarize` | app tool |
| `flaky` (tool) | `testFlaky` | the `flaky` **harness/preset id** is unchanged |

`profiles`, `chapters`, and `locations` were added under their final
names, so they have no removed-name row. All three are core session tools with the
same incremental action set — see
[Session records](#session-records-profilemanage-chaptermanage-locationmanage).
`actionRequest` and `threadFork` were also added under their final names and follow
the `<namespace><action>` shape (`action`+`Request`, `thread`+`Fork`) where a single
action names them; they are
conditional harness-owned tools (registered, searchable) — see
[Owner questions and history forks](#owner-questions-and-history-forks).

The three web entries are bare verbs for the same reason: `search`, `fetch`, and
`download` are the words a model types. A domain name is likewise not an exception: a
tool named for the domain it owns (`files`) is the same decision made once, not a
deviation from it.
`websearch` and `webfetch` remain harness CONFIGURATION field names (only the tool
is renamed), and `download` needs no field at all — it is an always-registered
preset. See [Web search](#web-search-search), [Page fetch](#page-fetch-fetch), and
[File download](#file-download-download).

There are **no aliases**: the old names are gone from the wire surface, the
exports, the catalogue, and the reserved-name list. This is a deliberate breaking
change — a catalogue with two names for one tool makes discovery ambiguous. Harness
ids (`instruct`, `research`, `workspace`, `reviewer`, `planner`, `demo`, `flaky`),
agent ids, and the `websearch` and `webfetch` configuration fields are *not* tool
names and are unchanged.

### Preset tools

Shipped with the package, each usable standalone or registered on a harness:

```ts
import {
    syntax,
    read,
    write,
    edit,
    files,
    glob,
    grep,
    shell,
    gitDiff,
    download
} from '@underload/harness';

await syntax({ code: 'def f():\n    pass', language: 'python' });  // true
await syntax({ code: 'const a: number = 1;', language: 'ts' });     // true (typescript, tsx, jsx and json too)
await read(['package.json']);                                   // { files: [{ path, content, … }], truncated, bytes, wireBytes, contentBudget, skipped, note? } — `note` only when a file of 65536 bytes or more came back cut
await write([{ path: 'notes.md', content: '# Notes' }]);            // [{ path, bytes }]
await files([{ op: 'list', path: ['src', 'task'] }]);                // { results: [{ op: 'list', path: 'src', entries: ['src/a.ts', 'src/nested/', 'task/b.ts', …], truncated, nextOffset, offset, limit, bytes }], bytes, contentBudget }
await files([{ op: 'list', path: 'src', offset: 200 }]);           // page 2 of the same list
await edit([{ path: 'a.ts', oldString: 'let x', newString: 'let y' }]);
await glob({ patterns: ['src/**/*.ts'] });                          // { files, truncated } — names only
await grep({ pattern: 'TODO', patterns: ['*.ts'] });                // { matches, truncated, bytes, contentBudget } — lines
await gitDiff();                                                    // { exitCode, stdout, stderr, truncated, timedOut, stderrTruncated, aborted }
await shell({ command: 'git status' });                        // { exitCode, stdout, stderr, truncated, stdoutTruncated, stderrTruncated, stdoutBytes, stderrBytes, stdoutDroppedBytes, stderrDroppedBytes, outputPath, timedOut, aborted, exitSignal, durationMs, linesChained }
await shell({ command: 'npm test', timeoutMs: 600_000 });      // 1..600000 ms; tree killed best-effort on timeout, and a run that already finished is never reported as timed out
await shell({ command: 'echo a\nexit 9' });                    // 9, not 0: on Windows the lines are chained with `&&` first, because cmd.exe would run only the first
await download({ url: 'https://example.com/spec.pdf' });            // toolMedia() envelope: { content: { url, finalUrl, contentType, kind, name, bytes, media: 'attached', mediaId }, __toolMedia: [attachment] }
```

Each tool lives in its own file under a capability folder (`tools/syntax/`,
`tools/files/`, `tools/command/`, `tools/webdownload/`, and the harness-owned
`tools/runtime/`), and the
barrel also exports the preset set as `presetTools`. **Every new harness preloads
that catalogue**: `read`, `write`, `edit`, `glob`, `grep`, and `download` are
declared immediately (core), while `files`, `syntax`, `shell`, and `gitDiff`
cost context only after a toolRequest query enables them; `presets: false` turns
the preload off.

Registration is **descriptor-driven** (`R7`-`R9`). `harness({})` scans
`tools/**/*.tool.ts`, reads each entry's `metadata` + `registration` literals
through the TypeScript AST, and registers every row whose `activation` the current
configuration satisfies — in scan `order`. There is no hand-written registration
list and no static import of a `.tool.ts` module: adding a file is enough for a new
harness to pick it up. `src/tools/descriptors.ts` uses the SAME scanner for the
package catalogue (`presetTools`, the server's preset/core groups), so a cold
process lists and loads a brand-new entry with nothing regenerated. `core/tool-manifest.ts`
is the generated, data-only mirror of that scan (one `import()` per entry) and is
the **browser** inventory — the browser cannot scan, so it is the only rows a
browser can see. See `docs/runtime-tools.md` for the activation
table and the policy flags (`primaryOnly`, `answerExtraction`, `control`,
`pendingOnly`).

The preset exports are **lazy proxies**, not implementations. The discovered
descriptor rows hold the static metadata (name, description, tags, schema) and the
loader names each implementation in its own `import()` branch; the body —
and the `node:fs` / `node:child_process` / `node:vm` it needs — loads the first
time a tool is called. A row the generated manifest does not know yet is compiled
from its editable source on first call instead of failing on a missing label (T24),
so a new preset is executable before the manifest is regenerated. Constructing a
harness or listing the catalogue therefore costs no Node built-ins, and a model that
never asks for `shell` never loads it. The published build turns each branch
into a chunk next to `dist/underload-harness.mjs`; all of `dist/` is shipped, and
`inlineDynamicImports` must stay off or the split is undone.

**The file tools are batched.** `read`, `write`, `edit`, and `files`
each declare exactly ONE array property (`paths` / `files` / `edits` / `ops`), so the
single-property rule hands `execute` the array itself. A direct call and a model
call therefore reach the same code:

```ts
await read(['a.ts', 'b.ts']);                                  // { files: [{ path, content, … }, …], … }
await read([{ path: 'big.ts', startLine: 400, maxLines: 50 }]); // one bounded window
await write([{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }]);
await edit([{ path: 'a.ts', oldString: 'a', newString: 'b' }]);
```

**`read` is bounded by default.** Each result window returns at most 5000 lines
(`maxLines`, hard maximum 20000) starting at `startLine` (1-based, default 1). The
whole batch shares a fixed 256 KiB budget measured on the **serialized JSON** result
(escaping included), allocated by **demand** rather than by headcount: a file that
needs less than its share hands the difference back to the files that were actually
cut. Reading streams in 64 KiB chunks and stops at the cap, so a huge file or a
single giant line is never loaded wholesale. Because the budget is measured on the
form the harness delivers it in, `wireBytes <= contentBudget` always holds and a
full-budget read survives the harness's own wire cap with its continuation fields
intact — the failure this design removed was a 64 KiB content budget next to a 64 KiB
wire cap, which meant a full read was *always* over the cap and got replaced by an
envelope that destroyed `nextLine`/`nextColumn`. `content` is raw text whose
first line is `startLine` — line numbering is metadata, not a prefix, so a model can
still copy exact text into `edit`. A truncated entry reports `nextLine`,
`nextColumn` (a 0-based UTF-8 byte offset within that line, normally 0; non-zero
only when a giant line was cut mid-line) and `nextByte` (the absolute file offset).
`{ path, startLine: nextLine, startColumn: nextColumn }` resumes there by counting;
`{ path, startByte: nextByte, startLine: nextLine }` resumes by **seeking**, which is
how a large file should be walked, because a line-based window at line N must count
from byte 0 and therefore costs time proportional to the skipped prefix. Binary
rejection is based on the bytes DECODED WHILE STREAMING: a NUL or invalid UTF-8
sequence in a chunk that was read rejects that ENTRY as binary instead of returning
replacement characters. It is not whole-file validation — bytes after the last read
chunk (for example far past a truncated window) are never inspected, so one file can
read as text for a narrow window and as `EBINARY` for a wide one. A call accepts at
most 100 paths, which bounds the metadata side of the response as well as the
content. `bytes` reports raw content bytes, `wireBytes` the exact serialized length,
and `contentBudget` the cap this call was subject to.

A path that cannot be read is a per-entry result, not a failed call: it keeps its
ordered position with empty `content`, `bytes` 0, the empty-window range
(`endLine = startLine - 1`), and `error: { code, message }` — `ENOENT`, `EISDIR` (a
directory; use `glob` or `files`), `EACCES`/`EPERM` (a real denial), `EBINARY`, or
`EIO` — while every other requested file is still read. A failed entry consumes
**no** budget, so it cannot shrink the window of a file that does exist. Only a
malformed REQUEST (bad path, bad range, empty or oversized array) rejects the whole
call, before any disk access, because a broken request must not look like a
successful read.

`write` and `edit` validate **every** entry (shape, non-empty strings, no
NUL, unique target file) before the first write, and `edit` also reads and
match-checks every file first, so one bad entry leaves every file untouched.
Uniqueness is by **real file identity**, not spelling: on Windows `notes.txt` and
`NOTES.TXT` are one file, and so is a symlink alias on any platform, so a batch that
names one file twice is rejected before anything is written (Linux keeps `a.ts` and
`A.ts` as two files). A filesystem error part-way through the write phase is reported
with the paths already completed: there is **no transaction and no rollback**.
Read-match-write is held as **one critical section per file** (`tools/files/lock.ts`,
keyed by that same file identity), so two calls that name one file cannot both report
success while one silently overwrites the other — the later call sees the earlier
call's text and fails with "no match". A multi-file batch takes its locks in sorted
identity order, so overlapping batches cannot deadlock. This orders calls inside one
process; it makes no claim about another process or worker thread.

| Tool | Signatures | Result |
|---|---|---|
| `syntax` | `({ code, language: string })` — any name, validated at run time | `true` when the snippet parses and `false` when it does not. Parsers: `javascript` (a classic script, so no `import`/`export` or top-level await) and its `js` alias, `typescript`/`ts`, `tsx`, `jsx` (syntax diagnostics only — a type error still parses), `json` (strict; one leading BOM is ignored), and `python`/`py`/`python3`. Any other language is an ERROR that lists the supported set, never a verdict |
| `read` | `(paths: (string \| { path, startLine?, startColumn?, startByte?, maxLines? })[])` — non-empty, ≤100 | `{ files, truncated, bytes, wireBytes, contentBudget, skipped, note? }`; one window per path, ordered, **no default line cap** (the byte budget is the limit; an explicit `maxLines` is 1..20000); `note` is present only when a file of `65536` bytes or more came back cut — it names up to 2 such paths with their size, what was returned, and the exact continuation, and counts the rest; an unreadable path keeps its slot with `error: { code: 'ENOENT' \| 'EISDIR' \| 'EACCES' \| 'EPERM' \| 'EBINARY' \| 'EIO', message }` and consumes no budget; only a malformed request rejects the call |
| `write` | `(files: { path, content }[])` — non-empty | ordered `{ path, bytes }[]`, creating parent directories; duplicate target files rejected; serialized per file against a concurrent `edit` |
| `edit` | `(edits: { path, oldString, newString, replaceAll? }[])` — non-empty | ordered `{ path, replacements, bytes, match? }[]`; `oldString` must be unique unless `replaceAll`; exact-first matching with typographic-variant and trailing-whitespace fallbacks, line endings matched and preserved; all edits preflighted; read-match-write is one per-file critical section |
| `files` | `(ops: ({ op: 'list' \| 'move' \| 'copy' \| 'delete' \| 'mkdir', path? \| from+to, overwrite?, recursive?, force?, offset?, limit? })[])` — non-empty, ≤100 | `{ results, bytes, contentBudget }` with ONE ordered receipt per operation: `list` gives `{ path, entries, truncated, nextOffset, offset, limit, bytes }` (200 entries by default, 1000 maximum, one shared 64 KiB entry-text budget across the call), `move`/`copy` give `{ path, to, kind, bytes }` and gate an existing destination on `overwrite`, `delete` gives `{ path, removed, recursive }` and refuses a non-empty directory without `recursive` (`force` reports a missing path as a no-op), `mkdir` gives `{ path, created }`; a failed list entry carries its own `error: { code, message }`, a failed mutation rejects the call naming the operations already applied (no rollback) |
| `glob` | `({ patterns?, paths?, maxResults? })` | `{ files, truncated }` — NAMES only, capped at 100; there is no `content` property any more |
| `grep` | `({ pattern, patterns?, paths?, maxResults? })` | `{ matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget }`; caps at 100 matches and 64 KiB of match text, matching time-bounded |
| `shell` | `({ command, cwd?, timeoutMs?, input?, saveOutput? })` | `{ exitCode, stdout, stderr, truncated, stdoutTruncated, stderrTruncated, stdoutBytes, stderrBytes, stdoutDroppedBytes, stderrDroppedBytes, outputPath, timedOut, aborted, exitSignal, durationMs, linesChained }`; caps keep the **beginning and the end** with an in-band `[... N bytes omitted ...]` marker, and a cut stream is teed whole to `outputPath` |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut }`; read-only |

**Search is two tools now, not one tool with two modes.** `fileGlob` used to
switch between "which names match?" and "which lines match?" depending on whether the
caller sent `content`; the rename split that responsibility so each capability is
addressable by name, and there is no `fileSearch` alias either:

- `glob({ patterns?, paths?, maxResults? })` → `{ files: string[], truncated }`
  (glob matching only, and it never opens a file);
- `grep({ pattern, patterns?, paths?, maxResults? })` →
  `{ matches: { path, line, text, textTruncated, bytes }[], truncated, bytes, contentBudget }`
  (a content search restricted to files matching `patterns`).

Both share one walker, so the rules below apply to each of them.
`patterns` (default `["**/*"]`) are OR-ed, and a pattern with no `/` also matches
file names at any depth. A pattern is matched against each file's path **relative to
the root that found it**, and results carry that root as their prefix, so
`glob({ paths: ['src'], patterns: ['**/*.ts'] })` returns `src/a.ts` and
`src/nested/b.ts` (never an absolute path, and never a pattern matched against one).
`paths` (default `["."]`) are walked in caller order; roots that resolve to the same
directory (a symlink alias, or `src`/`SRC` on Windows) are walked once, and files are
deduplicated by resolved identity while keeping the first root's prefix. The cap is
global across every root.
`.git` and symlinks are always skipped, `node_modules` is skipped unless a root is
placed inside it, and both tools read the `.gitignore` files **at or below** each root and
skip what those files ignore — a root you name explicitly is still walked, because no
rule from above a root reaches into it. `grep` additionally skips binary files and files
over 1 MiB.

`grep` bounds its OUTPUT as well as its time: each match `text` is cut to 1 KiB on a
code-point boundary (`textTruncated` says when), and the whole call stops at a 64 KiB
aggregate with `truncated: true`, so one match on a minified line cannot flood a tool
response. `bytes` reports what the response consumed and `contentBudget` the fixed cap.

Content matching is **time-bounded**: a JavaScript regex can backtrack
exponentially (`(a+)+$` needs seconds on a 31-byte line), so the match loop runs in
`node:vm` with a cumulative 30-second budget and a pattern that exceeds it fails with
a clear error instead of hanging the call. That budget is the only time bound on the
match; no separate overall request timeout is added. It is a timeout, not a sandbox,
and an ordinary grep over a large tree is unaffected (the context is reused per
search and the boundary is crossed once per file, not once per line).
`gitDiff` runs a fixed `git diff` argv with no shell, colour, external diff
drivers, or textconv, and never stages or commits.

`syntax` never executes the code it checks. Its Python half needs a Python 3
interpreter on `PATH` and throws if none is found — a missing interpreter is a
setup problem, not a verdict of "invalid syntax", and the same rule covers an
unsupported `language` and a non-string `code`: both throw, so `false` always means
"this snippet did not parse". Every language module is imported on demand, so a
JavaScript check never loads the TypeScript compiler, the compiler never loads the
interpreter, and JSON needs neither.

Every preset is tagged. The five core file tools and `download` are always
declared, so a model
reads/writes/edits/lists names with `glob` and finds text with `grep` directly, and
pulls a real file with `download` without a discovery round.
`files` is found with `files`/`list`/`move`/`rename`/`copy`/`delete`/`mkdir`; a shell
with `shell`, git with `git`, syntax checks with `javascript`/`typescript`/`json`/`python`,
and `fetch` with `web`/`fetch`/`url`/`read`/`research` when the harness opted into
`webfetch`. Those
searchable tools stay out of the context window until enabled.

**These presets hold no sandbox.** `read`, `write`, `edit`,
`shell`, and `gitDiff` act with the permissions of the host process. Run the
harness inside a container, a worktree, or an account you are willing to have
modified, or wrap `execute` to add a fence.

### Web search (`search`)

One opt-in search tool over **Exa**, **Tavily** or **Linkup**. It is deliberately
**not** part of `presetTools`: a search tool needs a provider key, and a key
belongs to one harness. Nothing is registered unless the configuration asks for it
*and* a key is available.

```ts
// Library: environment-backed (EXA_API_KEY / TAVILY_API_KEY / LINKUP_API_KEY)
const writer = harness({
    agents: { writer: agent({ ... }) },
    websearch: true
});

// Library: injected environment, or explicit per-provider overrides
const writer = harness({
    agents: { writer: agent({ ... }) },
    websearch: {
        env: { EXA_API_KEY: readSecretFromYourStore() },
        tavily: { apiKey: () => vault.get('TAVILY_API_KEY') },
        linkup: { apiKey: () => vault.get('LINKUP_API_KEY') }
    }
});

// Standalone factory: undefined when no provider key is available
const definition = createWebSearchTool({ env: process.env });
```

Registration rules:

| Rule | Effect |
|---|---|
| `websearch` absent or `false` | No tool. |
| `websearch: true` or `{}` | Resolve `EXA_API_KEY` / `TAVILY_API_KEY` / `LINKUP_API_KEY` at construction. |
| `exa.apiKey` / `tavily.apiKey` / `linkup.apiKey` | Explicit override (string, or a getter called once at construction and reused for every search — no per-request rotation); an explicit blank key disables that provider instead of falling back to env. |
| Provider without a key | Absent: not in the schema, not callable. |
| No provider with a key | No tool at all, even when opted in. |
| `tools: { search }` configured | Your tool wins; the built-in factory is not consulted. |

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
`search` in its direct-call catalogue, configured or not. With a key it is a
normal callable entry (`POST /api/tools/search`); without one the entry is
marked `unconfigured`, carries the provider variable *names* and a non-secret hint,
and a direct call answers a normal `{ "ok": false }` tool failure explaining what
to set and that a restart is required. The catalogue is built when the server
starts — after `.env` loading, never at module import — and each descriptor may
carry `availability: { state, environment, hint }`. Key values never appear in a
descriptor, hint, CLI listing, or UI.

The same rule applies to preset descriptors (`GET /harnesses`, the `/presets`
alias, and the canonical bootstrap document). Every shared-toolbox preset
(`instruct`, `research`, `workspace`, `reviewer`, `planner`, and the `flaky`
example) declares `environmentTools: ['search', 'fetch']`, which the
server appends to its `tools` list **and** to `coreTools` **only** when the runtime
catalogue has an executable definition for that name: a resolved key for `search`
(`src/server/harnesses/websearch.ts`), the `webfetch` opt-in for `fetch`
(`src/server/harnesses/webfetch.ts`, whose `native` provider needs no credential). A
keyless host therefore advertises `fetch` but not `search`, so a preset card never
claims a tool the session cannot call.

The built-in tool is **core** (R18): when configured, it is declared on every
request and the model calls it directly — no discovery round. The keyless entry is
still visible in the Tools tab with its `unconfigured` hint, but it is not runnable:

```ts
// Direct call on the tool the factory returned (or on the registry entry)
await definition?.({ query: 'harness tool discovery', maxResults: 5 });
// -> { provider: 'exa', query, maxResults, results: [{ title, url, snippet, published? }] }

// Per-call provider override. The legal values are exactly the providers whose
// key resolved; Linkup sends no publication date, so `published` is absent there.
await definition?.({ query: 'linkup endpoints', provider: 'linkup' });
// -> { provider: 'linkup', query, maxResults, results: [{ title, url, snippet }] }
```

| Bound | Value |
|---|---|
| Default results | 5 |
| Maximum results | 20 (`maxResults` is clamped, not rejected) |
| Title / snippet | 300 / 1,000 characters |
| Published date / URL | 64 characters (dropped when longer) / 2,048 characters (the row is dropped when longer) |
| Response body | 512 KiB (524,288 bytes) — declared `content-length`, then counted per streamed chunk |
| Per-request timeout | 15 s, `AbortController`, timer cleared in `finally` |
| Retries / failover | None: one request, one provider, one attempt |

Provider choice: the first provider with a key in the fixed order
**exa → tavily → linkup**, so Exa wins when several keys exist and a single-key
setup needs no decision. The `provider` argument is only offered when more than
one is configured, and an unknown or unconfigured value is a readable error that
lists what IS available. Statuses 401/403 (key), 402/432/433 (credits),
429 (rate limit), 5xx, timeouts, non-JSON bodies, and network failures become one
sanitized sentence each — the provider body is never echoed. There is no retry and
no failover, so a bad call cannot double spend.

Secrets never leave the constructed tool: they travel only in a request header
(`x-api-key` for Exa, `Authorization: Bearer` for Tavily and Linkup), never in the
URL or JSON body. The description, schema, arguments, result, and progress events contain
no key, and every string a provider returns is passed through a redactor built
from **all** configured keys, however short (a page or error that echoes one
becomes `[redacted]`). Redirects are refused, `http(s)` URLs are required in
results, and returned excerpts are untrusted content — the tool description tells
the model to cite them, not follow instructions found inside them.

The adapters are loaded with `import()` on first execution and use `fetch` plus
plain JSON: no SDK dependency, no network work at construction, and the published
build emits one chunk per adapter like the other lazy tools.

### Page fetch (`fetch`)

The reading sibling of `search`: one opt-in tool that fetches ONE page and answers
as **text**. It is also **not** in `presetTools` — the hosted providers
close over a key — but unlike `search` its factory always returns a tool, because
the default provider needs no credential at all.

```ts
// Library: registers `fetch` with the keyless native provider
const writer = harness({
    agents: { writer: agent({ ... }) },
    webfetch: true
});

// Library: also offer the hosted crawlers (per call, never a silent upgrade)
const writer = harness({
    agents: { writer: agent({ ... }) },
    webfetch: {
        env: { EXA_API_KEY: readSecretFromYourStore() },
        linkup: { apiKey: () => vault.get('LINKUP_API_KEY') }
    }
});

// Standalone factory: always a Tool, whatever the environment holds
const definition = createWebFetchTool({ env: process.env });

await definition?.({ url: 'https://example.com/article' });
// -> { provider: 'native', url, contentType, format: 'markdown', characters, truncated, content, title? }

// Text instead of converted markdown, and a hosted crawler when one is configured
await definition?.({ url: 'https://example.com/article', format: 'text' });
await definition?.({ url: 'https://example.com/sso-page', provider: 'linkup' });
// -> { provider: 'linkup', ..., contentType: 'text/markdown' }; 'exa' works the same way
```

| Rule | Effect |
|---|---|
| `webfetch` absent or `false` | No tool. |
| `webfetch: true` or `{}` | Registers `fetch` with `native` only, unless `EXA_API_KEY` / `LINKUP_API_KEY` is present. |
| Visibility | `core` (R9-R11): a harness that registered `fetch` declares it on every request, so researching a page costs no `toolRequest` round. The gate is registration - with no `webfetch` opt-in there is no tool and nothing is declared. |
| `exa.apiKey` / `linkup.apiKey` | Explicit override (string or getter, resolved once at construction); an explicit blank value disables that provider instead of falling back to env. |
| Hosted provider without a key | Absent: not in the schema, not callable, not named in the description. |
| `provider` omitted | `"native"`, always. A hosted crawler is never chosen silently, because it costs credits. |
| `provider: "tavily"` | Rejected — Tavily is a search provider only. |
| `tools: { fetch }` configured | Your tool wins; the built-in factory is not consulted. |

| Bound | Value |
|---|---|
| Native response body | **100 KiB** (102,400 bytes) — declared `content-length` first (the body is cancelled before a byte is read), then counted per streamed chunk |
| Returned content | 24,000 characters (`truncated: true` when cut) |
| Hosted provider response body | 512 KiB — the shared provider-request budget, not the page budget |
| Per-request timeout | 15 s, `AbortController`, timer cleared in `finally` |
| Retries | None, except one honest-`User-Agent` retry when Cloudflare challenges the browser one |
| Redirects | **Followed** (a page URL legitimately redirects); the result reports the final URL |
| URL / title / content type | 2,048 / 300 / 200 characters |

`fetch` is **text only**. A body with no `content-type` header is treated as text,
and the readable set is `text/*`, `application/json`, `*+json`, `application/xml`,
`*+xml`, `application/xhtml+xml`, the JavaScript/TypeScript MIMEs, and
`image/svg+xml` (SVG is text). Everything else — any other `image/*`, `audio/*`,
`video/*`, `application/pdf`, `application/octet-stream` — is refused with one
sentence that points the model at `download`. The URL must be absolute `http(s)`
with no userinfo; a `user:pass@host` URL is rejected rather than sent with the
credentials on the wire.

The hosted providers answer with server-rendered markdown, so a cut page is the
only local bound there (Exa also takes `text.maxCharacters` server-side; Linkup
has no such knob). Status failures, timeouts, and network errors become one
sanitized sentence per provider, and every returned string passes through the
redactor built from **all** configured web keys.

### File download (`download`)

The byte path. `fetch` answers text and refuses a binary; `download` accepts **any
content type**, caps the transfer, and hands the real bytes to the model as
multimodal input. It is a normal **preset** (`presetTools.download`, a named
export, and a callable server catalogue entry): registration is `always` and
visibility is `core`, so it needs no configuration field, no key, and no
discovery round.

```ts
import { download } from '@underload/harness';

await download({ url: 'https://example.com/diagram.png' });
await download({ url: 'https://example.com/a.zip', name: 'release.zip' });
// -> toolMedia() envelope:
//    { content: { url, finalUrl, contentType, kind, name, bytes, declaredBytes?,
//                 media: 'attached', mediaId },
//      __toolMedia: [attachment] }
```

| Rule | Value |
|---|---|
| Size cap | **20 MiB** (`20 * 1024 * 1024` raw, decoded bytes). Checked against `content-length` before the body is touched, then per streamed chunk for a host that lies or declares nothing |
| Timeout | 60 s for the whole transfer; `context.signal` is honoured, so `toolCancel`/run abort stops the socket instead of only its delivery |
| Attempts | One; no retry |
| Redirects | Followed; `finalUrl` reports where the bytes came from |
| URL | Absolute `http(s)`, no userinfo, at most 2,048 characters |
| Disk | **Nothing is written.** There is no output path and no file on the host: the bytes are held on the committed `tool` message (in memory, and inside a persisted snapshot when the host has one) and are gone when that transcript is |
| `name` | Optional plain filename, always sanitized (no path separators, no drive colon, ≤200 characters); otherwise the server `content-disposition` or the URL basename, with an extension fallback from the MIME |

What the model and the host see are different things, and that split is the
point:

- the **tool result text** is the small JSON summary above (a few hundred bytes,
  so the 64 KiB result budget never touches it) — never a base64 blob;
- the **bytes** travel on the committed `tool` message's `attachments`, which is
  what lets them survive history, snapshot restore, and forks;
- a `tool_result` progress event, and the server's manual
  `POST /api/tools/download` answer, carry `ToolMediaDescriptor[]` (id, kind,
  name, mime, size) — **metadata only, never base64**;
- the **transport** expands the attachments into a clearly labelled USER-role
  multimodal payload **after** the whole contiguous tool block, so strict
  provider tool-call pairing is never broken.

Known families keep their media kind (png/jpeg/webp/gif images, mp4/webm/ogg/mov
video, wav/mp3 audio, pdf) and are checked against their magic signature, so a
host that claims `image/png` and sends HTML fails loudly instead of quietly. Any
other type is `kind: 'file'` and goes out as the standard OpenAI-compatible file
part (`{ type: 'file', file: { filename, file_data } }`) with its real bytes.

Per kind the transport emits the documented part for it: `image` → `image_url`
(data URL), `pdf` → `file` (data URL), `audio` → `input_audio` (raw base64, and
OpenAI's enum means wav or mp3 only), `video` → `video_url`, `file` → the file
part above.

**Limits a user of this feature must know.** File support is the model/provider's
call, not a promise from this package: an image or PDF is broadly accepted, video
is an OpenRouter extension (the transport only sends the video part when the
request host is `openrouter.ai`), and a generic file part may be rejected by the
provider with an explicit error — nothing is ever dropped silently. An uploaded
(`kind: 'file'` composer) attachment keeps its historical 4 MiB per file / 8 MiB
per turn / 4 files caps and is still refused by the transport; only tool-attached
download media uses the 20 MiB profile. And bytes are not free downstream: one
20 MiB download becomes ~27 MiB of base64 in persisted history, in every later
request body, and in a snapshot, so it counts against `forks.maxHistoryBytes`
(default 8 MiB serialized history) and can block or shrink a fork. There is no
UI preview of downloaded files.

**Your own tools can attach bytes the same way.** `toolMedia(content, attachments)`
is exported from `@underload/harness` (the companion of `toolUi()`), and the
harness unwraps it for any tool, not only `download`:

```ts
import { tool, toolMedia } from '@underload/harness';

const chart = tool({
    description: 'Render one report as a PNG.',
    tags: ['chart', 'image'],
    parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, scale: { type: 'number' } },
        required: ['id'],
        additionalProperties: false
    },
    // `content` is the ordinary (small) result the model reads; the attachment is
    // what it SEES. `data` is raw canonical base64 and `size` the DECODED length.
    execute: async ({ parameters }) => {
        const png = await render(parameters.id);

        return toolMedia(
            { id: parameters.id, bytes: png.length },
            [{
                id: 'chart-1',
                kind: 'image',
                marker: '[Image 1]',
                name: `${parameters.id}.png`,
                mime: 'image/png',
                size: png.length,
                data: png.toString('base64')
            }]
        );
    }
});
```

The default profile is `DOWNLOAD_ATTACHMENT_LIMITS` (20 MiB per file, 4 files), and
the attachment still has to pass the shared validator: matching MIME **and** magic
signature for a known kind, a plain filename, and canonical base64 whose `size`
agrees with `data`. A host tool that over-attaches fails the call loudly with
`Cannot attach tool media: …` instead of degrading into a filename-only answer.

### `harness()` — the execution loop

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    primary: 'writer',               // entry point (explicit; first key is the default)
    subagents: ['researcher'],       // optional delegation allowlist
    tools: { search: tool({...}) },
    report: { progress: async (event) => {} }
});
```

| Field | Meaning |
|---|---|
| `agents` | Every brain, keyed by name. **The first key is the entry point** unless `primary` names another one. |
| `primary` | Which agent the callable runs. Optional; must name a registered agent. Use it in multi-agent configs so routing is explicit. |
| `subagents` | Allowlist the primary may delegate to. Optional; defaults to every agent except the primary. Empty (or a one-agent config) means no `delegate` tool at all. Must not contain the primary or an unknown name. |
| `maxIterations` | Model requests one agent run may make before the harness throws. Every request counts: the first answer, each immediate tool continuation, a pause turn, and every completion or timed wake. **Default 16** — the library's runaway guard. Must be a positive safe integer (validated at construction); there is no unlimited value. The app presets set 1000. |
| `forks` | `{ enabled?, maxDepth?, maxConcurrent?, maxHistoryBytes?, maxBranchRecords? }`. `enabled` defaults **true** and registers the core `threadFork` tool. Defaults: depth 2, 4 live branches, 8 MiB serialized branch history, 64 retained records; every numeric bound must be a positive safe integer. |
| `interaction` | `{ actionRequest?: (context, signal) => Promise<HarnessActionChoice>, autoAnswer? }`. Presence registers the core `actionRequest` tool. `autoAnswer` defaults true and only governs a child/fork request's automatic owner fork; it never selects an option by itself. |
| `tools` | Extra tools, keyed by the name the model calls. A configured tool replaces a preloaded preset of the same name. |
| `toolSources` | Map of wire name → editable source path. Registered after the baseline/presets and before `tools`; each revision is inspectable through `toolSource()`/`toolSources()`. |
| `toolFolders` | Ordered external folders scanned recursively for `*.tool.ts` modules. Absolute or cwd-relative; later folders win name collisions; invalid folders/modules fail construction. Folder code is trusted code with process permissions. |
| `maxEnabledTools` | Maximum number of SEARCHABLE tools enabled at once (default **32**). Core tools never count. This is the persistent enabled-set bound, not a per-query match cap; `toolRequest` reports the full union in `matched` and what the bound withheld in `omitted`. |
| `presets` | Preload the discovered `preset`-group entries. **True by default**; `false` filters that group out, so the runtime (harness-owned) rows plus `tools` remain. `download` is one of those preset entries, so `presets: false` removes it too. |
| `websearch` | `true` or `{ env?, exa?, tavily?, linkup? }`. Registers the core `search` tool when at least one provider key resolves; the default provider is the first key in the **exa → tavily → linkup** order and `provider` overrides per call. Absent, `false`, or no key means no tool. A configured `tools.search` wins. |
| `webfetch` | `true` or `{ env?, exa?, linkup? }`. Registers the `fetch` tool even with no key at all, because the default provider is the keyless native GET; `EXA_API_KEY` / `LINKUP_API_KEY` only add the per-call hosted crawlers. Absent or `false` means no tool. A configured `tools.fetch` wins. |
| `report.progress` | Awaited for every step — a UI or `console.log`. |
| `commands` | Slash commands this harness can run: `{ name, description, usage?, execute }`. Registered **after** the built-ins (`/help`, `/tools`, `/task`, `/websearch`, `/webfetch`), so a name that collides with one — or repeats inside the list — fails construction. See [Slash commands](#slash-commands). |
| `plugins` | Optional programmatic extension (`createAgent`, `addTool`, `addCommand`, and lifecycle subscriptions through `api.on` — including a `turn.before` handler that can rewrite the request or return a `HarnessTurnDecision` for the run). The plugin phase runs after the built-ins and `commands`, so a plugin **replaces** a name rather than colliding with it — the same override semantics `addTool` has. Authoring rules, precedence, and the decision semantics: [`docs/plugins.md`](./docs/plugins.md). |

The registry key is the identity: `writer: agent({...})` names the agent
`writer` and `search: tool({...})` is the name the model calls. You never
repeat the name inside the definition.

| Member | Meaning |
|---|---|
| `writer(input)` | Run the entry agent to completion. Resolves with its message. |
| `writer.name` | The entry agent's name. |
| `writer.agent` | The entry agent. `writer.agent.messages` is the live transcript. |
| `writer.agents` | Every agent, including the entry one. |
| `writer.subagents` | The agents the primary may delegate to, keyed by name. Empty when delegation is not configured. |
| `writer.tools` | Every registered tool, keyed by wire name: the preset/app catalogue plus the harness-owned set (`toolRequest`, `toolList`, `toolManage`, `toolCreate`, `tasks`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `delegate` when it exists, `threadFork` when forks are enabled, and `actionRequest` when interaction is configured). Registration is not declaration: `tool.visibility` and `toolRequest` say which half a name is in. |
| `writer.discoveredTools` | Names `toolRequest` has enabled, in discovery order. Read-only copy; `reset()` empties it. |
| `writer.toolCreate(config)` | Host-side runtime creation. Same validation/registry/budget as the model's `toolCreate`; throws `HarnessError`. |
| `writer.executeTool(name, parameters)` | Run one registered tool directly, with this harness's context (`agent`, `agents`, `run`). The server's manual-execution path: discovery gates the model, not the operator, so an un-discovered searchable tool still runs. Reserved policy is kept (`toolCreate` registration, primary-only `delegate`); an unregistered name throws, and `actionRequest`/`threadFork` are refused because they need the owning run. |
| `writer.commands` | The registered slash commands, keyed by name **without** the leading slash (`commands.help` answers `/help`). Every read is a frozen defensive copy of the live registry, so a command registered later shows up in the next read — and mutating the copy changes nothing. |
| `writer.executeCommand(input)` | Run one slash line (`'/task add "testing"'`) in THIS process. The model is never called and no progress event is emitted; a built-in that calls a tool still fires `stateChange('tool_execute')`, so a persistence layer sees the mutation. Throws `HarnessError` for a line without a leading `/` or an unknown name, and rethrows what a host command throws; every recoverable failure comes back as `{ content, isError: true }`. See [Slash commands](#slash-commands). |
| `writer.registerCommand(command)` | Register or **replace** one command at runtime, with `registerTool`'s replace semantics. Validates the name and the definition and throws `HarnessError` without touching the registry when either is invalid. |
| `writer.branches()` | Detached copies of retained branch audit records (`HarnessBranchRecord[]`), newest terminal records within `maxBranchRecords`; active records are never evicted. Ephemeral: not part of the snapshot. |
| `writer.branch(id)` | One detached branch record by id, or `undefined`. |
| `writer.reset()` | Reset the entry agent's conversation, forget discovered tools, and clear `tasks`, `profiles`, `chapters`, `locations`, and the `agentManage`/`agentResult` registry. Created tools stay registered but are no longer enabled. Branch records and pending questions are ephemeral runtime state and are **not** cleared here. |
| `writer.nestedRuns()` / `writer.nestedRuns('refuse')` | Read, or arm once, this instance's **nested-run policy** (`'allow'` by default; armed on EVERY lane worker replica at hello, whatever preset that lane rebuilt). Under `'refuse'` every door that could start a CHILD conversation throws the named `nested-run-unsupported` limitation before the child, its transcript or its provider request exists: a tool's `context.run(...)`, a `harness(...)` call made from inside a tool body, `harness.sendThreadInput(...)`, a sibling brain run through `context.agents`, `delegate`, and a `threadFork` branch. On a refusing instance those doors are refused at the SURFACES a tool is handed, not at a stack depth: `context.harness` is a guarded view of the live handle (`src/harness.ts` `toolHandleView`) whose callable, `sendThreadInput` and sibling-brain members throw whenever they are reached — a reference the body stores and fires after its own call settled is refused just the same, while every plain read and every routed `harness.runtime` operation passes through. An inline harness still receives the strict-identical live handle. A tool reads the same policy from its own context (`context.nestedRuns`) and takes its local path when it says `'refuse'`. Arming a value the build does not recognise throws, and only a lane worker arms it — an inline harness never changes, see [Per-thread CPU isolation](#per-thread-cpu-isolation-threadexecution-worker). |

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
clears conversations, discovery, tasks and records, but created tools stay
registered (so a session cannot mint an unbounded number of them by resetting), and
only a new harness starts the count again. `toolCreation` configures the capability:
`'all'` (default — `toolCreate` is declared to every agent), `'primary'` (declared to
the primary only; a subagent that guesses the name gets a clear refusal), or `false`
(no model-facing tool at all — the host method `harness.createTool()` still works).

**No sandbox.** A created tool is compiled with the host realm's `Function`
constructor and runs with the process's full permissions — the same trust model as
`shell`. There is no isolation, no allowlist, and no network/filesystem fence.

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
subagents**, a guessed call from a subagent is rejected, and `run()` refuses to
re-enter an agent that is already running, so delegation is one level deep and
cycles fail fast. `delegate` is not registered at all when there are no
subagents. A tool can still call `ctx.run(name, input)` directly when it needs a
sibling turn mid-tool, but that path is inside one agent's turn rather than
model-visible delegation. Under `threadExecution: "worker"` a lane refuses it — the
child a tool body starts would exist only inside that lane; see
[Per-thread CPU isolation](#per-thread-cpu-isolation-threadexecution-worker).

Two controls shape a child without changing that rule. **Time:** a delegated child has
no wall-clock limit — `timeoutMs` is an optional bound the caller sets when it wants
one (see [The loop](#the-loop)), and a child that is still running is abandoned with
`toolCancel` on the `callId` its pending placeholder names. **Scope:**
`scope: { tools: [...] }` is a hard allowlist the child neither sees nor calls outside
of — with one door that can never be locked, `toolRequest`, so a restricted child can
always report the capability it is missing instead of looping on what it has. Enabling
a tool through discovery is not the same as being scoped to it: a tool the allowlist
omits is still refused at launch, with the refusal as a readable result.

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
  not). A **worker lane** is the third case for the same local path: a replica arms
  the nested-run refusal, `context.nestedRuns` reads `'refuse'`, and the tool
  condenses instead of handing the notes to a child that nobody would publish.

#### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    declare                -> core tools + everything toolRequest enabled
    no tool calls?         -> report done, return the message
    schedule each call     -> CONCURRENT async work, not a serial loop
    results stream back    -> each `tool_result` carries its own duration
    wake                   -> sync:  once EVERY sync call of that message settled
                             async: immediately, one turn per completion
    append settled results -> then turn() again
```

Tool calls are **scheduled concurrently**. The model stream stays serialized per
agent (one request at a time); calls execute as async work and their results are
appended as they settle. What decides *when the model is asked again* is each
call's **turn mode** (`tool({ mode })`, documented with
[`tool()`](#tool--an-action-the-model-can-request-or-you-can-call)): a `sync`
completion joins its message's sync group and only the drained group buys a turn,
while an `async` completion re-prompts the model on its own — immediately, even
while a `sync` call from an earlier message is still running. A parked group is a
**park, never a block**: any other wake (an async completion, the periodic wake
below, steering input, or the run's abort) releases it, and the loop re-reads real
state after waking. This changes four things a caller must know:

- **A sync batch is one turn.** A message whose calls are all `sync` produces no
  intermediate request: the follow-up turn is built after the last one settled, so
  the model sees every result of the batch at its original call position. `shell`,
  `delegate`, `threadFork` and `actionRequest` are `async`, so they keep the
  per-completion wake below.
- **The top-level promise is the drain point.** `await writer(input)` resolves only
  when the entry agent's response is complete AND every pending call — delegated
  child runs included — has finished. A per-agent `done` event is one response, not
  terminal session work: it can arrive while that agent's own calls are still
  running (listed in the event's `pending`), and the agent is woken when outcomes
  land (`wakeup`, or once its message's sync group drains).
- **A periodic wake keeps a turn honest.** While calls are pending the runtime also
  wakes the agent on a timer (default **600000 ms**), so a hung call is visible and
  can be killed instead of blocking forever. There is **no automatic hard tool
  timeout**: pending calls are interrupted, not resumed, on restart, and a hanging
  call ends only through an explicit cancel (or the tool's own configured timeout).
  - **A THREAD has no wall-clock limit either (policy 2026-11-09).** A conversation —
    a delegated child, a `threadFork` branch, a host thread, a steered turn — stops
    when its agent gives its final answer, and nothing external ends it on a clock.
    `delegate`'s `timeoutMs` is an **optional, caller-set** bound with **no limit as
    its default**: pass one (a model may ask for 1..3600000 ms) when you believe a
    limit is warranted, and the child that hits it comes back as the structured
    `status: "cancelled"` result with `partialContent` and `cancelledAtMessage`.
    CORRECTED IN PLACE: the default used to be a finite **300000 ms (5 minutes)**;
    the mechanism stays, the finite default does not. What still ends a long run is a
    tool's own timeout, the `maxIterations` **request count** (16 by default — a
    count bound, deliberately untouched by a policy about time), the run-depth and
    record caps, `toolCancel`, and — ADDED 2026-11-09 when the plugin-pipeline
    user-facing lists landed — an explicit **`stop` decision** from a `turn.before`
    plugin ([`docs/plugins.md`](./docs/plugins.md)): a policy assertion made by code
    the application shipped, at a boundary the run is already parked at, not a clock
    — nothing expires — and it takes the run's own abort path (the conversation
    records `stopped`, the invocation records `cancelled`, and everything the run
    appended is rolled back). A child that is stuck is abandoned by naming its
    pending `callId` to `toolCancel`; the placeholder the model receives while the
    child runs says so. And because a thread is unbounded, a stopped conversation is
    restarted by a **host** prompt (`sendThreadInput`), never by an agent's
    `threadSend` — the host owns stopping and reviving, so a model cannot undo a
    Stop the operator pressed.
- **Ordering is completion order.** Concurrent side effects are not ordered: two
  file writes or two commands may interleave, and results come back in the order
  they finish, not the order the model asked for them. Tools are async promises
  inside one Node process — **no OS worker or CPU isolation**, so CPU-bound
  JavaScript still blocks the event loop. A server-hosted session can opt out of
  that limitation per deployment with `HARNESS_THREAD_EXECUTION=worker`, which runs
  each conversation (loop and tool bodies) on its own worker thread; see
  [Per-thread CPU isolation](#per-thread-cpu-isolation-threadexecution-worker).
  The other blocking cost a server pays is its own durability — the whole-document
  checkpoint and the per-event journal lines — and `HARNESS_IO_EXECUTION=worker` moves
  that write side onto one IO worker thread per database root; see
  [Off-loop durability](#off-loop-durability-ioexecution-worker).

Cancellation follows the same model. A run's signal (and `toolCancel({ callId })`
for one call) reaches every running tool; `shell` honours it and kills its
process tree. `toolCancel` logically settles/aborts that call's own task: its late
result is ignored. Cancellation is **idempotent**: cancelling a call that already
completed, failed, or was already cancelled succeeds with
`{ cancelled: true, alreadySettled: true }` and changes nothing, so a caller never
has to check the pending list first. Only a `callId` this run never started is an
error. Arbitrary JavaScript cannot be preempted — a created tool keeps
its CPU until it yields. A whole-run abort does more than flip the signal: it
preempts an uncooperative provider request, releases the child actor/restore slot
immediately, and rolls back the cancelled turn's in-flight prompt state without
waiting for the provider. A provider socket/generator that never returns may stay
in memory, but it no longer blocks the actor or re-delegation; a late provider
commit is guarded by the core precommit check. One host-side caveat: a
`report.progress` reporter that hangs can still stall the mailbox (and therefore
cancellation); there is no guaranteed reporter watchdog.

Delegation is the same mechanism: an `delegate` call stays **pending** until
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

Two conditional harness-owned tools cover
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
  when such histories must be forkable. One `download` of a 20 MiB file is already
  ~27 MiB of base64 in that transcript, so a download-heavy session forks only
  after the bound is raised.
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

The transport never retries: it reports every failure as an `error` frame (any HTTP
status, a provider error on a `200` stream, a malformed frame, a truncated stream
that never reported a completion) or by throwing. Retries belong to the **agent**
(see [`agent()` → Retries](#retries)), so there is exactly one retry owner and a
custom transport gets the same behaviour for free.

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
| `tool_result` | `agent`, `name`, `content`, `isError`, optional `outcome` (`'completed' \| 'failed' \| 'rejected' \| 'cancelled'` — the structured reason; `isError` is always `outcome !== 'completed'`), optional `durationMs`, optional `pending`, optional `ui` (declarative panels), optional `media` (`ToolMediaDescriptor[]` — `id`, `kind`, `name`, `mime`, `size` only, never base64; see [File download (`download`)](#file-download-download)) |
| `usage` | `agent`, `usage` (`input`, `output`, `total`, optional `cached`) — one per model request, tool rounds included |
| `done` | `agent`, `message`, optional `pending` |
| `wakeup` | `agent`, `reason: 'pending-tools'`, `pending` |
| `retry` | `agent`, `attempt`, `maxAttempts`, `delayMs`, `error: { message }` — the failed model attempt was discarded and the same request is re-sent |
| `attempt_commit` | `agent`, `attempt`, `maxAttempts` — one model request SUCCEEDED and its answer is committed. Emitted for every committed response that does NOT get a `done`: a tool-calling round (closed after its tool calls) and a text response superseded before it could be reported. Everything before it is final, so a later `retry` of a NEWER request must not discard it |
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
branded envelope with `toolUi(content, panels)` from `@underload/harness`. The
companion seam for BYTES is `toolMedia(content, attachments)` — see [File download
(`download`)](#file-download-download) — and the two compose in any nesting order,
because the delivery boundary peels both brands to reach the plain content.

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
  panels?, media?, durationMs }` — `result` is the underlying content, and `media`
  is the `ToolMediaDescriptor[]` projection (`id`, `kind`, `name`, `mime`, `size`)
  of anything a tool attached with `toolMedia()`, so a `download` answer never puts
  base64 on the wire either;
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
| `EXA_API_KEY` | Opt-in `search` provider (the preferred default) for the real presets (`instruct`, `research`, `workspace`, `reviewer`, `planner`, and the `flaky` example), **and** the optional hosted `fetch` provider |
| `TAVILY_API_KEY` | Second opt-in `search` provider (search only — Tavily has no `fetch` provider) |
| `LINKUP_API_KEY` | Third opt-in `search` provider, and the second optional hosted `fetch` provider |
| `HARNESS_THREAD_EXECUTION` | Server only: `inline` (default) or `worker` — runs each conversation's turn on its own OS worker thread. See [Per-thread CPU isolation](#per-thread-cpu-isolation-threadexecution-worker) |
| `HARNESS_WORKER_IDLE_MS`, `HARNESS_MAX_LANE_WORKERS`, `HARNESS_WORKER_HANDSHAKE_MS`, `HARNESS_WORKER_ENTRY` | Server only: the lane-worker bounds and entry file for `worker` execution (same section; every value is validated, and a bad one aborts startup) |
| `HARNESS_IO_EXECUTION` | Server only: `inline` (default) or `worker` — runs the database checkpoint and the event journal on one IO worker thread instead of on the request loop. See [Off-loop durability](#off-loop-durability-ioexecution-worker) |
| `HARNESS_IO_WORKER_ENTRY` | Server only: explicit IO worker entry file; otherwise `dist/underload-harness.io-worker.mjs`, else the source entry (dev/test) |

`fetch` and `download` need **no** key: `webfetch: true` registers the native
page GET on a keyless host and declares it core (R9-R11), and `download` is an
always-registered preset the model opens with `toolRequest`. See
[Page fetch (`fetch`)](#page-fetch-fetch) and [File download
(`download`)](#file-download-download).

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

## Slash commands

A slash line is an **operator action, not a prompt**. `/task add "testing"` runs in
the process that owns the session — the CLI, the HTTP server, a UI composer's submit
handler — and it never reaches a model, never enters a queue lane, and never spends a
request. The harness owns the registry (`src/harness.ts`), so every front end resolves
one name to one implementation and `/help` reports the same list everywhere.

```ts
const writer = harness({
    agents: { /* … */ },
    commands: [
        {
            name: 'standup',
            description: 'Summarize today.',
            usage: '/standup [channel]',
            execute: ({ harness, rest }) => ({ content: `standup ${rest}`.trim() })
        }
    ]
});

await writer.executeCommand('/standup general');   // { content: 'standup general' }
writer.commands.standup;                           // the installed definition
```

### One grammar for every surface

`parseCommandLine` (exported from the package root, implemented in
`src/core/command.ts`) is the ONE tokenizer, so the same line means the same thing in
a terminal and over HTTP:

| Input | Resolves to |
|---|---|
| `draft a plan` | not a command — the parser answers `undefined` and the host sends the text to the model |
| `/task add "fix: the build"` | `name: 'task'`, `args: ['add', 'fix: the build']` |
| `/websearch Professor Vance` | `name: 'websearch'`, `args: ['Professor', 'Vance']`, `rest: 'Professor Vance'` |
| `/task ""` | `args: ['']` — an explicit empty argument, not a missing one |
| `/Task ADD note` | the NAME alone is folded → `name: 'task'`, `args: ['ADD', 'note']` (so `/task ADD` really is an unknown action, while `/TASK add` is not) |
| `/` | a command-shaped line with an EMPTY name, so the lookup misses and reports an unknown command |

The tokenizer is the shell-ish minimum and the whole contract: whitespace separates
tokens, `"…"` and `'…'` group text, `\` escapes the next character inside and outside
quotes, an unmatched quote consumes the rest of the line instead of throwing (an
operator is mid-edit in a REPL), and a trailing `\` keeps itself. Only the command
name is case-folded, because **arguments are data**: a task text or a search query
must reach the tool exactly as written.

A command implementation receives
`{ harness, name, args, rest, input }` — the live handle, the folded name, the
tokenized arguments, the verbatim trimmed tail, and the original line — and returns
`{ content, isError?, data? }` (`HarnessCommandContext` / `HarnessCommandResult` in
`src/types/index.ts`). `content` is always displayable text, `isError` marks a
recoverable failure so a host styles it instead of parsing prose, and `data` carries
the structured value for a host that wants a table (a CLI ignores it).

Registration validates the name against `COMMAND_NAME_PATTERN`
(`/^[a-z][a-z0-9-]{0,31}$/`): one lowercase letter, then lowercase letters, digits or
`-`, at most 32 characters. Lowercase-only is what keeps ONE canonical spelling, so
`/Task` and `/task` can never become two entries that disagree. A name may be written
`'/plugin'` or `'plugin'` — the slash and the case are stripped before validation.

### Built-ins

| Command | Behavior |
|---|---|
| `/help [command]` | Every command in this harness, sorted, one `/name  description` line each plus an indented `usage:` line when the command declares one. `/help <name>` prints that one entry through the same renderer; an unknown name is a readable answer with `isError`, never an exception. |
| `/tools [filter]` | The tools registered in this harness, sorted, as `name — description…` lines. Descriptions are previewed at 200 characters and newlines collapse, because a full `tasks` description alone is ~1.5 KB. The filter is the raw tail (several words work) and matches the name **or** the description, case-insensitively; no match answers `no registered tool matches "…"` with `isError`. |
| `/task [list \| add <text> \| complete <id> \| reopen <id> \| remove <id>...]` | This session's task list, through the live `tasks` tool. The command name kept the singular (Decision J); the three ownership verbs are gone with the lock (Decision P) — `/task claim 1` now answers the usage line. See the actions below. |
| `/websearch <query>` | Searches with this session's `search` tool and prints `N result(s) via <provider>:`, then title / URL / snippet / published per hit. The **raw tail** is the query, so quoting an exact phrase survives tokenization. |
| `/webfetch <url>` | Fetches one page through this session's `fetch` tool and prints `title`, `url`, `content type`, `characters`, then the extracted text. The **first token** is the URL, so a trailing flag cannot corrupt the address. |

`/task` actions, every one of them against the live tool:

```text
/task                    read the current page (same as `/task list`)
/task add <text>         add one task — quotes let a space-bearing text through
/task complete <id>      mark one task completed (a patch: the stored text is untouched)
/task reopen <id>        mark one task pending
/task remove <id>...     remove one or more ids
```

**Corrected in place (records-engine Decision P, 2026-11-09):** `/task claim <id>...`,
`/task release <id>...` and `/task takeover <id>...` are DELETED, with the tool's `claim` /
`release` / `takeover` / `leaseMs` parameters and the `owner` / `ownerThreadId` /
`leaseUntil` fields. There is no ownership to move: any agent may write any record, and the
conflict control is the `expects: [{ id, rev }]` token the command builds from the read it
just did.

Each answers the same readable block: `#<id> [x]/[ ] <text>` rows (or `No tasks.`), the
`N total, N completed, N pending` tally, and the page cursor
(`page: offset 0, limit 20, showing 3, next offset 20`). A row carries NO ownership suffix
(the `(claimed by …)` suffix went with the lock, Decision P), so a rejected
`/task complete 7` reads as what it is: a stale revision token, answered with the current
record. The `#` prefix on each
id is there so an operator can copy `/task complete 7` straight out of the listing.
Because these are `harness.executeTool('task', …)` calls and not a private store, the
command inherits the tool's own bounds (200 tasks, 4000 characters each, 20 per page by
default, 100 maximum) and the next `/task` really lists what `/task add` wrote.

`complete`, `reopen` and `remove` are **guarded writes**: the command reads the store
first (following `page.nextOffset` until the list is exhausted) and sends the real
`expects: [{ id, rev }]` tokens, so an edit by another agent between the read and the
write is the tool's stale error instead of a lost update — never an invented revision.
An unknown id gets no token, so the tool's own `task has no task with id "99".` is what
the operator reads. `claim`, `release` and `takeover` send no token at all: an ownership
action never changes `rev`. They also run **unthreaded**, which makes the holder pair
`(entry agent, no thread)` — so `/task release` lifts only the operator's own or an
expired claim, and `/task takeover` is the documented override for a live one. The read
costs one extra `tool_execute` notification per guarded command (a debounced save, not a
model turn).

`/websearch` and `/webfetch` are pass-throughs to the **conditional** `search` and
`fetch` tools, so an unconfigured session gets guidance instead of a registry error:
`/websearch` names `websearch: true` plus `EXA_API_KEY` / `TAVILY_API_KEY` /
`LINKUP_API_KEY`, `/webfetch` names `webfetch: true` and notes that its native
provider needs no key, and `/task` in a harness without the `tasks` tool says the tool
is not registered. Every command body is capped at the same 64 KiB the model path uses
(`MODEL_TOOL_RESULT_BUDGET_BYTES`) with a plain `… truncated: …` marker, because a
command result is human-facing rather than a JSON envelope for a model.

### Contributing commands

| Path | Collision policy |
|---|---|
| `commands: [...]` in `harness({})` | Registered after the built-ins in the same declarative phase, so colliding with a built-in or repeating a name inside the list **fails construction**: `Command "/task" is already registered. Built-in commands and "commands" entries share one namespace and must be unique; use a plugin or harness.registerCommand() to override "/task".` |
| `api.addCommand(name, definition)` in a plugin | The plugin phase runs after the built-ins and `commands`, so it **replaces** by name — exactly like `addTool`. This is how a tool package swaps a built-in out. |
| `harness.registerCommand(command)` at runtime | Also **replaces** by name (the `registerTool` rule: "already registered" is never an error). The next command and the next `/help` see the new implementation. |

`description` is required, `usage` is optional (a blank one is dropped), and `execute`
must be a function — sync or async. All validation happens before the first mutation,
so a rejected candidate leaves the registry exactly as it was, and the installed
record is a NEW object: mutating the definition you passed in cannot edit a published
command (or its `/help` line) afterwards. `Harness.commands` is a frozen copy **per
read** and `executeCommand` looks the name up at call time, so a replacement is
visible to the next command and never to one already in flight.

```ts
// Runtime registration replaces by name, exactly like registerTool.
writer.registerCommand({
    name: 'standup',
    description: 'Today, briefly.',
    execute: () => ({ content: 'ship the docs' })
});

writer.registerCommand({
    name: '/task',
    description: 'Ours now.',
    execute: () => ({ content: 'our /task wins' })
});   // overrides the built-in by name
await writer.executeCommand('/TASK add "note"');   // one name, case-folded on lookup
```

### Commands over HTTP

`POST /sessions/:id/tasks` is the supported command surface, and the store's
`dispatch()` (`src/server/sessions.ts`) is the one splitter: text that is not
command-shaped goes to `enqueue()` **untouched**, and a leading `/` runs
`executeCommandTurn()` **before the `202` body is produced** — so the turn in the
response is already terminal and nothing ever entered a queue.

- The recorded turn is an ordinary `SessionTurn` whose `prompt` is the line you typed,
  carrying three synthesized events: `start`, `tool_call` (`name: 'command'`,
  `arguments: '{"input":"/task add …"}'`), and `tool_result` with the command's
  `content`, its `isError`, and `outcome: 'completed' | 'failed'`, paired by `callId`.
  The browser therefore draws a command with the same tool card it uses for a real
  tool call, and the transcript survives a reload with no special case anywhere.
- There is no `text`, no `done`, and **no `usage`**: nothing was generated and nothing
  was billed, and an absent tally is more honest than a fabricated zero. `status` is
  `done` or `error`.
- The turn has no `threadId`, because a command acts on the **session** (its task
  list, its tool registry), never on one conversation. A `threadId` in the request
  body is therefore accepted and ignored — validating it would invent a 400 for a
  value with no meaning — while `attachments` and `references` are a `400`
  (`A slash command cannot carry attachments.` /
  `A slash command cannot carry result references.`), because a command has no schema
  to bind media to.
- Commands deliberately bypass the single-flight gate and the pending-turn cap, so
  `/task` stays readable while a model run streams. `session.status` and `lastError`
  are untouched: a command is not a run, and a failed `/task bogus` must not raise the
  session-wide error banner a real run owns. A command whose tool call is genuinely
  unsafe right now is refused by the harness, and that refusal becomes an error turn.
- An unknown command, and anything a host command throws, becomes a **readable error
  turn** (status `error`, the message as the tool result) rather than a `500`.
- The legacy `POST /sessions/:id/messages` route does **not** treat a leading `/` as a
  command: its response-owned SSE contract predates the registry, so that line still
  goes to the model. Slash commands are supported on `/tasks` only.
- A host handle built before the command registry has no `executeCommand`; `dispatch`
  then falls back to `enqueue()`, which is exactly what such a server did before.

The harness state a command mutated (a `/task add`) is committed with the terminal
turn record: `session.core` is refreshed from the live harness (best-effort — the turn
is terminal either way) and the turn itself is saved with a strict write **before** the
`202` leaves, so a reload shows the same task list. A failed write is an error, not a
silent success: the server never promises a transcript it did not write.

### Commands in the CLI

The terminal resolves a line through the same parser and the same registry
(`src/server/cli/commands.ts`), with one deliberate difference: its own commands are
checked **first**, so they shadow harness commands of the same name.

| CLI command | What answers |
|---|---|
| `/help` | The REPL's own list, then `harness commands:` — `harness.commands` rendered verbatim, so a plugin override or a runtime `registerCommand` appears there automatically. Both sections stay, even where a name is shadowed, so the listing cannot disagree with the registry. |
| `/tools` | The direct-call **catalogue** (grouped, with the `.env`-aware availability hints, rebuilt after `.env` is read) — not the session registry. This is the shadow an operator wants. |
| `/reset` | Clears every agent conversation plus the entry harness. |
| `/presets` | The preset catalogue. |
| `/exit`, `/quit` | Quit. Closing readline and draining an in-flight run stay in `src/server/cli/index.ts`. |

Anything else command-shaped is forwarded to `harness.executeCommand` **verbatim**:
only the parser folds the name, so `/websearch Mixed Case Query` searches for exactly
what was typed and `/task add "Testing"` stores the case the operator wrote (the old
whole-input `toLowerCase()` is gone). Ordinary text is the only thing that starts a
model run, and a line typed while another line is still in flight is dropped, so a
command and a run never overlap. The interactive banner prints the live registry
(`harness: /help /task /tools /webfetch /websearch`) so the operator sees what this
session can run. In `--json` mode stdout carries the event stream, so command output
is written to stderr; an `isError` result always goes to stderr.

### Errors a command can produce

Everything an operator can get wrong is an answer, not an exception:

| Situation | What comes back |
|---|---|
| line without a leading `/` | `executeCommand` **throws** `a command must start with "/"` — that is a host bug, since only command-shaped lines should reach it |
| unknown command (`/nope`, or a bare `/`) | `executeCommand` **throws** `unknown command: /nope`. The CLI prints it plus `hint: /help lists the commands this session can run`; the server records an error turn |
| missing argument | `/task: "add" needs the task text.` then `usage: …`, with `isError` (same for `"complete" needs a task id.` and `a query is required.` / `a URL is required.`) |
| too many arguments | `/task: "list" takes no arguments (got 1).`, `/task: "complete" takes one id (got 2).`, `/help: "help" takes at most one command name.` |
| unknown `/task` action | `/task: unknown action "bogus".` plus the usage line |
| tool not registered | the `/websearch` / `/webfetch` guidance text above, or `/task: the "task" tool is not registered in this harness.` |
| the tool rejects the call | `<label>: <the tool's own message>` — the label is the command and subaction (`/task add`, `/webfetch`), covering an unknown task id, a failed provider call, a non-text page, a stale `expects` (another agent changed the record between the command's read and its write), and a record another agent holds a live claim on |

Only a command that throws on purpose escapes: `executeCommand` does not wrap a host
command's exception, so a built-in's recoverable failures return
`{ content, isError: true }` by convention.

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

In an interactive session the terminal answers its own `/reset`, `/tools`,
`/presets`, `/help` and `/exit` (or `/quit`), and every other command-shaped line —
the harness built-ins `/help`, `/tools`, `/task`, `/websearch` and `/webfetch` plus
anything a plugin or `harness.registerCommand()` contributes — runs through this
session's command registry, with the line forwarded verbatim so argument case is
preserved. `/help` prints both sets. See [Slash commands](#slash-commands) for the
command table, the collision rules, and how a command becomes a recorded turn.
`HARNESS_BASE_URL`,
`HARNESS_API_KEY`, and `HARNESS_MODEL` provide the same defaults as the flags;
they can come from the shell or from the package-root `.env` (see
[Environment file](#environment-file)). `EXA_API_KEY`, `TAVILY_API_KEY` or
`LINKUP_API_KEY` enables the opt-in `search` tool in the live presets
(`instruct`, `research`, `workspace`); with no key it is simply absent. Those
same keys also add the hosted `fetch` providers (`exa`, `linkup`); the `fetch`
itself and the always-registered `download` are available either way, because
their default paths need no credential. `--tools` lists the direct-call
catalogue, and the **Web search** row says `unconfigured` (naming the variables it
needs) when no key resolved.

Because tools run concurrently the CLI prints their own timing rather than
implying a call is the only thing happening:

```
→ read {"path":"README.md"}
← read · 1.3s
  ...
  pending · search 900ms
  instruct-model · tool_calls · 1 tool call · 1 tool still running
~ instruct woke · 1 still running · search 900ms
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
yarn dev:frontend         # Vite on all interfaces, dual-stack (localhost + LAN); /v1/harness proxies to the running service
yarn preview:frontend     # built UI on :5180 (loopback only); same /v1/harness proxy

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
default `/v1/harness` root onto the service mount at `http://127.0.0.1:5000/v1/harness`.
Start the service first (see [Service host](#service-host-v1harness)), or override
the root with `?apiRoot=` / `VITE_HARNESS_API` — or from the UI itself, with the
“Harness server URL” field in the Endpoint & model dialog (see “Connecting the UI to
the service” below).

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
serves only the UI and proxies `/v1/harness`, so a stopped service gives a proxy error,
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
toolbox is identical: all nine package tools (`syntax`, the six file tools
`read`/`write`/`edit`/`files`/`glob`/`grep`,
`shell`, `gitDiff`), the app tools (`timeNow`, `textCount`, `diceRoll`,
`noteSearch`, `textSummarize`), opt-in `search`, and the harness-owned tools
(`toolRequest`, `toolCreate`, `tasks`, `profiles`, `chapters`,
`locations`, `agentManage`, `agentResult`, plus `delegate` only when the
preset declares a subagent,
`threadFork` when forks are enabled, and `actionRequest` when the host supplies an
interaction handler).
R18 splits declarations: the five core file tools, the harness-owned
`toolRequest`/`tasks`, and the environment pair it actually registered (a configured
`search`, an enabled `fetch`) are always declared, while `download`, `files`,
`shell`, `gitDiff`, `syntax`, and the app tools are discovered. Choosing a harness
changes the agents, not the tools.

Agent identities live in **`src/agents/`** as trusted `AgentProfile` values:
`instruction` plus a `guidelines` list. `agentInstruction()` joins them into ONE
system prompt (identity line, blank line, `Guidelines:` bullets) because several
OpenAI-compatible gateways accept a single system turn — seeding two `system`
messages used to drop the guidelines on those models — so the definition a UI renders
and the prompt a model receives are the same text. A client can select an agent id; it
can never supply instruction text. That join is the **default**: when a harness or session
stores an instruction override, `agentInstruction()` returns it verbatim as the complete
prompt and appends no guideline block, because the override is edited as one box holding
the whole effective prompt.

Guidelines carry **policy, not an inventory**. Every request already declares its
callable tools with name, description, and schema (`offerDeclarations` in
`src/harness.ts` → the `tools` array in `src/transport/openai.ts`), so a line that
only repeats which tools exist duplicates context and goes stale when a visibility
changes. What remains in prose is what a schema cannot say: the searchable catalogue
behind the declared set, a keyless host having no `search`, the conditional
`delegate` gate, and the missing sandbox. Those lines are shared constants in
`src/agents/guidelines.ts`, and `agents.test.ts` refuses a profile that re-lists
declared tools or outgrows its prompt budget. The discovery selector's own contract
(the uncapped names/regex/tags union, `maxEnabledTools`, newest-request precedence,
`matched`/`omitted`) lives in `toolRequest`'s description, which the model reads as
part of that declaration.

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
Delegation is **one level deep** and a subagent never receives `delegate`; the
profiles say so, and none of them asks a subagent to delegate again.

The two remaining presets are examples, and T5 un-shipped them: they are NOT in the
catalogue a server lists (`GET /api/harnesses` returns only the five real roles). A
host or a test injects them explicitly (`createHarnessRegistry(ALL_PRESET_TEMPLATES)`
or `FIXTURE_PRESETS`), and an older session recorded while they shipped still restores
because the scripted factory is looked up in that superset:

| Preset | Shape |
|---|---|
| `demo` | Scripted offline template — no endpoint needed; discovers `timeNow` with `toolRequest`, calls it, then answers. Deliberately not a live harness, so it uses timeNow only. Editable: metadata edits keep the script; an executable edit upgrades it to a live profiled harness. |
| `flaky` | The shared toolbox plus a tool that throws two calls out of three, to show recoverable failures. Editable: metadata edits keep `testFlaky`; an executable edit rebuilds the live toolbox with it retained. |

`flaky` is the only preset-specific extra tool: it is excluded from the shared
toolbox because it fails on purpose and keeps attempt state. Every entry - shipped or
fixture - is a template the registry copies; there is no read-only category (R20.1). Legacy
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
discovery, `tasks`, and the three record stores) and disappear with the
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
| `GET /api/harnesses` | Harness descriptors (`primary`, `subagents`, `coreTools`, `agentModels?`, `agentInstructions?`, `builtin`, `editable`), provider defaults, and the trusted `agents` list. Every entry is an editable application copy; `editable` is always `true` (compatibility only) |
| `POST /api/harnesses` | Create a harness from trusted agent ids — body `{ name, title?, description?, primary, subagents?, agentModels?, agentInstructions? }` → `201 { harness }` |
| `PATCH /api/harnesses/:name` | Change any harness — body `{ title?, description?, primary?, subagents?, agentModels?, agentInstructions? }` → `{ harness }` |
| `DELETE /api/harnesses/:name` | Remove one harness — `200 { deleted: true }`; `404` for an unknown name or a repeat delete. Any harness is removable, including a shipped built-in (its name is remembered in the database's `deleted` list so a restart does not re-ship it). Existing and saved sessions are untouched: each runs and restores from the definition it captured |
| `GET /api/harnesses/:name` | Read ONE harness definition — `200 { harness }`, the same projection the index lists, including `agentInstructions` when the card overrides any (the compiled `/views` document omits that map, so the configuration dialog reads the one card it is about to show). A legacy alias resolves to the card it redirects to; `404` for an unknown name |
| `GET /api/agents` | The trusted agent registry (`name`, `title`, `description`, `instruction`, `guidelines`) |
| `GET /api/tools` | The whole tool catalogue, session-bound core tools first (`toolRequest`, `toolCreate`, `tasks`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `delegate`, `actionRequest`, `threadFork`) then every direct-call tool (including the core file tools); `search` always appears with `availability` |
| `GET /api/tools/bootstrap` | Alias of `GET /api/tools` (the list the root bootstrap document carries) |
| `POST /api/tools/:name` | Call one tool on the server. A session-bound tool (`toolRequest`, `toolCreate`, `tasks`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `delegate`, `actionRequest`, `threadFork`) needs `sessionId`; every other tool - including the core file tools - keeps its session-less runner. `actionRequest`/`threadFork` are refused because they need the owning run. An unconfigured tool returns `ok: false`. See [the call body](#the-tool-call-body) |
| `POST /api/tools/:name/call` | Alias of the row above (verb-named spelling), same dispatcher |
| `POST /api/models` | Server-side `GET {baseURL}/models`; returns `{ models: string[] }` for the UI dropdown |
| `POST /api/sessions` | Create a session for a preset |
| `GET /api/sessions`, `GET /api/sessions/:id` | List or read sessions |
| `PATCH /api/sessions/:id` | Retarget models in a live session: body `{ agentModels: { agent: model } }` → `{ session }`. Merges into the live map, validates every key/value, applies all-or-nothing, and is allowed while the session is running (the next request uses the new model; the current one keeps its own). See [Server and UI](#server-and-ui) |
| `POST /api/sessions/:id/messages` | Legacy submit; response is `text/event-stream`. This response OWNS the run: a disconnect cancels it, and a busy session or a pending queue is a `409`. New clients should prefer `/tasks` + `/events` |
| `POST /api/sessions/:id/tasks` | Queue a task (`{ input, attachments?, references?, threadId? }`) → `202 { session, turn }`. The turn is `queued` with a stable id/index and no `startedAt`; each thread runs its own lane FIFO (cap 100 pending across all lanes, `429`) and continues after a task fails. Omitting `threadId` opens a new thread; a running `threadId` steers, or queues a continuation when attachments/an unfinished reference prevent it. In memory only |
| `GET /api/sessions/:id/events` | Watch the session: `text/event-stream` opening with one `snapshot`, then `turn` upserts (queued → running → terminal) and `event` frames, then one final `snapshot` when the queue drains. A disconnect only unsubscribes; server-owned tasks keep running |
| `POST /api/sessions/:id/reset` | Reset every agent and clear discovery, tasks, and the three record stores; `409` while a run or queued work is pending |
| `POST /api/sessions/:id/cancel` | Optional `{ all?: true }` → `{ cancelled }`. Default cancels the active run only; `all: true` (the UI Stop button) also cancels every queued turn, which stays in `turns` as a `cancelled` row |
| `POST /api/sessions/:id/actions/:requestId/answer` | `{ choice: { kind: 'option', optionId } \| { kind: 'custom', text } }` → `{ ok: true }`. Settles one pending `actionRequest`; allowed while the session is busy. `400` invalid/unknown option, `404` unknown session/request, `409` answered or expired |
| `DELETE /api/sessions/:id` | Forget a session: abort active work, drop queued work, and close its watchers |

#### The tool call body

`POST /api/tools/:name` always takes **one wrapper object with a `parameters`
property**; `{ "parameters": {} }` is a valid argument-less call, and a body without
`parameters` is a `400`. What `parameters` HOLDS depends on the tool's schema, and the
two forms are not interchangeable:

```jsonc
// files declares ONE property, so the value IS that property (the same unwrapping
// a model call gets and a direct call passes):
POST /api/tools/files   { "parameters": [{ "op": "list", "path": ["src", "task"] }] }

// its schema, as listed by GET /api/tools, is still an object:
{ "type": "object", "properties": { "ops": { "type": "array", … } }, "required": ["ops"], … }

// a multi-property tool takes the whole object, because there is nothing to unwrap:
POST /api/tools/glob       { "parameters": { "patterns": ["**/*.ts"], "paths": ["src"] } }
POST /api/tools/grep       { "parameters": { "pattern": "TODO", "patterns": ["*.ts"] } }
POST /api/tools/download   { "parameters": { "url": "https://example.com/a.pdf", "name": "a.pdf" } }
POST /api/tools/search     { "parameters": { "query": "harness docs", "provider": "linkup" } }
POST /api/tools/toolRequest { "parameters": { "tags": ["files"] }, "sessionId": "…" }
```

The single-property tools are `read`, `write`, `edit`, and `files`;
`glob`, `grep`, `syntax`, `shell`, `gitDiff`, `download`, `search`, and every core
tool carry several
properties. `search`'s optional `provider` only accepts a value whose key
resolved, and the catalogue schema shows that property only when a second provider
exists (`fetch` follows the same rule inside a session harness, where it is
registered rather than catalogued). `read`'s single `paths` property still accepts range objects as its
ITEMS (`{ "paths": [{ "path": "big.ts", "startLine": 400, "maxLines": 50 }] }`), so
per-file windows do not add a second top-level property and the unwrapping rule is
unchanged. `files` requires `ops`, so there is no "no preference" shape to normalize:
a `{ "ops": [...] }` wrapper and a bare `[...]` are the same request (the same
unwrapping rule), while an empty argument box and `{ "ops": [] }` are both refused -
only a `list` entry may omit `path`, and that one means the working directory.

**Harness creation and overrides.** `POST /api/harnesses` adds a live harness
built from trusted agents and the shared toolbox; `PATCH` changes any harness,
including the shipped templates (`instruct`, `research`, `workspace`, `reviewer`,
`planner`, `demo`, `flaky`). Every entry is an editable template copy;
`editable` remains on the wire for compatibility and is always `true`. A
metadata-only `PATCH` (`title`/`description`) preserves the template's captured
factory — the scripted `demo` keeps its offline script and `timeNow`-only registry,
and `flaky` keeps its `testFlaky` extra. An executable `PATCH`
(`primary`/`subagents`/`agentModels`/`agentInstructions`) rebuilds the harness: `demo`
becomes an
honest live profiled harness (shared toolbox, requires an endpoint), and `flaky`
rebuilds the live toolbox while retaining `testFlaky`.
`builtin: true` still marks provenance. There is no delete; with a database root
the registry is restored from `<root>/harness/state.json` (see Persistence), and
without one it is in memory only. Registry edits affect FUTURE sessions only,
because a session freezes its captured preset and descriptor at creation. Both
routes validate the request — exactly one primary, known agent ids only, no
duplicate ids, reserved aliases
(`writer`/`assistant`/`researcher`) and existing names rejected, bounded
title/description — and reject unknown fields, so a client cannot supply a bare
`instruction`, a provider, or a tool list.

**Saved registry rows and improved defaults.** A restart replays the registry rows
saved in `state.json`, but a shipped default may improve between builds (T3 widened
the real presets' teams and retitled `research`/`workspace`). The conservative rule:
a built-in row whose executable fields (primary, subagents, agents, tools,
environmentTools, template, and an empty `agentModels`/`agentInstructions`) still match the previously
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

`agentInstructions` is the one text-shaped field: a map of **selected agent id →
instruction OVERRIDE**, e.g. `{ "summarizer": "Condense to one line." }`. It is
validated like `agentModels` (keys must be final members; values trimmed, non-empty,
at most 8000 characters, and free of control characters other than tab/newline/CR, so
multi-line prose is legal) and REPLACED wholesale on `PATCH`, so `{}` clears every
override and an agent the map omits runs its trusted `GET /api/agents` instruction.
A stored value IS the member's **complete prompt**: `agentInstruction(profile, override)`
returns it verbatim, so the profile's `guidelines` are the default an un-overridden
member runs on and are never appended underneath an override, and the shipped profile in
`src/agents` is never rewritten. An instruction edit is EXECUTABLE, so it rebuilds the harness factory and
is persisted with the registry row; a saved session keeps the instructions its agents
were built with (its system messages are already in the transcript), which is why
`PATCH /api/sessions/:id` still accepts `agentModels` only. The browser's agent dialog
edits all of this as a local draft: nothing is written until its bottom-right action,
and dismissing the dialog sends nothing at all.

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

### Per-thread CPU isolation (`threadExecution: 'worker'`)

By default the server is single-threaded in the honest sense: every session's turns
interleave on one event loop, and the sentence in [The loop](#the-loop) still holds —
a CPU-bound tool body blocks that loop, so a sibling conversation, an SSE stream and
an HTTP read all wait for it.
`threadExecution: 'worker'` removes that limitation for **server-hosted** sessions:
each live conversation executes on its own OS worker thread.

```bash
HARNESS_THREAD_EXECUTION=worker yarn dev:server    # or: start-service / startHarnessServer()
```

What moves to the lane worker, and what does not:

| Runs on the lane worker | Stays on the coordinator |
|---|---|
| the agent loop, provider stream handling, and **every tool body** (sync, CPU-heavy, or created by `toolCreate`) | the **canonical** harness and session document |
| a queued thread turn **and** the legacy root `POST .../messages` run | persistence, the event journal, the display view, and every SSE response |
| a session-bound manual `POST .../tools/:name` call and a slash `/command` (both on the session's operator lane) | the single-flight gate, the queue pump, and cancellation classification |
| the guidance text of a focused submit, taken into the lane's own running conversation | the identity ledger, the writer leases, and the commit journal |
| a `nested` child conversation | **not in worker mode at all** — every door that can start one is refused (see the limitation below), because the child would exist only inside that lane |

Shared state is not merged. A lane sends **operations** carrying the facts they
depend on, and the coordinator's authority (`src/server/workers/lane-authority.ts`)
decides each one against the canonical harness:

- a transcript **appends at the length the authority reported**; a stale prefix is
  refused with the canonical length, so a committed run either lands whole or is
  re-read — never silently overwritten;
- `harness.memory` crosses as a **bounded declared window** and writes are
  **compare-and-set** against a digest, so a sibling's key is never deleted by the
  lane that never read it, and a function/symbol value is named instead of dropped;
- a terminal run **archives its invocation** with ids the authority **leased** at
  startup, and the authority reassigns the completion order, so two lanes can both
  claim to be "latest finished" without colliding;
- every session-shared operation a core tool performs (`tasks`, `profiles`,
  `chapters`, `locations`, `toolCreate`, `toolManage`, `toolRegistry`,
  `toolRequest`, `toolList`, `threadSend`, `threadList`, `agentManage`,
  `agentResult`) is **routed**, not executed locally: the lane replica's own
  `harness.runtime` object is replaced, so the canonical harness performs the work
  and the answer crosses back. Tool sources are unchanged.
- an `actionRequest` (an owner question) crosses as data, is registered in the
  session's normal pending map, and is answered by the usual HTTP route; a lane
  whose run ends leaves no orphaned question.

Those four writes need targeted core seams, because folding a lane commit with
`harness.restore()` per commit would rebuild every created tool and thread agent on
the coordinator (`src/harness.ts`, `src/types/index.ts`):

| Seam | Contract |
|---|---|
| `harness.appendThreadMessages(threadId, messages, fromLength)` | append at a prefix; refuses (mutating nothing) when the canonical length moved; notifies `agent_message` |
| `harness.setThreadStatus(threadId, status, invocationId?)` | mirror a lane conversation's roster state; refuses when a run is attached **in this** harness |
| `harness.archiveInvocation(input)` | store one terminal invocation; identity is the caller's, counters are only ever **raised** |
| `harness.reserveIdentity(input)` | raise this harness's minting counters so two replicas cannot mint the same id |

Worker mode is a **promise, not a hint**, so an unsupported shape is an error with a
name and a fix — never a quiet inline fallback:

- a harness that cannot be rebuilt from its durable record (a preset injected as a
  factory closure) is refused by `POST /sessions` with a 400, at creation;
- a tool body that reaches a canonical-document member of the live handle
  (`harness.snapshot/restore/reset/registerTool/createThread/sendThreadInput`, …) is
  refused at the lane handshake, naming the tool;
- a tool that walks `harness.memory` dynamically (`memory.data`, `memory.keys()`, a
  computed key) is refused for the same reason;
- **Nested runs are refused, not faked — at every door.** `delegate` and `threadFork` each
  start a CHILD conversation, and in a lane that child's thread record and transcript would
  exist only in that lane's replica: the archived result reaches the coordinator, but the
  canonical roster cannot list the child and its transcript disappears when the lane is
  reclaimed. Adopting a thread by an existing id needs a core seam this build does not have.
  A lane therefore closes four kinds of door:
  1. the two tool entries are removed from the replica at hello, so neither is declared to the
     model nor resolvable by a call (`context.callTool("delegate")` answers an honest
     "not registered");
  2. `harness.runtime.delegate` on the replica is replaced with the same named thrower;
  3. the replica **arms the core policy** (`writer.nestedRuns('refuse')`,
     `src/core/nested-runs.ts` + the doors in `src/harness.ts`). The arm is not a preset option:
     `refuseNestedRuns` runs for EVERY lane at hello, whatever preset that lane rebuilt, and a build
     with no nested-run seam faults the handshake instead of quietly running children on a private
     copy. It closes every door a tool BODY holds: `context.run(name, input)` in any spelling
     (`ctx.run`, a destructured `{ run }`, an alias), `context.harness(...)` used as a runner,
     `context.harness.sendThreadInput(...)`, and a sibling brain run straight from
     `context.agents`. Every one of them throws `nested-run-unsupported` **before** the child, its
     transcript or its provider request exists, and the lane handshake states the doors it armed;
  4. those refusals live at the **surfaces**, not at a stack depth. A refusing replica does not hand
     a body the raw live handle: `context.harness` is a guarded view of it (`src/harness.ts`
     `toolHandleView`, built once per instance) whose callable, `sendThreadInput` and sibling-brain
     members throw whenever they are reached — so a reference the body stores and fires from a
     callback or a timer AFTER its own call settled is refused exactly like a call made inside the
     body. Everything a lane toolbox needs passes through that view untouched (`runtime.*`,
     `memory`, `tools`, `commands`, `threads()` / `threadMessages()`, `executeTool`, `nestedRuns()`),
     and a write made through it lands on the live replica, so this is a set of closed doors rather
     than a crippled handle. An inline harness still receives the strict-identical live handle, and
     a reference it kept still works.
  A tool that has a real local path takes it instead of failing: the shipped `textSummarize`
  reads `context.nestedRuns` and condenses the notes on a lane, so worker mode does not lose
  the toolbox over one summarizer call. A revision whose captured source reaches one of these doors
  is refused before it runs, naming the tool — the source scan is TEXTUAL and says so on the surface
  itself; it is the lens, and the armed core is the guarantee, which is why a spelling the pattern
  misses (a computed member, a renamed context parameter) is still refused. Worker mode therefore
  does **not** promise nested conversation state — and cross-thread work (`threadRead`,
  `threadSend`, `threadList`) is unaffected, because it is routed to the canonical harness rather
  than answered from a private copy.
- no worker entry on disk is a `ServerRuntimeError` naming both candidate paths, and
  a handshake that times out fails the turn.

Guidance for a live run is honest in the same way. A focused submit into a running lane is
answered from the lane's own `steer.result` receipt, never from the frame the coordinator
posted: `steered: true` means the executing conversation took the text (and it lands in that
conversation's canonical transcript), while a refusal — a run that is not at a steerable point,
or a lane that stopped — becomes an ordinary queued continuation. The declared memory window is
recomputed the same way it is trusted: from the tool revision that is installed NOW, so a tool
created or replaced after the session started widens the window instead of being scanned against
a snapshot from session creation.

Compatibility is unchanged: the default stays `inline`, no existing host changes
shape on upgrade, and a worker session answers exactly the same HTTP surface.

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS_THREAD_EXECUTION` | `inline` | `inline` or `worker`; any other value aborts startup |
| `HARNESS_WORKER_IDLE_MS` | `120000` | reclaim a lane worker after this much idle time (`0` = keep it until the session goes). 0–3600000 |
| `HARNESS_MAX_LANE_WORKERS` | `16` | upper bound on concurrently live lane workers — each owns a full harness replica, so this is the memory guard. 1–64 |
| `HARNESS_WORKER_HANDSHAKE_MS` | `60000` | bound on worker import + build + capability report. 1000–600000 |
| `HARNESS_WORKER_ENTRY` | unset | explicit worker entry file; otherwise `dist/underload-harness.worker.mjs`, else the source entry (dev/test) |

Values are **validated, not coerced**: `HARNESS_WORKER_IDLE_MS=12s` aborts startup
naming the variable and the accepted range, because an approximated runtime is the
one thing this mode may not do.

The lane worker is a published entry point — `@underload/harness/worker`, built as
`dist/underload-harness.worker.mjs` by `yarn build` (`vite.config.ts`, `package.json`
`exports`). Resolve order is: the configured `workerEntry`, the built bundle, the
source module. A cold lane measures ~1.6–2.4 s in source mode (it rebuilds the
harness, recompiles created-tool sources and restores the snapshot) and less against
`dist/`; reclaim is always safe because the next turn rebuilds from committed state.

Branch state is deliberately absent from snapshot v1 (a `harness.branch` listing belongs
to the run that created it), which is exactly why worker mode refuses `threadFork` rather
than keeping a private branch the coordinator cannot list: a fork that ran on a lane would
commit only its returned summary, and the branch detail would vanish with the lane. In
`inline` sessions — the default — both nested tools behave exactly as documented above.

Cross-references: `src/server/config.ts` (the validated runtime),
`src/server/workers/` (protocol, lane host, worker entry + loop, authority,
capability, identity/commit/memory primitives), `src/server/sessions.ts` (the
worker branches — search for `workerExecution`), and
`src/server/workers/lane-worker.test.ts` (the behavioral proofs: a CPU burn on one
lane while a sibling and the event loop keep moving, a task written on one lane read
back by a rebuilt lane, and cancel/crash leaving no late effects).

### Off-loop durability (`ioExecution: 'worker'`)

A durable server writes two things: the whole `harness/state.json` document (a
two-space `JSON.stringify` of every session's every event) and one JSON line per
harness event under `harness/sessions/<id>/events.jsonl`. Inline, both happen on the
request loop, so a big checkpoint is a synchronous block that every other session and
every open SSE stream pays for. `ioExecution: 'worker'` moves **the write side of
durability** onto one IO worker thread per database root:

    HARNESS_IO_EXECUTION=worker yarn dev:server    # or runtime: { ioExecution: 'worker' }

What does NOT move is the authority. The coordinator still decides what the next
document and the next journal line are, and in what order: it builds the record
exactly as before (`databaseRecord`), then hands it to
`src/server/workers/io-client.ts` instead of calling `persistence.save()`. The thread
serializes and performs the syscalls (`fs.*Sync`, one operation at a time, so the
atomic rename stays one-writer) and answers with a receipt. Three consequences,
stated rather than smoothed over:

- **Strict saves become awaited.** `persistOrThrow`, and the store methods that
  contain it (`create`, `enqueue`, `reset`, `remove`, `cancel`, `cancelThread`,
  `deleteThread`, `updateThreadTranscript`, `setAgentModels`, `persistRegistry`,
  `mutateRegistry`), resolve only after the worker's rename receipt — so a 201/200
  still means "durable before the response". A failed commit rejects with the exact
  message the inline writer throws, and the caller's rollback still runs.
- **Best-effort saves claim order, not durability.** The core state-change observer,
  the interval `checkpoint()`, and every journal event append stay SYNCHRONOUS and
  enqueue the work (a burst of observer fires coalesces into ONE commit of the newest
  document). They are never presented as durable; a crash in that window can lose what
  was queued, never what the strict path already acknowledged.
- **Terminal commits are fenced, which inline never was.** A transition whose document
  lists journaled events (`cancel`, `cancelThread`, the turn-start write, a command
  turn's terminal write) commits through `io.commitCheckpoint({ document,
  fenceSessions: [session.id] })`: that session's journal tail is fsynced and
  acknowledged BEFORE the document referencing those events is renamed. Strictly
  stronger than inline, which never fsynced there.

Reads stay on the coordinator (`persistence.load()`, `journal.read()`): a restore runs
before the server answers anything, and queueing it would serialize a cold start behind
a pending compaction for no gain. In worker mode the coordinator keeps a journal
instance ONLY as a reader, so there is still exactly one writer per file.

Ordering is load-bearing and comes from the queue: frames are posted in call order and
answered one at a time, so a journal append is on disk before the checkpoint that lists
it, and a reset's truncate precedes the document that forgets those turns. There is no
inline fallback anywhere — a missing entry, a host without `node:worker_threads`, a
thread that dies, or a protocol-version mismatch throws a named `HarnessIoError`, fails
every outstanding operation, and aborts startup: a listener never binds its port until
`store.ioReady()` settles. Shutdown is awaited too: `startHarnessServer().close()`
awaits `store.drainIo()`, which flushes the coalesced slot, fences the held journal
handles, and reports every operation that never received a durability receipt.

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS_IO_EXECUTION` | `inline` | `inline` or `worker`; any other value aborts startup |
| `HARNESS_IO_WORKER_ENTRY` | unset | explicit IO worker entry file; otherwise the built `dist/underload-harness.io-worker.mjs`, else the source entry (dev/test) |

The cost that stays on the main thread, honestly: building the record (the authority
owns the state) and the structured clone `postMessage` performs on each frame — one
document per checkpoint. A checkpoint frame is therefore bounded by `maxFrameBytes`
(64 MiB): the worker measures the serialized length before touching the disk and feeds
that number back, so a permanently oversized database fails loudly and stops paying the
clone. Off-loading is a bounded cost moved off the loop, not a zero-cost win.

The IO worker is a published entry point — `@underload/harness/io-worker`, built as
`dist/underload-harness.io-worker.mjs` (`vite.config.ts`, `package.json` `exports`).
Because the manifest says `"sideEffects": false`, the entry calls `startIoWorker()`
explicitly: an entry that merely imported its loop compiled to a bundle that answered
no frames at all.

Cross-references: `src/server/workers/io-protocol.ts` (the frames and the three
outcomes `durable` / `written` / `superseded`), `src/server/workers/io-client.ts` (the
FIFO queue, the handshake gate, and the numbered integration contract at the bottom of
the file), `src/server/workers/io-worker.ts` and `io-worker-loop.ts` (the thread),
`src/server/sessions.ts` (the worker branches — search for `this.io`),
`src/server/io-worker-bridge.test.ts` (store + standalone-server proofs, including the
built bundle), and `src/server/workers/io-client.test.ts` (ordering, barriers, error
close, and byte identity with the inline writer).

### Threads in the browser UI (R5/R6/R7)

The UI exposes the runtime's persistent conversations as **threads**, and the
composer decides which one a message belongs to. Focus is explicit state: it is
shown by the single expanded conversation and named in the routing label on the
composer's frame, and a background snapshot, another tab's turn or a late record
never moves it. (The old compact thread strip above the transcript was removed: it
duplicated the tile's own thread badge and cost a permanent row of height.)

- **Only one conversation is open, and it is the focused one.** Opening any turn of
  a conversation (its compact header) focuses that thread; closing it unfocuses. A
  CHILD conversation (a delegated thread with no turn of its own) is focused by
  clicking its nested invocation row: the parent tile collapses, the child's
  recorded transcript is shown, and the composer targets the child's own id.
  Repeated turns of one persistent thread share the same canonical label (the
  server's label, else `T3`) in their headers and in one badge, so they never read
  as independent conversations.
- **Routing.** With a thread focused: idle/stopped → the message CONTINUES that
  conversation (a new turn in the same thread); running → the message STEERS it
  (queued as a user message at the thread's next model boundary, possibly answered
  by the owning turn) — UNLESS the draft carries attachments or a `#` reference to a
  block that has not finished, because steering is text-only and needs terminal
  reference content: that submit is accepted as a QUEUED CONTINUATION turn in the
  same thread that keeps its bytes and runs when the active turn ends. The routing
  line above the field names the real outcome (`Steering …`, `Queued in …`,
  `Continuing …`) before you send.
  With nothing focused, a message opens a NEW thread — and if the draft carries `#`
  block references, it opens a **connected** new thread: the relation is persisted
  as the turn's `references` and the roster reports it as `connectedThreadIds`, its
  run receives those results as context, and the new thread is never OWNED by the
  referenced one (`ownerThreadId` stays delegation-only), so stopping or deleting
  the source leaves it intact. Unfocused submits each get their own execution lane
  and run CONCURRENTLY; only a legacy, pre-thread harness handle keeps the old
  serialized backlog.
- **Unfocus** is collapsing the expanded conversation (click its header again): the
  routing label then reads `New thread` and the next message opens a new standalone
  thread instead of steering the focused one.
- **Per-thread stop/delete** are API-only now (`POST /sessions/:id/threads/:id/cancel`,
  `DELETE /sessions/:id/threads/:id`); the browser shell no longer offers a control
  per thread — the composer's stop-all covers cancellation.
- **Stop everything** stays available while a draft exists: with text in the field
  the composer paints submit + a separate `×` (`Stop all tasks`), which sends
  `POST /sessions/:id/cancel { all: true }`. With an empty field the inline action
  is already that stop, so only one control is shown.
- **Deletion is authoritative at once.** `DELETE /sessions/:id/threads/:threadId`
  returns the whole snapshot, and the client treats any authoritative snapshot that
  no longer lists a thread the same way (so an API/other-tab deletion is learned
  identically): the thread's turns disappear, its focus is dropped — even while a
  pending optimistic row still names it — and any `#` reference chip that pointed at
  one of those turns is removed from the draft (the reader is told) instead of
  failing the next submit (a failed submit restores its draft without any dead
  reference). The deletion is also remembered locally — scoped to its session — so a
  late snapshot, SSE turn or in-flight answer cannot bring the thread back,
  re-focus it or delete a newer row. Labels of surviving blocks never change.

Wire additions are optional and additive, so an older server keeps working: a
snapshot without `threads` leaves the routing decision to focus alone, a turn
without `threadId` renders no badge, and a submit with no target omits `threadId`
(the pre-thread body).

```
POST   /sessions/:id/tasks                    { input, attachments?, references?, threadId? }
GET    /sessions/:id/threads/:threadId/transcript                           -> { transcript }
PUT    /sessions/:id/threads/:threadId/transcript { messages }              -> { session, transcript }
POST   /sessions/:id/threads/:threadId/cancel { }                        -> { cancelled, session? }
DELETE /sessions/:id/threads/:threadId                                  -> { deleted: true, session }
POST   /sessions/:id/cancel                   { all: true }              -> { cancelled }
```

A `/tasks` submit whose `input` starts with `/` is a **slash command**, not a prompt:
the `202` envelope is identical, but its `turn` is already terminal because the server
executed it in this process — see [Slash commands](#slash-commands).

### Editable thread transcripts

A conversation's transcript is the user's own JSON, and the transcript dialog in the
browser UI edits it. Only `messages` are editable: turns, events, statuses, timestamps
and `usage` stay server-owned history, because they are the record of what actually
ran, not an input to it.

`GET /sessions/:id/threads/:threadId/transcript` answers the editor's document
(`ThreadTranscriptResponse`, `src/server/protocol.ts`):

```json
{
  "transcript": {
    "threadId": "0f0d…",
    "agent": "instruct",
    "messages": [{ "role": "user", "content": "draft a plan" }],
    "raw": "[\n  {\n    \"role\": \"user\",\n    \"content\": \"draft a plan\"\n  }\n]"
  }
}
```

- `messages` is the LIVE transcript the model will be sent next;
- `raw` is the pretty-printed (2-space) JSON the editor holds and edits;
- `invalid: { error, messages }` is present **only** when the stored value cannot be
  read — then `messages` is the placeholder and `raw` is the broken value verbatim.

`PUT /sessions/:id/threads/:threadId/transcript` with body `{ messages }` replaces the
whole transcript and answers `{ session, transcript }` — the post-write snapshot plus
the same document — so a client repaints everything from one response.

**A broken value is a successful write.** `messages` is deliberately `unknown`
(`UpdateThreadTranscriptRequest`): any JSON value round-trips. A structurally invalid
value is persisted as submitted, the thread's live transcript becomes a valid one-entry
`system` placeholder whose text is `[transcript unreadable: <reason>]`, and the answer
carries `transcript.invalid` with the reason and the raw text
(`updateThreadTranscript`, `src/server/sessions.ts`). The session therefore stays
runnable, snapshot-able and restorable while the operator keeps fixing the JSON, and
the dialog opens an unreadable thread **directly in the editor** with that banner and
the raw value, because the only useful thing that surface can do then is help them
repair it. Only an absent `messages` property is a `400` — the server answers
``A transcript update requires a `messages` value.`` because the service adapter hands
a body that failed to parse as `{}`, so refusing it is what keeps a malformed request
from silently emptying a transcript.

| Status | When |
|---|---|
| `200` | a valid replacement, **or** a value that is not a readable transcript (it is stored and reported as unreadable) |
| `400` | absent `messages`, or a body that is not an object |
| `404` | unknown session or unknown thread. On `GET`, a thread that survives only in the unreadable map is still served — its raw value is the useful part |
| `405` | any method other than `GET` / `PUT` |
| `409` | the thread is running (stop it first), or the session's harness handle predates `setThreadMessages` |

Live work is refused twice, on purpose: the store checks the thread record and its
execution lane before touching anything, and `harness.setThreadMessages(threadId,
messages)` re-checks the run state before it mutates, so a run that starts in between
still answers `409` rather than losing the edit. That primitive validates with the
SAME reader `snapshot()`/`restore()` enforce (`readHarnessMessages`,
`src/core/snapshot.ts`), so a harness can never be left holding a transcript its own
snapshot would refuse; a rejected write mutates nothing, and an accepted one is
installed **in place** because `agent.messages` is exposed by reference. An empty array
is a legal transcript, and a **stopped** thread is writable — repairing a broken
conversation is the whole point. The write notifies `agent_message`, the existing
persistence reason, and emits no progress event: a host edit is not model output.

**Two keys the reader owns on the way in.** Every transcript read and write speaks
`HarnessMessage` entries, and two of their keys are the harness's to normalize:

- `included` — the context-inclusion flag a `turn.before` policy writes
  (`context.setIncluded`). **Only the literal `false` is storage**: absent means
  included, and re-enabling DELETES the key. A submitted `included: true` is therefore
  accepted and silently normalized to the absent form — at the agent seed, at this
  transcript write, at the lane append, at `restore()`, and at a fork — rather than
  rejected, because rejecting would break a host that round-trips its own JSON. The rule
  for a host that persists its OWN copy of a transcript follows from that storage form:
  **omit the key, do not write `true`**. The one place nothing can normalize is a direct
  edit of the public mutable `agent.messages` array (the state-change observer cannot see
  it, `HarnessStateChangeEvent`), where a hand-written `true` stays visible to every read
  surface until the next copy. No `included` key ever reaches a provider request.
- `messageId` — the stable transcript address (`msg-<n>` within one conversation). The
  runtime mints one when it creates a canonical entry, COPIES it across a fork, a branch
  and a snapshot (never re-mints), and BACKFILLS one when a document predates ids, so a
  restored conversation is addressable from its first round and `restore → snapshot`
  returns the same document. It is what `context.setIncluded(id, …)` accepts, so a policy
  can disable the same turn in a later round, after a restart, or after a
  `replaceHistory()` that kept the entry — the things an index or a message identity
  cannot survive. Like `included`, it never reaches a provider request, and a host may
  carry its own non-empty string in the key if it wants one.

**Reload is tolerant per thread and fatal per document.** A transcript broken by hand
in `state.json` cannot cost the whole session: the store validates every host thread's
`messages` before `harness.restore()` and neutralises the unreadable ones with the same
placeholder, keeping each thread's id, agent, label and turn links so the roster can
still address it
(`tolerateThreadTranscripts` / `mergeInvalidTranscripts`, `src/server/sessions.ts`).
The tolerance is deliberately scoped to host threads: an invalid **default**
(`agent:<name>`) conversation still fails the restore and drops the session, because
that transcript is what the entry point runs and a placeholder there would silently
rewrite the session's primary conversation. Retention also covers a default conversation
whose placeholder came from a live `PUT`; only a hand-broken `core.agents[name].messages`
in the stored file stays fatal. The raw value of an unreadable host thread
is retained beside it as `SessionSnapshot.invalidThreads` — additive
(present only when at least one thread is unreadable), sorted by thread id, and
persisted as the optional `invalidThreads` map on the session record — so a restart
still shows the operator exactly what they typed:

```json
{
  "id": "0f0d…",
  "agent": "instruct",
  "label": "IT1",
  "error": "thread \"0f0d…\" messages[0].role must be one of: system, user, assistant, tool.",
  "messages": [{ "role": "sysytem", "content": "a typo a human made" }]
}
```

An entry is dropped as soon as it stops being useful: the thread was deleted, or its
live transcript is no longer a placeholder (the operator repaired the JSON by hand, or
a `PUT` installed a valid value). Document-level corruption stays **fatal** — an
unreadable file, malformed JSON, an unknown database version, an invalid record shape,
or a malformed `invalidThreads` map still aborts startup — and a failed load never
rewrites the operator's file.

The browser client surface is `getThreadTranscript(sessionId, threadId)` and
`updateThreadTranscript(sessionId, threadId, messages)` (`src/frontend/api.ts`); the
dialog is `src/frontend/ui/thread-transcript.ts`. A Save parses locally first (invalid
JSON keeps the text in the editor and never sends it), and a refresh never overwrites
the textarea — only an explicit Save, Cancel, or opening a different thread does — so
an unrelated stream frame cannot destroy an in-progress repair.

### Task queue, timeline, and message rendering (R4/R5)

- **The queue is server-owned and FIFO per conversation.** `POST /tasks` returns
  `202` immediately; each thread executes its own lane's tasks one at a time, in
  order, and continues after a per-task error. Lanes are independent, so two
  different threads run CONCURRENTLY (only a legacy, pre-thread harness handle
  keeps one serialized backlog).
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
session registers, including `shell`, the file tools, and a configured
`search` (they may be `visibility: 'core'` but are not session-bound). The
**Core tools** group is different by design: those entries are `sessionBound`, their
call must carry the selected `sessionId`, and they execute inside that session's
harness, so a manual `toolRequest`, `toolCreate`, `tasks`, `profiles`,
`chapters`, `locations`, `agentManage`, `agentResult`, or `delegate`
call changes the conversation the user is looking at (and is refused with `409` while any session
operation is in flight: a chat turn, queued work, a reset, or another manual call). A manual
call is not a turn - it never changes `status` or appends a turn, only a private
single-flight flag while it runs. A session model PATCH is the exception: it is a
model choice, not a harness mutation, so it is accepted while a run streams and
aborts nothing.
`delegate` is listed for every host but only exists in a session whose harness
allows subagents; otherwise the call answers a clear `404`. `actionRequest` and
`threadFork` are likewise listed (conditional in a session), but a manual call is
refused because both need the run that owns the conversation. The **Web search** group
shows whether this server has `EXA_API_KEY`/`TAVILY_API_KEY`/`LINKUP_API_KEY`; an
unconfigured entry
keeps its schema and example arguments visible but disables **Call tool** and prints
the server's hint, so it never looks like a working tool. `download` is listed under
**Package presets** and is callable here like the file tools; its answer is the
summary plus `media` **descriptors** (id, kind, name, mime, size), never the
base64 bytes, which stay on the transcript. `fetch` is listed under **Web fetch**
and is directly callable whenever the host enabled `webfetch` (its `native` provider
needs no key); a host that did not enable it still sees the row, listed as
`availability: unconfigured` with its hint. Inside a run both web tools are declared
core, so the model needs no `toolRequest` round to research a page.

**Cancellation is cooperative and signal-based.** Aborting a run
(`POST /sessions/:id/cancel`, `DELETE /sessions/:id`, or a closed legacy stream)
signals every call that is running, and `toolCancel({ callId })` targets one call.
`toolCancel` logically settles/aborts that call's own task; its late result is
ignored, and cancelling an already settled (or already cancelled) call succeeds
without an error — cancellation is a state, not a one-shot transition.
`shell` honours the abort signal and kills its process tree, and
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
the server's permissions: `workspace`, `shell`, `write`, and direct tool
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
    "presets": [{ "name": "demo", "title": "…", "requiresEndpoint": false, "primary": "demo", "subagents": [], "agents": ["demo"], "tools": ["timeNow"], "coreTools": ["toolRequest", "toolCreate", "task", "profiles", "chapters", "locations", "agentManage", "agentResult", "threadFork"], "builtin": true, "editable": true }],
    "agents": [{ "name": "instruct", "title": "Instruct", "description": "…", "instruction": "…", "guidelines": ["…"] }],
    "tools": [{ "name": "toolRequest", "group": "Core tools", "tags": ["discovery"], "visibility": "core", "sessionBound": true, "parameters": {}, "availability": { "state": "available", "hint": "Runs inside a session harness: send a sessionId with the call." } }, { "name": "read", "group": "Package presets", "tags": ["files"], "visibility": "core", "parameters": {} }],
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
  sources — recompiled, never executed, todo/profile/chapter/location stores, and
  the terminal agent-result archive);
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
- one conversation whose stored transcript cannot be read does **not** cost the
  session: the thread keeps its id, agent, label and turn links, its live transcript
  becomes the `[transcript unreadable: …]` placeholder, and the raw value is retained
  in the additive `invalidThreads` roster so the operator can still repair it (see
  [Editable thread transcripts](#editable-thread-transcripts));
- a session this build **cannot rebuild** (a snapshot naming a tool that has since
  been renamed, a model map naming a retired agent, an internally inconsistent
  record) is **dropped on load instead of failing startup**: every other session,
  the registry, the API and new-session creation keep working, and the dropped id
  answers `404 Unknown session` rather than presenting a half-restored row. Each
  drop is reported through `onRestoreError` (stderr by default) and kept in
  `SessionStore.restoreErrors`, so the reason stays readable after the session is
  gone; the next whole-document commit therefore no longer carries that record.
  Document-level problems stay **fatal** — an unreadable file, malformed JSON, an
  unknown database version and an invalid record SHAPE still abort startup, because
  an unparseable document says nothing trustworthy about the sessions inside it —
  and a failed load never rewrites the operator's file.

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
GET    /v1/harness/harnesses/:name        read one harness -> { harness }
PATCH  /v1/harness/harnesses/:name        change any harness
DELETE /v1/harness/harnesses/:name        remove any harness → 200 { deleted: true }
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
POST   /v1/harness/sessions/:id/tasks     queue a task, or run a `/command` → 202 { session, turn }
GET    /v1/harness/sessions/:id/events    watch the queue → text/event-stream
POST   /v1/harness/sessions/:id/reset     reset agents, discovery, tasks, records
POST   /v1/harness/sessions/:id/cancel    cancel active work ({ all } also drops the queue)
POST   /v1/harness/sessions/:id/actions/:requestId/answer   answer one pending actionRequest
GET    /v1/harness/sessions/:id/threads/:threadId/transcript       one transcript (editable JSON)
PUT    /v1/harness/sessions/:id/threads/:threadId/transcript       replace it → { session, transcript }
```

A `POST …/tasks` whose `input` starts with `/` is executed as a slash command in the
server process and answers `202` with an already-terminal turn; the legacy `/messages`
route keeps sending such a line to the model
(see [Slash commands](#slash-commands)).

**Standalone `/api` compatibility is unchanged.** The `/api` root stays a 404 (it
has no bootstrap document), every `/api` request still needs
`X-Harness-Client: ui`, and `/api/presets` exists as an alias of `/api/harnesses`.
The canonical mount does not use that header: the service loader installs
permissive CORS, so a custom header is not an access boundary there.

**Access control is an Origin gate, not authentication.** The service app is built
with `cors({ origin: '*', allowHeaders: '*' })`, and it listens on `0.0.0.0` by
default. The harness endpoint therefore rejects a browser request whose `Origin`
is none of: the request's own host, a loopback hostname (`localhost`,
`127.0.0.1`, `[::1]`), or an **https `*.github.io`** origin (this package's
deployed UI — see “GitHub Pages” below). Requests with no `Origin` (curl,
server-to-server) are allowed. That stops an arbitrary public web page from
reading transcripts or driving tools **through a browser**, but it does not
authenticate anyone who can reach the port directly. Combined with unsandboxed
tools (`shell`, `write`, `toolCreate`), that means: bind the service to a
trusted network only, and prefer loopback (`host: '127.0.0.1'`) when the port is
reachable from elsewhere. No global service host/CORS settings are changed by this
package.

**Connecting the UI to the service.** The UI is server-agnostic: nothing about the
built bundle names a host, and the browser picks its API root at runtime. The ladder,
in order (`src/frontend/api.ts` `resolveRoot`):

1. `?apiRoot=` on the page URL — this load only;
2. the **“Harness server URL”** this browser saved in the Endpoint & model dialog
   (`localStorage` key `underload-harness-app:api-root`);
3. server-injected config (`window.__HARNESS_CONFIG__.apiRoot`, or the
   `<meta name="harness-api-root">` tag);
4. build-time `VITE_HARNESS_API`;
5. on a GitHub Pages host, the local/LAN gateway chain compiled into
   `src/frontend/deployment.ts` (see “GitHub Pages” below);
6. `/v1/harness` — the contract's one root (`HARNESS_API_ROOT`,
   `src/shared/harness-api.ts`), resolved against the page's own origin.

Step 6 is the default the dialog shows and needs no configuration: a UI served at
`http://localhost:8180` dials `http://localhost:8180/v1/harness`.

**Pointing the UI at another harness, from the UI.** Press the status pill at the top
right to open **Endpoint & model**; the field at the top of that dialog is this
browser's harness server URL, and the line at the bottom of the dialog prints the root
actually in use. `Apply & reconnect` validates the value — a rooted path, or an
absolute `http(s)` URL with no query, fragment, credentials or backslashes — stores it
in normalized form (so a trailing slash cannot drift between loads), removes the
`apiRoot` parameter from the address bar (that parameter outranks the saved value, so
leaving it in place would undo the save; every other parameter and the hash survive),
and reloads, which re-resolves the root and reconnects the `harness.v1` WebSocket. A
value the validator refuses is reported inline and nothing is written. `Reset`, or
applying a blank field, deletes the key and reloads — that restores automatic
resolution, which on a Pages host means the compiled chain again.

The setting has its own storage key and is never serialized into a request body: the
dialog's Base URL / API key / model triple describes the **provider**, and where the UI
sends its requests is a separate decision. A saved root also silences the Pages probe
chain — a deliberate choice is never replaced by a guess.

A one-load override looks like this:

```text
http://localhost:5180/?apiRoot=http://localhost:5000/v1/harness
```

`yarn dev:frontend` (Vite) and `yarn preview:frontend` (built UI) serve on `:5180`
and proxy `/v1/harness` (REST and the WebSocket upgrade alike) to the service gateway
on `:5000`, so the explicit `?apiRoot=` above is only needed when bypassing that
proxy. A loopback Vite origin is allowed by the Origin gate directly; a LAN browser's
non-loopback origin is not, so the dev proxy stamps the target's origin on its
server-to-server request (the gate still rejects a foreign origin that reaches the
service without that proxy). For a LAN browser keep the default relative
`/v1/harness` root; an absolute `?apiRoot=http://<LAN-IP>:5000/...` is a different page
origin and the runtime gate ignores it — the exceptions are a root that names an entry
of the compiled Pages chain exactly (see “GitHub Pages” below) and the **saved** server
URL, which the runtime gate does not apply to (see the trust rule below). The UI never
sees the API key — it posts only the base URL and model, and `defaults.hasApiKey` is a
boolean.

A **runtime** absolute root (`?apiRoot=` or injected `__HARNESS_CONFIG__`/meta)
must be the page's own origin, a loopback hostname (`localhost`, `127.0.0.1`,
`[::1]`), or one of those compiled chain entries; anything else is silently
ignored and the next source is used. This is
deliberate: the UI posts the provider key saved in this browser to that root, so a
crafted `?apiRoot=https://evil.example/v1/harness` link must not receive it. A rooted path
such as `/v1/harness` is same-origin by construction. Build-time
`VITE_HARNESS_API` is operator-controlled and may name another origin; it cannot
be changed by a URL a user is tricked into opening. The **saved** server URL is
trusted for the same reason — it can only have been typed by someone using this app —
so it may name any host the browser can reach, and it outranks `VITE_HARNESS_API` so
an operator-built bundle stays re-pointable without a rebuild. What decides whether
that host answers is the service, not the client: an absolute root must be an origin
the service's Origin gate accepts and that answers CORS, and an **https** page cannot
dial a plain-`http` harness at all (the browser blocks the mixed content), so an https
deployment needs an https (or loopback) server URL. The loopback list is shared
with the service Origin gate (`src/server/origin.ts`), so "local" has one definition.

**GitHub Pages (`https://underloadjs.github.io/harness/`).** `.github/workflows/ci.yml`
publishes `src/frontend/dist` to Pages, a host that serves the bundle and **no API**.
A relative root cannot work there: `/v1/harness` resolves to
`https://underloadjs.github.io/v1/harness/…` and returns GitHub's 404 HTML page, so the UI
boots and then reports “The harness server returned a non-JSON response”. When the
page is served from a `*.github.io` host and nothing is pinned by `?apiRoot=`, the saved
“Harness server URL”, injected config, or `VITE_HARNESS_API`, the client therefore dials
the absolute chain compiled into `src/frontend/deployment.ts`, in order, and keeps the
first gateway that answers `GET <root>/health`:

```text
http://localhost:5000/v1/harness        # the service gateway on this machine
http://127.0.0.1:5000/v1/harness        # the same gateway, IPv4 spelling
http://192.168.50.109:5000/v1/harness   # the standard LAN host
```

Both loopback spellings are probed because the gateway binds `0.0.0.0` (IPv4) while a
Windows browser resolves `localhost` to `::1` first — a `localhost`-only candidate
refused connections on a machine whose gateway was up. The LAN host is last so a
machine with its own server never reads a stale shared transcript, and it keeps the
provider key saved in this browser on the viewer's own host whenever possible.

What the client cannot do alone:

- **Origin gate** — the service accepts an https `*.github.io` origin
  (`isPagesOrigin` in `src/shared/origin.ts`); every other public origin is still 403.
- **CORS / Private Network Access** — already satisfied by the service loader
  (`cors({ origin: '*', allowHeaders: '*' })` plus
  `Access-Control-Allow-Private-Network: true`), which is why the Pages UI must dial
  the **service** mount, not the standalone `:5181` server (that one has no CORS
  answer for its `X-Harness-Client` header, so a cross-origin preflight fails).
- **Mixed content** — Pages serves HTTPS while the harness serves plain HTTP.
  Browsers exempt `localhost`/`127.0.0.1`, but Chrome blocks an HTTPS page fetching a
  plain-HTTP LAN address, so the third entry needs relaxed mixed-content blocking or an
  HTTPS-terminating proxy in front of `:5000`. A blocked candidate just fails its
  probe and the next one is tried.

If nothing answers, the offline pane lists every host that was tried; `Retry` is a
full reload, which re-probes. Pin one host with
`https://underloadjs.github.io/harness/?apiRoot=http://192.168.50.109:5000/v1/harness`
(a root that names a compiled chain entry exactly is trusted; any other foreign
absolute root is still ignored), save one in this browser with the dialog's
“Harness server URL” field (a saved root is trusted across origins, and it silences the
chain until `Reset` clears it), or bake one in with `VITE_HARNESS_API` at build time.
The host/port constants mirror the monorepo's `config/environment` (`src/host.ts`,
`src/port.ts`); that package is not published, so they are restated here — update both
when the LAN address changes.

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
tools, discovery, tasks, and the queued backlog are durable under
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
  `src/tools/catalogue.ts` → `src/tools/descriptors.ts`, which owns both loaders), so
  the build emits one chunk per tool next to the
  entry (`read-*.js`, `gitDiff-*.js`, …). The entry keeps no `node:` import
  and no static link to those chunks. `build.lib` must stay ESM-only and must not
  set `inlineDynamicImports`, which would fold every implementation back into the
  entry. A `.tool.ts` that is newer than the generated manifest has no chunk yet; the
  catalogue compiles it from its editable source instead (`prepareToolCandidate`), so
  the Node surface stays honest while `yarn tools:manifest` is only needed for the
  browser build.
- `package.json` `files` ships all of `dist/` (entry, `.d.ts` tree, and the chunks),
  so a consumer's `import { read }` still resolves its body after publishing.
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

# @underload/harness

> The reusable browser client and its app build moved to
> [`@loadscript/harness`](../loadscript/harness): the UI sources that used to live
> under `src/frontend` are no longer part of this package. The library and the
> server API stay here.

A plugin-first CLI agent harness. One call builds a callable writer that runs the
tool loop for you.

## Install

```bash
yarn add @underload/harness
```

The harness core has no runtime dependencies of its own, and Node 18+ is enough
(`fetch` is the default transport). What the package DOES declare in `dependencies` is
exactly what its published sources import: `dotenv` (the Node entries' `.env` loader)
and `typescript` (the tool-source compiler, `src/core/tool-source.ts`). The browser
markdown renderer (`dompurify`, `marked`, `highlight.js`) moved with the client to
`@loadscript/harness`. `vite` is a `peerDependency` (`^8`) for the module runner the
worker entries load through. Nothing is inlined — every dependency stays the
dependency's own published artifact (see [npm Publishing](#npm-publishing)).

## Usage

```ts
import { harness, agent, tool } from '@underload/harness';

const writer = harness({
    agents: {
        writer: agent({
            model: 'merge/ds4-flash',
            instruction: 'You are a writer.',
            provider: {
                baseURL: 'http://localhost:8800/providers/private/v1',
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
`toolRequest` and `tasks` (plus `delegate` while the rank map lets some agent
delegate) are also declared up front and are the only session-bound core
tools. Every other harness-owned row — `toolRegistry`, `toolList`, `toolManage`,
`toolCreate`, `records`, `profiles`, `chapters`, `locations`, `agentManage`, and
`agentResult` — stays registered so `toolRequest` can enable it, but is searchable,
not declared (R9-R11). That is the DEFAULT posture, not what the server's conversations
start with: a session the server creates seeds the enabled set with every
switchable name this deployment has not denied and the cap admits, so those
names are declared from its first request (`enableAllTools`, see [Tool
discovery](#tool-discovery)).
Two conditional harness-owned
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
  archive, and `snapshot()`/`restore()`. It also owns its OWN plugin configuration —
  a copy of the server's template taken when the session was created, durable on the
  session's own record — so editing one conversation's plugin settings changes no other
  conversation.
- **Thread** — one persistent, agent-owned conversation. It has a stable id and
  its OWN transcript, and shares the session's tools, stores, discovery state,
  and creation budget.

Every configured agent owns a **default conversation** with id `agent:<name>`.
Its transcript is the registry `Agent.messages`, so delegation keeps its
historical behaviour (a delegated agent accumulates its conversation across calls) and
`sendThreadInput('agent:<name>', …)` resumes exactly that history. Run events
keep their existing invocation identity (`HarnessThread`, keyed by run id); the
persistent thread is a separate record, joined through
`HarnessThreadRecord.invocationId`. That join is a WITHIN-ONE-PROCESS join by nature: the run id is
a per-process counter (a restore only ever RAISES it), so a restarted server can hand the SAME
number to a different conversation, and a lane worker mints from its own counter while its parent is
still running. Two published facts make that readable rather than guessable. Every run frame carries
the epoch of the process that MINTED its id (`thread.epoch` — see the `thread`
identity note under [Progress events](#progress-events)), and the host/UI roster row now carries the
matching IDENTITY BLOCK: `invocation_id` (this conversation's LATEST recorded run), `invocation_ids`
(every run recorded for it, oldest first, at most 64, deduped by bare id) and `epoch` (the process
that minted `invocation_id`) — on `ThreadSummary`, which is what `GET …/threads` pages and what a
`thread.upsert` stream frame carries, and as `invocationId` / `invocationIds` / `epoch` on
`SessionThread` / `SessionThreadView`. All three are OPTIONAL and every value is BARE: the composite
`id + U+0000 + epoch` run key stays a private join key, and a row is emitted without any of them when
the conversation never ran (or its document predates the field), so an old roster row projects
exactly as it did. A client that finds the same id on two rows therefore binds a recorded frame to the
conversation whose row names the SAME process, so it never binds a roster row to
a run a previous process recorded under the same number — and the model-facing `threadList` page keeps
STRIPPING `epoch`, because its schema offers no epoch argument the model could send back.

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
  `reset()`), and a `threadFork` branch id is refused as an address rather than
  deleted — it holds no thread slot, and its record leaves with the conversation that
  forked it. The receipt states the whole state change, in four fields: `{ deleted,
  removedThreadIds, removedInvocationIds, removedBranchIds }` — the id you named, every
  conversation that actually went (the cascade included), and which agent-result
  records and branch lookups were purged with them, because a released conversation's
  answers stop being readable by id and a caller needs to see that, not infer it. The
  two id lists are always present: empty means "purged nothing".
  Deletion purges THIS conversation only: it never promises to forget
  what other histories were already told, and it does not undo what this thread
  copied into session-shared memory (tasks, profiles, chapters, locations) or what
  a connected thread already received through a `#` reference. The one shared write it
  makes any shared write is **nothing** at all (Decision P deleted the claims this used to
  release: `releaseThread` and its four call sites are gone).

Threads may only be OWNED by an independent host thread: `ownerThreadId` must
name a `createThread` record, never an implicit `agent:<name>` conversation
(its owner link could not be persisted/restored). Delegation children from host
threads satisfy this automatically.
- **Cross-thread chat & discovery** — once the session owns a host thread, FOUR
  conditional core tools are registered: `threadList` returns the live
  conversations this caller can address (id, agent, origin, status, owner/label) with the caller's own
  `currentThreadId`, `threadRead` reads one of them back (**the FIRST PAGE only** —
  a page of up to 20 messages under its own 32 KiB text budget, one
  message by index, or a regex/role-filtered page with per-message content paging;
  `hasMore`/`nextOffset` continue the message list and `contentHasMore`/`nextContentOffset`
  continue one long message, so a full transcript is a sequence of reads, never one
  read;
  attachments come back as descriptors, never base64 bytes; omitting `thread` reads
  the calling run's own conversation), `threadSend` posts into one of them, and
  `threadDelete` releases a finished conversation the caller owns. Ids
  are therefore observed, never invented by a model or injected by the server;
  deleted threads are absent, and only this session is visible. The runtime records
  the REAL sender (agent + thread from the calling run, not a tool argument). The
  roster and the three address doors are scoped to the caller's **THREAD FAMILY** — its
  own thread, its ancestors, its descendants, and the default `agent:<name>`
  conversations of the agents that family spans — because a tool that lists ids the
  caller cannot use is worse than one that lists none; a threadless caller (a host view
  outside any conversation) stays unscoped and sees everything, and a SIBLING is
  deliberately outside the family. The
  post is STATE-AWARE and the receipt names the outcome: a RUNNING target is
  steered (`delivered: 'queued'` — the message lands at its next safe boundary, in
  the turn already in flight), a conversation a plugin PARKED (`paused`) is QUEUED
  into the park and the park is LEFT ALONE (`delivered: 'queued'` — the holder parked
  for its own next turn, and only a host `sendThreadInput` lifts a park from outside),
  a DORMANT `idle` target is started (`delivered: 'started'`, the message is its prompt),
  and a STOPPED one is refused. Neither path waits for the answer.
  CORRECTED IN PLACE: an idle target used to get an inert append
  (`delivered: 'appended'`) that no run was obliged to read, and a parked target used to
  be resumed by the message that only arrived.
  A message that STARTS a dormant default conversation also opens a route back: the run
  that answers it carries the SENDER's thread id as a transient, per-run reply target, so
  that one turn can list, read and reply to the conversation that woke it; when the run
  ends the route reverts, and nothing about the woken agent's standing conversation is
  rewired for the callers that come after it.

Threads persist in the harness snapshot as an optional `threads`/`threadSequence`
pair (absent while only default conversations exist). The key joined the format at v2 and is carried unchanged by the current version, `HARNESS_SNAPSHOT_VERSION = 3` (`src/core/snapshot.ts:107`). See `src/harness.ts` and
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
  server/           HTTP API, sessions, the WebSocket update stream, catalogue presets, CLI, discovered routes
  frontend/         browser client + the app shell it renders
```

The application layers are barrelled the same way as the library:

```
src/server/
  index.ts              the server surface (startHarnessServer, runtime, dispatcher,
                        SessionStore, protocol, presets) -> @underload/harness/server
  start.ts              startHarnessServer: the ONLY listener, created when called; takes the
                        explicit `harness` boot configuration (templates/agents/plugins/tools)
  api.ts                transport-neutral dispatcher: routes, body policy, bootstrap
  handler.ts            Node adapter: the /v1/harness mount, no header gate, plain HTTP (no CORS)
  service.ts            @underload/service adapter: /v1/harness, Origin gate, CORS, the stream upgrade
  runtime.ts            lazy shared store/catalogue for the discovered service routes, one per
                        database root and guarded by the boot-configuration signature
  persistence.ts        durable database: versioned JSON, atomic write, DTO validation
  sessions.ts           authoritative turns + FIFO queue; restore + write-through
  environment.ts        package-root .env loader (Node entry points only)
  config.ts             provider defaults + mergeSettings credential rule
  protocol.ts           client/server wire types (turns, queue, stream items)
  package-root.ts       package root discovered by walking to package.json (build-layout free)
  static.ts             optional static serving for a host-supplied UI build
  cli/                  argv parsing, one-shot + interactive rendering
  harnesses/            presets and harness-level tools shared by CLI and server
  endpoint/harness/     the route modules @underload/service discovers

The browser client that used to sit under `src/frontend/` (index/main/api/
stream/deployment/contract/ui/extensions/styles.css/index.html) now lives in
`@loadscript/harness`.
```
docs/                   the package documents (index: docs/README.md): the plugin
                        authoring guide (plugins.md), the runtime-tools
                        integration doc, and the issue + task logs
```

The transcript is one compact row per user turn. A delegated agent adds an ENTRY
of its own under the invocation that spawned it: a compact thread row at depth 1
(its own children at depth 2, and so on), placed inside the turn row but outside
every collapsible body — collapsing a parent tile or a parent entry never hides
it. Each entry expands independently and owns its input, streamed text, tool
calls, status and outcome; two calls to the same agent are two entries — and an entry belongs to
one RUN, so rows are keyed by the invocation id together with the process epoch that minted it
(a restarted server can hand the same number to a different run, and a one-sided comparison
merges rather than
splits, so only two known epochs that differ open a second entry). A
`threadFork`/autoanswer branch reuses the same nested entry shape via its `thread`
metadata (`kind`/`branchId`), with only a small kind tag differentiating it. A
saved session that predates the `thread` metadata is replayed from its
`delegate` calls, and a stream that cannot be attributed keeps the old flat
agent section instead of inventing ancestry.

Imports resolve by environment as well as by name, so a browser never loads a
`node:http` graph and a Node host still gets the server API from the root:

| Specifier | Resolves to | Contains |
|---|---|---|
| `@underload/harness` (node/import) | `src/index.ts` | library + shared + server |
| `@underload/harness` (browser) | `src/browser.ts` | library + shared |
| `@underload/harness/server` | `src/server/index.ts` | server API only |
| `@underload/harness/worker` | `src/server/workers/lane-worker.ts` | the lane-worker ENTRY a `Worker` is spawned with (`threadExecution: 'worker'`) — not an API surface |
| `@underload/harness/io-worker` | `src/server/workers/io-worker.ts` | the IO-worker ENTRY (`HARNESS_IO_EXECUTION=worker`) — same shape, durability arm |
| `@underload/harness/shared` | `src/shared/index.ts` | origin/loopback helpers |

Importing any of them is inert: no listener is bound (call `startHarnessServer`
for that, or let `@underload/service` host `/v1/harness`). The browser client is
`@loadscript/harness`.

### TypeScript consumers

The package publishes **TypeScript source**, so there is no declaration build and no
`.d.ts` tree: the `types` condition of every subpath names the same `src/*.ts` file the
runtime loads, and a consumer's editor and `tsc` read that source directly.

Those sources use extensionless relative specifiers (`./harness`, `./ui/turns`) the way a
bundler-resolution codebase does, so the supported consumer mode is
`moduleResolution: "bundler"` — what Vite, Vitest, vite-node and every bundler consumer
in this workspace already uses:

```jsonc
{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler" } }
```

`moduleResolution: "node16" | "nodenext"` is NOT supported: it requires every relative
specifier to carry its output extension, which the published source does not, so it fails
with TS2834 (the ruling, and what an emitted `.d.ts` used to pay for it, is recorded in
`scripts/check-package-types.ts:44-53`).

Types follow the same environment split as the runtime:

| Consumer | Resolves | Compiler needs |
|---|---|---|
| Node | `src/index.ts` (library + shared + server) | `types: ["node"]` (server API) |
| Browser (`customConditions: ["browser"]`) | `src/browser.ts` (library + shared) | `lib` with `DOM` |
| `@underload/harness/server` | `src/server/index.ts` | `types: ["node"]` |

Type-checking source instead of a trimmed declaration surface costs two settings, both
deliberate: `types: ["vite/client"]` because `src/frontend/api.ts` reads `import.meta.env`
(whose type that ambient declaration provides), and `skipLibCheck: true` because the
source graph reaches third-party `.d.ts` files through `typescript`, `ws` and `marked`.
The harness code is still type-checked in full — it is `.ts`, so it is in the program.

The Node root re-exports the browser client, so its DOM signatures make the `DOM`
lib necessary even in a Node program — an accepted consequence of "the root exposes
everything". Import a subpath when you want the narrower surface (or no DOM at all).

`yarn test:package` type-checks a real `moduleResolution: Bundler` consumer **and** a
real `customConditions: ["browser"]` consumer against a copied published install (the
package inside a scratch `node_modules`, so the manifest's resolution is what is tested,
never a `paths` alias), and walks the published browser source graph to prove it reaches
neither the Node root nor the server barrel. `yarn test:package:runtime` then *runs* that
same copied install: the `.env` loader, a durable `createHarnessRuntime({ root })`, and
`startHarnessServer` on an ephemeral loopback port (the `/v1/harness` mount, the paged
harness index, a session POST, clean close). `yarn test:package:tools` drives the whole
self-modifying-tool scenario through the copied `src/index.ts`. `prepublishOnly` runs
them all.

**Browser note.** Importing the browser root (or `./frontend`) evaluates no Node
graph: `src/browser.ts` statically reaches only the library, shared and client modules.
The package tools are a documented Node-only exception —
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
                        tasks, delegate, threadFork, …) — one *.tool.ts each
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

Tests sit next to the module they cover and reach the published surface through the
package specifiers — the bare `@underload/harness` and its published subpaths (e.g.
`@underload/harness/shared`), never a hand-written path into a build directory: there is
no build directory, because the package publishes `src/*.ts`. There is
deliberately **no `resolve.alias`** in `vitest.config.ts`: every published condition
already names the raw TypeScript entry under `src/`, so the manifest targets — not an
alias table — are what make `vitest run` build-free, and a
test can never assert a stale bundle. `src/structure.test.ts` pins the manifest,
the config, and the `tsconfig.json` `paths` mirror against each other.

Each folder has an `index.ts` barrel, and `harness.ts` re-exports the public
surface, so consumers only ever import from `@underload/harness`.

### `agent()` — the brain

Model, instruction, message history, and the model-request retry sequence for one
turn. It owns no other policy: no tool execution, no compaction, no planning.

**What it does about context size.** It measures, and it refuses; it never trims or
summarises. `estimateContextTokens(messages, instructions?)` is on the published
surface and answers "will this transcript fit?" with the same `ceil(chars / 4)` the
UI's context bar shows — message content, an assistant turn's tool-call names and raw
arguments, and instruction text. Two exclusions matter when picking a limit: attachment
**bytes** are not counted (a provider charges media per image, not per base64 character)
and neither are the request's **tool schemas**, so the real prompt is a little larger
than the estimate; `reasoning` is excluded because it is never resent. Set `provider.contextWindow` or `agent({ maxPromptTokens })` — a limit on
what may be sent, not a policy about what to send, and the agent setting wins when
both are set — and a transcript estimated above it fails **before the request
leaves**, as a `context-overflow` failure naming the estimate and the window. A
provider's own 400/413 "input too long" answer is reported under that same code
instead of as a generic transport error, and neither is ever retried: re-sending the
same oversized bytes answers the same way. What replaces an oversized transcript stays
the host's decision, on the plugin bus — `turn.before` is the one hook that may
rewrite the transcript the provider is about to see, and the shipped
`context-compaction` plugin (`src/plugins/context-compaction.plugin.ts`) is the
reference implementation — it owns the `contextLimit` setting that decides when it
acts. No tokenizer ships (a dependency, and a false promise across gateways), so
every number here is an estimate, and a provider's real count arrives one request
too late to prevent the next one.

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
| attempts | 1 + 10 retries | `retry: { maxRetries }` (default `10`); `retry: false` (or `maxRetries: 0`) is a **hard opt-out for every class** — exactly one attempt, and the short class ladders below are skipped too |
| waits | `min(1000 * 2 ** n, 60000)` ms, n = 0..9 | 1s, 2s, 4s, 8s, 16s, 32s, then **60 s flat** for the rest of the ladder (`retry: { baseDelayMs }` changes the base; there is no jitter, so a published `delayMs` is a fact). Uncapped doubling used to sleep 1023 s (~17 min) on an exhausted ladder; capped, the same eleven attempts wait at most 303 s |
| class ladders | 3 / 4 attempts | `provider-connection` (nothing answered the dial): **3** attempts, 250 ms + 500 ms. `provider-timeout` (a bound expired, or the provider reported a timeout on the stream): **4** attempts, 2 s + 4 s + 8 s, each capped at 30 s, under a **900 s** wall-clock deadline over the whole sequence. Neither is stretched by `retry.maxRetries`, and `baseDelayMs` only ever RAISES the timeout ladder's 2 s base. `provider-rejected` (an HTTP 400/401/403/404) and `provider-aborted` (the gateway's own in-stream cancel) are terminal, as is an abort from your own signal |
| success | first successful attempt | later retries are never made |
| exhaustion | last attempt fails | the **last attempt's own error** is thrown / yielded |

Every transient model-call failure is retried, not just 5xx: a returned `error` frame (any
HTTP status, a provider error attached to a `200` stream, a malformed frame, a truncated
stream), a thrown network error, and a stream that throws mid-flight. A gateway's mid-stream
error frame is read STRUCTURALLY — its `code` (`timeout` / `connection` / `aborted` /
`upstream_status` / `decode` / `unknown`), plus `status`, `errno` and `param`, pick the retry
class through `providerWireFailureOf` (`src/transport/provider-timeouts.ts`), and an unknown or
absent code keeps the generic transient ladder it always had. TWO producers write that frame —
the primary gateway (`packages/underload/service/src/server/start.ts`) and a second SSE writer
(`repository/agentic/src/server/start-server.ts`, an inlined copy pinned by its own test) —
with the same six codes and the same wire keys, so the ladder never depends on which one is in
front. **Cancellation is not
retried**: an abort before an attempt, during a backoff, or while a request is in flight ends
the request immediately — and so is a cancel the PROVIDER reported (`provider-aborted`), which
is a request nobody is waiting for.

A failed attempt's partial text, reasoning and tool calls are discarded — they are
never committed to history, so no tool from an abandoned attempt can run. The
`retry` event (and `AgentStreamEvent`'s `retry` frame) reports the attempt, the
budget (the CLASS's budget — 11 transient, 3 for `provider-connection`, 4 for
`provider-timeout`), the backoff, the failed attempt's error (`message` plus its
machine `code`) and, for a provider-classified attempt, the `provider` diagnostics —
redacted endpoint, effective port, which bound expired and the errno the platform
named. A TERMINAL `error` event carries the same `code` and `provider` since
2026-11-17, so a failure that was terminal by design no longer reaches a UI as a
sentence to parse. That is what a UI/CLI renders.

```ts
agent({ model: 'x', provider: { baseURL }, retry: { maxRetries: 3, baseDelayMs: 500 } });
agent({ model: 'x', provider: { baseURL }, retry: false });   // one attempt, fail fast
```

#### Structured output

`structured: schema` means "send the schema **and** hand me a validated value"
(issue 0001). One field covers both halves, and the schema is judged by the same
runtime gate a created tool's arguments pass — there is no second JSON-Schema
implementation.

```ts
const brain = agent({
    model: 'x',
    provider: { baseURL },
    instruction: 'Answer with JSON only.',
    structured: {
        type: 'object',
        properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['title']
    }
});

for await (const event of brain.stream('Summarise this.')) {
    if (event.type !== 'done') continue;

    event.message.structured;   // { title: '…', tags: [ … ] } — already validated
}
```

| Behaviour | Rule |
|---|---|
| On the wire | Injected as the transport's `response_format: { type: 'json_schema', json_schema: { name, schema } }`, through the same `provider.responseFormat` seam the transport section describes. An explicit `provider.responseFormat` wins on the wire, and `structured` still gates the reply. |
| The value | `message.structured` carries the parsed, validated value. The key is absent for every agent that did not set `structured`, and absent when the turn was not judged (see the two rows below). |
| Bad answer | Not JSON, or valid JSON that fails the schema: a `HarnessError` with code `structured-output-invalid` — an `error` event from `stream()`, a throw from `turn()` — and **nothing is committed to history**. Never a silent `{}`. |
| Retries | A schema failure is **not** a transport retry, whatever `retry` says: the provider answered successfully, so re-sending the identical request would burn a request and a backoff on the same shape of failure. Exactly one transport call, then the host decides. |
| `stopReason: 'length'` | Not judged. A truncated answer is a different problem than a malformed one, so the caller keeps the distinguishable `stopReason: 'length'` and no `structured` value. |
| `stopReason: 'tool_calls'` | Not judged: the turn has no answer yet. The final answer of the same run is. |
| Bad schema | Rejected at construction with code `structured-schema-invalid`, under the same bounds a created tool schema passes (`MAX_CREATED_SCHEMA_DEPTH` / `_NODES` / `_BYTES`). Parsing is strict — a code-fenced answer is a failure, not something to sniff out. |
| A custom `stream` | Cannot be told about `response_format`, so `structured` is validation-only there; the wire half needs `provider`. |

Forks and persistent threads inherit the schema: they are the same brain, so they
must not silently commit answers the owning agent would have refused.

### `tool()` — an action the model can request, or you can call

A tool is an **executable object**, not a passive descriptor. The same
implementation has two entry points: a direct call, and a call from the model.

```ts
// The preset's real shape: one array property, so `execute` receives the array
// itself. Items may be strings or
// `{ path, startLine?, startColumn?, startByte?, maxLines?, maxBytes?, lossy?, numbered? }`.
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

// { files: [{ path, content, startLine, endLine, truncated, limit, startByteAligned,
//             nextLine, nextColumn, nextByte, bytes, sizeBytes, lineCount?, lossy?,
//             budgetGranted?, error? }],
//   truncated, bytes, wireBytes, contentBudget, budgetPool, modelBytes, skipped, note? }
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
    `edit`, `search`, `fetch` and `actionRequest` are `'sync'`; `shell`, `delegate`
    and `threadFork` are `'async'` (a long command, a child run and a detached clone
    must never hold a batch hostage). `actionRequest` is `'sync'` on purpose: the
    question is directed AT the owner, so while a run owns an unsettled request the
    turn loop issues no model request at all — the run is held until the answer, a
    `toolCancel` or an expiry releases it, instead of spending a turn on a
    `{"status":"pending"}` placeholder for its own open question.
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
- every searchable tool the enabled set carries — what `toolRequest` or `toolManage`
  has already enabled, plus what the host seeded at construction (`enableAllTools`,
  below).

`toolRequest` is a core tool the harness always registers. It accepts exact
`names`, a name `regex`, and/or capability `tags`, selects the **union** of those
criteria, enables the matches for the next request, and returns the matched
metadata. Selection is uncapped; the host bounds the persistent enabled set with
`maxEnabledTools` (default 32), and core tools never spend that bound.

The enabled set can also be seeded instead of queried: `enableAllTools: true` runs ONE
`enableTools` pass over the registered names at the end of construction
(`src/harness.ts` `seedSwitchableTools`), so every name that harness can give a cap
slot — live, not
`visibility: 'core'`, not pending-only, not switched off by the deployment's tool deny list
(`src/harness.ts` `isToolGloballyDisabled`) and not switched off by THIS conversation
(`withheldTools`) — is enabled before the first request.
`maxEnabledTools` is not raised for the seed: past the cap the remaining names are
simply left off, exactly as an over-cap `toolRequest` match is omitted, and it is never
an error. It is off for a library harness unless you pass it;
the shipped server passes it on BOTH of its build paths — for every session it CREATES
(`SessionStore.create` → `buildHarness(…, { enableAllTools: true })`), which is what makes a
brand-new conversation usable immediately, and for every session it RESTORES
(`SessionStore.restoreSession`, the same call). The restore
seed changes nothing about the conversation that comes back: `harness.restore()` ends by
replacing the enabled set wholesale with the persisted `discovery.enabled`
(`src/harness.ts` `restore()`), so a restart still cannot switch a tool back on for a conversation
that had switched it off — a restored session keeps exactly the set it committed, and the
switched-off names travel with it in the snapshot's additive `discovery.withheld`. It is there
because the RESET re-seam below is gated on that same build configuration, which belongs to the
process that built the harness: built unseeded, a session reset after a restart had no seed to
re-run. A session RESET is the other event that starts a new conversation, so the server re-runs
the same pass there (`SessionStore.reset` → `harness.enableAllSwitchableTools()`, `src/server/sessions.ts`),
in every process — `create → reset` and `create → restart → reset` are the same toolbox. A restart
on its own is not, and stays exactly as described above. A record written before this seed existed
is no exception: nothing about the posture is stored per session (the committed set already is,
inside the snapshot), so a legacy session refills on its first RESET like any other, and a plain
restart of one never refills it. The ONE case that still resets to an empty toolbox is a session
whose preset factory withholds the seed from the configuration — an injected or scripted preset
that builds its own harness (`src/server/session-reset-toolbox.test.ts`,
`src/server/sessions.test.ts`); every shipped preset forwards it, and a library `harness()` caller
or the CLI never receives the report at all. `harness.isToolSwitchable(name)` is the matching
read, and since the session switch it answers exactly ONE question — which names hold a
searchable CAP SLOT (`src/harness.ts` `occupiesSearchableSlot`) — and not "may this name be
switched": `toolManage enable|disable`, the plugin seam and the operator's PATCH accept EVERY
registered name, core declarations and the pending-only `toolCancel` included, and the
conversation's own off-switch is a separate `harness.withheldTools` set. The seed above and the
reset re-seam both SKIP a withheld name (an auto-enable never overwrites a user's decision),
while `reset()` clears the set, so a new conversation starts with every name on. And `protected`
on a session-tool row is no longer this predicate: it is the kernel's UNREGISTER rule
(`visibility === 'core'` on the live registry map), the one thing `DELETE` still refuses with a
`403`.

Every harness also preloads the bundled preset catalogue by default (`presets:
true`), so its tools are available with no imports at all. The five core file tools
(`read`, `write`, `edit`, `glob`, `grep`)
plus a configured `search` (and `fetch` when the harness opted into `webfetch`) are
declared from the first request, together with the harness-owned `toolRequest` and
`tasks` (and `delegate` while some agent may delegate under `ranks`). Every other harness-owned row —
`toolRegistry`, `toolList`, `toolManage`, `toolCreate`, `records`, `profiles`,
`chapters`, `locations`, `agentManage`, and `agentResult` — plus the
conditional `actionRequest` (`interaction` configured) and `threadFork`
(`forks.enabled`, the default) stays registered but searchable: the model enables
them with `toolRequest` — or finds them already enabled in a session the server created,
because that session starts with the seeded toolbox described above — and a manual server
call still runs them directly.
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
(metadata only). The motivating case is `delegate` in a harness whose rank map gives
an agent a strictly-lower-ranked peer: an exact wire-name, regex, or tag query names
the tool instead of
claiming nothing matched. These entries are never enabled, never count against
`maxEnabledTools`, and their tags are not reported in `unmatchedTags`.

| Rule | Behaviour |
|---|---|
| Query shape | `names` (exact, case-sensitive), `regex` (bare source or `/source/flags`), and `tags` are OR-ed into one union; each match appears once. An empty query enables nothing and returns the vocabulary. |
| Tags | Trimmed, lowercased, deduplicated. Not required when `names` or `regex` is supplied. |
| Default visibility | `'searchable'`. The declared core set is `read`/`write`/`edit`/`glob`/`grep`, the harness-owned `toolRequest`/`tasks`, a configured `search`/`fetch`, and `delegate` only for the agents that actually hold a strictly-lower-ranked target (the declaration is rank-projected per caller, see [Delegation](#delegation), so a junior sibling never sees it). Everything else is demand-discovered: `files`, `download`, `syntax`, `shell`, `gitDiff`, the app tools, and the eleven demoted harness-owned rows (`toolRegistry`, `toolList`, `toolManage`, `toolCreate`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `actionRequest`, `threadFork`) — all still registered, so `toolRequest` can enable them (R9-R11). |
| Core vs session-bound | `core` means declared on every request — unless this conversation switches the name off (the conversation-switch row below), which is the one thing `core` no longer implies. It also never spends a `maxEnabledTools` slot. Only the harness-owned set is `sessionBound` (needs a `sessionId` for a manual server call); core file tools, `download`, `search`, and `fetch` run directly. |
| Ranking | Exact requested names keep caller order. Name-regex hits follow, then tag matches ranked OR-style: a tool's rank is its **best single-tag score** — exact tag (4) > tag prefix (3) > tag substring (2) > name/description hit (1). More matching tags only breaks ties. |
| Enabled bound | `maxEnabledTools` (default **32**) bounds the persistent SEARCHABLE enabled set at the model-turn boundary. Every selector kind (names, regex, tags) switches the set: this request's ordered matches lead, prior entries fill leftover capacity, overflow is `omitted`, and displaced prior names are `evicted`. Core tools are declared unless this conversation switched them off, and never count against the bound. |
| Already available | Core tools the caller already has (`delegate` for a caller that can delegate, `tasks`, the file tools, …) that match the query are listed in `alreadyAvailable` — metadata only, never enabled, never counted against the bound. They are scored by wire name and tags only (never description), and a match is not reported as unmatched. A **conditionally declared** control is reported the same way while it is genuinely actionable: `toolCancel` appears in this list exactly when the caller has calls in flight AND this conversation has not switched it off, because it is declared only then — querying `cancel` must never answer "no such capability" about a tool the caller is holding, and must not promise one the conversation has hidden. |
| No match | when neither a searchable nor an already-available core tool matches, the result carries `unmatchedTags` and the full searchable `availableTags`, so the model retries with real vocabulary. Both are computed AFTER the withheld set is applied, so a name this conversation switched off contributes no tag and is honestly reported as unmatched. |
| Undiscovered tool | calling one returns a tool result naming tags that would enable it — it does not run. |
| Conversation switch (`withheldTools`) | Every REGISTERED name is switchable off and on for ONE conversation â the searchable rows, the core declarations (`toolRequest`, `tasks`, `delegate`, `read`/`write`/`edit`/`glob`/`grep`, a configured `search`/`fetch`, the thread group) and the pending-only `toolCancel` all included. The mechanism is a per-harness `withheldTools` Set (`src/harness.ts` `applyToolSwitch`, read back as `harness.withheldTools`), NOT cap-set membership: for a name with a cap slot a disable also frees that slot, and for a core or pending-only name the withheld set is the ONLY record, because such a name never had a slot to lose. It is REAL TIME â declarations, `toolRequest`'s catalogue and the launch gate read it per request and per launch, so a switch lands on a running thread's very next model request, which is why the `enabled`-only `PATCH /v1/harness/sessions/:id/tools/:toolId` has no idle gate and no `403` for a harness-owned name. It is INVISIBLE, not denied: a withheld name is absent from `tools`/`matched`/`omitted`, from `availableTags` and from `alreadyAvailable`, is never re-enabled by a match, and is not reported as `forbidden` (that field stays the delegation allowlist plus the deployment deny list). Calling it anyway answers `Tool "<name>" is switched off for this conversation by its user. Calling toolRequest will not find it and asking again will not change this answer.` (`src/harness.ts` `sessionDisableReason`). It gates the AGENTS ONLY: `harness.executeTool` / `context.callTool` (a nested call, and both execution routes) still run a switched-off name, and no other session or deployment setting moves. It PERSISTS as conversation state â the snapshot's additive `discovery.withheld`, omitted while empty (`HARNESS_SNAPSHOT_VERSION` is `3` — the version bump came from the rank pass, not from this key — and it stays additive within v3), absent means empty, an unknown name is dropped leniently on restore rather than throwing â `reset()` clears it (a new conversation starts with everything on), and `src/server/sessions.ts` `pruneStaleEnabledTools` prunes a name this build no longer registers, so a stale switch is simply forgotten and a name that comes back later comes back ON. A worker lane starts from `LaneBlueprint.withheldTools` (`src/server/workers/protocol.ts`, filled by `blueprintFor`) and is kept honest on a live toggle by the one-way `sync.tools { enabled, withheld }` frame (`LaneToolStateSync`), posted by `lane-host.ts` `broadcastTools()` from `lane-authority.ts` `toolStateNow()`; the frame is additive â no `LANE_PROTOCOL_VERSION` bump â and a replica DROPS a name it cannot register instead of throwing. The hazards are the accepted cost: switching off `toolRequest` removes the model's only switching door, so recovery is user-side only; switching off `tasks`/`delegate`/the thread controls leaves the machinery running while the model loses its writer and dispatcher; switching off `toolCancel` leaves a model no way to withdraw an in-flight call; enabling a searchable name can still EVICT another enabled one through the cap; and a session can hold a name enabled while the deployment deny list still refuses it, because deployment outranks session. |
| Seeded enabled set | `enableAllTools: true` (`HarnessConfiguration`, **off** for a library caller) enables every registered name that can hold a cap slot at the end of construction through one `enableTools` pass (`src/harness.ts` `seedSwitchableTools`) — so `maxEnabledTools` still caps it, the overflow is left off rather than thrown, a name the deployment denies is filtered out first, and a name THIS conversation has switched off is skipped (an auto-enable never overwrites a user's switch). The shipped server sets it on BOTH build paths: for a session it CREATES (`SessionStore.create` → `buildHarness(…, { enableAllTools: true })`) and for a session it RESTORES (`SessionStore.restoreSession`, the same call), and re-runs the pass whenever a session is RESET (`src/server/sessions.ts` `SessionStore.reset`, via `harness.enableAllSwitchableTools()`) — a reset starts a new conversation, in any process. Setting it on the restore path does not refill anything: `harness.restore()` replaces the enabled set with the persisted `discovery.enabled` (`src/harness.ts` `restore()`) after construction, so a restored session keeps the set it committed and only a RESET starts full again; the flag on that path is what lets the reset seam fire at all after a restart, because the seam is gated on the per-process build configuration. A pre-existing record (written before the seed) needs nothing special: it refills on its first reset and never on a plain restart. The one qualification of "exactly": an enabled name THIS build no longer registers is pruned off the committed set on restore instead of losing the conversation (`src/server/sessions.ts` `pruneStaleEnabledTools`) — the same function prunes a switched-off name that is no longer registered out of `discovery.withheld`, silently. A deployment denial outranks either figure: a denied name is filtered out of the seed, hidden from the model, and refused at the launch gate whatever a row's `enabled` says. `harness.isToolSwitchable(name)` states which names hold a cap slot — cap arithmetic, not permission to switch: every registered name is switchable, and a row's `protected` figure is the kernel's UNREGISTER rule (`visibility === 'core'`), which only `DELETE` consults. |
| Lifetime | discovery is per harness and kept across calls; `reset()` forgets it with the conversation — the conversation's switches too, because `reset()` clears the `withheldTools` set beside the enabled set. `harness.discoveredTools` exposes the enabled names — seeded ones included, switched-off names excluded; `harness.withheldTools` exposes the switches. |
| Scope on the server | The enabled set is per harness and ONE session owns one harness, so discovery is per conversation — and a CPU-isolated lane replica resolves that same session's enabled names AND its switches (`src/server/workers/lane-authority.ts` `enabledNow()`/`toolStateNow()`, the `sync.tools` frame above). Two switches sit ABOVE that set and are deliberately not per conversation: the deployment **tool deny list** (`PATCH /v1/harness/tools/:id`, one store per process, honoured on the next turn of every session AND thread, `src/server/tool-settings.ts`) and the plugin **template** (`PATCH /v1/harness/plugins/:id`, inherited by sessions created after the write). Plugin settings proper are per conversation — `PATCH /v1/harness/sessions/:id/plugins/:pluginId` (`src/server/plugins.ts`, "THE TWO SCOPES"). A session CAN switch ANY name in its own toolbox off or on — every registered name, the harness-owned core controls included (`PATCH /v1/harness/sessions/:id/tools/:tool_id`, the `withheldTools` row above) — but that is not a copy of the deny list: every harness re-filters the request list through the provider (`src/harness.ts` `isToolGloballyDisabled`) and refuses to launch a denied name (its launch gate), so a session cannot lift a deployment denial — while the MANUAL path (`harness.executeTool`, both tool-execution routes) is not gated by either switch at all, which is what lets an operator run a name the model was refused or a conversation switched off. |
| Reserved names | `toolRequest`, `toolList`, `toolManage`, `toolCreate`, `tasks`, `profiles`, `chapters`, `locations`, `agentManage`, and `agentResult` belong to the harness, and `delegate`, `actionRequest`, and `threadFork` too when they are registered; using one throws. |
| Manual call | an operator may run any registered tool through `harness.executeTool()` /
  `POST /v1/harness/tools/:id/executions` (or the session-scoped form of it); discovery gates the model, not the user. Core file tools need no session; the harness-owned set does. `actionRequest` and `threadFork` are the exception: they need the run that owns the conversation and are refused by the manual path. |

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

Checking an editable module does not require registering it. `compileToolSourceModule`
(exported from `@underload/harness`, with `supportsToolCompilation` as the platform flag)
transpiles a candidate and answers with its metadata, the content-addressed `revision`
(the same identity `toolManage source` reports for those bytes), the `checks` actually
performed, and a callable `definition` that is registered nowhere. The limit is the one
this section already states: the compiler is `ts.transpileModule`, so **syntax only** — no
semantic type check — and loading a candidate runs its top-level code, which
`{ evaluate: 'syntax' }` opts out of entirely. A host that compiles its user tools once
can hand the compiled `definition` plus its bytes to every harness it builds
(`tools: { name: { tool, source } }`) and keep the inspect/revision surface. Full
contract: [`docs/runtime-tools.md`](./docs/runtime-tools.md#compile-a-candidate-without-touching-the-registry).

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
| `tasks()` / `tasks({})` / `tasks({ parameters: undefined })` | read: return the current page, change nothing |
| `tasks` entry **without** `id` | add one task (`text` required, trimmed, max 4000 chars) with the next stable id (`"1"`, `"2"`, …) |
| `tasks` entry **with** a known `id` | patch that task: `text` and/or `completed`, whichever you send; omitted fields are unchanged |
| `remove: ["7", "9"]` | remove those ids |
| `ids: ["4"]` | read named records instead of a page — one id answers in `entry`, several in `entries` |
| `where: { completed: true }` | equality filter for a list read (`{ field: value }`, AND across the keys), applied BEFORE ordering and paging, so the page and its cursors move over the matching records and `counts` describes the filtered set; it cannot combine with `since` or `ids` |
| `expects: [{ id, rev }]` | the revisions you READ, one per id this call patches or removes; required for every such write whenever the runtime knows the caller — the lock and its ownership verbs are gone, so this is the only conflict control |
| `since: <storeRev>` | also return the store events after that revision: `changes`, plus `changesHasMore` / `changesTruncated` / `oldestAvailableRev` / `droppedEvents` (see the change-feed bullet) |
| `offset` / `limit` | index-page the returned list (limit 1-100, default 20) |
| `afterId: "12"` | keyset-page it: the records with an id above `"12"`; cannot be combined with `offset` |
| `mergeDisjoint: true` | opt-in: apply a stale content patch when the concurrent change touched only fields this patch leaves out |

```text
tasks({ "tasks": [{ "text": "Draft the plan" }] })
  -> { tasks: [{ id: "1", text: "Draft the plan", completed: false, rev: 1,
                updatedBy: "instruct", updatedThreadId: "agent:instruct",
                updatedAt: "2026-11-08T09:15:32.772Z" }],
       counts: { total: 1, completed: 0, pending: 1 },
       page: { offset: 0, limit: 20, hasMore: false },
       storeRev: 1,
       entry: { … the new record, repeated … },
       addedIds: ["1"] }

tasks({ "tasks": [{ "id": "1", "completed": true }],
        "expects": [{ "id": "1", "rev": 1 }], "offset": 20, "limit": 20 })
  -> { tasks: [...], counts: { total: 42, completed: 3, pending: 39 },
       page: { offset: 20, limit: 20, hasMore: true, nextOffset: 40 },
       storeRev: 22, changedIds: ["1"] }

tasks({ "tasks": [{ "id": "1", "completed": true }],
        "expects": [{ "id": "1", "rev": 2 }] })          // `completed` is ALREADY true
  -> { tasks: [...], counts: { total: 42, completed: 3, pending: 39 },
       page: { offset: 20, limit: 20, hasMore: true, nextOffset: 40 },
       storeRev: 22, noopIds: ["1"] }                    // nothing moved: no rev, no event
```

- **Every successful call answers the same envelope** — `{ tasks, counts, page,
  storeRev }` with no per-action wrapper, plus `entry` when exactly one record answers
  (a single patch, or an `ids` read of one id), `entries` when `ids` names several, and
  `removed` / `removedIds` when the call deleted one record / two or more. Beside those ride
  **one key per KIND of write**: `addedIds` names every id the call minted (in mint order),
  `changedIds` every id it really patched (in the order you named them), and `noopIds` every id
  whose patch wrote nothing. Those three follow a different presence rule from
  `removed` / `removedIds`, and that is the whole contract: each appears whenever the call did
  that kind of write — **at any count, and independently of the others** — so a batch of one add
  plus one patch names BOTH ids while `entry` stays out; an empty list means the key is absent;
  and each key keeps one stable type (an array of ids). A caller branches on which KEY is
  present, never on a count, and an id is in `changedIds` or in `noopIds`, never both. `entry` is
  the one-record convenience and never suppresses a list, and the three lists ride whatever
  `limit` you sent — the page is a plain projection, so `limit: 1` stays the cheap write and the
  ids of your own write still arrive. A read answers with none of them. `counts` reports `total`, `completed`, and
  `pending` (`pending` is the count of unfinished tasks; the store itself keeps
  `completed: boolean` per task) and is always derived from the WHOLE list, never
  from the page. `page.nextOffset` (offset mode) or `page.nextAfterId` (`afterId`
  mode) is omitted when `hasMore` is false; loop on it to read the rest. The page is
  bounded by 100 items and a 64 KiB budget charged on the task records themselves — the JSON
  around them is never counted, and the first record of a page always lands. Caps: 200 tasks, 4000
  characters of text each, and going over is a refusal that sizes the job — `tasks would hold
  201 tasks; the maximum is 200. Remove one before adding.`, or `Remove 2 more before adding.`
  when you are two over, because the number already nets off the `remove` list the same call
  sends.
- **Each record carries `rev`**, its CONTENT revision: 1 when it is added, +1 only
  when `text` (after trimming) or `completed` actually changes. The PATCH itself is
  event-free when the values you send already match — no `rev` bump, no attribution, no
  store event — so a model that restates the list cannot flood the log, and the answer says so
  instead of leaving you to re-read: that id appears in `noopIds`, and nowhere else (no `entry`,
  no `changes` row, no `changedIds`). An entry that names an `id` and NO field at all is refused
  rather than counted as a no-op (`tasks "tasks[0]" names id "1" but sets no field; read it with
  "ids" instead.`), so through this tool `noopIds` has exactly one producer: a patch whose named
  fields already hold those values. Nothing
  else can move `rev` either: with the lock deleted there is no ownership action left
  to knock another agent off its compare-and-swap token. `updatedBy` /
  `updatedThreadId` / `updatedAt` attribute the
  last write and come from the tool context (the calling agent and conversation), never
  from tool arguments, so a model cannot forge who edited what.
- **The list is shared, so writes are guarded.** A call that HAS an agent identity (a
  model call, `harness.executeTool`, a slash command, a lane worker) must send
  `expects` for every id it patches or removes, or the write is refused as
  `guarded write: pass "expects" [{ id, rev }] for task "1" (read it first).`; a call
  with no identity (a bare `tool()` or driver call) may still write blind.
- The patch is **atomic**: the whole call is validated before anything mutates, so a
  bad entry leaves the list, the id counter, `storeRev` and the change log exactly as
  they were, and names the offending field
  (`tasks "tasks[0]" needs "text" to add a task, or an existing "id" to change one.`).
  Unknown ids, a duplicate id inside one call, an id that appears in two of `tasks` /
  `remove` / `ids` (`tasks id "1" appears in both "tasks" and "remove"; one operation
  per id per call.`), a repeated id in `remove`, the 201st
  task, a 4001-character text, and a stale `expects` all produce
  readable, recoverable tool results.
- **The change feed is bounded, and it sizes the gap.** The store keeps a FIFO log of 200
  recorded events per collection (`add` / `update` / `remove`); `since` returns the events after
  the revision you pass, at most 50 of them, trimmed against the same 64 KiB number the page was
  cut by but charged from the serialized page rather than from zero — and because the feed's own
  five keys are written after that trim and never charged, and its first event always lands, a
  feed-bearing answer can come back a little over the declared budget by a small fixed amount that
  does not grow with `droppedEvents`. A feed is FIVE keys, and
  nothing else adds any of them: `changes` (oldest first); `changesHasMore` — **this answer was
  cut short**, more events exist above your `since` than the 50-entry cap or the byte budget let
  through, and nothing was lost, so read on from the last `rev` you got; `changesTruncated` —
  **the retention floor moved past `since`**, so part of the gap is gone for good and no further
  read can show it; `oldestAvailableRev` — that floor, the oldest revision this collection's
  window can still show; and `droppedEvents` — the floor's SIZE,
  `max(0, oldestAvailableRev - since - 1)`, the events strictly below it that are gone, which is
  how a poller says "100 behind, resume at 101" without knowing the 200-event window out of band.
  The two booleans are not one signal and neither is the number: `changesHasMore: true` with
  `changesTruncated: false` and `droppedEvents: 0` is a reader that simply has more to read. The
  floor is read off the retained events, never derived from `storeRev`: a collection that has
  never written reports `1` (the revision its first event will carry), and a window trimmed to
  nothing reports `storeRev + 1`, so that reader is current only at `since === storeRev`. Through
  this tool both low-water keys ride ONLY beside a `changes` array — a plain `tasks` read has no
  feed to bound, so it carries neither (the un-wrapped `records` surface answers a plain read of
  one collection WITH `oldestAvailableRev`, and still never `droppedEvents`). The window is per
  collection, so a task reader is never woken by chapter edits. A `since` ahead of the store is an
  error, not an empty answer.
- Every result is a defensive copy, never a live reference.
- The list is **per harness**, shared by every agent in it, kept across
  turns, and cleared by `reset()` (ids restart at `"1"`, `storeRev` restarts at 0, the
  log empties). Snapshot/restore carry it inside the snapshot-v2 `records` block: one
  collection map `{ nextId, collections: { tasks: { definition?, items, storeRev?, changes? } } }`
  with ONE id counter across every collection, where each `items` entry is a full
  `TaskItem` (`id`, `text`, `completed`, `rev`, plus the optional
  `updatedBy`/`updatedThreadId`/`updatedAt`). `rev` and the attribution triple are
  OPTIONAL on read (`rev` restores as `1`), a missing `storeRev` restores as the last
  retained change, and `changes` restores as `[]`. Compatibility runs one way only:
  persisted keys are validated
  exactly, never ignored (`<label> has an unknown field "<key>".`), and an older build
  knows only `id`/`text`/`completed`, so a snapshot written by this build is REFUSED
  there rather than silently downgraded. A persisted claim field is refused the same
  way: `leaseUntil` / `owner` / `ownerThreadId` are not part of the v2 entry shape, so
  an old file cannot smuggle a lock back in, and a restored store simply has no
  claims to drop. Two harnesses — and therefore two server sessions — never share tasks.

#### Concurrency and ownership

There is ONE task store per harness and every agent on every thread writes it, and a
call is not a transaction: you read a record, work on it, and write back, and in
between somebody else may have written the same record. The store turns that race from
a silent overwrite into an explicit, recoverable error:

- **A read is a snapshot.** Results are copies, so the `rev` you hold describes the
  store as it was when you read it, not as it is when your next call lands.
- **`expects` is the proof of what you read.** Send the `rev` of every id you patch or
  remove. A mismatch rejects the WHOLE call and names the current revision, the last
  editor and when it wrote, and (when the log covers the gap) the fields that changed —
  and it CARRIES THE CURRENT RECORD, so the retry needs no extra read:
  `tasks "1" changed since revision 1 (now 2, last edited by "coder" at 2026-11-08T09:30:53.657Z); changed fields: completed; retry with "expects" [{ id: "1", rev: 2 }] or pass "mergeDisjoint": true. current: {"id":"1","rev":2,"text":"…","completed":true}`
  (the entry rides along whole up to an 8 KiB budget; past it the large fields are
  withheld and the message says so). A token whose record the store no longer has IS
  the race you hit, whichever half of the call named it — a `tasks` patch, a `remove`,
  or the token alone — and it answers
  `tasks "1" was removed since revision 1 — re-read the list and add or retry.` while
  the removal is still inside the 200-event window, and names both possibilities (never
  in this collection, or aged out of the window) when it is not. Only a call that sent
  no token for that id hears the plainer `tasks has no task with id "1".`, and a token
  for a live id this call does not touch is still rejected as a token for nothing
  (`tasks "expects" names id "4", which this call does not change`).
- **`rev` is content-only; `storeRev` counts every event.** A write that changes
  nothing, or one that lands on a different record, therefore never invalidates your
  token, while `since: <last storeRev>` still shows everything that moved.
- **There is no lock and no lease.** Any agent on any thread may write any task at any
  time; there is nothing to hold, hand back, or seize, so the token above is the ONLY
  conflict control and a long edit is protected by retrying rather than by reserving.
  The same rule survives a restart: the snapshot has no claim fields, so nothing can
  come back locked.
- **`mergeDisjoint` is the one escape from a stale rejection**, and only for a content
  patch: it applies the patch when the change log PROVES every concurrent update since
  your read touched only fields your patch does not set. An overlapping field still
  rejects, a removal never merges, and a log that cannot prove full coverage rejects
  rather than guessing — and when it rejects a second time the advice says why
  (`"mergeDisjoint" is already set, and the change window no longer covers every
  revision since <expected>, so it cannot prove this patch disjoint.`).

```ts
// ONE harness session, two agents: `coder` and `reviewer`. Record "1" sits at
// content rev 3, and nothing reserves it — both writers are free to go.

// — compare-and-swap: the loser is told, never silently overwritten —
coder:     tasks({})                                  // -> tasks[0] = { id: "1", rev: 3, … }
reviewer:  tasks({ tasks: [{ id: "1", completed: true }],
                   expects: [{ id: "1", rev: 3 }] })  // -> applied: content rev 4
coder:     tasks({ tasks: [{ id: "1", text: "Rewrite the intro" }],
                   expects: [{ id: "1", rev: 3 }] })  // -> the WHOLE call is REJECTED, and the
                                                      //    refusal carries the CURRENT record:
                                                      //    tasks "1" changed since revision 3 (now 4, last edited by "reviewer" at 2026-11-08T09:30:53.657Z); changed fields: completed; retry with "expects" [{ id: "1", rev: 4 }] or pass "mergeDisjoint": true. current: {"id":"1","rev":4,"text":"…","completed":true}
coder:     tasks({ tasks: [{ id: "1", text: "Rewrite the intro" }],
                   expects: [{ id: "1", rev: 4 }] })  // -> it retries straight from the refusal
                                                      //    it was just handed: content rev 5

// — mergeDisjoint: the escape hatch when the two patches do not touch —
reviewer:  tasks({ tasks: [{ id: "1", completed: false }],
                   expects: [{ id: "1", rev: 4 }] })  // -> STALE (the record is at 5): refused,
                                                      //    and the refusal names rev 5
coder:     tasks({ tasks: [{ id: "1", completed: false }],
                   expects: [{ id: "1", rev: 4 }],
                   mergeDisjoint: true })             // -> APPLIED: the log proves the skipped
                                                      //    rev 5 touched only "text", which
                                                      //    this patch leaves out — content rev 6
reviewer:  tasks({ tasks: [{ id: "1", text: "Retitle" }],
                   expects: [{ id: "1", rev: 4 }],
                   mergeDisjoint: true })             // -> still REJECTED: the skipped rev 5 set
                                                      //    "text", which this patch sets too
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
harness (therefore per server session), shared by every agent in the harness,
stable decimal-string ids from `"1"`, and cleared by `reset()` (ids restart at
`"1"`). They share one action set and one validation policy:

| Action | Input | Result |
|---|---|---|
| `add` | the tool's required fields plus optionals | `{ profile \| chapter \| location, counts }` — no list |
| `list` | optional `offset` (≥ 0) and `limit` (1-100, default 20) | ONE page: the records (summaries for chapters) plus `counts` and `page: { offset, limit, hasMore, nextOffset? }` |
| `get` | `id` | one record plus `counts`; for chapters this is the only action that returns `content` |
| `update` | `id` plus at least one mutable field | the patched record plus `counts`; fields you omit are unchanged |
| `remove` | `id` | `{ removed, counts }` |

Pages default to 20 records (max 100) with a 64 KiB budget charged on the serialized records
themselves and not on the `counts`/`page` JSON around them (the first record of a page always
lands); caps are 200 records, 200-character names/titles, 4000-character text, and at most 32
profile traits of 200 characters. Every result is a defensive snapshot (arrays and records
are copies). A rejected
call changes nothing: unknown action, missing/blank `id`, unknown id, wrong field
type, an update that names no field, and every tool-specific rule below are
readable errors naming the tool and field.

These three wrappers answer with their own domain shape and nothing beside it: an
`add` / `update` / `remove` here carries NO `addedIds` / `changedIds` / `noopIds`, no
`storeRev`, and no change-feed keys — the id receipts and the `since` window belong to
`tasks` and to the un-wrapped `records` surface, which return the engine's own envelope.
Their schemas are closed (`additionalProperties: false`) over the actions above, so a
`define`, a `drop` or a `since` sent to `profiles` is refused by the schema before the
engine sees it; `define` and `drop` are `records` verbs, and `records` refuses `define`
beside a `collection` (`records "define" registers a NEW collection, so it takes no
"collection" beside it.`) because `define` names the collection it creates. `define`
answers with the spec it ACCEPTED — `definition`, with the engine defaults the caller
omitted (`maxRecords`, `responseBudgetBytes`) filled in, so the caps you are about to hit
are discoverable before you trip them — and `drop` answers with `dropped: true` beside the
name, because an empty page plus the name is byte-identical to what a READ of an empty
collection answers.

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

Two harness-owned tools — `activation: 'always'` so every harness registers them, but
`visibility: 'searchable'` with `alwaysDeclared: false`, so the model enables them with
`toolRequest` — let an agent inspect what the session's other agents have produced without
reading their transcripts. Neither is rank- or role-restricted: under the rank model EVERY
registered agent may call both, so a junior delegate can read what its own siblings produced.

```ts
agentManage({})                                  // agents + truncated result previews
agentResult({ agent: 'researcher' })             // latest completed result
agentResult({ agent: 'researcher', invocationId: '3', offset: 4000 })
```

`agentManage` lists EVERY configured agent (even one that has not run), with
`name`, `rank` (the A–Z letter that decides what that agent may delegate to — this listing
used to report `role: 'primary' | 'subagent'`, and the model's own view of the team needed the
fact that actually decides delegation), `model`, `invocationCount`, and up to five recent invocations
newest first. Each invocation preview carries `invocationId`, `kind` (`root`,
`delegation`, `fork`, or `autoanswer`), `status`, `contentLength`, a
200-character `preview`, and a `truncated` flag. A running invocation has status
`running` and no content — a streamed partial is never presented as a result — and it is the
ONE row that gains two more keys: `startedAt` (the epoch milliseconds the run began, stamped
when the run registered) and `ageMs` (`max(0, now - startedAt)`, computed when you READ it, so
the same row ages between polls). That pair is the whole answer to "is this still going?", and it
is an age rather than a heartbeat: `delegate` has no wall-clock bound by default, retention never
evicts a running row, and nothing proves a run is alive — you decide whether to poll again or move
on. No other row carries it.

`agentResult` returns one completed answer. Omit `invocationId` for that agent's
latest **finished** result (completion order, so a fork that finished earlier does
not mask the root's answer). The result is `{ content, contentLength, offset,
limit, hasMore, nextOffset? }`: pages are 4000 characters by default and at most
8000, so a long answer is read in full across pages instead of being silently
truncated by the harness's 64 KiB tool-result bound. Offsets are UTF-16 code-unit
indices; page edges snap to surrogate-pair boundaries, so a non-BMP glyph is never
split (the returned `offset` is the one actually used). A failed/cancelled invocation
reports `error` and no content; an unknown id or agent is an error; an agent that
has not run returns `status: 'empty'`. A run that is still in flight, addressed by
`invocationId`, answers `status: 'running'` with `content: ''` plus the same
`startedAt` / `ageMs` pair; every other answer — `completed`, `failed`, `cancelled`,
`status: 'empty'`, and anything read back after a snapshot/restore — carries NEITHER key: a failed
or cancelled answer already reports its span as `durationMs`, and an archived or restored row has no
start stamp at all, so absence reads as "unknown", never as an age of 0. The pair is absent from
the `delegate` envelope too — a released or abandoned `delegate` describes a child that already
settled and answers with that child's `status`, `invocationId` and `durationMs`.

Both tools expose ONLY the completed assistant answer value. They never return
system instructions, transcript messages, tool arguments, or tool bodies. Results
are held in a bounded per-harness registry (64 completed records, active runs are
never evicted) and are **durable across snapshot/restore**: terminal results —
completed, failed, or cancelled — are stored in the snapshot's ADDITIVE `agentResults` array
(`invocationId`, `sequence`, `completedOrder`, agent, `rank` (the field the rank pass
renamed from `role`), kind, status, content, error?), so a restart keeps every answer that already
exists. Running invocations are omitted from a snapshot (they have no answer yet),
a snapshot written without that optional key restores with an empty registry (the KEY is
additive; the DOCUMENT version is not — a v2 file is refused outright, because the rank pass
renamed the transcript's `role` key to `rank` and refuses to guess a letter from the old word:
`Snapshot version 2 is not supported; this harness reads version 3.`,
`src/core/snapshot.ts:107,302-316,1205-1207`), restore advances
the run/completion/branch id counters so a later run in THAT restored harness cannot
overwrite an id the same snapshot archived — which is a restore guarantee, not a global one:
an invocation id is per-process (see [Progress events](#progress-events)), so treat
`invocationId` as a handle into the harness that is answering, never as a permanent id through
history — and `reset()` clears the archive with the conversation.

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
| `delegate` | `delegate` | core; registered only while the rank map spans two or more DISTINCT letters, and DECLARED PER CALLER only to an agent that holds a strictly-lower-ranked target (rank model, not a role flag) |
| `readFile` | `read` | **batched and bounded**: `(paths: (string \| { path, startLine?, startColumn?, startByte?, maxLines?, maxBytes?, lossy?, numbered? })[])` → `{ files: [{ path, content, startLine, endLine, truncated, limit, startByteAligned, nextLine, nextColumn, nextByte, bytes, sizeBytes, lineCount?, lossy?, budgetGranted?, error? }], truncated, bytes, wireBytes, contentBudget, budgetPool, modelBytes, skipped, note? }` |
| `writeFile` / `fileWrite` | `write` | **batched**: `({ path, content }[])` → `{ path, bytes, lossy? }[]` |
| `editFile` | `edit` | **batched**: `({ path, oldString, newString, replaceAll? }[])` → `{ path, replacements, bytes, match?, changed? }[]` |
| `listFiles` / `fileList` | `files` | **one manager, five operations**: `(ops: ({ op: 'list' \| 'move' \| 'copy' \| 'delete' \| 'mkdir', path?, from?, to?, overwrite?, replaceDirectory?, recursive?, force?, offset?, limit? })[])` → `{ results: [ ...ordered receipts... ], bytes, contentBudget }`; the paged listing is one OPERATION and its cursor lives inside that receipt (`{ entries, truncated, nextOffset, offset, limit, bytes }`), which is why `files` declares ONE property instead of three |
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
| `flaky` (tool) | `testFlaky` | both are gone: the tool and the `flaky` **harness/preset id** were deleted with the example tier |

`profiles`, `chapters`, and `locations` were added under their final
names, so they have no removed-name row. All three are core session tools with the
same incremental action set — see
[Session records](#session-records-profiles-chapters-locations).
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
ids (`general`, `instruct`, `research`, `workspace`, `reviewer`, `planner`,
`debugger`), agent ids, and the `websearch` and `webfetch` configuration fields are
*not* tool names and are unchanged. (`demo` and `flaky` are no longer among them: the
example presets were deleted, so those two names resolve to nothing.)

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
await read(['package.json']);                                   // { files: [{ path, content, … }], truncated, bytes, wireBytes, contentBudget, budgetPool, modelBytes, skipped, note? } — `note` only when a file of 65536 bytes or more came back cut
await write([{ path: 'notes.md', content: '# Notes' }]);            // [{ path, bytes, lossy? }]
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
table and the policy flags (`activation`, `mode`, `order`, `pendingOnly`, `control`,
`answerExtraction`, `sessionBound`, `listed`, `alwaysDeclared`). No flag carries authority:
the removed `primaryOnly` is gone from `ToolRegistration` and `DiscoveredTool`
(`src/core/tool-metadata.ts:95-124,128-151`), and the only rank-derived behaviour happens in
the runtime, as two projections — `delegate` for the callers that hold a strictly-lower-ranked
target (`rankProjectedDefinitions`) and `toolCreate` under the `toolCreation` policy
(`creationGatedDefinitions`).

The preset exports are **lazy proxies**, not implementations. The discovered
descriptor rows hold the static metadata (name, description, tags, schema) and the
loader names each implementation in its own `import()` branch; the body —
and the `node:fs` / `node:child_process` / `node:vm` it needs — loads the first
time a tool is called. A row the generated manifest does not know yet is compiled
from its editable source on first call instead of failing on a missing label (T24),
so a new preset is executable before the manifest is regenerated. Constructing a
harness or listing the catalogue therefore costs no Node built-ins, and a model that
never asks for `shell` never loads it. Because the published shape IS this source
tree, every branch stays an `import()` of its own `*.tool.ts` file: the split is
inherent to the sources rather than something a bundler produces, so an installed
package costs the same nothing until a call needs the body.

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

**`read` is bounded by default.** Each file gets a 1-based window: `startLine` defaults to 1,
`maxLines` to **2000**, and `maxBytes` to **65536** — deliberately small, because a read
feeds a context window, not a pipe. An explicit `maxLines`/`maxBytes` is honoured inside
1..20000 lines / 1..262144 bytes and outside them is **refused, never clamped**, because
`limit` is the field that decides whether to ask again. The whole batch shares a fixed
256 KiB budget measured on the **serialized JSON** result (escaping included), allocated by
**demand** rather than by headcount: a file that needs less than its share hands the
difference back to the files that were actually cut. A budget cut is explainable rather than
inferred: `budgetPool` (always present) is what the batch had left to split once the result's
own scaffolding, every entry's scaffolding and the note reserve were taken, and `budgetGranted`
names the allowance one entry was actually scanned against — present only when that batch share
was smaller than the file's own `maxBytes`, because otherwise `maxBytes` already is the answer.
Reading streams in 64 KiB chunks and
stops at the cap, so a huge file or a single giant line is never loaded wholesale. `limit`
names WHICH governor stopped a window — `'maxLines'` (raise `maxLines`), `'maxBytes'` (raise
`maxBytes`, the only knob that widens ONE file), `'budget'` (the shared envelope is full, so
raising either cap on that path changes nothing — want fewer bytes across the call) or `null`
(the window reached EOF) — and `maxBytes` itself is charged in **escaped wire bytes**, the unit
`wireBytes` counts, not the raw bytes `bytes` reports: a newline costs 2 escaped bytes in the
allowance and 1 raw byte in `bytes`, so a newline-heavy window stops with `bytes` near half the
allowance. Because the budget is measured on the form the harness delivers it in,
`wireBytes <= contentBudget` always holds and a full-budget read survives the harness's own wire
cap with its continuation fields
intact — the failure this design removed was a 64 KiB content budget next to a 64 KiB
wire cap, which meant a full read was *always* over the cap and got replaced by an
envelope that destroyed `nextLine`/`nextColumn`. `content` is raw text whose
first line is `startLine` — line numbering is metadata, not a prefix, so a model can
still copy exact text into `edit`. A truncated entry reports `nextLine`,
`nextColumn` (a 0-based UTF-8 byte offset within that line, counted from that line's physical
start and never from a seek, so normally 0 and non-zero only when a giant line was cut
mid-line) and `nextByte` (the absolute file offset).
`{ path, startLine: nextLine, startColumn: nextColumn }` resumes there by counting;
`{ path, startByte: nextByte, startLine: nextLine }` resumes by **seeking**, which is
how a large file should be walked, because a line-based window at line N must count
from byte 0 and therefore costs time proportional to the skipped prefix. A truncated
entry's `nextByte` is always strictly past the offset its own window started at, so paging
terminates: an allowance too small for the first code point still moves the cursor instead of
answering the same empty window forever. A `startColumn` past the end of `startLine` is not an
error either — the skip crosses that line's terminator, lands on the next line, and the entry
reports the line it actually returned. `startColumn` is always measured from the PHYSICAL start
of `startLine`, including when `startByte` is what supplied that line's offset — where it used to
be added to the SEEK, starting the window `startColumn` bytes deeper than the line it named — and
a column that resolves behind a `startByte` leaves the window at that seek, because a position the
caller pinned is never moved backwards by a relative field. Binary rejection is scoped to the bytes this call looked
at, and its two checks see different amounts of the file: the NUL check is **window** scoped,
firing on a NUL the window would have to contain, so a stray NUL far past the window reads as
text there and as `EBINARY` on the page that reaches it, while the invalid-UTF-8 check is
**chunk** scoped — the strict decoder is handed the whole read chunk before the window is cut,
so a bad byte after the cut but inside that chunk also answers `EBINARY`. A `startByte` that lands
inside a run of UTF-8 continuation bytes longer than any code point is `EBINARY` naming that byte
offset — the alignment probe stays bounded (it gives up past 64 continuation bytes), and giving up
used to report EOF, which read as "the file ends here" over a file with readable bytes before the
run. Neither check is whole-file
validation, so one file can read as text for a narrow window and as `EBINARY` for a wide one;
`lossy: true` substitutes U+FFFD for undecodable bytes and says so with `lossy: true`, but a
NUL is `EBINARY` either way — it says "not text", not "wrong codepage". A call accepts at most
100 paths, which bounds the metadata side of the response as well as the content.
`numbered: true` prefixes that ONE file's model copy with a padded `123: ` gutter: `content`
stays raw and `bytes` excludes the gutter, but the gutter is charged against that file's
`maxBytes` at the width the projection pads to, so a numbered window holds fewer bytes than the
same call without it and no other file in the call is affected. `bytes` reports raw content
bytes, `wireBytes` the exact serialized length, and `contentBudget` the cap this call was
subject to. `sizeBytes` is the whole file's size, or `null` when that size is not a filesystem
fact — a FIFO, a socket, a device, or a regular file whose `st_size` of 0 is contradicted by an
actual byte (`/proc`, `/sys`) — and `sizeBytes: 0 | null` is NEVER read as EOF: such a target keeps
resuming from its own `nextByte` instead of answering `ERANGE`, and a `startLine` there is settled
against a real EOF rather than answered from byte 0. `lineCount` is published only when every line
was counted to a PROVEN end, so a window that stopped mid-file carries no count at all rather than
a confident 0. For a docs writer that means one extra caution: a pseudo-file re-renders on every
read and its lines change LENGTH (`/proc/self/status`'s `State:` line is 12 characters while
sleeping and 10 while running), so a `startByte` carried over from an earlier read can land
mid-line in the next one because every later line's absolute offset moved — `startLine` +
`startColumn` is the stable axis for those targets.

A path that cannot be read is a per-entry result, not a failed call: it keeps its
ordered position with empty `content`, `bytes` 0, the empty-window range
(`endLine = startLine - 1`), and `error: { code, rawCode?, message }` — a CLOSED set of 13
per-entry codes (the published `FILE_READ_ERROR_CODES` has 14: the 14th, `ECANCELED`, is the
CALL-level cancellation answer explained below, not a fact about one file):
`ENOENT` (which names likely siblings), `EISDIR` (a directory; use `glob` or `files`, and whose
entry previews the folder), `EACCES`/`EPERM`/`ENOTDIR`/`ELOOP`/`ENAMETOOLONG` (a real denial or an
unusable path), `EBINARY`, `ERANGE`, `ESPIPE` (a positional read on a pipe, socket or device —
read it without `startByte`), `EAGAIN` (a FIFO with no writer: start the writer), `ETIMEDOUT`
(that file missed the 10 000 ms per-file I/O deadline — `FILE_READ_IO_DEADLINE_MS` — while its
siblings kept their content), and `EIO`, which now means only "this handle could not be read"; any
other errno folds into `EIO` and keeps its true name in `error.rawCode`, so a caller switches on
`code` without losing the precise reason. Every file is opened with `O_NONBLOCK` when it is a FIFO,
which is what turns the old kernel-level hang on an empty pipe into that `EAGAIN` entry — while a
cancelled call does the opposite and rejects the WHOLE call, because the signal is checked before
every syscall. That rejection carries a CODE: `ECANCELED`, the 14th member of
`FILE_READ_ERROR_CODES` and the only one that is not a fact about one file (`src/tools/files/
cancellation.ts`); used to be whatever the host's `AbortSignal` happened to carry — a `DOMException`
named `AbortError` whose `code` is the NUMBER 20, not a string errno and not a member of any set this
tool promises. The reason the host passed to `abort()` survives as `details.rawCode` (here
`'AbortError'`, because it differs from `code`) and as the rejection's `cause`, so nothing about the
cancellation is lost on the way to a CODE. Every other requested file is still read. A failed entry consumes
**no** budget, so it cannot shrink the window of a file that does exist, and a readable file
whose share of the envelope was consumed by the per-entry reserves gets the smallest window the
floor allows — ONE code point, `limit: 'budget'`, `budgetGranted: 0`, and a cursor that still
advances — rather than `EIO`.
The two off-the-end axes answer differently on purpose. A `startByte` at or past EOF is an
`ERANGE` naming the file's size, because an empty success would teach a model that the file is
shorter than it is, and that includes the offset exactly AT EOF — a byte address names a byte, and
there is none at `sizeBytes`; on the LINE axis `startLine === lineCount + 1` is legal only when the
last line is TERMINATED, because the newline is what creates the position one past it (`'a\nb\n'`
accepts `startLine: 3` as the empty window at EOF, `'a\nb'` refuses it), and every other line past
the end is `ERANGE` naming the line count; a 0-byte file answers ANY `startLine` with the empty
window and `lineCount: 0`, because a file with no lines has nothing out of range. Neither axis
clamps against `sizeBytes: null`, since a size that is not a fact ends nothing. Only a
malformed REQUEST (bad path, bad range, empty or oversized array) rejects the whole
call, before any disk access, because a broken request must not look like a
successful read.

`write` and `edit` validate **every** entry (shape, non-empty strings, no
NUL, unique target file) before the first write, and an entry that names any field outside its
own list (`path`/`content` for `write`, `path`/`oldString`/`newString`/`replaceAll` for `edit`) is
REFUSED rather than quietly dropped — a typo'd `overwrite` on the direct-call path used to mean the
caller believed it had asked for something it never got. `edit` also reads and
match-checks every file first, so one bad entry leaves every file untouched.
Uniqueness is by **real file identity**, not spelling: on Windows `notes.txt` and
`NOTES.TXT` are one file, and so is a symlink alias on any platform, so a batch that
names one file twice is rejected before anything is written (Linux keeps `a.ts` and
`A.ts` as two files). A filesystem error part-way through the write phase is reported
with the paths already completed: there is **no transaction and no rollback**. The rejection
carries machine-readable data as well as the sentence — a `code` from the tool's published set
(`FILE_WRITE_ERROR_CODES`, `FILE_EDIT_ERROR_CODES`) and `details` naming the failed path and the
completed ones.
Both tools publish through the SAME helper (`tools/files/atomic-publish.ts`,
`publishAtomically`): the payload goes into a `.tmp-` sibling created with `wx` in the directory of
the RESOLVED target, the existing file's mode is `chmod`ed onto it, and a same-directory `rename`
swaps the directory ENTRY — so a reader inside a write sees the whole previous content or the whole
new content — never a prefix — and a failure before the rename leaves the target with its previous
content and its previous mode and removes the staging file, leaving no litter. What that trade
buys, stated plainly: the target gets a NEW inode, so an already-open handle, `uid`/`gid` and
xattrs keep describing the old file (the mode travels, ownership does not), and a HARD-LINK
partner keeps the previous bytes under its own name, because the caller named one path; a read-only
FILE can now be overwritten — `edit` of a 0444 file included, which is the case the in-place write
could not open at all — because only the DIRECTORY's permissions gate the rename, the published
file still carries its 0444 mode, and a read-only directory still refuses outright; a symlink is
written THROUGH, so the link survives and the file it names is the one that changes, and a DANGLING
link is still honoured the way a live one is — its missing end is landed on, its parent created,
and the rename lands there, so the link is never replaced by a regular file; and a target that is
NOT a regular file (a directory, a FIFO, a device, a socket) is REFUSED with a code rather than
silently replaced by a regular file, because a rename would take the node with it. No `fsync` was
added, so the durability boundary on power loss is the one in-place writing already had.
Read-match-write is held as **one critical section per file** (`tools/files/lock.ts`,
keyed by that same file identity), in this process only — a second harness process or a
worker-thread lane keeps its own lock map — so a concurrent `write` and `edit` never interleave
into a torn file, and a concurrent `edit` cannot silently clobber another `edit`: the later call
sees the earlier call's text and fails with "no match". A full-content `write` deliberately never
checks what is current, so if something else changed the file first, THIS write wins and that
change is gone; that is documented last-writer-wins on a whole-file write, not an accident of the
lock. A multi-file batch takes its locks in sorted identity order, so overlapping batches cannot
deadlock. Nothing here orders a writer outside the harness — another process, a lane, or a plain
editor.

| Tool | Signatures | Result |
|---|---|---|
| `syntax` | `({ code, language: string })` — any name, validated at run time | `true` when the snippet parses and `false` when it does not. Parsers: `javascript` (a classic script, so no `import`/`export` or top-level await) and its `js` alias, `typescript`/`ts`, `tsx`, `jsx` (syntax diagnostics only — a type error still parses), `json` (strict; one leading BOM is ignored), and `python`/`py`/`python3`. Any other language is an ERROR that lists the supported set, never a verdict |
| `read` | `(paths: (string \| { path, startLine?, startColumn?, startByte?, maxLines?, maxBytes?, lossy?, numbered? })[])` — non-empty, ≤100 | `{ files, truncated, bytes, wireBytes, contentBudget, budgetPool, modelBytes, skipped, note? }`, one entry per path `{ path, content, startLine, endLine, truncated, limit, startByteAligned, nextLine, nextColumn, nextByte, bytes, sizeBytes, lineCount?, lossy?, budgetGranted?, error? }`; per-file defaults `startLine 1`, `startColumn 0`, `startByte null`, **`maxLines 2000`, `maxBytes 65536`** (the allowance is charged in escaped wire bytes while `bytes` reports raw ones), ceilings 20000 lines / 262144 bytes and an explicit value outside them refused rather than clamped; `limit` names WHICH governor cut the window (`'maxLines'` / `'maxBytes'` / `'budget'`, `null` at EOF), `budgetPool` is the part of the envelope that was actually splittable and `budgetGranted` one file's share of it (escaped-wire units, and only when that share was the smaller of it and `maxBytes`); a truncated entry's `nextByte` always advances the cursor; `sizeBytes` is `number \| null` — `null` when the size is not a filesystem fact (FIFO, socket, device, or a regular file whose `st_size === 0` a byte contradicted, e.g. `/proc`), and `0 \| null` is never EOF; `lineCount` (the `wc -l` figure) appears only once every line is counted to a proven end; a seek into a run of UTF-8 continuation bytes longer than any code point is `EBINARY` naming that offset; `note` is present only when a file of `65536` bytes or more came back cut — it names up to 2 such paths with their size, what was returned, and the exact continuation, and counts the rest; an unreadable path keeps its slot with `error: { code: 'ENOENT' \| 'EISDIR' \| 'EACCES' \| 'EPERM' \| 'EBINARY' \| 'ERANGE' \| 'EAGAIN' \| 'ENOTDIR' \| 'ELOOP' \| 'ENAMETOOLONG' \| 'ESPIPE' \| 'ETIMEDOUT' \| 'EIO', rawCode?, message }` (a CLOSED set; anything else folds to `EIO` and keeps its real name in `rawCode`; `ETIMEDOUT` is this tool's own 10 000 ms per-file I/O deadline, `EAGAIN` a FIFO with no writer, which is opened `O_NONBLOCK` precisely so it cannot hang the call, `ESPIPE` a `startByte` on a target with no file offset) and consumes no budget; only a malformed request or a cancelled call rejects the call — a cancelled one with the published `ECANCELED` (the 14th code, `src/tools/files/cancellation.ts`), the host's abort reason as `details.rawCode` and as `cause`, never with partial `files` |
| `write` | `(files: { path, content }[])` — non-empty, ≤100, and an entry naming any other field is refused | ordered `{ path, bytes, lossy? }[]`, creating parent directories; duplicate target files rejected by real file identity and NUL content rejected (the package's only reader refuses a NUL); each file is published ATOMICALLY through `tools/files/atomic-publish.ts` — a `.tmp-` sibling created `wx` next to the RESOLVED target, the existing mode carried over by `chmod`, then a same-directory rename — so a reader never sees a partial file and a failed write leaves its own target's content and mode intact with no staging litter, at the cost of a NEW inode (an open handle, a hard link, `uid`/`gid` and xattrs stay on the old file — the hard-link partner keeps the PREVIOUS bytes), an overwritable read-only FILE, and a DANGLING symlink still written THROUGH (its missing end is created and the link survives); a target that is not a regular file is REFUSED with a code (`EISDIR`, `EOPNOTSUPP`) instead of replaced by one, and no `fsync` was added; an unpaired surrogate in the content becomes U+FFFD on disk, permanently and invisibly on re-read, so that entry says `lossy: true`; serialized per file against a concurrent `edit` IN THIS PROCESS ONLY (another harness process or a worker-thread lane keeps its own locks), and a `write` never checks what is current, so a concurrent external writer's change is replaced by this write; a cancelled call is refused with the published `ECANCELED` (`src/tools/files/cancellation.ts`) — before anything is written, and at the next file when the abort arrives mid-batch, with `details.completedPaths` naming what already landed and no rollback |
| `edit` | `(edits: { path, oldString, newString, replaceAll? }[])` — non-empty, ≤100, and an entry naming any other field is refused | ordered `{ path, replacements, bytes, match?, changed? }[]`; `oldString` must be unique unless `replaceAll`; exact-first matching with `'typographic'` and `'trailing-whitespace'` fallbacks — that second tier matches WHOLE LINES, so the lines it replaces lose their trailing whitespace with them — and `match` appears only when a fallback tier was used (there is no ending-related value); an LF-only `newString` adopts the endings of the matched region, a `newString` containing `\r` is written verbatim byte for byte, and endings are converted with a pair differing only in `\r`; a non-UTF-8 or NUL target is refused with `EBINARY` naming the byte offset, before anything is written, and a target over the exported `FILE_EDIT_MAX_BYTES` (8 MiB) is refused with `EFBIG` before it is read; `oldString === newString` is a CHECK rather than a mistake — it still has to match uniquely and reports `changed: false` without republishing the file — and an EMPTY `oldString` is accepted only against an EMPTY file, where it inserts, and is refused against a file that has text; every edit is preflighted and each file that changed is published once, through the same staged+rename publish as `write` (a `.tmp-` sibling, the mode carried, then a rename), so the INODE CHANGES, a hard-link partner keeps the previous bytes, an existing 0444 file is editable because only the directory gates the rename, a symlink's TARGET is updated rather than the link replaced, and a non-regular target is refused with a code; read-match-write is one per-file critical section IN THIS PROCESS ONLY, and a writer outside that lock — another harness process, a lane, an editor — simply wins; a cancelled call is refused with the published `ECANCELED` (`src/tools/files/cancellation.ts`), before the first read and before each further entry of the batch, naming the file it stopped on and `details.completedPaths`; a file that was already edited stays edited (no rollback) |
| `files` | `(ops: ({ op: 'list' \| 'move' \| 'copy' \| 'delete' \| 'mkdir', path? \| from+to, overwrite?, replaceDirectory?, recursive?, force?, offset?, limit? })[])` — non-empty, ≤100, and an op naming a field another op owns is refused by name | `{ results, bytes, contentBudget }` with ONE ordered receipt per operation: `list` gives `{ path, entries, truncated, nextOffset, offset, limit, bytes, starved?, note?, error? }` — 200 entries by default with `limit` clamped into 1..1000 and `offset` to ≥0 rather than rejected, one 64 KiB entry-text budget shared by every list op in the CALL (an op that arrives to a spent budget answers `entries: []`, `truncated: true` and `nextOffset` at its own offset, and says so additively with `starved: true` plus a `note` naming the op that spent the allowance; `nextOffset` is `null` when nothing was withheld), a directory named twice or aliased walked once, and one unreadable directory becoming that receipt's own `error` while the entries it could read survive — the same `note` also explains a page stranded by one long name that no longer fits, or an `offset` past the end of the listing; `move`/`copy` give `{ path, to, kind, bytes, replaced? }`, where `kind` describes the DESTINATION after the operation (`file`/`directory`/`symlink` — a moved link stays a link and reports 0 bytes), `overwrite` permits removing the NAME at `to`, and replacing a destination DIRECTORY TREE additionally needs `replaceDirectory: true` (a file taking a directory name, or a directory replacing a NOT-EMPTY one; the refusal counts the entries at stake and changes nothing, while an empty destination directory and a symlink destination need only `overwrite`), whatever the removal destroyed is reported as `replaced: { path, kind, entries }`, and a destination that is the source or lies inside it is REFUSED BEFORE any filesystem change (symlinked aliases resolved by real identity); a cross-device `move` reports `EXDEV` with the remedy — `copy`, then `delete` — rather than copying behind the caller's back, `delete` gives `{ path, removed, recursive }` and refuses a NON-EMPTY directory without `recursive` (an empty entry is removed with `rmdir` for a real directory and `unlink` for a symlink — never a widening recursive `rm`, so an entry that appears mid-flight surfaces as `ENOTEMPTY` instead of a silent tree deletion — and a dangling symlink needs no such permission; `force` reports a missing path as a no-op), `mkdir` gives `{ path, created }`; mutations hold the per-file locks only for the NAMED `path`/`from`/`to`, not for the subtrees a recursive delete or a directory copy walks; a failed mutation rejects the call naming the operations already applied and what this op left behind (no rollback), carrying `code` plus `details` (`op`, `path`, `applied`, `appliedCount`, `rollback: false`, and the failing op's own `failure`), while a failing list entry is per-entry `error: { code: 'ENOENT' \| 'ENOTDIR' \| 'EACCES' \| 'EPERM' \| 'EIO' \| 'EXDEV', rawCode?, message }` — a closed set, every other errno folded onto `EIO` with its true name in `rawCode`, and the message naming code and path once; a cancelled call rejects the same way with the published `ECANCELED` (`src/tools/files/cancellation.ts`), naming the operation it stopped on and the ops already applied — the signal is checked before EVERY op, list ops included, so a cancelled `list` rejects the call rather than answering an entry `error` |
| `glob` | `({ patterns?, paths?, maxResults?, offset? })` | `{ files, truncated, offset, limit, nextOffset \| null, bytes, contentBudget, stopReason, partial, searched, excluded, patterns, note? }` — NAMES only; `maxResults` defaults to **100 and is clamped to 1-1000** (the effective cap is echoed as `limit`), and a page also stops before the entry that would cross the 64 KiB path-text budget; there is no `content` property any more |
| `grep` | `({ pattern, patterns?, paths?, maxResults?, offset?, output?, context? })` | `{ matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget, offset, limit, nextOffset?, partial?, stopReason }`; `maxResults` defaults to **100 and is clamped to 1-1000**, alongside a 64 KiB match-text budget, and matching is time-bounded |
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

Every preset is tagged. The five core file tools are always declared, so a model
reads/writes/edits/lists names with `glob` and finds text with `grep` directly. `download`
is `visibility: 'searchable'` (`src/tools/webdownload/download.tool.ts:566`), so a library
model opens it with `toolRequest` — and a session the server creates starts with it already
enabled by the seed (subject to the cap and the deny list), which is where "pulls a real
file with `download` without a discovery round" is true there (`enableAllTools`, see
[Tool discovery](#tool-discovery)).
`files` is found with `files`/`list`/`move`/`rename`/`copy`/`delete`/`mkdir`; a shell
with `shell`, git with `git`, syntax checks with `javascript`/`typescript`/`json`/`python`,
and `fetch` with `web`/`fetch`/`url`/`read`/`research` when the harness opted into
`webfetch`. Those
searchable tools stay out of the context window until something enables them:
`toolRequest` in a library harness, or the new-session seed the server applies to a
conversation it creates (`enableAllTools`, see
[Tool discovery](#tool-discovery)) — which is what makes a fresh server session's
`download` or `shell` call need no discovery round, as long as `maxEnabledTools` admits
the name.

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
enough for any of those entry points, and no UI field or `RunnerSettings` value
carries a search key. Every shipped harness (`general`, `instruct`, `research`,
`workspace`, `reviewer`, `planner`, `debugger`) is built from one shared factory and
shares one toolbox, so a key makes web search available to all of them or to none.
There is no endpoint-free preset left to exempt: the scripted `demo` and the `flaky`
example are deleted, so every card requires a provider.

**Catalogue visibility (server and UI).** The harness app always lists
`search` in its direct-call catalogue, configured or not. With a key it is a
normal callable entry (`POST /v1/harness/tools/search/executions`); without one the entry is
marked `unconfigured`, carries the provider variable *names* and a non-secret hint,
and a direct call answers a normal `{ "ok": false }` tool failure explaining what
to set and that a restart is required. The catalogue is built when the server
starts — after `.env` loading, never at module import — and each descriptor may
carry `availability: { state, environment, hint }`. Key values never appear in a
descriptor, hint, CLI listing, or UI.

The same rule applies to preset descriptors (`GET /harnesses`, the `/presets`
alias, and the canonical bootstrap document). Every shared-toolbox preset
(`general`, `instruct`, `research`, `workspace`, `reviewer`, `planner`, `debugger`)
declares `environmentTools: ['search', 'fetch']`, which the
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
// -> { provider: 'native', url, contentType, format: 'markdown', characters, truncated, content,
//      pageCharacters, offset, nextOffset?, title? }

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
| Native response body | **1 MiB** (1,048,576 bytes) — declared `content-length` first (the body is cancelled before a byte is read), then counted per streamed chunk. It is a **transfer** budget, not a content budget: the old 100 KiB was refusing pages whose raw HTML merely weighed more than their converted text needed |
| Returned content | 240,000 characters across the whole page (`truncated: true` while more of the page exists) |
| One serialized result | **64 KiB** — the tool keeps its own result inside the harness's model-facing budget instead of being re-wrapped by a generic envelope that would drop `url`/`title`/`truncated`/`nextOffset`, so the content slice is capped at 64 KiB minus a 2,048-byte object allowance. Paging keys ride along: `pageCharacters` is the page's real character count, `offset` echoes where this window started (an out-of-range request is clamped and reports `offsetClamped` plus a `note`), and `nextOffset` is present **only when `truncated`** — pass it back as `offset` to read on. They count CHARACTERS, not bytes, and only within one `format` |
| A `query` answer that came back short | `stopReason` names which bound closed it, because the two need opposite responses. `"contentBudget"` = the 64 KiB result budget cut the answer and `nextOffset` is where it resumes — re-fetch at that offset **without** `query`, since `offset` is ignored while `query` is set; `"resultCap"` = the 20-section cap withheld matching sections (`totalMatches` > `matches`), which paging cannot reach, so narrowing the query is the fix. `query` results report no `offset` at all: selection runs on the whole converted page. Matching sections are ordered by hits per character before the cap is applied, so a long section can no longer buy a slot with its length. Absent when nothing was withheld |
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
  `POST /v1/harness/tools/download/executions` answer, carry `ToolMediaDescriptor[]` (id, kind,
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
    entry: 'writer',                            // routing ONLY (first key is the default)
    ranks: { writer: 'A', researcher: 'B' },    // authority; any number of agents may share a rank
    tools: { search: tool({...}) },
    report: { progress: async (event) => {} }
});
```

| Field | Meaning |
|---|---|
| `agents` | Every brain, keyed by name. **The first key is a DEFAULT, nothing more** — it is the fallback `entry` and the order every per-member read returns. Order says nothing about authority; that is `ranks`. |
| `entry` | Which agent the callable runs (`HarnessConfiguration.entry`, `src/types/index.ts:4710-4718`). Optional; must name a registered agent, or construction throws `Entry agent "zzz" is not registered. Configured agents: …`; defaults to the first `agents` key. ROUTING ONLY: it grants NO capability and it is not a rank — the entry agent may hold Rank A or Rank C, and an entry that cannot delegate is a normal configuration. Use it in multi-agent configs so routing is explicit. A legacy `primary` (or `subagents`) key here is REFUSED at construction, not translated: this build routes with `entry` and ranks with `ranks`, and silently dropping `primary` would move routing to the first `agents` key AND — with `ranks` absent — put Rank A on that same first agent, so a stale document would resume as a different team with a different authority. |
| `ranks` | Authority map: agent name → `AgentRank` (`'A'`…`'Z'`, `src/types/index.ts:1469`), where a LARGER letter is a LOWER authority and **any number of agents may share one rank** (two Rank A agents are ordinary peers). Optional, and it may cover fewer agents than the roster: an omitted map ranks the ENTRY agent at `'A'` and every other agent at `'B'` (the direct successor of the old `primary`/`subagents` pair), a stated map fills every agent it omits — the entry agent included — ONE RANK BELOW the lowest rank it names, and `ranks: {}` states "no ranking", which puts every agent on one letter and registers no `delegate` at all. An unknown name or a bad letter throws at construction naming the exact site. Delegation targets, the nesting ceiling and the `toolCreation` ceiling all derive from these letters — nothing else. |
| `maxIterations` | OPTIONAL runaway guard: model requests one agent run may make before the harness throws. Every request counts: the first answer, each immediate tool continuation, a pause turn, and every completion or timed wake. **Unset by default = no limit**, and `Infinity` states that explicitly; a finite value must be a positive safe integer (validated at construction). The app presets set no limit either. |
| `forks` | `{ enabled?, maxDepth?, maxConcurrent?, maxHistoryBytes?, maxBranchRecords? }`. `enabled` defaults **true** and registers the core `threadFork` tool. Defaults: depth 2, 4 live branches, 8 MiB serialized branch history, 64 retained records; every numeric bound must be a positive safe integer. |
| `interaction` | `{ actionRequest?: (context, signal) => Promise<HarnessActionChoice>, autoAnswer? }`. Presence registers the core `actionRequest` tool. `autoAnswer` defaults true and only governs a child/fork request's automatic owner fork; it never selects an option by itself. |
| `tools` | Extra tools, keyed by the name the model calls. A configured tool replaces a preloaded preset of the same name. |
| `toolSources` | Map of wire name → editable source path. Registered after the baseline/presets and before `tools`; each revision is inspectable through `toolSource()`/`toolSources()`. |
| `toolFolders` | Ordered external folders scanned recursively for `*.tool.ts` modules. Absolute or cwd-relative; later folders win name collisions; invalid folders/modules fail construction. Folder code is trusted code with process permissions. |
| `maxEnabledTools` | Maximum number of SEARCHABLE tools enabled at once (default **32**). Core tools never count. This is the persistent enabled-set bound, not a per-query match cap; `toolRequest` reports the full union in `matched` and what the bound withheld in `omitted`. |
| `enableAllTools` | Seed the enabled set at construction: one `enableTools` pass over every registered name THIS harness can give a cap slot (live, not `visibility: 'core'`, not pending-only), minus the names the host's global tool provider denies (`toolSettings`) and minus the names THIS conversation has switched off (`withheldTools` — an auto-enable never overwrites a user's decision), so a brand-new instance starts with the capped toolbox enabled instead of waiting for a `toolRequest` match (`src/harness.ts` `seedSwitchableTools`). **Off unless exactly `true`**; the cap above still binds, and an over-cap catalogue keeps the first names in registration order and leaves the rest off — never a throw. Not snapshot state, so a restore keeps the set it committed (`restore()` replaces the enabled set from the persisted `discovery.enabled`, `src/harness.ts` `restore()`; one honest exception: an enabled name THIS build no longer registers is pruned on restore rather than losing the conversation, and a switched-off name this build does not register is pruned off `discovery.withheld` by the same function — `src/server/sessions.ts` `pruneStaleEnabledTools`), and the kernel's `reset()` empties it and clears the conversation's withheld set with it. The shipped server passes it on both of its build paths — every session it creates (`SessionStore.create` → `buildHarness(…, { enableAllTools: true })`) and every session it restores (`SessionStore.restoreSession`, the same call) — and a session RESET re-runs the same pass (`src/server/sessions.ts` `SessionStore.reset`, through `harness.enableAllSwitchableTools()`), because a reset starts a new conversation and must not look like the empty toolbox this flag exists to remove. The restore path asks for the flag so that re-run survives a restart (the seam reads this per-process configuration); it does not make a restart refill, because the restore above overwrites the seed. |
| `maxCreatedTools` | Lifetime budget for `toolCreate` / `toolRegistry` **in this harness instance** (default **32**, `unlimited` disables it). It is not a process-wide guard: a replacement that removes a name frees no slot, and N harnesses each hold their own budget. A host that builds one harness per conversation therefore pays the construction cost per conversation and gets N independent budgets — see [External tool folders](#external-tool-folders-and-toolts) for the shared-source shape. |
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
| `writer(input)` | Run the entry agent to completion. Resolves with its message. Once the agent `entry` names has been detached by `removeAgent`, the call REFUSES rather than re-routing onto another brain. |
| `writer.name` | The EFFECTIVE entry agent's name — the agent `entry` names while it is registered, else the first still-registered member (so `removeAgent(entry)` never leaves the handle naming a detached agent). |
| `writer.agent` | The EFFECTIVE entry agent, resolved by the same rule as `writer.name`. `writer.agent.messages` is the live transcript. |
| `writer.agents` | Every agent, including the entry one. |
| `writer.ranks` | The RESOLVED rank map (agent name → rank letter, `Harness.ranks`, `src/types/index.ts:5017`). A GETTER over the live roster, so `addAgent`/`removeAgent` move it, and each read hands out a frozen defensive copy (`ranksView`, `src/harness.ts:1720`, mounted at `:17211`) — a caller can neither mutate the ranking nor cache a copy its way into a promotion. This replaces the removed `writer.subagents` allowlist: who may delegate to whom follows from these letters and nothing else. |
| `writer.tools` | Every registered tool, keyed by wire name: the preset/app catalogue plus the harness-owned set (`toolRequest`, `toolList`, `toolManage`, `toolCreate`, `tasks`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `delegate` when it exists, `threadFork` when forks are enabled, and `actionRequest` when interaction is configured). Registration is not declaration: `tool.visibility` and the enabled set — `toolRequest`, `toolManage`, or an `enableAllTools` seed — say which half a name is in. |
| `writer.discoveredTools` | Names in the CAPPED enabled set, in discovery order: what `toolRequest` has enabled plus what an `enableAllTools` seed put there. A name this conversation switched off is not in it, and neither is a core or pending-only name — those never hold a slot, so this list says nothing about them. Read-only copy; `reset()` empties it (the shipped server re-runs the seed after ITS reset — `SessionStore.reset`). |
| `writer.withheldTools` | THE CONVERSATION'S SWITCHES: the sorted, copied names this harness's user has switched OFF for its agents (`src/types/index.ts` `Harness.withheldTools` → `src/harness.ts`), and the only place a core or pending-only name's switch exists at all. A getter that copies, so a caller cannot mutate the live Set. It is INDEPENDENT of `discoveredTools` by construction (`applyToolSwitch` frees a searchable name's slot in the same step), cleared by `reset()`, and persisted as the snapshot's additive `discovery.withheld`. What it does NOT gate: `executeTool` (the manual/REST executions) and `context.callTool` (a tool calling a tool) reach a registered name whatever this list says. |
| `writer.isToolSwitchable(name)` | Whether THIS harness gives that name a SEARCHABLE CAP SLOT (`src/harness.ts` `occupiesSearchableSlot`) — which names an enable spends one of the `maxEnabledTools` slots on, and which an over-cap selection can evict. CORRECTED IN PLACE: this row used to call it the kernel's yes/no on "may a caller switch this name at all", and the fact behind a session-tool row's `protected` figure. Neither holds since the withheld set: `toolManage`'s `enable`/`disable`, the plugin seam and the operator's PATCH accept EVERY registered name (`src/harness.ts` `requireSwitchableTool` refuses only a blank or an unregistered one), so `false` here means only "no cap slot" — an unregistered name, a `visibility: 'core'` declaration, or a pending-only control such as `toolCancel` (registered as `'searchable'`, still pending-only). Read at call time: a tool registered after construction holds a slot the moment it exists, and a removed one does not. `protected` is now the UNREGISTER axis (`visibility === 'core'`, the kernel's `remove` rule), so `toolCancel` is `protected: false` on BOTH reads while `write` is `false` here and `true` there; a pane that wants "is this name off for the agents" reads `withheldTools`, not either of those (`src/server/api-reads.ts` `sessionToolRowsOf`). |
| `writer.enableAllSwitchableTools()` | OPTIONAL host seam (`src/types/index.ts` `Harness.enableAllSwitchableTools` → `src/harness.ts`): re-runs the `enableAllTools` pass on a LIVE harness — every registered name that can hold a cap slot, minus the deployment's deny list AND minus the names this conversation has switched off, capped in registration order. `reset()` empties the set and the construction seed is not snapshot state, so this is the only way a host whose "new conversation" is a RESET gives one the toolbox a fresh CREATE gets; looping `toolManage enable` per name is not equivalent, because an explicit enable inserts newest-first and keeps a different set once the cap binds. Reports one `state_change` when the set moves, nothing when it does not. |
| `writer.toolCreate(config)` | Host-side runtime creation. Same validation/registry/budget as the model's `toolCreate`; throws `HarnessError`. |
| `writer.executeTool(name, parameters)` | Run one registered tool directly, with this harness's context (`agent`, `agents`, `run`). The server's manual-execution path: discovery gates the model, not the operator, so an un-discovered searchable tool still runs. THE CALLER IS THE HOST ACTOR (`agent: hostActor()`, `src/harness.ts:16361`) — the session's ENTRY agent while that agent is registered, and the unregistered Rank A identity named `host` once `removeAgent` detaches it (`hostActor` `:1669`, `hostRank` `:1637`) — so the rank doors behave exactly as they do for that actor: `delegate` is judged at that standing (refused when it holds no strictly-lower-ranked target) and `toolCreate` at the `toolCreation` ceiling; there is no role gate left to keep. `writer.toolCreate()` is the separate HOST path and is never rank-gated (`:16975`). An unregistered name throws, and `actionRequest`/`threadFork` are refused because they need the owning run. |
| `writer.commands` | The registered slash commands, keyed by name **without** the leading slash (`commands.help` answers `/help`). Every read is a frozen defensive copy of the live registry, so a command registered later shows up in the next read — and mutating the copy changes nothing. |
| `writer.executeCommand(input)` | Run one slash line (`'/task add "testing"'`) in THIS process. The model is never called and no progress event is emitted; a built-in that calls a tool still fires `stateChange('tool_execute')`, so a persistence layer sees the mutation. Throws `HarnessError` for a line without a leading `/` or an unknown name, and rethrows what a host command throws; every recoverable failure comes back as `{ content, isError: true }`. See [Slash commands](#slash-commands). |
| `writer.registerCommand(command)` | Register or **replace** one command at runtime, with `registerTool`'s replace semantics. Validates the name and the definition and throws `HarnessError` without touching the registry when either is invalid. |
| `writer.branches()` | Detached copies of retained branch audit records (`HarnessBranchRecord[]`), newest terminal records within `maxBranchRecords`; active records are never evicted. Ephemeral: not part of the snapshot. |
| `writer.branch(id)` | One detached branch record by id, or `undefined`. |
| `writer.reset()` | Reset the entry agent's conversation, forget discovered tools, and clear `tasks`, `profiles`, `chapters`, `locations`, and the `agentManage`/`agentResult` registry. Created tools stay registered but are no longer enabled. Branch records and pending questions are ephemeral runtime state and are **not** cleared here. The KERNEL leaves the enabled set empty; the shipped server's session reset immediately re-runs the `enableAllTools` pass on top of it (`SessionStore.reset`), so a reset conversation starts with the toolbox a new one gets instead of the empty pane this used to produce. |
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
only a new harness starts the count again. `toolCreation` configures the capability
(`ToolCreationPolicy`, `src/types/index.ts:1556`): `'all'` (the default — `toolCreate` is
declared to EVERY agent), a rank LETTER — that rank and every rank TOWARD `'A'` may create, so
`'A'` is the faithful replacement for the removed `'primary'` policy and `'C'` admits A, B and C
(`holdsCreationRank`, `src/harness.ts:1264`) — or `false` (no model-facing tool at all; the host
methods `harness.toolCreate()` / `harness.createTool()` still work). A stated letter withholds the
DECLARATION from the agents below it AND refuses a guessed call with an error naming the caller's
rank, e.g. `Tool creation is limited to Rank A and above in this harness; "helper" holds Rank B.`
(`createToolForAgent`, `src/harness.ts:4213-4230`). A bad value fails construction
(`resolveToolCreation`, `:1246-1257`): the refusal spells all 26 letters —
`toolCreation must be "all", false, or a rank letter (A, B, C, …, Z). Received primary.` —
and the lifetime budget applies whichever way the gate goes.

**The budget is per instance, and so is the construction cost.** The counter belongs to
ONE harness, so N harnesses hold N independent budgets and nothing in the library bounds
how many user tools exist process-wide. That is deliberate: a process-global registry (or
a thread-local one, or a host-side counter standing in for either) would have to survive
`snapshot()`/`restore()` per harness, and sharing the registry is exactly what breaks
the isolation those two give each conversation. The number's job is to stop ONE runaway
session growing its own registry, which it does — `reset()` does not restore it, and
removing a name does not free a slot.

What actually costs on a host that builds one harness per conversation is CONSTRUCTION,
not the budget: each instance re-runs the AST descriptor scan over the tool tree (nothing
is cached across calls, `src/tools/descriptors.ts`), wires the `presets: true`
catalogue, scans every `toolFolders` root and compiles each `*.tool.ts` revision it
finds, then registers `toolSources` and `tools`. For a per-conversation sandbox that is
usually the point — a fresh registry, a fresh budget, no shared state. A host that instead
wants ONE reviewed catalogue shared across many conversations keeps the source in a
configured folder, or compiles it once with `compileToolSourceModule` and passes the
compiled `definition` beside the bytes it came from —
`tools: { name: { tool: compiled.definition, source: compiled.record } }`. Either
way those tools are catalogue state: they arrive with every instance, and none of them
ever spends `maxCreatedTools`. `toolSource(name)` still reports the revision, because the
source travels with the entry.

**No sandbox.** A created tool is compiled with the host realm's `Function`
constructor and runs with the process's full permissions — the same trust model as
`shell`. There is no isolation, no allowlist, and no network/filesystem fence.

### Delegation

```ts
const team = harness({
    agents: { lead: agent({...}), tester: agent({...}), reviewer: agent({...}) },
    entry: 'lead',                                    // routing only, never an authority claim
    ranks: { lead: 'A', tester: 'B', reviewer: 'B' }, // authority: delegation runs downward
    report: { progress: console.log }
});

await team('Add a parser and have it reviewed.');
```

Each agent keeps its own `instruction`(s) and transcript; a delegated agent never sees the
caller's conversation, and only its final `content` comes back. The `delegate` tool is
`{ agent, input }`, and it is registered exactly when the rank map spans TWO OR MORE DISTINCT
letters — a one-agent harness, an all-Rank-A roster, and a roster whose members all share one
letter hold no `delegate` at all (the tool is never registered, so the model is never offered
it). Delegation is **strictly downward**: an agent may hand work only to a registered agent
ranked strictly below it, so a same-rank peer AND any superior are refused, by a sentence that
names the caller's rank and its legal targets rather than an unnamed privilege —
`lead holds Rank A and cannot delegate to "co" (Rank A): delegation is strictly downward. The
legal targets are Rank B and below: helper.` The DECLARATION is projected per caller, so a Rank
B agent is never shown a tool it cannot use, while the `agent` enum deliberately stays the whole
roster: a wrong guess then reaches that rank sentence instead of a schema error that cannot name
a rank. Depth follows from the same letters — a chain of runs visits strictly DESCENDING ranks,
so it can never be longer than the number of ranks that exist (`A`/`B`/`C` configured makes A→B→C
legal at three levels); the old hard-coded "one level deep" was that rule for the single roster
shape the removed vocabulary could express. `run()` still refuses to re-enter an agent that is
already running, so a cycle keeps its own, earlier refusal
(`Agent "x" is already running; it cannot be re-entered (delegation cycle).`). A tool can still
call `ctx.run(name, input)` directly when it needs a
sibling turn mid-tool, but that path is inside one agent's turn rather than
model-visible delegation. Under `threadExecution: "worker"` a lane refuses it — the
child a tool body starts would exist only inside that lane; see
[Per-thread CPU isolation](#per-thread-cpu-isolation-threadexecution-worker).

Two controls shape a child without changing that rule. **Time:** a delegated child has
no wall-clock limit — `timeoutMs` is an optional bound the caller sets when it wants
one (see [The loop](#the-loop)), and a child that is still running is abandoned with
`toolCancel` on the `callId` its pending placeholder names — abandoning it does not discard
the outcome: the child's terminal envelope is still delivered, as that call's own tool
message, marked `callCancelled: true` to say that YOU released the call, while the
`toolCancel` result itself stays an acknowledgement. **Scope:**
`scope: { tools: [...] }` is a hard allowlist the child neither sees nor calls outside
of — with one door that can never be locked, `toolRequest`, so a restricted child can
always report the capability it is missing instead of looping on what it has. Enabling
a tool through discovery is not the same as being scoped to it: a tool the allowlist
omits is still refused at launch, with the refusal as a readable result.

What that means for the shipped roles:

- **A rank delegates; a same-rank or junior peer never delegates upward.** The six teamed
  cards each hold their own entry agent at Rank A and every other member at Rank B, so each
  shipped team has exactly one delegator — and that is a CONSEQUENCE of the letters, not a rule
  the runtime enforces by role. Drop the `summarizer` (or `workspace`, or `reviewer`) from a
  Manager's roster and that step has no target left: the Rank B members have no strictly-lower
  peer to hand it to, and a Manager whose roster is down to itself spans ONE rank, so the
  harness registers no `delegate` at all — which is exactly the case its profile tells it to
  stop and report instead of quietly doing the work. Configure `A`/`B`/`C` and the same card
  gains a three-level chain with no other change; put two members at Rank A and each may
  delegate to the Rank B members, because a rank is a rung, not a person.
- **Briefs must be self-contained.** A delegated agent starts from its own instruction and
  the `input` you give it, nothing else, so the delegator must include the goal, the
  paths/areas, the constraints, and the evidence it wants back.
- **Verification is the delegator's job.** A delegate result is a claim: the shipped
  profiles tell the delegating agent to check it (read the file, run the check, or send the
  Reviewer) before answering. The Manager goes further and is required to send every
  step's result to `reviewer` for an INDEPENDENT check before accepting it, because
  the agent that produced a result is not allowed to be the one that judges it.
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
    declare                -> core tools + everything the enabled set carries
                             (what toolRequest enabled, or the enableAllTools seed)
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
below while async work is pending, steering input, or the run's abort) releases it, and
the loop re-reads real state after waking. This changes four things a caller must know:

- **A sync batch is one turn.** A message whose calls are all `sync` produces no
  intermediate request: the follow-up turn is built after the last one settled, so
  the model sees every result of the batch at its original call position. `shell`,
  `delegate` and `threadFork` are `async`, so they keep the per-completion wake
  below. `actionRequest` is `sync`: the question is directed at the owner, so a
  message of questions costs one turn after the LAST answer, and a run that owns an
  unsettled question issues no request at all until the answer, a `toolCancel` or an
  expiry releases the hold.
- **The top-level promise is the drain point.** `await writer(input)` resolves only
  when the entry agent's response is complete AND every pending call — delegated
  child runs included — has finished. A per-agent `done` event is one response, not
  terminal session work: it can arrive while that agent's own calls are still
  running (listed in the event's `pending`), and the agent is woken when outcomes
  land (`wakeup`, or once its message's sync group drains).
- **A periodic wake keeps a turn honest — for `async` work only.** While an **`async`**
  call is pending the runtime also wakes the agent on a timer (default **600000 ms**), so
  a hung background call stays visible and can be killed instead of blocking forever. A
  board whose outstanding calls are ALL `sync` is **not** woken on that timer: a sync
  group already re-enters the model the moment its last member settles, so a timed wake
  there would buy nothing but a `status:'pending'` placeholder turn. The mode a call
  RESOLVES TO is what counts, so a mixed board (one `async` plus one `sync`) still pings
  — that async completion is what releases the parked gate — and a heartbeat armed for an
  async call stops the moment only sync work is left. The rule lives in the `async-ping`
  plugin, not in the loop, and `harness({ wakeIntervalMs })` (or that plugin's
  `intervalMs` setting) sets the cadence.
  - **The trade-off this makes.** There is **no automatic hard tool timeout**: pending
    calls are interrupted, not resumed, on restart, and a hanging call ends only through
    an explicit cancel (or the tool's own configured timeout). For a run parked on `sync`
    work alone, the agent's own chance to notice and `toolCancel` is now whatever the
    caller supplies: steering input, a thread stop, or aborting the run's `signal` — all
    three release the park, and the turn they buy can call `toolCancel`. A `read`/`edit`/
    `fetch`/`sleep` call wedged with no bound of its own therefore stays parked until the
    host acts; `shell` (`timeoutMs`), `fetch` and `delegate` (`timeoutMs`) carry their
    own bound and are unaffected. Recorded with its evidence in
    [`docs/tasks/2026-11-19-heartbeat-async-only.md`](./docs/tasks/2026-11-19-heartbeat-async-only.md).
  - **A THREAD has no wall-clock limit either (policy 2026-11-09).** A conversation —
    a delegated child, a `threadFork` branch, a host thread, a steered turn — stops
    when its agent gives its final answer, and nothing external ends it on a clock.
    `delegate`'s `timeoutMs` is an **optional, caller-set** bound with **no limit as
    its default**: pass one (a model may ask for 1..3600000 ms) when you believe a
    limit is warranted, and the child that hits it comes back as the structured
    `status: "cancelled"` result with `partialContent` and `cancelledAtMessage`.
    CORRECTED IN PLACE: the default used to be a finite **300000 ms (5 minutes)**;
    the mechanism stays, the finite default does not. What still ends a long run is a
    tool's own timeout, the optional `maxIterations` **request count** (unset by
    default = no limit — a count bound a host opts into, deliberately untouched by a
    policy about time), the run-depth and
    record caps, `toolCancel`, and — ADDED 2026-11-09 when the plugin-pipeline
    user-facing lists landed — an explicit **`stop` decision** from a `turn.before`
    plugin ([`docs/plugins.md`](./docs/plugins.md)): a policy assertion made by code
    the application shipped, at a boundary the run is already parked at, not a clock
    — nothing expires — and it takes the run's own abort path (the conversation
    records `stopped`, the invocation records `cancelled`, and everything the run
    appended is rolled back). A child that is stuck is abandoned by naming its
    pending `callId` to `toolCancel`; the placeholder the model receives while the
    child runs says so, and abandoning it that way does not discard its outcome — the
    child's terminal envelope still arrives as that call's own tool message, marked
    `callCancelled: true`. And because a thread is unbounded, a stopped conversation is
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
  The other blocking cost a server pays is its own durability — the checkpoint's shard
  commits and the per-event journal lines — and `HARNESS_IO_EXECUTION=worker` moves
  that write side onto one IO worker thread per database root; see
  [Off-loop durability](#off-loop-durability-ioexecution-worker).

Cancellation follows the same model. A run's signal (and `toolCancel({ callId })`
for one call) reaches every running tool; `shell` honours it and kills its
process tree. The four filesystem tools honour it too and answer with the published
`ECANCELED` (`src/tools/files/cancellation.ts`): `read` checks it before every syscall, `write` and
`edit` before each file (the write check is inside the shared publish), `files` before every
operation, `list` included, which is why a cancelled `list` rejects the call instead of answering an
entry `error`. `toolCancel` logically settles/aborts that call's own task: its late
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

Delegation is the same mechanism: a `delegate` call stays **pending** until
the child fully completes, and the parent's `pending` list names it. A second
delegation to the same agent does NOT continue the first child's conversation:
from a thread-backed conversation (a server session, any `createThread` host thread)
each delegation MINTS ITS OWN child conversation, so a re-`delegate` starts fresh and
remembers nothing — the follow-up door is `threadSend` into the `threadId` the envelope
returned, and `threadRead` is how you re-read the answer. Only a delegation issued from
an agent's own DEFAULT conversation runs in that agent's standing
`agent:<name>` conversation, which is the one case where a second call does continue
the first transcript. Abandoning an in-flight call with `toolCancel` answers the ACK
immediately (`{ cancelled: true, callId, name }`) and puts the child's terminal envelope
in the call's own tool message — `status`, the harness's own `error` sentence,
`partialContent`, `cancelledAtMessage`, the identity fields, and `callCancelled: true` —
so the recovery the description recommends is not the path that loses the result.

Failures split in two:

- **Recoverable** — unknown tool, undiscovered tool, malformed JSON arguments, or a
  throwing tool. Each becomes a tool result the model sees, so it can correct
  itself.
- **Terminal** — a transport failure, or more than `maxIterations` model requests
  when a host has opted into that OPTIONAL guard (unset by default = no limit; the
  bundled live presets leave it unset). History is truncated back to
  where the call started and the harness throws, so a failed call is never
  replayed on the next attempt.

`maxIterations` is per agent run — a delegated child gets its own budget — and
is validated when `harness()` is called: a value that is neither a positive safe
integer nor `Infinity` throws `HarnessError` immediately instead of failing mid-run.

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
POST /v1/harness/sessions/:id/actions/:requestId/answer
{ "choice": { "kind": "option", "option_id": "core" } }  // or { kind: 'custom', text }
-> 200 { "ok": true, "request_id": "…", "resolved_at": 1762000000000 }
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
- **Inheritance and bounds.** Ordinary forks inherit the source agent's RANK and
  therefore its rank-projected declarations (a fork of a Rank A agent still holds
  `delegate`, narrowed to its own legal targets; a fork of a Rank B member has no
  strictly-lower-ranked peer to hand work to). Rank is PROPAGATED to every derived actor
  (`actorRanks.set`, `src/harness.ts:1588`), never re-derived, which is why a fork obeys the
  same nesting ceiling as its source and may itself fork. Forks may nest to `maxDepth` 2, with 4 live
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
  **not** part of the snapshot at all: a restart does not restore them.
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
        baseURL: 'http://localhost:8800/providers/private/v1',
        apiKey: () => rotateKey(),          // resolved per request
        headers: { 'x-title': 'writer' },
        sampling: { temperature: 0.8 }
    }
});
```

Tool calls are streamed by providers as indexed fragments with partial JSON
arguments. The transport accumulates them and reports complete calls on the
terminal frame — partial arguments are not executable.

#### What is on the wire

An unconfigured request body is exactly `{ model, stream: true, messages,
tools?, ...sampling }`, and that stays true byte-for-byte when none of the three
seams below is used. `stream_options` is not sent **by default** — several
gateways reject unknown request fields, so a default would break working
deployments to fix an optional counter. Usage is captured when a provider reports
it and left `undefined` when it does not.

A host reaches any other outbound field through one of three seams, widest first
(issue 0001):

| Seam | Use it for | What it cannot change |
|---|---|---|
| `provider.extraBody` | `stream_options`, `seed`, `stop`, `top_k`, `parallel_tool_calls`, `tool_choice`, `max_completion_tokens`, any provider-specific field | `model`, `stream`, `messages`, `tools`, the sampling fields, `response_format` |
| `provider.responseFormat` | requiring an output shape: `'text'`, `'json'`, or a named `jsonSchema` | anything else in the body |
| `openAICompatible(provider, { buildBody })` | a non-OpenAI dialect: rename or rebuild the body while reusing message mapping, attachment parts, video policy, aborting, error scrubbing and the SSE reader | the URL, the headers, the frame parser |

```ts
// (1) The opt-in the token counter needs. Merged FIRST, so it can add fields but
// never rewrite the request shape.
agent({
    model: 'x',
    provider: {
        baseURL: 'http://localhost:8800/providers/private/v1',
        extraBody: { stream_options: { include_usage: true } }
    }
});

// (2) A function form, called once per request with the resolved request, so the
// extension can key off `request.tools` or `request.signal`.
agent({
    model: 'x',
    provider: { baseURL, extraBody: (request) => ({ seed: request.tools ? 7 : 11 }) }
});

// (3) The three response shapes.
agent({
    model: 'x',
    provider: {
        baseURL,
        responseFormat: { jsonSchema: { name: 'answer', schema, strict: true } }
        //  'text' -> { response_format: { type: 'text' } }
        //  'json' -> { response_format: { type: 'json_object' } }
    }
});

// (4) A host whose gateway uses different field names keeps the whole transport and
// overrides only the body.
const transport = openAICompatible(
    { baseURL },
    { buildBody: (body) => ({ ...body, max_output_tokens: body.max_tokens }) }
);
```

The rules that keep the first seam from becoming a foot-gun:

- **Precedence.** `extraBody` is merged first, so `model`, `stream`, `messages`,
  the declared `tools`, the sampling numbers and `response_format` always win. An
  `extraBody` `tools` entry is dropped outright, not just outranked: a provider
  told about a tool the harness never declared produces calls with no
  implementation to route them to. Overriding `stream` is deliberately not
  available here — it changes what the reader below parses — so it is a
  `buildBody` decision, not a side effect of spread order.
- **Fail at construction, not at the first prompt.** A plain-object `extraBody`
  and any `responseFormat` are validated when the transport is built, which for
  `agent({ provider })` means when the agent is built. Rejected: a non-object, an
  `undefined`/function/symbol-valued key (JSON would silently drop it), a cycle,
  and anything over `MAX_EXTRA_BODY_BYTES` (8 KiB) once serialized. Every
  rejection is a `HarnessError` with code `provider-request-body` and a message
  naming the field.
- **A function form that fails at request time is an `error` frame**, not a
  throw, and nothing was sent — the transport keeps its "never retries, report
  honestly" contract.

`buildBody` receives the fully assembled default body (extension, mapped
transcript, wire tool list, sampling, `response_format`) plus the request, and
must return a plain JSON object.

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
    baseURL: 'http://localhost:8800/providers/private/v1',
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
  at 5,120 s), and the first success wins. `POST /v1/harness/models` therefore answers
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
| `progress` | `agent`, `phase: 'tool-composition' \| 'idle'` (a live frame is always `tool-composition`; `idle` is how the DISPLAY plane spells "line cleared", never emitted by a provider leg), `toolCallSlots`, `argumentChars` — the model is writing a tool call **right now**: how many calls it has opened in THIS attempt and how many characters of arguments have reached the server. **Counters only — it never carries the argument text.** Emitted at most twice a second while that block is being written, absent when nothing was reported, and **informational only**: nothing may end, time out or reorder a run because of it, and a consumer that does not know the kind skips it |
| `retry` | `agent`, `attempt`, `maxAttempts` (the failure CLASS's budget: 11 transient, 3 for `provider-connection`, 4 for `provider-timeout`), `delayMs`, `error` (`HarnessErrorInfo` — `message`, plus `code` when classified) and optional `provider` (`HarnessProviderAttemptDiagnostics` — redacted `url`, `port`, `errorClass`, `phase`, `timeoutMs`, `errno`) — the failed model attempt was discarded and the same request is re-sent |
| `attempt_commit` | `agent`, `attempt`, `maxAttempts` — one model request SUCCEEDED and its answer is committed. Emitted for every committed response that does NOT get a `done`: a tool-calling round (closed after its tool calls) and a text response superseded before it could be reported. Everything before it is final, so a later `retry` of a NEWER request must not discard it |
| `action_request` | `agent`, `callId`, `request` (parsed `HarnessActionRequest`) |
| `action_answer` | `agent`, `requestId`, `answer` (`source: 'owner' \| 'auto'`, optional `branchId`) |
| `branch_start` | `agent`, `branch` (`HarnessBranchSummary`) |
| `branch_end` | `agent`, `branchId`, `status: 'completed' \| 'failed' \| 'cancelled'`, optional `error` |
| `error` | `agent`, `error` (`HarnessErrorInfo` — `message`, plus `code` and, since 2026-11-17, the transport's `provider` diagnostics of the attempt that ENDED the run; both absent for an unclassified failure, so historical records keep the `{ message }` shape) |

Every event names its agent, so multi-agent runs stay readable in one stream. Every
variant also carries an optional `thread` for a non-root invocation:
`{ id, parentId?, callId?, input?, kind?: 'delegation' | 'fork' | 'autoanswer',
branchId?, epoch? }`. Root events and older recorded turns have no `thread`, and a branch's
`id` is its `branchId`, so `branch_start`, `branch_end`, the branch's own frames, and
`harness.branch(id)` share one naming scheme. `epoch` (since 2026-11-17) is the process that
MINTED `id`: the invocation counter restarts with the process and a lane worker mints from its
own, so an id is unique only inside one process, and every frame of a run carries that same
opaque string so a client can tell a recycled id from a continuing run. It is OPTIONAL — every
turn recorded earlier has none, and an absent one decides nothing (it never means "different
run"). The value is the same per-process epoch the REST surface reports
(`X-Harness-Epoch`, the boot document, and the stream cursors), so a frame and a cursor naming
one epoch name one server process. As far as the TURN goes it stays in the recorded event
payload — no display turn record (`TurnSection` / `TurnSummary`) and no `turn.*` frame carries it
(the browser keeps it as its own row state and stamps the row with `data-run-epoch` for inspection,
and nothing renders it) — but the SAME token is published on the CONVERSATION planes, beside the run
ids it discriminates: `epoch` on `SessionThread` / `SessionThreadView` and in a roster row's identity
block, which is also what a `thread.upsert` frame carries (see the identity note under
[Sessions, agents, and threads](#sessions-agents-and-threads)).

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

### When a model is writing a tool call, the stream used to stop

A model that is composing a tool call **used to send nothing at all**. The arguments stream in
pieces inside the provider's response, the pieces are stitched together before the call is
launched, and the client's first frame about that call was the `tool_call` that came after the
model had already finished writing it. A relay in front of a local model makes this worse: it
withholds the whole tool region and delivers one final update at the end. So a four-call
delegation with a few thousand characters of arguments looked exactly like a hang — one live turn
sat for 62 seconds with zero frames and was stopped by its user, and a second turn of the same
shape finished normally after 27 seconds. Nothing had gone wrong, and nothing could have said so.

That is what `progress` is for. While a tool block is being written you now get a small frame, at
most twice a second, saying how many calls are being composed and how much of their arguments has
arrived — and in the browser the turn's tile carries a line for it: `composing N tool call(s) ·
<chars> chars` (`src/frontend/ui/turns.ts:891-893`). Two honest limits:

- **"Composing" is not "running".** A call counted here has been *opened* by the model, not
  launched: a tool starts only once its arguments are complete. The line is progress on the
  request, not progress on the work.
- **Absence is not failure.** A provider or relay that delivers the tool block in one piece sends
  exactly one such frame, and an older recorded turn sends none. A tile that shows no composition
  line is not a dead tile; when the screen has heard nothing for a while it says
  `still generating · quiet for <duration>` (`src/frontend/ui/turns.ts:4829-4830`), and those
  thresholds are about
  what the VIEW can claim — nothing in this product stops a run on a clock.

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
  tools), and it is RECORDED in the turn, so `GET …/turns/:id/events` re-serves the
  same panels after a reload and `eventTimes` stays aligned. The DISPLAY tree carries
  only a bounded SUMMARY per step (`DisplayPanelSummary`, `src/server/turn-projector.ts`):
  full panels are an event read or a manual-call answer, never a display node;
- `POST /v1/harness/tools/:tool_id/executions` and
  `POST /v1/harness/sessions/:id/tools/:tool_id/executions` both answer
  `{ ok: true, result, panels?, media?, duration_ms }` — `result` is the underlying
  content, and `media` is the `ToolMediaDescriptor[]` projection (`id`, `kind`, `name`,
  `mime`, `size`) of anything a tool attached with `toolMedia()`, so a `download` answer
  never puts base64 on the wire either. A tool that RAN and failed is still `200`, with
  `{ ok: false, error, duration_ms }`; only a call the server could not make at all is an
  HTTP error, so a client branches on `ok` and not on the status code.
- both manual paths share the model budget: a result or error over **64 KiB of
  UTF-8** is returned as the explicit envelope `{ truncated: true, originalBytes,
  budgetBytes, content }` (panels stay on the separate tool-UI limit), and a result
  that fits is returned exactly as before. This is a post-serialization cap: it
  bounds the response/context cost, **not** the process's peak memory;
- the direct runner validates `parameters` with the same schema the model sees, in
  "direct" mode, so both `["src"]` and `{ "paths": ["src"] }` reach the tool and a
  wrong type is an `ok: false` tool error. `parameters: null` means "no arguments";
- a tool created at runtime (`toolCreate`) or added by a plugin lives in its
  session's harness, not in the static catalogue: the SESSION execution route resolves
  it, a route naming another session answers `404 Tool "<name>" is not available in
  this session.`, and the global route answers `403` because the name is session-bound.
  For listing, read the session (`GET /v1/harness/sessions/:id/definition`): a created
  tool is registered AND enabled at once, so its name appears in `discovered_tools`
  alongside the discovered catalogue tools. `GET /v1/harness/tools` stays the static
  catalogue;
- `GET /v1/harness/tools` is otherwise unchanged. The shipped `timeNow` tool is the in-app
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
workspace root still finds it. The loader resolves it from the package directory
regardless of cwd, so in a workspace checkout that is
`packages/underload/harness/.env` relative to the repo root. Copy
`.env.example` to `.env`; the real file is git-ignored.

| Variable | Used by |
|---|---|
| `HARNESS_BASE_URL` | Provider base URL default; CLI `-b` overrides |
| `HARNESS_API_KEY` | Provider key; CLI `-k` overrides. Falls back to `OPENAI_API_KEY` |
| `HARNESS_MODEL` | Model default; CLI `-m` overrides |
| `EXA_API_KEY` | Opt-in `search` provider (the preferred default) for every shipped preset (`general`, `instruct`, `research`, `workspace`, `reviewer`, `planner`, `debugger`), **and** the optional hosted `fetch` provider |
| `TAVILY_API_KEY` | Second opt-in `search` provider (search only — Tavily has no `fetch` provider) |
| `LINKUP_API_KEY` | Third opt-in `search` provider, and the second optional hosted `fetch` provider |
| `HARNESS_THREAD_EXECUTION` | Server only: `inline` (default) or `worker` — runs each conversation's turn on its own OS worker thread. See [Per-thread CPU isolation](#per-thread-cpu-isolation-threadexecution-worker) |
| `HARNESS_DEV_API` | **Vite only** (`src/frontend/vite-proxy.ts`, read when the UI's dev/preview config loads): the mount the `/v1/harness` proxy forwards to. Default `http://127.0.0.1:5000/v1/harness`; the point it at the standalone launcher with `http://127.0.0.1:5181/v1/harness`. No server or CLI entry reads it |
| `HARNESS_WORKER_IDLE_MS`, `HARNESS_MAX_LANE_WORKERS`, `HARNESS_WORKER_HANDSHAKE_MS`, `HARNESS_WORKER_ENTRY` | Server only: the lane-worker bounds and entry file for `worker` execution (same section; every value is validated, and a bad one aborts startup) |
| `HARNESS_IO_EXECUTION` | Server only: `inline` (default) or `worker` — runs the checkpoint's shard commits (one frame per shard file) and the event journal on one IO worker thread instead of on the request loop. See [Off-loop durability](#off-loop-durability-ioexecution-worker) |
| `HARNESS_IO_WORKER_ENTRY` | Server only: explicit IO worker entry file; unset resolves the package's own source entry (`src/server/workers/io-worker.ts`) |
| `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT` | Server only: how many CONSECUTIVE network-class failures (`stopReason: 'provider-network'`) one conversation tolerates before the server stops AUTO-RESUMING it. Default `10`, range 0–1000, `0` = auto-recovery off; digits only, and a bad value aborts startup naming the variable. A per-provider `settings.networkResumeLimit` outranks it. It bounds a PROVIDER condition, so it carries the `HARNESS_PROVIDER_` prefix like the three time bounds; it does NOT replay anything on restart |

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
Because these are `harness.executeTool('tasks', …)` calls and not a private store, the
command inherits the tool's own bounds (200 tasks, 4000 characters each, 20 per page by
default, 100 maximum) and the next `/task` really lists what `/task add` wrote.

`complete`, `reopen` and `remove` are **guarded writes**: the command reads the store
first (following `page.nextOffset` until the list is exhausted) and sends the real
`expects: [{ id, rev }]` tokens, so an edit by another agent between the read and the
write is the tool's stale error instead of a lost update — never an invented revision.
An unknown id gets no token, so the tool's own `tasks has no task with id "99".` is what
the operator reads. The read
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
- There is no second submit route to be inconsistent with: the response-owned
  `POST …/messages` stream was deleted, so the queue submit is the ONLY way a line reaches
  the model, and a leading `/` on it is a command. The host's own `dispatch()`/`execute()`
  path answers a leading `/` the same way.
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
| tool not registered | the `/websearch` / `/webfetch` guidance text above, or `/task: the "tasks" tool is not registered in this harness.` |
| the tool rejects the call | `<label>: <the tool's own message>` — the label is the command and subaction (`/task add`, `/webfetch`), covering an unknown task id, a failed provider call, a non-text page, and a stale `expects` (another agent changed the record between the command's read and its write) |

Only a command that throws on purpose escapes: `executeCommand` does not wrap a host
command's exception, so a built-in's recoverable failures return
`{ content, isError: true }` by convention.

## CLI

The CLI runs a preset in-process. No UI, no HTTP server, no browser. It runs from
this package's source through the workspace script; the published package remains
the library.

```bash
yarn cli --list                                     # the eight shipped presets
yarn cli "Write an opening."                        # default preset: general (live)
yarn cli --preset planner "Plan the release."       # plans, then delegates to its specialists
yarn cli --preset workspace --model merge/ds4-flash --base-url http://localhost:8800/providers/private/v1
yarn cli --preset research --model merge/ds4-flash --base-url http://localhost:8800/providers/private/v1
yarn cli                                            # interactive General session (TTY)
echo "Summarise this" | yarn cli                    # one task from stdin
```

The Analyst card is the `workspace` preset and the Explore card is `research` (the
ids are kept for saved sessions and bookmarks; `--list` shows each id with its
title). The default is the real `general` role, not the demo: a scripted answer is
not a useful general harness, and `general` is the one card the catalogue lists
first. There is no endpoint-free preset to fall back to: the scripted `demo`
fixture is deleted, so `--preset demo` is an unknown name and the CLI says so and
prints the real list. Every preset is live, and a live role uses
`--base-url` / `HARNESS_BASE_URL` (plus `--api-key` / `HARNESS_API_KEY` when the
provider needs one); if the run cannot reach the provider, it reports the failure
rather than
inventing a demo transcript.

| Flag | Meaning |
|---|---|
| `-p, --preset <name>` | Preset to run (default `general`; every preset needs a provider) |
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
session's `GET /v1/harness/stream` WebSocket as the same `report.progress` events a CLI
prints. The server, not the browser, keeps the queue and the transcript.

On a phone (`max-width: 860px`) both side rails start **collapsed** and the topbar
grows one toggle per rail; opening one closes the other, and a backdrop click or
`Escape` dismisses it. The rails stay in the DOM (CSS only hides them), so their
content and state survive opening and closing, and every wider layout ignores the
toggle state and shows both rails permanently. A shut scratch board also parks its
panels' live read: the rows, filter and open details stay exactly where the reader
left them, while the request and the realtime subscription behind them are released
and taken up again — with one fresh read — when the board opens. So the scratch board is
dormant on a phone until the reader opens it, and live on every wider layout.

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
`startHarnessServer({ databaseRoot })`). It is itself a HOST, so it states the
production catalogue explicitly (`harness: { presets, plugins: BUILTIN_PLUGINS,
toolbox: { sharedToolbox: true } }`); the server boot contract itself has NO implicit
presets, plugins or toolbox, and `@underload/service` forwards its host's configuration
through `variables.harness` (see `knowledge.md`, "Harness boot configuration (R-boot)").
Normal hosting is still owned by `@underload/service`; there is deliberately no generic
`serve`/`start` alias.

To run the UI against that standalone API instead of the service, point Vite's
proxy mount at it (a shell variable, read by `src/frontend/vite.config.ts` through
`src/frontend/vite-proxy.ts`):

```bash
HARNESS_DEV_API=http://127.0.0.1:5181/v1/harness yarn dev:frontend
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
`locations`, `agentManage`, `agentResult`, plus `delegate` only when the card's rank map
spans two or more distinct letters,
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

### The eight real presets

| Preset | Visible title | Role |
|---|---|---|
| `general` | General | **Default card, and the only one with no team.** Does every step itself with the full toolbox; `delegate` is not even registered. |
| `instruct` | Instruct | Worker with the full toolbox. Does its own building and editing, and delegates only the steps that would burn its context (an investigation, a long read, a review). |
| `research` | Explore | Read-only investigator: maps files, symbols and the web, cross-checks what decides the answer, and cites file/line/tool/URL. Changes nothing unless the brief authorises it. |
| `workspace` | Analyst | The implementor: writes the change in the codebase's existing style, keeps it minimal and efficient, and verifies it with a real check. |
| `reviewer` | Reviewer | Strict, independent judge of plans, code, documents and claims; every finding carries evidence, and it is non-mutating by default. |
| `planner` | Manager | Holds the goal, writes the plan, delegates EVERY step, and accepts a result only after `reviewer` has independently checked it. Never executes a step, and refuses to run as a delegate. |
| `debugger` | Debugger | Stress-tests the system: unlocks any searchable tool, runs any command, exercises each capability at its edges, and reports a reproduction. |
| `chat` | Chat | The one card that opts out of the toolbox: the General profile on an EMPTY catalogue — no file, search, delegation, or record tool is registered. It cannot read or write the server host, because the only rows it can call are the harness-owned core tools, and it carries no iteration budget, so it runs until the model answers. `tools: []` on the card is made true in the runtime by `sharedToolbox: false`, not merely promised. |

Every real preset states its ROSTER and its RANK MAP explicitly, side by side
(`src/server/harnesses/presets.ts`); the derived `teamOf()` list is DELETED, because it
inferred both decisions from one word — who runs at all, and who may hand work to whom. The
two letters are named once (`ENTRY_RANK = 'A'` at `:168`, `TEAM_RANK = 'B'` at `:169`), and
every teamed card puts its OWN entry agent at Rank A with every other member at Rank B, so
each team has exactly one delegator. The entry agent is listed ONCE in `agents` (its rank is
what says whether it can delegate), and `planner` (the Manager) is in nobody else's roster
because a Manager refuses
to run as a delegate. `general` and the tool-less `chat` card state ONE rank each, which is
what makes `delegate` disappear from the runtime rather than merely being discouraged:
`ranksDeclareDelegation` (`src/server/harnesses/toolbox.ts:289-290`) counts DISTINCT letters,
so one letter registers no delegation tool at all. Every shipped card spans exactly TWO
letters, so the "one level deep" a reader observes is a property of these RANK MAPS, not a
rule the runtime enforces by role — a host that configures `A`/`B`/`C` gets a three-level
chain from the same code, and a Rank B member of a shipped team still forks, spawns threads
and calls every tool its Rank A entry agent calls, because threading never consults rank.

There is no example tier left. The two presets that used to sit beside these eight —
`demo` (a scripted offline transport) and `flaky` (the shared toolbox plus a tool that
throws two calls out of three) — are deleted, along with the `demo`/`flaky` agent
profiles and the `testFlaky` tool and its scanned `src/server/tools/examples` folder.
A card a user could pick that did not do what a card promises was the bug; the offline
loop and the failure tool that suites still need are TEST fixtures a test injects
itself (`src/server/harnesses/fixture-presets.test-support.ts`), never a catalogue row.
Because nothing ships a scripted factory any more, a saved session whose frozen record
names the `scripted` template is DROPPED at restore with a readable reason
(`Scripted harness "demo" is not shipped in this build`) unless the host injected a
scripted preset of that name — never silently rebuilt on some other harness.

Every shipped entry is a template the registry copies; there is no read-only category
(R20.1). Legacy
identifiers still resolve: `writer` and `assistant` → `instruct`, `researcher` →
`research`. They are aliases, not extra cards, and a session created through one
reports the canonical name. Titles are never names: the visible titles `Explore`,
`Analyst` and `Manager` keep the `research`, `workspace` and `planner` ids, because
an id is what a URL, a session record and every per-agent map carry — and there is no
agent-id alias fallback, so a renamed id would abort a restore. Adding a NEW reserved
alias could also collide with an existing user-created harness on restart, so the
title carries the rename instead.

The server keeps one harness per session, so submitting a second task continues
the same conversation. `POST /v1/harness/sessions/:id/tasks` accepts a task with
a `202` **`TaskReceipt`** — `{ session_id, turn_id, status, thread_id, session_revision,
accepted_at, links { turn, turns, thread, stream } }`, plus `queue_position` while it
waits or `steered` / `steered_thread_id` when it folded into a running conversation —
and never echoes the session or the turn record; the content arrives on the stream and
a bounded `/turns` page carries the row. The server runs it FIFO behind anything already
pending, so tasks execute in submission order even when they arrive while a run
streams. **Team membership, the entry agent, the resolved rank map and the descriptor
snapshot are frozen at
session creation**: the preset object and a `harnessDefinition` are captured, so a
later create/patch never changes which agents a running session has, which agent routes
it, the RANKS that decide what it may delegate, or the history it reports. The UI's
Endpoint panel is sent when a session is
created; changing it starts a fresh session on the next run.

**A session is created on demand, not on first use.** `POST /v1/harness/sessions` needs a
harness name and nothing else; the id is the server's own `randomUUID()`, and the record is
written before the `201` answers — a failed write rolls the in-memory entry back, so a retry
can never observe a session that was never durable (`src/server/sessions.ts:2269-2278`). A
client holding a `201` may therefore `POST …/tasks` immediately, with no probe-and-retry loop.
The UI depends on that ordering: `+` calls this route the moment it is pressed, including
while another conversation is still streaming, because starting a conversation cancels nothing
and the `+` deliberately has no run guard (`paintSessionActions`,
`src/frontend/main.ts:11220-11225`; pinned against a live run by
`src/frontend/canonical-directory-live-main.test.ts:304`). Each `+` press creates a NEW
session — no dedup, no reuse, no client-side cap — and a failed create leaves an empty draft
plus one error in the status pill, never a half-bound conversation. There is no Reset control
in the page at all: starting over IS New session, while `POST /v1/harness/sessions/:id/reset`
stays alive for other clients (`src/frontend/main.ts:4086-4088`).

**Plugin settings are per conversation; the tool switch is per deployment.** A session owns a
copy of the plugin-settings store, taken from the template at creation
(`copyPluginSettingsStore`, `src/server/plugins.ts:713` → `src/server/sessions.ts:2186`) and
persisted on the session's own record (`src/server/persistence.ts:293`), so
`PATCH /v1/harness/sessions/:id/plugins/:pluginId` moves ONE conversation from its next turn
and no other, while `PATCH /v1/harness/plugins/:id` changes what sessions created after it
inherit and touches no live one. A CPU-isolated lane replica is built from that session's
snapshot, never the template's (`src/server/plugins.ts:107-121`). The tool deny list has no
session-scoped twin: `PATCH /v1/harness/tools/:id` is honoured on the next turn of every
session AND thread (`src/server/tool-settings.ts:1-2`), and a session's own tool routes change
what that session declares without ever lifting a deployment denial
(`src/harness.ts:4567-4581`) — though the manual execution path is not gated by the switch at
all, which is how an operator runs a name the model was refused (`src/harness.ts:7848-7850`).
The page follows the same line — with no conversation open, the Tools
and Plugins panes are hidden rather than quietly repointed at the template
(`src/frontend/main.ts` `paintControls`, the `harnessTitleTools.hidden` / `toolsToggle.hidden` / `pluginsToggle.hidden` trio). One carve-out is worth stating because it is the easy
misreading: pressing Call in the tools pane does NOT run the tool inside the conversation you
are configuring. A `sessionBound` call runs in the playground's own throwaway session, created
for the purpose and cleaned up after it (`src/frontend/main.ts:2253-2292` wires
`ensurePlaygroundSession`, then `callTool(name, parameters, sessionId)`), so inspecting a tool
never writes into the transcript on screen. And note the shape of the surface: plugin
configuration has exactly TWO scopes today — the template and one conversation. A harness
template carries no plugin settings of its own (`src/server/persistence.ts`,
`HarnessPresetRecord`), and a thread has none either: its turns and its lane worker resolve the
SESSION's store (`src/server/plugins.ts:107-121`). A per-harness or per-thread scope is open
work, not something to infer.

One field is deliberately not frozen: an agent's **model**. `PATCH
/v1/harness/sessions/:id` with `{ agent_models: { <agent>: <model> } }` retargets an
existing session in place (see the session table below). The map MERGES into the
live map, every key must name a member of that session's harness, values are
validated like a harness override, and the whole patch is all-or-nothing. It is
allowed while a run streams: the in-flight request keeps the model it started
with (the assistant message it commits names that model), and the **next request**
of that agent uses the new one — including a queued task, whose request starts
after the patch. Nothing is aborted, rebuilt, or replayed, and the
frozen `harnessDefinition.agentModels` remains the creation-time record. Team
editing (`agents`/`entry`/`ranks`) still applies to the next session you start — including
the delegation surface, which is a function of the ranks a session was CREATED with. A session is in
memory ONLY where no database root is configured: with one (the service's
`DATABASE_ROOT`, or `startHarnessServer({ databaseRoot })`) it is persisted and restored
on the next boot (see [Persistence](#persistence-database_root)). Created tools live in the
session's harness: they survive `reset()` (which clears the conversation,
discovery, `tasks`, and the three record stores) and disappear with the
session.

Every submit (`/tasks`) is also the server's
record: every task becomes a `SessionTurn` (id, index, prompt, status, timestamps,
every event the run produced, a parallel `eventTimes` array of epoch-ms stamps,
and a `usage` tally summed from the per-request `usage` events — `input` with the
cached part in `cached`). A queued task is a turn immediately: `status: 'queued'`,
a stable `id` and `index`, and **no `startedAt`** until the server pump begins it,
so a client can render the backlog before execution. Reads are bounded and lazy:
`GET /v1/harness/sessions` answers a PAGE of `SessionSummary` rows (`limit` default
25 and max 100, an opaque `cursor`, plus the `status` and `harness` filters) and
`GET /v1/harness/sessions/:id` answers one session's metadata; NEITHER embeds the
heavy children. Turns, threads, transcripts, recorded events and each display tree
are their own named, paged routes, so a browser reload — or
a second client — renders the same transcript, the same per-step/per-tool elapsed
time, and the same token count from `/turns`, `/turns/:id/display` and
`/turns/:id/events` without having seen the stream. A turn that is
still running (or still queued) is in the page too, which is what the UI reattaches
to; its live channel is the `GET /v1/harness/stream` WebSocket, with a session
bounded REST reads as its fallback: there is no SSE and no second transport. A row's `queue_depth` counts waiting turns only
— the active turn is not in it — and is omitted when the queue is empty. The
identified read adds `agent_models`
(the session's LIVE effective model of every agent — overrides resolved,
rewritten by a session PATCH, so a per-agent dropdown survives a reload and shows
what the next request will use), the key-free `endpoint` view, `definition_revision`,
`pending_action_count` and `created_tool_count`; the frozen descriptor itself
(members, the entry agent, the resolved rank map, and the models the session was created with) is
`GET /sessions/:id/definition`, and that read is also where `discovered_tools`
lives, so a reload loses neither the configuration nor the discovery state.

There is **one mount**: `HARNESS_API_ROOT` = `/v1/harness`, and both the standalone
listener (`startHarnessServer`, `127.0.0.1:5181` by default) and the
`@underload/service` gateway serve exactly the paths below — the same dispatcher, the
same bootstrap document at `/v1/harness`, and the same WebSocket at
`/v1/harness/stream`. The legacy `/api` root is not mounted at all: a request to it
answers `This server serves /v1/harness; "/api" is not mounted.`, and the `/presets`,
`/views`, `/tools/bootstrap`, `/tools/:name/call` and `/sessions/:id/messages` aliases
were deleted rather than kept behind a flag. See
[Service host](#service-host-v1harness) below.

| Endpoint | Purpose |
|---|---|
| `GET /v1/harness` | The constant-size boot document: identity, links, capabilities, limits, epoch and server time — no catalogue, no defaults, no sessions |
| `GET /v1/harness/health` | Liveness probe |
| `GET /v1/harness/config` | Global provider defaults and the deployment runtime facts (never per-session) |
| `PATCH /v1/harness/config` | Change the global provider defaults — `{ settings: { base_url?, model?, api_key? } }`; an explicit `null` puts the shipped default back |
| `GET /v1/harness/harnesses` | Harness definitions, paged (`q` matches name/title/description). Every entry is an editable application copy |
| `POST /v1/harness/harnesses` | Create a harness from trusted agent ids — body `{ name, title?, description?, agents, entry?, ranks?, agent_models?, agent_instructions?, agent_colors? }` → `201 { harness }`. `agents` is the ONLY roster field and is REQUIRED beside `name`; it keeps DECLARATION order (the display/cycle order), which is presentation only. `entry` is optional, must be a member, defaults to the first name, and grants no authority. `ranks` may cover fewer members than the roster and is RESOLVED into the map the harness runs with (an omitted map = entry `'A'`, every other member `'B'`; a stated map is filled one rank below the lowest letter it names). A duplicate name, a roster over 16 members, an `entry` outside the roster, a `ranks` key outside the roster, and a bad rank letter are each a `400` naming the members. `primary`/`subagents` are not accepted at all |
| `PATCH /v1/harness/harnesses/:name` | Change a harness definition. The EXECUTABLE fields are `agents`/`entry`/`ranks`/`agent_models`/`agent_instructions`/`agent_colors` — stating any of them rebuilds the harness's factory, so the change reaches the NEXT session, never a running one; an omitted `entry` survives whenever the patch left it a member, and an omitted `ranks` keeps the current ranks restricted to the surviving members (a member the patch added takes the filled value, so a newcomer never lands at `'A'` by accident) |
| `DELETE /v1/harness/harnesses/:name` | Remove one — `{ deleted: true, harness_name, tombstoned, restored_by_restart: false }`; a deleted built-in stays deleted across a restart. `404` unknown/repeat/alias-only delete. `409` while ANY live or restored session belongs to this canonical harness, or while one of its session removals is still in flight: nothing is removed, no session is cascaded, and each owned session must be deleted individually (there is deliberately no bulk delete). After the registry write succeeds the route removes the knowledge articles attributed to this harness and flushes before the `200`; other harnesses', unowned/legacy and Storyline articles survive. A cleanup/flush failure after that commit is a `500` naming the partial outcome (the harness is already gone; a repeat DELETE is `404` and does not retry cleanup) |
| `GET /v1/harness/harnesses/:name` | Read ONE definition — the identified read carries what a card omits (the per-agent model map, instruction text, resolved core-tool set); `404` for an unknown name |
| `GET /v1/harness/harnesses/:name/instructions` | Which members carry an instruction override (not paged: membership is bounded by the definition) |
| `GET /v1/harness/harnesses/:name/instructions/:agentId` | One member's effective instruction text |
| `GET /v1/harness/agents` | The trusted agent profiles, paged |
| `GET /v1/harness/agents/:id` | One profile |
| `PATCH /v1/harness/agents/:id` | Override a profile's declarative text (`title`, `description`, `instruction`) — future sessions only, and durable in the agent-state layer |
| `DELETE /v1/harness/agents/:id` | Retire the override |
| `GET /v1/harness/tools` | The global tool catalogue, paged |
| `GET /v1/harness/tools/:id` | One catalogue entry with its argument schema |
| `PATCH /v1/harness/tools/:id` | Enable or disable one catalogue entry for EVERY session (no un-register, so a run in flight keeps the declarations it was given) |
| `POST /v1/harness/tools/:id/executions` | Execute a catalogue tool without a session, against the deployment catalogue; a session-bound name is a `403` naming the session route; an unconfigured tool answers `200 { ok: false }`. See [the call body](#the-tool-call-body) |
| `GET /v1/harness/plugins` | The built-in plugins with their settings and the TEMPLATE's current values (answerable with no harness and no model) |
| `PATCH /v1/harness/plugins/:id` | Change one plugin's settings **in the template**: write-anytime, and the change is inherited by every session created AFTER it — an existing session answers from its own copy (see the per-session rows below). `{ settings: { enabled: false } }` is the off switch for everything started from now on; `X-Harness-Revision` here is the template counter |
| `POST /v1/harness/models` | Server-side `GET {base_url}/models`; returns `{ models, observed_at }` for the UI dropdown |
| `GET /v1/harness/sessions` | Sessions as bounded summaries — paged (`limit` 25 default / 100 max, `cursor`, `status`, `harness`); turns and threads are separate routes |
| `POST /v1/harness/sessions` | Create a session from a harness definition — `{ harness, title?, settings?, messages? }` → `201 { session }`; `messages` is the transcript the new conversation starts with (below, "Seeding a new conversation") |
| `GET /v1/harness/sessions/:id` | One session's metadata plus its live model map and counters — still no turns, threads, transcripts or display trees. It DOES carry `inactive_thread_ids` (additive, absent when the session never deleted one): the ids of the conversations this route's roster HIDES because a `DELETE …/threads/:threadId` retired them. The roster omission is the listing rule, not evidence — after a reload a client cannot tell "deleted" from "never existed" — so the deletion fact travels as its own field, and the roster keeps meaning "the conversations this session can still run" |
| `PATCH /v1/harness/sessions/:id` | Retarget models in a live session: body `{ agent_models: { agent: model } }` (and/or `title`, where `null` clears it) → `{ session }`. Merges into the live map, validates every key/value, applies all-or-nothing, and is allowed while the session is running (the next request uses the new model; the current one keeps its own). See [Server and UI](#server-and-ui) |
| `DELETE /v1/harness/sessions/:id` | Dispose a session — `{ deleted: true, session_id, aborted_turns, dropped_queued_tasks }` |
| `GET /v1/harness/sessions/:id/definition` | The harness definition this session froze, plus `frozen_at`, `source_revision` / `current_revision` / `current`, and `discovered_tools` — the enabled set, omitted while it is empty and therefore already populated on a session the server created (`enableAllTools`) |
| `GET /v1/harness/sessions/:id/usage` | The session's token accounting (server-summed from the recorded `usage` events) |
| `GET /v1/harness/sessions/:id/commands` | The slash commands this session can run (discovery only — execution is a task submit) |
| `GET /v1/harness/sessions/:id/records` | The session record store, whole or as a `?since=` delta; read-only, so polling it moves no revision. A delta is a CLOSED object — `{ session_id, revision, store_rev, collections_rev, changes, reset }` — and `reset: true` says your `since` is no longer answerable: the store rewound under that watermark (a session `reset()` takes `store_rev` to 0), or the retained window trimmed past it, or a restore/restart cleared the feed. It is a `200`, not an error, and `changes` still carries what IS retained; the recovery is the snapshot read of this same path, and only that. The per-collection window keys (`oldestAvailableRev` / `droppedEvents`) are not published on either form of this route |
| `GET /v1/harness/sessions/:id/queue` | The tasks waiting in this session's queue |
| `POST /v1/harness/sessions/:id/tasks` | Submit a task (`{ input, attachments?, references?, thread_id? }`) or steer a running conversation → `202` **`TaskReceipt`** (see above). Each thread runs its own lane FIFO (cap 100 pending across all lanes, `429`) and continues after a task fails. Omitting `thread_id` opens a new thread; a running `thread_id` steers, or queues a continuation when attachments/an unfinished reference prevent it |
| `POST /v1/harness/sessions/:id/reset` | Discard a session's conversation state — `{ reset: true, session_id, discarded_turns, discarded_threads, dropped_queued_tasks, revision }`; `409` while a run or queued work is pending. The cleared toolbox is immediately re-seeded (`SessionStore.reset`), so the next `GET .../tools` shows the same rows a brand-new session shows — unlike a restart, which keeps the set the conversation committed |
| `POST /v1/harness/sessions/:id/cancel` | Optional `{ all?: true }` → the cancel receipt. Default cancels the active run only; `all: true` (the UI Stop button) also drains every queued turn, which stays in `/turns` as a `cancelled` row |
| `GET /v1/harness/sessions/:id/actions` | The owner questions still waiting for an answer |
| `POST /v1/harness/sessions/:id/actions/:requestId/answer` | `{ choice: { kind: 'option', option_id } \| { kind: 'custom', text } }` → `{ ok: true, request_id, resolved_at }`. Settles one pending `actionRequest`; allowed while the session is busy. `400` invalid/unknown option, `404` unknown session/request, `409` answered or expired |
| `GET /v1/harness/sessions/:id/agents` | This session's agent roster (bindings joined with what the session actually runs). Each row states the member's `rank`: the definition's `ranks` map is the ONLY authority — the read never derives a letter from the name, the roster order, or "is this the entry agent" — and a member the map does not name reports the LOWEST rank, because authority exists only where the definition grants it (`rankOfMember`, `src/server/api-reads.ts:1477-1488`). Any number of members may share a rank, `'A'` included. The row also carries `deletable`, the same predicate the `DELETE` behind it refuses on |
| `POST /v1/harness/sessions/:id/agents` | Bind a trusted profile, or define a session-owned agent, into this session only. The answer is ONE `SessionAgentBinding`, and it names the member's `rank` — a letter the caller may state, and one the runtime fills when it does not: an omitted rank takes ONE RANK BELOW the lowest rank configured anywhere (the store's own fallback for a handle that reports no `ranks` at all is `'Z'`, the bottom of the scale — never an inherited middle rank), so a bound newcomer cannot land above the harness's delegator by accident |
| `GET /v1/harness/sessions/:id/agents/:agentId` | One binding |
| `PATCH /v1/harness/sessions/:id/agents/:agentId` | Override one session agent's model or instruction, or change its rank while the session has not started a thread (a started conversation keeps the ranks its template defines and answers `409`) |
| `DELETE /v1/harness/sessions/:id/agents/:agentId` | Remove one binding. The ENTRY agent is the one member that is never detachable (`harness.name` and `handle.agent` point at it), and a binding can never REPLACE `definition.entry` — promoting a member is a harness-definition edit, not a session-scoped binding. That entry guard is the SERVER's, and the library handle is looser on purpose: `harness.removeAgent(entry)` is legal (`src/harness.ts:16687-16691`) and `harness.name`/`handle.agent` then resolve to the first still-registered agent, because this route — not the library — is the one that guards a durable roster. An agent that still owns a conversation is refused with a `409` naming those thread ids (delete the threads first), and live or queued work is a `409` |
| `GET /v1/harness/sessions/:id/agents/:agentId/instruction` | One session agent's effective instruction, naming the layer it came from |
| `PATCH /v1/harness/sessions/:id/agents/:agentId/instruction` | Replace or clear it (`{ instruction: "…" \| null }`) and return that same document |
| `GET /v1/harness/sessions/:id/tools` | This session's toolbox: one row per live registry name, with `declared` (in the frozen definition's **`coreTools`**, not the preset's tool list), `enabled` — the CALL axis, `!withheld && (holds a cap slot ? in the capped set : true)` (`src/server/api-reads.ts` `sessionToolRowsOf`). So `false` means EITHER "this conversation switched it off" OR "the cap has no free slot for it", and only the first appears in `harness.withheldTools`; a slotless row (a core declaration, the pending-only `toolCancel`) can only be `false` because it is switched off. The row carries no separate withheld flag, so for a searchable name those two `false`s read identically here. A session the server CREATED starts with every cap-eligible name there, `enableAllTools`, and so does one it RESETS; a name the deployment denies is the one name the seed leaves off, and the denial outranks this figure — `GET /v1/harness/tools` is the row that states it), `origin` (`created` / `discovered` / `catalogue`) and `protected` — the UNREGISTER axis: `visibility === 'core'` on the live registry map, exactly the `DELETE` `403` and nothing else. It is never consulted by an enable/disable PATCH, and `toolCancel` is `protected: false` because the kernel's `remove` accepts it |
| `POST /v1/harness/sessions/:id/tools` | Register a session-local tool |
| `GET /v1/harness/sessions/:id/tools/:toolId` | One session tool with its argument schema |
| `PATCH /v1/harness/sessions/:id/tools/:toolId` | Edit or switch one session tool. A body carrying ONLY `enabled` writes this conversation's withheld set (`src/harness.ts` `applyToolSwitch`) and answers `200` for EVERY row the session lists — the core declarations (`write`/`read`/`edit`/`glob`/`grep`, `toolRequest`, `tasks`, the thread group, a configured `search`/`fetch`, `delegate`) and the pending-only `toolCancel` included — WHILE a thread is running: no idle gate and no `403` (`src/server/api.ts` `setSessionToolEnabled`), and the change lands on that thread's very next model request because declarations are rebuilt per request and the launch gate is a per-launch live read. Withholding a name never un-registers it. The idle gate REMAINS on the other half of this route: a PATCH that also carries the declaration (source/metadata/parameters) replaces what a run is executing, so `assertIdleForToolMutation` (`src/server/api.ts`) still answers `409` while the session is busy, and that refusal can arrive with the new revision installed and the switch unchanged. Remaining refusals: `404` a name this session does not list, `400` from the body validation, and the runtime's race `409` if the name stopped being registered between the row and the write |
| `DELETE /v1/harness/sessions/:id/tools/:toolId` | Remove one registration — the implementation, its captured revision, its created-tool record, its enabled slot and this conversation's switch on it go in one step, so a restart does not resurrect the name and a later CREATE of that name starts it ON. `403` a `protected` row, which is now the UNREGISTER axis alone: `visibility === 'core'` on the live registry map (`src/server/api.ts` `deleteSessionTool` reads the same map the kernel's `toolManage remove` refuses with), so the nine harness-owned names above are refused HERE even though each of them switches off with a `200`; `400` only a name this session merely INHERITS, with no session-local registration and no enabled slot — `toolCancel` is `protected: false` now (it registers at `visibility: 'searchable'`), and deleting the inherited one answers that `400` while switching the same name answers `200`. An enabled catalogue row, the new-session seed included, is `origin: 'discovered'` and removes with `200`; `409` while the session is busy |
| `GET /v1/harness/sessions/:id/tools/:toolId/source` | One tool's installed source revision |
| `POST /v1/harness/sessions/:id/tools/:toolId/executions` | Execute a tool through THIS session's registry (a replaced preset, a created tool and a session-owned core tool all run what the session holds); a busy session is a `409`. See [the call body](#the-tool-call-body) |
| `GET /v1/harness/sessions/:id/plugins` | THIS conversation's plugin rows — the same catalogue, the same paging, and THIS session's `enabled`/`values`. `X-Harness-Revision` is that session's own counter: 0 until its first `PATCH`, and it never moves the template counter |
| `GET /v1/harness/sessions/:id/plugins/:pluginId` | One row with this session's values; `404` unknown session first, then unknown plugin |
| `PATCH /v1/harness/sessions/:id/plugins/:pluginId` | `{ settings }` → `{ plugin }`, changing one plugin **for this conversation** from its next turn. Write-anytime: no `409` path at all, because a settings value moves no registration — exactly why a session TOOL SWITCH (`enabled`-only `PATCH …/tools/:toolId`) is write-anytime too since the withheld set; the idle gate stays only on the tool writes that replace or remove an implementation (`assertIdleForToolMutation`, `src/server/api.ts`). `404` resolves before the body is read; an unknown key/type/range is a `400` that changes nothing; the write is durable before the answer |
| `GET /v1/harness/sessions/:id/threads` | A PAGE of conversation rows (`ThreadSummary`, `src/server/harness.swagger.yaml`; the same shape a `thread.upsert` stream frame carries — `src/shared/harness-stream.ts`). Besides the identity, ownership, lifecycle and transcript SIGNALS, each row now publishes an IDENTITY BLOCK: `invocation_id` (the conversation's LATEST recorded run), `invocation_ids` (every run recorded for it, oldest first, deduped by BARE id, capped at 64 — the OLDEST 64 are kept, so on a busy conversation the NEWEST are the ones missing, which is why the latest rides separately in `invocation_id`) and `epoch` (the PROCESS that minted `invocation_id`). Emitted only when the record actually names that fact (`src/server/api-reads.ts` `threadRowOf`/`rosterInvocationIdsOf`): a conversation that never ran names none of the three rather than answering `[]`, and a document predating the field gains the two id keys and stays epoch-free. Values are BARE — never the composite `id\0epoch` run key — so an id here can be posted straight back to the transcript routes, and `epoch` is what lets a client split a RECYCLED id (the invocation counter is per-process, so two conversations can report the same number after a restart) onto the conversation that really ran the frame naming that process. Soft-deleted conversations are absent from this roster; they are reported beside it, on `GET /v1/harness/sessions/:id`, as `inactive_thread_ids` |
| `POST /v1/harness/sessions/:id/threads` | Open an additional conversation |
| `GET /v1/harness/sessions/:id/threads/:threadId` | One conversation's metadata |
| `DELETE /v1/harness/sessions/:id/threads/:threadId` | Delete one conversation (it stops that conversation first, then purges it) |
| `POST /v1/harness/sessions/:id/threads/:threadId/cancel` | Stop one conversation |
| `POST /v1/harness/sessions/:id/threads/:threadId/resume` | Re-run the interrupted turn of one halted conversation → `200` with the receipt of the REQUEUED row (same `turn_id`). The server calls THIS path itself when a conversation's run dies on a network-class failure (`stopReason: 'provider-network'`) and its streak is below the ceiling (see **Recovery policy on restart** under [Server and UI](#server-and-ui)) — and an auto-resume is IN PLACE, so the attempt it abandons is kept as a journal `rollback` line plus the store's `turnRollbacks` evidence (`SessionSnapshot` / `SessionView`, `src/server/protocol.ts`) rather than erased |
| `GET /v1/harness/sessions/:id/threads/:threadId/transcript` | One transcript's state and size (`{ transcript }`: state, `message_count`, `chars`, `bytes`, `role_counts`, `revision`) |
| `PUT /v1/harness/sessions/:id/threads/:threadId/transcript` | Replace it with a whole document — `{ messages, if_revision? }` → the write receipt (see [Editable thread transcripts](#editable-thread-transcripts)) |
| `GET /v1/harness/sessions/:id/threads/:threadId/transcript/messages` | Page through one transcript's messages (`limit`/`cursor`, optional `role`); `total` stays the whole transcript's count |
| `GET /v1/harness/sessions/:id/threads/:threadId/transcript/document` | One transcript as the editor's JSON TEXT document — the edit/export surface |
| `GET /v1/harness/sessions/:id/turns` | Page through recorded turns |
| `GET /v1/harness/sessions/:id/turns/:turnId` | One turn's record metadata |
| `GET /v1/harness/sessions/:id/turns/:turnId/display` | One turn's compiled display tree |
| `GET /v1/harness/sessions/:id/turns/:turnId/events` | Page through one turn's recorded events |
| `GET /v1/harness/sessions/:id/turns/:turnId/steps/:stepId` | One step's recorded request and result together |
| `GET /v1/harness/sessions/:id/turns/:turnId/blocks/:blockId` | One context segment's recorded text |
| `PATCH /v1/harness/sessions/:id/turns/:turnId/blocks/:blockId` | Switch one context segment in or out of the following requests |
| `GET /v1/harness/sessions/:id/turns/:turnId/attachments/:attachmentId` | One attachment's recorded bytes |
| `GET /v1/harness/stream` | The live-update channel: a **WebSocket** upgrade on the `harness.v1` subprotocol (a plain `GET` answers `400` saying so). See [Live updates](#live-updates-the-websocket-stream) |

Every collection read above is paged (`limit` 25 default, 100 maximum, opaque
`cursor`), and every page stamps its collection revision — in the body and in the
`X-Harness-Revision` header — against the per-process `X-Harness-Epoch`, so a client
can order a read against a stream frame. Writes answer SLIM RECEIPTS
(`TaskReceipt`, `ResetSessionResult`, `CancelSessionResult`, `DeleteSessionResult`,
`TranscriptWriteReceipt`, …) and never the mutated aggregate. A path that exists but
not for the verb you used is a `405` naming the verbs it does take.

**Seeding a new conversation.** `POST /v1/harness/sessions` takes
`{ harness, title?, settings? }` and ONE extra field: `messages`, the transcript the
entry agent's default conversation starts with. It is the only piece of recorded state a
client may supply at creation, and only in transcript shape — the same document
`PUT .../transcript` takes (see [Editable thread transcripts](#editable-thread-transcripts)).
Present, including empty, it **replaces** that conversation exactly as a transcript PUT
does, so a seed with no `system` entry runs the agent with no instruction until the next
reset; absent, the profile's own seeded instruction stands. Every entry is validated by the
same reader the runtime and a snapshot restore enforce, **before** anything is created — an
unknown role, an unknown key, or non-string content is a `400` that leaves no session —
and the write then carries the transcript route's live-work guard and durability. An
optional `messageId` on an entry is honoured as a stable address and backfilled when
absent. The seed is initial state, not history: it is written ONCE, never merged or
re-applied on a later create, and it appears in the transcript, not in `/turns`, because
those turns were never executed. To carry an executed conversation across a restart,
restore the session from its own durable record instead — the server reloads what it
committed ([Persistence](#persistence-database_root)), which is the state a seeded
transcript stands in for.

#### The tool call body

**Two execution routes, one body.** `POST /v1/harness/tools/:tool_id/executions` runs a
CATALOGUE tool with no session at all, against the deployment catalogue;
`POST /v1/harness/sessions/:id/tools/:tool_id/executions` runs one inside a SESSION (a
session-bound tool, a session registration, or a harness-owned control tool). Both take
**one wrapper object with a `parameters` property** and nothing else — an unknown body
field is a `400`, and an absent `parameters` is the same empty argument box as
`{ "parameters": {} }`. A session-bound tool asked of the GLOBAL route is a `403` that
names the route to use:
`Tool "toolRequest" runs inside a session; call it through
/v1/harness/sessions/{session_id}/tools/toolRequest/executions.` What `parameters` HOLDS
depends on the tool's schema, and the two forms are not interchangeable:

```jsonc
// files declares ONE property, so the value IS that property (the same unwrapping
// a model call gets and a direct call passes):
POST /v1/harness/tools/files/executions
     { "parameters": [{ "op": "list", "path": ["src", "tasks"] }] }

// its schema, as listed by GET /v1/harness/tools, is still an object:
{ "type": "object", "properties": { "ops": { "type": "array", … } }, "required": ["ops"], … }

// a multi-property tool takes the whole object, because there is nothing to unwrap:
POST /v1/harness/tools/glob/executions     { "parameters": { "patterns": ["**/*.ts"], "paths": ["src"] } }
POST /v1/harness/tools/grep/executions     { "parameters": { "pattern": "TODO", "patterns": ["*.ts"] } }
POST /v1/harness/tools/download/executions { "parameters": { "url": "https://example.com/a.pdf", "name": "a.pdf" } }
POST /v1/harness/tools/search/executions   { "parameters": { "query": "harness docs", "provider": "linkup" } }

// a session-bound tool has no global route: the session moves into the PATH
POST /v1/harness/sessions/…/tools/toolRequest/executions { "parameters": { "tags": ["files"] } }
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

**Harness creation and overrides.** `POST /v1/harness/harnesses` adds a live harness
built from trusted agents and the shared toolbox; `PATCH` changes any harness,
including the shipped templates (`general`, `instruct`, `research`, `workspace`,
`reviewer`, `planner`, `debugger`). Every entry is an editable template copy;
`editable` remains on the wire for compatibility and is always `true`. A
metadata-only `PATCH` (`title`/`description`) preserves the template's captured
factory, so a harness that does not use the live profiled factory keeps whatever it
was built with. An executable `PATCH`
(`agents`/`entry`/`ranks`/`agent_models`/`agent_instructions`/`agent_colors`) rebuilds the
harness as a live profiled harness from the shared toolbox. `agent_colors` is display-only
yet still counts as executable: the map is captured by the factory closure and reaches every
`Agent` built from it, so a stated color must rebuild the factory rather than be stored as a
swatch no agent carries.
`builtin: true` still marks provenance. `DELETE /v1/harness/harnesses/:name` removes one
(or tombstones a shipped name) and answers
`{ deleted: true, harness_name, tombstoned, restored_by_restart: false }`:
`tombstoned` is `true` when a SHIPPED name was removed, and `restored_by_restart` is always
false because the tombstone is part of the durable document — no host restart re-ships it;
only a new release or an explicit re-create (which clears the tombstone) brings the name back.
The route is REFUSED with `409` while any live or restored session belongs to this canonical
harness, or while one of its session removals is still in flight, so sessions must be deleted
individually first (`DELETE /v1/harness/sessions/:id`; there is deliberately no bulk delete and
no cascade). After the registry write is durable the route removes the knowledge articles
attributed to this harness and flushes before answering; a cleanup/flush failure then answers
`500` naming the partial outcome (the harness is already gone, and a repeat DELETE is `404`).
With a database root
the registry is restored from `<root>/harness/index.json` (see Persistence), and
without one it is in memory only. `PATCH` and every other registry edit affect FUTURE sessions
only, because a session freezes its captured preset and descriptor at creation; DELETE is not an
edit and is guarded as above. Both routes validate the request — a REQUIRED `agents` roster of known ids with no duplicates
(at most 16), an optional `entry` that must name a member, an optional `ranks` map whose keys
are members and whose values are single rank letters, reserved aliases
(`writer`/`assistant`/`researcher`) and existing names rejected, bounded
title/description — and reject unknown fields, so a client cannot supply a bare
`instruction`, a provider, or a tool list. THE OLD VOCABULARY IS NOT TRANSLATED: because the
field set is closed (`name`/`title`/`description`/`agents`/`entry`/`ranks`/`agent_models`/
`agent_instructions`/`agent_colors`), a body still sending `primary` or `subagents` is a `400`
naming the ACCEPTED set — that is the intended migration signal, because accepting the old pair
would invent authority for a roster the client never ranked. A lowercase letter is refused the
same way, with the exact shape spelled out:
`` `ranks.a` must be a single rank letter from A (highest) to Z (lowest), upper-case. Received "a". ``

**Saved registry rows and improved defaults.** A restart replays the registry rows
saved in `index.json`, but a shipped default may improve between builds (T3 widened
the real presets' teams and retitled `research`/`workspace`). The conservative rule:
a built-in row whose executable fields (entry, the RESOLVED ranks map, agents, tools,
environmentTools, template, and empty `agentModels`/`agentInstructions`/`agentColors`/`customAgents`
maps) still match the previously
shipped definition recorded in `LEGACY_PRESET_DEFINITIONS`
(`src/server/harnesses/presets.ts`) is treated as an unmodified default and is
refreshed to the current template. The rank map is compared CANONICALISED (`sortedRanks`,
`src/server/harnesses/registry.ts:912-914`, inside `isLegacyShippedDefinition` at `:1163-1200`)
because rank is executable AUTHORITY: a row whose planner sits at Rank B instead of Rank A is a
real customisation and must not be refreshed away. A row that differs in ANY executable field — or
that carries per-agent models — is a real customisation and is replayed exactly as
saved. A title/description the operator edited is preserved across a refresh.
The legacy table itself is written in the current `entry`/`ranks` vocabulary, so it can prove
"nobody customised this" only for a row that already speaks rank — a row still carrying
`primary`/`subagents` is REFUSED on load rather than compared.
Frozen sessions are never rewritten: each session restores from its own recorded
preset and descriptor, so an old conversation keeps the team it started with.

`agent_models` is the one model-shaped field: a map of **selected agent id → model
id**, e.g. `{ "summarizer": "small/fast" }`. A member it omits uses the session's
`settings.model`, so a dropdown can show "default". Values are trimmed, non-empty,
at most 200 characters, and free of control characters; keys must belong to the
resulting FINAL ROSTER set or the request is a `400` naming the members.
Only ids are overridable — never a provider, base URL, or key. On `PATCH` the map
REPLACES the previous one, so `{}` clears every override; changing membership
without restating the map drops the overrides of agents that are no longer selected.
The factory closure captures the map, so a harness edit never rewrites an existing
session: those models change only through `PATCH /v1/harness/sessions/:id` (which merges
and never touches the frozen definition).

`agent_instructions` is the one text-shaped field: a map of **selected agent id →
instruction OVERRIDE**, e.g. `{ "summarizer": "Condense to one line." }`. It is
validated like `agent_models` (keys must be final members; values trimmed, non-empty,
at most 8000 characters, and free of control characters other than tab/newline/CR, so
multi-line prose is legal) and REPLACED wholesale on `PATCH`, so `{}` clears every
override and an agent the map omits runs its trusted `GET /v1/harness/agents` instruction.
A stored value IS the member's **complete prompt**: `agentInstruction(profile, override)`
returns it verbatim, so the profile's `guidelines` are the default an un-overridden
member runs on and are never appended underneath an override, and the shipped profile in
`src/agents` is never rewritten. An instruction edit is EXECUTABLE, so it rebuilds the harness factory and
is persisted with the registry row; a saved session keeps the instructions its agents
were built with (its system messages are already in the transcript), which is why
`PATCH /v1/harness/sessions/:id` still accepts `agent_models` only. The browser's agent dialog
edits all of this as a local draft: nothing is written until its bottom-right action,
and dismissing the dialog sends nothing at all.

`POST /v1/harness/models` takes `{ settings?: { base_url?, api_key?, model? } }` — every
field optional, an unknown field a `400`, and the key is never echoed back. It exists
because the browser must not hold the server key and providers rarely send CORS
headers; the server performs `GET {base_url}/models` with the merged settings and returns
ids only: `{ models, observed_at }`. A blank `base_url` is `400`, a provider failure or
unusable body is `502`, and an empty catalogue is `200` with
`{ "models": [], "observed_at": "…" }`.

No request header is required any more: the legacy `X-Harness-Client: ui` gate is GONE
(`src/server/handler.ts`), and the browser still sends the header as an inert marker.
Access control is an ORIGIN policy, not authentication — the service gateway applies it to
REST, and the SAME rule guards the stream handshake (`isStreamOriginAllowed`,
`src/server/stream/mount.ts`, one definition in `src/shared/origin.ts`), while the
standalone listener sends no CORS headers at all. That is why a cross-origin page dials the
service mount and never `:5181`.

### Live updates (the WebSocket stream)

There is ONE live channel: `GET /v1/harness/stream`, upgraded with the `harness.v1`
subprotocol (`HARNESS_WS_SUBPROTOCOL`, `src/shared/harness-api.ts`). A plain `GET` on that
path is a `400` — `GET /stream expects a WebSocket upgrade (Sec-WebSocket-Key/Version) for
the harness.v1 subprotocol.` — and there is no SSE route left: the run-owning
`POST …/messages` stream and the `GET …/events` watcher were deleted rather than aliased,
and neither ever owned the execution of a queued task.

Both frame vocabularies are CLOSED (`src/shared/harness-stream.ts`):

| direction | frames |
|---|---|
| client → server | `hello` · `subscribe` · `unsubscribe` · `ack` · `ping` · `bye` |
| server → client | `welcome` · `subscription_state` · `update` · `resync_required` · `error` · `heartbeat` · `pong` |

- **`hello`** is optional and is the ONLY resume input: it carries the last `epoch` and
  `cursor` the client applied, and it counts only as the first frame of a connection (a
  late one is refused with `late_hello`). With no `hello`, every subscription starts fresh
  at the server's current position.
- **`subscribe`** is discriminated by `scope`, and the ids ARE the contract: `global` takes
  none, `session` takes `session_id`, `thread` takes `session_id` + `thread_id`, `turn`
  takes `session_id` + `turn_id`. Narrowing a session subscription by conversation is a
  `thread_id` FILTER — a filter removes frames, it does not name a resource. `pace` is
  `ordered` (default) or `ack`, and an `ack` names the highest sequence the client applied.
- **`welcome`** arrives before anything else with the process `epoch` and the `limits` of
  THIS connection; one `subscription_state` follows per subscription, carrying its baseline
  `revisions`, its `seq`, and `replayed_frames` when the server had history to send. A
  client reconciles against those numbers instead of assuming a position.
- **`update`** carries one of sixteen kinds, and no kind carries a session tree:
  `session.updated`, `turn.upsert`, `turn.removed`, `display.ops`, `usage.updated`,
  `action.opened`, `action.closed`, `thread.upsert`, `thread.removed`, `transcript.updated`,
  `records.updated`, `tool.registry_updated`, `agent.registry_updated`, `run.event` (opt-in
  raw events), `catalogue.updated`, `config.updated`. A `display.ops` frame is at most 32
  addressed ops with each append bounded at 2,000 characters, and `records.updated` carries
  two watermarks and no records at all.
- **`resync_required`** is recovery: a cursor from a previous epoch, or one older than the
  replay window (512 frames / 60 s), answers `epoch_mismatch` or `cursor_expired` with the
  `link`ed reads to re-fetch — bounded pages, never a snapshot boot.
- **`heartbeat` / `pong`** keep the connection honest: one heartbeat per 15 s, and three
  missed intervals close it with code `4408`.

The counter policy is the REST policy: cursors are opaque base64url(`epoch:sequence`),
revisions restart at 1 per resource and are compared only WITHIN one epoch, and the epoch
rides every REST response as `X-Harness-Epoch` beside each read's `X-Harness-Revision`. That
string is the process's ONE epoch, minted at module load and never re-minted — and since
2026-11-17 it is the SAME value stamped on every recorded run frame (`thread.epoch`), so a
cursor and a frame naming one epoch name one server process.
Protocol problems are `error` frames with one closed code (`invalid_payload`,
`unknown_subscription`, `unknown_resource`, `unsupported_filter`, `late_hello`,
`too_many_subscriptions`, `frame_too_large`, `rate_limited`, `internal`), and the whole
budget is `HARNESS_WS_STREAM_LIMITS`: 64 subscriptions per connection, 32 client messages
per second, 16 KiB in / 64 KiB out per frame, a 256-frame / 1 MiB send queue, and a 10 s
sustained-stall cut.

The browser keeps exactly ONE of these connections per page (`src/frontend/stream.ts`):
every pane is a scoped subscription on it, a gap (`sequence > expected`) re-subscribes THAT
subscription instead of painting a wrong view, and a dropped socket never cancels a task —
execution is server-owned, so the socket re-opens an OBSERVATION and nothing else, and with
no socket at all the UI keeps working from bounded reads.

### Per-thread CPU isolation (`threadExecution: 'worker'`)

By default the server is single-threaded in the honest sense: every session's turns
interleave on one event loop, and the sentence in [The loop](#the-loop) still holds —
a CPU-bound tool body blocks that loop, so a sibling conversation, a live stream frame
and an HTTP read all wait for it.
`threadExecution: 'worker'` removes that limitation for **server-hosted** sessions:
each live conversation executes on its own OS worker thread.

```bash
HARNESS_THREAD_EXECUTION=worker yarn dev:server    # or: start-service / startHarnessServer()
```

What moves to the lane worker, and what does not:

| Runs on the lane worker | Stays on the coordinator |
|---|---|
| the agent loop, provider stream handling, and **every tool body** (sync, CPU-heavy, or created by `toolCreate`) | the **canonical** harness and session document |
| a queued thread turn **and** the session's root (default-conversation) turn | persistence, the event journal, the display view, and every frame the coordinator publishes |
| a session-bound manual `POST …/tools/:tool_id/executions` call and a slash `/command` (both on the session's operator lane) | the single-flight gate, the queue pump, and cancellation classification |
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
  `toolRequest`, `toolList`, `threadSend`, `threadList`, `threadDelete`, `agentManage`,
  `agentResult`) is **routed**, not executed locally: the lane replica's own
  `harness.runtime` object is replaced, so the canonical harness performs the work
  and the answer crosses back. Tool sources are unchanged. `threadDelete` routes
  because it moves canonical state — the record, its transcript, its invocation and
  branch lookups, and the thread slot the 256 cap counts — and the CALLER's id travels
  inside the request's `identity` (the TARGET is the request's `threadId`), because the
  delete is scoped to that caller's own descendants and must be enforced authority-side
  (`AUTHORITY_RUNTIME_METHODS`, `src/server/workers/capability.ts`).
- a terminal run's archived invocation travels WITH ITS CONVERSATION: the `result:archive`
  operation names the thread the invocation ran in, and the durable projection the
  coordinator keeps reconstructs the same ownership, so deleting a conversation purges
  its results in a worker-mode session exactly as it does inline — including a fork
  branch's result, whose owner is the conversation that forked it
  (`src/server/workers/{lane-commit,lane-authority,lane-worker-loop}.ts`,
  `src/server/sessions.ts`).
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
     members throw whenever they are reached — the one surface it hands out READABLE is `ranks`,
     a fresh frozen copy of the resolved rank map (the replacement for the removed `subagents`
     member) — so a reference the body stores and fires from a
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
  `threadSend`, `threadList`, `threadDelete`) is unaffected, because it is routed to the
  canonical harness rather
  than answered from a private copy.
- no worker entry on disk is a `ServerRuntimeError` naming both candidate paths, and
  a handshake that times out fails the turn.

**The boot posture crosses as data, or the session is refused (B6).** A durable record
carries the team and the declared tool names, but not what the harness was BUILT with —
so a replica rebuilt from the record alone used to run the library defaults: the three
generated plugins came back on a deployment that configured none, the shared toolbox
came back on a tool-less card, and a finite budget became `Infinity`. Every lane now
carries the serializable half of the boot configuration in its `hello` blueprint
(`LaneBlueprint.presetRebuild` / `.plugins`, `src/server/workers/protocol.ts`) and
rebuilds with it. `laneBootPosture` (`src/server/workers/capability.ts`) is the ONE rule
the creation gate and `blueprintFor` share:

| Boot configuration | Lane behaviour |
|---|---|
| per-card/deployment `sharedToolbox`, `websearch`, `webfetch`, `maxIterations`, `extraToolSources`, `toolFolders` | carried in `presetRebuild.toolbox`, passed to `presetFromRecord(record, undefined, toolbox)`; the rebuilt card's materialized posture is verified before hello, and a mismatch faults the handshake (`preset-not-rebuildable`) rather than running a different harness |
| `harness.plugins: []` (a server seam's zero default) | `plugins: { kind: 'none' }` → the replica passes `plugins: []`, so no generated built-in reappears |
| `harness.plugins: BUILTIN_PLUGINS` (or a subset, accepted only by element identity) | `plugins: { kind: 'builtin', names }` → the replica registers exactly those generated entries, in the same order |
| any other plugin list (`setup` is a closure) | refused at `POST /sessions` (400, `plugins-not-rebuildable`) |
| `harness.commands` (one handler closure per command) | refused at `POST /sessions` (400, `commands-not-rebuildable`) |
| `extraTools` (a constructed `Tool` definition) | refused at `POST /sessions` (400, `extra-tools-not-rebuildable`) |
| a host-supplied `create` factory | refused at `POST /sessions` (400, `preset-not-rebuildable`, unchanged) |

A direct `new SessionStore` that never configures plugins omits the blueprint field and
keeps the factory default (the generated set) on both sides — the same omission the
canonical harness makes. The end-to-end matrix is pinned by
`src/server/workers/lane-boot-posture.test.ts` (the rule, the real
blueprint→`structuredClone`→rebuild path, and one spawned zero-plugin lane).

Guidance for a live run is honest in the same way. A focused submit into a running lane is
answered from the lane's own `steer.result` receipt, never from the frame the coordinator
posted: `steered: true` means the executing conversation took the text (and it lands in that
conversation's canonical transcript), while a refusal — a run that is not at a steerable point,
or a lane that stopped — becomes an ordinary queued continuation. The declared memory window is
recomputed the same way it is trusted: from the tool revision that is installed NOW, so a tool
created or replaced after the session started widens the window instead of being scanned against
a snapshot from session creation.

**The one piece of conversation state that is neither routed nor refused: the display
lane.** It is the number the context bar stacks its rows by, and the shipped
`summarize` compaction raises it mid-run (`harness.threads.setContextLane`,
`src/harness.ts`). No `SharedMutation` kind carries a lane
(`src/server/workers/lane-commit.ts` — `thread:status` digests status and label
only), so the bump has no route to the canonical record the recorder reads, and it is
deliberately NOT refused: a tool body would be blameless for losing a cosmetic marker,
and refusing it would close a door that costs nothing to walk through. The loss, stated
plainly: in worker mode a session that compacts keeps **one-row** context bars with every
event stamped lane 0, where the same session on the default inline engine paints that
boundary as two stacked rows. Everything the compaction actually does is unaffected — the
summarize call, the history it replaces, and the transcript it commits cross back like any
other turn content — and the value is **lost**, not deferred: a rebuilt lane reads the
canonical record and starts on lane 0 again. The capability list the session reports
carries this as `LIMITATION (display lane, not routed)`, so an operator flips the switch
knowing the context bar goes flat.

Compatibility is unchanged: the default stays `inline`, no existing host changes
shape on upgrade, and a worker session answers exactly the same HTTP surface.

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS_THREAD_EXECUTION` | `inline` | `inline` or `worker`; any other value aborts startup |
| `HARNESS_WORKER_IDLE_MS` | `120000` | reclaim a lane worker after this much idle time (`0` = keep it until the session goes). 0–3600000 |
| `HARNESS_MAX_LANE_WORKERS` | `16` | upper bound on concurrently live lane workers — each owns a full harness replica, so this is the memory guard. 1–64 |
| `HARNESS_WORKER_HANDSHAKE_MS` | `60000` | bound on worker import + build + capability report. 1000–600000 |
| `HARNESS_WORKER_ENTRY` | unset | explicit worker entry file; unset resolves the package's own source entry (`src/server/workers/lane-worker.ts`) |

Values are **validated, not coerced**: `HARNESS_WORKER_IDLE_MS=12s` aborts startup
naming the variable and the accepted range, because an approximated runtime is the
one thing this mode may not do.

The lane worker is a published entry point — `@underload/harness/worker`, which is
`src/server/workers/lane-worker.ts` itself (`package.json` `exports`). Resolve order is:
the configured `workerEntry` (a missing file aborts startup naming the variable), then the
package's own source module (`src/server/workers/lane-host.ts:160-186`). The thread loads
that TypeScript through Vite's module runner (`src/server/workers/worker-boot.mjs`), so
there is no built bundle to try first and no Node flag to add. A cold lane measures
~1.6–2.4 s in source mode (it rebuilds the harness, recompiles created-tool sources and
restores the snapshot), and reclaim is always safe because the next turn rebuilds from
committed state.

Branch state is deliberately absent from snapshot v2 (a `harness.branch` listing belongs
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

A durable server writes two kinds of thing: the checkpoint **shards** —
`harness/index.json`, one `harness/sessions/<id>/session.json` per session and one
`harness/sessions/<id>/threads/<threadId>.json` per conversation, each a compact
`JSON.stringify` of its own unit (`src/server/persistence.ts:2364-2381`) — and one JSON
line per harness event under `harness/sessions/<id>/events.jsonl`
(`src/server/journal.ts:90-92`). Inline, both happen on the request loop, so a big
checkpoint is a synchronous block that every other session and every live stream
connection pays for. `ioExecution: 'worker'` moves **the write side of
durability** onto one IO worker thread per database root:

    HARNESS_IO_EXECUTION=worker yarn dev:server    # or runtime: { ioExecution: 'worker' }

What does NOT move is the authority. The coordinator still decides what the next
document and the next journal line are, and in what order: it builds the record
exactly as before (`databaseRecord`), splits it into shard units
(`harnessShardUnitsOf`, `src/server/workers/io-client.ts:491`), and hands those to
`src/server/workers/io-client.ts` instead of calling `persistence.save()` — one
`shard.save` frame per file, in the commit order the inline writer uses
(`IO_SHARD_ORDER`, `src/server/workers/io-protocol.ts:161-176`). The thread serializes
each unit and performs its syscalls (`fs.*Sync`, one operation at a time, so each
shard's rename stays one-writer) and answers with a receipt per shard. Three
consequences, stated rather than smoothed over:

- **Strict saves become awaited.** `persistOrThrow`, and the store methods that
  contain it (`create`, `enqueue`, `reset`, `remove`, `cancel`, `cancelThread`,
  `deleteThread`, `updateThreadTranscript`, `setAgentModels`, `persistRegistry`,
  `mutateRegistry`), resolve only after the worker's rename receipt **for every shard of
  that commit** — one frame answers for itself, and nothing claims "all shards durable"
  from the index receipt (`io-protocol.ts:72-77`) — so a 201/200 still means "durable
  before the response". A failed commit rejects with the exact message the inline writer
  throws, and the caller's rollback still runs.
- **Best-effort saves claim order, not durability.** The core state-change observer,
  the interval `checkpoint()`, and every journal event append stay SYNCHRONOUS and
  enqueue the work (a burst of observer fires coalesces into one commit of the newest
  payload **per shard path**, and a shard that was replaced answers `superseded`, counted
  in total and per path — `io-client.ts:51-64`, `:1018-1042`). They are never presented
  as durable; a crash in that window can lose what
  was queued, never what the strict path already acknowledged.
- **Terminal commits are fenced, which inline never was.** A transition whose document
  lists journaled events (`cancel`, `cancelThread`, the turn-start write, a command
  turn's terminal write) commits through `io.commitCheckpoint({ document,
  fenceSessions: [session.id] })`: that session's journal tail is fsynced and
  acknowledged BEFORE the file that lists those events is renamed — under the sharded
  layout that file is the session's `session.json`, and the fence still lands on it
  because the queue is FIFO (`io-protocol.ts:36-42`). Strictly
  stronger than inline, which never fsynced there.

Reads stay on the coordinator (`persistence.load()`, `journal.read()`): a restore runs
before the server answers anything, and queueing it would serialize a cold start behind
a pending compaction for no gain. In worker mode the coordinator keeps a journal
instance ONLY as a reader, so there is still exactly one writer per file.

Ordering is load-bearing and comes from the queue: frames are posted in call order and
answered one at a time, so a journal append is on disk before the checkpoint that lists
it, a reset's truncate precedes the record that forgets those turns, and inside one
commit the thread shards are posted before the `session.json` that indexes them and that
before `index.json` (`orderIoShardUnits`, `io-protocol.ts:161-176`, `:573`) — so a reader
that starts at `index.json` never follows a reference to a shard written after it. There is no
inline fallback anywhere — a missing entry, a host without `node:worker_threads`, a
thread that dies, or a protocol-version mismatch throws a named `HarnessIoError`, fails
every outstanding operation, and aborts startup: a listener never binds its port until
`store.ioReady()` settles. Shutdown is awaited too: `startHarnessServer().close()`
awaits `store.drainIo()`, which flushes the coalesced slot, fences the held journal
handles, and reports every operation that never received a durability receipt.

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS_IO_EXECUTION` | `inline` | `inline` or `worker`; any other value aborts startup |
| `HARNESS_IO_WORKER_ENTRY` | unset | explicit IO worker entry file; unset resolves the package's own source entry (`src/server/workers/io-worker.ts`) |

The cost that stays on the main thread, honestly: building the record (the authority
owns the state) and the structured clone `postMessage` performs on each frame — and the
split does **not** make that clone proportional to what changed. Every checkpoint re-fans
the **whole document** into shard units (`harnessShardUnitsOf`), and the client posts one
frame per unit: `commitShardEntries` posts all of them for a strict commit, `flushDeferred`
posts every unit the coalesced slot holds for a queued one (both in
`src/server/workers/io-client.ts`). Per-commit fan-out, clone and worker-side stringify are
therefore still O(total store), and a sha256 of every shard rides that same pass in **both**
modes — inline in `commitShardIfChanged` (`src/server/persistence.ts:2994-3011`), worker mode
on the worker itself (`harnessShardDigest`, `src/server/workers/io-worker-loop.ts:356`, judged
at `:359-367`), where it is off the loop but not free. What shrinks in both modes is the
**write syscall and the failure radius** — one conversation's bytes are one file's
`mkdir/open/write/fsync/rename`, a shard whose bytes did not change is not opened at all, and
an oversized or failing shard costs only its own file —
not the per-commit CPU. A shard frame is bounded by `maxFrameBytes`
(64 MiB): the worker measures the serialized length before touching the disk and feeds
that number back **for that path**, so a permanently oversized conversation fails loudly,
stops paying its own clone, and does not freeze the writes of every other session
(`io-worker-loop.ts:322-341` measures, `io-client.ts:912` caches it per path,
`:1288-1292` refuses). Off-loading is a bounded cost moved off the loop, not a zero-cost win.

The IO worker is a published entry point — `@underload/harness/io-worker`, which is
`src/server/workers/io-worker.ts` itself (`package.json` `exports`). Unset, the client
resolves that specifier through the package's own manifest (`src/server/workers/io-client.ts:381-430`);
the thread loads it through the plain-JS bootstrap `src/server/workers/worker-boot.mjs`
and the harness Vite module runner, so no build step and no Node flag is involved.
Because the manifest says `"sideEffects": false`, the entry calls `startIoWorker()`
explicitly: an entry that merely imported its loop compiled to a bundle that answered
no frames at all.

Cross-references: `src/server/workers/io-protocol.ts` (the frames and the three
outcomes `durable` / `written` / `superseded`), `src/server/workers/io-client.ts` (the
FIFO queue, the handshake gate, and the numbered integration contract at the bottom of
the file), `src/server/workers/io-worker.ts` and `io-worker-loop.ts` (the thread),
`src/server/sessions.ts` (the worker branches — search for `this.io`),
`src/server/io-worker-bridge.test.ts` (store + standalone-server proofs, including the
off-thread durability round trip), and `src/server/workers/io-client.test.ts` (ordering, barriers, error
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
- **Deletion is authoritative at once.** `DELETE /v1/harness/sessions/:id/threads/:threadId`
  answers a SLIM receipt (`{ deleted: true, thread_id, session_id, removed_descendants,
  removed_turns, revision }`), and the client treats any authoritative page that no
  longer lists a thread the same way (so an API/other-tab deletion is learned
  identically): the thread's turns disappear, its focus is dropped — even while a
  pending optimistic row still names it — and any `#` reference chip that pointed at
  one of those turns is removed from the draft (the reader is told) instead of
  failing the next submit (a failed submit restores its draft without any dead
  reference). The deletion is also remembered locally — scoped to its session — so a
  late snapshot, stream update or in-flight answer cannot bring the thread back,
  re-focus it or delete a newer row. Labels of surviving blocks never change.

Wire additions are optional and additive, so an older server keeps working: a
snapshot without `threads` leaves the routing decision to focus alone, a turn
without `threadId` renders no badge, and a submit with no target omits `thread_id`
(the pre-thread body).

```
POST   /v1/harness/sessions/:id/tasks       { input, attachments?, references?, thread_id? }
GET    /v1/harness/sessions/:id/threads                    -> a PAGE of conversation rows
GET    /v1/harness/sessions/:id/threads/:threadId/transcript -> { transcript } — state and SIZE only
GET    /v1/harness/sessions/:id/threads/:threadId/transcript/document -> { document, transcript_state, revision, … }
PUT    /v1/harness/sessions/:id/threads/:threadId/transcript { messages, if_revision? } -> a write receipt
POST   /v1/harness/sessions/:id/threads/:threadId/cancel { }   -> { cancelled, thread_id, session_id, status, dropped_queued_tasks, revision }
POST   /v1/harness/sessions/:id/threads/:threadId/resume { }   -> the submit receipt, re-running the interrupted turn
DELETE /v1/harness/sessions/:id/threads/:threadId            -> { deleted: true, thread_id, session_id,
                                                  removed_descendants, removed_turns, revision }
POST   /v1/harness/sessions/:id/cancel      { all: true }      -> { cancelled }
```

- The thread-cancel receipt is the store's own answer, never a constant: `cancelled` is
  true exactly when this call TERMINATED work — it aborted a live run, released a turn
  parked in a reference wait, or dropped at least one queued continuation — and `status`
  is the conversation's real post-stop status read from its own record (the value its
  roster row carries, when it has one). `dropped_queued_tasks` counts the NAMED
  conversation's own backlog, measured before the stop, so it is a floor and not the
  total the cascade discarded.
- The thread-delete route now STOPS that conversation first (the same stop above) and
  then purges it, so deleting a conversation with live or queued work no longer needs a
  preceding cancel. A turn in ANOTHER conversation that merely `#`-references a turn of
  the deleted one keeps running: its link is dropped, its label is kept as
  `turn.strippedReferences`, and it composes the "result was deleted" note instead of
  running without its input.

A `/tasks` submit whose `input` starts with `/` is a **slash command**, not a prompt:
the `202` envelope is identical, but its `turn` is already terminal because the server
executed it in this process — see [Slash commands](#slash-commands).

### Editable thread transcripts

A conversation's transcript is the user's own JSON, and the transcript dialog in the
browser UI edits it. Only `messages` are editable: turns, events, statuses, timestamps
and `usage` stay server-owned history, because they are the record of what actually
ran, not an input to it.

**Three reads, because they cost different things.** `GET
/v1/harness/sessions/:id/threads/:threadId/transcript` answers METADATA only
(`{ transcript }`: `transcript_state`, `message_count`, `chars`, `bytes`, `revision`,
`role_counts`, and `unreadable_reason?`) — the row a client opens with, at constant size.
`GET …/transcript/messages` pages the entries (`limit`/`cursor`, optional `role` filter,
and `total` counting the WHOLE transcript so a filter never renumbers the cursor). The
editor reads `GET …/transcript/document` (`TranscriptDocumentResponse`):

```json
{
  "session_id": "ses_01…",
  "thread_id": "0f0d…",
  "agent": "instruct",
  "revision": 7,
  "transcript_state": "ok",
  "document": "[\n  {\n    \"role\": \"user\",\n    \"content\": \"draft a plan\"\n  }\n]",
  "content_type": "application/json"
}
```

- `document` is the pretty-printed (2-space) JSON the editor holds and edits, generated
  from the LIVE transcript the model will be sent next;
- when the stored value cannot be read, `transcript_state` is `"unreadable"` and
  `document` is the BROKEN value verbatim — the text the operator is fixing;
- there is NO session-level transcript path: the DEFAULT conversation is addressed by
  its own `thread_id` (an `agent:<name>` row), and every transcript route names one
  `threads/:thread_id`.

`PUT …/transcript` with body `{ messages, if_revision? }` replaces the whole transcript
and answers a SLIM RECEIPT (`TranscriptWriteReceipt`), never the mutated aggregate:

```json
{
  "session_id": "ses_01…",
  "thread_id": "0f0d…",
  "accepted_as": "transcript",
  "message_count": 1,
  "revision": 8,
  "links": { "transcript": "…", "messages": "…", "document": "…" }
}
```

`accepted_as` is `"raw"` when the submitted value was stored as unreadable, and then
`invalid: { error, stored_type }` says why; `links` points back at the three reads so a
client repaints from one response.

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
| `405` | a verb the path does not take: the transcript path serves `GET`/`PUT`, and the document is its own path (`…/transcript/document`, `GET` only) |
| `409` | the thread is running (stop it first), the session's harness handle predates `setThreadMessages`, **or** `if_revision` did not match — `This transcript is at revision N; the write expected M. Re-read before writing.` |

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
in a conversation's `threads/<threadId>.json` cannot cost the whole session: the store validates every host thread's
`messages` before `harness.restore()` and neutralises the unreadable ones with the same
placeholder, keeping each thread's id, agent, label and turn links so the roster can
still address it
(`tolerateThreadTranscripts` / `mergeInvalidTranscripts`, `src/server/sessions.ts`).
The tolerance is deliberately scoped to host threads: an invalid **default**
(`agent:<name>`) conversation still fails the restore and drops the session, because
that transcript is what the entry point runs and a placeholder there would silently
rewrite the entry agent's own conversation. Retention also covers a default conversation
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

The browser client surface is `getTranscriptMetadata(id, threadId)`,
`listTranscriptMessages(id, threadId, …)`, `getTranscriptDocument(id, threadId)` and
`putTranscriptDocument(id, threadId, messages, ifRevision?)` (`src/frontend/api.ts`); the
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
  queue are cancelled. CORRECTED IN PLACE 2026-11-13: this bullet then claimed "Reset,
  New session, and tab switches stay locked while work is pending" — none of that shipped.
  New session (`+`) stays ENABLED during a live run, which is how a second independent
  conversation is started while the first one streams (its gate is
  `submitting || !booted || archivedSelection`, `src/frontend/main.ts:11220-11225`, and a
  run is not in that expression); switching conversation is a view change that only
  unsubscribes the observer, and the header cycler is never disabled by pending work.
  There is no Reset button to lock: starting over is New session, and
  `POST /v1/harness/sessions/:id/reset` remains a server route for other clients.
- **The agent name inside the composer frame is the "who answers next" switch, and it is local
  until you send.** On a keyboard, `Tab` and `Shift+Tab` while you type step through the team's
  agents (forward, backward, wrapping at both ends), while clicking that name — or `Enter`/`Space`
  on it — opens the agent settings dialog exactly as before. With a thumb, a tap switches to the
  next agent and a press-and-hold (about half a second; a finger that slides off it cancels the
  press instead) opens that same dialog. Which half you get follows the INPUT device, not the
  window width, so a narrow desktop window keeps the keyboard rules and a wide landscape phone
  still taps. Cycling costs no request and writes nothing: the name in the frame is the only
  thing that changes, and the choice belongs to the conversation you are in, so switching
  conversations or starting a new one forgets it. Your next send commits it — that
  message runs the agent you picked, in a conversation that agent owns, and the name then falls
  back to the team's entry agent for the message after — and nothing about the harness definition
  changes: no promotion, no team edit, no `PATCH`. A team with one agent, or a Tools/Plugins view
  that hides the name, leaves `Tab` as the plain focus move it always was, and the button states
  the reason. Switching agent while a conversation is expanded releases that focus, because each
  conversation runs its own agent, so the routing line above the field reads `New thread` and your
  message really does go to the agent you picked.
- **A live turn can say WHY it looks quiet.** While a turn is running, its tile carries the
  composition line from [`progress`](#progress-events) (a tool block being written) and, when
  nothing has reached the browser
  for a while, a quiet/silent note with the same fact phrased plainly — the composition line reads
  `composing N tool call(s) · <chars> chars` (`src/frontend/ui/turns.ts:891-893`) and the note reads
  `still generating · quiet for <duration>`, with "— the run is still working" added on the 30 s
  grade (`src/frontend/ui/turns.ts:4829-4830`). Both are about what THIS VIEW received,
  never a verdict on the run: the thresholds are 5 s and 30 s of silence, they change only what the
  interface is allowed to say, and a note appears beside a turn that is still streaming. The
  per-agent rings use the same two-step vocabulary, computed from their own per-agent receipt
  stamps (`gradeActivityFromStamps` — cited by SYMBOL, `src/frontend/ui/activity.ts`) and repainted from the
  document and stream paths (`src/frontend/main.ts:7455, 13988, 14437, 14601`); while an agent is
  active a 1 000 ms clock re-grades them (`ACTIVITY_GRADE_TICK_MS`,
  `src/frontend/main.ts:6732, 6761-6789`).
- **Reload and switching recover from the record.** Selecting a session that still
  has work opens one `GET /v1/harness/stream` observer (a submit also opens or reopens
  it); a lost socket is re-opened with its
  `hello` cursor, and while none is open the pane keeps working from bounded reads
  (`GET /v1/harness/sessions/:id/turns` paged), reconciling turns by id, until the
  observer
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
  silently blocking the turn — and it fires only while an **`async`** call is pending.
  A board waiting on `sync` work alone therefore produces no `wakeup` line at all: its
  pending line stays the static snapshot taken when the call launched, until the call's
  own result closes the card. Nothing in the pane advances that line on a clock, and
  nothing has to — the run is woken by the settlement itself.
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
first, then every direct-call tool — and calls `POST /v1/harness/tools/:id/executions` for all of
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
`delegate` is listed for every host but only exists in a session whose harness RANK map
spans two or more distinct letters, i.e. while some agent holds a strictly-lower-ranked
peer; otherwise the tool is not registered at all and the call answers a clear `404`.
`actionRequest` and
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
(`POST /sessions/:id/cancel`, `DELETE /sessions/:id`, or a per-thread stop —
NOT a closed stream: dropping the WebSocket cancels nothing)
signals every call that is running, and `toolCancel({ callId })` targets one call.
`toolCancel` logically settles/aborts that call's own task; its late result is
ignored, and cancelling an already settled (or already cancelled) call succeeds
without an error — cancellation is a state, not a one-shot transition.
`shell` honours the abort signal and kills its process tree, and
`ToolContext.signal` is the same signal a tool can watch: the four filesystem tools check it at every
batch boundary and refuse with the published `ECANCELED`, `details.rawCode` naming the reason the
host passed to `abort()` and the same object kept as the rejection's `cause`. Arbitrary JavaScript
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
Vite only and proxies `/v1/harness` to the service gateway; `yarn dev:server` is the
separate standalone API launcher (explicit, no Vite). Production hosting is the
service gateway below.

### The scratch board's live panels (Tasks and Records)

The scratch board mounts two first-party panels over the session's record store:
`harness.tasks` (title **Tasks**) above `harness.records` (title **Records**). Both
are `scratch`-slot, `requiresSession: true`, and **display-only** — every control is a
reader-side affordance, never a write. The first is the card's own title, its collapse
control, and both cards ship **closed**. Nothing boots until the reader presses a title:
that press is what makes the one snapshot read and the one realtime registration, and
closing the card releases both and clears its surface, so opening it again is a fresh
read, never a stale view kept "live" by nothing. On a phone, closing the whole board
suspends both cards at once: their reads park while the board is shut, and their rows,
filter and open details are still there when it opens again. The other controls are a
task row opening its own detail (the collapsed row is a tick-or-cross mark plus its text,
and pressing it reveals the full text, the meta line and the record's history), the
records panel's collection filter chips, the "N new" follow pill, and a Retry where a
read failed. Nothing writes: the agent owns the store, so a checkbox that looks clickable
but is not would be a lie.

- **Data, once, then deltas.** Each panel reads the two bounded REST reads
  (`GET …/records` for the snapshot, `GET …/records?since=` for the delta) — and a
  closed card reads nothing at all, because opening it is what builds the engine. The
  `records.updated` wake carries the store's watermarks and no records at all, so it
  is a nudge, never a payload; the two panels share ONE registration on that topic
  (`extensions/records-wake.ts`), held only while a card is open on a shown board, and
  a burst costs one delta read, not one per frame. There is no polling anywhere. A delta
  answering `reset: true` — or a `collections_rev` that moved out from under the card — throws
  its local state away and re-bootstraps from the snapshot read, because that boolean is the
  store-wide plane's ONLY gap signal: the window keys a `tasks` reader sees
  (`oldestAvailableRev` / `droppedEvents`) stop at the per-collection feed and never cross this
  route, so the panel has one honest recovery and takes it.
- **Five states, and the panel says which one it is in.** `loading`, `empty`, `error`
  with a Retry, `stale` (rows on screen that may be behind), and `ready`. The state is
  published as `data-phase` on the panel root, so the stylesheet and assistive tech read
  the same fact the reader sees. A closed card has no state to report: it carries no
  `data-phase` and the corner box stays blank and hidden — it is not reading, so it has
  nothing to say about a read. A fixed box in the open card's top-right corner names it in
  one word — no skeleton is ever laid over the list, because a block of bars inserted and
  pulled out on every re-read is what made the tile flicker — and while a read is
  outstanding that box says `reading` whatever `data-phase` says: an unanswered fetch is
  not a verdict on the rows already on screen, so the rows, the phase and the sync
  sentence hold still and only the corner word moves (`recordsCornerStateOf`, fed by
  `RecordsClient.fetching`, which stays up across the body-refresh debounce so the word
  never blinks between a delta and the re-read it queued).
- **A change speaks about itself.** A live row lands with its identity and order at
  once and its values one debounced re-read later, because a change row names the
  fields it touched and carries no values. A value that is not knowable renders `—`
  with a tooltip rather than being invented. Rows key by record id, so a task that
  completes is the same element travelling from Pending to Completed, and rows that
  just landed carry a short highlight plus a word — never a strike or a colour alone.
- **A reader who scrolled away keeps their place.** New rows above the reading
  position raise a "N new" pill instead of shoving the list; the panel follows the
  bottom edge only while the reader is already at it.
- **A screen reader hears the same story** through a pre-mounted `role=status`
  region: sentences about what landed ("agent added a task: …"), coalesced into one
  write per burst, and never the rows a first read brought in (arriving is not an
  event). `prefers-reduced-motion` drops every animation.
- **Failures stay local.** A panel whose read fails, whose plane died, or whose
  registration was refused explains itself in its own rail; its neighbour and the
  shell are untouched. A conversation switch drops the rows, the filter and the
  registration it belonged to.

Their CSS is one clearly-marked section at the end of `src/frontend/styles.css`,
namespaced `.panel-tasks-*` / `.panel-records-*`, with nothing overridden above it.

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
discovered. The frontend dev launch expects this service (its `/v1/harness` proxy
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
  "api_root": "/v1/harness",
  "service": "noobscript-harness",
  "api_version": "v1",
  "server_time": 1762819200000,
  "epoch": "mwk24rfs-222y0t4w3p13",
  "capabilities": {
    "websocket_stream": true, "tool_execution": true, "tool_registration": true,
    "transcript_editing": true, "command_dispatch": true, "model_discovery": true,
    "harness_definition_writes": true, "agent_writes": true, "persistent_threads": true
  },
  "limits": {
    "body_bytes": 1000000, "submit_body_bytes": 16777216, "input_chars": 200000,
    "pending_tasks": 100, "thread_records": 256, "attachments_per_turn": 4,
    "attachment_bytes": 4194304, "total_attachment_bytes": 8388608,
    "result_references": 16, "pending_actions": 4, "steer_records": 64,
    "created_tools": 32, "tool_result_bytes": 262144,
    "page_limit_default": 25, "page_limit_max": 100
  },
  "links": {
    "self": "/v1/harness", "health": "/v1/harness/health", "config": "/v1/harness/config",
    "harnesses": "/v1/harness/harnesses", "agents": "/v1/harness/agents",
    "tools": "/v1/harness/tools", "plugins": "/v1/harness/plugins",
    "models": "/v1/harness/models", "sessions": "/v1/harness/sessions",
    "stream": "/v1/harness/stream"
  }
}
```

This document is **constant size** (`ServiceInfo`, `src/shared/harness-api.ts`): it
carries identity (`api_root`, `service`, `api_version`, optional `build_version`,
`server_time`), the per-process `epoch` every revision and stream cursor is compared
within, the capability advertisement, the enforced `limits` (the same numbers a refusal
quotes — 100 pending tasks, 4 attachments per turn, 25/100 page limit), and the link map
a client follows from there. NO harnesses, agents, tools or sessions are embedded: each is
its own paged read, so booting costs one small response instead of the whole catalogue.

`api_root` is the **API URL this document was served from**, not a filesystem
path. There is deliberately no advertised workspace root: the file and command
tools resolve relative paths against the server process's working directory
(`process.cwd()`) and have no sandbox or fence, so a file-root option would
promise behaviour the tools do not implement. The service's `variables.root` is
the shared database/storage boundary: the harness endpoint uses it as the durable
database root (below `<root>/harness/`), never as a workspace.

**Streaming from your own endpoint.** The loader offers an endpoint exactly two
passthroughs (`packages/underload/service/src/server/start.ts:357-387`):
`{ raw: Response }`, which it returns untouched, and `{ stream: AsyncIterable }`, which
it feeds to hono's `streamSSE`. Prefer `raw`, and do not write the writer:
`createHarnessSseResponse(start, signal)` — exported from `@underload/harness/server`,
and the same function both in-package adapters use — builds the response with the
`: connected\n\n` preamble, one `data: <json>\n\n` frame per item (the shape the shipped
UI already parses), `X-Accel-Buffering: no`, a frame that waits for the consumer's next
pull instead of buffering a transcript into memory, and the step the `{ stream }` shape
**cannot** express: `cancel()` (tab closed) or an aborting request signal aborts the
signal handed to `start`, so a browser disconnect actually cancels a run. `{ stream }`
is fine for a producer with nothing to cancel, but the loader only stops writing on
`stream.aborted` and never tells the handler, so a `{ stream }` handler running anything
cancellable must wire its own abort from `context.req.raw.signal` and pass it in — that
one line is what decides whether a disconnect stops a run or only stops a socket. The
other thing the loader does quietly is pre-parse a JSON body with no cap, which is why
`src/server/endpoint/harness/service-route.ts` declares `body: 'raw'`: the endpoint then
streams the body through the route-aware cap in `bodyLimitFor` (`src/server/api.ts:744`)
— **16 MiB** (`MAX_SUBMIT_BODY_BYTES`) for `POST /v1/harness/sessions/:id/tasks`, the one
route that carries base64 attachments, and **1,000,000 bytes** (`MAX_API_BODY_BYTES`) for
every other route — rejecting an over-sized payload before the whole thing is in memory.
Pinned by `src/server/sse-writer.test.ts`.

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

The store is version 2 (`HARNESS_DATABASE_VERSION`, `src/server/persistence.ts:208`)
and it is **one logical document spread over a directory tree**, one file per session
and one per conversation: a single file holding every session and every transcript does
not survive the population this server is meant to reach (hundreds of sessions,
thousands of conversations), and it had to be re-stringified and re-fsynced whole for the
smallest change. A supplied root owns exactly one namespace and never writes at the root
itself (`HARNESS_DATABASE_DIRECTORY`, `persistence.ts:200`):

```text
<root>/harness/index.json                              the document header: `version`, `savedAt`,
                                                       `registry`, the optional `deleted`,
                                                       `globalSettings`, `pluginSettings` and
                                                       `toolSettings` blocks, and the ordered
                                                       `sessions: [{ id, ordinal }]` list
                                                       (`harnessIndexDocumentOf`, :2289-2306)
<root>/harness/sessions/<sessionId>/session.json       ONE session record: identity, the
                                                       **frozen** preset metadata + descriptor
                                                       it was created with, provider settings
                                                       **without the API key**, timestamps,
                                                       status and error, every turn (events,
                                                       per-event times, usage), the pending
                                                       queue order, the live per-agent model
                                                       map and the last committed core
                                                       snapshot — with every `core.threads[]`
                                                       row stripped of its `messages`
                                                       (`splitHarnessSessionRecord`, :2320-2358)
<root>/harness/sessions/<sessionId>/threads/<threadId>.json
                                                       ONE transcript: `{ version, sessionId,
                                                       id, messages }`. The smallest unit a
                                                       recovery tool picks up alone, so it
                                                       carries the version and the session that
                                                       owns it (`serializeHarnessShard`,
                                                       :2364-2381)
<root>/harness/sessions/<sessionId>/events.jsonl       the per-step append-only journal —
                                                       UNCHANGED by the split, and it shares
                                                       the session directory with `threads/`
                                                       (`src/server/journal.ts:90-92`)
<root>/harness/agents.json                             the global agent overlay — UNCHANGED:
                                                       same location, same commit helper
                                                       (:2939, :2994-3008)
```

Every session and every conversation is therefore a file a `shell` can read: one
session's row is `session.json`, one conversation's transcript is
`threads/<threadId>.json`. A shard's file name comes from the row's id and must match
`HARNESS_THREAD_ID_PATTERN` (`^thread-[1-9][0-9]*$`, `:219-226`) before it is
path-joined, so a hand-edited `../../x` cannot address a path outside its session
directory. `load()` reassembles the tree into the ONE object graph the rest of this
package has always received — sessions in `index.json` order, each `core.threads[]` row
carrying the `messages` that now live in a shard — and runs the identical
`readHarnessDatabase` validation on the merged result (`:2576-2689`). Nothing else moved:
the in-memory model, every validator, the restore pipeline and `SessionStore` are the
code that was there before the split.

Branch records and the runtime's pending action-request promises are **not** in
the store. `branch_start`/`branch_end`/`action_request`/`action_answer` events
are recorded inside their turn (so a reload can render the conversation), but no
branch transcript is restored and no question is resumed.

A row whose id is not a generated host id KEEPS its `messages` inline in
`session.json`: it has no safe file name, and dropping the transcript would lose bytes
the previous layout stored (`:2312-2319`). Such a row is refused by
`src/core/snapshot.ts` on restore either way.

**The rank model is a CLEAN BREAK on disk, not a translation.** The stored roster fields are
`entry` and `ranks`, and every door that reads them refuses the old vocabulary outright:

- a saved registry row or a frozen session descriptor carrying `primary` or `subagents` is
  REFUSED at load, naming the label and telling the operator to re-save in the new shape or
  start from a fresh database root (`requireNoLegacyRosterKeys`, `src/server/persistence.ts:697-706`,
  called for the frozen descriptor at `:746` and for the preset record at `:837`);
- a stored `ranks` value must be ONE rank letter —
  `<label>.<agent> must be a single rank letter
  from "A" (highest) to "Z" (lowest).` (`readRankMap`, `:717-731`);
- the harness SNAPSHOT is version 3 (`HARNESS_SNAPSHOT_VERSION`, `src/core/snapshot.ts:107`) and
  answers `Snapshot version 2 is not supported; this harness reads version 3.` (`:1205-1207`).
  It will not guess: a v2 transcript record's `role: 'primary' | 'subagent'` maps to a rank only
  by assumption, and v3 lets any number of agents share Rank A, so a v2 file is refused while its
  records are read as `rank` (`:302-316`);
- the per-conversation lane ARCHIVE digest hashes the agent's `rank`, so an archive row written
  before the rank model digests to the old value and RE-ARCHIVES once by design rather than being
  shimmed with a `role` alias (`src/server/workers/lane-commit.ts:164-190`).

`HARNESS_DATABASE_VERSION` stays 2 through all of this (`src/server/persistence.ts:208`), because
the version tracks the shard TREE and none of these keys changed it — the rank change is a change
to the VALUES inside the same layout, which is exactly why the loaders refuse the old keys loudly
instead of relying on a version bump to catch them.

Commits are **per shard, ordered, incremental**. Each shard is its own commit unit with
the discipline the single file always had: the shard's full JSON (compact
`JSON.stringify`, not the historical two-space pretty-print — `:2360-2364`, and the
measured format change is documented at `:1922-1937`) goes to a staging file **in that
shard's own directory** (`index.json.<pid>.<n>.tmp`, `thread-7.<pid>.<n>.tmp`), is
fsynced, then renamed over the canonical name; the canonical file is never unlinked
first, and a cross-directory rename would not be atomic (`commitHarnessFile`,
`:1968-1996`, `writeHarnessShardFile`, `:2395-2403`). The order is the whole torn-set
story (`save` → `commitShards`, `:2755-2837`):

1. every thread shard of a session,
2. that session's `session.json` — the file that indexes those shards,
3. `index.json`, once every session is durable,
4. last of all, the shards the new document no longer names.

A crash between any two steps therefore leaves an **extra** file the committed header
does not name (ignored on read) and never a file the header names while missing;
deleting first would invert that and produce the one state `load()` has to refuse
(`:2769-2773`). For one session, the point at which its row and its transcripts are all
on disk is its **`session.json` rename** — `index.json` only publishes which ids exist.
A structural API mutation (create/patch/delete session, enqueue/cancel, reset, manual
tool call, registry create/patch) still persists **before** the response, and in worker
mode the caller awaits **every** shard's own receipt, because the index rename does not
fsync the thread file that precedes it (`src/server/workers/io-protocol.ts:72-77`,
`IO_SHARD_ORDER` at `:161-176`). The directory entry itself is not fsynced — the same
deliberate durability boundary the synchronous writer always had (`:1976-1979`).

The same ordered commit runs on the IO worker thread under `HARNESS_IO_EXECUTION=worker`;
`persistence.save()` keeps its signature, its throw and its monkey-patchability either
way (`:2755-2785`). Background turns still persist at start, on every non-delta event
(message commit, tool call/result, usage) and at the terminal settle, and per-token
text/reasoning deltas are still coalesced into the terminal write. A failed structural
write is a 500; a failed background write never changes a run's outcome but is
observable via `SessionStore.persistenceError` (and stderr unless `onPersistenceError`
is set).

A commit is **content-addressed in both modes**: each shard's payload is hashed (sha256)
against the last bytes that writer committed at that path, and a shard whose bytes did not
change is not opened at all. **Where** the gate is decided is the only difference: inline
decides it in `commitShardIfChanged` (`shardDigests`, `src/server/persistence.ts:2994-3011`),
worker mode decides it on the **worker** in `runShardSave` against `committedShards`
(`src/server/workers/io-worker-loop.ts:142`, applied at `:355-367`) — the only place that can
decide it there, because only the worker holds the serialized bytes. Both gates demand the
same pair (payload digest match **and** the file still carrying its `size`/`mtimeMs` witness),
and a file that cannot be statted counts as changed in both. Inline's table is primed by
`load()` from the bytes it just read (`src/server/persistence.ts:2814-2816`), so the first
commit after a restart costs only what changed; the worker's map is thread state with no
priming step, so a **restarted worker re-commits each shard once**
(`src/server/workers/io-worker-loop.ts:135`) and skips every later identical payload — a skip
answers `result` with `skipped: true` (`src/server/workers/io-protocol.ts:406-414`, an
additive flag, not a new outcome) and the client counts it in `stats.skippedShards`
(`src/server/workers/io-client.ts:259`, `:925`) instead of `writtenBytes`. `index.json` holds
the only wall-clock stamp, so it is normally the one always-rewritten file. **Write
amplification is proportional to the edited conversation in both modes**: one new message
costs one thread shard plus one session record, not every session's every event. A commit
still posts one frame per shard, so it costs more frames than the single whole-document frame
v1 cost — but it no longer opens **one file per shard of the whole store**: once each side
has seen the bytes, the opened set tracks what changed, and that is the set inline opens
(the worker's one re-commit pass after a start or restart is the exception above). What
stays whole-store in both modes is the CPU **in front of** the gate
(the fan-out, the clone, the stringify), never the write syscall.
The pre-split baseline, measured on the live
store: 2 writes per settled tool call at 816 ms each on a 110 MB document, about 36% of a
long run's wall clock (`src/server/sessions.ts:3797-3801`; the same document measured
800 ms per checkpoint at `src/server/persistence.ts:9`, and 407 ms → 242 ms to stringify
with the bytes halving 110.0 MB → 54.6 MB at `:1922-1928`) — at that measured write rate a
busy day of a 94–110 MB store is on the
order of **1.3–4 TB of rewritten bytes** (an extrapolation of the measured per-write cost
and write frequency, not a separate measurement).

The split, measured **apples to apples** through each layout's own store class: a synthetic
corpus (300 sessions / 3000 transcripts / 58.4 MB compact) on a Linux page cache — **not**
the operator's 110 MB Windows store, and **not** comparable with the 816 ms figure above,
which includes the record build and the IPC. Save with nothing changed 109.7 ms → 76.0 ms;
save with one appended message 109.7 ms → 74.9 ms; cold save 109.7 ms → 76.9 ms;
**load 90.5 ms → 104.5 ms (≈15% slower)**; total bytes 58.4 MB → 58.5 MB; largest single
file 58.4 MB → 35.8 KB. The win is therefore syscall- and recovery-shaped, not byte-shaped,
and the load regression is explained by restore being **unchanged in shape**: `load()` is
still eager — it opens every session record and every transcript the header names (`load`,
`src/server/persistence.ts`) — so a large tree still pays a full read at startup.

What still grows **inside one file**: `turns[].events` stays **inline in `session.json`,
unbounded**. `splitHarnessSessionRecord` moves exactly `core.threads[].messages`, so the turn
rows keep their event streams (`SessionTurn.events`, `src/server/protocol.ts:211`, declared
unbounded on purpose at `:249`) — measured at ~87% of a 35.8 KB `session.json` in that
corpus. Thread **transcripts** are sharded; turn **event streams** are not, and that is the
next thing that grows.

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
- **A restarted process cannot be mistaken for the run it used to host (2026-11-17 —
  identity only; the policy above is UNCHANGED and still replays nothing).** Run ids come
  from a per-process counter, so after a restart the SAME id can name a DIFFERENT run, and a
  lane worker mints from its own counter. Every run frame therefore carries the epoch of the
  process that MINTED its id (`thread.epoch`, see [Progress events](#progress-events)), and
  the transcript fold treats two known-but-different epochs as two runs before it asks
  anything else about the frames (rule (0) of `isRunBoundary`), while a record written before
  the epoch exists carries none and folds exactly as it did. That value is the same epoch the
  REST surface already reports (`X-Harness-Epoch`, the boot document, health, the stream
  cursors). As far as the TURN goes it lives in the recorded event payload only — no display
  turn record (`TurnSection` / `TurnSummary`) and no `turn.*` frame carries it — but since W26
  the same token rides the CONVERSATION planes beside the run ids it separates: `epoch` on
  `SessionThread` / `SessionThreadView` and in a roster row's identity block, which a
  `thread.upsert` frame therefore carries too — and the browser fold applies the SAME pair one
  level DOWN, inside a row: its tool-card state is keyed `(epoch, callId)` (`callKeyOf`,
  `src/frontend/ui/turns.ts:1668`), so a process that restarts and re-mints a call id cannot have
  the new run's tool result thrown away as a duplicate of the dead run's settled card, which is
  what used to leave the new card counting up forever;
- **A network-dropped conversation is auto-resumed while its run is LIVE — and none of the
  restart behaviour above changes (2026-11-17).** While a run is live, a conversation whose run
  dies on the `provider-network` stop reason (a missed provider
  time bound, a dead dial, or a codeless death the transport diagnosed as bytes dying in transit —
  whether or not a retry was spent) is put back to work
  by the server itself: it raises a DURABLE per-conversation streak (`networkFailures`, in the
  session shard, so a provider still down across a restart does not buy fresh resumes) and,
  while that streak is strictly below the session's ceiling, calls its own
  `POST …/threads/:threadId/resume` path so the SAME turn re-runs in place. One answered run
  clears the streak; a cancel or a manual stop counts as nothing; `retries-exhausted` and
  `timeout` are not network causes (the first is a non-network exhausted ladder, the second is
  the host's own wall clock). THE CLASS IS DELIBERATELY WIDER THAN "THE NETWORK DIED", and the
  over-trigger is accepted: the transport's codeless `provider-transit` diagnosis also covers a
  gateway frame whose code is `decode`/`unknown`/absent, an in-stream `upstream_status` carrying a
  NON-refusal status (408 / 429 / any 5xx, 504 included — only 400/401/403/404 are refusals, because
  a refusal has to be OUR request's fault), and a body that closed without reporting a completion.
  Any of those raises the streak, so a merely truncated or merely upstream-throttled endpoint can
  consume the whole ceiling before the conversation rests; the ceiling is what bounds that. An HTTP
  4xx/5xx response BODY, a malformed frame and a schema throw carry no such class, and stay
  `api-error` / `retries-exhausted`. The ceiling resolves in order: the per-provider
  `settings.networkResumeLimit`, then `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT` (`0` = the loop is
  OFF), then **10**; both the streak and the ceiling are reported read-only on the snapshot and
  the compiled view (`networkFailures` / `networkFailureLimit`, plus the per-thread count on each
  roster row) — NOT on the bounded `GET /v1/harness/sessions/:id` read, which answers a
  `SessionResource` and carries none of them. Two guards bound the loop — a per-turn live claim counter, and an outright refusal
  while the store is shutting down or still restoring — so a restart never spends provider time
  by itself, and the restored streak only COUNTS. What the re-run discards is still evidence: the
  journal keeps a `rollback` line with the abandoned attempt's events (including its terminal
  `error` frame) and the session shard keeps the bounded summary, so the restart policy stays
  "mark interrupted, never replay" while the reason a thread stopped stays answerable.
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
  [Editable thread transcripts](#editable-thread-transcripts)). The shard split added one
  more way to reach that same tolerance — a `threads/<threadId>.json` the row names but
  that is simply **gone** (an external deletion after the header was committed) — and it
  is routed through the existing `tolerateThreadTranscripts` path rather than a new error
  class, with one extra line saying what happened and where: `HARNESS_MISSING_THREAD_TRANSCRIPT`
  is the marker the row gets, `attachThreadTranscripts` sets it and `noteMissingThreadTranscript`
  prints the line (`src/server/persistence.ts`), and the restore pass hands that row to
  `tolerateThreadTranscripts`, which records it in `invalidThreads` (`src/server/sessions.ts`).
- a stale **enabled-tool name** in the snapshot does **not** cost the session: the
  store filters the saved `core.discovery.enabled` through
  `harness.isToolSwitchable(name)` immediately before `harness.restore()`, switching
  off only the names this rebuilt harness cannot register and keeping every other
  switch exactly as committed (`pruneStaleEnabledTools`,
  `src/server/sessions.ts`). A tool the session CREATED
  keeps its slot, because the snapshot
  re-registers it and `restore()` counts that name as available
  (`src/harness.ts` `restore`). So a `search` key being removed, a plugin being
  unregistered or an app tool being edited out of a harness card costs one switch, not
  the conversation — while the kernel itself stays strict for a snapshot handed to it
  directly (`src/harness.ts` `restore`'s validation). THE SAME FUNCTION PRUNES
  `discovery.withheld`, on a DIFFERENT bar and in SILENCE: the names this build no longer
  registers (plus the ones the snapshot re-registers through `createdTools`) are dropped from
  the switch list, never matched against `isToolSwitchable` — a core declaration and the
  pending-only `toolCancel` hold no cap slot, so the cap predicate would throw a core disable
  away at every restart. A dropped switch reports nothing, because it asserts nothing
  dangerous, while a dropped ENABLED name still prints its tolerated-restore line; and either
  way the pruned list is what the next save writes. The user-visible consequence: a switch on a
  name that has vanished is forgotten, and if that name is registered again it comes back ON
  (pinned, with the rationale for not throwing, by
  `src/server/restore-enabled-tool-prune.test.ts`). CORRECTED IN PLACE 2026-11-13: the bullet
  below used to name "a snapshot naming a tool that has since been renamed" as a drop
  cause; because a session the server creates starts with the whole cap-eligible toolbox
  enabled, that was the ordinary case and it silently deleted conversations. The
  tolerance is pinned by `src/server/restore-enabled-tool-prune.test.ts`, and
  `src/server/restore-isolation.test.ts` now pins the drop by renaming an AGENT;
- a session this build **cannot rebuild** for any other reason (a snapshot naming an
  agent that has since been renamed, a model map naming a retired agent, an internally
  inconsistent record) is **dropped on load instead of failing startup**: every other
  session, the registry, the API and new-session creation keep working, and the dropped
  id answers `404 Unknown session` rather than presenting a half-restored row. Both
  outcomes are reported through the SAME channel — `onRestoreError` (stderr by default)
  and `SessionStore.restoreErrors`, where the lines interleave — so a host separates
  them by their text, not by their position: a drop always states the reason, so it
  stays readable after the session is gone, while a prune states that the session
  restored and names what it switched off
  (`src/server/sessions.ts:4039-4043`). A dropped record is gone from the next commit —
  its `session.json` and its `threads/` shards are erased by that commit **in both modes**
  (see the erase rule below, which worker mode takes through its `shard.erase` frame) — and a
  pruned name is forgotten there too: the store re-captures
  the session's snapshot right after the restore (`src/server/sessions.ts:4434`), so
  the stale name is out of the saved set at the first save and is not re-reported on
  every restart. Document-level problems stay **fatal**, each naming the file that is
  actually at fault (`load`, `src/server/persistence.ts`). Three outcomes, three files: an
  unreadable, malformed, wrong-version or structurally invalid `index.json` aborts startup
  naming **`index.json`**; a `session.json` the header lists that cannot be **read or
  parsed** aborts startup naming **`session.json`**; a record that parses but fails the
  merged `readHarnessDatabase` shape check aborts naming **`index.json`**, because that
  error is raised as `harnessShapeError(this.file, …)` on the header that published the id.
  A thread transcript the row names that is **gone**, or that parses badly / carries no
  `messages` envelope, is the one tolerated document case: `attachThreadTranscripts` gives
  the row the missing marker or the raw text and the existing
  `tolerateThreadTranscripts`/`invalidThreads` path above records it, with no new error
  class — while a shard that raises a real read error is fatal and names **that shard**,
  because `readShardText` treats only `ENOENT` as absence. In v1 the same broken record sat
  inside the one document and refused the whole load, so sharding must not turn a loud
  failure into a silently lost session. A shard the header does not name is ignored on
  read and left in place: `load()` performs no garbage collection (`:148-150`), and the
  only files a commit unlinks are the erased footprint below — which **both** modes
  perform, inline inside `save()` and worker mode through a `shard.erase` frame. A failed
  load never rewrites the operator's files.

**What a delete actually removes** (drop, then erase — **in both modes**). A session that leaves the store
is erased only **after** the commit that no longer names it, and only in this order
(`eraseVanishedShards`, `src/server/persistence.ts:3025-3052`): its `session.json`, then
its whole `threads/` directory. Its **`events.jsonl` survives**, and so does the session
directory — that is v1's outcome and what `SessionStore.remove()` counts on, because the
store deletes the journal itself afterwards (`SessionStore.remove`,
`src/server/sessions.ts`) and a
checkpoint must not pre-empt that. A conversation retired by the 256-record cap
(`capThreadRecords`, `src/server/sessions.ts`) loses only its own thread shard
(the vanished-thread loop of the same function). Both modes remove the **same bytes through
one primitive**: `eraseHarnessShardPaths` (`src/server/persistence.ts:3086-3106`), which the
inline collector calls and the worker's `shard.erase` handler `runShardErase`
(`src/server/workers/io-worker-loop.ts:401-423`) calls, so "erased" cannot come to mean two
different things. What differs is **who plans the removal and when it is awaited**: inline
erases inside `save()`, after the index is durable; worker mode derives the exact
`files`/`trees` on the coordinator from `persistence.shardFootprint`
(`src/server/persistence.ts:2577-2583`) — the worker holds no session identity — and posts a
`shard.erase` frame **unawaited, after** that commit's shard writes: in the strict path behind
the awaited shards and **before** the journal-fence check
(`src/server/workers/io-client.ts:1426`, the fence is judged at `:1430`), and in the queued
path through `deferredErases` (`:703`) drained by `flushDeferred` (`:1098-1116`) so a still
queued write of the dropped session cannot resurrect the orphan. No durability outcome was
invented: the commit receipt still names only shards, never a removal. Every erase stays
best-effort and never fails a mutation that succeeded:
the header is already durable, so a leftover shard is invisible to `load()` (the index is
authoritative) and costs disk, not correctness. A worker-mode erase failure answers `failure`
with code `shard-erase` (`src/server/workers/io-worker-loop.ts:412-421`) and stays off the
sticky persistence-error channel, because `noteFailure` reports `shard.save` and journal
kinds only (`src/server/workers/io-client.ts:822-844`) — while inline swallows its unlink
failures outright, so neither mode reports a mutation that did succeed as a failure. The
crash-leftover rule is unchanged either: a removal that never drained leaves bytes `load()`
never lists, so they cost disk, not correctness.

**No migration, and an honest empty start.** Version 2 does **not** read, rewrite,
rename or delete a v1 `state.json`: the constant survives only as the path of an
artifact an older build can still open (`src/server/persistence.ts:202-207`,
`:2421-2424`), and the upgrade deliberately bumps the version instead of guessing
(`:187-195`) — a v1 reader walking this tree would find an empty `sessions` list in
`index.json` and report "no sessions", the silent clean slate the version gate exists to
refuse. When `index.json` is absent and a `state.json` is present, this build starts
empty and says so **once**, on stderr with the store's own prefix:
`[harness] skipped the v1 harness database: The harness database at <root>/harness/state.json
is the single-file v1 store, which this build (database version 2) cannot read; it is not
read, rewritten, renamed or deleted …` (`noteLegacyHarnessDatabase`,
`:2530-2549`). The same line is exposed as `HarnessPersistence.restoreDiagnostics`
(`:2480-2487`) — today the only note this store produces while reading — and a host can
route it with `onRestoreNote` (`:2452-2458`). Nothing is moved out of the way: an older
build pointed at the same root still finds all of its sessions.

**Unchanged by the split**: the 256-record bound on host thread rows
(`MAX_THREAD_RECORDS`, `src/core/thread.ts:46`) and the 64-record agent-result retention
(`AGENT_RESULT_RETENTION`, `src/core/agent-limits.ts:25`) are the same numbers with the
same messages, still enforced per session (`src/core/snapshot.ts:815-818` refuses a
document over the cap); the journal format, every tolerance above, and every wire shape
are untouched. Under `HARNESS_IO_EXECUTION=worker` the IO thread now receives **one
`shard.save` frame per shard, plus a `shard.erase` frame for what the document stopped
naming** — protocol version **3** (`IO_PROTOCOL_VERSION`, `src/server/workers/io-protocol.ts:129`):
version 2 was the `checkpoint.save` → `shard.save` split, and 3 added the removal kind, which
a version-2 worker has no handler for (the `skipped` flag on a `result` IS additive and is
therefore not the reason for the bump, `:109-129`) — posted in `IO_SHARD_ORDER` (`:188`,
`orderIoShardUnits` `:643`). Coalescing is per **path** rather than per
document, so a burst of observer fires collapses into one commit per touched shard and a
replaced shard is reported `superseded`, in total and per path
(`src/server/workers/io-client.ts:56-63`, `:1121-1128`, `:1135-1143`, `:1699-1702`), and the 64 MiB frame bound
(`IO_MAX_FRAME_BYTES`, `io-protocol.ts:150`) is enforced **per shard**: exactly, on
the serialized length inside the worker (`io-worker-loop.ts:322-341`), and pre-checked
client-side from the last size measured for that same path, so one runaway transcript
fails loudly and stops being cloned without freezing every other write
(`io-client.ts:44-49`, `:912`, `:1288-1292`).

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

**Two runtimes, one default root, one layout each (interop).**
`packages/typecrate/harness` is a Rust port whose stated origin is this package's server
core — `src/server/persistence.ts` is named as its specification
(`packages/typecrate/harness/src/lib.rs:1-6`, the `persistence` row at `:20`) — and it
still reads and writes the single-file v1 document:
`<root>/harness/state.json`
(`packages/typecrate/harness/src/persistence.rs:1`, `:74`, `:133`). Both runtimes default
to the same root, `<repo>/../temporary/dump` — computed in TypeScript at
`packages/underload/service/server.ts:24` (`DATABASE_ROOT`) and in Rust by
`default_database_root()` at `packages/typecrate/harness/src/package_root.rs:86-101` — and
neither takes a
cross-process lock (above). Pointed at one root, therefore, **neither runtime sees the
other's store**: this build reads `harness/index.json`, finds none, prints the
skipped-v1 line once, and starts empty, while the Rust gateway reads
`harness/state.json` and finds either nothing or the bytes an older TypeScript build
left — so it restores that, not this layout. Each then commits its own document into the
same `harness/` directory: a session created by one runtime is invisible to the other,
and the two checkpoint writers never collide only because they never touch the same file.
The one file they DO both own is `<root>/harness/agents.json` — same path on both sides
(`src/server/persistence.ts:2941-2942`,
`packages/typecrate/harness/src/persistence.rs:141-142`), same bare-array shape, no lock —
so the last runtime to write an agent decision wins and the other's decision is gone. What
would resolve the split: port the Rust persistence to this layout, or make its reader
refuse a root that already holds `harness/index.json` — the same refusal this package
applies to a v1 root rather than guessing. Until then, run the two against separate
`--database-root` values.

The paths below are the SAME dispatcher the standalone listener serves — one mount, one
bootstrap document, one error shape — printed here for scanning. The endpoint table in
[Server and UI](#server-and-ui) is the full list, including every child route:

```text
GET    /v1/harness                        bootstrap document
GET    /v1/harness/health                 liveness probe
GET    /v1/harness/config                 global provider defaults + runtime facts
PATCH  /v1/harness/config                 change the global defaults
GET    /v1/harness/harnesses              harness descriptors (paged)
POST   /v1/harness/harnesses              create a harness → 201 { harness }
GET    /v1/harness/harnesses/:name        read one harness → { harness }
PATCH  /v1/harness/harnesses/:name        change one
DELETE /v1/harness/harnesses/:name        remove one
GET    /v1/harness/harnesses/:name/instructions[/:agentId]   member instruction text
GET/PATCH/DELETE /v1/harness/agents/:id   trusted agent profiles
GET    /v1/harness/tools[/:id]            catalogue
PATCH  /v1/harness/tools/:id              enable/disable one entry for every session
POST   /v1/harness/tools/:id/executions   run a catalogue tool, no session
GET    /v1/harness/plugins                built-in plugins + the TEMPLATE's settings
PATCH  /v1/harness/plugins/:id            change one plugin's settings for sessions created after it
POST   /v1/harness/models                 server-side GET {base_url}/models
GET    /v1/harness/sessions               paged SessionSummary rows (no children)
POST   /v1/harness/sessions               create → 201 { session }
GET    /v1/harness/sessions/:id           metadata + live agent_models (no turns)
PATCH  /v1/harness/sessions/:id           retarget agent_models (next request)
DELETE /v1/harness/sessions/:id           forget a session
GET    /v1/harness/sessions/:id/definition|usage|commands|records
POST   /v1/harness/sessions/:id/tasks     submit a task, or run a `/command` → 202 TaskReceipt
GET    /v1/harness/sessions/:id/turns[/:id][/display|/events|/context]
POST   /v1/harness/sessions/:id/reset|cancel
GET    /v1/harness/sessions/:id/queue|actions
POST   /v1/harness/sessions/:id/actions/:request_id/answer   answer one pending actionRequest
GET    /v1/harness/sessions/:id/agents[/:agentId] · tools · threads
POST   /v1/harness/sessions/:id/tools[/:tool_id][/executions]
GET    /v1/harness/sessions/:id/plugins[/:plugin_id]      this conversation's rows
PATCH  /v1/harness/sessions/:id/plugins/:plugin_id        one plugin for this conversation only
GET/PUT /v1/harness/sessions/:id/threads/:thread_id/transcript[/messages|/document]
POST   /v1/harness/sessions/:id/threads/:thread_id/cancel|resume
GET    /v1/harness/stream                 the harness.v1 WebSocket (live updates)
```

A `POST …/tasks` whose `input` starts with `/` is executed as a slash command in the
server process and answers `202` with an already-terminal turn (see
[Slash commands](#slash-commands)).

**One mount, one dispatcher.** `HARNESS_API_ROOT` (`/v1/harness`) is the only mount on
either host, and the legacy `/api` root is not mounted at all: a request to it answers
`This server serves /v1/harness; "/api" is not mounted.` The `/presets`, `/views`,
`/tools/bootstrap` and `/tools/:name/call` aliases were deleted rather than kept behind a
flag, and so was the `X-Harness-Client: ui` header gate — the service loader installs
permissive CORS, so a custom header was never an access boundary there.

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
browser's harness server URL, and a short line in the dialog prints the root actually in
use. `Apply` at the bottom right is the dialog's only button and the only thing that
commits anything: what is on screen there is a **draft**, so dismissing the dialog with
the close button, `Escape` or a click outside leaves every saved value exactly as it was.
`Apply` validates the URL — a rooted path, or an absolute `http(s)` URL with no query,
fragment, credentials or backslashes — stores it in normalized form (so a trailing slash
cannot drift between loads), removes the `apiRoot` parameter from the address bar (that
parameter outranks the saved value, so leaving it in place would undo the save; every
other parameter and the hash survive), and reloads, which re-resolves the root and
reconnects the `harness.v1` WebSocket. That reload happens only when the URL actually
changed; for an unchanged URL `Apply` writes the draft and closes. `Enter` in any text field of
the dialog is that same `Apply` press — never a form submit and never a bare reload — and an
`Enter` that only confirms an input-method candidate is ignored. A value the validator
refuses is reported inline and nothing is written. Applying a **blank** field deletes the
key and reloads — the field is now the only reset affordance — and that restores
automatic resolution, which on a Pages host means the compiled chain again.

The setting has its own storage key and is never serialized into a request body: the
dialog's Base URL / API key / model triple describes the **provider**, and where the UI
sends its requests is a separate decision. That triple is part of the same draft, so
`Apply` is also what saves it. The model is one the endpoint advertises: editing the Base
URL debounces a `POST /v1/harness/models` for the draft settings by about 500 ms, the harness server
performs the upstream `GET {base}/models` (it owns the credential, and the key is never
sent back to the browser), and the ids it returns repopulate the Model dropdown — a
select-only control, there is no field in which to type an id. That debounced lookup is a
**preview**: its answer paints the dialog's dropdown and nothing else, so a URL you typed and
then dismissed, or overtook with another edit, never changes what a conversation dials. The
catalogue the rest of the app uses moves only on a **committed** lookup — the one a load makes
for the saved endpoint, even when the dialog is already open, and the one `Apply` makes once the
draft is the record — and `Apply` republishes only when the list on screen was fetched for that
exact Base URL **and** API key, because a blank key on the configured origin means the harness
server's own key and the same URL can therefore legitimately answer with a different list.
Reopening the dialog spends no request when the published catalogue already answers for that
pair: it seeds the dropdown from it, and arms exactly one lookup when nothing is known about it.
A saved root also
silences the Pages probe chain — a deliberate choice is never replaced by a guess.

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
  the **service** mount, not the standalone `:5181` server (that one sends no CORS headers
  at all, so any cross-origin preflight fails against it).
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
chain until that field is applied blank), or bake one in with `VITE_HARNESS_API` at build
time.
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
and every live frame names it too: a `turn.upsert` update carries the turn row and its
id). Reloading the UI re-reads the bounded paged reads (`GET /v1/harness/sessions` and
`GET /v1/harness/sessions/:id/turns`), which already contain every settled turn and point
at its recorded events, then re-subscribes on the one `GET /v1/harness/stream` socket; if
no socket is open the UI still works from those reads.
Queued and running work belongs to the server, so a reload, a hidden tab, or a
closed watcher never cancels it. With a database root, sessions, turns, created
tools, discovery, tasks, the queued backlog, and every conversation's transcript are
durable under `<root>/harness/index.json` plus one `sessions/<id>/` directory per session
(the record, its `threads/<threadId>.json` transcripts and its `events.jsonl`) and a
restart resumes them (see Persistence: running
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
yarn build             # regenerate the TWO generated catalogues (harness-tools.manifest.json
                       # + the plugin manifest) — nothing is compiled, see npm Publishing
yarn build:frontend    # the UI application -> src/frontend/dist (standalone/deploy base)
yarn cli --list        # CLI preset catalogue
yarn dev:frontend      # Vite UI on all interfaces, dual-stack (LAN + localhost), /v1/harness -> the service on :5000
yarn dev:server        # optional standalone API on :5181 (no Vite/UI)
yarn start-service     # repo root: builds UI for /harness/, serves it + /v1/harness on :5000
yarn build:harness-ui  # repo root: rebuild just the gateway UI (/harness/ base)
```

## npm Publishing

The package is publishable to npm as `@underload/harness`.

```bash
yarn build      # harness-tools.manifest.json + the plugin manifest, and nothing else:
                # the package publishes `src/*.ts`, so there is no bundle and no `.d.ts`
                # tree to produce before a release
yarn publish    # prepublishOnly runs, in order: typecheck -> test -> build ->
                # test:package:files -> test:package -> test:package:runtime -> test:package:tools
```

- **The library barrel is stable: `src/harness.ts`.** It is the published library
  barrel (`harness()` / `agent()` / `tool()` plus every public type), which the Node root
  `src/index.ts` re-exports — and `src/index.ts` IS the entry the published package
  resolves: `main`/`module`/`types` point at it (`package.json:6-8`) and every `exports`
  condition names a `src/*.ts` file, so an installed host loads the same file a workspace
  run edits. The bare `@underload/harness` specifier in tests resolves through those same
  conditions — `vitest.config.ts` has **no `resolve.alias`**, so a test can never assert a
  stale bundle (the full note is under [TypeScript consumers](#typescript-consumers)).
  Nothing is bundled and nothing is emitted: there is no JS build of the library and no
  declaration step.
- **The JavaScript application also lives under `src/`, next to the library:**
  `src/server` (HTTP API, sessions, the WebSocket stream, catalogue presets, CLI, discovered service
  routes), `src/frontend` (browser client + app shell) and `src/shared` (helpers
  both trees evaluate). Each barrel is a published entry: the root `.` (Node), the root's
  nested `browser` group, `./server`, `./frontend`, `./shared`, plus the two worker
  EXECUTABLES — `./worker` (`src/server/workers/lane-worker.ts`) and `./io-worker`
  (`src/server/workers/io-worker.ts`), spawned as threads rather than imported as APIs.
  Publishing is by manifest only (`package.json` `exports` + `files`) — `src/structure.test.ts`
  pins every published condition against the file it names, so neither side can drift.
- **Entries and conditions.** `exports` maps the root to `src/browser.ts` under the
  nested `browser` group (`types` + `default`) and to `src/index.ts` under `types` +
  `default` (library + shared + server + client). (CORRECTED IN PLACE 2026-11-12: this
  section used to document a `development` condition that mapped each entry onto its
  `src/` barrel while `node`/`import`/`default` answered from `dist/`. A source-only
  package has no dev-vs-built fork to express, so the condition is gone and every shipped
  condition names the source.) `./server`, `./frontend`, `./shared`, `./worker` and
  `./io-worker` expose each layer on its own, and every condition declares an **explicit
  `types` target** — the same `.ts` file the runtime loads, because there is no emitted
  `.d.ts` for anything to resolve implicitly to.
- **Lazy preset modules, not chunks.** Each preset's implementation is a dynamic import
  (see `src/tools/catalogue.ts` → `src/tools/descriptors.ts`, which owns both loaders), so
  constructing a harness or listing the catalogue loads no Node built-ins. In Node the
  catalogue scans the tools root live; the generated `harness-tools.manifest.json` is what
  the browser bundle uses, because a bundle cannot scan. A `.tool.ts` newer than the
  manifest is compiled from its editable source (`prepareToolCandidate`), so the Node
  surface stays honest while `yarn tools:manifest` is only needed to refresh the browser
  catalogue — and `typecheck`/`test` run `--check`, so a stale catalogue fails the build
  instead of silently omitting a tool.
- `package.json` `files` ships `src` — every `.ts` source, the two hand-written ambient
  `.d.ts` files, the UI assets (`index.html`, the three `.css` files), the OpenAPI
  document and the one permitted plain-JS file (`src/server/workers/worker-boot.mjs`,
  the worker-thread bootstrap) — with tests, specs, snapshots, `src/frontend/dist`, and
  nested `node_modules`/`.vite` excluded (`package.json:40-50`). `scripts/package-files.ts`
  resolves that list to the exact packed set, `scripts/package-files.test.ts` pins it, and
  `yarn test:package` refuses the release if any built artifact (`.mjs`/`.cjs`/`.js`/`.map`
  or an emitted `foo.d.ts` twin of `foo.ts`) lands inside it.
- `package.json` points `main` / `module` / `types` at `./src/index.ts`
  (`package.json:6-8`); inside `exports` **every** shipped condition points at a `src/`
  entry, so there is no condition a consumer can fall through into a missing build
  output. Tooling configs and tests never reach npm.
- **Dependency split is decided by what the published SOURCE imports, not by which layer
  is prettier.** `dotenv` (server `.env` loader) and `typescript` (the tool-source compiler
  imports it at RUN time, `src/core/tool-source.ts`) are `dependencies`, and
  `dompurify`, `highlight.js` and `marked` joined them because `src/frontend/ui/markdown.ts`
  imports them: a source-only publish means an installed consumer that evaluates the
  client tree really needs those packages resolvable (there is no bundle that could have
  inlined them). `jsdom` stays a `devDependency` — only tests import it. Nothing is
  "externalised" any more because nothing is bundled; a consumer's own bundler decides
  that, and `yarn test:package:runtime` fails the release if any declared specifier does
  not resolve from a copied install.
- **`vite` is a `peerDependency` (`^8`) as well as a `devDependency`.** The deployable
  surface still runs Vite: `build:frontend` / `dev:frontend` load `src/frontend/vite.config.ts`,
  and the worker entries are loaded through Vite's module runner
  (`src/server/workers/worker-runner.ts`, started with `configFile: false`). A host that
  spawns those entries has to provide Vite, which is what a peer declaration says; the
  library core (`harness()` / `agent()` / `tool()`) imports no Vite at all; the peer covers the
  app/worker surface that does (`package.json:106-108`).
- `sideEffects: false` + `exports` make the package tree-shakeable.
- **`.env` is never bundled.** Package-relative paths are resolved by
  `src/server/package-root.ts` (a walk up to `package.json`), not by
  `new URL('<neighbouring file>', import.meta.url)`: Vite rewrites that pattern and
  would inline the file — including real provider keys — into a bundle. Keep it that
  way when adding new package-relative paths.
- `publishConfig.access` is `public`, so the scoped package publishes
  publicly to the npm registry.

## License

ISC

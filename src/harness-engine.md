# `harness({...})` — the engine contract

The programmatic surface of `@underload/harness`: three factories — `harness({...})`,
`agent({...})` and `tool({...})` — plus the callable handle they return, the events a
run reports, and the types the whole thing is typed with. A host calls them in-process.
There is no listener, no mount path, no status code and no wire protocol between a host
and the engine.

This document replaces `src/harness-engine.swagger.yaml`. OpenAPI models HTTP
operations, and the engine has none, so that document described its shapes in a
vocabulary it did not belong to. The HTTP + WebSocket server a host can put in front of
the engine is a separate surface, documented in `src/harness-server.swagger.yaml`.

Read off the build, not a wish:

| Source | What it owns |
|---|---|
| `src/engine/harness.ts` | `harness()`, the handle, the run loop, tool scheduling |
| `src/engine/core/agent.ts` | `agent()`, the retry ladder, the pre-request context floor |
| `src/engine/core/tool.ts` | `tool()` |
| `src/engine/core/context-estimate.ts` | `estimateContextTokens()` and the hybrid estimate |
| `src/engine/types/index.ts` | every public engine type |
| `src/engine/plugins/context-compaction.plugin.ts` | the resolved effective context limit |
| `src/engine/transport/openai.ts` | the built-in transport |

Human-readable companions: `README.md` (the package tour, `### harness() — the execution
loop`), `knowledge.md` (the internal map), and `docs/plugins.md` (the `turn.before`
authoring rules).

---

## 1. Entry points

| Published specifier | Resolves to | What it carries |
|---|---|---|
| `@underload/harness` (Node) | `src/index.ts` | the engine barrel plus the server barrel |
| `@underload/harness` (browser condition) | `src/engine/browser.ts` | the engine only — never `node:http` |
| `@underload/harness/types` | `src/engine/types/index.ts` | types only |
| `@underload/harness/server`, `/worker`, `/io-worker`, `/shared*` | `src/server/**`, `src/engine/shared/**` | the surfaces over the engine, not the engine |

The engine barrel itself is `src/engine/index.ts` (`harness`/`agent`/`tool`, every
public type, the isomorphic helpers); the Node root re-exports it, so a consumer never
names it. Importing the package starts nothing: no port is bound, and every construction
cost is paid by the call that builds a harness. The names a host needs are all on the
root barrel — `harness`, `agent`, `tool`, `HarnessError`, `estimateContextTokens`,
`compileToolSourceModule`, `openAICompatible`, `toolUi`, `toolMedia`, `toolText`,
`AGENT_RANKS` — and every engine type is re-exported from it too (`export type *`).

## 2. Quick start

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
    report: { progress: (event) => console.log(event.type) }
});

const message = await writer('tell me about new year');
console.log(message.content);            // the entry agent's final answer
```

The registry key is the identity: `writer: agent({...})` names the agent `writer` and
`search: tool({...})` is the name the model calls. You never repeat a name inside the
definition — a `name` field there is a standalone label only, overwritten on
registration.

Construction is **synchronous**, and it performs every registration — presets,
`toolSources`, `toolFolders`, configured `tools`, `commands`, plugins — and validates
every bound. A typo therefore throws on the line it was written:

```
Entry agent "zzz" is not registered. Configured agents: a.
HarnessConfiguration.ranks.a must be one of: A, B, C, …, Z. Received Z1.
HarnessConfiguration.ranks names agent "ghost", which is not registered. Configured agents: a.
Agent "agent" has no transport: provide either `stream` or `provider.baseURL`.
Agent "agent" has an invalid `color`: "red". Use a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).
maxIterations must be a positive safe integer or Infinity; received 0.
A harness requires at least one agent.
A tool requires at least one tag.
```

---

## 3. `harness(configuration): Harness`

```ts
harness(configuration: HarnessConfiguration): Harness
```

Every field except `agents` is optional. The returned handle is callable:
`writer(input, options?)` runs the entry agent to completion and resolves with its
`HarnessAssistantMessage`.

### 3.1 Roster and routing

| Field | Type | Default | Meaning |
|---|---|---|---|
| `agents` | `Record<string, Agent>` | — (required) | Every brain, keyed by name. The **first key is a default, not an authority statement**: it is the fallback `entry` and the order per-member reads return. |
| `entry` | `string` | first `agents` key | Which registered agent the callable runs. ROUTING ONLY: it grants no capability and is not a rank. An unregistered name throws at construction. |
| `ranks` | `Partial<Record<string, AgentRank>>` | entry `'A'`, every other agent `'B'` | Authority map, where a **larger letter is a lower authority** and any number of agents may share one rank. A stated map fills every agent it omits — the entry included — **one rank below the lowest rank it names**, clamped at `'Z'`; `ranks: {}` names nothing, so every agent lands on `'B'`: one rank, and no `delegate` tool is registered at all. Unknown names and bad letters throw. Delegation targets, the nesting ceiling and the `toolCreation` ceiling all derive from these letters and nothing else. |

`AgentRank` is the 26-letter scale `'A' | … | 'Z'` (the `AGENT_RANKS` array and the
`rankIndexOf` / `isLowerRank` / `isAgentRank` helpers are exported). Distinct ranks, not
agent counts, bound nesting: a chain of delegations visits strictly descending ranks, so
`A → B → C` needs three letters.

### 3.2 Bounds and budgets

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxIterations` | `number` | unset (no limit) | Runaway guard: MODEL REQUESTS one agent run may make before the harness rolls history back to where the call started and throws. Every request counts — the first answer, each tool continuation, a pause with pending work, and every wake-driven turn. `Infinity` states "no limit" explicitly; a finite value must be a positive safe integer. The bound is harness-wide and per run: each run gets its own count. |
| `threadForkTimeoutMs` | `number` | unset (no limit) | Default wall clock for a `threadFork` branch when the caller names none. The `threadFork` tool's own schema value wins over it; this is the host's backstop for every other fork door. |
| `wakeIntervalMs` | `number` | `600000` | How often a run **whose board still holds an `async`-resolving call** emits `wakeup` and gets another model turn (`DEFAULT_WAKE_INTERVAL_MS`, `src/engine/harness.ts:676`). Since R4 this is the shipped `async-ping` plugin's `intervalMs` **default** (`src/engine/plugins/async-ping.plugin.ts:216`, `:242`): a stored `pluginSettings` value wins. A board whose outstanding calls are ALL `sync` is NOT pinged — its group re-enters the run itself — which is why a call that resolves to `sync` has no heartbeat behind it **unless the row that names its tool declares `async`**: the plugin's predicate resolves the mode by NAME, from the registration policy and else the generated `BUILTIN_TOOL_DESCRIPTORS` row (`src/engine/plugins/async-ping.plugin.ts:310-319`, the table index at `:211`), never from the call, so a lone unswitched `delegate` refined to `sync` — and a `shell` call carrying an explicit `"async": false` — **is** pinged, one `status:'pending'` placeholder turn per ping. That divergence is pinned at `src/engine/harness.tool-async-switch.test.ts:1579` ("pings a run parked on a refined lone delegate") and stated in `docs/plugins.md` (the `async.pending` section, "Neither read can see a per-call override") and in `README.md`'s "A periodic wake keeps a turn honest" bullet. |
| `maxCreatedTools` | `number` | `32` | Lifetime runtime tool-creation budget for THIS harness instance. Not process-wide; `reset()` does not restore it and removing a name frees no slot. Configured and catalogue tools never spend it. A positive safe integer, validated at construction. |
| `maxEnabledTools` | `number` | `32` | Bound on the persistent SEARCHABLE enabled set. Core tools are always declared and never count. This is not a per-query match cap: `toolRequest` reports the full union in `matched` and what the bound withheld in `omitted`. |

### 3.3 Tools

| Field | Type | Default | Meaning |
|---|---|---|---|
| `presets` | `boolean` | `true` | Preload the bundled preset catalogue (`src/engine/tools/**/*.tool.ts`) — `read`, `write`, `edit`, `glob`, `grep` are `core`; `files`, `shell`, `gitDiff`, `syntax`, `download` are searchable. `false` filters that group out: the harness-owned kernel rows (`toolRequest`, `tasks`, `toolCreate`, `toolRegistry`, `toolList`, `toolManage`, `records`, `profiles`, `chapters`, `locations`, `agentManage`, `agentResult`, `knowledge`, `threadFork`, `toolCancel`, `sleep`) plus `tools`, `toolSources`, `toolFolders` and runtime registrations still land. A configured tool wins a name collision. |
| `tools` | `Record<string, HarnessConfiguredTool>` | none | Extra tools keyed by the wire name the model calls. A configured tool **replaces** a preset of the same name. A value is a prebuilt `Tool`, or `{ tool, source }` where `source` carries the bytes it was compiled from — the shared-catalogue shape: compile once with `compileToolSourceModule`, pass the same object to every instance, keep a real `toolSource()` revision without re-evaluating the module. |
| `toolSources` | `Record<string, string>` | none | Independently compiled source entries, keyed by wire name; each value is a package-relative or absolute source path. Committed after the baseline/presets and **before** `tools` overrides. |
| `toolFolders` | `string[]` | none | Ordered external folders scanned recursively for `*.tool.ts` modules. Absolute or cwd-relative; later folders win name collisions; an invalid folder or module fails construction. Folder code is trusted code with this process's permissions — no sandbox. `toolManage`'s disk writes are fenced to these folders. Compilation is Node-only. |
| `enableAllTools` | `boolean` | `false` | Seed the enabled set at construction with every registered name that can hold a cap slot, minus deployment-denied (`toolSettings`) and conversation-withheld names. Off unless exactly `true`. Not snapshot state, so a restore keeps the set it committed, and `reset()` still empties it — `harness.enableAllSwitchableTools()` is the seam that re-runs the pass on a live handle. |
| `websearch` | `boolean \| WebsearchConfiguration` | absent | Opt-in core `search` tool. `true` reads `EXA_API_KEY` / `TAVILY_API_KEY` / `LINKUP_API_KEY` from the environment; an object injects an `env` snapshot or explicit per-provider `apiKey` (a string, or a getter called once at construction). The default provider is the first key in exa → tavily → linkup order and `provider` overrides per call. Absent, `false`, or no key registers nothing. A configured `tools.search` wins. |
| `webfetch` | `boolean \| WebFetchConfiguration` | absent | Opt-in `fetch` tool: a bounded, text-only native GET that needs no credential and is always the default; `EXA_API_KEY` / `LINKUP_API_KEY` only add the hosted crawlers. Unlike `websearch`, `true` registers it with no key at all. A configured `tools.fetch` wins. |

### 3.4 Forks and owner interaction

| Field | Type | Default | Meaning |
|---|---|---|---|
| `forks` | `HarnessForkConfiguration` | all defaults | N3 fork/branch bounds and the `threadFork` capability. `enabled` defaults **`true`**, so `threadFork` is registered even when `forks` is omitted; `forks: { enabled: false }` removes the tool and refuses every branch. Defaults: `maxDepth: 2`, `maxConcurrent: 4`, `maxHistoryBytes: 8 MiB`, `maxBranchRecords: 64`; each numeric bound must be a positive safe integer, validated at construction. |
| `interaction` | `HarnessInteractionConfiguration` | absent | Owner interaction. **Presence** registers the core `actionRequest` tool. `actionRequest: (context, signal) => Promise<HarnessActionChoice>` is the host answerer; `autoAnswer` defaults `true` and only governs a child/fork request's automatic owner fork — it never selects an option by itself. At most four requests may await an owner at once. |

### 3.5 Reporting

```ts
report?: {
    progress?: (event: HarnessEvent) => void | Promise<void>;
    stateChange?: (event: HarnessStateChangeEvent) => void;
    diagnostic?: (event: HarnessDiagnosticEvent) => void;
}
```

- `report.progress` is **awaited for every step**, so a slow UI paces the run and a
  `console.log` can simply print. This is the whole live reporting surface (section 7).
- `report.stateChange` is a synchronous, advisory observer that fires after a mutation
  the snapshot would record, so a server can schedule a save. Errors it throws are
  ignored.
- `report.diagnostic` is the channel that makes a **broken plugin** visible: a handler
  that throws, times out, or returns an unparseable decision is reported here instead of
  being dropped silently. Also synchronous, also error-tolerant, and it can never fail a
  run.

### 3.6 Commands, plugins, host services

| Field | Type | Default | Meaning |
|---|---|---|---|
| `commands` | `readonly HarnessCommandConfiguration[]` | none | Slash commands `{ name, description, usage?, execute }` registered **after** the built-ins (`/help`, `/tools`, `/task`, `/websearch`, `/webfetch`), so a name that collides with a built-in or repeats inside the list fails construction. A plugin or `registerCommand` runs later and may replace a name. |
| `plugins` | `readonly HarnessPlugin[]` | none | Programmatic plugins. Auto-discovered built-ins are applied **first**, so a name listed here replaces the built-in of that name rather than colliding with it. |
| `builtinPlugins` | `readonly HarnessPlugin[]` | the generated manifest | The built-in set made explicit. Absent applies the manifest (`async-ping`, `context-compaction`, `context-trimmer`); `[]` opts out of every auto-discovered plugin, which is the only way `plugins: []` can mean "no plugins". |
| `pluginSettings` | `HarnessPluginSettingsProvider` | in-memory defaults | Read-only per-plugin settings view, asked for `<pluginName>.<key>` whenever a plugin reads `api.settings.*`. Absent seeds each plugin's declared defaults and maps `wakeIntervalMs` onto `async-ping.intervalMs`. |
| `toolSettings` | `HarnessToolSettingsProvider` | absent | The host's GLOBAL tool switch. Presence means the harness consults it at declarations, at the launch gate, and in `toolRequest`'s `forbidden` report; absence means nothing is disabled globally. A disabled tool stays registered and stays callable by the host — only a model's view of it changes. |
| `knowledge` | `HarnessKnowledge` | a private in-memory engine | The cross-session knowledge base. Absent builds the harness's own ephemeral engine, so `harness.knowledge` always answers and never claims durability it does not have. A host passes the durable store it owns (`loadKnowledgeFileStore({ root })`) — the SAME instance to every harness in the process, because knowledge is deployment-scoped. Never session state: `snapshot()`/`restore()`/`reset()` leave it alone. |
| `knowledgeOwner` | `string` | absent (unowned) | The canonical harness name stamped on newly created knowledge articles. A TRUSTED host field, never model input, and it is stamped on `create` only. Blank means unowned, never "owned by `''`". |

---

## 4. `agent(configuration): Agent`

The brain. It owns its transcript and performs exactly one model request per `turn()`.

```ts
agent(configuration: AgentConfiguration): Agent
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | `string` | — (required) | Model identifier, sent verbatim on every request. |
| `name` | `string` | `'agent'` | Label for standalone use. Inside a harness the registry key names the agent and overwrites it. |
| `instruction` | `string \| string[]` | none | System instruction(s). A list becomes one system message per entry, in order, so persona + rules + format compose. |
| `prefix` | `Extract<HarnessMessage, { role: 'system' \| 'user' \| 'assistant' }>[]` | none | PRESET HISTORY: agentic turns that already happened (a prior session a host is resuming, worked examples a spawn should start with). The order is the contract — every `instruction` system message, then `prefix`, then `messages`, then the conversation. Roles are `system`/`user`/`assistant` only, enforced by the TYPE: a `tool` result answers an assistant `tool_calls` block this field never carries, so an orphan would reach a provider as an invalid request. Each entry gets the same hygiene as a seeded `messages` entry (detached copy, `included` normalization, attachment validation, runtime-minted `messageId`) and is reseeded by `reset()` and by a new host thread — a fork does NOT re-inject it, because its baseline is its source's materialized transcript. The harness-level write of this band is `setAgentPrefix` (section 11). |
| `messages` | `HarnessMessage[]` | none | Seed history. Instructions and `prefix` are prepended ahead of it. |
| `provider` | `HarnessProviderConfiguration` | none | Endpoint configuration for the built-in transport (section 5). |
| `stream` | `HarnessStream` | none | Explicit transport: `(request) => AsyncIterable<HarnessStreamEvent>`. Takes precedence over `provider`, and `provider` is then ignored. An agent with neither throws at construction (`has no transport: provide either \`stream\` or \`provider.baseURL\``). |
| `structured` | `Record<string, unknown>` | none | A JSON Schema the ANSWER must satisfy. On the wire it becomes the built-in transport's `response_format` (an explicit `provider.responseFormat` wins there, and `structured` still gates the reply); the reply is parsed and validated, and a failure is a typed `structured-output-invalid` with **no commit** to history and no retry. A tool-calling turn or a `length`-truncated turn is not judged. With an explicit `stream` the schema cannot reach the wire, so `structured` is validation-only. |
| `retry` | `false \| { maxRetries?, baseDelayMs? }` | 10 retries | The agent is the single retry owner. Default: one initial attempt plus ten retries, doubling from 1 s and capped at 60 s. `false` (or `maxRetries: 0`) is a hard opt-out for every class. Two classes own their own short ladders and ignore a non-zero `maxRetries`: `provider-connection` (3 attempts, 250 ms/500 ms) and `provider-timeout` (4 attempts, 2 s/4 s/8 s, capped at 30 s under a 900 s wall clock). A retry re-sends ONLY the current model request — never a tool, never the run — and cancellation and `context-overflow` are never retried. |
| `maxPromptTokens` | `number` | none | The pre-request context floor for this agent: the largest estimate it may SEND. `agent()` measures the transcript about to leave with `estimateContextTokens()` and refuses an oversized one with a typed `context-overflow` before any fetch. This value **wins over** `provider.contextWindow` when both are set, and it is checked AFTER any `turn.before` replacement, so a compactor gets its chance first. A refusal, not a policy: nothing is trimmed to fit. A fork and a persistent thread inherit it. |
| `color` | `string` | none | Display-only identity color, a CSS hex value (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). It never reaches a request or a transcript, and anything that is not a hex color is a construction error. A fork and a thread keep the same swatch. |

Standalone use is first-class:

```ts
const brain = agent({ model, provider });

// one turn, yielded as AgentStreamEvent
for await (const event of brain.stream('hello')) render(event);

// one request against the CURRENT history. turn() is an AsyncGenerator whose RETURN
// value is the AgentRequestCommit naming the attempt that succeeded.
const turn = brain.turn();
let step = await turn.next();
while (!step.done) {
    render(step.value);
    step = await turn.next();
}
const commit = step.value;   // AgentRequestCommit | undefined — the success boundary
```

---

## 5. Provider configuration (the built-in transport)

`provider` configures the OpenAI-compatible transport `agent()` builds for you. Only
`baseURL` is required.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `baseURL` | `string` | — (required) | Base URL WITHOUT the `/chat/completions` suffix. |
| `apiKey` | `string \| (() => string)` | none | A static key, or a getter so rotating credentials stay live per request. |
| `headers` | `Record<string, string>` | none | Extra headers merged over the generated ones. |
| `sampling` | `HarnessSampling` | none | `temperature`, `top_p`, `max_tokens`, `presence_penalty`, `frequency_penalty`, forwarded verbatim. `max_tokens` caps the ANSWER; the input window is `contextWindow`. |
| `extraBody` | `Record<string, unknown> \| ((request) => Record<string, unknown>)` | none | The escape hatch for every field this type does not model (`stream_options.include_usage`, `seed`, `stop`, `tool_choice`, …). Merged FIRST, so first-class fields always win. A function is called once per request. Validated at transport construction, not on the first prompt. |
| `responseFormat` | `'text' \| 'json' \| { jsonSchema }` | none | Required response shape: `text` → text, `json` → `json_object`, `{ jsonSchema: { name, schema, strict? } }` → `json_schema`. Beats whatever `extraBody` puts under that key. |
| `contextWindow` | `number` | none | The model's input window in tokens. Set it and `agent()` refuses a request whose estimate exceeds it, BEFORE the request leaves, as a typed `context-overflow`. Enforced by `agent()`, so a custom `stream` gets the same guard; a host calling `openAICompatible()` directly has none. Agent-scope `maxPromptTokens` wins when both are set. |
| `responseHeadTimeoutMs` | `number` | `300000` | Bound on `fetch` resolving with a response HEAD (`HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS`). Cleared the moment the head arrives, so it can never cut off a delivering stream. |
| `firstTokenTimeoutMs` | `number` | `300000` | Bound on the first streamed frame after the head (`HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS`). Generous on purpose: a large-context thinking model is legitimately silent before its first delta. |
| `streamChunkTimeoutMs` | `number` | `120000` | Bound BETWEEN consecutive reads of an open body (`HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS`). Each resolves field → environment variable → shipped default, and `0` turns that one bound off. All three are validated at transport construction. |

The full outbound body, the fields deliberately not sent, and the three request-body
seams: [`docs/request-body.md`](../docs/request-body.md).

---

## 6. `tool(configuration): Tool`

An action. The result is directly callable for a host and registerable for the model;
both paths run the same `execute`.

```ts
const read = tool<string[], FileReadResult>({
    description: 'Read files from disk.',
    tags: ['files', 'read'],
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
    execute: async ({ parameters }) => Promise.all(parameters.map(readFile))
});

await read(['package.json']);        // direct, no harness
harness({ tools: { read } });        // the model calls it by the registry key
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `description` | `string` | — (required) | Shown to the model. An undescribed tool is an unusable tool. |
| `tags` | `readonly string[]` | — (required) | Capability tags used by discovery. An untagged tool is invisible to `toolRequest`, so it could never be found; a tool with no tags throws. Stored trimmed, lowercased, deduplicated. |
| `execute` | `(context: ToolContext) => unknown \| Promise<unknown>` | — (required) | The implementation. Throwing is fine: the harness turns it into a tool result the model can read and recover from, which does not end the run. |
| `name` | `string` | the registry key | Optional label. Inside a harness the registry key names the tool. |
| `visibility` | `'core' \| 'searchable'` | `'searchable'` | `core` tools are declared on every request — keep that list tiny. `searchable` tools stay hidden until `toolRequest` enables them, and the persistent enabled set is bounded by `maxEnabledTools`. |
| `mode` | `'sync' \| 'async'` | `'sync'` | The turn policy this tool's calls DEFAULT to — a call may override it with the reserved `async` argument (below), so this field is a default, not a verdict. It says WHEN a finished call may start the next turn, never how it executes: `sync` joins its batch's sync group — the run is re-entered only once every sync call launched from the same assistant message has settled; `async` triggers its own turn immediately, even while siblings are still in flight. The declared default belongs to the resolved definition, never to the wire name. |
| `parameters` | `Record<string, unknown>` | none | JSON Schema for the arguments; TypeBox output works as-is. **Single-property rule:** for a schema with exactly one property, `execute` receives that property's VALUE, not a wrapper. **Reserved-key carve-out:** the harness offers every tool one extra optional argument, `async`, which is NOT part of this literal — it is added to the model-facing declaration copy and stripped before validation, so a closed (`additionalProperties: false`) schema still accepts it, the single-property rule is unaffected, and `execute` never sees it. A schema that declares `async` itself owns that property and gets no switch. |

#### The reserved per-call `async` argument

Every declaration the harness offers — every registered tool, and the pending-only
`toolCancel` control — advertises one optional boolean argument, `async`
(`TOOL_ASYNC_PARAMETER_KEY`, `src/engine/core/tool.ts:129`; the injected copy,
`withToolAsyncSwitch`, `:156`). It is a **turn-mode switch, not a tool parameter**:

| Call says | That call resolves to | Effect |
|---|---|---|
| `"async": true` | `'async'` | Background: the completion triggers its own turn; the assistant turn stays free. Overrides a declared `'sync'`. |
| `"async": false` | `'sync'` | Inline: the completion joins the sync group of its assistant message. Overrides a declared `'async'`. |
| absent | the tool's own chain | `modeDefinitions` (the discovered registration policy) → `definition.mode` → `DEFAULT_TOOL_MODE` (`'sync'`), `effectiveToolMode`, `src/engine/harness.ts:2073`/`:2082-2083`. |

Resolution per call, in order (`src/engine/harness.ts:11911-11958`): the explicit switch →
the registration/discovered policy → the declared mode → `DEFAULT_TOOL_MODE`; and a
**`delegate`-only refinement** runs after that chain, overriding its answer for one call (step 3,
`loneDelegation`) — see `knowledge.md` "Turn modes: sync vs async (T2)". A switch is read from the raw arguments tolerantly
before validation (`readCallAsyncSwitch`, `src/engine/harness.ts:1229`) and applied to the
RESOLVED definition, so a tool that owns the key has no switch to read.

The key is injected into the **model-facing declaration copy only**
(`withToolAsyncSwitch` at `src/engine/harness.ts:7008` for an ordinary row and `:7037` for
the pending-only `toolCancel` row) and removed centrally, as the first statement of
`resolveToolParameters` (`src/engine/core/schema-validation.ts:336`, the strip at `:353`,
via `stripToolAsyncSwitch`, `src/engine/core/tool.ts:206`). Every plane passes that one
function: the model wire (`src/engine/harness.ts:1213`), `callTool` (`:17549`),
`executeTool` (`:17650`) and the server's manual tool route
(`src/server/api.ts:2937`). Four consequences follow, and all four are the contract:

- a closed schema (`additionalProperties: false`) still accepts the call;
- a ONE-property schema keeps the single-property rule — the published `parameters`
  literal never grows a second property, so `toolParameterKey` (`src/engine/core/tool.ts:66`)
  still unwraps the value for `execute`;
- the key never reaches `context.parameters` or a tool implementation;
- the **published/registered** `parameters` literal — what the host catalogue shows — does
  NOT carry the key; only the offered declaration does (`docs/runtime-tools.md`).

A non-boolean value is a readable refusal from that same strip, on every plane:
`$.async must be a boolean (true for async, false for sync); received <type>.`
(`stripToolAsyncSwitch`, `src/engine/core/tool.ts:206-222`). A malformed payload is not a
switch: it keeps reporting the error the authoritative parse reports.
`call.arguments` in the transcript keeps whatever the model wrote — the strip removes the
value from resolution and validation, never from the record or the provider replay
(`src/engine/types/index.ts:100-123`).

`ToolContext` gives an implementation: `parameters`; `agent?` and `agents?` (the
brains); `run?(name, input, options?)` to start a full child turn on a sibling brain,
with an optional `signal`, a `tools` allowlist (exempting `toolRequest`), `maxTurns` and
an `identity` out-carrier; `callTool?(name, parameters)` to reach another registered tool
through the live registry; `signal?` (a per-call controller linked to the run's, so
`toolCancel` cancels one call without killing the run); `callId?`, `runScope?`,
`runDepth?`, `threadId?`, `toolScope?`; `harness?` (the live handle, or a guarded view of
it on a refusing lane worker — shared memory and the routed operations are reached through
it, as `harness.memory` and `harness.runtime`); and `nestedRuns?`, this instance's policy
at call time. A standalone `tool()(args)` call has no harness, so most of those are
absent there.

A tool may wrap its return value to add presentation without changing what the model
sees: `toolUi(content, panels)`, `toolMedia(content, media)` and `toolText(content,
text)`. The envelope is internal — `content` goes to the model exactly as any other
value, and the panels/media ride on the `tool_result` event only.

---

## 7. Running: `writer(input, options?)`

```ts
(input: string, options?: HarnessRunOptions): Promise<HarnessAssistantMessage>
```

| Option | Type | Meaning |
|---|---|---|
| `signal` | `AbortSignal` | Cancellation for the run, forwarded to every model request, to every tool's `ToolContext.signal`, and to every run it causes (`ctx.run`, `delegate`), so a cancel reaches children too. It is checked before each model turn and each tool call; in-flight background calls are aborted through their controllers. A tool that ignores the signal keeps running, but its late result is discarded. |
| `attachments` | `HarnessAttachment[]` | Files for the ROOT user prompt only, validated before any history mutation. Delegated children and `ctx.run` start from their own text, so a root's bytes are never re-sent with an unrelated request. |

The loop, per call:

```
append user input
repeat:
    turn()                -> assistant message (+ tool calls)
    usage?                -> report what that request spent
    no tool calls?        -> pending work? pause : report done and return
    for each call:        -> LAUNCH it (validation is synchronous, execution is background)
    loop again immediately, with placeholders for the unfinished calls
```

Termination:

- **the model answers with text** — the normal end; the promise resolves;
- an unknown tool, an undiscovered tool, malformed arguments, or a throwing tool becomes
  a readable **tool result** and the run continues;
- **`maxIterations` exhausted**, or a transport failure that outlives the agent's retry
  ladder: every actor's history is truncated back to where the call started and the call
  **rejects** with a `HarnessError`. With background work outstanding, the pending calls
  are aborted rather than orphaned.

A run that finishes with background calls still running emits `done` with a non-empty
`pending` list and keeps its promise open until the tree drains; `wakeup` events keep it
re-requested while ASYNC work is pending (a sync group re-enters the run when it drains —
it is not on the timer, `src/engine/plugins/async-ping.plugin.ts:11-47`).

## 8. The result

`HarnessAssistantMessage` — what the call resolves to and the payload of `done`:

| Field | Type | Meaning |
|---|---|---|
| `role` | `'assistant'` | |
| `content` | `string` | The answer text. |
| `reasoning` | `string` | Accumulated thinking text; always present, empty for non-reasoning models. |
| `toolCalls` | `HarnessToolCall[]` | What the model asked for in this turn; empty when it answered directly. Each is `{ id, name, arguments }`, `arguments` being the raw JSON string as delivered and `id` unique across the whole conversation. |
| `model` | `string` | The model that produced this turn, captured at request time. |
| `stopReason` | `'stop' \| 'length' \| 'tool_calls'` | `tool_calls` means the turn is not finished; the other two are terminal. |
| `usage` | `HarnessUsage` | **Optional**: absent when the provider reported no `usage` block. Never read as zero. |
| `structured` | `unknown` | Present only for an agent built with `structured`, and only when the answer passed the schema. The key is absent, never `undefined`, for every other agent. |

```ts
type HarnessUsage = { input: number; output: number; total: number; cached?: number };
```

`input` is the provider's prompt-token count for ONE request, including any replayed
cache prefix (OpenAI `prompt_tokens` semantics) — that is the current context size as
the provider billed it. `cached` is how much of `input` came from the prefix cache, and
absent means **unknown**, not zero.

## 9. Events

`report.progress` receives every variant below. Each names its `agent`, so a multi-agent
run stays readable in one stream, and `thread` is present only for a NON-ROOT run. One
`usage` event is emitted per MODEL REQUEST, so the usage events — not `done` — are the
complete cost record.

| `type` | Payload | Meaning |
|---|---|---|
| `start` | `model` | A model request began. |
| `text` | `delta` | An answer delta. |
| `reasoning` | `delta` | A thinking delta. |
| `tool_call` | `call` | The model asked for a tool. |
| `tool_result` | `name`, `callId?`, `content`, `isError`, `outcome?`, `ui?`, `media?`, `durationMs?`, `pending?` | One call's result. `isError` is always derived from `outcome`, so the two can never disagree. |
| `usage` | `usage` | Token accounting for the request that just finished. |
| `done` | `message`, `pending?` | A response the consumer is meant to see. Non-empty `pending` means the run is NOT terminal. |
| `retry` | `attempt`, `maxAttempts`, `delayMs`, `error`, `provider?` | The retried attempt is DISCARDED: text streamed before this frame belongs to the failed attempt and none of its tools were executed. |
| `attempt_commit` | `attempt`, `maxAttempts` | One request SUCCEEDED: everything streamed since the previous boundary is final. This is the boundary a tool-calling round has and `done` does not. |
| `wakeup` | `reason: 'pending-tools'`, `pending` | The wake interval elapsed while the board still held an **`async`**-resolving call; the run gets another turn. A sync-only board is never woken this way — the async filter is the shipped rule (`src/engine/plugins/async-ping.plugin.ts:11-47`). A progress event, never a transcript entry. |
| `progress` | `phase`, `toolCallSlots`, `argumentChars` | Tool-call composition heartbeat while a large parallel tool block is still being composed. Counters only, never argument text; purely informational — nothing may end, time out, or reorder a run because of it. |
| `action_request` | `callId`, `request` | The model asked its owner a bounded question. |
| `action_answer` | `requestId`, `answer` | An answer was recorded, owner or automatic. |
| `branch_start` / `branch_end` | `branch` / `branchId`, `status`, `error?` | A fork or auto-answer branch started, or reached `completed` / `failed` / `cancelled`. |
| `error` | `error` (`HarnessErrorInfo`) | A failure, delivered as data because events cross CLI/RPC boundaries. |

`outcome` classifies why a call ended — `completed`, `failed` (the implementation could
not finish), `rejected` (the call never reached an implementation: unknown or
not-yet-enabled name, invalid arguments), `cancelled` (`toolCancel` released it; nothing
failed). Only a non-`completed` outcome is stored on the committed transcript entry.

## 10. Context: current size, effective limit

The engine **returns** token usage; it does not return a "current / effective context
size" pair, because those have different owners.

**Current.** Two numbers, both published:

- `HarnessUsage.input` — what the provider billed for one request, including a replayed
  cache prefix. Optional, because a provider may report no `usage` at all.
- `estimateContextTokens(messages, instructions?, options?: ContextEstimateOptions): number`
  — the published `ceil(serialized-payload bytes / 4)` estimate over the transcript a
  request would send. It backs the UI context bar, the `maxPromptTokens` floor and the
  compaction plugin's trigger, so a host that trims its own history measures the same
  number. It counts message content, assistant tool-call names and raw arguments, and
  leading instructions; with the two-argument call it does NOT count attachment bytes or
  the request's tool schemas, so the real prompt is a little larger. Passing `options`
  adds those three invisible costs as a conservative allowance.

The `turn.before` plugin hook receives both spellings: `estimatedTokens`, frozen at
handler entry, and `currentEstimatedTokens()`, the same estimate re-evaluated against
`currentMessages()` after any write this handler (or an earlier one in the round) made.
Once a run has a request that reported `usage`, both numbers are the provider-anchored
hybrid; before the first report they are the plain bytes/4 estimate.

**Effective.** There is no single number the engine returns. Three independent owners can
cap a request, and each reports its own:

| Owner | Where it is set | Who enforces it |
|---|---|---|
| the agent's pre-request FLOOR | `agent({ maxPromptTokens })` — wins over `provider.contextWindow` | `agent()`, before the request leaves, after any `turn.before` replacement |
| the endpoint's window | `provider.contextWindow` | also `agent()`, so a custom transport is guarded |
| the compaction POLICY | the shipped `context-compaction` plugin's `contextLimit` / `modelLimits` / `headroomRatio` settings | the plugin, at `turn.before` |

The plugin resolves its trigger per turn:
`limit = modelLimits[model].limit ?? contextLimit`, a declared `modelLimits[model].window`
clamps it, and the firing point is that ceiling minus a headroom buffer. Its
`resolveContextTrigger()` returns `{ limit, window?, effective }` and is exported from the
plugin module, NOT from the package root.

The one engine result that carries a current estimate and the effective window together
is the typed refusal:

```
HarnessError { code: 'context-overflow',
               details: { estimatedTokens, contextWindow, model, agent } }
```

`HarnessErrorInfo` — the event form — carries `code` and the message, and does not widen
into that numeric pair.

## 11. The handle

Every member is read live; getters copy, so a host cannot mutate the registry through
them.

### Identity and roster

| Member | Signature |
|---|---|
| `name` / `agent` | `string` / `Agent` — the EFFECTIVE entry agent: `entry`'s brain while it is registered, else the first still-registered one. |
| `agents` | `Readonly<Record<string, Agent>>` |
| `ranks` | `Readonly<Record<string, AgentRank>>` — the RESOLVED map, one entry per registered agent, a frozen defensive copy on every read. |
| `addAgent` | `(name, configuration: AgentConfiguration, options?: { delegate?: boolean; rank?: AgentRank }) => Agent` |
| `removeAgent` | `(name: string) => void` — once it detaches `entry`, `name`/`agent` follow the effective entry. |
| `setAgentRank` / `setAgentInstruction` | `(name, rank)` / `(name, instruction)` |
| `setAgentPrefix` | `(name, prefix: readonly HarnessPrefixTurn[]) => void` — restate one member's PRESET HISTORY (the `prefix` seed of section 4). Idle-only and membership-gated like any roster write; the argument must be an ARRAY, and `[]` is the removal — the runtime has no wider layer to inherit from, so there is no `null` spelling here (the server resolves inheritance before it calls). One write moves three things at once, because the brain owns them: the band in the CURRENT transcript (exactly the entries the last seed pushed, between the instruction block and the legacy `messages` seed — every accumulated turn is kept by reference), the `reset()` baseline, and the configuration a NEW host thread reseeds from. It refuses rather than guessing: a fork has no seed band (its transcript IS its baseline), and a transcript that no longer holds the seeded entries where the seed put them — a compactor rewrote one — is a refusal, not a splice at a shifted position. Read back with `agentPrefixOf` (internal), which is how the server's prefix route states the band the member actually runs. |
| `nestedRuns` | `(policy?: NestedRunPolicy) => NestedRunPolicy` — read, or arm once, the nested-run policy (`'allow'` default; `'refuse'` is armed on lane-worker replicas, and every door that could start a child throws `nested-run-unsupported`). |

### Tools

| Member | Signature |
|---|---|
| `tools` | `Readonly<Record<string, Tool>>` — every registered tool by wire name. Registration is not declaration: `visibility` and the enabled set say which half a name is in. |
| `discoveredTools` | `readonly string[]` — the capped SEARCHABLE enabled set, in discovery order: what `toolRequest` enabled plus what an `enableAllTools` seed put there. Core and withheld names are not in it. |
| `withheldTools` | the names THIS conversation switched off, independent of `discoveredTools`. |
| `isToolSwitchable` | `(name: string) => boolean` — whether the name can hold a cap slot (`false` means "no slot", not "cannot be switched"). |
| `enableAllSwitchableTools` | `() => void` — re-run the `enableAllTools` seed on a live handle; the only way a RESET gets the toolbox a fresh CREATE gets. |
| `registerTool` | `(candidate: HarnessToolRegistrationCandidate) => Promise<HarnessToolRegistrationResult>` — the one compile/load/validate/register path. Publication is a completion barrier; replacements do not spend the creation budget. |
| `toolCreate` | `(configuration: ToolCreation) => Tool` — the host-side runtime creation, same validation, registry and budget as the model's `toolCreate`; throws `HarnessError`. |
| `toolSource` / `toolSources` | `(name) => HarnessToolSource \| undefined` / `() => HarnessToolSource[]` — the installed source revisions. |
| `executeTool` | `(name, parameters) => Promise<unknown>` — the host/manual path; discovery gates the MODEL, not the operator. `parameters` may be the unwrapped value or the schema wrapper. No tool-result envelope: a failure throws. |
| `callTool` | `(name, parameters, options?: HarnessToolCallOptions) => Promise<unknown>` — a nested call through the live registry, resolving the definition at call time. |
| `memory` / `runtime` | `HarnessMemory` (harness-owned shared state) / `HarnessToolRuntime` (routed operations behind the core tool sources). |

### Commands, plugins, knowledge

| Member | Signature |
|---|---|
| `commands` | `Readonly<Record<string, HarnessCommand>>`, keyed WITHOUT the leading slash; each read is a frozen copy of the live registry. |
| `executeCommand` | `(input: string) => Promise<HarnessCommandResult>` — one slash line in this process; the model is never called. A missing `/` or an unknown name throws; a recoverable failure comes back as `{ content, isError: true }`. |
| `registerCommand` | `(command: HarnessCommandConfiguration) => HarnessCommand` — register or replace. |
| `plugins` / `pluginMetadata` | `readonly string[]` in application order / the declared descriptors, JSON-serializable as-is. |
| `knowledge` / `knowledgeOwner` | the base this harness writes through, by reference (never `undefined`) / the trusted attribution name, or absent. |

### State, branches, threads

| Member | Signature |
|---|---|
| `snapshot` | `() => HarnessSnapshot` — JSON-serializable core state, safe to take DURING a live run (committed transcript, discovery, created-tool sources, stores; uncommitted deltas are not). `version` gates the schema (`HARNESS_SNAPSHOT_VERSION`, currently `3`). |
| `restore` | `(snapshot: HarnessSnapshot) => void` — apply to a FRESH harness built from the same definition; a foreign `version` is refused rather than guessed. |
| `reset` | `() => void` — clear the conversation and the session stores; created tools stay registered but are no longer enabled, and the creation budget is not restored. |
| `dispose` | `() => void` — emit `harness.dispose` once and clear plugin subscriptions; it never disposes a host-owned knowledge store. |
| `branches` / `branch` | `() => HarnessBranchRecord[]` / `(id) => HarnessBranchRecord \| undefined` — the retained branch audit records, ephemeral. |
| `records` / `recordsChanges` / `onRecordsChange` | `() => RecordStoreView` / `(since) => RecordStoreDelta` / a change listener returning its unsubscribe. |
| threads | `threads()`, `thread(id, callerThreadId?)`, `threadMessages(id, callerThreadId?)`, `setThreadMessages`, `appendThreadMessages(threadId, messages, fromLength)`, `patchThreadMessages(threadId, messages, expectedLength)`, `setThreadStatus`, `setThreadLabel`, `archiveInvocation`, `reserveIdentity` — the persistent-conversation ledger. |
| thread run doors | `createThread(agent, options?)`, `sendThreadInput(threadId, input, options?)`, `steerThread(threadId, input)`, `stopThread(threadId, reason?)`, `stopAllThreads(reason?)`, `deleteThread(threadId)`. |

## 12. Errors

```ts
class HarnessError extends Error {
    readonly code?: string;      // stable machine name; `name` is set to the same value
    readonly details?: unknown;  // structured recovery payload
    readonly cause?: unknown;    // the original transport/parse error
}
```

A rejection a caller must ACT on carries a `code`, and the code is also the first token of
the message, because the model, the HTTP surface, a worker report and an operator all
quote one identifiable name. (`errorCodeOf` in `src/engine/util/errors.ts` is the package's
own total classifier for a hostile thrown value; it is internal, so a host switches on
`error.code` after an `instanceof HarnessError` guard.)

| `code` | When |
|---|---|
| `context-overflow` | The pre-request floor refused the transcript, or the provider answered input-too-long. `details` carries `{ estimatedTokens, contextWindow, model, agent }`. Never retried. |
| `provider-timeout` | A provider time bound expired (own 4-attempt ladder, 2 s/4 s/8 s, 900 s wall clock). |
| `provider-connection` | Nothing answered the dial (own 3-attempt ladder, 250 ms/500 ms). |
| `provider-rejected` | The provider deterministically refused the request. |
| `provider-aborted` | The provider reported a cancel that was not our signal. |
| `structured-output-invalid` | The answer failed the agent's `structured` schema; nothing is committed and nothing is retried. |
| `stale-record` | A record write was refused against a newer revision; `details` names the current entry. |
| `nested-run-unsupported` | A lane worker refused a door that would start a child conversation. |

Configuration mistakes (`bad entry`, a bad rank letter, an invalid `color`, a non-positive
bound, a tagless tool) are plain `HarnessError`s with no code: they are bugs on the line
that built the harness, not conditions a caller recovers from.

## 13. Where the rest lives

| Topic | Document |
|---|---|
| The package tour, the preset catalogue and its tool posture, CLI and server usage | `README.md` |
| The internal map: what owns what, and why | `knowledge.md` |
| Plugin authoring: `api.on`, `turn.before` decisions, `context.edit`, settings, teardown | [`docs/plugins.md`](../docs/plugins.md) |
| The self-modifying runtime-tools loop | [`docs/runtime-tools.md`](../docs/runtime-tools.md) |
| The built-in transport's exact outbound body | [`docs/request-body.md`](../docs/request-body.md) |
| The HTTP + WebSocket surface over the engine | `src/harness-server.swagger.yaml` |

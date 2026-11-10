# Plugins — the authoring guide

> **Status:** Authoring documentation for the plugin surface as it stands on
> 2026-11-09, the day the pipeline-v2 stage landed (event bus v2, the
> `HarnessTurnDecision` pipeline, the mutation API, and the worker-lane sync —
> `docs/tasks/2026-11-09-plugin-pipeline-v2.md` now carries only the remaining
> work — the two probes and the boundaries closed by decision). This document
> describes the code and its tests; it does not assert a passing production
> verification run.
> **Source of truth:** `src/plugin/hooks.ts` (the dispatch rules, header
> "THE RULES"), `src/plugin/host.ts` (the per-plugin api view),
> `src/plugin/settings.ts` (the settings read/write edges), `src/types/index.ts`
> (every published contract named below), and `src/harness.ts` (the only
> emitter, and the consumer of a turn decision). Where this guide quotes a
> rule, the file that owns it is named.

A plugin is code the application shipped. It subscribes to the harness
lifecycle, and at exactly one boundary — the `turn.before` hook — it may
rewrite what the provider is about to see and decide what happens to the run.
Everything else a plugin does is a side effect through `api`, using the same
handle methods a host calls. This guide states the rules an author has to
honour; the reasoning and the decisions live in the task entries, and this
file is the place a reader meets them first (requirement R8 of the pipeline
entry).

---

## What a plugin is

```ts
const myPolicy: HarnessPlugin = {
    name: 'my-policy',                                  // unique in one harness
    metadata: {
        name: 'my-policy', title: 'My policy',
        hooks: ['turn.before'],                          // DECLARED (UI data)
        settings: [{ key: 'limit', label: 'Limit', type: 'number', default: 50 }]
    },
    setup(api) {
        api.on('turn.before', (context) => {            // LIVE — what actually runs
            if (context.estimatedTokens < api.settings.number('limit')) return;
            // ... act ...
        });
    }
};
```

- `setup(api)` runs **once, synchronously**, during `harness()` construction.
  It subscribes and registers; it does not await and cannot be async
  (`harness()` stays a plain factory).
- `metadata` is DATA: it is what the Plugins pane renders
  (`HarnessPluginMetadata.hooks`). The bus separately records what `setup()`
  ACTUALLY registered (`createHookBus().live()`), and the pane compares the
  two. A declared-but-unregistered hook is a UI row that fires nothing; an
  undeclared-but-registered one is a live surprise. Keep them equal.
- Application order: the generated built-ins first (`src/plugin/manifest.ts`,
  a **build-time** scan of `src/plugins/*.plugin.ts` — a browser cannot read
  files), then the host's `configuration.plugins` entries; a later entry with
  the same `name` **replaces** in place. Plugins apply after the built-ins and
  `configuration.commands`, so `api.addTool`/`api.addCommand` replace a name
  rather than colliding with it.

### The trust boundary (decided 2026-11-09)

Plugin code is **built-ins plus host-provided only** (pipeline T0, Q1(a)).
There is no operator-installable plugin mechanism: no registry, no module
resolution, no supply-chain story — and the shipped server never passes
`configuration.plugins` at all, so today a running server runs exactly the
built-ins plus whatever settings an operator edits. A lane replica is built
from the same preset record, which is why the worker problem disappears under
this answer — and also why a **closure cannot reach a worker**: the settings
provider and the diagnostic sink are in-process objects, and a lane worker
gets neither (the `WORKER MODE` section of `src/server/plugins.ts` states the
limit for the provider; `lane-worker-loop.ts` `sayHello` states it for the
sink). The capability tiers (observe / context / conversation-control / host)
are the recorded **design target** for `api` (Q2(a)), not the current state:
a plugin holds the raw host surface, and `metadata.capability` deliberately
does not exist until foreign code is ever loadable.

---

## Global enablement — the operator's switch

Every plugin answers to **one reserved setting key, `enabled`**, and the framework —
not the plugin — acts on it. An operator flips it with a single click:

```http
PATCH /v1/harness/plugins/{plugin_id}
{ "settings": { "enabled": false } }
```

**Resolution** is the ordinary settings order, and there is only one rule:

```
effective = stored override  ??  the plugin's declared `enabled` default  ??  true
```

A plugin that **declares** `enabled` in its own `metadata.settings`
(`src/plugins/context-compaction.plugin.ts` does, as its Rule 0) keeps its own
descriptor and its own default, and the framework gate and the plugin's own
`api.settings.boolean('enabled', …)` read the **same stored value** — they can
never disagree. A plugin that does **not** declare it (`async-ping`) still
answers to it, because the key belongs to the framework: `src/server/plugins.ts`
synthesizes the descriptor for the write edge, the persisted snapshot, the
restore filter, and the read. The key is therefore accepted for every plugin and
`GET /plugins` reports it on every row as the top-level `enabled` field — while
`values` stays the projection of the **declared** keys only (a key absent from
`settings` never appears there, so a client editing a form never edits
enablement by accident).

**What "off" means, precisely.** Nothing is un-loaded and nothing is
un-registered:

| Off stops | Off leaves alone |
|---|---|
| every lifecycle **hook delivery** to that plugin's handlers | its tools, agents, commands and slash commands |
| the payload construction behind an `if (bus.has(event))` emit guard | its row in `GET /plugins` (still listed, with `enabled: false`) |
| a plugin-owned timer from re-arming and waking (`async-ping` re-reads the key in its own `arm`/`tick`) | its settings, its source revision, and every other plugin |

The gate lives in one place — `runPlugins` in `src/plugin/host.ts` builds each
plugin's settings view and hands the bus a **live** `enabled()` predicate per
registration — and `src/plugin/hooks.ts` rule 9 applies it at dispatch. Three
consequences worth knowing:

* **`harness.dispose` is exempt.** A disabled plugin still receives the
  teardown event, so its timers, listeners and handles are always released. A
  `'*'` observer is exempt for that event too, because the gate is applied to
  the event being **delivered**, not to the event that was subscribed.
* **A gate that throws reads as enabled.** Fail-open, like every other hook
  rule: a host that cannot read its own settings document must not silence
  every plugin in the process. A skipped delivery is *not* reported through
  `onHandlerError` — an operator turning a plugin off is not a plugin failure.
* **The switch is live, so it is global.** `harness()` stores the provider by
  reference and the settings view re-reads it on every access, so an accepted
  PATCH changes what **every existing session and thread** does on its very next
  turn: no rebuild, no re-registration, no restart. There is deliberately no
  idle gate on the route — a settings write moves no registration and removes no
  schema a model was promised — so the Plugins page is usable while a
  conversation is running. The value is durable before the response
  (`state.json`, under `pluginSettings`), and a restart reads it back before the
  first request.

`count()` follows dispatch (it answers "how many handlers would this event
reach right now"), while `live()` stays registration-based on purpose: the
Plugins pane compares an author's declared `metadata.hooks` with what
`setup()` actually subscribed to, and a disabled plugin did still subscribe.

A CPU-isolated **lane worker** sees the same limit as every other settings
read: a provider closure cannot cross `worker_threads`, so a replica that is
already running picks the new value up when its lane is next created
(`src/server/plugins.ts`, `WORKER MODE`).

---

## The event catalogue

Eighteen events (`HarnessLifecycleEvent`), payload per event in
`HarnessLifecyclePayloads`:

| Group | Events | Payload |
|---|---|---|
| Threads | `thread.created` `thread.started` `thread.paused` `thread.resumed` `thread.stopped` `thread.idle` | `HarnessThreadRecord` |
| | `thread.deleted` | `{ threadId, agent }` (the record is already purged) |
| Runs | `run.started` | `HarnessRunLifecycleContext` |
| | `run.finished` | `…& { message }` · `run.failed`: `…& { error }` |
| Turns | `turn.before` | `HarnessTurnBeforeContext` — **the only event whose return value means anything** |
| | `turn.after` | `HarnessTurnAfterContext` |
| Tools | `tool.before` | `…& { call }` · `tool.after`: `…& { call, callId, content, isError, outcome, durationMs }` |
| Async | `async.pending` `async.drained` | `HarnessAsyncLifecycleContext` (`agent` is the SCHEDULER identity: display name or `thread:<id>`) |
| Host | `host.state_change` | `HarnessStateChangeEvent` verbatim — **explicit subscription only, never through `'*'`** |
| Teardown | `harness.dispose` | `Record<string, never>` |

`run.*` fires for EVERY run, delegated children and branch runs included, so
a plugin can observe the whole tree; `threadId` is absent for a branch run.
A `tool.before` hook **cannot veto a call** — a refusal needs a tool result,
and that is the model's contract rather than a hook's. The only "no" a hook
can say to a tool is "don't run it next turn" (`api.disableTool`), or a
`stop`/`pause` decision at the next turn boundary.

---

## Subscribing

`api.on(event, handler, options?)` returns an unsubscribe function
(idempotent). Three subscription facts decide most plugin behaviour:

- **Named** subscriptions keep their exact per-event payload typing. The
  wildcard is a SEPARATE OVERLOAD, so `'*'` never widens `E`.
- **`'*'` is an observer, not a party** (bus rule 7). It receives
  `{ event, payload }` as a discriminated union
  (`HarnessWildcardEventContext`), so `event` and `payload` narrow together
  and no `any` reaches your code. Its result is ALWAYS discarded — a
  wildcard entered on a `turn.before` frame cannot rewrite the request by
  accident. It is delivered every catalogue event EXCEPT `host.state_change`
  (`WILDCARD_DELIVERABLE` in `src/plugin/hooks.ts` is a `Record` over the
  whole union: adding an event fails `tsc` until its author decides whether
  an audit plugin receives it). `live()` reports a wildcard expanded into
  exactly the events it will receive, so the Plugins pane keeps telling the
  truth about it.
- **Subscribing during an emit** takes effect the next round: dispatch walks
  a snapshot (rule 3), so a handler cannot mutate the loop it is part of.

### `priority` and `timeoutMs`

Both live on the same options object and both default to the historical
behaviour:

- `priority` — dispatch rank WITHIN one event: higher first, default `0`,
  ties broken by registration order (stable). It reorders nothing ACROSS
  events — a `tool.before` handler can never move in front of the
  `turn.before` that precedes it.
- `timeoutMs` — a per-handler budget, **fail-OPEN**: a handler that
  outlives it is dropped AND reported (`kind: 'handler-timed-out'`); the
  round continues with the handlers that survived, and the late result is
  ignored whenever it arrives. A budget bounds the **wait**, not the damage:
  a side effect the handler already made (a flag write) stays made. The
  timer is armed ONLY at the moment a handler returns a thenable — a
  synchronous handler never costs a timer, which is the same discipline as
  the fast path below.

### Fail-open, and reported

A handler that throws, rejects, times out, or returns a decision this
contract cannot parse is DROPPED; the run never sees the error (rule 2), and
every drop is REPORTED (rule 8). `harness()` always installs the reporter
(`createHookBus({ onHandlerError: notifyPluginDiagnostic })`), so in
production a broken plugin is visible on the host's
`harness({ report.diagnostic })` sink with `kind`
`'handler-threw' | 'handler-timed-out' | 'invalid-decision'`, and the
shipped server journals these on the session (`plugin_diagnostics`, bounded,
durable) and prints the failure kinds to stderr. Two honest limits: a plugin
cannot yet see ANOTHER plugin's failure (no mirror event — the reporter is a
host channel), and a lane replica installs no sink at all.

### The synchronous fast path — the microtask rule

`turn.before` is dispatched through `emitMaybeSync` (bus rule 6). While
every handler stays synchronous the round resolves on the caller's tick and
the run loop applies it with **no `await`**; the first handler that returns
a thenable switches that round to the async branch. Why an author cares:
the shipped `context-compaction` plugin subscribes `turn.before`
unconditionally, so the guard `if (bus.has(event))` can never skip the
round — an `async` handler on that event adds a microtask to **every
model turn**, and concurrent runs interleave on exactly those boundaries,
so observable event order changes. The regression this is pinned by is
`src/server/queue.test.ts` ("a late observer disconnect cannot cancel the
queued task that started next").

The worked example is the plugin itself
(`src/plugins/context-compaction.plugin.ts`): under the limit, off the
cooldown, or on a branch round the handler returns **synchronously** and
does nothing; only a real trigger crosses the async boundary (pause →
action → resume). Write your `turn.before` handler the same way: decide
sync, go async only when you are actually waiting on work.

### Per-handler payload freshness

Every handler of a round is entered with a freshly built context, so a
later hook sees what an earlier hook already wrote (a flag, an edit, a
`setTranscript`). Do not cache one context object across a round, and do
not assume your `entries` snapshot is another handler's.

---

## `turn.before` — anatomy of the round

The payload (`HarnessTurnBeforeContext`) is the exact request about to go
out plus the controls to change it. Four pairs of views, each with a
different freshness contract:

| Entry-time (stable for the handler) | Live (at access time) |
|---|---|
| `messages` — the projection the handler was ENTERED WITH | `currentMessages()` — the projection as it is NOW; after your write, what the provider will actually receive |
| `estimatedTokens` — the size of that entry-time projection | `currentEstimatedTokens()` — the same estimate over exactly what `currentMessages()` returns, so a compactor can measure what its own prune just saved |

Both pairs are plain values on entry **deliberately**: `context-compaction`
compares `estimatedTokens` against its limit and its cooldown map, and a
mid-handler write moving that number underneath those checks would let a
compaction trigger on a transcript it never measured. While nothing has
been written, `messages` and `currentMessages()` are the SAME array, so an
observing handler pays nothing for the distinction. After the round both
live views freeze to what the round decided.

`entries` is the FULL canonical transcript, in canonical order, INCLUDING
disabled units — context control never deletes, it hides reversibly, so the
units a projection filtered out are exactly the ones you need to re-enable.
It is built **lazily on first access**, cached for that one handler (its
entries stay usable for `setIncluded` across mere transcript growth),
rebuilt for EVERY handler, and frozen when the round closes. A handler that
calls `replaceHistory()` invalidates every entry captured before it —
`setIncluded` then refuses a stale entry loudly, and the cure it names is
"read `entries` again".

### Addressing a turn: three targets

`setIncluded(target, boolean)` accepts:

1. an **entry** from this round (`context.entries[i]`) — resolved by message
   identity; valid across growth, stale after `replaceHistory()`;
2. a **number** — the index, interpreted against the CURRENT transcript;
3. a **`messageId` string** — the durable address (`msg-<n>` within one
   conversation). It resolves in a LATER round of the same conversation,
   after `restore()`, and after a `replaceHistory()` that kept the entry.

Ids are minted once when the runtime creates a canonical message, **COPIED
across a fork, a branch materialization and a snapshot** (never re-minted
on a copy), and backfilled when a document predates ids — so one
`setIncluded(id, …)` names the same turn on either side of a fork. An id is
scoped to ONE transcript: lookup is a scan of this agent's messages, so the
same number in another conversation is not a conflict (an INCORPORATED
branch legitimately holds a duplicate, and an id resolves to its first
occurrence). An id that names nothing gets the stale-entry refusal with the
cure named. A canonical message that reached the transcript by a raw
host push may carry no id at all — address those by entry. `edit` stays
**entry-addressed**: a bare id there is a shape error, because rewriting
text under an index that shifted is exactly the risk a flag can tolerate
and text cannot.

### The two writes

- **`setIncluded(target, included)`** — switch one transcript entry, or the
  WHOLE tool-call unit it belongs to (an assistant block plus every result
  answering its calls), off or on for the model. Only `false` is stored;
  `true` REMOVES the key, so an unflagged transcript stays byte-identical
  and re-enabling is the exact inverse. Targeting any member of a unit
  addresses every member — a request never carries a half-answered
  `tool_calls[]` or an orphan result. `included` must be a strict boolean
  (`'yes'`, `1`, `0`, `null` are refused, not coerced); the value is checked
  after the target and before anything is written, so a refused call writes
  nothing.
- **`edit(entry, patch)`** — change the TEXT of one canonical entry in
  place, under closed role rules (`HarnessContextEditPatch`): `content` for
  every role, `reasoning` for an assistant only. A `tool` result may change
  its **content only** — `toolCallId` and `name` are the pairing keys the
  unit resolver and the transport both trust, so a patch naming them is
  refused, as is any other key (`role`, `toolCalls`, `attachments`,
  `included`, `messageId`) and an empty patch. `included` is refused here
  because it is the OTHER axis: it cascades to a whole unit, and an edit
  never cascades. The entry is resolved and the whole patch validated
  BEFORE a single field is written (a refusal leaves the transcript
  byte-identical); a legal edit writes in place, dirties the round's
  projection cache so **the same request carries the new text**, and
  reports one `agent_message` change.

Both writes are **canonical**: they survive later turns,
`snapshot()`/`restore()`, and any store that persists on the notification
(the server's `state.json`) — in BOTH execution lanes (under
`threadExecution: 'worker'` the lane pushes the in-place change as a
whole-prefix, digest-guarded `transcript:patch`; the authority replays and
reports it. When canonical rewrote that prefix first, the patch is refused
WHOLE, the lane re-reads, and this round's write is dropped — the policy
re-derives it on the next `turn.before`). On a **branch run** both writes
land on the ephemeral copy — its own request is still filtered — and report
nothing, because there is no conversation to persist them into.

`edit` introduces **no new message field** — `content`/`reasoning` are
already whitelisted per role in `src/core/snapshot.ts` and
`src/core/branch.ts`. That is the persistence rule for the next author: a
new per-message field must join every one of those allowlists, or an
edited/flagged transcript stops loading.

### Request-only, committed, and the one coalesced report

Four distinct decisions, four scopes — never conflate them:

| Call | Scope |
|---|---|
| `setTranscript(messages)` (or returning `{ transcript }`) | THIS REQUEST only; committed history untouched. Last non-empty wins; an empty array is never an override. |
| `replaceHistory(messages)` | the COMMITTED transcript, validated through the snapshot reader and notified like every transcript write. Requested re-reads: it invalidates captured entries. **Refused on a branch run** (a branch owns an ephemeral copy). |
| `setIncluded` / `edit` | canonical, per-entry/unit writes — durable, reversible, re-projected into the same request. |
| returning `{ decision }` | the RUN (below); it says nothing about the request unless it is a `replace`. |

A plugin round reports **one** `agent_message` per round, however many
canonical writes it made: `setIncluded` and `edit` mark the round dirty and
the round close flushes the single report BEFORE the request goes out, so
durability is never later than it was. A 40-unit prune schedules one
whole-document save, not forty. Two edges ride along: a write that lands
after the round already closed (a handler that parked its context) reports
on the spot, because its window is gone; and a rejected async round flushes
before re-raising, so a failure cannot lose the report for writes that did
land. Host writes (`postThreadMessage`, `writeThreadTranscript`) stay
per-write — the batch window is a plugin round, not a time window. Nothing
debounces across a run boundary: the observer IS the durability mechanism,
and a flush that never arrives would silently lose a write.

### `actorKey` and `branchId` — telling a root round from a branch round

`threadId` means the SPAWNING conversation: a branch run (a fork or an
`actionRequest` autoanswer) and its root report the SAME `threadId`. That is
the shipped meaning and it is pinned; do not read it as "the conversation
this round belongs to". For the discriminator:

- `actorKey` — the run's scheduling identity (a registered agent's display
  name, `thread:<id>` for a host thread, `branch:<id>` for a branch). ALWAYS
  different between a root round and a branch round of one conversation.
- `branchId` — the branch's own id (`branch-<n>`, the same value the
  state-change plane reports). Present ONLY when this run IS a branch.

A policy that must not prune a transcript that is about to be incorporated
into its owner checks `branchId` — which is exactly what the shipped
compactor now does (it declines to act on a branch round at all).

### The two shipped context passes — who owns what

The posture, in one sentence: **the engine core trims nothing** — the projection is a pure
skip filter over canonical history and nothing in it windows, truncates, elides or reorders —
**and `context-trimmer` is the one place trimming happens**, one rule per switch. Both
built-ins subscribe `turn.before`, and compaction is dispatched first (manifest order,
`src/plugin/manifest.ts`).

The trimmer's settings (`PATCH /v1/harness/plugins/context-trimmer`, read live on the next
turn of every session) ARE the policy surface:

| Switch | Default | What it decides |
|---|---|---|
| `enabled` | `true` | The framework's reserved key: hook delivery on or off. Off stops every policy below and undoes no flag an earlier turn wrote |
| `dropSupersededToolCalls` | `true` | The shipped rule, verbatim: a fully answered unit whose every committed result `failed` or `rejected`, where EVERY tool NAME it called has a `completed` answer in a still-included later unit, stops being sent — as a whole unit |
| `dropInvalidToolCallsOnceAnswered` | `true` | The same rule generalised over `invalidOutcomes`. Independent of the row above; with both off, no tool unit is ever withheld — the engine's posture |
| `invalidOutcomes` | `"failed,rejected"` | The closed set `failed` \| `rejected` \| `cancelled` \| `empty` the generalisation may act on. Unknown names are dropped (so is `completed`), the pass says which it used, and a set that resolves to nothing disables the generalisation |
| `dropOldThoughts` | `"turn"` | Which thinking stops being replayed: `off`, `turn` (the open turn keeps its thinking, every closed turn's is withheld) or `all`. Any other string behaves as `turn` and the diagnostic says so |
| `thoughtKeepUnits` | `0` | The recent-N tier on top of that tier; every value above `0` is documented as cache-hostile |
| `supersedeMatch` | `"name"` | `name` is the shipped loosening; `fingerprint` is compaction's exact rule (`src/core/argument-fingerprint.ts`), which makes the two passes agree by construction — the value that makes compaction's failure-retry prune redundant, per the overlap note below |
| `dropDuplicateCalls` | `false` | Withhold an earlier unit a later unit re-ran with an identical fingerprint — the only switch that can withhold work the model actually used |
| `minTokens` / `minThoughtChars` | `0` | A pass under the floor writes nothing at all. The tool floor never gates thinking, because the estimator does not count `reasoning` (`src/core/context-estimate.ts`) |
| `safetyUnits` | `0` | Units at the END of the transcript no tool trim may touch; `0` removes the horizon |
| `maxUnits` | `0` | Cap on how many tool units ONE pass withholds; `0` is unbounded |

A `string` tier accepts any string at the PATCH edge (that edge owns the declared type and the
published numeric bounds, never the content of a string), so the closed set is the plugin's
decision: an unrecognised value runs as its documented fallback and the pass diagnostic names
the value submitted beside the value used.

Three things no switch changes, and each setting's text says so rather than letting an
operator discover them: a unit is withheld **whole** or not at all (provider pairing is
unit-atomic, so half a unit never leaves); an **unanswered** call is never touched; and every
policy is **withhold-only inside a session** — flipping a switch off stops new writes and
restores nothing, which is the property that lets the compactor skip any phase check against
this pass (`src/plugins/context-compaction.plugin.ts` reasons about exactly that). A branch
round and an internal agent's transcript are never trimmed, and no setting is even read on
either.

What compaction still owns alone is the pressure problem: its per-model trigger
(`contextLimit`, `modelLimits`), its savings floor, its tail horizon and its cooldown shape a
whole-conversation pass, and in `summarize` mode it spends a model turn the trimmer never
spends.

**The overlap, resolved deliberately (task T9, ratified 2026-11-10): compaction keeps its
failure-retry pruning.** Both passes can name the same superseded failed unit, and the answer is
the runtime's, not a new phase check, priority, or knob:

- **Who writes.** The first pass dispatched in a round that has a candidate acts — compaction is
  dispatched first (`src/plugin/manifest.ts` scan order), then the trimmer. The other pass reads
  the LIVE unit flag (`src/core/context-pruning.ts` `groupUnits` → `unit.included`, and
  `planTrimmedUnits` step (1) in `src/plugins/context-trimmer.plugin.ts`), proposes nothing, and
  therefore reports nothing: a round with BOTH built-ins enabled produces exactly one
  `setIncluded(leader, false)` for that unit and exactly one pass line. Pinned by the
  `context-compaction × context-trimmer overlap` cases in
  `src/plugin/context-compaction.test.ts`, at the action level (the recorded write count) and
  through a real harness (the flags, the request, the diagnostic owners, the round's save
  count).
- **What `supersedeMatch: 'fingerprint'` changes.** It swaps the trimmer's evidence rule for
  compaction's exact one (`toolCallFingerprint(name, canonicalArguments)`,
  `src/core/argument-fingerprint.ts`) instead of the looser name-only match, so on that value
  the two rules select the same unit by construction; on the shipped default (`name`) the
  trimmer's rule is a strict superset of compaction's. Either way compaction's failure-retry
  prune is redundant-but-harmless for that class — its own `minTokens` / `safetyTurns` /
  cooldown gates still decide whether it acts at all, and if it acts first, the trimmer simply
  finds the unit already withheld.
- **Why the prune stays.** It is the eviction path for an operator who wants the compacting pass
  to own it: with `dropSupersededToolCalls` and `dropInvalidToolCallsOnceAnswered` off (or
  `enabled: false` on the whole trimmer, `PATCH /v1/harness/plugins/context-trimmer`),
  compaction prunes superseded failures under its own floor and horizon — and compaction keeps
  the roles the trimmer can never take: the pressure trigger, the `summarize` retention range,
  and the summary entry that pass commits into the transcript.
- **What no switch touches.** Both passes are withhold-only, and a withheld unit is exactly one
  `false` flag, so a double pass cannot double-write and an operator "off" restores nothing.
  That monotonicity is the compactor's stated reason for needing no phase check against this
  pass (`src/plugins/context-compaction.plugin.ts`, the section on the other shipped
  `turn.before` pass), and it still holds with twelve trimmer switches and the thinking flag:
  the trimmer's only two writers take the literal `false` — `setIncluded(entry, false)` and
  `setReasoningIncluded(entry, false)` — and it calls no `setTranscript`, no `edit`, no
  `replaceHistory`.

The compaction fixtures still switch the trimmer off through their settings provider
(`src/plugin/context-compaction.test.ts`, `src/server/persistence.test.ts`) — not because the
two passes fight, but so each of those cases measures ONE plugin's numbers; the overlap cases
are the ones that leave it at its declared defaults.

The trigger reads one setting beyond `contextLimit`
(`src/plugins/context-compaction.plugin.ts`):

- `modelLimits` (a JSON string map, model id → `{ limit?, window? }`) —
  `limit` replaces `contextLimit` for that one model; `window` states the
  model's HARD context window and CAPS whichever limit is in force. The model
  id is read live from the agent, so switching models changes the ceiling on
  the next turn. Anything malformed — broken JSON, a value that is not an
  object, a non-positive limit — is ignored rather than an error, and a model
  that is not in the map takes the global settings.

There is no headroom beside the limit: the limit IS the firing point. A turn
whose estimate is at or above the effective limit fires the pass on that turn
— a former `gapTokens` knob that fired N tokens early was removed in favour
of the single number.

---

## What a decision does to the run

`turn.before` may return `{ transcript }`, `{ decision }`, or both in one
object. `HarnessTurnDecision` is a closed union of four actions:

| Action | Effect on the run |
|---|---|
| `continue` | the default: send what this round resolved and keep running. Saying it out loud is how a LATER plugin clears an earlier plugin's `pause`/`stop` (last-wins per channel). |
| `replace` | send `transcript` for this request only — identical to the `{ transcript }` sugar, which stays shipped and is normalized into this channel. |
| `pause` | park the CONVERSATION (the roster goes `'paused'`, exactly `context.pause()`) and **still send this request**. A pause is a roster signal for the host and other plugins, not a control-flow break; `resume()` returns it to `running`. |
| `stop` | end the RUN without pretending an answer exists. The run's own abort path is taken (for a conversation, the same `stopThreadState` every stop travels: record → `stopped`, queue discard, task-claim release, one `thread.stopped`), then the run unwinds: the transcript rolls back to where the run started — the same splice the `maxIterations` guard uses, so an orphan assistant message is impossible — the invocation records `cancelled`, `run.failed` (not `run.finished`) carries the plugin's `reason`, and the caller rejects with it. A BRANCH run has no conversation to stop and must not abort its parent's signal, so it marks the run plugin-stopped and throws the reason directly (recorded `cancelled`, not `failed`). |

`reason` is what the caller, `agentResult` and the run record see; a
non-string reason is dropped so it can never reach the UI as
`[object Object]`. `respond` (answer without a provider call) and `retry`
are **deferred**: both change what the terminal `done` frame means, and
neither has a consumer yet.

### Merge and precedence, stated once

The bus reduces one round into `{ transcript?, decision? }`
(`contributionOf` / `parseDecision` / `mergeContribution` in
`src/plugin/hooks.ts`), and the harness consumes it in the same order for
both the sync and the async branch (`requestOf` / `applyTurnDecision` in
`src/harness.ts`). Top-down:

1. an **explicit replace** — a returned `decision: { action: 'replace' }`
   or the equivalent returned `{ transcript }`; a returned value wins over
   an earlier `setTranscript`, and across handlers the LAST non-empty value
   wins. An empty array is never an override.
2. otherwise the **re-projected canonical flags** — if a handler wrote
   `setIncluded`/`edit` and nobody explicitly overrode the transcript, the
   round re-projects so the change lands on THIS request (and every later
   one). A round that did neither hands back the original projection array
   untouched — same identity, same bytes.
3. `pause`/`stop` **compose** with 1 and 2: the transcript is still decided
   exactly as above, and the RUN is additionally parked or ended.
4. order within a round: `priority` (higher first), then registration
   order; "last wins" means last IN that dispatch order, so an operator
   reordering `configuration.plugins` cannot silently flip a policy
   collision that `priority` decides.
5. an **unparseable decision is ignored AND reported**
   (`kind: 'invalid-decision'`), never thrown into the run — and the rest
   of that same handler's result (a valid `transcript`) still applies.

With no decision anywhere, the hot path reads one `undefined` and is
byte-identical to a hook-less run — pinned by
`src/server/queue.test.ts` (unchanged) and by a frames-matched test.

---

## `api` — what a plugin can reach

`HarnessPluginApi` is the whole surface; every thread/agent/tool operation is
the SAME handle method a host calls, so a plugin cannot reach a private path
with different rules.

- `agents`, `tools`, `createAgent`, `addTool`, `addCommand` — live
  registries; registrations REPLACE a name (the plugin phase runs after the
  built-ins and `configuration.commands`).
- `threads.*` — `list` `create` `delete` (+ `remove` alias) `stop` `send`
  `steer` `messages` `replaceMessages` `setStatus`. See the prohibition
  below about `send` on your own thread.
- `snapshot()` — the SAME detached document the host's `harness.snapshot()`
  returns: agents and transcripts, discovery, created tools, thread records,
  the record stores. Safe MID-RUN (a synchronous read of COMMITTED state;
  partial provider text is a progress event, never snapshot state, and
  branch transcripts are ephemeral and excluded). **Read-only in effect:**
  it hands out a detached copy, so mutating the returned object changes
  nothing, and the read itself reports no state change — that is what makes
  one call per turn safe. The way to change persisted state is a write the
  harness reports (`edit`, `setIncluded`, `replaceHistory`,
  `replaceMessages`), not an edit of a copy. There is deliberately **no
  `api.restore()`**: a restore replaces registries and is refused while any
  run is live — a host decision.
- `settings` — `get` plus coercing `number`/`string`/`boolean` accessors (a
  stored value of the wrong shape falls back to the declared default, so a
  corrupt host document can never hand a plugin a NaN), and the one write:
  **`setOwn(key, value)`**. It is namespaced to the plugin that owns the
  view — there is no cross-namespace spelling — and it validates against
  the plugin's OWN descriptor with the server's write-edge rules: the key
  must be declared, the value must match the declared type (a numeric
  string is accepted for a number and NORMALIZED; a string is accepted only
  for a `string` setting), a number must be finite and inside `min`/`max`.
  `step` stays a UI hint and is NOT enforced. `null`/`undefined` are
  refused, not treated as "reset". The write always goes **through the
  host's provider**, never around it, and the two possible hosts get
  different, stated answers: a harness with no `configuration.pluginSettings`
  has the library's in-memory provider, where `setOwn` works for the
  lifetime of the PROCESS and persists NOTHING — it is not in `snapshot()`
  and does not survive a restart; and a provider that implements `get`
  alone — which is the shipped server's live provider, read-only by
  construction so its store stays the one that validates, bumps the
  revision and schedules the save — has NO writer, and `setOwn` THROWS
  saying so rather than keeping a copy nobody reads. Wiring a host store's
  write path is host work, not a library fallback.
- `report.diagnostic({ message, data? })` — the plugin's OWN voice on the
  same advisory channel the framework uses for handler failures
  (`harness({ report.diagnostic })`). Its report is stamped `kind: 'policy'`
  and owned by the plugin's name (the host stamps the owner; a plugin cannot
  forge a report about another plugin). Synchronous, never awaited, cannot
  fail a run: a missing reporter is a silent no-op and a throwing sink is
  swallowed. This is where a compactor names the units it withheld, each
  one's estimated tokens, and the id of the unit that superseded it — the
  difference between "compacted" and "silently did nothing".
- `enableTool` / `disableTool` / `enabledTools` — the progressive-discovery
  gate; both refuse a CORE declaration (it is always in context, so
  switching it would be a lie), and `enableTool` may evict an over-cap name.
- `async.pending(agent?)` / `async.wake(agent?)` — the background board and
  the wake. The scheduler owns NO timer: the wake is a plugin policy
  (`async-ping`), and `wake()` is the only way one is produced.
- `config` — read-only, exactly `{ wakeIntervalMs }` (legacy compat).

---

## `host.state_change` — the persistence plane, by invitation

The host's `report.stateChange` plane is bridged into the bus as a declared
event, payload identical (`HarnessStateChangeEvent` — reasons
`agent_message | tool_execute | tool_create | thread | reset | restore`,
with `branchId` on branch writes), so a plugin and a host share ONE
vocabulary. It is **explicit-subscription-only**: it fires on every
transcript, tool, and thread mutation — far more often than any run event —
so it is the one event `'*'` does NOT deliver, and a `'*'` subscriber that
wants it opts in BY NAME and cannot be double-delivered. It is fired
synchronously (this plane sits inside commit points), and its observer is
swallowed on a throw exactly like the host's. There is no hidden
re-entrancy guard: a `host.state_change` handler that writes transcript
state RE-ENTERS this notify, and that is the author's contract, not the
bus's.

---

## Teardown — `harness.dispose` and `dispose()`

`harness()` returns a handle with a **`dispose()`** member, and the server
binds it to session teardown (`SessionStore.disposeSession`, reached by
`remove()` and by a store shutdown). The contract:

- **Exactly once.** A latch, not a flag check: a second `dispose()` is
  idempotent and fires nothing more. The event is emitted once and the bus
  is cleared right after, so a handler that re-subscribes during teardown
  dies with the harness.
- **Never raced against a run.** `dispose()` is NOT an abort: if a run is
  live, the event is PARKED and emitted by the last run to settle — from
  the END of the run's finally, after that run's `run.finished`/`run.failed`
  and after `thread.idle`. Teardown never lands in front of a thread's
  terminal hooks.
- **Not snapshot state.** A dispose is a process fact; a restored harness
  has a fresh bus by construction.

A plugin that only needs "the harness is going away" subscribes to
`harness.dispose` — the shipped `async-ping` plugin has declared that
subscription ("clear everything") since before any harness path emitted the
event, and it is live now, not inert. (Its own source header and its hook handler both
still called the event "reserved" after T1.6 — a code-side one-liner flagged in the
landing record rather than edited by a docs pass, and CORRECTED IN PLACE 2026-11-09 by
the final-verification pass: `src/plugins/async-ping.plugin.ts` now says the event is
live and names `emitDispose` and the server's `disposeSession` binding.)

---

## Do not call `api.threads.send` on the thread whose turn is parked, from inside a hook

A `turn.before` handler that calls `api.threads.send(threadId, …)` for the
SAME thread whose turn it is sitting in re-enters that actor key's turn
serializer mid-round (`serializeTurn(run.actorKey, …)`), against the "no
overlapping harness execution per actor" property the queue suite pins.
Whether that deadlocks or merely queues behind the parked turn has **never
been probed** — and the recorded decision (pipeline entry, open decision 3,
2026-11-09) is therefore a **prohibition, not a finding**: do not do it, and
do not read the parked turn as making it safe. Sending to a DIFFERENT actor
key (another thread, another agent) is a different question, is already
exercised by the state-aware `threadSend`, and is fine. Closing this needs
one probe test — a send-to-self from `turn.before` under a fake transport
with a bounded wait — and whichever stage adds it replaces this paragraph
with what it observed.

---

## Author checklist (the short version)

- Decide sync if you can; the fast path is a contract, not an optimization
  (`queue.test.ts` will fail you, not your reviewer).
- Report every failure mode you rely on: a dropped handler is visible on
  the diagnostic channel — your own decisions should be too
  (`api.report.diagnostic`).
- Address turns by `messageId` if the write must survive the round; by
  entry if it must not outlive it. Never hold an entry across
  `replaceHistory()`.
- Never delete history — hide it with `setIncluded`, reverse it with
  `setIncluded(…, true)`.
- A `pause` parks the roster and the request still goes out; a `stop` ends
  the run through the abort path and rolls the run's own writes back. Say
  which you mean.
- Check `branchId` before writing durable policy; a branch's writes are
  ephemeral and silent.
- Do not send to your own thread from a hook (above).
- Do not add a per-message field without updating the snapshot/branch
  per-role allowlists, or your transcript stops restoring.

Companion reading: `docs/tasks/2026-11-09-plugin-pipeline-v2.md` (framework
decisions), `docs/tasks/2026-11-09-context-inclusion-followups.md` (now only
the missing UI marker for an excluded turn),
`docs/tasks/2026-11-09-progressive-compaction.md`
(the policy that consumes all of this), and the shipped built-ins
`src/plugins/context-compaction.plugin.ts`,
`src/plugins/context-trimmer.plugin.ts` (the same `turn.before` boundary, and
the one place trimming happens: every rule is its own switch, the economy
knobs `minTokens`/`minThoughtChars`/`safetyUnits`/`maxUnits` are declared and
default to off — no limit, no floor, no horizon unless the operator asks —
and it is still the smallest policy that writes canonical state and reports
it), and
`src/plugins/async-ping.plugin.ts` as worked examples.

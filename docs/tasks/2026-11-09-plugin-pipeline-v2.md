# Plugin pipeline v2 — decisions, not only transcript rewrites

Status: **open — stage not started; T0 (the capability/security model) blocks the API
shape and must be decided first.** Written from a static audit of the plugin surface,
against revision `44cdbbe` ("Upgraded Task Logic") of the **`@underload/harness`
package repository** (its own git repo at `packages/underload/harness/.git`, not the
workspace root), working tree **dirty with the uncommitted Stage 1 context-inclusion
work** — `git diff --stat -- src` reports 2 206 insertions / 108 deletions across 15
files (`src/harness.ts`, `src/types/index.ts`, `src/core/agent.ts`, `src/core/branch.ts`,
`src/core/snapshot.ts`, `src/harness.inclusion.test.ts` and the persistence tests). Every
`path:line` below was read out of that tree; line numbers will drift, so the identifier
names in this document are the durable anchors and the *drift check* near the end lists
the commands to re-verify them.

Written for an implementer who did **not** do that audit and who must treat this file as
the whole brief: what exists, what is missing, why the missing parts matter, and the check
that closes each task. Nothing here has been implemented — this is a specification of
intent plus a map of the surface, not a guarantee that the surface still looks like this.

Companion entries: [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md)
(Stage 1's own edges, including the worker-lane sync gap this stage must close),
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) (the
consumer that needs these capabilities), [2026-11-09-thread-timeout-policy.md](./2026-11-09-thread-timeout-policy.md)
(a `pause`/`stop` policy that interacts with T2 below), and
[../issues/0007-improvements-review-list.md](../issues/0007-improvements-review-list.md)
(cross-cutting review items; not duplicated here).

## Date / Method / Scope

**Date:** 2026-11-09.

**Method:** static audit only. Each finding was produced by reading the declaration, the
merge/dispatch code, and the emit site of the same capability, then confirming the
negative with a targeted grep (for example "which events does production emit?" by
grepping `hookBus.emit`/`hookBus.fire` call sites in `src/harness.ts`, and "does the
server pass `plugins`?" by grepping `plugins` across `src/server/harnesses/*.ts`). No
live session and no test run was performed for this entry — it is a documentation-only
change, so **no test run is required**; see *Not tested* for what was therefore not
observed.

**Scope:** the plugin framework as it stands — the lifecycle bus (`src/plugin/hooks.ts`),
the plugin host and api (`src/plugin/host.ts`, `src/types/index.ts`
`HarnessPluginApi`), the harness emit sites (`src/harness.ts`), the server's wiring of
plugins and settings (`src/server/harnesses/toolbox.ts`, `src/server/plugins.ts`), and
the worker-lane transcript protocol (`src/server/workers/*`).

**Out of scope (deliberately):** the *policy* of compaction (which turn to drop, which
summary to write) — that is
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md); the
token-budget and provider-overflow gaps —
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md);
and tool-registry lifecycle —
[../issues/0007-improvements-review-list.md](../issues/0007-improvements-review-list.md).

## Requirement

The stage exists so that a plugin can be a **policy owner** rather than a transcript
rewriter. Expanded into the claims the work must satisfy:

- **R1 — a plugin may decide, not only rewrite.** At a turn boundary a hook must be able
  to say: continue as planned, replace what will be sent, pause the run, or stop it. The
  current surface can do the second only (`setTranscript` / a returned `transcript`).
- **R2 — several plugins must compose predictably.** Order, precedence, per-handler
  budgets (a timeout), and what happens when one handler throws must all be defined and
  observable, not an accident of registration order plus "last non-empty wins".
- **R3 — a plugin must be able to observe everything the host can observe**, or a stated
  subset: wildcards so an audit/telemetry plugin can subscribe once, and the teardown
  event that is declared but never emitted today.
- **R4 — a plugin must be able to mutate context safely**: switch inclusion (shipped in
  Stage 1b), edit an entry within its role's rules, and nothing else. History is never
  deleted — context control hides reversibly (the standing product rule;
  `src/types/index.ts:117-134`).
- **R5 — a plugin's write must survive what the host's write survives**: the same
  conversation, a snapshot/restore, and — under `threadExecution: 'worker'` — a restart.
  The last one is currently false (`src/types/index.ts:3493-3502`).
- **R6 — the trust boundary must be explicit.** Either the harness only ever runs code
  the application shipped, or installing foreign plugin code is allowed and then bounded
  by a capability model. "Raw server access, unlimited, undecided" is not an acceptable
  resting state, because `api` already carries the whole harness control surface
  (`src/types/index.ts:3613-3643`).
- **R7 — the framework invariants must survive the change**: the synchronous fast path /
  microtask neutrality, fail-open dispatch, per-handler payload freshness, observable
  event ordering, and provider tool-call pairing.
- **R8 — an author must be able to learn all of this without reading `harness.ts`**: one
  guide, one reference, and release notes for behaviour that only gets additive.

## Findings

### F1. `turn.before` is the only hook whose return value means anything, and the value can only be a transcript

The result type is a single-key object, and the per-event result map gives every other
event `void`:

| What | Where | Value today |
|---|---|---|
| "`turn.before` is the ONLY hook whose return value matters" | `src/types/index.ts:3254-3257` | comment in the event union's own header |
| `HarnessHookResult` | `src/types/index.ts:3569-3571` | `{ transcript? } \| void` |
| `HarnessLifecycleResult<E>` | `src/types/index.ts:3573-3575` | `E extends 'turn.before' ? HarnessHookResult : void` |
| Merged bus result | `src/plugin/hooks.ts:88-92` | `HarnessMergedHookResult = { transcript? }` — no decision channel |
| Where the result is consumed | `src/harness.ts:7763` (`emitMaybeSync`), `:7768-7793` (`requestOf`), applied `:7799-7820` | the merged transcript becomes the request body and nothing else |
| Handler signature | `src/types/index.ts:3577-3581` | sync or async, result discarded for every other event |

`tool.before` states the limit out loud rather than leaving it to be discovered — the
emit-site comment says a hook **"cannot VETO a call — a refusal needs a tool result, and
that is the model's contract rather than a hook's"**, and the emit result is dropped on
the floor (`src/harness.ts:6131-6141`; `fail`/`immediateResult` are the harness's own
refusal path at `:6149`, `:6040-6063`). So today the only "no" a plugin can say is
"don't run that tool **next turn**" (`api.disableTool`, `src/types/index.ts:3645-3651`).

Consequence for the pipeline: a decision needs (a) a decision type on the result, and
(b) a consumer that acts on it in the run loop. The loop's natural seams are
`src/harness.ts:8148` (`await requestTurn(run)`) and the boundaries right after it —
`throwIfAborted` at `:8163`, the `maxIterations` guard at `:8123-8128`, and `turn.after`
at `:8193-8199` (which today also discards its result).

### F2. Merge is "last non-empty wins", with no priority, no timeout, and no production diagnostics

| Rule | Where | Notes |
|---|---|---|
| Sequential, registration order, awaited | `src/plugin/hooks.ts:18-21` (rule 1) | "LAST NON-EMPTY WINS … only means something with a defined order" |
| Fail-open: a throwing handler is dropped, the round continues | `src/plugin/hooks.ts:22-23` (rule 2), `:282-286`, `:312-315` | the run never sees the error |
| Empty array is not an override | `src/plugin/hooks.ts:168-179` (`overrideOf`) | `[]` means "nothing to say" |
| Last non-empty wins | `src/plugin/hooks.ts:280-281`, `:326-327` | no priority field anywhere |
| No per-handler timeout | `src/plugin/hooks.ts:117-155` (the whole bus type) | one handler that never resolves parks the turn forever |
| `onHandlerError` exists but is optional | `src/plugin/hooks.ts:71-75`, `:181-184` | "Absent = silent (still skipped)" (`:182`) |
| Production passes nothing | `src/harness.ts:1150` — `createHookBus()` | so a real handler failure is **invisible**: no reporter is wired anywhere in `src/` (grep `onHandlerError` → only `src/plugin/hooks.ts` and its test) |
| Harness-visible precedence comment | `src/harness.ts:7361-7369` | `setTranscript` vs a returned `{ transcript }` vs `setIncluded` |

Two sharp edges worth naming before the tasks: (1) a hook that awaits real work (a
summarizer call) **holds the turn open indefinitely**, because nothing bounds it; (2) with
two plugins that both rewrite, the winner is whoever registered last, and the registration
order is itself fixed only by `runPlugins` application order (`src/plugin/host.ts:16-25`,
`src/harness.ts:9579-9585`) — an operator reordering `configuration.plugins` silently
changes which policy wins.

### F3. A fixed 17-event enum, no wildcard, one event that is never emitted, and three host-only signal planes

| What | Where | Value today |
|---|---|---|
| Event union | `src/types/index.ts:3266-3283` | exactly 17 members (7 `thread.*`, 3 `run.*`, 2 `turn.*`, 2 `tool.*`, 2 `async.*`, 1 `harness.dispose`) |
| No wildcard | `src/plugin/hooks.ts:120-124` (`on` is keyed by `E extends HarnessLifecycleEvent`), `:165-166` (`isEventName` refuses anything not a non-empty string) | an audit plugin must register 17 handlers and learns nothing about events added later |
| `harness.dispose` never emitted by production | `src/types/index.ts:3263-3265` ("NO harness path emits it yet: `harness()` has no dispose/close method"), `:3394` (payload `Record<string, never>`) | only test code emits it: `src/plugin/hooks.test.ts:342-349`, `src/plugin/async-ping.test.ts:509-514`; the shipped ping plugin declares it and is inert (`src/plugins/async-ping.plugin.ts:34`, `:83`) |
| Progress plane is host-only | `src/types/index.ts:2400` (`HarnessProgress`), `:2852` (`report.progress`) | a plugin has no `report` accessor: `HarnessPluginApi` (`:3584-3668`) carries no progress member |
| State-change plane is host-only | `src/types/index.ts:2424-2443` (`HarnessStateChangeReason` / `…Event`), `:2857` (`report.stateChange`); emitter `src/harness.ts:1127-1140` | the reasons are exactly `agent_message \| tool_execute \| tool_create \| thread \| reset \| restore`; the observer callback is swallowed on throw (`:1134-1139`) |
| Server revision/event hub is host-only | `src/server/api-events.ts:142-180` (`HarnessEventHub`), `:269` (`createHarnessEventHub`) | one hub per API instance (`:265-268`); the plugin api cannot see a revision bump, so a plugin cannot tell a host what changed for the UI |

`api.on` is the **only** subscription a plugin gets, and the bus's `live()` accessor is
what the server reports as the live hook surface versus the declared
`metadata.hooks` (`src/plugin/hooks.ts:149-152`, `src/types/index.ts:3317-3320`) — so any
new subscription form (wildcard) has to keep `live()` honest, or the Plugins pane starts
lying.

### F4. The plugin api reaches threads/agents/tools/commands/async/settings-read — and nothing else

`HarnessPluginApi` (`src/types/index.ts:3584-3668`) is the whole surface, and the harness
builds it once (`pluginApiBase`, `src/harness.ts:1180`) and clones the two per-plugin
members in the host (`src/plugin/host.ts:53-55`, `:136`).

| Reachable | Where | Not reachable (and who owns it instead) |
|---|---|---|
| `agents`, `tools`, `createAgent`, `addTool`, `addCommand` | `:3585-3598` | **sessions** — a server concept (`src/server/sessions.ts`); the api has `threads` only (`:3616-3643`) |
| `on` | `:3600-3607` | **global config** — `config` is exactly `{ wakeIntervalMs }` (`:3667`), documented as legacy-compat read-only |
| `settings` (read + coerce only) | `:3609-3611`, `:3355-3362` | **writing its own settings** — no setter; writes go through the server store (`src/server/plugins.ts:272`, `:517`; route `src/server/api.ts:1997`; contract `src/server/harness.swagger.yaml:847`) |
| `threads.*` (list/create/delete/stop/send/steer/messages/replaceMessages/setStatus) | `:3613-3643` | **persistence** — `snapshot()`/`restore()` are harness handle members, not api members (`:3003`, `:3011`) |
| `enableTool`/`disableTool`/`enabledTools` | `:3645-3651` | **event hub / revisions** — `src/server/api-events.ts:142`, `:269` |
| `async.pending`/`async.wake` | `:3653-3661` | **plugin load/unload at runtime** — `runPlugins` runs once during construction (`src/plugin/host.ts:136`; `src/harness.ts:9579-9585`) and the handle only reports what was applied (`:2990`, `:2997`) |

The header comment is candid about the intent: "Harness control (R3: 'a plugin can trigger
anything within the server'). Every operation is the SAME handle method a host calls"
(`src/types/index.ts:3613-3615`). That is exactly why T0 is blocking — the surface is
currently **broad but shallow**, and adding sessions/snapshot/event-hub/raw-settings-write
to it without a capability model turns every built-in plugin into a full host.

### F5. A running server never passes `configuration.plugins`: it executes generated built-ins, and host replacement is programmatic only

| Fact | Where |
|---|---|
| The field exists and is honoured by `harness()` | `src/types/index.ts:2869` (`plugins?: readonly HarnessPlugin[]`), consumed at `src/harness.ts:9581` (`plugins: configuration.plugins ?? []`) |
| Application order: generated built-ins first, then host entries, a name replaces in place | `src/plugin/host.ts:16-25`; `src/harness.ts:9569-9585`; generated wiring `src/plugin/manifest.ts:36-45` (`BUILTIN_PLUGINS`) |
| The server's live harness factory does **not** set `plugins` | `src/server/harnesses/toolbox.ts:532-589` builds `liveConfiguration: HarnessConfiguration` and `:590` calls `harness(liveConfiguration)`. Grepping `plugin` in that file yields only the **settings provider** pass-through (`:578-587`) |
| Same for the scripted demo preset | `src/server/harnesses/presets.ts:299` (a `harness({ … })` literal with no `plugins`) |
| Same for a lane worker replica | `src/server/workers/lane-worker-loop.ts:968-984` — `preset.create(settings, progress, { stateChange, interaction })`; the report type declares only `interaction` (`src/server/harnesses/types.ts:40`) and `pluginSettings` (`:53`) |
| The server's plugin surface is settings + catalogue only | `src/server/plugins.ts:1-20` (its one live provider), `:272`, `:517`; the documented worker limit is the `WORKER MODE` section at `src/server/plugins.ts:56-65` |

Consequence: `configuration.plugins` — the "an operator swaps the shipped compaction
plugin out" mechanism the host header advertises (`src/plugin/host.ts:20-22`) — is
**unreachable through the shipped server**. A deployment can change a built-in's settings
and can rebuild a harness programmatically; it cannot add a plugin, and a lane worker
cannot even receive the live settings provider (a closure cannot cross `worker_threads`,
`src/server/harnesses/toolbox.ts:581-587`). Also note **stale cross-references** in that
area, which T4.5 must fix while it is open:

- `src/server/harnesses/types.ts:51-52` names **two** relatives of its own directory, and
  **neither resolves**: `./sessions.ts` ("SessionStore passes one provider … `buildHarness`")
  and `./plugins.ts` ("see ./plugins.ts, WORKER MODE"). From `src/server/harnesses/` there
  is **no** `sessions.ts` and **no** `plugins.ts` (directory listing); the real files are
  `src/server/sessions.ts` — where `buildHarness` is a private method at `:2021` — and
  `src/server/plugins.ts`, whose `WORKER MODE` section is at `:56-65`. The correct relative
  form from that file is `../sessions.ts` / `../plugins.ts`.
- `src/server/plugins.ts:69` points at `../types/index.ts:3053-3118` "the descriptor,
  metadata, and provider contracts", which now live at `src/types/index.ts:3288-3362`; the
  same file also cites the provider's "nothing stored" signal as `:3110` (`:21`) and the
  numeric-hint rule as `:3053-3056` (`:40`) — the corresponding text is now
  `src/types/index.ts:3341-3350` and `:3285-3302`.

### F6. Worker lanes publish appended slices only, so an in-place inclusion change never reaches the authority

The lane protocol is delta-shaped **by design**, and the design comment says so:

| Fact | Where |
|---|---|
| "Nothing here is a whole-state diff: each op names the prefix, the digest, or the identity it depends on" | `src/server/workers/lane-worker-loop.ts:632-634` |
| The only transcript op a lane owes is an append when the replica is LONGER | `:638-648` — `if (transcript.length > lane.committedLength) ops.push({ kind: 'transcript:append', fromLength, messages: transcript.slice(lane.committedLength) })` |
| `committedLength` is the canonical PREFIX this replica holds | `:134-139`, initialised `:184`, advanced `:775`, `:1084`, `:1089` |
| The mutation union has no replace/patch form for a transcript | `src/server/workers/lane-commit.ts:183-208` — `transcript:append` at `:189`; the patch-with-`expects` shape exists only for records (`record:update`, `:185`) |
| The authority applies append, and answers a pull for the tail | `src/server/workers/lane-authority.ts:773-775` (`appendThreadMessages(threadId, messages, fromLength)`), `:129` + `:705` (`transcript:sync` with `haveLength`), conflict code `prefix-moved` at `:845` |
| Turn start PULLS the canonical delta but never PUSHES an in-place edit | `src/server/workers/lane-worker-loop.ts:1092-1096` (`runExclusive(() => syncTranscript())`), `syncTranscript` at `:817-855` |
| The contract already documents this as a known, not-yet-durable case | `src/types/index.ts:3493-3502` — "a lane whose authority holds the transcript receives only APPENDED SLICES … so an in-place flag change on an ALREADY-COMMITTED message does not reach the authority until a full-transcript sync exists — planned for the server-integration stage, NOT in place now" |

A `turn.before` hook that calls `setIncluded` therefore works completely in inline mode
(the write lands on canonical state and is reported: `src/harness.ts:7621-7640`) and works
**only until the process restarts** in worker mode. That is an R5 violation with a named
fix, and it is the reason T4 belongs in this stage rather than in the compaction stage:
the compactor is the first plugin whose output is durable state.

### F7. Stage 1's own API has four limits a pipeline v2 must either fix or document

| Limit | Evidence |
|---|---|
| Entries are addressed by **index or live object identity** — there is no stable message id anywhere in `HarnessMessage` | `src/types/index.ts:108-112` (`HarnessToolCall`), `:141`/`:155`/`:167`/`:196` (the four variants, no id key); `HarnessContextEntry.index` is a snapshot of the position at build time (`:3419-3425`); resolution is `canonical.indexOf(target.message)` (identity) at `src/harness.ts:7579-7590` |
| `replaceHistory()` invalidates every entry captured before it, and a numeric index is interpreted against the CURRENT transcript | `src/types/index.ts:3421-3424`; refusal text names the cure (`src/harness.ts:7583`, and the `:7557-7559` comment); the ordering caveat is in the emit-site header (`:7373-7378`) |
| A branch round has no first-class discriminator: `threadId` is the SPAWNING conversation for a branch, `run.actorKey` (`branch:<id>`) is only a fallback | `src/types/index.ts:3447`, `:3397-3408`; the comment spelling this out is `src/harness.ts:7681-7689` ("a plugin therefore cannot tell a branch round from a root round by `threadId`") |
| Every `setIncluded` write reports one persistence notification, so N writes in one round are N whole-document saves waiting to be coalesced | `src/harness.ts:7638-7640`; the save model is a whole-document atomic rewrite (`src/server/persistence.ts:33-44`, `:1557-1616`; tracked as a review item in [../issues/0007](../issues/0007-improvements-review-list.md), *Operations and scaling*) |
| Still in Stage 1's shape: `estimatedTokens` is the value at **handler entry**, not after writes; `entries` is lazy and frozen at round close | `src/harness.ts:7718-7725` (deliberate: a mid-handler write must not move the number under the compactor's own checks), `:7661-7679`, `:7475-7480` |

None of these are defects; all of them are things a **pipeline** (multiple plugins,
decisions, durable writes) turns into footguns, which is why they are listed here and
tracked with owners in
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md).

### F8. Invariants the change must not break (each one is already pinned by a named test or contract)

| Invariant | Where it lives | What breaks it |
|---|---|---|
| **Synchronous fast path / microtask neutrality.** An always-subscribed but inert hook must be event-order identical to no hook | `src/plugin/hooks.ts:41-50` (rule 6), `:292-331` (`emitMaybeSync`), `src/harness.ts:7385-7402` and `:7795-7805`; the regression is `src/server/queue.test.ts:1305` ("a late observer disconnect cannot cancel the queued task that started next") | any `await` added to the `turn.before` hot path, including "harmless" logging in a new dispatch step |
| **A `has()`-guarded empty emit is free** | `src/plugin/hooks.ts:33-40` (rule 5) — every emit site is `if (bus.has(event)) …` (`src/harness.ts:4407`, `:6011`, `:6136`, `:8813`, …) | an unguarded emit that builds payloads nobody listens to |
| **Fail-open.** A handler that throws never fails the run | `src/plugin/hooks.ts:11-14`, `:22-23`, `:282-286` | a merge step that rethrows, or a decision parser that throws on a plugin's typo |
| **Per-handler freshness** (a later hook sees an earlier hook's write) | `src/plugin/hooks.ts:103-115` (payload factory once per handler), `src/harness.ts:7356-7364`, `:7655-7659` | caching one context object per round |
| **Provider pairing.** Exclusion is unit-wide; the projection stays pair-clean | `src/types/index.ts:131-134`, `src/harness.ts:564-580` (`transcriptUnits`), `:5702-5814` (`projectTranscript`); pinned by `src/harness.inclusion.test.ts` and the `wireIssues` oracle of `src/harness.background.test.ts:365` | any new per-message mutation that can split an assistant block from its results |
| **Event ordering is observable** (delegated children interleave with the parent) | `src/plugin/hooks.ts:33-40`, `src/harness.ts:8807-8813` | re-sequencing emits, or emitting `harness.dispose` from a path that races a run |

## Tasks

Order matters: **T0 is a blocking decision**, T1–T3 are the framework change, T4 is the
server/worker integration, T5 is the contract text, T6 is verification. T1/T2/T3 touch
`src/plugin/hooks.ts`, `src/types/index.ts` and `src/harness.ts` in the same region
(`emitTurnBefore`, `:7404-7821`), so they land as one sequence, not three.

### T0 — Decide the capability/security model (blocking)

Two questions, each with the trade-off named so the answer can be recorded here rather
than re-litigated:

- **Q1 — who may supply plugin code?**
  - **(a) built-ins + host-provided only** (today's *de facto* state, F5): the server
    needs no new input surface, no module resolution, no supply-chain story, and the
    worker problem disappears (a replica is built from the same preset record,
    `src/server/workers/lane-worker-loop.ts:968-984`). Cost: an operator cannot add a
    plugin without shipping a build.
  - (b) operator-installable external plugins: needs a registry/allowlist, module
    resolution rules (`src/plugin/manifest.ts:1-19` shows the built-in scan is a
    **build-time** generator, `node scripts/generate-plugin-manifest.mjs`, because
    "a browser cannot read files"), a load-time failure story, and a trust statement
    beside the existing Origin gate
    ([../issues/0007](../issues/0007-improvements-review-list.md), *Security and trust
    posture*: the host has no authentication).
- **Q2 — what does `api` grant?**
  - **(a) capability-scoped**: split `HarnessPluginApi` into tiers (observe / context /
    conversation-control / host) and have a plugin declare the tier it needs in
    `metadata` (which is already data the UI reads, `src/types/index.ts:3308-3325`).
    Cost: a real type refactor plus a migration note.
  - (b) raw host access (today): cheapest, but it means an external plugin can delete
    threads, replace tools and drive runs, and F4 shows there is no way to say "this one
    may only read".

**Recommendation (recorded, and reversible by the owner): Q1(a) for this stage, Q2(a) as
the shape to design toward.** Rationale: it keeps the honest sentence "a plugin is code
the application shipped" while the pipeline gains real power, and the capability tiers are
needed anyway for T2's decision rights (`stop` is a much larger grant than `replace`).
If the owner chooses Q1(b), T4 gains a sub-task and the security review becomes blocking.

*Check:* this section names one answer per question, plus the owner and the date, and the
`metadata` type (`src/types/index.ts:3308-3325`) either gains the capability field or
records why it does not. No T1-T4 code lands before that sentence exists.

### T1 — Event bus v2: wildcards, priority, diagnostics, and the missing teardown

- **T1.1 — wildcard subscription.** Accept `'*'` alongside the 17 names, delivering
  `{ event, payload, threadId?, agent }` (typed via the existing
  `HarnessLifecyclePayloads` map, `src/types/index.ts:3368-3395`, so no `any` at the
  boundary). Keep `on(E)` exact for named subscriptions; add a separate overload rather
  than widening `E`, or the payload typing collapses. Wildcards must be **load-time**
  subscriptions only — a hook that subscribes during an emit is already handled by
  snapshot iteration (`src/plugin/hooks.ts:24-26`, `:298`).
- **T1.2 — `live()` must report a wildcard honestly**, or the Plugins pane's live-vs-declared
  comparison (`src/plugin/hooks.ts:149-152` vs `src/types/index.ts:3317-3320`) drifts.
  Recommended shape: expand a wildcard registration into **all current event names**,
  because `live()`'s return type is keyed by `HarnessLifecycleEvent`
  (`src/plugin/hooks.ts:152`) and cannot carry a `'*'` key without widening it — if a
  marker is wanted, widen that type deliberately rather than inventing a pseudo-event.
- **T1.3 — optional priority on `on`** (`registration?: { owner, api, priority? }`,
  `src/plugin/hooks.ts:120-124`), default 0, **stable within a priority** (registration
  order), and document that priority reorders *within one event* only.
- **T1.4 — per-handler budget.** Add an optional `timeoutMs` to the same registration
  object. Semantics must be fail-open, not fail-closed: a timed-out handler is dropped
  **and reported**, never allowed to hold the turn (F2). Keep the sync fast path intact —
  a timer may only be armed once a handler has actually returned a thenable
  (`src/plugin/hooks.ts:317-324` is exactly that moment).
- **T1.5 — wire `onHandlerError` in production.** `createHookBus()` at
  `src/harness.ts:1150` passes no options. Route it to the host's existing observer
  channel (`report.stateChange`-style, or a new `report` member — but see T1.6: a plugin
  must be able to see it too) so a broken plugin is visible in `GET /sessions` or the
  log, without ever failing a run (rule 2).
- **T1.6 — emit `harness.dispose`.** `harness()` has no teardown today
  (`src/types/index.ts:3263-3265`), so either add `close()`/`dispose()` to the handle
  (a new handle member beside `snapshot`/`restore`, `:3003`-`:3011`) or bind disposal to
  server session teardown. It must fire exactly once, after the last run of every thread,
  and clear the bus (`src/plugin/hooks.ts:153-154`, `clear()`) — which is what
  `async-ping` already assumes it needs (`src/plugins/async-ping.plugin.ts:34`).
- **T1.7 — optional bridge for the host-only planes (F3).** The cheapest honest form is
  a new declared event `host.state_change` (or a `state.` prefix) emitted from
  `notifyStateChange` (`src/harness.ts:1127-1140`) with the existing reason union
  (`src/types/index.ts:2424-2432`) — behind an explicit subscription, never a wildcard
  default, because the state-change plane fires far more often than any run event and a
  naive bridge would put a handler on every tool execution.

*Check:* focused run of the bus and plugin tests —
`npx vitest run src/plugin/hooks.test.ts src/plugin/host.test.ts src/plugin/settings.test.ts src/harness.plugin.test.ts src/plugin/async-ping.test.ts src/plugin/context-compaction.test.ts`
plus the fast-path guard `npx vitest run src/server/queue.test.ts`, which must stay green
**unchanged** (F8): it is the proof that a permanently-subscribed, usually-inert hook costs
no microtask. New assertions: a wildcard handler sees every emitted event exactly once with
the right payload; a priority-1 handler runs before a priority-0 handler registered
earlier; a handler that never resolves is dropped at its budget and reported; a throwing
handler is reported (T1.5) and the round still completes; `harness.dispose` fires once on
teardown and clears the bus.

### T2 — Turn decision pipeline: `HarnessTurnDecision`

- **T2.1 — the type.** Add to `src/types/index.ts` beside `HarnessHookResult`
  (`:3569-3575`):

  ```
  HarnessTurnDecision =
      | { action: 'continue' }
      | { action: 'replace'; transcript: readonly HarnessMessage[] }
      | { action: 'pause'; reason?: string }
      | { action: 'stop'; reason?: string }
  ```

  `respond` (synthesize an answer without a provider call) and `retry` are **deferred /
  open** (see *Open decisions*): both change what the `done` event and the run record
  mean, and neither has a consumer yet. Keep `{ transcript }` working as sugar for
  `replace` — it is a shipped contract pinned by `src/harness.plugin.test.ts` and by
  `src/harness.inclusion.test.ts`, and T0's answer does not change that.
- **T2.2 — merge semantics, stated in one place.** Extend `overrideOf`/`finishRound`
  (`src/plugin/hooks.ts:168-179`, `:255-290`) into a single reducer that returns
  `{ transcript?, decision? }`. Precedence, top-down, and it must match the existing
  prose at `src/harness.ts:7361-7369`:
  1. an explicit `replace` (a returned decision, then `setTranscript`) — last wins;
  2. otherwise the re-projected canonical flags (`requestOf`'s `currentProjection()`
     branch, `src/harness.ts:7771-7783`);
  3. a decision of `pause`/`stop` composes with 1 and 2 — the transcript is still decided,
     the *run* is additionally parked or ended;
  4. ties by T1.3 priority, then registration order;
  5. an unparseable decision object is **ignored and reported** (fail-open), never thrown
     into the run.
- **T2.3 — where it lands.** The bus round is already the single choke point:
  `emitMaybeSync('turn.before', …)` at `src/harness.ts:7763` and `requestOf` at
  `:7768-7793`. Return the merged decision alongside the transcript from `emitTurnBefore`
  (`:7404-7407`, `:7799-7820`), and consume it in `requestTurn` right after
  `const requestTranscript = before.sync ? before.value : await before.promise`
  (`:7867-7868`):
  - `continue`/`replace` → today's behaviour, unchanged;
  - `pause` → park the record via the existing `pauseThreadState` path (the same one
    `context.pause()` uses, `:7754-7756`) and **let the turn proceed**: pause is a roster
    signal, not a control-flow break, and `resume()` already returns it to `running`
    (`:7757-7759`);
  - `stop` → abort the run **without** pretending an answer exists: reuse the run's own
    abort/reason machinery (`throwIfAborted` defined at `src/harness.ts:5405`, applied at
    `:8163`; `abortErrorOf` at `:5418`) so the run records as stopped/cancelled with the plugin's reason, and
    `run.finished`/`run.failed` stay truthful (`:8854-8867`).
- **T2.4 — preserve the hot path.** `stop`/`pause` may only add work on the turn that
  actually asks for it. With no decision the code path must remain identical to today's,
  including on the sync branch (`:7799-7805`), or `src/server/queue.test.ts:1305` breaks.
- **T2.5 — interaction with the timeout policy.** A `stop` decision is a *new* way for a
  run to end before its final answer, next to `maxIterations`
  (`src/harness.ts:8123-8128`; `DEFAULT_MAX_ITERATIONS = 16` at `:459`). It does not
  violate R1/R2 of [2026-11-09-thread-timeout-policy.md](./2026-11-09-thread-timeout-policy.md)
  (that entry forbids **wall-clock** bounds), but that document's policy text should
  mention it once the decision lands, so "the only things that end a run" stays a closed
  list.

*Check:* `npx vitest run src/harness.plugin.test.ts src/harness.inclusion.test.ts src/plugin/hooks.test.ts src/server/queue.test.ts`, with new cases: each of the four
actions; a `stop` mid-run leaves no orphan assistant message (compare the rollback path
the `maxIterations` guard uses at `:8124-8127`, `scheduler.abandonScope`); a `pause`
decision is followed by `resume` and the conversation continues; a malformed decision is
ignored AND reported while the round's transcript override still applies; a sync handler
returning a decision costs no microtask (`queue.test.ts` unchanged and green).

### T3 — Mutation API: edit, include, read — and never delete

- **T3.1 — `context.edit(entry, patch)`, role-safe.** Accept only what a role can
  legitimately change: text for `system`/`user`/`assistant`; **content only** for a
  `tool` result (its `toolCallId`/`name` are pairing keys — `src/harness.ts:5660-5666`,
  `src/transport/openai.ts:316-321`). Reject structural edits that would change
  `toolCalls` membership, because unit resolution and provider pairing both key on call
  ids (`src/harness.ts:5721-5738`, `:5780-5790`).
- **T3.2 — the two primitives that already exist are the precedent.** `setIncluded` is a
  canonical, validated, notifying write with strict argument checks and an all-or-nothing
  order (resolve → validate → write): `src/harness.ts:7593-7641`, documented contract at
  `src/types/index.ts:3476-3513`. `currentMessages()` is the read-your-writes view
  (`src/harness.ts:7701-7702`, `:7647-7659`). Any `edit` must reuse that shape exactly —
  same validation-before-write rule, same `agent_message` notification, same re-projection
  cache invalidation (`inclusionChanged`/`currentProjection`, `:7441-7450`).
- **T3.3 — no delete.** Requirement R4: history is never deleted; a plugin that wants the
  model to stop seeing a turn disables it (`src/types/index.ts:3410-3418`, and the
  standing rule comment at `:117-134`). A wholesale rewrite stays available through
  `replaceHistory` (`:3527-3531`, `src/harness.ts:7735-7750`), which is refused on a
  branch run for exactly that durability reason (`:7736-7740`).
- **T3.4 — a branch discriminator.** Add `actorKey` and/or `branchId` to
  `HarnessTurnBeforeContext` so a plugin can tell a root round from a branch round without
  guessing from the transcript (F7; `src/harness.ts:7681-7689`, and the shared identity
  block `src/types/index.ts:3397-3408`, which already says `threadId` is absent for a
  branch).
- **T3.5 — controlled persistence/settings access.** Two candidates, both currently
  host-only (F4): `api.snapshot()` (read-only, already safe to call mid-run —
  `src/harness.ts:1117-1120`, contract `src/types/index.ts:2998-3003`) and a **scoped**
  settings write (`api.settings.setOwn(key, value)` bound to the plugin's own namespace and
  validated against its own descriptor, the same rules the server applies at its write
  edge, `src/server/plugins.ts:31-54`). Neither may bypass the host's provider — a
  distribution without a settings store needs a stated "no writer" answer.
- **T3.6 — validation and persistence rules to define explicitly:** which writes are
  canonical (persisted) versus request-only; which notifications they report (reuse
  `agent_message`, `src/harness.ts:7638-7640`); what a branch run does with them
  (ephemeral, no notification — `src/types/index.ts:3500-3502`); and how each survives
  snapshot/restore (the message key allowlists at `src/core/snapshot.ts:238-244`, `:265-267`,
  `:293-295`, `:328-330` refuse unknown keys, so **a new per-message field must be added
  there and in `src/core/branch.ts:457-570` or a flagged transcript stops loading** — the
  same rule Stage 1 followed, `src/types/index.ts:129-133`).

*Check:* `npx vitest run src/harness.inclusion.test.ts src/harness.snapshot.test.ts src/core/branch.test.ts src/harness.fork.test.ts` plus new edit cases:
a legal edit lands on the same request; an illegal patch throws **before** writing
(assert the transcript is byte-identical afterwards, as the `setIncluded` tests do); a
snapshot round-trips the edited text; a fork carries it (`src/harness.fork.test.ts:435-522`
is the model); the branch discriminator distinguishes a root round from a fork round in
one test.

### T4 — Server and worker integration

- **T4.1 — full-transcript sync for in-place changes.** Add a transcript mutation that can
  express a rewrite of the committed prefix, not only an append: either
  `transcript:replace { threadId, messages }` or the `patch + expects` CAS shape already
  used for records (`src/server/workers/lane-commit.ts:185`, precedent) with `expects`
  bound to a digest. Extend the union at `:189`, the authority's apply at
  `src/server/workers/lane-authority.ts:773-775`, and `deriveOperations` at
  `src/server/workers/lane-worker-loop.ts:638-648` so a **flag-only change is detected**
  (today `transcript.length > committedLength` is false for an in-place edit — that is the
  exact condition to fix). Reuse the existing `prefix-moved` → rebase path
  (`src/server/workers/lane-authority.ts:845`, `lane-worker-loop.ts:798`, `:889`) rather
  than inventing a second conflict story.
- **T4.2 — the durability claim must become true, or be restated.** Update
  `src/types/index.ts:3493-3502` when the sync lands; until then the "do not treat the
  flag as restart-durable under `threadExecution: 'worker'`" sentence stays.
- **T4.3 — a server test that drives `turn.before` inclusion end-to-end in worker mode**:
  a lane runs, a plugin disables a unit, the commit boundary pushes the change, and the
  **authority's** transcript (not the replica's) shows `included: false` — then a restart
  restores it. The inline-mode equivalents already exist
  (`src/server/transcript.test.ts:553-569` for the PUT path, `src/harness.snapshot.test.ts:802+`
  for persistence), so this is a new case in the worker suite
  (`src/server/workers/lane-worker.test.ts`, `lane-worker-correctness.test.ts`,
  `lane-authority.test.ts`), not a new oracle.
- **T4.4 — external plugin loading, only if T0 picks Q1(b).** Needs: a settings-borne
  plugin list per harness, resolution rules, an allowlist, and a lane-worker answer
  (a replica built from a preset record cannot receive a closure —
  `src/server/plugins.ts:56-65`, `src/server/harnesses/toolbox.ts:581-587`).
- **T4.5 — fix the stale cross-references listed in F5**, and name both of them so the fix
  is mechanical: in `src/server/harnesses/types.ts:51-52` change `./sessions.ts` →
  `../sessions.ts` (the file that owns `buildHarness`, `src/server/sessions.ts:2021`) and
  `./plugins.ts` → `../plugins.ts` (whose `WORKER MODE` section is
  `src/server/plugins.ts:56-65`); in `src/server/plugins.ts` repoint the three stale type
  ranges — `:21` (`src/types/index.ts:3110` → the provider's "nothing stored" signal at
  `:3341-3350`), `:40` (`:3053-3056` → the descriptor's numeric-hint rule at `:3285-3302`),
  and `:69` (`../types/index.ts:3053-3118` → `:3288-3362`). Do **not** "fix" the
  same-looking sentence at `src/server/api.ts:1923` — it lives in `src/server/`, where
  `./plugins.ts` and `./sessions.ts` resolve correctly.

*Check:* `npx vitest run src/server/workers/lane-worker.test.ts src/server/workers/lane-worker-correctness.test.ts src/server/workers/lane-authority.test.ts src/server/workers/lane-commit.test.ts src/server/transcript.test.ts`, and — because T4 changes the protocol —
`npm run typecheck` plus the package's full suite (T6). The acceptance condition is
specific: **an inclusion change made by a plugin in worker mode survives a server
restart**, which is exactly the sentence `src/types/index.ts:3493-3502` currently says is
not true.

### T5 — Documentation and contract

- **T5.1 — a plugin authoring guide** (`docs/plugins.md`, and index it from
  `docs/tasks/README.md`-style prose or the README layout section — see the review item
  "there is no `docs/` index" in
  [../issues/0007-improvements-review-list.md](../issues/0007-improvements-review-list.md)).
  It must state the ordering/precedence rules that today live only inside
  `src/plugin/hooks.ts:16-50` and `src/harness.ts:7356-7382`, the fail-open rule, the
  sync fast-path rule (an author who writes `async` handlers pays a microtask —
  `src/plugins/context-compaction.plugin.ts:36-44` is the worked example), and what a
  decision does to the run.
- **T5.2 — API reference** for the new surface: decision semantics, wildcard, priority,
  timeout, `edit`, the capability tiers (if T0 chose them), and the two Stage 1 members
  still undocumented at author level (`currentMessages`, lazy `entries`) — see
  [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md)
  T9 for the same task on the Stage 1 side; whoever lands first owns the text.
- **T5.3 — release notes** for additive behaviour (a new handle member `dispose`/`close`,
  new `metadata` fields, new decision actions), following the README's breaking-change
  table convention.
- **T5.4 — the `metadata.hooks` catalogue is UI data**, so any new event or wildcard form
  must reach the Plugins pane honestly: `src/types/index.ts:3317-3320`,
  `src/server/api-events.ts`-served catalogue, `src/frontend/plugins-tab.test.ts:119`
  (its fixture already lists `harness.dispose`, i.e. the UI renders events that never
  fire — T1.6 should note that).
- **T5.5 — [`knowledge.md:3739`](../../knowledge.md#not-built-yet) "Not built yet"** lists
  "compaction — history pruning before
  context limits" (`knowledge.md:3739`, item at `:3744`). Update that list when T1-T4
  land, since the roadmap section is explicitly "keep honest — it is the roadmap"
  ([`knowledge.md:35`](../../knowledge.md)).

*Check:* every new public type has a doc comment in the voice of its neighbours
(`src/types/index.ts:3569-3575` is the tone reference), `npm run typecheck` is green, and
the stale-reference fix is verifiable by command — in `src/server/harnesses/types.ts` the
first grep must be **empty** and the second **non-empty** (the naive form cannot tell them
apart, because `../sessions.ts` contains `./sessions.ts`):

```bash
grep -nE '(^|[^.])\./(sessions|plugins)\.ts' src/server/harnesses/types.ts   # must print nothing
grep -nE '\.\./(sessions|plugins)\.ts' src/server/harnesses/types.ts          # must print both
grep -nE 'index\.ts:3(0[0-9]{2}|1[01][0-9])' src/server/plugins.ts            # must print nothing
```

### T6 — Verification

Run these after the last production edit, and report counts and failing test names — a
focused green run proves only its own files:

1. `npx vitest run src/plugin/hooks.test.ts src/plugin/host.test.ts src/harness.plugin.test.ts src/harness.inclusion.test.ts src/server/queue.test.ts`
   (the seam files, including the fast-path guard, unchanged).
2. The package suite with `npm test` (`package.json:96` = the two manifest checks +
   `vitest run`), then `npm run typecheck` (`:106`) and `npm run test:frontend` (`:97`) —
   the last one because `metadata.hooks` and the live-hook report feed the Plugins pane.
3. `npm run plugins:manifest:check` (`:103`) if a plugin's declared `metadata` changed;
   a stale generated manifest fails the suite by design
   (`scripts/generate-plugin-manifest.mjs`).
4. The pairing oracle: the `wireIssues` assertion style of
   `src/harness.background.test.ts:365` (reused by `src/harness.inclusion.test.ts` and
   `src/harness.action-request.test.ts:79`) must stay empty for every new decision path.

*Check:* one recorded run of each command above, after the final edit, with counts; plus
an explicit statement of which lane (`inline` / `worker`) the worker-mode evidence came
from.

## Why this stage exists

The honest summary of the current system in three sentences, each backed above:

1. **A plugin can only rewrite the request transcript** (F1) — it cannot decide to stop,
   to pause meaningfully, to continue with a marker, or to compose with another plugin's
   rewrite except by "whoever registered last wins" (F2).
2. **Failures are invisible** (F2): the only reporter the bus has is optional and no
   production caller passes it, so a broken policy plugin looks identical to a plugin that
   decided to do nothing.
3. **The server cannot even load the mechanism** (F5), and in worker mode a plugin's
   durable write is lost on restart (F6).

The compaction consumer makes all three concrete. A progressive compactor must:

- run on **every** turn cheaply, which is only possible because of the sync fast path
  (`src/plugin/hooks.ts:41-50`) — so T1/T2 may not add an `await` to it (F8);
- **decide** things a transcript override cannot express: "this turn is done, stop asking"
  (a budget, a stalled loop), and "wait — the compaction summarizer is still running"
  (a real pause), which is T2;
- be **composable** with other policies — a budget plugin and a compaction plugin both
  want the turn boundary (T1.3, T2.2);
- **persist** its decision: a disabled unit is only worth computing if it is still
  disabled after a restart, which is T4 (F6), and which today is documented as NOT true
  (`src/types/index.ts:3493-3502`);
- **fail loudly** when it breaks, because a silent compaction failure means the context
  grows until the provider refuses the request
  ([../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md));
- and be **editable** rather than only droppable once the fleet learns that raw verbatim
  failure traces are what models copy (T3.1, and the external evidence in
  [2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md)).

## Open decisions

Recorded as open; none may be resolved silently inside an implementation PR.

1. **`respond` / synthetic-answer.** A `HarnessTurnDecision` variant that answers the
   model's next request without a provider call (the shape a hard budget or an
   approval-park wants). Deferred from T2.1 because it changes what `done` means and
   interacts with `maxIterations` (`src/harness.ts:8123-8128`) and with the run-record
   content (`src/harness.ts:3106-3113`).
2. **Exact `stop` semantics.** Which run status a plugin `stop` produces — reuse the
   abort path (`throwIfAborted`, `src/harness.ts:8163`) or a distinct
   `plugin-stopped` reason — and whether the assistant message the hook replaced is kept
   in the transcript. Affects what the UI and `threadRead` show.
3. **Same-actor `api.threads.send` from inside a hook.** A `turn.before` handler that
   calls `api.threads.send(threadId, …)` on the thread whose turn is parked re-enters the
   serializer for that actor key (`serializeTurn(run.actorKey, …)`,
   `src/harness.ts:7843`, and the "no overlapping harness execution" property pinned by
   `src/server/queue.test.ts`). Whether that deadlocks or queues behind the parked turn
   is **untested** (see *Not tested*) and must be answered before the guide (T5.1) tells
   authors they may do it.
4. **Capability tiers vs raw access** — T0's Q2, with the recommendation recorded but not
   the decision.
5. **Whether `harness.dispose` needs a handle member at all** — T1.6: the alternative is
   emitting it from server session teardown only, which leaves a library-only consumer
   with no teardown at all.
6. **Wildcard payload typing.** `{ event, payload }` loses per-event narrowing unless it is
   a mapped union keyed by `HarnessLifecycleEvent`; a `payload: unknown` escape hatch would
   put an `any` back at the boundary that the current design deliberately removed
   (`src/types/index.ts:3364-3367`).

## Verify before starting — drift check

A premise that fails is **not** a reason to proceed: mark that finding `corrected` in
place (keep the original text — the rule at `docs/tasks/README.md:24-26`), then re-scope
from the surviving findings.

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'                # written against 44cdbbe, tree dirty
grep -n "export type HarnessHookResult\|HarnessLifecycleResult" src/types/index.ts
grep -rn "onHandlerError" src/             # expect: hooks.ts + hooks.test.ts ONLY
grep -n "createHookBus()" src/harness.ts   # expect: no options argument
grep -n "harness.dispose" src/harness.ts   # expect: no production emit site
grep -n "plugin\b\|hookBus.emit\|hookBus.fire" src/harness.ts | wc -l
grep -rn "plugins" src/server/harnesses/*.ts   # expect: comments + settings pass-through only
grep -n "transcript:append\|transcript:sync\|transcript:replace\|transcript:patch" \
        src/server/workers/lane-commit.ts src/server/workers/lane-authority.ts
grep -n "committedLength" src/server/workers/lane-worker-loop.ts | head
grep -n "does not reach the authority" src/types/index.ts   # F6's contract sentence
npx vitest run src/server/queue.test.ts src/plugin/hooks.test.ts src/harness.inclusion.test.ts
npm run typecheck                          # BASELINE must be green before any edit
```

Stop-and-recheck conditions:

1. **A second event gained a return value** — F1 flips, and T2 becomes a widening rather
   than an addition.
2. **`onHandlerError` is wired in production already** — T1.5 is done; keep the rest.
3. **A transcript replace/patch mutation appeared in `lane-commit.ts`** — T4.1 is partly
   done; verify the *flag-only change* detection, which is the part that is actually
   missing (`lane-worker-loop.ts:641`).
4. **The server gained a plugin list** (grep `plugins:` in `src/server/`) — T0's Q1 is
   answered by someone else; record which commit and re-read the trust statement.
5. **`HarnessTurnBeforeContext` gained `actorKey`/`branchId`** — T3.4 is done, and F7's
   third row is `corrected`.

## Not tested

- **Docs-only entry: no test run was required and none was performed for this file.** The
  baseline claims in *Tasks* (`src/harness.inclusion.test.ts` has 35 `it()` blocks —
  a static count — and the harness suite is green on the current tree) come from the
  Stage 1 work that produced this tree; re-run the drift-check commands before relying on
  them.
- **Whether `api.threads.send` from inside a `turn.before` hook deadlocks the same actor**
  — decision 3 above. Not probed.
- **The cost of an external-plugin model** (module resolution in a bundled/browser build,
  cold-start time, supply-chain review) — T0's Q1(b) is argued from `src/plugin/manifest.ts:1-19`
  and `src/server/plugins.ts:56-65`, not measured.
- **Worker-lane behaviour for a plugin write** — F6 is read from the commit derivation
  (`lane-worker-loop.ts:632-648`) and the contract sentence
  (`src/types/index.ts:3493-3502`). No lane was observed doing it.
- **Whether a timed-out handler can leave a side effect behind** (it may already have
  written `included` before it stalled) — T1.4 semantics need a test, not a paragraph.
- **Interaction between `pause` decisions and a host-driven stop**, and between `stop`
  and an in-flight delegated child. Both are control-flow claims about `src/harness.ts`
  paths this audit did not execute.
- **Frontend behaviour for a new event or decision** — the Plugins pane renders declared
  and live hooks (`src/types/index.ts:3317-3320`, `src/plugin/hooks.ts:149-152`); whether
  an unknown event name breaks a row was not observed
  (`src/frontend/plugins-tab.test.ts:119`).

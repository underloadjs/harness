# Plugin pipeline v2 — decisions, not only transcript rewrites

Status: **T0 DECIDED and T1 + T2 + T3 LANDED (2026-11-09 — the decision text is recorded
in *T0*, the landing notes under each task; T3.4 also lands T8 of the companion
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md),
the branch discriminator being one change with one owner and one landing, and it closes
nothing else there). T4 LANDED except T4.4 (T4.1 + T4.2 + T4.3 + T4.5 closed 2026-11-09,
which also closes T3 of that companion entry — the worker-lane sync had one owner there and
one landing here, exactly as both files asked; T4.4 stays closed by T0's Q1(a) answer. T1.5's
server half — the diagnostic sink the host installs — landed in the same change). T5 CLOSED
2026-11-09 by the documentation pass (T5.1/T5.2 → `docs/plugins.md`, indexed by the new
`docs/README.md` and the README layout tree; T5.3 → the user-facing "what ends a run" lists
in `README.md` and `knowledge.md` now carry the `stop` member — the matching one-line
addition to the "What still bounds a run" comment in `src/core/agent-limits.ts` is CODE-side,
so the docs pass flagged it rather than silently skipping it, and it LANDED 2026-11-09 in the
final-verification pass (that comment now carries the `stop` bullet — corrected in place here
the same day); T5.4 stands with its recorded bound —
`live()` reports a wildcard honestly and the frontend suites are green, but no rendered row
was observed; T5.5 → `knowledge.md`'s "Not built yet" already tells the current truth after
the compaction stage rewrote that item). T6 is answered by the recorded runs (the per-task
check evidence above: the seam-file suites, the worker suites, `npm test` 178 files / 3 130
passed / 2 skipped after the last production edit, `npm run typecheck` clean, `npm run
test:frontend` 138 files / 1 813 passed, and the explicit inline/worker lane statements);
the 2026-11-09 docs pass re-probed one file for currency — `npx vitest run
src/plugin/hooks.test.ts` → 31/31 green — and ran no suite of its own.** The items this
entry leaves open are named rather than buried: the deferred `respond`/`retry` actions
(open decision 1), the plugin-visible mirror diagnostic event (T1.5's recorded edge), the
same-actor `api.threads.send` probe that would replace open decision 3's prohibition with a
finding — the `agent-limits.ts` comment line above is NO LONGER one of them (UPDATE
2026-11-09: it landed in the final-verification pass). Written
from a static audit of the plugin surface,
against revision `44cdbbe` ("Upgraded Task Logic") of the **`@underload/harness`
package repository** (its own git repo at `packages/underload/harness/.git`, not the
workspace root), working tree **dirty with the uncommitted Stage 1 context-inclusion
work** — `git diff --stat -- src` reports 2 206 insertions / 108 deletions across 15
files (`src/harness.ts`, `src/types/index.ts`, `src/core/agent.ts`, `src/core/branch.ts`,
`src/core/snapshot.ts`, `src/harness.inclusion.test.ts` and the persistence tests). Every
`path:line` below was read out of that tree; line numbers will drift, so the identifier
names in this document are the durable anchors and the *drift check* near the end lists
the commands to re-verify them.

**Drift re-check, 2026-11-09 (before T1/T2 started).** The tree moved to `afb38f1` plus
two landed working-tree change sets (the delegate-timeout/scope policy and the
`threadSend` merge), so the line numbers here drifted a second time. Every finding was
re-read through its identifiers and **none needed a `corrected` mark on its substance**.
Of the five stop-and-recheck conditions in the *drift check* section, three were
resolved by checking rather than assumed: **(1)** no second event had gained a return
value, so T2 stayed an addition rather than becoming a widening; **(2)** `onHandlerError`
was STILL unwired in production when T1 began (T1.5 was live work, not already-done work)
and is wired now; **(5)** `HarnessTurnBeforeContext` still has no `actorKey`/`branchId`,
so F7's third row and T3.4 stand. What DID change underneath the text is F3's
`harness.dispose` row and the `harness()` comment it quotes: **CORRECTED IN PLACE by
T1.6** — `harness.dispose()` is a handle member now and it emits the event, so "NO
harness path emits it yet" is a statement about `44cdbbe`, not about the current tree.

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
| `settings` (read + coerce only) | `:3609-3611`, `:3355-3362` | **writing its own settings** — no setter; writes go through the server store (`src/server/plugins.ts:272`, `:517`; route `src/server/api.ts:1997`; contract `src/server/harness.swagger.yaml:847`) — **CORRECTED IN PLACE 2026-11-09 (T3.5):** `api.settings.setOwn(key, value)` exists, namespaced to the owning plugin and validated against its own descriptor with the server's write-edge rules; it writes THROUGH the host provider, so a read-only provider (the shipped server's) is refused with a stated "no writer" answer, and the library's in-memory default persists nothing |
| `threads.*` (list/create/delete/stop/send/steer/messages/replaceMessages/setStatus) | `:3613-3643` | **persistence** — `snapshot()`/`restore()` are harness handle members, not api members (`:3003`, `:3011`) — **PARTLY CORRECTED IN PLACE 2026-11-09 (T3.5):** `api.snapshot()` is now an api member (the same detached document the handle returns, safe mid-run); `restore()` deliberately stayed host-only, because it replaces registries and is refused while a run is live |
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

> **FIXED IN PLACE 2026-11-09 (T4.5).** Both relatives in `src/server/harnesses/types.ts` now
> read `../sessions.ts` / `../plugins.ts`, and the three ranges in `src/server/plugins.ts` were
> repointed at where those contracts actually live in this tree: the descriptor's numeric-hint
> rule at `src/types/index.ts:3434-3438`, the provider's "nothing stored" signal at
> `:3489-3497`, and the descriptor/metadata/provider block at `:3434-3507`.
> `src/server/api.ts:1923` was deliberately NOT "fixed": it lives in `src/server/`, where
> `./plugins.ts` and `./sessions.ts` resolve. The three greps in T5's *Check* are the proof, and
> they now print empty / both / empty.

### F6. Worker lanes publish appended slices only, so an in-place inclusion change never reaches the authority

> **CORRECTED IN PLACE 2026-11-09 (T4.1/T4.2/T4.3, landed).** The rows below are true of
> `44cdbbe` and of every build up to this stage: a lane owed exactly one transcript operation, an
> append, and an in-place write to the committed prefix died with the worker process. What runs
> now is `transcript:patch` — the committed prefix, compare-and-set against the digest the lane
> adopted — applied on the canonical harness through `harness.patchThreadMessages` and reported
> as the same `agent_message` change the server persists, plus a `committedDigest` half of the
> lane's base so a flag or text change is DETECTED at all (the length condition alone never was),
> plus a digest-aware `transcript:sync`/`fromDigest` so the same class of change propagates the
> other way. The rows are kept because the reasoning is the reason the op is whole-prefix and
> CAS-bound rather than sparse. The contract sentence at the bottom of this table — the one this
> finding quoted as "not yet durable" — is replaced by the landing note under T4.

The lane protocol is delta-shaped **by design**, and the design comment says so:

| Fact | Where |
|---|---|
| "Nothing here is a whole-state diff: each op names the prefix, the digest, or the identity it depends on" | `src/server/workers/lane-worker-loop.ts:632-634` |
| The only transcript op a lane owes is an append when the replica is LONGER | `:638-648` — `if (transcript.length > lane.committedLength) ops.push({ kind: 'transcript:append', fromLength, messages: transcript.slice(lane.committedLength) })` |
| `committedLength` is the canonical PREFIX this replica holds | `:134-139`, initialised `:184`, advanced `:775`, `:1084`, `:1089` |
| The mutation union has no replace/patch form for a transcript | `src/server/workers/lane-commit.ts:183-208` — `transcript:append` at `:189`; the patch-with-`expects` shape exists only for records (`record:update`, `:185`) |
| The authority applies append, and answers a pull for the tail | `src/server/workers/lane-authority.ts:773-775` (`appendThreadMessages(threadId, messages, fromLength)`), `:129` + `:705` (`transcript:sync` with `haveLength`), conflict code `prefix-moved` at `:845` |
| Turn start PULLS the canonical delta but never PUSHES an in-place edit | `src/server/workers/lane-worker-loop.ts:1092-1096` (`runExclusive(() => syncTranscript())`), `syncTranscript` at `:817-855` |
| The contract already documents this as a known, not-yet-durable case | `src/types/index.ts:3493-3502` — "a lane whose authority holds the transcript receives only APPENDED SLICES … so an in-place flag change on an ALREADY-COMMITTED message does not reach the authority until a full-transcript sync exists — planned for the server-integration stage, NOT in place now" — **NOW REPLACED (T4.2, 2026-11-09)**: the paragraph states the write is restart-durable in both lanes, names the mechanism, and states what a refused patch costs |

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
| A branch round has no first-class discriminator: `threadId` is the SPAWNING conversation for a branch, `run.actorKey` (`branch:<id>`) is only a fallback | `src/types/index.ts:3447`, `:3397-3408`; the comment spelling this out is `src/harness.ts:7681-7689` ("a plugin therefore cannot tell a branch round from a root round by `threadId`") — **CORRECTED IN PLACE 2026-11-09 (T3.4 / context T8):** `HarnessTurnBeforeContext` now carries `actorKey` (every round) and `branchId` (a branch only), and that implementation comment says so; `threadId` still means the spawning conversation, and a test pins that equality |
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

**DECIDED 2026-11-09 — owner: the implementing stage (G3), on the recommendation above;
reversible by the owner exactly as this section says.**

- **Q1 = (a).** Plugin code is **built-ins plus host-provided only** for this stage. The
  server gains no new input surface, no module resolution and no supply-chain story, and
  the worker-replica problem disappears (a lane rebuilds from the same preset record).
  The sentence that is now true and stays true: *a plugin is code the application
  shipped.* An operator still cannot add a plugin without shipping a build — that cost
  was accepted knowingly, and `configuration.plugins` remains the programmatic path.
- **Q2 = (a) recorded as the DESIGN TARGET, not implemented this stage.** The tiers
  (observe / context / conversation-control / host) are the shape the api moves toward,
  and `HarnessTurnDecision` was designed with them in mind (`stop` is a larger grant
  than `replace`, which is why the decision consumer sits in the harness rather than in
  a plugin's own api).
- **Why `metadata` (`HarnessPluginMetadata`) did NOT gain the capability field — the
  sentence this task's *Check* asks for.** Under Q1(a) every plugin is trusted shipped
  code, so a declared tier would be **nominal**: nothing in the loader could act on it
  differently, every plugin already holds the full `api`, and the UI would render a
  permission row that enforces nothing (a permission label the operator reads as a
  guarantee while it is decoration). Tiers only become load-bearing if **Q1(b)** ever
  lands, because the thing a tier gates is *foreign* code. Adding the field now would
  also be a published, migration-note-worthy shape decided before the model it labels
  exists. So: no field, and the reason lives here — if Q1(b) is ever chosen, that stage
  adds `metadata.capability` and the migration note together, and open decision 4 stays
  the place the shape is argued.

*Check:* this section names one answer per question, plus the owner and the date, and the
`metadata` type (`src/types/index.ts:3308-3325`) either gains the capability field or
records why it does not. No T1-T4 code lands before that sentence exists.

**Check satisfied 2026-11-09, and T1/T2 landed after it:** one answer per question,
owner and date above, and the `metadata` type is unchanged with the reason recorded in
the bullet before this one. (`metadata.hooks` did NOT change either — T1 added events to
the catalogue, not to what a plugin declares about itself, so
`npm run plugins:manifest:check` stayed green without a regeneration.)

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

**LANDED 2026-11-09 — T1.1 … T1.7, one line each for what a reader (or the next task)
needs to know, with the identifier that carries it.**

- **T1.1 — wildcard `'*'`.** `api.on('*')` and `hooks.on('*')` are a SEPARATE OVERLOAD
  (`HarnessHookSubscribe<Options>` in `src/types/index.ts`, reused by both the handle's
  plugin api and `HarnessHookBus.on`), so a named subscription keeps its exact per-event
  payload typing. The envelope is `HarnessWildcardEventContext` — a mapped union over
  `HarnessLifecyclePayloads`, which is what resolves open decision 6 below: `event` and
  `payload` narrow together and no `any` reached the boundary. Load-time only: a wildcard
  registered mid-emit is picked up by the NEXT round, exactly like a named one, because
  dispatch still walks a snapshot (rule 3). Identity fields are deliberately NOT copied
  onto the envelope — every payload that has a thread or an agent already carries them
  (`HarnessRunLifecycleContext`, `HarnessThreadRecord`), so a second copy could disagree
  with the payload it names.
- **T1.2 — `live()`.** Expanded into the events it will ACTUALLY deliver, keyed by
  `HarnessLifecycleEvent` (no invented `'*'` pseudo-event, no widened return type). The
  deliverable set is `WILDCARD_DELIVERABLE` in `src/plugin/hooks.ts`, a `Record` over the
  WHOLE union — so adding an event breaks `tsc` until its author decides whether an audit
  plugin receives it. That is the F3 complaint ("learns nothing about events added
  later") closed structurally rather than by discipline.
- **T1.3 — `priority`.** `HarnessHookOptions.priority`, default 0, higher first, ties by
  registration order via a per-bus monotonic `seq`. Priority reorders WITHIN one event
  only (the comment on the type says so); it can never move a `tool.before` handler in
  front of the `turn.before` that precedes it.
- **T1.4 — `timeoutMs`.** Fail-OPEN: the timed-out handler is dropped AND reported
  (`kind: 'timed-out'` on `HarnessHookErrorContext`), the round continues with the
  handlers that survived, and the late result is ignored whenever it arrives. The timer
  is armed ONLY at the moment a handler returns a thenable (`runBounded`/`withBudget`),
  so the sync fast path never allocates one — the pinned case is a synchronous handler
  carrying a budget that produces no diagnostic after the budget elapses. A budget bounds
  the WAIT, not the damage: a handler that already wrote `included` before stalling keeps
  its write, which is the behaviour the *Not tested* section asked for as a test rather
  than a paragraph (`arms no timer for a synchronous handler that carries a budget`,
  `drops a handler that never resolves at its budget…`).
- **T1.5 — the production reporter.** `createHookBus({ onHandlerError:
  notifyPluginDiagnostic })` in `src/harness.ts`. The channel is a new additive
  `configuration.report.diagnostic` member (`HarnessDiagnosticEvent`: `type`, `kind`,
  `event`, `owner`, `message`), chosen over `report.stateChange` because a broken plugin
  is not a persistence transition and must not schedule a save. It is synchronous,
  advisory, and its own throw is swallowed — the same rules as the state-change observer,
  so "visible without ever failing a run" (rule 2) holds in both directions. `kind` is
  `handler-threw` | `handler-timed-out` | `invalid-decision`; the bus's context keeps
  `kind` OPTIONAL (absent = a plain throw), which is why every pre-existing assertion in
  `src/plugin/hooks.test.ts` stayed green unchanged. **One half of the entry's parenthetical
  is deliberately NOT done**: T1.6's "a plugin must be able to see it too" would need a
  plugin-visible mirror event (`host.plugin_error`-style), and this stage adds exactly one
  new catalogue event (`host.state_change`, T1.7), so a plugin cannot yet audit *another*
  plugin's failures — only the host can. Recorded here as the open edge rather than
  silently left out; adding it also needs the re-entrancy rule the doc did not specify
  (a failure reporter that itself emits into the bus can recurse), so it belongs with the
  stage that decides the catalogue shape, not as an accident of this one.
- **T1.5 UPDATE, 2026-11-09 (landed with T4): the host now has a receiver as well as a
   reporter.** The bullet above describes the LIBRARY channel; what was still missing was a
   server-side sink, and `src/server/persistence.test.ts` recorded that gap in a comment while
   its fixtures supplied their own. It is closed: `HarnessPresetReport` gained `diagnostic`, the
   shared toolbox factory and the scripted `demo` factory forward it, and
   `SessionStore.buildHarness` installs one whose `notePluginDiagnostic` journals the event on
   the session (bounded at `PLUGIN_DIAGNOSTIC_LIMIT`, durable through
   `HarnessSessionRecord.pluginDiagnostics`, projected onto the snapshot and onto
   `GET /sessions/{id}` as `plugin_diagnostics`, with the failure kinds also printed on stderr).
   Pinned by `a hook that throws still answers, and names itself, its owner and its event on the
   session`, `journals the failure on the durable plane and reports it again after a restart`,
   and `keeps a plugin’s own policy report on the session and off the server log` in
   `src/server/plugins-api.test.ts`. The plugin-visible MIRROR event stays open exactly as that
   bullet states. A lane replica installs no sink either — `sayHello` passes
   `diagnostic: () => undefined`, with the missing frame named in the line's own comment — which
   is F5's boundary (a report fired inside a hook has no closure to travel on), not this
   channel's, and the same limit `src/server/plugins.ts` "WORKER MODE" already documents for
   `pluginSettings`.
- **T1.6 — `harness.dispose`.** Resolved as **BOTH**: a `dispose()` handle member (beside
  `snapshot`/`restore`) AND the server binding (`SessionStore.disposeSession` calls it),
  which is the answer to open decision 5 below. It fires exactly once (`disposeEmitted`
  latch), is idempotent, and clears the bus right after the emit so a handler that
  re-subscribes during teardown dies with the harness. `dispose()` is NOT an abort; if a
  run is live it PARKS the event and the last run to settle emits it, from the END of
  `runAgent`'s finally — after `run.finished`/`run.failed` and after `thread.idle`, so
  the teardown event is never raced against a run (F8's last row) and never lands in
  front of a thread's terminal hook. It is also not snapshot state: a restored harness
  has a fresh bus by construction (the type comment records that asymmetry). **Verification
  gap, stated rather than papered over:** the handle member and its ordering are pinned by
  two tests, but the SERVER binding is only exercised indirectly — no session test asserts
  that `harness.dispose` fired, because the server builds harnesses from presets and cannot
  pass `configuration.plugins` (finding F5), so there is no way today to put an observing
  plugin inside a session harness. The binding is covered by the whole suite staying green
  (every server test that calls `store.dispose()` now also disposes its harnesses) and by
  the optional-call guard that a harness view without a `dispose` still tears down cleanly.
  Making it directly observable is F5's problem, i.e. T4's territory.
- **T1.7 — `host.state_change`.** New declared event, payload = the existing
  `HarnessStateChangeEvent` verbatim (one vocabulary for host and plugin), fired from
  `notifyStateChange` with `fire` (sync, and this plane sits inside commit points). It is
  **never** part of the `'*'` fan-out — `WILDCARD_DELIVERABLE['host.state_change']` is
  the one `false`, and `has()`/`live()` follow the same rule, so a `'*'` subscriber that
  wants it opts in BY NAME and cannot be double-delivered. No hidden re-entrancy guard: a
  handler that writes transcript state re-enters this notify, and that is documented as
  the author's contract, mirroring the host observer's exposure.

**Check evidence (2026-11-09).** The focused list above ran green:
`npx vitest run src/plugin/hooks.test.ts src/plugin/host.test.ts src/plugin/settings.test.ts
src/harness.plugin.test.ts src/plugin/async-ping.test.ts src/plugin/context-compaction.test.ts`
→ **6 files, 120 tests, all passed** (96 of them pre-existing, 24 new). `npx vitest run
src/server/queue.test.ts` → **15 passed with the file untouched** (`git status` shows no
modification), which is F8's proof. Every enumerated new assertion exists by name:
`delivers every emitted event to a wildcard exactly once, with the right payload`,
`runs a priority-1 handler before a priority-0 handler registered earlier, stably within
a priority`, `drops a handler that never resolves at its budget, reports it, and keeps the
round`, `reports a throwing hook to the host without failing the run`,
`fires exactly once on dispose, clears the bus, and survives a second call`, and
`a dispose() that lands mid-run waits for the last run, after its terminal hooks`.

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

**LANDED 2026-11-09 — T2.1 … T2.5.**

- **T2.1 — the type.** `HarnessTurnDecision` sits beside `HarnessHookResult` in
  `src/types/index.ts` with the four closed actions; `respond`/`retry` stay deferred
  (open decision 1). The `{ transcript }` sugar keeps working and is now documented as an
  alias of `replace` rather than a different mechanism, because the reducer normalizes one
  into the other (below) — a shipped contract pinned by
  `src/harness.plugin.test.ts` and `src/harness.inclusion.test.ts`, both green unchanged.
- **T2.2 — one reducer.** `contributionOf` + `parseDecision` + `mergeContribution` in
  `src/plugin/hooks.ts`, used by BOTH the sync prefix of `emitMaybeSync` and the async
  tail (`finishRound`) — one round, one merged `{ transcript?, decision? }`, mutated in
  place so the two branches cannot return different answers for the same round. The
  doc's precedence list is implemented literally: (1) an explicit replace — a returned
  decision wins over an earlier `setTranscript`, last wins across handlers; (2) otherwise
  `requestOf`'s re-projection branch, untouched, including the "no write happened, so the
  caller's own array identity is returned" property; (3) `pause`/`stop` compose with the
  transcript rather than replacing it; (4) ties by `priority` then registration order
  (T1.3), and a later `continue` clears an earlier `stop` — that is what "last wins per
  channel" means and the reducer test pins it in both directions; (5) an unparseable
  decision is ignored AND reported (`kind: 'invalid-decision'`), never thrown, and the
  same handler's valid `transcript` override still applies. `reason` is kept only when it
  is a string, so a non-string reason can never reach the UI as `[object Object]`.
- **T2.3 — the consumer.** `emitTurnBefore` returns
  `HarnessMaybeAsync<{ transcript; decision? }>` — the `decision` key is ABSENT unless a
  plugin returned one, so a decision-free turn reads a single `undefined`. `requestTurn`
  consumes it right after the transcript resolves, via `applyTurnDecision`:
  `continue`/`replace` change nothing; `pause` parks through the same `pauseThreadState`
  that `context.pause()` uses and **the turn still goes out** (a roster signal, not a
  control-flow break — the pinned evidence is that both provider requests are sent and
  `thread.paused`/`thread.resumed` fire in that order); `stop` takes the run's own abort
  path — for a conversation run, `stopThreadState`, the ONE path every stop already
  travels (record → `stopped`, epoch bump, queue discard, task-claim release, one
  `thread.stopped`), with the plugin's `reason` as the abort reason; then
  `throwIfAborted` throws it, so the run unwinds through `runAgentCore`'s existing catch:
  the transcript rolls back to where the run started (the same splice the `maxIterations`
  guard uses, hence **no orphan assistant message**), the invocation records `cancelled`,
  `run.failed` carries the reason and `run.finished` does not fire, and the caller
  rejects with the plugin's error. A branch run has no conversation to stop and must not
  abort its PARENT's signal, so it sets the new `run.pluginStopped` marker (the only new
  `RunState` field; `runAgentCore`'s catch consults it so a branch stop also records
  `cancelled` rather than `failed`) and throws the reason directly.
- **T2.4 — hot path.** The `sync` branch still has no `await`: the decision is read by
  destructuring the same ternary that already existed, and `applyTurnDecision` is behind
  `if (decision !== undefined)`. Evidence: `src/server/queue.test.ts` green **unchanged**,
  plus the new `a synchronous decision costs no microtask: the frames match a hook-less
  run`, which asserts the frame list against the SAME literal the pre-existing hook-less
  baseline pins (`start, tool_call, attempt_commit, tool_result, text, done`) and the same
  two provider requests.
- **T2.5 — the timeout policy.** Amended in
  [2026-11-09-thread-timeout-policy.md](./2026-11-09-thread-timeout-policy.md) under F6:
  a `stop` decision joins the closed list of things that end a run, and the paragraph
  says why it does not touch R1/R2 (it is a policy assertion at a boundary the run is
  already parked at, not a timer — nothing expires). `README.md`, `knowledge.md` and the
  `src/core/agent-limits.ts` comment carry the same list and pick the new member up when
  T5.3 (release notes) lands; that is deliberately not done here so one stage owns the
  wording of the user-facing lists.

**Check evidence (2026-11-09).** `npx vitest run src/harness.plugin.test.ts
src/harness.inclusion.test.ts src/plugin/hooks.test.ts src/server/queue.test.ts` →
**4 files, 114 tests, all passed**, with `src/server/queue.test.ts` and
`src/harness.inclusion.test.ts` byte-unchanged (`git status`). The new case names:
`a continue decision sends the projected transcript and changes nothing`,
`a replace decision sends what it says, and only for this request`,
`a pause decision parks the conversation, still sends the turn, and resume continues it`,
`a stop decision mid-run ends the run with the plugin reason and leaves no orphan
assistant message`, `a malformed decision is ignored AND reported while the round's
transcript override still applies`, `a synchronous decision costs no microtask…`, and on
the bus side `merges one round into { transcript, decision }: last wins per channel,
replace normalizes into the transcript`.

**Whole-package verification after T1+T2 (2026-11-09) — recorded here because T6 asks for
it, and scoped honestly.** `npm run typecheck` (which runs both manifest checks and
`tsc --noEmit`) is clean, and `npm run plugins:manifest:check` reports
`plugin-manifest.ts is current (2 plugins)` — no plugin's declared `metadata` changed, so
no regeneration was needed. `npm test` (the two manifest checks + `vitest run`) →
**176 files, 3018 passed | 2 skipped, 0 failed**, which includes the delegate-timeout and
`threadSend` change sets' own tests (`src/harness.delegation.test.ts`,
`src/harness.thread-runtime.test.ts`, `src/harness.fork.test.ts`,
`src/core/discovery.test.ts`, `src/core/metadata.ownership.test.ts`,
`src/tools/runtime/threadRead.test.ts`, and the three worker-lane suites under
`src/server/workers/`) and every F8
regression: `src/server/queue.test.ts` (the microtask guard, unchanged), the `wireIssues`
pairing oracle of `src/harness.background.test.ts` (unchanged, green) and
`src/harness.inclusion.test.ts` (unchanged, green). What this stage did NOT run, and
therefore does not claim: `npm run test:frontend` (a new catalogue event reaching the
Plugins pane is verified at the type level only — T5.4 / T6.2), `npm run test:package:tools`,
and the worker lane (T4) — so the evidence above is the **inline lane only**. That oracle
also has not been pointed at a DECISION path yet: the files that reuse it return
transcripts, not decisions, so "provider pairing stays clean under a `stop`" currently
rests on the rollback being the run's existing one rather than on that assertion — T6's
item 4 is still open on that point.

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

**LANDED 2026-11-09 — T3.1 … T3.6, and T8 of the companion context-inclusion entry by the
same change. One line each for what a reader (or the next task) needs, with the identifier
that carries it.**

- **T3.1 — `context.edit(entry, patch)`.** `HarnessContextEditPatch` (`src/types/index.ts`)
  is the closed text patch — `content` for every role, `reasoning` for an assistant only —
  and the role rules are DATA at module scope in `src/harness.ts`
  (`EDITABLE_FIELDS`, `editableFieldsOf`, `editRefusalOf`) so every refusal names what the
  caller MAY do and WHY the key it named is not text. A `tool` result may change its
  `content` and nothing else: `toolCallId`/`name` are the pairing keys
  (`src/transport/openai.ts` `wireMessage`), and a patch naming `toolCalls`, `role`,
  `attachments`, `toolCallId`, `name` or `included` is refused — the last one pointing at
  `setIncluded`, because inclusion is the other axis and cascades to a whole unit while an
  edit never does. Addressed by ENTRY, not by index: F7's finding is that a numeric index
  is re-read against the CURRENT transcript, which is a tolerable risk for a flag and a
  bad one for rewriting text.
- **T3.2 — the same primitive, not a new one.** `edit` reuses `setIncluded`'s shipped
  shape step for step: the entry guards moved into one shared read-only resolver
  (`indexOfIssuedEntry` — shape → issued-this-round `WeakSet` → identity `indexOf`, the
  stale case naming the `replaceHistory()` cure), the value-display helper is shared
  (`shownValue`), the write is IN PLACE on the harness-owned canonical object, the same
  projection cache is dirtied (`inclusionChanged` → `currentProjection`) so THE SAME
  REQUEST carries the new text, and exactly one `agent_message` state change is reported.
  Order is resolve → validate every field → write, so a refusal writes nothing; the new
  test asserts that as BYTES (`canonicalBytes`, before and after fifteen refusals), which
  is stricter than the `setIncluded` tests' "no `included` key appeared" check.
- **T3.3 — no delete, and no second rewrite path.** Nothing in T3 removes an entry: R4
  holds, a plugin that wants the model to stop seeing a turn disables it, and a wholesale
  rewrite stays `replaceHistory` (still refused on a branch run — an edit is allowed there
  precisely because it is ephemeral and request-shaping).
- **T3.4 — the branch discriminator (also closes context T8).** `HarnessTurnBeforeContext`
  gains `actorKey` (the run's scheduling identity — display name, `thread:<id>`, or
  `branch:<id>`; ALWAYS different between a root round and a branch round) and `branchId`
  (present only when `run.branch` exists, and the same `branch-<n>` the state-change plane
  already reports — exposure, not invention). `threadId` keeps its shipped meaning, the
  SPAWNING conversation, and the test asserts the two rounds' equality on it while they
  differ on `actorKey`. `branchId` is spread in as an ABSENT key rather than an
  `undefined`-valued one, so an ordinary round's payload carries nothing extra.
- **T3.5 — `api.snapshot()` and `api.settings.setOwn()`.** `pluginApiBase` gains
  `snapshot: () => snapshot()` — the handle's own document, detached, safe mid-run, and
  honest about "read-only in effect" (mutating the copy changes nothing; a read reports no
  state change, which is what makes it safe once per turn). There is deliberately no
  `api.restore`: a restore replaces registries and is refused while any run is live, which
  is a host decision. `setOwn` lives in `createPluginSettingsView`
  (`src/plugin/settings.ts`), so it is namespaced by the plugin that owns the view and has
  no cross-namespace spelling; it enforces the DECLARED key set, the declared type, and
  `min`/`max` — normalizing to the declared type — and does NOT enforce `step`, which is
  the server's PATCH-edge rule restated in the plugin layer (`src/server/plugins.ts` keeps
  its own copy because `src/plugin/*` must not import `src/server/*`, and the error
  wording is shared on purpose so one bad value reads identically from either edge).
  **The "no writer" answer, stated in the type:** a write always goes THROUGH the host's
  provider (`HarnessPluginSettingsProvider.set?`, newly optional). The library's default
  in-memory provider accepts writes for the lifetime of the PROCESS and persists nothing —
  an edit is not in `snapshot()` and does not survive a restart; a host whose provider
  implements `get` alone (the shipped server's live provider, read-only by construction so
  its store stays the one that validates, bumps the revision and schedules the save) has no
  writer, and `setOwn` says so rather than keeping a copy nobody reads. Wiring a host
  store's write path is host work, not a library fallback.
- **T3.6 — persistence, written down where the writer is.** Canonical and reported: an edit
  survives later turns, `snapshot()`/`restore()`, a store writing on that notification, and
  a fork/branch materialization that copies the text (all three pinned by tests). Ephemeral
  and silent: a branch run edits its own copy and reports nothing. Request-only: nothing
  about `edit` is request-scoped — that stays `setTranscript`/a returned transcript.
  **The whitelist question resolves to "no new field":** `edit` writes only `content`
  (every role) and `reasoning` (assistant), and both are already in the per-role key lists
  (`src/core/snapshot.ts`, `src/core/branch.ts`), so neither file changed and an edited
  transcript loads exactly as before; a test pins the KEY ORDER of an edited message
  (`Object.keys`) so a future rebuild-instead-of-assign implementation cannot drift silently.
  The worker-lane limit F6 describes is a property of an IN-PLACE write, so it applies to
  an edit exactly as it does to a flag; the `edit` contract says so rather than leaving the
  reader to generalise from `setIncluded`.

**Check evidence (2026-11-09).** Baseline BEFORE the edit, `npx vitest run
src/harness.inclusion.test.ts src/harness.snapshot.test.ts src/core/branch.test.ts
src/harness.fork.test.ts` → **4 files, 106 passed** (inclusion 35, snapshot 34, branch 23,
fork 14). After: **4 files, 114 passed**, the eight new cases being
`edits one user entry in place, and the SAME request carries the new text`,
`edits a tool result content while its pairing keys stay exactly as they were`,
`edits an assistant turn's text and reasoning, and refuses reasoning on every other role`,
`refuses every patch that is not text, before writing a single byte`,
`refuses an entry made stale by replaceHistory, exactly like setIncluded does`,
`names a fork round differently from a root round while threadId stays equal, and a branch
edit reports no notification`, `persists the edited text through JSON and serves it after a
restart`, and `carries an edited entry into the branch transcript and the branch request`.
T3.5 is pinned in the seam files instead: `src/plugin/settings.test.ts` 9 → **13**
(the declared-key, type, `min`/`max`, no-`step`, no-writer and namespace rules, each with
its exact refusal text) and `src/harness.plugin.test.ts` 33 → **37** (a mid-run
`api.snapshot()` through a real hook, its read-only effect, its zero notifications, and
`setOwn` reaching the host provider on the very next read). `src/core/branch.test.ts`
(23) passed UNCHANGED — the copy path already carried `content`, which is the T3.6 claim.
`src/server/queue.test.ts` stayed green and untouched.

**NOT done by this landing, and not claimed.** (1) **The worker lane.** An edit is an
in-place change, so F6/T4 is now the durability story of TWO mutation kinds; T4 owns it and
the contract sentences say so. (2) **The compaction cooldown pollution**
(`src/plugins/context-compaction.plugin.ts` keys its map on `context.threadId`, so a branch
round writes a `branch:<id>` entry into it). `actorKey`/`branchId` are what make that fixable,
but changing the shipped plugin's cooldown key is a BEHAVIOUR change and belongs to the
compaction stage, not here. (3) **Frontend** — no `metadata` changed, so
`npm run plugins:manifest:check` stayed green with no regeneration and no rendered row was
observed (T5.4/T6.2 own that).

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

**LANDED 2026-11-09 — T4.1, T4.2, T4.3 and T4.5 (T4.4 stays closed by T0's Q1(a)). One
line each for what a reader (or the next task) needs, with the identifier that carries it.**

- **T4.1 — the protocol decision, ratified.** The doc offered `transcript:patch { threadId,
  expects, … }` or `transcript:replace { threadId, messages, expects }`, both bound to a digest
  of the committed prefix, and preferred reusing the existing `prefix-moved` → rebase path over
  inventing a second conflict story. **Chosen: `transcript:patch`** (`SharedMutation` in
  `src/server/workers/lane-commit.ts`), whose payload IS the whole committed prefix
  (`expectedLength` entries + `expects` = `digestMemoryValue` of that prefix as this lane last
  ADOPTED it). It is the records precedent (`record:update`'s `patch + expects`) applied to the
  transcript, and it refuses with `prefix-moved` carrying the same canonical facts an append
  refusal carries, so `adoptReceipts` → `needsRebase` → `syncTranscript` is the ONE recovery
  path for both. Why whole-prefix rather than a sparse entry list: the CAS is whole-prefix, so
  a per-entry `expects` could not be trusted anyway (a digest cannot say which entries it
  disagreed about); whole-prefix makes the fold's apply one atomic `splice`; the cost is inside
  the envelope the lane already pays (a full `replica.snapshot()` per boundary, a full
  `harness.snapshot()` per group); and it converges, because the lane adopts the authority's
  reported digest and stops re-sending. `transcript:sync` was rejected as the name for the push:
  that identifier is already the REQUEST a lane raises to PULL, and one name per direction is
  what keeps a reader able to tell who overwrites whom.
- **T4.1 — the flag-only detection, which is the part that was actually missing.**
  `LaneWorkerState` gained `committedDigest` beside `committedLength`: the length says how much
  canonical state a replica holds, the digest says what it HELD when it adopted it, and the diff
  between that and the replica's current prefix is the only way to see an in-place write
  (`setIncluded` storing/removing `included`, `edit` changing `content`/`reasoning`) — the
  append condition `transcript.length > committedLength` is blind to it by construction. The
  digest is recomputed LOCALLY at every point the base moves (`adoptCommittedBase`: a first turn
  for a target, an adopted receipt, a transcript sync), which is why it can never disagree with
  the content the next derivation reads. `deriveOperations` now emits the patch BEFORE the
  append in the same group — the fold applies ops in order and a patch never changes a length,
  so one boundary carries a compactor's prune AND the turn it just answered.
- **T4.1 — the authority apply and the core seam.** `lane-authority.ts` replays the op through a
  NEW targeted lane seam, `harness.patchThreadMessages(threadId, messages, expectedLength)`
  (`src/harness.ts`, declared in `src/types/index.ts` beside `appendThreadMessages`), the
  fourth member of that family: no `setThreadMessages` live-run guard (a lane's run lives on
  another thread), validation through `readHarnessMessages` with `surrounding` (so an entry
  with no address is minted one above everything the conversation owns), an IN-PLACE `splice`
  (the array `agent.messages` is exposed by reference), and one `agent_message` notification —
  the only durability mechanism a flag or an edit has. The seam refuses a patch that would move
  a committed position's `role` (provider pairing and the exclusion unit resolve on it) or its
  `messageId` (that is how `setIncluded` and the UI point at the turn from another round); a
  caller that names no address keeps the one already at that position, because an address
  belongs to the turn and not to the write. The CAS itself stays SERVER-side (the authority owns
  `digestMemoryValue`; the core has no serializer for it and gains none just to police a worker
  protocol), and it is repeated against the LIVE transcript in `replay` for the same reason the
  append re-checks `fromLength` — the live object gets the final word. A live refusal that is
  structural rather than a moved base is now reported with its own code (`replay` returns
  `code`, so a bad payload is `invalid-mutation` and not a false "canonical moved, re-read").
- **T4.1 — the sync expresses in-place changes in BOTH directions.** The pull gained
  `haveDigest` on the `transcript:sync` request (the authority answers `rebased` with the whole
  canonical transcript when the bytes at the lane's own length differ), the turn frame gained
  `fromDigest` (`authority.canonicalHeadOf` returns length AND digest from ONE canonical read;
  it is not cheaper than the retired length-only call — `canonicalState` materialized that
  prefix either way — it costs one extra digest pass over bytes the fold already produced, and
  that is the honest price of seeing a content change), and `syncTranscript`'s early return now
  means "same length AND same content". Without
  those, an operator's transcript edit or a sibling lane's committed patch would leave a live
  replica asking the provider with text the authority no longer holds. `LaneCommand.turn`'s
  `fromDigest` and the patch op are both OPTIONAL in wire terms: an older worker never sends a
  patch and a newer worker never compares a digest it did not receive. `LANE_PROTOCOL_VERSION`
  stayed at 3 deliberately — the mutation union, the request field and the frame field are
  additive, and the mismatch a version bump exists to catch (a stale `dist/` bundle) already
  fails LOUDLY here: a pre-T4 coordinator answers an unexpected `transcript:patch` with the
  fold's named `invalid-mutation` refusal, which the lane records as a commit fault instead of
  mis-parsing a frame.
- **T4.2 — the durability sentence was REPLACED, not restated.** `src/types/index.ts`
  `setIncluded`'s *PERSISTENCE — PRECISE SCOPE* paragraph now says the write is restart-durable
  in BOTH lanes and names the mechanism (`transcript:patch` → `patchThreadMessages` → the
  `agent_message` report the server persists), and it states the conflict cost instead of
  hiding it: when canonical rewrote the prefix first, the patch is refused WHOLE, the lane
  re-reads, and that round's write is dropped — the policy re-derives it on the next
  `turn.before`, because a whole-prefix digest cannot name which entries it disagreed about.
  `edit`'s *THE SAME WORKER-LANE LIMIT* paragraph became the shared rule. This closes T3 of
  [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md),
  whose acceptance artifact those two sentences are.
- **T4.3 — the server test that drives it.** Extended in the worker suite, no new oracle:
  `lane-commit.test.ts` gained the fold rules (applied / stale digest / canonical got shorter /
  malformed payload / writer lease / patch-then-append in one group / a conflicting patch
  rolling the whole group back through `rolledBackReceipts`); `lane-authority.test.ts` gained the
  live applier against a REAL harness (the authority's own `threadMessages` showing
  `included: false` plus the edited text, exactly ONE `agent_message` report, and a
  snapshot→restore round trip), the structural refusals, the sibling-append-does-not-conflict
  case, and the digest-aware `transcript:sync` rebase; `lane-worker.test.ts` gained the
  derivation itself (`deriveOperations`, exported with its structural `ReplicaReadView` for
  exactly this: nothing owed when the replica matches its base, a patch for a flag-only change,
  a patch for a text edit, patch-before-append when the turn also grew, an unpublished tail
  edit riding the append instead, and the adoption rule that terminates the re-send) plus the
  durable end-to-end on a REAL session: a real lane turn, then a `transcript:patch` committed by
  that session's own authority on the LIVE lane's epoch under the writer lease that lane holds,
  read back through the store's transcript, found in `state.json`, and read again by a SECOND
  store over the same root.
- **T4.3 — what the worker-mode evidence is, stated per T6's rule: it came from the WORKER
  lane** (`threadExecution: 'worker'`, real `node:worker_threads`, the scripted `demo` preset).
  One honest limit, and it is F5's rather than T4's: the op that lands in the durable test is
  SUBMITTED on the lane's behalf by the test, because no `turn.before` plugin can run inside a
  replica today — the replica is rebuilt by `presetFromRecord` from a preset RECORD, a factory
  closure cannot cross `worker_threads`, and the built-ins that DO get there (the shipped
  compactor) need its declared `contextLimit` (100 000 tokens) before they write anything. So
  the derivation, the receipt adoption, the frame path and the authority apply are each pinned at
  their own boundary, and what is pinned end-to-end is the durability claim itself. Closing the
  last step is T4.4 (plugin loading on a lane), which T0's Q1(a) left open on purpose; the same
  asymmetry now applies to T1.5's diagnostics (below), where the worker states it in code.
- **T4.5 — the stale cross-references are fixed and verifiable by command.** In
  `src/server/harnesses/types.ts` the two relatives became `../sessions.ts` and
  `../plugins.ts`; in `src/server/plugins.ts` the three type ranges now point at
  `src/types/index.ts:3434-3438` (the descriptor's numeric-hint rule), `:3489-3497` (the
  provider's "nothing stored" signal) and `:3434-3507` (the descriptor, metadata and provider
  contracts). `src/server/api.ts:1923` was NOT touched: it lives in `src/server/`, where
  `./plugins.ts` and `./sessions.ts` resolve correctly. The *Check* command from T5 prints
  empty / both / empty as required (the first pattern needs its `[^.]` guard, because
  `../sessions.ts` contains `./sessions.ts`).
- **T1.5's remaining half — the sink the server installs.** The library channel existed and was
  wired; the host had no receiver, so a broken plugin was still invisible on a durable session.
  `HarnessPresetReport` gained the optional `diagnostic` member (the same additive
  third-argument discipline as `stateChange`/`interaction`/`pluginSettings`), `createToolboxHarness`
  forwards it, the scripted `demo` factory forwards it, and `SessionStore.buildHarness` installs
  one. `notePluginDiagnostic` journals the event on the session (bounded at
  `PLUGIN_DIAGNOSTIC_LIMIT` = 24, oldest dropped, named by its OWNING plugin, with the failing
  hook and the plugin's structured payload), makes it DURABLE
  (`HarnessSessionRecord.pluginDiagnostics`, restored tolerantly — a malformed entry is dropped
  rather than costing the session its history, because this field is observability and cannot
  afford the strictness the load-bearing fields can), projects it onto `SessionSnapshot`/
  `SessionView` and onto the identified session read as `plugin_diagnostics`
  (`src/server/api-reads.ts`, `harness.swagger.yaml` `SessionPluginDiagnostic`, and the
  regenerated `src/shared/harness-api.ts`), and prints the three FAILURE kinds on stderr
  (a `policy` report is a decision, not a breakage, so it is recorded and not shouted). It never
  schedules a save of its own — a diagnostic is an observation, and letting a chatty plugin drive
  the whole-document save rate would undo the coalescing rule the context entry just landed. The
  plugin-visible mirror event (`host.plugin_error`-style, "a plugin must be able to see another
  plugin's failure") is still NOT added: that is the open edge T1.5 recorded, and it needs the
  re-entrancy rule that entry never specified.
- **Check evidence (2026-11-09).** Baseline BEFORE the edit, the five focused files above:
  **5 files / 97 tests passed** (the lane suites green on the tree this change started from).
  After: the same five plus the fast-path guard and the sink's own file —
  `npx vitest run src/server/workers/lane-worker.test.ts src/server/workers/lane-worker-correctness.test.ts src/server/workers/lane-authority.test.ts src/server/workers/lane-commit.test.ts src/server/transcript.test.ts src/server/queue.test.ts src/server/plugins-api.test.ts`
  → **7 files, 149 tests, all passed**, with `src/server/queue.test.ts` carrying **no
  modification at all** in `git status` and `src/harness.inclusion.test.ts` carrying only the
  Stage 1 context work this entry was written against — T4 edited neither, which is F8's proof
  that a lane change cost the inline fast path nothing. The new case names are in
  the three worker files, and the T1.5 sink is pinned in `src/server/plugins-api.test.ts`
  (a throwing `turn.before` hook still answers AND names itself, its owner and its event on the
  session; the same record found in `state.json` and re-read after a restart; a plugin's own
  `policy` report journaled with its payload and absent from the log).
- **Whole-package verification after the last edit (2026-11-09).** `npm run typecheck` (both
  manifest checks + `tsc --noEmit`) → clean, and neither generated manifest needed a
  regeneration: no plugin's declared `metadata` changed. `npm test` → **178 files, 3 130 passed |
  2 skipped, 0 failed** against the recorded baseline of **3 110 passed / 2 skipped** — every one
  of the twenty added tests is this change, and no pre-existing assertion moved. Because the
  contract moved (a new `SessionPluginDiagnostic` schema and `plugin_diagnostics` on the session
  resource) and `src/shared/harness-api.ts` was regenerated from it, `npm run test:frontend` was
  run as well: **138 files, 1 813 passed**, the baseline figure unchanged. The lane evidence
  came from the **worker** lane (`threadExecution: 'worker'`, real `node:worker_threads`); the
  inline lane is what the full suite and `src/server/queue.test.ts` cover. Not run by this
  landing: `npm run test:package:tools`, whose two failures are recorded as pre-existing and
  outside this scope.
- **Not tested by this landing (claims, not observations).** (1) A `turn.before` plugin decision
  carried by a real lane replica — F5's limit, above. (2) The lane-side DIAGNOSTIC path: the
  replica passes `diagnostic: () => undefined` on purpose, so a plugin that throws INSIDE a hook
  on a lane is still reported only inside the worker process; `src/server/workers/lane-worker-loop.ts`
  `sayHello` says why in the line itself. (3) Two live lanes patching ONE conversation
  concurrently: the fold's CAS and the writer lease both refuse the second, and that pair is
  pinned at the fold and the authority, but no test runs two lanes against one transcript at the
  same instant. (4) A patch that conflicts while a run is attached on the REPLICA: the rebase's
  `setThreadMessages` is then refused by the core's live-work guard, the base is left honestly
  stale, and the next boundary (or the next turn start, which always syncs first) retries — that
  retry is the pre-existing M4 contract, not something this change re-pinned.

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

   **RESOLVED 2026-11-09 (T2.3): reuse the abort path; no new status.** The run's own
   cancellation machinery is taken — `stopThreadState` with the plugin's `reason` as the
   abort reason, then `throwIfAborted` — so the vocabulary a host already renders stays
   closed: the conversation records `stopped`, the invocation records `cancelled`,
   `run.failed` (not `run.finished`) carries the reason, and `threadRead`/`agentResult`
   need no new branch. A distinct `plugin-stopped` reason was rejected because it would
   split ONE observable event ("this run did not answer") across two spellings for no
   gain a consumer could act on: the *why* the owner actually needs is the `reason`
   string, which rides the abort already. On the transcript question: the hook's replaced
   message is **not** kept, because `replace`/`transcript` only ever shapes the REQUEST —
   nothing was committed to keep — and everything the run itself appended (including any
   earlier turn's assistant message and its tool results) is rolled back by the run's
   existing splice, exactly as the `maxIterations` guard does. That is what makes an
   orphan assistant message impossible, and it is pinned by
   `a stop decision mid-run ends the run with the plugin reason and leaves no orphan
   assistant message`.

3. **Same-actor `api.threads.send` from inside a hook.** A `turn.before` handler that
   calls `api.threads.send(threadId, …)` on the thread whose turn is parked re-enters the
   serializer for that actor key (`serializeTurn(run.actorKey, …)`,
   `src/harness.ts:7843`, and the "no overlapping harness execution" property pinned by
   `src/server/queue.test.ts`). Whether that deadlocks or queues behind the parked turn
   is **untested** (see *Not tested*) and must be answered before the guide (T5.1) tells
   authors they may do it.

   **ANSWERED 2026-11-09: FORBIDDEN UNTIL TESTED.** Nothing in T1/T2 changed the
   serializer, and no test in this stage re-enters it from a hook, so the question is
   still open as a matter of EVIDENCE, not of behaviour: the answer recorded here is a
   prohibition, not a finding. The authoring guide (T5.1) must therefore NOT tell authors
   they may call `api.threads.send` on the thread whose turn is parked (and must not
   imply the parked turn makes it safe); a different actor key is a different question and
   is already exercised by the `threadSend` merge. Closing this needs one probe test —
   send-to-self from `turn.before` under a fake transport with a bounded wait — and
   whichever stage adds it replaces this sentence with what it observed.

4. **Capability tiers vs raw access** — T0's Q2, with the recommendation recorded but not
   the decision.

   **ANSWERED 2026-11-09:** decided in T0 as **(a) the design target, not implemented
   this stage**, with the reason `metadata` did not gain the field — see the *DECIDED*
   block there. This entry stays as the pointer; the argument lives in one place.

5. **Whether `harness.dispose` needs a handle member at all** — T1.6: the alternative is
   emitting it from server session teardown only, which leaves a library-only consumer
   with no teardown at all.

   **RESOLVED 2026-11-09 (T1.6): BOTH, and the handle member is the primitive.**
   `harness().dispose()` exists (`Harness.dispose`) and the server calls it from
   `SessionStore.disposeSession`, so `remove()` and a store shutdown both reach it. The
   alternative alone was rejected for exactly the reason this entry states: a
   library-only consumer (a CLI, a test, every harness in `src/**/*.test.ts`) would have
   had no teardown at all, and the shipped `async-ping` plugin's forward-looking
   `harness.dispose` subscription — inert since it was written — would have stayed inert.
   Making the handle the primitive also means the ordering guarantee lives in ONE place
   (the harness knows when its last run settled; the server does not), and the server
   binding is then a one-line call rather than a second emit site with its own race.

6. **Wildcard payload typing.** `{ event, payload }` loses per-event narrowing unless it is
   a mapped union keyed by `HarnessLifecycleEvent`; a `payload: unknown` escape hatch would
   put an `any` back at the boundary that the current design deliberately removed
   (`src/types/index.ts:3364-3367`).

   **RESOLVED 2026-11-09 (T1.1): the mapped union, exactly as this entry prefers.**
   `HarnessWildcardEventContext = { [E in HarnessLifecycleEvent]: { event: E; payload:
   HarnessLifecyclePayloads[E] } }[HarnessLifecycleEvent]` — a discriminated union, so
   `if (context.event === 'turn.before') context.payload.estimatedTokens` typechecks and
   no `unknown`/`any` appears at the boundary. Two consequences recorded with it: the
   overload pair on `on` is what keeps `E` from widening (T1.1), and a wildcard handler's
   result is typed `void | Promise<void>` — an observer that happens to be entered on a
   `turn.before` frame cannot rewrite the request by accident (plugin/hooks.ts rule 7).

## Verify before starting — drift check

A premise that fails is **not** a reason to proceed: mark that finding `corrected` in
place (keep the original text — the rule at `docs/tasks/README.md:28-30`, which this
entry cited as `:24-26` until the index rows grew), then re-scope
from the surviving findings.

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'                # written against 44cdbbe, tree dirty
grep -n "export type HarnessHookResult\|HarnessLifecycleResult" src/types/index.ts
grep -rn "onHandlerError" src/             # expect: hooks.ts + hooks.test.ts ONLY
#   CORRECTED 2026-11-09 (T1.5): it is now wired at the `createHookBus` call site in
#   `src/harness.ts` (`notifyPluginDiagnostic`), which is exactly stop-and-recheck
#   condition (2) resolving as "T1.5 is live work", and the tests that install one.
grep -n "createHookBus()" src/harness.ts   # expect: no options argument
grep -n "harness.dispose" src/harness.ts   # expect: no production emit site
#   CORRECTED 2026-11-09 (T1.6): `emitDispose` is a production emit site now (the handle's
#   `dispose()`, plus the deferred emit at the end of `runAgent`'s finally), and
#   `src/server/sessions.ts` binds it to session teardown.
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
   **HIT 2026-11-09 (T4.1, both halves together), so this command set now reports "T4.1 already
   did the thing" — do not re-implement it.** `SharedMutation` carries
   `transcript:patch { threadId, expectedLength, expects, messages }`, and the flag-only detection
   is `LaneWorkerState.committedDigest` diffed in `deriveOperations` — the half a reader must
   CHECK rather than assume, because an op union can grow while the condition that emits it stays
   blind to a change of length. The assertion that replaced the premise is
   `owes NOTHING while the replica matches its base, and a patch the moment a committed flag moves`
   in `src/server/workers/lane-worker.test.ts`. The `grep -n "does not reach the authority" src/types/index.ts`
   line above now prints NOTHING for the same reason: T4.2 replaced that sentence.
4. **The server gained a plugin list** (grep `plugins:` in `src/server/`) — T0's Q1 is
   answered by someone else; record which commit and re-read the trust statement.
5. **`HarnessTurnBeforeContext` gained `actorKey`/`branchId`** — T3.4 is done, and F7's
   third row is `corrected`.
   **HIT 2026-11-09 (T3.4 / context T8):** both fields exist and F7's third row is marked in
   place, so this command set now reports "T3.4 already landed" — do not re-implement it.
   The assertions that replaced the premise are
   `names a fork round differently from a root round while threadId stays equal, and a branch
   edit reports no notification` in `src/harness.inclusion.test.ts`.

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

**Re-checked 2026-11-09 after T1/T2 landed — what this stage DID observe, and what is
still a claim:**

- **Observed by test**, so no longer a gap: a wildcard sees every deliverable event
  exactly once with a payload that narrows; a priority-1 handler runs first; a
  never-resolving handler is dropped at its budget and reported while the healthy
  handler's override survives; a throwing handler is reported through
  `report.diagnostic` and the run answers; `harness.dispose` fires once, is deferred
  behind a live run, and clears the bus (a later run fires no hook at all); each of the
  four decisions; a `stop`'s rollback; a malformed decision's report next to its still-
  applied override; and the frame-identical hot path with a synchronous decision.
- **Still NOT observed.** (1) **A timed-out handler's SIDE EFFECT** — the never-resolving
  case is tested, and the *documented* rule is that a budget bounds the WAIT, not the
  damage (a flag write the handler made before stalling stays made), but no test writes
  `included` and then stalls. T4's durability work should pin that, because a partially
  applied compaction is where it bites. (2) **The same-actor `api.threads.send` probe** —
  open decision 3, now a prohibition rather than an answer, still unprobed. (3) **A
  `pause` decision against a host-driven stop, and a `stop` against an in-flight
  delegated child.** Both control-flow claims about `src/harness.ts` paths remain
  unexecuted: T2 tested a pause on a plain tool round and a stop on a root run, not the
  interaction. (4) **Worker lane + plugin decision** — untouched by this stage (T4), so
  F6's "not restart-durable under `threadExecution: 'worker'`" sentence still stands, and
  no lane was ever observed carrying a decision. (5) **A `dispose()` called while a run is
  live AND a delegated child is pending** — the deferral is tested for one root run; the
  child case relies on `activeRuns` counting every run the harness owns (which the code
  states and the test does not exercise). (6) **Frontend**: `npm run test:frontend` was
  NOT part of this stage's verification list, so a new catalogue event reaching the
  Plugins pane (`host.state_change`) is verified at the type level only — `tsc` and the
  manifest check, no rendered row. T5.4 owns that claim.

**Checked 2026-11-09 after T3 landed — what T3 observed, and what it left a claim.**

- **Observed by test.** A legal edit reaching the SAME provider request; an illegal patch
  refusing fifteen inputs with the canonical transcript byte-identical afterwards; a
  pairing key staying byte-identical through an edit (`Object.keys` order pinned); an
  edited text surviving JSON + `restore()` and being served by a harness with no plugin;
  a fork carrying an edited entry into its materialized record AND its own request; a root
  round and a fork round differing on `actorKey` while `threadId` is equal, with
  `branchId` absent on the root and equal to the branch record's id on the fork; a branch
  edit reporting no state change; `api.snapshot()` mid-run being the host document,
  detached, and silent; and `setOwn` reaching the host provider on the next read, with each
  refusal wording pinned.
- **Still NOT observed.** (1) **A worker lane carrying an edit** — the same gap F6 records
  for a flag, now for two mutation kinds, and T4 is the only owner. (2) **A store that
  persists on the notification** — every T3 durability claim is "the `agent_message`
  notification is reported", exercised against `report.stateChange` in a library harness,
  not against `state.json` in a server session (the server cannot host a plugin, F5).
  (3) **A branch policy that ACTS on the discriminator** — T3 exposes `actorKey`/`branchId`
  and tests that they differ; no shipped plugin changed its behaviour on them, and the
  compaction cooldown key is deliberately untouched. (4) **`api.snapshot()` from a lane
  worker replica** — untested, and untestable from the inline lane; T4's suite is where a
  replica's snapshot first means anything.

**Checked 2026-11-09 after T4 landed — what T4 observed, and what it left a claim.**

- **Observed by test.** A lane's IN-PLACE write reaching canonical state: the fold's whole-prefix
  CAS (applied; stale-digest refusal; shortened-canonical refusal; malformed payload; the writer
  lease; the sibling-append that must NOT read as a conflict; and a conflicting patch rolling its
  whole group back through `rolledBackReceipts`); the live applier on a REAL canonical harness,
  where the AUTHORITY's own `threadMessages` answers `included: false` plus the rewritten text and
  reports exactly one `agent_message`; the core seam's structural refusals (a role or an address
  moving, a local run attached); the digest-aware pull (`transcript:sync` rebases at equal length,
  and an absent `haveDigest` keeps the pre-T4 answer, so an older worker is never refused for not
  knowing the field); the worker's derivation, including the fast path that owes NOTHING when the
  replica matches its base and the adoption rule that stops one patch being re-pushed at every
  later boundary; and the DURABLE claim end to end on a real `threadExecution: 'worker'` session —
  committed by the session's own authority on a live lane epoch under the lease that lane holds,
  present in `state.json`, and read back by a second store over the same root. Plus the T1.5 sink
  on a real session: a `turn.before` handler that throws STILL answers, and names its owner, its
  event and its message on the session, in the durable document, and after a restart — while a
  plugin's own `policy` report is recorded with its payload and kept off the server log.
- **Still NOT observed.** (1) **A `turn.before` plugin running on a real replica** — F5's limit (a
  preset factory closure cannot cross `worker_threads`, and the built-ins that DO get there act
  only above their declared 100 000-token `contextLimit`), so the durable test submits the patch ON
  the lane's behalf rather than watching a plugin produce it; T4.4 owns that missing step, and
  `lane-worker.test.ts` says so in the test's own header rather than implying more. (2) **A lane
  DIAGNOSTIC reaching the authority**: `sayHello` passes `diagnostic: () => undefined` explicitly,
  because there is no frame for it — same cause, same documented limit as `pluginSettings`
  ("WORKER MODE" in `src/server/plugins.ts`). (3) **Two live lanes patching one conversation at
  once** — the CAS and the lease refuse the second, pinned at the fold and the authority but never
  raced on threads. (4) **A conflicting patch while a run is attached to the REPLICA**: the
  rebase's wholesale `setThreadMessages` is then refused, the base stays honestly stale, and the
  next safe point retries — the pre-existing M4 contract, not re-pinned here. (5) **The Plugins
  pane rendering `plugin_diagnostics`** — the contract and the generated client types moved with
  the field, and no rendered row was observed (T5.4's rule still applies to it).

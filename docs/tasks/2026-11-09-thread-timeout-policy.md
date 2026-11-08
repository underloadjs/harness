# Thread time limits — the default must be "no limit"

Status: **closed 2026-11-09 — policy change, implemented; T0-T9 all CLOSED (the dated
`LANDED` / `ANSWERED` notes under each task name the file and the test; nothing is
committed, the work sits in the package working tree).** Written from a source audit
(no live session was run for this entry, see *Not tested*), against revision
`44cdbbe` ("Upgraded Task Logic") of the **`@underload/harness` package repository**
(which is its own git repo at `packages/underload/harness/.git`, not the workspace
root), working tree dirty. Every numeric claim below was read out of the file it is
attributed to; the drift checklist near the end lists the
exact commands to re-verify them, because other tasks land on these files constantly
and line numbers will move.

Written for an agent that did not do the audit and that must **verify the premises
before implementing** — this document is a specification of intent plus a map of the
surface, not a guarantee that the surface still looks like this.

**STATUS 2026-11-09 — IMPLEMENTED (working tree of the package repo; nothing
committed, per the assignment).** Every task T0-T9 is closed and each task section
below carries a dated `LANDED` / `ANSWERED` note naming the file and the test that
closes it. The drift check re-ran clean against HEAD `afb38f1` ("Updated List", the
commit after the `44cdbbe` this entry was written against) with **one premise
overturned**: the `toolCancel`-discoverability claim F5/T7 inherited from the sibling
entry had already been fixed at `44cdbbe` itself (see the `corrected` note at F5).
The verification actually run is recorded at T5 and T9; the two `test:package:tools`
failures are pre-existing at `afb38f1` (proved by a fresh build in a pristine
worktree of HEAD) and are unrelated to this change.

## Date / Method / Scope

**Date:** 2026-11-09.

**Method:** static audit of every wall-clock bound attached to a thread, plus the
existing documentation of those bounds. No behavioural probe was run; the sibling
entry [2026-11-08-delegate-stress-test.md](./2026-11-08-delegate-stress-test.md)
already measured `timeoutMs` enforcement live (its *Controls that work* table,
line 50) and that measurement is reused here rather than re-derived.

**Scope:** the four kinds of thread the package runs — delegated children
(`delegate`), forked threads (`threadFork` / autoanswer branches), host threads
(`createThread` + `sendThreadInput`), and conversations driven by `threadSend` /
`steerThread` — and the tool calls that happen inside them.

**Out of scope (explicitly, so nobody "fixes" it):** every tool's own timeout, the
per-run `maxIterations` count bound, run-depth bounds, thread/branch/tool record caps,
and the server's worker-startup and connection timers. Those are listed under *What
stays bounded on purpose* and must survive the change.

## Requirement

Stated by the requester on 2026-11-09, expanded to the four claims it actually makes:

- **R1.** No thread has a time limit. That covers delegated children, forked
  threads, and "otherwise" — every path that runs a conversation.
- **R2.** A thread stops only when the agent produces its final answer. Nothing
  external may end it on a clock.
- **R3.** A stopped thread can always be restarted by sending it a new prompt.
- **R4.** Tool calls *do* keep time limits, because a hung tool would otherwise run
  forever and must be killed automatically. The thread's unboundedness rests on the
  tools inside it being bounded.
- **R5.** The timeout is **not deleted**. It becomes an optional, caller-settable
  bound whose **default is infinity**: the spawning agent may impose a limit when it
  believes one is warranted, and that is entirely its choice.

R5 is the load-bearing nuance. The change is "finite default → unbounded default with
an opt-in bound", not "remove the parameter".

## Findings

### F1. `delegate` is the only thread with a clock, and its default is finite — this violates R1/R2/R5

One `setTimeout` in the whole turn machinery of `src/harness.ts` bounds a conversation:
the delegated child.

| What | Where | Value today |
|---|---|---|
| Canonical default | `src/core/agent-limits.ts:37` | `DELEGATE_TIMEOUT_MS = 300_000` (5 min) |
| T28 rationale comment | `src/core/agent-limits.ts:29-36` | "a child that ran `sleep 600` sat `running` indefinitely … Five minutes is long enough … short enough that a frozen child cannot hold a session open" |
| Re-exports | `src/core/index.ts:219`, `src/core/metadata.ts:74-81` (name at `:80`) | — |
| Import into the harness | `src/harness.ts:311` | — |
| Default applied | `src/harness.ts:3591-3594` | `timeoutMs` if a finite number, else `DELEGATE_TIMEOUT_MS`; floored at 1, **no upper clamp at runtime** |
| Timer armed | `src/harness.ts:3596-3606` | `AbortController` + `setTimeout(..., timeoutMs)`, `timer.unref?.()`, abort reason `Delegation to "…" exceeded its ${timeoutMs}ms timeout and was stopped.` |
| Signal merge | `src/harness.ts:3608` (`linkSignals(callerSignal, timeoutController.signal)`, helper at `:3432-3452`) | child aborts on caller abort **or** on its own timer |
| Timeout verdict | `src/harness.ts:3639` (`timedOut = timeoutController.signal.aborted`) and `:3654-3656` (error text repeated in the result) | — |
| Cleanup | `src/harness.ts:3665-3667` (`clearTimeout` in `finally`) | — |
| Model-facing schema | `src/tools/runtime/delegate.tool.ts:76-82` | `timeoutMs`: `integer`, `minimum: 1`, `maximum: 3600000`, description "…Defaults to 300000 (5 minutes). On expiry the child is stopped…" |
| Allowlist-mode description | `src/tools/runtime/delegate.tool.ts:147` and its `core/metadata.ts:203+` twin | restates the envelope contract; does not restate the default |
| Generated mirror | `src/core/tool-manifest.ts:884-889` (`:888` carries "Defaults to 300000 (5 minutes)") | generated, not hand-edited |
| Host-facing signature | `src/types/index.ts:842-857` (`timeoutMs?: number` at `:849`) | — |
| `context.run` comment | `src/types/index.ts:1592-1598` | says the linked signal exists so `delegate` can enforce `timeoutMs` |

Two consequences worth stating before the tasks:

- **Nothing pins the number.** `DELEGATE_TIMEOUT_MS` appears in **zero test files**
  (grep it). `src/core/metadata.ownership.test.ts:374-381` pins only that the delegate
  parameter **name list** contains `'timeoutMs'` (`:379`), and its numeric equality pin
  at `:389-395` covers `[200, 5, 64, 4000, 8000]` — the four `AGENT_*` limits — not the
  delegate timeout, despite `src/core/agent-limits.ts:14-18` and `:35-36` claiming it
  does. **That comment is currently wrong about the delegate entry.** So the 5-minute
  default is specified only by prose. The live timeout behaviour *is* tested, but with
  an explicit value: `src/harness.delegation.test.ts:599-670`
  the `delegation timeout (T28)` block opens at `:606`; `timeoutMs:30` at `:632`, asserting
  `status: 'cancelled'`, the `exceeded its 30ms timeout` text at `:666`,
  `partialContent` and `cancelledAtMessage`).
- **The schema ceiling and the runtime disagree today.** The schema caps an explicit
  `timeoutMs` at 3_600_000 (`delegate.tool.ts:79`) but `src/harness.ts:3591-3594` only
  floors at 1, so a host calling `runtime.delegate(...)` (`src/types/index.ts:849`) can
  pass 10 hours today and it is honoured. Any fix must decide one behaviour and test it
  (T2.3).

### F2. Every other thread already runs without a clock — the work is narrow, not a sweep

Verified by reading each entry point; none attaches a timer or a deadline.

| Thread-running entry point | Location | Timer attached? |
|---|---|---|
| `sendThreadInput` (host turn) | `src/harness.ts:4705-4744` | no — awaits `runAgent` with the caller's `options?.signal` only |
| `steerThread` | `src/harness.ts:4673-4703` | no — synchronous queue push + `markRunDirty` |
| `threadSend` / `postThreadMessage` | `src/harness.ts:4199-4226`, `:4219` | no — mailbox post |
| `threadFork` dispatch | `src/harness.ts:~6760-6941` (`scheduler.schedule` → `runAgent(branch, …, signal, …)`) | no — aborts only with the parent run |
| `actionRequest` autoanswer branch | `src/harness.ts:~7060` (`forkAgent(ownerRun.agent, …)`) | no |
| `context.run` / `ctx.run` | model path `src/harness.ts:6410-6437`, manual path `:9615-9648` | no own timer; `:6437` `linkSignals` exists **only** so `delegateFor` can feed in its own |
| harness callable `writer(input)` | `src/harness.ts:8315` (`runAgent`), handle at `:9982` | no |
| plugin `api.threads.send` / `.steer` | `src/harness.ts:1236-1237` | no |
| server `executeTurn` | `src/server/sessions.ts:7256-7294` | no — `new AbortController()` at `:7273`, aborted by operator stop/cancel only; `src/server/sessions.ts` contains no `setTimeout` at all |

The fork/branch layer is the cleanest confirmation of the intended shape: its four
frozen bounds are **count, depth and size only** — `MAX_FORK_DEPTH = 2`
(`src/core/branch.ts:57`), `MAX_FORK_CONCURRENT = 4` (`:60`),
`MAX_FORK_HISTORY_BYTES = 8 MiB` (`:64`), `MAX_BRANCH_RECORDS = 64` (`:67`) — and the
`threadFork` tool schema takes exactly `input` and `label`
(`src/tools/runtime/threadFork.tool.ts:19-39`), with **no `timeoutMs`**.
`HarnessForkConfiguration` (`src/types/index.ts:1101-1107`) and `ForkAgentOptions`
(`src/core/branch.ts:158-168`) likewise have no time field.

So the implementation surface for R1 is essentially **`delegate` + the policy text**,
and the rest is a regression guard (T5.3).

### F3. No server, worker, or frontend timer will cut a long turn off — but three timers look like they might

Read these before "fixing" them; each is bounded to something other than a turn.

| Timer | Value | What it actually bounds |
|---|---|---|
| `LANE_IDLE_MS` / `workerIdleMs` | 120_000 (`src/server/workers/protocol.ts:86`; default `src/server/config.ts:136`, max `WORKER_IDLE_MS_MAX = 3_600_000` at `:128`) | idle **worker** reclamation; `armIdle` (`src/server/workers/lane-host.ts:328-336`) arms only when the lane is *not* active, so a never-ending turn never arms it |
| `LANE_HANDSHAKE_MS` / `workerHandshakeMs` | 60_000 (`src/server/workers/protocol.ts:95`, enforced `lane-host.ts:549-558`, config bounds `src/server/config.ts:130-131`) | worker **startup** (hello), not the turn |
| `IO_HANDSHAKE_MS`, `IO_CLOSE_GRACE_MS`, `opTimeoutMs` | 60_000 (`src/server/workers/io-protocol.ts:86`), 30_000 (`io-client.ts:123`), **off by default** (`io-client.ts:220`, `:693-703`; pinned "opTimeoutMs is off by default" in `io-client.test.ts:624`) | IO worker startup / shutdown / a single IO operation when explicitly enabled |
| WebSocket heartbeat | `heartbeat_interval_ms: 15000` × `heartbeat_timeout_intervals: 3` = 45 s of **peer silence** → close 4408 (`src/shared/harness-stream.ts:28-47`, server `src/server/stream/connection.ts:360-374`, client `src/frontend/stream.ts:320-333`) | connection liveness; **any inbound frame re-arms it**, and the server pings every 15 s, so a long turn does not trip it. Values are `fixed_by_contract` (`src/server/stream/protocol.ts:295`, `:323-324`) — do not change them here |
| `sustained_stall_ms` | 10_000 (`src/server/stream/connection.ts:114-128`) | a full send queue for 10 s closes the connection (backpressure) |
| `ack_timeout_ms` | 5_000 (`src/server/stream/broker.ts:418-431`; `replay_seconds: 60` at `:364`) | `pace: 'ack'` subscription pacing → `resync_required`, never aborts a run. The frontend copies the value (`src/frontend/stream.ts:165`) but never arms it |
| `MODEL_LIST_TIMEOUT_MS`, `PROBE_TIMEOUT_MS` | 10_000 (`src/server/api.ts:326`), 2_500 (`src/frontend/api.ts:715-718`) | provider model-list fetch / endpoint candidate probing |
| `VIEW_CHECKPOINT_INTERVAL_MS` | 2_000 (`src/server/sessions.ts:440`, used `:4360`) | view checkpoint throttling |

Worker-mode caveat that is orthogonal to time but relevant to how R1 gets *phrased*:
under `threadExecution: 'worker'`, a lane worker **refuses** nested runs outright —
`NESTED_RUN_TOOL_NAMES = ['delegate', 'threadFork']`
(`src/server/workers/capability.ts:342`, doors at `:421-423` and `:528`,
`src/core/nested-runs.ts:54`). An unbounded delegated child is therefore an
**inline-mode property**; the new description text must not promise it inside a lane.

### F4. R3 ("a stopped thread restarts on a new prompt") is already true for the host path and deliberately false for the agent path

- `sendThreadInput` revives `stopped` → `idle` before running
  (`src/harness.ts:4705-4744`, comment at `:4716-4720`: "An explicit HOST turn revives
  a stopped conversation. Model-driven paths (delegation, threadSend, steering) do
  not: 'stopped' must mean stopped for agents"), and resumes a plugin-parked `paused`
  record via `resumeThreadState` (`:4730`). R3 is satisfied for a host prompt today.
- `threadSend` **throws** for `stopped` (`src/harness.ts:4232-4236`) and for
  `idle`/`paused` it does an inert append (`delivered: 'appended'`).
- `steerThread` refuses `idle` honestly: `Thread "…" is idle; use sendThreadInput to
  start a turn` (`src/harness.ts:4686-4691`).

**This is a live policy conflict, not a bug to fix silently.** The sibling entry
proposes making `threadSend` state-aware (start a turn when not running) while its
**T3.3** keeps `stopped` a refusal on the reasoning quoted above
(`2026-11-08-delegate-stress-test.md:311-318`). R3 as worded here says a stopped
thread restarts "when a new prompt is sent", and `threadSend` is a prompt. Which
surface that applies to must be decided, not averaged (T6).

### F5. Dropping the finite default re-opens exactly the hole T28 closed, and today the only recovery is a control the model reportedly cannot find

**CORRECTED 2026-11-09 (the second half of this heading is no longer true).** The
recovery is a control the model CAN now find: sibling tasks **T1.2** (report
conditionally-declared core tools in `alreadyAvailable`) and **T1.3** (name
`toolCancel` in the `status: 'pending'` envelope) had already landed at `44cdbbe`,
before this entry was written — see the corrected note under the two sharp edges and
at T7. The first half of the heading (the hole T28 closed) stands: an unbounded child
is only recoverable because those two fixes exist, which is why they are a
precondition of this policy rather than an unrelated improvement.

T28's own comment (`src/core/agent-limits.ts:29-33`) says the finite default exists
because a frozen child otherwise "sat `running` indefinitely" and `toolCancel` was
the only recovery. Making the default unbounded moves that risk back out, so the
claim must be met with the two escape hatches that remain:

1. **The tool clocks inside the child** — R4. This is the intended primary defence,
   and it is real; see *What stays bounded on purpose*.
2. **The liveness wake + `toolCancel`** — `DEFAULT_WAKE_INTERVAL_MS = 600_000`
   (`src/harness.ts:468`, validated `:489-499`, resolved `:802`) is explicitly
   "a LIVENESS interval, not a timeout — nothing is killed automatically (the model
   decides, via `toolCancel`)" (`src/harness.ts:461-463`). Core owns no timer; the
   shipped `async-ping` plugin does (`src/plugins/async-ping.plugin.ts:64`
   `DEFAULT_PING_INTERVAL_MS = 600_000`, declared setting default `600000` at `:90`,
   one-shot self-rearming `arm()` at `:162-176`, cleared on `async.drained` at
   `:210-212`), seeded from the harness option via
   `'async-ping': { intervalMs: wakeIntervalMs }` (`src/harness.ts:1161-1167`) and
   exposed as `api.config.wakeIntervalMs` (`src/harness.ts:1263`).

Two sharp edges to verify rather than assume:

- `toolCancel` is declared **only while that agent has calls in flight**
  (`src/tools/runtime/toolCancel.tool.ts:9-12`, `visibility: 'core'` at `:31`) and the
  sibling entry reports it is unreachable through `toolRequest`
  (`matched: 0` by name, regex, and tag; absent from `alreadyAvailable`) —
  `2026-11-08-delegate-stress-test.md:70-110`, tasks T1.1-T1.4. With no default clock,
  an undiscoverable `toolCancel` means a stuck child has **no practical recovery**.
  **CORRECTED 2026-11-09 — it is discoverable.** `declaredForDiscovery`
  (`src/harness.ts`, the "T28: the set toolRequest reports as `alreadyAvailable`"
  helper) appends the pending-only control to the declared set under exactly the
  condition `offerDeclarations` declares it, excluding the asking `toolRequest` call
  itself, and the projection placeholder for a still-running call says *"use toolCancel
  with this callId to abandon it"*. Pinned by
  `src/harness.already-available.test.ts` (`toolCancel discovery (T28)`) and, for the
  delegation envelope, by the new
  `src/harness.delegation.test.ts` › *pending delegation placeholder
  (delegate-stress T1.3/T1.4)*.
- The wake is a **plugin**, so a deployment that disables `async-ping` (or a settings
  document that pins its `intervalMs`) can make an unbounded child invisible. Whether
  the child's *own* hung tool call gets its wake, or only the parent's, is untested
  here (`async-ping` keys its per-agent timer on scheduler identity,
  `src/plugins/async-ping.plugin.ts:100-105`).
  **MEASURED 2026-11-09 (T8): the child gets its own wake.** The plugin arms per
  scheduler identity, and a delegated child is its own actor, so the child is woken
  and its own inspecting turn declares `toolCancel` — see the dated result at T8 for
  both configurations (heartbeat shipped vs replaced).

Related: a run's pending work is **interrupted, not resumed, across a restart**
(`knowledge.md:1901-1903`, `README.md:1661-1665`). An unbounded child that was
`running` when the process exits therefore comes back as a `running` record with no
timer anywhere — which is now the intended behaviour, but the docs must not imply a
clock will clean it up.

### F6. `maxIterations` is the remaining non-time bound that can end a run before the final answer

`DEFAULT_MAX_ITERATIONS = 16` (`src/harness.ts:459`, validated `:505-515`,
enforced `:7964-7969`, harness option `maxIterations` at `src/types/index.ts:2745`)
caps model requests per run and aborts the run — abandoning pending work — when it is
exhausted. R2 ("stops once the agent gives its final answer") is therefore not
literally true today, and raising the wall clock from 5 minutes to infinity will make
the 16-request ceiling the thing that actually ends a long child.

**Decision recorded, not made here:** `maxIterations` is a **count** bound and R1/R5
speak only about time, so the recommendation is to leave it alone and say so in the
docs (T4.3). If the requester meant "no bound of any kind", that is a different,
larger change and must come back as a new finding rather than being folded in.

**LIST AMENDED 2026-11-09 (T2.5 of
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) landed).** A
`turn.before` **`stop` decision** (`HarnessTurnDecision`,
`src/types/index.ts`; consumed in `requestTurn` via `applyTurnDecision` in
`src/harness.ts`) is now a **fourth** way a run can end before its final answer, next
to `maxIterations`, `MAX_RUN_DEPTH` and the record caps. It does **not** touch R1/R2:
it is not a clock — no timer, no deadline, nothing that expires — it is a *policy*
assertion made by code the application shipped, at a boundary where the run is already
parked. The thread still stops when its agent gives its final answer unless a plugin
says otherwise, and the wall clock stays infinite everywhere. What a `stop` does is
take the run's existing abort path: the conversation records `stopped`, the invocation
records `cancelled`, `run.failed` (not `run.finished`) carries the plugin's reason, and
everything the run appended is rolled back, so no orphan assistant message appears.
The closed list now reads: **the agent's final answer, a `maxIterations` count
exhaustion, a caller/host abort (`stopThread`, a signal, session teardown), or a
plugin's `stop` decision** — plus the structural bounds (`MAX_RUN_DEPTH`, the record
caps) that refuse work rather than end it. `README.md` / `knowledge.md` /
`src/core/agent-limits.ts` carry the same list and gain this member when the plugin
docs stage (T5.3 of the pipeline entry) lands; until then this paragraph is the record.

## Tasks

Order matters: **T0 is a blocking decision**, T1-T3 are the change, T4-T5 are text and
tests, T6-T8 are the edges, and T9 is the cleanup that keeps the audit trail honest.

### T0 — Decide how the harness callable behaves while an unbounded child is pending

`writer(input)` "resolves only after the response is complete AND every pending call —
delegated child runs included — has finished" (`knowledge.md:1893-1895`). Today a stuck
child stops in 5 minutes; with an unbounded default, a stuck child means
`await writer(input)` never resolves. Options:

- **(a) keep the drain** and rely on tools' own clocks + wake + `toolCancel` —
  consistent with R1-R5 and with the pre-existing "no automatic hard tool timeout"
  stance for ordinary tools (`README.md:1661-1665`, `knowledge.md:1899-1903`);
- (b) bound only the *wait*, not the child, so the callable returns with a `pending`
  envelope (this is the current async-delivery shape: `status: 'pending'` + `callId`,
  described at `delegate.tool.ts:147`).

*Check:* the decision is written into `delegate.tool.ts`'s description and into the two
docs, so a reader is never surprised by a never-resolving callable. Recommended: (a),
with (b)'s placeholder semantics already covering the "parent keeps working" case.

**ANSWERED 2026-11-09 — (a), the drain stays.** A delegated run has no wall-clock
limit, so `await writer(input)` may legitimately never resolve while a child is still
working, and that is the intended shape rather than a defect: the recovery for a stuck
child is (1) the **tools inside it**, each of which keeps its own time bound, (2)
`maxIterations` as the **count** bound that ends a run that keeps requesting, and (3)
an explicit **`toolCancel`** on the child's pending `callId`, which the placeholder and
the schema text both name. The unbounded default is therefore CORRECT, not an oversight
to paper over with a wait-only bound: option (b) would reintroduce exactly the clock R1
forbids, just relocated to the callable. Written where a reader meets it:
`src/tools/runtime/delegate.tool.ts` (the `timeoutMs` description: *"A child that is
still running is abandoned with toolCancel using the callId from its pending
placeholder"*), `README.md` (the *periodic wake* bullet under *The loop*, and the
delegation section), and `knowledge.md` (the *A thread has no wall-clock limit* bullet
next to the *Callable* bullet, which is where the drain contract is stated).

### T1 — Make "no limit" the default for a delegated child

- Keep the exported name and its re-exports (`src/core/agent-limits.ts:37`,
  `src/core/index.ts:219`, `src/core/metadata.ts:80`) so nothing else has to move; set
  it to `Number.POSITIVE_INFINITY` **or** delete the fallback and treat
  `timeoutMs === undefined` as unbounded — pick one and say which in the comment.
  Recommended: keep the constant, valued `Number.POSITIVE_INFINITY`, so the "default"
  is a single readable fact rather than an absence.
- In `delegateFor` (`src/harness.ts:3591-3606`), arm the timer **only when a finite
  bound was supplied**: wrap the `setTimeout`/`unref`/`clearTimeout` trio in
  `if (Number.isFinite(timeoutMs))`, and keep `timeoutController` unconditionally so
  the caller-signal path and the `timedOut` check at `:3639` keep working unchanged.
- Preserve today's `Number.isFinite` guard behaviour: an explicit `Infinity` passed in
  already falls through to the default, which after this change still means
  unbounded — correct, and worth a test so it cannot regress into "0 ms".

*Check:* with fake timers (`vi.useFakeTimers()` — the pattern used by
`src/harness.background.test.ts` and `src/harness.sync-async.test.ts`, which exist
precisely to avoid wall-clock assertions), a `delegate` with **no** `timeoutMs`
advanced well past 300_000 ms is still `running` and then completes normally; the
existing explicit-timeout test still passes untouched.

**LANDED 2026-11-09 — the recommendation is taken verbatim.** The exported name and its
re-exports are untouched; `DELEGATE_TIMEOUT_MS` is now `Number.POSITIVE_INFINITY`
(`src/core/agent-limits.ts`), with the original T28 comment kept above the dated
correction so the reasoning stays auditable. In `delegateFor`, `timeoutController`
stays unconditional (the caller-signal path and the `timedOut` verdict are unchanged)
and the `setTimeout`/`unref`/`clearTimeout` trio moved inside
`if (Number.isFinite(timeoutMs))`; the handle is `let timeoutTimer … | undefined` and
`finally` clears it only when it exists, so the unbounded path arms and clears
nothing. An explicit `Infinity` (and `NaN`/`-Infinity`, which the pre-existing
`Number.isFinite` guard already rejects) resolves to the default — still unbounded,
never 0 ms — and is pinned by the test
*treats an explicit non-finite bound as unbounded, never as 0 ms*.

### T2 — Settle the argument contract for `timeoutMs`

- **T2.1 — omitted ⇒ unbounded.** State it in the schema description
  (`delegate.tool.ts:76-82`).
- **T2.2 — the model-facing ceiling.** Keep `minimum: 1` and `maximum: 3600000`, and
  explain that the ceiling applies to what a *model may ask for*, not to the absence
  of a bound. A "0 means infinity" spelling is tempting and should be **rejected**:
  `minimum: 1` already forbids 0, and overloading 0 would make an explicit value mean
  "no value".
- **T2.3 — the host path.** `runtime.delegate(...)` (`src/types/index.ts:849`) is not
  schema-validated, and `src/harness.ts:3591-3594` applies no upper clamp (F1). Choose:
  clamp host values to the same ceiling, or document that the ceiling is
  tool-argument-only. Do not leave both behaviours half-implemented as they are today.

*Check:* one new validation test per choice (over-ceiling model value; over-ceiling
host value), and the schema text matches whichever behaviour the test asserts.

**LANDED 2026-11-09.** **T2.1:** omitted ⇒ unbounded, stated in the `timeoutMs`
description ("OMIT IT FOR NO TIME LIMIT, which is the default"). **T2.2:** `minimum: 1`
and `maximum: 3600000` kept, and the description now names the range and says it
"bounds what you may ask for, never the absence of a bound"; the "0 means infinity"
spelling is REJECTED and the rejection is tested — a model that sends `timeoutMs: 0` is
refused by the schema gate before the child runs. **T2.3 — the host path is documented
as tool-argument-only, NOT clamped.** The runtime applies no upper clamp (it never did)
and `runtime.delegate` is not schema-validated, so a host bound above 3600000 is
honoured exactly as given; that is now stated in the `delegateFor` comment, in the
`HarnessRuntime.delegate` signature comment in `src/types/index.ts`, and in
`README.md`/`knowledge.md`, so the half-implemented disagreement F1 recorded is gone:
both halves now say the same thing, and the tests assert it. Validation tests added:
*refuses a model bound above the ceiling before the child runs*, *refuses a zero
bound: the floor is real and 0 does not mean infinity*, *honours a host bound above the
model ceiling instead of clamping it*.

### T3 — Rewrite the model-facing text, in the one place that owns it

Three surfaces must agree, and only the entry literal is hand-written:

- `src/tools/runtime/delegate.tool.ts:52-101` — the AST-extractable literal the
  startup scanner reads (`src/core/tool-scan.ts`), so **no computation and no
  interpolation** in it;
- `src/tools/runtime/delegate.tool.ts:132-166` and its twin
  `src/core/metadata.ts:203+` — the allowlist form, derived **from** the literal, so a
  new argument is declared once;
- `src/core/tool-manifest.ts:884-889` — **generated**; regenerate with
  `npm run tools:manifest` rather than editing, because
  `npm run tools:manifest:check` (`package.json:105`, wired into `npm test` at `:96`;
  the script itself exits non-zero on a stale manifest, `scripts/generate-tool-manifest.mjs:29`,
  `:60`) fails if the literal moves without regeneration.

The new text must state, in this order: the child runs to its own final answer with
**no time limit by default**; `timeoutMs` is an **optional** bound for when the caller
believes one is warranted, and on expiry the result is the same structured
`status: 'cancelled'` envelope with `partialContent` and `cancelledAtMessage`
(`src/harness.ts:3654-3663`) that exists today; the recovery for a stuck child is
`toolCancel`, named explicitly at the moment the model holds a `callId`; and the tools
the child calls carry their own time bounds.

*Check:* `npm run tools:manifest:check` passes;
`src/core/metadata.ownership.test.ts:329-381` passes (catalogue/allowlist derivation
equality and the parameter-name list); `src/harness.metadata.test.ts:529-536` passes.

**LANDED 2026-11-09.** The rewritten text lives only in the entry literal's `timeoutMs`
property description (`src/tools/runtime/delegate.tool.ts`); the allowlist form DERIVES
its schema from that literal, so the catalogue row, the live declaration and
`src/core/metadata.ts` carry it from one place, and a property description is where a
model reads an argument's contract anyway. It is a plain literal holding number
LITERALS (no interpolation, no computation), in the order this task asked for: no time
limit by default → an optional bound the caller sets when it believes one is warranted →
the same structured `status: "cancelled"` envelope with `partialContent` and
`cancelledAtMessage` on expiry → `toolCancel` named at the moment the model holds a
`callId` → the child's tools keep their own time bounds. `src/core/tool-manifest.ts` was
REGENERATED with `npm run tools:manifest` and never hand-edited; the plugin manifest is
untouched. `scope`/`scope.tools` each gained one clause for the sibling entry's
finding-2 escape hatch, so the schema no longer promises a door that is really open.
All three checks were run and pass.

### T4 — Document the policy where a reader will actually look

- `README.md:1661-1665` and `knowledge.md:1899-1903` already say "no automatic hard
  tool timeout"; extend them with the thread-level rule: **a thread has no wall-clock
  limit; it stops when its agent answers; `delegate`'s `timeoutMs` is an optional
  caller-set bound; tool calls are individually bounded.** Also note the restart rule
  (R3) and that pending work is interrupted, not resumed, across a restart.
- `knowledge.md:1098-1099`-style tool tables carry tool timeouts already (shell at
  `:1099`); confirm the `delegate` row, if one exists in the delegation section,
  reflects the new default. Note that **no doc states the old 5-minute default
  anywhere** — grep of `README.md`/`knowledge.md` for `300000`/`5 minutes` finds only
  shell, web tool, and task-lease values. The "Defaults to 300000 (5 minutes)" wording
  lives only in `delegate.tool.ts:81`, `tool-manifest.ts:888`, and the T28 comments.
- **T4.3 — say what stays bounded** (the *What stays bounded on purpose* list below),
  so the next reader does not "discover" the same thing twice and so `maxIterations`
  is explicitly named as a count bound, per F6.

*Check:* no sentence in `README.md` or `knowledge.md` still claims a delegated child
is time-bounded by default; the 600000 wake is still described as liveness, not a
timeout.

**LANDED 2026-11-09.** `README.md` — the *A periodic wake keeps a turn honest* bullet
under *The loop* carries the thread-level rule, the retired 300000 ms default marked
CORRECTED IN PLACE, `maxIterations` named as the count bound, and the restart rule (a
HOST prompt revives a stopped thread; `threadSend` does not). The README delegation
section gained a two-control paragraph (time, then scope). `knowledge.md` — a new
*A thread has no wall-clock limit (policy 2026-11-09)* bullet sits directly under the
*Callable* bullet that states the drain contract, which is where a reader meets the
never-resolving-callable question; the pre-existing *no automatic hard tool timeout*
bullet is extended rather than rewritten; and the *Delegation* section now records the
pending-placeholder control and the scope escape hatch. **T4.2** — there is no
`delegate` row in the tool-timeout tables, and the grep this entry predicted is
confirmed: `knowledge.md`'s timeout rows are `shell`, the web tools and task leases.
The only places that ever said "Defaults to 300000 (5 minutes)" were
`delegate.tool.ts:81`, `tool-manifest.ts:888` and the T28 comments; all three now state
the new rule, and `src/core/metadata.ownership.test.ts` forbids the retired wording
from returning to either the literal or the generated mirror. **T4.3** — what stays
bounded is written out as a list in `README.md`, in `knowledge.md`, and in the
`src/core/agent-limits.ts` comment: tool clocks, `maxIterations` (a COUNT bound),
`MAX_RUN_DEPTH`, the record caps, and the 600000 ms wake described as liveness only.

### T5 — Tests, including the guard that the policy does not rot

- **T5.1** default-unbounded (T1's check).
- **T5.2** explicit bound unchanged — extend, do not replace,
  `src/harness.delegation.test.ts:599-670`; its `timeoutMs: 30` case is the proof that
  the mechanism still exists (R5).
- **T5.3** no clock on the other threads: one test that a `threadFork` branch and a
  host thread (`createThread` + `sendThreadInput`) survive an advanced fake clock well
  past 300_000 ms and finish on their own answer. Cheap, and it is what pins R1 for
  F2's rows.
- **T5.4** tool clocks untouched: no new test needed — `src/tools/command/shell.test.ts`
  (`:315-397` timeout cases), `src/tools/files/grep.test.ts` (`:820` "wall-clock
  budget"), `src/tools/runtime/threadRead.test.ts` (`:126`, 30_000) already pin them.
  They must stay green **unchanged**.
- **T5.5** optional but valuable: a source-shape assertion that the only
  turn-bounding `setTimeout` in `src/harness.ts` is the delegate one and that it is
  guarded by a finiteness check, so a future "safety timeout" cannot silently
  reintroduce a thread limit.
- **T5.6** pin the constant by number this time. `src/core/metadata.ownership.test.ts`
  claims to (`src/core/agent-limits.ts:14-18`, `:35-36`) and does not for
  `DELEGATE_TIMEOUT_MS` (F1). Either add the assertion or correct the comment — do not
  leave a comment that points at a pin that does not exist.

*Check:* focused run —
`npx vitest run src/harness.delegation.test.ts src/core/metadata.ownership.test.ts src/harness.metadata.test.ts src/harness.background.test.ts src/tools/command/shell.test.ts src/tools/files/grep.test.ts src/server/workers/protocol.test.ts`
then the package's full suite with `npm test` (`package.json:96`, which is the two
manifest checks plus `vitest run`). Report the counts and the failing test names, and
treat a green focused run as evidence for those files only — never as the final
verification.

**LANDED 2026-11-09 — every item, with the test that closes it.**

| Item | Where | What it proves |
|---|---|---|
| T5.1 default unbounded | `src/harness.delegation.test.ts` › *delegation time limits (policy 2026-11-09)* › `runs a delegated child with no clock at all when timeoutMs is omitted` | `vi.getTimerCount() === 0` while the child runs (it was 1 before the change); still `running` at exactly 300000 ms and at 1800000 ms; ends on its own answer with `status: "completed"`, no `error`, no `partialContent` |
| T5.2 explicit bound unchanged | same file, *delegation timeout (T28)* › `stops a frozen child and reports its partial work` | passes UNMODIFIED (only its heading comment gained a dated note that this is now the OPTIONAL behaviour); the mechanism's own timer is additionally proven by *honours a host bound above the model ceiling instead of clamping it*, which asserts `getTimerCount() === 1` and the exact `…exceeded its 5400000ms timeout…` error text |
| T5.3 no clock on the other threads | `src/harness.fork.test.ts` › `runs a branch with no clock when its own tool is parked (policy 2026-11-09 T5.3)`; `src/harness.thread-runtime.test.ts` › `a host turn has no wall-clock bound (policy 2026-11-09 T5.3)` | the fork half advances a fake clock that owns BOTH timers and Date (300001 ms, then 1500000 ms) with `getTimerCount() === 0` and no `branch_end`; the host-thread half moves DATE only via `vi.setSystemTime`, which is the probe for the other shape a limit takes — a `Date.now() - startedAt` deadline check — and the turn still ends on its own answer |
| T5.4 tool clocks untouched | `src/tools/command/shell.test.ts`, `src/tools/files/grep.test.ts`, `src/tools/runtime/threadRead.test.ts` | green and UNEDITED, inside the focused run alongside `src/server/workers/protocol.test.ts` |
| T5.5 source-shape guard | `src/harness.delegation.test.ts` › `harness source shape (policy 2026-11-09 T5.5)` | exactly ONE non-comment `setTimeout(` in `src/harness.ts`, and its line is immediately after `if (Number.isFinite(timeoutMs)) {`; exactly ONE `clearTimeout(`, guarded by `timeoutTimer !== undefined`; exactly ONE `: DELEGATE_TIMEOUT_MS` fallback. A future "safety timeout" must edit this test on purpose |
| T5.6 pin the constant | `src/core/metadata.ownership.test.ts` › `pins DELEGATE_TIMEOUT_MS by number and keeps the schema prose honest` | `DELEGATE_TIMEOUT_MS === Number.POSITIVE_INFINITY` — the claim at `agent-limits.ts:14-18`/`:35-36` is now TRUE because the assertion exists; the catalogue projection equals the entry literal; the schema still says `integer / 1 / 3600000`; its description names `1-3600000`, the unbounded default and `toolCancel`; and neither the literal nor the generated manifest may say "Defaults to 300000" |

Focused run, 2026-11-09, from `packages/underload/harness`, using the exact command
above: **7 files / 164 tests passed**. (`src/runtime/tools/delegate.test.ts` named in
this document's command does not exist — vitest skipped the missing path; the delegate
tests live at `src/harness.delegation.test.ts`, which is in the list.) The full-suite
result is recorded in the assignment report, not claimed here.

### T6 — Reconcile R3 with the sibling entry's T3.3 before either lands

F4's conflict is between two open task documents that both touch
`src/harness.ts:4232-4236` (`threadSend` refusing `stopped`). Decide which surface owns
"a new prompt restarts a stopped thread":

- host `sendThreadInput` — already correct (`src/harness.ts:4712-4724`), nothing to do;
- agent-facing `threadSend` — the sibling's T3.3 wants `stopped` to stay a refusal so a
  model cannot undo a user's Stop.

Recommended resolution: **R3 means the host path**, and `threadSend` keeps refusing
`stopped`; record that reading in both documents rather than letting two agents
implement opposite behaviours. If the requester means the agent path too, T3.3 of the
sibling entry is overturned and must be marked `corrected` there (README rule).

*Check:* one sentence in each document naming the same owner, and a test asserting the
chosen behaviour for a `stopped` thread.

**ANSWERED 2026-11-09 — the HOST owns stopping and reviving a stopped thread.**
R3 means the host surface (`createThread` + `sendThreadInput`, i.e. the operator's Stop
and the next host prompt), NOT the agent-facing `threadSend`: a model may not undo a
Stop the operator pressed. The sibling entry's **T3.3 is ratified, not overturned** —
`postThreadMessage` keeps throwing for `stopped` ("Thread \"...\" is stopped; it
cannot receive messages until a host resumes or deletes it"), and the sentence naming
that owner now appears in BOTH documents (here, and in the sibling entry's finding-3
status note). Test: `src/harness.thread-runtime.test.ts` ›
*a stopped thread is revived by a host only (policy 2026-11-09 T6)* — the agent message
is refused, the record stays `stopped`, nothing is appended to the transcript, and the
next HOST turn revives it to `idle`. No production behaviour changed: the code already
implemented the chosen reading, and both documents now agree on who owns it.

### T7 — Fix the discovery precondition (depends on the sibling entry)

F5 says the recovery for an unbounded child is `toolCancel`, and the sibling entry says
the model cannot find `toolCancel`. Land sibling **T1.2/T1.3** (report
conditionally-declared core tools in `alreadyAvailable`; name the cancel tool in the
`status: 'pending'` envelope) with or before T1 above. If that is blocked, say so in
this document and keep the explicit-bound recommendation in T0 visible, because an
invisible-and-uncancellable child is exactly the regression T28 was written for.

*Check:* with a delegate call pending, `toolRequest` for `"cancel"` lists `toolCancel`
under `alreadyAvailable`, **or** the pending envelope names it (sibling T1.3).

**CLOSED 2026-11-09 — `corrected`: the precondition was already satisfied.** This task
asked for sibling **T1.2/T1.3** to land with or before T1. Both had landed at
`44cdbbe`, the very revision this entry was written against; what this entry inherited
was the sibling entry's measurement of an EARLIER tree (its *Date / Method* line names
`7e9892d2`, "Upgraded Harness Configuration") together with that entry's own
`Unconfirmed` note saying the root cause was unsettled. Current source:
`declaredForDiscovery` (`src/harness.ts`, "T28: the set toolRequest reports as
`alreadyAvailable`") appends the pending-only control under exactly the condition
`offerDeclarations` declares it — excluding the asking `toolRequest` call so a query
cannot make itself cancellable — and the projection placeholder for a still-running
call says *"use toolCancel with this callId to abandon it"*. The check is satisfied on
BOTH halves: `src/harness.already-available.test.ts` › `toolCancel discovery (T28)`
(pending call → `alreadyAvailable` lists `toolCancel`, with nothing enabled and no cap
slot spent; idle caller → an honest miss) and the new
`src/harness.delegation.test.ts` › *pending delegation placeholder (delegate-stress
T1.3/T1.4)*. The engine half is pinned in `src/core/discovery.test.ts`
(reports a conditionally-declared control in both directions, sibling **T1.4**).
Consequence for this policy: an unbounded child is not the T28 regression, because the
escape hatch the policy depends on is reachable.

### T8 — Verify the wake actually covers a child (F5's untested edge)

`async-ping` keys its per-agent timer on scheduler identity
(`src/plugins/async-ping.plugin.ts:100-105`, `arm()` at `:162`, the tick calling
`api.async.wake()` at `:198`; harness emit sites around
`src/harness.ts:6077-6094`).
Confirm by live probe or test that a delegated child whose own tool call is hung gets a
wake that lets **it** (or its parent) cancel, and that a deployment with `async-ping`
disabled still has a stated recovery path.

*Check:* a written result for both configurations (plugin on / plugin off) recorded in
this file, marked `unconfirmed` if the probe was not run.

**MEASURED 2026-11-09 — both configurations, settled by test rather than by probe.**

- **Plugin on (the shipped default): the CHILD is covered.** A delegated child whose
  OWN tool call is parked receives its own wake —
  `agent: "researcher"`, `reason: "pending-tools"`,
  `pending: [{ callId: "r1", name: "hang", elapsedMs: 250 }]`, attributed to the
  child's run by `thread: { id: "2", callId: "c1" }` (the delegation call that spawned
  it) — and the child's own inspecting request declares `toolCancel`, so the wake is
  actionable for the child, not only for its parent. The plugin keys its timer on
  scheduler identity, and a delegated child IS a separate actor; that is exactly why it
  is covered rather than shared away. Test: `src/harness.delegation.test.ts` ›
  `wakes the CHILD agent while its own tool is parked and offers it toolCancel`
  (`wakeIntervalMs: 250`, so the cadence itself is asserted at 249 vs 250 ms).
- **Plugin replaced (a deployment that disables the heartbeat): no wake, no timer, and
  the child stays `running`.** Advancing three historical 600000 ms intervals produces
  zero wakeups for either actor, `vi.getTimerCount() === 0`, and the child is still
  `running`. The stated recovery in that configuration is the caller's explicit
  `toolCancel` (named in the placeholder and in the schema text) or an optional
  `timeoutMs` set up front. Test: same file,
  `leaves an unbounded child running with no wake when the ping plugin is replaced`.

Neither configuration is `unconfirmed` any more. One caveat worth carrying forward: a
deployment that pins `async-ping.intervalMs` very large behaves in practice like the
plugin-off case, which the schema text already anticipates by keeping `timeoutMs`
available to the caller.

### T9 — Housekeeping the repo rules require

- Update `docs/tasks/README.md`'s index row for this file (done when this entry was
  written).
- Mark superseded statements rather than deleting them: `README.md:1661-1665` and
  `knowledge.md:1899-1903` are `corrected` in place, and
  `2026-11-08-delegate-stress-test.md:19` and `:50` should note that the *default*
  changed while the *explicit-value* measurement stays valid.
- Keep the entry literal dependency-free: `scripts/check-package-tools.mjs:95-115`
  lists `delegate.tool.ts` in `RUNTIME_SOURCE_ENTRIES` (`:97`) and requires
  `dependencies: []`, which is exactly why the schema carries a **number literal** and
  cannot import the constant. Do not "fix" the duplication by adding an import; the
  equality pin (T5.6) is the fix.

*Check:* `npm run test:package:tools` (`package.json:101`) and
`npm run tools:manifest:check` (`:105`) both pass.

**LANDED 2026-11-09.** `docs/tasks/README.md`'s index row for this file now describes
the policy as implemented. In the sibling entry, the lines that carry the old default —
its *Scope* line listing `timeoutMs` among the controls exercised, and the `timeoutMs`
row of *Controls that work* — are annotated in place as still VALID FOR AN EXPLICIT
VALUE while the *default* they describe has changed; its finding-1 `Unconfirmed` note,
its finding-2 candidate fixes, its unresolved-ordering anomaly and its retest notes are
all settled in place there too. The other index rows were left alone (their summaries
are not materially wrong).

Verification actually run (2026-11-09, package working tree at `afb38f1` plus these
edits): `npm run tools:manifest:check` **passes** ("tool-manifest.ts is current
(30 descriptors)"). `npm run test:package:tools` reports **exactly the two failures a
pristine worktree of `afb38f1` reports with a fresh build** — `scripted model registers
and invokes a tool without a discovery round` and `all tool contexts saw one
strict-identical harness and intact state` (`0 !== 1`: the `modelProbe` capture never
happened) — so this change did not cause them, and this task does NOT claim that gate
green: it is a pre-existing failure at the base revision, disclosed rather than
smoothed over. The entry literal stayed dependency-free (`dependencies: []`), and the
duplicated ceiling is left duplicated on purpose, with the equality pin as the fix.

## What stays bounded on purpose (R4 — do not remove any of these)

**Tool clocks (the defence R1 depends on).** `COMMAND_DEFAULT_TIMEOUT_MS = 120_000`
and `COMMAND_MAX_TIMEOUT_MS = 600_000` (`src/tools/command/shell.tool.ts:142`, `:145`);
`MAX_SEARCH_MILLIS = 30_000` (`src/tools/files/grep.tool.ts:193`); the
`node:vm` cumulative 30 s matching budget (`src/tools/files/bounded-regex.ts`,
described `knowledge.md:1243-1247`); `MAX_THREAD_MATCH_MILLIS = 30_000`
(`src/tools/runtime/threadRead.ts:99`); `FETCH_TIMEOUT_MS = 15_000` and
`RESOLVE_TIMEOUT_MS = 2_000` (`src/tools/webfetch/request.ts:52`, `:339`);
`SEARCH_TIMEOUT_MS = 15_000` (`src/tools/websearch/request.ts:60`);
`DOWNLOAD_TIMEOUT_MS = 60_000` (`src/tools/webdownload/download.tool.ts:111`,
re-exported `:802`); git diagnostics `TIMEOUT_MS = 10_000`
(`src/tools/command/gitDiff.tool.ts:77`); `TASKKILL_TIMEOUT_MS = 2_000`
(`src/tools/command/processTree.ts:41`); Python probes `5_000` / `10_000`
(`src/tools/syntax/python.ts:40`, `:44`).

**Liveness, not a timeout.** `DEFAULT_WAKE_INTERVAL_MS = 600_000`
(`src/harness.ts:468`) via `async-ping` (`src/plugins/async-ping.plugin.ts:64`, `:90`).

**Count and size bounds.** `DEFAULT_MAX_ITERATIONS = 16` (`src/harness.ts:459`);
`MAX_RUN_DEPTH = 2` (`src/harness.ts:757`, enforced `:8400-8411`, delegate guard
`src/harness.ts:3506-3518`); `MAX_THREAD_RECORDS = 256` (`src/core/thread.ts:46`,
enforced `src/harness.ts:4354-4356`) and `MAX_THREAD_LABEL_CHARS = 120` (`:40`);
`branch.ts:57-67` (F2); `DEFAULT_CREATED_TOOLS_LIMIT = 32` (`src/core/creation.ts:73`,
harness option `maxCreatedTools`) — which caps runtime-created **tools only**; threads
and delegate calls do not consume it; `maxLaneWorkers` default 16 / limit 64
(`src/server/config.ts:137`, `:129`, enforced `src/server/workers/lane-host.ts:458-467`).

## Verify before starting — drift check

Run these first. A premise that fails is **not** a reason to proceed: mark that finding
`corrected` in place (keep the original text, per `docs/tasks/README.md`'s rules), then
re-scope from the surviving findings. Line numbers here **will** have drifted —
`src/harness.ts` is ~10k lines and moves constantly; the identifiers in this document
(`delegateFor`, `linkSignals`, `postThreadMessage`, `NESTED_RUN_TOOL_NAMES`) are the
durable anchors.

```bash
cd packages/underload/harness
git rev-parse --show-toplevel                     # must be .../packages/underload/harness
# (the package is its OWN git repo) — not the workspace root
git log -1 --format='%h %s'                       # written against 44cdbbe
grep -rn "DELEGATE_TIMEOUT_MS" src scripts         # expect: agent-limits.ts, core/index.ts,
                                                   # core/metadata.ts, harness.ts — and NO test hits
sed -n '29,37p' src/core/agent-limits.ts           # 300_000 still the default? still claims a test pin?
grep -n "timeoutMs" src/tools/runtime/delegate.tool.ts \
        src/core/tool-manifest.ts src/types/index.ts   # schema + generated mirror + host signature
grep -n "setTimeout" src/harness.ts                # is the delegate branch still the ONLY turn timer?
grep -n "DEFAULT_MAX_ITERATIONS\|DEFAULT_WAKE_INTERVAL_MS\|MAX_RUN_DEPTH" src/harness.ts
sed -n '1893,1905p' knowledge.md                   # "no automatic hard tool timeout" still there?
sed -n '1655,1670p' README.md
grep -n "timeoutMs\|timeout" docs/tasks/2026-11-08-delegate-stress-test.md   # sibling claims
npx vitest run src/harness.delegation.test.ts src/core/metadata.ownership.test.ts \
             src/harness.metadata.test.ts          # BASELINE must be green before any edit
npm run tools:manifest:check                        # committed manifest is current?
npm run test:package:tools                      # entry-literal / dependencies:[] contract
```

**RE-RUN 2026-11-09, before any edit, from `packages/underload/harness` at HEAD
`afb38f1` ("Updated List"):** `git rev-parse --show-toplevel` is the package (its own
repo) ✔; `DELEGATE_TIMEOUT_MS` still appears only in `core/agent-limits.ts`,
`core/index.ts`, `core/metadata.ts` and `harness.ts`, with **no test hit** ✔;
`agent-limits.ts` still carried `300_000` and still claimed a pin that did not exist ✔
(F1 accurate); `grep -n "setTimeout" src/harness.ts` returned exactly ONE arm site (the
delegation branch) plus one prose mention ✔ (the premise T5.5 needed); the schema /
manifest / host-signature `timeoutMs` rows were all where F1 said they were ✔;
`README.md`/`knowledge.md` grep for `300000`/`5 minutes` found only shell, web-tool and
task-lease values ✔ (T4.2 accurate); the BASELINE was **green** — `npx vitest run
src/harness.delegation.test.ts src/core/metadata.ownership.test.ts
src/harness.metadata.test.ts` = **3 files / 40 tests passed** ✔;
`npm run tools:manifest:check` passed ✔. Line numbers had drifted exactly as this file
warned (e.g. the timer moved from `:3591` to `:3590`, `postThreadMessage` from
`:4219`/`:4232` to `:4284`/`:4297`, `sendThreadInput` from `:4705` to `:4698`); every
edit was anchored on the identifiers instead.

**Stop-and-recheck conditions — outcome:** (1) did not fire — the constant was still
finite, so F1 stands and nothing had done the work; (2) no thread-level timeout option
appeared on `HarnessConfiguration`, `HarnessForkConfiguration` or `HarnessRunOptions`;
(3) `threadFork` still takes only `input`/`label` — no `timeoutMs`; (4) no server turn
deadline exists (`src/server/sessions.ts` still contains no `setTimeout`), so F3's
justification holds at the API edge; (5) `async-ping` is still seeded by default
(`src/harness.ts`, `'async-ping': { intervalMs: wakeIntervalMs }`), so T8 stayed
advisory — and is now closed by test anyway; (6) the manifest/package gates are
unchanged (`package.json` `test` / `test:package:tools` / `tools:manifest:check`), and
they were run before any prose was written, as instructed. ONE premise of this entry
was overturned by the re-check — F5/T7's `toolCancel` discoverability claim, marked
`corrected` where it appears.

Stop-and-recheck conditions:

1. **`DELEGATE_TIMEOUT_MS` is gone or already infinite** — R1 is partly satisfied by
   someone else. Record which commit did it, keep T2-T6 if the text/tests/docs were not
   updated, and mark F1 `corrected`.
2. **A thread-level timeout option appeared** (e.g. a `timeoutMs`/`runTimeoutMs` field
   on `HarnessConfiguration` at `src/types/index.ts:2716+`, or on
   `HarnessForkConfiguration` / `HarnessRunOptions`) — that is a direct R1 violation and
   a new finding; do not fold it into this task's scope silently.
3. **`threadFork` gained a `timeoutMs`** (`src/tools/runtime/threadFork.tool.ts:19-39`) —
   same, F2 flips.
4. **A server turn deadline now exists** (grep `src/server` for `AbortSignal.timeout`,
   `RUN_.*_MS`, `setTimeout` in `src/server/sessions.ts`) — F3's "no turn deadline"
   claim is what justifies unbounded threads at the API edge, so it must be re-verified
   before shipping, not after.
5. **`async-ping` is no longer seeded by default** (`src/harness.ts:1161-1167`) —
   T8 becomes blocking rather than advisory.
6. **The manifest/package gates changed** (`package.json:96`, `:101`, `:104-105`;
   `scripts/check-package-tools.mjs:95-115`) — T3 and T9's commands are the ones that
   break first, so run them before writing any prose.

## Not tested

- **No live session was run for this entry.** Everything is read from source and from
  the sibling entry's measurements. In particular the never-resolving-callable risk
  (T0) is inferred from `knowledge.md:1893-1895`, not observed.

  **PARTLY SUPERSEDED 2026-11-09:** still no LIVE session, but the risk is now
  measured rather than inferred — `src/harness.delegation.test.ts` and
  `src/harness.fork.test.ts` / `src/harness.thread-runtime.test.ts` hold the caller
  pinned in `probe()` state while the clock is advanced minutes past the old default,
  proving the promise does hang and that nothing else ends it. What remains genuinely
  unobserved is a real provider stream (below) and a real model's behaviour under the
  new schema text.
- **Whether the wake reaches the child**, and what happens with `async-ping` disabled —
  F5, T8. Unconfirmed.

  **CLOSED 2026-11-09: confirmed for both configurations by test** — see the dated
  result at T8.
- **Whether `toolCancel` is discoverable while a delegate is pending** — inherited from
  the sibling entry's own `Unconfirmed` note
  (`2026-11-08-delegate-stress-test.md:105-110`), not re-settled here.

  **CLOSED 2026-11-09 — settled, and the inheritance was stale:** it IS discoverable
  (alreadyAvailable + the placeholder note), which had already landed at `44cdbbe`; the
  sibling entry has updated its own `Unconfirmed` note in place.
- **Behaviour of an unbounded child under `threadExecution: 'worker'`** — nested runs are
  refused there (`src/server/workers/capability.ts:342`), so the case may be
  unreachable; not probed.
- **Interaction with a real provider stream that stalls for hours** (no `done` frame,
  no error): the thread would wait forever with no clock. R1 says that is correct;
  nobody has measured what a 3-hour stalled stream does to the frontend's 45 s
  heartbeat reconnect loop plus replay.
- **Fan-out with unbounded children.** The sibling entry saw 12 concurrent children all
  complete with no cap and roughly linear latency
  (`2026-11-08-delegate-stress-test.md:57-60`, `:375-377`). Whether the removed 5-minute
  default was masking stragglers in that latency figure is unknown.
- **`paused` and `stopped` revival paths under load** — F4 is source-only, and the
  sibling entry also never observed `paused` live
  (`2026-11-08-delegate-stress-test.md:385-387`).

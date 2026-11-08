# Delegate stress test

Status: **closed 2026-11-09 — findings 1–3 are all CLOSED (finding 1's fix had already
landed at `44cdbbe`; finding 2's scope escape-hatch and finding 3's state-aware
`threadSend` landed in the working tree the same day), and the cancelled-result ordering
anomaly is SETTLED as a display artefact, not a defect. What remains of this entry is
observational: the fan-out rows (n ≤ 12, local model, roughly linear latency, delivery
as a race) are environment-dependent OBSERVATIONS about a live session, not package
claims, and they are marked as such where they appear.** Written for a reviewer who did not run the test and who will
re-run it. Every claim carries either a transcript observation or a `path:line`
reference; claims that were not settled are labelled rather than smoothed over.

## Date / Method / Scope

**Date:** 2026-11-08. Source under test: `7e9892d2` ("Upgraded Harness
Configuration"), working tree dirty.

**STATUS 2026-11-09 — finding 1 and finding 2 are CLOSED (finding 1's fix had already
landed at `44cdbbe`; finding 2's candidate fix landed in the working tree on
2026-11-09). The ordering anomaly is SETTLED as a display artefact. Finding 3
(`threadSend` state-awareness) is the only work still open, and its T3.3 — keep
`stopped` a refusal — is ratified: the HOST owns stopping and reviving a stopped
thread, an agent message never does (see
[2026-11-09-thread-timeout-policy.md](./2026-11-09-thread-timeout-policy.md) T6).**
**LANDED THE SAME DAY — finding 3 is CLOSED. T3.1–T3.6 are all in the working tree
(see the per-task notes under *For finding 3*); the merge lives in the runtime, in
`postThreadMessage`, and the running branch the retest notes called load-bearing is
now test-verified rather than read from source.**
Re-anchored against `afb38f1`; every `path:line` in this file had drifted, so the
identifiers (`postThreadMessage`, `declaredForDiscovery`, `offerDeclarations`,
`deliverTask`, `scheduler.cancel`) are the citations that held.

**Date:** 2026-11-08. Source under test: `7e9892d2` ("Upgraded Harness
Configuration"), working tree dirty.

**Method:** 28 delegations issued from a live `instruct` primary session in six
stages — 1 baseline, 2 parallel, 4 control-surface probes, a 6-delegate burst, a
12-delegate burst, and a steering probe. Each claim was checked against the
running harness (`agentManage`, `agentResult`, `threadRead`, `threadList`,
`shell`) and then against source. No claim rests on documentation alone.

**Scope:** the `delegate` control surface (`scope`, `maxChars`, `timeoutMs`,
`requireClarification`), `toolCancel`, `threadSend` as mid-run steering, and
fan-out behaviour. Agents used: `research`, `workspace`, `reviewer`, `planner`,
`summarizer`.

**CORRECTED 2026-11-09 — one word of this scope changed after the measurements were
taken.** `timeoutMs` is still the control measured below, but its DEFAULT is no longer
finite: the delegation policy entry made an omitted `timeoutMs` mean "no time limit",
so every row in *Controls that work* that supplied an explicit value (the 1200 ms
`timeoutMs` measurement) remains valid as measured, and any inference about what
happens when the caller passes NOTHING must be re-derived. See that entry's T1.

**How to reproduce.** All three findings are behavioural, so they need a live
session rather than a unit test:

1. **Finding 1** — issue any `delegate`, note the `callId` from the `pending`
   envelope, then call `toolRequest` for `toolCancel` three ways: exact name,
   `regex: "cancel"`, and `tags: ["cancel"]`. Expect `matched: 0` in all three,
   and expect `toolCancel` to be absent from `alreadyAvailable`. Then call
   `toolCancel` by name with that `callId` and expect it to succeed.
   **CORRECTED 2026-11-09 — the first two expectations above are now the OPPOSITE, and
   that is the fix.** Re-run: `matched` is still 0 (it is not a catalogue candidate), but
   `alreadyAvailable` now lists `toolCancel` for the regex and tag queries while the call
   is in flight, the `pending` envelope itself names `toolCancel` beside the `callId`, and
   the by-name cancel still succeeds. Unit equivalent: the two tests named under T1.2/T1.3.
2. **Finding 2** — `delegate` to `workspace` with
   `scope: { tools: ["read", "glob"] }` and a brief that requires a write.
   Expect no answer and a child that loops on `glob`; confirm with
   `threadRead` on the child's `threadId`.
   **CORRECTED 2026-11-09 — the loop is gone.** `toolRequest` is now declared to a
   scoped child whatever the allowlist says, so the same probe answers
   "the capability I need is not available" (or fails on the readable scope refusal)
   instead of spinning. Re-run expectation: the child calls `toolRequest`, gets a real
   result, and terminates on its own. Unit equivalent: T2.1's check.
3. **Finding 3** — `delegate` a long-running task, wait until
   `threadList` reports the child **idle** (not running), then `threadSend` into
   it. Expect `delivered: "appended"` and no new run. See *Retest notes* — the
   running branch is the one that was never actually exercised.
   **CORRECTED 2026-11-09 — with T3.2 landed this expectation is the OPPOSITE, and
   that is the fix.** Re-run: the idle child answers `delivered: "started"` and a run
   IS under way, while the send itself has already returned (the receipt never waits
   for the answer), and `threadList` now shows that child `running`. The running
   branch — still never exercised live, because a real child settles faster than a
   model can notice it — is pinned by unit test instead:
   `src/harness.thread-runtime.test.ts` › *steers a genuinely running conversation
   and its next turn reflects the message (T3.1)*.

---

## Controls that work (verified, for contrast)

Recorded because two of the findings are about what is *missing*, and a reviewer
needs the baseline to tell a defect from normal behaviour.

| Control | Verdict | Evidence |
|---|---|---|
| `timeoutMs` | enforced precisely | 1200 ms budget → `durationMs: 1209`, `status: "cancelled"`, explicit error text |
| `timeoutMs` | enforced precisely **(explicit value only — the default changed on 2026-11-09; see the correction above the *Scope* line)** | 1200 ms budget → `durationMs: 1209`, `status: "cancelled"`, explicit error text |
| `requireClarification` | real pre-flight gate | `"Improve things around here"` rejected **before the child ran**; consumed no invocation |
| `scope` | enforced | scoped `workspace` could not write; `/tmp/instruct_stress_scope_probe.txt` absent afterwards (`ls` exit 2) |
| `maxChars` | pages losslessly | 600-char page of a 4691-char answer; `agentResult` recovered all 120 items, no loss |
| `toolCancel` | real mid-flight kill | cancelled record carried `partialContent` and `cancelledAtMessage: 45` |
| fan-out 1 / 6 / 12 | all delivered | distinct `invocationId` + `threadId` per child, all owned by the caller |

**Fan-out latency** grew roughly linearly — ~3.7 s at n=1 to 3.7–18.9 s at n=12
— so child runs are bounded/queued rather than free. One agent can hold several
live runs at once (`workspace` invocations 5 and 9 overlapped). No cap was
reached at 12.

**Delivery is a race, not a rule.** A no-I/O child returned its result inline in
one stage and returned `pending` placeholders in the next, at near-identical
duration (3.7 s vs 3.8 s). Do not rely on either path.

---

## Findings

### 1. `toolCancel` is callable but undiscoverable

**CORRECTED 2026-11-09 — CLOSED. The behaviour described below is what `7e9892d2` did;
current source fixes both halves, and neither half needs new code.** `declaredForDiscovery`
in `src/harness.ts` ("T28: the set toolRequest reports as `alreadyAvailable`") appends
the pending-only control to the set discovery reads, under exactly the condition
`offerDeclarations` uses to declare it, and it excludes the asking `toolRequest` call so
a query can never make itself cancellable; the placeholder the model receives while a
call runs says *"use toolCancel with this callId to abandon it"*. The `Unconfirmed` note
below is answered by the same code. Tests:
`src/harness.already-available.test.ts` › `toolCancel discovery (T28)`,
`src/core/discovery.test.ts` › *reports a conditionally-declared control in both
directions*, and `src/harness.delegation.test.ts` › *pending delegation placeholder
(delegate-stress T1.3/T1.4)*. Everything below stays as filed because the reasoning is
the reason the fix is shaped this way (a report, not a grant: nothing is enabled and no
cap slot is spent).

### 1. `toolCancel` is callable but undiscoverable

`delegate`'s own description instructs the model to "use toolCancel with that
callId to abandon" a pending child. The tool exists and works — it cancelled
live delegate calls three times during this run — but `toolRequest` cannot find
it. It returned `matched: 0, omitted: 0` for `toolCancel` queried by exact name,
by regex, and by the `cancel`/`agents`/`threads` tags, and it was absent from the
`alreadyAvailable` list even while delegate calls were genuinely pending.

The call still succeeds when issued by name:

```
toolCancel { callId: "call_faf694d8e322443cbfc37239" }
  -> { cancelled: true, name: "delegate" }
```

**Why it is the way it is.** Two rules combine:

- `toolCancel` is `visibility: 'core'`
  (`src/tools/runtime/toolCancel.tool.ts:31`), and core tools are never
  catalogue candidates — `src/core/discovery.ts:264` filters the catalogue to
  `visibility === 'searchable'`, and `src/core/discovery.ts:578` skips any
  non-searchable tool during selection. The stated reason
  (`src/core/discovery.ts:42`) is that core tools are already declared, so
  returning them would waste the model's turn.
- `alreadyAvailable` is built only from the caller's *declared* core set
  (`src/core/discovery.ts:315`, `:650`), and `toolCancel` is declared
  conditionally — "ONLY while that agent actually has calls in flight"
  (`src/tools/runtime/toolCancel.tool.ts:9-12`).

So the tool is invisible to discovery in exactly the window where `delegate`
tells the model to go looking for it. A model that has never seen the name has
no path to it: `toolRequest` reports the capability as absent, and the guidance
is to conclude it is unavailable.

**Unconfirmed:** whether the conditional declaration was in fact active at the
moment of the query, or whether the `declared` set handed to `toolRequest`
merely omits conditionally-declared controls. Both produce the observed
`matched: 0`; distinguishing them needs a probe that inspects the declared list
while a call is in flight. This is the single most important thing for a
retester to settle, because T1.2 is only the right fix under the second reading.

**SETTLED 2026-11-09 — the SECOND reading was the real one, and T1.2 was therefore the
right fix.** A pending-only control is declared to the model by `offerDeclarations`
whenever `scheduler.pending(run.actorKey).length > 0`, but the set handed to
`toolRequest` was built by `visibleCoreTools`, which SKIPS every `pendingOnly`
definition (`if (pendingOnlyDefinitions.has(definition)) continue;`) — so the tool was
declared on the very request that asked, and discovery still reported it absent. That is
also why the answer is a REPORT and not a catalogue entry: `declaredForDiscovery` adds
the control only for the actor that has work in flight, so `enabled` stays empty, no
`maxEnabledTools` slot is spent, and an idle caller keeps getting an honest miss. The
probe that settles it is the test, not a live session: *reports toolCancel while a call
is pending, and not while the query itself is the only work*.

### 2. `scope` gates `toolRequest`, which livelocks a restricted child

**CLOSED 2026-11-09 — the first candidate below is the one that landed** (as task
**T2.1** under *Tasks*). The second candidate — refusing the delegation up front when
`scope` omits `toolRequest` while the agent's prompt depends on it — was rejected: a
child's prompt dependency is not knowable at dispatch, the refusal would punish callers
whose brief happens to name a tool, and an escape hatch is cheaper than a new error.
The restriction itself is unchanged and still correct: the allowlist bounds what the
child can DO, and a tool the allowlist omits is still refused at launch with the
readable `is outside this run's scope` result the finding says was missing.

### 2. `scope` gates `toolRequest`, which livelocks a restricted child

`scope.tools` is a hard allowlist, and it applies to `toolRequest` itself. A
child that correctly identifies a missing capability therefore has no way to
request it, and no clean denial to fail on.

Observed with `scope: { tools: ["read", "glob"] }` on `workspace`, briefed to
write one file and report whether the write was allowed or denied:

- The child never wrote and never answered. It ran **45 messages over 132 s**
  before being cancelled, emitting `glob` calls in a loop while narrating the
  opposite intent — `"I've been looping on glob calls by mistake — let me now
  actually attempt the write"` followed by another `glob`.
- `scope: { tools: [] }` on `research` was worse: **zero** messages produced,
  no tool call, no answer, hung until cancelled.

Enforcement itself is correct and was verified independently — the probe file
`/tmp/instruct_stress_scope_probe.txt` did not exist after the run (`ls` exit 2),
so the child could not have written.

**Why it is the way it is.** `scope` is built as a genuine restriction: the child
"neither sees nor can call anything outside" the allowlist, so a read-only review
is read-only by construction rather than by instruction. The defect is not the
restriction but the absence of an exit: a scoped child that needs a tool outside
its scope spins instead of failing, and the caller sees only a `running` record
until it notices and kills it. Note the child's own system prompt *instructs* it
to "call toolRequest … before concluding that something cannot be done" — which
is exactly the instruction that cannot be honoured under a restrictive scope.

No tasks were written for this finding (the request covered 1 and 3), but the
obvious candidates are: always allow `toolRequest` through `scope`, or refuse the
delegation up front when `scope` omits it while the agent's prompt depends on it.

**TASK NOW FILED (2026-11-09): T2.1, below, and it has landed.**

### 3. `threadSend` cannot wake a thread that is not already running

**CLOSED 2026-11-09 — T3.1–T3.6 LANDED (the notes are under *For finding 3* in
*Tasks*).** The behaviour described below is what the code did. `postThreadMessage`
now steers a running target, STARTS a run in a dormant one (idle, or a park it lifts
through the host's own resume path), still refuses a `stopped` one, and the receipt
says which of the two live outcomes happened (`queued` / `started`). The body stays as
filed because its reading of the three primitives is the reason the fix is shaped the
way it is — the merge is the TOOL, not the handle methods.

**Corrected (first draft).** The first draft claimed `threadSend` was "a queued
follow-up turn, not control," based on steering a `reviewer` child mid-count:
the message was accepted (`delivered: "appended"`) and the answer was unaffected
— it still ended `REACHED: 120` rather than the requested 30. That test was
invalid. `delivered: "appended"` is the **idle** branch — `postThreadMessage`
reports `'queued'` only while the target is running (`src/harness.ts:4227`) — so
the child had already finished and the message could not have changed its answer.

**What the running path actually does.** Read from source: it interrupts, and it
is the same mechanism the host steer uses.

- `threadSend` while running → `target.queue.push` + `markRunDirty(target.run)`
  (`src/harness.ts:4245-4247`).
- `steerThread` → `state.queue.push` + `markRunDirty(state.run)`
  (`src/harness.ts:4624-4628`).
- Both queues are drained by one function, `drainThreadQueue`
  (`src/harness.ts:7664`), called at `src/harness.ts:7732` — *before* the next
  request is built, so the model sees the guidance "on the very next turn
  instead of one round late" — and again at `src/harness.ts:7862`.

**Caveat: this branch was never observed running.** It is asserted from source
only. See T3.1 and *Retest notes*.

**VERIFIED 2026-11-09 — by test, which is what T3.1 asked for, and the source reading
was right.** `src/harness.thread-runtime.test.ts` › *steers a genuinely running
conversation and its next turn reflects the message (T3.1)* holds the target's first
answer behind a gate so the run is provably in flight when the send lands, and asserts
the child's NEXT ANSWER restates the steered text. An inert append cannot produce that
output, so the interrupt is settled, and the finding does not regrow into the larger
first-draft claim.

The gap is the other states:

- **Idle.** Falls through to `target.agent.user(content)`
  (`src/harness.ts:4253`) and returns. Nothing runs; the text waits for some
  unrelated turn to read it. `steerThread` at least refuses honestly —
  `Thread "…" is idle; use sendThreadInput to start a turn`
  (`src/harness.ts:4616-4622`) — but `threadSend` reports the bare word
  `appended`, which reads as delivered and does the least of the three paths.
- **Paused.** Only `stopped` throws (`src/harness.ts:4232-4236`), so `paused`
  takes the same inert append and nothing wakes it. `paused` is a real runtime
  state (`src/types/index.ts:2153`) that only `sendThreadInput` clears
  (`src/harness.ts:4657-4658`).

**The asymmetry the host does not have.** A user "Continue" on a thread is a
host turn through `sendThreadInput`, which revives `stopped`
(`src/harness.ts:4647-4650`) and resumes `paused` before calling `runAgent`
(`src/harness.ts:4661`). `threadSend` — the agent-facing equivalent — never
starts a run at all. An agent can interrupt a running peer but cannot resume a
dormant one.

#### Update: `steerThread` / `sendThreadInput` / `threadSend` are not aliases

Raised in review as "these three look like aliases of one `threadSend`." They are
not — they return different things and only two of them are worker-safe:

| | `steerThread` | `sendThreadInput` | `threadSend` (tool) |
|---|---|---|---|
| Returns | `HarnessThreadSteerReceipt` `{ threadId, queued, reason? }` (`src/types/index.ts:2192-2196`) | `Promise<HarnessAssistantMessage>` — **the answer itself** (`src/harness.nested-runs.test.ts:226`) | `HarnessThreadMessageResult` `{ threadId, delivered, sender, senderThreadId? }` (`src/types/index.ts:2211-2221`) |
| Blocking | no | **yes — awaits the whole run** | no |
| Starts a run | no | yes (`src/harness.ts:4661`) | no |
| Payload | text only (`src/server/sessions.ts:6679`) | text + attachments | text only |
| Worker mode | routed | **refused** — nested-run door (`src/server/workers/capability.ts:244`, `:531`) | **routed to the authority** (`src/server/workers/capability.ts:187`, `:205`, `:340`) |

The last row is the binding constraint. `sendThreadInput` starts a child
conversation, so a lane worker refuses it (`NESTED_RUN_ARMED_DOORS`,
`src/server/workers/capability.ts:531`); `threadSend` is deliberately outside
that set because it only posts text and routes to the coordinator
(`src/server/workers/capability.ts:340`). **A merged `threadSend` that awaited
the answer would stop being a chat primitive and become a nested run — it would
have to be removed from the replica at hello, exactly like `delegate` and
`threadFork`.**

#### Update: the merge already exists — at the server layer

The proposed behaviour (interrupt if running, otherwise start a turn) is already
the product's behaviour for a human. `steerIntoThread`
(`src/server/sessions.ts:6654`) tries `steerThread`, and when the thread is not
running it returns `undefined` (`src/server/sessions.ts:6671-6672`) so the
caller enqueues a continuation turn instead — documented at
`src/server/sessions.ts:102`: "A submit to a RUNNING thread is STEERED … no
duplicate turn is recorded." A user pressing send gets one state-aware
operation; a model gets three primitives and has to pick. The semantics are
proven in production — they just live in the HTTP layer, so only the server
benefits.

---

## Unresolved anomaly — ordering of a cancelled tool result

Two Stage-3 `delegate` calls reported
`Tool call "delegate" (<id>) was cancelled before it completed; no result is available.`
at a point when **no `toolCancel` had yet been issued** for them. Issuing
`toolCancel` for one of them afterwards returned
`{ cancelled: true, name: "delegate" }` with **no `alreadySettled` flag** — which
per `src/harness.ts:6181-6198` means the task was still `pending` at that moment.
Those two statements appear to contradict each other.

Two candidate explanations, neither confirmed:

1. **Display ordering, not real ordering.** `src/harness.ts:6207-6210` states
   that "delivery of the cancelled result is queued on the mailbox." The
   cancellation text may have surfaced in a later turn while being rendered
   grouped with the original batch, making it look pre-cancellation.
2. **Something else cancelled them first**, and the later `toolCancel` re-found
   a still-pending task — which would need a second task or a re-scheduled one.

Searched for and ruled out: a delegation concurrency cap that auto-cancels
excess children. No such limit exists in `src/harness.ts` (searched
`MAX_CONCURRENT`, `concurrency`, `slots`), and the only `scheduler.cancel` call
site is the `toolCancel` handler itself (`src/harness.ts:6212`).

**This is not a finding and no task is filed against it.** It is recorded so a
retester can settle it; if explanation 1 holds, it is a display artefact of this
harness rather than a defect.

**SETTLED 2026-11-09 — explanation 1, a display-ordering artefact. Not a defect, and no
code change.** The mechanism is in current source and it produces exactly the observed
shape: `toolCancel` removes the task and acknowledges with
`{ cancelled: true, callId, name }` **immediately**
(`src/harness.ts`, the toolCancel handler — "Remove it before acknowledging, so the
acknowledgement's own `pending` list is already accurate. Delivery of the cancelled
result is queued on the mailbox"), and only LATER does the delivery path write
`Tool call "delegate" (<id>) was cancelled before it completed; no result is available.`
(`task.status === 'cancelled'` in the delivery function, classified `outcome:
'cancelled'`). So the two statements are not contradictory: the "was cancelled" text is
a QUEUED DELIVERY of a call whose cancellation had been accepted, and a re-issue of
`toolCancel` before that delivery ran still found the task pending — hence
`{ cancelled: true }` with no `alreadySettled` flag, which is the
`alreadySettled: true` branch at the toolCancel handler not yet being reachable. A
transcript rendering that groups a turn's tool results by call position therefore shows
the cancellation prose beside the original batch, earlier than the moment it happened.
Explanation 2 is ruled out by the same reading: nothing else calls `scheduler.cancel`,
and there is no delegation concurrency cap (the searches this entry ran are unchanged).
Reproducer if a future reviewer wants it: a live batch of delegations, cancelled while
the parent's next turn is already built.

---

## Tasks

### For finding 1 — make `toolCancel` reachable

**T1.1 — Decide the intended visibility contract, then record it.** Either
`toolCancel` is expected to be discoverable, or it is not. Today `delegate`
instructs the model to use a tool that discovery reports as absent, so the two
descriptions disagree regardless of which way the decision goes.
*Check:* `delegate`'s description and `toolRequest`'s output agree in the
pending-call window — either both offer `toolCancel`, or `delegate` stops
naming a tool discovery will not surface.

**LANDED — the contract decided is: DISCOVERABLE, while actionable.** `delegate` keeps
naming `toolCancel`, and `toolRequest` now surfaces it in exactly the same window, so
the two descriptions agree instead of contradicting each other. Written down where both
audiences read it: the `alreadyAvailable` row of the discovery table in `README.md`
(names `toolCancel` as the conditionally-declared case), the `toolCancel` entry
description itself (it already addresses the model "while calls are in flight"), and the
new *Delegation* bullet in `knowledge.md`.

**T1.2 — Report conditionally-declared core tools in `alreadyAvailable`.**
`alreadyAvailable` is assembled from the caller's declared core set
(`src/core/discovery.ts:315`, `:650`). Confirm whether the conditional
declaration of `toolCancel` reaches that set while a background call is in
flight; if it does not, include it. This is the smallest fix and keeps
`toolCancel` out of the searchable catalogue. **Depends on settling the
Unconfirmed note above** — if the declared set already contains `toolCancel`
while a call is pending, the bug is elsewhere and this task is wrong.
*Check:* with a delegate call pending, `toolRequest` for `"cancel"` — by name,
regex, or tag — lists `toolCancel` under `alreadyAvailable`.

**LANDED (at `44cdbbe`, before this task was filed) — and pinned.**
`declaredForDiscovery` + `requestToolsFor` are the mechanism;
`src/harness.already-available.test.ts` › `toolCancel discovery (T28)` is the check,
including the negative half (no enablement, no cap slot, and no report when the asking
`toolRequest` call is the only thing pending). The engine-level half — the declared set
is authoritative in both directions — is now pinned in `src/core/discovery.test.ts`.

**T1.3 — Add a pending-call hint to the placeholder.** The `pending` envelope
carries a `callId` but does not name the tool that cancels it. Naming it at the
moment the model holds a `callId` removes the discovery dependency entirely, and
works regardless of how T1.1 and T1.2 resolve.
*Check:* the `status: "pending"` result states the cancellation tool by name.

**LANDED (at `44cdbbe`) — and now pinned by a delegation test.** The projection that
answers an unsettled call (`src/harness.ts`, the pending-placeholder block that builds
`{ status: "pending", callId, name, elapsedMs, note }`) carries the note *"This tool
call is still running in the background. Its real result arrives in a later turn; use
toolCancel with this callId to abandon it."* Pinned by `src/harness.delegation.test.ts`
› `advertises toolCancel beside the callId while the child is still running`, which
asserts every contract field exactly (`{ status: 'pending', callId: 'c1', name:
'delegate', elapsedMs: 0 }`) and asserts the note names the control — the wording itself
stays out of the published contract, as `src/harness.inclusion.test.ts` already decided.

**T1.4 — Test it.** Extend `src/core/discovery.test.ts` (which already pins
that a core tool is never a candidate, `:182`) with the conditional-declaration
case, and add a delegation test asserting the pending envelope advertises its
own control.
*Check:* both tests fail against current source and pass after T1.2/T1.3.

**LANDED 2026-11-09, adjusted to what the code already was.** The *fail against current
source* clause of this check could not be met: T1.2/T1.3 were already current source, so
the two tests added are REDUNDANCY pins rather than red-then-green proofs —
(1) `src/core/discovery.test.ts` › *reports a conditionally-declared control in both
directions (delegate-stress T1.2)*, next to the existing "a core tool is never a
candidate" pin, asserting that a declared pending-only control is reported and an
undeclared one is a genuine miss, and that mere catalogue presence never makes it
selectable; (2) the delegation placeholder test under T1.3. `src/harness.already-
available.test.ts` already covered the harness-level behaviour and was left untouched.
All three files are green; the only tests that went RED first were the ones for finding
2, whose fix is new.

### For finding 3 — one `threadSend` that does the right thing per state
### For finding 2 — the scope must not be able to lock its own exit

**T2.1 — Always let `toolRequest` through `scope.tools`. LANDED 2026-11-09.**
The escape hatch was scope-blockable, which is what turned a missing capability into a
livelock instead of an answer. `src/harness.ts` now has ONE named predicate,
`isScopeEscapeHatch(name)`, read by BOTH halves of the gate — the declaration filter in
`declared()` (so a scoped child SEES `toolRequest`, `scope: { tools: [] }` included) and
the launch gate in `launchToolCall` (so it can CALL it). The exemption is by wire NAME,
deliberately, not by a marker on the resolved definition: what must stay reachable is
the name the model was told to use, and a host that replaces the entry under that name
replaces the hatch, not the rule. Everything else keeps both halves of the restriction.

*Check:* `src/harness.delegation.test.ts` › *lets a scoped child call toolRequest, the
one tool the allowlist cannot block* — a child scoped to `["read","glob"]` is declared
`["toolRequest","read","glob"]`, its `toolRequest {"names":["write"]}` call ANSWERS
(`{ enabled: ["write"], tools: [write], matched: 1, omitted: 0 }`, no scope refusal), and
the child still returns its own answer; the sibling tests pin that `task` is still
filtered out, that an empty allowlist declares ONLY the door, and that a guessed
capability call is still refused with `is outside this run's scope`. Schema text
updated in the same commit: `delegate`'s `scope`/`scope.tools` descriptions now say the
discovery door is never restricted (regenerated manifest included).

**Known limitation, deliberately not fixed here (reported, not silently expanded):**
`alreadyAvailable` and `enabled` are computed from the actor's core view WITHOUT the
run's `toolScope`, so a scoped child that enables a tool outside its allowlist is
enabled-but-still-refused at launch. The livelock is gone (the child gets a real answer
and a clean denial), but a follow-up could make the discovery answer scope-aware so it
cannot offer a capability the scope forbids.

### For finding 3 — one `threadSend` that does the right thing per state

**T3.1 — Pin the running-path interrupt before touching anything.** The path at
`src/harness.ts:4245-4247` is asserted from source but was never observed: the
only live attempt landed after the child had already finished, and that misread
produced the wrong first-draft conclusion. Add a test that sends into a
genuinely running child and asserts the child's answer reflects the message.
*Check:* a test in `src/harness.thread-runtime.test.ts` that fails if the
message is appended instead of drained into the live run.

**LANDED 2026-11-09 — `src/harness.thread-runtime.test.ts` › *threadSend is
state-aware (delegate-stress T3.1–T3.6) › steers a genuinely running conversation and
its next turn reflects the message (T3.1)*.** The two host threads of one agent run at
once, so the target's first answer is held behind a gate (`heldAnswer`) and the
sender's own model turn issues the tool call and COMPLETES while the target is still
in flight — the send is provably non-blocking and the target is provably running
(`requests: 1`, record `running`, transcript still one message deep). After the gate
opens, the assertion is the answer itself: the transcript is exactly the four messages
`count to 120` → `REACHED: 120` → the attributed steer → `last instruction: from agent
"writer" (thread thread-1):\ncount to 30, not 120`, and the second request's message
list is asserted complete. Appending instead of draining fails both halves. The
sibling test that already pinned the boundary ordering (*queues a chat message into a
running thread at its next boundary*) is untouched.

**T3.2 — Make `threadSend` state-aware: steer while running, start a turn
otherwise.** This is the merge. Move the logic the server already runs at
`src/server/sessions.ts:6671-6672` down into `postThreadMessage`
(`src/harness.ts:4219`) so the runtime, not the HTTP layer, owns the decision.
Keep it **non-blocking**: on idle/paused it starts a run and returns a receipt;
it must not await the answer.
*Check:* one send into a running thread interrupts it; one send into an idle or
paused thread causes a run to start; neither call blocks the sender.

**LANDED 2026-11-09 — `postThreadMessage` (src/harness.ts) is the state-aware façade;
`src/server/sessions.ts` did not move and did not change.** The runtime now decides per
status, in this order: `stopped` throws FIRST and mutates nothing (T3.3); `paused` is
lifted by the SAME `resumeThreadState` call `sendThreadInput` makes, so
`thread.resumed` fires for the plugin that parked it and no second revival path
exists; a target that is `running` with a run attached takes the existing
queue-and-`markRunDirty` path (drained by `drainThreadQueue` before the next request is
built); anything dormant (idle, or a park whose run had already ended) is STARTED —
`runAgent(target.agent, content, …, target)`, the same positional call `sendThreadInput`
makes, minus the await. The message is not appended by the send: it IS the run's root
prompt, so one delivered message is still one transcript entry.

Three choices are load-bearing and are commented at the call site. **No `parent`**: a
parent would put the sender's brain in the lineage, and the common case — two threads of
the SAME agent talking to each other — would then be refused as a "delegation cycle".
**No `signal`**: the sender's cancellation must not abort a conversation it only spoke
to. **No await**: the receipt returns first and the run is caught
(`void runAgent(…).catch(…)`) purely so a fire-and-forget rejection is not unhandled —
the failure itself is not swallowed, because `runAgent` emits `run.failed`, archives the
error through `finishInvocation` (so `agentResult` can name it), and returns the thread
to `idle` in its `finally`.

*Check*, met by three tests in
`src/harness.thread-runtime.test.ts` › *threadSend is state-aware (delegate-stress
T3.1–T3.6)*: the running branch (T3.1, above) returns while the target's request is
still gated; the idle branch (*starts a run in an idle conversation and returns before
the answer exists (T3.2, T3.6)*) resolves the receipt with the provider reached and the
record `running`, then asserts the settled transcript is prompt-plus-answer; and the
parked branch (*lifts a plugin park and starts a turn in the parked conversation
(T3.2)*) reaches a real `paused` record — a `turn.before` hook parks it and never
resumes, the state the *Not tested* list said nothing had ever exercised — observes
`['resumed:idle']`, and starts the next turn.

**Known limitation, deliberately not fixed here (reported, not silently expanded):** a
dormant start at the AUTHORITY, which is where worker mode routes `threadSend`, runs a
conversation the server never opened. Two consequences follow, and the merge is what
makes them reachable — `src/server/sessions.ts`'s delete guard already anticipated one
("a `threadSend` revived without a server turn"):
1. a focused submit into that conversation while it is live takes `steerIntoThread`,
   which queues the guidance and THEN throws 409 "…is running but no recorded turn owns
   it" (`owningTurnOf` finds nothing, because an unowned host thread has no owner chain
   to walk) — so the steer lands while the caller is refused. `lane-worker-correctness.
   test.ts` › *picks up a message another lane sent while this conversation was idle
   (T10 M4)* now waits for the detached turn via its `waitAuthorityIdle` helper rather
   than depending on that race; the 409 itself is a server-layer question (should a
   turn-less run get an audit record?) and is filed here, not answered.
2. `lane-host.ts` notifies `notifyTranscriptMoved` once, when the routed reply is
   posted, so the owner lane of that conversation is not told about the later appends
   the authority's own run makes. The next commit's prefix guard is what keeps that
   safe (a stale append is refused, never overwritten); a push per append is the
   follow-up.

**T3.3 — Keep `stopped` a refusal.** Auto-restart should cover idle and paused,
not stopped. "Stopped must mean stopped for agents"
(`src/harness.ts:4645-4646`, enforced for this tool at `:4232-4236`) is
deliberate: reviving a conversation the host stopped is a host decision, and
`threadSend` is not the host. Folding stopped into the merge would silently undo
a user's Stop.
*Check:* `src/harness.ts:4232-4236` still throws for `stopped`, and a test
asserts a stopped child is not revived by an agent's message.

**RATIFIED 2026-11-09 — and the test exists.** The policy entry for thread time limits
decided the conflict the same way (its T6): **the HOST owns stopping and reviving**;
`sendThreadInput` is R3's "new prompt", `threadSend` is not the host. The check's second
half is now pinned by `src/harness.thread-runtime.test.ts` ›
*a stopped thread is revived by a host only (policy 2026-11-09 T6)*: the agent message
throws, the record stays `stopped`, nothing is appended, and the following HOST turn
revives it. If T3.2 lands, it must not widen this refusal to `stopped`.

**T3.2 LANDED without widening it.** The `stopped` throw is the FIRST statement of
`postThreadMessage`, before the park is lifted, before any text is built, and before
any run could be started, so a stopped record cannot be reached by the auto-restart.
The model-driven shape the finding is actually about is now pinned as well (the T6
test above exercises the manual host door): `src/harness.thread-runtime.test.ts` ›
*threadSend is state-aware (delegate-stress T3.1–T3.6) › leaves a stopped conversation
untouched when a model sends into it (T3.3)* has a LIVE run issue the tool, read the
refusal back as its own tool result — `Tool "threadSend" failed: Thread "thread-2" is
stopped; it cannot receive messages until a host resumes or deletes it.` — and then
asserts the target's record equals `{ id, agent, origin: 'host', status: 'stopped',
sequence: 3 }` with an empty transcript. No revival, no queued guidance, no text.

**T3.4 — Prove the merged tool survives worker mode.** The non-blocking rule in
T3.2 is what keeps `threadSend` out of `NESTED_RUN_ARMED_DOORS`
(`src/server/workers/capability.ts:531`). A merged send that starts a run is
closer to that line than today's append, so the routing must be re-asserted
rather than assumed.
*Check:* `threadSend` remains in `AUTHORITY_RUNTIME_METHODS`
(`src/server/workers/capability.ts:205`) and is NOT added to the nested-run door
list; `src/server/workers/capability.test.ts` passes unchanged.

**LANDED 2026-11-09 — re-asserted, not assumed, and NOTHING in
`src/server/workers/capability.ts` changed.** `threadSend` is still
`AUTHORITY_RUNTIME_METHODS.threadSend` (`:205`), still a `SHARED_STATE_TOOL_NAMES`
entry (`:187`), and still absent from `NESTED_RUN_ARMED_DOORS` (`:531`); the existing
pins — `isNestedRunTool('threadSend') === false` (`capability.test.ts:217`) and
`isAuthorityRuntimeMethod('threadSend') === true` (`:229`) — passed unchanged, before
and after the merge, as did the whole file and `src/harness.nested-runs.test.ts`. What
keeps it on the correct side of the line is the non-blocking rule the T3.1/T3.2 tests
now measure rather than assert in prose: the sending turn finishes while the target's
request is still gated, so no lane ever holds a promise for another conversation's
answer, and the tool stays a routed chat primitive instead of becoming the nested run
that would have to leave the replica at hello.

**LANDED — the merged behaviour is exercised in worker mode, at both layers it
touches.** `src/server/workers/lane-authority.test.ts` › *delivers a cross-thread
message into the target conversation* answers the routed call on the canonical harness
and now reads `{ threadId, delivered: 'started', sender: 'primary' }` exactly, with the
attributed prompt and the started turn's answer as the conversation's whole transcript;
the two real-`worker_threads` integrations (`lane-worker.test.ts` › *sends across
threads from a lane and reads the roster from the authority*, and
`lane-worker-correctness.test.ts` › *picks up a message another lane sent while this
conversation was idle (T10 M4)*) report `started` from the lane's side. Those three
assertions are the only test edits the merge forced outside
`harness.thread-runtime.test.ts`, and they are the receipt value changing, not the
routing.

**T3.5 — Do not collapse the runtime API.** `steerThread` and `sendThreadInput`
are separate public handle methods for good reason — one is a receipt, one
awaits the answer, and only one is lane-safe. Merge the **tool**, not the
methods: `threadSend` becomes the state-aware façade over both. `sendThreadInput`
in particular has ~30 call sites across `src/server/sessions.ts`,
`src/server/workers/lane-worker-loop.ts:1113`, and the thread-runtime tests.
*Check:* both methods keep their signatures and return types
(`src/types/index.ts:2192`, `:2211`); only `postThreadMessage` changes.

**LANDED 2026-11-09 — the runtime API was not collapsed, and `postThreadMessage` is
the only executable code in `src/harness.ts` that moved.** `steerThread` and
`sendThreadInput` are byte-for-byte untouched: same parameters, same
`HarnessThreadSteerReceipt` (`queued`/`reason`) and `Promise<HarnessAssistantMessage>`
returns, same ~30 call sites across `src/server/sessions.ts`,
`src/server/workers/lane-worker-loop.ts` and the thread-runtime tests, and the tests
that pin them (the R5 steering group, the M1 queued-rejection pair, the T6 host-revival
test) passed without an edit. The public type change is one field of one receipt
(`HarnessThreadMessageResult.delivered`, T3.6); `HarnessThreadSteerReceipt` did not
move. Elsewhere in the file only comments were corrected — the thread-model header, and
two persistence cross-references that named the now-retired idle append — because a
cross-reference that points at a removed behaviour is a defect for the next reader.

`threadSend` is the façade over both primitives, which is exactly the asymmetry the
finding reported closing: the tool steers like `steerThread` when a run is live and
starts like `sendThreadInput` when it is not, and keeps neither one's blocking shape.

**T3.6 — Make the receipt say what happened.** `delivered: 'appended' | 'queued'`
does not distinguish "a run started" from "text parked in a transcript" — the
ambiguity that caused the misread this finding is built on. Add a value for the
started case (e.g. `'started'`).
*Check:* `src/tools/runtime/threadSend.tool.ts:21` and
`src/types/index.ts:2211-2221` describe every state's outcome, and each receipt
value is reachable in a test.

**LANDED 2026-11-09 — `delivered: 'queued' | 'started'`, and `'appended' is retired
rather than left unreachable.** Adding a third word and keeping the old one would have
failed this task's own check: with a dormant target now started, NO state parks text in
a transcript without a run that reads it, so `'appended'` had no reachable case left.
The retirement is stated where a reader meets the type
(`HarnessThreadMessageResult` in `src/types/index.ts`), together with the two values'
meaning, the fact that a `stopped` target is neither (it throws), and the caveat that
`'started'` reports the START of a run and not its answer — a later failure belongs to
the run's own reporting (`run.failed`, `agentResult`), not to this receipt. The model
sees the same contract in `threadSend`'s description
(`src/tools/runtime/threadSend.tool.ts`), and `src/core/tool-manifest.ts` was
regenerated (`npm run tools:manifest`) so the generated copy cannot drift.

Reachability, one test per value:
- `'queued'` — *steers a genuinely running conversation and its next turn reflects the
  message (T3.1)*, plus the pre-existing *queues a chat message into a running thread at
  its next boundary*;
- `'started'` — *starts a run in an idle conversation and returns before the answer
  exists (T3.2, T3.6)*, *lifts a plugin park and starts a turn in the parked
  conversation (T3.2)*, and the rewritten *delivers a threadSend message with
  runtime-derived sender attribution*, which now asserts the started run's whole
  transcript (`prompt` = the attributed message, then its answer) instead of one parked
  line;
- the no-value case (`stopped`) — the T3.3 and T6 tests above.

Three assertions elsewhere in the suite pinned the old word and moved with it —
`src/server/workers/lane-authority.test.ts`, `src/server/workers/lane-worker.test.ts`
and `src/server/workers/lane-worker-correctness.test.ts` — and `src/harness.ts` no
longer contains the string.

---

## Retest notes for the reviewer

Ordered by how much they could change this document:

1. **Finding 3's running branch is unverified.** Everything about the interrupt
   path is read from source. If a send into a genuinely running child turns out
   NOT to affect its answer, finding 3 regrows into the larger claim the first
   draft made. Test this first — it is the load-bearing uncertainty.
   **SETTLED 2026-11-09 — the source reading was right, and it is a measurement now,
   not a reading.** T3.1's test holds the target's first answer behind a gate so the
   run is provably mid-request when the send lands, and the child's next answer
   restates the steered text. The finding therefore keeps its shape: the gap was the
   DORMANT states, and T3.2 closed them.
2. **Finding 1's root cause is unconfirmed** (see the Unconfirmed note). Settle
   whether `toolCancel` is in the declared set while a call is pending before
   accepting T1.2.

2. **Finding 1's root cause is unconfirmed** (see the Unconfirmed note). Settle
   whether `toolCancel` is in the declared set while a call is pending before
   accepting T1.2. **SETTLED 2026-11-09 — it was NOT (visibleCoreTools skips
   `pendingOnly` definitions), so T1.2 was the right fix, and it had already landed.**
   See the settled note inside finding 1.
3. **The cancelled-result ordering anomaly is unresolved** and may be a display
   artefact of this harness rather than a package defect.

3. **The cancelled-result ordering anomaly is unresolved** and may be a display
   artefact of this harness rather than a package defect. **RESOLVED 2026-11-09 — it is
   the artefact** (explanation 1), with the code path named in the *Unresolved anomaly*
   section.
4. **Line numbers will drift.** `src/harness.ts` is 10,084 lines and grew by 713
   bytes during this review as edits landed; every citation below was
   re-verified against the live file, but none will survive unrelated changes.
   Prefer the quoted
   identifiers (`postThreadMessage`, `drainThreadQueue`, `NESTED_RUN_ARMED_DOORS`)
   as the anchors.
5. **Latency numbers are environment-dependent** (local `basalt` model). The
   linear-degradation claim is about shape, not the specific seconds.

## Not tested

- **That subagents cannot delegate further.** Stated in `delegate`'s description
  and in every subagent system prompt, never exercised: no child was given
  `delegate` and asked to call it.
- **`delegate` fan-out ceiling.** 12 concurrent children all completed, so no
  cap was reached; the true limit is unknown. Latency already degrades linearly,
  so a ceiling may be practical rather than enforced.
- **Whether `scope` is enforced for `delegate` itself** (i.e. whether a scoped
  child can be granted `delegate` and spawn grandchildren).
- **`threadSend` reply delivery.** A reply "may arrive later as a message from
  that thread"; no reply was ever observed, because no child was still running
  when the send landed.
- **A send into a genuinely running child.** See retest note 1 — the one attempt
  landed after the child had already finished.
  **COVERED 2026-11-09, by test — the live gap remains.**
  `src/harness.thread-runtime.test.ts` › *…reflects the message (T3.1)* measures it with
  the target's answer held behind a gate; a live session still cannot aim that precisely,
  which is why the reproducer under *How to reproduce* points at the test.
- **`paused` thread state.** The inert-append claim for `paused` is from source
  only; no thread in this session was ever in `paused`, since nothing exercised
  a plugin park.
  **COVERED 2026-11-09 — a park IS reachable, just not in a session with no plugin.**
  A `turn.before` handler that calls `payload.pause()` and never resumes leaves the
  record `paused` after its run ends (that is what `src/harness.plugin.test.ts` pins);
  the merge's parked branch reuses that shape —
  *lifts a plugin park and starts a turn in the parked conversation (T3.2)* — and
  reports the lift as `['resumed:idle']` before starting the next turn.

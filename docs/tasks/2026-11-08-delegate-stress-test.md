# Delegate stress test

Status: **open — findings 1–3 reported, finding 3 corrected twice, one anomaly
unresolved.** Written for a reviewer who did not run the test and who will
re-run it. Every claim carries either a transcript observation or a `path:line`
reference; claims that were not settled are labelled rather than smoothed over.

## Date / Method / Scope

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

**How to reproduce.** All three findings are behavioural, so they need a live
session rather than a unit test:

1. **Finding 1** — issue any `delegate`, note the `callId` from the `pending`
   envelope, then call `toolRequest` for `toolCancel` three ways: exact name,
   `regex: "cancel"`, and `tags: ["cancel"]`. Expect `matched: 0` in all three,
   and expect `toolCancel` to be absent from `alreadyAvailable`. Then call
   `toolCancel` by name with that `callId` and expect it to succeed.
2. **Finding 2** — `delegate` to `workspace` with
   `scope: { tools: ["read", "glob"] }` and a brief that requires a write.
   Expect no answer and a child that loops on `glob`; confirm with
   `threadRead` on the child's `threadId`.
3. **Finding 3** — `delegate` a long-running task, wait until
   `threadList` reports the child **idle** (not running), then `threadSend` into
   it. Expect `delivered: "appended"` and no new run. See *Retest notes* — the
   running branch is the one that was never actually exercised.

---

## Controls that work (verified, for contrast)

Recorded because two of the findings are about what is *missing*, and a reviewer
needs the baseline to tell a defect from normal behaviour.

| Control | Verdict | Evidence |
|---|---|---|
| `timeoutMs` | enforced precisely | 1200 ms budget → `durationMs: 1209`, `status: "cancelled"`, explicit error text |
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

### 3. `threadSend` cannot wake a thread that is not already running

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

**T1.3 — Add a pending-call hint to the placeholder.** The `pending` envelope
carries a `callId` but does not name the tool that cancels it. Naming it at the
moment the model holds a `callId` removes the discovery dependency entirely, and
works regardless of how T1.1 and T1.2 resolve.
*Check:* the `status: "pending"` result states the cancellation tool by name.

**T1.4 — Test it.** Extend `src/core/discovery.test.ts` (which already pins
that a core tool is never a candidate, `:182`) with the conditional-declaration
case, and add a delegation test asserting the pending envelope advertises its
own control.
*Check:* both tests fail against current source and pass after T1.2/T1.3.

### For finding 3 — one `threadSend` that does the right thing per state

**T3.1 — Pin the running-path interrupt before touching anything.** The path at
`src/harness.ts:4245-4247` is asserted from source but was never observed: the
only live attempt landed after the child had already finished, and that misread
produced the wrong first-draft conclusion. Add a test that sends into a
genuinely running child and asserts the child's answer reflects the message.
*Check:* a test in `src/harness.thread-runtime.test.ts` that fails if the
message is appended instead of drained into the live run.

**T3.2 — Make `threadSend` state-aware: steer while running, start a turn
otherwise.** This is the merge. Move the logic the server already runs at
`src/server/sessions.ts:6671-6672` down into `postThreadMessage`
(`src/harness.ts:4219`) so the runtime, not the HTTP layer, owns the decision.
Keep it **non-blocking**: on idle/paused it starts a run and returns a receipt;
it must not await the answer.
*Check:* one send into a running thread interrupts it; one send into an idle or
paused thread causes a run to start; neither call blocks the sender.

**T3.3 — Keep `stopped` a refusal.** Auto-restart should cover idle and paused,
not stopped. "Stopped must mean stopped for agents"
(`src/harness.ts:4645-4646`, enforced for this tool at `:4232-4236`) is
deliberate: reviving a conversation the host stopped is a host decision, and
`threadSend` is not the host. Folding stopped into the merge would silently undo
a user's Stop.
*Check:* `src/harness.ts:4232-4236` still throws for `stopped`, and a test
asserts a stopped child is not revived by an agent's message.

**T3.4 — Prove the merged tool survives worker mode.** The non-blocking rule in
T3.2 is what keeps `threadSend` out of `NESTED_RUN_ARMED_DOORS`
(`src/server/workers/capability.ts:531`). A merged send that starts a run is
closer to that line than today's append, so the routing must be re-asserted
rather than assumed.
*Check:* `threadSend` remains in `AUTHORITY_RUNTIME_METHODS`
(`src/server/workers/capability.ts:205`) and is NOT added to the nested-run door
list; `src/server/workers/capability.test.ts` passes unchanged.

**T3.5 — Do not collapse the runtime API.** `steerThread` and `sendThreadInput`
are separate public handle methods for good reason — one is a receipt, one
awaits the answer, and only one is lane-safe. Merge the **tool**, not the
methods: `threadSend` becomes the state-aware façade over both. `sendThreadInput`
in particular has ~30 call sites across `src/server/sessions.ts`,
`src/server/workers/lane-worker-loop.ts:1113`, and the thread-runtime tests.
*Check:* both methods keep their signatures and return types
(`src/types/index.ts:2192`, `:2211`); only `postThreadMessage` changes.

**T3.6 — Make the receipt say what happened.** `delivered: 'appended' | 'queued'`
does not distinguish "a run started" from "text parked in a transcript" — the
ambiguity that caused the misread this finding is built on. Add a value for the
started case (e.g. `'started'`).
*Check:* `src/tools/runtime/threadSend.tool.ts:21` and
`src/types/index.ts:2211-2221` describe every state's outcome, and each receipt
value is reachable in a test.

---

## Retest notes for the reviewer

Ordered by how much they could change this document:

1. **Finding 3's running branch is unverified.** Everything about the interrupt
   path is read from source. If a send into a genuinely running child turns out
   NOT to affect its answer, finding 3 regrows into the larger claim the first
   draft made. Test this first — it is the load-bearing uncertainty.
2. **Finding 1's root cause is unconfirmed** (see the Unconfirmed note). Settle
   whether `toolCancel` is in the declared set while a call is pending before
   accepting T1.2.
3. **The cancelled-result ordering anomaly is unresolved** and may be a display
   artefact of this harness rather than a package defect.
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
- **`paused` thread state.** The inert-append claim for `paused` is from source
  only; no thread in this session was ever in `paused`, since nothing exercised
  a plugin park.

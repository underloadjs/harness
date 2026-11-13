# 0019 — A settled delegation can be recorded and never delivered: the parent keeps only the `pending` placeholder

> **Status:** Fixed — 2026-11-14 (the owed-delivery register shipped after the 03:51 review pass;
> AC1-AC4 are met, and what remains open is the **instrumentation** gap that review asked for, not
> the delivery. See the second- and third-pass updates)
> **Severity:** Significant
> **Area:** `src/harness.ts` (background tool delivery for `delegate`)
> **Date opened:** 2026-11-11

## Context

A primary agent ran 19 delegations against two subagents to exercise the `delegate`
contract. Two of them returned the documented `{ status: "pending", callId }`
placeholder, the children then reached a terminal state, and the terminal envelope
never arrived in the parent conversation — not on the next turn, and not across the
eight further turns the parent took while waiting. The child records were complete and
readable the whole time through `agentResult`, so the work was done and reported; the
parent simply never received it. The tool description tells the caller the opposite —
"never assume the envelope is missing just because the first turn showed a
placeholder" — so a caller that trusts the contract waits for a message that is never
coming, and the only recovery is to know to poll `agentResult` by hand.

## Gap

A caller that receives a `pending` placeholder needs a guarantee that exactly one
terminal envelope follows it for that `callId`, whatever the child's timing was. Today
the placeholder is a promise the runtime does not always keep: once it is committed as
the request projection's stand-in, nothing re-drives delivery for that call if the
completion landed in the window between the launch and the next turn boundary. The
consumer has to duplicate the delivery layer — keep the `callId`, poll
`agentManage`/`agentResult` for the child's record, and reconstruct the envelope the
runtime already has — which is meaningful duplicated code around a documented
single-call contract.

## Why it is the way it is

Delivery is deliberately event-driven, not polled. The scheduling model is stated at
`src/harness.ts:25-31` ("for each call: -> LAUNCH it … loop again immediately, with
placeholders for unfinished calls") and `:172-180` ("Until a call settles, the request
projection answers it with a placeholder … Each completion is committed at the call's
ORIGINAL position and drives another turn"). Placeholders are projection-only and are
never committed (`:6731-6738`, "Placeholders are NEVER committed"). `settleWindow`
(`:9715-9717`) coalesces only work that settles without real I/O, and the batch gate at
`:10040` parks a run rather than building a turn on placeholders. `delegate` is
registered `mode: 'async'` (`src/tools/runtime/delegate.tool.ts:131`) precisely so the
parent is not held by the child. So the design is a completion-driven push; the gap is
that the push has a lost-wakeup window, and there is no reconciliation pass that
notices a settled call whose tool message was never inserted.

## Evidence

| Fact | Source |
|---|---|
| Two delegations returned a placeholder and were never answered in the parent transcript | live session, 2026-11-11: `call_1e0f3787…` (child invocation 21, `timeoutMs: 1`, cancelled at 62 ms) and `call_07126745…` (child invocation 35, completed, `content: "ENUM-PROBE"`, 2173 ms). `threadRead { thread: "thread-3" }` over the full 93-message transcript returns **no** `role: "tool"` message carrying either `toolCallId`; both appear only as launches inside assistant `toolCalls` |
| Both children were terminal and fully readable while the parent waited | `agentResult { agent: "general", invocationId: "21" }` → `status: "cancelled"`, `error: "Delegation to \"general\" exceeded its 1ms timeout and was stopped."`, `cancelledAtMessage: 1`, `durationMs: 62`; `agentResult { agent: "research", invocationId: "35" }` → `status: "completed"`, `content: "ENUM-PROBE"` |
| The same shape delivered inline on retry, so it is a race, not a deterministic failure | two further `timeoutMs: 1` delegations (invocations 33 and 34, 228 ms and 268 ms) returned their terminal envelopes directly |
| The contract promises delivery, so the placeholder is not a valid final answer | `src/tools/runtime/delegate.tool.ts:164` — "a child that is still running leaves a `{ status: "pending", callId }` placeholder there instead, and the real envelope arrives in a later turn … never assume the envelope is missing just because the first turn showed a placeholder" |
| Delivery is push-based with no reconciliation pass over settled-but-undelivered calls | `src/harness.ts:25-31`, `:172-180`, `:6731-6738` (projection placeholders), `:9715-9717` (`settleWindow`, microtasks only), `:10040` (batch gate) |
| The delivery site that inserts one tool message per settled call | `src/harness.ts:7355-7360` ("EVERY settled call is its tool message in this agent's transcript: deliverTask/immediateResult insert one for every completed, failed, rejected, and cancelled call, and a placeholder is never committed") |

## Proposal

Make placeholder resolution idempotent and self-healing rather than purely
edge-triggered. At the point where the run decides what the next model request looks
like — the same place that already consults the settled-call ledger (`:7355-7360`) —
sweep the calls it has launched and not yet answered, and for any whose invocation
record is already terminal, insert the terminal envelope as the tool message before
building the request. That reuses the existing delivery path (`deliverTask`) and the
existing identity lookup; it adds a reconciliation check, not a second delivery
mechanism. Pair it with a one-line invariant test: for every committed `pending`
placeholder, a tool message with the same `callId` must exist by the time the run
finishes draining.

**Alternatives considered.**

- *Make `delegate` synchronous (await the child before answering).* Rejected: it
  contradicts `registration.mode: 'async'` and its stated reason (`delegate.tool.ts:126-131`
  — the parent must stay free, a completion triggers its own turn, `toolCancel` and the
  heartbeat keep working), and it would serialize the concurrency the 3-sibling test at
  `src/harness.delegation.test.ts` exists to protect.
- *Add a periodic re-drain timer.* Rejected: it reintroduces a timer in a file whose
  test suite asserts the opposite — `src/harness.delegation.test.ts:1683`
  ("arms exactly one turn-bounding timer, and only behind a finiteness check") — and a
  timer adds latency without closing the race.
- *Tell the model to poll `agentResult` itself.* Rejected: that moves the runtime's job
  into the prompt, costs a round trip per delegation, and leaves the documented
  contract false.

## Acceptance criteria

1. For every `delegate` call whose first answer was a `pending` placeholder, the parent
   transcript ends with exactly one tool message carrying that `toolCallId` and the
   child's terminal envelope — including when the child settled during the launch turn.
2. A harness run cannot finish draining with a launched-and-settled `delegate` call
   that has no tool message.
3. The delivered envelope is byte-identical to the one `agentResult` reports for the
   same `invocationId` (same `status`, `content`, `error`, `durationMs`).
4. No new timer is armed: the existing single-turn-bounding-timer assertion still
   passes.

## Tests to add

- `src/harness.delegation.test.ts` — a child that settles synchronously (no I/O) while
  the parent launched it in a batch: assert the parent transcript carries a tool message
  for that `callId` with the terminal envelope, and that no placeholder survives.
- `src/harness.delegation.test.ts` — a child cancelled by `timeoutMs` in the same tick
  as the launch: assert delivery of the `status: "cancelled"` envelope, not just its
  availability through `agentResult`.
- `src/harness.delegation.test.ts` — three concurrent siblings where one settles during
  the launch turn and two later: assert three tool messages, each carrying its own
  `invocationId` (the existing sibling-attribution pins must not regress).
- A drain-invariant assertion in the same file: after the harness promise resolves, no
  launched `delegate` call is missing its tool message.

## Out of scope

- Changing `delegate` to a synchronous tool, or changing its `mode`.
- Changing the envelope shape (that is 0024).
- Cancellation reporting (0021 and 0022).
- Adding a heartbeat or any new timer.
- Thread reaping (0027).

## Update (2026-11-11) — independent review

- **Verdict: confirmed as a defect, re-classified as to mechanism.** An independent
  read-only pass over `src/harness.ts` agreed the gap is real and reachable, and agreed the
  severity (**Significant**), but **refuted the causal sentence in Context and in the first
  Proposal paragraph**. There *is* a re-drain at every turn boundary — `drainMailbox`
  (`src/harness.ts:6417`) is awaited at `:9844`, at `:9861`, and again in the final guard
  before a run may resolve at `:9984` — so "it settled before the next boundary and nothing
  re-drove it" is not the mechanism. A settle landing in any of those drains marks the run
  dirty and buys a turn.
- **The real suspects are the discard paths inside delivery, not a lost wakeup.**
  `deliverTask` (`src/harness.ts:6950`) states its own contract: "A task whose run has
  already ended (or was aborted) is discarded: the transcript it would touch was rolled
  back." Its silent exits are `run.aborted` (`:6958`), `!run.active` (`:6973`, which calls
  `settleCompletion` and returns **without inserting a tool message**), and
  `insertToolMessage` declining because the call already has a result (`:6693`) or has no
  valid insert index (`:6695-6696`, `resultInsertIndex` at `:6610` — "the delivery is
  discarded rather than appending an unpaired result at the end"). `scheduler.abandonScope`
  (`:9831`, `:10063`, `:10608`) is the fourth: it releases a task with no notify at all
  (`:10609-10612`).
- **The shape that fits the observation.** Each host turn is its own run. The stranded call
  was launched in a run that ended while the child was still working; when the child settled,
  `!run.active` (`:6973`) discarded the delivery, and the parent's later turns are successor
  runs that never re-drive a call belonging to a finished run. That is consistent with the
  transcript showing the launch and no result, and with the parent continuing normally.
- **What the reporter did not prove, and an implementer must.** Whether a `tool_result` event
  fired for the two stranded `callId`s, and whether the parent run was still active at each
  settle. Both are needed to pick which exit fired. Add that instrumentation to the
  reproduction before choosing a fix; the acceptance criteria stand either way, since they are
  stated as outcomes.
- **One description sentence belongs to this issue and was missed as filed.** "A child that
  finishes without real I/O has its result in the tool message of your next turn"
  (`src/tools/runtime/delegate.tool.ts:164`) rests on `settleWindow` being microtask-only
  (`src/harness.ts:9715-9717`). Any macrotask puts a child outside that sentence — including a
  1 ms timer, which is what the reproduction's own `timeoutMs: 1` probes were. That sentence is
  what leads a caller to read a placeholder as "arriving next turn", so closing this issue
  should re-word it.
- **Test gap confirmed.** `src/harness.delegation.test.ts` never cancels a delegation and
  never exercises delivery when the parent run has ended or aborted, nor the `abandonScope`
  release — which is why this shipped.
- Severity unchanged: **Significant**.

## Update (2026-11-14, partial fix) — one discard path closed, the observed one still open (D2)

- **What closed: the release door stopped discarding the envelope it caused.** The review of 0021
  identified a fifth exit that this entry had not named — for a parent-initiated `toolCancel` the
  envelope is *produced and then thrown away*, because the scheduler treats the child's late
  resolution as data on a dead task. That path is now wired end to end: the live call publishes a
  per-call trace (`DelegateCallTrace` / `delegateCallTraces`, `src/harness.ts:4307-4343`),
  `onSettled` reads it synchronously in the cancel's own stack and passes it to delivery
  (`:8924-8937`), and `deliverTask`'s cancelled branch awaits the child's already-in-flight settle
  promise and inserts the terminal envelope as the call's own tool message
  (`:8215-8239`, built by the shared `unfinishedDelegateEnvelopeOf` at `:4274-4305`). So a
  released delegation can no longer leave the parent holding only the placeholder. 0021 records the
  same change from its side, including the fact that `toolCancel`'s ack is unchanged.
- **What did not close: the shape the reproduction actually observed.** The two stranded calls in
  the 2026-11-11 pass belong to a run that had ENDED while the child was still working, and the
  exits the review named for that shape are untouched, in the same order:
  `deliverTask`'s `run.aborted` early return (`src/harness.ts:8163-8176`) and its `!run.active`
  early return (`:8178-8181`) both `settleCompletion` and return **before** the released-trace
  branch, `insertToolMessage` still declines a call that already has a result or has no valid
  insert index (`:7866`, `resultInsertIndex` at `:7797`), and `scheduler.abandonScope` still
  releases with no notify at all (`:11201`, `:11451`, `:12158`). A successor run therefore still
  never re-drives a call that belonged to a finished run. **No reconciliation sweep was added.**
- **Acceptance criteria, honestly.**
  1. *Every `pending` placeholder ends with exactly one tool message carrying the terminal
     envelope* — **met for the `toolCancel` door only**; not met for a parent run that ended or
     aborted, which is the observed case. Still **Open**.
  2. *A run cannot finish draining with a launched-and-settled `delegate` call that has no tool
     message* — **not met**: there is no drain invariant assertion and no sweep, and the two early
     returns above are the counter-examples.
  3. *The delivered envelope is byte-identical to what `agentResult` reports for the same
     invocation* — **met where the envelope is delivered**: the shape is computed ONCE
     (`:4250-4252`, "two hand-copied literals are how the doors drifted apart in the first place,
     and the delivered bytes must agree with what `agentResult` reports"), the page limit comes
     from the call's own arguments (`delegatePageLimitOf`, `:4258-4264`), and the two differences
     that remain are stated intent, not drift: `error` is the harness's own sentence rather than
     the record's raw abort string (`:4359-4361`), and `content` prefers the child's FINAL answer
     because a release races the child (`:4356-4358`).
  4. *No new timer* — **met**: the only wait is the child's own already-in-flight settle promise
     (`:8226-8233`), and the source-shape pin on `armWallClock` still passes
     (`src/harness.delegation.test.ts:2355-2375`).
- **The description sentence the review asked for is gone.** "A child that finishes without real
  I/O has its result in the tool message of your next turn" no longer appears in either
  description (`src/tools/runtime/delegate.tool.ts:99`, `:213`; also absent from
  `src/core/metadata.ts` and the generated `src/core/tool-manifest.ts`). The surviving promise —
  "Never treat the placeholder as an answer, and never assume the envelope is missing just because
  the first turn showed a placeholder" (`:213`) — is now the sentence this issue is about: it is
  true on the release door and still false on the ended-parent-run door. Do not re-add the retired
  sentence.
- **What the next implementer has that the original did not: an address, and a trap.** The record
  of a settled child can now be found WITHOUT a heuristic — `delegatedRecordOf(parentScope,
  parentCallId)` is value-addressed (`:4408-4424`) and every child stamps its own
  `parentScope`/`parentCallId` — and `HarnessDelegationResult`'s shape is built in one place. The
  trap is lifetime: the trace map is cleared in `delegateFor`'s `finally` (`:4739`), so a sweep
  that runs at a later turn boundary CANNOT use `delegateCallTraces`; it must walk committed
  `tool_call`/`tool` pairs in the transcript against the ledger (a committed placeholder with no
  tool message, matched by `parentCallId`/`parentScope`), and re-derive `agent`/`limit` from the
  committed call's own arguments the way `delegatePageLimitOf` does.
- **The instrumentation the review demanded is still missing.** Whether a `tool_result` event
  fired for the two stranded `callId`s, and whether the parent run was active at each settle, were
  never measured; the 2026-11-14 pass did not reproduce the ended-parent-run case (the original
  live session is not in this repo, so its transcript is not re-examinable). **Unconfirmed which
  of the two early returns fired.** That gap should be closed before choosing between "sweep at
  the request-projection point" and "re-drive on the successor run's first boundary".
- **Tests.** The new pins are 0021's (`src/harness.delegation.test.ts:973`, `:1027`) and cover the
  release door only. The **Tests to add** list in this entry is untouched: no test settles a child
  during the launch turn against an ENDED parent run, and there is no drain-invariant assertion.

## Update (2026-11-14, second pass) — the register shipped; the review's two "not met" findings are superseded

Read from the current source and tests; **no test was executed by this doc pass**. Everything the
03:51 review update concluded about the *delivery* half has since changed, so this update supersedes
"there is no drain invariant assertion", "**No reconciliation sweep was added**", and AC1's "not met
for a parent run that ended or aborted". The review's **instrumentation** finding is NOT superseded
and is the only thing still owed.

- **There is now an owed-delivery register, and it is ledger-backed rather than trace-backed.** The
  shape `OwedDelivery` is `src/harness.ts:8636` and the queue is a per-`actorKey` map at `:8654`;
  `recordOwedDelivery` (`:8672`) is the one door that decides whether a settled call is owed,
  `recordOwedDebtOfTask` (`:8700`) adapts a scheduler task into that shape, and
  `recordOwedAbandonments` (`:8710`) walks `scheduler.pendingOfScope` so an abandonment sweep records
  debts instead of losing them. Payment reads the ledger at that moment: `owedRecordOf` (`:8717`) is
  value-first with the `parentScope`/`parentCallId` pair as fallback, and `owedAccountOf` (`:8724`)
  returns "nothing to report" for an evicted record **and for a child that is still running** — the
  comment at `:8720-8723` states why: "its own delivery answers the call when it lands, and that
  account is the real one, so the register must not get ahead of it".
- **The two early returns the review named as counter-examples now record before they return.**
  `run.aborted` at `:8305` records at `:8321`; `!run.active` at `:8326` records at `:8329`; and the
  third leak — `insertToolMessage` declining a call that has no valid insert index (def `:7980`,
  `resultInsertIndex` `:7911`) — records at `:8519`. The register is documented as the third answer
  door in the three-place-grep comment at `:4298` and `:4314`, so the next reader is told about it
  where the cancellation doors are described.
- **Payment is the first act of the next turn, not a later convenience.** `deliverOwedAccounts(run)`
  runs at `:11690`, ahead of `drainMailbox`, with the comment at `:11683-11689` stating the reason: a
  debt must not be starvable by a run that stops after that request. The queue key is deleted at
  `:8792` once paid, and the whole register is cleared on `restore()` (`:13163`) and `reset()`
  (`:14346`) — the state that owed the account no longer exists, so a restored session does not report
  a previous generation's child.
- **AC1-AC4.** AC1 — **met** on both doors the review called unmet: the pins are
  `src/harness.delegation.test.ts:301` (parent cut off by its turn budget) and `:366` (parent aborted
  with the call in flight), inside the describe at `:280`. AC2 — **met**: the drain invariant is
  asserted over BOTH channels at `:352-363`, and the two properties it names are "exactly one account"
  (`accountsFor(...) === 1` at `:344` and again after a third turn at `:349`) and no provider-orphan
  tool result (`orphanToolResults(...)toEqual([])` at `:345`, `:350`); the ledger half still holds the
  outcome after the register has finished with it (`:357-363`). AC3 — **met, unchanged**: the shape is
  still computed once (the "two hand-copied literals" comment is now at `:4304-4318`), the page limit
  still comes from the call's own arguments (`delegatePageLimitOf`, `:4325`), and the two stated
  differences survive (`:4433` for the harness sentence replacing the raw abort string; the final-text
  preference is restated for the register at `:8729-8730`). AC4 — **met, unchanged**: the only wait is
  the child's own in-flight settle promise (`:8408`); no timer was added, and the `armWallClock`
  source-shape pin moved to `src/harness.delegation.test.ts:3117-3132`.
- **The trap the review recorded is still exactly as recorded**, and the register is built around it:
  `delegateCallTraces` is cleared in `delegateFor`'s own `finally` (`:4655` set, `:4828` delete), so a
  later-turn account CANNOT read the trace map — which is why `owedRecordOf` resolves through
  `delegatedRecordOf` (`:4494`) and the queue stores only `{ scope, callId, invocationId }`.
- **What is still owed.** (a) The review's instrumentation demand: whether a `tool_result` event fired
  for the two stranded `callId`s and whether the parent run was active at each settle, was never
  measured, and the live session that produced the report is not in this repo. The shipped fix covers
  both early returns by construction, so this no longer gates the fix — but the *original* attribution
  (which door fired) remains unconfirmed, and this pass did not measure it either. (b) The
  three-cause discriminator is 0021's, unchanged. (c) `deliverOwedAccounts` has exactly one call site
  (`:11690`, the next model turn); a session that never starts another turn after the debt is booked
  still holds it until `restore()`/`reset()` drops it. Whether that is a guarantee to chase or the
  intended lifetime is the owner's call, and no test asserts it either way.
- Status stays **Open**, severity **Significant**. *(Dated correction, 2026-11-14 third pass: this was
  the state at that pass and is superseded — the register below shipped and the header now reads
  **Fixed**. What remains is the 2026-11-11 attribution, recorded there, not the delivery.)*

## Update (2026-11-14, third pass) — the register re-verified at current addresses; the lifetime claim reduced

Read from source and tests; **no test was executed by this doc pass**. Addresses are from the working
tree at 07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree). `src/harness.ts` was rewritten
twice during the pass (it is 14,764 lines now, and was over 15,000 an hour earlier), so every number
here is a snapshot and the quoted identifiers are what should be re-grepped.

- **The register is intact, with current addresses.** `type OwedDelivery` at `src/harness.ts:8709`,
  the per-`actorKey` queue at `:8727`, the door probe `owedChildRecordOf` at `:8731`,
  `recordOwedDelivery` at `:8745`, `recordOwedDebtOfTask` at `:8773`, `recordOwedAbandonments` at
  `:8783`, payment's ledger reads `owedRecordOf` `:8790` and `owedAccountOf` `:8797`, and
  `deliverOwedAccounts` `:8860`. It is documented as the third answer door in the three-door heading at
  `:4290-4326` (item 3 of the list, `:4304-4307`).
- **Five doors, all recording.** `run.aborted` (`if` at `:8378`, records at `:8394`), `!run.active`
  (`:8399` → `:8402`), a declined `insertToolMessage` (`:8591` → `:8592`, the "the writer DECLINES
  when the call's slot is gone" comment at `:8586-8590`), and `scheduler.abandonScope` preceded by
  `recordOwedAbandonments` at `:11728`/`:11729`, `:11991`/`:11992` and `:12770`/`:12771`. Payment is
  still the first act of the next turn (`deliverOwedAccounts(run)` at `:11763`, its **only** call
  site), the queue key is dropped once paid (`:8865`), and the register is cleared on `restore()`
  (`:13266`) and `reset()` (`:14449`).
- **Two corrections to the second pass.** The debt no longer stores only `{ scope, callId,
  invocationId }`: `OwedDelivery` (`:8709-8724`) carries `scope`, `callId`, `name`, `invocationId` and
  an optional `threadId`, and the comment at `:8715-8722` says why — the account is re-inserted as the
  result of the **same** call (`insertToolMessage` writes `name`; `boundDelivery` keys the per-turn
  budget on `{ name, callId }`), and an account whose slot is gone can still name the conversation it
  describes. And the door comments no longer carry the reason strings (`'run-aborted'`,
  `'run-inactive'`, `'caller-declined'`): `recordOwedDelivery(run, call)` is 2-argument at all three
  sites, and each door is identified by the comment above it (`:8391-8393`, `:8400-8401`,
  `:8586-8590`).
- **AC1-AC4's pins, re-derived.** `src/harness.delegation.test.ts:280` (describe) with cases `:301`
  ("accounts for a child that settled after its parent was cut off by its turn budget"), `:366` ("…after
  its parent was aborted with the call in flight"), `:406` ("keeps the ONE account a still-open
  conversation already carries (no duplicate on the next turn)") and `:432` ("drops an UNPAID account
  when a restore replaces the runtime state that owed it"). The AC2 drain invariant is asserted over
  both channels in each of the first three cases: exactly one account
  (`accountsFor(...) === 1` at `:344`, `:349`, `:395`, `:402`) and no provider-orphan tool result
  (`orphanToolResults(...)toEqual([])` at `:345`, `:350`, `:396`, `:403`), with the ledger half still
  holding the outcome (`recordOf(...)` at `:336` and the post-drain read at `:357`). The helpers are
  `accountsFor` `:225` and `recordOf` `:264`.
- **Reduction: the second pass's item (c) is now half-closed, and is stated as such.** It read "a
  session that never starts another turn after the debt is booked still holds it until
  `restore()`/`reset()` drops it … **no test asserts it either way**". A test does assert the restore
  half: `:432` exhausts the parent's turn budget, snapshots, restores, and then pins BOTH facts — the
  runtime debt is gone (`accountsFor(...) === 0` at `:470`, no orphan at `:471`) and the durable
  ledger still answers the same id with `status: 'cancelled'` and its partial (`:475-478`). The case
  is the first one's counterfactual, stated in its own comment at `:433-441`. What is **still
  unasserted**: the `reset()` door (`:14449`) has no case that reads the register — the file's only
  `reset()` case is `:969` ("reset() clears every agent transcript, not just the entry agent"), which
  calls `writer.reset()` at `:998` and asserts transcripts only (`:1001-1002`), never
  `accountsFor(...)`. And nothing pins the "no further turn is ever started" window — whether a debt
  booked and never paid is a guarantee to chase or the intended lifetime remains the owner's call.
- **What this pass could not confirm.** The review's instrumentation demand stays as recorded: whether
  a `tool_result` event fired for the two 2026-11-11 `callId`s, and whether the parent run was active
  at each settle, has still never been measured, and the live session that produced the report is not
  in this repo. **Unconfirmed which of the early returns fired**; the register now covers all five
  doors by construction, so the delivery fix does not depend on the answer.

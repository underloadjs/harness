# 0019 — A settled delegation can be recorded and never delivered: the parent keeps only the `pending` placeholder

> **Status:** Open
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

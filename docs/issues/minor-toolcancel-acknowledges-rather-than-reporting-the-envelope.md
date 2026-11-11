# 0021 — `toolCancel` answers with an acknowledgement, and the two cancellation paths report different error strings

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (cancellation reporting)
> **Date opened:** 2026-11-11

## Context

`delegate` names `toolCancel` as the recovery for a child that is still running, and
promises that an unfinished child arrives as a structured envelope carrying `error`,
`status` and `durationMs`. When the parent actually uses that recovery, it gets two
different answers depending on who did the cancelling. A timeout produces the harness's
own sentence. A parent-initiated cancel produces a bare
`{ cancelled: true, callId, name }` acknowledgement plus the line "no result is
available", and the error text that eventually surfaces through `agentResult` is the raw
`AbortError` string `"This operation was aborted"`. So the control the description
recommends is the one path that loses the envelope it just caused.

## Gap

A caller that abandons a delegation wants the outcome of the call it abandoned, in the
same message, in the same shape as every other unfinished child. Today it must issue a
second call (`agentResult`, and it needs the `invocationId` for that — see 0024) and the
string it gets back is a host-level primitive that cannot be classified: nothing in
`"This operation was aborted"` says whether the child timed out, was cancelled by the
caller, or was rolled back with the run.

## Why it is the way it is

`toolCancel` is a control, not a result channel: it releases the call logically at once
because arbitrary JavaScript cannot be preempted (`src/harness.ts:1547-1560`, "The
harness releases a cancelled call LOGICALLY at once (removes it from the pending view,
discards a late result)"). The timeout path is different because the harness itself
raises the reason: `timeoutController.abort(new HarnessError(...))` at
`src/harness.ts:4179-4183`, and the delegate catch prefers that message over the
record's (`:4237-4239`). A parent cancel has no equivalent reason object, so
`record.error ?? toErrorInfo(error).message` (`:4239`) falls through to whatever the
abort produced. The asymmetry is inherited from that design, not intended as an
interface.

## Evidence

| Fact | Source |
|---|---|
| Timeout raises a harness sentence | `src/harness.ts:4179-4183` (`Delegation to "${target}" exceeded its ${timeoutMs}ms timeout and was stopped.`), preferred at `:4237-4239` |
| A non-timeout cancel falls through to the raw error message | `src/harness.ts:4239` (`record.error ?? toErrorInfo(error).message`) |
| Runtime, 2026-11-11: timeout path | envelope `error: "Delegation to \"general\" exceeded its 1ms timeout and was stopped."` (invocations 21, 33, 34) |
| Runtime, 2026-11-11: parent-cancel path | `toolCancel { callId: "call_fdcc6f638ef94edf8a790ddf" }` → `{ cancelled: true, callId, name: "delegate" }`; the tool message read "Tool call \"delegate\" … was cancelled before it completed; no result is available"; `agentResult { invocationId: "26" }` → `error: "This operation was aborted"` |
| The cancelled run's own record carries the raw string too | `src/harness.ts:3672-3676` (`record.error = toErrorInfo(outcome.error ?? …).message`) |
| `delegate` recommends `toolCancel` as the recovery | `src/tools/runtime/delegate.tool.ts:164` and the `timeoutMs` property text at `:104-113` |

## Proposal

Give a parent-initiated cancellation the same structured outcome as a timeout, and let
`toolCancel` report it. Add a reason discriminator on the cancelled result —
`reason: "timeout" | "cancelled-by-parent" | "caller-aborted"` — set where each cause is
raised, and have `toolCancel` return the terminal envelope for the call it released when
one is already available, falling back to the current acknowledgement when the tool has
not yet released. Keep the human-readable sentence for the timeout exactly as pinned, and
replace the leaked `AbortError` text with the harness's own wording for a caller-initiated
cancel.

**Alternatives considered.**

- *Leave `toolCancel` as an acknowledgement and document that the envelope arrives later.*
  Rejected: for a delegation the envelope is produced synchronously by the abort, so the
  information exists at receipt time; withholding it only forces a second call.
- *Only fix the wording.* Rejected: it fixes triage but not the extra round trip.
- *Return the whole child transcript from `toolCancel`.* Rejected: it re-opens the leak
  boundary at `src/harness.ts:4704-4712`.

## Acceptance criteria

1. A parent-cancelled `delegate` call reports `status: "cancelled"` with a harness-raised
   message naming the agent and the reason, never a raw `AbortError` string.
2. The two causes are distinguishable without string matching: a timeout and a
   parent cancel report different machine-readable reasons.
3. `toolCancel` on a delegation that has already produced its terminal result returns
   that result; on a tool that has not, it still returns the current acknowledgement
   unchanged.
4. The existing timeout sentence is byte-identical, so its pin does not move.

## Tests to add

- `src/harness.delegation.test.ts` — a parent-cancelled child: assert the envelope's
  `status`, the harness wording, and that the message is not `"This operation was
  aborted"`.
- `src/harness.delegation.test.ts` — assert the reason discriminator differs between the
  timeout case and the parent-cancel case.
- The `toolCancel` test file — assert the acknowledgement shape is unchanged for an
  ordinary async tool, and that a delegation whose result is already settled returns it.

## Out of scope

- What `partialContent` contains (0020).
- Cancelling several calls at once, or cancelling a whole thread.
- Changing when a cancelled call is released logically (the non-preemptibility model).

## Update (2026-11-11) — independent review

- **Verdict: confirmed, severity unchanged (Minor), attribution corrected.** The two strings are
  not two renderings of one surface. The timeout sentence is generated in the harness twice — as
  the abort reason (`src/harness.ts:4179-4183`) and again in the envelope (`:4237-4239`). The raw
  `"This operation was aborted"` is the **child's own invocation record**
  (`record.error = toErrorInfo(…).message`, `:3671-3676`), reachable only through `agentResult`;
  the parent's own tool message is the generic cancel line (`:6998-7003`) and the ack is
  `{ cancelled, callId, name }` (`:7399`). So the substantive defect is not the wording mismatch
  — it is that the cancel path never delivers the envelope at all, which is what the Proposal
  already asks for.
- **Sharpened by the review:** for a parent-initiated cancel the envelope is not merely withheld,
  it is unreachable by design — the scheduler releases the task and a late resolution is treated
  as data on a dead task (`src/core/scheduler.ts:281-298`). The fix therefore has to produce the
  envelope at cancel time from the child's terminal record, not wait for the tool promise.
- **Test gap confirmed:** `src/harness.delegation.test.ts` never applies `toolCancel` to a
  `delegate` call at all.

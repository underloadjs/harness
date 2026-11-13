# 0021 — `toolCancel` answers with an acknowledgement, and the two cancellation paths report different error strings

> **Status:** Fixed — 2026-11-14 (the released door now delivers the child's terminal envelope as
> the delegation's own tool message: AC1 and AC4 are met; AC2's two-door discriminator shipped and
> its third cause stays open; AC3 is **superseded**, not met as written — `toolCancel` never returns
> the terminal result, it answers a structured JSON receipt and the result arrives as the call's own
> tool message. See the updates; the third pass of 2026-11-14 re-derived every address at the current
> tree.)
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

- `src/harness.delegation.test.ts` — assert the reason discriminator differs between the
  timeout case and the parent-cancel case.

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

## Update (2026-11-14, partial fix) — three of four criteria closed (D2)

- **The envelope is now delivered on the door that used to lose it — but not through
  `toolCancel`'s return value.** The proposal asked `toolCancel` itself to answer with the
  terminal result. What shipped keeps the control a control: `toolCancel` still acks
  `{ cancelled: true, callId, name }` immediately (`src/harness.ts:8702-8715`), because the
  release is synchronous and at that instant the child has not terminalised — "the abort is still
  unwinding through its model/tool boundaries, so the record on this stack is `running` with no
  partial content" (`:8224-8233`). The debt moved to the delivery layer instead: the live
  delegation publishes a per-call trace (`DelegateCallTrace` / `delegateCallTraces`,
  `:4307-4343`, set at `:4566`, cleared in `delegateFor`'s own `finally` at `:4739`), `onSettled`
  reads it **synchronously in the cancel's own stack** (`:8924-8934`) and hands it to
  `deliverTask` as the `released` argument (`:8154-8158`), and the cancelled branch of delivery
  awaits the child's already-in-flight settle promise (`:8234`) and inserts the terminal envelope
  as the call's OWN tool message (`:8215-8239`).
- **Acceptance criteria, honestly.**
  1. *`status: "cancelled"` with a harness sentence, never a raw `AbortError`* — **met on the
     parent-cancel door**: the delivered tool message carries
     `Delegation to "<agent>" was cancelled by the caller before the call returned.`
     (`:4386`) plus the child's real terminal `status` (`:4295`). The raw
     `"This operation was aborted"` still lives in the child's own record and therefore in
     `agentResult` for that invocation — deliberately, and now stated in the source
     (`:4359-4361`: the record "holds the raw … string, which cannot be classified (0021 AC1);
     the child's own wording stays available through `agentResult`"). A live probe of the released
     door on 2026-11-14 returned exactly the envelope (`callCancelled: true`, that sentence, no
     `AbortError` text).
  2. *Two causes distinguishable without string matching* — **met only for the two doors the
     finding observed, and by a boolean rather than an enum.** `callCancelled` is present on
     exactly one door, the released one (`src/types/index.ts:1408-1414`), so a timeout
     (no `callCancelled`, the timeout sentence) and a parent cancel (with `callCancelled`) are
     separable by key presence. The proposal's third cause — `caller-aborted`, the CALLING run's
     own abort, which propagates as a rollback rather than a result — has no discriminator, and
     no `reason` field was added. The two-cause version of this criterion is what the fix pinned;
     the three-cause version stays open.
  3. *`toolCancel` returns the terminal result when it exists, else the ack unchanged* —
     **shipped differently**: the ack is unchanged in BOTH cases and the result arrives as the
     call's tool message. That is the option the original **Alternatives considered** rejected
     ("Leave `toolCancel` as an acknowledgement and document that the envelope arrives later"),
     and the reason for overriding that judgement is the finding above — the envelope does not
     EXIST at ack time, so returning it was not available; the extra round trip is what got
     removed, which was the criterion's actual point. Nothing about the child's transcript is
     returned, so the leak boundary at the end of the **Alternatives** list still holds.
  4. *The timeout sentence byte-identical* — **met**: the timeout path still raises and reports
     its own harness sentence, and the new envelope builder is shared, not copied
     (`:4250-4252`, "two hand-copied literals are how the doors drifted apart"). The historical
     "no result is available" sentence also survives byte for byte for every non-delegation,
     non-fork cancelled call (`:8201-8212`).
- **What is still open here.** (a) the three-cause discriminator from AC2; (b) the sibling
  finding this file handed to 0019 is only half closed — a released delegation whose PARENT run
  has ended or aborted still falls out of `deliverTask` before the released branch runs
  (`run.aborted` at `:8163-8176`, `!run.active` at `:8178-8181`), so the envelope is owed and not
  delivered in exactly the case 0019 describes.
- **Test gap from the review is closed for the delegation door.** `toolCancel` is now applied to
  a `delegate` call: `src/harness.delegation.test.ts:973` ("delivers the child forensics when
  toolCancel releases the delegation"), with the marker pinned at `:1027`. Nothing pins a
  reason-level discriminator, because none exists.
- Status stays **Open**, severity **Minor**. *(Dated correction, 2026-11-14 third pass: superseded —
  the released door shipped, AC1/AC4 are met, AC3 is recorded as superseded, and the header now reads
  **Fixed** with AC2's third cause named as the open half. See the third-pass update.)*

### Citations for the update above, re-derived (2026-11-14, second pass)

The 03:50 pass cited `src/harness.ts` and `src/harness.delegation.test.ts` by the line numbers that
were live when it wrote them. Both files have moved since (the crate-side description pass and the
0019 owed-delivery work both edited `harness.ts`), so every address above was re-grepped by symbol.
The substance of the update is unchanged — nothing in it was disproved — only its line numbers:

| Statement above | Was | Is now (symbol-verified) |
|---|---|---|
| `toolCancel` acks `{ cancelled: true, callId, name }` immediately | `:8702-8715` | `:9110-9126` and `:9141-9149` (the two ack shapes; both unchanged in content) |
| The live delegation publishes a per-call trace (`DelegateCallTrace` / `delegateCallTraces`) | `:4307-4343` | type at `:4397`, map at `:4412`, and the three-place-grep comment that explains why the cancellation doors are not one surface at `:4304-4318` |
| …set at | `:4566` | `:4655` |
| …cleared in `delegateFor`'s own `finally` at | `:4739` | `:4828` |
| `onSettled` reads it synchronously in the cancel's own stack | `:8924-8934` | `:9358` (`onSettled`), `:9367` (`delegateCallTraces.get(callTraceKey(run.scope, call.id))`) |
| and hands it to `deliverTask` as the `released` argument | `:8154-8158` | `:9371` (`deliverTask(task, run, call, released)`); the parameter is declared at `:8296-8300` |
| the cancelled branch awaits the child's in-flight settle promise | `:8234` | `:8408` |
| and inserts the terminal envelope as the call's OWN tool message | `:8215-8239` | `:8394-8413`, with `releasedDelegateResultOf(released)` at `:8413` and the builder itself at `:4439-4476` |
| the harness sentence `Delegation to "<agent>" was cancelled by the caller before the call returned.` | `:4386` | `:4472` (`:4386` is now a comment about the "no result is available" door) |
| the child's real terminal `status` | `:4295` | carried by the same builder — `unfinishedDelegateEnvelopeOf` is declared at `:4341` and its three callers are `:4457` (released), `:4812` (timeout) and `:8759` (reprint), which is the three-place grep the comment at `:4318` names |
| the raw `"This operation was aborted"` stays in the child's record, stated in source | `:4359-4361` | `:4433` |
| `callCancelled` is present on exactly one door | `src/types/index.ts:1408-1414` | `src/types/index.ts:1430` (`callCancelled?: boolean`) |
| the generic "no result is available" sentence survives byte for byte | `:8201-8212` | `:8421` |
| a released delegation whose parent run has ended falls out before the released branch | `:8163-8176`, `:8178-8181` | `:8305` (`run.aborted`) and `:8326` (`!run.active`) — the same two doors 0019 records its owed-delivery captures at |
| the pin: `toolCancel` applied to a `delegate` call | `src/harness.delegation.test.ts:973`, marker `:1027` | `src/harness.delegation.test.ts:1600` (`delivers the child forensics when toolCancel releases the delegation`), AC1's classifiable-reason assertion `:1649`, the byte-for-byte ack pin (AC3) `:1659-1660`, and the untouched-record note `:1686` |

## Update (2026-11-14, third pass) — the released door re-read at the current tree; two shipped changes this pass had not recorded

Read from source and tests; **no test was executed by this doc pass**. Addresses are from the working
tree at 07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree). `src/harness.ts` was rewritten
during the pass (14,764 lines now, over 15,000 an hour earlier) and `src/harness.delegation.test.ts`
grew by roughly 600 lines, which is why every address in the second pass's table above has moved again.
The quoted identifiers are what should be re-grepped; the numbers are a snapshot.

- **Status: Fixed.** AC1 and AC4 are met and pinned; AC2 is met for the two doors the finding could
  observe and its third cause is declined-for-now, unchanged from the second pass; AC3 is **superseded**
  rather than met (below). The two body-section reductions are recorded at the end of this update.
- **AC1, re-read at the door that ships it.** `releasedDelegateResultOf` is now `src/harness.ts:4444-4482`.
  It addresses the child's record by the id the child wrote (`:4447`, `invocationRecords.get(...)`) with
  the `(parentScope, parentCallId)` pair as fallback (`:4452-4455`), returns `undefined` when the child
  registered no record (`:4456`, "the caller then gets the historical cancel sentence, which is what 'no
  invented identity' requires", `:4430-4433`), and raises the harness sentence
  `Delegation to "${trace.agent}" was cancelled by the caller before the call returned.` at `:4478`. The
  delivered bytes are pinned with exact values — `content: 'half an answer'`, `contentLength: 14`,
  `status: 'cancelled'`, `cancelledAtMessage: 2`, `error:` that sentence, `partialContent` and
  `callCancelled: true` — at `src/harness.delegation.test.ts:1638-1655`, with the `outcome: 'cancelled'`
  classification at `:1657`, and the child's own raw `"This operation was aborted"` still on the record
  at `:1688`.
- **A shipped change the second pass had not seen, and it narrows AC1.** The cancel sentence is no longer
  unconditional: `:4476-4478` passes `error` only when `record.status !== 'completed'`, because the
  contract makes `error` mean "did not finish" (`src/types/index.ts:1399-1400`, "Present only when
  `status` is not 'completed'"). A release races the child, so a child that answered a moment after the
  release reports `status: 'completed'` with **no** `error` and `callCancelled: true` as the only marker
  — reasoned out in the comment at `:4468-4475`, with the `record.status === 'completed'` test at `:4476`. **This branch has no pin.** Across all
  of `src/**/*.test.ts`, `callCancelled` appears exactly once (`src/harness.delegation.test.ts:1654`, the
  cancelled case), so nothing yet asserts the completed-after-release shape, and nothing asserts that the
  timeout door omits the key. Both are still owed.
- **AC3 — why "superseded", stated precisely.** The criterion asks `toolCancel` to return the terminal
  result when one exists. The control returns a receipt in every case and never the child's answer:
  `JSON.stringify({ cancelled: true, callId, name: task.name })` at `:9217` for a live release (after
  `scheduler.cancel` at `:9213`, whose comment says the receipt must already see an accurate pending
  list, `:9209-9212`), and `JSON.stringify({ cancelled: true, callId, name: settled.name, alreadySettled:
  true })` at `:9186-9192` (read off the settled tool message by `toolResultOf(brain, callId)` at `:9180`)
  for an id that had already settled — the R2 idempotence rule, stated at
  `:9146-9152` and answered by a **success**, not an error; only an id this run never started fails, at
  `:9204`. The second pass recorded the same conclusion for the older shape; the difference today is
  that the "already settled" case now says what it found instead of silently repeating the bare ack, and
  that is what makes the receipt genuinely distinct from the envelope by **type** (a JSON control receipt
  versus a JSON delegation envelope), which is what AC3's real requirement — never confuse the two —
  asks for. The prose-ack fear that motivated the "labelled line" idea is gone: there is no prose left to
  label.
- **The envelope's shape, re-read.** `unfinishedDelegateEnvelopeOf` is `:4347-4384`: `error` is optional
  (`:4358`, made so by 0019's owed reprint, comment `:4352-4357`) and `answer` is optional (`:4359`,
  documented at `:4343-4346` as the field the release door passes when the child answered anyway).
  It emits `agent`, the paged `content`, `contentLength`, `offset`, `limit`, `truncated`, conditional
  `nextOffset`, `invocationId`, conditional `threadId`, `status`, `durationMs`, then conditional `error`,
  `partialContent` and `cancelledAtMessage` (`:4364-4384`). **There is no `note` field on this envelope**
  — the release used to carry one and does not any more, so a caller that branches on `note` is reading a
  field that now belongs only to the placeholder paths (`:8260`, `:8298`).
- **The three-door note, at its current address.** The shared-shape heading is `:4290-4325`; it names
  this issue explicitly (`:4298-4303`, "That door used to answer 'no result is available' while the
  child's terminal record — status, error, partialContent, cancelledAtMessage, identity — sat in the
  ledger one call away"), states that what is single-sourced is the SHAPE and not the WORDING
  (`:4312-4313`), and lists the three sites that still raise a "did not finish" sentence in their own
  words (`:4314-4324`). The wording list is accurate as of this pass: the release line at `:4478`, the
  timeout line at `:4833` (`Delegation to "${target}" exceeded its ${timeoutMs}ms timeout and was
  stopped.`, with `record.error ?? toErrorInfo(error).message` beside it at `:4834`), the owed reprint
  passing the child's own `record.error` at `:8841` (call `:8832-8842`), and the no-record fallback at
  `:8494-8495`. AC4 holds: that timeout sentence is byte-identical to the one the Evidence table records
  from the 2026-11-11 runtime probe, and the generic sentence still answers every non-delegation release
  — `src/harness.sync-async.test.ts:460` pins
  `s2:Tool call "willCancel" (s2) was cancelled before it completed; no result is available.` **and** the
  receipt `c9:{"cancelled":true,"callId":"s2","name":"willCancel"}` at `:461`.
- **The trace plumbing, re-derived.** `type DelegateCallTrace` `:4403` (its "what a live `delegate` call
  leaves for the delivery layer" comment at `:4386-4402`), the map `:4418`, the key builder `:4422`, set
  at `:4670`, cleared in `delegateFor`'s own `finally` at `:4843`, read synchronously in the cancel's
  stack at `:9438-9441`, and passed as the `released` argument at `:9444`; `deliverTask`'s parameter is
  declared at `:8373`, the branch waits the child's settle promise at `:8481` and builds the envelope at
  `:8486`. The delivery-layer comment at `:8452-8470` cites this issue's pin by name
  (`src/harness.delegation.test.ts:1600-1655`) and calls the control's answer "the bare `{ cancelled,
  callId, name }` acknowledgement", which is the wording the third pass confirms at `:9217`.
- **Pins, with what each one holds.** `describe('delegation identity by value and cancel delivery (0029,
  0021)')` at `src/harness.delegation.test.ts:1363`; the case `:1600` "delivers the child forensics when
  toolCancel releases the delegation" — envelope `:1638-1655`, classification `:1657`, the byte-for-byte
  receipt `:1661-1663`, the exactly-one-result pin `:1664` (AC3's "unchanged ack" half), agreement with
  `agentResult` for the same `invocationId` `:1673-1683`, raw record string `:1688`. Idempotence is pinned
  in `src/harness.background.test.ts`: the pair of receipts for `k1` at `:2042-2044` (second one carries
  `alreadySettled: true`) with both outcomes `completed` and `isError: false` at `:2038-2040`, and the
  two-call variant at `:2144-2145`; the rule is announced in that file's header at `:53`.
- **Reduction, dated: two bullets left the Tests to add section.** "A parent-cancelled child: assert the
  envelope's `status`, the harness wording, and that the message is not 'This operation was aborted'" is
  shipped and pinned (`:1600`, assertions at `:1651`, `:1654`, `:1688`), so it is deleted. "The
  `toolCancel` test file — assert the acknowledgement shape is unchanged for an ordinary async tool" is
  shipped and pinned (`src/harness.sync-async.test.ts:460-461`, `src/harness.background.test.ts:2038-2045`
  and `:2144-2145`), so it is deleted — **with its second clause dropped rather than the bullet**: the
  criterion it tested ("a delegation whose result is already settled returns it") is the superseded half
  of AC3 and no test will ever assert it. What remains in that section is the reason-discriminator pin,
  because it is genuinely still owed: no test compares the two doors' reasons.
- **What this pass could not confirm.** Nothing about the original live session changed: the 2026-11-11
  probe rows in the Evidence table stay as recorded, and the `Temp/t12-verify/pre-fix-logs/c2a.log` pair
  that the in-source comment at `:8470` cites is scratch, not committed, so this pass treated it as
  unrepeatable rather than as evidence. The `caller-aborted` third cause of AC2 remains the owner's call,
  and no test asserts either new gap named above.

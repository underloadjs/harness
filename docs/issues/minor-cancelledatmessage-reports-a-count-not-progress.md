# 0022 — `cancelledAtMessage` counts committed messages, but is described as "how far it got"

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (run forensics), `src/tools/runtime/delegate.tool.ts` (description)
> **Date opened:** 2026-11-11

## Context

The `delegate` description says a cancelled child reports `cancelledAtMessage` "so you
can see what it had produced and how far it got". Four cancellations were observed
against children of very different lengths — one stopped after 62 ms, one after 9,962 ms
of generating a 700-word essay — and every one of them reported `cancelledAtMessage: 1`.
The field cannot separate a child that died instantly from one that worked for ten
seconds, so the sentence that advertises it overstates what the caller can learn.

## Gap

A caller post-mortem-ing a cancelled child needs a signal that scales with the work done.
A count of committed messages is a coarse proxy that saturates at 1 for the single case
that matters most — a child killed inside its first turn — which is where the field is
supposed to help. Either the field should measure progress, or the description should
stop claiming it does.

## Why it is the way it is

The value is defined as a rollback-surviving counter, not a progress measure:
`record.cancelledAtMessage = run.messagesProduced` at `src/harness.ts:3680-3682`, where
`run.messagesProduced = Math.max(0, brain.messages.length - commitIndex)` at `:10070`.
The comment at `:4704-4712` states the purpose — "`messagesProduced` is how many messages
this run had" — and the reason it is snapshotted is the transcript rollback that used to
erase every trace of a cancelled run. So a committed-message count is exactly what was
chosen, for a good reason; the mismatch is only in the advertised meaning, plus the fact
that a first-turn cancellation makes the count useless.

## Evidence

| Fact | Source |
|---|---|
| The field is the committed-message counter | `src/harness.ts:3680-3682` (`record.cancelledAtMessage = run.messagesProduced`), set at `:10070` |
| The stated purpose is a rollback-surviving count | `src/harness.ts:4704-4712` |
| The description advertises it as progress | `src/tools/runtime/delegate.tool.ts:164` ("so you can see what it had produced and how far it got") |
| It is emitted only when defined | `src/harness.ts:3680` guard, and `:4243-4245` in the envelope |
| Runtime, 2026-11-11: identical value across runs of wildly different length | invocations 21 (62 ms), 26 (9,962 ms), 33 (228 ms), 34 (268 ms) — all `cancelledAtMessage: 1` |

## Proposal

Report progress alongside the counter rather than replacing it, so the existing meaning
is preserved for anything that reads it: add the number of tool calls the child completed
and, when the run was inside a model round, that round's index — both are already
run-local state at the capture point (`:10068-10072`). Then narrow the description to
what the fields mean: committed messages, tool calls completed, and elapsed time
(`durationMs` already exists and does distinguish these four cases).

**Alternatives considered.**

- *Redefine `cancelledAtMessage` as a percentage.* Rejected: it is a published field with
  a pinned meaning, and a percentage has no denominator the runtime knows.
- *Drop the field.* Rejected: the count is genuinely useful for a child that ran several
  turns, and dropping it breaks consumers.
- *Say nothing and leave it.* Rejected: the description is the caller's only documentation
  of the field, and it is wrong for the common case.

## Acceptance criteria

1. Two cancelled children — one killed in its first turn, one killed after several turns
   — are distinguishable from the envelope without comparing `durationMs`.
2. `cancelledAtMessage` keeps its current value for a child that committed messages, so
   existing readers are unaffected.
3. The `delegate` description states what each forensic field measures, and no longer
   implies `cancelledAtMessage` measures elapsed progress.

## Tests to add

- `src/harness.delegation.test.ts` — a child cancelled during its first turn versus one
  cancelled after a tool round: assert the reported progress differs while
  `cancelledAtMessage` stays as pinned.
- `src/core/metadata.ownership.test.ts` — a pin that the description's wording of the
  forensic fields matches the emitted fields, so prose and record cannot drift again.

## Out of scope

- Capturing partial text (0020).
- The cancel-reason discriminator (0021).
- Changing `durationMs`.

## Update (2026-11-11) — independent review

- **Verdict: re-classified from "does not measure progress" to "correct by its own
  definition; the description overstates it".** The value is
  `run.messagesProduced = Math.max(0, brain.messages.length - commitIndex)`
  (`src/harness.ts:10070`), recorded at `:3680-3682`, where `commitIndex` is taken **before**
  the run appends its own user prompt (`:9806-9812`). So `1` means "this run appended its brief
  and nothing else" — arithmetically right for a first-turn abort, including the 9,962 ms one,
  because nothing else had been committed. The complaint is about the unit and the advertised
  meaning, not about a wrong number.
- **Root cause is shared with 0020.** Both fields are blind to uncommitted in-flight work. An
  implementer fixing 0020 should fix the reporting of progress in the same pass; this issue's
  Proposal (report tool calls completed and the current round index) is the half 0020 does not
  cover.
- Severity unchanged: **Minor**.

## Update (2026-11-14) — the wording half closed; the progress half delegated

- **The counter is untouched, which is what AC2 asked for.** `run.messagesProduced =
  Math.max(0, brain.messages.length - commitIndex)` is still captured before the splice
  (`src/harness.ts:11458`) and still recorded as `cancelledAtMessage` by `finishInvocation`
  (`src/harness.ts:3784`, next to the record's other forensic fields). Both surfaces emit it only
  when it exists (`:4177-4179` in `agentResult`, `:4301-4303` in the `delegate` envelope).
- **AC3 — met, in both descriptions and in the generated catalogue.** The sentence that advertised
  progress now says what the number is: "`cancelledAtMessage`, which counts committed messages
  rather than measuring progress" (`src/tools/runtime/delegate.tool.ts:99`) and "…`cancelledAtMessage`,
  which counts the messages that run had committed and is not a measure of progress" (`:213`), both
  regenerated into `src/core/metadata.ts:249` and `src/core/tool-manifest.ts:1193`. The neighbouring
  conflation the review did not name is gone too: `maxTurns` is now documented as a cap on model
  REQUESTS with "N allows at most N-1 tool rounds" (`src/tools/runtime/delegate.tool.ts:142`, the
  same rule stated in the entry's turn-gate comment at `:66-70` and as stress-report item #7), which
  is what made a "rounds" reading of `cancelledAtMessage` look plausible in the first place.
- **AC1 — not met, and the field it wanted is now filed elsewhere.** The proposal asked for the
  number of tool calls completed and, inside a model round, the round's index, so two children of
  different depth are tellable without comparing `durationMs`. Nothing like that shipped: the
  unfinished-run envelope is still `status` + `error` + `partialContent` + `cancelledAtMessage`
  (`src/types/index.ts:1399-1407`), so a child stopped at 62 ms and one stopped at 9,962 ms after a
  dozen tool rounds remain indistinguishable on the message count. The 2026-11-14 pass put that
  need into its own entry — `docs/issues/minor-cancelled-childs-tool-activity-leaves-no-addressable-record.md`
  (0032) proposes a bounded `toolActivity` tally captured at the same point — so AC1 of this entry
  and 0032's field are the SAME work. The owner should fix one and close the other by reference
  rather than adding two counters.
- **Tests, and why the pin this entry asked for is still missing.** There is no test in
  `src/harness.delegation.test.ts` comparing the reported progress of a first-turn cancellation
  against a multi-round one, and **no pin that the description's wording of the forensic fields
  matches the emitted fields** — the closest are a presence assertion
  (`src/harness.metadata.test.ts:710`, the description must contain `partialContent`) and the
  schema/prose pins for `timeoutMs` and `maxTurns`
  (`src/core/metadata.ownership.test.ts:477-492`, `:495-557`), none of which covers the forensic
  sentences. Since 2026-11-14 those sentences are the ONLY place the true meanings are written for a
  model, an unguarded drift here re-creates the issue.
- Status stays **Open** (AC1 outstanding, delegated to 0032), severity **Minor**.

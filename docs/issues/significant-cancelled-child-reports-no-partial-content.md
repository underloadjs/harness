# 0020 — A child cancelled before it committed a turn reports no `partialContent`, though the description promises it

> **Status:** Open
> **Severity:** Significant
> **Area:** `src/harness.ts` (run forensics), `src/tools/runtime/delegate.tool.ts` (description)
> **Date opened:** 2026-11-11

## Context

`delegate` tells its caller that a child which did not finish is still worth reading:
"A cancelled or failed child still returns its `partialContent` and `cancelledAtMessage`
instead of an empty record, so you can see what it had produced and how far it got."
Four cancellations were observed. None of them carried a `partialContent` key at all —
not the three 1 ms timeouts, and not a child aborted by `toolCancel` after **9,962 ms**
of generating a 700-word essay. For that last one the parent paid ten seconds of model
time and got back an envelope with nothing in it: `content: ""`, `contentLength: 0`, and
`agentResult` for the same invocation also returned `content: ""`, `contentLength: 0`.
The mechanism exists and is tested; it just does not cover the case that actually
happens — a child killed while producing its first and only turn.

## Gap

The caller needs the child's in-flight text, not only its committed text. A delegated
run that is cancelled mid-generation is the common case — that is exactly what a
timeout or a `toolCancel` of a long answer does — and in that case the run has committed
nothing, so `partialContent` is absent and the parent cannot tell "the child said
nothing" from "the child said nine seconds of prose that was thrown away". The field is
also omitted rather than present-and-empty, so the documented "instead of an empty
record" promise is indistinguishable from the record being empty.

## Why it is the way it is

The forensics are captured from committed state on purpose. `finishInvocation` copies
`run.partialContent ?? run.answer?.content` into the record only when the value is a
non-blank string (`src/harness.ts:3684-3687`), and `run.partialContent` is set from
`lastSubstantiveText(brain.messages, commitIndex)` (`:10071`, helper at `:9730`) — that
is, the last substantive **committed** assistant text before the rollback point. The
comment at `:4704-4712` states the intent: the counters are taken from the run's own
state "never from a transcript read, so they cannot leak system instructions or tool
bodies", and they exist to survive the transcript rollback. Reading only committed
messages is therefore a deliberate leak-and-rollback boundary, not an oversight. What
was not accounted for is that an aborted first generation has no committed assistant
message, so the boundary excludes the only content the caller wants. The behaviour is
pinned today by `src/harness.delegation.test.ts:636` ("reports a cancelled child as a
structured result instead of an empty record") and `:723` ("stops a frozen child and
reports its partial work") — both of which use children that had already committed
something.

## Evidence

| Fact | Source |
|---|---|
| The description promises `partialContent` for any unfinished child | `src/tools/runtime/delegate.tool.ts:164` — "A cancelled or failed child still returns its `partialContent` and `cancelledAtMessage` instead of an empty record, so you can see what it had produced and how far it got" |
| The envelope omits the key entirely when the record has none | `src/harness.ts:4240-4242` (`...(record.partialContent === undefined ? {} : { partialContent: record.partialContent })`), with `content` derived from `record.partialContent ?? ''` at `:4221-4222` |
| Capture reads committed messages only | `src/harness.ts:10071` (`run.partialContent = lastSubstantiveText(brain.messages, commitIndex)`), helper `:9730`; recorded at `:3684-3687` behind a non-blank guard |
| Runtime, 2026-11-11: parent-cancelled child after 9,962 ms of prose | `delegate` envelope: `status: "cancelled"`, `content: ""`, `contentLength: 0`, `durationMs: 9962`, **no** `partialContent` key; `agentResult { agent: "general", invocationId: "26" }` → `content: ""`, `contentLength: 0`, `error: "This operation was aborted"` |
| Runtime, 2026-11-11: three timeout cancellations behaved identically | invocations 21, 33, 34 — no `partialContent` key in any envelope |
| The existing tests cover children that had already committed text | `src/harness.delegation.test.ts:636`, `:723` |

## Proposal

Capture the in-flight assistant text at abort, from the same source the run already
holds, and keep the leak boundary intact. In the abort path beside `:10071`, when
`lastSubstantiveText` finds nothing committed, fall back to the partial assistant text
the run was assembling (the streamed assistant content for the current turn, which is
run-local state and contains no system instructions and no tool bodies). Emit
`partialContent: ""` explicitly whenever the child is `cancelled` or `failed`, so the
field contract holds and "said nothing" is a stated fact rather than a missing key. Then
say in the description what the field actually contains when it is empty.

**Alternatives considered.**

- *Read the child's transcript for the partial turn.* Rejected: `:4704-4712` exists
  precisely to avoid reading the transcript for forensics, and the rollback may already
  have truncated it.
- *Keep the field absent and only fix the prose.* Rejected: it leaves ten seconds of
  generated work discarded, which is the consumer-visible loss, not just a wording bug.
- *Persist the whole partial turn as `content`.* Rejected: `content` is the answer page;
  mixing an unfinished draft into it would break the `agentResult` continuation contract
  that 0019's delivery fix depends on.

## Acceptance criteria

1. A child cancelled during its first generation reports a non-empty `partialContent`
   whenever it had streamed substantive assistant text before the abort.
2. A child cancelled with nothing to show reports `partialContent: ""` (key present) and
   `cancelledAtMessage`, so the envelope shape for an unfinished run is stable.
3. `partialContent` never contains system instructions or a tool body — the existing
   leak boundary still holds.
4. `agentResult` for the same invocation reports the same `partialContent` the envelope
   reported.
5. The description's "you can see what it had produced and how far it got" is true for
   the timeout case, or the sentence is narrowed to say when it is not.

## Tests to add

- `src/harness.delegation.test.ts` — a child whose first turn is aborted mid-stream after
  emitting text: assert `partialContent` carries that text and `content` stays empty.
- `src/harness.delegation.test.ts` — a child aborted before emitting anything: assert
  `partialContent: ""` is present and `cancelledAtMessage` is reported.
- `src/harness.delegation.test.ts` — a leak guard: a child that called a tool before the
  abort; assert `partialContent` contains neither the system prompt nor the tool result
  body.
- Extend the existing pins at `:636` and `:723` to assert the key is present in both
  cases rather than merely that the record is non-empty.

## Out of scope

- Resuming or retrying a cancelled child.
- Streaming partial text to the parent before the child finishes.
- Delivery of the envelope itself (0019) and the `toolCancel` receipt (0021).
- What `cancelledAtMessage` counts (0022).

## Update (2026-11-11) — independent review

- **Verdict: confirmed, severity unchanged (Significant), attribution corrected in one
  place.** The capture is not "broken": `run.partialContent` is set from
  `lastSubstantiveText(brain.messages, commitIndex)` (`src/harness.ts:10071`, helper `:9730`)
  and recorded when non-blank (`:3684-3687`), and the two existing cancel tests pass because
  their children had already committed text. The accurate statement is that the capture reads
  **committed** messages only, so it is structurally blind to in-flight streamed text — which
  is the only text a child killed inside its first generation has produced. The description at
  `src/tools/runtime/delegate.tool.ts:164` is over-broad for that case.
- **The strongest evidence was under-played as filed.** The 9,962 ms child aborted mid-essay
  is the case that carries this issue: ten seconds of model work, discarded, with `content: ""`
  and no `partialContent` key. Lead with it.
- **A related finding belongs to 0021, not here.** For a parent-initiated `toolCancel` the
  envelope is not merely sparse, it is structurally unreachable: the scheduler releases the
  task and treats a late resolution as data on a dead task (`src/core/scheduler.ts:281-298`),
  so the parent gets the acknowledgement (`src/harness.ts:7399`) and never the envelope it
  caused.
- **Cross-surface inconsistency found during the review, to be decided here.** The cancelled
  `delegate` envelope carries the partial twice — paged in `content` and whole in
  `partialContent` (`src/harness.ts:4221-4245`) — while `agentResult`'s cancelled shape has no
  `partialContent` key at all and puts the same text in `content` (`:3929-3957`). A caller
  paging a partial answer has to know which surface it is on. Fixing the capture should settle
  one representation and say so in both descriptions.
- **Test gap confirmed.** Both cancel tests (`src/harness.delegation.test.ts:636`, `:723`) use
  children that had already committed something, and neither asserts `partialContent` for
  uncommitted in-flight text — which is precisely why this survived.

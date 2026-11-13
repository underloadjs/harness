# 0020 — A child cancelled before it committed a turn reports no `partialContent`, though the description promises it

> **Status:** Fixed — 2026-11-14 (AC1: the in-flight streamed answer is now the evidence that
> ships; **AC2 remains declined by design** — absent-means-silent, and the owner decision recorded
> in the 2026-11-14 review update still stands; the **worker-mode forensic half** that the
> durability update left open is closed the same day — third-pass update below)
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

## Update (2026-11-13) — the cross-surface inconsistency the review raised, settled (B3)

- **`agentResult` now has the key.** The review's last bullet — the cancelled `delegate` envelope
  carrying the partial twice (paged in `content`, whole in `partialContent`) while `agentResult`'s
  cancelled shape had no `partialContent` key at all — is closed in the direction of "both surfaces
  carry it": the cancelled/failed `agentResult` shape pages the partial exactly like a completed
  answer and adds the WHOLE partial beside the page (`src/harness.ts:4138-4183`, the field at
  `:4163-4173`, present only when the run actually said something so a "failed on its first
  request" envelope stays byte-for-byte what it was). The same shape is pinned for a forked branch
  through `agentResult` in `src/harness.fork.test.ts:1886-1914`.
- **The two surfaces agree by test, not by prose**: `src/harness.delegation.test.ts:1049` pins the
  `agentResult` read of the same invocation against `stored.partialContent`, next to the envelope's
  own `partialContent: 'half an answer'` (`:1025`, `:1054`). That is **AC4** of this entry, met.

## Update (2026-11-14, partial fix) — the description and the tool-trace half (T5 pass)

- **The capture is still what this entry said it was.** `run.partialContent` is set from
  `lastSubstantiveText(brain.messages, commitIndex)` at the rollback point
  (`src/harness.ts:11453-11459`) and recorded behind the non-blank guard (`:3887-3889`). Nothing
  reads in-flight streamed text, so a child killed inside its FIRST generation — the case this
  issue leads with — still has nothing to report.
- **Acceptance criteria, honestly.**
  1. *Non-empty `partialContent` for a child cancelled during its first generation* — **not met**.
     No in-flight/streams capture was added; the case that motivated the entry is unchanged.
  2. *`partialContent: ""` present for an unfinished run with nothing to show* — **not met**, and
     not by accident: the shipped rule is "absent means it never said anything", stated at both
     emission sites (`src/harness.ts:4169-4173` in `agentResult`, `:4298-4300` in the envelope) and
     in the type (`src/types/index.ts:1401-1404`, "Present only for a non-completed run that had
     said something substantive"). The owner has to choose: either the stable-shape criterion here
     wins, or the byte-for-byte-compatibility rule wins and AC2 should be rewritten to match it. As
     shipped, an absent key is the documented answer, so **AC2 as written is the criterion the fix
     pass declined.**
  3. *The leak boundary holds* — **met and unchanged**: the record's own comment still states that
     the forensic fields are taken "from the run's own state, never from a transcript read, so they
     cannot leak system instructions or tool bodies" (`src/harness.ts:3776-3783`).
  4. *`agentResult` reports the same value the envelope reported* — **met** (B3, above).
  5. *The description is true for the timeout case, or narrowed* — **met by narrowing**: the
     sentence no longer claims a caller can see "what it had produced" tout court; it now reads
     "A child that did not finish keeps its error plus the last assistant TEXT it committed as
     `partialContent` — its tool calls and tool results are rolled back and not retained — and
     `cancelledAtMessage`, which counts committed messages rather than measuring progress"
     (`src/tools/runtime/delegate.tool.ts:99`), with the same narrowing in the full description
     (`:213`: "partialContent — only the LAST assistant TEXT that run committed") and regenerated
     into `src/core/metadata.ts:249` and `src/core/tool-manifest.ts:1193`.
- **The other half of what a killed child loses is now its own entry.** This issue's **Out of
  scope** said "Capturing partial text (0020)" and nothing about the tool blocks. The tool
  calls/results a stopped child made are also gone, and the fix that closed AC5 explicitly refuses
  to widen `partialContent` to carry them: that gap is filed as
  `docs/issues/minor-cancelled-childs-tool-activity-leaves-no-addressable-record.md` (0032), which
  also carries the provider-pairing reason (`src/server/persistence.ts:1655-1675`) why retaining the
  rolled-back messages is not a free fix.
- **Line drift for re-checkers.** The `src/harness.delegation.test.ts` pins this entry cites as
  `:636` and `:723` are now `:642` ("reports a cancelled child as a structured result instead of an
  empty record") and `:1082` ("stops a frozen child and reports its partial work"); both still use
  children that had committed something, and neither asserts `partialContent` for uncommitted text,
  so the test gap the review recorded stands.
- Status stays **Open**, severity **Significant**.

## Update (2026-11-14, durability) — the partial this issue captures is now stored, not just projected (0033)

The gap this entry describes is the **capture** point — committed assistant text only — and that
half is still open. What changed on this date is downstream of it: whatever this issue's capture
decides to store is now **durable**. `partialContent` and `cancelledAtMessage` joined the persisted
agent-result row (`src/types/index.ts:3368`, `:3374`), the snapshot projection emits them
(`src/harness.ts:12341-12344`) and `restore()` re-attaches them (`:12691-12696`), with the reader
accepting them as optional so pre-existing files still load
(`src/core/snapshot.ts:139-140`, `:148`, `:251-273`). Before that, a session that stopped and
started again answered the same `invocationId` with `content: ""` and no `partialContent` key at
all, so a caller reading a cancelled child after a restart saw less than the caller saw before the
restart — the loss this entry set out to fix was, for that reader, still total.

Consequences for this entry, stated so the remaining half is not over- or under-counted:

- **AC5's leak boundary is untouched.** The durable value is exactly the value the record already
  held; no transcript read joined the projection, so nothing system-instruction-shaped or
  tool-body-shaped can reach `state.json` through this field.
- **A fix to the capture point now needs no persistence work.** Whatever this entry settles on —
  in-flight text at abort, or an explicit `partialContent: ""` for a stopped run — is stored and
  restored by the existing pair of keys, with one exception worth naming: `""` is refused by the
  reader (`min: 1`, `src/core/snapshot.ts:251-256`), so if this entry's AC2 (a stable
  present-and-empty key) is taken up, the reader bound has to move with it, or the shape will fail
  to load. That is a decision for this entry, recorded here rather than in 0033.
- **`durationMs` is still not persisted**, deliberately: 0033 rejects it as a per-process
  measurement, so a restored row answers for the run's span only when the same process still holds
  the live record.
- **The worker-mode half is still open.** A lane-archived result is not written through the snapshot
  projection: `src/server/workers/lane-worker-loop.ts:1084-1098` builds the `result:archive`
  operation from `content` and `error` only, and `archiveInvocation` stores `content: ''` for a
  non-completed status (`src/harness.ts:7200`) with no input field for a partial
  (`src/types/index.ts:3385`). So in `worker` mode a cancelled child loses the pair without any
  restart — the same symptom this entry reports, through a different door, and 0033's **Out of
  scope** says so rather than claiming the whole path.
- Status stays **Open**, severity **Significant**. See
  `docs/issues/significant-cancelled-childs-partial-content-is-lost-across-a-restart.md` (0033).

## Update (2026-11-14, second pass) — AC1 shipped; the review's "not met" finding is superseded

Read from the current source and tests; **no test was executed by this doc pass**. The 03:52 review
update recorded AC1 as "**not met**: no in-flight/streams capture was added". That capture exists
today, so the finding is superseded — and the entry's headline defect, a child killed inside its
first generation reporting nothing, is closed.

- **AC1 met at the capture point, with the priority order written down.** `src/harness.ts:11927-11938`
  decides `run.partialContent` as `run.streamedText` when that buffer is non-blank and
  `lastSubstantiveText(brain.messages, commitIndex)` otherwise, and the comment above it states the
  rule and its edge cases: "The in-flight buffer is the FRESHER evidence and wins; an empty buffer
  means the run really had nothing in hand, so the committed text is reported exactly as before." The
  buffer itself: declared on `RunState` at `:5340`, initialised at `:12422`, reset when a model
  request opens at `:11373`, appended per `text` delta at `:11409`, dropped when the request closes on
  a non-text boundary at `:11428`, and cleared after capture at `:11938` — so a later request can never
  concatenate an earlier request's prose into one partial.
- **Four pins, one per direction.** `src/harness.delegation.test.ts:482` — "a cancelled child reports
  the answer it was streaming (issue 0020 AC1)": `:522` reports the in-flight text on cancel;
  `:558` is the leak/scope guard, asserting **only** the prose of the request that was in flight and
  not earlier transcript text; `:622` proves the model-facing timeout door reports the same partial
  (AC4's two-surface agreement, by behaviour rather than by prose); `:662` pins the empty case — a
  child cancelled before it streamed anything gets **no `partialContent` key at all**.
- **AC2 still declined, and the reader is what locks it.** `src/core/snapshot.ts:262-268` refuses a
  `partialContent: ""` (`min: 1`), and the capture comment at `:11930-11933` explains that this is
  deliberate: "the empty case stays empty (no synthetic empty string), which is what keeps the
  snapshot reader's `min: 1` guard meaningful: a present `partialContent` always says the child did
  say something." The choice the 03:52 update put in front of the owner — stable shape versus
  byte-for-byte compatibility — is therefore still unresolved and still its to make; if it is taken
  up, the capture point and the reader bound move together.
- **AC3-AC5 unchanged, addresses refreshed.** The leak boundary comment is `src/harness.ts:3781`;
  `agentResult`'s cancelled/failed emission is `:4216-4227` (the "byte-for-byte what it was" reasoning
  is in the comment at `:4216-4219`), and the envelope's is `:4373`. The type keys are
  `src/types/index.ts:1420` / `:1423`, with the persisted twins at `:3381` / `:3387` (0033).
  AC5's narrowed sentence is still in all four authored sites — `src/tools/runtime/delegate.tool.ts:124`
  and `:238`, `src/core/metadata.ts:249`, and regenerated at `src/core/tool-manifest.ts:1193` — so the
  03:52 update's `:99` / `:213` citations are the stale pair; 0024's update carries the three-site map.
- **Re-deriving the 03:52 update's "line drift" paragraph, which has itself drifted.** It maps the
  entry's original pins to `src/harness.delegation.test.ts:642` and `:1082`; today those two tests are
  `:1269` ("reports a cancelled child as a structured result instead of an empty record") and `:1709`
  ("stops a frozen child and reports its partial work"). Both still use children that had produced
  something, which is why the four cases at `:482` had to be added rather than reused.

## Update (2026-11-14, third pass) — the worker-mode forensic half is closed

Read from the current source and tests; **no test was executed by this doc pass** (only
`yarn tools:manifest:check`, which reported `tool-manifest.ts is current (32 descriptors)`). The
addresses below were read from the working tree at 07:45-08:05 on 2026-11-14; `src/harness.ts`,
`src/types/index.ts` and the three `src/server/workers/lane-*.ts` files all moved during the pass, so
these line numbers are a snapshot of a dirty worktree at HEAD `cef43af` — the quoted identifiers are
the durable part of each citation.

**Claim verified:** the durability update's bullet "**The worker-mode half is still open.**"
(`:229-237` as written there). **It is closed.** A lane-archived cancellation now records the forensic
pair at every hand-off, and each end refuses a malformed pair instead of coercing one:

| Hand-off | Where the pair now lives | What pins it |
|---|---|---|
| The archive input | `src/types/index.ts:3448` (`partialContent?`) and `:3451` (`cancelledAtMessage?`) on `HarnessInvocationArchiveInput` | — (type) |
| The core's archive | `archiveInvocation` at `src/harness.ts:7264` validates the pair (`:7313-7329`, through `readSnapshotString` / `readSnapshotInteger`), stores it (`:7358`) and **returns** the row including it (`:7385`) | `src/harness.agent-results.test.ts:2213` — "the archive seam carries the forensic pair of a stopped run"; `:2236` stores it on the row AND returns it, `:2282` drops it on a completed archive, `:2347` refuses a malformed pair with no row and no burned completion order |
| The op identity | `archiveDigestOf` at `src/server/workers/lane-commit.ts:142` digests the pair (`:166-167`) | `src/server/workers/lane-commit.test.ts:1393` — the pair changes the digest (`:1418-1422`), `completedOrder` (`:1425`) and `threadId` (`:1427`) do not |
| The fold | `readArchiveForensicPair` at `src/server/workers/lane-commit.ts:199`; the `result:archive` case validates FIRST and rejects `invalid-mutation` (`:1006-1024`), then writes the pair on both paths (`:1083` replace, `:1123` new row) | `src/server/workers/lane-commit.test.ts:913` — carries the pair, refuses a malformed one without touching canonical state (`:956`, `:981`, `:995`, `:1008`, `:1053`) |
| The authority | `src/server/workers/lane-authority.ts:1167-1170` forwards both fields into the core's own archive; `:1192-1196` reports `invalid-mutation` | `src/server/workers/lane-authority.test.ts:604` (the pair lands on the canonical row, with the writer-side digest) and `:691` (a malformed pair is refused before canonical state moves, and burns no completion order) |
| The lane | `src/server/workers/lane-worker-loop.ts:1112-1113` emits the pair on the `result:archive` operation | `src/server/workers/lane-worker.test.ts:1414` — `:1486` names the pair on the op, `:1490` skips only a row whose canonical digest already covers it, `:1506` sends neither field for a completed record; `src/server/workers/lane-worker-correctness.test.ts:497` runs the chain end to end against the **source** worker |

- **AC2's declined shape is what the worker leg ships too.** The lane comment at
  `src/server/workers/lane-worker-loop.ts:1106-1111` states the same rule as the inline capture: the
  pair is spread "only when present … An absent partial means the run said NOTHING substantive, and
  `''` would be a different claim". So this pass does not reopen the stable-shape question; it extends
  the answer.
- **Corrections to the addresses that bullet cited.** `src/server/workers/lane-worker-loop.ts:1084-1098`
  is no longer the archive-operation builder (the pair comment now runs `:1099-1111`, the spread
  `:1112-1113`); `src/harness.ts:7200` no longer lands on the `content: ''` store (the rule sits in the
  pair guard at `:7358`); and `src/types/index.ts:3385` is now the **persisted** row's
  `cancelledAtMessage`, not the archive input. The behaviour each of those three supported — no input
  field, no projection, canonical state empty — is gone.
- **What remains of this entry is not worker mode.** The capture point is closed (second pass); the
  remaining loss around a stopped child is the rolled-back **tool activity** with no addressable
  record, which is 0032
  (`docs/issues/minor-cancelled-childs-tool-activity-leaves-no-addressable-record.md`), and the
  durable-half work is 0033. The two `Status stays **Open**` lines inside the 03:52 review update
  (`:200`) and the durability update (`:236`) were true when written and are superseded by the header;
  the header governs, and this entry is fixed.

**Reduction, dated 2026-11-14 (third pass).** Nothing was removed from the title, Gap, Evidence,
Proposal, Acceptance criteria or Tests to add by this pass: those sections describe the capture point,
which the second pass closed. The closed worker-mode half lived entirely inside an Update, and per the
log rule ("corrections go in a dated Update rather than rewriting the section above") that bullet
stands as written and is corrected here.

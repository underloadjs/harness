# 0032 — A cancelled or failed child's tool calls and results leave no record the caller can address

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (the cancelled-run rollback and its forensic capture), `src/server/persistence.ts` (the provider-pairing repair that explains the rollback)
> **Date opened:** 2026-11-14
> **Found by:** the 2026-11-14 `delegate`/thread stress pass, after 0020's partial-text half had already shipped. The pass's report file is not in the tree, so the live observation below is recorded as an observation, not an artifact.

## Context

An unfinished run is described by what it left in the invocation record: `status`, `error`,
`cancelledAtMessage`, `durationMs` and `partialContent`. 0020's fix and the 2026-11-14
description pass made that set honest — `partialContent` is "the LAST assistant TEXT that run
committed", and the description now states plainly that "its tool calls and tool results are
rolled back and never retained". Being honest about the loss does not close it. A child that was
stopped while it was WORKING (its turns were tool rounds, which is what a research or file
child does) leaves an account with a name, a status, a count of committed messages and no trace
of the activity itself.

The stress pass hit the sharpest version of this: one child ran a long chain of tool calls
before it was cancelled, its `partialContent` was empty — it had committed no assistant text
between rounds — and the parent's whole account of ten seconds of work was `status: "cancelled"`,
`cancelledAtMessage` (a message count, see 0022) and an empty answer. Answering "what did it
actually do?" meant reading the rollback in `src/harness.ts`, not calling something.

## Gap

Three consumers are each stopped by the same missing byte:

- **The parent agent**, deciding whether to re-delegate, narrow the brief or fix the tools, has
  no signal that distinguishes "did fifty useful lookups" from "retried one doomed call fifty
  times". Both report the same envelope.
- **A host or plugin** doing post-mortems on a stopped child cannot enumerate the calls it made:
  `threadRead` on the child answers with the conversation from BEFORE the run, because the run's
  own messages are spliced out.
- **An operator** budgeting a fleet of long-running children cannot see which tool a runaway
  child was hammering, so `maxTurns`/`timeoutMs` are set blind.

In a server deployment there IS a durable record of the activity — the per-session event journal,
`<databaseRoot>/harness/sessions/<sessionId>/events.jsonl` (`src/server/journal.ts`), read back as
`GET …/turns/:turnId/events` — but it is operator-addressed by TURN id, is not reachable by the
model at all, and does not exist in an inline library deployment. Whether a delegated child's own
`tool` frames are folded into the parent turn's journal is **unconfirmed** by this pass
(`src/server/sessions.ts:7431-7454` and `:8409` are the two recorders; neither was traced through
the delegation path).

**Severity, argued against the log's three levels.** Not **Blocking**: nothing core breaks — the
cancellation lands, the parent gets a truthful envelope, and it can re-delegate. Not
**Significant**: nothing documented as working fails, and the description was corrected in the same
window to state the loss plainly (`src/tools/runtime/delegate.tool.ts:99`, `:213`), so a caller is
not misled — which is the bar 0020 clears for **Significant**: there, a field the description
promised was actually discarding the caller's work. This is a non-critical capability on an
exceptional path: **Minor**. The
case for re-rating it Significant is the fleet operator: there is no *supported* post-mortem
channel inside the library, and the one outside channel (the session event journal) is
turn-addressed, operator-only, and unproven for child frames. If the owner settles that a
delegated child's tool frames are journalled and readable, it stays an ergonomics gap; if they are
not, the observability loss on long tool-heavy children is the argument to raise it.

## Why it is the way it is

The rollback is load-bearing, not incidental:

1. **Provider pairing.** A restored conversation must not contain an assistant `toolCalls` block
   whose ids are unanswered — "an OpenAI-compatible endpoint would reject the transcript" — which
   is why the persistence layer repairs committed-but-unanswered calls by synthesizing
   `INTERRUPTED_TOOL_RESULT_TEXT` (`src/server/persistence.ts:1655-1675`, `:1713-1723`). A
   cancelled run's messages are not repaired, they are REMOVED (`brain.messages.splice(commitIndex)`,
   `src/harness.ts:11474`), which is the cheapest way to keep the resumed transcript coherent, and
   the rule that lets the conversation keep working after a stop.
2. **The leak boundary.** The forensic values are read from the RUN's own state, never from a
   transcript read, "so they cannot leak system instructions or tool bodies"
   (`src/harness.ts:3776-3783`, restated at the capture point `:11453-11459`); 0020's **AC3**
   makes that a criterion, not a suggestion. A tool RESULT body is exactly what that boundary
   keeps out — which is why the surviving field is the run's last committed assistant text and not
   its transcript tail.
3. **Retention.** The record ledger is bounded (`AGENT_RESULT_RETENTION = 64`,
   `src/core/agent-limits.ts`), so a per-invocation forensic payload has to be small and capped,
   not a transcript copy.

So both obvious fixes are already claimed by other issues: keeping the rolled-back messages
contradicts (1), and widening `partialContent` contradicts (2) and is explicitly out of 0020's
scope. What is left is a third shape: a bounded, SEPARATE field that reports the activity without
carrying its text.

## Evidence

| Fact | Source |
|---|---|
| A cancelled/failed run splices its own messages out of the transcript | `src/harness.ts:11442-11474` (`run.active = false`, forensics captured, then `brain.messages.splice(commitIndex)`) |
| The two forensic values are run-local counters plus the last COMMITTED assistant text | `src/harness.ts:11458-11459` (`run.messagesProduced`, `run.partialContent = lastSubstantiveText(brain.messages, commitIndex)`), recorded at `:3887-3889` behind a non-blank guard |
| Nothing else about the run's tool activity survives into the record | `AgentInvocationRecord`'s forensic fields are `error`, `cancelledAtMessage`, `partialContent`, `durationMs` (`src/harness.ts:3783`, `:5238-5242`); there is no tool-activity field |
| The description states the loss rather than fixing it | `src/tools/runtime/delegate.tool.ts:99` and `:213` — "its tool calls and tool results are rolled back and never retained" |
| The knowledge doc tracks it as unbuilt work | `knowledge.md`, "Not built yet" item 9 ("no surviving record of what a killed child DID … see issue 0032") |
| A lone unanswered `tool_calls` block is what the provider pairing rule refuses | `src/server/persistence.ts:1655-1675` (the repair exists for COMMITTED calls: `:1713-1723`) |
| A server deployment keeps the frames, addressed by turn, not by invocation | `src/server/journal.ts:8` (`…/sessions/<sessionId>/events.jsonl`), appended per event at `src/server/sessions.ts:5129-5159`; the read route is `GET …/turns/:turnId/events` (`src/server/api-events.ts:203`) |
| Whether a delegated child's frames reach the parent turn's journal | **unconfirmed** — the two recorders are `src/server/sessions.ts:7431-7454` and `:8409`; not traced through the child-run path by this pass |
| Live, 2026-11-14 stress pass: a cancelled child with a long tool chain reported an empty answer and no activity trace | stress pass observation; the report file is not in this repo, so the specific counts (calls, tokens, elapsed) are the pass's own account and were not re-measured here |

## Proposal

Add a bounded, SEPARATE forensic field to the terminal record and surface it on the two unfinished
-run surfaces (`delegate`'s envelope and `agentResult`'s cancelled/failed shape) — the same
surfaces that already carry `partialContent`. Its content is the run's OWN tool activity,
captured from the scheduler/task state at the existing capture point
(`src/harness.ts:11453-11459`, before the splice), and it carries NO tool result bodies. The
minimum that answers the gap is a per-name tally:

```
toolActivity?: {
    calls: number;                       // registered invocations this run made
    settled: number;                     // of those, how many produced a result
    byName?: Array<{ name: string; calls: number }>;  // capped list, e.g. 8 names, ordered by count
    truncated: boolean;                  // the cap closed the list, not the run
};
```

Three properties make it safe: it is **separate** (so `partialContent`'s text-only contract and
0020's leak criterion are untouched), it is **bounded** (a fixed cap on entries and no free text
beyond tool names, which are already public), and it is **never replayed** — the field lives on the
record, not in any message, so provider pairing, `threadRead`, snapshot restore and every
continuation path behave exactly as they do today. Emit it for completed runs too if the owner
wants the same field shape everywhere; for a completed run the transcript already carries the
calls, so the field is a convenience rather than the only account.

**Alternatives considered.**

- *Retain the rolled-back messages on the child thread.* Rejected: it breaks (1) — a resumed
  conversation would show calls with no results, the exact shape the persistence repair exists to
  avoid — and it would make `threadRead` on a stopped child show work that the harness itself
  declared never happened.
- *Widen `partialContent` to hold the tool blocks.* Rejected: 0020's **AC3** forbids it, the
  field is text, and tool result bodies are the thing the leak boundary keeps out.
- *Tell callers to read the server's event journal.* Rejected as the whole answer: it does not
  exist in an inline library deployment, it is addressed by turn rather than by invocation, and
  the model has no route to it (0021's complaint about a second, unaddressable channel applies
  verbatim).
- *Emit more `toolEvent` lifecycle frames and call that the record.* Rejected: events are
  ephemeral for a library consumer, unpaged, and not joinable to an `invocationId` after the fact.

## Acceptance criteria

1. A run that was cancelled or failed AFTER calling at least one tool reports what tools it
   called, in a field separate from `partialContent`.
2. The field is bounded by construction (a fixed ceiling on entries and bytes), and when the cap
   closes it, the result says so instead of implying the run stopped there.
3. The leak boundary holds: the field carries no tool RESULT body and no system-instruction text,
   and its values come from the run's own state at the capture point.
4. `agentResult` for the same invocation reports the same value the `delegate` envelope reported.
5. Nothing about the transcript changes: the splice stays, `threadRead` on a stopped child answers
   with the pre-run conversation, a restored transcript needs no new repair, and the provider
   pairing pins do not move.
6. A run that registered no invocation (refused before it started) reports NO field rather than a
   zero-shaped one, so "did nothing" and "reported nothing" stay distinguishable — the same
   no-invented-identity rule as 0029.
7. The `delegate`/`agentResult` descriptions name the field and its bound.

## Tests to add

- `src/harness.delegation.test.ts` — a child cancelled inside a tool round (the existing gated-tool
  fixtures): assert the envelope's activity field names the tool and the call count, and that
  `partialContent` is unchanged from what the same fixture reports today.
- `src/harness.delegation.test.ts` — a child cancelled before any tool call: assert the field is
  absent, not `{ calls: 0 }`.
- `src/harness.agent-results.test.ts` — the same invocation read through `agentResult` answers with
  the same value, page-stable and byte-identical to the envelope's.
- `src/harness.thread-runtime.test.ts` or `src/harness.task.test.ts` — the cap: a child with more
  distinct tool names than the ceiling reports `truncated: true` and stays inside the byte bound.
- A pairing guard in the existing persistence suite: a cancelled child with tool calls, snapshot +
  restore, and the next request still accepted (the pin that the rollback contract did not move).

## Out of scope

- Retaining the rolled-back transcript, or resuming/retrying a cancelled child (still out, as in
  0020).
- Changing what `partialContent` contains, or its capture point (0020).
- Changing the unit or meaning of `cancelledAtMessage` (0022).
- The cancel-reason discriminator (0021).
- The server event journal's own retention, paging, or whether a child's frames are folded into
  its parent's turn — that is an operator-side surface, and this issue does not propose to change
  it.

## Update (2026-11-14) — the surviving half of a stopped child is now stored, so `toolActivity` inherits a durable home

This entry's premise — "the only thing that survives is the run's last committed ASSISTANT TEXT" —
is unchanged, and so is the proposal. What moved is where that survivor lives: as of
`docs/issues/significant-cancelled-childs-partial-content-is-lost-across-a-restart.md` (0033),
`partialContent` and `cancelledAtMessage` are part of the PERSISTED agent-result row
(`src/types/index.ts:3368`, `:3374`; projection `src/harness.ts:12341-12344`; restore
`:12691-12696`; reader `src/core/snapshot.ts:139-148`, `:251-273`). Three consequences for the work
this entry proposes:

- **A `toolActivity` field has a durable slot to join, and the same rules to satisfy.** The reader
  validates an exact key list per row, so a new forensic field must be added there as a MAY-BE-ABSENT
  key (the 0033 pattern) or every old file and every new file disagree. It must also be refused on a
  `completed` row if it is only ever a stopped-run fact, or `restore -> snapshot` stops being
  idempotent for it (`src/core/snapshot.ts:266-273` is the precedent).
- **The size argument this entry's proposal leans on is still a one-string argument.** 0033 added a
  second TEXT field to a row without doubling the bytes, because `content` and `partialContent` are
  mutually exclusive per record (`src/harness.ts:3879-3890`, `:7200`). A `toolActivity` tally is a
  separate axis, so its own bound is still this entry's to define — it does not ride on 0033's
  reasoning.
- **Worker mode is still the weaker door.** A lane-archived result carries `content` and `error`
  only (`src/server/workers/lane-worker-loop.ts:1084-1098`), and `archiveInvocation` has no input
  field for a partial (`src/types/index.ts:3385`), so a lane-archived cancelled result has neither
  the text nor any tally. If this entry ships, the archive operation shape needs the field too, or
  the feature exists in one execution mode only.

Status stays **Open**, severity **Minor**.

### Citations re-derived (2026-11-14, second pass)

`src/harness.ts`, `src/core/snapshot.ts` and `src/types/index.ts` all moved under the later passes
today, so the addresses in this entry's **Evidence** table and in the 2026-11-14 update were re-grepped
by symbol. **The findings are unchanged** — the splice still erases the tool blocks, and the record
still has no tool-activity field — only the line numbers. Read from source; no test was executed by
this doc pass.

| Statement | Was | Is now |
|---|---|---|
| a cancelled run splices its own messages, after the forensics are captured | `src/harness.ts:11442-11474`, capture `:11453-11459`, `:11458-11459` | the capture block is `:11927-11938` — `run.messagesProduced` at `:11927` and `run.partialContent` decided at `:11934-11937` (0020's in-flight buffer now wins over `lastSubstantiveText`, which strengthens rather than weakens this entry: the surviving field is still **prose only**) — and the splice itself is `brain.messages.splice(commitIndex)` at `:11953` |
| the two forensic values are recorded behind a non-blank guard | `src/harness.ts:3887-3889`, `:3879-3890` | `:3877-3890` still holds the terminal-status decision and both writes (`:3877` classifies `cancelled` vs `failed`) |
| the record's forensic fields, and no tool-activity field | `src/harness.ts:3783`, `:5238-5242` | `AgentInvocationRecord` is declared at `:3758`, `partialContent`/`cancelledAtMessage` at `:3783-3784`, and the leak-boundary comment at `:3781` is unchanged; `:5238` is now `RunState.replyThreadId` (0030), so read the record shape at `:3758-3790` and the envelope's twin at `src/types/index.ts:1398`, `:1420`, `:1423` |
| the persistence pairing rule and its repair | `src/server/persistence.ts:1655-1675`, `:1713-1723` | the "Interrupted-turn transcript repair (T25/T26)" block starts at `:1653` and `repairAgentMessages` is `:1679`, with `repairInterruptedToolCalls` exported at `:1735` |
| the durable row's keys, projection, restore and reader | `src/types/index.ts:3368`, `:3374`; `src/harness.ts:12341-12344`, `:12691-12696`; `src/core/snapshot.ts:139-148`, `:251-273`, `:266-273` | `:3381`/`:3387`; `:12810-12813`; `:13175-13180`; reader list `:139-148`, refusal precedent `:251-268` — and the row gained a THIRD optional key today, `threadId` (`src/types/index.ts:3405`, 0027's C6), which is the same idempotency trap this entry warns about: a new forensic field must join the may-be-absent list and be refused where it does not belong, or `restore -> snapshot` stops being idempotent for it |
| one answer string per record, and the archive rule | `src/harness.ts:3879-3890`, `:7200` | `:3877-3890`, and `archiveInvocation`'s rule is `:7295` (def `:7249`) |
| the lane operation's shape | `src/server/workers/lane-worker-loop.ts:1084-1098`, `src/types/index.ts:3385` | `:1083-1105` and `HarnessInvocationArchiveInput` at `:3416-3431`. The claim "carries `content` and `error` only" is still true for the forensics, but the op now ALSO carries `threadId` (stated from `lane.targetId`, comment at `:1100-1105`) — so this entry's warning that the archive shape needs the field is no longer theoretical: the shape has already moved once, and the comment justifying that move is itself stale, because the snapshot row now carries `threadId` too |
| the roadmap entry | `knowledge.md`, "Not built yet" item 9 | confirmed present — `knowledge.md:5833` is the "Not built yet" heading and **item 9** is `:5901-5913`, which names this issue; the loop section also cites it at `:1796` |

## Update (2026-11-14, third pass) — the worker-mode bullet above is now false, and the addresses moved again

Read from source; **no test was executed by this doc pass**. Addresses are from the working tree at
07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree); `src/harness.ts` was rewritten twice during
the pass (14,764 lines today, over 15,000 an hour earlier), so the quoted identifiers are the durable
part of each citation and the bare line numbers are a snapshot.

- **The premise is unchanged and the entry stays Open.** `grep -rn toolActivity src/` returns nothing:
  the rolled-back tool activity still leaves no record the caller can address, and the bounded tally
  proposed here is still the only proposal for it.
- **Correction: "Worker mode is still the weaker door" no longer says what the tree says.** A
  lane-archived result now carries the FORENSIC PAIR, not just `content` and `error`: the archive input
  declares `partialContent?`/`cancelledAtMessage?` (`src/types/index.ts:3448`, `:3451`),
  `archiveInvocation` validates them, stores them and returns them with the row (`src/harness.ts:7264`,
  guard `:7313-7329`, store `:7358`, return `:7385`), `archiveDigestOf` digests them
  (`src/server/workers/lane-commit.ts:142`, fields `:166-167`), the `result:archive` fold validates
  BEFORE it writes (`:199`, `:1006-1024`, `:1083`, `:1123`), the authority forwards them
  (`src/server/workers/lane-authority.ts:1167-1170`, refusal `:1192-1196`) and the lane emits them
  (`src/server/workers/lane-worker-loop.ts:1112-1113`). So a lane-archived cancelled result DOES have
  the text. What survives of this entry's warning is the narrower, still-live half: a `toolActivity`
  field has to join that same input-and-fold-and-emit chain, or the feature exists in one execution
  mode only. 0020's and 0033's third-pass updates tabulate the identical hand-offs with their tests.
- **The second-pass table row "the lane operation's shape" is superseded on its central claim** ("still
  true for the forensics"), which the bullet above disproves. Its `threadId` half is confirmed, and the
  stale comment it called out has since been corrected in-source — 0027's third pass cites the
  correction at `src/server/workers/lane-worker-loop.ts:1120-1125`.
- **Addresses re-derived for the bullets that stand.** Capture block `src/harness.ts:11995-12011`
  (`run.messagesProduced` at `:11999`, the streamed-buffer decision at `:12007-12010`, buffer dropped
  at `:12011`), the splice at `:12026`; the terminal-status decision and both forensic writes at
  `:3878-3899` (`:3882-3883` classifies `cancelled` vs `failed`, the non-blank guard at `:3897`);
  `AgentInvocationRecord` at `:3764` with `partialContent`/`cancelledAtMessage` at `:3789-3790` and the
  no-leak comment at `:3787`; the envelope's twin at `src/types/index.ts:1420`, `:1423`; the durable
  row's keys at `:3381`, `:3387` (plus `threadId` at `:3405`); the reader's may-be-absent list at
  `src/core/snapshot.ts:139-140`, its read-not-dropped group at `:159`, its bounded reads at `:262-277`,
  and the completed-row refusal — the precedent any new forensic field must copy — at `:291-296`.
  `src/server/persistence.ts` still resolves at the cited `:1654`/`:1679`/`:1735`, and the roadmap entry
  is unchanged (`knowledge.md:5833`, item 9 at `:5901-5912`, loop-section citation at `:1796`).
- **One citation inside this file's 2026-11-14 update is corrected.** `src/harness.ts:7200`, cited there
  for the one-string rule, no longer lands on it: the mutual-exclusion rule sits in the archive pair
  guard at `:7358`, and the record-level writes are at `:3880` (a COMPLETED run's `content`) and
  `:3896-3898` (every other terminal outcome's `partialContent`).

Status stays **Open**, severity **Minor**. Nothing was removed from the nine sections by this pass — the
gap itself is untouched — because what changed is one sentence inside an earlier Update, contradicted by
another entry's fix the same day.

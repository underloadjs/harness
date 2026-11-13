# 0033 — A restarted session reports a cancelled child's answer as empty: the forensic partial was never part of the persisted record

> **Status:** Fixed — 2026-11-14 (the durable row now carries the pair; the worker-mode leg closed
> the same day — see the third-pass update; what is still owed is named in **Tests to add**)
> **Severity:** Significant
> **Area:** `src/harness.ts` (the `agentResults` snapshot projection and `restore()`),
> `src/core/snapshot.ts` (the snapshot reader), `src/types/index.ts`
> (`HarnessAgentResultSnapshot`)
> **Date opened:** 2026-11-14

## Context

0020 made a cancelled child's last committed text visible, and 0022 fixed the wording of the
position counter beside it. Both were fixes to the **live** record. The 2026-11-14 durability
pass put that pair in front of the door a chat product actually uses: a session that stops and
starts again. The server snapshots every harness (`src/server/sessions.ts:3126`) and reloads it
from `state.json` on the next start, and `agentResult` is the only way to read a finished child
after that reload. Before the restart, a child stopped mid-answer reported its partial and the
message it stopped at; after the restart, the same `invocationId` answered `content: ""` with
**no `partialContent` key at all** — the answer the caller had been shown a moment earlier had
been destroyed by the round trip through the file. Nothing in the docs warned about it: the
durable shape is described as "terminal results", and a terminal result looks like exactly that.

## Gap

What a stopped run produced and how far it got has to be **stored state**, not a live
projection: the same terminal invocation must read the same way before and after `restore()`,
in both execution modes, for every terminal state — and a file written before the storage
exists must still load. Today the pair lives only in memory: `finishInvocation` stamps
`partialContent` and `cancelledAtMessage` on the in-process record
(`src/harness.ts:3883-3890`), and both readers project them from that record
(`src/harness.ts:4170-4178` for `agentResult`, `:4296-4303` for the `delegate` envelope). A
consumer that wants the partial after a restart has to keep its own copy of every cancelled
child's answer, which is the duplicated-code half of "Significant".

## Why it is the way it is

The persisted agent-result row was defined around **the answer**, not around the forensics: the
union carries `status`, `content` (the completed answer) and `error`, and the projection writes
`content` for every terminal state (`HEAD:src/harness.ts:11597-11610`). When 0020 and 0022 added
the forensic pair they added it to the live record and the two envelope readers, and the
snapshot union and its reader were not touched. The reader is strict **on purpose**: it declares
the exact key list a row may carry and refuses anything else, so an unexpected key in
`state.json` is a corrupt file rather than a forward-compatible one
(`HEAD:src/core/snapshot.ts:122-137`, with the completed-row refusal for the one optional key at
`:211`). That strictness is why this could not be fixed in the projection alone — the reader and
the type had to change with it, and why the fix had to keep old files valid.

## Evidence

Every line below is the state as shipped at the date opened (`HEAD` of this package); the
post-fix lines are in **Proposal** and in **Tests to add**.

| Fact | Source |
|---|---|
| The live envelope carries the pair | `src/types/index.ts:1411` (`partialContent?`), `:1414` (`cancelledAtMessage?`) on the `delegate` result envelope |
| The in-process record is stamped with both, from the run's own counters before the rollback | `src/harness.ts:3883-3890` (`finishInvocation`, def `:3859`) — `cancelledAtMessage = run.messagesProduced`, `partialContent` behind a non-blank guard |
| Where that text comes from | `src/harness.ts:11478` (`run.partialContent = lastSubstantiveText(brain.messages, commitIndex)`) — committed assistant text only, which is 0020's narrower gap, not this one |
| Both readers project the pair off the live record | `src/harness.ts:4170-4178` (`agentResult`'s cancelled/failed shape), `:4298-4303` (`delegateFor`'s unfinished envelope, def `:4446`) |
| The persisted row type had no forensic key | `HarnessAgentResultSnapshot`, `HEAD:src/types/index.ts:3241` (now `:3322`) — `status` / `content` / `error` |
| The projection writes nine fields and no partial | `HEAD:src/harness.ts:11597-11610` — `content: record.content` for every terminal state; `partialContent`/`cancelledAtMessage` absent |
| `restore()` rebuilds the row from those fields only | `HEAD:src/harness.ts:11928-11946` (`content: result.content` at `:11946`) — so a restored cancelled row is `status: 'cancelled'`, `content: ''`, `error: …` and nothing else |
| The reader validates an exact key list, one optional key | `HEAD:src/core/snapshot.ts:122-137` (required keys + `['error']`), `:211` (`snapshot.agentResults[N].error must be absent on a completed result.`) |
| The server persists the snapshot verbatim — no field list to update | `src/server/persistence.ts:1131-1132` (`core` is only `requireRecord` + a `version` check); written at `src/server/sessions.ts:2281` (create), `:3126` (re-snapshot on persist), `:3294` (`core: session.core` into the record) |
| The HTTP contract does not describe this row at all | `src/server/harness.swagger.yaml` and `src/shared/harness-api.ts` contain **0** occurrences of `agentResult`, `agentResults`, `partialContent` or `HarnessAgentResultSnapshot` — `agentResult` is a model-facing tool answer, not a DTO, so no contract regeneration is owed |
| The archive path already enforces one answer string per row | `src/harness.ts:7200` (`content: status === 'completed' ? input.content ?? '' : ''`) and `:3879-3890` (the completed branch writes `content`, every other status writes `partialContent`) — so `content` and `partialContent` are mutually exclusive on any record, live or archived (`archiveInvocation`, def `:7154`) |
| Retention is unchanged by the new keys | `src/core/agent-limits.ts:25` (`AGENT_RESULT_RETENTION = 64`), enforced per array at `src/core/snapshot.ts:112-116` |
| Runtime, 2026-11-14 (the fixture in `src/server/threads.test.ts:3051`, run before the fix): a parked child cancelled at the server door | live `agentResult`: `status: 'cancelled'`, `error: 'operator stop'`, `partialContent: 'half an answer'`, `cancelledAtMessage: 2`; after `stop` + reload of the same `state.json`: `content: ''` and **no** `partialContent`/`cancelledAtMessage` keys, for the same `invocationId` |
| The lead's completed row is unaffected either way | same fixture — `{ invocationId: '1', sequence: 1, completedOrder: 2, status: 'completed', content: 'lead answer' }` carries no forensic key before or after the change |

## Proposal (what shipped)

Two **optional** keys on the persisted union, stored and rebuilt exactly as the live record
holds them, with the reader widened to accept — but never require — them:

- `HarnessAgentResultSnapshot.partialContent?: string` and `.cancelledAtMessage?: number`
  (`src/types/index.ts:3368`, `:3374`).
- The projection emits each only when the record has it (`src/harness.ts:12341-12344`), and
  `restore()` re-attaches the pair on the rebuilt record (`src/harness.ts:12691-12696`).
- The reader adds both to the MAY-BE-ABSENT list (`src/core/snapshot.ts:139-140`, `:148`) and
  reads them with the existing bounded helpers (`:251-263`): `partialContent` needs ≥ 1
  character, `cancelledAtMessage` is a safe integer ≥ 0 — the value `0` is legitimate, because a
  run cancelled inside its first turn has committed nothing (0020's case).
- Both are refused on a `completed` row, beside the existing `error` refusal
  (`src/core/snapshot.ts:266-273`), because the runtime never writes that shape: a completed run
  answers with `content`.

**Size.** No new bound was added, and none is needed: a row holds at most ONE answer string,
because `content` is written only for a completed run and `partialContent` only for the other
terminal states (`src/harness.ts:7200`, `:3879-3890`). A file of ≤ 64 rows
(`src/core/agent-limits.ts:25`) therefore carries the same single answer string per row it
carried before — the worst case per row moves from `content` to `partialContent`, never to both.

**Old files.** The keys are optional, so a `state.json` written before this change validates
exactly as it did (`src/core/snapshot.ts:139-148`, pinned at
`src/harness.agent-results.test.ts:1932`). **New files on an old reader** still fail: an old
build's strict key list rejects `partialContent` as an unknown key. That direction was already
true of every added snapshot field (`error`, `threads`, `turns`) and is a deployment concern, not
a format decision.

**Alternatives considered and rejected.**

- *Fold the partial into `content` at projection time.* It would restore the text, but it would
  also make `content` mean "the answer" on one row and "whatever the run last said" on the next,
  and a completed row would be indistinguishable from a cancelled one that happened to commit an
  answer. `agentResult`'s paging and 0032's proposed `toolActivity` both key off that difference.
- *Store the whole live envelope.* `restore()` would get the pair for free, but the envelope also
  holds `durationMs` (a per-process measurement) and the paged answer body, so the file would
  carry fields the runtime cannot rebuild — and the reader would stop being a description of the
  format.
- *Persist `durationMs` too.* Rejected on purpose: it is this process's wall-clock span of the
  run, not state. A restored row that reported a duration would assert a measurement the reload
  never made, and `delegate`'s envelope documents it as the delegation's own measurement. It
  remains unpersisted (see **Out of scope**).
- *Accept `partialContent: ""`.* Rejected: the runtime never writes an empty one (the guard is
  `trim().length > 0`), so accepting it would let a hand edit restore a shape no live run answers
  with — the same argument the reader already makes for `error`
  (`src/core/snapshot.ts:236-249`, `:266-273`).
- *Add a fourth forensic field for "what it was doing" instead.* That is 0032's `toolActivity`
  proposal, and it is a different gap; this one is only about the pair the runtime already
  reports.

## Acceptance criteria

1. A `cancelled` run with a partial: `snapshot()` writes both keys, `restore()` re-attaches them,
   and the next `agentResult` for that `invocationId` is byte-identical to the pre-snapshot
   answer — same `content`, same `partialContent`, same `cancelledAtMessage`.
   → `src/harness.agent-results.test.ts:1779`
2. A `failed` run's partial survives the same round trip.
   → `src/harness.agent-results.test.ts:1844`
3. A `state.json`-shaped snapshot from the previous generation (no forensic keys) still restores,
   with the same answer it gave before — no new field is required of an old file.
   → `src/harness.agent-results.test.ts:1932`
4. A file the runtime could not have written is refused with one sentence and changes no live
   state: an empty `partialContent`, a negative or fractional `cancelledAtMessage`, a non-string
   partial, and either key on a `completed` row.
   → `src/harness.agent-results.test.ts:2023`
5. At the server door: a parked child cancelled through `store.cancelThread`, the session
   persisted, the store reloaded from `state.json`, and the answer re-read — the live envelope,
   the on-disk row, the reloaded envelope and the re-written row all agree on `content`,
   `partialContent` and `cancelledAtMessage`; the lead's completed row still carries neither key.
   → `src/server/threads.test.ts:3051`
6. The wire contract is untouched: `yarn tools:manifest:check` is current and
   `src/server/harness.swagger.yaml` / `src/shared/harness-api.ts` gain no key.
7. The model-facing descriptions say the partial is durable, so a caller does not re-implement
   its own copy: `src/tools/runtime/agentResult.tool.ts:42-…`,
   `src/tools/runtime/delegate.tool.ts:36-…`, `knowledge.md:1782-1792` and `:1828-1836`.

## Tests to add

Shipped with the fix:

- `src/harness.agent-results.test.ts:1692` — `the forensic partial survives persistence
  (issue 0033)`: AC1 (`:1779`), AC2 (`:1844`), the old-generation file (`:1932`), the four
  malformed-value refusals with the live state checked unchanged afterwards (`:2023`). The
  `durationMs` asymmetry (present live, absent after restore) is asserted inside AC1 so the
  unpersisted field is a pinned fact rather than an omission.
- `src/server/threads.test.ts:3051` — AC5, the full server round trip through the file on disk.
- `src/server/workers/lane-authority.test.ts`, `src/harness.snapshot.test.ts` and
  `src/harness.delegation.test.ts` continue to pin the surrounding contracts unchanged.

Still owed:

- A live eviction case for the same record shape — 0029's caveat names the same limitation. The
  retention bound is pinned only with completed rows (`src/harness.agent-results.test.ts:1161`,
  "retains at most 64 results and snapshot restores that bound"), so nothing asserts what a caller
  reads when a **cancelled** row with a partial is the one the bound evicts.
- A `restore()`-then-address case: a rebuilt record carries the forensic pair but **no**
  `parentScope` / `parentCallId` (`src/harness.ts:13268-13289`), and `delegatedRecordOf` matches on
  exactly that pair (`:4500-4517`). So after a reload the pair-addressed doors — 0024's pending
  placeholder, 0019's dropped-delivery probe, 0021's released-call fallback — answer "no record"
  for a child that is in fact in the ledger. No test pins that shape, because no test restores a
  delegation and then reads it by parent address.

## Out of scope

- What `partialContent` contains, and capturing the in-flight text of a first-turn cancellation
  (0020). This issue persists whatever the runtime decided to store; it changes nothing about the
  capture point or the leak boundary.
- The unit and meaning of `cancelledAtMessage` (0022) — persisted here as the committed-message
  counter it is documented to be.
- Carrying the child's tool calls and results (0032).
- `durationMs` durability, rejected above.
- Any change to the retention bound (64), the paging, or the HTTP contract — the row is not a
  DTO, and this issue must not grow into making it one.

## Update (2026-11-14, second pass) — citations re-derived, and the worker leg re-checked

The inline/snapshot fix is unchanged and still verified; `src/harness.ts` and
`src/harness.agent-results.test.ts` both moved under the earlier passes today, so every address in
the **Proposal**, **Acceptance criteria** and **Tests** sections above was re-grepped by symbol. Read
from source; **no test was executed by this doc pass**.

| Statement above | Was | Is now |
|---|---|---|
| the persisted type carries the pair | `src/types/index.ts:3368`, `:3374` | `:3381` (`partialContent?: string`), `:3387` (`cancelledAtMessage?: number`), with the mutual-exclusion rule stated at `:3364` and this issue's own history at `:3345-3364` |
| the projection emits each only when present | `src/harness.ts:12341-12344` | `:12810-12813` |
| `restore()` re-attaches the pair | `src/harness.ts:12691-12696` | `:13175-13180` |
| the reader's may-be-absent list | `src/core/snapshot.ts:139-140`, `:148` | unchanged — `:139-140`, `:148`; the "read, not dropped" list that now also carries 0027's `threadId` is `:159` |
| a completed row refuses the forensic keys | `src/core/snapshot.ts:266-273` | `:251-268` (the `partialContent: ""` and `cancelledAtMessage: 0` reasoning is at `:251-252`) |
| the completed-row `error` rejection | `src/core/snapshot.ts:211` | `:233` |
| the retention bound and its enforcement | `src/core/agent-limits.ts:25`, `src/core/snapshot.ts:112-116` | unchanged — `agent-limits.ts:25` (`AGENT_RESULT_RETENTION = 64`), `snapshot.ts:114-116` |
| `archiveInvocation`'s one-answer-per-row rule | `src/harness.ts:7200`, def `:7154` | `:7295`, def `:7249`, exported at `:14283` |
| where the partial text comes from | `src/harness.ts:11478` | `lastSubstantiveText` def `:11541`, called at `:11937` |
| the persistence describe and its four cases | `src/harness.agent-results.test.ts:1692`, `:1779`, `:1844`, `:1932`, `:2023` | describe `:1706`; cases `:1797` (cancelled, both delete doors), `:1890` (failed), `:1980` (old-generation row without the keys), `:2071` (a forensic value the runtime cannot write is refused) |

- **The worker-mode claim was re-checked from the operation, not the doc, and stands.** The op at
  `src/server/workers/lane-worker-loop.ts:1083-1105` carries `invocationId`, `sequence`,
  `completedOrder`, `agent`, `role`, `runKind`, `status`, `content`, optional `error` and `threadId`
  (stated from `lane.targetId`, with the "Stress report #6 (2026-11-14)" comment at `:1100-1105`);
  `HarnessInvocationArchiveInput` (`src/types/index.ts:3416-3431`) has `threadId?: string` but
  **neither** forensic key, and `archiveInvocation` forces `content: ''` for any non-completed status
  (`:7295`). So there is no channel for the pair in worker mode at all, exactly as **Out of scope**
  says — and the leg stays open. Note the asymmetry the C6 closure in 0027 created: the archive input
  DID gain `threadId`, so the operation shape is not frozen; adding the pair is now a digest-and-shape
  change, not a precedent.
- **One thing the earlier pass could not know is now true, and it does not close this issue.** The
  durable row also carries `threadId` today (0027's C6), which is why `src/harness.agent-results.test.ts:1797`
  asserts the restored conversation's delete receipt matches the live one. That is 0027's criterion
  riding on the same fixture, not a second claim by this entry.

## Update (2026-11-14, third pass) — the worker leg is closed; the status says so

Read from source and tests; **no test was executed by this doc pass** (only
`yarn tools:manifest:check` → `tool-manifest.ts is current (32 descriptors)`). Addresses are from the
working tree at 07:45-08:05 on 2026-11-14, HEAD `cef43af` with a dirty worktree: `src/harness.ts`,
`src/types/index.ts` and all three `src/server/workers/lane-*.ts` files were rewritten during the
pass, so the quoted identifiers — `partialContent`, `archiveDigestOf`, `readArchiveForensicPair`,
`delegateCallTraces` — are the durable part of each citation and the bare line numbers are a snapshot.

- **The worker-mode leg the second pass declared open is closed**, and with it the last gap this
  entry itself named. The pair now travels all four worker hand-offs and is refused, not coerced, at
  both ends: `HarnessInvocationArchiveInput` (`src/types/index.ts:3448` / `:3451`, with the rule
  spelled out at `:3431-3447`), `archiveInvocation` validating (`src/harness.ts:7313-7329`) and
  storing (`:7358`) and returning it (`:7385`), `archiveDigestOf` digesting it
  (`src/server/workers/lane-commit.ts:166-167`), the fold validating before it writes
  (`:1006-1024` → `:1083` / `:1123`), the authority forwarding it
  (`src/server/workers/lane-authority.ts:1167-1170`) and reporting `invalid-mutation` (`:1192-1196`),
  and the lane emitting it (`src/server/workers/lane-worker-loop.ts:1112-1113`). The pins are listed
  in 0020's third-pass update; the end-to-end chain is
  `src/server/workers/lane-worker-correctness.test.ts:497`.
- **Three citations in the second-pass bullet "…and the leg stays open" no longer support it**: the
  archive operation is built at `src/server/workers/lane-worker-loop.ts:1087-1113`, not `:1083-1105`,
  and it now names both fields; `HarnessInvocationArchiveInput` is `src/types/index.ts:3416-3452` and
  carries `partialContent`/`cancelledAtMessage`, so "`threadId?` but **neither** forensic key" is no
  longer the type; and `archiveInvocation` is `src/harness.ts:7264` (def), whose `content: ''` rule
  sits beside the pair guard at `:7358` rather than at `:7295`. The asymmetry that bullet recorded —
  "the archive input DID gain `threadId`, so the operation shape is not frozen" — is exactly how the
  pair got in.
- **The second-pass address table has drifted again.** Current: the persisted pair is
  `src/types/index.ts:3381` / `:3387` inside `HarnessAgentResultSnapshot` (def `:3331`), whose
  mutual-exclusion and size argument is `:3344-3346` and `:3362-3371`, with the "ABSENT, never empty"
  and "covers the answer it was still STREAMING" note at `:3373-3380`; the projection writes the pair
  at `src/harness.ts:12913-12916` (not `:12810-12813`) and `restore()` re-attaches it at
  `:13278-13283` (not `:13175-13180`); the reader's may-be-absent keys are `src/core/snapshot.ts:139-140`
  and `:148`, its read-not-dropped list `:159`, its bounded reads `:262-277`, and the completed-row
  refusal of the pair is `:291-296` (not `:251-268`); the persistence describe is
  `src/harness.agent-results.test.ts:1711` with cases `:1802` (cancelled, and the delete-cascade
  parity inside it), `:1895` (failed), `:1985` (old-generation row) and `:2076` (a forensic value the
  runtime cannot write). `src/core/agent-limits.ts:25` and the server fixture at
  `src/server/threads.test.ts:3051` still resolve as cited.
- **What is genuinely still owed, re-checked rather than assumed.** The retention bound is pinned
  only with completed rows (`src/harness.agent-results.test.ts:1161` asserts ids under the 64 cap, not
  a forensic row's survival), and a restored record is rebuilt without `parentScope`/`parentCallId`
  (`src/harness.ts:13268-13289`) while `delegatedRecordOf` addresses children by exactly that pair
  (`:4500-4517`) — so the pair-addressed doors go quiet after a reload even though the row is intact.
  Both are now in **Tests to add**.
- **Verified by absence, stated as such.** The pair is on disk and in the model-facing readers, and
  nowhere in the server's own surfaces: `grep -rn "partialContent\|cancelledAtMessage" src/server
  --include='*.ts'` with `*.test.ts` and `src/server/workers/` removed returns no hits, and
  `src/frontend/` returns none. That is consistent with the existing **Out of scope** bullet ("the row
  is not a DTO"), so it is reported here rather than filed as a gap: a UI still has to call the
  `agentResult` tool to show a stopped child's text.
- **Not re-derived by this pass.** The second pass's claim that an in-flight content projection
  "overwrites the older committed tail", and the two boundaries it called untested. This pass only
  re-confirmed the persistence facts above; if that ordering claim is still load-bearing, it needs its
  own pass.
- **`knowledge.md` contradicts shipped code in two places (reported, not edited — that file is outside
  this pass).** `knowledge.md:2961-2975` still states the C6 finding as live — "`threadId` is never
  persisted — `HarnessAgentResultSnapshot` has no such field (`src/types/index.ts:3315-3333`), and
  neither the snapshot projection (`src/harness.ts:12311-12324`) nor the restore that re-inserts the
  records (`src/harness.ts:12651-12663`) carries one" — against the field at `src/types/index.ts:3405`,
  the projection at `:12926`, the restore at `:13288` and the reader at `src/core/snapshot.ts:285-288`.
  And `knowledge.md:1794-1796` still calls a row's partial "the last COMMITTED assistant TEXT", which
  understates the capture since 0020 AC1 (the per-request streamed buffer wins,
  `src/harness.ts:12005-12007`).

**Reduction, dated 2026-11-14 (third pass).** Per the log's reduction rule the closed part was deleted
outright from the body rather than annotated: the first bullet of **Out of scope** ("**The worker-mode
archive leg is open.**", with its four stale addresses) and the first bullet under **Tests to add →
Still owed** ("The worker-mode leg: a lane-archived cancelled result … has no test") are gone, and the
**Still owed** list was replaced with the two cases this pass could actually confirm. The **Status**
line no longer carries "the worker-mode leg is NOT closed by this change".

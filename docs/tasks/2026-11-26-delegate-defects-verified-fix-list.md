# Delegate / agents-control defects — verified fix list

> **Status:** **Implemented 2026-11-26** — every item below was re-verified against HEAD and, where it
> survived verification, fixed. This file is now the record of that pass, not an open brief: each item
> carries its outcome and the evidence that closes it, and every claim this file made that HEAD
> contradicted is kept, marked **`corrected`**.
> **Tree:** `packages/underload/harness` at HEAD **`cabfeff`** (a nested repository — **every change
> described here is an uncommitted working-tree change**). `packages/typecrate/harness` (HEAD
> **`39090d0`**) and `packages/loadscript/harness` were also touched. **Group D remains host/UI and was
> not touched.**
> **Area:** delegation, `agentResult`, `threadSend`/`threadFork`, result ledger.
> **Date:** 2026-11-26 — verification, then implementation.
> **Not a new issue file.** The findings that belong in the issue log were folded into **0007**
> (`docs/issues/review-list-improvements-review-list.md`, whose `## Update (2026-11-26)` section carries
> the three Group C refutations, the C2 refutation, the B3 wording that landed, a **Second wave**
> sub-section with B1 / B2 / `toolCancel` / B5 / the loadscript correction, and the P1 row's corrected —
> still **open** — status). **0032 shipped and is CLOSED** — its file is deleted, its index row dropped,
> and its surviving notes live in 0007.

## Provenance

Three runs produced the material here. No one of them is trusted; the **Verification** work described
below is what this pass actually re-checked, and the outcomes say what HEAD turned out to say.

| Run | What it was | Where |
|---|---|---|
| **IT3** | `delegate` + agents-control stress test, ~40 live probes | `thread-46`, label `IT3`, invocation `49` (final report at transcript index 143) |
| **IT4** | `threadFork` branch of IT3 — the 15,957-char tool-contract essay | `branch-8`, invocation `branch-8` |
| **This pass** | Independent re-verification of IT3's claims, plus four new findings, **then the fixes** | `thread-62`, label `IT7`, invocation `72` |

The docs the brief described are dated 2026-11-19; the fixes landed 2026-11-26 against `cabfeff`.
**Two of IT3's findings had already been fixed in that gap** (Group A), all **five** Group B items
survived verification and shipped — two of them as prose only — three of Group C were refuted and one
was re-scoped by measurement and then fixed under an owner decision.

## How to read this file now

The rules this file opened with are the rules it was written under, and they bound what is below:

1. An item that did not reproduce was **not deleted** — it is recorded with the refutation, because the
   log's rule is that a correction is dated and kept, not silently rewritten
   (`docs/tasks/README.md:36-38`).
2. Findings that belong to the issue log landed there, not as new numbered issues. 0032's closure
   followed the log's own rule: the file is deleted, the index row is dropped, and the surviving notes
   moved into 0007 (`docs/issues/README.md:123-132`).
3. A wording-only fix is pinned with an **exact-message / exact-string** assertion, because refusal and
   description text IS the contract in several of these cases.
4. The manifest was regenerated after every description change and verified with
   `yarn tools:manifest:check`.

**Line numbers in this file are as of 2026-11-26 and several of them have already moved.** The whole
`src/tools/` + `src/core/` tree this brief was filed against now lives under `src/engine/`, and
`src/engine/harness.ts` plus the delegation suites were under concurrent edit during the pass. Where a
number was verified today it is given; where it is known to have drifted the drift is stated. **Re-anchor
by symbol or by named test, never by number.**

---

## Group A — already fixed. Verified, pinned where a pin was owed, not re-implemented

### A1. `maxTurns: 1` left a child zero tool rounds, and the error did not say so — **confirmed already fixed; no code change**

IT3 filed this as defect 0036 ("misleading error"). The refusal in force is the N ⇒ N-1 sentence and it
is pinned **six** times, across **two** files, in **three** assertion styles:

- `src/engine/harness.delegate-diagnostics.test.ts:278-280` and `:303-305` — exact `toBe` on the whole
  refusal string (verified today: both cases assert the complete sentence byte-for-byte).
- `src/engine/harness.delegation.test.ts:362-364` and `:521-523` — `toThrow(/requested tools on its
  single model turn without answering/)` (regex, so a re-wording survives; recorded as the weaker pin).
- `src/engine/harness.delegation.test.ts:3765` and `:4044` — the two exact strings again, the 2-turn and
  the 1-turn spellings, asserted via `toEqual` on the envelope. **`corrected` on the coordinates:** the
  brief cited these two as `:3438-3439` and `:3547`; on today's tree those lines sit in the
  **pending-placeholder** case and the **child-wake** case, not on the turn-cap sentence, and the exact
  strings re-anchor to `:3765` / `:4044`. The pins exist — the brief's numbers did not survive the file
  growing.
- Generator: `turnCapErrorOf` (`src/engine/harness.ts:789`, module scope; applied at `:15014`) — cited
  **by symbol**, because that file moved under concurrent edit all pass.

**`corrected`** — the brief said this string is pinned for `Agent "general"`. It is not: **every** pin
above uses `Agent "researcher"`, so what is pinned is the refusal **template**, not the literal sentence
the file quoted. That does not weaken the closure (the subject name is interpolated), but the claim as
filed was wrong about what the pins read.

### A2. `requireClarification` is a literal-label gate, not a semantic one — **pin added; the file's interpretation `corrected`**

The gate is **lexical**. `requireClarification` throws from `src/engine/harness.ts`, and the decision is
made by `missingBriefParts` and its acceptance-word regex (cited **by symbol**, same reason as A1). The
brief's repro — *"Read the file package.json … Done means you print the exact name string."* — was
refused for naming no acceptance criterion, and appending only the label `Acceptance criterion: …`
flipped it to accepted with no semantic change. That part is confirmed.

**No prose-completion pin existed.** One was added:
`src/engine/harness.delegation.test.ts:1370`, `accepts a plain-prose completion clause carried by the
"done when" marker alone, with no acceptance vocabulary` — a label-free completion clause accepted via
the `done when` marker, with an in-source comment (`:1361-1369`) stating the honest qualification: the
clause clears the gate **because `done when` is in the word list**, and changing it to `Once` refuses
the same prose again. The test asserts acceptance and nothing more; no assertion claims a semantic gate.

**`corrected`** — the file wrote "the gate let the prose through" as if the harness had understood the
sentence. It did not: that probe was accepted **only because the words `acceptance` / `criterion` sat in
the word list**. The gate is a word list; the prose-completion case is pinned, the gate is unchanged.

---

## Group B — real, confirmed, implemented

### B1. `agentResult` silently clamped an out-of-range `offset` while `fetch` reported the same clamp — **shipped, with two documented deviations**

**What shipped.** The contract lives in `src/engine/harness.ts`, in the two helpers
`agentResultClampNote` and `agentResultRefusalFor` above `agentResultFor` (cited by symbol; `agentResultFor`
is `:5493` as of this writing, the helpers `:5445` and `:5464`), **not** in
`src/engine/tools/runtime/agentResult.tool.ts` as the brief assumed — the paging arithmetic and its
refusals are harness-side, the entry only declares the parameters. An offset that **strictly exceeds**
the stored length now returns `offsetClamped: true` plus a one-sentence `note` naming where the page
really starts, on **both** branches: the completed row and the failed / cancelled row's `partialContent`
page (the flag is computed once — `requested > total` — and applied on both paths, so the two doors
cannot drift). The `offset` parameter description now advertises the clamp, so the behaviour is
discoverable before it is hit: `src/engine/tools/runtime/agentResult.tool.ts:174`.

**No shared constant exists, and none was invented.** The note is a **noun-swapped mirror** of the
`fetch` note at `src/engine/tools/webfetch/index.ts:871-876`. Forcing one constant was rejected on
purpose: the two tools name their unit differently (`characters` of a stored answer vs a fetched page),
and a single constant would churn webfetch's pinned wording for no gain. The vocabulary is shared by
shape and by these two cites, not by a symbol.

**Deviation 1 — `offset === contentLength` reports NO flag.** The brief's test item (b) asked for the
same flag at exactly `contentLength`. That is the honest empty tail, not an overshoot, and it is also
what webfetch does — its rule is `startOffset !== invocation.offset`
(`src/engine/tools/webfetch/index.ts:690`) — and the brief's own fix text said "exceeds". Pinned as
**absent**, in `src/engine/harness.agent-results.test.ts:672`
(`reports an offset past the end as a clamp, and an in-range offset as nothing at all`).

**Deviation 2 — `corrected`: "add the field to the agent-result type beside `contentLength`/`hasMore`"
is impossible.** That door is **untyped**: `HarnessToolRuntime.agentResult: (parameters) => unknown`
(`src/engine/types/index.ts:1456`), and the return shape is documented in prose rather than declared —
the precedent used here is the `partialContent` comment block at `src/engine/types/index.ts:1778-1793`.
There is no type to add a member to; the documented-shape comment precedent was followed instead.

**Pinned.** `src/engine/harness.agent-results.test.ts`: `:672` (past the end → flag + note; in-range →
neither), `:739` (`reports the same clamp when paging a stopped child partialContent` — the failed /
cancelled branch), and `:1360` (`does not report a surrogate-boundary repair as an offset clamp`, with
its reasoning at `:1353-1359`): a surrogate-boundary offset pulled **back** is **not** flagged, because
the flag is `requested > total`, **never** `page.offset !== requested`. The flag cannot lie.

### B2. `agentResult` conflated "unknown id" with "wrong agent" — **shipped**

Two refusals, two remedies, both built by `agentResultRefusalFor` (`src/engine/harness.ts`, cited by
symbol):

- the id exists under another agent → `…; it belongs to agent "X".`, and a distinct-owner scan also
  emits `…it belongs to agents "A", "B".` for a recycled id that sits under two agents;
- the id exists nowhere → `…: no such invocation in this harness.`

The pre-existing **unregistered-agent** refusal is preserved verbatim, so an unknown agent name still
fails the way the suites already pin it.

**`corrected`** — the brief asked for a cross-agent lookup to be built. It already existed:
`invocationRecordOfInvocationId` (`src/engine/harness.ts:4849` as of this writing) carries **no agent
filter** and its record carries `.agent`, so the owner was always known; the fix was to use it in the
refusal, not to add a lookup.

**Ring behaviour preserved and newly pinned.** An id retired with its transcript stays readable by id
and is never reported unknown — the documented ring behaviour — which is why the retired-row case must
name its owner rather than fall through to `no such invocation`. Existing behaviour pins still hold:
`src/engine/harness.agent-results.test.ts:407-418` and `:517-523` (a row hidden by the per-agent cap is
still readable by id; "a flag is not a deletion"). New exact-message pins: `:833`, `:872`, `:939` (the
two-owner plural), `:964`, and the retired-id case at `:968`
(`still reads an id retired with its conversation, and names its owner rather than calling it unknown`).

### B3. `delegate.timeoutMs` accepted `1` — **prose shipped; the file's supporting evidence `corrected` twice**

**What shipped.** One advisory clause in `timeoutMs`'s description
(`src/engine/tools/runtime/delegate.tool.ts`): a bound under roughly 1000 ms almost always cancels the
child before it answers, that cancellation still mints a child conversation and still costs a provider
request, and the caller owns releasing the timed-out child's thread (default is **no** time limit —
omit the bound). **No bound and no behaviour changed.** The **owner chose the prose-only remedy** over
auto-release, so the release duty the descriptions already place on the caller for a finished child now
covers a timed-out one too — by prose, not by code. Mirrored into the generated
`src/engine/core/tool-manifest.ts` and the hand-mirrored Rust row
`packages/typecrate/harness/src/tools/catalogue.rs:252`, and pinned in all copies by
`src/engine/core/metadata.ownership.test.ts`.

**`corrected` (i)** — "the 500 ms timeout probe is a standing case" is **false**: there is no 500 ms
timeout anywhere in `src/**/*.test.ts` (`grep` for a 500 bound → **0** hits). The standing sub-second
bounds are `timeoutMs: 30` — `src/engine/harness.delegation.test.ts:699` and
`src/engine/harness.fork.test.ts:1770` (the work order also anchored a second `timeoutMs: 30` case at
`harness.delegation.test.ts:2228`; that one sits at `:2370` today, the file having grown) — and 1-5 ms
plugin bounds (`src/engine/plugin/hooks.test.ts:743`, `:773`, `src/engine/harness.plugin.test.ts:989`).
The 500 ms figure came from an **IT3 live probe**. The conclusion the brief drew — **do not raise
`minimum`** — still stands, on the real evidence.

**`corrected` (ii)** — "see the `maxChars` description pin noted in 0026" is **false**: 0026 records the
**absence** of such a pin, not one. The pattern actually copied is the `agentResult.limit`
maximum/description pin in `src/engine/core/metadata.ownership.test.ts` (the block the pass anchored at
`:540-543`, at `:544-547` on today's tree — that file gained pins during the pass, re-anchor by the
`agentResult.properties.limit` assertion).

**The four-copy chain, recorded because it is how the next edit gets missed:** the entry literal
`src/engine/tools/runtime/delegate.tool.ts` → the **generated** `src/engine/core/tool-manifest.ts`
(`yarn tools:manifest`) → the **hand-mirrored** `packages/typecrate/harness/src/tools/catalogue.rs`; plus
the **hand-duplicated** allowlist copy in `src/engine/core/metadata.ts`. The Rust copy is guarded **from
the TS suite** — no `cargo` test pins description text, so `metadata.ownership.test.ts` reads the crate
row and compares it.

### B4. A turn-capped child's ledger row said nothing about its tool work — **shipped as 0032's own design, and 0032 is CLOSED**

**What shipped** is 0032's design, not a wider `partialContent`:
`toolActivity?: { calls; settled; byName?; truncated }` with `TOOL_ACTIVITY_NAME_CAP = 8`
(`src/engine/core/agent-limits.ts:52`), captured **before** the transcript splice and kept **separate**
from `partialContent`, **absent** when no invocation was registered ("did nothing" and "reported nothing"
stay different) and **absent on a `completed` row** (the tally describes a run that did not conclude).
Threaded through the whole chain, as 0032 demanded — archive input → `archiveInvocation`
(`src/engine/harness.ts:9631`) → `archiveDigestOf` / the `result:archive` fold
(`src/server/workers/lane-commit.ts`) → `lane-authority.ts` → `lane-worker-loop.ts`, so it exists in both
execution modes — with one shared validator `readSnapshotToolActivity`
(`src/engine/core/snapshot-validation.ts:273`), the snapshot's may-be-absent key
(`src/engine/core/snapshot.ts:269`) and the completed-row refusal.

**0032 was closed by the log's own rule**: the file is deleted
(`docs/issues/minor-cancelled-childs-tool-activity-leaves-no-addressable-record.md`, deleted in the
working tree), its index row is dropped, and its surviving notes — the Operations journalled-child
question and the B4 framing correction below — were folded into 0007. Its acceptance evidence is
enumerated in 0007's `## Update (2026-11-26)` (the `harness.delegation.test.ts`,
`harness.agent-results.test.ts`, `lane-commit.test.ts`, `lane-worker-correctness.test.ts` and
`metadata.ownership.test.ts` blocks, plus the three-door pin at `src/server/threads.test.ts:3815`,
`:3839`, `:3906`).

**`corrected`** — IT3's framing, "the harness discards the work it already paid for", is **refuted**:
`threadRead` on a turn-capped child returns the committed `diceRoll` call **and its result**
`{"sides":6,"value":1}`. Only the **ledger** half was ever missing — a post-mortem reading `agentResult`
/ `agentManage` alone could not say what a stopped child **did**.

**`corrected`** — 0032's "five may-be-absent keys at `:198`" is stale: the list is now **nine** keys at
`src/engine/core/snapshot.ts:269` — `error`, `partialContent`, `cancelledAtMessage`, `threadId`,
`stopReason`, `epoch`, `role`, `rank`, `toolActivity` — of which `toolActivity` is the new one.

**Follow-on found during the audit and fixed:** `toolCancel`'s description did **not** enumerate
`toolActivity`, although the tally rides that door (0032 AC7) — a field a caller cannot discover is a
field it will not ask for. Fixed in the entry (`src/engine/tools/runtime/toolCancel.tool.ts`), the
generated manifest, and the Rust row at
`packages/typecrate/harness/src/tools/catalogue.rs:293`.

### B5. `delegate`'s pending placeholder could omit `invocationId`/`threadId` — **CONFIRMED, by a different mechanism than hypothesised; prose fixed**

**Confirmed live.** A probe against `http://localhost:8800/providers/private/v1` with `local/basalt`
(2/2 round trips) showed the **single-child** placeholder carrying **both** ids — so IT3's shape needed
more than one child. The real omission path is **two or more `delegate` calls to the same agent in one
assistant message**: the queued sibling has no child record yet, `delegatedRecordOf` therefore finds
nothing, and both keys are dropped from its placeholder; after release, both children received real ids.

**`corrected`** — both causes the in-source comment named are wrong **as routes**: a pre-dispatch
refusal never reaches a pending projection at all, and eviction can never hit an in-flight child because
`pruneInvocationRecords` skips `status === 'running'`. The contract sentence *"a missing id means no run,
not an unknown one"* is therefore **false for a queued sibling** — a queued sibling is a run that has not
started yet and will. That sentence was replaced in both allowlist copies
(`src/engine/tools/runtime/delegate.tool.ts`, `src/engine/core/metadata.ts`) with text that says the ids
appear once the child has started, that they are absent while the call is queued behind siblings, and
that this is not the same as never starting (paraphrased — the shipped wording is the source worker's).

**No manifest or Rust mirror of that text exists** — `grep -c "DELIVERY:"` is **0** in
`src/engine/core/tool-manifest.ts` and **0** in `packages/typecrate/harness/src/tools/catalogue.rs`
(re-measured today) — which is exactly why the P1 row in 0007 stays open; the pin at
`src/engine/core/metadata.ownership.test.ts:810` (re-anchored in the final pass — the number had drifted
five lines when the file gained pins; the case is `pins the queued-sibling placeholder sentence in both
allowlist copies and nowhere in the catalogue chain (B5)` at `:759`) now asserts that absence
(`expect([manifest.includes('DELIVERY:'), rust.includes('DELIVERY:')]).toEqual([false, false])`), so a
future mirror of the paragraph fails loudly instead of silently disagreeing.

**Runtime pinned**, runtime behaviour **deliberately not changed** — no invented identity, no synthetic
id: `src/engine/harness.delegation.test.ts:3326`,
`gives the started child both ids and the queued sibling neither, then gives that sibling a real id (B5)`
— an exact-key assertion: started child → both keys; queued sibling → neither; both settle with real ids.

**The 0007 P1 row stays open**: the base / zero-subagent `delegate` description still carries **no**
placeholder paragraph at all, so the generated manifest and the Rust row still teach the smaller
contract.

---

## Group C — three refutations, and one re-scoped by measurement and then fixed

### C1. `threadSend` to an agent's own idle default "claims a run is in flight" — **refuted**

Today's refusal names the real cause and the remedy: `… is agent "instruct"'s own conversation and is
idle: a message into it would start a second turn of the agent that is asking. Use this turn, or address
a thread you created (see threadList).` The string IT3 quoted, `already has a run in flight`, is **0**
hits in `src/`. Recorded as a row of 0007's `### Refuted as filed` table. **No code change.**

### C2. `threadFork`'s answer "carries no `contentLength`/`truncated`/`nextOffset`" — **refuted twice, then implemented under an owner decision**

The literal claim is refuted in both halves. An over-cap fork emits **no keys at all** — `truncated` and
`nextOffset` included — because the delivery seam refuses the **whole JSON document**: `Tool result too
large to deliver: 40058 bytes against a 32768-byte budget…` with `outcome: failed` (message prefix in
`src/engine/core/result-budget.ts`). And `contentLength` was **never** a fork key at any size:
`HarnessForkResult` is `{ branchId, threadId, content }` (`src/engine/types/index.ts:1967-1971`).
IT3's `contentLength: 16,015` is the byte size of the **serialized fork document** (15,957 + 58).
The branch itself keeps its full 40,000 characters and stays pageable **by branch id** through
`agentResult` (`contentLength: 40000`, cursors accepted) — the answer is not lost, only undeliverable in
one frame.

**`corrected`** — the brief's "if anyone wants this closed, generate a >32 KiB fork answer and look" is
**now done**, and what survived is a real ergonomics gap rather than a contract lie: the refusal named
no `branch-N` handle and prescribed `smaller limit, fewer ids, narrower fields` — arguments `threadFork`
does not take — and `threadFork`'s description never stated the 32,768-byte per-result delivery cap
(`MODEL_TOOL_RESULT_BUDGET_BYTES`, `src/engine/core/result-budget.ts`) at all.

**Owner decision, recorded as a decision:** the owner **authorised implementing the fix in this pass**,
overriding this file's own "do not implement" rule for Group C. What shipped: the over-cap refusal now
names the **retained handles** and points the caller at `agentResult` on the branch instead of a re-run,
and `threadFork`'s description now states the delivery cap, the fact that an over-cap answer is refused
whole rather than truncated, and that the branch stays pageable by id. Read today at
`src/engine/tools/runtime/threadFork.tool.ts:65`, with the retained-handle rule sitting above
`type RetainedHandleKey = 'branchId' | 'invocationId'` in `src/engine/core/result-budget.ts:462`.

**`corrected` — the "implementation evidence is `unconfirmed` at line level" marking is spent.** What
this section first wrote (kept, because it is what the tree said at the time) was: *"read, not pinned …
Described, not quoted — the worker's wording is not final … Implementation evidence is `unconfirmed` at
line level until the final verification pass re-anchors it: the description text and the refusal branch
were not pinned against the final tree at the time this was written, and the live over-cap shape was
never observed."* The final pass re-anchored all of it, and the wording is final. What is in the tree:

- `src/engine/core/result-budget.ts` gained `parseJsonDocument` (`:420` — the parse that answers
  "is this JSON?" and "does it carry its own address?" from ONE read), `retainedHandleOf` (`:476`) and
  `REFUSAL_HANDLE_MAX_CHARS = 120` (`:470`), and `refusalMessage` (`:524`) now picks between two
  recovery clauses.
- `src/engine/core/result-budget.test.ts:177`
  (`names the retained handle when the refused document carries one, and the re-run when it does not
  (C2)`) pins **five** refusal rows as **whole** `rejected` descriptors — a fork `branchId`, a
  delegation `invocationId`, an object with neither key, an array, and an **over-long handle**
  (121 chars > the cap) that falls back to the re-run sentence — plus the two negative assertions that
  stop a both-clauses-at-once bug from hiding behind a moved pin (`:249-257`).
- **End to end**, `src/engine/harness.fork.test.ts:307`
  (`refuses a fork answer over the delivery cap whole, and names the branch that still holds it (C2)`):
  a 40,058-byte fork document (`:375`) is delivered as the refusal and nothing else — one tool frame,
  pinned whole (`:382-393`) — with `outcome: 'failed'` (`:398-402`), and then the case **takes the
  sentence at its word**: `agentResult` under the branch id answers with the first page of the
  discarded summary and `contentLength: 40_000` (`:407-419`). The recovery is one paged read, not a
  second fork.
- The description cap is pinned **against `MODEL_TOOL_RESULT_BUDGET_BYTES`, never a bare literal**:
  `src/engine/core/metadata.ownership.test.ts:867`
  (`states the delivery cap a fork answer has to fit, in every copy of that row (C2)`) asserts the
  constant is `32_768` (`:882`), matches three whole sentences — cap, whole-document refusal, the
  "no length argument" lever — against the **entry literal** and against `src/engine/core/metadata.ts`
  as the imported objects (`:897-904`), then against the three **text copies** `threadFork.tool.ts`,
  `src/engine/core/tool-manifest.ts` and
  `packages/typecrate/harness/src/tools/catalogue.rs` (`:910-918`), and finally re-pins the "takes no
  length argument" claim against the schema's own property list (`:925-926`). Raising the constant
  without touching the prose turns this case red.

**The refusal as shipped**, verbatim (`src/engine/harness.fork.test.ts:382-387`, where only the two
byte figures are derived and every word around them is literal):

> `Tool result too large to deliver: 40058 bytes against a 32768-byte budget. The result was discarded, not truncated: no part of it reached this transcript. What was discarded is retained under branchId "branch-1": agentResult pages the full text by that id, so read it there instead of re-running tool 'threadFork' (call f1). If this call could have written anything, that write may already be applied — re-read before retrying.`

**Two decisions, recorded as decisions.** (1) `threadId` was **excluded** from the accepted handle keys.
The approved design offered it; it is left out because a `branchId` / `invocationId` addresses an
invocation RECORD that pages this answer, while a bare `threadId` addresses a CONVERSATION whose
transcript is related to the discarded document but is not it — promising retention at a thread id
would repeat, one tool over, the false-advice defect this clause exists to fix
(`src/engine/core/result-budget.ts:455-461`); `threadFork`'s document carries `threadId` with the same
value as `branchId`, so nothing is lost. (2) The clause was mirrored into
`packages/typecrate/harness/src/tools/result.rs` — `retained_handle` (`:288`),
`REFUSAL_HANDLE_MAX_CHARS` (`:273`), the two-arm `refusal_message` (`:327`) — **with a Rust test**
(`a_refused_document_that_names_a_retained_branch_is_pointed_at_that_branch`, `:1388`), and that test
**caught a real defect** the TS pins could not: the Rust handle arm was missing a sentence terminator,
so the write-safety sentence ran into the re-run clause with no full stop. The **non-handle arm stayed
byte-identical** (`:1417-1424` pins it, and every pre-existing refusal pin in both packages depends on
that). Rust verification, re-run on the final tree: `cargo test` in `packages/typecrate/harness` →
**22 suites / 486 tests passed, 0 failed**; `cargo check --tests` → exit **0**. The over-cap shape
remains **scripted, not observed live** — see *Not tested*.

### C3. IT3's own retractions — **keep them retracted**

The `threadSend` default-conversation note "names the wrong thread" was withdrawn by its own author
after re-testing against a provably mid-run child, and the separate reviewer objection (`queued` vs
`started`) collapsed the same way — `delivered: 'queued' | 'started' | 'resumed'` is deliberately
three-valued (`src/engine/types/index.ts:4176`). Both are rows of 0007's `### Refuted as filed` table.
**No code change.**

### C4. `agentManage`'s arithmetic — **correct**

`totalResults: 64`, per-agent `invocationCount` summing to 7, `hiddenResults: 57`; `64 − 7 = 57`, exactly
the documented rule, computed in `agentManageView` (`totalResults: records.length`,
`hiddenResults: records.length - listed`) and published in prose at
`src/engine/tools/runtime/agentManage.tool.ts:60-71`. Recorded as a refuted row in 0007 so it is not
re-filed. **No code change.**

---

## Group D — host/UI, outside this package (**unchanged**)

Both observations stand exactly as written, and neither belongs to this package:

1. **`branch-N` rows** are `threadFork` branches, not delegated children: `branchId` and `threadId` come
   back as the *same* `branch-N` string, they never appear in `threadList`, and they are released only
   when their parent conversation is deleted. The badge is fine; the row is not a clickable conversation.
2. **Released threads still shown, with last-known status.** `threadDelete` is a **mark**, not an
   erasure: the row leaves the roster and every agent-facing door while its transcript and result rows
   are retained — so released rows legitimately persist in a host view that has not re-read the roster.
   A released row should read distinctly from a live `error` row.

Standing note, kept because it explains the screenshot: most of the red `error` rows were **intentional
probes** — turn-caps (`maxTurns` 2 and 4), a 500 ms timeout (a live probe, see B3 `corrected`), and a
caller `toolCancel`.

---

## Corrections to this file's own coordinates (all of them, kept deliberately)

- **Every `src/…` path the brief cited is one directory move stale**: `src/tools/…` is
  `src/engine/tools/…` and `src/core/…` is `src/engine/core/…`.
- `src/core/metadata.ts:249` is now `src/engine/core/metadata.ts:250` — and that number has moved again
  today (the `agentDelegateMetadata` factory now opens at `:249-250` under a comment block).
- The base `delegate` description was cited as `src/tools/runtime/delegate.tool.ts:135-137`; it is
  `src/engine/tools/runtime/delegate.tool.ts:142-143` per this pass, and on today's tree the
  `description:` property itself is at `:149`, with the allowlist template at `:307` (the file grew
  comment blocks during the pass). **Re-anchor by symbol.**
- `src/engine/harness.metadata.ownership.test.ts` **never existed**; the real file is
  `src/engine/core/metadata.ownership.test.ts`.
- The item-level corrections are kept inline where they were found (A1 ×2 — the pinned agent name, and
  the drifted pin numbers `:3438-3439`/`:3547` → `:3765`/`:4044` — A2, B1 Deviation 2, B2, B3 ×2, B4 ×2,
  B5, C2) rather than collected here, so each original claim sits beside the evidence that overturned it.

## Out-of-package change — `packages/loadscript/harness` (recorded as a decision)

`packages/loadscript/harness/src/types/index.ts` mirrors the delegation envelope and mirrored it
**without `toolActivity`** (`grep -n toolActivity` in that file → **0** hits when this was filed), while
its comments asserted that a stopped child's tool calls "are gone for good — 0020's leak boundary and
0032" — at `:1735` and again at `:4460`. Closing 0032 made that sentence **false**: the calls are
tallied now.

**Decision (owner):** correct the mirror in this pass rather than leave a published type contradicting
the package that owns the field.

**Landed, and verified on the final tree.** **`corrected`** — this section first recorded the correction
as **decided and in flight**, on the honest grounds that `packages/loadscript/harness` carried **no**
working-tree change when it was written (`git status` clean there). That was true at the time; two
source workers finished after the documentation pass, and the change is now in the tree:

- `src/types/index.ts:1695` declares **`HarnessToolActivity`**, the client mirror of the engine's own
  type, and `toolActivity?` sits on all three doors that carry it — `HarnessDelegationResult` (`:1732`,
  field at `:1798`), `HarnessAgentResultSnapshot` (`:4470`, field at `:4547`) and
  `HarnessInvocationArchiveInput` (`:4614`, field at `:4657`).
- The forensic sentence is corrected in **both** places it sat — the live envelope
  (`:1782-1786`) and the durable snapshot row (`:4517-4522`). The wording, stated the way both packages
  now state it: the tool **calls and their result bodies / text** are deliberately NOT retained
  (0020's leak boundary, which is why `partialContent` stays text-only), while the **bounded**
  `toolActivity` tally — `calls`, `settled` and up to `TOOL_ACTIVITY_NAME_CAP` (8) tool names — **is**
  retained on a stopped run. The engine's twin of that sentence is
  `packages/underload/harness/src/engine/types/index.ts:4629-4634`.

**Honest caveat, stated rather than glossed (unchanged by the fix):** **no generator, test or document
establishes that this file is a contractual mirror** of
`packages/underload/harness/src/engine/types/index.ts` — that is precisely why nothing failed when 0032
shipped, and nothing fails now either. Verification of the package as it now stands, re-run on the final
tree: `yarn typecheck` → exit **0**, and `yarn test` → **183 files / 2,626 tests passed** (both in
`packages/loadscript/harness`).

## Verification performed

**Final pass, re-run on the final tree (2026-11-26).** This is the closing verification of the whole
pass and it replaces the earlier sample this file first recorded (**272 files / 5,121 tests**, with
`cargo check --tests` flagged as an earlier sample and "every figure above predates the last two waves'
wording edits") — that sample is kept in 0007's second-wave entry as history, and it is superseded here.
Stated precisely about what each run covered: every TypeScript and Rust run below happened **after the
last source edit** of the pass (the final source change was the comment-only `partialContent` fix in the
two type files); the only edits that followed these runs are documentation prose (this file, 0007 and the
tasks index), and **no test in the suite reads this package's `docs/` or `knowledge.md`** — checked by
grepping `src/**/*.test.ts` for `docs/`: every hit is either a comment citation or an unrelated
gitignore/glob fixture path (`docs/secret`, a seeded `docs/readme.md`), and none is a `readFile` /
`sourceOf` of a documentation file — so the figures describe the final tree. The two
manifest checks were re-run once more **after** those documentation edits and are still current.

| Check | Where | Result |
|---|---|---|
| `yarn vitest run` (full suite) | `packages/underload/harness` | **272 files / 5,124 tests passed**, exit **0** |
| `yarn typecheck` | `packages/underload/harness` | exit **0** |
| `yarn tools:manifest:check` | `packages/underload/harness` | current — **34** tool descriptors, exit **0** |
| `yarn plugins:manifest:check` | `packages/underload/harness` | current — **3** plugins, exit **0** |
| `cargo test` | `packages/typecrate/harness` | **22 suites / 486 tests passed, 0 failed**, exit **0** |
| `cargo check --tests` | `packages/typecrate/harness` | exit **0** |
| `yarn typecheck` | `packages/loadscript/harness` | exit **0** |
| `yarn test` (vitest) | `packages/loadscript/harness` | **183 files / 2,626 tests passed**, exit **0** |

Runner policy held across every command here and across the whole diff of all three repositories: repo
code is run only through `yarn vite-node` / `yarn vitest run` / `yarn <script>` (the manifest checks
themselves print `$ vite-node scripts/…`), with no `node <file>`, `node --test`, `tsx`, `ts-node` or
`process.execPath`-on-a-repo-file introduced anywhere in sources, scripts, docs commands or
`package.json`. The two exemptions that legitimately appear are code running outside this monorepo (the
Rust crate, driven by `cargo`) and published plain-JS npm bins.

## Not tested / follow-ups (all of these are `unconfirmed`, not "fine")

- **Worker-mode POSITIVE `toolActivity`** is pinned at the **fold / archive-door** level
  (`src/server/workers/lane-commit.test.ts`, `lane-worker-correctness.test.ts`), **never** through a live
  tool-using lane stub — no test drives a worker child that actually called a tool and then got tallied
  end to end.
- **No `cargo test` pins the mirrored Rust catalogue row's text** (`src/tools/catalogue.rs`); the
  guards for that text are TS-side `sourceOf` greps in `metadata.ownership.test.ts`. The crate row is
  text-verified, as 0007's Requests section has always said. **`corrected` in the final pass, so the
  caveat reads narrowly rather than as a blanket:** the crate's **refusal sentence** is now pinned by
  Rust — `a_refused_document_that_names_a_retained_branch_is_pointed_at_that_branch` in
  `packages/typecrate/harness/src/tools/result.rs:1388` asserts both arms byte for byte (see C2) — so
  what stays unguarded by `cargo` is the tool-description/catalogue text, not the refusal.
- **On-disk persistence and a real lane restart** were exercised **in-process**, not through
  `src/server/persistence.ts` and not through a respawned worker process.
- **B5's queued-sibling shape is pinned scripted, not observed live** with multiple siblings; the live
  probe showed the single-child placeholder (both ids present), not a multi-sibling one.
- **The over-cap fork is pinned scripted, not observed live** — a provider's own output bound likely
  truncates the fork answer before the 32,768-byte delivery cap is the thing that bites, so the refusal
  shape this pass pinned may never be what a real provider produces first.
- **A live multi-sibling `threadFork` refusal-naming check was not run.**
- **Standing hazard for the next wording edit**, recorded so it is read as a cost rather than
  rediscovered as a failure: any further tool-description change moves the byte pins in
  `src/engine/harness.tool-list.test.ts` — registry `65,567` (`:433`), `originalBytes: 64,655` (`:450`),
  `toolManage` details `139,050` (`:558`) — and can move `DELEGATE_FLOOR` (`16,101`,
  `src/engine/plugin/context-compaction.test.ts:4183`, whose `+520` cap is `16,621` against a live
  catalogue floor of `16,567` tokens). If the cap stops clearing the floor, the failure is NOT a token
  figure: the compaction pass declines to park and the case dies as `Thread "thread-1" never reached
  "paused" (last: running)`. The probe recipe for both is in those files' own comments.
  **`corrected` in the final pass — those three byte figures and two of the three coordinates moved
  again after this line was written**, because the C2 and `toolCancel` clauses grew the same rows; the
  figures a next pass has to beat are registry `66,001` payload bytes
  (`src/engine/harness.tool-list.test.ts:438`), `originalBytes: 65,089` UTF-8 (`:457`, and the refusal
  message that quotes it, `:464`), and `toolManage` details `139,484` (`:579`). `DELEGATE_FLOOR` is
  **unchanged at `16,101`** but now sits at `src/engine/plugin/context-compaction.test.ts:4192`; its
  `+520` cap and the `16,567`-token live floor are quoted from that wave's probe and were **not
  re-probed** here, so treat the token pair as `unconfirmed` at line level and re-measure it before
  trusting the margin.

## Outcome of the suggested order of work

The gate column is replaced by what actually happened.

| # | Item | Cost (as filed) | Outcome |
|---|---|---|---|
| 1 | B1 `offsetClamped` on `agentResult` | small, self-contained | **Shipped**, with deviation 1 (`=== contentLength` carries no flag) and deviation 2 (`corrected`: no type to add the field to — documented-shape comment instead). Three named pins, including the surrogate case that proves the flag cannot lie. |
| 2 | B2 owner-aware `agentResult` refusals | small | **Shipped.** Two refusals (+ the two-owner plural); `corrected`: the cross-agent resolver already existed. Ring behaviour preserved and newly pinned. |
| 3 | B3 `timeoutMs` prose | small (prose) / medium (behaviour) | **Prose only, on owner decision** — no auto-release, `minimum: 1` unchanged. Its two supporting citations `corrected` against the tree. |
| 4 | B4 → 0032's `toolActivity` | medium | **Shipped end to end and 0032 CLOSED** (file deleted, notes folded into 0007); snapshot chain carries it; the `toolCancel` enumeration gap the audit found is fixed in all three copies. |
| 5 | B5 placeholder ids | probe first | **CONFIRMED live, via a different mechanism** (queued sibling, not the two causes the in-source comment named). Prose fixed in both allowlist copies; runtime pinned, not changed. 0007's P1 row **stays open**. |
| 6 | A1/A2 pin check | trivial | **A1 already fixed**, six pins pass, `corrected` on which agent name they use. **A2's missing pin added**; the gate is lexical and stays so. |
| 7 | C1–C4 refutation notes in 0007 | trivial | **Landed as rows of 0007's `### Refuted as filed` table.** C2 additionally got a refuted row AND a fix, under an owner decision that overrode this file's "do not implement" for Group C. |

## Out of scope

- No change to the rank model, `scope.tools` semantics (that is 0023), or the `maxChars` ceiling entry
  (that is 0026).
- No change to `partialContent`'s `min: 1` reader bound — the present-and-empty shape was declined by
  design (0007, ex-0020).
- No new issue files for Group C. The log holds live gaps only.
- **Not taken:** the `loadscript` alternative of a **full mirror plus a guard test** that pins the two
  type files against each other — the pass corrected the contradicting comments instead of installing a
  mirror contract that no generator or test today establishes.
- **Not taken:** any `branch-N` **UI affordance** change (Group D) — it is host/UI, outside this package,
  and the group was left untouched.

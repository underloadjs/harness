# Delegate / agents-control defects — verified fix list

> **Status:** Handoff — ready for one agent to pick up, verify against HEAD, and implement.
> **Area:** delegation, `agentResult`, `threadSend`/`threadFork`, result ledger.
> **Date:** 2026-11-26.
> **Not a new issue file.** This is a work order. Several items below belong in the existing
> issue log (0007, 0032) and must be folded there rather than filed as new entries.

## Provenance

Three runs produced the material here. Do not trust any one of them; the **Verification** column
below says what *this* pass actually re-checked.

| Run | What it was | Where |
|---|---|---|
| **IT3** | `delegate` + agents-control stress test, ~40 live probes | `thread-46`, label `IT3`, invocation `49` (final report at transcript index 143) |
| **IT4** | `threadFork` branch of IT3 — the 15,957-char tool-contract essay | `branch-8`, invocation `branch-8` |
| **This pass** | Independent re-verification of IT3's claims, plus four new findings | `thread-62`, label `IT7`, invocation `72` |

The tree the docs describe is dated 2026-11-19; today is 2026-11-26. **Two of IT3's findings have
already been fixed in that gap** (see Group A). Re-verify everything against HEAD before writing code.

## How to work this list

1. For each item, run the **Reproduce** step first. An item that does not reproduce today is done —
   delete it from this file and say so in the commit message.
2. Items marked **fold into 0007 / 0032** must land in those files, not as new numbered issues.
   The log's own rule: only live gaps, corrections go in a dated `## Update` section.
3. Every fix needs the named test. A wording-only fix still needs an exact-message pin, because
   refusal text is the contract in several of these cases (the 0007 rows already say this).
4. Regenerate the manifest after any description change: `yarn tools:manifest:check`.

---

## Group A — already fixed. Verify, pin if missing, do not re-implement

### A1. `maxTurns: 1` left a child zero tool rounds, and the error did not say so

**IT3 filed this as defect 0036 ("misleading error"). It is fixed.**

- **Reproduce:** `delegate(agent:"general", maxTurns:1, input:"Use the diceRoll tool once, then answer ROLLED <n>.")`
- **Observed today (verbatim):**
  `Agent "general" requested tools on its single model turn without answering, the maxTurns this run was given (1). maxTurns caps model REQUESTS, not tool rounds, and the child's answer has to be one of them, so N turns allow at most N-1 tool rounds: 1 turn = 0 tool rounds — at maxTurns: 1 a child gets no tool round at all, and must answer without calling one.`
- **Already pinned:** `src/engine/harness.delegate-diagnostics.test.ts:279` and `:304`;
  `src/engine/harness.delegation.test.ts:363`, `:522`, `:3433`, `:3547`.
- **Action:** nothing to implement. Confirm the pins pass and close the item.

### A2. `requireClarification` was a literal-label gate, not a semantic one

**Fixed.** IT3's repro brief — *"Read the file package.json … Done means you print the exact name
string."* — was refused for naming no acceptance criterion, and appending only the label
`Acceptance criterion: …` flipped it to accepted with no semantic change.

- **Reproduce today:** delegate with a brief whose completion condition is plain prose
  (`Acceptance criterion: the reply contains the word ROLLED and the rolled number.`).
  My `maxTurns:1` probe used exactly that phrasing and **was accepted** — the gate let it through.
- **Action:** confirm a test pins that prose completion clauses are accepted (IT3 reported none
  existed). If still unpinned, add the pin; do not change the gate.

---

## Group B — real, confirmed today, not yet implemented

### B1. `agentResult` silently clamps an out-of-range `offset`; `fetch` reports the same clamp

**Severity: Minor (ergonomics / drift). New. Confirmed.**

- **Reproduce:** `agentResult(agent:"instruct", invocationId:"branch-8", offset:90000)` on a
  15,957-character answer.
- **Observed:** `{"content":"","contentLength":15957,"offset":15957,"hasMore":false}` — no flag,
  no note. The clamp arithmetic is honest, but a caller that overshot by computing
  `contentLength - n` cannot tell a clamp from a genuinely empty tail.
- **The inconsistency is the defect.** `offsetClamped` already exists in this package and is
  documented behaviour for `fetch`. `grep -rn offsetClamped src/` returns hits in
  `src/engine/tools/webfetch/index.ts` (5) and `src/engine/types/index.ts` (3) and **zero** in
  `src/engine/tools/runtime/agentResult.tool.ts`. Same situation, two contracts.
- **Fix:** in `agentResult`, when the requested `offset` exceeds `contentLength`, return
  `offsetClamped: true` plus a one-sentence `note` naming the clamp target, reusing the `fetch`
  wording and the existing type member rather than inventing a new one. Add the field to the
  agent-result type beside `contentLength`/`hasMore`.
- **Tests:** extend the agent-result paging suite
  (`src/engine/harness.agent-results.test.ts`) with (a) offset past the end → `offsetClamped: true`
  + `offset === contentLength` + `hasMore: false`; (b) offset exactly at `contentLength` → same;
  (c) an in-range offset → key absent, so the flag never lies.
- **Acceptance:** a caller can distinguish "you overshot" from "the tail is empty" without
  arithmetic, and the two paging tools describe the clamp with one shared vocabulary.

### B2. `agentResult` conflates "unknown id" with "wrong agent", and hides the owner

**Severity: Minor→Medium. IT3 defect 0034. Confirmed.**

- **Reproduce:** `agentResult(agent:"general", invocationId:"branch-7")` — the id is real and
  belongs to `instruct`.
- **Observed (verbatim):** `No result "branch-7" is available for agent "general".`
- **Why it matters:** the two failures need opposite remedies (switch agent vs. give up), and the
  message does not say which happened. `agentManage` caps each agent at 5 rows with no cursor, so
  recovery is one blind probe per candidate agent. The harness plainly knows the owner — the
  `instruct` call for the same id succeeds.
- **Fix:** resolve the id across the ledger first. If it exists under another agent, refuse with
  `… it belongs to agent "instruct"`. If it exists nowhere, refuse with
  `no such invocation in this harness`. Two messages, two remedies.
- **Tests:** in `src/engine/harness.agent-results.test.ts`, one case per branch, plus one pinning
  that an id retired with its transcript but still readable by id is **not** reported as unknown
  (that is the documented ring behaviour, and this change must not break it).
- **Acceptance:** no caller has to enumerate agents to find an id's owner.

### B3. `delegate.timeoutMs` accepts `1`, which guarantees a cancelled child that still cost a thread and a provider request

**Severity: Minor (judgement call for the owner). New. Confirmed at the schema and at runtime.**

- **Schema:** `src/engine/tools/runtime/delegate.tool.ts:166-169` — `timeoutMs` is
  `type: 'integer', minimum: 1, maximum: 3600000`. There is no floor above 1 ms.
- **Runtime repro:** `delegate(agent:"general", timeoutMs:1, …)` →
  `{"status":"cancelled","durationMs":29,"error":"Delegation to \"general\" exceeded its 1ms timeout and was stopped.","cancelledAtMessage":1}`.
  A thread (`thread-63`) was minted, a ledger row (`73`) was written, a provider request was issued,
  and the child was stopped 29 ms later. I had to `threadDelete` the orphan myself.
- **Do NOT fix by raising `minimum`.** The package's own tests deliberately use sub-second bounds
  (the 500 ms timeout probe is a standing case), and a schema floor would break them. The bound is
  a test tool, not a model tool.
- **Fix (prose, not schema):** one clause in the `timeoutMs` description — a bound below roughly
  1000 ms will almost always cancel the child, and the cancellation still mints a thread and burns
  a request, so omit the bound (the default is *no* time limit) rather than setting a tiny one.
  That matches the existing time policy recorded at `delegate.tool.ts:89-95` (unbounded default →
  optional bound → `cancelled` envelope → `toolCancel`).
- **Optional second half (owner's call):** when a delegation is stopped by its own `timeoutMs`
  before the child commits anything, the parent is left holding a thread it must release. Either
  state in the description that the caller owns that cleanup, or auto-release a child thread that
  never committed a turn. The first is a sentence; the second is a behaviour change — pick one and
  say which in the commit.
- **Tests:** pin the description sentence if the suite pins descriptions (it does — see the
  `maxChars` description pin noted in 0026). If auto-release is chosen, pin that a
  `timeoutMs`-cancelled, zero-committed-turn child leaves no roster entry and no orphan row.

### B4. A turn-capped child's envelope is empty even though its tool work survived — this is open issue **0032**

**Severity: Minor. IT3 defect 0036 (second half). IT3's framing was wrong; the underlying gap is real and already logged.**

- **Reproduce:** the `maxTurns:1` probe from A1. Envelope:
  `{"status":"failed","content":"","cancelledAtMessage":3,"durationMs":10214,"stopReason":"turn-cap"}`
  — **no `partialContent`**.
- **But the work is NOT lost, contrary to how IT3 filed it.** `threadRead("thread-64")` on that same
  child returns the committed `diceRoll` call **and its result** `{"sides":6,"value":1}`. IT3 wrote
  "the harness discards the work it already paid for"; it does not — the transcript retains it and
  `threadRead` recovers it. IT3's own proposed remedy ("surface the tool calls the child made") is
  therefore partly already available.
- **What is actually missing** is exactly what **0032** describes: the terminal **result row** stays
  text-only, so a post-mortem that reads only the ledger (`agentResult`, `agentManage`) can never
  say what a stopped child **did** — only what it was *saying*. `grep -rn toolActivity src/` still
  returns nothing, so 0032 is open.
- **Action:** do **not** file this as new. Fold the observation into 0032 as a dated `## Update`:
  a `turn-cap` child that committed only tool turns is the cleanest reproduction of 0032's gap, and
  the transcript half of the premise is confirmed retained (matching 0032's post-IT19 framing).
  Then implement 0032's `toolActivity` tally as designed — a **separate bounded field**, not a wider
  `partialContent`, and it must join the snapshot input-fold-emit chain that 0032 names, or the
  feature exists in one execution mode only.
- **Acceptance:** `agentResult` on a turn-capped child reports a bounded count of calls/results
  without widening `partialContent`, is absent on a `completed` row, and survives
  `restore -> snapshot` idempotently.

### B5. `delegate`'s pending placeholder may omit `invocationId`/`threadId` — **unverified, needs a live async repro**

**IT3 defect 0037. I could not reproduce it: both of my delegations settled synchronously, so I
never saw a placeholder. Treat as unconfirmed.**

- **What the contract promises:** the allowlist description of `delegate` documents the placeholder
  as `{ status: "pending", callId, name, invocationId, threadId, elapsedMs, note }` — so the two
  handles are contractually present.
- **Reproduce:** delegate something that does real I/O (a child that must call a tool) and read the
  tool message the delegation returns. If it is a placeholder, check both ids are there.
- **If confirmed:** fold into the existing **0007 P1** row about the base/zero-subagent `delegate`
  description and the generated manifest teaching a smaller contract than the allowlist description
  (the placeholder paragraph at `src/core/metadata.ts:249` vs the base text at
  `src/tools/runtime/delegate.tool.ts:135-137`). That row already covers the documentation half;
  this item adds only the runtime half.
- **If not confirmed:** delete the item and record the refutation in 0007 so it is not re-filed —
  the log has precedent for exactly that.

---

## Group C — refuted. Do not implement; record so it is not re-filed

### C1. `threadSend` to an agent's own idle default does **not** claim "a run is in flight"

IT3's defect 0038 quoted `"agent:instruct" already has a run in flight` and called it misleading
because the row was `idle`. **That wording does not come back today.** Verbatim, from this pass:

> `Tool "threadSend" failed: "agent:instruct" is agent "instruct"'s own conversation and is idle: a message into it would start a second turn of the agent that is asking. Use this turn, or address a thread you created (see threadList).`

That names the real cause and gives the remedy. Either it was fixed in the week since IT3 ran, or
IT3 misquoted. **No action** beyond a one-line refutation note in 0007.

### C2. `threadFork`'s answer is not entirely unbounded — `contentLength` is present

IT3's defect 0039 claimed the fork result carries "no `contentLength`/`truncated`/`nextOffset`".
The transcript shows the fork result **did** carry `contentLength` (16,015). What remains open is
narrower and **unreproduced**: whether `truncated`/`nextOffset` are emitted once a fork answer
exceeds the 32,768-byte per-result delivery cap. IT3 never generated an over-cap fork, and neither
did I (15,957 chars fit). **Action:** if anyone wants this closed, generate a >32 KiB fork answer
and look. Until then it is a contract-wording question, not a defect.

### C3. IT3's own retraction — keep it retracted

IT3 originally reported that the `threadSend` default-conversation note names the wrong thread. It
re-tested with a provably mid-run child and **withdrew the finding in full**; a separate reviewer
objection (`queued` vs `started`) collapsed the same way. Do not re-file either.

### C4. `agentManage` arithmetic is correct

Observed this pass: `totalResults: 64`, per-agent `invocationCount` summing to 7, `hiddenResults: 57`.
`64 − 7 = 57`, exactly the documented rule (retired rows stay readable by id but are listed by no
agent). IT3 reached the same conclusion independently. **Not a defect.**

---

## Group D — host/UI, outside this package

The sidebar the owner was looking at renders two things the harness package does not decide:

1. **`branch-N` rows.** Those are `threadFork` branches, not delegated children. A fork returns
   `branchId` and `threadId` as the *same* `branch-N` string, never appears in `threadList`, and is
   released only when its parent conversation is deleted. `threadRead` accepts it; `threadDelete`
   refuses it as "a fork record, not a conversation"; `threadSend` refuses it. The UI badge is fine
   — but it should not be clickable as a conversation.
2. **Released threads still shown, with last-known status.** `threadDelete` is a *mark*, not an
   erasure: the row leaves the roster and every agent-facing door while its transcript and result
   rows are retained. IT3 released all 13 children it minted, yet the tree still showed them. That
   is a display choice, not a ledger bug — but a released/inactive row should be visually distinct
   from a live `error` row, or the tree reads as failures that never happened.

Most of the red `error` rows in that screenshot were **intentional probes**, not breakage:
turn-cap (`maxTurns` 2 and 4), a 500 ms timeout, and a caller `toolCancel` — each one a failure path
IT3 fired on purpose.

---

## Suggested order of work

| # | Item | Cost | Gate |
|---|---|---|---|
| 1 | B1 `offsetClamped` on `agentResult` | small, self-contained | none |
| 2 | B2 owner-aware `agentResult` refusals | small | none |
| 3 | B3 `timeoutMs` prose (+ owner decides on auto-release) | small (prose) / medium (behaviour) | owner decision |
| 4 | B4 → fold into 0032, then implement `toolActivity` | medium | snapshot chain must carry it |
| 5 | B5 placeholder ids | probe first | unconfirmed |
| 6 | A1/A2 pin check | trivial | none |
| 7 | C1–C4 refutation notes in 0007 | trivial | none |

## Out of scope

- No change to the rank model, `scope.tools` semantics (that is 0023), or the `maxChars` ceiling
  entry (that is 0026).
- No change to `partialContent`'s `min: 1` reader bound — the present-and-empty shape was declined
  by design (0007, ex-0020).
- No new issue files for Group C. The log holds live gaps only.

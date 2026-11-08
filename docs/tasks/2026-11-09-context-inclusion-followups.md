# Context inclusion (Stage 1) — what shipped, and the eleven edges left open

Status: **partly closed — Stage 1 (1a + 1b) is implemented on the current working tree.
T8 LANDED 2026-11-09 (the branch discriminator), as part of T3 of the companion pipeline
entry — one owner, one landing, exactly as this file's *Tasks* order asked. T1, T5 and T6
LANDED the same day (the stable transcript address `messageId`, the live context metric
`currentEstimatedTokens()`, and the ratified `included: true` normalization + host-hygiene
rule). T3's pipeline half (`context.edit`, the branch discriminator) landed with T8. **T4 LANDED
2026-11-09 as one change with T4.4 of the companion progressive-compaction entry — one plugin
round now reports ONE `agent_message`, while host writes stay per-write (whoever edits the
harness owns it, and the harness was edited once).** **T3 LANDED the same day** (the worker-lane
sync the pipeline entry owns: `transcript:patch` + the lane's `committedDigest` base + the
authority's `patchThreadMessages` replay), and its acceptance artifact is the durability
sentence below F3 — REPLACED, not restated. **T9 CLOSED 2026-11-09 by the documentation pass**
(`docs/plugins.md` owns the author-guide text, `docs/README.md` indexes it, and the
README/knowledge "Not built yet" + run-end lists are aligned — see the landing note under T9).
T2 stays deferred by its own rule, and **T7 (the UI marker) is the only task this file still
holds open.** This file is not a
defect report: every item below is either a
documented scope limit of the stage or a consequence of it. Written against revision
`44cdbbe` ("Upgraded Task Logic") of the **`@underload/harness` package repository** (its
own git repo at `packages/underload/harness/.git`), working tree **dirty with the Stage 1
work itself** (`git diff --stat -- src` → 2 206 insertions / 108 deletions across 15
files). Every `path:line` was read out of that tree, so the line numbers describe
**uncommitted** code: re-run the drift check at the end before trusting any of them.

Review provenance is stated once, honestly: Stage 1a was accepted, and Stage 1b was
accepted with caveats that were closed except the worker-lane sync item (F3). That is the
outcome of the review sessions that produced this tree and **cannot be derived from the
source** — it is recorded here as context, and F3 is the source-backed evidence that the
one open caveat is real.

Companion entries:
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) (the framework work
this feeds; T4 there owns the worker sync) and
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) (the first
consumer of `setIncluded`). Related issues:
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md),
[../issues/0007-improvements-review-list.md](../issues/0007-improvements-review-list.md).

## Date / Method / Scope

**Date:** 2026-11-09.

**Method:** static audit of the shipped surface — the flag's declaration, the projection,
the plugin-facing control, and each persistence path — plus one grep per negative claim
(for example: does anything in `src/frontend/` render the flag? does any lane mutation op
rewrite the committed prefix?). The tests were read as contracts, not executed: this is a
documentation-only change, so **no test run was required** for this file, and the counts in
the table below are static counts, labelled as such.

**Scope:** the `included` flag and the `turn.before` control surface that writes it —
`src/types/index.ts`, `src/harness.ts` (`projectTranscript`, `transcriptUnits`,
`emitTurnBefore`), `src/core/agent.ts` (`withIncluded`), `src/core/snapshot.ts`
(`applyIncluded`), `src/core/branch.ts` (`copyIncluded`, `copyMessage`,
`incorporateBranchHistory`), the worker protocol (`src/server/workers/*`), and the
frontend/contract surfaces.

**Out of scope:** compaction policy (the compaction entry), the decision/pipeline questions
(the pipeline entry), and the token-budget gaps that
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md)
owns.

## Requirement

The stage's own contract, restated from the shipped comments so an implementer of a
follow-up knows which invariant each edge trades against:

- **R1 — context control never deletes.** An entry can be disabled, re-enabled, and stays
  in canonical history; only `false` is stored, absent means included, and re-enabling
  **removes the key** (`src/types/index.ts:117-134`, `:3476-3482`; the write is
  `delete member.included` / `member.included = false`, `src/harness.ts:7516-7528`).
- **R2 — the projection stays provider-pair-clean.** The exclusion unit is the whole
  tool-call block, so a request never carries a half-answered `tool_calls[]` or an orphan
  result (`src/types/index.ts:131-134`, `:3480-3481`; `src/harness.ts:564-580`,
  `:5702-5814`).
- **R3 — the default path stays byte-identical.** With no flag anywhere, transcripts,
  snapshots, branch records and provider payloads are exactly what they were before the
  stage, and **no request object ever carries an `included` key at all** — not even
  `included: true` from a hand-built message (`src/types/index.ts:124-129`,
  `src/core/agent.ts:155-178`, `src/harness.ts:5697-5701`, `:7785-7792`).
- **R4 — persistence parity.** A plugin's flag write is reported as an `agent_message`
  state change like every other transcript write, and is carried by snapshot/restore, by
  fork/reset, and by branch incorporation (`src/harness.ts:7627-7640`; see the verified
  table below).
- **R5 — strict validation, all-or-nothing writes.** A non-boolean `included`, a
  non-integer or out-of-range index, a foreign entry and a stale entry each throw
  **before** anything is written, and coercion is refused because a truthy string would
  silently have re-enabled (`src/types/index.ts:3504-3512`, `src/harness.ts:7534-7619`).
- **R6 — the surface must stay addressable and observable** across turns, restarts, lanes,
  branches and the UI. This is the requirement the edges below fall out of: it is the one
  the stage only partly met, by design and on purpose.

### What Stage 1 ships (verified on this tree)

| Capability | Where | Evidence |
|---|---|---|
| `included?: boolean` on all four `HarnessMessage` variants; absent/`true` = included; only `false` stored | `src/types/index.ts:117-134` (rule block), `:141`, `:155`, `:167`, `:196` | single normalization point `withIncluded` at `src/core/agent.ts:155-178`, applied by `seed()`/fork baseline at `:431-464` and `:418` |
| Unit-aware filtering, request-only; canonical history untouched; pending placeholders suppressed for an excluded unit | `src/harness.ts:5685-5814` (`projectTranscript`: pass 1 `:5713-5719`, pass 2 `:5721-5738`, `isExcluded` `:5745-5748`, withheld-block consumption `:5755-5766`, placeholders `:5794-5810`) | every projected copy passes through `withIncluded` (`:5769`, `:5790`) |
| Persistence: snapshot reader + writer | `src/core/snapshot.ts:211-227` (`applyIncluded`), per-role key lists `:238-244`, `:265-267`, `:293-295`, `:328-330`; writer re-validates canonical messages at `src/harness.ts:8974` | a snapshot carrying `included: true` is accepted and normalized away (`src/core/snapshot.ts:214-216`) |
| Persistence: branch copy, materialization, incorporation, fork/reset baseline | `src/core/branch.ts:432-450` (`copyIncluded`), `:457-570` (`copyMessage`, lists at `:467`, `:483`, `:505`, `:564`), `:642-668` (a pending placeholder inherits its unit's flag), `:742`, `:841-890` (`incorporateBranchHistory`; a demoted child system instruction keeps `false`, `:871-886`) | fork baseline re-clones through `copyBaselineMessage` → `withIncluded` (`src/core/agent.ts:185-248`, used `:418`) |
| Plugin-facing 1b: `HarnessContextEntry`, `context.entries`, `context.setIncluded`, `context.currentMessages`, same-request re-projection, strict validation, lazy entries | `src/types/index.ts:3410-3441`, `:3443-3540`; `src/harness.ts:7404-7821` (units `:7485-7508`, write `:7516-7528`, resolve `:7534-7591`, `setIncluded` `:7593-7641`, projection cache `:7441-7450`, context factory `:7647-7761`, round application `:7763-7820`) | precedence is spelled out at `src/harness.ts:7356-7369` |
| Tests | `src/harness.inclusion.test.ts` — **35 `it()` blocks** (static count), sections at `:277`, `:340`, `:458`, `:541`, `:755`, `:927`, `:1879`; plus `src/harness.snapshot.test.ts:802+`, `src/harness.fork.test.ts:435-522`, `src/harness.action-request.test.ts:502-575`, `src/core/branch.test.ts`, `src/core/agent.fork.test.ts:201`, `src/core/agent.attachments.test.ts:83`, `src/transport/openai.test.ts:181`, `src/server/transcript.test.ts:552-575` | the pairing oracle is `wireIssues` (`src/harness.background.test.ts:365`), restated in `src/harness.action-request.test.ts:79` |
| Suite state on this tree | full harness suite **2 953 passed / 2 skipped**, typecheck green — **as reported by the session that produced the tree; not re-run for this documentation change** | re-run `npm test` (`package.json:96`) and `npm run typecheck` (`:106`) to confirm |
| Suite state after T1/T5/T6 | **3 047 passed / 2 skipped across 176 files**, `npm run typecheck` green, and a test-including `tsc` probe with **no new error** — the package's `tsconfig.json` excludes `**/*.test.ts`, so under a probe that re-includes them the suite carries ~458 PRE-EXISTING type errors (94 of them `lib` gaps like `Array.prototype.at`), and this change added none | measured 2026-11-09 on the tree these tasks landed on |

## Findings

### F1. There are no stable message ids — entries are addressed by index or by live object identity

> **CORRECTED IN PLACE 2026-11-09 (T1, landed).** A canonical `HarnessMessage` now carries
> an optional `messageId` (`msg-<n>`, one sequence per transcript), `HarnessContextEntry`
> exposes it, and `setIncluded` accepts it as a THIRD target form alongside the shipped
> index and entry. Index and object-identity resolution were NOT replaced — the rows below
> remain true of them, and remain the reason the id exists. The full decision record, the
> minting/copy/persistence rules and the test evidence are in T1's landing note.

| Fact | Where |
|---|---|
| `HarnessMessage` carries no id of any kind | `src/types/index.ts:141`-`:196`; the snapshot key lists name every legal key per role and an id is not among them (`src/core/snapshot.ts:238-244`, `:265-267`, `:293-295`, `:328-330`) |
| An entry's `index` is "the position at the moment THIS entry object was built" — a snapshot, not a handle | `src/types/index.ts:3419-3425` |
| Resolution of an entry target is `canonical.indexOf(target.message)` — **object identity** | `src/harness.ts:7579-7590`; the issued-entry guard is a `WeakSet` (`:7458`, `:7505`, `:7573-7577`) |
| A numeric index is interpreted against the CURRENT transcript, so a growth or a rewrite changes what it means | `src/harness.ts:7537-7559` (bounds message names the live range) |
| Canonical messages are stable objects **within** a conversation because the flag write is in-place by design ("preserves every message identity and the transcript positions the running turn still depends on") | `src/harness.ts:7510-7515` |
| Across processes there is nothing to point at: a restored transcript is rebuilt from records (`src/harness.ts:9306`, `:9340`) and a branch **mints new provider ids** per materialization (`src/core/branch.ts:647-656`, `createBranchId` `:139`) | so an id minted at authoring time would have to survive both |

Consequence: a hook can address a turn **only inside one `turn.before` round**. Anything
that wants to reference a turn across turns, across a restart, or from a UI is inventing
its own key today. **Since T1 that is no longer the whole truth**: across turns and across
a restart a `messageId` does the job, and "from a UI" is the part still open (the id is in
the transcript document the transcript dialog already renders, but T7 owns surfacing it).

### F2. Inclusion is unit-level; there is no per-call partial

`HarnessToolCall` is `{ id, name, arguments }` (`src/types/index.ts:108-112`) and the
transport emits **every** call of a block (`src/transport/openai.ts:305-308`). So one
assistant block asking for `read` + `write`, where only the `read` result should be
withheld, is withheld **whole** — by `setIncluded`'s own cascade
(`src/harness.ts:7516-7528`) and by both consumers of the unit map
(`src/harness.ts:564-580`, `:5702-5814`). `src/core/snapshot.ts:68-81` (tool-call reader,
strict whitelist at `:72`) and `src/core/branch.ts:642-668` are the two places a per-call
flag would have to be added before it could round-trip.

### F3. Worker lanes never publish an in-place change to the committed prefix

> **CLOSED 2026-11-09 (pipeline T4.1/T4.2/T4.3, landed).** The rows below are why the last
> caveat in `src/types/index.ts` said what it said, and they were true of `44cdbbe`. A lane now
> also publishes an IN-PLACE rewrite of its committed prefix, as `transcript:patch`
> (`src/server/workers/lane-commit.ts`) compare-and-set against the digest of that prefix as the
> lane last adopted it — a base `LaneWorkerState` now carries beside `committedLength`, because
> the length alone cannot see a flag or an edit at all, which was the exact bug. The authority
> replays it on the canonical harness through `harness.patchThreadMessages` and reports the same
> `agent_message` change, which is what puts it in `state.json`; and the same content check now
> runs the other way too (`transcript:sync`'s `haveDigest`, the `turn` frame's `fromDigest`), so
> an operator's in-place transcript edit reaches a live replica instead of the replica serving
> it from a stale copy. The rows stay as the reasoning behind the shape: whole-prefix rather
> than sparse, CAS rather than merge, and `prefix-moved` → rebase as the one conflict path. The
> sentence at the bottom of this table is the acceptance artifact, and it was REPLACED.

| Fact | Where |
|---|---|
| The lane's owed operations are deltas only: "Nothing here is a whole-state diff" | `src/server/workers/lane-worker-loop.ts:632-634` |
| The transcript op fires **only when the replica is longer** — an in-place flag change does not change length | `:638-648` (`if (transcript.length > lane.committedLength)`), `committedLength` semantics `:134-139` |
| The mutation union has no replace/patch form for a transcript (records have one: `patch + expects`) | `src/server/workers/lane-commit.ts:183-208` (`transcript:append` `:189`, `record:update` `:185`) |
| The authority applies an append and answers a pull for the missing tail | `src/server/workers/lane-authority.ts:773-775`, `:129` + `:705` (`transcript:sync`), `prefix-moved` `:845` |
| Turn start **pulls** the canonical delta; nothing pushes a rewrite | `src/server/workers/lane-worker-loop.ts:1092-1096`, `syncTranscript` `:817-855` |
| The public contract already says so | `src/types/index.ts:3493-3502` — "do not treat the flag as restart-durable under `threadExecution: 'worker'` until that lands" — **REPLACED 2026-11-09 (T3)**: the paragraph now states the write IS restart-durable in both lanes, names `transcript:patch`/`patchThreadMessages` as the mechanism, and states what a refused patch costs instead of hiding it |

Inline mode is complete: the write is canonical and reported (`src/harness.ts:7638-7640`)
and the server's `state.json` captures it at the next boundary
(`src/server/persistence.ts:33-44`). Worker mode is correct-until-restart.
**The last sentence was the state of `44cdbbe`; since T3 landed, worker mode is correct AT the
restart too** — the lane pushes the in-place write, the authority reports it, and the durable
document carries it (see the closure note under *T3* for what pins it, and for the one
lane-side step still open: a host plugin cannot run inside a replica, which is the pipeline
entry's F5 and T4.4).

### F4. `replaceHistory()` invalidates every entry (and every index) captured before it

| Fact | Where |
|---|---|
| The type comment states it: a handler that calls `replaceHistory()` invalidates the indices **and the message identities** of earlier entries | `src/types/index.ts:3421-3424` |
| The runtime refuses a stale entry loudly, and its message names the cure ("Read `entries` again after `replaceHistory()`") | `src/harness.ts:7581-7585` |
| An entry stays usable when the transcript merely GREW; only a replaced list invalidates it | `src/harness.ts:7587-7590` |
| The emit-site header repeats the ordering caveat for `entries` **and** for numeric indices | `src/harness.ts:7373-7378` |
| `replaceHistory` is refused outright on a branch run, because it rewrites persistent state | `src/harness.ts:7735-7750` (`:7736-7740`) |

That is the correct behaviour, but it means a compactor that prunes **and** summarizes in
one handler must re-read `entries` between the two writes — a rule that currently exists
only inside comments.

### F5. `context.messages` is entry-time; `currentMessages()` is the live view — the two are different on purpose

| Fact | Where |
|---|---|
| `messages` is "the array the provider was about to receive WHEN THIS HANDLER WAS ENTERED… it does NOT move when this handler writes" | `src/types/index.ts:3451-3458`; implementation `src/harness.ts:7648-7659`, `:7694` |
| `currentMessages()` is the same projection evaluated at access time, and is what the provider will actually receive | `src/types/index.ts:3459-3469`; implementation `src/harness.ts:7701-7702`, sharing the one cache `:7441-7451` |
| They are the **same array** while nothing has been written, so an observing handler pays nothing for the distinction | `src/types/index.ts:3466-3468` |
| A later handler is entered with the earlier handler's result, because the context is rebuilt per handler | `src/harness.ts:7655-7659`, `src/plugin/hooks.ts:103-115` |
| After the round both are frozen to what the round decided | `src/harness.ts:7460-7480`, `:7702` |

Not a defect — but the distinction is invisible in the type names, and an author who reads
`messages` after their own `setIncluded` call sees a stale list. **The same pairing now
exists for the size of the request (T5): `estimatedTokens` is the entry-time number and
`currentEstimatedTokens()` is the live one, and both type comments say which is which.**

### F6. One persistence notification per write, and the save is a whole-document rewrite

`setIncluded` reports `agent_message` per call (`src/harness.ts:7638-7640`), which is the
documented **only** durability mechanism for the flag (`src/types/index.ts:3490-3492`). The
reason it is worth coalescing:

| Fact | Where |
|---|---|
| Durability is one whole-document atomic rewrite per boundary (stage + fsync + rename) | `src/server/persistence.ts:33-44`, `:1557-1616` |
| The event's own `reason` is documented as "a coarse hint for coalescing/debouncing a save" | `src/types/index.ts:2410-2412` |
| The same cost is already a review item (no session-count bound, no retention policy) | [../issues/0007-improvements-review-list.md](../issues/0007-improvements-review-list.md), *Operations and scaling* |

A 40-unit prune is therefore 40 notifications today. Nothing is wrong — the observer is
advisory and swallowed (`src/harness.ts:1134-1139`) — but the batching opportunity is
stated by the contract and not taken.

**CORRECTED 2026-11-09 — T4 landed, so the sentence above is now the history of the problem.**
One `turn.before` ROUND reports ONE `agent_message` however many canonical writes it made:
`setIncluded` and `edit` mark the round dirty and `closeRoundObservations()` flushes the single
report at the round boundary (before the request goes out, so durability is never later than it
was). A 40-unit prune is 4 writes-batched-into-1 notification, and the durable test in
`src/server/persistence.test.ts` measures it rather than asserting it — 2 transcript reports for
the same run with the policy off, 3 with a three-unit pass. Host writes are deliberately
untouched, which the same suite pins.

### F7. `entries` is lazy and per-handler; `estimatedTokens` is the entry-time number

| Fact | Where |
|---|---|
| `entries` is built on **first access**, cached for that handler, rebuilt for every handler, and frozen when the round closes | `src/types/index.ts:3470-3475`; `src/harness.ts:7661-7679`, `:7708-7712`, `:7464-7480` |
| `estimatedTokens` is deliberately **not** a getter: a mid-handler flag write must not move the number underneath the compactor's own limit/cooldown checks | `src/harness.ts:7718-7725`, `src/types/index.ts:3514-3517` |
| So the size the operator sees never reflects what their own write just saved | `src/core/context-estimate.ts:108` is the estimator; the prune's own savings are invisible to the same handler |
| The estimate itself is `chars/4` and never counts `reasoning` (attachment **bytes** excluded by design) | `src/core/context-estimate.ts:1-41`, `:28-33`, `:48` |
| `turn.before` exposes no pending-call list, so an in-flight call cannot be told apart from an unanswered unit by `entries` alone | `src/types/index.ts:3446-3540` has no `pending` member; the pending view exists internally (`src/harness.ts:5572-5577`, `HarnessPendingTool` `src/types/index.ts:228-232`) |

T5 below either makes the number live or documents, in the reference, that it is a
snapshot — "silently entry-time" is the only option that is not acceptable.
**CLOSED 2026-11-09 by T5, option (b):** the number is still entry-time, the type comment
and the implementation comment now name that out loud, and `currentEstimatedTokens()` is
the live twin a handler uses to measure its own prune.

### F8. `included: true` is normalized at every read/snapshot/projection edge, but not at every live canonical write

| Fact | Where |
|---|---|
| Canonical `agent.messages` is a public mutable array, and the state-change observer **cannot** see a direct edit | `src/types/index.ts:2418-2420` ("`agent.messages` mutated by a tool or host code directly"), `src/harness.ts:1122-1126` |
| The runtime's own writer only ever stores `false` and deletes the key to re-enable | `src/harness.ts:7516-7528` |
| Every **entry** path normalizes: seed, fork baseline, replacement, restore, branch copy | `src/core/agent.ts:155-178` + `:431-464`; `src/harness.ts:4778-4789` (validated through `readHarnessMessages`); `src/core/snapshot.ts:211-227`; `src/core/branch.ts:432-450` |
| Every **read** path re-derives the request without the key | `src/harness.ts:5697-5701`, `:5769`, `:5790`; an explicit override is sanitized too (`:7785-7792`) |
| `snapshot()` re-validates through the reader, so `state.json` cannot keep `true` | `src/harness.ts:8974`, `src/core/snapshot.ts:214-216` |
| **But** `threadMessages()` — what `api.threads.messages` and the server's transcript GET return — is a raw JSON clone of canonical state | `src/harness.ts:561-562`, `:4739-4740` |

So a host or tool that writes `included = true` in place leaves a form the runtime never
writes: invisible to the model and to snapshots, **visible to every read surface**, and
different from what the same code will look like after a restart. The server's transcript
PUT is safe (it validates: `src/harness.ts:4791-4806`, pinned by
`src/server/transcript.test.ts:552-575`); the gap is the direct-edit path the contract
already admits it cannot observe. T6 decides whether the runtime should also normalize on
read, or whether "never write `true`" is a rule hosts must simply keep.
**DECIDED 2026-11-09 (T6): keep normalizing, write the rule where a host reads it, and do
NOT add read-side normalization.** T6's landing note records the four entry points, the one
path that stays raw, and where the rule now lives.

### F9. `entry.message` is the live canonical object, and its nested arrays are shared

| Fact | Where |
|---|---|
| The entry hands out the canonical message **itself**, and the contract says it is read-only by convention | `src/harness.ts:7493-7495` (`index`, `message`), `src/types/index.ts:3426-3429` ("Mutating it directly would bypass the key normalization and the persistence notification") |
| `withIncluded` is a **shallow** spread, so a projection copy shares the `toolCalls` and `attachments` arrays with canonical state | `src/core/agent.ts:171-178`; consumed at `src/harness.ts:5769`, `:5790`; unit resolution walks `message.toolCalls` for ids (`:5729-5737`) |
| A host-facing read is detached (JSON clone), so only the entry is shared | `src/harness.ts:561-562`, `:4739-4740` |
| Nested `toolCalls` are the pairing keys the projection and the transport both trust | `src/harness.ts:5780-5790`, `src/transport/openai.ts:305-308`; ids are conversation-unique by enforcement (`src/harness.ts:5822-5857`) |
| Persistence of nested arrays is strict per key, so a mutation that adds a key fails to load | `src/core/snapshot.ts:68-81`; `src/core/branch.ts:642-668` |

The rule is correct and cheap, but nothing enforces it: a plugin that sorts
`entry.message.toolCalls` in place changes the **call order** the projection preserves
(`src/harness.ts:5786-5790`) and the transcript it later tries to snapshot, with no
notification at all.

### F10. The UI has no notion of "this turn is excluded"

| Fact | Where |
|---|---|
| Progress events carry no inclusion field — the union has `tool_result`, `done`, `usage`, etc., and no flag | `src/types/index.ts:2234-2262` |
| The conversation board is event-driven, so it cannot show what no event reports | `src/frontend/ui/turns.ts:1-8` (the board renders server `SessionTurn` records and their `events`), and the transcript dialog's own header on what the harness records: "the harness records progress events, not raw provider traffic" (`src/frontend/ui/thread-transcript.ts:24-30`) |
| Grep `included` across `src/frontend/*.ts` and `src/frontend/ui/*.ts` → **no** use of the flag (the only hits are unrelated locals, e.g. `src/frontend/main.ts:1644`) | so there is no marker, no count, and no filter |
| The flag IS visible in the transcript JSON document, which is a `<pre>` of `JSON.stringify` of the server's recorded messages | `src/frontend/ui/thread-transcript.ts:31-32`, `:425` |
| And it IS in the published API contract for all four variants | `src/server/harness.swagger.yaml` `included:` at `:7999`, `:8019`, `:8041`, `:8074` |

Operator impact: after a compactor prunes 30 units, the visible product tells you nothing.
The transcript dialog shows the flag if you scroll to it, and the context bar's number
moves with no explanation (F7).

### F11. A branch round has no first-class discriminator

> **CORRECTED IN PLACE 2026-11-09 (T8, landed with pipeline T3.4).** The rows below
> described the tree the audit read. `HarnessTurnBeforeContext` now carries `actorKey`
> (the run's scheduling identity: display name / `thread:<id>` / `branch:<id>`) and
> `branchId` (present only for a branch, and the same `branch-<n>` the state-change plane
> already reports), so a policy CAN tell a root round from a fork round in one test. The
> rows are kept because the reasoning is the reason the fields look the way they do —
> `threadId` still means the spawning conversation, unchanged and now pinned by a test, and
> the cooldown pollution in `src/plugins/context-compaction.plugin.ts` is STILL there (it
> is a behaviour change to a shipped plugin, and the compaction stage owns it).

| Fact | Where |
|---|---|
| `turn.before`'s identity block is `{ threadId, agent, iteration }` — the thread of a branch round is the **spawning** conversation | `src/types/index.ts:3446-3450`; the shared block `:3397-3408` (`threadId` absent only for a branch — but `turn.before` falls back to `run.actorKey`) |
| The implementation comment states the trap: a branch and its root report the **same** `threadId`; `run.actorKey` (`branch:<id>`) is only a fallback, and "a plugin therefore cannot tell a branch round from a root round by `threadId`" | `src/harness.ts:7681-7689` |
| The compaction guard's cooldown map is polluted by branch actor keys because of exactly this | `src/plugins/context-compaction.plugin.ts:53-66` |
| Branch semantics genuinely differ: the flag applies to an ephemeral copy, no notification is reported, `replaceHistory`/`pause`/`resume` are refused or no-ops | `src/types/index.ts:3500-3502`; `src/harness.ts:7631-7640`, `:7735-7750`, `:7751-7759` |
| Elsewhere the branch id IS modelled, so the information exists to expose | `src/core/branch.ts:115-139` (`agentBranchOf`, `createBranchId`), `src/types/index.ts:2434-2443` (`HarnessStateChangeEvent.branchId`) |

A policy that behaves differently for a fork (usually: don't prune a transcript that is
about to be incorporated into its owner) cannot currently express that difference.

**USED 2026-11-09 — the discriminator T8 shipped (`context.branchId`) was consumed by exactly
the decision this finding predicted, and it removed the third row of this table as a side
effect.** The shipped compaction policy declines to prune on a branch round at all: the flag
would land on an ephemeral copy that is incorporated as text, the owner re-derives the same
decision on its own round, and the cooldown entry keyed by `branch:<id>` could never be
cleared. Both the guard and the action check `branchId`
(`src/plugins/context-compaction.plugin.ts:458`, `:301`), so the cooldown map is no longer
polluted by branch actor keys and the map's documented "never pruned" caveat lost one of its
two cases. Pinned in `src/plugin/context-compaction.test.ts` (a branch round parks nothing,
acts never, and leaves the owner's own crossing fresh) and in
`src/harness.inclusion.test.ts` (a flag write still works on a branch round and reports
nothing, which is the ephemeral-copy semantics this row describes).

## Tasks

Order: T1 and T6 are contract decisions, T3 is the only real durability bug-shaped item,
T2/T4/T5/T7/T8 are additive, T9 is text. T3 is owned jointly with
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md)
T4.1 — one owner, one landing, no duplicated protocol work.

### T1 — Stable message ids: add them, or defer them out loud

- **T1.1 — decide the addressing question.** Options: (a) no ids, accept F1, and say in the
  reference that a `turn.before` entry is valid only within its round; (b) mint an internal
  id per canonical message (`messageId`) and let `entries` expose it, with
  `setIncluded(entry, …)` resolving by id; (c) reuse provider `toolCallId` for tool units
  only (cheap, partial: it does not cover `system`/`user`/plain-assistant entries).
  Recommendation: **(b), introduced as an additional target, never a replacement** — the
  current identity/index resolution already works and is tested
  (`src/harness.ts:7579-7590`), and removing it is a breaking change to a shipped surface.
- **T1.2 — minting points, if (b):** the only places a canonical message is created are
  `src/core/agent.ts` (`seed()`, `:406-470`; the per-role copies at `:195-248`) and
  `src/harness.ts:5660-5666` (`insertToolMessage`) — plus the assistant commit inside
  `agent.turn()`. Every one of them must mint exactly once and never re-mint on copy, or
  the id stops being an identity.
- **T1.3 — snapshot migration.** `readToolCalls`/the four per-role whitelists
  (`src/core/snapshot.ts:72`, `:238-244`, `:265-267`, `:293-295`, `:328-330`) refuse
  unknown keys, so the id must be added to each **and** be optional on read: a
  pre-id `state.json` must still restore. Backfill-on-read (mint when absent) or
  backfill-on-write are both defensible; pick one and make `restore → snapshot` idempotent,
  which is the property `applyIncluded` already protects
  (`src/core/snapshot.ts:214-216`).
- **T1.4 — branch/fork policy.** A fork **duplicates** messages; a branch materialization
  already mints fresh provider ids per replay (`src/core/branch.ts:647-656`) and
  incorporation joins two transcripts that must not collide (`:841-890`). Decide: ids are
  copied (two objects, one identity, across conversations — fine if the API scopes lookup
  to one agent) or re-minted per branch (then `entries` from the owner and from the branch
  never mean the same turn).
- **T1.5 — API addressing.** `HarnessContextEntry` gains the id (`src/types/index.ts:3418-3425`)
  and `setIncluded`'s target union widens (`:3513`) — plus the same stale-entry rule for an
  id that no longer exists, worded like the existing one (`src/harness.ts:7581-7585`).

*Check:* either this section records "deferred, and the reference says entries are
round-scoped" (then T1.2-T1.5 are not scheduled and F1 is a documented property), or a new
test in `src/harness.inclusion.test.ts` addresses a turn **by id across two rounds of the
same conversation**, and `src/harness.snapshot.test.ts` + `src/harness.fork.test.ts` gain
the restore-without-ids and fork-with-ids cases.

**LANDED 2026-11-09 — option (b), `messageId`, as an ADDITIONAL target.** The deferral
branch of the *Check* was not taken: the minting surface proved safe to land, and the cost
was visible churn, not a broken contract.

- **What carries it.** `src/core/message-id.ts` (a new leaf that imports only types) owns
  the id: the `msg-<n>` spelling, the sequence parse, `nextMessageIdOf` (the id for one
  message entering a transcript), `createMessageIdAllocator` (the reader's batch backfill)
  and `assignMessageId` (mint, or carry a copied id). **There is no process-wide counter**:
  a mint is one above the highest numeric id already in the transcript the message joins,
  which is what makes ids reproducible in tests while staying collision-free WITHOUT shared
  state that restore, fork, lane-append and worker processes would each have to keep in step
  — the same reserve-from-max trick `reserveBranchSequence` uses for branch ids. A
  host-authored id that does not spell `msg-<n>` is carried verbatim and treated as opaque,
  and a mint skips any candidate already present verbatim.
- **T1.2 — minted EXACTLY ONCE, at every canonical creation point.** In `src/core/agent.ts`:
  `seed()` (instruction blocks, seeded messages, and the fork-baseline loop), `append`,
  `appendUser` (the path a run's root prompt takes from `runAgentCore`), `stream()`'s prompt,
  the public `assistant()`, and the assistant commit inside `request()`; plus
  `src/harness.ts` `insertToolMessage`. Nothing else creates a canonical message: both host
  transcript writes and both `restore()` pushes install READER output, and the reader owns
  ids there.
- **Never re-minted on a copy.** `withIncluded` is now the REQUEST-SAFE copy — it strips
  `included` **and** `messageId` — so a projection, a `setTranscript` override and a provider
  payload carry neither key. A custom `HarnessStream` therefore sees exactly the flag-free,
  id-free data it saw before the stage existed (R3 survives the new field), and every
  canonical call site then chooses explicitly between minting and carrying the source's id.
  Key order is unchanged for pre-existing consumers: the id is appended LAST, and a
  projection still ends with `included` when it is flagged.
- **T1.3 — BACKFILL-ON-READ, the option the task left open.** Every path into canonical
  state goes through `readHarnessMessages`, so the reader is the one place able to promise
  that a restored transcript is addressable from its first round. `messageId` joined all
  four per-role allowlists in `src/core/snapshot.ts` as an OPTIONAL key: an entry that
  carries an id gets it back verbatim, an entry that does not is minted the next free
  number, and therefore `restore -> snapshot` is idempotent — the property `applyIncluded`
  already protects, pinned by a test instead of asserted in a comment. A
  present-but-unsuitable value (a non-string, an empty string) is REFUSED like any other
  mistyped field rather than silently re-minted. Restoring a document that numbers its
  entries `msg-9`…`msg-11` makes the next creation `msg-12`: the ceiling comes from the
  document, not from a fresh counter.
  **The one real defect this found:** an APPEND is the only read whose array is a *slice*,
  so `readHarnessMessages` gained a `surrounding` parameter and `appendThreadMessages` now
  passes the conversation's own entries — without it a lane append minted `msg-1` into a
  transcript that already used `msg-1`.
- **T1.4 — a fork COPIES ids (the decision this file asks for).** The branch's entry for a
  turn its owner already had is a different OBJECT with the SAME id, which is what lets one
  `setIncluded(id, …)` name that turn on either side. Two consequences are accepted rather
  than papered over: an id is scoped to ONE transcript (every lookup is a scan of
  `brain.messages`, never a registry), so the same number in another conversation is not a
  conflict; and an INCORPORATED branch legitimately holds a duplicate (the owner's prefix and
  the child's copy of that prefix name the same turns), where an id resolves to its FIRST
  occurrence. A branch's own framing entries are materialized WITHOUT an id
  (`core/branch.ts` `flushPending`) and are minted one when the branch seeds its baseline —
  which is why a completed branch record shows an id on every entry.
- **T1.5 — addressing.** `HarnessContextEntry.messageId` (optional, hoisted from the
  canonical message, key OMITTED when there is none so no consumer has to special-case
  `undefined`), and `setIncluded(entry | number | string, boolean)` with the type comment
  listing all three targets. A blank or whitespace-only id is refused as a MISTAKE; an id
  that names nothing gets the stale-entry refusal style with the same cure named —
  ``turn.before setIncluded received a stale messageId "msg-99": no entry with that id is in
  the transcript. Read `entries` again after `replaceHistory()`.`` `edit` deliberately stays
  entry-addressed (a bare id there is a shape error), and a patch that names `messageId` is
  refused with its own reason. Index and object-identity resolution are untouched, so
  nothing shipped broke: the only string that moved is the shared shape message, now
  "needs a transcript index, an entry from this turn, or a messageId."
- **The cost, stated plainly.** A canonical entry now carries one more key, and canonical
  state IS the host-facing document: `threadMessages()`, the server's transcript metadata /
  paged messages / editor document, and `state.json`. That is exactly *why* an id survives a
  restart, and it is visible: 28 test files quoted whole transcripts and had to learn about
  it. The convention chosen is a per-file `withoutIds(...)` deep normalizer (an address is an
  identity field like a timestamp, not the content under test) while the id itself is pinned
  EXACTLY where it is the subject — the three files the *Check* names, plus
  `src/server/transcript.test.ts`, whose fixtures now build the stored form through
  `withIds(...)`, so the pretty-printed editor text and the document `bytes` figures stay
  exact rather than relaxed (115 → 175, 39 → 59, 327 → 427: +20 bytes per entry, the minted
  key verbatim). The published contract moved with the field — `src/server/harness.swagger.yaml`'s
  four `HarnessMessage` variants admit `messageId` with `additionalProperties: false` intact,
  and `src/shared/harness-api.ts` needed no regeneration because it aliases `../types` — and
  `README.md` documents both keys. A snapshot written by THIS build no longer loads on an
  older one, where the key would be an unknown field: the usual one-way direction for this
  schema, recorded rather than discovered.
- **Check evidence.** `src/harness.inclusion.test.ts` gained `mints one address per canonical
  entry in creation order, and keeps it out of every request`; `addresses the same turn by id
  in a LATER round of one conversation` (round one learns `msg-2`, round two disables the
  whole unit with it, both rounds' id lists pinned exactly, the second request pair-clean and
  id-free); `keeps an id addressable across replaceHistory, while the entry object it
  replaced is refused`; and `keeps edit entry-addressed, refuses a patch that rewrites an
  address, and writes nothing`. `src/harness.snapshot.test.ts` gained `restores a transcript
  written before addresses existed, and mints them in transcript order`, `honours the
  addresses a document carries and numbers the next entry above them`, and `refuses a
  messageId that is not a usable address, and leaves the target untouched`.
  `src/harness.fork.test.ts` gained `copies transcript addresses into a branch, and numbers
  the branch's own entries itself`. Focused `src/harness.inclusion.test.ts
  src/harness.snapshot.test.ts src/harness.fork.test.ts src/core/context-estimate.test.ts`:
  **99 → 112 passed**. Full `npm test`: **3 034 → 3 047 passed / 2 skipped**, 176 files, with
  no pre-existing assertion weakened — every id added to an expected value is an exact one.
- **What this does NOT close.** The id has no UI surface (T7); `entry.message`'s nested
  arrays are still shared (F9); a worker lane still publishes only appended slices, so an
  in-place FLAG write on an already-committed entry remains T3's problem (the id itself rides
  along with a message, which is why a lane append keeps working) — **CLOSED 2026-11-09 by T3:
  a lane now also publishes the in-place rewrite of its committed prefix
  (`transcript:patch`), and the id rides along with THAT unchanged, which is why the seam
  refuses a patch that would move a committed entry's address**; and per-call partial
  inclusion (T2) still has nothing to hang a call-level flag on — `HarnessToolCall` is
  unchanged.


### T2 — Per-call partial inclusion, only if a real use case appears

F2. Two candidate designs, both more expensive than they look:

- **Flag on `HarnessToolCall`** (`src/types/index.ts:108-112`): touches the call whitelist
  `src/core/snapshot.ts:68-81`, the branch call remapping `src/core/branch.ts:642-668`, the
  unit resolver (a per-call exclusion makes the "unit" a **sub**-unit —
  `src/harness.ts:5729-5737`, `:5780-5790`), and the projection's pairing contract, which
  must then **reconstruct** `tool_calls[]` to contain only the surviving calls
  (`src/transport/openai.ts:305-308`) while still answering every emitted call.
- **Filtered reconstruction at wire time only** (no new field): cheaper to persist, harder
  to keep honest, because `resultInsertIndex` and `hasToolResult` locate results by call id
  in canonical order (`src/harness.ts:5584-5632`).

**Documented risk, whichever way:** the current all-or-nothing unit rule is what makes
provider pairing unbreakable (R2, and the contract sentence at
`src/types/index.ts:3480-3481`). A per-call rule re-opens exactly the class of bug the unit
rule exists to prevent, and it invalidates the "same array for every member of a unit"
identity that `entry.included` depends on (`src/harness.ts:575-579`, `:7500-7502`).

*Check:* do not implement before a use case is written here with a name. When it is, the
acceptance condition is the pairing oracle (`wireIssues`,
`src/harness.background.test.ts:365`) staying empty on a transcript where one block has
one excluded and one included call.

### T3 — Worker-mode full-transcript sync (owner: the pipeline entry)

The condition to fix is one line: `transcript.length > lane.committedLength`
(`src/server/workers/lane-worker-loop.ts:641`) never fires for an in-place flag change; the
mutation union has nothing to send (`src/server/workers/lane-commit.ts:183-208`); the
authority has nothing to apply (`src/server/workers/lane-authority.ts:773-775`). Design and
sub-tasks live in
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md)
T4.1 (including reuse of the existing `prefix-moved` → rebase path,
`src/server/workers/lane-authority.ts:845`).

*Check:* the sentence at `src/types/index.ts:3493-3502` is **replaced** — that text is the
acceptance artifact. A worker-mode test proves the authority's transcript (not the replica's)
carries the flag after a commit boundary and after a restart.

**CLOSED 2026-11-09 — the artifact is replaced, and the test exists.** Both sentences (the
`setIncluded` persistence paragraph and `edit`'s worker-lane paragraph) now state that an
in-place change is restart-durable in BOTH lanes and name the mechanism instead of disclaiming
it. What carries it: `transcript:patch` in the lane mutation union, `LaneWorkerState.committedDigest`
(the content half of the base, recomputed locally wherever `committedLength` moves), the
authority's replay through the new `harness.patchThreadMessages` seam with ONE `agent_message`
report, and a digest-aware pull (`transcript:sync`'s `haveDigest`, `turn`'s `fromDigest`) for
canonical in-place changes. The design decisions the pipeline entry left to ratify are recorded
in its T4 landing note — `patch + expects` was chosen over `replace`, bound to a digest of the
committed prefix, and the existing `prefix-moved` → rebase path is the only conflict story.

- **Check evidence.** `src/server/workers/lane-commit.test.ts` pins the fold (including that a
  flag-only change APPLIES and that a conflicting patch rolls its whole group back rather than
  half-rewriting a prefix); `src/server/workers/lane-authority.test.ts` pins the live applier
  against a REAL harness — the AUTHORITY's `threadMessages` answering `included: false` plus the
  edited text, one `agent_message` notification, the snapshot→restore round trip, and the
  structural refusals that keep a committed entry's role and address; `src/server/workers/lane-worker.test.ts`
  pins the derivation (`deriveOperations`) and the durable end to end on a real
  `threadExecution: 'worker'` session — a real lane turn, then the patch committed by that
  session's own authority on the live lane's epoch under the writer lease that lane holds, read
  back through the store, found in `state.json`, and read again by a second store over the same
  root. The lane case is stated honestly: the OPERATION is submitted on the lane's behalf by the
  test, because a host plugin still cannot run inside a replica (the pipeline entry's F5 — a
  factory closure cannot cross `worker_threads`), so no `turn.before` handler exists there to
  produce it. That gap is the pipeline's T4.4, and it is where this file's R6 "observable across
  lanes" claim is still bounded.

### T4 — Notification coalescing / debouncing

- **T4.1** Batch one pass: collect the writes, then report once. The write site is
  `src/harness.ts:7638-7640`; keeping per-write notifications for the **host** API
  (`postThreadMessage`, `writeThreadTranscript`) is fine — the problem is only N writes from
  one plugin round.
- **T4.2** If the coalescer is inside `setIncluded`, it needs a round boundary to flush at;
  `closeRoundObservations()` (`src/harness.ts:7475-7480`) already marks exactly that moment,
  so the flush point exists and no new lifecycle concept is needed.
- **T4.3** Do not coalesce across a run boundary: the observer is the durability mechanism
  (R4), and a "later flush" that never arrives because the run failed silently loses a
  write. A same-round flush is safe; a time-based debounce is not.

**LANDED 2026-11-09 — T4.1–T4.3, as ONE change with T4.4 of
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md): the compaction
stage is what made N-writes-per-round real, and the harness was edited once, by that landing.**

- **T4.1** — the batch lives in `emitTurnBefore`: `setIncluded` (`src/harness.ts:8265`) and
  `edit` (`:8366`) call `reportCanonicalWrite()` (`:8009`) instead of notifying, and
  `closeRoundObservations()` (`:7987`) reports once. The host API
  (`setThreadMessages`, `writeThreadTranscript`, `postThreadMessage`) keeps its per-write
  report exactly as this task said it should — the batching window is a plugin round, not a
  time window.
- **T4.2** — the flush point is the existing `closeRoundObservations()`, and no new lifecycle
  concept was added: the same call that freezes `entries` and pins the round's final projection
  also flushes the report, so "the round is over" has one meaning in one place.
- **T4.3** — no debounce, no timer, nothing across a run boundary. Two extra edges the design
  had to answer rather than assume, both pinned: a write that arrives AFTER the round closed (a
  plugin that parked its context) reports on the spot, because its window will never come
  again; and the async round's rejection path flushes before re-raising, so a failure cannot
  lose the report for writes that did land.

*Check:* **met.** `src/harness.inclusion.test.ts` › *one persistence report per plugin round
(context T4 / compaction T4.4)* — four cases: three flag writes in one round (addressed by
index, by `messageId`, and by live entry) report ONCE with all three flags persisted; a flag
write batched together with an `edit` reports once with both changes on the same request; three
successive host `setThreadMessages` writes still report three times; and a late write after the
round closed still reports. The server-plane count is measured differentially in
`src/server/persistence.test.ts` (a 3-unit pass adds exactly ONE report against the same run
with the built-in replaced by a no-op). The existing snapshot suite passes untouched
(`src/harness.snapshot.test.ts`, 43 cases), including the two per-write notification counts
that a single-write round still satisfies — a coalescer that changed them would have failed
loudly, and did not.
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) T4.4 is closed
by the same change, as this task predicted.

### T5 — Live context metrics, or documented entry-time semantics

Pick one (F7): (a) make `estimatedTokens` a getter and re-run the compactor's guard against
the post-write number — but the current non-getter is a **deliberate** choice with a stated
reason (`src/harness.ts:7718-7725`), so (a) must also move the cooldown logic or accept that
a pass can trigger on a transcript it never measured; or (b) keep it entry-time and say so
in the type comment and the reference (`src/types/index.ts:3514-3517`), and add
`currentEstimatedTokens()` beside `currentMessages()` (`:3469`, `:3517`) so a plugin that
wants its own savings can ask. Recommendation: **(b)** — it preserves the shipped
behaviour and gives the compactor the number it needs for its minimum-savings floor.

*Check:* either the type comment names the entry-time semantics explicitly, or the new
accessor exists with a test asserting it reflects a `setIncluded` made earlier in the same
handler (exact value, computed with `src/core/context-estimate.ts:108`).

**LANDED 2026-11-09 — option (b), both halves.** `estimatedTokens` is unchanged (a plain
entry-time value, so `context-compaction`'s limit and cooldown checks still cannot move
underneath the transcript they measured), and the type comment plus the implementation
comment now say that in those words instead of only defending the choice.

- **What was added.** `HarnessTurnBeforeContext.currentEstimatedTokens()`, beside
  `currentMessages()`, sharing its source: the same `estimateContextTokens` over exactly the
  list `currentMessages()` returns, plus the same leading instruction blocks. The two live
  accessors were routed through one closure (`currentRequestMessages` in `src/harness.ts`) so
  the live list and the live number can never answer about different transcripts, and both
  freeze to the round's decision once the round has computed its request, as
  `currentMessages()` already did.
- **One contract note.** This is a REQUIRED member of a plugin-facing type, so a hand-built
  `turn.before` payload stops typechecking without it. That is the only consumer-visible
  consequence, and the shipped test fake that fabricates a payload
  (`src/plugin/context-compaction.test.ts`) was completed for it.
- **Check evidence.** the test ``keeps `estimatedTokens` entry-time and reports the savings
  through currentEstimatedTokens()`` in `src/harness.inclusion.test.ts`, pinned to exact values
  from `src/core/context-estimate.ts`'s own rule (`ceil(chars / 4)`): the projection this handler
  was entered with is 24 counted characters (`Write.` 6 + `question` 8 + `answered` 8 + the
  run's 2-character prompt) so the entry-time number is 6 and the live accessor agrees;
  after one `setIncluded(messageId, false)` the entry-time number is STILL 6 while
  `currentEstimatedTokens()` answers 4 (16 characters) and `currentMessages()` is 3 entries
  against `messages`' 4. The same test then re-reads the context AFTER the round closed: the
  run has committed an answer (canonical is 5 entries, a naive re-projection would measure
  four), and the live accessor still answers 3 entries / 4 tokens — frozen to the request
  that actually went out, exactly like `currentMessages()`. And it pins that the provider
  received the live view, with neither the flag nor an address in it.


### T6 — Host normalization and hygiene for `included: true`

- **T6.1** Decide (F8): reject `included: true` at the edges that accept whole messages
  (`src/harness.ts:4778-4789`, `appendThreadMessages` `:4836-4843`, seed at `src/core/agent.ts:431-464`) — currently
  they **normalize silently**, which is the friendlier behaviour — or keep normalizing and
  state the rule where a host will read it. Recommendation: keep normalizing (rejecting
  would break a host that round-trips its own JSON), and document.
- **T6.2** The remaining hole is the direct-edit path the contract already disclaims
  (`src/types/index.ts:2418-2420`). If read-side normalization is wanted, the cheapest
  honest place is `threadMessages()` (`src/harness.ts:4739-4740`), which is already a copy;
  note it would then differ from `entries`, which must keep showing the canonical object
  (`:7493-7495`).
- **T6.3** Host hygiene, written down once: the flag's storage form is "only `false`", so a
  host that persists its own transcript copy should omit the key rather than write `true`
  (`src/types/index.ts:127-128`).

*Check:* one test per accepted entry point asserting a submitted `included: true` never
appears in canonical state or in `threadMessages()` output afterwards, and the README/API
note that states the rule.

**LANDED 2026-11-09 — normalization kept, read-side normalization declined, and the rule
written where a host actually reads it.**

- **T6.1 decision.** Every entry point that accepts WHOLE messages keeps silently
  normalizing a submitted `included: true` to the absent form: the agent seed and reset
  (`src/core/agent.ts` `withIncluded`), the transcript replace (`writeThreadTranscript`,
  behind `setThreadMessages` and `replaceHistory()`), the lane append
  (`appendThreadMessages`), `restore()`, and the fork/branch copy (`core/branch.ts`
  `copyIncluded`). Rejecting was the worse choice: a host that reads its transcript out of
  the server, changes one turn and PUTs the whole document back would fail on a key it never
  wrote.
- **T6.2 decision, recorded: NO read-side normalization.** `threadMessages()` — and with it
  `api.threads.messages` and the server's transcript GET — keeps showing canonical state
  verbatim, including a `true` that a tool or host code wrote straight into the public
  mutable `agent.messages`. Stripping it there would have made the read surface disagree
  with `context.entries`, which must keep handing out the canonical object
  (`createEntries` in `src/harness.ts`), and the divergence is now a documented property
  rather than an unwritten accident: such a value is invisible to the model, invisible to
  `snapshot()` and therefore gone after a restart, and visible only to a reader of live
  state.
- **T6.3, and where a host reads it.** The rule is written in the places a host looks: the
  `HarnessMessage` union block in `src/types/index.ts` (host hygiene — omit the key rather
  than write `true`, and the one path nothing can normalize), the `setIncluded` comment that
  repeats the storage form, and a new transcript-routes paragraph in `README.md` ("Two keys
  the reader owns on the way in") that covers this flag and the `messageId` together.
- **Check evidence.** `src/harness.inclusion.test.ts` gained one test per accepted entry
  point, each asserting BOTH halves: canonical state carries no `included` key, and the host
  read surface never shows `"included":true` — the seed, the transcript replace, and the lane
  append (which additionally pins that a submitted id is honoured while an id-less entry is
  minted one the transcript is not already using). The direct-edit path is pinned as the
  recorded decision rather than as a defect, in the test ``leaves a hand-written `true` on a
  direct canonical edit visible to the read surface``, together with the two surfaces that DO
  stay clean. `restore()`'s half was already pinned by ``normalizes a hand-written
  `included: true` back to the omitted form`` in `src/harness.snapshot.test.ts`, and the
  fork's half by `carries the context-inclusion flag through the fork clone and a branch
  reset` in `src/core/agent.fork.test.ts`; both still pass, untouched.


### T7 — UI and observability

- **T7.1** An "excluded from context" marker plus a count on the conversation board
  (F10). The board is event-based and the events carry no flag (`src/types/index.ts:2234-2262`),
  so this needs either a transcript read beside the event stream (the transcript dialog
  already has the document, `src/frontend/ui/thread-transcript.ts:31-32`, `:425`) or one new
  additive event field. Prefer the read: it is the authority, and an event would have to be
  replayed to reconstruct state.
- **T7.2** Transcript metadata: the excluded count and estimated tokens saved, surfaced
  where the context bar already lives — the bar's number is the same estimate the plugin
  compares against (`src/core/context-estimate.ts:14-19`), so the two must agree.
- **T7.3** A one-line diagnostic per prune pass (owned by
  [2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) T4.5); this
  task's part is only making it visible.

*Check:* a frontend test in the existing transcript/board suites asserting the marker
renders from a transcript containing one `included: false` unit and that the count matches;
`npm run test:frontend` (`package.json:97`) green.

### T8 — Branch discriminator on `HarnessTurnBeforeContext`

Add `actorKey` and/or `branchId` (F11). The data exists (`src/core/branch.ts:115-139`,
`src/harness.ts:7681-7689`) and the state-change event already carries `branchId`
(`src/types/index.ts:2434-2443`), so this is exposure, not invention. Keep `threadId`
meaning what it means today (the spawning conversation) — that is pinned by the shipped
comment and by the compaction cooldown behaviour
(`src/plugins/context-compaction.plugin.ts:53-66`).

*Check:* one test that a fork round and a root round of the same conversation report
different discriminators and the same `threadId`, and that a branch write still reports no
notification (`src/harness.ts:7631-7640`).

**LANDED 2026-11-09 — with pipeline T3.4, as one change (this file's own instruction: T3 is
"owned jointly … one owner, one landing, no duplicated protocol work", and the discriminator
is the same kind of single-owner item).**

- **What carries it.** `HarnessTurnBeforeContext.actorKey` (every round) and
  `HarnessTurnBeforeContext.branchId` (only when `run.branch` exists). Both are the run's
  existing facts, not new ones: `RunState.actorKey` and `AgentBranchMetadata.branchId` are
  what the scheduler, the mailbox and the state-change plane already use, which is the
  "exposure, not invention" requirement this task stated.
- **What did NOT change.** `threadId` still names the SPAWNING conversation for a branch
  (the shipped comment in `src/harness.ts` `emitTurnBefore` says so, and the new test
  asserts the equality rather than trusting it), so the shipped compaction plugin's
  cooldown behaviour is bit-for-bit what it was. A `branchId` that does not apply is spread
  in as an ABSENT key, not as `branchId: undefined`.
- **Check evidence.** `names a fork round differently from a root round while threadId
  stays equal, and a branch edit reports no notification` in
  `src/harness.inclusion.test.ts`: one test, one scenario, both facts — the two rounds'
  `threadId` is identical, their `actorKey` is not, the fork's `branchId` equals the branch
  record's, the root payload has no `branchId` key at all, the branch's own request carried
  the edit, and the state-change stream of a run WITH the plugin is byte-equal to the same
  run WITHOUT it (`withoutBranchIds`, because branch ids are process-global). Focused
  baseline before the work: **106 passed** across
  `src/harness.inclusion.test.ts`/`src/harness.snapshot.test.ts`/`src/core/branch.test.ts`/
  `src/harness.fork.test.ts`; after: **114 passed**.
- **The part this task does NOT close.** F11's last bullet — the compaction guard keying
  its cooldown map on `context.threadId` and therefore storing one entry per
  `branch:<id>` — is a behaviour change to a shipped plugin (its cooldown semantics and its
  settings-visible pause behaviour move), so it belongs to
  [2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md), which is
  the stage that will decide whether a branch round should compact at all. The fields it
  needs are now there.

### T9 — Documentation and release notes

- **T9.1** `currentMessages()` vs `messages` (F5), lazy `entries` (F7), and the entry-time
  estimate — all currently documented only inside `src/types/index.ts:3451-3475` and
  `src/harness.ts:7356-7382`. They belong in the author guide
  ([2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md)
  T5.1/T5.2 — one owner).
- **T9.2** Persistence caveats in one place: what a flag survives (later turns,
  snapshot/restore, fork, incorporation) and what it does not yet survive (a restart under
  `threadExecution: 'worker'`, F3; a branch's own conversation, `:3500-3502`).
- **T9.3** `README.md` / `knowledge.md`: the flag is a user-visible behaviour change once a
  compactor uses it; [`knowledge.md:3739`](../../knowledge.md#not-built-yet)-`:3744` ("Not built yet") is where the roadmap
  honesty lives. **Partly served already, 2026-11-09:** T6 added the README paragraph a host
  reads (transcript-routes section: the `included` storage form, the normalization rule, the
  host-hygiene sentence) and T1 documented `messageId` there and in the published contract,
  so what is LEFT here is the author-guide/`knowledge.md` pass — the flag's user-visible
  behaviour and the "Not built yet" line about worker-lane durability.
- **T9.4** The stale cross-references in the plugin area (`src/server/harnesses/types.ts:51-52`
  — both `./sessions.ts` and `./plugins.ts` — plus the three stale type ranges at
  `src/server/plugins.ts:21`, `:40`, `:69`) are listed in the pipeline entry T4.5 — do not
  fix them twice.

*Check:* `grep -n "currentMessages" README.md knowledge.md docs/` finds prose, not only type
comments; and the flag's contract sentence about worker durability matches T3's actual
state at the time of reading.

**CLOSED 2026-11-09 — the documentation pass landed the text, and the check is met.**

- **T9.1 + T9.2** — `docs/plugins.md` (pipeline T5.1/T5.2, one owner) now carries the
  author-level prose the type comments alone used to hold: the `messages` /
  `currentMessages()` and `estimatedTokens` / `currentEstimatedTokens()` freshness table
  with the stated reason for entry-time values, the lazy per-handler `entries` and its
  round-close freeze, the three `setIncluded` targets with the `replaceHistory()`
  staleness rule and the `messageId` copy-across-fork policy, and one persistence section
  that states what a flag or an edit survives (later turns, `snapshot()`/`restore()`, a
  store's save, a fork or branch copy — and, since T3 landed, a restart under
  `threadExecution: 'worker'`) and what stays ephemeral (a branch run's copy, silently).
  `grep -n currentMessages README.md knowledge.md docs/` now answers from prose, not type
  comments — in `docs/plugins.md` (the guide is the audience text; `README.md` keeps the
  host-facing paragraph T6/T1 landed, and `knowledge.md` keeps the internal map).
- **T9.3** — the same pass added the plugin `stop` decision to the closed "what still ends
  a long run" list in `README.md` (the periodic-wake bullet) and `knowledge.md` (the
  Callable bullet), corrected the header's false "Dependencies: none" claim, and re-checked
  "Not built yet": pruning is built and the item says so, the summarize checkpoint is not,
  and the worker-lane durability statement no longer disclaims what T3 landed. The one
  code-side line this pass could NOT land (docs-only): the "What still bounds a run"
  comment in `src/core/agent-limits.ts` then omitted the `stop` member the two prose lists
  carried — a one-bullet comment change, flagged here rather than silently skipped, and
  LANDED 2026-11-09 by the final-verification pass (that comment now carries the bullet).
- **T9.4** — owned and landed by the pipeline entry's T4.5; nothing to do here, as this
  task said.

## Verify before starting — drift check

Mark a premise `corrected` in place rather than deleting it when it no longer holds (the
rule at `docs/tasks/README.md:28-30`, cited as `:24-26` until the index rows grew).

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'; git status --short   # Stage 1 may be committed by now
grep -n "included" src/types/index.ts | head -20
grep -n "const projectTranscript\|const transcriptUnits\|const setIncluded\|const resolveUnit" src/harness.ts
grep -rn "messageId\|messageUid" src/types/index.ts        # T1 already done?
                                                                  # HIT 2026-11-09: all four
                                                                  # variants carry `messageId`, and
                                                                  # so does `HarnessContextEntry`
grep -n "transcript:append\|transcript:replace\|transcript:patch" src/server/workers/lane-commit.ts
grep -n "committedLength" src/server/workers/lane-worker-loop.ts | head -3
grep -rn "included" src/frontend/ui/ src/frontend/*.ts | grep -v test | grep -v "entries included"
grep -n "does not reach the authority" src/types/index.ts  # F3's contract sentence still true?
npx vitest run src/harness.inclusion.test.ts               # 35 tests; BASELINE green
```

Stop-and-recheck conditions:

1. **Stage 1 is committed** — every `path:line` above is still valid but the "uncommitted"
   framing in the header is `corrected`; re-derive the line numbers once, on the commit.
2. **A `messageId` field exists** — F1 and T1 are resolved; keep T1.3-T1.5 if the
   snapshot/branch policy was not decided.
   **HIT 2026-11-09:** T1 landed WITH its policies (backfill-on-read; ids copied across a
   fork, never re-minted), so nothing of T1.2-T1.5 is left, and F1 carries the `corrected`
   note. What the check does NOT settle is whether the id reaches a UI — that is T7.
3. **A transcript replace/patch mutation exists in the worker protocol** — T3 done; then
   F3's last row and `src/types/index.ts:3493-3502` must both have been updated, or the
   docs are the remaining work.
4. **`turn.before` gained `actorKey`/`branchId`** — T8 done, F11 `corrected`.
   **HIT 2026-11-09:** that is now the state of the tree. Re-running this check reports T8
   as landed (see the landing note under T8); only the cooldown-key change is still open,
   and it belongs to the compaction entry.
5. **The frontend renders the flag** — T7.1 done; verify the count comes from the transcript
   read, not from a reconstructed event stream.

## Not tested

- **Docs-only entry: no test run was performed for this file.** The "35 `it()` blocks"
  figure is a static count of `it(` in `src/harness.inclusion.test.ts`; the
  "2 953 passed / 2 skipped, typecheck green" figure is inherited from the session that
  produced the tree and was **not** re-verified here.
- **Cross-turn and cross-restart id references** (T1) — unexercised when this file was
  written; **exercised since 2026-11-09** by the two-round, restore-and-restart and fork tests
  named in T1's landing note (original claim kept above because it is why the task existed).
  Still unexercised: an id carried through a worker-lane commit and restart (that is T3's
  surface), and an id used by a client of the HTTP transcript routes (T7).
- **Per-call exclusion** (T2) — never exercised; the unit rule has never been broken in a
  test, which is the point of R2.
- **Worker-lane behaviour of a plugin write** (T3/F3) — read from the derivation code and
  the contract sentence; no lane was observed, and no lane test currently drives
  `turn.before` at all.
- **Whether one notification per write is actually slow** — the save model is a
  whole-document rewrite (`src/server/persistence.ts:33-44`), but no profile was taken, so
  T4's benefit is reasoned, not measured.
- **UI behaviour with an excluded turn** — no frontend surface consumes the flag (F10), so
  nothing was observed; the transcript dialog shows it only as raw JSON
  (`src/frontend/ui/thread-transcript.ts:425`).
- **A host writing `included: true` in place** (F8) — was read, not run; **now probed**, and
  the claim below holds exactly as written: the value is invisible to the model and to
  snapshots and stays visible to `threadMessages()` until the next copy (T6's last test pins
  both halves). What remains unprobed is whether any real host does it. The original claim:
  claim "visible in `threadMessages()`, invisible in a snapshot" follows from
  `src/harness.ts:4739-4740` vs `:8974` and has not been probed.
- **Branch rounds in a real fork/autoanswer under a plugin** — the Stage 1b branch tests
  exist (`src/harness.inclusion.test.ts:1652`, `src/harness.fork.test.ts:435-522`), but
  no test asks what a *policy* should do on a branch, which is what T8 exists to enable.

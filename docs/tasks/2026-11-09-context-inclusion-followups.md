# Context inclusion (Stage 1) — what shipped, and the eleven edges left open

Status: **open — Stage 1 (1a + 1b) is implemented on the current working tree and its
follow-ups are not.** This file is not a defect report: every item below is either a
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

## Findings

### F1. There are no stable message ids — entries are addressed by index or by live object identity

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
its own key today.

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

| Fact | Where |
|---|---|
| The lane's owed operations are deltas only: "Nothing here is a whole-state diff" | `src/server/workers/lane-worker-loop.ts:632-634` |
| The transcript op fires **only when the replica is longer** — an in-place flag change does not change length | `:638-648` (`if (transcript.length > lane.committedLength)`), `committedLength` semantics `:134-139` |
| The mutation union has no replace/patch form for a transcript (records have one: `patch + expects`) | `src/server/workers/lane-commit.ts:183-208` (`transcript:append` `:189`, `record:update` `:185`) |
| The authority applies an append and answers a pull for the missing tail | `src/server/workers/lane-authority.ts:773-775`, `:129` + `:705` (`transcript:sync`), `prefix-moved` `:845` |
| Turn start **pulls** the canonical delta; nothing pushes a rewrite | `src/server/workers/lane-worker-loop.ts:1092-1096`, `syncTranscript` `:817-855` |
| The public contract already says so | `src/types/index.ts:3493-3502` — "do not treat the flag as restart-durable under `threadExecution: 'worker'` until that lands" |

Inline mode is complete: the write is canonical and reported (`src/harness.ts:7638-7640`)
and the server's `state.json` captures it at the next boundary
(`src/server/persistence.ts:33-44`). Worker mode is correct-until-restart.

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
`messages` after their own `setIncluded` call sees a stale list.

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

| Fact | Where |
|---|---|
| `turn.before`'s identity block is `{ threadId, agent, iteration }` — the thread of a branch round is the **spawning** conversation | `src/types/index.ts:3446-3450`; the shared block `:3397-3408` (`threadId` absent only for a branch — but `turn.before` falls back to `run.actorKey`) |
| The implementation comment states the trap: a branch and its root report the **same** `threadId`; `run.actorKey` (`branch:<id>`) is only a fallback, and "a plugin therefore cannot tell a branch round from a root round by `threadId`" | `src/harness.ts:7681-7689` |
| The compaction guard's cooldown map is polluted by branch actor keys because of exactly this | `src/plugins/context-compaction.plugin.ts:53-66` |
| Branch semantics genuinely differ: the flag applies to an ephemeral copy, no notification is reported, `replaceHistory`/`pause`/`resume` are refused or no-ops | `src/types/index.ts:3500-3502`; `src/harness.ts:7631-7640`, `:7735-7750`, `:7751-7759` |
| Elsewhere the branch id IS modelled, so the information exists to expose | `src/core/branch.ts:115-139` (`agentBranchOf`, `createBranchId`), `src/types/index.ts:2434-2443` (`HarnessStateChangeEvent.branchId`) |

A policy that behaves differently for a fork (usually: don't prune a transcript that is
about to be incorporated into its owner) cannot currently express that difference.

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

*Check:* a test asserting the exact `state_change` count for a 3-unit prune (one, not
three) and for a host `setThreadMessages` (unchanged), plus the existing snapshot tests
still passing untouched; and
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) T4.4 closed
by the same change.

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
  honesty lives.
- **T9.4** The stale cross-references in the plugin area (`src/server/harnesses/types.ts:51-52`
  — both `./sessions.ts` and `./plugins.ts` — plus the three stale type ranges at
  `src/server/plugins.ts:21`, `:40`, `:69`) are listed in the pipeline entry T4.5 — do not
  fix them twice.

*Check:* `grep -n "currentMessages" README.md knowledge.md docs/` finds prose, not only type
comments; and the flag's contract sentence about worker durability matches T3's actual
state at the time of reading.

## Verify before starting — drift check

Mark a premise `corrected` in place rather than deleting it when it no longer holds (the
rule at `docs/tasks/README.md:24-26`).

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'; git status --short   # Stage 1 may be committed by now
grep -n "included" src/types/index.ts | head -20
grep -n "const projectTranscript\|const transcriptUnits\|const setIncluded\|const resolveUnit" src/harness.ts
grep -rn "messageId\|messageUid" src/types/index.ts        # T1 already done?
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
3. **A transcript replace/patch mutation exists in the worker protocol** — T3 done; then
   F3's last row and `src/types/index.ts:3493-3502` must both have been updated, or the
   docs are the remaining work.
4. **`turn.before` gained `actorKey`/`branchId`** — T8 done, F11 `corrected`.
5. **The frontend renders the flag** — T7.1 done; verify the count comes from the transcript
   read, not from a reconstructed event stream.

## Not tested

- **Docs-only entry: no test run was performed for this file.** The "35 `it()` blocks"
  figure is a static count of `it(` in `src/harness.inclusion.test.ts`; the
  "2 953 passed / 2 skipped, typecheck green" figure is inherited from the session that
  produced the tree and was **not** re-verified here.
- **Cross-turn and cross-restart id references** (T1) — nothing today carries an id, so the
  whole question is unexercised, including what a fork should do (`src/core/branch.ts:647-656`).
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
- **A host writing `included: true` in place** (F8) — the code paths are read, not run; the
  claim "visible in `threadMessages()`, invisible in a snapshot" follows from
  `src/harness.ts:4739-4740` vs `:8974` and has not been probed.
- **Branch rounds in a real fork/autoanswer under a plugin** — the Stage 1b branch tests
  exist (`src/harness.inclusion.test.ts:1652`, `src/harness.fork.test.ts:435-522`), but
  no test asks what a *policy* should do on a branch, which is what T8 exists to enable.

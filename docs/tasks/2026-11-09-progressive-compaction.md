# Progressive compaction — prune what a later success already answered

Status: **open — stage not started; T0 (the policy decision) blocks the implementation,
and T1/T2 are the two source changes that policy depends on.** Written as a companion to
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md):
that entry is about what a plugin **may do**, this one is about the first policy that
should do it. Verified against revision `44cdbbe` ("Upgraded Task Logic") of the
**`@underload/harness` package repository** (its own git repo at
`packages/underload/harness/.git`), working tree **dirty with the uncommitted Stage 1
context-inclusion work** (`git diff --stat -- src` → 2 206 insertions / 108 deletions,
15 files). Every `path:line` was read out of that tree; names are the durable anchors and
the *drift check* at the end lists the commands to re-verify the numbers.

External claims are cited and labelled **vendor** (a first-party product document) or
**preprint** (an unreviewed paper) in *Why this policy*. Anything this document asserts
about **this** harness is `path:line`-backed; anything it asserts about model behaviour is
a citation, not a measurement, and lands in *Not tested*.

Companion entries:
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md)
(the exclusion primitive's own edges — unit-level only, worker-lane durability), and the
budget/overflow gaps tracked once in
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md)
— linked, never duplicated here.

## Date / Method / Scope

**Date:** 2026-11-09.

**Method:** three passes. (1) A static audit of the compaction seam: the shipped plugin,
the outcome classification, the estimator, the result budget, and the id/argument rules.
(2) A literature/vendor pass for the policy questions the code cannot answer (what is safe
to drop, what a model does with a dropped failure, what compaction costs a prompt cache);
those sources are listed under *References*, whose **citation note** there states how they
were retrieved and why no claim here may be cited to a scratch path. (3) No live session
and no test run — this is a documentation-only change, so **no test run is required**; the
consequences are listed in *Not tested* rather than smoothed over.

**Scope:** the **pruning** half of compaction — deciding which already-committed transcript
units stop being sent to the model, and the small source changes that make that decision
sound (a persisted tool outcome, a canonical argument fingerprint).

**Out of scope (explicitly, so nobody "fixes" it here):** the full
summarize-and-reinitialize checkpoint (F7 → T6); pre-request token guarding and provider
overflow classification (issue 0004); the token-budget policy
(`src/core/result-budget.ts` stays as shipped unless T5 decides otherwise); and the
plugin framework's decision/wildcard/priority work
([2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md)).

## Requirement

- **R1 — compaction must actually do something.** `executeCompaction()` is today a
  documented no-op (F1); the stage replaces it with a policy, not with more machinery.
- **R2 — pruning is the first policy, summarization is not.** The narrow, reversible,
  cheap win is: stop sending a tool unit that has already been **answered by a later
  successful call of the same work**. A full structured-summary checkpoint is T6, later.
- **R3 — context control never deletes.** A pruned unit stays in canonical history and can
  be re-enabled; the mechanism is the Stage 1 `included` flag
  (`src/types/index.ts:117-134`, `:3410-3441`, `:3476-3513`).
- **R4 — a decision must be justified by structure, not by prose.** "This looks like a
  failure" is not a signal: the classification must be the structured outcome (F2), and
  "the same call" must be a canonical fingerprint, not a string compare of raw JSON (F3).
- **R5 — a healthy control outcome is not garbage.** `cancelled` is an expected outcome,
  not a failure (`src/types/index.ts:234-251`), and the most recent unresolved failure is
  the highest-signal thing in the window (F5). Recency therefore bounds what may be pruned.
- **R6 — the change must be safe and cheap in the same breath:** idempotent (a second pass
  changes nothing), pairing-preserving (R3 + the provider contract,
  `src/types/index.ts:131-134`), bounded in blast radius (minimum savings, tail horizon,
  batching for the prompt cache), and observable (a diagnostic naming what it dropped and
  why it dropped it).

## Findings

### F1. `executeCompaction()` is a literal no-op, while the trigger, cooldown and pause machinery around it is complete

| What | Where | Value today |
|---|---|---|
| The action | `src/plugins/context-compaction.plugin.ts:165-185` | body is `void api; void context;` plus `// TODO: implement context compaction here.` (`:182`) |
| Its signature | `:157-163` | `HarnessCompactionAction = (api, context) => Promise<void>` — the whole control surface plus the parked turn |
| The trigger | `:189-255` (`createContextCompactionHandler`) | limit check, per-thread cooldown map, `REGROWTH_RATIO = 0.05` re-fire margin (`:123-126`), internal-agent skip (`:128-155`) |
| The lifecycle around the action | `:201-213` (`pass`) | `await context.pause()` → action → `finally { await context.resume() }` |
| The setting | `:101-112`, fallback `:121` (`CONTEXT_LIMIT_DEFAULT = 100000`) | operator-editable at runtime; the server persists the override (`src/server/plugins.ts:1-30`) |
| Sync fast path | `:36-44`, `:215-227` | the under-limit path deliberately returns synchronously so no microtask is added |

So a real compactor only has to fill in `:175-185` (or replace the built-in, which
`configuration.plugins` allows **in-process only** — see F5 of the pipeline entry), and it
inherits the trigger/cooldown/pause behaviour for free. Note what the cooldown means for
this stage: `:250-252` records the estimate **before** the action runs, so a policy that
prunes nothing still consumes a cooldown slot until the context has grown 5% of the limit
(`:239-248`).

### F2. A tool outcome is decided, reported on events, and then **not persisted on the transcript message**

| Fact | Where |
|---|---|
| The classification and its meaning ("a consumer must never decide 'cancelled' vs 'failed' … by matching strings") | `src/types/index.ts:234-251`, union at `:251` |
| One structured outcome, computed once per delivery | `src/harness.ts:5893-5949` (`cancelled` `:5908-5916`, `failed` `:5917-5925`, `completed` `:5926-5943`, serialize-failure → `failed` `:5944-5949`) |
| `isError` is **derived**, never stored separately | `src/harness.ts:5952-5955` (`outcome !== 'completed'`) |
| It reaches the event and the hook payload | `src/types/index.ts:2244-2258` (`tool_result` carries `isError` and optional `outcome`), `:3384-3391` (`tool.after` payload carries `outcome`), emitted `src/harness.ts:5975-5994`, `:6011-6019` |
| The **committed message** carries only `{ role, content, toolCallId, name, attachments? }` | `src/harness.ts:5646-5672`, splice at `:5660-5666`; the message union is the same shape (`src/types/index.ts:170-196`) |
| Failure text is English prose, produced at the delivery site | `:5913-5915` (cancelled), `:5922-5924` (`Tool "…" failed: <message>`), `:5945-5947`; invocation refusals go through `fail`/`immediateResult` with `outcome: 'rejected'` (`:6148-6149`, `:6040-6063`, sites `:6165`, `:6177`, `:6195`, `:6221`, `:6263`, `:6322`, `:6334`) |
| The snapshot reader's per-role key allowlists do not name an outcome | `src/core/snapshot.ts:293-295` (assistant), `:328-330` (tool) — an unknown key is refused, so **a new field must be added here or a flagged transcript stops loading** (`:238-244`, `:265-267` are the other two roles) |

Consequence: after a restart (or in a snapshot, a fork, or a `threadRead`) **the outcome is
gone**, and the only remaining signal is the message text. Any compaction rule of the form
"drop units whose call failed" is therefore forced to string-match prose it did not write
and cannot localize — exactly what the type's own header forbids (`src/types/index.ts:234-236`).

### F3. There is no retry fingerprint: ids must be unique, arguments are raw text, and nothing canonicalizes them

| Fact | Where |
|---|---|
| A tool call is `{ id, name, arguments: string }` | `src/types/index.ts:108-112` |
| Ids must be non-empty, unique within a turn, and unique across the whole conversation | `src/harness.ts:5822-5857` (`assertToolCallIds`), enforced at `:8173`; the unit resolver depends on that uniqueness (`:5721-5725`, `:568-573`) |
| `arguments` is stored verbatim and only sanitized at the wire edge (non-object JSON → `'{}'`) | `src/transport/openai.ts:271-285` (`wireArguments`), used `:305-307`; the snapshot reader keeps raw text on purpose ("malformed arguments are a replayable fact", `src/core/snapshot.ts:76-79`, whitelist `:72`) |
| The estimator counts that raw text | `src/core/context-estimate.ts:20-27`, implementation `:108+` |
| No canonicalization/dedupe helper exists anywhere in `src/` | grep for a sorted-key JSON helper returns nothing outside the two sites above |

So "the model re-ran the same call" is today unexpressible: a retry has a **different id**
and may have a **different byte order** in the same JSON (`{"a":1,"b":2}` vs
`{"b":2,"a":1}`). A resolved-failure rule needs a fingerprint that survives both.

### F4. Stage 1 shipped the exclusion primitive; it is unit-level and it is the right tool

| Capability | Where | Notes |
|---|---|---|
| `context.setIncluded(entry \| number, boolean)` — unit-wide, validated, canonical, notifying, re-projected into the same request | `src/types/index.ts:3476-3513`; implementation `src/harness.ts:7593-7641` (resolve → validate → write, `:7516-7528`, `:7534-7591`) | this is the write a compactor needs, and it is already reversible |
| The unit is the whole tool-call block, so pairing can never break | `src/types/index.ts:131-134`, `src/harness.ts:564-580` (`transcriptUnits`), `:5702-5814` (`projectTranscript`) | "a request never ends up with a half-answered `tool_calls[]` or an orphan result" (`:3480-3481`) |
| A disabled unit also suppresses its **request-only pending placeholders** | `src/harness.ts:5713-5748`, `:5794-5810`; pinned by `src/harness.inclusion.test.ts:691` ("emits no pending placeholder for a disabled unit whose call is still running") | a retry in flight does not resurrect a disabled block |
| The canonical list a plugin scans is `context.entries` (lazy, per-handler, live `included`) | `src/types/index.ts:3418-3441`, `src/harness.ts:7485-7508`, `:7708-7712` | built from `brain.messages`, so **an in-flight call is not in it** — see the horizon caveat in T4 |
| There is **no per-call partial exclusion** | `HarnessToolCall` has no flag (`src/types/index.ts:108-112`); the transport maps every call (`src/transport/openai.ts:305-308`) | one failed + one successful call in the **same** assistant block are withheld together, never separately |

### F5. The evidence for the policy (external, cited) — and the shape it points at

Short version of *Why this policy* (full citations there):

- **Pruning resolved failures is the documented cheap win.** The TIR-pruning preprint
  prunes *erroneous* tool interactions precisely to stop agents "getting stuck in repeated
  failed resolution attempts" (PruneTIR, arXiv:2605.09931, **preprint**); Anthropic frames
  the same discipline as keeping "the smallest set of high-signal tokens" and calls
  tool-result clearing the cheaper, lossless option when the output is **re-fetchable**
  (effective context engineering; context management, **vendor**).
- **Unresolved and recent failures are high-signal, and deleting them causes retries.** The
  "Feedback That Backfires" preprint (arXiv:2608.23651, **preprint**) reports agents
  repeating a call they just watched fail — i.e. the visible failure text is what prevents
  the repeat. So the rule is *prune answered failures*, never *prune failures*.
- **Verbatim traces are copying magnets, and masking beats summarizing.** The Complexity
  Trap (arXiv:2508.21433, **preprint**, NeurIPS 2025 DL4C) finds simple observation masking
  as efficient as LLM summarization for agent context, at lower cost and risk; opencode's
  own docs concede compaction is lossy and let an operator raise the retained tail when
  exact detail matters (`keep.tokens`, **vendor**).
- **Summaries lose what the task did not ask for.** "Lost in Context Compaction"
  (arXiv:2608.11242, **preprint**) measures ~17% retention of user side constraints across
  compactors — the argument for keeping a constraint **outside** the summarized region
  (T6) rather than trusting a summary to carry it.
- **Repeated compaction compounds.** The Claude Code CHANGELOG (vendor, observed
  2026-11-08 at `2.1.319`; *References*) carries a run of compaction-repair entries that
  read as a bug history for this exact design: an idle pass "replacing a conversation with
  a reply that was not a summary"; a "Prompt is too long" recovery "keeping too much of a
  conversation with dense text … so the next request could fail again"; "very long
  conversations losing their earlier summary when compaction had to shorten its own
  request"; `"Autocompact is thrashing"` errors "in turns that read many PDF pages, images
  or other large tool results"; and an idle pass that is deliberately scheduled *before*
  the one-hour prompt cache expires, whose summary is only used on the next message *once*
  that cache has expired — i.e. the vendor ties compaction timing to cache lifetime
  explicitly, which is what T4.5 must copy rather than invent.
- **`cancelled` is a healthy outcome, not garbage.** This is not external evidence — it is
  this package's own contract: "`completed` and `cancelled` are both healthy control
  outcomes" (`src/types/index.ts:247-250`).
- **Mid-history rewrites cost the cache.** Manus states the KV-cache hit rate as the single
  most important metric for a production agent, and the discipline of never editing
  earlier turns that follows from it (vendor blog, *References*); DeepSeek Harness
  (`dsh`) implements compaction as **log-only bookkeeping plus one head-anchored surface
  replacement**, and its basic provider runs the optional tool-result pruner **before**
  range selection so a pass can "advance the surface without a summary" (vendor,
  `docs/subsystems/compaction.md`); opencode sends the whole conversation so the summary
  request itself reuses the prompt cache, and later passes update the existing summary
  (vendor, `services/site/src/docs/content/compaction.mdx`). Both upstream paths are
  cited with revision-pinned URLs under *References*, because a doc `HEAD` moves.

The rule this evidence supports, and the one T3 implements:

> **Prune a tool unit when it is (a) old enough to be out of the working tail, (b) answered
> with `failed` or `rejected`, (c) demonstrably superseded by a later unit that performed
> the same work and completed, and (d) large enough that dropping it is worth the risk.
> Never prune `cancelled`, never prune an unanswered failure, never prune inside the tail.**

**Why "invalid = failed" alone is the wrong filter.** "Failed" is a mixture of four things:
a call whose retry later succeeded (worth dropping), a call the agent gave up on
(load-bearing), an expected control outcome (`cancelled`, healthy but error-shaped on the
wire — `isError` is `outcome !== 'completed'`, `src/harness.ts:5952-5955`), and a
schema/argument refusal the model may need verbatim to fix its next call (`rejected`,
`src/types/index.ts:241-245`). A filter on "not completed" therefore deletes both the
useful and the re-fetchable, keeps the healthy, and drops the constraint-like information
the paper evidence says models lose first.

### F6. The adjacent budget gaps that dominate cost and quality more than the summary does

Tracked once in
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md)
— read that entry before implementing; only the harness-internal facts are here.

| Gap | Where | Detail |
|---|---|---|
| The estimate is a character heuristic | `src/core/context-estimate.ts:1-41`, `CHARS_PER_TOKEN = 4` at `:48`, `estimateContextTokens` at `:108` | it counts tool names and raw `arguments` text (`:20-27`), instruction blocks, and an attachment's **name + MIME only** (`:28-31`); it **never counts `reasoning`** (`:33`); nothing anchors it to provider-reported usage |
| The only limit in the product is one plugin's setting | `src/plugins/context-compaction.plugin.ts:101-112`; `src/harness.ts:7718-7725` hands the estimate to the hook | issue 0004's "the only limit in the product lives in one plugin's settings" |
| Tool-result budget is **per result, no aggregate guard** | `src/core/result-budget.ts:38-54`, `MODEL_TOOL_RESULT_BUDGET_BYTES = 256 * 1024` at `:54` | the header states the cost itself: "the cap is PER RESULT and there is no aggregate guard, so N parallel tool calls can now commit up to N x 256 KiB in one turn" (`:50-53`); applied at `:108` (`boundToolResult`), used by `src/harness.ts:6047` and `:5913`/`:5922`/`:5940` |
| No pre-request guard, no overflow classification | issue 0004 (gap list), `src/transport/openai.ts` | an oversized request is sent and comes back as a generic transport error, re-sent through the whole retry ladder |
| Nothing bounds the **transcript as a whole** | `src/harness.ts:7848` (`projectTranscript` for the turn) and `:7874` (`transcript: requestTranscript` into `brain.turn`) | pruning reduces it; no independent cap exists |

### F7. A full summarize-and-reinitialize checkpoint is **not** part of this stage

The shipped plugin's pause/trigger skeleton plus `replaceHistory()`
(`src/harness.ts:7735-7750`; contract `src/types/index.ts:3527-3531`) is all the checkpoint
needs from the framework, and the plugin header already warns about its one trap: a
`replaceHistory()` call must re-state the newest turn, because it replaces the **whole**
committed transcript (`src/plugins/context-compaction.plugin.ts:172-174`). Roadmap
placement: [`knowledge.md:3739`](../../knowledge.md#not-built-yet) "Not built yet", item 2 — "compaction — history pruning
before context limits" ([`knowledge.md:3744`](../../knowledge.md#not-built-yet)). This stage is the "history pruning" half;
T6 below records the checkpoint so the next reader does not re-derive it.

## Tasks

Order: **T0 is a blocking decision**, T1 and T2 are small, independently testable source
prerequisites, T3 is the policy, T4 is the safety envelope, T5 is the separable adjacent
work, T6 is the deferred checkpoint, T7 is the test plan.

### T0 — Decide the policy (blocking)

Five questions; the recommendation is recorded so an implementer can start from an answer
rather than from a blank page, and each answer must be written back here with a date.

- **Q1 — exclude vs annotate/abstract.** **Recommend: exclude, and design the abstraction
  seam now.** Exclusion is already the primitive with a contract, tests and persistence
  (F4), it is reversible (R3), and masking is the option the Complexity Trap preprint
  measures as equal-to-better than summarizing at lower risk. Annotating (replacing a
  result with a one-line "pruned: N tokens, re-fetchable by `read(path)`") needs a new
  persisted field and a mutation API
  ([pipeline entry T3.1](./2026-11-09-plugin-pipeline-v2.md)), so keep it behind a
  `mode` setting (`exclude` \| `annotate`) that starts at `exclude`.
- **Q2 — every turn vs threshold.** **Recommend: every turn, with a minimum-savings floor
  (T4.1).** A threshold-only policy repeats the shipped cooldown's flaw — it records the
  estimate before the action (`src/plugins/context-compaction.plugin.ts:250-252`), so a
  policy that fires late has already paid for the oversized request.
- **Q3 — safety horizon.** **Recommend: never touch the last K units, K derived from
  settings (`safetyTurns`), and never touch a unit with no committed result.** A plugin
  cannot see in-flight calls through `entries` (F4, last row), so "no result message" and
  "in flight" are indistinguishable from `entries` alone; the tail bound is what keeps that
  ambiguity harmless.
- **Q4 — per-call partial vs unit-level.** **Recommend: unit-level for this stage** (F4:
  the unit already guarantees pairing), with the per-call option recorded in
  [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md)
  T2. Cost of unit-level: a block mixing one failed and one successful call is withheld
  whole, which is conservative and may prune a live result.
- **Q5 — cache batching.** **Recommend: batch.** Change flags in one pass but report the
  persistence notification **once** (today one notification per write,
  `src/harness.ts:7638-7640`, each of which can trigger a whole-document save,
  `src/server/persistence.ts:33-44`), and prefer many small changes over alternating
  change/unchange turns, so the provider's prompt cache is invalidated on a batch boundary
  rather than every turn (Manus/dsh, *Why this policy*).

*Check:* this section has five dated answers; `context-compaction`'s setting descriptors
(`src/plugins/context-compaction.plugin.ts:101-112`) match them (a `mode`, a `minTokens`,
a `safetyTurns`, and either the existing `contextLimit` kept or explicitly superseded), and
the generated plugin manifest is regenerated (`npm run plugins:manifest`,
`package.json:102`) so `npm run plugins:manifest:check` passes.

### T1 — Persist the tool outcome on the message

- **T1.1** Add `outcome?: HarnessToolOutcome` to the `tool` variant
  (`src/types/index.ts:170-196`), **omitting `completed`** — the same minimal-delta rule
  `included` and `attachments` follow ("the key is OMITTED when there is no media, so every
  medialess tool result keeps its exact previous shape", `:186-190`). Absent then means
  `completed` for a pre-existing transcript, which is the only reading that keeps every
  existing fixture valid.
- **T1.2** Write it at the single insertion point (`insertToolMessage`,
  `src/harness.ts:5646-5672`, splice `:5660-5666`) by passing the outcome the delivery
  already computed (`:5893-5949`, `:6040-6063`) — do not re-derive it from text anywhere.
- **T1.3** Keep `isError` derived (`src/harness.ts:5952-5955`); optionally expose
  `isError`/`outcome` reads on the projection. Do **not** store both and let them drift
  (`src/types/index.ts:248-250` says they can never disagree).
- **T1.4** Update every allowlist that refuses unknown keys, or restore/fork will start
  rejecting real transcripts: snapshot per-role key lists (`src/core/snapshot.ts:238-244`,
  `:265-267`, `:293-295`, `:328-330` plus `applyIncluded`'s neighbours `:211-227`), branch
  materialization (`src/core/branch.ts:457-570`, `copyMessage`; the per-role lists at
  `:467`, `:483`, `:505`, `:564`), and the OpenAPI message schemas
  (`src/server/harness.swagger.yaml` — the four message variants; the `included:`
  properties are at `:7999`, `:8019`, `:8041`, `:8074`).
- **T1.5** Do **not** string-match the failure prose (`src/harness.ts:5913-5924`) as a
  migration bridge. Old transcripts simply carry no `outcome`, which reads as `completed`;
  a one-line "pre-outcome transcripts" note in the plugin header is the honest answer, and
  it is why the pruning rule must also require a **superseding** success (F5), so a
  mis-read old failure can never be pruned on its own.

*Check:* `npx vitest run src/harness.background.test.ts src/harness.action-request.test.ts
src/harness.snapshot.test.ts src/core/branch.test.ts src/transport/openai.test.ts
src/server/transcript.test.ts` with new cases: a failed and a cancelled result
carry their exact `outcome`; a **completed** result carries no key at all (assert
`JSON.stringify` of the message equals the pre-change shape); snapshot round-trip and fork
carry it; the provider payload is unchanged (`src/transport/openai.ts:316-321` sends
`role`/`tool_call_id`/`content` only).

### T2 — A canonical argument fingerprint

- **T2.1** One helper, exported from `src/core` beside the estimator: parse `arguments`,
  re-serialize with **sorted keys**, and on malformed/non-object JSON fall back to the
  trimmed raw string (mirroring `wireArguments`'s honesty about non-objects,
  `src/transport/openai.ts:271-285`, and the snapshot reader's "malformed arguments are a
  replayable fact", `src/core/snapshot.ts:76-79`).
- **T2.2** Match on `name` + fingerprint only. Ids are explicitly **not** comparable across
  retries (`assertToolCallIds` forbids reuse, `src/harness.ts:5822-5857`).
- **T2.3** Resolution rule: a **later `completed`** unit with the same name+fingerprint
  **resolves** an earlier `failed`/`rejected` one. It does **not** resolve a `cancelled`
  one (`src/types/index.ts:247-250`: cancelled is a control outcome, not a failure to be
  retried away), and a `completed` unit is never itself a prune candidate.
- **T2.4** Decide and document the two edge cases now, not in review: a call whose
  `arguments` were truncated by the result budget (the fingerprint is of the **call**, which
  budgeting never touches — it bounds the result, `src/core/result-budget.ts:16-19`), and
  a same-name call whose arguments differ only in a counter (`read` of a different page is
  a **different** job, so exact-match on the fingerprint is the safe choice, and a
  prefix/normalization heuristic is explicitly out).

*Check:* a unit test file for the helper with exact expected strings
(`{ "b": 1, "a": 2 }` → `{"a":2,"b":2}`-style canonical form, one assertion per input
shape: nested objects, arrays, non-object JSON, empty string, malformed text), plus the
resolution matrix as a table-driven test.

### T3 — The compaction policy itself

- **T3.1** Runs on **every** `turn.before` (Q2), in the shipped built-in's action
  (`src/plugins/context-compaction.plugin.ts:175-185`) or a handler beside the guard, and
  must stay synchronous unless it actually writes (the fast-path reasoning at `:36-44`).
- **T3.2** Scan `context.entries` (the canonical list, `src/harness.ts:7485-7508`) and
  group into units; skip a unit whose `included` is already `false` (idempotence) or that
  is in the tail horizon (Q3).
- **T3.3** For each candidate `failed`/`rejected` unit, ask T2's resolver whether a later
  unit of the same name+fingerprint completed. If yes, `context.setIncluded(entry, false)`.
- **T3.4** **Never asymmetric.** One unit, one flag — `setIncluded` already cascades across
  the assistant message, every result of the block, and its placeholders
  (`src/harness.ts:7516-7528`, `:7593-7640`; contract `src/types/index.ts:3476-3488`).
  Assert the projection stays pair-clean with the existing oracle
  (`src/harness.background.test.ts:365`, `wireIssues`).
- **T3.5** Keep the abstraction option open (Q1): compute the candidate list first, so an
  `annotate` mode is a second writer over the same list rather than a second policy.
- **T3.6** Never compact the compactor: reuse `isInternalAgent`
  (`src/plugins/context-compaction.plugin.ts:128-155`) so a summarizer thread's own
  conversation is not pruned into a loop.

*Check:* `npx vitest run src/harness.inclusion.test.ts src/plugin/context-compaction.test.ts`,
asserting the **exact** set of indices disabled for
a scripted transcript — e.g. a `[read(failed), read(completed same args)]` pair leaves
`[0]` disabled and `[1]` enabled, and a second pass disables nothing new.

### T4 — Guards, settings and observability

- **T4.1 — minimum savings.** Compute the byte/token delta with the package estimator
  (`src/core/context-estimate.ts:108`) and skip the pass when the gain is below `minTokens`
  — a prune that saves 40 tokens is a cache invalidation for nothing (Q5).
- **T4.2 — tail horizon.** `safetyTurns` units, counted **from the end of the transcript**,
  not from `context.iteration`: that field is a per-**run** counter
  ("1-based model-turn counter within this run", `src/types/index.ts:3449-3450`), so it
  restarts at 1 on every new run and cannot express "the last N turns of this conversation".
- **T4.3 — per-turn idempotence** (no repeated flag churn → no repeated notification → no
  repeated save) plus a bound on how many units one pass may disable, so a first pass on an
  old conversation cannot silently empty it.
- **T4.4 — notification coalescing.** One `agent_message` per pass instead of one per
  write; the write site is `src/harness.ts:7638-7640` and the reason it matters is the
  whole-document save model (`src/server/persistence.ts:33-44`, `:1557-1616`). Tracked as a
  follow-up with an owner in
  [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md)
  T4; whoever lands first edits the harness.
- **T4.5 — cache-aware batching** (Q5), and a diagnostic that names each pruned unit, its
  tokens, and the id of the unit that superseded it. Without it, an operator cannot tell
  "compacted well" from "compacted wrongly and the agent is now lost", which is the failure
  mode the changelog history in F5 is about.
- **T4.6 — settings**: `enabled`, `minTokens`, `safetyTurns`, `mode` (`exclude` \|
  `annotate`) declared in `metadata.settings` alongside the existing `contextLimit`
  (`src/plugins/context-compaction.plugin.ts:101-112`), each with a default the plugin also
  carries as a fallback constant (`:115-121` is the pattern, and it is why the metadata must
  stay a plain literal for the manifest scanner, `:89-91`).
- **T4.7 — visibility of failures.** A throwing compactor is currently **silent** (no
  production `onHandlerError`,
  [pipeline entry F2](./2026-11-09-plugin-pipeline-v2.md)); T3 must not land its diagnostics
  claim before that reporter exists.

*Check:* `npx vitest run src/plugin/context-compaction.test.ts src/plugin/async-ping.test.ts src/harness.inclusion.test.ts src/harness.snapshot.test.ts` plus one server test asserting the **number of `state_change`
notifications** a multi-unit pass emits (coalescing, T4.4), and one asserting the pass is a
no-op on a second identical turn.

### T5 — Adjacent context controls (separable, and higher value per unit of risk)

Each of these is independent of T3 and can land in any order; each is listed with the
reason it matters more than a better summary would.

- **T5.1 — write-time spill with a head/tail preview** at the point the result is bounded
  (`src/core/result-budget.ts:108`, called from `src/harness.ts:6047` / `:5913` / `:5922` /
  `:5940`): a large result becomes a small, honest envelope that names where the full text
  lives, instead of a mid-string cut. Why: the truncation exists already and its shape is a
  contract ("A truncated JSON-ish result is therefore still parseable JSON",
  `src/core/result-budget.ts:16-18`); making it re-findable is what lets T3 prune the rest
  safely (the "re-fetchable" condition in F5's rule).
- **T5.2 — an aggregate tool-result budget per turn** next to the per-result cap, since the
  header itself states there is no aggregate guard (`src/core/result-budget.ts:50-53`).
- **T5.3 — tool-result elision for superseded large results** — the annotate half of Q1,
  applied to *large* results, not only to failures. This is the trade opencode's
  `keep.tokens` knob exists to make — its default and its settings table are in
  `services/site/src/docs/content/compaction.mdx` at rev `caf8d6a` (*References*).
- **T5.4 — a hybrid token estimate**: anchor on the provider's reported `usage` for the
  prefix (`src/types/index.ts:254-267` `HarnessUsage`; per-request `usage` event) and
  extrapolate the delta with `chars/4`. Why: the current number is explicitly an estimate
  with a 4-chars/token contract (`src/core/context-estimate.ts:1-41`), and every pruning
  decision in T3/T4 is measured with it.
- **T5.5 — provider overflow recovery** (recognize "input too long", compact, retry) —
  issue 0004 owns this; do not restate it here.

*Check:* each sub-task has its own focused test command (`src/core/result-budget.test.ts`,
`src/core/context-estimate.test.ts`, and the transport tests for T5.4's usage anchor), and
T5.5's check is the one in
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md).

### T6 — The full checkpoint (explicitly **not** this stage)

Recorded so the design survives: a summarize-and-reinitialize pass would use
`replaceHistory()` (`src/harness.ts:7735-7750`, `src/types/index.ts:3527-3531`, refused on
a branch run `:7736-7740`) with

1. a **structured summary template** — Objective / Requirements / Decisions / Work State /
   Next Move / Relevant Files / Constraints — the "recall first, then precision" guidance in
   the Anthropic compaction docs (**vendor**), and the shape DeepSeek Harness's summary
   event carries (`docs/subsystems/compaction.md`, the `compaction/summary` event row, at
   rev `fcc0ad46`, *References*);
2. **the recent tail preserved verbatim**, sized by a setting — opencode's `keep.tokens`,
   default 15 000, in `compaction.mdx` at rev `caf8d6a` (*References*);
3. a **constraint registry kept out of the summarized region**, because 17% retention of
   side constraints is not acceptable for a policy-bearing session (arXiv:2608.11242);
4. **head-anchored, cache-aware replacement**: one replacement at a batch boundary, never a
   mid-history edit every turn (Manus, and the `shadowed`/`surfaceOp` design in
   `docs/subsystems/compaction.md` at rev `fcc0ad46`, *References*);
5. the newest turn **re-stated** in the replacement, because `replaceHistory` replaces
   everything including the prompt the run just appended
   (`src/plugins/context-compaction.plugin.ts:172-174`).

*Check:* this stays in this file (and in `knowledge.md:3744`'s "Not built yet" list) until a
stage opens for it; no T1-T5 task may quietly grow a summarizer call.

### T7 — Tests for the stage

A pruned-and-resolved pair; an unresolved failure retained; a `cancelled` unit retained; a
pending/in-flight unit untouched; the pairing oracle empty after every pass
(`wireIssues`); snapshot/restart preserving both the flag and the new `outcome`; idempotence
(second pass changes nothing and notifies nothing); several units in one transcript, and
several transcripts (two threads, plus a branch run, where the flag must apply to the
ephemeral copy only — `src/types/index.ts:3500-3502`, `src/harness.fork.test.ts:435-522`);
notification count for one multi-unit pass (T4.4); and a worker-mode case that the
durability claim in
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) F6/T4 is now true.

*Check:* `npm test` (`package.json:96`: both manifest checks + `vitest run`) green after the
last production edit, `npm run typecheck` (`:106`) green, `npm run test:frontend` (`:97`)
green if any server-facing schema or plugin metadata changed, and the reported counts come
from that run — a focused run is evidence for its own files only.

## Why this policy

The short argument, then the citations.

1. **Prune "resolved + old + large + re-fetchable", not "invalid".** Structure (`outcome`,
   fingerprint, position from the end, byte size) is knowable exactly; "invalid" is a
   reading of prose. F2 shows the outcome is currently thrown away at the transcript edge,
   so the first job is to stop throwing it away — that is the whole of T1.
2. **Keep the failures that still have no answer.** The retry-loop evidence (PruneTIR;
   Feedback That Backfires) says an agent that cannot see its own recent failure repeats
   it. R5 and Q3 encode that as a horizon.
3. **Prefer masking to summarizing until the summary is provably safe.** The Complexity
   Trap result (masking ≈ summarization, at lower cost and risk) plus 17% side-constraint
   retention (Lost in Context Compaction) plus the vendor bug history in F5 is an
   argument for doing the reversible thing first. Stage 1's `included` flag **is** that
   reversible thing, and unlike a summary it keeps the original recoverable — the same
   distinction the vendor docs draw between masking (a marker + a handle back) and
   summarizing (prose with no way back).
4. **Treat `cancelled` as healthy.** This is the package's own contract
   (`src/types/index.ts:247-250`), and a policy that prunes it deletes evidence the agent
   chose to stop.
5. **Compaction is a cost lever and a cache lever at once.** Compounding is documented in
   both directions: the savings are real (Anthropic's context-management numbers, **vendor**:
   an 84% token reduction on a 100-turn web-search evaluation, with runs that would
   otherwise exhaust the context) and so is the churn risk (Claude Code's repair history;
   dsh's pruner runs **before** range selection so a pass can avoid a summary call at all).

### References

Vendor (first-party product documentation) unless marked **preprint**.

**Citation note (what the research pass left behind):** the two competitor entries below
were read on 2026-11-08 from repository clones under the repo-root `Temp/` directory
(`Temp/research/sst-opencode` @ `caf8d6a`, `Temp/research/dsh` @ `fcc0ad46`, and a Claude
Code CHANGELOG capture @ `2.1.319`). That directory is disposable scratch space per
`AGENTS.md`, is git-ignored, and is **not part of this tree** — it may already be gone.
Therefore **no citation in this document is to a `Temp/` path**: the upstream repository
path and the revision-pinned upstream URL below are the canonical form, and the local
line numbers that were read from those clones are not quoted.

- Anthropic — *Effective context engineering for AI agents* —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic — *Managing context on the Claude Developer Platform* (context editing / tool
  clearing; the 100-turn evaluation) — <https://claude.com/blog/context-management>
- Anthropic — *Compaction* (platform docs; the summary-and-reinit primitive) —
  <https://platform.claude.com/docs/en/build-with-claude/compaction>
- Anthropic — *Effective harnesses for long-running agents* (why compaction alone was not
  enough; progress files beside summaries) —
  <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- Claude Code — *Explore the context window*, incl. "What survives compaction" —
  <https://code.claude.com/docs/en/context-window>
- Claude Code — CHANGELOG (compaction repair history; observed 2026-11-08 at the
  `2.1.319` entry) — <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>
- opencode — compaction docs, repo path `services/site/src/docs/content/compaction.mdx`,
  read at revision `caf8d6a` (branch `dev`), pinned:
  <https://github.com/sst/opencode/blob/caf8d6a/services/site/src/docs/content/compaction.mdx>
- DeepSeek Harness — compaction subsystem docs, repo path `docs/subsystems/compaction.md`,
  read at revision `fcc0ad46` (branch `master`), pinned:
  <https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad46/docs/subsystems/compaction.md>
- Manus — *Context Engineering for AI Agents: Lessons from Building Manus* (KV-cache hit
  rate; append-only discipline) —
  <https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>
- **preprint** — *PruneTIR: Inference-Time Tool Call Pruning…* —
  <https://arxiv.org/abs/2605.09931>
- **preprint** — *Feedback That Backfires: Why Small Language Model Agents Repeat the Call
  They Just Watched Fail* — <https://arxiv.org/abs/2608.23651>
- **preprint** — *Lost in Context Compaction: When LLM Systems Drop Side Constraints* —
  <https://arxiv.org/abs/2608.11242>
- **preprint** — *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM
  Summarization for Agent Context Management* (NeurIPS 2025 DL4C workshop) —
  <https://arxiv.org/abs/2508.21433>

Marked **unconfirmed**: the specific effect of any of these findings on **this** harness's
models and provider mix — nothing here was measured locally (see *Not tested*), and the
arXiv numbers (17% retention, 84% token cut, masking≈summarization) come from their own
evaluation setups, not from `@underload/harness`.

## Open decisions

1. **Q1–Q5 of T0**, with recommendations recorded but no owner decision yet.
2. **Annotate vs exclude**: whether an annotated result keeps the original text in the
   message (reversible, costs bytes) or only a handle (cheap, needs a re-read path). Not
   decided; T0 Q1 defers it behind a setting.
3. **Whether `outcome` is derived from `isError` on read for legacy transcripts.** T1's
   answer is "absent means completed"; a distribution with important old sessions may want
   "absent means unknown", which changes the pruning rule (F5, resolved-only). Marked
   **unconfirmed** until a real corpus is inspected.
4. **The fingerprint's treatment of tools whose arguments legitimately vary while doing the
   same work** (a `read` with a different `offset`, a paged `threadRead`). T2.4 says
   exact-match for now; a per-tool normalization hook is the alternative and is not free.
5. **Where the policy lives**: inside the shipped built-in (`executeCompaction`) or as a
   second built-in that composes with the limit guard — which depends on the pipeline
   entry's priority/composition work landing first.

## Verify before starting — drift check

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'                # written against 44cdbbe, tree dirty
sed -n '165,186p' src/plugins/context-compaction.plugin.ts   # still a no-op?
grep -rn "outcome" src/types/index.ts src/harness.ts | head # event-only, or persisted yet?
grep -n "role: 'tool'," src/harness.ts                      # the committed message shape (:5660)
grep -n "included'\]" src/core/snapshot.ts src/core/branch.ts  # the key lists T1 must extend
grep -n "MODEL_TOOL_RESULT_BUDGET_BYTES" src/core/result-budget.ts
grep -n "CHARS_PER_TOKEN" src/core/context-estimate.ts
grep -rn "compact\|prune" src/ --include=*.ts | grep -v test | head   # someone started?
sed -n '3739,3745p' knowledge.md           # roadmap entry still says "not built yet"?
npm run plugins:manifest:check             # BASELINE green before any edit
```

Stop-and-recheck conditions:

1. **`executeCompaction` is no longer blank** — F1 is `corrected`; re-scope to auditing the
   policy that landed rather than writing one.
2. **A persisted outcome or a fingerprint helper already exists** — T1 or T2 is done; keep
   the rest and mark the row.
3. **`HarnessToolCall` gained a flag** — F4's last row flips and Q4 is answered for you.
4. **The result budget changed** (aggregate guard added) — T5.2/T5.3 are partly done; F6's
   numbers are the ones to re-read first.
5. **A provider-overflow classifier appeared** — issue 0004 has moved; re-read it before
   touching T5.5.

## Not tested

- **Docs-only entry: no test run was performed for this file.** The baseline statements
  above (the suite is green on this tree; `src/harness.inclusion.test.ts` holds 35 `it()`
  blocks — a static count) describe the tree as handed over, not a measurement taken here.
- **Frontier-model behaviour in this harness.** Every behavioural claim in *Why this policy*
  is cited from another system's evaluation. Nothing measured what **this** harness's
  configured model does when an answered failure is withheld.
- **The actual prompt-cache cost of a mid-history flag change** with the configured
  provider — Q5's batching rule is reasoned from vendor guidance, not from a measured hit
  rate here (`HarnessUsage.cached`, `src/types/index.ts:254-267`, is never fed back into
  the estimate, F6).
- **Per-call partial exclusion** (Q4) — never exercised; the transport always sends every
  call of a block (`src/transport/openai.ts:305-308`).
- **Worker-mode durability of a plugin write** — asserted from
  `src/types/index.ts:3493-3502` and `src/server/workers/lane-worker-loop.ts:632-648`, and
  owned by the pipeline entry's T4; no lane run was observed.
- **Full-summary quality** (T6) — untested by design: this stage does not write a summary.
- **Whether pruning changes the agent's *behaviour* favourably** on a real long task. The
  cost argument is arithmetic; the quality argument is borrowed from the citations, and the
  changelog evidence in F5 says the failure mode (thrash, lost constraints) is real. T3's
  horizon and floor exist because that risk is not measured here.

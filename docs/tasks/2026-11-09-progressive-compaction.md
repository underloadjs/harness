# Progressive compaction — prune what a later success already answered

Status: **the stage has landed except the guards nobody asked for — and T5's separable
budget controls are now part of what has landed: T0 answered with dates, T1 (the persisted
tool outcome), T2 (the argument fingerprint, now exported), T3 (the pruning policy), T4
(its guards, settings, observability and the notification coalescing) and T5.1/T5.2/T5.4
(the write-time spill envelope, the aggregate per-turn tool-result budget and the
provider-anchored context estimate) are all in the working tree as of 2026-11-09.** What
remains open here is T5.3 (tool-result elision, blocked on the annotate/original-text
decision, with its reason recorded under the task) and T6 (the summarize-and-reinitialize
checkpoint, explicitly not this stage — deliberately unbuilt, and `knowledge.md`'s "Not
built yet" says exactly that); the worker-lane case of T7 is **no longer one of them** —
the pipeline entry's T4 landed the durable proof on a real `threadExecution: 'worker'`
session (UPDATE 2026-11-09, see the note under T7), leaving only T7's real-corpus /
live-provider observations open. T5.5 (provider overflow recovery) is
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md)'s
and was not touched. The
original framing still holds — T0 blocked the implementation, and T1/T2 are the two source
changes that policy depends on. Written as a companion to
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
consequences are listed in *Not tested* rather than smoothed over. **Amendment 2026-11-09:**
the implementation pass that landed T1 and T2's export DID run the suite, baselined before
the first edit; the measured numbers replaced the "not measured" caveat in *Not tested*.

**Scope:** the **pruning** half of compaction — deciding which already-committed transcript
units stop being sent to the model, and the small source changes that make that decision
sound (a persisted tool outcome, a canonical argument fingerprint).

**Out of scope (explicitly, so nobody "fixes" it here):** the full
summarize-and-reinitialize checkpoint (F7 → T6); pre-request token guarding and provider
overflow classification (issue 0004); the token-budget policy
(`src/core/result-budget.ts` stayed as shipped until T5.1/T5.2 decided otherwise — and even
then the per-result cap and its 256 KiB constant are untouched: what changed is the
envelope's shape, plus a per-turn aggregate beside it); and the
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

**CORRECTED 2026-11-09 — T3 landed, so this finding's headline is history and stop-and-recheck
condition 1 has fired.** `executeCompaction` is no longer blank: it prunes superseded tool
failures through `setIncluded` (see *T3 — LANDED*), and the policy itself lives in
`src/core/context-pruning.ts`. What this row predicted is exactly what happened — the
trigger/cooldown/pause machinery was inherited unchanged, and filling in the action was the
whole integration. Two of its observations still hold and still matter: the estimate is
recorded BEFORE the action (`contextLimit` crossing → cooldown slot consumed even by a pass
that pruned nothing, which is why a refused pass reports `belowFloor` instead of staying
silent), and `configuration.plugins` can still replace the built-in in-process only.

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

**CORRECTED 2026-11-09 — T1 landed, so the headline of this finding is history.** The
committed entry now carries the classification as an optional `outcome` key
(`src/types/index.ts:210-275`, the field and its storage contract at `:230-260`), written at
the one insertion point (`src/harness.ts:6037` `insertToolMessage`, key emitted at `:6076`)
from the value the delivery computed (`:6369`/`:6374` for a settled task, `:6467` for an
immediate result), and admitted by both persisted readers (`src/core/snapshot.ts:429-431` +
`applyOutcome` `:251`; `src/core/branch.ts:637` + `copyOutcome` `:502`). Two table rows are
the ones that changed — "the committed message carries only `{role, content, toolCallId,
name, attachments?}`" and "the snapshot reader's per-role key allowlists do not name an
outcome". Everything else still reads true: the prose is still produced and still shown to
the model; it is simply no longer what a rule has to read. What did NOT change is the
migration stance: a transcript written before this landing carries no key, reads as
`completed`, and nothing re-derives the old value from the text — which is exactly why Q3's
"never touch a unit with no committed result" and the superseding-success requirement are not
optional (F5, resolved-only).

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

**CORRECTED 2026-11-09 — two rows of this table are history after T5.1/T5.2/T5.4, and the
line numbers in all of them are stale (re-solve by identifier, per the note under *Verify
before starting*).**

- **"nothing anchors it to provider-reported usage" is no longer true.** The chars/4
  heuristic is still there and is still the contract of `estimateContextTokens`, but
  `src/core/context-estimate.ts` now also exports `transcriptChars`, `ContextTokenAnchor`,
  `anchorFromUsage` and `estimateContextTokensHybrid`, and `../harness.ts` feeds BOTH
  `turn.before` estimates from the hybrid (see *T5.4 — LANDED*). What is still true: the
  number is a heuristic for the text that arrived since the last reported request,
  `reasoning` is still never counted, an attachment still costs its name + MIME only, and
  `HarnessUsage.cached` is still fed into nothing.
- **"per result, no aggregate guard" is no longer true.** The header sentence that said so
  has been rewritten, and `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES` (512 KiB) plus
  `createToolResultTurnBudget` now bound the SUM one turn commits (see *T5.2 — LANDED*).
  The per-result cap and the 256 KiB constant are unchanged, so the `read`-survival
  property that number exists for is untouched.
- The envelope SHAPE changed too (see *T5.1 — LANDED*): the mid-string cut is now a
  head/tail preview plus a note naming the producing call. `src/core/result-budget.ts`
  (and `knowledge.md`'s manual-route section) carry the current key set; this entry does
  not restate it.

What did NOT move: the transcript as a whole still has no independent cap, and there is
still no pre-request guard or provider-overflow classification — that half of issue 0004
(T5.5) is untouched by this stage.

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

**ANSWERED 2026-11-09 — all five, so T0 is closed as a decision. At the time the answers were
recorded the settings descriptors were explicitly NOT part of them; they belonged to T4, and
that split is what the *Check:* note under this section refers to (it has since been closed —
see its status paragraph).**

- **Q1 — `exclude`.** Accepted as recommended, with the seam made real rather than
  aspirational: the candidate list is computed before anything is written (T3.5), so an
  `annotate` mode is a second **writer** over the same list, not a second policy. The
  `mode` setting starts at `exclude`; whether an annotated result keeps its original text is
  still open (Open decisions 2) and only matters once `annotate` exists.
- **Q2 — every turn, with a `minTokens` floor.** Accepted. The cooldown's ordering flaw
  (`src/plugins/context-compaction.plugin.ts:250-252` records the estimate *before* the
  action) is the reason a threshold-only trigger is not chosen; the floor is what makes
  "every turn" cheap instead of chatty (T4.1).
- **Q3 — tail horizon counted from the END of the transcript, plus the committed-result
  rule.** Accepted, with the direction made explicit because it is the easy half to get
  backwards: `safetyTurns` is a **tail** horizon — the last K units of the whole transcript,
  i.e. the most recent work — and a pass may only ever consider units before it. Independently,
  a unit with **no committed result** is never a candidate. The second clause is what makes
  T1.5's absent-means-`completed` reading safe: a pre-outcome transcript, a still-pending
  background call, and a branch placeholder all read as healthy, so none of them can be pruned
  on the strength of a key they do not have.
- **Q4 — unit-level.** Accepted, including the stated cost: a block that mixes one failed and
  one successful call is withheld whole. Per-call partial exclusion stays recorded in
  [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md) T2
  and is now additionally pinned as *not tested* here (Not tested).
- **Q5 — batch.** Accepted: flags change in one pass, and the persistence notification fires
  **once** per pass rather than per write (`src/harness.ts:7638-7640` today, each notification
  able to trigger a whole-document save, `src/server/persistence.ts:33-44`).

*Check:* this section has five dated answers; `context-compaction`'s setting descriptors
(`src/plugins/context-compaction.plugin.ts:101-112`) match them (a `mode`, a `minTokens`,
a `safetyTurns`, and either the existing `contextLimit` kept or explicitly superseded), and
the generated plugin manifest is regenerated (`npm run plugins:manifest`,
`package.json:102`) so `npm run plugins:manifest:check` passes.

**Status 2026-11-09 — GREEN END TO END.** The five answers are recorded above, and T4.6 shipped
the descriptors that express them: `enabled`, `contextLimit`, `minTokens`, `safetyTurns` and
`mode` (declared as a string enumerating only `exclude`, because that is the only value this
build implements), each with the same default as the fallback constant beside it, and
`npm run plugins:manifest:check` passes. The order the entry asked for — answers first, knobs
with the policy that needs them — is the order it happened in: T0 and T3 landed before the
descriptors, so no knob was ever advertised for behaviour that did not exist.

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

**LANDED 2026-11-09 — T1.1–T1.5, and one structural decision the task left open was made:
the three rules live in a new leaf module, `src/core/tool-outcome.ts` (95 lines), rather than
being re-spelled at each site.** Absent-means-`completed` is now stated once (`toolOutcomeOf`),
the omit rule once (`storedOutcomeEntry`, the spread form a message literal wants), and the
derivation once (`isErrorOutcome` from a classification / `toolResultIsError` from an entry),
plus the validation half (`TOOL_OUTCOMES`, `isToolOutcome`) the two untrusted readers share.
Pinned by `src/core/tool-outcome.test.ts` (8 cases, exact strings and exact key order).

- **T1.1** — `src/types/index.ts:210-275`; the field and its storage/migration contract at
  `:230-260`. Key order is `role, content, toolCallId, name, attachments?, outcome?,
  included?, messageId`: a field is declared where the writer emits it, and `messageId` stays
  last because `assignMessageId` appends it (`src/core/message-id.ts:161-171`). Order matters
  because a snapshot IS JSON text, and the tests now pin the serialized form.
- **T1.2** — one writer, as the task demanded. `insertToolMessage` (`src/harness.ts:6037`)
  takes the outcome the delivery computed as a 6th parameter and spreads
  `storedOutcomeEntry(outcome)` into the spliced literal (`:6076`); the settled-task delivery
  passes it at `:6374` and `immediateResult` at `:6467`. No site reads `content` to decide
  anything. Both branch and root deliveries write it (the `notify` flag is orthogonal), so a
  `threadFork` transcript knows what its inherited failures were.
- **T1.3** — `isError` stays derived at both report sites (`:6369`, `:6477`) and is never a
  stored field; the assertion that the entry has no `isError` key is now in
  `src/harness.background.test.ts`. The **projection keeps `outcome`**:
  `core/agent.ts`/`withIncluded` strips only `included`/`messageId`, which is the "optionally
  expose `isError`/`outcome` reads on the projection" half taken up — a `turn.before` policy
  reads the classification off the very list it is asked to trim (pinned in
  `src/harness.snapshot.test.ts`). A provider payload is unaffected either way because the
  transport field-selects the tool shape (`src/transport/openai.ts`).
- **T1.4** — three allowlists, extended exactly the way `messageId` and `included` were:
  the snapshot tool list (`src/core/snapshot.ts:429-431`, optional list `:431`) with
  `applyOutcome` (`:251`, called at `:455`); branch materialization (`src/core/branch.ts:637`)
  with `copyOutcome` (`:502`, called at `:677`); the fork/reset baseline copy
  (`src/core/agent.ts:257` and `:265`). OpenAPI: the `tool` variant of `HarnessMessage`
  (`src/server/harness.swagger.yaml:8104-8119`, enum at `:8106`), with
  `additionalProperties: false` kept honest. Both readers **refuse** a value outside the
  union (a mistyped `"fail"` must not silently read healthy) and **normalize** an explicit
  `completed` back to absent, so `restore → snapshot` stays idempotent — the `included: true`
  precedent. `node scripts/generate-harness-contract.mjs` produced **no** delta in
  `src/shared/` (`--check`: "harness contract types are up to date") because the generated
  types alias `../types`; no tool description changed, so `tools:manifest:check` and
  `plugins:manifest:check` both stayed current.
- **T1.5** — no bridge, as decided: the header note is
  `src/plugins/context-compaction.plugin.ts:12-14`, and a pre-outcome transcript, a completed
  result and a branch's pending placeholder all read `completed`. `src/core/branch.ts`'s
  `flushPending` deliberately still emits no outcome, and
  `src/core/branch.test.ts` now pins that a placeholder has no such key — the rule T0 Q3
  depends on.

**One boundary T3 has to respect, found while landing this (recorded here rather than
"fixed"):** three different things read as `completed` because they carry no key — a
transcript written before T1, a genuinely healthy result, and a **placeholder that was never
a delivery**. The last family has two members: a branch's request-only pending entry
(`src/core/branch.ts` `flushPending`, pinned as keyless), and the interrupted-call repair a
server commits when a process died mid-call (`src/server/persistence.ts`,
`INTERRUPTED_TOOL_RESULT_TEXT`) — that one DOES commit a tool message, so "never touch a unit
with no committed result" (Q3) does not by itself exclude it. Giving the repair a real
classification needs a fifth outcome value ("never settled"), which is a contract change the
union's own header has not agreed to; the conservative choice, taken here, is to leave it
absent and make the resolution rule require a superseding **success that was actually
delivered**. Flagged for T3 rather than decided in a substrate change.

*Check:* `npx vitest run src/harness.background.test.ts src/harness.action-request.test.ts
src/harness.snapshot.test.ts src/core/branch.test.ts src/transport/openai.test.ts
src/server/transcript.test.ts` with new cases: a failed and a cancelled result
carry their exact `outcome`; a **completed** result carries no key at all (assert
`JSON.stringify` of the message equals the pre-change shape); snapshot round-trip and fork
carry it; the provider payload is unchanged (`src/transport/openai.ts:316-321` sends
`role`/`tool_call_id`/`content` only).

**Status 2026-11-09 — every bullet is pinned, and the list was baselined BEFORE the first
edit: 146 passed → 156 passed, no regressions** (`Temp/g5/baseline-focused.log`,
`Temp/g5/focused-after-tests.log`). Per file after the change: `src/harness.background.test.ts`
25 (a new `it()` pinning `rejected`/`failed` on the entry and a **byte-exact**
`JSON.stringify` of a completed one; the cancelled pin went into the existing `toolCancel`
test, which is where a control outcome is produced), `src/harness.action-request.test.ts` 10
(untouched — an autoanswer branch's tool results are the immediate/rejected path, already
covered by the background pins), `src/harness.snapshot.test.ts` 43 (a new `describe` with five
cases: no key while healthy + a pre-outcome document reading `completed` with the prose still
saying "failed", the persisted round-trip with an idempotent re-save and a projection that
keeps the key, `completed` normalized away, the union refusal, and a host thread),
`src/core/branch.test.ts` 25 (fork carries `failed`, `completed` normalizes away, a bad value
is refused, a pending placeholder has no key), `src/transport/openai.test.ts` 33 (the wire
stays `role`/`tool_call_id`/`content` for a `failed` and a `cancelled` result),
`src/server/transcript.test.ts` 20 (the routes accept and serve the key; `document` contains
`"outcome": "failed"` and never `"outcome": "completed"`).

Three files outside that list changed too, because the substrate reaches further than the
task's own list assumed: `src/core/tool-outcome.test.ts` (new, 8 cases),
`src/core/agent.fork.test.ts` 14 (the fork **baseline** copy path — `copyBaselineMessage` —
which `reset()` re-clones, and which no focused-list file exercises), and
`src/core/argument-fingerprint.test.ts` 23 (the T2 barrel export). One pre-existing pin had
to learn the new key: `src/harness.tool-failures.test.ts` 17 — a compiled tool's synchronous
throw now stores `outcome: 'failed'` on the entry, which is the feature, not a regression;
it is the only delta in the whole suite (3067 passed / 2 skipped, see *Not tested* for the
measured baseline).

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

**Status 2026-11-09 — T2.1, T2.2 and T2.4 are LANDED (the helper arrived with an earlier set
and its own tests); the EXPORT step asked for here is now done, and T2.3 stays deliberately
in the policy.** `src/core/index.ts:208` re-exports `argumentFingerprint` and
`toolCallFingerprint` into `src/core`, immediately below the outcome helpers
(`:194-201`). One clarification of the task's wording: the context estimator
(`src/core/context-estimate.ts`) is **not** a barrel export — `src/harness.ts:380` imports it
by module — so "exported from `src/core` beside the estimator" is satisfied as "in `src/core`,
same internal-package surface", which is what the line does. Nothing consumes it yet (T3.3 is
the resolver's job). The export is pinned by an identity assertion (`toBe`, not a re-derived
value) in `src/core/argument-fingerprint.test.ts`, now 23 tests. The optional "export T2.3's
resolution rule as a pure predicate beside it" was considered and DECLINED: the rule needs a
(unit, later unit) pair from a transcript, which is the scan T3 owns, and
`src/core/argument-fingerprint.ts:63-71` already states the outcome half as data in its test
file (`RESOLUTION_MATRIX`, `src/core/argument-fingerprint.test.ts:224`, evaluated at `:351`) — a predicate here would put policy in a data helper and duplicate a decision T3 has to
make with the horizon rules from Q3 anyway.

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

**LANDED 2026-11-09 — T3.1–T3.6, in `executeCompaction` as the task specified, with one
structural decision: the RULE is a pure function in a new leaf module,
`src/core/context-pruning.ts` (`planContextPruning`, `groupUnits`, `resolvesPrunedFailure`),
and the plugin is only its WRITER.** That is T3.5's "compute the candidate list first" taken
to its end — an `annotate` mode is a second writer over the same `PrunePlan` — and it is what
makes the policy table-testable without a harness (25 cases in
`src/core/context-pruning.test.ts`, every token count asserted as an exact number).

- **T3.1** — runs inside the shipped built-in's action, which the trigger/cooldown/pause
  machinery already wrapped (`src/plugins/context-compaction.plugin.ts`
  `executeCompaction`). The SYNC fast path is untouched: the guard still returns
  synchronously for every turn under the limit, and the async boundary is still only a real
  trigger.
- **T3.2** — scans `context.entries` (read ONCE per pass, because it is cached per handler and
  its entries stay valid across flag writes) and groups it into units (`groupUnits`).
  Already-disabled units are skipped, which is the idempotence half of T4.3. **A mirror,
  stated rather than hidden:** the grouping is re-derived here because the shipped one
  (`../harness.ts` `transcriptUnits`) is module-private and importing it from a plugin would
  make a plugin import the harness at runtime (a cycle through `../plugin/manifest.ts`).
  Divergence is bounded and conservative — the WRITE still cascades the runtime's own unit,
  and estimating a subset of members UNDER-counts the saving, so a mismatch can only refuse a
  prune or name a different member, never break pairing. The pair-clean oracle below is what
  keeps that honest in behaviour.
- **T3.3** — the resolution rule, exported as the pure predicate `resolvesPrunedFailure`: a
  candidate needs EVERY committed result `failed`/`rejected`; a resolver needs every result
  `completed`, must itself still be `included`, and must contain **every** call key of the
  candidate (`toolCallFingerprint(name, arguments)`, so a reordered-JSON retry matches and a
  different `offset` does not). `cancelled` is never a candidate and is never resolved away,
  and `completed` is never a candidate. The matrix in
  `src/core/argument-fingerprint.test.ts` is reused verbatim as acceptance data, so the policy
  cannot quietly redefine "answered".
- **T3.4** — one write per unit, on the unit's leader entry; `setIncluded` cascades the
  assistant message, its results and its request-only placeholders. Pinned from the harness
  side in `src/plugin/context-compaction.test.ts` (the provider request after a prune holds
  exactly the three answering results and no pruned block) and by the untouched
  `src/harness.inclusion.test.ts` unit-semantics suite.
- **T3.5** — `PrunePlan.candidates` IS the seam: the plugin writes them in one loop and nothing
  else reads the plan. `mode` is already plumbed (T4.6) and an unimplemented value degrades to
  `exclude` while the diagnostic reports BOTH the stored and the used value.
- **T3.6** — `isInternalAgent` reused, unchanged. It earned its keep during this landing: the
  durable test's agent was first named `compactor`, and the guard correctly refused to compact
  it because the name contains the `compact` marker.
- **Ratified addition — a BRANCH round prunes nothing.** `context.branchId` short-circuits the
  guard AND the action (the action first, before any settings read). The reasons, all three
  real: the flag write would land on an ephemeral copy that is incorporated as text and is
  excluded from snapshot v1; the owner re-derives the same decision on its own next round; and
  the branch's cooldown key (`branch:<id>`, one per fork) could never be cleared, so every
  fork of an over-limit conversation added a dead entry to a map nothing prunes. Recorded
  against F11/T8 of
  [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md),
  which is where the discriminator was specified.
- **The placeholder nuance T1 left behind is handled by the rule, not by a new value.** A
  repaired interrupted call carries no outcome, so it reads `completed`: it can never be a
  CANDIDATE (a candidate needs a failed/rejected result), and it may only act as a resolver
  through the same fingerprint match as any other answer. The diagnostic names the resolver's
  id, so an operator can see which unit was believed to have answered. The reasoning is in
  `src/core/context-pruning.ts`'s header; no fifth outcome value was invented.
- **Guards the rule itself carries**, so a caller cannot forget them: a unit with no committed
  result is `unanswered` and untouchable (T0 Q3); a block that mixes a failed and a successful
  result is `mixed` and kept (Q4's cost, taken the conservative way — withholding it would drop
  a LIVE result); and a unit inside the tail horizon is untouchable but still allowed to
  ANSWER an older failure.

*Check:* `npx vitest run src/harness.inclusion.test.ts src/plugin/context-compaction.test.ts`,
asserting the **exact** set of indices disabled for
a scripted transcript — e.g. a `[read(failed), read(completed same args)]` pair leaves
`[0]` disabled and `[1]` enabled, and a second pass disables nothing new.

**Status 2026-11-09 — met, and the "exact indices" wording is honoured literally.** The
shared fixture `FAILED_THEN_ANSWERED` in `src/core/context-pruning.test.ts` is asserted
against the whole `PruneCandidate` object (`leaderIndex: 1`, `members: [1, 2]`,
`resolverIndex: 3`, `keys: ['read\u0000{"path":"a.ts"}']`, `tokens: 12`) rather than against a
count; the answering unit appears in no candidate; `withheldTokens` 12 is separately derived
from `estimateContextTokens` before/after removing indices 1 and 2. The multi-unit case pins
`[1, 6]` for two superseded failures in one transcript, `maxUnits` pins the eight oldest of
ten, and the second-pass case asserts the candidate list is EMPTY on the already-flagged
transcript (which is what makes the no-write/no-notify/no-save chain in T4.3/T4.4 testable at
all). Through a real harness, `src/plugin/context-compaction.test.ts` pins the same decision
as six flagged canonical messages and one provider request that no longer contains a pruned
block.

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

**LANDED 2026-11-09 — T4.1–T4.7, one change, both entries' T4 closed by the same edit.**

- **T4.1 — `minTokens`.** Measured with the package estimator by removing the candidate
  units from the transcript and re-running `estimateContextTokens` on the remainder
  (`withheldTokensOf` in `src/core/context-pruning.ts`), which is the delta the floor needs —
  instructions are constant on both sides and cancel out, and the estimator's single rounding
  over the whole transcript makes the BATCH number authoritative (per-unit numbers are
  reported too, and are smaller: 3 + 3 tokens measured as 7 as a batch, pinned in the test).
  Below the floor the plan comes back EMPTY, so the caller writes NOTHING — no flag, no
  notification, no save — and `belowFloor: true` makes the pass say why instead of being
  silent. Default **200** tokens (≈800 characters: one medium tool result), because 40 tokens
  is a cache invalidation for nothing (Q5).
- **T4.2 — the tail horizon.** `safetyTurns` counts UNITS **from the end**: `firstProtected =
  units.length - safety`, and the scan skips `index >= firstProtected` — so 0 protects
  nothing (the comparison, not a special case) and a corrupt `NaN`/negative value behaves as
  0 rather than protecting the whole transcript. The direction is pinned explicitly, because a
  horizon measured from the front would prune exactly the work in progress, and `context.iteration`
  is not used anywhere in the policy. Default **6** units: a unit is coarse (a whole tool
  block), so 6 is roughly a failure, its retry, the retry's answer and the turn after — the
  window the retry-loop evidence in F5 says must stay visible. A unit inside the horizon may
  still ANSWER an older failure.
- **T4.3 — idempotence and a bound.** An already-disabled unit is never a candidate (a second
  pass proposes nothing, therefore writes nothing, therefore notifies and saves nothing —
  asserted at three levels: the pure plan, the action, and a real harness round), and
  `MAX_UNITS_PER_PASS = 8` (`src/plugins/context-compaction.plugin.ts:227`) bounds one pass,
  taking the OLDEST eligible units so the bound also decides what survives: the recent tail.
  It is deliberately NOT a setting — T4.6 declares exactly the four knobs the answers name,
  and a knob nobody asked for is a knob nobody reads.
- **T4.4 — notification coalescing (== context-inclusion entry T4, landed here once).**
  `src/harness.ts`: `setIncluded` (`:8265`) and `edit` (`:8366`) no longer notify per write —
  they call `reportCanonicalWrite()` (`:8009`), which marks the round dirty
  (`roundWritesToReport`, `:7974`), and `closeRoundObservations()` (`:7987`) flushes **exactly
  one** `agent_message` at the round boundary. Three properties the design had to keep, all
  pinned by tests:
  the flush happens BEFORE the request goes out, so durability is never later than it was;
  the batch never crosses a run boundary (no timer, no debounce — the round IS the batch, and
  the async tail's rejection path flushes before re-raising so a lost report cannot lose a
  write); and a write that lands after the round closed reports on the spot, because its
  window will never come again. **Host writes are untouched** (`setThreadMessages`,
  `writeThreadTranscript`, `postThreadMessage`): one host write, one report, exactly as before.
- **T4.5 — batching and the pass report.** One pass disables a whole batch in one loop (one
  cache invalidation at a batch boundary rather than a rolling series), and every pass reports
  on the diagnostic channel: the units withheld, each one's estimated tokens, its outcomes, and
  `supersededBy` — the superseding unit's stable `messageId` when it has one. Mechanism, added
  with it: `api.report.diagnostic(report)` (`src/types/index.ts:4163`, `HarnessPluginApi`),
  implemented on the api base (`src/harness.ts:1480`) and stamped with the plugin's name by the
  per-plugin view (`src/plugin/host.ts:163`), forwarding to the host's existing
  `harness({ report.diagnostic })` sink. `HarnessDiagnosticEvent` gained the kind `'policy'`
  (a plugin's own decision report, not a failure), an optional `data`, and an OPTIONAL `event`
  — a decision is not tied to one hook, while every framework failure still names its own. A
  missing sink is a silent no-op and a throwing sink cannot fail the turn, so the channel
  stays as advisory as `report.stateChange`.
  **Honest gap, pinned rather than claimed:** the SERVER installs no `diagnostic` sink yet, and
  `HarnessPresetReport` has no field to carry one, so on the durable server plane a policy
  report currently has nowhere to go (recorded in `src/server/persistence.test.ts` where the
  test supplies its own). Wiring that sink is server plumbing the pipeline entry owns, not a
  policy question.
- **T4.6 — settings.** `metadata.settings` now declares five descriptors: the existing
  `contextLimit`, plus `enabled` (boolean, true), `minTokens` (number, 200, min 0, step 50),
  `safetyTurns` (number, 6, min 0, step 1) and `mode` (string, `'exclude'`). `mode` enumerates
  ONLY `exclude` — `HarnessPluginSettingType` has no select/enum type, and inventing one for a
  value that has one implementation would advertise a choice the plugin cannot honour — so the
  `annotate` seam is documented in the descriptor's own text and enforced by
  `COMPACTION_MODES` (`:220`), with the fallback constants beside the defaults (`:210-213`) in
  the file's existing duplication pattern and the metadata kept a plain literal for the scanner.
  `npm run plugins:manifest` was re-run and `plugins:manifest:check` is green; the generated
  `src/plugin/manifest.ts` is byte-unchanged, because it imports the metadata object rather
  than inlining it — the settings reach the UI through that reference, which the catalogue
  tests now pin with all five rows.
- **T4.7 — visibility.** The dependency is satisfied (the production `onHandlerError` →
  `report.diagnostic` reporter landed with the pipeline entry), and this change goes one step
  further: a compactor that DID something is now distinguishable from one that did nothing,
  including the specific case an operator would otherwise misread — superseded work existed but
  the saving was under the floor.

*Check:* `npx vitest run src/plugin/context-compaction.test.ts src/plugin/async-ping.test.ts src/harness.inclusion.test.ts src/harness.snapshot.test.ts` plus one server test asserting the **number of `state_change`
notifications** a multi-unit pass emits (coalescing, T4.4), and one asserting the pass is a
no-op on a second identical turn.

**Status 2026-11-09 — met, and the notification count is measured, not asserted.** The four
listed files are green (`src/plugin/context-compaction.test.ts` 29 cases,
`src/harness.inclusion.test.ts` 54, `src/harness.snapshot.test.ts` 43 untouched,
`src/plugin/async-ping.test.ts` 21 untouched). The server test is
`src/server/persistence.test.ts` › *persists a pruned pass and reports the whole multi-unit
pass ONCE*: the same seeded conversation run twice, once with the built-in and once with it
replaced by a no-op host plugin of the same name, counting `agent_message` reports — **two
without a pass, three with a three-unit pass**, i.e. one report for three writes, and 40 units
would also be one. The same test pins the durable shape (six flagged entries, nothing else),
that a refused pass writes nothing at all, and a restart: the stored document keeps the
decision, and the pass after a restart re-derives the identical plan and the identical single
report (the running preset conversation re-seeds from the preset's own `messages`, which is
what a preset IS, so the policy is proven reproducible rather than cached).
"no-op on a second identical turn" is pinned twice more, at the cheaper levels: the action's
second pass over the same entries writes nothing and reports nothing, and through a real
harness a second triggered turn adds exactly its own two writes.

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

**LANDED 2026-11-09 — T5.1, T5.2 and T5.4. T5.3 stays OPEN, deliberately (its reason is
recorded under its own bullet). T5.5 is issue 0004's and was not touched.** All three are
inside this package's existing seams: no new persisted field, no contract type change, no
wire change, and no edit to the pruning rule in `src/core/context-pruning.ts`.

- **T5.1 — LANDED, and the envelope grew two keys rather than changing its meaning.**
  `src/core/result-budget.ts` `boundToolResult(content, budgetBytes?, options?)` now emits
  `{ truncated, originalBytes, budgetBytes, note, content, tail }`: `content` stays the
  HEAD preview (the key every consumer and every earlier test already read — renaming it
  would break a documented contract for a cosmetic gain), `tail` is the new end preview,
  and `note` is the honest line: bytes cut, bytes of the original, the budget that bit,
  and **which call to re-run** (`re-run tool 'read' (call c1) with narrower arguments to
  fetch it`). The split is 3/4 of the surviving allowance to the head and 1/4 to the tail
  (`HEAD_PREVIEW_RATIO`/`TAIL_PREVIEW_RATIO`) — the beginning of a structured result keeps
  its keys, the end keeps the answer or the error, and the middle is what a model reads
  last. The note is RECOMPUTED on every shrink attempt, so it cannot claim a cut that did
  not happen; a budget below the envelope's own overhead (~250 bytes, most of it the note)
  degrades to a note-only envelope, which is pinned. The parseable-JSON contract
  (`:16-18` in the old numbering) is preserved and re-pinned, including the
  never-split-a-surrogate-pair rule at BOTH cut points (`trimBrokenSurrogate` for the head,
  the new `trimBrokenLeadSurrogate` for the tail). **What did not change:**
  `MODEL_TOOL_RESULT_BUDGET_BYTES` is still 256 KiB, the cap is still post-serialization,
  and an under-budget result is still returned byte for byte (the `read`-survival
  regression keeps passing untouched). The third parameter is opt-in: the harness's five
  delivery sites pass the tool name and call id through `boundDelivery`, while the server's
  manual `executeTool` route (`src/server/api.ts`, which has no transcript call to point at)
  passes nothing and gets `re-run the tool call` — the same cut, a less specific address.
  Honest limit, stated in the header: the full text does NOT live anywhere the harness can
  hand back — the envelope replaces it in the committed message, so "where the full text
  lives" is the tool call, and re-running it is the only way back. That is the
  "re-fetchable" condition F5's rule needs, and it is why an `annotate` writer can now be
  written without inventing a storage story first (Open decisions 2 still decides that story).
- **T5.2 — LANDED as a per-run ledger, because deliveries are one at a time and pairing
  forbids dropping one.** `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES = 512 * 1024` — 2x the
  per-result cap, so one full-budget `read` plus one more large result still fit UNCHANGED
  (the reason the per-result cap was raised to 256 KiB in the first place) while a turn of
  many big results can no longer spend N x 256 KiB. The guard is
  `createToolResultTurnBudget(aggregateBytes?, perResultBytes?)`, whose `commit()` applies
  the per-result cap first and then the turn's remaining HEADROOM: the first results of a
  turn keep their capped size, and once the window is spent each later result is spilled
  through the SAME T5.1 envelope at `min(perResult, max(SPILL_MIN_BUDGET_BYTES, remaining))`
  — never below the envelope's own overhead, never above the per-result cap it already
  satisfied — with a note
  that attributes the cut to the per-turn cap ("set by this turn's 524288-byte per-turn
  cap"), so the model can tell "my result was huge" from "this turn was greedy". A result
  is NEVER refused — a provider request must answer every `tool_calls[]` entry — so the
  aggregate is a soft bound, overshot by at most one spill envelope per result past the
  line (pinned: 524 788 against 524 288). **Determinism, stated:** the decision is a pure
  function of the bytes already committed and this result's bytes, in arrival order; there
  is no clock and no scan across siblings. Arrival order IS deterministic for the case this
  guard exists for (the SYNC calls of one assistant message deliver through the run's
  mailbox in the order the model listed them, pinned by the three-results-in-one-turn test);
  independently async calls can settle either way, and then which one keeps its size is
  which one settled first — bounded, stated, never a pairing problem.
  Wiring: one ledger per `RunState` (`../harness.ts` `turnResultBudget`, created at run
  construction and `reset()` inside `requestTurn` — after the round's FINAL transcript is
  decided and before a byte is sent, which is what makes a window "everything committed
  between two model requests"), applied by `boundDelivery` at all five delivery
  sites (cancelled / failed / completed / serialize-failure / `immediateResult`). A
  non-positive or NaN aggregate disables ONLY the aggregate guard; `src/core/index.ts` and
  the package root export the constant and the factory.
- **T5.4 — LANDED, heuristic-when-unreported, and one-sided about it.** New in
  `src/core/context-estimate.ts`: `transcriptChars` (the character weight the estimator
  divides by 4, exposed so an anchor is recorded in the SAME unit), `ContextTokenAnchor`
  (`{ tokens, chars }`), `anchorFromUsage(usage, requestChars)` and
  `estimateContextTokensHybrid(messages, instructions?, anchor?)` =
  `anchor.tokens + ceil((chars - anchor.chars) / 4)`. `estimateContextTokens` keeps its
  exact signature and is now literally `ceil(transcriptChars(...) / 4)`, so the UI context
  bar and every existing pin are untouched. Anchoring absorbs exactly what the heuristic
  cannot see — tool schemas, message framing, the tokenizer's real rate — and extrapolates
  only the text appended since the request that reported, which is the smallest and
  cheapest part to guess. Wiring in `../harness.ts`: `requestTurn` measures
  `pendingRequestChars` from the FINAL `requestTranscript` (after any plugin
  `setTranscript`/`replace`, before the response is appended) and resets the ledger; the
  `usage` frame that arrives for that request calls `anchorFromUsage` and, if accepted,
  stores `run.tokenAnchor`; both `turn.before` estimates
  (`estimatedTokens` and `currentEstimatedTokens()`) are computed with the anchor the
  HANDLER was entered with (`anchorAtEntry`), which is what keeps the shipped compactor's
  entry-time/cooldown rule intact and the pair comparable inside one round. `cached` is
  deliberately not used (it is a cache fact, not a size fact; see also *Not tested*).
  The sanity band is **asymmetric, and that is the design**: any positive count is adopted
  (a provider counting 100x the heuristic is the whole point), and a count is REFUSED only
  when it is below 1/4 of the heuristic — i.e. "more than 16 characters per token", which
  no real tokenizer does, and the direction (under-count) that would let a conversation
  run into an oversized request. The monotonicity rule, stated because the task demanded
  one: inside one anchor window the number is monotonic in the amount of text; it moves
  DOWN only at a re-anchor (a provider correcting this file's extrapolation, once per
  request) or when the transcript itself shrank (a withheld unit), and never because of a
  clock or a re-ordering. Both directions are pinned with exact numbers (903 after a 900
  report, 1004 when the report is refused, 903 as a downward correction of a 1001
  heuristic). **The plugin needed no policy change**: `contextLimit` is compared against
  `estimatedTokens`, which is now the hybrid, and the `minTokens` floor compares a
  DELIVERY-INVARIANT DIFFERENCE of the estimate, in which the anchor cancels exactly — so
  `src/core/context-pruning.ts` is untouched, by choice rather than by omission. Scope,
  stated: the anchor is per-RUN (and per branch run), so a host that starts a new run per
  message keeps the heuristic on its first turn; that is the pre-T5.4 behaviour, not a
  regression. The two `settings` descriptors whose text became false ("the same ~4
  characters/token estimate the UI context bar uses") were corrected in place, with the
  three catalogue pins that quote them.
- **T5.3 — DEFERRED, and the deferral is a decision, not a slip.** Annotating a superseded
  LARGE result (not only a failure) needs the question Open decisions 2 poses to be
  answered first: does an annotated result keep its original text in the message
  (reversible, costs the bytes it was meant to save) or only a handle (cheap, and the
  handle has to address something)? There is no addressable store for a tool result's full
  text in this tree — T5.1's note names the call to RE-RUN, which is a different promise
  from a re-READ — so an elision writer would have to decide storage, retention and a
  read-back tool, which is a contract change, not a policy knob. What this landing DID
  remove is the other half of the blocker: the "re-fetchable" condition F5 requires is now
  spelled to the model at write time, so T5.3 no longer waits on T5.1, only on that
  decision. `mode: 'annotate'` stays a declared-but-unimplemented value
  (`COMPACTION_MODES`), and `PrunePlan.candidates` is still the seam a second writer
  plugs into (T3.5).

*Check:* each sub-task has its own focused test command (`src/core/result-budget.test.ts`,
`src/core/context-estimate.test.ts`, and the transport tests for T5.4's usage anchor), and
T5.5's check is the one in
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md).

**Status 2026-11-09 — met, and every number in the three files is an exact expected value,
not a range.** The baseline was taken BEFORE the first edit —
`npx vitest run src/core/result-budget.test.ts src/core/context-estimate.test.ts
src/harness.background.test.ts src/transport/openai.test.ts src/plugin/context-compaction.test.ts`
→ **102 passed (5 files)**, and the same command after the work is **127 passed (5 files)**
(+13 in `result-budget.test.ts`, +12 in `context-estimate.test.ts`, the other three files
untouched and still green). `src/harness.budget.test.ts` (8 → 14) joins that list because
the per-turn ledger and the anchor only exist inside a run; the whole-suite numbers are in
*Not tested*. What each level pins:

- `src/core/result-budget.test.ts` — 20 cases (12 per-result + 8 ledger); the file was
  REWRITTEN against the new envelope, because five of its pins quoted the old prefix-only
  shape byte for byte. The envelope as an EXACT string and as an exact parsed object
  (74/25 previews at a 400-byte budget, 176 946/58 983 at the default cap), the four note
  spellings (name+id / name-only / id-only / no source), a JSON document that stays
  parseable and keeps BOTH its opening structure and its trailing `nextLine`
  continuation, multi-byte and surrogate cuts asserted as exact strings, the note-only
  envelope at a 0-byte budget, and the unchanged 256 KiB / byte-exact / full-budget-`read`
  pins. The ledger is pinned as a committed-byte TRAIL
  (968 → 1935 → 2035 → 2534 against a 2048-byte window) with the exact note each step
  produced, an explicit `toEqual(boundToolResult(...))` for the "under the aggregate costs
  nothing" property, a determinism case (two ledgers, identical strings), the soft-bound
  overshoot, `reset()`, the corrupt-aggregate rule over `0`/`NaN`/`-1`, and a
  caller-supplied per-result cap under a wider aggregate.
- `src/core/context-estimate.test.ts` — 12 cases added on top of the eight untouched
  heuristic pins (20 total), with no edit to any of the eight: `transcriptChars` equals the
  estimator's own numerator (440, 304, 38),
  `anchorFromUsage` exact accept/refuse tables (the band floor at 250 accepted and 249
  refused against a 1001 heuristic, a 100 000 report ADOPTED, `0`/`NaN`/negative refused,
  an empty prefix kept as framing overhead), and `estimateContextTokensHybrid` exact
  arithmetic — 1000 unchanged at the anchored prefix, 1015 after 60 new characters,
  25 100 against a 10 100 heuristic for the same transcript (the feature, in one pair of
  numbers), 115 for a transcript that shrank below the anchor, clamped at 0, the monotonic
  series `[1000, 1001, 1001, 1002]`, and the hostile-anchor fallbacks.
- `src/harness.budget.test.ts` — 6 cases added at the boundary where these rules actually
  run: three 300 000-byte results in ONE turn, asserted as
  `262144 / 262144 / 51806` budgets with the spill note naming the per-turn cap and the
  third call, plus "three calls, three results" for the never-drop rule; a one-result turn
  asserted BYTE-IDENTICAL to the pre-ledger envelope; and the anchor derived BY HAND from
  the scripted transcript (2 characters anchored at 900 → 903 at 14 characters; the same
  conversation without `usage` → `[1, 4]`, exactly the old number), including the
  below-the-heuristic correction and the refused report.
- `src/transport/openai.test.ts` — unchanged and still the pin for what the anchor reads:
  `usage.input` is `prompt_tokens` INCLUDING a replayed cache prefix (the `{input: 10,
  cached: 8}` cases), and an absent cache field stays "unknown". The wire format was not
  touched, so this file is the guard rail rather than a place that needed new cases.

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

**Status 2026-11-09 — the stage's list is pinned except for the one case that needs a worker
lane.** Measured, in the order the list states it: a pruned-and-resolved pair (pure plan +
action + real harness + durable server run); an unresolved failure retained; a `cancelled`
unit retained; a pending/in-flight unit untouched (`unanswered`, both as a candidate and as a
resolver); the pairing oracle kept honest by asserting the post-prune provider request
directly (`src/plugin/context-compaction.test.ts`); snapshot/restart preserving BOTH the flag
and the outcome (`src/harness.snapshot.test.ts`, `src/server/persistence.test.ts`);
idempotence — second pass changes nothing and notifies nothing, at the plan, action, real-harness
and durable levels; several units in one transcript, and several transcripts (two threads plus
a branch run, where the flag applies to the ephemeral copy only — and the shipped policy now
declines to write on a branch round at all); and the notification count for one multi-unit
pass (2 without a pass, 3 with a three-unit pass). NOT pinned here, still open: the
worker-mode durability case, which belongs to
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) T4 and needs a lane run
observed rather than asserted.

**UPDATE 2026-11-09 — that last case is now pinned, by the pipeline entry's T4 lane suites,
and this file's worker-lane item is closed.** `src/server/workers/lane-worker.test.ts` derives
the patch for an in-place flag change (`deriveOperations`: nothing owed while a replica matches
its base; a patch the moment a committed flag moves), `src/server/workers/lane-authority.test.ts`
replays it on a REAL canonical harness — the AUTHORITY's `threadMessages` answering
`included: false` plus the rewritten text, one `agent_message` report, the snapshot→restore
round trip — and a real `threadExecution: 'worker'` session carries the committed patch into
`state.json` and reads it back after a restart through a second store. One honest bound stays,
and it is the pipeline's T4.4, not this stage's: the operation in the durable test is SUBMITTED
on the lane's behalf by the test, because a host plugin cannot yet run inside a replica (a
preset factory closure cannot cross `worker_threads`), so the built-in compactor's own pass was
never observed ON a lane. The coalesced per-round report itself remains an inline-lane
mechanism (`closeRoundObservations`); a lane run carrying a plugin's prune end to end is the
step T4.4 would close.

`npm test` after the last production edit of this landing: **178 files, 3110 passed / 2
skipped** — the pre-edit baseline was 177 files / 3067 passed / 2 skipped, so this stage adds
one test file (`src/core/context-pruning.test.ts`) and 43 tests, with no regression anywhere
including the four catalogue suites that had to learn the five new descriptors
(`src/plugin/manifest.test.ts`, `src/harness.plugin.test.ts`, `src/server/plugins.test.ts`,
`src/server/plugins-api.test.ts` — all green, 80 cases between them).
`npm run typecheck` is clean (0 errors) and both manifest checks report current; `npm run
plugins:manifest` was re-run and the generated `src/plugin/manifest.ts` came back byte-identical,
because it imports the metadata object rather than inlining it. The tests-included probe
reports the same 458 pre-existing errors as before, none attributable to this work. `npm run
test:frontend` and `npm run test:package:tools` are reported under *Not tested*.

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

1. **Q1–Q5 of T0** — **CLOSED 2026-11-09, and so is the settings half.** All five are
   answered with dates under *T0 — Decide the policy*, and T4.6 shipped the descriptors that
   express them (`enabled`, `contextLimit`, `minTokens`, `safetyTurns`, `mode`), so this
   entry's T0 *Check:* is green end to end.
2. **Annotate vs exclude**: whether an annotated result keeps the original text in the
   message (reversible, costs bytes) or only a handle (cheap, needs a re-read path). Not
   decided, and still unbuilt — but the seam is now real rather than promised: `exclude` is
   one writer over `PrunePlan.candidates`, `mode` is a declared setting whose only implemented
   value is `exclude`, and a second value needs a new writer beside
   `executeCompaction`, not a new policy. **Amended 2026-11-09: T5.1 has now landed, and it
   answers "where does the full text live?" with the cheapest honest address there is — the
   call that made it (`re-run tool 'read' (call c1) with narrower arguments`), not a stored
   copy. So a pruned result IS re-fetchable in the sense F5's rule needs, and `annotate` is
   blocked on THIS decision alone, not on missing substrate. If the answer is "only a
   handle", the handle T5.3 would write already exists in prose; if it is "keep the text",
   someone has to decide where it is kept, because today the envelope replaces it.**
3. **Whether `outcome` is derived from `isError` on read for legacy transcripts.** T1's
   answer IS "absent means `completed`", and it is now the code's answer as well
   (`src/core/tool-outcome.ts` `toolOutcomeOf`, pinned by `src/core/tool-outcome.test.ts` and
   by the pre-outcome restore case in `src/harness.snapshot.test.ts`): nothing string-matches
   the failure prose, and `isError` is derived FROM the outcome, never the reverse. What
   remains is a data question, not an implementation one — a distribution with important old
   sessions may still prefer "absent means unknown", which would add a fourth state rather
   than change a reader. Marked **unconfirmed** until a real corpus is inspected; T0 Q3's
   "never touch a unit with no committed result" plus the superseding-success requirement are
   what keep the chosen reading safe in the meantime.
4. **The fingerprint's treatment of tools whose arguments legitimately vary while doing the
   same work** (a `read` with a different `offset`, a paged `threadRead`). T2.4 says
   exact-match for now; a per-tool normalization hook is the alternative and is not free.
5. **Where the policy lives** — **CLOSED 2026-11-09: inside the shipped built-in.** The
   decision took itself, in the direction the entry recommended: `executeCompaction` is the
   writer and the pipeline's priority/composition work turned out not to be a prerequisite,
   because the prune is a flag write inside the one round the guard already owns (no second
   `turn.before` handler, no ordering question, no extra async boundary). The composition
   option is not lost — a host still replaces the built-in in-process, and the policy is
   importable (`planContextPruning` from `src/core`) — it simply is not needed yet.

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

**Status 2026-11-09 — conditions 1, 2 AND 4 have fired, all of them by this entry's own
work, and the probes below are the ones that now answer them.** A fingerprint helper
(`src/core/argument-fingerprint.ts`) and a persisted outcome (T1) exist, and
`executeCompaction` is no longer blank (T3/T4), so F1 is `corrected`, T1–T4 are `LANDED`,
and **so are T5.1, T5.2 and T5.4** (the spill envelope, the aggregate per-turn budget and
the anchored estimate — see *T5 — LANDED*). What is left in this file is T5.3 (elision,
blocked on a decision rather than on code), T6 (the summary checkpoint) and the
worker-lane case of T7. Condition 3 has not fired (`HarnessToolCall` is still
`{id, name, arguments}`, so Q4's unit-level choice still stands); nor has 5 — issue 0004
still owns overflow recovery, and this stage only made the estimate that guard will want
more honest.

**UPDATE 2026-11-09 (later same day): the last of those three open items closed.** The
pipeline entry's T4 landed after this note was written and pinned the worker-lane
durability case on a real `threadExecution: 'worker'` session — see the dated UPDATE
under T7 for what the lane suites now prove, and for the one bound that stays open (a
host plugin cannot yet run inside a replica, which is that entry's T4.4). What is left in
this file is T5.3 and T6.

Condition 4 ("the result budget changed — aggregate guard added") is now the one to read
FIRST before touching F6's numbers: the guard landed, the per-result constant did not.

Two practical notes for the next pass, because the tree has moved since `44cdbbe`: the greps
are still the right probes, but the LINE NUMBERS cited throughout this file are not — re-solve
them by identifier, and read the `**LANDED**`/`**CORRECTED**` notes first: they carry the
current anchors. The probes that now answer "has this been done?":

```bash
grep -n "planContextPruning\|resolvesPrunedFailure" src/core/context-pruning.ts   # T3 policy
grep -n "MAX_UNITS_PER_PASS\|COMPACTION_MODES\|MIN_TOKENS_DEFAULT" src/plugins/context-compaction.plugin.ts
grep -n "roundWritesToReport\|reportCanonicalWrite" src/harness.ts                # T4.4 coalescing
grep -n "api.settings.boolean('enabled'" src/plugins/context-compaction.plugin.ts # branch/enabled rules
grep -n "context.branchId" src/plugins/context-compaction.plugin.ts               # the branch skip
grep -n "policy'" src/types/index.ts | head                                       # T4.5 report kind
grep -n "MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES\|createToolResultTurnBudget" src/core/result-budget.ts src/harness.ts  # T5.2
grep -n "NOTE_KEY\|TAIL_KEY\|HEAD_PREVIEW_RATIO" src/core/result-budget.ts        # T5.1 envelope
grep -n "anchorFromUsage\|estimateContextTokensHybrid\|transcriptChars" src/core/context-estimate.ts src/harness.ts     # T5.4
grep -n "tokenAnchor\|pendingRequestChars\|turnResultBudget" src/harness.ts       # the run-level wiring
```

The `outcome` grep on `src/types/index.ts` returns the persisted field as well as the event
fields, which is the difference condition 2 asks about.

## Not tested

- **Docs-only entry: superseded 2026-11-09 for the parts that landed.** The suite has now
  been measured on this tree, twice, by hand: `npm test` before the first edit was
  **3047 passed / 2 skipped across 176 files**, and after T1 + T2's export + their tests it is
  **3067 passed / 2 skipped across 177 files** (logs in this session's scratch
  `Temp/g5/`; `npm test` = `tools:manifest:check` + `plugins:manifest:check` + `vitest run`).
  `npm run typecheck` is clean and `node scripts/generate-harness-contract.mjs --check`
  reports the generated contract current. Still a static count, still not measured here: the
  `src/harness.inclusion.test.ts` `it()` blocks.
- **What the landed substrate is NOT tested against.** A real `state.json` from an older
  build — the pre-outcome case is exercised with a synthesized document, not a file from
  disk; the `tool.after` hook payload, deliberately left alone and therefore not
  re-exercised; and any transport other than the OpenAI-compatible one, which is the only
  place the "provider payload unchanged" claim was pinned. The two pre-existing
  `npm run test:package:tools` failures in this tree belong to another entry and were not
  touched. And `npm run typecheck` excludes `**/*.test.ts`, so the new assertions were
  type-checked separately with a scratch config that re-includes the suite
  (`Temp/g4b/tsconfig.tests.json`): the same 458 pre-existing errors as before the change,
  none attributable to this work.
- **What T3/T4 DID run** (measured 2026-11-09, this package as the working tree stands):
  `npm test` → 178 files, **3110 passed / 2 skipped**, exit 0; `npm run typecheck` → 0 errors
  with `tools:manifest:check` (30 descriptors) and `plugins:manifest:check` (2 plugins) both
  current; `npm run test:frontend` → 138 files, **1813 passed**, exit 0 (run because the plugin
  METADATA changed and the UI renders that catalogue; nothing in the frontend needed an edit,
  which is what a type-only settings addition should look like); the tests-included probe → the
  same 458 pre-existing errors. `npm run test:package:tools` still fails its two known checks
  (`scripted model registers and invokes a tool without a discovery round`, and the
  strict-identical-harness check with a `0 !== 1` count) — both pre-date this entry, neither is
  a shape diff, and neither was touched.
- **What T3/T4 did NOT measure.** Four things the landing deliberately leaves as reasoned
  decisions rather than results: (a) the **worker lane** — the coalesced per-round
  `agent_message` is a library-side flush (`closeRoundObservations`), and no lane run was
  observed writing a pruned flag, so the durability claim on a replica is still inherited from
  [2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) T4 and not proven
  here; (b) the **operator-visible end of the diagnostic channel** — `api.report.diagnostic`
  reaches an in-process host, but the server installs no `diagnostic` sink and
  `HarnessPresetReport` carries no field for one, so on the durable plane a pass report has
  nowhere to go yet (the persistence test supplies its own sink to prove the plumbing that
  exists); (c) the **`mode` fallback**, which is a documented degradation, not a validated
  operator choice — an operator who stores `annotate` gets `exclude` plus a report naming
  both; and (d) **how much a pass actually saves in production**, since the reported token
  counts come from the ~4 chars/token estimator, not from provider `usage`. **(Narrowed by
  T5.4: once a request has reported `usage`, the number the floor and the limit are compared
  against IS the provider's count for the prefix — but a pass's own saving is still measured
  as a difference of the estimate, and no real provider was observed. See the next bullet.)**
- **What T5.1/T5.2/T5.4 ran, and the four things they did NOT measure.** Run, on this
  working tree: the T5 focused list **102 passed → 127 passed** (5 files, before/after;
  +13 in `src/core/result-budget.test.ts`, +12 in `src/core/context-estimate.test.ts`);
  `npm test` → **175 files, 3035 passed / 2 skipped, exit 0** (the pre-edit state was
  3004 passed / 2 skipped, so the whole delta is the 31 new cases above plus the 6 in
  `src/harness.budget.test.ts`, and nothing else moved); `npm run typecheck` → clean, with
  `tools:manifest:check` (31 descriptors) and `plugins:manifest:check` (2 plugins) both
  current; `npm run test:frontend` → **138 files, 1813 passed, exit 0** (run because the
  plugin's setting TEXT changed and the UI renders that catalogue; three pins learned the
  new sentences, no frontend source did); and the tests-included probe (`npm run typecheck`
  excludes `**/*.test.ts`, so a scratch config that re-includes the suite —
  `Temp/g5b/tsconfig.tests.json` — was run over `src/**`): **467 errors tree-wide, exactly
  one of them in a file this landing touched** — `src/core/context-estimate.test.ts:131`,
  the PRE-EXISTING hostile-shape case whose line number merely moved (its `hostile` array
  infers `role: string`, and that assertion predates this change). The other case the first
  probe pass found was real and is fixed in source, not silenced: `ToolResultSource.name`
  was required while `sourcePhrase` had always supported an id-only or name-only address, so
  the id-only pin was a type error. No other error is attributable to this work. Six
  existing expectations had to learn the new
  shapes, which is the feature and not a regression: two envelope assertions in
  `src/harness.budget.test.ts`, one parsed-key assertion in `src/server/api.test.ts`, and
  five descriptor strings (`src/plugin/manifest.test.ts`, `src/harness.plugin.test.ts`,
  `src/frontend/plugins-tab.test.ts`). Still unmeasured:
  **(a) any real provider.** Every anchor number here comes from a scripted `usage` frame.
  What "prompt tokens for this prefix" MEANS is pinned only for the OpenAI-compatible
  parser (`src/transport/openai.test.ts`, where `input` is `prompt_tokens` including a
  replayed cache prefix — the guard rail this task leans on), and `HarnessUsage.cached` is
  still fed into nothing, so a provider that reports the uncached part alone could anchor
  low; the one-sided sanity band catches that only when the gap is worse than 4x.
  **(b) the per-run scope.** The anchor lives on `RunState`, so a host that starts one run
  per message never anchors and a restart always starts on the heuristic. That is a
  deliberate blast-radius choice, not a measured one: nothing here says how many real
  conversations are one-run-per-message.
  **(c) the UI/plugin divergence.** The context bar is still pure `chars / 4`
  (`src/frontend/ui/turns.ts`), so from the first reported request the bar and the plugin's
  trigger can disagree — now stated in both setting descriptors, never quantified, and not
  reconciled (the bar has no access to a provider count on the client side).
  **(d) the tuning.** 512 KiB per turn, the 2x relationship to the per-result cap, the
  512-byte spill floor and the 3/4-1/4 preview split are arithmetic on the existing cap and
  the shape of a log, not a corpus study: nothing measured how often a real turn trips
  512 KiB, whether a spilled third result makes a model re-run the call the note names
  (the note is model-facing prose whose EFFECT is unobserved — no live session), or how far
  a note-only envelope (the sub-~250-byte-budget edge, exercised only at a 0-byte budget)
  ever occurs in practice. The worker lane also never saw one: a spill is committed
  canonical TEXT, so it rides `transcript:patch` like any result, but no lane run was
  observed carrying one.
- **A durable preset conversation re-seeds on restart.** Observed while landing T4 and worth
  recording because it changes what "idempotent across a restart" can mean at the server plane:
  a preset's own `messages` are applied again when the harness is rebuilt, so the *running*
  conversation starts from the un-pruned seed and the pass re-derives the same plan, while the
  *stored* document never lost the flags. The test asserts both halves rather than assuming the
  one it wanted.
- **Frontier-model behaviour in this harness.** Every behavioural claim in *Why this policy*
  is cited from another system's evaluation. Nothing measured what **this** harness's
  configured model does when an answered failure is withheld.
- **The actual prompt-cache cost of a mid-history flag change** with the configured
  provider — Q5's batching rule, the `minTokens` floor's value (200), and the 8-unit bound are
  all reasoned from vendor guidance and arithmetic on the estimator, not from a measured hit
  rate here (`HarnessUsage.cached`, `src/types/index.ts:254-267`, is never fed back into
  the estimate, F6). What IS measured is the notification count (one per round, not one per
  write) and the token delta the estimator reports.
- **Per-call partial exclusion** (Q4) — never exercised; the transport always sends every
  call of a block (`src/transport/openai.ts:305-308`).
- **Worker-mode durability of a plugin write** — asserted from
  `src/types/index.ts:3493-3502` and `src/server/workers/lane-worker-loop.ts:632-648`, and
  owned by the pipeline entry's T4; no lane run was observed.
  **CLOSED for the mechanism 2026-11-09 by that entry's T4 lane suites** (derivation,
  authority replay on a real harness, and the durable `state.json` round trip on a real
  worker session — see the UPDATE under T7); still unobserved: the built-in compactor's own
  pass RUNNING on a replica, which is the pipeline's T4.4 (a host plugin cannot cross
  `worker_threads` today).
- **Full-summary quality** (T6) — untested by design: this stage does not write a summary.
- **Whether pruning changes the agent's *behaviour* favourably** on a real long task. The
  cost argument is arithmetic; the quality argument is borrowed from the citations, and the
  changelog evidence in F5 says the failure mode (thrash, lost constraints) is real. T3's
  horizon and floor exist because that risk is not measured here.

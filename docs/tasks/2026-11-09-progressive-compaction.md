# Progressive compaction — prune what a later success already answered

Status: **trimmed 2026-11-09 — the stage landed, and per the task-log rule everything that
landed has been REMOVED from this file rather than left as a done-marker.** **Updated
2026-11-10: T6 landed too**, as the `summarize` mode of the same plugin (now the default),
and its shipped shape differs from the design text below — see the note on the T6 section.
What is left is the remaining work plus the decisions that gate it: **T5.3** — tool-result
elision for superseded LARGE results (the `annotate` writer), blocked on Open decisions 2 and
on nothing else; and **T7's residue** — real-corpus and live-provider observations only.
**T5.5** (provider overflow recovery) belongs to
[../issues/minor-context-window-and-token-budget.md](../issues/minor-context-window-and-token-budget.md)
and stays here as a pointer, not a task. The roadmap anchor is `knowledge.md:4345`
("Not built yet"), item 2 at `:4350-4369`, which now names the THIRD writer and the storage
question that blocks T5.3 (the T5.3 clause itself at `:4363-4366`) — no longer the checkpoint,
which shipped. The original framing still holds — a persisted tool outcome and a canonical
argument fingerprint are what any further policy stands on, and both are shipped.

Line numbers describe the working tree reviewed on 2026-11-09. Names are the durable anchors
and the *drift check* near the end lists the commands to re-verify the numbers.
**Update 2026-11-11:** T5.3, T5.5 and T7 are still open, so every anchor inside their sections and
in the substrate table has been re-pointed to the tree as it stands on that date; where a claim the
anchor carried has been overtaken by the `summarize` writer it is restated with the date, and the
two corrections inside the landed T6 record are marked `corrected` with their originals kept.

Companion entries:
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) (what a plugin **may
do**; this entry is the first policy that should do it),
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md) (the
exclusion primitive's own edges), and the budget/overflow gaps tracked once in
[../issues/minor-context-window-and-token-budget.md](../issues/minor-context-window-and-token-budget.md)
— linked, never duplicated here.

## Date / Method / Scope

**Date:** 2026-11-09 (re-reviewed and trimmed the same day).

**Method:** a static audit of the compaction seam (the shipped plugin, the outcome
classification, the estimator, the result budget, the id/argument rules), plus a
literature/vendor pass for the policy questions the code cannot answer — what is safe to
drop, what a model does with a dropped failure, what compaction costs a prompt cache. Those
sources are listed under *References*, whose **citation note** states how they were retrieved
and why no claim here may be cited to a scratch path. No live session and no live provider
were used: that is precisely what the remaining T7 list still owes.

**Scope:** the **pruning** half of compaction — deciding which already-committed transcript
units stop being sent to the model — and the elision and summarization steps that would build
on that decision.

**Out of scope (explicitly, so nobody "fixes" it here):** provider-overflow classification and
pre-request token guarding (issue 0004); the plugin framework's decision/wildcard/priority
work ([2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md)); and the
per-result cap's 256 KiB constant (`MODEL_TOOL_RESULT_BUDGET_BYTES`,
`src/core/result-budget.ts:79`) — the shipped stage changed the envelope's shape and added a
per-turn aggregate beside it, not that number.

## Requirements the remaining work must satisfy

Carried over verbatim in substance from the stage's own brief, narrowed to the clauses the
open items trade against:

- **R2 — pruning is the first policy, summarization is not.** The narrow, reversible, cheap
  win is stopping a tool unit that a later successful call of the same work already answered.
  The structured-summary checkpoint is T6.
- **R3 — context control never deletes.** A pruned unit stays in canonical history and can be
  re-enabled; the mechanism is the `included` flag (`src/types/index.ts`, the four
  `HarnessMessage` variants and `HarnessContextEntry`/`setIncluded`).
- **R5 — a healthy control outcome is not garbage.** `cancelled` is an expected outcome, not a
  failure (`HarnessToolOutcome`, `src/types/index.ts`), and the most recent unresolved failure
  is the highest-signal thing in the window — so recency bounds what may be pruned.
- **R6 — safe and cheap in the same breath:** idempotent, pairing-preserving, bounded in blast
  radius (minimum savings, tail horizon, per-pass unit bound), and observable (a diagnostic
  naming what it dropped and why).

## The substrate the remaining work stands on

The findings and the landed tasks were removed; these are the anchors the open items quote,
inlined so this file stays self-contained.

| Fact | Where |
|---|---|
| `executeCompaction` is the shipped `exclude` writer: it prunes superseded tool failures and **only** calls `context.setIncluded` — no summarizer, no `replaceHistory` (the `summarize` machine is a separate one, `createContextCompactionPasses`) | `src/plugins/context-compaction.plugin.ts:743-856`; the single flag write is `setIncluded(entry, false)` at `:825` |
| `COMPACTION_MODES` ships **two** writers, `summarize` (the default) and `exclude` — re-pointed 2026-11-11, this row used to read "implements `exclude` alone"; `annotate` is declared in the setting's UI text and deliberately NOT in the list, so it degrades | `:471` (the list), `:466-470` (why `annotate` stays out), `:428` (the descriptor text), `:758-768` (the fallback, and why it is `exclude` and not the default) — pinned by `src/plugin/context-compaction.test.ts:1679-1697` (`degrades an unimplemented mode to exclude and reports both`, exact `mode exclude, setting mode annotate`) |
| The candidate list is computed BEFORE anything is written, so an `annotate` mode later is a second **writer** over the same plan, not a second policy | `src/core/context-pruning.ts:12` (the seam, stated in the header), `:102` (`UnitClass` — "a future `annotate` writer needs the same vocabulary"), `:169` (`PrunePlan.candidates`) |
| The "re-fetchable" condition the pruning rule requires is spelled to the model at write time: an over-cap result is a head/tail envelope whose `note` names the call to re-run | `src/core/result-budget.ts:37` (the rule), `:219` (the note), `boundToolResult` `:308`; the per-turn aggregate is `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES = 512 KiB` at `:94`, applied by `createToolResultTurnBudget` `:358` |
| The full text of a spilled result lives nowhere addressable — the envelope REPLACES it in the committed message, so re-running is the only way back | `src/core/result-budget.ts:37` (the header states this honest limit) and the note text at `:219` |
| A branch round never prunes (guard and action both check `branchId`), which is why the cooldown map holds one live key per conversation | `src/plugins/context-compaction.plugin.ts:751` (action), `:1389` (guard), explained at `:32-43` (branch skip) and `:275` (why the cooldown map is never pruned) |
| `replaceHistory()` exists as framework surface — the checkpoint T6 would use (re-pointed 2026-11-11: T6 has since landed and DOES call it, see the T6 section) | `src/types/index.ts:4346` (`HarnessTurnBeforeContext.replaceHistory`) |
| The persisted tool outcome, its absent-means-`completed` rule, and the fingerprint the policy compares | `src/core/tool-outcome.ts:90-92` (`toolOutcomeOf`), `src/core/argument-fingerprint.ts:171` (`toolCallFingerprint`) |

## Tasks

### T5.3 — Tool-result elision for superseded LARGE results (the `annotate` writer)

The `annotate` half of the `mode` setting, applied to *large* results, not only to failures.
This is the trade opencode's `keep.tokens` knob exists to make — its default and its settings
table are in `services/site/src/docs/content/compaction.mdx` at rev `caf8d6a` (*References*).

- **What is still open.** The writer. `COMPACTION_MODES` now ships two writers, `summarize` and
  `exclude` — re-pointed 2026-11-11, this bullet used to read "lists `exclude` only" — and
  `annotate` is still deliberately unlisted (`src/plugins/context-compaction.plugin.ts:471`, the
  omission and its report rule spelled out at `:466-470`), so an operator who stores it gets
  `exclude` plus a report naming both (the fallback at `:758-768`, pinned at
  `src/plugin/context-compaction.test.ts:1679-1697`) — a documented degradation, not a
  validated operator choice.
- **What it does NOT wait on.** Substrate. The candidate list is already computed before any
  write (`src/core/context-pruning.ts:12`, `:102`), the mode setting already exists, and the
  "re-fetchable" condition is already spelled to the model at write time (the spill envelope
  names the call to re-run, `src/core/result-budget.ts:37`/`:219`).
- **What it DOES wait on.** Open decisions 2: does an annotated result keep its original text
  in the message (reversible, costs the bytes it was meant to save) or only a handle (cheap,
  and the handle has to address something)? There is no addressable store for a tool result's
  full text in this tree, so "only a handle" means re-running the call — a different promise
  from a re-READ — and "keep the text" means deciding where it is kept, because today the
  envelope replaces it. Answering this is a contract change (storage, retention, possibly a
  read-back tool), not a policy knob.

*Check:* `annotate` appears in `COMPACTION_MODES` and a focused run of
`npx vitest run src/plugin/context-compaction.test.ts src/core/result-budget.test.ts` shows an
over-cap, superseded result arriving as a handle (or an annotated copy) rather than as an
excluded unit, with the pass diagnostic reporting the mode it actually used — and the
degradation case at `src/plugin/context-compaction.test.ts:1679-1697` updated to match whatever
the decision was.

### T5.5 — Provider overflow recovery (pointer, not a task)

Recognizing "input too long", compacting, and retrying is
[../issues/minor-context-window-and-token-budget.md](../issues/minor-context-window-and-token-budget.md)'s.
It was not touched by this stage and is not work this file owns; the only thing this stage
contributed to it is a more honest estimate to guard against.

*Check:* the one in issue 0004.

### T6 — The full checkpoint — **built 2026-11-10 as `mode: 'summarize'`**

Recorded so the design survives: a summarize-and-reinitialize pass would use
`replaceHistory()` (`src/types/index.ts:4346`; the implementation throws when the run has no
persistent conversation, `src/harness.ts:9181-9185`) with

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
   everything including the prompt the run just appended — the shipped action's own header
   states this rule and is why that action deliberately stays inside `setIncluded`
   (`src/plugins/context-compaction.plugin.ts:739-742`; re-pointed 2026-11-11, and the rule is
   honoured by the `summarize` finalize, which re-states the whole transcript).

**What a stage opening on this needs to know** — the paragraph as written 2026-11-09, kept
verbatim: *"`executeCompaction` today only calls `context.setIncluded`
(`src/plugins/context-compaction.plugin.ts:295-402`) and never calls a model; `replaceHistory` is
framework surface with no compaction caller (`src/types/index.ts:3983`); and the shipped
trigger/cooldown/pause machinery is inherited unchanged by whatever fills the action, which is why
a checkpoint can be added beside the pruner rather than instead of it."* **Corrected 2026-11-11 —
the middle clause is false**: `replaceHistory` now HAS a compaction caller. The `summarize`
finalize calls `context.replaceHistory([...])` at `src/plugins/context-compaction.plugin.ts:1181`
to append the instruction, `context.setTranscript` at `:1191` for the in-flight request, and
`api.threads.send(threadId, CONTINUATION_NUDGE)` at `:1529`; the entry's own drift check is the
grep that shows it. The two clauses that still hold are the load-bearing ones: the `exclude` writer
is `setIncluded`-only (`:743-856`, its single flag write at `:825`), and the shipped
trigger/cooldown/pause machinery is still what the checkpoint rides on — the summarize machine is
built beside the pruner, exactly as this paragraph predicted.

**What shipped on 2026-11-10, and where it departs from the text above.** The checkpoint
exists as the plugin's `summarize` mode — the default — in
`src/plugins/context-compaction.plugin.ts`, and it is the *conversation* that performs it:

- the pass parks the thread at the turn boundary, commits one `user` turn whose first line is
  the marker `[context compaction]` into the canonical transcript (`replaceHistory` **and**
  `setTranscript`, because the committed history and the in-flight request are two different
  writes), and lets this same agent's next model turn answer it — so no helper model is
  called and the point above about "no compaction caller" is what closed this item;
- the summary replaces the whole earlier region by *withholding* it, not by rewriting it: the
  retained head is the instruction plus the agent's own answer, and everything before the
  instruction (plus any turn the model spent on tools after it) keeps its place in canonical
  history with `included: false`. `replaceHistory` is used only to append the instruction, so
  nothing is ever destroyed and a pass stays switchable back on;
- **design point 2 (a verbatim recent tail sized by a setting) did not ship.** The tail is
  whatever the agent decided to write down, which is the whole bet of the design — a summary
  written by the model that has to live with it. `safetyTurns` belongs to `exclude` mode only;
- **design point 3 (a constraint registry kept out of the summarized region) did not ship
  either**: the instruction asks for DONE / CURRENT TASK / PENDING, and the side constraints
  survive only if the agent writes them. That is the open risk the T7 list now carries;
- design point 4 (head-anchored, cache-aware) shipped as *one* replacement per crossing,
  behind the existing cooldown and its 5%-of-limit regrowth margin; design point 5 (re-state
  the newest turn) is why the commit re-states the whole transcript rather than a slice.

The machine spans five hooks (`turn.before` trigger, `turn.after` recognises the answer,
`thread.idle` writes the range when the run ended on it, `run.finished`/`run.failed` are the
nets that never leave a thread parked), and the flow is pinned end to end in
`src/plugin/context-compaction.test.ts` under `context-compaction summarize flow (T9)`.

*Check:* `mode: 'summarize'` is the declared default, and `annotate` is still absent from
`COMPACTION_MODES` — T5.3 remains the only unbuilt writer here. `knowledge.md` "Not built yet",
item 2 now names the third writer and its storage question, not the checkpoint.

### T7 — Observations still owed (real corpus, live provider)

The stage's test list is pinned; what is left here is measurement, not implementation.

- **No real provider observed for the hybrid anchor.** Every anchor number is from a scripted
  `usage` frame; `HarnessUsage.cached` feeds nothing, so a provider that reports the uncached
  part alone could anchor low, and the one-sided sanity band catches that only past 4x.
- **No real pre-outcome `state.json`.** The pre-outcome restore case uses a synthesized
  document, so Open decisions 3 stays a data question until a real corpus is inspected.
- **Prompt-cache cost, the `minTokens` floor's value, and the per-pass unit bound are
  unmeasured**; so is the 512 KiB per-turn aggregate and the 3/4-1/4 preview split — arithmetic
  on the existing cap and the shape of a log, not a corpus study.
- **The UI context bar and the plugin estimator can disagree, and the divergence is
  unquantified.** The bar is still pure `chars / 4` (`src/core/context-estimate.ts:17-19`
  states the shared convention; `src/frontend/ui/turns.ts` renders it) while the plugin's
  trigger may be anchored on provider `usage`; the setting descriptors say so, nothing measures
  how often it matters. Clarified 2026-11-11: the divergence is between the bar's SEGMENTS and
  the plugin's anchor, not between every figure on screen — the tile's headline context figure is
  already the provider's own `usage.input` for the latest root-scope request, not the estimate
  (`src/frontend/ui/turns.ts:4003-4032` states that scoping rule and its reversal), so the
  estimate-vs-usage gap only shows in the `chars / 4` bar and its percentages. Surfacing that is
  the companion entry's T7.
- **Whether pruning changes agent behaviour favourably on a real long task.** The cost
  argument is arithmetic; the quality argument is borrowed from *References*, and the changelog
  evidence there says the failure mode (thrash, lost constraints) is real.

## Open decisions

1 and 5 closed with the landed work and were removed; the numbering below is kept because
`knowledge.md:4366` cites "Open decisions 2".

2. **Annotate vs exclude**: whether an annotated result keeps the original text in the message
   (reversible, costs bytes) or only a handle (cheap, needs a re-read path). Not decided, and
   still unbuilt — but the seam is real rather than promised: `exclude` is one writer over the
   pre-computed candidate list (`src/core/context-pruning.ts:12`, `:102`), and `mode` is a declared
   setting that now implements TWO values — `summarize` (the default) and `exclude`
   (`src/plugins/context-compaction.plugin.ts:471`, re-pointed 2026-11-11; this clause used to read
   "whose only implemented value is `exclude`") — with `annotate` still the deliberately unlisted
   third. A third value needs a new writer beside `executeCompaction` and beside the summarize
   machine (`createContextCompactionPasses`, `:1003`), not a new policy. The shipped spill envelope answers "where does the full text
   live?" with the cheapest honest address there is — the call that made it
   (`re-run tool 'read' (call c1) with narrower arguments`, `src/core/result-budget.ts:219`),
   not a stored copy. So a pruned result IS re-fetchable in the sense the pruning rule needs,
   and `annotate` is blocked on THIS decision alone. If the answer is "only a handle", the
   handle T5.3 would write already exists in prose; if it is "keep the text", someone has to
   decide where it is kept, because today the envelope replaces it. **Gates T5.3.**
3. **Whether `outcome` is derived from `isError` on read for legacy transcripts.** The answer
   in force is "absent means `completed`", and it is the code's answer
   (`toolOutcomeOf`, `src/core/tool-outcome.ts:90-92`); nothing string-matches the failure
   prose, and `isError` is derived FROM the outcome, never the reverse. There is deliberately
   **no** text bridge: a reader that re-derives an outcome from result prose is refused, and
   the snapshot reader states that as a migration decision rather than a fallback
   (`src/core/snapshot.ts:280`). What remains is a data question — a distribution with
   important old sessions may still prefer "absent means unknown", which would add a fourth
   state rather than change a reader. Marked **unconfirmed** until a real corpus is inspected
   (T7).
4. **The fingerprint's treatment of tools whose arguments legitimately vary while doing the
   same work** (a `read` with a different `offset`, a paged `threadRead`). The landed rule is
   exact match (`toolCallFingerprint`, `src/core/argument-fingerprint.ts:171`, consumed through
   the rule's own `keyOf` at `src/core/context-pruning.ts:180` — re-pointed 2026-11-11, where the
   old `:285` sits is now the comment stating the same rule, `:283`); a per-tool normalization
   hook is the alternative and is not free.

## Why this policy

The short argument, then the citations.

1. **Prune "resolved + old + large + re-fetchable", not "invalid".** Structure (`outcome`,
   fingerprint, position from the end, byte size) is knowable exactly; "invalid" is a reading
   of prose.
2. **Keep the failures that still have no answer.** The retry-loop evidence (PruneTIR;
   Feedback That Backfires) says an agent that cannot see its own recent failure repeats it.
   R5 encodes that as a horizon.
3. **Prefer masking to summarizing until the summary is provably safe.** The Complexity Trap
   result (masking ≈ summarization, at lower cost and risk) plus 17% side-constraint retention
   (Lost in Context Compaction) plus the vendor bug history is an argument for doing the
   reversible thing first. The `included` flag **is** that reversible thing, and unlike a
   summary it keeps the original recoverable — the same distinction the vendor docs draw
   between masking (a marker + a handle back) and summarizing (prose with no way back). This
   is the argument T5.3 and T6 are held against.
4. **Treat `cancelled` as healthy.** The package's own contract, and a policy that prunes it
   deletes evidence the agent chose to stop.
5. **Compaction is a cost lever and a cache lever at once.** The savings are real (Anthropic's
   context-management numbers, **vendor**: an 84% token reduction on a 100-turn web-search
   evaluation) and so is the churn risk (Claude Code's repair history; dsh's pruner runs
   **before** range selection so a pass can avoid a summary call at all).

### References

Vendor (first-party product documentation) unless marked **preprint**.

**Citation note:** the competitor entries were read on 2026-11-08 from repository clones under
the repo-root `Temp/` scratch directory, which is disposable and git-ignored. Therefore **no
citation in this document is to a `Temp/` path**: the upstream repository path and the
revision-pinned upstream URL below are the canonical form, and the local line numbers read
from those clones are not quoted.

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
models and provider mix — nothing here was measured locally (see *Not tested*), and the arXiv
numbers (17% retention, 84% token cut, masking≈summarization) come from their own evaluation
setups, not from `@underload/harness`.

## Verify before starting — drift check

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'
grep -n "replaceHistory" src/plugins/context-compaction.plugin.ts     # T6: BUILT — the commit that appends the instruction
grep -n "COMPACTION_MODES" src/plugins/context-compaction.plugin.ts   # T5.3: is `annotate` listed yet?
grep -n "annotate" src/plugins/context-compaction.plugin.ts           # still a documented degradation?
grep -n "candidates" src/core/context-pruning.ts                      # the seam an `annotate` writer plugs into
grep -rn "MODE_DEFAULT" src/plugins/context-compaction.plugin.ts      # which writer a fresh install gets
sed -n '4345,4370p' knowledge.md           # roadmap entry still names the third writer, not the checkpoint?
npm run plugins:manifest:check             # BASELINE green before any edit
```

Stop-and-recheck conditions:

1. **`annotate` is listed in `COMPACTION_MODES`** — T5.3 is done; Open decisions 2 has been
   answered, and what is left here is the observation list.
2. **A second `replaceHistory` caller appears in the plugin** (anything beyond the summarize
   commit's "re-state the transcript, append the instruction") — a rewrite-style checkpoint has
   opened, and the design text above is the spec it should be measured against, not
   re-invented.
3. **A provider-overflow classifier appeared** — issue 0004 has moved; re-read it before
   touching T5.5.
4. **The result budget gained an addressable store for full text** — the cheap answer to
   Open decisions 2 exists, which changes what "only a handle" costs.

## Not tested

- **Anything in the T7 list above** — no real provider, no real corpus, no live session. Every
  number the open items quote is from a scripted frame or from arithmetic.
- **Frontier-model behaviour in this harness.** Every behavioural claim in *Why this policy* is
  cited from another system's evaluation. Nothing measured what **this** harness's configured
  model does when an answered failure is withheld, or whether it acts on the spill note that
  names the call to re-run.
- **Summary QUALITY, now that a summary is actually written** (T6, `mode: summarize`). The
  plumbing is pinned end to end — park, instruction, answer, withheld range, resume, nudge —
  against scripted transports, which always answer with `SUMMARY`. What has never been
  measured is whether a real model's summary preserves enough of the dropped conversation to
  continue the task: the design's own risk (no verbatim tail, no constraint registry) lives
  exactly there.
- **The `mode` fallback as an operator choice.** The degradation is pinned as behaviour; nobody
  has asked whether an operator who stores `annotate` should get a refusal instead.
- **Per-call partial exclusion** — never exercised; the transport always sends every call of a
  block, and the unit-level rule is what keeps provider pairing unbreakable.

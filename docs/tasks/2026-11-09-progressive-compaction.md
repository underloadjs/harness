# Progressive compaction — prune what a later success already answered

Status: **trimmed 2026-11-09 — the stage landed, and per the task-log rule everything that
landed has been REMOVED from this file rather than left as a done-marker.** What is left is
the remaining work plus the decisions that gate it: **T5.3** — tool-result elision for
superseded LARGE results (the `annotate` writer), blocked on Open decisions 2 and on nothing
else; **T6** — the summarize-and-reinitialize checkpoint, deliberately unbuilt, whose design
text is kept below because it IS the design for that work; and **T7's residue** — real-corpus
and live-provider observations only. **T5.5** (provider overflow recovery) belongs to
[../issues/minor-context-window-and-token-budget.md](../issues/minor-context-window-and-token-budget.md)
and stays here as a pointer, not a task. The roadmap anchor is `knowledge.md:3861`
("Not built yet"), item 2 at `:3866-3882`, which names both T6 and the storage question that
blocks T5.3. The original framing still holds — a persisted tool outcome and a canonical
argument fingerprint are what any further policy stands on, and both are shipped.

Line numbers describe the working tree reviewed on 2026-11-09. Names are the durable anchors
and the *drift check* near the end lists the commands to re-verify the numbers.

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
| `executeCompaction` is the shipped writer: it prunes superseded tool failures and **only** calls `context.setIncluded` — no summarizer, no `replaceHistory` | `src/plugins/context-compaction.plugin.ts:295-402` |
| `COMPACTION_MODES` implements `exclude` alone; `annotate` is declared in the setting's UI text and deliberately NOT in the list, so it degrades | `:222` (the list), `:191` (the descriptor text), `:315` (the fallback) — pinned by `src/plugin/context-compaction.test.ts:1036-1049` (`degrades an unimplemented mode to exclude and reports both`, exact `mode exclude, setting mode annotate`) |
| The candidate list is computed BEFORE anything is written, so an `annotate` mode later is a second **writer** over the same plan, not a second policy | `src/core/context-pruning.ts:12` (the seam, stated in the header), `:101` (`UnitClass` — "a future `annotate` writer needs the same vocabulary"), `:169` (`PrunePlan.candidates`) |
| The "re-fetchable" condition the pruning rule requires is spelled to the model at write time: an over-cap result is a head/tail envelope whose `note` names the call to re-run | `src/core/result-budget.ts:37` (the rule), `:219` (the note), `boundToolResult` `:308`; the per-turn aggregate is `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES = 512 KiB` at `:94`, applied by `createToolResultTurnBudget` `:358` |
| The full text of a spilled result lives nowhere addressable — the envelope REPLACES it in the committed message, so re-running is the only way back | `src/core/result-budget.ts:37` (the header states this honest limit) and the note text at `:219` |
| A branch round never prunes (guard and action both check `branchId`), which is why the cooldown map holds one live key per conversation | `src/plugins/context-compaction.plugin.ts:303` (action), `:460` (guard), explained at `:36-39` and `:84-98` |
| `replaceHistory()` exists as framework surface — the checkpoint T6 would use | `src/types/index.ts:3983` (`HarnessTurnBeforeContext.replaceHistory`) |
| The persisted tool outcome, its absent-means-`completed` rule, and the fingerprint the policy compares | `src/core/tool-outcome.ts:90-92` (`toolOutcomeOf`), `src/core/argument-fingerprint.ts:171` (`toolCallFingerprint`) |

## Tasks

### T5.3 — Tool-result elision for superseded LARGE results (the `annotate` writer)

The `annotate` half of the `mode` setting, applied to *large* results, not only to failures.
This is the trade opencode's `keep.tokens` knob exists to make — its default and its settings
table are in `services/site/src/docs/content/compaction.mdx` at rev `caf8d6a` (*References*).

- **What is still open.** The writer. `COMPACTION_MODES` lists `exclude` only
  (`src/plugins/context-compaction.plugin.ts:222`), and `annotate` is deliberately unlisted so
  an operator who stores it gets `exclude` plus a report naming both (`:315`, pinned at
  `src/plugin/context-compaction.test.ts:1036-1049`) — a documented degradation, not a
  validated operator choice.
- **What it does NOT wait on.** Substrate. The candidate list is already computed before any
  write (`src/core/context-pruning.ts:12`, `:101`), the mode setting already exists, and the
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
degradation case at `src/plugin/context-compaction.test.ts:1036-1049` updated to match whatever
the decision was.

### T5.5 — Provider overflow recovery (pointer, not a task)

Recognizing "input too long", compacting, and retrying is
[../issues/minor-context-window-and-token-budget.md](../issues/minor-context-window-and-token-budget.md)'s.
It was not touched by this stage and is not work this file owns; the only thing this stage
contributed to it is a more honest estimate to guard against.

*Check:* the one in issue 0004.

### T6 — The full checkpoint (explicitly **not** this stage)

Recorded so the design survives: a summarize-and-reinitialize pass would use
`replaceHistory()` (`src/types/index.ts:3983`; the implementation throws when the run has no
persistent conversation, `src/harness.ts:8647-8653`) with

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
   states this rule and is why it deliberately stays inside `setIncluded`
   (`src/plugins/context-compaction.plugin.ts:291-294`).

**What a stage opening on this needs to know:** `executeCompaction` today only calls
`context.setIncluded` (`src/plugins/context-compaction.plugin.ts:295-402`) and never calls a
model; `replaceHistory` is framework surface with no compaction caller
(`src/types/index.ts:3983`); and the shipped trigger/cooldown/pause machinery is inherited
unchanged by whatever fills the action, which is why a checkpoint can be added beside the
pruner rather than instead of it.

*Check:* this stays in this file (and in `knowledge.md:3861` "Not built yet", item 2 at
`:3866-3882`) until a stage opens for it; no other task may quietly grow a summarizer call.

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
  how often it matters. Surfacing that is the companion entry's T7.
- **Whether pruning changes agent behaviour favourably on a real long task.** The cost
  argument is arithmetic; the quality argument is borrowed from *References*, and the changelog
  evidence there says the failure mode (thrash, lost constraints) is real.

## Open decisions

1 and 5 closed with the landed work and were removed; the numbering below is kept because
`knowledge.md:3882` cites "Open decisions 2".

2. **Annotate vs exclude**: whether an annotated result keeps the original text in the message
   (reversible, costs bytes) or only a handle (cheap, needs a re-read path). Not decided, and
   still unbuilt — but the seam is real rather than promised: `exclude` is one writer over the
   pre-computed candidate list (`src/core/context-pruning.ts:12`, `:101`), `mode` is a declared
   setting whose only implemented value is `exclude`
   (`src/plugins/context-compaction.plugin.ts:222`), and a second value needs a new writer
   beside `executeCompaction`, not a new policy. The shipped spill envelope answers "where does the full text
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
   (`src/core/snapshot.ts:253-255`). What remains is a data question — a distribution with
   important old sessions may still prefer "absent means unknown", which would add a fourth
   state rather than change a reader. Marked **unconfirmed** until a real corpus is inspected
   (T7).
4. **The fingerprint's treatment of tools whose arguments legitimately vary while doing the
   same work** (a `read` with a different `offset`, a paged `threadRead`). The landed rule is
   exact match (`toolCallFingerprint`, `src/core/argument-fingerprint.ts:171`, consumed at
   `src/core/context-pruning.ts:285`); a per-tool normalization hook is the alternative and is
   not free.

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
grep -n "COMPACTION_MODES" src/plugins/context-compaction.plugin.ts   # T5.3: is `annotate` listed yet?
grep -n "annotate" src/plugins/context-compaction.plugin.ts           # still a documented degradation?
grep -n "candidates" src/core/context-pruning.ts                      # the seam an `annotate` writer plugs into
grep -n "replaceHistory" src/plugins/context-compaction.plugin.ts     # T6: is a summarizer wired?
grep -rn "summarizer\|compactContext\|summarize" src/plugins/ src/core/context-pruning.ts | grep -v test
sed -n '3861,3882p' knowledge.md           # roadmap entry still says the checkpoint is not built?
npm run plugins:manifest:check             # BASELINE green before any edit
```

Stop-and-recheck conditions:

1. **`annotate` is listed in `COMPACTION_MODES`** — T5.3 is done; Open decisions 2 has been
   answered, and what is left here is T6 plus the observations.
2. **`executeCompaction` (or a replacement) calls `replaceHistory`** — a summarization stage
   has opened; the T6 design text above is the spec it should be measured against, not
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
- **Full-summary quality** (T6) — untested by design: nothing in this tree writes a summary.
- **The `mode` fallback as an operator choice.** The degradation is pinned as behaviour; nobody
  has asked whether an operator who stores `annotate` should get a refusal instead.
- **Per-call partial exclusion** — never exercised; the transport always sends every call of a
  block, and the unit-level rule is what keeps provider pairing unbreakable.

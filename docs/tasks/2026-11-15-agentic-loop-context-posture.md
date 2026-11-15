# Agentic-loop context posture — duplicate trim on, decisions into content, stale poll fixed

**Date:** 2026-11-15
**Method:** post-mortem of live session IT14 (`thread-32`), run 2026-11-14/15 against this
package, delegate-verified twice and spot-checked against source by the operator's agent; every
source claim below was re-anchored to `path:line` in the current tree on 2026-11-15. The IT14
transcript numbers (message counts, character counts, loop sites) are **session-record evidence**,
not reproducible from repo source — they are marked as such wherever they appear.
**Scope:** the trimmer's *duplicate* axis (one default flip), the agent prompts (one shared
guideline line), the `agentResult` ledger's terminal timing (one bounded investigation + fix), and
two hygiene pins (one doc clause, one test). Everything else the post-mortem raised is fenced off
in Part D — read it before touching anything.

---

## Part A — The decision this task implements

### A1 The operator's requirements, verbatim

> - Context should be clean and precise as possible, to prevent context rot or irrelevant
>   content. This is related to efficiency and accuracy in term of speed and turn while
>   producing the most accurate tasks.
> - Context should be small to prevent trigger context compaction unless necessary.

And the standing constraint that shapes every choice below:

> I'm not too worried about what other models will do … there are always workarounds such as
> converting tool turns into purely assistant/user prompt, which keeps the context logical.

Provider replay contracts (DeepSeek/Kimi `reasoning_content` hard 400s, Gemini signatures) are
therefore **not a driver** of this task. A modified turn can be reshaped at the transport to suit
any provider; what cannot be reshaped later is context that rotted or a trajectory that bloated.

### A2 The posture, in three parts

1. **Keep the thinking axis exactly as it ships** — `trimThoughts: true`, `thoughtTurns: 2`,
   model-step ranks, the rank-0 continuity floor
   (`src/plugins/context-trimmer.plugin.ts:783-785`, `planWithheldThoughts` `:1832-1914`,
   `thoughtAgoOf` `:1772-1789`). It is the only axis that reduces context in a
   single-user-message tool loop, which is the workflow shape that matters here.
2. **Turn `dropDuplicateCalls` on** — the one existing axis that removes redundant *successful*
   payloads, which is the actual context rot in this workflow (T1).
3. **Buy the memory back in `content`, not by withholding less** — a shared agent guideline that
   makes the model externalize each tool round's decision into message content, the design
   record's own deferred mechanism (T4). This is what makes part 1 safe: the trimmer keeps
   removing prose, the decisions stop living in prose.

Plus one efficiency defect the post-mortem proved in the same workflow (T5), and two hygiene
items (T2, T3).

### A3 What was rejected, and why — do not re-litigate inside this task

| Rejected | Reason (one line each) |
|---|---|
| The open-turn floor (`entry.index > lastUserIndex → continue`) | In a one-user-message loop it retains ~10⁶ chars of reasoning (IT14: 747 chars at the first turn → 21,403 at turn 358, ×154 steps) — a compaction machine-gun, and compaction is the lossy, slow thing A1's second requirement exists to avoid |
| F1a "never withhold reasoning from a `tool_calls` entry" | Its stated rationale is the provider contract A1 dismisses, and its effect in a tool loop is ≈ the open-turn floor: the axis goes inert |
| A `thoughtScope: 'turn' \| 'steps'` switch | Equal to the open-turn floor in this workflow shape; a new settings dimension that nothing here needs |
| Raising `thoughtTurns` | The measured re-derivations span 12–100+ turns; no horizon covers them, and the horizon that approximates "keep everything" is the open-turn floor again |
| `truncateToolRequests: true` now | Right next lever, but only after a transport can render a kept-result-without-request as a digested line — separate work, explicitly deferred (Part D) |

The deeper point, recorded so it is not rediscovered: the 2026-11-10 design record's E5 rule
("the decision content of an old turn already survives in `content`",
`docs/tasks/2026-11-10-context-trimmer-uplift.md:517-522`) assumed a channel this model does not
use — 93% of IT14's 154 assistant turns have empty `content`. The fix for that is restoring the
contract (decisions into `content`, T4), not disabling the trimmer.

---

## Part B — Findings

### FB — The polarity: the redundancy axis ships off while the memory axis ships on

Under shipped defaults, in a one-user-message tool loop (IT14: 379 messages, 154 assistant turns,
exactly one `user` message), the only things that ever leave the request are: whole
failed-then-answered tool units (`trimInvalidTools`/`dropSupersededToolCalls`, both `true`,
horizon 2) and thinking older than 2 model steps. The one axis that can remove redundant
**successful** payloads — `dropDuplicateCalls`, which the design record calls the largest
redundancy class in a long trajectory (`docs/tasks/2026-11-10-context-trimmer-uplift.md:382`,
`:997`) — ships `false` (`src/plugins/context-trimmer.plugin.ts:792`, descriptor `:667-676`), as
does `truncateToolRequests` (`:788`). Assistant `content`, user messages and `completed` results
are never withheld by any axis.

So the trimmer's shipped polarity in this workflow is: **working memory out, redundant success
in.** The measured cost (session-record evidence, IT14): four re-derivation classes — `toolCreate`
without a `parameters` schema silently dropping caller args (sites 28 → 55 → 60 → 286/295/306 →
329 → 351 → 354 → 356), the C1 record-echo established at 141 and re-derived from scratch at
358–365, the "4001-char" off-by-one chase closing as a non-finding (82/84 → 171–197), and six
zero-delete `sweep` calls (343, 346×4, 366) — each solved earlier and re-solved after the
reasoning that solved it had left the request. Every wasted turn adds an assistant entry, tool
calls and `completed` results, all in the never-trimmed class: per-request context goes down,
trajectory context goes up.

### FC — The design record's own answer for the memory loss: decisions in `content`

`docs/tasks/2026-11-10-context-trimmer-uplift.md:517-522` (E5): "the residue that does not
(scratch ids, paths, hypotheses worth revisiting) belongs in a durable note the **model writes
into `content`**, not in replayed CoT and not in a harness-side summary that spends a request."
The E6 tier table's second row (`:529`) names exactly this mechanism — "one compact decision
record per closed turn, produced free (model-written, not an extra call)" — and was **deferred,
never built**, because the models it was tested against already wrote content. IT14's model
does not. T4 builds it: one shared guideline line, the repo's established mechanism for
model-facing policy (`src/agents/guidelines.ts:1-51` — "A profile composes these with
`agentInstruction()` … so one edit reaches every role that uses the line and the wording cannot
drift").

### FD — `agentResult` answered `running` with an empty body after the child's text existed

Session-record evidence (IT14): 8 polls returned `{"status":"running","content":"","contentLength":0}`
for invocations 50/51 at transcript indices 109, 113, 114, 144, 145, 162, 201, 268 — while both
children's full text was already committed in their transcripts at index 71 (8431 chars) and 72
(8449 chars), and the same ids later returned the identical content as `completed` (indices 200,
311). Cost: 8 wasted turns, 8 empty results.

Source anchors: the explicit-id path returns whatever the one record per id says
(`src/harness.ts:4257-4274`; `invocationRecords` is a `Map` keyed by id, `:3938`); the B2
(2026-11-13) no-id default prefers the newest terminal record and its comment acknowledges "an
explicit `invocationId` still reaches the running record" (`:4282-4290`, `:4303-4306`);
`registerInvocation` files the record as `running` (`:13432`) and `commitRunTerminal` is the only
thing that ever makes it terminal (`:13437-13439`). **The root cause is unverified** — whether the
terminal commit lags the transcript's final text, or the observed record states have another
explanation — which is why T5 is a bounded probe first (the 200-vs-201 index contradiction is
exactly the kind of thing the probe must resolve). Existing `agentResult` test surface:
`src/harness.thread-runtime.test.ts` (e.g. `:1356`, `:1595`, `:1613`, `:1888-1908`).

### FE — `docs/plugins.md` cache clause is inverted

`docs/plugins.md:510-514`: "one model step moves at most one thought out of the request, at a
position **strictly older** than the one the previous step moved." Wrong direction: rank grows as
the transcript grows (`thoughtAgoOf` `:1772-1789`), so the entry crossing the horizon each step is
strictly **newer** — the divergence point advances forward, the cache-friendly case. The
surrounding claims (monotone boundary, one advancing divergence point per step, flags never
un-written) are correct as written.

### FF — The rank-0 floor's newest-entry case is unpinned

The continuity floor exempts the newest assistant entry **in the canonical transcript**
(`planWithheldThoughts` `:1880`, `thoughtAgoOf` counts already-withheld entries). Its safety
depends on the tool axes never withholding that entry — true today (a whole-unit rule needs an
answering turn above the unit; the truncate axis ships off), but asserted nowhere, and the
existing pin covers only an **interior** excluded entry
(`src/plugin/context-trimmer.test.ts:3956-4048`, fixture `GAP` with entry 4 excluded). If the
newest canonical assistant entry is ever `included: false`, the newest *emitted* step's thinking
becomes strippable and nothing tests that arithmetic.

---

## Part C — Tasks

Run order: Phase 1 → 2 → 3. Every phase is independently shippable; do not start a later phase to
avoid finishing an earlier one. Focused checks run from `packages/underload/harness`; the final
check is the whole package.

### Phase 1 — the trimmer and its pins

#### T1 — Flip `dropDuplicateCalls` to the shipped default `true`

One default flip, no semantics change:

1. `src/plugins/context-trimmer.plugin.ts:671` — the descriptor's `default: false` → `true`.
2. `src/plugins/context-trimmer.plugin.ts:792` — `DROP_DUPLICATE_CALLS_DEFAULT = false` → `true`.
   The duplication rule (`:763-775`) requires BOTH to move together; add the constant's rationale
   comment (2026-11-15 posture decision: the re-derivation finding — the class is the measured rot
   in long tool loops, and a later identical `completed` re-run genuinely supersedes the earlier
   unit) in the file's voice. `TRIMMER_DEFAULT_SETTINGS.dropDuplicateCalls` derives from the
   constant (`:948`), so the pure plan's default moves with it — intended.
3. Update the pins that encode the declared default (expected values only; do not weaken any
   assertion):
   - `src/plugin/context-trimmer.test.ts:2780` — the descriptor table row
     `['dropDuplicateCalls', 'boolean', false, …]`.
   - `src/plugin/manifest.test.ts:299-307` — the manifest scanner's descriptor copy.
   - `src/server/plugins.test.ts:453-471` — the fresh-install values map (`:463`).
   - `src/server/plugins-api.test.ts` — the effective-values maps (`:712`, `:1063`) and the
     descriptor reset-target list (`['dropDuplicateCalls', false]` at `:1097`).
   - `src/plugin/context-compaction.test.ts:4323-4331` — the declared-defaults comment, and any
     overlap assertion below it that changes because the fixture's duplicate successful re-runs
     now get withheld at defaults (update to the new shipped posture).
   - `docs/plugins.md:488` — the settings-table row's Default column `false` → `true`.
4. Grep `docs/` and the package README for other prose stating the off default and update; the
   2026-11-10 task file is a historical record — do **not** rewrite it (this file is the decision
   record for the flip).
5. Full-package test run to catch end-to-end fixtures (e.g. `src/harness.inclusion.test.ts`) that
   contain accidental duplicate identical successful calls; update their expectations to the new
   default.

Explicitly unchanged: the fingerprint matching, `duplicateTurns: 2`, `DUPLICATE_ELIGIBLE_CLASSES`
(`:841`), `supersedeMatch: 'name'`, every other switch.

**Closing check:** `yarn vitest run src/plugin/context-trimmer.test.ts src/plugin/manifest.test.ts src/plugin/context-compaction.test.ts src/server/plugins.test.ts src/server/plugins-api.test.ts` green, then the full package run green.

#### T2 — Fix the inverted cache clause (FE)

`docs/plugins.md:510-514`: change "at a position strictly older than the one the previous step
moved" to "at a position strictly **newer** than the one the previous step moved". Touch nothing
else in the paragraph — the surrounding claims are correct.

**Closing check:** the paragraph read end-to-end states: rank grows as the transcript grows,
the boundary advances forward, one thought leaves per step at a strictly newer position, a cached
prefix diverges at one advancing point per step.

#### T3 — Pin the newest-entry case behind the rank-0 floor (FF)

New test in the same describe block as `src/plugin/context-trimmer.test.ts:3956` (the step-rank
section; reuse `think`, `entriesFrom`, `thoughtShape`, `settingsWith`). Fixture: the **newest**
assistant entry excluded, e.g.

```
0 user
1 assistant think('one', 10)   — rank 2
2 assistant think('two', 20)   — rank 1, the newest VISIBLE step
3 assistant think('gone', 30)  — rank 0, included: false via entriesFrom(fixture, [3])
```

Assert, as full candidate shapes with `stepsAgo` pinned (the GAP pin's discipline,
`:3988-3993`):

- at `thoughtTurns: 1` (and `0`) the withheld set is entries **1 and 2** — including entry 2, the
  newest *visible* step, because the continuity floor exempted the excluded canonical newest;
- at the default `thoughtTurns: 2` the withheld set is entry 1 only — the exposure is
  horizon-dependent, which is the point.

The test's comment must state the dependency it exposes: the floor protects the newest **emitted**
step only while the newest **canonical** assistant entry is itself emitted; that holds under the
shipped posture because whole-unit rules need an answering turn above the unit and the truncate
axis is off — and this pin documents the arithmetic, it does not change it. No production code
changes in T3.

**Closing check:** `yarn vitest run src/plugin/context-trimmer.test.ts` green with the new pin present; delete-the-floor mutant semantics unchanged (the pin fails if `thoughtAgoOf` ever stops counting excluded entries).

### Phase 2 — the decision-record guideline

#### T4 — `DECISION_RECORD_GUIDELINE`: one shared line, all seven real roles

1. Add to `src/agents/guidelines.ts` (follow the file's one-line-constant convention and add the
   category bullet to the header enumeration at `:12-38`). Required draft — wording may be
   tightened to the file's voice, but must keep all four elements (the mechanism, the per-round
   instruction, the one-line shape, and the four content kinds):

   ```ts
   export const DECISION_RECORD_GUIDELINE =
       'Your old reasoning is trimmed from the context after a few model steps while message content and tool results are kept: end every turn that calls a tool with one short line of content naming what the round established — ids, paths, verdicts, next step — so decisions survive outside your reasoning.';
   ```

   The mechanism sentence must stay honest: reasoning is trimmed after a few model steps
   (`thoughtTurns: 2`); content and tool results are never withheld by any axis (FB).
2. Wire the constant into the `guidelines: […]` array of **all seven real profiles** — `general`,
   `instruct`, `research`, `workspace`, `reviewer`, `planner`, `debugger`
   (`src/agents/general.ts:52-65` and siblings) — via `agentInstruction()` composition
   (`src/agents/index.ts:110-139`). **Exclude `summarizer`**: it is a one-shot condenser whose
   output already is content (`src/agents/summarizer.ts:12-18`).
3. Update `src/agents/agents.test.ts`: the per-profile pinned prompt lengths are exact, so the
   added line is a visible diff; if any profile would cross the 1800-character ceiling, raise the
   ceiling in the test the way the roster pass raised 1500 → 1800 (`src/agents/index.ts:131-139`)
   — do not silently drop or shorten other guideline lines to make room.
4. No harness code, no tool-description edits, no new setting: the guideline is the whole
   mechanism. A per-session override (`instructionOverride`) still replaces the whole prompt as
   it does today.

**Closing check:** `yarn vitest run src/agents/agents.test.ts src/server/harnesses/presets.test.ts` green; `agentInstruction()` for each of the seven roles contains the line exactly once, summarizer does not.

### Phase 3 — the stale `running` answer

#### T5 — `agentResult`: a finished child must not answer `running` (FD)

1. **Probe first** (bounded; nothing else in this task starts before it concludes). Write a probe
   in repo-root `Temp/` (e.g. `Temp/instruct/agentresult-stale-probe.ts`), run with
   `yarn vite-node`, that builds a harness with a scripted/offline transport, runs a child to
   completion, and establishes — with the child's final text committed in its transcript — what
   the invocation record answers for the explicit id, and where `commitRunTerminal` runs relative
   to that transcript commit (`registerInvocation` at `src/harness.ts:13432` files `running`;
   `:13437-13439` names `commitRunTerminal` as the only terminalizer). The probe must also
   reconcile the index evidence (polls at 200 returning `completed` vs 201/268 returning
   `running` for the same ids).
2. **Then the minimal fix**: the record must be terminal no later than the transcript's final
   text — i.e. close the ordering gap the probe identifies; do not redesign the lookup.
3. Regression test beside the existing `agentResult` coverage
   (`src/harness.thread-runtime.test.ts`): a child whose final text is committed answers its
   explicit id with a terminal status, never `running` with an empty body.
4. Record the probe's finding and the fix as a dated Update note at the end of this file.

Negative scope: the B2 no-id default (`:4282-4290`) and the explicit-id scoping rule
(`:4262-4274` — an id belonging to another agent is reported unavailable) are intentional
design and out of bounds unless the probe proves the id path itself is the defect. No polling
guidance, backoff or tool-description changes. **Honest ceiling:** if the probe cannot reproduce
a stale `running` with a scripted transport, record that finding, add no speculative fix, and
close T5 with the evidence — that is an acceptable outcome.

**Closing check:** probe output summarized in this file; `yarn vitest run src/harness.thread-runtime.test.ts` green including the new regression test.

### Final check

`yarn vitest run` for the whole package, green. Nothing outside Part C appears in the diff.

---

## Part D — Scope fence: NOT in this task

Each item below was considered and rejected (A3); implementing any of them is scope creep, not
initiative:

- **No open-turn floor** inside `planWithheldThoughts` — not as default, not behind a flag. The
  `turn` label at `:1873` stays a report label.
- **No `tool_calls` immunity** for the thinking axis (the post-mortem's F1a).
- **No `thoughtScope` switch**, no new settings key of any kind on the thinking axis.
- **No change to any other trimmer default**: `thoughtTurns` stays 2, `trimThoughts` stays true,
  `truncateToolRequests` stays false, `supersedeMatch` stays `'name'`,
  `invalidOutcomes` stays `"failed,rejected"`, the four economy knobs stay 0.
- **No thinking-axis batching/hysteresis mechanism** (the post-mortem's F5): `minThoughtChars`
  cannot gate the observed write pattern and a real batching design is not worth it now.
- **No compaction changes** — no mode, default, budget or T5.3 elision work.
- **No transport "convert tool rounds into assistant/user prompts" rendering** — the deferred
  prerequisite for ever turning `truncateToolRequests` on; separate task, not started here.
- **No rewrites of historical task files** (`2026-11-10-context-trimmer-uplift.md` is the record
  of what shipped then; this file is the record of what changes now).
- **No agent-roster changes** beyond composing the one new guideline line.

## Part E — Not tested / open

- **The guideline's real-world compliance is unmeasured.** T4's acceptance is the line landing
  in the seven prompts and the tests staying green — whether a given model actually writes the
  one-line notes is only observable in a live session, and the post-mortem's turn-count
  predictions (fewer re-derivation loops) are hypotheses until then.
- **T5's root cause is unverified** at write-up time (FD); the probe is the verification step,
  and "cannot reproduce, no fix" is a recorded acceptable outcome.
- **The IT14 measurements are session-record evidence** — 93% empty content, the four loop
  classes, the 8 polls, the 747 → 21,403-char reasoning growth — verified by two independent
  delegates against `thread-32`, not re-derivable from repo source.
- **The estimator interaction**: with `dropDuplicateCalls` on, `estimatedTokens` and the context
  bar will read *lower* for trajectories with duplicate successful calls (the estimator counts
  withheld units' text as absent — `src/core/context-estimate.ts:36-56` states the flag-driven
  rule for thinking; whole-unit withholding removes the entries outright). No change needed;
  noted so nobody mistakes the moved numbers for a defect.

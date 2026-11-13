# 0025 — `requireClarification` refuses briefs that state a target and an output shape, because its acceptance test is a word list

> **Status:** Fixed — 2026-11-14 (the minimum-change alternative shipped, not the warning
> proposal: the acceptance test reads shape and count now, the incidental words are gone, and the
> refusal no longer demands a `done when` clause — see the updates; the third pass of 2026-11-14
> re-derived every address at the current tree and retired the stale-comment residual)
> **Severity:** Minor
> **Area:** `src/harness.ts` (`missingBriefParts`), `src/tools/runtime/delegate.tool.ts` (property description)
> **Date opened:** 2026-11-11

## Context

`requireClarification` is the recommended guard for a write-capable child: refuse an
under-specified brief before it spends a run. Three briefs were put through it.
"Make it better." was refused, correctly. "In the file notes.md, add a line containing
the word alpha. Done when notes.md contains that line." was accepted, correctly. "Summarize
the file README.md in three bullets." was **refused** — for naming no acceptance criterion —
even though it names a file, an operation, an output shape, and a count. The refusal asks
the caller to restate with a `done when` clause, so the caller pays a round trip to add a
clause that adds nothing the child could not already do.

## Gap

A caller that opts into the gate wants it to catch vague briefs, not to demand a magic
phrase. The current test is a fixed word list, so an actionable brief is refused for
phrasing rather than for substance, and the flag is recommended precisely for the
write-capable delegations where a refusal is most expensive in wall-clock and tokens.

## Why it is the way it is

The heuristic is explicitly coarse and documented as such: `src/harness.ts:3734-3738`
("Deliberately coarse: the gate exists to stop `"Fix the bug."` from reaching a
write-capable agent, not to grade prose"). Both parts must be present — the helper pushes
each missing part and the caller refuses when the list is non-empty (`:4088-4097`) — and
the acceptance test is a 17-word regex at `:3751-3755` (`acceptance|criteria|expect|
should|must|verify|…|done when|…`). The target test is a shape regex at `:3742-3747`
(path-like token, dotted identifier, URL, backquoted or quoted name, camelCase, snake_case),
which is why `README.md` satisfied it. The gate is opt-in, so nothing is lost by a refusal
except a round trip — that is the trade the design accepts.

## Evidence

| Fact | Source |
|---|---|
| Both parts are required | `src/harness.ts:4088-4097` (`missing.length > 0` refuses), helper `:3737-3759` |
| The acceptance test is a word list | `src/harness.ts:3751-3755` (`if (!hasAcceptance) missing.push('acceptance criterion (what "done" means)')` at `:3755`) |
| The target test is a shape test | `src/harness.ts:3742-3749` |
| The coarseness is intentional | `src/harness.ts:3734-3738` |
| The property description states the rule | `src/tools/runtime/delegate.tool.ts:96-102` ("refuse … if the brief names no concrete target … **or** no acceptance criterion") |
| Runtime, 2026-11-11: refused | `"Summarize the file README.md in three bullets."` → `The brief for "general" is under-specified: it names no acceptance criterion (what "done" means).` |
| Runtime, 2026-11-11: accepted | `"In the file notes.md, add a line containing the word alpha. Done when notes.md contains that line."` → child ran and completed (invocation 30) |
| Runtime, 2026-11-11: correctly refused | `"Make it better."` → both parts named missing, before the child ran |
| Existing pins | `src/harness.delegation.test.ts:590` (refuses an under-specified brief), `:615` (accepts a brief with a target and a criterion) |

## Proposal

Widen the acceptance signal to cover the ways a brief actually states what done means,
without turning the gate into a prose grader: an explicit output shape or count ("in three
bullets", "as a table with columns X and Y", "one line", "exactly"), a named verification
verb already in the list, or a stated constraint. Keep the hard refusal for a brief that
names **no** target at all — that is the case the design was built for — and when a target
is present but the acceptance signal is not, report it as a warning in the envelope
(`briefWarnings: ["no acceptance criterion"]`) and let the child run. If the owner prefers
to keep the refusal, the minimum change is to add the output-shape forms to the regex and
to soften the refusal text so it does not demand a `done when` clause specifically.

**Alternatives considered.**

- *Leave the heuristic alone and document that it wants a `done when` clause.* Rejected:
  it makes the flag costly to use for exactly the delegations it is recommended for, and it
  encodes a magic phrase rather than the substance the comment at `:3734-3738` describes.
- *Replace the regex with a model call.* Rejected: a gate that exists to save a child run
  must not itself spend one.
- *Drop the acceptance requirement entirely.* Rejected: it is what stops `"Fix the bug."`
  reaching a write-capable agent, which is the incident recorded at `:4083-4087`.

## Acceptance criteria

1. A brief that names a target and an explicit output shape or count is not refused for a
   missing acceptance criterion.
2. A brief that names no target is still refused before the child runs, and the refusal
   still names both missing parts when both are missing.
3. The refusal text no longer insists on a `done when` clause specifically.
4. The existing pins at `:590` and `:615` still pass, or are updated with the reason stated
   in the test.

## Tests to add

- `src/harness.delegation.test.ts` — "Summarize the file README.md in three bullets.":
  assert it is not refused for a missing acceptance criterion.
- `src/harness.delegation.test.ts` — a brief with an acceptance word but no target
  ("must pass the tests"): assert it is still refused for the missing target.

## Out of scope

- Grading prose quality.
- Making the gate default-on.
- Applying the gate to the host `runtime.delegate` path, which is not schema-validated.

## Update (2026-11-11) — independent review

- **Verdict: re-classified.** The implementation is correct to its own spec, so this is a
  complaint about the spec, not a bug. Both predicates must hold (`src/harness.ts:4088-4097`),
  which is what the shipped property text says
  (`src/tools/runtime/delegate.tool.ts:88-92`). The target regex is at `:3742-3749` and the
  acceptance word list at `:3751-3755`; the coarseness is stated as intentional at `:3734-3738`.
  Severity unchanged: **Minor**.
- **The proposed relaxation is unsound as first stated.** Accepting "target plus output shape"
  also requires changing the documented contract (the property description and this issue's
  framing), and on its own it strictly weakens the gate — a one-sided relaxation buys nothing.
- **The gate also over-accepts, and the original pass only tested one direction.** The
  acceptance list contains `because`, `without`, `test`, `tests` and `should`
  (`src/harness.ts:3751-3755`), so a brief like "Refactor `src/parse.ts` because it is long"
  passes the gate while stating no acceptance criterion at all: the target is present and an
  incidental causal word satisfies the list. Any fix must close this direction too, or the
  change is a net loosening with no compensating gain. When the owner takes the issue up,
  **Gap** and the acceptance criteria should carry it: a brief whose only acceptance signal is a
  causal or incidental word should not pass.
- **Test gap confirmed:** no test exercises a brief that satisfies exactly one predicate, and
  none exercises a brief that passes acceptance on an incidental word.

## Update (2026-11-14) — shipped, by the minimum-change route

Read from the current source and tests; **no test was executed by this doc pass**. Every line number
in the sections above predates the change (`src/harness.ts` has moved throughout), so this update is
the address map; the dated analysis stays as written.

- **AC1 — the acceptance test reads substance now.** `missingBriefParts` is
  `src/harness.ts:3979`, and the acceptance side is no longer one word list. It ORs the old
  `statesCondition` (`:3996-3999`) with three named shape tests: `BRIEF_ARTIFACTS` (`:3961`, the
  nouns a deliverable is measured in), `BRIEF_COUNT` (`:3963`, digits plus the spelled-out numbers),
  `BRIEF_COUNTED_SHAPE` (`:3966`, an `in/as/of/within/exactly/at most/…` preposition followed by a
  count and an artifact — this is the door `"in three bullets"` now walks through, matched at
  `:4003`), `BRIEF_NAMED_FORMAT` (`:3973`, matched at `:4004`) and `BRIEF_BOUND` (`:3977`, a numeric
  bound, matched at `:4005`).
- **AC2 — and the gate did not only get looser.** The review's over-acceptance finding shipped too:
  `because`, `without`, `test` and `tests` are **out** of the acceptance list and `criterion` is in.
  The list today, in full, is `acceptance|criteria|criterion|expect|expects|expected|should|must|
  verify|verified|pass|passes|passed|repro|reproduce|done when|so that|instead of`
  (`:3996-3999`) — every remaining word states an outcome, none is a causal connective.
- **AC3 — the refusal stopped naming a magic phrase.** `:4604-4618`: one enumeration of the missing
  parts and one remedy (`Add those parts to the brief and delegate again.`). The old second sentence
  restated the parts, demanded a `done when` clause, and promised "any constraint", which this gate
  never checked. Pinned by `expect(refusal).not.toContain('done when')` at
  `src/harness.delegation.test.ts:1264-1265`.
- **What did NOT ship: the warning route.** `briefWarnings` appears nowhere in `src/`, so a brief
  whose acceptance signal is missing is still **refused**, not warned-and-run — the Proposal's own
  "minimum change" fallback ("add the output-shape forms to the regex and soften the refusal text")
  is the option taken. The **Out of scope** bullet about the gate not holding the whole call is
  therefore still accurate.
- **The pins, all four directions, in one describe.** AC1 `src/harness.delegation.test.ts:1167`
  (`Summarize the file README.md in three bullets.` → the child runs, `:1186`); AC2 `:1190` (an
  acceptance-worded brief with no target is refused, the refusal names `concrete target`, and `:1213`
  asserts it does **not** claim the criterion is missing); the causal-word direction `:1217`
  (refused, names `acceptance criterion`, and `:1239` asserts the target is not reported missing);
  both parts missing `:1243`. Both of the review's test gaps are closed — each predicate is now
  exercised on its own, in both directions. AC4 holds: the two pre-existing pins (then `:590`, `:615`)
  are `:1108` and `:1133` today and still assert the same behaviour.
- **One stale source comment to fix, and it is not this pass's file.** The block at
  `:4609-4614` still reads "the GATE IS UNCHANGED — 0025's semantic proposals (over-acceptance and a
  richer acceptance test) are separate work", which the shipped change contradicts on both halves.
  `src/harness.ts` is owned by the sibling pass, so this is reported rather than edited.

## Update (2026-11-14, third pass) — every address re-derived; the stale-comment residual is closed

Read from source and tests; **no test was executed by this doc pass**. Addresses are from the working
tree at 07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree). `src/harness.ts` was rewritten
during the pass (it is 14,764 lines now, and was over 15,000 an hour earlier) and the runtime tool
files were renamed (`agentDelegate.tool.ts` → `delegate.tool.ts`), so every number below is a snapshot
and the quoted identifiers are what should be re-grepped.

- **The gate is unchanged in substance; the addresses moved ~5 lines and the file name changed.** The
  explanatory comment now runs `src/harness.ts:3944-3966` (the 0025 half — over-acceptance and
  under-acceptance, with the incident brief — at `:3949-3966`); `BRIEF_ARTIFACTS` at `:3967-3968`,
  `BRIEF_COUNT` at `:3969`, `BRIEF_COUNTED_SHAPE` at `:3972-3975`, `BRIEF_NAMED_FORMAT` at
  `:3979-3980`, `BRIEF_BOUND` at `:3983`, and `missingBriefParts` at `:3985-4016`: `hasTarget` at
  `:3990-3993`, the push of `concrete target (file, symbol, URL, or id)` at `:3995`, the
  `statesCondition` word list at `:4002-4005` (the incidental causal words gone, `criterion` added
  exactly as recorded in AC2), and the four-way `hasAcceptance` at `:4007-4011` — so the shape tests
  are now matched at `:4009`, `:4010`, `:4011`, not `:4003-4005`.
- **AC3's message, re-read.** The gate's own block is `:4602-4608` (`T28 UNDER-SPECIFIED BRIEFS ARE
  GATED AT DISPATCH`, with "the refusal happens BEFORE the child runs"), the read at `:4610`, the
  `if (missing.length > 0)` at `:4612`, and the message at `:4630-4631`:
  ``The brief for "${target}" is under-specified: it names no ${missing.join(', no ')}. `` +
  `'Add those parts to the brief and delegate again.'` — one enumeration, one remedy, and the string
  `done when` does not appear anywhere in it.
- **Reduction: the second pass's last item — "one stale source comment to fix" — is CLOSED, so the
  item is retired here rather than carried.** The block that used to read "the GATE IS UNCHANGED —
  0025's semantic proposals … are separate work" was corrected in-source and now runs `:4613-4629`;
  its `Correction (review #5, 2026-11-14)` paragraph says the opposite of what it said, by name: "Only
  the **MESSAGE** was untouched by #18; 0025 changed what this gate accepts, by widening the acceptance
  signal inside `missingBriefParts` (the over-accepted causal words are gone and `BRIEF_COUNTED_SHAPE`
  / `BRIEF_NAMED_FORMAT` / `BRIEF_BOUND` let a brief that fixes done-ness by SHAPE through)." A reader
  who takes the comment at face value now grades the gate correctly, which is what the item asked for.
- **Reduction, dated: the third bullet of Tests to add is deleted from that section.** It was
  conditional — "if warnings replace the soft refusal: assert the child runs and the envelope carries
  the warning" — and the owner's choice is final on the shipped tree: `briefWarnings` still appears
  nowhere in `src/`, so there is no warning to assert. The first two bullets are the shipped tests
  themselves and are pinned (below).
- **The pins, at current addresses.** All six cases sit inside `describe('delegation result contract
  (T28)')` at `src/harness.delegation.test.ts:1011` — there is no separate brief-gate describe. AC4's
  pre-existing pair: `:1108` (refuses at dispatch, asserts `is under-specified` and `concrete target`
  and `expect(researcher.messages).toEqual([])`) and `:1133` (accepts target + criterion, asserts the
  child's answer at `:1151`). AC1: `:1167`, asserted at `:1187`. AC2's other direction: `:1190`, with
  `not.toContain('acceptance criterion')` at `:1213`. Causal-word direction: `:1217`, with
  `not.toContain('concrete target')` at `:1239`. Both parts missing: `:1243`, with
  `not.toContain('done when')` at `:1265`.
- **What is still owed, and it is documentation only.** Nothing outside this issue records the rule:
  `grep -rn requireClarification knowledge.md docs/` hits only this file, so the two-part rule and the
  shape signals are undocumented for operators. The model-facing text is thinner still —
  `src/tools/runtime/delegate.tool.ts:145` says only that the flag "refuse[s] the delegation BEFORE the
  child runs if the brief names no concrete target (file, symbol, URL, or id) or no acceptance
  criterion", and never mentions that a shape or a count **is** a criterion. A model that writes
  "in three bullets" therefore cannot know from the schema that its brief will pass; it learns by
  being refused or not. Left as-is deliberately: widening that description is a prompt-contract change
  with a manifest consequence (`yarn tools:manifest:check`), not a docs fix.

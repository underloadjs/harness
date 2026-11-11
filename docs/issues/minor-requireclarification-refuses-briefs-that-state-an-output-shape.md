# 0025 — `requireClarification` refuses briefs that state a target and an output shape, because its acceptance test is a word list

> **Status:** Open
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
- `src/harness.delegation.test.ts` — if warnings replace the soft refusal: assert the
  child runs and the envelope carries the warning.

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

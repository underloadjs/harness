# 0026 — The `maxChars` ceiling lives in three places, and a running build was observed accepting a page above it

> **Status:** Open — **unconfirmed against HEAD**; re-verify on a build from the current tree before implementing
> **Severity:** Minor
> **Area:** `src/tools/runtime/delegate.tool.ts` (schema), `src/harness.ts` (page bound), `src/core/agent-limits.ts`
> **Date opened:** 2026-11-11

## Gap up front

`delegate` advertised `limit: 9000` for a `maxChars: 9000` request, although the schema
caps the argument at 8000 and the runtime clamps to `AGENT_RESULT_PAGE_MAX_CHARS` (8000).
Current source already refuses an over-ceiling model bound and already clamps, so this
entry is filed as a **drift and verification** issue rather than a confirmed live defect:
the observed behaviour came from a process whose in-memory build predated those guards, and
the log's own rule is that a claim without a current source reference is `unconfirmed`.

## Context

A caller asking for a 9,000-character page got one: the envelope echoed `limit: 9000`
against a schema that declares `maximum: 8000`. Nothing said the request was out of range,
and nothing said the page had been bounded, so the caller could not tell whether the
answer was complete — `truncated: false` was reported for a page larger than the
documented ceiling. The ceiling is expressed three times: as a schema bound, as a runtime
clamp against a published constant, and as prose in the description. Three expressions of
one number, in three files, is how this kind of divergence appears and then hides.

## Gap

A caller needs one answer to "what is the largest page I can ask for, and what happened to
my request when I asked for more". Today the bound is stated in prose and in a schema, and
enforced in a third place against a fourth constant; when they disagree the caller sees a
`limit` that matches neither the schema nor the constant, with no flag saying so.

## Why it is the way it is

The duplication is deliberate and pinned. The schema literal must stay an AST-extractable
plain literal holding number literals, because the startup scanner reads it out of the file
without evaluating the module and `scripts/check-package-tools.mjs` requires
`dependencies: []` for this entry — so it cannot import the constant
(`src/tools/runtime/delegate.tool.ts:38-45`). The pin against that duplication is
`src/core/metadata.ownership.test.ts`, which checks the inlined ceiling against the
canonical constants (`:41-45`). The runtime clamp is separate and intentional:
`src/harness.ts:4105-4107` takes `Math.min(Math.max(1, Math.floor(maxChars)),
AGENT_RESULT_PAGE_MAX_CHARS)` with `AGENT_RESULT_PAGE_MAX_CHARS = 8000` at
`src/core/agent-limits.ts:27`. The host path is deliberately **not** clamped — the schema
maximum bounds a model argument only (`src/harness.ts:4150-4160`), pinned by
`src/harness.delegation.test.ts:1411` ("honours a host bound above the ceiling instead of
clamping it") and `:1479` ("refuses a model bound above the ceiling before the child
runs").

## Evidence

| Fact | Source |
|---|---|
| The schema declares 1–8000 | `src/tools/runtime/delegate.tool.ts:81-87` (`maximum: 8000` at `:84`) |
| The runtime clamps to the published constant | `src/harness.ts:4105-4107`; `src/core/agent-limits.ts:27` (`AGENT_RESULT_PAGE_MAX_CHARS = 8000`) |
| The description repeats the ceiling in prose | `src/tools/runtime/delegate.tool.ts:164` ("at most maxChars characters (default 8000)") |
| The duplication is a known constraint, pinned by a test | `src/tools/runtime/delegate.tool.ts:38-45`; `src/core/metadata.ownership.test.ts` |
| A model bound above the ceiling is refused, and a host bound is not clamped | `src/harness.delegation.test.ts:1479`, `:1411` |
| Runtime, 2026-11-11: `maxChars: 9000` accepted | envelope `{"limit": 9000, "truncated": false}` for a 6-character answer (invocation 20) |
| The running process predated the current build | `dist/underload-harness.server.mjs` and its `lane-authority-*.js` chunk carry the clamp with an `8e3` ceiling and a sourcemap naming `AGENT_RESULT_PAGE_MAX_CHARS`; the chunk mtimes are 11:00:25 while the live session started earlier, so the in-memory build was older |
| `src/harness.ts` matches `HEAD` for this region | `git status --short -- src/harness.ts` is empty; the clamp is present in the working tree at `:4106` |

## Proposal

Make the single number the single source of truth for the *enforced* bound, and make a
clamped or refused request visible. Keep the literal in the schema (the scanner requires
it) but add an assertion in `src/core/metadata.ownership.test.ts` that the schema
`maximum`, the description's prose number, and `AGENT_RESULT_PAGE_MAX_CHARS` are one value
— the test already pins two of the three. Then, on the runtime side, when a model passes a
value above the ceiling, keep the refusal and make sure the refusal names the ceiling and
the accepted range; when a host passes one, keep the clamp and report it
(`maxCharsClamped: true`) so a caller can never read a clamped page as a complete one.

**Alternatives considered.**

- *Import the constant into the schema.* Rejected: it breaks the AST-extractable-literal
  rule and the `dependencies: []` check (`src/tools/runtime/delegate.tool.ts:38-45`).
- *Raise the ceiling to whatever the caller asks for.* Rejected: the ceiling is the
  context guard for a 58 KB answer, and the host path already has the unclamped escape
  hatch.
- *Close the issue as not-a-defect.* Plausible, and the honest outcome if a build from HEAD
  refuses `maxChars: 9000` as `:1479` asserts — in that case keep only the third pin and
  the clamp visibility, and record the refutation here so the claim is not re-filed.

## Acceptance criteria

1. A `delegate` call with `maxChars` above the ceiling either refuses naming the ceiling,
   or clamps and says so in the envelope.
2. No envelope reports a `limit` larger than the published ceiling on the model path.
3. A test pins schema `maximum`, the description's stated number, and
   `AGENT_RESULT_PAGE_MAX_CHARS` to one value.
4. The host path's unclamped behaviour is unchanged and still pinned.

## Tests to add

- `src/core/metadata.ownership.test.ts` — the three-way equality pin (schema `maximum`,
  the prose number in the allowlist description, the constant).
- `src/harness.delegation.test.ts` — extend `:1479` to assert the refusal text names the
  ceiling value, not just that a refusal happened.
- `src/harness.delegation.test.ts` — a host `runtime.delegate` call above the ceiling:
  assert the clamp is reported in the envelope while the host's own bound is honoured.

## Out of scope

- Changing the ceiling value.
- Paging semantics of `nextOffset` / `agentResult`, which are correct as observed.
- The `timeoutMs` ceiling, which follows the same three-place pattern and is already pinned
  by `src/core/metadata.ownership.test.ts`.

## Update (2026-11-11) — independent review

- **Verdict: REJECTED as originally filed** ("the upper bound is declared but not enforced"). On
  the model path the bound is enforced twice over: the schema gate `maximum: 8000`
  (`src/tools/runtime/delegate.tool.ts:84`) is applied by `resolveToolParameters`
  (`src/harness.ts:7463`; the manual and direct paths at `:11383` and `:11482`), and
  `src/core/schema-validation.ts:14-17` implements `minimum`/`maximum`. The runtime then clamps
  at `:4105-4107`. The sibling `timeoutMs` case proves the gate fires:
  `src/harness.delegation.test.ts:1479` asserts a refusal above the ceiling. So `limit: 9000` is
  not producible from this tree on any path.
- **The stale-build explanation is corroborated, not merely inferred.** The shipped server entry
  loads a chunk carrying the clamp with an `8e3` ceiling whose sourcemap names
  `AGENT_RESULT_PAGE_MAX_CHARS`, and that build is newer than the live process that produced the
  observation. `src/harness.ts` matches `HEAD` in this region.
- **What survives, and is the whole issue:** one number expressed in three places that can drift,
  plus a clamp that is invisible to the caller when the host path takes it. Keep the three-way
  pin and the `maxCharsClamped` visibility; drop the "not enforced" framing.
- **Test gap confirmed, and it is why this was worth filing anyway:** no test covers `maxChars`
  above the ceiling — neither the schema refusal nor the host clamp. The only over-ceiling
  argument tested anywhere is `timeoutMs`. Also untested: `maxChars: 1` and exactly 8000, both of
  which the live pass exercised successfully.

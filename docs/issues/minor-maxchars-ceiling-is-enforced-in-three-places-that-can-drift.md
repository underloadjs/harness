# 0026 — The `maxChars` ceiling lives in three places, and a running build was observed accepting a page above it

> **Status:** Open — **confirmed against HEAD 2026-11-16** (the "not enforced" defect is refuted;
> what survives is the missing equality pin and a clamp that is invisible to the caller)
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

The duplication is deliberate and **partly** pinned — both qualifiers corrected in place by the
2026-11-16 pass below. The schema literal must stay an AST-extractable plain literal holding number
literals, because the startup scanner reads it out of the file without evaluating the module and
`scripts/check-package-tools.mjs` requires `dependencies: []` for this entry — so it cannot import
the constant (`src/tools/runtime/delegate.tool.ts:38-45`). The pin against that duplication is
`src/core/metadata.ownership.test.ts`, which checks the inlined ceilings against the canonical
constants (the equality list at `:422-428`) — **but not this entry's `maxChars`**: the delegate copy is
only listed by key name (`:407`), while the sibling `agentResult.limit` is pinned to the constant
exactly as this issue asks (`.maximum` at `:436`, description at `:437-439`, prose at `:447`) and
`DELEGATE_TIMEOUT_MS` likewise (by number at `:466`). The runtime clamp
is separate and intentional; it has since been renamed and moved: `delegatePageLimitOf`
(`src/harness.ts:4547-4553`) takes `Math.min(Math.max(1, Math.floor(maxChars)),
AGENT_RESULT_PAGE_MAX_CHARS)` with `AGENT_RESULT_PAGE_MAX_CHARS = 8000` at
`src/core/agent-limits.ts:29`, and it is the ONE derivation both delegate doors use (`:4856` for the
live envelope, `:9553` for the owed-account reprint). **The host path is no longer deliberately
unclamped for `maxChars`** — the sentence this file carried is corrected below and in the update:
every path, model or host, runs through `delegatePageLimitOf`, so a host `maxChars: 9000` is
silently clamped to 8000 with no flag in the envelope. The two pins originally cited for "a host
bound is not clamped" are `timeoutMs` cases, not `maxChars` ones —
`src/harness.delegation.test.ts:2641` ("honours a host bound above the model ceiling instead of
clamping it") and `:2709` ("refuses a model bound above the ceiling before the child runs") — and no
test exercises `maxChars` above the ceiling on either path.

## Evidence

| Fact | Source |
|---|---|
| The schema declares 1–8000 | `src/tools/runtime/delegate.tool.ts:149-154` (`minimum: 1` at `:151`, `maximum: 8000` at `:152`) — re-anchored from `:81-87`/`:84` on 2026-11-16 |
| The runtime clamps to the published constant | `src/harness.ts:4547-4553` (`delegatePageLimitOf`, the `Math.min(Math.max(1, …), AGENT_RESULT_PAGE_MAX_CHARS)` at `:4551`), used by both delegate doors at `:4856` and `:9553`; `src/core/agent-limits.ts:29` (`AGENT_RESULT_PAGE_MAX_CHARS = 8000`) — re-anchored from `:4105-4107`/`:27` |
| The description repeats the ceiling in prose | `src/tools/runtime/delegate.tool.ts:138` ("`maxChars` pages the answer (default 8000)") and `:252` ("at most maxChars characters (default 8000)") — re-anchored from `:164` |
| The same number is mirrored in generated files (excluded as drift risk, recorded for completeness) | `src/core/tool-manifest.ts:1193` (prose), `:1212-1216` (`minimum: 1` `:1214`, `maximum: 8000` `:1215`) |
| The duplication is a known constraint, pinned by a test | `src/tools/runtime/delegate.tool.ts:38-45`; `src/core/metadata.ownership.test.ts` — **pinned for `agentResult.limit` (`:436`, `:437-439`, `:447`), not for `delegate.maxChars`, which is only listed by name at `:407`** |
| A model bound above the ceiling is refused, and a host bound is not clamped | **`timeoutMs` cases, not `maxChars`:** `src/harness.delegation.test.ts:2709` and `:2641` (re-anchored from `:1479`, `:1411`). The only `maxChars` bound test is `:1111` (`maxChars: 4`, inside the ceiling); **no `maxChars` case exists above 8000 on either path** |
| Runtime, 2026-11-11: `maxChars: 9000` accepted | envelope `{"limit": 9000, "truncated": false}` for a 6-character answer (invocation 20) |
| The running process predated the current build | `dist/underload-harness.server.mjs` and its `lane-authority-*.js` chunk carry the clamp with an `8e3` ceiling and a sourcemap naming `AGENT_RESULT_PAGE_MAX_CHARS`; the chunk mtimes are 11:00:25 while the live session started earlier, so the in-memory build was older |
| `src/harness.ts` matches `HEAD` for this region | `git status --short -- src/harness.ts` is empty; the clamp is present in the working tree at `:4106` (the clamp is at `:4551` today, and the tree is no longer clean for that file — see the 2026-11-16 update) |

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
  context guard for a 58 KB answer, and there is no unclamped escape hatch to fall back
  on — `delegatePageLimitOf` (`src/harness.ts:4547-4553`) clamps **every** path, host
  included, so a host `maxChars: 9000` already becomes 8000 silently.
- *Close the issue as not-a-defect.* Plausible, and the honest outcome if a build from HEAD
  refuses `maxChars: 9000` as `:1479` asserts — in that case keep only the third pin and
  the clamp visibility, and record the refutation here so the claim is not re-filed.

## Acceptance criteria

1. A `delegate` call with `maxChars` above the ceiling either refuses naming the ceiling,
   or clamps and says so in the envelope.
2. No envelope reports a `limit` larger than the published ceiling on the model path.
3. A test pins schema `maximum`, the description's stated number, and
   `AGENT_RESULT_PAGE_MAX_CHARS` to one value.
4. The host path's clamp is stated and pinned: `delegatePageLimitOf` (`src/harness.ts:4547-4553`)
   bounds **every** path, so a host `maxChars: 9000` becomes 8000 silently, and no test covers
   `maxChars` above the ceiling on either the host or the model path.

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

## Update — 2026-11-16 (review pass)

Re-verified against the current tree, read and grepped only (no build, no test run — this is a
documentation pass). **Status moved from "unconfirmed against HEAD" to confirmed-and-open**, and the
header now says so.

- **The "not enforced" defect is refuted, as the 2026-11-11 review argued.** There is one constant,
  `AGENT_RESULT_PAGE_MAX_CHARS = 8000` (`src/core/agent-limits.ts:29`), and ONE runtime derivation,
  `delegatePageLimitOf` (`src/harness.ts:4547-4553`):
  `Math.min(Math.max(1, Math.floor(maxChars)), AGENT_RESULT_PAGE_MAX_CHARS)`, with an omitted
  `maxChars` falling back to the constant itself. It is called at `:4856` (the delegate envelope)
  and at `:9553` (the owed-account reprint, which passes `undefined` deliberately because a debt
  records the door, not the call's `maxChars` — the comment at `:9528-9530` says so). So
  `limit: 9000` is not producible from this tree.
- **"Three places" is better described today as one constant, one helper, and the two hand-maintained
  restatements.** The constant (`src/core/agent-limits.ts:29`) and the helper
  (`src/harness.ts:4547-4553`) are the live pair; the drift surface is the schema literal
  (`src/tools/runtime/delegate.tool.ts:149-154`, `minimum: 1` at `:151` / `maximum: 8000` at `:152`)
  and the prose (`:138` and `:252`, both "default 8000"). The generated mirrors
  (`src/core/tool-manifest.ts:1193`, `:1212-1216`) are excluded as drift risk: they are emitted from
  the same literal the scanner reads, so they cannot disagree with it independently.
- **Why it stays Open: the delegate copy has no equality pin.**
  `src/core/metadata.ownership.test.ts:407` merely lists `'maxChars'` among the declared property
  names of the delegate entry — no number is compared. The same file already pins the sibling
  exactly the way this issue asks: `:436`
  `expect(agentResult.properties.limit.maximum).toBe(AGENT_RESULT_PAGE_MAX_CHARS)`, its description
  at `:437-439`, its prose at `:447`, and `:466` pins `DELEGATE_TIMEOUT_MS` by number (the
  `it(...)` for it opens at `:451`); the five `AGENT_*` constants are pinned as one equality list at
  `:422-428`. AC3's three-way pin
  (schema `maximum` + prose number + constant) therefore does **not** exist for `delegate`, even
  though the pattern it asks for is already in the file two screens away.
- **Anchors reconciled across this file and the index row (2026-11-16, same pass).** The header, the
  evidence table and the index row cited three different anchor sets for `metadata.ownership.test.ts`
  (`:41-45` for the constants check, `:438`, `:451`, and `:437-440` / `:423-429` in the row). All
  three were re-read against the file and replaced with one verified set, used identically in every
  place: `:407` (the delegate property-name list — the only `maxChars` assertion in the file),
  `:422-428` (the `AGENT_*` equality list, `expect([…]).toEqual([200, 5, 64, 4000, 8000])`), `:436`
  (`agentResult.limit` `.maximum`), `:437-439` (that parameter's whole `description` string), `:447`
  (the `agentResult` tool description prose) and `:466` (`DELEGATE_TIMEOUT_MS` pinned by number).
  `:41-45` was the **import** block, not the check, so it is no longer cited for the equality pin.
- **The clamp is still invisible.** `grep -rn "maxCharsClamped|Clamped" src` returns webfetch's
  `offsetClamped` (`src/tools/webfetch/index.ts:492`, `:673`) and one test-local word in
  `src/core/context-estimate.test.ts:324` — nothing for `maxChars`. And the test gap is unchanged:
  `src/harness.delegation.test.ts:1111` is the only `maxChars` bound case and it asks for
  `maxChars: 4`; the two over-ceiling tests this file once cited (`:2641`, `:2709`) are **`timeoutMs`**
  arguments, not `maxChars` ones.
- **In-place correction of a sentence the tree now contradicts.** This file said the host path is
  deliberately **not** clamped and pinned by `:1411`. For `maxChars` that is false: a host
  `runtime.delegate` call goes through the same `delegatePageLimitOf` (`src/harness.ts:4547`, reached
  at `:4856`), so a host `maxChars: 9000` is clamped to 8000 **silently** — `limit` reports 8000 and
  no key says the request was bounded. Whether that is the intended contract is an owner call, but
  the *behaviour* is a clamp, not a pass-through. It is untested either way: no host-side `maxChars`
  case exists above the ceiling. **Two more sentences in this file made the same claim and are
  corrected in place with it** (2026-11-16, same pass): the Alternatives parenthetical — "the host
  path already has the unclamped escape hatch" — now says there is no escape hatch, because
  `delegatePageLimitOf` clamps every path, and AC4 — "the host path's unclamped behaviour is
  unchanged and still pinned" — now states the clamp itself and the fact that no test covers
  `maxChars` above the ceiling on either path.
- **Concrete next step (unchanged in substance, sharpened by this pass).**
  1. Add the third pin to `src/core/metadata.ownership.test.ts`: the delegate schema `maximum`
     (`delegate.tool.ts:152`), the prose range/`default 8000` (`:154`, `:138`, `:252`) and
     `AGENT_RESULT_PAGE_MAX_CHARS` must be one value — copy the `agentResult.limit` shape at `:436`.
  2. Add the two missing cases to `src/harness.delegation.test.ts`: a model `maxChars: 9000` →
     schema refusal that names the ceiling and the accepted range (AC1, AC2), and a host
     `maxChars: 9000` → clamped to 8000, today silently, with `maxCharsClamped: true` once the owner
     accepts the new key (AC1, AC4 as now written — the AC4 wording fix this update records has
     since been applied in place, see the AC list above).
- **One 2026-11-11 evidence row is no longer reproducible as written.** Its "`git status --short --
  src/harness.ts` is empty" was a claim against that day's tree; today the file reports ` M`
  (HEAD `e869dc0`), so the clean-tree half of that row cannot be re-observed. What matters from it
  survives by read: the clamp is present in the working tree, at `:4551` rather than `:4106`.
- **Status stays Open**, severity Minor, and the title stays accurate: the ceiling is enforced, the
  point is that four hand-written expressions of it are not pinned to one value and a caller cannot
  see the clamp take.

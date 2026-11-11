# 0013 — `category` combined with date or domain filters reaches the provider and returns an opaque `HTTP 400`

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11) — closed**)
> **Severity:** Minor
> **Area:** `src/tools/websearch/index.ts` (argument validation)
> **Date opened:** 2026-11-10

## Context

Found by stress-testing `search` filter combinations. The tool description already tells the
caller which combinations are invalid — `index.ts:462` states *"Note \"people\" and \"company\"
do not support date filters, and \"people\" does not support excludeDomains"* — but nothing
enforces it. A caller that reads the warning and still sends the combination pays a provider
round trip to receive an error that names no field, and cannot tell from the message which
argument to drop.

## Gap

The four documented-invalid combinations are accepted locally and rejected remotely, so the
error the caller sees identifies neither the field nor the fix:

| Call | Result |
|---|---|
| `category:"people"` + `since` | `Exa search failed (HTTP 400).` |
| `category:"people"` + `until` | `Exa search failed (HTTP 400).` |
| `category:"company"` + `since` | `Exa search failed (HTTP 400).` |
| `category:"people"` + `excludeDomains` | `Exa search failed (HTTP 400).` |

The caller needs the same thing the tool already gives for every other invalid argument: a
message that names the offending field and says what to drop.

## Why it is the way it is

It is not a trade-off — it is an unfinished application of a rule this file already states.
The domain validator argues the exact principle at `index.ts:236-243` (the two quoted sentences are `:241-243`):

> *"…the provider answers it with a bare `HTTP 400` that names no field, because the response
> body is deliberately never surfaced (it can echo the key). Catching it here costs nothing and
> points at the offending entry."*

and the test suite commits to the same reasoning at `websearch.test.ts:1039-1040`: *"A 400 from
the provider would arrive as an opaque 'Exa search failed'; validating here names the argument
instead."* Date format (`:256-258`) and inverted range (`:341`) were both moved local on that
reasoning. `readCategory` (`:271-279`) validates only type and length, so the *combination* rule
is the one case the policy never reached.

Two constraints that shape the fix:

- **The provider body cannot simply be surfaced.** It is deliberately never read
  (`websearch/request.ts:32-36`, `:280-281`: *"Provider bodies are deliberately absent: they can
  contain the request (and therefore the key)"*), with `cancelBody(response)` at `:441`. "Pass
  through a better upstream message" would regress a documented security property.
- **Silently dropping the filter is wrong for the same reason the category echo is criticized**
  at `index.ts:457-460`: a caller that "cannot name a domain or a date range has to over-fetch
  and post-filter in its own context." Dropping `since` for `people` would return results the
  caller believes are date-filtered.

## Evidence

| Fact | Source |
|---|---|
| The description states the constraint | `src/tools/websearch/index.ts:462` |
| `readCategory` validates type and length only — no combination check | `src/tools/websearch/index.ts:271-279` |
| All four filters are passed to the adapter unconditionally | `src/tools/websearch/index.ts:528-539` (the five filter keys are handed over at `:533-537`) |
| The opaque fallback message | `src/tools/websearch/request.ts:300` (`${label} search failed (HTTP ${status}).`) |
| The stated local-validation policy | `src/tools/websearch/index.ts:236-243` |
| The test suite states the same policy | `src/tools/websearch/websearch.test.ts:1039-1040` |
| Sibling validations that already work | `index.ts:265` (ISO date), `:334` (non-empty query), `:341` (inverted range); asserted at `websearch.test.ts:792-793`, `:1051-1053` |
| Runtime 2026-11-10: all four combinations above → `Exa search failed (HTTP 400).`, deterministic across two query texts | live provider |
| Runtime: `category:"people"` alone and `category:"company"` alone both succeed, so the values are valid and only the pair fails | live provider |
| Runtime: `category:"news"` + `since` succeeds, and `category:"company"` + `excludeDomains` succeeds — so a fix must not over-reject | live provider |
| Runtime: a transient provider outage is a *different* message (`Exa could not be reached (network error)`), so the 400 is not flakiness | live provider |

## Proposal

Add the combination check to `readInvocation` **after** the per-field validators, so a precise
field error keeps precedence over a combination error:

```ts
if (category === 'people' && (since !== undefined || until !== undefined)) {
    throw new HarnessError('search category "people" does not support date filters. Drop "since"/"until", or use another category.');
}
if (category === 'company' && (since !== undefined || until !== undefined)) {
    throw new HarnessError('search category "company" does not support date filters. Drop "since"/"until", or use another category.');
}
if (category === 'people' && exclude !== undefined) {
    throw new HarnessError('search category "people" does not support "excludeDomains". Drop the category or the domain filter.');
}
```

Three traps for the implementer:

1. Gate on the **validated** `readDomains` result, not raw input — `excludeDomains: []` already
   throws `/array of 1-20 domains/` (`websearch.test.ts:1055`) and that ordering must not change.
2. `company` + `excludeDomains` must still pass; it is verified working.
3. Cover **both** `since` and `until`. Testing only `since` leaves the defect half-fixed.

**Alternatives considered.**

- *Silently drop the unsupported filter.* Rejected: it returns results the caller believes are
  filtered, which is the failure mode `:457-460` already rejects.
- *Surface the provider's 400 body.* Rejected: regresses the deliberate body suppression that
  protects the API key.
- *Leave it as a documentation-only rule.* Rejected: the same file already decided that
  provider-only constraints belong in local validation.

## Acceptance criteria

1. Each of the four combinations is refused before any provider request is made.
2. Each refusal names the category, the unsupported filter, and what to drop.
3. `people` alone, `company` alone, `company` + `excludeDomains`, and `news` + `since` all still succeed.
4. Field-level errors (`excludeDomains: []`, malformed date, inverted range) still take precedence.

## Tests to add

- `src/tools/websearch/websearch.test.ts` — beside the existing `rejects a malformed filter
  before paying for the request` (`websearch.test.ts:1038`): assert each of the four combinations throws its
  message **and** that the request counter stays at 0, so the local guarantee is proven, not
  assumed.
- `src/tools/websearch/websearch.test.ts` — the four still-valid combinations above resolve
  normally, guarding against over-rejection.

## Out of scope

- Surfacing provider response bodies.
- Validating `category` against a closed enum — the description deliberately keeps it open
  (`index.ts:457-462`).
- Tavily/Linkup adapter filter support (unverified; only Exa was exercised).

## Update (2026-11-11)

- **Re-anchored** (five cites moved, none by much): the local-validation policy comment is
  `src/tools/websearch/index.ts:236-243` — the two sentences this issue quotes are `:241-243`;
  the open-set category comment is `:457-460` (the issue cited `458-461`, and its
  out-of-scope cite `456-461` is now `457-462`); the adapter hand-off is `:528-539`, with the
  five filter keys passed unconditionally at `:533-537`; and two test cites were one line
  short — the `/array of 1-20 domains/` assertion is `src/tools/websearch/websearch.test.ts:1055`
  (not `1053`) and the test name `rejects a malformed filter before paying for the request`
  is `:1038` (its explanatory comment, which the issue quotes, is `:1039-1040`).
- **Re-verified exact, no edit needed**: the description sentence that already states the rule
  (`index.ts:462`, verbatim), `readCategory` at `:271-279`, the date rationale at `:256-258`
  and its throw at `:265`, the non-empty-query check at `:334`, the inverted-range check at
  `:341`, the assertions at `websearch.test.ts:792-793` and `:1051-1053`, and the
  body-suppression evidence in `src/tools/websearch/request.ts` (`:32-36`, `:280-281`,
  `cancelBody` at `:441`, the opaque message at `:300`).
- **Gap still open**: `grep -n 'does not support' src/tools/websearch/index.ts` matches only
  the description string at `:462`, so nothing enforces the combination; the proposal's
  placement (after the per-field validators) still matches the file's shape.
- The three live-provider rows are left **as recorded** (2026-11-10): re-running them costs
  provider spend and nothing in the tree suggests the provider's behaviour changed.
- Status stays **Open**.

## Update (2026-11-11) — closed

- **Shipped as proposed**, in argument validation only: `src/tools/websearch/index.ts:357-388`
  adds the three combination checks to `readInvocation` (comment `:357-371`, checks `:372-388`),
  after every per-field validator. The
  remaining field readers were hoisted out of the returned object literal
  (`src/tools/websearch/index.ts:344-355`) so the checks run on **validated** values — in the
  same evaluation order the literal used (`maxResults`, `provider`, `includeDomains`,
  `excludeDomains`, `category`, `speed`), so no existing field error lost precedence. No change
  to `src/tools/websearch/request.ts`: provider bodies stay unsurfaced, and the description
  sentence that already stated the rule (`src/tools/websearch/index.ts:508`) is unchanged.
- **Exact refusals** (`HarnessError`, thrown before `loadSearch`):
  `:372-376` `search category "people" does not support date filters. Drop "since"/"until", or
  use another category.` — `:378-382` the same sentence for `"company"` — `:384-388`
  `search category "people" does not support "excludeDomains". Drop the category or the domain
  filter.` `company` + `excludeDomains` and `news` + date filters are untouched.
- **Tests added**, in `src/tools/websearch/websearch.test.ts` inside
  `describe('provider filters')`, beside the existing `rejects a malformed filter before paying
  for the request` (`:1053`), using that test's request-counter stub (`stubFetch(async …)`):
  `refuses a category the provider cannot combine with a filter, before paying for the request`
  (`:1075`) asserts all six refused messages in full — `people`/`company` × `since` **and**
  `until`, `people` + `excludeDomains`, plus `category: "People"` to pin the case-folded compare —
  then `expect(requests).toBe(0)`; `keeps a precise field error ahead of a combination error`
  (`:1110`) runs `excludeDomains: []`, a malformed date, an inverted range and a bad `speed`
  **each with `category: "people"`**, so only these calls can prove the ordering;
  `still accepts the category and filter pairs the provider accepts` (`:1138`) resolves the four
  valid pairs and asserts the filters are still on the wire (`category`, `excludeDomains`,
  `startPublishedDate` per request body), so nothing was silently dropped.
- **Offline evidence:** `yarn vitest run src/tools/websearch/websearch.test.ts` → 58/58 (55
  before the change); with the source hunk reverted the same run is **1 failed | 57 passed**, the
  failure being the refusal test — so the local guarantee is pinned, not assumed.
  `src/server/websearch.test.ts` and `src/server/harnesses/catalogue.test.ts` (the other two
  files that touch this tool) pass unchanged; 68/68 across all three. `tsc --noEmit` and
  `eslint` on the changed source are clean.
- **Criteria met:** (1) all four combinations throw from `readInvocation` with the request
  counter at 0; (2) each message names the category, the unsupported filter, and what to drop;
  (3) `people` alone, `company` alone, `company` + `excludeDomains` and `news` + `since` all
  resolve and still send their filters; (4) field-level errors still win.
- **Drift in the cites above**, re-read against the tree before the fix: every `index.ts` and
  `request.ts` cite in the 2026-11-11 re-anchor re-verified **exact** (inverted range condition
  `:340`, throw `:341`; `readCategory` `:271-279`; description sentence verbatim; body suppression
  `request.ts:32-33` and `:280-281`, opaque message `:300`, `cancelBody` `:441` and `:452`). The
  two **test-file** cites were already 5 lines low — the test name is `:1043` (not `:1038`) and
  the `/array of 1-20 domains/` assertion is `:1060` (not `:1055`) — and this fix's 10 helper
  lines push them to `:1053` and `:1070`; the +46-line source change likewise shifts the
  description cite `:462` → `:508`, the open-set comment `:457-460` → `:503-506`, and the
  adapter hand-off `:528-539`/`:533-537` → `:574-585`/`:579-583`. The policy comment
  (`:236-243`) and `readCategory` sit above the edit and did not move.
- **Not covered by this fix** (still out of scope): the guard is provider-agnostic, so
  Tavily/Linkup combination behaviour stays unverified — only Exa was exercised; a provider that
  would accept `people` + `since` is now refused locally instead. Surfacing provider bodies, and
  closing `category` to an enum, remain out.
- Status is **Fixed**. The log's rule for a closed issue is to delete the file and drop the
  index row; the file is kept, with the row marked, so the fix can be reviewed against its issue
  in the same pass — the owner's integrated run decides, and deletion is then a one-command step.

# 0016 — `query` mode reports `truncated: true` with no `nextOffset`, and `truncated` conflates two causes

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11, fix)** at the bottom)
> **Severity:** Minor
> **Area:** `src/tools/webfetch/index.ts` (the `query` return path)
> **Date opened:** 2026-11-10

## Context

Found by stress-testing `fetch`'s `query` mode against long Wikipedia articles. `query` is
sold as "the cheap way to answer one question from a long page", but when it hits either of its
two limits the caller is told the answer is incomplete and given no way to continue. The
non-`query` path solved exactly this problem already; the `query` path never got the fix.

## Gap

In `query` mode the result object carries **neither `offset` nor `nextOffset`**, yet it can
still report `truncated: true`. Measured: `query="quantum"` on
`en.wikipedia.org/wiki/Quantum_mechanics` returned `characters: 60314, truncated: true,
matches: 20, totalMatches: 25` — five matching sections exist that the caller can see it did not
receive and cannot reach.

Two distinct causes share the one `truncated` flag, and they need opposite responses:

| Cause | Meaning | Right response |
|---|---|---|
| Serialized result hit the byte budget | more content exists for the *same* sections | re-fetch with `offset` — but `offset` is ignored in `query` mode |
| `MAX_QUERY_BLOCKS` (20) capped the section list | more *sections* exist | narrow the `query`, not page |

The consumer needs to know which limit it hit and what to do next.

## Why it is the way it is

Partly an oversight, partly an unstated contract. The non-`query` path was explicitly fixed for
this: `index.ts:662-665` — *"Where the NEXT window starts, present only when more exists. Every
other content tool in this harness pages; fetch used to be the one that silently lost the rest
of the document."* The `query` branch returns before that block and was not covered by the fix.

`offset` being ignored with `query` is a real design consequence — section selection runs on the
whole converted document (`index.ts:576-577` selects from `safeContent`, not `window`) — but it is
**nowhere documented**, so a caller that combines `query` with `offset` gets a silently ignored
argument.

The sibling tools already disambiguate the two causes with `stopReason`:
`glob.tool.ts:140` and `grep.tool.ts:250` report `resultCap | contentBudget | searchBudget |
complete`. `fetch` `query` mode has no equivalent.

## Evidence

| Fact | Source |
|---|---|
| `nextOffset` is emitted only on the non-`query` path | `src/tools/webfetch/index.ts:665` (`...(truncated ? { nextOffset: … } : {})`), reached only after the `query` branch returns |
| The `query` branch returns its own object, without `offset`/`nextOffset` | `src/tools/webfetch/index.ts:576-632` (the branch), returning its own object at `:605-631` — `characters`, `matches`, `totalMatches`, `matchMode`, `pageCharacters`, and no `offset`/`nextOffset` |
| `query` selection runs on the whole page, so `offset` is ignored | `src/tools/webfetch/index.ts:576-577` (the selection call is `:577` — `selectSections(safeContent, invocation.query, MAX_QUERY_BLOCKS)`, not `window`) (`selectSections(safeContent, …)` — not `window`) |
| The documented promise that `nextOffset` accompanies `truncated` | `src/types/index.ts:2269-2272` ("Present only when `truncated` is true, so resuming is a fact from the tool rather than a guess") |
| The section cap | `src/tools/webfetch/request.ts:121` (`MAX_QUERY_BLOCKS = 20`) |
| The cap is documented as bounding the answer | `src/tools/webfetch/sections.ts:96-98` ("a one-word query against a long page would otherwise match most of it and smuggle the whole document back") |
| Siblings disambiguate the cause | `src/tools/files/glob.tool.ts:140`, `src/tools/files/grep.tool.ts:250` (`stopReason`) |
| Runtime 2026-11-10: `query="quantum"` on Quantum_mechanics → `characters: 60314, truncated: true, matches: 20, totalMatches: 25`, **no `nextOffset`** | live fetch |
| Runtime: `query="surface code"` on Quantum_error_correction → 52,643 chars, `matches: 3`, `truncated: false` — so the flag is not always set, and its absence is meaningful | live fetch |
| The `no section matching` error already exists and is precise | `src/tools/webfetch/index.ts:595` |

## Proposal

1. **Emit `nextOffset` in `query` mode when the byte budget cut the answer**, so the caller can
   resume. When the cap rather than the budget caused the truncation, emit `matches`/
   `totalMatches` (already present) plus a `stopReason`-style cause, and no `nextOffset` —
   because paging is the wrong remedy there.
2. **Document that `offset` is ignored with `query`**, in the `offset` parameter description
   (`index.ts:405`) rather than only in source.
3. **Deprioritize, never exclude, low-value sections.** Sort matched sections by match density
   (`matches / sectionLength`) before applying the 20-block cap, so a 4 KB section with 3 hits
   outranks a 39 KB one with 3. Measured motivation: on the QEC article the `## References`
   section was ~39,600 of 52,643 characters (≈75%) of the returned payload.

**Alternatives considered.**

- *Exclude References / External links / See also by default.* Rejected: it breaks legitimate
  queries. `query="Bibcode"` returns exactly those two sections as its entire correct answer
  (verified: `matches: 2, totalMatches: 2`), so blanket exclusion would turn a correct answer
  into a "no section matching" error. The tool's contract is "the sections whose heading or text
  contain it", and it is currently met.
- *Cap each section's length.* Reasonable and complementary, but it changes what a returned
  section means and should follow the `stopReason` work, not precede it.
- *Say nothing and let the caller re-fetch without `query`.* Rejected: that is the expensive
  path the mode exists to avoid.

## Acceptance criteria

1. A `query` result with `truncated: true` caused by the byte budget carries `nextOffset`, and
   re-fetching with it returns further matching content.
2. A `query` result truncated by the 20-block cap reports the cause distinctly from a
   byte-budget cut, and does not promise a resumable `nextOffset`.
3. The `offset` parameter description states that `offset` is ignored when `query` is set.
4. Sections are returned in match-density order, with the ordering rule pinned by a test.

## Tests to add

- `src/tools/webfetch/webfetch.test.ts` — stub a long multi-section page and a `query` that
  matches more than `MAX_QUERY_BLOCKS` sections; assert the cap cause is reported and that
  `totalMatches > matches` is actionable. A second case where the byte budget is the cause
  asserts `nextOffset` is present and resumes correctly.
- `src/tools/webfetch/webfetch.test.ts` — assert `offset` is ignored with `query`, so the
  documented behavior is pinned rather than incidental.
- `src/harness.webfetch.test.ts` — the fields survive the tool envelope.

## Out of scope

- Excluding any section by name.
- Changing `MAX_QUERY_BLOCKS` itself.
- The markdown verbosity that inflates citation metadata (a link per identifier) — related, but
  it belongs with the converter work in 0012.

## Update (2026-11-11)

- **Re-anchored** (the `query` branch sits ~11 lines lower than filed, and two cites were
  stale by 3 lines): the branch is `src/tools/webfetch/index.ts:576-632` and its own return
  object is `:605-631`; the section selection that ignores `offset` is `:577`
  (`selectSections(safeContent, invocation.query, MAX_QUERY_BLOCKS)`); the `nextOffset`
  emission this issue contrasts with is `:665` (the comment quoted in "Why it is the way it
  is" is `:662-665`); `MAX_QUERY_BLOCKS = 20` is `src/tools/webfetch/request.ts:121`; the
  "bounds the answer" rationale is `src/tools/webfetch/sections.ts:96-98`; and the
  `nextOffset` contract in the types is `src/types/index.ts:2269-2272`.
- **Re-verified exact, no edit needed**: the `query` branch's early return means `:665` is
  unreachable with `query` — the asymmetry is unchanged; the no-match error is
  `src/tools/webfetch/index.ts:595`; the `offset` parameter description is `index.ts:405` and
  still never mentions `query` (`grep -n 'ignored with\|"query"' src/tools/webfetch/index.ts`
  returns nothing about the interaction), so proposal step 2 is still a real doc gap; the
  sibling `stopReason` precedents are `src/tools/files/glob.tool.ts:140` and
  `src/tools/files/grep.tool.ts:250`.
- The runtime rows are left **as recorded** (live 2026-11-10): re-running them costs provider
  spend, and the shape they describe is what the code at `:605-631` still produces.
- Status moved to **Fixed** — closing note below.

## Update (2026-11-11, fix) — closed

- **All three proposal steps shipped**, inside the existing rules (no cap change, no exclusion by
  section name).
  1. **`nextOffset` on a byte-budget cut.** `src/tools/webfetch/index.ts:703-705` computes it
     through `resumeOffsetForCut` (`:345-375`), which walks the emitted blocks with the same
     `sectionHeader` / `SECTION_SEPARATOR` layout the answer was built with (`:309-316`) and maps
     the cut back to an offset **in the converted page** — not in the joined answer — using
     `lineStartOffset(match.line)` as the search hint and the whole document as the fallback.
     2. **The cause is named.** `stopReason` (`:698-706`) reports which bound closed the answer,
     in the sibling vocabulary the issue cites (`glob.tool.ts:140`, `grep.tool.ts:250`):
     `'contentBudget'` ships a resume pointer, `'resultCap'` does not. 3. **Density ranking.**
     `src/tools/webfetch/sections.ts:148-190` ranks every matching section by hits per character
     (`countOccurrences:95`, `matchDensity:124`) and applies `maxBlocks` AFTER the sort, so the
     cap drops the thickest section instead of whatever came first; nothing is excluded.
- **Decisions worth knowing before re-reading the code.**
  - The field is **`stopReason`**, not the literal `cause` the proposal sketched — the issue's own
    wording was "a `stopReason`-style cause", and the two sibling tools already use this name with
    exactly these two values, so the shared vocabulary won. Contract:
    `src/types/index.ts:2423-2430`.
  - When **both** bounds close at once, `contentBudget` wins the name (`index.ts:690-697`): it is
    the one that ships a resume pointer, so it is the one the caller can act on.
  - Density is measured on the **trimmed** section text — the same string the caller receives —
    because ranking on the raw slice let a single trailing whitespace character reorder two
    otherwise-identical sections. Ties keep document order (`sections.ts:183`).
- **Criterion-by-criterion.** 1 — a budget cut carries `nextOffset`, and a test proves it resumes:
  re-fetching at it returns content containing the markers of the sections the cut answer never
  delivered (`webfetch.test.ts:1685-1704`). 2 — a cap cut reports `'resultCap'` with
  `nextOffset` absent and `totalMatches > matches` actionable (`:1628-1641`). 3 — the `offset`
  parameter description now says it is ignored with `query` and what each cause means
  (`index.ts:481`), pinned by a test (`:1794-1803`). 4 — density order is pinned exactly, not as a
  range (`:1723` expects `['Details', 'Intro', 'References']`).
- **A consequence the issue did not spell out, now documented in three places.** The resume offset
  counts converted-page characters, and `offset` is ignored while `query` is set — so resuming a
  query answer means **re-fetching at `nextOffset` without `query`**. Stated in the parameter
  description (`:481`), in the `nextOffset` contract comment
  (`src/types/index.ts:2400-2406`), and in the branch itself (`index.ts:738-744`). Query mode also
  stops echoing `offset` entirely: selection runs on the whole page, so echoing a number read as
  "your offset was applied" (`index.ts:745-748`, test `:1754-1772`).
- **Proximity answers** (no heading structure) keep their existing note and now also report
  `stopReason: 'resultCap'` with no `nextOffset` when occurrences were withheld — paging reaches
  other parts of the page, not the withheld sections (`:1774-1792`).
- **Public surface.** `WebFetchResult.stopReason` is a new optional field (additive);
  `nextOffset`'s query-mode semantics are newly written down. The contract lives in
  `src/types/index.ts`, which is outside this issue's declared area — flag for the package owner.
- **Anchors this fix moved**: the `query` branch 576-632 → `index.ts:652-751`; the `offset`
  description 405 → 481; `selectSections` → `sections.ts:148`; `nextOffset` in the types →
  `:2400-2406`. `MAX_QUERY_BLOCKS = 20` is unchanged, still pinned as a number by a test
  (`webfetch.test.ts:1626`).
- **Tests** (`src/tools/webfetch/webfetch.test.ts:1599-1804`, envelope in
  `src/harness.webfetch.test.ts:418` and `:444`). Cap and ranking are asserted separately, as the
  issue's test note asked: the cap case gives every section equal density so only the cap can
  reorder it, and the two ordering cases assert the opposite of document order (a 2,000-character
  `## References` block last; a 6,000-character wall dropped by the cap while all twenty thin
  sections survive). The budget case pins the resume offset to the character
  (`page.indexOf('## Section 05') + 3243`) and then proves it by re-fetching.
- **Not done here** (as scoped): the per-section length cap, which the issue wants to follow this
  work, and the markdown verbosity that inflated the measured payload (tracked in 0012 — density
  ranking shrinks its blast radius, it does not remove it).
- **Verification.** `vitest run src/tools/webfetch/webfetch.test.ts src/harness.webfetch.test.ts`
  → 106 passed; `tsc --noEmit -p .` → clean; `vite-node scripts/generate-tool-manifest.mjs
  --check` → current. The live QEC/Wikipedia rows were not re-run (provider spend); the ordering,
  cap and budget cases they describe are reproduced offline by the fixtures above.

# 0016 — `query` mode reports `truncated: true` with no `nextOffset`, and `truncated` conflates two causes

> **Status:** Open
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
this: `index.ts:664-666` — *"Where the NEXT window starts, present only when more exists. Every
other content tool in this harness pages; fetch used to be the one that silently lost the rest
of the document."* The `query` branch returns before that block and was not covered by the fix.

`offset` being ignored with `query` is a real design consequence — section selection runs on the
whole converted document (`index.ts:565-568` slices `safeContent`, not `window`) — but it is
**nowhere documented**, so a caller that combines `query` with `offset` gets a silently ignored
argument.

The sibling tools already disambiguate the two causes with `stopReason`:
`glob.tool.ts:140` and `grep.tool.ts:250` report `resultCap | contentBudget | searchBudget |
complete`. `fetch` `query` mode has no equivalent.

## Evidence

| Fact | Source |
|---|---|
| `nextOffset` is emitted only on the non-`query` path | `src/tools/webfetch/index.ts:666` (`...(truncated ? { nextOffset: … } : {})`), reached only after the `query` branch returns |
| The `query` branch returns its own object, without `offset`/`nextOffset` | `src/tools/webfetch/index.ts:595-640` |
| `query` selection runs on the whole page, so `offset` is ignored | `src/tools/webfetch/index.ts:565-568` (`selectSections(safeContent, …)` — not `window`) |
| The documented promise that `nextOffset` accompanies `truncated` | `src/types/index.ts:2235-2238` ("Present only when `truncated` is true, so resuming is a fact from the tool rather than a guess") |
| The section cap | `src/tools/webfetch/request.ts:124` (`MAX_QUERY_BLOCKS = 20`) |
| The cap is documented as bounding the answer | `src/tools/webfetch/sections.ts:93-95` ("a one-word query against a long page would otherwise match most of it and smuggle the whole document back") |
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

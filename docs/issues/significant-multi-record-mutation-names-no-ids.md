# 0008 — A multi-record mutation returns no `entry`, and additions/patches never got the `removedIds` fix

> **Status:** Open
> **Severity:** Significant
> **Area:** `src/core/records.ts` (mutation result shape), `src/tools/runtime/records.tool.ts` (`limit` description)
> **Date opened:** 2026-11-09

## Context

Found by stress-testing the store from 7 threads across 5 agents. The documented recipe
for a cheap write is "pass `limit: 1` on any add, patch or remove whose list you do not
need" (`records.tool.ts:131`), because the record the call changed arrives in `entry`
whatever `limit` says. That holds for exactly one changed record. A batch that adds two
records and follows the advice gets back a one-item page of unrelated survivors and
**nothing naming what it just created** — the caller cannot confirm its own write landed
without a second round trip, which is precisely the problem M3 already solved for removals.

## Gap

A caller that mutates more than one record cannot tell, from the result alone:

- **which ids an addition minted.** Two adds with `limit: 1` return no `entry` and no id
  list; the new records are recoverable only by paging the collection.
- **which records a patch changed.** Same shape: `entries` is the page, not the changed
  set, and it is capped by the `limit` the caller was told to shrink.
- Removals already do not have this problem — `removedIds` exists for exactly this reason
  (`:3351-3353`, "the caller had to re-read the list to confirm its own write landed",
  `:3339-3340`). The asymmetry is an unfinished fix, not a design rule: the same ~20 bytes
  close the gap for adds and patches.

## Why it is the way it is

Partly deliberate. `entry` is singular-only by rule (`affected.length === 1` at `:2929`)
so that the action wrappers can answer `add`/`update` with a single typed record, and the
M3 comment at `:3337-3343` states the trade-off explicitly: the bodies stay withheld and
"the un-wrapped `records` surface answers with the full array" (`:3328-3329`). Widening
`entry` to a union would break that pin.

What is **not** deliberate is that the `removedIds` remedy was applied to removals only.
The comment names the reason (`a caller that removes several records still gets the full
array`) and that reason applies identically to additions.

## Evidence

| Fact | Source |
|---|---|
| `entry` is emitted only when exactly one record was affected | `src/core/records.ts:2929-2938` (`if (affected.length === 1) result.entry = …`) |
| Removals of two or more got a dedicated id list | `src/core/records.ts:3336` (`removed` singular) and `:3351-3353` (`removedIds` when `length > 1`), inside the wrapper `shaped` object at `:3330` |
| The stated reason for `removedIds` is caller self-confirmation | `src/core/records.ts:3337-3340` ("returned only a survivor page and the caller had to re-read the list to confirm its own write landed") |
| The tool description tells callers to shrink `limit`, promising `entry` | `src/tools/runtime/records.tool.ts:131` ("a record the call changed arrives in `entry` … but a batch that changed SEVERAL records answers with the page only, so do not shrink `limit` then") |
| The page is a plain projection, so it does not contain the changed set | `src/core/records.ts:2915-2923` (`project(state, { offset, limit, … })` runs regardless of what the batch touched), with `removed` bolted on at `:2925` |
| The log's own rule against count-dependent types | `src/core/records.ts:3344-3348` ("`removed` keeps one stable type … `removedIds` keeps another … so a caller never has to branch on count") |
| Runtime, 2026-11-09: `records { collection: "unicode", entries: [{s:"c1"},{s:"c2"}], limit: 1 }` → no `entry`, no `removed`, one unrelated page row; ids 256/257 recovered only at `offset: 39` | live session store |
| Runtime, same pass: two patches with `limit: 1` → no `entry` (page only), while a single patch returns `entry` | live session store |

## Proposal

Mirror M3 rather than invent a new shape:

1. Emit **`addedIds: string[]`** when a batch mints more than one record, and
   **`changedIds: string[]`** when it patches more than one, beside the existing
   `removedIds`. Keep `entry` singular-only so every existing pin stays exact, and keep
   each key one stable type (never `T | T[]`) for the same reason `:3344-3348` gives.
2. Emit them whatever `limit` says, so the documented `limit: 1` recipe stays cheap and
   still self-confirms.
3. Update the `limit` sentence at `records.tool.ts:131` to name the three id lists, and
   regenerate the manifest (`npm run tools:manifest`).

**Alternatives considered.**

- *Always return the full page for a multi-record batch.* Rejected: it is what the doc
  already says, and it costs the caller a scan of unrelated rows to find its own writes.
- *Widen `entry` to `RecordEntry | RecordEntry[]`.* Rejected: `:3344-3348` rules out
  count-dependent types for exactly this reason, and the wrappers unpack `entry` as one
  record.
- *Tell callers to re-read.* Rejected: it doubles the round trips of the batch API, which
  exists to avoid that.

## Acceptance criteria

1. A batch that adds N>1 records returns the N new ids without the caller paging.
2. A batch that patches N>1 records returns the N changed ids likewise.
3. Both hold with `limit: 1`, and neither changes the type of `entry` or `removed`.
4. The `limit` description names the id lists, and the generated manifest matches.

## Tests to add

- `src/core/records.test.ts` — two adds → `addedIds` has both, in mint order; two patches
  → `changedIds`; one add → `entry` and **no** `addedIds` (the M3 "at exactly one the
  singular already says everything" rule).
- `src/harness.records.test.ts` — the same through the `records` tool entry point, and
  that `tasks` (`style: batch`) answers a multi-add with ids.
- `scripts/check-package-tools.mjs` / manifest pin — the reworded `limit` description is
  regenerated, not hand-edited.

## Out of scope

- Changing `entry` into a collection, or dropping the singular rule.
- Returning full bodies for a multi-record batch (the page budget is the point).
- The `counts`/`page` shape of an unscoped read (0007, Documentation).

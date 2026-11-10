# 0010 — `define` beside `collection` is refused on one path and silently ignored on the other

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/core/records.ts` (`runCall`, `executeCollection`), `src/tools/runtime/records.tool.ts` (`define` description)
> **Date opened:** 2026-11-09

## Context

`define` is documented as something to pass "on its own". A caller that passes it with a
`collection` anyway gets one of two answers depending on which code path handles the call:
the engine refuses it as ambiguous, or the tool entry point registers the collection and
discards `collection` without a word. During the stress test the silent branch won every
time, and the response echoed a *different* collection name than the one sent — which
reads like the write went to the named collection when it did not.

## Gap

A caller cannot rely on `collection` being honoured, and is not told it was dropped:

- `records { collection: "unicode", define: { name: "verifyG", … } }` **succeeded**; the
  response said `"collection": "verifyG"`, not `"unicode"`, with no warning.
- The engine's own comment calls the same combination "ambiguous and refused, not merged"
  and throws for it — so the intended contract is refusal, and one path enforces it while
  the entry point that actually runs bypasses it.
- The tool description says only "pass `define` … on its own", which is advice, not an
  enforced rule, and gives no reason to expect a refusal.

## Why it is the way it is

Deliberate ordering, stated in the code: `define` is checked first "so `records({ define })`
is not read as an unknown-collection typo" (`:3569-3571`). That is the right reason to
short-circuit early — and the cost is that a `collection` riding along is consumed by the
short-circuit before `findCollection` can object. The refusal at `:2721` was written for
the same case and is not reached from this entry point.

## Evidence

| Fact | Source |
|---|---|
| The tool path returns before the collection is ever resolved | `src/core/records.ts:3572-3574` (`if (raw.define !== undefined) return defineCollection(…)`), ahead of `findCollection` at `:3588` |
| The engine path refuses the same input as ambiguous | `src/core/records.ts:2721-2726` (comment "ambiguous and refused, not merged" at `:2718-2720`; the message `records "define" registers a NEW collection, so it takes no "collection" beside it.` is at `:2724`) |
| The refusal is unreachable from the tool entry point that sees `define` first | `src/core/records.ts:3572-3574` vs `:2721` — the `records` surface enters `executeCollection` only at `:3590`, after the early return, so it cannot reach the refusal. Traced 2026-11-11: `executeCollection` has exactly two call sites, and the other is the **wrapper** path at `:3596`, whose input is built by `toCollectionInput`; the batch-style branch copies the caller's parameters verbatim (`{ ...raw }` at `:3323`), so a `define` reaching a `tasks`-style wrapper does hit `:2721`. Whether a wrapper schema admits an undeclared `define` in the first place is **unconfirmed** (the schema layer was not traced), so the refusal may still be dead in practice — but the wrapper path, not the `records` path, is where it lives |
| `define` is documented as advice only | `src/tools/runtime/records.tool.ts:40` ("Pass `define` { … } **on its own** to register a NEW collection") |
| Runtime, 2026-11-09: `{collection:"unicode", define:{name:"verifyG",…}}` → accepted, response `"collection":"verifyG"`, `verifyG` appeared in the collections list, `drop` then removed it | live session store |

## Proposal

Pick one contract and enforce it at the single entry point:

1. **Refuse** `collection` + `define` in `runCall` before the short-circuit, reusing the
   existing message from `:2724`. This matches the engine's stated intent and the
   "on its own" wording, and it is one moved check.
2. Delete or re-point the refusal at `:2721` so the rule lives in one place.
   It is reachable from exactly one other caller — the wrapper path at `:3596` (see the Evidence row) — so keeping it means adding a comment that names that caller and says the `records` surface never gets here.
3. Say the enforced rule in the `define` description (`records.tool.ts:40`) and
   regenerate the manifest.

**Alternatives considered.**

- *Ignore `collection` and document it.* Rejected: the engine already declares the
  combination ambiguous, and a silently discarded argument is the failure mode this log's
  rules exist to prevent — the caller gets a confident success naming a different
  collection.
- *Treat `collection` as the target of `define`.* Rejected: `define` names its own
  collection, so the argument has no meaning to keep.

## Acceptance criteria

1. `collection` + `define` is rejected on every entry point, with the same wording.
2. No code path registers a collection while discarding a supplied `collection`.
3. The tool description states that the combination is an error, and the manifest matches.

## Tests to add

- `src/core/records.test.ts` — `executeRecords({ collection: "tasks", define: {…} })`
  throws `invalid-input` and registers nothing (assert the collections list is unchanged).
- `src/harness.records.test.ts` — the same through the `records` tool, and that
  `records({ define })` with no `collection` still succeeds exactly as today.

## Out of scope

- Re-`define` semantics (an existing name is already refused rather than merged).
- Whether `define` should accept a `drop` in the same call.
- The `drop` + `collection` pairing, which is correct today.

## Update (2026-11-11)

- **Re-anchored** — both regions moved by ~120 lines. Current ranges: the short-circuit and
  its rationale are `src/core/records.ts:3569-3574` (the `raw.define !== undefined` return is
  `:3572-3574`) and `findCollection` is now `:3588`; the ambiguity refusal is `:2721-2726`
  (the "ambiguous and refused, not merged" comment at `:2718-2720`, the message at `:2724`).
  `src/tools/runtime/records.tool.ts:40` still carries the "Pass `define` … on its own"
  advice verbatim and was left alone.
- **The unconfirmed reachability claim is now resolved** (it was the one open question in
  the issue). `executeCollection` has exactly two call sites:
  `src/core/records.ts:3590` (the `records` surface — `define` was consumed by the early
  return at `:3572`, so this one can never reach `:2721`) and `:3596` (the wrapper path,
  whose input comes from `toCollectionInput`). The batch-style branch of `toCollectionInput`
  copies the caller's parameters verbatim (`{ ...raw }` at `:3323`), so a `define` arriving
  through a `tasks`-style wrapper **does** reach the refusal. What remains **unconfirmed** is
  narrower: whether a wrapper's JSON schema lets an undeclared `define` through at all — the
  schema layer was not traced — so the refusal may be live only for a driver that calls the
  wrapper directly. Proposal step 2 should be read with that in mind: the refusal is not
  dead code, it just has one caller.
- **Note for whoever picks this up**: `src/tools/runtime/records.tool.ts:157-158` cites
  `src/core/records.ts:2596-2626` for the `describe` guard; that range is the page-shape code
  now, and the guard is at `:2743` onward. Code comment, so it moves with the change.
- The runtime row is left **as recorded** (live session store, 2026-11-09).
- Status stays **Open**.

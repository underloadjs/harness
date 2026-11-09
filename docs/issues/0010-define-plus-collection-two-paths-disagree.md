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
is not read as an unknown-collection typo" (`:3437-3439`). That is the right reason to
short-circuit early — and the cost is that a `collection` riding along is consumed by the
short-circuit before `findCollection` can object. The refusal at `:2603` was written for
the same case and is not reached from this entry point.

## Evidence

| Fact | Source |
|---|---|
| The tool path returns before the collection is ever resolved | `src/core/records.ts:3440-3442` (`if (raw.define !== undefined) return defineCollection(…)`), ahead of `findCollection` at `:3456` |
| The engine path refuses the same input as ambiguous | `src/core/records.ts:2603-2608` (comment "ambiguous and refused, not merged" at `:2600-2602`; the message `records "define" registers a NEW collection, so it takes no "collection" beside it.` is at `:2606`) |
| The refusal is unreachable from the tool entry point that sees `define` first | `src/core/records.ts:3440-3442` vs `:2603` — `executeCollection` is entered only at `:3458`, after the early return. Whether any other caller reaches `:2603` is **unconfirmed** (not traced beyond these two sites) |
| `define` is documented as advice only | `src/tools/runtime/records.tool.ts:40` ("Pass `define` { … } **on its own** to register a NEW collection") |
| Runtime, 2026-11-09: `{collection:"unicode", define:{name:"verifyG",…}}` → accepted, response `"collection":"verifyG"`, `verifyG` appeared in the collections list, `drop` then removed it | live session store |

## Proposal

Pick one contract and enforce it at the single entry point:

1. **Refuse** `collection` + `define` in `runCall` before the short-circuit, reusing the
   existing message from `:2606`. This matches the engine's stated intent and the
   "on its own" wording, and it is one moved check.
2. Delete or re-point the now-redundant refusal at `:2603` so the rule lives in one place.
   If it is reachable from another caller, keep it and add a comment naming that caller.
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

# 0010 — `define` beside `collection` is refused on one path and silently ignored on the other

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11) — closed**)
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

## Update (2026-11-11) — closed

- **Shipped as proposed, both steps, with the enforcement moved one line earlier than step 1
  describes.** The pair is now refused in `dispatchCall` (`src/core/records.ts:3823-3825`) —
  the single point every `records` call passes — **before** the `define` short-circuit at
  `:3830`, not inside `executeCollection` after it. That placement is deliberate: the
  short-circuit is the reason the pair ever disagreed, and a guard under it can only ever
  cover the wrapper path. `undefined` is treated as absence, so `records({ define })` alone —
  the documented call and the only way to register a collection — is untouched, which is
  acceptance criterion 2.
- **The engine guard stays** (`:2903-2904`, inside `executeCollection`, where a
  tasks/chapters-style wrapper arrives with its `define` verbatim, `{ ...raw }` at `:3551`),
  so the pair is refused whichever door it comes through. Its comment now says who reaches it
  and who does not, and both sites share one string:
  `DEFINE_WITH_COLLECTION_MESSAGE` (`:265-266`). The refusal, byte-identical on both paths:
  `invalid-input: records "define" registers a NEW collection, so it takes no "collection"
  beside it.` **Nothing is registered and nothing is dropped** — the refusal throws before
  either branch runs, pinned by `listCollections()` still listing `{'chapters','locations',
  'profiles','tasks'}` with `counts.total === 4`.
- **The "unconfirmed" premise in the 2026-11-11 update is now settled, and it went the other
  way.** A `define` does **not** reach the wrapper's engine guard through the JSON-schema layer:
  `src/tools/runtime/tasks.tool.ts:170` sets `additionalProperties: false` and never declares
  `define`, and the schema runs on every path (`src/harness.ts:11226` — "A manual call
  therefore cannot skip the schema" — enforced in `src/core/schema-validation.ts:213`). So a
  `tasks({ collection, define })` call is refused one layer earlier with
  `tasks must not include the additional property "define".`, while the engine guard is live
  for a driver that calls the engine directly (`src/core/records.ts` via `records`, and
  `src/server/workers/lane-authority.ts:594`). Both refusals are pinned
  (`src/harness.records.test.ts:739`), so the sentence "the refusal is not dead code, it just
  has one caller" is now a fact with a named caller rather than a guess.
- **Step 2 — the description states what is enforced** (`src/tools/runtime/records.tool.ts:40`
  and the `define` parameter at `:187`): `define` is "on its own (no other field)", a
  `"collection"` beside it "is an error, never a merge that discards the collection you
  named", and the tool description carries the same clause. The generated manifest
  (`src/core/tool-manifest.ts`) was regenerated with `yarn tools:manifest`, and
  `yarn tools:manifest:check` exits 0; a test asserts the shipped tool parameter and the
  manifest carry the identical sentence (`src/harness.records.test.ts:753`), because the
  description is the one place a model reads this rule.
- **Accepted alternative**: the **separate action** ("a `define` action distinct from a batch,
  so the pair is unrepresentable") is the redesign this issue rejects; sharing the message
  constant is the cheap half of the same idea — one wording, two doors.
- **Drift noted and fixed**: the `describe`-guard cite in `src/tools/runtime/records.tool.ts`
  read `src/core/records.ts:2596-2626` (the 2026-11-11 update guessed `:2743`); the guard is at
  **`:2928-2959`** and the comment now says so. The issue's own `:2497-2502` / `:3404-3420`
  cites moved to **`:2903-2904`** (its reachability note at `:2893-2902`) and
  **`:3823-3825`**, and `defineCollection` — `:2308-2310` when this was filed — is at
  **`:3292`**. All of it moved while 0008 and 0011 landed in the same file.
- **Tests**: `src/core/records.test.ts:984` (engine refuses the pair, exact message, nothing
  registered), `:1005` (the wrapper route answers the identical sentence and the storeRev
  counter still moves — no half-applied write), `:1024` (`define` alone still registers:
  the result is `{ name, fields, collection: 'quests', storeRev: 0 }` and the name appears in
  `listCollections()`); `src/harness.records.test.ts:689` (the tool end to end: `err.message`,
  `err.code === 'invalid-input'`, `err.details.field === 'define'`, both collections absent
  from `listCollections()`), `:710` (`define` alone through the tool), `:739` (the schema
  refusal above), `:753` (description + manifest carry the clause).
- **Evidence** (offline, deterministic; 2026-11-11):
  - `yarn vitest run src/core/records.test.ts src/core/records.store-events.test.ts
    src/harness.records.test.ts src/harness.task.test.ts` — **112 passed** (101 in those same
    files before the fix).
  - The same command over the 11 records-adjacent files (the four above plus
    `src/core/schema-validation.test.ts`, `src/tools/runtime/threadRead.test.ts`,
    `src/server/workers/lane-authority.test.ts`,
    `src/server/workers/lane-authority.request-scope.test.ts`, `src/harness.tool-list.test.ts`,
    `src/harness.discovery.test.ts`, `src/core/tool-discovery.test.ts`) — **242 passed**.
  - `npx tsc --noEmit` — clean (exit 0); `yarn tools:manifest:check` — exit 0, so the
    regenerated manifest and the shipped descriptors cannot have drifted apart.
  - **Negative control**: with ONLY the 0010 entry-point guard (and the 0009 payload) reverted
    — the engine guard and every other in-flight change kept — `yarn vitest run
    src/core/records.test.ts src/harness.records.test.ts src/harness.task.test.ts` answers
    **7 failed / 87 passed**, and only the two entry-point paths lose: `src/core/records.test.ts`
    `0010: records refuses define beside a collection and registers nothing` and
    `src/harness.records.test.ts` `0010: the records tool refuses define beside a collection
    and registers nothing`. The wrapper-route pins (`records.test.ts:1005`, refused by the
    engine guard, which stayed in place) and the schema pin (`harness.records.test.ts:739`)
    still pass, exactly as the reachability note predicts. `src/core/records.ts` was restored
    byte-for-byte (sha `d918fadc…`) and re-ran green at 94/94.
- **Not covered by these tests**: `chapters`/`profiles`/`locations` have no separate pair test
  (they route through the same `executeCollection` guard as `tasks`); no wire type changed, so
  `docs/contracts/harness-api.md` needed nothing.
- Status: **Fixed 2026-11-11**.

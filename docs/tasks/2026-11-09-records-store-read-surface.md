# Records store — the read surface loses single-record results and mixes two page orders

Status: **fixed 2026-11-09** — all seven defects implemented and independently reviewed; see "Resolution" at the end. **Re-verified against the current tree on 2026-11-11** — every closure still holds and the pinned test blocks are unchanged; the Resolution's source anchors have drifted and `## Update (2026-11-11)` at the end records their current locations.
Produced by a live stress test of the five store tools from inside a running
session, then re-verified by two independent reviewing agents, then grounded against the source.
Seven defects were open (R1–R7); five first-pass claims were overturned or restated and are kept
below marked `corrected`, because the reasoning is auditable and because two of them are things a
verifier will otherwise re-report.

This file is about the **read and result-shaping** surface only. The write path — the CAS token,
`mergeDisjoint`, atomicity, per-collection `storeRev` — was exercised hard and held up; it is
recorded under "What held up" so a verifier does not re-litigate it.

Line numbers describe the working tree reviewed on 2026-11-09. The names and the reproduction
calls are the durable anchors; the *drift check* at the end lists the commands to re-verify.

## Date / Method / Scope

**Date:** 2026-11-09.

**Method (three passes, in this order):**

1. **Black-box stress test** — roughly 60 tool calls against a live session store through
   `tasks`, `records`, `profiles`, `chapters`, `locations`: batch adds, guarded and unguarded
   patches, stale tokens, `mergeDisjoint`, removals, `define`/`drop`, offset and keyset paging,
   `since` change feeds, and every cap and validation edge reachable from the tool schema.
2. **A real two-agent race** — a `workspace` subagent was delegated a write to the same record
   the primary agent was writing, with no ordering between them.
3. **Independent re-verification** — a `reviewer` and a `research` agent, each given a fixture
   they could re-run, reproduced or refuted each claim without seeing this file. Their raw tool
   results were read out of their own transcripts, not taken from their summaries.

Every finding below was then confirmed against the source and carries a `path:line`. A claim
that could not be grounded is marked `unconfirmed`.

**Scope:** `src/core/records.ts` (the engine), `src/core/task.ts` and the four built-in specs,
`src/tools/runtime/tasks.tool.ts` (the batch wrapper schema), and the wrapper projection
`toWrapperResult`.

**Out of scope:** persistence and restore (`src/server/persistence.ts`), tool discovery and
declaration (`src/core/tool-discovery.ts`), and the write-path concurrency proof, which passed.

## The fixture, so every claim below is re-runnable

R2, R3 and R4 depend on a collection that declares a `sortable` field. Build it exactly like
this, or the reproduction will not reproduce:

```jsonc
// records: define a collection with a sortable integer field
{
  "collection": "notes",
  "define": {
    "name": "d2fixture",
    "fields": [
      { "key": "label", "type": "text", "required": true },
      { "key": "prio",  "type": "integer", "sortable": true }
    ]
  }
}

// records: five adds, in this insertion order
{ "collection": "d2fixture", "entries": [
  { "label": "A", "prio": 5 }, { "label": "B", "prio": 1 }, { "label": "C", "prio": 9 },
  { "label": "D", "prio": 3 }, { "label": "E", "prio": 7 }
]}
```

The engine mints ids from one monotonic counter (`records.ts:2362-2377`), so the ids are
**consecutive and ascending in insertion order**. In the observed run they were 81–85, giving:

| id | prio | |
|---|---|---|
| 81 | 5 | |
| 82 | 1 | |
| 83 | 9 | |
| 84 | 3 | |
| 85 | 7 | |

Two orders therefore differ on this fixture, which is the whole point:

* **page order** (`prio` ascending) = `82, 84, 81, 85, 83`
* **id order** = `81, 82, 83, 84, 85`

Substitute the ids your run actually minted; the arithmetic, not the literals, is what matters.

## What held up (do not re-litigate these)

| Behaviour | Evidence |
|---|---|
| An unguarded patch is refused and the whole call stays atomic | `guarded-write` refusal; the sibling record in the same batch was untouched |
| A stale `expects` token is refused and **carries the current record** | `staleRecordError` at `records.ts:1084-1114`, required by R9 ("one round trip, not two", `records.ts:38-40`) |
| `mergeDisjoint: true` applies a disjoint stale patch, and refuses when both sides set the same field | applied (rev 2→3); refused at `records.ts:1529` (`cannot merge "completed" because this patch sets it too`) |
| A no-op patch bumps neither `rev` nor `storeRev` | observed; `pushChange` only fires on a real write (`records.ts:2051`) |
| `storeRev` and the `since` feed are **per collection** | writing `notes` moved its `storeRev` 6→7 while `tasks` stayed at 5; the design reason is Decision B (`records.ts:26-35`) |
| The race is safe | the subagent read `rev: 3` (the primary's concurrent write had landed), patched with the correct token, and `updatedBy`/`updatedThreadId` were attributed to `workspace`/`thread-2`, not to the primary (`writeAttribution`, `records.ts:2278-2283`) |
| `define` validation is strict and atomic | required field, enum values, `maxLength`, `maxItems`, `maxRecords`, reserved keys, empty enum `values`, unknown field, unknown collection, re-`define`, drop-when-non-empty, drop-a-built-in — each refused with a specific code |
| `sortable`, `getOnly`, and count facets work | page came back prio-ascending; `getOnly` fields withheld from pages and returned on a single-record read (`copyEntry`'s `full` flag, `records.ts:289-292`); facets counted correctly |
| Batch apply order is patches → removals → additions | observed, and stated in the tool description |

## Findings

### R1 — the batch wrapper throws away every single-record result the engine produced

**Observed.** `tasks` with `{"ids":["2"]}` returned a **successful** response containing
`"tasks": []` for an id that exists. Two ids returned both records. A nonexistent id returned
an `unknown-record` **error**. So the empty list is not a not-found signal — it is a lost result.

**Cause, in the source.** For a single lookup the engine deletes `entries` and sets `entry`
instead (`records.ts:2253-2258`):

```ts
if (plan.lookups.length === 1) {
    const [only] = readIds(state, plan.lookups);
    delete result.entries;
    result.entry = only;
}
```

The batch wrapper projection then reads only `entries` (`records.ts:2661-2680`):

```ts
if (wrapper.style === 'batch') {
    const shaped: Record<string, unknown> = {
        [wrapper.plural]: result.entries ?? [],   // <-- entry is never read
        counts: result.counts,
        page: result.page,
        storeRev: result.storeRev
    };
```

`result.entries` is `undefined` after the delete, `?? []` turns that into an empty array, and
`result.entry` is dropped on the floor. **The same branch also drops `entry` on a write**: the
engine sets it for a single affected record (`records.ts:2395`), and a one-task add through
`tasks` returns the page without it.

**This is a contract violation, not a design choice.** The wrapper's own schema promises the
opposite of what it does — `src/tools/runtime/tasks.tool.ts:70`:

> `Task ids to read, for when you want one record rather than a page. One id answers with "entry", several with "entries".`

**Scope.** Wrapper-specific, not engine-level. `records` returns `entry` correctly for one id
(confirmed independently, including with `since` alongside it), and the three `action`-style
wrappers take a single `id` and work (`chapters`/`profiles`/`locations` `get`). Only the
`batch` style is affected — which is `tasks` alone today (`src/core/task.ts:51`,
`wrapper: { tool: 'tasks', plural: 'tasks', singular: 'task', style: 'batch' }`).

*Task:* **T1.1** — in the `batch` branch of `toWrapperResult`, carry `entry` through when the
engine set it, i.e. add `...(result.entry === undefined ? {} : { entry: result.entry })`.
*Check:* a test asserting `tasks {"ids":[<existing id>]}` returns an `entry` equal to the record,
and that a single-record add returns `entry` as well as the page; the sentence at
`tasks.tool.ts:70` becomes true without editing it.

### R2 — offset and keyset paging enumerate two different orders, and the API hands you a cursor that is wrong across them

This is the one that silently loses data. Read it carefully; the wording below is exact.

**Observed, on the fixture.**

| call | returned | page |
|---|---|---|
| `{limit: 2}` (offset mode) | ids **82, 84** | `hasMore: true`, `nextOffset: 2`, **no `nextAfterId`** |
| `{afterId: "84", limit: 2}` | id **85** only | `hasMore: false` |
| `{afterId: "82", limit: 2}` | ids **83, 84** — id order, not prio order | `nextAfterId: "84"` |
| offset walk to exhaustion | 82, 84, 81, 85, 83 — **all five** | correct |

Following the cursor the API offers from an offset page therefore yields **{82, 84, 85} and
stops**, while `counts.total` reports 5 throughout. Ids 81 and 83 are never seen and the caller
has no signal that the walk was truncated.

**Cause.** The two modes deliberately use different orders (`records.ts:2079-2084`):

```ts
const keyset = request.afterId !== undefined;
const ordered = keyset
    ? [...state.items].sort((left, right) => Number(left.id) - Number(right.id))
    : orderedFor(definition, state.items);
```

The id re-sort is intentional and commented (`records.ts:1597-1599`): *"A sortable collection's
id order and its display order differ, which is exactly why keyset mode re-sorts by id rather
than reusing the page order."* It is also pinned by a test (`src/core/records.test.ts:94-99`).
**Keyset mode on its own is complete and correct** — walking `afterId` from below the minimum id
returns all five in id order. The defect is the seam between the modes:

1. An offset page emits `nextOffset` but **never** `nextAfterId` (`records.ts:2110-2116` — the
   two are assigned on exclusive branches). So the only cursor a caller can invent when switching
   is the last id it saw.
2. On a sortable collection the last id of an offset page is **not** the maximum id of that page
   (page 1 ends at id 84, but the page also contains 82, and 85 is still ahead while 81 and 83
   are behind).
3. Resuming from it skips everything that sorted into an earlier page but carries a smaller id.

**The description is the trap.** `src/tools/runtime/tasks.tool.ts:110-114`:

> `Keyset cursor: the last id of the previous page. Returns the tasks with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike "offset".`

"The last id of the previous page" and "cannot skip or repeat one" are both true only if the
previous page came from keyset mode. Read together against a sortable collection they are
false, and they are exactly what led to the lost records.

*Tasks:* **T2.1** — when an offset page is built for a collection that declares a `sortable`
field, also emit `nextAfterId` set to the **maximum id in the returned page** (not the last
element), so switching modes is safe. **T2.2** — reword `afterId` in the schemas that declare it
— `tasks.tool.ts` and `records.tool.ts`, and only those two: "all four wrapper schemas" in this
draft was wrong, the three `action` wrappers never declared `afterId` — to say the cursor walks
**id order**, which differs from the page order on a sortable collection, and that a walk must
not mix the two modes. **T2.3** — add the test that was missing: a sortable
collection walked to exhaustion by each mode independently, both seeing every record exactly once.
*Check:* T2.3 fails before T2.1 and passes after; the reworded description no longer implies the
two orders coincide.

### R3 — `drop` then re-`define` resets `storeRev` to 0 and discards the change log, stranding every client cursor

**Observed.** `notes` reached `storeRev: 116`. It was dropped and re-`define`d with the same
field spec. A subsequent `{"collection":"notes","since":116}` was refused:

> `invalid-input: notes "since" is revision 116, ahead of the store (storeRev 0); read the list first.`

That token can never be accepted again. The client is told its own saved watermark is a caller
error, and there is no code that says "the epoch moved, resync".

**Cause.** `dropCollection` deletes the collection outright (`records.ts:2442-2468`), and
re-`define` builds it with `freshState`, which starts at `storeRev: 0, changes: []`
(`records.ts:2003-2007`). The `since` guard is a plain `>` comparison
(`records.ts:2225-2229`). Nothing distinguishes "you asked for the future" from "the collection
was recreated under you".

Note this is **not** the same thing as `reset()`, which is a deliberate clean start that also
rewinds `nextId` to 1 (`records.ts:2854-2861`) — that one is correct by design.

*Tasks:* **T3.1** — keep `storeRev` monotonic per collection name across `drop` + re-`define`
(retain a per-name high-water mark, or refuse to re-`define` a name that was dropped while any
client may hold a token). **T3.2** — if the reset is kept, give it its own error code (e.g.
`revision-epoch-reset`) distinct from `invalid-input`, so a client can tell "resync from scratch"
apart from "you sent a bad number".
*Check:* a test that writes N records, drops, re-`define`s, and confirms either the old `since`
still resolves or a distinct code is returned; the existing `since > storeRev` message stays
reserved for a genuinely future revision.

### R4 — the stale-record hint recommends `mergeDisjoint` where it cannot help

**Observed twice, by two different agents.** A removal with a wrong token, and separately a
patch with a wrong token, both already sending `mergeDisjoint: true`, both refused with a
message ending:

> `... retry with "expects" [{ id: "97", rev: 1 }] or pass "mergeDisjoint": true.`

The flag was already passed. For a removal the advice is unreachable by contract — the same
schemas say `mergeDisjoint` "Never merges a removal" (`tasks.tool.ts:116-120`).

**Cause.** `staleRecordError` appends that sentence unconditionally (`records.ts:1101`). It does
not know whether the call is a patch or a removal, and does not check whether `mergeDisjoint`
was already set. The genuinely-informative variant exists separately at `records.ts:1529`
(`cannot merge "<field>" because this patch sets it too`), so the machinery to be precise is
there — it is just not used on this path.

*Tasks:* **T4.1** — omit the `mergeDisjoint` clause when the operation is a removal, and omit it
when `mergeDisjoint` is already true (in that case name the clashing field, as `:1529` does).
*Check:* a test asserting the removal-path message does not contain `mergeDisjoint`, and that a
patch path with the flag set reports the clash rather than re-recommending the flag.

### R5 — "was removed since revision N; the id is free again" is wrong on both halves

**Observed.** Id `4` belongs to `profiles` (rev 4, live). Patching it through `tasks` with an
`expects` token produced:

> `stale-record: tasks "4" was removed since revision 1; the id is free again — re-read the list and add or retry.`

It was never a task, so "was removed" is fabricated. And "the id is free again" is false twice
over: id 4 is live in `profiles`, and ids are never reused anyway — `nextId` only ever
increments (`records.ts:2362-2377`), so after id 11 was removed the next add got 12, not 11. The
sentence invites the caller to claim an id it cannot claim.

**Cause, and a correction to how this was first diagnosed.** The `expects` pre-check
(`records.ts:1443-1450`) runs `store.find(id)` and reports `removed: true` for **any** miss.
An earlier draft of this file attributed that to `expects` resolving against a *global* id
namespace. **That was wrong.** The store view handed to the planner is per-collection —
`find: (id) => state.items.find(...)` at `records.ts:2236`, scoped to one `state`. The actual
defect is narrower: step 3 cannot tell "removed from this collection" apart from "never in this
collection", and never consults the other collections before phrasing the answer.

The id counter *is* global (`records.ts:2000-2002`, Decision F3), which is why an id can be live
elsewhile while absent here — but the lookup is not.

*Tasks:* **T5.1** — when the id exists in another collection, say so: `id "4" belongs to
"profiles"`. **T5.2** — reserve "was removed" for ids that are absent everywhere, and drop "the
id is free again" from both branches (it is never true within a session). **T5.3** — keep the
`removed: true` detail field only when the change log actually holds a removal for that id in
that collection.
*Check:* a test patching a foreign id and asserting the message names the owning collection and
never claims the id is free; an existing removal keeps its current wording.

### R6 — no way to read a collection's schema back

**Observed.** `probeg1` was defined with `maxLength: 42`, a `getOnly` field, and a `sortable`
field. A plain read returned records and facet counts and **nothing about the spec**. A second
agent independently reached the same conclusion by a different route. The practical cost was
paid twice in this session: discovering the accepted `count` shapes took four failed `define`
calls, because there is no way to ask.

**Cause.** There is no introspection verb. The engine does hold the answer —
`collections: () => string[]` (`records.ts:1987`) is what powers the `unknown-collection`
message, which usefully lists every defined name — but only names are exposed, never field specs.

*Tasks:* **T6.1** — accept `describe: true` on a `collection` and return the definition (fields
with `type`, `required`, `maxLength`, `maxItems`, `sortable`, `getOnly`, `count`, plus
`maxRecords` and `responseBudgetBytes`). **T6.2** — consider listing collections on a bare
`records` call with no `collection`, so the name list is reachable without triggering an error.
*Check:* a test defining a collection with non-default caps and asserting `describe` returns them
verbatim; the `unknown-collection` wording stays unchanged.

### R7 — no filter on a list read

**Observed.** `counts` reported `{done: 2, bug: 2, idea: 1, risk: 1}` over 55 records, but
finding the two done records required paging all 55. There is no `where`, no `completed: false`,
no equality filter of any kind.

**Cause.** The read path is `offset`/`limit`/`afterId`/`since` only (`records.ts:2205-2215`);
`counts` is computed over the whole collection (`countsOf`) while the page is not, so the two
cannot be reconciled without a full walk.

*Task:* **T7.1** — add a filter to the list read (equality on `enum`/`integer`/`text` fields,
and boolean), applied before paging and reflected in a filtered count. *Check:* a test asserting
a filtered page returns only matching records, that `page.hasMore` is computed against the
filtered set, and that unfiltered reads are byte-identical to today.

## Corrected claims (kept, not deleted)

Five first-pass claims did not survive verification against the source or the reviewers. They are
recorded rather than deleted, and a verifier will otherwise re-report two of them (the `count`
shapes and the `maxRecords` bound).

| Claim | Verdict | What is actually true |
|---|---|---|
| **"`count: true` is rejected on an integer with a message that contradicts the docs."** | **withdrawn — the docs were right.** | The two shapes are validated separately and the messages are symmetric and exact: `count: true` requires `enum` (`records.ts:888-897`), `count: {key, complement}` requires `boolean` (`records.ts:898-906`). The original error was reading "boolean or enum" as applying to both shapes. Only residual nit: the message could list the accepted shape instead of only naming the rejected one. |
| **"`define` accepts `maxRecords: 200` although the docs say a larger number is refused — the bound looks unenforced."** | **withdrawn — the bound is enforced.** | `RECORD_MAX_RECORDS = 200` (`records.ts:146`) and the guard is `cap > RECORD_MAX_RECORDS` (`records.ts:2515-2518`), so 200 is the largest *valid* value and 201 is refused with code `record-cap`. The probe never tried 201. |
| **"`expects` tokens resolve against a global id namespace while errors are phrased per-collection."** (offered as R5's root cause) | **refuted by the source.** | The store view is per-collection (`records.ts:2236`). See R5 for the correct, narrower diagnosis. |
| **"`chapters`/`locations`/`profiles` omit `storeRev`/`since` by oversight; add parity."** | **downgraded — it is a documented design choice.** | `records.ts:2683-2686` states it outright: *"The action wrappers carry NO page on a mutation and NO storeRev: that is the contract these three tools have always had."* Those three schemas also accept no `since` argument, so they are internally consistent. The consequence (no incremental polling on those three) is real but is a scope limit, not a bug. |
| **"R2 repeats records."** | **understated.** | It **loses** records and reports `hasMore: false`. Repetition was the first symptom seen; the truncation is the defect. |

## Not tested

- **`maxRecords` refusal at 201.** The guard is read at `records.ts:2515-2518` but was never
  exercised; the 50-record cap on a `define`d collection was exercised and fired correctly.
- **`responseBudgetBytes` behaviour under a real 64 KiB page.** The budget is declared per
  collection (`src/core/task.ts:50`, `responseBudgetBytes: 64 * 1024`) and the page loop honours
  it (`records.ts:2093-2099`), but no test here produced a page large enough to trip it. R7's
  "page budget stays below the 256 KiB outer cap" claim is therefore **unconfirmed** at the
  boundary.
- **Restore after a drop + re-`define`.** R3 was observed live; whether a persisted snapshot
  carrying the old `storeRev` restores cleanly into the recreated collection was not checked
  (`records.ts:1841`, `records.ts:1896` are the paths). This could turn R3 from a stranded cursor
  into a restore failure.
- **A `sortable` field with ties.** `orderedFor` sorts absent-last and relies on `Array.sort`
  stability for equal values (`records.ts:1582-1593`). The chapters `order` tie (two chapters at
  `order: 1`) resolved by insertion order as expected, but stability across an *edit* that
  changes a sort key was not probed.
- **`RECORD_MAX_CHANGES` eviction.** The window is 200 events FIFO (`records.ts:159`,
  `records.ts:2051-2057`). `changesHasMore` was observed at the 50-per-result limit
  (`RECORD_MAX_CHANGES_IN_RESULT`, `records.ts:160`), but never at the 200-event eviction point,
  so `changesTruncated` has never been seen `true`.
- **Server/lane routing.** Every call went through the in-process harness. `lane-authority.ts`
  routing a lane's wrapper write to this engine (`records.ts:89`) was not exercised.
- **Whether R1's dropped `entry` reaches any existing consumer.** No caller outside this
  session was observed reading `tasks` with a single `ids` element, so the blast radius of R1 in
  production is **unconfirmed**.

## Verify before starting — drift check

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must end in packages/underload/harness
git log -1 --format='%h %s'; git status --short

# R1 — the engine sets `entry`, the batch branch never reads it
grep -n "result.entry = only" src/core/records.ts                 # expect ~2256
grep -n "result.entries ?? \[\]" src/core/records.ts              # expect 2665 and 2689
grep -n "One id answers with" src/tools/runtime/tasks.tool.ts     # expect ~70 (the promise)

# R2 — the two orders, and the cursor seam
grep -n "keyset mode re-sorts by id" src/core/records.ts          # expect ~1599 (it is deliberate)
grep -n "nextAfterId\|nextOffset" src/core/records.ts             # expect ~2113-2116 (exclusive branches)
grep -n "cannot skip or repeat one" src/tools/runtime/tasks.tool.ts  # expect ~112 (the trap)

# R3 — drop resets, since refuses a stranded token
grep -n "collections.delete" src/core/records.ts                  # expect ~2460
grep -n "ahead of the store" src/core/records.ts                  # expect ~2227

# R4/R5 — the two misleading messages
grep -n "or pass .mergeDisjoint" src/core/records.ts              # expect ~1101 (unconditional)
grep -n "the id is free again" src/core/records.ts                # expect ~1447

# R6/R7 — absence claims
grep -n "describe" src/core/records.ts src/tools/runtime/records.tool.ts   # R6: expect no introspection verb
grep -n "where\b" src/core/records.ts                             # R7: expect no filter support

# The test that pins R2's id-order behaviour — read it before changing anything
grep -n -A6 "afterId. is .ids greater than X" src/core/records.test.ts   # expect ~94-99

npx vitest run src/core/records.test.ts src/harness.records.test.ts      # BASELINE green before any edit
```

Stop-and-recheck conditions:

1. **`toWrapperResult`'s batch branch now reads `entry`** — R1 is closed; confirm the
   `tasks.tool.ts:70` sentence was left true rather than the description edited to match the bug.
2. **An offset page now emits `nextAfterId`** — R2's T2.1 landed; confirm it is the **maximum**
   id in the page, not the last element, or the fix is cosmetic.
3. **Someone "fixes" keyset mode to walk page order** — that reverses the decision recorded at
   `records.ts:1597-1599` and breaks `records.test.ts:94-99`. Either update that test on purpose
   or leave the orders distinct; do not change it silently.
4. **`since` gains an epoch concept** — confirm `reset()` (`records.ts:2854-2861`) still rewinds
   to 0 by design; R3 asks only about drop + re-`define`, not about reset.
5. **A filter is added** — confirm `counts` semantics are stated: today `counts` is over the
   whole collection while the page is a slice, and R7 changes that for filtered reads only.

## Resolution (2026-11-09)

All seven defects are implemented, independently reviewed, and the review's six residual
findings are closed with them. Verified: full non-frontend suite `npx vitest run` = **3081
passed, 2 skipped, 0 failed**; `npm run typecheck` = exit 0; `npm run tools:manifest`
regenerated. Anchors below are the post-fix tree at `packages/underload/harness`.

* **R1 — closed.** `toWrapperResult`'s `batch` branch now carries the engine's singular
  answers: `entry` (one-id read, one-record mutation) and `removed` (one deleted record),
  each conditional, at `src/core/records.ts:3260-3261`; a multi-record call keeps its
  historical page-only shape and `records` keeps the full array. Review F1: `TaskResult`
  omits the inherited array and declares `removed?: TaskItem` (`src/types/index.ts:1642`),
  matching what the wrapper returns. Review F2: the `tasks` envelope sentence
  (`src/tools/runtime/tasks.tool.ts:38`) now lists `entry?`/`removed?`, mirroring
  `records.tool.ts`; the `ids` sentence at `tasks.tool.ts:84` was left byte-identical.
  Pinned at `src/core/records.test.ts:749-900`.
* **R2 — closed.** An offset page on a collection that declares a `sortable` field also
  emits `nextAfterId`, set to the **maximum** id in the returned page, gated on
  `sortable && hasMore` (`src/core/records.ts:2450-2490`); keyset mode is untouched, so
  `records.test.ts:94-99`'s id-order decision still holds. `afterId` is reworded to name the
  order it walks and to forbid mixing modes in `src/tools/runtime/tasks.tool.ts:133` and
  `src/tools/runtime/records.tool.ts:136` — the only two schemas that declare it. Both walks
  pinned to exhaustion at `src/core/records.test.ts:901-1098`.
* **R3 — closed.** `storeRev` is monotonic per collection NAME across `drop` + re-`define`:
  a raise-only high-water mark (`src/core/records.ts:2298-2311`) is seeded at registration,
  carried up by every `drop` from the live revision (`:3014`), and re-seeded by a restore
  (`:3518`), so a re-`define` starts one past the highest revision the name ever reached
  (`:2933-2942`). A
  watermark that indexes a deleted log gets its own `revision-epoch-reset`
  (`src/core/records.ts:2701-2712`, code at `:211`) with an epoch floor, and `invalid-input`
  keeps its "you asked for the future" meaning. `reset()` still rewinds to 0 by design
  (`:3467-3468`). Pinned at `src/core/records.test.ts:1099-1280`.
* **R4 — closed.** `staleRecordError`'s advice is now computed, not appended
  (`src/core/records.ts:1276-1291`): a removal never sees the `mergeDisjoint` clause, a stale
  patch with the flag set names the clashing field (`:1790`), and when the window can no
  longer prove coverage the new uncomputable-clash fallback says the flag is spent rather than
  inventing a clash. The no-flag sentence is verbatim. `src/core/records.test.ts:329-477`.
* **R5 — closed.** The `expects` pre-check tells three truths apart
  (`src/core/records.ts:1672-1712`): live elsewhere (`id "4" belongs to "profiles"`), removed
  here with the change log as evidence, and absent with no logged removal. "the id is free
  again" is gone from every branch, and the `removed: true` detail rides only on the middle
  one. `src/core/records.test.ts:478-588`.
* **R6 — closed.** `describe: true` returns the stored definition verbatim, caps included
  (`src/core/records.ts:2963`), and a `records` call with no `collection` lists every
  registered name instead of only being able to throw them (`:2976`). Review F5: the guard
  refuses **all** eight companions — `entries`, `remove`, `ids`, `since`, `offset`, `limit`,
  `afterId`, `where` — with `invalid-input` (`:2596-2626`), so `describe: true, since: 999`
  is a refusal instead of an ignored value, and the `describe` param prose says so
  (`src/tools/runtime/records.tool.ts:158-162`). `src/core/records.test.ts:1281-1512`.
* **R7 — closed.** `where` is an equality map over declared fields (`src/core/records.ts:519`)
  applied BEFORE ordering and paging (`:2414-2420`), so the page, its cursors and `counts` all
  describe the matching set (`:2501`); an unfiltered read is byte-identical. Review F3: the
  filter is refused beside `since` (`:2646-2657`) and beside `ids`, the one lookup mode that
  answers without a page (`:2662-2680`), and both wrappers' `where` prose now says so. Review
  F4: a filtered offset page of a sortable collection is pinned to report `nextAfterId` as the
  maximum id **among the matches it returned** (`src/core/records.test.ts:1672-1787`).
  Review F6 corrected two R7 comments and one test title that claimed cursors and counts the
  assertions do not make. `src/core/records.test.ts:1513-1982`.

### Residual limitations

* **The R3 epoch is runtime-only by design.** The snapshot keys were not extended, so
  `drop` → process restart → re-`define` loses the high-water mark and the recreated
  collection starts at 0 again. A restore does seed the mark from the persisted `storeRev`
  (`src/core/records.ts:3514-3518`), so only an intervening drop is forgotten.
* **Mixed offset→keyset walks remain unsupported by contract.** Each mode's own walk is
  complete; an offset page's `nextAfterId` makes a switch safe against the records that page
  carried, but it cannot reach a match that sorts later and carries a smaller id. The two
  `afterId` descriptions state the rule rather than the code enforcing it. Clarified 2026-11-11:
  that gap is only for a walk that spans REQUESTS — inside ONE request the two cursors cannot be
  sent together at all, because `afterId` + `offset` is refused with `invalid-input` by code
  (`src/core/records.ts:2791-2798`).
* **`scripts/check-package-tools.mjs` still reports 2 failures** (`scripted model registers
  and invokes a tool without a discovery round`, and `all tool contexts saw one
  strict-identical harness and intact state`). Both are pre-existing on this tree,
  A/B-proven unrelated to these changes, and concern `toolRegistry` visibility at the
  packaged-harness boundary rather than the record engine.

## Update (2026-11-11)

Re-verified read-only against the current tree; no code was touched, and nothing was re-run beyond
reading anchors.

* **All seven closures still hold.** Each finding is still pinned by the same dedicated block in
  `src/core/records.test.ts`, and the Resolution's test ranges are unchanged and exact: R4
  `:329-477`, R5 `:478-588`, R1 `:749-900`, R2 `:901-1098`, R3 `:1099-1280`, R6 `:1281-1512`,
  R7 `:1513-1981` (the R7 `describe` closes at `:1981`, so the Resolution's `:1513-1982` runs one
  line past the block — the block is the anchor, not the number).
* **The Resolution's SOURCE anchors have drifted.** Its header is right that those numbers were
  the post-fix tree; that tree has moved. Current locations, each re-read today: R1 — the
  carry-through `src/core/records.ts:3464-3465`, `TaskResult` `src/types/index.ts:1822-1827`;
  R2 — the sortable-collection cursor rule `src/core/records.ts:2603-2641`, its prose now at
  `src/tools/runtime/tasks.tool.ts:141-142` and `src/tools/runtime/records.tool.ts:140`;
  R3 — the epoch map `src/core/records.ts:2356`, the re-`define` that continues the count
  `:3090-3095`, the `drop` that keeps the mark `:3177`, `revision-epoch-reset` `:2849-2860`, the
  restore seed `:3850-3853`, and `reset()` still rewinding `:3784-3798`; R4 — the computed advice
  `:1230-1315`; R5 — the three-way step-3 pre-check `:1668-1716` and the whole-store id sweep
  `:2875-2884`; R6 — the flag `:501-503`, the answer-before-paging rule `:2743-2748`, the
  companion guard `:2770-2777`, the detached copy `:383-386`, `describeCollection` `:3118-3126`;
  R7 — the filter and its validation `:516-610` with `matchesWhere` at `:607-610`, applied to the
  item set before the order is chosen and the slice is cut at `:2538-2560`, refused beside `since`
  at `:2800-2809` and beside `ids` at `:2811-2833`. The Findings and Corrected-claims tables above
  keep their 2026-11-09 numbers and were left as written, exactly as the flag at the head of this
  file states; the index row in `README.md` carries the same re-pointed anchors in summary form.
* **One residual is stated more precisely than it was**: see the clause added to Residual 2 — the
  mixed-mode rule is contract-only for a walk across REQUESTS, while `afterId` + `offset` inside a
  single request is refused by code.
* **The `scripts/check-package-tools.mjs` residual was not re-run** in this read-only pass, so its
  two failures stand exactly as recorded above: neither re-confirmed nor refuted.

# 0011 — The change feed reports that a gap was lost but never says where the window starts

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11) — closed**)
> **Severity:** Minor
> **Area:** `src/core/records.ts` (`since` feed, `unknown-record` refusal)
> **Date opened:** 2026-11-09

## Context

`since: <storeRev>` is the documented cheap poll, and the store is honest that the feed is
a FIFO window: retention is `RECORD_MAX_CHANGES` = 200 events per collection, and
`changesTruncated` is set when the reader fell behind the oldest retained event. Both are
documented (`knowledge.md:1080-1086`, `:1109-1117`) and both behave correctly — a stress test
confirmed the flag distinguishes head-loss from the 50-entry page cap.

What is missing is the number itself. The reader learns *that* it missed events and cannot
learn *which* events still exist, so a poller cannot tell "I am 3 events behind" from "I
lost 400" without re-reading the whole collection — and one refusal message is forced to
guess between the two.

## Gap

- **No floor is exposed.** The envelope carries `changes`, `changesHasMore`,
  `changesTruncated` and `storeRev`, but nothing naming the oldest retained revision. The
  reader must infer it from `changes[0].rev`, which is absent when the feed comes back
  empty — the one case where the reader most needs to know whether it is caught up or has
  lost everything.
- **One refusal is therefore ambiguous by construction.** The unknown-id error has to offer
  two causes because it cannot distinguish them: *"it was never in …, or its removal aged
  out of the 200-event window."* A consumer cannot branch on that text.
- **The bound is not in the poll result.** A caller cannot size its own polling interval
  against the window without knowing `RECORD_MAX_CHANGES` out of band.

## Why it is the way it is

The window is deliberately per-collection and deliberately short — `:2482-2483` explains
that a chapter write must not open a hole in the task window that `mergeDisjoint` reads as
"coverage unknown", and `:160-164` bounds the window so `since` stays cheap and a disjoint
merge stays provable. Trimming is the point. The gap is only that the trim leaves no
watermark behind.

## Evidence

| Fact | Source |
|---|---|
| Window is 200 events, per collection | `src/core/records.ts:165` (`RECORD_MAX_CHANGES = 200`, sizing rationale at `:160-164`), `:2484-2493` (`pushChange`, the FIFO splice at `:2491-2493`) |
| Head-loss is detected but only reported as a boolean | `src/core/records.ts:2671-2673` (`truncated = since < state.storeRev && (state.changes.length === 0 \|\| state.changes[0].rev > since + 1)`) — the floor `state.changes[0].rev` is read at `:2673` and discarded |
| The result exposes no oldest-revision key | `src/core/records.ts:2691-2694` (`result.changes = kept`, `changesHasMore`, `changesTruncated`, then `return result` at `:2696`) — three keys, no floor |
| The refusal is forced to hedge between two causes | `src/core/records.ts:1714-1715` ("it was never in …, or its removal aged out of the `${RECORD_MAX_CHANGES}`-event window"), with the hedging comment at `:1709-1711` |
| A SECOND feed has landed since this was filed (R2a) and carries the same hole | `src/core/records.ts:2386` (`const storeFeed: RecordStoreChange[]`, capped by the same `RECORD_MAX_CHANGES`), mirrored from `pushChange` at `:2495-2514` (its own FIFO splice at `:2510-2512`); `store.snapshot()` hands it over whole at `:3754-3759`, and `store.changesSince(since)` returns `{ storeRev, collectionsRev, changes, reset }` at `:3762-3777` — where `storeFeed[0].seq` is read at `:3775` to decide `reset` and then discarded, so the store-wide reader has no floor either |
| The retention rule is documented, so this is not a doc gap | `knowledge.md:1080-1086` (per-collection FIFO window capped at `RECORD_MAX_CHANGES` (200) — the constant is spelled `RECORD_MAX_CHANGES`, not the `TASK_MAX_CHANGES` this row quoted when it was filed), `:1109-1117` (`changesTruncated` = "the retained window no longer covers `since + 1`", at `:1114-1115`) |
| Runtime, 2026-11-09: `tasks { since: 0, limit: 1 }` at `storeRev` 206 → first change `rev` 7 (= exactly 200 retained), `changesTruncated: true`, and no field naming 7 | live session store |
| Runtime control: `tasks { since: 150, limit: 1 }` → 50 changes, `changesTruncated: false` — so the flag tracks the window, not the page cap | live session store |

## Proposal

1. Emit **`oldestAvailableRev`** on every result that carries `changes` (and on a plain
   read of a collection, where it costs one integer). It is already in hand at `:2673`.
2. Use it to split the hedged refusal at `:1714` into two: an id that never existed, and
   an id whose removal aged out — the latter now provable against the floor.
3. Name the field in the `since` descriptions of `records.tool.ts` and `tasks.tool.ts`
   (both already explain `changesTruncated`), and regenerate the manifest.

**Alternatives considered.**

- *Document "subtract 200 from `storeRev`".* Rejected: `storeRev` advances per event, but
  no-op patches and lease renewals record nothing (`knowledge.md:1085-1086`), so the floor
  is not derivable arithmetic — it has to be reported.
- *Widen the window.* Rejected: the bound is the reason `since` is cheap, and doubling it
  only postpones the same ambiguity.
- *Return a `gap: { lost, from, to }` object.* Rejected as over-specified: `lost` is not
  knowable once events are trimmed, and `oldestAvailableRev` plus `storeRev` is enough.

## Acceptance criteria

1. A feed result that sets `changesTruncated: true` also reports the oldest retained
   revision, and that revision equals `changes[0].rev` when the feed is non-empty.
2. An unknown-id refusal states one cause, not two.
3. Both tool descriptions mention the field, and the manifest is regenerated.

## Tests to add

- `src/core/records.test.ts` — push more than `RECORD_MAX_CHANGES` events, then assert
  `oldestAvailableRev` equals the first retained `rev`, and that it is absent (or equals
  1) on a fresh collection.
- `src/core/records.test.ts` — an id that never existed and an id whose removal aged out
  produce different messages.
- `src/harness.task.test.ts` — `tasks { since }` carries the field alongside `changes`.

## Out of scope

- Changing the window size, or making it configurable.
- Durable replay of trimmed events (the store keeps no journal).
- Per-session global revisions: the per-collection split is deliberate (`:2482-2483`).

## Update (2026-11-11)

- **Re-anchored** — the engine cites moved by 4-110 lines and the `knowledge.md` cites moved
  by ~290 (that file was realigned earlier today): `RECORD_MAX_CHANGES = 200` is
  `src/core/records.ts:165` (rationale `:160-164`), `pushChange` is `:2484-2493`, the
  head-loss test is `:2671-2673`, the three feed keys are `:2691-2694` with `return result`
  at `:2696`, the hedged unknown-id refusal is `:1714-1715` (its comment `:1709-1711`), and
  the retention/`changesTruncated` prose is `knowledge.md:1080-1086` and `:1109-1117`.
- **One correction, not just an anchor**: this issue cited the cap as `TASK_MAX_CHANGES`;
  the constant has been `RECORD_MAX_CHANGES` since the collections engine replaced the
  task store, and `knowledge.md` now spells it that way (`:1081`).
- **The gap got a second surface.** `src/core/records.ts:2386` adds a store-wide feed
  (`storeFeed`, mirrored inside `pushChange` at `:2495-2514` with its own FIFO splice at
  `:2510-2512`). `store.snapshot()` hands the whole window over at `:3754-3759`, and
  `store.changesSince(since)` returns `{ storeRev, collectionsRev, changes, reset }` at
  `:3762-3777`. The floor `storeFeed[0].seq` is read at `:3775` to decide `reset` and then
  dropped, so the store-wide poller has exactly the problem this issue describes: it learns
  a gap happened and cannot say where the window starts. A new Evidence row records it;
  proposal step 1 should cover both envelopes.
- The two runtime rows are left **as recorded** (live session store, 2026-11-09).
- Status stays **Open**.

## Update (2026-11-11) — closed

- **Shipped as proposed**, all three steps, and both envelopes. One helper computes the floor
  for either feed: `src/core/records.ts:1443-1465` (`windowFloor` at `:1457`), which reads the
  revision off the **retained events** rather than deriving it — the rejection of
  "subtract 200 from `storeRev`" is why, and the comment states it: a no-op patch records
  nothing, so the floor is not arithmetic. An **empty** window returns `storeRev + 1` (a trimmed
  window, or the epoch floor a re-`define` inherits), and a collection that has never written
  returns **1** — the revision its first event will carry.
- **Step 1 — the key is on every result that carries a feed, and on a plain read.** `project()`
  sets `result.oldestAvailableRev` at `src/core/records.ts:2780` (rationale `:2768-2779`), above
  the `since` branch, so one integer covers both. It is **always present and never
  count-dependent** — one key, one stable type, the rule `removed`/`removedIds` follow — which
  is why "absent (or equals 1) on a fresh collection" resolved to **equals 1**: a key that only
  sometimes appears is the ambiguity this issue is about, reintroduced.
- **Step 2 — the refusal states one cause.** `src/core/records.ts:1783-1820` replaces the hedge,
  and each branch is provable rather than probable: `everMinted(id)` consults the global,
  monotonic id counter (`:3011-3020`, the two new `StoreView` members at `:1483-1493`), and the
  floor says whether "no removal logged" is evidence or silence. The two messages, verbatim:
  never-held — `stale-record: tasks has no task with id "9999" — "tasks" never held it, and this
  collection's change log (which now starts at revision 400) holds no removal for it either.
  Re-read the list.` (the parenthetical is present only once the window has actually trimmed);
  aged-out — `stale-record: tasks has no task with id "1" — its removal is older than this
  collection's retained change window, which now starts at revision 400 (200 events), so the log
  can no longer show it. Re-read the list.`, and that branch is the only one that adds
  `details.oldestAvailableRev` (`:1814-1820`), so a consumer can branch on the number instead of
  the prose.
- **The second surface this update named is covered too.** `store.changesSince(since)` now
  returns `{ storeRev, collectionsRev, changes, reset, oldestAvailableRev }`
  (`src/core/records.ts:3964-3979`, floor at `:3979`, declared at `:2424-2431` with the
  `RecordStoreWindow` type at `:1439-1441`), where `storeFeed[0].seq` used to be read for the
  `reset` decision and dropped. `view()` was **deliberately not** given the key: a snapshot hands
  over the whole retained feed (`:3940-3947`), so there is no window for a reader to be behind.
- **The wrapper envelope stays byte-identical.** Through `tasks` the key rides **only beside
  `changes`** (`src/core/records.ts:3672-3679`), because the batch wrapper's historical page is
  pinned key-for-key elsewhere and a plain wrapper read carries no feed for the floor to bound.
  A plain read carries the key on the un-wrapped `records` surface only.
- **Step 3 — descriptions and manifest.** The `since` descriptions now name the field and what
  to do with it: `src/tools/runtime/records.tool.ts:114-120` and
  `src/tools/runtime/tasks.tool.ts:112-117`; both body descriptions repeat it
  (`records.tool.ts:40`, `tasks.tool.ts:38`). `npm run tools:manifest` regenerated
  `src/core/tool-manifest.ts` (records `:388`/`:458`, tasks `:618`/`:692`) and
  `npm run tools:manifest:check` reports `tool-manifest.ts is current (31 descriptors)`.
- **Tests added.** `src/core/records.test.ts:2412-2516` — a new describe with three cases: `:2436`
  300 events against the 200-event window → `storeRev 300`, `changesTruncated: true`,
  `oldestAvailableRev: 101`, and the equal-to-`changes[0].rev` pin criterion 1 asks for, plus the
  same read from inside the window (floor unmoved, not truncated) and at the floor itself;
  `:2474` a fresh collection → `changes: []`, floor `1`, so an empty feed is now distinguishable
  from a lost head; `:2495` a plain read carries the key on the engine surface while the `tasks`
  wrapper's page keys stay exactly `tasks`/`counts`/`page`/`storeRev`. The second test this file
  asked for is `src/core/records.test.ts:602` (`0011: an id whose removal aged out states that
  one cause, and names the floor`, exact storeRev 599 / floor 400), read against the never-held
  case pinned at `:563`; the store-wide half is `src/core/records.store-events.test.ts`, where
  every `changesSince` pin now carries the key: `:430-448` a fresh or reset store (floor 1, and
  `since: 5` on a store that never wrote reports the same floor beside `reset: true`),
  `:482-489` a restored epoch whose **empty** window reports `storeRev + 1` (floor 2 — the case
  "subtract the window size" cannot express), `:505` an untrimmed window reporting its own oldest
  event, and `:535-536` plus `:546` the trimmed 200-entry store-wide window: floor 11, equal to
  `changes[0].seq`, and unmoved for a cursor the window still covers.
- **`src/harness.task.test.ts`** — the wrapper half: `:695-707` (the whole `{ since }` envelope
  gains `oldestAvailableRev: 1`), `:937-950` and `:961-969` (a caught-up reader: floor 1 beside
  an empty feed), and `:991-1004` / `:1013-1026` in the cap-and-trim test — floor 1 while the gap
  is only the 50-entry cap, floor 2 once rev 1 has been dropped, `=== changes[0].rev` in both.
  That test's comment also stopped naming `TASK_MAX_CHANGES`, the wrong constant this file
  corrected above.
- **Pins updated, not left red**: `src/harness.metadata.test.ts:251` (the `tasks` `since`
  description) and `:308` (the `tasks` body description).
- **Offline evidence.** `npx vitest run src/core/records.test.ts src/core/records.store-events.test.ts
  src/harness.records.test.ts src/harness.task.test.ts src/harness.metadata.test.ts
  src/core/tool-discovery.test.ts src/shared/harness-api.test.ts src/server/api-records-live.test.ts`
  → **161/161** (8 files). With `src/core/records.ts` temporarily reverted to its `HEAD` content
  the three records files give **13 failed | 70 passed** — every case above plus the 0008 cases
  that share the files — and the file was restored byte-identical (sha256 `f670f77f…`).
  `npx tsc --noEmit` is clean and the manifest `--check` exits 0. No provider or live-session run
  was needed: the window, the page cap and the floor are all pure store behaviour.
- **Drift in the cites above**, re-read before the fix: `RECORD_MAX_CHANGES = 200` is still
  `src/core/records.ts:165` with its rationale at `:160-164`, but everything below it moved
  again. `pushChange` `:2484-2493` → `:2593-2602` (its splice at `:2601`); the head-loss test
  `:2671-2673` → `:2794-2796`; the three feed keys `:2691-2694` → `:2814-2817`; the hedged
  unknown-id refusal `:1714-1715` (comment `:1709-1711`) → replaced by `:1783-1820`; `storeFeed`
  `:2386` → `:2495`, its mirror inside `pushChange` `:2495-2514` → `:2612-2621` (splice `:2620`);
  `store.snapshot()` `:3754-3759` → `:3940-3947`; `store.changesSince` `:3762-3777` →
  `:3964-3979`. The two `knowledge.md` ranges (`:1080-1086`, `:1109-1117`) were **not**
  re-verified: that file is being realigned by a concurrent pass in the same tree (+66 lines),
  so its numbers are expected to move again.
- **Not covered by this fix** (the owner's next pass): the published declarations in
  `src/types/index.ts` still omit `oldestAvailableRev?` on `RecordsResult`,
  `RecordStoreDelta` and `RecordStoreView` (its only id list is `removedIds?`, `:1960`), so the
  engine declares the key locally (`src/core/records.ts:1432`, `:1439-1441`) and the harness
  facade keeps projecting the narrower published type. The one cause the split cannot see is
  disclosed rather than argued: an id minted in one collection and removed in **another** lands
  in the aged-out branch, because `ownerOf` only reports a live record (`:1798-1801`). Window
  size, configurability, and durable replay of trimmed events stay out of scope.
- Status is **Fixed**. The log's rule for a closed issue is to delete the file and drop the
  index row; the file is kept, with the row marked, so the fix can be reviewed against its issue
  in the same pass — the owner's integrated run decides, and deletion is then a one-command step.

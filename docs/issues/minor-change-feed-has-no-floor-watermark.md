# 0011 — The change feed reports that a gap was lost but never says where the window starts

> **Status:** Open
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

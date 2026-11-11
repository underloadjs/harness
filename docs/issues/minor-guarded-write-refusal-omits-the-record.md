# 0009 — The `guarded-write` refusal says "read it first" but withholds the record that `stale-record` returns

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11) — closed**)
> **Severity:** Minor
> **Area:** `src/core/records.ts` (conflict errors)
> **Date opened:** 2026-11-09

## Context

Every agent write to a shared collection must carry `expects: [{ id, rev }]`. The first
write to a record an agent has not read is refused with `guarded-write: … (read it
first).` — and that refusal carries only `{ id }`. The sibling `stale-record` refusal on
the same record carries the whole current entry, including the `rev` to retry with. So the
error that most needs the rev is the one that omits it, and the caller pays a full extra
round trip on every first write to every record. Observed repeatedly during a 7-thread
stress test, where it was the single most common source of extra calls.

## Gap

A caller that gets `guarded-write` cannot retry in one step. It must issue a read, parse
the `rev`, and re-send — three calls where the engine already had the data for two. The
`stale-record` path proves the payload is affordable: it inlines the record under a byte
budget and says so.

## Why it is the way it is

Not a rule, an asymmetry. `stalePayloadOf` (`:1200-1228`) exists precisely so that
returning the current record cannot flood the result: it drops to the projected shape when
the full entry exceeds `RECORD_STALE_PAYLOAD_BUDGET_BYTES` (8 KiB, `:174-179`, the constant at `:179`), and the
header comments state the intent — "a conflict into a second flood" is what it
avoids (`:176-177`, `:1202`), and
"the degradation the caller can read, never a silent truncation"
(`:177-178`). That mechanism is
already general; it is simply wired into one of the two conflict errors.

## Evidence

| Fact | Source |
|---|---|
| The guard applies to every agent-identified write | `src/core/records.ts:1765-1767` (the identity test itself is `:1768`) ("A call with an agent identity … may only patch or remove a record it has read: the token is the proof") |
| `guarded-write` details carry the id only | `src/core/records.ts:1771-1775` (patch site) and `:1781-1785` (removal site); both pass `{ id }` at `:1774` and `:1784` |
| `stale-record` details carry the full current entry | `src/core/records.ts:1306-1318` (`entry: copyEntry(definition, entry, payload.projected === false)` at `:1317`) |
| The payload is budgeted, so including it is bounded work | `src/core/records.ts:174-179` (`RECORD_STALE_PAYLOAD_BUDGET_BYTES = 8 * 1024` at `:179`), `:1200-1228` (`stalePayloadOf`, reached from `staleRecordError` at `:1259`) |
| The message itself instructs a read | `src/core/records.ts:1773`, `:1783` (`… (read it first).`) |
| Runtime, 2026-11-09: `records { collection: "probes", entries: [{ id: "12", label: "three" }] }` with no `expects` → refusal text ends at "(read it first)", no `current:` payload; the same patch with `expects: [{id:"12",rev:99}]` → refusal ends `current: {"id":"12",…}` | live session store |

## Proposal

Attach the current record to both `guarded-write` throw sites using the existing helper:
compute `stalePayloadOf(definition, entry)` and put the same `entry` / `projected` /
`note` fields into the details that `staleRecordError` already emits. No new budget, no
new shape, no message change — the advice "read it first" becomes "here is what you
read".

**Alternatives considered.**

- *Accept unguarded patches as last-write-wins.* Rejected: the guard is the whole
  concurrency story for a store with no locks, and relaxing it would reintroduce lost
  updates that the stress test confirmed are currently impossible.
- *Drop the "(read it first)" wording.* Rejected: the advice is correct, it is the payload
  that is missing.

## Acceptance criteria

1. A `guarded-write` refusal carries the current record (or its projected form when over
   budget, with the `note` naming what was withheld).
2. The refusal's `rev` is the one a retry needs, so read → retry is two calls, not three.
3. `stale-record` output is byte-identical to today.

## Tests to add

- `src/core/records.test.ts` — unguarded patch on a record with a `getOnly` body: refusal
  carries `entry` with the body projected out and `projected: true`; unguarded removal on
  a known id carries the record; a `getOnly`-free collection carries it whole.
- `src/harness.task.test.ts` — `tasks { tasks: [{ id, completed }] }` with no `expects`
  returns the current `rev` in the refusal.

## Out of scope

- Locks, claims, or a lease on records (the store's model is explicitly unlocked).
- Changing when a write is guarded.
- Adding `changed fields` to the refusal (the change feed already carries `fields`).

## Update (2026-11-11)

- **Re-anchored** — the guarded-write block sits ~15 lines lower than when this was filed,
  and the budget constant ~3 lines lower. Current ranges: the guard comment is
  `src/core/records.ts:1765-1767` (the `store.by !== undefined` identity test at `:1768`),
  the patch refusal is `:1771-1775` (message `:1773`, details `{ id }` at `:1774`), the
  removal refusal is `:1781-1785` (message `:1783`, details `{ id }` at `:1784`);
  `stale-record`'s details object is `:1306-1318` with the `entry` field at `:1317`;
  `stalePayloadOf` is `:1200-1228` and its only caller is `staleRecordError` at `:1259`;
  `RECORD_STALE_PAYLOAD_BUDGET_BYTES = 8 * 1024` is `:179`, under its header at `:174-178`.
- **Gap still open**: both refusal sites still pass `{ id }` and nothing else, while
  `stale-record` inlines the entry — the asymmetry the issue describes is exactly what the
  current code does, and the helper is still wired into one error out of two.
- The runtime row is left **as recorded** (live session store, 2026-11-09).

## Update (2026-11-11) — closed

- **Shipped as proposed, with one addition the acceptance list needs to know about.** The
  shared payload helper is now a renderer rather than a second producer: `stalePayloadTail`
  (`src/core/records.ts:1244-1250`) turns the ONE budgeted payload from `stalePayloadOf` into
  the `current: {…} (projection: … omitted)` tail, and both conflict refusals call it —
  `staleRecordError` (its own wording and its `details` literal are byte-identical, so the
  `stale-record` pins at `src/harness.task.test.ts:589` and `:804` still pass untouched) and
  the new `guardedWriteError` (`:1355-1370`, called from the two guard sites at `:1927` and
  `:1936`). The rejected alternative in **Alternatives** — "last-write-wins always, drop both
  codes" — stays rejected.
- **The payload rides in `error.details` exactly as the proposal asked**: `projected`, `entry`
  (the whole record, or the projection when it is over budget, with `rev` in it either way),
  and `note` naming what the projection withheld — `guardedWriteError` reads the same
  `stalePayloadOf` result, so the budget is still `RECORD_STALE_PAYLOAD_BUDGET_BYTES` and the
  shape is still the one `stale-record` emits.
- **The message carries the record too, which is the one place this fix reads the doc
  differently.** `src/harness.ts:6892` renders a failing agent task as
  `Tool "tasks" failed: <message>` and **nothing else** — `error.details` never reaches the
  model. A details-only payload would have made the structured API richer while leaving the
  reported symptom (one extra read on EVERY first write) exactly where it was. So the pinned
  sentence is kept **byte-identical** and the payload is appended after it, in `stale-record`'s
  exact form. Reading "no message change" as "the refusal must not say more" is the reading
  that fails acceptance criterion 1; the reading shipped is "the sentence must not change".
  Flagged for owner review, since it is an interpretation of a premise, not an extension.
- **A projected refusal still says so out loud.** `stale-record` composes its projection note
  into the message; this refusal keeps its pinned sentence, so `details.note` carries the note
  as well — the degradation stays spoken in both surfaces, per R11.
- **`details` is not a published type.** `HarnessError`'s `details` is a free-form record
  already (`src/util/errors.ts:24`), so this adds no type surface; the shape is pinned by tests
  and documented here rather than in `knowledge.md`.
- **Tests** (`src/core/records.test.ts`, `guarded write token contract`):
  - `:344` — the patch refusal: `code`, the `id`/`projected`/`entry` `details` keys asserted
    with `toEqual` (the `rev` a one-step retry needs, pinned field by field), and the exact
    message tail.
  - `:383` — the removal refusal: `updatedBy`/`updatedAt` arrive, because an
    identity-less removal is a guarded write that must say which record it deletes.
  - `:414` — over-budget entry: `projected: false`, the `note` naming what was withheld, the
    budgeted tail in the message, and `rev` still present so the retry needs no read.
  - `:301` (its pinned string at `:311-316`) — the pre-existing exact-message pin is
    **updated, not weakened**: the sentence is verbatim and the tail is appended inside the
    same string.
  - `src/harness.task.test.ts:719` — the model-visible string end to end
    (`Tool "tasks" failed: guarded-write: guarded write: … current: {…}`) plus the retry that
    reads the rev out of the refusal and succeeds with **no read in between**.
- **Both refusals stay the "exists but unguarded" refusal.** The payload is read only after
  STEP 3/STEP 4 (`:1766-1773`, `:1871-1879`) have answered an unknown id, so 0011's split —
  guarded complaint for an id that exists, plain rejection with the defined names for an id
  that does not — is untouched, and `never-held`/`aged-out` for `stale-record` are untouched.
- **Drift in the citations above, corrected**: the `stale-record` inlining site cited as
  `:1243-1251` is the `stalePayloadTail` call at `:1323` now, its `details` literal is
  `:1319-1336` with the `entry` field at `:1335`, `stalePayloadOf` (`:1200-1228` in the
  2026-11-11 re-anchor) is `:1213-1237`, and `RECORD_STALE_PAYLOAD_BUDGET_BYTES` is `:179`.
  Those moved while 0008 and 0011 were landing in the same files, and this pass moved the
  region again.
- **Evidence** (offline, deterministic; 2026-11-11):
  - `yarn vitest run src/core/records.test.ts src/core/records.store-events.test.ts
    src/harness.records.test.ts src/harness.task.test.ts` — **112 passed** (101 in those same
    files before the fix).
  - The same command over the 11 records-adjacent files (the four above plus
    `src/core/schema-validation.test.ts`, `src/tools/runtime/threadRead.test.ts`,
    `src/server/workers/lane-authority.test.ts`,
    `src/server/workers/lane-authority.request-scope.test.ts`, `src/harness.tool-list.test.ts`,
    `src/harness.discovery.test.ts`, `src/core/tool-discovery.test.ts`) — **242 passed**.
  - `npx tsc --noEmit` — clean (exit 0), so the `entry`/`note` keys type-check inside the
    existing `HarnessError` details contract.
  - **Negative control**: with ONLY the 0009 payload (back to `{ id }` and the bare sentence)
    and the 0010 entry-point guard reverted — every other in-flight change kept — `yarn vitest
    run src/core/records.test.ts src/harness.records.test.ts src/harness.task.test.ts` answers
    **7 failed / 87 passed**: the three 0009 tests, the pinned sentence test
    (`refuses an identified write that skipped its token…`, `src/core/records.test.ts:301`),
    the model-visible test at `src/harness.task.test.ts:719`, and 0010's two entry-point tests.
    Nothing else moves — the 0011 feed pins, the 0008 id-list pins, the wrapper-route 0010
    pins and the unchanged `stale-record` pins all still pass. `src/core/records.ts` was
    restored byte-for-byte from `Temp/T9/records.current.ts` (sha `d918fadc…`) and re-ran
    green at 94/94.
- **Not covered by these tests**: no published wire type for `details`, so a consumer that
  reads `entry` structurally is pinned only by these assertions; the tasks/chapters wrappers
  are not given their own guarded-write tests (they route through the same
  `executeCollection`); no `knowledge.md` row was added for the payload.
- Status: **Fixed 2026-11-11**.

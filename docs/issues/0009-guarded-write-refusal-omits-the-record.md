# 0009 — The `guarded-write` refusal says "read it first" but withholds the record that `stale-record` returns

> **Status:** Open
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

Not a rule, an asymmetry. `stalePayloadOf` (`:1200-1223`) exists precisely so that
returning the current record cannot flood the result: it drops to the projected shape when
the full entry exceeds `RECORD_STALE_PAYLOAD_BUDGET_BYTES` (8 KiB, `:169-173`), and the
header comment states the intent — "a conflict into a second flood" is what it avoids, and
"the degradation the caller can read, never a silent truncation". That mechanism is
already general; it is simply wired into one of the two conflict errors.

## Evidence

| Fact | Source |
|---|---|
| The guard applies to every agent-identified write | `src/core/records.ts:1759-1762` ("A call with an agent identity … may only patch or remove a record it has read: the token is the proof") |
| `guarded-write` details carry the id only | `src/core/records.ts:1765-1769` (patch site) and `:1775-1779` (removal site); both pass `{ id }` at `:1768` and `:1778` |
| `stale-record` details carry the full current entry | `src/core/records.ts:1295-1311` (`entry: copyEntry(definition, entry, payload.projected === false)`) |
| The payload is budgeted, so including it is bounded work | `src/core/records.ts:171-176` (`RECORD_STALE_PAYLOAD_BUDGET_BYTES = 8 * 1024`), `:1200-1223` (`stalePayloadOf`) |
| The message itself instructs a read | `src/core/records.ts:1767`, `:1777` (`… (read it first).`) |
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

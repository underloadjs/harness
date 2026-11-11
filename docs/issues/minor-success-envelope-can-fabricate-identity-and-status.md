# 0029 — A successful `delegate` can report an empty `invocationId` and an asserted `completed`, and two documented fields are conditional

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (delegation success path), `src/tools/runtime/delegate.tool.ts` (description)
> **Date opened:** 2026-11-11
> **Found by:** the independent review pass that re-checked 0019-0028, not by the original black-box run. **Unobserved in the live session** — this is a source-level finding, and no test covers it.

## Context

The `delegate` description presents `invocationId`, `threadId`, `status` and `nextOffset`
as facts about the run, and tells the caller to use the first of them to page the rest of
the answer. On the success path all four are best-effort. If the child's invocation record
is not there to read, the envelope still answers: `invocationId` becomes the empty string
and `status` becomes `'completed'`, asserted with no evidence. The record is not hard to
lose — terminal invocation records are pruned at 64, oldest first — and the description
gives the caller no way to tell a real identity from a placeholder one. Separately,
`threadId` and `nextOffset` are emitted only when present, while the description lists both
as part of the result unconditionally.

## Gap

A caller that stores the `invocationId` to page or cite a child's answer needs it to be
either genuine or visibly absent. Today an empty string is a valid-looking identity, and
`completed` is reported for a run whose record the runtime never saw — so the two fields a
caller is told to trust are the two that can be invented. A caller also cannot predict
whether `threadId` and `nextOffset` will be in the envelope at all.

## Why it is the way it is

The identity is read from the invocation record after the child's run resolves, matched by
the spawning call id or by "new since dispatch" (`src/harness.ts:4126-4145`), and the
success path tolerates its absence rather than failing: `invocationId: record?.invocationId
?? ''` and `status: record?.status ?? 'completed'` (`:4269-4271`). The tolerance is
deliberate in one direction — a child that never started registered no record, and the
comment at `:4116-4122` explains that an earlier "newest record" heuristic handed callers
another run's identity, so the code prefers to report nothing rather than a stale
identity. What was not carried through is that reporting nothing as `''` plus an asserted
`completed` is its own fabrication. Retention is the practical trigger:
`AGENT_RESULT_RETENTION = 64` (`src/core/agent-limits.ts:23`) and `pruneInvocationRecords`
(`src/harness.ts:3614`) evict oldest **terminal** records first, so a completed child can
age out. The conditional fields follow the same optional-chaining style as the cancelled
path (`:4266-4270`); the description simply describes the populated case
(`src/tools/runtime/delegate.tool.ts:164`).

## Evidence

| Fact | Source |
|---|---|
| The success path defaults identity and status | `src/harness.ts:4269` (`invocationId: record?.invocationId ?? ''`), `:4271` (`status: record?.status ?? 'completed'`) |
| The record may be absent, and that is intentional | `src/harness.ts:4116-4122` (matching by "new since dispatch" rather than "newest record", to avoid handing the caller a stale identity) |
| Terminal records are pruned, oldest first, at 64 | `src/core/agent-limits.ts:23` (`AGENT_RESULT_RETENTION = 64`), `src/harness.ts:3614-3624` (`pruneInvocationRecords`, "Evict oldest TERMINAL records only") |
| `threadId` and `nextOffset` are conditional in the envelope | `src/harness.ts:4266-4270` (`...(page.nextOffset === undefined ? {} : { nextOffset: … })`, `...(record?.threadId === undefined ? {} : { threadId: … })`) |
| The description lists all four unconditionally | `src/tools/runtime/delegate.tool.ts:164` ("The result carries agent, content, contentLength, offset, limit, truncated, nextOffset, invocationId, threadId, status, durationMs") |
| The existing test pins the populated case only | `src/harness.delegation.test.ts:494` ("returns the invocation identity agentManage/agentResult report") |
| Live, 2026-11-11: never observed | all 19 delegations in the black-box pass carried a real `invocationId` and a `threadId`; no test exercises the fallbacks |

## Proposal

Stop inventing the two fields. When the record is absent on the success path, omit
`invocationId` and `threadId` entirely rather than substituting `''`, and report `status`
as `'unknown'` (or omit it) instead of asserting `'completed'`, since the answer text
arrived but the run's own record did not. Keep the answer itself exactly as delivered —
`content`, `contentLength`, `offset`, `limit` and `truncated` all come from the returned
message and are unaffected. Then make the description honest about conditionality: name the
always-present fields and the three that appear only when known. If the owner prefers to
keep a non-empty identity, the alternative is to synthesise a clearly-marked one
(`invocationId: "unrecorded"`) so it cannot be mistaken for a value `agentResult` accepts.

**Alternatives considered.**

- *Raise `AGENT_RESULT_RETENTION`.* Rejected: it moves the window without removing the
  fabrication, and retention exists to bound a shared store.
- *Refuse the delegation when the record is missing.* Rejected: the answer is real and
  useful; failing the call would discard good work to protect a metadata field.
- *Leave the fallbacks and only fix the description.* Acceptable as the minimum, but it
  leaves an empty string that `agentResult` will reject, which is a trap rather than a
  signal.

## Acceptance criteria

1. No `delegate` envelope reports `invocationId: ""`.
2. A completed delegation whose invocation record is unavailable does not report
   `status: "completed"` as fact.
3. The description distinguishes the fields that are always present from `invocationId`,
   `threadId` and `nextOffset`, which are present only when known.
4. A caller that pages with the `invocationId` it was given never hands `agentResult` a
   value it will refuse.

## Tests to add

- `src/harness.delegation.test.ts` — a completed child whose record has been pruned
  (retention forced to 0 or the record deleted): assert the envelope still carries the
  answer, and that `invocationId` is absent rather than empty and `status` is not asserted.
- `src/harness.delegation.test.ts` — a child with no conversation: assert `threadId` is
  absent, and that a non-truncated answer carries no `nextOffset`.
- `src/core/metadata.ownership.test.ts` — a pin that the description's field list matches the
  fields the envelope actually emits, so the two cannot drift again.

## Out of scope

- Delivery of the envelope (0019) and the pending placeholder's identity (0024).
- The cancelled path's `partialContent` (0020) and `cancelledAtMessage` (0022).
- Changing `AGENT_RESULT_RETENTION`, or the retention policy itself.
- The `agentManage` preview caps (`AGENT_MANAGE_LIST_PER_AGENT`, `AGENT_MANAGE_PREVIEW_CHARS`).

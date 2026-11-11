# 0024 — The `pending` placeholder carries no `invocationId` or `threadId`, which is exactly when the caller needs them

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (delegation placeholder), `src/tools/runtime/delegate.tool.ts` (description)
> **Date opened:** 2026-11-11

## Context

The terminal `delegate` envelope carries `invocationId` and `threadId`, and the
description tells the caller what to do with them: page the rest of the answer with
`agentResult` using the `invocationId`, or address the conversation with `threadSend` /
`threadRead`. The placeholder that stands in for a still-running child carries only
`{ status: "pending", callId }`. So at the one moment the caller learns the child is
still working — and may want to inspect it, read its transcript, or recover its result
after a delivery miss (0019) — it holds a scheduler id and nothing else. Recovering the
invocation meant scanning `agentManage`, which lists up to five recent invocations per
agent and is the wrong tool for a lookup by identity.

## Gap

A caller holding a pending delegation needs the child's identity, not just its call
handle. Both ids exist before the child runs — the invocation record is created at
launch, which is why `newInvocationOf()` can find it by `parentCallId` — so withholding
them from the placeholder costs a discovery round trip for information the runtime
already has.

## Why it is the way it is

The placeholder is a projection artefact, not a result. Unfinished calls are answered
with a stand-in so the provider pairing stays valid (`src/harness.ts:172-180`,
`:6731-6738`), and the pending view is built from the scheduler's board — call ids and
elapsed time — which is why `callId` is the only identity available there. The terminal
envelope reads the invocation record instead (`src/harness.ts:4253-4262`), and the
record is matched by the spawning call id plus scope (`:4126-4145`, `newInvocationOf`),
so the mapping from `callId` to `invocationId` exists in the runtime but is not exposed
until the call settles. The description acknowledges the placeholder shape
(`src/tools/runtime/delegate.tool.ts:164`) without offering the identity that would make
it actionable.

## Evidence

| Fact | Source |
|---|---|
| The placeholder shape is `{ status: "pending", callId }` | `src/tools/runtime/delegate.tool.ts:164`; observed live as `{"status":"pending","callId":"call_19d6e84a…","name":"delegate","elapsedMs":229885,"note":"…"}` |
| The terminal envelope carries `invocationId` and `threadId` | `src/harness.ts:4253-4262` (success path) and `:4230-4236` (unfinished path) |
| The invocation record exists at launch and is findable from the call id | `src/harness.ts:4126-4145` (`newInvocationOf` matches `record.parentCallId === selfCallId` and `parentScope`), fed by `context.callId`/`context.runScope` from `src/tools/runtime/delegate.tool.ts:186-208` |
| The caller is told to use `invocationId` for continuation | `src/tools/runtime/delegate.tool.ts:164` ("read the rest with `agentResult` using `invocationId` and `nextOffset` as offset") |
| `agentManage` is a poor substitute | it returns up to five previews per agent (`AGENT_MANAGE_LIST_PER_AGENT`, imported at `src/harness.ts:318`) and was observed as `truncated: true` during the same session |
| Runtime, 2026-11-11 | every pending placeholder in the 19-call pass carried `callId` only; recovering the child required `agentManage` or a guessed `agentResult` invocation id |

## Proposal

Resolve the child's invocation record when the placeholder is built and include
`invocationId` and `threadId` in it, using the same `parentCallId` + `runScope` match the
terminal path already uses. If the record is not yet registered — a child refused before
it started — omit both rather than inventing them, exactly as the terminal path does when
`record` is undefined. Update the description's placeholder sentence to name the fields so
a caller knows it can act on a pending child immediately.

**Alternatives considered.**

- *Accept `callId` as the only handle and add a lookup by it.* Rejected: it adds a new
  query surface for information that is already resolvable at placeholder time.
- *Give `agentResult` a `callId` parameter.* Rejected as the primary fix: it helps
  recovery but not `threadSend`/`threadRead`, which need the thread id.
- *Leave it and document the `agentManage` workaround.* Rejected: `agentManage` is
  per-agent and preview-capped, so it cannot answer "which run did this call start" when
  siblings are in flight.

## Acceptance criteria

1. A `pending` placeholder for a child that started carries `invocationId` and, when the
   child owns a conversation, `threadId`.
2. A `pending` placeholder for a child that never started carries neither, and does not
   carry an empty-string substitute.
3. With three siblings in flight, each placeholder carries the identity of its own child —
   the existing sibling-attribution guarantee is extended to the pending state.
4. The description states the placeholder's fields.

## Tests to add

- `src/harness.delegation.test.ts` — a parked child: assert the pending answer carries the
  same `invocationId` the terminal envelope later reports.
- `src/harness.delegation.test.ts` — three concurrent siblings: assert three distinct
  `invocationId`s in the pending answers, matching the three terminal envelopes.
- `src/harness.delegation.test.ts` — a child refused before dispatch (a stopped thread):
  assert no `invocationId` key rather than a fabricated one.

## Out of scope

- Making the placeholder deliver the result (0019).
- Cancelling by `invocationId` instead of `callId`.
- Changing the terminal envelope's fields.

## Update (2026-11-11) — independent review

- **Verdict: confirmed, severity lowered from the reporter's Medium to Minor**, and
  re-characterised: the thin payload is a **pinned decision, not an oversight**. The placeholder
  is exactly `{ status: 'pending', callId, name, elapsedMs?, note }`
  (`src/harness.ts:6873-6890`, `status: 'pending'` at `:6879`) and
  `src/harness.delegation.test.ts:1559` asserts it with `toEqual`, so any fix must edit that
  test rather than claim a regression-free change.
- **Constraint the Proposal must respect:** the placeholder is generic to **every** async tool
  and is built from the scheduler's pending entry, which carries no delegate-specific identity.
  The fix must specialise the projection for `delegate` (resolving the child's record from
  `callId` + `runScope`, as `newInvocationOf` already does at `src/harness.ts:4126-4145`) rather
  than widen the scheduler's view for all tools.
- **Test gap confirmed:** the existing pin covers the payload shape only; nothing asserts that a
  pending answer identifies the child it belongs to.

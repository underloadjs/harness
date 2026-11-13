# 0024 — The `pending` placeholder carries no `invocationId` or `threadId`, which is exactly when the caller needs them

> **Status:** Fixed — 2026-11-14 (schema and both authored descriptions now state the shape;
> one branch of AC2 has no delegate-specific pin — see the update)
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

## Update (2026-11-14) — shipped, with one AC2 branch left unpinned

Verified by reading the current sources and tests (no test was executed by this doc pass — the
sibling owns the suite run), so the line numbers below are current-as-of-today and the evidence
above is dated at its own write.

- **The projection is delegate-specific, exactly as the constraint above demanded.** `projectTranscript`
  now takes an optional `scope` (`src/harness.ts:8093-8102`), resolves the child's record with
  `delegatedRecordOf(scope, call.id)` (`:8209-8212`), and emits `invocationId`/`threadId` only when
  that record is known (`:8222-8223`). The scheduler's generic pending entry was not widened, so the
  non-delegate placeholder is still the thin `{ status, callId, name, elapsedMs }` shape —
  `src/harness.inclusion.test.ts:862` still pins it with `toEqual`.
- **The ids are real ids, not a second derivation.** The pin compares the placeholder's
  `invocationId`/`threadId` against the **terminal envelope** of the same delegation
  (`src/harness.delegation.test.ts:2562`, `:2570-2572`), which is the property the caller needs: one
  child, one identity, from the first turn to the last. The sibling case (AC3) is pinned at
  `:2573` — three different subagents in flight, each placeholder naming its own child. The describe
  that holds both is `src/harness.delegation.test.ts:2499`.
- **AC2 half-met, stated plainly.** The description now says the ids are "ABSENT when the child never
  started, so a missing id means no run, not an unknown one", and the code honours it (`:8222-8223`
  emits only what it resolved) — but **no delegate-specific test pins the absent branch**: there is
  no case in the `:2499` describe, and no `not.toHaveProperty('invocationId')` anywhere in
  `src/harness.delegation.test.ts`. The only pin of an id-less placeholder is the non-delegate one at
  `src/harness.inclusion.test.ts:862`, which is a different door. If the owner wants that branch
  guarded, it needs a case where the child is rejected before a run is minted.
- **Three authored `delegate` descriptions, not two — and they are not interchangeable.** The runtime
  declaration (`src/tools/runtime/delegate.tool.ts:238`) and the metadata projection
  (`src/core/metadata.ts:249`) are **byte-identical** — both templates render the same text, and the
  comment at `delegate.tool.ts:236-237` points at the ownership comparison that holds them equal —
  and both state the placeholder shape, the two ids, and the never-started rule. The third site, the
  static `metadata` literal the catalogue and the generated manifest publish
  (`src/tools/runtime/delegate.tool.ts:124`, manifest row at `src/core/tool-manifest.ts:1193`),
  states the toolCancel half but **never mentions the pending placeholder**: `tool-manifest.ts`
  contains zero occurrences of `status: "pending"`. So a model that discovers `delegate` through
  `/tools` — and the generated Rust row that mirrors it, 0035 — learns a smaller contract than the
  runtime answers with. The AC's "both authored descriptions" is met; this listing gap is a new,
  narrower residual, and closing it means either widening the literal at `:124` or accepting that the
  listing description is a summary rather than the contract.

## Update (2026-11-14, third pass) — addresses re-derived; the description-consistency claim restated, the two residuals confirmed

Read from source and tests; **no test was executed by this doc pass** except
`yarn tools:manifest:check`, which reported `tool-manifest.ts is current (32 descriptors)`. Addresses
are from the working tree at 07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree);
`src/harness.ts` was rewritten twice during the pass, so re-grep the quoted identifier before trusting
a bare line number.

- **The projection, at current addresses.** `projectTranscript` is `src/harness.ts:8166`; the
  delegate-specific block is the comment at `:8268-8277` ("0024 — A PENDING DELEGATION NAMES ITS
  CHILD") with the lookup `const child = … delegatedRecordOf(scope, call.id)` at `:8282-8285` and the
  emission at `:8295-8296` (`...(child === undefined ? {} : { invocationId: child.invocationId })` and
  the same guard on `child?.threadId`). The absent-by-construction branch is stated in the comment at
  `:8279-8281` ("A child that never started … or whose record was evicted contributes NEITHER key: no
  `\"\"` substitute") and implemented by the ternary at `:8283-8285`. The lookup itself is
  `delegatedRecordOf(parentScope, parentCallId)` at `:4500-4517`. The earlier update's
  `:8093-8102` / `:8209-8212` / `:8222-8223` triple no longer resolves — the helper local
  `pendingPlaceholderMessage` is gone and the projection inlines the block.
- **The pins, at current addresses.** `src/harness.delegation.test.ts:2499` (describe) — the AC1 case
  at `:2508` destructures `invocationId`/`threadId` out of the payload (`:2544-2552`), pins the generic
  fields unchanged (`:2553`), and compares the two ids against the **terminal envelope** of the same
  delegation at `:2563-2570`; the AC3 sibling case is `:2573` ("gives each of three siblings in flight
  its own child identity (AC3)"). The thin non-delegate placeholder is still pinned with `toEqual` at
  `src/harness.inclusion.test.ts:862`.
- **What the previous update called "three authored descriptions, not interchangeable" is no longer a
  drift finding, and the way to see that is the generator, not a diff.** `src/core/tool-manifest.ts` is
  generated from each entry's own `metadata` literal, and `yarn tools:manifest:check` reports it
  current, so the row at `:1193` and `src/tools/runtime/delegate.tool.ts:124` agree by construction;
  the runtime declaration template at `:238` and the inlined projection at
  `src/core/metadata.ts:249` are held equal by the ownership pin at
  `src/core/metadata.ownership.test.ts:359` ("keeps delegate metadata literal and pins the inlined
  bounds"). **Refused claim:** this pass could not reproduce the earlier update's "byte-identical …
  1859 chars / 3799 chars" figures — a line-slice comparison of a multi-line template that contains its
  own backticks does not measure what it claims to. The consistency statement above replaces them; the
  numbers should not be cited again without a generator-based method.
- **Residual confirmed: the catalogue still teaches the smaller contract.**
  `grep -cF 'status: "pending"' src/core/tool-manifest.ts` → **0**, and the literal at
  `src/tools/runtime/delegate.tool.ts:124` contains no occurrence of `pending` at all, while the
  runtime declaration at `:238` does. So a model that discovers `delegate` through `/tools` — and the
  generated Rust row that mirrors it (0035) — still learns nothing about the pending placeholder or its
  two ids. Unchanged, still owed, and the fix is one sentence in the literal plus a regenerated
  manifest.
- **Residual confirmed: AC2's never-started branch has no delegate-specific pin.** Across
  `src/*.test.ts` there is **no** `not.toHaveProperty('invocationId')` (or `'threadId'`) anywhere, so
  nothing asserts the absent shape for a delegation; the only id-less placeholder pin remains the
  non-delegate one at `src/harness.inclusion.test.ts:862`. The code branch is
  `src/harness.ts:8283-8285`. A case is owed where the child is rejected before a run is minted.

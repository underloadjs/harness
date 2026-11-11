# 0027 — Every delegation leaves a live thread on the roster, and the model has no way to close one

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/harness.ts` (host threads), `src/tools/runtime/threadList`
> **Date opened:** 2026-11-11

## Context

Nineteen delegations produced nineteen host conversations: `thread-4` through `thread-22`,
each still listed by `threadList` as `status: "idle"` long after its answer had been
delivered, including the ones that were cancelled. Each entry carries an id, an agent, an
origin, a sequence number and an `ownerThreadId`. The parent had no way to close any of
them: `deleteThread` is a host operation, and `delegate` exposes nothing that reaps a
child. The roster is the tool the description points at for addressing children
(`threadSend` / `threadRead`), so it grows with every delegation and buries the
conversations a caller actually wants to talk to.

## Gap

A caller that fans out needs to tell the conversations it still cares about from the ones
that were one-shot answers, and to release the latter. Today the only lever is the store
cap, and the only signal is age. That is an ergonomics problem with a drift risk attached:
a long session's roster becomes unusable exactly when a caller has the most delegations to
track.

## Why it is the way it is

Deliberate, and stated. A delegation child of a host thread becomes its own host
conversation — own id, own transcript, `ownerThreadId` set to the caller — "so concurrent
siblings never mix and every child is addressable/stopped/deleted through the same host
API" (`src/harness.ts:141-152`). Addressability is the point: a child is a conversation
you can read with `threadRead` and post into with `threadSend`, which is how 0024's
missing ids would be used. The roster is bounded, not unbounded: `MAX_THREAD_RECORDS = 256`
(`src/core/thread.ts:46`), documented as a guard against a corrupt or adversarial snapshot
rather than a lifetime policy. What is missing is the other half of the same design: the
host can `deleteThread` a terminal conversation (`src/harness.ts:146-152`), but nothing
reaches that from inside a session, and nothing marks a one-shot child as finished work.

## Evidence

| Fact | Source |
|---|---|
| Each delegation mints its own host conversation | `src/harness.ts:141-152`; observed as `thread-4` … `thread-22`, each with `ownerThreadId: "thread-3"` |
| The roster lists them as live and idle after the answer | `threadList`, 2026-11-11: 19 child threads, all `status: "idle"`, including cancelled invocations 21/26/33/34 |
| The roster is capped, so this is bounded growth rather than a leak | `src/core/thread.ts:46` (`MAX_THREAD_RECORDS = 256`), comment at `:41-45` |
| Deletion exists as a host operation only | `src/harness.ts:146-152` (`deleteThread` purges a terminal host conversation plus its invocation/branch lookups) |
| The description points the caller at the thread tools | `src/tools/runtime/delegate.tool.ts:164` and `src/harness.ts:4253-4262` (`threadId` is emitted so the caller can address the conversation) |
| Cancellation does not retire the conversation | `threadList` after cancellation shows the same `idle` status as a completed child |

## Proposal

Give the roster a lifecycle it can express, without losing addressability. Mark a
delegation child terminal once its envelope has been delivered — the record already knows
it is finished, because the invocation is `completed` or `cancelled` — and have `threadList`
report that state (a `terminal` status, or a `settled: true` flag beside the existing
`status`) with terminal entries listed last and beyond a default filter. Then expose the
existing purge to the model as an explicit, owner-scoped close on the child handle, so a
caller that has read a child's answer can release it through the same host API rather than
a host-only one. Do not auto-delete on completion: `threadRead` after the answer is a
supported use of a finished child, and 0019's delivery fix makes "read it later" the
recovery path.

**Alternatives considered.**

- *Auto-delete a child thread when its envelope is delivered.* Rejected: it would break
  `threadRead`/`threadSend` on a finished child, which is the stated reason the
  conversation exists (`src/harness.ts:141-152`), and it would destroy the evidence 0020
  and 0022 need for a post-mortem.
- *Raise `MAX_THREAD_RECORDS`.* Rejected: it defers the ergonomics problem and the cap is
  a snapshot-integrity guard, not a policy knob.
- *Reuse the subagent's default conversation instead of minting one.* Rejected: it is
  explicitly what the design moved away from, so concurrent siblings mix.

## Acceptance criteria

1. `threadList` distinguishes a settled delegation child from a conversation that is still
   live work, without hiding the settled one.
2. A caller inside a session can release a terminal child conversation it owns, and the
   purge also removes the invocation and branch lookups the host purge removes.
3. Reading a settled child with `threadRead` still works until it is released.
4. Nothing about sibling isolation changes: concurrent delegations still get separate
   transcripts.

## Tests to add

- `src/harness.delegation.test.ts` — after a delegation completes, assert the child's
  roster entry reports the settled state and that `threadRead` still returns its
  transcript.
- The thread test file — an owner-scoped close of a terminal child: assert the thread is
  gone from the roster and its invocation/branch lookups go with it; assert closing a
  running child is refused.
- The thread test file — a caller may not close a thread it does not own.

## Out of scope

- Changing the per-agent default conversations (`agent:<name>`).
- Raising or removing `MAX_THREAD_RECORDS`.
- Cross-session thread persistence.
- Delivery of the envelope (0019).

## Update (2026-11-11) — independent review

- **Verdict: confirmed, severity unchanged (Minor); half the original claim was wrong.** "The
  parent had no way to address them" is incorrect: the terminal envelope carries `threadId`
  (`src/harness.ts:4270`) and `threadSend` / `threadRead` address it, exactly as the description
  says. What is missing is only the release side — `deleteThread` is host/plugin-only, and the
  model-facing thread surface is `threadSend`, `threadRead`, `threadList` and `threadFork`, with
  no close operation.
- **The minting site is now pinned:** a delegation from a host-thread parent calls
  `createThreadState(name, { ownerThreadId: parent.threadId }, true)`
  (`src/harness.ts:10305-10318`), which is why 19 delegations produced 19 conversations.
- **A cliff the original pass missed, and it is more serious than the ergonomics.** The bound is
  not passive: `createThreadState` **throws** once the host-thread count reaches
  `MAX_THREAD_RECORDS` (`src/harness.ts:5125-5128` — "This session already has N independent
  threads; delete a terminal one before creating another (maximum 256)"), with the constant at
  `src/core/thread.ts:46`. So in a long session the 257th delegation fails outright, and because
  nothing inside a session can delete a terminal thread, the caller has no way to free a slot.
  That turns this from a tidy-roster complaint into a hard availability limit reachable by
  ordinary use, and it belongs in **Gap** when the owner takes the issue up.
- **Test gap confirmed:** nothing in `src/harness.delegation.test.ts` asserts thread creation,
  thread count, or the cap for delegated children.

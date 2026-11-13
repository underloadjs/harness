# 0027 — Every delegation leaves a live thread on the roster, and the model has no way to close one

> **Status:** Fixed — 2026-11-13 (see **Update (2026-11-13, fix) — closed** at the bottom)
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

## Update (2026-11-13, fix) — closed

- **Shipped — the release half landed, and with it the scoping that makes the roster
  usable.** The proposal's "expose the existing purge to the model as an explicit,
  owner-scoped close on the child handle" is now the core tool **`threadDelete`**
  (`src/tools/runtime/threadDelete.tool.ts`): one required `thread` id, registered
  with the thread group (`activation: 'threads'`, `order: 255` so the roster stays
  declared first), not searchable and not a direct-call catalogue row, exactly like
  its three siblings. Nothing is automatic and nothing is recoverable, as **Alternatives
  considered** required: a settled child stays fully readable until its owner deletes it.
- **The close is owner-scoped, not host-wide.** The tool calls
  `harness.runtime.threadDelete(callerThreadId, threadId)` → `threadDeleteFor`
  (`src/harness.ts`): the target must be a STRICT DESCENDANT of the caller (walk the
  persistent `ownerThreadId` chain up from the target), so the caller's own thread, an
  ancestor, a sibling, and another agent's conversation are each refused by name. The
  host operation `deleteThread` keeps its unscoped host semantics, and a threadless
  caller (manual `executeTool`, plugin outside any conversation) gets it verbatim.
  Running threads refuse ("stop it first"), the default `agent:<name>` conversations
  refuse, and the delete CASCADES over finished descendants — a running descendant
  refuses the whole delete, so no partial removal is possible. The receipt is
  `{ deleted, removedThreadIds }` — `HarnessThreadDeleteResult`, a new type in this
  pass, reported by the host `deleteThread` door as well as the tool.
- **Acceptance criteria, honestly.**
  1. *Distinguish settled from live* — shipped differently than proposed: no
     `terminal` status or `settled` flag was added. Instead `threadList` is scoped to
     the caller's THREAD FAMILY (own thread, ancestors, descendants, the family's
     `agent:<name>` defaults — `threadFamilyOf`/`familyOfCaller` in `src/harness.ts`),
     which removes the nineteen-unreadable-siblings problem at its root, and the
     existing `status` field already separates a live conversation (`running`) from a
     settled one (`idle`). Settled entries are not hidden: inside the family they are
     listed until released.
  2. *Release with the host purge's reach* — `threadDelete` reaches the same
     `purgeThread` the host door uses, so the invocation and branch lookups go with
     the record, and the removed ids become unknown to threadList/Read/Send/Delete
     ("a deleted id is an error" is now literally true on the model surface).
  3. *`threadRead` on a settled child works until released* — pinned (a released one
     is unknown afterwards, a settled one reads normally).
  4. *Sibling isolation unchanged* — the minting site is untouched; the fix adds the
     release, not a shared transcript.
- **The cap cliff from the independent review is now climbable from inside a session.**
  `createThreadState` still throws at `MAX_THREAD_RECORDS` ("…delete a terminal one
  before creating another (maximum 256)", `src/harness.ts`), but a caller that fans out
  can now free slots itself: read the answer, `threadDelete` the child. The 256-thread
  bound is a policy the model can act on rather than a dead end.
- **Worker mode keeps it canonical.** `threadDelete` is classified in
  `AUTHORITY_RUNTIME_METHODS` (`src/server/workers/capability.ts`), routed with the
  TARGET as the request's `threadId` and the CALLER inside `identity`
  (`src/server/workers/lane-worker-loop.ts`), and executed by the canonical harness
  (`src/server/workers/lane-authority.ts`), so a lane never deletes against a private
  replica and the caller's descendant scope is enforced authority-side.
- **Pins added.** `src/tools/runtime/threadDelete.test.ts` — the entry's metadata /
  registration / import-discipline literals and the execute contract (caller thread +
  trimmed id forwarded, receipt returned untouched, threadless-host passthrough, empty
  ids refused without touching the runtime). `src/harness.thread-runtime.test.ts` — the
  B3/B4/B5 block: the scoped roster is the caller's family while the host roster stays
  session-wide, the two host read seams refuse a sibling by name, `threadSend` reaches
  ancestor/descendant/another agent's default, `deleteThread` reports every conversation
  it released (cascade included), `threadDelete` is a descendant door (a parent reaps its
  child and nothing else), and a running descendant still refuses while a released one
  is unknown afterwards.
- Status is **Fixed**. The log's rule for a closed issue is to delete the file and
  drop the index row; the file is kept, with the row marked, so the fix can be
  reviewed against its issue in the same pass — the owner's integrated run decides,
  and deletion is then a one-command step.

# 0027 — Every delegation leaves a live thread on the roster, and the model has no way to close one

> **Status:** Fixed — 2026-11-13, with **C6 closed 2026-11-14** (see the dated **Update** sections
> at the bottom; the last one records the cascade owner being made durable, which supersedes the
> "live-state only" boundary the previous update recorded)
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

## Update (2026-11-14) — the receipt grew, one address this entry called final is now refused, and the family gained a fifth member

- **Correction to the sentence above, which the 2026-11-13 update states as final:** the receipt
  is no longer `{ deleted, removedThreadIds }`. It is
  **`{ deleted, removedThreadIds, removedInvocationIds, removedBranchIds }`** — the id the caller
  named, every conversation that actually went (cascade included), and which agent-result records
  and branch lookups were purged with them
  (`src/types/index.ts:1195-1216`, computed by `purgeThread`'s outcome in `src/harness.ts:6304` and
  carried by both doors, `deleteThread` at `:6359` and `threadDeleteFor` at `:6519`). The reason is
  the consumer-visible half of a reaping loop: deleting a conversation silently SHRINKS the
  agent-result registry — `agentManage` drops an invocation and `agentResult(id)` starts throwing —
  and the purge already knew which ids it was dropping and threw those sets away
  (`src/harness.ts:6290`, stress-report item #6). **Both id lists are always present and empty when
  nothing went**, so "purged nothing" and "did not say" are different answers; that is a report, not
  a durability change — a released conversation's results stay released.
  - Pins: `src/harness.thread-runtime.test.ts:1837` ("reports on the receipt which invocations and
    branches the delete purged (M2 + stress report #6)"), the empty-arrays-not-omitted rule at
    `:3130-3141`, the tool-entry contract at `src/tools/runtime/threadDelete.test.ts:174` ("from a
    build that says nothing"), and the worker-mode leg below.
- **A `branch-N` id is refused as a delete address, not treated as unknown.** The 2026-11-13 update
  describes the descendant rule as the whole address policy; a fork branch id now has its own
  refusal (`branchDeleteRefusal`, `src/harness.ts:6078`): the delete seam resolves the branch ledger
  and refuses the id by name instead of answering "unknown thread", because the branch holds no
  thread slot of its own and its record leaves with the conversation that forked it (stress-report
  items #4 and #5; `src/tools/runtime/threadDelete.test.ts:157` names it "THE SIXTH" address case,
  and `src/harness.fork.test.ts:1705` records that what changed was the SENTENCE, not the outcome).
- **Worker mode: the delete reaches lane-archived results.** The 2026-11-13 update says the lane
  routes `threadDelete` and the canonical harness performs it — true, and incomplete: an archived
  invocation now travels WITH its conversation. The `result:archive` commit names the persistent
  thread the invocation ran in (`src/server/workers/lane-commit.ts:267`, "The PERSISTENT
  conversation this invocation ran in (stress report #6)"), the coordinator's durable projection
  reconstructs the same ownership, and the authority-side purge therefore removes lane-archived
  results exactly as the inline door does — a fork branch's result included, whose owner is the
  conversation that forked it (`src/server/workers/lane-authority.ts`,
  `src/server/workers/lane-worker-loop.ts`, `src/server/sessions.ts`). Pinned by
  `src/server/workers/lane-worker-correctness.test.ts:423` ("worker mode: a deleted conversation
  purges its lane-archived results (stress report #6)"); `src/server/workers/lane-authority.test.ts:14`
  records that an operation WITHOUT the field keeps the weaker, documented behaviour, so the field is
  an upgrade path, not a breaking requirement.
- **The THREAD FAMILY this entry's fix introduced has one more member, and one more sentence.** The
  family rule stated above (own thread, ancestors, descendants, the defaults the family spans)
  gained a fifth, transient member on 2026-11-14: the reply target of the run attached to the
  conversation — the id of whoever STARTED a dormant default conversation — folded in for the life
  of that run only, never persisted
  (`src/harness.ts:6058-6061`, `RunState.replyThreadId` at `:5135-5149`;
  `docs/issues/minor-threadsend-that-starts-a-default-conversation-leaves-the-woken-turn-unable-to-answer.md`,
  0030). And a refusal that used to end at "it is simply outside your lineage" now appends the cause
  and the remedy when the address is a default conversation that left the family
  (`defaultFamilyClauseOf`, `src/harness.ts:6185`, appended at `:5630-5632`; pinned by
  `src/harness.thread-runtime.test.ts:2825`), which is the sentence a caller needs when 0027's
  release door is the reason the address stopped resolving.
- **The four acceptance criteria of this entry still read as shipped** — nothing in the 2026-11-14
  pass changed the descendant-only scope, the running/descendant refusals, the readability of a
  settled child, or sibling isolation. Status stays **Fixed**; the receipt sentence in the
  2026-11-13 update is superseded by this one.


## Update (2026-11-14, independent review) — the purge cascade is a live-state rule, not a durable one (C6)

- **What the four-field receipt and the lane-parity claim above do NOT say.** Both are stated for
  the cascade as it runs in live state. `purgeThread`'s invocation predicate is
  `record.threadId === threadId || record.invocationId === state.record.invocationId`
  (`src/harness.ts:6329-6334`), and the FIRST half is what carries ownership for everything except
  the one invocation a thread most recently ran — including the lane-archived results the
  2026-11-14 update above made parity-able. That ownership field is **not persisted**:
  `HarnessAgentResultSnapshot` has no `threadId` (`src/types/index.ts:3315-3333`), the snapshot
  projection omits it (`src/harness.ts:12311-12324`), and the restore re-insert writes records
  without it (`src/harness.ts:12651-12663`).
- **The boundary, in one sentence.** After a `snapshot()` → `restore()` round trip, a later
  `threadDelete`/`deleteThread` of that conversation removes only what the SECOND predicate still
  reaches — the single invocation id the restored thread record carries — and purges none of the
  thread's other records, inline or lane-archived: their `threadId` no longer exists to match, so
  they stay on the roster and the receipt reports them as not removed. A restored thread that was
  `running` at snapshot time keeps even that one hook, because a running thread's record persists
  no `invocationId` at all (`src/harness.ts:12343-12348`).
- **Pre-existing, and not a regression from this pass.** The shape predates the 2026-11-13/14
  work; what this review wave added is a report of the cascade (the two id sets) and a lane parity
  fix that both ride on the un-persisted field. Nothing pinned by
  `src/harness.agent-results.test.ts:1383` or `src/server/workers/lane-authority.test.ts:544`
  changes — both assert against live state, and **no test asserts a purge after a restore round
  trip**, so this boundary is currently unobserved by the suite.
- **Follow-up work, deliberately not taken here.** No code change and no snapshot-shape change:
  making the cascade durable means adding `threadId` to `HarnessAgentResultSnapshot` and to both
  the projection and the restore, which widens a persisted document shape and needs the owner's
  version decision (and a decision about `parentCallId`/`parentScope`, which the same record also
  drops). Until then the purge/parity rule in this file and in `knowledge.md` is a
  live-session-lifetime rule.


## Update (2026-11-14, independent review) — the "left the family" clause no longer blames the caller for a delete it did not perform (C2)

- **What was wrong with the sentence, not with the verdict.** The clause `defaultFamilyClauseOf`
  appends (`src/harness.ts:6198`, at the read door `:6231` and the `threadSend` door `:5634`)
  stated the cause as fact: "it left your lineage when the last of your conversations running
  `X` was deleted". The clause fires for ANY out-of-family `agent:<name>` address, and a caller
  that never delegated to that agent never had its default in its lineage — so the refusal accused
  a model of a release it had not made. (This is the message-level twin of C5 in issue 0029: an
  inferred cause published as an observed one.)
- **The cause is now an either/or; the remedy is not.** The clause reads
  "…is agent `X`'s default conversation, so either it was never in your lineage or it left when
  the last of your conversations running `X` was deleted. Delegate to `X` again — the conversation
  it mints re-admits this address, and threadRead/threadSend reach it from then on." The remedy
  stays unconditional because re-delegating admits the address under either cause.
- **Nothing else moved.** The family rule, the verdict (still invisible), and the base sentence are
  untouched: a NON-default out-of-family address — a sibling, an ancestor, another family's
  thread — still gets "…The id exists — it is simply outside your lineage." with nothing appended,
  byte for byte. That is pinned, not asserted: the same run that witnesses the default refusal
  also refuses a sibling, and the third door result in
  `src/harness.thread-runtime.test.ts:2825` ("a default conversation that left the family names
  the cause and the remedy") is the sibling sentence with no clause. The exact default clause is
  pinned at `:2864` (`const defaultClause`).
- **Citations for the 2026-11-14 entry above, re-derived.** It cites `defaultFamilyClauseOf` at
  `src/harness.ts:6185`, appended at `:5630-5632`, pinned at `src/harness.thread-runtime.test.ts:2825`.
  The current addresses are `:6198` (definition), `:6231` (read door), `:5634` (`threadSend` door);
  the pin's test is still `:2825`, and its clause literal now sits at `:2864`.

## Update (2026-11-14, second pass) — C6 closed: the cascade owner is now on the durable row

The owner's version decision recorded as "deliberately not taken" in the C6 review has been taken.
Verified by reading the current sources and tests; **no test was executed by this doc pass**.

- **The field exists and is optional-by-construction.** `HarnessAgentResultSnapshot` carries
  `threadId?: string` (`src/types/index.ts:3405`), and the comment at `:3400-3404` states the three
  rules the C6 review asked to be decided: ABSENT means *no owner*, never *unknown owner*; an empty
  string is rejected at the load boundary; and — unlike 0033's forensic pair — the key is **legal on
  a completed result**, because a finished turn still belongs to its thread.
- **Both halves of the round trip write and read it.** The projection spreads it only when present
  (`src/harness.ts:12823`, `...(record.threadId === undefined ? {} : { threadId: record.threadId })`)
  and the restore does the same (`:13184`), so a restored record has "exactly the shape a live one
  has — no `\"\"` owner for a root run". The reader accepts it in the optional-key list
  (`src/core/snapshot.ts:148`), reads it in the same group as 0033's forensic keys instead of dropping
  it (`:155-159`), and rejects `threadId: ""` on disk as a hand edit (`:281-288`).
- **So the boundary sentence flips.** `purgeThread`'s first predicate — `record.threadId === threadId`
  (`src/harness.ts:6431`, and the sibling predicate at `:6444`) — now survives `snapshot()` →
  `restore()`, which is the half that owns "everything except the one invocation a thread most
  recently ran". A restored conversation that is deleted still takes its other records with it,
  inline and lane-archived alike.
- **The observation the C6 review said was missing now exists.** `src/harness.agent-results.test.ts:1797`
  (inside the 0033 describe at `:1706`) asserts the live conversation's `deleteThread` receipt and the
  restored conversation's `deleteThread` receipt **in the same run**, and they are byte-identical —
  `{ deleted, removedThreadIds: [threadId], removedInvocationIds: [invocationId], removedBranchIds: [] }`
  at `:1870-1881`. That is the "no test asserts a purge after a restore round trip" gap, closed. The
  server-document half is pinned in `src/server/threads.test.ts:3189-3205`, which asserts the on-disk
  row with `threadId: 'thread-2'` and names this cascade in its own comment.
- **What C6 still leaves open, unchanged.** `parentCallId`/`parentScope` remain unpersisted — neither
  appears anywhere in `src/core/snapshot.ts` — so a restored row still cannot name the call that
  spawned it, and the C6 review's second question stays with the owner.
- **Citations in the C6 review above are now historical**, and the current addresses are the ones
  listed here: `src/harness.ts:6329-6334` → `:6431`/`:6444`; `:12311-12324` (projection) → `:12823`;
  `:12651-12663` (restore) → `:13184`; `:12343-12348` (running thread mints no `invocationId`) and
  `src/types/index.ts:3315-3333` (the pre-`threadId` record shape) were not re-opened, since both are
  statements about the state before this change.
- **One source comment went stale as a side effect of this fix** (not this pass's file, so reported):
  `src/server/workers/lane-worker-loop.ts:1100-1105` still justifies the lane's `threadId: lane.targetId`
  by saying "the snapshot projection this loop reads (`HarnessAgentResultSnapshot`) does not carry
  it". It does now, so that line states the same fact from a second source — the row's value and
  `lane.targetId` agree today (a lane replica runs exactly one conversation), but nothing pins that
  they stay equal. Reconciling them (read the row, fall back to `targetId`) is a one-line change the
  worker owner should take or pin.

## Update (2026-11-14, third pass) — C6 re-verified at current addresses, and the two residuals above are closed

Read from source and tests; **no test was executed by this doc pass**. Addresses are from the working
tree at 07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree); `src/harness.ts`,
`src/types/index.ts`, `src/core/snapshot.ts` and the `src/server/workers/lane-*.ts` files all moved
during the pass, so cite the quoted identifier and treat the bare line numbers as a snapshot.

- **The durable owner is confirmed end to end.** `HarnessAgentResultSnapshot.threadId?: string` is
  `src/types/index.ts:3405`, and the comment at `:3388-3404` still states the three rules the C6
  review asked to be decided — ABSENT means *no owner* (`runThreadId`, `src/harness.ts:12415`), an
  empty string is rejected at the load boundary, and the key is legal on a completed result. The
  projection writes it (`src/harness.ts:12926`), `restore()` re-attaches it (`:13288`), the reader
  keeps it in the may-be-absent list (`src/core/snapshot.ts:148`) and the read-not-dropped group
  (`:155-159`), and rejects `threadId: ""` as a hand edit (`:279-288`). `purgeThread`'s predicate is
  `record.threadId === threadId || record.invocationId === state.record.invocationId` at
  `src/harness.ts:6445-6448` (def `:6433`), with the branch predicate at `:6457-6462`, so the first
  disjunct is what survives the reload.
- **The pins the C6 review said did not exist now exist, and they assert parity.** Inside
  `src/harness.agent-results.test.ts:1802` (describe `:1711`), the block labelled "SURFACE 4"
  (`:1869-1892`) deletes the pre-reload conversation and the post-reload one in the same run and
  requires identical receipts — `{ deleted: threadId, removedThreadIds: [threadId],
  removedInvocationIds: [invocationId], removedBranchIds: [] }` at `:1875-1886` — then asserts neither
  harness keeps the row (`:1890-1892`). The server-document half is
  `src/server/threads.test.ts:3187-3205`, whose expected on-disk row names `threadId: 'thread-2'` at
  `:3204` with the cascade spelled out in the comment above it.
- **Residual closed — the stale lane comment.** `src/server/workers/lane-worker-loop.ts:1120-1125`
  now carries the correction: the clause claiming the snapshot projection "does not expose `threadId`"
  "stopped being true when issue 0033/0024 taught the projection to write the owner WITH the row", and
  it records why `archiveDigestOf` still excludes the key (the authority assigns it). Nothing was
  reconciled by reading the row instead of `lane.targetId` — the lane still states
  `threadId: lane.targetId as string` at `:1126` — and that is now acceptable, because the equality is
  pinned rather than assumed: `src/server/workers/lane-worker-correctness.test.ts:584` asserts
  `row.threadId` equals the conversation the lane wrote, and describe `:446` ("a deleted conversation
  purges its lane-archived results (stress report #6)", delete at `:468`) pins the cascade itself in
  worker mode.
- **Still owed, unchanged: the spawn address.** `parentScope` / `parentCallId` appear **0** times in
  `src/core/snapshot.ts`, and `restore()` rebuilds records without them (`src/harness.ts:13268-13289`),
  so a restored row still cannot name the call that spawned it and `delegatedRecordOf` (`:4500-4517`)
  cannot address a restored child. The C6 review's second question therefore stays with the owner; the
  test that would pin the consequence is now listed under **Tests to add** in 0033.
- **The receipt's four fields are documented where the model reads them.** `src/tools/runtime/threadDelete.tool.ts:44`
  names `deleted`, `removedThreadIds`, `removedInvocationIds` and `removedBranchIds` ("an empty array
  means none went, not that the receipt is silent"), matching `HarnessThreadDeleteResult` at
  `src/types/index.ts:1213-1215`; the shape above is the pin.
- **`knowledge.md` still asserts the C6 boundary this entry closed** — `knowledge.md:2961-2975`,
  "`threadId` is never persisted — `HarnessAgentResultSnapshot` has no such field
  (`src/types/index.ts:3315-3333`), and neither the snapshot projection (`src/harness.ts:12311-12324`)
  nor the restore … (`src/harness.ts:12651-12663`)". Reported, not edited: `knowledge.md` is outside
  this pass.

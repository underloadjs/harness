# 0030 — A `threadSend` that starts a default conversation leaves the woken turn unable to answer its sender

> **Status:** Fixed — 2026-11-14 (see **Update (2026-11-14, fix) — closed** at the bottom)
> **Severity:** Minor
> **Area:** `src/harness.ts` (`postThreadMessage`'s dormant-start branch, `threadFamilyOf`, `RunState`)
> **Date opened:** 2026-11-14
> **Found by:** the 2026-11-14 `delegate`/thread stress pass, item #1 of that pass (the report itself is not in the tree; the fix carries the item number in `src/` comments as `T5/#1`).

## Context

`threadSend { thread: "agent:scout", message: … }` into a DORMANT default conversation is a
documented door: the message is the run's prompt and the receipt says `delivered: 'started'`.
The turn that starts has one obvious thing to do — answer the party that woke it, either with
the result or with a question back. It cannot. That run has no parent (a parent would put the
sender's brain in the lineage and read as a delegation cycle between two threads of one
agent), so nothing ever writes an `ownerThreadId` for an implicit default conversation, and
steps 2-4 of `threadFamilyOf` compute a SINGLETON family: the conversation itself. So inside
that very turn, `threadList` answers with exactly one row, and both `threadRead { thread:
<sender> }` and `threadSend { thread: <sender> }` are refused with the sentence that is wrong
for this caller:

> `Thread "thread-7" is not visible to thread "agent:scout": … The id exists — it is simply
> outside your lineage.`

The sender's id is not hidden from the woken turn — its prompt is stamped
`from agent "writer" (thread thread-7):` and the recorded send carries `senderThreadId` — so
the runtime tells the model where to reply and then refuses the reply.

## Gap

The conversation with the strongest claim on the woken turn's attention is the one address it
cannot use. A started default conversation can only report back through its own final answer,
which reaches the sender only if the sender happens to poll `agentResult`; it cannot read the
sender's transcript for context, cannot ask it a clarifying question, and cannot post an
intermediate result. Before the family scoping (0027's fix, 2026-11-13) the same calls
succeeded — for the wrong reason, because everything was reachable — so this is a reachability
corner a deliberate fix introduced, not a pre-existing wart.

## Why it is the way it is

The family rule is the security boundary: its roster and its three address doors (`threadSend`,
`threadRead`, `threadDelete`) are computed from ONE set — the caller's own thread, its
ancestors, its descendants, and the `agent:<name>` defaults that family spans
(`threadFamilyOf`/`familyOfCaller`). A sibling is outside it by design, which is what makes
0027's nineteen-unreadable-siblings problem go away. A default conversation woken by a send has
no edge in that graph: `postThreadMessage`'s dormant-start branch starts the run with no parent
and no owner link. The first-wins `ownerThreadId` is a PERMANENT lineage field for a host thread —
it is what the ancestor/descendant walks and the descendant-only delete door read — and for an
implicit `agent:<name>` conversation it is RUNTIME-ONLY: a reset deletes it and "a restart would
not reproduce it anyway" (`src/harness.ts:13801-13805`), which is also why `threadFork` refuses an
`agent:<name>` target. With no edge, the singleton family is the only honest answer the rule can
give. What was missing was the one transient edge the run itself knows: who woke me.

## Evidence

| Fact | Source |
|---|---|
| A dormant default target is STARTED by the message, with the sender recorded on the receipt | `src/harness.ts:5647-5656` (the one receipt builder: `threadId`, `delivered`, `sender`, `senderThreadId`, optional `note`) |
| That run is fired with NO parent, and the reason is stated | `src/harness.ts:5802-5822` (the reply-target comment: a parent "would put the sender's brain in the lineage and turn two threads of one agent into a 'delegation cycle'") |
| An implicit default conversation's owner link cannot carry a durable grant | `src/harness.ts:5806-5808`; it is RUNTIME-ONLY — a reset deletes it and "a restart would not reproduce it anyway" (`:13801-13805`), which is also the constraint behind `threadFork` refusing an `agent:<name>` target |
| The family is therefore the caller alone, and both doors refuse | `threadFamilyOf` steps 2-4, `src/harness.ts:5985-6061`; the refusal sentence is pinned verbatim at `src/harness.thread-runtime.test.ts:3479-3485` |
| The woken turn is told the sender's id | the recorded send carries `senderThreadId` (`src/harness.ts:5654`; `src/types/index.ts:3002-3003`) and the reply lands stamped `from agent "scout" (thread agent:scout):` (`src/harness.thread-runtime.test.ts:3471-3474`) |
| Runtime, 2026-11-14 stress pass: the woken turn's `threadList` returned one row and its reply to the sender was refused | stress pass item #1; the observation is reproduced as a test (`src/harness.thread-runtime.test.ts:3381`), not stored as an artifact in this repo |

## Proposal

Give the started run the one edge it is missing, on the RUN rather than on the record: the
`threadSend` that starts a default conversation passes the SENDER's thread id into the run
(`RunInternals.replyThreadId` → `RunState.replyThreadId`), and the family rule folds that id in
as one extra member for the life of that run. Nothing else about the family changes; the route
disappears when the run releases, because the field lives on the run and not on the thread
record.

**Alternatives considered.**

- *Adopt the sender as the default conversation's `ownerThreadId`.* Rejected, and the reason is
  recorded at the new field: the link is permanent and first-wins, so the first caller to wake
  an agent would weld its own family onto another agent's STANDING transcript and every later
  caller would be measured against it — and the link survives no restart, so the grant would
  silently evaporate on restore, changing the woken agent's reach mid-session
  (`src/harness.ts:5139-5143`).
- *Admit every thread of the woken agent's own family into scope.* Rejected: that is the
  sibling visibility 0027's fix removed on purpose, paid for with the leak of other callers'
  conversations.
- *Leave it refused and make the host relay the answer.* Rejected: the host is not always
  there (a `delegate` child and a peer thread post into defaults with no host in the loop), and
  a relay costs a round trip per message to route something the runtime already knows.
- *Relax the delegation-cycle rule and give the run its parent.* Rejected: cycle detection reads
  the lineage, and a lineage edge between two threads of one agent is exactly the cycle the rule
  refuses.

## Acceptance criteria

1. Inside the started run, `threadList`/`threadRead`/`threadSend` all accept the sender's id.
2. The route names EXACTLY one id — the sender's. Nothing else in the sender's family becomes
   reachable, and the woken agent's roster does not grow beyond itself plus that id.
3. The route is TRANSIENT: once the run releases, the same address produces the ordinary
   out-of-family refusal again.
4. Nothing is persisted to buy it: `ownerThreadId` stays absent on both the default
   conversation and the sender, so a later caller from another family is not locked out.
5. The route exists only where it is needed: a DEFAULT target (`origin === 'agent'`) woken by a
   sender that has a thread id. A dormant HOST thread the caller starts already reaches the
   caller through the owner chain, and a threadless caller is unscoped by definition.
6. No `note` is emitted naming an id the caller cannot address (`docs/issues/minor-threadsend-note-names-a-thread-the-caller-cannot-address.md`, 0031).
7. A run-start failure does not strand the conversation or its next turn — the transient field
   must not outlive a run that never got to run.

## Tests to add

- `src/harness.thread-runtime.test.ts` — the wake/read/reply round trip, with the receipt and
  the reply's prompt stamp pinned, and the post-run refusal pinned (`:3309` describe group,
  `:3381` "the woken turn lists, reads and answers its sender, and the route reverts (T5 AC1-AC4)").
- `src/harness.thread-runtime.test.ts` — the note rule for the same shape: withheld when the
  live conversation is out of reach (`:3495`).
- `src/harness.thread-runtime.test.ts` — a hook failure around the started run leaves the
  conversation idle and its next turn working (`:3547`).

## Out of scope

- Making `agent:<name>` conversations deletable or forkable (still refused; 0027).
- Widening the family rule beyond the one transient reply edge.
- Delegation follow-up continuity, which is a prompt-text defect, not a runtime one (0028).
- The `note` address rule and what it may name (0031).
- Parked-target steering: a `paused` target is queued, not started, and keeps its own rules.

## Update (2026-11-14, fix) — closed

- **Shipped as proposed — one transient field, one extra family member.** `RunState` carries
  `replyThreadId` (`src/harness.ts:5135-5149`) and `RunInternals` the same
  (`:5279-5284`, with the "never on the thread record" note that makes the transience
  structural). `postThreadMessage`'s dormant-start branch is the ONLY writer
  (`:5802-5822`, `replyTarget` computed from `origin === 'agent' && sender.threadId !==
  undefined`), the run adopts it at creation (`:11907-11913`), and step 5 of `threadFamilyOf`
  folds it into the family (`:6058-6061`). Because the roster, the send gate and read
  visibility all resolve through `familyOfCaller`, the three doors moved together — there is no
  door where the id is listed but refused.
- **Acceptance criteria, all met.**
  1. Route exists — pinned by `src/harness.thread-runtime.test.ts:3381` (list, read, reply).
  2. Exactly one id — the same test pins the roster at EXACTLY two entries, the scout's own
     default conversation and the sender's thread (`:3407-3435`), with `agent:writer` absent even
     though a SEND to it is in scope. The ordering is what buys that: step 4 computes the spanned
     AGENTS before step 5 folds the sender in, so the fold "adds one id and nothing else" — no pull
     of the sender's subtree, no other agent's standing transcript.
  3. Transient — `:3476-3485` pins the byte-identical out-of-family refusal once the run has
     released.
  4. Nothing persisted — `:3487-3492` asserts `ownerThreadId` is absent on BOTH conversations
     after the round trip.
  5. Narrow scope — the guard is the two-condition `replyTarget`; a host-thread target needs no
     route (it is already in the caller's subtree) and a threadless caller stays unscoped
     (`:5813-5821`).
  6. Note discipline — `:3495` ("the ambiguity note is withheld when the live conversation is
     out of reach") and 0031's family filter.
  7. A failed run start strands neither the conversation nor its next turn — `:3547`.
- **Description half (not this file's owner):** the `delegate`/`threadSend` prose that points a
  caller at a follow-up already matches the shipped rule — a follow-up into a child goes through
  `threadSend`, and a woken default conversation can now answer its sender.
- Status is **Fixed**. The log's rule for a closed issue is to delete the file and drop the
  index row; the file is kept, with the row marked, so the fix can be reviewed against its
  issue in the same pass — the owner's integrated run decides.

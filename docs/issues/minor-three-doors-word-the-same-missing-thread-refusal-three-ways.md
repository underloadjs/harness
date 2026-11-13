# 0034 — Three doors word the same missing-thread refusal three ways, so a caller cannot tell one fact from a grep

> **Status:** Fixed — 2026-11-14 (the parity is pinned against the source files, which is how the
> divergence got caught in the first place)
> **Severity:** Minor
> **Area:** `src/harness.ts` (`threadStateOf`), `src/server/workers/lane-authority.ts`
> (`thread:read`), `src/tools/runtime/threadRead.tool.ts` (the record tail)
> **Date opened:** 2026-11-14

## Context

An operator comparing two refusals for one id. Inline, `threadRead` on a thread that does not
exist answers `Thread "thread-99" is not available in this harness; it was never created, or it
was deleted.` Switch the same session to `worker` mode and the identical call — same tool, same
id, same harness state — answered `Thread "thread-99" has no record in this session; it was never
created, or it was deleted.`, and a third phrasing, `has no record in this harness`, came from
the tool's own record tail. The reasonable conclusion was that three different things had
happened, when one lookup had failed in one way. On the routed door the wording is not a
presentation detail: a lane rejection crosses the worker boundary as **message text only**, so
the sentence is the entire record of the fact on that side, and a log searched for one phrasing
misses the other two.

## Gap

An id that does not exist is ONE fact, and every door that refuses it should say so with one
sentence a caller can match — inline, on a lane, and through a model-facing tool — so that
"the thread was never created / was deleted" is greppable across execution modes and needs no
per-door matcher in the client.

## Why it is the way it is

Each door grew its own sentence, and nothing could see them together. The core guard is
`threadStateOf` (`HEAD:src/harness.ts:5070-5078`), which throws a `HarnessError`; every internal
seam that needs a live thread state routes through it, so the transcript read
(`threadMessages`), the transcript write (`setThreadMessages`), the send/park path
(`postThreadMessage`) and `stopThread` all already shared one head — which is why the pins in
`src/harness.thread-read.test.ts:731`, `src/harness.thread-park-queue.test.ts:517` and
`src/harness.fork.test.ts:1699` all quote the same sentence. The two that drifted are the doors
that do NOT go through that guard: the routed read answers from `harness.thread()` (a record-or-
`undefined` seam, deliberately silent — `src/harness.ts:5404` guards state, not records), and
`threadRead`'s tail fires when the record read returns `undefined`. The drift is visible in the
tool's own pre-fix comment: `HEAD:src/tools/runtime/threadRead.tool.ts:185` says
"`threadMessages` is the canonical read: it throws the harness's own 'not available in …' error"
while the throw three lines below (`:205-206`) spelled a different head. There was no test that
could look at the three together, which is exactly how they drifted: each door had its own pin,
and each pin passed.

## Evidence

Pre-fix lines are from `HEAD` of this package; the unified lines are the shipped state.

| Fact | Source |
|---|---|
| Head 1 — the core guard (the sentence every internal seam already shared) | `HEAD:src/harness.ts:5070-5078` (`threadStateOf`, message at `:5075`), a `HarnessError`. Now `src/harness.ts:5404-5414`, message at `:5409` |
| Head 2 — the routed read said "session" | `HEAD:src/server/workers/lane-authority.ts:956` — `Thread "<id>" has no record in this session; …`. Now `src/server/workers/lane-authority.ts:971`, with the reason for the choice in the comment at `:956-970` |
| Head 3 — the tool's record tail said "harness" but "no record" | `HEAD:src/tools/runtime/threadRead.tool.ts:205-206`. Now `src/tools/runtime/threadRead.tool.ts:209-212`, message at `:211` |
| The tool's own comment contradicted its throw at HEAD | `HEAD:src/tools/runtime/threadRead.tool.ts:185` (names the core head) vs `:205-206` (emits another) |
| On the routed door the message is the whole record | `src/server/workers/lane-worker-loop.ts:1795` and `:1893` — a rejected route is reported as `error: <message>` (`error instanceof Error ? error.message : String(error)`), with no code and no structured `threadId`; the surrounding rule is the comment at `:456` |
| A lane has no session object to be phrase-accurate about | `src/server/workers/lane-authority.ts:951-974` — the answer is produced by the CANONICAL harness, and in inline mode a library host holds a harness and never sees a session |
| The record seam stays silent by design (a fourth door that does not grow a sentence) | `src/harness.ts` — `thread(id)` answers `undefined`; pinned at `src/harness.thread-runtime.test.ts:3708` |
| The three per-door pins that already agreed on the core head | `src/harness.thread-read.test.ts:731`, `src/harness.thread-park-queue.test.ts:517`, `src/harness.fork.test.ts:1699`, `src/harness.thread-runtime.test.ts:352`, `:687` |
| The routed pin asserted the divergent head | `src/server/workers/lane-authority.test.ts:1336-1338` (now the unified sentence, as an exact string) |
| A near-miss sentence that is a DIFFERENT fact and keeps its own words | `src/server/sessions.ts:9193` — `Thread "<id>" has no recorded turn to resume.` (a 409 about a stopped conversation that DOES exist) |

## Proposal (what shipped)

Unify on the **core's** head — `Thread "<id>" is not available in this harness; it was never
created, or it was deleted.` — in the two doors that had drifted, and pin the parity itself:

- The routed read (`src/server/workers/lane-authority.ts:971`) and the tool tail
  (`src/tools/runtime/threadRead.tool.ts:211`) now quote the core sentence byte-for-byte; the core
  sentence is unchanged, so no existing pin moved except the routed one, which asserted the old
  head.
- Each of the three sites carries a cross-reference comment naming the other two
  (`src/harness.ts:5398-5403`, `src/server/workers/lane-authority.ts:956-970`,
  `src/tools/runtime/threadRead.tool.ts:205-209`), so an editor at one door sees the other doors.
- The head chosen is the core's because it is the only one true in both execution modes: the
  record is missing **from the harness** — in worker mode the answer comes from the canonical
  harness object, in inline mode from the harness the host holds. "Session" is not an object an
  inline caller has.

**The parity is pinned against the source files, not only against behaviour**
(`src/harness.thread-runtime.test.ts:3760`): it walks every non-test `.ts` under `src/`, counts
occurrences of the sentence, and requires **exactly three files — the three named above — each
carrying it exactly once**. A fourth file is a drift that has started; a second copy inside one
file is the same sentence about to fork. This is deliberate: a behaviour test can only look
through one door at a time, which is precisely the blind spot that let three heads coexist.

**Alternatives considered and rejected.**

- *A shared `threadNotFound(threadId)` helper exported from one module and called by all three.*
  Rejected: the three doors live in three layers (core harness, server worker, tool runtime) and
  the only thing they must share is a string; publishing an internal error-wording helper on the
  package surface makes the wording part of the contract it is not (the sentence is prose for a
  model and an operator, not a code), and the tool and the authority cannot reach `threadStateOf`
  in any case. The source-walk test enforces the same invariant without a new export.
- *Keep "session" on the routed door and "harness" on the tool.* Rejected: the routed door is the
  one whose wording is the whole record, and the session-phrased head is false at the door that
  emits it most (a library host has no session).
- *Normalise in the client with a permissive regex.* Rejected: it leaves three sentences in
  server logs and pushes the divergence onto every consumer.
- *Put the refusal on the lane wire as a structured rejection (`code` + `threadId`).* A wire
  change to the lane protocol (the reply is `{ error: message }` today, `lane-worker-loop.ts:1893`),
  out of scope here — recorded below.
- *Also re-word `sessions.ts:9193` ("has no recorded turn to resume").* Rejected: different fact —
  the thread exists and is stopped — and it already carries its own status code.

## Acceptance criteria

1. One unknown id answers with one sentence at every inline door that refuses it —
   `threadMessages`, `setThreadMessages`, `executeTool('threadRead')`, `executeTool('threadSend')`
   — asserted as one exact-value map, not per-door fragments.
   → `src/harness.thread-runtime.test.ts:3681`
2. "Never created", "deleted" and "created in another harness" produce the same words for the same
   shape of absence, differing only in the id, so a grep for one case finds the others.
   → `src/harness.thread-runtime.test.ts:3714`
3. The routed door raises the same sentence, exactly, with the refused id inside it — because the
   message is all that survives the lane hop.
   → `src/harness.thread-runtime.test.ts:3737` and `src/server/workers/lane-authority.test.ts:1336-1338`
4. Exactly three production sources can write the sentence, each exactly once, and they are the
   three named here.
   → `src/harness.thread-runtime.test.ts:3760`
5. `harness.thread(id)` still answers `undefined` for the same id: the silent record seam does not
   grow a sentence of its own.
   → `src/harness.thread-runtime.test.ts:3711`
6. The unrelated sentences stay unrelated: `sessions.ts:9193` and the fork `branch-N` refusal keep
   their own wording. → `src/harness.fork.test.ts:1699`, `src/server/threads.test.ts` (unchanged).

## Tests to add

Shipped with the fix:

- `src/harness.thread-runtime.test.ts:3638` — `the missing-thread refusal is one sentence, not
  three (issue 0034, F2)`: AC1 (`:3681`), AC2 (`:3714`), AC3 (`:3737`), AC4 (`:3760`).
- `src/server/workers/lane-authority.test.ts:1336-1338` — the routed door's exact sentence, with
  the comment stating why an exact string is required there.

Still owed:

- The same exact-string pin at the **`result:archive`/`thread:read` reply boundary** — i.e. a
  worker-mode test that the string which crosses the lane is the unified one, not merely the one
  the authority throws. Today's pins stop at the throw (`lane-authority.test.ts:1336`), so a future
  reply-shaping change that rewrites message text would not be caught.

## Out of scope

- A structured lane rejection (`code`, `threadId`) on the worker wire. The authority's throw is a
  plain `Error` and the route reply carries `error: <message>` alone
  (`src/server/workers/lane-worker-loop.ts:1795`, `:1893`), so an id is recoverable from the
  sentence only. Changing that is a lane-protocol change, not a wording one.
- Any wording change to the *other* thread refusals: the family/lineage refusals, the
  `branch-N` address refusal, `stopped`-thread refusals, and `sessions.ts:9193`.
- Making `threadStateOf` public, or introducing a published error-code field for a missing thread.
- The `thread(id)` seam's contract (record-or-`undefined`), which stays silent on purpose.

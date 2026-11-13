# 0031 — The `threadSend` note names a live conversation the caller cannot address

> **Status:** Fixed — 2026-11-14 (see **Update (2026-11-14, fix) — closed** at the bottom)
> **Severity:** Minor
> **Area:** `src/harness.ts` (`postThreadMessage`'s `liveSiblingNoteFor`), `src/types/index.ts` (`note`)
> **Date opened:** 2026-11-14
> **Found by:** the 2026-11-14 `delegate`/thread stress pass, item #2 of that pass (the report itself is not in the tree; the fix carries the item number in `src/` comments as `T5/#2`).

## Context

`agent:<name>` reads like "the conversation this agent is having". In a session that delegates,
it is not: the agent's live work is a child thread and the default conversation is a standing
second brain. So a send into a default conversation answers with an advisory `note` (C1,
2026-11-13) naming the conversation that is actually in flight:

> `"agent:scout"` is scout's default conversation, and this message went there. The live scout
> conversation is thread "thread-11"; address that id to reach the turn in flight.

The scan that finds that conversation walks **the whole session**. It prefers a running thread
the caller owns (a descendant — always addressable) and falls back to "the newest running one".
The fallback is the problem: in the same 2026-11-13 pass, the roster and the three address
doors were scoped to the caller's THREAD FAMILY (0027's fix), and a SIBLING is deliberately
outside that family. So the receipt began naming an id and the very next call answered:

> `Thread "thread-11" is not visible to thread "thread-3": … it is simply outside your lineage.`

## Gap

The advice is the part of the receipt a caller acts on, and acting on it produced a refusal the
receipt had just said was unnecessary. Worse, the refusal is worded as a lineage fact, so the
caller reasonably concludes the note lied rather than that the runtime is self-inconsistent. And
the note is emitted whenever ANY thread of that agent is running anywhere in the session, so a
scoped caller is routinely pointed at work it is not allowed to see — the one case where the
right answer is silence.

## Why it is the way it is

Two features landed close together and only one was re-checked against the other. The note was
added for the ambiguity, with a session-wide scan, because the ambiguity IS session-wide: the
caller cannot know which of its sibling delegations is the "live one" from its own transcript
(`src/harness.ts:5658-5662`, "the newest one wins, preferring a thread the sender itself owns
(a sibling's running turn is the weaker hint, but still worth naming)"). The family scoping then
arrived with 0027's fix and changed what an id MEANS without changing what the note promises.
Nothing in the note's construction consulted the reachability rule, and the `note` contract in
the published type said only that it "appears only for a default-conversation target that has a
running thread of the same agent" (`src/types/index.ts:3004-3022`) — a statement about the
agent, not about the caller.

## Evidence

| Fact | Source |
|---|---|
| The note names a conversation found by a session-wide scan, newest wins | `src/harness.ts:5658-5662`, `:5680-5701` (`candidates` over `threadStates`, then `ownedBySender ?? reduce(… sequence …)`) |
| Only the caller-owned candidate was ever addressable | `:5691-5696` — the preferred candidate is `ownerThreadId === sender.threadId`, i.e. a descendant, and descendants are family members by rule |
| A sibling is outside the family, and the doors refuse it | `threadFamilyOf` (`src/harness.ts:5985-6061`); the refusal sentence pinned at `src/harness.thread-runtime.test.ts:3479-3485` |
| The published contract says nothing about the CALLER being able to address it | `src/types/index.ts:3004-3022` (`note?: string`) |
| Both the note and the scoping shipped in the same 2026-11-13 pass, so the mismatch was introduced, not inherited | `src/harness.ts:5642-5646` (C1 comment) against `docs/issues/minor-one-shot-child-threads-stay-on-the-roster.md` **Update (2026-11-13, fix)** |
| Runtime, 2026-11-14 stress pass: the note named a sibling and the follow-up send was refused | stress pass item #2; the shape is pinned as a test (`src/harness.thread-runtime.test.ts:3051-3110`), not stored as an artifact in this repo |

## Proposal

Filter the candidates through the SAME set the doors use, and change nothing else. Compute the
caller's family once, keep only candidates inside it, prefer the caller's own running child as
before, and emit the note only when something ADDRESSABLE is genuinely in flight. A threadless
caller keeps every candidate, because it is the unscoped host view and may address anything. The
wording of the sentence stays byte for byte — the sentence was never the problem, the id was.

**Alternatives considered.**

- *Drop the note.* Rejected: the ambiguity is real, and the caller-owned case is exactly the
  advice that helps (a parent with two running children, addressing the wrong one).
- *Keep the session-wide scan and append "…though that thread is outside your lineage".*
  Rejected: advice with its own refusal attached is noise, and it discloses another family's
  activity to a caller the family rule exists to keep it from.
- *Widen the family to include running siblings of the target agent.* Rejected: that is 0027's
  leak reintroduced through the side door of an advisory field.

## Acceptance criteria

1. Every id a `note` names is one the receiving caller can address: the follow-up `threadSend`
   or `threadRead` to it succeeds instead of refusing.
2. A scoped caller with no in-family running conversation of that agent gets NO note — the
   receipt is the plain `threadId` + `delivered` shape.
3. The sentence itself is byte-identical to the historical wording.
4. The note never reroutes anything: `threadId` and `delivered` describe where the message
   actually went, unchanged.
5. A threadless caller (host `runtime.threadSend`, a plugin outside any conversation) keeps the
   historical candidate set, including a sibling.

## Tests to add

- `src/harness.thread-runtime.test.ts` — a send into a default conversation while a borrowed
  (out-of-family) thread of that agent runs: the receipt carries no note, while an in-flight
  conversation the caller CAN address still produces one
  (`:3051` "a send addressed at a default conversation names the thread already in flight
  (B4/C1)", with the rule noted at `:3066`).
- `src/harness.thread-runtime.test.ts` — the note withheld when the live conversation is out of
  reach (`:3495`).

## Out of scope

- Whether a send into a default conversation should ever be RE-DIRECTED (it is not, and 0031
  does not change that).
- Widening the family rule (0027's design stands).
- The woken conversation's own reply route (0030).
- Notes on other receipts (`threadDelete`'s refusal sentences, `threadList`'s scoping note).

## Update (2026-11-14, fix) — closed

- **Shipped as proposed — the same family filter, no wording change.**
  `liveSiblingNoteFor` computes the caller's family once (`familyOfCaller(sender.threadId)`,
  `src/harness.ts:5666-5678`), filters the candidate scan through it
  (`:5680-5688`, with the threadless-caller exemption at `:5685-5687`), returns `undefined`
  when nothing addressable is running (`:5689`), and keeps the historical two-sentence wording
  verbatim (`:5703-5706`). The contract now states the rule it implements: "the thread it names
  must be one the CALLER can address … no addressable conversation in flight means no `note` at
  all" (`src/types/index.ts:3016-3021`).
- **Acceptance criteria, all met.**
  1. Addressable-or-silent — the filter is the same set `threadFamilyOf` returns, so a named id
     cannot be refused by the doors; pinned by the two tests below.
  2. Withheld when out of reach — `src/harness.thread-runtime.test.ts:3495`.
  3. Wording byte-for-byte — `src/harness.ts:5703-5706`; the pin asserts the sentence shape, and
     the fix note says so in the source (`:5676-5677`, "The wording itself is unchanged byte for
     byte").
  4. No rerouting — `receipt(delivered, note)` is unchanged in shape and precedence
     (`src/harness.ts:5647-5656`).
  5. Threadless caller keeps every candidate — `:5685-5687`. **Not pinned for the note:** the
     threadless host view is pinned for reachability alone
     (`src/harness.thread-runtime.test.ts:3102` "the threadless host door keeps sending across
     the whole session (B4)"), and no test exercises a note through a threadless send. If the
     exemption ever regresses, the receipt loses a useful hint silently; the owner may want that
     one extra assertion before closing.
- Status is **Fixed**. The log's rule for a closed issue is to delete the file and drop the
  index row; the file is kept, with the row marked, so the fix can be reviewed against its
  issue in the same pass — the owner's integrated run decides.

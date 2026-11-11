# 0028 — The primary agent's instructions promise delegation continuity that the runtime deliberately does not provide

> **Status:** Open
> **Severity:** Minor
> **Area:** agent prompt text vs `src/harness.ts` (delegation threads), `src/tools/runtime/delegate.tool.ts` (description)
> **Date opened:** 2026-11-11

## Context

The primary agent's operating instructions state that "a later delegation continues that
subagent's conversation". Tested: every delegation started a fresh conversation, and the
child saw nothing but its system prompt, the brief, and its own answer — verified by
reading a child transcript end to end, which contained exactly three messages. So a
caller that follows the instruction and sends a follow-up as "now do part two" hands the
child a brief that references work it has never seen. The child cannot resolve the
reference, and nothing in the envelope tells the parent that continuity was not applied.

## Gap

A caller needs the delegation model stated the same way in both places it is written down.
Today one surface says delegations to one subagent share a conversation and the other
surface — the tool description — says the opposite in effect ("The subagent does not see
this conversation, so include everything it needs"), and the runtime implements the second.
The instruction is the more authoritative-sounding of the two, because it is the agent's
own role text, so the wrong model wins.

## Why it is the way it is

Fresh-thread-per-delegation is the deliberate design, and it is documented in the source
header: a delegation child of a host thread becomes its own host conversation with its own
id and transcript and `ownerThreadId` set to the caller, "so concurrent siblings never mix
and every child is addressable/stopped/deleted through the same host API"
(`src/harness.ts:141-152`). Isolation is also what makes the 3-sibling concurrency test
meaningful, and the child's system prompt reinforces it ("You work alone"). The same header
separately notes that an agent's **default** conversation (`agent:<name>`) is the registry
Agent's history "which is what keeps delegation's historical accumulation" — so there are
two conversations in play, and the continuity claim reads as true of the default one while
the tool never runs there. The tool description itself never promises continuity
(`src/tools/runtime/delegate.tool.ts:164`). The defect is therefore in the instruction
text that sits beside the tool, not in the tool.

## Evidence

| Fact | Source |
|---|---|
| The instruction claims continuity | the primary agent's operating instructions: "a later delegation continues that subagent's conversation" |
| The tool description states isolation | `src/tools/runtime/delegate.tool.ts:164` ("The subagent does not see this conversation, so include everything it needs") |
| Fresh conversation per delegation is intentional | `src/harness.ts:141-152` |
| The child's own prompt reinforces isolation | child system message, read live: "You work alone: no subagent exists here …" |
| Runtime, 2026-11-11: no continuity | `threadRead { thread: "thread-4" }` → `total: 3` (system, the brief, the answer); two further delegations to the same `general` agent minted `thread-10` and `thread-11`, distinct transcripts, distinct `invocationId`s 23 and 24 |
| The default conversation is a different thing | `src/harness.ts:141-146` (`agent:<name>` is the registry Agent's history) |

## Proposal

Say the true model in both places, and make it actionable. In the tool description, state
that each delegation starts a new conversation with that subagent and that the brief must
therefore be self-contained — the sentence about not seeing *this* conversation already
exists, so the fix is to add the symmetric half about not seeing the subagent's previous
ones. In the agent instruction text, replace the continuity claim with either that
statement, or with the handle that would make continuity real: the child's `threadId`,
which the caller can then continue through `threadSend`. If the owner wants genuine
continuation, the smallest honest version is an explicit opt-in argument that runs the
delegation in the subagent's default conversation, accepting that concurrent siblings then
serialize behind one actor queue.

**Alternatives considered.**

- *Make delegation reuse the subagent's default conversation by default.* Rejected: it
  contradicts `src/harness.ts:141-152`, and it would make concurrent siblings share a
  transcript — the mixing that test suite guards.
- *Fix only the instruction text.* Acceptable as the minimum, but it leaves the tool
  description silent on the one property that decides whether a brief is self-contained.
- *Add a `continue: invocationId` argument.* Rejected as the default fix: it is a new
  surface for a property the design says callers should not need, and it duplicates
  `threadSend`, which already posts into a live child conversation.

## Acceptance criteria

1. The `delegate` description states that each delegation starts a new conversation with
   the subagent, and that the brief must carry everything the child needs.
2. The primary agent's instruction text no longer claims that a later delegation continues
   the previous conversation, or it names the handle (`threadId`) that makes continuation
   possible.
3. A test pins the observed behaviour so the two texts cannot drift back: two delegations
   to one subagent produce two transcripts, neither containing the other's brief.

## Tests to add

- `src/harness.delegation.test.ts` — two sequential delegations to the same subagent:
  assert two distinct thread ids and that the second child's message list does not contain
  the first brief.
- `src/core/metadata.ownership.test.ts` — a pin that the shipped description carries the
  new conversation-per-delegation sentence, so the prose cannot be edited away.

## Out of scope

- Adding a continuation argument, unless the owner decides to build it (then it belongs in
  its own issue).
- Changing the per-agent default conversations.
- `threadSend` semantics, which already address a live child correctly.

## Update (2026-11-11) — independent review

- **Verdict: re-classified — not a runtime defect at all.** The runtime behaves exactly as
  designed and documented: a host thread's delegation child gets a fresh Agent and its own
  conversation so "siblings never share a transcript, even when they target the same agent"
  (`src/harness.ts:10291-10300`, implemented at `:10305-10318`). The shipped `delegate`
  description never promises continuity
  (`src/tools/runtime/delegate.tool.ts:164`). The claim under test came from the primary's
  operating instructions, so the fix is prompt text plus a description sentence. Severity
  unchanged: **Minor**.
- **Important nuance the original pass did not have:** continuity **does** hold on the other
  path. When the parent is not a host thread, the child runs in the agent's default conversation
  (`defaultThreadOf`, `src/harness.ts:4828-4831`, used at `:10318`), and there a later
  delegation really does see the earlier one. So the instruction is true of one path and false
  of the path a server session actually takes — a better framing than "the prompt contradicts
  the runtime", and it should replace that framing in **Gap**.
- **Test gap confirmed:** continuity, in either direction, is untested.

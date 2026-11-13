# 0028 — The primary agent's instructions promise delegation continuity that the runtime deliberately does not provide

> **Status:** Fixed — 2026-11-14. **AC1, AC2 and AC3 are all met.** The texts in all three
> authored sites plus the guideline, and the guideline is byte-pinned; AC3's behavioural pin
> shipped the same day in BOTH directions — `describe('delegation conversation continuity, both
> directions (issue 0028 AC3)')` in `src/harness.delegation.test.ts` — which supersedes the
> third pass's "AC3 is owed" and "no host exception in the texts" findings; the fourth pass
> re-measured the Rust-port comparison (see its update). **Reduction, 2026-11-14:** the
> `src/harness.delegation.test.ts` entry under **Tests to add** closed and is deleted outright;
> only the `src/core/metadata.ownership.test.ts` wording pin remains live. File kept for review
> — delete it and this row once the owner's integrated run confirms.
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
(`src/harness.ts:104-131` — the host-thread sentence is `:115-118`). Isolation is also what makes the 3-sibling concurrency test
meaningful, and the child's system prompt reinforces it ("You work alone"). The same header
separately notes that an agent's **default** conversation (`agent:<name>`) is the registry
Agent's history "which is what keeps delegation's historical accumulation" — so there are
two conversations in play, and the continuity claim reads as true of the default one while
the tool never runs there. The tool description itself never promises continuity
(`src/tools/runtime/delegate.tool.ts`, the `metadata` description — the sentence that stood at
`:164` on 2026-11-11 has since been widened twice, and its current wording is quoted in the
2026-11-14 updates). The defect is therefore in the instruction
text that sits beside the tool, not in the tool.

## Evidence

| Fact | Source |
|---|---|
| The instruction claims continuity | the primary agent's operating instructions: "a later delegation continues that subagent's conversation" |
| The tool description states isolation | `src/tools/runtime/delegate.tool.ts`'s `metadata` description — on 2026-11-11 the sentence "The subagent does not see this conversation, so include everything it needs" stood at `:164`; that address is now the `maxTurns` parameter, and the sentence has grown into the wording quoted in the 2026-11-14 updates |
| Fresh conversation per delegation is intentional | `src/harness.ts:104-131` (the design header), enforced at runtime by the `resolvedThread` branch at `:12350-12368` (re-derived 2026-11-14) |
| The child's own prompt reinforces isolation | child system message, read live: "You work alone: no subagent exists here …" |
| Runtime, 2026-11-11: no continuity | `threadRead { thread: "thread-4" }` → `total: 3` (system, the brief, the answer); two further delegations to the same `general` agent minted `thread-10` and `thread-11`, distinct transcripts, distinct `invocationId`s 23 and 24 |
| The default conversation is a different thing | `src/harness.ts:110-112` (`agent:<name>` is the registry Agent's history) |

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
  contradicts `src/harness.ts:104-131` (the design header as it stands on 2026-11-14), and it would make concurrent siblings share a
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

- `src/core/metadata.ownership.test.ts` — a pin that the shipped description carries the
  new conversation-per-delegation sentence, so the prose cannot be edited away.
  <!-- Reduced 2026-11-14 (fourth pass): the `src/harness.delegation.test.ts` bullet — two
       sequential delegations to one subagent, two thread ids, the second child not shown the
       first brief — SHIPPED and is deleted per the log's closed-part rule. It became
       `describe('delegation conversation continuity, both directions (issue 0028 AC3)')`,
       which also pins the host case the bullet did not cover. The bullet above is unchanged
       and still owed: the only wording assertion in that file is still
       `expect.stringContaining('Subagents: alpha, beta.')`. -->

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

## Update (2026-11-14) — the texts shipped in every authored site; AC3 did not

Read from the current sources and tests; **no test was executed by this doc pass**, and the
byte-comparisons against the Rust port were made by reading both files, not by running `cargo test`.
The line citations above predate the change.

- **AC1 met, in all three authored descriptions.** The catalogue literal
  (`src/tools/runtime/delegate.tool.ts:124`) says: "EACH delegation starts a NEW conversation with
  that subagent: the child sees neither this conversation nor an earlier child's, so the brief must
  carry everything it needs." The runtime declaration (`:238`) and the metadata projection
  (`src/core/metadata.ts:249`) say: "The subagent does not see this conversation, and each delegation
  starts a NEW conversation with it, so it remembers no earlier one either: the brief must carry
  everything it needs." That is the symmetric half this entry asked for, and it is now in the text the
  model reads at both the discovery surface and the call surface.
- **AC2 met — the instruction names the handle, not the promise.**
  `src/agents/guidelines.ts:101-102` reads "…continue a child you already used with threadSend on the
  threadId it returned rather than assuming it remembers the last brief." The rationale is in the
  comment above it (`:95-100`): the continuation door is `threadSend` into the reported `threadId`, and
  the line reads correctly for a primary, a subagent and a lone agent alike (with `subagents: []` the
  tool is not even registered). The default card swaps in its own replacement line — pinned as
  `LONE_LINE` in `src/server/harnesses/presets.test.ts:249-255`, sourced from `src/agents/general.ts` —
  which closes both loopholes (`threadFork`, `threadSend`) in the same breath.
- **How the wording is guarded.** `src/server/harnesses/presets.test.ts:240-247` pins the delegation
  line **as a literal** ("a rewording in the source is a visible diff here instead of a silent pass");
  `src/agents/agents.test.ts:170` records the size of this very change (+55 characters, dated
  2026-11-14) and `:192` lists the guideline, while `:349-350` pins that the default card does **not**
  carry the team line.
- **AC3 unmet, and the gap is narrower than it sounds.** No test anywhere delegates twice to one
  subagent and compares the two transcripts — `src/harness.delegation.test.ts` has no such case, and
  neither has the suggested pin of the description sentence. What exists instead is *structural*
  equality: `src/core/metadata.ownership.test.ts:376-378` pins the metadata projection against the
  runtime declaration (so the two long templates cannot drift **apart from each other**), and
  `:383-386` pins only `expect.stringContaining('Subagents: alpha, beta.')` on the allowlist form. So
  the three texts are locked to one another, and any of them can still have its conversation-per-
  delegation sentence deleted with the suite green — which is precisely the drift AC3 was written
  against. The behaviour itself remains pinned by 0029's attribution work and by
  `src/harness.delegation.test.ts:1038` (a host delegation answering in `agent:researcher`, the
  default conversation), but no test asserts "two briefs, two conversations".
- **Rust port: this guideline matches, two neighbours still do not** (the crate is a separate package;
  recorded here because it is the same sentence the entry fixed, and 0035 is its docs issue).
  `packages/typecrate/harness/src/agents/profiles.rs:61` is **byte-identical** to
  `src/agents/guidelines.ts:102`, and its doc comment at `:60` cites `agents/guidelines.ts:101-102`,
  which resolves. `PERMISSIONS_GUIDELINE` (`profiles.rs:65` vs TS `:105-106`) and
  `WEB_SEARCH_GUIDELINE` (`profiles.rs:57` vs TS `:75-76`) match too. Two have drifted:
  `DISCOVERY_GUIDELINE` — TS `:61-62` says "when toolRequest is in it, call it", the crate's `:53`
  says "call toolRequest" unconditionally, which is the exact failure the TS comment at `:55-59`
  forbids (a host can switch `toolRequest` off via `withheldTools`, and then the line sends the model
  hunting for a tool it was never given); and `TOOL_CREATE_GUIDELINE` — TS `:133-134` says "while
  toolRequest is declared, enable it there", the crate's `:69` says "enable it with toolRequest". Both
  are crate-side edits that owe a `cargo` run, so they are reported rather than changed here.

## Update (2026-11-14, third pass) — addresses re-derived; the crate comparison re-measured and corrected

Read from source and tests; **no test was executed by this doc pass**, and the byte-comparisons against
the Rust port were made by a parser probe (`Temp/t21-docs/guide-check.ts`), not by `cargo test`.
Addresses are from the working tree at 07:45-08:05 on 2026-11-14 (HEAD `cef43af`, dirty worktree) and
the crate comparison is a 08:20 snapshot of that same dirty tree, which a second agent is editing
while this runs. Re-grep the quoted identifiers, not the numbers.

- **Status unchanged: Fixed, with AC3's behavioural pin still owed.** Nothing the second pass recorded
  was disproved; what follows is re-anchoring plus one correction and one new imprecision.
- **The guideline, re-read.** `src/agents/guidelines.ts:101` declares `DELEGATION_GUIDELINE` and `:102`
  is the string, unchanged in substance from the second pass: "…and continue a child you already used
  with threadSend on the threadId it returned rather than assuming it remembers the last brief." The
  rationale is the numbered item at `:90-98` — "**3.** a FOLLOW-UP goes through the handle, not
  through a second delegation (0028, corrected 2026-11-14)" — which names the runtime rule
  ("EVERY delegation from a thread mints its own child conversation", `:93-94`) and the exception
  ("Only a delegation from the HOST reuses the subagent's default conversation", `:95-96`). The
  "reads correctly for all three callers" note is now `:99-100` in the comment block above the constant.
- **One stale in-source citation, reported not edited.** That same line says the lone card's row "is not
  even registered, `src/harness.ts:1101-1103`". `src/harness.ts:1101-1103` today is the `roleOf`
  helper (def `:1103`), not the registration gate. The live gate is elsewhere: the primary-only marker
  `primaryOnlyDefinitions` (`:1312`, enforced `:2074`, populated `:3359`) plus the entry text's own
  promise that "a harness registers this tool only when it has subagents"
  (`src/tools/runtime/delegate.tool.ts:124`). The claim is true; the pointer is not. `src/agents/` is
  owned by the code pass, so this is reported.
- **The guards, at current addresses.** The byte-pin is `src/server/harnesses/presets.test.ts:245-246`
  (`const DELEGATION_LINE = '<the whole line>'`) with its reason at `:240-244` ("a rewording in the
  source is a visible diff here instead of a silent pass"); the assertions are in
  `it('composes one shared delegation line for the team roles, and none on the default card')` at
  `:1020` — the per-role loop `:1026-1030` (the `toContain(DELEGATION_LINE)` itself at `:1029`), the
  default card `:1035-1039`, and the reverse direction at `:1042`. The second pass cited
  `presets.test.ts:240-247`/`:250-252` for the same pair; the literals are at `:245-246` and `:252-253`
  today. The budget guard is `src/agents/agents.test.ts:165-187` (`PROMPT_LENGTHS`, every role exact),
  with this change's own size recorded at `:170-175` ("+55 each (0028, 2026-11-14)") and the
  1,783/1,800 ceiling note at `:181-184`; `SHARED_LABELS` keys the label by the **real constant**
  (`:191-198`, `DELEGATION_GUIDELINE` at `:192`), and the non-composition pins are `:349-350`
  (default card) and `:370` (instruct composes it).
- **The three description sites, re-confirmed with the sentences in place.** `delegate.tool.ts:124`
  (the catalogue literal) still says "EACH delegation starts a NEW conversation with that subagent: the
  child sees neither this conversation nor an earlier child's, so the brief must carry everything it
  needs."; `delegate.tool.ts:238` and `src/core/metadata.ts:249` still say "The subagent does not see
  this conversation, and each delegation starts a NEW conversation with it, so it remembers no earlier
  one either". The generated mirror `src/core/tool-manifest.ts:1193` carries the first text
  character-for-character, and the drift check was run against the live sources on 2026-11-14 and
  reported the manifest current (32 descriptors).
- **A new imprecision this pass found, in the other direction.** AC2 asked for wording that reads
  correctly for a primary, a subagent and a lone agent. The guideline line does — it gives advice
  ("continue … with threadSend") rather than making a claim. But the `delegate` entry texts assert
  "EACH delegation starts a NEW conversation" with **no host exception**, while the source comment at
  `src/agents/guidelines.ts:95-96` states the opposite for a host parent, and
  `src/harness.delegation.test.ts:1038`
  pins a host delegation running in `agent:researcher` — that agent's **default** conversation, not a
  freshly minted one. `grep -c 'from the host'` is 0 in both `src/tools/runtime/delegate.tool.ts` and
  `src/core/metadata.ts`, while the exception IS stated on the other side of the same family, in the
  `threadDelete` description (`src/core/tool-manifest.ts:2185`: "a delegation that comes from the host
  rather than a conversation reuses that subagent's default conversation instead of minting one"). So
  the sentence the entry fixed has been replaced by one that over-claims for the host case; whether
  that matters is the owner's call, and no test pins a second host delegation's thread id either.
- **AC3 unchanged and still owed.** No test delegates twice to one subagent and compares what the two
  children saw. `grep` over every `it(` title in `src/*.test.ts` for "twice", "second delegation",
  "remembers", "new conversation" and "does not see" returns nothing on this behaviour; the nearest
  real pins are the single host-delegation thread id at `src/harness.delegation.test.ts:1030-1041`
  (the `agent:researcher` assertion at `:1038`) and the follow-up routing pins at
  `src/harness.thread-runtime.test.ts:2903` ("threadSend reaches an ancestor, a descendant, and the
  default of another agent (B4)") and `:2984`. The structural equality pins the second pass named are
  still structural-only: `src/core/metadata.ownership.test.ts:376-378` compares the projection with the
  entry, and the only wording assertion in that test is
  `expect.stringContaining('Subagents: alpha, beta.')` at `:385`. A description that lost its
  conversation-per-delegation sentence would still pass.
- **Correction to the Rust-port bullet: the delegation line now MATCHES.** Measured by the probe at
  08:20 on 2026-11-14 (not by eye): `DELEGATION_GUIDELINE` is 316 characters on both sides —
  `src/agents/guidelines.ts:102` and `packages/typecrate/harness/src/agents/profiles.rs:61` — and the
  strings are equal. The second pass recorded a 58-character difference from this same sentence
  (TS 355 vs crate 298), so **both sides moved** and converged on the handle-wording; the crate's
  doc comment at `:60` cites `agents/guidelines.ts:101-102`, which resolves. `PERMISSIONS_GUIDELINE`
  matches too (114 characters, TS `:106` vs crate `:65`), and `WEB_SEARCH_GUIDELINE` differs only
  because the crate's literal escapes its quotes (`\"web\"`), which is Rust syntax, not different prose.
  What still drifts is exactly what the second pass found: `DISCOVERY_GUIDELINE` (TS `:62`, 200
  characters, "when toolRequest is in it, call it" vs crate `:53`, 182, "call toolRequest"
  unconditionally) and `TOOL_CREATE_GUIDELINE` (TS `:134`, 153, "while toolRequest is declared, enable
  it there" vs crate `:69`, 133, "enable it with toolRequest"). New this pass: `READ_ONLY_GUIDELINE`
  (TS `:123`) has **no crate counterpart at all** — the crate inlines per-role read-only prose (e.g.
  `profiles.rs:157`), so there is nothing there to compare. All three gaps are crate-side, all owe a
  `cargo` run, and the crate is a separate dirty tree (`git status` lists 17 modified files under
  `harness/src`), so they are reported for its owner rather than touched here — 0035 is that package's
  docs issue.

## Update (2026-11-14, fourth pass) — AC3 shipped in BOTH directions; the host exception is in the texts; the crate comparison re-measured

Read from the working tree at HEAD `cef43af` (dirty), and every number below comes from a parser probe
(`Temp/t25-docs/guide-check.ts`, run with `yarn vite-node`) or a direct read — **no test was executed by
this pass**, because a gate agent holds the suite. The test block named below was READ, not run.

- **Both trees moved while this pass ran, and every number above is the LATER state.** The harness HEAD
  went from `37c940f` to `cef43af` during the pass, and that commit MOVED this issue's own subject: the
  guideline strings now live in `src/agents/guidelines.ts` (137 lines, one line per guideline) where the
  first, second and third passes all cited `src/tools/runtime/guidelines.ts` (447 lines, with the
  multi-line bullet blocks). On the crate side, `src/agents/profiles.rs` went from a 242-line working
  tree whose `DISCOVERY_GUIDELINE` and `TOOL_CREATE_GUIDELINE` were multi-line raw-string blocks back to
  the committed 222-line one-constant-per-line form, and `src/tools/mod.rs`, `src/tools/catalogue.rs`,
  `src/ports.rs`, `tests/tools.rs` and `tests/http_host.rs` were re-edited too — the modified-path set
  is still those 8 paths, but every diff in it changed size. So the earlier passes' line numbers into
  `guidelines.ts` and into `profiles.rs` are all superseded by the table above, and the recipe stands
  with it: re-derive by grepping the symbol (`export const DISCOVERY_GUIDELINE`, `availability_of`,
  `record.origin === 'host'`), never by trusting the number — nothing in either package pins a citation.
- **What this pass changed in the crate's own docs** (the owner's two writable crate files): the
  `DISCOVERY_GUIDELINE` / `TOOL_CREATE_GUIDELINE` / `READ_ONLY_GUIDELINE` cross-reference drift is now
  recorded in 0035's fourth pass, and the crate README / `knowledge.md` were re-audited and re-anchored
  (counts, the tool-catalogue rows, and 15 drifted line citations listed there with their re-derived
  positions).

- **AC3 is MET, and the fix is behavioural, not textual.** `src/harness.delegation.test.ts` now carries
  `describe('delegation conversation continuity, both directions (issue 0028 AC3)')`, with two cases:
  - `it('re-enters the same child conversation when a host-driven session delegates twice')` — a
    host-driven primary delegates to `researcher` twice and asserts BOTH envelopes with `toEqual`, each
    carrying `threadId: 'agent:researcher'` with `invocationId` `'2'` then `'3'`; `writer.threads()` as
    exactly `[['agent:writer', 'agent'], ['agent:researcher', 'agent']]` (NO child thread was minted);
    the standing conversation's transcript as five exact messages; and — the pin — the SECOND child
    request's message list carrying `brief one`, `facts one` and only then `brief two`.
  - `it('mints two independent child conversations for a threaded parent, neither of which remembers the other')` —
    one `createThread('writer')` parent, two sends, children addressed as **distinct** `threadId`s
    `'thread-2'` and `'thread-3'` (`invocationId` `'2'` and `'4'`); the roster asserts each minted thread's
    `origin: 'host'` and `ownerThreadId: 'thread-1'`; each child transcript holds exactly its OWN exchange;
    each child REQUEST carries only its own brief; and `agent:researcher` is still at its seeded system
    prompt alone. That is precisely the pair AC3 asked for ("two transcripts, neither containing the
    other's brief"), pinned end to end with `toEqual` on whole lists.
- **The runtime branch that makes both directions true**, quoted from `src/harness.ts` — the
  `resolvedThread` IIFE at `:12350-12368`: after `if (branchRun !== undefined) return undefined;` and
  `if (threadState !== undefined) return threadState;`, it reads
  `if (parent !== undefined && parent.threadState?.record.origin === 'host')`, mints with
  `createThreadState(brain.name, parent.threadId === undefined ? undefined : { ownerThreadId: parent.threadId }, true)`,
  first falling back for a non-registry brain (`if (agents[brain.name] !== brain) return defaultThreadOf(brain);`),
  and every NON-host parent falls through to `return defaultThreadOf(brain);`. `defaultThreadOf` itself is
  declared at `:5528`. The test block's own header comment cites `:12350-12368`, and that range still
  resolves to this code — re-derive by grepping `record.origin === 'host'` and `defaultThreadOf`, not the number.
- **The texts now carry the host exception at all three authored sites** — which **supersedes** this
  file's third-pass bullet "A new imprecision… with **no host exception**" and its
  "`grep -c 'from the host'` is 0 in both `src/tools/runtime/delegate.tool.ts` and `src/core/metadata.ts`".
  Measured today: **2** in `src/tools/runtime/delegate.tool.ts` and **1** in `src/core/metadata.ts`
  (plus **2** in the generated `src/core/tool-manifest.ts`). The current authored sentences:
  - the catalogue literal, `src/tools/runtime/delegate.tool.ts` `metadata.description`: "EACH delegation
    starts a NEW conversation with that subagent: the child sees neither this conversation nor an earlier
    child's - **unless the call comes from the host rather than one of your conversations, and then the
    child re-enters that subagent's default conversation (`agent:<name>`), where it may remember what it
    answered for you before** - so the brief must carry everything it needs."
  - the runtime declaration, `src/tools/runtime/delegate.tool.ts` `agentDelegateMetadata(...)`, and the
    hand-duplicated projection in `src/core/metadata.ts` (`agentDelegateMetadata`, the allowlist form):
    "The subagent does not see this conversation, and each delegation starts a NEW conversation with it,
    so it remembers no earlier one either - **unless the call comes from the host rather than one of your
    conversations, and then the child re-enters that subagent's default conversation (agent:<name>), where
    it may remember what it answered for you before**: the brief must carry everything it needs."
  - the generated mirror `src/core/tool-manifest.ts:1193` carries the catalogue wording
    character-for-character, and `threadDelete`'s door still states the same rule from the other side
    (`src/tools/runtime/delegate.tool.ts`-family: `src/tools/runtime/threadDelete.tool.ts`; its manifest
    row is at `src/core/tool-manifest.ts:2185`, re-checked case-insensitively — the earlier citation
    `grep` needed `-i` because the sentence is now capitalised "A delegation FROM A CONVERSATION…").
  - The **area** line and the "Why it is the way it is" / **Evidence** pointers were re-anchored in the
    body of this file (the header comment is `src/harness.ts:104-131`, the host-thread sentence at
    `:115-118`, the default-conversation sentence at `:110-112`; `delegate.tool.ts:164` is the `maxTurns`
    parameter today).
- **AC3's other half — the description-wording pin — is still owed**, so **Tests to add** keeps exactly
  one live bullet. `src/core/metadata.ownership.test.ts` pins the projection against the entry
  (`coreMetadata.agentDelegateMetadata(['alpha','beta'])` vs `agentDelegateEntry.agentDelegateMetadata(…)`)
  and its only wording assertion is still `expect.stringContaining('Subagents: alpha, beta.')`. A description
  that lost its conversation-per-delegation clause would still pass.
- **Guards re-confirmed at current addresses**: the byte-pin literal is `DELEGATION_LINE` at
  `src/server/harnesses/presets.test.ts:245`, asserted inside
  `it('composes one shared delegation line for the team roles, and none on the default card')` at `:1020`
  (per-role `toContain` at `:1029`, the lone card's `not.toContain(DELEGATION_LINE)` at `:1039`, the
  reverse direction at `:1042`); the budget guard is `PROMPT_LENGTHS` at `src/agents/agents.test.ts:165`
  with this change's own note "+55 each (0028, 2026-11-14)" at `:170`, and `SHARED_LABELS` at `:191` keys
  `DELEGATION_GUIDELINE` at `:192`. In `src/agents/guidelines.ts` the rationale is the numbered item at
  `:92-98` (the host exception sentence at `:96`) and the line itself is `DELEGATION_GUIDELINE` at
  `:104-105`. The stale in-source pointer this file reported — `src/harness.ts:1101-1103` for the lone-card
  registration gate — **is still wrong**: `:1103` is the `roleOf` helper.
- **The Rust-port comparison, re-measured from scratch** (probe, with Rust's `\"` unescaped so the
  comparison is on prose, not Rust syntax). `packages/typecrate/harness/src/agents/profiles.rs`:

  | Constant | TS (`src/agents/guidelines.ts`) | crate (`profiles.rs`) | Verdict |
  |---|---|---|---|
  | `DELEGATION_GUIDELINE` | `:104`, 316 chars | `:61`, 316 chars | **MATCH** (the second pass's 58-char gap is gone — the third pass already corrected this, confirmed) |
  | `PERMISSIONS_GUIDELINE` | `:108`, 114 | `:65`, 114 | **MATCH** |
  | `WEB_SEARCH_GUIDELINE` | `:75`, 210 | `:57`, 210 | **MATCH** — stated flatly, because after unescaping there is no difference at all (the third pass's "differs only in quote escaping" is an artifact of comparing the raw literals) |
  | `DISCOVERY_GUIDELINE` | `:61`, 200 | `:53`, 182 | **DIFF** — first divergence at character 52; TS "when toolRequest is in it, call it", crate "call toolRequest" unconditionally. This is the harmful one: the TS comment at `:55-59` forbids the unconditional form for a host that withholds `toolRequest` |
  | `TOOL_CREATE_GUIDELINE` | `:136`, 153 | `:69`, 133 | **DIFF** — first divergence at character 40; TS "while toolRequest is declared, enable it there", crate "enable it with toolRequest" |
  | `READ_ONLY_GUIDELINE` | `:126`, 207 | — | **NO CRATE COUNTERPART**; the crate inlines per-role prose instead (the reviewer's line is `profiles.rs:157`; `:158` is that role's `DELEGATION_GUIDELINE` entry) |
- **New finding this pass, in the crate's own comments:** the doc comment above each crate guideline now
  points at the WRONG TS line for three of the five. `profiles.rs:60` cites `agents/guidelines.ts:101-102`
  (the declaration is at `:104-105`), `:64` cites `:105-106` (actual `:108-109`), `:68` cites `:133-134`
  (actual `:136-137`) — a **+3 drift** the TS comment block gained when the host-case rationale was added;
  `:52` (`DISCOVERY`, `61-62`) and `:56` (`WEB_SEARCH`, `75-76`) still resolve. Crate-side, and
  `packages/typecrate/harness/src/**` is outside this pass — recorded for its owner, and the same failure
  mode as 0035 (nothing pins a citation, in either package).
- **Corrected figure:** the third pass said the crate's `git status` "lists 17 modified files under
  `harness/src`". Measured today in that repo: **8 modified paths in total, 4 of them under `src/`**
  (`agents/profiles.rs`, `ports.rs`, `tools/catalogue.rs`, `tools/mod.rs`) plus `README.md`,
  `knowledge.md`, `tests/http_host.rs` and `tests/tools.rs`. Its HEAD is `d507659`, dated 2026-11-13.

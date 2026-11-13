# 0029 — A successful `delegate` can report an empty `invocationId` and an asserted `completed`, and two documented fields are conditional

> **Status:** Fixed — 2026-11-14 (see the dated **Update** sections at the bottom: the fix, then
> the 2026-11-14 independent-review correction of how exact the identity chain is)
> **Severity:** Minor
> **Area:** `src/harness.ts` (delegation success path), `src/tools/runtime/delegate.tool.ts` (description)
> **Date opened:** 2026-11-11
> **Found by:** the independent review pass that re-checked 0019-0028, not by the original black-box run. **Unobserved in the live session** — this is a source-level finding, and no test covered it.

## Context

The `delegate` description presents `invocationId`, `threadId`, `status` and `nextOffset`
as facts about the run, and tells the caller to use the first of them to page the rest of
the answer. On the success path all four are best-effort. If the child's invocation record
is not there to read, the envelope still answers: `invocationId` becomes the empty string
and `status` becomes `'completed'`, asserted with no evidence. The record is not hard to
lose — terminal invocation records are pruned at 64, oldest first — and the description
gives the caller no way to tell a real identity from a placeholder one. Separately,
`threadId` and `nextOffset` are emitted only when present, while the description lists both
as part of the result unconditionally.

## Gap

A caller that stores the `invocationId` to page or cite a child's answer needs it to be
either genuine or visibly absent. Today an empty string is a valid-looking identity, and
`completed` is reported for a run whose record the runtime never saw — so the two fields a
caller is told to trust are the two that can be invented. A caller also cannot predict
whether `threadId` and `nextOffset` will be in the envelope at all.

## Why it is the way it is

The identity is read from the invocation record after the child's run resolves, matched by
the spawning call id or by "new since dispatch" (`src/harness.ts:4126-4145`), and the
success path tolerates its absence rather than failing: `invocationId: record?.invocationId
?? ''` and `status: record?.status ?? 'completed'` (`:4269-4271`). The tolerance is
deliberate in one direction — a child that never started registered no record, and the
comment at `:4116-4122` explains that an earlier "newest record" heuristic handed callers
another run's identity, so the code prefers to report nothing rather than a stale
identity. What was not carried through is that reporting nothing as `''` plus an asserted
`completed` is its own fabrication. Retention is the practical trigger:
`AGENT_RESULT_RETENTION = 64` (`src/core/agent-limits.ts:23`) and `pruneInvocationRecords`
(`src/harness.ts:3614`) evict oldest **terminal** records first, so a completed child can
age out. The conditional fields follow the same optional-chaining style as the cancelled
path (`:4266-4270`); the description simply describes the populated case
(`src/tools/runtime/delegate.tool.ts:164`).

## Evidence

| Fact | Source |
|---|---|
| The success path defaults identity and status | `src/harness.ts:4269` (`invocationId: record?.invocationId ?? ''`), `:4271` (`status: record?.status ?? 'completed'`) |
| The record may be absent, and that is intentional | `src/harness.ts:4116-4122` (matching by "new since dispatch" rather than "newest record", to avoid handing the caller a stale identity) |
| Terminal records are pruned, oldest first, at 64 | `src/core/agent-limits.ts:23` (`AGENT_RESULT_RETENTION = 64`), `src/harness.ts:3614-3624` (`pruneInvocationRecords`, "Evict oldest TERMINAL records only") |
| `threadId` and `nextOffset` are conditional in the envelope | `src/harness.ts:4266-4270` (`...(page.nextOffset === undefined ? {} : { nextOffset: … })`, `...(record?.threadId === undefined ? {} : { threadId: … })`) |
| The description lists all four unconditionally | `src/tools/runtime/delegate.tool.ts:164` ("The result carries agent, content, contentLength, offset, limit, truncated, nextOffset, invocationId, threadId, status, durationMs") |
| The existing test pins the populated case only | `src/harness.delegation.test.ts:494` ("returns the invocation identity agentManage/agentResult report") |
| Live, 2026-11-11: never observed | all 19 delegations in the black-box pass carried a real `invocationId` and a `threadId`; no test exercises the fallbacks |

## Proposal

Stop inventing the two fields. When the record is absent on the success path, omit
`invocationId` and `threadId` entirely rather than substituting `''`, and report `status`
as `'unknown'` (or omit it) instead of asserting `'completed'`, since the answer text
arrived but the run's own record did not. Keep the answer itself exactly as delivered —
`content`, `contentLength`, `offset`, `limit` and `truncated` all come from the returned
message and are unaffected. Then make the description honest about conditionality: name the
always-present fields and the three that appear only when known. If the owner prefers to
keep a non-empty identity, the alternative is to synthesise a clearly-marked one
(`invocationId: "unrecorded"`) so it cannot be mistaken for a value `agentResult` accepts.

**Alternatives considered.**

- *Raise `AGENT_RESULT_RETENTION`.* Rejected: it moves the window without removing the
  fabrication, and retention exists to bound a shared store.
- *Refuse the delegation when the record is missing.* Rejected: the answer is real and
  useful; failing the call would discard good work to protect a metadata field.
- *Leave the fallbacks and only fix the description.* Acceptable as the minimum, but it
  leaves an empty string that `agentResult` will reject, which is a trap rather than a
  signal.

## Acceptance criteria

1. No `delegate` envelope reports `invocationId: ""`.
2. A completed delegation whose invocation record is unavailable does not report
   `status: "completed"` as fact.
3. The description distinguishes the fields that are always present from `invocationId`,
   `threadId` and `nextOffset`, which are present only when known.
4. A caller that pages with the `invocationId` it was given never hands `agentResult` a
   value it will refuse.

## Tests to add

- `src/harness.delegation.test.ts` — a completed child whose record has been pruned
  (retention forced to 0 or the record deleted): assert the envelope still carries the
  answer, and that `invocationId` is absent rather than empty and `status` is not asserted.
- `src/harness.delegation.test.ts` — a child with no conversation: assert `threadId` is
  absent, and that a non-truncated answer carries no `nextOffset`.
- `src/core/metadata.ownership.test.ts` — a pin that the description's field list matches the
  fields the envelope actually emits, so the two cannot drift again.

## Out of scope

- Delivery of the envelope (0019) and the pending placeholder's identity (0024).
- The cancelled path's `partialContent` (0020) and `cancelledAtMessage` (0022).
- Changing `AGENT_RESULT_RETENTION`, or the retention policy itself.
- The `agentManage` preview caps (`AGENT_MANAGE_LIST_PER_AGENT`, `AGENT_MANAGE_PREVIEW_CHARS`).

## Update (2026-11-13) — the fabrication stopped, in two parts (B2)

- **Half of this issue closed before the fix pass began, and not by this file's owner.** The
  success path no longer substitutes: `invocationId`, `threadId` and `status` are each a
  CONDITIONAL spread (`src/harness.ts:4774-4776`), and `HarnessDelegationResult` declares all
  three OPTIONAL with the reason spelled out (`src/types/index.ts:1382-1396`, "The field used to
  be `''` in that case: an address that addressed nothing, next to a `status` of `'completed'`
  that no record supported"). `durationMs` keeps its honest fallback — the child's measurement
  when there is a record, otherwise the span this call actually spent
  (`src/harness.ts:4777-4780`).

## Update (2026-11-14, fix) — closed (D1)

- **Shipped — and the fix moved the harder problem: from "how to find the record" to "the child
  tells us where it is".** The identity is now a CARRIER handed down through `context.run`
  (`HarnessRunIdentity`, created empty at `src/harness.ts:4541-4547`) and written by the CHILD
  RUN ITSELF: `invocationId`/`threadId` right after `registerInvocation`, and the terminal
  `status` at the terminal commit (`commitTerminalIdentity`, `src/harness.ts:11601`, with the
  settle guard keeping identity by value at `:12053`). `newInvocationOf` then ADDRESSES the
  ledger entry by that id and only VERIFIES it — same id, same agent — instead of searching
  (`:4592-4604`). The comment states the change in one line: "this is now VERIFICATION, not
  discovery", because after an `await` the calling code holds no `RunState` and the ledger is a
  shared store a concurrent run of the same agent is writing into.
- **Both heuristics the finding relied on are demoted, not deleted.** The `(parentCallId,
  parentScope)` match and the "new since dispatch" match survive ONLY for a run that never
  reached `registerInvocation` (refused before it owned its actor, or a host `run` closure that
  ignores the options) — `:4587-4591`, `:4606-4620` — and the pair match is now compared
  EXACTLY (scope included), which removes the cross-reporting the proposal worried about: a
  completed child can no longer be reported under a concurrent host thread's identity. The same
  pair-addressed lookup is published to the delivery layer as `delegatedRecordOf`
  (`:4408-4424`) for the released-call door (0021).
- **Acceptance criteria, honestly.**
  1. *No `invocationId: ""`* — **met**: the only emission is `record.invocationId`, and the
     source pin asserts the fabrication cannot come back
     (`src/harness.agent-results.test.ts:1641`, "an empty string that READS like an address").
  2. *No asserted `completed`* — **met**: `status` comes from the record or is absent
     (`src/harness.ts:4776`, `src/types/index.ts:1394-1396`).
  3. *The description distinguishes always-present from conditional* — **met** (the
     model-facing and server-facing descriptions now read "…`nextOffset` and `durationMs`, and —
     when the run is identifiable — `invocationId`, `threadId` and `status`; a child whose ledger
     entry cannot be resolved … reports its answer with those three keys ABSENT rather than
     inventing an identity": `src/tools/runtime/delegate.tool.ts:213`, mirrored in
     `src/core/metadata.ts:249` and the generated `src/core/tool-manifest.ts:1193`).
  4. *`agentResult` never handed a value it will refuse* — **met by construction**: absence is
     the answer, and the released-call door falls back to the historical cancel sentence rather
     than an invented identity when `releasedDelegateResultOf` finds nothing
     (`:4345-4354`, `:8236-8239`).
- **Which proposal was taken: the first one, not the marked-identity alternative.** Nothing is
  omitted-and-replaced-with-a-sentinel; `invocationId: "unrecorded"` was not introduced, so a
  caller cannot mistake a marker for an address.
- **Tests, and the one place the pin is weaker than requested.** `src/harness.agent-results.test.ts:1614`
  ("invents no invocation identity when the delegate result has no ledger record to point at")
  pins the branch **against the source text** — the three conditional spreads, the absence of any
  `invocationId: ''` in code, and the `durationMs` fallback — because, as the test says, "the
  omitted identity has no reachable trigger inside one process today": the child's default
  conversation is one `deleteThread` refuses, and the requesting run holds its own thread until
  its pending async work settles, so only the 64-record ledger bound could evict the entry. The
  **Tests to add** item 1 here asked for a live pruned-record run; the fix pass did not add one,
  and the owner should decide whether that asymmetry is acceptable or wants the eviction path
  exercised (retention forced to 0) before closing. The identity-by-value behaviour IS tested
  live: `src/harness.delegation.test.ts:736` (describe), `:796` ("names the child THIS call
  started while a host thread of the same agent runs alongside") and `:883` ("keeps two parents
  that share a tool-call id pointed at different children").
- **Line-number drift, so the entry stays re-checkable.** Every `src/harness.ts` line cited in
  **Why it is the way it is** and **Evidence** (`:4126-4145`, `:4266-4271`, `:4116-4122`, `:3614`,
  `:4269`) predates the 2026-11-13/14 passes and no longer points at what it named. The live
  addresses are the symbols: `delegateFor` → `newInvocationOf`, `delegatedRecordOf`,
  `unfinishedDelegateEnvelopeOf`, `releasedDelegateResultOf`, `commitTerminalIdentity`,
  `pruneInvocationRecords`, and `finishInvocation`'s record shape (`src/harness.ts:3770-3791`).
- Status is **Fixed**. The log's rule for a closed issue is to delete the file and drop the index
  row; the file is kept, with the row marked, so the fix can be reviewed against its issue in the
  same pass — the owner's integrated run decides.


## Update (2026-11-14, independent review) — exactly two of the three identity steps are exact (C5)

- **The published summary over-claimed, and this file's own update is where it said it.** The
  2026-11-14 entry above states that "the pair match is now compared EXACTLY (scope included),
  which removes the cross-reporting the proposal worried about: a completed child can no longer
  be reported under a concurrent host thread's identity". That is true of the two steps it names,
  and true of every run that reaches `registerInvocation`; it is not true of the whole chain, and
  the index row for this issue (`docs/issues/README.md`) repeated it as "both now compared
  exactly". The chain is THREE steps, and the third one is still discovery.
- **What the code actually does** (`newInvocationOf`, `src/harness.ts:4595-4623`, tried in order):
  1. **carrier address** — `carried.invocationId` (written by the child run itself,
     `src/harness.ts:12126-12129`) keys `invocationRecords.get` directly, then verifies the entry
     still carries that id and belongs to the target agent (`:4596-4607`). EXACT.
  2. **the `(parentCallId, parentScope)` pair** — `records.find` compares BOTH fields with `===`
     (`:4611-4621`). EXACT, and it is an address, not a guess.
  3. **the set-difference** — `records.find((record) => !knownInvocations.has(record.invocationId))`
     (`:4623`, against the dispatch-time snapshot taken at `:4576-4578`) returns "the newest record
     for that agent that did not exist when this call started". That IS discovery: the wording this
     fix retired was "newest record", and this is "newest record not previously seen" — one filter
     away from the same guess, not an address.
- **The residual, named.** A delegation whose child never wrote a carrier — a host that calls
  `runtime.delegate` with its own `run` closure that ignores the options, or a child refused before
  it owned its actor — falls through to step 3, and a concurrent run of the SAME agent that started
  after the dispatch snapshot can then be adopted and reported as this call's child: the envelope
  carries that other run's `invocationId`, `threadId` and `status`. Steps 1 and 2 close the two
  shapes the stress reports reproduced; step 3 never claimed to. The in-code comment is more honest
  than the docs were: the heuristics "are kept in that order because both are fallible; a carrier
  always wins" (`src/harness.ts:4590-4594`).
- **No test exercises the third branch.** Every child this suite delegates is started by a harness
  run, and a harness run always writes the carrier — including the two host-path fixtures that call
  `runtime.delegate` directly (`src/harness.delegation.test.ts:1640` and `:2091`), because both
  forward `context.run!` unchanged instead of a closure that drops the options. So the adoption
  hazard on the no-carrier branch is pinned by nothing: the identity tests
  (`src/harness.delegation.test.ts:736`, `:796`, `:883`) all witness steps 1 and 2.
- **Deliberately not changed.** The fallback order and the set-difference stay: a record that
  cannot be confirmed already reports ABSENT (`src/harness.ts:4580-4588`, "an identity the runtime
  did not observe is never invented"), and dropping step 3 entirely would turn the
  refused-before-registration cases from right-most-of-the-time into never. The correction here is
  the CLAIM, not the logic: two exact steps, one discovery step, residual on the no-carrier branch.
- **Citation drift, restated so this file stays re-checkable.** The `src/harness.ts` addresses in
  the 2026-11-14 update above (`:4541-4547`, `:4592-4604`, `:11601`, `:12053`) moved during this
  pass. The live ones: the carrier is created at `:4544-4550`, the chain is `:4595-4623`,
  `commitTerminalIdentity` is `:11620`, and the carrier write is `:12126-12129` — which now sits as
  the FIRST statement inside the settle guard, so a host carrier that rejects the assignment still
  settles its ledger record and releases its conversation (the independent review's C1, 2026-11-14).
  Prefer
  the symbols (`delegateFor` → `newInvocationOf`, `delegatedRecordOf`, `commitTerminalIdentity`).

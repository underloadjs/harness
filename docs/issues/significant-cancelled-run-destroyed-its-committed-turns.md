# 0036 — A cancelled run destroyed the turns it had already committed, and three descriptions promised it

> **Status:** Fixed — 2026-11-15 (IT19 R1–R5; this entry records the shipped behaviour and the
> documentation that was made true about it — the crate-side divergence is named in
> **Limitations**, and the behaviour suites that prove R1–R5 are owned by a sibling pass)
> **Severity:** Significant
> **Area:** `src/harness.ts` (the `runAgentCore` cancellation exit, `purgeThread` /
> `deleteThread`, `postThreadMessage` / `sendThreadInput`, `deliverOwedAccounts`),
> `src/core/transcript-repair.ts`, `src/tools/runtime/{delegate,agentResult,threadSend,threadList,threadDelete,threadRead}.tool.ts`,
> `src/core/{metadata,tool-manifest}.ts`, `knowledge.md`
> **Date opened:** 2026-11-15

## Context

A thread that stopped mid-work used to look like a thread that had never worked. The cancellation
exit in `runAgentCore` spliced every message the run had appended, so the conversation that was
stuck — the one a host or a caller most needed to inspect — went back to its pre-run state, and the
answer that came back named only a message count. The 2026-11-15 pass (IT19) changed the runtime
behind that, and this entry exists because the model-facing contract had already promised the old
rule in four places: the `delegate` description pair, `agentResult`, `threadSend` and
`threadDelete`. A description that promises a rollback while the runtime retains is worse than no
description: a model that believes the promise re-asks for work that is still on the record, and a
model that believes "deletion is permanent" stops reading a transcript that is still readable.

## What was wrong, and what shipped instead

- **R1 — retention replaces the splice.** A run bound to a conversation keeps its committed tail:
  `run.threadState !== undefined` takes the keep branch, and only a branch / ephemeral run still
  splices (`src/harness.ts:12945-12947`, with the boundary argued in the block at `:12922-12944`). A
  thread transcript is durable state the host owns (`save()`/`load()`), so a stop, a park, a
  timeout or an API error may not silently erase the turns the model was shown. A branch is a
  throwaway clone whose parent takes the ANSWER, not the transcript, so its rollback stays.
- **Pairing is repaired, not spliced.** The retained tail can end in an assistant turn whose tool
  calls never got results, and a strict provider rejects that shape, so every dangling call gets
  one synthesized result (`repairInterruptedToolCalls` at `src/harness.ts:12959-12968`, wording at
  `src/core/transcript-repair.ts:79`). A call that did complete is left alone. This is why
  retention is safe to ship at all, and why the honest sentence is "only a tool call left without
  an answer is recorded as interrupted".
- **R3 — `stopReason` says why a run halted.** The cause is classified at the one exit every
  non-concluded run converges through (`run.stopReason = classifyRunStopReason(run, error)`,
  `src/harness.ts:12920`; classifier at `:12500-12528`) and travels on the abort reason
  (`withRunStopCause`, `:671`). It is a CAUSE, never a progress measure.
- **R2 — `threadDelete` marks, it does not destroy.** `purgeThread` sets `inactive` +
  `inactiveAt` (`src/harness.ts:6901-6904`), keeps the row, its transcript and its invocation
  rows, bumps the generation and clears the queue; `deleteThread` (`:6959`) still refuses a
  RUNNING target (`:6990-6991`) and a finished target with a RUNNING descendant (`:7080-7104`), and a second
  delete of an already-released descendant RESTATES the first receipt without re-marking and
  without a second `thread.deleted` hook. `removedInvocationIds` therefore now means "no longer
  listed"; `removedBranchIds` is the one genuinely removed set.
- **R5 — three receipts.** A send names which operation it caused: `queued` (STEERING, including a
  plugin-parked target, which STAYS parked), `started` (CONTINUE, a dormant target) and `resumed`
  (RESUME, a stopped thread whose run was cut short). The resumable set is
  `RESUMMABLE_RUN_STOP_REASONS` (`src/harness.ts:710-717`); `user-stopped`, `plugin-parked` and an
  absent reason are refused, and an INACTIVE target is refused before any status branch
  (`inactiveThreadError`, `:733-738`) at the two AGENT doors - `postThreadMessage` (`:6041`) and
  `steerThread` (`:7374-7375`). `sendThreadInput` (`:7420`) is the HOST door and is deliberately
  NOT one of those refusals: it REVIVES the conversation, clearing `inactive`/`inactiveAt` at
  `:7440-7449`. Every refusal queues nothing.

## Independent-review corrections (the four sentences that were wrong the first time)

- A cancelled `threadFork` keeps ONLY its fork baseline: the branch run splices, so "the transcript
  survives a cancellation" is true of conversations and false of branches. The Rust `threadFork`
  row and the TS entry both already said the branch case, and both keep saying it.
- `threadList` never advertised `sendThreadInput` or `deleteThread`; those are host doors, so the
  roster text names only what an agent may do with a row and points at `stopReason` for the rest.
- A late child does NOT wake a concluded parent. `deliverOwedAccounts`
  (`src/harness.ts:9571-9656`, placeholder upgrade at `:9583-9611`) pays the debt at the top of the
  parent's NEXT turn, before the mailbox drain, and rides the call's own slot — so a retained run
  that was cut off mid-`delegate` has its interrupted placeholder UPGRADED in place (same call id,
  same position, same `messageId`, no `outcome` key) rather than gaining a second, contradictory
  account beside it. When the account cannot be described the placeholder stays.
- `parked` is prose for the `paused` status, not a new status. Nothing in R1–R5 adds a literal.

## Deliberate non-changes

No new status literal, no `parked`, no new registered tool (the manifest stays 32 descriptors),
`cancelledAtMessage` kept with its corrected meaning (a count of committed messages, not a progress
measure), `paused` still reported as `queued` by a send, `budget-exhausted` still in the resumable
set although `classifyRunStopReason` never returns it, and `api-error` remains the fallback branch
of that classifier (`:12527`) rather than a verified transport failure.

## Evidence

- `src/harness.ts:12916-12920` cause stamp; `:12945-12947` the retention boundary; the pairing
  repair is the call at `:12959-12968`; `:12500-12528` the classifier; `:710-718` the resumable
  set with its exclusions argued above it; `:733-738` the inactive refusal sentence and the agent
  doors that use it (`:6041`, `:7374-7375`); `:6894-6900` the mark; `:6990-6991` and `:7080-7104`
  the two running refusals; `:7420` with `:7440-7449` the host door that REVIVES an inactive
  conversation instead of refusing it; `:9571-9656` with `:9583-9611` the owed account and its
  in-place placeholder upgrade.
- `src/core/transcript-repair.ts:21-29, 79, 113` — the synthesized-interrupted vocabulary and the
  detector, deliberately separate from the server's crash repair
  (`src/server/persistence.ts:1752`).
- Descriptions, four-copy discipline: the entry literal in `src/tools/runtime/delegate.tool.ts`,
  the generated `src/core/tool-manifest.ts` (regenerated with `yarn workspace @underload/harness
  tools:manifest`; `tools:manifest:check` reports it current, 32 descriptors), the allowlist
  template in the same entry, and its hand-maintained mirror in `src/core/metadata.ts` — the two
  pairs verified BYTE-IDENTICAL by a probe (`Temp/docs/four-copy-check.ts`: A/B 2172 chars, C/D
  4107 chars, retention clause present in all four, no "rolled back" claim left).
- `src/tools/runtime/threadDelete.test.ts` pins the shipped `thread` schema row and the mark /
  idempotent-re-delete / `toolCancel`-remedy wording, and keeps the running-refusal substring pin.
- `knowledge.md` — the retired sentences are gone at the eight sites this pass touched (leak
  boundary, the roster bullet, `threadSend`, `threadDelete`, the stop path, `maxIterations`, "Not
  built yet" item 9, and the new delegation bullet).

## Acceptance criteria met

1. No description promises a rollback for a conversation run; each states the retention rule and
   the interrupted-call exception in the same words. (Verified by probe, above.)
2. `threadDelete`'s text describes a MARK, what survives, the idempotent re-delete, and the one
   agent stop that exists. (Test-pinned.)
3. `threadSend`'s text names all three receipts and every refusal reason, including inactive.
   (Test-pinned through the schema row; behaviour pinned by the sibling's runtime suite.)
4. `threadList`'s text explains that an inactive row is retained-but-unaddressable and that
   `stopReason` decides resumability.
5. The generated manifest and both allowlist copies agree byte-for-byte with the entries.

## Tests to add

- `src/tools/runtime/threadDelete.test.ts` — updated with this pass (schema row, the mark wording,
  the `toolCancel` remedy, idempotent re-delete, retained result rows).
- Behaviour of R1–R5 lives in `src/harness.thread-runtime.test.ts`, `src/harness.agent-results.test.ts`,
  `src/harness.delegation.test.ts`, `src/harness.background.test.ts`, `src/harness.fork.test.ts`,
  `src/harness.snapshot.test.ts`, `src/server/threads.test.ts` and
  `src/server/thread-stop-reference.test.ts`. Those files, and their runs, belong to the sibling
  pass that changed the runtime; this pass changed no behaviour and did not run them.

## Limitations

- **REST does not carry `stopReason`.** `src/shared/harness-api.ts` has zero occurrences of it, so
  the HTTP `ThreadSummary` cannot tell a client whether an agent may resume a stopped thread; the
  field is library- and tool-side only today.
- **Retention is capped.** `capThreadRecords` (`src/server/sessions.ts:4787`) prunes the OLDEST
  inactive rows past the bound, so "retained" is bounded retention. The per-event journal
  (`events.jsonl`) CAN still hold what the row cost, but it is not a promised survivor: it is
  opt-in and created lazily. `attachJournal` answers `undefined` whenever the store has no
  persistence root (`src/server/sessions.ts:5440-5442`) and a session starts with
  `journal: undefined` (`:2350`), so an in-memory session loses the row AND the journal.
- **`budget-exhausted` has no producer** in `classifyRunStopReason`; it is resumable and typed but
  only reachable through a cause stamped by a host or a lane.
- **The Rust crate still models the old rule.** `packages/typecrate/harness/src/turn.rs:30-34`
  (the cancelled arm at `:245-255`, the failed arm at `:265-275`) plus `src/store/turns.rs:1189-1213` roll a cancelled run back;
  there is no `inactive` / `inactiveAt` / thread `stopReason` model, and unknown lifecycle words
  fold to `idle` (`src/contract.rs:362-373`, `src/store/read.rs:1320-1327`,
  `src/api/threads.rs:326-330`). Its interrupted-result vocabulary exists only on the restore side
  (`src/persistence.rs:86-105`, `:2104-2127`). Only the four catalogue rows whose prose mirrored the
  TS text were hand-edited here — no count moved (`ENTRIES: [Entry; 36]`, `UNLISTED: [&str; 4]`,
  36 `name:` rows) and no behaviour ported. **Cargo was not run, so those rows are
  text-verified only.**

## Out of scope

No change to `src/harness.ts`, `src/server/**`, `src/core/transcript-repair.ts`,
`src/types/index.ts`, `src/core/snapshot.ts` or `src/frontend/**`; no new status literal, no new
tool, no lane/worker change, no crate behaviour port.

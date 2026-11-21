# 2026-11-19 — Tool-call composition: transport liveness and a visibility plane

**Date:** 2026-11-19
**Method:** two live session captures read read-only off disk (no live-store writes), then the
transport/stream reader read line by line against the working tree. Probes:
`Temp/coding/t6/probe-gaps.ts`, `Temp/coding/t6/probe-live.ts`, `Temp/coding/t6/probe-live2.ts`
(run with `yarn vite-node`, output quoted below). Implementation was landed by other workers;
this entry is the record the code cites.
**Scope:** `src/transport/openai.ts` (tool-call accumulation, early-close classification), the
`progress` signal through `src/types/index.ts` → `src/core/agent.ts` → `src/harness.ts` →
`src/shared/harness-stream.ts` / `src/harness-server.swagger.yaml` / `src/shared/harness-api.ts`
(generated) → `src/shared/turn-display.ts` → `src/server/turn-projector.ts` →
`src/frontend/view-state.ts` / `src/frontend/ui/turns.ts`. The rank model is **out of scope** —
it is not the cause (Finding 1).

---

## The report

Delegation "broke" when the `primary`/`subagent` vocabulary was replaced by ranks: a run
announced four delegates and then sat. Two captures of the same shape, one fatal, one benign, are
in hand. The report's premise (the rank change) is what Findings 1–2 refute. The announcement WAS
the model's own streamed text, not a frame the harness emits: the stalled turn's last text
deltas end the sentence *"Fixtures ready. Now launching four parallel delegate batteries — three
functional plus one dedicated concurrency race."* (`…/beed8a0c-…/events.jsonl`, indices 1903–1904
carry ` launching` / ` four`, and the reassembly of thread-2's `text` deltas is in
`Temp/coding/t6/probe-launching.ts` — output quoted there). The stall began at that sentence's
last delta, `1795001972983` (`:2` above), i.e. **72 ms** after the word ` launching` arrived: the
model finished talking, started writing the tool block, and no frame followed for 62 s.

## Findings

### 1. The rank model is not the cause — the tool block was, and it was invisible

| Fact | Evidence |
|---|---|
| The stalled session journaled **zero** `delegate` frames | `…/typescript/temporary/dump/harness/sessions/beed8a0c-604f-46a8-a71e-016136af89dc/events.jsonl` — the **2 014 `event` lines** figure is the journal as it stood AT THE ABORT (every line with `at <= 1795002035215`, re-counted 2026-11-19 by an `awk` scan of the file). That session kept running afterwards, so the file now holds **8 713** event lines; every probe below was re-run against both readings and gives the same answer. `grep`/probe count of `call.name === 'delegate'` = **0**; the only `tool_call` frames are `shell` ×2 and `toolList` ×1, and `threads/thread-2.json` persists assistant tool calls `["shell","toolList","shell"]` |
| The turn stalled for **62.232 s** immediately after the last text delta, then ended in a user abort | same file: last `text` at `1795001972983`, next frame `error` at `1795002035215` (`62232 ms`), payload `{"message":"This operation was aborted","thread":{"id":"2"}}` |
| The stalled harness was the shipped `instruct` preset, i.e. correctly ranked, with `delegate` available | `src/server/harnesses/presets.ts:211-230` — roster `['instruct','general','research','workspace','reviewer','debugger','summarizer']`, `instruct: ENTRY_RANK` (`'A'`, `:168`) over six `TEAM_RANK` members; `entry: 'instruct'` at `:228` |
| **CORRECTED IN PLACE 2026-11-19 — the earlier hedge was too modest.** It used to read "**Partially unconfirmed:** the capture itself cannot show those letters", and that is wrong: the capture DOES show them. `session.json` `.definition.ranks` persists the RESOLVED map — `{"instruct":"A","general":"B","research":"B","workspace":"B","reviewer":"B","debugger":"B","summarizer":"B"}` — and `.preset.ranks` carries the same map, so "entry `A` over six `B`" is an observation from that dump, not only the shipped preset's shape. What is genuinely NOT journalled is a per-agent rank field: `core.agents[*]` still persists just `{ model, messages }` for each of the seven agents, which is the half the original probe actually looked at | `grep -o '"ranks":{[^}]*}' session.json` and `jq '.definition.ranks'` against that dump, re-run 2026-11-19; the earlier probe `Temp/coding/t6/probe-live2.ts` read `core.agents[*]` only |
| The stalled sentence names the very block that was being composed | reassembling thread-2's `text` deltas gives `… Fixtures ready. Now launching four parallel delegate batteries — three functional plus one dedicated concurrency race.` and NOTHING after it (`Temp/coding/t6/probe-launching.ts`); the four calls then sat unwritten for 62.232 s |
| The same signature completed normally in a second capture | `Temp/d1/session/events.jsonl` (session `6a94b896-7c23-477b-af34-90738bb09764`): largest mid-generation gap on the root thread **27.683 s**, `text → usage`; the four `delegate` `tool_call` frames then launched at `…392987 / …393001 / …393020 / …393034` — **47 ms apart end to end** |
| That relay reports clean, provider-minted call ids | every `tool_call.id` in `Temp/d1/session/events.jsonl` is `call_<hex>`; **0** `progress` frames (the capture predates R5) |

**Corollary, stated plainly:** no live capture in this repo shows a name-echoing relay or an
id-less tool call. `Temp/d1/session/events.jsonl` carries `call_*` ids on every call and was
recorded before this change. R1 (`nameIsEcho`) and R2 (the minted id) are therefore **defensive
hardening** — rules that make a shape the contract permits illegal — not fixes for an observed
relay defect.

### 2. Why the silence was real, and why nothing could end it

| Fact | Evidence |
|---|---|
| Tool-call fragments are merged in the reader with **no yield**; `tool_call` events exist only after the terminal frame | `src/transport/openai.ts:1976-1979` (merge), `src/types/index.ts:487-494` ("Tool calls arrive on the terminal frame rather than as deltas") |
| That relay family withholds the WHOLE tool region and flushes one final frame | `services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100` and `:993-1003` (NInfer's `ToolCallStreamFilter` … "the stream carries exactly ONE final SSE frame with the complete `delta.tool_calls` array"); the sibling deploy doc says progressive streaming degrades to one update and "stall detectors, and live progress consumers all stop working" — `services/modal/deploy/qwen3.8-27b/modal_qwen3_8_l40s_ninfer.py:984-993` |
| SSE keep-alive comments cannot cross the relay hop either | the OpenAI SDK's SSE reader returns `null` for any line starting with `:` — `node_modules/openai/src/core/streaming.ts:321-324` — and the relay re-emits only `data:` lines built from parsed chunks: `runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts:162-164` |
| A 27 s or 62 s tool block is **inside every bound**: head 300 000 ms, first token 300 000 ms, **between-reads** 120 000 ms | `src/transport/provider-timeouts.ts:150-152`; the rationale for those generous defaults is `:41-66` |
| The first genuine danger zone is a tool block **longer than the 120 s between-reads bound**: it yields the coded `provider-timeout`, which takes the 4-attempt ladder (1 + 3, 2 s/4 s/8 s capped at 30 s, 900 000 ms sequence deadline) and re-sends from token 1, discarding the generated arguments | `src/core/agent.ts:1361-1385, 1402-1424`; `src/core/agent-limits.ts:179-207` (the ladder's shape), `:209-221` (`PROVIDER_TIMEOUT_MAX_RETRIES = 3`, `PROVIDER_TIMEOUT_RETRY_BASE_DELAY_MS = 2_000`, `PROVIDER_TIMEOUT_RETRY_DEADLINE_MS = 900_000`); pinned in `src/transport/openai.tool-call-liveness.test.ts:688` ("fires NOTHING at 62 s of silence and fires `stream-chunk` at exactly 120 s (the reported turn)") and `:607` (a default-configured stream trickles past 3 600 000 ms with no bound firing) |
| **No timeout default changed** | `src/transport/provider-timeouts.ts:150-152` still ships `300_000 / 300_000 / 120_000`; the "deliberately generous" decision is recorded at `:41-66` |

### 3. What the reader did with a complete block (the four transport defects)

| Defect | Before | Now | Pinned by |
|---|---|---|---|
| D1 name echo | `entry.name += name` unconditionally → `delegatedelegate`, which resolves to no tool and fails the whole multi-call block | name fragments APPEND, and the ONLY drop is a fragment byte-identical to the whole accumulated name (`nameIsEcho`). REVISED BY THE REVIEW (F2): the first version ALSO dropped every name once the slot had taken an argument byte, which flushed `deleg` from `name:'deleg'` + args + `name:'ate'` — an unresolvable call that fails the whole block — so that clause is gone and an interleaved piece concatenates again | `src/transport/openai.ts:1067-1072` (rule), `:1019-1066` (rationale, incl. the accepted residual risk); tests `src/transport/openai.tool-call-liveness.test.ts:304` (pieces still concatenate), `:333` (an echoed full name is ignored), `:371` (a late name on an unnamed slot is taken, later echoes are not), `:400` (a piece AFTER the first argument byte concatenates) |
| D2 anonymous calls | flushed as `id: ''`, so several parallel calls were unpairable — replay pairs a `tool` result with its call BY `tool_call_id` | `finishToolCalls` mints `harness-call-<slot>` with collision bumping, and both sides of the pair read the same string | `src/transport/openai.ts:1093, 1129-1155`; tests `:791` (distinct ids in slot order), `:810` (the same id on both sides), `:873` (never duplicates a provider id) |
| D3 de-multiplexing | `index ?? 0` → every index-less fragment landed in slot 0, merging parallel calls into one unresolvable call | `slotForFragment`: numeric `index` is authoritative → a known `id` → an unseen `id` OPENS a slot → else the slot last known to be streaming | `src/transport/openai.ts:979-1004`; tests `:528`, `:561` (the `?? 0` shape preserved), `:588` (a second id opens its own slot), `:265` |
| D4 early close | a body that ended without `[DONE]` and without a `finish_reason` **discarded a complete tool block** and raised a **codeless** `provider-transit` error → the generic 11-attempt ladder, i.e. up to 10 full re-generations of a ~60 s block | `completeToolRound`: when every accumulated slot's arguments parse to a plain JSON object, the round is `done` with `stopReason: 'tool_calls'`; the truncation guard still fires for partial args | `src/transport/openai.ts:2062-2110` (the shape test is the same `isPlainJsonObject` the outbound wire applies, `:317-333`); tests `:444` (a complete block survives), `:478` (a half-written block still fails), `:503` (non-object args are not a completed round) |

**Disclosed trade-off (D4):** a socket cut *between two complete calls* now launches the partial
set instead of retrying the block. A no-argument call whose provider streamed `arguments: ''`
still keeps its old retry, because `''` is not a JSON object and the transport cannot tell "no
arguments" from "cut before the first byte" — conservative on purpose
(`src/transport/openai.ts:2065-2069`).

### 4. The visibility half: one new projection-only event kind

| Layer | Fact | Source |
|---|---|---|
| Types | `HarnessProgressPhase = 'tool-composition' \| 'idle'`; `HarnessToolCallProgress = { phase, toolCallSlots, argumentChars }` — **never argument text** | `src/types/index.ts:468, 477-485`; the "counters only" reasoning at `:470-476` |
| Transport | a `HarnessStreamEvent` variant `{ type: 'progress' } & HarnessToolCallProgress` | `src/types/index.ts:498`; emitted at `src/transport/openai.ts:2017`, and a ZERO-slot sample emits nothing (review F3 — `composing 0 tool calls · 0 chars` must never be printable) |
| Throttle | one emission at phase entry, then at most one per 500 ms; monotonic clock (`performance.now`), **no new timer**, no new interval | `src/transport/openai.ts:1108` (interval), `:1835, 1852` (the per-attempt accumulator and its monotonic clock — attempt scoping needs no new timer), `:2011-2018` (the emit site, gated on a non-zero slot count) |
| Agent | forwarded as an event and nothing else — not accumulated, not committed; attempt scoping is free because the retry loop re-creates the transport iterator and the throttle clock lives in that closure | `src/core/agent.ts:1174-1199` |
| Harness | published through the one `emit` gate, so it carries `thread` (a delegated child's composition lands on its own section) and IS journalled verbatim | `src/harness.ts:13452-13478`; `HarnessEvent` variant `src/types/index.ts:4192` (the union opens at `:4045`); `copyEvent` `src/server/sessions.ts:1372` |
| Contract | regenerated through `scripts/generate-harness-contract.ts`: `progress` added to the CLOSED `HarnessEventType` list, the swagger event schema, and the recorded-event type | `src/shared/harness-stream.ts:130-146`; `src/harness-server.swagger.yaml:9241, 9257, 9687-9709`; `src/shared/harness-api.ts:3956, 4057-4068` |
| Display | one attempt-scoped field `TurnSection.toolProgress`, painted by `paintToolProgress` — **it mints no node, no step and no context block**, costs ZERO ops when the value did not move, and is cleared to `idle` at `done` / `retry` / `attempt_commit` / `error` AND at every terminal edge that has no frame of its own — a child settled by the PARENT's `tool_result`, `branch_end`, and the `settle()` sweep (review F1: a journal that ends ON a `progress` frame must not replay a live line on a finished turn) | `src/shared/turn-display.ts:1154, 1181`; `src/server/turn-projector.ts:363, 1926-1945, 3390-3395`, frame-driven clears at `:3261, 3379, 3394, 3455`, terminal-edge clears at `:3187, 3659, 3899` |
| Frontend | the ops fold applies the field; the tile renders a composition clause and a quiet/silent grade | `src/frontend/view-state.ts:424-429`; the composition clause `src/frontend/ui/turns.ts:877-905` (text `:891-893`, title `:898-904`) and the silence clause `:4807-4832` (text `:4829-4830`, title `:4855-4857`); thresholds `src/frontend/ui/time.ts:52-53`; per-agent grades come from receipt stamps and are repainted from the document / stream paths and on a 1 000 ms clock (`gradeActivityFromStamps` — cited BY SYMBOL, `src/frontend/ui/activity.ts`; `src/frontend/main.ts:6732, 6761-6789, 6845-6855, 7455, 13988, 14437, 14601`) — verified 2026-11-19 against the shipped files (see R7) |

**Journal consequence, stated exactly:** a `progress` line is appended in recorded order and
consumes a journal position, so the ORDINALS of every later event — and the node / context-block
/ step ids derived from that position — move relative to a turn that never composed a tool call.
Append order is never corrupted: the journal's `turnId + index` is the turn's append-only position
and a gap is corruption, and the parity pin compares the two projections **with the
position-derived keys set aside** and says so. `src/server/journal.ts:118, 143, 691`;
`src/server/journal-progress.test.ts:166-190` ("never shifts another event index") and
`:192-266` ("with their real ids and timestamps the two displays are NOT equal … exactly as they
already move for a journaled `wakeup`"). Volume: ≤ ~2 lines per second per composing turn
(the 500 ms throttle), and a relay that flushes the whole tool region in one frame costs exactly
one line (`src/transport/openai.tool-call-progress.test.ts:255`).

### 5. Timeout policy interaction (for the record)

Nothing was retuned. The two reported spans sit **inside** every shipped bound, so no timeout
could have ended either turn; the only way this shape becomes a timeout is a tool block over
120 s of silence, which yields `provider-timeout` → 4 attempts (`src/core/agent.ts:1361-1385, 1402-1424`,
`src/core/agent-limits.ts:179-207, 209-221`), and the re-send starts the request again from token 1 with
the generated arguments discarded. `MODEL_TIMEOUT_MAX_MS` (3 600 000) is **not** a request clock:
it ceilings a *model-settable* `delegate`/`threadFork` bound
(`src/core/agent-limits.ts:74-81`). See [issue 0037](../issues/minor-relay-gateway-silence-adds-no-per-request-provider-log.md)
(relay/gateway co-defect, code outside this package) and
[issue 0038](../issues/minor-long-tool-block-has-no-per-attempt-total-clock.md) (the harness-side
residual: no per-attempt total clock).

## Tasks (all landed; the check is the closing evidence)

1. **R1 — name fragments stop echoing.** Closing check: `src/transport/openai.tool-call-liveness.test.ts:304, 333, 371, 400` pin concatenation, echo-rejection, the late-name case and the argument-interleaved piece in both directions (the `:400` pin and the relaxed rule are the review's F2 correction — the range cited here before the review was `:304, 333, 365`). **Done.**
2. **R2 — an anonymous tool call gets a minted, collision-checked id that pairs byte-exactly on both sides of the transcript.** Closing check: `:791, 810, 873`; the minting site is `src/transport/openai.ts:1129-1155`. **Done.**
3. **R3 — one de-multiplexing rule for index-less fragments.** Closing check: `:265, 528, 561, 588`; rule at `src/transport/openai.ts:979-1004`. **Done.**
4. **R4 — a complete tool round survives a body that closed without `[DONE]`/`finish_reason`; the truncation guard keeps partial args.** Closing check: `:444, 478, 503`; rule at `src/transport/openai.ts:2029-2080`. **Done.**
5. **R5 — a `progress` frame exists, throttled, counters-only, and is legal on every plane.** Closing checks: `src/transport/openai.tool-call-progress.test.ts:99, 128, 150, 185, 212, 240, 255, 293`; `src/harness.progress.test.ts:60, 103, 126, 158`; `src/server/turn-projector-progress.test.ts:159, 195, 237, 273, 300`; `src/server/journal-progress.test.ts:138, 166, 192`. **Done.**
6. **R6 — the display plane shows the composition without inventing structure: one section field, no node, no context block, cleared at every attempt/terminal boundary.** Closing check: `src/server/turn-projector-progress.test.ts:159` (zero nodes/steps/blocks, tree byte-identical) and `:273` (a cold reload equals the live fold); the terminal edges are pinned by `:412-542` ("the composition line ends with the section": the parent's `tool_result` for a spawn call, a turn-level `cancelled` settle, a force-closed and an already-terminal row, the `done` answer clearing EXACTLY once, zero ops where the field was never painted, and a cold reload of an aborted journal). **Done.**
7. **R7 — frontend honesty: the quiet/silent grades are PRESENTATION thresholds, not timeouts, and the composition line is the positive half.** Verified 2026-11-19 against the shipped working tree: the composition clause is `composing N tool call(s) · <chars> chars` (`src/frontend/ui/turns.ts:891-893`) with its full `title` claim at `:898-904`; the silence clause is `still generating · quiet for <duration>`, and ONLY the 30 s grade adds "— the run is still working" (`src/frontend/ui/turns.ts:4829-4830`, title `:4855-4857`); the thresholds are `QUIET_AFTER_MS` / `SILENT_AFTER_MS` (`src/frontend/ui/time.ts:52-53`) and nothing in that package ends a run on a clock; and the per-agent grades are wired end to end (`gradeActivityFromStamps` — cited BY SYMBOL, `src/frontend/ui/activity.ts` (that file's line numbers move every pass), stamps from each ops frame `src/frontend/main.ts:14593-14600`, graded paint `:6845-6855` called at `:7455, 13988, 14437, 14601`, 1 000 ms re-grade clock `:6732, 6761-6789`). That file's header comment states the same wired fact (`src/frontend/ui/activity.ts:31-42`), so nothing here is left pending.

### Review wave (same day, after an independent review of the landed fix)

A reviewer added `src/harness.tool-composition-review.test.ts` (28 probes of its own, against its
own fold; 30 cases on disk now, because the fixes below each added the direction they opened) and
found four real gaps in what had just landed. All four are fixed, and the probe pins
that had recorded a SHIPPED DEFECT as a fact were re-pinned to the fixed behaviour — each such
pin says so where it sits, so a later reader can tell "this was pinned wrong once" from "this is
a regression guard written blind".

| Fix | What the review found | Where it is settled now |
|---|---|---|
| F1 | `toolProgress` outlived the attempt that produced it on the two terminal edges that carry NO frame of their own: a child cancelled by its parent's `tool_result` (that child emits no `error` frame), and a journal that simply ENDS on a `progress` frame when the user aborts. The settled row kept printing `composing N tool calls` on every reload, which the field contract forbids and which the tile made visible by scanning nested sections | clears at `src/server/turn-projector.ts:3187` (parent's `tool_result`), `:3659` (`branch_end`) and `:3899` (the `settle()` sweep, root included); pinned by `src/server/turn-projector-progress.test.ts:412-542` plus the two re-pinned probes in `src/harness.tool-composition-review.test.ts` |
| F2 | the name-echo guard was WIDER than an echo: it also dropped every name once the slot had taken an argument byte, so `name:'deleg'` then args then `name:'ate'` flushed `deleg` — an unresolvable tool, which fails the WHOLE multi-call block. That was a regression against the previous behaviour | rule at `src/transport/openai.ts:1067-1072` (the only drop is a byte-identical whole-name echo), rationale and the accepted residual risk at `:1019-1066`; pinned `src/transport/openai.tool-call-liveness.test.ts:400` and in the review file, including the name-PREFIX case the rule still cannot resolve |
| F3 | a `tool_calls: []` delta produced `{slots: 0, chars: 0}` — the self-contradictory line `composing 0 tool calls · 0 chars` | `src/transport/openai.ts:2011-2018`: a zero-slot sample emits NOTHING and does not spend the attempt's phase-entry emission, so the first real fragment still reports immediately; pinned `src/transport/openai.tool-call-progress.test.ts:307` and in the review file |
| F4 | the CLI renderer had no `progress` arm at all, so human terminal output stayed blind during composition BY ACCIDENT (an implicit default) while `--json` carried the frame | an explicit, validated `case 'progress'` at `src/server/cli/render.ts:258` — one dim line, only when the counters move |

Nothing in the review wave changed the contract, the journal format, the timeout policy or the
display schema; F1-F3 are behaviour fixes inside the transport and the projector, and F4 is a
renderer arm.


## Not tested / not confirmed

- Whether any relay in this workspace echoes `function.name` or omits `id`: no capture shows it
  (Finding 1), so D1/D2 are defensive.
- The rank letters the stalled session actually resolved are journalled after all: `session.json`
  `.definition.ranks` (and `.preset.ranks`) hold the resolved map, `instruct: A` over six `B`, so the
  Finding 1 row now states this as an OBSERVATION, not a preset inference. The unjournalled half is a
  per-agent rank key — `core.agents[*]` persists only `{ model, messages }` (corrected 2026-11-19;
  the earlier wording claimed the dump could not show the letters at all).
- Live-provider replay: no live model was dialled for this change; every figure above came from
  recorded captures or from a deterministic stub in the named test files.
- The exact frontend strings (tile clause, quiet title, ring grades) are quoted in R7 and were read
  off the shipped files on 2026-11-19; that wording stays owned by the frontend pass, so a later
  rewrite of it is not a defect in this record.

## Documentation gap recorded while writing this

`docs/tasks/2026-11-09-thread-timeout-policy.md` is cited by **eight** places in `src/`
(`src/core/agent-limits.ts:38`, `src/harness.ts:5817`, `src/tools/runtime/delegate.tool.ts:87`,
`src/harness.delegation.test.ts:49, 2573`, `src/harness.fork.test.ts:19, 1259`,
`src/harness.thread-runtime.test.ts:2524`) and is **not on disk** — `ls docs/tasks/` holds eight dated
briefs plus its README, and not this one. Its `R1/R2/R5` / `T5.3` / `F2` requirement labels are quoted by those
comments, so its contents must not be reconstructed from memory; treat any claim about that brief
as `unconfirmed` until the file is restored or the citations are re-pointed.

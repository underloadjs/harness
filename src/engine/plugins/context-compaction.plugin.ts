// Context Compaction — the shipped preset plugin (R3, summarize flow T9).
//
// WHAT THIS FILE DOES NOW
// -----------------------
// The TRIGGER, the PAUSE lifecycle, and TWO writers. Every conversation has a context
// limit; when one reaches it, this plugin parks the thread at the turn boundary and runs
// the compaction. In the DEFAULT mode (`summarize`) the compaction is performed BY THE
// CONVERSATION ITSELF: the next model turn is handed an instruction the plugin commits
// into the transcript, the agent answers with its own compacted knowledge, and everything
// the summary replaced stops being sent — through the shipped `setIncluded` flag, so
// nothing is deleted and a host can switch a turn back. In `exclude` mode (the R3
// behaviour, unchanged) the pass instead prunes superseded tool failures — a
// `failed`/`rejected` unit that a LATER unit already answered (same tool, same canonical
// argument fingerprint, answered `completed`) stops being sent, reversibly.
//
// THE POLICY LIVES ELSEWHERE ON PURPOSE
// -------------------------------------
// `executeCompaction` below is the `exclude` WRITER. The decision is a pure function in
// ../core/context-pruning.ts (`planContextPruning`), so the rule can be pinned by a table
// without a harness, a transport or a clock, and so a future `annotate` mode (T0 Q1) is a
// second writer over the SAME plan rather than a second policy. The order of the action is
// therefore fixed: read settings → build the plan → write the flags → report. A plan that
// clears none of its guards writes NOTHING, which also means no persistence notification and
// no save. The `summarize` writer is `createContextCompactionPasses` further down: its
// decision is the agent's own, so all this file owns is the machine that gets the
// instruction in and the range out (see "THE SUMMARIZE FLOW").
//
// PRE-OUTCOME TRANSCRIPTS: a conversation saved before the tool outcome was persisted
// (compaction T1 — `outcome` on a tool message, core/tool-outcome.ts) reads as all
// `completed`, because nothing re-derives an outcome from the result text.
//
// WHY A BRANCH ROUND IS SKIPPED ENTIRELY (ratified 2026-11-09)
// ------------------------------------------------------------
// A fork/autoanswer round has no persistent conversation: its transcript is an ephemeral
// copy that snapshot v1 excludes and that is INCORPORATED into the owner as text. A flag
// written there is therefore thrown away at incorporation, the owner re-derives the same
// decision on its own next round, and the only durable effect was a cooldown entry keyed by
// the branch's scheduling actor key (`branch:<id>`), which one turn later is a dead key in a
// map nothing prunes (see "WHY THE COOLDOWN MAP IS NEVER PRUNED" below). So the guard
// refuses to trigger on `context.branchId`, the action returns for one too (a host calling
// it directly must not prune an ephemeral copy), and the pollution stops. Recorded against
// F11/T8 of ../docs/tasks/2026-11-09-context-inclusion-followups.md, which is where the
// discriminator (`branchId`) was specified.
//
// THE TRIGGER POINT — ONE NUMBER (the operator's 2026-11-10 ruling)
// -----------------------------------------------------------------
// `contextLimit` is the CEILING, and the firing point is that ceiling minus the headroom
// buffer below: when a turn's `estimatedTokens` is at or above the effective limit, the pass
// fires on THAT turn. "One number" still holds in the sense the ruling meant — there is no
// SECOND input beside the limit; the buffer is a ratio OF the limit, not a knob next to it. The
// effective limit is resolved per turn from the same inputs as before, minus the headroom:
//
//     resolved  = modelLimits[<current model>].limit ?? contextLimit
//     ceiling   = model window is declared ? min(resolved, window) : resolved
//     buffer    = min(max(16000, floor(ceiling * headroomRatio)),
//                     floor(ceiling / 2), ceiling - 1)
//     trigger   = max(1, floor(ceiling) - buffer)
//
// The `buffer` line is the 2026-11-17 headroom rule. It first shipped gated on a DECLARED
// model window being the binding number; X2 (2026-11-17, F3) removed that gate, because the
// measured failure session declared NO window at all and therefore got zero leeway — see
// "THE HEADROOM BUFFER…" beside `HEADROOM_RATIO_DEFAULT` for both halves, and
// `resolveContextHeadroom` for the table. The declared-window rows are byte-identical across
// that change (4096→2048, 8192→4096, 32768→16768, 128000→108800, 200000→170000); what moved is
// every operator who sets only `contextLimit`, whose trigger is now the SAME formula run over
// their own ceiling.
//
// Each surviving input answers a different question:
//   - `contextLimit` is what the operator is WILLING to pay for, globally, and since X2 (F3) it
//     is also the ceiling the headroom buffer is measured against when nothing else binds — the
//     firing point is the limit minus the buffer, exactly as it always was for a declared window.
//     A former `gapTokens` headroom (a SECOND number, fire N tokens early because the answer grows
//     the context) was removed at the operator's request: one number, and one rule over it. What
//     keeps a blank pass from parking the same conversation every turn is the Rule-3 cooldown, not
//     a headroom.
//   - `modelLimits[...].limit` is what the operator is willing to pay for ONE model, so a
//     1M-token model and an 8k one stop sharing one ceiling.
//   - `modelLimits[...].window` is a FACT ABOUT THE MODEL — the hard context window the
//     provider rejects requests past. A ceiling above the window is a ceiling that can never
//     be reached, so the window caps it: limit 512k on a 256k model compacts at the 256k
//     behaviour, not at 512k.
//
// The model id comes from the live agent registry (`api.agents[context.agent].model()`), so
// an operator switching models changes the ceiling on the NEXT turn with no restart. When
// the lookup yields nothing (no registered brain, a host stub, a throwing accessor) the
// plugin does not guess: it degrades to "model unknown" — global limit as the ceiling, no
// window fact — and the buffer is measured over that ceiling like any other. Malformed
// `modelLimits` JSON and unusable entries are
// ignored the same way, so a typo in a settings field can never stop compaction altogether.
//
// THE TRIGGER RULES (each one exists for a concrete failure mode)
// ---------------------------------------------------------------
//   0. `enabled = false` turns the whole plugin off, before any other rule, so an operator
//      can stop compaction without removing the built-in (and the UI can offer that).
//   1. `contextLimit <= 0` turns the plugin off for every thread. A host that wants no
//      compaction sets 0 rather than removing the built-in (and the UI can offer that). It
//      is checked against the GLOBAL setting, before any per-model resolution, so "off"
//      means off even for a model that declares its own limit.
//   2. Below the trigger: do nothing AND forget this thread's last trigger. A compaction
//      that worked has to be able to fire again the next time the trigger is crossed.
//   3. At/above the trigger: fire on a FRESH crossing, or once the estimate has grown by
//      at least 5% of the resolved effective limit past the value that last fired (see
//      `REGROWTH_RATIO`). Without that margin a blank (or failing) action would pause the
//      same conversation on every single turn; with a strict "only once per crossing" rule
//      a conversation that keeps growing while compaction does nothing would never be
//      looked at again.
//   4. Never act on an internal compaction agent (`summarizer`, see `isInternalAgent`).
//      A real compactor will hand the summary to a summarizer thread; if this plugin
//      then compacted THAT conversation, the summarizer would re-trigger itself.
//
// THE SUMMARIZE FLOW — THE AGENT COMPACTS ITSELF (T9, the 2026-11-10 ruling)
// ---------------------------------------------------------------------------
// `mode: 'summarize'` (the DEFAULT now — an operator-approved behaviour change) does not
// guess at what is stale. It asks the conversation: at the turn boundary the plugin
// parks the thread, commits its own instruction into the CANONICAL transcript, and lets
// the NEXT model turn of that same conversation answer it. The turn carries the full
// context — the provider's prefix cache is still warm, because nothing before the
// instruction moved — and the answer is the compacted knowledge in the shape the instruction
// dictates: the objective with its requirements and decisions, the work state split into
// completed / active / blocked, an ordered next move, the files that matter, and the context a
// fresh read cannot recover.
//
// Then everything the summary replaced stops being SENT: every entry BEFORE the
// instruction, and the intermediate turns BETWEEN the instruction and that final answer,
// are flagged `included: false` (never deleted, never a system entry — the agent's
// instruction blocks stay). What the next request carries is the retained head
// `[instruction, summary]` plus whatever arrived after, which is the whole point: the
// context is small again and the agent still knows what it was doing.
//
// THE DISPLAY LANE A SUMMARIZE PASS LEAVES BEHIND (C1)
// ----------------------------------------------------
// A summarize pass also raises the conversation's DISPLAY LANE by exactly one, at the
// instant its instruction is committed. That lane is pure UI metadata — never model-facing,
// never on a `HarnessMessage` — and it is what the store stamps onto every event it records
// from then on, so the context bar of the turn the boundary happened IN paints its
// pre-compaction segments on row N and the compaction answer on row N+1: one compaction, two
// rows. `exclude` mode never bumps (see the block above `bumpLane` for why a prune does not
// deserve a row), a bump is undone whenever the pass ends without a compaction, and a refused
// lane write costs a diagnostic — never a failed compaction.
//
// THE PHASE MAP — WHY FIVE HOOKS AND NOT ONE
// ------------------------------------------
// The pass cannot finish inside `turn.before`: the answer it is waiting for is the one
// the request this hook is about to release will produce. So one in-memory phase per
// thread (`compacting` -> `finishing`) walks the pass across the run, and every hook
// below owns one edge of that machine. Branches never enter it (they have no durable
// conversation to compact, and `replaceHistory` refuses them), and neither does a run
// with no thread at all — for those `pause()`/`resume()` are no-ops and the committed
// instruction would be rolled back with the run, so the guard refuses the whole flow.
//
//   `turn.before`  — the trigger (Rules 0-5 + the phase guards), and the LAZY finalize:
//                    a run that kept going (steering or a tool round raced the answer)
//                    reaches the next boundary with `finishing` set, where `setIncluded`
//                    shrinks THIS request.
//   `turn.after`   — the answer arrived. A tool-free assistant turn is the summary, so
//                    the phase becomes `finishing` and the thread is un-parked here.
//                    That resume is load-bearing, not cosmetic: `thread.idle` fires only
//                    on a real transition to idle (src/harness.ts ~10227), so a thread
//                    left 'paused' would never reach the finalize below.
//   `thread.idle`  — the run ENDED on the summary, which is the common case. The
//                    transcript is rewritten through `api.threads.replaceMessages`
//                    (allowed exactly here: the run has detached and the record is
//                    idle), the phase clears, and a CONTINUATION NUDGE is sent so the
//                    conversation picks its task back up. The nudge's run queues behind
//                    the dying run's actor lock (`acquireAgent`) and projects the
//                    compacted context when it starts.
//   `run.finished` — the safety net for a compaction whose answer never reached
//                    `turn.after`: the thread is un-parked for ANY active phase, and the
//                    phase clears when it was still `compacting` (a `finishing` pass is
//                    finalized by the `thread.idle` that follows in the same `finally`).
//   `run.failed`   — same net on the failure path. The run's own rollback
//                    (`brain.messages.splice(commitIndex)`, src/harness.ts ~9677) has
//                    already removed the committed instruction and summary, so nothing
//                    is left to disable; only the park is. `finishing` survives on
//                    purpose — a later turn re-derives it — but a paused thread never
//                    does, because a stranded park hides the conversation from its host.
//
// WHY THE INTERMEDIATE TURNS GO TOO
// ---------------------------------
// A model that disobeys "do not call tools" answers with a tool round first, and the
// turns between the instruction and the real summary are exactly the ones the summary
// replaced: leaving them in the context would keep the noise and pay for it every turn.
// So the disable range is [0, final answer), excluding system entries and the
// instruction itself — which also covers the plain case, where the final answer is the
// message right after the instruction and the range adds nothing.
//
// THE COROLLARY A READER WILL ASK ABOUT (context T11/D3): guidance that DRAINS into that
// range — a steer or a queued `threadSend` that lands after the instruction was committed
// and before the summary — is withheld with the turns around it. That is the ratified rule
// ("disable all the turns between the instruction and the final answer") and it is not a
// lost message: a drain always happens BEFORE a request (`drainThreadQueue` runs ahead of
// `requestTurn`), so the model saw the text on the turn that produced the summary, and the
// summary is its durable record. What the rule does cost is that the text stops being sent
// from the NEXT request on, so an unrelated later turn cannot quote it back — the one
// consequence to know when reading a transcript whose entries are flagged off. A
// submission that arrives after the answer is retained: it is the next pass's history, not
// this one's. Pinned by the D3 case in src/plugin/context-compaction.test.ts.
//
// WHY THE CONTINUATION NUDGE IS A SEND AND NOT A RETURN VALUE
// -----------------------------------------------------------
// `turn.before` can rewrite THIS request; it cannot make the run continue after it
// resolved on the summary. The nudge is one more host-shaped turn on the same thread,
// fire-and-forget (`void ... .catch()`), so a conversation that compacted itself never
// silently stops mid-task. Its text names the summary as the source of the next step,
// which is what makes the retained head usable without the model having to ask.
//
// THE ONE CASE WHERE IT IS A STEER INSTEAD (the delegated run). When the answer is owed to
// a parent (`payload.depth >= 2`, `turn.after`:1611-1716), an out-of-band send would start a
// run the parent has already stopped awaiting, so the tool result would carry the summary and
// the real answer would be orphaned; there the same text is `api.threads.steer`ed into the run
// that is still running, which buys that run one more turn. Two consequences a reader needs:
//   - the nudge is drained into the transcript BEFORE the boundary that writes the range
//     (src/harness.ts:12669 -> `emitTurnBefore` :12182), so it shares the marker and must not
//     become the retention anchor — see `isContinuationNudge` and the F1 note there;
//   - the fold lands on the continuation turn itself (`finalizeInRequest`, via `setIncluded`),
//     never on a `thread.idle` rewrite, and the lane bump stays with `keepLaneBump` (:1213).
// KNOWN LIMITATION (F2, accepted 2026-11-16): if that queued nudge is never drained — the turn
// cap throws at src/harness.ts:12603-12649, before the :12669 drain — the run fails with the
// nudge still sitting in `state.queue`, and the net's `thread.idle` send below starts a run
// whose root turn AND first boundary drain both carry it: the nudge text appears twice
// (measured per-request nudge counts [0,0,2]). It is retained rather than anchor-forming, so it
// costs tokens and one duplicated instruction, not the retained head. Suppressing it needs a
// queue read/clear the plugin api does not expose (`api.threads` has neither), and skipping the
// idle send instead would strand a failed child whose answer nobody is awaiting — a duplicate
// nudge is the cheaper failure.
//
// KNOWN LIMITATION (T11/D4, ratified as accepted 2026-11-10): that nudge run has NO
// server-side turn record. The server's focused-submit path steers a thread it sees as
// 'running' and then looks for the turn that owns it, and a run the RUNTIME started
// (`src/server/sessions.ts` `steerIntoThread` → `owningTurnOf`, ~7156-7170) has none for a
// top-level thread — so a submit racing the nudge's first moments is refused with 409
// "Thread … is running but no recorded turn owns it; stop it before submitting". This is
// NOT a compaction invention: every runtime-driven run has that shape (a delegate's
// `threadSend` waking an idle conversation is the pre-existing one, documented at
// src/server/workers/lane-worker-correctness.test.ts ~160-172, where the test's own
// `waitAuthorityIdle` exists because a submit into that window is refused). It is a brief
// refusal the client re-sends, not a lost message — the nudge's own run queues and drains
// normally — and a server-level test of it would be a race (a gated plugin run racing an
// HTTP submit), so it stays a documented limitation rather than a timing-flaky case.
//
// WHY THE OTHER SHIPPED `turn.before` PASS (`context-trimmer`) IS SAFE IN THIS ROUND
// ----------------------------------------------------------------------------------
// The trimmer is registered AFTER this pass (src/plugin/manifest.ts:42-58) and hook
// dispatch is sequential in registration order (src/plugin/hooks.ts), so on a round where
// both fire, the trimmer runs INSIDE the window this pass opened. Two separate things
// about it had to be checked, and they have different answers:
//
//   1. ITS WRITERS (there are now TWO of them, and the pair is what used to be considered the
//      whole question) are compatible by construction: the trimmer mutates context through
//      exactly two controls, both inside `applyTrimPlan` in
//      src/plugins/context-trimmer.plugin.ts, and BOTH are called with the literal `false` —
//      `setIncluded(entry, false)` withholds one entry from the request (the first axis; the
//      runtime writes exactly the entry named, ../types
//      `HarnessTurnBeforeContext.setIncluded`) and
//      `setReasoningIncluded(entry, false)` withholds one assistant entry's THINKING from its
//      request copy (the second axis, uplift T6). Neither one re-ENABLES anything: `true` is
//      never passed anywhere in that plugin, so this pass never sees an entry or a thought come
//      BACK. There is no `setTranscript`, no `edit`, no `replaceHistory` and no `api.threads.*`
//      write anywhere in that plugin (the pause/resume wrapper is item 2 below). Anything they
//      withhold in this round rides along on the entries this pass commits back through
//      `replaceHistory`, and anything they withhold AFTER the finalize only makes the retained
//      head smaller. A pass that re-ENABLED entries would be the first thing needing a phase
//      check here.
//
//   2. ITS HANDLER WRAPPER is NOT compatible, and that is what context T11 (D1) fixed.
//      On a round with candidates the trimmer runs `await context.pause(); try { writer }
//      finally { await context.resume(); }` around a flag write; the wrapper is
//      `createContextTrimmerHandler` in src/plugins/context-trimmer.plugin.ts. Before T11 that
//      `resume()` lifted ANY 'paused' record — including the park THIS pass took moments earlier
//      on the same boundary — so the trigger turn lost its observable paused-during-compaction
//      window and the `thread.paused`/`thread.resumed` pair an operator watches became `paused`
//      + `resumed` + `resumed`, on a turn where the compaction was still outstanding.
//
// THE RULE THAT MAKES IT SAFE: parks are OWNED. `context.pause()` attributes the park to
// the plugin whose payload it came from, and `context.resume()` lifts only a park that
// same plugin holds (src/harness.ts `pauseThreadState`/`resumeThreadState`). The trimmer's
// wrapper therefore pauses as a no-op on top of this pass's park (no ownership transfer)
// and its `finally` declines to lift it — the park survives the round and goes away only
// through this pass's own unpark (`turn.after` / the run-terminal nets, both via
// `api.threads.resume`, which is deliberately OWNERLESS and still lifts anything, so a
// stranded park can always be freed). No phase check in the trimmer is needed for this,
// and none was added: the ordering stops mattering, which is a better guarantee than the
// one a phase check would buy.
//
// WHY PAUSE/RESUME AROUND THE ACTION
// ----------------------------------
// Compaction is slow (an LLM call) and rewrites the conversation, so the roster a host
// reads should say 'paused' while it happens — the same signal the UI acts on. `resume()`
// is in a `finally`: a compaction that threw must not strand the conversation in
// 'paused'. The error itself is deliberately NOT swallowed here — the hook bus is
// already the single fail-open authority (plugin/hooks.ts rule 2), so the plugin decides
// only about the thread's state and leaves the run's decision to the framework.
//
// WHY THE FAST PATH IS SYNCHRONOUS (no `async` keyword on the handler)
// -------------------------------------------------------------------
// The bus runs `await handler(payload)`. A plain function that returns `undefined` costs
// ONE microtask; an `async` function adds its own promise on top of that await. Nearly
// every turn is under the limit, and the harness interleaves a delegated child's event
// frames with its parent's on exactly those boundaries (plugin/hooks.ts rule 5: the
// reason every emit site is guarded by `has()`), so the path that runs most often is
// written to yield as little as the contract allows. Only a real trigger returns a
// promise, and that is the turn where the delay is the whole point.
//
// WHY THE HANDLERS LIVE IN ONE FACTORY (`createContextCompactionPasses`)
// ---------------------------------------------------------------------
// `setup` stays a five-line wiring function, and the per-thread cooldown map, the phase
// map and the action become injectable: a test (or a host that swaps the action but wants
// the same lifecycle) builds the same guard with its own action without re-implementing
// the rules. The shipped plugin always uses `executeCompaction`. `createContextCompaction
// Handler` remains as the single-hook spelling, because that is the shape a host reusing
// the `exclude` pass already had.
//
// WHY THE COOLDOWN MAP IS NEVER PRUNED
// -----------------------------------
// One number per conversation that crossed the limit, cleared on the next under-limit
// turn. One case leaves a stale entry behind, bounded and harmless:
//   - a thread deleted while still over the limit (so the map is bounded by the number of
//     threads a harness ever had).
//
// A BRANCH run used to be a second case: it reports its scheduling actor key `branch:<id>`
// as `threadId` (src/harness.ts `emitTurnBefore`), so every fork of an over-limit
// conversation added a key nothing could ever clear. It is not one any more — the guard
// refuses to trigger on `context.branchId` (see "WHY A BRANCH ROUND IS SKIPPED ENTIRELY"),
// which is also why its documented no-op `pause()`/`resume()` are no longer paid for.
// Neither case is worth a `thread.deleted` subscription, which would also make the live hook
// surface disagree with the declared `metadata.hooks` (the server reports the declared
// list to the UI).
//
// STATE
// -----
// The plugin is per-harness: `setup` runs once, so the cooldown map and the phase map die
// with the harness. Neither is persisted — a restarted process re-triggers on the next
// crossing, which is correct because the context limit is a runtime fact, not durable
// state. What IS durable is what a finished pass wrote: the withheld flags, the committed
// instruction and its summary are ordinary canonical transcript entries, so a restart
// resumes on the compacted context (pinned by the snapshot/restore case in
// src/plugin/context-compaction.test.ts).
//
// Cross-references:
//   - ../core/context-pruning.ts    — THE POLICY (`planContextPruning`), pure and table-tested
//   - ../core/argument-fingerprint.ts — the work identity the policy matches on
//   - ../core/tool-outcome.ts       — the persisted `outcome` it reads (absent ⇒ completed)
//   - ../core/context-estimate.ts   — the estimator feeding `estimatedTokens`: ~4 chars/token
//                                     for the text, anchored on the provider's reported
//                                     `usage.input` for the prefix as soon as a request
//                                     reports it (T5.4). Also the `minTokens` floor's measure.
//   - ../harness.ts                 — the `turn.before` emission (requestTurn → emitTurnBefore),
//                                     the pause/resume implementations (pauseThreadState),
//                                     `setIncluded` (the flag write) and the coalesced
//                                     per-round `agent_message` report (closeRoundObservations);
//                                     also `turn.after` (post-commit, ~9488), `run.finished` /
//                                     `run.failed` (~10171/~10184), the failure rollback
//                                     (~9677) that un-commits a compaction whose run failed,
//                                     and `thread.idle` (~10227), which fires ONLY on a real
//                                     transition to idle — the reason the summarize flow
//                                     un-parks at `turn.after` instead of at the finalize
//   - ../types (`HarnessPluginApi.threads`) — the T8 park/unpark pair the summarize flow drives
//                                     from OUTSIDE a hook (`pause`/`resume`), plus
//                                     `messages`/`replaceMessages` (the idle-path rewrite,
//                                     refused while a run is attached), `send` (the
//                                     continuation nudge) and `setContextLane`/
//                                     `getContextLane` (the display-lane pair above, whose
//                                     implementation is `setThreadContextLane` in
//                                     ../harness.ts and whose consumers are
//                                     ../server/sessions.ts `contextLaneOf` and
//                                     ../server/turn-projector.ts `laneOfEvent`)
//   - ../plugin/hooks.ts            — sequential, fail-open dispatch of hook handlers
//   - ../plugin/host.ts             — how this built-in is applied (and replaced by a host),
//                                     and where `api.report.diagnostic` gets its `owner`
//   - ../core/agent.ts              — `registerAgentThreader` / the thread model sync that
//                                     make `api.agents[context.agent].model()` the model THIS
//                                     run is about to send
//   - ../transport/models.ts        — checked as a possible source of a model's context
//                                     WINDOW: `listModels` returns `string[]` and drops every
//                                     other field the provider catalogue carries (`id` only,
//                                     :147-176), so there is no per-model context length in
//                                     reach today. Widening it means changing the return
//                                     shape its HTTP caller and the wire protocol consume
//                                     (src/server/handler.ts, src/server/protocol.ts), which
//                                     is why `modelLimits[...].window` is the ONLY window
//                                     source in this build.
//   - ../plugin/manifest.ts         — GENERATED wiring: this file is auto-discovered
// The policy itself, as a pure function (../core/context-pruning.ts). Imported from the
// module, not from the barrel: this file is auto-discovered by the manifest scanner and
// stays a leaf that depends on nothing but core + types.
import { planContextPruning } from '../core/context-pruning';
// The same estimator the harness, the UI context bar and the `maxPromptTokens` floor use
// (../core/context-estimate.ts), imported for ONE job: measuring a SHRUNK compaction request
// before sending it. The trigger itself keeps comparing the harness's own
// `estimatedTokens`/`currentEstimatedTokens()` — one number, one meaning, everywhere — and
// only the shrink plan asks for the conservative, attachment-aware figure (see
// `planCompactionRequest`).
import { estimateContextTokens } from '../core/context-estimate';
// (T3, the lone-surrogate defect) The pair-safe clip. `../util` is a LEAF below core
// (`util/index.ts` imports nothing), so this adds no dependency above "core + types" and
// no cycle: the same helper the transport's send path and every other clip site use, so
// one pairing rule governs every cut in the package.
import { clipPrefix } from '../util';
import type {
    Agent,
    HarnessLifecycleHandler,
    HarnessMessage,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata,
    HarnessTurnBeforeContext
} from '../types';

// A static literal: scripts/generate-plugin-manifest.mjs refuses a `metadata` export
// that is not written as an object literal, because the manifest has to describe this
// plugin without executing it.
export const metadata = {
    name: 'context-compaction',
    title: 'Context Compaction',
    description: 'Compacts the thread context when the conversation reaches a configured token threshold.',
    // The prompt this plugin sends, shown read-only in the plugin details panel
    // (2026-11-12: the operator wants to SEE the system prompt, not infer it).
    // The text is written TWICE because `metadata` is a plain object literal and
    // `COMPACTION_INSTRUCTION` is declared AFTER it, so a reference here would read a
    // temporal dead zone. src/plugin/context-compaction.test.ts pins the two copies as
    // byte-identical, so a reword that moves only one of them fails a test.
    systemPrompt: `[context compaction] Automated system prompt (not from the user): your context window has reached its limit. Compact your knowledge now. Reply with one structured summary and nothing else, using these headings (omit any that does not apply):
## Objective
- [one or two sentences on what you are trying to accomplish]
## Requirements
- [constraints, preferences and scope the user stated, or "(none)"]
## Decisions
- [decisions made and why, or "(none)"]
## Work State
### Completed
- [goals completed that still matter to the current or pending work; otherwise "(none)"]
### Active
- [what you are working on right now and exactly where you left off, with the details needed to resume; otherwise "(none)"]
### Blocked
- [what is blocking progress, and why; otherwise "(none)"]
## Next Move
1. [ordered next actions, or "(none)"]
## Relevant Files
- [at most 15 paths, most important first, each with a brief reason; or "(none)"]
## Important Context
- [facts you cannot recover from the code or the files listed; or "(none)"]
Keep each section terse: single-line bullets, not prose. Preserve exact file paths, symbols, commands, error strings, URLs and identifiers. Carry forward only unanswered questions or work still requiring action, in the user's own words. Preserve consequential workflow state: uncommitted, committed, pushed, under review, merged. Summarize only what the user and you said and did — leave out instruction files such as AGENTS.md, repository conventions and environment details: the next turn gets current versions of those. This summary will be your only retained memory of the earlier conversation: be specific but compact. Do not call tools and do not start any other work in this reply.`,
    version: '1.0.0',
    tags: ['context', 'compaction', 'lifecycle'],
    builtin: true,
    // The summarize machine spans one run: `turn.before` starts it (trigger, and the lazy
    // finalize when the run kept going), `turn.after` recognises the summary, `thread.idle`
    // finalizes when the run ended on it, and the two run-terminal hooks are the safety net
    // that never leaves a thread parked. See "THE PHASE MAP" in the header memo.
    hooks: ['turn.before', 'turn.after', 'thread.idle', 'run.finished', 'run.failed'],
    settings: [
        {
            key: 'contextLimit',
            label: 'Context limit (tokens)',
            type: 'number',
            default: 200000,
            min: 1000,
            step: 1000
        },
        {
            key: 'modelLimits',
            label: 'Per-model limits (JSON)',
            type: 'string',
            default: '{}'
        },
        // THE HEADROOM ROW (2026-11-17, declared 2026-11-17 by T4). Filed directly under
        // `modelLimits` because it is meaningless without it: the buffer only ever comes off a
        // ceiling that a DECLARED MODEL WINDOW makes binding (see `resolveContextHeadroom`), so
        // the row an operator reads is "how much of the window above do I keep free". `max: 0.5`
        // is not a UI preference — it is the plugin's own `HEADROOM_MAX_RATIO` rule stated at the
        // write edge, where a refusal is actionable: a larger ratio could only ever be clamped to
        // half the window, and a value the runtime cannot express is a value the pane should not
        // accept. `0` is legal and is the documented opt-out (fire exactly at the limit).
        //
        // No `description`, in line with the 2026-11-12 settings-pane ruling this plugin's other
        // five rows follow (`src/plugin/context-compaction.test.ts` pins that no compaction
        // descriptor carries a paragraph); the label carries the UNIT, and the decision it encodes
        // stays pinned as behaviour in that same file.
        {
            key: 'headroomRatio',
            label: 'Headroom before a declared window (ratio)',
            type: 'number',
            default: 0.15,
            min: 0,
            max: 0.5,
            step: 0.01
        },
        {
            key: 'enabled',
            label: 'Compact conversations',
            type: 'boolean',
            default: true
        },
        {
            key: 'minTokens',
            label: 'Minimum saving per pass (tokens)',
            type: 'number',
            default: 200,
            min: 0,
            step: 50
        },
        {
            key: 'safetyTurns',
            label: 'Recent units to protect',
            type: 'number',
            default: 6,
            min: 0,
            step: 1
        },
        {
            key: 'mode',
            label: 'Compaction mode',
            type: 'string',
            default: 'summarize'
        }
    ]
} satisfies HarnessPluginMetadata;

// Fallback when the host stores nothing for `contextLimit`. It has to equal
// `metadata.settings[0].default` (200000): the metadata must stay a plain object literal
// for the manifest scanner, so the number is written twice and BOTH places move together.
// The fallback only matters for a host plugin that reuses the guard without declaring the
// setting, because a declared default always outranks this argument (plugin/settings.ts
// `resolve`: stored value -> declared default -> argument fallback).
const CONTEXT_LIMIT_DEFAULT = 200000;

// The same duplication rule for the policy settings the descriptors above declare: each
// constant here is the `default:` of the descriptor above it, written out because the
// scanner cannot read a computed literal. `MIN_TOKENS_DEFAULT`/`SAFETY_TURNS_DEFAULT` are
// reasoned from the estimator (~4 chars/token), so 200 tokens is roughly one medium tool
// result — enough to beat the cache cost of touching the middle of a conversation, small
// enough that a real prune is never refused. `SAFETY_TURNS_DEFAULT` is 6 units because a
// unit is coarse: that is roughly a failure, its retry, the retry's answer and the turn
// after, which is exactly the window the retry-loop evidence says must stay visible.
const ENABLED_DEFAULT = true;
const MIN_TOKENS_DEFAULT = 200;
const SAFETY_TURNS_DEFAULT = 6;

// The two writers. `MODE_SUMMARIZE` is the declared default (the 2026-11-10 ruling);
// `MODE_EXCLUDE` is R3's pruning pass and stays byte-for-byte what it was, for an operator
// who wants the cheap flow or a host that reuses `executeCompaction` directly.
const MODE_SUMMARIZE = 'summarize';
const MODE_EXCLUDE = 'exclude';
const MODE_DEFAULT = MODE_SUMMARIZE;

// R4's remaining trigger setting, duplicated from its descriptor by the same rule.
// An empty map: no per-model knowledge, so every model uses the global ceiling. A JSON
// string rather than one setting per model, because the model ids are the operator's, not
// this build's, and a declared setting list cannot enumerate them.
const MODEL_LIMITS_DEFAULT = '{}';

// Every `mode` value this build implements. `annotate` is deliberately NOT listed: an
// operator who stores it today gets `exclude` (the candidate list is already computed
// before any write, which is the seam T0 Q1 asked to keep), and the pass diagnostic reports
// both the value stored and the value used. Exported so a future writer and the UI extend
// ONE list rather than re-spelling the union. Order is the UI's: the default first.
export const COMPACTION_MODES: readonly string[] = [MODE_SUMMARIZE, MODE_EXCLUDE];

// ---------------------------------------------------------------------------
// THE SUMMARIZE SCRIPT — the three strings that ARE the protocol
// ---------------------------------------------------------------------------
//
// All three are exported and their FIRST LINE is the detection anchor: the finalize step
// finds its own instruction by scanning for `COMPACTION_MARKER` at the start of a user
// entry, so the marker must stay byte-stable even if the body is reworded. It is also the
// only thing telling the model (and a human reading the transcript) that this "user" turn
// is plumbing rather than something a person typed — the role has to be `user`, because
// the instruction arrives at a boundary where a `system` entry mid-transcript would be a
// shape the transports are not promised (types/index.ts, `HarnessMessage`).
//
// EXPORTED (T6, 2026-11-17, D-1). The harness kernel has to recognise this plumbing for one
// decision that is NOT compaction policy: the answer a DELEGATED run hands back to its spawner
// must be the task answer, never a compaction turn's reply. Rather than have `src/harness.ts`
// re-paste the marker (a second spelling of an identity is how two files drift), the kernel
// imports the predicates built on it — `isCompactionAnswerTurn` below — so this module stays
// the single owner of the protocol strings. The import is one-directional (this plugin imports
// only `../core` and `../types`), and `src/plugin/manifest.ts` already pulls this module into
// the harness graph, so no cycle and no new dependency appears.
export const COMPACTION_MARKER = '[context compaction]';

// The instruction the plugin commits into the transcript at the trigger. Since 2026-11-12 it
// asks for the OpenCode checkpoint shape (adopted from OpenCode v2.2.5's compaction prompt,
// read out of the shipped binary — its docs never print the text): objective, requirements,
// decisions, work state split into completed / active / blocked, an ordered next move, the
// files the next turn would have to open, and the context a fresh read cannot recover. The
// old three-item list (DONE / CURRENT TASK / PENDING) is what left the constraints, decisions
// and blockers out — the open risk the T7 list still carries (docs/tasks/2026-11-09-
// progressive-compaction.md). The trailing rules are the shape OpenCode pins that summary
// with: terse single-line bullets, verbatim identifiers, only the questions still unanswered,
// the git/workflow state that changes what an agent does next, and NOTHING about the
// instruction files and environment the next turn receives fresh anyway. The tool ban is the
// agent's own guard rail: a compaction that stops to read a file spends another turn and
// re-enters the phase machine for nothing (still handled, see `turn.after`, but the summary is
// what this turn was for).
// Exported (not a private constant) because the finalize range and every test that names
// the committed turn need the exact text, not a copy that can drift from it.
export const COMPACTION_INSTRUCTION = `${COMPACTION_MARKER} Automated system prompt (not from the user): your context window has reached its limit. Compact your knowledge now. Reply with one structured summary and nothing else, using these headings (omit any that does not apply):
## Objective
- [one or two sentences on what you are trying to accomplish]
## Requirements
- [constraints, preferences and scope the user stated, or "(none)"]
## Decisions
- [decisions made and why, or "(none)"]
## Work State
### Completed
- [goals completed that still matter to the current or pending work; otherwise "(none)"]
### Active
- [what you are working on right now and exactly where you left off, with the details needed to resume; otherwise "(none)"]
### Blocked
- [what is blocking progress, and why; otherwise "(none)"]
## Next Move
1. [ordered next actions, or "(none)"]
## Relevant Files
- [at most 15 paths, most important first, each with a brief reason; or "(none)"]
## Important Context
- [facts you cannot recover from the code or the files listed; or "(none)"]
Keep each section terse: single-line bullets, not prose. Preserve exact file paths, symbols, commands, error strings, URLs and identifiers. Carry forward only unanswered questions or work still requiring action, in the user's own words. Preserve consequential workflow state: uncommitted, committed, pushed, under review, merged. Summarize only what the user and you said and did — leave out instruction files such as AGENTS.md, repository conventions and environment details: the next turn gets current versions of those. This summary will be your only retained memory of the earlier conversation: be specific but compact. Do not call tools and do not start any other work in this reply.`;

// The turn that restarts the conversation once the range is disabled. It points at the
// summary as the source of the next step, because after the finalize that is the ONLY
// memory of the work still standing — an imperative with no anchor reads as a new task.
// The three things it names are the headings the instruction above writes down, so a reword
// of one moves the other.
export const CONTINUATION_NUDGE = `${COMPACTION_MARKER} Your context was just compacted; your summary above states the objective, the active work and where you left off, and the next move. Continue your current task now.`;

// Not a setting (T4.6 declares exactly the four above, and a knob nobody asked for is a knob
// nobody reads): the bound on how many units ONE pass may disable, so the first pass over an
// old conversation cannot silently empty it (T4.3). Oldest eligible units are taken first, so
// the bound also decides WHAT survives: the recent tail, and one cache invalidation instead
// of a rolling series of them.
const MAX_UNITS_PER_PASS = 8;

// Re-trigger margin, as a fraction of the EFFECTIVE limit (see `resolveContextTrigger`).
// 5% is deliberately coarse: the estimate itself is the ~4 chars/token rule of thumb, so a
// margin measured in single tokens would just be noise from the estimator rather than real
// growth. The base is the resolved limit rather than the raw `contextLimit` setting: with no
// per-model entry and no window the two are the same number, so today's behaviour is
// unchanged, and with them the margin stays a fraction of the size the conversation is
// actually being held to (5% of a 512000 ceiling would never re-fire inside a 262144 window).
const REGROWTH_RATIO = 0.05;

// ---------------------------------------------------------------------------
// THE HEADROOM BUFFER, THE OVERFLOW CODE, AND THE SHRINK LADDER (2026-11-17)
// ---------------------------------------------------------------------------
//
// WHY A BUFFER EXISTS AT ALL (the bug this removes). The trigger used to fire at the
// ceiling ITSELF, so the request that carried the compaction instruction was the whole
// transcript PLUS the ~430-token instruction — a request strictly larger than the one the
// agent's own `maxPromptTokens` / `provider.contextWindow` floor (../core/agent.ts:1066-1090)
// or the provider had just refused. The pass that was supposed to relieve the pressure was
// therefore the first thing refused, and the re-trigger memory below muted the retry. The
// buffer moves the firing point BELOW the hard reject point, by enough that the instruction
// and one more turn still fit.
//
// WHY THE BUFFER IS KEYED ON THE BINDING CEILING — INCLUDING A BARE `contextLimit` (X2, F3).
// `modelLimits[model].window` is a FACT ABOUT THE MODEL — the point past which the provider
// answers 400. `contextLimit` and `modelLimits[model].limit` are OPERATOR CHOICES, and the
// original rule therefore ran the buffer off the window ONLY, on the grounds that an operator
// who sets 100000 on a 1-M token model is budgeting rather than reporting a hard limit and
// "fire 15% before my budget" moves a number they set deliberately and read directly.
//
// That reasoning is what the measured failure disproved. The session that died
// (`Temp/d1`, reproduced by the reviewer's probes in `Temp/review-v2/`) declares NO model
// window at all, so with a bare `contextLimit` its trigger was the ceiling EXACTLY: the first
// crossing WAS the refusal, and prevention depended on the estimate happening to cross the
// limit before the provider's true count did — which it did not (the estimate read 193,428 for
// a request billed 225,612). Zero headroom on the one deployment shape that has no model fact
// to lean on is the whole bug, so the SAME formula now runs over EVERY binding ceiling: same
// `headroomRatio`, same `min(max(HEADROOM_MIN_TOKENS, ratio·ceiling), floor(ceiling/2))` shape,
// same caps. The declared-window rows are unchanged byte for byte (the formula never moved);
// what moved is that an operator who sets only `contextLimit` now compacts EARLIER, which is
// the intended prevention. The two anti-futility brakes stay exactly where they were: the
// `minTokens` floor refuses a pass whose saving is smaller than a round trip, and the dead-run
// guard below refuses a pass whose request floor already exceeds the ceiling — a small
// `contextLimit` dominated by the tool catalogue fires nothing at all rather than burning a
// model turn per turn (see `HEADROOM_MAX_RATIO` for why the 50% cap is what makes a small
// ceiling survivable).
//
// Like every other default in this file, the number is written TWICE: once as the
// `metadata.settings` row the Plugins pane renders and the store seeds (row 3, `headroomRatio`),
// and once here as the argument fallback a host that reuses the guard without declaring the row
// reads. The scanner cannot read a computed literal, so BOTH places move together —
// src/plugin/manifest.test.ts and src/plugin/context-compaction.test.ts pin the row, and the
// buffer table pins this number's behaviour.
const HEADROOM_RATIO_DEFAULT = 0.15;

// The floor of the buffer: a summary, the continuation nudge, one fresh turn and the estimate's
// own error. Below this, "headroom" is a rounding artifact rather than working room, which is
// why a 4k-token model gets a proportionally larger slice (the cap below bounds it).
const HEADROOM_MIN_TOKENS = 16000;

// The ceiling of the buffer, as a fraction of the binding ceiling: a buffer may never eat more
// than half of the window it guards. Without it, a small declared window (a test fixture, a
// 8k model, the 100-token ceilings every lifecycle case in the test file uses) would collapse
// to `max(1, window - 16000) = 1` and compact on every turn — the buffer would become the bug.
const HEADROOM_MAX_RATIO = 0.5;

// The machine code the transport puts on a size refusal (`transport/openai.ts`
// `CONTEXT_OVERFLOW_CODE`, re-exported and published from the package root) and the
// `core/agent.ts` pre-request floor reuses for a transcript it refuses to send at all. It is
// spelled HERE, as a literal, on purpose: this plugin is a leaf (the manifest scanner
// discovers it and it depends on nothing but ../core and ../types), and importing the
// transport for one string would break that rule for a constant that has been stable since
// issue 0004. `src/plugin/context-compaction.test.ts` pins the two spellings agree.
const CONTEXT_OVERFLOW_CODE = 'context-overflow';

// The shrink ladder: each rung is the fraction of the REMOVABLE transcript (the boundary figure
// minus the request's irreducible floor — see `rungBudget` in `turnBefore`) a summarize request is
// cut to, in the order the rungs are tried. The floor is added back unchanged, because the
// transcript pass cannot cut it and scaling across it used to charge the transcript for a fraction
// of the tool catalogue (R6, 2026-11-17). Four rungs, each decisively smaller (0.85 → 0.35),
// because the point of a rung is that the provider CANNOT refuse it for the same reason as the
// rung above; after four refusals the problem is not the transcript (huge tool schemas, a tiny
// configured window, a provider counting something else entirely) and the pass stops rather than
// spending one model turn per turn forever. Strictly decreasing, every value < 1, so a rung
// request is always smaller than the request that was refused.
const SHRINK_LADDER: readonly number[] = [0.85, 0.7, 0.5, 0.35];

// How many entries at the END of the request the shrink never touches. The last two are, on the
// shipped path, "the turn the model is answering" and "the compaction instruction" — the pair
// that makes the request the request. Snapping (see `shrinkUnitEnd`) keeps the entry BEFORE them
// pairable, so a result is never left without the call that asked for it.
const SHRINK_KEEP_TAIL = 2;

// Per-entry text budget once the shrink reaches pass A (see `planCompactionRequest`). 240
// characters is a deliberate blunt instrument: it keeps "what this turn was about" legible and
// throws the payload away, which is exactly the trade a size refusal forces. Measured against
// the ladder's targets (a 200k removable transcript at rung 0 is a 170k budget before the floor
// is added back — see `rungBudget`), it is the LAST lever to move before whole units go, not the
// first.
const SHRINK_CLIP_CHARS = 240;

// The digest entry the shrink prepends when it drops whole units (see
// `planCompactionRequest`). Its marker deliberately does NOT start with
// `COMPACTION_MARKER`: `[context compaction]` is the anchor `planCompactionRetention` scans the
// CANONICAL transcript for, and this entry is REQUEST-ONLY (it never reaches
// `replaceHistory`), so sharing the marker would put a second anchor in front of a finalize that
// is looking for exactly one.
const SHRINK_DIGEST_MARKER = '[context compaction digest]';

// Agents this plugin never compacts. `summarizer` is the delegated condenser the shipped
// profiles already use (src/agents/summarizer.ts) — i.e. the agent a future compactor is
// most likely to spawn for its summary.
const INTERNAL_AGENT_NAMES: readonly string[] = ['summarizer'];

// Name fragments treated as compaction plumbing rather than a user conversation, so a
// host that registers its own condenser as `summarize-notes` or `compact-worker` is
// skipped too without having to be listed above.
const INTERNAL_AGENT_MARKERS: readonly string[] = ['summariz', 'compact'];

// Reserved namespaces for plugin-created internal agents (`underload:compaction`). A
// display name is normally a plain identifier, so a prefix is an unambiguous opt-out.
const INTERNAL_AGENT_PREFIXES: readonly string[] = ['underload:', 'plugin:'];

// True when a turn belongs to compaction's own machinery and must not be compacted.
// The check is case-insensitive because agent names come from user configuration.
export const isInternalAgent = (agent: string): boolean => {
    const name = String(agent ?? '')
        .trim()
        .toLowerCase();

    if (name.length === 0) return false;

    if (INTERNAL_AGENT_NAMES.includes(name)) return true;
    if (INTERNAL_AGENT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;

    return INTERNAL_AGENT_MARKERS.some((marker) => name.includes(marker));
};

// ---------------------------------------------------------------------------
// THE TRIGGER MATH (R4) — pure, exported, and table-testable on its own
// ---------------------------------------------------------------------------

// One model's declared facts. Both halves are optional and mean different things: `limit`
// is an OPERATOR choice that replaces `contextLimit` for this model, `window` is a FACT
// about the model that caps whatever limit is in force. A model that declares only a window
// keeps the global ceiling and is merely capped by it; one that declares only a limit is not
// capped at all.
export type HarnessContextModelLimits = {
    limit?: number;
    window?: number;
};

// The full answer for one turn, kept together so a caller (or a diagnostic, later) can see
// WHY it fired: the resolved ceiling, the window that capped it when one was declared, and
// the effective limit — the one number `estimatedTokens` is compared against.
export type HarnessContextTrigger = {
    // `modelLimits[model].limit ?? contextLimit`.
    limit: number;
    // Present only when a usable window was declared for this model.
    window?: number;
    // max(1, floor(min(limit, window) when windowed, limit) − headroom) — the number
    // `estimatedTokens` is compared to. The headroom buffer (see `resolveContextHeadroom`) is
    // subtracted from EVERY binding ceiling, declared window or operator budget alike (X2, F3);
    // `headroomRatio: 0` is the only spelling that makes the trigger the ceiling exactly.
    effective: number;
};

// A positive, finite, whole token count — the only shape worth keeping from a hand-typed
// settings field. `NaN`, `Infinity`, `0`, `-1`, `"128000"` (a string, which the settings
// view has already coerced for a NUMBER field but not for the values inside this JSON
// document) and everything else non-numeric drop out, so one bad entry can only ever mean
// "this entry says nothing", never "compaction is broken".
const positiveTokens = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    // Providers state windows in whole tokens; a fractional stored value is a typo, and
    // flooring keeps every downstream comparison an integer comparison.
    return Math.floor(value);
};

// Parses the `modelLimits` setting into a validated map. NEVER throws: the value comes from
// a free-text settings field an operator edits, and a syntax error there must degrade to
// "no per-model knowledge" (the global limit) rather than fail every turn — the same
// fail-open shape `mode` already uses. A parsed JSON value that is not a plain object
// (an array, `null`, `"5"`) is the same nothing. Entries are keyed by the TRIMMED model id,
// because provider ids are case-sensitive and this is an exact lookup, not a match.
export const parseModelLimits = (raw: unknown): Record<string, HarnessContextModelLimits> => {
    if (typeof raw !== 'string') return {};

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Record<string, HarnessContextModelLimits> = {};

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const id = key.trim();
        if (id.length === 0) continue;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;

        const entry = value as Record<string, unknown>;
        const limit = positiveTokens(entry.limit);
        const window = positiveTokens(entry.window);

        // An entry that states neither is a no-op, so it is dropped rather than stored as
        // `{}` — which matters because `{}` is also "this model is known, with no facts",
        // and a map that says nothing must be indistinguishable from an absent key.
        if (limit === undefined && window === undefined) continue;

        result[id] = {
            ...(limit === undefined ? {} : { limit }),
            ...(window === undefined ? {} : { window })
        };
    }

    return result;
};

// The headroom buffer, split out so the table in the test file can pin every row (see the
// block "THE HEADROOM BUFFER…" above `HEADROOM_RATIO_DEFAULT` for what the buffer is for and
// for why it now guards EVERY binding ceiling). Total: every unusable input answers `0`, i.e.
// "fire at the ceiling", which is the behaviour this build had before the buffer existed and the
// behaviour `headroomRatio: 0` restores on purpose.
export const resolveContextHeadroom = (input: {
    // The BINDING ceiling — `min(limit, window)` when a window was declared, otherwise the
    // operator's resolved limit — already floored to a whole token count.
    ceiling: number;
    // Whether the binding number is a declared model window rather than an operator budget.
    // SINCE X2 (F3) this no longer decides APPLICABILITY: the buffer guards both. The field
    // stays because it is a published input and because a caller that knows which number bound
    // can say so; a caller that does not know simply omits it and gets the same buffer.
    windowed?: boolean;
    // The `headroomRatio` setting. `0` opts out and restores "fire exactly at the limit"; a
    // corrupt (non-finite) value opts out too, because a number this file cannot trust must
    // not silently move a threshold an operator reads off the context bar.
    ratio?: number;
    // The buffer floor, spelled out for the same reason as `ratio` — a table row names it.
    minTokens?: number;
}): number => {
    const ratio = input.ratio === undefined ? HEADROOM_RATIO_DEFAULT : input.ratio;

    if (!Number.isFinite(ratio) || ratio <= 0) return 0;

    const ceiling =
        Number.isFinite(input.ceiling) && input.ceiling > 1 ? Math.floor(input.ceiling) : 0;

    if (ceiling <= 1) return 0;

    const floor =
        input.minTokens !== undefined && Number.isFinite(input.minTokens) && input.minTokens >= 0
            ? Math.floor(input.minTokens)
            : HEADROOM_MIN_TOKENS;

    // The ratio wants at least `floor`; the window allows at most half of itself, and never
    // the whole of it (an effective limit of 0 would fire on an empty conversation). The
    // order matters: the floor is what makes a big window's buffer meaningful, the caps are
    // what keep a small window's buffer from becoming the new bug.
    const wanted = Math.max(floor, Math.floor(ceiling * ratio));
    const cap = Math.min(Math.floor(ceiling * HEADROOM_MAX_RATIO), ceiling - 1);

    return Math.max(0, Math.min(wanted, cap));
};

// Resolves the number this turn's estimate is compared against. See the header section
// "THE TRIGGER POINT — ONE NUMBER" for what each input means and for why an unknown model
// degrades to the global limit instead of guessing, and `resolveContextHeadroom` for the
// buffer that now sits below EVERY binding ceiling (X2, F3).
export const resolveContextTrigger = (input: {
    // The global `contextLimit` setting. The caller has already refused a non-finite or
    // non-positive value (Rule 1: the plugin is off), so this is a real ceiling.
    contextLimit: number;
    // The validated per-model map (see `parseModelLimits`).
    modelLimits: Record<string, HarnessContextModelLimits>;
    // The model this conversation is running, when it is known (see `currentModelId`).
    modelId?: string;
    // The `headroomRatio` setting, passed through to `resolveContextHeadroom`. Omitted is the
    // declared default; `0` is "no buffer", which is what every pre-buffer fixture seeds.
    headroomRatio?: number;
    // The buffer floor (see `resolveContextHeadroom`).
    headroomMinTokens?: number;
}): HarnessContextTrigger => {
    // An OWN-key lookup, not a bare index: a model id like `constructor` or `valueOf` would
    // otherwise hit the prototype chain and read as a usable-looking entry. `undefined` for a
    // name the map does not carry is the "no per-model facts" answer the rule expects.
    const entry =
        input.modelId !== undefined && Object.prototype.hasOwnProperty.call(input.modelLimits, input.modelId)
            ? input.modelLimits[input.modelId]
            : undefined;

    // `??` and not `||`: a resolved limit of 0 cannot occur (the parser refuses it), but a
    // missing key must fall through to the global value rather than to 0.
    const limit = entry?.limit ?? input.contextLimit;
    const window = entry?.window;

    // The window CAPS the ceiling; it never raises it. A model that declares a 512k ceiling
    // and a 256k window compacts at the window, which is the whole point of the example in
    // the operator's request.
    const resolved = window === undefined ? limit : Math.min(limit, window);

    // Whether the BINDING number is the model fact or the operator's budget — the one question
    // `resolveContextHeadroom` asks. `<=` and not `<`: when the two agree, the window is what
    // stops the request, so the buffer belongs to it. The caller can re-derive this from the
    // `limit`/`window` this returns, which is why the answer is not a field of its own.
    const windowed = window !== undefined && window <= limit;

    // The firing point is the ceiling MINUS the headroom buffer (0 unless a window binds — see
    // `resolveContextHeadroom` for the rule and for why the buffer exists). `max(1, ...)` is the
    // only clamp: a ceiling so small it floors below one token (the test-suite's limit of
    // 100 is fine, but a host that stores 0.5 is not refused by Rule 1) fires at 1 token
    // rather than never. Flooring keeps the trigger an integer token count, matching the
    // estimate.
    const headroom = resolveContextHeadroom({
        ceiling: Math.floor(resolved),
        windowed,
        ...(input.headroomRatio === undefined ? {} : { ratio: input.headroomRatio }),
        ...(input.headroomMinTokens === undefined ? {} : { minTokens: input.headroomMinTokens })
    });

    const effective = Math.max(1, Math.floor(resolved) - headroom);

    return {
        limit,
        ...(window === undefined ? {} : { window }),
        effective
    };
};

// The model id of the conversation a turn belongs to, or `undefined` for "unknown".
//
// The lookup goes through the plugin api's live agent registry — the same registry the
// harness hands every plugin (src/harness.ts `pluginApiBase: { agents, ... }`) — keyed by
// `context.agent`, which is `brain.name`, and the harness overwrites that with the registry
// key when an agent is registered (../types `Agent.name`). A host-thread round reports the
// OWNING agent's name (core/agent.ts `registerAgentThreader` seeds the thread with
// `name: self.name`), and the runtime syncs a thread to the owning agent's CURRENT model at
// run start (core/agent.ts:1019-1024), so the registry brain's `model()` is the model this
// run is about to send.
//
// Everything about it is defensive, because the trigger must never be the thing that breaks
// a turn: a plugin api without an `agents` view, an unregistered name, a host stub whose
// `model` is not the accessor, and an accessor that throws all land on `undefined`, i.e.
// "no per-model facts". A wrong-but-resolvable id is not a hazard: an id nobody declared in
// `modelLimits` simply misses the map and takes the global limit.
const currentModelId = (api: HarnessPluginApi, agent: string): string | undefined => {
    try {
        const registry = api.agents as Record<string, Agent> | undefined;

        if (registry === undefined) return undefined;

        const brain = registry[agent];

        if (brain === undefined || typeof brain.model !== 'function') return undefined;

        const value: unknown = brain.model();

        return typeof value === 'string' && value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
};

// The compaction action's shape: the harness control surface plus the parked turn. It is
// the same signature a tool function has, which is the point — "a plugin can trigger
// anything within the server" means the action gets the api, not a curated subset.
export type HarnessCompactionAction = (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
) => Promise<void>;

// THE ACTION — the writer, not the decision (see "THE POLICY LIVES ELSEWHERE ON PURPOSE"
// above). Three steps, in this order, each of which is a guard against a specific failure:
//
//   1. read the settings (re-read every pass, because `api.settings` is live by contract),
//   2. compute the WHOLE candidate list against `context.entries` — the canonical transcript
//      including disabled entries — and write only if it clears `minTokens`,
//   3. report what happened on the diagnostic channel.
//
// Writing NOTHING is the common case and it is free: no flag write means no
// `agent_message` notification, which means no whole-document save (T4.4).
//
// Every write goes through `context.setIncluded(entry, false)`, and since R8 that call moves
// EXACTLY ONE canonical entry — so this action writes every member of the unit the plan named
// (`PruneCandidate.members`: the assistant message that asked for the calls, then every result
// answering one of them, leader first). With both halves flagged, the projection has nothing
// left to emit for the unit: no half-answered `tool_calls[]` and no orphan result (T3.4), and
// the projection oracle in src/harness.inclusion.test.ts is what pins it. A pass that wrote
// only the leader would withhold the request and keep the failed answer riding — a saving the
// diagnostic would claim and the request would not deliver.
//
// THE WRITE SET IS PER MEMBER, AND THE TRIMMER MAKES THAT LOAD-BEARING (2026-11-13 review)
// ----------------------------------------------------------------------------------------
// The write set is the unit's members MINUS the ones already withheld, so this writer can never
// undo another plugin's flag. That matters now that the context trimmer has its truncate axis: it
// withholds a tool unit's REQUEST entry only and deliberately leaves the tool RESULTS in the
// request (src/plugins/context-trimmer.plugin.ts `planTruncatedRequests`, whose `members` is one
// entry deep). The result is a HALF-withheld unit — and a half-withheld unit is still compaction's
// business, because the failed answer is still riding and still costs tokens. The plan therefore
// tests idempotence per member, not per unit (../core/context-pruning.ts `includedMembersOf`), and
// names only the surviving entries here; the reported `tokens` are measured over that same set, so
// the diagnostic cannot claim a saving the request does not show. A unit whose EVERY member is
// already withheld is still skipped, so a second pass over an unchanged transcript keeps writing
// nothing at all (T4.3/T4.4).
//
// An implementation that later calls `replaceHistory()` must re-state the newest turn:
// `replaceHistory` replaces the WHOLE committed transcript, including the prompt this run
// just appended (src/harness.plugin.test.ts pins that behaviour). That is T6's problem, and
// this stage deliberately stays inside `setIncluded`.
export async function executeCompaction(
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
): Promise<void> {
    // A branch round prunes nothing (see the header): the flag would land on a transcript
    // that is about to be incorporated as text, and the owner re-derives the same decision on
    // its own round. Checked here as well as in the guard because a host may call this action
    // directly — the guard's skip is a trigger policy, this one is a correctness rule.
    if (context.branchId !== undefined) return;

    // Rule 0, re-read per pass like every other setting.
    if (!api.settings.boolean('enabled', ENABLED_DEFAULT)) return;

    const minTokens = api.settings.number('minTokens', MIN_TOKENS_DEFAULT);
    const safetyTurns = api.settings.number('safetyTurns', SAFETY_TURNS_DEFAULT);
    const requestedMode = api.settings.string('mode', MODE_DEFAULT);

    // `annotate` is accepted by the UI and not implemented, so it degrades to the one writer
    // that exists rather than failing the turn. Both values are reported below, so the
    // fallback is never invisible to the operator who set it. The fallback is `exclude` and
    // NOT `MODE_DEFAULT`: this function IS the exclude writer, and summarize has its own
    // machine (`createContextCompactionPasses`), so a mode this function cannot honour means
    // "run the pass I was called for" — reporting `summarize` here would claim a flow that
    // did not happen.
    const mode = COMPACTION_MODES.indexOf(requestedMode) === -1 || requestedMode === MODE_SUMMARIZE
        ? MODE_EXCLUDE
        : requestedMode;

    // ONE read of the canonical list. `entries` is built on first access and cached for this
    // handler, and the entry objects stay valid across flag writes (only a `replaceHistory()`
    // invalidates them), so the writes below address exactly what the plan matched.
    const entries = context.entries;

    const plan = planContextPruning(entries, {
        safetyUnits: safetyTurns,
        maxUnits: MAX_UNITS_PER_PASS,
        minTokens
    });

    if (plan.candidates.length === 0) {
        // The one case worth a line even though nothing changed: units WERE superseded, but
        // the saving did not clear the floor. Without it, "compaction is doing nothing" and
        // "compaction is refusing a 60-token prune" look identical from outside (T4.7's whole
        // point), and an operator raising `contextLimit` would be chasing the wrong knob.
        if (plan.belowFloor) {
            api.report.diagnostic({
                message:
                    `context-compaction considered ${plan.consideredUnits} unit(s) and withheld nothing: ` +
                    `~${plan.withheldTokens} estimated tokens is under the ${minTokens} minTokens floor.`,
                data: { mode, minTokens, withheldTokens: plan.withheldTokens, consideredUnits: plan.consideredUnits }
            });
        }

        return;
    }

    const units = plan.candidates.map((candidate) => ({
        index: candidate.leaderIndex,
        ...(candidate.leaderMessageId === undefined
            ? {}
            : { messageId: candidate.leaderMessageId }),
        outcomes: candidate.outcomes,
        tokens: candidate.tokens,
        // WHAT ANSWERED IT (T4.5). The superseding unit's stable address when it has one, so
        // the operator can go read the retry; the transcript index otherwise. Naming only the
        // pruned unit would leave "and therefore what?" unanswered, which is the failure mode
        // the changelog history in F5 is about.
        supersededBy: candidate.resolverMessageId ?? `index:${candidate.resolverIndex}`
    }));

    for (const candidate of plan.candidates) {
        // EVERY STILL-SENT MEMBER, not just the leader (R8). `setIncluded` writes exactly one
        // canonical entry, so a prune that stopped at the leader would leave the failed RESULT
        // riding in every later request — compaction would report a saving it did not make. The
        // member list is the plan's own WRITE SET, leader first, derived from the same grouping
        // the plan matched on (./core/context-pruning.ts `groupUnits`), and it already EXCLUDES
        // the entries another writer silenced: a unit whose REQUEST the context trimmer truncated
        // lists its surviving results only. That exclusion is what keeps the two plugins honest
        // about the same transcript — compaction prunes whole units, and it never puts back a
        // request the trimmer withheld.
        for (const memberIndex of candidate.members) {
            // Located by index rather than reused from the plan, so a `replaceHistory()` from a
            // LATER handler in this same round cannot make this write address a stale entry: if
            // the entry the plan named is no longer in the transcript, it is absent and the
            // write is skipped. (An entry from an EARLIER handler is still refused by
            // `setIncluded` itself; this is the mirror-image hazard.)
            const entry = entries.find((lookedUp) => lookedUp.index === memberIndex);

            if (entry === undefined) continue;
            // Belt and braces on the plan's write set: `false` is the only stored spelling of
            // "withheld", so writing it again would fire a persistence notification and a save
            // for a write that changes nothing (T4.4). A round's `entries` snapshot can only go
            // stale in the `true -> false` direction — nothing in this build re-enables an entry
            // — so skipping here can never leave a live entry in the request.
            if (entry.included === false) continue;

            context.setIncluded(entry, false);
        }
    }

    // T4.5 — the pass report. One line per pruned unit inside ONE diagnostic, because a
    // multi-unit pass is one logical decision and an operator reads it as such. The text is
    // self-contained on purpose: a host with no structured sink still learns what left the
    // context and what replaced it.
    api.report.diagnostic({
        message:
            `context-compaction withheld ${units.length} superseded tool unit(s), ` +
            `~${plan.withheldTokens} estimated tokens (mode ${mode}${
                requestedMode === mode ? '' : `, setting mode ${requestedMode}`
            }): ${units
                .map(
                    (unit) =>
                        `#${unit.index}${
                            'messageId' in unit ? ` ${String(unit.messageId)}` : ''
                        } [${unit.outcomes.join('/')}] answered by ${unit.supersededBy}`
                )
                .join('; ')}`,
        data: {
            mode,
            ...(requestedMode === mode ? {} : { requestedMode }),
            minTokens,
            safetyTurns,
            maxUnits: MAX_UNITS_PER_PASS,
            withheldTokens: plan.withheldTokens,
            consideredUnits: plan.consideredUnits,
            units
        }
    });
}

// ---------------------------------------------------------------------------
// THE SUMMARIZE RANGE — pure, exported, and table-testable without a harness
// ---------------------------------------------------------------------------

// Where one conversation's self-compaction stands. In memory only, per harness: like the
// cooldown map it dies with the process, and a restart does not need it — a compaction
// that was interrupted leaves at most a parked thread, which `run.failed`/`run.finished`
// and the next `turn.before` both recover from.
export type HarnessCompactionPhase = 'compacting' | 'finishing';

// The range a finalize writes, as indices into the list it was handed.
export type HarnessCompactionRetention = {
    // The committed instruction entry, or -1 when the list carries none (a rolled-back or
    // host-edited transcript — there is nothing to disable then).
    instructionIndex: number;
    // The compaction ANSWER — the last tool-free assistant entry after the instruction —
    // or -1 when the list stops before one.
    answerIndex: number;
    // Every entry to withhold: the history the summary replaced, and the intermediate
    // turns between the instruction and the answer. System entries and the instruction
    // itself are never in here.
    disabled: number[];
};

// True for the entry that IS the committed compaction instruction. Detection is by the
// marker prefix on a `user` entry, which is why the first line of the instruction is the
// protocol: rewording the body is safe, changing the marker is not.
const isInstructionMessage = (message: HarnessMessage): boolean =>
    message.role === 'user' &&
    String((message as { content?: unknown }).content ?? '').startsWith(COMPACTION_MARKER);

// True for the compaction answer. "Tool-free assistant turn" is the same test `turn.after`
// uses to recognise the summary, so the two cannot disagree about which turn ended the
// compaction — and the intermediate turns the model spent on tools are exactly the ones
// between the instruction and this entry.
const isAnswerMessage = (message: HarnessMessage): boolean =>
    message.role === 'assistant' &&
    !((message as { toolCalls?: unknown[] }).toolCalls?.length ?? 0);

// True for the entry that IS the continuation nudge. The nudge carries the SAME marker prefix
// as the instruction (both are built from `COMPACTION_MARKER`, :521/:539/:566, and
// src/plugin/context-compaction.test.ts:4393-4394 pins both prefixes), so a marker-prefix scan
// cannot tell the two apart — and the nudge is NOT an anchor: it is the entry that arrives AFTER
// the answer to restart the conversation, while the retained head is defined relative to the
// instruction THIS pass committed.
//
// WHY IT MATTERS (defect F1, found by review, not by the shipped suite). On the delegated
// in-run continuation `drainThreadQueue` appends the nudge to the transcript BEFORE the request
// is built (src/harness.ts:12669 -> :12671 -> `emitTurnBefore` :12182), so at the boundary that
// writes the range the LAST marker-prefixed `user` entry is the nudge, not the instruction.
// Anchoring there yields `answerIndex: -1` and disables every entry up to the nudge — this
// pass's instruction and its summary included — so the continuation turn would be asked with the
// nudge ALONE: the retained head is gone, inclusion flags are never re-enabled (durable), and the
// next pass compounds it. A host conversation never hits this because host guidance is not
// marker-prefixed, which is exactly the shape pinned at
// src/plugin/context-compaction.test.ts:2752-2756 and :3387-3391.
//
// EXACT equality rather than another prefix: the marker contract stays intact for everything
// else (a host's own shorter marker-prefixed instruction remains an anchor — pinned at
// src/plugin/context-compaction.test.ts:4652-4668, and `isInstructionMessage` above is
// unchanged), and the nudge is a constant this plugin writes VERBATIM — both the queue drain
// (src/harness.ts:12669) and the idle-path `send` (:1740) commit `CONTINUATION_NUDGE`
// byte-for-byte — so exactness cannot miss it. A nudge that sits BEFORE the current instruction
// is still ordinary superseded history: the exclusion is only from the anchor scan, never from
// the disable range.
const isContinuationNudge = (message: HarnessMessage): boolean =>
    message.role === 'user' &&
    String((message as { content?: unknown }).content ?? '') === CONTINUATION_NUDGE;

// True for the assistant entry at `index` that IS the reply to a compaction instruction — the
// "compaction ANSWER" `planCompactionRetention` names with `answerIndex`, judged from the
// transcript rather than from a hook payload, so a reader that only has entries can ask the
// question.
//
// WHY THE KERNEL NEEDS IT (T6, 2026-11-17, D-1). A delegated run's answer is chosen in
// `src/harness.ts` from the run's own assistant turns (`run.answer` recording, the blank-turn
// rescue `resolveRunAnswer`, and the `partialContent` scan `lastSubstantiveText`). A summarize
// pass puts a tool-free prose turn into exactly that lane, so the summary could be selected as
// the answer the spawner is handed — the defect this excludes. The kernel does not own the
// marker, so the test lives HERE, next to the strings it reads, and the kernel imports it.
//
// THE RULE, stated the way the retention rule states it:
//   - the entry must be a tool-free `assistant` turn (the same test `isAnswerMessage` uses, so
//     the two can never disagree about which turn ended a compaction);
//   - scanning backwards past the intermediate rounds a disobedient model spent on tools (an
//     `assistant` entry WITH calls and every `tool` entry answering calls), the nearest entry
//     that is neither must be a compaction INSTRUCTION — which is why the disable range
//     `[instruction, answer)` is described as it is at `planCompactionRetention`;
//   - a `CONTINUATION_NUDGE` does NOT qualify (the `isContinuationNudge` exclusion above, and
//     for the same reason): it shares the marker, and the turn that answers it is the model
//     getting back to its TASK, which is precisely the answer D-1 wants to keep.
//   - anything else (a host message, a `system` entry, the start of the transcript) stops the
//     scan and answers `false`, so an ordinary final answer that merely FOLLOWS a compacted
//     stretch is never mistaken for plumbing.
//
// The scan is bounded by the entries it walks, not by the whole transcript: it stops at the
// first entry that is not an intermediate round.
export const isCompactionAnswerTurn = (
    messages: readonly HarnessMessage[],
    index: number
): boolean => {
    if (!Array.isArray(messages) || index < 0 || index >= messages.length) return false;

    if (!isAnswerMessage(messages[index])) return false;

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const entry = messages[cursor];

        // Intermediate rounds of the same compaction pass: the results, and the assistant turn
        // that asked for them. A model that obeyed "do not call tools" hits the instruction on
        // the very first step, which is the plain case.
        if (entry.role === 'tool') continue;
        if (entry.role === 'assistant' && !isAnswerMessage(entry)) continue;

        return isInstructionMessage(entry) && !isContinuationNudge(entry);
    }

    // The transcript begins before any instruction: not a compaction answer.
    return false;
};

// THE SAME QUESTION ONE TURN EARLIER: is the assistant turn this harness is STREAMING right now
// going to commit as a compaction answer? X2 (F4, 2026-11-17), for the one lane the answer rules
// still read the summary through — `src/harness.ts` reports an aborted run's in-flight buffer as
// `partialContent` (issue 0020, "interrupted with an answer in hand"), and an abort in the middle
// of a compaction answer would otherwise hand the spawner the relief note as "the answer it had".
//
// THE ANSWER IS INDEPENDENT OF THE TEXT. `isCompactionAnswerTurn` reads only the entry's ROLE and
// TOOL-CALL list plus the entries above it, so the placeholder below carries no content and the
// caller passes nothing but the transcript: what is being judged is the position of the turn, not
// what it says. The one shape the transcript cannot see is a turn that is streaming prose AND
// tool calls at once; when it commits it will have calls and will not be a compaction answer, and
// this helper will have called it one. That is the deliberate direction — an aborted in-flight
// preamble is worth strictly less to a spawner than the last thing the child actually committed,
// and the failure mode being prevented is the summary crossing the spawner boundary.
export const isCompactionAnswerStream = (messages: readonly HarnessMessage[]): boolean => {
    if (!Array.isArray(messages)) return false;

    // The placeholder needs only the fields `isAnswerMessage` reads. A CAST rather than a full
    // `HarnessAssistantMessage`, because inventing a model id, a stop reason and a usage block
    // for a turn that has not ended would put facts in a shape that claims to be committed state.
    const inFlight = { role: 'assistant', content: '', toolCalls: [] } as unknown as HarnessMessage;

    return isCompactionAnswerTurn([...messages, inFlight], messages.length);
};

// ---------------------------------------------------------------------------
// THE SHRINK PLAN — a summarize request the provider cannot refuse for size
// ---------------------------------------------------------------------------
//
// WHAT THIS IS FOR (2026-11-17, the compaction deadlock). A summarize pass answers a size
// problem by sending the WHOLE transcript plus the compaction instruction. When the transcript
// is already at the provider's hard limit, that request is strictly larger than the one that
// was just refused — so the compaction cannot run, and (before the headroom buffer and the
// overflow-reactive trigger below) nothing retried it. This function is the one that makes the
// compaction request SMALLER than the request that failed, with no model turn and no
// summarization: it is the emergency path, not the policy.
//
// IT IS REQUEST-ONLY, AND THAT IS THE WHOLE DESIGN. The caller hands the result to
// `context.setTranscript` (request-only, wins over the round's re-projection) while
// `context.replaceHistory` keeps the FULL canonical transcript. So nothing is deleted, no
// inclusion flag moves, and the model's own summary — the durable half of compaction — still
// replaces everything the digest stood in for. A shrink that never lands costs one model turn;
// a shrink that overwrites the record would lose conversation.
//
// THE LADDER, IN ORDER, EACH STEP MEASURED BEFORE THE NEXT (deterministic: no clock, no
// random, no provider call, so the table in the test file pins every row):
//   A. CLIP — every head entry keeps its first `SHRINK_CLIP_CHARS` characters of `content`,
//      drops its replayed `reasoning`, and clips each tool call's `arguments`. Payload goes,
//      shape stays, provider pairing is untouched.
//   B. DROP — whole PAIRABLE UNITS from the oldest end of the head (an assistant turn plus the
//      results answering its calls: `shrinkUnitEnd`), replaced by ONE `user` digest entry that
//      says how much went missing and carries the first and last excerpt. A leading `system`
//      entry is never dropped: a host that seeded one stated a standing instruction.
// The last `keepTail` entries are never touched by either step — on the shipped path that is
// "the turn being answered" plus "the compaction instruction", the pair that makes the request
// what it is.
//
// WHY EVERY FIGURE HERE IS `floorTokens + body` (the currency bug this planner had). The
// provider bills the WHOLE request — tool catalogue, instructions, harness turns, per-call
// overhead, transcript — and a rung target is a budget on that same billed total
// (`floor + ladder × the removable transcript`, clamped to the fit line — see `rungBudget` in
// `turnBefore`). When the measurement was the transcript body alone, the two sides of every
// comparison were different quantities: a default-preset harness's catalogue alone is 53,088
// payload bytes / 13,272 tokens, so a 2,438-token transcript asked to reach 13,353 was ALREADY
// under target at every rung, the ladder walked to the bottom, nothing improved, and the request
// came back UNCHANGED — an emergency path that was a no-op, and the session replayed the same 400
// every turn. `floorTokens` is the constant the messages cannot show (everything outside the
// transcript this pass rewrites), and `billedFigure` is the single measurer that adds it to
// every comparison, so `from`, `to`, `tokens` and the target are all the number the provider
// scores. Pass A's per-entry counter is the one body-only measurement in the function: the
// floor is the same on both sides of `next` vs `entry`, so adding it there would only cost two
// extra serializations per entry.
//
// WHY THE CALLER DERIVES THE FLOOR FROM `context.messages`. It is the transcript this function
// rewrites, and the figure the harness was billing when the request was refused, so
// `estimate - measure(messages)` is the residual by construction. `currentMessages()` would be
// the same figure when nothing was withheld this round, and can be SMALLER when the other
// `turn.before` pass clipped entries: taking the messages we are about to replace is the
// pairing that keeps the two halves of the sum the same two halves the harness measured. If a
// handler rewrote the projection after that estimate, the floor is understated by exactly that
// rewrite — which makes the ladder LESS aggressive, the safe direction (the `safety` re-check
// and the overflow-reactive re-arm still catch an underestimate on the next round). The
// subtraction is written ONCE, in `measureRequestFloor`, and both the guard and this planner read
// it from there — the X2 (F1) fix for the place where the two sides of that subtraction were
// priced by two different estimators.
//
// WHY THE MEASURE ASKS FOR ATTACHMENT BYTES. `estimateContextTokens` with
// `includeAttachmentBytes` is the conservative figure (../core/context-estimate.ts, "THE
// OPT-IN REQUEST WEIGHT"): a 6 MB screenshot replayed on every turn is the case where a
// transcript the plain estimate calls small still gets a 400, and a shrink that measured the
// plain figure would send it again unchanged. Tool SCHEMAS are deliberately not added here:
// the plugin does not serialize them, and the provider-anchored hybrid the harness estimates
// with already absorbs whatever the last request's `usage` reported. That anchoring is why the
// estimator's ANCHORED leg prices media as GROWTH rather than as allowance (the constant half of
// the allowance stays out, because it is inside `anchor.tokens` — see
// ../core/context-estimate.ts "THE OPT-IN REQUEST WEIGHT"): the shrink and the trigger must
// price the SAME request in the SAME currency, or the two numbers this pass compares are not
// comparable. THE HALF THE PLUGIN HAS TO CLOSE ITSELF (X2, F1): the shipped producer records the
// anchor from `transcriptChars(sent, instructions)` WITHOUT the media option
// (../core/context-estimate.ts "THE ONE ASYMMETRY A CALLER CAN CLOSE", src/harness.ts
// `pendingRequestChars`), so the trigger figure this plugin is handed contains no media term at
// all while every figure here contains it — `measureRequestFloor` therefore adds the projection's
// own media term back onto the trigger figure before subtracting, which is what makes
// `floor + measureShrink(projection) === tokens` hold instead of falling short by the media. The
// one known over-count that stays is a media entry that was already inside the anchored request;
// it lands in both terms, which is the UPPER-BOUND direction the option publishes, and the escape
// hatch for a caller that wants it once is in the same section.
export type HarnessCompactionShrink = {
    // THE REQUEST to send: never larger than what came in, and the `messages` the caller hands
    // to `setTranscript`.
    messages: HarnessMessage[];
    // Pairable units step B removed (0 when clipping alone was enough).
    dropped: number;
    // Head entries step A rewrote.
    clipped: number;
    // THE BILLED SIZE of the request being sent: the floor the caller supplied plus the
    // conservative estimate of `messages` (`includeAttachmentBytes`, see "WHY THE MEASURE ASKS
    // FOR ATTACHMENT BYTES" above). This is the figure the next trigger comparison and the
    // shrink diagnostic both report, and it is the figure `targetTokens` is compared against —
    // one currency on both sides, which is what makes a rung reachable at all. The bare
    // transcript figure is `tokens - floorTokens`, and the caller has the floor.
    tokens: number;
};

// One entry's text, cut to the budget with a marker the model can read. A string `content`
// only: an odd restored shape (a number, an object) is left exactly as it is, because the
// estimator counts its stringify and this function has no business inventing a serialization.
const clipShrinkText = (value: unknown, budget: number): unknown => {
    if (typeof value !== 'string') return value;
    if (value.length <= budget) return value;

    // The marker is part of the budget arithmetic ONLY in the sense that it rides along: the
    // estimate of a clipped entry is the estimate of the clipped text, so the ladder's next
    // measurement already includes it.
    //
    // PAIR-SAFE (T3, the lone-surrogate defect): a code-unit cut may land between a high
    // half and its low half, and the clipped text would END on half of an emoji. That half
    // is legal here — the transcript holds it, `JSON.stringify` escapes it as `\ud83d` — and
    // fatal on the wire: the provider's strict UTF-8 encoder refuses the whole request.
    // `clipPrefix` backs the cut off one unit instead, so the marker now rides on a boundary
    // that never splits a pair.
    return `${clipPrefix(value, budget)}\u2026 [truncated by compaction]`;
};

// The exclusive end of the PAIRABLE block starting at `index`: an assistant turn that asked for
// tool calls plus every `tool` entry that answers one of them. Strictly CONTIGUOUS (the shape
// the runtime writes, and what `transport/openai.ts` requires to stay pairable), so a result
// reordered elsewhere simply ends the scan rather than being swallowed by it.
const shrinkUnitEnd = (messages: readonly HarnessMessage[], index: number): number => {
    const calls = (messages[index] as { toolCalls?: unknown }).toolCalls;

    if (!Array.isArray(calls) || calls.length === 0) return index + 1;

    const ids = new Set<string>();

    for (const call of calls) {
        if (call === null || typeof call !== 'object') continue;
        const id = (call as { id?: unknown }).id;
        if (typeof id === 'string' && id.length > 0) ids.add(id);
    }

    if (ids.size === 0) return index + 1;

    let end = index + 1;

    while (end < messages.length) {
        const next = messages[end] as { role?: unknown; toolCallId?: unknown };
        if (next.role !== 'tool') break;
        if (typeof next.toolCallId !== 'string' || !ids.has(next.toolCallId)) break;
        end += 1;
    }

    return end;
};

// One clipped head entry: text cut, replayed thinking dropped (it is the single largest
// replayed payload and the model cannot use it under a size refusal), tool-call `arguments` cut
// (a 2 MB file written through a tool call is the case this exists for). `name` and `toolCalls`
// ids stay: pairing is the one thing a request-only rewrite may never break.
const clipShrinkEntry = (entry: HarnessMessage, budget: number): HarnessMessage => {
    const clipped = { ...entry } as HarnessMessage & Record<string, unknown>;

    // Every role of the union declares `content: string`, and `clipShrinkText` passes a
    // non-string through untouched, so the assignment cannot introduce a new shape — the cast
    // states exactly that (the estimator's own `textOf` keeps counting whatever survives).
    clipped.content = clipShrinkText(clipped.content, budget) as string;
    delete clipped.reasoning;

    const calls = clipped.toolCalls;

    if (Array.isArray(calls)) {
        clipped.toolCalls = calls.map((call) => {
            if (call === null || typeof call !== 'object') return call;
            const entry2 = { ...call } as Record<string, unknown>;
            entry2.arguments = clipShrinkText(entry2.arguments, budget);
            return entry2;
        });
    }

    return clipped as HarnessMessage;
};

// The request-weight measure, in ONE place so the ladder and its diagnostic cannot disagree.
// This is the CONSERVATIVE figure: serialized payload bytes plus the wire bytes an attachment
// puts in the body (see "WHY THE MEASURE ASKS FOR ATTACHMENT BYTES" above).
const measureShrink = (messages: readonly HarnessMessage[]): number =>
    estimateContextTokens(messages, undefined, { includeAttachmentBytes: true });

// THE SAME TRANSCRIPT WITHOUT THE MEDIA TERM, i.e. in the currency the HARNESS estimates in:
// `src/harness.ts` `emitTurnBefore` calls `estimateContextTokensHybrid(messages, instructions,
// anchor, { toolSchemaChars })` and never passes `includeAttachmentBytes`, so the number the
// trigger hands this plugin has never seen an attachment byte (X1/X2 currency audit, F1).
const measureBody = (messages: readonly HarnessMessage[]): number =>
    estimateContextTokens(messages, undefined);

// THE FLOOR of the request the summarize pass is about to send — the part of its billed size the
// transcript pass cannot remove — derived in ONE CURRENCY on both sides of the subtraction.
//
// THE BUG THIS REPLACES (`tokens − measureShrink(messages)`, the same expression under a
// comment that claimed "one currency"): the left side is the harness figure, which prices
// payload bytes WITHOUT media, and the right side prices payload bytes WITH media, so the
// residual was short by exactly the media term of the projection. A 6 MB screenshot replayed on
// every turn made the floor read ~1.5 M tokens low, `plan.tokens` understated the request the
// provider scores, and the ladder stopped cutting on a request it believed was already small
// enough — the same shape of bug the planner's own header says it exists to prevent.
//
// THE FIX: hand the harness figure the media term it never counted, then subtract the same
// media-inclusive body the ladder measures every candidate with:
//
//     media = measureShrink(m) − measureBody(m)              // the projection's own media term
//     floor = max(0, tokens + media − measureShrink(m))      // == max(0, tokens − measureBody(m))
//
// so `floor + measureShrink(m) === tokens + media`: the UNSHRUNK candidate measures exactly the
// harness figure plus the media term, because the projection prices identically on both sides.
// That is the property every comparison in `planCompactionRequest` needs — the ladder's
// `billedFigure` is `floor + measureShrink(candidate)` and `target` is the rung budget
// `floor + ladder × (tokens − floor)` clamped to the fit line (see `rungBudget` in `turnBefore`),
// so the floor is added exactly once and `to <= target` is a claim about the request the provider
// receives, and it is conservative by exactly `media`: a screenshot costs wire bytes in a request
// body whether or not the harness figure counted them, and the ladder is the side that must not
// understate.
//
// WHAT THE NUMBER IS *NOT*, stated because an operator reads it in the diagnostic and a reader
// must not "fix" it into a catalogue measurement. It is the request's irreducible billed figure
// AS THE ESTIMATOR PRICES IT, and on an anchored round it therefore carries two real,
// deliberate conservatisms of the provider-anchored estimate (../core/context-estimate.ts): the
// `ANCHOR_GROWTH_MARGIN` premium on the growth since the last reported `usage`, and the
// difference between the provider's own token density and the estimator's 4-bytes-per-token
// rule for the anchored prefix. Measured on `Temp/d1` round 21 that premium is the difference
// between the 44,597 this derivation reports and the ≈31,700 the serialized catalogue and system
// prompt actually cost — an UPPER bound, in the direction a "will this be refused?" check wants.
// Nothing here compares it to a provider limit any more (X2, F6): the dead-run guard asks a
// question about CANDIDATE REQUESTS, and this figure only ever sets what a rung counts as
// "already reached". The clamp at 0 covers the other direction, which the estimator's own
// rounding (a rewrite between the trigger's estimate and here) can produce.
const measureRequestFloor = (
    messages: readonly HarnessMessage[],
    tokens: number
): number => {
    const billed = measureShrink(messages);
    const media = billed - measureBody(messages);

    return Math.max(0, (tokens || 0) + media - billed);
};

// THE WHOLE SHRINK DECISION OF ONE SUMMARIZE PASS, computed BEFORE the pass parks anything
// (X2, F2), because the no-progress gate below has to be able to answer "would this pass send
// anything smaller than the request that was just refused?" without committing the instruction,
// paying for a `pause()`, or spending a model turn. Pure over `context.messages` — the entry-time
// projection, which is the array `request` is built from and never moves inside a handler — so
// computing it in `turnBefore` and consuming it in `beginSummarize` is byte-identical to
// computing it inside the commit, and it is paid for exactly once per pass.
//
// `sent` / `sentTokens` make the ACCEPTANCE rule explicit rather than implicit: the plan is
// adopted only when it is strictly smaller than the request that would otherwise go out,
// measured with the same measurer on both sides (`floor + body`, one currency), and when it is
// not adopted the figures report the ordinary request. `sentTokens` is the number the
// no-progress gate compares against the last refused figure.
export type HarnessSummarizePlan = {
    // The projection plus the compaction instruction — the request an UNSHRUNK pass sends.
    request: HarnessMessage[];
    // The irreducible part of this request's billed figure (see `measureRequestFloor`).
    floor: number;
    // The whole unshrunk request's transcript weight.
    full: number;
    // The shrink, or `undefined` for an ordinary (non-emergency) pass.
    plan: HarnessCompactionShrink | undefined;
    // THE REQUEST THIS PASS SENDS: the plan's messages when the plan was strictly smaller, the
    // ordinary request otherwise.
    sent: HarnessMessage[];
    // THE BILLED FIGURE of `sent`, in the same currency as `tokens` and `target`.
    sentTokens: number;
};

const planSummarizeRequest = (
    messages: readonly HarnessMessage[],
    tokens: number,
    shrinkTo: number | undefined
): HarnessSummarizePlan => {
    // THE FLOOR of this request — the part of the size the shrink cannot remove — derived in one
    // currency by `measureRequestFloor` (see that helper for the two estimators it reconciles and
    // for what the residual is NOT). It comes from `context.messages`, the same array `request`
    // below is built from, so both halves of every sum the planner compares are measured on the
    // one projection this pass rewrites.
    const floor = measureRequestFloor(messages, tokens);

    // THIS request: the projection exactly as measured, plus the instruction. The committed
    // history and the request are written by two different calls on purpose — `setTranscript` is
    // request-only and wins over the round's re-projection (src/harness.ts `requestOf`), while
    // `replaceHistory` alone would leave this request re-projected from the pre-commit list.
    const request = [...messages, { role: 'user' as const, content: COMPACTION_INSTRUCTION }];

    const plan =
        shrinkTo === undefined
            ? undefined
            : planCompactionRequest(request, shrinkTo, SHRINK_KEEP_TAIL, floor);

    const full = measureShrink(request);
    const shrunk = plan !== undefined && plan.tokens < floor + full;

    return {
        request,
        floor,
        full,
        plan,
        sent: shrunk ? plan!.messages : request,
        sentTokens: shrunk ? plan!.tokens : floor + full
    };
};

// Builds the shrunk request. `targetTokens` is the budget the caller wants the BILLED REQUEST
// under — the rung budget `turnBefore` derives as `floor + ladder × (tokens − floor)` (the ratio
// across the removable payload, the irreducible floor added back) clamped to the fit line, the
// effective ceiling or the ceiling itself when the floor sits inside the headroom band; `keepTail`
// is the verbatim tail (see `SHRINK_KEEP_TAIL`); `floorTokens` is the part of the request this
// ladder cannot remove (tool catalogue, agent instructions, harness turns, per-call overhead),
// measured once by the caller — see "WHY EVERY FIGURE HERE IS `floorTokens + body`" above. The
// helper NEVER subtracts that floor at the call site and never adds it twice: the caller passes
// one billed number, and `billedFigure` below is the only place the floor is added, which is what
// makes `to <= target` a claim about the request the provider receives. The default of 0 keeps the
// helper's standalone contract (a bare transcript, no host around it) byte-identical, which is
// what the table in src/plugin/context-compaction.test.ts pins.
//
// Total, and monotone in the amount it removes: the returned `tokens` is never larger than the
// figure that went in, and `messages` is never longer.
export const planCompactionRequest = (
    messages: readonly HarnessMessage[],
    targetTokens: number,
    keepTail: number = SHRINK_KEEP_TAIL,
    floorTokens: number = 0
): HarnessCompactionShrink => {
    // Normalised ONCE, here: a non-finite or negative floor is "no floor", and every figure
    // below adds the same number, so the two sides of every comparison cannot drift into
    // different currencies again.
    const floor = Number.isFinite(floorTokens) && floorTokens > 0 ? Math.floor(floorTokens) : 0;

    // THE one measurer: `floor + body`, the size the provider bills for the request this ladder
    // is building. The bare body is what this function used to measure, and on a session whose
    // catalogue outweighs its transcript that made every rung read "already under target" —
    // 13,272 catalogue tokens plus a 2,438-token body against a 13,353-token target — so the
    // ladder walked to the bottom, cut nothing that counted, and the refused request went out
    // again unchanged. Everything that is COMPARED lives here; the per-entry counter below is
    // the only body-only measurement, because a constant cancels out of it.
    const billedFigure = (list: readonly HarnessMessage[]): number => floor + measureShrink(list);

    const full = Array.isArray(messages) ? messages.slice() : [];
    const start = billedFigure(full);

    // Nothing to do — the ladder's first rung is already roomy enough. Reported as a no-op so
    // the caller can keep the request byte-identical instead of rebuilding it. The floor also
    // makes this branch answer the question the dead-run guard asks: a target at or below the
    // floor is reached immediately, and a target BELOW the floor can never be reached, which is
    // exactly the request `turnBefore` now refuses to send.
    const target = Number.isFinite(targetTokens) && targetTokens > 0 ? Math.floor(targetTokens) : 1;

    if (start <= target) {
        return { messages: full, dropped: 0, clipped: 0, tokens: start };
    }

    const tailSize = Math.max(0, Math.min(Math.floor(keepTail) || 0, full.length));
    const split = full.length - tailSize;

    // ── Pass A: clip the head's payload, keep every entry ───────────────────────────────
    //
    // A LEADING `system` ENTRY IS NEVER CLIPPED (2026-11-23). Pass B and
    // `planCompactionRetention` already refuse to DROP one — "a host that seeded one stated a
    // standing instruction" — and clipping is strictly worse than dropping: the entry survives
    // with 240 characters plus the marker, so the instruction is silently REPLACED rather than
    // withheld, and the host has no way to notice. The measured case: Storyline's brief IS its
    // system entry, so a delivery-relief pass over a Reader transcript clipped it to 267
    // characters before Pass B ever ran, and the host's next request could no longer be
    // attributed to its thread ("a request whose brief names no Storyline Run").
    //
    // The leading run is computed from the UNCLIPPED array, and only entries after it are
    // eligible: an agent's own instruction block is the first thing in every seeded transcript,
    // so "leading" is exactly the host's standing instruction.
    let keepLeading = 0;

    while (keepLeading < split && full[keepLeading].role === 'system') keepLeading += 1;

    let clipped = 0;
    const head = full.slice(0, split).map((entry, index) => {
        if (index < keepLeading) return entry;

        const next = clipShrinkEntry(entry, SHRINK_CLIP_CHARS);

        // Counted only when the rewrite actually removed characters, so "clipped: 0" means the
        // pass changed nothing rather than "the pass ran". Body-only on purpose: `floor` is the
        // same on both sides of this comparison, so adding it would only buy two more
        // serialisations per entry.
        if (measureShrink([next]) < measureShrink([entry])) clipped += 1;

        return next;
    });

    const tail = full.slice(split);
    let tokens = billedFigure([...head, ...tail]);

    if (tokens <= target) {
        return { messages: [...head, ...tail], dropped: 0, clipped, tokens };
    }

    // ── Pass B: drop the oldest pairable units, oldest first ────────────────────────────
    // Leading `system` entries are lifted out and always retained (the standing-instruction
    // rule `planCompactionRetention` follows for the same reason).
    const leading: HarnessMessage[] = [];
    let cursor = 0;

    while (cursor < head.length && head[cursor].role === 'system') {
        leading.push(head[cursor]);
        cursor += 1;
    }

    const excerpts: string[] = [];
    let dropped = 0;

    // The digest costs characters too, so it is measured INSIDE the loop: a ladder step that
    // stops the moment the budget is met without pretending the digest is free.
    const build = (from: number): HarnessMessage[] => {
        const kept = head.slice(from);

        if (dropped === 0 || from === 0) return [...leading, ...kept, ...tail];

        // A unit can carry no text at all (a tool-call turn whose every result is a file), so
        // the excerpts are optional — a digest that printed `undefined` for the excerpt would
        // cost characters and tell the model nothing.
        const excerptsOf =
            excerpts.length === 0
                ? ''
                : excerpts.length === 1
                  ? ` Oldest removed: ${excerpts[0]}`
                  : ` Oldest removed: ${excerpts[0]} | Most recent removed: ${excerpts[excerpts.length - 1]}`;

        return [
            ...leading,
            {
                role: 'user',
                content:
                    `${SHRINK_DIGEST_MARKER} The harness removed ${dropped} earlier ${
                        dropped === 1 ? 'turn' : 'turns'
                    } from this request without a model to summarize them, because the request itself ` +
                    `did not fit the context window. The removed turns are still on the record; they are ` +
                    `simply not being sent.${excerptsOf}`
            },
            ...kept,
            ...tail
        ];
    };

    let queue = build(cursor);

    tokens = billedFigure(queue);

    while (tokens > target && cursor < head.length) {
        const unitEnd = shrinkUnitEnd(head, cursor);
        const unit = head.slice(cursor, unitEnd);

        // Excerpts for the digest: the entry's own text, cut to the same budget the clip used,
        // so the digest cannot grow with the transcript.
        for (const entry of unit) {
            const text = typeof entry.content === 'string' ? entry.content.trim() : '';
            if (text.length === 0) continue;
            // PAIR-SAFE (T3), and more important here than at the clip above: the digest is
            // a synthetic entry the harness WRITES, so it rides every later request. An
            // orphan half in it would poison the thread permanently, and the model cannot
            // edit its way out of a message the harness authored.
            excerpts.push(clipPrefix(text, SHRINK_CLIP_CHARS));
        }

        dropped += 1;
        cursor = unitEnd;
        queue = build(cursor);
        tokens = billedFigure(queue);
    }

    return { messages: queue, dropped, clipped, tokens };
};

// The disable rule BOTH finalize paths share (`setIncluded` on a live run, a canonical
// rewrite on an idle one). Everything before the instruction goes, because the summary
// replaced it; everything strictly between the instruction and the final answer goes too,
// because those are the turns a disobedient model spent after the instruction; and the
// instruction plus the answer plus anything that arrived afterwards is the retained head
// the next request is built from.
//
// A `system` entry is never disabled, for two reasons: an agent's leading instruction
// blocks are re-prepended by the transport rather than stored as transcript entries
// (src/harness.ts `projectTranscript` never emits one), so on the shipped path this guard
// is a no-op — and a host that DOES seed a system entry into a transcript is stating a
// standing instruction that no compaction may silence.
export const planCompactionRetention = (
    messages: readonly HarnessMessage[]
): HarnessCompactionRetention => {
    let instructionIndex = -1;

    // LAST match, not first: a transcript that still carries an older, already-compacted
    // instruction must resolve against the one this pass committed. A continuation nudge is
    // skipped as an anchor (see `isContinuationNudge`): it shares the marker, and anchoring on
    // it would withhold the very instruction and summary this pass produced.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (isInstructionMessage(message) && !isContinuationNudge(message)) {
            instructionIndex = index;
            break;
        }
    }

    if (instructionIndex === -1) return { instructionIndex: -1, answerIndex: -1, disabled: [] };

    let answerIndex = -1;

    for (let index = messages.length - 1; index > instructionIndex; index -= 1) {
        if (isAnswerMessage(messages[index])) {
            answerIndex = index;
            break;
        }
    }

    const disabled: number[] = [];

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];

        if (message.role === 'system' || index === instructionIndex) continue;

        if (index < instructionIndex) {
            disabled.push(index);
            continue;
        }

        // Strictly between the instruction and the answer. When no answer entry exists
        // (a host edited it away) nothing after the instruction is touched.
        if (answerIndex !== -1 && index < answerIndex) disabled.push(index);
    }

    return { instructionIndex, answerIndex, disabled };
};

// True when this round belongs to a durable conversation the plugin may park, commit to
// and rewrite. A BRANCH round is refused earlier (Rule 5). What is left is a run with NO
// thread at all — a `writer('go')` turn on a registered agent — which reports the same
// string in both identity fields, because `threadId` is `run.threadId ?? run.actorKey`
// (src/harness.ts ~8833). For a real conversation the scheduling key is namespaced
// (`thread:<id>`), so the two fields never agree. A threadless round cannot hold a phase:
// its `pause()`/`resume()` are no-ops and `replaceHistory` refuses it outright.
const hasPersistentThread = (context: HarnessTurnBeforeContext): boolean =>
    context.branchId === undefined && context.actorKey !== context.threadId;

// The estimate a summarize pass measures with: `currentEstimatedTokens()` — the projection
// AS IT IS NOW — falling back to the entry-time number for a host stub that does not
// implement the accessor. The live view is the one that must be compared against the limit:
// `estimatedTokens` is frozen at handler ENTRY (types, `HarnessTurnBeforeContext`), so on
// the turn a compaction just landed it still reports the pre-compaction size, which would
// re-trigger the pass on the next turn forever.
const liveEstimate = (context: HarnessTurnBeforeContext): number => {
    try {
        const value: unknown = context.currentEstimatedTokens();

        return typeof value === 'number' && Number.isFinite(value) ? value : context.estimatedTokens;
    } catch {
        return context.estimatedTokens;
    }
};

// ---------------------------------------------------------------------------
// THE MACHINE — the five hooks one summarize pass walks across
// ---------------------------------------------------------------------------
//
// One factory owns the whole state machine — the cooldown map AND the phase map — because
// the edges cross hook boundaries: `turn.before` starts the pass, `turn.after` ends the
// `compacting` phase, `thread.idle` writes the range when the run ended on the answer, and
// the two run-terminal hooks make sure no thread is ever left parked. A host that wants
// only the `turn.before` half can still take it (`createContextCompactionHandler`), and
// then `exclude` mode is complete on its own while `summarize` relies on the built-in
// `setup` below to wire the rest of the machine.
export type HarnessCompactionPasses = {
    turnBefore: HarnessLifecycleHandler<'turn.before'>;
    turnAfter: HarnessLifecycleHandler<'turn.after'>;
    threadIdle: HarnessLifecycleHandler<'thread.idle'>;
    runFinished: HarnessLifecycleHandler<'run.finished'>;
    runFailed: HarnessLifecycleHandler<'run.failed'>;
};

// Builds every handler. The limit is read INSIDE the handler, not once at setup, because
// `api.settings` is re-read on every access by contract (plugin/settings.ts): an operator
// changing the value from the UI takes effect on the next turn, with no restart. That
// applies to `modelLimits` and `mode` exactly as much as to `contextLimit`.
export const createContextCompactionPasses = (
    api: HarnessPluginApi,
    action: HarnessCompactionAction = executeCompaction
): HarnessCompactionPasses => {
    // threadId -> the estimate that last fired for it. The per-thread key matters: two
    // long-running conversations must not share one cooldown.
    const triggered = new Map<string, number>();

    // THE DEAD-RUN LATCH (X2, F6) — threadId -> the estimate the guard last REPORTED at. The
    // guard's report is operator-facing prose ("raise `contextLimit`"), and an armed overflow
    // skips Rule 3 by design, so without a latch a conversation that is permanently bigger than
    // its ceiling printed the same paragraph once per rung per run. The latch holds the size it
    // reported at and re-arms on exactly Rule 3's margin (one report per `REGROWTH_RATIO` of
    // growth), plus a full clear the moment the request stops being dead (see the guard in
    // `turnBefore`) — so a session that stays dead says it once, a session that keeps growing
    // says it once per step, and a session that becomes dead AGAIN after the operator raised the
    // limit or shed a tool is free to say it again.
    const deadRunReported = new Map<string, number>();

    // -----------------------------------------------------------------------
    // THE OVERFLOW LADDER (2026-11-17, the deadlock this plugin used to cause)
    // -----------------------------------------------------------------------
    //
    // WHAT IT IS FOR. The transport and the agent's pre-request floor both answer a request
    // that does not fit with the SAME machine code (`CONTEXT_OVERFLOW_CODE`): a provider 400
    // relayed off the wire, and the harness refusing to send at all. When that reaches
    // `run.failed`, this plugin knows two things and can guess nothing else: the request was
    // too big, and the transcript is what it controls. So the failure ARMS a pass — the next
    // boundary runs whether or not the estimate crossed the trigger, and the summarize request
    // goes out cut to the next rung of `SHRINK_LADDER`.
    //
    // WHY A MAP OF RUNGS RATHER THAN A COUNTER. The rung IS the state: `0` means "the next
    // pass sends 85% of the transcript it can remove, on top of the floor it cannot", and an
    // absent key means "nothing was refused". One key per conversation, bounded by the ladder's
    // length, and it dies with the harness like the two maps beside it.
    //
    // WHY THE WATERMARK IS CLEARED ON AN OVERFLOW AND ON NOTHING ELSE (the second half of the
    // bug). Rule 3 records the size BEFORE the action, so a failed pass is damped until the
    // conversation grows by `REGROWTH_RATIO` — the right call for a provider that failed for a
    // reason compaction cannot fix, and the reason a refused compaction used to be retried
    // never. An overflow is different in kind: the NEXT attempt is a strictly smaller request,
    // so damping it is what re-creates the deadlock. A pass that died of anything else keeps
    // its damping, byte for byte (the failed-run case in the test file pins both halves).
    //
    // `overflowSpent` is the give-up: after `SHRINK_LADDER.length` refusals the transcript is
    // not the problem (a huge tool registry, a window smaller than one turn, a provider
    // counting something else), and one model turn per turn forever is a worse failure than a
    // reported one. The set is cleared by a SUCCESSFUL compaction (`turn.after`, the same edge
    // that resets the rung) or by a fresh overflow after the transcript changed size.
    const overflowRung = new Map<string, number>();

    // threadIds whose ladder is spent — reactive passes stopped, with a report saying so.
    const overflowSpent = new Set<string>();

    // THE NO-PROGRESS BASELINE (X2, F2) — threadId -> the BILLED figure of the shrink request
    // this overflow sequence last actually SENT.
    //
    // WHY A BASELINE AND NOT A RUNG COUNT. `SHRINK_LADDER` is strictly decreasing, so its
    // TARGETS are strictly decreasing — but a rung whose target sits below what the transcript
    // pass can remove produces the SAME request as the rung above it: the planner clips every
    // head entry and drops every droppable pairable unit and still cannot reach the target, so
    // it returns the all-removed request and every deeper rung returns that same request again.
    // The measured case (`Temp/review-v2/probe-b.log` B3, a floor-dominated round) is four rung
    // targets — 41,399 / 34,093 / 24,352 / 17,046 — all resolving to one identical
    // 206,159-token request: four provider round trips of exactly the size the provider had just
    // refused, and only the fourth was allowed to report the give-up. Give-up is therefore keyed
    // on PROGRESS, not on the rung counter: a rung that cannot come back strictly smaller than
    // the figure already refused cannot be improved by a deeper rung either (`planCompactionRequest`
    // is monotone in its target — a smaller target removes no less, so the sequence has already
    // reached its floor), and sending it again spends a model turn to re-learn a refusal. The
    // ladder stops there, with `stage: 'no-progress'` in the existing report plane.
    //
    // Same lifetime as the two maps above: cleared when a compaction succeeds (`turnAfter`, the
    // edge that resets the rung), when a sequence is spent, and when the no-progress gate ends
    // a sequence, so the NEXT refusal re-arms with a fresh baseline rather than being judged
    // against a figure from a conversation that has since changed size.
    const overflowBest = new Map<string, number>();

    // threadId -> the in-flight pass. Bounded by the number of conversations a harness
    // ever had, exactly like the cooldown map above: the only way an entry outlives its
    // thread is a thread purged mid-pass, which leaves one stale key in a map nothing
    // prunes (see "WHY THE COOLDOWN MAP IS NEVER PRUNED").
    const phases = new Map<string, HarnessCompactionPhase>();

    // -----------------------------------------------------------------------
    // THE DISPLAY LANE (C1) — one bump per SUMMARIZE pass, and the undo
    // -----------------------------------------------------------------------
    //
    // WHAT IT IS FOR. The context bar paints one stacked row per display lane
    // (../shared/turn-display.ts `ContextBlock.lane`), and the lane a recorded event lands
    // on is the conversation's CURRENT lane at record time
    // (../server/protocol.ts `SessionTurnEvent.lane`). Raising the thread's lane by one at
    // the moment a compaction starts therefore splits THAT turn's bar in two: the
    // pre-compaction segments stay on row N and the compaction answer, recorded a moment
    // later, sits on row N+1. That is the whole feature: one compaction, two visible rows,
    // in the bar of the turn the boundary actually happened in.
    //
    // WHY THE BUMP IS AT THE START OF THE PASS, NOT AT THE FINALIZE (traced, do not
    // "simplify" this). The pass spans a run: `turn.before` commits the instruction, the
    // model answers, `turn.after` flips the phase, and the range is written either at the
    // NEXT `turn.before` or on `thread.idle` — after which the turn has already reached its
    // terminal status (./sessions.ts records events only while the run lives, and the
    // terminal transition is what closes the row). A bump placed at the finalize would
    // therefore move the lane AFTER every event of this turn was recorded, and the
    // pre-compaction segments and the summary would sit in two DIFFERENT turns' bars — no
    // bar would ever show two rows. Bumping on the instruction commit is the only point in
    // the machine where "the boundary is inside this turn" is still true.
    //
    // WHY `exclude` MODE NEVER BUMPS. An exclude pass withholds individual superseded tool
    // units, and it fires whenever a conversation is over the limit — often several times
    // per conversation, one small range at a time. A lane bump per pass would slice one
    // conversation's history into a stack of thin rows keyed to no meaningful boundary: the
    // bar's rows would report when a prune happened, not when the conversation changed what
    // it knows. Summarize is different in kind — it rewrites what the conversation REMEMBERS
    // — so it is the one mode whose boundary deserves a row.
    //
    // THE UNDO. A pass that never produced a compaction (the commit threw, the run failed
    // or ended without an answer, the instruction got rolled back with it) must not leave a
    // lane it never earned, or a bar would show a boundary that never happened. So the
    // value live BEFORE the bump is remembered per thread, and every abandon path restores
    // it. The map holds at most one entry per in-flight pass — the same bounded-shape
    // caveat the two maps above have (a thread purged mid-pass leaves one stale key).
    //
    // A LANE WRITE CAN NEVER FAIL A COMPACTION: both directions are wrapped, and the only
    // consequence of a refused write is a diagnostic saying the bar will not show the
    // boundary. Compaction is about the model's context; the bar is downstream of it.
    const laneBefore = new Map<string, number>();

    // The pass's lane bump, and the marker that it still owes an undo.
    const bumpLane = (threadId: string): void => {
        try {
            const before = api.threads.getContextLane(threadId);

            laneBefore.set(threadId, before);
            api.threads.setContextLane(threadId, before + 1);
        } catch (error) {
            // Either read or write refused (a purged conversation, a rejected value). Drop
            // the undo marker with it: there is nothing this pass moved.
            laneBefore.delete(threadId);
            api.report.diagnostic({
                message:
                    `context-compaction could not raise the display lane of thread ${threadId}; the compaction ` +
                    `still ran, but its context bar will not show the boundary as a second row.`,
                data: {
                    mode: MODE_SUMMARIZE,
                    threadId,
                    reason: error instanceof Error ? error.message : String(error)
                }
            });
        }
    };

    // The pass finished its job: the bump is real, so forget the undo.
    const keepLaneBump = (threadId: string): void => {
        laneBefore.delete(threadId);
    };

    // The pass produced no compaction: put the lane back exactly where it was.
    const revertLaneBump = (threadId: string): void => {
        const before = laneBefore.get(threadId);

        if (before === undefined) return;

        laneBefore.delete(threadId);

        try {
            api.threads.setContextLane(threadId, before);
        } catch (error) {
            api.report.diagnostic({
                message:
                    `context-compaction could not restore the display lane of thread ${threadId} after an ` +
                    `abandoned pass; the conversation may show one empty row in its context bar.`,
                data: {
                    mode: MODE_SUMMARIZE,
                    threadId,
                    lane: before,
                    reason: error instanceof Error ? error.message : String(error)
                }
            });
        }
    };

    // `modelLimits` is free text an operator edits rarely, and this handler runs on
    // EVERY turn, so parsing it per turn is waste. Keyed by the exact stored string: the
    // compare is one reference/length check, and any change from the UI re-parses on the
    // next turn, which keeps the live-read contract every other setting has. The cache is
    // per-handler, like the cooldown map, so it dies with the harness.
    let limitsRaw: string | undefined;
    let limitsMap: Record<string, HarnessContextModelLimits> = {};

    // The park/act/unpark pass (`exclude` mode). Extracted so the fast path below can stay
    // synchronous.
    const pass = async (context: HarnessTurnBeforeContext): Promise<void> => {
        // Park, act, always unpark. `pause()` is outside the try because a pause that
        // failed has nothing to undo; the throw itself is left to the bus (fail-open),
        // which keeps "what a broken plugin does to a run" a framework decision.
        await context.pause();

        try {
            await action(api, context);
        } finally {
            await context.resume();
        }
    };

    // The one way this plugin ever lifts a park it did not need to hold: `api.threads.resume`
    // answers 'running' while a run is attached and 'idle' when the park outlived it, and is
    // a no-op for a thread that is not parked — including one a host deleted, which throws
    // through `threadStateOf` and is exactly the case with nothing left to un-park.
    const unpark = (threadId: string): void => {
        try {
            api.threads.resume(threadId);
        } catch {
            // Unknown thread: there is no record left to strand.
        }
    };

    // The trigger half of a summarize pass: park the conversation, commit the instruction
    // into the CANONICAL transcript, and hand THIS request the projection plus that
    // instruction. The answer arrives on the model turn this returns into, which is why the
    // pass cannot finish here (see "THE PHASE MAP").
    //
    // `shrinkTo` (2026-11-17) is the budget of an EMERGENCY request — one sent because a size
    // refusal says the full projection will not fit. It applies to the REQUEST ONLY
    // (`setTranscript`, via `planCompactionRequest`); the canonical history is still written in
    // full, so a shrink costs nothing durable and the model's own summary remains the thing
    // that decides what stops being sent. Omitted is the ordinary pass: the projection exactly
    // as measured, plus the instruction, byte-identical to what this function sent before.
    //
    // `planned` (X2, F2) is that decision, computed by the CALLER before this function parks
    // anything: `turnBefore` has to be able to refuse a no-progress rung without a park, without
    // a committed instruction, and without a model turn, and the plan it needs is exactly the one
    // this commit would make. It is pure over `context.messages`, which never moves inside a
    // handler, so pre-computing it changes no figure — it only moves the cost to before the
    // point of no return.
    const beginSummarize = async (
        context: HarnessTurnBeforeContext,
        effective: number,
        tokens: number,
        shrinkTo: number | undefined,
        planned: HarnessSummarizePlan
    ): Promise<void> => {
        const threadId = context.threadId;

        // Set BEFORE anything can fail: a phase that is set and then abandoned is cleared by
        // the `catch` below or by the run-terminal net; a phase that is never set would let
        // the next boundary trigger a second compaction on top of this one.
        phases.set(threadId, 'compacting');

        try {
            await context.pause();

            // ALL entries — the whole committed transcript in canonical order, each entry's
            // own `included` flag riding inside its message. `replaceHistory` re-states the
            // transcript through `writeThreadTranscript`, whose snapshot reader carries
            // `included: false` and the durable `messageId` for every role
            // (src/core/snapshot.ts ~345/369/398/434), so an entry an EARLIER pass withheld
            // is still withheld after this write; the flag case pinned in
            // src/plugin/context-compaction.test.ts is what proves it rather than assumes it.
            // Building the array from `entries` is also what keeps a leading `system` entry
            // (a host seed) from being dropped by the rewrite.
            const canonical = context.entries.map((entry) => entry.message);

            context.replaceHistory([
                ...canonical,
                { role: 'user', content: COMPACTION_INSTRUCTION }
            ]);

            // THE PLAN, taken from the caller's pre-computed decision (see `planSummarizeRequest`
            // for the derivation of every figure here, including the one-currency floor). The
            // committed history and the request are written by two different calls on purpose —
            // `setTranscript` is request-only and wins over the round's re-projection
            // (src/harness.ts `requestOf`), while `replaceHistory` alone would leave this request
            // re-projected from the pre-commit list.
            const { request, floor, full, plan, sent } = planned;

            context.setTranscript(sent);

            // DISPLAY LANE (C1): the boundary exists the moment the instruction is in the
            // canonical transcript, so the lane moves HERE — after the commit that could
            // still fail, before this hook releases the request that will carry the answer.
            // Every event recorded from here on (the summary's own `text`/`done` frames
            // first) is stamped with lane N+1 by the store's recorder, which re-reads the
            // thread live per event, so THIS turn's bar paints both rows. See the block
            // above `laneBefore` for why a bump at the finalize would have been too late.
            bumpLane(threadId);

            api.report.diagnostic({
                message:
                    `context-compaction parked thread ${threadId} and asked it to compact itself: ` +
                    `~${tokens} estimated tokens against an effective limit of ${effective} (mode summarize). ` +
                    `The next model turn carries the compaction instruction.`,
                data: { mode: MODE_SUMMARIZE, threadId, tokens, effective, entries: canonical.length + 1 }
            });

            // The SECOND report of an emergency pass, kept separate rather than folded into the
            // one above: the park report is the shape every existing case pins, and a shrink is
            // an addition to it, not a change in it. It is also the operator-facing half of the
            // deadlock fix — the line that says "the request that was refused has now been
            // out-sized", with both numbers, so a ladder that is not making progress is visible
            // rather than inferred from four identical refusals.
            //
            // THE CURRENCY of all three numbers: billed request size, not transcript size.
            // `from` and `to` are `floor + body` and `plan.tokens` (which is the same thing for
            // the shrunk request), and `target` is the rung budget against that same hard limit —
            // the floor plus the ratio across the removable transcript, clamped to the fit line —
            // so `to <= target` is the claim the provider can check. The floor is reported too,
            // because the number an operator needs when the ladder looks idle is "how much of
            // this request could not be shrunk at all" — stated that way, and not as "the tool
            // catalogue", because the figure is a RESIDUAL of the estimator's own round figure
            // (see `measureRequestFloor`: on an anchored round it carries the provider-anchored
            // premium as well, so it is an upper bound on the catalogue and the instruction
            // blocks rather than a measurement of them).
            if (plan !== undefined && sent !== request) {
                api.report.diagnostic({
                    message:
                        `context-compaction is asking thread ${threadId} to compact itself from a request the ` +
                        `provider could not refuse: ~${floor + full} billed estimated tokens were cut to ~` +
                        `${plan.tokens} (target ${shrinkTo}, of which ${floor} is this request's irreducible floor ` +
                        '— the serialized tool schemas and instruction blocks the transcript pass cannot touch, ' +
                        'counted in the same currency the trigger figure was estimated in) by withholding ' +
                        `${plan.dropped} earlier ${plan.dropped === 1 ? 'turn' : 'turns'} and clipping ` +
                        `${plan.clipped} ${plan.clipped === 1 ? 'entry' : 'entries'} from the request only — the ` +
                        'record is intact.',
                    data: {
                        mode: MODE_SUMMARIZE,
                        threadId,
                        stage: 'shrink',
                        target: shrinkTo,
                        from: floor + full,
                        to: plan.tokens,
                        floorTokens: floor,
                        dropped: plan.dropped,
                        clipped: plan.clipped,
                        entries: plan.messages.length
                    }
                });
            }
        } catch (error) {
            // A commit that failed has nothing to finalize. Drop the phase and lift the
            // park — a stranded park is the one failure this plugin may never cause — and
            // let the error reach the bus, the single fail-open authority (plugin/hooks.ts
            // rule 2). `resume()` is a no-op when the pause itself never landed.
            //
            // DISPLAY LANE (C1): the undo runs here too. `bumpLane` is the last thing the
            // happy path does, so a throw can come from before it (nothing to undo — the
            // map simply has no entry) or after it (the instruction landed, but the answer
            // will never arrive on this pass). Either way a pass that produced no
            // compaction must not leave a lane behind, because a lane is a claim that a
            // boundary happened.
            phases.delete(threadId);
            revertLaneBump(threadId);
            await context.resume();
            throw error;
        }
    };

    // Writes the range on a LIVE run (the run kept going after the answer, so there is no
    // idle moment to rewrite the transcript in). `setIncluded` is the only writer that also
    // re-projects THIS request (types, `setIncluded`: "THE SAME REQUEST SEEPS IT").
    const finalizeInRequest = (context: HarnessTurnBeforeContext): void => {
        const threadId = context.threadId;
        const entries = context.entries;
        const range = planCompactionRetention(entries.map((entry) => entry.message));

        if (range.instructionIndex === -1) {
            // The instruction is gone: the run that committed it rolled it back
            // (`brain.messages.splice(commitIndex)`, src/harness.ts ~9677) or a host rewrote
            // the transcript. Either way the pass is over — with nothing left to disable.
            //
            // DISPLAY LANE (C1): with the instruction gone there is no compaction to
            // report, so the bump this pass made is undone rather than left as a phantom
            // boundary in the bar.
            phases.delete(threadId);
            revertLaneBump(threadId);
            return;
        }

        for (const index of range.disabled) {
            // Located by index rather than reused from the range, so an entry the transcript
            // no longer carries is skipped instead of addressing the wrong turn — the same
            // guard `executeCompaction` follows.
            const entry = entries.find((candidate) => candidate.index === index);

            if (entry === undefined) continue;

            // One write per ENTRY, and `range.disabled` already names every entry in the
            // withheld range (leader and results alike), so per-entry writes need no member
            // expansion here — unlike the prune pass, which plans UNITS.
            context.setIncluded(entry, false);
        }

        phases.delete(threadId);
        // DISPLAY LANE (C1): the range is written, so this pass DID compact the conversation
        // and its bump is final — forget the undo.
        keepLaneBump(threadId);

        reportFinalize(threadId, range, 'turn.before', entries.length);
    };

    // The pass report, from either path. The indices are in it because "why is THAT turn
    // missing from the model's context" has to be answerable from the log alone (T4.5's
    // reasoning, which applies just as hard to a range this large).
    const reportFinalize = (
        threadId: string,
        range: HarnessCompactionRetention,
        path: string,
        total: number
    ): void => {
        api.report.diagnostic({
            message:
                `context-compaction compacted thread ${threadId} itself: ${range.disabled.length} of ${total} ` +
                `entry(ies) stop being sent, the retained head is the instruction at #${range.instructionIndex} ` +
                `${range.answerIndex === -1 ? 'with no answer entry' : `and the answer at #${range.answerIndex}`} (finalized at ${path}).`,
            data: {
                mode: MODE_SUMMARIZE,
                threadId,
                path,
                instructionIndex: range.instructionIndex,
                answerIndex: range.answerIndex,
                disabled: range.disabled,
                total
            }
        });
    };

    // How the idle-path finalize landed, because the three answers drive different follow-ups.
    type IdleFinalize = 'compacted' | 'refused' | 'nothing';

    // The idle path: the run ENDED on the compaction answer, so the transcript can be
    // rewritten wholesale (`api.threads.replaceMessages` is `setThreadMessages`, refused
    // while a run is attached and legal exactly here). Returns `refused` with the phase
    // INTACT so the next `turn.before` retries through `finalizeInRequest`, and `nothing`
    // when the instruction is no longer there at all.
    const finalizeOnIdle = (threadId: string): IdleFinalize => {
        let messages: HarnessMessage[];

        try {
            messages = api.threads.messages(threadId);
        } catch {
            // Unknown or already purged: nothing to rewrite, and no conversation left to
            // resume. The phase dies with the thread in every practical case.
            //
            // DISPLAY LANE (C1): the bump's marker goes with it — the conversation, and
            // with it the lane, no longer exists, so there is nothing left to undo and a
            // write attempt would only report a diagnostic about a deleted thread.
            phases.delete(threadId);
            laneBefore.delete(threadId);
            return 'nothing';
        }

        const range = planCompactionRetention(messages);

        if (range.instructionIndex === -1) {
            // No instruction left to anchor the range: nothing was compacted, so the lane
            // this pass raised goes back (C1).
            phases.delete(threadId);
            revertLaneBump(threadId);
            return 'nothing';
        }

        const withheld = new Set(range.disabled);
        const replacement = messages.map((message, index) =>
            withheld.has(index) ? { ...message, included: false } : message
        );

        try {
            api.threads.replaceMessages(threadId, replacement);
        } catch {
            // A run attached between the idle hook and this write (a host turn raced the
            // nudge), or the document refused the shape. Keep `finishing`: the next
            // `turn.before` writes the same range through the flags instead.
            //
            // DISPLAY LANE (C1): the bump marker stays for the same reason — the pass is
            // still open, its answer is still committed, and the retry at the next boundary
            // owns the undo if it ends up needing one.
            return 'refused';
        }

        phases.delete(threadId);
        // The rewrite landed: this conversation is compacted, so its lane bump is the real
        // boundary and the undo is dropped (C1).
        keepLaneBump(threadId);

        reportFinalize(threadId, range, 'thread.idle', messages.length);

        return 'compacted';
    };

    // SYNC fast path, deliberately not an `async` function: the bus does
    // `await handler(payload)`, so returning `undefined` costs one microtask, while an
    // `async` handler layers its own promise on top of that await. Almost every turn is
    // under the limit, and the harness interleaves a delegated child's event frames with
    // its parent's on exactly those boundaries (plugin/hooks.ts rule 5) — so the path that
    // runs most often yields as little as the contract allows, and only a real trigger
    // returns a promise.
    const turnBefore: HarnessLifecycleHandler<'turn.before'> = (context) => {
        // Rule 0 — the whole-plugin switch, read first so a disabled plugin costs one setting
        // read and no transcript work at all. It is re-read every turn like the rest
        // (`api.settings` is live by contract), which is what lets an operator flip it from
        // the UI mid-session.
        if (!api.settings.boolean('enabled', ENABLED_DEFAULT)) return undefined;

        const limit = api.settings.number('contextLimit', CONTEXT_LIMIT_DEFAULT);

        // Rule 1: a non-positive limit is "off". `Number.isFinite` also refuses NaN, so
        // a corrupt stored value can never make every turn look over the limit.
        if (!Number.isFinite(limit) || limit <= 0) return undefined;

        // Rule 4: never compact the compactor's own agents.
        if (isInternalAgent(context.agent)) return undefined;

        // Rule 5 (ratified 2026-11-09): a BRANCH round never triggers a pass at all. Its
        // `pause()`/`resume()` are no-ops, its transcript is ephemeral, and its cooldown key
        // (`branch:<id>`, one per fork) could never be cleared — so the trigger bought nothing
        // and left a dead entry behind. See the header section on the branch skip, and the
        // matching correctness check in `executeCompaction`.
        if (context.branchId !== undefined) return undefined;

        // Rules 2 and 3 compare against the EFFECTIVE limit, never against some derived
        // firing point: the per-model facts are read here, per turn, so switching models or
        // editing the map takes effect on the next turn like everything else. Reading them
        // AFTER the internal-agent and branch skips keeps a skipped round at two settings
        // reads — the disabled/enabled tests below pin the exact read sequence, because a
        // silent extra read on the hot path is a silent per-turn cost.
        const rawLimits = api.settings.string('modelLimits', MODEL_LIMITS_DEFAULT);

        if (rawLimits !== limitsRaw) {
            limitsRaw = rawLimits;
            limitsMap = parseModelLimits(rawLimits);
        }

        // Which writer this turn belongs to. The DECLARED default is `summarize`, so an unset
        // value lands there; any value that is neither implemented mode (including the
        // planned `annotate`) lands on `exclude`, the conservative flow that existed before
        // and cannot spend a model turn by accident.
        const summarize = api.settings.string('mode', MODE_DEFAULT) === MODE_SUMMARIZE;

        if (summarize) {
            // A round with no durable conversation is outside the machine: it cannot be
            // parked and `replaceHistory` refuses it, so the pass would cost a model turn
            // and keep nothing.
            if (!hasPersistentThread(context)) return undefined;

            const phase = phases.get(context.threadId);

            // A pass is in flight. `compacting` means the instruction is out for its answer:
            // no second instruction and no re-trigger. `finishing` means the answer is
            // committed and the run kept going, so THIS boundary writes the range — before
            // any threshold check, or a still-over-limit conversation would start a fresh
            // compaction on top of the one that just finished.
            if (phase === 'compacting') return undefined;

            if (phase === 'finishing') {
                finalizeInRequest(context);
                return undefined;
            }
        }

        // The headroom ratio. Read HERE, after the mode decision and before the trigger is
        // resolved, so a round skipped by Rules 1/4/5 still stops at two settings reads and the
        // pinned read sequences in the test file stay honest.
        //
        // It IS a declared `metadata.settings` row (row 3, filed under the `modelLimits` entry it
        // depends on), so an operator can see and edit it in the Plugins pane and a stored `0` is
        // a documented opt-out rather than a folklore setting. The DECLARED default now outranks
        // the argument below (plugin/settings.ts `resolve`: stored value → declared default →
        // argument fallback), so this read answers 0.15 for a fresh install two ways at once; the
        // argument stays because a host plugin that reuses this guard WITHOUT declaring the row
        // still has to get the buffer rather than `0`, exactly like the other fallback constants
        // above. The two spellings are the same number on purpose — see
        // `HEADROOM_RATIO_DEFAULT` for the duplication rule.
        const headroomRatio = api.settings.number('headroomRatio', HEADROOM_RATIO_DEFAULT);

        const { effective, limit: ceiling, window } = resolveContextTrigger({
            contextLimit: limit,
            modelLimits: limitsMap,
            modelId: currentModelId(api, context.agent),
            headroomRatio
        });

        // Rule 2: under the limit — clear the cooldown so the next crossing is fresh, and
        // return without touching the thread. `exclude` measures the entry-time estimate it
        // always measured; `summarize` measures the live one (see `liveEstimate`).
        const tokens = summarize ? liveEstimate(context) : context.estimatedTokens;

        // THE OVERFLOW RUNG (see the map above). A refusal outranks Rule 2 (the estimate may
        // well read low — the estimate is an estimate, and the provider just measured the real
        // thing) and Rule 3 (the next attempt is a strictly smaller request, so the growth that
        // the re-trigger memory waits for is exactly the growth that already failed).
        const rung = overflowRung.get(context.threadId);
        const armed = rung !== undefined && !overflowSpent.has(context.threadId);

        // Whether a DECLARED model window is the number that binds (the same test
        // `resolveContextTrigger` uses for the headroom buffer, re-derived from what it returns
        // rather than returned again as a second field). When it does, a projection already AT
        // the window will be refused with the instruction on top of it: the round trip we can
        // see coming is worth skipping, so such a pass goes out shrunk from its first rung.
        // Without a declared window there is nothing to be under, and the refusal-armed path
        // above carries the whole load.
        const atWindow = window !== undefined && window <= ceiling && tokens >= window;

        if (!armed && tokens < effective) {
            triggered.delete(context.threadId);
            return undefined;
        }

        // The summarize floor (documented in the `minTokens` descriptor): below this size a
        // round trip costs more than the context it saves. Read only on a turn that is
        // already over the limit, so the hot path never pays for it — and NOT recorded in
        // the cooldown, so raising the floor back down re-arms the pass on the next turn.
        //
        // An ARMED overflow respects it too, and that is a decision rather than an oversight:
        // a transcript below the floor that still got refused is being refused by something
        // compaction does not own (tool schemas, a window smaller than one turn), and spending
        // a model turn per turn to re-learn that is the loop the ladder exists to bound. The
        // give-up report below is the operator's signal, not a silent silence.
        //
        // The local is named `minTokens`, not `floor`, because "the floor" now means something
        // else in this file — a request's irreducible size, see `planCompactionRequest` — and
        // the dead-run guard below needs both words in the same function.
        if (summarize) {
            const minTokens = api.settings.number('minTokens', MIN_TOKENS_DEFAULT);

            if (Number.isFinite(minTokens) && tokens < minTokens) return undefined;
        }

        // Rule 3: at or above the limit. Fire on a fresh crossing, or once the conversation
        // has grown by at least REGROWTH_RATIO of the effective limit since the last fire.
        // `max(1, ...)` keeps a margin for a limit so small that 5% rounds to 0 — otherwise an
        // unchanged estimate would fire on every turn again. An armed overflow skips the rule
        // entirely (see above).
        if (!armed) {
            const previous = triggered.get(context.threadId);
            const margin = Math.max(1, Math.floor(effective * REGROWTH_RATIO));

            if (previous !== undefined && tokens < previous + margin) {
                return undefined;
            }
        }

        // THE DEAD RUN GUARD (2026-11-17, the size-refusal deadlock) — why a summarize pass can
        // be refused even on a round the provider just refused for size. The request this pass
        // sends is the whole transcript plus the compaction instruction, and the ladder can
        // only remove transcript: the request's FLOOR (tool catalogue, agent instructions,
        // harness turns, per-call overhead) rides along on every rung. So when the floor alone
        // is at or above the ceiling the overage is not the transcript's, clipping cannot close
        // it, and firing buys a guaranteed second refusal on a turn that was going to be
        // blocked anyway: `planCompactionRequest` reaches no target it cannot reach, the
        // transport rejects the request for the same reason, and the session walks the rest of
        // the ladder plus the give-up with the transcript intact either way. Not firing leaves
        // every entry in the request and says so once — an honest block instead of four
        // no-progress turns.
        //
        // WHY `>=` IS THE RIGHT EDGE: at `floor == ceiling` the smallest request the pass can
        // build is exactly at the figure the ceiling treats as unsendable, so it has nothing to
        // gain; one point below, and a clipped request can fit. The table in
        // src/plugin/context-compaction.test.ts pins both sides (a 13,272-token catalogue
        // blocks at a 13,272 ceiling and fires at 13,273 — the row RE-DERIVED for X2, because
        // both the floor derivation and the trigger moved under F1/F3) so this stays a boundary
        // rather than a clamp.
        //
        // WHY THE COMPARISON IS AGAINST THE CEILING AND NOT THE EFFECTIVE TRIGGER (X2, F3).
        // `ceiling` is the number that refuses — the declared window, or the operator's budget
        // when no window is declared. The headroom buffer now comes off BOTH of them, so
        // `effective` is strictly below the refusal point on every deployment; a guard that
        // compared an irreducible request against the FIRING point would suppress compaction on
        // every deployment whose floor sits between the two — exactly the small-`contextLimit`
        // installations F3 exists to protect (a 25,000 ceiling with a 15,000 floor has an
        // `effective` of 12,500 and could still relieve 10,000 tokens of transcript). The pass
        // is dead only when nothing it can send would be sendable.
        //
        // WHY THE FULL TRANSCRIPT AND NOT THE PROJECTION: the transcript figure below is the
        // most a pass could ever take off, so a refusal cannot be caused by the other
        // `turn.before` pass withholding entries this round. The floor comes from
        // `measureRequestFloor`, the same derivation `beginSummarize` uses, so the guard and the
        // ladder cannot disagree about what is irreducible, and this reads no new setting. An
        // `exclude` round is untouched: it never re-sends the transcript, so the floor argument
        // does not apply to it.
        //
        // The local is named `floor`, not the `minTokens` from the gate above: that one lives
        // inside its own `if (summarize)` block, so reading it down here would be a block-
        // scoping `ReferenceError` swallowed by the plugin hook's fail-open (a silent missing
        // pass), and "the floor" in this file means the request's irreducible size.
        //
        // It is hoisted ABOVE the guard (R6, 2026-11-17) rather than measured inside it, because
        // TWO readers now need the one figure: the guard below reports it as
        // `unreachableTarget`, and the shrink ladder prices its rung against it (see
        // `rungBudget`). One measurement per round either way — it is the same
        // `measureRequestFloor` derivation `planSummarizeRequest` runs on the same projection —
        // and an `exclude` round still pays nothing for it (`0`, since that mode never re-sends a
        // transcript).
        const floor = summarize ? measureRequestFloor(context.messages, tokens) : 0;

        if (summarize) {
            // The transcript figure only feeds the guard's report ("how much could this pass have
            // taken off"), so it stays where the report is made.
            const transcript = measureShrink(context.messages);

            if (floor >= ceiling) {
                // ONE REPORT PER SIZE, not one per run (X2, F6). Rule 3's regrowth margin already
                // bounds the UNARMED case to one report per 5% of growth, but an ARMED overflow
                // deliberately skips Rule 3, so a session permanently over its window used to
                // print this on every rung of every run — the report the reviewer measured as
                // repeating per turn. The latch therefore stores the size it reported at and
                // re-arms on the SAME margin Rule 3 uses, which keeps both truths: a conversation
                // stuck at one size says it once, a conversation that keeps growing keeps saying
                // it (each 5% step is new information about a request that still cannot fit), and
                // the moment the request STOPS being dead the else below clears the latch so a
                // later dead run is free to state it again.
                const reported = deadRunReported.get(context.threadId);
                const margin = Math.max(1, Math.floor(effective * REGROWTH_RATIO));

                if (reported === undefined || tokens >= reported + margin) {
                    deadRunReported.set(context.threadId, tokens);

                    api.report.diagnostic({
                        message:
                            `context-compaction is refusing to compact thread ${context.threadId}: its request ` +
                            `floor is ${floor} tokens against a ${ceiling} ceiling, so the transcript this pass ` +
                            `could still withhold is only ${transcript} of the ${tokens} estimated tokens on the ` +
                            `round. That floor is the part of EVERY request this harness sends that compaction ` +
                            `does not own — the serialized tool schemas of the agent's tool set and the agent's ` +
                            `instruction blocks — and it is already at or above the ceiling on its own, so no ` +
                            `amount of clipping can get a compaction request sendable and the pass would buy a ` +
                            `second refusal for the same reason while leaving every entry in the request anyway. ` +
                            `Raise \`contextLimit\` above ${floor}, or give the model a larger window in ` +
                            '`modelLimits` ' +
                            '(`modelLimits: {"<model id>": {"window": <tokens>}}`), or use a preset that ' +
                            'registers fewer tools.',
                        data: {
                            mode: MODE_SUMMARIZE,
                            threadId: context.threadId,
                            stage: 'unreachable-target',
                            tokens,
                            effective,
                            limit: ceiling,
                            unreachableTarget: floor,
                            transcriptTokens: transcript,
                            reported: true,
                            ...(armed ? { armed: true, rung } : {})
                        }
                    });
                }

                return undefined;
            }

            // The request is sendable after all, so the one-report latch is re-armed.
            deadRunReported.delete(context.threadId);
        }

        // Recorded BEFORE the action: a failing action must not be retried on the very
        // next turn, and the value stored is the size this pass was asked about. An overflow
        // failure clears this again in `runFailed` — the asymmetry is the point.
        triggered.set(context.threadId, tokens);

        if (!summarize) return pass(context);

        // THE BUDGET this pass sends its request under, or `undefined` for "send the ordinary
        // request". `SHRINK_LADDER` is strictly decreasing, so the fourth refusal sends 35% of
        // the transcript this pass can remove and the fifth reports the give-up instead of
        // spending another turn.
        const ladder = SHRINK_LADDER[armed ? Math.min(rung ?? 0, SHRINK_LADDER.length - 1) : 0];

        // THE RUNG, PRICED IN ONE CURRENCY (R6, 2026-11-17 — the over-compaction the operator
        // reported as "it erased more than the window asked for", twice as often as it needed to).
        //
        // WHAT MOVED. `tokens` is the BOUNDARY estimate, and that figure is not the transcript:
        // it is the transcript payload PLUS the request's irreducible floor (the serialized tool
        // catalogue, the agent's instruction blocks, the harness turns — everything
        // `measureRequestFloor` has just said this pass cannot remove; src/harness.ts:12512 passes
        // `toolSchemaBytes()` into the very estimator this number comes from). Scaling THAT number
        // by the rung therefore asked the transcript to absorb the rung's percentage of the
        // CATALOGUE too. Re-arranged, the payload budget the old expression produced was
        //
        //     ladder × (floor + payload₀) − floor  =  ladder × payload₀  −  (1 − ladder) × floor
        //
        // i.e. the cut the rung actually asked for PLUS a second allowance the size of a fraction
        // of the floor — 1,991 tokens of extra history per rung at the shipped 0.85 against the
        // 13,272-token catalogue of a writer-only roster, and the whole ladder compounds it. That
        // is the double subtraction the acceptance note names: the floor is removed once by the
        // `− floor` that turns a billed target into a payload budget inside `planCompactionRequest`
        // and once again by the ratio that was taken across it.
        //
        // THE SECOND, WORSE HALF: once that target dropped below `floor + the smallest request this
        // transcript can build`, it was unreachable BY CONSTRUCTION — every candidate was over it,
        // `planCompactionRequest` walked to the bottom of its pass B, and the pass withheld EVERY
        // droppable unit chasing a number no request of this harness could ever send. That is the
        // measured `Temp/review-v2/probe-b.log` B3 shape (four targets 41,399 / 34,093 / 24,352 /
        // 17,046 against a 44,597-token floor, all four resolving to one identical 206,159-token
        // request). The user-visible cost is conversation erased that the context window never
        // asked for, which is what "the size refusal should never have happened" is about: the
        // prevention is the headroom buffer, and a pass that over-cuts spends history instead.
        //
        // THE FIX: scale the part the transcript pass owns and add the floor back unchanged, so
        // the budget the loop is handed and the `floor + body` figure it stops on are the SAME
        // currency with ONE subtraction. `floor` cancels out of the ratio, which keeps a
        // catalogue-free round (`floor = 0`, every fake-api case that does not name a floor)
        // byte-identical to `max(1, floor(tokens × ladder))`, and it puts the target ABOVE the
        // floor on a catalogue-dominated round — the regime where a candidate can exist at all, so
        // the loop stops at the FIRST message budget whose true request fits instead of emptying
        // the transcript. The rung stays strictly decreasing in `payload₀`, and monotone in the
        // amount it removes, so the `no-progress` gate keeps the semantics it was accepted with:
        // a rung that cannot come back strictly smaller than the figure this sequence already sent
        // still ends the ladder, and `overflowBest` still baselines on `planned.sentTokens`.
        const rungBudget = floor + Math.max(1, Math.floor(Math.max(0, tokens - floor) * ladder));

        // THE FIT LINE — the one figure a summarize request is held to, shared with the trigger
        // above and the dead-run guard above that. It is `effective` on BOTH branches (an over-limit
        // round and a headroom round): the firing point the headroom buffer sits below, and the
        // figure the clamp below was already using before this fix — which is why every
        // catalogue-free case (`floor = 0`, all the fake-api tests) and every small-catalogue case
        // (X1: a 18,844 floor under a 24,250 line) keeps the exact numbers it shipped with.
        //
        // The one case that CANNOT use `effective` is a floor at or above it: a catalogue that sits
        // inside the buffer band of its own ceiling, which the guard immediately above has just
        // established is NOT a dead pass because the CEILING is still reachable (X2, F3). No request
        // this pass can build is under `effective` — `floor + 1 char` already misses it — so chasing
        // it walks pass B to the bottom, which is the over-cut this fix is about, with a different
        // number printed on the report. What decides a refusal on that deployment is the ceiling, so
        // the ceiling is the honest line there: the ladder stops at the first request that actually
        // fits it. NOTHING about the trigger changes — Rules 2 and 3 still compare this turn's
        // estimate against `effective`, headroom and all.
        const fitLine = effective > floor ? effective : ceiling;

        // THE CLAMP, unchanged in its reason: on an over-limit round the rung fraction of the
        // refused size is above the ceiling BY DEFINITION — 85% of 121% of the limit is still over
        // the limit — so clamping is what makes the target one the provider could actually answer.
        // `rungBudget`, `fitLine` and the ladder's `floor + body` measurements are one currency
        // (billed request size), which is the claim every figure in the shrink report makes.
        const shrinkTo = armed || atWindow ? Math.min(fitLine, rungBudget) : undefined;

        // THE PLAN, computed BEFORE the pass parks anything (see `planSummarizeRequest`): the
        // no-progress gate below has to know what this rung would actually send before it is
        // allowed to spend a model turn on it, and `beginSummarize` consumes the same object, so
        // the measurement is paid for exactly once either way.
        const planned = planSummarizeRequest(context.messages, tokens, shrinkTo);

        // THE NO-PROGRESS GATE (X2, F2). An armed round exists because the provider refused a
        // request for size, so its whole purpose is to send a SMALLER one. The rung targets come
        // down strictly (`SHRINK_LADDER`), but a target below what the transcript pass can remove
        // is reached by removing everything removable — and then every deeper rung reaches ITS
        // target the same way and sends the IDENTICAL request. That is the measured failure: four
        // rungs, four refused round trips, one identical 206,159-token figure each
        // (`Temp/review-v2/probe-b.log` B3), with the give-up arriving only after the fourth. The
        // gate therefore keys give-up on PROGRESS: once a rung cannot come back strictly smaller
        // than the figure this sequence already sent and was refused at, no deeper rung can either
        // (a smaller target removes no less), so the ladder stops here rather than at the rung
        // counter, and it stops WITHOUT a park, WITHOUT a committed instruction and WITHOUT the
        // provider round trip — one refusal now costs one shrunk attempt, not four.
        //
        // The baseline is per sequence and is recorded the moment a shrunk request is actually
        // sent (below), so the FIRST rung of a sequence is never judged against anything: the
        // figure that was refused belongs to the ordinary run request, which this pass never
        // measured. `atWindow` passes (prevention, not reaction) are outside the gate: nothing has
        // been refused, and the ordinary request is what was going to go out anyway.
        if (shrinkTo !== undefined && armed) {
            const refused = overflowBest.get(context.threadId);

            if (refused !== undefined && planned.sentTokens >= refused) {
                overflowRung.delete(context.threadId);
                overflowSpent.add(context.threadId);
                overflowBest.delete(context.threadId);

                api.report.diagnostic({
                    message:
                        `context-compaction stopped the shrink ladder on thread ${context.threadId} at rung ` +
                        `${(rung ?? 0) + 1} of ${SHRINK_LADDER.length}: this rung's request measures ` +
                        `~${planned.sentTokens} billed estimated tokens against the ~${refused} the provider just ` +
                        `refused for size, so the planner is already at the smallest request this transcript can ` +
                        `send (${planned.floor} of those tokens is the request's irreducible floor) and no deeper ` +
                        `rung of the ladder could send anything smaller. Compaction stops rather than spending a ` +
                        `model turn per rung to re-learn the same refusal; it reacts again as soon as a pass ` +
                        `succeeds or a fresh refusal arrives with a different transcript.`,
                    data: {
                        mode: MODE_SUMMARIZE,
                        threadId: context.threadId,
                        stage: 'no-progress',
                        rung: (rung ?? 0) + 1,
                        ladder: SHRINK_LADDER.length,
                        target: shrinkTo,
                        from: refused,
                        to: planned.sentTokens,
                        floorTokens: planned.floor,
                        exhausted: true
                    }
                });

                return undefined;
            }

            // The rung IS smaller than anything this sequence has been refused at, so it earns the
            // round trip — and becomes the baseline the next rung is judged against.
            overflowBest.set(context.threadId, planned.sentTokens);
        }

        return beginSummarize(context, effective, tokens, shrinkTo, planned);
    };

    // The edge that ends `compacting`: a tool-free assistant turn IS the compaction answer
    // (the instruction asked for exactly one). A disobedient model that answered with a
    // tool call keeps the phase — the pass stays open until it does answer in prose, and
    // the turns it spent in between are disabled by the range anyway
    // (`planCompactionRetention`).
    const turnAfter: HarnessLifecycleHandler<'turn.after'> = (payload) => {
        const threadId = payload.threadId;

        if (threadId === undefined) return undefined;
        if (phases.get(threadId) !== 'compacting') return undefined;
        if (!isAnswerMessage(payload.message)) return undefined;

        phases.set(threadId, 'finishing');

        // THE LADDER RESETS HERE, not at the finalize: the provider ANSWERED a request that
        // arrived whole, which is the whole definition of "the overflow is resolved". The next
        // refusal — possibly the very next turn — starts again at rung 1, and a thread that has
        // spent its ladder stops being spent by one good request.
        overflowRung.delete(threadId);
        overflowSpent.delete(threadId);
        // The no-progress baseline belongs to the sequence that just succeeded (X2, F2): the
        // next refusal starts a fresh ladder with a fresh baseline, measured against whatever the
        // next request actually is.
        overflowBest.delete(threadId);

        // Load-bearing, not cosmetic: `thread.idle` fires only on a real transition to idle
        // (src/harness.ts ~10227), and the idle-path finalize below needs that transition.
        // The record goes back to 'running' here because this run is still attached.
        unpark(threadId);

        // ── Compaction inside a DELEGATED run: continue in the SAME run ─────────────────────
        // A delegation answer travels back as the DELEGATE TOOL RESULT, whose `content` is the
        // LAST assistant message of the awaited child run (src/harness.ts:5061-5070 builds the
        // envelope from `message`). If compaction lets that run end on its own summary, the whole
        // delegated task is answered with that meta-text, while the real answer — produced by the
        // out-of-band nudge continuation the idle hook starts, in a run the parent stopped
        // awaiting — is orphaned on the child thread (src/harness.ts:13525 -> 13547). That is the
        // reported defect: a green, "finished" child whose parent was answered with a summary.
        //
        // So for a child run the continuation is queued INTO the run that is still running. The
        // chain, in the order the harness runs it:
        //   1. `steer` appends the nudge to `thread.queue` and marks the live run dirty
        //      (src/harness.ts:7367-7422, `markRunDirty`: src/harness.ts:8409);
        //   2. back in this turn's terminal branch, `run.dirty` is set, so the run takes another
        //      turn instead of resolving (src/harness.ts:12813-12819) — and that branch emits
        //      `attempt_commit`, NOT `done`, so the summary never folds the thread row green
        //      (src/server/turn-projector.ts, src/frontend/ui/turns.ts read `done.pending`);
        //   3. the top-of-loop drain (src/harness.ts:12669) appends the nudge as the next USER
        //      turn of the SAME run, so its request is a fresh boundary;
        //   4. that boundary finds the phase 'finishing' and `finalizeInRequest` withholds the
        //      superseded range through `setIncluded` — the same lazy-write shape the host flow
        //      pins at src/plugin/context-compaction.test.ts:2713;
        //   5. the run ends on the real answer, which is what the parent's envelope carries.
        let continuedInRun = false;
        if (payload.depth >= 2) {
            // `payload.depth` is the delegation-chain depth the runner computes for every run
            // (src/harness.ts:13315-13320, and it is NOT on the `turn.before` payload — only on the
            // `run.*`/`turn.*` identity block, src/types/index.ts:4990-4998): 1 is a host
            // submission on the main thread (and a branch run, which has no persistent thread to
            // compact), >= 2 is a run a tool started — `delegate`, or an explicit `ctx.run` bound
            // to a durable conversation. A depth-1 run keeps the historical host flow untouched:
            // the submission promise resolves on the summary and the nudge continuation runs as a
            // second run.
            let refusal: string | undefined;

            try {
                // THE RECEIPT IS THE ARBITER, not the absence of a throw: `steerThread` answers
                // `{ queued: false, reason }` (src/harness.ts:7407-7413) when the conversation has
                // no queueable run attached — status not `running`, or no live `state.run` — and
                // `drainThreadQueue` (src/harness.ts:12439-12441) would then return false on an
                // empty or missing queue, i.e. the nudge would be queued into a state that cannot
                // drain it. Queuing into a conversation that cannot drain it is worse than not
                // queuing at all, so only a `queued: true` receipt counts as the in-run path.
                const receipt = api.threads.steer(threadId, CONTINUATION_NUDGE);

                continuedInRun = receipt.queued;

                if (!continuedInRun) {
                    refusal = receipt.reason ?? 'the conversation refused the steering';
                }
            } catch (error) {
                // Unknown or already purged conversation.
                refusal = error instanceof Error ? error.message : String(error);
            }

            if (refusal !== undefined) {
                // Neither a refusal nor a throw is a failure: the idle hook below still sends the
                // nudge out of band, exactly the pre-fix behavior, which leaves the run ending on
                // the summary and the tool result carrying it. The operator is told which shape
                // this was, because it is the shape where the reported defect stays visible.
                api.report.diagnostic({
                    message:
                        `context-compaction thread ${threadId} could not queue the compaction continuation inside ` +
                        `the running child (${refusal}). The continuation will be sent out-of-band instead, so the ` +
                        `delegate tool result stays the summary.`,
                    data: { mode: MODE_SUMMARIZE, threadId, iteration: payload.iteration, stage: 'continue' }
                });
            }
        }

        api.report.diagnostic({
            message:
                `context-compaction thread ${threadId} answered its compaction instruction on turn ` +
                `${payload.iteration}; the conversation is un-parked and the superseded range is withheld ` +
                (continuedInRun
                    ? `on the continuation turn this same run now owns.`
                    : `at the next boundary (or now, if this was the run's last turn).`),
            data: {
                mode: MODE_SUMMARIZE,
                threadId,
                iteration: payload.iteration,
                // Marks the pass whose answer is owed to a parent: the fold happens in this run
                // rather than on the next boundary, and one report per pass is kept.
                ...(continuedInRun ? { continuedInRun: true } : {})
            }
        });

        // The pass needs no explicit de-duplication: the continuation turn's own `turn.before`
        // consumes the 'finishing' phase through `finalizeInRequest`, which deletes the phase and
        // emits the single finalize report, and this handler is gated on 'compacting' (line 1615).
        return undefined;
    };

    // The run ended ON the compaction answer — the normal case, and the only moment the
    // committed transcript may be rewritten wholesale.
    const threadIdle: HarnessLifecycleHandler<'thread.idle'> = (payload) => {
        const threadId = payload?.id;

        if (typeof threadId !== 'string') return undefined;
        if (phases.get(threadId) !== 'finishing') return undefined;

        const outcome = finalizeOnIdle(threadId);

        // Whatever the rewrite did, the park must not survive the pass.
        unpark(threadId);

        if (outcome === 'nothing') return undefined;

        // The continuation. The run that just ended resolved on the SUMMARY, so without
        // this the conversation would sit idle mid-task. `send` is the host-shaped turn
        // (a parked record would even be revived by it), the promise is deliberately
        // dropped, and the run queues behind the dying one's actor lock
        // (`acquireAgent`, src/harness.ts ~9700) — which is what lets its first request
        // project the compacted transcript rather than the pre-finalize one.
        try {
            void Promise.resolve(api.threads.send(threadId, CONTINUATION_NUDGE)).catch(() => undefined);
        } catch {
            // A send that refuses synchronously (a purged thread, a stopped conversation)
            // leaves the conversation idle with its context compacted — an idle thread the
            // host can wake, which is strictly better than a plugin that retried forever.
        }

        return undefined;
    };

    // The safety nets. A summarize pass that never reached its answer must still leave a
    // conversation the host can use: the park is the only durable thing it touched.
    //
    // Whether a `compacting` pass whose run terminated anyway still OWES the transcript a fold:
    // both the injected instruction and its prose answer are committed in the conversation. That
    // state is reachable without `turn.after` ever promoting the phase, and the hook bus is NOT
    // a cause of it: src/plugin/hooks.ts rule 2 (FAIL-OPEN) runs the remaining handlers even
    // when one throws, so a sibling subscription cannot swallow this hook. What can skip the
    // hand-off is the answering turn never REACHING the `turn.after` emit at all — the throws
    // between the turn's commit and that emit (tool-call id integrity src/harness.ts:12694-12707,
    // the autoanswer contract :12712-12716, the state-change notify :12721) leave a committed
    // answer in a conversation whose run then fails or finishes, and an out-of-loop write (a host
    // `replaceMessages`, a restore, another lane answering our instruction) leaves the same shape
    // with no emit at all. Which cause it was does not matter to this hook: the probe reads the
    // transcript, so a pass whose instruction and answer still stand is carried forward and one
    // they rolled back is not. It is also the only net case that has work in flight: the answer
    // exists, so the superseded range still has to be withheld and the conversation still has to
    // be continued. A transcript this hook cannot read (purged thread, host-refused read) counts
    // as "no answer", so the nets keep their historical abandon path instead of rewriting a
    // transcript they never saw.
    const hasCommittedCompactionAnswer = (threadId: string): boolean => {
        try {
            const range = planCompactionRetention(api.threads.messages(threadId));

            // `answerIndex === -1` is the ordinary abandoned pass: the instruction went in and the
            // model never answered in prose. `planCompactionRetention` would then withhold
            // everything before the instruction with no summary to stand in for it, so the fold
            // needs BOTH ends of the range.
            return range.instructionIndex !== -1 && range.answerIndex !== -1;
        } catch {
            return false;
        }
    };

    const runFinished: HarnessLifecycleHandler<'run.finished'> = (payload) => {
        const threadId = payload.threadId;

        if (threadId === undefined) return undefined;

        const phase = phases.get(threadId);

        if (phase === undefined) return undefined;

        // T11/D2 — the UNPARK covers any active phase, matching `runFailed`'s
        // unconditional one. The asymmetry it closes: this hook used to bail out unless the
        // phase was `compacting`, so a pass sitting in `finishing` with the park still held
        // would strand the record — `thread.idle` fires only on a real transition to idle
        // (src/harness.ts ~10298), and a 'paused' record never makes one, so neither the
        // finalize nor the continuation nudge would ever run. That combination is only
        // reachable pathologically (`turn.after` unparks in the same handler that sets
        // `finishing`, so it needs a throw between the two), and lifting here is what turns
        // it into a recoverable one: the run's own terminal `finally` then moves the record
        // 'running' → 'idle', `thread.idle` fires with the phase intact, and the idle-path
        // finalize below does the rest.
        //
        // `finishing` itself still survives this hook (only `compacting` clears): the
        // `thread.idle` that follows it in the same `finally` is where the range is written,
        // and that path needs the phase.
        //
        // THE SECONDARY DEFECT THIS CLOSES: clearing a `compacting` phase used to be
        // unconditional, which silently destroyed the one thing that same `thread.idle`
        // (src/harness.ts:13821) is gated on. When the transcript already holds instruction AND
        // answer, the pass is not abandoned — its fold and its continuation nudge would simply
        // never happen, leaving the superseded range in context forever and the conversation idle
        // mid-task. So the net PROMOTES to `finishing` whenever an answer is actually there to
        // fold, and the idle hook does the rest; anything else keeps the abandon path below.
        let carriedToIdleFinalize = false;

        if (phase === 'compacting') {
            if (hasCommittedCompactionAnswer(threadId)) {
                phases.set(threadId, 'finishing');
                carriedToIdleFinalize = true;
            } else {
                phases.delete(threadId);
                // DISPLAY LANE (C1): the pass ended without ever producing a compaction
                // answer, so the instruction it committed never became a summary. The lane it
                // raised on the way in is undone here, or every later turn of this conversation
                // would be drawn one row too low with no boundary that happened.
                //
                // THE RESIDUAL: this restores the COUNTER only. Events the recorder already
                // stamped carry the bumped lane verbatim (../server/sessions.ts stamps at record
                // time and nothing rewrites a stored event), so an abandoned pass can leave the
                // boundary turn's bar showing the bumped row — the conversation may show one
                // empty row in its context bar, exactly as the refused-write diagnostic in
                // `revertLaneBump` says.
                revertLaneBump(threadId);
            }
        }

        // A no-op in the ordinary `finishing` case — `turn.after` un-parked two hooks
        // earlier — which is also why no report is emitted for it: the pass is not
        // abandoned there, and the finalize report below already covers it.
        unpark(threadId);

        if (carriedToIdleFinalize) {
            // Not an abandonment, and not a silent lift either: the pass is handed to the idle
            // finalize, which reports the range it withholds and sends the continuation.
            api.report.diagnostic({
                message:
                    `context-compaction thread ${threadId} had its run end before the turn.after hand-off, but the ` +
                    `compaction answer is committed: the pass is carried to the idle finalize, which withholds the ` +
                    `superseded range and sends the continuation nudge.`,
                data: { mode: MODE_SUMMARIZE, threadId, hook: 'run.finished', phase: 'finishing' }
            });

            return undefined;
        }

        if (phase !== 'compacting') return undefined;

        api.report.diagnostic({
            message:
                `context-compaction abandoned its summarize pass on thread ${threadId}: the run ended ` +
                `without a compaction answer. The park was lifted; nothing was withheld.`,
            data: { mode: MODE_SUMMARIZE, threadId, hook: 'run.finished' }
        });

        return undefined;
    };

    const runFailed: HarnessLifecycleHandler<'run.failed'> = (payload) => {
        const threadId = payload.threadId;

        if (threadId === undefined) return undefined;

        // THE OVERFLOW ARM (2026-11-17, the deadlock). BEFORE the phase guard, because the
        // refusal this reacts to is usually not a compaction failure at all: it is the
        // conversation's own request being refused, on a thread that never started a pass
        // (no phase), or the summarize request being refused before the model ever answered.
        // Both cases need the same answer — the next boundary sends less — and neither of them
        // gets the park-lifting below, which a thread with no phase has nothing to lift.
        //
        // The code is the contract with the transport and the agent's pre-request floor
        // (`transport/openai.ts` `CONTEXT_OVERFLOW_CODE`, reused by `core/agent.ts` when it
        // refuses to send at all); the message prefix is the same fallback
        // `core/agent.ts` `isContextOverflowFailure` applies for a relay that cannot carry a
        // code, so a gateway that flattens the frame into prose is still recognised here.
        const code = (payload.error as { code?: unknown } | undefined)?.code;
        const reason = (payload.error as { message?: unknown } | undefined)?.message;
        const overflow =
            code === CONTEXT_OVERFLOW_CODE ||
            (typeof reason === 'string' && reason.startsWith(`${CONTEXT_OVERFLOW_CODE}:`));

        if (overflow) {
            const next = (overflowRung.get(threadId) ?? -1) + 1;
            const spent = next >= SHRINK_LADDER.length;

            if (spent) {
                overflowRung.delete(threadId);
                overflowSpent.add(threadId);
                // The sequence is over (X2, F2), so the baseline goes with it — a fresh refusal
                // after this one starts a new ladder and must not be judged against a figure
                // measured on a transcript that has since changed size.
                overflowBest.delete(threadId);
            } else {
                overflowRung.set(threadId, next);
                overflowSpent.delete(threadId);
            }

            // The other half of the fix: an overflow is the ONE failure this plugin can answer
            // with a DIFFERENT request, so the Rule-3 re-trigger watermark must not mute the
            // retry. Every other failure keeps its damping (the pass would otherwise repeat on
            // every turn of a run that is failing for a reason compaction cannot reach).
            triggered.delete(threadId);

            const ratio = spent ? 0 : SHRINK_LADDER[Math.min(next, SHRINK_LADDER.length - 1)];

            api.report.diagnostic({
                message: spent
                    ? `context-compaction thread ${threadId} was refused for size (code ${CONTEXT_OVERFLOW_CODE}) ` +
                      `for the ${SHRINK_LADDER.length}th time: the transcript is not what exceeds the window — a ` +
                      `tool registry the estimate cannot see, or a window smaller than one turn — so compaction ` +
                      `stops reacting until a pass succeeds rather than spending a model turn per turn.`
                    : `context-compaction thread ${threadId} was refused for size (code ${CONTEXT_OVERFLOW_CODE}). ` +
                      `The re-trigger cooldown is cleared and the next boundary compacts regardless of the ` +
                      `estimate, sending the request cut to ${Math.round(ratio * 100)}% of the projection ` +
                      `(shrink rung ${next + 1} of ${SHRINK_LADDER.length}) so the provider cannot refuse it for ` +
                      `the reason it just refused a larger one.`,
                data: {
                    mode: MODE_SUMMARIZE,
                    threadId,
                    hook: 'run.failed',
                    stage: 'overflow',
                    rung: spent ? SHRINK_LADDER.length : next + 1,
                    ladder: SHRINK_LADDER.length,
                    ratio,
                    exhausted: spent
                }
            });
        }

        const phase = phases.get(threadId);

        if (phase === undefined) return undefined;

        // A failed run has ALREADY rolled back everything this pass committed — the failure
        // catch truncates the transcript to where the run started (src/harness.ts ~9677),
        // instruction and summary included — so a `compacting` pass has nothing left to
        // write and its phase goes with it. A `finishing` pass keeps its phase on purpose:
        // if the summary survived (the failure came later), the next `turn.before` writes
        // the range from the surviving entries, and if it did not, that boundary finds no
        // instruction and clears the phase itself. What never survives is the park: a
        // thread left 'paused' is a conversation its host cannot reach.
        //
        // The rollback assumption is what the transcript probe below checks instead of
        // trusting: when it DID roll back (the usual case) there is no answer to find and this
        // hook abandons as before; when an answer survived, this hook hands the pass to the
        // idle finalize exactly as `runFinished` does.
        let carriedToIdleFinalize = false;

        if (phase === 'compacting') {
            if (hasCommittedCompactionAnswer(threadId)) {
                // Same hand-off as `runFinished`: something DID survive this run's rollback
                // (the failure landed after the answer was committed), so the range it describes
                // must still be withheld and the conversation still has to be continued.
                phases.set(threadId, 'finishing');
                carriedToIdleFinalize = true;
            } else {
                phases.delete(threadId);
                // DISPLAY LANE (C1): the run's rollback took the instruction and any answer
                // back out of the transcript, so this pass left nothing behind and its lane
                // bump is undone with the rest. A `finishing` pass keeps its bump: its summary
                // may well have survived (the failure came later), and the next boundary owns
                // that decision.
                //
                // THE RESIDUAL: as in `runFinished`, only the COUNTER comes back — events the
                // recorder stamped while the lane was raised keep their bumped `lane` key
                // (../server/sessions.ts), so this abandoned pass can leave the boundary turn's
                // bar showing the bumped row: one empty row in its context bar, the same
                // cosmetic cost the refused-write diagnostic in `revertLaneBump` reports.
                revertLaneBump(threadId);
            }
        }

        unpark(threadId);

        if (carriedToIdleFinalize) {
            api.report.diagnostic({
                message:
                    `context-compaction thread ${threadId} had its run fail before the turn.after hand-off, but the ` +
                    `compaction answer survived the rollback: the pass is carried to the idle finalize, which ` +
                    `withholds the superseded range and sends the continuation nudge.`,
                data: { mode: MODE_SUMMARIZE, threadId, hook: 'run.failed', phase: 'finishing' }
            });

            return undefined;
        }

        api.report.diagnostic({
            message:
                `context-compaction lifted its park on thread ${threadId} after a failed run ` +
                `(phase ${phase}); the run's own rollback removed anything the pass had committed.`,
            data: { mode: MODE_SUMMARIZE, threadId, phase, hook: 'run.failed' }
        });

        return undefined;
    };

    return { turnBefore, turnAfter, threadIdle, runFinished, runFailed };
};

// The `turn.before` half on its own: the trigger check, the per-thread cooldown, and the
// pause/action/resume sequence. Kept as the public shape a host uses to reuse the shipped
// guard with its own action (`exclude` mode is complete inside it); a host that wants the
// summarize flow wires all five passes, which is what `setup` below does.
export const createContextCompactionHandler = (
    api: HarnessPluginApi,
    action: HarnessCompactionAction = executeCompaction
): HarnessLifecycleHandler<'turn.before'> =>
    createContextCompactionPasses(api, action).turnBefore;

// Wiring only: the framework hands the scoped api, the guard owns the behaviour. The
// five subscriptions are the phase machine — one handler per edge, and the declared
// `metadata.hooks` list is exactly this list (the server shows that list to the operator).
// The arrow form (not a reference) is what the manifest scanner's `setup` regex requires.
export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    const passes = createContextCompactionPasses(api);

    api.on('turn.before', passes.turnBefore);
    api.on('turn.after', passes.turnAfter);
    api.on('thread.idle', passes.threadIdle);
    api.on('run.finished', passes.runFinished);
    api.on('run.failed', passes.runFailed);
};

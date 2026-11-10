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
// `contextLimit` IS the firing point. There is no second number beside it: when a turn's
// `estimatedTokens` is at or above the effective limit, the pass fires on THAT turn. The
// effective limit is resolved per turn from the same inputs as before, minus the headroom:
//
//     resolved  = modelLimits[<current model>].limit ?? contextLimit
//     effective = model window is declared ? min(resolved, window) : resolved
//     trigger   = max(1, floor(effective))
//
// Each surviving input answers a different question:
//   - `contextLimit` is what the operator is WILLING to pay for, globally — and the exact
//     size compaction starts at, with no leeway subtracted. A former `gapTokens` headroom
//     (fire N tokens early because the answer grows the context) was removed at the
//     operator's request: one number, reached exactly, is the whole rule. What keeps a
//     blank pass from parking the same conversation every turn is the Rule-3 cooldown, not
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
// plugin does not guess: it degrades to "model unknown" — global limit, no window — and
// compacts at the limit itself. Malformed `modelLimits` JSON and unusable entries are
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
// instruction moved — and the answer is the compacted knowledge: what is done and still
// relevant, what the current task is and exactly where it left off, and what is pending.
//
// Then everything the summary replaced stops being SENT: every entry BEFORE the
// instruction, and the intermediate turns BETWEEN the instruction and that final answer,
// are flagged `included: false` (never deleted, never a system entry — the agent's
// instruction blocks stay). What the next request carries is the retained head
// `[instruction, summary]` plus whatever arrived after, which is the whole point: the
// context is small again and the agent still knows what it was doing.
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
//   1. ITS WRITER (the one that used to be considered the whole question) is compatible by
//      construction: it writes ONLY `included: false` flags through `setIncluded`
//      (src/plugins/context-trimmer.plugin.ts ~351) — no `setTranscript`, no
//      `replaceHistory`, nothing that re-ENABLES an entry. Anything it withholds in this
//      round rides along on the entries this pass commits back through `replaceHistory`,
//      and anything it withholds AFTER the finalize only makes the retained head smaller.
//      A pass that re-ENABLED entries would be the first thing needing a phase check here.
//
//   2. ITS HANDLER WRAPPER is NOT compatible, and that is what context T11 (D1) fixed.
//      On a round with candidates the trimmer runs `await context.pause(); try { writer }
//      finally { await context.resume(); }` (src/plugins/context-trimmer.plugin.ts
//      ~421-427) around a flag write. Before T11 that `resume()` lifted ANY 'paused'
//      record — including the park THIS pass took moments earlier on the same boundary —
//      so the trigger turn lost its observable paused-during-compaction window and the
//      `thread.paused`/`thread.resumed` pair an operator watches became `paused` +
//      `resumed` + `resumed`, on a turn where the compaction was still outstanding.
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
//                                     refused while a run is attached) and `send` (the
//                                     continuation nudge)
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
    description:
        'Watches each agent conversation against a context limit and, when the limit is reached, compacts the conversation at the turn boundary before the next model request is sent. In the default "summarize" mode the conversation does the work: the thread is parked, an instruction the plugin commits into the transcript is answered by this same agent with a summary of what is done, what it is working on and where it left off, and everything before that instruction (and the turns between it and the answer) stops being sent. The thread resumes with a nudge to continue, and the context is small again: the instruction plus the agent\'s own summary. The older "exclude" mode prunes only the tool units a later success already answered. Neither mode deletes anything: a withheld unit keeps its place in history and can be switched back on. The limit is the firing point: compaction starts as soon as the estimate reaches the effective limit, which is the per-model override for the model the conversation is running, capped by that model\'s declared context window when one is declared.',
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
            step: 1000,
            description:
                'The firing point: estimated tokens a conversation may reach before this plugin compacts it, measured with the ~4 characters/token estimate the UI context bar uses, anchored on the reported prompt size of the last request that reported usage — so after the first report it can differ from the bar by whatever the tool schemas and message framing actually cost. There is no separate headroom: the estimate at or above this number fires the pass on that turn. It is this value unless modelLimits overrides it for the model this conversation runs, or caps it at that model\'s declared context window. Set to 0 to turn compaction off for every model.'
        },
        {
            key: 'modelLimits',
            label: 'Per-model limits (JSON)',
            type: 'string',
            default: '{}',
            description:
                'A JSON object keyed by model id, each value `{ "limit": number, "window": number }` — both optional. `limit` replaces contextLimit for that model, for an operator who is willing to pay more (or less) for one model than for the rest. `window` states the model\'s HARD context window: it caps whatever limit is in force, so a 512000 ceiling on a 262144-token model still compacts around the 256k behaviour rather than waiting for a size the provider never accepts. Example: `{"gpt-4o": {"limit": 512000, "window": 131072}, "llama-8b": {"window": 8192}}`. The model id is read live from the agent, so switching models changes the ceiling on the next turn. Anything malformed — broken JSON, a value that is not an object, a non-positive or non-numeric limit — is ignored and the global limit applies, never an error.'
        },
        {
            key: 'enabled',
            label: 'Compact conversations',
            type: 'boolean',
            default: true,
            description:
                'Runs compaction on or off, in either mode. Off changes nothing else: the limit is still read, the context bar still measures, and no other plugin is affected. It is the switch an operator expects when they want the behaviour gone without removing the built-in.'
        },
        {
            key: 'minTokens',
            label: 'Minimum saving per pass (tokens)',
            type: 'number',
            default: 200,
            min: 0,
            step: 50,
            description:
                'A pass must withhold at least this many estimated tokens, or it does nothing at all — no flag write, no persistence notification, no save. A prune that saves 40 tokens is a provider prompt-cache invalidation for nothing, so this floor is what makes running on every turn cheap. Measured as a difference of the same estimate, so any provider anchor cancels out of it and only the withheld characters count. In "summarize" mode the same number is read the other way round, as a trivial floor on the LIVE estimate: a conversation smaller than this is never worth a compaction round trip, so the pass refuses rather than paying for a summary of a handful of turns. Set it to 0 to remove the floor, which a small per-model limit needs: a floor above that limit would never be crossed.'
        },
        {
            key: 'safetyTurns',
            label: 'Recent units to protect',
            type: 'number',
            default: 6,
            min: 0,
            step: 1,
            description:
                'How many units at the END of the conversation no pass may touch. A unit is one assistant tool-call block plus its results, or one standalone message. The horizon counts UNITS from the end, never the per-run turn counter: a failure the model has not moved past yet is the highest-signal thing in the window, and pruning it is how an agent repeats the call it just watched fail. 0 removes the horizon. It belongs to "exclude" mode; "summarize" mode needs no horizon because the recent tail is exactly what the agent is summarizing.'
        },
        {
            key: 'mode',
            label: 'Compaction mode',
            type: 'string',
            default: 'summarize',
            description:
                'Which compaction runs when the limit is reached. "summarize" — the default since the 2026-11-10 context-compaction ruling — parks the conversation at the turn boundary and lets its NEXT model turn write the summary: the agent condenses what is done, what it is working on and where it left off, everything before that instruction stops being sent, and the conversation resumes with a nudge. "exclude" is the earlier behaviour: a superseded tool unit keeps its place in canonical history and simply stops being sent, which is the reversible option the evidence favours and the cheaper one — no extra model turn. "annotate" — replace the result with a one-line handle back to the full text — is the planned SECOND WRITER over the same candidate list the policy already computes before writing anything, and any value other than these two (including that one) behaves as "exclude", the flow that cannot spend a model turn by accident. The value actually used is reported in the pass diagnostic.'
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
const COMPACTION_MARKER = '[context compaction]';

// The instruction the plugin commits into the transcript at the trigger. It asks for the
// three things the compacted context has to survive on — done-and-relevant, current task
// and where it stopped, pending work — and explicitly drops completed work that serves
// neither, which is what keeps the summary small instead of a transcript in prose. The
// tool ban is the agent's own guard rail: a compaction that stops to read a file spends
// another turn and re-enters the phase machine for nothing (still handled, see
// `turn.after`, but the summary is what this turn was for).
// Exported (not a private constant) because the finalize range and every test that names
// the committed turn need the exact text, not a copy that can drift from it.
export const COMPACTION_INSTRUCTION = `${COMPACTION_MARKER} Automated system prompt (not from the user): your context window has reached its limit. Compact your knowledge now. Reply with a single compact summary and nothing else:
1. DONE — work completed so far that is still relevant to your current or pending tasks. Omit completed work that is irrelevant to both.
2. CURRENT TASK — what you are working on right now and exactly where you left off, with the concrete details needed to resume (paths, ids, decisions, open questions, blockers).
3. PENDING — all remaining tasks, in order.
This summary will be your only retained memory of the earlier conversation: be specific but compact. Do not call tools and do not start any other work in this reply.`;

// The turn that restarts the conversation once the range is disabled. It points at the
// summary as the source of the next step, because after the finalize that is the ONLY
// memory of the work still standing — an imperative with no anchor reads as a new task.
export const CONTINUATION_NUDGE = `${COMPACTION_MARKER} Your context was just compacted; your summary above lists the current task, where you left off, and pending work. Continue your current task now.`;

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
    // max(1, floor(min(limit, window) when windowed, limit otherwise)) — the number
    // `estimatedTokens` is compared to. With no window it is the ceiling itself: the limit
    // IS the firing point, with no headroom subtracted.
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

// Resolves the number this turn's estimate is compared against. See the header section
// "THE TRIGGER POINT — ONE NUMBER" for what each input means and for why an unknown model
// degrades to the global limit instead of guessing.
export const resolveContextTrigger = (input: {
    // The global `contextLimit` setting. The caller has already refused a non-finite or
    // non-positive value (Rule 1: the plugin is off), so this is a real ceiling.
    contextLimit: number;
    // The validated per-model map (see `parseModelLimits`).
    modelLimits: Record<string, HarnessContextModelLimits>;
    // The model this conversation is running, when it is known (see `currentModelId`).
    modelId?: string;
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

    // The firing point is the ceiling itself — no headroom subtracted. `max(1, ...)` is the
    // only clamp: a ceiling so small it floors below one token (the test-suite's limit of
    // 100 is fine, but a host that stores 0.5 is not refused by Rule 1) fires at 1 token
    // rather than never. Flooring keeps the trigger an integer token count, matching the
    // estimate.
    const effective = Math.max(1, Math.floor(resolved));

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
// Every write goes through `context.setIncluded(entry, false)`, which cascades the unit:
// the assistant message that asked for the calls, every result of that block, and its
// request-only placeholders (../types `HarnessContextEntry.included`). That is why pruning
// can never leave the provider with a half-answered `tool_calls[]` (T3.4), and why this
// action never has to think about pairing — the projection oracle in
// src/harness.inclusion.test.ts is what pins it.
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
        // Located by index rather than reused from the plan, so a `replaceHistory()` from a
        // LATER handler in this same round cannot make this write address a stale entry: if
        // the unit the plan named is no longer in the transcript, the entry is absent and the
        // write is skipped. (An entry from an EARLIER handler is still refused by
        // `setIncluded` itself; this is the mirror-image hazard.)
        const entry = entries.find((candidate2) => candidate2.index === candidate.leaderIndex);

        if (entry === undefined) continue;

        // One write per unit; the cascade does the rest. `false` is the only stored spelling
        // of "withheld", so a second pass over the same transcript changes nothing at all.
        context.setIncluded(entry, false);
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
    // instruction must resolve against the one this pass committed.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (isInstructionMessage(messages[index])) {
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

    // threadId -> the in-flight pass. Bounded by the number of conversations a harness
    // ever had, exactly like the cooldown map above: the only way an entry outlives its
    // thread is a thread purged mid-pass, which leaves one stale key in a map nothing
    // prunes (see "WHY THE COOLDOWN MAP IS NEVER PRUNED").
    const phases = new Map<string, HarnessCompactionPhase>();

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
    const beginSummarize = async (
        context: HarnessTurnBeforeContext,
        effective: number,
        tokens: number
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

            // THIS request: the projection exactly as measured, plus the instruction. The
            // committed history and the request are written by two different calls on
            // purpose — `setTranscript` is request-only and wins over the round's
            // re-projection (src/harness.ts `requestOf`), while `replaceHistory` alone would
            // leave this request re-projected from the pre-commit list.
            context.setTranscript([
                ...context.messages,
                { role: 'user', content: COMPACTION_INSTRUCTION }
            ]);

            api.report.diagnostic({
                message:
                    `context-compaction parked thread ${threadId} and asked it to compact itself: ` +
                    `~${tokens} estimated tokens against an effective limit of ${effective} (mode summarize). ` +
                    `The next model turn carries the compaction instruction.`,
                data: { mode: MODE_SUMMARIZE, threadId, tokens, effective, entries: canonical.length + 1 }
            });
        } catch (error) {
            // A commit that failed has nothing to finalize. Drop the phase and lift the
            // park — a stranded park is the one failure this plugin may never cause — and
            // let the error reach the bus, the single fail-open authority (plugin/hooks.ts
            // rule 2). `resume()` is a no-op when the pause itself never landed.
            phases.delete(threadId);
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
            phases.delete(threadId);
            return;
        }

        for (const index of range.disabled) {
            // Located by index rather than reused from the range, so an entry the transcript
            // no longer carries is skipped instead of addressing the wrong turn — the same
            // guard `executeCompaction` follows.
            const entry = entries.find((candidate) => candidate.index === index);

            if (entry === undefined) continue;

            // One write per unit; the cascade widens a tool-call block to its results.
            context.setIncluded(entry, false);
        }

        phases.delete(threadId);

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
            phases.delete(threadId);
            return 'nothing';
        }

        const range = planCompactionRetention(messages);

        if (range.instructionIndex === -1) {
            phases.delete(threadId);
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
            return 'refused';
        }

        phases.delete(threadId);

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

        const { effective } = resolveContextTrigger({
            contextLimit: limit,
            modelLimits: limitsMap,
            modelId: currentModelId(api, context.agent)
        });

        // Rule 2: under the limit — clear the cooldown so the next crossing is fresh, and
        // return without touching the thread. `exclude` measures the entry-time estimate it
        // always measured; `summarize` measures the live one (see `liveEstimate`).
        const tokens = summarize ? liveEstimate(context) : context.estimatedTokens;

        if (tokens < effective) {
            triggered.delete(context.threadId);
            return undefined;
        }

        // The summarize floor (documented in the `minTokens` descriptor): below this size a
        // round trip costs more than the context it saves. Read only on a turn that is
        // already over the limit, so the hot path never pays for it — and NOT recorded in
        // the cooldown, so raising the floor back down re-arms the pass on the next turn.
        if (summarize) {
            const floor = api.settings.number('minTokens', MIN_TOKENS_DEFAULT);

            if (Number.isFinite(floor) && tokens < floor) return undefined;
        }

        // Rule 3: at or above the limit. Fire on a fresh crossing, or once the conversation
        // has grown by at least REGROWTH_RATIO of the effective limit since the last fire.
        // `max(1, ...)` keeps a margin for a limit so small that 5% rounds to 0 — otherwise an
        // unchanged estimate would fire on every turn again.
        const previous = triggered.get(context.threadId);
        const margin = Math.max(1, Math.floor(effective * REGROWTH_RATIO));

        if (previous !== undefined && tokens < previous + margin) {
            return undefined;
        }

        // Recorded BEFORE the action: a failing action must not be retried on the very
        // next turn, and the value stored is the size this pass was asked about.
        triggered.set(context.threadId, tokens);

        return summarize
            ? beginSummarize(context, effective, tokens)
            : pass(context);
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

        // Load-bearing, not cosmetic: `thread.idle` fires only on a real transition to idle
        // (src/harness.ts ~10227), and the idle-path finalize below needs that transition.
        // The record goes back to 'running' here because this run is still attached.
        unpark(threadId);

        api.report.diagnostic({
            message:
                `context-compaction thread ${threadId} answered its compaction instruction on turn ` +
                `${payload.iteration}; the conversation is un-parked and the superseded range is withheld at the ` +
                `next boundary (or now, if this was the run's last turn).`,
            data: { mode: MODE_SUMMARIZE, threadId, iteration: payload.iteration }
        });

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
        if (phase === 'compacting') phases.delete(threadId);

        // A no-op in the ordinary `finishing` case — `turn.after` un-parked two hooks
        // earlier — which is also why no report is emitted for it: the pass is not
        // abandoned there, and the finalize report below already covers it.
        unpark(threadId);

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
        if (phase === 'compacting') phases.delete(threadId);

        unpark(threadId);

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

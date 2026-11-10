// Context Trimmer — the shipped preset plugin (R5).
//
// WHAT THIS FILE DOES
// -------------------
// At the START OF EVERY ASSISTANT TURN (`turn.before`, before `brain.turn()` is asked for
// anything), this plugin walks the conversation and switches off the tool units a later
// success has already replaced: a unit whose every committed result `failed` or was
// `rejected` stops being sent as soon as some LATER unit answers the same TOOL by NAME with
// a `completed` result. The write is the shipped `setIncluded(leader, false)` flag, which
// cascades the whole unit — the assistant block that asked for the calls AND every tool
// result answering one of them — so the paired call+answer the user described leaves the
// context together and the provider request stays pair-clean. Nothing is deleted: a trimmed
// unit keeps its place in canonical history and a host (or the UI) can switch it back on.
//
// HOW IT DIFFERS FROM CONTEXT COMPACTION (and the switch that decides how much)
// -----------------------------------------------------------------------------
// ../plugins/context-compaction.plugin.ts prunes only when the later unit reruns the SAME
// WORK: `toolCallFingerprint(name, canonicalArguments)` equality. This plugin's primary rule
// matches on the tool NAME alone, deliberately looser, per the ratified rule: a failed call
// followed later by a successful call of the same tool is ~99% superseded work, whether or not
// the retry used the same arguments (the typical shape is `read("a.ts")` failing and
// `read("b.ts")` answering the question the agent actually had). `supersedeMatch` is THE switch
// that picks which matcher the evidence rule uses — `'name'` is the default (behaviour-neutral)
// and `'fingerprint'` makes the two passes agree by construction, name AND canonical arguments
// — and the value in force is reported either way. `dropDuplicateCalls` is the one rule that is
// fingerprint-only whatever that switch says, because it can withhold a unit whose answers the
// model actually read. The looseness is bounded by everything else being as strict as
// compaction's:
//   - the unit's committed results must all be invalid outcomes (`failed`/`rejected` under the
//     shipped rule; whatever `invalidOutcomes` names under the generalisation, see "THE EFFECTIVE
//     OUTCOME MAPPING" below) and it must be FULLY answered — an unanswered block, and a unit
//     mixing a healthy answer with an invalid one, is never touched;
//   - EVERY name the failed block called must have a later `completed` answer — per NAME, so
//     the answers may sit in different later units (compaction additionally demands the whole
//     work set inside ONE unit). The choice stays all-or-nothing at UNIT granularity: half a
//     block staying is worse than the whole block, and the failed half's result is what the
//     model would lose;
//   - every answering unit must itself be INCLUDED: a resolver that is already withheld is not
//     evidence, because then the model would see neither the failure nor the answer;
//   - strictly LATER by transcript position, because that is the only ordering the model
//     experiences.
//
// WHY THE ECONOMY KNOBS DEFAULT TO 0 (and what they do when they are not)
// ----------------------------------------------------------------------
// Compaction is an expensive, rare, whole-conversation event, so it is guarded by a limit, a
// savings floor, a tail horizon and a per-thread cooldown. Trimming's OWN argument against those
// guards is still true at the declared defaults: it is one flag write per superseded unit, it is
// idempotent by construction (an already excluded unit is skipped, so a second pass writes
// NOTHING and therefore produces no persistence notification and no save), and a unit can only
// ever be trimmed once the answer exists somewhere above it. A tail horizon also fights the
// feature's purpose: a failure the model just replaced with a success is exactly the pair that is
// safe to drop from the NEXT request. That is why `minTokens`, `safetyUnits` and `maxUnits` all
// DEFAULT to 0, and at 0 each gate is a pass-through, so the shipped request is untouched.
//
// The argument has two soft spots once this plugin is the ONLY trimmer (F4 of the task entry), and
// the knobs are the operator's levers for them: a first pass over a conversation restored weeks
// ago withholds every superseded unit at once, and a per-turn pass with no floor can invalidate a
// provider's prompt cache to save 40 tokens. So the combined TOOL candidate set — both tool rules,
// before anything is written — runs the gates in this fixed order:
//   1. `safetyUnits` drops every candidate whose unit sits in the LAST n UNITS of the transcript,
//      counted exactly like compaction's `safetyTurns` (`../core/context-pruning.ts:372-377`):
//      units from the END of the transcript, never the per-run `iteration`, which counts model
//      steps inside one run and cannot express a conversation-level position;
//   2. `maxUnits` caps what is left, oldest-first (`0` is UNBOUNDED here, which is this plugin's
//      documented default — compaction's own `slice(0, maxUnits)` would turn 0 into "nothing");
//   3. `minTokens` measures the SELECTED set with the shipped estimator and, when the total is
//      below the floor, the plan comes back EMPTY — no flag, no notification, no save and no
//      diagnostic (D4 #5). Half a batch below the floor is the cache churn the floor exists to
//      avoid, so the floor rejects the WHOLE pass, as compaction T4.1 does.
// Cap-before-floor is the order, and it is deliberate: the cap decides what the pass would do, and
// the floor then decides whether that is worth doing at all. A floor measured on the uncapped set
// would let a pass proceed and then write an unknown number of units.
//
// THE TOKENS COME FROM THE SAME ESTIMATOR THE CONTEXT BAR USES (F invariant 7). The figure is the
// delta of `estimateContextTokens` over the whole transcript minus the same estimate with the
// selected members removed — the computation `../core/context-pruning.ts` `withheldTokensOf` does
// for compaction. That helper is PRIVATE to the core module (only `planContextPruning` and its
// `PrunePlan` expose the number), so the delta is mirrored here, one function, same estimator, same
// clamp at 0. Nothing else in this file invents a token figure, and `minTokens` is scoped to TOOL
// writes on purpose: the estimator never counts `reasoning` (`../core/context-estimate.ts:34-35`),
// so a floor shared with the thinking writes would silently disable the thoughts switch above 0.
// The gate functions below therefore receive ONLY the tool candidates, and a thinking write is
// never measured in tokens — `minTokens` cannot suppress one at any value, and
// `context-trimmer.test.ts` pins that with an unreachable floor next to a thinking-only pass.
// `minThoughtChars` is the thinking twin: the SAME kind of floor, in CHARACTERS, applied to the
// thinking side's own selection (see "THE THINKING RULE" below).
//
// THE THINKING RULE (T6) — THE SECOND AXIS, AND WHY IT IS NOT A TEXT EDIT
// -----------------------------------------------------------------------
// `dropOldThoughts` withholds the model's own recorded thinking from the requests that follow.
// The write is the per-entry FLAG `reasoningIncluded: false` (`../types`
// `HarnessTurnBeforeContext.setReasoningIncluded`), NOT a destructive edit of `reasoning`: the
// text stays in canonical history, a host can switch it back on, and this plugin's own
// "nothing is deleted" promise (top of this file) holds for thinking exactly as it holds for
// units. The projection RESOLVES the flag out — a flagged entry is still EMITTED, with its
// `content` and `toolCalls` untouched, and its request copy omits `reasoning` ENTIRELY
// (`../core/agent.ts` `withoutWithheldReasoning`, run by `../harness.ts` `projectTranscript`), so
// the transport needs no new field: the ABSENCE of `reasoning` is the wire signal.
//
// THE BOUNDARY IS THE LAST `user` ENTRY, never `iteration`. The OPEN turn is every committed
// assistant entry after the last user entry in canonical order; everything at or before it is a
// CLOSED turn. `iteration` cannot express this (it counts model steps inside ONE run,
// `../types`), while the last-user-entry rule does it exactly: on `iteration === 1` the run's own
// user entry is the last entry, so every committed assistant entry is closed, and from
// `iteration >= 2` the run's earlier assistant turns sit after it and keep their thinking. A
// mailbox/autoanswer user message legitimately MOVES the boundary — it really does open a new
// turn in the same transcript — which is why the rule is read from canonical order every turn and
// never remembered.
//
// Tiers: `off` writes nothing at all; `turn` (the default) withholds the closed turns' thinking
// and leaves the open turn's alone; `all` withholds every committed thought including the open
// turn's. `thoughtKeepUnits` then RESCUES the N newest entries of whatever the tier would have
// withheld (counting only entries that actually carry thinking), and `minThoughtChars` rejects the
// whole thinking side when the rescue left fewer characters of thinking than the floor. The order
// is tier → rescue → floor, and the floor measures what would ACTUALLY be written.
//
// Withhold-only, like every other switch here: the plugin never writes `true`, so turning the tier
// down to `off` stops new writes and restores nothing an earlier turn already withheld (F
// invariant 2). The `true` side of the control exists for the operator and the host API.
//

// THE SWITCH SURFACE (the 2026-11-10 trimmer ruling)
// --------------------------------------------------
// The ENGINE core trims nothing: the projection is a pure skip filter over canonical history
// and nothing in it windows, truncates or elides (src/harness.ts `projectTranscript`). This
// built-in is therefore the ONE place trimming happens, and "one place" is not "one switch":
// a single `enabled` conflated "this plugin exists" with "this policy runs", so an operator
// who wanted old thinking withheld and superseded failures kept had no lever. The policy
// space is now declared as independent switches (`dropSupersededToolCalls` for the shipped
// rule verbatim, `dropInvalidToolCallsOnceAnswered` + `invalidOutcomes` for the generalised
// version, `dropOldThoughts` + `thoughtKeepUnits` for thinking, `supersedeMatch` and
// `dropDuplicateCalls` for strictness, `minTokens`/`minThoughtChars`/`safetyUnits`/`maxUnits`
// for economy), each with a default that leaves today's request byte-for-byte unchanged.
// Three rules every one of them obeys, and none of them is a boolean:
//   - WITHHOLD-ONLY inside a session: a switch flipped off stops NEW writes and restores
//     nothing an earlier turn already withheld. That is what lets the compactor skip any
//     phase check against this pass (../plugins/context-compaction.plugin.ts reasons about
//     exactly that), and each setting's text says so rather than letting it be discovered;
//   - UNIT-ATOMIC. Half a unit never leaves: provider pairing is unit-granular
//     (src/harness.ts's two exclusion passes) and the `edit` surface refuses a `toolCalls`
//     patch (src/types), so per-call elision is not expressible and stays not expressible;
//   - a `completed` result is never invalid on its own (only `dropDuplicateCalls`, on an
//     exact fingerprint match), an UNANSWERED unit is never touched, and a branch round or an
//     internal agent's transcript is never trimmed — no setting is even read on one.
//
// THE THREE TOOL RULES, AND WHICH SWITCH ADMITS WHAT (T4)
// -------------------------------------------------------
// One walk of the unit mirror produces ONE candidate list, and a unit can be admitted by more
// than one switch at once — the list carries `admittedBy` (every switch that admits it) and
// `firedBy` (the switch the report attributes it to, in DECLARED order). The rules:
//   1. `dropSupersededToolCalls` — the shipped predicate, VERBATIM: `kind === 'candidate'`, i.e.
//      core's own class for a fully answered block whose every committed result is `failed` or
//      `rejected` (`../core/context-pruning.ts:320-331`). With `supersedeMatch: 'name'` the whole
//      predicate is byte-for-byte what shipped before the switch split, and the pre-existing
//      tables are the proof.
//   2. `dropInvalidToolCallsOnceAnswered` + `invalidOutcomes` — the same shape over a WIDER set of
//      invalid results, expressed as a predicate over each committed result's EFFECTIVE outcome
//      (the mapping is below). Its guards are the shipped rule's guards, unchanged: the unit is a
//      still-included tool unit, every call of it is answered, every committed result is invalid,
//      and every name it called has a later still-included `completed` answer.
//   3. `dropDuplicateCalls` — a LATER unit re-ran the SAME work (fingerprint, never name) and
//      answered it healthily, so the earlier unit is redundant whatever it itself produced. This
//      is the rule that reaches `answered` units (F2's duplicate-successful-call class, the
//      largest redundancy in a long trajectory), and precisely because it can withhold work the
//      model read and used, it is off by default and strictly fingerprint-matched EVEN WHEN
//      `supersedeMatch` says `'name'`.
// Rules 1 and 2 share ONE evidence search (the matcher `supersedeMatch` picks); rule 3 has its own,
// fingerprint-only. Every rule ends in the SAME `setIncluded(leader, false)` and the SAME single
// diagnostic — one pass, one decision, one line per withheld unit.
//
// THE EFFECTIVE OUTCOME MAPPING — why `cancelled` and `empty` need their own predicate
// ------------------------------------------------------------------------------------
// The two names do NOT map onto core's classifier, and pretending otherwise would have made them
// no-ops: an all-`cancelled` block lands in `mixed`, and an empty-but-`completed` block lands in
// `answered`, so `kind === 'candidate'` never proposes either (`../core/context-pruning.ts:320-331`).
// So the generalisation judges each committed result by its EFFECTIVE outcome, computed ONCE and
// independent of what the operator configured:
//     failed   -> 'failed'      rejected -> 'rejected'
//     cancelled-> 'cancelled'   completed-> 'empty' when the result's text is blank, else 'completed'
// `cancelled` is read from the outcome key ONLY — an abandoned call has no content worth judging,
// which is why a cancelled result whose text happens to be blank is still `cancelled`, never
// `empty`. `empty` is therefore the only value that is ever READ OFF THE TEXT, and that is the
// whole reason the descriptor calls it dangerous: a `grep` with no matches is indistinguishable
// from a stub. `completed` (non-blank) is in no set the operator can name — `outcomeSetOf` drops
// it at parse time — so a healthy answer keeps its unit unless rule 3 applies.
//
// Two consequences of that mapping are load-bearing, and are pinned by tables:
//   - with the effective set ⊆ {failed, rejected} (the default), the generalisation's predicate IS
//     exactly rule 1's classifier: every result invalid under {failed, rejected} and fully
//     answered is core's own definition of `candidate`. The generalisation is then redundant with
//     the shipped switch, not a second opinion on it;
//   - a unit MIXING a healthy answer with an invalid one stays a keep under EVERY combination,
//     because a healthy answer's effective outcome is `completed`, which no set admits. Same for
//     an unanswered unit: every rule demands a fully answered block. `dropDuplicateCalls` obeys
//     both, so its reach is `candidate` and `answered` — never `mixed`, `unanswered` or
//     `standalone` — which is how "regardless of its own outcome" and "a mixed block is a
//     documented keep" hold at the same time.
//
// Settings are read PER TURN, through ONE helper (`readTrimmerSettings`), and only AFTER the
// guards, so a disabled plugin, a branch round and an internal agent still cost what they
// always cost: one `enabled` read (or none) and no transcript walk. Every `string` tier
// normalises to a documented value and REPORTS the value it used, both in the diagnostic text
// when a submitted value was not honoured and in its structured `data.policy` always
// (the precedent is compaction's `mode`).
//
// WHY A BRANCH ROUND IS SKIPPED ENTIRELY (same ratified answer as compaction)
// ---------------------------------------------------------------------------
// A fork/autoanswer round owns an ephemeral transcript that is incorporated into its owner
// as text; a flag written there is thrown away at incorporation, and the owner re-derives
// the same decision on its own next round. So the guard refuses to trigger on
// `context.branchId`, and the action refuses too (a host calling it directly must not trim
// an ephemeral copy). See ../plugins/context-compaction.plugin.ts, "WHY A BRANCH ROUND IS
// SKIPPED ENTIRELY" — this plugin inherits that reasoning and reuses its `isInternalAgent`
// predicate rather than restating the agent-name lists.
//
// WHY THE FAST PATH IS SYNCHRONOUS, AND WHY PAUSE/RESUME ONLY WRAP A REAL TRIM
// ---------------------------------------------------------------------------
// The bus runs `await handler(payload)`. A plain function returning `undefined` costs ONE
// microtask; an `async` function adds its own promise on top of that await. The plan is a
// pure read, so the handler computes it synchronously and returns `undefined` whenever it is
// empty — nearly every turn. Only a turn that will actually trim something returns a promise
// and pays the `pause()`/`resume()` round-trip, and `resume()` sits in a `finally`: a trim
// that threw must not strand the conversation in 'paused' (the throw itself is left to the
// bus, which is the single fail-open authority — ../plugin/hooks.ts rule 2).
//
// STATE
// -----
// None. No cooldown map, no counters, nothing persisted: the trimmed state IS the inclusion
// flag on the transcript, which is canonical, durable and operator-visible. A restarted
// process re-runs the same pure plan over the same transcript and changes nothing, because
// the units it already trimmed are still flagged.
//
// Cross-references:
//   - ../core/context-pruning.ts                    `groupUnits` — THE unit mirror and the
//                                                   candidate/answered classification reused
//                                                   verbatim; `resolvesPrunedFailure` is the
//                                                   stricter sibling this plugin loosens
//   - ../core/tool-outcome.ts                       `toolOutcomeOf` — absent means `completed`
//   - ../plugins/context-compaction.plugin.ts       `isInternalAgent` — the recursion guard
//   - ../harness.ts                                 the `turn.before` emission
//                                                   (`requestTurn` → `emitTurnBefore`), and
//                                                   `setIncluded` (the cascading flag write)
//   - ../plugin/hooks.ts                            sequential, fail-open dispatch
//   - ../plugin/manifest.ts                         GENERATED wiring: this file is
//                                                   auto-discovered (do not edit by hand)
import type { ContextUnit } from '../core/context-pruning';
import { groupUnits, PRUNE_CANDIDATE_OUTCOMES, RESOLVING_OUTCOME } from '../core/context-pruning';
// The work identity `supersedeMatch: 'fingerprint'` and `dropDuplicateCalls` match on — the SAME
// helper compaction's `resolvesPrunedFailure` uses, so the two passes agree by construction.
import { toolCallFingerprint } from '../core/argument-fingerprint';
// The estimator the UI context bar is built on. Every token figure this plugin reports or gates on
// comes through it (header: "THE TOKENS COME FROM THE SAME ESTIMATOR THE CONTEXT BAR USES").
import { estimateContextTokens } from '../core/context-estimate';
import { toolOutcomeOf } from '../core/tool-outcome';
// Reused, not restated: the internal-agent lists (a summarizer thread must never be trimmed,
// or the compactor's own helper loses the failures it was handed to explain).
import { isInternalAgent } from './context-compaction.plugin';
import type {
    HarnessContextEntry,
    HarnessLifecycleHandler,
    HarnessMessage,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata,
    HarnessToolOutcome,
    HarnessTurnBeforeContext
} from '../types';

// A static literal: scripts/generate-plugin-manifest.mjs refuses a `metadata` export that is
// not written as an object literal, because the manifest has to describe this plugin without
// executing it.
export const metadata = {
    name: 'context-trimmer',
    title: 'Context Trimmer',
    description:
        'The posture this built-in exists to hold: the engine core trims nothing by default — every recorded message stays in the provider request — and this plugin is the one place trimming happens, one rule per switch. At the start of each assistant turn it finds tool calls that failed or were rejected and were later replaced by a successful call to the same tool, and excludes those paired call+result units from the context. Which outcomes count as invalid, whether supersession matches the tool name or the exact call fingerprint, whether thinking from earlier turns stops being replayed, and how much a pass must save before it writes anything are each a separate switch, and every one of them defaults to today\'s behaviour. A unit is withheld whole or not at all, an unanswered call is never touched, and a completed result is never invalid on its own unless dropDuplicateCalls is on and the fingerprints match. Nothing is deleted: a withheld unit keeps its place in canonical history and can be switched back on, and a switch flipped off stops new writes without restoring what an earlier turn already withheld.',
    version: '1.0.0',
    tags: ['context', 'trimming', 'lifecycle'],
    builtin: true,
    hooks: ['turn.before'],
    settings: [
        {
            key: 'enabled',
            // Master switch label (mirrors `title`): `enabled` gates hook delivery for all twelve settings, so the label names the plugin's whole activity, like compaction's 'Compact conversations'. Key/default/description unchanged.
            label: 'Context trimming',
            type: 'boolean',
            default: true,
            description:
                'Runs every trimming policy this plugin has, on or off. Off stops the pass, so none of the switches below is consulted and nothing is withheld from that turn on; it changes nothing else: units an earlier turn already trimmed stay trimmed until they are switched back on from the context view, no other plugin is affected, and the transcript is never rewritten. This is the framework\'s own key, so the switch in the Plugins row and this read are one stored value with one write path. Off is NOT the engine\'s posture: the engine\'s posture is every policy below off, which sends everything that was recorded.'
        },
        {
            key: 'dropSupersededToolCalls',
            label: 'Drop superseded tool calls',
            type: 'boolean',
            default: true,
            description:
                'The shipped rule, verbatim. A tool-call unit whose every committed result was failed or rejected, that is FULLY answered, and where EVERY tool name it called has a completed answer in some later unit that is still included, stops being sent as a whole unit: the assistant block and every result answering one of its calls leave together, so the request stays pair-clean. Every name must be answered, so a block that called A and B where only A was retried successfully stays whole — half a unit leaving is worse than the whole unit staying, and the failed half\'s result is what the model would lose. Flipping this off stops new writes and restores nothing an earlier turn already withheld. An unanswered unit is never touched, and a completed result is never invalid on its own: only dropDuplicateCalls can withhold a healthy unit, and only on an exact fingerprint match.'
        },
        {
            key: 'dropInvalidToolCallsOnceAnswered',
            label: 'Drop invalid tool calls once answered',
            type: 'boolean',
            default: true,
            description:
                'The same rule generalised over what counts as an invalid result, which is what invalidOutcomes decides. It is INDEPENDENT of dropSupersededToolCalls: turning one off leaves the other running, and with both off no tool unit is ever withheld, so the request carries every recorded tool call the harness has — the engine\'s posture. Like the shipped rule it withholds only a fully answered unit, only as a whole unit, and only once a still-included later unit has answered every name it called; a resolver that is itself withheld is not evidence, because then the model would see neither the failure nor the answer. Off stops new writes and restores nothing.'
        },
        {
            key: 'invalidOutcomes',
            label: 'Outcomes that count as invalid',
            type: 'string',
            default: 'failed,rejected',
            description:
                'Which committed results count as invalid for dropInvalidToolCallsOnceAnswered, as a comma-separated set drawn from failed, rejected, cancelled, empty. failed and rejected are the shipped rule. cancelled is opt-in only: the agent CHOSE to stop there, and a healthy control outcome is not garbage in this package — a unit mixing a cancelled answer with a healthy one is a keep either way. empty is opt-in and dangerous: it treats a completed result whose text is blank as invalid, and a legitimately empty answer — a grep with no matches, a zero-hit search — is indistinguishable from a stub, so withholding it removes the one fact that proves the agent already looked. Unknown names (including completed, which is only ever reachable through dropDuplicateCalls) are dropped and the pass says so; a set that resolves to nothing disables the generalisation, leaving dropSupersededToolCalls as the only tool policy. The set actually used is reported in the pass diagnostic.'
        },
        {
            key: 'dropOldThoughts',
            label: 'Drop old thinking',
            type: 'string',
            default: 'turn',
            description:
                'Which of the model\'s own thinking stops being replayed. "off": nothing is ever withheld and every recorded thought stays eligible for replay — the engine\'s posture, and the right value for a backend whose template concatenates historical thinking. "turn" (the default): the OPEN turn keeps its thinking — every committed assistant entry after the last user entry, which is why a mailbox or autoanswer user message legitimately moves the boundary — and the thinking of every CLOSED turn is withheld; it is the only tier every strict provider contract accepts at once, and it pins the provider\'s cache divergence point one turn back forever instead of walking it backwards through history. "all": every committed thought is withheld, including the open turn\'s — only sane on a transport that replays nothing, and it costs the current-turn continuity that every measured failure mode blames for re-deciding and for thin tool calls. Any other string behaves as "turn" and the diagnostic says so. The write is a per-entry FLAG on the assistant entry, never an edit of the text: the entry still travels, with its content and tool calls intact, and only its request copy drops the thinking, so provider pairing is untouched and canonical history keeps every thought — including of an entry this pass flagged. An entry with no recorded thinking, one that is already flagged, and one whose whole unit is already withheld are never candidates, so a second pass over an unchanged transcript writes nothing. The estimator does not count reasoning, so a withheld thought registers as zero saved tokens; measure the effect in characters with minThoughtChars. Withhold-only: switching to "off" stops new writes and restores nothing.'
        },
        {
            key: 'thoughtKeepUnits',
            label: 'Earlier units that keep thinking',
            type: 'number',
            default: 0,
            min: 0,
            max: 32,
            step: 1,
            description:
                'How many otherwise-withheld thinking entries, counted from the NEWEST entry backwards, additionally keep their thinking — the recent-N tier, for the backends that are trained on their own reasoning (local Qwen/GLM/Kimi, DeepSeek with tools, the keep-all Claude generations). Only consulted while dropOldThoughts is "turn" or "all"; it counts only entries that actually carry recorded thinking, and it never re-enables thinking an earlier turn already withheld. Every value ABOVE 0 is documented as cache-hostile: a sliding window walks the provider\'s divergence point backwards through previously-stable history on every eviction, which is strictly worse than 0 on both the window and the cache — use "off" if the whole history is wanted. 0 keeps exactly one turn: the open one. It runs BEFORE minThoughtChars, which measures what the rescue leaves behind.'
        },
        {
            key: 'supersedeMatch',
            label: 'Supersession match',
            type: 'string',
            default: 'name',
            description:
                'What makes a later call the answer to an earlier one. "name" is the shipped rule: the tool NAME alone, deliberately looser than compaction\'s fingerprint, because a failed call followed later by a successful call of the same tool is almost always superseded work whether or not the retry used the same arguments (read("a.ts") failing and read("b.ts") answering the question the agent actually had). "fingerprint" is compaction\'s exact rule — tool name AND canonical arguments must match — which makes the two passes agree by construction instead of by comment and is the value that makes compaction\'s failure-retry pruning redundant. Any other string behaves as "name" and the diagnostic says so. Neither value relaxes granularity: the unit still leaves whole, and every name the block called still has to be answered.'
        },
        {
            key: 'dropDuplicateCalls',
            label: 'Drop duplicate tool calls',
            type: 'boolean',
            default: false,
            description:
                'Withhold an EARLIER unit when a later, still-included unit re-ran the SAME work and answered it — matched on the exact fingerprint (tool name plus canonical arguments), NEVER on name alone — whatever the earlier unit\'s own outcome, so a unit the model read and used is reachable. Off by default: this is the one switch here that can withhold work the model actually used, and it is the largest class of redundant context in a long trajectory. It never touches an unanswered unit, never acts on a name-only match, and only ever withholds a unit whose re-run produced completed answers.'
        },
        {
            key: 'minTokens',
            label: 'Minimum saving per pass (tokens)',
            type: 'number',
            default: 0,
            min: 0,
            max: 1000000,
            step: 50,
            description:
                'A pass must withhold at least this many estimated tokens of TOOL-UNIT text, or it writes nothing at all: no flag, no notification, no save, no diagnostic. A prune that saves 40 tokens is a provider prompt-cache invalidation for nothing, so this floor is what makes trimming on every turn cheap. 0 (the default) is the shipped posture: the rule only ever removes pure noise, so no floor was needed. The scoping to tool writes is not a detail — the estimator does not count reasoning, so a floor shared with the thinking writes would silently disable the thoughts switch whenever it was above zero.'
        },
        {
            key: 'minThoughtChars',
            label: 'Minimum thinking saved per pass (characters)',
            type: 'number',
            default: 0,
            min: 0,
            max: 1000000,
            step: 50,
            description:
                'The thinking twin of minTokens, measured in CHARACTERS of withheld thinking — the only measure available for text the estimator does not count. A thinking pass below this floor writes nothing at all. 0 (the default) removes the floor. Do not convert this number into tokens: while the estimator is not reasoning-aware the two figures cannot be compared, and a tokens-saved number that includes thinking would disagree with the context bar the operator is reading.'
        },
        {
            key: 'safetyUnits',
            label: 'Recent units to protect',
            type: 'number',
            default: 0,
            min: 0,
            max: 4096,
            step: 1,
            description:
                'How many units at the END of the transcript no tool trim may touch. A unit is one assistant tool-call block plus its results, or one standalone message, and the horizon counts UNITS from the end — never the per-run turn counter, which counts model steps inside one run and cannot express a conversation-level position. 0 (the default) removes the horizon, which is the shipped argument: a failure the model just replaced with a success is exactly the pair that is safe to drop from the NEXT request. Raise it when re-sending the last few units is cheaper than re-prefilling from the oldest trimmed position in the provider\'s cache.'
        },
        {
            key: 'maxUnits',
            label: 'Maximum units per pass',
            type: 'number',
            default: 0,
            min: 0,
            max: 4096,
            step: 1,
            description:
                'Cap on how many tool units ONE pass may withhold; 0 (the default) is unbounded. It exists for the first pass over a conversation restored weeks ago: unbounded, that single turn withholds every superseded unit at once and the provider\'s cached prefix diverges at the oldest trimmed position. Withholding is oldest-first, so a cap removes the oldest noise now and leaves the newest superseded units for a later turn.'
        }
    ]
} satisfies HarnessPluginMetadata;

// Fallback when the host stores nothing for `enabled`. It has to equal
// `metadata.settings[0].default` (true): the metadata must stay a plain object literal for
// the manifest scanner, so the number is written twice and BOTH places move together. The
// fallback only matters for a host reusing the action without declaring the setting, because
// a declared default always outranks this argument (../plugin/settings.ts `resolve`).
//
// The same duplication rule applies to EVERY switch this plugin declares: each constant below
// is the `default:` of the descriptor above it, written out because the scanner cannot read a
// computed literal. A drift between a pair is invisible to the manifest and visible on the
// first turn, so they are kept in DECLARED ORDER here, one line per descriptor, and
// `context-trimmer.test.ts` pins the descriptor list key-by-key.
const ENABLED_DEFAULT = true;
const DROP_SUPERSEDED_DEFAULT = true;
const DROP_INVALID_ONCE_ANSWERED_DEFAULT = true;
// The documented default outcome set, spelled exactly as the descriptor spells it.
const INVALID_OUTCOMES_DEFAULT = 'failed,rejected';
// The recommended tier (Part D1 of the 2026-11-10 ruling): the open turn keeps its thinking.
const DROP_OLD_THOUGHTS_DEFAULT = 'turn';
const THOUGHT_KEEP_UNITS_DEFAULT = 0;
// The shipped loosening: tool NAME, no argument comparison.
const SUPERSEDE_MATCH_DEFAULT = 'name';
const DROP_DUPLICATE_CALLS_DEFAULT = false;
// The three economy knobs the shipped pass argued against, so all three default to off.
const MIN_TOKENS_DEFAULT = 0;
const MIN_THOUGHT_CHARS_DEFAULT = 0;
const SAFETY_UNITS_DEFAULT = 0;
const MAX_UNITS_DEFAULT = 0;

// ---------------------------------------------------------------------------
// THE SETTINGS SURFACE, AS VALUES (not as strings a predicate has to re-parse)
// ---------------------------------------------------------------------------
// One read per switch per turn, in DECLARED ORDER, normalised once, and the normalised result
// is what the policy AND the report read. Every `string` tier resolves to a member of its
// closed set plus the value that was actually submitted, because the WRITE edge does not own
// the closed set (a `string` setting accepts any string — ../server/plugins.ts validates type
// and bounds only) and the READ edge only coerces types (../plugin/settings.ts), so this file
// is the one place that decides what `"sometimes"` means — and it has to say so out loud.

// The outcomes a unit's committed results can be judged by. All four are ACTED ON: `failed` and
// `rejected` are the shipped rule's own class (`kind === 'candidate'`), while `cancelled` and
// `empty` reach units that classifier files as `mixed`/`answered`, so the generalisation judges
// them through `effectiveOutcomesOf` below (see the header's "THE EFFECTIVE OUTCOME MAPPING").
// `completed` is deliberately absent: a healthy answer is only ever reachable through
// `dropDuplicateCalls`, never through this setting.
export type TrimmerInvalidOutcome = 'failed' | 'rejected' | 'cancelled' | 'empty';

// Closed sets, in the order each one is DOCUMENTED in (a normalised value is always emitted in
// this order, so a report is stable whatever the operator typed).
const INVALID_OUTCOME_NAMES: readonly TrimmerInvalidOutcome[] = ['failed', 'rejected', 'cancelled', 'empty'];

// The outcome set the SHIPPED rule admits — core's own candidate class is defined by exactly this
// list (`../core/context-pruning.ts:97` `PRUNE_CANDIDATE_OUTCOMES`), so the shipped rule and the
// generalisation are provably the same predicate while the effective set is inside it. Reused
// rather than restated, and it is also what decides when a diagnostic line needs to name its
// switch: a unit whose outcomes are all in this list is the shape the shipped message has always
// described, and its line stays byte-identical.
const SHIPPED_INVALID_OUTCOMES: readonly HarnessToolOutcome[] = PRUNE_CANDIDATE_OUTCOMES;

// The two unit classes the DUPLICATE rule may withhold. `answered` is the class F2's
// duplicate-successful-call lives in and the reason this rule exists at all; `candidate` is
// included so the rule reaches a superseded failure whatever its outcome. `mixed`, `unanswered`
// and `standalone` are structural keeps — the first because a healthy answer inside the block is
// a fact the model used, the second because a call with no committed result may still be awaited,
// the third because a standalone message owns no work of its own.
const DUPLICATE_ELIGIBLE_CLASSES: readonly ContextUnit['kind'][] = ['candidate', 'answered'];

export type TrimmerThoughtTier = 'off' | 'turn' | 'all';
const THOUGHT_TIERS: readonly TrimmerThoughtTier[] = ['off', 'turn', 'all'];

export type TrimmerSupersedeMatch = 'name' | 'fingerprint';
const SUPERSEDE_MATCHES: readonly TrimmerSupersedeMatch[] = ['name', 'fingerprint'];

// The three tool rules, in DECLARED order. `admittedBy` lists every one that admits a unit, and
// `firedBy` is its first entry — the report attributes a withholding to the earliest declared
// switch that could have produced it, which keeps a pass at the declared defaults attributed to
// the shipped rule it actually is.
export type TrimmerToolRule = 'dropSupersededToolCalls' | 'dropInvalidToolCallsOnceAnswered' | 'dropDuplicateCalls';

// Every policy value one turn runs with. Plain data on purpose: the plan stays a pure function
// of (entries, settings), which is what keeps it re-runnable, restart-stable and testable.
export type TrimmerSettings = {
    dropSupersededToolCalls: boolean;
    dropInvalidToolCallsOnceAnswered: boolean;
    // The outcome set the generalisation acts on this turn: the documented closed set as
    // submitted, filtered through `INVALID_OUTCOME_NAMES` (unknown names, `completed` included,
    // are dropped). Empty == the generalisation is off, whatever the operator asked for.
    invalidOutcomes: readonly TrimmerInvalidOutcome[];
    invalidOutcomesSubmitted: string;
    // True when the submitted string named at least one name outside the closed set (an
    // empty submission is NOT a fallback — "an empty set disables the generalisation" is
    // documented behaviour, not a substitution).
    invalidOutcomesFallback: boolean;
    dropOldThoughts: TrimmerThoughtTier;
    dropOldThoughtsSubmitted: string;
    dropOldThoughtsFallback: boolean;
    supersedeMatch: TrimmerSupersedeMatch;
    supersedeMatchSubmitted: string;
    supersedeMatchFallback: boolean;
    dropDuplicateCalls: boolean;
    thoughtKeepUnits: number;
    minTokens: number;
    minThoughtChars: number;
    safetyUnits: number;
    maxUnits: number;
};

// `"failed, REJECTED , failed"` -> ['failed','rejected'] in CANONICAL order (a set, not a list:
// the order and the spelling the operator typed must not reach a report or a predicate). Every
// documented name is kept, `cancelled` and `empty` included — the generalisation acts on all four
// (see the header's "THE EFFECTIVE OUTCOME MAPPING"), and `completed` is not in the closed set, so
// it is dropped as an unknown name like any other. `unknown` is what drives the diagnostic clause —
// at least one typed name outside the closed set — and an empty submission is NOT a fallback,
// because "an empty set disables the generalisation" is documented behaviour rather than a
// substitution. Declared BEFORE the defaults below, which parse the documented default string.
const outcomeSetOf = (submitted: string): { names: TrimmerInvalidOutcome[]; unknown: boolean } => {
    const typed = submitted
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0);

    const unknown = typed.some((name) => !INVALID_OUTCOME_NAMES.includes(name as TrimmerInvalidOutcome));
    // Filtering the CANONICAL list (not the typed one) is what both de-duplicates and puts the
    // result in documented order.
    const names = INVALID_OUTCOME_NAMES.filter((name) => typed.includes(name));

    return { names, unknown };
};

// The configuration a pass runs with when nothing is read at all: the declared defaults, i.e.
// exactly the shipped behaviour. It is the default of `planTrimmedUnits` (a host calling the
// pure plan directly gets the rule, not a guess) and the default of the writer (so a host that
// reuses `applyTrimPlan` reports the policy it actually applied). Exported because it is the
// baseline a settings table is written against — `context-trimmer.test.ts` spreads it and overrides
// one switch per case, which is what keeps "everything else at its default" part of the fixture
// rather than an assumption.
export const TRIMMER_DEFAULT_SETTINGS: TrimmerSettings = {
    dropSupersededToolCalls: DROP_SUPERSEDED_DEFAULT,
    dropInvalidToolCallsOnceAnswered: DROP_INVALID_ONCE_ANSWERED_DEFAULT,
    // Built from the DOCUMENTED default string through the one parser, so the default set and the
    // descriptor's `default:` cannot drift apart by hand.
    invalidOutcomes: outcomeSetOf(INVALID_OUTCOMES_DEFAULT).names,
    invalidOutcomesSubmitted: INVALID_OUTCOMES_DEFAULT,
    invalidOutcomesFallback: false,
    dropOldThoughts: DROP_OLD_THOUGHTS_DEFAULT as TrimmerThoughtTier,
    dropOldThoughtsSubmitted: DROP_OLD_THOUGHTS_DEFAULT,
    dropOldThoughtsFallback: false,
    supersedeMatch: SUPERSEDE_MATCH_DEFAULT as TrimmerSupersedeMatch,
    supersedeMatchSubmitted: SUPERSEDE_MATCH_DEFAULT,
    supersedeMatchFallback: false,
    dropDuplicateCalls: DROP_DUPLICATE_CALLS_DEFAULT,
    thoughtKeepUnits: THOUGHT_KEEP_UNITS_DEFAULT,
    minTokens: MIN_TOKENS_DEFAULT,
    minThoughtChars: MIN_THOUGHT_CHARS_DEFAULT,
    safetyUnits: SAFETY_UNITS_DEFAULT,
    maxUnits: MAX_UNITS_DEFAULT
};

// A tier: trim + lowercase, then accept ONLY a documented member. Anything else is the
// documented fallback, and `fallback` records that a substitution happened so the diagnostic
// can name the value submitted and the value used.
const tierOf = <T extends string>(submitted: string, tiers: readonly T[], fallback: T) => {
    const typed = submitted.trim().toLowerCase();
    const match = tiers.find((tier) => tier === typed);

    return { tier: match ?? fallback, typed, fallback: match === undefined };
};

// THE ONE SETTINGS READ of a turn. `api.settings` is live by contract (../plugin/settings.ts),
// so this runs every turn and a `PATCH /v1/harness/plugins/context-trimmer` lands on the next
// one. Reads happen in DECLARED ORDER and all of them happen here: the read set of a turn is a
// pinned contract (`context-trimmer.test.ts` asserts it exactly), and it is only pinned because
// every caller is behind the guards (`guardPasses`), which is what keeps a disabled plugin, a
// branch round and an internal agent at the one `enabled` read (or none) they always cost.
//
// Numbers are NOT clamped here. `min`/`max` are the plugin's published bounds and the write
// edge refuses a value outside them (../server/plugins.ts, ../plugin/settings.ts
// `normalizeNumber`); the read edge is coercion-only by contract, so a hand-edited document
// keeps its value rather than being silently rewritten.
const readTrimmerSettings = (api: HarnessPluginApi): TrimmerSettings => {
    const dropSupersededToolCalls = api.settings.boolean('dropSupersededToolCalls', DROP_SUPERSEDED_DEFAULT);
    const dropInvalidToolCallsOnceAnswered = api.settings.boolean(
        'dropInvalidToolCallsOnceAnswered',
        DROP_INVALID_ONCE_ANSWERED_DEFAULT
    );
    const invalidOutcomesSubmitted = api.settings.string('invalidOutcomes', INVALID_OUTCOMES_DEFAULT);
    const dropOldThoughtsSubmitted = api.settings.string('dropOldThoughts', DROP_OLD_THOUGHTS_DEFAULT);
    const thoughtKeepUnits = api.settings.number('thoughtKeepUnits', THOUGHT_KEEP_UNITS_DEFAULT);
    const supersedeMatchSubmitted = api.settings.string('supersedeMatch', SUPERSEDE_MATCH_DEFAULT);
    const dropDuplicateCalls = api.settings.boolean('dropDuplicateCalls', DROP_DUPLICATE_CALLS_DEFAULT);
    const minTokens = api.settings.number('minTokens', MIN_TOKENS_DEFAULT);
    const minThoughtChars = api.settings.number('minThoughtChars', MIN_THOUGHT_CHARS_DEFAULT);
    const safetyUnits = api.settings.number('safetyUnits', SAFETY_UNITS_DEFAULT);
    const maxUnits = api.settings.number('maxUnits', MAX_UNITS_DEFAULT);

    const outcomes = outcomeSetOf(invalidOutcomesSubmitted);
    const thoughts = tierOf(dropOldThoughtsSubmitted, THOUGHT_TIERS, DROP_OLD_THOUGHTS_DEFAULT as TrimmerThoughtTier);
    const matcher = tierOf(supersedeMatchSubmitted, SUPERSEDE_MATCHES, SUPERSEDE_MATCH_DEFAULT as TrimmerSupersedeMatch);

    return {
        dropSupersededToolCalls,
        dropInvalidToolCallsOnceAnswered,
        invalidOutcomes: outcomes.names,
        invalidOutcomesSubmitted,
        invalidOutcomesFallback: outcomes.unknown,
        dropOldThoughts: thoughts.tier,
        dropOldThoughtsSubmitted,
        dropOldThoughtsFallback: thoughts.fallback,
        supersedeMatch: matcher.tier,
        supersedeMatchSubmitted,
        supersedeMatchFallback: matcher.fallback,
        dropDuplicateCalls,
        thoughtKeepUnits,
        minTokens,
        minThoughtChars,
        safetyUnits,
        maxUnits
    };
};

// Can ANY tool unit be withheld this turn? Every tool switch off — or the generalisation on with
// an outcome set that resolved to nothing — and the answer is no, which is what makes the pass
// touch nothing at all: no plan, no write, no diagnostic, no park (D4's zero-cost case). The
// duplicate rule counts on its own: with both supersession booleans off it is still a tool policy,
// and it is the switch the H2 independence check runs alone.
const toolRuleEnabled = (settings: TrimmerSettings): boolean =>
    settings.dropSupersededToolCalls ||
    (settings.dropInvalidToolCallsOnceAnswered && settings.invalidOutcomes.length > 0) ||
    settings.dropDuplicateCalls;

// The effective outcome of one committed result: the four stored outcomes plus the DERIVED `empty`
// (a `completed` result with no non-whitespace text). `completed` is a member of this union and is
// in NO set the operator can name, which is exactly what keeps a healthy answer's unit — the only
// switch that can withhold one is `dropDuplicateCalls`, on a fingerprint match.
export type TrimmerEffectiveOutcome = HarnessToolOutcome | 'empty';

// The per-call facts the predicates need about one unit. Derived here rather than taken from core
// because core's classifier answers a DIFFERENT question: it keys units by work fingerprint and
// files a `cancelled` or blank-`completed` result under `mixed`/`answered` as a KEEP, while this
// plugin has to ask about tool NAMES (the shipped loosening), about fingerprints (when
// `supersedeMatch` says so, and always for `dropDuplicateCalls`), and about the EFFECTIVE outcome
// of each committed result (the `cancelled`/`empty` generalisation).
export type TrimmingUnitFacts = {
    // Every tool the unit's block asked for, in call order. A name repeated by two calls appears
    // twice; the predicate asks the same question for both, so the duplicate costs one comparison
    // and can never change the answer.
    names: readonly string[];
    // One `toolCallFingerprint(name, arguments)` per call, in the SAME order as `names`: the two
    // lists are read together by `answersWorkOf`, so they are built from one pass over the calls
    // and can never shift out of alignment.
    keys: readonly string[];
    // The names that have at least one `completed` answer committed in THIS unit. A call with
    // no committed result is absent, so an in-flight call can never be an answer.
    resolvedNames: ReadonlySet<string>;
    // The work fingerprints with at least one `completed` answer committed in THIS unit — the
    // fingerprint twin of `resolvedNames`, and the only thing a duplicate re-run may match against.
    resolvedKeys: ReadonlySet<string>;
    // True when every call of the block has a committed result. The definition is core's own
    // (`results.length < calls.length` is what makes a unit `unanswered`,
    // ../core/context-pruning.ts:320-323), so the generalisation cannot disagree with the shipped
    // classifier about what "fully answered" means.
    fullyAnswered: boolean;
    // The EFFECTIVE outcome of every committed result, in result order — the order core's own
    // `outcomes` list uses, because both are the unit's tool members in member order.
    effectiveOutcomes: readonly TrimmerEffectiveOutcome[];
};

// One assistant tool-call block's calls (id, name and WORK fingerprint, canonical order). A
// standalone message — a user/assistant/system turn, or an orphan result whose block is gone — has
// none, which is what keeps it out of every role of the rules.
const callsOf = (unit: ContextUnit): { id: string; name: string; key: string }[] =>
    unit.leader.message.role === 'assistant'
        ? (unit.leader.message.toolCalls ?? []).map((call) => ({
              id: call.id,
              name: call.name,
              // The work identity, computed by the SAME helper compaction uses
              // (../core/argument-fingerprint.ts:171): raw argument text in, canonical key order
              // and whitespace out, so a reordered retry still matches and a different `path` does
              // not. Only `supersedeMatch: 'fingerprint'` and `dropDuplicateCalls` ever read it.
              key: toolCallFingerprint(call.name, call.arguments)
          }))
        : [];

// The committed results of a unit, in member order — the same list and order core derives its
// `outcomes` from, so `effectiveOutcomes` below is index-for-index comparable with `unit.outcomes`.
const resultsOf = (unit: ContextUnit): Extract<HarnessMessage, { role: 'tool' }>[] =>
    unit.members
        .filter((member) => member.message.role === 'tool')
        .map((member) => member.message as Extract<HarnessMessage, { role: 'tool' }>);

// The effective outcome of ONE committed result, the one decision `invalidOutcomes` is read
// against:
//   - `failed` / `rejected` / `cancelled` come from the outcome key alone. A `cancelled` result is
//     NEVER re-read off its text: an abandoned call has no content worth judging, which is why a
//     cancelled result whose content happens to be blank stays `cancelled`;
//   - `completed` becomes `empty` when its text is blank. This is the only value read off content,
//     and the reason the descriptor calls `empty` dangerous — a legitimate zero-hit `grep` is
//     indistinguishable from a stub;
//   - a content that is not a string (a restored or hand-edited transcript) cannot be judged blank,
//     so it stays `completed`: the conservative direction for an opt-in that is documented as risky.
const effectiveOutcomeOf = (
    result: Extract<HarnessMessage, { role: 'tool' }>
): TrimmerEffectiveOutcome => {
    const outcome = toolOutcomeOf(result);

    if (outcome !== RESOLVING_OUTCOME) return outcome;

    return typeof result.content === 'string' && result.content.trim().length === 0 ? 'empty' : 'completed';
};

// The committed results of a unit as `toolCallId -> outcome`, read through the shipped rule
// (../core/tool-outcome.ts: an absent key means `completed`, so a pre-outcome transcript
// reads healthy and is never a candidate). A duplicate answer for one call id is not
// producible by the runtime (results are committed per call), and last-wins is the honest
// reading of a hand-written transcript: the newest write is what the transcript says now.
const outcomesByCallOf = (unit: ContextUnit): Map<string, HarnessToolOutcome> => {
    const outcomes = new Map<string, HarnessToolOutcome>();

    for (const result of resultsOf(unit)) {
        outcomes.set(result.toolCallId, toolOutcomeOf(result));
    }

    return outcomes;
};

// Everything the rules need to know about one unit, in one pass over its calls and results.
const factsOf = (unit: ContextUnit): TrimmingUnitFacts => {
    const calls = callsOf(unit);
    const results = resultsOf(unit);
    const outcomes = outcomesByCallOf(unit);
    const resolvedNames = new Set<string>();
    const resolvedKeys = new Set<string>();

    for (const call of calls) {
        // Only a COMMITTED `completed` answer resolves anything: a missing result means the
        // call is unanswered (the unit is `unanswered` and no rule may touch it), and a
        // `failed`/`rejected`/`cancelled` answer is not evidence of success.
        if (outcomes.get(call.id) === RESOLVING_OUTCOME) {
            resolvedNames.add(call.name);
            resolvedKeys.add(call.key);
        }
    }

    return {
        names: calls.map((call) => call.name),
        keys: calls.map((call) => call.key),
        resolvedNames,
        resolvedKeys,
        // Core's own "not unanswered" test, restated on the same two counts (`calls.length > 0` is
        // the unit having work of its own at all, which `standalone` units fail).
        fullyAnswered: calls.length > 0 && results.length >= calls.length,
        effectiveOutcomes: results.map(effectiveOutcomeOf)
    };
};

// Is this unit's result set entirely invalid under the operator's `invalidOutcomes` set? Every
// committed result must be answered AND its effective outcome must be in the set. Two consequences
// the tables pin: a unit mixing a healthy answer with an invalid one is a keep (`completed` is in
// no set), and an all-`failed`/`rejected` unit under the DEFAULT set is admitted exactly when core
// files it as `kind === 'candidate'` — the same two conditions over the same lists.
const isInvalidUnder = (
    facts: TrimmingUnitFacts,
    invalidOutcomes: readonly TrimmerInvalidOutcome[]
): boolean =>
    facts.fullyAnswered &&
    facts.effectiveOutcomes.length > 0 &&
    facts.effectiveOutcomes.every(
        (outcome) => invalidOutcomes.indexOf(outcome as TrimmerInvalidOutcome) !== -1
    );

// The FIRST later, still-included unit that answered one piece of work with a `completed` result,
// or `undefined` when nothing did. `match` is the ONLY difference between the two evidence rules:
// `'name'` asks whether any later unit answered this tool with ANY arguments (the shipped
// loosening), `'fingerprint'` asks whether any later unit answered the SAME work — name AND
// canonical arguments (../core/argument-fingerprint.ts:171). Extracted so the ordering rule ("the
// oldest answer is the one worth naming") is stated once and cannot drift between the matchers.
const firstAnswerOf = (
    units: readonly ContextUnit[],
    facts: readonly TrimmingUnitFacts[],
    from: number,
    match: TrimmerSupersedeMatch,
    work: string
): ContextUnit | undefined => {
    for (let later = from; later < units.length; later += 1) {
        // A withheld resolver is not evidence: switching the failure off on the strength of an
        // answer the model cannot see would drop BOTH halves.
        if (!units[later].included) continue;

        const answered = match === 'fingerprint' ? facts[later].resolvedKeys : facts[later].resolvedNames;

        if (!answered.has(work)) continue;

        return units[later];
    }

    return undefined;
};

// The unit that answered EVERY call this unit made, under `match`, or `undefined` when any call is
// still unanswered. All-or-nothing on purpose (F2's asymmetry note): the answers may sit in
// different later units, but one unanswered call keeps the whole unit in the context, because half
// a unit leaving is worse than the whole unit staying and the withheld half's result is what the
// model would lose. The reported resolver is the EARLIEST answering unit across all calls, which is
// what a reviewer wants to read first.
const answersWorkOf = (
    units: readonly ContextUnit[],
    facts: readonly TrimmingUnitFacts[],
    index: number,
    match: TrimmerSupersedeMatch,
    work: { name: string; key: string }[]
): ContextUnit | undefined => {
    // A block with no calls of its own has no work to be answered — `every` would be vacuously
    // true and would trim on no evidence at all.
    if (work.length === 0) return undefined;

    let resolver: ContextUnit | undefined;

    for (const call of work) {
        const answer = firstAnswerOf(
            units,
            facts,
            index + 1,
            match,
            match === 'fingerprint' ? call.key : call.name
        );

        if (answer === undefined) return undefined;

        if (resolver === undefined || answer.leader.index < resolver.leader.index) resolver = answer;
    }

    return resolver;
};

// Estimated tokens a set of canonical indices withholds, measured by REMOVING them from the
// transcript and re-running the SAME estimator the UI context bar is built on. This mirrors
// ../core/context-pruning.ts `withheldTokensOf` one-for-one — that helper is PRIVATE there (only
// `planContextPruning`'s `PrunePlan.withheldTokens` exposes the figure), so reusing compaction's
// token basis means reusing its delta, its clamp at 0, and the fact that the (constant) instruction
// term cancels out on both sides. Indices are entry indexes, and `entries` is the canonical,
// gap-free list, so an index is also its position — the same assumption core makes.
const withheldTokensOf = (
    messages: readonly HarnessMessage[],
    indices: ReadonlySet<number>
): number => {
    const kept: HarnessMessage[] = [];

    for (let index = 0; index < messages.length; index += 1) {
        if (indices.has(index)) continue;
        kept.push(messages[index]);
    }

    return Math.max(0, estimateContextTokens(messages) - estimateContextTokens(kept));
};

// One candidate plus the position of its unit in the mirror, which is what `safetyUnits` counts
// backwards from. Kept out of the public candidate shape on purpose: an index into this pass's
// grouping is an implementation fact, not something a host should have to reason about.
type MatchedUnit = {
    candidate: TrimCandidate;
    unitIndex: number;
};

// THE ECONOMY GATES (T5), applied to the COMBINED tool candidate set in one fixed order — horizon,
// cap, floor — and never to a thinking write (the estimator does not count `reasoning`, so a shared
// floor would silently disable the thoughts switch above 0). At the declared zeros every gate is a
// pass-through, which is what makes the shipped request byte-identical.
const applyEconomyGates = (
    matched: readonly MatchedUnit[],
    unitCount: number,
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings
): MatchedUnit[] => {
    if (matched.length === 0) return [];

    // 1. THE TAIL HORIZON, in UNITS, counted FROM THE END of the transcript — never the per-run
    // `iteration`, which counts model steps inside one run and cannot express a conversation-level
    // position (`../core/context-pruning.ts:26-29`). The boundary is core's own: `>=` against
    // `units.length - safety`, so a horizon of 0 protects NOTHING and a horizon larger than the
    // transcript protects all of it. A unit inside the horizon is still eligible to ANSWER an older
    // failure, which is why only the candidate side is filtered.
    const safety = Number.isFinite(settings.safetyUnits) ? Math.max(0, settings.safetyUnits) : 0;
    const firstProtected = Math.max(0, unitCount - safety);
    const outside = matched.filter((entry) => entry.unitIndex < firstProtected);

    // 2. THE PER-PASS CAP, oldest-first (the walk that built `matched` is already in ascending
    // position order). Deliberately NOT compaction's `matches.slice(0, maxUnits)`: there 0 means
    // "nothing", and here 0 is the DOCUMENTED unbounded default.
    const maxUnits = Number.isFinite(settings.maxUnits) ? Math.max(0, settings.maxUnits) : 0;
    const selected = maxUnits === 0 ? outside : outside.slice(0, maxUnits);

    // 3. THE SAVINGS FLOOR, measured on what the cap left — cap first, then floor, so the floor
    // judges the pass the plugin would actually make rather than a bigger one it had already
    // decided not to make. `minTokens: 0` short-circuits the estimator entirely (the tokens of any
    // set are >= 0, so the floor could not reject anything) — the shipped path pays for no estimate.
    const minTokens = Number.isFinite(settings.minTokens) ? Math.max(0, settings.minTokens) : 0;

    if (selected.length === 0 || minTokens === 0) return selected;

    const withheld = new Set<number>();

    for (const entry of selected) {
        for (const index of entry.candidate.members) withheld.add(index);
    }

    // Below the floor the WHOLE pass is rejected, not part of it: half a batch is exactly the cache
    // churn the floor exists to avoid, and the empty plan means no flag, no notification, no save
    // and no diagnostic (D4 #5).
    if (withheldTokensOf(entries.map((entry) => entry.message), withheld) < minTokens) return [];

    return selected;
};

// One unit the trimmer wants withheld, with everything an operator needs to audit it.
export type TrimCandidate = {
    // The entry to disable, and its durable address when the runtime minted one.
    leaderIndex: number;
    leaderMessageId?: string;
    // Every canonical index that will stop being sent (the cascade covers them; naming them
    // is for the diagnostic, not for the write).
    members: readonly number[];
    // The outcomes the TRANSCRIPT records for this unit's committed results. Stored, never
    // re-decided — an `empty` withholding still reports `[completed]` here, because that IS what
    // the result says, and `invalidOutcomes` next to it says what the pass read.
    outcomes: readonly HarnessToolOutcome[];
    // The EFFECTIVE outcome of each committed result (../core/tool-outcome.ts's read plus the
    // derived `empty`), i.e. the values `invalidOutcomes` was matched against. For a unit the
    // shipped rule produced this equals `outcomes`; it differs exactly for the two generalised
    // outcomes, which is what makes a report line like `[cancelled]` or `[empty]` readable.
    invalidOutcomes: readonly TrimmerEffectiveOutcome[];
    // The tool names withheld, so a reviewer sees which work left the context.
    names: readonly string[];
    // EVERY switch that is allowed to withhold this unit. Two switches are on at once all the time
    // (`dropSupersededToolCalls` and the generalisation both admit an all-`failed` unit), and a
    // duplicate re-run can admit a unit the other two also admit, so the honest answer to "which
    // switch did this?" is a list — `policy.fired` is derived from it across the whole pass.
    admittedBy: readonly TrimmerToolRule[];
    // The switch the REPORT attributes the withholding to: the first entry of `admittedBy` in
    // DECLARED order, so a pass at the declared defaults is attributed to the shipped rule.
    firedBy: TrimmerToolRule;
    // The SUPERSEDING UNIT — the EARLIEST unit that answered any one of the withheld calls, under
    // the matcher that produced this candidate (`supersedeMatch` for the supersession rules,
    // fingerprint for a duplicate re-run). A multi-call block can be answered by more than one
    // later unit; the oldest answer is what a reviewer wants to read first.
    resolverIndex: number;
    resolverMessageId?: string;
};

// THE POLICY. Pure: same entries plus same settings, same plan. Oldest-first, because that is
// the walk order and it is the cache-friendly one (the surviving prefix is the prefix the provider
// already cached). A unit is visited ONCE, so it can appear in the plan at most once however many
// switches admit it — the rules are OR-therefore-unioned, never stacked into separate writes.
//
// Per unit, in this order:
//   1. it must be INCLUDED (idempotence — an already-trimmed unit is invisible to a second pass,
//      so a re-run writes nothing and therefore notifies nothing);
//   2. it must have work of its own and be FULLY answered. `standalone` (a message with no calls,
//      or an orphan result whose block is gone) owns no work, and `unanswered` has a call with no
//      committed result — an in-flight background call or a host block that was never answered —
//      which no rule here may touch (../core/context-pruning.ts rule 3);
//   3. a SWITCH must be allowed to look at it, BEFORE any later-unit search:
//      - `dropSupersededToolCalls` admits core's `kind === 'candidate'`, verbatim;
//      - `dropInvalidToolCallsOnceAnswered` admits a unit whose every committed result is invalid
//        under `invalidOutcomes` (`isInvalidUnder`, the header's outcome mapping);
//      - `dropDuplicateCalls` admits `candidate` and `answered` units only, i.e. never a `mixed`
//        or `unanswered` one, whatever the earlier unit's own outcome was;
//   4. the work must be ANSWERED. The two supersession rules share ONE search and use the matcher
//      `supersedeMatch` picks; the duplicate rule always re-runs it on the FINGERPRINT, because a
//      name-only match would let `read("a.ts")` be "answered" by `read("b.ts")` and withhold work
//      the model actually used. One unanswered call disqualifies the whole unit;
//   5. the surviving candidates then run the economy gates (horizon, cap, floor), which at the
//      declared zeros change nothing.
//
// `settings` is optional so a host (or a test) asking for the plain shipped rule gets it; the
// plugin itself always passes what it read this turn.
export const planTrimmedUnits = (
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS
): TrimCandidate[] => {
    // No tool policy is on, so nothing can be withheld: skip the unit mirror entirely rather than
    // walking it to produce an empty plan.
    if (!toolRuleEnabled(settings)) return [];

    // The shipped unit mirror (../core/context-pruning.ts `groupUnits`): an assistant block
    // plus every result answering one of its calls, contiguous or spliced in later, so a
    // background result that landed out of order is still part of its unit.
    const units = groupUnits(entries);
    const facts = units.map(factsOf);

    const matched: MatchedUnit[] = [];

    for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const own = facts[index];

        // (1) Idempotence — `unit.included` is the LIVE effective flag of the WHOLE unit.
        if (!unit.included) continue;
        // (2) No work of its own, or a call that is still outstanding: nothing here is superseded.
        if (unit.kind === 'standalone' || unit.kind === 'unanswered') continue;
        if (own.names.length === 0) continue;

        // (3) Which switches may look at this unit at all — before any later-unit search, so a unit
        // no switch wants costs one classification check and no scan of the rest of the transcript.
        const shippedApplies = settings.dropSupersededToolCalls && unit.kind === 'candidate';
        const generalisationApplies =
            settings.dropInvalidToolCallsOnceAnswered &&
            settings.invalidOutcomes.length > 0 &&
            isInvalidUnder(own, settings.invalidOutcomes);
        const duplicateApplies =
            settings.dropDuplicateCalls && DUPLICATE_ELIGIBLE_CLASSES.indexOf(unit.kind) !== -1;

        if (!shippedApplies && !generalisationApplies && !duplicateApplies) continue;

        // The unit's work, one entry per CALL: `answersWorkOf` needs the name for the shipped
        // matcher and the fingerprint for the exact one, and both come from the same call list.
        const work = own.names.map((name, callIndex) => ({ name, key: own.keys[callIndex] }));

        // (4) Evidence. One search per MATCHER, and only for the rules that asked for it.
        const superseder =
            shippedApplies || generalisationApplies
                ? answersWorkOf(units, facts, index, settings.supersedeMatch, work)
                : undefined;
        // The duplicate rule never reads `supersedeMatch`: withholding work the model used on a
        // name-only match is the failure mode the switch text rules out.
        const rerun = duplicateApplies ? answersWorkOf(units, facts, index, 'fingerprint', work) : undefined;

        const admittedBy: TrimmerToolRule[] = [];
        let resolver: ContextUnit | undefined;

        if (superseder !== undefined) {
            if (shippedApplies) admittedBy.push('dropSupersededToolCalls');
            if (generalisationApplies) admittedBy.push('dropInvalidToolCallsOnceAnswered');
            resolver = superseder;
        }

        if (rerun !== undefined) {
            admittedBy.push('dropDuplicateCalls');
            // The supersession evidence names the line when both fired; the re-run is the same
            // later success seen through the stricter matcher, so it never adds a second answer.
            resolver = resolver ?? rerun;
        }

        if (resolver === undefined) continue;

        matched.push({
            unitIndex: index,
            candidate: {
                leaderIndex: unit.leader.index,
                ...(unit.leader.messageId === undefined
                    ? {}
                    : { leaderMessageId: unit.leader.messageId }),
                members: unit.members.map((member) => member.index),
                outcomes: unit.outcomes,
                invalidOutcomes: own.effectiveOutcomes,
                names: own.names,
                admittedBy,
                firedBy: admittedBy[0],
                resolverIndex: resolver.leader.index,
                ...(resolver.leader.messageId === undefined
                    ? {}
                    : { resolverMessageId: resolver.leader.messageId })
            }
        });
    }

    return applyEconomyGates(matched, units.length, entries, settings).map((entry) => entry.candidate);
};

// THE THINKING CANDIDATE (T6) — one assistant entry whose recorded thinking this pass wants
// withheld, and everything the report has to say about it. A separate shape from `TrimCandidate`
// on purpose: the two axes act on different fields, have different granularity (a unit vs exactly
// one entry) and different floors (tokens vs characters), and a plan that merged them would force
// every consumer to ask "which kind is this?" before it could write anything.
export type ThoughtCandidate = {
    // The entry to flag, and its durable address when the runtime minted one.
    entryIndex: number;
    entryMessageId?: string;
    // WHICH TURN the entry belongs to: `open` = after the last user entry, i.e. the turn the run
    // is still building; `closed` = a finished turn. The tier reads exactly this, and the report
    // line names it, because "why did MY current reasoning disappear" is the first question an
    // operator asks of a thinking policy.
    turn: 'open' | 'closed';
    // Characters of thinking the flag removes from the request — the figure `minThoughtChars` is
    // measured against and the figure the report names. Never converted to tokens: the estimator
    // does not count reasoning, so the two numbers are not comparable.
    chars: number;
    // The tier in force that admitted it. The thinking side has one switch, so `firedBy` is a
    // constant — but D4 #1 asks every withheld item to name its switch, and a report that names it
    // only for tool units is a report a host has to guess about.
    firedBy: 'dropOldThoughts';
    tier: TrimmerThoughtTier;
};

// THE THINKING POLICY. Pure: same entries plus same settings, same plan, and no in-process state —
// a restarted process re-derives the same list, and the entries already flagged simply drop out of
// it, which is what makes a second pass write NOTHING.
//
// Per canonical entry, in this order:
//   1. tier gate — `off` means no thinking write exists at all, whatever else is configured;
//   2. the entry must be an `assistant` entry that actually CARRIES thinking (a non-empty string).
//      An entry with no `reasoning` has nothing to withhold, and flagging it would be a write, a
//      notification and a save for zero effect — which is also why `thoughtKeepUnits` counts only
//      these entries;
//   3. it must not ALREADY be flagged (idempotence — the exact trick the tool side uses with
//      `unit.included`), and it must not be a unit the model never sees anyway (`entry.included`
//      is the live, effective flag of the whole unit: thinking on a withheld entry cannot be
//      "removed from the request" because the entry is not in it, so the flag would cost a write
//      and change nothing; if a host re-enables that entry later, the NEXT pass flags it);
//   4. the TURN rule: `turn` spares the open turn, `all` spares nothing;
//   5. `thoughtKeepUnits` rescues the N newest of what survives (counted over the entries above,
//      so "the N newest thinking entries" is exactly what the descriptor promises);
//   6. `minThoughtChars` measures the characters the write WOULD remove — after the rescue, because
//      a floor on a saving this pass is not making is meaningless — and below it the thinking side
//      contributes NO writes. The tool side is untouched by this floor, exactly as the tool side's
//      `minTokens` never touches these candidates.
//
// THE THIRD ARGUMENT — the entries this SAME pass is about to withhold ENTIRELY (the members of the
// tool candidates, cascade included). Their thinking is skipped, for two reasons that are both
// about honesty rather than size: an entry that leaves the request leaves with its thinking, so a
// flag there would buy nothing, and counting its characters toward `minThoughtChars` would claim a
// saving the pass does not actually get. The set is passed IN rather than computed here so this
// function stays a pure policy over entries + settings — `dropOldThoughts` and the tool switches
// are independent switches (H2), and the independence is only provable while one does not read the
// other's state.
export const planWithheldThoughts = (
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS,
    withheldEntries?: ReadonlySet<number>
): ThoughtCandidate[] => {
    // (1) The tier gate, before anything is read off the transcript.
    if (settings.dropOldThoughts === 'off') return [];

    // THE BOUNDARY. The last user entry, in canonical order; everything after it is the open turn.
    // -1 when the transcript has no user entry at all, which makes every assistant entry part of
    // the open turn and leaves the `turn` tier with nothing to withhold — the conservative reading
    // of a transcript whose turn structure the plugin cannot see.
    let lastUserIndex = -1;

    for (let index = 0; index < entries.length; index += 1) {
        if (entries[index].message.role === 'user') lastUserIndex = index;
    }

    const selected: ThoughtCandidate[] = [];

    for (const entry of entries) {
        const message = entry.message;

        if (message.role !== 'assistant') continue;

        // (2) Thinking has to exist to be withheld.
        if (typeof message.reasoning !== 'string' || message.reasoning.length === 0) continue;
        // (3) Idempotence, and the "entry the model never sees" case.
        if (message.reasoningIncluded === false) continue;
        if (entry.included === false) continue;
        // (3b) An entry this SAME pass is about to withhold entirely leaves with its thinking, so
        // a flag here would buy nothing and would inflate the character figure `minThoughtChars` is
        // measured against. Checked before the rescue and the floor, because it is a candidacy rule,
        // not a preference.
        if (withheldEntries?.has(entry.index)) continue;

        const turn: 'open' | 'closed' = entry.index > lastUserIndex ? 'open' : 'closed';

        // (4) The tier.
        if (settings.dropOldThoughts === 'turn' && turn === 'open') continue;

        selected.push({
            entryIndex: entry.index,
            ...(entry.messageId === undefined ? {} : { entryMessageId: entry.messageId }),
            turn,
            chars: message.reasoning.length,
            firedBy: 'dropOldThoughts',
            tier: settings.dropOldThoughts
        });
    }

    // (5) THE RESCUE. `selected` is in canonical (ascending-index) order because that is the order
    // `entries` arrives in, so dropping the LAST N entries is the "N newest" the descriptor names.
    // Not finite or negative behaves as 0 — the read edge does not clamp, so the gate has to.
    const keep = Number.isFinite(settings.thoughtKeepUnits)
        ? Math.max(0, settings.thoughtKeepUnits)
        : 0;
    const rescued = keep === 0 ? selected : selected.slice(0, Math.max(0, selected.length - keep));

    // (6) THE FLOOR, in characters, over what would actually be written. `0` short-circuits it (the
    // shipped posture: no arithmetic on the default path).
    const floor = Number.isFinite(settings.minThoughtChars)
        ? Math.max(0, settings.minThoughtChars)
        : 0;

    if (floor === 0 || rescued.length === 0) return rescued;

    let chars = 0;

    for (const candidate of rescued) chars += candidate.chars;

    // Below the floor the thinking side writes NOTHING — not a partial set: half a batch of thinking
    // is the same cache churn the floor exists to avoid. The tool side is measured by `minTokens`
    // and is not affected by this decision, which is the estimator-blindness rule in force.
    return chars < floor ? [] : rescued;
};

// The guards, in one place, so the shipped handler and a host calling the action directly
// cannot drift: branch first (an ephemeral copy is never trimmed, whatever the knobs say, and
// a branch turn therefore reads NO setting at all), then `enabled` (read per turn, because
// `api.settings` is live by contract — ../plugin/settings.ts), then the recursion guard.
//
// NOTHING ELSE IS READ HERE, on purpose. Every policy switch is read after these three checks
// (`planOf`), which is what keeps a disabled plugin, a branch round and an internal agent at
// the cost they have always cost — one `enabled` read (or none) and no transcript walk — no
// matter how many switches this plugin grows.
const guardPasses = (api: HarnessPluginApi, context: HarnessTurnBeforeContext): boolean => {
    if (context.branchId !== undefined) return false;
    if (!api.settings.boolean('enabled', ENABLED_DEFAULT)) return false;

    return !isInternalAgent(context.agent);
};

// One turn's decision: the policy it ran with, the units the tool rules want withheld, and the
// entries the thinking rule wants flagged (T6). Two lists rather than one because the two axes
// write different fields at different granularity — a unit through `setIncluded`, one entry
// through `setReasoningIncluded` — and a merged list would force the writer to guess.
//
// `settings` travels WITH the plan because the report has to name the configuration that
// actually produced these withholdings, and a second settings read inside the writer would be
// a second answer to the same question (a value changing mid-turn is exactly the race the
// per-turn read exists to avoid).
export type TrimmerPass = {
    settings: TrimmerSettings;
    candidates: readonly TrimCandidate[];
    thoughts: readonly ThoughtCandidate[];
};

// The plan, or an empty one when a guard refused the turn. The ONLY place that touches
// `context.entries`, which is what lets a disabled plugin cost one settings read and no
// transcript walk at all.
const planOf = (api: HarnessPluginApi, context: HarnessTurnBeforeContext): TrimmerPass => {
    // A refused turn reads no policy switch at all, so it reports the shipped defaults (and in
    // practice reports nothing: an empty plan never reaches the writer).
    if (!guardPasses(api, context)) {
        return { settings: TRIMMER_DEFAULT_SETTINGS, candidates: [], thoughts: [] };
    }

    const settings = readTrimmerSettings(api);
    const candidates = planTrimmedUnits(context.entries, settings);

    // The entries the TOOL side is about to remove, cascade included (`members` is the whole unit:
    // the leader plus every result answering one of its calls). The thinking side is handed the set
    // so it does not spend a write, or a counted character, on an entry that will not be in the
    // request at all. Computed from the plan, never from a second settings read, and passed as an
    // argument rather than read inside the policy — that is what keeps `dropOldThoughts` provably
    // independent of the tool switches.
    const withheldEntries = new Set<number>();

    for (const candidate of candidates) {
        for (const member of candidate.members) withheldEntries.add(member);
    }

    return {
        settings,
        candidates,
        // The second axis, planned from the SAME entries snapshot — so the two sides of one pass
        // cannot describe two different transcripts.
        thoughts: planWithheldThoughts(context.entries, settings, withheldEntries)
    };
};

// The pass report's structured view of the POLICY, as opposed to the units. One object per
// pass, always present, so a host can diff "what the trimmer did" across turns without parsing
// prose: every switch as it was resolved, every `string` tier alongside the value that was
// submitted (an operator who typed `"sometimes"` and got `turn` must be able to see BOTH), and
// `fired` — the switches that can account for THESE units, which is the part a one-line message
// cannot state honestly when two switches are on at once.
const policyReportOf = (
    settings: TrimmerSettings,
    candidates: readonly TrimCandidate[],
    thoughts: readonly ThoughtCandidate[] = []
) => {
    // A switch "fired" when it is on AND every withheld unit is one it is admitted to withhold.
    // Reading `admittedBy` rather than re-deriving the predicate here is what keeps the report and
    // the plan from being two answers to one question: the plan already decided, per unit, which
    // switches could have produced it. (A unit admitted by NO switch is impossible — the plan is
    // what produced these — so the three flags together always name the whole decision, in DECLARED
    // order. A switch that is on but admits only PART of a mixed pass names neither: it is the
    // units, not the switches, that a reviewer is auditing.)
    //
    // `candidates.length > 0` is not redundant: `[].every(...)` is TRUE, so without it a
    // thinking-only pass would report all three tool switches as fired for units that do not exist.
    const accountsFor = (rule: TrimmerToolRule, switchOn: boolean): boolean =>
        candidates.length > 0 && switchOn && candidates.every((candidate) => candidate.admittedBy.indexOf(rule) !== -1);

    const fired: string[] = [];

    if (accountsFor('dropSupersededToolCalls', settings.dropSupersededToolCalls)) {
        fired.push('dropSupersededToolCalls');
    }

    if (accountsFor('dropInvalidToolCallsOnceAnswered', settings.dropInvalidToolCallsOnceAnswered)) {
        fired.push('dropInvalidToolCallsOnceAnswered');
    }

    if (accountsFor('dropDuplicateCalls', settings.dropDuplicateCalls)) fired.push('dropDuplicateCalls');

    // The second axis, named last (its position in the declared switch order). It fires exactly
    // when this pass wrote a thinking flag — NOT when the switch is merely on, because a pass that
    // wrote nothing on that axis has nothing to account for, and the tool-side rule above is the
    // precedent for "the units decide".
    if (thoughts.length > 0) fired.push('dropOldThoughts');

    return {
        dropSupersededToolCalls: settings.dropSupersededToolCalls,
        dropInvalidToolCallsOnceAnswered: settings.dropInvalidToolCallsOnceAnswered,
        // '/'-joined so the field is one comparable string; '' means "the generalisation is off".
        invalidOutcomes: settings.invalidOutcomes.join('/'),
        invalidOutcomesSubmitted: settings.invalidOutcomesSubmitted,
        invalidOutcomesFallback: settings.invalidOutcomesFallback,
        dropOldThoughts: settings.dropOldThoughts,
        dropOldThoughtsSubmitted: settings.dropOldThoughtsSubmitted,
        dropOldThoughtsFallback: settings.dropOldThoughtsFallback,
        supersedeMatch: settings.supersedeMatch,
        supersedeMatchSubmitted: settings.supersedeMatchSubmitted,
        supersedeMatchFallback: settings.supersedeMatchFallback,
        dropDuplicateCalls: settings.dropDuplicateCalls,
        thoughtKeepUnits: settings.thoughtKeepUnits,
        minTokens: settings.minTokens,
        minThoughtChars: settings.minThoughtChars,
        safetyUnits: settings.safetyUnits,
        maxUnits: settings.maxUnits,
        fired
    };
};

// The tier clauses a pass adds when a submitted `string` value was NOT honoured. The write
// edge accepts any string (../server/plugins.ts validates type and bounds, never content), so
// a typo lands here, and a human reading the session has to learn what ran rather than
// guessing. Emitted in a FIXED order, and only for the tiers that actually fell back — at the
// declared defaults the message is byte-identical to the one this plugin has always written.
const fallbackClausesOf = (settings: TrimmerSettings): string[] => {
    const clauses: string[] = [];

    if (settings.invalidOutcomesFallback) {
        clauses.push(
            `invalidOutcomes "${settings.invalidOutcomesSubmitted}" has unknown names; used ${
                settings.invalidOutcomes.length === 0 ? 'none (the generalisation is off)' : settings.invalidOutcomes.join('/')
            }`
        );
    }

    if (settings.dropOldThoughtsFallback) {
        clauses.push(
            `dropOldThoughts "${settings.dropOldThoughtsSubmitted}" is not a tier; used "${settings.dropOldThoughts}"`
        );
    }

    if (settings.supersedeMatchFallback) {
        clauses.push(
            `supersedeMatch "${settings.supersedeMatchSubmitted}" is not a matcher; used "${settings.supersedeMatch}"`
        );
    }

    return clauses;
};

// Does this unit's line have to NAME its switch? A unit whose every committed result is
// `failed`/`rejected` is exactly the shape this message has always described — the shipped rule,
// or the generalisation acting on the shipped outcome set, which is the same predicate — so its
// line stays BYTE-IDENTICAL and the H6 "the request and its reports are unchanged at the defaults"
// claim is testable against a hardcoded string. Anything else is a shape the shipped rule could
// never have produced: a `cancelled` or `empty` result, or a unit only `dropDuplicateCalls` could
// withhold (a `completed` answer the model read, superseded by an identical re-run). D4 #1 asks the
// message to say which switch fired, and that is precisely where the wording alone would mislead.
const namesSwitchOnLine = (candidate: TrimCandidate): boolean =>
    candidate.firedBy === 'dropDuplicateCalls' ||
    !candidate.invalidOutcomes.every(
        (outcome) => SHIPPED_INVALID_OUTCOMES.indexOf(outcome as HarnessToolOutcome) !== -1
    );

// THE WRITER. Two axes, one pass, one pause window, one diagnostic:
//   - tool side: one `setIncluded(leader, false)` per candidate — the runtime's cascade excludes
//     the paired tool results too (../types `HarnessTurnBeforeContext.setIncluded`), which is why
//     this never has to think about provider pairing (the pair-clean projection oracle in
//     src/harness.inclusion.test.ts is what pins that);
//   - thinking side (T6): one `setReasoningIncluded(entry, false)` per candidate — no cascade, the
//     entry keeps travelling, and only its request copy loses `reasoning`.
//
// Each candidate's entry is re-located by INDEX rather than reused from the plan, exactly as
// compaction does: if a later handler in this same round replaced the transcript, an entry the plan
// named is simply absent and the write is skipped instead of addressing the wrong turn. Both loops
// skip silently for that reason, and the pass reports NOTHING when neither side wrote.
const applyTrimPlan = async (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext,
    candidates: readonly TrimCandidate[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS,
    thoughts: readonly ThoughtCandidate[] = []
): Promise<void> => {
    // Nothing on either axis: no write, no notification, no save, no report.
    if (candidates.length === 0 && thoughts.length === 0) return;

    const entries = context.entries;
    const trimmed: TrimCandidate[] = [];

    for (const candidate of candidates) {
        const entry = entries.find((lookedUp) => lookedUp.index === candidate.leaderIndex);

        if (entry === undefined) continue;

        // `false` is the only stored spelling of "withheld", so re-enabling is exact and a
        // second pass changes nothing at all.
        context.setIncluded(entry, false);
        trimmed.push(candidate);
    }

    const withheld: ThoughtCandidate[] = [];

    for (const candidate of thoughts) {
        const entry = entries.find((lookedUp) => lookedUp.index === candidate.entryIndex);

        if (entry === undefined) continue;

        // Withhold-only (F invariant 2): this pass never writes `true`, and the flag — not the
        // text — is what changes, so `reasoning` survives in canonical state and an operator can
        // switch it back on.
        context.setReasoningIncluded(entry, false);
        withheld.push(candidate);
    }

    if (trimmed.length === 0 && withheld.length === 0) return;

    // THE PASS REPORT — ONE diagnostic for the whole round, because a multi-unit pass is one
    // logical decision, and the two axes therefore share one report rather than producing two
    // competing messages. Self-contained text, so a host with no structured sink still learns what
    // left the context and what replaced it.
    //
    // Sections, in a FIXED order, joined by ' | ' (the same separator the fallback clauses already
    // use, so an operator reads one machine-parseable line):
    //   1. the tool section — BYTE-IDENTICAL to the message this plugin has always written, and
    //      present only when the tool side wrote;
    //   2. the thinking section — `#<index> <id> <open|closed> <chars> chars via
    //      dropOldThoughts=<tier>` per entry, present only when the thinking side wrote. It names
    //      the turn because "why did the reasoning of MY current turn go" is the first question an
    //      operator asks, and the characters rather than tokens because the estimator does not
    //      count reasoning, so a token figure here would be a number this pass cannot compute;
    //   3. the fallback clauses for submitted values that were not honoured (unchanged).
    const clauses = fallbackClausesOf(settings);
    const sections: string[] = [];

    if (trimmed.length > 0) {
        sections.push(
            `context-trimmer withheld ${trimmed.length} superseded tool unit(s): ${trimmed
                .map(
                    (candidate) =>
                        `#${candidate.leaderIndex}${
                            candidate.leaderMessageId === undefined
                                ? ''
                                : ` ${candidate.leaderMessageId}`
                        } [${candidate.invalidOutcomes.join('/')}] ${candidate.names.join('+')} answered by ${
                            candidate.resolverMessageId ?? `index:${candidate.resolverIndex}`
                        }${namesSwitchOnLine(candidate) ? ` via ${candidate.firedBy}` : ''}`
                )
                .join('; ')}`
        );
    }

    if (withheld.length > 0) {
        sections.push(
            `context-trimmer withheld ${withheld.length} thinking entry(s): ${withheld
                .map(
                    (candidate) =>
                        `#${candidate.entryIndex}${
                            candidate.entryMessageId === undefined
                                ? ''
                                : ` ${candidate.entryMessageId}`
                        } ${candidate.turn} ${candidate.chars} chars via ${candidate.firedBy}=${candidate.tier}`
                )
                .join('; ')}`
        );
    }

    sections.push(...clauses);

    api.report.diagnostic({
        message: sections.join(' | '),
        data: {
            units: trimmed.map((candidate) => ({
                index: candidate.leaderIndex,
                ...(candidate.leaderMessageId === undefined
                    ? {}
                    : { messageId: candidate.leaderMessageId }),
                members: candidate.members,
                // Stored outcomes (`what the transcript records`) next to the effective ones
                // (`what the pass judged`): the two differ exactly for `empty`, where the result
                // really does say `completed`, and a reader needs both to tell a withheld stub from
                // a withheld zero-hit search result.
                outcomes: candidate.outcomes,
                invalidOutcomes: candidate.invalidOutcomes,
                names: candidate.names,
                supersededBy: candidate.resolverMessageId ?? `index:${candidate.resolverIndex}`,
                // D4 #1's per-unit half: which switch this unit's line belongs to, and every switch
                // that could have produced it (two are on together almost always).
                firedBy: candidate.firedBy,
                admittedBy: candidate.admittedBy
            })),
            // The thinking side's per-entry half, always present (empty when this pass touched no
            // thinking) so the record's SHAPE does not depend on which switches fired.
            thoughts: withheld.map((candidate) => ({
                index: candidate.entryIndex,
                ...(candidate.entryMessageId === undefined
                    ? {}
                    : { messageId: candidate.entryMessageId }),
                turn: candidate.turn,
                chars: candidate.chars,
                firedBy: candidate.firedBy,
                tier: candidate.tier
            })),
            policy: policyReportOf(settings, trimmed, withheld)
        }
    });
};

// THE ACTION — guards, plan, write, report. Exported because a host may want the same trim on
// a trigger of its own; it is also what the shipped handler runs inside its pause window.
export const executeTrimming = async (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
): Promise<void> => {
    const pass = planOf(api, context);

    await applyTrimPlan(api, context, pass.candidates, pass.settings, pass.thoughts);
};

// The WRITER's shape (the third argument is the plan the guard already computed, so a turn
// never walks the transcript twice; the fourth is the policy that plan was computed under, and the
// fifth is the thinking side of the same plan — both OPTIONAL so a host writer written before the
// switch split, and any host that does not care about thinking, keeps the exact signature it
// already has). The host-facing two-argument entry point above is `executeTrimming`; this one is
// the seam a test or a host reuses to observe the exact park/trim/unpark sequence without
// re-implementing the guards.
export type HarnessTrimmingAction = (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext,
    candidates: readonly TrimCandidate[],
    settings?: TrimmerSettings,
    thoughts?: readonly ThoughtCandidate[]
) => Promise<void>;

// Builds the `turn.before` handler: guard + pure plan synchronously, and the park/trim/unpark
// sequence only on a turn that will actually write.
export const createContextTrimmerHandler = (
    api: HarnessPluginApi,
    action: HarnessTrimmingAction = applyTrimPlan
): HarnessLifecycleHandler<'turn.before'> => {
    // The park/trim/unpark triple. `pause()` is outside the try because a pause that failed
    // has nothing to undo; the throw is left to the bus (fail-open), so the plugin decides
    // only about the thread's state, never about the run.
    const pass = async (
        context: HarnessTurnBeforeContext,
        candidates: readonly TrimCandidate[],
        settings: TrimmerSettings,
        thoughts: readonly ThoughtCandidate[]
    ): Promise<void> => {
        await context.pause();

        try {
            await action(api, context, candidates, settings, thoughts);
        } finally {
            await context.resume();
        }
    };

    // SYNC fast path, deliberately not an `async` function (see the header): the path that
    // runs on nearly every turn returns `undefined` and costs one microtask; only a real trim
    // returns a promise. Twelve settings reads are all SYNCHRONOUS, so more switches did not
    // move this turn onto a promise — the plan is still a pure read and the answer is still
    // `undefined` by the time the handler returns. A thinking-only pass DOES take the promise
    // path, because it is a pass that writes.
    return (context) => {
        const { settings, candidates, thoughts } = planOf(api, context);

        if (candidates.length === 0 && thoughts.length === 0) return undefined;

        return pass(context, candidates, settings, thoughts);
    };
};

// Wiring only: the framework hands the scoped api, the guard owns the behaviour. The arrow
// form (not a reference) is what the manifest scanner's `setup` regex requires.
export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    api.on('turn.before', createContextTrimmerHandler(api));
};

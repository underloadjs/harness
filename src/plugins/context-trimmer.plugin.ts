// Context Trimmer — the shipped preset plugin (R5).
//
// WHAT THIS FILE DOES
// -------------------
// At the START OF EVERY ASSISTANT TURN (`turn.before`, before `brain.turn()` is asked for
// anything), this plugin walks the conversation and switches off the parts of it the model no
// longer needs. Three axes, one pass, in this order:
//   1. WHOLE-UNIT TRIM — a tool unit whose every committed result `failed`/`rejected` (or whatever
//      `invalidOutcomes` names), was superseded, or is a redundant re-run, stops being sent
//      ENTIRELY: the assistant entry that asked for the calls AND every result answering one of
//      them. The write is the shipped per-entry `setIncluded(entry, false)` flag, one call per
//      member, because since R8 that flag moves exactly one entry and a unit is a policy-side
//      grouping (../harness.ts:622-633). Both halves go, so the request stays pair-clean — and when
//      axis 2 took ONE half on an earlier turn, this axis still acts and writes only the members
//      that are being sent (see "THE WRITE SET IS PER MEMBER" below);
//   2. TRUNCATE REQUEST — the opposite cut: the assistant REQUEST entry leaves and the tool RESULTS
//      keep riding, which is only expressible because the flag is per entry. Off by default;
//      `truncateToolRequests` + `truncateTurns` own it;
//   3. WITHHOLD THINKING — an assistant entry keeps travelling while its `reasoning` is flagged out
//      of the request copy (`setReasoningIncluded`). `trimThoughts` + `thoughtTurns` own it.
//
// Nothing is deleted: a trimmed unit, a truncated request and a flagged thought all keep their
// place in canonical history, and a host (or the UI) can switch each one back on.
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
// WHY THE HORIZONS DEFAULT TO 2 AND THE ECONOMY KNOBS TO 0
// --------------------------------------------------------
// Every eligibility rule here is windowed by a HORIZON in turns, and every horizon is a number the
// operator reads the same way: `N` protects the N most recent things of that kind, the entry is
// eligible at N+1, and `0` protects nothing. The four turn horizons (`invalidToolTurns`,
// `thoughtTurns`, `truncateTurns`, `supersededTurns`, plus `duplicateTurns`) all DEFAULT to 2, so
// out of the box nothing is touched in the last two tool turns and the last two recorded thoughts.
// That is a deliberate change from the first cut of this plugin, which had no horizon on its tool
// rules at all: the operator-facing promise is now "the recent conversation is yours, the old
// scaffolding is mine", and a failure the model replaced one step ago is exactly the pair an
// operator does NOT want to watch leave the context between two turns.
//
// What the horizons count is stated per rule and never guessed: `invalidToolTurns` /
// `supersededTurns` / `duplicateTurns` / `truncateTurns` count TOOL TURNS (a unit whose leader
// carries `toolCalls`), and `thoughtTurns` counts THOUGHT ENTRIES (an assistant entry carrying a
// non-empty `reasoning`). Neither is `context.iteration`, which counts model steps inside ONE run
// (`../types`) and cannot express a conversation-level position, and neither is `safetyUnits`,
// which is the separate, older knob that counts WHOLE transcript units from the end.
//
// The ECONOMY knobs (`minTokens`, `safetyUnits`, `maxUnits`) still default to 0, and at 0 each gate
// is a pass-through. Compaction is an expensive, rare, whole-conversation event, so it is guarded by
// a limit, a savings floor, a tail horizon and a per-thread cooldown. Trimming's OWN argument
// against those guards is still true at the declared defaults: it is a flag write per withheld unit,
// it is idempotent by construction (a unit whose EVERY entry is already excluded is skipped, so a
// second pass writes NOTHING and therefore produces no persistence notification and no save — and
// that skip is measured PER MEMBER, never at `unit.included`, because axis 2 leaves a unit HALF
// excluded and the surviving half still has to be trimmable), and a unit can only ever
// be trimmed once the answer exists somewhere above it. That is why those three default to 0, and
// at 0 the shipped request is untouched by THEM.
//
// The argument has two soft spots once this plugin is the ONLY trimmer (F4 of the task entry), and
// the knobs are the operator's levers for them: a first pass over a conversation restored weeks
// ago withholds every superseded unit at once, and a per-turn pass with no floor can invalidate a
// provider's prompt cache to save 40 tokens. So EACH tool axis — the whole-unit set and the truncate
// set, separately — runs the gates in this fixed order:
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
// The gates below therefore run over the TOOL candidates only — and, deliberately, SEPARATELY for
// each tool axis (the whole-unit set, then the truncate set), because a truncation that saves
// nothing must not ride along on a trim that does. A thinking write is never measured in tokens —
// `minTokens` cannot suppress one at any value, and `context-trimmer.test.ts` pins that with an
// unreachable floor next to a thinking-only pass. `minThoughtChars` is the thinking twin: the SAME
// kind of floor, in CHARACTERS, applied to the thinking side's own selection.
//
// THE THINKING RULE — THE THIRD AXIS, AND WHY IT IS NOT A TEXT EDIT
// -----------------------------------------------------------------
// `trimThoughts` withholds the model's own recorded thinking from the requests that follow, and
// `thoughtTurns` says how RECENT thinking is safe. The write is the per-entry FLAG
// `reasoningIncluded: false` (`../types` `HarnessTurnBeforeContext.setReasoningIncluded`), NOT a
// destructive edit of `reasoning`: the text stays in canonical history, a host can switch it back
// on, and this plugin's own "nothing is deleted" promise (top of this file) holds for thinking
// exactly as it holds for units. The projection RESOLVES the flag out — a flagged entry is still
// EMITTED, with its `content` and `toolCalls` untouched, and its request copy omits `reasoning`
// ENTIRELY (`../core/agent.ts` `withoutWithheldReasoning`, run by `../harness.ts`
// `projectTranscript`), so the transport needs no new field: the ABSENCE of `reasoning` is the wire
// signal.
//
// THE HORIZON COUNTS THOUGHTS, NOT TURNS AND NOT UNITS. `thoughtsAgo` is 0 for the newest entry in
// the transcript that actually carries a non-empty `reasoning`, 1 for the one above it, and so on;
// `thoughtTurns` admits everything at or beyond it. A unit is not the unit of account here because
// one tool turn can carry zero, one or several thoughts (a multi-call block, a thought recorded
// beside a tool result), and a knob that moved with units would let the operator's "2" mean three.
// `context.iteration` is worse still: it counts model steps inside ONE run (`../types`) and says
// nothing about where an entry sits in the conversation.
//
// THE TURN BOUNDARY IS REPORTED, NOT DECIDED. The OPEN turn is every committed assistant entry after
// the last `user` entry in canonical order; everything at or before it is CLOSED. The rule is
// re-read from canonical order every turn and never remembered, because a mailbox/autoanswer user
// message legitimately MOVES the boundary — it really does open a new turn in the same transcript —
// and `iteration` cannot express that. Each candidate carries `turn` and `turnsAgo` so the operator
// can see WHICH thought left and HOW old it was; that is what makes the "why did my current turn's
// reasoning go" question answerable from one line.
//
// THE HORIZON CAN REACH THE OPEN TURN, AND THE DEFAULT IS NOT A BLANKET PROTECTION FOR IT. The rank
// is over THOUGHTS, so a turn that carries only one or two thoughts keeps all of them at the shipped
// horizon of 2 — but a turn carrying THREE or more thoughts has its OWN oldest thought ranked `2` by
// now, and it goes on the turn it was committed. The arithmetic is pinned by
// `context-trimmer.test.ts` "the horizon protects the N newest thoughts — the N / N+1 boundary,
// exactly", and "a transcript with no user entry is ALL one turn, and the horizon still decides"
// pins the open-turn candidate itself (`turn: 'open'` with a rank that qualifies). No separate
// "protect the current turn" tier survives here: the old `off|turn|all` tier and its
// `thoughtKeepUnits` rescue both answered a question the operator chose to move to a thought count,
// in fewer numbers and with a smaller surface — the tier was removed because the operator replaced
// its unit of account, NOT because the horizon cannot reach the open turn.
//
// The order is horizon → floor, and the floor measures what would ACTUALLY be written: an entry this
// same pass is already withholding WHOLE (the tool axes take it, thinking and all) is not a thinking
// candidate, so its characters cannot inflate the figure `minThoughtChars` is compared against.
//
// Withhold-only, like every other switch here: the plugin never writes `true`, so turning the
// switch off stops new writes and restores nothing an earlier turn already withheld (F invariant 2).
// The `true` side of the control exists for the operator and the host API.
//

// THE SWITCH SURFACE (the 2026-11-13 trimmer clean-up)
// ----------------------------------------------------
// The ENGINE core trims nothing: the projection is a pure skip filter over canonical history
// and nothing in it windows, truncates or elides (src/harness.ts `projectTranscript`). This
// built-in is therefore the ONE place trimming happens, and "one place" is not "one switch":
// a single `enabled` conflated "this plugin exists" with "this policy runs", so an operator
// who wanted old thinking withheld and superseded failures kept had no lever. The policy
// space is declared as THREE toggle+horizon options the pane can show side by side —
// `trimInvalidTools` + `invalidToolTurns`, `trimThoughts` + `thoughtTurns`,
// `truncateToolRequests` + `truncateTurns` — plus the two tool rules that already had a toggle
// (`dropSupersededToolCalls` + `supersededTurns`, `dropDuplicateCalls` + `duplicateTurns`), the
// strictness knobs (`invalidOutcomes`, `supersedeMatch`) and the economy knobs
// (`minTokens`/`minThoughtChars`/`safetyUnits`/`maxUnits`). Every horizon sits immediately AFTER
// its toggle in the declared list, because the descriptor list IS the render order
// (src/frontend/main.ts `buildSettingField`, the row builder `openPluginDialog` calls per
// descriptor) and a number separated from the switch
// it belongs to is a number an operator has to map by name alone. Since 2026-11-13 that list is
// ALSO grouped: each policy declares a `group` (its category) and its dependent fields declare a
// `parentKey` (the checkbox that reveals them), so a strictness knob now sits under the policy it
// gates — `invalidOutcomes` under the invalid-tools rule, `supersedeMatch` under supersession,
// `minThoughtChars` under the thinking rule — and the three knobs that gate no policy of their own
// sit in Global Limits. Display metadata only: nothing at runtime reads it.
// Three rules every one of them obeys, and none of them is a boolean:
//   - WITHHOLD-ONLY inside a session: a switch flipped off stops NEW writes and restores
//     nothing an earlier turn already withheld. That is what lets the compactor skip any
//     phase check against this pass (../plugins/context-compaction.plugin.ts reasons about
//     exactly that). The OPERATOR half of that rule — "I turned it off and my context did not
//     come back" — is stated once, on the `enabled` row's hint, the first row of the pane; it is
//     NOT repeated on all seventeen, because repeating it is the boilerplate the clean-up removed.
//     Blind re-enabling is deliberately not offered: nothing here writes `true`, and there is no
//     provenance marker telling a flag this pass wrote from one the operator set by hand, so
//     "restore what this plugin hid" would resurrect entries the operator excluded on purpose;
//   - NOTHING IS DELETED. A withheld unit, a truncated request and a flagged thought all stay
//     in canonical history;
//   - a `completed` result is never invalid on its own (only `dropDuplicateCalls`, on an
//     exact fingerprint match), an UNANSWERED unit is never touched, and a branch round or an
//     internal agent's transcript is never trimmed — no setting is even read on one.
//
// THE TOOL RULES, AND WHICH SWITCH ADMITS WHAT
// --------------------------------------------
// One walk of the unit mirror produces ONE whole-unit candidate list, and a unit can be admitted
// by more than one switch at once — the list carries `admittedBy` (every switch that admits it)
// and `firedBy` (the switch the report attributes it to, in ATTRIBUTION order). The rules:
//   1. `dropSupersededToolCalls` + `supersededTurns` — the shipped predicate, VERBATIM:
//      `kind === 'candidate'`, i.e. core's own class for a fully answered block whose every
//      committed result is `failed` or `rejected` (`../core/context-pruning.ts:320-331`). With
//      `supersedeMatch: 'name'` the predicate itself is byte-for-byte what shipped before the
//      switch split; the horizon is the only thing that changed, and the pre-existing tables are
//      the proof of the predicate.
//   2. `trimInvalidTools` + `invalidToolTurns` + `invalidOutcomes` — the same shape over a WIDER
//      set of invalid results, expressed as a predicate over each committed result's EFFECTIVE
//      outcome (the mapping is below). Its guards are the shipped rule's guards, unchanged: the
//      unit is a tool unit whose entries are still being sent (in whole or in part — see "THE WRITE
//      SET IS PER MEMBER" below), every call of it is answered, every committed result is
//      invalid, and every name it called has a later still-included `completed` answer.
//      THE LAST CLAUSE IS THE LOAD-BEARING ONE, and it is why this row keeps a hint: the label
//      reads as unconditional, but the rule is the MOST gated one here. A failed block whose tool
//      is never called again — an abandoned error, a failure the model routed around, a resolver
//      unit the operator or an earlier pass already withheld — is invisible to it (`firstAnswerOf`
//      refuses a resolver that is not fully included, because otherwise BOTH halves would leave),
//      so switching this on over unresolved failures changes NOTHING, silently: no flag, no park,
//      no diagnostic line (`context-trimmer.test.ts` "a withheld resolver is not evidence" and the
//      `keeps every shape that has no included later answer` table are the proof).
//   3. `dropDuplicateCalls` + `duplicateTurns` — a LATER unit re-ran the SAME work (fingerprint,
//      never name) and answered it healthily, so the earlier unit is redundant whatever it itself
//      produced. This is the rule that reaches `answered` units (F2's duplicate-successful-call
//      class, the largest redundancy in a long trajectory), and precisely because it can withhold
//      work the model read and used, it is off by default and strictly fingerprint-matched EVEN
//      WHEN `supersedeMatch` says `'name'`.
// Rules 1 and 2 share ONE evidence search (the matcher `supersedeMatch` picks); rule 3 has its own,
// fingerprint-only. All three end in the SAME write — every member of the unit that is STILL being
// sent flagged, one `setIncluded` call each — and the SAME single diagnostic: one pass, one
// decision, one line per withheld unit.
//
// THE TRUNCATE AXIS IS NOT A FOURTH RULE — IT IS A DIFFERENT SHAPE OF WRITE (R3)
// ------------------------------------------------------------------------------
// `truncateToolRequests` + `truncateTurns` never asks whether a unit is redundant. It asks whether
// a tool turn is OLD ENOUGH that its QUESTION is no longer worth sending, and its answer is a write
// on the REQUEST entry alone: the model keeps the tool result and loses the call that produced it,
// which is the half of a stale exchange that carries the least information (the arguments of a call
// from six turns ago are already in the answer underneath them). It shares the tool-turn horizon
// definition, the economy gates and the diagnostic with the rules above, and it is OFF by default
// because it is the only axis here that can strand a result without its call.
//
// THE WRITE SET IS PER MEMBER — BOTH AXES, EVERY TURN (2026-11-13 review)
// -----------------------------------------------------------------------
// Axis 2 writes ONE entry and axis 1 wants the unit whole, so the two axes meet in a state this
// plugin creates for itself: a unit whose REQUEST is withheld and whose RESULTS are still being
// sent. Eligibility AND the write set are therefore both derived per member (`includedMembersOf`),
// never off `unit.included`, which is the conjunction over the whole unit. Testing candidacy at the
// unit made a request-truncated unit invisible to the invalid, superseded and duplicate rules
// FOREVER, so the junk result the operator's "trim invalid tools older than 2 turns" promise is
// about rode in every later request — and at the declared defaults both axes sit on the SAME
// horizon of 2, so whichever one fired first simply won the unit and the other never saw it again.
// A pass now skips a unit only when NOTHING is left to write, which keeps the idempotence promise
// exactly as strong (a second pass over an unchanged transcript still writes nothing, notifies
// nothing and saves nothing) while making the surviving half trimmable. The same reasoning and the
// same fix are core's rule 5 in ../core/context-pruning.ts, so both shipped passes agree.
//
// THE TOKEN ACCOUNT FOLLOWS THE WRITE SET, NOT THE UNIT. `applyEconomyGates` measures
// `candidate.members`, and `members` is now the still-sent half, so the figure `minTokens` judges
// (and the figure a completion pass reports) is the text THIS pass actually removes. A unit whose
// request left on an earlier turn is worth its surviving results — billing the request again would
// claim the same saving twice, which is the failure mode compaction's plan fixed the same way.
//
// WHAT DELIBERATELY DOES NOT CHANGE is the RESOLVER gate: `firstAnswerOf` still refuses a unit that
// is not FULLY included as evidence, because withholding a failure on the strength of an answer the
// model cannot see would drop BOTH halves. Relaxing it would widen what leaves the context rather
// than just decide where the write lands, so a half-truncated unit can be trimmed but still cannot
// prove another unit stale — the conservative direction, and the operator's rule ("only trim when
// the answer really is in the window").
//
// THE PRECEDENCE IS FIXED AND REPORTED (R6)
// -----------------------------------------
// `planOf` runs the axes in one order, every turn: whole-unit trim, then truncate, then thinking.
// Truncation skips a unit the whole-unit rules already took in THIS pass (one decision, one write,
// no line claiming a request that is already gone), and thinking skips an entry either tool axis
// already removes. The pass report carries the order as `policy.precedence`, so a reviewer reading
// "withheld 1 unit" next to "truncated 2 requests" never has to wonder which decision produced a
// given entry, and the per-entry flags alone cannot answer that because a truncated unit is HALF
// excluded.
//
// The precedence orders the writes of ONE pass; it is not a permanent claim on a unit. A unit that
// truncation took in an EARLIER pass stays eligible for the whole-unit rules in every later pass,
// and when one of them finishes it, THAT rule owns the record: `data.units[]` carries it, with
// `requestAlreadyWithheld: true` and a ` request already withheld` clause on its line, and
// `data.truncated[]` does not, because this pass wrote no truncation at all — the request entry is
// not written twice, and `policy.fired` therefore cannot name `truncateToolRequests` for a write it
// did not make. Attribution follows the rule that COMPLETED the unit, which is the only honest
// answer once a unit can leave in two steps.
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
//                                                   `setIncluded` (the per-entry flag write, R8)
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
    // ONE short sentence, SHORTER than Context Compacting's (`../plugins/context-compaction.plugin.ts:367`
    // is 87 chars; this is 83) — the operator reads the two plugins side by side in the same pane and
    // the row has to look the same size. The long form used to restate what the switches below say.
    // The full rationale lives in this file's header.
    description:
        'Withholds superseded tool units, stale tool requests and thinking; deletes nothing.',
    version: '1.0.0',
    tags: ['context', 'trimming', 'lifecycle'],
    builtin: true,
    hooks: ['turn.before'],
    // THE SWITCH SURFACE (the 2026-11-13 trimmer clean-up, grouped the same week).
    //
    // DECLARATION ORDER IS RENDER ORDER: the Plugins pane builds one control per descriptor in
    // this array's order (src/frontend/main.ts `buildSettingField`, inside `openPluginDialog`). Two
    // ADDITIVE, DISPLAY-ONLY fields now say what that order means: `group: {id, title}` files a row
    // under one named category (the renderer opens a section per `id`, in first-appearance order,
    // and prints `title` verbatim), and `parentKey: '<boolean key>'` nests a row UNDER that
    // checkbox — hidden while it is off, indented under it when it is on. A descriptor with neither
    // renders in the flat top-level run exactly as it did before the fields existed, which is why
    // `enabled` (no group) and the three Global Limits rows (group, no parent) look unremarkable.
    // The list is therefore written CATEGORY BY CATEGORY: the policy toggle first, then the
    // horizons and string tiers that window it, each still immediately after its own toggle — the
    // adjacency `context-trimmer.test.ts` pins. Neither field is read by the runtime, the validation
    // edge or the store (../types, ../plugin/settings.ts, ../server/plugins.ts), so
    // `readTrimmerSettings` below keeps the read order it has always had.
    //
    // THE HINT POLICY (the copy half of that clean-up). A `description` here becomes a
    // `.plugin-setting-hint` under the control — the generic renderer emits one per declared
    // description and nothing else — so this list, not this file's header, is what the operator
    // reads. Context Compacting declares SIX rows and ZERO descriptions; this list used to declare
    // seventeen hints totalling ~1.2k characters, five of them the same sentence, and that is the
    // row that looked noisy. So: a row carries a hint ONLY when the label plus the published
    // `min`/`max` cannot already answer the operator's question. Nine of the seventeen do, and each
    // of those nine states something that is otherwise a SILENT surprise:
    //   - the closed-set enumerations (`invalidOutcomes`, `supersedeMatch`) — the values are not
    //     listed anywhere the operator can see, and `outcomeSetOf` splits on `,` ONLY
    //     (`;`-separated input resolves to an empty set, which turns the rule off), so that
    //     separator is stated in the hint;
    //   - the gates that produce a silent NO-OP rather than an error: `trimInvalidTools`
    //     (the resolver gate below), `minTokens` (the floor runs PER AXIS), `maxUnits`
    //     (`0` is unbounded HERE, where compaction's same-named knob means "nothing");
    //   - the one horizon hint (`invalidToolTurns`) states the rank semantics ONCE for all five
    //     horizons instead of repeating "protect the newest N, 0 protects none" five times;
    //   - `enabled` carries the withhold-only caveat (see the rule below), stated exactly once
    //     where every operator reads it, instead of seventeen times;
    //   - `truncateToolRequests` states the half that survives, because "truncate" alone reads
    //     like the whole exchange left;
    //   - `dropDuplicateCalls` states that it is fingerprint-only whatever `supersedeMatch` says.
    // Every hint stays ONE short clause of at most 90 characters (`context-trimmer.test.ts` pins
    // both limits and the exact set of rows allowed to have one); the algorithm's rationale stays
    // in this file's header, where it belongs.
    settings: [
        {
            key: 'enabled',
            // Master switch label (mirrors `title`): `enabled` gates hook delivery for every
            // setting below, so the label names the plugin's whole activity, like compaction's
            // 'Compact conversations'. The framework owns this key (src/plugin/host.ts reads the
            // same stored value to gate the hook), so its behaviour is unchanged. It declares NO
            // `group` on purpose: the master switch sits above the policy categories, and filing it
            // inside one would make "is this plugin running at all" a question about a section it
            // does not belong to.
            label: 'Context trimming',
            type: 'boolean',
            default: true,
            // THE ONE PLACE the withhold-only caveat is stated (header, "Three rules every one of
            // them obeys"). This is the first row of the pane, so every operator reads it, and it
            // is the sentence that answers "I turned it off and my context did not come back".
            description: 'Turns each policy off from the next turn; entries already withheld stay out.'
        },

        // ==== CATEGORY: INVALID TOOLS ======================================================
        // One policy per category, and the fields that WINDOW that policy carry
        // `parentKey: '<the toggle>'` so the pane draws them indented under the checkbox and hides
        // them the moment it is off. `group.id` is the stable identity/order key; `group.title` is
        // the heading text, spelled the way the operator named the categories.
        {
            // THE INVALID-TOOLS RULE (replaces `dropInvalidToolCallsOnceAnswered`).
            key: 'trimInvalidTools',
            group: { id: 'invalid-tools', title: 'Invalid Tools' },
            label: 'Automatic Trim Invalid Tools',
            type: 'boolean',
            default: true,
            // THE GATE IS THE COPY (FIX 2). The label reads as unconditional and the rule is the
            // most gated one in this plugin: without a later, still-included `completed` answer for
            // EVERY name (`answersWorkOf` → `firstAnswerOf`), an invalid unit stays and the pass
            // says nothing at all. An operator who turns this on over unresolved failures gets a
            // silent no-op, so the hint states the precondition instead of the feature.
            //
            // At the shipped `invalidOutcomes` this is ALSO the same predicate as
            // `dropSupersededToolCalls` below (header, "THE EFFECTIVE OUTCOME MAPPING"), which is
            // why that row carries no hint of its own: two hints would be two wordings of one rule.
            // The distinction is documented in docs/plugins.md, not repeated per row.
            description: 'Trims nothing until a later included completed call answers every tool name it called.'
        },
        {
            key: 'invalidToolTurns',
            group: { id: 'invalid-tools', title: 'Invalid Tools' },
            parentKey: 'trimInvalidTools',
            label: 'Invalid tools · trim after (tool turns)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            step: 1,
            // THE ONE HORIZON HINT. It states the rank semantics for ALL FIVE horizons
            // (`invalidToolTurns`, `thoughtTurns`, `truncateTurns`, `supersededTurns`,
            // `duplicateTurns`): N protects the N newest of that kind, counted newest-first, the
            // entry is eligible at N+1, and 0 exempts nothing beyond the ordinary guards. The unit
            // of each horizon is in its own label ("(tool turns)" / "(thoughts)"), so the four
            // sibling rows need no copy of their own — this sentence used to appear five times.
            description: 'Protects the newest N tool turns; 0 protects none.'
        },
        {
            key: 'invalidOutcomes',
            group: { id: 'invalid-tools', title: 'Invalid Tools' },
            parentKey: 'trimInvalidTools',
            label: 'Outcomes that count as invalid',
            type: 'string',
            default: 'failed,rejected',
            // THE CLOSED SET, spelled out (nothing else in the pane lists it) AND the separator:
            // `outcomeSetOf` splits on `,` ONLY, so `"failed; rejected"` parses to an EMPTY set,
            // which is documented as "the rule is off" rather than a fallback — a silent outcome of
            // a character the operator picked. `empty` is the dangerous value: it is read off the
            // result TEXT, so a zero-hit `grep` and a stub are the same thing to this rule.
            description: 'Comma-separated subset of failed, rejected, cancelled, empty; empty means a blank result.'
        },

        // ==== CATEGORY: CHAIN OF THOUGHTS ==================================================
        {
            // THE THINKING RULE (replaces the `dropOldThoughts` tier and `thoughtKeepUnits`).
            key: 'trimThoughts',
            group: { id: 'chain-of-thoughts', title: 'Chain of Thoughts' },
            label: 'Automatic Trim Thoughts',
            type: 'boolean',
            default: true
        },
        {
            // The unit of account is IN THE LABEL ("(thoughts)"), and the rank semantics are stated
            // once on `invalidToolTurns`; nothing left for this row to say.
            key: 'thoughtTurns',
            group: { id: 'chain-of-thoughts', title: 'Chain of Thoughts' },
            parentKey: 'trimThoughts',
            label: 'Thoughts · trim after (thoughts)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            step: 1
        },
        {
            // The floor's thinking twin, filed WITH the rule it gates: it is read at step (5) of the
            // thinking selector and reaches nothing else (the tool axes are measured by `minTokens`,
            // and the estimator never counts `reasoning` — ../core/context-estimate.ts:34-35), so an
            // operator who turns thinking off never has to wonder what this number gates. WHAT a
            // floor does is stated once, on `minTokens`; this row adds nothing.
            key: 'minThoughtChars',
            group: { id: 'chain-of-thoughts', title: 'Chain of Thoughts' },
            parentKey: 'trimThoughts',
            label: 'Minimum thinking saved per pass (characters)',
            type: 'number',
            default: 0,
            min: 0,
            max: 1000000,
            step: 50
        },

        // ==== CATEGORY: SUPERSEDED TOOLS ===================================================
        {
            key: 'dropSupersededToolCalls',
            group: { id: 'superseded-tools', title: 'Superseded Tools' },
            label: 'Automatic Trim Superseded Tools',
            type: 'boolean',
            default: true
            // NO HINT, on purpose: at the shipped `invalidOutcomes` this is the SAME predicate as
            // `trimInvalidTools` above (header, "THE EFFECTIVE OUTCOME MAPPING" — core's own
            // `candidate` class over the same two conditions), and `context-trimmer.test.ts`
            // "trimInvalidTools: false leaves the shipped rule as the only tool policy" proves the
            // two are interchangeable there. Two rows, two wordings of one rule, is precisely the
            // noise the clean-up removed; the equivalence is documented in docs/plugins.md.
        },
        {
            key: 'supersededTurns',
            group: { id: 'superseded-tools', title: 'Superseded Tools' },
            parentKey: 'dropSupersededToolCalls',
            label: 'Superseded tools · trim after (tool turns)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            step: 1
        },
        {
            // Filed with the supersession rules because that is the only place it is read: BOTH
            // supersession rules consult it, and the duplicate rule never does (header, "THE TOOL
            // RULES", rule 3) — which is what `dropDuplicateCalls`'s hint says out loud.
            key: 'supersedeMatch',
            group: { id: 'superseded-tools', title: 'Superseded Tools' },
            parentKey: 'dropSupersededToolCalls',
            label: 'Supersession match',
            type: 'string',
            default: 'name',
            // The other closed set: two values, both spelled, because `'name'` vs `'fingerprint'`
            // decides whether a retry with DIFFERENT arguments counts as an answer (header,
            // "HOW IT DIFFERS FROM CONTEXT COMPACTION").
            description: "'name' matches any later call of the tool; 'fingerprint' needs identical arguments."
        },

        // ==== CATEGORY: DUPLICATE TOOLS ====================================================
        {
            key: 'dropDuplicateCalls',
            group: { id: 'duplicate-tools', title: 'Duplicate Tools' },
            label: 'Automatic Trim Duplicate Tools',
            type: 'boolean',
            default: false,
            // Non-inferable and load-bearing: this rule ignores `supersedeMatch` (header, "THE TOOL
            // RULES", rule 3), because withholding work the model actually READ needs the re-run to
            // be the same work, not just the same tool.
            description: 'Needs an exact re-run with identical arguments; supersedeMatch does not widen it.'
        },
        {
            key: 'duplicateTurns',
            group: { id: 'duplicate-tools', title: 'Duplicate Tools' },
            parentKey: 'dropDuplicateCalls',
            label: 'Duplicate tools · trim after (tool turns)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            step: 1
        },

        // ==== CATEGORY: TOOL REQUESTS ======================================================
        {
            // THE TRUNCATE RULE (new). Only the assistant REQUEST entry leaves; its tool results
            // stay in the context, so this is the one axis that does not withhold a whole unit.
            key: 'truncateToolRequests',
            group: { id: 'tool-requests', title: 'Tool Requests' },
            label: 'Automatic Truncate Tool Requests',
            type: 'boolean',
            default: false,
            // "Truncate" alone reads like the exchange left. The surviving half is the feature, and
            // it is what `data.truncated[].results` reports, so the row says it.
            description: 'Drops the request entry only; its tool results stay in the request.'
        },
        {
            key: 'truncateTurns',
            group: { id: 'tool-requests', title: 'Tool Requests' },
            parentKey: 'truncateToolRequests',
            label: 'Truncate tool requests after (tool turns)',
            type: 'number',
            default: 2,
            min: 0,
            max: 4096,
            step: 1
        },

        // ==== CATEGORY: GLOBAL LIMITS ======================================================
        // The three knobs that gate NO policy of their own: they bound what any pass may write, so
        // they carry no `parentKey` — they apply whether every policy above is on or off.
        {
            key: 'minTokens',
            group: { id: 'global-limits', title: 'Global Limits' },
            label: 'Minimum saving per pass (tokens)',
            type: 'number',
            default: 0,
            min: 0,
            max: 1000000,
            step: 50,
            // The per-axis scoping is the part an operator cannot see, so it is stated HERE, on the
            // floor the operator reaches for first: a floor that empties the whole-unit plan leaves
            // the truncate plan running (the gates run PER AXIS, `applyEconomyGates`), and the
            // token floor never touches thinking at all, because the estimator does not count
            // `reasoning` (`../core/context-estimate.ts:34-35`). Both are silent, so both are
            // stated — and `minThoughtChars`, now filed with the thinking rule it gates, needs no
            // copy of its own once this row says tokens stop at the tool axes.
            description: 'Each tool axis must save this many tokens, or it writes nothing; thinking is never gated.'
        },
        {
            // The label and `min`/`max` carry this row: units, counted from the END of the
            // transcript, tool rules only. docs/plugins.md has the detail.
            key: 'safetyUnits',
            group: { id: 'global-limits', title: 'Global Limits' },
            label: 'Recent units to protect',
            type: 'number',
            default: 0,
            min: 0,
            max: 4096,
            step: 1
        },
        {
            key: 'maxUnits',
            group: { id: 'global-limits', title: 'Global Limits' },
            label: 'Maximum units per pass',
            type: 'number',
            default: 0,
            min: 0,
            max: 4096,
            step: 1,
            // The zero means the OPPOSITE of what it means in Context Compaction's `maxUnits` twin
            // (there `slice(0, 0)` withholds nothing), and getting it wrong silently empties a pass.
            description: 'Tool units one axis may withhold per pass; 0 is unbounded, not disabled.'
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
// first turn, so they are kept ONE LINE PER DESCRIPTOR in the order the runtime reads them
// (`readTrimmerSettings` below — the order the descriptor list had before the pane grouped it,
// and the order `context-trimmer.test.ts` pins as `TURN_READS`), and that file pins the
// descriptor list key-by-key.
const ENABLED_DEFAULT = true;
// The three toggle+horizon pairs the operator sees first (the 2026-11-13 clean-up). Each `_TURNS`
// constant is the horizon that protects the N newest tool turns / thoughts; 2 is the shipped
// answer for all six, so the newest two tool turns and the newest two thoughts are never touched.
const TRIM_INVALID_TOOLS_DEFAULT = true;
const INVALID_TOOL_TURNS_DEFAULT = 2;
const TRIM_THOUGHTS_DEFAULT = true;
const THOUGHT_TURNS_DEFAULT = 2;
// Truncation is the one axis that can drop a request the model still needs context for, so it
// ships OFF; the horizon only ever widens what it may truncate once the operator turns it on.
const TRUNCATE_TOOL_REQUESTS_DEFAULT = false;
const TRUNCATE_TURNS_DEFAULT = 2;
const DROP_SUPERSEDED_DEFAULT = true;
const SUPERSEDED_TURNS_DEFAULT = 2;
const DROP_DUPLICATE_CALLS_DEFAULT = false;
const DUPLICATE_TURNS_DEFAULT = 2;
// The documented default outcome set, spelled exactly as the descriptor spells it.
const INVALID_OUTCOMES_DEFAULT = 'failed,rejected';
// The shipped loosening: tool NAME, no argument comparison.
const SUPERSEDE_MATCH_DEFAULT = 'name';
// The three economy knobs the shipped pass argued against, so all three default to off.
const MIN_TOKENS_DEFAULT = 0;
const MIN_THOUGHT_CHARS_DEFAULT = 0;
const SAFETY_UNITS_DEFAULT = 0;
const MAX_UNITS_DEFAULT = 0;

// ---------------------------------------------------------------------------
// THE SETTINGS SURFACE, AS VALUES (not as strings a predicate has to re-parse)
// ---------------------------------------------------------------------------
// One read per switch per turn, in the one PINNED READ ORDER (`context-trimmer.test.ts`
// `TURN_READS`), normalised once, and the normalised result
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

export type TrimmerSupersedeMatch = 'name' | 'fingerprint';
const SUPERSEDE_MATCHES: readonly TrimmerSupersedeMatch[] = ['name', 'fingerprint'];

// The three WHOLE-UNIT tool rules, in ATTRIBUTION order: `admittedBy` is built in this order and
// `firedBy` is its first entry. Attribution order is deliberately NOT the settings declaration
// order — declaration order is what the Plugins pane renders, while this order is what a pass
// report names — because a pass at the declared defaults IS the shipped rule and its report line
// has always been byte-identical to it (the overlap evidence in
// `../plugin/context-compaction.test.ts` and the H6 claim both read `firedBy`).
//
// `truncateToolRequests` is NOT in this union: it never withholds a unit, so `firedBy` ("which
// switch withheld this UNIT") has nothing to answer for it, and it reports on its own axis
// (`TruncateCandidate.firedBy`).
export type TrimmerToolRule = 'dropSupersededToolCalls' | 'trimInvalidTools' | 'dropDuplicateCalls';

// Every policy value one turn runs with. Plain data on purpose: the plan stays a pure function
// of (entries, settings), which is what keeps it re-runnable, restart-stable and testable.
//
// THE HORIZONS. `invalidToolTurns`, `supersededTurns`, `duplicateTurns` and `truncateTurns` count
// TOOL TURNS (a `ContextUnit` from `groupUnits` whose leader carries `toolCalls`); `thoughtTurns`
// counts THOUGHT ENTRIES (an assistant entry carrying a non-empty `reasoning`) — never transcript
// units and never the per-run `iteration`. In every case N protects the N newest and anything
// older is eligible; 0 protects nothing. Each one is a plain number here, normalised once by
// `horizonOf` at the gate.
export type TrimmerSettings = {
    dropSupersededToolCalls: boolean;
    supersededTurns: number;
    trimInvalidTools: boolean;
    invalidToolTurns: number;
    // The outcome set the invalid-tools rule acts on this turn: the documented closed set as
    // submitted, filtered through `INVALID_OUTCOME_NAMES` (unknown names, `completed` included,
    // are dropped). Empty == the rule is off, whatever the operator asked for.
    invalidOutcomes: readonly TrimmerInvalidOutcome[];
    invalidOutcomesSubmitted: string;
    // True when the submitted string named at least one name outside the closed set (an
    // empty submission is NOT a fallback — "an empty set disables the rule" is documented
    // behaviour, not a substitution).
    invalidOutcomesFallback: boolean;
    // The thinking axis: the toggle plus the thought-count horizon that replaced the old
    // off|turn|all tier and its `thoughtKeepUnits` rescue.
    trimThoughts: boolean;
    thoughtTurns: number;
    // The truncate axis: withholds one assistant REQUEST entry and leaves its tool results in the
    // request. Off by default, and gated by its own tool-turn horizon.
    truncateToolRequests: boolean;
    truncateTurns: number;
    supersedeMatch: TrimmerSupersedeMatch;
    supersedeMatchSubmitted: string;
    supersedeMatchFallback: boolean;
    dropDuplicateCalls: boolean;
    duplicateTurns: number;
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
    supersededTurns: SUPERSEDED_TURNS_DEFAULT,
    trimInvalidTools: TRIM_INVALID_TOOLS_DEFAULT,
    invalidToolTurns: INVALID_TOOL_TURNS_DEFAULT,
    // Built from the DOCUMENTED default string through the one parser, so the default set and the
    // descriptor's `default:` cannot drift apart by hand.
    invalidOutcomes: outcomeSetOf(INVALID_OUTCOMES_DEFAULT).names,
    invalidOutcomesSubmitted: INVALID_OUTCOMES_DEFAULT,
    invalidOutcomesFallback: false,
    trimThoughts: TRIM_THOUGHTS_DEFAULT,
    thoughtTurns: THOUGHT_TURNS_DEFAULT,
    truncateToolRequests: TRUNCATE_TOOL_REQUESTS_DEFAULT,
    truncateTurns: TRUNCATE_TURNS_DEFAULT,
    supersedeMatch: SUPERSEDE_MATCH_DEFAULT as TrimmerSupersedeMatch,
    supersedeMatchSubmitted: SUPERSEDE_MATCH_DEFAULT,
    supersedeMatchFallback: false,
    dropDuplicateCalls: DROP_DUPLICATE_CALLS_DEFAULT,
    duplicateTurns: DUPLICATE_TURNS_DEFAULT,
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

// A horizon, normalised for the gate. The READ edge is coercion-only (../plugin/settings.ts), so a
// hand-edited document can carry a nonsense number and this file is the only place that decides
// what it means: not finite or negative behaves as 0, i.e. "protect nothing", the same reading
// `safetyUnits` and `maxUnits` already give a -1 or a NaN.
const horizonOf = (horizon: number): number => (Number.isFinite(horizon) ? Math.max(0, horizon) : 0);

// Is an item that sits `ago` positions behind the newest one old enough to act on? `ago` is 0 for
// the newest tool turn / thought, so `horizon: 2` protects `ago` 0 and 1 and admits `ago` 2 and
// above — the exact N / N+1 boundary the operator reads in the hint.
const olderThanHorizon = (ago: number, horizon: number): boolean => ago >= horizonOf(horizon);

// THE TOOL-TURN HORIZONS (R2/R3/R4). A "tool turn" is a `ContextUnit` from
// ../core/context-pruning.ts `groupUnits` whose LEADER is an assistant entry carrying `toolCalls`
// — the request itself, so an `unanswered` block counts as a turn (the operator asked about tool
// turns, not about completed ones) while a user message, a plain assistant message and an orphan
// tool result are not one. Returns one entry per unit: how many NEWER tool turns sit above it
// (newest tool turn = 0), and `+Infinity` for a unit that is not a tool turn, so a horizon test
// on a non-tool unit can never accidentally admit it. Built by `toolTurnAgoOf` below, next to
// `factsOf`, because it reads the same leader shape.

// THE ONE SETTINGS READ of a turn. `api.settings` is live by contract (../plugin/settings.ts),
// so this runs every turn and a `PATCH /v1/harness/plugins/context-trimmer` lands on the next
// one. Reads happen in the ONE PINNED READ ORDER (the order of the toggles and their horizons,
// unchanged since before the pane grouped the list) and all of them happen here: the read set of a
// turn is a pinned contract (`context-trimmer.test.ts` asserts it exactly), and it is only pinned
// because every caller is behind the guards (`guardPasses`), which is what keeps a disabled plugin,
// a branch round and an internal agent at the one `enabled` read (or none) they always cost.
//
// Numbers are NOT clamped here. `min`/`max` are the plugin's published bounds and the write
// edge refuses a value outside them (../server/plugins.ts, ../plugin/settings.ts
// `normalizeNumber`); the read edge is coercion-only by contract, so a hand-edited document
// keeps its value rather than being silently rewritten. Each horizon is read next to its own
// toggle. That pairing — not the descriptor list — is what this order tracks: the list is grouped
// for the operator now (`group`/`parentKey`), and neither field is read at runtime, so a grouping
// edit here would change the pinned read set for a display reason.
const readTrimmerSettings = (api: HarnessPluginApi): TrimmerSettings => {
    const trimInvalidTools = api.settings.boolean('trimInvalidTools', TRIM_INVALID_TOOLS_DEFAULT);
    const invalidToolTurns = api.settings.number('invalidToolTurns', INVALID_TOOL_TURNS_DEFAULT);
    const trimThoughts = api.settings.boolean('trimThoughts', TRIM_THOUGHTS_DEFAULT);
    const thoughtTurns = api.settings.number('thoughtTurns', THOUGHT_TURNS_DEFAULT);
    const truncateToolRequests = api.settings.boolean(
        'truncateToolRequests',
        TRUNCATE_TOOL_REQUESTS_DEFAULT
    );
    const truncateTurns = api.settings.number('truncateTurns', TRUNCATE_TURNS_DEFAULT);
    const dropSupersededToolCalls = api.settings.boolean('dropSupersededToolCalls', DROP_SUPERSEDED_DEFAULT);
    const supersededTurns = api.settings.number('supersededTurns', SUPERSEDED_TURNS_DEFAULT);
    const dropDuplicateCalls = api.settings.boolean('dropDuplicateCalls', DROP_DUPLICATE_CALLS_DEFAULT);
    const duplicateTurns = api.settings.number('duplicateTurns', DUPLICATE_TURNS_DEFAULT);
    const invalidOutcomesSubmitted = api.settings.string('invalidOutcomes', INVALID_OUTCOMES_DEFAULT);
    const supersedeMatchSubmitted = api.settings.string('supersedeMatch', SUPERSEDE_MATCH_DEFAULT);
    const minTokens = api.settings.number('minTokens', MIN_TOKENS_DEFAULT);
    const minThoughtChars = api.settings.number('minThoughtChars', MIN_THOUGHT_CHARS_DEFAULT);
    const safetyUnits = api.settings.number('safetyUnits', SAFETY_UNITS_DEFAULT);
    const maxUnits = api.settings.number('maxUnits', MAX_UNITS_DEFAULT);

    const outcomes = outcomeSetOf(invalidOutcomesSubmitted);
    const matcher = tierOf(supersedeMatchSubmitted, SUPERSEDE_MATCHES, SUPERSEDE_MATCH_DEFAULT as TrimmerSupersedeMatch);

    return {
        dropSupersededToolCalls,
        supersededTurns,
        trimInvalidTools,
        invalidToolTurns,
        invalidOutcomes: outcomes.names,
        invalidOutcomesSubmitted,
        invalidOutcomesFallback: outcomes.unknown,
        trimThoughts,
        thoughtTurns,
        truncateToolRequests,
        truncateTurns,
        supersedeMatch: matcher.tier,
        supersedeMatchSubmitted,
        supersedeMatchFallback: matcher.fallback,
        dropDuplicateCalls,
        duplicateTurns,
        minTokens,
        minThoughtChars,
        safetyUnits,
        maxUnits
    };
};

// Can any WHOLE-UNIT tool rule withhold anything this turn? Every rule off — or the invalid-tools
// rule on with an outcome set that resolved to nothing — and the answer is no, which is what lets
// `planTrimmedUnits` skip the unit mirror entirely: no plan, no write, no diagnostic, no park
// (D4's zero-cost case). The duplicate rule counts on its own: with both supersession booleans off
// it is still a tool policy, and it is the switch the H2 independence check runs alone.
const unitRuleEnabled = (settings: TrimmerSettings): boolean =>
    settings.dropSupersededToolCalls ||
    (settings.trimInvalidTools && settings.invalidOutcomes.length > 0) ||
    settings.dropDuplicateCalls;

// Can the TOOL side write anything this turn — a whole-unit trim or a truncation? Truncate counts
// on its own: with every whole-unit rule off it is still a tool write, and the pass-level fast path
// in `planOf` has to know that or a truncate-only turn would take the synchronous "nothing to do"
// return and never write.
const toolRuleEnabled = (settings: TrimmerSettings): boolean =>
    unitRuleEnabled(settings) || settings.truncateToolRequests;

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

// The tool-turn rank map, declared next to `callsOf` because that IS the test: a unit is a tool
// turn when its leader carries calls. See the horizon memo above `readTrimmerSettings`.
const toolTurnAgoOf = (units: readonly ContextUnit[]): number[] => {
    // Positions in `units` of every tool turn, oldest first (the walk order).
    const toolTurns: number[] = [];

    for (let index = 0; index < units.length; index += 1) {
        if (callsOf(units[index]).length > 0) toolTurns.push(index);
    }

    // Every unit gets an answer; a NON-tool unit gets `+Infinity`, which is `>=` every horizon, so
    // a horizon test on a standalone message can never be what admits it.
    const ago = units.map((): number => Number.POSITIVE_INFINITY);

    for (let position = 0; position < toolTurns.length; position += 1) {
        ago[toolTurns[position]] = toolTurns.length - 1 - position;
    }

    return ago;
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
//
// GENERIC so the gates below serve BOTH tool axes: they read nothing off a candidate except the
// canonical indices in `members`, and a truncate candidate's `members` is exactly the one entry
// that axis removes, so the floor measures the text that axis actually withholds.
type MatchedUnit<T extends { members: readonly number[] } = TrimCandidate> = {
    candidate: T;
    unitIndex: number;
};

// THE ECONOMY GATES (T5), applied to the tool candidate set in one fixed order — horizon, cap,
// floor — and never to a thinking write (the estimator does not count `reasoning`, so a shared
// floor would silently disable the thoughts switch above 0). At the declared zeros every gate is a
// pass-through, which is what makes the shipped request byte-identical.
//
// THEY RUN PER AXIS (whole-unit trim, then truncate), not over one merged set. The two axes remove
// different text and one operator-facing sentence covers both: a pass has to earn its own keep.
// Merging them would let a truncation that saves nothing ride along on a trim that does, which is
// exactly the cache churn the floor exists to prevent, and it would make `maxUnits` ambiguous
// about whether it caps units or writes.
//
// THE FIGURE IS THE WRITE SET'S, NOT THE UNIT'S. The floor reads `candidate.members`, and for the
// whole-unit axis that list is the unit's STILL-SENT members, so a unit whose request an earlier
// truncation already withheld is judged on its surviving results — a saving the request really does
// lose. Measuring the whole unit there would bill the request text twice, once on the turn it left
// and again on the turn that only finishes the job.
const applyEconomyGates = <T extends { members: readonly number[] }>(
    matched: readonly MatchedUnit<T>[],
    unitCount: number,
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings
): MatchedUnit<T>[] => {
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
    // The entry to disable, and its durable address when the runtime minted one. It is the unit's
    // IDENTITY for the report, and since the write set is per member it is no longer guaranteed to
    // be one of the entries this pass writes: a unit whose REQUEST an earlier truncation already
    // withheld names a leader that is already off (`members` then lists the surviving results).
    leaderIndex: number;
    leaderMessageId?: string;
    // THE WRITE SET: every canonical index THIS pass stops sending, in canonical order. Since R8 the
    // runtime flag is PER ENTRY (../harness.ts:622-633 — "a plugin that wants a whole exchange out
    // of the prompt writes every member itself"), so this list is not a description of a cascade:
    // the writer addresses every entry in it. It is the unit's members MINUS the ones already
    // withheld, so a fresh unit lists the LEADER FIRST and then every result answering one of its
    // calls, while a unit whose request an earlier pass truncated lists ONLY the surviving results
    // and never puts the request back. It is never empty — a unit with nothing left to write is not
    // a candidate at all (the idempotence skip). Naming the entries is also what lets the economy
    // gates and the report state the size of THIS pass's decision rather than of the whole unit.
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
    // DECLARED order, so a pass at the declared defaults is attributed to the shipped rule. A unit
    // an EARLIER truncation left half-withheld is attributed the same way — to the rule that
    // COMPLETED it — because the truncate axis wrote nothing this pass, so it cannot share the
    // credit for a write it did not make (and `policy.fired` will not name it).
    firedBy: TrimmerToolRule;
    // The SUPERSEDING UNIT — the EARLIEST unit that answered any one of the withheld calls, under
    // the matcher that produced this candidate (`supersedeMatch` for the supersession rules,
    // fingerprint for a duplicate re-run). A multi-call block can be answered by more than one
    // later unit; the oldest answer is what a reviewer wants to read first.
    resolverIndex: number;
    resolverMessageId?: string;
};

// THE WRITE SET of one unit: its members that are STILL being sent, in canonical order (so a fresh
// unit is leader-first, and a unit whose request an earlier truncation already withheld is its
// surviving results only). Mirrors ../core/context-pruning.ts's private `includedMembersOf`
// one-for-one — that helper is not exported, and both shipped passes have to derive the same list
// for the same reason: `setIncluded` addresses ONE entry (R8), and the flag state a pass inherits is
// whatever the other pass left behind.
//
// Empty means the unit is FULLY withheld, which is the idempotence guarantee: a second pass over an
// unchanged transcript writes nothing, notifies nothing and saves nothing. It is also the ONLY skip
// — skipping on `unit.included` instead (the conjunction over the whole unit) made a unit this
// plugin's OWN truncate axis had already halved invisible to every whole-unit rule, so the failed
// RESULT it left behind rode in the request forever.
const includedMembersOf = (unit: ContextUnit): readonly HarnessContextEntry[] =>
    unit.members.filter((member) => member.included !== false);

// THE POLICY. Pure: same entries plus same settings, same plan. Oldest-first, because that is
// the walk order and it is the cache-friendly one (the surviving prefix is the prefix the provider
// already cached). A unit is visited ONCE, so it can appear in the plan at most once however many
// switches admit it — the rules are OR-therefore-unioned, never stacked into separate writes.
//
// Per unit, in this order:
//   1. ITS WRITE SET must not be empty (idempotence, MEASURED PER MEMBER — `includedMembersOf`).
//      `unit.included` is the conjunction over the WHOLE unit and would also skip a unit that this
//      plugin's own truncate axis halved, leaving its results riding; such a unit is still being
//      sent, so it stays planable and the pass withholds only the entries still in the request. A
//      re-run over an unchanged transcript still writes NOTHING and therefore notifies nothing;
//   2. it must have work of its own and be FULLY answered. `standalone` (a message with no calls,
//      or an orphan result whose block is gone) owns no work, and `unanswered` has a call with no
//      committed result — an in-flight background call or a host block that was never answered —
//      which no rule here may touch (../core/context-pruning.ts rule 3);
//   3. ITS HORIZON AND A SWITCH must both allow it, BEFORE any later-unit search, so a unit no
//      switch wants costs one classification check and no scan of the rest of the transcript. Each
//      rule owns its own tool-turn horizon (R2/R4/R4'), and `toolTurnAgoOf` is computed once per
//      pass so the three rules count the SAME tool turns and can never disagree about what "2 tool
//      turns ago" means for one another:
//      - `dropSupersededToolCalls` + `supersededTurns` admits core's `kind === 'candidate'`;
//      - `trimInvalidTools` + `invalidToolTurns` admits a unit whose every committed result is
//        invalid under `invalidOutcomes` (`isInvalidUnder`, the header's outcome mapping);
//      - `dropDuplicateCalls` + `duplicateTurns` admits `candidate` and `answered` units only, i.e.
//        never a `mixed` or `unanswered` one, whatever the earlier unit's own outcome was;
//   4. the work must be ANSWERED. The two supersession rules share ONE search and use the matcher
//      `supersedeMatch` picks; the duplicate rule always re-runs it on the FINGERPRINT, because a
//      name-only match would let `read("a.ts")` be "answered" by `read("b.ts")` and withhold work
//      the model actually used. One unanswered call disqualifies the whole unit;
//   5. the surviving candidates then run the economy gates (tail horizon, cap, floor), which at the
//      declared zeros change nothing.
//
// `settings` is optional so a host (or a test) asking for the plain shipped rule gets it; the
// plugin itself always passes what it read this turn.
export const planTrimmedUnits = (
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS
): TrimCandidate[] => {
    // No whole-unit rule is on, so nothing can be withheld: skip the unit mirror entirely rather
    // than walking it to produce an empty plan. Truncate has its own mirror walk
    // (`planTruncatedRequests`) and is deliberately NOT part of this fast path.
    if (!unitRuleEnabled(settings)) return [];

    // The shipped unit mirror (../core/context-pruning.ts `groupUnits`): an assistant block
    // plus every result answering one of its calls, contiguous or spliced in later, so a
    // background result that landed out of order is still part of its unit.
    const units = groupUnits(entries);
    const facts = units.map(factsOf);
    // THE HORIZON MAP, once per pass: `ago[index]` is how many newer tool turns sit above that
    // unit, so a horizon of 2 protects the two newest tool turns and nothing else. It counts TOOL
    // TURNS, not transcript units — `safetyUnits` is the knob that counts units, and the two are
    // independent on purpose.
    const ago = toolTurnAgoOf(units);

    const matched: MatchedUnit[] = [];

    for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const own = facts[index];

        // (1) Idempotence, MEASURED PER MEMBER. The skip fires only when NOTHING of the unit is
        // left to write; `unit.included` (every member included) would also skip the half state
        // THIS plugin's own truncate axis creates — request off, results on — and the surviving
        // results would then ride in every later request forever, invisible to the invalid,
        // superseded and duplicate rules that exist to withhold them.
        const writeSet = includedMembersOf(unit);

        if (writeSet.length === 0) continue;
        // (2) No work of its own, or a call that is still outstanding: nothing here is superseded.
        if (unit.kind === 'standalone' || unit.kind === 'unanswered') continue;
        if (own.names.length === 0) continue;

        // (3) Which switches may look at this unit at all — horizon first, because it is one
        // integer comparison against a map already built, while every predicate after it is a scan.
        const shippedApplies =
            settings.dropSupersededToolCalls &&
            unit.kind === 'candidate' &&
            olderThanHorizon(ago[index], settings.supersededTurns);
        const invalidApplies =
            settings.trimInvalidTools &&
            olderThanHorizon(ago[index], settings.invalidToolTurns) &&
            settings.invalidOutcomes.length > 0 &&
            isInvalidUnder(own, settings.invalidOutcomes);
        const duplicateApplies =
            settings.dropDuplicateCalls &&
            olderThanHorizon(ago[index], settings.duplicateTurns) &&
            DUPLICATE_ELIGIBLE_CLASSES.indexOf(unit.kind) !== -1;

        if (!shippedApplies && !invalidApplies && !duplicateApplies) continue;

        // The unit's work, one entry per CALL: `answersWorkOf` needs the name for the shipped
        // matcher and the fingerprint for the exact one, and both come from the same call list.
        const work = own.names.map((name, callIndex) => ({ name, key: own.keys[callIndex] }));

        // (4) Evidence. One search per MATCHER, and only for the rules that asked for it.
        const superseder =
            shippedApplies || invalidApplies
                ? answersWorkOf(units, facts, index, settings.supersedeMatch, work)
                : undefined;
        // The duplicate rule never reads `supersedeMatch`: withholding work the model used on a
        // name-only match is the failure mode the switch text rules out.
        const rerun = duplicateApplies ? answersWorkOf(units, facts, index, 'fingerprint', work) : undefined;

        const admittedBy: TrimmerToolRule[] = [];
        let resolver: ContextUnit | undefined;

        if (superseder !== undefined) {
            if (shippedApplies) admittedBy.push('dropSupersededToolCalls');
            if (invalidApplies) admittedBy.push('trimInvalidTools');
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
                members: writeSet.map((member) => member.index),
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

// THE TRUNCATE CANDIDATE (the 2026-11-13 clean-up) — one assistant REQUEST entry whose tool results
// stay in the context. A third shape rather than a `TrimCandidate` with a flag, because the write
// means something different here: a trim says "this unit is gone", a truncation says "the request
// is gone and the ANSWER is the part worth keeping". A consumer must never have to guess which of
// the two a `false` flag was written for.
export type TruncateCandidate = {
    // The request entry to exclude, and its durable address when the runtime minted one.
    leaderIndex: number;
    leaderMessageId?: string;
    // THE ONLY canonical index this write stops sending. `members` is one entry deep on purpose:
    // the economy gates read `members` to measure the pass, so the figure they judge is the request
    // text that leaves and not the results that stay.
    members: readonly number[];
    // The results this write KEEPS sending, narrowed to the ones still being sent (see the policy
    // below). Named in the report because "did you just delete my tool output?" is the question this
    // switch raises, and the answer is a list of indexes, not a promise — so the list must contain
    // ONLY entries the model is actually receiving. A result an operator or an earlier whole-unit
    // pass already switched off is excluded from it, and the line then reads `results kept none`.
    results: readonly number[];
    // The tool names whose request left, so a reviewer can see which work lost its question.
    names: readonly string[];
    firedBy: 'truncateToolRequests';
};

// THE TRUNCATE POLICY (R3). Pure, like every other plan here: same entries plus same settings, same
// list. Per tool unit, oldest first:
//   1. the toggle — off (the shipped default) means no truncate write exists at all;
//   2. the unit's LEADER must still be included. Read off `leader.included`, not `unit.included`:
//      after a truncation the unit is HALF excluded (the request gone, the results in), and since R8
//      the flag moves exactly ONE entry, so the per-entry verdict is the only one that answers "has
//      this request already gone?" — the unit-level conjunction would say "handled" about a unit whose
//      results are still riding, and (see above) that is the state the whole-unit rules still have to
//      reach;
//   3. it must be a real tool unit WITH at least one committed result: `standalone` owns no request,
//      and `unanswered` has no answer to keep, so truncating it would drop the question and leave
//      nothing but a hole in the provider's pairing;
//   4. ITS HORIZON: older than `truncateTurns` tool turns, counted newest-first over tool units,
//      exactly like the trim horizons;
//   5. PRECEDENCE (R6): a unit this SAME pass is already withholding WHOLE leaves entirely, so a
//      truncation on it would be a second write for one decision and would report a truncation the
//      request never shows. Whole-unit trim wins, always, and the pass report names that order.
//
// Nothing here deletes: one `setIncluded(leader, false)` and the tool results stay in canonical
// history AND in the request.
export const planTruncatedRequests = (
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS,
    trimmedEntries?: ReadonlySet<number>
): TruncateCandidate[] => {
    if (!settings.truncateToolRequests) return [];

    const units = groupUnits(entries);
    const ago = toolTurnAgoOf(units);

    const matched: MatchedUnit<TruncateCandidate>[] = [];

    for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];

        // (2) The request itself is already not being sent.
        if (unit.leader.included === false) continue;
        // (3) Not a tool unit, or a tool unit with no committed answer to keep.
        if (unit.kind === 'standalone' || unit.kind === 'unanswered') continue;

        // THE PAIRING GUARD (rule 3) counts every COMMITTED result — role only, never the flag. A
        // unit with no committed result of its own has no answer to keep, and dropping its question
        // would leave a hole in the provider's pairing whatever the flags say.
        const results = unit.members
            .filter((member) => member.message.role === 'tool')
            .map((member) => member.index);

        if (results.length === 0) continue;
        // THE REPORT LIST (2026-11-13 review) is the NARROWER set: `results kept #…` and
        // `data.truncated[].results` both claim "these entries are STILL being sent", so a result an
        // operator (or an earlier whole-unit write) already switched off must not be named as one of
        // them — the operator would diff the list against the request and find the plugin lying. The
        // two lists are deliberately different: a unit whose results are ALL already withheld is
        // still a unit whose stale question can go (a pure saving, and the pairing guard above is
        // satisfied), but its line then says `results kept none` instead of naming a result the
        // model never sees.
        const kept = unit.members
            .filter((member) => member.message.role === 'tool' && member.included !== false)
            .map((member) => member.index);
        // (4) Inside its horizon: the request stays.
        if (!olderThanHorizon(ago[index], settings.truncateTurns)) continue;
        // (5) The whole-unit rules already took it.
        if (trimmedEntries?.has(unit.leader.index)) continue;

        const calls = callsOf(unit);

        matched.push({
            unitIndex: index,
            candidate: {
                leaderIndex: unit.leader.index,
                ...(unit.leader.messageId === undefined
                    ? {}
                    : { leaderMessageId: unit.leader.messageId }),
                members: [unit.leader.index],
                results: kept,
                names: calls.map((call) => call.name),
                firedBy: 'truncateToolRequests'
            }
        });
    }

    return applyEconomyGates(matched, units.length, entries, settings).map((entry) => entry.candidate);
};

// THE THINKING CANDIDATE (T6, re-shaped by the 2026-11-13 clean-up) — one assistant entry whose
// recorded thinking this pass wants withheld, and everything the report has to say about it. A
// separate shape from `TrimCandidate` on purpose: the two axes act on different fields, have
// different granularity (a unit vs exactly one entry) and different floors (tokens vs characters),
// and a plan that merged them would force every consumer to ask "which kind is this?" before it
// could write anything.
export type ThoughtCandidate = {
    // The entry to flag, and its durable address when the runtime minted one.
    entryIndex: number;
    entryMessageId?: string;
    // WHICH TURN the entry belongs to: `open` = after the last user entry, i.e. the turn the run is
    // still building; `closed` = a finished turn. NOT a rule any more (the tier is gone) — the
    // horizon decides eligibility — but the report line still names it, because "why did MY current
    // reasoning disappear" is the first question an operator asks of a thinking policy, and `turn`
    // plus `turnsAgo` is what answers it.
    turn: 'open' | 'closed';
    // How many newer THOUGHTS sit above this entry: 0 is the newest recorded thinking in the
    // transcript. This is the figure `thoughtTurns` was compared against, so the report can say
    // "this one was 3 thoughts old, the one above it was 1" without re-walking the transcript.
    turnsAgo: number;
    // Characters of thinking the flag removes from the request — the figure `minThoughtChars` is
    // measured against and the figure the report names. Never converted to tokens: the estimator
    // does not count reasoning, so the two numbers are not comparable.
    chars: number;
    // The thinking side has one switch, so `firedBy` is a constant — but D4 #1 asks every withheld
    // item to name its switch, and a report that names it only for tool units is a report a host
    // has to guess about.
    firedBy: 'trimThoughts';
    // The horizon in force when this entry was admitted, next to the number that was actually
    // compared, which is how a report stays readable when the operator hand-edited a nonsense
    // horizon and `horizonOf` had to decide what it meant.
    horizon: number;
};

// THE THOUGHT RANK MAP (R2). One entry per canonical entry: how many NEWER entries carrying
// non-empty `reasoning` sit above it, newest thought = 0, and `+Infinity` for anything that is not
// a thought. The count is over THOUGHT ENTRIES — an assistant entry carrying a non-empty
// `reasoning` string — and deliberately NOT over transcript units (one unit can carry zero, one or
// several thoughts, and a multi-call turn would move the horizon by more than the operator reads)
// and NEVER over `context.iteration`, which counts model steps inside one run and cannot express a
// conversation-level position.
//
// It is computed over every thought entry, INCLUDING ones already flagged and ones whose unit is
// withheld, and that is what makes the policy idempotent: writing a flag never renumbers anything,
// so a second pass over the same transcript reaches the same verdicts and skips exactly the entries
// it already flagged.
const thoughtAgoOf = (entries: readonly HarnessContextEntry[]): number[] => {
    const thoughts: number[] = [];

    for (let index = 0; index < entries.length; index += 1) {
        const message = entries[index].message;

        if (message.role === 'assistant' && typeof message.reasoning === 'string' && message.reasoning.length > 0) {
            thoughts.push(index);
        }
    }

    const ago = entries.map((): number => Number.POSITIVE_INFINITY);

    for (let position = 0; position < thoughts.length; position += 1) {
        ago[thoughts[position]] = thoughts.length - 1 - position;
    }

    return ago;
};

// THE THINKING POLICY. Pure: same entries plus same settings, same plan, and no in-process state —
// a restarted process re-derives the same list, and the entries already flagged simply drop out of
// it, which is what makes a second pass write NOTHING.
//
// Per canonical entry, in this order:
//   1. toggle gate — `trimThoughts` off means no thinking write exists at all, whatever else is
//      configured. It replaces the old off|turn|all tier outright: the tier's "which thinking"
//      question is what the horizon now answers, in one number the operator can read;
//   2. the entry must be an `assistant` entry that actually CARRIES thinking (a non-empty string).
//      An entry with no `reasoning` has nothing to withhold, and flagging it would be a write, a
//      notification and a save for zero effect — which is also what `thoughtTurns` counts;
//   3. it must not ALREADY be flagged (idempotence — the exact trick the tool side uses with
//      `unit.included`), and it must not be an entry the model never sees anyway (`entry.included`
//      is the live flag: thinking on a withheld entry cannot be "removed from the request" because
//      the entry is not in it, so the flag would cost a write and change nothing; if a host
//      re-enables that entry later, the NEXT pass flags it);
//   4. THE HORIZON: older than `thoughtTurns` thoughts, counted newest-first over the thought
//      entries above. At the shipped 2 the open turn's thinking is safe (it is the newest thought,
//      `ago` 0) — the tier's useful half, kept — and `0` reaches the open turn too;
//   5. `minThoughtChars` measures the characters the write WOULD remove and below it the thinking
//      side contributes NO writes. The tool side is untouched by this floor, exactly as the tool
//      side's `minTokens` never touches these candidates.
//
// THE THIRD ARGUMENT — the entries this SAME pass is about to withhold ENTIRELY (the write set of
// each tool candidate — every member of the unit still being sent — plus the single request entry
// truncation takes). Their thinking is
// skipped, for two reasons that are both about honesty rather than size: an entry that leaves the
// request leaves with its thinking, so a flag there would buy nothing, and counting its characters
// toward `minThoughtChars` would claim a saving the pass does not actually get. The set is passed IN
// rather than computed here so this function stays a pure policy over entries + settings —
// `trimThoughts` and the tool switches are independent switches (H2), and the independence is only
// provable while one does not read the other's state.
export const planWithheldThoughts = (
    entries: readonly HarnessContextEntry[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS,
    withheldEntries?: ReadonlySet<number>
): ThoughtCandidate[] => {
    // (1) The toggle, before anything is read off the transcript.
    if (!settings.trimThoughts) return [];

    // THE RANK MAP, and the turn boundary the report still names.
    const ago = thoughtAgoOf(entries);

    // THE BOUNDARY. The last user entry, in canonical order; everything after it is the open turn.
    // -1 when the transcript has no user entry at all, which makes every assistant entry part of
    // the open turn. `iteration` cannot express this (it counts model steps inside ONE run), while
    // the last-user-entry rule does it exactly, and a mailbox/autoanswer user message legitimately
    // MOVES the boundary because it really does open a new turn — which is why it is re-read from
    // canonical order every turn and never remembered.
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
        // measured against. Checked before the horizon and the floor, because it is a candidacy
        // rule, not a preference.
        if (withheldEntries?.has(entry.index)) continue;

        const turn: 'open' | 'closed' = entry.index > lastUserIndex ? 'open' : 'closed';
        const turnsAgo = ago[entry.index];

        // (4) The horizon.
        if (!olderThanHorizon(turnsAgo, settings.thoughtTurns)) continue;

        selected.push({
            entryIndex: entry.index,
            ...(entry.messageId === undefined ? {} : { entryMessageId: entry.messageId }),
            turn,
            turnsAgo,
            chars: message.reasoning.length,
            firedBy: 'trimThoughts',
            horizon: horizonOf(settings.thoughtTurns)
        });
    }

    // (5) THE FLOOR, in characters, over what would actually be written. `0` short-circuits it (the
    // shipped posture: no arithmetic on the default path). There is no rescue step any more: the
    // horizon IS the recent-N protection `thoughtKeepUnits` used to bolt on afterwards.
    const floor = Number.isFinite(settings.minThoughtChars)
        ? Math.max(0, settings.minThoughtChars)
        : 0;

    if (floor === 0 || selected.length === 0) return selected;

    let chars = 0;

    for (const candidate of selected) chars += candidate.chars;

    // Below the floor the thinking side writes NOTHING — not a partial set: half a batch of thinking
    // is the same cache churn the floor exists to avoid. The tool side is measured by `minTokens`
    // and is not affected by this decision, which is the estimator-blindness rule in force.
    return chars < floor ? [] : selected;
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

// One turn's decision: the policy it ran with, the units the whole-unit tool rules want withheld,
// the requests truncation wants dropped, and the entries the thinking rule wants flagged. Three
// lists rather than one because the three axes write different things — a whole unit through
// `setIncluded`, ONE request entry through `setIncluded`, one entry's thinking through
// `setReasoningIncluded` — and a merged list would force the writer to guess which field a line
// meant.
//
// `settings` travels WITH the plan because the report has to name the configuration that
// actually produced these withholdings, and a second settings read inside the writer would be
// a second answer to the same question (a value changing mid-turn is exactly the race the
// per-turn read exists to avoid).
export type TrimmerPass = {
    settings: TrimmerSettings;
    candidates: readonly TrimCandidate[];
    truncated: readonly TruncateCandidate[];
    thoughts: readonly ThoughtCandidate[];
};

// THE PRECEDENCE, stated once and reported (R6). The three axes are planned in exactly this order
// and each later axis is told what the earlier one already took, so a transcript position gets at
// most one decision per pass:
//   1. whole-unit trim  — the unit leaves entirely, results included;
//   2. truncate request — only a unit that survived step 1 has its request entry dropped, and its
//      results stay;
//   3. withhold thinking — an entry that leaves the request by step 1 or 2 gets no thinking flag,
//      because a flag on an entry that is not in the request buys nothing and would inflate the
//      `minThoughtChars` figure.
// Nothing here "fights": a unit is never both trimmed and truncated, and the report names this
// string so a reader never has to re-derive it from the code.
const PASS_PRECEDENCE = 'whole-unit trim > truncate request > withhold thinking';

// The plan, or an empty one when a guard refused the turn. The ONLY place that touches
// `context.entries`, which is what lets a disabled plugin cost one settings read and no
// transcript walk at all.
const planOf = (api: HarnessPluginApi, context: HarnessTurnBeforeContext): TrimmerPass => {
    // A refused turn reads no policy switch at all, so it reports the shipped defaults (and in
    // practice reports nothing: an empty plan never reaches the writer).
    if (!guardPasses(api, context)) {
        return { settings: TRIMMER_DEFAULT_SETTINGS, candidates: [], truncated: [], thoughts: [] };
    }

    const settings = readTrimmerSettings(api);

    // THE FAST PATH: with no tool axis and no thinking axis on, no write of any kind is possible, so
    // the pass costs no transcript walk and no candidate object — the same reasoning that kept the
    // disabled-plugin turn cheap before any of this existed, now applied to the switches rather than
    // to `enabled` alone.
    if (!toolRuleEnabled(settings) && !settings.trimThoughts) {
        return { settings, candidates: [], truncated: [], thoughts: [] };
    }

    // Step 1, the whole-unit tool side. `planTrimmedUnits` gates itself on its own three switches,
    // so a turn with none of them on pays no mirror walk; the truncate axis has its own gate and its
    // own walk for the same reason.
    const candidates = planTrimmedUnits(context.entries, settings);

    // The entries the TOOL side is about to remove: every member of a withheld unit (the whole-unit
    // writer addresses every one of them, R8), plus the single request entry each truncation takes.
    // Computed from the plan, never from a second settings read, and passed as an argument rather
    // than read inside the policy — that is what keeps `trimThoughts` provably independent of the
    // tool switches.
    const removedEntries = new Set<number>();

    for (const candidate of candidates) {
        for (const member of candidate.members) removedEntries.add(member);
    }

    // Step 2, planned against the SAME entries snapshot and told what step 1 took.
    const truncated = planTruncatedRequests(context.entries, settings, removedEntries);

    for (const candidate of truncated) {
        for (const member of candidate.members) removedEntries.add(member);
    }

    return {
        settings,
        candidates,
        truncated,
        // Step 3, planned from the SAME entries snapshot — so the axes of one pass cannot describe
        // two different transcripts.
        thoughts: planWithheldThoughts(context.entries, settings, removedEntries)
    };
};

// The pass report's structured view of the POLICY, as opposed to the units. One object per
// pass, always present, so a host can diff "what the trimmer did" across turns without parsing
// prose: every switch as it was resolved, EVERY HORIZON beside the rule it windows (R7 — "which
// rule admitted this unit" is only answerable when the report also carries "how old did that rule
// require it to be"), every `string` tier alongside the value that was submitted (an operator who
// typed `"sometimes"` and got `name` must be able to see BOTH), the precedence the axes ran in, and
// `fired` — the switches that can account for THESE writes, which is the part a one-line message
// cannot state honestly when two switches are on at once.
const policyReportOf = (
    settings: TrimmerSettings,
    candidates: readonly TrimCandidate[],
    thoughts: readonly ThoughtCandidate[] = [],
    truncated: readonly TruncateCandidate[] = []
) => {
    // A switch "fired" when it is on AND every withheld unit is one it is admitted to withhold.
    // Reading `admittedBy` rather than re-deriving the predicate here is what keeps the report and
    // the plan from being two answers to one question: the plan already decided, per unit, which
    // switches could have produced it. (A unit admitted by NO switch is impossible — the plan is
    // what produced these — so the three flags together always name the whole decision, in the
    // ATTRIBUTION order documented on `TrimmerToolRule`. A switch that is on but admits only PART
    // of a mixed pass names neither: it is the units, not the switches, that a reviewer is
    // auditing.)
    //
    // A unit an EARLIER pass truncated and THIS pass finished counts as the trimming rule's, and
    // only as the trimming rule's: the plan is what produced `admittedBy`, and the truncate axis
    // fired nothing this pass because it wrote nothing (its `truncated.length > 0` test below is the
    // only thing that can name it). So a two-step exit is accounted for exactly once per pass —
    // `data.truncated` stays empty and `policy.fired` omits `truncateToolRequests` even though the
    // operator has that switch on, which is the honest reading of a pass that touched no request.
    //
    // `candidates.length > 0` is not redundant: `[].every(...)` is TRUE, so without it a
    // thinking-only pass would report all three tool switches as fired for units that do not exist.
    const accountsFor = (rule: TrimmerToolRule, switchOn: boolean): boolean =>
        candidates.length > 0 && switchOn && candidates.every((candidate) => candidate.admittedBy.indexOf(rule) !== -1);

    const fired: string[] = [];

    if (accountsFor('dropSupersededToolCalls', settings.dropSupersededToolCalls)) {
        fired.push('dropSupersededToolCalls');
    }

    if (accountsFor('trimInvalidTools', settings.trimInvalidTools)) fired.push('trimInvalidTools');

    if (accountsFor('dropDuplicateCalls', settings.dropDuplicateCalls)) fired.push('dropDuplicateCalls');

    // The two non-unit axes, named after the unit rules (attribution order, then these two in the
    // order they run). Each fires exactly when THIS pass wrote on its axis — not when the switch is
    // merely on, because a pass that wrote nothing on that axis has nothing to account for, and the
    // tool-side rule above is the precedent for "the writes decide".
    if (truncated.length > 0) fired.push('truncateToolRequests');

    if (thoughts.length > 0) fired.push('trimThoughts');

    return {
        dropSupersededToolCalls: settings.dropSupersededToolCalls,
        supersededTurns: settings.supersededTurns,
        trimInvalidTools: settings.trimInvalidTools,
        invalidToolTurns: settings.invalidToolTurns,
        // '/'-joined so the field is one comparable string; '' means "the invalid-tools rule is off".
        invalidOutcomes: settings.invalidOutcomes.join('/'),
        invalidOutcomesSubmitted: settings.invalidOutcomesSubmitted,
        invalidOutcomesFallback: settings.invalidOutcomesFallback,
        trimThoughts: settings.trimThoughts,
        thoughtTurns: settings.thoughtTurns,
        truncateToolRequests: settings.truncateToolRequests,
        truncateTurns: settings.truncateTurns,
        supersedeMatch: settings.supersedeMatch,
        supersedeMatchSubmitted: settings.supersedeMatchSubmitted,
        supersedeMatchFallback: settings.supersedeMatchFallback,
        dropDuplicateCalls: settings.dropDuplicateCalls,
        duplicateTurns: settings.duplicateTurns,
        minTokens: settings.minTokens,
        minThoughtChars: settings.minThoughtChars,
        safetyUnits: settings.safetyUnits,
        maxUnits: settings.maxUnits,
        // R6: the order the three axes were planned in, so a report line naming a truncation next
        // to a withheld unit is never ambiguous about which decision came first.
        precedence: PASS_PRECEDENCE,
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

// Does this candidate's line have to say the REQUEST entry was already gone before this pass? True
// when the write set does not contain the unit's own leader — i.e. a truncation (this plugin's
// `truncateToolRequests`, or a host switching one entry off) took the request on an EARLIER turn and
// the invalid / superseded / duplicate rule is only now finishing the unit. The leader index stays in
// the line because it is the unit's IDENTITY, so without this clause a reader diffing `#<index>`
// against `data.units[].members` is the only way to notice that no request entry was written — and
// the same number then looks like a truncation this pass did not do (double-counting the decision).
// Fresh units keep their line BYTE-IDENTICAL, which is what the H6 claim needs.
const requestAlreadyWithheldOnLine = (candidate: TrimCandidate): boolean =>
    candidate.members.indexOf(candidate.leaderIndex) === -1;

// The truncate line's `results kept …` tail. With a NON-EMPTY list the line is byte-identical to
// what this plugin has always written. `none` is a shape the report can only reach now that
// `planTruncatedRequests` narrows `results` to the entries still being sent: every result of that
// unit is already withheld (a host or an earlier whole-unit write switched one off), so naming an
// index the model is not receiving would be the line claiming a saving it did not make — and
// staying silent would leave `results kept` dangling with nothing after it.
const resultsKeptOnLine = (candidate: TruncateCandidate): string =>
    candidate.results.length === 0 ? 'none' : candidate.results.map((index) => `#${index}`).join(',');

// THE WRITE-TIME VALIDITY CHECK, shared by all three write loops (2026-11-13 review).
//
// An entry is addressed by INDEX, and an index is a SNAPSHOT of the transcript as `turn.before`
// saw it (`../types` `HarnessContextEntry.index`: a mid-round `replaceHistory()` invalidates every
// index captured before it). The handler also AWAITS `context.pause()` between the plan and this
// writer, so another handler can change the transcript in that window. Re-location by index then
// has three possible outcomes, and only the first one is a write:
//   1. the index still resolves to the entry the plan meant → write;
//   2. it resolves to NOTHING → skip (the case this plugin has always handled);
//   3. it resolves to a DIFFERENT message — a shifted transcript, or a flag somebody else already
//      wrote — and that one used to be written anyway. Two real costs, both silent:
//        - `setIncluded` / `setReasoningIncluded` write and report UNCONDITIONALLY
//          (`../harness.ts:8915-8933` and `:8971-8990`), so a `false` → `false` write still fires a
//          persistence notification and a whole-document save for a change that did not happen —
//          the exact thing the "a second pass writes nothing, notifies nothing, saves nothing"
//          promise in this file's header forbids; and
//        - `setReasoningIncluded` REFUSES a non-assistant entry with a THROW
//          (`../harness.ts:8971-8975`), so a thinking index that landed on a tool or user message
//          lost the whole pass report through the bus's fail-open path.
//
// `roles` is the CLOSED set of roles a candidate of that axis can name, so a shifted index that
// lands on something else is treated exactly like a missing entry — skipped, not written, and not
// thrown. Nothing here re-enables: `false` stays the only value this plugin stores.
const writableEntryOf = (
    entries: readonly HarnessContextEntry[],
    index: number,
    roles: readonly HarnessMessage['role'][]
): HarnessContextEntry | undefined => {
    const entry = entries.find((lookedUp) => lookedUp.index === index);

    if (entry === undefined) return undefined;
    // A candidate's shape decides the roles it can legitimately name, so this is a validity check
    // on the ADDRESS, not a policy: only an assistant entry owns `reasoning` or a request, and a
    // whole-unit member is its request plus the tool results answering it.
    if (roles.indexOf(entry.message.role) === -1) return undefined;
    // Already withheld: writing `false` again notifies and saves without changing anything.
    if (entry.included === false) return undefined;

    return entry;
};

// THE WRITER. Three axes, one pass, one pause window, ONE diagnostic:
//   - whole-unit tool side: EVERY member of the unit the plan named that is STILL being sent, one
//     `setIncluded(entry, false)` each. Since R8 the runtime flag moves exactly ONE canonical entry
//     (../harness.ts:622-633) and
//     ./context-compaction.plugin.ts:857-875 is the precedent for writing a unit as its members. A
//     pass that stopped at the leader would withhold the request and leave the failed ANSWER riding —
//     a saving the diagnostic claims and the request does not deliver. With both halves flagged the
//     projection has nothing left to emit for the unit: no half-answered `tool_calls[]`, no orphan
//     result (the pair-clean oracle in ../harness.inclusion.test.ts is what pins that);
//   - truncate side: ONE `setIncluded(leader, false)`, the REQUEST only, and that single-entry write
//     IS the feature — the results keep riding as ownerless entries (../harness.ts:627-632), so the
//     model still gets the answer it asked for. `data.truncated[].results` names the entries that
//     stay, so a reviewer never has to guess which reading of the flag a line was written under;
//   - thinking side: one `setReasoningIncluded(entry, false)` per candidate — no cascade, the entry
//     keeps travelling, and only its request copy loses `reasoning`.
//
// Withhold-only throughout (F invariant 2): `false` is the only value any of these axes stores, so
// every decision stays reversible from the UI and the snapshot, and a second pass over the same
// transcript writes nothing — no flag write means no `agent_message` notification, which means no
// whole-document save (T4.4).
//
// Each candidate's entry is re-located by INDEX rather than reused from the plan, exactly as
// compaction does: if a later handler in this same round replaced the transcript, an entry the plan
// named is simply absent and the write is skipped instead of addressing the wrong turn. All THREE
// loops now run that re-location through one shared check (`writableEntryOf`), because the
// 2026-11-13 review found the truncate and thinking loops re-checking nothing: a transcript that
// moved inside the awaited `pause()` used to produce a `false` → `false` write there — a
// notification and a whole-document save for a change that did not happen, plus a report section
// claiming a write this pass never made — and on the thinking side a shifted index could land on a
// non-assistant entry, where the runtime THROWS. The loops skip silently for those reasons, and the
// pass reports NOTHING when none of them wrote.
const applyTrimPlan = async (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext,
    candidates: readonly TrimCandidate[],
    settings: TrimmerSettings = TRIMMER_DEFAULT_SETTINGS,
    thoughts: readonly ThoughtCandidate[] = [],
    truncated: readonly TruncateCandidate[] = []
): Promise<void> => {
    // Nothing on any axis: no write, no notification, no save, no report.
    if (candidates.length === 0 && thoughts.length === 0 && truncated.length === 0) return;

    const entries = context.entries;
    const trimmed: TrimCandidate[] = [];

    for (const candidate of candidates) {
        // (a) THE WHOLE UNIT — `members` is this candidate's WRITE SET (its STILL-SENT members,
        // leader first on a fresh unit), not a description of a cascade that no longer exists. A
        // candidate whose every member has gone from the transcript is dropped from the report
        // rather than announced: the pass says what it wrote, and a mid-round `replaceHistory()`
        // can leave one member missing while the others still land (reported, because the unit
        // really did leave the request).
        let written = false;

        for (const memberIndex of candidate.members) {
            // THE SHARED RE-CHECK: the index must still resolve, to a role this axis can name
            // (a request entry or a tool result), and to an entry that is STILL being sent. The
            // plan already excludes withheld members, so reaching the skip here means the
            // transcript moved inside this round — and nothing in this build re-enables an entry,
            // so skipping can never leave a live entry in the request.
            const entry = writableEntryOf(entries, memberIndex, ['assistant', 'tool']);

            if (entry === undefined) continue;

            // `false` is the only stored spelling of "withheld", so re-enabling is exact and a
            // second pass changes nothing at all.
            context.setIncluded(entry, false);
            written = true;
        }

        if (written) trimmed.push(candidate);
    }

    const truncatedWrites: TruncateCandidate[] = [];

    for (const candidate of truncated) {
        // THE SAME RE-CHECK the whole-unit loop has always run, and it is not theoretical here: the
        // truncate horizon and the whole-unit horizons all default to 2, so a request an operator
        // switched off by hand, or a `replaceHistory()` inside the awaited `pause()`, leaves this
        // loop holding an entry that is already off. Writing it would fire a persistence
        // notification and a save for a change that did not happen AND push the candidate into the
        // `truncated` section, reporting a truncation this pass never wrote. A request entry is by
        // construction an assistant entry, so a role mismatch means the index moved.
        const entry = writableEntryOf(entries, candidate.leaderIndex, ['assistant']);

        if (entry === undefined) continue;

        // ONE entry: the request. Deliberately NOT `candidate.results` — those are exactly the
        // entries this switch keeps sending, and writing them would turn the truncate back into a
        // whole-unit trim, which is the confusion the separate candidate shape exists to prevent.
        context.setIncluded(entry, false);
        truncatedWrites.push(candidate);
    }

    const withheld: ThoughtCandidate[] = [];

    for (const candidate of thoughts) {
        // THE ROLE CHECK IS LOAD-BEARING HERE: `setReasoningIncluded` refuses a non-assistant entry
        // with a throw (../harness.ts:8971-8975), and a throw inside this loop loses the whole pass
        // report, not just this write. An entry that is not being sent needs no thinking flag
        // either — the projection already skips it — so both are skips, not errors.
        const entry = writableEntryOf(entries, candidate.entryIndex, ['assistant']);

        if (entry === undefined) continue;

        // THE SECOND LIVE FLAG on the same entry. `included` says the entry rides; the thinking
        // flag is an independent switch on it, and the plan read that switch off the same snapshot
        // the pause window invalidated. Somebody else flagging this entry in the window would
        // otherwise get a `false` → `false` write: one notification, one save, no change.
        const message = entry.message as Extract<HarnessMessage, { role: 'assistant' }>;

        if (message.reasoningIncluded === false) continue;

        // The flag — not the text — is what changes, so `reasoning` survives in canonical state and
        // an operator can switch it back on.
        context.setReasoningIncluded(entry, false);
        withheld.push(candidate);
    }

    if (trimmed.length === 0 && truncatedWrites.length === 0 && withheld.length === 0) return;

    // THE PASS REPORT — ONE diagnostic for the whole round, because a multi-unit pass is one
    // logical decision, and the three axes therefore share one report rather than producing three
    // competing messages. Self-contained text, so a host with no structured sink still learns what
    // left the context and what replaced it.
    //
    // Sections, in a FIXED order (the order the axes RAN — trim, truncate, thinking), joined by
    // ' | ' (the same separator the fallback clauses already use, so an operator reads one
    // machine-parseable line). Each section is present only when THAT axis wrote:
    //   1. the whole-unit tool section — BYTE-IDENTICAL to the message this plugin has always
    //      written, except where a line describes a shape the shipped rule could not produce (see
    //      `namesSwitchOnLine`) or completes a unit whose REQUEST an earlier truncation already
    //      took, which adds ` (request already withheld)` so the line is never read as a second
    //      truncation (see `requestAlreadyWithheldOnLine`);
    //   2. the truncate section — `#<index> <id> <names> results kept #<index>,…`;
    //   3. the thinking section — `#<index> <id> <open|closed> <chars> chars via
    //      trimThoughts=<horizon>` per entry. It names the turn because "why did the reasoning of MY
    //      current turn go" is the first question an operator asks, the age in thoughts because that
    //      is the number the horizon was compared against, and the characters rather than tokens
    //      because the estimator does not count reasoning, so a token figure here would be a number
    //      this pass cannot compute;
    //   4. the fallback clauses for submitted values that were not honoured (unchanged).
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
                        }${
                            requestAlreadyWithheldOnLine(candidate) ? ' (request already withheld)' : ''
                        }${namesSwitchOnLine(candidate) ? ` via ${candidate.firedBy}` : ''}`
                )
                .join('; ')}`
        );
    }

    if (truncatedWrites.length > 0) {
        sections.push(
            `context-trimmer truncated ${truncatedWrites.length} tool request(s): ${truncatedWrites
                .map(
                    (candidate) =>
                        `#${candidate.leaderIndex}${
                            candidate.leaderMessageId === undefined
                                ? ''
                                : ` ${candidate.leaderMessageId}`
                        } ${candidate.names.join('+')} results kept ${resultsKeptOnLine(candidate)}`
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
                        } ${candidate.turn} ${candidate.turnsAgo} thoughts old ${candidate.chars} chars via ${
                            candidate.firedBy
                        }=${candidate.horizon}`
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
                // THE WRITE-SET FLAG — did this pass write the REQUEST entry, or only the entries
                // that outlived it? `index` above names the unit and its leader, and for a unit an
                // earlier truncation already halved the leader is NOT one of `members`. Stating it
                // keeps the two axes from double-counting one decision: this line belongs to the
                // trimming rule that completed the unit, and `data.truncated` stays silent because
                // this pass wrote no truncation.
                requestAlreadyWithheld: candidate.members.indexOf(candidate.leaderIndex) === -1,
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
            // THE TRUNCATE RECORD — the counterpart of `units` for the axis that removes one entry
            // instead of a unit. `results` is the proof of the switch's promise: these entries are
            // STILL being sent, and a reader can diff the two lists instead of trusting the prose.
            truncated: truncatedWrites.map((candidate) => ({
                index: candidate.leaderIndex,
                ...(candidate.leaderMessageId === undefined
                    ? {}
                    : { messageId: candidate.leaderMessageId }),
                names: candidate.names,
                results: candidate.results,
                firedBy: candidate.firedBy
            })),
            // The thinking side's per-entry half, always present (empty when this pass touched no
            // thinking) so the record's SHAPE does not depend on which switches fired.
            thoughts: withheld.map((candidate) => ({
                index: candidate.entryIndex,
                ...(candidate.entryMessageId === undefined
                    ? {}
                    : { messageId: candidate.entryMessageId }),
                turn: candidate.turn,
                turnsAgo: candidate.turnsAgo,
                chars: candidate.chars,
                firedBy: candidate.firedBy,
                horizon: candidate.horizon
            })),
            policy: policyReportOf(settings, trimmed, withheld, truncatedWrites)
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

    await applyTrimPlan(api, context, pass.candidates, pass.settings, pass.thoughts, pass.truncated);
};

// The WRITER's shape (the third argument is the plan the guard already computed, so a turn never
// walks the transcript twice; the fourth is the policy that plan was computed under, and the fifth
// and sixth are the thinking and truncate sides of the same plan — all OPTIONAL so a host writer
// written before the axes existed, and any host that does not care about them, keeps the exact
// signature it already has). The host-facing two-argument entry point above is `executeTrimming`;
// this one is the seam a test or a host reuses to observe the exact park/trim/unpark sequence
// without re-implementing the guards.
export type HarnessTrimmingAction = (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext,
    candidates: readonly TrimCandidate[],
    settings?: TrimmerSettings,
    thoughts?: readonly ThoughtCandidate[],
    truncated?: readonly TruncateCandidate[]
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
        thoughts: readonly ThoughtCandidate[],
        truncated: readonly TruncateCandidate[]
    ): Promise<void> => {
        await context.pause();

        try {
            await action(api, context, candidates, settings, thoughts, truncated);
        } finally {
            await context.resume();
        }
    };

    // SYNC fast path, deliberately not an `async` function (see the header): the path that
    // runs on nearly every turn returns `undefined` and costs one microtask; only a real pass
    // returns a promise. The settings reads are all SYNCHRONOUS, so more switches did not move
    // this turn onto a promise — the plan is still a pure read and the answer is still
    // `undefined` by the time the handler returns. A thinking-only or truncate-only pass DOES
    // take the promise path, because it is a pass that writes.
    return (context) => {
        const { settings, candidates, truncated, thoughts } = planOf(api, context);

        if (candidates.length === 0 && truncated.length === 0 && thoughts.length === 0) {
            return undefined;
        }

        return pass(context, candidates, settings, thoughts, truncated);
    };
};

// Wiring only: the framework hands the scoped api, the guard owns the behaviour. The arrow
// form (not a reference) is what the manifest scanner's `setup` regex requires.
export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    api.on('turn.before', createContextTrimmerHandler(api));
};

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
// HOW IT DIFFERS FROM CONTEXT COMPACTION (the one real decision in this file)
// ---------------------------------------------------------------------------
// ../plugins/context-compaction.plugin.ts prunes only when the later unit reruns the SAME
// WORK: `toolCallFingerprint(name, canonicalArguments)` equality. This plugin matches on the
// tool NAME alone, deliberately looser, per the ratified rule: a failed call followed later
// by a successful call of the same tool is ~99% superseded work, whether or not the retry
// used the same arguments (the typical shape is `read("a.ts")` failing and `read("b.ts")`
// answering the question the agent actually had). The looseness is bounded by everything
// else being as strict as compaction's:
//   - the unit must be ALL-`failed`/`rejected` and fully answered (core/context-pruning.ts
//     `groupUnits` classification, so `kind === 'candidate'` — an unanswered block, a
//     `cancelled` result or a unit mixing healthy and failed answers is never touched);
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
// WHY THERE IS NO TOKEN FLOOR, NO HORIZON AND NO COOLDOWN
// -------------------------------------------------------
// Compaction is an expensive, rare, whole-conversation event, so it is guarded by a limit,
// a savings floor, a tail horizon and a per-thread cooldown. Trimming is none of those: it
// is one flag write per superseded unit, it is idempotent by construction (an already
// excluded unit is skipped, so a second pass writes NOTHING and therefore produces no
// persistence notification and no save), and a unit can only ever be trimmed once the answer
// exists somewhere above it. The failure mode the compaction guards protect against — an
// operator's 40-token prune invalidating a provider prompt cache on every turn — is paid for
// here with one comparison per unit pair, and the units it removes ARE the pure-noise ones.
// A tail horizon would also fight the feature's own purpose: a failure the model just
// replaced with a success is exactly the pair that is safe to drop from the NEXT request.
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
import { groupUnits, RESOLVING_OUTCOME } from '../core/context-pruning';
import { toolOutcomeOf } from '../core/tool-outcome';
// Reused, not restated: the internal-agent lists (a summarizer thread must never be trimmed,
// or the compactor's own helper loses the failures it was handed to explain).
import { isInternalAgent } from './context-compaction.plugin';
import type {
    HarnessContextEntry,
    HarnessLifecycleHandler,
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
        'At the start of each assistant turn, finds tool calls that failed or were rejected and were later replaced by a successful call to the same tool, and excludes those paired call+result units from the context. Nothing is deleted: a trimmed unit keeps its place in history and can be switched back on.',
    version: '1.0.0',
    tags: ['context', 'trimming', 'lifecycle'],
    builtin: true,
    hooks: ['turn.before'],
    settings: [
        {
            key: 'enabled',
            label: 'Trim superseded tool calls',
            type: 'boolean',
            default: true,
            description:
                'Runs the trimming pass on or off. Off changes nothing else: units an earlier turn already trimmed stay trimmed until they are switched back on from the context view, no other plugin is affected, and the transcript is never rewritten. It is the switch an operator expects when they want the behaviour gone without removing the built-in.'
        }
    ]
} satisfies HarnessPluginMetadata;

// Fallback when the host stores nothing for `enabled`. It has to equal
// `metadata.settings[0].default` (true): the metadata must stay a plain object literal for
// the manifest scanner, so the number is written twice and BOTH places move together. The
// fallback only matters for a host reusing the action without declaring the setting, because
// a declared default always outranks this argument (../plugin/settings.ts `resolve`).
const ENABLED_DEFAULT = true;

// The per-call facts the predicate needs about one unit. Derived here rather than imported
// because core/context-pruning.ts models units by WORK FINGERPRINTS (`keys`), while this
// plugin matches on tool NAMES — the deliberate loosening described in the header.
export type TrimmingUnitFacts = {
    // Every tool the unit's block asked for, in call order. A name repeated by two calls
    // appears twice; the predicate asks the same question for both, so the duplicate costs one
    // comparison and can never change the answer.
    names: readonly string[];
    // The names that have at least one `completed` answer committed in THIS unit. A call with
    // no committed result is absent, so an in-flight call can never be an answer.
    resolvedNames: ReadonlySet<string>;
};

// One assistant tool-call block's calls (id + name, canonical order). A standalone message —
// a user/assistant/system turn, or an orphan result whose block is gone — has none, which is
// what keeps it out of both roles of the rule.
const callsOf = (unit: ContextUnit): { id: string; name: string }[] =>
    unit.leader.message.role === 'assistant'
        ? (unit.leader.message.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name }))
        : [];

// The committed results of a unit as `toolCallId -> outcome`, read through the shipped rule
// (../core/tool-outcome.ts: an absent key means `completed`, so a pre-outcome transcript
// reads healthy and is never a candidate). A duplicate answer for one call id is not
// producible by the runtime (results are committed per call), and last-wins is the honest
// reading of a hand-written transcript: the newest write is what the transcript says now.
const outcomesByCallOf = (unit: ContextUnit): Map<string, HarnessToolOutcome> => {
    const outcomes = new Map<string, HarnessToolOutcome>();

    for (const member of unit.members) {
        if (member.message.role !== 'tool') continue;

        outcomes.set(member.message.toolCallId, toolOutcomeOf(member.message));
    }

    return outcomes;
};

// The unit's work set by NAME, with the names it actually answered.
const factsOf = (unit: ContextUnit): TrimmingUnitFacts => {
    const calls = callsOf(unit);
    const outcomes = outcomesByCallOf(unit);
    const resolvedNames = new Set<string>();

    for (const call of calls) {
        // Only a COMMITTED `completed` answer resolves anything: a missing result means the
        // call is unanswered (the unit is `unanswered` and cannot be a candidate anyway), and
        // a `failed`/`rejected`/`cancelled` answer is not evidence of success.
        if (outcomes.get(call.id) === RESOLVING_OUTCOME) resolvedNames.add(call.name);
    }

    return { names: calls.map((call) => call.name), resolvedNames };
};

// The FIRST later, still-included unit that answered `name` with a `completed` result, or
// `undefined` when nothing did. Extracted so the per-name search in `planTrimmedUnits` stays
// readable and its ordering rule ("the oldest answer is the one worth naming") is stated once.
const firstAnswerOf = (
    units: readonly ContextUnit[],
    facts: readonly TrimmingUnitFacts[],
    from: number,
    name: string
): ContextUnit | undefined => {
    for (let later = from; later < units.length; later += 1) {
        // A withheld resolver is not evidence: switching the failure off on the strength of an
        // answer the model cannot see would drop BOTH halves.
        if (!units[later].included) continue;
        if (!facts[later].resolvedNames.has(name)) continue;

        return units[later];
    }

    return undefined;
};

// One unit the trimmer wants withheld, with everything an operator needs to audit it.
export type TrimCandidate = {
    // The entry to disable, and its durable address when the runtime minted one.
    leaderIndex: number;
    leaderMessageId?: string;
    // Every canonical index that will stop being sent (the cascade covers them; naming them
    // is for the diagnostic, not for the write).
    members: readonly number[];
    // The outcomes that made this unit a candidate.
    outcomes: readonly HarnessToolOutcome[];
    // The tool names withheld, so a reviewer sees which work left the context.
    names: readonly string[];
    // The SUPERSEDING UNIT — the EARLIEST unit that answered any one of the withheld names.
    // A multi-name block can be answered by more than one later unit (the rule is per name,
    // see `planTrimmedUnits`); the oldest answer is what a reviewer wants to read first.
    resolverIndex: number;
    resolverMessageId?: string;
};

// THE POLICY. Pure: same entries, same plan. Oldest-first, because that is the walk order
// and it is the cache-friendly one (the surviving prefix is the prefix the provider already
// cached).
//
// The predicate, per candidate unit:
//   1. it must be INCLUDED (idempotence — an already-trimmed unit is invisible to a second
//      pass, so a re-run writes nothing and therefore notifies nothing);
//   2. it must be `kind === 'candidate'`: at least one call, EVERY call answered, and every
//      answer `failed` or `rejected` (the classification is ../core/context-pruning.ts's own,
//      so an unanswered block, a `cancelled` answer and a mixed block are all keeps here for
//      the same reasons they are keeps for compaction);
//   3. EVERY name that unit called must have a `completed` answer in SOME later included unit
//      — per NAME, in possibly different units, and with no argument comparison at all. That
//      is the whole loosening (see the header) and the whole all-or-nothing: one unanswered
//      name keeps the unit whole.
export const planTrimmedUnits = (entries: readonly HarnessContextEntry[]): TrimCandidate[] => {
    // The shipped unit mirror (../core/context-pruning.ts `groupUnits`): an assistant block
    // plus every result answering one of its calls, contiguous or spliced in later, so a
    // background result that landed out of order is still part of its unit.
    const units = groupUnits(entries);
    const facts = units.map(factsOf);

    const candidates: TrimCandidate[] = [];

    for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const names = facts[index].names;

        // (1) Idempotence — `unit.included` is the LIVE effective flag of the WHOLE unit.
        if (!unit.included) continue;
        // (2) Not a candidate (a `completed`, `cancelled`, mixed or unanswered block, or a
        // standalone message): nothing here is superseded work.
        if (unit.kind !== 'candidate') continue;
        // Defensive: `kind === 'candidate'` already implies at least one call, and an empty
        // name list would make `every` vacuously true and trim on no evidence at all.
        if (names.length === 0) continue;

        // (3) Per name: answer. The first name with NO answer disqualifies the
        // whole unit, which is why the walk below bails out instead of collecting anything.
        let resolver: ContextUnit | undefined;

        for (const name of names) {
            const answer = firstAnswerOf(units, facts, index + 1, name);

            if (answer === undefined) {
                resolver = undefined;
                break;
            }

            // The EARLIEST answering unit across all names — the search is index-ascending per
            // name, so keeping the smallest index seen is the same rule for every input.
            if (resolver === undefined || answer.leader.index < resolver.leader.index) {
                resolver = answer;
            }
        }

        if (resolver === undefined) continue;

        candidates.push({
            leaderIndex: unit.leader.index,
            ...(unit.leader.messageId === undefined
                ? {}
                : { leaderMessageId: unit.leader.messageId }),
            members: unit.members.map((member) => member.index),
            outcomes: unit.outcomes,
            names,
            resolverIndex: resolver.leader.index,
            ...(resolver.leader.messageId === undefined
                ? {}
                : { resolverMessageId: resolver.leader.messageId })
        });
    }

    return candidates;
};

// The guards, in one place, so the shipped handler and a host calling the action directly
// cannot drift: branch first (an ephemeral copy is never trimmed, whatever the knobs say, and
// a branch turn therefore reads NO setting at all), then `enabled` (read per turn, because
// `api.settings` is live by contract — ../plugin/settings.ts), then the recursion guard.
const guardPasses = (api: HarnessPluginApi, context: HarnessTurnBeforeContext): boolean => {
    if (context.branchId !== undefined) return false;
    if (!api.settings.boolean('enabled', ENABLED_DEFAULT)) return false;

    return !isInternalAgent(context.agent);
};

// The plan, or an empty list when a guard refused the turn. The ONLY place that touches
// `context.entries`, which is what lets a disabled plugin cost one settings read and no
// transcript walk at all.
const planOf = (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
): TrimCandidate[] => (guardPasses(api, context) ? planTrimmedUnits(context.entries) : []);

// THE WRITER. One `setIncluded(leader, false)` per candidate; the runtime's cascade excludes
// the paired tool results too (../types `HarnessTurnBeforeContext.setIncluded`), which is why
// this never has to think about provider pairing — the pair-clean projection oracle in
// src/harness.inclusion.test.ts is what pins that.
//
// The entry is re-located by INDEX rather than reused from the plan, exactly as compaction
// does: if a later handler in this same round replaced the transcript, an entry the plan
// named is simply absent and the write is skipped instead of addressing the wrong turn.
const applyTrimPlan = async (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext,
    candidates: readonly TrimCandidate[]
): Promise<void> => {
    if (candidates.length === 0) return;

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

    if (trimmed.length === 0) return;

    // The pass report: one line per trimmed unit inside ONE diagnostic, because a multi-unit
    // pass is one logical decision. Self-contained text, so a host with no structured sink
    // still learns what left the context and what replaced it.
    api.report.diagnostic({
        message:
            `context-trimmer withheld ${trimmed.length} superseded tool unit(s): ${trimmed
                .map(
                    (candidate) =>
                        `#${candidate.leaderIndex}${
                            candidate.leaderMessageId === undefined
                                ? ''
                                : ` ${candidate.leaderMessageId}`
                        } [${candidate.outcomes.join('/')}] ${candidate.names.join('+')} answered by ${
                            candidate.resolverMessageId ?? `index:${candidate.resolverIndex}`
                        }`
                )
                .join('; ')}`,
        data: {
            units: trimmed.map((candidate) => ({
                index: candidate.leaderIndex,
                ...(candidate.leaderMessageId === undefined
                    ? {}
                    : { messageId: candidate.leaderMessageId }),
                members: candidate.members,
                outcomes: candidate.outcomes,
                names: candidate.names,
                supersededBy: candidate.resolverMessageId ?? `index:${candidate.resolverIndex}`
            }))
        }
    });
};

// THE ACTION — guards, plan, write, report. Exported because a host may want the same trim on
// a trigger of its own; it is also what the shipped handler runs inside its pause window.
export const executeTrimming = async (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext
): Promise<void> => {
    await applyTrimPlan(api, context, planOf(api, context));
};

// The WRITER's shape (the third argument is the plan the guard already computed, so a turn
// never walks the transcript twice). The host-facing two-argument entry point above is
// `executeTrimming`; this one is the seam a test or a host reuses to observe the exact
// park/trim/unpark sequence without re-implementing the guards.
export type HarnessTrimmingAction = (
    api: HarnessPluginApi,
    context: HarnessTurnBeforeContext,
    candidates: readonly TrimCandidate[]
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
        candidates: readonly TrimCandidate[]
    ): Promise<void> => {
        await context.pause();

        try {
            await action(api, context, candidates);
        } finally {
            await context.resume();
        }
    };

    // SYNC fast path, deliberately not an `async` function (see the header): the path that
    // runs on nearly every turn returns `undefined` and costs one microtask; only a real trim
    // returns a promise.
    return (context) => {
        const candidates = planOf(api, context);

        if (candidates.length === 0) return undefined;

        return pass(context, candidates);
    };
};

// Wiring only: the framework hands the scoped api, the guard owns the behaviour. The arrow
// form (not a reference) is what the manifest scanner's `setup` regex requires.
export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    api.on('turn.before', createContextTrimmerHandler(api));
};

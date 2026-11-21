// Context pruning — the progressive-compaction T3 policy, as ONE pure function.
//
// WHAT THIS IS
// ------------
// `planContextPruning` answers a single question about a canonical transcript: **which
// already-committed tool units stop being sent to the model?** It is the whole policy of
// stage 3 ("prune what a later success already answered") with no I/O, no clock, no hook
// bus and no harness import, so it can be pinned by a table the way the fingerprint helper
// is (./argument-fingerprint.ts). The shipped plugin
// (../plugins/context-compaction.plugin.ts) owns the trigger, the settings and the WRITES;
// this module owns the decision. The split is deliberate: T3.5/Q1 asked for the candidate
// list to exist before anything is written, so an `annotate` mode later becomes a second
// WRITER over the same plan rather than a second policy.
//
// THE RULE (every clause exists for a cited failure mode; the evidence is F5 of
// ../docs/tasks/2026-11-09-progressive-compaction.md)
//   1. A unit is a candidate only when EVERY committed result of it is `failed` or
//      `rejected`. A unit that produced any `completed` answer is delivering something the
//      model asked for, and one that produced a `cancelled` answer is evidence the agent
//      CHOSE to stop (R5: a healthy control outcome is not garbage). `completed` is
//      therefore never a candidate and a `cancelled` unit is never resolved away.
//   2. A candidate is pruned only when a LATER unit answers the same work: the same tool
//      `name` with the same `toolCallFingerprint(name, arguments)`, every result of that
//      later unit `completed`, and that later unit still `included`. "Later" is by
//      transcript position, because that is the only ordering the model experiences.
//      Fingerprints, not result text, and never call ids — ids must be unique per call, so
//      a retry always arrives with a different one (F3).
//   3. A unit with NO committed result is never touched (T0 Q3). That covers an
//      in-flight background call (its result is not in `entries` yet) and a host-written
//      block that was never answered. It is also what makes T1.5's absent-means-`completed`
//      reading safe.
//   4. The last `safetyTurns` UNITS, counted FROM THE END of the transcript, are untouchable
//      (T4.2 — a per-run `iteration` counter cannot express "the last N turns of this
//      conversation"). A recent unanswered failure is the highest-signal thing in the
//      window; pruning it is how an agent repeats a call it just watched fail.
//   5. Idempotence (T4.3) is measured PER MEMBER, not at the unit: a unit is skipped only when
//      EVERY one of its entries is already withheld, so a second pass over an unchanged
//      transcript produces NO writes and therefore no persistence notification and no save.
//      The per-member half of the rule exists because the flag is per entry (R8) and the
//      context trimmer's truncate axis writes ONE entry — the assistant REQUEST — and none of
//      the results. A unit in that half state still has live content riding in the prompt, so
//      it stays planable and the pass withholds only the entries that are still being sent.
//      Testing idempotence at the unit (`unit.included`, the conjunction) made a
//      request-trimmed unit permanently invisible to compaction: its failed RESULT rode in the
//      request forever, because neither writer would name it again.
//   6. A pass takes the OLDEST eligible units first, at most `maxUnits` of them (T4.3: the
//      first pass over an old conversation must not silently empty it), and only if the
//      whole set withholds at least `minTokens` (T4.1: a 40-token prune is a cache
//      invalidation for nothing, Q5). Oldest-first is also the cache-friendly order
//      (Manus' append-only argument): the prefix that stays is the prefix the provider has
//      already cached.
//
// WHAT IS DELIBERATELY NOT DECIDED HERE
// -------------------------------------
// The tool-message outcome's storage rules (./tool-outcome.ts), the grouping's persistence
// semantics, and the flag WRITE itself. Since R8 the write addresses EXACTLY ONE canonical
// entry (../harness.ts `setIncluded`), so this module only names units and their MEMBERS: a
// caller that wants a whole exchange out of the context iterates the plan's
// `PruneCandidate.members` — the unit's STILL-SENT members (./context-pruning.ts
// `includedMembersOf`) — and writes each one. That is what keeps provider pairing honest for a
// pruner — it is the writer's job to name both sides, not the runtime's — and it is also what
// stops one writer from undoing another's write: a request the trimmer already withheld is not
// in this list, so compaction cannot put it back.
//
// ONE MIRROR, AND WHY IT IS THE ONLY ONE
// -------------------------------------
// `groupUnits` derives unit membership here (an assistant `toolCalls` block plus every tool
// message answering one of its calls, contiguous or spliced in later) because the runtime
// stopped grouping: `projectTranscript` skips one entry at a time now, and a plugin must not
// import the harness at runtime to ask it (a cycle through ../plugin/manifest.ts). Since the
// writer follows THIS list, a divergence changes what a pass withholds rather than what the
// projection emits — which is why the member list, not just the leader, is part of the plan.
// T3.4's oracle (the pair-clean projection check in src/harness.inclusion.test.ts /
// src/harness.background.test.ts `wireIssues`) is what keeps that mirror honest in
// behaviour, not in code.
//
// THE INTERRUPTED-REPAIR EDGE (flagged while landing T1)
// -----------------------------------------------------
// A tool result written by the server's interrupted-call repair
// (../server/persistence.ts, `INTERRUPTED_TOOL_RESULT_TEXT`) carries NO outcome, so it reads
// `completed` like any genuinely healthy result — there is no fifth outcome value to tell
// them apart, and inventing one was declined. Two consequences, both accepted:
//   - it is never a CANDIDATE (a candidate needs a failed/rejected result), so a repaired
//     call is never pruned on its own; and
//   - it MAY act as a resolver, i.e. the policy can treat a call that was cut off as
//     having answered an earlier identical failure. That is exactly the condition T3 states
//     ("only prune when the resolution rule genuinely matched"): the match is on name +
//     fingerprint + a committed answer, never on prose, and the diagnostic names the
//     resolver's id so an operator can see which unit was believed to have answered.
//
// Cross-references:
//   - ./argument-fingerprint.ts                       toolCallFingerprint — the work identity
//   - ./tool-outcome.ts                               toolOutcomeOf — absent means completed
//   - ./context-estimate.ts                           estimateContextTokens — the token floor
//   - ../types/index.ts                               HarnessContextEntry (the input shape)
//   - ../harness.ts                                   `setIncluded` (the write), `turn.before`
//   - ../plugins/context-compaction.plugin.ts         the caller: trigger, settings, writes
//   - ../docs/tasks/2026-11-09-progressive-compaction.md T3 (this rule), T4 (its guards)

import { toolCallFingerprint } from './argument-fingerprint';
import { estimateContextTokens } from './context-estimate';
import { toolOutcomeOf } from './tool-outcome';
import type { HarnessContextEntry, HarnessMessage, HarnessToolOutcome } from '../types';

// The outcome sets the contract fixes (../types `HarnessToolOutcome`): only a `completed`
// answer resolves anything, and only a real failure or refusal is ever a prune candidate.
export const RESOLVING_OUTCOME: HarnessToolOutcome = 'completed';
export const PRUNE_CANDIDATE_OUTCOMES: readonly HarnessToolOutcome[] = ['failed', 'rejected'];

// Every shape a unit can have, from the point of view of the rule. Kept as an OPEN set of
// classes (rather than a boolean) because the diagnostic has to say WHY a unit was kept, and
// because a future `annotate` writer needs the same vocabulary.
export type UnitClass =
    // Every committed result failed or was refused, and every call has an answer committed.
    | 'candidate'
    // Every committed result `completed` — a live answer. Never a candidate; the class a
    // resolver must be in.
    | 'answered'
    // A call of the block has no committed result yet: in flight, or never answered.
    // T0 Q3's "never touch a unit with no committed result".
    | 'unanswered'
    // A `cancelled` result, or a block mixing healthy and failed answers: conservative keep.
    | 'mixed'
    // A message that is not a tool-call block (a user/assistant/system turn), or a tool
    // result whose block is gone. It carries no recorded WORK to be superseded — an orphan
    // result has a `name` but its `arguments` lived on the missing call — so it is never a
    // candidate and never a resolver.
    | 'standalone';

// One unit: the messages that move together, with the identity the rule needs.
export type ContextUnit = {
    // The unit's LEADER: the assistant message that asked for the calls, or the standalone
    // message itself. It is the readable, stable one to NAME in a diagnostic. It is NOT the
    // only one to WRITE: `setIncluded` addresses exactly one entry (R8), so a pass that wants
    // the whole unit withheld writes every entry of `members` — the leader alone leaves the
    // paired results riding in the prompt.
    leader: HarnessContextEntry;
    // Every member, in canonical order, INCLUDING the leader. This is the WHOLE-UNIT write set
    // — the set a writer that means "this exchange is gone" has to address, because
    // `setIncluded` writes exactly one entry (R8). Which of these are STILL being sent is not
    // stored here: a plan reads it off the entries (see `includedMembersOf`), because the
    // trimmer's truncate axis withholds the leader alone and leaves the results riding.
    members: readonly HarnessContextEntry[];
    // The classification above.
    kind: UnitClass;
    // One fingerprint per CALL the unit made (a call with no committed result still counts
    // here — it is what makes `kind === 'unanswered'`).
    keys: readonly string[];
    // One outcome per committed RESULT, in result order.
    outcomes: readonly HarnessToolOutcome[];
    // The unit's effective inclusion (LIVE, from the entries the caller passed): true only
    // when EVERY member is included, so a unit with one withheld half reads as "not sent".
    // This is the UNIT-level verdict, and it answers exactly two questions: "is a resolver
    // whole enough to be believed?" (see `resolvesPrunedFailure`) and "is this unit still
    // being sent at all?". It is NOT the idempotence test for a prune plan any more — that one
    // is per member (`includedMembersOf`), because a request-trimmed unit is half withheld and
    // still has live content in the prompt. A caller that needs ONE entry's verdict reads
    // `entry.included` — this figure is about the unit, not about any member.
    included: boolean;
};

// THE WRITE SET of one unit: the members that are STILL being sent, in canonical order.
//
// This is what makes a prune plan able to act on a HALF-withheld unit. The flag is per entry
// (R8) and the context trimmer's truncate axis writes exactly one of them — the assistant
// REQUEST (`../plugins/context-trimmer.plugin.ts` `planTruncatedRequests`, whose `members` is
// deliberately one entry deep) — so the unit's failed tool RESULT goes on riding in every
// request. Under the previous unit-level skip such a unit read "already handled" and compaction
// never planned it again, which made the surviving result unprunable forever.
//
// Empty means the unit is FULLY withheld: a pass writes nothing there, which is the idempotence
// guarantee (T4.3) — a second pass over an already-pruned transcript still produces no writes,
// no persistence notification and no save.
//
// Edge case this also settles: the other half state (leader ON, a result OFF, e.g. a pass that
// stopped midway or a host that switched one answer off) is COMPLETED by the next pass rather
// than skipped. Compaction owns whole-unit pruning, so finishing the withholding is its call;
// it never does the reverse, i.e. it never re-enables an entry another writer silenced.
const includedMembersOf = (unit: ContextUnit): readonly HarnessContextEntry[] =>
    unit.members.filter((member) => member.included !== false);

// A unit the policy wants withheld, with everything an operator needs to audit it.
export type PruneCandidate = {
    // THE ENTRY TO NAME IN THE REPORT: the assistant message that asked for the calls. It is
    // the readable, stable identity of the unit, and since the write set is per member it is no
    // longer guaranteed to be one of the entries this pass actually withholds (a
    // request-trimmed unit names a leader that is already off).
    leaderIndex: number;
    leaderMessageId?: string;
    // THE WRITE SET: every canonical index this pass stops sending, in canonical order. It is
    // the unit's members MINUS the ones already withheld, so
    //   - a fresh unit lists the LEADER FIRST and then every result answering one of its calls
    //     (`setIncluded` writes one entry at a time (R8), so a writer that means the whole unit
    //     has to address every one of these; the leader alone withholds only the request), and
    //   - a unit whose request the trimmer already truncated lists ONLY the surviving results,
    //     and never re-enables the request the trimmer withheld.
    // It is never empty: a unit with no still-included member is not a candidate at all.
    members: readonly number[];
    // The outcomes that made this unit a candidate.
    outcomes: readonly HarnessToolOutcome[];
    // The fingerprints withheld, so a reviewer can see what work left the context.
    keys: readonly string[];
    // THE SUPERSEDING UNIT (T4.5: a diagnostic must name what answered).
    resolverIndex: number;
    resolverMessageId?: string;
    // Estimated tokens this unit withholds, measured with the package estimator OVER THE WRITE
    // SET ONLY (`PruneCandidate.members`). A member another writer already silenced contributes
    // nothing to the saving, so the figure never claims tokens the request does not lose.
    tokens: number;
};

export type PruneOptions = {
    // Units, counted from the END of the transcript, that no pass may touch (T4.2). A
    // non-finite or negative value behaves as 0.
    safetyUnits: number;
    // Hard bound on how many units ONE pass may disable (T4.3).
    maxUnits: number;
    // Minimum estimated tokens a pass must withhold to be worth doing (T4.1). Below it the
    // plan is EMPTY — nothing is written, so nothing is persisted.
    minTokens: number;
};

export type PrunePlan = {
    // Empty means "write nothing this turn".
    candidates: readonly PruneCandidate[];
    // Estimated tokens the whole plan withholds, measured by removing the UNION of every
    // candidate's WRITE SET at once (0 for an empty plan). Already-silenced members are not in
    // that union, so the figure is the saving the next request actually shows.
    withheldTokens: number;
    // Every unit the scan considered, for the diagnostic and for tests that assert what was
    // deliberately KEPT (an unanswered failure, a cancelled block, the tail horizon).
    consideredUnits: number;
    // Set when candidates existed but the whole set fell under `minTokens`.
    belowFloor: boolean;
};

// The identity of one call, exactly as the rule uses it.
const keyOf = (name: string, args: string): string => toolCallFingerprint(name, args);

const isToolEntry = (message: HarnessMessage): boolean => message.role === 'tool';

const callIdsOf = (message: HarnessMessage): string[] => {
    if (message.role !== 'assistant' || message.toolCalls === undefined) return [];

    return message.toolCalls.map((call) => call.id);
};

// The calls a unit made, paired with their fingerprints.
const callsOf = (leader: HarnessContextEntry): { id: string; key: string }[] => {
    const calls = leader.message.role === 'assistant' ? leader.message.toolCalls ?? [] : [];

    return calls.map((call) => ({ id: call.id, key: keyOf(call.name, call.arguments) }));
};

// Group the canonical transcript into units (see the header's mirror note).
//
// Two passes, because a late background result is spliced back at its ORIGINAL position
// while the block it answers may sit far above it: collect the answer ids per assistant
// block first, then walk the transcript once more to attach each result to the block that
// asked for it.
export const groupUnits = (entries: readonly HarnessContextEntry[]): ContextUnit[] => {
    // toolCallId -> the leader entry that asked for it.
    const owners = new Map<string, HarnessContextEntry>();

    for (const entry of entries) {
        for (const id of callIdsOf(entry.message)) {
            // First owner wins: a duplicate id is refused before anything executes
            // (../harness.ts `assertToolCallIds`), so a second claim can only be a
            // hand-written transcript, and the earliest block is the honest owner.
            if (!owners.has(id)) owners.set(id, entry);
        }
    }

    const leaders = new Map<HarnessContextEntry, HarnessContextEntry[]>();
    const standalone: HarnessContextEntry[] = [];

    for (const entry of entries) {
        const callIds = callIdsOf(entry.message);

        if (callIds.length > 0) {
            // An assistant block is its own leader, even when nothing answers it yet.
            if (!leaders.has(entry)) leaders.set(entry, []);
            continue;
        }

        if (isToolEntry(entry.message)) {
            const callId = (entry.message as { toolCallId?: unknown }).toolCallId;
            const owner = typeof callId === 'string' ? owners.get(callId) : undefined;

            if (owner !== undefined) {
                const members = leaders.get(owner);

                if (members !== undefined) members.push(entry);
                continue;
            }

            // An ORPHAN result (its block is gone, e.g. after a host `replaceHistory`) is a
            // standalone unit: the runtime's own grouping treats it the same way, and the
            // projection is what decides whether the provider sees it.
        }

        standalone.push(entry);
    }

    const units: ContextUnit[] = [];

    // Canonical order, so a caller may reason about "later" by position. Leaders first,
    // then the standalone messages, re-sorted by index at the end.
    for (const [leader, members] of leaders) {
        units.push(classifyUnit(leader, [leader, ...members]));
    }

    for (const entry of standalone) {
        units.push(classifyUnit(entry, [entry]));
    }

    return units.sort((left, right) => left.leader.index - right.leader.index);
};

// The shape `resolvesPrunedFailure` needs about one unit: enough to classify it and to
// compare work, nothing else. Structural on purpose, so the predicate is testable straight
// from the resolution matrix rows.
export type UnitFacts = {
    outcomes: readonly HarnessToolOutcome[];
    keys: readonly string[];
    // Whether the unit is currently sent to the model — the UNIT-level reading: true only when
    // EVERY member is. A resolver that is itself withheld must not be the evidence for pruning
    // anything else: the model would then see NEITHER failure nor answer.
    //
    // This gate is deliberately stricter than the candidate side's per-member test below: a
    // resolver whose REQUEST a trimmer truncated (`leader.included === false`, its results still
    // sent) is NOT believed, so it resolves nothing. That conservatism is the operator's rule
    // ("only prune when the resolution rule genuinely matched") and relaxing it would widen what
    // leaves the context, not just where the write lands — so an all-truncated transcript simply
    // prunes nothing, which is the safe direction.
    included: boolean;
};

// True when `later` answers the failed work `earlier` attempted.
//
// Every clause is a decision, not an implementation detail:
//   - `earlier` must be an all-failed/refused unit (`answered`/`mixed`/`unanswered` are
//     never pruned away by someone else's success);
//   - `later` must be an all-`completed`, still-included unit;
//   - EVERY key of `earlier` must appear in `later`, so a block that asked for two things is
//     only resolved when the retry did both. Requiring ALL rather than ANY is the
//     conservative half of Q4's unit-level choice.
// Keys compared with `toolCallFingerprint`, so a reordered-JSON retry matches and a
// different `offset` does not (T2.4: exact match, no prefix heuristic).
export const resolvesPrunedFailure = (earlier: UnitFacts, later: UnitFacts): boolean => {
    if (!isCandidateFacts(earlier)) return false;
    if (!later.included) return false;
    if (later.outcomes.length === 0) return false;
    if (!later.outcomes.every((outcome) => outcome === RESOLVING_OUTCOME)) return false;

    const answered = new Set(later.keys);

    return earlier.keys.length > 0 && earlier.keys.every((key) => answered.has(key));
};

// The candidate half of the predicate, exposed because the plan and the tests both need it.
export const isCandidateFacts = (facts: UnitFacts): boolean =>
    facts.outcomes.length > 0 &&
    facts.outcomes.every((outcome) => PRUNE_CANDIDATE_OUTCOMES.indexOf(outcome) !== -1);

// Classify one unit from its leader and members.
const classifyUnit = (
    leader: HarnessContextEntry,
    members: readonly HarnessContextEntry[]
): ContextUnit => {
    const calls = callsOf(leader);
    const results = members
        .filter((member) => isToolEntry(member.message))
        .map((member) => member.message as Extract<HarnessMessage, { role: 'tool' }>);

    const outcomes = results.map((result) => toolOutcomeOf(result));

    // `kind` — the order of these checks IS the rule.
    let kind: UnitClass;

    if (calls.length === 0) {
        // A standalone message (or an orphan result whose block is gone): no work of its own
        // to be superseded, so neither a candidate nor a resolver.
        kind = 'standalone';
    } else if (results.length < calls.length) {
        // At least one call of the block has no committed result yet: in flight, or never
        // answered. T0 Q3: never touch it.
        kind = 'unanswered';
    } else if (isCandidateFacts({ outcomes, keys: calls.map((call) => call.key), included: true })) {
        kind = 'candidate';
    } else if (outcomes.every((outcome) => outcome === RESOLVING_OUTCOME)) {
        kind = 'answered';
    } else {
        // Anything else: a `cancelled` result, or a mix of healthy and failed answers.
        kind = 'mixed';
    }

    return {
        leader,
        members,
        kind,
        // The WORK set: one key per call. An unanswered unit still has keys (a resolver needs
        // its calls' keys to match against), which is why keys and outcomes are separate.
        keys: calls.map((call) => call.key),
        outcomes,
        // EVERY member decides (R8): the flag is per entry now, so the unit counts as sent
        // only while all of its entries are. A leader that is on and a result that is off is a
        // half-withheld unit — this figure says "not fully sent", and the plan decides what to
        // do about that per member (`includedMembersOf`), not by skipping the unit.
        included: members.every((member) => member.included)
    };
};

// Estimated tokens the given canonical indices withhold, measured by REMOVING them from the
// transcript and re-running the SAME estimator (T4.1: the delta is the number the floor
// needs, and instructions are constant on both sides so they cancel out).
const withheldTokensOf = (
    messages: readonly HarnessMessage[],
    indices: ReadonlySet<number>
): number => {
    const kept: HarnessMessage[] = [];

    for (let index = 0; index < messages.length; index += 1) {
        if (indices.has(index)) continue;
        kept.push(messages[index]);
    }

    return Math.max(
        0,
        estimateContextTokens(messages) - estimateContextTokens(kept)
    );
};

// THE POLICY. Pure: same entries, same options, same plan.
export const planContextPruning = (
    entries: readonly HarnessContextEntry[],
    options: PruneOptions
): PrunePlan => {
    const units = groupUnits(entries);

    // T4.2 — the tail horizon, in UNITS, counted from the END. `firstProtected` is the
    // index of the first unit no pass may touch: 6 units with a horizon of 2 protects units
    // 4 and 5, and a horizon of 0 protects NOTHING (the comparison is `>=`, so `safety = 0`
    // puts the boundary past the last unit rather than in front of all of them).
    const safety = Number.isFinite(options.safetyUnits) ? Math.max(0, options.safetyUnits) : 0;
    const firstProtected = Math.max(0, units.length - safety);

    const messages = entries.map((entry) => entry.message);
    const consideredUnits = units.length;

    // One eligible unit and the entries this pass would stop sending for it. `writeSet` rides
    // along on the match so the floor, the per-unit figures and the write set below are all the
    // SAME list — one definition of "what this pass withholds", measured once.
    type Matched = { unit: ContextUnit; resolver: ContextUnit; writeSet: readonly HarnessContextEntry[] };

    const matches: Matched[] = [];

    for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];

        // T4.2 — inside the tail horizon: untouchable, but still eligible to ANSWER an older
        // failure (the most recent success is the best evidence an old failure is stale).
        if (index >= firstProtected) continue;
        // Rule 5 — idempotence, MEASURED PER MEMBER. A unit is skipped only once EVERY entry of
        // it is withheld. A half-withheld one (the trimmer's truncate axis took the REQUEST and
        // left the results, R8 makes the flag per entry) still has live content in the prompt,
        // so it stays planable and the write set names only what is still being sent.
        const writeSet = includedMembersOf(unit);

        if (writeSet.length === 0) continue;
        // Rules 1/3 — only an all-failed, fully answered block is a candidate.
        if (unit.kind !== 'candidate') continue;

        for (let later = index + 1; later < units.length; later += 1) {
            const resolver = units[later];

            if (!resolvesPrunedFailure(unit, resolver)) continue;

            matches.push({ unit, resolver, writeSet });
            break;
        }
    }

    // T4.3's bound, applied to the OLDEST eligible matches first (the loop above is already
    // in ascending position order).
    const maxUnits = Number.isFinite(options.maxUnits) ? Math.max(0, options.maxUnits) : 0;
    const selected = matches.slice(0, maxUnits);

    // THE TOKEN ACCOUNT IS THE WRITE SET'S, NOT THE UNIT'S (2026-11-13 review). An
    // already-withheld member is not in this set, so it contributes nothing to the saving: a
    // unit whose request the trimmer silenced is worth its surviving results and the floor judges
    // THAT, rather than a figure for text that left the prompt on an earlier turn. (The number
    // used to be exact only because a pass always wrote every member.)
    const memberIndices = new Set<number>();
    const candidates: PruneCandidate[] = [];

    for (const match of selected) {
        for (const member of match.writeSet) memberIndices.add(member.index);
    }

    const withheldTokens = selected.length === 0 ? 0 : withheldTokensOf(messages, memberIndices);

    const minTokens = Number.isFinite(options.minTokens) ? Math.max(0, options.minTokens) : 0;

    for (const match of selected) {
        const unitIndices = new Set<number>(match.writeSet.map((member) => member.index));

        candidates.push({
            // The unit's IDENTITY for the report — not necessarily an entry this pass writes.
            leaderIndex: match.unit.leader.index,
            ...(match.unit.leader.messageId === undefined
                ? {}
                : { leaderMessageId: match.unit.leader.messageId }),
            // THE WRITE SET (leader first on a fresh unit; surviving results only when the
            // trimmer already took the request). A writer that iterates this list can never
            // resurrect an entry another plugin withheld.
            members: match.writeSet.map((member) => member.index),
            outcomes: match.unit.outcomes,
            keys: match.unit.keys,
            resolverIndex: match.resolver.leader.index,
            ...(match.resolver.leader.messageId === undefined
                ? {}
                : { resolverMessageId: match.resolver.leader.messageId }),
            // Per-unit number for the diagnostic: the same estimator, THIS WRITE SET only, so
            // it is the saving the request actually delivers. It is the sum of a subset, so the
            // plan's total (which removes the whole set at once) is the authoritative figure.
            tokens: withheldTokensOf(messages, unitIndices)
        });
    }

    // T4.1 — the floor rejects the WHOLE pass rather than part of it. Half a batch is the
    // cache churn Q5 is trying to avoid, and a partial prune of an old conversation is
    // harder to reason about than "nothing happened this turn".
    if (candidates.length > 0 && withheldTokens < minTokens) {
        return {
            candidates: [],
            withheldTokens,
            consideredUnits,
            belowFloor: true
        };
    }

    return {
        candidates,
        withheldTokens,
        consideredUnits,
        belowFloor: false
    };
};

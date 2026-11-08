// core/context-pruning.ts — the progressive-compaction T3 policy, pinned as a pure
// function (no harness, no transport, no clock).
//
// WHAT THIS FILE PINS, and why each case exists
// --------------------------------------------
//   1. the resolution rule, row for row, against the matrix the fingerprint helper wrote
//      down before the policy existed (../argument-fingerprint.ts:63-71 and
//      ./argument-fingerprint.test.ts:224) — those rows ARE the acceptance data, so the
//      policy cannot quietly redefine "answered";
//   2. the exact set of units one pass disables, by TRANSCRIPT INDEX (the doc's own
//      *Check:* wording: a `[read(failed), read(completed same args)]` pair leaves the
//      first unit disabled and the second enabled);
//   3. the three conservative keeps: an unanswered/in-flight unit, a `cancelled` unit, and a
//      mixed block — plus the tail horizon counted FROM THE END (T4.2, not
//      `context.iteration`);
//   4. the guards: `minTokens` refuses the WHOLE pass (T4.1), `maxUnits` bounds one pass and
//      takes the OLDEST eligible units (T4.3), and a second pass over an already-pruned
//      transcript produces no candidates at all — which is what makes "no write, no
//      notification, no save" true (T4.4's durability premise);
//   5. the token accounting, measured with the package estimator and asserted as an EXACT
//      number, so the floor is a number an operator can reason about rather than a vibe.
//
// Determinism note: every expected value below is hand-derived from the fixture — indices
// from the layout, outcomes from the messages, tokens from `estimateContextTokens`'
// documented `ceil(chars / 4)` rule over the withheld messages' content plus the tool
// names and raw arguments (./context-estimate.ts `messageChars`). Nothing here reads
// production output back in and calls it expected.

import { describe, expect, it } from 'vitest';
import {
    PRUNE_CANDIDATE_OUTCOMES,
    RESOLVING_OUTCOME,
    groupUnits,
    isCandidateFacts,
    planContextPruning,
    resolvesPrunedFailure
} from './context-pruning';
import { toolCallFingerprint } from './argument-fingerprint';
import type { HarnessContextEntry, HarnessMessage, HarnessToolOutcome } from '../types';

// The estimator this policy is contractually bound to. Importing it here is not
// circular reasoning about TOKENS: the test uses it to derive the number the fixture was
// built to produce, and separately pins the fixture's byte sizes so the number cannot
// drift silently with the fixture.
import { estimateContextTokens } from './context-estimate';

// The options every case shares unless the case is ABOUT a guard. `maxUnits` mirrors the
// plugin's bound; `safetyUnits` 0 means "no horizon", which makes the index expectations
// below readable — the horizon has its own tests.
const NO_GUARDS = { safetyUnits: 0, maxUnits: 8, minTokens: 0 };

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// One message of a fixture transcript. `call` makes the assistant entry that opens a
// tool unit; `result` makes the tool entry that answers it, and its `outcome` is written
// EXACTLY as the runtime writes it: absent for `completed` (core/tool-outcome.ts).
type Spec =
    | { user: string }
    | { said: string }
    | {
          call: { id: string; name: string; arguments: string };
          said?: string;
      }
    | { result: { id: string; name: string; content: string; outcome?: HarnessToolOutcome } };

const messagesOf = (specs: readonly Spec[]): HarnessMessage[] => {
    const messages: HarnessMessage[] = [];

    for (const spec of specs) {
        if ('user' in spec) {
            messages.push({ role: 'user', content: spec.user });
            continue;
        }

        if ('call' in spec) {
            messages.push({
                role: 'assistant',
                content: spec.said ?? '',
                toolCalls: [{ id: spec.call.id, name: spec.call.name, arguments: spec.call.arguments }]
            });
            continue;
        }

        if ('said' in spec) {
            messages.push({ role: 'assistant', content: spec.said });
            continue;
        }

        // The storage rule T1 landed: only a NON-`completed` outcome gets a key, so this
        // fixture writes EXACTLY what the runtime writes and the policy is never handed a
        // shape the transcript could not hold.
        messages.push({
            role: 'tool',
            content: spec.result.content,
            toolCallId: spec.result.id,
            name: spec.result.name,
            ...(spec.result.outcome === undefined || spec.result.outcome === 'completed'
                ? {}
                : { outcome: spec.result.outcome })
        });
    }

    return messages;
};

// The entries `turn.before` hands a compactor: one per canonical message, in canonical
// order, each carrying the EFFECTIVE inclusion of its unit. `disabled` names a unit by the
// index of its ASSISTANT leader — the same addressing `setIncluded` cascades, spelled out
// independently here so the grouping the policy mirrors is cross-checked by the fixture.
const entriesOf = (specs: readonly Spec[], disabled: readonly number[] = []): HarnessContextEntry[] => {
    const messages = messagesOf(specs);
    const leaderOfCall = new Map<string, number>();

    messages.forEach((message, index) => {
        if (message.role !== 'assistant' || message.toolCalls === undefined) return;

        for (const call of message.toolCalls) {
            if (!leaderOfCall.has(call.id)) leaderOfCall.set(call.id, index);
        }
    });

    const off = new Set(disabled);

    return messages.map((message, index) => {
        let leader = index;

        if (message.role === 'tool') {
            const owner = leaderOfCall.get(message.toolCallId);

            if (owner !== undefined) leader = owner;
        }

        // A minted id for every entry, like the runtime's (src/core/message-id.ts), so the
        // plan's `leaderMessageId` / `resolverMessageId` are exercised rather than absent.
        return {
            index,
            message: { ...message, messageId: `msg-${index + 1}` },
            messageId: `msg-${index + 1}`,
            included: !off.has(leader)
        } as HarnessContextEntry;
    });
};

// The canonical (un-advertised) transcript for the shared fixture: a failed `read` of
// `a.ts`, then the SAME call answered, with a standalone turn on each side.
const FAILED_THEN_ANSWERED: readonly Spec[] = [
    { user: 'open a' },
    { call: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } },
    { result: { id: 'c1', name: 'read', content: 'Tool "read" failed: EIO', outcome: 'failed' } },
    { call: { id: 'c2', name: 'read', arguments: '{ "path" : "a.ts" }' } },
    { result: { id: 'c2', name: 'read', content: 'export const a = 1;' } },
    { said: 'done' }
];

const planOf = (
    specs: readonly Spec[],
    disabled: readonly number[] = [],
    options: Partial<typeof NO_GUARDS> = {}
) => planContextPruning(entriesOf(specs, disabled), { ...NO_GUARDS, ...options });

// One line, in the shape the policy is asked to produce, so the assertions below read as
// the rule rather than as an object dump.
const shapeOf = (plan: ReturnType<typeof planOf>) =>
    plan.candidates.map((candidate) => ({
        leaderIndex: candidate.leaderIndex,
        members: candidate.members,
        outcomes: candidate.outcomes,
        resolverIndex: candidate.resolverIndex,
        leaderMessageId: candidate.leaderMessageId,
        resolverMessageId: candidate.resolverMessageId,
        tokens: candidate.tokens
    }));

// ---------------------------------------------------------------------------
// 1. The resolution rule — the matrix, reused as acceptance data
// ---------------------------------------------------------------------------

// The rows are copied from ./argument-fingerprint.test.ts (`RESOLUTION_MATRIX`), which is
// where the rule was written down BEFORE this policy existed and which keeps the
// fingerprint half of the matrix. `resolves` is the column the helper deliberately refused
// to decide; it is decided here.
type Row = {
    case: string;
    earlierName: string;
    earlierArgs: string;
    earlierOutcome: HarnessToolOutcome;
    laterName: string;
    laterArgs: string;
    laterOutcome: HarnessToolOutcome;
    resolves: boolean;
};

const MATRIX_ROWS: readonly Row[] = [
    {
        case: 'retry-succeeded',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{ "path" : "a.ts" }',
        laterOutcome: 'completed',
        resolves: true
    },
    {
        case: 'reordered-keys-retry-succeeded',
        earlierName: 'read',
        earlierArgs: '{"offset":10,"path":"a.ts"}',
        earlierOutcome: 'rejected',
        laterName: 'read',
        laterArgs: '{"path":"a.ts","offset":10}',
        laterOutcome: 'completed',
        resolves: true
    },
    {
        case: 're-sent-identical-malformed-call-succeeded',
        earlierName: 'exec',
        earlierArgs: '{"command":"ec',
        earlierOutcome: 'rejected',
        laterName: 'exec',
        laterArgs: '  {"command":"ec  ',
        laterOutcome: 'completed',
        resolves: true
    },
    {
        case: 'answered-by-different-page',
        earlierName: 'read',
        earlierArgs: '{"offset":0,"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{"offset":50,"path":"a.ts"}',
        laterOutcome: 'completed',
        resolves: false
    },
    {
        case: 'answered-by-different-tool',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'write',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'completed',
        resolves: false
    },
    {
        case: 'truncated-call-answered-by-complete-call',
        earlierName: 'exec',
        earlierArgs: '{"command":"ec',
        earlierOutcome: 'failed',
        laterName: 'exec',
        laterArgs: '{"command":"echo"}',
        laterOutcome: 'completed',
        resolves: false
    },
    {
        case: 'blank-call-answered-by-empty-object',
        earlierName: 'tasks',
        earlierArgs: '',
        earlierOutcome: 'failed',
        laterName: 'tasks',
        laterArgs: '{}',
        laterOutcome: 'completed',
        resolves: false
    },
    {
        // `cancelled` is an expected control outcome, never a failure to be retried away.
        case: 'cancelled-is-never-resolved',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'cancelled',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'completed',
        resolves: false
    },
    {
        case: 'completed-is-never-a-candidate',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'completed',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'completed',
        resolves: false
    },
    {
        case: 'answered-by-a-cancellation',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'cancelled',
        resolves: false
    },
    {
        case: 'answered-by-another-failure',
        earlierName: 'read',
        earlierArgs: '{"path":"a.ts"}',
        earlierOutcome: 'failed',
        laterName: 'read',
        laterArgs: '{"path":"a.ts"}',
        laterOutcome: 'failed',
        resolves: false
    }
];

const factsOf = (
    name: string,
    args: string,
    outcome: HarnessToolOutcome,
    included = true
) => ({
    outcomes: [outcome] as readonly HarnessToolOutcome[],
    keys: [toolCallFingerprint(name, args)],
    included
});

describe('resolvesPrunedFailure — the resolution matrix (T2.3, decided here)', () => {
    it('matches every hand-written expectation in the matrix', () => {
        expect(
            MATRIX_ROWS.map((row) =>
                resolvesPrunedFailure(
                    factsOf(row.earlierName, row.earlierArgs, row.earlierOutcome),
                    factsOf(row.laterName, row.laterArgs, row.laterOutcome)
                )
            )
        ).toEqual(MATRIX_ROWS.map((row) => row.resolves));
    });

    it('names the two resolved cases by name, not by count', () => {
        expect(
            MATRIX_ROWS.filter((row) =>
                resolvesPrunedFailure(
                    factsOf(row.earlierName, row.earlierArgs, row.earlierOutcome),
                    factsOf(row.laterName, row.laterArgs, row.laterOutcome)
                )
            ).map((row) => row.case)
        ).toEqual([
            'retry-succeeded',
            'reordered-keys-retry-succeeded',
            're-sent-identical-malformed-call-succeeded'
        ]);
    });

    it('pins the outcome sets the contract fixes', () => {
        expect(PRUNE_CANDIDATE_OUTCOMES).toEqual(['failed', 'rejected']);
        expect(RESOLVING_OUTCOME).toBe('completed');
    });

    it('refuses a resolver that is itself withheld', () => {
        // The model would then see NEITHER the failure NOR the answer, which is the one
        // way this policy could make an agent lost rather than merely shorter.
        const failed = factsOf('read', '{"path":"a.ts"}', 'failed');
        const answered = factsOf('read', '{"path":"a.ts"}', 'completed', false);

        expect(resolvesPrunedFailure(failed, answered)).toBe(false);
        expect(resolvesPrunedFailure(failed, factsOf('read', '{"path":"a.ts"}', 'completed'))).toBe(
            true
        );
    });

    it('requires EVERY call of a block to be redone', () => {
        // Q4's unit-level choice in its conservative direction: a block that asked for two
        // things is only superseded when the retry did both.
        const earlier = {
            outcomes: ['failed', 'failed'] as readonly HarnessToolOutcome[],
            keys: [
                toolCallFingerprint('read', '{"path":"a.ts"}'),
                toolCallFingerprint('read', '{"path":"b.ts"}')
            ],
            included: true
        };
        const half = {
            outcomes: ['completed'] as readonly HarnessToolOutcome[],
            keys: [toolCallFingerprint('read', '{"path":"a.ts"}')],
            included: true
        };
        const whole = {
            outcomes: ['completed', 'completed'] as readonly HarnessToolOutcome[],
            keys: [
                toolCallFingerprint('read', '{"path":"b.ts"}'),
                toolCallFingerprint('read', '{"path":"a.ts"}')
            ],
            included: true
        };

        expect(resolvesPrunedFailure(earlier, half)).toBe(false);
        expect(resolvesPrunedFailure(earlier, whole)).toBe(true);
    });

    it('classifies candidate facts exactly', () => {
        const keys = [toolCallFingerprint('read', '{}')];

        expect(isCandidateFacts({ outcomes: ['failed'], keys, included: true })).toBe(true);
        expect(isCandidateFacts({ outcomes: ['rejected'], keys, included: true })).toBe(true);
        // NO result committed: not a candidate, whatever the calls were (T0 Q3).
        expect(isCandidateFacts({ outcomes: [], keys, included: true })).toBe(false);
        // A healthy or self-chosen stop is a live answer, and a mixed block answered
        // something the model asked for.
        expect(isCandidateFacts({ outcomes: ['completed'], keys, included: true })).toBe(false);
        expect(isCandidateFacts({ outcomes: ['cancelled'], keys, included: true })).toBe(false);
        expect(
            isCandidateFacts({ outcomes: ['failed', 'completed'], keys, included: true })
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. The plan, by index
// ---------------------------------------------------------------------------

describe('planContextPruning — the exact set a pass disables', () => {
    it('disables the failed unit and keeps the answering unit', () => {
        const plan = planOf(FAILED_THEN_ANSWERED);
        const readKey = toolCallFingerprint('read', '{"path":"a.ts"}');

        expect(plan.candidates).toEqual([
            {
                leaderIndex: 1,
                leaderMessageId: 'msg-2',
                members: [1, 2],
                outcomes: ['failed'],
                keys: [readKey],
                resolverIndex: 3,
                resolverMessageId: 'msg-4',
                tokens: 12
            }
        ]);

        // The doc's own phrasing of this case: `[0]` disabled and `[1]` enabled — i.e. the
        // unit that asked (index 1) is the one named, and the answering unit is untouched.
        expect(plan.candidates.map((candidate) => candidate.leaderIndex)).toEqual([1]);
        expect(plan.withheldTokens).toBe(12);
        expect(plan.belowFloor).toBe(false);
        expect(plan.consideredUnits).toBe(4);
    });

    it('counts the withheld tokens with the package estimator, exactly', () => {
        const entries = entriesOf(FAILED_THEN_ANSWERED);
        const messages = entries.map((entry) => entry.message);

        // 12 = ceil(46 / 4): the withheld unit is the assistant entry (0 content + `read` 4
        // + the raw `{"path":"a.ts"}` 15 = 19) plus its result (23 content + `read` 4 = 27).
        // Cross-checked against the estimator over the whole transcript minus the unit.
        expect(
            estimateContextTokens(messages) -
                estimateContextTokens(messages.filter((_, index) => index !== 1 && index !== 2))
        ).toBe(12);

        // A bigger result moves the number, so the account is not a constant in disguise.
        const wide = planOf([
            { user: 'open a' },
            { call: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } },
            {
                result: {
                    id: 'c1',
                    name: 'read',
                    content: 'x'.repeat(400),
                    outcome: 'failed'
                }
            },
            { call: { id: 'c2', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'c2', name: 'read', content: 'ok' } }
        ]);

        // 400 chars of result text + 4 of result name + the leader's 19 (4 name + 15 raw
        // arguments) = 423 chars, minus the 400 that stay in the transcript's other numbers:
        // asserted as an exact token count so a fixture edit that changes the SIZE fails
        // here rather than quietly moving the floor.
        expect(wide.withheldTokens).toBe(106);
    });

    it('prunes several units of one transcript in one pass, oldest first', () => {
        const plan = planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { user: 'again' },
            { call: { id: 'a2', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a2', name: 'read', content: 'ok' } },
            { call: { id: 'b1', name: 'exec', arguments: '{"c":1}' } },
            { result: { id: 'b1', name: 'exec', content: 'nope', outcome: 'rejected' } },
            { call: { id: 'b2', name: 'exec', arguments: '{ "c" : 1 }' } },
            { result: { id: 'b2', name: 'exec', content: 'ok' } }
        ]);

        expect(plan.candidates.map((candidate) => candidate.leaderIndex)).toEqual([1, 6]);
        expect(plan.candidates.map((candidate) => candidate.resolverIndex)).toEqual([4, 8]);
        expect(plan.candidates.map((candidate) => candidate.outcomes)).toEqual([
            ['failed'],
            ['rejected']
        ]);
    });

    it('matches a reordered-JSON retry and refuses a different page', () => {
        // The fingerprint is the whole point: raw text differs, the work does not.
        expect(planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"offset":10,"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { call: { id: 'a2', name: 'read', arguments: '{"path":"a.ts","offset":10}' } },
            { result: { id: 'a2', name: 'read', content: 'ok' } }
        ]).candidates.map((candidate) => candidate.leaderIndex)).toEqual([1]);

        expect(planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"offset":10,"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { call: { id: 'a2', name: 'read', arguments: '{"offset":20,"path":"a.ts"}' } },
            { result: { id: 'a2', name: 'read', content: 'ok' } }
        ]).candidates).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 3. What is deliberately KEPT
// ---------------------------------------------------------------------------

describe('planContextPruning — what no pass may touch', () => {
    it('keeps a failure that has no answer yet', () => {
        const plan = planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { user: 'and now?' }
        ]);

        expect(plan.candidates).toEqual([]);
        expect(plan.withheldTokens).toBe(0);
    });

    it('keeps a block whose call is still in flight (no committed result at all)', () => {
        // `entries` comes from the canonical transcript, so an in-flight call has its
        // assistant block and NO tool message. This is the case the horizon exists for,
        // and the reason a plugin cannot guess it from `context.iteration`.
        const plan = planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { call: { id: 'z1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { said: 'waiting' }
        ]);

        expect(plan.candidates).toEqual([]);
        expect(groupUnits(entriesOf([
            { user: 'go' },
            { call: { id: 'z1', name: 'read', arguments: '{"path":"a.ts"}' } }
        ]))[1].kind).toBe('unanswered');
    });

    it('keeps a cancelled unit even when an identical call later succeeded', () => {
        const plan = planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'cancelled', outcome: 'cancelled' } },
            { call: { id: 'a2', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a2', name: 'read', content: 'ok' } }
        ]);

        expect(plan.candidates).toEqual([]);
    });

    it('keeps a block that mixed a failed call with a successful one', () => {
        // Q4's cost, taken the conservative way: one assistant block asked for two things,
        // one answered and one failed. Withholding it whole would remove a LIVE result, and
        // a live result is what the model asked for.
        const entries = entriesOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { result: { id: 'a2', name: 'read', content: 'ok' } },
            { call: { id: 'b1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'b1', name: 'read', content: 'ok' } }
        ]);

        // Two answers of one block: attach the second result to the FIRST block by hand,
        // because the fixture builder gives every `call` its own block.
        (entries[3].message as Extract<HarnessMessage, { role: 'tool' }>).toolCallId = 'a1b';
        (entries[1].message as Extract<HarnessMessage, { role: 'assistant' }>).toolCalls = [
            ...(entries[1].message as Extract<HarnessMessage, { role: 'assistant' }>).toolCalls!,
            { id: 'a1b', name: 'read', arguments: '{"path":"b.ts"}' }
        ];

        expect(groupUnits(entries)[1].kind).toBe('mixed');
        expect(planContextPruning(entries, NO_GUARDS).candidates).toEqual([]);
    });

    it('keeps an already-disabled unit, so a second pass writes nothing', () => {
        const first = planOf(FAILED_THEN_ANSWERED);

        expect(first.candidates.map((candidate) => candidate.leaderIndex)).toEqual([1]);

        // The same transcript with the winner's flag applied — exactly what the NEXT round
        // sees, because `setIncluded` is canonical state (and persisted, T1/context T4).
        const second = planOf(FAILED_THEN_ANSWERED, [1]);

        expect(second.candidates).toEqual([]);
        expect(second.withheldTokens).toBe(0);
        expect(second.belowFloor).toBe(false);
    });

    it('protects the last N UNITS, counted from the end (T4.2)', () => {
        const specs: readonly Spec[] = [
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
            { call: { id: 'a2', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a2', name: 'read', content: 'ok' } }
        ];

        // Units are [user, failed block, answering block] = 3. A horizon of 1 protects the
        // answering unit only, so the failure is still prunable...
        expect(planOf(specs, [], { safetyUnits: 1 }).candidates.map((c) => c.leaderIndex)).toEqual(
            [1]
        );

        // ...a horizon of 2 protects the answering unit AND the failure, so nothing is a
        // candidate any more. The direction matters: a horizon that counted from the FRONT
        // would prune exactly the work the agent is still doing.
        expect(planOf(specs, [], { safetyUnits: 2 }).candidates).toEqual([]);
        expect(planOf(specs, [], { safetyUnits: 99 }).candidates).toEqual([]);

        // A non-finite or negative horizon behaves as 0 rather than protecting everything:
        // a corrupt stored value must not silently disable the policy.
        expect(planOf(specs, [], { safetyUnits: Number.NaN }).candidates.map((c) => c.leaderIndex)).toEqual([1]);
        expect(planOf(specs, [], { safetyUnits: -4 }).candidates.map((c) => c.leaderIndex)).toEqual([1]);
    });

    it('lets a unit inside the horizon still ANSWER an older failure', () => {
        // The horizon bounds what may be PRUNED, not what may be believed. The most recent
        // success is the best evidence that an older failure is stale.
        const plan = planOf(
            [
                { user: 'go' },
                { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
                { result: { id: 'a1', name: 'read', content: 'boom', outcome: 'failed' } },
                { user: 'middle' },
                { said: 'middle answer' },
                { call: { id: 'a2', name: 'read', arguments: '{"path":"a.ts"}' } },
                { result: { id: 'a2', name: 'read', content: 'ok' } }
            ],
            [],
            { safetyUnits: 2 }
        );

        expect(plan.candidates.map((candidate) => candidate.leaderIndex)).toEqual([1]);
        expect(plan.candidates.map((candidate) => candidate.resolverIndex)).toEqual([5]);
    });

    it('never prunes a genuinely completed unit, nor a repaired interrupted result', () => {
        // The interrupted-call repair commits a tool message with NO outcome, so it reads
        // `completed` — which is exactly why it can never be a CANDIDATE here.
        const plan = planOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { result: { id: 'a1', name: 'read', content: 'The call did not finish.' } },
            { user: 'next' }
        ]);

        expect(plan.candidates).toEqual([]);
    });

    it('treats an orphan tool result as its own unit and never as a candidate', () => {
        // Its block is gone (a host `replaceHistory()`), so it classifies `unanswered`:
        // the grouping mirrors the runtime, and the write cascade is the runtime's anyway.
        const units = groupUnits(entriesOf([
            { user: 'go' },
            { result: { id: 'ghost', name: 'read', content: 'boom', outcome: 'failed' } }
        ]));

        expect(units.map((unit) => unit.kind)).toEqual(['standalone', 'standalone']);
        expect(units[1].members.map((member) => member.index)).toEqual([1]);
    });
});

// ---------------------------------------------------------------------------
// 4. The guards (T4.1, T4.3)
// ---------------------------------------------------------------------------

describe('planContextPruning — the guards', () => {
    it('refuses the WHOLE pass when the saving is under minTokens', () => {
        const plan = planOf(FAILED_THEN_ANSWERED, [], { minTokens: 13 });

        // The candidate existed (14 tokens) but 14 < 15, so NOTHING is proposed — the caller
        // therefore writes nothing, notifies nothing and saves nothing.
        expect(plan.candidates).toEqual([]);
        expect(plan.belowFloor).toBe(true);
        expect(plan.withheldTokens).toBe(12);
        expect(plan.consideredUnits).toBe(4);

        // At the floor it goes through: the comparison is `>=`, not `>`.
        expect(
            planOf(FAILED_THEN_ANSWERED, [], { minTokens: 12 }).candidates.map(
                (c) => c.leaderIndex
            )
        ).toEqual([1]);
    });

    it('measures the floor over the whole batch, not per unit', () => {
        // Two 3-token candidates that together clear the floor must not be refused twice —
        // the Q5 argument in one assertion: one cache invalidation for both, none for either.
        const specs: readonly Spec[] = [
            { user: 'go' },
            { call: { id: 'a1', name: 'r', arguments: '{"p":1}' } },
            { result: { id: 'a1', name: 'r', content: 'boom', outcome: 'failed' } },
            { call: { id: 'a2', name: 'r', arguments: '{"p":1}' } },
            { result: { id: 'a2', name: 'r', content: 'ok' } },
            { call: { id: 'b1', name: 'r', arguments: '{"p":2}' } },
            { result: { id: 'b1', name: 'r', content: 'boom', outcome: 'failed' } },
            { call: { id: 'b2', name: 'r', arguments: '{"p":2}' } },
            { result: { id: 'b2', name: 'r', content: 'ok' } }
        ];

        const each = planOf(specs, [], { minTokens: 0 });

        // Each unit alone is worth 3 tokens; removed together they are worth 7, because the
        // estimator rounds ONCE over the transcript. The batch number is the authoritative
        // one, which is exactly why the floor is measured over the batch.
        expect(each.candidates.map((candidate) => candidate.tokens)).toEqual([3, 3]);
        expect(each.withheldTokens).toBe(7);
        expect(planOf(specs, [], { minTokens: 8 }).candidates).toEqual([]);
        expect(planOf(specs, [], { minTokens: 7 }).candidates.map((c) => c.leaderIndex)).toEqual([
            1,
            5
        ]);
    });

    it('takes at most maxUnits per pass, oldest first', () => {
        // Ten superseded failures: the bound is what stops a first pass over an old
        // conversation from emptying it in one turn.
        const specs: Spec[] = [{ user: 'go' }];

        for (let round = 0; round < 10; round += 1) {
            specs.push({ call: { id: `f${round}`, name: 'read', arguments: `{"p":${round}}` } });
            specs.push({
                result: { id: `f${round}`, name: 'read', content: 'boom', outcome: 'failed' }
            });
            specs.push({ call: { id: `k${round}`, name: 'read', arguments: `{"p":${round}}` } });
            specs.push({ result: { id: `k${round}`, name: 'read', content: 'ok' } });
        }

        const plan = planOf(specs, [], { maxUnits: 3 });

        expect(plan.candidates.map((candidate) => candidate.leaderIndex)).toEqual([1, 5, 9]);
        expect(plan.candidates.map((candidate) => candidate.resolverIndex)).toEqual([3, 7, 11]);

        // The bound is not a preference: the untaken units are still there, and the NEXT
        // pass takes them, so the conversation shrinks over turns instead of at once.
        expect(planOf(specs, [], { maxUnits: 0 }).candidates).toEqual([]);
        expect(planOf(specs, [], { maxUnits: -1 }).candidates).toEqual([]);
        expect(planOf(specs, [], { maxUnits: 20 }).candidates).toHaveLength(10);
    });

    it('reports no floor rejection when there was nothing to prune', () => {
        // `belowFloor` means "superseded work existed and was refused". A plain
        // nothing-to-do turn must not look like a refusal, or the diagnostic becomes noise.
        const plan = planOf([{ user: 'go' }, { said: 'hi' }], [], { minTokens: 500 });

        expect(plan.candidates).toEqual([]);
        expect(plan.belowFloor).toBe(false);
        expect(plan.withheldTokens).toBe(0);
        expect(plan.consideredUnits).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// 5. The grouping mirror (header: "one mirror, and why divergence is safe")
// ---------------------------------------------------------------------------

describe('groupUnits', () => {
    it('attaches a result spliced in LATER to the block that asked for it', () => {
        // A background tool's real result is committed at its ORIGINAL position
        // (../harness.ts `resultInsertIndex`), and a host transcript may hold it in a
        // different order. Membership is by call id, not adjacency.
        const units = groupUnits(entriesOf([
            { user: 'go' },
            { call: { id: 'a1', name: 'read', arguments: '{}' } },
            { said: 'unrelated' },
            { result: { id: 'a1', name: 'read', content: 'ok' } }
        ]));

        // Three units, not four: index 3 belongs to the block that asked for it, so it is a
        // MEMBER and never a leader of its own.
        expect(units.map((unit) => unit.leader.index)).toEqual([0, 1, 2]);
        expect(units[1].members.map((member) => member.index)).toEqual([1, 3]);
        expect(units[2].members.map((member) => member.index)).toEqual([2]);
        expect(units[0].kind).toBe('standalone');
        expect(units[1].kind).toBe('answered');
    });

    it('pins the fingerprint format the plan reports', () => {
        // Not decoration: the diagnostic shows these keys, and a format change is a change
        // an operator would see.
        expect(toolCallFingerprint('read', '{"path":"a.ts"}')).toBe(
            'read\u0000{"path":"a.ts"}'
        );

        const plan = planOf(FAILED_THEN_ANSWERED);

        expect(plan.candidates[0].keys).toEqual(['read\u0000{"path":"a.ts"}']);
    });
});

// The shipped `context-trimmer` preset plugin (src/plugins/context-trimmer.plugin.ts).
//
// WHAT THIS FILE PINS
// -------------------
// The RULE (which superseded tool units leave the context, and which stay), the TRIGGER
// guards, the WRITES, the report, and one end-to-end turn through a REAL harness:
//
//   A1. a `failed` (or `rejected`) unit that a LATER `completed` unit of the SAME TOOL NAME
//       answers is withheld — one `setIncluded(leader, false)`, and in the harness run the
//       assistant block AND its result are gone from the provider request while canonical
//       history still carries both, flagged;
//   A2. keeps: no later success, a later success of a DIFFERENT name, a resolver unit that is
//       itself excluded, and the candidate that is already excluded (idempotence);
//   A3. several failures before one success are ALL withheld, oldest first, and a failure
//       AFTER the last success stays (it is the newest fact in the window);
//   A4. a unit is all-or-nothing: a block whose names are only PARTLY answered later is kept;
//   A5. `enabled: false`, an internal compaction agent and a branch round change nothing, and
//       a re-run over an already-trimmed transcript writes and reports NOTHING;
//   plus the plugin's declared SWITCH SURFACE (every key, type, default and numeric bound it
//       publishes — asserted as one exact list, so a switch cannot ship unannounced), the
//       POLICY SWITCHES themselves (both tool switches off == the engine's posture with no
//       write and no diagnostic; the two switches independent; a `string` tier the write edge
//       accepted with a garbage value runs as its documented fallback and says so), and the
//       synchronous fast path:
//       a turn that trims nothing returns `undefined` (no promise, no park), and only a real
//       trim pays `pause -> write -> resume`.
//
// The name-only match is the ONE deliberate difference from context-compaction, so the
// fixtures below use DIFFERENT arguments for the failure and its retry: the shipped
// fingerprint rule (`../core/context-pruning.ts` `resolvesPrunedFailure`) would keep them,
// this plugin must not. The stricter rule's own table lives in
// src/core/context-pruning.test.ts and is unaffected.
//
// Two levels, deliberately: the guard/writer run against fakes, where every control is
// recorded and every number is an exact input; the built-in then runs inside a real harness
// with a scripted transport, where the provider request and the canonical transcript are both
// asserted, including the `pairIssues` pairing oracle borrowed from
// src/harness.inclusion.test.ts (an excluded unit that leaked one result shows up there).
//
// Cross-references:
//   - ../plugins/context-trimmer.plugin.ts      — the implementation under test
//   - ../plugins/context-compaction.plugin.ts   — the stricter sibling, and `isInternalAgent`
//   - ../core/context-pruning.ts                — `groupUnits`, the unit mirror this reuses
//   - ../harness.ts                             — the real `turn.before`, `setIncluded`
//                                                 cascade and pause/resume implementations

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessContextEntry,
    HarnessDiagnosticEvent,
    HarnessLifecycleHandler,
    HarnessMessage,
    HarnessPluginApi,
    HarnessPluginDiagnosticReport,
    HarnessPluginSettingDescriptor,
    HarnessPluginSettingsProvider,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessToolOutcome,
    HarnessTurnBeforeContext
} from '@underload/harness';
import {
    createContextTrimmerHandler,
    executeTrimming,
    metadata,
    planTrimmedUnits,
    planTruncatedRequests,
    planWithheldThoughts,
    setup,
    TRIMMER_DEFAULT_SETTINGS,
    type ThoughtCandidate,
    type TrimCandidate,
    type TrimmerInvalidOutcome,
    type TrimmerSettings
} from '../plugins/context-trimmer.plugin';

// Ids are addresses, not content (context T1, src/core/message-id.ts): stripped DEEPLY so
// every expected value below pins the transcript, not the minting sequence.
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// ---------------------------------------------------------------------------
// Message + entry builders
// ---------------------------------------------------------------------------

// One assistant tool-call block.
const call = (id: string, name: string, args = '{}'): HarnessMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, arguments: args }]
});

// One committed tool result. `completed` is stored as NO key, exactly as the runtime stores
// it (../core/tool-outcome.ts rule 1), so a fixture can never disagree with the read rule.
const result = (
    id: string,
    name: string,
    content: string,
    outcome?: HarnessToolOutcome
): HarnessMessage => ({
    role: 'tool',
    content,
    toolCallId: id,
    name,
    ...(outcome === undefined || outcome === 'completed' ? {} : { outcome })
});

// Canonical entries built the way the runtime builds them: index, message, minted durable id,
// EFFECTIVE unit flag. `excluded` names CANONICAL INDEXES, so a test states exactly which
// members of which unit are already withheld (the runtime would have cascaded the whole unit;
// the policy reads the leader's live flag, which is what an excluded leader models).
const entriesFrom = (
    messages: readonly HarnessMessage[],
    excluded: readonly number[] = []
): HarnessContextEntry[] =>
    messages.map(
        (message, index) =>
            ({
                index,
                message: { ...message, messageId: `msg-${index + 1}` },
                messageId: `msg-${index + 1}`,
                included: !excluded.includes(index)
            }) as unknown as HarnessContextEntry
    );

// A failed `read`, then the SAME TOOL answered with different arguments (the loosening).
// Unit indexes: 1 = the failed block, 2 its result, 3 the answering block, 4 its result.
const TRIMMABLE: readonly HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
    call('c2', 'read', '{"path":"b.ts"}'),
    result('c2', 'read', 'export const b = 2;'),
    { role: 'assistant', content: 'done' }
];

// The one candidate the fixture above produces, spelled out so the assertions below stay
// honest about WHAT leaves the context and WHAT answers it.
//
// `invalidOutcomes` is what the pass JUDGED (the effective outcome of each committed result),
// `outcomes` what the transcript RECORDS — identical for this shape, and the two lists separate
// only for `cancelled`/`empty` (see the T4 tables below). `admittedBy` names every switch that
// could have withheld it — both tool booleans are on by default, and at the default outcome set the
// generalisation is the same predicate as the shipped rule, so both admit it — and `firedBy` is the
// one the report attributes it to, the earliest declared (the shipped rule).
const TRIMMABLE_CANDIDATE: TrimCandidate = {
    leaderIndex: 1,
    leaderMessageId: 'msg-2',
    members: [1, 2],
    outcomes: ['failed'],
    invalidOutcomes: ['failed'],
    names: ['read'],
    admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools'],
    firedBy: 'dropSupersededToolCalls',
    resolverIndex: 3,
    resolverMessageId: 'msg-4'
};

// ---------------------------------------------------------------------------
// Fakes: every control records its own name, so "wrote nothing" and "touched nothing else"
// are assertions about a recorded CALL SEQUENCE rather than about side effects.
// ---------------------------------------------------------------------------

type FakeApi = {
    api: HarnessPluginApi;
    touches: string[];
    diagnostics: HarnessPluginDiagnosticReport[];
    setSetting: (key: string, value: number | string | boolean) => void;
};

// A complete `HarnessPluginApi` whose every control except a settings read and the diagnostic
// channel THROWS. `createAgent`, `addTool`, `snapshot`, `threads.*`, `enableTool`, `async.*`
// and `settings.setOwn` being untouched is therefore proven by the fixture, not promised.
//
// THE HORIZONS ARE SEEDED TO 0 here for exactly the reason `settingsWith` zeroes them for the pure
// plans below: the writer and trigger tables pin WHICH entries get a flag and what the report says,
// on two- and three-turn fixtures that the declared horizon of 2 would protect entirely. The read
// set is unaffected (every switch is read every turn whatever is stored), and the tables that care
// about the horizon values set their own. A table that wants the DECLARED horizons passes
// `atDeclaredHorizons: true`, which leaves the seed out so the values read as the shipped ones.
const NO_HORIZON: Record<string, number> = {
    invalidToolTurns: 0,
    supersededTurns: 0,
    duplicateTurns: 0,
    truncateTurns: 0,
    thoughtTurns: 0
};

const createFakeApi = (stored: Record<string, unknown> = {}): FakeApi => {
    const touches: string[] = [];
    const diagnostics: HarnessPluginDiagnosticReport[] = [];
    const { atDeclaredHorizons, ...values_ } = stored;
    const values: Record<string, unknown> =
        atDeclaredHorizons === true
            ? { ...values_ }
            : { ...NO_HORIZON, ...values_ };

    const skip = (name: string): never => {
        touches.push(name);
        throw new Error(`The trimming action touched ${name}.`);
    };

    const api: HarnessPluginApi = {
        agents: {},
        tools: {},
        createAgent: () => skip('createAgent'),
        addTool: () => skip('addTool'),
        addCommand: () => skip('addCommand'),
        on: () => () => undefined,
        settings: {
            get: (key) => {
                touches.push(`settings.get:${key}`);
                return values[key];
            },
            number: (key, fallback) => {
                touches.push(`settings.number:${key}`);
                const value = values[key];

                return typeof value === 'number' ? value : (fallback ?? 0);
            },
            string: (key, fallback) => {
                touches.push(`settings.string:${key}`);
                const value = values[key];

                return typeof value === 'string' ? value : (fallback ?? '');
            },
            boolean: (key, fallback) => {
                touches.push(`settings.boolean:${key}`);
                const value = values[key];

                return typeof value === 'boolean' ? value : (fallback ?? false);
            },
            setOwn: (key) => skip(`settings.setOwn:${key}`)
        },
        report: {
            diagnostic: (report) => {
                touches.push('report.diagnostic');
                diagnostics.push(report);
            }
        },
        snapshot: () => skip('snapshot'),
        threads: {
            list: () => skip('threads.list'),
            create: () => skip('threads.create'),
            delete: () => skip('threads.delete'),
            remove: () => skip('threads.remove'),
            stop: () => skip('threads.stop'),
            send: () => skip('threads.send'),
            steer: () => skip('threads.steer'),
            messages: () => skip('threads.messages'),
            replaceMessages: () => skip('threads.replaceMessages'),
            setStatus: () => skip('threads.setStatus')
        },
        enableTool: () => skip('enableTool'),
        disableTool: () => skip('disableTool'),
        enabledTools: () => skip('enabledTools'),
        async: {
            pending: () => skip('async.pending'),
            wake: () => skip('async.wake')
        },
        config: { wakeIntervalMs: 600000 }
    };

    return {
        api,
        touches,
        diagnostics,
        setSetting: (key, value) => {
            values[key] = value;
        }
    };
};

// The EXACT settings read set of one turn that gets past the guards: the `enabled` the guard
// shares with the framework's hook gate, then every policy switch in the PINNED READ ORDER, read
// once per turn. Pinned as one list in every fast-path assertion below, so a switch that ships
// without being consulted — or one consulted twice a turn — fails, and so does a switch that
// leaks in front of the guards (a branch round, an internal agent or a disabled plugin still
// cost what invariant 5 promises: one read, or none). A HORIZON is read immediately after the
// toggle it belongs to, which is the pairing this order tracks. It is NOT the descriptor order
// any more: since the 2026-11-13 grouping the list is ordered for the PANE (categories, then the
// fields nested under each toggle), and `group`/`parentKey` are display-only metadata nothing
// reads, so the runtime keeps its own order rather than a pinned contract moving for a styling
// reason.
const TURN_READS: readonly string[] = [
    'settings.boolean:enabled',
    'settings.boolean:trimInvalidTools',
    'settings.number:invalidToolTurns',
    'settings.boolean:trimThoughts',
    'settings.number:thoughtTurns',
    'settings.boolean:truncateToolRequests',
    'settings.number:truncateTurns',
    'settings.boolean:dropSupersededToolCalls',
    'settings.number:supersededTurns',
    'settings.boolean:dropDuplicateCalls',
    'settings.number:duplicateTurns',
    'settings.string:invalidOutcomes',
    'settings.string:supersedeMatch',
    'settings.number:minTokens',
    'settings.number:minThoughtChars',
    'settings.number:safetyUnits',
    'settings.number:maxUnits'
];

// The `data.policy` block of a pass that ran on the writer tables' BASELINE: every switch as it was
// resolved, EVERY HORIZON next to the rule it windows (0 here, because `createFakeApi` opens the
// horizons — see the note there), every tier next to the value that was submitted (identical here —
// nothing fell back), the precedence the axes ran in, and `fired`, the switches that account for a
// shipped-rule withholding. The DECLARED values of the horizons are pinned by
// `DECLARED_DEFAULT_POLICY` below, which a pass over a long-enough transcript reports verbatim.
const DEFAULT_POLICY = {
    dropSupersededToolCalls: true,
    supersededTurns: 0,
    trimInvalidTools: true,
    invalidToolTurns: 0,
    invalidOutcomes: 'failed/rejected',
    invalidOutcomesSubmitted: 'failed,rejected',
    invalidOutcomesFallback: false,
    trimThoughts: true,
    thoughtTurns: 0,
    truncateToolRequests: false,
    truncateTurns: 0,
    supersedeMatch: 'name',
    supersedeMatchSubmitted: 'name',
    supersedeMatchFallback: false,
    dropDuplicateCalls: false,
    duplicateTurns: 0,
    minTokens: 0,
    minThoughtChars: 0,
    safetyUnits: 0,
    maxUnits: 0,
    precedence: 'whole-unit trim > truncate request > withhold thinking',
    fired: ['dropSupersededToolCalls', 'trimInvalidTools']
};

// The same block with NOTHING overridden at all: every horizon at its declared 2. `atDeclaredHorizons`
// leaves the baseline seed out of the fake's store, so the numbers in the report are the shipped
// ones, and the fixture below is long enough that the oldest unit is still outside the horizon.
const DECLARED_DEFAULT_POLICY = {
    ...DEFAULT_POLICY,
    supersededTurns: 2,
    invalidToolTurns: 2,
    thoughtTurns: 2,
    truncateTurns: 2,
    duplicateTurns: 2
};

const ONE_USER_TURN: readonly HarnessMessage[] = [{ role: 'user', content: 'question' }];

// A full `turn.before` payload. `entries` is writable-entry-backed, so `setIncluded` flips the
// LIVE flag the policy re-reads — the exact mechanism idempotence depends on.
type FakeTurnInput = {
    api: HarnessPluginApi;
    calls: string[];
    entries?: HarnessContextEntry[];
    threadId?: string;
    agent?: string;
    branchId?: string;
    actorKey?: string;
    // A turn whose `entries` getter must never be read: any access throws.
    guardEntries?: boolean;
};

const createFakeTurn = (input: FakeTurnInput): HarnessTurnBeforeContext => {
    const entries = input.entries ?? entriesFrom(ONE_USER_TURN);

    const context: HarnessTurnBeforeContext = {
        threadId: input.threadId ?? 'thread-1',
        agent: input.agent ?? 'writer',
        iteration: 1,
        actorKey: input.actorKey ?? input.agent ?? 'writer',
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        messages: ONE_USER_TURN,
        estimatedTokens: 500,
        signal: new AbortController().signal,
        api: input.api,
        setTranscript: () => {
            input.calls.push('setTranscript');
        },
        edit: () => {
            input.calls.push('edit');
        },
        entries,
        setIncluded: (target, included) => {
            const index =
                typeof target === 'number'
                    ? target
                    : typeof target === 'string'
                        ? entries.findIndex((entry) => entry.messageId === target)
                        : target.index;

            input.calls.push(`setIncluded:${index}:${String(included)}`);

            // Flip the flag on the ENTRY the plan was built from, so a second pass over the
            // same list sees what the runtime would see after the write — the live view
            // idempotence rests on.
            const entry = entries[index] as { included?: boolean } | undefined;

            if (entry !== undefined) entry.included = included === true;
        },
        // The second axis (trimmer uplift T6). The real runtime writes this flag on the CANONICAL
        // MESSAGE — it has no unit cascade and no entry-level effective flag — so the fake flips
        // exactly the field `planWithheldThoughts` re-reads (`entry.message.reasoningIncluded`).
        // That is what makes the idempotence and re-derive assertions below honest: the plan sees
        // the write.
        setReasoningIncluded: (target, included) => {
            const index =
                typeof target === 'number'
                    ? target
                    : typeof target === 'string'
                        ? entries.findIndex((entry) => entry.messageId === target)
                        : target.index;

            input.calls.push(`setReasoningIncluded:${index}:${String(included)}`);

            const entry = entries[index];

            if (entry !== undefined) {
                const message = entry.message as { reasoningIncluded?: boolean };

                // Only `false` is storage, mirroring the real control's exact inverse.
                if (included === true) delete message.reasoningIncluded;
                else message.reasoningIncluded = false;
            }
        },
        currentMessages: () => ONE_USER_TURN,
        currentEstimatedTokens: () => 500,
        replaceHistory: () => {
            input.calls.push('replaceHistory');
        },
        pause: async () => {
            input.calls.push('pause');
        },
        resume: async () => {
            input.calls.push('resume');
        }
    };

    // A skipped turn must not pay for the canonical list at all. `entries` is a plain data
    // property above (every ordinary test needs the real list), so a guard test re-defines it
    // as a THROWING getter — a conditional object literal could not, because spreading an
    // object with a getter evaluates it at construction time.
    if (input.guardEntries === true) {
        Object.defineProperty(context, 'entries', {
            get(): never {
                throw new Error('entries must not be read on a skipped turn.');
            }
        });
    }

    return context;
};

// THE STALE-SNAPSHOT SIMULATOR — the writer's own race window (the 2026-11-13 review).
//
// The plan reads `context.entries` THREE times (src/plugins/context-trimmer.plugin.ts `planOf`:
// the whole-unit walk, the truncate walk, the thinking walk) and the writer reads it a FOURTH time,
// after the handler's `await context.pause()` (src/plugins/context-trimmer.plugin.ts
// `createContextTrimmerHandler`). A mid-round `replaceHistory()` lands in exactly that gap, and it
// REPLACES the message list — so the stale side is a different list, not a mutated one, which is
// what makes re-locating an entry by INDEX observable instead of accidental.
//
// `strictReasoning` replaces the thinking control with the real runtime's role refusal
// (src/harness.ts `setReasoningIncluded` THROWS on a non-assistant target: "only an assistant entry
// carries reasoning"), so a thinking write that lands on the wrong turn FAILS the test loudly
// rather than being recorded as an innocent call.
//
// The `reads()` counter is asserted by both tests that use this helper: it pins that the plan really
// saw `planned` (three reads) and the writer really saw `stale` (the fourth), so neither test can
// pass by running both halves against the same list.
const withStaleEntries = (
    base: HarnessTurnBeforeContext,
    planned: HarnessContextEntry[],
    stale: HarnessContextEntry[],
    strictReasoning?: { calls: string[] }
): { context: HarnessTurnBeforeContext; reads: () => number } => {
    let reads = 0;

    const context: HarnessTurnBeforeContext = {
        ...base,
        ...(strictReasoning === undefined
            ? {}
            : {
                  setReasoningIncluded: (target: HarnessContextEntry | number | string, included: unknown): void => {
                      const entry =
                          typeof target === 'number'
                              ? stale.find((lookedUp) => lookedUp.index === target)
                              : typeof target === 'string'
                                ? stale.find((lookedUp) => lookedUp.messageId === target)
                                : target;

                      if (entry.message.role !== 'assistant') {
                          throw new Error(
                              `setReasoningIncluded landed on a ${entry.message.role} message (index ${entry.index}).`
                          );
                      }

                      strictReasoning.calls.push(`setReasoningIncluded:${entry.index}:${String(included)}`);
                      // Only `false` is storage, exactly like the shipped control.
                      (entry.message as { reasoningIncluded?: boolean }).reasoningIncluded = false;
                  }
              })
    };

    Object.defineProperty(context, 'entries', {
        get: (): HarnessContextEntry[] => {
            reads += 1;

            return reads <= 3 ? planned : stale;
        }
    });

    return { context, reads: () => reads };
};

// ---------------------------------------------------------------------------
// A1 — the rule, as a pure plan
// ---------------------------------------------------------------------------

describe('context-trimmer plan (planTrimmedUnits)', () => {
    it('A1: withholds the failed unit a later success of the same tool name answered', () => {
        // The exact candidate, including the durable addresses of BOTH halves of the pair.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({}))).toEqual([TRIMMABLE_CANDIDATE]);
    });

    it('A1: a `rejected` call is as superseded as a `failed` one', () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"path":"a.ts"}'),
            result('c1', 'read', 'Tool "read" is not available.', 'rejected'),
            call('c2', 'read', '{"path":"b.ts"}'),
            result('c2', 'read', 'export const b = 2;')
        ];

        expect(planTrimmedUnits(entriesFrom(messages), settingsWith({}))).toEqual([
            { ...TRIMMABLE_CANDIDATE, outcomes: ['rejected'], invalidOutcomes: ['rejected'] }
        ]);
    });

    it('A1: argument equality is NOT required — the deliberate loosening', () => {
        // The retry read a DIFFERENT file. `resolvesPrunedFailure` (the shipped compaction
        // rule) would keep this failure because its fingerprint differs; the trimmer's rule is
        // the tool NAME, so the superseded pair leaves the context.
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"path":"a.ts"}'),
            result('c1', 'read', 'boom', 'failed'),
            call('c2', 'read', '{"path":"an-entirely-different-file.ts"}'),
            result('c2', 'read', 'contents')
        ];

        expect(planTrimmedUnits(entriesFrom(messages), settingsWith({}))).toEqual([TRIMMABLE_CANDIDATE]);
    });

    it('A2: keeps every shape that has no included later answer', () => {
        const cases: Array<{ kept: string; messages: HarnessMessage[]; excluded?: readonly number[] }> = [
            {
                // Nothing answered it: the failure IS the newest fact.
                kept: 'no later answer',
                messages: [
                    call('c1', 'read', '{"p":1}'),
                    result('c1', 'read', 'boom', 'failed'),
                    { role: 'assistant', content: 'gives up' }
                ]
            },
            {
                // A success of a DIFFERENT tool does not answer this one (A2).
                kept: 'later success of another tool',
                messages: [
                    call('c1', 'read', '{"p":1}'),
                    result('c1', 'read', 'boom', 'failed'),
                    call('c2', 'write', '{"p":1}'),
                    result('c2', 'write', 'ok')
                ]
            },
            {
                // The answering unit is itself withheld, so the model would see NEITHER half.
                kept: 'excluded resolver unit',
                messages: [
                    call('c1', 'read', '{"p":1}'),
                    result('c1', 'read', 'boom', 'failed'),
                    call('c2', 'read', '{"p":1}'),
                    result('c2', 'read', 'ok')
                ],
                excluded: [2, 3]
            },
            {
                // A later `failed`/`rejected` of the same name is not an answer.
                kept: 'later failure of the same tool',
                messages: [
                    call('c1', 'read', '{"p":1}'),
                    result('c1', 'read', 'boom', 'failed'),
                    call('c2', 'read', '{"p":1}'),
                    result('c2', 'read', 'still broken', 'failed')
                ]
            },
            {
                // A `cancelled` answer is a choice the agent made, never superseded garbage.
                kept: 'cancelled answer only',
                messages: [
                    call('c1', 'read', '{"p":1}'),
                    result('c1', 'read', 'boom', 'failed'),
                    call('c2', 'read', '{"p":1}'),
                    result('c2', 'read', 'stopped', 'cancelled')
                ]
            },
            {
                // A block with no committed result may still be awaited (core rule 3).
                kept: 'unanswered block',
                messages: [
                    call('c1', 'read', '{"p":1}'),
                    call('c2', 'read', '{"p":1}'),
                    result('c2', 'read', 'ok')
                ]
            }
        ];

        for (const entry of cases) {
            // The case name travels INSIDE the compared object, so a failure says which keep
            // broke rather than just "expected [] got [something]".
            expect({
                kept: entry.kept,
                plan: planTrimmedUnits(entriesFrom(entry.messages, entry.excluded ?? []))
            }).toEqual({ kept: entry.kept, plan: [] });
        }
    });

    it('A2: an already-excluded candidate is skipped, so a re-run proposes nothing', () => {
        // The whole failed unit withheld (leader AND result — what a whole-unit trim, or compaction,
        // leaves behind, since R8 makes the flag per entry). NOTHING of the unit is being sent, so the
        // write set is empty and the idempotence skip fires.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE, [1, 2]), settingsWith({}))).toEqual([]);
    });

    it('A2: finishes a unit whose REQUEST an earlier pass already withheld, per rule', () => {
        // THE DEFECT THIS PINS (T10). `truncateToolRequests` writes ONE entry — the assistant REQUEST
        // — so the unit's failed RESULT is still being sent while `unit.included` (the conjunction
        // over every member) reads false. Testing candidacy at that unit-level flag made such a unit
        // invisible to the invalid, superseded and duplicate rules FOREVER, and with both horizons at
        // their declared 2 the two axes sit on the SAME horizon: whichever one fired first kept the
        // junk result riding in every later request, which is exactly what "invalid tools more than 2
        // tool turns ago are trimmed" promises not to do.
        const requestGone = entriesFrom(TRIMMABLE, [1]);

        // The RESULT (2) is the only member left to write; the leader (1) is named as the unit's
        // identity and never re-enabled.
        const SURVIVING_RESULT = {
            index: 1,
            members: [2],
            outcomes: ['failed'],
            invalidOutcomes: ['failed'],
            names: ['read'],
            resolverIndex: 3
        };

        // Rule 1, `dropSupersededToolCalls`, on its own.
        expect(
            planShape(planTrimmedUnits(requestGone, settingsWith({ trimInvalidTools: false })))
        ).toEqual([{ ...SURVIVING_RESULT, firedBy: 'dropSupersededToolCalls', admittedBy: ['dropSupersededToolCalls'] }]);

        // Rule 2, `trimInvalidTools`, on its own — the switch the operator-facing promise names.
        expect(
            planShape(planTrimmedUnits(requestGone, settingsWith({ dropSupersededToolCalls: false })))
        ).toEqual([{ ...SURVIVING_RESULT, firedBy: 'trimInvalidTools', admittedBy: ['trimInvalidTools'] }]);

        // Rule 3, `dropDuplicateCalls`, on its own, and fingerprint-matched whatever `supersedeMatch`
        // says (the fixture is a retry of the EXACT work, so the stricter matcher still matches).
        expect(
            planShape(
                planTrimmedUnits(
                    entriesFrom(SAME_ARGS, [1]),
                    settingsWith({
                        dropSupersededToolCalls: false,
                        trimInvalidTools: false,
                        dropDuplicateCalls: true
                    })
                )
            )
        ).toEqual([{ ...SURVIVING_RESULT, firedBy: 'dropDuplicateCalls', admittedBy: ['dropDuplicateCalls'] }]);

        // (b) THE SECOND PASS WRITES NOTHING. Applying the write set above leaves every member of the
        // unit withheld, which is the state the skip is about: no candidate, so no flag, no
        // notification, no save and no diagnostic.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE, [1, 2]), settingsWith({}))).toEqual([]);

        // THE MIRROR HALF STATE (a host switched one RESULT off, or a pass stopped midway) is completed
        // the same way rather than skipped: the request is what is still being sent, and the next pass
        // finishes the unit. Nothing is ever re-enabled on the way.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE, [2]), settingsWith({}))).toEqual([
            { ...TRIMMABLE_CANDIDATE, members: [1] }
        ]);
    });

    it('A2: a standalone message and an orphan result are never candidates', () => {
        expect(planTrimmedUnits(entriesFrom([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'hi' }]))).toEqual([]);

        // An orphan result (its block is gone) answers nothing and owns no work of its own.
        expect(
            planTrimmedUnits(
                entriesFrom([
                    result('cX', 'read', 'boom', 'failed'),
                    call('c2', 'read', '{}'),
                    result('c2', 'read', 'ok')
                ])
            )
        ).toEqual([]);
    });

    it('A3: withholds EVERY superseded attempt, oldest first, and keeps a later failure', () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"p":1}'),
            result('c1', 'read', 'boom', 'failed'),
            call('c2', 'read', '{"p":1}'),
            result('c2', 'read', 'nope', 'rejected'),
            call('c3', 'read', '{"p":1}'),
            result('c3', 'read', 'finally'),
            // A NEW failure after the answer: the newest fact in the window, never trimmed.
            call('c4', 'read', '{"p":2}'),
            result('c4', 'read', 'broke again', 'failed'),
            { role: 'assistant', content: 'done' }
        ];

        expect(
            planTrimmedUnits(entriesFrom(messages), settingsWith({})).map((candidate) => ({
                leaderIndex: candidate.leaderIndex,
                members: candidate.members,
                outcomes: candidate.outcomes,
                resolverIndex: candidate.resolverIndex
            }))
        ).toEqual([
            { leaderIndex: 1, members: [1, 2], outcomes: ['failed'], resolverIndex: 5 },
            { leaderIndex: 3, members: [3, 4], outcomes: ['rejected'], resolverIndex: 5 }
        ]);
    });

    it('A4: a unit is all-or-nothing — a partly answered block is kept whole', () => {
        const mixed: HarnessMessage[] = [
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'c1', name: 'read', arguments: '{"p":1}' },
                    { id: 'c2', name: 'write', arguments: '{"p":1}' }
                ]
            },
            result('c1', 'read', 'boom', 'failed'),
            result('c2', 'write', 'refused', 'rejected'),
            // Only `read` is answered later, so the block cannot go without losing `write`.
            call('c3', 'read', '{"p":1}'),
            result('c3', 'read', 'ok')
        ];

        expect(planTrimmedUnits(entriesFrom(mixed), settingsWith({}))).toEqual([]);

        // Both names answered by one later unit -> the SAME fixture now trims, so the keep
        // above is provably the rule and not an accident of the builder. The two names are
        // answered by DIFFERENT units (msg-4 answers `read`, msg-6 answers `write`), which the
        // per-name rule accepts; the report names the EARLIEST answering unit.
        expect(
            planTrimmedUnits(
                entriesFrom([
                    ...mixed,
                    call('c4', 'write', '{"p":1}'),
                    result('c4', 'write', 'ok')
                ])
            ).map((candidate) => ({
                leaderIndex: candidate.leaderIndex,
                names: candidate.names,
                outcomes: candidate.outcomes,
                resolverMessageId: candidate.resolverMessageId
            }))
        ).toEqual([
            {
                leaderIndex: 0,
                names: ['read', 'write'],
                outcomes: ['failed', 'rejected'],
                resolverMessageId: 'msg-4'
            }
        ]);
    });

    it('A4: a block mixing a healthy and a failed answer is never a candidate', () => {
        expect(
            planTrimmedUnits(
                entriesFrom([
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            { id: 'c1', name: 'read', arguments: '{"p":1}' },
                            { id: 'c2', name: 'read', arguments: '{"p":2}' }
                        ]
                    },
                    result('c1', 'read', 'boom', 'failed'),
                    result('c2', 'read', 'ok'),
                    call('c3', 'read', '{"p":1}'),
                    result('c3', 'read', 'answered')
                ])
            )
        ).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T4 — the generalised "invalid" set, the two matchers, and the duplicate rule
// ---------------------------------------------------------------------------

// A multi-call assistant block, so the fixtures below stay one line per call.
const blockOf = (requested: Array<{ id: string; name: string; args: string }>): HarnessMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: requested.map((entry) => ({ id: entry.id, name: entry.name, arguments: entry.args }))
});

// The readable form of a plan: the fields a table case is actually about, one object per withheld
// unit, so a failure names the unit, its outcomes AND the switch that produced it.
const planShape = (plan: readonly TrimCandidate[]) =>
    plan.map((candidate) => ({
        index: candidate.leaderIndex,
        members: candidate.members,
        outcomes: candidate.outcomes,
        invalidOutcomes: candidate.invalidOutcomes,
        names: candidate.names,
        firedBy: candidate.firedBy,
        admittedBy: candidate.admittedBy,
        resolverIndex: candidate.resolverIndex
    }));

// A settings object with ONE switch moved off the declared default. Spelling the baseline out per
// case is what keeps "everything else is at its default" part of the fixture: a new switch lands in
// `TRIMMER_DEFAULT_SETTINGS` and every case below inherits its default, so a case can never be
// passing because of a switch it never meant to turn on.
//
// THE HORIZONS ARE ZEROED HERE, ON PURPOSE. Every table in this file that asks WHICH unit a rule
// picks runs against a two- or three-tool-turn fixture, and a default horizon of 2 protects the two
// newest turns — so the predicate tables would all be empty and would prove nothing. `0` is the
// documented "protect nothing" value, which leaves each table testing exactly the rule it names. The
// horizon itself is pinned by its own tables (`the horizon windows each tool rule...`), which set
// their own values and are the only place the declared 2 is asserted, and by the defaults tables
// that use `TRIMMER_DEFAULT_SETTINGS` directly.
const settingsWith = (overrides: Partial<TrimmerSettings>): TrimmerSettings => ({
    ...TRIMMER_DEFAULT_SETTINGS,
    invalidToolTurns: 0,
    supersededTurns: 0,
    duplicateTurns: 0,
    truncateTurns: 0,
    thoughtTurns: 0,
    ...overrides
});

// The fixtures the T4 tables run over. Each one is the SAME shape — a first unit, then a later
// `completed` answer of the same tool with different arguments — differing ONLY in the outcome of
// the first unit's result, which is the whole variable.
const unitThenAnswer = (firstResult: HarnessMessage): HarnessMessage[] => [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"p":1}'),
    firstResult,
    // The answer: same NAME, different arguments, so only a name-only matcher would call it an
    // answer to the call above. `supersedeMatch` and `dropDuplicateCalls` are pinned separately.
    call('c2', 'read', '{"p":2}'),
    result('c2', 'read', 'contents'),
    { role: 'assistant', content: 'done' }
];

// A block that answers one call with `outcome` and the other with a HEALTHY `contents`, both names
// answered later, so the only reason a pass could keep it is the mix itself.
const mixedUnit = (firstResult: HarnessMessage): HarnessMessage[] => [
    { role: 'user', content: 'go' },
    blockOf([
        { id: 'c1', name: 'read', args: '{"p":1}' },
        { id: 'c2', name: 'write', args: '{"q":1}' }
    ]),
    firstResult,
    result('c2', 'write', 'written'),
    call('c3', 'read', '{"p":2}'),
    result('c3', 'read', 'contents'),
    call('c4', 'write', '{"q":2}'),
    result('c4', 'write', 'written again'),
    { role: 'assistant', content: 'done' }
];

// The same block with the healthy answer REPLACED by an invalid one: the control that proves the
// keeps above are the mix and not the fixture.
const invalidPair = (firstResult: HarnessMessage, secondResult: HarnessMessage): HarnessMessage[] => [
    { role: 'user', content: 'go' },
    blockOf([
        { id: 'c1', name: 'read', args: '{"p":1}' },
        { id: 'c2', name: 'write', args: '{"q":1}' }
    ]),
    firstResult,
    secondResult,
    call('c3', 'read', '{"p":2}'),
    result('c3', 'read', 'contents'),
    call('c4', 'write', '{"q":2}'),
    result('c4', 'write', 'written again'),
    { role: 'assistant', content: 'done' }
];

// A block with one `failed` answer and one call that has NO result at all, both names answered
// later — so the only thing keeping it is the outstanding call (core's rule 3).
const UNANSWERED: HarnessMessage[] = [
    { role: 'user', content: 'go' },
    blockOf([
        { id: 'c1', name: 'read', args: '{"p":1}' },
        { id: 'c2', name: 'write', args: '{"q":1}' }
    ]),
    result('c1', 'read', 'boom', 'failed'),
    call('c3', 'read', '{"p":2}'),
    result('c3', 'read', 'contents'),
    call('c4', 'write', '{"q":2}'),
    result('c4', 'write', 'written again'),
    { role: 'assistant', content: 'done' }
];

describe('context-trimmer plan — invalidOutcomes (T4)', () => {
    // One table, one row per outcome value and per mix, each naming the switch combination that is
    // supposed to fire. `dropSupersededToolCalls: false` throughout: with the shipped switch on,
    // every `failed`/`rejected` row would be admitted by it and the row would say nothing about
    // `invalidOutcomes`.
    it('judges a unit by the EFFECTIVE outcome of each committed result, per outcome value', () => {
        const cases: Array<{ case: string; messages: HarnessMessage[]; settings: Partial<TrimmerSettings>; plan: unknown }> = [
            // ---- failed / rejected: the shipped rule's own values.
            {
                case: "set 'failed' admits a `failed` unit",
                messages: unitThenAnswer(result('c1', 'read', 'boom', 'failed')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['failed'] },
                plan: [
                    {
                        index: 1,
                        members: [1, 2],
                        outcomes: ['failed'],
                        invalidOutcomes: ['failed'],
                        names: ['read'],
                        firedBy: 'trimInvalidTools',
                        admittedBy: ['trimInvalidTools'],
                        resolverIndex: 3
                    }
                ]
            },
            {
                case: "set 'failed' keeps a `rejected` unit",
                messages: unitThenAnswer(result('c1', 'read', 'refused', 'rejected')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['failed'] },
                plan: []
            },
            {
                case: "set 'rejected' admits a `rejected` unit",
                messages: unitThenAnswer(result('c1', 'read', 'refused', 'rejected')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['rejected'] },
                plan: [
                    {
                        index: 1,
                        members: [1, 2],
                        outcomes: ['rejected'],
                        invalidOutcomes: ['rejected'],
                        names: ['read'],
                        firedBy: 'trimInvalidTools',
                        admittedBy: ['trimInvalidTools'],
                        resolverIndex: 3
                    }
                ]
            },
            {
                case: 'the default set is the shipped rule over again, and says both admit it',
                messages: unitThenAnswer(result('c1', 'read', 'boom', 'failed')),
                settings: { dropSupersededToolCalls: false },
                plan: [
                    {
                        index: 1,
                        members: [1, 2],
                        outcomes: ['failed'],
                        invalidOutcomes: ['failed'],
                        names: ['read'],
                        firedBy: 'trimInvalidTools',
                        // The whole default set is named, so the generalisation and the shipped
                        // classifier agree on this unit — the equivalence the header claims.
                        admittedBy: ['trimInvalidTools'],
                        resolverIndex: 3
                    }
                ]
            },
            // ---- cancelled: opt-in, and read from the outcome key only.
            {
                case: "set 'cancelled' admits an all-`cancelled` unit the shipped classifier files as `mixed`",
                messages: unitThenAnswer(result('c1', 'read', 'stopped', 'cancelled')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['cancelled'] },
                plan: [
                    {
                        index: 1,
                        members: [1, 2],
                        // The transcript RECORDS `cancelled` and the pass JUDGED `cancelled`: the
                        // two lists separate only for `empty`.
                        outcomes: ['cancelled'],
                        invalidOutcomes: ['cancelled'],
                        names: ['read'],
                        firedBy: 'trimInvalidTools',
                        admittedBy: ['trimInvalidTools'],
                        resolverIndex: 3
                    }
                ]
            },
            {
                case: "set 'cancelled' keeps a unit mixing `cancelled` with a healthy answer",
                messages: mixedUnit(result('c1', 'read', 'stopped', 'cancelled')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['cancelled'] },
                plan: []
            },
            {
                case: "set 'cancelled' keeps a `cancelled`+`failed` unit: only one of the two is named",
                messages: invalidPair(
                    result('c1', 'read', 'stopped', 'cancelled'),
                    result('c2', 'write', 'boom', 'failed')
                ),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['cancelled'] },
                plan: []
            },
            {
                case: "set 'failed,cancelled' admits that same `cancelled`+`failed` unit",
                messages: invalidPair(
                    result('c1', 'read', 'stopped', 'cancelled'),
                    result('c2', 'write', 'boom', 'failed')
                ),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['failed', 'cancelled'] },
                plan: [
                    {
                        index: 1,
                        // The WHOLE unit leaves — granularity is untouched by the generalisation:
                        // the cancelled call goes with the failed one, cascade and all.
                        members: [1, 2, 3],
                        outcomes: ['cancelled', 'failed'],
                        invalidOutcomes: ['cancelled', 'failed'],
                        names: ['read', 'write'],
                        firedBy: 'trimInvalidTools',
                        admittedBy: ['trimInvalidTools'],
                        // Both names are answered by DIFFERENT later units (c3 answers `read` at 4,
                        // c4 answers `write` at 6); the line names the earliest.
                        resolverIndex: 4
                    }
                ]
            },
            {
                case: "set 'cancelled' keeps a `failed` unit (opting into cancelled does not reach failed)",
                messages: unitThenAnswer(result('c1', 'read', 'boom', 'failed')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['cancelled'] },
                plan: []
            },
            // ---- empty: the only value read off the text, and never off a cancelled result.
            {
                case: "set 'empty' admits a unit whose `completed` answers are blank",
                messages: unitThenAnswer(result('c1', 'read', '   ')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['empty'] },
                plan: [
                    {
                        index: 1,
                        members: [1, 2],
                        // The distinction the descriptor warns about, made visible: the result
                        // RECORDS `completed` (that is what a blank answer is) and the pass judged
                        // `empty`.
                        outcomes: ['completed'],
                        invalidOutcomes: ['empty'],
                        names: ['read'],
                        firedBy: 'trimInvalidTools',
                        admittedBy: ['trimInvalidTools'],
                        resolverIndex: 3
                    }
                ]
            },
            {
                case: "set 'empty' keeps a unit mixing a blank answer with a healthy one",
                messages: mixedUnit(result('c1', 'read', '')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['empty'] },
                plan: []
            },
            {
                case: "set 'empty' does NOT read a `cancelled` result's blank content",
                messages: unitThenAnswer(result('c1', 'read', '', 'cancelled')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['empty'] },
                plan: []
            },
            {
                case: "set 'empty' does NOT read a `failed` result's blank content either",
                messages: unitThenAnswer(result('c1', 'read', '', 'failed')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: ['empty'] },
                plan: []
            },
            {
                case: 'a set naming all four still keeps the unit with one real completed answer',
                messages: mixedUnit(result('c1', 'read', 'stopped', 'cancelled')),
                settings: {
                    dropSupersededToolCalls: false,
                    invalidOutcomes: ['failed', 'rejected', 'cancelled', 'empty']
                },
                plan: []
            },
            {
                case: "set 'failed,rejected,cancelled,empty' admits `cancelled`+blank-`completed` together",
                messages: invalidPair(
                    result('c1', 'read', 'stopped', 'cancelled'),
                    result('c2', 'write', '   ')
                ),
                settings: {
                    dropSupersededToolCalls: false,
                    invalidOutcomes: ['failed', 'rejected', 'cancelled', 'empty']
                },
                plan: [
                    {
                        index: 1,
                        members: [1, 2, 3],
                        outcomes: ['cancelled', 'completed'],
                        invalidOutcomes: ['cancelled', 'empty'],
                        names: ['read', 'write'],
                        firedBy: 'trimInvalidTools',
                        admittedBy: ['trimInvalidTools'],
                        resolverIndex: 4
                    }
                ]
            },
            // ---- unknown names, and an empty set: the generalisation is off, not narrowed.
            {
                case: 'unknown names leave nothing behind',
                messages: unitThenAnswer(result('c1', 'read', 'boom', 'failed')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: [] },
                plan: []
            },
            {
                case: '`completed` is not a name the setting can use',
                messages: unitThenAnswer(result('c1', 'read', 'contents')),
                settings: { dropSupersededToolCalls: false, invalidOutcomes: [] },
                plan: []
            }
        ];

        for (const entry of cases) {
            expect({
                case: entry.case,
                plan: planShape(planTrimmedUnits(entriesFrom(entry.messages), settingsWith(entry.settings)))
            }).toEqual({ case: entry.case, plan: entry.plan });
        }
    });

    it('keeps a MIXED unit and an UNANSWERED unit under EVERY combination of the tool switches', () => {
        // The exhaustive check F2 asks for: `mixed` and `unanswered` are structural keeps, not
        // accidents of one setting. Every tool switch in both positions, the closed set in seven
        // spellings (nothing, each single name, and the combinations that matter), both matchers,
        // the duplicate rule in both positions: 112 runs per shape, all of them a pure function.
        const outcomeSets: Array<readonly TrimmerInvalidOutcome[]> = [
            [],
            ['failed'],
            ['rejected'],
            ['cancelled'],
            ['empty'],
            ['failed', 'rejected'],
            ['failed', 'rejected', 'cancelled', 'empty']
        ];

        // A `failed` result for the mixed block, and a blank `completed` one, so both generalised
        // names are exercised against a healthy partner — the shape that must never leave.
        const shapes = [
            { shape: 'mixed failed + completed', messages: mixedUnit(result('c1', 'read', 'boom', 'failed')) },
            { shape: 'mixed cancelled + completed', messages: mixedUnit(result('c1', 'read', 'stopped', 'cancelled')) },
            { shape: 'mixed empty + completed', messages: mixedUnit(result('c1', 'read', '')) },
            { shape: 'unanswered + failed', messages: UNANSWERED }
        ];

        for (const shape of shapes) {
            for (const dropSupersededToolCalls of [true, false]) {
                for (const trimInvalidTools of [true, false]) {
                    for (const invalidOutcomes of outcomeSets) {
                        for (const supersedeMatch of ['name', 'fingerprint'] as const) {
                            for (const dropDuplicateCalls of [true, false]) {
                                // `entriesFrom` rebuilds the entries every run: `setIncluded` is not
                                // involved in a pure plan, and a fresh list keeps the runs independent.
                                const plan = planTrimmedUnits(
                                    entriesFrom(shape.messages),
                                    settingsWith({
                                        dropSupersededToolCalls,
                                        trimInvalidTools,
                                        invalidOutcomes,
                                        supersedeMatch,
                                        dropDuplicateCalls
                                    })
                                );

                                expect({ shape: shape.shape, supersedeMatch, dropDuplicateCalls, invalidOutcomes: invalidOutcomes.join(','), plan }).toEqual({
                                    shape: shape.shape,
                                    supersedeMatch,
                                    dropDuplicateCalls,
                                    invalidOutcomes: invalidOutcomes.join(','),
                                    plan: []
                                });
                            }
                        }
                    }
                }
            }
        }
    });

    it('is the shipped rule byte-for-byte at the declared defaults, mixed and unanswered shapes included', () => {
        // The zero-regression half of the same table: at the DEFAULT settings the new shapes are
        // keeps for the same reasons they always were, and the one shape the shipped rule did trim
        // still trims with the same candidate it produced before T4.
        expect(planShape(planTrimmedUnits(entriesFrom(mixedUnit(result('c1', 'read', 'boom', 'failed')))))).toEqual([]);
        expect(planShape(planTrimmedUnits(entriesFrom(UNANSWERED), settingsWith({})))).toEqual([]);
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({}))).toEqual([TRIMMABLE_CANDIDATE]);
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({}))).toEqual([TRIMMABLE_CANDIDATE]);
    });

    it('answers every name in possibly different units, and withholds the whole mixed-name unit', () => {
        // Both names of an all-invalid block are answered, by TWO different later units — the rule
        // is per name, so the block goes, and it goes whole.
        const messages = invalidPair(
            result('c1', 'read', 'boom', 'failed'),
            result('c2', 'write', 'refused', 'rejected')
        );

        expect(planShape(planTrimmedUnits(entriesFrom(messages), settingsWith({ dropSupersededToolCalls: false })))).toEqual([
            {
                index: 1,
                members: [1, 2, 3],
                outcomes: ['failed', 'rejected'],
                invalidOutcomes: ['failed', 'rejected'],
                names: ['read', 'write'],
                firedBy: 'trimInvalidTools',
                admittedBy: ['trimInvalidTools'],
                resolverIndex: 4
            }
        ]);

        // One name answered, the other not: the whole unit stays (all-or-nothing granularity).
        const partlyAnswered: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            blockOf([
                { id: 'c1', name: 'read', args: '{"p":1}' },
                { id: 'c2', name: 'write', args: '{"q":1}' }
            ]),
            result('c1', 'read', 'boom', 'failed'),
            result('c2', 'write', 'refused', 'rejected'),
            call('c3', 'read', '{"p":2}'),
            result('c3', 'read', 'contents')
        ];

        expect(planShape(planTrimmedUnits(entriesFrom(partlyAnswered), settingsWith({})))).toEqual([]);
    });
});

// The two candidate fixtures the matcher and economy tables share. `supersedeMatch` is the ONLY
// difference between the first two: same tool name, different arguments vs the same arguments.
const DIFFERENT_ARGS: HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'boom', 'failed'),
    call('c2', 'read', '{"path":"b.ts"}'),
    result('c2', 'read', 'contents'),
    { role: 'assistant', content: 'done' }
];

const SAME_ARGS: HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'boom', 'failed'),
    // A retry of the EXACT work: a new call id (the runtime forbids reusing one), the same
    // arguments. `toolCallFingerprint` ignores the id, so this is the same work.
    call('c2', 'read', '{"path":"a.ts"}'),
    result('c2', 'read', 'contents'),
    { role: 'assistant', content: 'done' }
];

// The one candidate the two fixtures above produce, as the readable shape (see `planShape`).
const CANDIDATE_SHAPE = {
    index: 1,
    members: [1, 2],
    outcomes: ['failed'],
    invalidOutcomes: ['failed'],
    names: ['read'],
    firedBy: 'dropSupersededToolCalls',
    admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools'],
    resolverIndex: 3
};

// A superseded SUCCESS: the model read `contents`, then re-ran the exact same call and got the same
// thing again. F2's largest class, and the only one `dropDuplicateCalls` can reach.
const DUPLICATE_SUCCESS: HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'contents'),
    call('c2', 'read', '{"path":"a.ts"}'),
    result('c2', 'read', 'contents'),
    { role: 'assistant', content: 'done' }
];

describe('context-trimmer plan — supersedeMatch (T4)', () => {
    it("'name' fires where 'fingerprint' does not, and both fire on the exact same work", () => {
        // Same tool name, DIFFERENT arguments: the shipped loosening answers it, the exact matcher
        // does not. Everything else about the two runs is identical, so the matcher is the only
        // variable — this is the case the whole switch exists for.
        expect(
            planShape(planTrimmedUnits(entriesFrom(DIFFERENT_ARGS), settingsWith({ supersedeMatch: 'name' })))
        ).toEqual([CANDIDATE_SHAPE]);

        expect(
            planShape(planTrimmedUnits(entriesFrom(DIFFERENT_ARGS), settingsWith({ supersedeMatch: 'fingerprint' })))
        ).toEqual([]);

        // The same work re-run: BOTH matchers answer it, with the same candidate, so
        // `supersedeMatch: 'fingerprint'` makes this pass agree with compaction's rather than
        // merely being a stricter cousin of it.
        expect(
            planShape(planTrimmedUnits(entriesFrom(SAME_ARGS), settingsWith({ supersedeMatch: 'name' })))
        ).toEqual([CANDIDATE_SHAPE]);

        expect(
            planShape(planTrimmedUnits(entriesFrom(SAME_ARGS), settingsWith({ supersedeMatch: 'fingerprint' })))
        ).toEqual([CANDIDATE_SHAPE]);
    });

    it("'fingerprint' compares canonical arguments, not the raw text", () => {
        // Two spellings of one argument object. The fingerprint helper sorts the keys and drops the
        // whitespace (../core/argument-fingerprint.ts:138), so this IS the same work and the strict
        // matcher must say so — a raw string comparison would have kept the unit.
        const reordered: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"offset":10,"path":"a.ts"}'),
            result('c1', 'read', 'boom', 'failed'),
            call('c2', 'read', '{ "path" : "a.ts" , "offset" : 10 }'),
            result('c2', 'read', 'contents'),
            { role: 'assistant', content: 'done' }
        ];

        expect(
            planShape(planTrimmedUnits(entriesFrom(reordered), settingsWith({ supersedeMatch: 'fingerprint' })))
        ).toEqual([CANDIDATE_SHAPE]);

        // One key added is different WORK, whatever the matcher: the answer did not re-run the call.
        const oneKeyMore: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"path":"a.ts"}'),
            result('c1', 'read', 'boom', 'failed'),
            call('c2', 'read', '{"path":"a.ts","offset":10}'),
            result('c2', 'read', 'contents'),
            { role: 'assistant', content: 'done' }
        ];

        expect(
            planShape(planTrimmedUnits(entriesFrom(oneKeyMore), settingsWith({ supersedeMatch: 'fingerprint' })))
        ).toEqual([]);
    });

    it('is all-or-nothing per CALL under the fingerprint matcher', () => {
        // A two-call block where BOTH names were retried successfully (so `'name'` answers the
        // block) but only ONE call's exact work was re-run. The fingerprint matcher demands every
        // call, so the block stays — granularity does not loosen with the matcher.
        const block: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            blockOf([
                { id: 'c1', name: 'read', args: '{"p":1}' },
                { id: 'c2', name: 'write', args: '{"q":1}' }
            ]),
            result('c1', 'read', 'boom', 'failed'),
            result('c2', 'write', 'refused', 'rejected'),
            call('c3', 'read', '{"p":1}'),
            result('c3', 'read', 'contents'),
            // `write` retried, but on a different file: same name, different work.
            call('c4', 'write', '{"q":2}'),
            result('c4', 'write', 'written'),
            { role: 'assistant', content: 'done' }
        ];

        expect(planShape(planTrimmedUnits(entriesFrom(block), settingsWith({ supersedeMatch: 'name' })))).toEqual([
            {
                index: 1,
                members: [1, 2, 3],
                outcomes: ['failed', 'rejected'],
                invalidOutcomes: ['failed', 'rejected'],
                names: ['read', 'write'],
                firedBy: 'dropSupersededToolCalls',
                admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools'],
                resolverIndex: 4
            }
        ]);

        expect(
            planShape(planTrimmedUnits(entriesFrom(block), settingsWith({ supersedeMatch: 'fingerprint' })))
        ).toEqual([]);
    });

    it('a withheld resolver is not evidence under either matcher', () => {
        // The shipped guard, re-pinned for the fingerprint path: with the answering unit flagged off
        // the model would see neither the failure nor the answer, whatever the matcher matched on.
        expect(
            planShape(planTrimmedUnits(entriesFrom(SAME_ARGS, [3, 4]), settingsWith({ supersedeMatch: 'fingerprint' })))
        ).toEqual([]);
        expect(planShape(planTrimmedUnits(entriesFrom(SAME_ARGS, [3, 4]), settingsWith({})))).toEqual([]);
    });
});

describe('context-trimmer plan — dropDuplicateCalls (T4)', () => {
    it('withholds the earlier unit when a later one re-ran the same work and answered it', () => {
        // The duplicate is the ONLY switch here that reaches an all-`completed` unit: the shipped
        // classifier files it `answered`, and the generalisation cannot admit it either (a
        // `completed` result is in no set), so `firedBy` is the duplicate rule alone.
        expect(
            planShape(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ dropDuplicateCalls: true })))
        ).toEqual([
            {
                index: 1,
                members: [1, 2],
                outcomes: ['completed'],
                invalidOutcomes: ['completed'],
                names: ['read'],
                firedBy: 'dropDuplicateCalls',
                admittedBy: ['dropDuplicateCalls'],
                resolverIndex: 3
            }
        ]);

        // OFF (the default) is the shipped posture: a unit whose answer the model read and used
        // stays in the request.
        expect(planShape(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({})))).toEqual([]);
    });

    it('runs alone with both supersession switches off, and never on a name-only match', () => {
        const duplicateOnly = settingsWith({
            dropSupersededToolCalls: false,
            trimInvalidTools: false,
            dropDuplicateCalls: true
        });

        // H2's independence, third direction: the duplicate class fires with neither of the other
        // two tool switches on.
        expect(planShape(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), duplicateOnly))).toEqual([
            {
                index: 1,
                members: [1, 2],
                outcomes: ['completed'],
                invalidOutcomes: ['completed'],
                names: ['read'],
                firedBy: 'dropDuplicateCalls',
                admittedBy: ['dropDuplicateCalls'],
                resolverIndex: 3
            }
        ]);

        // ... and it does NOT fire when only the NAME matches, even with `supersedeMatch: 'name'`:
        // withholding work the model read on a name-only match is the failure mode the switch text
        // rules out, so the fingerprint is not configurable here.
        expect(planShape(planTrimmedUnits(entriesFrom(DIFFERENT_ARGS), duplicateOnly))).toEqual([]);
        expect(
            planShape(
                planTrimmedUnits(
                    entriesFrom(DIFFERENT_ARGS),
                    settingsWith({
                        dropSupersededToolCalls: false,
                        trimInvalidTools: false,
                        dropDuplicateCalls: true,
                        supersedeMatch: 'name'
                    })
                )
            )
        ).toEqual([]);
    });

    it('reaches a superseded failure too, and stays fingerprint-only whatever the matcher says', () => {
        // "Regardless of its own outcome": the same rule covers an all-`failed` unit. With both
        // supersession switches off it is the duplicate rule that withholds it, and it took the
        // EXACT re-run to do it.
        const duplicateOnly = settingsWith({
            dropSupersededToolCalls: false,
            trimInvalidTools: false,
            dropDuplicateCalls: true
        });

        expect(planShape(planTrimmedUnits(entriesFrom(SAME_ARGS), duplicateOnly))).toEqual([
            {
                index: 1,
                members: [1, 2],
                outcomes: ['failed'],
                invalidOutcomes: ['failed'],
                names: ['read'],
                firedBy: 'dropDuplicateCalls',
                admittedBy: ['dropDuplicateCalls'],
                resolverIndex: 3
            }
        ]);

        // With the matcher moved to the strict value as well, the SAME unit is now admitted by BOTH
        // the shipped rule and the duplicate rule — the duplicate pass never invents a second
        // candidate for a unit the primary rule already named.
        expect(
            planShape(
                planTrimmedUnits(
                    entriesFrom(SAME_ARGS),
                    settingsWith({ supersedeMatch: 'fingerprint', dropDuplicateCalls: true })
                )
            )
        ).toEqual([
            {
                ...CANDIDATE_SHAPE,
                admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools', 'dropDuplicateCalls']
            }
        ]);
    });

    it('keeps every duplicate shape that is not a healthy re-run of a fully answered unit', () => {
        const cases: Array<{ case: string; messages: HarnessMessage[]; excluded?: readonly number[] }> = [
            {
                // The re-run is the same work but its answer FAILED: the later unit is a candidate,
                // not a resolver, so nothing is redundant yet.
                kept: 'the re-run did not answer healthily',
                messages: [
                    { role: 'user', content: 'go' },
                    call('c1', 'read', '{"p":1}'),
                    result('c1', 'read', 'contents'),
                    call('c2', 'read', '{"p":1}'),
                    result('c2', 'read', 'boom', 'failed'),
                    { role: 'assistant', content: 'done' }
                ]
            },
            {
                // The later unit is itself withheld, so the model sees only the earlier answer —
                // the same resolver guard the primary rule obeys.
                kept: 'the re-run is already withheld',
                messages: DUPLICATE_SUCCESS,
                excluded: [3, 4]
            },
            {
                // An outstanding call: never touched, even with the duplicate rule on.
                kept: 'the earlier unit is unanswered',
                messages: [
                    { role: 'user', content: 'go' },
                    blockOf([
                        { id: 'c1', name: 'read', args: '{"p":1}' },
                        { id: 'c2', name: 'write', args: '{"q":1}' }
                    ]),
                    result('c1', 'read', 'contents'),
                    call('c3', 'read', '{"p":1}'),
                    result('c3', 'read', 'contents'),
                    { role: 'assistant', content: 'done' }
                ]
            },
            {
                // The earlier unit is `mixed` — one answer used, one refused. A mixed block is a
                // documented keep (F2), so the duplicate rule does not reach it either.
                kept: 'the earlier unit is mixed',
                messages: [
                    { role: 'user', content: 'go' },
                    blockOf([
                        { id: 'c1', name: 'read', args: '{"p":1}' },
                        { id: 'c2', name: 'write', args: '{"q":1}' }
                    ]),
                    result('c1', 'read', 'contents'),
                    result('c2', 'write', 'refused', 'rejected'),
                    call('c3', 'read', '{"p":1}'),
                    result('c3', 'read', 'contents'),
                    call('c4', 'write', '{"q":1}'),
                    result('c4', 'write', 'written'),
                    { role: 'assistant', content: 'done' }
                ]
            },
            {
                // A standalone message owns no work of its own.
                kept: 'a standalone message',
                messages: [
                    { role: 'user', content: 'go' },
                    { role: 'assistant', content: 'thinking out loud' },
                    call('c2', 'read', '{"p":1}'),
                    result('c2', 'read', 'contents')
                ]
            }
        ];

        for (const entry of cases) {
            expect({
                kept: entry.kept,
                plan: planShape(
                    planTrimmedUnits(
                        entriesFrom(entry.messages, entry.excluded ?? []),
                        settingsWith({ dropDuplicateCalls: true })
                    )
                )
            }).toEqual({ kept: entry.kept, plan: [] });
        }
    });

    it('is idempotent: a second pass over the duplicate it withheld proposes nothing', () => {
        const settings = settingsWith({ dropDuplicateCalls: true });
        const first = planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settings);

        expect(first.map((candidate) => candidate.leaderIndex)).toEqual([1]);

        // The flags the runtime would have cascaded, applied to a rebuilt list — the exact state a
        // restarted process reads back from disk.
        expect(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS, [1, 2]), settings)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T5 — the economy knobs: horizon, cap, floor, in that order
// ---------------------------------------------------------------------------

// Two superseded units answered by a third. The token figures below are the estimator's own:
// `Temp/T45/probe.ts` computed them with the same delta the plugin mirrors — 5 tokens for either
// unit alone, 10 for the pair, and 13 for `TRIMMABLE`'s single unit.
const TWO_TRIMMABLE: HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"p":1}'),
    result('c1', 'read', 'boom', 'failed'),
    call('c2', 'read', '{"p":1}'),
    result('c2', 'read', 'nope', 'rejected'),
    call('c3', 'read', '{"p":1}'),
    result('c3', 'read', 'finally'),
    { role: 'assistant', content: 'done' }
];

const leaderIndexesOf = (plan: readonly TrimCandidate[]): number[] => plan.map((candidate) => candidate.leaderIndex);

describe('context-trimmer economy knobs (T5)', () => {
    it('at the declared zeros the plan is exactly the shipped one, for both fixtures', () => {
        // The zero-tests T5 asks for: `minTokens`/`safetyUnits`/`maxUnits` at 0 (and
        // `minThoughtChars` at any value, since the thoughts write is not this pass's) change
        // nothing at all. Asserted against the plan the plugin produced BEFORE the knobs existed,
        // which is `TRIMMABLE_CANDIDATE` for the one-unit fixture.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ minTokens: 0, safetyUnits: 0, maxUnits: 0 }))).toEqual([
            TRIMMABLE_CANDIDATE
        ]);

        // The floor is not even MEASURED at 0 (one less estimator pass on the shipped path), so a
        // huge value next to a zero floor still writes: the floor is the gate, not the number.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ minTokens: 0, minThoughtChars: 1000000 }))).toEqual([
            TRIMMABLE_CANDIDATE
        ]);

        // `minThoughtChars` never gates a TOOL write either, however large it is.
        expect(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minThoughtChars: 1000000 }))).toEqual(
            planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({}))
        );

        // Both candidates, oldest first, with every knob at 0.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({})))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minTokens: 0, safetyUnits: 0, maxUnits: 0 })))).toEqual([1, 3]);
    });

    it('safetyUnits protects the last N UNITS of the transcript, counted from the end', () => {
        // 5 units here: the user message, the two failed blocks, the answering block and the final
        // assistant turn — so a horizon of 3 protects units 2, 3 and 4 and leaves the OLDEST
        // candidate (unit 1) withholdable. That partial bite is the proof the count is per unit and
        // from the end, not per message or from the front.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 0 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 2 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 3 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 4 })))).toEqual([]);

        // A horizon LARGER than the transcript protects all of it, and a negative or non-finite
        // value behaves as 0 (`../core/context-pruning.ts:376`) — the read edge does not clamp, so
        // the gate has to.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 9999 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: -1 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: Number.NaN })))).toEqual([1, 3]);

        // Units, not MESSAGES: `TRIMMABLE` is 6 messages but 4 units, so 4 protects the candidate
        // and a message-count reading of the same number would not have.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ safetyUnits: 2 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ safetyUnits: 3 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ safetyUnits: 4 })))).toEqual([]);

        // A unit inside the horizon may still ANSWER an older failure — the horizon only ever
        // protects the candidate side, exactly as compaction's does.
        expect(
            planShape(
                planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 3 }))
            )
        ).toEqual([
            {
                index: 1,
                members: [1, 2],
                outcomes: ['failed'],
                invalidOutcomes: ['failed'],
                names: ['read'],
                firedBy: 'dropSupersededToolCalls',
                admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools'],
                // The answer sits INSIDE the protected tail (unit 3), and still counts.
                resolverIndex: 5
            }
        ]);
    });

    it('maxUnits caps one pass, oldest first, and the rest wait for a later turn', () => {
        // 0 is UNBOUNDED here (this plugin's documented default), which is the one place the gate
        // deliberately differs from compaction's `slice(0, maxUnits)`.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 0 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 1 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 2 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 9 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: -1 })))).toEqual([1, 3]);

        // The cap is not a state machine: the NEXT pass over the now-flagged transcript withholds the
        // next-oldest unit by re-deriving the plan, with nothing remembered in between.
        const capped = planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 1 }));

        expect(capped.map((candidate) => candidate.members)).toEqual([[1, 2]]);
        expect(
            leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE, [1, 2]), settingsWith({ maxUnits: 1 })))
        ).toEqual([3]);
    });

    it('minTokens rejects the WHOLE pass below the floor, and the floor is measured after the cap', () => {
        // The fixture's real figures: 5 tokens per unit, 10 for the pair.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minTokens: 5 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minTokens: 10 })))).toEqual([1, 3]);
        // One token above the saving is the whole rejection: the plan comes back empty rather than
        // partial, so a below-floor turn writes, notifies, saves and reports NOTHING.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minTokens: 11 })))).toEqual([]);

        // A single candidate measured alone (the cap left one unit at 5 tokens): at the floor it
        // writes, one token above it does not.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 1, minTokens: 5 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 1, minTokens: 6 })))).toEqual([]);

        // THE ORDER, pinned by that pair: 6 is ABOVE what the capped pass saves (5) and BELOW what
        // the uncapped pass saves (10). A floor measured before the cap would have let this turn
        // write one unit; the shipped order rejects the capped pass outright, which is the pass the
        // plugin would actually have made.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 1, minTokens: 6 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ maxUnits: 0, minTokens: 6 })))).toEqual([1, 3]);

        // The horizon runs first of all, so a candidate the horizon removed cannot prop the floor up:
        // one unit inside the horizon left (5 tokens... zero units), and 6 would otherwise reject.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ safetyUnits: 3, minTokens: 6 })))).toEqual([]);

        // Non-finite and negative behave as 0 (`../core/context-pruning.ts:422`).
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minTokens: -1 })))).toEqual([1, 3]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE), settingsWith({ minTokens: Number.NaN })))).toEqual([1, 3]);
    });

    it('the economy gates apply to the duplicate rule as well, and never to thinking', () => {
        const settings = settingsWith({ dropDuplicateCalls: true, dropSupersededToolCalls: false, trimInvalidTools: false });

        // Same estimator, same gates, third rule. `Temp/T45/probe2.ts` measured this unit at 7
        // estimated tokens, so the floor's edge is 7 vs 8 — the same one-token edge as the tool rule.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, minTokens: 7 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, minTokens: 8 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, safetyUnits: 4 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, maxUnits: 1 })))).toEqual([1]);
    });

    it('bills a pass for the members it WITHHOLDS, never for the whole unit (T10)', () => {
        // THE FIGURE IS THE WRITE SET'S. `Temp/opencode-t10-trimmer/tokens3.ts` measured this fixture
        // with the SAME estimator the context bar uses: the whole failed unit is 13 estimated tokens,
        // its REQUEST alone is 5 and its RESULT alone is 8. So once the truncate axis has taken the
        // request on an earlier turn, the pass that finishes the unit is worth EIGHT — billing it the
        // unit's 13 would count the same 5 tokens twice, once on the turn the request left and again on
        // the turn that only withholds the answer.
        const requestGone = entriesFrom(TRIMMABLE, [1]);

        // The fresh unit: the floor passes AT 13 and rejects the whole plan one token above it.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ minTokens: 13 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ minTokens: 14 })))).toEqual([]);

        // The SAME unit after its request left: the edge moved down by exactly the request's 5 tokens,
        // which is only possible because the plan measures the surviving result and nothing else.
        expect(leaderIndexesOf(planTrimmedUnits(requestGone, settingsWith({ minTokens: 8 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(requestGone, settingsWith({ minTokens: 9 })))).toEqual([]);

        // And the candidate that clears the 8-token floor names only the entry it withholds, so the
        // figure the floor judged and the write the plugin performs are the SAME list.
        expect(
            planTrimmedUnits(requestGone, settingsWith({ minTokens: 8 })).map((candidate) => ({
                index: candidate.leaderIndex,
                members: candidate.members
            }))
        ).toEqual([{ index: 1, members: [2] }]);
    });

    it('a below-floor pass writes nothing at all: no flag, no park, no diagnostic', async () => {
        // D4 #5 / invariant 3, at the level of the writer and the trigger: the floor rejection
        // happens IN THE PLAN, so the turn is still the synchronous no-op and the operator learns
        // nothing happened because nothing did.
        const { api, touches, diagnostics } = createFakeApi({ minTokens: 500 });
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        expect(calls).toEqual([]);
        expect(entries[1].included).toBe(true);
        expect(diagnostics).toEqual([]);
        expect(touches).toEqual([...TURN_READS]);

        const { api: handlerApi } = createFakeApi({ minTokens: 500 });
        const handlerCalls: string[] = [];
        const handler = createContextTrimmerHandler(handlerApi);

        expect(
            handler(createFakeTurn({ api: handlerApi, calls: handlerCalls, entries: entriesFrom(TRIMMABLE) }))
        ).toBeUndefined();
        expect(handlerCalls).toEqual([]);

        // 13 tokens is the fixture's whole saving, so the floor's edge is one token: at 13 the pass
        // writes and reports, at 14 it does not exist.
        const atFloor = createFakeApi({ minTokens: 13 });
        const atFloorCalls: string[] = [];

        await executeTrimming(atFloor.api, createFakeTurn({ api: atFloor.api, calls: atFloorCalls, entries: entriesFrom(TRIMMABLE) }));
        expect(atFloorCalls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(atFloor.diagnostics).toHaveLength(1);

        const above = createFakeApi({ minTokens: 14 });
        const aboveCalls: string[] = [];

        await executeTrimming(above.api, createFakeTurn({ api: above.api, calls: aboveCalls, entries: entriesFrom(TRIMMABLE) }));
        expect(aboveCalls).toEqual([]);
        expect(above.diagnostics).toEqual([]);
    });

    it('reports the knobs it ran with, in the pass report', async () => {
        const { api, diagnostics } = createFakeApi({ minTokens: 5, safetyUnits: 2, maxUnits: 1 });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TWO_TRIMMABLE) }));

        // The cap bit (one unit of two) and the report says so: the policy block carries the values
        // that produced THIS plan, not the declared defaults.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(policyOf(diagnostics[0])).toMatchObject({ minTokens: 5, safetyUnits: 2, maxUnits: 1 });
        // The line is the shipped wording — the unit is the shape the shipped rule has always
        // named, so the generalisation changed nothing about it (the resolver is `msg-6`, the third
        // tool block of the fixture).
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-6'
        );
    });
});

// ---------------------------------------------------------------------------
// T4 — what a report LINE says when a switch other than the shipped one fired
// ---------------------------------------------------------------------------

describe('context-trimmer report — which switch a line names (T4 / D4 #1)', () => {
    // D4 #1: one pass, one diagnostic, one line per withheld unit, and the line says which switch
    // produced it. The shipped wording is the baseline every other case in this file pins
    // byte-identically, so the clause is only allowed to appear on a shape the shipped rule could
    // never have produced — which is exactly what the three cases below are.
    it('names the effective outcome in the brackets and appends the switch only for a shape the shipped rule could not produce', async () => {
        const cases: Array<{ case: string; stored: Record<string, unknown>; messages: HarnessMessage[]; message: string; fired: string[] }> = [
            {
                // `cancelled` is not in the shipped outcome set, so the brackets change AND the
                // line says which switch did it.
                case: 'cancelled',
                stored: { dropSupersededToolCalls: false, invalidOutcomes: 'cancelled' },
                messages: unitThenAnswer(result('c1', 'read', 'stopped', 'cancelled')),
                message:
                    'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [cancelled] read answered by msg-4 via trimInvalidTools',
                fired: ['trimInvalidTools']
            },
            {
                // `empty` is the one value read off the TEXT: the line reports what the pass JUDGED
                // (`empty`), while `data.units[].outcomes` below keeps what the transcript RECORDS
                // (`completed`).
                case: 'empty',
                stored: { dropSupersededToolCalls: false, invalidOutcomes: 'empty' },
                messages: unitThenAnswer(result('c1', 'read', '   ')),
                message:
                    'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [empty] read answered by msg-4 via trimInvalidTools',
                fired: ['trimInvalidTools']
            },
            {
                // A duplicate re-run withholds a unit whose answers the model READ, so the line
                // names `dropDuplicateCalls` even though its outcome is the ordinary `completed`.
                // `dropSupersededToolCalls` is ON here (the declared default) and still does not
                // claim the unit — `fired` is derived from what actually admitted it.
                case: 'duplicate',
                stored: { dropDuplicateCalls: true },
                messages: DUPLICATE_SUCCESS,
                message:
                    'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [completed] read answered by msg-4 via dropDuplicateCalls',
                fired: ['dropDuplicateCalls']
            }
        ];

        for (const entry of cases) {
            const { api, diagnostics } = createFakeApi(entry.stored);
            const calls: string[] = [];

            await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(entry.messages) }));

            expect({
                case: entry.case,
                // One diagnostic for the pass, one line inside it.
                reported: diagnostics.length,
                message: diagnostics[0]?.message,
                calls,
                fired: policyOf(diagnostics[0]).fired
            }).toEqual({
                case: entry.case,
                reported: 1,
                message: entry.message,
                calls: ['setIncluded:1:false', 'setIncluded:2:false'],
                fired: entry.fired
            });
        }
    });

    it('carries both outcome lists and both switch lists on the structured unit, so a host never has to parse the line', async () => {
        const { api, diagnostics } = createFakeApi({ dropSupersededToolCalls: false, invalidOutcomes: 'empty' });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(unitThenAnswer(result('c1', 'read', '   '))) }));

        expect(diagnostics[0].data).toEqual({
            // The thinking and truncate sides are ALWAYS part of the report, even when they wrote
            // nothing: a host diffs ONE shape across turns, so "no thinking this pass" and "no
            // request truncated this pass" are empty lists rather than missing keys.
            thoughts: [],
            truncated: [],
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    // The whole unit was still being sent, so this pass DID write the request entry.
                    requestAlreadyWithheld: false,
                    // RECORDS `completed`, JUDGED `empty` — the pair that makes a withheld stub
                    // distinguishable from a withheld zero-hit search.
                    outcomes: ['completed'],
                    invalidOutcomes: ['empty'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'trimInvalidTools',
                    admittedBy: ['trimInvalidTools']
                }
            ],
            policy: {
                ...DEFAULT_POLICY,
                dropSupersededToolCalls: false,
                invalidOutcomes: 'empty',
                invalidOutcomesSubmitted: 'empty',
                fired: ['trimInvalidTools']
            }
        });
    });
});

// ---------------------------------------------------------------------------
// The action: writes and the report
// ---------------------------------------------------------------------------

describe('context-trimmer action (executeTrimming)', () => {
    it('A1: writes one flag on the leader, keeps the answering unit, and reports the pair', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE);
        const context = createFakeTurn({ api, calls, entries });

        await expect(executeTrimming(api, context)).resolves.toBeUndefined();

        // TWO writes — one per MEMBER of the withheld unit, the leader and its own result. R8
        // removed the runtime's cascade, so the policy names every entry it wants out of the
        // request (and never rewrites the transcript beyond those flags). The answering unit
        // (entries 3 and 4) stays on.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(entries[1].included).toBe(false);
        expect(entries[3].included).toBe(true);
        expect(entries[4].included).toBe(true);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);

        expect(diagnostics).toHaveLength(1);
        // BYTE-IDENTICAL to the message this plugin wrote before the switch split: at the
        // declared defaults no tier fell back, so no clause is appended (the `fallbackClausesOf`
        // contract). The structured `policy` block is where the configuration now lives.
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): ' +
                '#1 msg-2 [failed] read answered by msg-4'
        );
        expect(diagnostics[0].data).toEqual({
            // The thinking and truncate sides are ALWAYS part of the report, even when they wrote
            // nothing: a host diffs ONE shape across turns, so "no thinking this pass" and "no
            // request truncated this pass" are empty lists rather than missing keys.
            thoughts: [],
            truncated: [],
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    requestAlreadyWithheld: false,
                    outcomes: ['failed'],
                    invalidOutcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'dropSupersededToolCalls',
                    admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools']
                }
            ],
            policy: DEFAULT_POLICY
        });
    });

    it('A1: finishes an already-truncated unit with ONE write, and attributes the completion to the trim rule', async () => {
        // THE STATE `truncateToolRequests` LEAVES BEHIND: the REQUEST entry (1) is withheld and the
        // failed RESULT (2) rides on. The truncate axis stays ON here, with a horizon of one tool turn
        // — the answering unit (3) is the newest tool turn, so it is protected and the axis has
        // nothing to write for a reason a reader can check. That is what turns "the report does not
        // double-count this decision" into an assertion rather than an artefact of a switch being off.
        const { api, touches, diagnostics } = createFakeApi({ truncateToolRequests: true, truncateTurns: 1 });
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE, [1]);

        await expect(executeTrimming(api, createFakeTurn({ api, calls, entries }))).resolves.toBeUndefined();

        // ONE write, on the surviving RESULT. The leader already carried the flag, so the writer does
        // not touch it again: re-writing `false` would fire a persistence notification and a
        // whole-document save for a write that changes nothing, and no axis here ever stores `true`.
        expect(calls).toEqual(['setIncluded:2:false']);
        expect(entries[1].included).toBe(false);
        expect(entries[2].included).toBe(false);
        expect(entries[3].included).toBe(true);
        expect(entries[4].included).toBe(true);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);

        // The unit is still NAMED by its leader (the readable, durable identity) and the line says the
        // request was already gone, so the same `#1` cannot be misread as a truncation this pass did.
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): ' +
                '#1 msg-2 [failed] read answered by msg-4 (request already withheld)'
        );
        expect(diagnostics[0].data).toEqual({
            thoughts: [],
            // THE TRUNCATE SECTION STAYS EMPTY: this pass wrote no truncation, so the decision that
            // belongs to an EARLIER turn is not reported again and `policy.fired` cannot name the
            // truncate switch for a write it did not make (see the `truncateToolRequests: true` in
            // the policy block right below — the switch was on, and it still did not fire).
            truncated: [],
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [2],
                    requestAlreadyWithheld: true,
                    outcomes: ['failed'],
                    invalidOutcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    // The whole-unit rule owns this record: it withheld the last piece of the unit,
                    // whoever truncated the request on the turn before.
                    firedBy: 'dropSupersededToolCalls',
                    admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools']
                }
            ],
            policy: { ...DEFAULT_POLICY, truncateToolRequests: true, truncateTurns: 1 }
        });

        // THE SECOND PASS WRITES AND REPORTS NOTHING. The same live entries, one turn later: the unit
        // has no member left to withhold, so the plan is empty — no flag write, therefore no
        // notification and no save, and no diagnostic line either.
        const writes = calls.length;
        const reads = touches.length;

        await expect(executeTrimming(api, createFakeTurn({ api, calls, entries }))).resolves.toBeUndefined();

        expect(calls.slice(writes)).toEqual([]);
        expect(diagnostics).toHaveLength(1);
        expect(touches.slice(reads)).toEqual(TURN_READS);

        // NOTHING IS DELETED — flags only. Canonical history still carries the request, its result and
        // the answering unit, so a host or the UI can switch each entry back on.
        expect(entries).toHaveLength(TRIMMABLE.length);
        expect(entries[1].message as Extract<HarnessMessage, { role: 'assistant' }>).toMatchObject({
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
        });
        expect((entries[2].message as Extract<HarnessMessage, { role: 'tool' }>).content).toBe(
            'Tool "read" failed: EACCES'
        );
    });

    it('A1: one pass that finishes an old truncation AND truncates a fresh request bills each entry once', async () => {
        // THE CROSS-AXIS HALF of the same promise. `truncateTurns: 0` (the fake's baseline) makes the
        // truncate axis eligible for BOTH tool turns: the one whose request an earlier pass already
        // took (unit #1 — nothing left for that axis to do) and the answering turn (#3). The whole-unit
        // rule runs first and finishes #1, and the truncate axis writes #3. One transcript position,
        // one decision, one record — the two lists must not overlap.
        const { api, diagnostics } = createFakeApi({ truncateToolRequests: true, truncateTurns: 0 });
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE, [1]);

        await expect(executeTrimming(api, createFakeTurn({ api, calls, entries }))).resolves.toBeUndefined();

        // Two writes: the surviving RESULT of the finished unit, then the REQUEST of the fresh one. The
        // already-off leader (#1) is never re-written, and #4 — the answer the model keeps — is the one
        // entry of the answering unit that stays on.
        expect(calls).toEqual(['setIncluded:2:false', 'setIncluded:3:false']);
        expect(entries.map((entry) => entry.included)).toEqual([true, false, false, false, true, true]);

        const data = diagnostics[0].data as {
            units: { index: number; members: number[]; requestAlreadyWithheld: boolean }[];
            truncated: { index: number; results: number[] }[];
            policy: { fired: string[] };
        };

        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): ' +
                '#1 msg-2 [failed] read answered by msg-4 (request already withheld)' +
                ' | context-trimmer truncated 1 tool request(s): #3 msg-4 read results kept #4'
        );

        // THE TWO LISTS ARE DISJOINT. `#1` is a completion (its write set is the result) and `#3` is a
        // truncation (its write set is the request, its result listed as kept) — neither entry appears
        // on both sides, so the pass cannot bill the same text twice.
        expect(data.units.map((unit) => ({ index: unit.index, members: unit.members, requestAlreadyWithheld: unit.requestAlreadyWithheld }))).toEqual([
            { index: 1, members: [2], requestAlreadyWithheld: true }
        ]);
        expect(data.truncated).toEqual([{ index: 3, messageId: 'msg-4', names: ['read'], results: [4], firedBy: 'truncateToolRequests' }]);
        expect(data.policy.fired).toEqual(['dropSupersededToolCalls', 'trimInvalidTools', 'truncateToolRequests']);
    });

    it('A2: writes and reports nothing when nothing was superseded', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls }));

        expect(calls).toEqual([]);
        expect(diagnostics).toEqual([]);
        // Every switch is still consulted exactly once on a turn that gets past the guards.
        expect(touches).toEqual([...TURN_READS]);
    });

    it('A3: writes one flag per superseded attempt, oldest first, in a single report', async () => {
        const { api, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom([
            call('c1', 'read', '{"p":1}'),
            result('c1', 'read', 'boom', 'failed'),
            call('c2', 'read', '{"p":1}'),
            result('c2', 'read', 'nope', 'rejected'),
            call('c3', 'read', '{"p":1}'),
            result('c3', 'read', 'finally')
        ]);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        expect(calls).toEqual([
            'setIncluded:0:false',
            'setIncluded:1:false',
            'setIncluded:2:false',
            'setIncluded:3:false'
        ]);

        const data = diagnostics[0].data as { units: { index: number }[] };

        expect(data.units.map((unit) => unit.index)).toEqual([0, 2]);
        expect(diagnostics[0].message).toContain('withheld 2 superseded tool unit(s)');
    });

    it('A5: is idempotent — a second pass writes nothing and notifies nothing', async () => {
        const { api, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const context = createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) });

        await executeTrimming(api, context);
        calls.length = 0;
        await executeTrimming(api, context);

        expect(calls).toEqual([]);
        expect(diagnostics).toHaveLength(1);
    });

    it('A5: a branch round is skipped before a single setting is read', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];

        await executeTrimming(
            api,
            createFakeTurn({
                api,
                calls,
                guardEntries: true,
                branchId: 'branch-1',
                actorKey: 'branch:branch-1'
            })
        );

        // No settings read, no transcript walk, no write (an ephemeral copy is never trimmed).
        expect(calls).toEqual([]);
        expect(touches).toEqual([]);
        expect(diagnostics).toEqual([]);
    });

    it('A5: an internal compaction agent is skipped without walking the transcript', async () => {
        const { api, touches, diagnostics } = createFakeApi({ enabled: true });
        const calls: string[] = [];

        for (const agentName of ['summarizer', 'underload:compaction', 'compact-worker']) {
            await executeTrimming(
                api,
                createFakeTurn({ api, agent: agentName, calls, guardEntries: true })
            );
        }

        expect(calls).toEqual([]);
        expect(touches).toEqual([
            'settings.boolean:enabled',
            'settings.boolean:enabled',
            'settings.boolean:enabled'
        ]);
        expect(diagnostics).toEqual([]);
    });

    it('A5: `enabled: false` costs one settings read and changes nothing', async () => {
        const { api, touches, diagnostics, setSetting } = createFakeApi({ enabled: false });
        const calls: string[] = [];

        await executeTrimming(
            api,
            createFakeTurn({ api, calls, guardEntries: true, entries: entriesFrom(TRIMMABLE) })
        );

        expect(calls).toEqual([]);
        expect(touches).toEqual(['settings.boolean:enabled']);
        expect(diagnostics).toEqual([]);

        // The switch is live per turn: the very next turn trims again.
        setSetting('enabled', true);
        const after: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls: after, entries: entriesFrom(TRIMMABLE) }));
        expect(after).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(diagnostics).toHaveLength(1);
    });

    // THE THIRD WRITE LOOP, SAME RACE (2026-11-13 review). The whole-unit loop is the one that
    // already re-checked the live flag; it now runs the same shared validity check as the other two,
    // so an index that lands on a role this axis cannot name (a REQUEST entry or a RESULT) is skipped
    // rather than written. The plan's write set is [1,2]; index 1 has moved to a `user` entry in the
    // replaced transcript, so exactly one flag lands — and the unit is still REPORTED, because the
    // unit really did leave the request.
    it('a whole-unit member that went stale inside the pause window is skipped, and the rest lands', async () => {
        const { api, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const planned = entriesFrom(TRIMMABLE);
        const stale = entriesFrom([
            { role: 'user', content: 'go' },
            { role: 'user', content: 'moved' },
            result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
            call('c2', 'read', '{"path":"b.ts"}'),
            result('c2', 'read', 'export const b = 2;'),
            { role: 'assistant', content: 'done' }
        ]);
        const { context, reads } = withStaleEntries(
            createFakeTurn({ api, calls, entries: planned }),
            planned,
            stale
        );

        await executeTrimming(api, context);

        expect(calls).toEqual(['setIncluded:2:false']);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(
            (
                diagnostics[0].data as {
                    units: { members: readonly number[]; requestAlreadyWithheld: boolean }[];
                }
            ).units.map((unit) => [unit.members, unit.requestAlreadyWithheld])
        ).toEqual([[[1, 2], false]]);
        expect(reads()).toBe(4);
    });
});


// ---------------------------------------------------------------------------
// The policy switches (the 2026-11-10 split): gating, independence, and what a pass reports
// ---------------------------------------------------------------------------

// The shipped pair, but answered with a `rejected` result instead of a `failed` one — the
// fixture `invalidOutcomes` narrows over.
const TRIMMABLE_REJECTED: readonly HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'Tool "read" is not available.', 'rejected'),
    call('c2', 'read', '{"path":"b.ts"}'),
    result('c2', 'read', 'export const b = 2;'),
    { role: 'assistant', content: 'done' }
];

// The shipped pair, but answered with the SAME arguments — the shape `supersedeMatch:
// 'fingerprint'` accepts as well as `'name'`. `TRIMMABLE` answers with DIFFERENT arguments on
// purpose (it is the shipped loosening), so any case that has to survive the strict matcher runs on
// this one. Same indexes, so the same candidate address and the same resolver.
const TRIMMABLE_SAME_ARGS: readonly HarnessMessage[] = [
    { role: 'user', content: 'go' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
    call('c2', 'read', '{"path":"a.ts"}'),
    result('c2', 'read', 'export const a = 1;'),
    { role: 'assistant', content: 'done' }
];

// A pass report's structured policy block, typed loosely so a test can name the exact fields.
type PassPolicy = Record<string, string | number | boolean | readonly string[]>;

const policyOf = (report: HarnessPluginDiagnosticReport | undefined): PassPolicy =>
    (report?.data as { policy: PassPolicy } | undefined)?.policy ?? {};

describe('context-trimmer policy switches', () => {
    it('with BOTH tool switches off nothing is withheld, reported, touched or parked', async () => {
        const { api, touches, diagnostics } = createFakeApi({
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        // The engine's posture: every recorded unit stays in the request, no flag, no
        // notification, and NO diagnostic at all (D4's zero-cost case).
        expect(calls).toEqual([]);
        expect(entries[1].included).toBe(true);
        expect(diagnostics).toEqual([]);
        expect(touches).toEqual([...TURN_READS]);

        // And it is still the SYNCHRONOUS no-op: twelve switches did not turn the common turn
        // into a promise. A second fake keeps the read list above readable.
        const { api: handlerApi, touches: handlerTouches } = createFakeApi({
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });
        const handlerCalls: string[] = [];
        const handler = createContextTrimmerHandler(handlerApi);

        expect(handler(createFakeTurn({ api: handlerApi, calls: handlerCalls, entries: entriesFrom(TRIMMABLE) }))).toBeUndefined();
        expect(handlerCalls).toEqual([]);
        expect(handlerTouches).toEqual([...TURN_READS]);
    });

    it('`dropSupersededToolCalls: false` still withholds through the generalisation, and names it', async () => {
        const { api, diagnostics } = createFakeApi({ dropSupersededToolCalls: false });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );

        const policy = policyOf(diagnostics[0]);

        expect(policy.fired).toEqual(['trimInvalidTools']);
        expect(policy.dropSupersededToolCalls).toBe(false);
        expect(policy.invalidOutcomes).toBe('failed/rejected');
    });

    it('`trimInvalidTools: false` leaves the shipped rule as the only tool policy', async () => {
        const { api, diagnostics } = createFakeApi({ trimInvalidTools: false });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

        // Independent in the other direction: the shipped switch alone still withholds the pair.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);

        const policy = policyOf(diagnostics[0]);

        expect(policy.fired).toEqual(['dropSupersededToolCalls']);
        expect(policy.trimInvalidTools).toBe(false);
    });

    it('`invalidOutcomes` narrows what counts as invalid once the shipped switch is off', async () => {
        const kept = createFakeApi({ dropSupersededToolCalls: false, invalidOutcomes: 'failed' });
        const keptCalls: string[] = [];

        await executeTrimming(kept.api, createFakeTurn({ api: kept.api, calls: keptCalls, entries: entriesFrom(TRIMMABLE_REJECTED) }));

        // `rejected` is not in the set the generalisation may act on, and the shipped switch is
        // off, so the unit stays — the switches are genuinely independent.
        expect(keptCalls).toEqual([]);
        expect(kept.diagnostics).toEqual([]);

        const trimmed = createFakeApi({ dropSupersededToolCalls: false, invalidOutcomes: 'rejected' });
        const trimmedCalls: string[] = [];

        await executeTrimming(trimmed.api, createFakeTurn({ api: trimmed.api, calls: trimmedCalls, entries: entriesFrom(TRIMMABLE_REJECTED) }));

        expect(trimmedCalls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(policyOf(trimmed.diagnostics[0]).invalidOutcomes).toBe('rejected');
        expect(policyOf(trimmed.diagnostics[0]).fired).toEqual(['trimInvalidTools']);
    });

    it('an outcome set that resolves to NOTHING disables the generalisation', async () => {
        // Three spellings of "nothing that admits THIS unit": empty, an unknown name, and an
        // opt-in name that does not describe a `failed` result. With `dropSupersededToolCalls` off,
        // all three withhold nothing. (`cancelled` is no longer "inert": T4 acts on it, so what
        // keeps the unit here is that its outcome is `failed`, which the set `cancelled` does not
        // name — the difference between an unusable name and a name that simply does not match.)
        for (const invalidOutcomes of ['', 'completed', 'cancelled']) {
            const { api, diagnostics } = createFakeApi({ dropSupersededToolCalls: false, invalidOutcomes });
            const calls: string[] = [];

            await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

            expect({ invalidOutcomes, calls, reported: diagnostics.length }).toEqual({
                invalidOutcomes,
                calls: [],
                reported: 0
            });
        }

        // `cancelled` IS a documented name, so it is kept as the effective set and dropped WITHOUT a
        // fallback clause — and the pass reports the set it actually ran with, which is now
        // `cancelled` and no longer the T3 transitional `''`.
        const cancelled = createFakeApi({ invalidOutcomes: 'cancelled' });
        const cancelledCalls: string[] = [];

        await executeTrimming(cancelled.api, createFakeTurn({ api: cancelled.api, calls: cancelledCalls, entries: entriesFrom(TRIMMABLE) }));

        expect(cancelledCalls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(cancelled.diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(policyOf(cancelled.diagnostics[0])).toMatchObject({
            invalidOutcomes: 'cancelled',
            invalidOutcomesSubmitted: 'cancelled',
            invalidOutcomesFallback: false,
            fired: ['dropSupersededToolCalls']
        });

        const completed = createFakeApi({ invalidOutcomes: 'completed' });
        const completedCalls: string[] = [];

        await executeTrimming(completed.api, createFakeTurn({ api: completed.api, calls: completedCalls, entries: entriesFrom(TRIMMABLE) }));

        expect(completedCalls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(completed.diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4' +
                ' | invalidOutcomes "completed" has unknown names; used none (the generalisation is off)'
        );
    });

    it('a tier the operator spelled wrong reports the fallback that actually ran', async () => {
        const cases: Array<{ stored: Record<string, unknown>; clause: string; policy: PassPolicy }> = [
            {
                stored: { invalidOutcomes: 'failed,rejected,bogus' },
                clause: 'invalidOutcomes "failed,rejected,bogus" has unknown names; used failed/rejected',
                policy: {
                    invalidOutcomes: 'failed/rejected',
                    invalidOutcomesSubmitted: 'failed,rejected,bogus',
                    invalidOutcomesFallback: true
                }
            },
            {
                stored: { supersedeMatch: 'loose' },
                clause: 'supersedeMatch "loose" is not a matcher; used "name"',
                policy: {
                    supersedeMatch: 'name',
                    supersedeMatchSubmitted: 'loose',
                    supersedeMatchFallback: true
                }
            }
        ];

        for (const entry of cases) {
            const { api, diagnostics } = createFakeApi(entry.stored);
            const calls: string[] = [];

            await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

            // The write edge accepts any string (it owns type and bounds, never content), so
            // THIS is the surface that tells the operator what ran.
            expect(diagnostics[0].message).toBe(
                `context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4 | ${entry.clause}`
            );
            expect(policyOf(diagnostics[0])).toMatchObject(entry.policy);
        }
    });

    it('reports every fallback clause in DECLARED order when both string tiers are wrong at once', async () => {
        const { api, diagnostics } = createFakeApi({
            invalidOutcomes: 'nope',
            supersedeMatch: 'loose'
        });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4' +
                ' | invalidOutcomes "nope" has unknown names; used none (the generalisation is off)' +
                ' | supersedeMatch "loose" is not a matcher; used "name"'
        );
        expect(policyOf(diagnostics[0]).fired).toEqual(['dropSupersededToolCalls']);
    });

    it('a tier that only differs in case or spacing is normalised WITHOUT a fallback clause', async () => {
        const { api, diagnostics } = createFakeApi({
            supersedeMatch: 'Fingerprint ',
            invalidOutcomes: ' Failed , REJECTED '
        });
        const calls: string[] = [];

        // `TRIMMABLE_SAME_ARGS` rather than `TRIMMABLE`: the value being normalised here is
        // `'Fingerprint '`, and the normalised `fingerprint` matcher demands the answer re-ran the
        // EXACT work. The shipped fixture answers with different arguments on purpose, so a case
        // that runs the strict matcher has to use the fixture that survives it — which is also the
        // proof that the normalised matcher is really the one in force, not the fallback.
        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE_SAME_ARGS) }));

        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        // Normalisation is not a substitution: nothing was dropped, so nothing is complained
        // about, and the USED values are the canonical spellings.
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(policyOf(diagnostics[0])).toMatchObject({
            supersedeMatch: 'fingerprint',
            supersedeMatchFallback: false,
            invalidOutcomes: 'failed/rejected',
            invalidOutcomesFallback: false
        });
    });

    it('reports the economy and thoughts knobs in every pass report, and the ones that gate nothing stay inert', async () => {
        // The report half, at values that gate NOTHING: `minTokens: 0` and `safetyUnits: 0` are the
        // pass-throughs, `maxUnits: 1` cannot bite a one-candidate pass, `minThoughtChars` is the
        // thinking twin this pass never applies (the estimator does not count `reasoning`), and
        // `thoughtTurns: 7` protects more thoughts than this fixture has. A superseded unit still
        // leaves, so a reader can tell "off" from "not implemented" and the declared defaults never
        // leak into the block.
        const { api, diagnostics } = createFakeApi({
            thoughtTurns: 7,
            supersedeMatch: 'fingerprint',
            dropDuplicateCalls: true,
            truncateToolRequests: true,
            truncateTurns: 9,
            minTokens: 0,
            minThoughtChars: 2000,
            safetyUnits: 0,
            maxUnits: 1
        });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE_SAME_ARGS) }));

        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(policyOf(diagnostics[0])).toMatchObject({
            trimThoughts: true,
            thoughtTurns: 7,
            truncateToolRequests: true,
            truncateTurns: 9,
            supersedeMatch: 'fingerprint',
            dropDuplicateCalls: true,
            minTokens: 0,
            minThoughtChars: 2000,
            safetyUnits: 0,
            maxUnits: 1
        });

        // `minThoughtChars` is inert for a TOOL write at any value, including one no tool unit in
        // this fixture could ever clear.
        const { api: inertApi, diagnostics: inertDiagnostics } = createFakeApi({ minThoughtChars: 1000000 });
        const inertCalls: string[] = [];

        await executeTrimming(inertApi, createFakeTurn({ api: inertApi, calls: inertCalls, entries: entriesFrom(TRIMMABLE) }));

        expect({ minThoughtChars: 1000000, calls: inertCalls, reported: inertDiagnostics.length }).toEqual({
            minThoughtChars: 1000000,
            calls: ['setIncluded:1:false', 'setIncluded:2:false'],
            reported: 1
        });

        // The cases that DO bite are pinned in the economy table above; this one only has to keep
        // them reported. Asserting the values here is what stops a future refactor from dropping a
        // knob from the block once it stops being inert.
        expect(policyOf(inertDiagnostics[0])).toMatchObject({
            minTokens: 0,
            safetyUnits: 0,
            maxUnits: 0,
            minThoughtChars: 1000000
        });
    });
});

// ---------------------------------------------------------------------------
// The trigger: synchronous fast path, pause/resume only around a real trim
// ---------------------------------------------------------------------------

describe('context-trimmer trigger (createContextTrimmerHandler)', () => {
    it('returns undefined SYNCHRONOUSLY on a turn with nothing to trim, and parks nothing', () => {
        const { api, touches } = createFakeApi();
        const calls: string[] = [];
        const handler = createContextTrimmerHandler(api);

        // The default fake transcript is one user message: the plan is computed (that is the
        // whole cost) and comes back empty.
        const result = handler(createFakeTurn({ api, calls }));

        // Not a promise: the path nearly every turn takes yields exactly one microtask, and no
        // control — park, write, edit, rewrite — was touched at all. The twelve settings reads
        // a turn now costs are all synchronous, which is why splitting one switch into twelve
        // did not move this turn onto a promise.
        expect(result).toBeUndefined();
        expect(calls).toEqual([]);
        expect(touches).toEqual([...TURN_READS]);
    });

    it('parks, writes, and un-parks only on a turn that trims, with one plan for both', async () => {
        const { api, touches } = createFakeApi();
        const calls: string[] = [];
        const seen: Array<{ api: HarnessPluginApi; context: HarnessTurnBeforeContext; count: number }> = [];

        const handler = createContextTrimmerHandler(api, async (writerApi, context, candidates) => {
            calls.push('action');
            seen.push({ api: writerApi, context, count: candidates.length });
        });

        const context = createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) });
        const result = handler(context);

        expect(result).toBeInstanceOf(Promise);
        await result;

        expect(calls).toEqual(['pause', 'action', 'resume']);
        expect(seen).toHaveLength(1);
        // Identity, not equality: the writer gets the harness control surface, the very parked
        // turn, and the plan the guard already computed (no second transcript walk).
        expect(seen[0].api).toBe(api);
        expect(seen[0].context).toBe(context);
        expect(seen[0].count).toBe(1);
        expect(touches).toEqual([...TURN_READS]);
    });

    it('un-parks when the writer throws and lets the error reach the bus', async () => {
        const { api } = createFakeApi();
        const calls: string[] = [];

        const handler = createContextTrimmerHandler(api, async (): Promise<void> => {
            calls.push('action');
            throw new Error('trim failed');
        });

        await expect(
            handler(createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }))
        ).rejects.toThrow('trim failed');

        expect(calls).toEqual(['pause', 'action', 'resume']);
    });

    it('never runs the writer for a branch round, an internal agent, or a disabled plugin', async () => {
        const { api, touches } = createFakeApi();
        const calls: string[] = [];
        const handler = createContextTrimmerHandler(api, async (): Promise<void> => {
            calls.push('action');
        });

        expect(
            handler(createFakeTurn({ api, calls, guardEntries: true, branchId: 'branch-1', actorKey: 'branch:branch-1' }))
        ).toBeUndefined();
        expect(
            handler(createFakeTurn({ api, calls, guardEntries: true, agent: 'summarizer' }))
        ).toBeUndefined();

        // A branch reads NOTHING at all; the internal agent costs the one `enabled` read the
        // guard shares with the off switch. Neither built the canonical list (the throwing
        // `entries` getter above would have failed the turn).
        expect(calls).toEqual([]);
        expect(touches).toEqual(['settings.boolean:enabled']);

        const { api: offApi, touches: offTouches } = createFakeApi({ enabled: false });
        const offHandler = createContextTrimmerHandler(offApi, async (): Promise<void> => {
            calls.push('action');
        });

        expect(offHandler(createFakeTurn({ api: offApi, calls, guardEntries: true }))).toBeUndefined();

        // Disabled: exactly one settings read, no writer, no transcript walk.
        expect(calls).toEqual([]);
        expect(offTouches).toEqual(['settings.boolean:enabled']);
    });

    it('setup subscribes exactly one turn.before handler that trims inside its pause window', async () => {
        const { api, touches } = createFakeApi();
        const registered: Array<{ event: string; handler: HarnessLifecycleHandler<'turn.before'> }> = [];

        api.on = (event: string, handler: unknown) => {
            registered.push({ event, handler: handler as unknown as HarnessLifecycleHandler<'turn.before'> });
            return () => undefined;
        };

        setup(api);
        expect(registered.map((entry) => entry.event)).toEqual(['turn.before']);

        const calls: string[] = [];

        await registered[0].handler(
            createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) })
        );

        // park -> write -> un-park, with the shipped writer: the built-in changes the
        // transcript inside the pause window and reports it. TWO writes for ONE unit, because the
        // flag is per entry (R8) and the unit's write set is its leader plus its result.
        expect(calls).toEqual([
            'pause',
            'setIncluded:1:false',
            'setIncluded:2:false',
            'resume'
        ]);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);
    });
});

// ---------------------------------------------------------------------------
// Metadata: the FULL declared switch surface, key-by-key
// ---------------------------------------------------------------------------

describe('context-trimmer metadata', () => {
    it('declares the shipped switch surface and the one hook it uses', () => {
        expect(metadata.name).toBe('context-trimmer');
        expect(metadata.title).toBe('Context Trimmer');
        expect(metadata.builtin).toBe(true);
        expect(metadata.version).toBe('1.0.0');
        expect(metadata.tags).toEqual(['context', 'trimming', 'lifecycle']);
        // The trigger point this plugin needs, and nothing else, so the live hook surface and
        // the declared intent stay identical.
        expect(metadata.hooks).toEqual(['turn.before']);

        // The closed switch surface, in DECLARED order, as `[key, type, default, min, max,
        // step]`. Asserted EXACTLY — a switch added, removed, reordered or re-typed fails here,
        // and a NUMBER without `min`/`max` fails here too, because the PATCH edge only refuses
        // nonsense in a value the plugin published bounds for
        // (src/server/plugins.ts `checkValue`). `enabled` keeps its key, its label, its type
        // and its default: it is the framework's reserved master switch (src/server/plugins.ts
        // `RESERVED_ENABLED_DESCRIPTOR`), so the policy switches below are separate keys.
        //
        // THE ORDER IS THE PANE'S ORDER, and since the 2026-11-13 grouping it is the pane's
        // CATEGORY order: each policy toggle opens a section and the rows that window it follow it
        // immediately, because the Plugins pane renders one control per descriptor in this array's
        // order — a number separated from the switch it belongs to is a number an operator has to
        // map by name alone. The `group`/`parentKey` metadata that says so is pinned below.
        expect(
            metadata.settings?.map((setting: HarnessPluginSettingDescriptor) => [
                setting.key,
                setting.type,
                setting.default,
                setting.min,
                setting.max,
                setting.step
            ])
        ).toEqual([
            ['enabled', 'boolean', true, undefined, undefined, undefined],
            ['trimInvalidTools', 'boolean', true, undefined, undefined, undefined],
            ['invalidToolTurns', 'number', 2, 0, 4096, 1],
            ['invalidOutcomes', 'string', 'failed,rejected', undefined, undefined, undefined],
            ['trimThoughts', 'boolean', true, undefined, undefined, undefined],
            ['thoughtTurns', 'number', 2, 0, 4096, 1],
            ['minThoughtChars', 'number', 0, 0, 1000000, 50],
            ['dropSupersededToolCalls', 'boolean', true, undefined, undefined, undefined],
            ['supersededTurns', 'number', 2, 0, 4096, 1],
            ['supersedeMatch', 'string', 'name', undefined, undefined, undefined],
            ['dropDuplicateCalls', 'boolean', false, undefined, undefined, undefined],
            ['duplicateTurns', 'number', 2, 0, 4096, 1],
            ['truncateToolRequests', 'boolean', false, undefined, undefined, undefined],
            ['truncateTurns', 'number', 2, 0, 4096, 1],
            ['minTokens', 'number', 0, 0, 1000000, 50],
            ['safetyUnits', 'number', 0, 0, 4096, 1],
            ['maxUnits', 'number', 0, 0, 4096, 1]
        ]);

        // THE GROUPING AND THE NESTING (R1/R2, the 2026-11-13 "it looks unorganised" request), as
        // `[key, group.id, group.title, parentKey]` with `null` for an absent field. This is the
        // whole contract the renderer gets: `title` is the heading text it prints verbatim, `id` is
        // what it orders sections by, and `parentKey` is the checkbox that reveals a row. `enabled`
        // carries neither (the master switch sits above the categories), and the three Global
        // Limits rows carry a group but no parent, because they bound every policy at once.
        expect(
            metadata.settings?.map((setting: HarnessPluginSettingDescriptor) => [
                setting.key,
                setting.group?.id ?? null,
                setting.group?.title ?? null,
                setting.parentKey ?? null
            ])
        ).toEqual([
            ['enabled', null, null, null],
            ['trimInvalidTools', 'invalid-tools', 'Invalid Tools', null],
            ['invalidToolTurns', 'invalid-tools', 'Invalid Tools', 'trimInvalidTools'],
            ['invalidOutcomes', 'invalid-tools', 'Invalid Tools', 'trimInvalidTools'],
            ['trimThoughts', 'chain-of-thoughts', 'Chain of Thoughts', null],
            ['thoughtTurns', 'chain-of-thoughts', 'Chain of Thoughts', 'trimThoughts'],
            ['minThoughtChars', 'chain-of-thoughts', 'Chain of Thoughts', 'trimThoughts'],
            ['dropSupersededToolCalls', 'superseded-tools', 'Superseded Tools', null],
            ['supersededTurns', 'superseded-tools', 'Superseded Tools', 'dropSupersededToolCalls'],
            ['supersedeMatch', 'superseded-tools', 'Superseded Tools', 'dropSupersededToolCalls'],
            ['dropDuplicateCalls', 'duplicate-tools', 'Duplicate Tools', null],
            ['duplicateTurns', 'duplicate-tools', 'Duplicate Tools', 'dropDuplicateCalls'],
            ['truncateToolRequests', 'tool-requests', 'Tool Requests', null],
            ['truncateTurns', 'tool-requests', 'Tool Requests', 'truncateToolRequests'],
            ['minTokens', 'global-limits', 'Global Limits', null],
            ['safetyUnits', 'global-limits', 'Global Limits', null],
            ['maxUnits', 'global-limits', 'Global Limits', null]
        ]);

        // THE GROUPING INVARIANTS a hand-edit breaks but a deep-equal above only catches by
        // accident: a category's rows are CONTIGUOUS and a group appears exactly once as a run, so
        // the renderer opens one heading per section in first-appearance order (a second
        // `invalid-tools` run below `global-limits` would draw that heading twice); every
        // `parentKey` names a row declared BEFORE it, and that row is a `boolean`, because a gate
        // the renderer cannot evaluate is a row that hides forever; and the group heading is
        // non-empty, since the renderer prints it verbatim.
        const groupRuns = (metadata.settings ?? []).reduce(
            (runs: string[], setting: HarnessPluginSettingDescriptor) => {
                const id = setting.group?.id ?? null;

                if (runs[runs.length - 1] !== id) runs.push(String(id));

                return runs;
            },
            []
        );

        expect(groupRuns).toEqual([
            'null',
            'invalid-tools',
            'chain-of-thoughts',
            'superseded-tools',
            'duplicate-tools',
            'tool-requests',
            'global-limits'
        ]);
        expect(new Set(groupRuns).size).toBe(groupRuns.length);

        for (const setting of metadata.settings ?? []) {
            if (setting.group === undefined) continue;
            expect(setting.group.title.length).toBeGreaterThan(0);
        }

        for (let index = 0; index < (metadata.settings ?? []).length; index += 1) {
            const setting = metadata.settings![index];
            if (setting.parentKey === undefined) continue;

            const parentIndex = (metadata.settings ?? []).findIndex(
                (other: HarnessPluginSettingDescriptor) => other.key === setting.parentKey
            );

            // A gate that does not exist, or is declared AFTER the row it gates, is a row the
            // renderer cannot resolve while it builds the pane top-down.
            expect(parentIndex).toBeGreaterThanOrEqual(0);
            expect(parentIndex).toBeLessThan(index);
            expect(metadata.settings?.[parentIndex]?.type).toBe('boolean');
        }

        // THE THREE TOGGLE + HORIZON OPTIONS the operator is meant to see first, each horizon
        // immediately after its toggle (the pairs above, spelled out as pairs so a reordering
        // that separates a number from its switch fails here and not in the pane).
        const keys = (metadata.settings ?? []).map((setting) => setting.key);

        expect(keys.indexOf('truncateToolRequests') + 1).toBe(keys.indexOf('truncateTurns'));
        expect(keys.indexOf('trimInvalidTools') + 1).toBe(keys.indexOf('invalidToolTurns'));
        expect(keys.indexOf('trimThoughts') + 1).toBe(keys.indexOf('thoughtTurns'));
        expect(keys.indexOf('dropSupersededToolCalls') + 1).toBe(keys.indexOf('supersededTurns'));
        expect(keys.indexOf('dropDuplicateCalls') + 1).toBe(keys.indexOf('duplicateTurns'));

        // Every descriptor is UI-facing: a real label, and a hint ONLY where the copy earns it.
        // A declared `description` is what the generic renderer turns into a `.plugin-setting-hint`
        // under the control (`src/frontend/main.ts` `buildSettingField`, called per descriptor by
        // `openPluginDialog`), and Context Compacting — the row this one sits next to in the pane —
        // declares SIX controls and ZERO descriptions. So the previous shape, "every one of the
        // seventeen rows must explain itself in >30 characters", is the assertion that LOCKED IN
        // the divergence, and it is replaced by the exact copy table below: eight rows now carry no
        // description at all, and the nine that do state something the label plus `min`/`max`
        // cannot answer (the two closed sets, the gates that no-op silently, the one horizon
        // sentence that covers all five horizons, and the withhold-only caveat once). Pinning the
        // table means a row that grows boilerplate back fails here, not in the pane.
        expect(
            (metadata.settings ?? []).map(
                (setting: HarnessPluginSettingDescriptor) => [setting.key, setting.description ?? null]
            )
        ).toEqual([
            ['enabled', 'Turns each policy off from the next turn; entries already withheld stay out.'],
            [
                'trimInvalidTools',
                'Trims nothing until a later included completed call answers every tool name it called.'
            ],
            ['invalidToolTurns', 'Protects the newest N tool turns; 0 protects none.'],
            [
                'invalidOutcomes',
                'Comma-separated subset of failed, rejected, cancelled, empty; empty means a blank result.'
            ],
            ['trimThoughts', null],
            ['thoughtTurns', null],
            ['minThoughtChars', null],
            ['dropSupersededToolCalls', null],
            ['supersededTurns', null],
            ['supersedeMatch', "'name' matches any later call of the tool; 'fingerprint' needs identical arguments."],
            [
                'dropDuplicateCalls',
                'Needs an exact re-run with identical arguments; supersedeMatch does not widen it.'
            ],
            ['duplicateTurns', null],
            ['truncateToolRequests', 'Drops the request entry only; its tool results stay in the request.'],
            ['truncateTurns', null],
            ['minTokens', 'Each tool axis must save this many tokens, or it writes nothing; thinking is never gated.'],
            ['safetyUnits', null],
            ['maxUnits', 'Tool units one axis may withhold per pass; 0 is unbounded, not disabled.']
        ]);

        // THE COPY BUDGET, as measured numbers rather than a mood: nine hints across seventeen rows
        // (was seventeen hints), 693 characters of hint in total (was 1,206), eight rows with no
        // hint, and the longest clause at 89 characters. `metadata.description` is 83 characters,
        // SHORTER than compaction's 87 — the row has to read at least as plainly as its neighbour.
        const hints = (metadata.settings ?? [])
            .map((setting) => setting.description)
            .filter((description): description is string => typeof description === 'string');

        expect(hints).toHaveLength(9);
        expect(hints.reduce((total, description) => total + description.length, 0)).toBe(693);
        expect(Math.max(...hints.map((description) => description.length))).toBe(89);
        expect((metadata.settings ?? []).length).toBe(hints.length + 8);

        for (const setting of metadata.settings ?? []) {
            expect(typeof setting.label).toBe('string');
            expect(setting.label.length).toBeGreaterThan(3);
        }

        // The rows that DO carry one stay one short clause: at most 90 characters, and one clause
        // (no second sentence after a period), which is what stops a hint turning back into the
        // multi-paragraph prose the clean-up removed.
        for (const description of hints) {
            expect(description.length).toBeLessThanOrEqual(90);
            expect(description).not.toMatch(/\.\s+\S/);
        }

        // A toggle's label names the whole action the way compaction's does (`Automatic
        // Compaction …`), so the headline options read alike in the pane. The 2026-11-13 grouping
        // pass also TITLE-CASED the object of every `Automatic …` label ("invalid tools" ->
        // "Invalid Tools", "Tool Request" -> "Tool Requests"), because these five labels now sit as
        // the heading row of their own category and a lower-case object reads as a sentence fragment
        // next to a title-case section heading. Pinned exactly, all five.
        const labelOf = (key: string): string =>
            (metadata.settings ?? []).find((setting) => setting.key === key)?.label ?? '';

        expect(labelOf('trimInvalidTools')).toBe('Automatic Trim Invalid Tools');
        expect(labelOf('trimThoughts')).toBe('Automatic Trim Thoughts');
        expect(labelOf('dropSupersededToolCalls')).toBe('Automatic Trim Superseded Tools');
        expect(labelOf('dropDuplicateCalls')).toBe('Automatic Trim Duplicate Tools');
        expect(labelOf('truncateToolRequests')).toBe('Automatic Truncate Tool Requests');
        expect(labelOf('invalidToolTurns')).toBe('Invalid tools · trim after (tool turns)');

        // The master switch keeps the wording that mirrors `title` — it is not one of the five
        // policy labels, and renaming it would move the framework-reserved row's identity on screen.
        expect(labelOf('enabled')).toBe('Context trimming');

        // The posture, stated by the plugin itself in ONE short sentence (R1): the long form used to
        // restate what every descriptor below already says, and 83 characters is also the number the
        // copy budget above is measured against (compaction's is 87, so this row is not the tall one).
        expect(metadata.description).toBe(
            'Withholds superseded tool units, stale tool requests and thinking; deletes nothing.'
        );
        expect(metadata.description.match(/\./g)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// A1 end to end: the flag, the cascade, and the provider request
// ---------------------------------------------------------------------------

// The scripted transport (mirrors src/harness.inclusion.test.ts): every request the transport
// receives is recorded, so "effectively excluded" is proven at the wire, not at the flag.
const copyMessages = (messages: readonly HarnessMessage[]): HarnessMessage[] =>
    JSON.parse(JSON.stringify(messages)) as HarnessMessage[];

const scripted = (turns: HarnessStreamEvent[][], seen: HarnessMessage[][]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen.push(copyMessages(request.messages));
        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// The pairing oracle of src/harness.inclusion.test.ts, re-expressed for one projected list: an
// excluded unit that leaked its assistant block or its result shows up here.
const pairIssues = (messages: readonly HarnessMessage[]): string[] => {
    const issues: string[] = [];
    const claimed = new Set<number>();

    messages.forEach((message, index) => {
        if (message.role !== 'assistant') return;

        const requested = message.toolCalls ?? [];

        if (requested.length === 0) return;

        const expected = requested.map((entry) => entry.id);
        const actual: string[] = [];
        let cursor = index + 1;

        while (cursor < messages.length && messages[cursor].role === 'tool') {
            actual.push((messages[cursor] as Extract<HarnessMessage, { role: 'tool' }>).toolCallId);
            claimed.add(cursor);
            cursor += 1;
        }

        if (actual.join(',') !== expected.join(',')) {
            issues.push(`assistant#${index}: expected [${expected.join(',')}] but paired [${actual.join(',')}]`);
        }
    });

    messages.forEach((message, index) => {
        if (message.role !== 'tool' || claimed.has(index)) return;
        issues.push(
            `orphan tool#${index}: ${(message as Extract<HarnessMessage, { role: 'tool' }>).toolCallId}`
        );
    });

    return issues;
};

// role + content + call ids, so a placement bug is readable in the diff.
const shape = (messages: readonly HarnessMessage[]): string[] =>
    messages.map((message) => {
        if (message.role === 'tool') return `tool:${message.toolCallId}:${message.content}`;

        if (message.role === 'assistant') {
            return `assistant:${message.content}:${(message.toolCalls ?? []).map((entry) => entry.id).join('|')}`;
        }

        return `${message.role}:${message.content}`;
    });

// The seeded conversation: a failed `alpha` call, then the SAME TOOL answered with different
// arguments, then an answer. Nothing is pre-flagged — the plugin has to decide.
const SEED: HarnessMessage[] = [
    { role: 'user', content: 'question' },
    call('c1', 'alpha', '{"path":"a.ts"}'),
    result('c1', 'alpha', 'Tool "alpha" failed: boom', 'failed'),
    call('c2', 'alpha', '{"path":"b.ts"}'),
    result('c2', 'alpha', 'A'),
    { role: 'assistant', content: 'answered' }
];

const trimmerPlugin = () => ({ name: metadata.name, metadata, setup });

// A host observer for the park the trim produces: `pause`/`resume` are real thread state
// changes, so "parked exactly once, on the trimming turn only" is a recorded-sequence
// assertion (the same surface src/plugin/context-compaction.test.ts pins for compaction).
const probe = (events: string[]) => ({
    name: 'probe',
    setup: (api: HarnessPluginApi) => {
        api.on('thread.paused', () => {
            events.push('paused');
        });
        api.on('thread.resumed', () => {
            events.push('resumed');
        });
    }
});

// A state-change stream as compact, order-significant keys — the same view
// src/harness.inclusion.test.ts (`changesOf`) uses to pin which writes notify.
const changesOf = (events: readonly HarnessStateChangeEvent[]): string[] =>
    events.map((event) => `${event.reason}:${event.agent ?? '-'}:${event.branchId ?? '-'}`);

// The provider these end-to-end tables run under: ONLY the trimmer's keys answer, every other
// (plugin, key) returns `undefined`, which is the harness's signal to fall back to the DECLARED
// default (src/plugin/settings.ts reads through this provider).
//
// THE HORIZONS ARE OPENED here, for the same reason `createFakeApi` seeds them to 0: these tables
// pin what the RUNTIME does with a decision — the pair-clean request, the flagged canonical
// history, the park, the notification — over a two-tool-turn conversation that the shipped horizon
// of 2 protects entirely. `the declared horizons protect the recent conversation end to end` below
// is the table that runs at the declared values instead.
const settingsOf = (values: Record<string, unknown>): HarnessPluginSettingsProvider => ({
    get: (plugin, key) =>
        plugin === metadata.name ? (values[key] ?? NO_HORIZON[key]) : undefined
});

describe('context-trimmer through a harness', () => {
    it('A1: withholds the superseded unit from the request while history keeps it, flagged', async () => {
        const seen: HarnessMessage[][] = [];
        const events: string[] = [];
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            // The horizons are opened (see `settingsOf`); the pair-clean request and the flagged
            // canonical history are what this table pins. `the declared horizons protect the recent
            // conversation end to end` is the table that runs at the shipped 2s.
            pluginSettings: settingsOf({}),
            plugins: [trimmerPlugin(), probe(events)],
            report: {
                stateChange: (event: HarnessStateChangeEvent) => {
                    changes.push(event);
                }
            }
        });

        await writer('go');

        // THE REQUEST: the failed block and its result are both gone — one unit, cascade and
        // all — and what is left is still pair-clean.
        expect(seen[0]).toEqual([
            { role: 'user', content: 'question' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'alpha', arguments: '{"path":"b.ts"}' }] },
            { role: 'tool', content: 'A', toolCallId: 'c2', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);
        expect(pairIssues(seen[0])).toEqual([]);

        // NOT DELETED: canonical history still holds all eight entries, in place, with the
        // trimmed unit flagged on BOTH members and nothing else touched.
        expect(shape(writer.agent.messages)).toEqual([
            'user:question',
            'assistant::c1',
            'tool:c1:Tool "alpha" failed: boom',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:'
        ]);
        expect(withoutIds(writer.agent.messages[1])).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'alpha', arguments: '{"path":"a.ts"}' }],
            included: false
        });
        expect(withoutIds(writer.agent.messages[2])).toStrictEqual({
            role: 'tool',
            content: 'Tool "alpha" failed: boom',
            toolCallId: 'c1',
            name: 'alpha',
            outcome: 'failed',
            included: false
        });
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(2);
        // `false` is the only stored spelling, so re-enabling stays the exact inverse.
        expect(JSON.stringify(writer.agent.messages)).not.toContain('"included":true');

        // The park happened exactly once, around the trimming turn. The five changes below are
        // the run's own user append, the pause and the resume (the park's own `thread` state
        // changes), the round's single COALESCED flag write, and the committed answer — the
        // 3 × `agent_message` shape src/harness.inclusion.test.ts:3226 pins for a plugin write
        // inside `turn.before`, bracketed by the park. A per-write notifier would have made
        // six.
        expect(events).toEqual(['paused', 'resumed']);
        expect(changesOf(changes)).toEqual([
            'agent_message:writer:-',
            'thread:writer:-',
            'thread:writer:-',
            'agent_message:writer:-',
            'agent_message:writer:-'
        ]);
    });

    it('A5: a second turn re-runs the plan, writes nothing, and never parks again', async () => {
        const seen: HarnessMessage[][] = [];
        const events: string[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            // The horizons are opened for this table too (see `settingsOf`): what it pins is that a
            // SECOND run re-derives the same plan, writes NOTHING and never parks again — which is
            // only interesting once the first run did trim.
            pluginSettings: settingsOf({}),
            plugins: [trimmerPlugin(), probe(events)]
        });

        await writer('go');
        await writer('again');

        expect(events).toEqual(['paused', 'resumed']);

        // The unit stays excluded on every later turn, with no further write at all.
        expect(shape(seen[1])).toEqual([
            'user:question',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:',
            'user:again'
        ]);
        expect(pairIssues(seen[1])).toEqual([]);
    });

    it('A5: `enabled: false` leaves the superseded unit in the request and parks nothing', async () => {
        const seen: HarnessMessage[][] = [];
        const events: string[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            pluginSettings: settingsOf({ enabled: false }),
            plugins: [trimmerPlugin(), probe(events)]
        });

        await writer('go');

        expect(shape(seen[0])).toEqual([
            'user:question',
            'assistant::c1',
            'tool:c1:Tool "alpha" failed: boom',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go'
        ]);
        expect(pairIssues(seen[0])).toEqual([]);
        expect(events).toEqual([]);
        expect(writer.agent.messages.filter((message) => message.included === false)).toEqual([]);
    });

    // THE POSTURE, end to end: with the two tool switches off (not the plugin), the request
    // carries every recorded entry in canonical order, nothing is flagged, nothing parks, and
    // the only state changes are the run's own — the acceptance criterion H1.
    it('H1: both tool policies off sends every recorded entry and writes nothing at all', async () => {
        const seen: HarnessMessage[][] = [];
        const events: string[] = [];
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            pluginSettings: settingsOf({
                dropSupersededToolCalls: false,
                trimInvalidTools: false
            }),
            plugins: [trimmerPlugin(), probe(events)],
            report: {
                stateChange: (event: HarnessStateChangeEvent) => {
                    changes.push(event);
                }
            }
        });

        await writer('go');

        expect(shape(seen[0])).toEqual([
            'user:question',
            'assistant::c1',
            'tool:c1:Tool "alpha" failed: boom',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go'
        ]);
        expect(pairIssues(seen[0])).toEqual([]);
        expect(events).toEqual([]);
        expect(writer.agent.messages.filter((message) => message.included === false)).toEqual([]);

        // No `agent_message` flag-write in the middle of the run: user append, then the
        // committed answer — the 2 events A1's 5 would otherwise grow into.
        expect(changesOf(changes)).toEqual(['agent_message:writer:-', 'agent_message:writer:-']);
    });

    // Switch INDEPENDENCE at the harness level: turning ONE of the two tool switches off leaves
    // the other withholding the same pair, so a mid-session flip of one cannot switch the
    // other off by accident (acceptance criterion H2).
    it('H2: `dropSupersededToolCalls: false` alone still withholds the pair through the generalisation', async () => {
        const seen: HarnessMessage[][] = [];
        const events: string[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            pluginSettings: settingsOf({ dropSupersededToolCalls: false }),
            plugins: [trimmerPlugin(), probe(events)]
        });

        await writer('go');

        expect(shape(seen[0])).toEqual([
            'user:question',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go'
        ]);
        expect(pairIssues(seen[0])).toEqual([]);
        expect(events).toEqual(['paused', 'resumed']);
    });

    // T3b, end to end: the PATCH edge accepts ANY string for a tier (it owns type and bounds,
    // never content), so the honest half lives HERE — the plugin's next pass report names the
    // documented fallback that actually ran, alongside the value the operator stored.
    it('T3b: a garbage tier value is used as the documented fallback and named in the pass report', async () => {
        const seen: HarnessMessage[][] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            pluginSettings: settingsOf({
                invalidOutcomes: 'bogus',
                supersedeMatch: 'loose'
            }),
            plugins: [trimmerPlugin()],
            report: {
                diagnostic: (event: HarnessDiagnosticEvent) => {
                    diagnostics.push(event);
                }
            }
        });

        await writer('go');

        // The rule still ran (the shipped switch is on), so the pass reported exactly once.
        expect(diagnostics.map((event) => `${event.type}:${event.kind}:${event.owner}`)).toEqual([
            'plugin_diagnostic:policy:context-trimmer'
        ]);
        expect(diagnostics[0].message).toContain('supersedeMatch "loose" is not a matcher; used "name"');
        expect(diagnostics[0].message).toContain(
            'invalidOutcomes "bogus" has unknown names; used none (the generalisation is off)'
        );

        const policy = (diagnostics[0].data as { policy: Record<string, unknown> }).policy;

        expect(policy).toMatchObject({
            invalidOutcomes: '',
            invalidOutcomesSubmitted: 'bogus',
            supersedeMatch: 'name',
            supersedeMatchSubmitted: 'loose',
            fired: ['dropSupersededToolCalls']
        });

        // And the request is the shipped one: the unknown outcome set disabled only the
        // generalisation, which the shipped switch already covers.
        expect(shape(seen[0])).toEqual([
            'user:question',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go'
        ]);
        expect(pairIssues(seen[0])).toEqual([]);
    });
    // THE TRUNCATE PROMISE, AT THE WIRE (2026-11-13 review). Everything this axis had before this
    // table was plan-level or fake-api-level: a recorded `setIncluded(leader, false)` and a report
    // line naming the results. What the operator actually asked for — "actually remove tool request
    // …, only keeping the tool response in the context" — is only answerable through a REAL harness:
    // the request must carry the surviving RESULT as an ownerless `tool` message, the exact shape the
    // transport maps at src/transport/openai.ts:394-398 (`{ role: 'tool', tool_call_id, content }`),
    // and the pairing oracle borrowed from src/harness.inclusion.test.ts must report EXACTLY the one
    // orphan the switch promises — one result whose request left, and no other half-pair.
    it('TRUNCATE end to end: the request leaves and the response rides on as an ownerless tool message', async () => {
        const seen: HarnessMessage[][] = [];
        const events: string[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    messages: SEED,
                    stream: scripted([answer('settled')], seen)
                })
            },
            tools: {
                alpha: tool({
                    description: 'Echo tool alpha.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => 'A'
                })
            },
            presets: false,
            // Horizons open (see `settingsOf`), truncate asked for. The shipped tool rules stay on, so
            // the failed unit still leaves WHOLE — which is what makes the truncate candidate here the
            // ANSWERING unit, the one whose result has to survive the loss of its own call.
            pluginSettings: settingsOf({ truncateToolRequests: true }),
            plugins: [trimmerPlugin(), probe(events)],
            report: {
                diagnostic: (event: HarnessDiagnosticEvent) => {
                    diagnostics.push(event);
                }
            }
        });

        await writer('go');

        // THE REQUEST the provider is handed. Unit 0 (the failed call plus its result) is withheld
        // whole, the answering REQUEST entry is withheld ALONE, and its result is the only tool
        // message left — ownerless, because no assistant entry in this request asks for `c2`.
        expect(seen[0]).toEqual([
            { role: 'user', content: 'question' },
            { role: 'tool', content: 'A', toolCallId: 'c2', name: 'alpha' },
            { role: 'assistant', content: 'answered' },
            { role: 'user', content: 'go' }
        ]);

        // THE ONE ORPHAN, and only it. `pairIssues` is the oracle that fails a half-emitted unit, so
        // this asserts both halves of the promise at once: the switch left exactly one unclaimed
        // result (the feature), and the whole-unit trim leaked no pair of its own.
        expect(pairIssues(seen[0])).toEqual(['orphan tool#1: c2']);

        // NOTHING WAS DELETED: every canonical entry is still in place, and the flag sits on exactly
        // the three entries this pass wrote — the failed unit's two, and the request alone. The
        // surviving result carries NO flag, which is the difference between a truncation and a trim.
        expect(shape(writer.agent.messages)).toEqual([
            'user:question',
            'assistant::c1',
            'tool:c1:Tool "alpha" failed: boom',
            'assistant::c2',
            'tool:c2:A',
            'assistant:answered:',
            'user:go',
            'assistant:settled:'
        ]);
        expect(withoutIds(writer.agent.messages[3])).toStrictEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c2', name: 'alpha', arguments: '{"path":"b.ts"}' }],
            included: false
        });
        expect((writer.agent.messages[4] as { included?: boolean }).included).toBeUndefined();
        expect(writer.agent.messages.filter((message) => message.included === false)).toHaveLength(3);
        // `false` remains the only stored spelling, so an operator can still switch all three back.
        expect(JSON.stringify(writer.agent.messages)).not.toContain('"included":true');

        // One pass, one park, one report — and the report's truncate section names the result that
        // stays, with the canonical index the request-level assertion above just confirmed.
        expect(events).toEqual(['paused', 'resumed']);
        expect(diagnostics.map((event) => `${event.type}:${event.kind}:${event.owner}`)).toEqual([
            'plugin_diagnostic:policy:context-trimmer'
        ]);
        expect(diagnostics[0].message).toContain('context-trimmer truncated 1 tool request(s):');
        expect(diagnostics[0].message).toContain('results kept #4');
        expect(
            (diagnostics[0].data as { truncated: { index: number; results: number[] }[] }).truncated.map(
                (row) => [row.index, row.results]
            )
        ).toEqual([[3, [4]]]);
    });
});

// ---------------------------------------------------------------------------
// T6 — THE THINKING RULE: the horizon, the writes, the report, and the two floors
// ---------------------------------------------------------------------------
//
// `trimThoughts` is the second axis (with `thoughtTurns` as its horizon): it withholds the model's
// own recorded thinking while the entry itself keeps travelling. The write is the per-entry FLAG
// `reasoningIncluded: false` (../types `HarnessTurnBeforeContext.setReasoningIncluded`), never a text
// edit, and the projection resolves the flag by omitting `reasoning` from that entry's request copy —
// the shape assertions for that live in src/harness.inclusion.test.ts, where a real run and a real
// transport are available. What THIS section pins is the POLICY and the WRITES: which entries the
// horizon selects, what each floor rejects, what one pass writes and reports, and that the thinking
// side and the tool side never gate each other. (The pre-uplift shape this section used to pin — the
// `dropOldThoughts` off|turn|all tier and its `thoughtKeepUnits` rescue — is gone: the horizon
// answers "which thinking" in one number, and it IS the recent-N protection.)
//
// THE HORIZON COUNTS THOUGHTS, newest-first, not turns and not units: `thoughtTurns: 2` protects the
// two newest recorded thoughts, and `0` reaches the open turn's thinking too. THE LAST `user` ENTRY is
// still the turn boundary, and still REPORTED (`turn: 'open' | 'closed'` on every candidate, because
// the operator's line says which turn a write came out of) — it no longer GATES anything, so the
// fixtures below place their user entries deliberately and each expected list says which side of that
// line every entry sits on.

// An assistant entry that CARRIES thinking of exactly `chars` characters. Every character figure
// asserted in this section is one of these literals — never a count taken back off an implementation
// run — because the thinking axis measures CHARACTERS (the estimator does not count reasoning, so a
// token figure here would be a number this plugin cannot compute).
const think = (content: string, chars: number): HarnessMessage => ({
    role: 'assistant',
    content,
    reasoning: 'x'.repeat(chars)
});

// An assistant TOOL-CALL block that also carries thinking, for the one fixture where both axes act
// on the same transcript.
const callThinking = (id: string, name: string, args: string, chars: number): HarnessMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, arguments: args }],
    reasoning: 'x'.repeat(chars)
});

// The thinking transcript. Canonical indexes are the contract, so the layout is spelled out:
//   0 user    'question'                 opens turn 1
//   1 assistant 10 chars of thinking     CLOSED  (a candidate under `turn` and `all`)
//   2 user    'again'                    closes turn 1, opens turn 2
//   3 assistant 20 chars of thinking     CLOSED  (a candidate under `turn` and `all`)
//   4 assistant, NO thinking             never a candidate: flagging it would be a write, a
//                                        notification and a save for zero effect
//   5 user    'now'                      THE BOUNDARY — everything after it is the open turn
//   6 assistant 30 chars of thinking     OPEN    (only `all` may touch it)
const THOUGHTS: readonly HarnessMessage[] = [
    { role: 'user', content: 'question' },
    think('one', 10),
    { role: 'user', content: 'again' },
    think('two', 20),
    { role: 'assistant', content: 'three' },
    { role: 'user', content: 'now' },
    think('four', 30)
];

// The readable form of a thinking plan: exactly the fields a table case is about. `chars` stays in
// it because the floor is measured over it; `turn` and `turnsAgo` stay in it because they are what
// an operator reads to find out WHICH thought left and HOW old it was — the two numbers the report
// line carries, and the only way to tell "the current turn's thinking" from "something from last
// week" without opening the transcript.
const thoughtShape = (plan: readonly ThoughtCandidate[]) =>
    plan.map((candidate) => ({
        index: candidate.entryIndex,
        messageId: candidate.entryMessageId,
        turn: candidate.turn,
        turnsAgo: candidate.turnsAgo,
        chars: candidate.chars,
        firedBy: candidate.firedBy,
        horizon: candidate.horizon
    }));

describe('context-trimmer thinking plan (planWithheldThoughts)', () => {
    it('the switch off has no thinking write at all, whatever else is configured', () => {
        // Every horizon, every floor, the whole transcript: off is the engine's posture, so no flag
        // exists to write (the independence from the tool switches starts here).
        for (const thoughtTurns of [0, 1, 2, 5]) {
            expect(
                thoughtShape(
                    planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ trimThoughts: false, thoughtTurns }))
                )
            ).toEqual([]);
        }

        expect(
            thoughtShape(
                planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ trimThoughts: false, minThoughtChars: 1 }))
            )
        ).toEqual([]);
    });

    it('the horizon protects the N newest thoughts — the N / N+1 boundary, exactly', () => {
        // `ago` over THOUGHTS: entry 6 is the newest thought (0), 3 is the one above it (1), 1 is
        // two above (2). A horizon of N admits `ago >= N`, so each row is one entry different, and
        // the step from N to N+1 moves EXACTLY the thought that sits at `ago === N`.
        const table: Array<[number, number[]]> = [
            [0, [1, 3, 6]],
            [1, [1, 3]],
            [2, [1]],
            [3, []],
            [5, []],
            // A nonsense horizon is "protect nothing", the same reading every other number edge in
            // this plugin gives a -1 or a NaN.
            [-5, [1, 3, 6]],
            [Number.NaN, [1, 3, 6]]
        ];

        for (const [thoughtTurns, indexes] of table) {
            expect(
                planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ thoughtTurns })).map(
                    (candidate) => candidate.entryIndex
                )
            ).toEqual(indexes);
        }
    });

    it('the DEFAULT horizon leaves the two newest thoughts alone, open turn included', () => {
        const plan = planWithheldThoughts(entriesFrom(THOUGHTS), TRIMMER_DEFAULT_SETTINGS);

        // Exact candidate objects, hardcoded from the fixture: entry 1 is the only thought two or
        // more thoughts old. `turn` is report context, not a rule — it says which side of the last
        // user entry the entry sits on — and `turnsAgo` plus `horizon` are the comparison itself.
        expect(plan).toEqual([
            {
                entryIndex: 1,
                entryMessageId: 'msg-2',
                turn: 'closed',
                turnsAgo: 2,
                chars: 10,
                firedBy: 'trimThoughts',
                horizon: 2
            }
        ]);
        // The declared default IS 2, which is why the current turn's thinking (thought `ago` 0) is
        // safe out of the box without a separate tier for it.
        expect(TRIMMER_DEFAULT_SETTINGS.thoughtTurns).toBe(2);
        expect(thoughtShape(planWithheldThoughts(entriesFrom(THOUGHTS)))).toEqual([
            {
                index: 1,
                messageId: 'msg-2',
                turn: 'closed',
                turnsAgo: 2,
                chars: 10,
                firedBy: 'trimThoughts',
                horizon: 2
            }
        ]);
    });

    it('the horizon counts THOUGHT ENTRIES — not turns, not units, not `iteration`', () => {
        // One CLOSED turn carrying three thoughts in a row (a multi-call turn: the block, a second
        // block, and a plain message), then the boundary user entry, then the open turn's thought.
        // A knob counting TURNS would see 2 turns and protect all three thoughts; a knob counting
        // UNITS would see the tool units; this one sees 4 thoughts.
        const MANY: readonly HarnessMessage[] = [
            { role: 'user', content: 'open' },
            think('a', 10),
            think('b', 20),
            think('c', 30),
            { role: 'user', content: 'next' },
            think('open', 40)
        ];

        // Thoughts: 5 (ago 0), 3 (1), 2 (2), 1 (3). Horizon 2 therefore admits 1 and 2 only.
        expect(
            planWithheldThoughts(entriesFrom(MANY), settingsWith({ thoughtTurns: 2 })).map(
                (candidate) => ({ index: candidate.entryIndex, turnsAgo: candidate.turnsAgo })
            )
        ).toEqual([
            { index: 1, turnsAgo: 3 },
            { index: 2, turnsAgo: 2 }
        ]);

        // And the rank map does NOT renumber when a flag is written: the same transcript with entry
        // 5 already flagged reaches the same verdicts, which is the idempotence proof in numbers.
        const flagged = entriesFrom(MANY);

        (flagged[5].message as { reasoningIncluded?: boolean }).reasoningIncluded = false;

        expect(
            planWithheldThoughts(flagged, settingsWith({ thoughtTurns: 2 })).map((candidate) => ({
                index: candidate.entryIndex,
                turnsAgo: candidate.turnsAgo
            }))
        ).toEqual([
            { index: 1, turnsAgo: 3 },
            { index: 2, turnsAgo: 2 }
        ]);

        // `iteration` cannot express any of this: the fake turn reports `iteration: 1` for the whole
        // conversation, while the ranks above are conversation-level positions.
    });

    it('an entry with no thinking, and an entry whose thinking is already flagged, are never candidates', () => {
        // Entry 4 has no `reasoning` key at all: flagging it would be a write, a notification and a
        // save for zero effect.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ thoughtTurns: 0 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([1, 3, 6]);

        // An EMPTY reasoning string is the same case one level down: nothing to remove.
        expect(
            planWithheldThoughts(
                entriesFrom([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning: '' }]),
                settingsWith({ thoughtTurns: 0 })
            )
        ).toEqual([]);
    });

    it('a second pass over an already-flagged transcript has no candidate left, and neither has a restored one', () => {
        const entries = entriesFrom(THOUGHTS);

        // Pass one through the policy: every thought, horizon open.
        const first = planWithheldThoughts(entries, settingsWith({ thoughtTurns: 0 })).map(
            (candidate) => candidate.entryIndex
        );

        expect(first).toEqual([1, 3, 6]);

        // The write, applied the way the runtime applies it — on the canonical MESSAGE object, which
        // is what `entries` hands out.
        for (const index of first) {
            (entries[index].message as { reasoningIncluded?: boolean }).reasoningIncluded = false;
        }

        expect(planWithheldThoughts(entries, settingsWith({ thoughtTurns: 0 })).length).toBe(0);

        // A RESTART, modelled exactly: a fresh entry list (no in-process state survives) whose
        // messages carry the flags the first process wrote. Re-deriving finds all three already
        // flagged and proposes nothing, so a continued session writes no duplicate flags.
        const restored = entriesFrom(
            THOUGHTS.map((message, index) =>
                index === 1 || index === 3 || index === 6 ? { ...message, reasoningIncluded: false } : message
            )
        );

        expect(planWithheldThoughts(restored, settingsWith({ thoughtTurns: 0 }))).toEqual([]);
    });

    it('skips an entry the model never sees and an entry this pass already excludes', () => {
        // `entry.included === false` is the live per-entry flag: an entry that is not in the request
        // cannot have its thinking removed from it, so a flag would cost a write and change nothing
        // (and the next pass after a re-enable picks it up).
        expect(
            thoughtShape(
                planWithheldThoughts(entriesFrom(THOUGHTS, [3]), settingsWith({ thoughtTurns: 0 }))
            )
        ).toEqual([
            {
                index: 1,
                messageId: 'msg-2',
                turn: 'closed',
                turnsAgo: 2,
                chars: 10,
                firedBy: 'trimThoughts',
                horizon: 0
            },
            {
                index: 6,
                messageId: 'msg-7',
                turn: 'open',
                turnsAgo: 0,
                chars: 30,
                firedBy: 'trimThoughts',
                horizon: 0
            }
        ]);

        // The TOOL side is withholding entry 1's whole unit THIS pass, so its thinking leaves with
        // it: no flag, and — the part that matters — no characters counted toward the floor.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ thoughtTurns: 0 }),
                new Set([1, 2])
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([3, 6]);

        // The rank map is unchanged by that skip, so the two remaining candidates still report the
        // ages the transcript says they have.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ thoughtTurns: 0 }), new Set([1, 2])).map(
                (candidate) => ({ index: candidate.entryIndex, turnsAgo: candidate.turnsAgo })
            )
        ).toEqual([
            { index: 3, turnsAgo: 1 },
            { index: 6, turnsAgo: 0 }
        ]);
    });

    it('a transcript with no user entry is ALL one turn, and the horizon still decides — never index arithmetic', () => {
        const noUser = entriesFrom([think('one', 10), think('two', 20)]);

        // There is no last user entry, so both entries are the open turn and BOTH are reportable as
        // `open`. The horizon, not a tier, is what keeps the newest one.
        expect(planWithheldThoughts(noUser, settingsWith({ thoughtTurns: 2 }))).toEqual([]);
        expect(
            planWithheldThoughts(noUser, settingsWith({ thoughtTurns: 1 })).map((candidate) => ({
                index: candidate.entryIndex,
                turn: candidate.turn,
                turnsAgo: candidate.turnsAgo
            }))
        ).toEqual([{ index: 0, turn: 'open', turnsAgo: 1 }]);
    });

    it('minThoughtChars rejects the thinking side BELOW the floor, over what the horizon leaves, and 0 is inert', () => {
        // The would-be total with the horizon open is 10 + 20 + 30 = 60 characters.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ thoughtTurns: 0, minThoughtChars: 61 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([]);
        // Exactly at the floor is NOT below it, so the pass writes — the boundary is `chars < floor`.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ thoughtTurns: 0, minThoughtChars: 60 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([1, 3, 6]);
        // ORDER: horizon → floor. The shipped 2-thought horizon leaves only the 10-character entry
        // in play, so a floor of 11 rejects a pass the OPEN horizon would have cleared — the floor
        // measures what would ACTUALLY be written, never the transcript's whole thinking.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ thoughtTurns: 2, minThoughtChars: 11 })
            )
        ).toEqual([]);
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ thoughtTurns: 2, minThoughtChars: 10 })
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([1]);
        // An entry this pass already excludes contributes NOTHING to that total (the tool side took
        // it whole): with entry 6 gone the would-be total is 10 + 20 = 30, not the transcript's 60.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ thoughtTurns: 0, minThoughtChars: 51 }),
                new Set([6])
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([]);
        // The same floor WITHOUT the exclusion clears, which is the proof the removed entry was
        // subtracted rather than merely left unflagged.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ thoughtTurns: 0, minThoughtChars: 51 })
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([1, 3, 6]);
        // Exactly at the reduced total writes.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ thoughtTurns: 0, minThoughtChars: 30 }),
                new Set([6])
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([1, 3]);
        // 0 (the shipped default) measures nothing at all, and a 1-character thinking entry still
        // writes with the floor off.
        expect(
            planWithheldThoughts(
                entriesFrom([think('tiny', 1)]),
                settingsWith({ thoughtTurns: 0, minThoughtChars: 0 })
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([0]);
        // A nonsense floor behaves as 0, like every other number edge in this plugin.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ minThoughtChars: -5 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([1, 3, 6]);
    });

    it('minTokens NEVER gates the thinking side, at any value (the estimator does not count reasoning)', () => {
        const entries = entriesFrom(THOUGHTS);

        // The plan function does not read the token floor at all: an unreachable one leaves the
        // thinking plan identical to the default one, character for character.
        expect(planWithheldThoughts(entries, settingsWith({ minTokens: 1000000 }))).toEqual(
            planWithheldThoughts(entries, settingsWith({}))
        );

        // And the TOOL side is gated by exactly that value on the same transcript shape, so the two
        // floors really are two separate measurements (the proof deferred from T5).
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ minTokens: 1000000 }))).toEqual([]);
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), TRIMMER_DEFAULT_SETTINGS)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// T6 — the thinking WRITES and the one-diagnostic REPORT
// ---------------------------------------------------------------------------
// The `data.thoughts` entries of a pass over THOUGHTS with the horizon OPEN (what `createFakeApi`
// seeds — see the note there), spelled out once because half the cases below need them and each one
// is a line the operator reads: the entry, its durable id, WHICH TURN it belongs to, how many
// THOUGHTS old it was, and the characters the flag removes. `horizon` is the value the age was
// compared against, so a reader can re-derive the decision from the record alone.
const THOUGHTS_REPORT = [
    { index: 1, messageId: 'msg-2', turn: 'closed', turnsAgo: 2, chars: 10, firedBy: 'trimThoughts', horizon: 0 },
    { index: 3, messageId: 'msg-4', turn: 'closed', turnsAgo: 1, chars: 20, firedBy: 'trimThoughts', horizon: 0 },
    { index: 6, messageId: 'msg-7', turn: 'open', turnsAgo: 0, chars: 30, firedBy: 'trimThoughts', horizon: 0 }
];

// The one message that pass writes, hardcoded from the format and the fixture — the byte-identity
// claim for the thinking section, in the same style as A1's for the tool section. The age is counted
// in THOUGHTS (entry 6 is 0 old, 3 is 1 old, 1 is 2 old) and the figure is characters, never tokens:
// the estimator does not count reasoning, so a token figure here would be a number the pass cannot
// compute.
const THOUGHTS_MESSAGE =
    'context-trimmer withheld 3 thinking entry(s): ' +
    '#1 msg-2 closed 2 thoughts old 10 chars via trimThoughts=0; ' +
    '#3 msg-4 closed 1 thoughts old 20 chars via trimThoughts=0; ' +
    '#6 msg-7 open 0 thoughts old 30 chars via trimThoughts=0';

// The SAME transcript at the shipped horizon (2 thoughts): only the oldest entry is old enough, and
// the line says so with `2 thoughts old` next to `trimThoughts=2` — the age and the bound that
// accepted it, side by side.
const DECLARED_THOUGHTS_MESSAGE =
    'context-trimmer withheld 1 thinking entry(s): #1 msg-2 closed 2 thoughts old 10 chars via trimThoughts=2';
// A COPY with the shipped horizon in it — the shared row above must stay untouched, because half the
// tables below compare against it with `horizon: 0`.
const DECLARED_THOUGHTS_REPORT = [{ ...THOUGHTS_REPORT[0], horizon: 2 }];

// The tool rule AND the thinking rule on one transcript, so the two axes can be pinned inside ONE
// pass — one pause window, one diagnostic, one report:
//   0 user    'question'
//   1 assistant TOOL BLOCK, 10 chars of thinking  ← the all-`failed` unit's leader, CLOSED
//   2 tool    c1 `failed`
//   3 assistant TOOL BLOCK, 20 chars of thinking  ← the answering unit (a KEEP), CLOSED
//   4 tool    c2 completed
//   5 user    'now'                                ← THE BOUNDARY
//   6 assistant, 30 chars of thinking              OPEN — protected by the horizon, not by the tier
const THOUGHTS_AND_UNIT: readonly HarnessMessage[] = [
    { role: 'user', content: 'question' },
    callThinking('c1', 'read', '{"path":"a.ts"}', 10),
    result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
    callThinking('c2', 'read', '{"path":"b.ts"}', 20),
    result('c2', 'read', 'export const b = 2;'),
    { role: 'user', content: 'now' },
    think('open', 30)
];

// The `units` record of a baseline pass over THOUGHTS_AND_UNIT — the same object three tables below
// have to match byte for byte, and the shape the whole-unit axis has always shipped.
const UNIT_RECORD = {
    index: 1,
    messageId: 'msg-2',
    members: [1, 2],
    // The pass wrote the unit's REQUEST entry too (nothing was pre-withheld), which is the baseline
    // every completion case below is the contrast against.
    requestAlreadyWithheld: false,
    outcomes: ['failed'],
    invalidOutcomes: ['failed'],
    names: ['read'],
    supersededBy: 'msg-4',
    firedBy: 'dropSupersededToolCalls',
    admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools']
};

describe('context-trimmer thinking writes and report (T6)', () => {
    it('writes the flag on exactly the eligible entries and reports one thinking-only pass', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);

        await expect(executeTrimming(api, createFakeTurn({ api, calls, entries }))).resolves.toBeUndefined();

        // One write per candidate, canonical order, and NOTHING else touched — no `setIncluded`, no
        // `edit`, no `replaceHistory`, no `setTranscript`. The thinking-less entry (4) is not in it:
        // flagging it would be a write, a notification and a save for zero effect.
        expect(calls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        // The WRITE is the flag, on the canonical message, and only `false` is ever stored: no entry
        // gained `true`, which is what keeps a later restore exact.
        expect((entries[1].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[3].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[6].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[4].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBeUndefined();
        expect(calls.every((call) => call.endsWith(':false'))).toBe(true);
        // The THINKING TEXT SURVIVES the write — the flag is not an edit, which is what keeps this
        // plugin's "nothing is deleted, it can be switched back on" promise true for thinking.
        expect(entries[1].message).toMatchObject({ reasoning: 'x'.repeat(10) });
        expect(entries[3].message).toMatchObject({ reasoning: 'x'.repeat(20) });
        // One settings read set plus the diagnostic: a pass has exactly one report.
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);

        expect(diagnostics).toHaveLength(1);
        // NO tool section and NO truncate section on a thinking-only pass — both are conditional, so
        // the message a tool-only pass has always written stays byte-identical.
        expect(diagnostics[0].message).toBe(THOUGHTS_MESSAGE);
        expect(diagnostics[0].data).toEqual({
            units: [],
            truncated: [],
            thoughts: THOUGHTS_REPORT,
            // `fired` names the ONE switch that accounts for these writes — and only it. Without the
            // plan-is-empty guard, `[].every` would have reported every tool switch as fired for
            // units that do not exist in this pass.
            policy: { ...DEFAULT_POLICY, fired: ['trimThoughts'] }
        });
    });

    it('the DEFAULT horizon reaches exactly the entries older than two thoughts, end to end', async () => {
        // Nothing overridden: the shipped 2-thought horizon, which is the posture an operator gets
        // without touching the pane. `createFakeApi` opens the horizons for the predicate tables, so
        // this table asks for the declared ones.
        const { api, diagnostics } = createFakeApi({ atDeclaredHorizons: true });
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        // The two newest thoughts (entries 3 and 6, ranks 1 and 0) keep riding; the 2-thoughts-old
        // one goes. The OPEN turn is not special here — entry 6 survives because of its rank, and a
        // 3rd-from-newest open-turn thought would go with the horizon at 2.
        expect(calls).toEqual(['setReasoningIncluded:1:false']);
        expect((entries[3].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBeUndefined();
        expect((entries[6].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBeUndefined();
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(DECLARED_THOUGHTS_MESSAGE);
        expect((diagnostics[0].data as { thoughts: unknown[] }).thoughts).toEqual(DECLARED_THOUGHTS_REPORT);
        // Every horizon in the record is the shipped 2 — the report is the operator's only way to
        // learn what bound produced the line they are reading.
        expect(policyOf(diagnostics[0])).toEqual({ ...DECLARED_DEFAULT_POLICY, fired: ['trimThoughts'] });
    });

    it('is idempotent: a second pass over the transcript it just wrote writes, notifies, saves and reports NOTHING', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);
        const context = createFakeTurn({ api, calls, entries });

        await executeTrimming(api, context);

        expect(calls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        expect(diagnostics).toHaveLength(1);

        // Same round, same transcript, settings unchanged. The fake flips the very field the policy
        // re-reads, so this is the real re-derive, not a fake that forgot.
        await executeTrimming(api, context);

        expect(calls).toHaveLength(3);
        expect(diagnostics).toHaveLength(1);
        // The only thing the second round cost was the settings reads — no write, no notification,
        // and therefore no save, and no diagnostic.
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic', ...TURN_READS]);
    });

    it('a number switch submitted as anything else runs the DECLARED horizon and adds no clause', async () => {
        // The string tiers own the fallback clause (`invalidOutcomes`, `supersedeMatch`). A horizon is
        // a NUMBER, and a non-number resolves to the declared default in the read itself — so the
        // pass runs the shipped 2 and the message carries no complaint, exactly like `minTokens: -5`.
        const { api, touches, diagnostics } = createFakeApi({ thoughtTurns: 'sometimes' });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS) }));

        // Behaviour: the declared horizon 2, i.e. the oldest thought only.
        expect(calls).toEqual(['setReasoningIncluded:1:false']);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);
        expect(diagnostics).toHaveLength(1);
        // The line names `trimThoughts=2`, the value that RAN, and nothing else.
        expect(diagnostics[0].message).toBe(DECLARED_THOUGHTS_MESSAGE);
        expect((diagnostics[0].data as { thoughts: Array<{ horizon: number }> }).thoughts).toEqual(
            DECLARED_THOUGHTS_REPORT
        );
        // Only the switch that was mis-submitted resolves to its declared value — the other horizons
        // are the opened baseline this fake seeds, and the report says so next to each rule.
        expect(policyOf(diagnostics[0])).toEqual({
            ...DEFAULT_POLICY,
            thoughtTurns: 2,
            fired: ['trimThoughts']
        });
    });

    it('minTokens cannot suppress a thinking write at any value, while the same floor still empties the tool side', async () => {
        // The estimator never counts `reasoning` (../core/context-estimate.ts), so a token floor
        // shared with the thinking writes would silently disable `trimThoughts` above 0 — the proof
        // deferred from T5, and the reason the two floors are two measurements.
        const { api, diagnostics } = createFakeApi({ minTokens: 1000000 });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS) }));

        expect(calls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(THOUGHTS_MESSAGE);

        // Same fixture with a TOOL candidate next to it: the unreachable floor drops the unit write
        // and every thinking write survives — including the leader's own, which the same pass no
        // longer excludes from the request (rule (3b) reads the PLAN, not the settings, and the plan
        // is empty once the token gate has spoken).
        const toolFloor = createFakeApi({ minTokens: 1000000 });
        const toolCalls: string[] = [];

        await executeTrimming(
            toolFloor.api,
            createFakeTurn({ api: toolFloor.api, calls: toolCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(toolCalls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        expect((toolFloor.diagnostics[0].data as { units: unknown[] }).units).toEqual([]);
        expect(
            (toolFloor.diagnostics[0].data as { thoughts: unknown[] }).thoughts
        ).toEqual(THOUGHTS_REPORT);
        expect((toolFloor.diagnostics[0].data as { policy: { fired: string[] } }).policy.fired).toEqual([
            'trimThoughts'
        ]);
    });

    it('minThoughtChars bites at the pass level, and the TOOL side is untouched by it', async () => {
        // Above the 60 characters this pass would remove: nothing at all happens — no flag, no
        // notification, no save, no diagnostic.
        const high = createFakeApi({ minThoughtChars: 61 });
        const highCalls: string[] = [];

        await executeTrimming(
            high.api,
            createFakeTurn({ api: high.api, calls: highCalls, entries: entriesFrom(THOUGHTS) })
        );

        expect(highCalls).toEqual([]);
        expect(high.diagnostics).toEqual([]);
        expect(high.touches).toEqual([...TURN_READS]);

        // Exactly at the floor it writes (the comparison is `chars < floor`).
        const exact = createFakeApi({ minThoughtChars: 60 });
        const exactCalls: string[] = [];

        await executeTrimming(
            exact.api,
            createFakeTurn({ api: exact.api, calls: exactCalls, entries: entriesFrom(THOUGHTS) })
        );

        expect(exactCalls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);

        // THE INDEPENDENCE, in the other direction: a floor that suppresses the thinking side leaves
        // the tool rule's message BYTE-IDENTICAL to A1's — no empty section, no trailing separator.
        // The thinking total on this transcript is 20 + 30 = 50 characters (the unit leader is
        // already leaving whole, so its thinking contributes nothing), and 51 is above it.
        const mixed = createFakeApi({ minThoughtChars: 51 });
        const mixedCalls: string[] = [];

        await executeTrimming(
            mixed.api,
            createFakeTurn({ api: mixed.api, calls: mixedCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        // The unit still leaves, and it is the ONLY thing the pass reports.
        expect(mixedCalls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(mixed.diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(mixed.diagnostics[0].data).toEqual({
            units: [UNIT_RECORD],
            truncated: [],
            thoughts: [],
            // The policy block echoes the settings the pass RAN with, so the moved floor is part of
            // the record even though the thinking side wrote nothing — and `fired` says so too.
            policy: { ...DEFAULT_POLICY, minThoughtChars: 51 }
        });
    });

    it('one pass, one report: both axes in a single diagnostic, and neither names the other entry twice', async () => {
        const { api, diagnostics } = createFakeApi();
        const calls: string[] = [];

        await executeTrimming(
            api,
            createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        // Unit writes first (leader, then result), then the thinking writes — one pause window around
        // all of them (the trigger section below pins the park itself). The unit leader's OWN
        // thinking is not flagged: it leaves with the entry, and flagging it would only inflate the
        // character figure the floor is measured against.
        expect(calls).toEqual([
            'setIncluded:1:false',
            'setIncluded:2:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4' +
                ' | context-trimmer withheld 2 thinking entry(s):' +
                ' #3 msg-4 closed 1 thoughts old 20 chars via trimThoughts=0;' +
                ' #6 msg-7 open 0 thoughts old 30 chars via trimThoughts=0'
        );

        const data = diagnostics[0].data as {
            units: unknown[];
            truncated: unknown[];
            thoughts: unknown[];
            policy: { fired: string[] };
        };

        expect(data.units).toEqual([UNIT_RECORD]);
        expect(data.truncated).toEqual([]);
        expect(data.thoughts).toEqual([THOUGHTS_REPORT[1], THOUGHTS_REPORT[2]]);
        // Declared order, both axes named: the two tool switches that account for the unit, then the
        // thinking switch that accounts for the flags.
        expect(data.policy.fired).toEqual(['dropSupersededToolCalls', 'trimInvalidTools', 'trimThoughts']);
    });

    it('trimThoughts off leaves the tool rule BYTE-IDENTICAL, and the tool switches off leave the thinking rule running', async () => {
        // H2 in both directions, on the SAME transcript.
        const off = createFakeApi({ trimThoughts: false });
        const offCalls: string[] = [];

        await executeTrimming(
            off.api,
            createFakeTurn({ api: off.api, calls: offCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(offCalls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(off.diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(off.diagnostics[0].data).toEqual({
            units: [UNIT_RECORD],
            truncated: [],
            thoughts: [],
            // Same rule as above: the block names the resolved value of every switch, and `off` is
            // what ran. The horizon is reported next to it even though nothing consulted it.
            policy: { ...DEFAULT_POLICY, trimThoughts: false }
        });

        // The other half: both TOOL switches off, thinking still withheld, and the tool section gone.
        // With no unit leaving, the leader's thinking is a candidate again — 60 characters this time.
        const toolOff = createFakeApi({
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });
        const toolCalls: string[] = [];

        await executeTrimming(
            toolOff.api,
            createFakeTurn({ api: toolOff.api, calls: toolCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(toolCalls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        expect(toolOff.diagnostics[0].message).toBe(
            'context-trimmer withheld 3 thinking entry(s): ' +
                '#1 msg-2 closed 2 thoughts old 10 chars via trimThoughts=0; ' +
                '#3 msg-4 closed 1 thoughts old 20 chars via trimThoughts=0; ' +
                '#6 msg-7 open 0 thoughts old 30 chars via trimThoughts=0'
        );
        expect((toolOff.diagnostics[0].data as { policy: { fired: string[] } }).policy.fired).toEqual([
            'trimThoughts'
        ]);
    });

    it('is withhold-only: flipping the switch off mid-session stops writes and restores nothing', async () => {
        const { api, setSetting, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);
        const context = createFakeTurn({ api, calls, entries });

        await executeTrimming(api, context);

        expect(calls).toEqual([
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        expect(diagnostics).toHaveLength(1);

        // An operator moves the switch between turns. `api.settings` is LIVE by contract
        // (../plugin/settings.ts), so the next round runs the new value with no restart.
        setSetting('trimThoughts', false);

        await executeTrimming(api, context);

        expect(calls).toHaveLength(3);
        expect(diagnostics).toHaveLength(1);

        // And the flags the earlier turn wrote are STILL there: `false` stops new writes and restores
        // nothing (F invariant 2). That is only true because the decision lives on the ENTRY — a
        // per-round decision the plugin had to remember would have evaporated with the round.
        expect((entries[1].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[3].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[6].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
    });

    it('reads no policy and writes no flag on a branch round or with the plugin disabled', async () => {
        // A branch's transcript is an ephemeral copy: nothing to persist, so the guard runs before
        // `entries` is even read (the throwing getter proves it).
        const branch = createFakeApi();
        const branchCalls: string[] = [];
        const branchTurn = createFakeTurn({
            api: branch.api,
            calls: branchCalls,
            entries: entriesFrom(THOUGHTS),
            branchId: 'branch-1',
            guardEntries: true
        });

        await executeTrimming(branch.api, branchTurn);

        expect(branchCalls).toEqual([]);
        expect(branch.diagnostics).toEqual([]);
        // A branch reads NOTHING — not even `enabled`.
        expect(branch.touches).toEqual([]);

        const disabled = createFakeApi({ enabled: false });
        const disabledCalls: string[] = [];

        await executeTrimming(
            disabled.api,
            createFakeTurn({
                api: disabled.api,
                calls: disabledCalls,
                entries: entriesFrom(THOUGHTS),
                guardEntries: true
            })
        );

        expect(disabledCalls).toEqual([]);
        expect(disabled.diagnostics).toEqual([]);
        expect(disabled.touches).toEqual(['settings.boolean:enabled']);
    });

    it('takes the ASYNC path for a thinking-only pass and the SYNC one when the switch is off', async () => {
        const handler = createContextTrimmerHandler(createFakeApi().api);
        const { api } = createFakeApi();
        const calls: string[] = [];

        // A pass that writes thinking is a real trim: a promise, and the park/trim/unpark triple.
        const writing = handler(createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS) }));

        expect(writing).toBeInstanceOf(Promise);
        await writing;
        expect(calls).toEqual([
            'pause',
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'setReasoningIncluded:6:false',
            'resume'
        ]);

        // The same transcript with the switch off: `undefined`, no park, no microtask — the fast path
        // that keeps the shipped turn cost unchanged now has to account for BOTH axes.
        const offApi = createFakeApi({ trimThoughts: false });
        const offCalls: string[] = [];

        expect(
            createContextTrimmerHandler(offApi.api)(
                createFakeTurn({ api: offApi.api, calls: offCalls, entries: entriesFrom(THOUGHTS) })
            )
        ).toBeUndefined();
        expect(offCalls).toEqual([]);
    });

    // A STALE THINKING WRITE (2026-11-13 review). The writer re-locates a candidate by INDEX, and an
    // index is a SNAPSHOT (../types `HarnessContextEntry.index` — a mid-round `replaceHistory()`
    // invalidates every one captured before it) while the handler awaits `pause()` before writing.
    // Two ways that goes wrong, and both are answered by the shared re-check (`writableEntryOf`)
    // rather than by a catch:
    //   - the index lands on a NON-ASSISTANT message, where `setReasoningIncluded` THROWS
    //     (src/harness.ts:8971-8975) — before the guard, that throw took the WHOLE pass report with
    //     it, because the bus is fail-open and the writer never reached its `api.report`;
    //   - the entry's thinking was flagged by somebody else inside the window, so the write is
    //     `false` → `false`: one persistence notification and one save for a change that happened on
    //     somebody else's turn.
    it('a stale thinking index is skipped, and an already-flagged entry is not written twice', async () => {
        const { api, diagnostics, touches } = createFakeApi();
        const calls: string[] = [];
        // What the plan sees: three thoughts, all eligible at the open horizon (ranks 2, 1 and 0).
        const planned = entriesFrom([
            { role: 'user', content: 'go' },
            think('one', 3),
            call('c1', 'read', '{"path":"a.ts"}'),
            result('c1', 'read', 'contents'),
            think('two', 4),
            think('three', 5)
        ]);
        // What the transcript actually holds when the writer runs: index 1 is now a TOOL message (an
        // entry that cannot carry thinking), index 4 already carries the flag, and only index 5 is
        // still this pass's business.
        const stale = entriesFrom([
            { role: 'user', content: 'go' },
            result('c9', 'read', 'moved'),
            call('c1', 'read', '{"path":"a.ts"}'),
            result('c1', 'read', 'contents'),
            { ...think('two', 4), reasoningIncluded: false },
            think('three', 5)
        ]);
        const { context, reads } = withStaleEntries(
            createFakeTurn({ api, calls, entries: planned }),
            planned,
            stale,
            { calls }
        );

        await executeTrimming(api, context);

        // Exactly ONE flag, and no throw. `withStaleEntries` installs the runtime's own role refusal,
        // so a write on index 1 fails this test loudly instead of being recorded as a call.
        expect(calls).toEqual(['setReasoningIncluded:5:false']);
        expect(diagnostics).toHaveLength(1);
        // The report names the one entry this pass wrote, with the age and horizon the PLAN measured:
        // the plan's snapshot is the transcript the operator's horizon was compared against, and the
        // skipped entries are reported as neither written nor withheld.
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 thinking entry(s): #5 msg-6 open 0 thoughts old 5 chars via trimThoughts=0'
        );
        expect((diagnostics[0].data as { thoughts: unknown[] }).thoughts).toEqual([
            { index: 5, messageId: 'msg-6', turn: 'open', turnsAgo: 0, chars: 5, firedBy: 'trimThoughts', horizon: 0 }
        ]);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);
        // The fixture, pinned: three plan reads, one writer read.
        expect(reads()).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// THE TRUNCATE AXIS — the request goes, the answer stays
// ---------------------------------------------------------------------------

// `truncateToolRequests` is the only switch in this plugin that acts on ONE entry of a unit while
// the unit keeps riding, so the fixture is the same `TRIMMABLE` shape read as units:
//   0 user       'go'
//   1 assistant  TOOL BLOCK c1  ← unit 0's leader: the request
//   2 tool       c1 `failed`    ← unit 0's answer — MUST still be sent
//   3 assistant  TOOL BLOCK c2  ← unit 1's leader (the answering unit), also old enough
//   4 tool       c2 completed   ← unit 1's answer
//   5 assistant  'done'
// Both units are 0 and 1 tool-turns old, so an OPEN horizon (0) makes both eligible; the trim axis
// takes unit 0 whole first, which is the precedence the plan documents.
describe('context-trimmer truncate tool requests (planTruncatedRequests)', () => {
    it('is OFF by default: the switch has to be asked for, and nothing else changes when it is', () => {
        // The declared default is `false`, and the honest comparison is the same transcript with the
        // whole-unit switches turned OFF — otherwise the trim's own candidates hide what this switch
        // on its own would do. Ages here: unit 0 is 1 tool turn old, unit 1 is 0 old, so an OPEN
        // horizon (0) makes both eligible.
        const bothOff = settingsWith({ dropSupersededToolCalls: false, trimInvalidTools: false });

        expect(planTruncatedRequests(entriesFrom(TRIMMABLE), bothOff)).toEqual([]);
        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), { ...bothOff, truncateToolRequests: true })
        ).toEqual([
            {
                leaderIndex: 1,
                leaderMessageId: 'msg-2',
                members: [1],
                results: [2],
                names: ['read'],
                firedBy: 'truncateToolRequests'
            },
            {
                leaderIndex: 3,
                leaderMessageId: 'msg-4',
                members: [3],
                results: [4],
                names: ['read'],
                firedBy: 'truncateToolRequests'
            }
        ]);

        // And the plan is the ONLY thing that moves: the unit plan is character-for-character the same
        // with the switch on, so a host cannot get a truncate that disturbs the trim it already had.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ truncateToolRequests: true }))).toEqual(
            planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({}))
        );
    });

    it('names the leader ONLY, and `results` are the entries that keep riding', () => {
        // Both whole-unit switches off, so neither unit is trimmed and the truncate is the sole
        // writer: each leader goes, each result stays. `members: [leader]` is the write set, and
        // `results` is the promise in the setting's description.
        expect(
            planTruncatedRequests(
                entriesFrom(TRIMMABLE),
                settingsWith({ truncateToolRequests: true, dropSupersededToolCalls: false, trimInvalidTools: false })
            )
        ).toEqual([
            {
                leaderIndex: 1,
                leaderMessageId: 'msg-2',
                members: [1],
                results: [2],
                names: ['read'],
                firedBy: 'truncateToolRequests'
            },
            {
                leaderIndex: 3,
                leaderMessageId: 'msg-4',
                members: [3],
                results: [4],
                names: ['read'],
                firedBy: 'truncateToolRequests'
            }
        ]);

        // The write set is exactly one entry per candidate, while the trim candidate over the same
        // transcript carries both members — the two axes are not the same decision spelled twice.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({}))[0].members).toEqual([1, 2]);
    });

    // THE REPORT LIST IS THE STILL-SENT HALF (2026-11-13 review). `results kept #…` in the pass line
    // and `data.truncated[].results` both claim "these entries are STILL being sent", so a result
    // that is already withheld must not be listed — while the PAIRING GUARD keeps counting every
    // COMMITTED result, because a unit whose results have all gone is still a unit whose stale
    // question can leave, and a unit with no results at all still may not.
    it('`results` names only the results the model is still receiving', () => {
        const settings = settingsWith({
            truncateToolRequests: true,
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });

        // Unit 0's result was switched off by hand (a host, or the UI — it is the same flag); unit 1
        // is intact. Both requests are still eligible; only the first one's list has to change.
        expect(planTruncatedRequests(entriesFrom(TRIMMABLE, [2]), settings)).toEqual([
            {
                leaderIndex: 1,
                leaderMessageId: 'msg-2',
                members: [1],
                // EMPTY, not `[2]`: entry 2 is already excluded, so naming it would report a result
                // the provider is not receiving.
                results: [],
                names: ['read'],
                firedBy: 'truncateToolRequests'
            },
            {
                leaderIndex: 3,
                leaderMessageId: 'msg-4',
                members: [3],
                results: [4],
                names: ['read'],
                firedBy: 'truncateToolRequests'
            }
        ]);

        // Every result of both units withheld: the candidates survive (the guard is about the
        // provider's pairing, and it reads ROLES) with empty lists. A withheld result is not the same
        // shape as NO result, and this is the line that proves the two were not conflated.
        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE, [2, 4]), settings).map((candidate) => [
                candidate.leaderIndex,
                candidate.results
            ])
        ).toEqual([
            [1, []],
            [3, []]
        ]);

        // The guard itself, unchanged: the unanswered unit has no committed result to keep, so its
        // request stays whatever the flags say.
        expect(
            planTruncatedRequests(
                entriesFrom([
                    { role: 'user', content: 'go' },
                    call('c1', 'read', '{"path":"a.ts"}'),
                    call('c2', 'read', '{"path":"b.ts"}'),
                    result('c2', 'read', 'contents')
                ]),
                settings
            ).map((candidate) => candidate.leaderIndex)
        ).toEqual([2]);
    });

    it('the HORIZON is tool turns: 0 truncates every answered request, 1 keeps the newest, 2 keeps both', () => {
        // Ages on this transcript: unit 0 is 1 tool turn old (the newest tool turn is unit 1's), and
        // unit 1 is 0 old. The N / N+1 boundary is therefore `truncateTurns: 1` — the newest request
        // is protected, the one above it is not.
        const bothOff = { truncateToolRequests: true, dropSupersededToolCalls: false, trimInvalidTools: false };

        for (const truncateTurns of [0, 1, 2]) {
            expect(
                planTruncatedRequests(
                    entriesFrom(TRIMMABLE),
                    settingsWith({ ...bothOff, truncateTurns })
                ).map((candidate) => [candidate.leaderIndex, candidate.results])
            ).toEqual(truncateTurns === 0 ? [[1, [2]], [3, [4]]] : truncateTurns === 1 ? [[1, [2]]] : []);
        }

        // A nonsense number behaves as 0 (the read resolves it), so the widest horizon is the safe
        // one rather than a silent no-op.
        expect(
            planTruncatedRequests(
                entriesFrom(TRIMMABLE),
                settingsWith({ ...bothOff, truncateTurns: -5 })
            ).map((candidate) => candidate.leaderIndex)
        ).toEqual([1, 3]);
    });

    it('a unit the whole-unit trim already took is never ALSO truncated — the precedence, in the plan', () => {
        // The precedence is trim > truncate, and the mechanism is the shared `removedEntries` set the
        // plan passes in. Unit 0 leaves WHOLE (both entries), so its request is not in the truncate
        // list; unit 1's request is.
        const trimmedEntries = new Set([1, 2]);

        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), settingsWith({ truncateToolRequests: true }), trimmedEntries)
                .map((candidate) => candidate.leaderIndex)
        ).toEqual([3]);

        // The same call with the 2-turn horizon DECLARED protects unit 1's request as well, so the
        // shipped posture writes no truncate line on a two-unit transcript at all.
        expect(
            planTruncatedRequests(
                entriesFrom(TRIMMABLE),
                { ...TRIMMER_DEFAULT_SETTINGS, truncateToolRequests: true },
                trimmedEntries
            )
        ).toEqual([]);

        // And a leader that is already withheld is not a candidate: re-deciding an entry the model
        // never sees would report a truncate that changes nothing.
        const alreadyGone = entriesFrom(TRIMMABLE).map((entry) =>
            entry.index === 1 ? ({ ...entry, included: false } as HarnessContextEntry) : entry
        );

        expect(
            planTruncatedRequests(alreadyGone, settingsWith({ truncateToolRequests: true, truncateTurns: 0 }))
                .map((candidate) => candidate.leaderIndex)
        ).toEqual([3]);
    });

    it('a unit with nothing to keep is never truncated — the results have to STAY somewhere', () => {
        // An UNANSWERED request is the case the switch must refuse: dropping the request of a call
        // whose result has not landed yet would break the pair the provider validates, and dropping
        // it after the result lands is what `results` exists to prove is safe.
        const unanswered: readonly HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"path":"a.ts"}'),
            { role: 'assistant', content: 'done' }
        ];

        expect(
            planTruncatedRequests(
                entriesFrom(unanswered),
                settingsWith({ truncateToolRequests: true, truncateTurns: 0 })
            )
        ).toEqual([]);

        // A tool unit whose committed result belongs to a DIFFERENT call id (the orphan case the unit
        // grouper leaves standalone) is refused for the same reason.
        const orphan: readonly HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"path":"a.ts"}'),
            result('cX', 'read', 'nobody asked'),
            { role: 'assistant', content: 'done' }
        ];

        expect(
            planTruncatedRequests(entriesFrom(orphan), settingsWith({ truncateToolRequests: true, truncateTurns: 0 }))
        ).toEqual([]);
    });

    it('the economy gates run on the truncate axis too, and they are PER AXIS, not shared', () => {
        // Both whole-unit switches off, so the truncate is the only writer and its gates are the only
        // ones in play. `maxUnits` caps candidates per pass: 1 keeps the OLDEST request (the plan is
        // ordered oldest-first), which is the same rule the trim follows.
        const bothOff = { truncateToolRequests: true, dropSupersededToolCalls: false, trimInvalidTools: false };

        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), settingsWith({ ...bothOff, maxUnits: 1 })).map(
                (candidate) => candidate.leaderIndex
            )
        ).toEqual([1]);

        // `minTokens` gates the truncate exactly as it gates the trim, on the same transcript.
        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), settingsWith({ ...bothOff, minTokens: 1000000 }))
        ).toEqual([]);

        // PROOF THAT THE GATES ARE PER AXIS: the trim writes nothing (its token gate is shut) while
        // the truncate, on its own pass through its own gate at a value the trim never sees, still
        // acts. A single shared gate would have emptied both.
        expect(
            planTruncatedRequests(
                entriesFrom(TRIMMABLE),
                settingsWith({ ...bothOff, minTokens: 0, maxUnits: 0 })
            ).map((candidate) => candidate.leaderIndex)
        ).toEqual([1, 3]);
    });

    it('writes ONE setIncluded per request and reports its own section, naming the results that stay', async () => {
        const { api, touches, diagnostics } = createFakeApi({
            truncateToolRequests: true,
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        // Exactly the two leaders — the RESULT entries (2 and 4) are never touched, and no third
        // write exists. `false` only, as everywhere in this plugin.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:3:false']);
        expect(entries[2].included).toBe(true);
        expect(entries[4].included).toBe(true);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);

        expect(diagnostics).toHaveLength(1);
        // Its OWN section — a reader must be able to tell a truncated request from a withheld unit
        // without opening the transcript, and `results kept` is the diffable promise.
        expect(diagnostics[0].message).toBe(
            'context-trimmer truncated 2 tool request(s): #1 msg-2 read results kept #2;' +
                ' #3 msg-4 read results kept #4'
        );
        expect(diagnostics[0].data).toEqual({
            units: [],
            truncated: [
                { index: 1, messageId: 'msg-2', names: ['read'], results: [2], firedBy: 'truncateToolRequests' },
                { index: 3, messageId: 'msg-4', names: ['read'], results: [4], firedBy: 'truncateToolRequests' }
            ],
            thoughts: [],
            // `truncateToolRequests` is on and it accounts for every line, so `fired` names it — and
            // the two whole-unit switches that are OFF in this case (they had to be, or the trim would
            // have taken unit 0 first) are reported off, exactly as the pass ran them.
            policy: {
                ...DEFAULT_POLICY,
                dropSupersededToolCalls: false,
                trimInvalidTools: false,
                truncateToolRequests: true,
                fired: ['truncateToolRequests']
            }
        });
    });

    // THE LINE ADMITS WHEN NOTHING IS LEFT RIDING (2026-11-13 review). With every result of a unit
    // already withheld, the old line still printed `results kept #2` — an index the model had stopped
    // receiving, which is the opposite of what that clause promises. `none` is the honest tail, and
    // the request still leaves, because dropping a stale question over an exchange whose answers are
    // already gone is a saving on its own.
    it('reports `results kept none` when every result of the truncated unit is already withheld', async () => {
        const { api, touches, diagnostics } = createFakeApi({
            truncateToolRequests: true,
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });
        const calls: string[] = [];
        const entries = entriesFrom(TRIMMABLE, [2, 4]);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:3:false']);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            'context-trimmer truncated 2 tool request(s): #1 msg-2 read results kept none;' +
                ' #3 msg-4 read results kept none'
        );
        expect(diagnostics[0].data).toEqual({
            units: [],
            truncated: [
                { index: 1, messageId: 'msg-2', names: ['read'], results: [], firedBy: 'truncateToolRequests' },
                { index: 3, messageId: 'msg-4', names: ['read'], results: [], firedBy: 'truncateToolRequests' }
            ],
            thoughts: [],
            policy: {
                ...DEFAULT_POLICY,
                dropSupersededToolCalls: false,
                trimInvalidTools: false,
                truncateToolRequests: true,
                fired: ['truncateToolRequests']
            }
        });
    });

    // THE STALE WRITE (2026-11-13 review): the handler awaits `context.pause()` between the plan and
    // this writer, and `setIncluded` writes and reports UNCONDITIONALLY (src/harness.ts:8915-8933).
    // A request entry that stopped being sent inside that window must therefore be skipped — a
    // `false` → `false` write is a persistence notification and a whole-document save for a change
    // that did not happen, and the candidate would also land in the `truncated` section, reporting a
    // truncation this pass never made.
    it('a request that went stale inside the pause window is neither written nor reported', async () => {
        const { api, touches, diagnostics } = createFakeApi({
            truncateToolRequests: true,
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });
        const calls: string[] = [];
        // What the plan sees: both requests still being sent, so both are candidates.
        const planned = entriesFrom(TRIMMABLE);
        // What the transcript holds when the writer runs: the first request has been switched off in
        // the meantime, the second is untouched.
        const stale = entriesFrom(TRIMMABLE, [1]);
        const { context, reads } = withStaleEntries(
            createFakeTurn({ api, calls, entries: planned }),
            planned,
            stale
        );

        await executeTrimming(api, context);

        expect(calls).toEqual(['setIncluded:3:false']);
        expect(diagnostics[0].message).toBe(
            'context-trimmer truncated 1 tool request(s): #3 msg-4 read results kept #4'
        );
        expect((diagnostics[0].data as { truncated: unknown[] }).truncated).toEqual([
            { index: 3, messageId: 'msg-4', names: ['read'], results: [4], firedBy: 'truncateToolRequests' }
        ]);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);
        // The fixture, pinned: three reads for the plan, one for the writer. If the plan ever walks
        // the list again, this fails here instead of quietly comparing one list against itself.
        expect(reads()).toBe(4);
    });

    // THE FLOOR IS THE SILENT HALF of the headline toggle (2026-11-13 review). `minTokens` runs PER
    // AXIS, and the figures below are the shipped estimator's own over THIS transcript: the truncate
    // write set [1,3] is worth 10 tokens and the whole-unit write set [1,2] is worth 13. Context
    // Compacting ships its floor at 200 — a scale a trimmer operator copies without thinking — and at
    // that value a short conversation's truncate pass writes NOTHING while the switch stays on.
    it('a realistic `minTokens` floor silences the truncate axis while the switch stays on', () => {
        const truncateOnly = settingsWith({
            truncateToolRequests: true,
            dropSupersededToolCalls: false,
            trimInvalidTools: false
        });

        // THE EXACT BOUNDARY of this axis's own saving: 10 is at the floor, 11 is under it, and
        // under it the WHOLE pass is rejected (no candidate, so no flag, no notification, no save,
        // no diagnostic line).
        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), { ...truncateOnly, minTokens: 10 }).map(
                (candidate) => candidate.leaderIndex
            )
        ).toEqual([1, 3]);
        expect(planTruncatedRequests(entriesFrom(TRIMMABLE), { ...truncateOnly, minTokens: 11 })).toEqual([]);
        expect(planTruncatedRequests(entriesFrom(TRIMMABLE), { ...truncateOnly, minTokens: 200 })).toEqual([]);

        // PER AXIS, not shared, and the two axes can disagree at the SAME settings: at 11 the truncate
        // write set (10 tokens) is refused while the whole-unit write set (13 tokens) still goes.
        // (Both plans are called standalone here, so neither sees the other's `trimmedEntries` — the
        // precedence is `planOf`'s, and the point being pinned is the floor, not the precedence.)
        const bothOn = settingsWith({ minTokens: 11 });

        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), bothOn).map((candidate) => candidate.members)).toEqual([
            [1, 2]
        ]);
        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), bothOn).map((candidate) => candidate.leaderIndex)
        ).toEqual([]);

        // And at the declared 0 both axes run, which is the shipped posture: no floor, no surprise.
        expect(
            planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({})).map((candidate) => candidate.members)
        ).toEqual([[1, 2]]);
        expect(
            planTruncatedRequests(entriesFrom(TRIMMABLE), settingsWith({ truncateToolRequests: true })).map(
                (candidate) => candidate.leaderIndex
            )
        ).toEqual([1, 3]);
    });

    it('three axes, one diagnostic, in the order they RAN', async () => {
        // A transcript where all three axes have work: the failed unit goes whole (trim), the
        // answering unit's request goes (truncate), and its thinking goes (thinking). The sections are
        // in run order — trim, truncate, thinking — joined by the same ' | ' the fallback clauses
        // use, so one operator reading one line can attribute every entry.
        const { api, diagnostics } = createFakeApi({ truncateToolRequests: true });
        const calls: string[] = [];

        await executeTrimming(
            api,
            createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(calls).toEqual([
            'setIncluded:1:false',
            'setIncluded:2:false',
            'setIncluded:3:false',
            'setReasoningIncluded:6:false'
        ]);
        // Entry 3 is the truncated leader, and its thinking is NOT flagged: the entry itself leaves the
        // request, so a flag on it would be a second write for zero effect and would inflate the
        // character figure `minThoughtChars` is measured against. Rule (3b) reads the whole REMOVE
        // set of the pass — trim members and truncate leaders alike — not just the unit plan.
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4' +
                ' | context-trimmer truncated 1 tool request(s): #3 msg-4 read results kept #4' +
                ' | context-trimmer withheld 1 thinking entry(s):' +
                ' #6 msg-7 open 0 thoughts old 30 chars via trimThoughts=0'
        );
        // The record keeps the three axes in three lists: `units` (whole units), `truncated` (one
        // request entry plus the results that stay) and `thoughts` (one flagged entry) — a reader can
        // attribute every entry to exactly one decision without opening the transcript.
        const data = diagnostics[0].data as { units: unknown[]; truncated: unknown[]; thoughts: unknown[] };

        expect(data.units).toEqual([UNIT_RECORD]);
        expect(data.truncated).toEqual([
            { index: 3, messageId: 'msg-4', names: ['read'], results: [4], firedBy: 'truncateToolRequests' }
        ]);
        expect(data.thoughts).toEqual([THOUGHTS_REPORT[2]]);
        expect(policyOf(diagnostics[0])).toMatchObject({
            truncateToolRequests: true,
            truncateTurns: 0,
            precedence: 'whole-unit trim > truncate request > withhold thinking',
            fired: ['dropSupersededToolCalls', 'trimInvalidTools', 'truncateToolRequests', 'trimThoughts']
        });
    });
});

// ---------------------------------------------------------------------------
// THE TOOL HORIZONS — R2/R4: each whole-unit rule has its own tool-turn window
// ---------------------------------------------------------------------------

// Four tool turns, oldest first. `toolTurnAgoOf` counts TOOL TURNS (units whose leader carries
// calls), newest = 0, so the ages below are 3, 2, 1 and 0 — enough to put a rule's N and N+1 on
// different sides of the line twice over.
//
// TURN_AGES is the supersede/invalid fixture: two ALL-`failed` units (entries 1 and 5, so
// `kind === 'candidate'`), each answered by a later same-name success (3 and 7). Ages: 1 → 3,
// 3 → 2, 5 → 1, 7 → 0.
//   0 user       'start'
//   1 assistant  call c1 read {"p":1}   ← ago 3  `candidate` (failed)
//   2 tool       c1 `failed`
//   3 assistant  call c2 read {"p":2}   ← ago 2  `answered` — the resolver of unit 1
//   4 tool       c2 completed
//   5 assistant  call c3 read {"p":3}   ← ago 1  `candidate` (failed)
//   6 tool       c3 `failed`
//   7 assistant  call c4 read {"p":4}   ← ago 0  `answered` — the resolver of unit 5
//   8 tool       c4 completed
const TURN_AGES: readonly HarnessMessage[] = [
    { role: 'user', content: 'start' },
    call('c1', 'read', '{"p":1}'),
    result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
    call('c2', 'read', '{"p":2}'),
    result('c2', 'read', 'first contents'),
    call('c3', 'read', '{"p":3}'),
    result('c3', 'read', 'Tool "read" failed: EACCES', 'failed'),
    call('c4', 'read', '{"p":4}'),
    result('c4', 'read', 'second contents')
];

// The duplicate fixture: THREE byte-identical calls (same name, same arguments) plus a fourth of a
// different tool, so the fingerprint matcher has a chain to collapse. Ages as above.
//   1 assistant call c1 read {"path":"a.ts"} → failed     ← ago 3, a duplicate of 5's work
//   3 assistant call c2 read {"path":"a.ts"} → completed  ← ago 2, a duplicate of 5's work
//   5 assistant call c3 read {"path":"a.ts"} → completed  ← ago 1, the NEWEST copy — the keeper
//   7 assistant call c4 beta {}             → completed   ← ago 0, different work
const TURN_DUPES: readonly HarnessMessage[] = [
    { role: 'user', content: 'start' },
    call('c1', 'read', '{"path":"a.ts"}'),
    result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
    call('c2', 'read', '{"path":"a.ts"}'),
    result('c2', 'read', 'first contents'),
    call('c3', 'read', '{"path":"a.ts"}'),
    result('c3', 'read', 'second contents'),
    call('c4', 'beta', '{}'),
    result('c4', 'beta', 'beta contents')
];

// The leader indices of a plan, oldest first — the only figure these tables vary.
const leadersOf = (plan: readonly { leaderIndex: number }[]): number[] =>
    plan.map((candidate) => candidate.leaderIndex);

describe('context-trimmer tool rules with per-rule horizons (R2/R4)', () => {
    it('invalidToolTurns: a failed unit becomes eligible only once N newer tool turns sit above it', () => {
        // One rule in play, so the horizon is the only variable. Ages: entry 1 is 3 tool turns old,
        // entry 5 is 1 old. The sweep is the whole ladder — 0 protects nothing, 1 still lets the
        // 1-old one go, 2 is the first value that protects it, 4 is the first that protects the 3-old
        // one too. Each N and its N+1 sit on opposite sides, which is the contract the descriptor
        // states (`Protects the newest N tool turns; 0 protects none.`).
        for (const invalidToolTurns of [0, 1, 2, 3, 4]) {
            expect(
                leadersOf(
                    planTrimmedUnits(
                        entriesFrom(TURN_AGES),
                        settingsWith({
                            trimInvalidTools: true,
                            invalidToolTurns,
                            dropSupersededToolCalls: false,
                            dropDuplicateCalls: false
                        })
                    )
                )
            ).toEqual(
                invalidToolTurns <= 1 ? [1, 5] : invalidToolTurns <= 3 ? [1] : []
            );
        }

        // The horizon is a TOOL-TURN count, not a unit or entry count: the two failed units sit four
        // transcript entries apart and the window still measures the turns between them.
        expect(
            leadersOf(
                planTrimmedUnits(
                    entriesFrom(TURN_AGES),
                    settingsWith({ trimInvalidTools: true, dropSupersededToolCalls: false, invalidToolTurns: 2 })
                )
            )
        ).toEqual([1]);
    });

    it('supersededTurns: the answering turn is never dropped, and the answered one goes at its own bound', () => {
        // The shipped rule's own horizon, swept the same way. Only the two `candidate` units can be
        // superseded (an `answered` unit is a RESOLVER, not a candidate), and both need a later
        // same-name success to exist — which is why entry 7, the newest turn, can never leave: it has
        // nothing above it to answer it.
        for (const supersededTurns of [0, 1, 2, 3, 4]) {
            expect(
                leadersOf(
                    planTrimmedUnits(
                        entriesFrom(TURN_AGES),
                        settingsWith({
                            dropSupersededToolCalls: true,
                            supersededTurns,
                            trimInvalidTools: false,
                            dropDuplicateCalls: false
                        })
                    )
                )
            ).toEqual(supersededTurns <= 1 ? [1, 5] : supersededTurns <= 3 ? [1] : []);
        }

        // The horizon cannot invent a candidate: with nothing answering the failed unit, no horizon
        // value at all moves the rule (`0` opens the window, and the predicate still refuses).
        const unanswered: readonly HarnessMessage[] = [
            { role: 'user', content: 'start' },
            call('c1', 'read', '{"p":1}'),
            result('c1', 'read', 'Tool "read" failed: EACCES', 'failed')
        ];

        expect(
            leadersOf(
                planTrimmedUnits(
                    entriesFrom(unanswered),
                    settingsWith({ supersededTurns: 0, trimInvalidTools: false, dropDuplicateCalls: false })
                )
            )
        ).toEqual([]);
    });

    it('duplicateTurns: the newest copy is the keeper, and the horizon decides how far down the chain it reaches', async () => {
        // Ages here: entry 1 is 3 old, 3 is 2 old, 5 is 1 old, 7 is 0 old. The three identical `read`
        // calls collapse to the newest one (entry 5), so the candidates are 1 (ago 3) and 3 (ago 2) —
        // and the KEEPER survives every horizon value, including 0, because it has no later copy to be
        // superseded by, not because the window protects it.
        for (const duplicateTurns of [0, 1, 2, 3, 4]) {
            expect(
                leadersOf(
                    planTrimmedUnits(
                        entriesFrom(TURN_DUPES),
                        settingsWith({
                            dropDuplicateCalls: true,
                            duplicateTurns,
                            trimInvalidTools: false,
                            dropSupersededToolCalls: false
                        })
                    )
                )
            ).toEqual(duplicateTurns <= 2 ? [1, 3] : duplicateTurns <= 3 ? [1] : []);
        }

        // The keeper is provably still in the request: with the window open the pass writes the two
        // older copies and NOTHING else, so entry 5 and its result keep riding.
        const { api } = createFakeApi({
            dropDuplicateCalls: true,
            trimInvalidTools: false,
            dropSupersededToolCalls: false
        });
        const calls: string[] = [];
        const entries = entriesFrom(TURN_DUPES);

        await executeTrimming(api, createFakeTurn({ api, calls, entries }));

        expect(calls).toEqual([
            'setIncluded:1:false',
            'setIncluded:2:false',
            'setIncluded:3:false',
            'setIncluded:4:false'
        ]);
        expect(entries[5].included).toBe(true);
        expect(entries[6].included).toBe(true);
    });

    it('the horizons are SEPARATE knobs: opening one rule leaves its neighbours shut', () => {
        // The same transcript, three settings, three different plans. This is the whole point of one
        // horizon per toggle instead of a single shared window: an operator who trusts the invalid-tools
        // rule but not the duplicate rule can say so per rule.
        const settings = {
            supersededOnly: settingsWith({ supersededTurns: 0, trimInvalidTools: false, dropDuplicateCalls: false }),
            invalidOnly: settingsWith({ invalidToolTurns: 0, dropSupersededToolCalls: false, dropDuplicateCalls: false }),
            duplicatesOnly: settingsWith({
                dropDuplicateCalls: true,
                duplicateTurns: 0,
                trimInvalidTools: false,
                dropSupersededToolCalls: false
            })
        };

        expect(leadersOf(planTrimmedUnits(entriesFrom(TURN_AGES), settings.supersededOnly))).toEqual([1, 5]);
        expect(leadersOf(planTrimmedUnits(entriesFrom(TURN_AGES), settings.invalidOnly))).toEqual([1, 5]);
        expect(leadersOf(planTrimmedUnits(entriesFrom(TURN_DUPES), settings.duplicatesOnly))).toEqual([1, 3]);

        // A neighbour's horizon cannot leak: `supersededTurns: 9` shuts the shipped rule while
        // `invalidToolTurns: 0` still lets the same unit go through the invalid rule — the unit is
        // withheld either way, and `firedBy` proves which rule did it.
        const split = settingsWith({ supersededTurns: 9, invalidToolTurns: 0, dropDuplicateCalls: false });
        const plan = planTrimmedUnits(entriesFrom(TURN_AGES), split);

        expect(leadersOf(plan)).toEqual([1, 5]);
        expect(plan.map((candidate) => [candidate.firedBy, candidate.admittedBy])).toEqual([
            ['trimInvalidTools', ['trimInvalidTools']],
            ['trimInvalidTools', ['trimInvalidTools']]
        ]);

        // And the reverse: an open supersede window with the invalid rule shut still takes the same
        // two units, attributed to the shipped rule.
        const flipped = settingsWith({ supersededTurns: 0, trimInvalidTools: false, dropDuplicateCalls: false });

        expect(
            planTrimmedUnits(entriesFrom(TURN_AGES), flipped).map((candidate) => [
                candidate.leaderIndex,
                candidate.firedBy
            ])
        ).toEqual([
            [1, 'dropSupersededToolCalls'],
            [5, 'dropSupersededToolCalls']
        ]);
    });

    it('the DECLARED horizons (all 2) protect the two newest tool turns, end to end and in the report', async () => {
        // Nothing overridden — the posture an operator gets from a fresh install. Of the two failed
        // units, only the 3-turns-old one is old enough to leave; the 1-turn-old failure is protected
        // by every one of the declared windows, and the report says so with `2` next to each rule.
        const { api, touches, diagnostics } = createFakeApi({ atDeclaredHorizons: true });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TURN_AGES) }));

        // One unit, leader first then its result — the whole-unit write set the runtime requires.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(diagnostics[0].data).toEqual({
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    requestAlreadyWithheld: false,
                    outcomes: ['failed'],
                    invalidOutcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'dropSupersededToolCalls',
                    admittedBy: ['dropSupersededToolCalls', 'trimInvalidTools']
                }
            ],
            truncated: [],
            thoughts: [],
            // EVERY horizon is the shipped 2 — the operator reading this record can re-derive the
            // decision for the unit that left AND for the one that stayed.
            policy: DECLARED_DEFAULT_POLICY
        });

        // The same transcript with the windows OPEN writes both failures — the difference between the
        // two plans is the horizons and nothing else.
        const opened = createFakeApi();
        const openedCalls: string[] = [];

        await executeTrimming(
            opened.api,
            createFakeTurn({ api: opened.api, calls: openedCalls, entries: entriesFrom(TURN_AGES) })
        );

        expect(openedCalls).toEqual([
            'setIncluded:1:false',
            'setIncluded:2:false',
            'setIncluded:5:false',
            'setIncluded:6:false'
        ]);
        // Same shape of record, every horizon at 0 — the two records side by side ARE the R2 proof.
        expect(policyOf(opened.diagnostics[0])).toEqual(DEFAULT_POLICY);
    });

    it('a nonsense horizon number resolves to the declared 2 — the bounds belong to the pane, not the pass', async () => {
        // The read resolves a non-number to the descriptor default; nothing is clamped in the pass
        // itself (a value above `max` still acts, which is what the PATCH edge in
        // `src/server/plugins-api.test.ts` pins at the API boundary). A NEGATIVE number is a number,
        // so it arrives as-is — and `ago >= -1` is true for every unit, i.e. a negative window is
        // OPEN, which is the safe direction: it removes more, it never silently disables a rule.
        expect(
            leadersOf(
                planTrimmedUnits(
                    entriesFrom(TURN_AGES),
                    settingsWith({ supersededTurns: -1, trimInvalidTools: false, dropDuplicateCalls: false })
                )
            )
        ).toEqual([1, 5]);

        const { api, diagnostics } = createFakeApi({
            supersededTurns: 'soon',
            trimInvalidTools: false,
            dropDuplicateCalls: false
        });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TURN_AGES) }));

        // The declared 2 → the 1-turn-old failure is protected, the 3-turns-old one leaves.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(policyOf(diagnostics[0])).toMatchObject({ supersededTurns: 2 });
    });
});

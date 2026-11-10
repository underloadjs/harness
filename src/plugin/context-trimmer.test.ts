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
    admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered'],
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
const createFakeApi = (stored: Record<string, unknown> = {}): FakeApi => {
    const touches: string[] = [];
    const diagnostics: HarnessPluginDiagnosticReport[] = [];
    const values: Record<string, unknown> = { ...stored };

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
// shares with the framework's hook gate, then every policy switch in DECLARED ORDER, read once
// per turn. Pinned as one list in every fast-path assertion below, so a switch that ships
// without being consulted — or one consulted twice a turn — fails, and so does a switch that
// leaks in front of the guards (a branch round, an internal agent or a disabled plugin still
// cost what invariant 5 promises: one read, or none).
const TURN_READS: readonly string[] = [
    'settings.boolean:enabled',
    'settings.boolean:dropSupersededToolCalls',
    'settings.boolean:dropInvalidToolCallsOnceAnswered',
    'settings.string:invalidOutcomes',
    'settings.string:dropOldThoughts',
    'settings.number:thoughtKeepUnits',
    'settings.string:supersedeMatch',
    'settings.boolean:dropDuplicateCalls',
    'settings.number:minTokens',
    'settings.number:minThoughtChars',
    'settings.number:safetyUnits',
    'settings.number:maxUnits'
];

// The `data.policy` block of a pass that ran on the declared defaults: every switch as it was
// resolved, every tier next to the value that was submitted (identical here — nothing fell
// back), and `fired`, the two switches that both account for a shipped-rule withholding.
const DEFAULT_POLICY = {
    dropSupersededToolCalls: true,
    dropInvalidToolCallsOnceAnswered: true,
    invalidOutcomes: 'failed/rejected',
    invalidOutcomesSubmitted: 'failed,rejected',
    invalidOutcomesFallback: false,
    dropOldThoughts: 'turn',
    dropOldThoughtsSubmitted: 'turn',
    dropOldThoughtsFallback: false,
    supersedeMatch: 'name',
    supersedeMatchSubmitted: 'name',
    supersedeMatchFallback: false,
    dropDuplicateCalls: false,
    thoughtKeepUnits: 0,
    minTokens: 0,
    minThoughtChars: 0,
    safetyUnits: 0,
    maxUnits: 0,
    fired: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered']
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

// ---------------------------------------------------------------------------
// A1 — the rule, as a pure plan
// ---------------------------------------------------------------------------

describe('context-trimmer plan (planTrimmedUnits)', () => {
    it('A1: withholds the failed unit a later success of the same tool name answered', () => {
        // The exact candidate, including the durable addresses of BOTH halves of the pair.
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE))).toEqual([TRIMMABLE_CANDIDATE]);
    });

    it('A1: a `rejected` call is as superseded as a `failed` one', () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'go' },
            call('c1', 'read', '{"path":"a.ts"}'),
            result('c1', 'read', 'Tool "read" is not available.', 'rejected'),
            call('c2', 'read', '{"path":"b.ts"}'),
            result('c2', 'read', 'export const b = 2;')
        ];

        expect(planTrimmedUnits(entriesFrom(messages))).toEqual([
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

        expect(planTrimmedUnits(entriesFrom(messages))).toEqual([TRIMMABLE_CANDIDATE]);
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
        // The whole failed unit withheld (leader AND result, as the runtime cascade leaves it).
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE, [1, 2]))).toEqual([]);
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
            planTrimmedUnits(entriesFrom(messages)).map((candidate) => ({
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

        expect(planTrimmedUnits(entriesFrom(mixed))).toEqual([]);

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
const settingsWith = (overrides: Partial<TrimmerSettings>): TrimmerSettings => ({
    ...TRIMMER_DEFAULT_SETTINGS,
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        // The whole default set is named, so the generalisation and the shipped
                        // classifier agree on this unit — the equivalence the header claims.
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                        firedBy: 'dropInvalidToolCallsOnceAnswered',
                        admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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
                for (const dropInvalidToolCallsOnceAnswered of [true, false]) {
                    for (const invalidOutcomes of outcomeSets) {
                        for (const supersedeMatch of ['name', 'fingerprint'] as const) {
                            for (const dropDuplicateCalls of [true, false]) {
                                // `entriesFrom` rebuilds the entries every run: `setIncluded` is not
                                // involved in a pure plan, and a fresh list keeps the runs independent.
                                const plan = planTrimmedUnits(
                                    entriesFrom(shape.messages),
                                    settingsWith({
                                        dropSupersededToolCalls,
                                        dropInvalidToolCallsOnceAnswered,
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
        expect(planShape(planTrimmedUnits(entriesFrom(UNANSWERED)))).toEqual([]);
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE))).toEqual([TRIMMABLE_CANDIDATE]);
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
                firedBy: 'dropInvalidToolCallsOnceAnswered',
                admittedBy: ['dropInvalidToolCallsOnceAnswered'],
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

        expect(planShape(planTrimmedUnits(entriesFrom(partlyAnswered)))).toEqual([]);
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
    admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered'],
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
                admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered'],
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
        expect(planShape(planTrimmedUnits(entriesFrom(SAME_ARGS, [3, 4])))).toEqual([]);
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
        expect(planShape(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS)))).toEqual([]);
    });

    it('runs alone with both supersession switches off, and never on a name-only match', () => {
        const duplicateOnly = settingsWith({
            dropSupersededToolCalls: false,
            dropInvalidToolCallsOnceAnswered: false,
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
                        dropInvalidToolCallsOnceAnswered: false,
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
            dropInvalidToolCallsOnceAnswered: false,
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
                admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered', 'dropDuplicateCalls']
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
            planTrimmedUnits(entriesFrom(TWO_TRIMMABLE))
        );

        // Both candidates, oldest first, with every knob at 0.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(TWO_TRIMMABLE)))).toEqual([1, 3]);
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
                admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered'],
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
        const settings = settingsWith({ dropDuplicateCalls: true, dropSupersededToolCalls: false, dropInvalidToolCallsOnceAnswered: false });

        // Same estimator, same gates, third rule. `Temp/T45/probe2.ts` measured this unit at 7
        // estimated tokens, so the floor's edge is 7 vs 8 — the same one-token edge as the tool rule.
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, minTokens: 7 })))).toEqual([1]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, minTokens: 8 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, safetyUnits: 4 })))).toEqual([]);
        expect(leaderIndexesOf(planTrimmedUnits(entriesFrom(DUPLICATE_SUCCESS), settingsWith({ ...settings, maxUnits: 1 })))).toEqual([1]);
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
        expect(atFloorCalls).toEqual(['setIncluded:1:false']);
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
        expect(calls).toEqual(['setIncluded:1:false']);
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
                    'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [cancelled] read answered by msg-4 via dropInvalidToolCallsOnceAnswered',
                fired: ['dropInvalidToolCallsOnceAnswered']
            },
            {
                // `empty` is the one value read off the TEXT: the line reports what the pass JUDGED
                // (`empty`), while `data.units[].outcomes` below keeps what the transcript RECORDS
                // (`completed`).
                case: 'empty',
                stored: { dropSupersededToolCalls: false, invalidOutcomes: 'empty' },
                messages: unitThenAnswer(result('c1', 'read', '   ')),
                message:
                    'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [empty] read answered by msg-4 via dropInvalidToolCallsOnceAnswered',
                fired: ['dropInvalidToolCallsOnceAnswered']
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
                calls: ['setIncluded:1:false'],
                fired: entry.fired
            });
        }
    });

    it('carries both outcome lists and both switch lists on the structured unit, so a host never has to parse the line', async () => {
        const { api, diagnostics } = createFakeApi({ dropSupersededToolCalls: false, invalidOutcomes: 'empty' });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(unitThenAnswer(result('c1', 'read', '   '))) }));

        expect(diagnostics[0].data).toEqual({
            // The thinking side is always part of the report, even when it wrote nothing (T6):
            // a host diffs ONE shape across turns, so "no thinking this pass" is an empty list
            // rather than a missing key.
            thoughts: [],
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    // RECORDS `completed`, JUDGED `empty` — the pair that makes a withheld stub
                    // distinguishable from a withheld zero-hit search.
                    outcomes: ['completed'],
                    invalidOutcomes: ['empty'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'dropInvalidToolCallsOnceAnswered',
                    admittedBy: ['dropInvalidToolCallsOnceAnswered']
                }
            ],
            policy: {
                ...DEFAULT_POLICY,
                dropSupersededToolCalls: false,
                invalidOutcomes: 'empty',
                invalidOutcomesSubmitted: 'empty',
                fired: ['dropInvalidToolCallsOnceAnswered']
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

        // ONE write, on the LEADER. The cascade covers the result, so the policy never names
        // a member (and never rewrites the transcript).
        expect(calls).toEqual(['setIncluded:1:false']);
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
            // The thinking side is always part of the report, even when it wrote nothing (T6):
            // a host diffs ONE shape across turns, so "no thinking this pass" is an empty list
            // rather than a missing key.
            thoughts: [],
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    outcomes: ['failed'],
                    invalidOutcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'dropSupersededToolCalls',
                    admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered']
                }
            ],
            policy: DEFAULT_POLICY
        });
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

        expect(calls).toEqual(['setIncluded:0:false', 'setIncluded:2:false']);

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
        expect(after).toEqual(['setIncluded:1:false']);
        expect(diagnostics).toHaveLength(1);
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
            dropInvalidToolCallsOnceAnswered: false
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
            dropInvalidToolCallsOnceAnswered: false
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

        expect(calls).toEqual(['setIncluded:1:false']);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );

        const policy = policyOf(diagnostics[0]);

        expect(policy.fired).toEqual(['dropInvalidToolCallsOnceAnswered']);
        expect(policy.dropSupersededToolCalls).toBe(false);
        expect(policy.invalidOutcomes).toBe('failed/rejected');
    });

    it('`dropInvalidToolCallsOnceAnswered: false` leaves the shipped rule as the only tool policy', async () => {
        const { api, diagnostics } = createFakeApi({ dropInvalidToolCallsOnceAnswered: false });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

        // Independent in the other direction: the shipped switch alone still withholds the pair.
        expect(calls).toEqual(['setIncluded:1:false']);

        const policy = policyOf(diagnostics[0]);

        expect(policy.fired).toEqual(['dropSupersededToolCalls']);
        expect(policy.dropInvalidToolCallsOnceAnswered).toBe(false);
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

        expect(trimmedCalls).toEqual(['setIncluded:1:false']);
        expect(policyOf(trimmed.diagnostics[0]).invalidOutcomes).toBe('rejected');
        expect(policyOf(trimmed.diagnostics[0]).fired).toEqual(['dropInvalidToolCallsOnceAnswered']);
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

        expect(cancelledCalls).toEqual(['setIncluded:1:false']);
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

        expect(completedCalls).toEqual(['setIncluded:1:false']);
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
                stored: { dropOldThoughts: 'sometimes' },
                clause: 'dropOldThoughts "sometimes" is not a tier; used "turn"',
                policy: {
                    dropOldThoughts: 'turn',
                    dropOldThoughtsSubmitted: 'sometimes',
                    dropOldThoughtsFallback: true
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

    it('reports every fallback clause in DECLARED order when all three tiers are wrong at once', async () => {
        const { api, diagnostics } = createFakeApi({
            invalidOutcomes: 'nope',
            dropOldThoughts: 'sometimes',
            supersedeMatch: 'loose'
        });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE) }));

        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4' +
                ' | invalidOutcomes "nope" has unknown names; used none (the generalisation is off)' +
                ' | dropOldThoughts "sometimes" is not a tier; used "turn"' +
                ' | supersedeMatch "loose" is not a matcher; used "name"'
        );
        expect(policyOf(diagnostics[0]).fired).toEqual(['dropSupersededToolCalls']);
    });

    it('a tier that only differs in case or spacing is normalised WITHOUT a fallback clause', async () => {
        const { api, diagnostics } = createFakeApi({
            dropOldThoughts: '  TURN ',
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

        expect(calls).toEqual(['setIncluded:1:false']);
        // Normalisation is not a substitution: nothing was dropped, so nothing is complained
        // about, and the USED values are the canonical spellings.
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(policyOf(diagnostics[0])).toMatchObject({
            dropOldThoughts: 'turn',
            dropOldThoughtsFallback: false,
            supersedeMatch: 'fingerprint',
            supersedeMatchFallback: false,
            invalidOutcomes: 'failed/rejected',
            invalidOutcomesFallback: false
        });
    });

    it('reports the economy and thoughts knobs in every pass report, and the two that gate nothing stay inert', async () => {
        // The report half, at values that gate NOTHING: `minTokens: 0` and `safetyUnits: 0` are the
        // pass-throughs, `maxUnits: 1` cannot bite a one-candidate pass, and `minThoughtChars` is the
        // thinking twin this pass never applies (the estimator does not count `reasoning`). A
        // superseded unit still leaves, so a reader can tell "off" from "not implemented" and the
        // declared defaults never leak into the block.
        const { api, diagnostics } = createFakeApi({
            dropOldThoughts: 'all',
            thoughtKeepUnits: 4,
            supersedeMatch: 'fingerprint',
            dropDuplicateCalls: true,
            minTokens: 0,
            minThoughtChars: 2000,
            safetyUnits: 0,
            maxUnits: 1
        });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(TRIMMABLE_SAME_ARGS) }));

        expect(calls).toEqual(['setIncluded:1:false']);
        expect(policyOf(diagnostics[0])).toMatchObject({
            dropOldThoughts: 'all',
            thoughtKeepUnits: 4,
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
            calls: ['setIncluded:1:false'],
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
        // transcript inside the pause window and reports it.
        expect(calls).toEqual(['pause', 'setIncluded:1:false', 'resume']);
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
            ['dropSupersededToolCalls', 'boolean', true, undefined, undefined, undefined],
            ['dropInvalidToolCallsOnceAnswered', 'boolean', true, undefined, undefined, undefined],
            ['invalidOutcomes', 'string', 'failed,rejected', undefined, undefined, undefined],
            ['dropOldThoughts', 'string', 'turn', undefined, undefined, undefined],
            ['thoughtKeepUnits', 'number', 0, 0, 32, 1],
            ['supersedeMatch', 'string', 'name', undefined, undefined, undefined],
            ['dropDuplicateCalls', 'boolean', false, undefined, undefined, undefined],
            ['minTokens', 'number', 0, 0, 1000000, 50],
            ['minThoughtChars', 'number', 0, 0, 1000000, 50],
            ['safetyUnits', 'number', 0, 0, 4096, 1],
            ['maxUnits', 'number', 0, 0, 4096, 1]
        ]);

        // Every descriptor is UI-facing: a label and a real explanation, not a placeholder.
        for (const setting of metadata.settings ?? []) {
            expect(typeof setting.label).toBe('string');
            expect(setting.label.length).toBeGreaterThan(3);
            expect(typeof setting.description).toBe('string');
            expect((setting.description ?? '').length).toBeGreaterThan(40);
        }

        // The posture, stated by the plugin itself (T2a): the engine trims nothing, this is the
        // one place that does, and withholding is reversible.
        expect(metadata.description).toContain('engine core trims nothing by default');
        expect(metadata.description).toContain('the one place trimming happens');
        expect(metadata.description).toContain('failed or were rejected');
        expect(metadata.description).toContain('successful call to the same tool');
        expect(metadata.description).toContain('Nothing is deleted');
        expect(metadata.description).toContain('switched back on');
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

const settingsOf = (values: Record<string, unknown>): HarnessPluginSettingsProvider => ({
    get: (plugin, key) => (plugin === metadata.name ? values[key] : undefined)
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
                dropInvalidToolCallsOnceAnswered: false
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
                dropOldThoughts: 'sometimes',
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
        expect(diagnostics[0].message).toContain('dropOldThoughts "sometimes" is not a tier; used "turn"');
        expect(diagnostics[0].message).toContain('supersedeMatch "loose" is not a matcher; used "name"');
        expect(diagnostics[0].message).toContain(
            'invalidOutcomes "bogus" has unknown names; used none (the generalisation is off)'
        );

        const policy = (diagnostics[0].data as { policy: Record<string, unknown> }).policy;

        expect(policy).toMatchObject({
            invalidOutcomes: '',
            invalidOutcomesSubmitted: 'bogus',
            dropOldThoughts: 'turn',
            dropOldThoughtsSubmitted: 'sometimes',
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
});

// ---------------------------------------------------------------------------
// T6 — THE THINKING RULE: the tier table, the writes, the report, and the two floors
// ---------------------------------------------------------------------------
//
// `dropOldThoughts` is the second axis: it withholds the model's own recorded thinking while the
// entry itself keeps travelling. The write is the per-entry FLAG `reasoningIncluded: false`
// (../types `HarnessTurnBeforeContext.setReasoningIncluded`), never a text edit, and the projection
// resolves the flag by omitting `reasoning` from that entry's request copy — the shape assertions
// for that live in src/harness.inclusion.test.ts, where a real run and a real transport are
// available. What THIS section pins is the POLICY and the WRITES: which entries a tier selects,
// what `thoughtKeepUnits` rescues, what each floor rejects, what one pass writes and reports, and
// that the thinking side and the tool side never gate each other.
//
// THE BOUNDARY IS THE LAST `user` ENTRY, not `iteration`. Every assistant entry after it is the
// OPEN turn (the run is still building it) and keeps its thinking under `turn`; everything at or
// before it is a CLOSED turn. The fixtures below therefore place their user entries deliberately,
// and each expected list says which side of that line every entry sits on.

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
// it because the floors are measured over it, and `turn` stays in it because the tier boundary is
// the single most confusing thing about this switch for an operator reading a report.
const thoughtShape = (plan: readonly ThoughtCandidate[]) =>
    plan.map((candidate) => ({
        index: candidate.entryIndex,
        messageId: candidate.entryMessageId,
        turn: candidate.turn,
        chars: candidate.chars,
        firedBy: candidate.firedBy,
        tier: candidate.tier
    }));

describe('context-trimmer thinking plan (planWithheldThoughts, T6)', () => {
    it('tier "off" has no thinking write at all, whatever else is configured', () => {
        // Every position, every rescue setting, the whole transcript: `off` is the engine's
        // posture, so no flag exists to write (H2's independence starts here).
        for (const thoughtKeepUnits of [0, 1, 2, 5]) {
            expect(
                thoughtShape(
                    planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ dropOldThoughts: 'off', thoughtKeepUnits }))
                )
            ).toEqual([]);
        }

        expect(thoughtShape(planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ dropOldThoughts: 'off', minThoughtChars: 1 }))))
            .toEqual([]);
    });

    it('tier "turn" — the DEFAULT — takes every closed turn and leaves the open one alone', () => {
        const plan = planWithheldThoughts(entriesFrom(THOUGHTS));

        // Exact candidate objects, hardcoded from the fixture: 1 and 3 sit at or before the last
        // user entry (index 5), 6 sits after it and is the open turn.
        expect(plan).toEqual([
            {
                entryIndex: 1,
                entryMessageId: 'msg-2',
                turn: 'closed',
                chars: 10,
                firedBy: 'dropOldThoughts',
                tier: 'turn'
            },
            {
                entryIndex: 3,
                entryMessageId: 'msg-4',
                turn: 'closed',
                chars: 20,
                firedBy: 'dropOldThoughts',
                tier: 'turn'
            }
        ]);
        // Same answer through the readable form, so a table failure names the fields a reader cares
        // about rather than the whole candidate.
        expect(thoughtShape(plan)).toEqual([
            { index: 1, messageId: 'msg-2', turn: 'closed', chars: 10, firedBy: 'dropOldThoughts', tier: 'turn' },
            { index: 3, messageId: 'msg-4', turn: 'closed', chars: 20, firedBy: 'dropOldThoughts', tier: 'turn' }
        ]);
        // The declared default IS `turn`, so the table above is the shipped behaviour.
        expect(TRIMMER_DEFAULT_SETTINGS.dropOldThoughts).toBe('turn');
        expect(thoughtShape(planWithheldThoughts(entriesFrom(THOUGHTS), TRIMMER_DEFAULT_SETTINGS))).toEqual(
            thoughtShape(plan)
        );
    });

    it('tier "all" takes the open turn too, and still skips an entry with no thinking', () => {
        expect(
            thoughtShape(planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ dropOldThoughts: 'all' })))
        ).toEqual([
            { index: 1, messageId: 'msg-2', turn: 'closed', chars: 10, firedBy: 'dropOldThoughts', tier: 'all' },
            { index: 3, messageId: 'msg-4', turn: 'closed', chars: 20, firedBy: 'dropOldThoughts', tier: 'all' },
            // Entry 4 has no `reasoning` key at all, so there is nothing to withhold and no flag is
            // written — and `thoughtKeepUnits` counts entries like this one NOT at all.
            { index: 6, messageId: 'msg-7', turn: 'open', chars: 30, firedBy: 'dropOldThoughts', tier: 'all' }
        ]);
    });

    it('thoughtKeepUnits rescues the N newest thinking entries, and only those', () => {
        const table: Array<[TrimmerSettings['dropOldThoughts'], number, number[]]> = [
            // `turn`: the candidate list is [1, 3], so keep-1 drops 3 and keep-2 empties it.
            ['turn', 0, [1, 3]],
            ['turn', 1, [1]],
            ['turn', 2, []],
            // A rescue bigger than the list is the same answer as an exact one — no clamping bug,
            // and nothing negative-indexes.
            ['turn', 5, []],
            // `all`: the candidate list is [1, 3, 6] — keep-1 is exactly "the open turn keeps its
            // thinking again", which is the documented use of this switch.
            ['all', 0, [1, 3, 6]],
            ['all', 1, [1, 3]],
            ['all', 2, [1]],
            ['all', 3, []],
            ['all', 32, []]
        ];

        for (const [tier, thoughtKeepUnits, indexes] of table) {
            const plan = planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ dropOldThoughts: tier, thoughtKeepUnits })
            );

            expect(plan.map((candidate) => candidate.entryIndex)).toEqual(indexes);
        }

        // The rescue counts ONLY entries with thinking: entry 4 has none, so under `all` a keep-1
        // rescues entry 6 and not entry 4 — a plan that counted 4 would report a write on it.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ dropOldThoughts: 'all', thoughtKeepUnits: 1 }))
                .map((candidate) => candidate.entryIndex)
        ).toEqual([1, 3]);
    });

    it('a second pass over an already-flagged transcript has no candidate left, and neither has a restored one', () => {
        const entries = entriesFrom(THOUGHTS);

        // Pass one through the policy: 1 and 3.
        const first = planWithheldThoughts(entries).map((candidate) => candidate.entryIndex);

        expect(first).toEqual([1, 3]);

        // The write, applied the way the runtime applies it — on the canonical MESSAGE object, which
        // is what `entries` hands out.
        for (const index of first) {
            (entries[index].message as { reasoningIncluded?: boolean }).reasoningIncluded = false;
        }

        expect(planWithheldThoughts(entries)).toEqual([]);

        // A RESTART, modelled exactly: a fresh entry list (no in-process state survives) whose
        // messages carry the flags the first process wrote. Re-deriving finds the same two entries
        // already flagged and proposes nothing, so a continued session writes no duplicate flags.
        const restored = entriesFrom(
            THOUGHTS.map((message, index) =>
                index === 1 || index === 3 ? { ...message, reasoningIncluded: false } : message
            )
        );

        expect(planWithheldThoughts(restored)).toEqual([]);
    });

    it('skips an entry the model never sees, an entry with empty thinking, and an entry this pass already excludes', () => {
        // `entry.included === false` is the LIVE, effective flag of the whole unit: an entry that is
        // not in the request cannot have its thinking removed from it, so a flag would cost a write
        // and change nothing (and the next pass after a re-enable picks it up).
        expect(
            thoughtShape(
                planWithheldThoughts(entriesFrom(THOUGHTS, [3]), settingsWith({ dropOldThoughts: 'all' }))
            )
        ).toEqual([
            { index: 1, messageId: 'msg-2', turn: 'closed', chars: 10, firedBy: 'dropOldThoughts', tier: 'all' },
            { index: 6, messageId: 'msg-7', turn: 'open', chars: 30, firedBy: 'dropOldThoughts', tier: 'all' }
        ]);

        // An EMPTY reasoning string is the same case one level down: nothing to remove.
        expect(
            planWithheldThoughts(
                entriesFrom([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning: '' }]),
                settingsWith({ dropOldThoughts: 'all' })
            )
        ).toEqual([]);

        // (3b) The tool side is withholding entry 1's whole unit THIS pass, so its thinking leaves
        // with it: no flag, and — the part that matters — no characters counted toward the floor.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ dropOldThoughts: 'all' }),
                new Set([1, 2])
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([3, 6]);
    });

    it('a transcript with no user entry has no closed turn, so only "all" writes — and never by index arithmetic', () => {
        const noUser = entriesFrom([think('one', 10), think('two', 20)]);

        // Every entry is after "the last user entry", which does not exist (-1), so under `turn`
        // there is nothing closed to withhold. This is the conservative reading, and it is what
        // makes the rule safe on a transcript whose turn structure the plugin cannot see.
        expect(planWithheldThoughts(noUser)).toEqual([]);
        expect(
            planWithheldThoughts(noUser, settingsWith({ dropOldThoughts: 'all' })).map((candidate) => ({
                index: candidate.entryIndex,
                turn: candidate.turn
            }))
        ).toEqual([
            { index: 0, turn: 'open' },
            { index: 1, turn: 'open' }
        ]);
    });

    it('minThoughtChars rejects the thinking side BELOW the floor, over what the rescue leaves, and 0 is inert', () => {
        // The would-be total under `turn` is 10 + 20 = 30 characters.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ minThoughtChars: 31 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([]);
        // Exactly at the floor is NOT below it, so the pass writes — the boundary is `chars < floor`.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ minThoughtChars: 30 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([1, 3]);
        // ORDER: tier → rescue → floor. With keep-1 the would-be total is 10, so a floor of 11
        // rejects a pass the unrescued 30 would have cleared.
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ dropOldThoughts: 'turn', thoughtKeepUnits: 1, minThoughtChars: 11 })
            )
        ).toEqual([]);
        expect(
            planWithheldThoughts(
                entriesFrom(THOUGHTS),
                settingsWith({ dropOldThoughts: 'turn', thoughtKeepUnits: 1, minThoughtChars: 10 })
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([1]);
        // 0 (the shipped default) measures nothing at all, and a 1-character thinking entry still
        // writes with the floor off. (`all`, because that entry is the OPEN turn — the boundary, not
        // the floor, is what decides that one.)
        expect(
            planWithheldThoughts(
                entriesFrom([{ role: 'user', content: 'q' }, think('tiny', 1)]),
                settingsWith({ dropOldThoughts: 'all', minThoughtChars: 0 })
            ).map((candidate) => candidate.entryIndex)
        ).toEqual([1]);
        // A nonsense floor behaves as 0, like every other number edge in this plugin.
        expect(
            planWithheldThoughts(entriesFrom(THOUGHTS), settingsWith({ minThoughtChars: -5 })).map(
                (candidate) => candidate.entryIndex
            )
        ).toEqual([1, 3]);
    });

    it('minTokens NEVER gates the thinking side, at any value (the estimator does not count reasoning)', () => {
        const entries = entriesFrom(THOUGHTS);

        // The plan function does not read the token floor at all: an unreachable one leaves the
        // thinking plan identical to the default one, character for character.
        expect(
            planWithheldThoughts(entries, settingsWith({ minTokens: 1000000 }))
        ).toEqual(planWithheldThoughts(entries));

        // And the TOOL side is gated by exactly that value on the same transcript shape, so the two
        // floors really are two separate measurements (the proof deferred from T5).
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), settingsWith({ minTokens: 1000000 }))).toEqual([]);
        expect(planTrimmedUnits(entriesFrom(TRIMMABLE), TRIMMER_DEFAULT_SETTINGS)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// T6 — the thinking WRITES and the one-diagnostic REPORT
// ---------------------------------------------------------------------------

// The `data.thoughts` entries of a `turn` pass over THOUGHTS, spelled out once because three cases
// below need them and each one is a line the operator reads: the entry, its durable id, WHICH TURN
// it belongs to, and the characters the flag removes.
const THOUGHTS_REPORT = [
    { index: 1, messageId: 'msg-2', turn: 'closed', chars: 10, firedBy: 'dropOldThoughts', tier: 'turn' },
    { index: 3, messageId: 'msg-4', turn: 'closed', chars: 20, firedBy: 'dropOldThoughts', tier: 'turn' }
];

// The one message a `turn` pass over THOUGHTS writes, hardcoded from the format and the fixture —
// the byte-identity claim for the thinking section, in the same style as A1's for the tool section.
const THOUGHTS_MESSAGE =
    'context-trimmer withheld 2 thinking entry(s): ' +
    '#1 msg-2 closed 10 chars via dropOldThoughts=turn; #3 msg-4 closed 20 chars via dropOldThoughts=turn';

// The tool rule AND the thinking rule on one transcript, so the two axes can be pinned inside ONE
// pass — one pause window, one diagnostic, one report:
//   0 user    'question'
//   1 assistant TOOL BLOCK, 10 chars of thinking  ← the all-`failed` unit's leader, CLOSED
//   2 tool    c1 `failed`
//   3 assistant TOOL BLOCK, 20 chars of thinking  ← the answering unit (a KEEP), CLOSED
//   4 tool    c2 completed
//   5 user    'now'                                ← THE BOUNDARY
//   6 assistant, 30 chars of thinking              OPEN — `turn` must not touch it
const THOUGHTS_AND_UNIT: readonly HarnessMessage[] = [
    { role: 'user', content: 'question' },
    callThinking('c1', 'read', '{"path":"a.ts"}', 10),
    result('c1', 'read', 'Tool "read" failed: EACCES', 'failed'),
    callThinking('c2', 'read', '{"path":"b.ts"}', 20),
    result('c2', 'read', 'export const b = 2;'),
    { role: 'user', content: 'now' },
    think('open', 30)
];

describe('context-trimmer thinking writes and report (T6)', () => {
    it('writes the flag on exactly the closed entries and reports one thinking-only pass', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);

        await expect(executeTrimming(api, createFakeTurn({ api, calls, entries }))).resolves.toBeUndefined();

        // One write per candidate, oldest first, and NOTHING else touched — no `setIncluded`, no
        // `edit`, no `replaceHistory`, no `setTranscript`.
        expect(calls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        // The WRITE is the flag, on the canonical message, and only `false` is ever stored: the open
        // turn (6) and the thinking-less entry (4) are untouched, and no entry gained `true`.
        expect((entries[1].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[3].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[6].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBeUndefined();
        expect(calls.every((call) => call.endsWith(':false'))).toBe(true);
        // The THINKING TEXT SURVIVES the write — the flag is not an edit, which is what keeps this
        // plugin's "nothing is deleted, it can be switched back on" promise true for thinking.
        expect(entries[1].message).toMatchObject({ reasoning: 'x'.repeat(10) });
        expect(entries[3].message).toMatchObject({ reasoning: 'x'.repeat(20) });
        // One settings read set plus the diagnostic: a pass has exactly one report.
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);

        expect(diagnostics).toHaveLength(1);
        // NO tool section on a thinking-only pass — the section is conditional, so the message a
        // tool-only pass has always written stays byte-identical.
        expect(diagnostics[0].message).toBe(THOUGHTS_MESSAGE);
        expect(diagnostics[0].data).toEqual({
            units: [],
            thoughts: THOUGHTS_REPORT,
            // `fired` names the ONE switch that accounts for these writes — and only it. Without the
            // plan-is-empty guard, `[].every` would have reported all three tool switches as fired
            // for units that do not exist in this pass.
            policy: { ...DEFAULT_POLICY, fired: ['dropOldThoughts'] }
        });
    });

    it('is idempotent: a second pass over the transcript it just wrote writes, notifies, saves and reports NOTHING', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);
        const context = createFakeTurn({ api, calls, entries });

        await executeTrimming(api, context);

        expect(calls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        expect(diagnostics).toHaveLength(1);

        // Same round, same transcript, settings unchanged. The fake flips the very field the policy
        // re-reads, so this is the real re-derive, not a fake that forgot.
        await executeTrimming(api, context);

        expect(calls).toHaveLength(2);
        expect(diagnostics).toHaveLength(1);
        // The only thing the second round cost was the settings reads — no write, no notification,
        // and therefore no save, and no diagnostic.
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic', ...TURN_READS]);
    });

    it('runs as "turn" and SAYS SO when the tier submitted is not a tier, and still writes only the closed turns', async () => {
        const { api, touches, diagnostics } = createFakeApi({ dropOldThoughts: 'sometimes' });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS) }));

        // Behaviour: `turn`.
        expect(calls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        expect(touches).toEqual([...TURN_READS, 'report.diagnostic']);
        expect(diagnostics).toHaveLength(1);

        // Report: BOTH what was submitted and what ran, appended as the fallback clause in the one
        // message — the thinking section first, then the clause, joined by ' | '.
        expect(diagnostics[0].message).toBe(`${THOUGHTS_MESSAGE} | dropOldThoughts "sometimes" is not a tier; used "turn"`);

        const data = diagnostics[0].data as {
            thoughts: unknown[];
            policy: Record<string, unknown>;
        };

        expect(data.thoughts).toEqual(THOUGHTS_REPORT);
        expect(data.policy).toMatchObject({
            dropOldThoughts: 'turn',
            dropOldThoughtsSubmitted: 'sometimes',
            dropOldThoughtsFallback: true,
            fired: ['dropOldThoughts']
        });
        // The candidate list itself carries the RESOLVED tier, so a per-entry line can never name a
        // value the pass did not run with.
        expect((data.thoughts as Array<{ tier: string }>).map((thought) => thought.tier)).toEqual([
            'turn',
            'turn'
        ]);
    });

    it('minTokens cannot suppress a thinking write at any value, while the same floor still empties the tool side', async () => {
        // The estimator never counts `reasoning` (../core/context-estimate.ts), so a token floor
        // shared with the thinking writes would silently disable `dropOldThoughts` above 0 — the
        // proof deferred from T5, and the reason the two floors are two measurements.
        const { api, diagnostics } = createFakeApi({ minTokens: 1000000 });
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS) }));

        expect(calls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(THOUGHTS_MESSAGE);

        // Same fixture with a TOOL candidate next to it: the unreachable floor drops the unit write
        // and every thinking write survives — including the leader's own, which the same pass no
        // longer excludes from the request (rule (3b) reads the plan, not the settings).
        const toolFloor = createFakeApi({ minTokens: 1000000 });
        const toolCalls: string[] = [];

        await executeTrimming(
            toolFloor.api,
            createFakeTurn({ api: toolFloor.api, calls: toolCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(toolCalls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        expect((toolFloor.diagnostics[0].data as { units: unknown[] }).units).toEqual([]);
        expect(
            (toolFloor.diagnostics[0].data as { thoughts: Array<{ index: number; chars: number }> }).thoughts
        ).toEqual([
            { index: 1, messageId: 'msg-2', turn: 'closed', chars: 10, firedBy: 'dropOldThoughts', tier: 'turn' },
            { index: 3, messageId: 'msg-4', turn: 'closed', chars: 20, firedBy: 'dropOldThoughts', tier: 'turn' }
        ]);
        expect((toolFloor.diagnostics[0].data as { policy: { fired: string[] } }).policy.fired).toEqual([
            'dropOldThoughts'
        ]);
    });

    it('minThoughtChars bites at the pass level, and the TOOL side is untouched by it', async () => {
        // Above the 30 characters this pass would remove: nothing at all happens — no flag, no
        // notification, no save, no diagnostic.
        const high = createFakeApi({ minThoughtChars: 31 });
        const highCalls: string[] = [];

        await executeTrimming(high.api, createFakeTurn({ api: high.api, calls: highCalls, entries: entriesFrom(THOUGHTS) }));

        expect(highCalls).toEqual([]);
        expect(high.diagnostics).toEqual([]);
        expect(high.touches).toEqual([...TURN_READS]);

        // Exactly at the floor it writes (the comparison is `chars < floor`).
        const exact = createFakeApi({ minThoughtChars: 30 });
        const exactCalls: string[] = [];

        await executeTrimming(
            exact.api,
            createFakeTurn({ api: exact.api, calls: exactCalls, entries: entriesFrom(THOUGHTS) })
        );

        expect(exactCalls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);

        // THE INDEPENDENCE, in the other direction: a floor that suppresses the thinking side leaves
        // the tool rule's message BYTE-IDENTICAL to A1's — no empty section, no trailing separator.
        const mixed = createFakeApi({ minThoughtChars: 21 });
        const mixedCalls: string[] = [];

        await executeTrimming(
            mixed.api,
            createFakeTurn({ api: mixed.api, calls: mixedCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        // The unit still leaves, and it is the ONLY thing the pass reports: the thinking side's one
        // candidate is 20 characters, under the 21-character floor.
        expect(mixedCalls).toEqual(['setIncluded:1:false']);
        expect(mixed.diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(mixed.diagnostics[0].data).toEqual({
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    outcomes: ['failed'],
                    invalidOutcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'dropSupersededToolCalls',
                    admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered']
                }
            ],
            thoughts: [],
            // The policy block echoes the settings the pass RAN with, so the moved floor is part of
            // the record even though the thinking side wrote nothing.
            policy: { ...DEFAULT_POLICY, minThoughtChars: 21 }
        });
    });

    it('one pass, one report: both axes in a single diagnostic, and neither names the other entry twice', async () => {
        const { api, diagnostics } = createFakeApi();
        const calls: string[] = [];

        await executeTrimming(
            api,
            createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        // Tool write first, then the thinking write — one pause window around both (the trigger
        // section below pins the park itself).
        expect(calls).toEqual(['setIncluded:1:false', 'setReasoningIncluded:3:false']);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4' +
                ' | context-trimmer withheld 1 thinking entry(s): #3 msg-4 closed 20 chars via dropOldThoughts=turn'
        );

        const data = diagnostics[0].data as { units: unknown[]; thoughts: unknown[]; policy: { fired: string[] } };

        expect(data.units).toEqual([
            {
                index: 1,
                messageId: 'msg-2',
                members: [1, 2],
                outcomes: ['failed'],
                invalidOutcomes: ['failed'],
                names: ['read'],
                supersededBy: 'msg-4',
                firedBy: 'dropSupersededToolCalls',
                admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered']
            }
        ]);
        expect(data.thoughts).toEqual([
            { index: 3, messageId: 'msg-4', turn: 'closed', chars: 20, firedBy: 'dropOldThoughts', tier: 'turn' }
        ]);
        // Declared order, both axes named: the two tool switches that account for the unit, then the
        // thinking switch that accounts for the flag.
        expect(data.policy.fired).toEqual([
            'dropSupersededToolCalls',
            'dropInvalidToolCallsOnceAnswered',
            'dropOldThoughts'
        ]);
    });

    it('dropOldThoughts "off" leaves the tool rule BYTE-IDENTICAL, and the tool switches off leave the thinking rule running', async () => {
        // H2 in both directions, on the SAME transcript.
        const off = createFakeApi({ dropOldThoughts: 'off' });
        const offCalls: string[] = [];

        await executeTrimming(
            off.api,
            createFakeTurn({ api: off.api, calls: offCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(offCalls).toEqual(['setIncluded:1:false']);
        expect(off.diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): #1 msg-2 [failed] read answered by msg-4'
        );
        expect(off.diagnostics[0].data).toEqual({
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    outcomes: ['failed'],
                    invalidOutcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4',
                    firedBy: 'dropSupersededToolCalls',
                    admittedBy: ['dropSupersededToolCalls', 'dropInvalidToolCallsOnceAnswered']
                }
            ],
            thoughts: [],
            // Same rule as above: the block names the tier that RAN, and `off` is what ran.
            policy: { ...DEFAULT_POLICY, dropOldThoughts: 'off', dropOldThoughtsSubmitted: 'off' }
        });

        // The other half: both TOOL switches off, thinking still withheld, and the tool section gone.
        const toolOff = createFakeApi({
            dropSupersededToolCalls: false,
            dropInvalidToolCallsOnceAnswered: false
        });
        const toolCalls: string[] = [];

        await executeTrimming(
            toolOff.api,
            createFakeTurn({ api: toolOff.api, calls: toolCalls, entries: entriesFrom(THOUGHTS_AND_UNIT) })
        );

        expect(toolCalls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        expect(toolOff.diagnostics[0].message).toBe(
            'context-trimmer withheld 2 thinking entry(s): ' +
                '#1 msg-2 closed 10 chars via dropOldThoughts=turn; #3 msg-4 closed 20 chars via dropOldThoughts=turn'
        );
        expect(
            (toolOff.diagnostics[0].data as { policy: { fired: string[] } }).policy.fired
        ).toEqual(['dropOldThoughts']);
    });

    it('is withhold-only: flipping the tier to "off" mid-session stops writes and restores nothing', async () => {
        const { api, setSetting, diagnostics } = createFakeApi();
        const calls: string[] = [];
        const entries = entriesFrom(THOUGHTS);
        const context = createFakeTurn({ api, calls, entries });

        await executeTrimming(api, context);

        expect(calls).toEqual(['setReasoningIncluded:1:false', 'setReasoningIncluded:3:false']);
        expect(diagnostics).toHaveLength(1);

        // An operator moves the switch between turns. `api.settings` is LIVE by contract
        // (../plugin/settings.ts), so the next round runs the new value with no restart.
        setSetting('dropOldThoughts', 'off');

        await executeTrimming(api, context);

        expect(calls).toHaveLength(2);
        expect(diagnostics).toHaveLength(1);

        // And the flags the earlier turn wrote are STILL there: `off` stops new writes and restores
        // nothing (F invariant 2). That is only true because the decision lives on the ENTRY — a
        // per-round decision the plugin had to remember would have evaporated with the round.
        expect((entries[1].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
        expect((entries[3].message as { reasoningIncluded?: boolean }).reasoningIncluded).toBe(false);
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
            createFakeTurn({ api: disabled.api, calls: disabledCalls, entries: entriesFrom(THOUGHTS), guardEntries: true })
        );

        expect(disabledCalls).toEqual([]);
        expect(disabled.diagnostics).toEqual([]);
        expect(disabled.touches).toEqual(['settings.boolean:enabled']);
    });

    it('takes the ASYNC path for a thinking-only pass and the SYNC one when the tier is off', async () => {
        const handler = createContextTrimmerHandler(createFakeApi().api);
        const { api } = createFakeApi();
        const calls: string[] = [];

        // A pass that writes thinking is a real trim: a promise, and the park/trim/unpark triple.
        const writing = handler(
            createFakeTurn({ api, calls, entries: entriesFrom(THOUGHTS) })
        );

        expect(writing).toBeInstanceOf(Promise);
        await writing;
        expect(calls).toEqual([
            'pause',
            'setReasoningIncluded:1:false',
            'setReasoningIncluded:3:false',
            'resume'
        ]);

        // The same transcript with the switch off: `undefined`, no park, no microtask — the fast path
        // that keeps the shipped turn cost unchanged now has to account for BOTH axes.
        const offApi = createFakeApi({ dropOldThoughts: 'off' });
        const offCalls: string[] = [];

        expect(
            createContextTrimmerHandler(offApi.api)(
                createFakeTurn({ api: offApi.api, calls: offCalls, entries: entriesFrom(THOUGHTS) })
            )
        ).toBeUndefined();
        expect(offCalls).toEqual([]);
    });
});

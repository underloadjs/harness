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
//   plus the plugin's declared metadata (exactly one setting) and the synchronous fast path:
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
    setup,
    type TrimCandidate
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
const TRIMMABLE_CANDIDATE: TrimCandidate = {
    leaderIndex: 1,
    leaderMessageId: 'msg-2',
    members: [1, 2],
    outcomes: ['failed'],
    names: ['read'],
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
            { ...TRIMMABLE_CANDIDATE, outcomes: ['rejected'] }
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
        expect(touches).toEqual(['settings.boolean:enabled', 'report.diagnostic']);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toBe(
            'context-trimmer withheld 1 superseded tool unit(s): ' +
                '#1 msg-2 [failed] read answered by msg-4'
        );
        expect(diagnostics[0].data).toEqual({
            units: [
                {
                    index: 1,
                    messageId: 'msg-2',
                    members: [1, 2],
                    outcomes: ['failed'],
                    names: ['read'],
                    supersededBy: 'msg-4'
                }
            ]
        });
    });

    it('A2: writes and reports nothing when nothing was superseded', async () => {
        const { api, touches, diagnostics } = createFakeApi();
        const calls: string[] = [];

        await executeTrimming(api, createFakeTurn({ api, calls }));

        expect(calls).toEqual([]);
        expect(diagnostics).toEqual([]);
        expect(touches).toEqual(['settings.boolean:enabled']);
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
        // control — park, write, edit, rewrite — was touched at all.
        expect(result).toBeUndefined();
        expect(calls).toEqual([]);
        expect(touches).toEqual(['settings.boolean:enabled']);
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
        expect(touches).toEqual(['settings.boolean:enabled']);
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
        expect(touches).toEqual(['settings.boolean:enabled', 'report.diagnostic']);
    });
});

// ---------------------------------------------------------------------------
// Metadata: exactly the one declared knob
// ---------------------------------------------------------------------------

describe('context-trimmer metadata', () => {
    it('declares one setting and the one hook it uses', () => {
        expect(metadata.name).toBe('context-trimmer');
        expect(metadata.title).toBe('Context Trimmer');
        expect(metadata.builtin).toBe(true);
        expect(metadata.version).toBe('1.0.0');
        expect(metadata.tags).toEqual(['context', 'trimming', 'lifecycle']);
        // The trigger point this plugin needs, and nothing else, so the live hook surface and
        // the declared intent stay identical.
        expect(metadata.hooks).toEqual(['turn.before']);

        // ONE knob: `enabled`, the key the framework reserves for the global toggle, so the
        // Plugins dialog and that toggle address the same stored value. (`min`/`step` are read
        // through the DECLARED descriptor type: `satisfies` narrows `metadata.settings` to the
        // literal, and this plugin declares no numeric hints at all.)
        expect(
            metadata.settings?.map((setting: HarnessPluginSettingDescriptor) => [
                setting.key,
                setting.type,
                setting.default,
                setting.min,
                setting.step
            ])
        ).toEqual([['enabled', 'boolean', true, undefined, undefined]]);

        for (const setting of metadata.settings ?? []) {
            expect(typeof setting.description).toBe('string');
            expect((setting.description ?? '').length).toBeGreaterThan(40);
        }

        // The description carries the two promises the feature is judged on.
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
});

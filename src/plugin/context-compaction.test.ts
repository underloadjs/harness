// The shipped `context-compaction` preset plugin (src/plugins/context-compaction.plugin.ts).
//
// WHAT THIS FILE PINS
// -------------------
// The TRIGGER, the PAUSE lifecycle, and the ACTION as a writer over the pure policy
// (../core/context-pruning.ts — whose own rule table is pinned in
// src/core/context-pruning.test.ts; this file pins the PLUGIN half: settings, guards,
// writes, reports, and behaviour through a real harness):
//
//   1. BELOW the limit: nothing happens at all (no park, no action, no transcript change);
//   2. AT/ABOVE the limit: park -> action (exactly once, with the SAME api and the SAME
//      turn context object) -> un-park, and the un-park also happens when the action
//      throws, because a failed compaction must not strand a conversation in 'paused';
//   3. the per-thread COOLDOWN: an unchanged over-limit estimate does not fire again,
//      growth past the 5%-of-limit margin does, and dropping below the limit makes the
//      next crossing fresh again;
//   4. the internal `summarizer` conversation is never compacted (recursion guard), and a
//      BRANCH round never triggers a pass at all (ratified 2026-11-09: its flag writes are
//      ephemeral and its cooldown key could never be cleared);
//   5. the ACTION: it prunes exactly the superseded failure and nothing else, re-reads
//      `enabled`/`minTokens`/`safetyTurns`/`mode` every pass, degrades an unimplemented
//      `mode` to `exclude` while REPORTING both, never rewrites history, and says what it
//      did on `api.report.diagnostic` (T4.5). Through a real harness the flag is canonical
//      state, ONE `agent_message` reports a multi-unit pass (T4.4), and a second pass
//      changes and notifies nothing.
//
// Two levels of test, deliberately: the guard factory is exercised with fakes, where the
// token estimates are exact inputs and every control is observable; the shipped built-in
// is then exercised through a REAL harness with a scripted transport, where the estimate
// comes from the harness itself (core/context-estimate.ts, ceil(chars / 4)) and the
// pause/resume are real `thread.paused` / `thread.resumed` events plus real roster
// statuses. The integration numbers are derived from that documented formula, not
// reverse-engineered from a run.
//
// Cross-references:
//   - ../plugins/context-compaction.plugin.ts — the implementation under test
//   - ../core/context-pruning.ts              — THE POLICY, pure and table-tested elsewhere
//   - ../core/context-estimate.ts             — the estimate the integration numbers use
//   - ../harness.ts (`emitTurnBefore`)        — the real pause/resume + token estimate, the
//                                               `setIncluded` write, and the per-round
//                                               notification coalescing (T4.4)
//   - ./hooks.ts                              — fail-open dispatch of a throwing handler
//   - ../harness.plugin.test.ts               — the transport helpers mirrored below

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type {
    Harness,
    HarnessContextEntry,
    HarnessDiagnosticEvent,
    HarnessLifecycleHandler,
    HarnessMessage,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginDiagnosticReport,
    HarnessPluginSettingsProvider,
    HarnessSnapshot,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessToolOutcome,
    HarnessTurnBeforeContext
} from '@underload/harness';
import {
    COMPACTION_MODES,
    createContextCompactionHandler,
    executeCompaction,
    isInternalAgent,
    metadata,
    setup
} from '../plugins/context-compaction.plugin';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// ---------------------------------------------------------------------------
// Fakes: every control records its own name, so "blank" and "exactly once" are
// assertions about a recorded CALL SEQUENCE rather than about side effects.
// ---------------------------------------------------------------------------

// One shared, frozen-by-convention transcript so a test can assert the action never even
// swapped the array it was handed.
const TURN_MESSAGES: readonly HarnessMessage[] = [{ role: 'user', content: 'question' }];

type FakeApi = {
    api: HarnessPluginApi;
    // Everything the api was asked to do, in order (settings reads included).
    touches: string[];
    // T4.5 — every diagnostic the action reported, in order.
    diagnostics: HarnessPluginDiagnosticReport[];
    // Simulates an operator changing the stored limit between turns.
    setLimit: (value: number) => void;
    // ...or any other setting the action reads.
    setSetting: (key: string, value: number | string | boolean) => void;
};

// A complete `HarnessPluginApi`. Any control other than a settings read and the diagnostic
// channel is a FAILURE: `skip` records it and throws, so an action that tried to spawn a
// thread, disable a tool or wake async work fails the test loudly instead of passing
// silently. The settings are backed by a MAP rather than one number for every key: the
// action now reads four of them, and a test that wants `minTokens: 20` has to be able to
// say so without also changing the limit.
const createFakeApi = (
    limit: number,
    stored: Record<string, number | string | boolean> = {}
): FakeApi => {
    const touches: string[] = [];
    const diagnostics: HarnessPluginDiagnosticReport[] = [];
    const values: Record<string, unknown> = { contextLimit: limit, ...stored };

    const skip = (name: string): never => {
        touches.push(name);
        throw new Error(`The compaction action touched ${name}.`);
    };

    const api: HarnessPluginApi = {
        agents: {},
        tools: {},
        createAgent: () => skip('createAgent'),
        addTool: () => skip('addTool'),
        addCommand: () => skip('addCommand'),
        // The guard never subscribes; only `setup` does, and that test replaces `on`.
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
            // T3.5: the write edge is part of the api, so "the compactor never persisted
            // its own setting" stays provable.
            setOwn: (key) => skip(`settings.setOwn:${key}`)
        },
        // T4.5 — the plugin's own diagnostic channel is RECORDED rather than skipped: the
        // pass report is half of what the action is expected to produce, and the message
        // text is asserted case by case below.
        report: {
            diagnostic: (report) => {
                touches.push('report.diagnostic');
                diagnostics.push(report);
            }
        },
        // T3.5 — the read-only persisted-state view is a control too, so it stays a `skip`.
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
        setLimit: (value: number) => {
            values.contextLimit = value;
        },
        setSetting: (key: string, value: number | string | boolean) => {
            values[key] = value;
        }
    };
};

// A full `turn.before` payload whose controls push into `calls`. `entries` defaults to a
// single user turn (nothing prunable), and `setIncluded` RECORDS the write and flips the
// entry's flag, so a test can assert both what was disabled and what was not — the entries
// a real round hands out carry the effective unit flag, and the policy reads it again on
// the next pass (that is the idempotence T4.3 depends on).
const createFakeTurn = (input: {
    api: HarnessPluginApi;
    estimatedTokens: number;
    calls: string[];
    threadId?: string;
    agent?: string;
    entries?: readonly HarnessContextEntry[];
    branchId?: string;
    actorKey?: string;
    // The live estimate. Deliberately independent of `estimatedTokens` so a test that
    // wanted to prove "the action measured with the estimator, not with this number" can
    // see them disagree.
    currentTokens?: number;
}): HarnessTurnBeforeContext => {
    const entries = input.entries ?? [entryOf(0, { role: 'user', content: 'question' })];

    return {
        threadId: input.threadId ?? 'thread-1',
        agent: input.agent ?? 'writer',
        iteration: 1,
        // T3.4/T8 — the discriminator every payload now carries. A fake ROOT round reports the
        // registered agent's own scheduling key and no branch id at all, which is exactly the
        // shape a real root round has.
        actorKey: input.actorKey ?? input.agent ?? 'writer',
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        messages: TURN_MESSAGES,
        estimatedTokens: input.estimatedTokens,
        signal: new AbortController().signal,
        api: input.api,
        setTranscript: () => {
            input.calls.push('setTranscript');
        },
        // T3 — the second mutation control, recorded like the others so a compaction that
        // started editing entries becomes visible in the same call list.
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

            // Flip the flag on the ENTRY the plan was built from, so a second action over the
            // same list sees what the runtime would see after the write.
            const entry = entries[index] as { included?: boolean } | undefined;

            if (entry !== undefined) entry.included = included === true;
        },
        currentMessages: () => TURN_MESSAGES,
        // Context T5 — the live view of the same number.
        currentEstimatedTokens: () => input.currentTokens ?? input.estimatedTokens,
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
};

// ---------------------------------------------------------------------------
// Entry fixtures
// ---------------------------------------------------------------------------

// One canonical entry, built the way the runtime builds them: an index, the live message,
// the durable id, and the EFFECTIVE flag of its unit. `included` is writable here because
// `setIncluded` above flips it.
const entryOf = (
    index: number,
    message: HarnessMessage,
    included = true
): HarnessContextEntry =>
    ({
        index,
        message: { ...message, messageId: `msg-${index + 1}` },
        messageId: `msg-${index + 1}`,
        included
    }) as HarnessContextEntry;

// The transcript the action tests share: one `read` that failed, the SAME call answered
// later (arguments reordered, so only the fingerprint can match), and a turn on each side.
// The result text is 900 characters so the pass clears any floor a test names.
const prunableEntries = (disabledLeaders: readonly number[] = []): HarnessContextEntry[] => {
    const messages: HarnessMessage[] = [
        { role: 'user', content: 'open a' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
        },
        {
            role: 'tool',
            content: `Tool "read" failed: ${'E'.repeat(900)}`,
            toolCallId: 'c1',
            name: 'read',
            outcome: 'failed'
        },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c2', name: 'read', arguments: '{ "path" : "a.ts" }' }]
        },
        { role: 'tool', content: 'export const a = 1;', toolCallId: 'c2', name: 'read' },
        { role: 'assistant', content: 'done' }
    ];

    return messages.map((message, index) => entryOf(index, message, !disabledLeaders.includes(index)));
};

// The recording action used by the lifecycle tests: it appends 'action' to the SAME array
// the park/unpark controls use, so one assertion pins the ORDER of the whole sequence.
const createRecordingAction = (calls: string[]) => {
    const seen: Array<{ api: HarnessPluginApi; context: HarnessTurnBeforeContext }> = [];

    return {
        seen,
        action: async (api: HarnessPluginApi, context: HarnessTurnBeforeContext): Promise<void> => {
            calls.push('action');
            seen.push({ api, context });
        }
    };
};

// One `pause -> action -> resume` triple, spelled out so the expected sequences below stay
// readable instead of repeating the same three strings eleven times.
const TRIPLE = ['pause', 'action', 'resume'];

// `count` triples, built with a plain loop (no `Array.prototype.flat`, which the package's
// `lib` list does not include).
const triples = (count: number): string[] => {
    const expected: string[] = [];

    for (let index = 0; index < count; index += 1) expected.push(...TRIPLE);

    return expected;
};

// ---------------------------------------------------------------------------
// Scripted transport (mirrors src/harness.plugin.test.ts: turns replay in order)
// ---------------------------------------------------------------------------

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// No `instruction`, so the agent has no instruction blocks and the estimate is exactly
// ceil(sum of message content chars / 4) (core/context-estimate.ts).
const brain = (stream: HarnessStream) => agent({ model: 'merge/ds4-flash', stream });

// The settings an operator would type in the Plugins pane, as a stored document. Every key
// this plugin reads may appear; anything it does NOT store falls back to its DECLARED
// default, which is what the default-floor case below depends on.
const settingsOf = (values: Record<string, number | string | boolean>): HarnessPluginSettingsProvider => ({
    get: (plugin, key) => (plugin === 'context-compaction' ? values[key] : undefined)
});

// The one-key spelling: just the limit.
const limitAt = (value: number): HarnessPluginSettingsProvider => settingsOf({ contextLimit: value });

// A HOST plugin (applied after the built-ins), so its `turn.before` observer sees the same
// estimate the compactor saw, and its `thread.paused` / `thread.resumed` handlers record
// the park the built-in produced.
const probe = (events: string[], estimates: number[]): HarnessPlugin => ({
    name: 'probe',
    setup: (api) => {
        api.on('thread.paused', () => {
            events.push('paused');
        });
        api.on('thread.resumed', () => {
            events.push('resumed');
        });
        api.on('turn.before', (payload) => {
            estimates.push(payload.estimatedTokens);
        });
    }
});

describe('context-compaction metadata', () => {
    it('declares exactly the knobs the ratified answers name', () => {
        expect(metadata.name).toBe('context-compaction');
        expect(metadata.title).toBe('Context Compaction');
        // The trigger point this plugin needs, and nothing else, so the live hook surface
        // and the declared intent stay identical.
        expect(metadata.hooks).toEqual(['turn.before']);

        // T4.6: `enabled`, the limit, the savings floor, the horizon, and the mode. The
        // numbers below ARE the ratified answers (T0 Q2's floor, Q3's horizon), and each
        // default is duplicated as a fallback constant beside the plugin's own reads — a
        // drift between the two changes one of the assertions in this file.
        expect(
            metadata.settings?.map((setting) => [
                setting.key,
                setting.type,
                setting.default,
                setting.min,
                setting.step
            ])
        ).toEqual([
            ['contextLimit', 'number', 100000, 1000, 1000],
            ['enabled', 'boolean', true, undefined, undefined],
            ['minTokens', 'number', 200, 0, 50],
            ['safetyTurns', 'number', 6, 0, 1],
            ['mode', 'string', 'exclude', undefined, undefined]
        ]);

        // Every knob has to explain itself to the operator who is about to type a number
        // into it; a silent default is how a policy gets blamed for the wrong reason.
        for (const setting of metadata.settings ?? []) {
            expect(typeof setting.description).toBe('string');
            expect((setting.description ?? '').length).toBeGreaterThan(40);
        }

        const descriptionOf = (key: string): string =>
            String((metadata.settings ?? []).find((setting) => setting.key === key)?.description);

        // The three texts that carry a DECISION rather than a label.
        expect(descriptionOf('minTokens')).toContain('prompt-cache');
        expect(descriptionOf('safetyTurns')).toContain('END of the conversation');
        expect(descriptionOf('safetyTurns')).toContain('never the per-run turn counter');
        expect(descriptionOf('mode')).toContain('"annotate"');
        expect(descriptionOf('mode')).toContain('behaves as "exclude"');

        // `mode` enumerates ONLY what this build implements, so the UI cannot offer a value
        // that does nothing, and the list the plugin falls back to is that one value.
        expect(COMPACTION_MODES).toEqual(['exclude']);
    });
});

describe('context-compaction trigger (createContextCompactionHandler)', () => {
    it('does nothing below the limit and never touches the thread', async () => {
        const { api, touches } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);

        // 99 < 100: one settings read, and that is the whole turn. The fast path returns
        // `undefined` SYNCHRONOUSLY (no promise), which is the point — see the plugin's
        // "WHY THE FAST PATH IS SYNCHRONOUS".
        expect(handler(createFakeTurn({ api, estimatedTokens: 99, calls }))).toBeUndefined();

        expect(calls).toEqual([]);
        expect(seen).toEqual([]);
        expect(touches).toEqual(['settings.boolean:enabled', 'settings.number:contextLimit']);
    });

    it('parks, runs the action once with the same api and context, then un-parks', async () => {
        const { api, touches } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const context = createFakeTurn({ api, estimatedTokens: 100, calls });

        // EXACTLY at the limit (not above it) is already "reached".
        const result = handler(context);
        // A real trigger is the only path that returns a promise; the under-limit fast path
        // stays synchronous.
        expect(result).toBeInstanceOf(Promise);
        await result;

        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(1);
        // Identity, not equality: the action gets the harness control surface and the very
        // parked turn it is compacting.
        expect(seen[0].api).toBe(api);
        expect(seen[0].context).toBe(context);
        expect(touches).toEqual(['settings.boolean:enabled', 'settings.number:contextLimit']);
    });

    it('un-parks when the action throws and lets the error reach the bus', async () => {
        const { api, touches } = createFakeApi(100);
        const calls: string[] = [];

        const handler = createContextCompactionHandler(api, async (): Promise<void> => {
            calls.push('action');
            throw new Error('compaction failed');
        });

        // The plugin resumes and RE-RAISES: the hook bus is the only fail-open authority
        // (plugin/hooks.ts rule 2), so the plugin never decides about the run.
        await expect(handler(createFakeTurn({ api, estimatedTokens: 100, calls }))).rejects.toThrow(
            'compaction failed'
        );

        expect(calls).toEqual(TRIPLE);
        expect(touches).toEqual(['settings.boolean:enabled', 'settings.number:contextLimit']);
    });

    it('fires on a fresh crossing, holds inside the 5% margin, and fires again past it', async () => {
        const { api } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, estimatedTokens, calls }));
        };

        // margin = floor(100 * 0.05) = 5, so the threshold after a fire at 100 is 105.
        await run(99);
        expect(calls).toEqual([]);

        await run(100);
        expect(calls).toEqual(triples(1));

        // Over the limit but inside the margin: a blank action must not park every turn.
        await run(104);
        expect(calls).toEqual(triples(1));

        // Grown by exactly the margin -> re-arm.
        await run(105);
        expect(calls).toEqual(triples(2));

        // Unchanged again relative to the NEW mark (105 + 5 = 110).
        await run(109);
        expect(calls).toEqual(triples(2));

        // Back under the limit: the guard is forgotten, so the next crossing is fresh.
        await run(99);
        expect(calls).toEqual(triples(2));

        await run(100);
        expect(calls).toEqual(triples(3));
        expect(seen).toHaveLength(3);
    });

    it('keeps the cooldown per thread, not per harness', async () => {
        const { api } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (threadId: string, estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, threadId, estimatedTokens, calls }));
        };

        await run('thread-1', 100);
        await run('thread-2', 100);
        // One long conversation must not silence another that crossed at the same size.
        expect(calls).toEqual(triples(2));

        // thread-1's own mark is still 100, so 102 is inside its margin...
        await run('thread-1', 102);
        // ...while thread-2, whose mark 102 also covers, stays quiet too.
        await run('thread-2', 102);
        expect(calls).toEqual(triples(2));
        expect(seen).toHaveLength(2);
    });

    it('treats a non-positive limit as off, and re-reads the setting every turn', async () => {
        const { api, setLimit } = createFakeApi(0);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, estimatedTokens, calls }));
        };

        // 0 means "off" for any size, and so does a negative stored value.
        await run(1000000);
        setLimit(-1);
        await run(1000000);
        expect(calls).toEqual([]);

        // The same handler starts working the moment the host stores a real limit: the
        // settings read happens per turn, never once at setup.
        setLimit(100);
        await run(1000000);
        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(1);
    });

    it('never compacts an internal compaction agent', async () => {
        const { api } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);

        for (const agentName of ['summarizer', 'underload:compaction', 'plugin:condenser']) {
            await handler(createFakeTurn({ api, agent: agentName, estimatedTokens: 500, calls }));
        }

        // A compactor that spawns a summarizer would otherwise park its own helper.
        expect(calls).toEqual([]);
        expect(seen).toEqual([]);
    });

    // Ratified 2026-11-09: a branch round never triggers a pass. The two reasons are both
    // pinned here — the pass would do nothing useful (its transcript is ephemeral), AND it
    // used to leave a cooldown entry keyed by `branch:<id>`, a key nothing could ever clear
    // or reuse.
    it('never parks, acts, or records a cooldown for a branch round', async () => {
        const { api, touches } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);

        // Two branch rounds at the same size: the first is a fresh crossing, so WITHOUT the
        // skip it would park; the second would be inside its own cooldown either way.
        await handler(createFakeTurn({ api, estimatedTokens: 100, calls, branchId: 'branch-1', actorKey: 'branch:branch-1' }));
        await handler(createFakeTurn({ api, estimatedTokens: 500, calls, branchId: 'branch-2', actorKey: 'branch:branch-2' }));

        expect(calls).toEqual([]);
        expect(seen).toEqual([]);
        expect(touches).toEqual([
            'settings.boolean:enabled',
            'settings.number:contextLimit',
            'settings.boolean:enabled',
            'settings.number:contextLimit'
        ]);

        // The owner conversation is unaffected: its own crossing still fires, which is the
        // point — the branch decision must not silence the persistent conversation.
        await handler(createFakeTurn({ api, estimatedTokens: 500, calls, threadId: 'thread-9' }));
        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(1);
    });

    it('turns the whole plugin off when `enabled` is false, and reads nothing else', async () => {
        const { api, touches, setSetting } = createFakeApi(100, { enabled: true });
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);

        await handler(createFakeTurn({ api, estimatedTokens: 500, calls }));
        expect(calls).toEqual(TRIPLE);

        // The switch is re-read every turn (an operator flips it from the UI mid-session),
        // and a disabled plugin costs exactly ONE settings read — no limit read, no park,
        // no action, no transcript work.
        setSetting('enabled', false);
        calls.length = 0;
        touches.length = 0;

        expect(handler(createFakeTurn({ api, estimatedTokens: 99999, calls }))).toBeUndefined();
        expect(calls).toEqual([]);
        expect(touches).toEqual(['settings.boolean:enabled']);

        setSetting('enabled', true);
        await handler(createFakeTurn({ api, estimatedTokens: 99999, calls }));
        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(2);
    });

    it('names the internal agents the guard refuses', () => {
        expect(
            ['summarizer', 'SUMMARIZER', ' underload:compaction ', 'condenser-summarize', 'compact-worker'].map(
                isInternalAgent
            )
        ).toEqual([true, true, true, true, true]);

        // Real conversations are untouched, including the shipped profile names.
        expect(
            ['writer', 'instruct', 'research', 'workspace', 'reviewer', 'planner', 'demo', 'flaky', ''].map(
                isInternalAgent
            )
        ).toEqual([false, false, false, false, false, false, false, false, false]);
    });
});

// THE ACTION, run directly against a fake turn. The rule itself is table-tested in
// src/core/context-pruning.test.ts; these cases pin the PLUGIN's half: the settings it
// reads and re-reads, the write it performs, what it refuses to write, and the report it
// makes. Every api control except the settings read and the diagnostic channel THROWS in
// the fake, so "no thread was spawned, no tool disabled, no history replaced" is proven by
// the fixture rather than asserted.
describe('context-compaction action (executeCompaction)', () => {
    // The exact settings reads a pruning pass performs, in order — pinned because a silent
    // extra read is a silent behavioural dependency on a value the operator can change.
    const POLICY_READS = [
        'settings.boolean:enabled',
        'settings.number:minTokens',
        'settings.number:safetyTurns',
        'settings.string:mode'
    ];

    it('withholds the failed unit a later identical success answered, and reports it', async () => {
        const { api, touches, diagnostics } = createFakeApi(100, { minTokens: 10, safetyTurns: 0 });
        const calls: string[] = [];
        const entries = prunableEntries();
        const context = createFakeTurn({ api, estimatedTokens: 500, calls, entries });

        await expect(executeCompaction(api, context)).resolves.toBeUndefined();

        // ONE write, on the LEADER of the failed unit. The answering unit is untouched, and
        // the runtime's own cascade takes care of the result message (T3.4), so the policy
        // never has to name every member.
        expect(calls).toEqual(['setIncluded:1:false']);
        expect(entries[1].included).toBe(false);
        expect(entries[3].included).toBe(true);
        expect(entries[4].included).toBe(true);

        expect(touches).toEqual([...POLICY_READS, 'report.diagnostic']);

        // T4.5 — the pass report names the unit, the answer that superseded it, and the
        // saving, in text a host can print alone.
        expect(diagnostics).toHaveLength(1);

        const [report] = diagnostics;

        expect(report.message).toContain('withheld 1 superseded tool unit(s)');
        expect(report.message).toContain('mode exclude');
        expect(report.message).toContain('msg-2');
        expect(report.message).toContain('[failed] answered by msg-4');

        const data = report.data as {
            mode: string;
            minTokens: number;
            safetyTurns: number;
            maxUnits: number;
            withheldTokens: number;
            consideredUnits: number;
            units: { index: number; messageId: string; outcomes: string[]; tokens: number; supersededBy: string }[];
        };

        expect(data.mode).toBe('exclude');
        expect(data.minTokens).toBe(10);
        expect(data.safetyTurns).toBe(0);
        expect(data.maxUnits).toBe(8);
        expect(data.consideredUnits).toBe(4);
        // 236 tokens is the withheld unit: the 921-char result text (`Tool "read" failed: ` is
        // 21 + 900 E's) plus its 4-char tool name, and the leader's 19 (4-char name + the 15
        // raw argument characters) = 944 characters over the estimator's 4 chars/token, then
        // the estimator's single rounding over the whole transcript before/after. The
        // identical arithmetic is asserted from the estimator itself in
        // src/core/context-pruning.test.ts, so this number is cross-checked, not read back.
        expect(data.withheldTokens).toBe(236);
        expect(data.units).toEqual([
            {
                index: 1,
                messageId: 'msg-2',
                outcomes: ['failed'],
                tokens: 236,
                supersededBy: 'msg-4'
            }
        ]);

        // The transcript handed in is still the one handed back: pruning is a FLAG, never a
        // rewrite (R3 — context control does not delete).
        expect(context.messages).toBe(TURN_MESSAGES);
        expect(context.messages).toEqual([{ role: 'user', content: 'question' }]);
    });

    it('writes and reports nothing when no failure was answered', async () => {
        const { api, touches, diagnostics } = createFakeApi(100);
        const calls: string[] = [];

        // The default fake turn: one user message. Over-limit, but nothing superseded.
        await executeCompaction(api, createFakeTurn({ api, estimatedTokens: 500, calls }));

        expect(calls).toEqual([]);
        expect(diagnostics).toEqual([]);
        expect(touches).toEqual(POLICY_READS);
    });

    it('keeps an unanswered block, a cancelled block, a mixed block, and a retried failure', async () => {
        // Four shapes that must all survive a pass, each one a different clause of the rule,
        // plus the one shape that must prune — so a keep below is provably the rule and not a
        // fixture that never matched anything.
        const call = (id: string, name = 'read', args = '{"path":"a.ts"}'): HarnessMessage => ({
            role: 'assistant',
            content: '',
            toolCalls: [{ id, name, arguments: args }]
        });
        const result = (
            id: string,
            content: string,
            outcome?: HarnessToolOutcome,
            name = 'read'
        ): HarnessMessage => ({
            role: 'tool',
            content,
            toolCallId: id,
            name,
            ...(outcome === undefined || outcome === 'completed' ? {} : { outcome })
        });
        const askAgain = (args = '{ "path" : "a.ts" }'): HarnessMessage[] => [
            call('c2', 'read', args),
            result('c2', 'export const a = 1;')
        ];
        const bigFail = (): HarnessMessage =>
            result('c1', `Tool "read" failed: ${'E'.repeat(900)}`, 'failed');

        const cases: Array<{ name: string; messages: HarnessMessage[] }> = [
            {
                // T0 Q3: no committed result means the model may still be waiting for one.
                name: 'unanswered block',
                messages: [{ role: 'user', content: 'go' }, call('c1'), ...askAgain()]
            },
            {
                // A control outcome the agent chose, not a failure to be retried away.
                name: 'cancelled block',
                messages: [
                    { role: 'user', content: 'go' },
                    call('c1'),
                    result('c1', 'cancelled by the caller', 'cancelled'),
                    ...askAgain()
                ]
            },
            {
                // Q4's unit-level cost, taken the conservative way: one block asked for two
                // things, one failed and one answered, so withholding it whole would drop a
                // LIVE result.
                name: 'mixed block',
                messages: [
                    { role: 'user', content: 'go' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
                            { id: 'c1b', name: 'read', arguments: '{"path":"b.ts"}' }
                        ]
                    },
                    bigFail(),
                    result('c1b', 'b.ts contents'),
                    ...askAgain()
                ]
            },
            {
                // A second failure of the same work is not an answer (F5: the retry-loop
                // evidence is exactly about this case).
                name: 'retried failure',
                messages: [
                    { role: 'user', content: 'go' },
                    call('c1'),
                    bigFail(),
                    call('c2'),
                    result('c2', 'still broken', 'failed'),
                    { role: 'user', content: 'and now?' }
                ]
            }
        ];

        for (const entry of cases) {
            const { api } = createFakeApi(100, { minTokens: 1, safetyTurns: 0 });
            const calls: string[] = [];
            const entries = entry.messages.map((message, index) => entryOf(index, message));

            await executeCompaction(
                api,
                createFakeTurn({ api, estimatedTokens: 500, calls, entries })
            );

            // The case name travels INSIDE the compared object, so a failure says which of
            // the four keeps broke (vitest's message argument is not part of this package's
            // assertion style).
            expect({ kept: entry.name, calls }).toEqual({ kept: entry.name, calls: [] });
        }

        // The shape that DOES prune, on the same builders, so the four keeps above are the
        // rule rather than an accident of the fixture.
        const { api } = createFakeApi(100, { minTokens: 1, safetyTurns: 0 });
        const calls: string[] = [];
        const entries = [
            { role: 'user', content: 'go' },
            call('c1'),
            bigFail(),
            ...askAgain()
        ].map((message, index) => entryOf(index, message as HarnessMessage));

        await executeCompaction(api, createFakeTurn({ api, estimatedTokens: 500, calls, entries }));

        expect(calls).toEqual(['setIncluded:1:false']);
    });

    it('refuses a pass under minTokens, and says why instead of being silent', async () => {
        const { api, diagnostics } = createFakeApi(100, { minTokens: 5000, safetyTurns: 0 });
        const calls: string[] = [];

        await executeCompaction(
            api,
            createFakeTurn({ api, estimatedTokens: 500, calls, entries: prunableEntries() })
        );

        // Nothing was written, so nothing is persisted — a refused pass is free (T4.1/Q5).
        expect(calls).toEqual([]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('withheld nothing');
        expect(diagnostics[0].message).toContain('under the 5000 minTokens floor');
        expect(diagnostics[0].data).toMatchObject({ minTokens: 5000, withheldTokens: 236 });
    });

    it('is idempotent: a second pass over the same transcript disables nothing new', async () => {
        const { api, diagnostics } = createFakeApi(100, { minTokens: 10, safetyTurns: 0 });
        const calls: string[] = [];
        const entries = prunableEntries();
        const context = createFakeTurn({ api, estimatedTokens: 500, calls, entries });

        await executeCompaction(api, context);
        await executeCompaction(api, context);

        // ONE write total, and ONE report total: the second pass sees the live flag, proposes
        // nothing, and therefore notifies nothing (no save, no cache churn — T4.3/T4.4).
        expect(calls).toEqual(['setIncluded:1:false']);
        expect(diagnostics).toHaveLength(1);
    });

    it('honours safetyTurns as a horizon from the END of the transcript', async () => {
        // The fixture has 4 units; the candidate is unit #1 and the resolver unit #2.
        for (const [safetyTurns, expected] of [
            [0, ['setIncluded:1:false']],
            // A horizon of 2 protects units #2 and #3, so the candidate is still reachable...
            [2, ['setIncluded:1:false']],
            // ...and a horizon of 4 protects the candidate too, so nothing is pruned at all.
            [4, []]
        ] as const) {
            const { api } = createFakeApi(100, { minTokens: 10, safetyTurns });
            const calls: string[] = [];

            await executeCompaction(
                api,
                createFakeTurn({ api, estimatedTokens: 500, calls, entries: prunableEntries() })
            );

            expect(calls).toEqual([...expected]);
        }
    });

    it('takes at most 8 units in one pass, oldest first', async () => {
        // Ten superseded failures: the bound exists so the first pass over an old
        // conversation cannot silently empty it (T4.3).
        const entries: HarnessContextEntry[] = [entryOf(0, { role: 'user', content: 'go' })];

        for (let round = 0; round < 10; round += 1) {
            const base = entries.length;

            entries.push(
                entryOf(base, {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: `f${round}`, name: 'read', arguments: `{"p":${round}}` }]
                }),
                entryOf(base + 1, {
                    role: 'tool',
                    content: 'boom',
                    toolCallId: `f${round}`,
                    name: 'read',
                    outcome: 'failed'
                }),
                entryOf(base + 2, {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: `k${round}`, name: 'read', arguments: `{ "p" : ${round} }` }]
                }),
                entryOf(base + 3, {
                    role: 'tool',
                    content: 'ok',
                    toolCallId: `k${round}`,
                    name: 'read'
                })
            );
        }

        const { api, diagnostics } = createFakeApi(100, { minTokens: 0, safetyTurns: 0 });
        const calls: string[] = [];

        await executeCompaction(
            api,
            createFakeTurn({ api, estimatedTokens: 5000, calls, entries })
        );

        expect(calls).toEqual([
            'setIncluded:1:false',
            'setIncluded:5:false',
            'setIncluded:9:false',
            'setIncluded:13:false',
            'setIncluded:17:false',
            'setIncluded:21:false',
            'setIncluded:25:false',
            'setIncluded:29:false'
        ]);

        const data = diagnostics[0].data as { maxUnits: number; units: { index: number }[] };

        expect(data.maxUnits).toBe(8);
        expect(data.units.map((unit) => unit.index)).toEqual([1, 5, 9, 13, 17, 21, 25, 29]);
    });

    it('degrades an unimplemented mode to exclude and reports both', async () => {
        const { api, diagnostics } = createFakeApi(100, {
            minTokens: 10,
            safetyTurns: 0,
            mode: 'annotate'
        });
        const calls: string[] = [];

        await executeCompaction(
            api,
            createFakeTurn({ api, estimatedTokens: 500, calls, entries: prunableEntries() })
        );

        // `annotate` is not built, so the reversible writer is used — and the report says so
        // rather than letting an operator believe their setting took effect.
        expect(calls).toEqual(['setIncluded:1:false']);
        expect(diagnostics[0].message).toContain('mode exclude, setting mode annotate');
        expect(diagnostics[0].data).toMatchObject({ mode: 'exclude', requestedMode: 'annotate' });
    });

    it('skips a branch round before reading anything', async () => {
        const { api, touches, diagnostics } = createFakeApi(100, { minTokens: 0, safetyTurns: 0 });
        const calls: string[] = [];

        await executeCompaction(
            api,
            createFakeTurn({
                api,
                estimatedTokens: 500,
                calls,
                entries: prunableEntries(),
                branchId: 'branch-1',
                actorKey: 'branch:branch-1',
                threadId: 'thread-1'
            })
        );

        // No settings read at all: an ephemeral copy is never pruned, whatever the knobs say.
        expect(calls).toEqual([]);
        expect(touches).toEqual([]);
        expect(diagnostics).toEqual([]);
    });

    it('setup registers one turn.before handler whose default action IS the policy', async () => {
        const { api, touches } = createFakeApi(100, { minTokens: 10, safetyTurns: 0 });
        const registered: Array<{
            event: string;
            handler: HarnessLifecycleHandler<'turn.before'>;
        }> = [];

        // Capture what `setup` subscribes instead of reaching into the harness.
        api.on = (event, handler) => {
            registered.push({
                event,
                handler: handler as unknown as HarnessLifecycleHandler<'turn.before'>
            });
            return () => undefined;
        };

        setup(api);
        expect(registered.map((entry) => entry.event)).toEqual(['turn.before']);

        const calls: string[] = [];
        await registered[0].handler(
            createFakeTurn({ api, estimatedTokens: 100, calls, entries: prunableEntries() })
        );

        // park -> prune -> un-park, in that order: `executeCompaction` is the DEFAULT action,
        // so the shipped built-in changes the transcript inside the pause window.
        expect(calls).toEqual(['pause', 'setIncluded:1:false', 'resume']);
        expect(touches).toEqual([
            'settings.boolean:enabled',
            'settings.number:contextLimit',
            ...POLICY_READS,
            'report.diagnostic'
        ]);
    });

    // The estimate is ceil(content chars / 4) (core/context-estimate.ts), and the agent
    // has no instruction blocks, so these prompts are exact by construction:
    //   400 chars -> 100, 412 -> 103, 476 -> 119 against a limit of 100 (margin 5).
    const SHORT = 'go';
    const CROSSING = 'x'.repeat(400);
    const INSIDE_MARGIN = 'y'.repeat(10);
    const PAST_MARGIN = 'z'.repeat(60);

    it('leaves an under-limit conversation completely alone', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')], seen)) },
            pluginSettings: limitAt(100),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Under limit' });
        const message = await writer.sendThreadInput(thread.id, SHORT);

        expect(message.content).toBe('ok');
        expect(estimates).toEqual([1]);
        expect(events).toEqual([]);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // No park, and no rewrite of the request or of committed history.
        expect(seen).toHaveLength(1);
        expect(seen[0].messages).toEqual([{ role: 'user', content: SHORT }]);
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SHORT },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('parks and un-parks once per crossing, and a pass with nothing superseded rewrites nothing', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok'), answer('fine'), answer('done')], seen)) },
            pluginSettings: limitAt(100),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Over limit' });

        // Turn 1: 400 chars = 100 tokens -> the limit is reached -> park + un-park.
        expect((await writer.sendThreadInput(thread.id, CROSSING)).content).toBe('ok');
        expect(estimates).toEqual([100]);
        expect(events).toEqual(['paused', 'resumed']);
        // The run was never stranded by the park.
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // Turn 2: 412 chars = 103 tokens — still over the limit, inside the 5% margin, so the
        // conversation is not parked again for the same size.
        expect((await writer.sendThreadInput(thread.id, INSIDE_MARGIN)).content).toBe('fine');
        expect(estimates).toEqual([100, 103]);
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // Turn 3: 476 chars = 119 tokens, 19 past the last mark -> re-armed.
        expect((await writer.sendThreadInput(thread.id, PAST_MARGIN)).content).toBe('done');
        expect(estimates).toEqual([100, 103, 119]);
        expect(events).toEqual(['paused', 'resumed', 'paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // NOTHING TO PRUNE, proven from the harness side: this transcript has no tool unit at
        // all, so the policy wrote no flag — every request carried the full transcript (1,
        // then 3, then 5 messages), and committed history holds every turn in order with no
        // `included` key anywhere. Pruning is a flag, never a rewrite (R3), and a conversation
        // with no superseded failure is left byte-for-byte alone.
        expect(seen.map((request) => request.messages.length)).toEqual([1, 3, 5]);
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: CROSSING },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: INSIDE_MARGIN },
            { role: 'assistant', content: 'fine' },
            { role: 'user', content: PAST_MARGIN },
            { role: 'assistant', content: 'done' }
        ]);
    });

    it('does nothing at any size when the limit is 0', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            pluginSettings: limitAt(0),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Compaction off' });
        await writer.sendThreadInput(thread.id, CROSSING);

        // The estimate really did pass the (disabled) limit; the plugin just refused it.
        expect(estimates).toEqual([100]);
        expect(events).toEqual([]);
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });

    it('never parks the summarizer conversation', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        const writer = harness({
            agents: { summarizer: brain(scripted([answer('condensed')])) },
            pluginSettings: limitAt(100),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('summarizer', { label: 'Condenser' });
        const message = await writer.sendThreadInput(thread.id, CROSSING);

        expect(message.content).toBe('condensed');
        // Over the limit by the same margin the writer test used, yet skipped by name.
        expect(estimates).toEqual([100]);
        expect(events).toEqual([]);
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });

    it('un-parks a real thread when the action throws, and the run still answers', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        // A HOST plugin replaces the built-in (plugin/host.ts precedence) and reuses the
        // shipped guard with an action that fails. The settings namespace is the NAME, so
        // the replacement is configured exactly like the built-in it displaced — and it has
        // to be configured through `pluginSettings`, because the default in-memory provider
        // is seeded from the BUILT-IN's declared default (100000), which outranks the
        // replacement's own declared default (plugin/settings.ts `resolve`).
        const failing: HarnessPlugin = {
            name: 'context-compaction',
            metadata: { name: 'context-compaction', title: 'Failing Compactor' },
            setup: (api) => {
                api.on(
                    'turn.before',
                    createContextCompactionHandler(api, async (): Promise<void> => {
                        throw new Error('compaction failed');
                    })
                );
            }
        };

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            pluginSettings: limitAt(100),
            plugins: [failing, probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Failed compaction' });
        const message = await writer.sendThreadInput(thread.id, CROSSING);

        // Fail-open: the throwing handler was skipped by the bus, the run answered anyway,
        // and `finally` returned the thread to its run.
        expect(message.content).toBe('ok');
        expect(estimates).toEqual([100]);
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: CROSSING },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    // -----------------------------------------------------------------------
    // T3/T4 through a real conversation: the flag is canonical state, the provider stops
    // seeing the pruned unit, and a multi-unit pass costs ONE persistence notification.
    //
    // The numbers are derived, not observed: `brain()` has no instruction, so the estimate
    // is ceil(content chars / 4) over the transcript (core/context-estimate.ts). A failed
    // result of `N` characters contributes (21 + N + 4) chars — 21 for `Tool "read" failed: `
    // and 4 for the tool name on the result — and its assistant entry 19 more (4 name + the
    // 15-character raw arguments). The floor and horizon settings are named explicitly so
    // each test measures one thing; the DECLARED defaults are pinned by their own case.
    // -----------------------------------------------------------------------

    // Three failed reads, each answered later by the same call with its arguments
    // reordered. `failChars` moves the saving without moving anything else.
    const supersededTranscript = (
        failChars: number,
        paths: readonly string[] = ['a.ts', 'b.ts', 'c.ts']
    ): HarnessMessage[] => {
        const messages: HarnessMessage[] = [{ role: 'user', content: 'open them' }];

        paths.forEach((path, round) => {
            messages.push(
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: `f${round}`, name: 'read', arguments: `{"path":"${path}"}` }]
                },
                {
                    role: 'tool',
                    content: `Tool "read" failed: ${'E'.repeat(failChars)}`,
                    toolCallId: `f${round}`,
                    name: 'read',
                    outcome: 'failed'
                },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: `k${round}`, name: 'read', arguments: `{ "path" : "${path}" }` }]
                },
                {
                    role: 'tool',
                    content: `${path} contents`,
                    toolCallId: `k${round}`,
                    name: 'read'
                }
            );
        });

        messages.push({ role: 'assistant', content: 'settled' });

        return messages;
    };

    // A host plugin that NAMES the built-in replaces it (src/plugin/host.ts precedence),
    // which is how these tests compare "with compaction" against "without" in one harness
    // configuration instead of reasoning about the difference.
    const withoutCompaction: HarnessPlugin = { name: 'context-compaction', setup: () => undefined };

    const compactRun = async (input: {
        transcript: HarnessMessage[];
        settings: Record<string, number | string | boolean>;
        stateChanges: HarnessStateChangeEvent[];
        diagnostics: HarnessDiagnosticEvent[];
        seen: HarnessStreamRequest[];
        turns?: HarnessStreamEvent[][];
        plugins?: HarnessPlugin[];
        prompt?: string;
    }): Promise<{ writer: Harness; threadId: string }> => {
        const writer = harness({
            agents: {
                writer: brain(input.turns === undefined ? scripted([answer('after')], input.seen) : scripted(input.turns, input.seen))
            },
            pluginSettings: settingsOf(input.settings),
            plugins: input.plugins ?? [],
            report: {
                stateChange: (event) => void input.stateChanges.push(event),
                diagnostic: (event) => void input.diagnostics.push(event)
            }
        });

        const thread = writer.createThread('writer', { label: 'Compaction fixture' });
        writer.setThreadMessages(thread.id, input.transcript);
        await writer.sendThreadInput(thread.id, input.prompt ?? 'next');

        return { writer, threadId: thread.id };
    };

    it('withholds three superseded failures in one pass, and reports the pass ONCE', async () => {
        const stateChanges: HarnessStateChangeEvent[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const { writer, threadId } = await compactRun({
            transcript: supersededTranscript(600),
            settings: { contextLimit: 100, minTokens: 10, safetyTurns: 0 },
            stateChanges,
            diagnostics,
            seen
        });

        // 3 failures withheld, one report. 621 = ceil(2484/4): each pruned unit is 600 + 21
        // + 4 of result plus 19 of call text = 644 chars, three of them 1932, and the
        // before/after rounding over the whole transcript lands on 621.
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].type).toBe('plugin_diagnostic');
        expect(diagnostics[0].kind).toBe('policy');
        expect(diagnostics[0].owner).toBe('context-compaction');
        expect(diagnostics[0].message).toContain('withheld 3 superseded tool unit(s)');
        expect(diagnostics[0].message).toContain('msg-2');
        expect(diagnostics[0].message).toContain('answered by msg-4');

        // THE COALESCING ASSERTION (context T4 / compaction T4.4). THREE flag writes in one
        // round produce ONE transcript-change notification. The comparison run disables the
        // built-in, so the difference between the two counts IS the pass — and it is 1, not
        // 3, which is the whole point (40 units would also be 1).
        const withPass = stateChanges.filter((event) => event.reason === 'agent_message');
        const disabledChanges: HarnessStateChangeEvent[] = [];

        const disabled = await compactRun({
            transcript: supersededTranscript(600),
            settings: { contextLimit: 100, minTokens: 10, safetyTurns: 0 },
            stateChanges: disabledChanges,
            diagnostics: [],
            seen: [],
            plugins: [withoutCompaction]
        });

        // 4 = the host `setThreadMessages` seed write (a HOST write stays per-write — see the
        // context entry's T4.1), the run's user append, the coalesced pass, the committed
        // answer. 3 = the same run with no pass to report.
        expect(withPass).toHaveLength(4);

        const withoutPass = disabledChanges.filter(
            (event) => event.reason === 'agent_message'
        );

        expect(withoutPass).toHaveLength(3);
        // The delta is the pass: one report for three writes.
        expect(withPass.length - withoutPass.length).toBe(1);

        expect(
            disabled.writer.threadMessages(disabled.threadId).some((message) => message.included === false)
        ).toBe(false);

        // Canonical history: every member of the three pruned units is flagged, and NOTHING
        // else is — the answering units, the tail and the opening user turn all stay.
        const flagged = writer
            .threadMessages(threadId)
            .map((message, index) => ({ index, role: message.role, included: message.included }))
            .filter((entry) => entry.included === false);

        expect(flagged).toEqual([
            { index: 1, role: 'assistant', included: false },
            { index: 2, role: 'tool', included: false },
            { index: 5, role: 'assistant', included: false },
            { index: 6, role: 'tool', included: false },
            { index: 9, role: 'assistant', included: false },
            { index: 10, role: 'tool', included: false }
        ]);

        // The provider request that went out carries the ANSWERS and the tail, and never a
        // half-answered block: the cascade kept pairing intact (T3.4's oracle, in the shape
        // this file can see — the request itself).
        const request = seen[seen.length - 1].messages;

        // No pruned block reaches the provider: the `f0` call (and its siblings) are gone,
        // and with them the results that answered them.
        expect(
            request.some((message) => {
                if (message.role !== 'assistant') return false;

                const calls = (message as { toolCalls?: { id: string }[] }).toolCalls;

                return (calls ?? []).some((call) => call.id.startsWith('f'));
            })
        ).toBe(false);
        expect(
            request.filter((message) => message.role === 'tool').map((message) => (message as { toolCallId: string }).toolCallId)
        ).toEqual(['k0', 'k1', 'k2']);

        // T3.4's oracle, spelled out on the request this file can see: every call the model
        // is offered has exactly one answer in this request, in call order, and every answer
        // belongs to a call that is present. This is the same invariant `wireIssues` asserts
        // in src/harness.background.test.ts — pruning is allowed to remove units, never to
        // leave a half-answered `tool_calls[]` or an orphan result behind.
        const offeredCallIds: string[] = [];
        const answeredCallIds: string[] = [];

        for (const message of request) {
            if (message.role === 'assistant') {
                for (const call of (message as { toolCalls?: { id: string }[] }).toolCalls ?? []) {
                    offeredCallIds.push(call.id);
                }
                continue;
            }

            if (message.role === 'tool') {
                answeredCallIds.push((message as { toolCallId: string }).toolCallId);
            }
        }

        expect({ offered: offeredCallIds, answered: answeredCallIds }).toEqual({
            offered: ['k0', 'k1', 'k2'],
            answered: ['k0', 'k1', 'k2']
        });

        // Durable, like every other canonical write: the flag is in the snapshot a server
        // would persist.
        const snapshot = JSON.parse(JSON.stringify(writer.snapshot())) as HarnessSnapshot;

        expect(
            snapshot.threads?.[0].messages
                .map((message, index) => ({ index, role: message.role, included: message.included }))
                .filter((entry) => entry.included === false)
        ).toEqual(flagged);
    });

    it('leaves the same pair alone when the saving is under the declared default minTokens', async () => {
        const stateChanges: HarnessStateChangeEvent[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        // No `minTokens`/`safetyTurns` stored at all, so the DECLARED defaults (200 / 6) are
        // what this run resolves — the same numbers the operator sees in the UI.
        const { writer, threadId } = await compactRun({
            // A 20-character failure: ~10 tokens withheld, far under the 200 floor. The
            // padded user turn is what carries the transcript over the 100-token limit, and
            // it is a standalone unit, so pruning can never rescue the saving either.
            transcript: [
                { role: 'user', content: 'p'.repeat(500) },
                ...supersededTranscript(20).slice(1)
            ],
            settings: { contextLimit: 100 },
            stateChanges,
            diagnostics,
            seen
        });

        expect(writer.threadMessages(threadId).some((message) => message.included === false)).toBe(false);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('withheld nothing');
        expect(diagnostics[0].message).toContain('under the 200 minTokens floor');

        // Nothing written means nothing to persist: the host seed write, the run's user
        // append and the committed answer are the whole count — byte-for-byte the notification
        // profile of a conversation with no compaction at all.
        expect(stateChanges.filter((event) => event.reason === 'agent_message')).toHaveLength(3);

        // And the transcript the model is about to see still holds the failure.
        expect(
            seen[seen.length - 1].messages.some((message) =>
                String((message as { content?: string }).content ?? '').startsWith('Tool "read" failed:')
            )
        ).toBe(true);
        // And the canonical history is exactly what it was before the turn, plus this run's
        // two entries — no `included` key anywhere, because a refused pass never writes.
        expect(
            writer.threadMessages(threadId).filter((message) => message.included === undefined)
        ).toHaveLength(writer.threadMessages(threadId).length);
    });

    it('is a no-op on the next pass: nothing disabled, nothing notified, nothing reported', async () => {
        const stateChanges: HarnessStateChangeEvent[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const { writer, threadId } = await compactRun({
            transcript: supersededTranscript(600),
            settings: { contextLimit: 100, minTokens: 10, safetyTurns: 0 },
            stateChanges,
            diagnostics,
            seen,
            // Two runs, so the second crossing needs its own answer frame.
            turns: [answer('after'), answer('after again')],
            prompt: 'x'.repeat(20)
        });

        const afterFirstPass = stateChanges.filter((event) => event.reason === 'agent_message');

        // Seed write + user append + the coalesced pass + the committed answer.
        expect(afterFirstPass).toHaveLength(4);
        expect(diagnostics).toHaveLength(1);

        // Grow the conversation past the 5%-of-limit margin so the TRIGGER fires again, and
        // prove the pass is the part that does nothing: no new flag, no new report, and no
        // extra notification — which is the chain T4.3 asks for (no churn -> no notify ->
        // no save). 6 tokens = 24 chars on top of the ~506-token transcript, over a limit
        // whose margin is floor(100 * 0.05) = 5.
        await writer.sendThreadInput(threadId, 'y'.repeat(24));

        const afterSecondPass = stateChanges.filter((event) => event.reason === 'agent_message');

        // The second run adds exactly its own two writes (the appended prompt and the
        // committed answer). The pass contributed NOTHING: no flag, no notification, no save.
        expect(afterSecondPass).toHaveLength(6);
        expect(diagnostics).toHaveLength(1);

        expect(
            writer
                .threadMessages(threadId)
                .filter((message) => message.included === false)
        ).toHaveLength(6);
    });
});

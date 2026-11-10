// The shipped `context-compaction` preset plugin (src/plugins/context-compaction.plugin.ts).
//
// WHAT THIS FILE PINS
// -------------------
// The TRIGGER, the PAUSE lifecycle, and BOTH writers: the `exclude` pass (a pure policy in
// ../core/context-pruning.ts — whose own rule table is pinned in
// src/core/context-pruning.test.ts; this file pins the PLUGIN half: settings, guards,
// writes, reports, and behaviour through a real harness) and the `summarize` flow (T9),
// where the conversation compacts itself. Which half a case measures is named by the
// `mode` it stores — the fake api seeds `exclude` because most of the guard cases below
// pin the pruning lifecycle, and every summarize case names its mode explicitly.
//
//   1. BELOW the trigger: nothing happens at all (no park, no action, no transcript
//      change); and the TRIGGER itself — the effective limit, `min(resolved limit, model
//      window)` with NO headroom subtracted (the operator's 2026-11-10 one-number ruling:
//      the limit IS the firing point) — including the `modelLimits` JSON map (per-model
//      limit, per-model window, and every malformed input ignored in favour of the global
//      limit);
//   2. AT/ABOVE the trigger: park -> action (exactly once, with the SAME api and the SAME
//      turn context object) -> un-park, and the un-park also happens when the action
//      throws, because a failed compaction must not strand a conversation in 'paused';
//   3. the per-thread COOLDOWN: an unchanged over-trigger estimate does not fire again,
//      growth past the 5%-of-effective-limit margin does, and dropping below the trigger
//      makes the next crossing fresh again;
//   4. the internal `summarizer` conversation is never compacted (recursion guard), and a
//      BRANCH round never triggers a pass at all (ratified 2026-11-09: its flag writes are
//      ephemeral and its cooldown key could never be cleared);
//   5. the `exclude` ACTION: it prunes exactly the superseded failure and nothing else,
//      re-reads `enabled`/`minTokens`/`safetyTurns`/`mode` every pass, degrades an
//      unimplemented `mode` to `exclude` while REPORTING both, never rewrites history, and
//      says what it did on `api.report.diagnostic` (T4.5). Through a real harness the flag
//      is canonical state, ONE `agent_message` reports a multi-unit pass (T4.4), and a
//      second pass changes and notifies nothing;
//   6. the `summarize` FLOW end to end: the trigger parks the thread and commits its
//      instruction into the canonical transcript AND into that request, the agent's own
//      answer is the compaction, everything before the instruction (and the intermediate
//      turns) stops being sent, the thread is un-parked, and a continuation nudge restarts
//      the conversation on the compacted head — plus both finalize paths, the disobedient
//      model, the failed-run rollback, the flag that survives the commit, the phase guard,
//      and the restart persistence of everything the pass wrote.
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
//   - ../core/context-pruning.ts              — THE `exclude` POLICY, pure and table-tested elsewhere
//   - ../core/context-estimate.ts             — the estimate the integration numbers use
//   - ../harness.ts (`emitTurnBefore`)        — the real pause/resume + token estimate, the
//                                               `setIncluded` write, and the per-round
//                                               notification coalescing (T4.4); also
//                                               `turn.after`, `thread.idle`, `run.failed` and
//                                               the failure rollback the summarize cases pin
//   - ./hooks.ts                              — fail-open dispatch of a throwing handler
//   - ../plugins/context-trimmer.plugin.ts    — the SECOND shipped `turn.before` context pass; the
//                                               final block here pins the overlap task T9 ratified
//                                               (exactly one pass withholds a superseded unit)
//   - ../core/agent.ts                        — `registerAgentThreader` and the thread model
//                                               sync that make `api.agents[name].model()`
//                                               the model the run is about to send
//   - ../transport/models.ts                  — checked as a window source and REJECTED: it
//                                               returns `string[]` (ids only), so the
//                                               provider's per-model context length never
//                                               reaches the harness, and the `modelLimits`
//                                               map's `window` is the only one in this build
//   - ../harness.plugin.test.ts               — the transport helpers mirrored below

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
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
    COMPACTION_INSTRUCTION,
    COMPACTION_MODES,
    CONTINUATION_NUDGE,
    createContextCompactionHandler,
    createContextCompactionPasses,
    executeCompaction,
    isInternalAgent,
    metadata,
    parseModelLimits,
    planCompactionRetention,
    resolveContextTrigger,
    setup
} from '../plugins/context-compaction.plugin';
// Uplift T9 — the OTHER shipped `turn.before` context pass. Imported only by the overlap block at
// the end of this file, which is the one place a case measures BOTH passes at once.
import {
    TRIMMER_DEFAULT_SETTINGS,
    executeTrimming,
    planTrimmedUnits,
    type TrimmerSettings
} from '../plugins/context-trimmer.plugin';
// The compactor's own policy (the pure mirror of its prune), so "the two rules name the same
// unit" is an assertion about both policies rather than about two plugins.
import { planContextPruning } from '../core/context-pruning';

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
    // The live agent registry the trigger reads the model id from. Mutable by identity:
    // `api.agents` is this same object, so a test can register a brain between turns.
    agents: Record<string, Agent>;
    // Simulates an operator changing the stored limit between turns.
    setLimit: (value: number) => void;
    // ...or any other setting the action reads.
    setSetting: (key: string, value: number | string | boolean) => void;
};

// A registered brain that does one thing: answer `model()`. The guard reads that accessor
// and nothing else, so the fake carries only it — `as unknown as Agent` rather than a stub
// of all twelve members, which would let a test keep passing while the plugin reached for a
// member the real registry happens not to populate.
const fakeBrain = (model: unknown): Agent => ({ model }) as unknown as Agent;

// A complete `HarnessPluginApi`. Any control other than a settings read and the diagnostic
// channel is a FAILURE: `skip` records it and throws, so an action that tried to spawn a
// thread, disable a tool or wake async work fails the test loudly instead of passing
// silently. The settings are backed by a MAP rather than one number for every key: the
// action now reads four of them, and a test that wants `minTokens: 20` has to be able to
// say so without also changing the limit.
//
// NO headroom is seeded, because there is none any more: the limit IS the firing point
// (the operator's 2026-11-10 one-number ruling), so every trigger number in this file is
// the stored `contextLimit` itself unless a `modelLimits` entry says otherwise.
const createFakeApi = (
    limit: number,
    stored: Record<string, number | string | boolean | undefined> = {},
    agents: Record<string, Agent> = {}
): FakeApi => {
    const touches: string[] = [];
    const diagnostics: HarnessPluginDiagnosticReport[] = [];

    // `mode: 'exclude'` is seeded because nearly every case in the guard/action blocks below
    // pins the PRUNING lifecycle — the park/action/resume triple, the flag writes, the pass
    // report — and that pass only runs in `exclude` mode now that `summarize` is the declared
    // default. A case that wants the summarize flow stores the mode explicitly, so the two
    // flows never measure each other.
    const values: Record<string, unknown> = { mode: 'exclude', contextLimit: limit, ...stored };

    const skip = (name: string): never => {
        touches.push(name);
        throw new Error(`The compaction action touched ${name}.`);
    };

    const api: HarnessPluginApi = {
        agents,
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
            setStatus: () => skip('threads.setStatus'),
            // T8 — the park/unpark pair is part of this api too, and the compactor's `unpark`
            // reaches for `resume` on every run-terminal edge. Recorded like every other
            // control: `unpark` swallows the throw (an unknown thread is not an error), so the
            // touch is the observable half of the call.
            pause: () => skip('threads.pause'),
            resume: () => skip('threads.resume')
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
        agents,
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
        // Trimmer uplift T6 — the second canonical control `HarnessTurnBeforeContext` now
        // requires. The compaction plugin never calls it, and this fake only exists so the
        // context literal stays the shape the type promises; it records the call and flips the
        // flag on the same entry object, exactly like `setIncluded` above does.
        setReasoningIncluded: (target, included) => {
            const index =
                typeof target === 'number'
                    ? target
                    : typeof target === 'string'
                        ? entries.findIndex((entry) => entry.messageId === target)
                        : target.index;

            input.calls.push(`setReasoningIncluded:${index}:${String(included)}`);

            const entry = entries[index] as { reasoningIncluded?: boolean } | undefined;

            if (entry !== undefined) entry.reasoningIncluded = included === true ? undefined : false;
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

// The exact settings reads one NON-SKIPPED turn performs, in order. Pinned because a silent
// extra read on the hot path is a silent per-turn cost, and because the ORDER proves the
// internal-agent and branch guards run BEFORE the trigger is resolved: those rounds stop
// after `contextLimit` and never pay for the map parse (the branch test below pins the
// two-read sequence).
//
// `mode` is part of the sequence because the trigger has to know WHICH machine to hand the
// turn to (summarize or exclude) before it can decide, and it is read after `modelLimits`
// so a skipped round still stops at two reads. `minTokens` is deliberately NOT here: in
// summarize mode it is a floor consulted only on a turn that is already over the limit, so
// an under-limit turn never pays for it (pinned by the floor case below).
const TRIGGER_READS = [
    'settings.boolean:enabled',
    'settings.number:contextLimit',
    'settings.string:modelLimits',
    'settings.string:mode'
];

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
//
// NO headroom is seeded, because there is none any more (the operator's 2026-11-10
// one-number ruling): the limit IS the firing point, so a fixture that stores
// `contextLimit: 100` compacts at an estimate of 100 — the scale every integration number
// below is derived from.
//
// `context-trimmer` (R5, the other shipped `turn.before` context pass) is seeded OFF here,
// exactly as src/server/persistence.test.ts does for its compaction fixture. Its rule is a
// superset of compaction's (tool NAME match, no token floor, no cooldown), so left at its
// declared default it runs its own pass on these transcripts — in the `withoutCompaction`
// control arm, and even in an arm where compaction's `minTokens` floor refuses the pass.
// Turning it off keeps every case below a measurement of ONE plugin, which is what this
// file's header claims; no expectation changes as a result.
const settingsOf = (values: Record<string, number | string | boolean>): HarnessPluginSettingsProvider => {
    const stored: Record<string, number | string | boolean> = { ...values };

    return {
        get: (plugin, key) => {
            if (plugin === 'context-trimmer' && key === 'enabled') return false;

            return plugin === 'context-compaction' ? stored[key] : undefined;
        }
    };
};

// The one-key spelling: just the limit.
const limitAt = (value: number): HarnessPluginSettingsProvider => settingsOf({ contextLimit: value });

// The same, pinned to the OLD writer. Everything in this file that measures the prune
// lifecycle (park -> `executeCompaction` -> un-park, the flag writes, the pass report) has to
// say `mode: 'exclude'` now that `summarize` is the declared default; without it those cases
// would silently drive the summarize machine and pin nothing. `limitAt` stays for the cases
// that never reach a mode decision (under the limit, limit 0, internal agent, branch).
const excludeAt = (value: number): HarnessPluginSettingsProvider =>
    settingsOf({ contextLimit: value, mode: 'exclude' });

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
        // The trigger points this plugin needs, and nothing else, so the live hook surface
        // and the declared intent stay identical. The summarize machine spans one run, so it
        // declares all five edges — and `setup` below subscribes exactly this list, which is
        // what keeps the operator-facing declaration honest.
        expect(metadata.hooks).toEqual(['turn.before', 'turn.after', 'thread.idle', 'run.finished', 'run.failed']);

        // T4.6: `enabled`, the limit, the savings floor, the horizon, and the mode, plus
        // R4's per-model map beside the limit it modifies. The numbers below ARE the
        // ratified answers (T0 Q2's floor, Q3's horizon, and the operator's 2026-11-10
        // one-number ruling on the limit), and each default is duplicated as a fallback
        // constant beside the plugin's own reads — a drift between the two changes one of
        // the assertions in this file.
        expect(
            metadata.settings?.map((setting) => [
                setting.key,
                setting.type,
                setting.default,
                setting.min,
                setting.step
            ])
        ).toEqual([
            ['contextLimit', 'number', 200000, 1000, 1000],
            ['modelLimits', 'string', '{}', undefined, undefined],
            ['enabled', 'boolean', true, undefined, undefined],
            ['minTokens', 'number', 200, 0, 50],
            ['safetyTurns', 'number', 6, 0, 1],
            ['mode', 'string', 'summarize', undefined, undefined]
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

        // T9: the floor's text now has to explain that the SAME number means a different
        // thing in the new mode, or an operator with a small per-model limit sets a floor
        // that quietly refuses every summarize pass.
        expect(descriptionOf('minTokens')).toContain('summarize');
        expect(descriptionOf('mode')).toContain('summarize');

        // The texts that tell an operator WHERE the firing point actually is. The limit's
        // own description has to state that it IS the firing point with no headroom beside
        // it (the opposite disclaimer the removed gap scheme needed), and the map has to
        // state that a bad value is IGNORED (an operator who fears breaking compaction never
        // types the per-model fact they need).
        expect(descriptionOf('contextLimit')).toContain('The firing point');
        expect(descriptionOf('contextLimit')).toContain('no separate headroom');
        expect(descriptionOf('modelLimits')).toContain('"window"');
        expect(descriptionOf('modelLimits')).toContain('ignored');
        expect(String(metadata.description)).toContain('The limit is the firing point');

        // `mode` enumerates ONLY what this build implements, so the UI cannot offer a value
        // that does nothing. T9 added the second writer, and the order is the UI's: the
        // DEFAULT first, which is the same value `MODE_DEFAULT` falls back to (a drift
        // between the descriptor above and this list means the UI offers a mode the plugin
        // does not actually run when nothing is stored).
        expect(COMPACTION_MODES).toEqual(['summarize', 'exclude']);
        expect(COMPACTION_MODES).toContain(
            String((metadata.settings ?? []).find((setting) => setting.key === 'mode')?.default)
        );
    });
});

// ---------------------------------------------------------------------------
// R4 — THE TRIGGER MATH, as a table.
//
// Every expected number is computed by HAND from the ratified rule
//
//     resolved  = modelLimits[<model>].limit ?? contextLimit
//     effective = window is declared ? min(resolved, window) : resolved
//     trigger   = max(1, floor(effective))
//
// rather than read back out of a run, so a change in the rule fails loudly here. There is
// no headroom term any more (the operator's 2026-11-10 one-number ruling): the limit IS
// the firing point, so a 200000 ceiling fires at exactly 200000 and a 512000 ceiling on a
// 262144-token model fires at the window, 262144.
// ---------------------------------------------------------------------------

describe('context-compaction trigger math (parseModelLimits + resolveContextTrigger)', () => {
    // Shorthand for the common call: no per-model facts, no model in play.
    const globalOnly = (contextLimit: number) => resolveContextTrigger({ contextLimit, modelLimits: {} });

    it('fires exactly at the global ceiling — the limit IS the firing point', () => {
        // 200000 fires at 200000. The map names a DIFFERENT model: a window declared for one
        // model must not cap another model's conversation, which is why `window` is absent
        // from the answer.
        expect(
            resolveContextTrigger({
                contextLimit: 200000,
                modelLimits: parseModelLimits('{"other/model": {"window": 131072}}'),
                modelId: 'openai/gpt-4o'
            })
        ).toEqual({ limit: 200000, effective: 200000 });

        // And the same identity at the smaller scales the lifecycle tests use.
        expect(globalOnly(100000)).toEqual({ limit: 100000, effective: 100000 });
        expect(globalOnly(1000)).toEqual({ limit: 1000, effective: 1000 });
    });

    it('takes the per-model limit in place of the global ceiling', () => {
        const modelLimits = parseModelLimits('{"fast/small": {"limit": 50}}');

        // The model named in the map gets its own ceiling...
        expect(
            resolveContextTrigger({ contextLimit: 100000, modelLimits, modelId: 'fast/small' })
        ).toEqual({ limit: 50, effective: 50 });

        // ...and every other model keeps the global one, unchanged.
        expect(
            resolveContextTrigger({ contextLimit: 100000, modelLimits, modelId: 'big/model' })
        ).toEqual({ limit: 100000, effective: 100000 });
    });

    it('caps the ceiling at the model window — the operator\'s 512k-on-a-256k-model case', () => {
        const modelLimits = parseModelLimits('{"wide/model": {"window": 262144}}');
        const resolved = resolveContextTrigger({
            contextLimit: 512000,
            modelLimits,
            modelId: 'wide/model'
        });

        // min(512000, 262144) = 262144, with no headroom subtracted: the window IS the
        // firing point. (`window` is reported so a caller can see WHY the number moved.)
        expect(resolved).toEqual({ limit: 512000, window: 262144, effective: 262144 });

        // The same answer when the operator spells the ceiling on the entry as well: the
        // window caps it either way.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"wide/model": {"limit": 512000, "window": 262144}}'),
                modelId: 'wide/model'
            })
        ).toEqual({ limit: 512000, window: 262144, effective: 262144 });
    });

    it('never lets a window RAISE the ceiling', () => {
        // A generous window on a conservative operator is still the operator's number — the
        // window is a cap, not an override.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"huge/model": {"window": 1000000}}'),
                modelId: 'huge/model'
            })
        ).toEqual({ limit: 100000, window: 1000000, effective: 100000 });
    });

    it('degrades to the global ceiling when the model is unknown or unresolved', () => {
        const modelLimits = parseModelLimits('{"known/model": {"limit": 1000}}');

        // An id nobody declared simply misses the map.
        expect(
            resolveContextTrigger({ contextLimit: 100, modelLimits, modelId: 'other/model' })
        ).toEqual({ limit: 100, effective: 100 });

        // And a turn whose model could not be read passes `undefined` — the guard's
        // "model unknown" answer, which must mean the global limit, never 0 and never a
        // crash.
        expect(
            resolveContextTrigger({ contextLimit: 100, modelLimits, modelId: undefined })
        ).toEqual({ limit: 100, effective: 100 });
    });

    it('fires as early as it possibly can on a degenerate ceiling, and floors a fractional one', () => {
        // The ONLY clamp in the rule: a ceiling that floors below one token fires at 1
        // rather than never. Rule 1 refuses a limit of 0, so 0.5 is the smallest a host can
        // store and still arm the plugin.
        expect(globalOnly(0.5)).toEqual({ limit: 0.5, effective: 1 });
        expect(globalOnly(1)).toEqual({ limit: 1, effective: 1 });

        // A fractional ceiling floors, so the trigger stays a whole token count.
        expect(globalOnly(100.9)).toEqual({ limit: 100.9, effective: 100 });
    });

    // The map comes from a free-text settings field, so EVERY bad shape has to land on "no
    // per-model knowledge" rather than on an error or on a partial guess.
    it('ignores malformed modelLimits JSON instead of throwing', () => {
        for (const raw of ['{', '{"a":', 'not json', '', '   ', '[]', 'null', '"text"', '5', '{}']) {
            expect(parseModelLimits(raw)).toEqual({});
        }

        // And the handler-relevant consequence: the global ceiling still fires the pass.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"openai/gpt-4o": {"window": 8192},}'),
                modelId: 'openai/gpt-4o'
            })
        ).toEqual({ limit: 100000, effective: 100000 });
    });

    it('keeps the usable halves of an entry and drops the unusable ones', () => {
        // A JSON document typed by hand, so the input is exactly what the settings field
        // holds (no `JSON.stringify` surprises: it turns `1e400` into `null`).
        const raw =
            '{' +
            '  "both/model":      { "limit": 200000, "window": 128000 },' +
            '  "window-only":     { "window": 8192 },' +
            '  "limit-only":      { "limit": 4096 },' +
            '  "floored/model":   { "limit": 1000.9, "window": 128000.9 },' +
            '  " spaced key ":    { "window": 1024 },' +
            '  "extra-keys":      { "limit": 700, "bogus": true, "note": "comment" },' +
            '  "bad-numbers":     { "limit": "200000", "window": 0 },' +
            '  "zero-limit":      { "limit": 0 },' +
            '  "negative":        { "limit": -5, "window": -1 },' +
            '  "not-an-entry":    "128000",' +
            '  "array-entry":     [128000],' +
            '  "null-entry":      null,' +
            '  "empty-entry":     {},' +
            '  "":                { "window": 512 },' +
            '  "infinite":        { "window": null },' +
            '  "case-sensitive":  { "window": 64 }' +
            '}';

        expect(parseModelLimits(raw)).toEqual({
            'both/model': { limit: 200000, window: 128000 },
            'window-only': { window: 8192 },
            'limit-only': { limit: 4096 },
            // Token counts are whole numbers, so a fractional entry is floored rather than
            // refused — refusing it would throw away a fact the operator typed correctly.
            'floored/model': { limit: 1000, window: 128000 },
            // Provider ids are exact and case-sensitive: the key is TRIMMED (a hand-typed
            // field picks up spaces) and never lower-cased (that would merge two models).
            'spaced key': { window: 1024 },
            'case-sensitive': { window: 64 },
            // Unknown sibling keys are ignored, not merged away: the usable fact stays.
            'extra-keys': { limit: 700 }
            // EVERYTHING ELSE IS ABSENT, and each absence is its own rule: a string number
            // (`"200000"`) is not a number, because the settings view coerces the SETTING and
            // never the values inside a JSON document; 0 and a negative are not ceilings;
            // `null` is not a finite window; a non-object entry, an array and an empty object
            // state nothing; and an empty key cannot be looked up by any model id.
        });
    });

    it('is unfazed by an entry that names neither a limit nor a window', () => {
        // `'{"bad": {"limit": "text"}}'` parses to an entry with no usable half, which the
        // parser drops so the key MISSES the map — a stored `{}` and an absent key have to
        // mean the same thing, or a typo would silently mean "this model has no facts" in
        // one place and "this model's ceiling is the global one" in another.
        expect(parseModelLimits('{"bad": {"limit": "text"}, "empty": {}}')).toEqual({});

        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"bad": {"limit": "text"}}'),
                modelId: 'bad'
            })
        ).toEqual({ limit: 100000, effective: 100000 });
    });

    it('refuses a non-string input rather than coercing it', () => {
        // The settings view already guarantees a string for a `string` setting; this guard
        // is for a host that calls the parser directly with a stored object, which is not a
        // documented spelling and must not half-work.
        expect(parseModelLimits({ 'a/model': { window: 1024 } })).toEqual({});
        expect(parseModelLimits(undefined)).toEqual({});
    });

    it('does not mistake an inherited Object member for a per-model entry', () => {
        // A model id that collides with something on the prototype chain: a bare index read
        // would find `Object.prototype.constructor` and treat it as an entry.
        expect(
            resolveContextTrigger({
                contextLimit: 100,
                modelLimits: parseModelLimits('{"real/model": {"limit": 10}}'),
                modelId: 'constructor'
            })
        ).toEqual({ limit: 100, effective: 100 });
    });
});

describe('context-compaction trigger (createContextCompactionHandler)', () => {
    it('does nothing below the limit and never touches the thread', async () => {
        const { api, touches } = createFakeApi(100);
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);

        // 99 < 100 (the limit IS the trigger): the three trigger reads, and that is the
        // whole turn. The fast path returns `undefined` SYNCHRONOUSLY (no promise), which is
        // the point — see the plugin's "WHY THE FAST PATH IS SYNCHRONOUS".
        expect(handler(createFakeTurn({ api, estimatedTokens: 99, calls }))).toBeUndefined();

        expect(calls).toEqual([]);
        expect(seen).toEqual([]);
        expect(touches).toEqual(TRIGGER_READS);
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
        expect(touches).toEqual(TRIGGER_READS);
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
        expect(touches).toEqual(TRIGGER_READS);
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
            ['writer', 'instruct', 'research', 'workspace', 'reviewer', 'planner', 'general', 'debugger', ''].map(
                isInternalAgent
            )
        ).toEqual([false, false, false, false, false, false, false, false, false]);
    });

    // -------------------------------------------------------------------------
    // R4 — the guard resolves the TRIGGER before it compares. These cases pin
    // the same arithmetic as the table above from the other side: what a turn
    // does, at the exact token counts either side of the firing point.
    // -------------------------------------------------------------------------

    it('falls back to the declared default ceiling when the host stores nothing', async () => {
        // `contextLimit: undefined` means "the host has stored nothing", so the read falls
        // back to the DECLARED default (200000) exactly as a fresh session's would — and
        // with no headroom knob the fallback IS the firing point.
        const { api } = createFakeApi(0, { contextLimit: undefined });
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (threadId: string, estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, threadId, estimatedTokens, calls }));
        };

        // One token under the declared default, and nothing happens at all.
        await run('under', 199999);
        expect(calls).toEqual([]);

        // At the default the pass fires: no headroom sits between the estimate and the
        // number the operator (or here, the shipped default) named.
        await run('crossing', 200000);
        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(1);
    });

    it('uses the per-model limit for the model this conversation runs', async () => {
        const agents: Record<string, Agent> = {
            writer: fakeBrain(() => 'fast/small'),
            other: fakeBrain(() => 'big/model')
        };
        const { api } = createFakeApi(
            100000,
            { modelLimits: '{"fast/small": {"limit": 50}}' },
            agents
        );
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (agent: string, threadId: string, estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, agent, threadId, estimatedTokens, calls }));
        };

        // 49 < 50 and 50 = 50: the model's own ceiling, not the global one.
        await run('writer', 'under', 49);
        expect(calls).toEqual([]);

        await run('writer', 'crossing', 50);
        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(1);

        // A conversation on a model the map does not name keeps the global ceiling: the same
        // size that just fired for `fast/small` is nowhere near 100000 here, and only crosses
        // when the GLOBAL number is reached.
        await run('other', 'other-under', 50);
        expect(calls).toEqual(triples(1));

        await run('other', 'other-crossing', 100000);
        expect(calls).toEqual(triples(2));
        expect(seen).toHaveLength(2);
    });

    it('caps the trigger at the model window and scales the regrowth margin off the cap', async () => {
        // The operator's example end to end: a 512000 ceiling on a 262144-token model —
        // min(512000, 262144) = 262144, with no headroom subtracted.
        const { api } = createFakeApi(
            512000,
            { modelLimits: '{"wide/model": {"window": 262144}}' },
            { writer: fakeBrain(() => 'wide/model') }
        );
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, estimatedTokens, calls }));
        };

        await run(262143);
        expect(calls).toEqual([]);

        await run(262144);
        expect(calls).toEqual(TRIPLE);

        // The re-trigger margin is 5% of the EFFECTIVE (capped) limit — floor(262144 * 0.05)
        // = 13107 — not of the 512000 ceiling. Off the ceiling the margin would be 25600, half
        // the window, and a conversation stuck just over the trigger would go unexamined for
        // far longer than the rule intends.
        await run(275250);
        expect(calls).toEqual(triples(1));

        await run(275251);
        expect(calls).toEqual(triples(2));
        expect(seen).toHaveLength(2);

        // Back under the trigger clears the cooldown, so the next crossing is fresh — the
        // Rule 2 memory is keyed off the TRIGGER, not off the raw ceiling.
        await run(262000);
        await run(262144);
        expect(calls).toEqual(triples(3));
    });

    it('degrades to the global ceiling when the per-model facts are unusable', async () => {
        // A per-model limit of 1000 is in force ONLY when the lookup and the map both work;
        // every degraded shape below must therefore still fire at the global 100.
        const modelLimits = '{"known/model": {"limit": 1000}}';
        const stored = { modelLimits };

        // The control: with a resolvable model the override applies and 100 is nowhere near
        // the trigger.
        const control = createFakeApi(100, stored, { writer: fakeBrain(() => 'known/model') });
        const controlCalls: string[] = [];
        const controlHandler = createContextCompactionHandler(
            control.api,
            createRecordingAction(controlCalls).action
        );

        await controlHandler(createFakeTurn({ api: control.api, estimatedTokens: 100, calls: controlCalls }));
        expect(controlCalls).toEqual([]);

        // The degraded shapes, each in its own handler so no cooldown can mask another.
        const degraded: Array<{ name: string; agents?: Record<string, Agent>; limits?: string }> = [
            // No brain registered under this agent name at all.
            { name: 'unregistered agent', agents: {} },
            // A host-built api that carries no agent registry.
            { name: 'no agent registry' },
            // `model` is not the accessor the Agent type declares.
            { name: 'model is not a function', agents: { writer: fakeBrain('merge/ds4-flash') } },
            // An accessor that throws (a stub, or a brain mid-replacement).
            {
                name: 'model() throws',
                agents: {
                    writer: fakeBrain(() => {
                        throw new Error('no model yet');
                    })
                }
            },
            // An accessor that answers the empty string.
            { name: 'model() is blank', agents: { writer: fakeBrain(() => '') } },
            // An id the map does not name.
            { name: 'unknown model id', agents: { writer: fakeBrain(() => 'other/model') } },
            // A syntax error in the field, and an entry whose only half is unusable.
            {
                name: 'malformed JSON',
                agents: { writer: fakeBrain(() => 'known/model') },
                limits: '{ "known/model": {"limit": 1000 },, }'
            },
            {
                name: 'unusable entry',
                agents: { writer: fakeBrain(() => 'known/model') },
                limits: '{"known/model": {"limit": "1000"}}'
            }
        ];

        for (const variant of degraded) {
            const fake = createFakeApi(100, {
                ...stored,
                ...(variant.limits === undefined ? {} : { modelLimits: variant.limits })
            });

            if (variant.name === 'no agent registry') {
                delete (fake.api as Partial<HarnessPluginApi>).agents;
            } else {
                (fake.api as HarnessPluginApi).agents = variant.agents ?? {};
            }

            const calls: string[] = [];
            const handler = createContextCompactionHandler(fake.api, createRecordingAction(calls).action);

            // 100 is at the global ceiling, so "fired" is the assertion that the plugin
            // refused to guess a per-model number it could not read.
            await handler(createFakeTurn({ api: fake.api, estimatedTokens: 100, calls }));

            expect(calls).toEqual(TRIPLE);
        }
    });

    it('re-resolves the trigger every turn, from live settings and the live model', async () => {
        let model = 'fast/small';
        const { api, setSetting } = createFakeApi(100000, { modelLimits: '{}' }, {
            writer: fakeBrain(() => model)
        });
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (threadId: string, estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, threadId, estimatedTokens, calls }));
        };

        // Turn 1: no per-model facts, so a 100000 ceiling and 100 tokens is nowhere near it.
        await run('thread-1', 100);
        expect(calls).toEqual([]);

        // The operator edits the map from the UI. The parsed map is CACHED behind the stored
        // string, so this is the assertion that the cache is keyed on the value and not on
        // the first thing it ever saw.
        setSetting('modelLimits', '{"fast/small": {"limit": 50}}');
        await run('thread-1', 100);
        expect(calls).toEqual(TRIPLE);
        expect(seen).toHaveLength(1);

        // The operator switches the AGENT to another model. The id is read from the live
        // registry per turn, so the new model's facts apply on the next turn with no restart
        // — and this model declares nothing, so the global ceiling is back in force.
        model = 'big/model';
        await run('thread-1', 100);
        expect(calls).toEqual(TRIPLE);

        setSetting('modelLimits', '{"big/model": {"limit": 50}}');
        await run('thread-2', 40);
        await run('thread-2', 50);
        expect(calls).toEqual(triples(2));
        expect(seen).toHaveLength(2);
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

    it('setup wires exactly the declared hooks, and its turn.before default action IS the policy', async () => {
        // `mode: 'exclude'` is what the fake api seeds, and this case wants the PRUNE writer:
        // `executeCompaction` is the default action of the pass factory, so it is only
        // observable as the shipped behaviour when the turn is routed to that machine. The
        // summarize half is measured through a real harness in the `summarize flow` block,
        // where its phase machine actually exists.
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

        // ONE subscription per declared hook, in the declared order — and nothing else. This
        // is the assertion that keeps `metadata.hooks` (what the server shows the operator)
        // identical to what the plugin really touches: a hook wired without being declared, or
        // declared and never wired, fails right here.
        expect(registered.map((entry) => entry.event)).toEqual([...metadata.hooks]);

        const calls: string[] = [];
        await registered[0].handler(
            createFakeTurn({ api, estimatedTokens: 100, calls, entries: prunableEntries() })
        );

        // park -> prune -> un-park, in that order: `executeCompaction` is the DEFAULT action,
        // so the shipped built-in changes the transcript inside the pause window.
        expect(calls).toEqual(['pause', 'setIncluded:1:false', 'resume']);
        expect(touches).toEqual([...TRIGGER_READS, ...POLICY_READS, 'report.diagnostic']);
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
            pluginSettings: excludeAt(100),
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
            pluginSettings: excludeAt(100),
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
    // configuration instead of reasoning about the difference. The control arm has NO other
    // context pass available either: `settingsOf` seeds `context-trimmer` off, so "without"
    // means without any pruning, which is what the coalescing delta below claims to measure.
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
            settings: { contextLimit: 100, minTokens: 10, safetyTurns: 0, mode: 'exclude' },
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
            settings: { contextLimit: 100, minTokens: 10, safetyTurns: 0, mode: 'exclude' },
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
            settings: { contextLimit: 100, mode: 'exclude' },
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
            settings: { contextLimit: 100, minTokens: 10, safetyTurns: 0, mode: 'exclude' },
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

    // -----------------------------------------------------------------------
    // R4 — the new threshold gates a REAL pass, not just the pure helper.
    //
    // The model id these tests key the map on is `merge/ds4-flash`: that is the model the
    // `writer` brain is built with (see `brain` above), and the trigger reads it from the
    // live registry through `api.agents[context.agent].model()` — `context.agent` is the
    // registry key `writer` (src/harness.ts `emitTurnBefore` hands `brain.name`, and the
    // harness overwrites that with the registry key on registration). The estimates are the
    // harness's own ceil(chars / 4) over an agent with no instruction blocks, so every
    // number below is derived from the documented formula, not from a run.
    // -----------------------------------------------------------------------

    it('leaves the conversation alone when the per-model limit lifts the trigger past the estimate', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            // The global ceiling of 100 would fire at this 100-token estimate (every other
            // test in this file does exactly that). This model's own ceiling of 1000 does
            // not, and it is the model the run is actually on.
            pluginSettings: settingsOf({
                contextLimit: 100,
                modelLimits: '{"merge/ds4-flash": {"limit": 1000}}'
            }),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Per-model ceiling' });
        expect((await writer.sendThreadInput(thread.id, CROSSING)).content).toBe('ok');

        expect(estimates).toEqual([100]);
        expect(events).toEqual([]);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // Nothing parked means nothing pruned: the transcript is the two committed messages,
        // with no `included` flag anywhere.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: CROSSING },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('runs a real pass at the window-capped trigger, and only for the model that declares the window', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        const capped = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            pluginSettings: settingsOf({
                contextLimit: 1000,
                // effective = min(1000, 100) = 100 — the declared window caps the ceiling, and
                // with no headroom the cap IS the firing point — so this 100-token turn
                // crosses it.
                modelLimits: '{"merge/ds4-flash": {"window": 100}}',
                // The pass this case watches is the prune (the events are the park of the
                // `exclude` lifecycle), so the mode is named rather than inherited; the
                // control arm below names the same mode so the two differ ONLY by the model
                // id the map keys.
                mode: 'exclude'
            }),
            plugins: [probe(events, estimates)]
        });

        const cappedThread = capped.createThread('writer', { label: 'Window capped' });
        expect((await capped.sendThreadInput(cappedThread.id, CROSSING)).content).toBe('ok');

        expect(estimates).toEqual([100]);
        expect(events).toEqual(['paused', 'resumed']);
        expect(capped.thread(cappedThread.id)?.status).toBe('idle');

        // Identical settings except for the key the map names: a window declared for a model
        // this run is NOT on caps nothing, so the global 1000 ceiling stands and the turn is
        // left alone. One token estimate apart, the whole difference is the lookup.
        const uncappedEvents: string[] = [];
        const uncappedEstimates: number[] = [];

        const uncapped = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            pluginSettings: settingsOf({
                contextLimit: 1000,
                modelLimits: '{"other/model": {"window": 100}}',
                mode: 'exclude'
            }),
            plugins: [probe(uncappedEvents, uncappedEstimates)]
        });

        const uncappedThread = uncapped.createThread('writer', { label: 'Window elsewhere' });
        await uncapped.sendThreadInput(uncappedThread.id, CROSSING);

        expect(uncappedEstimates).toEqual([100]);
        expect(uncappedEvents).toEqual([]);
    });

    it('leaves a small conversation alone under the shipped defaults (limit 200000)', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        // No `pluginSettings` at all: the in-memory provider is seeded from the DECLARED
        // defaults, so this is a fresh install — ceiling 200000, empty map, and no headroom:
        // the firing point IS 200000, which a 100-token conversation is nowhere near.
        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Fresh install' });
        expect((await writer.sendThreadInput(thread.id, CROSSING)).content).toBe('ok');

        expect(estimates).toEqual([100]);
        expect(events).toEqual([]);
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });
});

// ---------------------------------------------------------------------------
// T9 — THE SUMMARIZE FLOW, end to end, through a real harness.
//
// Every number here is derived, never read back: the transcript is seeded with 1200
// characters of one user turn (300 tokens) and the prompt `go` adds one more, so the live
// projection at the first boundary is 301 against an effective limit of 250 — over, and
// `minTokens: 0` so the floor cannot refuse the pass. After a successful compaction the
// retained head (the instruction ~186 tokens, the answer, the nudge) measures ~189, i.e.
// under 250, which is what makes "the context is small again" an assertion rather than a
// hope. The instruction and the nudge are the EXPORTED strings, because a case that pasted
// its own copy would keep passing after the protocol changed.
//
// The continuation run is fire-and-forget from inside `thread.idle` (see the plugin's "WHY
// THE NUDGE IS A SEND"), so it is still queued when the submission resolves; `settle` below
// waits for it. That is the one place a poll is honest: the plugin deliberately does not
// hand back a promise for the continuation, and neither does the host.
// ---------------------------------------------------------------------------

describe('context-compaction summarize flow (T9)', () => {
    const SEED = 'x'.repeat(1200);
    const PROMPT = 'go';
    const LIMIT = 250;

    // Scripted transport with a window INTO the request: `on` runs while the model turn is
    // in flight, which is the only moment a case can observe the roster status mid-pass, the
    // committed transcript BEFORE the answer, or steer the conversation from inside it.
    const flowStream = (
        turns: HarnessStreamEvent[][],
        seen: HarnessStreamRequest[],
        on?: (index: number, request: HarnessStreamRequest) => void
    ): HarnessStream => {
        let index = 0;

        return async function* (request) {
            seen.push(request);
            on?.(index, request);

            const frames = turns[index] ?? turns[turns.length - 1];
            index += 1;

            for (const frame of frames) yield frame;
        };
    };

    // The summarize settings: the mode spelled out (it IS the default, and a case that names
    // what it measures stays readable after the default moves again), the limit at 250, and
    // `minTokens: 0` so the summarize floor never refuses the pass by accident.
    const summarizeSettings = (
        extra: Record<string, number | string | boolean> = {}
    ): HarnessPluginSettingsProvider =>
        settingsOf({ contextLimit: LIMIT, minTokens: 0, mode: 'summarize', ...extra });

    // Waits for the fire-and-forget continuation. Resolves true once the nudge's answer has
    // landed and the conversation is idle again, false if that never happens within 1s — the
    // caller asserts `true`, so a missing continuation is a failure rather than a skip.
    const settle = async (writer: Harness, threadId: string, messages: number): Promise<boolean> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (
                writer.threadMessages(threadId).length >= messages &&
                writer.thread(threadId)?.status === 'idle'
            ) {
                return true;
            }

            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        return false;
    };

    // A tool the disobedient model can waste a turn on: it answers immediately, so the tool
    // round is over inside the run and the pass stays open exactly as long as the model keeps
    // refusing to answer in prose.
    const alphaTool = () =>
        tool({ description: 'Echo tool alpha.', tags: ['test'], visibility: 'core', execute: () => 'A' });

    // One tool round: prose plus a call, which is NOT a compaction answer (the answer test is
    // "assistant turn with no tool calls", shared by `turn.after` and the finalize range).
    const toolRound = (id: string, name: string): HarnessStreamEvent[] => [
        { type: 'text', delta: 'working' },
        { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: '{}' }] }
    ];

    it('compacts the conversation itself: park, instruction, answer, withhold, resume, nudge', async () => {
        const seen: HarnessStreamRequest[] = [];
        const statuses: string[] = [];
        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        // Captured from INSIDE the compaction request: the committed transcript at the moment
        // the instruction is already in it and the answer has not been written yet.
        let midPass: readonly HarnessMessage[] | undefined;

        let handle: Harness | undefined;
        let threadId = '';

        const stream = flowStream(
            [answer('SUMMARY'), answer('resumed')],
            seen,
            (index) => {
                statuses.push(String(handle?.thread(threadId)?.status));

                if (index === 0) midPass = handle?.threadMessages(threadId);
            }
        );

        handle = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates)],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const writer = handle;
        const thread = writer.createThread('writer', { label: 'Summarize' });

        threadId = thread.id;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        const reply = await writer.sendThreadInput(thread.id, PROMPT);

        // THE SUBMISSION RESOLVES ON THE SUMMARY. The caller asked `go` and got the
        // compaction back — accepted behaviour for this design (the continuation run is the
        // host's next turn), and the reason the nudge below is load-bearing.
        expect(reply.content).toBe('SUMMARY');
        expect(await settle(writer, threadId, 6)).toBe(true);

        // TWO model requests: the compaction turn, then the continuation.
        expect(seen).toHaveLength(2);

        // Request 1 is the projection exactly as measured, plus the committed instruction at
        // the end — the seeded turn and the prompt are still in front of it, because THIS
        // request is the one being answered.
        expect(seen[0].messages.map((message) => String(message.content))).toEqual([
            SEED,
            PROMPT,
            COMPACTION_INSTRUCTION
        ]);

        // Request 2 — THE PROOF THE CONTEXT IS SMALL AGAIN. The provider sees the instruction,
        // the agent's own summary, and the nudge: 3 messages, ~189 tokens, and neither the
        // 1200-character seed nor the prompt anywhere in it.
        expect(withoutIds(seen[1].messages)).toEqual([
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' },
            { role: 'user', content: CONTINUATION_NUDGE }
        ]);

        // The park is real and it is lifted — and the SECOND request went out while the
        // thread was 'running' again, which is the ordering the whole design hangs on:
        // `thread.idle` only fires on a real transition, so `turn.after` has to un-park the
        // conversation for the continuation to be schedulable at all.
        expect(statuses).toEqual(['paused', 'running']);
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(threadId)?.status).toBe('idle');

        // What the run had committed when the instruction was handed to the model: the
        // instruction as the LAST entry, and NO `included` flag anywhere. The commit does not
        // quietly rewrite the transcript's visibility before the answer exists — the range is
        // written after the summary, by the finalize, and not before.
        expect(withoutIds(midPass)).toEqual([
            { role: 'user', content: SEED },
            { role: 'user', content: PROMPT },
            { role: 'user', content: COMPACTION_INSTRUCTION }
        ]);

        // THE FINAL CANONICAL TRANSCRIPT. Nothing is deleted: the two superseded turns are
        // still in their original positions, flagged off, and the retained head (instruction,
        // summary, nudge, answer) follows them in order.
        expect(withoutIds(writer.threadMessages(threadId))).toEqual([
            { role: 'user', content: SEED, included: false },
            { role: 'user', content: PROMPT, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' },
            { role: 'user', content: CONTINUATION_NUDGE },
            { role: 'assistant', content: 'resumed' }
        ]);

        // THREE reports, one per edge of the pass, with the numbers an operator would ask for.
        expect(diagnostics).toHaveLength(3);
        expect(diagnostics.map((report) => report.owner)).toEqual([
            'context-compaction',
            'context-compaction',
            'context-compaction'
        ]);

        // The trigger: the LIVE projection beside the effective limit. Those two numbers are
        // the whole firing decision, and an operator reading the log has to be able to see WHY
        // the pass ran. `currentEstimatedTokens()` rather than `estimatedTokens` because the
        // latter is frozen at handler entry — a boundary that lands right after a compaction
        // would otherwise still see the pre-compaction size and fire the pass again.
        expect(diagnostics[0].message).toContain('~301 estimated tokens against an effective limit of 250');
        expect(diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId,
            tokens: 301,
            effective: 250,
            entries: 3
        });

        expect(diagnostics[1].message).toContain('answered its compaction instruction on turn 1');
        expect(diagnostics[1].data).toEqual({ mode: 'summarize', threadId, iteration: 1 });

        // The finalize: which range stopped being sent, and which two entries are now the
        // conversation's memory. `path` says idle because the run ENDED on the answer — the
        // wholesale rewrite is legal exactly there.
        expect(diagnostics[2].kind).toBe('policy');
        expect(diagnostics[2].message).toContain('2 of 4 entry(ies) stop being sent');
        expect(diagnostics[2].message).toContain('the instruction at #2 and the answer at #3');
        expect(diagnostics[2].message).toContain('finalized at thread.idle');
        expect(diagnostics[2].data).toEqual({
            mode: 'summarize',
            threadId,
            path: 'thread.idle',
            instructionIndex: 2,
            answerIndex: 3,
            disabled: [0, 1],
            total: 4
        });
    });

    it('writes the range lazily when the run kept going, and then sends no nudge at all', async () => {
        const seen: HarnessStreamRequest[] = [];
        const statuses: string[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        let handle: Harness | undefined;
        let threadId = '';

        // Steered from inside the compaction request, so the run has a second iteration
        // waiting after the summary — no idle moment between the answer and the next boundary.
        const stream = flowStream([answer('SUMMARY'), answer('kept going')], seen, (index) => {
            statuses.push(String(handle?.thread(threadId)?.status));
            if (index === 0) void handle?.steerThread(threadId, 'also this');
        });

        handle = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            pluginSettings: summarizeSettings(),
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const writer = handle;
        const thread = writer.createThread('writer', { label: 'Steer race' });

        threadId = thread.id;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        const reply = await writer.sendThreadInput(thread.id, PROMPT);

        // The steered input is what the submission resolves on, not the summary.
        expect(reply.content).toBe('kept going');
        expect(writer.thread(threadId)?.status).toBe('idle');
        expect(seen).toHaveLength(2);

        // THE LAZY FINALIZE, proven on the request it re-projected: the second request of the
        // SAME run carries the compacted head plus the steered input. `setIncluded` is the
        // only control that both writes the range and re-projects the live request, and this
        // is the case that pins it (the idle path rewrites the transcript instead).
        expect(seen[1].messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'SUMMARY',
            'also this'
        ]);

        // No nudge anywhere: the conversation was never interrupted, so there is nothing to
        // continue. The second turn of the run IS the continuation.
        expect(withoutIds(writer.threadMessages(threadId))).toEqual([
            { role: 'user', content: SEED, included: false },
            { role: 'user', content: PROMPT, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' },
            { role: 'user', content: 'also this' },
            { role: 'assistant', content: 'kept going' }
        ]);

        expect(diagnostics).toHaveLength(3);
        expect(diagnostics[2].message).toContain('finalized at turn.before');
        expect(diagnostics[2].data).toMatchObject({ path: 'turn.before', disabled: [0, 1] });
        expect(statuses).toEqual(['paused', 'running']);
    });

    it('answers the instruction with a tool call, and still withholds the turns it wasted', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const stream = flowStream(
            [toolRound('t1', 'alpha'), answer('FINALLY'), answer('resumed')],
            seen
        );

        const writer = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            tools: { alpha: alphaTool() },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates)],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const thread = writer.createThread('writer', { label: 'Disobedient' });

        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        const reply = await writer.sendThreadInput(thread.id, PROMPT);

        expect(reply.content).toBe('FINALLY');
        expect(await settle(writer, thread.id, 8)).toBe(true);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // ONE park for the whole thing, even though the model spent three turns: the phase
        // guard is a per-pass guard, not a per-turn one.
        expect(events).toEqual(['paused', 'resumed']);
        expect(seen).toHaveLength(3);

        // While the pass was still OPEN (the tool round's second request) nothing was
        // withheld — the intermediate turns are only known to be wasted once the prose answer
        // exists, and until then the model needs them.
        expect(seen[1].messages.map((message) => String(message.content))).toEqual([
            SEED,
            PROMPT,
            COMPACTION_INSTRUCTION,
            'working',
            'A'
        ]);

        // Then the compacted head, and the continuation on top of it.
        expect(seen[2].messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'FINALLY',
            CONTINUATION_NUDGE
        ]);

        // The disobedient block is withheld exactly like the old history: the call and its
        // result go, the instruction and the eventual summary stay.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SEED, included: false },
            { role: 'user', content: PROMPT, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            {
                role: 'assistant',
                content: 'working',
                included: false,
                toolCalls: [{ id: 't1', name: 'alpha', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'A',
                included: false,
                toolCallId: 't1',
                name: 'alpha'
            },
            { role: 'assistant', content: 'FINALLY' },
            { role: 'user', content: CONTINUATION_NUDGE },
            { role: 'assistant', content: 'resumed' }
        ]);

        // The answer edge names the turn it actually landed on (2), not the boundary the pass
        // started at, and the range counts the wasted block.
        expect(diagnostics[1].message).toContain('answered its compaction instruction on turn 2');
        expect(diagnostics[2].message).toContain('4 of 6 entry(ies) stop being sent');
        expect(diagnostics[2].data).toEqual({
            mode: 'summarize',
            threadId: thread.id,
            path: 'thread.idle',
            instructionIndex: 2,
            answerIndex: 5,
            disabled: [0, 1, 3, 4],
            total: 6
        });
    });

    it('lifts the park and rolls the pass back when the compaction request fails', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        // `retry: false` — the agent is the one retry owner (core/agent.ts R1), so without the
        // opt-out a transport error is a retry sequence rather than a failed run, and the
        // phase machine would never see `run.failed`.
        const writer = harness({
            agents: {
                writer: agent({
                    model: 'merge/ds4-flash',
                    retry: false,
                    stream: flowStream(
                        [[{ type: 'error', message: 'provider down' }] as HarnessStreamEvent[], answer('later')],
                        seen
                    )
                })
            },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates)],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const thread = writer.createThread('writer', { label: 'Provider down' });

        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        await expect(writer.sendThreadInput(thread.id, PROMPT)).rejects.toThrow('provider down');

        // THE CONTRACT OF THE FAILURE PATH: a failed compaction costs the conversation
        // nothing. The run's own rollback (`brain.messages.splice(commitIndex)`) removed the
        // instruction it committed, `run.failed` lifted the park, and the thread is usable.
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(seen).toHaveLength(1);
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([{ role: 'user', content: SEED }]);

        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[1].message).toContain('lifted its park on thread');
        expect(diagnostics[1].message).toContain('after a failed run (phase compacting)');
        expect(diagnostics[1].data).toEqual({
            mode: 'summarize',
            threadId: thread.id,
            phase: 'compacting',
            hook: 'run.failed'
        });

        // Usable means USABLE: the next turn runs on the untouched transcript. It does not
        // re-fire the pass, because the cooldown still holds the size the failed pass recorded
        // — the same re-trigger protection the `exclude` lifecycle pins, from the other side.
        const next = await writer.sendThreadInput(thread.id, 'retry now');

        expect(next.content).toBe('later');
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SEED },
            { role: 'user', content: 'retry now' },
            { role: 'assistant', content: 'later' }
        ]);
    });

    it('never re-sends a turn an earlier pass already withheld, through both wholesale writes', async () => {
        const seen: HarnessStreamRequest[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        // A turn a HOST (or an earlier `exclude` pass) had already switched off, big enough to
        // flip the trigger on its own if the estimate started counting it again.
        const withheld = `pre-withheld ${'w'.repeat(1200)}`;

        const stream = flowStream([answer('SUMMARY'), answer('resumed')], seen);

        const writer = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            pluginSettings: summarizeSettings(),
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const thread = writer.createThread('writer', { label: 'Already withheld' });

        writer.setThreadMessages(thread.id, [
            { role: 'user', content: withheld, included: false },
            { role: 'user', content: SEED }
        ]);

        expect((await writer.sendThreadInput(thread.id, PROMPT)).content).toBe('SUMMARY');
        expect(await settle(writer, thread.id, 7)).toBe(true);

        // The trigger measured the PROJECTION, not the transcript: ~301 (the seed and the
        // prompt), not ~601 with the already-withheld turn counted. A live estimate that read
        // canonical history would fire compaction on conversations that are already compacted.
        expect(diagnostics[0].data).toMatchObject({ tokens: 301, effective: 250 });

        // And it stayed off: no request this pass produced — the compaction turn, the
        // continuation, or the follow-up — ever carried that text again.
        const carries = (messages: readonly HarnessMessage[]): boolean =>
            messages.some((message) => String(message.content).startsWith('pre-withheld'));

        expect(seen.map((request) => carries(request.messages))).toEqual([false, false]);
        expect(
            writer.threadMessages(thread.id).slice(0, 2).map((message) => message.included)
        ).toEqual([false, false]);

        // The flag survived BOTH wholesale writes — `replaceHistory` (the commit) and
        // `replaceMessages` (the idle rewrite). Read as "is this entry withheld", the answer
        // is yes for the three turns the summary replaced (the pre-existing one, the seed, the
        // prompt) and no for the retained head (the instruction, the summary, the nudge, the
        // continuation's answer).
        expect(
            writer
                .threadMessages(thread.id)
                .map((message, index) => ({ index, withheld: message.included === false }))
        ).toEqual([
            { index: 0, withheld: true },
            { index: 1, withheld: true },
            { index: 2, withheld: true },
            { index: 3, withheld: false },
            { index: 4, withheld: false },
            { index: 5, withheld: false },
            { index: 6, withheld: false }
        ]);
    });

    it('runs one pass per crossing: one park, one instruction, and a second pass that reclaims the first', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        let handle: Harness | undefined;
        let threadId = '';

        const stream = flowStream([answer('SUMMARY'), answer('first'), answer('second')], seen);

        // How many instructions each request carried. A second one inside the FIRST
        // submission's requests would mean the phase guard leaked and a boundary re-triggered
        // on top of a pass that was already running; two in pass two's request is correct and
        // expected — the older instruction is still in the transcript, merely withheld.
        const instructions = (request: HarnessStreamRequest): number =>
            request.messages.filter((message) =>
                String(message.content).startsWith(COMPACTION_INSTRUCTION)
            ).length;

        handle = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates)],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const writer = handle;
        const thread = writer.createThread('writer', { label: 'Phase guard' });

        threadId = thread.id;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        expect((await writer.sendThreadInput(thread.id, PROMPT)).content).toBe('SUMMARY');
        expect(await settle(writer, threadId, 6)).toBe(true);

        // ONE park and ONE un-park for a submission that ran two model turns, and exactly the
        // three reports of a single pass.
        expect(events).toEqual(['paused', 'resumed']);
        expect(diagnostics).toHaveLength(3);
        expect(seen.map(instructions)).toEqual([1, 1]);

        // The next submission grows the conversation past the trigger again (~299 against
        // 250). The cooldown does NOT hold it back, because the turn that ran on the compacted
        // head measured ~189 — under the limit — and cleared it. So the second pass is a real
        // crossing, and its finalize reclaims the FIRST pass's turns as well: after this, the
        // only retained memory is the second instruction and the second summary.
        expect((await writer.sendThreadInput(threadId, 'y'.repeat(300))).content).toBe('second');
        expect(await settle(writer, threadId, 11)).toBe(true);

        expect(events).toEqual(['paused', 'resumed', 'paused', 'resumed']);
        expect(diagnostics).toHaveLength(6);

        // The request the SECOND compaction went out on: the compacted head from pass one
        // (instruction, summary, nudge, answer), the new prompt, and the new instruction —
        // 6 messages, no 1200-character seed anywhere.
        expect(seen[2].messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'SUMMARY',
            CONTINUATION_NUDGE,
            'first',
            'y'.repeat(300),
            COMPACTION_INSTRUCTION
        ]);
        expect(seen.map(instructions)).toEqual([1, 1, 2, 1]);

        // Seven of nine withheld: everything up to and including pass one's answer, because
        // pass two's summary replaces all of it.
        expect(diagnostics[5].data).toEqual({
            mode: 'summarize',
            threadId,
            path: 'thread.idle',
            instructionIndex: 7,
            answerIndex: 8,
            disabled: [0, 1, 2, 3, 4, 5, 6],
            total: 9
        });

        // The continuation after pass two runs on the new head alone: the older instruction is
        // now ordinary superseded history, withheld like everything else before the new one.
        expect(seen[3]?.messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'second',
            CONTINUATION_NUDGE
        ]);
    });

    it('persists the compacted head across a restart, and the restored harness sends only it', async () => {
        const seen: HarnessStreamRequest[] = [];

        let handle: Harness | undefined;
        let threadId = '';

        const stream = flowStream([answer('SUMMARY'), answer('resumed')], seen);

        handle = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            pluginSettings: summarizeSettings()
        });

        const writer = handle;
        const thread = writer.createThread('writer', { label: 'Restart' });

        threadId = thread.id;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        await writer.sendThreadInput(thread.id, PROMPT);
        expect(await settle(writer, threadId, 6)).toBe(true);

        // The document a store would have written: the flags are plain message fields, so the
        // compaction survives JSON the way every other canonical write does.
        const snapshot = JSON.parse(JSON.stringify(writer.snapshot())) as HarnessSnapshot;
        const before = withoutIds(writer.threadMessages(threadId));

        const restartSeen: HarnessStreamRequest[] = [];
        const fresh = harness({
            agents: {
                writer: agent({
                    model: 'merge/ds4-flash',
                    stream: flowStream([answer('after restart')], restartSeen)
                })
            },
            // Generous on purpose: this case is about what the restored transcript projects,
            // not about the restart firing another pass.
            pluginSettings: settingsOf({ contextLimit: 100000, minTokens: 0, mode: 'summarize' })
        });

        fresh.restore(snapshot);

        // Restored exactly as persisted — including a conversation that is NOT parked, which
        // is the other half of "no thread stranded paused": the park never outlives the pass,
        // so there is no paused state to restore.
        expect(fresh.thread(threadId)?.status).toBe('idle');
        expect(withoutIds(fresh.threadMessages(threadId))).toEqual(before);

        expect((await fresh.sendThreadInput(threadId, 'still there?')).content).toBe('after restart');

        // THE WHOLE POINT OF THE PERSISTENCE: a process that restarted with an empty plugin
        // state still talks to the model through the compacted head — the 1200-character seed
        // and the original prompt are gone from the request, and no plugin decision was
        // needed to keep them gone.
        expect(restartSeen[0].messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'SUMMARY',
            CONTINUATION_NUDGE,
            'resumed',
            'still there?'
        ]);
    });

    it('refuses the summarize pass below minTokens, and re-arms the moment the floor comes down', async () => {
        const seen: HarnessStreamRequest[] = [];

        // Mutable on purpose: the point of the last third of this case is that a REFUSE
        // records nothing (no cooldown, no park, no turn), so an operator who lowers the floor
        // gets the pass on the very next turn rather than waiting for the 5% regrowth margin.
        // `mode` names the flow explicitly rather than inheriting the declared default: an
        // unimplemented mode would degrade to `exclude`, whose floor means something else
        // entirely (a minimum SAVING, not a minimum conversation size), and this case would
        // then pass for the wrong reason.
        const stored: Record<string, number | string | boolean> = {
            contextLimit: 100,
            minTokens: 200,
            mode: 'summarize'
        };

        const provider: HarnessPluginSettingsProvider = {
            get: (plugin, key) => {
                if (plugin === 'context-trimmer' && key === 'enabled') return false;

                return plugin === 'context-compaction' ? stored[key] : undefined;
            }
        };

        const writer = harness({
            agents: {
                writer: brain(scripted([answer('ok'), answer('fine'), answer('summarised'), answer('after')], seen))
            },
            pluginSettings: provider
        });

        const thread = writer.createThread('writer', { label: 'Tiny' });

        // A request that carries no instruction at all IS the refusal: the park, the commit
        // and the model turn all hang off the same branch, so "no instruction in the provider
        // request" proves nothing was spent.
        const noInstruction = (request: HarnessStreamRequest): boolean =>
            request.messages.every((message) => {
                const content = String(message.content);

                return !content.startsWith(COMPACTION_INSTRUCTION) && !content.startsWith(CONTINUATION_NUDGE);
            });

        // 412 chars = 103 tokens: over the 100 limit, so the trigger fires, and far under the
        // 200 floor, so the round trip is refused as too small to be worth a summary.
        expect((await writer.sendThreadInput(thread.id, 'x'.repeat(412))).content).toBe('ok');
        expect(seen).toHaveLength(1);
        expect(noInstruction(seen[0])).toBe(true);

        // Same conversation, one and a half tokens larger, still refused. A RECORDED cooldown
        // would have suppressed this turn on the margin alone, and the next turn proves
        // nothing was recorded at all.
        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'x'.repeat(420) }]);
        expect((await writer.sendThreadInput(thread.id, 'again')).content).toBe('fine');
        expect(seen).toHaveLength(2);
        expect(seen.map(noInstruction)).toEqual([true, true]);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // The floor goes to 0 — the same live re-read every other setting gets — and the very
        // next turn compacts. The size (107 → 108) is inside the 5% margin, so a cooldown
        // recorded by either refusal would have held this turn back.
        stored.minTokens = 0;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'x'.repeat(424) }]);

        expect((await writer.sendThreadInput(thread.id, 'now')).content).toBe('summarised');
        expect(String(seen[2].messages[seen[2].messages.length - 1].content)).toBe(COMPACTION_INSTRUCTION);

        // Out of the way for the continuation run: at this scale (the retained head alone is
        // ~217 tokens against a limit of 100) the next boundary would compact again, which is
        // correct behaviour but not what this case is measuring.
        stored.contextLimit = 100000;
        expect(await settle(writer, thread.id, 6)).toBe(true);

        // The one pass this conversation got: instruction, answer, nudge, continuation — and
        // the two superseded turns behind them, withheld.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: 'x'.repeat(424), included: false },
            { role: 'user', content: 'now', included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'summarised' },
            { role: 'user', content: CONTINUATION_NUDGE },
            { role: 'assistant', content: 'after' }
        ]);
    });

    // -----------------------------------------------------------------------
    // T11 — the three edges the independent review found untested or wrong.
    // -----------------------------------------------------------------------

    // A gate the SCRIPTED TRANSPORT awaits. An async generator may await between requests
    // (src/harness.ts streams whatever the transport yields), so holding the model turn open
    // is deterministic rather than a race — the compaction park is observably held while
    // something else speaks, and the case releases it when it is done looking.
    const gate = (): { promise: Promise<void>; open: () => void } => {
        let open!: () => void;

        const promise = new Promise<void>((resolve) => {
            open = resolve;
        });

        return { promise, open };
    };

    // Wait for a status the harness writes from INSIDE a run, bounded so a missing
    // transition fails this case instead of hanging it (mirrors the helper in
    // src/harness.thread-park-queue.test.ts).
    const waitStatus = async (writer: Harness, threadId: string, status: string): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (writer.thread(threadId)?.status === status) return;

            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        throw new Error(
            `Thread "${threadId}" never reached "${status}" (last: ${
                writer.thread(threadId)?.status ?? 'missing'
            }).`
        );
    };

    // The same settings WITHOUT the trimmer switch `settingsOf` turns off: an unset
    // `enabled` lands on the trimmer's declared default (true), so both shipped
    // `turn.before` passes share the round the way they do in a real server.
    const summarizeWithTrimmer = (): HarnessPluginSettingsProvider => {
        const stored: Record<string, number | string | boolean> = {
            contextLimit: LIMIT,
            minTokens: 0,
            mode: 'summarize'
        };

        return {
            get: (plugin, key) => (plugin === 'context-compaction' ? stored[key] : undefined)
        };
    };

    // D3 — the retention rule's sharp edge, pinned as the limitation it is.
    //
    // A steer that drains AFTER the instruction was committed and BEFORE the prose summary
    // lands inside the withheld range [instruction, answer), so it stops being sent even
    // though it is a brand-new fact rather than the history the summary replaced. That is
    // the ratified design ("disable all the turns between the instruction and the final
    // answer"), and it is not a lost message: the drain happens before a request, so the
    // model read it on the very turn that produced the summary — the summary is its record.
    // What the case pins is the cost: the retained head is the summary, not the transcript.
    it('withholds guidance that drains between the instruction and the summary (T11/D3 limitation)', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const STEER = 'steered mid-compaction';

        let handle: Harness | undefined;
        let threadId = '';

        // The steer lands inside the FIRST (parked) request: the conversation is 'paused',
        // so steering QUEUES (context T8) and drains at the run's next boundary — after the
        // tool round, before the prose answer.
        const stream = flowStream(
            [toolRound('t1', 'alpha'), answer('SUMMARIZED'), answer('resumed')],
            seen,
            (index) => {
                if (index === 0) handle?.steerThread(threadId, STEER);
            }
        );

        const writer = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            tools: { alpha: alphaTool() },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates)],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        handle = writer;

        const thread = writer.createThread('writer', { label: 'Mid-pass steer' });
        threadId = thread.id;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        const reply = await writer.sendThreadInput(thread.id, PROMPT);

        expect(reply.content).toBe('SUMMARIZED');
        expect(await settle(writer, thread.id, 9)).toBe(true);

        // ONE park for the whole pass, and no extra resume from the steered drain.
        expect(events).toEqual(['paused', 'resumed']);
        expect(seen).toHaveLength(3);

        // The request that answered the instruction carried the steered turn: the drain
        // happened before the request went out, which is why the withholding below is a
        // retention decision and never a lost message.
        expect(seen[1].messages.map((message) => String(message.content))).toEqual([
            SEED,
            PROMPT,
            COMPACTION_INSTRUCTION,
            'working',
            'A',
            STEER
        ]);

        // THE WITHHOLDING. The continuation request carries the instruction, the summary, and
        // the nudge — and not the steered turn, which sits strictly between the instruction
        // and the answer.
        expect(seen[2].messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'SUMMARIZED',
            CONTINUATION_NUDGE
        ]);

        // Canonical history keeps every entry in place; the flags are the whole story. Entry 5
        // is the steered turn that drained mid-pass: withheld with its neighbours.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SEED, included: false },
            { role: 'user', content: PROMPT, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            {
                role: 'assistant',
                content: 'working',
                included: false,
                toolCalls: [{ id: 't1', name: 'alpha', arguments: '{}' }]
            },
            { role: 'tool', content: 'A', included: false, toolCallId: 't1', name: 'alpha' },
            { role: 'user', content: STEER, included: false },
            { role: 'assistant', content: 'SUMMARIZED' },
            { role: 'user', content: CONTINUATION_NUDGE },
            { role: 'assistant', content: 'resumed' }
        ]);

        // The range says so in numbers: five entries stop being sent, the mid-pass steer
        // (index 5) among them, and the retained head is the instruction at #2 and the answer
        // at #6.
        expect(diagnostics[2].data).toEqual({
            mode: 'summarize',
            threadId: thread.id,
            path: 'thread.idle',
            instructionIndex: 2,
            answerIndex: 6,
            disabled: [0, 1, 3, 4, 5],
            total: 7
        });
    });

    // D5 — end to end through the SHIPPED plugin: a delegate's `threadSend` arriving while
    // the summarize park is held must QUEUE, must not start a second run on the compacting
    // conversation, and must drain afterwards as a RETAINED entry (it landed after the
    // instruction and the answer, so the retention range does not reach it).
    it('queues a delegate threadSend that lands during the shipped park, and keeps it after the summary', async () => {
        const seen: HarnessStreamRequest[] = [];
        const scoutSeen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const statuses: string[] = [];
        const scoutEvents: string[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const hold = gate();

        let handle: Harness | undefined;
        let threadId = '';
        let scoutThreadId = '';

        // The compacting conversation: the transport WAITS inside the compaction request, so
        // the park is held for exactly as long as the delegate needs to speak into it.
        const writerStream: HarnessStream = async function* (request) {
            seen.push(request);
            statuses.push(String(handle?.thread(threadId)?.status));

            // THE WINDOW: one awaited gate inside the parked model turn. An async generator
            // may await (the harness consumes whatever the transport yields), so the park is
            // held deterministically while the delegate's run speaks.
            if (seen.length === 1) await hold.promise;

            const frames =
                seen.length === 1
                    ? answer('SUMMARY')
                    : seen.length === 2
                        ? answer('the finding was read')
                        : answer('resumed');

            for (const frame of frames) yield frame;
        };

        // THE DELEGATE. Its FIRST turn is a real tool round on the shipped cross-thread tool,
        // so the sender identity is the runtime's (the calling run's agent and thread), not
        // something the test passed in. `threadId`/`scoutThreadId` are only known after
        // `harness(...)`, which is why the frames are built here rather than in a list.
        const scoutStream: HarnessStream = async function* (request) {
            scoutSeen.push(request);

            if (scoutSeen.length === 1) {
                for (const frame of [
                    { type: 'text', delta: 'reporting' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [
                            {
                                id: 's1',
                                name: 'threadSend',
                                arguments: JSON.stringify({ thread: threadId, message: 'the finding' })
                            }
                        ]
                    }
                ] as HarnessStreamEvent[]) {
                    yield frame;
                }

                return;
            }

            for (const frame of answer('noted')) yield frame;
        };

        handle = harness({
            agents: {
                writer: agent({ model: 'merge/ds4-flash', stream: writerStream }),
                scout: agent({ model: 'merge/ds4-flash', stream: scoutStream })
            },
            pluginSettings: summarizeSettings(),
            plugins: [
                {
                    name: 'scout-probe',
                    setup: (api) => {
                        api.on('run.started', (payload) => void scoutEvents.push(`run:${payload.input}`));
                    }
                },
                probe(events, [])
            ],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const writer = handle;
        const thread = writer.createThread('writer', { label: 'Parked compaction' });
        const scoutThread = writer.createThread('scout', { label: 'Delegate' });

        threadId = thread.id;
        scoutThreadId = scoutThread.id;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: SEED }]);

        const turn = writer.sendThreadInput(thread.id, PROMPT);

        // The park is live BEFORE the delegate may speak.
        await waitStatus(writer, threadId, 'paused');

        // The delegate runs its own conversation (its tool round performs the send) and
        // finishes, while the compacting conversation sits parked.
        expect((await writer.sendThreadInput(scoutThread.id, 'report the finding')).content).toBe(
            'noted'
        );

        // THE WINDOW, read while the parked request is still awaiting its gate: the roster
        // says `paused`, the compacting conversation has made exactly ONE provider request,
        // and the only run this harness started is the delegate's own.
        expect(writer.thread(threadId)?.status).toBe('paused');
        expect(seen).toHaveLength(1);
        // TWO runs in the whole harness at this point: the compaction run ('go') and the
        // delegate's own. The parked conversation got NO second run — a message that merely
        // arrives does not steal the holder's turn (context T8), which is the half of D5 the
        // reviewer asked for.
        expect(scoutEvents).toEqual(['run:go', 'run:report the finding']);

        // The finding is NOT in the compacting transcript yet — a park is a queue, not a turn.
        expect(writer.threadMessages(thread.id).map((message) => String(message.content))).toEqual([
            SEED,
            PROMPT,
            COMPACTION_INSTRUCTION
        ]);

        // THE RECEIPT, as the delegate's own conversation recorded it: the tool result is the
        // runtime's receipt, and it says `queued` — not `started`, which is what the same send
        // does to a conversation nobody parked.
        expect(JSON.parse(String(writer.threadMessages(scoutThread.id)[2].content))).toEqual({
            threadId,
            delivered: 'queued',
            sender: 'scout',
            senderThreadId: scoutThreadId
        });

        // Release the gate: the summary lands, `turn.after` lifts the park, and the run's OWN
        // next boundary drains the finding (context T8 — a park taken inside a run is applied
        // by that run, never by a second one). So one run answers both the instruction and the
        // finding, and the lazy `turn.before` finalize is the pass's writer.
        hold.open();

        expect((await turn).content).toBe('the finding was read');

        // One park, one lift, and STILL only two runs in the harness: the compacting run and the
        // delegate's. The drained finding bought one more turn of the parked run; it did not
        // start a conversation of its own.
        expect(events).toEqual(['paused', 'resumed']);
        expect(scoutEvents).toEqual(['run:go', 'run:report the finding']);
        expect(seen).toHaveLength(2);
        expect(statuses).toEqual(['paused', 'running']);

        // THE RETAINED FINDING. The finalize ran with the finding already in the transcript, and
        // it sits AFTER the instruction and after the summary, so the retention range stops in
        // front of it: the next request carries the instruction, the summary, and the finding —
        // attributed by the runtime to the delegate that sent it.
        expect(seen[1].messages.map((message) => String(message.content))).toEqual([
            COMPACTION_INSTRUCTION,
            'SUMMARY',
            `from agent "scout" (thread ${scoutThreadId}):\nthe finding`
        ]);

        // Canonical history: the two superseded turns withheld, and everything the pass retained
        // — the summary, the finding, and the answer that read it — still sent.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SEED, included: false },
            { role: 'user', content: PROMPT, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' },
            { role: 'user', content: `from agent "scout" (thread ${scoutThreadId}):\nthe finding` },
            { role: 'assistant', content: 'the finding was read' }
        ]);

        // THREE reports, all on the compacting conversation — the delegate's own run is not a
        // pass and produces none. The finalize names the LAZY path (`turn.before`, because the
        // run kept going) and the range it withheld: the two turns the summary replaced, out of
        // the five entries that existed at that boundary.
        expect(diagnostics.map((report) => report.owner)).toEqual([
            'context-compaction',
            'context-compaction',
            'context-compaction'
        ]);
        expect(diagnostics[2].message).toContain('finalized at turn.before');
        expect(diagnostics[2].data).toEqual({
            mode: 'summarize',
            threadId,
            path: 'turn.before',
            instructionIndex: 2,
            answerIndex: 3,
            disabled: [0, 1],
            total: 5
        });
    });

    // The same-round interaction the review's D1 defect is about, through BOTH shipped
    // passes: the trimmer has candidates on the trigger round, runs its
    // `pause -> write -> resume` wrapper inside the compaction park, and must leave that park
    // exactly where it found it.
    it('keeps its park held when context-trimmer writes in the same round (T11/D1 interaction)', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const statuses: string[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        let handle: Harness | undefined;
        let threadId = '';

        const stream = flowStream([answer('SUMMARY'), answer('resumed')], seen, () => {
            statuses.push(String(handle?.thread(threadId)?.status));
        });

        const writer = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            pluginSettings: summarizeWithTrimmer(),
            plugins: [probe(events, [])],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        handle = writer;

        const thread = writer.createThread('writer', { label: 'Both passes' });
        threadId = thread.id;

        // A conversation that trips BOTH passes on the first boundary: a `read` that failed
        // and was answered by a later `read` (a trim candidate), and enough text to cross the
        // limit. The trimmer has never seen this transcript, so its plan is non-empty exactly
        // on the round the compactor parks.
        writer.setThreadMessages(thread.id, [
            { role: 'user', content: 'open both' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
            },
            {
                role: 'tool',
                content: `Tool "read" failed: ${'E'.repeat(1200)}`,
                toolCallId: 'c1',
                name: 'read',
                outcome: 'failed'
            },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }]
            },
            { role: 'tool', content: 'export const b = 2;', toolCallId: 'c2', name: 'read' }
        ]);

        const reply = await writer.sendThreadInput(thread.id, PROMPT);

        expect(reply.content).toBe('SUMMARY');
        expect(await settle(writer, threadId, 10)).toBe(true);

        // THE CLAIM: the roster says 'paused' while the compaction request is in flight, even
        // though the trimmer paused and un-parked inside that same round. Before T11 the first
        // entry here was 'running' — the trimmer's `finally` had lifted the park on the turn
        // that took it.
        expect(statuses).toEqual(['paused', 'running']);
        expect(events).toEqual(['paused', 'resumed']);

        // And the trimmer really did write in that round (it is not a pass that skipped): the
        // owners interleave inside ONE round, compaction's trigger first, the trimmer's pass
        // report second, both after the answer the finalize report.
        expect(diagnostics.map((report) => report.owner)).toEqual([
            'context-compaction',
            'context-trimmer',
            'context-compaction',
            'context-compaction'
        ]);
        expect(diagnostics[1].message).toContain('context-trimmer withheld 1 superseded tool unit');
        expect(diagnostics[1].message).toContain('read');

        // The provider saw the instruction plus the projection on the trigger turn, and the
        // compacted head on the continuation — the trimmer's flags and the compaction's
        // rewrite agree, because the trimmer only ever writes `included: false`.
        expect(seen).toHaveLength(2);
        expect(withoutIds(seen[1].messages)).toEqual([
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' },
            { role: 'user', content: CONTINUATION_NUDGE }
        ]);

        // Nothing deleted: the failed unit the trimmer withheld, the answering unit and the
        // prompt the summary replaced are all still in place, all withheld; the retained head
        // is the instruction, the summary, the nudge and the continuation answer.
        expect(
            writer
                .threadMessages(threadId)
                .map((message, index) => ({ index, withheld: message.included === false }))
        ).toEqual([
            { index: 0, withheld: true },
            { index: 1, withheld: true },
            { index: 2, withheld: true },
            { index: 3, withheld: true },
            { index: 4, withheld: true },
            { index: 5, withheld: true },
            { index: 6, withheld: false },
            { index: 7, withheld: false },
            { index: 8, withheld: false },
            { index: 9, withheld: false }
        ]);
    });
});

// ---------------------------------------------------------------------------
// T11/D2 — THE RUN-TERMINAL NETS, on their own.
//
// `run.finished` used to un-park ONLY a `compacting` pass, while `run.failed` un-parks for
// any phase. The asymmetry matters because `thread.idle` fires only on a REAL transition to
// idle (src/harness.ts ~10298): a record left 'paused' produces no idle event at all, so a
// 'finishing' pass holding a park would strand the conversation with no finalize and no
// continuation. The combination is pathological (`turn.after` un-parks in the same handler
// that sets the phase, so it needs a throw between the two), and both halves of the net are
// pinned here at the handler level, where the fake api records every control the pass reaches
// (`skip` in `createFakeApi` records the name and throws, and the plugin's `unpark` swallows
// exactly that throw) — a real harness cannot produce the state on purpose.
// ---------------------------------------------------------------------------

describe('context-compaction run-terminal nets (T11/D2)', () => {
    const runLifecycle = { threadId: 'thread-1', agent: 'writer', depth: 1, input: 'go' };

    it('un-parks on run.finished from the finishing phase, and keeps that phase for the idle finalize', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // The pass has to EXIST before any terminal edge means anything: a `turn.before` over
        // the limit sets `compacting` and parks the conversation (the fake payload records the
        // `pause`, exactly as the `compacting` case below does), so the state this case starts
        // from is the shipped one rather than a hand-built map entry.
        const calls: string[] = [];

        await passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                calls,
                threadId: 'thread-1'
            })
        );
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        // Everything below is about the two terminal edges, so the trigger's own reads and its
        // 'entering' report are cleared out of the way here.
        fake.touches.length = 0;

        // The edge that ends `compacting`: a tool-free answer, so the phase becomes
        // `finishing` and the ordinary unpark runs in the SAME handler — the lift first, then
        // the report that names the turn it landed on.
        passes.turnAfter({
            ...runLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });
        expect(fake.touches).toEqual(['threads.resume', 'report.diagnostic']);

        // THE NET. The run ends with `finishing` STILL set (the state a throw between the
        // phase set and that unpark would leave). Before T11/D2 this hook touched nothing at
        // all and the park survived.
        fake.touches.length = 0;
        fake.diagnostics.length = 0;
        passes.runFinished({
            ...runLifecycle,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        // One control: the lift. And no report, because a `finishing` pass is not an
        // abandoned one — the finalize below is its report.
        expect(fake.touches).toEqual(['threads.resume']);
        expect(fake.diagnostics).toHaveLength(0);

        // THE PHASE SURVIVED THE NET: the `thread.idle` that follows in the same `finally`
        // refuses to do anything without `finishing`, so reaching the transcript read here IS
        // the proof. (The fake's `threads.messages` refuses, which is the plugin's `nothing`
        // branch — the phase is cleared there, exactly as it is for a purged conversation.)
        fake.touches.length = 0;
        passes.threadIdle({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            sequence: 1,
            status: 'idle'
        });
        expect(fake.touches).toEqual(['threads.messages', 'threads.resume']);
    });

    // The `compacting` net, unchanged by D2: the pass IS abandoned, so the phase clears and
    // the operator gets the report that says so.
    it('still reports and clears an abandoned compacting pass on run.finished', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // The trigger sets `compacting` without any answer: a `turn.before` over the limit,
        // handed the persistent-thread shape the summarize flow needs.
        const calls: string[] = [];

        // Awaited because the summarize trigger IS the async begin (the phase itself is set
        // synchronously, before its first await; the park and the two writes are not).
        await passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                calls,
                threadId: 'thread-1'
            })
        );

        // The pass is open: parked, and the instruction committed into history AND this request.
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        passes.runFinished({
            ...runLifecycle,
            message: { role: 'assistant', content: 'not a compaction answer' }
        });

        expect(fake.touches).toEqual(['threads.resume', 'report.diagnostic']);
        expect(fake.diagnostics).toHaveLength(1);
        expect(fake.diagnostics[0].message).toContain(
            'abandoned its summarize pass on thread thread-1'
        );
        expect(fake.diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            hook: 'run.finished'
        });

        // And the phase went WITH the report: the idle edge that follows finds nothing to
        // finalize and touches the thread not at all.
        fake.touches.length = 0;
        passes.threadIdle({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            sequence: 1,
            status: 'idle'
        });
        expect(fake.touches).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T9 — THE RETENTION RANGE, as a table.
//
// `planCompactionRetention` is the single rule BOTH finalize paths write from, so the whole
// "what stops being sent" decision is pinned here without a harness: the exact indices, for
// the transcripts the flow actually produces. The fixtures use the exported instruction for
// the committed turn and a SHORTER one with the same marker for the second pass, because
// detection is by marker PREFIX — the body is free to change and this table stays valid.
// ---------------------------------------------------------------------------

describe('context-compaction retention range (planCompactionRetention)', () => {
    const INSTRUCTION = COMPACTION_INSTRUCTION;
    const SHORT_INSTRUCTION = '[context compaction] do the same thing, shorter body';

    const turn = (role: HarnessMessage['role'], content: string, extra: Partial<HarnessMessage> = {}): HarnessMessage =>
        ({ role, content, ...extra }) as HarnessMessage;

    it('finds nothing to disable when the transcript carries no instruction', () => {
        expect(planCompactionRetention([turn('user', 'question'), turn('assistant', 'answer')])).toEqual({
            instructionIndex: -1,
            answerIndex: -1,
            disabled: []
        });

        expect(planCompactionRetention([])).toEqual({ instructionIndex: -1, answerIndex: -1, disabled: [] });
    });

    it('withholds the history the summary replaced and nothing else', () => {
        expect(
            planCompactionRetention([
                turn('user', 'old work'),
                turn('assistant', 'old answer'),
                turn('user', INSTRUCTION),
                turn('assistant', 'the summary')
            ])
        ).toEqual({ instructionIndex: 2, answerIndex: 3, disabled: [0, 1] });
    });

    it('withholds the turns a disobedient model spent between the instruction and the answer', () => {
        expect(
            planCompactionRetention([
                turn('user', 'old work'),
                turn('user', INSTRUCTION),
                turn('assistant', 'working', { toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }] }),
                turn('tool', 'A', { toolCallId: 't1', name: 'read' }),
                turn('assistant', 'the summary'),
                // Whatever arrived AFTER the answer is the conversation moving on, not
                // something the summary replaced — so it stays.
                turn('user', 'and now this')
            ])
        ).toEqual({ instructionIndex: 1, answerIndex: 4, disabled: [0, 2, 3] });
    });

    it('takes the LAST answer when the model answered twice, and the LAST instruction when there are two passes', () => {
        // Two prose turns after the instruction (the second is the continuation's answer):
        // the range still ends at the newest one, so nothing between the instruction and the
        // newest answer is left sending.
        expect(
            planCompactionRetention([
                turn('user', 'old'),
                turn('user', INSTRUCTION),
                turn('assistant', 'first summary'),
                turn('user', 'nudge'),
                turn('assistant', 'latest answer')
            ])
        ).toEqual({ instructionIndex: 1, answerIndex: 4, disabled: [0, 2, 3] });

        // Pass two's instruction is the anchor; pass one's head is ordinary history again.
        expect(
            planCompactionRetention([
                turn('user', 'old'),
                turn('user', INSTRUCTION),
                turn('assistant', 'summary one'),
                turn('user', SHORT_INSTRUCTION),
                turn('assistant', 'summary two')
            ])
        ).toEqual({ instructionIndex: 3, answerIndex: 4, disabled: [0, 1, 2] });
    });

    it('leaves a host-seeded system entry and an unanswered instruction alone', () => {
        // A `system` entry is a standing instruction, never history: the shipped path stores
        // instruction blocks outside the transcript, so this only ever fires for a host that
        // seeds one — and no compaction may silence it.
        expect(
            planCompactionRetention([
                turn('system', 'standings'),
                turn('user', 'old work'),
                turn('user', INSTRUCTION),
                turn('assistant', 'the summary')
            ])
        ).toEqual({ instructionIndex: 2, answerIndex: 3, disabled: [1] });

        // No answer yet (the model has not replied, or a host edited the answer away): the
        // history before the instruction is still superseded, and nothing after it is touched.
        expect(
            planCompactionRetention([
                turn('user', 'old work'),
                turn('user', INSTRUCTION),
                turn('assistant', 'a tool call', { toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }] })
            ])
        ).toEqual({ instructionIndex: 1, answerIndex: -1, disabled: [0] });
    });

    it('anchors on the marker PREFIX of a user turn, not on the body or another role', () => {
        // Reworded body: still the instruction, because the FIRST LINE is the protocol.
        expect(
            planCompactionRetention([turn('user', 'old'), turn('user', SHORT_INSTRUCTION), turn('assistant', 's')])
        ).toEqual({ instructionIndex: 1, answerIndex: 2, disabled: [0] });

        // The marker in the MIDDLE of a sentence is a human quoting the plugin, not the
        // plugin; and an assistant turn that starts with the marker (a model parroting it)
        // is not the committed instruction either.
        expect(
            planCompactionRetention([
                turn('user', 'I saw "[context compaction]" in the log, what is it?'),
                turn('assistant', '[context compaction] repeating the header back')
            ])
        ).toEqual({ instructionIndex: -1, answerIndex: -1, disabled: [] });
    });

    it('names the marker the protocol is built on', () => {
        // Both exported strings start with the same marker, and it is the anchor every
        // finalize and every restart detection uses. A rename here is a protocol change: an
        // in-flight transcript's instruction stops being recognisable.
        expect(COMPACTION_INSTRUCTION.startsWith('[context compaction]')).toBe(true);
        expect(CONTINUATION_NUDGE.startsWith('[context compaction]')).toBe(true);
        expect(COMPACTION_INSTRUCTION).toContain('Do not call tools');
        expect(CONTINUATION_NUDGE).toContain('Your context was just compacted');
    });
});

// ---------------------------------------------------------------------------
// UPLIFT T9 — THE OVERLAP, MEASURED: EXACTLY ONE PASS WITHHOLDS A SUPERSEDED UNIT.
//
// Until today this file only ever measured ONE pass at a time: `settingsOf` above seeds
// `context-trimmer` OFF, because the trimmer's rule (superseded failed tool units) overlaps
// compaction's failure-retry prune, and the fixtures wanted a single plugin's numbers. Task T9
// of docs/tasks/2026-11-10-context-trimmer-uplift.md ratified what that overlap means now that
// the trimmer has switches: compaction KEEPS its failure-retry pruning, and the trimmer's rule
// becomes compaction's rule by construction at `supersedeMatch: 'fingerprint'`. The resolution
// is not a phase check or a new priority — it is the fact that both passes are withhold-only and
// idempotent, so the second one to run finds the unit already withheld and writes nothing.
//
// This block pins that sentence at both levels the file already uses:
//
//   1. THE ACTIONS, run in the order the bus dispatches them (compaction first —
//      src/plugin/manifest.ts scans paths ascending, src/plugin/hooks.ts runs registrations in
//      order at equal priority), against the shared fakes. There `calls` IS the write count, so
//      "exactly one pass withholds it" is an assertion about one recorded
//      `setIncluded:1:false`, not about a side effect that two passes could each have produced;
//   2. THE BUILT-INS through a REAL harness with the trimmer left at its declared defaults,
//      where the observables are the canonical flags, the provider request, the diagnostic
//      OWNERS, and the round's persistence profile.
//
// Why it is load-bearing: src/plugins/context-compaction.plugin.ts ~196-228 skips any phase
// check against the trimmer on the argument that the trimmer "writes ONLY `included: false`
// flags … nothing that re-ENABLES an entry". With twelve settings, a thinking flag and a
// fingerprint matcher, that is a claim about code rather than intent; the case below is where a
// regression (a pass that re-enables, or a pass that ignores the live flag and writes twice)
// stops being invisible.
// ---------------------------------------------------------------------------

describe('context-compaction × context-trimmer overlap (uplift T9)', () => {
    // The same transcript as `prunableEntries` above, in message form (that helper builds
    // fake ENTRIES, and a real harness needs the messages). One failed `read`, the same call
    // answered later with its arguments reordered — a fingerprint match, and trivially a name
    // match, so BOTH rules see exactly the same candidate — with a turn on each side.
    const supersededFixture = (): HarnessMessage[] => [
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

    // The provider BOTH built-ins see: compaction's numbers are stored, and every trimmer key
    // falls through as `undefined`, i.e. its DECLARED default (`enabled` true,
    // `dropSupersededToolCalls` true, `dropInvalidToolCallsOnceAnswered` true,
    // `invalidOutcomes` "failed,rejected", `supersedeMatch` "name", `dropDuplicateCalls` false,
    // `dropOldThoughts` "turn", and every economy knob 0). That is precisely the fresh-install
    // posture an operator gets from `GET /plugins`, which is what makes the numbers below the
    // shipped behaviour rather than a fixture arrangement.
    const bothPassesAt = (
        values: Record<string, number | string | boolean>
    ): HarnessPluginSettingsProvider => ({
        get: (plugin, key) => (plugin === 'context-compaction' ? values[key] : undefined)
    });

    const overlapRun = async (input: {
        provider: HarnessPluginSettingsProvider;
        stateChanges: HarnessStateChangeEvent[];
        diagnostics: HarnessDiagnosticEvent[];
        seen: HarnessStreamRequest[];
    }): Promise<{ writer: Harness; threadId: string }> => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('after')], input.seen)) },
            pluginSettings: input.provider,
            report: {
                stateChange: (event) => void input.stateChanges.push(event),
                diagnostic: (event) => void input.diagnostics.push(event)
            }
        });

        const thread = writer.createThread('writer', { label: 'Overlap fixture' });
        writer.setThreadMessages(thread.id, supersededFixture());
        await writer.sendThreadInput(thread.id, 'next');

        return { writer, threadId: thread.id };
    };

    // The numbers, derived the way this file derives all of them (core/context-estimate.ts,
    // ceil(chars / 4)): the failed unit is 944 characters — the 921-character result plus its
    // 4-character tool name, and the leader's 19 (4 name + the 15 raw argument characters) — so
    // 236 withheld tokens, the same figure the `executeCompaction` case above pins for this
    // exact fixture. The whole transcript is ~256 tokens, far over the 100-token limit, so the
    // compaction trigger fires on the first turn of both runs.
    const BOTH_PASS_SETTINGS = { contextLimit: 100, minTokens: 10, safetyTurns: 0, mode: 'exclude' };

    // THE PREMISE, pinned before the exactly-one cases: the two rules select the SAME unit, so
    // the overlap is real and has to be resolved. `prunableEntries` is deliberately a fixture
    // whose retry differs only in whitespace — it matches under BOTH matchers — which is the
    // shipped evidence that `supersedeMatch: 'fingerprint'` makes the trimmer's rule
    // compaction's rule by construction (`toolCallFingerprint(name, canonicalArguments)`,
    // src/core/argument-fingerprint.ts), and that at the shipped `'name'` the trimmer's rule is
    // the looser of the two, i.e. a superset. That is what makes compaction's prune
    // redundant-but-harmless rather than a second eviction.
    it('has both rules select the same unit, at either matcher', () => {
        const entries = prunableEntries();
        const fingerprint: TrimmerSettings = {
            ...TRIMMER_DEFAULT_SETTINGS,
            supersedeMatch: 'fingerprint'
        };

        const trimmerPlan = (settings: TrimmerSettings) =>
            planTrimmedUnits(entries, settings).map((candidate) => ({
                leaderIndex: candidate.leaderIndex,
                resolverIndex: candidate.resolverIndex,
                names: candidate.names,
                firedBy: candidate.firedBy
            }));

        const SAME_TRIMMER_CANDIDATE = [
            {
                leaderIndex: 1,
                resolverIndex: 3,
                names: ['read'],
                firedBy: 'dropSupersededToolCalls'
            }
        ];

        expect(trimmerPlan(TRIMMER_DEFAULT_SETTINGS)).toEqual(SAME_TRIMMER_CANDIDATE);
        expect(trimmerPlan(fingerprint)).toEqual(SAME_TRIMMER_CANDIDATE);

        // Compaction's own policy over the same entries, with its gates opened to the fixture's
        // numbers (no horizon, no floor, the shipped per-pass cap): the identical unit, nothing
        // else — the two passes agree on WHICH unit and differ only about whether their own
        // floor/horizon/cooldown lets them act at all.
        expect(
            planContextPruning(entries, { safetyUnits: 0, maxUnits: 8, minTokens: 0 })
                .candidates
                .map((candidate) => ({
                    leaderIndex: candidate.leaderIndex,
                    resolverIndex: candidate.resolverIndex,
                    outcomes: candidate.outcomes
                }))
        ).toEqual([{ leaderIndex: 1, resolverIndex: 3, outcomes: ['failed'] }]);
    });

    it('withholds the unit through exactly one write when both actions run in one round', async () => {
        // Both dispatch orders, because "exactly one pass" must not be an artefact of which hook
        // the bus happens to run first. The shipped order is the first arm.
        for (const order of ['compaction-first', 'trimmer-first'] as const) {
            const { api, diagnostics } = createFakeApi(100, { minTokens: 10, safetyTurns: 0 });
            const calls: string[] = [];
            const entries = prunableEntries();
            const context = createFakeTurn({ api, estimatedTokens: 500, calls, entries });

            if (order === 'compaction-first') {
                await executeCompaction(api, context);
                await executeTrimming(api, context);
            } else {
                await executeTrimming(api, context);
                await executeCompaction(api, context);
            }

            // EXACTLY ONE WRITE, from one pass. `calls` records every mutation control, so a
            // second pass that planned the same unit again would append a second
            // `setIncluded:1:false` here — and a pass that touched the thinking axis would add a
            // `setReasoningIncluded:*`. Neither happens: each pass reads the LIVE unit flag
            // (`context-pruning.groupUnits` → `unit.included`, and `planTrimmedUnits` step (1)),
            // so the second one finds the unit withheld and proposes nothing.
            expect(calls).toEqual(['setIncluded:1:false']);

            // The unit is withheld (the leader here — the runtime's `writeIncluded` cascade takes
            // the results, src/harness.ts ~8523), and its resolver is untouched.
            expect(entries[1].included).toBe(false);
            expect(entries[3].included).toBe(true);
            expect(entries[4].included).toBe(true);

            // EXACTLY ONE pass report, from the pass that acted, and no line at all from the
            // other. A double report would be the visible half of a double write.
            expect(diagnostics).toHaveLength(1);

            if (order === 'compaction-first') {
                // Byte-exact, and the `~236` figure is the one pinned for this fixture above.
                expect(diagnostics[0].message).toBe(
                    'context-compaction withheld 1 superseded tool unit(s), ' +
                        '~236 estimated tokens (mode exclude): #1 msg-2 [failed] answered by msg-4'
                );
            } else {
                // The trimmer's shipped line shape: the unit, its outcomes, the names it called
                // and what answered them (src/plugins/context-trimmer.plugin.ts ~1443).
                expect(diagnostics[0].message).toBe(
                    'context-trimmer withheld 1 superseded tool unit(s): ' +
                        '#1 msg-2 [failed] read answered by msg-4'
                );
            }
        }
    });

    it('leaves exactly one withholding pass when both built-ins are active in a real round', async () => {
        const stateChanges: HarnessStateChangeEvent[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const { writer, threadId } = await overlapRun({
            provider: bothPassesAt(BOTH_PASS_SETTINGS),
            stateChanges,
            diagnostics,
            seen
        });

        // ONE pass withheld anything, and it is the compactor's — dispatch order, not a contest.
        const withheld = diagnostics.filter((event) =>
            event.message.includes('superseded tool unit(s)')
        );

        expect(withheld).toHaveLength(1);
        expect(withheld[0].owner).toBe('context-compaction');
        expect(withheld[0].message).toContain('withheld 1 superseded tool unit(s)');
        // The trimmer ran in the same round (it is ENABLED here, unlike every other case in this
        // file) and reported nothing, because it had nothing to write.
        expect(diagnostics.some((event) => event.owner === 'context-trimmer')).toBe(false);

        // Canonical state: exactly the failed unit — leader plus the cascaded result — and
        // nothing else.
        const flagged = writer
            .threadMessages(threadId)
            .map((message, index) => ({ index, role: message.role, included: message.included }))
            .filter((entry) => entry.included === false);

        expect(flagged).toEqual([
            { index: 1, role: 'assistant', included: false },
            { index: 2, role: 'tool', included: false }
        ]);

        // And the request that went out is pair-clean with only the answer in it (the same
        // T3.4-style oracle the three-unit case uses).
        const request = seen[seen.length - 1].messages;
        const offered: string[] = [];
        const answered: string[] = [];

        for (const message of request) {
            if (message.role === 'assistant') {
                for (const call of (message as { toolCalls?: { id: string }[] }).toolCalls ?? []) {
                    offered.push(call.id);
                }
                continue;
            }

            if (message.role === 'tool') answered.push((message as { toolCallId: string }).toolCallId);
        }

        expect({ offered, answered }).toEqual({ offered: ['c2'], answered: ['c2'] });

        // The persistence profile of ONE withholding pass: the host seed write, the run's user
        // append, ONE coalesced `agent_message` for the round's writes, and the committed answer.
        // A second pass that wrote flags would still batch into that same round, so this number
        // is not the discriminator by itself — it is what proves the trimmer added no write of
        // its own to a round that already had one.
        expect(stateChanges.filter((event) => event.reason === 'agent_message')).toHaveLength(4);

        // THE CONTROL: the identical conversation with the trimmer seeded off (the `settingsOf`
        // posture every other case in this file uses). Flags and pass line are identical, which
        // is the operational statement of the ratified answer: enabling the trimmer neither adds
        // a second eviction nor changes which units the eviction lands on for this shape.
        const controlChanges: HarnessStateChangeEvent[] = [];
        const controlDiagnostics: HarnessDiagnosticEvent[] = [];

        const control = await overlapRun({
            provider: settingsOf(BOTH_PASS_SETTINGS),
            stateChanges: controlChanges,
            diagnostics: controlDiagnostics,
            seen: []
        });

        expect(
            control.writer
                .threadMessages(control.threadId)
                .map((message, index) => ({ index, role: message.role, included: message.included }))
                .filter((entry) => entry.included === false)
        ).toEqual(flagged);
        expect(
            controlDiagnostics.filter((event) => event.message.includes('superseded tool unit(s)'))
                .map((event) => event.message)
        ).toEqual(withheld.map((event) => event.message));
        expect(controlChanges.filter((event) => event.reason === 'agent_message')).toHaveLength(4);
    });
});

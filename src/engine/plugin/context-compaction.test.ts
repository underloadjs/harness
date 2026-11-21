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
//      window)` MINUS the headroom buffer, where the buffer comes off WHICHEVER number binds
//      (X2, F3 — a bare `contextLimit` gets exactly the same working room as a declared model
//      window, because it is the operator's GUESS at that window and the summarize request
//      (whole projection + the 1,752-byte instruction) has to fit under the model's real one;
//      `headroomRatio: 0` is the documented opt-out, and every fixture here seeds it so each
//      case measures its own rule) — including the `modelLimits` JSON map (per-model
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
//      model, the failed-run park lift, the flag that survives the commit, the phase guard,
//      and the restart persistence of everything the pass wrote; and the same flow driven
//      through the SHIPPED transport, where the size refusal is a gateway SSE frame rather
//      than a scripted event, so the transport's classification, the one-attempt retry rule
//      and the `run.failed` payload the reactive arm reads are all under test together.
//
// Two levels of test, deliberately: the guard factory is exercised with fakes, where the
// token estimates are exact inputs and every control is observable; the shipped built-in
// is then exercised through a REAL harness with a scripted transport, where the estimate
// comes from the harness itself (core/payload-bytes.ts prices the serialized request,
// core/context-estimate.ts divides it by 4, and src/harness.ts:12406-12410 + :12512-12533 fold in
// the bytes of the declared tool schema — the `CATALOGUE` constant below) plus real
// `thread.paused` / `thread.resumed` events and real roster statuses. The integration
// numbers are derived from that documented pipeline, not reverse-engineered from a run.
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
//                                               the model the run is about to send; and
//                                               `isContextOverflowFailure`, the one-attempt rule
//                                               the wire-level case below counts fetches against
//   - ../transport/openai.ts                   — the in-stream error frame the wire-level case
//     ../transport/provider-timeouts.ts        feeds the harness; `isContextOverflowSignal`
//                                               (the ONE matcher, in the second file) is what
//                                               puts `code: 'context-overflow'` on that frame
//   - ../transport/models.ts                  — checked as a window source and REJECTED: it
//                                               returns `string[]` (ids only), so the
//                                               provider's per-model context length never
//                                               reaches the harness, and the `modelLimits`
//                                               map's `window` is the only one in this build
//   - ../harness.plugin.test.ts               — the transport helpers mirrored below

import { describe, expect, it, vi } from 'vitest';
// `CONTEXT_OVERFLOW_CODE` is imported rather than copied: these cases arm the machine with the
// SAME spelling the transport and the agent's pre-request floor publish, so a drift between the
// plugin's local literal and the shipped code fails here instead of silently un-arming it.
// `openAICompatible` is for ONE case only — the end-to-end refusal below, which runs the real
// wire transport so the gateway frame, the shared matcher, the retry ladder and the `run.failed`
// payload are all in the frame together.
import { CONTEXT_OVERFLOW_CODE, agent, harness, openAICompatible, tool } from '../index';
import type {
    Agent,
    Harness,
    HarnessAssistantMessage,
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
} from '../index';
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
    planCompactionRequest,
    planCompactionRetention,
    resolveContextHeadroom,
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

// A projection that carries the weight a fake `estimatedTokens` CLAIMS — the honesty rule the
// shrink ladder depends on (X1, 2026-11-17, the size-refusal deadlock).
//
// The pairing is not cosmetic. `beginSummarize` derives the request's irreducible FLOOR as
// `max(0, estimatedTokens - measureBody(context.messages))` (X2, F1 — `measureRequestFloor` adds
// the projection's media term back onto the harness figure before subtracting, so the currency
// matches on both sides), and `turnBefore`'s dead-run guard
// refuses a summarize pass when that floor is at or above the ceiling. A fake that hands over a
// 2-token `'question'` projection and a hand-written `estimatedTokens: 400` is therefore a fake
// whose request is 398 tokens of tool catalogue and 2 tokens of transcript — a request where no
// amount of clipping can help, and the pass is (correctly) refused. Most cases in this file mean
// the opposite: THE TRANSCRIPT IS THE REQUEST, which is exactly what a host with no tools and no
// media measures, and that is what this helper states.
//
// The arithmetic is the estimator's own, not a guess: `transcriptChars` prices a plain user entry
// at its `content` bytes and nothing else (no framing, no role text), so `tokens * 4` ASCII
// characters is `tokens` tokens EXACTLY, and `floor` comes out 0. A case that genuinely wants a
// catalogue-dominated request says so by passing `messages` explicitly with a projection far
// below its estimate, and asserts the refusal (`turnBefore`'s `unreachable-target` report).
const turnProjection = (tokens: number): HarnessMessage[] => [
    { role: 'user', content: 'q'.repeat(tokens * 4) }
];

type FakeApi = {
    api: HarnessPluginApi;
    // Everything the api was asked to do, in order (settings reads included).
    touches: string[];
    // T4.5 — every diagnostic the action reported, in order.
    diagnostics: HarnessPluginDiagnosticReport[];
    // The live agent registry the trigger reads the model id from. Mutable by identity:
    // `api.agents` is this same object, so a test can register a brain between turns.
    agents: Record<string, Agent>;
    // C1 — the display lanes the fake api holds, keyed by thread id (an absent thread is
    // lane 0). Asserted directly by the lane cases below.
    lanes: Map<string, number>;
    // ...or makes every lane WRITE refuse, reads included stay working, so a case can prove
    // a refused lane write costs a compaction nothing but a diagnostic.
    failLanes: (value: boolean) => void;
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
// NO headroom is seeded, and none is needed: the fake never declares a model WINDOW unless a
// test names one in `modelLimits`, and the 2026-11-17 buffer is keyed on exactly that. So every
// trigger number in this file is still the stored `contextLimit` itself unless a `modelLimits`
// entry says otherwise — the one ruling (an operator budget is the firing point the operator
// typed) that the buffer deliberately leaves alone.
const createFakeApi = (
    limit: number,
    stored: Record<string, number | string | boolean | undefined> = {},
    agents: Record<string, Agent> = {}
): FakeApi => {
    const touches: string[] = [];
    const diagnostics: HarnessPluginDiagnosticReport[] = [];
    // C1 — the lane state, and the switch that makes writes refuse (see `FakeApi`).
    const lanes = new Map<string, number>();
    let failLanes = false;

    // `mode: 'exclude'` is seeded because nearly every case in the guard/action blocks below
    // pins the PRUNING lifecycle — the park/action/resume triple, the flag writes, the pass
    // report — and that pass only runs in `exclude` mode now that `summarize` is the declared
    // default. A case that wants the summarize flow stores the mode explicitly, so the two
    // flows never measure each other.
    //
    // `headroomRatio: 0` is seeded for the same reason, since X2 (F3): the buffer now comes off
    // EVERY binding ceiling, so a fixture that stores `contextLimit: 250` and no ratio fires at
    // 125, not 250, and every hand-derived ceiling, `REGROWTH_RATIO` margin and "under the limit"
    // premise in this file would have to be re-typed as half its value. Zero is the documented
    // opt-out ("fire exactly at the number the operator typed"), which keeps each case a
    // measurement of ITS OWN rule — the trigger rules, the ladder, the machine — rather than a
    // measurement of the buffer. The buffer is pinned where it belongs, in the
    // `resolveContextHeadroom` / `resolveContextTrigger` tables below, by cases that store the
    // ratio they are talking about, and in the summarize-flow cases named
    // `withHeadroom`/`summarizeAt` that run the declared 0.15 on purpose.
    const values: Record<string, unknown> = {
        mode: 'exclude',
        headroomRatio: 0,
        contextLimit: limit,
        ...stored
    };

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
            resume: () => skip('threads.resume'),
            // C1 — the DISPLAY LANE pair. Backed by a real map (not `skip`), because a
            // summarize pass now bumps the lane as part of starting, and a fake that threw
            // would silently turn every summarize case into a "the lane write failed" case.
            // The values are asserted case by case below; `touches` still records every read,
            // so "the exclude pass never touched a lane" stays provable.
            getContextLane: (threadId) => {
                touches.push(`threads.getContextLane:${threadId}`);
                return lanes.get(threadId) ?? 0;
            },
            setContextLane: (threadId, lane) => {
                touches.push(`threads.setContextLane:${threadId}:${lane}`);

                if (!Number.isInteger(lane) || lane < 0) {
                    throw new TypeError(`Context lane must be an integer >= 0; received ${lane}.`);
                }

                if (failLanes) {
                    throw new Error('the lane store refused the write');
                }

                // CANONICAL SHAPE, mirrored from the real store (src/harness.ts
                // `setThreadContextLane`): lane 0 is what ABSENCE already means, so a write
                // of 0 clears the key instead of storing it. The revert paths rely on this —
                // a fake that kept `0` in the map would report "the phantom row is still
                // there" for a lane the harness would have dropped.
                if (lane === 0) lanes.delete(threadId);
                else lanes.set(threadId, lane);

                return {
                    id: threadId,
                    agent: 'writer',
                    origin: 'host',
                    status: 'idle',
                    sequence: 1,
                    ...(lane === 0 ? {} : { contextLane: lane })
                };
            }
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
        lanes,
        failLanes: (value: boolean) => {
            failLanes = value;
        },
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
    // THE REQUEST CAPTURE (2026-11-17, the shrink ladder). `setTranscript` and `replaceHistory`
    // keep recording their names in `calls` — every existing sequence pin depends on that — but
    // a case that measures WHAT went out (a shrunk summarize request, a canonical history that
    // must stay whole) needs the arrays, and a case that does not pass these arrays changes
    // nothing about the fake.
    requests?: HarnessMessage[][];
    histories?: HarnessMessage[][];
    // THE PROJECTION this boundary sees. Default is the one-entry `TURN_MESSAGES` every
    // action case uses; a shrink case names the transcript it wants cut, because the request
    // the plugin builds is `messages + instruction` and the ladder's budget is measured over
    // exactly that list.
    messages?: readonly HarnessMessage[];
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
        messages: input.messages ?? TURN_MESSAGES,
        estimatedTokens: input.estimatedTokens,
        signal: new AbortController().signal,
        api: input.api,
        setTranscript: (messages) => {
            input.calls.push('setTranscript');
            input.requests?.push(messages.map((message) => ({ ...message })));
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
        replaceHistory: (messages) => {
            input.calls.push('replaceHistory');
            input.histories?.push(messages.map((message) => ({ ...message })));
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
// so a skipped round still stops at two reads. `headroomRatio` is read LAST in the group —
// after the mode decision and the summarize phase guard — because it only feeds
// `resolveContextTrigger`, and a round that returns early (a pass already in flight) must not
// pay for it. It is a DECLARED row (see `metadata.settings`), and a fixture that does not seed
// it lands on the declared default 0.15 — the SAME number the read-site fallback answers, which
// is why no trigger figure in this file moves either way. `minTokens` is deliberately NOT here:
// in summarize mode it is a floor consulted only on a turn that is already over the limit, so
// an under-limit turn never pays for it (pinned by the floor case below).
const TRIGGER_READS = [
    'settings.boolean:enabled',
    'settings.number:contextLimit',
    'settings.string:modelLimits',
    'settings.string:mode',
    'settings.number:headroomRatio'
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

// No `instruction`, so the agent has no instruction blocks and the transcript term of the
// estimate is exactly ceil(sum of message content payload bytes / 4) (core/context-estimate.ts).
const brain = (stream: HarnessStream) => agent({ model: 'merge/ds4-flash', stream });

// ---------------------------------------------------------------------------
// THE TOOL-CATALOGUE FLOOR — the constant every HARNESS-LEVEL number here carries
// ---------------------------------------------------------------------------
// `turn.before`'s `estimatedTokens` prices the tool schemas of the request into the figure on
// the UNANCHORED leg (src/harness.ts:12512-12533 passes `toolSchemaChars: toolSchemaBytes()`,
// and `core/context-estimate.ts:421` `toolSchemaPayloadBytes` serializes them). A fixture that
// never asks for a tool still declares the catalogue the harness preloads, so a harness-level
// estimate is NEVER the transcript alone — it is `CATALOGUE + transcript`, and every token
// literal below is written that way instead of as one magic number, so a future change to the
// preset catalogue moves the constant and stays legible.
//
// THE FIGURE, derived rather than read back. `brain()` declares no tools and the harness is
// built without `presets: false`, so the catalogue is the shipped preset set plus the runtime
// set: 11 entries — `toolRequest` 2,396 B, `tasks` 10,224 B, `read` 4,249 B, `write` 2,202 B,
// `edit` 5,294 B, `glob` 3,618 B, `grep` 5,417 B, `threadList` 3,818 B, `threadRead` 7,476 B,
// `threadSend` 4,515 B, `threadDelete` 3,929 B = 53,128 serialized bytes
// (`toolSchemaPayloadBytes(request.tools)` of a live request; probe
// `Temp/coding-w1/probe-compaction-floor.ts`, reproduced by
// `Temp/coding-w2/probe-delegation-floor.ts`, and RE-MEASURED 2026-11-18 for the rank-model
// entry/rank vocabulary). The +40 bytes against the figures this header carried before are the
// rank rewording of the `toolRequest` description (+28 B) and of `threadDelete` (+12 B):
// `core/context-estimate.ts` and `plugin/context-compaction.plugin.ts` are byte-identical, so the
// estimator moved not one line — only the model-facing declaration text grew. 53,128 / 4 = 13,282
// tokens EXACTLY.
//
// THE OTHER MOVEMENT IN THE SAME DIRECTION, and every `+1`/`+9` delta below comes from it: since
// T5 (2026-11-17) the estimator counts SERIALIZED PAYLOAD BYTES (`core/payload-bytes.ts`
// `modelPayloadBytes`) rather than characters (`core/context-estimate.ts:378-495`). An all-ASCII
// fixture is unchanged byte for byte, and a fixture whose text carries an escape is not: the clip
// marker's `…` is 3 bytes (27 characters → 29 bytes), the 1,714-character `COMPACTION_INSTRUCTION`
// is 1,752 bytes, a JSON `arguments` string pays one extra byte per quote, and an attachment's
// `name` AND `mime` are both counted now (the `mimeType`/`mime` mismatch this file used to pin as
// a bug is fixed at `core/context-estimate.ts:479-490`). Those figures are derived in the comment
// that pins each one; they are arithmetic, not drift.
//
// WHY THE ADDITION IS EXACT, which is what lets a pin stay `CATALOGUE + n`. The catalogue byte
// count is a multiple of 4, so `ceil((53128 + transcriptBytes) / 4)` = 13,282 +
// `ceil(transcriptBytes / 4)`: the transcript figure every comment in this file already derives
// keeps its exact value and simply rides on top of the constant. The same holds for the trigger
// arithmetic, and that is what keeps the fixtures honest — the effective limit, the
// `REGROWTH_RATIO` margin (`max(1, floor(effective * 0.05))`) and every "under the limit" premise
// below are keyed on the SAME figure, so a case whose point is "this conversation is smaller than
// the ceiling" states its ceiling as `CATALOGUE + <the transcript budget it was written against>`
// and a case whose point is "this conversation crossed" keeps its transcript-scale ceiling and
// moves only the reported estimate.
//
// TWO THINGS THIS CONSTANT IS SINCE X1 (2026-11-17), and both are why the wording above says
// "the floor". It is also the number the shrink ladder measures AGAINST: `beginSummarize` derives
// the request's irreducible size as `estimatedTokens − measureBody(messages)` (X2, F1 — the media
// term the harness figure never priced is added back before the subtraction, see
// `measureRequestFloor`), and `turnBefore` refuses a summarize pass when that figure is at or
// above the ceiling — so a case whose ceiling is
// BELOW `CATALOGUE` is a case where no compaction can ever run, and it measures the refusal rather
// than a pass (the `minTokens` case at :4599 moved to `CATALOGUE + 100` for exactly that reason).
// And it is the floor of the WRITER-ONLY ROSTER only: a roster with a delegating agent registers
// the runtime's `delegate` tool as well, 7,702 more serialized bytes, so that harness's catalogue
// is 60,830 bytes = 15,207.5 tokens — NOT a multiple of 4 any more, so the delegate case rounds
// that floor UP to 15,208 (probe `Temp/coding-x1/probe-x6.ts`, re-measured 2026-11-18: the +346
// bytes against the 60,484 this header carried is the rank rewording of the `delegate` entry
// (+306 B) plus the same +40 this constant already carries). The delegate case uses
// `DELEGATE_FLOOR`, not this constant, and says so.
const CATALOGUE = 13_282;

// The settings an operator would type in the Plugins pane, as a stored document. Every key
// this plugin reads may appear; anything it does NOT store falls back to its DECLARED
// default, which is what the default-floor case below depends on.
//
// `headroomRatio: 0` IS seeded, since X2 (F3) removed the window precondition: the buffer now
// comes off EVERY binding ceiling, so a fixture that stores `contextLimit: 250` and says nothing
// about the buffer fires at 125, and every hand-derived ceiling, `REGROWTH_RATIO` margin and
// "under the limit" premise in this file would have to be re-typed as half its value. Zero is the
// documented opt-out ("fire exactly at the number the operator typed"), which keeps each case a
// measurement of ITS OWN rule. The buffer itself is pinned by the tables above and by the cases
// that spell the ratio they are talking about (`withBuffer`, or a stored `headroomRatio`).
//
// `context-trimmer` (R5, the other shipped `turn.before` context pass) is seeded OFF here,
// exactly as src/server/persistence.test.ts does for its compaction fixture. Its rule is a
// superset of compaction's (tool NAME match, no token floor, no cooldown), so left at its
// declared default it runs its own pass on these transcripts — in the `withoutCompaction`
// control arm, and even in an arm where compaction's `minTokens` floor refuses the pass.
// Turning it off keeps every case below a measurement of ONE plugin, which is what this
// file's header claims; no expectation changes as a result.
const settingsOf = (values: Record<string, number | string | boolean>): HarnessPluginSettingsProvider => {
    // The same opt-out `createFakeApi` seeds, and for the same reason (X2, F3): every ceiling in
    // this file is hand-derived against the number the operator typed. A case that wants the
    // buffer uses `withBuffer` (or stores `headroomRatio` itself) and says so.
    const stored: Record<string, number | string | boolean> = { headroomRatio: 0, ...values };

    return {
        get: (plugin, key) => {
            if (plugin === 'context-trimmer' && key === 'enabled') return false;

            return plugin === 'context-compaction' ? stored[key] : undefined;
        }
    };
};

// The one-key spelling: just the limit.
const limitAt = (value: number): HarnessPluginSettingsProvider => settingsOf({ contextLimit: value });

// THE UN-OPTED-OUT SPELLING (X2, F3): the limit and NOTHING about the buffer, so the declared
// 0.15 default applies and the firing point is the ceiling minus the buffer. Only the cases that
// are ABOUT the buffer use this, and their expectations state the buffer's arithmetic.
const withBuffer = (value: number): HarnessPluginSettingsProvider =>
    settingsOf({ contextLimit: value, mode: 'exclude' });

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
        // R4's per-model map beside the limit it modifies, plus the 2026-11-17 `headroomRatio`
        // row beside the window fact it reads (declared by T4 on 2026-11-17, so the Plugins pane
        // shows it and a stored `0` is an operator-visible opt-out). The numbers below ARE the
        // ratified answers (T0 Q2's floor, Q3's horizon, the operator's 2026-11-10 one-number
        // ruling on the limit, and the 15%/16k/half-window buffer of the 2026-11-17 deadlock fix
        // — `max: 0.5` is that last rule's own cap, and it is pinned row-for-row in
        // ./manifest.test.ts, ../harness.plugin.test.ts and ../server/plugins-api.test.ts rather
        // than in this 5-tuple), and each default is duplicated as a fallback constant beside the
        // plugin's own reads — a drift between the two changes one of the assertions in this file.
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
            ['headroomRatio', 'number', 0.15, 0, 0.01],
            ['enabled', 'boolean', true, undefined, undefined],
            ['minTokens', 'number', 200, 0, 50],
            ['safetyTurns', 'number', 6, 0, 1],
            ['mode', 'string', 'summarize', undefined, undefined]
        ]);

        // The 2026-11-12 settings-pane cleanup: the panel is label + input only, so NO
        // descriptor carries a help paragraph. src/frontend/main.ts:8967 renders the hint
        // paragraph only when `description` is present, so absence is the whole contract —
        // asserting it here means reintroducing a paragraph is a reviewed edit, not drift.
        for (const setting of metadata.settings ?? []) {
            expect(setting.description).toBeUndefined();
        }

        // The plugin-level description is the only prose the panel shows, so it is pinned
        // EXACTLY (not by substring): one sentence, what the plugin does, nothing else.
        expect(metadata.description).toBe(
            'Compacts the thread context when the conversation reaches a configured token threshold.'
        );

        // 2026-11-12: the panel also shows the PROMPT, read-only. `metadata.systemPrompt`
        // DUPLICATES `COMPACTION_INSTRUCTION` because `metadata` is a plain object literal and
        // the constant is declared after it (temporal dead zone) — not because the manifest
        // scanner forbids a computed value. THIS is the pin that keeps the two copies from
        // drifting silently: identity against the constant the plugin actually commits into
        // the transcript, byte for byte, marker and em dashes and newlines included. (The
        // constant's own wording is pinned by the marker/`Do not call tools` assertions at the
        // bottom of this file, so this one assertion is the whole drift guard for the copy in
        // `metadata`.)
        expect(metadata.systemPrompt).toBe(COMPACTION_INSTRUCTION);

        // The contract's cap, pinned in-repo: `PluginSummary.system_prompt` declares
        // `maxLength: 2000` (src/server/harness.swagger.yaml), and nothing enforces that at
        // runtime — src/server/api.ts `pluginRowOf` spreads the declared value out as-is — so
        // the budget is asserted here instead. The identity above covers both copies with this
        // one check. The shipped prompt is 1714 characters and 21 lines (the OpenCode checkpoint
        // template adopted 2026-11-12), so an operator-visible reword still has about 285
        // characters of room; a text that crossed 2000 would otherwise ship a row the spec calls invalid.
        expect(COMPACTION_INSTRUCTION.length).toBeLessThanOrEqual(2000);

        // The DECISIONS the deleted per-setting prose used to carry are still pinned, just
        // as behaviour rather than as wording, so dropping the text pins cost no coverage.
        // They are named by TEST, not by line number, because lines move every time this file
        // grows and a stale number misroutes the next reader:
        //   - "the limit IS the firing point, no headroom"  -> the trigger table below,
        //     `fires exactly at the global ceiling — the limit IS the firing point` (an
        //     operator ceiling; a declared model window gets the buffer, pinned by
        //     `buffers a declared window by 15% with a 16k floor and a half-window cap`)
        //   - "a malformed modelLimits value is IGNORED"    -> `ignores malformed modelLimits
        //     JSON instead of throwing`
        //   - "annotate behaves as exclude"                 -> `degrades an unimplemented mode
        //     to exclude and reports both`, which pins the diagnostic SUBSTRING
        //     `mode exclude, setting mode annotate` (`toContain`) and the data pair
        //     `{ mode: 'exclude', requestedMode: 'annotate' }` (`toMatchObject`) — the clause
        //     and the fields, not the whole rendered message.

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
//     ceiling   = window is declared ? min(resolved, window) : resolved
//     windowed  = window is declared AND window <= resolved   (the window BINDS)
//     buffer    = windowed ? min(max(16000, floor(ceiling * 0.15)), floor(ceiling / 2),
//                               ceiling - 1)
//                 : 0
//     trigger   = max(1, floor(ceiling) - buffer)
//
// rather than read back out of a run, so a change in the rule fails loudly here.
//
// THE BUFFER IS THE 2026-11-17 HEADROOM RULE (the compaction deadlock). It exists so the
// request that carries the ~430-token compaction instruction is not itself past the point the
// provider refuses at — until it existed, the pass that was supposed to relieve the pressure
// was the first thing refused. It applies ONLY when a declared model window is the BINDING
// number: `contextLimit` and `modelLimits[model].limit` are operator budgets, i.e. firing
// points somebody typed on purpose, and they still fire at exactly the number typed (the
// `limit: 50`, `contextLimit: 100000` and `window: 1000000` rows below pin that half). The
// buffer's floor is 16000 tokens of working room and its cap is half the window, so a small
// declared window compacts at the midpoint instead of collapsing to 1 token.
// `headroomRatio: 0` opts out and reproduces the one-number ruling byte-for-byte, which is
// what the dedicated opt-out case below pins.
// ---------------------------------------------------------------------------

describe('context-compaction trigger math (parseModelLimits + resolveContextTrigger)', () => {
    // Shorthand for the common call: no per-model facts, no model in play.
    const globalOnly = (contextLimit: number) => resolveContextTrigger({ contextLimit, modelLimits: {} });

    it('buffers the global ceiling too — a bare `contextLimit` gets the same leeway (F3)', () => {
        // 200000 fires at 170000. The map names a DIFFERENT model: a window declared for one
        // model must not cap another model's conversation, which is why `window` is absent
        // from the answer — and its absence no longer means "no buffer". X2 (F3) removed the
        // windowed-only gate because the deployment that actually died declared no window at
        // all and therefore fired at the ceiling EXACTLY, so the first crossing was the
        // refusal. Here: max(16000, floor(200000 * 0.15) = 30000) = 30000, under the half-window
        // cap of 100000, so the firing point is 170000.
        expect(
            resolveContextTrigger({
                contextLimit: 200000,
                modelLimits: parseModelLimits('{"other/model": {"window": 131072}}'),
                modelId: 'openai/gpt-4o'
            })
        ).toEqual({ limit: 200000, effective: 170000 });

        // The 16000 floor binds below a 106667 ceiling, and the 50% cap takes over below 32000:
        // these are the two shapes every small deployment lands on.
        expect(globalOnly(100000)).toEqual({ limit: 100000, effective: 84000 });
        expect(globalOnly(1000)).toEqual({ limit: 1000, effective: 500 });

        // `headroomRatio: 0` is still the documented opt-out, and it restores the one-number
        // ruling byte for byte — the behaviour every other fixture in this file seeds.
        expect(
            resolveContextTrigger({ contextLimit: 1000, modelLimits: {}, headroomRatio: 0 })
        ).toEqual({ limit: 1000, effective: 1000 });
    });

    it('takes the per-model limit in place of the global ceiling', () => {
        const modelLimits = parseModelLimits('{"fast/small": {"limit": 50}}');

        // The model named in the map gets its own ceiling — and the same buffer over it,
        // because since F3 the buffer is keyed on the BINDING ceiling, not on which settings key
        // supplied it: 50 − min(max(16000, 7), min(25, 49)) = 50 − 25 = 25.
        expect(
            resolveContextTrigger({ contextLimit: 100000, modelLimits, modelId: 'fast/small' })
        ).toEqual({ limit: 50, effective: 25 });

        // ...and every other model keeps the global one, buffered as the global one is.
        expect(
            resolveContextTrigger({ contextLimit: 100000, modelLimits, modelId: 'big/model' })
        ).toEqual({ limit: 100000, effective: 84000 });
    });

    it('caps the ceiling at the model window — the operator\'s 512k-on-a-256k-model case', () => {
        const modelLimits = parseModelLimits('{"wide/model": {"window": 262144}}');
        const resolved = resolveContextTrigger({
            contextLimit: 512000,
            modelLimits,
            modelId: 'wide/model'
        });

        // The window BINDS (262144 < 512000), so it is both the cap AND the number the headroom
        // buffer is measured against: max(16000, floor(262144 * 0.15) = 39321) = 39321, capped
        // at half the window (131072) — the cap does not bind — so the firing point is
        // 262144 − 39321 = 222823. `window` is still reported so a caller can see WHY the
        // number moved, and `limit` is still the un-capped ceiling.
        expect(resolved).toEqual({ limit: 512000, window: 262144, effective: 222823 });

        // The same answer when the operator spells the ceiling on the entry as well: the
        // window caps it either way, and it is the cap that gets the buffer either way.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"wide/model": {"limit": 512000, "window": 262144}}'),
                modelId: 'wide/model'
            })
        ).toEqual({ limit: 512000, window: 262144, effective: 222823 });

        // And the pre-buffer rule, spelled: `headroomRatio: 0` is the documented opt-out, and
        // it lands on exactly the number this case expected before the buffer existed.
        expect(
            resolveContextTrigger({
                contextLimit: 512000,
                modelLimits,
                modelId: 'wide/model',
                headroomRatio: 0
            })
        ).toEqual({ limit: 512000, window: 262144, effective: 262144 });
    });

    // The buffer rule on its own, so every clause of it has a row: the 16000 floor, the
    // half-ceiling cap, the `ceiling - 1` clamp, the fact (X2, F3) that an operator budget is
    // buffered exactly like a declared window, and the three ways a ratio says "no buffer".
    it('buffers the binding ceiling by 15% with a 16k floor and a half-ceiling cap', () => {
        // A real model window: the ratio is larger than the floor, so the ratio answers.
        expect(resolveContextHeadroom({ ceiling: 262144, windowed: true })).toBe(39321);
        expect(resolveContextHeadroom({ ceiling: 200000, windowed: true })).toBe(30000);
        // A window the floor is generous for: 16000 of working room, not 4800.
        expect(resolveContextHeadroom({ ceiling: 32000, windowed: true })).toBe(16000);
        // A small window: the half-ceiling cap is what keeps the trigger off 1 token. Without
        // it this would be `max(1, 8192 - 16000) = 1` — a conversation that compacts on every
        // turn, i.e. the fix becoming the bug.
        expect(resolveContextHeadroom({ ceiling: 8192, windowed: true })).toBe(4096);
        expect(resolveContextHeadroom({ ceiling: 100, windowed: true })).toBe(50);
        // A ceiling with room for nothing.
        expect(resolveContextHeadroom({ ceiling: 1, windowed: true })).toBe(0);
        expect(resolveContextHeadroom({ ceiling: 0, windowed: true })).toBe(0);
        // THE FLAG IS NOT THE SWITCH (X2, F3). A `contextLimit` with no `modelLimits` entry is
        // not an exact number: it is the operator's guess at the model's window, and the
        // request the pass sends (transcript + the ~1,752-byte instruction) is measured against
        // the provider's real window, so an undecorated budget needs the working room EXACTLY as
        // much as a declared window does. 200000 buffers to 30000 either way, and the rows above
        // keep naming `windowed: true` only because a caller that knows which number bound can
        // say so.
        expect(resolveContextHeadroom({ ceiling: 200000, windowed: false })).toBe(30000);
        expect(resolveContextHeadroom({ ceiling: 200000 })).toBe(30000);
        // The switch is the RATIO: `0` is the documented opt-out and restores "fire exactly at
        // the limit". A ratio that cannot be trusted, or that says no, means no buffer too —
        // never a guess.
        expect(resolveContextHeadroom({ ceiling: 200000, windowed: true, ratio: 0 })).toBe(0);
        expect(resolveContextHeadroom({ ceiling: 200000, windowed: true, ratio: -0.5 })).toBe(0);
        expect(resolveContextHeadroom({ ceiling: 200000, windowed: true, ratio: Number.NaN })).toBe(0);
        expect(
            resolveContextHeadroom({ ceiling: 200000, windowed: true, ratio: Number.POSITIVE_INFINITY })
        ).toBe(0);
        // A ratio ABOVE the cap is the cap, not a runaway: 150% of 200000 is still half of it.
        expect(resolveContextHeadroom({ ceiling: 200000, windowed: true, ratio: 1.5 })).toBe(100000);
        // The floor is a knob a table row can name, including `0` ("pure ratio").
        expect(resolveContextHeadroom({ ceiling: 32000, windowed: true, minTokens: 0 })).toBe(4800);
        expect(resolveContextHeadroom({ ceiling: 32000, windowed: true, minTokens: 20000 })).toBe(16000);
        // A non-finite floor falls back to the module floor rather than to 0.
        expect(
            resolveContextHeadroom({ ceiling: 32000, windowed: true, minTokens: Number.NaN })
        ).toBe(16000);
    });

    // The trigger's own arithmetic with a hand-sized window, so the buffer is visible at the
    // scale every lifecycle case in this file uses (the 262144 row above is the operator's
    // scale; a 500-token conversation is the one a test can actually build).
    it('moves the firing point below a small declared window, and only below that one', () => {
        // 1000 ceiling, 500 window: the window binds, half of it is the cap, so the trigger
        // fires at 250 — a 250-token conversation on a 500-token model is now compaction, and
        // the same conversation against the operator's 1000-token budget is not.
        expect(
            resolveContextTrigger({
                contextLimit: 1000,
                modelLimits: parseModelLimits('{"small/model": {"window": 500}}'),
                modelId: 'small/model'
            })
        ).toEqual({ limit: 1000, window: 500, effective: 250 });

        // The same window DECLARED but not binding (the operator budget is smaller): the budget
        // is the ceiling, and since F3 the buffer comes off WHATEVER binds — the window fact is
        // not a precondition. 300 is small enough that the half-ceiling cap answers: 150.
        expect(
            resolveContextTrigger({
                contextLimit: 300,
                modelLimits: parseModelLimits('{"small/model": {"window": 500}}'),
                modelId: 'small/model'
            })
        ).toEqual({ limit: 300, window: 500, effective: 150 });

        // A per-model LIMIT (no window at all) is the same case from the other side: the model's
        // own hard limit is the binding number, and F3 buffers it like any other ceiling — the
        // summarize request still has to fit under it. 500 − 250 = 250.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"capped/model": {"limit": 500}}'),
                modelId: 'capped/model'
            })
        ).toEqual({ limit: 500, effective: 250 });

        // Equal halves: `window <= limit`, so the model fact is what stops the request and the
        // buffer belongs to it.
        expect(
            resolveContextTrigger({
                contextLimit: 500,
                modelLimits: parseModelLimits('{"even/model": {"limit": 500, "window": 500}}'),
                modelId: 'even/model'
            })
        ).toEqual({ limit: 500, window: 500, effective: 250 });
    });

    it('never lets a window RAISE the ceiling', () => {
        // A generous window on a conservative operator is still the operator's number — the
        // window is a cap, not an override, and `limit` reports the un-capped ceiling either
        // way. WHAT MOVES IS THE BUFFER: since F3 the headroom comes off the binding ceiling,
        // and here the binding ceiling is the operator's 100000 (the window never binds), so the
        // firing point is 100000 − min(max(16000, 15000), min(50000, 99999)) = 100000 − 16000 =
        // 84000. The window's size is irrelevant to that arithmetic, which is the point.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"huge/model": {"window": 1000000}}'),
                modelId: 'huge/model'
            })
        ).toEqual({ limit: 100000, window: 1000000, effective: 84000 });
    });

    it('degrades to the global ceiling when the model is unknown or unresolved', () => {
        const modelLimits = parseModelLimits('{"known/model": {"limit": 1000}}');

        // An id nobody declared simply misses the map. The number that BINDS is still the
        // operator's 100 — that is what this case is about, and F3 does not move it; the 50% cap
        // then takes half of a ceiling that small off it, which the buffer rows above pin.
        expect(
            resolveContextTrigger({ contextLimit: 100, modelLimits, modelId: 'other/model' })
        ).toEqual({ limit: 100, effective: 50 });

        // And a turn whose model could not be read passes `undefined` — the guard's
        // "model unknown" answer, which must mean the global limit, never 0 and never a
        // crash.
        expect(
            resolveContextTrigger({ contextLimit: 100, modelLimits, modelId: undefined })
        ).toEqual({ limit: 100, effective: 50 });
    });

    it('fires as early as it possibly can on a degenerate ceiling, and floors a fractional one', () => {
        // The ONLY clamp in the rule: a ceiling that floors below one token fires at 1
        // rather than never. Rule 1 refuses a limit of 0, so 0.5 is the smallest a host can
        // store and still arm the plugin.
        expect(globalOnly(0.5)).toEqual({ limit: 0.5, effective: 1 });
        expect(globalOnly(1)).toEqual({ limit: 1, effective: 1 });

        // A fractional ceiling floors, so the trigger stays a whole token count: the ceiling is
        // 100, the half-ceiling cap is 50, and the firing point is a whole 50 (an unfloored
        // ceiling would leak the `.9` into the firing point). `limit` keeps the raw stored
        // number, because the trigger's job is to report what the operator typed.
        expect(globalOnly(100.9)).toEqual({ limit: 100.9, effective: 50 });
    });

    // The map comes from a free-text settings field, so EVERY bad shape has to land on "no
    // per-model knowledge" rather than on an error or on a partial guess.
    it('ignores malformed modelLimits JSON instead of throwing', () => {
        for (const raw of ['{', '{"a":', 'not json', '', '   ', '[]', 'null', '"text"', '5', '{}']) {
            expect(parseModelLimits(raw)).toEqual({});
        }

        // And the handler-relevant consequence: the global ceiling still fires the pass —
        // buffered like any other ceiling now that F3 removed the window precondition
        // (100000 − 16000 = 84000); the point of this row is that a malformed map costs the
        // per-model facts and NOTHING else.
        expect(
            resolveContextTrigger({
                contextLimit: 100000,
                modelLimits: parseModelLimits('{"openai/gpt-4o": {"window": 8192},}'),
                modelId: 'openai/gpt-4o'
            })
        ).toEqual({ limit: 100000, effective: 84000 });
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
        ).toEqual({ limit: 100000, effective: 84000 });
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
        ).toEqual({ limit: 100, effective: 50 });
    });
});

// The marker `clipShrinkText` appends, spelled here rather than imported so a reword of the
// plugin has to move this file too. 240 kept + `…` (1 char) + ` [truncated by compaction]`
// (26 chars) = 267 characters per clipped string, which is where every token figure below
// comes from.
const CLIP = '\u2026 [truncated by compaction]';
const clipHead = (text: string): string => `${text.slice(0, 240)}${CLIP}`;

// ---------------------------------------------------------------------------
// 2026-11-17 — THE SHRINK LADDER AND THE OVERFLOW-REACTIVE TRIGGER
//
// THE DEFECT THESE CASES PIN, in one paragraph: the trigger fired AT the ceiling, the
// summarize request was the whole projection PLUS the ~430-token instruction, so the request
// that was supposed to relieve the pressure was strictly larger than the request the provider
// (or `core/agent.ts`'s own `maxPromptTokens` floor) had just refused — and the Rule-3
// re-trigger memory, recorded before the action, muted the retry. Nothing in the machine knew
// a refusal had happened. Three changes, pinned from three directions below: the headroom
// buffer (the trigger-math table above), the overflow-reactive arming and cooldown release
// (the passes block below), and the request shrink (the plan table below, plus one end-to-end
// case in the T9 block that measures the bytes that actually leave).
// ---------------------------------------------------------------------------

describe('context-compaction shrink plan (planCompactionRequest)', () => {
    // The request every case below builds by hand: three head entries (a user turn, an
    // assistant turn that asked for a call and carries 600 characters of replayed thinking, and
    // the tool result answering it) plus the two verbatim tail entries. The counts are the
    // estimator's own — PAYLOAD BYTES, i.e. `content` + tool-call `name` + `arguments` +
    // `reasoning` + result `name`, each priced by `core/payload-bytes.ts` `modelPayloadBytes` —
    // so every expected token figure is derived, never read back:
    //
    //   e0  user      'a' × 1000                                     1000
    //   e1  assistant '' + name 'read' (4) + arguments (1,015: the 1,011
    //       characters of `{"path":"…"}` plus one byte for each of its 4
    //       quotes) + reasoning 'c' × 600                           1619
    //   e2  tool      'e' × 800 + name 'read' (4)                    804
    //   e3  user      'answer me'                                      9
    //   e4  user      'compact now'                                   11
    //                                                              ─────
    //       request total                                           3443  → 861 tokens
    const ARGUMENTS = `{"path":"${'p'.repeat(1000)}"}`;
    const headOf = (): HarnessMessage[] => [
        { role: 'user', content: 'a'.repeat(1000) },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: ARGUMENTS }],
            reasoning: 'c'.repeat(600)
        },
        { role: 'tool', content: 'e'.repeat(800), toolCallId: 'c1', name: 'read' }
    ];
    const tailOf = (): HarnessMessage[] => [
        { role: 'user', content: 'answer me' },
        { role: 'user', content: 'compact now' }
    ];
    const requestOf = (): HarnessMessage[] => [...headOf(), ...tailOf()];

    it('sends the request untouched when the budget already fits', () => {
        // 40 characters is exactly 10 tokens, and 10 is the budget: a plan that has nothing to
        // do reports the input back and says so, so the caller keeps the byte-identical request.
        const messages: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(40) }];

        expect(planCompactionRequest(messages, 10)).toEqual({
            messages,
            dropped: 0,
            clipped: 0,
            tokens: 10
        });

        // One token short of the budget cannot be answered either: the single entry IS the
        // verbatim tail, and the ladder refuses to cut the request it is answering.
        expect(planCompactionRequest(messages, 9)).toEqual({
            messages,
            dropped: 0,
            clipped: 0,
            tokens: 10
        });
    });

    it('clips the head payload before it removes anything, and never touches the tail', () => {
        const plan = planCompactionRequest(requestOf(), 400);

        // 3,443 payload bytes → 861 tokens, over a 400 budget. Pass A alone answers it: every
        // head entry is cut to 240 characters of text plus the 27-character clip marker, the
        // assistant's 600 characters of replayed thinking are gone, its `arguments` are cut, and
        // the tail rides verbatim. In the estimator's own currency the marker is NOT 27 bytes —
        // its `…` is 3 of UTF-8 and its ASCII tail 26, so 29 — which is what makes a clipped
        // entry cost 269 bytes, the assistant's clipped `arguments` 240 characters + 3 escaped
        // quotes + the 29-byte marker = 272, and the tool result's `name` another 4:
        //   269 + (272 + 4) + (269 + 4) + 9 + 11 = 838 → 210 tokens.
        expect(plan).toEqual({
            messages: [
                { role: 'user', content: clipHead('a'.repeat(1000)) },
                {
                    role: 'assistant',
                    content: '',
                    // `reasoning` is DELETED, not emptied: the projection omits the key when the
                    // thinking does not travel, and the estimator follows the key.
                    toolCalls: [{ id: 'c1', name: 'read', arguments: clipHead(ARGUMENTS) }]
                },
                {
                    role: 'tool',
                    content: clipHead('e'.repeat(800)),
                    toolCallId: 'c1',
                    name: 'read'
                },
                { role: 'user', content: 'answer me' },
                { role: 'user', content: 'compact now' }
            ],
            dropped: 0,
            clipped: 3,
            tokens: 210
        });
    });

    it('drops whole pairable units, oldest first, behind one digest entry', () => {
        // A budget pass A cannot reach (30 < 210), so the ladder moves to whole units. The
        // assistant turn and the result answering `c1` go as ONE unit: an orphan tool result is
        // a provider pairing error, and this is the one rule the request rewrite may never
        // break. `dropped: 2` counts UNITS (the user turn, then the tool unit), not entries.
        const plan = planCompactionRequest(requestOf(), 30);

        // The excerpts are the ORIGINAL text of what went missing, cut to the same 240-character
        // budget, oldest first and newest last.
        expect(plan.messages.map((message) => String(message.content))).toEqual([
            `[context compaction digest] The harness removed 2 earlier turns from this request ` +
                `without a model to summarize them, because the request itself did not fit the ` +
                `context window. The removed turns are still on the record; they are simply not ` +
                `being sent. Oldest removed: ${'a'.repeat(240)} | Most recent removed: ${'e'.repeat(240)}`,
            'answer me',
            'compact now'
        ]);
        expect(plan.dropped).toBe(2);
        expect(plan.clipped).toBe(3);
        // What the surviving request weighs, by hand: the digest is 771 characters (291 of
        // marker and prose + the two 240-character excerpts), and the two tail entries are 9 and
        // 11 → 791 bytes (all ASCII, so bytes and characters are one number here) →
        // ceil(791 / 4) = 198 tokens. The clipped head that pass A built (838 payload bytes) is
        // what the drops replaced, so the figure falls as the ladder advances rather than being
        // reported from the rung.
        expect(plan.tokens).toBe(198);
    });

    it('keeps a leading system entry while it drops everything else', () => {
        // A host that seeds a `system` entry stated a standing instruction, and
        // `planCompactionRetention` refuses to silence one for the same reason. Under a budget
        // that removes the whole head, the system entry is still the first thing sent.
        const messages: HarnessMessage[] = [
            { role: 'system', content: 'stay terse' },
            ...headOf(),
            ...tailOf()
        ];

        const plan = planCompactionRequest(messages, 1);

        expect(plan.messages.map((message) => String(message.content))).toEqual([
            'stay terse',
            `[context compaction digest] The harness removed 2 earlier turns from this request ` +
                `without a model to summarize them, because the request itself did not fit the ` +
                `context window. The removed turns are still on the record; they are simply not ` +
                `being sent. Oldest removed: ${'a'.repeat(240)} | Most recent removed: ${'e'.repeat(240)}`,
            'answer me',
            'compact now'
        ]);
        expect(plan.dropped).toBe(2);
    });

    it('stops at the verbatim tail rather than breaking the request it is answering', () => {
        // `keepTail` is not a suggestion: with a budget of 1 the loop removes every head entry
        // and then STOPS, because the last two entries are the turn being answered and the
        // instruction. The plan reports the same size it started from, which is the signal the
        // caller uses to keep the ordinary request instead of pretending a shrink happened.
        const plan = planCompactionRequest(tailOf(), 1);

        expect(plan).toEqual({
            messages: tailOf(),
            dropped: 0,
            clipped: 0,
            tokens: 5
        });
    });

    // THE FLOOR ARGUMENT — every figure above prices a TRANSCRIPT, and the provider bills a
    // REQUEST (X1, 2026-11-17, the size-refusal deadlock).
    //
    // `floorTokens` is the part of the request this ladder cannot remove: the tool catalogue, the
    // agent instructions, the harness turns and the per-call overhead. The shipped caller derives
    // it in `beginSummarize` as `max(0, estimatedTokens - measureShrink(context.messages))`, and
    // `planCompactionRequest` now adds it to EVERY figure it compares, so the rung target and the
    // returned `tokens` are the same quantity — the billed size. The arithmetic below is the
    // rows above plus a constant: 861 transcript tokens and a 1,000-token floor is 1,861 billed,
    // pass A's 210 becomes 1,210 and the digest-and-tail's 198 becomes 1,198.
    //
    // THE CONTRAST IS THE DEFECT. A 1,250-token rung against a 13,282-token catalogue and a
    // 2,438-token transcript (the live session's shape, `Temp/d1/report.md`) used to read "the
    // transcript is already under target", return the request UNCHANGED, and send the identical
    // 400 out on every later turn of the session.
    it('prices the request floor in every comparison, and never reports a rung below it', () => {
        const request = requestOf(); // 3,443 payload bytes = 861 transcript tokens

        // A. The legacy contract, byte-identical: no floor, budget above the transcript, so the
        //    caller keeps the request it came with. Default `floorTokens` is what every call site
        //    that has no host around it (and every case above) uses.
        expect(planCompactionRequest(request, 900)).toEqual({
            messages: request,
            dropped: 0,
            clipped: 0,
            tokens: 861
        });

        // B. THE BUG'S SHAPE, and the fix. Billed 1,861 against a 1,250 rung: the pre-fix
        //    transcript measure read 861 ≤ 1,250 and answered "nothing to do"; the request
        //    measure reads 1,861 > 1,250 and answers with pass A — the clipped head pinned above,
        //    210 transcript tokens plus the 1,000 the transcript pass cannot touch.
        expect(planCompactionRequest(request, 1250, 2, 1000)).toEqual({
            messages: [
                { role: 'user', content: clipHead('a'.repeat(1000)) },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'c1', name: 'read', arguments: clipHead(ARGUMENTS) }]
                },
                { role: 'tool', content: clipHead('e'.repeat(800)), toolCallId: 'c1', name: 'read' },
                { role: 'user', content: 'answer me' },
                { role: 'user', content: 'compact now' }
            ],
            dropped: 0,
            clipped: 3,
            tokens: 1210
        });

        // C. A target the floor alone beats is the OTHER no-op, and it is the case
        //    `turnBefore`'s dead-run guard refuses to spend a pass on: 2,761 billed, 2,800 asked,
        //    nothing the ladder could do about it.
        expect(planCompactionRequest(request, 2800, 2, 1900)).toEqual({
            messages: request,
            dropped: 0,
            clipped: 0,
            tokens: 2761
        });

        // D. A target BELOW the floor: the ladder walks to the bottom and stops at the floor plus
        //    the digest-and-tail it may not go under (1,900 + 198), instead of reporting a number
        //    the provider could not have billed for a request that still carries the whole
        //    catalogue. This is why the caller's adopt test is `plan.tokens < floor + full` and
        //    not `plan.tokens < target`.
        const bottomed = planCompactionRequest(request, 1250, 2, 1900);

        expect(bottomed.dropped).toBe(2);
        expect(bottomed.clipped).toBe(3);
        expect(bottomed.tokens).toBe(2098);

        // E. A hostile floor is "no floor", never `NaN`: the planner normalises it once, so a
        //    caller that cannot price its own request still gets the transcript figure the rows
        //    above pin.
        expect(planCompactionRequest(request, 400, 2, Number.NaN).tokens).toBe(210);
        expect(planCompactionRequest(request, 400, 2, -50).tokens).toBe(210);
    });

    it('measures with attachment bytes, the case the plain estimate calls small', () => {
        // THE POINT OF THE OPT-IN FIGURE (../core/context-estimate.ts, "THE OPT-IN REQUEST
        // WEIGHT"). The plain figure for this entry is 114 payload bytes = 29 tokens: 100 of text
        // plus the attachment's `name` (5) plus its `mime` (9). The MIME term counts NOW: T5 fixed
        // the `mimeType`/`mime` mismatch this file used to pin as a bug, so `mime` wins whenever it
        // is a non-empty string and `mimeType` is the fallback, and exactly ONE of them is billed
        // per attachment (../core/context-estimate.ts:479-490). The SAME entry is
        // 114 + 53,333 characters of base64 = 53,447 once a 40,000-byte screenshot rides on it —
        // base64 is pure ASCII, so its wire width IS its length (`attachmentWireBytes`,
        // ../core/context-estimate.ts:282-305, and it prefers `data` over the `size` derivation):
        // ceil(53447 / 4) = 13,362 tokens. A plugin that measured 29 would re-send the request
        // that was just refused and report success.
        const shot: HarnessMessage[] = [
            {
                role: 'user',
                content: 'x'.repeat(100),
                attachments: [
                    {
                        id: 'a1',
                        kind: 'image',
                        marker: '[Image 1]',
                        name: 'a.png',
                        mime: 'image/png',
                        size: 40000,
                        data: 'A'.repeat(53333)
                    }
                ]
            }
        ];

        // Nothing removable (the single entry IS the verbatim tail), so the plan can only report
        // the honest figure — and the honest figure is what makes the caller keep the request.
        expect(planCompactionRequest(shot, 100)).toEqual({
            messages: shot,
            dropped: 0,
            clipped: 0,
            tokens: 13362
        });

        // The same request one token roomier: untouched, by construction.
        expect(planCompactionRequest(shot, 13362).tokens).toBe(13362);
    });
});

// ---------------------------------------------------------------------------
// THE OVERFLOW-REACTIVE TRIGGER — `run.failed` arms, the next boundary answers
// ---------------------------------------------------------------------------

describe('context-compaction overflow-reactive trigger', () => {
    const runLifecycle = { threadId: 'thread-1', agent: 'writer', depth: 1, input: 'go' };

    // The payload a refusal arrives with. `code` is the contract with the transport
    // (`CONTEXT_OVERFLOW_CODE`, imported from the package root rather than copied, so these
    // cases fail if the plugin's local spelling ever drifts from the published one) and the
    // message is the agent's own pre-request floor text, which the plugin also recognises.
    const refused = (message = 'provider said no'): never =>
        ({ message, code: CONTEXT_OVERFLOW_CODE } as never);

    const down = (message = 'provider down'): never => ({ message } as never);

    // Every turn in this describe is a request whose size IS its transcript: no tool catalogue, no
    // media, so the hand-passed `tokens` and the projection's measured weight are the same number
    // and the plugin derives a floor of 0 (see `turnProjection`). A case that wants the opposite —
    // a catalogue-dominated request the ladder cannot rescue — names its `messages` explicitly and
    // asserts the `unreachable-target` refusal instead.
    const summarizeTurn = (
        fake: FakeApi,
        tokens: number,
        calls: string[],
        extra: { requests?: HarnessMessage[][]; messages?: readonly HarnessMessage[] } = {}
    ): HarnessTurnBeforeContext =>
        createFakeTurn({
            api: fake.api,
            estimatedTokens: tokens,
            currentTokens: tokens,
            calls,
            messages: turnProjection(tokens),
            ...extra
        });

    it('arms on a refusal and compacts on the next boundary even under the trigger', async () => {
        // Limit 250, a 100-token projection: Rule 2 refuses this turn twice in a row, and that
        // is correct — until the provider says the request does not fit.
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];

        await passes.turnBefore(summarizeTurn(fake, 100, calls));
        expect(calls).toEqual([]);
        expect(fake.diagnostics).toHaveLength(0);

        passes.runFailed({ ...runLifecycle, error: refused() });

        // The arm report, exactly — including the rung the next pass will send.
        expect(fake.diagnostics).toHaveLength(1);
        expect(fake.diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            hook: 'run.failed',
            stage: 'overflow',
            rung: 1,
            ladder: 4,
            ratio: 0.85,
            exhausted: false
        });

        const requests: HarnessMessage[][] = [];

        await passes.turnBefore(summarizeTurn(fake, 100, calls, { requests }));

        // THE PASS HAPPENED. Same projection, same settings, one refusal in between: the
        // summarize machine parked the thread and committed its instruction (no `resume` — the
        // park is held until the answer, which is the machine's existing shape).
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        // The request is the projection plus the instruction. With one entry to work with there
        // is nothing to cut, so NO shrink report is made — the ladder reported the same size and
        // the caller kept the ordinary request rather than claiming a saving.
        expect(requests).toEqual([
            [...turnProjection(100), { role: 'user', content: COMPACTION_INSTRUCTION }]
        ]);
        expect(fake.diagnostics.filter((report) => (report.data as { stage?: string })?.stage === 'shrink')).toEqual([]);
    });

    it('cuts the summarize request to the rung, and says so with both numbers', async () => {
        // A projection the ladder can actually cut: 5 × 400 characters of ASCII (2,000 bytes) =
        // 500 tokens, and this fake has no tool catalogue, so 500 IS the estimate the request was
        // refused at. The rung is 0.85 × 500 = 425 — and the rung is then CLAMPED to the 250
        // ceiling (X1, 2026-11-17): 85% of an over-limit size is still over the limit, so an
        // unclamped rung asks the ladder to stop at a number the provider would refuse. The
        // request the pass builds adds the instruction: 2,000 + 1,752 = 3,752 PAYLOAD BYTES = 938
        // billed tokens (the instruction is 1,714 characters but 1,752 bytes — the estimator
        // prices the JSON escaping (`core/payload-bytes.ts`), and this text carries 20 newlines
        // (2 bytes each as `\n`), 16 quotes (2 bytes each) and one em-dash (3 UTF-8 bytes), 38
        // bytes over its length).
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const messages: HarnessMessage[] = [0, 1, 2, 3, 4].map((index) => ({
            role: 'user' as const,
            content: `t${index}${'x'.repeat(399 - String(index).length)}`
        }));

        passes.runFailed({ ...runLifecycle, error: refused() });

        const calls: string[] = [];
        const requests: HarnessMessage[][] = [];

        await passes.turnBefore(
            summarizeTurn(fake, 500, calls, { requests, messages })
        );

        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        // Pass A (4 × 269 + 400 + 1,752 = 3,228 bytes → 807 tokens) does not reach 250 either, so
        // the ladder moves to whole units and removes all four head entries behind ONE digest. The
        // digest is the 291 characters of marker and prose pinned in the planner table above plus
        // the oldest and newest 240-character excerpts of what went missing = 771 characters, all
        // ASCII, so 771 + 400 + 1,752 = 2,923 bytes → 731 tokens. That is still over the 250
        // ceiling — the tail and the instruction are the request, and the ladder may not cut them —
        // which is why the report states both numbers instead of claiming a saving.
        expect(requests[0].map((message) => String(message.content))).toEqual([
            `[context compaction digest] The harness removed 4 earlier turns from this request ` +
                `without a model to summarize them, because the request itself did not fit the ` +
                `context window. The removed turns are still on the record; they are simply not ` +
                `being sent. Oldest removed: t0${'x'.repeat(238)} | Most recent removed: t3${'x'.repeat(238)}`,
            String(messages[4].content),
            COMPACTION_INSTRUCTION
        ]);

        // THE CONTRACT OF THE WHOLE FIX, as a pair of numbers, in ONE currency: the request that
        // goes out is smaller than the one that was refused (so the provider cannot refuse it for
        // the same reason twice), and `to` is compared against a `target` that is a fraction of the
        // same hard ceiling the provider bills against. With no catalogue in this fixture the floor
        // is 0, so the billed figure and the transcript figure are the same number here — the
        // floor-dominated pair lives in the next case.
        const shrink = fake.diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'shrink'
        );

        expect(shrink?.data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            stage: 'shrink',
            target: 250,
            from: 938,
            to: 731,
            floorTokens: 0,
            dropped: 4,
            clipped: 4,
            entries: 3
        });
    });

    // ── R6 (2026-11-17): THE LADDER STOPS WHERE THE WINDOW ACTUALLY ENDS ────────────────
    //
    // THE DEFECT THESE THREE CASES SHARE. The boundary estimate the trigger compares is the
    // transcript payload PLUS the request's irreducible floor — the serialized tool catalogue and
    // the instruction blocks (`src/harness.ts:12512` hands the estimator `toolSchemaBytes()` on
    // every round, and `measureRequestFloor` derives the residual from that same figure). The rung
    // used to scale THAT whole number, so the budget it handed the planner was
    //
    //     floor(ladder × (floor + payload₀))  =  floor + ladder × payload₀  −  (1 − ladder) × floor
    //
    // — the cut the rung asked for, PLUS a second allowance measured in fractions of a catalogue
    // the transcript pass cannot touch. Every rung therefore erased a slice of conversation the
    // context window never asked for, and once that budget fell below `floor + the smallest request
    // the transcript can build` it was unreachable, so the planner dropped EVERY droppable unit
    // chasing a number no request of this harness could ever send. `rungBudget` in the plugin now
    // scales the removable payload and adds the floor back unchanged, and `fitLine` states the one
    // ceiling "fits" is measured against; these cases pin the exact budget each regime produces.
    //
    // THE FIXTURE, sized so the two halves of the sum are visible. 5 × 4,000 ASCII characters =
    // 20,000 payload bytes = 5,000 transcript tokens, and `tokens` is the 25,000 the harness bills,
    // so the floor this pass derives is exactly 20,000 (25,000 − 5,000) — a catalogue-dominated
    // round, the shape that used to lose the ladder's footing. The request the pass builds carries
    // the instruction on top: 20,000 + 1,752 payload bytes = 5,438 tokens, i.e. 25,438 billed,
    // 4,438 over the 25,000 ceiling, so a cut IS required. What the ceiling requires and nothing
    // more: clip the four head entries (4 × 269 + 4,000 + 1,752 = 6,828 bytes = 1,707 tokens),
    // i.e. 21,707 billed. The pre-R6 budget of 21,250 was 3,000 tokens lower — exactly
    // `0.15 × 20,000`, the rung's percentage of the catalogue — and that allowance is what pushed
    // the planner past clipping into dropping all four head units to reach 21,631, buying 76 tokens
    // of savings the ceiling never asked for with four turns of history (probe
    // `Temp/orch/probe-ladder.ts`, both rows).
    const heavyTranscript = (): HarnessMessage[] =>
        [0, 1, 2, 3, 4].map((index) => ({
            role: 'user' as const,
            content: `t${index}${'x'.repeat(3999 - String(index).length)}`
        }));

    // Pass A's four clipped heads, spelled out rather than re-derived: `clipShrinkText` keeps the
    // first 240 characters and appends the marker, so `t0` + 238 x's + `… [truncated by
    // compaction]` (267 characters, 269 bytes — the ellipsis is 3 bytes of UTF-8).
    const clippedHead = (index: number): string =>
        `t${index}${'x'.repeat(238)}\u2026 [truncated by compaction]`;

    // The one report all three regimes below produce, asserted whole so a moved budget cannot hide
    // inside a `toMatchObject`. `target` 24,250 is `20,000 + floor(0.85 × 5,000)`; `to` 21,707 is
    // `20,000 + 1,707`; `dropped: 0` is the whole point — the transcript units survive.
    const RUNG_REPORT = {
        mode: 'summarize',
        threadId: 'thread-1',
        stage: 'shrink',
        target: 24_250,
        from: 25_438,
        to: 21_707,
        floorTokens: 20_000,
        dropped: 0,
        clipped: 4,
        entries: 6
    };

    // The request that budget selects: the four clipped heads, the verbatim tail entry the ladder
    // may not cut (`SHRINK_KEEP_TAIL`), and the instruction. NO digest, because no unit went.
    const clippedRequest = (messages: readonly HarnessMessage[]): HarnessMessage[] => [
        ...[0, 1, 2, 3].map((index) => ({
            role: 'user' as const,
            content: clippedHead(index)
        })),
        { role: 'user' as const, content: String(messages[4].content) },
        { role: 'user' as const, content: COMPACTION_INSTRUCTION }
    ];

    it('stops the shrink at the first budget that fits, keeping the history the ceiling never asked for', async () => {
        const messages = heavyTranscript();
        const fake = createFakeApi(25_000, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];
        const requests: HarnessMessage[][] = [];

        passes.runFailed({ ...runLifecycle, error: refused() });
        await passes.turnBefore(summarizeTurn(fake, 25_000, calls, { requests, messages }));

        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        // THE STOPPING POINT, byte for byte: pass A alone, every pairable unit still in the
        // request. Under the pre-R6 budget the array below had THREE rows — a digest plus the
        // tail plus the instruction — because the budget sat 3,000 tokens under this one.
        expect(requests[0]).toEqual(clippedRequest(messages));

        const shrink = fake.diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'shrink'
        );

        expect(shrink?.data).toEqual(RUNG_REPORT);

        // THE OTHER HALF OF THE PIN, in the two numbers the operator reads: the request that goes
        // out is 21,707 billed against the 25,000 ceiling the provider refuses at — the cut was
        // enough — and it is still 3,731 tokens of transcript the pass did NOT throw away compared
        // with the 25,438 that would otherwise have gone out. None of that 3,731 was owed to the
        // ceiling; the pre-R6 budget charged the transcript for 15% of the catalogue and then
        // billed the difference in turns.
    });

    it('prices the refusal-armed rung and the at-window rung against one ceiling', async () => {
        // THE SAME ROUND, TRIGGERED THE OTHER WAY. Nothing was refused here: a DECLARED model
        // window equal to the ceiling makes the projection-at-the-window prevention path
        // (`atWindow`, the branch the headroom buffer exists for) the reason this pass shrinks at
        // all. Both branches read the one `fitLine` / `rungBudget` pair, so the budget, the sent
        // request and every reported figure are the same numbers — "fits" means one thing, and a
        // prevention pass does not compact harder than a reaction pass, or less.
        const messages = heavyTranscript();
        const fake = createFakeApi(
            25_000,
            {
                mode: 'summarize',
                minTokens: 0,
                modelLimits: '{"wide/model": {"window": 25000}}'
            },
            { writer: fakeBrain(() => 'wide/model') }
        );
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];
        const requests: HarnessMessage[][] = [];

        await passes.turnBefore(summarizeTurn(fake, 25_000, calls, { requests, messages }));

        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(requests[0]).toEqual(clippedRequest(messages));

        expect(
            fake.diagnostics
                .filter((report) => (report.data as { stage?: string })?.stage === 'shrink')
                .map((report) => report.data)
        ).toEqual([RUNG_REPORT]);
    });

    it('keeps the ladder reachable when the floor sits inside the headroom band', async () => {
        // THE REGIME THE FIT LINE EXISTS FOR. The same 25,000 ceiling with the DECLARED 0.15
        // buffer: the ratio wants 3,750 and the floor wants 16,000, so the half-ceiling cap
        // answers, `effective` is 12,500, and this round's 20,000-token floor sits UNDER THE
        // FIRING POINT — while the dead-run guard has just established the pass is NOT dead,
        // because the ceiling (25,000) is still reachable. Pre-R6 the budget was
        // `min(12,500, 21,250) = 12,500`: below the floor, therefore unreachable by construction,
        // therefore every droppable unit went. `fitLine` answers with the ceiling instead, the
        // number the provider actually refuses at, so the rung keeps its 24,250 budget and stops
        // at the same first request that fits it. The TRIGGER is untouched: this round still fires
        // because 25,000 ≥ 12,500, and Rule 3's margin is still `effective`-scaled.
        const messages = heavyTranscript();
        const fake = createFakeApi(25_000, {
            mode: 'summarize',
            minTokens: 0,
            headroomRatio: 0.15
        });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];
        const requests: HarnessMessage[][] = [];

        passes.runFailed({ ...runLifecycle, error: refused() });
        await passes.turnBefore(summarizeTurn(fake, 25_000, calls, { requests, messages }));

        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(requests[0]).toEqual(clippedRequest(messages));

        expect(
            fake.diagnostics
                .filter((report) => (report.data as { stage?: string })?.stage === 'shrink')
                .map((report) => report.data)
        ).toEqual([RUNG_REPORT]);

        // The park report still names the buffered firing point, unchanged in its semantics (the
        // fix moved the ladder's fit line, not the trigger). It is the one report on this path
        // that carries `effective`; the arm report carries `stage: 'overflow'` and the shrink
        // report carries `target`/`from`/`to`.
        const parked = fake.diagnostics.find(
            (report) => (report.data as { effective?: number })?.effective !== undefined
        );

        expect(parked?.data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            tokens: 25_000,
            effective: 12_500,
            // The canonical transcript the pass committed: the fake's one standing entry plus the
            // compaction instruction this pass appended.
            entries: 2
        });
    });

    it('refuses a pass whose floor alone is over the ceiling, and sends the one that is not', async () => {
        // THE DEAD RUN (X1, 2026-11-17 — the second half of the deadlock). A session whose tool
        // catalogue and instructions are 1,000 tokens and whose ceiling is 1,000 cannot be rescued
        // by clipping: the summarize request is `catalogue + transcript + instruction`, and the
        // ladder only ever removes transcript. Under the old currency the pass fired anyway, sent a
        // request the provider refused for the identical reason, and left the failed turn, the park
        // and the re-armed pass sitting there for the NEXT turn to replay — which is the report
        // this file's header calls a deadlock. Refusing it is an honest block: nothing is parked,
        // nothing is rewritten, every entry stays in the request.
        //
        // THE FIXTURE STATES ITS FLOOR INSTEAD OF HIDING IT: `messages` is 500 tokens of
        // transcript, `tokens` is the 1,500 the harness actually bills, so the derived floor is
        // exactly 1,000 (1,500 − 500) and the two halves of the sum are the two halves the
        // estimator priced.
        const messages: HarnessMessage[] = [0, 1, 2, 3, 4].map((index) => ({
            role: 'user' as const,
            content: `t${index}${'x'.repeat(399 - String(index).length)}`
        }));

        const refusedRun = async (limit: number): Promise<FakeApi> => {
            const fake = createFakeApi(limit, { mode: 'summarize', minTokens: 0 });
            const passes = createContextCompactionPasses(fake.api);

            passes.runFailed({ ...runLifecycle, error: refused() });

            const calls: string[] = [];
            const requests: HarnessMessage[][] = [];

            await passes.turnBefore(summarizeTurn(fake, 1500, calls, { requests, messages }));

            // The floor is the same in both arms (1,000), and so is the transcript (500). Only the
            // ceiling moves, by ONE token.
            return fake;
        };

        // ── Arm 1: floor == ceiling → no pass, one report, nothing touched ───────────────
        const blocked = await refusedRun(1000);
        const blockReports = blocked.diagnostics.filter(
            (report) => (report.data as { stage?: string })?.stage === 'unreachable-target'
        );

        expect(blockReports.map((report) => report.data)).toEqual([
            {
                mode: 'summarize',
                threadId: 'thread-1',
                stage: 'unreachable-target',
                tokens: 1500,
                effective: 1000,
                limit: 1000,
                // X2, F6: `reported: true` marks the turn that actually printed the paragraph, so
                // a log reader can tell "this is the one report" from "this turn was also dead and
                // stayed quiet" (the latch below bounds the repeat, and `tokens` is what it tracks).
                unreachableTarget: 1000,
                transcriptTokens: 500,
                reported: true,
                armed: true,
                rung: 0
            }
        ]);

        // No park, no commit, no request rewrite, no display lane — and no shrink report either,
        // because a pass that never started cannot report one.
        expect(blocked.touches.filter((touch) => touch.startsWith('threads.'))).toEqual([]);
        expect(
            blocked.diagnostics.filter((report) => (report.data as { stage?: string })?.stage === 'shrink')
        ).toEqual([]);

        // ── Arm 2: the ceiling is ONE token higher → the ladder has work to do ───────────
        // `effective` 1,001 is above the 1,000 floor, so the fit line IS `effective` and the rung
        // budget — the floor plus the ratio across the 500 tokens of removable transcript,
        // 1,000 + floor(0.85 × 500) = 1,425 — clamps to 1,001 and is reachable in principle.
        // Billed 1,000 + 938 = 1,938 → pass A gives
        // 1,000 + 807 = 1,807, still over, so the four head units go behind the digest:
        // 1,000 + 731 = 1,731 — the floor plus the smallest request the ladder may send.
        const fired = await refusedRun(1001);
        const firedShrink = fired.diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'shrink'
        );

        expect(
            fired.diagnostics.filter((report) => (report.data as { stage?: string })?.stage === 'unreachable-target')
        ).toEqual([]);
        expect(firedShrink?.data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            stage: 'shrink',
            target: 1001,
            from: 1938,
            to: 1731,
            floorTokens: 1000,
            dropped: 4,
            clipped: 4,
            entries: 3
        });

        // THE BEFORE/AFTER, in one line: under the transcript-only measure this same fixture was a
        // no-op — 938 transcript tokens already sat under the 1,001 target, so the ladder walked to
        // the bottom, cut nothing the provider would notice, and re-sent the refused request.
    });

    it('says the dead-run refusal once, and leaves an exclude round alone', async () => {
        // THE LATCH (X2, F6). Rule 3's regrowth memory bounds the UNARMED case, and the guard
        // fires BEFORE that memory is written, so the bound lives in the guard itself: it stores
        // the size it reported at and says nothing more until the size moves by the same
        // `REGROWTH_RATIO` margin Rule 3 uses — 5% of the effective limit, so 1,500 → 1,500 is
        // inside the margin and 1,600 is outside it (1,500 + floor(1,000 × 0.05) = 1,550). A
        // session permanently over its window therefore states the problem ONCE and goes quiet,
        // while a session that keeps growing keeps stating it, because each step is a request
        // that still does not fit.
        const fake = createFakeApi(1000, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];
        // A 500-token transcript under a 1,500/1,600 estimate: the floor is 1,000/1,100 and the
        // ceiling is 1,000, so every one of these turns is a dead run and the question is only how
        // often the pass says so.
        const deadMessages = turnProjection(500);
        const reportsOf = (): number =>
            fake.diagnostics.filter(
                (report) => (report.data as { stage?: string })?.stage === 'unreachable-target'
            ).length;

        await passes.turnBefore(summarizeTurn(fake, 1500, calls, { messages: deadMessages }));
        expect(reportsOf()).toBe(1);

        // THE PARAGRAPH TELLS THE OPERATOR WHAT TO DO (X2, F6). The old wording blamed the
        // shrink ladder ("the target was unreachable") for a condition that is about the request
        // this harness SENDS, and named no lever; the ceiling here belongs to a `contextLimit` of
        // 1,000 against a 1,000-token floor, and the only levers are the limit, the model's
        // declared window, and the size of the tool set.
        const refusal = fake.diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'unreachable-target'
        );

        expect(String(refusal?.message)).toContain('is refusing to compact thread thread-1');
        expect(String(refusal?.message)).toContain('floor is 1000 tokens against a 1000 ceiling');
        expect(String(refusal?.message)).toContain('Raise `contextLimit` above 1000');
        expect(String(refusal?.message)).toContain('`modelLimits`');

        await passes.turnBefore(summarizeTurn(fake, 1500, calls, { messages: deadMessages }));
        expect(reportsOf()).toBe(1);

        await passes.turnBefore(summarizeTurn(fake, 1600, calls, { messages: deadMessages }));
        expect(reportsOf()).toBe(2);
        expect(calls).toEqual([]);

        // `exclude` never re-sends the transcript, so the floor argument does not apply to it and
        // the guard must not touch the mode: the same size fires the pruning pass as it always did.
        const excluding = createFakeApi(1000, { mode: 'exclude', minTokens: 0 });
        const guard = createContextCompactionHandler(excluding.api);
        const excludeCalls: string[] = [];

        guard(createFakeTurn({ api: excluding.api, estimatedTokens: 1500, calls: excludeCalls }));

        expect(
            excluding.diagnostics.filter(
                (report) => (report.data as { stage?: string })?.stage === 'unreachable-target'
            )
        ).toEqual([]);
    });

    it('prices the media term the harness figure never saw into the floor (X2, F1)', async () => {
        // THE CURRENCY BUG THIS PINS. The `estimatedTokens` on this boundary is the HARNESS
        // figure, and `src/harness.ts` `emitTurnBefore` never passes `includeAttachmentBytes`, so
        // a screenshot replayed on every turn is invisible in it; the plugin's own measurer
        // (`measureShrink`) DOES price those wire bytes (core/context-estimate.ts, "THE OPT-IN
        // REQUEST WEIGHT"). The floor used to be `estimatedTokens − measureShrink(messages)`:
        // subtracting a media-inclusive number from a media-free one left the residual short by
        // exactly the media term, so a request that was already past its ceiling read as
        // rescuable and the pass spent a model turn to be refused again.
        //
        // THE FIGURES, from the estimator's own rules — the same entry the planner table pins at
        // the `measures with attachment bytes` case above: the BODY is 100 text bytes + `name` 5
        // + `mime` 9 = 114 bytes → ceil(114 / 4) = 29 tokens; the media term adds the 53,333
        // base64 characters (ASCII, so its wire width IS its length) → 53,447 bytes →
        // ceil(53,447 / 4) = 13,362 tokens. A harness estimate of 1,029 is therefore 29 transcript
        // + 1,000 of catalogue and instructions with the media term UNCOUNTED, and the floor
        // `measureRequestFloor` must derive is 1,029 + (13,362 − 29) − 13,362 = 1,000 — the
        // ceiling EXACTLY, which is the dead run the guard refuses. The pre-fix derivation read
        // max(0, 1,029 − 13,362) = 0 and fired.
        const shot: HarnessMessage[] = [
            {
                role: 'user',
                content: 'x'.repeat(100),
                attachments: [
                    {
                        id: 'a1',
                        kind: 'image',
                        marker: '[Image 1]',
                        name: 'a.png',
                        mime: 'image/png',
                        size: 40000,
                        data: 'A'.repeat(53333)
                    }
                ]
            }
        ];

        const fake = createFakeApi(1000, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];

        passes.runFailed({ ...runLifecycle, error: refused() });

        await passes.turnBefore(summarizeTurn(fake, 1029, calls, { messages: shot }));

        // No park, no instruction, no request — and the report states the floor in the currency
        // the operator reads: `transcriptTokens` is the media-INCLUSIVE transcript (13,362), which
        // is why 1,029 estimated tokens is not "small enough".
        expect(calls).toEqual([]);
        expect(
            fake.diagnostics.filter(
                (report) => (report.data as { stage?: string })?.stage === 'unreachable-target'
            ).map((report) => report.data)
        ).toEqual([
            {
                mode: 'summarize',
                threadId: 'thread-1',
                stage: 'unreachable-target',
                tokens: 1029,
                effective: 1000,
                limit: 1000,
                unreachableTarget: 1000,
                transcriptTokens: 13362,
                reported: true,
                armed: true,
                rung: 0
            }
        ]);
    });

    it('judges the dead run against the refusal point, not the buffered trigger (X2, F3)', async () => {
        // THE BAND F3 CREATES, and the guard has to sit on the right side of it. A 1,000 ceiling
        // with the DECLARED 0.15 ratio: the half-ceiling cap answers (min(max(16000, 150),
        // min(500, 999)) = 500), so the trigger fires at 500 while the number that REFUSES stays
        // 1,000. This request's floor is 700 — 1,200 estimated minus the 500 tokens of transcript
        // the pass could take — so it sits between the two. A guard keyed on `effective` (the
        // figure X1's dead-run guard compared against) would call this dead and withhold a pass
        // that can still relieve 500 sendable tokens; on a small-`contextLimit` deployment that
        // band is most of the working room, i.e. F3 would have made compaction unrunnable for
        // exactly the installations F3 protects. The guard compares against what refuses.
        const fake = createFakeApi(1000, { mode: 'summarize', minTokens: 0, headroomRatio: 0.15 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];

        await passes.turnBefore(summarizeTurn(fake, 1200, calls, { messages: turnProjection(500) }));

        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(
            fake.diagnostics.filter(
                (report) => (report.data as { stage?: string })?.stage === 'unreachable-target'
            )
        ).toEqual([]);
    });

    it('stops the ladder the first time a rung cannot come back smaller (X2, F2)', async () => {
        // THE MEASURED FAILURE: four rung targets, four refused round trips, one identical request
        // each time (`Temp/review-v2/probe-b.log` B3 — 41,399 / 34,093 / 24,352 / 17,046 all
        // resolving to the same 206,159-token figure). The rung TARGETS strictly decrease, but a
        // target below what the transcript pass can remove is reached by removing everything
        // removable, so every deeper rung sends the same bytes and the give-up only arrived after
        // the fourth refusal. Give-up is keyed on PROGRESS now: the second rung of this sequence
        // is compared against the figure the first rung actually sent and was refused at, cannot
        // beat it, and stops there — with no park, no instruction and no provider round trip.
        //
        // THE FIXTURE, sized so both rungs bottom out. 1,400 ceiling (`headroomRatio: 0`, so the
        // trigger IS the ceiling), a 500-token transcript (five 400-character entries), and a
        // 1,500 estimate → floor 1,000: over the trigger, under the ceiling, so the guard lets the
        // sequence run. Rung 1 asks for 1,400 and rung 2 for 1,350 — the rung budget is the floor
        // PLUS the ratio across the 500 tokens of transcript this pass can actually remove
        // (1,000 + floor(0.85 × 500) = 1,425, clamped to the 1,400 fit line; 1,000 + floor(0.7 ×
        // 500) = 1,350), because the ratio no longer reaches across the 1,000-token floor it cannot
        // remove (R6, 2026-11-17) — and BOTH are below the smallest request this transcript can
        // send, so both resolve to the all-removed request:
        //   pass A (clip only) = 4 clipped heads × 269 bytes + the one verbatim projection entry
        //            (400) + the instruction (1,752) = 3,228 bytes → 807 tokens → billed 1,807,
        //            still over both targets, so the head units go:
        //   digest = 291 characters of marker and prose + the oldest and newest 240-character
        //            excerpts of what went missing = 771 bytes (all ASCII)
        //   tail   = the one verbatim projection entry the ladder may not cut = 400 bytes — the
        //            second `SHRINK_KEEP_TAIL` slot is the instruction itself, which is why the
        //            request below has ONE transcript row (the same arithmetic the ladder case
        //            above derives as 731 tokens with a 0 floor)
        //   instruction = 1,752 bytes (the 1,714 characters of `COMPACTION_INSTRUCTION`, 38 of
        //            them multi-byte — see the byte-audit note at the top of this file)
        //   body   = ceil((771 + 400 + 1,752) / 4) = ceil(2,923 / 4) = 731 tokens
        //   billed = floor + body = 1,000 + 731 = 1,731 tokens on rung 1 AND on rung 2.
        const messages: HarnessMessage[] = [0, 1, 2, 3, 4].map((index) => ({
            role: 'user' as const,
            content: `t${index}${'x'.repeat(399 - String(index).length)}`
        }));

        const fake = createFakeApi(1400, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const requests: HarnessMessage[][] = [];
        const first: string[] = [];

        // Refusal #1 arms the ladder; the next boundary sends rung 1.
        passes.runFailed({ ...runLifecycle, error: refused() });
        await passes.turnBefore(
            summarizeTurn(fake, 1500, first, { messages, requests })
        );

        expect(first).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(requests).toHaveLength(1);

        // Refusal #2: the provider refused the 1,731-token request, so rung 2 (target 1,350) is
        // asked whether it can send anything smaller. It cannot — the transcript has not moved,
        // and a smaller target removes no less — so the sequence ends HERE, one round trip after
        // the refusal rather than four.
        const second: string[] = [];

        passes.runFailed({ ...runLifecycle, error: refused() });
        await passes.turnBefore(
            summarizeTurn(fake, 1500, second, { messages, requests })
        );

        expect(second).toEqual([]);
        expect(requests).toHaveLength(1);

        const stop = fake.diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'no-progress'
        );

        expect(stop?.data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            stage: 'no-progress',
            rung: 2,
            ladder: 4,
            target: 1350,
            from: 1731,
            to: 1731,
            floorTokens: 1000,
            exhausted: true
        });

        // And the sequence is not bricked: the report above deleted the baseline, so a FRESH
        // refusal starts a new ladder with a fresh baseline rather than being judged against a
        // stale figure — the next boundary sends again. That is the bound this fix leaves, stated
        // honestly: one shrunk attempt per pair of refusals (attempt, stop, attempt, stop) instead
        // of one per rung, and the machine stays available for the case where the refusal WAS the
        // transcript's fault and the transcript has since changed.
        const third: string[] = [];

        passes.runFailed({ ...runLifecycle, error: refused() });
        await passes.turnBefore(
            summarizeTurn(fake, 1500, third, { messages, requests })
        );

        expect(third).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(requests).toHaveLength(2);
    });

    it('keeps the cooldown for an ordinary failure and clears it for a refusal', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // A real pass first, so the Rule-3 memory exists: it records 400 BEFORE the action, and
        // the margin is floor(250 × 0.05) = 12, so a turn at the same size is cooled.
        let calls: string[] = [];

        await passes.turnBefore(summarizeTurn(fake, 400, calls));
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        calls = [];
        await passes.turnBefore(summarizeTurn(fake, 400, calls));
        expect(calls).toEqual([]);

        passes.runFailed({ ...runLifecycle, error: down() });

        // A provider that failed for a reason compaction cannot reach stays damped — otherwise
        // every turn of a broken run buys another model round trip.
        calls = [];
        await passes.turnBefore(summarizeTurn(fake, 400, calls));
        expect(calls).toEqual([]);

        passes.runFailed({ ...runLifecycle, error: refused() });

        // The SAME size, the SAME margin, one different error code: a refused request is
        // answered with a SMALLER request, so muting the retry is the deadlock this fixes.
        calls = [];
        await passes.turnBefore(summarizeTurn(fake, 400, calls));
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
    });

    it('walks the ladder and stops spending turns once it is spent', () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // Five refusals: four rungs, then the give-up. The rung data is asserted below, so the
        // loop only drives the machine.
        const expected: unknown[] = [
            { mode: 'summarize', threadId: 'thread-1', hook: 'run.failed', stage: 'overflow', rung: 1, ladder: 4, ratio: 0.85, exhausted: false },
            { mode: 'summarize', threadId: 'thread-1', hook: 'run.failed', stage: 'overflow', rung: 2, ladder: 4, ratio: 0.7, exhausted: false },
            { mode: 'summarize', threadId: 'thread-1', hook: 'run.failed', stage: 'overflow', rung: 3, ladder: 4, ratio: 0.5, exhausted: false },
            { mode: 'summarize', threadId: 'thread-1', hook: 'run.failed', stage: 'overflow', rung: 4, ladder: 4, ratio: 0.35, exhausted: false },
            // The give-up: `ratio: 0` and `exhausted: true` say the transcript is not the problem
            // — a tool registry the estimate cannot see, or a window smaller than one turn.
            { mode: 'summarize', threadId: 'thread-1', hook: 'run.failed', stage: 'overflow', rung: 4, ladder: 4, ratio: 0, exhausted: true }
        ];

        for (const _ of expected) {
            passes.runFailed({ ...runLifecycle, error: refused() });
        }

        expect(fake.diagnostics.map((report) => report.data)).toEqual(expected);
    });

    it('stops reacting after the ladder is spent, and restarts it on a real answer', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        passes.runFailed({ ...runLifecycle, error: refused() });
        passes.runFailed({ ...runLifecycle, error: refused() });
        passes.runFailed({ ...runLifecycle, error: refused() });
        passes.runFailed({ ...runLifecycle, error: refused() });
        passes.runFailed({ ...runLifecycle, error: refused() });

        // Spent: the same below-trigger boundary the arming case fired on now stays quiet.
        let calls: string[] = [];

        await passes.turnBefore(summarizeTurn(fake, 100, calls));
        expect(calls).toEqual([]);

        // One answered compaction resets the ladder — the provider answered a whole request, so
        // the next refusal is a new emergency and starts again at rung 1.
        await passes.turnBefore(summarizeTurn(fake, 400, calls));
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        passes.turnAfter({
            ...runLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        passes.runFailed({ ...runLifecycle, error: refused() });

        // The LAST overflow report — not the last diagnostic, which is the existing park-lift
        // report this failure also produces (`phase: 'finishing'`, unchanged above).
        const reports = fake.diagnostics.filter(
            (report) => (report.data as { stage?: string })?.stage === 'overflow'
        );

        expect(reports[reports.length - 1].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            hook: 'run.failed',
            stage: 'overflow',
            rung: 1,
            ladder: 4,
            ratio: 0.85,
            exhausted: false
        });
    });

    it('recognises a refusal that arrives as prose, the way a gateway relays one', async () => {
        // No `code` at all: the fallback is the same one `core/agent.ts`
        // `isContextOverflowFailure` applies, and the agent's own pre-request floor message
        // starts with the code followed by a colon — pinned here so a relay that flattens the
        // frame into text still arms the machine.
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        passes.runFailed({
            ...runLifecycle,
            error: {
                message:
                    'context-overflow: agent "writer" would send an estimated 900 tokens against a 512-token window'
            } as never
        });

        const calls: string[] = [];

        await passes.turnBefore(summarizeTurn(fake, 100, calls));
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        // A lookalike that is not the prefix does NOT arm: the rule is a prefix match on the
        // machine code, not a word search through English prose.
        const other = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const otherPasses = createContextCompactionPasses(other.api);

        otherPasses.runFailed({
            ...runLifecycle,
            error: { message: 'the provider mentioned a context window in its error page' } as never
        });

        const otherCalls: string[] = [];

        await otherPasses.turnBefore(summarizeTurn(other, 100, otherCalls));
        expect(otherCalls).toEqual([]);
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
        // back to the DECLARED default (200000) exactly as a fresh session's would — and with
        // no window declared the fallback IS the firing point, buffer-free.
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

    it('buffers a declared window, and scales the regrowth margin off the buffered trigger', async () => {
        // The operator's example end to end: a 512000 ceiling on a 262144-token model. The
        // window caps the ceiling AND carries the headroom buffer, so the trigger is
        // 262144 − 39321 = 222823 — the whole point of the buffer, which is that the request
        // carrying the ~430-token compaction instruction fits under the window instead of
        // arriving past the point the provider refuses at.
        const { api } = createFakeApi(
            512000,
            // The buffer ON for this case, spelled: the whole test is the buffer's arithmetic at
            // the operator's scale, so it must not ride the fixture's `headroomRatio: 0` seed
            // (X2, F3 moved that seed to the declared default's side of the rule).
            { headroomRatio: 0.15, modelLimits: '{"wide/model": {"window": 262144}}' },
            { writer: fakeBrain(() => 'wide/model') }
        );
        const calls: string[] = [];
        const { seen, action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);
        const run = async (estimatedTokens: number): Promise<void> => {
            await handler(createFakeTurn({ api, estimatedTokens, calls }));
        };

        // One token under the buffered trigger: nothing. This is the case the old numbers
        // called "under the limit" at 262143, and the case the fix exists for — 262143 of
        // projection plus the instruction is a request the 262144 window refuses.
        await run(222822);
        expect(calls).toEqual([]);

        await run(222823);
        expect(calls).toEqual(TRIPLE);

        // The re-trigger margin is 5% of the EFFECTIVE (capped AND buffered) limit —
        // floor(222823 * 0.05) = 11141 — not of the 262144 window (13107) and not of the
        // 512000 ceiling (25600). Off the ceiling a conversation stuck just over the trigger
        // would go unexamined for a quarter of a window.
        await run(233963);
        expect(calls).toEqual(triples(1));

        await run(233964);
        expect(calls).toEqual(triples(2));
        expect(seen).toHaveLength(2);

        // Back under the trigger clears the cooldown, so the next crossing is fresh — the
        // Rule 2 memory is keyed off the TRIGGER, not off the raw ceiling or the raw window.
        await run(222800);
        await run(222823);
        expect(calls).toEqual(triples(3));
    });

    it('fires at the operator limit only when the buffer is opted out (X2, F3)', async () => {
        // THE OPT-OUT, spelled: `headroomRatio: 0` means "fire exactly at the number the
        // operator typed", so a conversation 5 tokens under 200000 is left exactly where the
        // operator put it and the 200000th token fires. This is also why every other fixture in
        // this file seeds that zero — its ceilings are hand-derived against the typed number.
        const { api } = createFakeApi(200000);
        const calls: string[] = [];
        const { action } = createRecordingAction(calls);

        const handler = createContextCompactionHandler(api, action);

        await handler(createFakeTurn({ api, estimatedTokens: 199999, calls }));
        expect(calls).toEqual([]);

        await handler(createFakeTurn({ api, estimatedTokens: 200000, calls }));
        expect(calls).toEqual(TRIPLE);

        // THE DECLARED DEFAULT at handler level, with no window anywhere in the settings — the
        // shape X2 (F3) is about. `contextLimit: 200000` is the operator's guess at the model's
        // window, and the summarize request (the whole projection PLUS the 1,752-byte
        // instruction) is scored against the model's REAL window by the provider, so the
        // un-decorated budget needs the same working room a declared window gets: the firing
        // point moves to 200000 − min(max(16000, 30000), min(100000, 199999)) = 170000. One
        // token either side of that is the whole difference between this arm and the one above.
        const buffered = createFakeApi(200000, { headroomRatio: 0.15 });
        const bufferedCalls: string[] = [];
        const bufferedHandler = createContextCompactionHandler(
            buffered.api,
            createRecordingAction(bufferedCalls).action
        );

        await bufferedHandler(createFakeTurn({ api: buffered.api, estimatedTokens: 169999, calls: bufferedCalls }));
        expect(bufferedCalls).toEqual([]);

        await bufferedHandler(createFakeTurn({ api: buffered.api, estimatedTokens: 170000, calls: bufferedCalls }));
        expect(bufferedCalls).toEqual(TRIPLE);
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

        // EVERY member of the failed unit, leader first. Since R8 the runtime flag moves ONE
        // canonical entry (`src/harness.ts` `writeIncluded`), so a prune that stopped at the
        // leader would withhold the request and leave the failed ANSWER riding — a saving the
        // report below claims and the request would not deliver. The answering unit (3, 4) is
        // untouched either way.
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(entries[1].included).toBe(false);
        expect(entries[2].included).toBe(false);
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
        // 238 tokens is the withheld unit, counted in payload bytes: the 926-byte result (the
        // 20-character `Tool "read" failed: ` prefix costs 22, because its two quotes double, plus
        // the 900 E's, plus its 4-byte tool name) and the 23-byte leader (its 4-byte name plus the
        // 15 characters of `{"path":"a.ts"}`, whose four quotes double to 19) = 949 bytes. The
        // estimator rounds ONCE over the whole transcript, which measures 1,009 payload bytes
        // (253 tokens) with the unit riding and 60 bytes (15 tokens) with it off, so the saving it
        // reports is 253 − 15 = 238 — not `ceil(949 / 4)`. The identical arithmetic is asserted
        // from the estimator itself in src/core/context-pruning.test.ts, so this number is
        // cross-checked, not read back.
        expect(data.withheldTokens).toBe(238);
        expect(data.units).toEqual([
            {
                index: 1,
                messageId: 'msg-2',
                outcomes: ['failed'],
                tokens: 238,
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

        // The one shape that prunes writes BOTH of its entries (R8: one flag write per entry,
        // so the failed answer really leaves the request).
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
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
        expect(diagnostics[0].data).toMatchObject({ minTokens: 5000, withheldTokens: 238 });
    });

    it('is idempotent: a second pass over the same transcript disables nothing new', async () => {
        const { api, diagnostics } = createFakeApi(100, { minTokens: 10, safetyTurns: 0 });
        const calls: string[] = [];
        const entries = prunableEntries();
        const context = createFakeTurn({ api, estimatedTokens: 500, calls, entries });

        await executeCompaction(api, context);
        await executeCompaction(api, context);

        // TWO writes total, and ONE report total: the second pass sees the live per-entry flags
        // and finds the unit FULLY withheld — every member of it already off, so its write set
        // (`context-pruning.includedMembersOf`) is empty and the pass proposes nothing. Nothing is
        // written, so nothing is notified and nothing is saved (no save, no cache churn —
        // T4.3/T4.4).
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
        expect(diagnostics).toHaveLength(1);
    });

    it('finishes a unit whose REQUEST the trimmer already truncated, and bills only what it withholds', async () => {
        // THE HALF STATE THE TRUNCATE AXIS CREATES (the 2026-11-13 review). Entry 1 — the
        // assistant REQUEST — is already withheld (src/plugins/context-trimmer.plugin.ts
        // `planTruncatedRequests` writes that one entry and leaves the results), entry 2 is the
        // FAILED RESULT still riding in the request, and entries 3/4 are the later identical call
        // that answers it. Under the old unit-level idempotence test this unit read as "already
        // handled" and compaction never planned it again: the failed answer stayed in the prompt
        // for the life of the conversation.
        const { api, diagnostics } = createFakeApi(100, { minTokens: 10, safetyTurns: 0 });
        const calls: string[] = [];
        const entries = prunableEntries([1]);
        const context = createFakeTurn({ api, estimatedTokens: 500, calls, entries });

        await executeCompaction(api, context);

        // (a) THE UNIT IS PLANNED, and (b) EXACTLY THE STILL-INCLUDED MEMBER IS WRITTEN: one write,
        // for entry 2. The leader is not touched, so compaction cannot resurrect a request the
        // trimmer withheld, and the answering unit (3, 4) is untouched as always.
        expect(calls).toEqual(['setIncluded:2:false']);
        expect(entries[1].included).toBe(false);
        expect(entries[2].included).toBe(false);
        expect(entries[3].included).toBe(true);
        expect(entries[4].included).toBe(true);

        // (d) THE SAVING IS WHAT WAS ACTUALLY WITHHELD. The report still NAMES the unit by its
        // leader — that is the identity an operator recognises, and the T4.5 "what answered it"
        // half is unchanged — but the figure is 232, the result on its own, not the 238 the whole
        // unit is worth (asserted byte-exact above). The leader's 23 payload bytes left the prompt
        // on the trimmer's turn; claiming them here would bill the same text twice. 232 is the
        // 926-byte result (22 bytes for the escaped 20-character `Tool "read" failed: ` prefix +
        // the 900 E's + the 4-byte name) through the estimator's single rounding over the
        // transcript: 986 bytes (247 tokens) with the result riding, 60 bytes (15 tokens) without
        // it, so 247 − 15 = 232.
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('withheld 1 superseded tool unit(s)');
        expect(diagnostics[0].message).toContain('~232 estimated tokens');
        expect(diagnostics[0].message).toContain('#1 msg-2 [failed] answered by msg-4');

        const data = diagnostics[0].data as { withheldTokens: number; units: { tokens: number; index: number }[] };

        expect(data.withheldTokens).toBe(232);
        expect(data.units[0].index).toBe(1);
        expect(data.units[0].tokens).toBe(232);

        // The floor judges the SAME figure, so the smaller saving is what an operator's `minTokens`
        // has to beat: 233 refuses this pass, 232 takes it (`>=`).
        for (const [minTokens, expected] of [
            [233, []],
            [232, ['setIncluded:2:false']]
        ] as const) {
            const gated = createFakeApi(100, { minTokens, safetyTurns: 0 });
            const gatedCalls: string[] = [];

            await executeCompaction(
                gated.api,
                createFakeTurn({
                    api: gated.api,
                    estimatedTokens: 500,
                    calls: gatedCalls,
                    entries: prunableEntries([1])
                })
            );

            expect(gatedCalls).toEqual([...expected]);
        }

        // (c) IDEMPOTENT: the pass above completed the withholding, so the unit is now fully off
        // and a SECOND pass over the live flags writes nothing new and reports nothing.
        await executeCompaction(api, context);

        expect(calls).toEqual(['setIncluded:2:false']);
        expect(diagnostics).toHaveLength(1);
    });

    it('honours safetyTurns as a horizon from the END of the transcript', async () => {
        // The fixture has 4 units; the candidate is unit #1 and the resolver unit #2.
        for (const [safetyTurns, expected] of [
            [0, ['setIncluded:1:false', 'setIncluded:2:false']],
            // A horizon of 2 protects units #2 and #3, so the candidate is still reachable...
            [2, ['setIncluded:1:false', 'setIncluded:2:false']],
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

        // Eight withheld units = SIXTEEN writes: the plan caps at 8 UNITS, and R8 makes each
        // unit a leader write plus its result write, oldest first.
        expect(calls).toEqual([
            'setIncluded:1:false',
            'setIncluded:2:false',
            'setIncluded:5:false',
            'setIncluded:6:false',
            'setIncluded:9:false',
            'setIncluded:10:false',
            'setIncluded:13:false',
            'setIncluded:14:false',
            'setIncluded:17:false',
            'setIncluded:18:false',
            'setIncluded:21:false',
            'setIncluded:22:false',
            'setIncluded:25:false',
            'setIncluded:26:false',
            'setIncluded:29:false',
            'setIncluded:30:false'
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
        // rather than letting an operator believe their setting took effect. The write set is
        // the unit's members either way (R8).
        expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);
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
        // so the shipped built-in changes the transcript inside the pause window. The prune is
        // one write per MEMBER of the unit it withholds (R8), inside the same single pause.
        expect(calls).toEqual(['pause', 'setIncluded:1:false', 'setIncluded:2:false', 'resume']);
        expect(touches).toEqual([...TRIGGER_READS, ...POLICY_READS, 'report.diagnostic']);
    });

    // What a `turn.before` estimate is here, exactly: `CATALOGUE + ceil(payload bytes / 4)`
    // (core/context-estimate.ts — the tool schemas of the request ride on the unanchored leg, see
    // the constant above), and the agent has no instruction blocks, so the transcript term of
    // these prompts is exact by construction:
    //   400 chars -> 100, 412 -> 103, 476 -> 119 against a limit of 100 (margin 5).
    // The estimates below are therefore `CATALOGUE + 100`, `CATALOGUE + 103`, `CATALOGUE + 119`.
    // The margin, and the crossing itself, are keyed on the OPERATOR's limit, which stays a
    // transcript-scale number, so the regrowth arithmetic these cases measure is unchanged.
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
            // The ceiling this case was written against is 100 TRANSCRIPT tokens; the request it
            // judges also carries the catalogue, so the number an operator would type today is
            // `CATALOGUE + 100`. The 2-character prompt is 1 transcript token, which sits 99
            // tokens under that ceiling exactly as it did under 100.
            pluginSettings: limitAt(CATALOGUE + 100),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Under limit' });
        const message = await writer.sendThreadInput(thread.id, SHORT);

        expect(message.content).toBe('ok');
        expect(estimates).toEqual([CATALOGUE + 1]);
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

        // Turn 1: 400 chars = 100 transcript tokens, i.e. a `CATALOGUE + 100` boundary estimate
        // -> the limit is reached -> park + un-park.
        expect((await writer.sendThreadInput(thread.id, CROSSING)).content).toBe('ok');
        expect(estimates).toEqual([CATALOGUE + 100]);
        expect(events).toEqual(['paused', 'resumed']);
        // The run was never stranded by the park.
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // Turn 2: 412 chars = 103 tokens — still over the limit, inside the 5% margin, so the
        // conversation is not parked again for the same size. (The margin is
        // `max(1, floor(100 * 0.05)) = 5` on the LIMIT, and the catalogue is a constant, so the
        // 3-token growth is inside it exactly as it was before the catalogue moved into the
        // estimate.)
        expect((await writer.sendThreadInput(thread.id, INSIDE_MARGIN)).content).toBe('fine');
        expect(estimates).toEqual([CATALOGUE + 100, CATALOGUE + 103]);
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // Turn 3: 476 chars = 119 tokens, 19 past the last mark -> re-armed.
        expect((await writer.sendThreadInput(thread.id, PAST_MARGIN)).content).toBe('done');
        expect(estimates).toEqual([CATALOGUE + 100, CATALOGUE + 103, CATALOGUE + 119]);
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
        expect(estimates).toEqual([CATALOGUE + 100]);
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
        expect(estimates).toEqual([CATALOGUE + 100]);
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
        expect(estimates).toEqual([CATALOGUE + 100]);
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
    // The numbers are derived, not observed: `brain()` has no instruction, so the TRANSCRIPT part of
    // the estimate is ceil(payload bytes / 4) over the content (core/payload-bytes.ts +
    // core/context-estimate.ts), and the boundary adds the `CATALOGUE` floor the header derives — so
    // every `contextLimit` in this block is written as `CATALOGUE + <transcript number>`. A failed
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
        // half-answered block. Pairing holds because this pass writes its WHOLE write set —
        // every member of a pruned unit gets its own flag, per the list above — not because the
        // runtime fans one flag out: R8 removed that cascade (the oracle is T3.4's, in the shape
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
    // harness overwrites that with the registry key on registration). The transcript term of
    // the estimate is the harness's own ceil(payload bytes / 4) over an agent with no instruction
    // blocks, and the request's 11-tool catalogue adds the constant above on top of it, so every
    // number below is derived from the documented formula, not from a run. The ceilings stay
    // TRANSCRIPT-scale, except where a case needs its ceiling ABOVE the estimate: that one is
    // written `CATALOGUE + n`, because the estimate it must clear carries the floor.
    // -----------------------------------------------------------------------

    it('leaves the conversation alone when the per-model limit lifts the trigger past the estimate', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            // The global ceiling of 100 would fire at this CATALOGUE + 100 estimate (every other
            // test in this file does exactly that). This model's own ceiling — 1000 transcript
            // tokens above the catalogue the request carries, i.e. 900 tokens of headroom over
            // this conversation — does not, and it is the model the run is actually on.
            pluginSettings: settingsOf({
                contextLimit: 100,
                modelLimits: `{"merge/ds4-flash": {"limit": ${CATALOGUE + 1000}}}`
            }),
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Per-model ceiling' });
        expect((await writer.sendThreadInput(thread.id, CROSSING)).content).toBe('ok');

        expect(estimates).toEqual([CATALOGUE + 100]);
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
                // The ceiling is written `CATALOGUE + 1000` in BOTH arms so they differ ONLY by
                // the model id the map keys: with the catalogue priced into the estimate, a bare
                // 1000 would fire in the control arm too (the request is CATALOGUE + 100).
                contextLimit: CATALOGUE + 1000,
                // effective = min(CATALOGUE + 1000, 100) = 100 — the declared window caps the
                // ceiling, and because it BINDS it also carries the headroom buffer: the trigger
                // is max(1, 100 − min(max(16000, floor(100 × 0.15)), floor(100 / 2), 99)) = 50 (the
                // half-window cap is what keeps a 100-token fixture from collapsing to 1). This
                // CATALOGUE + 100 request crosses either number by thousands, so the case
                // measures the SAME thing it always did: the model-keyed lookup, not the buffer.
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

        expect(estimates).toEqual([CATALOGUE + 100]);
        expect(events).toEqual(['paused', 'resumed']);
        expect(capped.thread(cappedThread.id)?.status).toBe('idle');

        // Identical settings except for the key the map names: a window declared for a model
        // this run is NOT on caps nothing, so the global `CATALOGUE + 1000` ceiling stands — the
        // CATALOGUE + 100 request is 900 transcript tokens under it — and the turn is left alone.
        // 900 tokens of ceiling apart, the whole difference is the lookup.
        const uncappedEvents: string[] = [];
        const uncappedEstimates: number[] = [];

        const uncapped = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            pluginSettings: settingsOf({
                contextLimit: CATALOGUE + 1000,
                modelLimits: '{"other/model": {"window": 100}}',
                mode: 'exclude'
            }),
            plugins: [probe(uncappedEvents, uncappedEstimates)]
        });

        const uncappedThread = uncapped.createThread('writer', { label: 'Window elsewhere' });
        await uncapped.sendThreadInput(uncappedThread.id, CROSSING);

        expect(uncappedEstimates).toEqual([CATALOGUE + 100]);
        expect(uncappedEvents).toEqual([]);
    });

    it('leaves a small conversation alone under the shipped defaults (limit 200000)', async () => {
        const events: string[] = [];
        const estimates: number[] = [];

        // No `pluginSettings` at all: the in-memory provider is seeded from the DECLARED
        // defaults, so this is a fresh install — ceiling 200000, an empty `modelLimits` map, and
        // `headroomRatio` at its declared 0.15. No buffer moves the firing point here, because
        // the buffer is keyed on a DECLARED window and none is declared: the firing point IS
        // 200000, which a CATALOGUE + 100 request (13,382 tokens, the 100 of transcript plus the
        // catalogue the request carries) is nowhere near.
        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [probe(events, estimates)]
        });

        const thread = writer.createThread('writer', { label: 'Fresh install' });
        expect((await writer.sendThreadInput(thread.id, CROSSING)).content).toBe('ok');

        expect(estimates).toEqual([CATALOGUE + 100]);
        expect(events).toEqual([]);
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });
});

// ---------------------------------------------------------------------------
// T9 — THE SUMMARIZE FLOW, end to end, through a real harness.
//
// Every number here is derived, never read back: the transcript is seeded with 2100
// characters of one user turn (525 tokens) and the prompt `go` adds one more, so the live
// projection at the first boundary is `CATALOGUE + 526` — the 526 of transcript plus the tool
// catalogue every request carries (see the constant above) — against an effective limit of
// `CATALOGUE + 520`: over by the same 6 tokens it always was, and `minTokens: 0` so the floor
// cannot refuse the pass. After a successful compaction the retained head (the instruction
// 438 tokens, the answer, the nudge) measures 486, i.e. 34 under the limit, which is what makes
// "the context is small again" an assertion rather than a hope. Because the floor is ADDITIVE
// (`CATALOGUE` is a multiple-of-4 byte count, so it rides on top of the transcript term and on
// top of the ceiling), this block writes its limit ONCE as `CATALOGUE + 520` and every
// limit-vs-estimate comparison in it keeps the exact margin it had at transcript scale. The seed
// and the limit are SIZED BY THE SHIPPED INSTRUCTION: the head is instruction + answer + nudge,
// so the OpenCode checkpoint template (1,714 characters / 1,752 payload bytes of instruction,
// adopted 2026-11-12) moved both numbers — a limit under ~490 transcript tokens would sit below
// the retained head alone and every continuation turn would re-trigger, which is a real property
// of the design, not an artefact of this fixture. The instruction and the nudge are the EXPORTED
// strings, because a case that pasted its own copy would keep passing after the protocol changed.
//
// The continuation run is fire-and-forget from inside `thread.idle` (see the plugin's "WHY
// THE NUDGE IS A SEND"), so it is still queued when the submission resolves; `settle` below
// waits for it. That is the one place a poll is honest: the plugin deliberately does not
// hand back a promise for the continuation, and neither does the host.
// ---------------------------------------------------------------------------

describe('context-compaction summarize flow (T9)', () => {
    const SEED = 'x'.repeat(2100);
    const PROMPT = 'go';

    // THE LARGE TRANSCRIPT the two overflow-refusal cases seed, and what its size is for NOW.
    //
    // A rung's budget is `floor + ladder × (tokens − floor)` — the ratio across the REMOVABLE
    // transcript with the irreducible floor added back (R6, 2026-11-17) — CLAMPED to the fit line
    // (the effective ceiling, or the ceiling itself when the floor sits inside the headroom band).
    // `tokens` is the BOUNDARY estimate — the transcript PLUS the catalogue floor
    // (src/harness.ts:12512 passes `toolSchemaBytes()`) — and since X1 (2026-11-17) the ladder
    // measures the same billed quantity: `floor + the request it is cutting` (see
    // `planCompactionRequest`). A cut therefore needs
    // `floor + transcript + 438 > min(fit line, floor + 0.85 × transcript)` — which an over-ceiling
    // request satisfies, because its own estimate is over the ceiling. Two relations preceded that
    // one: pre-X1 the rung was a fraction of `floor + transcript` while the measurement was the
    // transcript alone, so a catalogue-dominant conversation could never satisfy it and every rung
    // returned the request untouched (the deadlock that shipped); pre-R6 the ratio reached across
    // the floor it cannot remove, so the transcript was billed a fraction of the catalogue on top
    // and the budget fell under the smallest sendable request (pinned in the
    // `overflow-reactive trigger` cases above).
    //
    // The 300,000-character BIG_SEED (75,441 transcript tokens against a 13,282-token floor) is
    // kept because these two cases pin "the retry is strictly smaller", and a transcript that
    // dwarfs the catalogue makes the number dramatic: 89,161 billed down to 13,915. At the 2,100-
    // character `SEED` every other case here uses (526 transcript tokens) the ladder now cuts too —
    // to 13,915 billed, the digest plus the verbatim tail — which is the same request either way
    // where the provider is concerned, and the give-up line is what tells the operator the floor is
    // the problem rather than the transcript.
    const BIG_SEED = 'x'.repeat(300_000);

    // 520 TRANSCRIPT tokens plus the catalogue floor the estimate is measured against — the one
    // place this block adds the constant, so every margin in it (the 6-token crossing, and the
    // 34-token headroom the retained head leaves) stays exactly the transcript-scale number the
    // header derives.
    const LIMIT = CATALOGUE + 520;

    // THE DELEGATING ROSTER'S FLOOR, which is NOT `CATALOGUE`. A roster with a delegating agent
    // registers one more runtime tool — the `delegate` entry, 7,702 serialized bytes = 1,925.5
    // tokens — so every request that harness sends carries a 60,830-byte catalogue: 15,207.5
    // tokens, which this constant rounds UP to 15,208 (probe `Temp/coding-x1/probe-x6.ts`, the
    // same method that derived `CATALOGUE`, which it reproduces at 53,128 bytes for a writer-only
    // roster). The delegate case below caps its conversation with `DELEGATE_FLOOR + 520` so its
    // transcript budget and its crossing margin stay the numbers every sibling case uses.
    //
    // THE ONE TOKEN THIS COSTS: the writer-only catalogue is a multiple of 4 (53,128 B), so its
    // siblings state an exact `CATALOGUE + n`; the delegating catalogue is not (60,830 B), so the
    // crossing this block measures sits one token either side of the 6 its siblings state. The
    // rounding is UP, which is the side that keeps the dead-run guard honest: an understated floor
    // would cap the conversation BELOW the request's irreducible size and the pass would refuse.
    //
    // WHY IT HAS TO MOVE AT ALL (X1, 2026-11-17): the pass now refuses to start when the request's
    // irreducible size is at or above the ceiling, and a `CATALOGUE + 520` ceiling in a
    // delegating harness sits 1,926 tokens UNDER its own floor — a request no amount of clipping
    // could ever fit, so the pass there was a dead run by construction.
    const DELEGATE_FLOOR = 15_208;

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
        // C1 — the conversation's display lane, sampled from INSIDE each provider request.
        // `turn.before` has already run by the time a request leaves, so this array is the
        // mid-run visibility proof: the recorder stamps every event from here on with lane 1,
        // and that is what puts the summary's own segments on the second row of THIS turn's
        // context bar.
        const lanes: string[] = [];
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
                lanes.push(String(handle?.thread(threadId)?.contextLane));

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
        // the agent's own summary, and the nudge: 3 messages, 1,752 + 7 + 185 = 1,944 payload
        // bytes → 486 tokens of transcript, i.e. CATALOGUE + 486 against the CATALOGUE + 520
        // ceiling, and neither the 2100-character seed nor the prompt anywhere in it.
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

        // C1 — THE DISPLAY LANE, sampled mid-run and after. It was already 1 while the FIRST
        // provider request (the compaction itself) was in flight, so every event the server
        // records from that request on is stamped with lane 1 and THIS turn's context bar
        // splits at the boundary — the summary's segments sit under the pre-compaction ones.
        // One pass raises it exactly once: after the summary AND the continuation run it is
        // still 1, never 2.
        expect(lanes).toEqual(['1', '1']);
        expect(writer.thread(threadId)?.contextLane).toBe(1);

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

        // C1 — and the lane never reached the transcript: the display row number is UI
        // metadata, so NO entry above carries a `lane` key (a transport that field-selects
        // messages never sees it, and the model is sent exactly the same bytes as before).
        expect(writer.threadMessages(threadId).map((message) => 'lane' in message)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false
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
        // would otherwise still see the pre-compaction size and fire the pass again. The report
        // carries the CATALOGUE floor on the estimate side (it is the request the provider bills),
        // and the margin over the ceiling is still the 6 transcript tokens the header derives.
        expect(diagnostics[0].message).toContain(
            `~${CATALOGUE + 526} estimated tokens against an effective limit of ${CATALOGUE + 520}`
        );
        expect(diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId,
            tokens: CATALOGUE + 526,
            effective: CATALOGUE + 520,
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

    it('lifts the park when the compaction request fails and keeps the failed pass\'s turns', async () => {
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
        // its WORK but never its RECORD. `run.failed` lifts the park and the thread is
        // usable; issue 0036 R1 removed the run's `brain.messages.splice(commitIndex)`,
        // so the turns the failed pass committed stay on the record — the send's prompt
        // and the compaction instruction the model was actually shown. Re-captured from an
        // actual run: SEED, the prompt, the instruction, and nothing else. SEED itself is
        // untouched (the pass died before it withheld any turn), there is no assistant turn
        // to repair, and no summary was ever produced.
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(seen).toHaveLength(1);
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SEED },
            { role: 'user', content: PROMPT },
            { role: 'user', content: COMPACTION_INSTRUCTION }
        ]);

        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[1].message).toContain('lifted its park on thread');
        expect(diagnostics[1].message).toContain('after a failed run (phase compacting)');
        expect(diagnostics[1].data).toEqual({
            mode: 'summarize',
            threadId: thread.id,
            phase: 'compacting',
            hook: 'run.failed'
        });

        // Usable means USABLE: the next submission runs, answers, and leaves the thread
        // idle. The pass now RE-FIRES once, and that is a consequence of retention rather
        // than a broken cooldown: Rule 3 re-arms when the projection has grown by the
        // regrowth margin since the last fire, and the retained prompt + instruction rows
        // ARE that growth (the old "it does not re-fire" claim assumed the failed pass had
        // spliced them out, so the retry measured the same size and stayed cooled).
        // The retry is a 2,010-character prompt because of the size of that margin: the
        // CATALOGUE + 520 ceiling this block runs under makes it
        // `max(1, floor(13,802 × 0.05)) = 690` tokens, and the only rows that can grow the
        // projection are the 438 tokens of instruction the failed pass left on the record plus
        // the new prompt. The second boundary therefore measures CATALOGUE + 1,466
        // (2,100 + 2 + 1,752 + 2,010 = 5,864 payload bytes) against the mark
        // CATALOGUE + 526 + 690 = CATALOGUE + 1,216, and re-arms on 940 tokens of growth.
        // Re-captured from an actual run: the second instruction is in flight (still
        // included — it is what the model was just shown), and the block that pass compacted
        // (SEED, both prompts, the first instruction) is switched off by it. The answer is
        // the scripted 'later' either way, which is what keeps "usable" the contract here.
        const RETRY = `retry now ${'r'.repeat(2000)}`;
        const next = await writer.sendThreadInput(thread.id, RETRY);

        expect(next.content).toBe('later');
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: SEED, included: false },
            { role: 'user', content: PROMPT, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION, included: false },
            { role: 'user', content: RETRY, included: false },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'later' }
        ]);
    });

    // THE DEADLOCK, END TO END (2026-11-17). The transport refuses the request with the code the
    // transport and the agent's pre-request floor share (`CONTEXT_OVERFLOW_CODE` on an `error`
    // frame — the shape the built-in transport actually emits, and the one that keeps the retry
    // ladder out of it, so `retry: false` is not needed here); the run fails; the very next
    // boundary answers with a request the provider cannot refuse for the same reason.
    it('answers a size refusal with a strictly smaller compaction request on the next boundary', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const writer = harness({
            agents: {
                writer: brain(
                    flowStream(
                        [
                            [
                                {
                                    type: 'error',
                                    message: 'this request exceeds the model context window',
                                    code: CONTEXT_OVERFLOW_CODE
                                }
                            ] as HarnessStreamEvent[],
                            answer('SUMMARY'),
                            answer('resumed')
                        ],
                        seen
                    )
                )
            },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates)],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const thread = writer.createThread('writer', { label: 'Refused, then smaller' });

        writer.setThreadMessages(thread.id, [{ role: 'user', content: BIG_SEED }]);

        // REQUEST 1 — the ordinary pass, exactly as it has always been: the projection plus the
        // instruction. Nothing was shrunk, because nothing had been refused yet, and that is the
        // behaviour every case above pins.
        await expect(writer.sendThreadInput(thread.id, PROMPT)).rejects.toThrow('context window');

        expect(seen[0].messages.map((message) => String(message.content))).toEqual([
            BIG_SEED,
            PROMPT,
            COMPACTION_INSTRUCTION
        ]);

        const refusedReport = diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'overflow'
        );

        expect(refusedReport?.data).toEqual({
            mode: 'summarize',
            threadId: thread.id,
            hook: 'run.failed',
            stage: 'overflow',
            rung: 1,
            ladder: 4,
            ratio: 0.85,
            exhausted: false
        });

        // REQUEST 2 — the armed boundary. The transcript the failed pass left is BIG_SEED, the
        // prompt and the instruction the provider never saw an answer to (issue 0036 R1 keeps
        // them), and `retry now` is what the host is asking about now: 300,000 + 2 + 1,752 + 9 =
        // 301,763 payload bytes = 75,441 transcript tokens, so the boundary estimate is
        // CATALOGUE + 75,441 = 88,723 and the request the pass builds is one instruction larger,
        // 303,515 bytes = 75,879 transcript tokens.
        //
        // THE RUNG IS NOW A BUDGET THE PROVIDER COULD ACTUALLY MEET, and that is the fix. Two
        // things changed on 2026-11-17. The rung budget `13,282 + floor(0.85 × 75,441) = 77,406`
        // — the floor, plus the ratio across the 75,441 tokens of transcript this pass can
        // actually remove (R6 took the ratio off the catalogue it cannot remove) — is CLAMPED to
        // the 13,802 fit line: 85% of an over-limit size is still over the limit, so an unclamped
        // rung asks the ladder to stop at a number the provider would refuse. And the ladder
        // measures the BILLED figure, catalogue and all: 13,282 + 75,879 = 89,161 over a 13,802
        // budget, where the old transcript-only measure read 75,879 against a 75,414 target, walked
        // the whole ladder, and sent the refused request out again byte-identical. Pass A
        // (269 + 2 + 269 + 9 + 1,752 = 2,301 bytes = 576 transcript tokens, 13,858 billed) is still
        // 56 over, so the ladder drops the three head units behind one digest: 771 + 9 + 1,752 =
        // 2,532 bytes = 633 tokens, 13,915 billed — the smallest request it may send, 75,246 tokens
        // under the one that was refused.
        const next = await writer.sendThreadInput(thread.id, 'retry now');

        expect(next.content).toBe('SUMMARY');
        expect(await settle(writer, thread.id, 8)).toBe(true);

        expect(seen[1].messages.map((message) => String(message.content))).toEqual([
            `[context compaction digest] The harness removed 3 earlier turns from this request ` +
                `without a model to summarize them, because the request itself did not fit the ` +
                `context window. The removed turns are still on the record; they are simply not ` +
                `being sent. Oldest removed: ${'x'.repeat(240)} | Most recent removed: ${COMPACTION_INSTRUCTION.slice(0, 240)}`,
            'retry now',
            COMPACTION_INSTRUCTION
        ]);

        const shrinkReport = diagnostics.find(
            (report) => (report.data as { stage?: string })?.stage === 'shrink'
        );

        // All three figures are billed request size, and `floorTokens` is printed with them so the
        // line answers "why did it stop at 13,915 when the ceiling is 13,802?" without a second
        // tool: 13,282 of that request is the catalogue, the instructions and the harness turns,
        // which no transcript pass can shrink.
        expect(shrinkReport?.data).toEqual({
            mode: 'summarize',
            threadId: thread.id,
            stage: 'shrink',
            target: 13802,
            from: 89161,
            to: 13915,
            floorTokens: CATALOGUE,
            dropped: 3,
            clipped: 2,
            entries: 3
        });

        // REQUEST 3 — THE PROOF THE SHRINK COST NOTHING DURABLE. The continuation goes out with
        // the instruction, the model's own summary and the nudge, exactly as the unshrunk pass
        // above does: the digest and the clipped heads were never committed, and the summary —
        // not the shrink — is what decided that SEED and both prompts stop being sent.
        expect(seen).toHaveLength(3);
        expect(withoutIds(seen[2].messages)).toEqual([
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' },
            { role: 'user', content: CONTINUATION_NUDGE }
        ]);

        // Two parks, both lifted: the refusal stranded nothing, and neither pass left the thread
        // 'paused'.
        expect(events).toEqual(['paused', 'resumed', 'paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });

    // THE OPERATOR'S FAILURE, END TO END THROUGH THE SHIPPED TRANSPORT (2026-11-17 — the
    // coexistence check between the transport fix and this plugin).
    //
    // The case above SCRIPTS the stream event the transport emits. This one starts one level
    // further out, at the bytes a gateway writes on a committed `200 text/event-stream`, and runs
    // the chain with no scripted frame in it at all:
    //
    //   gateway error frame (`code: 'upstream_status'`, `status: 400`, the provider's own
    //   "maximum context length" line)
    //     -> `transport/openai.ts` in-stream arm, classified by the ONE matcher
    //        (`transport/provider-timeouts.ts` `isContextOverflowSignal`, T2) and emitted as
    //        `{ type: 'error', code: CONTEXT_OVERFLOW_CODE, … }`;
    //   -> `core/agent.ts` `isContextOverflowFailure` keeps it out of the retry ladder, so the
    //        gateway is asked EXACTLY ONCE per request (pinned by the fetch counts below);
    //   -> `src/harness.ts` fails the run and emits `run.failed` as
    //        `{ …runLifecycleContext(run), error: toErrorInfo(error) }` (harness.ts:14249), i.e.
    //        `payload.error.code === 'context-overflow'` — the one field the plugin switches on;
    //   -> this plugin arms rung 1 and the NEXT boundary sends a request the provider cannot
    //        refuse for the same reason: 75,879 tokens cut to 576, measured on the wire body.
    //
    // WHY THE FETCH STUB IS WORTH IT: the two fixes live in different packages-of-concern and the
    // ONLY contract between them is that payload field. A transport that stopped classifying, or
    // a `toErrorInfo` that dropped the code, would un-arm this plugin SILENTLY — every case above
    // hands the plugin the code directly and would keep passing. This case fails.
    //
    // It also pins the operator gap T4 reported: this brain declares NO `provider.contextWindow`
    // and no `modelLimits` entry, so nothing in the build knows the model's window, the headroom
    // buffer never binds, and the refusal-armed ladder is the entire recovery.
    it('arms from a gateway size refusal on the shipped transport and sends a strictly smaller retry', async () => {
        // The gateway's own frame shape: what `buildStreamErrorPayload` writes for a definite
        // upstream status (packages/underload/service/src/server/start.ts:635-703, the frame
        // pinned byte-for-byte by ../transport/openai.context-overflow.test.ts), including the
        // `param: null` the producer sends and the absence of `errno`.
        const providerLine =
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens";
        const refusalFrame = {
            error: {
                message: `upstream localhost:8800/v1/chat/completions returned HTTP 400 before the first chunk: ${providerLine}`,
                type: 'stream_error',
                code: 'upstream_status',
                status: 400,
                param: null
            }
        };

        const sseBody = (frames: readonly unknown[]): string =>
            `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;

        // A normal completion in the shape `openAICompatible` parses: a content delta, a
        // `finish_reason`, and the `[DONE]` sentinel the transport's truncation guard wants. NO
        // `usage` block, so no hybrid anchor is taken and the estimate stays the payload-bytes
        // heuristic every number in this file is derived from — the serialized request, the declared
        // tool schema included, divided by 4 (compaction T5.4 anchors only on a reported count).
        const completionBody = (text: string): string =>
            sseBody([
                { choices: [{ delta: { content: text } }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] }
            ]);

        const streamBody = (text: string): ReadableStream<Uint8Array> => {
            const encoder = new TextEncoder();

            return new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(text));
                    controller.close();
                }
            });
        };

        // One response per provider REQUEST, in order: the refusal, the shrunk compaction answer,
        // the continuation. A FOURTH request throws instead of replaying the last body — an
        // overflow that walked the retry ladder would re-send the same bytes, which is the exact
        // defect the transport half of this chain removes.
        const responses = [
            sseBody([refusalFrame]),
            completionBody('SUMMARY'),
            completionBody('resumed')
        ];
        // Every request BODY the wire actually carried: the provider's own view, which is the only
        // place "strictly smaller" is a fact about the world rather than about a plugin's log.
        const wire: Record<string, unknown>[] = [];

        const fetchMock = vi.fn(async (_input: unknown, init?: { body?: string }) => {
            wire.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

            const body = responses.shift();

            if (body === undefined) {
                throw new Error(
                    `The provider was asked ${wire.length} times: a classified overflow must cost ` +
                        `exactly one attempt per request.`
                );
            }

            return new Response(streamBody(body), { status: 200 });
        });

        vi.stubGlobal('fetch', fetchMock);

        const events: string[] = [];
        const estimates: number[] = [];
        const diagnostics: HarnessDiagnosticEvent[] = [];
        const failures: Array<{ threadId: string | undefined; error: unknown }> = [];

        // A HOST plugin on the SAME hook the built-in uses, so the payload asserted below IS the
        // payload the built-in was handed, not a reconstruction of it.
        const watcher: HarnessPlugin = {
            name: 'overflow-watcher',
            setup: (api) => {
                api.on('run.failed', (payload) => {
                    failures.push({ threadId: payload.threadId, error: payload.error });
                });
            }
        };

        const wireMessages = (index: number): string[] =>
            (wire[index].messages as { content: string }[]).map((message) => message.content);

        // The provider's byte count for one request — the comparison the operator reads as "it
        // sent less the second time".
        const wireChars = (index: number): number => JSON.stringify(wire[index].messages).length;

        const writer = harness({
            agents: {
                writer: agent({
                    // The model of the measured session, with NO `provider.contextWindow`: no
                    // window is declared anywhere, so the buffer and the first-rung pre-shrink
                    // have nothing to bind to (see the operator gap in the memo above).
                    model: 'local/basalt',
                    stream: openAICompatible({ baseURL: 'http://localhost:8800/providers/private/v1' })
                })
            },
            pluginSettings: summarizeSettings(),
            plugins: [probe(events, estimates), watcher],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        try {
            const thread = writer.createThread('writer', { label: 'Refused on the wire' });

            writer.setThreadMessages(thread.id, [{ role: 'user', content: BIG_SEED }]);

            // REQUEST 1 — the ordinary pass (nothing had been refused yet), refused by the
            // gateway. The frame is terminal on ONE attempt, and the thrown message leads with
            // the machine code, which is what `toErrorInfo` turns into `error.code` below.
            await expect(writer.sendThreadInput(thread.id, PROMPT)).rejects.toThrow('context-overflow: ');

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(wireMessages(0)).toEqual([BIG_SEED, PROMPT, COMPACTION_INSTRUCTION]);

            // THE RUN-LEVEL SIGNAL, read off the hook payload the built-in consumed. The key set
            // is pinned exactly because `toErrorInfo` emits `{ message, code }` and nothing else,
            // and the code is the ONE field the reactive arm matches (`code ===
            // CONTEXT_OVERFLOW_CODE` in the plugin's `runFailed`). The prefix is the other half:
            // it is the fallback the plugin (and `core/agent.ts`) apply to a relay that arrives
            // without a code, so it has to stay in the message too.
            expect(failures).toHaveLength(1);
            expect(failures[0].threadId).toBe(thread.id);
            expect(Object.keys(failures[0].error as object)).toEqual(['message', 'code']);
            expect((failures[0].error as { code?: string }).code).toBe(CONTEXT_OVERFLOW_CODE);
            expect(
                String((failures[0].error as { message?: string }).message).startsWith(
                    `${CONTEXT_OVERFLOW_CODE}: `
                )
            ).toBe(true);

            // The arm itself, reported once for this thread with the rung the ladder picked.
            expect(
                diagnostics.filter((report) => (report.data as { stage?: string })?.stage === 'overflow')
                    .length
            ).toBe(1);

            // REQUEST 2 — the armed boundary, one fetch. Same arithmetic the scripted case above
            // pins (the transcript, the estimate and the rung are identical): BIG_SEED + PROMPT +
            // the instruction the provider never saw an answer to + `retry now` = 301,763 payload
            // bytes = 75,441 transcript tokens on top of the CATALOGUE floor = an 88,723 boundary
            // estimate. The rung budget (13,282 + floor(0.85 × 75,441) = 77,406) is clamped to the
            // 13,802 fit line, and the ladder measures
            // 13,282 + 75,879 = 89,161 billed, so the ladder keeps going past pass A (13,858
            // billed, 56 over) and drops the three head units behind one digest: 13,915 billed, the
            // smallest request it may send and 75,246 under what the gateway refused.
            const next = await writer.sendThreadInput(thread.id, 'retry now');

            expect(next.content).toBe('SUMMARY');
            expect(await settle(writer, thread.id, 8)).toBe(true);

            expect(wireMessages(1)).toEqual([
                `[context compaction digest] The harness removed 3 earlier turns from this request ` +
                    `without a model to summarize them, because the request itself did not fit the ` +
                    `context window. The removed turns are still on the record; they are simply not ` +
                    `being sent. Oldest removed: ${'x'.repeat(240)} | Most recent removed: ${COMPACTION_INSTRUCTION.slice(0, 240)}`,
                'retry now',
                COMPACTION_INSTRUCTION
            ]);

            expect(
                diagnostics.find((report) => (report.data as { stage?: string })?.stage === 'shrink')
                    ?.data
            ).toEqual({
                mode: 'summarize',
                threadId: thread.id,
                stage: 'shrink',
                target: 13802,
                from: 89161,
                to: 13915,
                floorTokens: CATALOGUE,
                dropped: 3,
                clipped: 2,
                entries: 3
            });

            // THE PROVIDER'S OWN MEASUREMENT of the contract: the second request is smaller than
            // the one that was refused, on the bytes that left this process.
            expect(wireChars(1)).toBeLessThan(wireChars(0));

            // Three fetches for two submits and one continuation: the refusal cost ONE attempt,
            // the shrunk pass ONE, the nudge ONE — no ladder anywhere.
            expect(fetchMock).toHaveBeenCalledTimes(3);

            // And the pass that recovered is a normal pass: two parks, both lifted.
            expect(events).toEqual(['paused', 'resumed', 'paused', 'resumed']);
            expect(writer.thread(thread.id)?.status).toBe('idle');
        } finally {
            vi.unstubAllGlobals();
        }
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

        // The trigger measured the PROJECTION, not the transcript: `CATALOGUE + 526` (the 526 of
        // the seed and the prompt, on top of the catalogue floor), not `CATALOGUE + 829` with the
        // already-withheld turn counted. A live estimate that read canonical history would fire
        // compaction on conversations that are already compacted.
        expect(diagnostics[0].data).toMatchObject({ tokens: CATALOGUE + 526, effective: CATALOGUE + 520 });

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

        // The next submission grows the conversation past the trigger again (~554 against
        // 520). The cooldown does NOT hold it back, because the turn that ran on the compacted
        // head measured ~479 — under the limit — and cleared it. So the second pass is a real
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

        // C1 — two compactions, two boundaries: each pass raised the lane exactly once, so this
        // conversation now sits on lane 2 (a bar renders its turns as rows 0, 1 and 2, split at
        // the two turns the compactions happened in).
        expect(writer.thread(threadId)?.contextLane).toBe(2);

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

        // C1 — the DISPLAY LANE is durable, the same way the withheld flags are. The pass that
        // happened before the restart left lane 1 on the persisted HOST-thread record, so the
        // restored conversation resumes on that lane: its bar keeps the two rows the
        // compaction created, and the NEXT pass raises 1 -> 2 instead of minting a second row
        // from 0. Both sides are asserted: the document's field, and what the live record
        // reads back after `restore()`.
        expect(
            (snapshot.threads ?? []).find((entry) => entry.id === threadId)?.contextLane
        ).toBe(1);
        expect(fresh.thread(threadId)?.contextLane).toBe(1);

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
            // The ceiling has to be a figure a compaction pass could REACH, or the case would
            // measure the wrong refusal: X1 (2026-11-17) added the dead-run guard, and a 100-token
            // ceiling under a 13,282-token catalogue is unreachable by clipping no matter what
            // `minTokens` says. `CATALOGUE + 100` puts the ceiling just above the floor, so the
            // transcript is the term that crosses and the floor is the only thing that stops the
            // pass — which is what this case is named for.
            contextLimit: CATALOGUE + 100,
            // The summarize floor judges the SAME figure the trigger does, so a 200-token floor
            // would be beaten by any request that carries a catalogue: this fixture wants the
            // floor ABOVE this conversation, which is `CATALOGUE + 200` — 97 tokens above the
            // `CATALOGUE + 103` the first turn measures.
            minTokens: CATALOGUE + 200,
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

        // 412 chars = 103 transcript tokens, i.e. a `CATALOGUE + 103` boundary estimate: 3 tokens
        // over the `CATALOGUE + 100` ceiling, so the trigger fires, and 97 tokens under the
        // CATALOGUE + 200 floor, so the round trip is refused as too small to be worth a summary.
        expect((await writer.sendThreadInput(thread.id, 'x'.repeat(412))).content).toBe('ok');
        expect(seen).toHaveLength(1);
        expect(noInstruction(seen[0])).toBe(true);

        // The same conversation with a 5-character prompt (420 + 5 = 425 payload bytes = 107
        // transcript tokens), still 95 tokens under the CATALOGUE + 200 floor, still refused. A
        // RECORDED cooldown would have suppressed this turn on the margin alone, and the next
        // turn proves nothing was recorded at all.
        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'x'.repeat(420) }]);
        expect((await writer.sendThreadInput(thread.id, 'again')).content).toBe('fine');
        expect(seen).toHaveLength(2);
        expect(seen.map(noInstruction)).toEqual([true, true]);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // The floor goes to 0 — the same live re-read every other setting gets — and the very
        // next turn compacts. The size does not move past the margin (420 + 5 and 424 + 3 both
        // measure 107 transcript tokens, and the regrowth margin at this ceiling is
        // `max(1, floor(13,382 × 0.05)) = 669`), so a cooldown recorded by either refusal would
        // have held this turn back.
        stored.minTokens = 0;
        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'x'.repeat(424) }]);

        expect((await writer.sendThreadInput(thread.id, 'now')).content).toBe('summarised');
        expect(String(seen[2].messages[seen[2].messages.length - 1].content)).toBe(COMPACTION_INSTRUCTION);

        // Out of the way for the continuation run: at this scale (the retained head alone is
        // `CATALOGUE + 486` against a `CATALOGUE + 100` ceiling) the next boundary would compact
        // again, which is correct behaviour but not what this case is measuring.
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

        // THE TRIMMER ARM, pinned rather than ambient: the shipped `supersededTurns` horizon
        // counts TOOL TURNS above a unit and protects the newest N (default 2), and this
        // fixture's failed unit has exactly one newer tool turn above it — so under the shipped
        // default the trimmer never looks at it and the D1 interaction has nothing to measure.
        // Horizon 0 is the same rule with its protection switched off; the default itself is
        // pinned in src/plugin/context-trimmer.test.ts.
        const trimmerStored: Record<string, number | string | boolean> = { supersededTurns: 0 };

        return {
            get: (plugin, key) =>
                plugin === 'context-compaction' ? stored[key] : plugin === 'context-trimmer' ? trimmerStored[key] : undefined
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
            pluginSettings: summarizeSettings({ contextLimit: DELEGATE_FLOOR + 520 }),
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
        // LINEAGE (2026-11-13): the scout posts INTO `thread`, so `thread` must be in the
        // scout's lineage for that send to be admitted at all — it is created as the
        // owner of the scout's thread, which is exactly the relationship the test relies
        // on (a delegate reporting back into the conversation that owns its brief).
        const scoutThread = writer.createThread('scout', {
            label: 'Delegate',
            ownerThreadId: thread.id
        });

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
        // CATALOGUE + 520 limit — 2200 characters of failure text puts the projection at
        // CATALOGUE + 573 tokens, 53 transcript tokens over the trigger, the same margin over the
        // trigger the seed gives the other cases in this block. The trimmer has never seen this
        // transcript, so its plan is non-empty exactly on the round the compactor parks.
        writer.setThreadMessages(thread.id, [
            { role: 'user', content: 'open both' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
            },
            {
                role: 'tool',
                content: `Tool "read" failed: ${'E'.repeat(2200)}`,
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
                messages: turnProjection(400),
                calls,
                threadId: 'thread-1'
            })
        );
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);

        // C1 — the bump is part of STARTING a pass: the lane is already 1 while the answer is
        // still being produced, which is what lets the recorder stamp the summary's own events
        // with it (see the flow cases for the mid-run proof).
        expect(fake.lanes.get('thread-1')).toBe(1);

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
                messages: turnProjection(400),
                calls,
                threadId: 'thread-1'
            })
        );

        // The pass is open: parked, and the instruction committed into history AND this request.
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        // C1 — and the lane it raised to mark the boundary.
        expect(fake.lanes.get('thread-1')).toBe(1);
        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        passes.runFinished({
            ...runLifecycle,
            message: { role: 'assistant', content: 'not a compaction answer' }
        });

        // The probe comes FIRST: the net has to look at the transcript before it may call this
        // pass abandoned (the fake's `threads.messages` refuses, which is the plugin's "cannot
        // read → no answer" branch, so the abandon path is what runs). The restore then comes
        // before the lift (the lane goes back before the park is lifted, so no event can be
        // recorded against a phantom row), then the lift, then the report.
        expect(fake.touches).toEqual([
            'threads.messages',
            'threads.setContextLane:thread-1:0',
            'threads.resume',
            'report.diagnostic'
        ]);
        // C1 — an abandoned pass produced NO compaction, so the bump is undone: the key goes
        // back to absent (lane 0), because a lane is a claim that a boundary happened.
        expect(fake.lanes.has('thread-1')).toBe(false);
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

    // THE SECONDARY DEFECT: a net must not swallow a pass whose answer SURVIVED.
    //
    // WHY THIS CASE EXISTS. Both nets used to CLEAR a `compacting` phase unconditionally, and the
    // `thread.idle` that fires LATER IN THE SAME terminal `finally` (src/harness.ts:13821, after
    // `run.finished`) is gated on `finishing` (../plugins/context-compaction.plugin.ts:1724).
    // Clearing the phase therefore destroyed the finalize AND the continuation without a word:
    // the superseded range stayed in the model's context forever, and the conversation sat idle
    // mid-task with its answer owed to nobody. The state is reachable whenever `turn.after` never
    // got to hand the phase on although the answer DID land — a handler subscribed before this one
    // throws inside the same `turn.after` emit (src/harness.ts:12727-12740).
    //
    // The fake above cannot express that transcript: its `threads.messages` throws, which is the
    // plugin's "cannot read → nothing to fold" branch the case above pins. So this case hands the
    // api a real transcript and asserts the whole carry-through — the net PROMOTES, the idle hook
    // writes the range and sends the nudge, and the lane keeps the boundary it claimed.
    it('carries a compacting pass whose answer survived to the idle finalize instead of idling silently', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // The pass opens exactly as the shipped trigger opens it: `compacting`, parked, lane 1.
        await passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                messages: turnProjection(400),
                calls: [],
                threadId: 'thread-1'
            })
        );

        // The conversation ALREADY holds both ends of the range: the superseded turn, the injected
        // instruction, and the prose answer `turn.after` never got to promote.
        const transcript: HarnessMessage[] = [
            { role: 'user', content: 'question' },
            { role: 'user', content: COMPACTION_INSTRUCTION },
            { role: 'assistant', content: 'SUMMARY' }
        ];
        const written: HarnessMessage[][] = [];
        const sent: string[] = [];

        fake.api.threads.messages = (threadId) => {
            fake.touches.push('threads.messages');

            return transcript.map((message) => ({ ...message }));
        };
        fake.api.threads.replaceMessages = (threadId, messages) => {
            fake.touches.push('threads.replaceMessages');
            written.push(messages.map((message) => ({ ...message })));
        };
        fake.api.threads.send = (threadId, input) => {
            fake.touches.push('threads.send');
            sent.push(input);

            return Promise.resolve({ role: 'assistant', content: 'continuation' } as HarnessAssistantMessage);
        };

        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        passes.runFinished({
            ...runLifecycle,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        // Probe, lift, report — and NO lane revert, because this pass DID compact the conversation.
        expect(fake.touches).toEqual(['threads.messages', 'threads.resume', 'report.diagnostic']);
        expect(fake.lanes.get('thread-1')).toBe(1);
        expect(fake.diagnostics).toHaveLength(1);
        expect(fake.diagnostics[0].message).toContain('carried to the idle finalize');
        expect(fake.diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-1',
            hook: 'run.finished',
            phase: 'finishing'
        });

        // THE POINT: the `thread.idle` that follows in the same `finally` still finds a phase, so
        // it writes the range (the turn before the instruction stops being sent; the instruction
        // and the answer stay), un-parks, and sends the continuation nudge.
        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        passes.threadIdle({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            sequence: 1,
            status: 'idle'
        });

        expect(fake.touches).toEqual([
            'threads.messages',
            'threads.replaceMessages',
            'report.diagnostic',
            'threads.resume',
            'threads.send'
        ]);
        expect(written).toEqual([
            [
                { role: 'user', content: 'question', included: false },
                { role: 'user', content: COMPACTION_INSTRUCTION },
                { role: 'assistant', content: 'SUMMARY' }
            ]
        ]);
        expect(sent).toEqual([CONTINUATION_NUDGE]);
        expect(fake.diagnostics).toHaveLength(1);
        expect(fake.diagnostics[0].message).toContain('compacted thread thread-1 itself');
        // The boundary this pass created stays claimed (C1).
        expect(fake.lanes.get('thread-1')).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// THE DELEGATED IN-RUN CONTINUATION, at the handler level (T12/F1).
//
// WHY THIS BLOCK EXISTS. The shipped file had NO plugin-level case for the in-run continuation:
// the shared fake answers `threads.steer` by recording the touch and THROWING
// (src/plugin/context-compaction.test.ts:269), so the delegated path could only ever be measured
// end-to-end, and the end-to-end file watched the delivered ANSWER rather than the request the
// continuation turn was asked with. That is the gap F1 fell through: with the nudge drained into
// the transcript ahead of the finalize (src/harness.ts:12669 -> `emitTurnBefore` :12182) and
// sharing the instruction's marker, the range anchored on the nudge, `answerIndex` was -1 and
// the instruction plus the summary were withheld — the child was asked with the nudge alone,
// durably, and still answered correctly, so every existing green stayed green.
//
// These cases pin the request view itself: [instruction, summary, nudge], the inclusion flags
// behind it, the finalize indices, and one lane bump for the pass. The end-to-end counterpart is
// src/harness.compaction-delegation.test.ts, which now asserts the same view from the provider's
// side.
// ---------------------------------------------------------------------------

describe('context-compaction delegated in-run continuation (T12/F1)', () => {
    // The identity a run started by a tool reports: depth 2, the delegation chain below a host
    // submission (src/harness.ts:13315-13320) — the dispatch condition for the in-run path.
    const childLifecycle = { threadId: 'thread-2', agent: 'researcher', depth: 2, input: 'dig' };

    // The child's transcript at the continuation boundary: superseded history, this pass's
    // instruction, its summary, and the nudge the queue drain appended before this boundary.
    const childEntries = (): HarnessContextEntry[] => [
        entryOf(0, { role: 'user', content: 'dig into the seeded report' }),
        entryOf(1, { role: 'user', content: COMPACTION_INSTRUCTION }),
        entryOf(2, { role: 'assistant', content: 'SUMMARY' }),
        entryOf(3, { role: 'user', content: CONTINUATION_NUDGE })
    ];

    // What the model is actually sent: an entry whose `included` flag was switched off by
    // `setIncluded` is withheld from the request, so this IS the request view.
    const requestView = (entries: readonly HarnessContextEntry[]): string[] =>
        entries
            .filter((entry) => entry.included !== false)
            .map((entry) => String((entry.message as { content?: unknown }).content ?? ''));

    // The shared fake refuses `threads.steer` (see the block header); the in-run path needs the
    // receipt the real `steerThread` hands back (src/harness.ts:7407-7421).
    const steerInto = (
        fake: ReturnType<typeof createFakeApi>,
        text: string[]
    ): void => {
        fake.api.threads.steer = (threadId, input) => {
            fake.touches.push('threads.steer');
            text.push(input);

            return { threadId, queued: true };
        };
    };

    it('queues the continuation into the child run and asks the next turn with instruction, summary and nudge', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const steered: string[] = [];

        steerInto(fake, steered);

        // THE PASS opens on the child (parked, instruction committed, lane raised to 1).
        const openCalls: string[] = [];

        await passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                messages: turnProjection(400),
                calls: openCalls,
                threadId: 'thread-2',
                agent: 'researcher'
            })
        );
        expect(openCalls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(fake.lanes.get('thread-2')).toBe(1);

        // THE BUMP, recorded exactly once (one read to know where the lane is, one write to raise
        // it), at the instruction commit (C1).
        expect(fake.touches.filter((entry) => entry.includes('ContextLane'))).toEqual([
            'threads.getContextLane:thread-2',
            'threads.setContextLane:thread-2:1'
        ]);

        // THE ANSWER lands on a depth-2 turn: lift, then the nudge is queued INTO the live run —
        // one `threads.steer`, no `threads.send`, and the report says which run owns the
        // continuation now.
        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        passes.turnAfter({
            ...childLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        expect(fake.touches).toEqual(['threads.resume', 'threads.steer', 'report.diagnostic']);
        expect(steered).toEqual([CONTINUATION_NUDGE]);
        expect(fake.diagnostics).toHaveLength(1);
        expect(fake.diagnostics[0].message).toContain(
            'answered its compaction instruction on turn 2'
        );
        expect(fake.diagnostics[0].message).toContain(
            'on the continuation turn this same run now owns'
        );
        expect(fake.diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-2',
            iteration: 2,
            continuedInRun: true
        });

        // THE CONTINUATION BOUNDARY: the same run, one more turn, and the nudge already in the
        // entry list — the state F1 mis-anchored on.
        const entries = childEntries();
        const calls: string[] = [];

        fake.diagnostics.length = 0;

        passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                messages: turnProjection(400),
                entries,
                calls,
                threadId: 'thread-2',
                agent: 'researcher'
            })
        );

        // THE RANGE: only the superseded turn goes. The instruction, the summary and the nudge
        // are the retained head — the same contract the host path pins at :2752-2756 (lazy
        // in-run) and :3387-3391 (out-of-band).
        expect(calls).toEqual(['setIncluded:0:false']);
        expect(requestView(entries)).toEqual([COMPACTION_INSTRUCTION, 'SUMMARY', CONTINUATION_NUDGE]);

        // THE FINALIZE REPORT, with the indices that prove the anchor: `answerIndex: -1` (the
        // pre-fix answer) here means the nudge became the anchor and the head was withheld.
        expect(fake.diagnostics).toHaveLength(1);
        expect(fake.diagnostics[0].message).toContain(
            'context-compaction compacted thread thread-2 itself: 1 of 4 entry(ies) stop being sent'
        );
        expect(fake.diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-2',
            path: 'turn.before',
            instructionIndex: 1,
            answerIndex: 2,
            disabled: [0],
            total: 4
        });

        // ONE bump for the pass: the range was written, so the undo is dropped and no second
        // boundary appears (the value is still 1, and the continuation boundary wrote no lane at
        // all), and the finalize consumed the phase — a still-over-limit child does not start
        // another pass on its continuation turn.
        expect(fake.lanes.get('thread-2')).toBe(1);
        expect(fake.touches.filter((entry) => entry.includes('ContextLane'))).toEqual([]);
    });

    it('falls back to the out-of-band nudge when the conversation refuses to queue it', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const steered: string[] = [];

        // A `queued: false` receipt (`src/harness.ts:7407-7413`: idle conversation, no live run)
        // is the shape the plugin must NOT treat as a continuation.
        fake.api.threads.steer = (threadId, input) => {
            fake.touches.push('threads.steer');
            steered.push(input);

            return { threadId, queued: false, reason: 'idle' };
        };

        await passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                messages: turnProjection(400),
                calls: [],
                threadId: 'thread-2',
                agent: 'researcher'
            })
        );

        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        passes.turnAfter({
            ...childLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        // Lift, the refused steer, the refusal report, then the ordinary hand-off report — and no
        // `continuedInRun` marker, because nothing was queued.
        expect(fake.touches).toEqual([
            'threads.resume',
            'threads.steer',
            'report.diagnostic',
            'report.diagnostic'
        ]);
        expect(steered).toEqual([CONTINUATION_NUDGE]);
        expect(fake.diagnostics[0].message).toContain('could not queue the compaction continuation');
        expect(fake.diagnostics[0].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-2',
            iteration: 2,
            stage: 'continue'
        });
        expect(fake.diagnostics[1].data).toEqual({
            mode: 'summarize',
            threadId: 'thread-2',
            iteration: 2
        });

        // The run ends on the summary, so the idle hook is the one that owns the finalize and the
        // nudge (the pre-existing host-shaped flow, unchanged). Under this fake the transcript
        // read refuses — the plugin's "cannot read" branch — so the observable half is the read
        // and the lift, exactly as in the `finishing`-phase case above; the range and the nudge
        // are pinned by the `run-terminal nets` cases (the transcript-backed one among them).
        fake.touches.length = 0;

        passes.threadIdle({
            id: 'thread-2',
            agent: 'researcher',
            origin: 'host',
            sequence: 1,
            status: 'idle'
        });

        expect(fake.touches).toEqual(['threads.messages', 'threads.resume']);
    });
});

// ---------------------------------------------------------------------------
// C1 — THE DISPLAY LANE: one bump per SUMMARIZE PASS, and the undo
//
// WHY THESE CASES EXIST. The context bar paints one stacked row per display lane, and the
// lane of a recorded event is the conversation's CURRENT lane at record time
// (../server/protocol.ts `SessionTurnEvent.lane`). So the boundary a compaction creates is
// only VISIBLE if the lane moves at the moment the pass STARTS: an increment at the finalize
// would land after the turn's last event, and the pre-compaction segments and the summary
// would sit in two different turns' bars — no bar would ever show two rows. The cases below
// pin that moment, one bump per pass (never two), and every path that must UNDO a bump that
// produced no compaction. The end-to-end proof (a real run, lane visible while the answer is
// in flight) is in the summarize-flow block above.
// ---------------------------------------------------------------------------

describe('context-compaction display lane (C1)', () => {
    const runLifecycle = { threadId: 'thread-1', agent: 'writer', depth: 1, input: 'go' };

    // The thread-idle payload, in the shape the real `thread.idle` hook hands out (a
    // DETACHED `HarnessThreadRecord`).
    const idleOf = () => ({
        id: 'thread-1',
        agent: 'writer',
        origin: 'host' as const,
        sequence: 1,
        status: 'idle' as const
    });

    // Every lane touch, in order — the assertions ask for this slice instead of comparing a
    // whole `touches` list, because the settings reads a trigger pays are not this feature's
    // business.
    //
    // WHY EACH TURN BELOW ALSO CARRIES `messages: turnProjection(N)` (X1, 2026-11-17): a lane
    // bump only exists if a pass started, and a summarize pass only starts when clipping could
    // actually help — so these fixtures state that the transcript IS the request they claim,
    // rather than a 2-token projection riding on a hand-written 400-token estimate (which the
    // dead-run guard reads as a catalogue-dominated request and refuses). See `turnProjection`.
    const laneTouches = (touches: readonly string[]): string[] =>
        touches.filter((entry) => entry.includes('ContextLane'));

    it('raises the lane at the instruction commit, before the pass report', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls })
        );

        // The pass started: park, instruction into history AND into this request...
        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        // ...and the lane, read then raised by exactly one. The order below is the whole
        // contract: the bump happens AFTER the commit that could still fail and BEFORE the
        // report, so a pass that committed has already moved the boundary by the time this
        // hook releases the request the answer arrives on.
        expect(fake.lanes.get('thread-1')).toBe(1);
        expect(laneTouches(fake.touches)).toEqual([
            'threads.getContextLane:thread-1',
            'threads.setContextLane:thread-1:1'
        ]);
    });

    it('keeps the bump when the lazy finalize writes the range, and a second pass raises it again', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // Pass 1 opens.
        const started: string[] = [];

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls: started })
        );
        expect(fake.lanes.get('thread-1')).toBe(1);

        // The answer landed, so the phase is `finishing`; the run then KEPT GOING, which is
        // the shape `finalizeInRequest` owns — the next boundary writes the range through the
        // flags. Its transcript is a compacted head: history, instruction, answer.
        passes.turnAfter({
            ...runLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        const finalized: string[] = [];

        passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                messages: turnProjection(400),
                calls: finalized,
                entries: [
                    entryOf(0, { role: 'user', content: 'question' }),
                    entryOf(1, { role: 'user', content: COMPACTION_INSTRUCTION }),
                    entryOf(2, { role: 'assistant', content: 'SUMMARY' })
                ]
            })
        );

        // The range was written (the history before the instruction stops being sent), so the
        // compaction is REAL and its lane stays at 1 — the finalize never raises a second row.
        expect(finalized).toEqual(['setIncluded:0:false']);
        expect(fake.lanes.get('thread-1')).toBe(1);

        // A fresh crossing later in the same conversation (under the limit first, which clears
        // the cooldown, then over it) is a SECOND boundary, so it raises a second row.
        passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 10, currentTokens: 10, messages: turnProjection(10), calls: [] })
        );

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls: [] })
        );
        expect(fake.lanes.get('thread-1')).toBe(2);
    });

    it('reverts the bump when the run fails mid-pass', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls: [] })
        );
        expect(fake.lanes.get('thread-1')).toBe(1);

        // The failed pass produced no compaction: its injected instruction may be RETAINED
        // in the conversation (issue 0036 R1) but no summary ever landed, so the lane goes
        // back to where it was (absent = 0), not one row too low.
        passes.runFailed({
            ...runLifecycle,
            error: { message: 'provider exploded' } as never
        });

        expect(fake.lanes.has('thread-1')).toBe(false);
    });

    it('reverts the bump when the instruction vanished before the lazy finalize', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls: [] })
        );
        passes.turnAfter({
            ...runLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        // The next boundary finds NO instruction (the run rolled it back, or a host rewrote
        // the transcript), so the pass closes with nothing withheld — and nothing to show.
        const calls: string[] = [];

        passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls })
        );

        expect(calls).toEqual([]);
        expect(fake.lanes.has('thread-1')).toBe(false);
    });

    it('drops the undo for a purged conversation instead of writing a lane onto it', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls: [] })
        );
        passes.turnAfter({
            ...runLifecycle,
            iteration: 2,
            message: { role: 'assistant', content: 'SUMMARY' }
        });

        // `threads.messages` refuses here (the fake's `skip`), which is the plugin's
        // unknown/purged-thread branch: the conversation, and the lane with it, is gone, so
        // the marker is dropped WITHOUT a write attempt. One touch, and it is the read.
        fake.touches.length = 0;
        fake.diagnostics.length = 0;
        passes.threadIdle(idleOf());

        expect(fake.touches).toEqual(['threads.messages', 'threads.resume']);
        expect(laneTouches(fake.touches)).toEqual([]);
        expect(fake.lanes.get('thread-1')).toBe(1);
        expect(fake.diagnostics).toHaveLength(0);
    });

    it('takes only a diagnostic when the lane write refuses, and the compaction still starts', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        // A refused lane write is a bar problem, not a context problem: the instruction is
        // committed and the pass proceeds, and the operator is told the rows will not show.
        fake.failLanes(true);

        const calls: string[] = [];

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls })
        );

        expect(calls).toEqual(['pause', 'replaceHistory', 'setTranscript']);
        expect(fake.lanes.size).toBe(0);
        expect(fake.diagnostics).toHaveLength(2);
        expect(fake.diagnostics[0].message).toContain(
            'could not raise the display lane of thread thread-1'
        );
        expect(fake.diagnostics[1].message).toContain('parked thread thread-1');
    });

    it('reports a revert that refuses without throwing out of the run-terminal net', async () => {
        const fake = createFakeApi(250, { mode: 'summarize', minTokens: 0 });
        const passes = createContextCompactionPasses(fake.api);

        await passes.turnBefore(
            createFakeTurn({ api: fake.api, estimatedTokens: 400, currentTokens: 400, messages: turnProjection(400), calls: [] })
        );
        expect(fake.lanes.get('thread-1')).toBe(1);

        // The pass is abandoned and the undo itself is refused: two reports, in this order
        // (the failed restore, then the pass it belongs to), and a hook that never throws.
        fake.failLanes(true);
        fake.touches.length = 0;
        fake.diagnostics.length = 0;

        expect(() =>
            passes.runFinished({ ...runLifecycle, message: { role: 'assistant', content: 'x' } })
        ).not.toThrow();

        expect(fake.diagnostics).toHaveLength(2);
        expect(fake.diagnostics[0].message).toContain(
            'could not restore the display lane of thread thread-1'
        );
        expect(fake.diagnostics[1].message).toContain('abandoned its summarize pass');
    });

    it('never touches a lane in exclude mode, where a bump would fragment the bar', async () => {
        // The DEFAULT seeded by `createFakeApi` is `exclude`, which is what makes this the
        // shipped prune path: it fires per over-limit turn and prunes one unit at a time, so
        // a lane per pass would stack a thin row for every prune. `minTokens`/`safetyTurns`
        // are seeded exactly as the other prune cases do (the defaults keep this transcript's
        // one superseded unit inside the horizon, and a pass that withheld nothing would prove
        // nothing about lanes).
        const fake = createFakeApi(250, { minTokens: 10, safetyTurns: 0 });
        const passes = createContextCompactionPasses(fake.api);
        const calls: string[] = [];

        await passes.turnBefore(
            createFakeTurn({
                api: fake.api,
                estimatedTokens: 400,
                currentTokens: 400,
                messages: turnProjection(400),
                calls,
                entries: prunableEntries()
            })
        );

        // A real prune pass ran (the one superseded unit was withheld — leader AND result,
        // because one flag write moves one entry now)...
        expect(calls).toEqual(['pause', 'setIncluded:1:false', 'setIncluded:2:false', 'resume']);
        // ...and it never asked for a lane, let alone raised one.
        expect(fake.lanes.size).toBe(0);
        expect(laneTouches(fake.touches)).toEqual([]);
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

    // DEFECT F1 (found by review, 2026-11-16): the continuation nudge carries the SAME marker
    // prefix as the instruction (`COMPACTION_MARKER` feeds both exports, and the case at the end
    // of this describe pins both prefixes), so the anchor scan must not stop on it. On the
    // delegated in-run continuation the nudge is drained into the transcript BEFORE the boundary
    // that writes the range (src/harness.ts:12669 -> `emitTurnBefore` :12182), so the LAST
    // marker-prefixed entry IS the nudge: anchoring there gave `answerIndex: -1` and disabled the
    // instruction and the summary, so the continuation turn was asked with the nudge alone.
    it('does not anchor on a continuation nudge: the instruction and its summary survive', () => {
        expect(
            planCompactionRetention([
                turn('user', 'old work'),
                turn('user', INSTRUCTION),
                turn('assistant', 'the summary'),
                // The drained nudge, sitting after the answer exactly as the in-run continuation
                // puts it there.
                turn('user', CONTINUATION_NUDGE)
            ])
        ).toEqual({ instructionIndex: 1, answerIndex: 2, disabled: [0] });

        // A nudge with no instruction of its own is not an anchor at all: there is nothing to
        // withhold, rather than withholding the whole conversation up to the nudge.
        expect(
            planCompactionRetention([
                turn('user', 'old work'),
                turn('user', CONTINUATION_NUDGE),
                turn('assistant', 'an answer')
            ])
        ).toEqual({ instructionIndex: -1, answerIndex: -1, disabled: [] });

        // The second pass anchors on ITS instruction, and pass one's nudge goes with the rest of
        // that pass's superseded head — the exclusion is about the anchor, never about the range.
        expect(
            planCompactionRetention([
                turn('user', 'old'),
                turn('user', INSTRUCTION),
                turn('assistant', 'summary one'),
                turn('user', CONTINUATION_NUDGE),
                turn('assistant', 'the continuation answer'),
                turn('user', SHORT_INSTRUCTION),
                turn('assistant', 'summary two')
            ])
        ).toEqual({ instructionIndex: 5, answerIndex: 6, disabled: [0, 1, 2, 3, 4] });
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
    // `trimInvalidTools` true with `invalidToolTurns` 2, `trimThoughts` true with
    // `thoughtTurns` 2, `truncateToolRequests` false with `truncateTurns` 2,
    // `dropSupersededToolCalls` true with `supersededTurns` 2, `dropDuplicateCalls` false with
    // `duplicateTurns` 2, `invalidOutcomes` "failed,rejected", `supersedeMatch` "name", and the
    // four economy knobs `minTokens`/`minThoughtChars`/`safetyUnits`/`maxUnits` all 0). That is
    // precisely the fresh-install posture an operator gets from `GET /plugins`, which is what
    // makes the numbers below the shipped behaviour rather than a fixture arrangement.
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
    // ceil(payload bytes / 4), `core/payload-bytes.ts` for the escaping): the failed unit is 949
    // payload bytes — the 926-byte result (922 of escaped text: the 20-character
    // `Tool "read" failed: ` prefix costs 22 because its two quotes double, + the 900 E's, + its
    // 4-byte tool name) and the leader's 23 (4-byte name + the 15 characters of `{"path":"a.ts"}`,
    // whose four quotes double it to 19) — so 238 withheld tokens, the same figure the
    // `executeCompaction` case above pins for this exact fixture. The whole transcript is 1,009
    // payload bytes → 253 tokens, far over the 100-token limit (and the catalogue floor on top of
    // it), so the compaction trigger fires on the first turn of both runs.
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
        // The shipped `supersededTurns` horizon (default 2 tool turns) protects this fixture's
        // unit — there is exactly one newer tool turn above it — so the overlap is pinned with
        // the horizon switched OFF (`0`): the same rule, one step later on the timeline. The
        // shipped default is pinned in src/plugin/context-trimmer.test.ts, and the arm below
        // keeps every other switch at its declared default.
        const NO_HORIZON: TrimmerSettings = { ...TRIMMER_DEFAULT_SETTINGS, supersededTurns: 0 };
        const fingerprint: TrimmerSettings = {
            ...NO_HORIZON,
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

        expect(trimmerPlan(NO_HORIZON)).toEqual(SAME_TRIMMER_CANDIDATE);
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
            // `supersededTurns: 0` for the trimmer arm — the shared fake api is one flat store,
            // and the shipped 2-tool-turn horizon would protect this fixture's unit so the
            // overlap would never happen (see the case above for the same pin).
            const { api, diagnostics } = createFakeApi(100, {
                minTokens: 10,
                safetyTurns: 0,
                supersededTurns: 0
            });
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

            // EXACTLY ONE PASS WRITING, and since R8 one pass writing a unit means one write
            // per MEMBER of it. `calls` records every mutation control, so a second pass that
            // planned the same unit again would append `setIncluded:1:false` twice here — and a
            // pass that touched the thinking axis would add a `setReasoningIncluded:*`. Neither
            // happens: each pass re-reads the LIVE per-entry flags, and the skip is PER MEMBER —
            // both writers compute their write set as the unit's members MINUS the entries already
            // withheld (`src/core/context-pruning.ts` `includedMembersOf`, mirrored by
            // `src/plugins/context-trimmer.plugin.ts` `includedMembersOf`) and propose a unit only
            // when that list is NON-EMPTY (the trimmer's `planTrimmedUnits` step (1), core's rule 5).
            // Both members are off here, so the second pass has nothing left to write. It is NOT the
            // unit-level conjunction `unit.included` doing that work: it reads `false` as soon as ANY
            // member is withheld, and a unit whose request an earlier truncation took must stay
            // trimmable — which is why the test above compares per-member write sets, not that flag.
            expect(calls).toEqual(['setIncluded:1:false', 'setIncluded:2:false']);

            // The unit is withheld — BOTH of its entries, because the runtime no longer
            // cascades (src/harness.ts `writeIncluded`), and compaction writes its whole write
            // set (src/plugins/context-compaction.plugin.ts `candidate.members`). The resolver
            // is untouched.
            expect(entries[1].included).toBe(false);
            expect(entries[2].included).toBe(false);
            expect(entries[3].included).toBe(true);
            expect(entries[4].included).toBe(true);

            // EXACTLY ONE pass report, from the pass that acted, and no line at all from the
            // other. A double report would be the visible half of a double write.
            expect(diagnostics).toHaveLength(1);

            if (order === 'compaction-first') {
                // Byte-exact, and the `~238` figure is the one pinned for this fixture above.
                expect(diagnostics[0].message).toBe(
                    'context-compaction withheld 1 superseded tool unit(s), ' +
                        '~238 estimated tokens (mode exclude): #1 msg-2 [failed] answered by msg-4'
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

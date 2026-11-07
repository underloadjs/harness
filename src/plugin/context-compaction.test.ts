// The shipped `context-compaction` preset plugin (src/plugins/context-compaction.plugin.ts).
//
// WHAT THIS FILE PINS
// -------------------
// The TRIGGER and the PAUSE lifecycle — everything except the compaction itself, which is
// intentionally blank in this change:
//
//   1. BELOW the limit: nothing happens at all (no park, no action, no transcript change);
//   2. AT/ABOVE the limit: park -> action (exactly once, with the SAME api and the SAME
//      turn context object) -> un-park, and the un-park also happens when the action
//      throws, because a failed compaction must not strand a conversation in 'paused';
//   3. the per-thread COOLDOWN: an unchanged over-limit estimate does not fire again,
//      growth past the 5%-of-limit margin does, and dropping below the limit makes the
//      next crossing fresh again;
//   4. the internal `summarizer` conversation is never compacted (recursion guard);
//   5. the action is DEMONSTRABLY blank: run directly, it touches no api control and no
//      turn control, and through a real harness the transcript and the provider request
//      come out untouched even though the trigger fired.
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
//   - ../core/context-estimate.ts             — the estimate the integration numbers use
//   - ../harness.ts (`emitTurnBefore`)        — the real pause/resume + token estimate
//   - ./hooks.ts                              — fail-open dispatch of a throwing handler
//   - ../harness.plugin.test.ts               — the transport helpers mirrored below

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type {
    HarnessLifecycleHandler,
    HarnessMessage,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginSettingsProvider,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessTurnBeforeContext
} from '@underload/harness';
import {
    createContextCompactionHandler,
    executeCompaction,
    isInternalAgent,
    metadata,
    setup
} from '../plugins/context-compaction.plugin';

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
    // Simulates an operator changing the stored limit between turns.
    setLimit: (value: number) => void;
};

// A complete `HarnessPluginApi`. Any control other than the settings read is a FAILURE:
// `skip` records it and throws, so an action that tried to spawn a thread, disable a tool
// or wake async work fails the blankness test loudly instead of passing silently.
const createFakeApi = (limit: number): FakeApi => {
    const touches: string[] = [];
    let currentLimit = limit;

    const skip = (name: string): never => {
        touches.push(name);
        throw new Error(`The blank action touched ${name}.`);
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
                return undefined;
            },
            number: (key) => {
                touches.push(`settings.number:${key}`);
                return currentLimit;
            },
            string: (key) => {
                touches.push(`settings.string:${key}`);
                return '';
            },
            boolean: (key) => {
                touches.push(`settings.boolean:${key}`);
                return false;
            }
        },
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
        setLimit: (value: number) => {
            currentLimit = value;
        }
    };
};

// A full `turn.before` payload whose four controls push into `calls`.
const createFakeTurn = (input: {
    api: HarnessPluginApi;
    estimatedTokens: number;
    calls: string[];
    threadId?: string;
    agent?: string;
}): HarnessTurnBeforeContext => ({
    threadId: input.threadId ?? 'thread-1',
    agent: input.agent ?? 'writer',
    iteration: 1,
    messages: TURN_MESSAGES,
    estimatedTokens: input.estimatedTokens,
    signal: new AbortController().signal,
    api: input.api,
    setTranscript: () => {
        input.calls.push('setTranscript');
    },
    replaceHistory: () => {
        input.calls.push('replaceHistory');
    },
    pause: async () => {
        input.calls.push('pause');
    },
    resume: async () => {
        input.calls.push('resume');
    }
});

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

// The one host hook a compaction test needs: the limit the operator would type in the UI,
// plus an observer that never changes anything.
const limitAt = (value: number): HarnessPluginSettingsProvider => ({
    get: (plugin, key) =>
        plugin === 'context-compaction' && key === 'contextLimit' ? value : undefined
});

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
    it('declares exactly the limit the operator edits', () => {
        expect(metadata.name).toBe('context-compaction');
        expect(metadata.title).toBe('Context Compaction');
        // The trigger point this plugin needs, and nothing else, so the live hook surface
        // and the declared intent stay identical.
        expect(metadata.hooks).toEqual(['turn.before']);
        expect(metadata.settings).toEqual([
            {
                key: 'contextLimit',
                label: 'Context limit (tokens)',
                type: 'number',
                default: 100000,
                min: 1000,
                step: 1000,
                description:
                    'Estimated tokens a conversation may reach before this plugin compacts it. Measured with the same ~4 characters/token estimate the UI context bar uses.'
            }
        ]);
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
        expect(touches).toEqual(['settings.number:contextLimit']);
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
        expect(touches).toEqual(['settings.number:contextLimit']);
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
        expect(touches).toEqual(['settings.number:contextLimit']);
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

describe('context-compaction action (executeCompaction)', () => {
    it('is blank: it awaits, returns undefined, and touches nothing', async () => {
        const { api, touches } = createFakeApi(100);
        const calls: string[] = [];
        const context = createFakeTurn({ api, estimatedTokens: 500, calls });

        await expect(executeCompaction(api, context)).resolves.toBeUndefined();

        // No api control (every one of them throws in the fake), and no turn control: no
        // summarization, no truncation, no history rewrite, not even a settings read.
        expect(touches).toEqual([]);
        expect(calls).toEqual([]);

        // The transcript handed in is still the one handed back.
        expect(context.messages).toBe(TURN_MESSAGES);
        expect(context.messages).toEqual([{ role: 'user', content: 'question' }]);
        expect(context.estimatedTokens).toBe(500);
    });

    it('setup registers one turn.before handler whose default action is that blank one', async () => {
        const { api, touches } = createFakeApi(100);
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
        await registered[0].handler(createFakeTurn({ api, estimatedTokens: 100, calls }));

        // Parked and un-parked, and NOTHING in between: `executeCompaction` is the default
        // action, so the shipped plugin currently changes no transcript at all.
        expect(calls).toEqual(['pause', 'resume']);
        expect(touches).toEqual(['settings.number:contextLimit']);
    });
});

describe('context-compaction through a real harness', () => {
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
        expect(writer.threadMessages(thread.id)).toEqual([
            { role: 'user', content: SHORT },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('parks and un-parks once per crossing, and the blank action rewrites nothing', async () => {
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

        // Turn 2: 412 chars = 103 tokens — still over the limit, inside the 5% margin, so
        // the blank action does not park the same conversation again.
        expect((await writer.sendThreadInput(thread.id, INSIDE_MARGIN)).content).toBe('fine');
        expect(estimates).toEqual([100, 103]);
        expect(events).toEqual(['paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // Turn 3: 476 chars = 119 tokens, 19 past the last mark -> re-armed.
        expect((await writer.sendThreadInput(thread.id, PAST_MARGIN)).content).toBe('done');
        expect(estimates).toEqual([100, 103, 119]);
        expect(events).toEqual(['paused', 'resumed', 'paused', 'resumed']);
        expect(writer.thread(thread.id)?.status).toBe('idle');

        // BLANK ACTION, proven from the harness side: every request carried the full
        // transcript (1, then 3, then 5 messages), and committed history still holds every
        // turn in order — nothing was summarized or truncated.
        expect(seen.map((request) => request.messages.length)).toEqual([1, 3, 5]);
        expect(writer.threadMessages(thread.id)).toEqual([
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
        expect(writer.threadMessages(thread.id)).toEqual([
            { role: 'user', content: CROSSING },
            { role: 'assistant', content: 'ok' }
        ]);
    });
});

// The plugin framework, end to end (R2/R3/R4).
//
// WHAT THIS FILE PINS
// -------------------
// The pieces a plugin author actually touches, exercised through a REAL harness with a
// scripted transport (no network, no timers):
//
//   1. AUTO-DISCOVERY: `harness({})` applies the built-in plugins from
//      src/plugins and reports them, metadata included;
//   2. PRECEDENCE: a `configuration.plugins` entry naming a built-in replaces it;
//   3. INTERCEPTION: `turn.before` sees the projected transcript and a token estimate,
//      and may replace the request WITHOUT touching committed history;
//   4. HARNESS CONTROL: a hook (or a setup) can create/stop/delete conversations,
//      enable/disable tools, read its own settings, and park/unpark the thread;
//   5. FAIL-OPEN: a hook that throws must not fail the run;
//   6. LIFECYCLE ordering: the events fire in the run's real order, which is the only
//      thing a plugin can build behaviour on;
//   7. MICROTASK NEUTRALITY: `turn.before` always HAS a subscriber (the shipped
//      context-compaction plugin), so an inert one must produce exactly the frames and
//      the provider requests a hook-less harness produces, while a synchronous override
//      still reaches the provider (src/plugin/hooks.ts rule 6).
//
// Every expected value below is written out in full, so a change in event ordering,
// payload shape, or the token estimate fails with a diff instead of a shrug.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessEvent,
    HarnessPluginMetadata,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessTurnBeforeContext
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Scripted transport (same shape as harness.test.ts: turns are replayed in order)
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

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}) =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

// A searchable tool the discovery gate must enable before the model may call it.
const clockTool = () =>
    tool({ description: 'Read the clock.', tags: ['time'], execute: () => 'noon' });

describe('plugin auto-discovery', () => {
    it('harness() applies the built-in plugins and reports their metadata', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) } });

        // The generated manifest, in scan order — no host configuration was needed to
        // get the presets, which is what "automatically scanned and loaded" means.
        expect(writer.plugins).toEqual(['async-ping', 'context-compaction']);
        expect(writer.pluginMetadata.map((entry) => entry.title)).toEqual([
            'Background Ping',
            'Context Compaction'
        ]);

        // The catalogue is data only: exactly what a server needs to hand a UI, and
        // every declared setting carries the default the plugin will read.
        expect(writer.pluginMetadata[1].settings).toEqual([
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
        expect(writer.pluginMetadata.map((entry) => entry.builtin)).toEqual([true, true]);
    });

    it('lists a metadata-free host plugin after the built-ins with a synthesized entry', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            plugins: [{ name: 'extras', setup: () => undefined }]
        });

        expect(writer.plugins).toEqual(['async-ping', 'context-compaction', 'extras']);
        expect(writer.pluginMetadata[2]).toEqual({ name: 'extras', title: 'extras', builtin: false });
    });

    it('replaces a same-name built-in in place instead of registering it twice', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            plugins: [
                {
                    name: 'context-compaction',
                    metadata: { name: 'context-compaction', title: 'My Compactor' },
                    setup: () => undefined
                }
            ]
        });

        // One entry, same slot: the shipped compaction plugin's hooks were never
        // registered, so an operator swapping it out does not get two compactors.
        expect(writer.plugins).toEqual(['async-ping', 'context-compaction']);
        expect(writer.pluginMetadata[1]).toEqual({
            name: 'context-compaction',
            title: 'My Compactor',
            builtin: false
        });
    });

    it('still rejects two host plugins with the same name', () => {
        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                plugins: [{ name: 'x' }, { name: 'x' }]
            })
        ).toThrow('Plugin "x" is registered more than once.');
    });

    it('honours the legacy wakeIntervalMs through the async-ping settings default', () => {
        // The setting the UI will edit is `async-ping.intervalMs`; `wakeIntervalMs` is the
        // field an existing deployment already passes. The default provider maps one onto
        // the other, and `api.config` exposes the effective heartbeat.
        const seen: number[] = [];
        const probe = {
            name: 'async-ping',
            metadata: {
                name: 'async-ping',
                title: 'Probe',
                settings: [
                    { key: 'intervalMs', label: 'Interval', type: 'number', default: 600000 }
                ]
            } satisfies HarnessPluginMetadata,
            setup: (api: { settings: { number: (key: string, fallback?: number) => number }; config: { wakeIntervalMs: number } }) => {
                seen.push(api.settings.number('intervalMs'), api.config.wakeIntervalMs);
            }
        };

        harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            wakeIntervalMs: 2500,
            plugins: [probe as never]
        });

        expect(seen).toEqual([2500, 2500]);
    });

    it('reads settings through a host provider when one is configured', () => {
        const asked: string[] = [];
        const seen: Record<string, unknown> = {};

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            pluginSettings: {
                get: (plugin, key) => {
                    asked.push(`${plugin}.${key}`);
                    return plugin === 'reader' && key === 'limit' ? 42 : undefined;
                }
            },
            plugins: [
                {
                    name: 'reader',
                    metadata: {
                        name: 'reader',
                        title: 'Reader',
                        settings: [{ key: 'limit', label: 'Limit', type: 'number', default: 7 }]
                    },
                    setup: (api) => {
                        seen.stored = api.settings.number('limit');
                        seen.undeclared = api.settings.number('other', 3);
                    }
                }
            ]
        });

        expect(seen).toEqual({ stored: 42, undeclared: 3 });
        expect(asked).toEqual(['reader.limit', 'reader.other']);
        // The built-ins still loaded; a host provider is additive, not a replacement.
        expect(writer.plugins).toEqual(['async-ping', 'context-compaction', 'reader']);
    });
});

describe('turn.before interception', () => {
    it('sees the projected transcript and an exact token estimate, and replaces only the request', async () => {
        const seen: HarnessStreamRequest[] = [];
        const hooks: HarnessTurnBeforeContext[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('replied')], seen)) },
            plugins: [
                {
                    name: 'rewriter',
                    setup: (api) => {
                        api.on('turn.before', (payload) => {
                            hooks.push(payload);
                            payload.setTranscript([{ role: 'user', content: 'Compact prompt' }]);
                        });
                    }
                }
            ]
        });

        const message = await writer('ABCDEFGH');

        expect(message.content).toBe('replied');
        expect(hooks).toHaveLength(1);

        // The hook sees EXACTLY what the provider was about to receive: the committed
        // transcript projected for this turn, before any rewrite.
        expect(hooks[0].messages).toEqual([{ role: 'user', content: 'ABCDEFGH' }]);
        // 8 characters at ~4 chars/token (core/context-estimate.ts) = 2.
        expect(hooks[0].estimatedTokens).toBe(2);
        expect(hooks[0].iteration).toBe(1);
        expect(hooks[0].agent).toBe('writer');
        // The callable root runs in the primary's DEFAULT conversation.
        expect(hooks[0].threadId).toBe('agent:writer');
        expect(hooks[0].signal.aborted).toBe(false);

        // The provider got the override...
        expect(seen[0].messages).toEqual([{ role: 'user', content: 'Compact prompt' }]);

        // ...while committed history is untouched. This is the difference between
        // "shrink this request" and "rewrite this conversation".
        expect(writer.agent.messages).toEqual([
            { role: 'user', content: 'ABCDEFGH' },
            { role: 'assistant', content: 'replied' }
        ]);
    });

    it('last non-empty override wins, and committed history is unchanged without replaceHistory', async () => {
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')], seen)) },
            plugins: [
                {
                    name: 'first',
                    setup: (api) => {
                        api.on('turn.before', () => ({
                            transcript: [{ role: 'user', content: 'from-return' }]
                        }));
                    }
                },
                {
                    name: 'second',
                    setup: (api) => {
                        api.on('turn.before', () => ({
                            transcript: [{ role: 'user', content: 'from-later-return' }]
                        }));
                    }
                }
            ]
        });

        await writer('go');

        expect(seen[0].messages).toEqual([{ role: 'user', content: 'from-later-return' }]);
        expect(writer.agent.messages[0]).toEqual({ role: 'user', content: 'go' });
    });

    it('replaceHistory rewrites committed history through the validating write path', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [
                {
                    name: 'compactor',
                    setup: (api) => {
                        api.on('turn.before', (payload) => {
                            payload.replaceHistory([
                                { role: 'system', content: 'summarized' },
                                { role: 'user', content: 'oldest question' }
                            ]);
                            // The request keeps its own transcript; the NEXT turn would
                            // project the rewritten history.
                            payload.setTranscript([{ role: 'user', content: 'summarized turn' }]);
                        });
                    }
                }
            ]
        });

        const thread = writer.createThread('writer', { label: 'Compacted' });
        await writer.sendThreadInput(thread.id, 'a very long question indeed');

        // The replacement covers EVERYTHING committed at the boundary, including the
        // prompt this run just appended (it is committed before the first request, so it
        // IS history by then). A real compactor therefore re-states the newest turn in
        // its replacement instead of dropping it — pinning that here, because the
        // alternative (silently keeping the old prompt) would defeat the whole rewrite.
        expect(writer.threadMessages(thread.id)).toEqual([
            { role: 'system', content: 'summarized' },
            { role: 'user', content: 'oldest question' },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('parks and resumes the conversation observably at the boundary', async () => {
        const observed: string[] = [];
        const lifecycle: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [
                {
                    name: 'parking',
                    setup: (api) => {
                        api.on('thread.paused', (payload) => {
                            lifecycle.push(`paused:${payload.status}`);
                        });
                        api.on('thread.resumed', (payload) => {
                            lifecycle.push(`resumed:${payload.status}`);
                        });
                        api.on('turn.before', async (payload) => {
                            await payload.pause();
                            // The roster a host (or the server) reads sees the park.
                            observed.push(
                                String(payload.api.threads.list().find((entry) => entry.id === payload.threadId)?.status)
                            );
                            await payload.resume();
                            observed.push(
                                String(payload.api.threads.list().find((entry) => entry.id === payload.threadId)?.status)
                            );
                        });
                    }
                }
            ]
        });

        const thread = writer.createThread('writer', { label: 'Parked' });
        const message = await writer.sendThreadInput(thread.id, 'go');

        expect(message.content).toBe('ok');
        expect(observed).toEqual(['paused', 'running']);
        expect(lifecycle).toEqual(['paused:paused', 'resumed:running']);
        // And the run finished normally: a pause at a boundary is not a cancellation.
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });

    it('leaves a thread parked when the hook never resumes it, and the snapshot never persists paused', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [
                {
                    name: 'parker',
                    setup: (api) => {
                        api.on('turn.before', async (payload) => {
                            await payload.pause();
                        });
                    }
                }
            ]
        });

        const thread = writer.createThread('writer', { label: 'Parked' });
        await writer.sendThreadInput(thread.id, 'go');

        // The run completed, and the park OUTLIVED it: the run loop only clears
        // 'running', so a parked conversation is not silently revived.
        expect(writer.thread(thread.id)?.status).toBe('paused');

        // Persistence: 'paused' is never durable. A restarted process sees an idle
        // conversation, because no run is live any more (core/snapshot.ts accepts only
        // 'idle' | 'stopped' for a thread record).
        const persisted = writer.snapshot().threads?.find((entry) => entry.id === thread.id);
        expect(persisted?.status).toBe('idle');
    });

    it('fails open: a throwing hook does not fail the run, and a later hook still runs', async () => {
        const seen: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('survived')])) },
            plugins: [
                {
                    name: 'sync-boom',
                    setup: (api) => {
                        api.on('turn.before', () => {
                            throw new Error('sync boom');
                        });
                    }
                },
                {
                    name: 'async-boom',
                    setup: (api) => {
                        api.on('turn.before', async () => {
                            await Promise.resolve();
                            throw new Error('async boom');
                        });
                    }
                },
                {
                    name: 'witness',
                    setup: (api) => {
                        api.on('turn.before', (payload) => {
                            seen.push(`saw:${payload.iteration}`);
                        });
                        api.on('turn.after', (payload) => {
                            seen.push(`after:${payload.message.content}`);
                        });
                    }
                }
            ]
        });

        const message = await writer('go');

        expect(message.content).toBe('survived');
        // Two broken hooks, then the healthy one, in registration order.
        expect(seen).toEqual(['saw:1', 'after:survived']);
        expect(writer.agent.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'survived' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// The maybe-sync `turn.before` boundary (T6)
// ---------------------------------------------------------------------------
//
// `turn.before` has a PERMANENT subscriber in every harness (the shipped
// context-compaction plugin), so the `has()` guard can no longer protect the emission
// from costing a microtask. Awaiting it moved observer-visible frames — the regression
// src/server/queue.test.ts pins — so harness.ts applies a synchronous round with NO
// `await` (plugin/hooks.ts rule 6). The harness-level consequence is what this section
// owns: an inert subscriber must be indistinguishable from no subscriber at all.
describe('turn.before microtask neutrality', () => {
    // Compact, id-free projection of the progress stream: the event type plus the
    // fields an ORDERING regression changes. `durationMs`/`usage` are left out because
    // they measure the wall clock, which would make the comparison flaky rather than
    // tighter, and message ids are random.
    const eventKey = (event: HarnessEvent): string => {
        if (event.type === 'tool_call') return `tool_call:${event.agent}:${event.call.id}`;
        if (event.type === 'tool_result') {
            return `tool_result:${event.agent}:${event.callId}:${event.content}`;
        }
        if (event.type === 'done') return `done:${event.agent}:${event.message.content}`;
        if (event.type === 'text') return `text:${event.agent}:${event.delta}`;
        return `${event.type}:${event.agent}`;
    };

    // One tool round, then an answer — run either with no extra `turn.before` subscriber
    // (the pre-plugin baseline) or with a synchronously inert one (the shape the shipped
    // context-compaction plugin has under its limit).
    const runBoard = (
        inert: boolean
    ): Promise<{ keys: string[]; requests: string[][]; answer: string }> => {
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: {
                writer: brain(scripted([callTool('c1', 'clock', '{}'), answer('final')], seen))
            },
            presets: false,
            tools: {
                clock: tool({
                    description: 'Read the clock.',
                    tags: ['time'],
                    // Core, so the model may call it without a discovery round.
                    visibility: 'core',
                    execute: () => 'noon'
                })
            },
            ...(inert
                ? {
                    plugins: [
                        {
                            name: 'inert-turn-before',
                            setup: (api) => {
                                api.on('turn.before', () => undefined);
                            }
                        }
                    ]
                }
                : {}),
            report: { progress: (event) => void events.push(event) }
        });

        return writer('go').then((message) => ({
            keys: events.map(eventKey),
            // Everything the provider actually received, per request, as role:content.
            requests: seen.map((request) =>
                request.messages.map((entry) => `${entry.role}:${entry.content}`)
            ),
            answer: message.content
        }));
    };

    it('an inert turn.before subscriber streams exactly what a hook-less harness streams', async () => {
        const without = await runBoard(false);
        const withHook = await runBoard(true);

        // The baseline is pinned on its own first, so the comparison below can never
        // drift into "whatever the second harness happened to do".
        expect(without.keys).toEqual([
            'start:writer',
            'tool_call:writer:c1',
            // The request's success boundary closes BEFORE the inline result is
            // delivered: a committed tool round, then its answer.
            'attempt_commit:writer',
            'tool_result:writer:c1:noon',
            'text:writer:final',
            'done:writer:final'
        ]);
        expect(without.requests).toEqual([
            ['user:go'],
            ['user:go', 'assistant:', 'tool:noon']
        ]);
        expect(without.answer).toBe('final');

        // Identical frames AND identical provider requests: the hook round added no
        // boundary for anything else to slip into.
        expect(withHook).toEqual(without);
    });

    it('a synchronous handler still overrides the request, and only the request', async () => {
        const seen: HarnessStreamRequest[] = [];
        const observed: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('replied')], seen)) },
            plugins: [
                {
                    name: 'sync-rewriter',
                    setup: (api) => {
                        api.on('turn.before', (payload) => {
                            // A plain function returning a value: the shape the maybe-sync
                            // round keeps on the caller's tick.
                            observed.push(`sync:${payload.iteration}:${payload.messages.length}`);
                            return { transcript: [{ role: 'user', content: 'synced request' }] };
                        });
                    }
                }
            ]
        });

        const message = await writer('go');

        expect(observed).toEqual(['sync:1:1']);
        expect(seen[0].messages).toEqual([{ role: 'user', content: 'synced request' }]);
        expect(message.content).toBe('replied');
        // Committed history keeps the original prompt: an override is per-request, which
        // is the difference between this hook and `replaceHistory()`.
        expect(writer.agent.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'replied' }
        ]);
    });
});

describe('plugin harness control', () => {
    it('creates and deletes conversations, and enables then disables a tool, from setup', () => {
        let createdIds: string[] = [];

        const writer = harness({
            agents: {
                writer: brain(scripted([answer('hi')])),
                helper: brain(scripted([answer('help')]))
            },
            tools: { now: clockTool() },
            plugins: [
                {
                    name: 'controller',
                    setup: (api) => {
                        const first = api.threads.create('writer', { label: 'first' });
                        const second = api.threads.create('helper', { label: 'second' });
                        const third = api.threads.create('writer', { label: 'third' });
                        createdIds = [first.id, second.id, third.id];

                        // A host thread is a REAL conversation: the roster names it. The
                        // two leading `undefined` labels are the agents' DEFAULT
                        // conversations, which are threads but carry no label.
                        expect(api.threads.list().map((entry) => entry.label)).toEqual([
                            undefined,
                            undefined,
                            'first',
                            'second',
                            'third'
                        ]);

                        // `delete` is the contract name and `remove` its documented alias:
                        // both purge through `harness.deleteThread`, so a plugin can use
                        // whichever spelling reads better.
                        api.threads.delete(second.id);
                        api.threads.remove(third.id);
                        expect(api.threads.list().map((entry) => entry.label)).toEqual([
                            undefined,
                            undefined,
                            'first'
                        ]);

                        api.enableTool('now');
                        expect(api.enabledTools()).toContain('now');
                        api.disableTool('now');
                        expect(api.enabledTools()).not.toContain('now');

                        // A core declaration is always in context, so switching it would
                        // be a lie the plugin would believe.
                        expect(() => api.enableTool('toolRequest')).toThrow(
                            'Tool "toolRequest" is a core declaration; it is always in context and cannot be enabled or disabled.'
                        );
                        expect(() => api.disableTool('missing')).toThrow(
                            'Tool "missing" is not registered in this harness.'
                        );
                    }
                }
            ]
        });

        expect(writer.threads().map((entry) => entry.id)).toEqual(['agent:writer', 'agent:helper', createdIds[0]]);
        expect(writer.threads()[2].label).toBe('first');
        expect(writer.discoveredTools).toEqual([]);
    });

    it('a hook can stop ANOTHER conversation and read a transcript', async () => {
        const before: string[] = [];
        const after: string[] = [];
        const roles: string[][] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            plugins: [
                {
                    name: 'driver',
                    setup: (api) => {
                        // Opened at setup: a plugin may bring its own conversation with
                        // it, exactly like the requirement's "spawn a new thread".
                        const bystander = api.threads.create('writer', { label: 'bystander' });

                        api.on('turn.after', (payload) => {
                            const target = payload.threadId ?? '';

                            before.push(
                                String(api.threads.list().find((entry) => entry.id === bystander.id)?.status)
                            );
                            // Halting a DIFFERENT conversation: stopping the one this hook
                            // is running inside would abort its own run.
                            api.threads.stop(bystander.id, 'hook stop');
                            after.push(
                                String(api.threads.list().find((entry) => entry.id === bystander.id)?.status)
                            );
                            // A read of the running conversation sees the committed turn.
                            roles.push(api.threads.messages(target).map((entry) => entry.role));
                        });
                    }
                }
            ]
        });

        const thread = writer.createThread('writer', { label: 'working' });
        const message = await writer.sendThreadInput(thread.id, 'go');

        expect(message.content).toBe('one');
        expect(before).toEqual(['idle']);
        expect(after).toEqual(['stopped']);
        expect(roles).toEqual([['user', 'assistant']]);

        // The stop is real harness state, not a hook-local opinion.
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(
            writer.threads().find((entry) => entry.label === 'bystander')?.status
        ).toBe('stopped');
    });

    it('exposes the background board and a wake to a hook', async () => {
        const snapshots: number[][] = [];

        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'now', '{}'), answer('done')])) },
            tools: { now: clockTool() },
            plugins: [
                {
                    name: 'watcher',
                    setup: (api) => {
                        api.enableTool('now');
                        api.on('async.pending', (payload) => {
                            snapshots.push(payload.pending.map((entry) => entry.elapsedMs));
                        });
                        api.on('async.drained', (payload) => {
                            snapshots.push(payload.pending.map((entry) => entry.elapsedMs));
                            // The wake accessor exists so the ping plugin can replace the
                            // timer without a scheduler change; calling it here is a no-op
                            // because the board is already empty.
                            payload.api.async.wake();
                        });
                    }
                }
            ]
        });

        const message = await writer('go');

        expect(message.content).toBe('done');
        // One call launched (elapsed 0), then the drained transition (nothing running).
        expect(snapshots).toEqual([[0], []]);
    });
});

describe('lifecycle event order', () => {
    // One handler per event, all from one plugin, so the recorded sequence IS the run's
    // real ordering (no cross-plugin interleaving to reason about). `enable` opts into
    // the discovery gate for tests that script a tool round.
    const record = (events: string[], enable?: string) => ({
        name: 'recorder',
        setup: (api: {
            on: (event: string, handler: (payload: never) => void) => void;
            enableTool: (name: string) => void;
        }) => {
            for (const event of [
                'thread.created',
                'thread.started',
                'thread.paused',
                'thread.resumed',
                'thread.stopped',
                'thread.idle',
                'thread.deleted',
                'run.started',
                'run.finished',
                'run.failed',
                'turn.before',
                'turn.after',
                'tool.before',
                'tool.after',
                'async.pending',
                'async.drained'
            ]) {
                api.on(event, () => {
                    events.push(event);
                });
            }

            if (enable !== undefined) api.enableTool(enable);
        }
    });

    it('brackets an answering run exactly as the harness documents', async () => {
        const events: string[] = [];
        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [record(events) as never]
        });

        const thread = writer.createThread('writer', { label: 'Ordered' });
        await writer.sendThreadInput(thread.id, 'go');
        writer.stopThread(thread.id);
        writer.deleteThread(thread.id);

        expect(events).toEqual([
            'thread.created',
            'thread.started',
            'run.started',
            'turn.before',
            'turn.after',
            'run.finished',
            'thread.idle',
            'thread.stopped',
            'thread.deleted'
        ]);
    });

    it('brackets a tool round, including the background transitions', async () => {
        const events: string[] = [];
        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'now', '{}'), answer('ok')])) },
            tools: { now: clockTool() },
            plugins: [record(events, 'now') as never]
        });

        await writer('go');

        expect(events).toEqual([
            'thread.started',
            'run.started',
            'turn.before',
            'turn.after',
            'tool.before',
            'async.pending',
            'tool.after',
            'async.drained',
            // The results bought the second turn, and the answer ended the run.
            'turn.before',
            'turn.after',
            'run.finished',
            'thread.idle'
        ]);
    });

    it('reports a failed run instead of a finished one', async () => {
        const events: string[] = [];
        const writer = harness({
            // `retry: false` because this pins the terminal FAILURE path: a scripted
            // error frame repeats forever, and the default retry backoff would turn this
            // test into a retry suite (the same reason harness.test.ts does it).
            agents: { writer: brain(scripted([[{ type: 'error', message: 'provider down' }]]), { retry: false }) },
            plugins: [record(events) as never]
        });

        await expect(writer('go')).rejects.toThrow('provider down');

        // `run.failed` REPLACES `run.finished`; `thread.idle` still fires because the
        // conversation genuinely stopped working.
        expect(events).toEqual([
            'thread.started',
            'run.started',
            'turn.before',
            'run.failed',
            'thread.idle'
        ]);
    });
});

// `HarnessMessage` is used by the transcript assertions above; `HarnessEvent` is NOT
// imported on purpose: a progress frame and a hook payload are different surfaces, and
// this file pins only the hook side.

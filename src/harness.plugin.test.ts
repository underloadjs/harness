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
//      still reaches the provider (src/plugin/hooks.ts rule 6);
//   8. THE T3.5 SURFACE: `api.snapshot()` is the host's own document (detached, safe
//      mid-run, reports nothing), and `api.settings.setOwn()` writes only the calling
//      plugin's declared namespace, through the host's provider, under the server's own
//      write-edge rules — including the stated "no writer" refusal.
//
// Every expected value below is written out in full, so a change in event ordering,
// payload shape, or the token estimate fails with a diff instead of a shrug.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessDiagnosticEvent,
    HarnessEvent,
    HarnessPluginMetadata,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessTurnBeforeContext
} from '@underload/harness';

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
                    'Estimated tokens a conversation may reach before this plugin compacts it. Measured with the ~4 characters/token estimate the UI context bar uses, anchored on the reported prompt size of the last request that reported usage — so after the first report it can differ from the bar by whatever the tool schemas and message framing actually cost.'
            },
{
                key: "enabled",
                label: "Compact conversations",
                type: "boolean",
                default: true,
                description:
                    "Runs the pruning pass on or off. Off changes nothing else: the limit is still read, the context bar still measures, and no other plugin is affected. It is the switch an operator expects when they want the behaviour gone without removing the built-in."
                },
{
                key: "minTokens",
                label: "Minimum saving per pass (tokens)",
                type: "number",
                default: 200,
                min: 0,
                step: 50,
                description:
                    "A pass must withhold at least this many estimated tokens, or it does nothing at all \u2014 no flag write, no persistence notification, no save. A prune that saves 40 tokens is a provider prompt-cache invalidation for nothing, so this floor is what makes running on every turn cheap. Measured as a difference of the same estimate, so any provider anchor cancels out of it and only the withheld characters count."
                },
{
                key: "safetyTurns",
                label: "Recent units to protect",
                type: "number",
                default: 6,
                min: 0,
                step: 1,
                description:
                    "How many units at the END of the conversation no pass may touch. A unit is one assistant tool-call block plus its results, or one standalone message. The horizon counts UNITS from the end, never the per-run turn counter: a failure the model has not moved past yet is the highest-signal thing in the window, and pruning it is how an agent repeats the call it just watched fail. 0 removes the horizon."
                },
{
                key: "mode",
                label: "Compaction mode",
                type: "string",
                default: "exclude",
                description:
                    "What a compaction does with a unit it removes. Only \"exclude\" is implemented today: the unit keeps its place in canonical history and simply stops being sent, which is the reversible option the evidence favours. \"annotate\" \u2014 replace the result with a one-line handle back to the full text \u2014 is the planned SECOND WRITER over the same candidate list the policy already computes before writing anything, and any value other than \"exclude\" (including that one) behaves as \"exclude\" until it lands. The value actually used is reported in the pass diagnostic."
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
        expect(withoutIds(writer.agent.messages)).toEqual([
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
        expect(withoutIds(writer.agent.messages[0])).toEqual({ role: 'user', content: 'go' });
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
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
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
        expect(withoutIds(writer.agent.messages)).toEqual([
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
        expect(withoutIds(writer.agent.messages)).toEqual([
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

// ---------------------------------------------------------------------------
// T1 — the event bus in PRODUCTION (the reporter the harness installs, the wildcard,
// the host plane bridge, and the teardown the catalogue promised)
// ---------------------------------------------------------------------------

describe('plugin diagnostics in production (T1.5)', () => {
    it('reports a throwing hook to the host without failing the run', async () => {
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('carried on')])) },
            plugins: [
                {
                    name: 'broken-policy',
                    setup: (api) => {
                        api.on('turn.before', () => {
                            throw new Error('compactor crashed');
                        });
                    }
                }
            ],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const message = await writer('go');

        // Fail-open is unchanged (rule 2) — what T1.5 adds is that the drop is no
        // longer invisible.
        expect(message.content).toBe('carried on');
        expect(diagnostics).toEqual([
            {
                type: 'plugin_diagnostic',
                kind: 'handler-threw',
                event: 'turn.before',
                owner: 'broken-policy',
                message: 'compactor crashed'
            }
        ]);
    });

    it('drops a hook that never resolves at its budget, reports it, and still answers', async () => {
        const diagnostics: HarnessDiagnosticEvent[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('answered anyway')])) },
            plugins: [
                {
                    name: 'slow-policy',
                    setup: (api) => {
                        // A summarizer call that never comes back. Without a budget this
                        // turn was parked forever; the run had no way to notice.
                        api.on('turn.before', () => new Promise<never>(() => undefined), {
                            timeoutMs: 5
                        });
                    }
                }
            ],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const message = await writer('go');

        expect(message.content).toBe('answered anyway');
        expect(diagnostics).toEqual([
            {
                type: 'plugin_diagnostic',
                kind: 'handler-timed-out',
                event: 'turn.before',
                owner: 'slow-policy',
                message:
                    'A "slow-policy" handler for "turn.before" timed out after 5ms and was dropped (fail-open).'
            }
        ]);
    });

    it('a diagnostic sink that throws cannot fail the run either', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('fine')])) },
            plugins: [
                {
                    name: 'broken-policy',
                    setup: (api) => {
                        api.on('turn.before', () => {
                            throw new Error('first failure');
                        });
                    }
                }
            ],
            report: {
                diagnostic: () => {
                    throw new Error('the reporter is itself broken');
                }
            }
        });

        await expect(writer('go')).resolves.toMatchObject({ content: 'fine' });
    });
});

describe('wildcard subscription and the host plane (T1.1, T1.7)', () => {
    it('one "*" handler sees a whole session in the run\'s real order, once each', async () => {
        const seen: string[] = [];
        const stateChanges: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [
                {
                    name: 'auditor',
                    setup: (api) => {
                        api.on('*', (context) => {
                            seen.push(context.event);
                        });
                        // T1.7: the state-change plane is opt-in BY NAME, so this second
                        // subscription is the only reason this plugin sees it at all.
                        api.on('host.state_change', (event) => {
                            stateChanges.push(event.reason);
                        });
                    }
                }
            ]
        });

        const thread = writer.createThread('writer', { label: 'Audited' });
        await writer.sendThreadInput(thread.id, 'go');
        writer.stopThread(thread.id);
        writer.deleteThread(thread.id);

        // Identical to the named-handler ordering the file already pins, reached with
        // ONE subscription — which is the whole requirement (R3).
        expect(seen).toEqual([
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

        // Exactly the reasons this session's mutations produce, in order: the create,
        // the two transcript appends of the run (user, then the assistant answer), the
        // stop, and the delete. A run start/finish deliberately contributes NOTHING
        // here (harness.ts: the per-turn `agent_message` already covers it), which is
        // why this list is five and not nine.
        expect(stateChanges).toEqual([
            'thread',
            'agent_message',
            'agent_message',
            'thread',
            'thread'
        ]);

        writer.dispose();

        // Teardown is part of what an auditor is entitled to see.
        expect(seen[seen.length - 1]).toBe('harness.dispose');
    });

    it('a "*" subscriber that wants host.state_change by name gets it, and no duplicate', async () => {
        const wild: string[] = [];
        const named: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [
                {
                    name: 'both-ways',
                    setup: (api) => {
                        api.on('*', (context) => void wild.push(context.event));
                        api.on('host.state_change', (event) => void named.push(event.reason));
                    }
                }
            ]
        });

        await writer('go');

        // The wildcard fan-out carried no `host.state_change`, so the named
        // subscription cannot be double-delivered: it sees exactly the run's two
        // transcript appends (the user prompt and the committed answer) and nothing else.
        expect(wild).toEqual([
            'thread.started',
            'run.started',
            'turn.before',
            'turn.after',
            'run.finished',
            'thread.idle'
        ]);
        expect(named).toEqual(['agent_message', 'agent_message']);
        expect(wild.filter((event) => event === 'host.state_change')).toEqual([]);
    });
});

describe('harness.dispose (T1.6)', () => {
    it('fires exactly once on dispose, clears the bus, and survives a second call', async () => {
        const events: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('one'), answer('two')])) },
            plugins: [
                {
                    name: 'auditor',
                    setup: (api) => {
                        api.on('harness.dispose', () => void events.push('harness.dispose'));
                        api.on('turn.before', () => void events.push('turn.before'));
                        api.on('run.finished', () => void events.push('run.finished'));
                    }
                }
            ]
        });

        await writer('first');

        expect(events).toEqual(['turn.before', 'run.finished']);

        writer.dispose();

        expect(events).toEqual(['turn.before', 'run.finished', 'harness.dispose']);

        // Idempotent (guarantee 1), and the bus is CLEARED: the next run works and fires
        // no hook at all, which is what "subscriptions die with the harness" means.
        writer.dispose();
        await writer('second');

        expect(events).toEqual(['turn.before', 'run.finished', 'harness.dispose']);
        expect(writer.agent.messages.map((message) => message.role)).toEqual([
            'user',
            'assistant',
            'user',
            'assistant'
        ]);
    });

    it('a dispose() that lands mid-run waits for the last run, after its terminal hooks', async () => {
        const events: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            plugins: [
                {
                    name: 'auditor',
                    setup: (api) => {
                        for (const event of ['run.finished', 'thread.idle', 'harness.dispose']) {
                            api.on(event as 'run.finished', () => void events.push(event));
                        }
                    }
                }
            ]
        });

        const running = writer('go');

        writer.dispose();

        // Parked: the teardown event must never be raced against a live run (F8).
        expect(events).toEqual([]);

        await running;

        expect(events).toEqual(['run.finished', 'thread.idle', 'harness.dispose']);

        writer.dispose();

        expect(events).toEqual(['run.finished', 'thread.idle', 'harness.dispose']);
    });
});

// ---------------------------------------------------------------------------
// T2 — the turn decision pipeline
// ---------------------------------------------------------------------------
//
// The four actions of `HarnessTurnDecision`, consumed where the transcript is decided
// (`requestTurn`, right after `emitTurnBefore`), plus the fail-open rule for a
// malformed one. Every expected value is written out, so an action that silently became
// a no-op — or a rollback that stopped rolling back — fails with a diff.
describe('turn decision pipeline (T2)', () => {
    // A core tool (no discovery round) so a scripted tool round reaches the provider.
    const coreClock = () =>
        tool({
            description: 'Read the clock.',
            tags: ['time'],
            visibility: 'core',
            execute: () => 'noon'
        });

    // The committed transcript of the ROOT conversation, as `role:content` lines.
    const transcriptOf = (messages: readonly { role: string; content?: unknown }[]): string[] =>
        messages.map((message) => `${message.role}:${message.content ?? ''}`);

    it('a continue decision sends the projected transcript and changes nothing', async () => {
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('normal')], seen)) },
            plugins: [
                {
                    name: 'agreeing-policy',
                    setup: (api) => {
                        api.on('turn.before', () => ({ decision: { action: 'continue' } }));
                    }
                }
            ]
        });

        const message = await writer('go');

        expect(message.content).toBe('normal');
        expect(seen.map((request) => transcriptOf(request.messages))).toEqual([['user:go']]);
        expect(transcriptOf(writer.agent.messages)).toEqual([
            'user:go',
            'assistant:normal'
        ]);
    });

    it('a replace decision sends what it says, and only for this request', async () => {
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('replied')], seen)) },
            plugins: [
                {
                    name: 'rewriter',
                    setup: (api) => {
                        api.on('turn.before', () => ({
                            decision: {
                                action: 'replace',
                                transcript: [{ role: 'user', content: 'compacted request' }]
                            }
                        }));
                    }
                }
            ]
        });

        const message = await writer('go');

        // The provider saw the replacement...
        expect(seen.map((request) => transcriptOf(request.messages))).toEqual([
            ['user:compacted request']
        ]);
        // ...and committed history still holds the original prompt: a decision about the
        // REQUEST is not a write to the transcript (that is `replaceHistory`).
        expect(transcriptOf(writer.agent.messages)).toEqual(['user:go', 'assistant:replied']);
        expect(message.content).toBe('replied');
    });

    it('a pause decision parks the conversation, still sends the turn, and resume continues it', async () => {
        const lifecycle: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: {
                writer: brain(scripted([callTool('c1', 'clock', '{}'), answer('second turn')], seen))
            },
            tools: { clock: coreClock() },
            presets: false,
            plugins: [
                {
                    name: 'pauser',
                    setup: (api) => {
                        api.on('thread.paused', (record) => void lifecycle.push(`paused:${record.status}`));
                        api.on('thread.resumed', (record) => void lifecycle.push(`resumed:${record.status}`));
                        api.on('turn.before', async (payload) => {
                            if (payload.iteration === 1) {
                                return { decision: { action: 'pause', reason: 'compacting' } };
                            }

                            // A later boundary un-parks it. Pause is a ROSTER signal, so
                            // the parked run kept going the whole time.
                            await payload.resume();

                            return { decision: { action: 'continue' } };
                        });
                    }
                }
            ]
        });

        const thread = writer.createThread('writer', { label: 'Pausable' });
        const message = await writer.sendThreadInput(thread.id, 'go');

        expect(message.content).toBe('second turn');
        // BOTH turns went out: a pause never withheld a request.
        expect(seen.map((request) => transcriptOf(request.messages))).toEqual([
            ['user:go'],
            ['user:go', 'assistant:', 'tool:noon']
        ]);
        expect(lifecycle).toEqual(['paused:paused', 'resumed:running']);
        // The park did not end the run, and the resume returned the conversation to the
        // status the run loop owns.
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });

    it('a stop decision mid-run ends the run with the plugin reason and leaves no orphan assistant message', async () => {
        const events: string[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: {
                writer: brain(scripted([callTool('c1', 'clock', '{}'), answer('never requested')], seen))
            },
            tools: { clock: coreClock() },
            presets: false,
            plugins: [
                {
                    name: 'budget',
                    setup: (api) => {
                        api.on('run.finished', () => void events.push('run.finished'));
                        api.on('run.failed', (context) => void events.push(`run.failed:${context.error.message}`));
                        api.on('thread.stopped', (record) => void events.push(`thread.stopped:${record.status}`));
                        api.on('turn.before', (payload) => {
                            if (payload.iteration < 2) return undefined;

                            return { decision: { action: 'stop', reason: 'plugin budget exhausted' } };
                        });
                    }
                }
            ]
        });

        const failure = await writer('go').then(
            () => undefined,
            (error: Error) => error
        );

        // The reason the plugin gave is the reason the caller and `run.failed` report —
        // open decision 2: the abort path, not a fabricated answer.
        expect((failure as Error).message).toBe('plugin budget exhausted');
        expect(events).toEqual([
            'thread.stopped:stopped',
            'run.failed:plugin budget exhausted'
        ]);
        // ONE provider request: the decision lands before the second request is built,
        // and the run never claimed an answer.
        expect(seen.map((request) => transcriptOf(request.messages))).toEqual([['user:go']]);
        // THE orphan check: the assistant message and the tool result the first turn
        // committed are rolled back with the run, exactly like the `maxIterations`
        // guard's rollback, so a stopped conversation shows nothing but what it had
        // before the run.
        expect(transcriptOf(writer.agent.messages)).toEqual([]);
        expect(writer.thread('agent:writer')?.status).toBe('stopped');
    });

    it('a malformed decision is ignored AND reported while the round\'s transcript override still applies', async () => {
        const diagnostics: HarnessDiagnosticEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('replied')], seen)) },
            plugins: [
                {
                    name: 'typo-policy',
                    setup: (api) => {
                        // `halt` is not an action. The rewrite in the SAME object is
                        // real work and must survive the typo.
                        api.on('turn.before', () => ({
                            transcript: [{ role: 'user', content: 'still sent' }],
                            decision: { action: 'halt' }
                        }));
                    }
                }
            ],
            report: { diagnostic: (event) => void diagnostics.push(event) }
        });

        const message = await writer('go');

        expect(seen.map((request) => transcriptOf(request.messages))).toEqual([
            ['user:still sent']
        ]);
        expect(message.content).toBe('replied');
        expect(diagnostics).toEqual([
            {
                type: 'plugin_diagnostic',
                kind: 'invalid-decision',
                event: 'turn.before',
                owner: 'typo-policy',
                message:
                    'A "typo-policy" handler for "turn.before" returned a decision this contract cannot parse and it was ignored: {"action":"halt"}.'
            }
        ]);
    });

    it('a synchronous decision costs no microtask: the frames match a hook-less run', async () => {
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: {
                writer: brain(scripted([callTool('c1', 'clock', '{}'), answer('final')], seen))
            },
            presets: false,
            tools: { clock: coreClock() },
            plugins: [
                {
                    name: 'sync-decision',
                    setup: (api) => {
                        api.on('turn.before', () => ({ decision: { action: 'continue' } }));
                    }
                }
            ],
            report: { progress: (event) => void events.push(event) }
        });

        const message = await writer('go');

        // The SAME literal ordering the hook-less baseline is pinned to above (the
        // `turn.before microtask neutrality` section): a plain function returning a
        // decision must not have moved a frame.
        expect(events.map((event) => (event.type === 'done' ? `done:${event.message.content}` : event.type))).toEqual([
            'start',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'text',
            'done:final'
        ]);
        expect(seen.map((request) => transcriptOf(request.messages))).toEqual([
            ['user:go'],
            ['user:go', 'assistant:', 'tool:noon']
        ]);
        expect(message.content).toBe('final');
    });
});

// ---------------------------------------------------------------------------
// Pipeline T3.5 — `api.snapshot()` and `api.settings.setOwn()`
// ---------------------------------------------------------------------------

describe('plugin persistence and settings write surface (T3.5)', () => {
    it('api.snapshot() is the host document, safe mid-run, and read-only in effect', async () => {
        const seen: HarnessStreamRequest[] = [];
        // What the hook saw at the turn boundary (a CLONE, so the mutation experiment
        // below cannot rewrite the evidence), and what a fresh read returns afterwards.
        let midRun: unknown;
        let afterMutation: unknown;

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')], seen)) },
            plugins: [
                {
                    name: 'auditor',
                    setup: (api) => {
                        api.on('turn.before', (context) => {
                            // T3.5: the SAME document `harness.snapshot()` hands a host,
                            // taken while a run is live. The user turn of this run is
                            // already committed at this boundary, so it is in here.
                            const doc = api.snapshot();
                            midRun = JSON.parse(JSON.stringify(doc));

                            // Read-only IN EFFECT, not just by comment: this is a detached
                            // document, so pushing into it changes nothing the harness or a
                            // later read will ever see.
                            doc.agents.writer.messages.push({ role: 'user', content: 'injected' });
                            afterMutation = JSON.parse(JSON.stringify(api.snapshot()));
                        });
                    }
                }
            ]
        });

        await writer('go');

        // Snapshot version 2: the record store collapsed into ONE collection map with one
        // id counter (records-engine T4/R5), which is a shape change the version must show.
        expect(midRun).toEqual(expect.objectContaining({ version: 2 }));
        expect(withoutIds((midRun as { agents: { writer: { messages: unknown[] } } }).agents.writer.messages)).toEqual([
            { role: 'user', content: 'go' }
        ]);

        // A fresh read is unaffected by the caller mutating the copy it was handed.
        expect(withoutIds((afterMutation as { agents: { writer: { messages: unknown[] } } }).agents.writer.messages)).toEqual([
            { role: 'user', content: 'go' }
        ]);
        expect(JSON.stringify(afterMutation)).not.toContain('injected');
        expect(withoutIds(writer.agent.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'hi' }
        ]);
        // The request the provider got is the projected committed transcript, unchanged
        // by a read-only call: `snapshot()` reports state, it never mutates it.
        expect(seen.map((request) => request.messages)).toEqual([
            [{ role: 'user', content: 'go' }]
        ]);
    });

    it('a snapshot taken from a hook costs no persistence notification at all', async () => {
        const reasons: string[] = [];
        const plain: string[] = [];

        const build = (withAuditor: boolean, sink: string[]) =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                ...(withAuditor
                    ? {
                          plugins: [
                              {
                                  name: 'auditor',
                                  setup: (api) => {
                                      api.on('turn.before', () => {
                                          api.snapshot();
                                      });
                                  }
                              }
                          ]
                      }
                    : {}),
                report: { stateChange: (event) => void sink.push(`${event.reason}:${event.agent ?? '-'}`) }
            });

        await build(false, plain)('go');
        await build(true, reasons)('go');

        // The user append and the committed answer, and nothing else: a read reports no
        // change, which is what keeps it safe to call once per turn.
        expect(plain).toEqual(['agent_message:writer', 'agent_message:writer']);
        expect(reasons).toEqual(plain);
    });

    it('api.settings.setOwn() writes ONLY its own namespace, through the host provider', async () => {
        // A host provider with the optional writer — the proof the write goes THROUGH the
        // provider rather than around it, and the only way to see what a host would store.
        const stored: Record<string, unknown> = {};
        const writes: Array<[string, string, unknown]> = [];
        const refusals: string[] = [];
        const perTurn: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('one'), answer('two')])) },
            pluginSettings: {
                get: (plugin, key) => stored[`${plugin}.${key}`],
                set: (plugin, key, value) => {
                    writes.push([plugin, key, value]);
                    stored[`${plugin}.${key}`] = value;
                }
            },
            plugins: [
                {
                    name: 'policy',
                    metadata: {
                        name: 'policy',
                        title: 'Policy',
                        settings: [
                            { key: 'note', label: 'Note', type: 'string', default: 'unset' },
                            { key: 'limit', label: 'Limit', type: 'number', default: 10, min: 5, max: 20 }
                        ]
                    },
                    setup: (api) => {
                        api.on('turn.before', () => {
                            perTurn.push(api.settings.string('note'));
                            api.settings.setOwn('note', 'written');
                            // The write is live IMMEDIATELY: the view re-reads the
                            // provider on every access (the same property that makes an
                            // operator's PATCH reach a running session), so a plugin sees
                            // its own change without a rebuild or a restart.
                            perTurn.push(api.settings.string('note'));
                            // A number for a string setting is refused, not stringified.
                            try {
                                api.settings.setOwn('note', 7);
                            } catch (error) {
                                refusals.push((error as Error).message);
                            }

                            // Out of the published bounds, so refused.
                            try {
                                api.settings.setOwn('limit', 99);
                            } catch (error) {
                                refusals.push((error as Error).message);
                            }

                            // Another plugin's namespace is not reachable from this view.
                            try {
                                api.settings.setOwn('intervalMs', 1);
                            } catch (error) {
                                refusals.push((error as Error).message);
                            }
                        });
                    }
                }
            ]
        });

        await writer('go');

        // Written exactly once, normalized to the declared type, under THIS plugin's name.
        expect(writes).toEqual([['policy', 'note', 'written']]);
        // The declared default, then the plugin's own write — same view, no rebuild.
        expect(perTurn).toEqual(['unset', 'written']);
        expect(refusals).toEqual([
            '"note" of plugin "policy" must be a string (it is declared "string").',
            '"limit" of plugin "policy" must be at most 20; 99 was submitted.',
            'settings.setOwn received "intervalMs", which plugin "policy" does not declare (declared: "note", "limit").'
        ]);
        expect(stored['policy.note']).toBe('written');
        expect(stored['async-ping.intervalMs']).toBeUndefined();
    });

    it('a host whose provider has no writer is told so, and the write is not silently kept', async () => {
        const refusals: string[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            // The shipped server's live provider is exactly this: read-only, because its
            // store's own PATCH edge stays the one that validates and persists.
            pluginSettings: { get: () => undefined },
            plugins: [
                {
                    name: 'policy',
                    metadata: {
                        name: 'policy',
                        title: 'Policy',
                        settings: [{ key: 'note', label: 'Note', type: 'string', default: 'unset' }]
                    },
                    setup: (api) => {
                        api.on('turn.before', () => {
                            try {
                                api.settings.setOwn('note', 'written');
                            } catch (error) {
                                refusals.push((error as Error).message);
                            }

                            // The refusal is a plugin-level throw inside a hook, so the
                            // bus fail-open rule keeps the run alive either way.
                            api.settings.setOwn('missing', 'x');
                        });
                    }
                }
            ]
        });

        expect((await writer('go')).content).toBe('hi');
        expect(refusals).toEqual([
            'settings.setOwn cannot store "note" of plugin "policy": this harness\'s plugin-settings provider is read-only (no writer).'
        ]);
    });
});

// `HarnessMessage` is used by the transcript assertions above; `HarnessEvent` is NOT
// imported on purpose: a progress frame and a hook payload are different surfaces, and
// this file pins only the hook side.

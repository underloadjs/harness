// Unit tests for the server-owned session transcript (H3).
//
// Everything here runs against injected scripted presets: no provider, no
// network, no filesystem. The catalogue is injected through the SessionStore
// constructor so the tests can script delegation, cancellation, and failures that
// the shipped presets cannot produce offline.
//
// The clock is pinned with a Date.now spy, so turn timestamps are asserted as
// exact numbers. Only turn ids are generated (randomUUID), so those are asserted
// by shape and by identity relative to the emitted frames.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '../harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent, HarnessUsage } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { SessionError, SessionStore } from './sessions';
import type { SessionStreamItem } from './protocol';

// A distinctive key: the copy-safety test also proves settings never leak into a
// snapshot, because this string must not appear in the serialized record.
const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A preset is only metadata + a factory; the store resolves it by name.
const presetOf = (
    name: string,
    create: HarnessPreset['create'],
    agents: readonly string[] = [name]
): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: agents[0] ?? name,
    subagents: agents.slice(1),
    agents,
    tools: [],
    builtin: true,
    editable: true,
    create
});

// Pin the server clock. Every call to `set()` changes what Date.now() returns for
// the rest of the test; `afterEach` restores the real clock.
const pinClock = (initial: number): ((next: number) => void) => {
    let value = initial;
    vi.spyOn(Date, 'now').mockImplementation(() => value);
    return (next: number) => {
        value = next;
    };
};

afterEach(() => {
    vi.restoreAllMocks();
});

// A promise the test settles explicitly, used to hold a run open.
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

// A transport that always answers with one text delta and a terminal frame.
const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield {
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 3, output: 2, total: 5 }
        };
    };

// One agent, one tool-free answer. Used by the turn-shape, order, reset, and
// copy-safety tests.
const singlePreset = (): HarnessPreset =>
    presetOf('single', (settings, progress) =>
        harness({
            agents: {
                single: agent({
                    model: settings.model,
                    instruction: 'You are a scripted test agent.',
                    stream: answerStream('hello')
                })
            },
            primary: 'single',
            presets: false,
            report: { progress }
        })
    );

// Replay one scripted frame list per request, exactly like src/harness.test.ts.
// The last list is reused when a run asks for more requests than were scripted,
// so a preset can be reused across turns. The usage tests below need per-request
// figures, which the shared `answerStream` cannot vary.
const requestStream = (requests: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* (): AsyncGenerator<HarnessStreamEvent> {
        const frames = requests[index] ?? requests[requests.length - 1];
        index++;
        for (const frame of frames) yield frame;
    };
};

// One agent, one tool-free answer whose single request reports exactly `usage`.
// Used by the cached-propagation tests: "reported 0 cached" and "not reported"
// must stay distinguishable all the way into the turn tally.
const usagePreset = (usage: HarnessUsage): HarnessPreset =>
    presetOf('priced', (settings, progress) =>
        harness({
            agents: {
                priced: agent({
                    model: settings.model,
                    instruction: 'You are a scripted test agent.',
                    stream: requestStream([
                        [
                            { type: 'text', delta: 'priced answer' },
                            { type: 'done', stopReason: 'stop', toolCalls: [], usage }
                        ]
                    ])
                })
            },
            primary: 'priced',
            presets: false,
            report: { progress }
        })
    );

// One agent that ALWAYS takes exactly one `todoManage` tool round before
// answering, so a single run makes two model requests. Entry 0 is the tool
// round's usage, entry 1 the answer's; the harness reports each on a `usage`
// event and then repeats the LAST one on `done` (the double-count trap).
// `todoManage` is a CORE tool, declared on the first request without a
// toolRequest round (src/harness.todo.test.ts pins that).
const toolRoundPreset = (usage: readonly [HarnessUsage, HarnessUsage]): HarnessPreset =>
    presetOf('rounds', (settings, progress) =>
        harness({
            agents: {
                rounds: agent({
                    model: settings.model,
                    instruction: 'Take one tool round, then answer.',
                    stream: requestStream([
                        [
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    { id: 'c1', name: 'todoManage', arguments: '{"action":"list"}' }
                                ],
                                usage: usage[0]
                            }
                        ],
                        [
                            { type: 'text', delta: 'all done' },
                            { type: 'done', stopReason: 'stop', toolCalls: [], usage: usage[1] }
                        ]
                    ])
                })
            },
            primary: 'rounds',
            presets: false,
            report: { progress }
        })
    );

// Primary + subagent. The primary asks for `agentDelegate` on its first request and,
// after the harness appends the delegate result as a tool message, answers with
// text. The helper answers on its own stream. This exercises the fact that the
// session records subagent progress in the primary turn.
const teamPreset = (): HarnessPreset =>
    presetOf(
        'team',
        (settings, progress) =>
            harness({
                agents: {
                    lead: agent({
                        model: settings.model,
                        instruction: 'You are the delegating lead.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            const last = request.messages[request.messages.length - 1];

                            if (last !== undefined && last.role === 'tool' && last.name === 'agentDelegate') {
                                yield { type: 'text', delta: 'done by helper' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                                return;
                            }

                            yield {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    {
                                        id: 'call_1',
                                        name: 'agentDelegate',
                                        arguments: '{"agent":"helper","input":"find it"}'
                                    }
                                ]
                            };
                        }
                    }),
                    helper: agent({
                        model: settings.model,
                        instruction: 'You are the delegated helper.',
                        stream: answerStream('helper answer')
                    })
                },
                primary: 'lead',
                subagents: ['helper'],
                presets: false,
                report: { progress }
            }),
        ['lead', 'helper']
    );

describe('SessionStore turns', () => {
    it('opens the stream with the running turn and records every event', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const created = store.create('single');
        expect(created.turns).toEqual([]);

        setClock(2_000);

        const items: SessionStreamItem[] = [];
        await store.run(created.id, '  say hello  ', async (item) => {
            items.push(item);
        });

        // 1. The first frame is the turn itself, before any harness event, with the
        //    trimmed prompt and no events yet.
        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);

        const turnId = opening.turn.id;
        expect(turnId).toMatch(UUID_PATTERN);
        expect(opening.turn).toEqual({
            id: turnId,
            index: 0,
            prompt: 'say hello',
            status: 'running',
            startedAt: 2_000,
            updatedAt: 2_000,
            events: [],
            // Parallel to `events` and empty until the first record arrives.
            eventTimes: []
        });

        // 2. Every event frame names the turn, and the events are exactly the
        //    scripted start/text/done sequence.
        const events = items.slice(1, -1).map((item) => {
            if (item.type !== 'event') {
                throw new Error(`expected only event frames before the terminal one, got ${item.type}`);
            }

            expect(item.turnId).toBe(turnId);
            return item.event;
        });

        expect(events).toEqual([
            { type: 'start', agent: 'single', model: 'scripted/test' },
            { type: 'text', agent: 'single', delta: 'hello' },
            // Per-request accounting (`src/harness.ts:704`): the harness reports
            // the request's usage AFTER the streamed text and BEFORE the terminal
            // message, so the event list has exactly one entry between them.
            { type: 'usage', agent: 'single', usage: { input: 3, output: 2, total: 5 } },
            {
                type: 'done',
                agent: 'single',
                message: {
                    role: 'assistant',
                    content: 'hello',
                    reasoning: '',
                    toolCalls: [],
                    model: 'scripted/test',
                    stopReason: 'stop',
                    usage: { input: 3, output: 2, total: 5 }
                }
            }
        ]);

        // 3. The terminal snapshot carries the complete turn, including every
        //    recorded event and the stable start timestamp.
        const terminal = items.at(-1);
        if (terminal?.type !== 'snapshot') {
            throw new Error(`expected a snapshot last, got ${terminal?.type}`);
        }

        expect(terminal.session.status).toBe('idle');
        expect(terminal.session.turns).toEqual([
            {
                id: turnId,
                index: 0,
                prompt: 'say hello',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 2_000,
                events,
                // The clock is pinned, so every record shares this timestamp.
                eventTimes: [2_000, 2_000, 2_000, 2_000],
                // The server's running tally for the one reported request
                // (`SessionStore` addUsage). No `cached` key: this fixture never
                // reports a cache figure, and absent must stay absent.
                usage: { input: 3, output: 2, total: 5 }
            }
        ]);

        // 4. Reload path: get() and list() return the same authoritative record.
        expect(store.get(created.id)).toEqual(terminal.session);
        expect(store.list()).toEqual([terminal.session]);

        // 5. Provider settings (including the key) never enter a snapshot.
        expect(JSON.stringify(terminal.session)).not.toContain('super-secret-key');
    });

    it('carries the running tally on every frame from the first usage event on', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const created = store.create('single');

        setClock(2_000);

        const items: SessionStreamItem[] = [];
        await store.run(created.id, 'cost please', async (item) => {
            items.push(item);
        });

        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);

        const turnId = opening.turn.id;

        // The one request's reported usage is the server's whole tally here.
        const tally = { input: 3, output: 2, total: 5 };

        // The recorded event list, in emission order: start/text precede the
        // per-request usage, and the terminal `done` repeats the same usage only
        // inside its message.
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'single', model: 'scripted/test' },
            { type: 'text', agent: 'single', delta: 'hello' },
            { type: 'usage', agent: 'single', usage: { input: 3, output: 2, total: 5 } },
            {
                type: 'done',
                agent: 'single',
                message: {
                    role: 'assistant',
                    content: 'hello',
                    reasoning: '',
                    toolCalls: [],
                    model: 'scripted/test',
                    stopReason: 'stop',
                    usage: { input: 3, output: 2, total: 5 }
                }
            }
        ];

        // Every frame is asserted whole. `usage` is ABSENT (not `undefined`) on the
        // opening turn frame and on the frames before the first usage event, so a
        // client cannot print a tally it was never handed.
        expect(items.slice(0, -1)).toEqual([
            {
                type: 'turn',
                turn: {
                    id: turnId,
                    index: 0,
                    prompt: 'cost please',
                    status: 'running',
                    startedAt: 2_000,
                    updatedAt: 2_000,
                    events: [],
                    eventTimes: []
                }
            },
            {
                type: 'event',
                turnId,
                at: 2_000,
                event: { type: 'start', agent: 'single', model: 'scripted/test' }
            },
            {
                type: 'event',
                turnId,
                at: 2_000,
                event: { type: 'text', agent: 'single', delta: 'hello' }
            },
            {
                // The usage frame already carries the tally its own event produced.
                type: 'event',
                turnId,
                at: 2_000,
                event: { type: 'usage', agent: 'single', usage: { input: 3, output: 2, total: 5 } },
                usage: tally
            },
            {
                // `done` reports the same request's usage again inside its message;
                // the sink does not fold it, so the frame tally is unchanged.
                type: 'event',
                turnId,
                at: 2_000,
                event: {
                    type: 'done',
                    agent: 'single',
                    message: {
                        role: 'assistant',
                        content: 'hello',
                        reasoning: '',
                        toolCalls: [],
                        model: 'scripted/test',
                        stopReason: 'stop',
                        usage: { input: 3, output: 2, total: 5 }
                    }
                },
                usage: tally
            }
        ]);

        const terminal = items.at(-1);
        if (terminal?.type !== 'snapshot') {
            throw new Error(`expected a snapshot last, got ${terminal?.type}`);
        }

        // The reloaded record agrees with the live frames: same events, same tally.
        expect(terminal.session.turns).toEqual([
            {
                id: turnId,
                index: 0,
                prompt: 'cost please',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 2_000,
                events,
                eventTimes: [2_000, 2_000, 2_000, 2_000],
                usage: { input: 3, output: 2, total: 5 }
            }
        ]);
    });

    it('sums every reported request and never counts the repeated done usage', async () => {
        const setClock = pinClock(1_000);

        // Both requests of the tool round report the same figures, so a sink that
        // also folded `done` would report {9,6,15} instead of {6,4,10}.
        const step = { input: 3, output: 2, total: 5 };
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([toolRoundPreset([step, step])]));
        const created = store.create('rounds');
        setClock(2_000);

        const items: SessionStreamItem[] = [];
        await store.run(created.id, 'two requests', async (item) => {
            items.push(item);
        });

        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);

        const events = items.slice(1, -1).map((item) => {
            if (item.type !== 'event') {
                throw new Error(`expected only event frames before the terminal one, got ${item.type}`);
            }

            expect(item.turnId).toBe(opening.turn.id);
            return item.event;
        });

        // One start, one usage per request, the tool round in between, then the
        // answer. Each request's usage precedes its own terminal message.
        expect(events).toEqual([
            { type: 'start', agent: 'rounds', model: 'scripted/test' },
            { type: 'usage', agent: 'rounds', usage: { input: 3, output: 2, total: 5 } },
            {
                type: 'tool_call',
                agent: 'rounds',
                call: { id: 'c1', name: 'todoManage', arguments: '{"action":"list"}' }
            },
            {
                type: 'tool_result',
                agent: 'rounds',
                name: 'todoManage',
                callId: 'c1',
                content:
                    '{"todos":[],"counts":{"total":0,"completed":0,"remaining":0},"page":{"offset":0,"limit":20,"hasMore":false}}',
                // Every EXECUTED call reports its span, inline ones included
                // (harness.ts deliverTask). The clock is pinned at 2_000, so the
                // inline todoManage round is exactly 0 ms.
                durationMs: 0,
                isError: false,
                outcome: 'completed'
            },
            { type: 'text', agent: 'rounds', delta: 'all done' },
            { type: 'usage', agent: 'rounds', usage: { input: 3, output: 2, total: 5 } },
            {
                type: 'done',
                agent: 'rounds',
                message: {
                    role: 'assistant',
                    content: 'all done',
                    reasoning: '',
                    toolCalls: [],
                    model: 'scripted/test',
                    stopReason: 'stop',
                    usage: { input: 3, output: 2, total: 5 }
                }
            }
        ]);

        const terminal = items.at(-1);
        if (terminal?.type !== 'snapshot') {
            throw new Error(`expected a snapshot last, got ${terminal?.type}`);
        }

        // Two requests × {3,2,5}; the repeated `done` usage is deliberately not
        // added (double-count guard).
        expect(terminal.session.turns[0].usage).toEqual({ input: 6, output: 4, total: 10 });

        // The final event frame carries the same running tally after the second sum.
        expect(items.at(-2)).toEqual({
            type: 'event',
            turnId: opening.turn.id,
            at: 2_000,
            event: events[6],
            usage: { input: 6, output: 4, total: 10 }
        });
    });

    it('sums cached only over the requests that report it', async () => {
        const setClock = pinClock(1_000);

        // Request 0 reports no cache figure at all; request 1 reports 2 cached. The
        // tally carries the reported sum only and never invents a 0 for request 0.
        const store = new SessionStore(
            DEFAULTS,
            createHarnessRegistry([
                toolRoundPreset([
                    { input: 3, output: 2, total: 5 },
                    { input: 4, output: 3, total: 7, cached: 2 }
                ])
            ])
        );
        const created = store.create('rounds');
        setClock(2_000);

        await store.run(created.id, 'cache me', async () => {});

        expect(store.get(created.id).turns[0].usage).toEqual({
            input: 7,
            output: 5,
            total: 12,
            cached: 2
        });
    });

    it('omits cached entirely when no request reports it', async () => {
        pinClock(2_000);
        const store = new SessionStore(
            DEFAULTS,
            createHarnessRegistry([usagePreset({ input: 5, output: 1, total: 6 })])
        );
        const created = store.create('priced');

        await store.run(created.id, 'no cache', async () => {});

        // toEqual without `cached` fails if the tally carries the key at all, so
        // this pins "absent stays absent" (never a zero-filled figure).
        expect(store.get(created.id).turns[0].usage).toEqual({ input: 5, output: 1, total: 6 });
    });

    it('keeps a reported cached figure of zero distinct from absent', async () => {
        pinClock(2_000);
        const store = new SessionStore(
            DEFAULTS,
            createHarnessRegistry([usagePreset({ input: 5, output: 1, total: 6, cached: 0 })])
        );
        const created = store.create('priced');

        await store.run(created.id, 'zero cache', async () => {});

        // The provider DID report a cache figure, so the tally must carry the 0.
        expect(store.get(created.id).turns[0].usage).toEqual({
            input: 5,
            output: 1,
            total: 6,
            cached: 0
        });
    });

    it('keeps the partial tally of the completed requests when a run is cancelled', async () => {
        // R3: a cancelled run bills only what the provider had already answered.
        // Request 0 settles with usage and asks for a tool round; request 1 hangs
        // until the abort, so it never reports usage. The tally must be request
        // 0's figures exactly — no zero-filled request, no double count.
        const first = { input: 100, output: 5, total: 105, cached: 40 };
        const secondRequest = deferred();

        const partialPreset = presetOf('partial', (settings, progress) =>
            harness({
                agents: {
                    partial: agent({
                        model: settings.model,
                        instruction: 'One tool round, then wait for the abort.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            const last = request.messages[request.messages.length - 1];

                            if (last !== undefined && last.role === 'tool' && last.name === 'todoManage') {
                                // Request 1 is now in flight; the test cancels from here.
                                secondRequest.resolve();

                                await new Promise<void>((_resolve, reject) => {
                                    if (request.signal?.aborted === true) {
                                        reject(new Error('The run was aborted.'));
                                        return;
                                    }

                                    request.signal?.addEventListener(
                                        'abort',
                                        () => reject(new Error('The run was aborted.')),
                                        { once: true }
                                    );
                                });
                                return;
                            }

                            yield {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    { id: 'c1', name: 'todoManage', arguments: '{"action":"list"}' }
                                ],
                                usage: first
                            };
                        }
                    })
                },
                primary: 'partial',
                presets: false,
                report: { progress }
            })
        );

        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([partialPreset]));
        const created = store.create('partial');
        setClock(2_000);

        const items: SessionStreamItem[] = [];
        const running = store.run(created.id, 'cancel mid-run', async (item) => {
            items.push(item);
        });

        await secondRequest.promise;
        expect(store.cancel(created.id)).toBe(true);
        await running;

        const turn = store.get(created.id).turns[0];
        expect(turn.status).toBe('cancelled');
        // Exactly one usage event (request 0); the aborted request reported none.
        expect(turn.events.filter((event) => event.type === 'usage')).toEqual([
            { type: 'usage', agent: 'partial', usage: first }
        ]);
        expect(turn.usage).toEqual(first);
    });

    it('records subagent events in the primary turn', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([teamPreset()]));
        const created = store.create('team');
        setClock(2_000);

        const items: SessionStreamItem[] = [];
        await store.run(created.id, 'delegate please', async (item) => {
            items.push(item);
        });

        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);

        const events = items.slice(1, -1).map((item) => {
            if (item.type !== 'event') {
                throw new Error(`expected only event frames before the terminal one, got ${item.type}`);
            }

            expect(item.turnId).toBe(opening.turn.id);
            return item.event;
        });

        // Delegation is one tool call, so the helper's start/text/done land in the
        // middle of the lead's event stream, in this exact order.
        expect(events).toEqual([
            { type: 'start', agent: 'lead', model: 'scripted/test' },
            {
                type: 'tool_call',
                agent: 'lead',
                call: {
                    id: 'call_1',
                    name: 'agentDelegate',
                    arguments: '{"agent":"helper","input":"find it"}'
                }
            },
            {
                type: 'start',
                agent: 'helper',
                model: 'scripted/test',
                // T3 thread identity: direct child of the root, so no parentId; the
                // prompt travels on this frame only.
                thread: { id: '2', callId: 'call_1', input: 'find it' }
            },
            {
                type: 'text',
                agent: 'helper',
                delta: 'helper answer',
                thread: { id: '2', callId: 'call_1' }
            },
            // Only the helper's stream reports usage here: the lead's two requests
            // have no `usage` on their `done` frames, so they emit no usage event.
            {
                type: 'usage',
                agent: 'helper',
                usage: { input: 3, output: 2, total: 5 },
                thread: { id: '2', callId: 'call_1' }
            },
            {
                type: 'done',
                agent: 'helper',
                thread: { id: '2', callId: 'call_1' },
                message: {
                    role: 'assistant',
                    content: 'helper answer',
                    reasoning: '',
                    toolCalls: [],
                    model: 'scripted/test',
                    stopReason: 'stop',
                    usage: { input: 3, output: 2, total: 5 }
                }
            },
            {
                type: 'tool_result',
                agent: 'lead',
                name: 'agentDelegate',
                callId: 'call_1',
                content: '{"agent":"helper","content":"helper answer"}',
                // Additive execution span (harness.ts deliverTask). The clock is
                // pinned at 2_000, so the delegated inline call is exactly 0 ms.
                durationMs: 0,
                isError: false,
                outcome: 'completed'
            },
            { type: 'text', agent: 'lead', delta: 'done by helper' },
            {
                type: 'done',
                agent: 'lead',
                message: {
                    role: 'assistant',
                    content: 'done by helper',
                    reasoning: '',
                    toolCalls: [],
                    model: 'scripted/test',
                    stopReason: 'stop'
                }
            }
        ]);

        const terminal = items.at(-1);
        if (terminal?.type !== 'snapshot') {
            throw new Error(`expected a snapshot last, got ${terminal?.type}`);
        }

        // One turn owns both agents: the subagent does not create a second turn.
        expect(terminal.session.turns).toHaveLength(1);
        expect(terminal.session.turns[0].status).toBe('done');
        expect(terminal.session.turns[0].events).toEqual(events);

        // Persistence roundtrip (R3): a saved turn is the reconstruction source after
        // a reload, so the thread identity must survive plain JSON unchanged, and a
        // legacy (root) frame must still carry NO `thread` key at all.
        expect(JSON.parse(JSON.stringify(terminal.session.turns[0].events))).toEqual(events);
        expect(Object.keys(events[0]).sort()).toEqual(['agent', 'model', 'type']);
        // The delegated request's spend belongs to the same turn: only the helper
        // reported usage, so the tally is that one request's figures.
        expect(terminal.session.turns[0].usage).toEqual({ input: 3, output: 2, total: 5 });
        expect(store.get(created.id).turns).toEqual(terminal.session.turns);
    });

    it('keeps sequential turns in order and leaves earlier turns untouched', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const created = store.create('single');

        setClock(2_000);
        const firstItems: SessionStreamItem[] = [];
        await store.run(created.id, 'first', async (item) => {
            firstItems.push(item);
        });

        const firstTerminal = firstItems.at(-1);
        if (firstTerminal?.type !== 'snapshot') {
            throw new Error(`expected a snapshot last, got ${firstTerminal?.type}`);
        }

        const firstTurn = firstTerminal.session.turns[0];

        setClock(3_000);
        const secondItems: SessionStreamItem[] = [];
        await store.run(created.id, 'second', async (item) => {
            secondItems.push(item);
        });

        const secondOpening = secondItems[0];
        if (secondOpening.type !== 'turn') {
            throw new Error(`expected a turn frame first, got ${secondOpening.type}`);
        }

        const secondTerminal = secondItems.at(-1);
        if (secondTerminal?.type !== 'snapshot') {
            throw new Error(`expected a snapshot last, got ${secondTerminal?.type}`);
        }

        const turns = secondTerminal.session.turns;
        expect(
            turns.map((turn) => ({
                index: turn.index,
                prompt: turn.prompt,
                status: turn.status,
                startedAt: turn.startedAt,
                updatedAt: turn.updatedAt
            }))
        ).toEqual([
            { index: 0, prompt: 'first', status: 'done', startedAt: 2_000, updatedAt: 2_000 },
            { index: 1, prompt: 'second', status: 'done', startedAt: 3_000, updatedAt: 3_000 }
        ]);

        // The first turn is exactly what it was before the second run.
        expect(turns[0]).toEqual(firstTurn);
        // The second turn is the frame the stream opened with.
        expect(turns[1].id).toBe(secondOpening.turn.id);
        expect(turns[0].id).not.toBe(turns[1].id);

        // Both turns survive a reload, in order.
        expect(store.get(created.id).turns).toEqual(turns);
    });

    it('rejects busy and invalid runs without mutating the turn list', async () => {
        const setClock = pinClock(1_000);
        const gate = deferred();

        const gatedPreset = presetOf('gated', (settings, progress) =>
            harness({
                agents: {
                    gated: agent({
                        model: settings.model,
                        instruction: 'Wait for the gate.',
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            await gate.promise;
                            yield { type: 'text', delta: 'released' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'gated',
                presets: false,
                report: { progress }
            })
        );

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([gatedPreset]));
        const created = store.create('gated');
        setClock(2_000);

        const items: SessionStreamItem[] = [];
        const started = deferred();
        const running = store.run(created.id, 'first', async (item) => {
            items.push(item);

            if (item.type === 'event' && item.event.type === 'start') started.resolve();
        });

        await started.promise;

        // Busy rejection: a 409 and no queued turn.
        const busy = store.run(created.id, 'second', async () => {});
        await expect(busy).rejects.toBeInstanceOf(SessionError);
        await expect(busy).rejects.toMatchObject({
            status: 409,
            message: 'A task is already running in this session.'
        });

        // The in-flight state is readable through get() and already has its turn.
        const during = store.get(created.id);
        expect(during.status).toBe('running');
        expect(during.turns.map((turn) => turn.prompt)).toEqual(['first']);
        expect(during.turns[0].status).toBe('running');

        gate.resolve();
        await running;

        // Validation errors happen before mutation too.
        await expect(store.run(created.id, '   ', async () => {})).rejects.toMatchObject({ status: 400 });
        await expect(store.run(created.id, 'x'.repeat(200_001), async () => {})).rejects.toMatchObject({
            status: 413
        });

        const final = store.get(created.id);
        expect(final.turns.map((turn) => turn.prompt)).toEqual(['first']);
        expect(final.turns[0].status).toBe('done');
        expect(final.turns[0].events.map((event) => event.type)).toEqual(['start', 'text', 'done']);
    });

    it('marks a cancelled run cancelled and keeps the events recorded before abort', async () => {
        const setClock = pinClock(1_000);

        const hangingPreset = presetOf('hanging', (settings, progress) =>
            harness({
                agents: {
                    hanging: agent({
                        model: settings.model,
                        instruction: 'Wait until aborted.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            yield { type: 'text', delta: 'partial' };

                            // Hold the run open until the signal aborts, exactly like
                            // a provider waiting on the next chunk.
                            await new Promise<void>((_resolve, reject) => {
                                if (request.signal?.aborted) {
                                    reject(new Error('The run was aborted.'));
                                    return;
                                }

                                request.signal?.addEventListener(
                                    'abort',
                                    () => reject(new Error('The run was aborted.')),
                                    { once: true }
                                );
                            });
                        }
                    })
                },
                primary: 'hanging',
                presets: false,
                report: { progress }
            })
        );

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([hangingPreset]));
        const created = store.create('hanging');
        setClock(2_000);

        const items: SessionStreamItem[] = [];
        const partial = deferred();
        const running = store.run(created.id, 'stop me', async (item) => {
            items.push(item);

            if (item.type === 'event' && item.event.type === 'text') partial.resolve();
        });

        await partial.promise;
        expect(store.cancel(created.id)).toBe(true);
        await running;

        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);

        // The error event is recorded but not streamed, because the abort closes the
        // stream. The terminal frame still carries it inside the snapshot.
        expect(items.map((item) => item.type)).toEqual(['turn', 'event', 'event', 'failed']);

        const terminal = items.at(-1);
        if (terminal?.type !== 'failed') {
            throw new Error(`expected a failed frame last, got ${terminal?.type}`);
        }

        expect(terminal.error).toEqual({ message: 'The run was cancelled.' });
        expect(terminal.session.status).toBe('error');
        expect(terminal.session.lastError).toBe('The run was cancelled.');
        expect(terminal.session.turns).toEqual([
            {
                id: opening.turn.id,
                index: 0,
                prompt: 'stop me',
                status: 'cancelled',
                startedAt: 2_000,
                updatedAt: 2_000,
                events: [
                    { type: 'start', agent: 'hanging', model: 'scripted/test' },
                    { type: 'text', agent: 'hanging', delta: 'partial' },
                    // T15: cancellation is PREEMPTIVE, so the recorded error is the
                    // run signal's reason rather than the transport's own rejection
                    // (harness.ts abortErrorOf). The store aborts without a reason
                    // (sessions.ts forwardAbort), so the DOM default is the exact
                    // text; the session banner still uses `lastError`, asserted
                    // above as 'The run was cancelled.'.
                    {
                        type: 'error',
                        agent: 'hanging',
                        error: { message: 'This operation was aborted' }
                    }
                ],
                eventTimes: [2_000, 2_000, 2_000]
            }
        ]);

        // Survives reload, and cancelling again is a no-op.
        expect(store.get(created.id).turns).toEqual(terminal.session.turns);
        expect(store.cancel(created.id)).toBe(false);
        expect(store.assertRunnable(created.id)).toBeUndefined();
    });

    it('records an error turn when the transport fails', async () => {
        const setClock = pinClock(1_000);

        const brokenPreset = presetOf('broken', (settings, progress) =>
            harness({
                agents: {
                    broken: agent({
                        model: settings.model,
                        instruction: 'Fail.',
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            yield { type: 'error', message: 'provider exploded' };
                        }
                    })
                },
                primary: 'broken',
                presets: false,
                report: { progress }
            })
        );

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([brokenPreset]));
        const created = store.create('broken');
        setClock(2_000);

        const items: SessionStreamItem[] = [];
        await store.run(created.id, 'explode', async (item) => {
            items.push(item);
        });

        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);

        const terminal = items.at(-1);
        if (terminal?.type !== 'failed') {
            throw new Error(`expected a failed frame last, got ${terminal?.type}`);
        }

        expect(terminal.error).toEqual({ message: 'provider exploded' });
        expect(terminal.session.status).toBe('error');
        expect(terminal.session.lastError).toBe('provider exploded');
        expect(terminal.session.turns).toEqual([
            {
                id: opening.turn.id,
                index: 0,
                prompt: 'explode',
                status: 'error',
                startedAt: 2_000,
                updatedAt: 2_000,
                events: [
                    { type: 'start', agent: 'broken', model: 'scripted/test' },
                    { type: 'error', agent: 'broken', error: { message: 'provider exploded' } }
                ],
                eventTimes: [2_000, 2_000]
            }
        ]);

        // A failed turn is retained for the next reload.
        expect(store.get(created.id)).toEqual(terminal.session);
    });

    it('clears turns on reset and isolates sessions from each other', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const first = store.create('single');
        const second = store.create('single');

        setClock(2_000);
        await store.run(first.id, 'first task', async () => {});
        await store.run(second.id, 'second task', async () => {});

        expect(store.get(first.id).turns.map((turn) => turn.prompt)).toEqual(['first task']);
        expect(store.get(second.id).turns.map((turn) => turn.prompt)).toEqual(['second task']);
        expect(store.get(first.id).turns[0].id).not.toBe(store.get(second.id).turns[0].id);

        const reset = store.reset(first.id);
        expect(reset.turns).toEqual([]);
        expect(reset.status).toBe('idle');
        expect(reset.messages.every((message) => message.role === 'system')).toBe(true);
        expect(reset.lastError).toBeUndefined();

        // The other session is untouched by the reset.
        expect(store.get(second.id).turns.map((turn) => turn.prompt)).toEqual(['second task']);

        // remove() deletes the record and its turns with it.
        expect(store.remove(first.id)).toBe(true);
        expect(() => store.get(first.id)).toThrow(SessionError);
        expect(store.list().map((session) => session.id)).toEqual([second.id]);
    });

    it('returns copies, so a client cannot mutate the stored session', async () => {
        pinClock(2_000);
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const created = store.create('single');

        const items: SessionStreamItem[] = [];
        await store.run(created.id, 'original', async (item) => {
            items.push(item);

            // Tamper with the frames as a hostile in-process listener would.
            if (item.type === 'turn') item.turn.prompt = 'tampered';
            if (item.type === 'event') item.event = { type: 'text', agent: 'x', delta: 'tampered' };
        });

        const opening = items[0];
        if (opening.type !== 'turn') throw new Error(`expected a turn frame first, got ${opening.type}`);
        const turnId = opening.turn.id;

        // The tampering affected the caller's frame only.
        expect(opening.turn.prompt).toBe('tampered');

        const stored = store.get(created.id);
        expect(stored.turns[0].prompt).toBe('original');
        expect(stored.turns[0].events.map((event) => event.type)).toEqual([
            'start',
            'text',
            'usage',
            'done'
        ]);

        // Mutating a snapshot must not change a later read.
        const external = store.get(created.id);
        external.turns[0].prompt = 'mutated';
        external.turns[0].events.length = 0;

        // The running tally is copied exactly like `eventTimes`, so tampering with
        // the object a client received cannot rewrite the server's figure.
        const usage = external.turns[0].usage;
        if (usage === undefined) throw new Error('expected a usage tally on the copied turn');
        usage.input = 999;
        usage.output = 999;
        usage.total = 999;
        usage.cached = 999;

        external.turns.pop();
        external.messages.length = 0;

        expect(store.get(created.id)).toEqual({
            id: created.id,
            harness: 'single',
            status: 'idle',
            model: 'scripted/test',
            // Every agent's effective model is part of the snapshot (R9); this
            // harness has one agent and no override, so it reports the session model.
            agentModels: { single: 'scripted/test' },
            createdAt: 2_000,
            updatedAt: 2_000,
            messages: [
                { role: 'system', content: 'You are a scripted test agent.' },
                { role: 'user', content: 'original' },
                { role: 'assistant', content: 'hello' }
            ],
            turns: [
                {
                    id: turnId,
                    index: 0,
                    prompt: 'original',
                    status: 'done',
                    startedAt: 2_000,
                    updatedAt: 2_000,
                    events: [
                        { type: 'start', agent: 'single', model: 'scripted/test' },
                        { type: 'text', agent: 'single', delta: 'hello' },
                        { type: 'usage', agent: 'single', usage: { input: 3, output: 2, total: 5 } },
                        {
                            type: 'done',
                            agent: 'single',
                            message: {
                                role: 'assistant',
                                content: 'hello',
                                reasoning: '',
                                toolCalls: [],
                                model: 'scripted/test',
                                stopReason: 'stop',
                                usage: { input: 3, output: 2, total: 5 }
                            }
                        }
                    ],
                    eventTimes: [2_000, 2_000, 2_000, 2_000],
                    // Untouched by the tampering above: the live tally survives.
                    usage: { input: 3, output: 2, total: 5 }
                }
            ],
            // R6 tombstone: the label this turn minted is remembered (counters
            // only), so deleting the turn later cannot re-mint "SE1" for different
            // content.
            labelHighWater: { SE: 1 },
            // The frozen configuration captured at creation, and the (empty)
            // discovery set. Both survive a reload.
            harnessDefinition: {
                name: 'single',
                title: 'single',
                description: 'single scripted preset',
                requiresEndpoint: false,
                primary: 'single',
                subagents: [],
                agents: ['single'],
                tools: [],
                coreTools: [
                    'toolRequest',
                    'toolCreate',
                    'todoManage',
                    'profileManage',
                    'chapterManage',
                    'locationManage',
                    'agentManage',
                    'agentResult',
                    'threadFork'
                ],
                builtin: true,
                editable: true
            },
            discoveredTools: []
        });
    });

    it('reports unknown harnesses and sessions with the existing statuses', () => {
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));

        expect(() => store.create('missing')).toThrow('Unknown harness "missing".');
        expect(() => store.create('missing')).toThrow(SessionError);
        expect(() => store.get('missing')).toThrow('Unknown session "missing".');
    });
});

// Registry interactions and discovery retention through the session record.
describe('SessionStore and the harness registry', () => {
    // Replay one scripted frame list per request, like src/harness.test.ts does.
    const scriptedStream = (turns: HarnessStreamEvent[][]): HarnessStream => {
        let index = 0;

        return async function* (): AsyncGenerator<HarnessStreamEvent> {
            const frames = turns[index] ?? turns[turns.length - 1];
            index++;
            for (const frame of frames) yield frame;
        };
    };

    it('freezes the harness definition at creation', () => {
        pinClock(1_000);
        const registry = createHarnessRegistry();
        const store = new SessionStore(DEFAULTS, registry);
        const before = store.create('instruct');

        expect(before.harnessDefinition?.title).toBe('Instruct');
        expect(before.messages[0]).toEqual({
            role: 'system',
            content:
                'You are the Instruct agent. Answer the request directly and keep the answer focused.'
        });

        // A registry override replaces the entry; it cannot reach the session that
        // captured the old preset (and its factory). The allowlist is restated so the
        // test pins the routing change itself, not the inherited-team derivation.
        registry.update('instruct', { title: 'Edited', primary: 'workspace', subagents: [] });
        expect(store.get(before.id).harnessDefinition?.title).toBe('Instruct');
        expect(store.get(before.id).harnessDefinition?.primary).toBe('instruct');
        expect(store.get(before.id).messages[0]).toEqual({
            role: 'system',
            content:
                'You are the Instruct agent. Answer the request directly and keep the answer focused.'
        });

        // A new session resolves the patched entry and is built from it.
        const after = store.create('instruct');
        expect(after.harnessDefinition?.title).toBe('Edited');
        expect(after.harnessDefinition?.primary).toBe('workspace');
        expect(after.harnessDefinition?.agents).toEqual(['workspace']);
        expect(after.messages[0]).toEqual({ role: 'system', content: 'You are a workspace coding agent.' });
    });

    it('keeps discovery enabled across two turns in one session', async () => {
        const setClock = pinClock(1_000);

        const reader = tool({
            description: 'Read a text file.',
            tags: ['files', 'read'],
            execute: () => 'file contents'
        });

        const discovering = presetOf('discovering', (settings, progress) =>
            harness({
                agents: {
                    discovering: agent({
                        model: settings.model,
                        instruction: 'Discover, then read.',
                        stream: scriptedStream([
                            [{ type: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'toolRequest', arguments: '{"tags":["read"]}' }] }],
                            [{ type: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'c2', name: 'reader', arguments: '{"path":"a.txt"}' }] }],
                            [{ type: 'text', delta: 'first' }, { type: 'done', stopReason: 'stop', toolCalls: [] }],
                            [{ type: 'text', delta: 'second' }, { type: 'done', stopReason: 'stop', toolCalls: [] }]
                        ])
                    })
                },
                primary: 'discovering',
                tools: { reader },
                presets: false,
                report: { progress }
            })
        );

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([discovering]));
        const created = store.create('discovering');

        setClock(2_000);
        await store.run(created.id, 'first', async () => {});
        expect(store.get(created.id).discoveredTools).toEqual(['reader']);

        // The second turn starts from the harness's existing enabled set: no new
        // toolRequest round, and the tool is still declared/callable.
        setClock(3_000);
        const items: SessionStreamItem[] = [];
        await store.run(created.id, 'second', async (item) => {
            items.push(item);
        });

        const second = store.get(created.id).turns[1];
        expect(second.events.map((event) => event.type)).toEqual(['start', 'text', 'done']);
        expect(second.eventTimes).toEqual([3_000, 3_000, 3_000]);
        expect(store.get(created.id).discoveredTools).toEqual(['reader']);

        // reset() clears the discovery record with the conversation.
        store.reset(created.id);
        expect(store.get(created.id).discoveredTools).toEqual([]);
        expect(store.get(created.id).turns).toEqual([]);
    });
});

// Per-agent model retargeting on a LIVE session (PATCH /sessions/:id, R2).
//
// A model change must not rebuild the harness or lose history: the agent keeps
// its transcript and only the next request targets the new id. These tests pin
// the three things that can go wrong silently:
//   1. the patch updates the live map (`model`/`agentModels`) but not the frozen
//      `harnessDefinition`;
//   2. a change arriving while a request streams does not relabel that request
//      (attribution stays the model that actually ran);
//   3. validation is all-or-nothing, so a rejected patch leaves every agent alone.
describe('SessionStore agent model retargeting', () => {
    // Two agents whose transport records the model each REQUEST names. `overrides`
    // is the preset's per-agent map (so the frozen definition carries it), and
    // `wait` lets a test hold a request open while it patches mid-flight.
    const modelProbePreset = (
        overrides: Readonly<Record<string, string>> = {},
        wait?: () => Promise<void>
    ): { preset: HarnessPreset; requests: string[] } => {
        const requests: string[] = [];

        const preset = presetOf(
            'probe',
            (settings, progress) => {
                // Mirror the registry's factory: an override wins, otherwise the
                // session settings' model (see ./harnesses/toolbox.ts).
                const probe = (name: string) =>
                    agent({
                        model: overrides[name] ?? settings.model,
                        instruction: `You are ${name}.`,
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            // Recorded BEFORE any await: this is the model the
                            // transport actually sent, i.e. the attribution truth.
                            requests.push(request.model);

                            if (wait !== undefined) await wait();

                            yield { type: 'text', delta: `${name} answered` };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    });

                return harness({
                    agents: { lead: probe('lead'), helper: probe('helper') },
                    primary: 'lead',
                    subagents: ['helper'],
                    presets: false,
                    report: { progress }
                });
            },
            ['lead', 'helper']
        );

        return { preset: { ...preset, agentModels: { ...overrides } }, requests };
    };

    it('changes one agent in place, reporting the live map over the frozen definition', () => {
        const setClock = pinClock(1_000);
        const { preset, requests } = modelProbePreset({ helper: 'small/fast' });
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('probe');

        // Baseline: the override applies to `helper` only; the entry agent keeps
        // the session model. The definition carries exactly the preset's map.
        expect(created.model).toBe('scripted/test');
        expect(created.agentModels).toEqual({ lead: 'scripted/test', helper: 'small/fast' });
        expect(created.harnessDefinition?.agentModels).toEqual({ helper: 'small/fast' });

        setClock(2_000);

        // Merge semantics: only the named agent changes (values are trimmed).
        const patched = store.setAgentModels(created.id, { helper: '  big/model  ' });

        expect(patched.model).toBe('scripted/test');
        expect(patched.agentModels).toEqual({ lead: 'scripted/test', helper: 'big/model' });
        expect(patched.updatedAt).toBe(2_000);
        // The frozen snapshot still records what the session was BUILT with.
        expect(patched.harnessDefinition?.agentModels).toEqual({ helper: 'small/fast' });

        // The store (not just the returned copy) holds the change: a reload and a
        // later list() report the same live map.
        expect(store.get(created.id).agentModels).toEqual({
            lead: 'scripted/test',
            helper: 'big/model'
        });
        expect(store.list().map((session) => session.agentModels)).toEqual([
            { lead: 'scripted/test', helper: 'big/model' }
        ]);

        // Retargeting the ENTRY agent moves the snapshot's top-level model too,
        // because that field is derived from the live entry brain.
        expect(store.setAgentModels(created.id, { lead: 'entry/model' }).model).toBe('entry/model');

        // Nothing was sent to a provider by a patch.
        expect(requests).toEqual([]);
    });

    it('keeps the running request attributed to its model and uses the new one next', async () => {
        const setClock = pinClock(1_000);
        const gate = deferred();
        const entered = deferred();

        const { preset, requests } = modelProbePreset({}, async () => {
            entered.resolve();
            await gate.promise;
        });

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('probe');

        setClock(2_000);

        const items: SessionStreamItem[] = [];
        const running = store.run(created.id, 'first', async (item) => {
            items.push(item);
        });

        // The first request is now inside the transport, so its model is captured
        // and the transport has already named it. A patch from here is mid-flight.
        await entered.promise;
        expect(requests).toEqual(['scripted/test']);

        // A busy session accepts the patch: no 409, no cancellation, and the run
        // keeps streaming (the turn list still has its in-flight turn).
        const patched = store.setAgentModels(created.id, { lead: 'next/model' });
        expect(patched.status).toBe('running');
        expect(patched.turns.map((turn) => turn.status)).toEqual(['running']);
        expect(patched.model).toBe('next/model');
        expect(patched.agentModels).toEqual({ lead: 'next/model', helper: 'scripted/test' });

        gate.resolve();
        await running;

        // The turn records the model the request STARTED with, in both places the
        // event stream names a model: the `start` event and the `done` message.
        const turn = store.get(created.id).turns[0];
        expect(turn.status).toBe('done');
        expect(turn.events).toEqual([
            { type: 'start', agent: 'lead', model: 'scripted/test' },
            { type: 'text', agent: 'lead', delta: 'lead answered' },
            {
                type: 'done',
                agent: 'lead',
                message: {
                    role: 'assistant',
                    content: 'lead answered',
                    reasoning: '',
                    toolCalls: [],
                    model: 'scripted/test',
                    stopReason: 'stop'
                }
            }
        ]);

        // The terminal snapshot frame carries the live map, not the attribution.
        const terminal = items[items.length - 1];
        expect(terminal.type).toBe('snapshot');
        if (terminal.type !== 'snapshot') throw new Error('expected a snapshot frame');
        expect(terminal.session.model).toBe('next/model');
        expect(terminal.session.agentModels).toEqual({ lead: 'next/model', helper: 'scripted/test' });

        // The NEXT request of the same agent targets the new model. INTENTIONAL
        // T4 behaviour change: every server turn is a NEW block, so the harness
        // conversation is reseeded from the agent instructions before execution.
        // The previous block's user message is NOT inherited; its result remains
        // available through the session turn record / # references instead.
        setClock(3_000);
        await store.run(created.id, 'second', async () => {});
        expect(requests).toEqual(['scripted/test', 'next/model']);

        const second = store.get(created.id).turns[1];
        expect(second.events[0]).toEqual({ type: 'start', agent: 'lead', model: 'next/model' });
        expect(store.get(created.id).messages.filter((message) => message.role === 'user')).toEqual([
            { role: 'user', content: 'second' }
        ]);
    });

    it('rejects every invalid patch atomically, leaving the live map untouched', () => {
        pinClock(1_000);
        const { preset } = modelProbePreset({ helper: 'small/fast' });
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('probe');
        const before = { lead: 'scripted/test', helper: 'small/fast' };

        // The valid entry in this map must NOT be applied: validation runs over the
        // whole map before any brain is touched.
        expect(() => store.setAgentModels(created.id, { lead: 'new/model', ghost: 'x' })).toThrow(
            new SessionError(
                400,
                '`agentModels` names "ghost", which is not a member of this harness. Members: lead, helper.'
            )
        );

        expect(() => store.setAgentModels(created.id, { helper: '' })).toThrow(
            new SessionError(400, '`agentModels.helper` cannot be empty.')
        );
        expect(() => store.setAgentModels(created.id, { helper: '   ' })).toThrow(
            new SessionError(400, '`agentModels.helper` cannot be empty.')
        );
        expect(() => store.setAgentModels(created.id, { helper: 7 })).toThrow(
            new SessionError(400, '`agentModels.helper` must be a model id string.')
        );
        expect(() => store.setAgentModels(created.id, { helper: 'x'.repeat(201) })).toThrow(
            new SessionError(400, '`agentModels.helper` cannot exceed 200 characters.')
        );
        expect(() => store.setAgentModels(created.id, ['lead'])).toThrow(
            new SessionError(400, '`agentModels` must be an object mapping agent ids to model ids.')
        );
        expect(() => store.setAgentModels(created.id, null)).toThrow(
            new SessionError(400, '`agentModels` must be an object mapping agent ids to model ids.')
        );
        // An empty map would change nothing, so it is not a silent success.
        expect(() => store.setAgentModels(created.id, {})).toThrow(
            new SessionError(400, 'A patch must change at least one agent model.')
        );
        expect(() => store.setAgentModels('nope', { lead: 'x' })).toThrow(
            new SessionError(404, 'Unknown session "nope".')
        );

        // Every rejection above left the session exactly as it was.
        const after = store.get(created.id);
        expect(after.agentModels).toEqual(before);
        expect(after.model).toBe('scripted/test');
        expect(after.harnessDefinition?.agentModels).toEqual({ helper: 'small/fast' });
    });
});

// Manual tool execution through a session (R8).
//
// The server's POST /tools/:name calls this path when a client supplies a
// sessionId. What matters here: the call runs the SESSION's harness (so state
// really changes), it does not need the model's discovery gate, it cannot race a
// running turn, and a missing capability is a lookup error rather than an invented
// implementation.
describe('SessionStore manual tool calls', () => {
    // A harness with one searchable tool, so discovery and direct execution both
    // have something to act on.
    const toolPreset = (): HarnessPreset =>
        presetOf('toolbox', (settings, progress) =>
            harness({
                agents: {
                    toolbox: agent({
                        model: settings.model,
                        instruction: 'Tool holder.',
                        stream: answerStream('ok')
                    })
                },
                tools: {
                    digest: tool({
                        description: 'Summarise text.',
                        tags: ['text', 'summary'],
                        execute: () => 'digested'
                    })
                },
                primary: 'toolbox',
                presets: false,
                report: { progress }
            })
        );

    it('runs a core tool in that session and isolates its state', async () => {
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const mine = store.create('single');
        const other = store.create('single');

        expect(await store.callTool(mine.id, 'todoManage', { action: 'add', text: '  only mine ' })).toEqual({
            todo: { id: '1', text: 'only mine', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });

        // The state lives in the session's harness: the same session sees the item,
        // a sibling session does not.
        expect(await store.callTool(mine.id, 'todoManage', { action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'only mine', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
        expect(await store.callTool(other.id, 'todoManage', { action: 'list' })).toEqual({
            todos: [],
            counts: { total: 0, completed: 0, remaining: 0 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
    });

    it('runs a searchable tool without the model discovery gate, then records discovery', async () => {
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([toolPreset()]));
        const session = store.create('toolbox');

        // Discovery gates the MODEL. An explicit operator call may run any
        // registered tool even before toolRequest enabled it.
        expect(store.get(session.id).discoveredTools).toEqual([]);
        expect(await store.callTool(session.id, 'digest', 'anything')).toBe('digested');

        // toolRequest through the same path enables it for the model, and the
        // snapshot reports the change (the session really was mutated).
        expect(await store.callTool(session.id, 'toolRequest', { tags: ['text'] })).toEqual({
            enabled: ['digest'],
            tools: [{ name: 'digest', description: 'Summarise text.', tags: ['text', 'summary'] }],
            remaining: 0
        });
        expect(store.get(session.id).discoveredTools).toEqual(['digest']);
    });

    it('maps unknown sessions and unavailable tools to 404 and keeps tool errors intact', async () => {
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([singlePreset()]));
        const session = store.create('single');

        await expect(store.callTool('missing', 'todoManage', { action: 'list' })).rejects.toMatchObject({
            status: 404,
            message: 'Unknown session "missing".'
        });

        // singlePreset has no subagents, so its harness registers no delegate.
        await expect(store.callTool(session.id, 'agentDelegate', { agent: 'x', input: 'go' })).rejects.toMatchObject({
            status: 404,
            message: 'Tool "agentDelegate" is not available in this session.'
        });

        // A tool that throws keeps its own message: the API layer reports it as
        // ok:false, exactly like a throwing catalogue tool.
        await expect(store.callTool(session.id, 'todoManage', { action: 'add' })).rejects.toThrow(
            'todoManage "add" requires a non-empty "text" string.'
        );
    });

    // A manual tool call is not a turn, so `status` stays idle while it runs.
    // The store's private `busy` flag is the single-flight gate (F5): it must
    // reject chat, reset, and another manual call, and it must always release.
    const slowPreset = (gate: { promise: Promise<void> }, fail = false): HarnessPreset =>
        presetOf('slow', (settings, progress) =>
            harness({
                agents: {
                    slow: agent({
                        model: settings.model,
                        instruction: 'Hold the session.',
                        stream: answerStream('chat answer')
                    })
                },
                tools: {
                    slowTool: tool({
                        description: 'Wait for the gate.',
                        tags: ['slow'],
                        execute: async () => {
                            await gate.promise;
                            if (fail) throw new Error('slow tool failed');
                            return 'slow result';
                        }
                    })
                },
                primary: 'slow',
                presets: false,
                report: { progress }
            })
        );

    it('rejects chat, reset, and a second manual call while a manual call is pending', async () => {
        const gate = deferred();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([slowPreset(gate)]));
        const session = store.create('slow');

        const pending = store.callTool(session.id, 'slowTool', {});

        // The UI state is deliberately untouched: no turn, no running status, so
        // a reload cannot show a phantom turn or a stuck spinner.
        expect(store.get(session.id)).toMatchObject({ status: 'idle', turns: [] });

        await expect(store.run(session.id, 'chat', async () => {})).rejects.toMatchObject({
            status: 409,
            message: 'A task is already running in this session.'
        });

        // reset is synchronous, so both the type and the status matter.
        expect(() => store.reset(session.id)).toThrow(SessionError);
        expect(() => store.reset(session.id)).toThrow(
            'Cancel the running task before resetting the session.'
        );

        await expect(store.callTool(session.id, 'slowTool', {})).rejects.toMatchObject({
            status: 409,
            message: 'A task is running in this session; try again when it finishes.'
        });

        // Cancelling a manual call is not supported (no turn/controller); it does
        // not silently release the gate either.
        expect(store.cancel(session.id)).toBe(false);

        gate.resolve();
        expect(await pending).toBe('slow result');

        // Every operation resumes after the successful manual call.
        expect(await store.callTool(session.id, 'slowTool', {})).toBe('slow result');
        await store.run(session.id, 'chat now', async () => {});
        expect(store.get(session.id).turns.map((turn) => turn.prompt)).toEqual(['chat now']);
    });

    it('releases the gate after a manual call fails', async () => {
        const gate = deferred();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([slowPreset(gate, true)]));
        const session = store.create('slow');

        const pending = store.callTool(session.id, 'slowTool', {});
        // Attach the rejection handler before the deliberate delay below, so the
        // held promise is never reported as an unhandled rejection.
        const settled = pending.catch((error: unknown) => error);

        await expect(store.callTool(session.id, 'todoManage', { action: 'list' })).rejects.toMatchObject({
            status: 409
        });

        gate.resolve();
        expect(String(await settled)).toBe('Error: slow tool failed');

        // The failure path must release exactly like the success path: a chat and
        // a fresh manual call both work afterwards, and status was never error.
        await store.run(session.id, 'after failure', async () => {});
        expect(store.get(session.id).status).toBe('idle');
        await expect(store.callTool(session.id, 'slowTool', {})).rejects.toThrow('slow tool failed');
    });

    it('rejects a manual call while a task is running', async () => {
        const gate = deferred();

        const gated = presetOf('gated', (settings, progress) =>
            harness({
                agents: {
                    gated: agent({
                        model: settings.model,
                        instruction: 'Wait for the gate.',
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            await gate.promise;
                            yield { type: 'text', delta: 'released' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'gated',
                presets: false,
                report: { progress }
            })
        );

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([gated]));
        const session = store.create('gated');

        const started = deferred();
        const running = store.run(session.id, 'first', async (item) => {
            if (item.type === 'event' && item.event.type === 'start') started.resolve();
        });
        await started.promise;

        // A manual mutation cannot interleave with a live turn: the running
        // transcript depends on the state it would change.
        await expect(store.callTool(session.id, 'todoManage', { action: 'list' })).rejects.toMatchObject({
            status: 409,
            message: 'A task is running in this session; try again when it finishes.'
        });

        gate.resolve();
        await running;

        // Once the turn is done, the same call works.
        expect(await store.callTool(session.id, 'todoManage', { action: 'list' })).toEqual({
            todos: [],
            counts: { total: 0, completed: 0, remaining: 0 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
    });
});


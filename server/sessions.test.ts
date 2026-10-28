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
import { agent, harness } from '../src/harness';
import type { HarnessStream, HarnessStreamEvent } from '../src/harness';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
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
    agents,
    tools: [],
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

// Primary + subagent. The primary asks for `delegate` on its first request and,
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

                            if (last !== undefined && last.role === 'tool' && last.name === 'delegate') {
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
                                        name: 'delegate',
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
        const store = new SessionStore(DEFAULTS, [singlePreset()]);
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
            events: []
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
                events
            }
        ]);

        // 4. Reload path: get() and list() return the same authoritative record.
        expect(store.get(created.id)).toEqual(terminal.session);
        expect(store.list()).toEqual([terminal.session]);

        // 5. Provider settings (including the key) never enter a snapshot.
        expect(JSON.stringify(terminal.session)).not.toContain('super-secret-key');
    });

    it('records subagent events in the primary turn', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, [teamPreset()]);
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
                    name: 'delegate',
                    arguments: '{"agent":"helper","input":"find it"}'
                }
            },
            { type: 'start', agent: 'helper', model: 'scripted/test' },
            { type: 'text', agent: 'helper', delta: 'helper answer' },
            {
                type: 'done',
                agent: 'helper',
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
                name: 'delegate',
                content: '{"agent":"helper","content":"helper answer"}',
                isError: false
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
        expect(store.get(created.id).turns).toEqual(terminal.session.turns);
    });

    it('keeps sequential turns in order and leaves earlier turns untouched', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, [singlePreset()]);
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

        const store = new SessionStore(DEFAULTS, [gatedPreset]);
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

        const store = new SessionStore(DEFAULTS, [hangingPreset]);
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
                    { type: 'error', agent: 'hanging', error: { message: 'The run was aborted.' } }
                ]
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

        const store = new SessionStore(DEFAULTS, [brokenPreset]);
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
                ]
            }
        ]);

        // A failed turn is retained for the next reload.
        expect(store.get(created.id)).toEqual(terminal.session);
    });

    it('clears turns on reset and isolates sessions from each other', async () => {
        const setClock = pinClock(1_000);
        const store = new SessionStore(DEFAULTS, [singlePreset()]);
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
        const store = new SessionStore(DEFAULTS, [singlePreset()]);
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
        expect(stored.turns[0].events.map((event) => event.type)).toEqual(['start', 'text', 'done']);

        // Mutating a snapshot must not change a later read.
        const external = store.get(created.id);
        external.turns[0].prompt = 'mutated';
        external.turns[0].events.length = 0;
        external.turns.pop();
        external.messages.length = 0;

        expect(store.get(created.id)).toEqual({
            id: created.id,
            harness: 'single',
            status: 'idle',
            model: 'scripted/test',
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
                    ]
                }
            ]
        });
    });

    it('reports unknown harnesses and sessions with the existing statuses', () => {
        const store = new SessionStore(DEFAULTS, [singlePreset()]);

        expect(() => store.create('missing')).toThrow('Unknown harness "missing".');
        expect(() => store.create('missing')).toThrow(SessionError);
        expect(() => store.get('missing')).toThrow('Unknown session "missing".');
    });
});

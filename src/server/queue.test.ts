// Server-owned task queue (R4) — store AND HTTP contract.
//
// Everything runs offline against scripted presets: no provider, no network. The
// clock is pinned (Date.now spy), so every recorded timestamp is asserted as an
// exact number; the only generated values are turn ids (randomUUID), asserted by
// shape and by identity against the frames that carry them.
//
// Coverage map (acceptance evidence for R4):
//   - gated A then enqueue B → B queued, FIFO prompts/events/ids, drain;
//   - no overlapping harness execution (peak concurrency 1, shared single flight);
//   - a failing task records its error and the queue continues;
//   - disconnect on the watch stream does not cancel a task (real service adapter);
//   - cancel { all: true } drops pending safely and retains cancelled records;
//   - live model PATCH applies to the NEXT queued request;
//   - reset/manual/legacy guards while work is queued;
//   - POST /tasks 202 + GET /events frame contract, legacy routes unchanged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '../harness';
import type { HarnessMessage, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import type { HarnessRuntime } from './runtime';
import { createHarnessRuntime } from './runtime';
import { createHarnessServiceHandler } from './service';
import { SessionError, SessionStore } from './sessions';
import type { SessionStreamItem } from './protocol';

const DEFAULTS = {
    baseURL: 'http://scripted.invalid/v1',
    model: 'scripted/test',
    hasApiKey: true
};

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const presetOf = (
    name: string,
    create: HarnessPreset['create']
): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: name,
    subagents: [],
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create
});

// Pin the server clock; every set() changes what Date.now() returns until the
// afterEach restore. Pinned timestamps make startedAt/eventTimes exact.
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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];
    return last === undefined ? '' : String(last.content);
};

// A preset whose stream waits on a PER-PROMPT gate and aborts with request.signal.
//
// The fixture also records the overlap peak, so a test can prove the pump never
// runs two tasks at once, and exposes a per-prompt "started" signal so a test can
// deterministically observe a task as running before it enqueues the next one.
type GatedFixture = {
    preset: HarnessPreset;
    log: string[];
    peak: () => number;
    started: (prompt: string) => { promise: Promise<void>; resolve: () => void };
    gate: (prompt: string) => { promise: Promise<void>; resolve: () => void };
};

const gatedFixture = (): GatedFixture => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts = new Map<string, ReturnType<typeof deferred>>();
    const log: string[] = [];
    let active = 0;
    let highest = 0;

    const gate = (prompt: string) => {
        const existing = gates.get(prompt);
        if (existing !== undefined) return existing;

        const created = deferred();
        gates.set(prompt, created);
        return created;
    };

    const started = (prompt: string) => {
        const existing = starts.get(prompt);
        if (existing !== undefined) return existing;

        const created = deferred();
        starts.set(prompt, created);
        return created;
    };

    const preset = presetOf('gated', (settings, progress) =>
        harness({
            agents: {
                gated: agent({
                    model: settings.model,
                    instruction: 'Wait for a per-prompt gate.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const prompt = lastUser(request.messages);

                        active += 1;
                        highest = Math.max(highest, active);
                        log.push(`start:${prompt}`);
                        started(prompt).resolve();

                        try {
                            // Abort-aware wait: a cancel must settle the turn even
                            // though the gate itself is never released.
                            await new Promise<void>((resolve, reject) => {
                                if (request.signal?.aborted === true) {
                                    reject(new Error('The run was aborted.'));
                                    return;
                                }

                                request.signal?.addEventListener(
                                    'abort',
                                    () => reject(new Error('The run was aborted.')),
                                    { once: true }
                                );
                                gate(prompt).promise.then(resolve, reject);
                            });

                            yield { type: 'text', delta: `answer:${prompt}` };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        } finally {
                            log.push(`end:${prompt}`);
                            active -= 1;
                        }
                    }
                })
            },
            primary: 'gated',
            presets: false,
            report: { progress }
        })
    );

    return { preset, log, peak: () => highest, started, gate };
};

// A preset whose stream fails for prompt 'boom' and answers every other prompt,
// so one queued task can error while the rest continue.
const failingFixture = (): HarnessPreset =>
    presetOf('flaky', (settings, progress) =>
        harness({
            agents: {
                flaky: agent({
                    model: settings.model,
                    instruction: 'Fail on demand.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const prompt = lastUser(request.messages);

                        if (prompt === 'boom') {
                            yield { type: 'error', message: 'provider exploded' };
                            return;
                        }

                        yield { type: 'text', delta: `ok:${prompt}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'flaky',
            presets: false,
            report: { progress }
        })
    );

// A preset with one manual tool, used to prove a queued backlog rejects manual
// mutations (the pump owns the harness, so a manual call cannot interleave).
const toolFixture = (): HarnessPreset =>
    presetOf('toolbox', (settings, progress) =>
        harness({
            agents: {
                toolbox: agent({
                    model: settings.model,
                    instruction: 'Tool holder.',
                    stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                        yield { type: 'text', delta: 'ok' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            tools: {
                digest: tool({
                    description: 'Summarise text.',
                    tags: ['text'],
                    execute: () => 'digested'
                })
            },
            primary: 'toolbox',
            presets: false,
            report: { progress }
        })
    );

const createStore = (presets: HarnessPreset[] = []): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry(presets));

// The sequence a frame asserts, in order: turn rows by status+prompt, events by
// type+turnId, and plain snapshot/failed frames.
const frameKey = (item: SessionStreamItem): string => {
    if (item.type === 'turn') return `turn:${item.turn.status}:${item.turn.prompt}`;
    if (item.type === 'event') return `event:${item.event.type}:${item.turnId}`;
    return item.type;
};

const harnessCall = (result: Awaited<ReturnType<HarnessRuntime['api']>>) => {
    if (result.kind !== 'stream') throw new Error('expected a stream');
    return result;
};

const callApi = (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {}
) =>
    runtime.api({
        method,
        pathname,
        mount: '/v1/harness',
        readBody: async <T>() => body as T,
        bootstrapRoot: true
    });

const createSession = async (runtime: HarnessRuntime, harnessName: string): Promise<string> => {
    const result = await callApi(runtime, 'POST', '/v1/harness/sessions', { harness: harnessName });
    if (result.kind !== 'json' || result.status !== 201) throw new Error('expected a created session');

    return (result.body as { session: { id: string } }).session.id;
};

// Poll a condition without depending on a particular number of microtasks (the
// queue pump and the serialized watch writer settle across ticks). Macrotask turns
// keep this from starving the work it waits on.
const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

describe('SessionStore task queue', () => {
    it('queues behind the active turn, drains FIFO, and never runs two tasks at once', async () => {
        const setClock = pinClock(1_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        setClock(2_000);

        // Watch from the submit on, so the frame sequence is the real contract.
        const frames: SessionStreamItem[] = [];
        const watched = store.watch(created.id, async (item) => {
            frames.push(item);
        });
        expect(watched.snapshot.turns).toEqual([]);
        expect(watched.snapshot.queueDepth).toBeUndefined();

        const firstStarted = fixture.started('first');
        const secondStarted = fixture.started('second');

        const first = store.enqueue(created.id, '  first  ');

        // 202-shaped acceptance: stable id/index, trimmed prompt, queued, and NO
        // startedAt before execution. The queueDepth snapshot counts this turn.
        expect(first.turn).toEqual({
            id: first.turn.id,
            index: 0,
            prompt: 'first',
            status: 'queued',
            updatedAt: 2_000,
            events: [],
            eventTimes: []
        });
        expect(first.turn.id).toMatch(UUID_PATTERN);
        expect(first.turn).not.toHaveProperty('startedAt');
        expect(first.session.queueDepth).toBe(1);
        expect(first.session.status).toBe('idle');
        expect(first.session.turns.map((turn) => turn.status)).toEqual(['queued']);

        // The pump starts in the same tick; wait until the stream is really parked.
        await firstStarted.promise;

        setClock(3_000);

        // B is accepted WHILE A runs: queued, index 1, nothing else started.
        const second = store.enqueue(created.id, 'second');
        expect(second.turn).toEqual({
            id: second.turn.id,
            index: 1,
            prompt: 'second',
            status: 'queued',
            updatedAt: 3_000,
            events: [],
            eventTimes: []
        });
        expect(second.turn.id).not.toBe(first.turn.id);
        expect(second.session.queueDepth).toBe(1);
        expect(second.session.turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual([
            '0:running',
            '1:queued'
        ]);

        // Still only A has entered the harness.
        expect(fixture.log).toEqual(['start:first']);
        expect(fixture.peak()).toBe(1);
        expect(fixture.started('second').promise).toBe(secondStarted.promise);

        // Let A finish; the pump must then start B, in order.
        setClock(4_000);
        fixture.gate('first').resolve();
        await first.settled;
        await secondStarted.promise;

        expect(fixture.log).toEqual(['start:first', 'end:first', 'start:second']);
        expect(fixture.peak()).toBe(1);

        // B is running now: the queued upsert became a running row.
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual(['done', 'running']);

        setClock(5_000);
        fixture.gate('second').resolve();
        await second.settled;
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.queueDepth).toBeUndefined();
        expect(final.status).toBe('idle');

        // Exact FIFO record: prompts, statuses, start times (stamped at execution,
        // not at enqueue), and each turn's own events.
        expect(final.turns).toEqual([
            {
                id: first.turn.id,
                index: 0,
                prompt: 'first',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 4_000,
                events: [
                    { type: 'start', agent: 'gated', model: 'scripted/test' },
                    { type: 'text', agent: 'gated', delta: 'answer:first' },
                    {
                        type: 'done',
                        agent: 'gated',
                        message: {
                            role: 'assistant',
                            content: 'answer:first',
                            reasoning: '',
                            toolCalls: [],
                            model: 'scripted/test',
                            stopReason: 'stop'
                        }
                    }
                ],
                eventTimes: [2_000, 4_000, 4_000]
            },
            {
                id: second.turn.id,
                index: 1,
                prompt: 'second',
                status: 'done',
                startedAt: 4_000,
                updatedAt: 5_000,
                events: [
                    { type: 'start', agent: 'gated', model: 'scripted/test' },
                    { type: 'text', agent: 'gated', delta: 'answer:second' },
                    {
                        type: 'done',
                        agent: 'gated',
                        message: {
                            role: 'assistant',
                            content: 'answer:second',
                            reasoning: '',
                            toolCalls: [],
                            model: 'scripted/test',
                            stopReason: 'stop'
                        }
                    }
                ],
                eventTimes: [4_000, 5_000, 5_000]
            }
        ]);

        // Frame contract: queued/running/terminal upserts, event frames naming
        // their turn, one drain snapshot at the end.
        expect(frames.map(frameKey)).toEqual([
            'turn:queued:first',
            'turn:running:first',
            `event:start:${first.turn.id}`,
            // B is accepted while A is parked on its gate, so its queued upsert
            // arrives before A produces any further event.
            'turn:queued:second',
            `event:text:${first.turn.id}`,
            `event:done:${first.turn.id}`,
            'turn:done:first',
            'turn:running:second',
            `event:start:${second.turn.id}`,
            `event:text:${second.turn.id}`,
            `event:done:${second.turn.id}`,
            'turn:done:second',
            'snapshot'
        ]);

        // The initial snapshot after registration was still the empty record.
        expect(watched.snapshot.turns).toEqual([]);

        // Every event copy names its own turn id.
        const eventFrames = frames.filter((item) => item.type === 'event');
        expect(eventFrames.map((item) => item.turnId)).toEqual([
            first.turn.id,
            first.turn.id,
            first.turn.id,
            second.turn.id,
            second.turn.id,
            second.turn.id
        ]);
    });

    it('records a failed queued task and keeps draining the rest', async () => {
        pinClock(2_000);
        const store = createStore([failingFixture()]);
        const created = store.create('flaky');

        const boom = store.enqueue(created.id, 'boom');
        const good = store.enqueue(created.id, 'good');
        const tail = store.enqueue(created.id, 'tail');

        await boom.settled;
        await good.settled;
        await tail.settled;
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.turns.map((turn) => `${turn.index}:${turn.status}:${turn.prompt}`)).toEqual([
            '0:error:boom',
            '1:done:good',
            '2:done:tail'
        ]);

        // The failure is the FIRST turn's record, not the last one's, and its
        // events stop at the provider error.
        expect(final.turns[0].events.map((event) => event.type)).toEqual(['start', 'error']);
        expect(final.turns[1].events.map((event) => event.type)).toEqual([
            'start',
            'text',
            'done'
        ]);

        // A later success resets the session-level banner; the failed turn keeps
        // its own terminal status for a reload.
        expect(final.turns[0].events[1]).toEqual({
            type: 'error',
            agent: 'flaky',
            error: { message: 'provider exploded' }
        });
    });

    it('rejects invalid submits and the 101st pending task before mutating anything', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        const started = fixture.started('hold');
        store.enqueue(created.id, 'hold');
        await started.promise;

        // Validation order: unknown id (404), empty (400), over-long (413).
        expect(() => store.enqueue('missing', 'x')).toThrow(SessionError);
        expect(() => store.enqueue('missing', 'x')).toThrow('Unknown session "missing".');
        expect(() => store.enqueue(created.id, '   ')).toThrow('A task cannot be empty.');
        expect(() => store.enqueue(created.id, 'x'.repeat(200_001))).toThrow(
            'A task cannot exceed 200000 characters.'
        );

        const queuedBefore = store.get(created.id).turns.length;

        // Fill the backlog to the cap (100 pending; the active turn is not pending).
        for (let index = 0; index < 100; index += 1) {
            store.enqueue(created.id, `queued-${index}`);
        }

        expect(store.get(created.id).queueDepth).toBe(100);
        expect(store.get(created.id).turns).toHaveLength(queuedBefore + 100);

        // The 101st pending submit is a 429 and adds no turn.
        let rejection: unknown;
        try {
            store.enqueue(created.id, 'overflow');
        } catch (error) {
            rejection = error;
        }
        expect(rejection).toBeInstanceOf(SessionError);
        expect(rejection).toMatchObject({
            status: 429,
            message: 'A session cannot queue more than 100 pending tasks.'
        });
        expect(store.get(created.id).turns).toHaveLength(queuedBefore + 100);

        // Stop everything so the fixture cannot leak a parked run.
        store.cancel(created.id, { all: true });
        fixture.gate('hold').resolve();
        await store.waitForIdle(created.id);
    });

    it('cancel { all: true } aborts the active turn and retains queued turns as cancelled', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        const started = fixture.started('active');
        const active = store.enqueue(created.id, 'active');
        await started.promise;

        const queued = store.enqueue(created.id, 'queued');
        const later = store.enqueue(created.id, 'later');
        expect(store.get(created.id).queueDepth).toBe(2);

        // Active-only cancel (legacy shape) leaves the backlog alone.
        expect(store.cancel(created.id)).toBe(true);
        expect(store.get(created.id).queueDepth).toBe(2);

        // Stop-all drops the two pending turns; they stay as cancelled records.
        expect(store.cancel(created.id, { all: true })).toBe(true);

        await active.settled;
        await queued.settled;
        await later.settled;
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.queueDepth).toBeUndefined();
        expect(final.status).toBe('error');
        expect(final.lastError).toBe('The run was cancelled.');

        expect(final.turns.map((turn) => ({ index: turn.index, status: turn.status }))).toEqual([
            { index: 0, status: 'cancelled' },
            { index: 1, status: 'cancelled' },
            { index: 2, status: 'cancelled' }
        ]);

        // A dropped turn never started: no startedAt, no events, updated at drop.
        expect(final.turns[1].startedAt).toBeUndefined();
        expect(final.turns[1].events).toEqual([]);
        expect(final.turns[1].eventTimes).toEqual([]);
        expect(final.turns[2].startedAt).toBeUndefined();
        expect(final.turns[2].events).toEqual([]);

        // Nothing ran after the stop.
        expect(fixture.log).toEqual(['start:active', 'end:active']);
    });

    it('rejects legacy runs, manual tools, and reset while work is queued', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset, toolFixture()]);
        const created = store.create('gated');

        const started = fixture.started('first');
        store.enqueue(created.id, 'first');
        await started.promise;
        store.enqueue(created.id, 'second');

        await expect(store.run(created.id, 'legacy', async () => {})).rejects.toMatchObject({
            status: 409,
            message: 'A task is already running in this session.'
        });
        expect(() => store.assertRunnable(created.id)).toThrow(
            'A task is already running in this session.'
        );
        await expect(store.callTool(created.id, 'todoManage', { action: 'list' })).rejects.toMatchObject({
            status: 409,
            message: 'A task is running in this session; try again when it finishes.'
        });
        expect(() => store.reset(created.id)).toThrow(SessionError);
        expect(() => store.reset(created.id)).toThrow(
            'Cancel the running task before resetting the session.'
        );

        // Nothing above mutated the queue or the records.
        expect(store.get(created.id).queueDepth).toBe(1);
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual([
            'running',
            'queued'
        ]);

        store.cancel(created.id, { all: true });
        fixture.gate('first').resolve();
        await store.waitForIdle(created.id);
    });

    it('accepts a submit during a legacy run and runs it after that run releases the gate', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        const legacyStarted = fixture.started('legacy');
        const frames: SessionStreamItem[] = [];
        const legacy = store.run(created.id, 'legacy', async (item) => {
            frames.push(item);
        });

        await legacyStarted.promise;

        // Accepted while the legacy run owns the harness: it queues, it does not
        // execute, and it does NOT abort or reshape the legacy stream.
        const queuedStarted = fixture.started('queued');
        const queued = store.enqueue(created.id, 'queued');
        expect(queued.turn.status).toBe('queued');
        expect(fixture.log).toEqual(['start:legacy']);

        fixture.gate('legacy').resolve();
        await legacy;
        await queuedStarted.promise;
        fixture.gate('queued').resolve();
        await queued.settled;
        await store.waitForIdle(created.id);

        // Legacy stream is byte-for-byte the old shape: opening turn, events,
        // terminal snapshot. No queued turn appears in it.
        expect(frames.map((item) => item.type)).toEqual([
            'turn',
            'event',
            'event',
            'event',
            'snapshot'
        ]);
        const legacyTerminal = frames[frames.length - 1];
        if (legacyTerminal?.type !== 'snapshot') throw new Error('expected a snapshot');
        expect(legacyTerminal.session.turns.map((turn) => turn.status)).toEqual([
            'done',
            'queued'
        ]);

        expect(fixture.peak()).toBe(1);
        expect(fixture.log).toEqual(['start:legacy', 'end:legacy', 'start:queued', 'end:queued']);
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual(['done', 'done']);
    });

    it('applies a live model patch to the next queued request, not the running one', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        const firstStarted = fixture.started('first');
        const first = store.enqueue(created.id, 'first');
        await firstStarted.promise;

        // PATCH while the first task runs: allowed, nothing aborted (T2 contract).
        store.setAgentModels(created.id, { gated: 'live/next-model' });

        fixture.gate('first').resolve();
        await first.settled;

        const secondStarted = fixture.started('second');
        const second = store.enqueue(created.id, 'second');
        await secondStarted.promise;
        fixture.gate('second').resolve();
        await second.settled;
        await store.waitForIdle(created.id);

        const turns = store.get(created.id).turns;
        const firstStart = turns[0].events[0];
        const secondStart = turns[1].events[0];
        if (firstStart.type !== 'start' || secondStart.type !== 'start') {
            throw new Error('expected start events');
        }

        // In-flight attribution: the running request kept the model it started
        // with; the next request used the patched one.
        expect(firstStart.model).toBe('scripted/test');
        expect(secondStart.model).toBe('live/next-model');
        expect(store.get(created.id).model).toBe('live/next-model');
        expect(store.get(created.id).harnessDefinition?.agentModels).toBeUndefined();
    });

    it('remove aborts the active turn, drops pending work, and closes watchers silently', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        const frames: SessionStreamItem[] = [];
        let closes = 0;
        store.watch(
            created.id,
            async (item) => {
                frames.push(item);
            },
            () => {
                closes += 1;
            }
        );

        const started = fixture.started('active');
        const active = store.enqueue(created.id, 'active');
        await started.promise;

        const queued = store.enqueue(created.id, 'queued');

        const frameCountAtRemove = frames.length;
        expect(store.remove(created.id)).toBe(true);
        expect(closes).toBe(1);
        expect(() => store.get(created.id)).toThrow('Unknown session');

        // Pending work was discarded, not executed, and its completion resolved.
        await queued.settled;
        await active.settled;

        // The aborted run recorded its terminal state internally, but nothing was
        // published after disposal: a removed session cannot leak frames.
        expect(frames).toHaveLength(frameCountAtRemove);
        expect(fixture.log).toEqual(['start:active', 'end:active']);
        expect(store.size).toBe(0);
    });

    it('waits for the queue to drain and resolves waitForIdle only after the last turn', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('gated');

        // No work: idle is immediate.
        await expect(store.waitForIdle(created.id)).resolves.toBeUndefined();

        const started = fixture.started('one');
        const task = store.enqueue(created.id, 'one');
        await started.promise;

        let idle = false;
        const drained = store.waitForIdle(created.id).then(() => {
            idle = true;
        });

        expect(idle).toBe(false);
        fixture.gate('one').resolve();
        await task.settled;
        await drained;
        expect(idle).toBe(true);
    });
});

describe('queue HTTP contract', () => {
    const runtimeOf = (presets: HarnessPreset[]): HarnessRuntime => {
        const store = new SessionStore(SETTINGS, createHarnessRegistry(presets));

        return createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            store,
            loadEnvironment: false
        });
    };

    it('answers 202 {session, turn}, forwards the watch frames, and keeps /messages legacy', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const accepted = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: '  first  '
        });

        if (accepted.kind !== 'json') throw new Error('expected JSON');
        expect(accepted.status).toBe(202);

        const body = accepted.body as {
            session: { id: string; status: string; queueDepth?: number; turns: unknown[] };
            turn: Record<string, unknown>;
        };
        expect(body.session.id).toBe(id);
        expect(body.session.status).toBe('idle');
        expect(body.session.queueDepth).toBe(1);
        expect(body.turn).toEqual({
            id: body.turn.id,
            index: 0,
            prompt: 'first',
            status: 'queued',
            updatedAt: 2_000,
            events: [],
            eventTimes: []
        });
        expect(String(body.turn.id)).toMatch(UUID_PATTERN);

        // Watch the queue with an in-process emitter so the frame order is exact.
        const stream = harnessCall(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/events`)
        );
        const controller = new AbortController();
        const frames: SessionStreamItem[] = [];
        let opened!: () => void;
        const opening = new Promise<void>((resolve) => {
            opened = resolve;
        });

        const watched = stream.start(async (item) => {
            frames.push(item);
            if (frames.length === 1) opened();
        }, controller.signal);

        await opening;

        // First frame is the complete snapshot, and it already shows the running
        // turn (the pump started on submit) with no pending depth.
        expect(frames[0].type).toBe('snapshot');
        if (frames[0].type !== 'snapshot') throw new Error('expected the snapshot first');
        expect(frames[0].session.turns.map((turn) => turn.status)).toEqual(['running']);

        const second = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: 'second'
        });
        if (second.kind !== 'json') throw new Error('expected JSON');
        expect(second.status).toBe(202);
        expect((second.body as { session: { queueDepth?: number } }).session.queueDepth).toBe(1);

        // Let the watcher stay attached through the whole drain, then disconnect:
        // unsubscribing must not cancel anything (the adapter test covers the real
        // HTTP path; this asserts the frame contract).
        const secondStarted = fixture.started('second');
        fixture.gate('first').resolve();
        await secondStarted.promise;
        fixture.gate('second').resolve();
        await runtime.store.waitForIdle(id);

        controller.abort();
        await watched;

        // The watch frame sequence proves upserts, event attribution, and the
        // drain snapshot. (Queued/running first and its start event predate the
        // watcher, so they are absent.)
        const turnIds = runtime.store.get(id).turns.map((turn) => turn.id);
        expect(frames.map(frameKey)).toEqual([
            'snapshot',
            'turn:queued:second',
            `event:text:${turnIds[0]}`,
            `event:done:${turnIds[0]}`,
            'turn:done:first',
            'turn:running:second',
            `event:start:${turnIds[1]}`,
            `event:text:${turnIds[1]}`,
            `event:done:${turnIds[1]}`,
            'turn:done:second',
            'snapshot'
        ]);

        // Both tasks completed for the server.
        expect(runtime.store.get(id).turns.map((turn) => turn.status)).toEqual(['done', 'done']);

        // A POST /messages on a session with pending work is still a 409 (legacy).
        const third = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: 'third'
        });
        if (third.kind !== 'json') throw new Error('expected JSON');
        const busy = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
            input: 'legacy'
        });
        expect(busy.kind).toBe('json');
        if (busy.kind !== 'json') throw new Error('expected JSON');
        expect(busy.status).toBe(409);
        expect(busy.body).toEqual({
            error: { message: 'A task is already running in this session.' }
        });

        runtime.store.cancel(id, { all: true });
        fixture.gate('third').resolve();
        await runtime.store.waitForIdle(id);
    });

    it('keeps the legacy cancel response and validates the {all} option', async () => {
        pinClock(2_000);
        const runtime = runtimeOf([failingFixture()]);
        const id = await createSession(runtime, 'flaky');

        // Legacy shape: no body → the active run only.
        const legacy = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`);
        expect(legacy.kind).toBe('json');
        if (legacy.kind !== 'json') throw new Error('expected JSON');
        expect(legacy.status).toBe(200);
        expect(legacy.body).toEqual({ cancelled: false });

        // `{ all: true }` is accepted with the same response envelope.
        const all = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {
            all: true
        });
        expect(all.kind).toBe('json');
        if (all.kind !== 'json') throw new Error('expected JSON');
        expect(all.status).toBe(200);
        expect(all.body).toEqual({ cancelled: false });

        // Non-boolean / unknown fields are rejected before anything is cancelled.
        const notBoolean = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {
            all: 'yes'
        });
        expect(notBoolean.kind).toBe('json');
        if (notBoolean.kind !== 'json') throw new Error('expected JSON');
        expect(notBoolean.status).toBe(400);
        expect(notBoolean.body).toEqual({
            error: { message: '`all` must be a boolean when present.' }
        });

        const unknown = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {
            stop: true
        });
        expect(unknown.kind).toBe('json');
        if (unknown.kind !== 'json') throw new Error('expected JSON');
        expect(unknown.status).toBe(400);
        expect(unknown.body).toEqual({
            error: { message: 'Unknown field "stop". Allowed fields: all.' }
        });

        // Unknown session is a 404 for both queue routes.
        const missingTask = await callApi(
            runtime,
            'POST',
            '/v1/harness/sessions/missing/tasks',
            { input: 'x' }
        );
        expect(missingTask).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: 'Unknown session "missing".' } }
        });

        const missingEvents = await callApi(runtime, 'GET', '/v1/harness/sessions/missing/events');
        expect(missingEvents).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: 'Unknown session "missing".' } }
        });
    });

    it('a real service-adapter disconnect does not cancel the queued task', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const accepted = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: 'survivor'
        });
        if (accepted.kind !== 'json') throw new Error('expected JSON');
        expect(accepted.status).toBe(202);

        const handler = createHarnessServiceHandler({ runtime });
        const abort = new AbortController();
        const result = await handler(
            {
                req: {
                    path: `/v1/harness/sessions/${id}/events`,
                    header: () => undefined,
                    raw: { method: 'GET', signal: abort.signal }
                }
            },
            { body: {} }
        );

        // Real Response with the SSE headers (the loader passes it through raw).
        expect(result.raw).toBeInstanceOf(Response);
        const raw = result.raw!;
        expect(raw.status).toBe(200);
        expect(raw.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

        const reader = raw.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Incremental SSE reader: the adapter writes `: connected` first, then one
        // `data: <json>` frame per emit. Comment-only blocks are skipped.
        const readItem = async (): Promise<SessionStreamItem | undefined> => {
            for (;;) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary >= 0) {
                    const block = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);

                    const data = block
                        .split('\n')
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trimStart())
                        .join('\n');

                    if (data.length > 0) return JSON.parse(data) as SessionStreamItem;
                    continue;
                }

                const chunk = await reader.read();
                if (chunk.done) return undefined;
                buffer += decoder.decode(chunk.value);
            }
        };

        // Consume the initial snapshot, then disconnect like a closing tab.
        expect(await readItem()).toEqual({ type: 'snapshot', session: runtime.store.get(id) });

        abort.abort();

        // The stream must end from the adapter's side (watcher unsubscribed), and
        // the queued task must NOT be cancelled by that disconnect.
        expect(await readItem()).toBeUndefined();
        await reader.cancel().catch(() => {});

        // The disconnect must not cancel: the run continues to completion.
        fixture.gate('survivor').resolve();
        await runtime.store.waitForIdle(id);

        const final = runtime.store.get(id);
        expect(final.status).toBe('idle');
        expect(final.turns).toEqual([
            {
                id: final.turns[0].id,
                index: 0,
                prompt: 'survivor',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 2_000,
                events: [
                    { type: 'start', agent: 'gated', model: 'scripted/test' },
                    { type: 'text', agent: 'gated', delta: 'answer:survivor' },
                    {
                        type: 'done',
                        agent: 'gated',
                        message: {
                            role: 'assistant',
                            content: 'answer:survivor',
                            reasoning: '',
                            toolCalls: [],
                            model: 'scripted/test',
                            stopReason: 'stop'
                        }
                    }
                ],
                eventTimes: [2_000, 2_000, 2_000]
            }
        ]);
    });

    it('a late legacy-stream abort cannot cancel the queued task that started next', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const legacyStarted = fixture.started('legacy');
        const stream = harnessCall(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
                input: 'legacy'
            })
        );

        const controller = new AbortController();
        const frames: SessionStreamItem[] = [];

        // Gate the legacy TERMINAL snapshot. While it is pending the legacy run has
        // already released the single-flight gate (executeTurn's finally) but the
        // response is still open — exactly the old race window.
        const terminalGate = deferred();
        const terminalReached = deferred();

        const running = stream.start(async (item) => {
            frames.push(item);

            if (item.type === 'snapshot') {
                terminalReached.resolve();
                await terminalGate.promise;
            }
        }, controller.signal);

        await legacyStarted.promise;

        // Accepted behind the legacy run and parked until it releases the gate.
        const queuedStarted = fixture.started('queued');
        const queued = runtime.store.enqueue(id, 'queued');
        expect(queued.turn.status).toBe('queued');
        expect(fixture.log).toEqual(['start:legacy']);

        // Finish the legacy turn: the pump starts the queued task while the legacy
        // terminal write is still gated.
        fixture.gate('legacy').resolve();
        await terminalReached.promise;
        await queuedStarted.promise;
        expect(fixture.log).toEqual(['start:legacy', 'end:legacy', 'start:queued']);

        // The OLD response disconnects now. Cancellation is tied to the legacy run's
        // own controller, so this must not touch the queued task.
        controller.abort();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(runtime.store.get(id).turns[1].status).toBe('running');
        expect(runtime.store.get(id).status).toBe('running');

        terminalGate.resolve();
        await running;

        // The queued task completes normally: not cancelled, no error banner.
        fixture.gate('queued').resolve();
        await queued.settled;
        await runtime.store.waitForIdle(id);

        const final = runtime.store.get(id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual([
            'legacy:done',
            'queued:done'
        ]);

        // The legacy stream still ended with its own terminal snapshot last.
        expect(frames.map((item) => item.type)).toEqual([
            'turn',
            'event',
            'event',
            'event',
            'snapshot'
        ]);

        const legacyTerminal = frames[4];
        if (legacyTerminal.type !== 'snapshot') throw new Error('expected terminal snapshot');
        expect(legacyTerminal.session.turns[0].status).toBe('done');
    });

    it('a legacy-stream disconnect still cancels its OWN run and leaves the queued task alone', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const legacyStarted = fixture.started('legacy');
        const stream = harnessCall(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
                input: 'legacy'
            })
        );

        const controller = new AbortController();
        const frames: SessionStreamItem[] = [];
        const running = stream.start(async (item) => {
            frames.push(item);
        }, controller.signal);

        await legacyStarted.promise;

        // Accepted behind the legacy run; it must not be what the disconnect hits.
        const queuedStarted = fixture.started('queued');
        const queued = runtime.store.enqueue(id, 'queued');

        // Disconnect while the legacy run is still streaming.
        controller.abort();
        await running;

        await queuedStarted.promise;
        fixture.gate('queued').resolve();
        await queued.settled;
        await runtime.store.waitForIdle(id);

        const final = runtime.store.get(id);
        expect(final.status).toBe('idle');
        expect(final.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual([
            'legacy:cancelled',
            'queued:done'
        ]);

        // The legacy response ended as the old contract: a terminal failed frame
        // naming this run's cancellation.
        const terminal = frames[frames.length - 1];
        if (terminal.type !== 'failed') throw new Error('expected a failed frame');
        expect(terminal.error).toEqual({ message: 'The run was cancelled.' });
    });

    it('serializes watch writes so async backpressure cannot reorder frames', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const stream = harnessCall(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/events`)
        );

        // Gated emitter: every write stays pending until this test resolves it, so
        // overlapping writes (the old bug) can be completed in REVERSE order.
        const pendingWrites: { item: SessionStreamItem; resolve: () => void }[] = [];
        let wake: (() => void) | undefined;
        const notify = (): void => {
            const next = wake;
            wake = undefined;
            next?.();
        };

        const emit = (item: SessionStreamItem): Promise<void> =>
            new Promise<void>((resolve) => {
                pendingWrites.push({ item, resolve });
                notify();
            });

        const waitForWrite = (): Promise<void> =>
            new Promise<void>((resolve) => {
                if (pendingWrites.length > 0) {
                    resolve();
                    return;
                }

                wake = resolve;
            });

        const recorded: SessionStreamItem[] = [];
        let stop = false;

        // Complete the NEWEST pending write first. A non-serialized route keeps
        // several writes in flight, so this reverses their frame order.
        const driver = (async (): Promise<void> => {
            while (!stop || pendingWrites.length > 0) {
                await waitForWrite();

                const next = pendingWrites.pop();
                if (next === undefined) continue;

                recorded.push(next.item);
                next.resolve();

                // Let the route schedule its next chained write.
                await Promise.resolve();
            }
        })();

        const controller = new AbortController();
        const running = stream.start(emit, controller.signal);

        // Snapshot is the first frame a client sees.
        await waitUntil(() => recorded.length >= 1);
        expect(recorded[0].type).toBe('snapshot');

        const taskStarted = fixture.started('task');
        const task = runtime.store.enqueue(id, 'task');

        // The task parks on its gate until this test releases it; the queue drain
        // only happens after that, so release before waiting for idle.
        await taskStarted.promise;
        fixture.gate('task').resolve();

        // Let the run and the drain snapshot be published, then end the stream.
        await runtime.store.waitForIdle(id);
        await waitUntil(() => recorded.length >= 8);

        controller.abort();
        await running;

        stop = true;
        notify();
        await driver;

        const taskId = runtime.store.get(id).turns[0].id;
        expect(recorded.map(frameKey)).toEqual([
            'snapshot',
            'turn:queued:task',
            'turn:running:task',
            `event:start:${taskId}`,
            `event:text:${taskId}`,
            `event:done:${taskId}`,
            'turn:done:task',
            'snapshot'
        ]);

        // The pump was never touched by the gated writer.
        fixture.gate('task').resolve();
        await task.settled;
        expect(runtime.store.get(id).turns[0].status).toBe('done');
    });
});

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
//   - POST /tasks 202 + receipt, and the same frame contract at the seam the realtime plane
//     is fed from.
//
// T35 MIGRATION NOTE: the transport changed, the queue domain did not. `POST /tasks` answers
// a 202 `TaskReceipt` (never `{session, turn}`), the backlog is the named
// `GET .../queue` page, and `GET .../events` / `POST .../messages` are retired — a plain
// `GET /v1/harness/stream` answers the upgrade it expected (400), and the service adapter
// words that refusal itself (./service.ts). The observer-side assertions therefore run
// against `store.watch` (the seam the WebSocket plane is bridged from, ./stream/mount.ts),
// which is an accepted internal oracle, not a backward-compatibility fixture. Three findings
// are asserted as-observed and reported rather than smoothed over: `TaskReceipt.queue_position`
// / `GET .../queue` / `session.queueDepth` do not see a per-conversation (lane) backlog; a
// cancel with `all` absent no longer type-checks the flag and cancels the backlog entry while
// publishing `dropped_queued_tasks: 0`; and a writer-backpressure guarantee that lived on the
// SSE route now belongs to the stream plane.
//
// T39 UPDATE (./api-regressions.test.ts owns the repaired behaviour, asserted through REST): the
// per-conversation backlog IS projected — `queueRowsOf`/`pendingCountOf` (./api-reads.ts:166-173 and
// :655-683) fold every lane queue into one global FIFO ordering, and `TaskReceipt.queue_position` is
// that ordering's 1-based ordinal (contract `minimum: 1`, ./harness.swagger.yaml:5001-5005). A cancel
// whose `all` is not a boolean answers 400 again, before anything is cancelled. One finding below is
// still store behaviour and stays asserted as-observed: a session-level cancel stops EVERY active
// conversation run while its receipt names a single `active_turn_id`.

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
// T35: canonical transport. One mount, a 202 receipt for a submit, a named queue page, and
// NO per-session SSE route — realtime is a WebSocket upgrade the stream plane owns.
import { HARNESS_ROUTES } from '../shared/harness-api';
import {
    bindApiCall,
    readOk,
    readTurn,
    submitTask,
    type CanonicalCall
} from './canonical-reads.test-support';

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
                            // R1: one attempt — the queue's failed-task path is what is
                            // pinned here, not the retry backoff.
                            yield { type: 'error', message: 'provider exploded' };
                            return;
                        }

                        yield { type: 'text', delta: `ok:${prompt}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    },
                    retry: false
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

// One `CanonicalCall` over the runtime's single mount. The old file read the accept-time
// aggregate off the 202 body; the canonical submit answers a receipt, so the figures that
// aggregate carried (queue depth, the turn row, the conversation) are read from the routes
// that own them — composed by ./canonical-reads.test-support.ts.
const callOf = (runtime: HarnessRuntime): CanonicalCall => bindApiCall(runtime.api, '/v1/harness');

/** One row of `GET /v1/harness/sessions/{id}/queue` (the members this file asserts). */
type QueueRow = {
    turn_id: string;
    index: number;
    position: number;
    status: string;
    prompt_preview: string;
    prompt_chars: number;
    thread_id?: string;
    thread_label?: string;
};

type QueuePage = { items: QueueRow[]; limit: number; next_cursor: string | null };

const readQueue = (call: CanonicalCall, id: string): Promise<QueuePage> =>
    readOk<QueuePage>(call, 'GET', HARNESS_ROUTES.sessionsBySessionIdQueue(id), 200);

// The canonical cancel receipt (`CancelSessionResult`, ../shared/harness-api.ts). `revision`
// is compared to the hub that owns it, exactly as ./api-canonical.test.ts does.
const cancelResult = (runtime: HarnessRuntime, id: string, cancelled: boolean, dropped: number) => ({
    cancelled,
    session_id: id,
    dropped_queued_tasks: dropped,
    revision: runtime.api.events.getRevision('session', id)
});

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
    it('starts independent thread submits concurrently instead of serializing them', async () => {
        const setClock = pinClock(1_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('gated');

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

        const first = await store.enqueue(created.id, '  first  ');

        // 202-shaped acceptance: stable id/index, trimmed prompt, queued, and NO
        // startedAt before execution. The queueDepth snapshot counts this turn.
        // R1-R6: an unfocused submit opens its own host thread; the turn names it.
        expect(first.turn).toEqual({
            id: first.turn.id,
            index: 0,
            prompt: 'first',
            threadId: 'thread-1',
            threadLabel: 'GD1',
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
        const second = await store.enqueue(created.id, 'second');
        expect(second.turn).toEqual({
            id: second.turn.id,
            index: 1,
            prompt: 'second',
            threadId: 'thread-2',
            threadLabel: 'GD2',
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

        // F1/RUNTIME READINESS: BOTH plain submits are in flight before either is
        // released — the independent thread lanes overlap (peak 2), while each
        // lane's own backlog would stay FIFO.
        await secondStarted.promise;
        expect(fixture.log).toEqual(['start:first', 'start:second']);
        expect(fixture.peak()).toBe(2);
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual([
            'running',
            'running'
        ]);

        // Release A first; B keeps running independently.
        setClock(4_000);
        fixture.gate('first').resolve();
        await first.settled;

        expect(fixture.log).toEqual(['start:first', 'start:second', 'end:first']);
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
                threadId: 'thread-1',
                threadLabel: 'GD1',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 4_000,
                // R1-R6/T3: a root HOST-thread run carries its invocation identity
                // on every frame (`input` on start only); the first run of a fresh
                // harness is invocation '1'.
                events: [
                    {
                        type: 'start',
                        agent: 'gated',
                        model: 'scripted/test',
                        thread: { id: '1', input: 'first' }
                    },
                    { type: 'text', agent: 'gated', delta: 'answer:first', thread: { id: '1' } },
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
                        },
                        thread: { id: '1' }
                    }
                ],
                eventTimes: [2_000, 4_000, 4_000]
            },
            {
                id: second.turn.id,
                index: 1,
                prompt: 'second',
                threadId: 'thread-2',
                threadLabel: 'GD2',
                status: 'done',
                startedAt: 3_000,
                updatedAt: 5_000,
                // The second submit opened its own thread; its run is invocation '2'.
                events: [
                    {
                        type: 'start',
                        agent: 'gated',
                        model: 'scripted/test',
                        thread: { id: '2', input: 'second' }
                    },
                    { type: 'text', agent: 'gated', delta: 'answer:second', thread: { id: '2' } },
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
                        },
                        thread: { id: '2' }
                    }
                ],
                eventTimes: [3_000, 5_000, 5_000]
            }
        ]);

        // Frame contract: queued/running/terminal upserts and event frames naming
        // their own turn, interleaved by CONCURRENCY; one drain snapshot at the end.
        expect(frames.map(frameKey)).toEqual([
            'turn:queued:first',
            'turn:running:first',
            `event:start:${first.turn.id}`,
            // B is accepted while A is parked on its gate; B starts at once.
            'turn:queued:second',
            'turn:running:second',
            `event:start:${second.turn.id}`,
            `event:text:${first.turn.id}`,
            `event:done:${first.turn.id}`,
            'turn:done:first',
            `event:text:${second.turn.id}`,
            `event:done:${second.turn.id}`,
            'turn:done:second',
            'snapshot'
        ]);

        // The initial snapshot after registration was still the empty record.
        expect(watched.snapshot.turns).toEqual([]);

        // Every event copy names its own turn id.
        const eventFrames = frames.filter((item) => item.type === 'event');
        // Each event names its OWN turn. The lanes overlap at START (F1); the two
        // releases are ordered by the test, so each lane's own event subsequence is
        // exact and deterministic.
        expect(eventFrames.map((item) => item.turnId)).toEqual([
            first.turn.id,
            second.turn.id,
            first.turn.id,
            first.turn.id,
            second.turn.id,
            second.turn.id
        ]);
        expect(eventFrames.filter((item) => item.turnId === first.turn.id).map((item) => item.event.type)).toEqual([
            'start',
            'text',
            'done'
        ]);
        expect(eventFrames.filter((item) => item.turnId === second.turn.id).map((item) => item.event.type)).toEqual([
            'start',
            'text',
            'done'
        ]);
    });

    it('records a failed task and keeps draining the rest of its thread', async () => {
        pinClock(2_000);
        const store = createStore([failingFixture()]);
        const created = await store.create('flaky');

        // Same-thread FIFO: the failure must not stop the queued continuations, and
        // the serialized order keeps the banner rule deterministic.
        const boom = await store.enqueue(created.id, 'boom');
        expect(boom.turn.threadId).toBe('thread-1');
        await boom.settled;

        const good = await store.enqueue(created.id, 'good', undefined, undefined, 'thread-1');
        await good.settled;

        const tail = await store.enqueue(created.id, 'tail', undefined, undefined, 'thread-1');
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
            error: { message: 'provider exploded' },
            // Host-thread root frames carry their invocation identity.
            thread: { id: '1' }
        });
    });

    it('rejects invalid submits and the 101st pending task before mutating anything', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('gated');

        // Park the exclusive gate with a legacy run: every thread lane's pump waits,
        // so accepted lane work genuinely stays PENDING (F1 keeps separate lanes, so
        // independent prompts would otherwise run at once).
        fixture.gate('legacy');
        void store.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;

        // Validation order: unknown id (404), empty (400), over-long (413).
        await expect(store.enqueue('missing', 'x')).rejects.toThrow(SessionError);
        await expect(store.enqueue('missing', 'x')).rejects.toThrow('Unknown session "missing".');
        await expect(store.enqueue(created.id, '   ')).rejects.toThrow('A task cannot be empty.');
        await expect(store.enqueue(created.id, 'x'.repeat(200_001))).rejects.toThrow(
            'A task cannot exceed 200000 characters.'
        );

        const queuedBefore = store.get(created.id).turns.length;

        // Fill the backlog to the cap (100 pending; the active turn is not pending).
        for (let index = 0; index < 100; index += 1) {
            await store.enqueue(created.id, `queued-${index}`);
        }

        expect(store.get(created.id).queueDepth).toBe(100);
        expect(store.get(created.id).turns).toHaveLength(queuedBefore + 100);

        // The 101st pending submit is a 429 and adds no turn.
        let rejection: unknown;
        try {
            await store.enqueue(created.id, 'overflow');
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
        await store.cancel(created.id, { all: true });
        fixture.gate('legacy').resolve();
        await store.waitForIdle(created.id);
    });

    it('cancel { all: true } aborts the active turn and retains queued turns as cancelled', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('gated');

        // A legacy run parks every lane pump, so the two later submits are genuinely
        // PENDING (F1: independent lanes would otherwise start them at once).
        fixture.gate('legacy');
        const legacy = store.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;

        const queued = await store.enqueue(created.id, 'queued');
        const later = await store.enqueue(created.id, 'later');
        expect(store.get(created.id).queueDepth).toBe(2);

        // Active-only cancel (legacy shape) leaves the backlog alone.
        expect(await store.cancel(created.id)).toBe(true);
        expect(store.get(created.id).queueDepth).toBe(2);

        // Stop-all drops the two pending turns; they stay as cancelled records.
        expect(await store.cancel(created.id, { all: true })).toBe(true);

        fixture.gate('legacy').resolve();
        await legacy;
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
        expect(fixture.log).toEqual(['start:legacy', 'end:legacy']);
    });

    it('rejects legacy runs, manual tools, and reset while work is queued', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset, toolFixture()]);
        const created = await store.create('gated');

        // Two independent lanes, both live (F1): the exclusive paths must refuse.
        fixture.gate('first');
        fixture.gate('second');
        await store.enqueue(created.id, 'first');
        await fixture.started('first').promise;
        await store.enqueue(created.id, 'second');
        await fixture.started('second').promise;

        await expect(store.run(created.id, 'legacy', async () => {})).rejects.toMatchObject({
            status: 409,
            message: 'A task is already running in this session.'
        });
        expect(() => store.assertRunnable(created.id)).toThrow(
            'A task is already running in this session.'
        );
        await expect(store.callTool(created.id, 'task', {})).rejects.toMatchObject({
            status: 409,
            message: 'A task is running in this session; try again when it finishes.'
        });
        await expect(store.reset(created.id)).rejects.toThrow(SessionError);
        await expect(store.reset(created.id)).rejects.toThrow(
            'Cancel the running task before resetting the session.'
        );

        // Nothing above mutated the lanes or the records: both are still running.
        expect(store.get(created.id).queueDepth).toBeUndefined();
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual([
            'running',
            'running'
        ]);

        await store.cancel(created.id, { all: true });
        fixture.gate('first').resolve();
        fixture.gate('second').resolve();
        await store.waitForIdle(created.id);
    });

    it('accepts a submit during a legacy run and runs it after that run releases the gate', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('gated');

        const legacyStarted = fixture.started('legacy');
        const frames: SessionStreamItem[] = [];
        const legacy = store.run(created.id, 'legacy', async (item) => {
            frames.push(item);
        });

        await legacyStarted.promise;

        // Accepted while the legacy run owns the harness: it queues, it does not
        // execute, and it does NOT abort or reshape the legacy stream.
        const queuedStarted = fixture.started('queued');
        const queued = await store.enqueue(created.id, 'queued');
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
        const created = await store.create('gated');

        const firstStarted = fixture.started('first');
        const first = await store.enqueue(created.id, 'first');
        await firstStarted.promise;

        // PATCH while the first task runs: allowed, nothing aborted (T2 contract).
        await store.setAgentModels(created.id, { gated: 'live/next-model' });

        fixture.gate('first').resolve();
        await first.settled;

        const secondStarted = fixture.started('second');
        const second = await store.enqueue(created.id, 'second');
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
        const created = await store.create('gated');

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
        const active = await store.enqueue(created.id, 'active');
        await started.promise;

        const queued = await store.enqueue(created.id, 'queued');

        const frameCountAtRemove = frames.length;
        expect(await store.remove(created.id)).toBe(true);
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
        const created = await store.create('gated');

        // No work: idle is immediate.
        await expect(store.waitForIdle(created.id)).resolves.toBeUndefined();

        const started = fixture.started('one');
        const task = await store.enqueue(created.id, 'one');
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

    it('answers 202 with a receipt, forwards the queue frames, and retires /messages', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');
        const call = callOf(runtime);

        const receipt = await submitTask(call, id, { input: '  first  ' });

        expect(receipt.session_id).toBe(id);
        expect(String(receipt.turn_id)).toMatch(UUID_PATTERN);
        // The conversation the task landed in is part of the receipt (the old body carried
        // `turn.threadId` / `turn.threadLabel`; the receipt carries the id and the turn read
        // carries the label).
        expect(receipt.thread_id).toBe('thread-1');
        // A plain submit is neither a steer nor a queue overflow.
        expect(receipt).not.toHaveProperty('steered');
        expect(receipt).not.toHaveProperty('steered_thread_id');
        expect(receipt.links.stream).toBe('/v1/harness/stream');

        // The row the old 202 echoed is now the durable turn record, read by name. The
        // prompt is TRIMMED, the conversation is named, and no event has been recorded.
        const turn = await readTurn(call, id, receipt.turn_id);

        expect(turn).toMatchObject({
            session_id: id,
            id: receipt.turn_id,
            index: 0,
            prompt: 'first',
            thread_id: 'thread-1',
            thread_label: 'GD1'
        });

        // Wait until the scripted transport has entered `first` (the per-prompt gate holds
        // it there), so the SECOND submit is provably accepted BEHIND a running task rather
        // than racing the pump's first tick.
        await fixture.started('first').promise;

        const second = await submitTask(call, id, { input: 'second' });

        // `queued`: the accepted-behind state. `queue_position` is ABSENT here for a reason that is
        // now understood rather than reported as a blind spot: `postSessionTask` derives it from the
        // SAME global projection the named queue read uses (`queueRowsOf`, ./api-reads.ts:655-683,
        // which folds every lane backlog), and by the time the receipt is built this submit's own
        // conversation has already promoted it out of the backlog — it is running, so it has no slot.
        // A submit that genuinely waits DOES get the slot, as the 1-based ordinal the contract
        // specifies (./harness.swagger.yaml:5001-5005): see ./api-regressions.test.ts.
        expect(second.status).toBe('queued');
        expect(second).not.toHaveProperty('queue_position');

        // TRANSPORT + CONCURRENCY FINDING (both asserted as they are): an UNFOCUSED submit
        // opens its OWN conversation (`thread-2`/`GD2`), and independent conversations run
        // concurrently (the store test at the top of this file is what owns that rule). So
        // the second submit is not queued behind the first at all, and the canonical queue
        // page correctly answers EMPTY. The legacy 202 aggregate implied a session-level
        // `queueDepth: 1` for the accepted task; on the canonical surface the figures are
        // the per-conversation row plus the (empty) backlog.
        const backlog = await readQueue(call, id);

        expect(backlog.items).toEqual([]);
        expect(backlog.limit).toBe(0);
        expect(backlog.next_cursor).toBeNull();

        const secondTurn = await readTurn(call, id, second.turn_id);

        expect(secondTurn).toMatchObject({
            index: 1,
            prompt: 'second',
            thread_id: 'thread-2',
            thread_label: 'GD2'
        });
        expect(runtime.store.get(id).turns.map((turnRecord) => `${turnRecord.index}:${turnRecord.threadLabel}`)).toEqual([
            '0:GD1',
            '1:GD2'
        ]);
        expect(secondTurn.status).toBe('running');

        // Watch the queue from here on, so the frame order is the real contract. The HTTP
        // observer stream is gone (T15: one WebSocket plane), and `store.watch` is the seam
        // that plane is fed from — an accepted internal oracle, not a network fixture.
        const frames: SessionStreamItem[] = [];
        const watched = runtime.store.watch(id, async (item) => {
            frames.push(item);
        });

        // The attach hands over a COMPLETE snapshot: BOTH conversations are already running
        // (an unfocused submit opens its own, and independent conversations run
        // concurrently), and `first` already carries its `start` event — which is why no
        // frame is lost by attaching late, the same reasoning the legacy route's
        // snapshot-first frame encoded.
        expect(watched.snapshot.turns.map((record) => record.status)).toEqual(['running', 'running']);
        expect(watched.snapshot.turns[0].events.map((event) => event.type)).toEqual(['start']);

        // Let the watcher stay attached through the whole drain, then disconnect:
        // unsubscribing must not cancel anything (the adapter test covers the real
        // HTTP path; this asserts the frame contract).
        const secondStarted = fixture.started('second');
        fixture.gate('first').resolve();
        await secondStarted.promise;
        fixture.gate('second').resolve();
        await runtime.store.waitForIdle(id);

        watched.unsubscribe();

        // The watch frame sequence proves upserts and event attribution under CONCURRENCY
        // (F1), and the drain snapshot. Because the two tasks run in INDEPENDENT
        // conversations, the interleaving of the two lanes is not a fixed order — so the
        // contract is asserted as exact SETS plus the ordering that IS defined: every
        // recorded event of both turns arrives, each attributed to its own turn, no change is
        // published twice, both terminal rows land, and the drain snapshot is last. (The
        // `start` events and the running rows predate the attach — see the snapshot above.)
        const turnIds = runtime.store.get(id).turns.map((turnRecord) => turnRecord.id);
        const keys = frames.map(frameKey);

        expect(keys.filter((key) => key === 'turn:done:first')).toEqual(['turn:done:first']);
        expect(keys.filter((key) => key === 'turn:done:second')).toEqual(['turn:done:second']);
        // Both `start` events predate the attach (each conversation was already running), so
        // the events delivered from here on are the text/done pairs of both turns.
        expect(keys.filter((key) => key.startsWith('event:')).sort()).toEqual(
            [
                `event:text:${turnIds[0]}`,
                `event:done:${turnIds[0]}`,
                `event:text:${turnIds[1]}`,
                `event:done:${turnIds[1]}`
            ].sort()
        );
        expect(keys[keys.length - 1]).toBe('snapshot');
        // One publish per change, and nothing else on the wire.
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toHaveLength(7);

        // Both tasks completed for the server.
        expect(runtime.store.get(id).turns.map((turnRecord) => turnRecord.status)).toEqual(['done', 'done']);

        // A THIRD submit, still pending, proves the retired legacy route is really gone:
        // `POST /messages` is not a second submit surface — the dispatcher answers 404 and
        // names the route it did not find (T13 removed it rather than aliasing it).
        const third = await submitTask(call, id, { input: 'third' });

        expect(third.status).toBe('queued');

        const legacy = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
            input: 'legacy'
        });

        expect(legacy).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: `Unknown API route: POST /v1/harness/sessions/${id}/messages` } }
        });

        // The per-session SSE path is retired on the same evidence, and the ONE realtime
        // route answers a plain GET with the upgrade it expected.
        expect(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/events`)
        ).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: `Unknown API route: GET /v1/harness/sessions/${id}/events` } }
        });

        const streamWithoutUpgrade = await callApi(runtime, 'GET', '/v1/harness/stream');

        expect(streamWithoutUpgrade).toEqual({
            kind: 'json',
            status: 400,
            body: {
                error: {
                    message:
                        'GET /stream expects a WebSocket upgrade (Sec-WebSocket-Key/Version) for the harness.v1 subprotocol.'
                }
            }
        });

        await runtime.store.cancel(id, { all: true });
        fixture.gate('third').resolve();
        await runtime.store.waitForIdle(id);
    });

    it('answers a cancel receipt and validates the {all} option', async () => {
        pinClock(2_000);
        const runtime = runtimeOf([failingFixture()]);
        const id = await createSession(runtime, 'flaky');

        // Canonical shape: a receipt that names the session, what it dropped, and the
        // revision it moved. Nothing is running, so `active_turn_id` is ABSENT (never null).
        const idle = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`);

        expect(idle.kind).toBe('json');
        if (idle.kind !== 'json') throw new Error('expected JSON');
        expect(idle.status).toBe(200);
        expect(idle.body).toEqual(cancelResult(runtime, id, false, 0));

        // `{ all: true }` with an empty backlog answers the same receipt.
        const all = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {
            all: true
        });
        expect(all.kind).toBe('json');
        if (all.kind !== 'json') throw new Error('expected JSON');
        expect(all.status).toBe(200);
        expect(all.body).toEqual(cancelResult(runtime, id, false, 0));

        // T39 REGRESSION (was: PRODUCT FINDING reported, not hidden): the route now type-checks
        // the VALUE of `all` before anything is cancelled, so `{all:'yes'}` answers the legacy
        // 400 again instead of a 200 that quietly meant `all:false` and left the backlog running
        // (./api.ts `postSessionCancel`).
        const notBoolean = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {
            all: 'yes'
        });
        expect(notBoolean.kind).toBe('json');
        if (notBoolean.kind !== 'json') throw new Error('expected JSON');
        expect(notBoolean.status).toBe(400);
        expect(notBoolean.body).toEqual({ error: { message: '`all` must be a boolean when present.' } });

        // An unknown field is still refused, before anything is cancelled.
        const unknown = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {
            stop: true
        });
        expect(unknown.kind).toBe('json');
        if (unknown.kind !== 'json') throw new Error('expected JSON');
        expect(unknown.status).toBe(400);
        expect(unknown.body).toEqual({
            error: { message: 'Unknown field "stop". Allowed fields: all.' }
        });

        // Unknown session is a 404 for the queue routes.
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

        // The retired observer path answers as an UNKNOWN ROUTE, not as an unknown session:
        // routing is decided before any store lookup, so a deleted route never reaches the
        // store to be told "no such session".
        const missingEvents = await callApi(runtime, 'GET', '/v1/harness/sessions/missing/events');
        expect(missingEvents).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: 'Unknown API route: GET /v1/harness/sessions/missing/events' } }
        });

        // The canonical replacement for that read answers the store's own answer.
        const missingQueue = await callApi(runtime, 'GET', '/v1/harness/sessions/missing/queue');
        expect(missingQueue).toEqual({
            kind: 'json',
            status: 404,
            body: { error: { message: 'Unknown session "missing".' } }
        });

        const missingTurns = await callApi(runtime, 'GET', '/v1/harness/sessions/missing/turns');
        expect(missingTurns).toEqual({
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

        const accepted = await submitTask(callOf(runtime), id, { input: 'survivor' });

        expect(accepted.status).toBe('queued');

        // FIXTURE RACE: the pump starts the queued task on a later tick, so the scripted
        // transport is awaited BEFORE the observer attaches — the store cannot change again
        // afterwards, because the per-prompt gate holds the stream open.
        await fixture.started('survivor').promise;

        // The observer attaches, is handed the complete snapshot, and then DISCONNECTS. The
        // domain question is unchanged ("does a closing tab cancel the run?"); only the
        // carrier moved: the per-session SSE route is gone, and the WebSocket plane is fed
        // from this same watch seam (./stream/**, the realtime owner).
        const frames: SessionStreamItem[] = [];
        const watched = runtime.store.watch(id, async (item) => {
            frames.push(item);
        });

        expect(watched.snapshot.turns.map((record) => record.status)).toEqual(['running']);

        // T15: the realtime route is a 101 upgrade the loader answers from the raw socket.
        // A plain GET that reaches the JSON dispatcher asked for an upgrade it did not send,
        // so the service adapter answers 400 — no `Response`, no SSE headers.
        const handler = createHarnessServiceHandler({ runtime });
        const abort = new AbortController();
        const result = await handler(
            {
                req: {
                    path: '/v1/harness/stream',
                    header: () => undefined,
                    raw: { method: 'GET', signal: abort.signal }
                }
            },
            { body: {} }
        );

        expect(result.raw).toBeUndefined();
        expect(result.status).toBe(400);
        expect(result.response).toEqual({
            error: {
                // The SERVICE adapter refuses before the dispatcher: the upgrade belongs to
                // the loader's socket, so this is the wording a real client hears (the
                // in-process dispatcher's own wording is pinned in ./view.test.ts).
                message:
                    'GET /v1/harness/stream is a WebSocket upgrade: send Upgrade: websocket and Connection: Upgrade.'
            }
        });

        // The retired per-session path answers as an unknown route through the SAME adapter
        // (the adapters never re-implement routing).
        const retired = await handler(
            {
                req: {
                    path: `/v1/harness/sessions/${id}/events`,
                    header: () => undefined,
                    raw: { method: 'GET', signal: new AbortController().signal }
                }
            },
            { body: {} }
        );

        expect(retired.raw).toBeUndefined();
        expect(retired.status).toBe(404);

        // Disconnect like a closing tab: the watcher is dropped and NOTHING is published to
        // it in between — a cancellation would have arrived as a terminal frame.
        watched.unsubscribe();
        expect(frames).toEqual([]);
        expect(runtime.store.get(id).turns[0].status).toBe('running');

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
                threadId: 'thread-1',
                threadLabel: 'GD1',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 2_000,
                events: [
                    {
                        type: 'start',
                        agent: 'gated',
                        model: 'scripted/test',
                        thread: { id: '1', input: 'survivor' }
                    },
                    { type: 'text', agent: 'gated', delta: 'answer:survivor', thread: { id: '1' } },
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
                        },
                        thread: { id: '1' }
                    }
                ],
                eventTimes: [2_000, 2_000, 2_000]
            }
        ]);
    });

    it('a late observer disconnect cannot cancel the queued task that started next', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const legacyStarted = fixture.started('legacy');
        const running = await runtime.store.enqueue(id, 'legacy');

        await legacyStarted.promise;

        // The observer stays attached across the handover. The LEGACY version of this test
        // parked the route's terminal WRITE (a per-response writer chain); the store seam has
        // no such chain — a watcher callback that blocks would stall the publisher itself —
        // so the window is held open the way it is held in production: the observer is simply
        // still attached when the queued task starts, and the disconnect lands after that.
        const terminalReached = deferred();
        const frames: SessionStreamItem[] = [];

        const watched = runtime.store.watch(id, async (item) => {
            frames.push(item);

            if (item.type === 'snapshot') terminalReached.resolve();
        });

        expect(watched.snapshot.turns.map((record) => record.status)).toEqual(['running']);

        // Accepted behind the legacy run and parked until it releases the gate.
        const queuedStarted = fixture.started('queued');
        const queued = await runtime.store.enqueue(id, 'queued');
        expect(queued.turn.status).toBe('queued');
        expect(fixture.log).toEqual(['start:legacy']);

        // Finish the legacy turn: the pump starts the queued task while the legacy
        // observer is still attached.
        fixture.gate('legacy').resolve();
        await queuedStarted.promise;
        // The promotion order is the honest one for this seam: the store starts the queued
        // task as soon as the run releases its lane gate, and the scripted transport's
        // `finally` (the `end:legacy` line) closes only when the generator is done — so
        // `start:queued` legitimately lands before `end:legacy`. (The legacy SSE route
        // awaited its own terminal write, which is why the old file saw the reverse.) What
        // matters, and what the rest of this test pins, is that BOTH started while the
        // observer was still attached.
        expect(fixture.log).toEqual(['start:legacy', 'start:queued']);

        // The OLD observer disconnects now. Cancellation is owned by the run's controller,
        // never by an observer, so this must not touch the queued task.
        watched.unsubscribe();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(runtime.store.get(id).turns[1].status).toBe('running');
        expect(runtime.store.get(id).status).toBe('running');

        // The observer attached across the handover already saw the queued task's promotion
        // rows, attributed to the QUEUED turn; the run it replaced closes later (its terminal
        // write is published after the observer is gone), which is asserted at the end.
        expect(frames.map(frameKey)).toEqual([
            'turn:queued:queued',
            'turn:running:queued',
            `event:start:${queued.turn.id}`
        ]);

        // The queued task completes normally: not cancelled, no error banner.
        fixture.gate('queued').resolve();
        await queued.settled;
        await running.settled;
        await runtime.store.waitForIdle(id);

        // With the drain complete, the scripted transport has closed `legacy` as well: the
        // promotion happened while the observer was still attached, and nothing was cancelled.
        expect(fixture.log).toEqual(['start:legacy', 'start:queued', 'end:legacy', 'end:queued']);

        const final = runtime.store.get(id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual([
            'legacy:done',
            'queued:done'
        ]);

        // The observer was dropped mid-run, so the LAST thing it received is the queued
        // task's promotion — no cancellation frame followed it, and the store's final record
        // (above) shows both runs finishing normally.
        expect(frames.map((item) => item.type)).toEqual(['turn', 'turn', 'event']);
    });

    it('a session cancel still stops its OWN run and leaves the queued task alone', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        const legacyStarted = fixture.started('legacy');
        const running = await runtime.store.enqueue(id, 'legacy');

        await legacyStarted.promise;

        // Accepted behind the legacy run; it must not be what the cancel hits.
        const queuedStarted = fixture.started('queued');
        const queued = await runtime.store.enqueue(id, 'queued');

        // The canonical stop: `POST /cancel` with no `all` stops the ACTIVE run only. The
        // receipt names the turn it stopped and reports the backlog it left (0 dropped), so
        // the client can tell "my run stopped" from "the queue was emptied".
        //
        // The request is STARTED before its result is awaited, and the parked transport is
        // released only once the store has recorded the cancellation: the route awaits
        // `store.cancel`, which settles when the run exits, so a test that held the gate
        // while awaiting the response would deadlock the fixture (the legacy SSE route never
        // had this shape — its disconnect aborted the run's own controller).
        fixture.gate('legacy');

        // The receipt quotes the session counter as of the cancel (./api.ts reads
        // `getRevision('session', id)` after `store.cancel`); the store's own snapshot frame
        // moves it afterwards, so the pre-request figure is the one to compare against.
        const sessionRevision = runtime.api.events.getRevision('session', id);
        const cancelCall = callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, {});

        await waitUntil(() => runtime.store.get(id).turns.some((turn) => turn.status === 'cancelled'));

        fixture.gate('legacy').resolve();

        const cancelled = await cancelCall;

        expect(cancelled.kind).toBe('json');
        if (cancelled.kind !== 'json') throw new Error('expected JSON');
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toEqual({
            cancelled: true,
            session_id: id,
            dropped_queued_tasks: 0,
            active_turn_id: running.turn.id,
            revision: sessionRevision
        });

        // Bounded waits (`waitUntil`, the convention this file and ./transcript.test.ts use)
        // so a stalled pump fails with an OBSERVED state instead of the 15s test timeout.
        // PRODUCT FINDING (store behaviour, asserted as observed and NOT changed by T39): a
        // session-level `POST /cancel` with no `all` aborts EVERY conversation run that is ACTIVE
        // (./sessions.ts:7510-7518 stops each lane with an active turn), so both of this test's
        // submits end `cancelled` while the receipt names a single `active_turn_id`.
        // `dropped_queued_tasks: 0` is the honest figure here, and it is no longer suspected of
        // being blind to lanes: neither submit was ever in a backlog (each opened its own
        // conversation and was promoted immediately), and the count DOES include a real lane
        // backlog — `POST .../cancel {all:true}` over two queued continuations publishes
        // `dropped_queued_tasks: 2` (./api-regressions.test.ts). What the receipt still cannot
        // express is "this cancel stopped N runs"; the contract has one `active_turn_id` field.
        fixture.gate('queued').resolve();
        // The store's own drain definition (pending work, not a status string): a cancelled
        // backlog task never runs, so waiting on `status === 'idle'` here would wait on a
        // figure the cancel is free to leave at `error`.
        await runtime.store.waitForIdle(id);

        const final = runtime.store.get(id);

        // A server-side cancel owns the session-wide error banner (unlike the legacy
        // observer disconnect in the test above, which left the session `idle`): the stop is
        // REPORTED on the session, which is what the record needs to say after both the run
        // and the backlog entry it left ended as `cancelled`.
        expect(final.status).toBe('error');
        expect(final.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual([
            'legacy:cancelled',
            'queued:cancelled'
        ]);

        // What the stop DOES prove: it is attributed to the run that was active, the backlog
        // record is retained (not deleted), and the cancelled run keeps an honest terminal
        // record — the fact the legacy failed-frame used to state on the wire.
        expect((cancelled.body as { active_turn_id: string }).active_turn_id).toBe(running.turn.id);
        expect(final.turns.map((record) => record.index)).toEqual([0, 1]);
        expect(final.turns[0].events.map((event) => event.type)).toContain('error');
    });

    it('delivers watch frames in publish order, and stamps the live plane with a strictly increasing sequence', async () => {
        pinClock(2_000);
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');

        // SCOPE NOTE (transport move, not a dropped expectation): the old version of this
        // test gated the SSE WRITER, because the REST route owned a serialized write chain
        // (`createSseWriter`, ./handler.ts). No canonical REST route streams any more (T15),
        // so writer backpressure is now the WebSocket plane's guarantee (./stream/**, the
        // realtime owner). What the store and the hub still own — and what is asserted here
        // — is that ONE change publishes exactly one frame, in order, and moves each resource
        // counter exactly once.
        const recorded: SessionStreamItem[] = [];
        const watched = runtime.store.watch(id, async (item) => {
            recorded.push(item);
        });

        type RevisionRecord = { resource: string; id: string | null; revision: number };
        const hubEvents: { kind: string; revisions: RevisionRecord[] }[] = [];
        const unsubscribeHub = runtime.api.events.subscribe((event) => {
            hubEvents.push(event as unknown as { kind: string; revisions: RevisionRecord[] });
        });

        expect(watched.snapshot.turns).toEqual([]);

        const taskStarted = fixture.started('task');
        const task = await runtime.store.enqueue(id, 'task');
        const taskId = task.turn.id;

        // The task parks on its gate until this test releases it; the queue drain
        // only happens after that, so release before waiting for idle.
        await taskStarted.promise;
        fixture.gate('task').resolve();

        await runtime.store.waitForIdle(id);
        unsubscribeHub();
        watched.unsubscribe();

        // One ordered publish per change: row, run, three events, terminal row, drain
        // snapshot — the same sequence a client would page through.
        expect(recorded.map(frameKey)).toEqual([
            'turn:queued:task',
            'turn:running:task',
            `event:start:${taskId}`,
            `event:text:${taskId}`,
            `event:done:${taskId}`,
            'turn:done:task',
            'snapshot'
        ]);

        // The live plane is monotonic per resource: one number per change, never two, so a
        // resyncing consumer can order frames from the revision alone. `turn` is the key the
        // contract DEFINES the display and event counters to follow (./api.ts `display.ops`
        // bumps the trio together), so it moves once per recorded change of this run.
        const kinds = hubEvents.map((event) => event.kind);

        expect(kinds).toContain('turn.upsert');
        expect(kinds).toContain('display.ops');
        expect(kinds).toContain('session.updated');

        const turnRevisions = hubEvents
            .flatMap((event) => event.revisions)
            .filter((record) => record.resource === 'turn' && record.id === `${id}:${taskId}`)
            .map((record) => record.revision);

        expect(turnRevisions).toEqual([...turnRevisions].sort((left, right) => left - right));
        expect(new Set(turnRevisions).size).toBe(turnRevisions.length);
        // The final figure is the one a REST read quotes: one counter, one number.
        expect(turnRevisions[turnRevisions.length - 1]).toBe(
            runtime.api.events.getRevision('turn', `${id}:${taskId}`)
        );

        // The pump was never touched by the observer.
        await task.settled;
        expect(runtime.store.get(id).turns[0].status).toBe('done');
    });
});
